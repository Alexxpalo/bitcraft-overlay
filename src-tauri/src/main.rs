// Prevents console window on Windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::OnceLock;
use tauri::Manager;

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("bitcraft-overlay")
            .build()
            .expect("failed to build HTTP client")
    })
}

#[tauri::command]
async fn bitwasp(path: String) -> Result<serde_json::Value, String> {
    let url = format!("https://bitjita.com/api/{path}");
    let resp = http_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn toggle_always_on_top(window: tauri::Window) -> Result<bool, String> {
    let current = window.is_always_on_top().map_err(|e| e.to_string())?;
    let next = !current;
    window.set_always_on_top(next).map_err(|e| e.to_string())?;
    Ok(next)
}

#[tauri::command]
fn is_game_focused() -> bool {
    #[cfg(windows)]
    unsafe {
        use winapi::um::processthreadsapi::GetCurrentProcessId;
        use winapi::um::winuser::{GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId};
        let hwnd = GetForegroundWindow();
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == GetCurrentProcessId() {
            return true;
        }
        let mut buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if len <= 0 { return false; }
        let title = String::from_utf16_lossy(&buf[..len as usize]);
        title.to_ascii_lowercase().contains("bitcraft")
    }
    #[cfg(not(windows))]
    { true }
}

#[tauri::command]
fn set_window_size(window: tauri::Window, width: f64, height: f64) -> Result<(), String> {
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    std::process::exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            bitwasp,
            toggle_always_on_top,
            set_window_size,
            is_game_focused,
        ])
        .setup(|app| {
            // Dev-mode: watch src/ and reload all webview windows when files change
            #[cfg(debug_assertions)]
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    use std::collections::HashMap;
                    use std::time::{Duration, SystemTime};
                    let src = std::path::PathBuf::from("../src");
                    let mut stamps: HashMap<String, SystemTime> = HashMap::new();
                    loop {
                        std::thread::sleep(Duration::from_millis(600));
                        if let Ok(entries) = std::fs::read_dir(&src) {
                            let mut changed = false;
                            for e in entries.flatten() {
                                if let Ok(meta) = e.metadata() {
                                    if let Ok(t) = meta.modified() {
                                        let k = e.file_name().to_string_lossy().to_string();
                                        if stamps.get(&k).map_or(true, |old| *old != t) {
                                            if stamps.contains_key(&k) { changed = true; }
                                            stamps.insert(k, t);
                                        }
                                    }
                                }
                            }
                            if changed {
                                for (_, w) in handle.webview_windows() {
                                    let _ = w.eval("location.reload()");
                                }
                            }
                        }
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
