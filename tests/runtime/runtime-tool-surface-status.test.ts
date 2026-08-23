import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { CanonicalForgeRuntime, type CanonicalRuntimeDependencies } from '../../src/runtime/root/runtime';
import { observeRuntimeStatus } from '../../src/runtime/root/status';
import { clearRuntimeWriteClaimForTests } from '../../src/runtime/root/write-fence';
import type { CanonicalRuntimeConfig } from '../../src/runtime/root/types';

function inertScheduler() {
  let stopped = false;
  return {
    ready: Promise.resolve(),
    done: new Promise<void>((resolveDone) => {
      const timer = setInterval(() => {
        if (!stopped) return;
        clearInterval(timer);
        resolveDone();
      }, 5);
      timer.unref?.();
    }),
    stop: async () => { stopped = true; },
  };
}

function fixture(): { root: string; config: CanonicalRuntimeConfig } {
  const root = mkdtempSync(join(tmpdir(), 'forge-runtime-tool-surface-'));
  const controllerHome = join(root, 'controller');
  const repositoryRoot = join(root, 'repository');
  mkdirSync(repositoryRoot, { recursive: true });
  const manifestPath = join(root, 'release.json');
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    releaseId: 'release-tool-surface-test',
    artifactIdentity: 'sha256:tool-surface-test',
    entrypoint: 'forge-runtime',
    arguments: [],
    configurationSchemaVersion: 1,
    controllerHome: resolve(controllerHome),
    databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
    workerProtocolVersion: 1,
    createdAt: '2026-08-23T00:00:00.000Z',
  }), 'utf8');
  return {
    root,
    config: {
      controllerHome,
      repositoryRoot,
      releaseManifestPath: manifestPath,
      host: '127.0.0.1',
      port: 0,
      authToken: 'tool-surface-test-runtime-token',
      schedulerReadyTimeoutMs: 5_000,
    },
  };
}

describe('Canonical Runtime tool-surface status projection', () => {
  test('re-publishes a changed live fingerprint before Runtime schema observation', async () => {
    const fx = fixture();
    let fingerprint = 'schema-a';
    let observeToolSurface: (() => void) | undefined;
    const dependencies: Partial<CanonicalRuntimeDependencies> = {
      startScheduler: () => inertScheduler(),
      startLocalBridge: async () => undefined,
      startTransport: async (options) => {
        observeToolSurface = options.onToolSurfaceObservation;
        return {
          endpoint: 'http://127.0.0.1:9876/mcp',
          host: '127.0.0.1',
          port: 9876,
          close: async () => undefined,
        };
      },
      runMcpProbe: async () => undefined,
      computeToolSurfaceFingerprint: () => fingerprint,
    };
    const runtime = new CanonicalForgeRuntime(fx.config, dependencies);
    try {
      await runtime.start();
      expect(observeRuntimeStatus(fx.config.controllerHome).snapshot?.toolSurfaceFingerprint).toBe('schema-a');
      expect(observeToolSurface).toBeDefined();

      fingerprint = 'schema-b';
      observeToolSurface?.();

      expect(observeRuntimeStatus(fx.config.controllerHome).snapshot?.toolSurfaceFingerprint).toBe('schema-b');
    } finally {
      await runtime.stop('TEST_CLEANUP').catch(() => undefined);
      clearRuntimeWriteClaimForTests();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});
