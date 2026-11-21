//! Moteur de recherche de Corrtex : un métamoteur sans clé d'API.
//!
//! Corrtex interroge lui-même, depuis l'ordinateur de l'utilisateur, plusieurs moteurs publics
//! (DuckDuckGo en version HTML, Mojeek, Marginalia, Wikipédia) et la page `ui/search.html`
//! fusionne et classe les résultats. Pour aller vite :
//! - un seul client HTTP, dont les connexions restent ouvertes (pas de nouvelle poignée de main TLS) ;
//! - les connexions sont « réchauffées » dès qu'on clique dans la barre d'adresse ;
//! - la recherche part dès l'appui sur Entrée, pendant que la page de résultats se charge ;
//! - chaque réponse est gardée 10 minutes (retour arrière, nouvel onglet : instantané) ;
//! - deux demandes identiques en même temps n'en font qu'une.
//!
//! Seules les adresses des moteurs ci-dessous sont construites ici : la page ne peut pas
//! demander une adresse quelconque.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, REFERER};
use tokio::sync::OnceCell;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
const WIKI_UA: &str = "Corrtex/0.2 (navigateur ; https://github.com/Xera-Dev/Corrtex)";
const TTL: Duration = Duration::from_secs(600);
const MAX_ENTRIES: usize = 160;

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        let mut h = HeaderMap::new();
        h.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("fr-FR,fr;q=0.9,en;q=0.5"));
        h.insert(ACCEPT, HeaderValue::from_static("text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"));
        reqwest::Client::builder()
            .user_agent(UA)
            .default_headers(h)
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(9))
            .pool_idle_timeout(Duration::from_secs(110))
            .pool_max_idle_per_host(6)
            .tcp_nodelay(true)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

// ---------------------------------------------------------------- cache (et demandes partagées)
type Cell = Arc<OnceCell<Result<String, String>>>;
struct Entry {
    at: Instant,
    cell: Cell,
}

fn cache() -> &'static Mutex<HashMap<String, Entry>> {
    static M: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn cached<F, Fut>(key: String, fetch: F) -> Result<String, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<String, String>>,
{
    let cell = {
        let mut m = cache().lock().unwrap_or_else(|e| e.into_inner());
        m.retain(|_, e| e.at.elapsed() < TTL);
        if m.len() >= MAX_ENTRIES {
            if let Some(old) = m.iter().min_by_key(|(_, e)| e.at).map(|(k, _)| k.clone()) {
                m.remove(&old);
            }
        }
        m.entry(key.clone()).or_insert_with(|| Entry { at: Instant::now(), cell: Arc::new(OnceCell::new()) }).cell.clone()
    };
    let r = cell.get_or_init(fetch).await.clone();
    // une erreur n'est pas gardée : la prochaine demande réessaie
    if r.is_err() {
        let mut m = cache().lock().unwrap_or_else(|e| e.into_inner());
        if m.get(&key).map(|e| Arc::ptr_eq(&e.cell, &cell)).unwrap_or(false) {
            m.remove(&key);
        }
    }
    r
}

// ---------------------------------------------------------------- outils
fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            b' ' => "+".to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

async fn text_of(req: reqwest::RequestBuilder, who: &str) -> Result<String, String> {
    let r = req.send().await.map_err(|e| {
        if e.is_timeout() {
            format!("{who} : délai dépassé")
        } else {
            format!("{who} injoignable")
        }
    })?;
    let st = r.status().as_u16();
    // DuckDuckGo répond 202 quand il demande une vérification anti-robot
    if st == 202 || !(200..300).contains(&st) {
        return Err(format!("{who} a refusé la demande ({st})"));
    }
    r.text().await.map_err(|_| format!("{who} : réponse coupée"))
}

/// Jeton « vqd » de DuckDuckGo (nécessaire pour les images, actualités et vidéos).
async fn ddg_vqd(q: &str) -> Result<String, String> {
    let q2 = q.to_string();
    cached(format!("vqd\u{1}{q}"), || async move {
        let html = text_of(client().get(format!("https://duckduckgo.com/?q={}&ia=web", enc(&q2))), "DuckDuckGo").await?;
        for pat in ["vqd=\"", "vqd='", "vqd=", "\"vqd\":\""] {
            if let Some(i) = html.find(pat) {
                let tok: String = html[i + pat.len()..].chars().take_while(|c| c.is_ascii_digit() || *c == '-').collect();
                if tok.len() > 4 {
                    return Ok(tok);
                }
            }
        }
        Err("DuckDuckGo : jeton introuvable".into())
    })
    .await
}

fn valid_form(s: &str) -> bool {
    s.len() < 3000 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"%+=&-_.~*".contains(&b))
}

async fn fetch_source(source: &str, q: &str, page: u32, form: &str) -> Result<String, String> {
    let c = client();
    match source {
        // résultats web principaux : la version HTML légère de DuckDuckGo
        "ddg" => {
            let body = if page <= 1 || form.is_empty() {
                format!("q={}&b=&kl=fr-fr", enc(q))
            } else if valid_form(form) {
                form.to_string()
            } else {
                return Err("page suivante invalide".into());
            };
            text_of(
                c.post("https://html.duckduckgo.com/html/")
                    .header(REFERER, "https://html.duckduckgo.com/")
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .body(body),
                "DuckDuckGo",
            )
            .await
        }
        // moteur indépendant (son propre index), en complément
        "mojeek" => {
            let s = if page > 1 { format!("&s={}", (page - 1) * 10 + 1) } else { String::new() };
            text_of(c.get(format!("https://www.mojeek.com/search?q={}&lb=fr&arc=fr{s}", enc(q))), "Mojeek").await
        }
        // petits sites et blogs (clé publique partagée)
        "marginalia" => {
            text_of(
                c.get(format!("https://api2.marginalia-search.com/search?query={}&count=12&page={}", enc(q), page.max(1)))
                    .header("API-Key", "public"),
                "Marginalia",
            )
            .await
        }
        // fiche de résumé
        "wiki" => {
            text_of(
                c.get(format!(
                    "https://fr.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1&generator=search&gsrlimit=1&gsrsearch={}&prop=extracts%7Cpageimages%7Cinfo%7Cdescription&exintro=1&explaintext=1&exsentences=4&piprop=thumbnail&pithumbsize=480&inprop=url",
                    enc(q)
                ))
                .header("User-Agent", WIKI_UA),
                "Wikipédia",
            )
            .await
        }
        "images" | "news" | "videos" => {
            let vqd = ddg_vqd(q).await?;
            let (path, per) = match source {
                "images" => ("i.js", 100),
                "news" => ("news.js", 30),
                _ => ("v.js", 60),
            };
            let s = (page.max(1) - 1) * per;
            let extra = if source == "news" { "&noamp=1&df=" } else { "&f=,,,,," };
            text_of(
                c.get(format!("https://duckduckgo.com/{path}?l=fr-fr&o=json&q={}&vqd={vqd}&p=1&s={s}{extra}", enc(q)))
                    .header(REFERER, "https://duckduckgo.com/")
                    .header(ACCEPT, "application/json"),
                "DuckDuckGo",
            )
            .await
        }
        _ => Err("source inconnue".into()),
    }
}

fn clean_q(q: &str) -> String {
    q.trim().chars().filter(|c| !c.is_control()).take(300).collect()
}

/// Une source de résultats (page brute : la page de résultats la lit et la classe).
#[tauri::command]
pub async fn search_fetch(source: String, q: String, page: Option<u32>, form: Option<String>) -> Result<String, String> {
    let q = clean_q(&q);
    if q.is_empty() {
        return Err("recherche vide".into());
    }
    let page = page.unwrap_or(1).clamp(1, 20);
    let form = form.unwrap_or_default();
    let key = format!("{source}\u{1}{q}\u{1}{page}\u{1}{form}");
    let (s, q2, f2) = (source.clone(), q.clone(), form.clone());
    cached(key, || async move { fetch_source(&s, &q2, page, &f2).await }).await
}

/// Lance la recherche avant même que la page de résultats soit chargée (appui sur Entrée).
#[tauri::command]
pub async fn search_prefetch(q: String, kind: Option<String>) {
    let q = clean_q(&q);
    if q.is_empty() {
        return;
    }
    let list: &[&str] = match kind.as_deref() {
        Some("images") => &["images"],
        Some("news") => &["news"],
        Some("videos") => &["videos"],
        _ => &["ddg", "mojeek", "wiki", "marginalia"],
    };
    for s in list {
        let (s, q) = (s.to_string(), q.clone());
        tauri::async_runtime::spawn(async move {
            let _ = search_fetch(s, q, Some(1), None).await;
        });
    }
}

/// Ouvre à l'avance les connexions vers les moteurs (clic dans la barre d'adresse).
#[tauri::command]
pub async fn search_warm() {
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    {
        let mut l = LAST.lock().unwrap_or_else(|e| e.into_inner());
        if l.map(|t| t.elapsed() < Duration::from_secs(45)).unwrap_or(false) {
            return;
        }
        *l = Some(Instant::now());
    }
    for url in ["https://html.duckduckgo.com/html/", "https://www.mojeek.com/", "https://fr.wikipedia.org/w/api.php"] {
        tauri::async_runtime::spawn(async move {
            let _ = client().head(url).send().await;
        });
    }
}

/// Page d'un site de shopping (comparateur, boutique) par le client rapide : connexions gardées
/// ouvertes, pages gardées 10 minutes. L'adresse a déjà été vérifiée par l'appelant.
pub async fn shop_get(url: String) -> Result<String, String> {
    cached(format!("shop\u{1}{url}"), || async move {
        let r = client().get(&url).send().await.map_err(|e| if e.is_timeout() { "délai dépassé".to_string() } else { "site injoignable".to_string() })?;
        let code = r.status().as_u16();
        if code == 404 {
            return Err("introuvable".into());
        }
        if !(200..300).contains(&code) {
            return Err(format!("le site a refusé la demande ({code})"));
        }
        r.text().await.map_err(|_| "réponse coupée".to_string())
    })
    .await
}
