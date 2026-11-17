import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runMcpDoctor } from "../../adapters/mcp/setup";
import { recordMcpTransportEvent } from "../../src/runtime/diagnostics/mcp-timing";
import { mcpControllerHomeOAuthPath, mcpControllerHomeTokenPath } from "../../adapters/mcp/auth";
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

  test("user-level MCP doctor succeeds from a non-Git directory without invoking Git", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-mcp-doctor-user-level-"));
    const controllerHome = join(root, "controller-home");
    const binDir = join(root, "bin");
    const gitCalls = join(root, "git-calls.log");
    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    const previousControllerHome = process.env.FORGE_CONTROLLER_HOME;
    try {
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "git"), `#!/bin/sh\nprintf 'called\\n' >> "${gitCalls}"\nexit 1\n`);
      chmodSync(join(binDir, "git"), 0o700);
      process.env.PATH = binDir;
      delete process.env.FORGE_CONTROLLER_HOME;
      process.chdir(root);

      const result = runMcpDoctor({ userLevel: true, controllerHome, json: true });
      const report = JSON.parse(result.lines[0] ?? "{}") as {
        scope?: string;
        status?: string;
        repo?: string;
        mcp?: { localConfig?: boolean; authConfigured?: boolean };
        chatgpt?: { setup?: string };
      };

      expect(existsSync(gitCalls)).toBe(false);
      expect(result.repoRoot).toBeUndefined();
      expect(report).toMatchObject({
        scope: "user",
        status: "user_level",
        mcp: { localConfig: false, authConfigured: false },
        chatgpt: { setup: `forge mcp setup chatgpt --user-level --controller-home ${JSON.stringify(controllerHome)}` },
      });
      expect(report.repo).toBeUndefined();
    } finally {
      process.chdir(previousCwd);
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousControllerHome === undefined) delete process.env.FORGE_CONTROLLER_HOME;
      else process.env.FORGE_CONTROLLER_HOME = previousControllerHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports Controller Home credential presence without exposing values or claiming ownership of Secure Tunnel secrets", () => {
    const { repoDir, controllerHome } = makeFixture();
    const oauthSecret = "synthetic-oauth-secret-value";
    const bearerSecret = "synthetic-bearer-secret-value";
    try {
      mkdirSync(join(controllerHome, "mcp"), { recursive: true });
      writeFileSync(mcpControllerHomeOAuthPath(controllerHome), oauthSecret);
      writeFileSync(mcpControllerHomeTokenPath(controllerHome), bearerSecret);
      const result = withControllerHome(controllerHome, () => runMcpDoctor({ repo: repoDir, json: true }));
      const report = JSON.parse(result.lines[0] ?? "{}") as {
        credentialBoundary?: {
          controllerHome?: { oauthFileConfigured?: boolean; bearerTokenFileConfigured?: boolean; secretValuesExposed?: boolean };
          openAiSecureTunnel?: { credentialName?: string; credentialOwner?: string; persistedByForge?: boolean };
        };
      };
      expect(report.credentialBoundary).toEqual({
        controllerHome: {
          oauthFileConfigured: true,
          bearerTokenFileConfigured: true,
          secretValuesExposed: false,
        },
        openAiSecureTunnel: {
          credentialName: "CONTROL_PLANE_API_KEY",
          credentialOwner: "external_runtime_environment",
          persistedByForge: false,
        },
      });
      expect(JSON.stringify(report)).not.toContain(oauthSecret);
      expect(JSON.stringify(report)).not.toContain(bearerSecret);
    } finally {
      rmSync(join(controllerHome, ".."), { recursive: true, force: true });
    }
  });

  test("reports the persisted last session-close reason when the Connector is no longer reachable", () => {
    const { controllerHome } = makeFixture();
    const closedAt = new Date(Date.now() - 1_000).toISOString();
    const initializedAt = new Date().toISOString();
    try {
      recordMcpTransportEvent(controllerHome, {
        kind: "session_closed",
        sessionId: "expired-session",
        connectionId: "connection-expired",
        route: "/mcp",
        principalId: "oauth-client:fixture",
        reason: "idle_ttl",
        at: closedAt,
      });
      recordMcpTransportEvent(controllerHome, {
        kind: "session_initialized",
        sessionId: "replacement-session",
        connectionId: "connection-expired",
        route: "/mcp",
        principalId: "oauth-client:fixture",
        at: initializedAt,
      });

      const json = withControllerHome(controllerHome, () => runMcpDoctor({
        userLevel: true,
        controllerHome,
        json: true,
      }));
      const report = JSON.parse(json.lines[0] ?? "{}") as {
        transportEvidence?: {
          lastSessionClose?: { kind?: string; at?: string; reason?: string; route?: string; sessionId?: string } | null;
          reinitializedAfterLastClose?: boolean;
        };
      };
      expect(report.transportEvidence).toEqual({
        lastSessionClose: {
          kind: "session_closed",
          at: closedAt,
          reason: "idle_ttl",
          route: "/mcp",
          sessionId: "expired-session",
        },
        reinitializedAfterLastClose: true,
      });

      const human = withControllerHome(controllerHome, () => runMcpDoctor({
        userLevel: true,
        controllerHome,
      }));
      expect(human.lines.some((line) => line.includes("Last MCP session close: idle_ttl"))).toBe(true);
      expect(human.repoRoot).toBeUndefined();
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
