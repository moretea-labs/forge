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
        "read_project_repository" =>
            read_project_repository(required(args, "repoId")?).await,
        "read_project_overview" =>
            read_project_overview(required(args, "repoId")?).await,
        "read_project_plan_list" =>
            read_project_plan_list(required(args, "repoId")?).await,
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
        "read_project_knowledge" =>
            read_project_knowledge(
                required(args, "repoId")?,
                args.get("query").and_then(Value::as_str).unwrap_or("").to_string(),
            ).await,
        "read_recovery_status" => read_recovery_status().await,
        "verify_recovery_runtime" => verify_recovery_runtime().await,
        "read_connection_status" => read_connection_status().await,
        "repair_connection" => repair_connection().await,
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
            required(args,"provider")?,
            required(args,"endpoint")?,
            args.get("model").and_then(Value::as_str).unwrap_or("").to_string(),
            args.get("apiKey").and_then(Value::as_str).map(str::to_owned),
            args.get("apiProtocol").and_then(Value::as_str).map(str::to_owned),
        ),
        "clear_local_api_key" => clear_local_api_key(),
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
    model: Option<String>,
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
    Ok(NativeApiTurnRequest {
        messages,
        repo_id,
        checkout_id,
        conversation_id,
        model:value.get("model").and_then(Value::as_str)
            .map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned),
        allow_effects:value.get("allowEffects").and_then(Value::as_bool).unwrap_or(false),
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

struct NativeApiHost;
impl LocalApiHost for NativeApiHost {
    fn packaged_tool_script(&self) -> Result<PathBuf, String> {
        let executable = std::env::current_exe()
            .map_err(|_| "FORGE_DESKTOP_LOCAL_TOOL_RESOURCE_UNAVAILABLE")?;
        native_tool_script_for_executable(&executable)
    }

    fn emit_tool_progress(&self, payload: Value) {
        write_api_turn_event(json!({ "type":"progress", "data":payload }));
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
    let host = NativeApiHost;
    let result = tauri::async_runtime::block_on(run_local_api_turn(
        &host,
        request.messages,
        request.repo_id,
        request.checkout_id,
        request.conversation_id,
        request.model,
        request.allow_effects,
        &mut cancel_receiver,
    ));
    match result {
        Ok(data) => write_api_turn_event(json!({ "type":"result", "ok":true, "data":data })),
        Err(error) => write_api_turn_event(json!({ "type":"result", "ok":false, "error":error })),
    }
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
        assert!(request.allow_effects);
        assert_eq!(request.messages.len(), 1);
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
    fn bridge_never_accepts_arbitrary_command_execution() {
        let invalid = tauri::async_runtime::block_on(dispatch("execute_command", &json!({})));
        assert_eq!(invalid.unwrap_err(), "FORGE_NATIVE_BRIDGE_OPERATION_UNSUPPORTED");
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
