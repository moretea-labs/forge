import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { storeAgentMailWatchCredentialHandoff } from "../../src/cli/local-bridge/agentmail-keychain-handoff";
import { createMobileIntentDevice, rotateMobileIntentDevice } from "../../src/cli/local-bridge/mobile-intents";
import { registerRepository } from "../../src/runtime/repositories/registry";

const CLI = join(import.meta.dir, "../../src/cli/index.ts");

test("AgentMail device CLI requires explicit approval and issues only its Watch scope", () => {
  const temp = mkdtempSync(join(tmpdir(), "forge-agentmail-device-"));
  const root = join(temp, "source");
  const controllerHome = join(temp, "controller");
  mkdirSync(root, { recursive: true });
  mkdirSync(controllerHome, { recursive: true });
  try {
    const initialized = spawnSync("git", ["init", "-b", "main", root], { encoding: "utf8" });
    expect(initialized.status).toBe(0);
    const repository = registerRepository({ path: root, controllerHome });
    const args = [
      CLI, "repo", "agentmail-watch-device", repository.repoId,
      "--controller-home", controllerHome, "--json",
    ];
    const storePath = join(root, ".forge/mobile-intents.json");

    const rejected = spawnSync("bun", args, { encoding: "utf8" });
    expect(rejected.status).not.toBe(0);
    expect(existsSync(storePath)).toBe(false);

    const rotationWithoutApproval = spawnSync("bun", [...args, "--rotate-existing"], { encoding: "utf8" });
    expect(rotationWithoutApproval.status).not.toBe(0);
    expect(rotationWithoutApproval.stderr).toContain("--confirm-authorization");
    expect(existsSync(storePath)).toBe(false);

    const issued = spawnSync("bun", [...args, "--confirm-authorization"], { encoding: "utf8" });
    expect(issued.status).toBe(0);
    const result = JSON.parse(issued.stdout) as {
      token: string;
      device: { deviceId: string; scopes: string[] };
    };
    expect(result.device.deviceId).toBe("agentmail-mac-watch");
    expect(result.device.scopes).toEqual(["workflow:agentmail.mail-watch-event:execute"]);
    expect(result.token.length).toBeGreaterThan(24);
    const registryOnDisk = readFileSync(storePath, "utf8");
    expect(registryOnDisk).toContain("agentmail-mac-watch");
    expect(registryOnDisk).not.toContain(result.token);

    const repeated = spawnSync("bun", [...args, "--confirm-authorization"], { encoding: "utf8" });
    expect(repeated.status).not.toBe(0);
    expect(repeated.stderr).toContain("AGENTMAIL_WATCH_DEVICE_ALREADY_EXISTS");
    const stored = JSON.parse(readFileSync(storePath, "utf8")) as { devices: Array<{ deviceId: string }> };
    expect(stored.devices).toHaveLength(1);
    expect(stored.devices[0]!.deviceId).toBe("agentmail-mac-watch");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("AgentMail device rotation preserves its single scope and stores only a hash", () => {
  const temp = mkdtempSync(join(tmpdir(), "forge-agentmail-rotation-"));
  const root = join(temp, "source");
  mkdirSync(root, { recursive: true });
  try {
    const issued = createMobileIntentDevice(root, {
      name: "AgentMail Mac Watch",
      deviceId: "agentmail-mac-watch",
      scopes: ["workflow:agentmail.mail-watch-event:execute"],
      rateLimitPerMinute: 12,
    });
    const before = JSON.parse(readFileSync(join(root, ".forge/mobile-intents.json"), "utf8")) as {
      devices: Array<Record<string, unknown>>;
    };
    let handoffToken = "";
    const rotated = rotateMobileIntentDevice(root, issued.device.deviceId, (token) => {
      handoffToken = token;
      return () => { handoffToken = issued.token; };
    });
    const afterJSON = readFileSync(join(root, ".forge/mobile-intents.json"), "utf8");
    const after = JSON.parse(afterJSON) as { devices: Array<Record<string, unknown>> };
    const device = after.devices[0]!;

    expect(rotated.handoffStored).toBe(true);
    expect(rotated.device.deviceId).toBe("agentmail-mac-watch");
    expect("token" in rotated).toBe(false);
    expect(after.devices).toHaveLength(1);
    expect(device.deviceId).toBe("agentmail-mac-watch");
    expect(device.name).toBe("AgentMail Mac Watch");
    expect(device.scopes).toEqual(["workflow:agentmail.mail-watch-event:execute"]);
    expect(device.rateLimitPerMinute).toBe(12);
    expect(device.createdAt).toBe(before.devices[0]!.createdAt);
    expect(device.tokenHash).toBe(createHash("sha256").update(handoffToken).digest("hex"));
    expect(device.tokenHash).not.toBe(before.devices[0]!.tokenHash);
    expect(afterJSON).not.toContain(handoffToken);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("AgentMail Keychain handoff can restore the previous item or remove a newly-created item", () => {
  const temp = mkdtempSync(join(tmpdir(), "forge-agentmail-keychain-"));
  const storePath = join(temp, "handoff-token");
  const keychainPath = join(temp, "keychain");
  const script = [
    "#!/bin/sh",
    "set -eu",
    "store=" + JSON.stringify(storePath),
    'case "$3" in',
    "  read)",
    '    if [ -f "$store" ]; then',
    '      cat "$store"',
    "      printf '\\n'",
    "    else",
    "      printf '%s\\n' 'The specified item could not be found in the keychain.' >&2",
    "      exit 44",
    "    fi",
    "    ;;",
    "  write)",
    '    cat > "$store"',
    "    ;;",
    "  delete)",
    '    rm -f "$store"',
    "    ;;",
    "  *)",
    "    exit 2",
    "    ;;",
    "esac",
  ].join("\n");
  writeFileSync(keychainPath, script, { mode: 0o700 });
  try {
    writeFileSync(storePath, "previous-token");
    const rollbackPrevious = storeAgentMailWatchCredentialHandoff(
      "agentmail-mac-watch",
      "next-token",
      { keychainCommand: keychainPath, platform: "darwin" },
    );
    expect(readFileSync(storePath, "utf8")).toBe("next-token");
    rollbackPrevious();
    expect(readFileSync(storePath, "utf8")).toBe("previous-token");

    rmSync(storePath);
    const rollbackNew = storeAgentMailWatchCredentialHandoff(
      "agentmail-mac-watch",
      "fresh-token",
      { keychainCommand: keychainPath, platform: "darwin" },
    );
    expect(readFileSync(storePath, "utf8")).toBe("fresh-token");
    rollbackNew();
    expect(existsSync(storePath)).toBe(false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
