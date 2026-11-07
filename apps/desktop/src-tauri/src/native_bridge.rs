// One-shot typed IPC adapter for the native SwiftUI client.
// Reuses the exact Forge MCP and Keychain implementations in main.rs.
// No daemon, extra token store, shell execution, or general tool gateway.
use super::*;
use std::io::Read;

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
        "read_project_work_list" =>
            read_project_work_list(required(args, "repoId")?).await,
        "read_project_plan_list" =>
            read_project_plan_list(required(args, "repoId")?).await,
        "read_work_detail" =>
            read_work_detail(required(args, "repoId")?, required(args, "workId")?).await,
        "read_requirement_detail" =>
            read_requirement_detail(required(args, "repoId")?, required(args, "requirementId")?).await,
        "read_plan_detail" =>
            read_plan_detail(required(args, "repoId")?, required(args, "planId")?).await,
        "read_project_knowledge" =>
            read_project_knowledge(
                required(args, "repoId")?,
                args.get("workId").and_then(Value::as_str).map(str::to_owned),
                args.get("query").and_then(Value::as_str).unwrap_or("").to_string(),
            ).await,
        "read_recovery_status" => read_recovery_status().await,
        "read_connection_status" => read_connection_status().await,
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
            read_agent_git_diff_runtime(
                &repo_id, Some(&checkout_id),
                args.get("staged").and_then(Value::as_bool).unwrap_or(false), None,
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
        "read_local_api_settings" => read_local_api_settings(),
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
