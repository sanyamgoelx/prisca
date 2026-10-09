//! Talks to scanners through a long-lived PowerShell worker (scripts/wia.ps1)
//! that uses Windows Image Acquisition. One worker per app; requests are
//! serialised. Every request has a time limit; cancelling or timing out ends
//! the worker, and the next request starts a new one.
//!
//! Errors are returned as JSON text `{"code":..,"error":..}` so the window can
//! tell a cancel from a failure.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const SCRIPT: &str = include_str!("../scripts/wia.ps1");

struct Worker {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
}

pub struct Scanner {
    worker: Mutex<Option<Worker>>,
    pid: AtomicU32,
    next_id: AtomicU64,
    cancelled: AtomicBool,
    dir: PathBuf,
}

pub fn err_json(code: &str, msg: &str) -> String {
    json!({ "code": code, "error": msg }).to_string()
}

impl Scanner {
    pub fn new(cache_dir: PathBuf) -> Self {
        Scanner {
            worker: Mutex::new(None),
            pid: AtomicU32::new(0),
            next_id: AtomicU64::new(1),
            cancelled: AtomicBool::new(false),
            dir: cache_dir,
        }
    }

    fn spawn(&self) -> Result<Worker, String> {
        if !cfg!(windows) {
            return Err(err_json("unsupported", "Scanning works on Windows only. You can still add pictures."));
        }
        std::fs::create_dir_all(&self.dir).map_err(|e| err_json("io", &e.to_string()))?;
        let script = self.dir.join("prisca-wia.ps1");
        // UTF-8 with BOM so Windows PowerShell 5.1 reads it as UTF-8.
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(SCRIPT.as_bytes());
        std::fs::write(&script, bytes).map_err(|e| err_json("io", &e.to_string()))?;

        // The worker's diagnostics (settings used, driver errors) go to a log.
        let stderr = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join("scanner.log"))
            .map(Stdio::from)
            .unwrap_or_else(|_| Stdio::null());

        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| err_json("helper", &format!("Couldn't start the scanner helper (PowerShell): {e}")))?;
        let stdin = child.stdin.take().ok_or_else(|| err_json("helper", "no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| err_json("helper", "no stdout"))?;
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(l) => {
                        if tx.send(l).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        self.pid.store(child.id(), Ordering::SeqCst);
        let mut w = Worker { child, stdin, lines: rx };
        if let Err(e) = self.read_reply(&mut w, 0, Duration::from_secs(30)) {
            let _ = w.child.kill();
            return Err(e);
        }
        Ok(w)
    }

    /// Sends one request and waits (at most `timeout`) for its reply.
    pub fn request(&self, mut req: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        req["id"] = Value::from(id);
        let mut guard = self.worker.lock().map_err(|_| err_json("helper", "scanner lock poisoned"))?;
        self.cancelled.store(false, Ordering::SeqCst);
        for attempt in 0..2 {
            if guard.is_none() {
                *guard = Some(self.spawn()?);
            }
            let w = guard.as_mut().unwrap();
            let sent = writeln!(w.stdin, "{}", req).and_then(|_| w.stdin.flush());
            let result = match sent {
                Ok(()) => self.read_reply(w, id, timeout).map_err(|e| (e, false)),
                Err(e) => Err((err_json("helper", &format!("worker gone: {e}")), true)),
            };
            match result {
                Ok(v) => return Ok(v),
                Err((e, never_sent)) => {
                    if let Some(mut w) = guard.take() {
                        let _ = w.child.kill();
                    }
                    self.pid.store(0, Ordering::SeqCst);
                    // Retry only when the request never reached a worker.
                    if attempt == 0 && never_sent {
                        continue;
                    }
                    return Err(e);
                }
            }
        }
        Err(err_json("crashed", "The scanner helper stopped. Try again."))
    }

    fn read_reply(&self, w: &mut Worker, id: u64, timeout: Duration) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match w.lines.recv_timeout(left) {
                Ok(line) => {
                    let text = line.trim().trim_start_matches('\u{feff}');
                    if text.is_empty() {
                        continue;
                    }
                    let Ok(v) = serde_json::from_str::<Value>(text) else { continue };
                    if v.get("id").and_then(Value::as_u64) == Some(id) {
                        return Ok(v);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    return Err(err_json(
                        "timeout",
                        "The scanner stopped responding. Turn it off and on, then try again.",
                    ))
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(if self.cancelled.swap(false, Ordering::SeqCst) {
                        err_json("cancelled", "Scanning was cancelled.")
                    } else {
                        err_json("crashed", "The scanner helper stopped unexpectedly. Try again.")
                    })
                }
            }
        }
    }

    /// Stops a scan in progress by ending the worker process.
    pub fn cancel(&self) {
        let pid = self.pid.swap(0, Ordering::SeqCst);
        if pid == 0 {
            return;
        }
        self.cancelled.store(true, Ordering::SeqCst);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let pid_s = pid.to_string();
            let _ = Command::new("taskkill")
                .args(["/PID", pid_s.as_str(), "/T", "/F"])
                .creation_flags(0x0800_0000)
                .status();
        }
    }
}
