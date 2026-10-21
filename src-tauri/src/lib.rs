mod scanner;

use scanner::Scanner;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Emitter, Manager, State};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// Closing the window keeps Prisca in the tray (set by the window from its settings).
static KEEP_IN_TRAY: AtomicBool = AtomicBool::new(false);

struct AppState {
    scanner: Scanner,
    /// A second helper for text recognition, so reading a page never holds up the next scan.
    reader: Scanner,
    /// A third helper for printing, so a print job never waits for a scan or the text reader.
    printer: Scanner,
    scan_dir: PathBuf,
    /// Files and switches Prisca was started with (right-click menu, Prisca printer), until the window takes them.
    startup_args: Mutex<Vec<String>>,
}

/// Command-line words that mean something to the window: --print/--add <file>, --inbox.
fn useful_args(args: impl IntoIterator<Item = String>) -> Vec<String> {
    args.into_iter().skip(1).filter(|a| !a.is_empty()).collect()
}

/// What Prisca was started with (taken once).
#[tauri::command]
fn take_startup_args(state: State<'_, AppState>) -> Vec<String> {
    state.startup_args.lock().map(|mut v| std::mem::take(&mut *v)).unwrap_or_default()
}

/// Renders a PDF's pages to pictures (Windows' own PDF renderer) for the batch.
#[tauri::command]
async fn pdf_pages(app: tauri::AppHandle, path: String, dpi: u32, max: u32) -> Result<Value, String> {
    let reply = blocking(app, move |s| {
        let out = s.scan_dir.to_string_lossy().to_string();
        s.printer.request(json!({ "cmd": "pdf", "path": path, "dpi": dpi, "max": max, "out": out }), secs(600))
    })
    .await?;
    check(reply)
}

/// Where the Prisca printer drops what other apps print.
fn inbox_dir() -> PathBuf {
    let base = std::env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\ProgramData"));
    base.join("Prisca").join("inbox")
}

/// Moves finished print jobs out of the Prisca printer's folder into the scan folder.
/// A job Windows is still writing can't be moved yet and is left for the next look.
#[tauri::command]
fn inbox_take(state: State<'_, AppState>) -> Value {
    let dir = inbox_dir();
    let mut taken = Vec::new();
    let mut waiting = 0;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            let is_pdf = p.extension().map_or(false, |x| x.eq_ignore_ascii_case("pdf"));
            let meta = e.metadata().ok();
            let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            if !is_pdf || len == 0 {
                continue;
            }
            // Still being written (or only just finished): look again shortly.
            let fresh = meta
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .map_or(false, |d| d < std::time::Duration::from_millis(1500));
            if fresh {
                waiting += 1;
                continue;
            }
            let n = OCR_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let dest = state.scan_dir.join(format!("printed-{n}.pdf"));
            let moved = std::fs::rename(&p, &dest).is_ok()
                || (std::fs::copy(&p, &dest).is_ok() && std::fs::remove_file(&p).map_err(|_| { let _ = std::fs::remove_file(&dest); }).is_ok());
            if moved { taken.push(dest.to_string_lossy().to_string()); } else { waiting += 1; }
        }
    }
    json!({ "files": taken, "waiting": waiting, "folder": dir.to_string_lossy() })
}

/// Is the Prisca printer set up (printer, its folder, the task that opens Prisca)?
#[tauri::command]
async fn printer_setup_state(app: tauri::AppHandle) -> Result<Value, String> {
    let inbox = inbox_dir().to_string_lossy().to_string();
    let reply = blocking(app, move |s| {
        s.printer.request(json!({ "cmd": "prisca-printer", "mode": "state", "inbox": inbox }), secs(60))
    })
    .await?;
    check(reply)
}

/// Adds or removes the Prisca printer. Windows asks for permission once (administrator).
#[tauri::command]
async fn printer_setup(app: tauri::AppHandle, mode: String) -> Result<Value, String> {
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let inbox = inbox_dir().to_string_lossy().to_string();
    let reply = blocking(app, move |s| {
        s.printer.request(json!({ "cmd": "prisca-printer", "mode": mode, "exe": exe, "inbox": inbox }), secs(300))
    })
    .await?;
    check(reply)
}

// ---------- Background: tray, shortcut, start with Windows ----------

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Brings the window forward (a print job arrived while Prisca was in the tray).
#[tauri::command]
fn show_window(app: tauri::AppHandle) {
    show_main(&app);
}

#[tauri::command]
fn set_keep_in_tray(on: bool) {
    KEEP_IN_TRAY.store(on, Ordering::SeqCst);
}

/// Starts Prisca (in the tray) when Windows starts.
#[tauri::command]
fn set_autostart(app: tauri::AppHandle, on: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let m = app.autolaunch();
    if on { m.enable() } else { m.disable() }.map_err(|e| e.to_string())?;
    m.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn autostart_state(app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

fn scan_shortcut() -> tauri_plugin_global_shortcut::Shortcut {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyS)
}

/// Ctrl+Alt+S from any app: Prisca comes forward and scans. Only this key combination is taken.
#[tauri::command]
fn set_scan_hotkey(app: tauri::AppHandle, on: bool) -> Result<bool, String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    let sc = scan_shortcut();
    if on {
        if !gs.is_registered(sc) {
            gs.register(sc).map_err(|_| "Ctrl+Alt+S is already used by another app, so it can't scan from anywhere.".to_string())?;
        }
    } else if gs.is_registered(sc) {
        let _ = gs.unregister(sc);
    }
    Ok(on)
}

// ---------- Print history ----------

fn history_path(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("Prisca")).join("history")
}

/// Folder that keeps a PDF of each printed job, for "Print again".
#[tauri::command]
fn history_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = history_path(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// Deletes one old history PDF (only inside the history folder).
#[tauri::command]
fn history_delete(app: tauri::AppHandle, path: String) {
    let p = PathBuf::from(&path);
    if p.starts_with(history_path(&app)) {
        let _ = std::fs::remove_file(p);
    }
}

// ---------- Printer queue, clipboard ----------

/// What Windows is holding for a printer.
#[tauri::command]
async fn print_queue(app: tauri::AppHandle, printer: String) -> Result<Value, String> {
    let reply = blocking(app, move |s| s.printer.request(json!({ "cmd": "queue", "printer": printer }), secs(60))).await?;
    check(reply)
}

/// Cancels one job (id) or all of them (id = 0) on a printer.
#[tauri::command]
async fn print_queue_cancel(app: tauri::AppHandle, printer: String, id: i64) -> Result<Value, String> {
    let reply = blocking(app, move |s| {
        s.printer.request(json!({ "cmd": "queue-cancel", "printer": printer, "id": id }), secs(120))
    })
    .await?;
    check(reply)
}

/// Puts saved files on the clipboard, to paste into WhatsApp, email or a folder.
#[tauri::command]
async fn copy_files(app: tauri::AppHandle, paths: Vec<String>) -> Result<Value, String> {
    let reply = blocking(app, move |s| s.printer.request(json!({ "cmd": "clip-files", "paths": paths }), secs(60))).await?;
    check(reply)
}

#[cfg(windows)]
const MENU_EXTS: [&str; 10] = [".pdf", ".png", ".jpg", ".jpeg", ".bmp", ".webp", ".gif", ".tif", ".tiff", ".jfif"];

/// "Print with Prisca" and "Open in Prisca" on PDFs and pictures (this user only, no admin).
#[tauri::command]
fn context_menu(on: bool) -> Result<bool, String> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let exe = std::env::current_exe().map_err(|e| e.to_string())?.to_string_lossy().to_string();
        for ext in MENU_EXTS {
            let base = format!("Software\\Classes\\SystemFileAssociations\\{ext}\\shell");
            for (verb, label, flag) in [("Prisca.Print", "Print with Prisca", "--print"), ("Prisca.Open", "Open in Prisca", "--add")] {
                let key = format!("{base}\\{verb}");
                if on {
                    let (k, _) = hkcu.create_subkey(&key).map_err(|e| e.to_string())?;
                    k.set_value("", &label).map_err(|e| e.to_string())?;
                    k.set_value("Icon", &format!("\"{exe}\",0")).map_err(|e| e.to_string())?;
                    let (c, _) = hkcu.create_subkey(format!("{key}\\command")).map_err(|e| e.to_string())?;
                    c.set_value("", &format!("\"{exe}\" {flag} \"%1\"")).map_err(|e| e.to_string())?;
                } else {
                    let _ = hkcu.delete_subkey_all(&key);
                }
            }
        }
        Ok(on)
    }
    #[cfg(not(windows))]
    {
        let _ = on;
        Err("The right-click menu is a Windows feature.".into())
    }
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
        let r = s.reader.request(json!({ "cmd": "ocr", "path": path.to_string_lossy() }), secs(90));
        let _ = std::fs::remove_file(&path);
        r
    })
    .await?;
    check(reply)
}

/// Printers Windows knows about (name, default, state).
#[tauri::command]
async fn list_printers(app: tauri::AppHandle) -> Result<Value, String> {
    let reply = blocking(app, |s| s.printer.request(json!({ "cmd": "printers" }), secs(60))).await?;
    check(reply)
}

/// A printer's paper sizes, and the edge it can't print on for one paper size (0 = its default).
#[tauri::command]
async fn printer_info(app: tauri::AppHandle, name: String, paper: i64) -> Result<Value, String> {
    let reply = blocking(app, move |s| {
        s.printer.request(json!({ "cmd": "printer", "name": name, "paper": paper }), secs(60))
    })
    .await?;
    check(reply)
}

/// Writes one page picture for a print job (body: JPEG) and returns its path.
#[tauri::command]
fn stage_print(state: State<'_, AppState>, request: Request<'_>) -> Result<String, String> {
    let bytes: Vec<u8> = match request.body() {
        InvokeBody::Raw(b) => b.clone(),
        InvokeBody::Json(v) => serde_json::from_value(v.clone()).map_err(|e| e.to_string())?,
    };
    let n = OCR_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let path = state.scan_dir.join(format!("print-{n}.jpg"));
    std::fs::write(&path, &bytes).map_err(|e| format!("Couldn't prepare the page for printing: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// Prints sheets laid out by the window: every picture at an exact place in mm.
#[tauri::command]
async fn print_job(app: tauri::AppHandle, job: Value) -> Result<Value, String> {
    // Big jobs on a slow printer take a while to hand over to Windows.
    let reply = blocking(app, move |s| s.printer.request(json!({ "cmd": "print", "job": job }), secs(900))).await?;
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

/// Lets go of the scanner after a quiet spell (it stays connected between scans in a batch).
#[tauri::command]
async fn release_scanner(app: tauri::AppHandle) -> Result<(), String> {
    blocking(app, |s| s.scanner.request(json!({ "cmd": "release" }), secs(20)).map(|_| ())).await
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

/// The last lines of the scanner diagnostics log (for problem reports).
#[tauri::command]
fn scanner_log_tail(app: tauri::AppHandle, lines: usize) -> String {
    let text = std::fs::read_to_string(cache_dir(&app).join("scanner.log")).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(lines.min(500));
    all[start..].join("\n")
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

/// Run by the uninstaller: right-click menu out, the Prisca printer and its task removed.
fn uninstall_cleanup() {
    let _ = context_menu(false);
    let helper = Scanner::new(std::env::temp_dir().join("Prisca"));
    let inbox = inbox_dir().to_string_lossy().to_string();
    let _ = helper.request(json!({ "cmd": "prisca-printer", "mode": "remove", "inbox": inbox, "exe": "" }), secs(300));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if std::env::args().any(|a| a == "--uninstall") {
        uninstall_cleanup();
        return;
    }
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
    // One Prisca: a second start (right-click menu, the Prisca printer) hands its files to the open window.
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        let args = useful_args(argv);
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        let _ = app.emit("prisca://args", args);
    }));
    if updater {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--background"])))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        show_main(app);
                        let _ = app.emit("prisca://scan", ());
                    }
                })
                .build(),
        )
        .on_window_event(|w, e| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                if KEEP_IN_TRAY.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = w.hide();
                }
            }
        })
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
            app.manage(AppState {
                scanner: Scanner::new(cache.clone()),
                reader: Scanner::new(cache.clone()),
                printer: Scanner::new(cache),
                scan_dir,
                startup_args: Mutex::new(useful_args(std::env::args())),
            });
            // Tray: open, scan, quit. Closing the window can keep Prisca here (setting).
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
                let open = MenuItem::with_id(app, "open", "Open Prisca", true, None::<&str>)?;
                let scan = MenuItem::with_id(app, "scan", "Scan now (Ctrl+Alt+S)", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit Prisca", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&open, &scan, &quit])?;
                let mut tray = TrayIconBuilder::with_id("main")
                    .tooltip("Prisca")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, e| match e.id.as_ref() {
                        "open" => show_main(app),
                        "scan" => {
                            show_main(app);
                            let _ = app.emit("prisca://scan", ());
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, e| {
                        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                            show_main(tray.app_handle());
                        }
                    });
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                tray.build(app)?;
            }
            // Started with Windows: wait in the tray.
            if std::env::args().any(|a| a == "--background") {
                KEEP_IN_TRAY.store(true, Ordering::SeqCst);
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_devices,
            scan,
            ocr_page,
            cancel_scan,
            probe_scanner,
            release_scanner,
            scanner_log_path,
            scanner_log_tail,
            read_file,
            discard_scan,
            save_file,
            default_folder,
            next_number,
            path_exists,
            list_printers,
            printer_info,
            stage_print,
            print_job,
            take_startup_args,
            pdf_pages,
            inbox_take,
            printer_setup_state,
            printer_setup,
            context_menu,
            show_window,
            set_keep_in_tray,
            set_autostart,
            autostart_state,
            set_scan_hotkey,
            history_dir,
            history_delete,
            print_queue,
            print_queue_cancel,
            copy_files
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
