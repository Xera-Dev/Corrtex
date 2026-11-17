//! Extensions Chrome (Chrome Web Store) pour Corrtex.
//!
//! - Téléchargement du paquet .crx de l'extension depuis les serveurs de Google.
//! - Décompression dans le dossier de données de Corrtex, avec la clé publique de
//!   l'extension réinjectée dans son manifeste : elle garde ainsi le même identifiant
//!   que sur le Chrome Web Store.
//! - Installation / activation / suppression via le profil WebView2 (Windows).

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager, Webview};

#[derive(Serialize, Clone, Default)]
pub struct ExtInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub enabled: bool,
    /// icône en data URL (lue depuis le dossier de l'extension)
    pub icon: String,
    /// page d'options et fenêtre principale (popup) de l'extension, si elles existent
    pub options: String,
    pub popup: String,
}

pub fn ext_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("extensions");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Trouve un identifiant d'extension (32 lettres de a à p) dans un lien ou un texte.
pub fn parse_id(input: &str) -> Option<String> {
    let lower = input.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut run = 0usize;
    for (i, b) in bytes.iter().enumerate() {
        if (b'a'..=b'p').contains(b) {
            run += 1;
            if run == 32 {
                let next_ok = bytes.get(i + 1).map(|c| !c.is_ascii_alphanumeric()).unwrap_or(true);
                let start = i + 1 - 32;
                let prev_ok = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
                if next_ok && prev_ok {
                    return Some(lower[start..=i].to_string());
                }
            }
        } else {
            run = 0;
        }
    }
    None
}

// ------------------------------------------------------------------ téléchargement
fn download_crx(id: &str, dest: &Path) -> Result<(), String> {
    let url = format!(
        "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=131.0.0.0&acceptformat=crx2,crx3&x=id%3D{id}%26installsource%3Dondemand%26uc"
    );
    let mut cmd = std::process::Command::new("curl.exe");
    cmd.args(["-L", "-f", "-s", "--max-time", "120", "-o"]).arg(dest).arg(&url);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW : pas de fenêtre de console
    }
    let status = cmd.status().map_err(|e| format!("téléchargement impossible : {e}"))?;
    if !status.success() {
        return Err("Le Chrome Web Store n'a pas fourni cette extension (identifiant incorrect ou extension retirée).".into());
    }
    Ok(())
}

// ------------------------------------------------------------------ format .crx
fn read_varint(data: &[u8], pos: &mut usize) -> Option<u64> {
    let mut result = 0u64;
    let mut shift = 0;
    while *pos < data.len() && shift < 64 {
        let b = data[*pos];
        *pos += 1;
        result |= ((b & 0x7f) as u64) << shift;
        if b & 0x80 == 0 {
            return Some(result);
        }
        shift += 7;
    }
    None
}

/// Champs "bytes" (type 2) d'un message protobuf : (numéro de champ, contenu).
fn proto_fields(data: &[u8]) -> Vec<(u64, &[u8])> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < data.len() {
        let Some(key) = read_varint(data, &mut pos) else { break };
        let (field, wire) = (key >> 3, key & 7);
        match wire {
            0 => {
                if read_varint(data, &mut pos).is_none() {
                    break;
                }
            }
            1 => pos += 8,
            5 => pos += 4,
            2 => {
                let Some(len) = read_varint(data, &mut pos) else { break };
                let end = pos.saturating_add(len as usize);
                if end > data.len() {
                    break;
                }
                out.push((field, &data[pos..end]));
                pos = end;
            }
            _ => break,
        }
    }
    out
}

fn id_from_key(key: &[u8]) -> String {
    let hash = Sha256::digest(key);
    hash[..16].iter().flat_map(|b| [b >> 4, b & 0xf]).map(|n| (b'a' + n) as char).collect()
}

fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Sépare un fichier .crx en (archive zip, clé publique de l'extension).
fn split_crx(data: &[u8], expected_id: &str) -> Result<(Vec<u8>, Option<Vec<u8>>), String> {
    if data.len() < 16 || &data[0..4] != b"Cr24" {
        // certains serveurs renvoient directement le zip
        if data.starts_with(b"PK") {
            return Ok((data.to_vec(), None));
        }
        return Err("Fichier d'extension invalide.".into());
    }
    let u32le = |i: usize| u32::from_le_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]) as usize;
    match u32le(4) {
        2 => {
            let (klen, slen) = (u32le(8), u32le(12));
            let start = 16 + klen + slen;
            let key = data.get(16..16 + klen).map(|k| k.to_vec());
            Ok((data.get(start..).ok_or("crx tronqué")?.to_vec(), key))
        }
        3 => {
            let hlen = u32le(8);
            let header = data.get(12..12 + hlen).ok_or("crx tronqué")?;
            let zip = data.get(12 + hlen..).ok_or("crx tronqué")?.to_vec();
            // CrxFileHeader : champs 2 et 3 = preuves (clé publique en champ 1)
            let mut key = None;
            for (field, proof) in proto_fields(header) {
                if field == 2 || field == 3 {
                    for (f, k) in proto_fields(proof) {
                        if f == 1 && id_from_key(k) == expected_id {
                            key = Some(k.to_vec());
                        }
                    }
                }
            }
            Ok((zip, key))
        }
        v => Err(format!("Version de crx non prise en charge ({v}).")),
    }
}

// ------------------------------------------------------------------ zip (lecture minimale)
fn unzip(data: &[u8], dest: &Path) -> Result<(), String> {
    let u16le = |i: usize| -> Result<usize, String> { Ok(u16::from_le_bytes([*data.get(i).ok_or("zip")?, *data.get(i + 1).ok_or("zip")?]) as usize) };
    let u32le = |i: usize| -> Result<usize, String> {
        let s = data.get(i..i + 4).ok_or("zip tronqué")?;
        Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as usize)
    };
    // fin du répertoire central
    let eocd = (0..data.len().saturating_sub(21)).rev().find(|&i| data[i..].starts_with(&[0x50, 0x4b, 0x05, 0x06])).ok_or("archive zip invalide")?;
    let count = u16le(eocd + 10)?;
    let mut p = u32le(eocd + 16)?;
    for _ in 0..count {
        if !data.get(p..).map(|d| d.starts_with(&[0x50, 0x4b, 0x01, 0x02])).unwrap_or(false) {
            return Err("archive zip invalide".into());
        }
        let method = u16le(p + 10)?;
        let csize = u32le(p + 20)?;
        let usize_ = u32le(p + 24)?;
        let (nlen, xlen, clen) = (u16le(p + 28)?, u16le(p + 30)?, u16le(p + 32)?);
        let local = u32le(p + 42)?;
        let name = String::from_utf8_lossy(data.get(p + 46..p + 46 + nlen).ok_or("zip")?).replace('\\', "/");
        p += 46 + nlen + xlen + clen;

        // sécurité : pas de chemins absolus ni de remontée de dossier
        let rel = Path::new(&name);
        if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
            continue;
        }
        let out = dest.join(rel);
        if name.ends_with('/') {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        let start = local + 30 + u16le(local + 26)? + u16le(local + 28)?;
        let raw = data.get(start..start + csize).ok_or("zip tronqué")?;
        let bytes = match method {
            0 => raw.to_vec(),
            8 => {
                let mut v = Vec::with_capacity(usize_);
                flate2::read::DeflateDecoder::new(raw).read_to_end(&mut v).map_err(|e| e.to_string())?;
                v
            }
            m => return Err(format!("compression zip non prise en charge ({m})")),
        };
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&out, bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Télécharge et décompresse l'extension ; renvoie son dossier.
pub fn download_and_unpack(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let root = ext_root(app)?;
    let tmp = root.join(format!("{id}.crx"));
    download_crx(id, &tmp)?;
    let data = std::fs::read(&tmp).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&tmp);
    let (zip, key) = split_crx(&data, id)?;

    let dir = root.join(id);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    unzip(&zip, &dir)?;

    // clé publique dans le manifeste -> même identifiant que sur le Chrome Web Store
    let manifest_path = dir.join("manifest.json");
    let text = std::fs::read_to_string(&manifest_path).map_err(|_| "manifest.json introuvable dans l'extension".to_string())?;
    let text = text.trim_start_matches('\u{feff}');
    let mut manifest: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("manifest invalide : {e}"))?;
    if let (Some(key), Some(obj)) = (key, manifest.as_object_mut()) {
        obj.insert("key".into(), serde_json::Value::String(base64(&key)));
        std::fs::write(&manifest_path, serde_json::to_string_pretty(&manifest).unwrap_or_default()).map_err(|e| e.to_string())?;
    }
    // les dossiers commençant par "_" (sauf _locales) sont refusés par le moteur
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with('_') && n != "_locales" {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    Ok(dir)
}

// ------------------------------------------------------------------ informations du manifeste
fn localized(dir: &Path, manifest: &serde_json::Value, value: &str) -> String {
    let Some(key) = value.strip_prefix("__MSG_").and_then(|v| v.strip_suffix("__")) else { return value.to_string() };
    let default = manifest.get("default_locale").and_then(|v| v.as_str()).unwrap_or("en");
    for loc in ["fr", default, "en"] {
        let p = dir.join("_locales").join(loc).join("messages.json");
        if let Ok(t) = std::fs::read_to_string(p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(t.trim_start_matches('\u{feff}')) {
                if let Some(obj) = v.as_object() {
                    if let Some((_, m)) = obj.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)) {
                        if let Some(s) = m.get("message").and_then(|s| s.as_str()) {
                            return s.to_string();
                        }
                    }
                }
            }
        }
    }
    value.to_string()
}

/// Icône la plus grande trouvée dans le manifeste ("icons", puis icône du bouton
/// d'action), renvoyée en data URL. Chaîne vide si aucune n'est lisible.
fn best_icon(dir: &Path, m: &serde_json::Value) -> String {
    let mut candidates: Vec<(u32, String)> = Vec::new();
    let mut collect = |v: Option<&serde_json::Value>| match v {
        Some(serde_json::Value::Object(map)) => {
            for (k, p) in map {
                if let Some(p) = p.as_str() {
                    candidates.push((k.parse().unwrap_or(0), p.to_string()));
                }
            }
        }
        Some(serde_json::Value::String(p)) => candidates.push((16, p.clone())),
        _ => {}
    };
    collect(m.get("icons"));
    for key in ["action", "browser_action", "page_action"] {
        collect(m.get(key).and_then(|a| a.get("default_icon")));
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, p) in candidates {
        let rel = p.trim_start_matches("./").trim_start_matches('/');
        let path = dir.join(rel);
        let Ok(bytes) = std::fs::read(&path) else { continue };
        if bytes.is_empty() || bytes.len() > 400_000 {
            continue;
        }
        let ext = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        let mime = match ext.as_str() {
            "svg" => "image/svg+xml",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "ico" => "image/x-icon",
            "bmp" => "image/bmp",
            _ => "image/png",
        };
        return format!("data:{mime};base64,{}", base64(&bytes));
    }
    String::new()
}

pub fn manifest_info(app: &AppHandle, id: &str) -> ExtInfo {
    let mut info = ExtInfo { id: id.to_string(), ..Default::default() };
    let Ok(root) = ext_root(app) else { return info };
    let dir = root.join(id);
    let Ok(text) = std::fs::read_to_string(dir.join("manifest.json")) else { return info };
    let Ok(m) = serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}')) else { return info };
    let s = |v: Option<&serde_json::Value>| v.and_then(|x| x.as_str()).unwrap_or("").to_string();
    info.name = localized(&dir, &m, &s(m.get("name")));
    info.description = localized(&dir, &m, &s(m.get("description")));
    info.version = s(m.get("version"));
    let options = s(m.get("options_page")).to_string();
    let options = if options.is_empty() { s(m.get("options_ui").and_then(|o| o.get("page"))) } else { options };
    if !options.is_empty() {
        info.options = format!("chrome-extension://{id}/{}", options.trim_start_matches('/'));
    }
    let popup = s(m.get("action").or_else(|| m.get("browser_action")).and_then(|a| a.get("default_popup")));
    if !popup.is_empty() {
        info.popup = format!("chrome-extension://{id}/{}", popup.trim_start_matches('/'));
    }
    info.icon = best_icon(&dir, &m);
    info
}

// ------------------------------------------------------------------ profil WebView2
/// (identifiant, nom, activée) des extensions installées dans le profil.
pub type ProfileExt = (String, String, bool);

#[cfg(windows)]
mod platform {
    use super::ProfileExt;
    use std::sync::mpsc::{channel, Sender};
    use std::time::Duration;
    use tauri::Webview;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2BrowserExtension, ICoreWebView2Profile7, ICoreWebView2_13,
    };
    use webview2_com::{
        take_pwstr, BrowserExtensionEnableCompletedHandler, BrowserExtensionRemoveCompletedHandler,
        ProfileAddBrowserExtensionCompletedHandler, ProfileGetBrowserExtensionsCompletedHandler,
    };
    use windows_core::{Interface, BOOL, HSTRING, PWSTR};

    fn profile(pw: &tauri::webview::PlatformWebview) -> windows_core::Result<ICoreWebView2Profile7> {
        unsafe {
            let core = pw.controller().CoreWebView2()?;
            core.cast::<ICoreWebView2_13>()?.Profile()?.cast::<ICoreWebView2Profile7>()
        }
    }

    fn ext_id(e: &ICoreWebView2BrowserExtension) -> String {
        unsafe {
            let mut p = PWSTR::null();
            if e.Id(&mut p).is_ok() { take_pwstr(p) } else { String::new() }
        }
    }

    fn ext_name(e: &ICoreWebView2BrowserExtension) -> String {
        unsafe {
            let mut p = PWSTR::null();
            if e.Name(&mut p).is_ok() { take_pwstr(p) } else { String::new() }
        }
    }

    fn ext_enabled(e: &ICoreWebView2BrowserExtension) -> bool {
        unsafe {
            let mut b = BOOL::default();
            e.IsEnabled(&mut b).is_ok() && b.as_bool()
        }
    }

    /// Exécute `f` sur le fil de la vue et attend sa réponse (10 s max).
    fn run<T: Send + 'static>(
        wv: &Webview,
        f: impl FnOnce(ICoreWebView2Profile7, Sender<Result<T, String>>) + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = channel::<Result<T, String>>();
        wv.with_webview(move |pw| match profile(&pw) {
            Ok(p) => f(p, tx),
            Err(e) => {
                let _ = tx.send(Err(format!("profil WebView2 indisponible : {e}")));
            }
        })
        .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "le moteur n'a pas répondu".to_string())?
    }

    /// Applique `action` à l'extension `id` du profil.
    fn with_ext(
        wv: &Webview,
        id: String,
        action: impl FnOnce(ICoreWebView2BrowserExtension, Sender<Result<(), String>>) + Send + 'static,
    ) -> Result<(), String> {
        run(wv, move |p, tx| {
            let tx2 = tx.clone();
            let handler = ProfileGetBrowserExtensionsCompletedHandler::create(Box::new(move |res, list| {
                let found = (|| {
                    res.ok()?;
                    let list = list?;
                    let mut n = 0u32;
                    unsafe { list.Count(&mut n).ok()? };
                    (0..n).find_map(|i| unsafe { list.GetValueAtIndex(i).ok() }.filter(|e| ext_id(e) == id))
                })();
                match found {
                    Some(e) => action(e, tx2),
                    None => {
                        let _ = tx2.send(Err("extension introuvable".into()));
                    }
                }
                Ok(())
            }));
            if let Err(e) = unsafe { p.GetBrowserExtensions(&handler) } {
                let _ = tx.send(Err(e.to_string()));
            }
        })
    }

    pub fn add(wv: &Webview, path: String) -> Result<String, String> {
        run(wv, move |p, tx| {
            let tx2 = tx.clone();
            let handler = ProfileAddBrowserExtensionCompletedHandler::create(Box::new(move |res, ext| {
                let _ = match (res, ext) {
                    (Ok(()), Some(e)) => tx2.send(Ok(ext_id(&e))),
                    (Err(e), _) => tx2.send(Err(format!("installation refusée par le moteur : {e}"))),
                    _ => tx2.send(Err("installation refusée par le moteur".into())),
                };
                Ok(())
            }));
            let path = HSTRING::from(path.as_str());
            if let Err(e) = unsafe { p.AddBrowserExtension(&path, &handler) } {
                let _ = tx.send(Err(e.to_string()));
            }
        })
    }

    pub fn list(wv: &Webview) -> Result<Vec<ProfileExt>, String> {
        run(wv, move |p, tx| {
            let tx2 = tx.clone();
            let handler = ProfileGetBrowserExtensionsCompletedHandler::create(Box::new(move |res, list| {
                let mut out = Vec::new();
                if res.is_ok() {
                    if let Some(list) = list {
                        let mut n = 0u32;
                        if unsafe { list.Count(&mut n) }.is_ok() {
                            for i in 0..n {
                                if let Ok(e) = unsafe { list.GetValueAtIndex(i) } {
                                    out.push((ext_id(&e), ext_name(&e), ext_enabled(&e)));
                                }
                            }
                        }
                    }
                }
                let _ = tx2.send(Ok(out));
                Ok(())
            }));
            if let Err(e) = unsafe { p.GetBrowserExtensions(&handler) } {
                let _ = tx.send(Err(e.to_string()));
            }
        })
    }

    pub fn set_enabled(wv: &Webview, id: String, enabled: bool) -> Result<(), String> {
        with_ext(wv, id, move |e, tx| {
            let tx2 = tx.clone();
            let handler = BrowserExtensionEnableCompletedHandler::create(Box::new(move |res| {
                let _ = tx2.send(res.map_err(|e| e.to_string()));
                Ok(())
            }));
            if let Err(err) = unsafe { e.Enable(enabled, &handler) } {
                let _ = tx.send(Err(err.to_string()));
            }
        })
    }

    pub fn remove(wv: &Webview, id: String) -> Result<(), String> {
        with_ext(wv, id, move |e, tx| {
            let tx2 = tx.clone();
            let handler = BrowserExtensionRemoveCompletedHandler::create(Box::new(move |res| {
                let _ = tx2.send(res.map_err(|e| e.to_string()));
                Ok(())
            }));
            if let Err(err) = unsafe { e.Remove(&handler) } {
                let _ = tx.send(Err(err.to_string()));
            }
        })
    }
}

#[cfg(not(windows))]
mod platform {
    use super::ProfileExt;
    use tauri::Webview;
    const MSG: &str = "Les extensions Chrome ne sont disponibles que sous Windows (le moteur de Safari, utilisé sur Mac, ne les accepte pas).";
    pub fn add(_: &Webview, _: String) -> Result<String, String> {
        Err(MSG.into())
    }
    pub fn list(_: &Webview) -> Result<Vec<ProfileExt>, String> {
        Ok(Vec::new())
    }
    pub fn set_enabled(_: &Webview, _: String, _: bool) -> Result<(), String> {
        Err(MSG.into())
    }
    pub fn remove(_: &Webview, _: String) -> Result<(), String> {
        Err(MSG.into())
    }
}

pub fn profile_add(wv: &Webview, dir: &Path) -> Result<String, String> {
    platform::add(wv, dir.to_string_lossy().to_string())
}
pub fn profile_list(wv: &Webview) -> Result<Vec<ProfileExt>, String> {
    platform::list(wv)
}
pub fn profile_set_enabled(wv: &Webview, id: &str, enabled: bool) -> Result<(), String> {
    platform::set_enabled(wv, id.to_string(), enabled)
}
pub fn profile_remove(wv: &Webview, id: &str) -> Result<(), String> {
    platform::remove(wv, id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ids() {
        assert_eq!(
            parse_id("https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh?hl=fr").as_deref(),
            Some("ddkjiahejlhfcafbddmgiahcphecmpfh")
        );
        assert_eq!(parse_id("cjpalhdlnbpafiamejdnhcphjbkeiagm").as_deref(), Some("cjpalhdlnbpafiamejdnhcphjbkeiagm"));
        assert_eq!(parse_id("bonjour"), None);
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"M"), "TQ==");
    }
}
