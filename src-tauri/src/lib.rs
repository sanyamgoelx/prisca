mod scanner;

use scanner::Scanner;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Manager, State};

struct AppState {
    scanner: Scanner,
    scan_dir: PathBuf,
}

/// Scanners Windows knows about.
#[tauri::command]
async fn list_devices(app: tauri::AppHandle) -> Result<Value, String> {
    let reply = blocking(app, |s| s.scanner.request(json!({ "cmd": "devices" }), secs(60))).await?;
    check(reply)
}

/// Scans one page (flatbed) or every page in the feeder.
#[tauri::command]
async fn scan(
    app: tauri::AppHandle,
    device: String,
    device_name: Option<String>,
    dpi: u32,
    intent: String,
    source: String,
) -> Result<Value, String> {
    let reply = blocking(app, move |s| {
        let out = s.scan_dir.to_string_lossy().to_string();
        // A whole feeder at high resolution on USB can take a long time.
        let limit = if source == "feeder" { secs(3600) } else { secs(600) };
        s.scanner.request(
            json!({
                "cmd": "scan", "device": device, "deviceName": device_name.unwrap_or_default(),
                "dpi": dpi, "intent": intent, "source": source, "out": out
            }),
            limit,
        )
    })
    .await?;
    check(reply)
}

/// Recognises the text on one page (Windows OCR). Body: the page as a JPEG.
#[tauri::command]
async fn ocr_page(app: tauri::AppHandle, request: Request<'_>) -> Result<Value, String> {
    let bytes: Vec<u8> = match request.body() {
        InvokeBody::Raw(b) => b.clone(),
        InvokeBody::Json(v) => serde_json::from_value(v.clone()).map_err(|e| e.to_string())?,
    };
    let reply = blocking(app, move |s| {
        let n = OCR_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let path = s.scan_dir.join(format!("ocr-{n}.jpg"));
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
        let r = s.scanner.request(json!({ "cmd": "ocr", "path": path.to_string_lossy() }), secs(90));
        let _ = std::fs::remove_file(&path);
        r
    })
    .await?;
    check(reply)
}

static OCR_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[tauri::command]
async fn cancel_scan(app: tauri::AppHandle) -> Result<(), String> {
    // Off the main thread: ending the worker waits for taskkill.
    tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().scanner.cancel())
        .await
        .map_err(|e| e.to_string())
}

/// Everything the scanner's driver reports about itself (for diagnosing odd scanners).
#[tauri::command]
async fn probe_scanner(app: tauri::AppHandle, device: String, device_name: Option<String>) -> Result<Value, String> {
    let reply = blocking(app, move |s| {
        s.scanner.request(
            json!({ "cmd": "probe", "device": device, "deviceName": device_name.unwrap_or_default() }),
            secs(60),
        )
    })
    .await?;
    check(reply)
}

/// Where the scanner diagnostics log lives.
#[tauri::command]
fn scanner_log_path(app: tauri::AppHandle) -> String {
    cache_dir(&app).join("scanner.log").to_string_lossy().to_string()
}

fn secs(n: u64) -> std::time::Duration {
    std::time::Duration::from_secs(n)
}

fn cache_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_cache_dir().unwrap_or_else(|_| std::env::temp_dir().join("Prisca"))
}

/// Raw bytes of a file (scans and imported pictures).
#[tauri::command]
async fn read_file(path: String) -> Result<Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Couldn't read {path}: {e}"))?;
    Ok(Response::new(bytes))
}

/// Deletes a temporary scan once it has been loaded.
#[tauri::command]
fn discard_scan(state: State<'_, AppState>, path: String) {
    let p = PathBuf::from(&path);
    if p.starts_with(&state.scan_dir) {
        let _ = std::fs::remove_file(p);
    }
}

/// Writes a file. Path in the `x-path` header (URL-encoded), bytes in the body.
#[tauri::command]
fn save_file(request: Request<'_>) -> Result<String, String> {
    let raw = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing path")?;
    let path = PathBuf::from(percent_decode(raw));
    // If the webview fell back to JSON IPC, bytes arrive as a number array.
    let bytes: Vec<u8> = match request.body() {
        InvokeBody::Raw(b) => b.clone(),
        InvokeBody::Json(v) => serde_json::from_value(v.clone()).map_err(|e| e.to_string())?,
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't make the folder: {e}"))?;
    }
    std::fs::write(&path, bytes).map_err(|e| format!("Couldn't save {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

/// Default save folder: Documents\Prisca.
#[tauri::command]
fn default_folder(app: tauri::AppHandle) -> String {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("Prisca").to_string_lossy().to_string()
}

/// The next free number for "<prefix> NNN" in a folder (1 if none yet).
#[tauri::command]
fn next_number(folder: String, prefix: String) -> u32 {
    let mut max = 0u32;
    if let Ok(entries) = std::fs::read_dir(Path::new(&folder)) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Some(rest) = name.strip_prefix(&format!("{prefix} ")) {
                let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(n) = digits.parse::<u32>() {
                    max = max.max(n);
                }
            }
        }
    }
    max + 1
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// Runs a scanner call on a blocking thread so the window stays responsive.
async fn blocking<T: Send + 'static>(
    app: tauri::AppHandle,
    f: impl FnOnce(&AppState) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || f(app.state::<AppState>().inner()))
        .await
        .map_err(|e| format!("scanner helper crashed: {e}"))?
}

fn check(reply: Value) -> Result<Value, String> {
    if reply.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(reply)
    } else {
        // Keep the code so the window can react (e.g. "cancelled", "empty").
        Err(serde_json::to_string(&json!({
            "code": reply.get("code").cloned().unwrap_or(Value::from("unknown")),
            "error": reply.get("error").cloned().unwrap_or(Value::from("Scanning failed.")),
            "hresult": reply.get("hresult").cloned().unwrap_or(Value::Null),
        }))
        .unwrap())
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    // Updates are switched on once release-setup has put the signing key's
    // public half in tauri.conf.json (plugins.updater).
    let updater = context
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .map_or(false, |k| !k.is_empty());
    let mut builder = tauri::Builder::default();
    if updater {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let cache = cache_dir(app.handle());
            let scan_dir = cache.join("scans");
            // Keep the diagnostics log small.
            let log = cache.join("scanner.log");
            if std::fs::metadata(&log).map(|m| m.len() > 2_000_000).unwrap_or(false) {
                let _ = std::fs::remove_file(&log);
            }
            // Leftovers from last time.
            let _ = std::fs::remove_dir_all(&scan_dir);
            let _ = std::fs::create_dir_all(&scan_dir);
            app.manage(AppState { scanner: Scanner::new(cache), scan_dir });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_devices,
            scan,
            ocr_page,
            cancel_scan,
            probe_scanner,
            scanner_log_path,
            read_file,
            discard_scan,
            save_file,
            default_folder,
            next_number,
            path_exists
        ])
        .run(context)
        .expect("error while running Prisca");
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn decodes_paths() {
        assert_eq!(percent_decode("C%3A%5CScans%5Ca%20b.pdf"), "C:\\Scans\\a b.pdf");
        assert_eq!(percent_decode("%E0%A4%95.pdf"), "क.pdf");
        assert_eq!(percent_decode("100%"), "100%");
    }
}
