import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
