// Prevents console window on Windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Generic GET proxy to the Bitjita REST API, run server-side to avoid the
/// CORS restriction that blocks requests from the WebView.
#[tauri::command]
async fn bitjita(path: String) -> Result<serde_json::Value, String> {
    let url = format!("https://bitjita.com/api/{path}");
    let resp = reqwest::Client::new()
        .get(&url)
        .header("User-Agent", "bitcraft-overlay")
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

/// Returns true if the foreground window is BitCraft or one of our overlay windows.
/// JS uses this to auto-hide the overlay when the user switches to another app.
#[tauri::command]
fn is_game_focused() -> bool {
    #[cfg(windows)]
    unsafe {
        use winapi::um::processthreadsapi::GetCurrentProcessId;
        use winapi::um::winuser::{GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId};
        let hwnd = GetForegroundWindow();
        // If foreground window belongs to our process (any overlay panel) → stay visible
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == GetCurrentProcessId() {
            return true;
        }
        // Otherwise check if it's BitCraft by window title
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
            bitjita,
            toggle_always_on_top,
            set_window_size,
            is_game_focused,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
