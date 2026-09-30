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

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![platform_info, recovery_status, recovery_restart_runtime, local_bridge_bootstrap, local_bridge_start_work])
        .run(tauri::generate_context!())
        .expect("error while running Forge V3 desktop");
}
