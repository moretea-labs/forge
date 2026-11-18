import { spawnSync } from "node:child_process";

export const AGENTMAIL_WATCH_KEYCHAIN_HANDOFF_SERVICE =
  "com.moretea.agentmail.forge-watch-device.handoff";

interface HandoffOptions {
  keychainCommand?: string;
  platform?: string;
}

const KEYCHAIN_SCRIPT = "import Foundation\nimport Security\n\nlet arguments = CommandLine.arguments\nguard arguments.count >= 4 else { exit(2) }\nlet operation = arguments[1]\nlet account = arguments[2]\nlet service = arguments[3]\nlet query: [String: Any] = [\n    kSecClass as String: kSecClassGenericPassword,\n    kSecAttrService as String: service,\n    kSecAttrAccount as String: account\n]\n\nswitch operation {\ncase \"read\":\n    var readQuery = query\n    readQuery[kSecReturnData as String] = true\n    readQuery[kSecMatchLimit as String] = kSecMatchLimitOne\n    var result: CFTypeRef?\n    let status = SecItemCopyMatching(readQuery as CFDictionary, &result)\n    if status == errSecItemNotFound { exit(44) }\n    guard status == errSecSuccess, let data = result as? Data, !data.isEmpty else {\n        exit(1)\n    }\n    FileHandle.standardOutput.write(data)\n\ncase \"write\":\n    let data = FileHandle.standardInput.readDataToEndOfFile()\n    guard !data.isEmpty else { exit(2) }\n    let updateStatus = SecItemUpdate(\n        query as CFDictionary,\n        [kSecValueData as String: data] as CFDictionary\n    )\n    let status: OSStatus\n    if updateStatus == errSecItemNotFound {\n        var item = query\n        item[kSecValueData as String] = data\n        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly\n        status = SecItemAdd(item as CFDictionary, nil)\n    } else {\n        status = updateStatus\n    }\n    guard status == errSecSuccess else { exit(1) }\n\ncase \"delete\":\n    let status = SecItemDelete(query as CFDictionary)\n    guard status == errSecSuccess || status == errSecItemNotFound else {\n        exit(1)\n    }\n\ndefault:\n    exit(2)\n}\n";

interface KeychainResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runKeychain(
  keychainCommand: string,
  operation: "read" | "write" | "delete",
  deviceId: string,
  token?: string,
): KeychainResult {
  const result = spawnSync(
    keychainCommand,
    ["-e", KEYCHAIN_SCRIPT, operation, deviceId, AGENTMAIL_WATCH_KEYCHAIN_HANDOFF_SERVICE],
    {
      input: token,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  if (result.error || result.status === null) {
    throw new Error("AGENTMAIL_KEYCHAIN_HANDOFF_COMMAND_FAILED");
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function readExistingHandoff(
  keychainCommand: string,
  deviceId: string,
): string | undefined {
  const result = runKeychain(keychainCommand, "read", deviceId);
  if (result.status === 0) {
    const token = result.stdout.replace(/\r?\n$/, "");
    if (!token) throw new Error("AGENTMAIL_KEYCHAIN_HANDOFF_EMPTY");
    return token;
  }
  if (result.status === 44) return undefined;
  throw new Error("AGENTMAIL_KEYCHAIN_HANDOFF_READ_FAILED");
}

function writeHandoff(
  keychainCommand: string,
  deviceId: string,
  token: string,
): void {
  const result = runKeychain(keychainCommand, "write", deviceId, token);
  if (result.status !== 0) {
    throw new Error("AGENTMAIL_KEYCHAIN_HANDOFF_WRITE_FAILED");
  }
}

function removeHandoff(keychainCommand: string, deviceId: string): void {
  const result = runKeychain(keychainCommand, "delete", deviceId);
  if (result.status !== 0 && result.status !== 44) {
    throw new Error("AGENTMAIL_KEYCHAIN_HANDOFF_DELETE_FAILED");
  }
}

/**
 * Store the one-time AgentMail Watch token in the logged-in macOS Keychain.
 * The returned rollback restores the prior handoff item if the registry commit fails.
 * The token is sent to Security.framework over stdin, never as an argv value or CLI output.
 */
export function storeAgentMailWatchCredentialHandoff(
  deviceId: string,
  token: string,
  options: HandoffOptions = {},
): () => void {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error("AGENTMAIL_KEYCHAIN_HANDOFF_REQUIRES_MACOS");
  }
  if (!deviceId.trim() || !token.trim()) {
    throw new Error("AGENTMAIL_KEYCHAIN_HANDOFF_INVALID_INPUT");
  }

  const keychainCommand = options.keychainCommand ?? "/usr/bin/swift";
  const previousToken = readExistingHandoff(keychainCommand, deviceId);
  try {
    writeHandoff(keychainCommand, deviceId, token);
  } catch {
    try {
      if (previousToken === undefined) removeHandoff(keychainCommand, deviceId);
      else writeHandoff(keychainCommand, deviceId, previousToken);
    } catch {
      throw new Error("AGENTMAIL_KEYCHAIN_HANDOFF_ROLLBACK_FAILED");
    }
    throw new Error("AGENTMAIL_KEYCHAIN_HANDOFF_WRITE_FAILED");
  }

  return () => {
    if (previousToken === undefined) removeHandoff(keychainCommand, deviceId);
    else writeHandoff(keychainCommand, deviceId, previousToken);
  };
}
