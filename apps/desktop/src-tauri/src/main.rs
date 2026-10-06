#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use serde_json::{json, Value};
use std::{env, fs, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};

const MCP_PROTOCOL_VERSION: &str = "2026-07-28";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeServiceConfig {
    controller_home: String,
    host: String,
    port: u16,
    auth_token_file: String,
}

fn controller_home() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("FORGE_CONTROLLER_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    if let Some(path) = env::var_os("XDG_STATE_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path).join("forge").join("controller"));
    }
    dirs::home_dir()
        .map(|home| home.join(".forge").join("controller"))
        .ok_or_else(|| "FORGE_DESKTOP_CONTROLLER_HOME_UNAVAILABLE".to_string())
}

fn runtime_config() -> Result<RuntimeServiceConfig, String> {
    let home = controller_home()?;
    let config_path = home.join("runtime").join("service").join("config.json");
    let text = fs::read_to_string(&config_path)
        .map_err(|_| "FORGE_DESKTOP_RUNTIME_CONFIG_UNAVAILABLE".to_string())?;
    let config: RuntimeServiceConfig = serde_json::from_str(&text)
        .map_err(|_| "FORGE_DESKTOP_RUNTIME_CONFIG_INVALID".to_string())?;
    let configured_home = PathBuf::from(&config.controller_home);
    if configured_home != home {
        return Err("FORGE_DESKTOP_RUNTIME_CONTROLLER_HOME_MISMATCH".to_string());
    }
    if !matches!(config.host.as_str(), "127.0.0.1" | "localhost" | "::1") {
        return Err("FORGE_DESKTOP_RUNTIME_ENDPOINT_NOT_LOOPBACK".to_string());
    }
    let token_path = PathBuf::from(&config.auth_token_file);
    if !path_within(&token_path, &home) {
        return Err("FORGE_DESKTOP_RUNTIME_TOKEN_OUTSIDE_CONTROLLER_HOME".to_string());
    }
    Ok(config)
}

fn path_within(path: &Path, root: &Path) -> bool {
    path == root || path.strip_prefix(root).is_ok()
}

fn request_id(prefix: &str) -> String {
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    format!("forge-desktop-{prefix}-{}-{millis}", std::process::id())
}

async fn call_runtime_tool(name: &str, arguments: Value) -> Result<Value, String> {
    let config = runtime_config()?;
    let token = fs::read_to_string(&config.auth_token_file)
        .map_err(|_| "FORGE_DESKTOP_RUNTIME_TOKEN_UNAVAILABLE".to_string())?;
    let token = token.trim();
    if token.is_empty() {
        return Err("FORGE_DESKTOP_RUNTIME_TOKEN_EMPTY".to_string());
    }
    let host = if config.host == "::1" { "[::1]" } else { config.host.as_str() };
    let endpoint = format!("http://{host}:{}/mcp", config.port);
    let meta = json!({
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": { "name": "forge-desktop", "version": env!("CARGO_PKG_VERSION") },
        "io.modelcontextprotocol/clientCapabilities": {}
    });
    let body = json!({
        "jsonrpc": "2.0",
        "id": request_id("mcp"),
        "method": "tools/call",
        "params": {
            "name": name,
            "arguments": arguments,
            "_meta": meta
        }
    });
    let response = reqwest::Client::new()
        .post(endpoint)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("MCP-Protocol-Version", MCP_PROTOCOL_VERSION)
        .header("MCP-Method", "tools/call")
        .json(&body)
        .send()
        .await
        .map_err(|_| "FORGE_DESKTOP_RUNTIME_UNREACHABLE".to_string())?;
    if !response.status().is_success() {
        return Err(format!("FORGE_DESKTOP_RUNTIME_HTTP_{}", response.status().as_u16()));
    }
    let rpc: Value = response.json().await
        .map_err(|_| "FORGE_DESKTOP_RUNTIME_RESPONSE_INVALID".to_string())?;
    if let Some(error) = rpc.get("error") {
        let code = error.get("code").and_then(Value::as_i64).unwrap_or_default();
        return Err(format!("FORGE_DESKTOP_RUNTIME_RPC_ERROR:{code}"));
    }
    let result = rpc.get("result").cloned().ok_or_else(|| "FORGE_DESKTOP_RUNTIME_RESULT_MISSING".to_string())?;
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        if let Some(structured) = result.get("structuredContent") {
            let code = structured.pointer("/error/code").and_then(Value::as_str).unwrap_or("FORGE_DESKTOP_CAPABILITY_FAILED");
            return Err(code.to_string());
        }
        return Err("FORGE_DESKTOP_CAPABILITY_FAILED".to_string());
    }
    if let Some(structured) = result.get("structuredContent") {
        return Ok(structured.clone());
    }
    let text = result.get("content").and_then(Value::as_array)
        .and_then(|items| items.iter().find(|item| item.get("type").and_then(Value::as_str) == Some("text")))
        .and_then(|item| item.get("text")).and_then(Value::as_str)
        .ok_or_else(|| "FORGE_DESKTOP_RUNTIME_STRUCTURED_CONTENT_MISSING".to_string())?;
    serde_json::from_str(text).map_err(|_| "FORGE_DESKTOP_RUNTIME_TOOL_RESULT_INVALID".to_string())
}

#[tauri::command]
async fn read_automatic_continuations() -> Result<Value, String> {
    call_runtime_tool("capability_execute", json!({
        "capability_id": "controller.workflow_supervisor",
        "action": "list",
        "arguments": { "active_only": true },
        "request_id": request_id("continuations-list")
    })).await
}

#[tauri::command]
async fn switch_automatic_continuation_conversation(
    task_id: String,
    expected_conversation_id: String,
    reason: String,
) -> Result<Value, String> {
    if task_id.trim().is_empty() || expected_conversation_id.trim().is_empty() || reason.trim().is_empty() {
        return Err("FORGE_DESKTOP_CONVERSATION_SWITCH_ARGUMENT_REQUIRED".to_string());
    }
    call_runtime_tool("capability_execute", json!({
        "capability_id": "controller.workflow_supervisor",
        "action": "switch_to_fresh_conversation",
        "arguments": {
            "task_id": task_id,
            "expected_conversation_id": expected_conversation_id,
            "reason": reason,
            "authorized_by": "forge-desktop"
        },
        "request_id": request_id("conversation-switch")
    })).await
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            read_automatic_continuations,
            switch_automatic_continuation_conversation
        ])
        .run(tauri::generate_context!())
        .expect("error while running Forge desktop");
}
