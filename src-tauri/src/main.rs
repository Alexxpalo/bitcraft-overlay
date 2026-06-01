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
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[tauri::command]
fn is_game_focused() -> bool {
    #[cfg(windows)]
    unsafe {
        use winapi::um::handleapi::CloseHandle;
        use winapi::um::processthreadsapi::{GetCurrentProcessId, OpenProcess};
        use winapi::um::winbase::QueryFullProcessImageNameW;
        use winapi::um::winnt::PROCESS_QUERY_LIMITED_INFORMATION;
        use winapi::um::winuser::{GetForegroundWindow, GetWindowThreadProcessId};

        let hwnd = GetForegroundWindow();
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        // Own window focused (e.g. user clicking the overlay) → keep visible.
        if pid == GetCurrentProcessId() {
            return true;
        }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(handle);
        if ok == 0 {
            return false;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let exe = path
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        exe.contains("bitcraft")
    }
    #[cfg(not(windows))]
    {
        true
    }
}

#[tauri::command]
fn set_window_size(window: tauri::Window, width: f64, height: f64) -> Result<(), String> {
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_updater::UpdaterExt;
    match app.updater().map_err(|e| e.to_string())?.check().await {
        Ok(Some(u)) => Ok(Some(u.version.to_string())),
        Ok(None)    => Ok(None),
        Err(e)      => Err(e.to_string()),
    }
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    if let Some(u) = app.updater().map_err(|e| e.to_string())?
        .check().await.map_err(|e| e.to_string())?
    {
        u.download_and_install(|_, _| {}, || {})
            .await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    std::process::exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            bitwasp,
            app_version,
            set_window_size,
            is_game_focused,
            check_for_update,
            install_update,
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
        .expect("error while running tauri application")
}
