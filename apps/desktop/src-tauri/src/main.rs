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
    repository_root: Option<String>,
    auth_token_file: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryGatewayConfig {
    host: String,
    port: u16,
    bearer_token_file: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryConfigFile {
    controller_home: Option<String>,
    gateway: Option<RecoveryGatewayConfig>,
}

#[derive(Debug, Deserialize)]
struct RecoveryTokenFile {
    token: Option<String>,
}

struct RecoveryConnection {
    endpoint: String,
    token: String,
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

fn recovery_connection() -> Result<RecoveryConnection, String> {
    let home = controller_home()?;
    let config_path = home.join("recovery").join("config").join("recovery.json");
    let text = fs::read_to_string(&config_path)
        .map_err(|_| "FORGE_DESKTOP_RECOVERY_CONFIG_UNAVAILABLE".to_string())?;
    let config: RecoveryConfigFile = serde_json::from_str(&text)
        .map_err(|_| "FORGE_DESKTOP_RECOVERY_CONFIG_INVALID".to_string())?;
    if let Some(configured_home) = config.controller_home.as_deref() {
        if PathBuf::from(configured_home) != home {
            return Err("FORGE_DESKTOP_RECOVERY_CONTROLLER_HOME_MISMATCH".to_string());
        }
    }
    let gateway = config.gateway.ok_or_else(|| "FORGE_DESKTOP_RECOVERY_GATEWAY_UNAVAILABLE".to_string())?;
    if gateway.host != "127.0.0.1" {
        return Err("FORGE_DESKTOP_RECOVERY_ENDPOINT_NOT_LOOPBACK".to_string());
    }
    let token_path = PathBuf::from(&gateway.bearer_token_file);
    if !path_within(&token_path, &home) {
        return Err("FORGE_DESKTOP_RECOVERY_TOKEN_OUTSIDE_CONTROLLER_HOME".to_string());
    }
    let token_text = fs::read_to_string(&token_path)
        .map_err(|_| "FORGE_DESKTOP_RECOVERY_TOKEN_UNAVAILABLE".to_string())?;
    let token_file: RecoveryTokenFile = serde_json::from_str(&token_text)
        .map_err(|_| "FORGE_DESKTOP_RECOVERY_TOKEN_INVALID".to_string())?;
    let token = token_file.token.unwrap_or_default();
    if token.len() < 32 {
        return Err("FORGE_DESKTOP_RECOVERY_TOKEN_INVALID".to_string());
    }
    Ok(RecoveryConnection {
        endpoint: format!("http://127.0.0.1:{}/recovery/mcp", gateway.port),
        token,
    })
}

fn path_within(path: &Path, root: &Path) -> bool {
    path == root || path.strip_prefix(root).is_ok()
}

fn request_id(prefix: &str) -> String {
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    format!("forge-desktop-{prefix}-{}-{millis}", std::process::id())
}

async fn call_stateless_mcp_tool(
    endpoint: &str,
    token: &str,
    name: &str,
    arguments: Value,
    error_prefix: &str,
) -> Result<Value, String> {
    let meta = json!({
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": { "name": "forge-desktop", "version": env!("CARGO_PKG_VERSION") },
        "io.modelcontextprotocol/clientCapabilities": {}
    });
    let body = json!({
        "jsonrpc": "2.0",
        "id": request_id("mcp"),
        "method": "tools/call",
        "params": { "name": name, "arguments": arguments, "_meta": meta }
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
        .map_err(|_| format!("{error_prefix}_UNREACHABLE"))?;
    if !response.status().is_success() {
        return Err(format!("{error_prefix}_HTTP_{}", response.status().as_u16()));
    }
    let rpc: Value = response.json().await
        .map_err(|_| format!("{error_prefix}_RESPONSE_INVALID"))?;
    if let Some(error) = rpc.get("error") {
        let code = error.get("code").and_then(Value::as_i64).unwrap_or_default();
        return Err(format!("{error_prefix}_RPC_ERROR:{code}"));
    }
    let result = rpc.get("result").cloned().ok_or_else(|| format!("{error_prefix}_RESULT_MISSING"))?;
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        if let Some(code) = result.get("structuredContent").and_then(|value| value.pointer("/error/code")).and_then(Value::as_str) {
            return Err(code.to_string());
        }
        return Err(format!("{error_prefix}_TOOL_FAILED"));
    }
    if let Some(structured) = result.get("structuredContent") {
        return Ok(structured.clone());
    }
    let text = result.get("content").and_then(Value::as_array)
        .and_then(|items| items.iter().find(|item| item.get("type").and_then(Value::as_str) == Some("text")))
        .and_then(|item| item.get("text")).and_then(Value::as_str)
        .ok_or_else(|| format!("{error_prefix}_STRUCTURED_CONTENT_MISSING"))?;
    serde_json::from_str(text).map_err(|_| format!("{error_prefix}_TOOL_RESULT_INVALID"))
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
    call_stateless_mcp_tool(&endpoint, token, name, arguments, "FORGE_DESKTOP_RUNTIME").await
}

async fn call_recovery_tool(name: &str, arguments: Value) -> Result<Value, String> {
    let connection = recovery_connection()?;
    call_stateless_mcp_tool(&connection.endpoint, &connection.token, name, arguments, "FORGE_DESKTOP_RECOVERY").await
}

fn recovery_mutation_arguments(status: &Value, action_prefix: &str) -> Result<Value, String> {
    let identity = status.get("identity").and_then(Value::as_object)
        .ok_or_else(|| "FORGE_DESKTOP_RECOVERY_IDENTITY_UNAVAILABLE".to_string())?;
    let host = identity.get("host").and_then(Value::as_str).filter(|value| !value.is_empty())
        .ok_or_else(|| "FORGE_DESKTOP_RECOVERY_HOST_UNAVAILABLE".to_string())?;
    let platform = identity.get("platform").and_then(Value::as_str).filter(|value| !value.is_empty())
        .ok_or_else(|| "FORGE_DESKTOP_RECOVERY_PLATFORM_UNAVAILABLE".to_string())?;
    let controller_home = identity.get("controllerHome").and_then(Value::as_str).filter(|value| !value.is_empty())
        .ok_or_else(|| "FORGE_DESKTOP_RECOVERY_CONTROLLER_HOME_UNAVAILABLE".to_string())?;
    let recovery_release = identity.get("recovery").and_then(Value::as_object)
        .and_then(|recovery| recovery.get("releaseRevision")).and_then(Value::as_str)
        .filter(|value| !value.is_empty()).unwrap_or("none");
    let target_runtime = identity.get("targetRuntime").and_then(Value::as_object)
        .and_then(|runtime| runtime.get("id")).and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "FORGE_DESKTOP_RECOVERY_TARGET_RUNTIME_UNAVAILABLE".to_string())?;
    Ok(json!({
        "request_id": request_id(action_prefix),
        "expected_host": host,
        "expected_platform": platform,
        "expected_controller_home": controller_home,
        "expected_recovery_release": recovery_release,
        "expected_target_runtime": target_runtime
    }))
}

#[tauri::command]
async fn read_recovery_status() -> Result<Value, String> {
    call_recovery_tool("runtime_status", json!({})).await
}

#[tauri::command]
async fn verify_recovery_runtime() -> Result<Value, String> {
    call_recovery_tool("verify_stable_runtime", json!({})).await
}

#[tauri::command]
async fn perform_recovery_action(action: String) -> Result<Value, String> {
    let (tool, prefix) = match action.as_str() {
        "restart_runtime" => ("restart_primary_runtime", "restart-runtime"),
        "recover_runtime" => ("recover_primary_runtime", "recover-runtime"),
        _ => return Err("FORGE_DESKTOP_RECOVERY_ACTION_UNSUPPORTED".to_string()),
    };
    let status = call_recovery_tool("runtime_status", json!({})).await?;
    let arguments = recovery_mutation_arguments(&status, prefix)?;
    call_recovery_tool(tool, arguments).await
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
async fn read_projects() -> Result<Value, String> {
    let config = runtime_config()?;
    let result = call_runtime_tool("repository_list", json!({
        "include_removed": false,
        "request_id": request_id("projects-list")
    })).await?;
    let preferred_repo_id = config.repository_root.as_deref().and_then(|repository_root| {
        result.get("repositories").and_then(Value::as_array).and_then(|repositories| {
            repositories.iter().find_map(|repository| {
                let root_matches = repository.get("canonicalRoot").and_then(Value::as_str) == Some(repository_root)
                    || repository.get("localRoot").and_then(Value::as_str) == Some(repository_root);
                root_matches.then(|| repository.get("repoId").and_then(Value::as_str)).flatten()
            })
        })
    });
    let repositories = result.get("repositories").and_then(Value::as_array)
        .map(|items| items.iter().map(|repository| json!({
            "repoId": repository.get("repoId").and_then(Value::as_str),
            "displayName": repository.get("displayName").and_then(Value::as_str),
            "checkoutId": repository.get("checkoutId").and_then(Value::as_str),
            "remoteUrl": repository.get("remoteUrl").and_then(Value::as_str),
            "defaultBranch": repository.get("defaultBranch").and_then(Value::as_str)
        })).collect::<Vec<_>>())
        .unwrap_or_default();
    Ok(json!({ "repositories": repositories, "preferredRepoId": preferred_repo_id }))
}

#[tauri::command]
async fn read_project_overview(repo_id: String) -> Result<Value, String> {
    if repo_id.trim().is_empty() { return Err("FORGE_DESKTOP_REPOSITORY_REQUIRED".to_string()); }
    call_runtime_tool("rh_status", json!({
        "repo_id": repo_id,
        "operation": "list",
        "detail_level": "summary",
        "request_id": request_id("project-overview")
    })).await
}

#[tauri::command]
async fn read_work_detail(repo_id: String, work_id: String) -> Result<Value, String> {
    if repo_id.trim().is_empty() || work_id.trim().is_empty() {
        return Err("FORGE_DESKTOP_WORK_DETAIL_ARGUMENT_REQUIRED".to_string());
    }
    call_runtime_tool("rh_work", json!({
        "repo_id": repo_id,
        "operation": "get",
        "work_id": work_id,
        "detail_level": "detail",
        "request_id": request_id("work-detail")
    })).await
}

#[tauri::command]
async fn continue_work(repo_id: String, work_id: String, prompt: String) -> Result<Value, String> {
    if repo_id.trim().is_empty() || work_id.trim().is_empty() || prompt.trim().is_empty() {
        return Err("FORGE_DESKTOP_CONTINUE_WORK_ARGUMENT_REQUIRED".to_string());
    }
    call_runtime_tool("rh_work", json!({
        "repo_id": repo_id,
        "operation": "launcher_start",
        "work_id": work_id,
        "controller_type": "chatgpt",
        "transport_conversation": "bound",
        "continuation_prompt": prompt,
        "request_id": request_id("continue-work")
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
            read_recovery_status,
            verify_recovery_runtime,
            perform_recovery_action,
            read_projects,
            read_project_overview,
            read_work_detail,
            continue_work,
            read_automatic_continuations,
            switch_automatic_continuation_conversation
        ])
        .run(tauri::generate_context!())
        .expect("error while running Forge desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_complete_recovery_mutation_identity_from_status() {
        let status = json!({
            "identity": {
                "host": "machine.test",
                "platform": "darwin",
                "controllerHome": "/Users/test/.forge/controller",
                "recovery": { "releaseRevision": "recovery-revision" },
                "targetRuntime": { "id": "launchd:forge-runtime:release" }
            }
        });
        let arguments = recovery_mutation_arguments(&status, "test-recovery").expect("identity should derive");
        assert_eq!(arguments.get("expected_host").and_then(Value::as_str), Some("machine.test"));
        assert_eq!(arguments.get("expected_platform").and_then(Value::as_str), Some("darwin"));
        assert_eq!(arguments.get("expected_controller_home").and_then(Value::as_str), Some("/Users/test/.forge/controller"));
        assert_eq!(arguments.get("expected_recovery_release").and_then(Value::as_str), Some("recovery-revision"));
        assert_eq!(arguments.get("expected_target_runtime").and_then(Value::as_str), Some("launchd:forge-runtime:release"));
        assert!(arguments.get("request_id").and_then(Value::as_str).is_some());
    }
}
