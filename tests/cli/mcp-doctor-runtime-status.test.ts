import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runMcpDoctor } from "../../adapters/mcp/setup";
import type { RuntimeStatusSnapshot } from "../../src/runtime/root/types";

function makeFixture(): { repoDir: string; controllerHome: string } {
  const base = mkdtempSync(join(tmpdir(), "forge-mcp-doctor-"));
  const repoDir = join(base, "repo");
  const controllerHome = join(base, "controller-home");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(controllerHome, { recursive: true });
  return { repoDir, controllerHome };
}

function writeLiveRuntimeEvidence(controllerHome: string, runtimeInstanceId: string): void {
  const runtimeDir = join(controllerHome, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const observedAt = new Date().toISOString();
  // pid = this test process: alive by construction; the owner record omits
  // processStartTime/executableFingerprint so observation falls back to
  // isProcessAlive(pid), which is the documented compatibility path.
  const snapshot: RuntimeStatusSnapshot = {
    schemaVersion: 1,
    forgeInstanceId: "forge_doctor_fixture",
    runtimeInstanceId,
    pid: process.pid,
    releaseId: "fixture-release",
    artifactIdentity: "sha256:fixture",
    endpoint: "http://127.0.0.1:8765/mcp",
    readiness: {
      ready: true,
      reasonCodes: [],
      diagnostics: {
        database: { outcome: "pass" },
        scheduler: { outcome: "pass" },
        releaseCoherence: { outcome: "pass" },
        mcpEndToEnd: { outcome: "pass" },
      },
      observedAt,
    },
    startedAt: observedAt,
    updatedAt: observedAt,
  };
  writeFileSync(join(runtimeDir, "status.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  writeFileSync(
    join(runtimeDir, "active-runtime-owner.json"),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        runtimeInstanceId,
        pid: process.pid,
        acquiredAt: observedAt,
        fencingGeneration: 1,
      },
      null,
      2,
    )}\n`,
  );
}

function withControllerHome<T>(controllerHome: string, run: () => T): T {
  const previous = process.env.FORGE_CONTROLLER_HOME;
  process.env.FORGE_CONTROLLER_HOME = controllerHome;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.FORGE_CONTROLLER_HOME;
    else process.env.FORGE_CONTROLLER_HOME = previous;
  }
}

describe("forge mcp doctor runtime status", () => {
  test("reports the canonical runtime as running from the authoritative observation when connector service state is absent", () => {
    const { repoDir, controllerHome } = makeFixture();
    try {
      writeLiveRuntimeEvidence(controllerHome, "runtime_doctor_fixture_1");
      const result = withControllerHome(controllerHome, () => runMcpDoctor({ repo: repoDir }));
      const runtimeLine = result.lines.find((line) => line.startsWith("[forge mcp] Runtime:"));
      expect(runtimeLine).toBeDefined();
      expect(runtimeLine).toContain("running");
      expect(runtimeLine).not.toContain("not running");
      expect(runtimeLine).toContain(`pid=${process.pid}`);

      const jsonResult = withControllerHome(controllerHome, () => runMcpDoctor({ repo: repoDir, json: true }));
      const report = JSON.parse(jsonResult.lines[0] ?? "{}") as {
        canonicalRuntime?: { running?: boolean; ready?: boolean; pid?: number; endpoint?: string };
      };
      expect(report.canonicalRuntime?.running).toBe(true);
      expect(report.canonicalRuntime?.ready).toBe(true);
      expect(report.canonicalRuntime?.pid).toBe(process.pid);
      expect(report.canonicalRuntime?.endpoint).toBe("http://127.0.0.1:8765/mcp");
    } finally {
      rmSync(join(controllerHome, ".."), { recursive: true, force: true });
    }
  });

  test("still reports not running when the canonical runtime is genuinely absent", () => {
    const { repoDir, controllerHome } = makeFixture();
    try {
      const result = withControllerHome(controllerHome, () => runMcpDoctor({ repo: repoDir }));
      const runtimeLine = result.lines.find((line) => line.startsWith("[forge mcp] Runtime:"));
      expect(runtimeLine).toContain("not running");

      const jsonResult = withControllerHome(controllerHome, () => runMcpDoctor({ repo: repoDir, json: true }));
      const report = JSON.parse(jsonResult.lines[0] ?? "{}") as {
        canonicalRuntime?: { running?: boolean; reasonCodes?: string[] };
      };
      expect(report.canonicalRuntime?.running).toBe(false);
      expect(report.canonicalRuntime?.reasonCodes).toContain("RUNTIME_NOT_RUNNING");
    } finally {
      rmSync(join(controllerHome, ".."), { recursive: true, force: true });
    }
  });

  test("preserves the ChatGPT connector service state on its own line when present", () => {
    const { repoDir, controllerHome } = makeFixture();
    try {
      const mcpDir = join(controllerHome, "mcp");
      mkdirSync(mcpDir, { recursive: true });
      const observedAt = new Date().toISOString();
      writeFileSync(
        join(mcpDir, "mcp.runtime.json"),
        `${JSON.stringify(
          {
            version: 1,
            repo: repoDir,
            startedAt: observedAt,
            updatedAt: observedAt,
            status: "stopped",
            tunnelMode: "none",
            server: { endpoint: "http://127.0.0.1:8765/mcp", running: false, healthy: false, restartCount: 0 },
          },
          null,
          2,
        )}\n`,
      );
      const result = withControllerHome(controllerHome, () => runMcpDoctor({ repo: repoDir }));
      const connectorLine = result.lines.find((line) => line.startsWith("[forge mcp] ChatGPT connector service:"));
      expect(connectorLine).toContain("stopped");
      const runtimeLine = result.lines.find((line) => line.startsWith("[forge mcp] Runtime:"));
      expect(runtimeLine).toContain("not running");

      const jsonResult = withControllerHome(controllerHome, () => runMcpDoctor({ repo: repoDir, json: true }));
      const report = JSON.parse(jsonResult.lines[0] ?? "{}") as {
        runtime?: { status?: string };
        canonicalRuntime?: { running?: boolean };
      };
      expect(report.runtime?.status).toBe("stopped");
      expect(report.canonicalRuntime?.running).toBe(false);
    } finally {
      rmSync(join(controllerHome, ".."), { recursive: true, force: true });
    }
  });
});
