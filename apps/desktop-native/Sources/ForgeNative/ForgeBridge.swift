import Foundation

enum ForgeBridgeError: LocalizedError {
    case missingHelper, invalidResponse, remote(String)
    var errorDescription: String? {
        switch self {
        case .missingHelper: return "Native Forge helper is missing from the app bundle."
        case .invalidResponse: return "Native Forge bridge returned an invalid result."
        case .remote(let message): return message
        }
    }
}

/// IPC adapter, not a backend: each request launches the bundled Rust binary
/// once, using a strict operation allowlist. No shell, daemon, or token copy.
enum ForgeBridge {
    static let allowed: Set<String> = [
        "read_projects", "read_project_repository", "read_project_overview",
        "read_project_plan_list",
        "read_requirement_detail", "read_plan_detail",
        "read_project_knowledge", "read_recovery_status", "read_connection_status",
        "read_local_provider_status", "read_local_provider_models", "read_local_conversation_activity",
        "read_agent_git_diff", "commit_agent_git_files", "restore_agent_git_files", "read_local_api_settings",
        "send_local_conversation", "cancel_local_conversation"
    ]

    static func request(_ name: String, _ arguments: [String: Any] = [:]) async throws -> [String: Any] {
        guard allowed.contains(name) else {
            throw ForgeBridgeError.remote("FORGE_NATIVE_BRIDGE_OPERATION_UNSUPPORTED")
        }
        let data = try JSONSerialization.data(withJSONObject: [
            "operation": name, "arguments": arguments
        ])
        guard data.count <= 1_048_576 else {
            throw ForgeBridgeError.remote("FORGE_NATIVE_BRIDGE_REQUEST_TOO_LARGE")
        }
        let executable = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/forge-desktop")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw ForgeBridgeError.missingHelper
        }
        return try await Task.detached(priority: .userInitiated) {
            let child = Process()
            child.executableURL = executable
            child.arguments = ["--native-bridge"]
            let input = Pipe(), output = Pipe()
            child.standardInput = input
            child.standardOutput = output
            child.standardError = FileHandle.nullDevice
            try child.run()
            input.fileHandleForWriting.write(data)
            try? input.fileHandleForWriting.close()
            let reply = output.fileHandleForReading.readDataToEndOfFile()
            child.waitUntilExit()
            guard child.terminationStatus == 0,
                  let envelope = try JSONSerialization.jsonObject(with: reply) as? [String: Any],
                  let ok = envelope["ok"] as? Bool else {
                throw ForgeBridgeError.invalidResponse
            }
            guard ok else {
                throw ForgeBridgeError.remote(envelope["error"] as? String ?? "FORGE_NATIVE_BRIDGE_ERROR")
            }
            guard let result = envelope["data"] as? [String: Any] else {
                throw ForgeBridgeError.invalidResponse
            }
            return result
        }.value
    }
}
