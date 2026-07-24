import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "../..");

describe("Agent worker release ownership", () => {
  test("excludes the retired Agent worker from packaged Kernel releases", () => {
    const installer = readFileSync(join(ROOT, "src/runtime/supervisor/installer.ts"), "utf8");
    const manager = readFileSync(join(ROOT, "src/cli/agent-jobs/job-manager.ts"), "utf8");

    expect(installer).not.toContain("'src/cli/agent-jobs/job-worker.ts', join(releasePath, 'agent-worker.js')");
    expect(installer).not.toContain("agentWorkerEntrypoint: 'agent-worker.js'");
    expect(manager).toContain('join(controllerHome, "daemon", "controller.pid")');
    expect(manager).toContain("Kernel caller spawn one");
  });
});
