// One-shot typed IPC adapter for the native SwiftUI client.
// Reuses the exact Forge MCP and Keychain implementations in main.rs.
// No daemon, extra token store, shell execution, or general tool gateway.
use super::*;
use std::io::{BufRead, Read, Write};

fn required_bounded(arguments: &Value, field: &str, max_len: usize) -> Result<String, String> {
    let value = arguments.get(field).and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("FORGE_NATIVE_BRIDGE_{field}_REQUIRED"))?;
    if value.len() > max_len {
        return Err(format!("FORGE_NATIVE_BRIDGE_{field}_TOO_LONG"));
    }
    Ok(value.to_owned())
}

fn required(arguments: &Value, field: &str) -> Result<String, String> {
    required_bounded(arguments, field, 4096)
}

fn required_strings(arguments: &Value, field: &str, max_items: usize) -> Result<Vec<String>, String> {
    let values = arguments.get(field).and_then(Value::as_array)
        .ok_or_else(|| format!("FORGE_NATIVE_BRIDGE_{field}_REQUIRED"))?;
    if values.is_empty() || values.len() > max_items {
        return Err(format!("FORGE_NATIVE_BRIDGE_{field}_INVALID"));
    }
    values.iter().map(|value| {
        value.as_str().filter(|entry| !entry.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| format!("FORGE_NATIVE_BRIDGE_{field}_INVALID"))
    }).collect()
}

fn optional_strings(arguments: &Value, field: &str, max_items: usize) -> Result<Option<Vec<String>>, String> {
    match arguments.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => required_strings(arguments, field, max_items).map(Some),
    }
}

async fn dispatch(operation: &str, args: &Value) -> Result<Value, String> {
    match operation {
        "read_projects" => read_projects().await,
        "register_project" => call_runtime_tool("repository_register", json!({
            "path": required(args, "path")?
        })).await,
        "read_project_repository" =>
            read_project_repository(required(args, "repoId")?).await,
        "read_repository_access" =>
            read_repository_access(required(args, "repoId")?).await,
        "set_repository_access" =>
            set_repository_access(required(args, "repoId")?, required(args, "mode")?).await,
        "read_project_overview" =>
            read_project_overview(required(args, "repoId")?).await,
        "read_project_requirement_list" =>
            read_project_requirement_list(required(args, "repoId")?).await,
        "read_project_plan_list" =>
            read_project_plan_list(required(args, "repoId")?).await,
        "read_project_schedules" =>
            read_project_schedules(required(args, "repoId")?).await,
        "control_project_schedule" =>
            control_project_schedule(
                required(args, "repoId")?,
                required(args, "scheduleId")?,
                required(args, "action")?,
            ).await,
        "read_project_plugins" =>
            read_project_plugins(required(args, "repoId")?).await,
        "read_project_autopilot_statuses" =>
            read_project_autopilot_statuses(
                required(args, "repoId")?,
                required(args, "checkoutId")?,
                required_strings(args, "requirementIds", 100)?,
            ).await,
        "read_user_requests" =>
            read_user_requests(args.get("repoId").and_then(Value::as_str).map(str::to_owned)).await,
        "control_user_request" =>
            control_user_request(
                required_bounded(args, "requestId", 256)?,
                required(args, "action")?,
                args.get("decision").and_then(Value::as_str).unwrap_or("").to_string(),
            ).await,
        "read_requirement_detail" =>
            read_requirement_detail(required(args, "repoId")?, required(args, "requirementId")?).await,
        "read_plan_detail" =>
            read_plan_detail(required(args, "repoId")?, required(args, "planId")?).await,
        "create_requirement" =>
            create_requirement(
                required(args,"repoId")?,
                required(args,"requirementId")?,
                required_bounded(args,"title",240)?,
                required_bounded(args,"outcome",4000)?,
                args.get("acceptanceCriteria").and_then(Value::as_array)
                    .map(|values| values.iter().filter_map(Value::as_str).map(str::to_owned).take(32).collect())
                    .unwrap_or_default(),
            ).await,
        "create_plan" =>
            create_plan(
                required(args,"repoId")?,
                required(args,"planId")?,
                required_bounded(args,"objective",4000)?,
                args.get("requirementId").and_then(Value::as_str).map(str::to_owned),
                args.get("parentPlanId").and_then(Value::as_str).map(str::to_owned),
            ).await,
        "revise_requirement" =>
            revise_requirement(
                required(args,"repoId")?,
                required(args,"requirementId")?,
                args.get("expectedRevision").and_then(Value::as_u64)
                    .filter(|revision| *revision > 0)
                    .ok_or("FORGE_NATIVE_BRIDGE_EXPECTED_REVISION_REQUIRED")?,
                required_bounded(args,"title",240)?,
                required_bounded(args,"outcome",4000)?,
                args.get("acceptanceCriteria").and_then(Value::as_array)
                    .filter(|items| items.len() <= 50
                        && items.iter().all(|item| item.as_str().is_some_and(|text| text.len() <= 500)))
                    .ok_or("FORGE_NATIVE_BRIDGE_ACCEPTANCE_CRITERIA_INVALID")?
                    .iter().filter_map(Value::as_str).map(str::to_owned).collect(),
            ).await,
        "revise_plan" =>
            revise_plan(
                required(args,"repoId")?,
                required(args,"planId")?,
                args.get("expectedRevision").and_then(Value::as_u64)
                    .filter(|revision| *revision > 0)
                    .ok_or("FORGE_NATIVE_BRIDGE_EXPECTED_REVISION_REQUIRED")?,
                required_bounded(args,"objective",4000)?,
            ).await,
        "autopilot_control" =>
            autopilot_control(
                required(args,"repoId")?,
                required(args,"checkoutId")?,
                required(args,"requirementId")?,
                required(args,"operation")?,
                args.get("confirmAuthorization").and_then(Value::as_bool).unwrap_or(false),
                args.get("model").and_then(Value::as_str).map(str::to_owned),
                args.get("maxTotalTokens").and_then(Value::as_u64),
                args.get("maxTurns").and_then(Value::as_u64),
                args.get("maxToolCalls").and_then(Value::as_u64),
                args.get("checkpointPlanIds").and_then(Value::as_array)
                    .map(|values| values.iter().filter_map(Value::as_str).map(str::to_owned).take(64).collect())
                    .unwrap_or_default(),
                args.get("expiresInMinutes").and_then(Value::as_u64),
                args.get("reason").and_then(Value::as_str).map(str::to_owned),
            ).await,
        "read_project_knowledge" =>
            read_project_knowledge(
                required(args, "repoId")?,
                args.get("query").and_then(Value::as_str).unwrap_or("").to_string(),
                args.get("recall").and_then(Value::as_bool),
                args.get("checkoutId").and_then(Value::as_str).map(str::to_owned),
            ).await,
        "read_recovery_status" => read_recovery_status().await,
        "verify_recovery_runtime" => verify_recovery_runtime().await,
        "read_connection_status" => read_connection_status().await,
        "configure_initial_connection" =>
            configure_initial_connection(
                required(args, "controller")?,
                required(args, "tunnel")?,
            ).await,
        "repair_connection" => repair_connection().await,
        "read_plugin_management" => read_plugin_management().await,
        "install_official_plugin" =>
            install_official_plugin(required(args, "pluginId")?).await,
        "read_local_provider_status" => read_local_provider_status().await,
        "read_local_provider_models" => read_local_provider_models().await,
        "read_local_conversation_activity" =>
            call_runtime_tool("capability_execute", json!({
                "capability_id": "controller.local_conversation",
                "action": "activity",
                "arguments": { "conversation_id": required(args, "conversationId")? },
                "request_id": request_id("native-local-conversation-activity")
            })).await,
        "read_agent_git_diff" => {
            let repo_id = required(args, "repoId")?;
            let checkout_id = required(args, "checkoutId")?;
            let paths = if args.get("paths").is_some() {
                Some(required_strings(args, "paths", 32)?)
            } else {
                None
            };
            read_agent_git_diff_for_review(
                &repo_id, Some(&checkout_id),
                args.get("staged").and_then(Value::as_bool).unwrap_or(false),
                paths.as_deref(),
            ).await
        },
        "commit_agent_git_files" =>
            commit_reviewed_agent_git_files(
                required(args, "repoId")?,
                required(args, "checkoutId")?,
                required(args, "message")?,
                required_strings(args, "paths", 32)?,
                args.get("staged").and_then(Value::as_bool).unwrap_or(false),
                required_bounded(args, "expectedPatch", 20_000)?,
                required(args, "expectedHead")?,
                required(args, "expectedBranch")?,
            ).await,
        "restore_agent_git_files" =>
            restore_reviewed_agent_git_files(
                required(args, "repoId")?,
                required(args, "checkoutId")?,
                required_strings(args, "paths", 32)?,
                required_bounded(args, "expectedPatch", 20_000)?,
                required(args, "expectedHead")?,
                required(args, "expectedBranch")?,
            ).await,
        "read_local_api_settings" => read_local_api_settings(),
        "save_local_api_settings" => save_local_api_settings(
            required(args,"defaultProvider")?,
            args.get("profiles").cloned().unwrap_or_else(|| json!([])),
            args.get("joyCodeModel").and_then(Value::as_str).map(str::to_owned),
        ),
        "managed_api_credential_control" => managed_api_credential_control(
            required(args,"operation")?,
            args.get("credentialRef").and_then(Value::as_str).map(str::to_owned),
            args.get("endpoint").and_then(Value::as_str).map(str::to_owned),
            args.get("label").and_then(Value::as_str).map(str::to_owned),
            args.get("confirmAuthorization").and_then(Value::as_bool),
        ).await,
        "send_local_conversation" =>
            send_local_conversation(
                required(args, "conversationId")?,
                args.get("providerSessionId").and_then(Value::as_str).map(str::to_owned),
                required(args, "prompt")?,
                args.get("model").and_then(Value::as_str).map(str::to_owned),
                args.get("reasoningEffort").and_then(Value::as_str).map(str::to_owned),
                args.get("repoId").and_then(Value::as_str).map(str::to_owned),
                args.get("checkoutId").and_then(Value::as_str).map(str::to_owned),
                optional_strings(args, "imagePaths", 4)?,
            ).await,
        "cancel_local_conversation" =>
            cancel_local_conversation(required(args, "conversationId")?).await,
        _ => Err("FORGE_NATIVE_BRIDGE_OPERATION_UNSUPPORTED".into()),
    }
}

struct NativeApiTurnRequest {
    messages: Vec<Value>,
    repo_id: Option<String>,
    checkout_id: Option<String>,
    conversation_id: String,
    provider: String,
    model: Option<String>,
    // Request-scoped ceiling only; the canonical repository AccessPolicy
    // remains the sole source of write authority.
    allow_effects: bool,
}

fn parse_api_turn_request(value: &Value) -> Result<NativeApiTurnRequest, String> {
    let messages = value.get("messages").and_then(Value::as_array)
        .cloned().ok_or("FORGE_NATIVE_API_MESSAGES_REQUIRED")?;
    let conversation_id = required(value, "conversationId")?;
    let repo_id = value.get("repoId").and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty()).map(str::to_owned);
    let checkout_id = value.get("checkoutId").and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty()).map(str::to_owned);
    let provider = value.get("provider").and_then(Value::as_str).unwrap_or("api");
    let valid_api_profile = provider.strip_prefix("api:").is_some_and(|profile_id| {
        !profile_id.is_empty() && profile_id.len() <= 64
            && profile_id.chars().all(|char| char.is_ascii_alphanumeric() || "._-".contains(char))
    });
    if !matches!(provider, "api" | "joycode") && !valid_api_profile {
        return Err("FORGE_NATIVE_API_PROVIDER_INVALID".into());
    }
    let allow_effects = match value.get("allowEffects") {
        None => true, // Old clients still receive no more than canonical Forge policy.
        Some(Value::Bool(enabled)) => *enabled,
        Some(_) => return Err("FORGE_NATIVE_API_EFFECTS_INVALID".into()),
    };
    Ok(NativeApiTurnRequest {
        messages,
        repo_id,
        checkout_id,
        conversation_id,
        provider:provider.to_string(),
        model:value.get("model").and_then(Value::as_str)
            .map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned),
        allow_effects,
    })
}

fn native_tool_script_for_executable(executable: &Path) -> Result<PathBuf, String> {
    let macos = executable.parent().ok_or("FORGE_DESKTOP_LOCAL_TOOL_RESOURCE_UNAVAILABLE")?;
    let contents = macos.parent().ok_or("FORGE_DESKTOP_LOCAL_TOOL_RESOURCE_UNAVAILABLE")?;
    Ok(contents.join("Resources/forge-local-tool.mjs"))
}

fn write_api_turn_event(value: Value) {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{value}");
    let _ = stdout.flush();
}

struct NativeApiHost {
    sequence: std::sync::atomic::AtomicU64,
}
impl LocalApiHost for NativeApiHost {
    fn packaged_tool_script(&self) -> Result<PathBuf, String> {
        let executable = std::env::current_exe()
            .map_err(|_| "FORGE_DESKTOP_LOCAL_TOOL_RESOURCE_UNAVAILABLE")?;
        native_tool_script_for_executable(&executable)
    }

    fn emit_tool_progress(&self, payload: Value) {
        write_api_turn_event(json!({ "type":"progress", "data":sequence_local_api_event(payload, &self.sequence) }));
    }
    fn emit_model_progress(&self, payload: Value) {
        write_api_turn_event(json!({ "type":"progress", "data":sequence_local_api_event(payload, &self.sequence) }));
    }
}

pub fn run_api_turn() -> i32 {
    let mut first = String::new();
    let request = (|| -> Result<NativeApiTurnRequest, String> {
        std::io::stdin().read_line(&mut first)
            .map_err(|_| "FORGE_NATIVE_API_READ_FAILED")?;
        if first.is_empty() || first.len() > 1_048_576 {
            return Err("FORGE_NATIVE_API_REQUEST_INVALID".into());
        }
        let value: Value = serde_json::from_str(first.trim_end())
            .map_err(|_| "FORGE_NATIVE_API_JSON_INVALID")?;
        parse_api_turn_request(&value)
    })();
    let request = match request {
        Ok(request) => request,
        Err(error) => {
            write_api_turn_event(json!({ "type":"result", "ok":false, "error":error }));
            return 0;
        }
    };

    let (cancel_sender, mut cancel_receiver) = tokio::sync::watch::channel(false);
    let cancel_reader = cancel_sender.clone();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break; };
            let Ok(value) = serde_json::from_str::<Value>(&line) else { continue; };
            if value.get("action").and_then(Value::as_str) == Some("cancel") {
                let _ = cancel_reader.send(true);
                break;
            }
        }
    });

    // Keep one sender owned by the turn itself. EOF on the parent pipe means
    // "no more control frames", not "cancel channel failed".
    let _cancel_channel_lifetime = cancel_sender;
    let host = NativeApiHost { sequence: std::sync::atomic::AtomicU64::new(0) };
    let terminal_conversation_id = request.conversation_id.clone();
    let result = tauri::async_runtime::block_on(async {
        let repository_effect_access = resolve_repository_effect_access(
            request.repo_id.as_deref(), request.checkout_id.as_deref()
        ).await?;
        run_local_api_turn(
            &host,
            request.messages,
            request.repo_id,
            request.checkout_id,
            request.conversation_id,
            Some(request.provider),
            request.model,
            repository_effect_access && request.allow_effects,
            &mut cancel_receiver,
        ).await
    });
    host.emit_model_progress(local_api_terminal_progress(&terminal_conversation_id, &result));
    match result {
        Ok(data) => write_api_turn_event(json!({ "type":"result", "ok":true, "data":data })),
        Err(error) => write_api_turn_event(json!({ "type":"result", "ok":false, "error":error })),
    }
    0
}

fn parse_native_model_round_request(value: &Value) -> Result<Value, String> {
    if value.get("provider").and_then(Value::as_str) != Some("joycode") {
        return Err("FORGE_NATIVE_MODEL_PROVIDER_INVALID".into());
    }
    let body = value.get("body").and_then(Value::as_object)
        .ok_or("FORGE_NATIVE_MODEL_BODY_REQUIRED")?;
    let model = body.get("model").and_then(Value::as_str).unwrap_or("").trim();
    if model.is_empty() || model.len() > 120 {
        return Err("FORGE_NATIVE_MODEL_MODEL_INVALID".into());
    }
    if !body.get("messages").is_some_and(Value::is_array)
        || !body.get("tools").is_some_and(Value::is_array) {
        return Err("FORGE_NATIVE_MODEL_BODY_INVALID".into());
    }
    Ok(Value::Object(body.clone()))
}

pub fn run_model_round() -> i32 {
    let result = (|| -> Result<Value, String> {
        let mut input = String::new();
        std::io::stdin().take(8 * 1024 * 1024 + 1)
            .read_to_string(&mut input)
            .map_err(|_| "FORGE_NATIVE_MODEL_READ_FAILED")?;
        if input.len() > 8 * 1024 * 1024 {
            return Err("FORGE_NATIVE_MODEL_REQUEST_TOO_LARGE".into());
        }
        let value: Value = serde_json::from_str(&input)
            .map_err(|_| "FORGE_NATIVE_MODEL_JSON_INVALID")?;
        let body = parse_native_model_round_request(&value)?;
        let session = read_joycode_session()?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(180))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "FORGE_NATIVE_MODEL_CLIENT_FAILED")?;
        tauri::async_runtime::block_on(request_local_api_round(
            &client,
            JOYCODE_COLOR_GATEWAY_ORIGIN,
            "openai",
            None,
            Some(&session),
            &body,
        ))
    })();
    let envelope = match result {
        Ok(data) => json!({ "ok": true, "data": data }),
        Err(error) => json!({ "ok": false, "error": error }),
    };
    println!("{envelope}");
    0
}

pub fn run() -> i32 {
    let result = (|| -> Result<Value, String> {
        let mut input = String::new();
        std::io::stdin().take(1_048_577)
            .read_to_string(&mut input)
            .map_err(|_| "FORGE_NATIVE_BRIDGE_READ_FAILED")?;
        if input.len() > 1_048_576 {
            return Err("FORGE_NATIVE_BRIDGE_REQUEST_TOO_LARGE".into());
        }
        let value: Value = serde_json::from_str(&input)
            .map_err(|_| "FORGE_NATIVE_BRIDGE_JSON_INVALID")?;
        let operation = required(&value, "operation")?;
        let args = value.get("arguments").unwrap_or(&Value::Null);
        tauri::async_runtime::block_on(dispatch(&operation, args))
    })();
    let envelope = match result {
        Ok(data) => json!({ "ok": true, "data": data }),
        Err(error) => json!({ "ok": false, "error": error }),
    };
    println!("{envelope}");
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_model_round_accepts_only_bounded_joycode_chat_payloads() {
        let body = parse_native_model_round_request(&json!({
            "provider":"joycode",
            "body":{
                "model":"JoyAI-Code-1.6",
                "messages":[{"role":"user","content":"continue"}],
                "tools":[]
            }
        })).expect("valid JoyCode model round");
        assert_eq!(body.get("model").and_then(Value::as_str), Some("JoyAI-Code-1.6"));
        assert!(parse_native_model_round_request(&json!({
            "provider":"api",
            "body":{"model":"x","messages":[],"tools":[]}
        })).is_err());
        assert!(parse_native_model_round_request(&json!({
            "provider":"joycode",
            "body":{"model":"JoyAI-Code-1.6","messages":[]}
        })).is_err());
    }

    #[test]
    fn native_api_turn_protocol_is_typed_and_separate_from_one_shot_bridge() {
        let request = parse_api_turn_request(&json!({
            "conversationId":"thread-1",
            "repoId":"repo_1",
            "checkoutId":"checkout_1",
            "messages":[{"role":"user","content":"hello"}],
            "model":"thread-model",
            "allowEffects":true
        })).expect("valid native API turn");
        assert_eq!(request.conversation_id, "thread-1");
        assert_eq!(request.repo_id.as_deref(), Some("repo_1"));
        assert_eq!(request.checkout_id.as_deref(), Some("checkout_1"));
        assert_eq!(request.model.as_deref(), Some("thread-model"));
        assert_eq!(request.messages.len(), 1);
        assert!(request.allow_effects);
        let read_only = parse_api_turn_request(&json!({
            "conversationId":"thread-1","repoId":"repo_1","checkoutId":"checkout_1",
            "allowEffects":false,
            "messages":[{"role":"user","content":"inspect only"}]
        })).expect("read only native turn");
        assert!(!read_only.allow_effects);
        assert!(parse_api_turn_request(&json!({
            "conversationId":"thread-1","allowEffects":"false", "messages":[]
        })).is_err());
        let without_legacy_flag = parse_api_turn_request(&json!({
            "conversationId":"thread-1","repoId":"repo_1","checkoutId":"checkout_1",
            "messages":[{"role":"user","content":"hello"}]
        })).expect("missing allowEffects cannot elevate canonical policy");
        assert_eq!(without_legacy_flag.repo_id.as_deref(), Some("repo_1"));
        assert!(without_legacy_flag.allow_effects);
        assert!(parse_api_turn_request(&json!({"conversationId":"thread-1"})).is_err());

        let helper = Path::new("/Applications/Forge.app/Contents/MacOS/forge-desktop");
        assert_eq!(
            native_tool_script_for_executable(helper).unwrap(),
            PathBuf::from("/Applications/Forge.app/Contents/Resources/forge-local-tool.mjs")
        );
        let one_shot = tauri::async_runtime::block_on(dispatch(
            "send_local_api_conversation", &json!({})
        ));
        assert_eq!(one_shot.unwrap_err(), "FORGE_NATIVE_BRIDGE_OPERATION_UNSUPPORTED");
    }

    #[test]
    fn scoped_user_request_merge_preserves_exact_counts_and_legacy_fallback() {
        let global = json!({"data":{
            "items":[{"requestId":"global-1","updatedAt":"2026-11-09T00:00:00Z"}],
            "totalCount":1,
            "truncated":false,
            "scope":"global"
        }});
        let repo = json!({"data":{
            "items":[{"requestId":"repo-1","targetScope":{"repoId":"repo-a"},"updatedAt":"2026-11-09T01:00:00Z"}],
            "totalCount":1,
            "truncated":false,
            "scope":"repository"
        }});
        let exact = merge_user_request_projections(global, Some(repo), true);
        assert_eq!(exact.get("totalCount").and_then(Value::as_u64), Some(2));
        assert_eq!(exact.get("countExact").and_then(Value::as_bool), Some(true));
        assert_eq!(exact.get("possiblyTruncated").and_then(Value::as_bool), Some(false));

        let legacy_items = (0..50).map(|index| {
            if index == 0 {
                json!({"requestId":"global-legacy","updatedAt":"2026-11-09T00:00:00Z"})
            } else {
                json!({"requestId":format!("other-{index}"),"targetScope":{"repoId":"repo-other"}})
            }
        }).collect::<Vec<_>>();
        let legacy = merge_user_request_projections(json!({"data":{"items":legacy_items}}), None, false);
        assert_eq!(legacy.get("knownCount").and_then(Value::as_u64), Some(1));
        assert_eq!(legacy.get("countExact").and_then(Value::as_bool), Some(false));
        assert_eq!(legacy.get("possiblyTruncated").and_then(Value::as_bool), Some(true));
    }

    #[test]
    fn bridge_never_accepts_arbitrary_command_execution() {
        let invalid = tauri::async_runtime::block_on(dispatch("execute_command", &json!({})));
        assert_eq!(invalid.unwrap_err(), "FORGE_NATIVE_BRIDGE_OPERATION_UNSUPPORTED");
        let missing_checkout = tauri::async_runtime::block_on(dispatch("autopilot_control", &json!({
            "repoId":"repo_1",
            "requirementId":"REQ-1",
            "operation":"status"
        })));
        assert_eq!(missing_checkout.unwrap_err(), "FORGE_NATIVE_BRIDGE_checkoutId_REQUIRED");
        let merged = merge_user_request_projections(
            json!({"data":{"items":[
                {"requestId":"global","title":"Global","summary":"g","status":"pending","updatedAt":"2026-11-09T02:00:00Z"},
                {"requestId":"foreign","title":"Foreign","summary":"f","status":"pending","updatedAt":"2026-11-09T03:00:00Z","targetScope":{"repoId":"repo-b"}}
            ]}}),
            Some(json!({"data":{"items":[
                {"requestId":"repo","title":"Repo","summary":"r","status":"pending","updatedAt":"2026-11-09T04:00:00Z","targetScope":{"repoId":"repo-a"}}
            ]}})),
            false,
        );
        assert_eq!(merged.get("knownCount").and_then(Value::as_u64), Some(2));
        let ids = merged.get("items").and_then(Value::as_array).unwrap().iter()
            .filter_map(|item| item.get("requestId").and_then(Value::as_str)).collect::<Vec<_>>();
        assert_eq!(ids, vec!["repo", "global"]);
        assert_eq!(merged.get("possiblyTruncated").and_then(Value::as_bool), Some(false));

        let fake_accept = tauri::async_runtime::block_on(dispatch("control_user_request", &json!({
            "requestId":"req-1",
            "action":"accept",
            "decision":"accepted"
        })));
        assert_eq!(fake_accept.unwrap_err(), "FORGE_DESKTOP_USER_REQUEST_ACTION_UNSUPPORTED");
        let empty_resolution = tauri::async_runtime::block_on(dispatch("control_user_request", &json!({
            "requestId":"req-1",
            "action":"resolve",
            "decision":""
        })));
        assert_eq!(empty_resolution.unwrap_err(), "FORGE_DESKTOP_USER_REQUEST_DECISION_REQUIRED");
        assert_eq!(required(&json!({"repoId":""}), "repoId").unwrap_err(),
                   "FORGE_NATIVE_BRIDGE_repoId_REQUIRED");
        assert_eq!(required_strings(&json!({"paths":["src/main.rs"]}), "paths", 32).unwrap(),
                   vec!["src/main.rs".to_string()]);
        assert!(required_strings(&json!({"paths":[]}), "paths", 32).is_err());
        assert_eq!(optional_strings(&json!({}), "imagePaths", 4).unwrap(), None);
        assert_eq!(optional_strings(&json!({"imagePaths":["/tmp/a.png"]}), "imagePaths", 4).unwrap(),
                   Some(vec!["/tmp/a.png".to_string()]));
    }
}
