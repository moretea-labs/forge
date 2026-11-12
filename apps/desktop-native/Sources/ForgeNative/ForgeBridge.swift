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

final class ForgeApiTurn: @unchecked Sendable {
    private let child: Process
    private let input: FileHandle
    private let output: FileHandle
    private let writeLock = NSLock()
    private var cancelSent = false

    init(child: Process, input: FileHandle, output: FileHandle) {
        self.child = child
        self.input = input
        self.output = output
    }

    func cancel() {
        writeLock.lock()
        defer { writeLock.unlock() }
        guard !cancelSent, child.isRunning else { return }
        cancelSent = true
        guard let data = "{\"action\":\"cancel\"}\n".data(using:.utf8) else { return }
        input.write(data)
    }

    static func decodeEvent(_ data: Data) -> [String:Any]? {
        guard !data.isEmpty,
              let value = try? JSONSerialization.jsonObject(with:data) as? [String:Any],
              value["type"] as? String != nil else { return nil }
        return value
    }

    func wait(onProgress: @escaping ([String:Any]) async -> Void) async throws -> [String:Any] {
        try await Task.detached(priority:.userInitiated) { [child,input,output] in
            var buffer = Data()
            var result: [String:Any]?
            var remoteError: String?

            func consume(_ line: Data) async {
                guard let event = Self.decodeEvent(line), let type = event["type"] as? String else { return }
                if type == "progress", let payload = event["data"] as? [String:Any] {
                    await onProgress(payload)
                } else if type == "result", let ok = event["ok"] as? Bool {
                    if ok { result = event["data"] as? [String:Any] }
                    else { remoteError = event["error"] as? String ?? "FORGE_NATIVE_API_ERROR" }
                }
            }

            while true {
                let chunk = try output.read(upToCount:4096) ?? Data()
                if chunk.isEmpty { break }
                buffer.append(chunk)
                let newline = Data([0x0A])
                while let range = buffer.range(of:newline) {
                    let line = buffer.subdata(in:buffer.startIndex..<range.lowerBound)
                    buffer.removeSubrange(buffer.startIndex..<range.upperBound)
                    await consume(line)
                }
            }
            if !buffer.isEmpty { await consume(buffer) }
            try? input.close()
            child.waitUntilExit()
            guard child.terminationStatus == 0 else { throw ForgeBridgeError.invalidResponse }
            if let remoteError { throw ForgeBridgeError.remote(remoteError) }
            guard let result else { throw ForgeBridgeError.invalidResponse }
            return result
        }.value
    }
}

/// IPC adapter, not a backend: each request launches the bundled Rust binary
/// once, using a strict operation allowlist. No shell, daemon, or token copy.
enum ForgeBridge {
    static let allowed: Set<String> = [
        "read_projects", "register_project", "read_github_project_items", "read_project_repository", "read_repository_access", "set_repository_access", "read_project_overview",
        "read_project_requirement_list", "read_project_plan_list", "read_project_autopilot_statuses",
        "read_project_schedules", "control_project_schedule", "read_project_plugins",
        "read_user_requests", "control_user_request",
        "read_requirement_detail", "read_plan_detail", "create_requirement", "create_plan", "revise_requirement", "revise_plan", "autopilot_control",
        "read_project_knowledge", "read_recovery_status", "verify_recovery_runtime",
        "read_connection_status", "configure_initial_connection", "repair_connection",
        "read_plugin_management", "install_official_plugin",
        "read_local_provider_status", "read_local_provider_models", "read_local_conversation_activity",
        "read_agent_git_diff", "commit_agent_git_files", "restore_agent_git_files",
        "read_local_api_settings", "save_local_api_settings", "managed_api_credential_control",
        "send_local_conversation", "cancel_local_conversation"
    ]

    static func startApiTurn(_ arguments:[String:Any]) throws -> ForgeApiTurn {
        let data = try JSONSerialization.data(withJSONObject:arguments)
        guard data.count <= 1_048_575 else {
            throw ForgeBridgeError.remote("FORGE_NATIVE_API_REQUEST_TOO_LARGE")
        }
        let executable = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/forge-desktop")
        guard FileManager.default.isExecutableFile(atPath:executable.path) else {
            throw ForgeBridgeError.missingHelper
        }
        let child = Process()
        child.executableURL = executable
        child.arguments = ["--native-api-turn"]
        let input = Pipe(), output = Pipe()
        child.standardInput = input
        child.standardOutput = output
        child.standardError = FileHandle.nullDevice
        try child.run()
        var line = data
        line.append(0x0A)
        input.fileHandleForWriting.write(line)
        return ForgeApiTurn(
            child:child,
            input:input.fileHandleForWriting,
            output:output.fileHandleForReading
        )
    }

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
