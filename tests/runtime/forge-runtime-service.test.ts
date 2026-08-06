import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { forgeRuntimeServicePaths, renderForgeRuntimeLaunchAgent } from '../../src/runtime/root/service';
import { resolveForgeRuntimeServiceCommand } from '../../src/runtime/root/service-runner';
import { publishRuntimeRelease } from '../../src/runtime/root/release-store';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): { root: string; home: string; repo: string; token:[REDACTED] } {
  const root = mkdtempSync(join(tmpdir(), 'forge-runtime-service-'));
  roots.push(root);
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  const token=[REDACTED]
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(token, 'test-token\n', { mode: 0o600 });
  return { root, home, repo, token };
}

function createRelease(home: string, root: string, id: string): string {
  const releaseRoot = join(root, id);
  mkdirSync(releaseRoot, { recursive: true });
  const executable = join(releaseRoot, 'forge-runtime');
  writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  chmodSync(executable, 0o755);
  const manifest = join(releaseRoot, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({
    schemaVersion: 1,
    releaseId: id,
    artifactIdentity: `artifact-${id}`,
    entrypoint: 'forge-runtime',
    arguments: [],
    configurationSchemaVersion: 1,
    controllerHome: home,
    databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
    workerProtocolVersion: 1,
    createdAt: new Date().toISOString(),
  }));
  return manifest;
}

const databaseHooks = {
  backupDatabase: (_home: string, destination: string) => {
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, 'backup');
    return { path: destination, schemaVersion: 1, integrity: 'ok' as const, recordCount: 0, auditEventCount: 0, orphanRecordCount: 0 };
  },
  restoreDatabase: (_home: string, backup: string) => ({ path: backup, schemaVersion: 1, integrity: 'ok' as const, recordCount: 0, auditEventCount: 0, orphanRecordCount: 0 }),
};

describe('Forge Runtime launchd service', () => {
  test('renders RunAtLoad and unsuccessful-exit KeepAlive around the stable runner', () => {
    const fx = fixture();
    const paths = forgeRuntimeServicePaths(fx.home);
    const plist = renderForgeRuntimeLaunchAgent({ paths, nodeExecutable: '/usr/bin/node', runnerPath: '/opt/forge/bin/forge-runtime-service.mjs' });
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>SuccessfulExit</key>');
    expect(plist).toContain('<false/>');
    expect(plist).toContain('<key>ThrottleInterval</key>');
    expect(plist).toContain('<integer>5</integer>');
    expect(plist).toContain('forge-runtime-service.mjs');
    expect(plist).not.toContain('forge-mcp-launch');
  });

  test('resolves the current active whole release on every runner start', () => {
    const fx = fixture();
    const configPath = forgeRuntimeServicePaths(fx.home).configPath;
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, controllerHome: fx.home, repositoryRoot: fx.repo, host: '127.0.0.1', port: 8765, authTokenFile: fx.token }));
    publishRuntimeRelease(fx.home, createRelease(fx.home, fx.root, 'release-a'), 'publish-a', databaseHooks);
    expect(resolveForgeRuntimeServiceCommand(fx.home, configPath).executable).toContain('release-a/forge-runtime');
    publishRuntimeRelease(fx.home, createRelease(fx.home, fx.root, 'release-b'), 'publish-b', databaseHooks);
    expect(resolveForgeRuntimeServiceCommand(fx.home, configPath).executable).toContain('release-b/forge-runtime');
  });
});
