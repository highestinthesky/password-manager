// Prevents an extra console window on Windows in release; harmless on macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tauri::command]
fn set_app_icon(bytes: Vec<u8>) -> Result<(), String> {
    set_platform_app_icon(&bytes)
}

#[cfg(target_os = "macos")]
fn set_platform_app_icon(bytes: &[u8]) -> Result<(), String> {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let mtm = unsafe { MainThreadMarker::new_unchecked() };
    let app = NSApplication::sharedApplication(mtm);
    let data = NSData::with_bytes(bytes);
    let icon = NSImage::initWithData(NSImage::alloc(), &data)
        .ok_or_else(|| "failed to decode icon".to_string())?;
    unsafe { app.setApplicationIconImage(Some(&icon)) };
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn set_platform_app_icon(_bytes: &[u8]) -> Result<(), String> {
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![set_app_icon])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
