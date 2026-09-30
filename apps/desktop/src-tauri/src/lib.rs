use serde::Serialize;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::Command;

#[derive(Debug, Serialize)]
struct PlatformInfo {
    platform: &'static str,
    shell: &'static str,
    runtime_owner: &'static str,
}

#[derive(Debug, Serialize)]
struct RecoveryResult {
    ok: bool,
    operation: &'static str,
    payload: serde_json::Value,
}

fn run_recovery(operation: &'static str, command: &'static str) -> RecoveryResult {
    let cli = std::env::var_os("FORGE_CLI_PATH").unwrap_or_else(|| "forge".into());
    let home = std::env::var_os("FORGE_CONTROLLER_HOME").unwrap_or_else(|| {
        std::env::var_os("HOME").map(|value| format!("{}/.forge/controller", value.to_string_lossy()).into()).unwrap_or_default()
    });
    let result = Command::new(cli)
        .args(["recovery", command, "--controller-home"])
        .arg(home)
        .output();
    match result {
        Ok(output) => {
            let text = if output.stdout.is_empty() { output.stderr } else { output.stdout };
            let payload = serde_json::from_slice(&text).unwrap_or_else(|_| serde_json::json!({ "message": String::from_utf8_lossy(&text).trim() }));
            RecoveryResult { ok: output.status.success(), operation, payload }
        }
        Err(error) => RecoveryResult { ok: false, operation, payload: serde_json::json!({ "error": error.to_string() }) },
    }
}

fn read_local_bridge_bootstrap() -> Result<serde_json::Value, String> {
    let mut root = TcpStream::connect("127.0.0.1:8766").map_err(|error| error.to_string())?;
    root.write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1:8766\r\nConnection: close\r\n\r\n").map_err(|error| error.to_string())?;
    let mut root_response = Vec::new();
    root.read_to_end(&mut root_response).map_err(|error| error.to_string())?;
    let root_text = String::from_utf8_lossy(&root_response);
    let token = root_text.lines().find_map(|line| {
        let value = line.strip_prefix("Set-Cookie:")?.trim();
        value.strip_prefix("forge_local_token=")?.split(';').next().map(str::to_owned)
    }).ok_or_else(|| "LOCAL_BRIDGE_TOKEN_MISSING".to_string())?;
    let mut api = TcpStream::connect("127.0.0.1:8766").map_err(|error| error.to_string())?;
    api.write_all(format!("GET /api/client/v3/bootstrap HTTP/1.1\r\nHost: 127.0.0.1:8766\r\nConnection: close\r\nX-Forge-Local-Token: {token}\r\n\r\n").as_bytes()).map_err(|error| error.to_string())?;
    let mut api_response = Vec::new();
    api.read_to_end(&mut api_response).map_err(|error| error.to_string())?;
    let separator = api_response.windows(4).position(|window| window == b"\r\n\r\n").ok_or_else(|| "LOCAL_BRIDGE_RESPONSE_INVALID".to_string())?;
    serde_json::from_slice(&api_response[separator + 4..]).map_err(|error| format!("LOCAL_BRIDGE_JSON_INVALID:{error}"))
}

fn local_bridge_token() -> Result<String, String> {
    let mut root = TcpStream::connect("127.0.0.1:8766").map_err(|error| error.to_string())?;
    root.write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1:8766\r\nConnection: close\r\n\r\n").map_err(|error| error.to_string())?;
    let mut response = Vec::new();
    root.read_to_end(&mut response).map_err(|error| error.to_string())?;
    String::from_utf8_lossy(&response).lines().find_map(|line| {
        let value = line.strip_prefix("Set-Cookie:")?.trim();
        value.strip_prefix("forge_local_token=")?.split(';').next().map(str::to_owned)
    }).ok_or_else(|| "LOCAL_BRIDGE_TOKEN_MISSING".to_string())
}

fn start_local_bridge_work(objective: String) -> Result<serde_json::Value, String> {
    let objective = objective.trim();
    if objective.is_empty() || objective.len() > 2_000 { return Err("WORK_OBJECTIVE_INVALID".to_string()); }
    let token = local_bridge_token()?;
    let body = serde_json::to_vec(&serde_json::json!({ "objective": objective, "scopeClear": true })).map_err(|error| error.to_string())?;
    let mut api = TcpStream::connect("127.0.0.1:8766").map_err(|error| error.to_string())?;
    let request = format!("POST /api/console/work/start HTTP/1.1\r\nHost: 127.0.0.1:8766\r\nConnection: close\r\nContent-Type: application/json\r\nX-Forge-Local-Token: {token}\r\nContent-Length: {}\r\n\r\n", body.len());
    api.write_all(request.as_bytes()).and_then(|_| api.write_all(&body)).map_err(|error| error.to_string())?;
    let mut response = Vec::new();
    api.read_to_end(&mut response).map_err(|error| error.to_string())?;
    let separator = response.windows(4).position(|window| window == b"\r\n\r\n").ok_or_else(|| "LOCAL_BRIDGE_RESPONSE_INVALID".to_string())?;
    let status = String::from_utf8_lossy(&response[..separator]).lines().next().unwrap_or_default().to_string();
    let payload: serde_json::Value = serde_json::from_slice(&response[separator + 4..]).map_err(|error| format!("LOCAL_BRIDGE_JSON_INVALID:{error}"))?;
    if !status.contains(" 2") { return Err(payload.get("error").and_then(serde_json::Value::as_str).unwrap_or("WORK_START_FAILED").to_string()); }
    Ok(payload)
}

fn connect_local_bridge_provider(profile_dir: Option<String>) -> Result<serde_json::Value, String> {
    let token = local_bridge_token()?;
    let mut api = TcpStream::connect("127.0.0.1:8766").map_err(|error| error.to_string())?;
    let body = match profile_dir.filter(|value| !value.trim().is_empty()) {
        Some(profile_dir) => serde_json::to_vec(&serde_json::json!({ "profileDir": profile_dir })).map_err(|error| error.to_string())?,
        None => Vec::new(),
    };
    let request = format!("POST /api/client/v3/provider/connect HTTP/1.1\r\nHost: 127.0.0.1:8766\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-Forge-Local-Token: {token}\r\n\r\n", body.len());
    api.write_all(request.as_bytes()).and_then(|_| api.write_all(&body)).map_err(|error| error.to_string())?;
    let mut response = Vec::new();
    api.read_to_end(&mut response).map_err(|error| error.to_string())?;
    let separator = response.windows(4).position(|window| window == b"\r\n\r\n").ok_or_else(|| "LOCAL_BRIDGE_RESPONSE_INVALID".to_string())?;
    let status = String::from_utf8_lossy(&response[..separator]).lines().next().unwrap_or_default().to_string();
    let payload: serde_json::Value = serde_json::from_slice(&response[separator + 4..]).map_err(|error| format!("LOCAL_BRIDGE_JSON_INVALID:{error}"))?;
    if !status.contains(" 2") {
        return Err(payload.get("error").and_then(serde_json::Value::as_str).unwrap_or("PROVIDER_CONNECT_FAILED").to_string());
    }
    Ok(payload)
}

fn choose_provider_profile() -> Result<String, String> {
    if std::env::consts::OS != "macos" { return Err("PROFILE_PICKER_UNSUPPORTED_PLATFORM".to_string()); }
    let output = Command::new("osascript")
        .args(["-e", "POSIX path of (choose folder with prompt \"Choose the Chrome user-data directory for Forge\")"])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() { return Err("PROFILE_PICKER_CANCELLED".to_string()); }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() { return Err("PROFILE_PICKER_EMPTY".to_string()); }
    Ok(path)
}

fn send_local_bridge_message(prompt: String, session_id: Option<String>) -> Result<serde_json::Value, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() || prompt.len() > 20_000 { return Err("LOCAL_MESSAGE_INVALID".to_string()); }
    let token = local_bridge_token()?;
    let mut api = TcpStream::connect("127.0.0.1:8766").map_err(|error| error.to_string())?;
    let mut payload = serde_json::json!({ "prompt": prompt });
    if let Some(session_id) = session_id.filter(|value| !value.trim().is_empty()) {
        payload["sessionId"] = serde_json::Value::String(session_id);
    }
    let body = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
    let request = format!("POST /api/client/v3/local/message HTTP/1.1\r\nHost: 127.0.0.1:8766\r\nConnection: close\r\nContent-Type: application/json\r\nX-Forge-Local-Token: {token}\r\nContent-Length: {}\r\n\r\n", body.len());
    api.write_all(request.as_bytes()).and_then(|_| api.write_all(&body)).map_err(|error| error.to_string())?;
    let mut response = Vec::new();
    api.read_to_end(&mut response).map_err(|error| error.to_string())?;
    let separator = response.windows(4).position(|window| window == b"\r\n\r\n").ok_or_else(|| "LOCAL_BRIDGE_RESPONSE_INVALID".to_string())?;
    let status = String::from_utf8_lossy(&response[..separator]).lines().next().unwrap_or_default().to_string();
    let result: serde_json::Value = serde_json::from_slice(&response[separator + 4..]).map_err(|error| format!("LOCAL_BRIDGE_JSON_INVALID:{error}"))?;
    if !status.contains(" 2") { return Err(result.get("error").and_then(serde_json::Value::as_str).unwrap_or("LOCAL_MESSAGE_FAILED").to_string()); }
    Ok(result)
}

fn read_local_bridge_work_detail(work_id: String) -> Result<serde_json::Value, String> {
    let work_id = work_id.trim();
    if work_id.is_empty() || work_id.len() > 200 || work_id.contains('/') || work_id.contains(' ') { return Err("WORK_ID_INVALID".to_string()); }
    let token = local_bridge_token()?;
    let mut api = TcpStream::connect("127.0.0.1:8766").map_err(|error| error.to_string())?;
    api.write_all(format!("GET /api/client/v3/work/{work_id} HTTP/1.1\r\nHost: 127.0.0.1:8766\r\nConnection: close\r\nX-Forge-Local-Token: {token}\r\n\r\n").as_bytes()).map_err(|error| error.to_string())?;
    let mut response = Vec::new();
    api.read_to_end(&mut response).map_err(|error| error.to_string())?;
    let separator = response.windows(4).position(|window| window == b"\r\n\r\n").ok_or_else(|| "LOCAL_BRIDGE_RESPONSE_INVALID".to_string())?;
    let status = String::from_utf8_lossy(&response[..separator]).lines().next().unwrap_or_default().to_string();
    let result: serde_json::Value = serde_json::from_slice(&response[separator + 4..]).map_err(|error| format!("LOCAL_BRIDGE_JSON_INVALID:{error}"))?;
    if !status.contains(" 2") { return Err(result.get("error").and_then(serde_json::Value::as_str).unwrap_or("WORK_DETAIL_FAILED").to_string()); }
    Ok(result)
}

#[tauri::command]
fn platform_info() -> PlatformInfo {
    PlatformInfo {
        platform: "macos",
        shell: "tauri",
        runtime_owner: "forge-runtime-and-standalone-recovery",
    }
}

#[tauri::command]
fn recovery_status() -> RecoveryResult {
    run_recovery("status", "status")
}

#[tauri::command]
fn recovery_restart_runtime() -> RecoveryResult {
    run_recovery("restart_runtime", "restart-runtime")
}

#[tauri::command]
fn local_bridge_bootstrap() -> Result<serde_json::Value, String> {
    read_local_bridge_bootstrap()
}

#[tauri::command]
fn local_bridge_start_work(objective: String) -> Result<serde_json::Value, String> {
    start_local_bridge_work(objective)
}

#[tauri::command]
fn local_bridge_connect_provider(profile_dir: Option<String>) -> Result<serde_json::Value, String> {
    connect_local_bridge_provider(profile_dir)
}

#[tauri::command]
fn local_bridge_choose_provider_profile() -> Result<String, String> {
    choose_provider_profile()
}

#[tauri::command]
fn local_bridge_local_message(prompt: String, session_id: Option<String>) -> Result<serde_json::Value, String> {
    send_local_bridge_message(prompt, session_id)
}

#[tauri::command]
fn local_bridge_work_detail(work_id: String) -> Result<serde_json::Value, String> {
    read_local_bridge_work_detail(work_id)
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![platform_info, recovery_status, recovery_restart_runtime, local_bridge_bootstrap, local_bridge_start_work, local_bridge_connect_provider, local_bridge_choose_provider_profile, local_bridge_local_message, local_bridge_work_detail])
        .run(tauri::generate_context!())
        .expect("error while running Forge V3 desktop");
}
