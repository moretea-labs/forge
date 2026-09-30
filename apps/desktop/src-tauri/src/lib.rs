use serde::Serialize;

#[derive(Debug, Serialize)]
struct PlatformInfo {
    platform: &'static str,
    shell: &'static str,
    runtime_owner: &'static str,
}

#[tauri::command]
fn platform_info() -> PlatformInfo {
    PlatformInfo {
        platform: "macos",
        shell: "tauri",
        runtime_owner: "forge-runtime-and-standalone-recovery",
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![platform_info])
        .run(tauri::generate_context!())
        .expect("error while running Forge V3 desktop");
}
