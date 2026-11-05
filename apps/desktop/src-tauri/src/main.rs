#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::Manager;
use std::{env, fs, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};

const MCP_PROTOCOL_VERSION: &str = "2025-11-25";

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

fn parse_mcp_payload(body: &str, content_type: &str, error_prefix: &str) -> Result<Value, String> {
    let source = if content_type.contains("text/event-stream") {
        body.lines()
            .filter_map(|line| line.strip_prefix("data:").map(str::trim))
            .find(|data| !data.is_empty() && *data != "[DONE]")
            .ok_or_else(|| format!("{error_prefix}_RESPONSE_INVALID"))?
    } else {
        body.trim()
    };
    serde_json::from_str(source).map_err(|_| format!("{error_prefix}_RESPONSE_INVALID"))
}

async fn read_mcp_payload(response: reqwest::Response, error_prefix: &str) -> Result<Value, String> {
    let content_type = response.headers()
        .get("content-type").and_then(|value| value.to_str().ok())
        .unwrap_or("").to_string();
    let payload = response.bytes().await
        .map_err(|_| format!("{error_prefix}_RESPONSE_INVALID"))?;
    if payload.len() > 8 * 1024 * 1024 {
        return Err(format!("{error_prefix}_RESPONSE_TOO_LARGE"));
    }
    let body = std::str::from_utf8(&payload)
        .map_err(|_| format!("{error_prefix}_RESPONSE_INVALID"))?;
    parse_mcp_payload(body, &content_type, error_prefix)
}

async fn call_mcp_tool(
    endpoint: &str,
    token: &str,
    name: &str,
    arguments: Value,
    error_prefix: &str,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build().map_err(|_| format!("{error_prefix}_CLIENT_FAILED"))?;
    let post = |body: Value, version: &str, session: Option<&str>| {
        let mut request = client.post(endpoint)
            .bearer_auth(token)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", version)
            .json(&body);
        if let Some(session) = session {
            request = request.header("Mcp-Session-Id", session);
        }
        request
    };
    let initialized = post(json!({
        "jsonrpc": "2.0",
        "id": request_id("mcp-init"),
        "method": "initialize",
        "params": {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "forge-desktop", "version": env!("CARGO_PKG_VERSION") }
        }
    }), MCP_PROTOCOL_VERSION, None).send().await
        .map_err(|_| format!("{error_prefix}_UNREACHABLE"))?;
    let session_id = initialized.headers()
        .get("mcp-session-id").and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty()).map(str::to_owned);
    let initialized_status = initialized.status();
    let operation = async {
        if !initialized_status.is_success() {
            return Err(format!("{error_prefix}_HTTP_{}", initialized_status.as_u16()));
        }
        let reply = read_mcp_payload(initialized, error_prefix).await?;
        if let Some(error) = reply.get("error") {
            return Err(format!("{error_prefix}_INITIALIZE_RPC_ERROR:{}", error.get("code").and_then(Value::as_i64).unwrap_or_default()));
        }
        let negotiated_version = reply.pointer("/result/protocolVersion")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{error_prefix}_PROTOCOL_VERSION_MISSING"))?;
        if !matches!(negotiated_version, "2025-11-25" | "2025-06-18") {
            return Err(format!("{error_prefix}_PROTOCOL_VERSION_UNSUPPORTED"));
        }
        let notified = post(json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }), negotiated_version, session_id.as_deref()).send().await
            .map_err(|_| format!("{error_prefix}_UNREACHABLE"))?;
        if !notified.status().is_success() {
            return Err(format!("{error_prefix}_INITIALIZED_HTTP_{}", notified.status().as_u16()));
        }
        let response = post(json!({
            "jsonrpc": "2.0",
            "id": request_id("mcp-tool"),
            "method": "tools/call",
            "params": { "name": name, "arguments": arguments }
        }), negotiated_version, session_id.as_deref()).send().await
            .map_err(|_| format!("{error_prefix}_UNREACHABLE"))?;
        if !response.status().is_success() {
            return Err(format!("{error_prefix}_HTTP_{}", response.status().as_u16()));
        }
        let rpc = read_mcp_payload(response, error_prefix).await?;
        if let Some(error) = rpc.get("error") {
            let code = error.get("code").and_then(Value::as_i64).unwrap_or_default();
            return Err(format!("{error_prefix}_RPC_ERROR:{code}"));
        }
        let result = rpc.get("result").ok_or_else(|| format!("{error_prefix}_RESULT_MISSING"))?;
        if result.get("isError").and_then(Value::as_bool) == Some(true) {
            if let Some(code) = result.pointer("/structuredContent/error/code").and_then(Value::as_str) {
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
    }.await;

    // Runtime owns MCP sessions. Always end the transient transport session,
    // including after an RPC/projection error; none is retained by the client.
    if let Some(session_id) = session_id {
        let _ = client.delete(endpoint).bearer_auth(token)
            .header("Mcp-Session-Id", session_id)
            .header("MCP-Protocol-Version", MCP_PROTOCOL_VERSION)
            .send().await;
    }
    operation
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
    call_mcp_tool(&endpoint, token, name, arguments, "FORGE_DESKTOP_RUNTIME").await
}

async fn call_recovery_tool(name: &str, arguments: Value) -> Result<Value, String> {
    let connection = recovery_connection()?;
    call_mcp_tool(&connection.endpoint, &connection.token, name, arguments, "FORGE_DESKTOP_RECOVERY").await
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
    let mut arguments = json!({
        "request_id": request_id(action_prefix),
        "expected_host": host,
        "expected_platform": platform,
        "expected_controller_home": controller_home,
        "expected_recovery_release": recovery_release,
        "expected_target_runtime": target_runtime
    });
    if action_prefix == "restart-runtime" {
        let target = identity.get("targetRuntime").and_then(Value::as_object)
            .ok_or_else(|| "FORGE_DESKTOP_RECOVERY_TARGET_RUNTIME_UNAVAILABLE".to_string())?;
        let active_release = target.get("activeReleaseId").and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "FORGE_DESKTOP_RECOVERY_ACTIVE_RELEASE_UNAVAILABLE".to_string())?;
        let authority_revision = target.get("authorityRevision").and_then(Value::as_u64)
            .filter(|value| *value >= 1)
            .ok_or_else(|| "FORGE_DESKTOP_RECOVERY_AUTHORITY_REVISION_UNAVAILABLE".to_string())?;
        arguments["expected_active_release_id"] = json!(active_release);
        arguments["expected_authority_revision"] = json!(authority_revision);
        if status.get("running").and_then(Value::as_bool) == Some(true)
            && status.get("ready").and_then(Value::as_bool) == Some(true) {
            let instance = status.get("snapshot").and_then(Value::as_object)
                .and_then(|snapshot| snapshot.get("runtimeInstanceId")).and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "FORGE_DESKTOP_RECOVERY_RUNTIME_INSTANCE_UNAVAILABLE".to_string())?;
            arguments["expected_runtime_instance_id"] = json!(instance);
            arguments["force_healthy_restart"] = json!(true);
        }
    }
    Ok(arguments)
}

#[tauri::command]
async fn read_recovery_status() -> Result<Value, String> {
    call_recovery_tool("runtime_status", json!({})).await
}

#[tauri::command]
async fn read_recovery_history() -> Result<Value, String> {
    call_recovery_tool("list_recovery_history", json!({ "limit": 20 })).await
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
async fn read_project_repository(repo_id: String) -> Result<Value, String> {
    if repo_id.trim().is_empty() { return Err("FORGE_DESKTOP_REPOSITORY_REQUIRED".to_string()); }
    let result = call_runtime_tool("repository_get", json!({
        "repo_id": repo_id,
        "detail_level": "detail",
        "request_id": request_id("project-repository")
    })).await?;
    let repository = result.get("repository").and_then(Value::as_object)
        .ok_or_else(|| "FORGE_DESKTOP_REPOSITORY_DETAIL_INVALID".to_string())?;
    let active_checkout_id = repository.get("activeCheckoutId").and_then(Value::as_str)
        .ok_or_else(|| "FORGE_DESKTOP_REPOSITORY_ACTIVE_CHECKOUT_MISSING".to_string())?;
    let all_checkouts = repository.get("checkouts").and_then(Value::as_array)
        .ok_or_else(|| "FORGE_DESKTOP_REPOSITORY_CHECKOUTS_INVALID".to_string())?;
    let active_checkout_count = all_checkouts.iter().filter(|checkout| {
        checkout.get("lifecycle").and_then(Value::as_str).unwrap_or("active") == "active"
    }).count();
    let checkouts = all_checkouts.iter().filter(|checkout| {
        let checkout_id = checkout.get("checkoutId").and_then(Value::as_str).unwrap_or("");
        checkout_id == active_checkout_id
            || checkout.get("lifecycle").and_then(Value::as_str).unwrap_or("active") == "active"
    }).take(40).map(|checkout| {
        let checkout_id = checkout.get("checkoutId").and_then(Value::as_str).unwrap_or("");
        json!({
            "checkoutId": checkout_id,
            "path": checkout.get("localRoot").and_then(Value::as_str),
            "branch": checkout.get("branch").and_then(Value::as_str),
            "worktree": checkout.get("worktree").and_then(Value::as_bool).unwrap_or(false),
            "lifecycle": checkout.get("lifecycle").and_then(Value::as_str).unwrap_or("active"),
            "active": checkout_id == active_checkout_id
        })
    }).collect::<Vec<_>>();
    Ok(json!({
        "repository": {
            "activeCheckoutId": active_checkout_id,
            "checkoutCount": all_checkouts.len(),
            "activeCheckoutCount": active_checkout_count,
            "checkouts": checkouts,
            "truncated": active_checkout_count > checkouts.len()
        }
    }))
}

#[tauri::command]
async fn read_project_work_list(repo_id: String) -> Result<Value, String> {
    if repo_id.trim().is_empty() { return Err("FORGE_DESKTOP_REPOSITORY_REQUIRED".to_string()); }
    call_runtime_tool("rh_work", json!({
        "repo_id": repo_id,
        "operation": "list",
        "limit": 100,
        "request_id": request_id("project-work-list")
    })).await
}

#[tauri::command]
async fn read_project_plan_list(repo_id: String) -> Result<Value, String> {
    if repo_id.trim().is_empty() { return Err("FORGE_DESKTOP_REPOSITORY_REQUIRED".to_string()); }
    call_runtime_tool("rh_work", json!({
        "repo_id": repo_id,
        "operation": "plan_list",
        "limit": 100,
        "request_id": request_id("project-plan-list")
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
async fn read_user_requests() -> Result<Value, String> {
    call_runtime_tool("rh_inbox", json!({
        "operation": "list",
        "detail_level": "summary",
        "limit": 100,
        "request_id": request_id("user-requests-list")
    })).await
}

#[tauri::command]
async fn read_requirement_detail(repo_id: String, requirement_id: String) -> Result<Value, String> {
    if repo_id.trim().is_empty() || requirement_id.trim().is_empty() {
        return Err("FORGE_DESKTOP_REQUIREMENT_DETAIL_ARGUMENT_REQUIRED".to_string());
    }
    call_runtime_tool("rh_work", json!({
        "repo_id": repo_id,
        "operation": "requirement_get",
        "requirement_id": requirement_id,
        "detail_level": "detail",
        "request_id": request_id("requirement-detail")
    })).await
}

#[tauri::command]
async fn read_plan_detail(repo_id: String, plan_id: String) -> Result<Value, String> {
    if repo_id.trim().is_empty() || plan_id.trim().is_empty() {
        return Err("FORGE_DESKTOP_PLAN_DETAIL_ARGUMENT_REQUIRED".to_string());
    }
    call_runtime_tool("rh_work", json!({
        "repo_id": repo_id,
        "operation": "plan_get",
        "plan_id": plan_id,
        "detail_level": "detail",
        "request_id": request_id("plan-detail")
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
async fn read_local_provider_status() -> Result<Value, String> {
    call_runtime_tool("capability_execute", json!({
        "capability_id": "controller.local_conversation",
        "action": "status",
        "arguments": {},
        "request_id": request_id("local-conversation-status")
    })).await
}


#[tauri::command]
async fn read_project_knowledge(repo_id: String, work_id: Option<String>, query: String) -> Result<Value, String> {
    if repo_id.trim().is_empty() || repo_id.len() > 256 || query.chars().count() > 160 {
        return Err("FORGE_DESKTOP_KNOWLEDGE_ARGUMENT_INVALID".to_string());
    }
    let mut arguments = json!({
        "repo_id": repo_id,
        "operation": "search",
        "query": "Read bounded Cognitive advisory memory",
        "search_terms": ["knowledge_query"],
        "max_files": 1,
        "max_snippets": 1,
        "include_learning_recall": false,
        "knowledge_query": if query.trim().is_empty() { "*" } else { query.trim() },
        "knowledge_limit": 24
    });
    if let Some(work) = work_id.filter(|value| !value.trim().is_empty() && value.len() <= 256) {
        arguments["work_id"] = json!(work);
    }
    let result = call_runtime_tool("rh_context", arguments).await?;
    let audit = result.pointer("/data/cognitionAudit")
        .filter(|value| value.get("readonly").and_then(Value::as_bool) == Some(true))
        .ok_or_else(|| "FORGE_DESKTOP_KNOWLEDGE_UNAVAILABLE".to_string())?;
    Ok(audit.clone())
}

#[tauri::command]
async fn send_local_conversation(
    conversation_id: String,
    provider_session_id: Option<String>,
    prompt: String,
    repo_id: Option<String>,
) -> Result<Value, String> {
    if conversation_id.trim().is_empty() || prompt.trim().is_empty() {
        return Err("FORGE_DESKTOP_LOCAL_CONVERSATION_ARGUMENT_REQUIRED".to_string());
    }
    let mut request = json!({
        "capability_id": "controller.local_conversation",
        "action": "send",
        "arguments": {
            "conversation_id": conversation_id,
            "prompt": prompt
        },
        "request_id": request_id("local-conversation-send")
    });
    if let Some(provider_session_id) = provider_session_id.filter(|value| !value.trim().is_empty()) {
        request["arguments"]["provider_session_id"] = Value::String(provider_session_id);
    }
    if let Some(repo_id) = repo_id.filter(|value| !value.trim().is_empty()) {
        request["repo_id"] = Value::String(repo_id);
    }
    call_runtime_tool("capability_execute", request).await
}

#[tauri::command]
async fn read_connection_status() -> Result<Value, String> {
    call_runtime_tool("capability_execute", json!({
        "capability_id": "controller.connection",
        "action": "get",
        "arguments": {},
        "request_id": request_id("connection-status")
    })).await
}

#[tauri::command]
async fn repair_connection() -> Result<Value, String> {
    call_runtime_tool("capability_execute", json!({
        "capability_id": "controller.connection",
        "action": "repair_connector",
        "arguments": {},
        "request_id": request_id("connection-repair")
    })).await
}


const LOCAL_API_KEYCHAIN_SERVICE: &str = "com.moretea.forge.desktop.api";

fn local_api_config_path() -> Result<PathBuf, String> {
    let root = dirs::config_dir().ok_or("FORGE_DESKTOP_LOCAL_SETTINGS_DIR_UNAVAILABLE")?;
    Ok(root.join("com.moretea.forge.desktop").join("local-api.json"))
}

fn local_api_config() -> Result<Value, String> {
    let path = local_api_config_path()?;
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({ "provider": "codex", "endpoint": "https://api.openai.com/v1", "model": "" }));
        }
        Err(_) => return Err("FORGE_DESKTOP_LOCAL_SETTINGS_READ_FAILED".into()),
    };
    serde_json::from_str(&text).map_err(|_| "FORGE_DESKTOP_LOCAL_SETTINGS_INVALID".to_string())
}

fn validated_local_api_endpoint(endpoint: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(endpoint.trim()).map_err(|_| "FORGE_DESKTOP_API_ENDPOINT_INVALID")?;
    let host = url.host_str().ok_or("FORGE_DESKTOP_API_ENDPOINT_INVALID")?;
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some()
        || endpoint.len() > 500
    {
        return Err("FORGE_DESKTOP_API_ENDPOINT_UNSAFE".into());
    }
    Ok(url.to_string().trim_end_matches('/').to_string())
}

#[cfg(target_os = "macos")]
fn read_local_api_key(endpoint: &str) -> Result<Option<String>, String> {
    use security_framework::passwords::{generic_password, PasswordOptions};
    match generic_password(PasswordOptions::new_generic_password(LOCAL_API_KEYCHAIN_SERVICE, endpoint)) {
        Ok(value) => String::from_utf8(value).map(Some).map_err(|_| "FORGE_DESKTOP_API_KEY_INVALID".to_string()),
        Err(error) if error.code() == -25300 => Ok(None),
        Err(_) => Err("FORGE_DESKTOP_API_KEYCHAIN_READ_FAILED".to_string()),
    }
}

#[cfg(not(target_os = "macos"))]
fn read_local_api_key(_endpoint: &str) -> Result<Option<String>, String> {
    Err("FORGE_DESKTOP_API_KEYCHAIN_UNSUPPORTED".into())
}

#[cfg(target_os = "macos")]
fn store_local_api_key(endpoint: &str, secret: &str) -> Result<(), String> {
    security_framework::passwords::set_generic_password(
        LOCAL_API_KEYCHAIN_SERVICE, endpoint, secret.as_bytes()
    ).map_err(|_| "FORGE_DESKTOP_API_KEYCHAIN_WRITE_FAILED".to_string())
}

#[cfg(not(target_os = "macos"))]
fn store_local_api_key(_endpoint: &str, _secret: &str) -> Result<(), String> {
    Err("FORGE_DESKTOP_API_KEYCHAIN_UNSUPPORTED".into())
}

#[cfg(target_os = "macos")]
fn delete_local_api_key(endpoint: &str) -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(
        LOCAL_API_KEYCHAIN_SERVICE, endpoint
    ) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == -25300 => Ok(()),
        Err(_) => Err("FORGE_DESKTOP_API_KEYCHAIN_DELETE_FAILED".to_string()),
    }
}

#[cfg(not(target_os = "macos"))]
fn delete_local_api_key(_endpoint: &str) -> Result<(), String> {
    Err("FORGE_DESKTOP_API_KEYCHAIN_UNSUPPORTED".into())
}

#[tauri::command]
fn clear_local_api_key() -> Result<Value, String> {
    let config = local_api_config()?;
    let endpoint = validated_local_api_endpoint(
        config.get("endpoint").and_then(Value::as_str).unwrap_or("")
    )?;
    delete_local_api_key(&endpoint)?;
    read_local_api_settings()
}

#[tauri::command]
fn read_local_api_settings() -> Result<Value, String> {
    let config = local_api_config()?;
    let provider = config.get("provider").and_then(Value::as_str).unwrap_or("codex");
    let endpoint = config.get("endpoint").and_then(Value::as_str).unwrap_or("https://api.openai.com/v1");
    let model = config.get("model").and_then(Value::as_str).unwrap_or("");
    let api_protocol = config.get("apiProtocol").and_then(Value::as_str).unwrap_or("openai");
    Ok(json!({
        "provider": provider,
        "endpoint": endpoint,
        "model": model,
        "apiProtocol": api_protocol,
        "hasKey": read_local_api_key(endpoint)?.is_some(),
    }))
}

#[tauri::command]
fn save_local_api_settings(provider: String, endpoint: String, model: String, api_key: Option<String>, api_protocol: Option<String>) -> Result<Value, String> {
    if provider != "codex" && provider != "api" {
        return Err("FORGE_DESKTOP_API_PROVIDER_INVALID".into());
    }
    let endpoint = validated_local_api_endpoint(&endpoint)?;
    let api_protocol = api_protocol.as_deref().unwrap_or("openai");
    if !matches!(api_protocol, "openai" | "anthropic") {
        return Err("FORGE_DESKTOP_API_PROTOCOL_INVALID".into());
    }
    let model = model.trim();
    if model.len() > 120 || (provider == "api" && model.is_empty()) {
        return Err("FORGE_DESKTOP_API_MODEL_INVALID".into());
    }
    if let Some(secret) = api_key.filter(|secret| !secret.trim().is_empty()) {
        if secret.len() > 4096 { return Err("FORGE_DESKTOP_API_KEY_INVALID".into()); }
        store_local_api_key(&endpoint, &secret)?;
    }
    let path = local_api_config_path()?;
    let parent = path.parent().ok_or("FORGE_DESKTOP_LOCAL_SETTINGS_DIR_UNAVAILABLE")?;
    fs::create_dir_all(parent).map_err(|_| "FORGE_DESKTOP_LOCAL_SETTINGS_WRITE_FAILED")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|_| "FORGE_DESKTOP_LOCAL_SETTINGS_WRITE_FAILED")?;
        use std::io::Write;
        let temp = path.with_extension("json.tmp");
        let mut file = fs::OpenOptions::new().write(true).truncate(true).create(true)
            .mode(0o600).open(&temp).map_err(|_| "FORGE_DESKTOP_LOCAL_SETTINGS_WRITE_FAILED")?;
        file.write_all(json!({ "provider": provider, "endpoint": endpoint, "model": model, "apiProtocol": api_protocol }).to_string().as_bytes())
            .map_err(|_| "FORGE_DESKTOP_LOCAL_SETTINGS_WRITE_FAILED")?;
        fs::rename(&temp, &path).map_err(|_| "FORGE_DESKTOP_LOCAL_SETTINGS_WRITE_FAILED")?;
    }
    #[cfg(not(unix))]
    { return Err("FORGE_DESKTOP_LOCAL_SETTINGS_UNSUPPORTED".into()); }
    read_local_api_settings()
}



#[tauri::command]
async fn read_agent_git_diff(app: tauri::AppHandle, repo_id: String) -> Result<Value, String> {
    if repo_id.trim().is_empty() { return Err("FORGE_DESKTOP_REPOSITORY_REQUIRED".into()); }
    let receipt = run_local_forge_tool(
        app,
        repo_id,
        "desktop-git-inspector".to_string(),
        "git_diff".to_string(),
        json!({ "max_bytes": 20000 }),
        false,
    ).await?;
    if receipt.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("FORGE_DESKTOP_GIT_DIFF_FAILED".into());
    }
    receipt.pointer("/result/diff").cloned()
        .ok_or_else(|| "FORGE_DESKTOP_GIT_DIFF_RESULT_INVALID".into())
}

fn local_tool_catalog(allow_effects: bool) -> Vec<Value> {
    let mut tools = vec![
        json!({"type":"function","function":{"name":"read_file","description":"Read bounded lines of a file in the user's selected registered Forge repository. Paths are repo-relative.","parameters":{"type":"object","properties":{"path":{"type":"string"},"start_line":{"type":"integer","minimum":1},"end_line":{"type":"integer","minimum":1}},"required":["path"],"additionalProperties":false}}}),
        json!({"type":"function","function":{"name":"git_status","description":"Read actual Git status of the selected Forge project, not a cached model guess.","parameters":{"type":"object","properties":{},"additionalProperties":false}}}),
        json!({"type":"function","function":{"name":"git_diff","description":"Inspect a bounded Git diff in the selected repository.","parameters":{"type":"object","properties":{"paths":{"type":"array","items":{"type":"string"}},"staged":{"type":"boolean"},"max_bytes":{"type":"integer","minimum":100,"maximum":16000}},"additionalProperties":false}}}),
        json!({"type":"function","function":{"name":"patch_plan","description":"Review the preconditions and affected paths of proposed canonical Forge edit operations before applying anything.","parameters":{"type":"object","properties":{"operations":{"type":"array","items":{"type":"object"}}},"required":["operations"],"additionalProperties":false}}}),
    ];
    if allow_effects {
        tools.extend([
            json!({"type":"function","function":{"name":"apply_patch","description":"Apply typed Forge safe-patch operations to the selected registered repository. Forge owns mutation exclusion, fingerprint validation and evidence.","parameters":{"type":"object","properties":{"purpose":{"type":"string"},"operations":{"type":"array","items":{"type":"object"},"minItems":1,"maxItems":16},"allowed_paths":{"type":"array","items":{"type":"string"}}},"required":["purpose","operations"],"additionalProperties":false}}}),
            json!({"type":"function","function":{"name":"run_command","description":"Execute an argument-array command through Forge's existing authorized Process Runtime and checkout/resource leases. No shell command strings or host scope.","parameters":{"type":"object","properties":{"command":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":24},"timeout_ms":{"type":"integer","minimum":1000,"maximum":60000},"max_output_bytes":{"type":"integer","minimum":1000,"maximum":12000}},"required":["command"],"additionalProperties":false}}}),
        ]);
    }
    tools
}

fn local_effect_completed(name: &str, receipt: &Value) -> bool {
    if receipt.get("ok").and_then(Value::as_bool) != Some(true) {
        return false;
    }
    let result = &receipt["result"];
    match name {
        "run_command" => result.get("status").and_then(Value::as_str) == Some("succeeded")
            && result.get("exitCode").and_then(Value::as_i64) == Some(0),
        "apply_patch" => result.get("status").and_then(Value::as_str) == Some("applied"),
        _ => false,
    }
}

async fn run_local_forge_tool(
    app: tauri::AppHandle,
    repo_id: String,
    conversation_id: String,
    tool_name: String,
    arguments: Value,
    allow_effects: bool,
) -> Result<Value, String> {
    use std::process::Stdio;
    use tokio::{io::AsyncWriteExt, process::Command, time::timeout};
        let config = runtime_config()?;
        let source_root = config.repository_root
            .filter(|path| PathBuf::from(path).is_absolute())
            .ok_or("FORGE_DESKTOP_LOCAL_SOURCE_UNAVAILABLE")?;
        let home = controller_home()?;
        // Source checkout is authoritative for this installed Forge instance;
        // the Desktop does not install/activate a second Runtime release.
        let dev_script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/forge-local-tool.mjs");
        let script = if dev_script.is_file() {
            dev_script
        } else {
            app.path().resolve("resources/forge-local-tool.mjs", tauri::path::BaseDirectory::Resource)
                .map_err(|_| "FORGE_DESKTOP_LOCAL_TOOL_RESOURCE_UNAVAILABLE")?
        };
        if !script.is_file() {
            return Err("FORGE_DESKTOP_LOCAL_TOOL_RESOURCE_UNAVAILABLE".to_string());
        }
        let home_bun = dirs::home_dir()
            .map(|home| home.join(".bun/bin/bun"))
            .filter(|candidate| candidate.is_file());
        let bun = home_bun.unwrap_or_else(|| PathBuf::from("bun"));
        let payload = json!({
            "controllerHome": home.to_string_lossy(),
            "sourceRoot": source_root,
            "repoId": repo_id,
            "conversationId": conversation_id,
            "tool": tool_name,
            "arguments": arguments,
            "allowEffects": allow_effects,
        });
        let bytes = payload.to_string();
        if bytes.len() > 96 * 1024 {
            return Err("FORGE_DESKTOP_LOCAL_TOOL_REQUEST_TOO_LARGE".to_string());
        }
        let mut child = Command::new(bun);
        child.arg(script).kill_on_drop(true)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = child.spawn()
            .map_err(|_| "FORGE_DESKTOP_LOCAL_TOOL_RUNNER_UNAVAILABLE")?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(bytes.as_bytes()).await
                .map_err(|_| "FORGE_DESKTOP_LOCAL_TOOL_DELIVERY_UNKNOWN")?;
        }
        // A lost or unresponsive tool process cannot hold the GUI's worker
        // indefinitely. Drop kills the child; effect outcomes remain unknown
        // until the single Forge Process authority is inspected.
        let completed = timeout(std::time::Duration::from_secs(90), child.wait_with_output())
            .await.map_err(|_| "FORGE_DESKTOP_LOCAL_TOOL_OUTCOME_UNKNOWN")?
            .map_err(|_| "FORGE_DESKTOP_LOCAL_TOOL_OUTCOME_UNKNOWN")?;
        if !completed.status.success() || completed.stdout.len() > 128 * 1024 {
            return Err("FORGE_DESKTOP_LOCAL_TOOL_OUTCOME_UNKNOWN".to_string());
        }
        let result: Value = serde_json::from_slice(&completed.stdout)
            .map_err(|_| "FORGE_DESKTOP_LOCAL_TOOL_RESULT_INVALID")?;
        if result.get("ok").and_then(Value::as_bool).is_none() {
            return Err("FORGE_DESKTOP_LOCAL_TOOL_RESULT_INVALID".to_string());
        }
        Ok(result)
}


// Provider-specific tool-call envelope parsing. Execution remains a single
// canonical Forge path independent of the remote model protocol.
fn provider_tool_calls(protocol: &str, output: &Value) -> Result<Vec<(String, String, Value)>, String> {
    let mut requests = Vec::new();
    if protocol == "anthropic" {
        let blocks = output.get("content").and_then(Value::as_array)
            .ok_or("FORGE_DESKTOP_API_RESPONSE_INVALID")?;
        for block in blocks {
            if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                requests.push((
                    block.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                    block.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                    block.get("input").cloned().unwrap_or(Value::Null)
                ));
            }
        }
    } else {
        let message = output.pointer("/choices/0/message")
            .ok_or("FORGE_DESKTOP_API_RESPONSE_INVALID")?;
        if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let arguments = call.pointer("/function/arguments").and_then(Value::as_str).unwrap_or("{}");
                if arguments.len() > 64 * 1024 { return Err("FORGE_DESKTOP_API_TOOL_ARGUMENTS_TOO_LARGE".into()); }
                requests.push((
                    call.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                    call.pointer("/function/name").and_then(Value::as_str).unwrap_or("").to_string(),
                    serde_json::from_str(arguments)
                        .map_err(|_| "FORGE_DESKTOP_API_TOOL_ARGUMENTS_INVALID")?,
                ));
            }
        }
    }
    Ok(requests)
}

async fn request_local_api_round(
    client: &reqwest::Client,
    endpoint: &str,
    protocol: &str,
    key: Option<&str>,
    body: &Value,
) -> Result<Value, String> {
    let route = match protocol {
        "anthropic" => "messages",
        "openai" => "chat/completions",
        _ => return Err("FORGE_DESKTOP_API_PROTOCOL_INVALID".into()),
    };
    let mut request = client.post(format!("{}/{}", endpoint.trim_end_matches('/'), route)).json(body);
    if protocol == "anthropic" {
        request = request.header("anthropic-version", "2023-06-01");
    }
    if let Some(key) = key.filter(|key| !key.trim().is_empty()) {
        request = if protocol == "anthropic" {
            request.header("x-api-key", key)
        } else {
            request.bearer_auth(key)
        };
    }
    let response = request.send().await.map_err(|_| "FORGE_DESKTOP_API_REQUEST_FAILED")?;
    if !response.status().is_success() {
        return Err(format!("FORGE_DESKTOP_API_HTTP_{}", response.status().as_u16()));
    }
    let bytes = response.bytes().await.map_err(|_| "FORGE_DESKTOP_API_RESPONSE_INVALID")?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("FORGE_DESKTOP_API_RESPONSE_TOO_LARGE".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "FORGE_DESKTOP_API_RESPONSE_INVALID".into())
}

#[tauri::command]
async fn send_local_api_conversation(
    app: tauri::AppHandle,
    messages: Vec<Value>,
    repo_id: Option<String>,
    conversation_id: String,
    allow_effects: bool,
) -> Result<Value, String> {
    let config = read_local_api_settings()?;
    if config.get("provider").and_then(Value::as_str) != Some("api") {
        return Err("FORGE_DESKTOP_API_PROVIDER_NOT_SELECTED".into());
    }
    let endpoint = validated_local_api_endpoint(config.get("endpoint").and_then(Value::as_str).unwrap_or(""))?;
    let model = config.get("model").and_then(Value::as_str).unwrap_or("").trim();
    if model.is_empty() { return Err("FORGE_DESKTOP_API_MODEL_INVALID".into()); }
    if conversation_id.len() > 160 || conversation_id.is_empty()
        || !conversation_id.chars().all(|char| char.is_ascii_alphanumeric() || "._:-".contains(char)) {
        return Err("FORGE_DESKTOP_API_CONVERSATION_INVALID".into());
    }
    if messages.is_empty() || messages.len() > 40 {
        return Err("FORGE_DESKTOP_API_MESSAGES_INVALID".into());
    }
    let repo_id = repo_id.filter(|value| !value.trim().is_empty());
    if repo_id.as_ref().is_some_and(|value| value.len() > 256) {
        return Err("FORGE_DESKTOP_API_REPOSITORY_INVALID".into());
    }
    let mut total = 0usize;
    let mut history = Vec::with_capacity(messages.len() + 15);
    for item in messages {
        let role = item.get("role").and_then(Value::as_str).unwrap_or("");
        let content = item.get("content").and_then(Value::as_str).unwrap_or("").trim();
        if !matches!(role, "user" | "assistant") || content.is_empty() || content.len() > 20_000 {
            return Err("FORGE_DESKTOP_API_MESSAGES_INVALID".into());
        }
        total += content.len();
        if total > 60_000 { return Err("FORGE_DESKTOP_API_MESSAGES_TOO_LARGE".into()); }
        history.push(json!({ "role": role, "content": content }));
    }
    let key = read_local_api_key(&endpoint)?;
    let host = reqwest::Url::parse(&endpoint).map_err(|_| "FORGE_DESKTOP_API_ENDPOINT_INVALID")?;
    let local = matches!(host.host_str().unwrap_or(""), "localhost" | "127.0.0.1" | "[::1]");
    if key.is_none() && !local { return Err("FORGE_DESKTOP_API_KEY_MISSING".into()); }
    let protocol = config.get("apiProtocol").and_then(Value::as_str).unwrap_or("openai");
    if !matches!(protocol, "openai" | "anthropic") {
        return Err("FORGE_DESKTOP_API_PROTOCOL_INVALID".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build().map_err(|_| "FORGE_DESKTOP_API_CLIENT_FAILED")?;
    let available_tools = if repo_id.is_some() { local_tool_catalog(allow_effects) } else { Vec::new() };
    let system_instruction = if let Some(id) = repo_id.as_ref() {
        format!("You are the Forge Desktop local API agent working in registered repository {id}. Use the supplied tools for real facts and repository operations. All calls execute through the existing Forge repository authority in the local process, not MCP HTTP. Never invent a file, command result, Requirement, Plan or Work lifecycle. Tools with effects are available only when the user has approved effects for this turn. Never claim an operation succeeded unless its tool result confirms it.")
    } else {
        "You are the Forge Desktop assistant. No Forge project is attached: tools are disabled. Do not invent repository changes or imply that you ran a command. Ask the user to attach a project to work on files.".to_string()
    };
    let mut tool_events: Vec<Value> = Vec::new();
    let mut total_calls = 0usize;
    for _round in 0..6 {
        let provider_body = if protocol == "anthropic" {
            let tools: Vec<Value> = available_tools.iter().map(|tool| json!({
                "name": tool.pointer("/function/name"),
                "description": tool.pointer("/function/description"),
                "input_schema": tool.pointer("/function/parameters"),
            })).collect();
            let mut body = json!({
                "model": model,
                "max_tokens": 3000,
                "system": system_instruction,
                "messages": history,
            });
            if !tools.is_empty() { body["tools"] = Value::Array(tools); }
            body
        } else {
            let mut upstream = Vec::with_capacity(history.len() + 1);
            upstream.push(json!({ "role": "system", "content": system_instruction }));
            upstream.extend(history.iter().cloned());
            let mut body = json!({ "model": model, "messages": upstream, "stream": false });
            if !available_tools.is_empty() { body["tools"] = Value::Array(available_tools.clone()); }
            body
        };
        let output = request_local_api_round(
            &client, &endpoint, protocol, key.as_deref(), &provider_body
        ).await?;
        let requests = provider_tool_calls(protocol, &output)?;
        if protocol == "anthropic" {
            let blocks = output.get("content").and_then(Value::as_array)
                .ok_or("FORGE_DESKTOP_API_RESPONSE_INVALID")?;
            if requests.is_empty() {
                let text = blocks.iter().filter_map(|block| {
                    if block.get("type").and_then(Value::as_str) == Some("text") {
                        block.get("text").and_then(Value::as_str)
                    } else { None }
                }).collect::<Vec<_>>().join("\n");
                if text.trim().is_empty() { return Err("FORGE_DESKTOP_API_RESPONSE_MISSING".into()); }
                return Ok(json!({ "output": text, "toolActivityCount": total_calls, "toolEvents": tool_events }));
            }
            history.push(json!({ "role": "assistant", "content": blocks }));
        } else {
            let message = output.pointer("/choices/0/message").ok_or("FORGE_DESKTOP_API_RESPONSE_INVALID")?;
            if requests.is_empty() {
                let text = message.get("content").and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or("FORGE_DESKTOP_API_RESPONSE_MISSING")?;
                return Ok(json!({ "output": text, "toolActivityCount": total_calls, "toolEvents": tool_events }));
            }
            history.push(message.clone());
        }
        if repo_id.is_none() || requests.is_empty() || requests.len() > 4 || total_calls + requests.len() > 12 {
            return Err("FORGE_DESKTOP_API_TOOL_BUDGET_EXCEEDED".into());
        }
        let mut tool_results = Vec::new();
        for (id, name, mut args) in requests {
            if id.is_empty() || name.is_empty() || !args.is_object()
                || !available_tools.iter().any(|tool| tool.pointer("/function/name").and_then(Value::as_str) == Some(&name)) {
                return Err("FORGE_DESKTOP_API_TOOL_NOT_AUTHORIZED".into());
            }
            let effectful = matches!(name.as_str(), "apply_patch" | "run_command");
            let effect_request_id = if effectful {
                let nonce = SystemTime::now().duration_since(UNIX_EPOCH)
                    .unwrap_or_default().as_nanos();
                let id = format!("forge-desktop-api-{}-{nonce}", std::process::id());
                args["request_id"] = Value::String(id.clone());
                Some(id)
            } else { None };
            let result = run_local_forge_tool(
                app.clone(), repo_id.clone().unwrap_or_default(),
                conversation_id.clone(), name.clone(), args, allow_effects
            ).await.map_err(|error| if effectful {
                format!("FORGE_DESKTOP_LOCAL_EFFECT_RECONCILIATION_REQUIRED:{}:{}",
                    effect_request_id.as_deref().unwrap_or("unknown"), error)
            } else { error })?;
            let ok = if effectful {
                local_effect_completed(&name, &result)
            } else {
                result.get("ok").and_then(Value::as_bool) == Some(true)
            };
            tool_events.push(json!({ "name": name, "ok": ok,
                "requestId": effect_request_id }));
            total_calls += 1;
            // A real tool result is the only source of truth sent back to the model.
            let serialized = result.to_string();
            let bounded = if serialized.len() > 16_000 {
                format!("{}...[truncated]", &serialized[..serialized.char_indices().map(|(idx, _)| idx).take_while(|idx| *idx <= 15_900).last().unwrap_or(0)])
            } else { serialized };
            if !ok && effectful {
                // The Forge Process/edit authority, not the model, reconciles effects.
                // Keep this exact request identity for read-only outcome inspection.
                return Err(format!("FORGE_DESKTOP_LOCAL_EFFECT_RECONCILIATION_REQUIRED:{}",
                    effect_request_id.as_deref().unwrap_or("unknown")));
            }
            if protocol == "anthropic" {
                tool_results.push(json!({"type":"tool_result","tool_use_id":id,"content":bounded,"is_error":!ok}));
            } else {
                history.push(json!({ "role": "tool", "tool_call_id": id, "content": bounded }));
            }
        }
        if protocol == "anthropic" {
            history.push(json!({ "role": "user", "content": tool_results }));
        }
    }
    Err("FORGE_DESKTOP_API_TOOL_ROUND_LIMIT".into())
}


fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            read_recovery_status,
            read_recovery_history,
            verify_recovery_runtime,
            perform_recovery_action,
            read_projects,
            read_project_overview,
            read_project_repository,
            read_project_work_list,
            read_project_plan_list,
            read_agent_git_diff,
            read_work_detail,
            read_user_requests,
            read_requirement_detail,
            read_plan_detail,
            continue_work,
            read_local_provider_status,
            read_project_knowledge,
            send_local_conversation,
            read_local_api_settings,
            save_local_api_settings,
            clear_local_api_key,
            send_local_api_conversation,
            read_connection_status,
            repair_connection
        ])
        .run(tauri::generate_context!())
        .expect("error while running Forge desktop");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parse_mcp_json_and_sse_replies() {
        let reply = json!({"jsonrpc":"2.0", "id":1, "result":{"ok":true}});
        let encoded = reply.to_string();
        assert_eq!(parse_mcp_payload(&encoded, "application/json", "TEST").unwrap(), reply);
        let event = format!("event: message\ndata: {}\n\n", encoded);
        assert_eq!(parse_mcp_payload(&event, "text/event-stream", "TEST").unwrap(), reply);
        assert!(parse_mcp_payload("event: heartbeat\n\n", "text/event-stream", "TEST").is_err());
    }


    #[test]
    fn local_api_openai_and_claude_use_correct_http_paths_and_parse_tools() {
        use std::{io::{Read, Write}, net::TcpListener, thread, time::Duration};
        for (protocol, expected_path, reply) in [
            ("openai", "/v1/chat/completions", json!({
                "choices":[{"message":{"role":"assistant","tool_calls":[{
                    "id":"tool-1","type":"function",
                    "function":{"name":"git_status","arguments":"{}"}
                }]}}]
            })),
            ("anthropic", "/v1/messages", json!({
                "content":[{"type":"tool_use","id":"toolu-1","name":"read_file","input":{"path":"README.md"}}]
            })),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").expect("loopback mock");
            let port = listener.local_addr().expect("mock address").port();
            let expected_path = expected_path.to_string();
            let response_body = reply.to_string();
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("mock connection");
                stream.set_read_timeout(Some(Duration::from_secs(8))).expect("read timeout");
                let mut request = Vec::new();
                let mut temp = [0u8; 2048];
                let header_end = loop {
                    let bytes = stream.read(&mut temp).expect("read request");
                    assert!(bytes > 0 && request.len() < 128 * 1024, "bounded request");
                    request.extend_from_slice(&temp[..bytes]);
                    if let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                        break end + 4;
                    }
                };
                let headers = String::from_utf8_lossy(&request[..header_end]).to_string();
                assert!(headers.starts_with(&format!("POST {expected_path} HTTP/1.1")), "endpoint path");
                assert!(headers.to_ascii_lowercase().contains("content-type: application/json"));
                let content_length = headers.lines().find_map(|line| {
                    line.to_ascii_lowercase().strip_prefix("content-length:")
                        .and_then(|value| value.trim().parse::<usize>().ok())
                }).expect("body length");
                while request.len() - header_end < content_length {
                    let bytes = stream.read(&mut temp).expect("body");
                    assert!(bytes > 0, "complete body");
                    request.extend_from_slice(&temp[..bytes]);
                }
                let body: Value = serde_json::from_slice(
                    &request[header_end..header_end + content_length]
                ).expect("valid provider payload");
                assert_eq!(body["model"], "test-model");
                assert_eq!(body["messages"][0]["role"], "user");
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response_body.len(), response_body
                );
                stream.write_all(response.as_bytes()).expect("respond");
                headers
            });
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(10)).redirect(reqwest::redirect::Policy::none())
                .build().expect("client");
            let response = tauri::async_runtime::block_on(request_local_api_round(
                &client, &format!("http://127.0.0.1:{port}/v1"), protocol, None,
                &json!({"model":"test-model","messages":[{"role":"user","content":"check repo"}]})
            )).expect("local mock provider response");
            let calls = provider_tool_calls(protocol, &response).expect("parsed provider calls");
            assert_eq!(calls.len(), 1);
            let headers = server.join().expect("mock received correct request");
            if protocol == "anthropic" {
                assert_eq!(calls[0].1, "read_file");
                assert!(headers.to_ascii_lowercase().contains("anthropic-version: 2023-06-01"));
            } else {
                assert_eq!(calls[0].1, "git_status");
            }
        }
    }

    #[test]
    fn parses_openai_and_anthropic_tool_invocations() {
        let openai = json!({"choices":[{"message":{"role":"assistant","tool_calls":[{
            "id":"call-1","type":"function",
            "function":{"name":"read_file","arguments":json!({"path":"README.md"}).to_string()}
        }]}}]});
        let openai_calls = provider_tool_calls("openai", &openai).expect("OpenAI function calls");
        assert_eq!(openai_calls.len(), 1);
        assert_eq!(openai_calls[0].1, "read_file");
        assert_eq!(openai_calls[0].2["path"], "README.md");

        let claude = json!({"content":[{"type":"text","text":"Looking up the project."},{
            "type":"tool_use","id":"toolu-1","name":"git_status","input":{}
        }]});
        let claude_calls = provider_tool_calls("anthropic", &claude).expect("Anthropic tool use");
        assert_eq!(claude_calls.len(), 1);
        assert_eq!(claude_calls[0].1, "git_status");
        assert_eq!(claude_calls[0].2, json!({}));

        let broken = json!({"choices":[{"message":{"tool_calls":[{"id":"bad",
            "function":{"name":"read_file","arguments":"{"}}]}}]});
        assert!(provider_tool_calls("openai", &broken).is_err());
    }

    #[test]
    fn effect_acceptance_is_not_completion() {
        assert!(local_effect_completed("run_command", &json!({"ok":true,"result":{
            "accepted":true,"status":"succeeded","exitCode":0
        }})));
        assert!(!local_effect_completed("run_command", &json!({"ok":true,"result":{
            "accepted":true,"status":"running"
        }})));
        assert!(!local_effect_completed("run_command", &json!({"ok":true,"result":{
            "accepted":true,"status":"failed","exitCode":1
        }})));
        assert!(local_effect_completed("apply_patch", &json!({"ok":true,"result":{
            "status":"applied"
        }})));
        assert!(!local_effect_completed("apply_patch", &json!({"ok":true,"result":{
            "status":"partial"
        }})));
    }

    #[test]
    fn local_tool_catalog_requires_user_grant_for_effects() {
        let readonly = local_tool_catalog(false);
        let names = |items: Vec<Value>| items.iter().filter_map(|item|
            item.pointer("/function/name").and_then(Value::as_str).map(str::to_owned)
        ).collect::<Vec<_>>();
        let readonly_names = names(readonly);
        assert!(readonly_names.contains(&"read_file".to_string()));
        assert!(readonly_names.contains(&"git_status".to_string()));
        assert!(!readonly_names.contains(&"run_command".to_string()));
        assert!(!readonly_names.contains(&"apply_patch".to_string()));
        let with_permission = names(local_tool_catalog(true));
        assert!(with_permission.contains(&"run_command".to_string()));
        assert!(with_permission.contains(&"apply_patch".to_string()));
    }

    #[test]
    fn restrict_api_endpoints_to_https_or_loopback_http() {
        assert_eq!(validated_local_api_endpoint("https://api.example.com/v1").unwrap(),
                   "https://api.example.com/v1");
        assert_eq!(validated_local_api_endpoint("http://127.0.0.1:11434/v1").unwrap(),
                   "http://127.0.0.1:11434/v1");
        assert!(validated_local_api_endpoint("http://api.example.com/v1").is_err());
        assert!(validated_local_api_endpoint("https://alice:secret@api.example.com/v1").is_err());
        assert!(validated_local_api_endpoint("https://api.example.com/v1?key=secret").is_err());
        assert!(validated_local_api_endpoint("https://api.example.com/v1#token").is_err());
    }


    #[test]
    fn derives_complete_recovery_mutation_identity_from_status() {
        let status = json!({
            "identity": {
                "host": "machine.test",
                "platform": "darwin",
                "controllerHome": "/tmp/forge-recovery-test/controller",
                "recovery": { "releaseRevision": "recovery-revision" },
                "targetRuntime": { "id": "launchd:forge-runtime:release" }
            }
        });
        let arguments = recovery_mutation_arguments(&status, "test-recovery").expect("identity should derive");
        assert_eq!(arguments.get("expected_host").and_then(Value::as_str), Some("machine.test"));
        assert_eq!(arguments.get("expected_platform").and_then(Value::as_str), Some("darwin"));
        assert_eq!(arguments.get("expected_controller_home").and_then(Value::as_str), Some("/tmp/forge-recovery-test/controller"));
        assert_eq!(arguments.get("expected_recovery_release").and_then(Value::as_str), Some("recovery-revision"));
        assert_eq!(arguments.get("expected_target_runtime").and_then(Value::as_str), Some("launchd:forge-runtime:release"));
        assert!(arguments.get("request_id").and_then(Value::as_str).is_some());
    }

    #[test]
    fn restart_runtime_requires_and_transmits_the_exact_active_authority_fence() {
        let status = json!({
            "running": true,
            "ready": true,
            "snapshot": { "runtimeInstanceId": "runtime-current-12345678" },
            "identity": {
                "host": "machine.test",
                "platform": "darwin",
                "controllerHome": "controller-test-home",
                "recovery": { "releaseRevision": "revision-recovery" },
                "targetRuntime": {
                    "id": "launchd:runtime:release-current",
                    "activeReleaseId": "release-current",
                    "authorityRevision": 990
                }
            }
        });
        let restart = recovery_mutation_arguments(&status, "restart-runtime").expect("fenced restart");
        assert_eq!(restart["expected_active_release_id"], "release-current");
        assert_eq!(restart["expected_authority_revision"], 990);
        assert_eq!(restart["force_healthy_restart"], true);
        assert_eq!(restart["expected_runtime_instance_id"], "runtime-current-12345678");
        let mut stopped_status = status.clone();
        stopped_status["running"] = json!(false);
        stopped_status["ready"] = json!(false);
        let start = recovery_mutation_arguments(&stopped_status, "restart-runtime").expect("start from stopped state");
        assert!(start.get("force_healthy_restart").is_none());
        assert!(start.get("expected_runtime_instance_id").is_none());
        let recovery = recovery_mutation_arguments(&status, "recover-runtime").expect("recovery keeps old schema");
        assert!(recovery.get("force_healthy_restart").is_none());
        assert!(recovery.get("expected_authority_revision").is_none());
        let missing = json!({
            "identity": {
                "host": "machine.test",
                "platform": "darwin",
                "controllerHome": "controller-test-home",
                "recovery": { "releaseRevision": "revision-recovery" },
                "targetRuntime": { "id": "launchd:runtime:release-current" }
            }
        });
        assert_eq!(
            recovery_mutation_arguments(&missing, "restart-runtime").unwrap_err(),
            "FORGE_DESKTOP_RECOVERY_ACTIVE_RELEASE_UNAVAILABLE"
        );
    }
}
