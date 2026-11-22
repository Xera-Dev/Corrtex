// Corrtex — navigateur léger basé sur le moteur web du système (WebView2 sous Windows).
//
// Architecture (une ou plusieurs fenêtres "wN") :
//   fenêtre "wN" (sans bordure)
//     ├─ webview "chrome-wN" : barre d'onglets + barre d'outils + favoris (ui/chrome.html)
//     ├─ webview "tab-K"     : un par onglet (page d'accueil ui/newtab.html ou site web)
//     ├─ webview "aibar-wN"  : en-tête du panneau IA (ui/aibar.html)
//     └─ webview "ai-wN"     : le site de l'IA choisie, en interface réduite (mobile)
//   webview temporaire "gprobe" : lit le profil Google (photo, nom, e-mail) puis se ferme.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod extensions;

mod search;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
    window::{Color, WindowBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl, WindowEvent,
};

// ---------------------------------------------------------------- dimensions
const CHROME_H: f64 = 116.0; // onglets (40) + barre d'outils (46) + favoris (30)
/// largeur du panneau IA (réglable à la souris, enregistrée dans les réglages)
static SIDE_W: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(400);
fn side_w() -> f64 {
    SIDE_W.load(std::sync::atomic::Ordering::Relaxed) as f64
}
const SIDE_MIN: f64 = 300.0;
/// gouttière (couleur de la barre d'outils) entre la page et le panneau IA ; c'est aussi la poignée
const GUTTER: f64 = 8.0;
const AIBAR_H: f64 = 96.0; // en-tête du panneau IA (titre + choix de l'IA)
const BG: Color = Color(32, 32, 34, 255);

const TAB_SCRIPT: &str = include_str!("tab_script.js");
const AI_SCRIPT: &str = include_str!("ai_script.js");
const GOOGLE_SKIN: &str = include_str!("google_skin.js");
const GOOGLE_SCRIPT: &str = include_str!("google_probe.js");
const MOBILE_UA: &str = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

// ---------------------------------------------------------------- IA disponibles
#[derive(Serialize, Clone)]
struct AiProvider {
    id: &'static str,
    name: &'static str,
    url: &'static str,
}

const AI_PROVIDERS: &[AiProvider] = &[
    AiProvider { id: "claude", name: "Claude", url: "https://claude.ai/new" },
    AiProvider { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/" },
    AiProvider { id: "gemini", name: "Gemini", url: "https://gemini.google.com/app" },
];

fn provider(id: &str) -> &'static AiProvider {
    AI_PROVIDERS.iter().find(|p| p.id == id).unwrap_or(&AI_PROVIDERS[0])
}

/// Toutes les vues partagent le même environnement WebView2 : elles doivent donc toutes
/// être créées avec les mêmes options (extensions activées).
// macOS : WKWebView ne s'annonce pas comme Safari (pas de « Version/… Safari/… »), et Google
// sert alors une page de résultats simplifiée et ancienne, que le style Corrtex ne reconnaît pas.
#[cfg(target_os = "macos")]
const DESKTOP_UA: Option<&str> = Some("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15");
#[cfg(not(target_os = "macos"))]
const DESKTOP_UA: Option<&str> = None;

/// Options du moteur WebView2 (identiques pour toutes les vues) : celles de Tauri par défaut, plus
/// l'aide à l'écriture d'Edge coupée (bouton « Reformuler » / « Réécrire avec Copilot » dans les champs).
#[cfg(windows)]
const WEBVIEW_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,msEdgeComposeInline,msComposeInline,msEdgeCompose,msInlineCompose,msEdgeComposeInlineRewrite,msEdgeWritingAssistance,msWritingAssistance,msEditorRewrite,msEdgeRewrite,msCopilotRewrite";

fn web(label: impl Into<String>, url: WebviewUrl) -> WebviewBuilder<tauri::Wry> {
    let b = WebviewBuilder::new(label, url).browser_extensions_enabled(true).background_color(BG);
    #[cfg(windows)]
    let b = b.additional_browser_args(WEBVIEW_ARGS);
    match DESKTOP_UA {
        Some(ua) => b.user_agent(ua),
        None => b,
    }
}

// ---------------------------------------------------------------- état
#[derive(Serialize, Clone)]
struct Tab {
    id: u32,
    #[serde(skip)]
    win: String,
    url: String,
    title: String,
    favicon: String,
    loading: bool,
    /// historique : page précédente / suivante disponibles (flèches grisées sinon)
    can_back: bool,
    can_fwd: bool,
    /// onglet épinglé : réduit à son icône, toujours à gauche
    pinned: bool,
    /// groupe de l'onglet (0 : aucun)
    group: u32,
    /// en veille : la page n'est pas chargée (mémoire libérée) jusqu'au prochain clic
    asleep: bool,
    /// zoom de la page (mémorisé par site)
    zoom: f64,
    /// page interne de Corrtex (bibliothèque…) quand l'onglet n'a pas d'adresse web
    page: String,
    /// mémoire JavaScript de la page (octets), relevée pour le tableau des performances
    #[serde(skip)]
    js_mem: u64,
    /// la page n'a pas pu s'ouvrir : page d'erreur Corrtex affichée à sa place
    error_page: bool,
    /// langue de la page (attribut lang), pour proposer la traduction
    lang: String,
    /// la page est affichée traduite
    translated: bool,
    /// article en vente détecté sur la page (nom, prix, marque, code EAN…), pour le comparateur
    #[serde(skip)]
    product: Option<serde_json::Value>,
    /// espace de l'onglet (ensembles d'onglets : Perso, Travail…)
    #[serde(default)]
    space: u32,
    /// la page joue du son / le son de l'onglet est coupé
    #[serde(skip_deserializing)]
    audible: bool,
    #[serde(skip_deserializing)]
    muted: bool,
    /// dernière fois que l'onglet était affiché (mise en veille des onglets inactifs)
    #[serde(skip)]
    last_seen: Option<Instant>,
    /// défilement de la page (0 à 30 px) : replie la barre de favoris
    #[serde(skip)]
    scroll: f64,
}

#[derive(Default)]
struct Win {
    /// suggestions affichées sous la barre d'adresse
    suggest: Option<serde_json::Value>,
    tabs: Vec<u32>, // ordre d'affichage
    active: Option<u32>,
    sidebar_open: bool,
    ai_created: bool,
    maximized: bool,
    /// plein écran (F11) : la barre du navigateur est masquée
    fullscreen: bool,
    /// plein écran demandé par la page (vidéo YouTube…) : l'onglet occupe tout l'écran
    page_fs: bool,
    /// la fenêtre a été mise en plein écran pour la page (à rétablir à la sortie)
    page_fs_window: bool,
    /// hauteur ajoutée à l'en-tête du panneau IA (liste « Comparer des onglets » dépliée)
    aibar_extra: f64,
    /// site dont la conversation est affichée dans le panneau IA (mémoire par site)
    ai_site: String,
    ai_site_at: Option<Instant>,
    /// groupes d'onglets de la fenêtre
    groups: Vec<Group>,
    /// fenêtre de navigation privée : pages sans historique, cookies effacés à la fermeture
    private: bool,
    /// panneau ouvert par-dessus la page : "extensions", "tools" ou vide
    panel_view: String,
    /// contenu de la petite fenêtre flottante (menu d'onglet, aperçu)
    popup: Option<serde_json::Value>,
    preview: Option<serde_json::Value>,
    /// espaces de la fenêtre (l'espace 0, « Principal », existe toujours) et espace affiché
    spaces: Vec<Space>,
    space: u32,
    /// vue côte à côte : onglet affiché à droite de l'onglet actif
    split: Option<u32>,
    /// profil de la fenêtre (0 : Principal)
    profile: u32,
}

/// Espace : un ensemble d'onglets avec son nom et sa couleur.
#[derive(Serialize, Deserialize, Clone, Default)]
struct Space {
    id: u32,
    name: String,
    color: String,
    /// dernier onglet affiché dans cet espace
    #[serde(skip)]
    last: Option<u32>,
}

fn default_spaces() -> Vec<Space> {
    vec![Space { id: 0, name: "Principal".into(), color: "#9aa0a6".into(), last: None }]
}

/// Groupe d'onglets : une pastille colorée devant ses onglets, repliable.
#[derive(Serialize, Deserialize, Clone, Default)]
struct Group {
    id: u32,
    name: String,
    color: String,
    collapsed: bool,
}

/// Onglet fermé, pour Ctrl+Maj+T.
#[derive(Clone)]
struct ClosedTab {
    url: String,
    title: String,
    favicon: String,
    win: String,
    index: usize,
    group: u32,
}

/// Couleurs des groupes (dans l'esprit des lueurs de Corrtex).
const GROUP_COLORS: &[&str] = &["#ff4f7b", "#ff9f43", "#ffd166", "#4cd38a", "#3ccfe0", "#5b8cff", "#a77bff", "#9aa0a6"];

#[derive(Serialize, Deserialize, Clone, PartialEq, Default)]
struct Media {
    #[serde(default)]
    tab: u32,
    #[serde(default)]
    title: String,
    #[serde(default)]
    artist: String,
    #[serde(default)]
    artwork: String,
    #[serde(default)]
    playing: bool,
    #[serde(default)]
    progress: f64,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Default)]
struct Google {
    /// "unknown" (pas encore vérifié), "signed_out" ou "signed_in"
    status: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    avatar: String,
    /// tous les comptes Google connectés (dans l'ordre de Google : authuser 0, 1, 2…)
    #[serde(default)]
    accounts: Vec<GAccount>,
    /// compte utilisé par Corrtex pour les pages Google (authuser)
    #[serde(default)]
    active: u32,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Default)]
struct GAccount {
    name: String,
    email: String,
    avatar: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    ai_provider: String,
    sidebar_open: bool,
    /// applique le style de Corrtex à la page de l'IA
    #[serde(default = "yes")]
    ai_skin: bool,
    #[serde(default = "default_side_w")]
    sidebar_w: f64,
    /// mémoire des conversations IA par site
    #[serde(default = "yes")]
    ai_memory: bool,
    /// site (domaine) → adresse de la conversation IA associée
    #[serde(default)]
    ai_chats: HashMap<String, String>,
    /// rouvrir les onglets de la dernière fois au démarrage
    #[serde(default = "yes")]
    restore_session: bool,
    /// minutes avant la mise en veille d'un onglet inactif (0 : jamais)
    #[serde(default = "default_sleep")]
    sleep_min: u32,
    /// zoom mémorisé par site
    #[serde(default)]
    zooms: HashMap<String, f64>,
    /// enregistrer les pages visitées dans l'historique
    #[serde(default = "yes")]
    save_history: bool,
    /// notes par site (domaine → texte)
    #[serde(default)]
    notes: HashMap<String, String>,
    /// liste de lecture (« Lire plus tard »)
    #[serde(default)]
    read_later: Vec<ReadItem>,
    /// raccourcis clavier personnalisés (action → touches, ex. « Ctrl+Shift+S »)
    #[serde(default)]
    keys: HashMap<String, String>,
    /// gestes de la souris (clic droit maintenu + glisser)
    #[serde(default = "yes")]
    gestures: bool,
    /// sites bloqués pendant le mode concentration
    #[serde(default = "default_focus_sites")]
    focus_sites: Vec<String>,
    /// dépôt GitHub (« propriétaire/projet ») où sont publiées les nouvelles versions
    #[serde(default)]
    update_repo: String,
    /// dernière version dont les nouveautés ont été vues
    #[serde(default)]
    last_version: String,
    /// profils (connexions et cookies séparés) ; le profil 0, « Principal », est implicite
    #[serde(default)]
    profiles: Vec<Profile>,
    /// économie d'énergie : « auto » (sur batterie), « on », « off »
    #[serde(default = "default_power")]
    power_mode: String,
    /// mises à jour installées toutes seules au démarrage
    #[serde(default = "yes")]
    auto_update: bool,
    /// fermer la dernière fenêtre la réduit dans la barre des tâches (réouverture instantanée)
    #[serde(default = "yes")]
    keep_running: bool,
    /// boutiques que l'agent de recherche d'achat peut visiter en plus de leDénicheur
    #[serde(default = "default_shop_sites")]
    shop_sites: Vec<ShopSite>,
    /// compte Google choisi parmi les comptes connectés
    #[serde(default)]
    google_active: u32,
    /// panneau IA avec l'interface de Corrtex (l'IA travaille en coulisse) plutôt que le site de l'IA
    #[serde(default = "yes")]
    ai_native: bool,
}

/// Boutique visitée par l'agent d'achat : `search` est l'adresse de recherche, {q} y est remplacé par la recherche.
#[derive(Serialize, Deserialize, Clone)]
struct ShopSite {
    name: String,
    search: String,
    #[serde(default)]
    on: bool,
}

fn default_shop_sites() -> Vec<ShopSite> {
    [
        ("Amazon", "https://www.amazon.fr/s?k={q}"),
        ("Fnac", "https://www.fnac.com/SearchResult/ResultList.aspx?Search={q}"),
        ("Darty", "https://www.darty.com/nav/recherche?text={q}"),
        ("Boulanger", "https://www.boulanger.com/resultats?tr={q}"),
        ("Cdiscount", "https://www.cdiscount.com/search/10/{q}.html"),
        ("Rakuten", "https://fr.shopping.rakuten.com/search/{q}"),
        ("Back Market", "https://www.backmarket.fr/fr-fr/search?q={q}"),
        ("LDLC", "https://www.ldlc.com/recherche/{q}/"),
        ("Decathlon", "https://www.decathlon.fr/search?Ntt={q}"),
        ("idealo", "https://www.idealo.fr/prechcat.html?q={q}"),
    ]
    .iter()
    .map(|(n, u)| ShopSite { name: n.to_string(), search: u.to_string(), on: false })
    .collect()
}

/// Domaine d'une adresse de recherche de boutique (sans « www. »).
fn shop_site_host(search: &str) -> Option<String> {
    let u = tauri::Url::parse(&search.replace("{q}", "x")).ok()?;
    if u.scheme() != "https" {
        return None;
    }
    let h = u.host_str()?.to_lowercase();
    Some(h.strip_prefix("www.").unwrap_or(&h).to_string())
}

fn default_focus_sites() -> Vec<String> {
    ["youtube.com", "facebook.com", "instagram.com", "tiktok.com", "x.com", "twitter.com", "reddit.com", "twitch.tv", "netflix.com"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

fn default_power() -> String {
    "auto".into()
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct Profile {
    id: u32,
    name: String,
    color: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct ReadItem {
    url: String,
    title: String,
    #[serde(default)]
    favicon: String,
    added: u64,
}

fn default_sleep() -> u32 {
    30
}

fn yes() -> bool {
    true
}

fn default_side_w() -> f64 {
    400.0
}

impl Default for Settings {
    fn default() -> Self {
        Settings { ai_provider: "claude".into(), sidebar_open: false, ai_skin: true, sidebar_w: 400.0, ai_memory: true, ai_chats: HashMap::new(), restore_session: true, sleep_min: 30, zooms: HashMap::new(), save_history: true, notes: HashMap::new(), read_later: Vec::new(), keys: HashMap::new(), gestures: true, focus_sites: default_focus_sites(), update_repo: String::new(), last_version: String::new(), profiles: Vec::new(), power_mode: default_power(), auto_update: true, keep_running: true, shop_sites: default_shop_sites(), google_active: 0, ai_native: true }
    }
}

#[derive(Default)]
struct Browser {
    /// mode concentration : fin prévue
    focus_until: Option<Instant>,
    /// l'ordinateur fonctionne sur batterie (signalé par la barre du navigateur)
    on_battery: bool,
    /// mise à jour de l'interface déjà programmée (regroupement des envois)
    bcast_pending: bool,
    /// recherche d'achat de l'agent, par fenêtre : demande, précisions et résultats (moteur caché)
    shopping: HashMap<String, serde_json::Value>,
    /// dernier état affiché par le panneau de recherche d'achat, par fenêtre
    shopping_view: HashMap<String, serde_json::Value>,
    /// panneau de recherche d'achat ouvert : onglet où il est dessiné, par fenêtre
    shopping_open: HashMap<String, u32>,
    /// historique des recherches de l'agent (achats et réponses), le plus récent en dernier
    agent_history: Vec<serde_json::Value>,
    /// fenêtres en cours de démarrage : écran de chargement affiché (au plus 2 s)
    booting: std::collections::HashSet<String>,
    /// Quitter Corrtex a été demandé : la dernière fenêtre se ferme vraiment
    quitting: bool,
    /// nouvelle version de Corrtex disponible (numéro), installation en cours
    update_version: Option<String>,
    updating: bool,
    /// panneau refermé par un clic dans la fenêtre : (fenêtre → vue, moment), pour ne pas le rouvrir aussitôt
    panel_dismissed: HashMap<String, (String, Instant)>,
    /// captures d'écran en attente d'ouverture dans l'éditeur (numéro → image PNG en base64, recadrage)
    captures: HashMap<u32, serde_json::Value>,
    #[cfg_attr(not(windows), allow(dead_code))]
    next_capture: u32,
    /// couleurs du thème transmises à la page de l'IA
    ai_theme: serde_json::Value,
    tabs: HashMap<u32, Tab>,
    windows: HashMap<String, Win>,
    next_tab: u32,
    next_win: u32,
    media: Option<Media>,
    settings: Settings,
    google: Google,
    probing: bool,
    last_probe: Option<Instant>,
    last_key: Option<Instant>,
    /// message à envoyer dès que la page de l'IA (fenêtre → texte) a fini de charger
    pending_ai: HashMap<String, String>,
    /// lectures de pages en cours (résumé, comparaison)
    text_reqs: HashMap<u64, TextReq>,
    next_req: u64,
    last_sel: Option<Instant>,
    /// réponse rapide en cours (bulle dans la page), par fenêtre
    quick: HashMap<String, QuickReq>,
    /// agent de navigation, par onglet
    agents: HashMap<u32, AgentJob>,
    next_group: u32,
    /// onglets fermés récemment (Ctrl+Maj+T), le plus récent à la fin
    closed: Vec<ClosedTab>,
    /// la session (onglets ouverts) a changé et doit être enregistrée
    session_dirty: bool,
    /// historique de navigation (le plus récent à la fin)
    history: Vec<HistEntry>,
    history_dirty: bool,
    /// téléchargements de la session
    downloads: Vec<Download>,
    next_dl: u32,
}

#[derive(Serialize, Deserialize, Clone)]
struct HistEntry {
    url: String,
    title: String,
    /// secondes depuis 1970
    time: u64,
}

#[derive(Serialize, Clone)]
struct Download {
    id: u32,
    url: String,
    name: String,
    path: String,
    /// "progress", "done" ou "failed"
    state: String,
    time: u64,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Question posée à la page d'IA cachée ; la réponse s'affiche dans une bulle de l'onglet.
#[derive(Clone)]
struct QuickReq {
    req: u64,
    tab: u32,
    bubble: String,
    prompt: String,
    started: bool,
    /// fonction de la page qui reçoit la réponse (par défaut : la bulle)
    cb: Option<&'static str>,
    /// vue qui reçoit la réponse à la place de l'onglet (ex. le comparateur)
    view: Option<String>,
}

/// Agent de navigation : une mission en cours dans un onglet.
#[derive(Clone)]
struct AgentJob {
    goal: String,
    /// actions déjà faites (décrites en clair)
    steps: Vec<String>,
    /// on attend l'état de la page pour demander l'action suivante
    waiting: bool,
}

/// Lecture du texte d'un ou plusieurs onglets avant de l'envoyer à l'IA.
struct TextReq {
    win: String,
    kind: &'static str,
    tabs: Vec<u32>,
    /// (onglet, titre, adresse, texte)
    got: Vec<(u32, String, String, String)>,
}

#[derive(Serialize, Clone)]
struct Snapshot {
    /// fenêtre concernée (chaque barre ne garde que l'état de SA fenêtre)
    win: String,
    ai_memory: bool,
    restore_session: bool,
    sleep_min: u32,
    groups: Vec<Group>,
    /// téléchargements de la session : (en cours, total)
    downloads: (usize, usize),
    private: bool,
    save_history: bool,
    /// repli actuel de la barre de favoris (0 à 30 px)
    bm_off: f64,
    ai_skin: bool,
    sidebar_w: f64,
    tabs: Vec<Tab>,
    active: Option<u32>,
    spaces: Vec<Space>,
    space: u32,
    split: Option<u32>,
    /// une note existe pour le site de l'onglet actif
    note: bool,
    /// mode concentration : secondes restantes
    focus_left: Option<u64>,
    /// profil de la fenêtre (absent pour Principal)
    profile: Option<Profile>,
    /// économie d'énergie en cours
    power_saver: bool,
    sidebar_open: bool,
    maximized: bool,
    ai_provider: String,
    providers: Vec<AiProvider>,
    media: Option<Media>,
    google: Google,
}

#[derive(Serialize, Clone)]
struct Global {
    save_history: bool,
    ai_memory: bool,
    restore_session: bool,
    sleep_min: u32,
    ai_provider: String,
    providers: Vec<AiProvider>,
    media: Option<Media>,
    google: Google,
}

struct AppState(Mutex<Browser>);

fn state(app: &AppHandle) -> std::sync::MutexGuard<'_, Browser> {
    app.state::<AppState>().inner().0.lock().unwrap_or_else(|e| e.into_inner())
}

fn snapshot(b: &Browser, win: &str) -> Snapshot {
    let w = b.windows.get(win);
    Snapshot {
        win: win.to_string(),
        ai_memory: b.settings.ai_memory,
        restore_session: b.settings.restore_session,
        sleep_min: b.settings.sleep_min,
        groups: w.map(|w| w.groups.clone()).unwrap_or_default(),
        downloads: (b.downloads.iter().filter(|d| d.state == "progress").count(), b.downloads.len()),
        private: w.map(|w| w.private).unwrap_or(false),
        save_history: b.settings.save_history,
        bm_off: CHROME_H - chrome_height(b, win),
        ai_skin: b.settings.ai_skin,
        sidebar_w: side_w(),
        tabs: w.map(|w| w.tabs.iter().filter_map(|id| b.tabs.get(id).cloned()).collect()).unwrap_or_default(),
        active: w.and_then(|w| w.active),
        spaces: w.map(|w| w.spaces.clone()).filter(|s| !s.is_empty()).unwrap_or_else(default_spaces),
        space: w.map(|w| w.space).unwrap_or(0),
        split: w.and_then(|w| w.split),
        note: w.and_then(|w| w.active).and_then(|a| b.tabs.get(&a)).map(|t| b.settings.notes.get(&site_of(&t.url)).map(|n| !n.trim().is_empty()).unwrap_or(false)).unwrap_or(false),
        focus_left: b.focus_until.and_then(|u| u.checked_duration_since(Instant::now())).map(|d| d.as_secs()),
        profile: w.map(|w| w.profile).filter(|p| *p != 0).and_then(|p| b.settings.profiles.iter().find(|x| x.id == p).cloned()),
        power_saver: power_saver(b),
        sidebar_open: w.map(|w| w.sidebar_open).unwrap_or(false),
        maximized: w.map(|w| w.maximized).unwrap_or(false),
        ai_provider: b.settings.ai_provider.clone(),
        providers: AI_PROVIDERS.to_vec(),
        media: b.media.clone(),
        google: b.google.clone(),
    }
}

/// Envoie l'état à l'interface de chaque fenêtre, et l'état global aux pages d'accueil.
fn broadcast(app: &AppHandle) {
    // plusieurs changements rapprochés (chargement d'une page…) : un seul envoi toutes les 25 ms
    {
        let mut b = state(app);
        b.session_dirty = true;
        if b.bcast_pending {
            return;
        }
        b.bcast_pending = true;
    }
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(25));
        state(&app2).bcast_pending = false;
        broadcast_now(&app2);
    });
}

fn broadcast_now(app: &AppHandle) {
    let (per_win, global, ai, panels) = {
        let b = state(app);
        let per: Vec<(String, Snapshot)> = b.windows.keys().map(|w| (w.clone(), snapshot(&b, w))).collect();
        let g = Global {
            save_history: b.settings.save_history,
            ai_memory: b.settings.ai_memory,
            restore_session: b.settings.restore_session,
            sleep_min: b.settings.sleep_min,
            ai_provider: b.settings.ai_provider.clone(),
            providers: AI_PROVIDERS.to_vec(),
            media: b.media.clone(),
            google: b.google.clone(),
        };
        // seules les vues qui existent reçoivent l'état
        let ai: std::collections::HashSet<String> = b.windows.iter().filter(|(_, w)| w.ai_created).map(|(l, _)| l.clone()).collect();
        let panels: std::collections::HashSet<String> = b.windows.iter().filter(|(_, w)| !w.panel_view.is_empty()).map(|(l, _)| l.clone()).collect();
        (per, g, ai, panels)
    };
    for (w, snap) in per_win {
        if ai.contains(&w) {
            let _ = app.emit_to(format!("aibar-{w}").as_str(), "browser-state", snap.clone());
        }
        if panels.contains(&w) {
            let _ = app.emit_to(format!("panel-{w}").as_str(), "browser-state", snap.clone());
        }
        let _ = app.emit_to(format!("chrome-{w}").as_str(), "browser-state", snap);
    }
    let _ = app.emit("global-state", global);
}

fn tab_label(id: u32) -> String {
    format!("tab-{id}")
}

fn tab_id_from_label(label: &str) -> Option<u32> {
    label.strip_prefix("tab-")?.parse().ok()
}

fn win_of_tab(app: &AppHandle, id: u32) -> Option<String> {
    state(app).tabs.get(&id).map(|t| t.win.clone())
}

// ---------------------------------------------------------------- réglages persistants
fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle) {
    let s = state(app).settings.clone();
    if let Some(p) = settings_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(&s) {
            let _ = std::fs::write(p, json);
        }
    }
}

// ---------------------------------------------------------------- sauvegarde (export / import)

/// Date du jour « AAAA-MM-JJ » (UTC), sans dépendance de calendrier.
fn today_ymd() -> String {
    ymd_of(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0))
}

/// Exporte favoris, préférences et réglages dans un fichier du dossier Téléchargements.
#[tauri::command]
async fn backup_export(app: AppHandle, ui: serde_json::Map<String, serde_json::Value>) -> Result<String, String> {
    let settings = state(&app).settings.clone();
    // seules les données de l'interface Corrtex (« corrtex.* ») sont gardées
    let ui: serde_json::Map<String, serde_json::Value> =
        ui.into_iter().filter(|(k, v)| k.starts_with("corrtex.") && v.is_string()).collect();
    let data = serde_json::json!({
        "app": "Corrtex",
        "backup": 1,
        "date": today_ymd(),
        "settings": settings,
        "ui": ui,
    });
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(&dir);
    let base = format!("Corrtex-sauvegarde-{}", today_ymd());
    let mut path = dir.join(format!("{base}.json"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{base} ({n}).json"));
        n += 1;
    }
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Importe une sauvegarde : applique les réglages et renvoie les données de l'interface à restaurer.
#[tauri::command]
async fn backup_import(app: AppHandle, data: serde_json::Value) -> Result<serde_json::Value, String> {
    if data.get("app").and_then(|v| v.as_str()) != Some("Corrtex") || data.get("backup").and_then(|v| v.as_u64()).is_none() {
        return Err("Ce fichier n’est pas une sauvegarde Corrtex.".into());
    }
    if let Some(imported) = data.get("settings").and_then(|v| v.as_object()) {
        // fusion champ par champ : un champ absent ou invalide garde la valeur actuelle
        let current = state(&app).settings.clone();
        let mut merged = serde_json::to_value(&current).map_err(|e| e.to_string())?;
        if let Some(obj) = merged.as_object_mut() {
            for (k, v) in imported {
                if obj.contains_key(k) {
                    let mut trial = obj.clone();
                    trial.insert(k.clone(), v.clone());
                    if serde_json::from_value::<Settings>(serde_json::Value::Object(trial)).is_ok() {
                        obj.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        let mut next: Settings = serde_json::from_value(merged).map_err(|e| e.to_string())?;
        next.sleep_min = next.sleep_min.min(24 * 60);
        next.sidebar_w = next.sidebar_w.clamp(SIDE_MIN, 1000.0);
        state(&app).settings = next;
        save_settings(&app);
        broadcast(&app);
    }
    let ui: serde_json::Map<String, serde_json::Value> = data
        .get("ui")
        .and_then(|v| v.as_object())
        .map(|m| m.iter().filter(|(k, v)| k.starts_with("corrtex.") && v.is_string()).map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    Ok(serde_json::Value::Object(ui))
}

// ---------------------------------------------------------------- mise en page
fn window_logical_size(app: &AppHandle, win: &str) -> (f64, f64) {
    if let Some(w) = app.get_window(win) {
        if let (Ok(size), Ok(scale)) = (w.inner_size(), w.scale_factor()) {
            let l = size.to_logical::<f64>(scale);
            return (l.width, l.height);
        }
    }
    (1280.0, 820.0)
}

fn content_rect(width: f64, height: f64, sidebar: bool, chrome_h: f64) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    let side = if sidebar { side_w() + GUTTER } else { 0.0 };
    (
        LogicalPosition::new(0.0, chrome_h),
        LogicalSize::new((width - side).max(100.0), (height - chrome_h).max(50.0)),
    )
}

/// Hauteur de la barre du navigateur : la barre de favoris se replie quand la page
/// de l'onglet actif défile (0 à 30 px).
fn chrome_height(b: &Browser, win: &str) -> f64 {
    if b.windows.get(win).map(|w| w.fullscreen || w.page_fs).unwrap_or(false) {
        return 0.0;
    }
    // mode concentration : seulement la barre d'outils (ni onglets, ni favoris)
    if b.focus_until.is_some() {
        return CHROME_H - 70.0;
    }
    let off = b.windows.get(win).and_then(|w| w.active).and_then(|id| b.tabs.get(&id)).map(|t| t.scroll).unwrap_or(0.0);
    CHROME_H - off.clamp(0.0, 30.0)
}

fn set_bounds(wv: &Webview, pos: LogicalPosition<f64>, size: LogicalSize<f64>) {
    let _ = wv.set_bounds(tauri::Rect { position: pos.into(), size: size.into() });
}

fn layout_with(app: &AppHandle, win: &str, width: f64, height: f64) {
    let Some((tab_ids, active, sidebar, ai_created, ch, bar_h)) = ({
        let b = state(app);
        let ch = chrome_height(&b, win);
        // vidéo en plein écran : ni panneau IA ni vue côte à côte
        // interface Corrtex : l'en-tête prend toute la hauteur du panneau, le site de l'IA reste caché
        let native = b.settings.ai_native;
        b.windows.get(win).map(|w| (w.tabs.clone(), w.active, w.sidebar_open && !w.page_fs, w.ai_created, ch, if native { 1.0e6 } else { AIBAR_H + w.aibar_extra }))
    }) else {
        return;
    };
    let page_fs = state(app).windows.get(win).map(|w| w.page_fs).unwrap_or(false);
    // écran de chargement : la barre occupe toute la fenêtre, les pages se chargent cachées derrière
    if state(app).booting.contains(win) {
        if let Some(chrome) = app.get_webview(&format!("chrome-{win}")) {
            set_bounds(&chrome, LogicalPosition::new(0.0, 0.0), LogicalSize::new(width, height));
            let _ = chrome.show();
        }
        for id in tab_ids {
            if let Some(wv) = app.get_webview(&tab_label(id)) {
                set_bounds(&wv, LogicalPosition::new(0.0, ch), LogicalSize::new(width, (height - ch).max(50.0)));
                let _ = wv.hide();
            }
        }
        return;
    }

    if let Some(chrome) = app.get_webview(&format!("chrome-{win}")) {
        if ch > 0.0 {
            set_bounds(&chrome, LogicalPosition::new(0.0, 0.0), LogicalSize::new(width, ch));
            let _ = chrome.show();
        } else {
            // plein écran : barre masquée
            let _ = chrome.hide();
        }
    }

    let (pos, size) = content_rect(width, height, sidebar, ch);
    // vue côte à côte : l'onglet actif à gauche, l'autre à droite (séparés de 6 px)
    let split = state(app).windows.get(win).and_then(|w| w.split).filter(|s| !page_fs && Some(*s) != active && app.get_webview(&tab_label(*s)).is_some());
    let half = ((size.width - 6.0) / 2.0).floor();
    for id in tab_ids {
        if let Some(wv) = app.get_webview(&tab_label(id)) {
            if split.is_some() && Some(id) == active {
                set_bounds(&wv, pos, LogicalSize::new(half, size.height));
                let _ = wv.show();
            } else if split == Some(id) {
                set_bounds(&wv, LogicalPosition::new(pos.x + half + 6.0, pos.y), LogicalSize::new(size.width - half - 6.0, size.height));
                let _ = wv.show();
            } else if Some(id) == active {
                set_bounds(&wv, pos, size);
                let _ = wv.show();
            } else {
                let _ = wv.hide();
            }
        }
    }

    if let Some(panel) = app.get_webview(&format!("panel-{win}")) {
        let view = state(app).windows.get(win).map(|w| w.panel_view.clone()).unwrap_or_default();
        let (pos, size) = panel_rect_for(&view, width, height, sidebar, ch);
        if let (Some(pw), Some(main)) = (app.get_window(&format!("panw-{win}")), app.get_window(win)) {
            let scale = main.scale_factor().unwrap_or(1.0);
            if let Ok(o) = main.inner_position().map(|p| p.to_logical::<f64>(scale)) {
                let _ = pw.set_position(LogicalPosition::new(o.x + pos.x, o.y + pos.y));
                let _ = pw.set_size(size);
            }
            set_bounds(&panel, LogicalPosition::new(0.0, 0.0), size);
        } else {
            set_bounds(&panel, pos, size);
        }
    }

    // page d'IA cachée (réponses rapides) : toujours hors de la fenêtre
    for key in [win.to_string(), format!("{win}_s1"), format!("{win}_s2"), format!("{win}_s3"), format!("{win}_s4")] {
        if let Some(q) = app.get_webview(&format!("aiq-{key}")) {
            set_bounds(&q, LogicalPosition::new(width + 200.0, 0.0), LogicalSize::new(420.0, 820.0));
        }
    }
    // moteur de la recherche d'achat : hors de la fenêtre lui aussi
    if let Some(q) = app.get_webview(&format!("shopw-{win}")) {
        set_bounds(&q, LogicalPosition::new(width + 900.0, 0.0), LogicalSize::new(400.0, 700.0));
    }

    let side_x = (width - side_w()).max(0.0);
    if let Some(wv) = app.get_webview(&format!("aires-{win}")) {
        if sidebar && ai_created {
            set_bounds(&wv, LogicalPosition::new((side_x - GUTTER).max(0.0), ch), LogicalSize::new(GUTTER, (height - ch).max(50.0)));
            let _ = wv.show();
        } else {
            let _ = wv.hide();
        }
    }
    let native = bar_h > 1.0e5;
    let bar_h = bar_h.min((height - ch).max(50.0));
    for (label, y, h) in [
        (format!("aibar-{win}"), ch, bar_h),
        (format!("ai-{win}"), ch + bar_h, (height - ch - bar_h).max(50.0)),
    ] {
        if let Some(wv) = app.get_webview(&label) {
            if sidebar && ai_created && !(native && label.starts_with("ai-")) {
                set_bounds(&wv, LogicalPosition::new(side_x, y), LogicalSize::new(side_w(), h));
                let _ = wv.show();
            } else {
                let _ = wv.hide();
            }
        }
    }
}

fn layout(app: &AppHandle, win: &str) {
    let (w, h) = window_logical_size(app, win);
    layout_with(app, win, w, h);
}

// ---------------------------------------------------------------- fenêtres
fn create_window(app: &AppHandle, position: Option<(f64, f64)>, size: Option<(f64, f64)>) -> Result<String, String> {
    let label = {
        let mut b = state(app);
        b.next_win += 1;
        let label = format!("w{}", b.next_win);
        let sidebar_open = b.settings.sidebar_open;
        b.windows.insert(label.clone(), Win { sidebar_open, spaces: default_spaces(), ..Default::default() });
        label
    };

    let (w, h) = size.unwrap_or((1280.0, 820.0));
    let mut builder = WindowBuilder::new(app, &label)
        .title("Corrtex")
        .inner_size(w, h)
        .min_inner_size(640.0, 420.0)
        .shadow(true)
        ;
    // macOS : vrais boutons de fenêtre (feux tricolores) posés sur la barre d'onglets
    #[cfg(target_os = "macos")]
    {
        builder = builder.decorations(true).title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.decorations(false);
    }
    builder = match position {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };
    let window = builder.build().map_err(|e| e.to_string())?;

    // première fenêtre au lancement : écran de chargement le temps que les pages se préparent
    let boot = STARTUP.swap(false, std::sync::atomic::Ordering::Relaxed);
    let mut chrome = web(format!("chrome-{label}"), WebviewUrl::App("chrome.html".into()));
    if boot {
        state(app).booting.insert(label.clone());
        chrome = chrome.initialization_script("window.__corrtexBoot = true;");
    }
    window
        .add_child(chrome, LogicalPosition::new(0.0, 0.0), if boot { LogicalSize::new(w, h) } else { LogicalSize::new(w, CHROME_H) })
        .map_err(|e| e.to_string())?;
    if boot {
        let (h2, l2) = (app.clone(), label.clone());
        std::thread::spawn(move || {
            std::thread::sleep(BOOT_MAX);
            boot_done(&h2, &l2);
        });
    }

    let h = app.clone();
    let win = label.clone();
    window.on_window_event(move |event| match event {
        // dernière fenêtre fermée avec « Garder Corrtex ouvert » : réduite dans la barre des tâches
        WindowEvent::CloseRequested { api, .. } => {
            if keep_open_on_close(&h, &win) {
                api.prevent_close();
                close_suggest(&h, &win);
                close_popups(&h, &win);
                dismiss_panel(&h, &win);
                if let Some(w) = h.get_window(&win) {
                    let _ = w.minimize();
                }
                save_session(&h);
                save_history(&h);
            }
        }
        WindowEvent::Moved(_) => {
            close_suggest(&h, &win);
            close_popups(&h, &win);
            dismiss_panel(&h, &win);
        }
        // clic dans la fenêtre du navigateur : le menu ou le panneau ouvert se ferme
        WindowEvent::Focused(true) => {
            *LAST_FOCUSED.lock().unwrap_or_else(|e| e.into_inner()) = win.clone();
            if let Some(w) = h.get_window(&format!("popw-{win}")) {
                if w.is_visible().unwrap_or(false) {
                    let _ = w.hide();
                }
            }
            dismiss_panel(&h, &win);
        }
        WindowEvent::Resized(size) => {
            close_suggest(&h, &win);
            close_popups(&h, &win);
            let app = h.clone();
            let win = win.clone();
            let size = *size;
            // hors du fil principal pour ne jamais le bloquer
            tauri::async_runtime::spawn(async move {
                let Some(window) = app.get_window(&win) else { return };
                let scale = window.scale_factor().unwrap_or(1.0);
                let l = size.to_logical::<f64>(scale);
                let maximized = window.is_maximized().unwrap_or(false);
                let changed = {
                    let mut b = state(&app);
                    match b.windows.get_mut(&win) {
                        Some(w) => {
                            let c = w.maximized != maximized;
                            w.maximized = maximized;
                            c
                        }
                        None => false,
                    }
                };
                layout_with(&app, &win, l.width, l.height);
                if changed {
                    broadcast(&app);
                }
            });
        }
        WindowEvent::Destroyed => {
            // dernière fenêtre fermée : la session est enregistrée telle quelle avant de quitter
            let last = state(&h).windows.len() <= 1;
            if last {
                save_session(&h);
            }
            for p in ["popw", "prvw", "panw"] {
                if let Some(w) = h.get_window(&format!("{p}-{win}")) {
                    let _ = w.close();
                }
            }
            let mut b = state(&h);
            if let Some(w) = b.windows.remove(&win) {
                for id in w.tabs {
                    b.tabs.remove(&id);
                    if b.media.as_ref().map(|m| m.tab) == Some(id) {
                        b.media = None;
                    }
                }
            }
        }
        _ => {}
    });

    // petites fenêtres (menus, aperçu) préparées en avance, une fois la fenêtre affichée
    {
        let h = app.clone();
        let l = label.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1800));
            prewarm_popups(&h, &l);
        });
    }
    Ok(label)
}

static STARTUP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
const BOOT_MAX: Duration = Duration::from_millis(2000);

/// Fin de l'écran de chargement : il s'efface en fondu, puis la fenêtre reprend sa disposition.
fn boot_done(app: &AppHandle, win: &str) {
    if !state(app).booting.contains(win) {
        return;
    }
    if let Some(c) = app.get_webview(&format!("chrome-{win}")) {
        let _ = c.eval("window.__corrtexBooted && window.__corrtexBooted()");
    }
    let (app2, win2) = (app.clone(), win.to_string());
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(220));
        state(&app2).booting.remove(&win2);
        layout(&app2, &win2);
    });
}

/// Fermer cette fenêtre doit-il seulement la réduire ? (dernière fenêtre normale, réglage actif)
fn keep_open_on_close(app: &AppHandle, win: &str) -> bool {
    let b = state(app);
    if b.quitting || !b.settings.keep_running {
        return false;
    }
    let Some(w) = b.windows.get(win) else { return false };
    !w.private && b.windows.iter().filter(|(l, x)| l.as_str() != win && !x.private).count() == 0
}

/// Quitter vraiment Corrtex (la session est enregistrée).
fn quit_app(app: &AppHandle) {
    state(app).quitting = true;
    save_session(app);
    save_history(app);
    app.exit(0);
}

#[tauri::command]
async fn app_quit(app: AppHandle) {
    quit_app(&app);
}

/// Réglages du démarrage : mises à jour automatiques, garder Corrtex ouvert.
#[tauri::command]
async fn set_app_prefs(app: AppHandle, auto_update: Option<bool>, keep_running: Option<bool>) {
    {
        let mut b = state(&app);
        if let Some(v) = auto_update {
            b.settings.auto_update = v;
        }
        if let Some(v) = keep_running {
            b.settings.keep_running = v;
        }
    }
    save_settings(&app);
}

/// Corrtex relancé alors qu'il tourne déjà (réduit) : la fenêtre existante revient aussitôt ;
/// une adresse passée en argument (lien ouvert depuis une autre application) s'ouvre dans un onglet.
fn reopen_existing(app: &AppHandle, args: Vec<String>) {
    let win = {
        let b = state(app);
        b.windows.iter().find(|(_, w)| !w.private).map(|(l, _)| l.clone()).or_else(|| b.windows.keys().next().cloned())
    };
    let Some(win) = win else {
        if let Ok(w) = create_window(app, None, None) {
            let _ = create_tab(app, &w, None);
        }
        return;
    };
    if let Some(w) = app.get_window(&win) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    for a in args.into_iter().skip(1) {
        if a.starts_with("http://") || a.starts_with("https://") {
            let _ = create_tab(app, &win, Some(a));
        }
    }
}

fn close_window(app: &AppHandle, win: &str) {
    if let Some(w) = app.get_window(win) {
        let _ = w.close();
    }
}

// ---------------------------------------------------------------- onglets
/// Page d'erreur de Corrtex : l'adresse qui n'a pas pu s'ouvrir (dans « #c=…&u=… »).
fn failed_url_of(url: &str) -> Option<String> {
    if !is_internal(url) {
        return None;
    }
    let u = tauri::Url::parse(url).ok()?;
    if !u.path().ends_with("/error.html") {
        return None;
    }
    let frag = u.fragment()?;
    let q = tauri::Url::parse(&format!("x:?{frag}")).ok()?;
    let failed = q.query_pairs().find(|(k, _)| k == "u").map(|(_, v)| v.to_string())?;
    (failed.starts_with("http://") || failed.starts_with("https://")).then_some(failed)
}

fn is_internal(url: &str) -> bool {
    url.starts_with("tauri://") || url.starts_with("http://tauri.localhost") || url.starts_with("https://tauri.localhost")
}

/// Ajoute un onglet à la fenêtre (sans créer sa vue). `index` : place voulue, sinon juste
/// après l'onglet actif.
fn add_tab_record(b: &mut Browser, win: &str, url: String, title: String, favicon: String, index: Option<usize>, asleep: bool) -> u32 {
    b.next_tab += 1;
    let id = b.next_tab;
    b.tabs.insert(
        id,
        Tab {
            id,
            win: win.to_string(),
            url,
            title: if title.is_empty() { "Nouvel onglet".into() } else { title },
            favicon,
            loading: !asleep,
            can_back: false,
            can_fwd: false,
            pinned: false,
            group: 0,
            asleep,
            zoom: 1.0,
            page: String::new(),
            js_mem: 0,
            error_page: false,
            lang: String::new(),
            translated: false,
            product: None,
            space: 0,
            audible: false,
            muted: false,
            last_seen: Some(Instant::now()),
            scroll: 0.0,
        },
    );
    if let Some(w) = b.windows.get_mut(win) {
        let pos = match index {
            Some(i) => i.min(w.tabs.len()),
            None => w.active.and_then(|a| w.tabs.iter().position(|t| *t == a)).map(|p| p + 1).unwrap_or(w.tabs.len()),
        };
        w.tabs.insert(pos, id);
        let sp = w.space;
        if let Some(t) = b.tabs.get_mut(&id) {
            t.space = sp;
        }
    }
    normalize_order(b, win);
    id
}

/// Onglets épinglés toujours en premier (l'ordre des autres est conservé).
fn normalize_order(b: &mut Browser, win: &str) {
    let pinned: std::collections::HashSet<u32> = b.tabs.values().filter(|t| t.pinned).map(|t| t.id).collect();
    if let Some(w) = b.windows.get_mut(win) {
        let (mut p, rest): (Vec<u32>, Vec<u32>) = w.tabs.iter().partition(|id| pinned.contains(id));
        p.extend(rest);
        w.tabs = p;
        // groupes vides : retirés
        let used: std::collections::HashSet<u32> = w.tabs.iter().filter_map(|id| b.tabs.get(id)).map(|t| t.group).collect();
        w.groups.retain(|g| used.contains(&g.id));
    }
}

fn create_tab(app: &AppHandle, win: &str, url: Option<String>) -> Result<u32, String> {
    if let Some(u) = &url {
        if !u.is_empty() {
            u.parse::<tauri::Url>().map_err(|_| format!("URL invalide : {u}"))?;
        }
    }
    let id = add_tab_record(&mut state(app), win, url.unwrap_or_default(), String::new(), String::new(), None, false);
    spawn_tab_view(app, id)?;
    activate(app, id);
    Ok(id)
}

/// Crée la vue (la page) d'un onglet : à l'ouverture, ou au réveil d'un onglet en veille.
fn spawn_tab_view(app: &AppHandle, id: u32) -> Result<(), String> {
    let (win, url, page, private) = {
        let mut b = state(app);
        let t = b.tabs.get_mut(&id).ok_or("onglet introuvable")?;
        t.asleep = false;
        t.loading = true;
        let (win, url, page) = (t.win.clone(), t.url.clone(), t.page.clone());
        let private = b.windows.get(&win).map(|w| w.private).unwrap_or(false);
        (win, url, page, private)
    };
    let profile = state(app).windows.get(&win).map(|w| w.profile).unwrap_or(0);
    let window = app.get_window(&win).ok_or("fenêtre introuvable")?;
    let webview_url = if url.is_empty() {
        WebviewUrl::App(if page.is_empty() { "newtab.html".into() } else { page.into() })
    } else {
        WebviewUrl::External(url.parse().map_err(|_| format!("URL invalide : {url}"))?)
    };

    let app_title = app.clone();
    let app_load = app.clone();
    let app_popup = app.clone();
    let app_dl = app.clone();

    let mut builder = web(tab_label(id), webview_url);
    // profil : connexions, cookies et stockage séparés
    if profile != 0 && !private {
        if let Ok(dir) = app.path().app_data_dir() {
            builder = builder.data_directory(dir.join("profiles").join(format!("p{profile}")));
        }
        // macOS (WKWebView) : pas de dossier de données, un magasin identifié par profil (macOS 14+)
        #[cfg(target_os = "macos")]
        {
            let mut store = *b"corrtex-profile0";
            store[14] = b'p';
            store[15] = profile.min(255) as u8;
            builder = builder.data_store_identifier(store);
        }
    }
    let builder = builder
        .incognito(private)
        .initialization_script(TAB_SCRIPT)
        .on_document_title_changed(move |wv, title| {
            if let Some(id) = tab_id_from_label(wv.label()) {
                {
                    let mut b = state(&app_title);
                    let mut url = String::new();
                    if let Some(t) = b.tabs.get_mut(&id) {
                        t.title = if title.trim().is_empty() { "Nouvel onglet".into() } else { title.clone() };
                        url = t.url.clone();
                    }
                    // titre de la dernière visite de cette page dans l'historique
                    if !url.is_empty() {
                        let n = b.history.len();
                        if let Some(h) = b.history.iter_mut().rev().take(20).find(|h| h.url == url) {
                            h.title = title.chars().take(300).collect();
                        }
                        if n > 0 {
                            b.history_dirty = true;
                        }
                    }
                }
                broadcast(&app_title);
            }
        })
        .on_page_load(move |wv, payload| {
            if let Some(id) = tab_id_from_label(wv.label()) {
                let url = payload.url().to_string();
                let finished = matches!(payload.event(), PageLoadEvent::Finished);
                // mode concentration : site bloqué → page Corrtex à la place
                if !finished && focus_blocks(&app_load, &url) {
                    let site = site_of(&url);
                    if let Some(win) = win_of_tab(&app_load, id) {
                        if let Some(target) = internal_url(&app_load, &win, "/focus.html", &format!("s={}", form_enc(&site))) {
                            let _ = wv.navigate(target);
                        }
                    }
                    return;
                }
                let failed = failed_url_of(&url);
                {
                    let mut b = state(&app_load);
                    if let Some(t) = b.tabs.get_mut(&id) {
                        t.error_page = failed.is_some();
                        if t.loading {
                            t.translated = false;
                            t.product = None;
                        }
                        t.url = match &failed {
                            Some(f) => f.clone(),
                            None if is_internal(&url) => String::new(),
                            None => url.clone(),
                        };
                        // page de résultats du moteur Corrtex : gardée pour la session et la barre d'adresse
                        if let Some(u) = tauri::Url::parse(&url).ok().filter(|u| is_internal(&url) && u.path().ends_with("/search.html")) {
                            t.page = format!("search.html#{}", u.fragment().unwrap_or(""));
                        }
                        t.loading = !finished;
                        if t.loading {
                            t.favicon.clear();
                            t.scroll = 0.0;
                        }
                    }
                }
                broadcast(&app_load);
                if finished {
                    let _ = wv.eval(&page_theme_js(&app_load));
                    let _ = wv.eval(&keys_js(&app_load));
                    // première page prête : fin de l'écran de chargement
                    if let Some(win) = win_of_tab(&app_load, id) {
                        let active = state(&app_load).windows.get(&win).and_then(|w| w.active) == Some(id);
                        if active && state(&app_load).booting.contains(&win) {
                            boot_done(&app_load, &win);
                        }
                    }
                    // panneau de recherche d'achat ouvert dans cette fenêtre : il reste affiché sur la nouvelle page
                    if let Some(win) = win_of_tab(&app_load, id) {
                        let shown = state(&app_load).shopping_open.get(&win) == Some(&id);
                        if shown {
                            shopping_show_in(&app_load, &win, id);
                        }
                    }
                    // son coupé : la nouvelle page reste muette
                    if state(&app_load).tabs.get(&id).map(|t| t.muted).unwrap_or(false) {
                        let _ = wv.eval("window.__corrtexMute && window.__corrtexMute(true)");
                    }
                    let private = {
                        let b = state(&app_load);
                        b.tabs.get(&id).and_then(|t| b.windows.get(&t.win)).map(|w| w.private).unwrap_or(false)
                    };
                    if !private {
                        record_visit(&app_load, &url);
                    }
                    apply_site_zoom(&app_load, id, &wv, &url);
                    agent_page_loaded(&app_load, id, &wv);
                }
                if finished && is_google_search(&url) {
                    let _ = wv.eval(&google_skin_js(&app_load));
                }
                // après une connexion / déconnexion Google, on relit le profil
                if finished && (url.starts_with("https://accounts.google.") || url.starts_with("https://myaccount.google.")) {
                    schedule_google_probe(&app_load, Duration::from_millis(1500));
                }
            }
        })
        .on_download(move |_wv, event| {
            on_download_event(&app_dl, event);
            true
        })
        .on_new_window(move |url, features| {
            // Pop-up avec une taille (connexion Google, paiement…) : vraie fenêtre.
            if features.size().is_some() {
                return NewWindowResponse::Allow;
            }
            // Liens "ouvrir dans un nouvel onglet" : nouvel onglet dans la même fenêtre,
            // dans le même groupe que l'onglet d'origine.
            let app = app_popup.clone();
            let u = url.to_string();
            tauri::async_runtime::spawn(async move {
                if let Some(win) = win_of_tab(&app, id) {
                    if let Ok(new_id) = create_tab(&app, &win, Some(u)) {
                        let changed = {
                            let mut b = state(&app);
                            let g = b.tabs.get(&id).filter(|t| !t.pinned).map(|t| t.group).unwrap_or(0);
                            match b.tabs.get_mut(&new_id) {
                                Some(t) if g != 0 => {
                                    t.group = g;
                                    true
                                }
                                _ => false,
                            }
                        };
                        if changed {
                            broadcast(&app);
                        }
                    }
                }
            });
            NewWindowResponse::Deny
        });

    let (w, h) = window_logical_size(app, &win);
    let sidebar = state(app).windows.get(&win).map(|w| w.sidebar_open).unwrap_or(false);
    let (pos, size) = content_rect(w, h, sidebar, CHROME_H);
    window.add_child(builder, pos, size).map_err(|e| e.to_string())?;
    watch_history(app, id);
    Ok(())
}

/// Suit l'historique de l'onglet (WebView2 : HistoryChanged) pour griser les flèches
/// précédent / suivant quand on ne peut pas reculer ou avancer.
#[cfg(windows)]
fn watch_history(app: &AppHandle, id: u32) {
    use webview2_com::HistoryChangedEventHandler;
    use windows_core::BOOL;
    let Some(wv) = app.get_webview(&tab_label(id)) else { return };
    let app = app.clone();
    let app_err = app.clone();
    // seuls les appels COM sont « unsafe » (les gestionnaires ont leurs propres blocs)
    let _ = wv.with_webview(move |pw| {
        let Ok(core) = (unsafe { pw.controller().CoreWebView2() }) else { return };
        let handler = HistoryChangedEventHandler::create(Box::new(move |sender, _| {
            if let Some(core) = sender {
                let (mut back, mut fwd) = (BOOL::default(), BOOL::default());
                unsafe {
                    let _ = core.CanGoBack(&mut back);
                    let _ = core.CanGoForward(&mut fwd);
                }
                let changed = {
                    let mut b = state(&app);
                    match b.tabs.get_mut(&id) {
                        Some(t) if t.can_back != back.as_bool() || t.can_fwd != fwd.as_bool() => {
                            t.can_back = back.as_bool();
                            t.can_fwd = fwd.as_bool();
                            true
                        }
                        _ => false,
                    }
                };
                if changed {
                    broadcast(&app);
                }
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = unsafe { core.add_HistoryChanged(&handler, &mut token) };

        // la page n'a pas pu s'ouvrir : page d'erreur Corrtex à la place de celle du moteur
        let app_nav = app_err.clone();
        let nav = webview2_com::NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
            let (Some(core), Some(args)) = (sender, args) else { return Ok(()) };
            let mut ok = BOOL::default();
            let mut status = webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_ERROR_STATUS::default();
            let mut uri = windows_core::PWSTR::null();
            unsafe {
                let _ = args.IsSuccess(&mut ok);
                let _ = args.WebErrorStatus(&mut status);
                let _ = core.Source(&mut uri);
            }
            // 14 : annulée, 9 : interrompue (l'utilisateur est allé ailleurs) ; 0 : erreur HTTP (page du site affichée)
            if ok.as_bool() || matches!(status.0, 0 | 9 | 14) {
                return Ok(());
            }
            let failed = unsafe { uri.to_string().unwrap_or_default() };
            if !(failed.starts_with("http://") || failed.starts_with("https://")) {
                return Ok(());
            }
            let app2 = app_nav.clone();
            tauri::async_runtime::spawn(async move { show_error_page(&app2, id, &failed, status.0) });
            Ok(())
        }));
        let mut token2 = 0i64;
        let _ = unsafe { core.add_NavigationCompleted(&nav, &mut token2) };
    });
}

/// Adresse d'une page de Corrtex (même origine que la barre du navigateur).
fn internal_url(app: &AppHandle, win: &str, path: &str, fragment: &str) -> Option<tauri::Url> {
    let mut target = app.get_webview(&format!("chrome-{win}")).and_then(|c| c.url().ok())?;
    target.set_path(path);
    target.set_query(None);
    target.set_fragment(Some(fragment));
    Some(target)
}

/// Adresse de la page interne d'erreur pour une adresse qui n'a pas pu s'ouvrir.
#[cfg_attr(not(windows), allow(dead_code))]
fn show_error_page(app: &AppHandle, id: u32, failed: &str, code: i32) {
    let Some(wv) = app.get_webview(&tab_label(id)) else { return };
    // origine des pages de Corrtex (celle de la barre du navigateur)
    let Some(win) = win_of_tab(app, id) else { return };
    let Some(base) = app.get_webview(&format!("chrome-{win}")).and_then(|c| c.url().ok()) else { return };
    let mut target = base.clone();
    target.set_path("/error.html");
    target.set_query(None);
    let enc: String = failed.bytes().map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
        _ => format!("%{b:02X}"),
    }).collect();
    target.set_fragment(Some(&format!("c={code}&u={enc}")));
    let _ = wv.navigate(target);
}

#[cfg(not(windows))]
fn watch_history(_app: &AppHandle, _id: u32) {}

fn activate(app: &AppHandle, id: u32) {
    activate_with(app, id, true);
}

/// Active un onglet. `focus = false` quand on clique dans la barre d'onglets : donner le
/// focus à la page interromprait le suivi de la souris (glisser-déposer des onglets).
fn activate_with(app: &AppHandle, id: u32, focus: bool) {
    let prev_shown: Option<u32>;
    let Some((win, asleep)) = ({
        let mut b = state(app);
        let win = b.tabs.get(&id).map(|t| t.win.clone());
        let prev = win.as_ref().and_then(|w| b.windows.get(w)).and_then(|w| w.active);
        // cliquer sur l'onglet de droite de la vue côte à côte : l'ancien reste visible (il passe à droite)
        let to_split = win.as_ref().and_then(|w| b.windows.get(w)).and_then(|w| w.split) == Some(id);
        prev_shown = if to_split { None } else { prev };
        let space = b.tabs.get(&id).map(|t| t.space).unwrap_or(0);
        if let Some(w) = win.as_ref().and_then(|w| b.windows.get_mut(w)) {
            // côte à côte : cliquer sur l'onglet de droite échange les côtés ; un autre onglet referme la vue
            if w.split == Some(id) {
                w.split = prev;
            } else if prev != Some(id) && w.split.is_some() {
                w.split = None;
            }
            w.active = Some(id);
            w.space = space;
            if let Some(sp) = w.spaces.iter_mut().find(|s| s.id == space) {
                sp.last = Some(id);
            }
        }
        let now = Instant::now();
        for t in [prev, Some(id)].into_iter().flatten() {
            if let Some(tab) = b.tabs.get_mut(&t) {
                tab.last_seen = Some(now);
            }
        }
        let asleep = b.tabs.get(&id).map(|t| t.asleep).unwrap_or(false);
        let gid = b.tabs.get(&id).map(|t| t.group).unwrap_or(0);
        if gid != 0 {
            if let Some(w) = win.as_ref().and_then(|w| b.windows.get_mut(w)) {
                if let Some(g) = w.groups.iter_mut().find(|g| g.id == gid) {
                    g.collapsed = false;
                }
            }
        }
        win.map(|w| (w, asleep))
    }) else {
        return;
    };
    if asleep {
        if let Err(e) = spawn_tab_view(app, id) {
            debug_log(&format!("réveil de l'onglet impossible : {e}"));
        }
    }
    // l'onglet quitté consomme moins de mémoire tant qu'il est caché
    if let Some(p) = prev_shown.filter(|p| *p != id) {
        memory_hint(app, p, false);
    }
    memory_hint(app, id, true);
    layout(app, &win);
    if focus {
        if let Some(wv) = app.get_webview(&tab_label(id)) {
            let _ = wv.set_focus();
        }
    }
    // vidéo en plein écran dans l'onglet quitté : on en sort
    if state(app).windows.get(&win).map(|w| w.page_fs).unwrap_or(false) {
        if let Some(wv) = prev_shown.filter(|p| *p != id).and_then(|p| app.get_webview(&tab_label(p))) {
            let _ = wv.eval("document.fullscreenElement && document.exitFullscreen()");
        }
        set_page_fullscreen(app, &win, false);
    }
    shopping_follow(app, &win);
    broadcast(app);
}

/// Retire l'onglet de sa fenêtre (sans fermer sa vue) et choisit le suivant à afficher.
fn unlink_tab(b: &mut Browser, id: u32) -> Option<(String, Option<u32>)> {
    let win = b.tabs.get(&id)?.win.clone();
    let w = b.windows.get_mut(&win)?;
    let idx = w.tabs.iter().position(|t| *t == id)?;
    w.tabs.remove(idx);
    if w.split == Some(id) {
        w.split = None;
    }
    if w.active == Some(id) {
        // l'onglet de droite de la vue côte à côte prend la place ; sinon un voisin du même espace
        if let Some(s) = w.split.take() {
            w.active = Some(s);
        } else {
            let space = b.tabs.get(&id).map(|t| t.space).unwrap_or(0);
            let tabs = &b.tabs;
            let same = |t: &&u32| tabs.get(t).map(|x| x.space == space).unwrap_or(false);
            w.active = w.tabs[idx.min(w.tabs.len())..].iter().find(same).or_else(|| w.tabs[..idx.min(w.tabs.len())].iter().rev().find(same))
                .or_else(|| w.tabs.get(idx).or_else(|| w.tabs.last())).copied();
        }
    }
    Some((win, w.active))
}

fn close(app: &AppHandle, id: u32) {
    let Some((win, next)) = ({
        let mut b = state(app);
        if let Some(t) = b.tabs.get(&id).cloned() {
            let private = b.windows.get(&t.win).map(|w| w.private).unwrap_or(false);
            if !t.url.is_empty() && !private {
                let index = b.windows.get(&t.win).and_then(|w| w.tabs.iter().position(|x| *x == id)).unwrap_or(0);
                b.closed.push(ClosedTab { url: t.url, title: t.title, favicon: t.favicon, win: t.win.clone(), index, group: t.group });
                if b.closed.len() > 25 {
                    b.closed.remove(0);
                }
            }
        }
        let r = unlink_tab(&mut b, id);
        b.tabs.remove(&id);
        if b.media.as_ref().map(|m| m.tab) == Some(id) {
            b.media = None;
        }
        if let Some((w, _)) = &r {
            let w = w.clone();
            normalize_order(&mut b, &w);
        }
        r
    }) else {
        return;
    };
    if let Some(wv) = app.get_webview(&tab_label(id)) {
        let _ = wv.close();
    }
    match next {
        Some(n) => activate(app, n),
        // Dernier onglet de la fenêtre fermé : on ferme la fenêtre.
        None => {
            close_window(app, &win);
            broadcast(app);
        }
    }
}

fn active_webview(app: &AppHandle, win: &str) -> Option<Webview> {
    let id = state(app).windows.get(win)?.active?;
    app.get_webview(&tab_label(id))
}

fn cycle_tab(app: &AppHandle, win: &str, delta: i32) {
    let target = {
        let b = state(app);
        let Some(w) = b.windows.get(win) else { return };
        let n = w.tabs.len() as i32;
        if n == 0 {
            return;
        }
        // seulement les onglets de l'espace affiché
        let list: Vec<u32> = w.tabs.iter().copied().filter(|t| b.tabs.get(t).map(|x| x.space == w.space).unwrap_or(false)).collect();
        if list.is_empty() {
            return;
        }
        let n = list.len() as i32;
        let cur = list.iter().position(|t| Some(*t) == w.active).unwrap_or(0) as i32;
        list[((cur + delta).rem_euclid(n)) as usize]
    };
    activate(app, target);
}

/// Fenêtre Corrtex (autre que `except`) dont la barre d'onglets se trouve sous le point
/// (coordonnées d'écran logiques), avec la position d'insertion estimée.
fn window_under(app: &AppHandle, except: &str, x: f64, y: f64) -> Option<(String, usize)> {
    let labels: Vec<(String, usize)> = state(app).windows.iter().filter(|(l, _)| l.as_str() != except).map(|(l, w)| (l.clone(), w.tabs.len())).collect();
    for (label, count) in labels {
        let Some(w) = app.get_window(&label) else { continue };
        if w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(true) {
            continue;
        }
        let (Ok(pos), Ok(size), Ok(scale)) = (w.outer_position(), w.inner_size(), w.scale_factor()) else { continue };
        let (wx, wy) = (pos.x as f64 / scale, pos.y as f64 / scale);
        let ww = size.width as f64 / scale;
        // zone de dépôt : la barre d'onglets, avec un peu de marge
        if x >= wx && x <= wx + ww && y >= wy - 10.0 && y <= wy + 40.0 + 30.0 {
            let tab_w = ((ww - 44.0 - 260.0) / (count as f64 + 1.0)).min(234.0).max(40.0);
            let index = (((x - wx - 44.0) / tab_w).round().max(0.0) as usize).min(count);
            return Some((label, index));
        }
    }
    None
}

/// Rattache un onglet à une autre fenêtre (glisser-déposer sur sa barre d'onglets).
fn attach(app: &AppHandle, id: u32, target: &str, index: usize) -> Result<(), String> {
    {
        let b = state(app);
        let from_private = b.tabs.get(&id).and_then(|t| b.windows.get(&t.win)).map(|w| w.private).unwrap_or(false);
        let to_private = b.windows.get(target).map(|w| w.private).unwrap_or(false);
        if from_private != to_private {
            return Err("un onglet privé reste dans une fenêtre privée".into());
        }
    }
    let window = app.get_window(target).ok_or("fenêtre introuvable")?;
    let wv = app.get_webview(&tab_label(id));
    let (old_win, next) = {
        let mut b = state(app);
        let (old, next) = unlink_tab(&mut b, id).ok_or("onglet introuvable")?;
        let sp = b.windows.get(target).map(|w| w.space).unwrap_or(0);
        if let Some(t) = b.tabs.get_mut(&id) {
            t.win = target.to_string();
            t.group = 0; // les groupes appartiennent à leur fenêtre
            t.space = sp; // tout comme les espaces
        }
        if let Some(w) = b.windows.get_mut(target) {
            let i = index.min(w.tabs.len());
            w.tabs.insert(i, id);
            w.active = Some(id);
        }
        normalize_order(&mut b, target);
        normalize_order(&mut b, &old);
        (old, next)
    };
    match &wv {
        Some(wv) => wv.reparent(&window).map_err(|e| e.to_string())?,
        None => spawn_tab_view(app, id)?,
    }
    layout(app, target);
    let _ = window.set_focus();
    if let Some(wv) = app.get_webview(&tab_label(id)) {
        let _ = wv.set_focus();
    }
    match next {
        Some(n) => activate(app, n),
        None => close_window(app, &old_win),
    }
    broadcast(app);
    Ok(())
}

/// Déplace un onglet dans une nouvelle fenêtre placée en (x, y) (coordonnées logiques).
fn move_to_new_window(app: &AppHandle, id: u32, x: f64, y: f64) -> Result<String, String> {
    let old_win = win_of_tab(app, id).ok_or("onglet introuvable")?;
    let size = window_logical_size(app, &old_win);
    let new_win = create_window(app, Some((x, y)), Some(size))?;
    {
        // la nouvelle fenêtre garde la confidentialité de l'onglet
        let mut b = state(app);
        let private = b.windows.get(&old_win).map(|w| w.private).unwrap_or(false);
        if let Some(w) = b.windows.get_mut(&new_win) {
            w.private = private;
        }
    }
    let window = app.get_window(&new_win).ok_or("fenêtre introuvable")?;
    let wv = app.get_webview(&tab_label(id));
    let next = {
        let mut b = state(app);
        let next = unlink_tab(&mut b, id).and_then(|(_, n)| n);
        if let Some(t) = b.tabs.get_mut(&id) {
            t.win = new_win.clone();
            t.group = 0;
            t.pinned = false;
            t.space = 0;
        }
        if let Some(w) = b.windows.get_mut(&new_win) {
            w.tabs.push(id);
            w.active = Some(id);
        }
        normalize_order(&mut b, &old_win);
        next
    };
    match &wv {
        Some(wv) => wv.reparent(&window).map_err(|e| e.to_string())?,
        None => spawn_tab_view(app, id)?,
    }
    layout(app, &new_win);
    match next {
        Some(n) => activate(app, n),
        None => close_window(app, &old_win),
    }
    let _ = window.set_focus();
    broadcast(app);
    Ok(new_win)
}

/// Change la place d'un onglet dans sa fenêtre.
fn reorder(app: &AppHandle, id: u32, index: usize) -> bool {
    let mut b = state(app);
    let Some(win) = b.tabs.get(&id).map(|t| t.win.clone()) else { return false };
    let Some(w) = b.windows.get(&win) else { return false };
    let Some(from) = w.tabs.iter().position(|t| *t == id) else { return false };
    let mut to = index.min(w.tabs.len() - 1);
    let order = w.tabs.clone();
    // les onglets épinglés restent entre eux, à gauche
    let pinned_count = order.iter().filter(|t| b.tabs.get(t).map(|x| x.pinned).unwrap_or(false)).count();
    let is_pinned = b.tabs.get(&id).map(|t| t.pinned).unwrap_or(false);
    to = if is_pinned { to.min(pinned_count.saturating_sub(1)) } else { to.max(pinned_count) };
    if from == to {
        return false;
    }
    let Some(w) = b.windows.get_mut(&win) else { return false };
    w.tabs.remove(from);
    w.tabs.insert(to, id);
    // posé entre deux onglets d'un même groupe : il le rejoint ; sorti de son groupe : il le quitte
    let order = w.tabs.clone();
    let group_of = |i: usize| order.get(i).and_then(|t| b.tabs.get(t)).map(|t| t.group).unwrap_or(0);
    let (left, right) = (if to > 0 { group_of(to - 1) } else { 0 }, group_of(to + 1));
    if !is_pinned {
        let cur = b.tabs.get(&id).map(|t| t.group).unwrap_or(0);
        let new_group = if left != 0 && left == right {
            left
        } else if cur != 0 && left != cur && right != cur {
            0
        } else {
            cur
        };
        if let Some(t) = b.tabs.get_mut(&id) {
            t.group = new_group;
        }
    }
    normalize_order(&mut b, &win);
    true
}

// ---------------------------------------------------------------- glisser un onglet hors de la fenêtre
// Comme dans Chrome : dès que l'onglet quitte la barre, une fenêtre le contient et suit
// la souris ; survoler la barre d'onglets d'une autre fenêtre l'y rattache aussitôt.
// Tant que le bouton de la souris reste enfoncé, Corrtex suit le curseur.

#[cfg(windows)]
fn mouse_button_down() -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn GetAsyncKeyState(vkey: i32) -> i16;
        fn GetSystemMetrics(index: i32) -> i32;
    }
    unsafe {
        // boutons inversés (gauchers) : le bouton principal est alors le droit
        let vk = if GetSystemMetrics(23) != 0 { 0x02 } else { 0x01 };
        (GetAsyncKeyState(vk) as u16 & 0x8000) != 0
    }
}

#[cfg(target_os = "macos")]
fn mouse_button_down() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
    }
    // état combiné de la session (0), bouton gauche (0)
    unsafe { CGEventSourceButtonState(0, 0) }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn mouse_button_down() -> bool {
    false
}

// position du premier onglet dans la barre (macOS : place laissée aux feux tricolores)
#[cfg(target_os = "macos")]
const STRIP_TAB_X: f64 = 80.0;
#[cfg(not(target_os = "macos"))]
const STRIP_TAB_X: f64 = 44.0;
const DETACH_MARGIN: f64 = 45.0;

/// Le curseur est-il encore sur la barre d'onglets de la fenêtre `win` ?
fn over_strip(app: &AppHandle, win: &str, x: f64, y: f64) -> bool {
    let Some(w) = app.get_window(win) else { return false };
    let (Ok(pos), Ok(size), Ok(scale)) = (w.outer_position(), w.inner_size(), w.scale_factor()) else { return false };
    let (wx, wy, ww) = (pos.x as f64 / scale, pos.y as f64 / scale, size.width as f64 / scale);
    x >= wx - DETACH_MARGIN && x <= wx + ww + DETACH_MARGIN && y >= wy - DETACH_MARGIN && y <= wy + 40.0 + DETACH_MARGIN
}

fn strip_index(app: &AppHandle, win: &str, x: f64) -> usize {
    let count = state(app).windows.get(win).map(|w| w.tabs.len()).unwrap_or(1).max(1);
    let Some(w) = app.get_window(win) else { return 0 };
    let (Ok(pos), Ok(size), Ok(scale)) = (w.outer_position(), w.inner_size(), w.scale_factor()) else { return 0 };
    let (wx, ww) = (pos.x as f64 / scale, size.width as f64 / scale);
    let tab_w = ((ww - STRIP_TAB_X - 260.0) / count as f64).min(234.0).max(40.0);
    (((x - wx - STRIP_TAB_X) / tab_w).floor().max(0.0) as usize).min(count - 1)
}

fn cursor_logical(app: &AppHandle, win: &str) -> Option<(f64, f64)> {
    let p = app.cursor_position().ok()?;
    let scale = app.get_window(win).and_then(|w| w.scale_factor().ok()).unwrap_or(1.0);
    Some((p.x / scale, p.y / scale))
}

enum DragMode {
    /// l'onglet est seul dans une fenêtre qui suit la souris
    Floating(String),
    /// l'onglet est dans la barre d'une fenêtre
    Docked(String),
}

fn drag_loop(app: AppHandle, id: u32, grab_x: f64) {
    let Some(src) = win_of_tab(&app, id) else { return };
    let offset = (STRIP_TAB_X + grab_x, 20.0);
    let alone = state(&app).windows.get(&src).map(|w| w.tabs.len() <= 1).unwrap_or(true);

    let mut mode = if alone {
        DragMode::Floating(src.clone())
    } else {
        let Some((cx, cy)) = cursor_logical(&app, &src) else { return };
        match move_to_new_window(&app, id, cx - offset.0, cy - offset.1) {
            Ok(w) => DragMode::Floating(w),
            Err(_) => return,
        }
    };

    let started = Instant::now();
    loop {
        let Some(win) = (match &mode { DragMode::Floating(w) | DragMode::Docked(w) => Some(w.clone()) }) else { break };
        let Some((cx, cy)) = cursor_logical(&app, &win) else { break };

        match &mode {
            DragMode::Floating(w) => {
                if let Some(window) = app.get_window(w) {
                    let _ = window.set_position(LogicalPosition::new(cx - offset.0, cy - offset.1));
                }
                // au-dessus de la barre d'onglets d'une autre fenêtre : on s'y rattache
                if let Some((target, index)) = window_under(&app, w, cx, cy) {
                    if attach(&app, id, &target, index).is_ok() {
                        mode = DragMode::Docked(target);
                    }
                }
            }
            DragMode::Docked(w) => {
                if over_strip(&app, w, cx, cy) {
                    if reorder(&app, id, strip_index(&app, w, cx)) {
                        broadcast(&app);
                    }
                } else if let Ok(new_win) = move_to_new_window(&app, id, cx - offset.0, cy - offset.1) {
                    mode = DragMode::Floating(new_win);
                }
            }
        }

        // bouton relâché : fin du glisser (sur les autres systèmes, une seule étape)
        if !mouse_button_down() || started.elapsed() > Duration::from_secs(120) {
            break;
        }
        std::thread::sleep(Duration::from_millis(8));
    }

    if let Some(w) = win_of_tab(&app, id).and_then(|w| app.get_window(&w)) {
        let _ = w.set_focus();
    }
    activate(&app, id);
}

// ---------------------------------------------------------------- panneaux superposés
// Panneau des extensions et liste de suggestions : des vues créées au moment de les
// afficher, pour passer au-dessus de la page (et fermées ensuite, pour rester léger).
const PANEL_W: f64 = 384.0;

/// Le comparateur de prix est un panneau latéral plus large, sur toute la hauteur.
fn panel_rect_for(view: &str, width: f64, height: f64, sidebar: bool, top: f64) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    let side = if sidebar { side_w() } else { 0.0 };
    if view == "shop" {
        // sous la barre (et les favoris), sur la page
        let w = 420.0_f64.min(width - side - 16.0).max(280.0);
        let y = top + 8.0;
        return (LogicalPosition::new((width - side - w - 8.0).max(0.0), y), LogicalSize::new(w, (height - y - 8.0).max(200.0)));
    }
    // recherche d'achat : même tiroir, plus large pour les fiches des articles
    if view == "shopping" {
        let w = 540.0_f64.min(width - side);
        return (LogicalPosition::new((width - side - w).max(0.0), top), LogicalSize::new(w, (height - top).max(200.0)));
    }
    // Extensions / Outils : zone transparente à droite de la page ; le panneau y est dessiné
    // exactement comme sur la page d'accueil (marges de 14 px, coins arrondis, ombre)
    let w = (PANEL_W + 54.0).min(width - side);
    (LogicalPosition::new((width - side - w).max(0.0), top), LogicalSize::new(w, (height - top).max(200.0)))
}

fn overlay_builder(label: String, page: &str) -> WebviewBuilder<tauri::Wry> {
    // opaque : sous Windows, une vue transparente posée sur une autre s'affiche en noir.
    // focused(false) : la barre d'adresse garde le focus pendant la frappe
    web(label, WebviewUrl::App(page.into())).focused(false)
}

#[tauri::command]
async fn toggle_ext_panel(app: AppHandle, webview: Webview, view: Option<String>) -> Result<bool, String> {
    // un seul panneau à la fois, par-dessus la page : « extensions » ou « tools » (Outils)
    let win = caller_win(&webview);
    // recherche d'achat : panneau en verre dans la page (comme le comparateur)
    if view.as_deref() == Some("shopping") {
        close_panel_window(&app, &win);
        if let Some(w) = state(&app).windows.get_mut(&win) {
            w.panel_view.clear();
        }
        shopping_toggle(&app, &win);
        return Ok(false);
    }
    // comparateur : carte affichée dans la page elle-même (verre sur la page)
    if view.as_deref() == Some("shop") {
        if let Some(wv) = active_webview(&app, &win) {
            let _ = wv.eval("window.__corrtexShopOpen && window.__corrtexShopOpen()");
        }
        return Ok(false);
    }
    let view = match view.as_deref() {
        Some("tools") => "tools",
        Some("shopping") => "shopping",
        _ => "extensions",
    };
    let label = format!("panel-{win}");
    // le clic sur le bouton vient de refermer ce même panneau : il reste fermé
    let just_closed = state(&app).panel_dismissed.remove(&win).filter(|(v, t)| v == view && t.elapsed() < Duration::from_millis(500)).is_some();
    if just_closed {
        return Ok(false);
    }
    let current = state(&app).windows.get(&win).map(|w| w.panel_view.clone()).unwrap_or_default();
    if app.get_webview(&label).is_some() {
        close_panel_window(&app, &win);
        if let Some(w) = state(&app).windows.get_mut(&win) {
            w.panel_view.clear();
        }
        let _ = app.emit_to(format!("chrome-{win}").as_str(), "ext-panel", serde_json::json!({ "win": win, "open": false, "view": current }));
        if current == view {
            return Ok(false);
        }
    }
    let window = app.get_window(&win).ok_or("fenêtre introuvable")?;
    let (w, h) = window_logical_size(&app, &win);
    let (sidebar, ch) = {
        let b = state(&app);
        (b.windows.get(&win).map(|w| w.sidebar_open).unwrap_or(false), chrome_height(&b, &win))
    };
    let (pos, size) = panel_rect_for(view, w, h, sidebar, ch);
    let page = match view {
        "tools" => "tools.html",
        "shop" => "shop.html",
        "shopping" => "shopping.html",
        _ => "panel.html",
    };
    let _ = window;
    open_panel_window(&app, &win, page, pos, size)?;
    if let Some(w) = state(&app).windows.get_mut(&win) {
        w.panel_view = view.to_string();
    }
    let _ = app.emit_to(format!("chrome-{win}").as_str(), "ext-panel", serde_json::json!({ "win": win, "open": true, "view": view }));
    Ok(true)
}

/// Comparateur de prix : l'article détecté dans l'onglet actif de la fenêtre.
#[tauri::command]
async fn shop_context(app: AppHandle, webview: Webview) -> serde_json::Value {
    let win = caller_win(&webview);
    let b = state(&app);
    let Some(id) = b.windows.get(&win).and_then(|w| w.active) else { return serde_json::Value::Null };
    let Some(t) = b.tabs.get(&id) else { return serde_json::Value::Null };
    serde_json::json!({ "tab": id, "url": t.url, "title": t.title, "product": t.product })
}

/// Télécharge une page d'un comparateur (leDénicheur) ou d'un site de codes promo (Dealabs) ;
/// l'analyse se fait dans le panneau. Seuls ces sites sont autorisés.
/// Adresse autorisée pour l'agent d'achat : comparateur, Dealabs, ou boutique activée dans les réglages.
fn shop_url_allowed(url: &str, extra: &[String]) -> Result<(), String> {
    let u = tauri::Url::parse(url).map_err(|_| "adresse invalide")?;
    let host = u.host_str().unwrap_or("").to_lowercase();
    let bare = host.strip_prefix("www.").unwrap_or(&host).to_string();
    let base = matches!(host.as_str(), "ledenicheur.fr" | "www.ledenicheur.fr" | "www.dealabs.com" | "dealabs.com");
    let allowed = base || extra.iter().any(|h| bare == *h || bare.ends_with(&format!(".{h}")));
    if u.scheme() != "https" || !allowed {
        return Err("site non autorisé".into());
    }
    Ok(())
}

fn fetch_shop_page(url: &str, extra: &[String]) -> Result<String, String> {
    let u = tauri::Url::parse(url).map_err(|_| "adresse invalide")?;
    let host = u.host_str().unwrap_or("").to_lowercase();
    let bare = host.strip_prefix("www.").unwrap_or(&host).to_string();
    let base = matches!(host.as_str(), "ledenicheur.fr" | "www.ledenicheur.fr" | "www.dealabs.com" | "dealabs.com");
    // boutiques activées dans les réglages (domaine exact ou sous-domaine)
    let allowed = base || extra.iter().any(|h| bare == *h || bare.ends_with(&format!(".{h}")));
    if u.scheme() != "https" || !allowed {
        return Err("site non autorisé".into());
    }
    {
        let mut cmd = std::process::Command::new(if cfg!(windows) { "curl.exe" } else { "curl" });
        cmd.args([
            "-s", "-L", "--max-time", "15",
            "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
            "-H", "Accept: text/html,application/xhtml+xml",
            "-H", "Accept-Language: fr-FR,fr;q=0.9",
            "-w", "\n%{http_code}",
            u.as_str(),
        ]);
        cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let out = cmd.output().map_err(|e| e.to_string())?;
        let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
        // le code HTTP est ajouté en dernière ligne
        let code = text.rfind('\n').map(|i| text.split_off(i)).unwrap_or_default();
        let code: u16 = code.trim().parse().unwrap_or(0);
        if code == 404 {
            return Err("introuvable".into());
        }
        if !(200..300).contains(&code) {
            return Err(format!("le site a refusé la demande ({code})"));
        }
        Ok(text)
    }
}

#[tauri::command]
async fn shop_fetch(app: AppHandle, url: String) -> Result<String, String> {
    let extra: Vec<String> = state(&app).settings.shop_sites.iter().filter(|s| s.on).filter_map(|s| shop_site_host(&s.search)).collect();
    shop_url_allowed(&url, &extra)?;
    // client rapide (connexions ouvertes, cache) ; curl en secours si le site le refuse
    match search::shop_get(url.clone()).await {
        Ok(t) => Ok(t),
        Err(e) if e.contains("refusé") || e.contains("injoignable") => {
            tauri::async_runtime::spawn_blocking(move || fetch_shop_page(&url, &extra)).await.map_err(|e| e.to_string())?
        }
        Err(e) => Err(e),
    }
}

/// Envoie une demande au panneau IA (l'ouvre s'il est fermé), par ex. « génère une image ».
#[tauri::command]
async fn ai_prompt(app: AppHandle, webview: Webview, prompt: String) -> Result<(), String> {
    let win = caller_win(&webview);
    ai_send(&app, &win, prompt.chars().take(4000).collect())
}

/// Page de résultats du moteur Corrtex : la recherche affichée (pour la barre d'adresse et la session).
#[tauri::command]
async fn search_page(app: AppHandle, webview: Webview, hash: String) {
    let Some(id) = webview.label().strip_prefix("tab-").and_then(|n| n.parse::<u32>().ok()) else { return };
    let hash: String = hash.trim_start_matches('#').chars().take(800).collect();
    if let Some(t) = state(&app).tabs.get_mut(&id) {
        t.url.clear();
        t.page = format!("search.html#{hash}");
    }
    broadcast(&app);
}

/// Boutiques de l'agent d'achat (réglages).
#[tauri::command]
async fn shop_sites_get(app: AppHandle) -> Vec<ShopSite> {
    state(&app).settings.shop_sites.clone()
}

#[tauri::command]
async fn shop_sites_set(app: AppHandle, sites: Vec<ShopSite>) -> Result<Vec<ShopSite>, String> {
    let mut clean: Vec<ShopSite> = Vec::new();
    for s in sites.into_iter().take(30) {
        let name: String = s.name.trim().chars().take(40).collect();
        let search: String = s.search.trim().chars().take(400).collect();
        if name.is_empty() || !search.contains("{q}") || shop_site_host(&search).is_none() {
            continue;
        }
        if clean.iter().any(|c| c.search == search) {
            continue;
        }
        clean.push(ShopSite { name, search, on: s.on });
    }
    state(&app).settings.shop_sites = clean.clone();
    save_settings(&app);
    Ok(clean)
}

/// Remet la liste des boutiques proposées par défaut (toutes désactivées).
#[tauri::command]
async fn shop_sites_reset(app: AppHandle) -> Vec<ShopSite> {
    let list = default_shop_sites();
    state(&app).settings.shop_sites = list.clone();
    save_settings(&app);
    list
}

/// Comparateur : « Demander conseil à l'IA » envoie les données trouvées au panneau IA.
#[tauri::command]
async fn shop_ask_ai(app: AppHandle, webview: Webview, prompt: String, req: String, slot: Option<u8>) -> Result<(), String> {
    // réponse affichée dans le panneau, par la page d'IA cachée (sans ouvrir le panneau IA) ;
    // « slot » : session d'IA à utiliser (plusieurs questions en parallèle)
    let win = caller_win(&webview);
    let slot = slot.unwrap_or(0).min(4);
    let tab = state(&app).windows.get(&win).and_then(|w| w.active).unwrap_or(0);
    let req: String = req.chars().filter(|c| c.is_ascii_alphanumeric()).take(30).collect();
    let key = quick_key(&win, slot);
    // la réponse doit aller à cette vue même si la page d'IA répond très vite
    quick_ask_slot(&app, &win, slot, tab, req, prompt.chars().take(12000).collect(), Some("__corrtexShopAI"))?;
    if let Some(q) = state(&app).quick.get_mut(&key) {
        q.view = Some(webview.label().to_string());
    }
    Ok(())
}

/// Prépare des sessions d'IA cachées (discussion vierge chargée) avant d'en avoir besoin.
#[tauri::command]
async fn shop_ai_warm(app: AppHandle, webview: Webview, slots: Vec<u8>) {
    let win = caller_win(&webview);
    for s in slots.into_iter().take(4) {
        let _ = quick_warm(&app, &win, s.clamp(1, 4));
    }
}

/// Ferme le panneau ouvert par-dessus la page (extensions ou outils).
#[tauri::command]
async fn close_panel(app: AppHandle, webview: Webview) {
    let win = caller_win(&webview);
    close_panel_window(&app, &win);
    let view = state(&app).windows.get_mut(&win).map(|w| std::mem::take(&mut w.panel_view)).unwrap_or_default();
    let _ = app.emit_to(format!("chrome-{win}").as_str(), "ext-panel", serde_json::json!({ "win": win, "open": false, "view": view }));
}

/// Suggestions de recherche Google pour le texte tapé dans la barre d'adresse.
#[tauri::command]
async fn suggest(query: String) -> Vec<String> {
    let q: String = query.chars().take(200).collect();
    if q.trim().is_empty() {
        return Vec::new();
    }
    tauri::async_runtime::spawn_blocking(move || {
        let enc: String = q
            .bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
                _ => format!("%{b:02X}"),
            })
            .collect();
        let url = format!("https://suggestqueries.google.com/complete/search?client=firefox&hl=fr&ie=utf-8&oe=utf-8&q={enc}");
        let mut cmd = std::process::Command::new(if cfg!(windows) { "curl.exe" } else { "curl" });
        cmd.args(["-s", "-f", "--max-time", "3", &url]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let out = cmd.output().ok()?;
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
        Some(v.get(1)?.as_array()?.iter().filter_map(|x| x.as_str().map(String::from)).take(8).collect::<Vec<_>>())
    })
    .await
    .ok()
    .flatten()
    .unwrap_or_default()
}

/// Affiche / met à jour la liste de suggestions sous la barre d'adresse.
/// `data` = { x, width, items: [...], selected } (coordonnées de la barre d'adresse).
#[tauri::command]
async fn suggest_update(app: AppHandle, webview: Webview, mut data: serde_json::Value) -> Result<(), String> {
    let win = caller_win(&webview);
    data["win"] = serde_json::Value::String(win.clone());
    let count = data.get("items").and_then(|i| i.as_array()).map(|a| a.len()).unwrap_or(0);
    if count == 0 {
        close_suggest(&app, &win);
        return Ok(());
    }
    if let Some(w) = state(&app).windows.get_mut(&win) {
        w.suggest = Some(data.clone());
    }
    // La liste est une petite fenêtre transparente, rattachée à la fenêtre du navigateur et
    // placée sous la barre d'adresse : coins arrondis et ombre réels, par-dessus la page.
    let main = app.get_window(&win).ok_or("fenêtre introuvable")?;
    let scale = main.scale_factor().unwrap_or(1.0);
    let origin = main.inner_position().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
    let x = data.get("x").and_then(|v| v.as_f64()).unwrap_or(120.0);
    let width = data.get("width").and_then(|v| v.as_f64()).unwrap_or(600.0);
    let (m, top) = (SUGGEST_MARGIN, 4.0); // marge pour l'ombre, petit écart sous la barre
    let pos = LogicalPosition::new(origin.x + x - m, origin.y + 80.0);
    let size = LogicalSize::new(width + 2.0 * m, count as f64 * 40.0 + 12.0 + top + m);
    let wlabel = format!("sugw-{win}");
    let vlabel = format!("suggest-{win}");

    match (app.get_window(&wlabel), app.get_webview(&vlabel)) {
        (Some(w), Some(wv)) => {
            let _ = w.set_position(pos);
            let _ = w.set_size(size);
            set_bounds(&wv, LogicalPosition::new(0.0, 0.0), size);
            let _ = app.emit_to(vlabel.as_str(), "suggestions", data);
        }
        _ => {
            close_suggest(&app, &win);
            let popup = WindowBuilder::new(&app, &wlabel)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .resizable(false)
                .skip_taskbar(true)
                .focusable(false)
                .focused(false)
                .parent(&main)
                .map_err(|e| e.to_string())?
                .position(pos.x, pos.y)
                .inner_size(size.width, size.height)
                .build()
                .map_err(|e| e.to_string())?;
            popup
                .add_child(
                    web(vlabel, WebviewUrl::App("suggest.html".into())).transparent(true).background_color(Color(0, 0, 0, 0)).focused(false),
                    LogicalPosition::new(0.0, 0.0),
                    size,
                )
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

const SUGGEST_MARGIN: f64 = 14.0;

fn close_suggest(app: &AppHandle, win: &str) {
    if let Some(w) = app.get_window(&format!("sugw-{win}")) {
        let _ = w.close();
    }
}

#[tauri::command]
async fn suggest_get(app: AppHandle, webview: Webview) -> Option<serde_json::Value> {
    state(&app).windows.get(&caller_win(&webview)).and_then(|w| w.suggest.clone())
}

#[tauri::command]
async fn suggest_close(app: AppHandle, webview: Webview) {
    let win = caller_win(&webview);
    if let Some(w) = state(&app).windows.get_mut(&win) {
        w.suggest = None;
    }
    close_suggest(&app, &win);
}

// ---------------------------------------------------------------- panneau IA// ---------------------------------------------------------------- panneau IA
fn ensure_ai(app: &AppHandle, win: &str) -> Result<(), String> {
    if state(app).windows.get(win).map(|w| w.ai_created).unwrap_or(true) {
        return Ok(());
    }
    let window = app.get_window(win).ok_or("fenêtre introuvable")?;
    let url = provider(&state(app).settings.ai_provider).url;

    let (w, h) = window_logical_size(app, win);
    let x = (w - side_w()).max(0.0);

    window
        .add_child(
            web(format!("aibar-{win}"), WebviewUrl::App("aibar.html".into())),
            LogicalPosition::new(x, CHROME_H),
            LogicalSize::new(side_w(), AIBAR_H),
        )
        .map_err(|e| e.to_string())?;

    let app_popup = app.clone();
    let win_popup = win.to_string();
    window
        .add_child(
            web(format!("ai-{win}"), WebviewUrl::External(url.parse().unwrap()))
                .user_agent(MOBILE_UA)
                .initialization_script(AI_SCRIPT)
                .on_page_load(|wv, payload| {
                    if matches!(payload.event(), PageLoadEvent::Finished) {
                        apply_ai_skin_to(&wv);
                        // message demandé pendant que le panneau s'ouvrait : envoyé maintenant
                        let win = wv.label().trim_start_matches("ai-").to_string();
                        let pending = state(wv.app_handle()).pending_ai.remove(&win);
                        if let Some(prompt) = pending {
                            let wv2 = wv.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(Duration::from_millis(1500));
                                ask_ai_now(&wv2, &prompt);
                            });
                        }
                    }
                })
                
                .on_new_window(move |url, features| {
                    if features.size().is_some() {
                        return NewWindowResponse::Allow;
                    }
                    // Les liens cliqués dans l'IA s'ouvrent dans un onglet de la fenêtre.
                    let app = app_popup.clone();
                    let win = win_popup.clone();
                    let u = url.to_string();
                    tauri::async_runtime::spawn(async move {
                        let _ = create_tab(&app, &win, Some(u));
                    });
                    NewWindowResponse::Deny
                }),
            LogicalPosition::new(x, CHROME_H + AIBAR_H),
            LogicalSize::new(side_w(), (h - CHROME_H - AIBAR_H).max(50.0)),
        )
        .map_err(|e| e.to_string())?;

    // poignée de redimensionnement, créée en dernier pour passer au-dessus du bord de la page
    window
        .add_child(
            overlay_builder(format!("aires-{win}"), "resizer.html"),
            LogicalPosition::new((x - GUTTER).max(0.0), CHROME_H),
            LogicalSize::new(GUTTER, (h - CHROME_H).max(50.0)),
        )
        .map_err(|e| e.to_string())?;

    if let Some(w) = state(app).windows.get_mut(win) {
        w.ai_created = true;
    }
    Ok(())
}

/// Nouvelle largeur du panneau IA (poignée glissée à la souris).
#[tauri::command]
async fn set_sidebar_width(app: AppHandle, webview: Webview, width: f64, save: bool) {
    let win = caller_win(&webview);
    let (ww, _) = window_logical_size(&app, &win);
    let max = (ww - 360.0).max(SIDE_MIN).min(1000.0);
    let w = width.clamp(SIDE_MIN, max).round();
    SIDE_W.store(w as u32, std::sync::atomic::Ordering::Relaxed);
    state(&app).settings.sidebar_w = w;
    let wins: Vec<String> = state(&app).windows.keys().cloned().collect();
    for wl in wins {
        layout(&app, &wl);
    }
    if save {
        save_settings(&app);
        broadcast(&app);
    }
}

/// Bouton « Rechercher sur cette page » : envoie à l'IA un message qui cadre la discussion
/// sur la page web ouverte dans l'onglet actif.
#[tauri::command]
async fn ai_ask_page(app: AppHandle, webview: Webview) -> Result<(), String> {
    let win = caller_win(&webview);
    let (url, title) = {
        let b = state(&app);
        let id = b.windows.get(&win).and_then(|w| w.active).ok_or("aucun onglet")?;
        let t = b.tabs.get(&id).ok_or("aucun onglet")?;
        (t.url.clone(), t.title.clone())
    };
    if url.is_empty() {
        return Err("pas de page web ouverte".into());
    }
    let prompt = format!(
        "Pour toute cette discussion, base-toi sur cette page web : « {} » ({}). Consulte son contenu pour répondre à mes prochaines questions. Pour l'instant, réponds uniquement : « Que souhaitez-vous rechercher ? »",
        title.replace('\n', " "),
        url
    );
    ai_send(&app, &win, prompt)
}

/// Écrit le message dans la page de l'IA et l'envoie.
fn ask_ai_now(ai: &Webview, prompt: &str) {
    // la page de l'IA reçoit le focus (nécessaire à certains éditeurs), puis le message
    let _ = ai.set_focus();
    apply_ai_skin_to(ai);
    let js = format!("window.__corrtexAsk && window.__corrtexAsk({})", serde_json::to_string(prompt).unwrap_or_default());
    let _ = ai.eval(&js);
}

/// Envoie un message à l'IA de la fenêtre ; ouvre le panneau s'il est fermé
/// (le message part alors dès que la page de l'IA a fini de charger).
/// Demandes en attente pour le panneau IA en interface Corrtex (le panneau les récupère à son chargement).
fn native_pending() -> &'static Mutex<HashMap<String, String>> {
    static M: std::sync::OnceLock<Mutex<HashMap<String, String>>> = std::sync::OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

fn ai_send(app: &AppHandle, win: &str, prompt: String) -> Result<(), String> {
    // interface Corrtex : la demande s'affiche dans le panneau, l'IA répond en coulisse
    if state(app).settings.ai_native {
        let was_open = {
            let mut b = state(app);
            let Some(w) = b.windows.get_mut(win) else { return Err("fenêtre introuvable".into()) };
            let r = w.sidebar_open;
            w.sidebar_open = true;
            b.settings.sidebar_open = true;
            r
        };
        native_pending().lock().unwrap_or_else(|e| e.into_inner()).insert(win.to_string(), prompt);
        ensure_ai(app, win)?;
        if !was_open {
            layout(app, win);
            save_settings(app);
            broadcast(app);
        }
        let _ = app.emit_to(format!("aibar-{win}").as_str(), "native-ask", serde_json::json!({}));
        return Ok(());
    }
    let (was_open, created) = {
        let mut b = state(app);
        let Some(w) = b.windows.get_mut(win) else { return Err("fenêtre introuvable".into()) };
        let r = (w.sidebar_open, w.ai_created);
        w.sidebar_open = true;
        b.settings.sidebar_open = true;
        r
    };
    if !created {
        state(app).pending_ai.insert(win.to_string(), prompt.clone());
        ensure_ai(app, win)?;
    }
    if !was_open {
        layout(app, win);
        save_settings(app);
        broadcast(app);
    }
    if created {
        let ai = app.get_webview(&format!("ai-{win}")).ok_or("panneau IA indisponible")?;
        if memory_sync_before_send(app, win, &ai) {
            // la conversation du site se charge : le message partira à la fin du chargement
            state(app).pending_ai.insert(win.to_string(), prompt);
        } else {
            ask_ai_now(&ai, &prompt);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- lecture du texte des onglets
/// Script lancé dans un onglet : récupère le texte principal de la page et le renvoie.
fn extract_js(req: u64, limit: usize) -> String {
    format!(
        r#"(function () {{
  try {{
    var root = document.querySelector('article') || document.querySelector('main, [role=main]') || document.body;
    var text = (root && root.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{{3,}}/g, '\n\n').trim();
    if (text.length < 500 && root !== document.body) text = (document.body.innerText || '').replace(/\n{{3,}}/g, '\n\n').trim();
    window.__TAURI_INTERNALS__.invoke('tab_event', {{ kind: 'page_text', data: {{ req: {req}, text: text.slice(0, {limit}), title: document.title, url: location.href }} }});
  }} catch (e) {{}}
}})();"#
    )
}

/// Demande le texte de plusieurs onglets ; le message part quand tout est revenu (ou après 4 s).
fn read_tabs(app: &AppHandle, win: &str, kind: &'static str, tabs: Vec<u32>, limit: usize) -> Result<(), String> {
    if tabs.is_empty() {
        return Err("aucun onglet".into());
    }
    let req = {
        let mut b = state(app);
        b.next_req += 1;
        let req = b.next_req;
        // les onglets sans page web (accueil) sont comptés tout de suite, sans texte
        let mut got = Vec::new();
        for id in &tabs {
            if let Some(t) = b.tabs.get(id) {
                if t.url.is_empty() || t.asleep {
                    got.push((*id, t.title.clone(), t.url.clone(), String::new()));
                }
            }
        }
        b.text_reqs.insert(req, TextReq { win: win.to_string(), kind, tabs: tabs.clone(), got });
        req
    };
    let js = extract_js(req, limit);
    for id in &tabs {
        let internal = state(app).tabs.get(id).map(|t| t.url.is_empty() || t.asleep).unwrap_or(true);
        if internal {
            continue;
        }
        if let Some(wv) = app.get_webview(&tab_label(*id)) {
            let _ = wv.eval(&js);
        }
    }
    try_finish_read(app, req, false);
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(4));
        try_finish_read(&app2, req, true);
    });
    Ok(())
}

fn try_finish_read(app: &AppHandle, req: u64, force: bool) {
    let done = {
        let mut b = state(app);
        let ready = b.text_reqs.get(&req).map(|r| force || r.got.len() >= r.tabs.len()).unwrap_or(false);
        if ready { b.text_reqs.remove(&req) } else { None }
    };
    let Some(mut r) = done else { return };
    // dans l'ordre des onglets choisis ; titre et adresse connus si la page n'a pas répondu
    let mut pages = Vec::new();
    for id in &r.tabs {
        if let Some(p) = r.got.iter().position(|g| g.0 == *id) {
            pages.push(r.got.remove(p));
        } else if let Some(t) = state(app).tabs.get(id) {
            pages.push((*id, t.title.clone(), t.url.clone(), String::new()));
        }
    }
    let block = |title: &str, url: &str, text: &str| -> String {
        let head = format!("« {} » ({})", title.replace('\n', " "), url);
        if text.is_empty() {
            format!("{head}\n(contenu non lisible : consulte la page directement)")
        } else {
            format!("{head}\n\"\"\"\n{text}\n\"\"\"")
        }
    };
    let prompt = if r.kind == "compare" {
        let mut p = format!(
            "Compare ces {} pages web. Réponds en français avec un tableau comparatif (points communs, différences, avantages et inconvénients de chacune), puis une recommandation courte.\n",
            pages.len()
        );
        for (i, pg) in pages.iter().enumerate() {
            p.push_str(&format!("\nPage {} : {}\n", i + 1, block(&pg.1, &pg.2, &pg.3)));
        }
        p
    } else {
        let pg = pages.first().cloned().unwrap_or_default();
        format!(
            "Résume cette page web en français : une phrase d'introduction, puis les points clés en liste (idées principales, chiffres et faits importants), et une courte conclusion.\n\nPage : {}",
            block(&pg.1, &pg.2, &pg.3)
        )
    };
    let _ = ai_send(app, &r.win, prompt);
}

/// Résumé de l'onglet actif (bouton de l'en-tête du panneau IA).
/// « Comparer les articles de la page » : la page repère ses articles et demande à l'IA cachée
#[tauri::command]
async fn ai_page_compare(app: AppHandle, webview: Webview, needs: String) -> Result<(), String> {
    let win = caller_win(&webview);
    let id = state(&app).windows.get(&win).and_then(|w| w.active).ok_or("aucun onglet")?;
    let url = state(&app).tabs.get(&id).map(|t| t.url.clone()).unwrap_or_default();
    if !url.starts_with("http") {
        return Err("pas de page web ouverte".into());
    }
    let wv = app.get_webview(&tab_label(id)).ok_or("onglet introuvable")?;
    let needs: String = needs.chars().take(400).collect();
    let arg = serde_json::to_string(&needs).unwrap_or_else(|_| "\"\"".into());
    wv.eval(&format!("window.__corrtexPageCompare && window.__corrtexPageCompare({arg})")).map_err(|e| e.to_string())
}

#[tauri::command]
async fn ai_summarize(app: AppHandle, webview: Webview) -> Result<(), String> {
    let win = caller_win(&webview);
    let id = state(&app).windows.get(&win).and_then(|w| w.active).ok_or("aucun onglet")?;
    let (url, title) = state(&app).tabs.get(&id).map(|t| (t.url.clone(), t.title.clone())).unwrap_or_default();
    if url.is_empty() {
        return Err("pas de page web ouverte".into());
    }
    // vidéo YouTube : la page récupère la transcription puis l'envoie (« yt_transcript »)
    if is_youtube_video(&url) {
        if let Some(wv) = app.get_webview(&tab_label(id)) {
            let _ = wv.eval("window.__corrtexYtSummary ? window.__corrtexYtSummary() : window.__TAURI_INTERNALS__.invoke('tab_event', { kind: 'yt_transcript', data: { text: '' } })");
        }
        return Ok(());
    }
    // PDF : le lecteur du moteur ne donne pas accès au texte ; on donne l'adresse à l'IA
    if tauri::Url::parse(&url).map(|u| u.path().to_lowercase().ends_with(".pdf")).unwrap_or(false) {
        return ai_send(&app, &win, format!(
            "Lis ce document PDF : {url}\n\nRésume-le en français : une phrase d'introduction, les points clés en liste, puis une courte conclusion. Ensuite, je te poserai des questions sur ce document."
        ));
    }
    let _ = title;
    read_tabs(&app, &win, "summary", vec![id], 15000)
}

fn is_youtube_video(url: &str) -> bool {
    tauri::Url::parse(url)
        .map(|u| matches!(u.host_str(), Some("www.youtube.com" | "youtube.com" | "m.youtube.com")) && (u.path() == "/watch" || u.path().starts_with("/shorts/")))
        .unwrap_or(false)
}

/// Comparaison de 2 ou 3 onglets de la fenêtre.
#[tauri::command]
async fn ai_compare(app: AppHandle, webview: Webview, ids: Vec<u32>) -> Result<(), String> {
    let win = caller_win(&webview);
    let ids: Vec<u32> = {
        let b = state(&app);
        let mine = b.windows.get(&win).map(|w| w.tabs.clone()).unwrap_or_default();
        ids.into_iter().filter(|i| mine.contains(i)).take(4).collect()
    };
    if ids.len() < 2 {
        return Err("choisissez au moins deux onglets".into());
    }
    let limit = if ids.len() > 2 { 6000 } else { 8000 };
    read_tabs(&app, &win, "compare", ids, limit)
}

/// Demande en attente pour le panneau IA (interface Corrtex).
#[tauri::command]
async fn ai_native_take(webview: Webview) -> Option<String> {
    let win = caller_win(&webview);
    native_pending().lock().unwrap_or_else(|e| e.into_inner()).remove(&win)
}

/// Panneau IA : interface Corrtex (true) ou site de l'IA (false, par ex. pour se connecter).
#[tauri::command]
async fn set_ai_native(app: AppHandle, on: bool) {
    state(&app).settings.ai_native = on;
    save_settings(&app);
    let wins: Vec<String> = state(&app).windows.keys().cloned().collect();
    for w in wins {
        layout(&app, &w);
        let _ = app.emit_to(format!("aibar-{w}").as_str(), "ai-view", serde_json::json!({ "native": on }));
    }
}

/// Hauteur de l'en-tête du panneau IA (liste des onglets à comparer dépliée ou non).
#[tauri::command]
async fn set_aibar_extra(app: AppHandle, webview: Webview, extra: f64) {
    let win = caller_win(&webview);
    if let Some(w) = state(&app).windows.get_mut(&win) {
        w.aibar_extra = extra.clamp(0.0, 360.0).round();
    }
    layout(&app, &win);
}

/// Mémoire des conversations par site : activée ou non (réglages de la page d'accueil).
#[tauri::command]
async fn set_ai_memory(app: AppHandle, on: bool) {
    {
        let mut b = state(&app);
        b.settings.ai_memory = on;
        if !on {
            b.settings.ai_chats.clear();
        }
    }
    save_settings(&app);
    broadcast(&app);
}

/// Texte sélectionné dans une page → question à l'IA (menu du clic droit).
fn ai_selection_prompt(action: &str, text: &str, title: &str) -> Option<String> {
    let quote = format!("\"\"\"\n{text}\n\"\"\"");
    let from = if title.trim().is_empty() { String::new() } else { format!(" (tiré de la page « {} »)", title.replace('\n', " ")) };
    Some(match action {
        "explain" => format!("Explique-moi clairement ce passage{from}, avec des mots simples et un exemple si c'est utile :\n\n{quote}"),
        "translate" => format!("Traduis ce texte en français (ou en anglais s'il est déjà en français), en gardant le ton d'origine. Donne seulement la traduction :\n\n{quote}"),
        "summarize" => format!("Résume ce passage{from} en quelques points clés :\n\n{quote}"),
        "rephrase" => format!("Reformule ce texte de façon plus claire et naturelle, en proposant deux versions :\n\n{quote}"),
        "rw_fix" | "rw_short" | "rw_formal" | "rw_friendly" | "rw_long" => {
            let what = match action {
                "rw_fix" => "Corrige l'orthographe, la grammaire et la ponctuation de ce texte sans changer son sens ni son ton",
                "rw_short" => "Raccourcis ce texte en gardant l'essentiel et le même ton",
                "rw_formal" => "Réécris ce texte sur un ton plus formel et professionnel",
                "rw_friendly" => "Réécris ce texte sur un ton plus chaleureux et amical",
                _ => "Développe un peu ce texte pour le rendre plus complet, sans inventer de faits",
            };
            format!("{what}. Garde la même langue que le texte. Réponds UNIQUEMENT par le texte réécrit, sans guillemets, sans titre ni commentaire :\n\n{quote}")
        }
        _ => return None,
    })
}


// ---------------------------------------------------------------- petites fenêtres flottantes
// Menu d'un onglet ou d'un groupe, et aperçu au survol : de petites fenêtres transparentes
// rattachées à la fenêtre du navigateur (comme la liste de suggestions), par-dessus la page.
const POP_MARGIN: f64 = 14.0;

/// Crée (cachée) la petite fenêtre d'un type, si elle n'existe pas encore. Elle est préparée
/// à l'avance puis seulement montrée / cachée : l'ouverture d'un menu est instantanée.
fn ensure_popup(app: &AppHandle, win: &str, prefix: &str) -> Result<(), String> {
    let wlabel = format!("{prefix}-{win}");
    if app.get_window(&wlabel).is_some() {
        return Ok(());
    }
    let focus = prefix == "popw";
    let main = app.get_window(win).ok_or("fenêtre introuvable")?;
    let vlabel = format!("{}-{win}", if prefix == "prvw" { "preview" } else { "popup" });
    let size = LogicalSize::new(300.0, 200.0);
    let popup = WindowBuilder::new(app, &wlabel)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .visible(false)
        .focusable(focus)
        .focused(false)
        .parent(&main)
        .map_err(|e| e.to_string())?
        .inner_size(size.width, size.height)
        .build()
        .map_err(|e| e.to_string())?;
    popup
        .add_child(
            web(vlabel, WebviewUrl::App("popup.html".into())).transparent(true).background_color(Color(0, 0, 0, 0)).focused(false),
            LogicalPosition::new(0.0, 0.0),
            size,
        )
        .map_err(|e| e.to_string())?;
    // macOS : une fenêtre rattachée à la fenêtre principale s'affiche dès sa création,
    // même construite invisible ; elle doit rester cachée jusqu'à l'ouverture du menu
    let _ = popup.hide();
    // Le menu se cache quand sa page perd le focus (voir popup.html) ou quand on clique dans
    // la fenêtre du navigateur. Pas sur la perte de focus de la fenêtre elle-même : sous
    // Windows, elle arrive aussi quand le focus passe dans sa propre page, et le menu
    // se refermait tout seul.
    let _ = focus;
    Ok(())
}

/// Panneau (Extensions, Outils) : fenêtre transparente au-dessus de la page.
fn open_panel_window(app: &AppHandle, win: &str, page: &str, pos: LogicalPosition<f64>, size: LogicalSize<f64>) -> Result<(), String> {
    close_panel_window(app, win);
    let main = app.get_window(win).ok_or("fenêtre introuvable")?;
    let scale = main.scale_factor().unwrap_or(1.0);
    let origin = main.inner_position().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
    let phys = main.inner_position().map_err(|e| e.to_string())?;
    let w = WindowBuilder::new(app, format!("panw-{win}"))
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .parent(&main)
        .map_err(|e| e.to_string())?
        .inner_size(size.width, size.height)
        .position(origin.x + pos.x, origin.y + pos.y)
        .focused(true)
        .build()
        .map_err(|e| e.to_string())?;
    // même écran que la fenêtre principale (pixels réels : deux écrans peuvent avoir des échelles différentes)
    let _ = w.set_position(tauri::PhysicalPosition::new(phys.x + (pos.x * scale).round() as i32, phys.y + (pos.y * scale).round() as i32));
    let _ = w.set_size(tauri::PhysicalSize::new((size.width * scale).round() as u32, (size.height * scale).round() as u32));
    w.add_child(
        web(format!("panel-{win}"), WebviewUrl::App(page.into())).transparent(true).background_color(Color(0, 0, 0, 0)),
        LogicalPosition::new(0.0, 0.0),
        size,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn close_panel_window(app: &AppHandle, win: &str) {
    if let Some(w) = app.get_window(&format!("panw-{win}")) {
        let _ = w.close();
    } else if let Some(p) = app.get_webview(&format!("panel-{win}")) {
        let _ = p.close();
    }
}

/// Le panneau se ferme (clic dans la fenêtre du navigateur, déplacement de la fenêtre).
fn dismiss_panel(app: &AppHandle, win: &str) {
    let view = {
        let b = state(app);
        b.windows.get(win).map(|w| w.panel_view.clone()).unwrap_or_default()
    };
    // le comparateur est dans la page : rien à fermer ici ; la recherche d'achat reste ouverte
    // pendant qu'on consulte les articles (elle se ferme par sa croix)
    if view.is_empty() || view == "shopping" || app.get_window(&format!("panw-{win}")).is_none() {
        return;
    }
    if let Some(w) = state(app).windows.get_mut(win) {
        w.panel_view.clear();
    }
    state(app).panel_dismissed.insert(win.to_string(), (view.clone(), Instant::now()));
    close_panel_window(app, win);
    let _ = app.emit_to(format!("chrome-{win}").as_str(), "ext-panel", serde_json::json!({ "win": win, "open": false, "view": view }));
}

/// Prépare les petites fenêtres d'une fenêtre du navigateur (appelé peu après son ouverture).
fn prewarm_popups(app: &AppHandle, win: &str) {
    let _ = ensure_popup(app, win, "popw");
    let _ = ensure_popup(app, win, "prvw");
}

fn open_popup(app: &AppHandle, win: &str, prefix: &str, mut data: serde_json::Value, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    data["win"] = serde_json::Value::String(win.to_string());
    {
        let mut b = state(app);
        let Some(wn) = b.windows.get_mut(win) else { return Err("fenêtre introuvable".into()) };
        if prefix == "prvw" { wn.preview = Some(data.clone()); } else { wn.popup = Some(data.clone()); }
    }
    ensure_popup(app, win, prefix)?;
    let main = app.get_window(win).ok_or("fenêtre introuvable")?;
    let scale = main.scale_factor().unwrap_or(1.0);
    let origin = main.inner_position().map_err(|e| e.to_string())?;
    let (ww, _) = window_logical_size(app, win);
    let x = x.min(ww - w - 8.0).max(4.0);
    let size = LogicalSize::new(w + 2.0 * POP_MARGIN, h + POP_MARGIN + 6.0);
    // en pixels réels de l'écran de la fenêtre principale : avec deux écrans d'échelles différentes,
    // une position « logique » serait convertie avec l'échelle de l'écran où la petite fenêtre
    // se trouvait avant, d'où un aperçu à un endroit inattendu
    let pos = tauri::PhysicalPosition::new(origin.x + ((x - POP_MARGIN) * scale).round() as i32, origin.y + (y * scale).round() as i32);
    let psize = tauri::PhysicalSize::new((size.width * scale).round() as u32, (size.height * scale).round() as u32);
    let wlabel = format!("{prefix}-{win}");
    let vlabel = format!("{}-{win}", if prefix == "prvw" { "preview" } else { "popup" });
    popup_targets().lock().unwrap_or_else(|e| e.into_inner()).insert(wlabel.clone(), pos);
    if let Some(pw) = app.get_window(&wlabel) {
        let _ = pw.set_position(pos);
        let _ = pw.set_size(psize);
        // Windows peut déplacer la fenêtre en changeant sa taille (changement d'échelle d'écran) : on la remet en place
        let _ = pw.set_position(pos);
    }
    if let Some(wv) = app.get_webview(&vlabel) {
        set_bounds(&wv, LogicalPosition::new(0.0, 0.0), size);
    }
    // la page dessine le contenu, ajuste la taille, puis demande à être montrée (popup_fit)
    let _ = app.emit_to(vlabel.as_str(), "popup-data", data);
    Ok(())
}

/// Position voulue de chaque petite fenêtre (menus, aperçu d'onglet), en pixels réels.
fn popup_targets() -> &'static Mutex<HashMap<String, tauri::PhysicalPosition<i32>>> {
    static M: std::sync::OnceLock<Mutex<HashMap<String, tauri::PhysicalPosition<i32>>>> = std::sync::OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

fn close_popups(app: &AppHandle, win: &str) {
    for p in ["popw", "prvw"] {
        if let Some(w) = app.get_window(&format!("{p}-{win}")) {
            let _ = w.hide();
        }
    }
}

/// Contenu à afficher par la petite fenêtre qui le demande.
#[tauri::command]
async fn popup_get(app: AppHandle, webview: Webview) -> Option<serde_json::Value> {
    let is_preview = webview.label().starts_with("preview-");
    let b = state(&app);
    let w = b.windows.get(&caller_win(&webview))?;
    if is_preview { w.preview.clone() } else { w.popup.clone() }
}

/// La petite fenêtre s'ajuste à la hauteur de son contenu (aucune zone vide sur la page).
#[tauri::command]
async fn popup_fit(app: AppHandle, webview: Webview, height: f64) {
    let win = caller_win(&webview);
    let prefix = if webview.label().starts_with("preview-") { "prvw" } else { "popw" };
    let main_scale = app.get_window(&win).and_then(|m| m.scale_factor().ok());
    if let (Some(w), Some(scale)) = (app.get_window(&format!("{prefix}-{win}")), main_scale.or_else(|| webview.window().scale_factor().ok())) {
        let target = popup_targets().lock().unwrap_or_else(|e| e.into_inner()).get(&format!("{prefix}-{win}")).copied();
        if let Ok(size) = w.inner_size() {
            let width = size.width as f64 / scale;
            let size = LogicalSize::new(width, height.clamp(40.0, 700.0) + POP_MARGIN + 6.0);
            let _ = w.set_size(tauri::PhysicalSize::new(size.width * scale, size.height * scale).cast::<u32>());
            set_bounds(&webview, LogicalPosition::new(0.0, 0.0), size);
        }
        // aperçu déjà fermé (la souris a quitté l'onglet) : on ne le montre pas
        if prefix == "prvw" && state(&app).windows.get(&win).map(|x| x.preview.is_none()).unwrap_or(true) {
            return;
        }
        // toujours à l'endroit voulu (sous l'onglet), même si le système l'a déplacée entre-temps
        if let Some(p) = target {
            let _ = w.set_position(p);
        }
        // contenu prêt : la fenêtre apparaît (un menu prend le focus pour se fermer au clic ailleurs)
        let _ = w.show();
        if let Some(p) = target {
            if w.outer_position().map(|o| o != p).unwrap_or(false) {
                let _ = w.set_position(p);
            }
        }
        if prefix == "popw" {
            let _ = w.set_focus();
            let _ = webview.set_focus();
        }
    }
}

#[tauri::command]
async fn popup_close(app: AppHandle, webview: Webview) {
    let win = caller_win(&webview);
    let prefix = if webview.label().starts_with("preview-") { "prvw" } else { "popw" };
    if let Some(w) = app.get_window(&format!("{prefix}-{win}")) {
        let _ = w.hide();
    }
}

/// Menu du clic droit sur un onglet (x : bord gauche de l'onglet dans la fenêtre).
#[tauri::command]
async fn tab_menu(app: AppHandle, webview: Webview, id: u32, x: f64) -> Result<(), String> {
    let win = caller_win(&webview);
    close_popups(&app, &win);
    let data = {
        let b = state(&app);
        let t = b.tabs.get(&id).ok_or("onglet introuvable")?;
        let w = b.windows.get(&win).ok_or("fenêtre introuvable")?;
        serde_json::json!({
            "kind": "tab",
            "tab": { "id": t.id, "title": t.title, "url": t.url, "pinned": t.pinned, "group": t.group, "asleep": t.asleep,
                     "active": w.active == Some(id) },
            "groups": w.groups,
            "count": w.tabs.len(),
            "closed": !b.closed.is_empty(),
            "spaces": if w.spaces.is_empty() { default_spaces() } else { w.spaces.clone() },
            "space": t.space,
            "split": w.split,
        })
    };
    open_popup(&app, &win, "popw", data, x, 40.0, 260.0, 430.0)
}

/// Menu d'un favori (clic droit dans la barre de favoris).
#[tauri::command]
async fn bookmark_menu(app: AppHandle, webview: Webview, url: String, x: f64, y: f64) -> Result<(), String> {
    let win = caller_win(&webview);
    close_popups(&app, &win);
    open_popup(&app, &win, "popw", serde_json::json!({ "kind": "bookmark", "url": url }), x, y, 280.0, 330.0)
}

/// Menu d'un groupe (clic droit sur sa pastille).
#[tauri::command]
async fn group_menu(app: AppHandle, webview: Webview, gid: u32, x: f64) -> Result<(), String> {
    let win = caller_win(&webview);
    close_popups(&app, &win);
    let data = {
        let b = state(&app);
        let w = b.windows.get(&win).ok_or("fenêtre introuvable")?;
        let g = w.groups.iter().find(|g| g.id == gid).ok_or("groupe introuvable")?;
        serde_json::json!({ "kind": "group", "group": g, "colors": GROUP_COLORS })
    };
    open_popup(&app, &win, "popw", data, x, 40.0, 260.0, 300.0)
}

/// Aperçu au survol d'un onglet.
#[tauri::command]
async fn tab_preview(app: AppHandle, webview: Webview, id: u32, x: f64) -> Result<(), String> {
    let win = caller_win(&webview);
    let data = {
        let b = state(&app);
        let t = b.tabs.get(&id).ok_or("onglet introuvable")?;
        let w = b.windows.get(&win).ok_or("fenêtre introuvable")?;
        let group = w.groups.iter().find(|g| g.id == t.group).cloned();
        let playing = b.media.as_ref().map(|m| m.tab == id && m.playing).unwrap_or(false);
        serde_json::json!({ "kind": "preview", "tab": { "id": t.id, "title": t.title, "url": t.url, "favicon": t.favicon,
            "pinned": t.pinned, "asleep": t.asleep, "playing": playing }, "group": group })
    };
    open_popup(&app, &win, "prvw", data, x, 40.0, 300.0, 120.0)
}

#[tauri::command]
async fn preview_close(app: AppHandle, webview: Webview) {
    let win = caller_win(&webview);
    if let Some(w) = state(&app).windows.get_mut(&win) {
        w.preview = None;
    }
    if let Some(w) = app.get_window(&format!("prvw-{win}")) {
        let _ = w.hide();
    }
}

// ---------------------------------------------------------------- actions sur les onglets et groupes
/// Met un onglet en veille : sa page est fermée (mémoire libérée), il se recharge au clic.
fn sleep_tab(app: &AppHandle, id: u32) -> bool {
    let ok = {
        let mut b = state(app);
        let active = b.tabs.get(&id).and_then(|t| b.windows.get(&t.win)).and_then(|w| w.active) == Some(id);
        let playing = b.media.as_ref().map(|m| m.tab == id).unwrap_or(false);
        match b.tabs.get_mut(&id) {
            Some(t) if !active && !playing && !t.asleep && !t.url.is_empty() => {
                t.asleep = true;
                t.loading = false;
                t.can_back = false;
                t.can_fwd = false;
                true
            }
            _ => false,
        }
    };
    if ok {
        if let Some(wv) = app.get_webview(&tab_label(id)) {
            let _ = wv.close();
        }
    }
    ok
}

#[tauri::command]
async fn tab_action(app: AppHandle, webview: Webview, id: u32, action: String, arg: Option<serde_json::Value>) -> Result<(), String> {
    let win = caller_win(&webview);
    close_popups(&app, &win);
    if state(&app).tabs.get(&id).map(|t| t.win != win).unwrap_or(true) {
        return Err("onglet introuvable".into());
    }
    match action.as_str() {
        "space" => {
            let sp = arg.as_ref().and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            move_tab_to_space(&app, id, sp);
            return Ok(());
        }
        "pin" | "unpin" => {
            let mut b = state(&app);
            if let Some(t) = b.tabs.get_mut(&id) {
                t.pinned = action == "pin";
                t.group = 0;
            }
            normalize_order(&mut b, &win);
        }
        "duplicate" => {
            let (url, index) = {
                let b = state(&app);
                let url = b.tabs.get(&id).map(|t| t.url.clone()).unwrap_or_default();
                let index = b.windows.get(&win).and_then(|w| w.tabs.iter().position(|t| *t == id)).map(|i| i + 1);
                (url, index)
            };
            let new_id = add_tab_record(&mut state(&app), &win, url, String::new(), String::new(), index, false);
            {
                let mut b = state(&app);
                let g = b.tabs.get(&id).filter(|t| !t.pinned).map(|t| t.group).unwrap_or(0);
                if let Some(t) = b.tabs.get_mut(&new_id) {
                    t.group = g;
                }
            }
            spawn_tab_view(&app, new_id)?;
            activate(&app, new_id);
        }
        "group_new" => {
            let mut b = state(&app);
            b.next_group += 1;
            let gid = b.next_group;
            let used: Vec<String> = b.windows.get(&win).map(|w| w.groups.iter().map(|g| g.color.clone()).collect()).unwrap_or_default();
            let color = GROUP_COLORS.iter().find(|c| !used.iter().any(|u| u == *c)).unwrap_or(&GROUP_COLORS[0]).to_string();
            let n = b.windows.get(&win).map(|w| w.groups.len()).unwrap_or(0) + 1;
            if let Some(w) = b.windows.get_mut(&win) {
                w.groups.push(Group { id: gid, name: format!("Groupe {n}"), color, collapsed: false });
            }
            if let Some(t) = b.tabs.get_mut(&id) {
                t.group = gid;
                t.pinned = false;
            }
            normalize_order(&mut b, &win);
        }
        "group_add" => {
            let gid = arg.as_ref().and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let mut b = state(&app);
            let exists = b.windows.get(&win).map(|w| w.groups.iter().any(|g| g.id == gid)).unwrap_or(false);
            if !exists {
                return Err("groupe introuvable".into());
            }
            // l'onglet rejoint le groupe, placé après son dernier onglet
            if let Some(t) = b.tabs.get_mut(&id) {
                t.group = gid;
                t.pinned = false;
            }
            let members: Vec<u32> = b.windows.get(&win).map(|w| w.tabs.iter().copied().filter(|t| *t != id && b.tabs.get(t).map(|x| x.group == gid).unwrap_or(false)).collect()).unwrap_or_default();
            if let (Some(last), Some(w)) = (members.last().copied(), b.windows.get_mut(&win)) {
                w.tabs.retain(|t| *t != id);
                let at = w.tabs.iter().position(|t| *t == last).map(|p| p + 1).unwrap_or(w.tabs.len());
                w.tabs.insert(at, id);
            }
            normalize_order(&mut b, &win);
        }
        "group_remove" => {
            let mut b = state(&app);
            if let Some(t) = b.tabs.get_mut(&id) {
                t.group = 0;
            }
            normalize_order(&mut b, &win);
        }
        "sleep" => {
            sleep_tab(&app, id);
        }
        "reload" => {
            if let Some(wv) = app.get_webview(&tab_label(id)) {
                let _ = wv.reload();
            }
        }
        "close_others" => {
            let others: Vec<u32> = {
                let b = state(&app);
                b.windows.get(&win).map(|w| w.tabs.iter().copied().filter(|t| *t != id && !b.tabs.get(t).map(|x| x.pinned).unwrap_or(false)).collect()).unwrap_or_default()
            };
            activate(&app, id);
            for t in others {
                close(&app, t);
            }
        }
        "close" => close(&app, id),
        _ => return Err("action inconnue".into()),
    }
    layout(&app, &win);
    broadcast(&app);
    Ok(())
}

#[tauri::command]
async fn group_action(app: AppHandle, webview: Webview, gid: u32, action: String, arg: Option<String>) -> Result<(), String> {
    let win = caller_win(&webview);
    if action != "rename" && action != "color" {
        close_popups(&app, &win);
    }
    match action.as_str() {
        "rename" => {
            let name: String = arg.unwrap_or_default().trim().chars().take(40).collect();
            let mut b = state(&app);
            if let Some(g) = b.windows.get_mut(&win).and_then(|w| w.groups.iter_mut().find(|g| g.id == gid)) {
                g.name = name;
            }
        }
        "color" => {
            let c = arg.unwrap_or_default();
            if !GROUP_COLORS.contains(&c.as_str()) {
                return Err("couleur inconnue".into());
            }
            let mut b = state(&app);
            if let Some(g) = b.windows.get_mut(&win).and_then(|w| w.groups.iter_mut().find(|g| g.id == gid)) {
                g.color = c;
            }
        }
        "toggle" => {
            // replier : si l'onglet affiché est dans le groupe, on affiche un onglet hors du groupe
            let switch_to = {
                let mut b = state(&app);
                let members: Vec<u32> = b.windows.get(&win).map(|w| w.tabs.iter().copied().filter(|t| b.tabs.get(t).map(|x| x.group == gid).unwrap_or(false)).collect()).unwrap_or_default();
                let w = b.windows.get(&win);
                let active = w.and_then(|w| w.active);
                let outside = w.and_then(|w| w.tabs.iter().copied().find(|t| !members.contains(t)));
                let collapsing = w.and_then(|w| w.groups.iter().find(|g| g.id == gid)).map(|g| !g.collapsed).unwrap_or(false);
                if collapsing && active.map(|a| members.contains(&a)).unwrap_or(false) && outside.is_none() {
                    None // aucun autre onglet : on ne replie pas
                } else {
                    if let Some(g) = b.windows.get_mut(&win).and_then(|w| w.groups.iter_mut().find(|g| g.id == gid)) {
                        g.collapsed = !g.collapsed;
                    }
                    if collapsing && active.map(|a| members.contains(&a)).unwrap_or(false) { outside } else { None }
                }
            };
            if let Some(t) = switch_to {
                activate(&app, t);
                // l'activation rouvre le groupe de l'onglet affiché, pas celui-ci
                let mut b = state(&app);
                if let Some(g) = b.windows.get_mut(&win).and_then(|w| w.groups.iter_mut().find(|g| g.id == gid)) {
                    g.collapsed = true;
                }
            }
        }
        "ungroup" => {
            let mut b = state(&app);
            for t in b.tabs.values_mut() {
                if t.win == win && t.group == gid {
                    t.group = 0;
                }
            }
            normalize_order(&mut b, &win);
        }
        "close" => {
            let members: Vec<u32> = {
                let b = state(&app);
                b.windows.get(&win).map(|w| w.tabs.iter().copied().filter(|t| b.tabs.get(t).map(|x| x.group == gid).unwrap_or(false)).collect()).unwrap_or_default()
            };
            for t in members {
                close(&app, t);
            }
        }
        _ => return Err("action inconnue".into()),
    }
    layout(&app, &win);
    broadcast(&app);
    Ok(())
}

/// Rouvre le dernier onglet fermé (Ctrl+Maj+T), à sa place si sa fenêtre existe encore.
fn reopen_closed_in(app: &AppHandle, win: &str) -> Result<(), String> {
    let (target, id) = {
        let mut b = state(app);
        let c = b.closed.pop().ok_or("aucun onglet fermé")?;
        let target = if b.windows.contains_key(&c.win) { c.win.clone() } else { win.to_string() };
        let id = add_tab_record(&mut b, &target, c.url, c.title, c.favicon, Some(c.index), false);
        let group_ok = c.group != 0 && b.windows.get(&target).map(|w| w.groups.iter().any(|g| g.id == c.group)).unwrap_or(false);
        if group_ok {
            if let Some(t) = b.tabs.get_mut(&id) {
                t.group = c.group;
            }
        }
        (target, id)
    };
    spawn_tab_view(app, id)?;
    activate(app, id);
    if let Some(w) = app.get_window(&target) {
        let _ = w.set_focus();
    }
    Ok(())
}

#[tauri::command]
async fn reopen_closed(app: AppHandle, webview: Webview) -> Result<(), String> {
    reopen_closed_in(&app, &caller_win(&webview))
}

/// Réglages des onglets (page d'accueil) : restauration de la session, mise en veille.
#[tauri::command]
async fn set_tab_prefs(app: AppHandle, restore: Option<bool>, sleep_min: Option<u32>) {
    {
        let mut b = state(&app);
        if let Some(r) = restore {
            b.settings.restore_session = r;
        }
        if let Some(m) = sleep_min {
            b.settings.sleep_min = m.min(24 * 60);
        }
    }
    save_settings(&app);
    broadcast(&app);
}

// ---------------------------------------------------------------- mise en veille automatique
fn sleep_tick(app: &AppHandle) {
    let (minutes, candidates) = {
        let b = state(app);
        // économie d'énergie : les onglets inactifs dorment au bout de 10 min au plus
        let m = if b.settings.sleep_min != 0 && power_saver(&b) { b.settings.sleep_min.min(10) } else { b.settings.sleep_min };
        let c: Vec<u32> = if m == 0 {
            Vec::new()
        } else {
            b.tabs
                .values()
                .filter(|t| !t.asleep && !t.pinned && !t.url.is_empty())
                .filter(|t| b.windows.get(&t.win).and_then(|w| w.active) != Some(t.id))
                .filter(|t| t.last_seen.map(|s| s.elapsed() > Duration::from_secs(m as u64 * 60)).unwrap_or(false))
                .map(|t| t.id)
                .collect()
        };
        (m, c)
    };
    if minutes == 0 || candidates.is_empty() {
        return;
    }
    let mut any = false;
    for id in candidates {
        any |= sleep_tab(app, id);
    }
    if any {
        broadcast(app);
    }
}

// ---------------------------------------------------------------- session
fn session_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    settings_path(app).and_then(|p| p.parent().map(|d| d.join("session.json")))
}

fn session_json(b: &Browser) -> serde_json::Value {
    let mut wins: Vec<(&String, &Win)> = b.windows.iter().filter(|(_, w)| !w.private).collect();
    wins.sort_by_key(|(l, _)| l.trim_start_matches('w').parse::<u32>().unwrap_or(0));
    let windows: Vec<serde_json::Value> = wins
        .into_iter()
        .map(|(_, w)| {
            let tabs: Vec<serde_json::Value> = w
                .tabs
                .iter()
                .filter_map(|id| b.tabs.get(id))
                .map(|t| serde_json::json!({ "url": t.url, "title": t.title, "favicon": t.favicon.chars().take(2048).collect::<String>(), "pinned": t.pinned, "group": t.group, "space": t.space }))
                .collect();
            let active = w.active.and_then(|a| w.tabs.iter().position(|t| *t == a)).unwrap_or(0);
            serde_json::json!({ "tabs": tabs, "active": active, "groups": w.groups, "spaces": w.spaces, "profile": w.profile })
        })
        .collect();
    serde_json::json!({ "windows": windows })
}

fn save_session(app: &AppHandle) {
    let json = {
        let mut b = state(app);
        b.session_dirty = false;
        // plus aucune fenêtre (fermeture de Corrtex) : on garde la session précédente
        if b.windows.is_empty() || b.windows.values().all(|w| w.tabs.is_empty()) {
            return;
        }
        session_json(&b)
    };
    if let Some(p) = session_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, json.to_string());
    }
}

/// Rouvre les fenêtres et onglets de la dernière fois. Les onglets non affichés restent en
/// veille (rien n'est chargé avant le clic) : le démarrage reste rapide.
fn restore_session(app: &AppHandle) -> bool {
    if !state(app).settings.restore_session {
        return false;
    }
    let Some(p) = session_path(app) else { return false };
    let Ok(text) = std::fs::read_to_string(p) else { return false };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { return false };
    let wins = json.get("windows").and_then(|w| w.as_array()).cloned().unwrap_or_default();
    let mut restored = false;
    for wj in wins {
        let tabs = wj.get("tabs").and_then(|t| t.as_array()).cloned().unwrap_or_default();
        let tabs: Vec<serde_json::Value> = tabs.into_iter().filter(|t| t.get("url").and_then(|u| u.as_str()).map(|u| u.starts_with("http")).unwrap_or(false)).collect();
        if tabs.is_empty() {
            continue;
        }
        let Ok(win) = create_window(app, None, None) else { continue };
        // profil de la fenêtre (s'il existe encore)
        let profile = wj.get("profile").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let known_profile = profile != 0 && state(app).settings.profiles.iter().any(|p| p.id == profile);
        if known_profile {
            let name = state(app).settings.profiles.iter().find(|p| p.id == profile).map(|p| p.name.clone()).unwrap_or_default();
            if let Some(w) = state(app).windows.get_mut(&win) {
                w.profile = profile;
            }
            if let Some(w) = app.get_window(&win) {
                let _ = w.set_title(&format!("Corrtex — {name}"));
            }
        }
        let active_idx = wj.get("active").and_then(|a| a.as_u64()).unwrap_or(0) as usize;
        let mut ids = Vec::new();
        {
            let mut b = state(app);
            // groupes : nouveaux numéros
            let mut map = HashMap::new();
            for g in wj.get("groups").and_then(|g| g.as_array()).cloned().unwrap_or_default() {
                let Ok(g) = serde_json::from_value::<Group>(g) else { continue };
                b.next_group += 1;
                let nid = b.next_group;
                map.insert(g.id, nid);
                if let Some(w) = b.windows.get_mut(&win) {
                    w.groups.push(Group { id: nid, ..g });
                }
            }
            // espaces de la fenêtre
            let spaces: Vec<Space> = wj.get("spaces").and_then(|v| serde_json::from_value(v.clone()).ok()).filter(|v: &Vec<Space>| v.iter().any(|s| s.id == 0)).unwrap_or_else(default_spaces);
            let known: std::collections::HashSet<u32> = spaces.iter().map(|s| s.id).collect();
            if let Some(w) = b.windows.get_mut(&win) {
                w.spaces = spaces;
            }
            for t in &tabs {
                let s = |k: &str| t.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
                let n = b.windows.get(&win).map(|w| w.tabs.len()).unwrap_or(0);
                let id = add_tab_record(&mut b, &win, s("url"), s("title"), s("favicon"), Some(n), true);
                if let Some(tab) = b.tabs.get_mut(&id) {
                    tab.pinned = t.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false);
                    let g = t.get("group").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                    tab.group = map.get(&g).copied().unwrap_or(0);
                    let sp = t.get("space").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                    tab.space = if known.contains(&sp) { sp } else { 0 };
                }
                ids.push(id);
            }
            normalize_order(&mut b, &win);
        }
        let first = ids.get(active_idx.min(ids.len() - 1)).copied();
        if let Some(id) = first {
            activate(app, id);
        }
        restored = true;
    }
    restored
}


// ---------------------------------------------------------------- historique
fn history_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    settings_path(app).and_then(|p| p.parent().map(|d| d.join("history.json")))
}

fn load_history(app: &AppHandle) {
    let list: Vec<HistEntry> = history_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    state(app).history = list;
}

fn save_history(app: &AppHandle) {
    let json = {
        let mut b = state(app);
        b.history_dirty = false;
        serde_json::to_string(&b.history).unwrap_or_else(|_| "[]".into())
    };
    if let Some(p) = history_path(app) {
        let _ = std::fs::write(p, json);
    }
}

/// Une page web a fini de charger : visite ajoutée à l'historique.
fn record_visit(app: &AppHandle, url: &str) {
    if !(url.starts_with("http://") || url.starts_with("https://")) || is_internal(url) {
        return;
    }
    let mut b = state(app);
    if !b.settings.save_history {
        return;
    }
    // même page rechargée juste après : une seule entrée
    if let Some(last) = b.history.last_mut() {
        if last.url == url {
            last.time = now_secs();
            b.history_dirty = true;
            return;
        }
    }
    b.history.push(HistEntry { url: url.chars().take(2048).collect(), title: String::new(), time: now_secs() });
    let n = b.history.len();
    if n > 5000 {
        b.history.drain(0..n - 5000);
    }
    b.history_dirty = true;
}

#[tauri::command]
async fn history_list(app: AppHandle, query: Option<String>, limit: Option<usize>) -> Vec<HistEntry> {
    let q = query.unwrap_or_default().to_lowercase();
    let limit = limit.unwrap_or(500).min(2000);
    let b = state(&app);
    b.history
        .iter()
        .rev()
        .filter(|h| q.is_empty() || h.url.to_lowercase().contains(&q) || h.title.to_lowercase().contains(&q))
        .take(limit)
        .cloned()
        .collect()
}

/// Adresse sans « https:// » ni « www. » ni « / » final, pour comparer avec ce que l'on tape.
fn bare_url(u: &str) -> String {
    let l = u.trim().to_lowercase();
    let l = l.strip_prefix("https://").or_else(|| l.strip_prefix("http://")).unwrap_or(&l).to_string();
    let l = l.strip_prefix("www.").unwrap_or(&l).to_string();
    l.trim_end_matches('/').to_string()
}

/// Barre d'adresse : sites déjà visités qui correspondent au texte tapé.
/// `inline` : complétion à écrire directement dans la barre (comme Chrome) ;
/// `items` : sites de l'historique à proposer dans la liste.
#[tauri::command]
async fn history_complete(app: AppHandle, query: String) -> serde_json::Value {
    let q = bare_url(&query);
    if q.is_empty() || q.contains(char::is_whitespace) {
        return serde_json::json!({ "inline": null, "items": [] });
    }
    // une ligne par adresse : nombre de visites, dernière visite, titre
    struct Agg { url: String, title: String, count: u32, last: u64 }
    let mut by_url: HashMap<String, Agg> = HashMap::new();
    // domaines visités (pour compléter « hel » → « hellcase.com »)
    let mut hosts: HashMap<String, (u32, u64, String)> = HashMap::new();
    {
        let b = state(&app);
        for h in b.history.iter().rev().take(5000) {
            if !(h.url.starts_with("http://") || h.url.starts_with("https://")) {
                continue;
            }
            let bare = bare_url(&h.url);
            let host = bare.split(['/', '?', '#']).next().unwrap_or("").to_string();
            if host.is_empty() {
                continue;
            }
            let hl = h.title.to_lowercase();
            if host.starts_with(&q) || bare.starts_with(&q) {
                let e = hosts.entry(host.clone()).or_insert((0, 0, String::new()));
                e.0 += 1;
                if h.time >= e.1 {
                    e.1 = h.time;
                    let scheme = if h.url.starts_with("http://") { "http://" } else { "https://" };
                    let www = if h.url.to_lowercase().contains("://www.") { "www." } else { "" };
                    e.2 = format!("{scheme}{www}{host}/");
                }
            }
            if bare.contains(&q) || hl.contains(&q) {
                let a = by_url.entry(bare.clone()).or_insert(Agg { url: h.url.clone(), title: h.title.clone(), count: 0, last: h.time });
                a.count += 1;
                if h.time > a.last {
                    a.last = h.time;
                }
                if a.title.is_empty() {
                    a.title = h.title.clone();
                }
            }
        }
    }
    // complétion : le domaine le plus visité qui commence par le texte ; si l'on tape déjà un chemin, l'adresse complète
    let inline = if q.contains('/') {
        by_url.iter().filter(|(k, _)| k.starts_with(&q)).max_by_key(|(_, a)| (a.count, a.last))
            .map(|(k, a)| serde_json::json!({ "text": k, "url": a.url, "title": a.title }))
    } else {
        hosts.iter().max_by_key(|(h, v)| (v.0, v.1, std::cmp::Reverse(h.len())))
            .map(|(h, v)| {
                let title = by_url.get(h).map(|a| a.title.clone()).unwrap_or_default();
                serde_json::json!({ "text": h, "url": v.2, "title": title })
            })
    };
    let inline_bare = inline.as_ref().and_then(|v| v["text"].as_str()).unwrap_or("").to_string();
    // liste : d'abord les adresses qui commencent par le texte, puis les plus visitées
    let mut list: Vec<(String, Agg)> = by_url.into_iter().filter(|(k, _)| *k != inline_bare).collect();
    list.sort_by_key(|(k, a)| (std::cmp::Reverse(k.starts_with(&q) as u8), std::cmp::Reverse(a.count), std::cmp::Reverse(a.last)));
    let items: Vec<serde_json::Value> = list.into_iter().take(3)
        .map(|(_, a)| serde_json::json!({ "url": a.url, "title": a.title })).collect();
    serde_json::json!({ "inline": inline, "items": items })
}

#[tauri::command]
async fn history_delete(app: AppHandle, url: String, time: u64) {
    let mut b = state(&app);
    b.history.retain(|h| !(h.url == url && h.time == time));
    b.history_dirty = true;
}

#[tauri::command]
async fn history_clear(app: AppHandle) {
    let mut b = state(&app);
    b.history.clear();
    b.history_dirty = true;
}

// ---------------------------------------------------------------- téléchargements
fn on_download_event(app: &AppHandle, event: tauri::webview::DownloadEvent<'_>) {
    match event {
        tauri::webview::DownloadEvent::Requested { url, destination } => {
            let path = destination.to_string_lossy().to_string();
            let name = destination.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "fichier".into());
            let mut b = state(app);
            b.next_dl += 1;
            let id = b.next_dl;
            b.downloads.push(Download { id, url: url.to_string(), name, path, state: "progress".into(), time: now_secs() });
        }
        tauri::webview::DownloadEvent::Finished { url, path, success } => {
            let mut b = state(app);
            let u = url.to_string();
            if let Some(d) = b.downloads.iter_mut().rev().find(|d| d.url == u && d.state == "progress") {
                d.state = if success { "done".into() } else { "failed".into() };
                if let Some(p) = path {
                    d.path = p.to_string_lossy().to_string();
                    if let Some(n) = p.file_name() {
                        d.name = n.to_string_lossy().to_string();
                    }
                }
            }
        }
        _ => {}
    }
    broadcast(app);
    let _ = app.emit("downloads-changed", ());
}

#[tauri::command]
async fn downloads_list(app: AppHandle) -> Vec<Download> {
    state(&app).downloads.iter().rev().cloned().collect()
}

#[tauri::command]
async fn downloads_clear(app: AppHandle) {
    state(&app).downloads.retain(|d| d.state == "progress");
    broadcast(&app);
}

/// Ouvre le fichier téléchargé, ou l'affiche dans son dossier.
#[tauri::command]
async fn download_open(app: AppHandle, id: u32, folder: bool) -> Result<(), String> {
    let path = state(&app).downloads.iter().find(|d| d.id == id).map(|d| d.path.clone()).ok_or("téléchargement introuvable")?;
    if path.is_empty() || !std::path::Path::new(&path).exists() {
        return Err("fichier introuvable".into());
    }
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("explorer.exe");
        if folder {
            cmd.arg(format!("/select,{path}"));
        } else {
            cmd.arg(&path);
        }
        cmd.spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if folder {
            cmd.arg("-R");
        }
        cmd.arg(&path).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let target = if folder { std::path::Path::new(&path).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or(path) } else { path };
        std::process::Command::new("xdg-open").arg(target).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------- bibliothèque (historique, téléchargements)
fn open_library_in(app: &AppHandle, win: &str, section: &str) -> Result<(), String> {
    let section = match section {
        "downloads" => "downloads",
        "readlater" => "readlater",
        _ => "history",
    };
    let page = format!("library.html#{section}");
    // déjà ouverte dans la fenêtre : on y va
    let existing = {
        let b = state(app);
        b.windows.get(win).and_then(|w| w.tabs.iter().copied().find(|t| b.tabs.get(t).map(|x| x.page.starts_with("library.html")).unwrap_or(false)))
    };
    if let Some(id) = existing {
        activate(app, id);
        let _ = app.emit_to(tab_label(id).as_str(), "library-section", section);
        return Ok(());
    }
    let id = add_tab_record(&mut state(app), win, String::new(), if section == "downloads" { "Téléchargements".into() } else { "Historique".into() }, String::new(), None, false);
    if let Some(t) = state(app).tabs.get_mut(&id) {
        t.page = page;
    }
    spawn_tab_view(app, id)?;
    activate(app, id);
    Ok(())
}

#[tauri::command]
async fn open_library(app: AppHandle, webview: Webview, section: String) -> Result<(), String> {
    let win = caller_win(&webview);
    let win = if state(&app).windows.contains_key(&win) { win } else { win_of_tab(&app, tab_id_from_label(webview.label()).unwrap_or(0)).unwrap_or(win) };
    open_library_in(&app, &win, &section)
}

// ---------------------------------------------------------------- zoom par site
const ZOOM_LEVELS: &[f64] = &[0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];

fn apply_site_zoom(app: &AppHandle, id: u32, wv: &Webview, url: &str) {
    let site = site_of(url);
    let z = if site.is_empty() { 1.0 } else { state(app).settings.zooms.get(&site).copied().unwrap_or(1.0) };
    let _ = wv.set_zoom(z);
    let changed = {
        let mut b = state(app);
        match b.tabs.get_mut(&id) {
            Some(t) if (t.zoom - z).abs() > 0.001 => {
                t.zoom = z;
                true
            }
            _ => false,
        }
    };
    if changed {
        broadcast(app);
    }
}

/// Zoom de l'onglet : "in", "out" ou "reset" ; mémorisé pour son site.
fn zoom_tab(app: &AppHandle, id: u32, dir: &str) {
    let (url, cur) = match state(app).tabs.get(&id) {
        Some(t) => (t.url.clone(), t.zoom),
        None => return,
    };
    let pos = ZOOM_LEVELS.iter().position(|z| (z - cur).abs() < 0.01).unwrap_or(5);
    let z = match dir {
        "in" => ZOOM_LEVELS[(pos + 1).min(ZOOM_LEVELS.len() - 1)],
        "out" => ZOOM_LEVELS[pos.saturating_sub(1)],
        _ => 1.0,
    };
    if let Some(wv) = app.get_webview(&tab_label(id)) {
        let _ = wv.set_zoom(z);
    }
    let site = site_of(&url);
    {
        let mut b = state(app);
        if let Some(t) = b.tabs.get_mut(&id) {
            t.zoom = z;
        }
        if !site.is_empty() {
            if (z - 1.0).abs() < 0.001 {
                b.settings.zooms.remove(&site);
            } else {
                b.settings.zooms.insert(site, z);
            }
        }
    }
    save_settings(app);
    broadcast(app);
}

#[tauri::command]
async fn zoom_active(app: AppHandle, webview: Webview, dir: String) {
    let win = caller_win(&webview);
    if let Some(id) = state(&app).windows.get(&win).and_then(|w| w.active) {
        zoom_tab(&app, id, &dir);
    }
}

// ---------------------------------------------------------------- mode lecture, recherche dans la page
fn eval_active(app: &AppHandle, win: &str, js: &str) -> Result<(), String> {
    let id = state(app).windows.get(win).and_then(|w| w.active).ok_or("aucun onglet")?;
    let wv = app.get_webview(&tab_label(id)).ok_or("page indisponible")?;
    let _ = wv.set_focus();
    wv.eval(js).map_err(|e| e.to_string())
}

#[tauri::command]
async fn reader_toggle(app: AppHandle, webview: Webview) -> Result<(), String> {
    eval_active(&app, &caller_win(&webview), "window.__corrtexReader && window.__corrtexReader()")
}

#[tauri::command]
async fn find_open(app: AppHandle, webview: Webview) -> Result<(), String> {
    eval_active(&app, &caller_win(&webview), "window.__corrtexFind && window.__corrtexFind()")
}

// ---------------------------------------------------------------- palette de commandes (Ctrl+K)
fn palette_in(app: &AppHandle, win: &str) -> Result<(), String> {
    close_popups(app, win);
    let data = {
        let b = state(app);
        let w = b.windows.get(win).ok_or("fenêtre introuvable")?;
        let tabs: Vec<serde_json::Value> = w
            .tabs
            .iter()
            .filter_map(|id| b.tabs.get(id))
            .map(|t| serde_json::json!({ "id": t.id, "title": t.title, "url": t.url, "favicon": t.favicon, "active": w.active == Some(t.id), "asleep": t.asleep }))
            .collect();
        let active = w.active.and_then(|a| b.tabs.get(&a));
        serde_json::json!({ "kind": "palette", "tabs": tabs, "closed": !b.closed.is_empty(),
            "page": active.map(|t| !t.url.is_empty()).unwrap_or(false), "sidebar": w.sidebar_open, "zoom": active.map(|t| t.zoom).unwrap_or(1.0) })
    };
    let (ww, _) = window_logical_size(app, win);
    let w = 620.0_f64.min(ww - 40.0);
    open_popup(app, win, "popw", data, (ww - w) / 2.0, 64.0, w, 460.0)
}

#[tauri::command]
async fn palette_open(app: AppHandle, webview: Webview) -> Result<(), String> {
    palette_in(&app, &caller_win(&webview))
}

/// Ouvre une adresse depuis la palette : dans l'onglet actuel s'il est vide, sinon un nouvel onglet.
#[tauri::command]
async fn palette_go(app: AppHandle, webview: Webview, url: String) -> Result<(), String> {
    let win = caller_win(&webview);
    close_popups(&app, &win);
    let (active, empty) = {
        let b = state(&app);
        let a = b.windows.get(&win).and_then(|w| w.active);
        (a, a.and_then(|a| b.tabs.get(&a)).map(|t| t.url.is_empty() && t.page.is_empty()).unwrap_or(false))
    };
    if empty {
        let id = active.ok_or("aucun onglet")?;
        let wv = app.get_webview(&tab_label(id)).ok_or("page indisponible")?;
        wv.navigate(url.parse().map_err(|_| "adresse invalide")?).map_err(|e| e.to_string())?;
        let _ = wv.set_focus();
        Ok(())
    } else {
        create_tab(&app, &win, Some(url)).map(|_| ())
    }
}


// ---------------------------------------------------------------- navigation privée
/// Nouvelle fenêtre privée : ses pages ne vont ni dans l'historique ni dans la session,
/// et leurs cookies disparaissent quand la dernière fenêtre privée se ferme (InPrivate).
fn open_private_window(app: &AppHandle) -> Result<String, String> {
    let win = create_window(app, None, None)?;
    if let Some(w) = state(app).windows.get_mut(&win) {
        w.private = true;
        w.sidebar_open = false;
    }
    if let Some(w) = app.get_window(&win) {
        let _ = w.set_title("Corrtex — Navigation privée");
    }
    create_tab(app, &win, None)?;
    broadcast(app);
    Ok(win)
}

#[tauri::command]
async fn new_private_window(app: AppHandle) -> Result<(), String> {
    open_private_window(&app).map(|_| ())
}

// ---------------------------------------------------------------- confidentialité
#[tauri::command]
async fn set_privacy(app: AppHandle, save_history: Option<bool>) {
    if let Some(v) = save_history {
        state(&app).settings.save_history = v;
    }
    save_settings(&app);
    broadcast(&app);
}

/// Efface les données de navigation : "history" (historique de Corrtex) ou "cookies"
/// (cookies, cache et données des sites : vous êtes déconnecté des sites).
#[tauri::command]
async fn clear_data(app: AppHandle, webview: Webview, kind: String) -> Result<(), String> {
    match kind.as_str() {
        "history" => {
            let mut b = state(&app);
            b.history.clear();
            b.history_dirty = true;
            b.closed.clear();
        }
        "cookies" => {
            webview.clear_all_browsing_data().map_err(|e| e.to_string())?;
            // le compte Google affiché n'est plus valable
            schedule_google_probe(&app, Duration::from_millis(800));
        }
        _ => return Err("type inconnu".into()),
    }
    broadcast(&app);
    Ok(())
}

// ---------------------------------------------------------------- performances
static SYS: std::sync::OnceLock<Mutex<Option<sysinfo::System>>> = std::sync::OnceLock::new();

/// Mémoire utilisée par Corrtex : l'application et toutes ses pages (processus enfants).
fn corrtex_memory() -> u64 {
    let lock = SYS.get_or_init(|| Mutex::new(sysinfo::System::new().ok()));
    let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let Some(sys) = guard.as_mut() else { return 0 };
    sys.refresh_processes_specifics(sysinfo::ProcessesToUpdate::All, true, sysinfo::ProcessRefreshKind::nothing().with_memory());
    let Ok(me) = sysinfo::get_current_pid() else { return 0 };
    let procs = sys.processes();
    // tous les descendants de Corrtex (moteur WebView2, pages, extensions…)
    let mut total = 0u64;
    let mut stack = vec![me];
    let mut seen = std::collections::HashSet::new();
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        if let Some(p) = procs.get(&pid) {
            total += p.memory();
        }
        for (cpid, p) in procs.iter() {
            if p.parent() == Some(pid) {
                stack.push(*cpid);
            }
        }
    }
    total
}

/// Tableau des performances : mémoire de Corrtex et de chaque onglet.
#[tauri::command]
async fn perf_stats(app: AppHandle) -> serde_json::Value {
    // relevé de la mémoire JavaScript des pages ouvertes (réponse au prochain appel)
    let awake: Vec<u32> = state(&app).tabs.values().filter(|t| !t.asleep && !t.url.is_empty()).map(|t| t.id).collect();
    for id in awake {
        if let Some(wv) = app.get_webview(&tab_label(id)) {
            let _ = wv.eval("try { window.__TAURI_INTERNALS__.invoke('tab_event', { kind: 'perf', data: (performance.memory && performance.memory.usedJSHeapSize) || 0 }); } catch (e) {}");
        }
    }
    let total = tauri::async_runtime::spawn_blocking(corrtex_memory).await.unwrap_or(0);
    let b = state(&app);
    let mut tabs: Vec<serde_json::Value> = b
        .tabs
        .values()
        .map(|t| {
            let active = b.windows.get(&t.win).and_then(|w| w.active) == Some(t.id);
            let private = b.windows.get(&t.win).map(|w| w.private).unwrap_or(false);
            serde_json::json!({ "id": t.id, "title": t.title, "url": t.url, "favicon": t.favicon, "asleep": t.asleep,
                "active": active, "pinned": t.pinned, "private": private, "js": t.js_mem })
        })
        .collect();
    tabs.sort_by(|a, b| b["js"].as_u64().cmp(&a["js"].as_u64()));
    let asleep = b.tabs.values().filter(|t| t.asleep).count();
    serde_json::json!({ "total": total, "tabs": tabs, "asleep": asleep, "count": b.tabs.len(), "sleep_min": b.settings.sleep_min })
}

/// Met en veille un onglet depuis le tableau des performances (ou tous les onglets inactifs).
#[tauri::command]
async fn perf_sleep(app: AppHandle, id: Option<u32>) -> usize {
    let ids: Vec<u32> = match id {
        Some(i) => vec![i],
        None => state(&app).tabs.values().filter(|t| !t.pinned).map(|t| t.id).collect(),
    };
    let mut n = 0;
    for i in ids {
        if sleep_tab(&app, i) {
            n += 1;
        }
    }
    broadcast(&app);
    n
}

// ---------------------------------------------------------------- réponses rapides (bulle)
/// Pose la question à une page d'IA cachée (même IA, même compte que le panneau, sans API) ;
/// la réponse est renvoyée au fil de l'eau dans la bulle de l'onglet.
fn quick_ask(app: &AppHandle, win: &str, tab: u32, bubble: String, prompt: String) -> Result<(), String> {
    quick_ask_to(app, win, tab, bubble, prompt, None)
}

/// Même chose, la réponse étant remise à une fonction précise de la page (`cb`).
fn quick_ask_to(app: &AppHandle, win: &str, tab: u32, bubble: String, prompt: String, cb: Option<&'static str>) -> Result<(), String> {
    quick_ask_slot(app, win, 0, tab, bubble, prompt, cb)
}

/// Clé d'une session d'IA cachée : la fenêtre, plus le numéro de session (0 = la session habituelle).
/// Plusieurs sessions travaillent en même temps (recherche d'achat : analyse et classement en parallèle).
fn quick_key(win: &str, slot: u8) -> String {
    if slot == 0 { win.to_string() } else { format!("{win}_s{slot}") }
}

/// Sessions d'IA déjà chargées sur une discussion vierge, prêtes à recevoir une question.
fn quick_fresh() -> &'static Mutex<std::collections::HashSet<String>> {
    static M: std::sync::OnceLock<Mutex<std::collections::HashSet<String>>> = std::sync::OnceLock::new();
    M.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// Ouvre une session d'IA cachée à l'avance (discussion vierge), pour qu'elle réponde sans attendre.
fn quick_warm(app: &AppHandle, win: &str, slot: u8) -> Result<(), String> {
    let key = quick_key(win, slot);
    if app.get_webview(&format!("aiq-{key}")).is_some() && quick_fresh().lock().unwrap_or_else(|e| e.into_inner()).contains(&key) {
        return Ok(());
    }
    if state(app).quick.contains_key(&key) {
        return Ok(());
    }
    quick_open(app, win, &key)
}

fn quick_open(app: &AppHandle, win: &str, key: &str) -> Result<(), String> {
    quick_fresh().lock().unwrap_or_else(|e| e.into_inner()).remove(key);
    let url = provider(&state(app).settings.ai_provider).url;
    let label = format!("aiq-{key}");
    match app.get_webview(&label) {
        // nouvelle discussion à chaque question
        Some(q) => {
            q.navigate(url.parse().unwrap()).map_err(|e| e.to_string())?;
        }
        None => {
            let window = app.get_window(win).ok_or("fenêtre introuvable")?;
            let (w, _) = window_logical_size(app, win);
            let app_load = app.clone();
            window
                .add_child(
                    web(label.clone(), WebviewUrl::External(url.parse().unwrap()))
                        .user_agent(MOBILE_UA)
                        .initialization_script(AI_SCRIPT)
                        .focused(false)
                        .on_page_load(move |wv, payload| {
                            if matches!(payload.event(), PageLoadEvent::Finished) {
                                quick_page_loaded(&app_load, &wv);
                            }
                        })
                        .on_new_window(|_, _| NewWindowResponse::Deny),
                    LogicalPosition::new(w + 200.0, 0.0),
                    LogicalSize::new(420.0, 820.0),
                )
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn quick_ask_slot(app: &AppHandle, win: &str, slot: u8, tab: u32, bubble: String, prompt: String, cb: Option<&'static str>) -> Result<(), String> {
    let key = quick_key(win, slot);
    let req = {
        let mut b = state(app);
        b.next_req += 1;
        let req = b.next_req;
        b.quick.insert(key.clone(), QuickReq { req, tab, bubble, prompt, started: false, cb, view: None });
        req
    };
    // session déjà prête (discussion vierge chargée) : la question part tout de suite
    let fresh = quick_fresh().lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
    match app.get_webview(&format!("aiq-{key}")) {
        Some(wv) if fresh => quick_page_loaded(app, &wv),
        _ => quick_open(app, win, &key)?,
    }
    // pas de réponse au bout de 75 s : la bulle propose d'ouvrir le panneau
    let app2 = app.clone();
    let win2 = key.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(75));
        let left = {
            let mut b = state(&app2);
            match b.quick.get(&win2) {
                Some(q) if q.req == req => b.quick.remove(&win2),
                _ => None,
            }
        };
        if let Some(q) = left {
            bubble_update(&app2, &q, "", true, true);
        }
    });
    Ok(())
}

/// La page d'IA cachée a chargé : on envoie la question en attente et on suit la réponse.
fn quick_page_loaded(app: &AppHandle, wv: &Webview) {
    let win = wv.label().trim_start_matches("aiq-").to_string();
    let job = {
        let mut b = state(app);
        match b.quick.get_mut(&win) {
            Some(q) if !q.started => {
                q.started = true;
                Some(q.clone())
            }
            _ => None,
        }
    };
    // pas de question en attente : session préchargée, prête pour la prochaine
    let Some(q) = job else {
        if !state(app).quick.contains_key(&win) {
            quick_fresh().lock().unwrap_or_else(|e| e.into_inner()).insert(win);
        }
        return;
    };
    let wv = wv.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1200));
        let js = format!(
            "window.__corrtexMark && window.__corrtexMark(); window.__corrtexAsk && window.__corrtexAsk({}); setTimeout(function () {{ window.__corrtexWatch && window.__corrtexWatch({}); }}, 1500);",
            serde_json::to_string(&q.prompt).unwrap_or_default(),
            q.req
        );
        let _ = wv.eval(&js);
    });
}

fn bubble_update(app: &AppHandle, q: &QuickReq, text: &str, done: bool, error: bool) {
    if let Some(tab) = app.get_webview(&q.view.clone().unwrap_or_else(|| tab_label(q.tab))) {
        let f = q.cb.unwrap_or("__corrtexBubble");
        let js = format!(
            "window.{f} && window.{f}({}, {}, {}, {})",
            serde_json::to_string(&q.bubble).unwrap_or_default(),
            serde_json::to_string(text).unwrap_or_default(),
            done,
            error
        );
        let _ = tab.eval(&js);
    }
}

/// Texte de la réponse renvoyé par la page d'IA cachée.
#[tauri::command]
async fn ai_quick_result(app: AppHandle, webview: Webview, req: u64, text: String, done: bool, error: bool) {
    let Some(win) = webview.label().strip_prefix("aiq-").map(|s| s.to_string()) else { return };
    let q = {
        let mut b = state(&app);
        match b.quick.get(&win) {
            Some(q) if q.req == req => {
                let q = q.clone();
                if done {
                    b.quick.remove(&win);
                }
                Some(q)
            }
            _ => None,
        }
    };
    if let Some(q) = q {
        let text: String = text.chars().take(20000).collect();
        bubble_update(&app, &q, &text, done, error);
    }
}


// ---------------------------------------------------------------- article détaché (fenêtre à part)
fn reader_store() -> &'static Mutex<HashMap<String, serde_json::Value>> {
    static M: std::sync::OnceLock<Mutex<HashMap<String, serde_json::Value>>> = std::sync::OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Ouvre l'article de la recherche IA dans sa propre fenêtre, déplaçable n'importe où sur l'écran.
#[tauri::command]
async fn reader_open(app: AppHandle, title: String, html: String) -> Result<(), String> {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
    let label = format!("reader-{}", N.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    let title: String = title.chars().take(120).collect();
    reader_store().lock().unwrap_or_else(|e| e.into_inner()).insert(label.clone(), serde_json::json!({ "title": title, "html": html.chars().take(400_000).collect::<String>() }));
    let window = WindowBuilder::new(&app, &label)
        .title(if title.is_empty() { "Article — Corrtex".to_string() } else { format!("{title} — Corrtex") })
        .inner_size(760.0, 860.0)
        .min_inner_size(380.0, 320.0)
        .shadow(true)
        .build()
        .map_err(|e| e.to_string())?;
    let (w, h) = window
        .inner_size()
        .ok()
        .zip(window.scale_factor().ok())
        .map(|(s, f)| (s.width as f64 / f, s.height as f64 / f))
        .unwrap_or((760.0, 860.0));
    window
        .add_child(web(format!("{label}-view"), WebviewUrl::App("reader.html".into())), LogicalPosition::new(0.0, 0.0), LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    // la page suit la taille de la fenêtre
    let app2 = app.clone();
    let l2 = label.clone();
    window.on_window_event(move |ev| match ev {
        WindowEvent::Resized(size) => {
            if let (Some(win), Some(v)) = (app2.get_window(&l2), app2.get_webview(&format!("{l2}-view"))) {
                let f = win.scale_factor().unwrap_or(1.0);
                set_bounds(&v, LogicalPosition::new(0.0, 0.0), LogicalSize::new(size.width as f64 / f, size.height as f64 / f));
            }
        }
        WindowEvent::Destroyed => {
            reader_store().lock().unwrap_or_else(|e| e.into_inner()).remove(&l2);
        }
        _ => {}
    });
    Ok(())
}

#[tauri::command]
async fn reader_get(webview: Webview) -> serde_json::Value {
    let label = webview.label().trim_end_matches("-view").to_string();
    reader_store().lock().unwrap_or_else(|e| e.into_inner()).get(&label).cloned().unwrap_or(serde_json::Value::Null)
}

// ---------------------------------------------------------------- génération d'images (ChatGPT / Gemini, sans API)
/// Une génération d'image en cours dans la vue cachée `aiimg-{win}`.
#[derive(Clone)]
struct ImgJob {
    req: String,
    view: String,
    prompt: String,
    /// IA encore à essayer (la première est celle en cours)
    providers: Vec<&'static str>,
    started: bool,
    serial: u64,
}

fn img_jobs() -> &'static Mutex<HashMap<String, ImgJob>> {
    static M: std::sync::OnceLock<Mutex<HashMap<String, ImgJob>>> = std::sync::OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// IA capables de générer des images, la plus probable en premier : celle du panneau si elle
/// en est capable, sinon ChatGPT puis Gemini (on passe à la suivante si on n'y est pas connecté).
fn image_providers(app: &AppHandle) -> Vec<&'static str> {
    let cur = state(app).settings.ai_provider.clone();
    match cur.as_str() {
        "gemini" => vec!["gemini", "chatgpt"],
        _ => vec!["chatgpt", "gemini"],
    }
}

fn img_reply(app: &AppHandle, job: &ImgJob, payload: serde_json::Value) {
    if let Some(v) = app.get_webview(&job.view) {
        let js = format!(
            "window.__corrtexImageGen && window.__corrtexImageGen({}, {})",
            serde_json::to_string(&job.req).unwrap_or_default(),
            payload
        );
        let _ = v.eval(&js);
    }
}

/// Lance (ou relance avec l'IA suivante) la génération dans la vue cachée.
fn img_start(app: &AppHandle, win: &str) -> Result<(), String> {
    let job = img_jobs().lock().unwrap_or_else(|e| e.into_inner()).get(win).cloned().ok_or("aucune génération")?;
    let Some(pid) = job.providers.first() else { return Err("aucune IA disponible".into()) };
    img_reply(app, &job, serde_json::json!({ "status": "start", "provider": provider(pid).name }));
    let url: tauri::Url = provider(pid).url.parse().map_err(|_| "adresse invalide")?;
    let label = format!("aiimg-{win}");
    match app.get_webview(&label) {
        Some(v) => v.navigate(url).map_err(|e| e.to_string())?,
        None => {
            let window = app.get_window(win).ok_or("fenêtre introuvable")?;
            let (w, _) = window_logical_size(app, win);
            let app_load = app.clone();
            window
                .add_child(
                    web(label.clone(), WebviewUrl::External(url))
                        .user_agent(MOBILE_UA)
                        .initialization_script(AI_SCRIPT)
                        .focused(false)
                        .on_page_load(move |wv, payload| {
                            if matches!(payload.event(), PageLoadEvent::Finished) {
                                img_page_loaded(&app_load, &wv);
                            }
                        })
                        .on_new_window(|_, _| NewWindowResponse::Deny),
                    LogicalPosition::new(w + 700.0, 0.0),
                    LogicalSize::new(480.0, 900.0),
                )
                .map_err(|e| e.to_string())?;
        }
    }
    // délai de sécurité : une image peut prendre plus d'une minute
    let (app2, win2, serial) = (app.clone(), win.to_string(), job.serial);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(200));
        let left = {
            let mut m = img_jobs().lock().unwrap_or_else(|e| e.into_inner());
            match m.get(&win2) {
                Some(j) if j.serial == serial => m.remove(&win2),
                _ => None,
            }
        };
        if let Some(j) = left {
            img_reply(&app2, &j, serde_json::json!({ "status": "error", "error": "L’IA n’a pas répondu à temps." }));
        }
    });
    Ok(())
}

fn img_page_loaded(_app: &AppHandle, wv: &Webview) {
    let win = wv.label().trim_start_matches("aiimg-").to_string();
    let job = {
        let mut m = img_jobs().lock().unwrap_or_else(|e| e.into_inner());
        match m.get_mut(&win) {
            Some(j) if !j.started => {
                j.started = true;
                Some(j.clone())
            }
            _ => None,
        }
    };
    let Some(j) = job else { return };
    let wv = wv.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        let js = format!(
            "window.__corrtexImageWatch && window.__corrtexImageWatch({}, {});",
            j.serial,
            serde_json::to_string(&j.prompt).unwrap_or_default()
        );
        let _ = wv.eval(&js);
    });
}

/// Page de résultats (onglet Images) : « Générer une image ».
#[tauri::command]
async fn ai_image(app: AppHandle, webview: Webview, prompt: String, req: String) -> Result<(), String> {
    let win = caller_win(&webview);
    let prompt: String = prompt.trim().chars().take(1500).collect();
    if prompt.is_empty() {
        return Err("description vide".into());
    }
    static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let job = ImgJob {
        req: req.chars().filter(|c| c.is_ascii_alphanumeric()).take(30).collect(),
        view: webview.label().to_string(),
        prompt,
        providers: image_providers(&app),
        started: false,
        serial: SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    };
    img_jobs().lock().unwrap_or_else(|e| e.into_inner()).insert(win.clone(), job);
    img_start(&app, &win)
}

/// Résultat renvoyé par la vue cachée : images (data: ou https:), ou erreur (« login » : pas connecté).
#[tauri::command]
async fn ai_image_result(app: AppHandle, webview: Webview, serial: u64, images: Vec<String>, text: String, error: String) {
    let Some(win) = webview.label().strip_prefix("aiimg-").map(|s| s.to_string()) else { return };
    let job = {
        let m = img_jobs().lock().unwrap_or_else(|e| e.into_inner());
        m.get(&win).filter(|j| j.serial == serial).cloned()
    };
    let Some(mut job) = job else { return };
    let images: Vec<String> = images
        .into_iter()
        .filter(|u| u.starts_with("data:image/") || u.starts_with("https://"))
        .take(4)
        .collect();
    let name = job.providers.first().map(|p| provider(p).name).unwrap_or("");
    if !images.is_empty() {
        img_jobs().lock().unwrap_or_else(|e| e.into_inner()).remove(&win);
        img_reply(&app, &job, serde_json::json!({ "status": "done", "images": images, "provider": name, "text": text.chars().take(600).collect::<String>() }));
        return;
    }
    // pas d'image : on essaie l'IA suivante (pas connecté, quota atteint, refus…)
    job.providers.remove(0);
    if !job.providers.is_empty() {
        job.started = false;
        img_jobs().lock().unwrap_or_else(|e| e.into_inner()).insert(win.clone(), job);
        let _ = img_start(&app, &win);
        return;
    }
    img_jobs().lock().unwrap_or_else(|e| e.into_inner()).remove(&win);
    let msg = if error == "login" {
        "Connectez-vous à ChatGPT ou à Gemini dans le panneau IA pour générer des images.".to_string()
    } else if !text.trim().is_empty() {
        text.chars().take(600).collect()
    } else {
        "L’IA n’a pas produit d’image. Réessayez ou reformulez la description.".to_string()
    };
    img_reply(&app, &job, serde_json::json!({ "status": "error", "error": msg }));
}

// ---------------------------------------------------------------- traduction de la page
/// Requête POST simple (curl, comme pour les suggestions) ; le corps passe par l'entrée standard.
fn http_post(url: &str, body: &str) -> Option<Vec<u8>> {
    use std::io::Write;
    let mut cmd = std::process::Command::new(if cfg!(windows) { "curl.exe" } else { "curl" });
    cmd.args(["-s", "-f", "--max-time", "12", "-X", "POST", "-H", "Content-Type: application/x-www-form-urlencoded;charset=UTF-8", "--data-binary", "@-", url]);
    cmd.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().ok()?;
    child.stdin.take()?.write_all(body.as_bytes()).ok()?;
    let out = child.wait_with_output().ok()?;
    out.status.success().then_some(out.stdout)
}

fn form_enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Traduit un texte avec Google Traduction (service public, sans clé) ; renvoie aussi la langue d'origine.
fn translate_one(text: &str, to: &str) -> Option<(String, String)> {
    let url = format!("https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl={to}&dt=t&ie=UTF-8&oe=UTF-8");
    let out = http_post(&url, &format!("q={}", form_enc(text)))?;
    let v: serde_json::Value = serde_json::from_slice(&out).ok()?;
    let parts = v.get(0)?.as_array()?;
    let mut res = String::new();
    for p in parts {
        if let Some(t) = p.get(0).and_then(|x| x.as_str()) {
            res.push_str(t);
        }
    }
    let from = v.get(2).and_then(|x| x.as_str()).unwrap_or("").to_string();
    Some((res, from))
}

/// Traduit une série de morceaux de texte de la page (un seul appel quand c'est possible).
fn translate_texts(texts: &[String], to: &str) -> Option<Vec<String>> {
    let clean: Vec<String> = texts.iter().map(|t| t.replace(['\n', '\r'], " ")).collect();
    if let Some((joined, _)) = translate_one(&clean.join("\n"), to) {
        let lines: Vec<String> = joined.split('\n').map(|l| l.to_string()).collect();
        if lines.len() == clean.len() {
            return Some(lines);
        }
    }
    // le découpage n'a pas été conservé : morceau par morceau, en parallèle
    let handles: Vec<_> = clean
        .into_iter()
        .map(|t| {
            let to = to.to_string();
            std::thread::spawn(move || translate_one(&t, &to).map(|r| r.0).unwrap_or(t))
        })
        .collect();
    Some(handles.into_iter().map(|h| h.join().unwrap_or_default()).collect())
}

/// Bouton « Traduire la page » : traduit en français, ou rétablit l'original.
#[tauri::command]
async fn translate_page(app: AppHandle, webview: Webview) {
    if let Some(wv) = active_webview(&app, &caller_win(&webview)) {
        let _ = wv.eval("window.__corrtexTranslatePage && window.__corrtexTranslatePage()");
    }
}

// ---------------------------------------------------------------- recherche dans l'historique avec l'IA
fn ymd_of(secs: u64) -> String {
    let z = (secs as i64).div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// « le site de chaussures vu mardi » : l'IA choisit dans l'historique ; la réponse
/// (numéros des pages) arrive dans la page Historique, qui reçoit aussi la liste envoyée.
#[tauri::command]
async fn history_ai(app: AppHandle, webview: Webview, query: String, req: String) -> Result<Vec<HistEntry>, String> {
    let tab = tab_id_from_label(webview.label()).ok_or("page inconnue")?;
    let win = win_of_tab(&app, tab).ok_or("fenêtre introuvable")?;
    let q: String = query.trim().chars().take(300).collect();
    if q.is_empty() {
        return Err("question vide".into());
    }
    let list: Vec<HistEntry> = {
        let b = state(&app);
        let mut seen = std::collections::HashSet::new();
        b.history.iter().rev().filter(|h| seen.insert(h.url.clone())).take(260).cloned().collect()
    };
    if list.is_empty() {
        return Err("historique vide".into());
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let jours = ["jeudi", "vendredi", "samedi", "dimanche", "lundi", "mardi", "mercredi"];
    let mut p = format!(
        "Voici mon historique de navigation (numéro | date | jour | titre | adresse). Aujourd'hui nous sommes le {} ({}).\nTrouve les pages qui correspondent le mieux à ma demande : « {q} ».\nRéponds UNIQUEMENT par un tableau JSON des numéros, du plus pertinent au moins pertinent (15 au maximum), par exemple [12, 4, 30]. Réponds [] si rien ne correspond. Aucun autre texte.\n\n",
        ymd_of(now),
        jours[((now / 86_400) % 7) as usize]
    );
    for (i, h) in list.iter().enumerate() {
        let short: String = h.url.trim_start_matches("https://").trim_start_matches("http://").trim_start_matches("www.").chars().take(70).collect();
        let title: String = h.title.replace(['\n', '|'], " ").chars().take(80).collect();
        p.push_str(&format!("{i} | {} | {} | {title} | {short}\n", ymd_of(h.time), jours[((h.time / 86_400) % 7) as usize]));
    }
    let req: String = req.chars().filter(|c| c.is_ascii_alphanumeric()).take(30).collect();
    quick_ask_to(&app, &win, tab, req, p, Some("__corrtexHistAI"))?;
    Ok(list)
}

// ---------------------------------------------------------------- agent de navigation
/// Demande à l'IA l'action suivante pour atteindre l'objectif, à partir de l'état de la page.
fn agent_prompt(job: &AgentJob, page: &str) -> String {
    let done = if job.steps.is_empty() {
        "(aucune pour l'instant)".to_string()
    } else {
        job.steps.iter().enumerate().map(|(i, s)| format!("{}. {s}", i + 1)).collect::<Vec<_>>().join("\n")
    };
    format!(
        "Tu pilotes le navigateur Corrtex pour aider l'utilisateur. Objectif : « {} ».\n\n\
Actions déjà faites :\n{done}\n\n\
État actuel de la page :\n{page}\n\n\
Choisis UNE seule action suivante. Réponds UNIQUEMENT par un objet JSON sur une ligne, sans aucun texte autour, parmi :\n\
{{\"action\":\"click\",\"id\":N,\"why\":\"…\"}}\n\
{{\"action\":\"type\",\"id\":N,\"text\":\"…\",\"enter\":true,\"why\":\"…\"}}\n\
{{\"action\":\"select\",\"id\":N,\"value\":\"…\",\"why\":\"…\"}}\n\
{{\"action\":\"scroll\",\"dir\":\"down\",\"why\":\"…\"}} (ou \"up\")\n\
{{\"action\":\"open\",\"url\":\"https://…\",\"why\":\"…\"}}\n\
{{\"action\":\"ask\",\"question\":\"…\"}} si une information de l'utilisateur te manque\n\
{{\"action\":\"done\",\"answer\":\"…\"}} quand l'objectif est atteint (donne le résultat utile à l'utilisateur) ou impossible (explique pourquoi).\n\
Règles : N est le numéro d'un élément de la liste ci-dessus. Écris \"why\" en français, en une courte phrase. \
Ne saisis jamais de mot de passe, de code de vérification ni de données bancaires, et ne confirme jamais un paiement ou un achat : \
dans ce cas réponds \"done\" en expliquant que l'utilisateur doit le faire lui-même. Si la page ne contient pas encore ce qu'il faut, fais défiler ou ouvre une recherche Google.",
        job.goal.replace('\n', " ")
    )
}

fn agent_resume_js(job: &AgentJob) -> String {
    format!(
        "window.__corrtexAgent && window.__corrtexAgent.start({}, {})",
        serde_json::to_string(&job.goal).unwrap_or_default(),
        job.steps.len()
    )
}

/// Ouvre le panneau IA sur la saisie de l'objectif de l'agent (palette Ctrl+K).
#[tauri::command]
async fn agent_open(app: AppHandle, webview: Webview) -> Result<(), String> {
    let win = caller_win(&webview);
    let open = state(&app).windows.get(&win).map(|w| w.sidebar_open).unwrap_or(false);
    if !open {
        toggle_sidebar(app.clone(), webview.clone()).await?;
    }
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(if open { 50 } else { 700 }));
        let _ = app2.emit_to(format!("aibar-{win}").as_str(), "agent-open", serde_json::json!({ "win": win }));
    });
    Ok(())
}

/// Lance l'agent dans l'onglet actif.
#[tauri::command]
async fn agent_start(app: AppHandle, webview: Webview, goal: String, shopping: Option<bool>) -> Result<String, String> {
    let win = caller_win(&webview);
    let goal: String = goal.trim().chars().take(500).collect();
    if goal.is_empty() {
        return Err("objectif vide".into());
    }
    // recherche d'achat : comparateur de prix et suivi des prix plutôt que des clics sur une page
    // (la recherche IA de l'accueil la demande directement)
    if shopping.unwrap_or(false) || is_shopping_goal(&goal) {
        open_shopping(&app, &win, &goal)?;
        return Ok("shopping".into());
    }
    let id = state(&app).windows.get(&win).and_then(|w| w.active).ok_or("aucun onglet")?;
    // sur l'accueil, l'agent commence par une recherche Google
    let empty = state(&app).tabs.get(&id).map(|t| t.url.is_empty()).unwrap_or(true);
    let job = AgentJob { goal: goal.clone(), steps: Vec::new(), waiting: true };
    state(&app).agents.insert(id, job.clone());
    let wv = app.get_webview(&tab_label(id)).ok_or("onglet introuvable")?;
    if empty {
        let url = format!("https://www.google.com/search?q={}", form_enc(&goal));
        let _ = wv.navigate(url.parse().map_err(|_| "adresse invalide")?);
    } else {
        let _ = wv.eval(&agent_resume_js(&job));
    }
    Ok("agent".into())
}

/// Recherche IA de l'accueil : que faire de la demande ?
/// « shopping » : recherche d'achat (comparateur, suivi des prix) ; « action » : l'agent agit sur le web ;
/// « answer » : simple question, réponse avec sources.
#[tauri::command]
async fn agent_kind(goal: String) -> String {
    let g = goal.trim().to_lowercase();
    if is_shopping_goal(&g) {
        return "shopping".into();
    }
    let starts = [
        "réserve", "reserve", "remplis", "inscris", "connecte", "commande", "ouvre ", "va sur", "aller sur", "trouve la page", "trouve-moi la page",
        "contacte", "télécharge", "telecharge", "abonne", "désabonne", "ajoute ", "prends rendez", "prendre rendez", "envoie", "postule",
        "achète", "réserver", "remplir", "s'inscrire", "inscris-moi", "trouve et ouvre", "cherche et ouvre", "navigue", "clique",
    ];
    let anywhere = ["pour moi", "à ma place", "a ma place", "sur le site", "sur leur site", "un billet", "une table", "un rendez-vous", "un créneau", "formulaire", "panier"];
    if starts.iter().any(|w| g.starts_with(w)) || anywhere.iter().any(|w| g.contains(w)) {
        return "action".into();
    }
    // question de connaissance (réponse rédigée) ; tout le reste passe par la comparaison des meilleurs articles
    let ask = [
        "qui ", "que ", "quoi", "quand", "où ", "ou est", "pourquoi", "comment ", "combien de", "quel est", "quelle est", "quels sont", "quelles sont",
        "qu'est", "qu’est", "c'est quoi", "c’est quoi", "explique", "définition", "définis", "traduis", "traduction", "résume", "calcule",
        "est-ce", "peut-on", "histoire de", "météo", "actualité", "actualités", "news", "heure ", "score", "résultat du", "recette", "signification",
    ];
    if ask.iter().any(|w| g.starts_with(w)) || ["météo", "actualit", "recette", "définition", "traduction"].iter().any(|w| g.contains(w)) {
        return "answer".into();
    }
    "shopping".into()
}

// ---------------------------------------------------------------- recherche d'achat de l'agent
/// La demande est-elle une recherche d'article à acheter ? (« trouve-moi un casque à moins de 100 € »)
fn is_shopping_goal(goal: &str) -> bool {
    let g = goal.to_lowercase();
    let words = [
        "acheter", "achat", "achète", "achèterais", "commander", "meilleur prix", "moins cher", "pas cher", "bon plan", "bons plans",
        "promo", "réduction", "budget", "rapport qualité", "qualité/prix", "qualité prix", "comparer les prix", "comparateur",
        "quel modèle", "quelle marque", "lequel choisir", "laquelle choisir", "je cherche un", "je cherche une", "trouve-moi un",
        "trouve moi un", "trouve-moi une", "trouve moi une", "conseille-moi un", "conseille moi un", "conseille-moi une", "recommande-moi",
        "meilleur rapport", "à moins de", "a moins de", "€", "euros", "le meilleur ", "la meilleure ", "les meilleurs ", "les meilleures ",
    ];
    // ce qui ressemble à une action sur la page en cours n'est pas un achat
    let page_task = ["cette page", "sur la page", "ce site", "de ces ", "parmi ces", "sa fiche", "remplis", "connecte", "inscris", "réserve", "billet", "train", "avion", "hôtel", "restaurant"];
    words.iter().any(|w| g.contains(w)) && !page_task.iter().any(|w| g.contains(w))
}

/// Moteur caché de la recherche d'achat (une vue par fenêtre, hors de l'écran) : il continue
/// pendant qu'on change d'onglet ; le panneau est dessiné dans la page de l'onglet affiché.
fn ensure_shop_worker(app: &AppHandle, win: &str) -> Result<(), String> {
    let label = format!("shopw-{win}");
    if let Some(w) = app.get_webview(&label) {
        let _ = w.eval("window.__corrtexShoppingReload && window.__corrtexShoppingReload()");
        return Ok(());
    }
    let window = app.get_window(win).ok_or("fenêtre introuvable")?;
    let (w, _) = window_logical_size(app, win);
    window
        .add_child(
            web(label, WebviewUrl::App("shopping.html".into())).focused(false),
            LogicalPosition::new(w + 900.0, 0.0),
            LogicalSize::new(400.0, 700.0),
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Ouvre le panneau de recherche d'achat et lance une nouvelle recherche.
fn open_shopping(app: &AppHandle, win: &str, goal: &str) -> Result<(), String> {
    state(app).shopping.insert(win.to_string(), serde_json::json!({ "goal": goal, "fresh": true }));
    let placeholder = serde_json::json!({ "goal": goal, "busy": true, "steps": [{ "t": "Préparation de la recherche…", "s": "run" }], "rounds": [], "tags": [], "suggestions": [] });
    state(app).shopping_view.insert(win.to_string(), placeholder);
    ensure_shop_worker(app, win)?;
    shopping_show(app, win);
    Ok(())
}

/// Affiche le panneau dans l'onglet actif de la fenêtre (et le retire de l'onglet précédent).
fn shopping_show(app: &AppHandle, win: &str) {
    let Some(id) = state(app).windows.get(win).and_then(|w| w.active) else { return };
    let prev = state(app).shopping_open.insert(win.to_string(), id);
    if let Some(p) = prev.filter(|p| *p != id) {
        if let Some(wv) = app.get_webview(&tab_label(p)) {
            let _ = wv.eval("window.__corrtexShopping && window.__corrtexShopping.hide()");
        }
    }
    shopping_show_in(app, win, id);
}

fn shopping_show_in(app: &AppHandle, win: &str, id: u32) {
    let view = state(app).shopping_view.get(win).cloned().unwrap_or(serde_json::Value::Null);
    if let Some(wv) = app.get_webview(&tab_label(id)) {
        let js = format!("window.__corrtexShopping && window.__corrtexShopping.show({})", serde_json::to_string(&view).unwrap_or_else(|_| "null".into()));
        let _ = wv.eval(&js);
    }
}

/// Changement d'onglet : le panneau ouvert suit l'onglet affiché.
fn shopping_follow(app: &AppHandle, win: &str) {
    let open = state(app).shopping_open.contains_key(win);
    if open {
        shopping_show(app, win);
    }
}

fn shopping_hide(app: &AppHandle, win: &str) {
    if let Some(id) = state(app).shopping_open.remove(win) {
        if let Some(wv) = app.get_webview(&tab_label(id)) {
            let _ = wv.eval("window.__corrtexShopping && window.__corrtexShopping.hide()");
        }
    }
}

/// Recherche d'achat de la fenêtre (demande, précisions, résultats déjà trouvés).
#[tauri::command]
async fn shopping_job(app: AppHandle, webview: Webview) -> serde_json::Value {
    let win = caller_win(&webview);
    state(&app).shopping.get(&win).cloned().unwrap_or(serde_json::Value::Null)
}

/// Le moteur enregistre sa recherche ; sa version courte va dans l'historique de l'agent.
#[tauri::command]
async fn shopping_save(app: AppHandle, webview: Webview, mut data: serde_json::Value) -> Result<(), String> {
    let win = caller_win(&webview);
    if data.to_string().len() > 1_500_000 {
        return Err("recherche trop volumineuse".into());
    }
    let record = data.as_object_mut().and_then(|o| o.remove("record"));
    state(&app).shopping.insert(win, data);
    if let Some(r) = record {
        agent_history_put(&app, r);
    }
    Ok(())
}

/// Nouvel état de la recherche (étapes, résultats) : le panneau ouvert le redessine.
#[tauri::command]
async fn shopping_push(app: AppHandle, webview: Webview, view: serde_json::Value) {
    let win = caller_win(&webview);
    let shown = {
        let mut b = state(&app);
        b.shopping_view.insert(win.clone(), view);
        b.shopping_open.get(&win).copied()
    };
    if let Some(id) = shown {
        shopping_show_in(&app, &win, id);
    }
}

/// Lance une recherche d'achat depuis une autre page (palette, accueil, bibliothèque).
#[tauri::command]
async fn shopping_start(app: AppHandle, webview: Webview, goal: String) -> Result<(), String> {
    let win = caller_win(&webview);
    let goal: String = goal.trim().chars().take(500).collect();
    if goal.is_empty() {
        return Err("demande vide".into());
    }
    open_shopping(&app, &win, &goal)
}

/// Bouton « Recherche d'achat » (Outils) : ouvre ou ferme le panneau sur la dernière recherche
/// (ou sur l'historique s'il n'y en a pas encore).
fn shopping_toggle(app: &AppHandle, win: &str) {
    if state(app).shopping_open.contains_key(win) {
        shopping_hide(app, win);
        return;
    }
    let has_job = state(app).shopping.contains_key(win);
    if has_job && app.get_webview(&format!("shopw-{win}")).is_none() {
        let _ = ensure_shop_worker(app, win);
    }
    if !state(app).shopping_view.contains_key(win) {
        state(app).shopping_view.insert(win.to_string(), serde_json::json!({ "history": true }));
    }
    shopping_show(app, win);
}

// ---------------------------------------------------------------- historique de l'agent
fn agent_history_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("agent_history.json"))
}

fn load_agent_history(app: &AppHandle) {
    let list: Vec<serde_json::Value> = agent_history_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    state(app).agent_history = list;
}

fn save_agent_history(app: &AppHandle) {
    let list = state(app).agent_history.clone();
    let Some(p) = agent_history_path(app) else { return };
    std::thread::spawn(move || {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string(&list) {
            let _ = std::fs::write(p, json);
        }
    });
}

/// Ajoute (ou met à jour, même numéro) une recherche dans l'historique ; 60 au plus.
fn agent_history_put(app: &AppHandle, mut rec: serde_json::Value) {
    let id = rec.get("id").and_then(|v| v.as_u64()).unwrap_or_else(|| now_secs() * 1000);
    rec["id"] = serde_json::json!(id);
    if rec.get("time").and_then(|v| v.as_u64()).is_none() {
        rec["time"] = serde_json::json!(now_secs());
    }
    {
        let mut b = state(app);
        b.agent_history.retain(|r| r.get("id").and_then(|v| v.as_u64()) != Some(id));
        b.agent_history.push(rec);
        let n = b.agent_history.len();
        if n > 60 {
            b.agent_history.drain(0..n - 60);
        }
    }
    save_agent_history(app);
}

/// Liste de l'historique (sans les données complètes), la plus récente d'abord.
fn agent_history_brief(app: &AppHandle) -> Vec<serde_json::Value> {
    state(app)
        .agent_history
        .iter()
        .rev()
        .map(|r| {
            let mut o = serde_json::Map::new();
            for k in ["id", "kind", "goal", "time", "answer", "url"] {
                if let Some(v) = r.get(k) {
                    o.insert(k.into(), v.clone());
                }
            }
            serde_json::Value::Object(o)
        })
        .collect()
}

#[tauri::command]
async fn agent_history_list(app: AppHandle) -> Vec<serde_json::Value> {
    agent_history_brief(&app)
}

#[tauri::command]
async fn agent_history_delete(app: AppHandle, id: Option<u64>) {
    {
        let mut b = state(&app);
        match id {
            Some(id) => b.agent_history.retain(|r| r.get("id").and_then(|v| v.as_u64()) != Some(id)),
            None => b.agent_history.clear(),
        }
    }
    save_agent_history(&app);
}

/// Rouvre une recherche de l'historique : achat → panneau avec ses résultats ; agent → sa page.
fn agent_history_open_in(app: &AppHandle, win: &str, id: u64) -> Result<(), String> {
    let rec = state(app).agent_history.iter().find(|r| r.get("id").and_then(|v| v.as_u64()) == Some(id)).cloned().ok_or("recherche introuvable")?;
    if rec.get("kind").and_then(|v| v.as_str()) == Some("shopping") {
        let data = rec.get("data").cloned().ok_or("résultats introuvables")?;
        state(app).shopping.insert(win.to_string(), data);
        ensure_shop_worker(app, win)?;
        shopping_show(app, win);
        return Ok(());
    }
    if let Some(url) = rec.get("url").and_then(|v| v.as_str()).filter(|u| u.starts_with("http")) {
        create_tab(app, win, Some(url.to_string()))?;
    }
    Ok(())
}

#[tauri::command]
async fn agent_history_open(app: AppHandle, webview: Webview, id: u64) -> Result<(), String> {
    let win = caller_win(&webview);
    agent_history_open_in(&app, &win, id)
}

/// Messages de l'agent venant de la page.
fn agent_event(app: &AppHandle, id: u32, kind: &str, data: &serde_json::Value) {
    let text = |k: &str, n: usize| data.get(k).and_then(|v| v.as_str()).unwrap_or("").chars().take(n).collect::<String>();
    match kind {
        "agent_snap" => {
            let job = {
                let mut b = state(app);
                match b.agents.get_mut(&id) {
                    Some(j) if j.waiting => {
                        j.waiting = false;
                        Some(j.clone())
                    }
                    _ => None,
                }
            };
            let Some(job) = job else { return };
            let Some(win) = win_of_tab(app, id) else { return };
            let prompt = agent_prompt(&job, &text("page", 14000));
            if let Err(e) = quick_ask_to(app, &win, id, "agent".into(), prompt, Some("__corrtexAgentReply")) {
                debug_log(&format!("agent : {e}"));
            }
        }
        "agent_step" | "agent_answer" => {
            let mut b = state(app);
            if let Some(j) = b.agents.get_mut(&id) {
                let t = text("desc", 300);
                j.steps.push(if kind == "agent_answer" { format!("L'utilisateur a répondu : {t}") } else { t });
                j.waiting = true;
                if j.steps.len() > 30 {
                    b.agents.remove(&id);
                }
            }
        }
        "agent_retry" => {
            if let Some(j) = state(app).agents.get_mut(&id) {
                j.waiting = true;
            }
        }
        _ => {
            state(app).agents.remove(&id);
        }
    }
}

/// Une page vient de charger dans un onglet piloté par l'agent : il reprend là où il en était.
fn agent_page_loaded(app: &AppHandle, id: u32, wv: &Webview) {
    // nouvelle page : l'agent reprend toujours, même si une demande partait de la page précédente
    let job = {
        let mut b = state(app);
        b.agents.get_mut(&id).map(|j| {
            j.waiting = true;
            j.clone()
        })
    };
    if let Some(job) = job {
        let wv = wv.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(900));
            let _ = wv.eval(&agent_resume_js(&job));
        });
    }
}

// ---------------------------------------------------------------- espaces d'onglets
const SPACE_COLORS: &[&str] = &["#5b8cff", "#4cd38a", "#ff9f43", "#a77bff", "#ff4f7b", "#3ccfe0", "#ffd166"];

/// Espaces : « new » (nom), « switch » (id), « rename » (id, nom), « color » (id, couleur), « delete » (id).
#[tauri::command]
async fn space_action(app: AppHandle, webview: Webview, action: String, id: Option<u32>, name: Option<String>, color: Option<String>) -> Result<(), String> {
    let win = caller_win(&webview);
    space_do(app, win, action, id, name, color)
}

fn space_do(app: AppHandle, win: String, action: String, id: Option<u32>, name: Option<String>, color: Option<String>) -> Result<(), String> {
    close_popups(&app, &win);
    let clean = |s: Option<String>| s.map(|n| n.trim().chars().take(30).collect::<String>()).filter(|n| !n.is_empty());
    let mut target: Option<u32> = None;
    let mut create_in: Option<u32> = None;
    {
        let mut b = state(&app);
        let ids: Vec<u32> = b.windows.get(&win).ok_or("fenêtre introuvable")?.spaces.iter().map(|s| s.id).collect();
        let tabs_in = |b: &Browser, sp: u32| -> Vec<u32> {
            b.windows.get(&win).map(|w| w.tabs.iter().copied().filter(|t| b.tabs.get(t).map(|x| x.space == sp).unwrap_or(false)).collect()).unwrap_or_default()
        };
        match action.as_str() {
            "new" => {
                let nid = ids.iter().max().copied().unwrap_or(0) + 1;
                let n = ids.len();
                let w = b.windows.get_mut(&win).ok_or("fenêtre introuvable")?;
                if w.spaces.is_empty() {
                    w.spaces = default_spaces();
                }
                w.spaces.push(Space {
                    id: nid,
                    name: clean(name).unwrap_or_else(|| format!("Espace {}", n + 1)),
                    color: SPACE_COLORS[n % SPACE_COLORS.len()].into(),
                    last: None,
                });
                w.space = nid;
                create_in = Some(nid);
            }
            "switch" => {
                let sp = id.unwrap_or(0);
                if !ids.contains(&sp) {
                    return Err("espace inconnu".into());
                }
                let list = tabs_in(&b, sp);
                let last = b.windows.get(&win).and_then(|w| w.spaces.iter().find(|s| s.id == sp)).and_then(|s| s.last).filter(|l| list.contains(l));
                match last.or_else(|| list.first().copied()) {
                    Some(t) => target = Some(t),
                    None => {
                        if let Some(w) = b.windows.get_mut(&win) {
                            w.space = sp;
                        }
                        create_in = Some(sp);
                    }
                }
            }
            "rename" | "color" => {
                let w = b.windows.get_mut(&win).ok_or("fenêtre introuvable")?;
                if let Some(sp) = w.spaces.iter_mut().find(|s| Some(s.id) == id) {
                    if action == "rename" {
                        if let Some(n) = clean(name) {
                            sp.name = n;
                        }
                    } else if let Some(c) = color.filter(|c| c.len() <= 9 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit())) {
                        sp.color = c;
                    }
                }
            }
            "delete" => {
                // ses onglets rejoignent l'espace Principal
                let sp = id.filter(|i| *i != 0).ok_or("l'espace Principal ne peut pas être supprimé")?;
                for t in tabs_in(&b, sp) {
                    if let Some(x) = b.tabs.get_mut(&t) {
                        x.space = 0;
                    }
                }
                let w = b.windows.get_mut(&win).ok_or("fenêtre introuvable")?;
                w.spaces.retain(|s| s.id != sp);
                if w.space == sp {
                    w.space = 0;
                }
            }
            _ => return Err("action inconnue".into()),
        }
    }
    if let Some(t) = target {
        activate(&app, t);
    } else if create_in.is_some() {
        create_tab(&app, &win, None)?;
    } else {
        broadcast(&app);
    }
    Ok(())
}

/// Range un onglet dans un autre espace.
fn move_tab_to_space(app: &AppHandle, id: u32, space: u32) {
    let (win, was_active) = {
        let mut b = state(app);
        let Some(win) = b.tabs.get(&id).map(|t| t.win.clone()) else { return };
        if !b.windows.get(&win).map(|w| w.spaces.iter().any(|s| s.id == space)).unwrap_or(false) {
            return;
        }
        if let Some(t) = b.tabs.get_mut(&id) {
            t.space = space;
        }
        let active = b.windows.get(&win).and_then(|w| w.active) == Some(id);
        (win, active)
    };
    // l'onglet suit dans son nouvel espace
    if was_active {
        activate(app, id);
    } else {
        let _ = win;
        broadcast(app);
    }
}

// ---------------------------------------------------------------- vue côte à côte
/// Ouvre un onglet à droite de l'onglet actif (`id`), ou un nouvel onglet vide.
#[tauri::command]
async fn split_open(app: AppHandle, webview: Webview, id: Option<u32>) -> Result<(), String> {
    let win = caller_win(&webview);
    split_open_in(app, win, id)
}

fn split_open_in(app: AppHandle, win: String, id: Option<u32>) -> Result<(), String> {
    close_popups(&app, &win);
    let active = state(&app).windows.get(&win).and_then(|w| w.active).ok_or("aucun onglet")?;
    let other = match id.filter(|i| *i != active) {
        Some(i) => {
            if state(&app).tabs.get(&i).map(|t| t.win != win).unwrap_or(true) {
                return Err("onglet introuvable".into());
            }
            i
        }
        None => {
            let nid = {
                let mut b = state(&app);
                add_tab_record(&mut b, &win, String::new(), String::new(), String::new(), None, true)
            };
            nid
        }
    };
    let asleep = state(&app).tabs.get(&other).map(|t| t.asleep).unwrap_or(false);
    if asleep || app.get_webview(&tab_label(other)).is_none() {
        spawn_tab_view(&app, other)?;
    }
    if let Some(w) = state(&app).windows.get_mut(&win) {
        w.split = Some(other);
    }
    layout(&app, &win);
    broadcast(&app);
    Ok(())
}

#[tauri::command]
async fn split_close(app: AppHandle, webview: Webview) {
    let win = caller_win(&webview);
    if let Some(w) = state(&app).windows.get_mut(&win) {
        w.split = None;
    }
    layout(&app, &win);
    broadcast(&app);
}

// ---------------------------------------------------------------- liste de lecture
/// Ajoute un onglet (l'onglet actif par défaut) à la liste de lecture.
#[tauri::command]
async fn read_later_add(app: AppHandle, webview: Webview, id: Option<u32>) -> Result<(), String> {
    let win = caller_win(&webview);
    read_later_add_in(app, win, id)
}

fn read_later_add_in(app: AppHandle, win: String, id: Option<u32>) -> Result<(), String> {
    close_popups(&app, &win);
    {
        let mut b = state(&app);
        let tid = id.or_else(|| b.windows.get(&win).and_then(|w| w.active)).ok_or("aucun onglet")?;
        let t = b.tabs.get(&tid).cloned().ok_or("onglet introuvable")?;
        if !t.url.starts_with("http") {
            return Err("pas de page web".into());
        }
        b.settings.read_later.retain(|r| r.url != t.url);
        b.settings.read_later.insert(0, ReadItem { url: t.url, title: t.title, favicon: t.favicon.chars().take(2048).collect(), added: now_secs() });
        b.settings.read_later.truncate(300);
    }
    save_settings(&app);
    let _ = app.emit("read-later", ());
    Ok(())
}

#[tauri::command]
async fn read_later_list(app: AppHandle) -> Vec<ReadItem> {
    state(&app).settings.read_later.clone()
}

#[tauri::command]
async fn read_later_remove(app: AppHandle, url: String) {
    state(&app).settings.read_later.retain(|r| r.url != url);
    save_settings(&app);
    let _ = app.emit("read-later", ());
}

// ---------------------------------------------------------------- notes par site
/// Note du site de l'onglet actif : { site, text }.
#[tauri::command]
async fn note_get(app: AppHandle, webview: Webview) -> serde_json::Value {
    let win = caller_win(&webview);
    let b = state(&app);
    let url = b.windows.get(&win).and_then(|w| w.active).and_then(|a| b.tabs.get(&a)).map(|t| t.url.clone()).unwrap_or_default();
    let site = site_of(&url);
    serde_json::json!({ "site": site, "text": b.settings.notes.get(&site).cloned().unwrap_or_default() })
}

#[tauri::command]
async fn note_set(app: AppHandle, site: String, text: String) {
    if site.is_empty() {
        return;
    }
    let text: String = text.chars().take(20000).collect();
    {
        let mut b = state(&app);
        if text.trim().is_empty() {
            b.settings.notes.remove(&site);
        } else {
            b.settings.notes.insert(site, text);
        }
    }
    save_settings(&app);
    broadcast(&app);
}

/// Petite fenêtre flottante générique (espaces, notes, dossier de favoris…).
#[tauri::command]
async fn popup_show(app: AppHandle, webview: Webview, kind: String, data: Option<serde_json::Value>, x: f64, y: f64) -> Result<(), String> {
    let win = caller_win(&webview);
    if !matches!(kind.as_str(), "spaces" | "notes" | "bmfolder" | "readlater") {
        return Err("menu inconnu".into());
    }
    close_popups(&app, &win);
    let mut d = data.filter(|v| v.is_object()).unwrap_or_else(|| serde_json::json!({}));
    let width = if kind == "notes" { 360.0 } else { 300.0 };
    d["kind"] = serde_json::Value::String(kind);
    open_popup(&app, &win, "popw", d, x, y, width, 360.0)
}

// ---------------------------------------------------------------- raccourcis clavier personnalisables
/// Actions disponibles : identifiant, libellé, touches par défaut.
const KEY_ACTIONS: &[(&str, &str, &str)] = &[
    ("new_tab", "Nouvel onglet", "Ctrl+T"),
    ("close_tab", "Fermer l’onglet", "Ctrl+W"),
    ("reopen_tab", "Rouvrir l’onglet fermé", "Ctrl+Shift+T"),
    ("private_window", "Nouvelle fenêtre privée", "Ctrl+Shift+N"),
    ("palette", "Palette de commandes", "Ctrl+K"),
    ("address", "Aller à la barre d’adresse", "Ctrl+L"),
    ("find", "Rechercher dans la page", "Ctrl+F"),
    ("history", "Historique", "Ctrl+H"),
    ("downloads", "Téléchargements", "Ctrl+J"),
    ("reader", "Mode lecture", "Alt+R"),
    ("ai_panel", "Panneau IA", "Ctrl+Shift+A"),
    ("screenshot", "Capture d’écran", "Ctrl+Shift+S"),
    ("split", "Vue côte à côte", "Alt+S"),
    ("notes", "Notes du site", "Alt+N"),
    ("read_later", "Lire plus tard", "Alt+L"),
    ("space_next", "Espace suivant", "Alt+PageDown"),
    ("space_prev", "Espace précédent", "Alt+PageUp"),
    ("mute_tab", "Couper / remettre le son de l’onglet", "Alt+M"),
    ("pip", "Vidéo en lecteur flottant", "Alt+P"),
    ("fullscreen", "Plein écran", "F11"),
];

fn key_of(b: &Browser, action: &str) -> String {
    b.settings.keys.get(action).cloned().unwrap_or_else(|| KEY_ACTIONS.iter().find(|a| a.0 == action).map(|a| a.2.to_string()).unwrap_or_default())
}

/// Touches → action, pour la barre du navigateur et les pages.
fn keymap(b: &Browser) -> serde_json::Map<String, serde_json::Value> {
    let mut m = serde_json::Map::new();
    for (id, _, _) in KEY_ACTIONS {
        let k = key_of(b, id);
        if !k.is_empty() {
            m.insert(k, serde_json::Value::String(id.to_string()));
        }
    }
    m
}

fn keys_js(app: &AppHandle) -> String {
    let b = state(app);
    format!(
        "window.__corrtexKeys && window.__corrtexKeys({}, {})",
        serde_json::Value::Object(keymap(&b)),
        b.settings.gestures
    )
}

fn apply_keys(app: &AppHandle) {
    let js = keys_js(app);
    let ids: Vec<u32> = state(app).tabs.keys().copied().collect();
    for id in ids {
        if let Some(wv) = app.get_webview(&tab_label(id)) {
            let _ = wv.eval(&js);
        }
    }
    let map = serde_json::Value::Object(keymap(&state(app)));
    let _ = app.emit("keys-changed", map);
}

#[tauri::command]
async fn keys_get(app: AppHandle) -> serde_json::Value {
    let b = state(&app);
    let list: Vec<serde_json::Value> = KEY_ACTIONS
        .iter()
        .map(|(id, label, def)| serde_json::json!({ "id": id, "label": label, "default": def, "keys": key_of(&b, id) }))
        .collect();
    serde_json::json!({ "actions": list, "map": serde_json::Value::Object(keymap(&b)), "gestures": b.settings.gestures })
}

/// Change les touches d'une action (`keys` vide : touches par défaut). Une combinaison déjà
/// utilisée par une autre action lui est retirée.
#[tauri::command]
async fn keys_set(app: AppHandle, action: String, keys: Option<String>) -> Result<(), String> {
    if !KEY_ACTIONS.iter().any(|a| a.0 == action) {
        return Err("action inconnue".into());
    }
    let keys = keys.map(|k| k.trim().chars().take(40).collect::<String>()).filter(|k| !k.is_empty());
    {
        let mut b = state(&app);
        match keys {
            // « none » : aucun raccourci pour cette action
            Some(k) if k == "none" => {
                b.settings.keys.insert(action, String::new());
            }
            Some(k) => {
                let others: Vec<&str> = KEY_ACTIONS.iter().map(|a| a.0).filter(|a| *a != action && key_of(&b, a) == k).collect();
                for o in others {
                    b.settings.keys.insert(o.to_string(), String::new());
                }
                b.settings.keys.insert(action, k);
            }
            None => {
                b.settings.keys.remove(&action);
            }
        }
    }
    save_settings(&app);
    apply_keys(&app);
    Ok(())
}

#[tauri::command]
async fn set_gestures(app: AppHandle, on: bool) {
    state(&app).settings.gestures = on;
    save_settings(&app);
    apply_keys(&app);
}

/// Exécute une action (raccourci clavier, geste de la souris).
fn run_action(app: &AppHandle, win: &str, action: &str) {
    let active = state(app).windows.get(win).and_then(|w| w.active);
    let chrome = app.get_webview(&format!("chrome-{win}"));
    let r: Result<(), String> = match action {
        "new_tab" => create_tab(app, win, None).map(|_| ()),
        "close_tab" => {
            if let Some(a) = active {
                close(app, a);
            }
            Ok(())
        }
        "reopen_tab" => reopen_closed_in(app, win),
        "private_window" => open_private_window(app).map(|_| ()),
        "palette" => palette_in(app, win),
        "address" => {
            if let Some(c) = &chrome {
                let _ = c.set_focus();
                let _ = app.emit_to(format!("chrome-{win}").as_str(), "focus-omnibox", win.to_string());
            }
            Ok(())
        }
        "find" => eval_active(app, win, "window.__corrtexFind && window.__corrtexFind()"),
        "history" => open_library_in(app, win, "history"),
        "downloads" => open_library_in(app, win, "downloads"),
        "reader" => eval_active(app, win, "window.__corrtexReader && window.__corrtexReader()"),
        "ai_panel" => {
            if let Some(c) = chrome.clone() {
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = toggle_sidebar(app2, c).await;
                });
            }
            Ok(())
        }
        "screenshot" => capture_start(app, win, "area"),
        "split" => {
            let open = state(app).windows.get(win).and_then(|w| w.split).is_some();
            if open {
                if let Some(w) = state(app).windows.get_mut(win) {
                    w.split = None;
                }
                layout(app, win);
                broadcast(app);
                Ok(())
            } else {
                split_open_in(app.clone(), win.to_string(), None)
            }
        }
        "notes" => {
            let _ = app.emit_to(format!("chrome-{win}").as_str(), "open-notes", win.to_string());
            Ok(())
        }
        "read_later" => read_later_add_in(app.clone(), win.to_string(), None),
        "space_next" | "space_prev" => {
            let next = {
                let b = state(app);
                b.windows.get(win).and_then(|w| {
                    let ids: Vec<u32> = if w.spaces.is_empty() { vec![0] } else { w.spaces.iter().map(|s| s.id).collect() };
                    let i = ids.iter().position(|s| *s == w.space).unwrap_or(0) as i32;
                    let d = if action == "space_next" { 1 } else { -1 };
                    ids.get(((i + d).rem_euclid(ids.len() as i32)) as usize).copied()
                })
            };
            match next {
                Some(sp) => space_do(app.clone(), win.to_string(), "switch".into(), Some(sp), None, None),
                None => Ok(()),
            }
        }
        "mute_tab" => {
            if let Some(a) = active {
                tab_mute_in(app, a);
            }
            Ok(())
        }
        "pip" => eval_active(app, win, "window.__corrtexPip && window.__corrtexPip()"),
        "fullscreen" => {
            toggle_fullscreen_win(app, win);
            Ok(())
        }
        _ => Ok(()),
    };
    if let Err(e) = r {
        debug_log(&format!("action {action} : {e}"));
    }
}

#[tauri::command]
async fn run_action_cmd(app: AppHandle, webview: Webview, action: String) {
    let win = caller_win(&webview);
    run_action(&app, &win, &action);
}

// ---------------------------------------------------------------- son par onglet
/// Coupe ou remet le son d'un onglet (moteur WebView2, et par sécurité les vidéos de la page).
fn tab_mute_in(app: &AppHandle, id: u32) {
    let muted = {
        let mut b = state(app);
        let Some(t) = b.tabs.get_mut(&id) else { return };
        t.muted = !t.muted;
        t.muted
    };
    if let Some(wv) = app.get_webview(&tab_label(id)) {
        let _ = wv.eval(&format!("window.__corrtexMute && window.__corrtexMute({muted})"));
        #[cfg(windows)]
        {
            let _ = wv.with_webview(move |pw| {
                use windows_core::Interface;
                if let Ok(core) = unsafe { pw.controller().CoreWebView2() } {
                    if let Ok(c8) = core.cast::<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8>() {
                        let _ = unsafe { c8.SetIsMuted(muted) };
                    }
                }
            });
        }
    }
    broadcast(app);
}

#[tauri::command]
async fn tab_mute(app: AppHandle, id: u32) {
    tab_mute_in(&app, id);
}

// ---------------------------------------------------------------- capture d'écran
/// « visible » : la partie affichée ; « full » : toute la page ; « area » : une zone choisie à la souris.
fn capture_start(app: &AppHandle, win: &str, mode: &str) -> Result<(), String> {
    close_popups(app, win);
    let id = state(app).windows.get(win).and_then(|w| w.active).ok_or("aucun onglet")?;
    if state(app).tabs.get(&id).map(|t| t.url.is_empty()).unwrap_or(true) {
        return Err("pas de page web".into());
    }
    match mode {
        // la page affiche un calque de sélection, puis renvoie la zone (« capture_area »)
        "area" => eval_active(app, win, "window.__corrtexCaptureArea && window.__corrtexCaptureArea()"),
        "full" => {
            cdp_capture(app, id, true, None);
            Ok(())
        }
        _ => {
            cdp_capture(app, id, false, None);
            Ok(())
        }
    }
}

#[tauri::command]
async fn capture_page(app: AppHandle, webview: Webview, mode: String) -> Result<(), String> {
    let win = caller_win(&webview);
    capture_start(&app, &win, &mode)
}

/// Image prête : ouverte dans l'éditeur de capture (nouvel onglet).
#[cfg_attr(not(windows), allow(dead_code))]
fn capture_done(app: &AppHandle, tab: u32, data: String, crop: Option<serde_json::Value>) {
    let Some(win) = win_of_tab(app, tab) else { return };
    let title = state(app).tabs.get(&tab).map(|t| t.title.clone()).unwrap_or_default();
    let n = {
        let mut b = state(app);
        b.next_capture += 1;
        let n = b.next_capture;
        b.captures.insert(n, serde_json::json!({ "data": data, "crop": crop, "title": title }));
        // on ne garde que les dernières
        let old: Vec<u32> = b.captures.keys().copied().filter(|k| *k + 5 < n).collect();
        for k in old {
            b.captures.remove(&k);
        }
        n
    };
    let id = add_tab_record(&mut state(app), &win, String::new(), "Capture d’écran".into(), String::new(), None, false);
    if let Some(t) = state(app).tabs.get_mut(&id) {
        t.page = format!("capture.html#{n}");
    }
    if spawn_tab_view(app, id).is_ok() {
        activate(app, id);
    }
}

#[tauri::command]
async fn capture_get(app: AppHandle, id: u32) -> serde_json::Value {
    state(&app).captures.get(&id).cloned().unwrap_or(serde_json::Value::Null)
}

#[cfg(windows)]
fn cdp_capture(app: &AppHandle, tab: u32, full: bool, crop: Option<serde_json::Value>) {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows_core::{HSTRING, PCWSTR};
    let Some(wv) = app.get_webview(&tab_label(tab)) else { return };
    let app = app.clone();
    let _ = wv.with_webview(move |pw| {
        let Ok(core) = (unsafe { pw.controller().CoreWebView2() }) else { return };
        // capture puis ouverture de l'éditeur
        let shoot = move |core: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2, params: String, app: AppHandle, crop: Option<serde_json::Value>| {
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |hr, json| {
                if hr.is_ok() {
                    if let Some(d) = serde_json::from_str::<serde_json::Value>(&json).ok().and_then(|v| v.get("data").and_then(|d| d.as_str()).map(|s| s.to_string())) {
                        let app2 = app.clone();
                        tauri::async_runtime::spawn(async move { capture_done(&app2, tab, d, crop) });
                    }
                }
                Ok(())
            }));
            let m = HSTRING::from("Page.captureScreenshot");
            let p = HSTRING::from(params.as_str());
            let _ = unsafe { core.CallDevToolsProtocolMethod(PCWSTR(m.as_ptr()), PCWSTR(p.as_ptr()), &handler) };
        };
        if !full {
            shoot(core, r#"{"format":"png"}"#.to_string(), app, crop);
            return;
        }
        // page entière : taille du contenu d'abord
        let core2 = core.clone();
        let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |hr, json| {
            let size = if hr.is_ok() { serde_json::from_str::<serde_json::Value>(&json).ok() } else { None };
            let (w, h) = size
                .as_ref()
                .and_then(|v| v.get("cssContentSize").or_else(|| v.get("contentSize")))
                .map(|c| (c.get("width").and_then(|x| x.as_f64()).unwrap_or(1280.0), c.get("height").and_then(|x| x.as_f64()).unwrap_or(800.0)))
                .unwrap_or((1280.0, 800.0));
            let h = h.min(16000.0);
            let params = format!(r#"{{"format":"png","captureBeyondViewport":true,"clip":{{"x":0,"y":0,"width":{w},"height":{h},"scale":1}}}}"#);
            shoot(core2, params, app, None);
            Ok(())
        }));
        let m = HSTRING::from("Page.getLayoutMetrics");
        let p = HSTRING::from("{}");
        let _ = unsafe { core.CallDevToolsProtocolMethod(PCWSTR(m.as_ptr()), PCWSTR(p.as_ptr()), &handler) };
    });
}

/// macOS : capture de la partie affichée de l'onglet avec l'outil système `screencapture`
/// (WKWebView n'a pas d'équivalent au protocole DevTools ; la page entière n'est pas possible).
/// La première fois, macOS demande l'autorisation « Enregistrement de l'écran ».
#[cfg(target_os = "macos")]
fn cdp_capture(app: &AppHandle, tab: u32, _full: bool, crop: Option<serde_json::Value>) {
    let Some(wv) = app.get_webview(&tab_label(tab)) else { return };
    let win = wv.window();
    let (Ok(inner), Ok(pos), Ok(size), Ok(scale)) = (win.inner_position(), wv.position(), wv.size(), win.scale_factor()) else { return };
    // screencapture travaille en points (pixels logiques) de l'écran
    let rect = format!(
        "{:.0},{:.0},{:.0},{:.0}",
        (inner.x + pos.x) as f64 / scale,
        (inner.y + pos.y) as f64 / scale,
        size.width as f64 / scale,
        size.height as f64 / scale
    );
    let app = app.clone();
    std::thread::spawn(move || {
        // le calque de sélection de zone a le temps de disparaître
        std::thread::sleep(Duration::from_millis(180));
        let file = std::env::temp_dir().join(format!("corrtex-capture-{tab}.png"));
        let ok = std::process::Command::new("screencapture")
            .args(["-x", "-t", "png", "-R", &rect])
            .arg(&file)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        let Ok(bytes) = std::fs::read(&file) else { return };
        let _ = std::fs::remove_file(&file);
        if !ok || bytes.is_empty() {
            return;
        }
        let data = base64_encode(&bytes);
        tauri::async_runtime::spawn(async move { capture_done(&app, tab, data, crop) });
    });
}

#[cfg(target_os = "macos")]
fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(not(any(windows, target_os = "macos")))]
fn cdp_capture(_app: &AppHandle, _tab: u32, _full: bool, _crop: Option<serde_json::Value>) {}

// ---------------------------------------------------------------- mode concentration
fn focus_blocks(app: &AppHandle, url: &str) -> bool {
    let b = state(app);
    if !b.focus_until.map(|u| u > Instant::now()).unwrap_or(false) {
        return false;
    }
    let site = site_of(url);
    !site.is_empty() && b.settings.focus_sites.iter().any(|s| site == *s || site.ends_with(&format!(".{s}")))
}

fn relayout_all(app: &AppHandle) {
    let wins: Vec<String> = state(app).windows.keys().cloned().collect();
    for w in wins {
        layout(app, &w);
    }
    broadcast(app);
}

/// Démarre le mode concentration pour `minutes` : barre réduite, sites qui distraient bloqués.
#[tauri::command]
async fn focus_start(app: AppHandle, minutes: u64) {
    let m = minutes.clamp(5, 480);
    state(&app).focus_until = Some(Instant::now() + Duration::from_secs(m * 60));
    relayout_all(&app);
    // les onglets déjà ouverts sur un site bloqué sont remplacés
    let open: Vec<(u32, String)> = state(&app).tabs.values().map(|t| (t.id, t.url.clone())).collect();
    for (id, url) in open {
        if focus_blocks(&app, &url) {
            if let (Some(wv), Some(win)) = (app.get_webview(&tab_label(id)), win_of_tab(&app, id)) {
                if let Some(target) = internal_url(&app, &win, "/focus.html", &format!("s={}", form_enc(&site_of(&url)))) {
                    let _ = wv.navigate(target);
                }
            }
        }
    }
    let _ = app.emit("focus-changed", true);
}

#[tauri::command]
async fn focus_stop(app: AppHandle) {
    state(&app).focus_until = None;
    relayout_all(&app);
    let _ = app.emit("focus-changed", false);
}

#[tauri::command]
async fn focus_info(app: AppHandle) -> serde_json::Value {
    let b = state(&app);
    let left = b.focus_until.and_then(|u| u.checked_duration_since(Instant::now())).map(|d| d.as_secs());
    serde_json::json!({ "sites": b.settings.focus_sites, "left": left })
}

#[tauri::command]
async fn focus_sites_set(app: AppHandle, sites: Vec<String>) {
    let clean: Vec<String> = sites
        .into_iter()
        .map(|s| {
            let s = s.trim().to_lowercase();
            let s = s.trim_start_matches("https://").trim_start_matches("http://").trim_start_matches("www.");
            s.split('/').next().unwrap_or("").to_string()
        })
        .filter(|s| s.contains('.') && s.len() < 80)
        .take(100)
        .collect();
    state(&app).settings.focus_sites = clean;
    save_settings(&app);
}

/// Fin du mode concentration (vérifiée régulièrement) et compte à rebours de la barre.
fn focus_tick(app: &AppHandle) {
    let ended = {
        let mut b = state(app);
        match b.focus_until {
            Some(u) if u <= Instant::now() => {
                b.focus_until = None;
                true
            }
            _ => false,
        }
    };
    if ended {
        relayout_all(app);
        let _ = app.emit("focus-changed", false);
    } else if state(app).focus_until.is_some() {
        broadcast(app);
    }
}

// ---------------------------------------------------------------- économie d'énergie
fn power_saver(b: &Browser) -> bool {
    match b.settings.power_mode.as_str() {
        "on" => true,
        "off" => false,
        _ => b.on_battery,
    }
}

/// État de la batterie, envoyé par la barre du navigateur.
#[tauri::command]
async fn power_state(app: AppHandle, on_battery: bool) {
    let changed = {
        let mut b = state(&app);
        let before = power_saver(&b);
        b.on_battery = on_battery;
        before != power_saver(&b)
    };
    if changed {
        broadcast(&app);
        let saver = power_saver(&state(&app));
        let _ = app.emit("power-saver", saver);
    }
}

#[tauri::command]
async fn set_power_mode(app: AppHandle, mode: String) {
    let m = if matches!(mode.as_str(), "on" | "off") { mode } else { "auto".into() };
    state(&app).settings.power_mode = m;
    save_settings(&app);
    broadcast(&app);
    let saver = power_saver(&state(&app));
    let _ = app.emit("power-saver", saver);
}

/// Onglets cachés : le moteur réduit leur mémoire (les pages restent ouvertes).
fn memory_hint(app: &AppHandle, id: u32, visible: bool) {
    #[cfg(windows)]
    {
        if let Some(wv) = app.get_webview(&tab_label(id)) {
            let _ = wv.with_webview(move |pw| {
                use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL};
                use windows_core::Interface;
                if let Ok(core) = unsafe { pw.controller().CoreWebView2() } {
                    if let Ok(c19) = core.cast::<ICoreWebView2_19>() {
                        let level = if visible { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW };
                        let _ = unsafe { c19.SetMemoryUsageTargetLevel(level) };
                    }
                }
            });
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, id, visible);
    }
}

// ---------------------------------------------------------------- profils
#[tauri::command]
async fn profile_list(app: AppHandle) -> Vec<Profile> {
    let mut v = vec![Profile { id: 0, name: "Principal".into(), color: "#9aa0a6".into() }];
    v.extend(state(&app).settings.profiles.iter().cloned());
    v
}

#[tauri::command]
async fn profile_create(app: AppHandle, name: String) -> Result<Profile, String> {
    let name: String = name.trim().chars().take(30).collect();
    if name.is_empty() {
        return Err("nom vide".into());
    }
    let p = {
        let mut b = state(&app);
        let id = b.settings.profiles.iter().map(|p| p.id).max().unwrap_or(0) + 1;
        let n = b.settings.profiles.len();
        let p = Profile { id, name, color: SPACE_COLORS[n % SPACE_COLORS.len()].into() };
        b.settings.profiles.push(p.clone());
        p
    };
    save_settings(&app);
    Ok(p)
}

/// Supprime un profil et ses données (connexions, cookies).
#[tauri::command]
async fn profile_delete(app: AppHandle, id: u32) -> Result<(), String> {
    if id == 0 {
        return Err("le profil Principal ne peut pas être supprimé".into());
    }
    if state(&app).windows.values().any(|w| w.profile == id) {
        return Err("fermez d'abord les fenêtres de ce profil".into());
    }
    state(&app).settings.profiles.retain(|p| p.id != id);
    save_settings(&app);
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::remove_dir_all(dir.join("profiles").join(format!("p{id}")));
    }
    Ok(())
}

fn open_profile_window_in(app: &AppHandle, id: u32) -> Result<String, String> {
    let name = if id == 0 { "Principal".to_string() } else { state(app).settings.profiles.iter().find(|p| p.id == id).map(|p| p.name.clone()).ok_or("profil inconnu")? };
    let win = create_window(app, None, None)?;
    if let Some(w) = state(app).windows.get_mut(&win) {
        w.profile = id;
    }
    if let Some(w) = app.get_window(&win) {
        if id != 0 {
            let _ = w.set_title(&format!("Corrtex — {name}"));
        }
    }
    create_tab(app, &win, None)?;
    broadcast(app);
    Ok(win)
}

#[tauri::command]
async fn open_profile_window(app: AppHandle, id: u32) -> Result<(), String> {
    open_profile_window_in(&app, id).map(|_| ())
}


#[tauri::command]
async fn app_info(app: AppHandle) -> serde_json::Value {
    let b = state(&app);
    let v = app.package_info().version.to_string();
    serde_json::json!({
        "version": v,
        "updated": !b.settings.last_version.is_empty() && b.settings.last_version != v,
        "first": b.settings.last_version.is_empty(),
        "update_repo": b.settings.update_repo,
        "power_mode": b.settings.power_mode,
        "auto_update": b.settings.auto_update,
        "keep_running": b.settings.keep_running,
        "ai_native": b.settings.ai_native,
        "power_saver": power_saver(&b),
        "on_battery": b.on_battery,
    })
}

#[tauri::command]
async fn version_seen(app: AppHandle) {
    let v = app.package_info().version.to_string();
    state(&app).settings.last_version = v;
    save_settings(&app);
}

#[tauri::command]
async fn set_update_repo(app: AppHandle, repo: String) -> Result<(), String> {
    let r = repo.trim().trim_start_matches("https://github.com/").trim_end_matches('/').to_string();
    if !r.is_empty() && !(r.split('/').count() == 2 && r.chars().all(|c| c.is_ascii_alphanumeric() || "-_./".contains(c))) {
        return Err("format attendu : propriétaire/projet".into());
    }
    state(&app).settings.update_repo = r;
    save_settings(&app);
    Ok(())
}

/// Dernière version publiée sur GitHub : { available, version, url, notes }.
// ---------------------------------------------------------------- mises à jour automatiques
// Les versions sont publiées sur github.com/Xera-Dev/Corrtex (fichier latest.json signé) :
// Corrtex vérifie peu après le démarrage puis toutes les 6 heures, et installe en un clic.
const UPDATE_FIRST: Duration = Duration::from_secs(4);
const UPDATE_EVERY: Duration = Duration::from_secs(6 * 3600);

async fn find_update(app: &AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    use tauri_plugin_updater::UpdaterExt;
    app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())
}

fn set_update_available(app: &AppHandle, version: Option<String>) {
    let changed = {
        let mut b = state(app);
        if b.update_version != version {
            b.update_version = version.clone();
            true
        } else {
            false
        }
    };
    if changed {
        let _ = app.emit("update-status", serde_json::json!({ "version": version }));
    }
}

fn update_watch(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(UPDATE_FIRST);
        let mut first = true;
        loop {
            let a = app.clone();
            let launch = first;
            tauri::async_runtime::block_on(async move {
                if let Ok(up) = find_update(&a).await {
                    let found = up.is_some();
                    set_update_available(&a, up.map(|u| u.version));
                    // au lancement, avec « Mises à jour automatiques » : installée tout de suite
                    let auto = state(&a).settings.auto_update;
                    if found && launch && auto {
                        let _ = install_update(&a).await;
                    }
                }
            });
            first = false;
            std::thread::sleep(UPDATE_EVERY);
        }
    });
}

#[tauri::command]
async fn update_check(app: AppHandle) -> Result<serde_json::Value, String> {
    let current = app.package_info().version.to_string();
    let up = find_update(&app).await.map_err(|e| format!("Vérification impossible : {e}"))?;
    let version = up.as_ref().map(|u| u.version.clone());
    set_update_available(&app, version.clone());
    Ok(serde_json::json!({
        "available": up.is_some(),
        "version": version.unwrap_or_default(),
        "current": current,
        "notes": up.and_then(|u| u.body).unwrap_or_default().chars().take(4000).collect::<String>(),
    }))
}

/// Version disponible connue (barre du navigateur au chargement).
#[tauri::command]
async fn update_status(app: AppHandle) -> Option<String> {
    state(&app).update_version.clone()
}

/// Télécharge et installe la nouvelle version, puis redémarre Corrtex (session enregistrée avant).
#[tauri::command]
async fn update_install(app: AppHandle) -> Result<(), String> {
    install_update(&app).await
}

async fn install_update(app: &AppHandle) -> Result<(), String> {
    let app = app.clone();
    {
        let mut b = state(&app);
        if b.updating {
            return Err("Mise à jour déjà en cours.".into());
        }
        b.updating = true;
    }
    let res: Result<(), String> = async {
        let up = find_update(&app).await?.ok_or_else(|| "Corrtex est déjà à jour.".to_string())?;
        save_session(&app);
        save_history(&app);
        let a = app.clone();
        let (mut done, mut last) = (0u64, u64::MAX);
        up.download_and_install(
            move |chunk, total| {
                done += chunk as u64;
                let pct = total.filter(|t| *t > 0).map(|t| done * 100 / t).unwrap_or(0);
                if pct != last {
                    last = pct;
                    let _ = a.emit("update-progress", serde_json::json!({ "pct": pct }));
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())
    }
    .await;
    state(&app).updating = false;
    if let Err(e) = res {
        let _ = app.emit("update-progress", serde_json::json!({ "error": e }));
        return Err(e);
    }
    app.restart()
}

// ---------------------------------------------------------------- mémoire des conversations par site

fn site_of(url: &str) -> String {
    tauri::Url::parse(url)
        .ok()
        .filter(|u| u.scheme() == "https" || u.scheme() == "http")
        .and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string()))
        .unwrap_or_default()
}

/// Adresse d'une conversation (et non de l'accueil) de l'IA choisie.
fn is_conversation(provider_url: &str, url: &str) -> bool {
    let (Ok(p), Ok(u)) = (tauri::Url::parse(provider_url), tauri::Url::parse(url)) else { return false };
    if p.host_str() != u.host_str() {
        return false;
    }
    let path = u.path();
    let id_after = |prefix: &str| path.strip_prefix(prefix).map(|rest| rest.trim_matches('/').len() >= 6).unwrap_or(false);
    id_after("/chat/") || id_after("/c/") || id_after("/app/")
}

/// Nouveau site dans la fenêtre : le panneau IA rouvre sa conversation, ou une nouvelle
/// discussion. Renvoie vrai si la page de l'IA a été rechargée.
fn memory_switch(app: &AppHandle, win: &str, site: &str, ai: &Webview, cur: &str, home: &str) -> bool {
    let target = state(app).settings.ai_chats.get(site).cloned().filter(|u| is_conversation(home, u));
    if let Some(w) = state(app).windows.get_mut(win) {
        w.ai_site = site.to_string();
        w.ai_site_at = Some(Instant::now());
    }
    let go = match target {
        Some(t) if t != cur => Some(t),
        None if is_conversation(home, cur) => Some(home.to_string()),
        _ => None,
    };
    match go.and_then(|u| u.parse().ok()) {
        Some(u) => ai.navigate(u).is_ok(),
        None => false,
    }
}

/// Avant d'envoyer un message : le panneau affiche-t-il bien la conversation du site ouvert ?
/// Renvoie vrai si la page de l'IA se recharge (le message attendra la fin du chargement).
fn memory_sync_before_send(app: &AppHandle, win: &str, ai: &Webview) -> bool {
    let (on, home, site, ai_site) = {
        let b = state(app);
        let w = b.windows.get(win);
        let site = w.and_then(|w| w.active).and_then(|id| b.tabs.get(&id)).map(|t| site_of(&t.url)).unwrap_or_default();
        (b.settings.ai_memory, provider(&b.settings.ai_provider).url.to_string(), site, w.map(|w| w.ai_site.clone()).unwrap_or_default())
    };
    if !on || site.is_empty() || ai_site.is_empty() || site == ai_site {
        return false;
    }
    let cur = ai.url().map(|u| u.to_string()).unwrap_or_default();
    memory_switch(app, win, &site, ai, &cur, &home)
}

/// Appelée toutes les 2 s : retient la conversation du site ouvert, et rouvre celle
/// du nouveau site quand on change d'onglet ou de site.
fn ai_memory_tick(app: &AppHandle) {
    let (on, home) = {
        let b = state(app);
        (b.settings.ai_memory, provider(&b.settings.ai_provider).url.to_string())
    };
    if !on {
        return;
    }
    let wins: Vec<(String, String, String, Option<Instant>)> = {
        let b = state(app);
        b.windows
            .iter()
            .filter(|(_, w)| w.sidebar_open && w.ai_created && !w.private)
            .map(|(l, w)| {
                let site = w.active.and_then(|id| b.tabs.get(&id)).map(|t| site_of(&t.url)).unwrap_or_default();
                (l.clone(), site, w.ai_site.clone(), w.ai_site_at)
            })
            .collect()
    };
    for (win, site, ai_site, at) in wins {
        if site.is_empty() {
            continue; // page d'accueil : on garde la conversation affichée
        }
        let Some(ai) = app.get_webview(&format!("ai-{win}")) else { continue };
        let Ok(cur) = ai.url() else { continue };
        let cur = cur.to_string();
        if ai_site.is_empty() {
            // première fois : la conversation affichée devient celle de ce site
            if let Some(w) = state(app).windows.get_mut(&win) {
                w.ai_site = site.clone();
                w.ai_site_at = Some(Instant::now());
            }
            continue;
        }
        if site != ai_site {
            memory_switch(app, &win, &site, &ai, &cur, &home);
            continue;
        }
        // même site : on retient sa conversation (après un court délai suivant un changement)
        let settled = at.map(|t| t.elapsed() > Duration::from_secs(3)).unwrap_or(true);
        if settled && is_conversation(&home, &cur) {
            let changed = {
                let mut b = state(app);
                if b.settings.ai_chats.get(&site) != Some(&cur) {
                    if b.settings.ai_chats.len() >= 300 && !b.settings.ai_chats.contains_key(&site) {
                        if let Some(k) = b.settings.ai_chats.keys().next().cloned() {
                            b.settings.ai_chats.remove(&k);
                        }
                    }
                    b.settings.ai_chats.insert(site.clone(), cur.clone());
                    true
                } else {
                    false
                }
            };
            if changed {
                save_settings(app);
            }
        }
    }
}

// ---------------------------------------------------------------- style Corrtex dans la page de l'IA
fn ai_skin_js(app: &AppHandle) -> String {
    let b = state(app);
    // le script complet est renvoyé à chaque fois : certains sites (ChatGPT, Claude)
    // reconstruisent leur page au démarrage et perdent le script injecté au chargement
    format!(
        "{}\n;window.__corrtexSkin && window.__corrtexSkin({}, {})",
        AI_SCRIPT,
        serde_json::to_string(&b.ai_theme).unwrap_or_else(|_| "null".into()),
        b.settings.ai_skin
    )
}

fn apply_ai_skin_to(wv: &Webview) {
    let js = ai_skin_js(wv.app_handle());
    let _ = wv.eval(&js);
}

fn apply_ai_skin(app: &AppHandle) {
    let js = ai_skin_js(app);
    for (label, wv) in app.webviews() {
        if label.starts_with("ai-") {
            let _ = wv.eval(&js);
        }
    }
}

/// Pages de recherche Google (www.google.*) : reçoivent le style Corrtex.
fn is_google_search(url: &str) -> bool {
    tauri::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| u.scheme() == "https" && h.starts_with("www.google.")))
        .unwrap_or(false)
}

fn google_skin_js(app: &AppHandle) -> String {
    let b = state(app);
    let on = b.ai_theme.get("google").and_then(|v| v.as_str()) != Some("off");
    format!(
        "{}\n;window.__corrtexGoogle && window.__corrtexGoogle({}, {}, {})",
        GOOGLE_SKIN,
        serde_json::to_string(&b.ai_theme).unwrap_or_else(|_| "null".into()),
        on,
        // profil Google connu de Corrtex : la page affiche la même photo et le même panneau
        serde_json::to_string(&b.google).unwrap_or_else(|_| "null".into())
    )
}

fn apply_google_skin(app: &AppHandle) {
    let js = google_skin_js(app);
    for (label, wv) in app.webviews() {
        if label.starts_with("tab-") && wv.url().map(|u| is_google_search(u.as_str())).unwrap_or(false) {
            let _ = wv.eval(&js);
        }
    }
}

/// Couleurs du thème (envoyées par l'interface quand le thème change).
#[tauri::command]
async fn set_ai_theme(app: AppHandle, theme: serde_json::Value) {
    // seulement des couleurs simples : pas de texte arbitraire injecté dans la page
    let ok = theme.as_object().map(|o| o.values().all(|v| v.as_str().map(|c| c.len() < 64 && c.chars().all(|ch| ch.is_ascii_alphanumeric() || " #(),.%-".contains(ch))).unwrap_or(false))).unwrap_or(false);
    if !ok {
        return;
    }
    state(&app).ai_theme = theme;
    apply_ai_skin(&app);
    apply_google_skin(&app);
    apply_page_theme(&app);
}

/// Couleurs du thème transmises aux pages (menu du clic droit, bulle de réponse, mode lecture…).
fn page_theme_js(app: &AppHandle) -> String {
    let t = state(app).ai_theme.clone();
    format!("window.__corrtexTheme && window.__corrtexTheme({})", serde_json::to_string(&t).unwrap_or_else(|_| "null".into()))
}

fn apply_page_theme(app: &AppHandle) {
    let js = page_theme_js(app);
    let ids: Vec<u32> = state(app).tabs.keys().copied().collect();
    for id in ids {
        if let Some(wv) = app.get_webview(&tab_label(id)) {
            let _ = wv.eval(&js);
        }
    }
}

#[tauri::command]
async fn toggle_ai_skin(app: AppHandle) {
    {
        let mut b = state(&app);
        b.settings.ai_skin = !b.settings.ai_skin;
    }
    save_settings(&app);
    apply_ai_skin(&app);
    broadcast(&app);
}

// ---------------------------------------------------------------- profil Google
/// Ouvre brièvement google.com dans une vue invisible pour lire la photo, le nom et
/// l'e-mail du compte connecté (les cookies sont partagés avec les onglets), puis la ferme.
fn probe_google(app: &AppHandle) {
    {
        let mut b = state(app);
        if b.probing {
            return;
        }
        b.probing = true;
        b.last_probe = Some(Instant::now());
    }
    let Some(window) = app.windows().into_values().next() else {
        state(app).probing = false;
        return;
    };
    let builder = web("gprobe", WebviewUrl::External("https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard".parse().unwrap()))
        .initialization_script(GOOGLE_SCRIPT)
        .on_download(|_, _| false)
        .focused(false);
    match window.add_child(builder, LogicalPosition::new(-6000.0, -6000.0), LogicalSize::new(1024.0, 700.0)) {
        Ok(wv) => {
            let _ = wv.hide();
            // sécurité : on ferme la vue après 20 s quoi qu'il arrive
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio_sleep(Duration::from_secs(20)).await;
                finish_probe(&app);
            });
        }
        Err(_) => state(app).probing = false,
    }
}

fn finish_probe(app: &AppHandle) {
    if let Some(wv) = app.get_webview("gprobe") {
        let _ = wv.close();
    }
    state(app).probing = false;
}

fn schedule_google_probe(app: &AppHandle, delay: Duration) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio_sleep(delay).await;
        probe_google(&app);
    });
}

async fn tokio_sleep(d: Duration) {
    // petite attente sans dépendance supplémentaire
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

/// Journal de diagnostic, à côté de Corrtex.exe (corrtex-debug.log, limité à ~200 Ko).
fn debug_log(msg: &str) {
    // macOS : jamais dans Corrtex.app (modifier l'application casserait sa signature)
    #[cfg(target_os = "macos")]
    let Some(path) = std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join("Library/Logs/Corrtex")).and_then(|d| std::fs::create_dir_all(&d).ok().map(|_| d.join("corrtex-debug.log"))) else { return };
    #[cfg(not(target_os = "macos"))]
    let Some(path) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("corrtex-debug.log"))) else { return };
    if std::fs::metadata(&path).map(|m| m.len() > 200_000).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    use std::io::Write;
    eprintln!("[corrtex] {msg}");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "[{t}] {msg}");
    }
}

// ---------------------------------------------------------------- commandes (interface)
/// Dernière fenêtre de navigation qui a eu le focus.
static LAST_FOCUSED: Mutex<String> = Mutex::new(String::new());

fn caller_win(webview: &Webview) -> String {
    let label = webview.window().label().to_string();
    // liste de suggestions (fenêtre flottante "sugw-wN") : elle agit pour la fenêtre "wN"
    for p in ["sugw-", "popw-", "prvw-", "panw-"] {
        if let Some(w) = label.strip_prefix(p) {
            return w.to_string();
        }
    }
    // article détaché : ses liens s'ouvrent dans la dernière fenêtre de navigation utilisée
    if label.starts_with("reader-") {
        let app = webview.app_handle();
        let b = state(app);
        let last = LAST_FOCUSED.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(w) = Some(last).filter(|w| b.windows.contains_key(w)).or_else(|| b.windows.keys().next().cloned()) {
            return w;
        }
    }
    label
}

#[tauri::command]
async fn get_state(app: AppHandle, webview: Webview) -> Snapshot {
    snapshot(&state(&app), &caller_win(&webview))
}

#[tauri::command]
async fn new_tab(app: AppHandle, webview: Webview, url: Option<String>) -> Result<u32, String> {
    create_tab(&app, &caller_win(&webview), url)
}

#[tauri::command]
async fn close_tab(app: AppHandle, id: u32) {
    close(&app, id);
}

#[tauri::command]
async fn activate_tab(app: AppHandle, id: u32, focus: Option<bool>) {
    activate_with(&app, id, focus.unwrap_or(true));
}


#[tauri::command]
async fn move_tab(app: AppHandle, id: u32, index: usize) {
    // épinglés à gauche ; posé entre deux onglets d'un groupe, il en devient membre
    reorder(&app, id, index);
    broadcast(&app);
}

/// Début du glisser d'un onglet hors de sa barre : Corrtex suit ensuite la souris.
#[tauri::command]
async fn drag_detach(app: AppHandle, id: u32, grab_x: f64) {
    let _ = tauri::async_runtime::spawn_blocking(move || drag_loop(app, id, grab_x)).await;
}

#[tauri::command]
async fn navigate(app: AppHandle, webview: Webview, url: String) -> Result<(), String> {
    let win = caller_win(&webview);
    let parsed: tauri::Url = url.parse().map_err(|_| format!("URL invalide : {url}"))?;
    match active_webview(&app, &win) {
        Some(wv) => {
            wv.navigate(parsed).map_err(|e| e.to_string())?;
            let _ = wv.set_focus();
            // hors Windows : une nouvelle adresse efface « suivant »
            #[cfg(not(windows))]
            {
                let mut b = state(&app);
                let active = b.windows.get(&win).and_then(|w| w.active);
                if let Some(t) = active.and_then(|a| b.tabs.get_mut(&a)) {
                    t.can_fwd = false;
                }
            }
            Ok(())
        }
        None => create_tab(&app, &win, Some(url)).map(|_| ()),
    }
}

#[tauri::command]
async fn go_back(app: AppHandle, webview: Webview) {
    let win = caller_win(&webview);
    // page d'erreur : on saute aussi la page d'erreur du moteur qui la précède
    let on_error = {
        let b = state(&app);
        b.windows.get(&win).and_then(|w| w.active).and_then(|a| b.tabs.get(&a)).map(|t| t.error_page).unwrap_or(false)
    };
    if let Some(wv) = active_webview(&app, &win) {
        let _ = wv.eval(if on_error { "history.go(-2)" } else { "history.back()" });
    }
    // hors Windows : après un retour, « suivant » devient possible
    #[cfg(not(windows))]
    {
        let changed = {
            let mut b = state(&app);
            let active = b.windows.get(&win).and_then(|w| w.active);
            match active.and_then(|a| b.tabs.get_mut(&a)) {
                Some(t) if !t.can_fwd => {
                    t.can_fwd = true;
                    true
                }
                _ => false,
            }
        };
        if changed {
            broadcast(&app);
        }
    }
}

#[tauri::command]
async fn go_forward(app: AppHandle, webview: Webview) {
    if let Some(wv) = active_webview(&app, &caller_win(&webview)) {
        let _ = wv.eval("history.forward()");
    }
}

#[tauri::command]
async fn reload(app: AppHandle, webview: Webview) {
    let win = caller_win(&webview);
    // page d'erreur : on réessaie l'adresse qui n'avait pas pu s'ouvrir
    let retry = {
        let b = state(&app);
        b.windows.get(&win).and_then(|w| w.active).and_then(|a| b.tabs.get(&a)).filter(|t| t.error_page).map(|t| t.url.clone())
    };
    if let Some(wv) = active_webview(&app, &win) {
        match retry.and_then(|u| u.parse().ok()) {
            Some(u) => {
                let _ = wv.navigate(u);
            }
            None => {
                let _ = wv.reload();
            }
        }
    }
}

#[tauri::command]
async fn toggle_sidebar(app: AppHandle, webview: Webview) -> Result<(), String> {
    let win = caller_win(&webview);
    let open = {
        let mut b = state(&app);
        let Some(w) = b.windows.get_mut(&win) else { return Ok(()) };
        w.sidebar_open = !w.sidebar_open;
        let open = w.sidebar_open;
        b.settings.sidebar_open = open;
        open
    };
    if open {
        ensure_ai(&app, &win)?;
    }
    layout(&app, &win);
    save_settings(&app);
    broadcast(&app);
    Ok(())
}

#[tauri::command]
async fn set_ai_provider(app: AppHandle, id: String) -> Result<(), String> {
    let p = provider(&id);
    // les sessions cachées préparées pour l'ancienne IA ne servent plus
    quick_fresh().lock().unwrap_or_else(|e| e.into_inner()).clear();
    let wins: Vec<String> = {
        let mut b = state(&app);
        b.settings.ai_provider = p.id.to_string();
        b.windows.keys().cloned().collect()
    };
    save_settings(&app);
    for w in wins {
        if let Some(wv) = app.get_webview(&format!("ai-{w}")) {
            let _ = wv.navigate(p.url.parse().unwrap());
        }
    }
    broadcast(&app);
    Ok(())
}

#[tauri::command]
async fn refresh_google(app: AppHandle) {
    let recent = state(&app).last_probe.map(|t| t.elapsed() < Duration::from_secs(60)).unwrap_or(false);
    if !recent {
        probe_google(&app);
    }
}

const MEDIA_JS_TOGGLE: &str = r#"(()=>{
  const btn=document.querySelector('[data-testid="control-button-playpause"],#play-pause-button,.ytp-play-button');
  if(btn){btn.click();return}
  const els=[...document.querySelectorAll('video,audio')];
  const m=els.find(e=>!e.paused)||els.find(e=>e.currentTime>0)||els[0];
  if(m){m.paused?m.play():m.pause()}
})()"#;

const MEDIA_JS_NEXT: &str = r#"(()=>{
  const btn=document.querySelector('[data-testid="control-button-skip-forward"],.next-button,.ytp-next-button');
  if(btn){btn.click();return}
  const m=[...document.querySelectorAll('video,audio')].find(e=>e.currentTime>0);
  if(m&&isFinite(m.duration)){m.currentTime=Math.min(m.duration,m.currentTime+10)}
})()"#;

const MEDIA_JS_PREV: &str = r#"(()=>{
  const btn=document.querySelector('[data-testid="control-button-skip-back"],.previous-button,.ytp-prev-button');
  if(btn&&btn.offsetParent!==null){btn.click();return}
  const m=[...document.querySelectorAll('video,audio')].find(e=>e.currentTime>0);
  if(m){m.currentTime=0}
})()"#;

#[tauri::command]
async fn media_control(app: AppHandle, action: String) {
    let Some(tab) = state(&app).media.as_ref().map(|m| m.tab) else { return };
    let js = match action.as_str() {
        "toggle" => MEDIA_JS_TOGGLE,
        "next" => MEDIA_JS_NEXT,
        "prev" => MEDIA_JS_PREV,
        _ => return,
    };
    if let Some(wv) = app.get_webview(&tab_label(tab)) {
        let _ = wv.eval(js);
    }
}

#[tauri::command]
async fn focus_media_tab(app: AppHandle) {
    let tab = state(&app).media.as_ref().map(|m| m.tab);
    if let Some(t) = tab {
        if let Some(win) = win_of_tab(&app, t).and_then(|w| app.get_window(&w)) {
            let _ = win.set_focus();
        }
        activate(&app, t);
    }
}

#[tauri::command]
async fn win_minimize(webview: Webview) {
    let _ = webview.window().minimize();
}

#[tauri::command]
async fn win_toggle_maximize(webview: Webview) {
    let w = webview.window();
    if w.is_maximized().unwrap_or(false) {
        let _ = w.unmaximize();
    } else {
        let _ = w.maximize();
    }
}

/// Plein écran (F11) : la fenêtre occupe tout l'écran et la barre du navigateur disparaît.
fn toggle_fullscreen_win(app: &AppHandle, win: &str) {
    let Some(window) = app.get_window(win) else { return };
    let on = {
        let mut b = state(app);
        let Some(w) = b.windows.get_mut(win) else { return };
        w.fullscreen = !w.fullscreen;
        w.fullscreen
    };
    close_suggest(app, win);
    let _ = window.set_fullscreen(on);
    layout(app, win);
    if !on {
        if let Some(chrome) = app.get_webview(&format!("chrome-{win}")) {
            let _ = chrome.show();
        }
    }
    broadcast(app);
}

/// Plein écran demandé par la page (bouton plein écran d'une vidéo) : toute la fenêtre passe
/// en plein écran et l'onglet occupe tout l'écran ; à la sortie (Échap), tout revient comme avant.
fn set_page_fullscreen(app: &AppHandle, win: &str, on: bool) {
    let Some(window) = app.get_window(win) else { return };
    let set_window = {
        let mut b = state(app);
        let Some(w) = b.windows.get_mut(win) else { return };
        if w.page_fs == on {
            return;
        }
        w.page_fs = on;
        if on {
            // déjà en plein écran (F11) : on n'y touchera pas à la sortie
            w.page_fs_window = !w.fullscreen;
            w.page_fs_window
        } else {
            let was = w.page_fs_window;
            w.page_fs_window = false;
            was && !w.fullscreen
        }
    };
    close_suggest(app, win);
    if on {
        close_popups(app, win);
        dismiss_panel(app, win);
    }
    if set_window {
        let _ = window.set_fullscreen(on);
    }
    layout(app, win);
    // la fenêtre change de taille un peu après : nouveau placement une fois le plein écran établi
    let (app2, win2) = (app.clone(), win.to_string());
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        layout(&app2, &win2);
    });
    broadcast(app);
}

#[tauri::command]
async fn toggle_fullscreen(app: AppHandle, webview: Webview) {
    toggle_fullscreen_win(&app, &caller_win(&webview));
}

#[tauri::command]
async fn win_close(webview: Webview) {
    let _ = webview.window().close();
}

// ---------------------------------------------------------------- extensions Chrome
/// Une vue quelconque du navigateur : toutes partagent le même profil WebView2.
fn any_ui_webview(app: &AppHandle) -> Result<Webview, String> {
    app.webviews().into_iter().find(|(l, _)| l.starts_with("chrome-")).map(|(_, w)| w).ok_or_else(|| "aucune fenêtre ouverte".into())
}

fn ext_list_blocking(app: &AppHandle) -> Result<Vec<extensions::ExtInfo>, String> {
    let wv = any_ui_webview(app)?;
    let installed = extensions::profile_list(&wv)?;
    let mut out: Vec<extensions::ExtInfo> = installed
        .into_iter()
        .map(|(id, name, enabled)| {
            let mut info = extensions::manifest_info(app, &id);
            if info.name.is_empty() || info.name.starts_with("__MSG_") {
                info.name = name;
            }
            info.enabled = enabled;
            info
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

fn ext_install_blocking(app: &AppHandle, input: &str) -> Result<extensions::ExtInfo, String> {
    let id = extensions::parse_id(input).ok_or("Lien ou identifiant d'extension non reconnu.")?;
    let dir = extensions::download_and_unpack(app, &id)?;
    let wv = any_ui_webview(app)?;
    let real_id = extensions::profile_add(&wv, &dir)?;
    let mut info = extensions::manifest_info(app, &id);
    info.id = real_id;
    info.enabled = true;
    let _ = app.emit("extensions-changed", ());
    Ok(info)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ext_list(app: AppHandle) -> Result<Vec<extensions::ExtInfo>, String> {
    blocking(move || ext_list_blocking(&app)).await
}

#[tauri::command]
async fn ext_install(app: AppHandle, input: String) -> Result<extensions::ExtInfo, String> {
    blocking(move || ext_install_blocking(&app, &input)).await
}

#[tauri::command]
async fn ext_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    blocking(move || {
        let wv = any_ui_webview(&app)?;
        extensions::profile_set_enabled(&wv, &id, enabled)?;
        let _ = app.emit("extensions-changed", ());
        Ok(())
    })
    .await
}

#[tauri::command]
async fn ext_remove(app: AppHandle, id: String) -> Result<(), String> {
    blocking(move || {
        let wv = any_ui_webview(&app)?;
        extensions::profile_remove(&wv, &id)?;
        if extensions::parse_id(&id).as_deref() == Some(id.as_str()) {
            if let Ok(root) = extensions::ext_root(&app) {
                let _ = std::fs::remove_dir_all(root.join(&id));
            }
        }
        let _ = app.emit("extensions-changed", ());
        Ok(())
    })
    .await
}

/// Ouvre une page d'extension (options, fenêtre principale) dans un nouvel onglet.
#[tauri::command]
async fn ext_open(app: AppHandle, webview: Webview, url: String) -> Result<(), String> {
    if !url.starts_with("chrome-extension://") {
        return Err("adresse non autorisée".into());
    }
    create_tab(&app, &caller_win(&webview), Some(url)).map(|_| ())
}

// ---------------------------------------------------------------- commandes (pages web)
/// Seule commande autorisée pour les sites des onglets : un onglet signale SON icône,
/// SA lecture média, ou un raccourci clavier. L'onglet est identifié par le libellé de
/// sa vue, jamais par les données envoyées.
#[tauri::command]
async fn tab_event(app: AppHandle, webview: Webview, kind: String, data: serde_json::Value) {
    let Some(id) = tab_id_from_label(webview.label()) else { return };

    match kind.as_str() {
        "report" => {
            let favicon = data.get("favicon").and_then(|v| v.as_str()).unwrap_or("").chars().take(2048).collect::<String>();
            let lang: String = data.get("lang").and_then(|v| v.as_str()).unwrap_or("").chars().take(16).collect::<String>().to_lowercase();
            let media: Option<Media> = data
                .get("media")
                .filter(|v| !v.is_null())
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .map(|mut m: Media| {
                    m.tab = id;
                    m.title = m.title.chars().take(200).collect();
                    m.artist = m.artist.chars().take(200).collect();
                    m.artwork = m.artwork.chars().take(2048).collect();
                    m
                });
            let changed = {
                let mut b = state(&app);
                let mut changed = false;
                if let Some(t) = b.tabs.get_mut(&id) {
                    if t.favicon != favicon {
                        t.favicon = favicon;
                        changed = true;
                    }
                    if t.lang != lang {
                        t.lang = lang;
                        changed = true;
                    }
                    let audible = data.get("audible").and_then(|v| v.as_bool()).unwrap_or(false);
                    if t.audible != audible {
                        t.audible = audible;
                        changed = true;
                    }
                    // hors Windows, le moteur ne signale pas l'historique : la page le fait
                    #[cfg(not(windows))]
                    if let Some(nav) = data.get("nav") {
                        let back = nav.get("b").and_then(|v| v.as_bool()).unwrap_or(false);
                        if t.can_back != back {
                            t.can_back = back;
                            changed = true;
                        }
                        // sans l'API Navigation, « suivant » est déduit des clics (voir go_back)
                        if let Some(fwd) = nav.get("f").and_then(|v| v.as_bool()) {
                            if t.can_fwd != fwd {
                                t.can_fwd = fwd;
                                changed = true;
                            }
                        }
                    }
                }
                match media {
                    Some(m) => {
                        let replace = match &b.media {
                            None => true,
                            Some(cur) => cur.tab == id || m.playing || !cur.playing,
                        };
                        if replace && b.media.as_ref() != Some(&m) {
                            b.media = Some(m);
                            changed = true;
                        }
                    }
                    None => {
                        if b.media.as_ref().map(|m| m.tab) == Some(id) {
                            b.media = None;
                            changed = true;
                        }
                    }
                }
                changed
            };
            if changed {
                broadcast(&app);
            }
        }
        "scroll" => {
            let v = data.as_f64().unwrap_or(0.0).clamp(0.0, 30.0).round();
            let win = {
                let mut b = state(&app);
                let Some(t) = b.tabs.get_mut(&id) else { return };
                if t.url.is_empty() || (t.scroll - v).abs() < 0.5 {
                    return;
                }
                t.scroll = v;
                let win = t.win.clone();
                if b.windows.get(&win).and_then(|w| w.active) != Some(id) {
                    return;
                }
                win
            };
            layout(&app, &win);
            let _ = app.emit_to(format!("chrome-{win}").as_str(), "bm-offset", serde_json::json!({ "win": win, "off": v }));
        }
        "page_text" => {
            let req = data.get("req").and_then(|v| v.as_u64()).unwrap_or(0);
            let take = |k: &str, n: usize| data.get(k).and_then(|v| v.as_str()).unwrap_or("").chars().take(n).collect::<String>();
            let (text, title, url) = (take("text", 16000), take("title", 300), take("url", 2048));
            let accepted = {
                let mut b = state(&app);
                match b.text_reqs.get_mut(&req) {
                    // seulement un onglet attendu par cette lecture, une seule fois
                    Some(r) if r.tabs.contains(&id) && !r.got.iter().any(|g| g.0 == id) => {
                        r.got.push((id, title, url, text));
                        true
                    }
                    _ => false,
                }
            };
            if accepted {
                try_finish_read(&app, req, false);
            }
        }
        "ai_selection" => {
            {
                let mut b = state(&app);
                if b.last_sel.map(|t| t.elapsed() < Duration::from_millis(700)).unwrap_or(false) {
                    return;
                }
                b.last_sel = Some(Instant::now());
            }
            let take = |k: &str, n: usize| data.get(k).and_then(|v| v.as_str()).unwrap_or("").chars().take(n).collect::<String>();
            let (action, text, title, bubble) = (take("action", 20), take("text", 8000), take("title", 300), take("bubble", 40));
            let panel = data.get("panel").and_then(|v| v.as_bool()).unwrap_or(false);
            if text.trim().is_empty() {
                return;
            }
            let Some(prompt) = ai_selection_prompt(&action, text.trim(), &title) else { return };
            let Some(win) = win_of_tab(&app, id) else { return };
            if panel || bubble.is_empty() {
                let _ = ai_send(&app, &win, prompt);
            } else {
                // réponse courte, affichée dans la bulle de la page
                let short = if action == "translate" || action == "rephrase" || action.starts_with("rw_") {
                    prompt
                } else {
                    format!("{prompt}\n\nRéponds de façon concise : quelques phrases ou une courte liste, sans titre.")
                };
                if let Err(e) = quick_ask(&app, &win, id, bubble.clone(), short) {
                    debug_log(&format!("réponse rapide impossible : {e}"));
                }
            }
        }
        "translate" => {
            // morceaux de texte de la page à traduire ; la réponse revient par __corrtexTranslated
            let batch = data.get("batch").and_then(|v| v.as_u64()).unwrap_or(0);
            let texts: Vec<String> = data
                .get("texts")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().take(120).filter_map(|x| x.as_str().map(|s| s.chars().take(2000).collect())).collect())
                .unwrap_or_default();
            let to = data.get("to").and_then(|v| v.as_str()).filter(|t| t.len() <= 8 && t.chars().all(|c| c.is_ascii_alphabetic() || c == '-')).unwrap_or("fr").to_string();
            let wv = webview.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let res = translate_texts(&texts, &to);
                let js = format!("window.__corrtexTranslated && window.__corrtexTranslated({batch}, {})", serde_json::to_string(&res).unwrap_or_else(|_| "null".into()));
                let _ = wv.eval(&js);
            });
        }
        "shop_detect" => {
            let p = if data.is_object() { Some(data.clone()) } else { None };
            if let Some(t) = state(&app).tabs.get_mut(&id) {
                t.product = p;
            }
            // le panneau ouvert suit l'article de l'onglet
            if let Some(win) = win_of_tab(&app, id) {
                let _ = app.emit_to(format!("panel-{win}").as_str(), "shop-changed", serde_json::json!({ "tab": id }));
            }
        }
        "shop_fetch" => {
            // le comparateur (dans la page) demande une page de leDénicheur ou de Dealabs
            let req = data.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
            let url = data.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let wv = webview.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let (ok, body) = match fetch_shop_page(&url, &[]) {
                    Ok(t) => (true, t),
                    Err(e) => (false, e),
                };
                let js = format!("window.__corrtexShopFetched && window.__corrtexShopFetched({req}, {ok}, {})", serde_json::to_string(&body).unwrap_or_else(|_| "\"\"".into()));
                let _ = wv.eval(&js);
            });
        }
        "open_new_tab" => {
            // lien du comparateur : nouvel onglet (seulement des adresses web)
            let url = data.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if url.starts_with("https://") || url.starts_with("http://") {
                if let Some(win) = win_of_tab(&app, id) {
                    let _ = create_tab(&app, &win, Some(url));
                }
            }
        }
        "action" => {
            // raccourci clavier personnalisé tapé dans la page
            if let Some(win) = win_of_tab(&app, id) {
                run_action(&app, &win, data.as_str().unwrap_or(""));
            }
        }
        "gesture" => {
            // geste de la souris : ← précédent, → suivant, ↑ actualiser, ↓ nouvel onglet, ↓→ fermer, ←↑ rouvrir
            let Some(win) = win_of_tab(&app, id) else { return };
            match data.as_str().unwrap_or("") {
                "L" => {
                    let _ = webview.eval("history.back()");
                }
                "R" => {
                    let _ = webview.eval("history.forward()");
                }
                "U" => {
                    let _ = webview.reload();
                }
                "D" => run_action(&app, &win, "new_tab"),
                "DR" => close(&app, id),
                "LU" => run_action(&app, &win, "reopen_tab"),
                _ => {}
            }
        }
        "capture_area" => {
            // zone choisie dans la page (pixels CSS de la partie affichée) : capture de la vue, recadrée dans l'éditeur
            if data.is_object() {
                let full = data.get("full").and_then(|v| v.as_bool()).unwrap_or(false);
                cdp_capture(&app, id, false, if full { None } else { Some(data.clone()) });
            }
        }
        "action_capture" => {
            if let Some(win) = win_of_tab(&app, id) {
                let _ = capture_start(&app, &win, "full");
            }
        }
        "shop_ai" => {
            let take = |k: &str, n: usize| data.get(k).and_then(|v| v.as_str()).unwrap_or("").chars().take(n).collect::<String>();
            let req: String = take("req", 30).chars().filter(|c| c.is_ascii_alphanumeric()).collect();
            let prompt = take("prompt", 12000);
            if let Some(win) = win_of_tab(&app, id) {
                let _ = quick_ask_to(&app, &win, id, req, prompt, Some("__corrtexShopAI"));
            }
        }
        "translated" => {
            let on = data.as_bool().unwrap_or(false);
            if let Some(t) = state(&app).tabs.get_mut(&id) {
                t.translated = on;
            }
            broadcast(&app);
        }
        "yt_transcript" => {
            let take = |k: &str, n: usize| data.get(k).and_then(|v| v.as_str()).unwrap_or("").chars().take(n).collect::<String>();
            let (text, title) = (take("text", 30000), take("title", 300));
            let Some(win) = win_of_tab(&app, id) else { return };
            let url = state(&app).tabs.get(&id).map(|t| t.url.clone()).unwrap_or_default();
            let prompt = if text.trim().is_empty() {
                format!("Résume en français cette vidéo YouTube : « {title} » ({url}). Une phrase d'introduction, les points clés en liste, puis une courte conclusion. Ensuite je te poserai des questions sur la vidéo.")
            } else {
                format!(
                    "Voici la transcription de la vidéo YouTube « {title} » ({url}).\n\nRésume-la en français : une phrase d'introduction, les points clés en liste avec les moments importants (minutage) quand c'est possible, puis une courte conclusion. Ensuite, réponds à mes questions sur cette vidéo en t'appuyant sur la transcription.\n\n\"\"\"\n{text}\n\"\"\""
                )
            };
            let _ = ai_send(&app, &win, prompt);
        }
        "page_fullscreen" => {
            // seulement l'onglet affiché
            let on = data.as_bool().unwrap_or(false);
            if let Some(win) = win_of_tab(&app, id) {
                let active = state(&app).windows.get(&win).and_then(|w| w.active) == Some(id);
                if active || !on {
                    set_page_fullscreen(&app, &win, on);
                }
            }
        }
        "shopping_action" => {
            // boutons du panneau de recherche d'achat (dans la page) : transmis au moteur caché
            let Some(win) = win_of_tab(&app, id) else { return };
            let action = data.get("action").and_then(|v| v.as_str()).unwrap_or("");
            match action {
                "close" => shopping_hide(&app, &win),
                "new" => {
                    let goal: String = data.get("goal").and_then(|v| v.as_str()).unwrap_or("").trim().chars().take(500).collect();
                    if !goal.is_empty() {
                        let _ = open_shopping(&app, &win, &goal);
                    }
                }
                "history" => {
                    let list = agent_history_brief(&app);
                    let js = format!("window.__corrtexShopping && window.__corrtexShopping.history({})", serde_json::to_string(&list).unwrap_or_else(|_| "[]".into()));
                    let _ = webview.eval(&js);
                }
                "open" => {
                    if let Some(hid) = data.get("id").and_then(|v| v.as_u64()) {
                        let _ = agent_history_open_in(&app, &win, hid);
                    }
                }
                "delete" => {
                    if let Some(hid) = data.get("id").and_then(|v| v.as_u64()) {
                        {
                            let mut b = state(&app);
                            b.agent_history.retain(|r| r.get("id").and_then(|v| v.as_u64()) != Some(hid));
                        }
                        save_agent_history(&app);
                    }
                }
                _ => {
                    if let Some(w) = app.get_webview(&format!("shopw-{win}")) {
                        let js = format!("window.__corrtexShoppingAction && window.__corrtexShoppingAction({})", serde_json::to_string(&data).unwrap_or_else(|_| "null".into()));
                        let _ = w.eval(&js);
                    }
                }
            }
        }
        "page_cmp_ai" => {
            let take = |k: &str, n: usize| data.get(k).and_then(|v| v.as_str()).unwrap_or("").chars().take(n).collect::<String>();
            let req: String = take("req", 30).chars().filter(|c| c.is_ascii_alphanumeric()).collect();
            let prompt = take("prompt", 12000);
            if let Some(win) = win_of_tab(&app, id) {
                let _ = quick_ask_to(&app, &win, id, req, prompt, Some("__corrtexPageCmpAI"));
            }
        }
        // question à l'IA cachée depuis une page (panneau YouTube…) : réponse dans __corrtexPageAI
        "page_ai" => {
            let take = |k: &str, n: usize| data.get(k).and_then(|v| v.as_str()).unwrap_or("").chars().take(n).collect::<String>();
            let req: String = take("req", 30).chars().filter(|c| c.is_ascii_alphanumeric()).collect();
            let prompt = take("prompt", 12000);
            if let Some(win) = win_of_tab(&app, id) {
                let _ = quick_ask_slot(&app, &win, 1, id, req, prompt, Some("__corrtexPageAI"));
            }
        }
        "page_cmp_done" => {
            let take = |k: &str, n: usize| data.get(k).and_then(|v| v.as_str()).unwrap_or("").chars().take(n).collect::<String>();
            let private = win_of_tab(&app, id).and_then(|w| state(&app).windows.get(&w).map(|w| w.private)).unwrap_or(false);
            if !private {
                let url = state(&app).tabs.get(&id).map(|t| t.url.clone()).unwrap_or_default();
                let goal = format!("Comparer les articles : {} ({})", take("needs", 300), take("title", 120));
                agent_history_put(&app, serde_json::json!({ "id": now_secs() * 1000, "kind": "agent", "goal": goal, "answer": take("answer", 4000), "url": url, "time": now_secs() }));
            }
        }
        "agent_done" => {
            // réponse finale de l'agent de navigation : gardée dans l'historique de l'agent
            let goal = state(&app).agents.get(&id).map(|j| j.goal.clone()).unwrap_or_default();
            let answer: String = data.get("answer").and_then(|v| v.as_str()).unwrap_or("").chars().take(4000).collect();
            let private = win_of_tab(&app, id).and_then(|w| state(&app).windows.get(&w).map(|w| w.private)).unwrap_or(false);
            if !goal.is_empty() && !private {
                let url = state(&app).tabs.get(&id).map(|t| t.url.clone()).unwrap_or_default();
                agent_history_put(&app, serde_json::json!({ "id": now_secs() * 1000, "kind": "agent", "goal": goal, "answer": answer, "url": url, "time": now_secs() }));
            }
        }
        "agent_snap" | "agent_step" | "agent_answer" | "agent_retry" | "agent_stop" => {
            agent_event(&app, id, kind.as_str(), &data);
        }
        "perf" => {
            let v = data.as_u64().unwrap_or(0);
            if let Some(t) = state(&app).tabs.get_mut(&id) {
                t.js_mem = v;
            }
        }
        "zoom" => {
            let dir = data.as_str().unwrap_or("reset").to_string();
            zoom_tab(&app, id, &dir);
        }
        "google_ready" => {
            // page de résultats Google prête (DOMContentLoaded) : on applique le style tout de suite
            let is_search = webview.url().map(|u| is_google_search(u.as_str())).unwrap_or(false);
            if is_search {
                let _ = webview.eval(&google_skin_js(&app));
            }
        }
        "install_ext" => {
            // Bouton « Ajouter à Corrtex » ajouté sur les pages du Chrome Web Store :
            // accepté uniquement depuis un onglet ouvert sur chromewebstore.google.com.
            let from_store = webview
                .url()
                .map(|u| u.scheme() == "https" && u.host_str() == Some("chromewebstore.google.com"))
                .unwrap_or(false);
            let Some(ext_id) = data.as_str().and_then(extensions::parse_id) else { return };
            if !from_store {
                return;
            }
            let app2 = app.clone();
            let result = blocking(move || ext_install_blocking(&app2, &ext_id)).await;
            let (ok, msg) = match result {
                Ok(info) => (true, format!("{} a été ajoutée à Corrtex", if info.name.is_empty() { "L'extension".to_string() } else { info.name })),
                Err(e) => (false, e),
            };
            let js = format!(
                "window.__corrtexExtResult && window.__corrtexExtResult({}, {})",
                ok,
                serde_json::to_string(&msg).unwrap_or_else(|_| "\"\"".into())
            );
            let _ = webview.eval(&js);
        }
        "key" => {
            {
                let mut b = state(&app);
                if b.last_key.map(|t| t.elapsed() < Duration::from_millis(250)).unwrap_or(false) {
                    return;
                }
                b.last_key = Some(Instant::now());
            }
            let Some(win) = win_of_tab(&app, id) else { return };
            match data.as_str().unwrap_or("") {
                "ctrl+t" => {
                    let _ = create_tab(&app, &win, None);
                }
                "ctrl+w" => close(&app, id),
                "f11" => toggle_fullscreen_win(&app, &win),
                "ctrl+shift+t" => {
                    let _ = reopen_closed_in(&app, &win);
                }
                "ctrl+k" => {
                    let _ = palette_in(&app, &win);
                }
                "ctrl+shift+n" => {
                    let _ = open_private_window(&app);
                }
                "ctrl+h" => {
                    let _ = open_library_in(&app, &win, "history");
                }
                "ctrl+j" => {
                    let _ = open_library_in(&app, &win, "downloads");
                }
                "ctrl+tab" => cycle_tab(&app, &win, 1),
                "ctrl+shift+tab" => cycle_tab(&app, &win, -1),
                "ctrl+l" => {
                    if let Some(chrome) = app.get_webview(&format!("chrome-{win}")) {
                        let _ = chrome.set_focus();
                        let _ = app.emit_to(format!("chrome-{win}").as_str(), "focus-omnibox", win.clone());
                    }
                }
                _ => {}
            }
        }
        _ => {}
    }
}

/// Choisit le compte Google utilisé par Corrtex (parmi les comptes connectés).
#[tauri::command]
async fn google_switch(app: AppHandle, index: u32) {
    {
        let mut b = state(&app);
        let Some(a) = b.google.accounts.get(index as usize).cloned() else { return };
        b.settings.google_active = index;
        b.google.active = index;
        b.google.name = a.name;
        b.google.email = a.email;
        b.google.avatar = a.avatar;
    }
    save_settings(&app);
    broadcast(&app);
}

/// Réponse de la vue invisible "gprobe" (google.com) : état de connexion et profil.
#[tauri::command]
async fn google_profile(app: AppHandle, webview: Webview, data: serde_json::Value) {
    if webview.label() != "gprobe" {
        return;
    }
    // on vérifie que la page est bien google.com
    let ok = webview
        .url()
        .map(|u| u.scheme() == "https" && matches!(u.host_str(), Some("www.google.com") | Some("accounts.google.com")))
        .unwrap_or(false);
    if !ok {
        return;
    }
    let take = |k: &str, n: usize| data.get(k).and_then(|v| v.as_str()).unwrap_or("").chars().take(n).collect::<String>();
    // (plus de trace du profil Google dans le journal : données personnelles)
    let signed_in = data.get("signedIn").and_then(|v| v.as_bool()).unwrap_or(false);
    let mut avatar = take("avatar", 2048);
    if !(avatar.starts_with("https://") && avatar.contains("googleusercontent.com/")) {
        avatar.clear();
    }
    // tous les comptes connectés (plusieurs comptes Google possibles)
    let clean_avatar = |a: &str| if a.starts_with("https://") && a.contains("googleusercontent.com/") { a.chars().take(2048).collect() } else { String::new() };
    let mut accounts: Vec<GAccount> = data
        .get("accounts")
        .and_then(|v| v.as_array())
        .map(|l| {
            l.iter()
                .take(10)
                .map(|a| GAccount {
                    name: a.get("name").and_then(|v| v.as_str()).unwrap_or("").chars().take(120).collect(),
                    email: a.get("email").and_then(|v| v.as_str()).unwrap_or("").chars().take(200).collect(),
                    avatar: clean_avatar(a.get("avatar").and_then(|v| v.as_str()).unwrap_or("")),
                })
                .filter(|a| a.email.contains('@'))
                .collect()
        })
        .unwrap_or_default();
    if signed_in && accounts.is_empty() {
        accounts.push(GAccount { name: take("name", 120), email: take("email", 200), avatar: avatar.clone() });
    }
    let g = if signed_in {
        let mut active = state(&app).settings.google_active;
        if active as usize >= accounts.len() {
            active = 0;
        }
        let cur = accounts[active as usize].clone();
        Google { status: "signed_in".into(), name: cur.name, email: cur.email, avatar: cur.avatar, accounts, active }
    } else {
        Google { status: "signed_out".into(), ..Default::default() }
    };
    let changed = {
        let mut b = state(&app);
        let c = b.google != g;
        b.google = g;
        c
    };
    finish_probe(&app);
    if changed {
        broadcast(&app);
        // les pages Google ouvertes reprennent la nouvelle photo / le nouveau compte
        apply_google_skin(&app);
    }
}

// ---------------------------------------------------------------- démarrage
// ---------------------------------------------------------------- menu macOS
// Sur Mac, ⌘C / ⌘V / ⌘Z… passent par la barre des menus : sans menu « Édition », le
// copier-coller ne marche pas dans les champs. Le menu par défaut de Tauri n'est pas
// repris car son « Fermer la fenêtre » (⌘W) fermerait tous les onglets d'un coup :
// ⌘W reste à Corrtex (fermer l'onglet), ⌘H à l'historique.
#[cfg(target_os = "macos")]
fn with_mac_menu(b: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
    b.menu(|app| {
        let about = AboutMetadata { name: Some("Corrtex".into()), version: Some(app.package_info().version.to_string()), ..Default::default() };
        let corrtex = Submenu::with_items(app, "Corrtex", true, &[
            &PredefinedMenuItem::about(app, Some("À propos de Corrtex"), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some("Services"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide_others(app, Some("Masquer les autres"))?,
            &PredefinedMenuItem::show_all(app, Some("Tout afficher"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "corrtex-quit", "Quitter Corrtex", true, Some("CmdOrCtrl+Q"))?,
        ])?;
        let edit = Submenu::with_items(app, "Édition", true, &[
            &PredefinedMenuItem::undo(app, Some("Annuler"))?,
            &PredefinedMenuItem::redo(app, Some("Rétablir"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("Couper"))?,
            &PredefinedMenuItem::copy(app, Some("Copier"))?,
            &PredefinedMenuItem::paste(app, Some("Coller"))?,
            &PredefinedMenuItem::select_all(app, Some("Tout sélectionner"))?,
        ])?;
        let window = Submenu::with_items(app, "Fenêtre", true, &[
            &PredefinedMenuItem::minimize(app, Some("Placer dans le Dock"))?,
            &PredefinedMenuItem::maximize(app, Some("Réduire/agrandir"))?,
            &PredefinedMenuItem::fullscreen(app, Some("Plein écran"))?,
        ])?;
        Menu::with_items(app, &[&corrtex, &edit, &window])
    })
    .on_menu_event(|app, event| {
        if event.id().as_ref() == "corrtex-quit" {
            // la session est enregistrée avant de quitter, comme à la fermeture de la dernière fenêtre
            save_session(app);
            save_history(app);
            app.exit(0);
        }
    })
}

#[cfg(not(target_os = "macos"))]
fn with_mac_menu(b: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    b
}

fn main() {
    with_mac_menu(tauri::Builder::default())
        // une seule instance : relancer Corrtex ramène la fenêtre déjà ouverte (réduite)
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| reopen_existing(app, args)))
        .manage(AppState(Mutex::new(Browser {
            google: Google { status: "unknown".into(), ..Default::default() },
            ..Default::default()
        })))
        .invoke_handler(tauri::generate_handler![
            tab_event,
            google_profile,
            google_switch,
            get_state,
            new_tab,
            close_tab,
            activate_tab,
            move_tab,
            drag_detach,
            navigate,
            go_back,
            go_forward,
            reload,
            toggle_sidebar,
            set_ai_provider,
            set_ai_theme,
            set_sidebar_width,
            ai_ask_page,
            toggle_ai_skin,
            refresh_google,
            media_control,
            focus_media_tab,
            toggle_ext_panel,
            suggest,
            suggest_update,
            suggest_get,
            suggest_close,
            ext_list,
            ext_install,
            ext_set_enabled,
            ext_remove,
            ext_open,
            win_minimize,
            win_toggle_maximize,
            win_close,
            toggle_fullscreen,
            ai_summarize,
            ai_page_compare,
            shop_sites_get,
            search::search_fetch,
            search::search_prefetch,
            search::search_warm,
            search_page,
            ai_prompt,
            ai_image,
            agent_kind,
            shop_ai_warm,
            ai_native_take,
            reader_open,
            reader_get,
            set_ai_native,
            ai_image_result,
            shop_sites_set,
            shop_sites_reset,
            ai_compare,
            set_aibar_extra,
            set_ai_memory,
            ai_quick_result,
            popup_get,
            popup_close,
            popup_fit,
            tab_menu,
            group_menu,
            bookmark_menu,
            history_complete,
            translate_page,
            history_ai,
            agent_start,
            agent_open,
            focus_start,
            focus_stop,
            focus_info,
            focus_sites_set,
            power_state,
            set_power_mode,
            profile_list,
            profile_create,
            profile_delete,
            open_profile_window,
            app_info,
            version_seen,
            set_update_repo,
            update_check,
            app_quit,
            set_app_prefs,
            shopping_job,
            shopping_save,
            shopping_start,
            shopping_push,
            agent_history_list,
            agent_history_delete,
            agent_history_open,
            update_status,
            update_install,
            keys_get,
            keys_set,
            set_gestures,
            run_action_cmd,
            tab_mute,
            capture_page,
            capture_get,
            space_action,
            split_open,
            split_close,
            read_later_add,
            read_later_list,
            read_later_remove,
            note_get,
            note_set,
            popup_show,
            shop_context,
            shop_fetch,
            shop_ask_ai,
            backup_export,
            backup_import,
            tab_preview,
            preview_close,
            tab_action,
            group_action,
            reopen_closed,
            set_tab_prefs,
            history_list,
            history_delete,
            history_clear,
            downloads_list,
            downloads_clear,
            download_open,
            open_library,
            zoom_active,
            reader_toggle,
            find_open,
            palette_open,
            palette_go,
            new_private_window,
            set_privacy,
            clear_data,
            perf_stats,
            perf_sleep,
            close_panel,
        ])
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            update_watch(handle.clone());
            load_agent_history(&handle);
            let settings = load_settings(&handle);
            SIDE_W.store(settings.sidebar_w.clamp(SIDE_MIN, 1000.0) as u32, std::sync::atomic::Ordering::Relaxed);
            state(&handle).settings = settings;

            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                load_history(&h);
                // session de la dernière fois, sinon une fenêtre avec la page d'accueil
                if !restore_session(&h) {
                    if let Ok(win) = create_window(&h, None, None) {
                        let _ = create_tab(&h, &win, None);
                    }
                }
                let wins: Vec<String> = state(&h).windows.keys().cloned().collect();
                for win in wins {
                    let open = state(&h).windows.get(&win).map(|w| w.sidebar_open).unwrap_or(false);
                    if open {
                        let _ = ensure_ai(&h, &win);
                        layout(&h, &win);
                    }
                }
                broadcast(&h);
                // lecture du profil Google peu après le démarrage
                schedule_google_probe(&h, Duration::from_millis(1200));
                // style Corrtex des pages d'IA : réappliqué toutes les 2 s (panneaux ouverts seulement)
                let h3 = h.clone();
                // session enregistrée (si elle a changé) et onglets inactifs mis en veille
                let h4 = h.clone();
                std::thread::spawn(move || {
                    let mut n = 0u32;
                    loop {
                        std::thread::sleep(Duration::from_secs(3));
                        n += 1;
                        if state(&h4).session_dirty {
                            save_session(&h4);
                        }
                        if state(&h4).history_dirty {
                            save_history(&h4);
                        }
                        if n % 10 == 0 {
                            sleep_tick(&h4);
                        }
                        // mode concentration : compte à rebours (toutes les 15 s) et fin
                        if n % 5 == 0 && state(&h4).focus_until.is_some() {
                            focus_tick(&h4);
                        }
                    }
                });
                std::thread::spawn(move || loop {
                    std::thread::sleep(Duration::from_secs(2));
                    let open = state(&h3).windows.values().any(|w| w.sidebar_open && w.ai_created);
                    if open {
                        apply_ai_skin(&h3);
                        ai_memory_tick(&h3);
                    }
                });
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Corrtex");
}
