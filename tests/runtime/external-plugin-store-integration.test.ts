import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { installExternalPluginRegistration } from '../../src/runtime/plugins/external-registration';
import {
  assistantPluginScope,
  controllerPluginRepository,
  executeAssistantPluginAction,
  getAssistantPluginManifest,
  listAssistantPluginManifests,
} from '../../src/runtime/plugins/store';

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGTERM');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-external-store-'));
  roots.push(controllerHome);
  const socketPath = join(controllerHome, 'missing-desktop.sock');
  installExternalPluginRegistration(controllerHome, {
    pluginId: 'desktop_operator',
    providerPluginId: 'desktop_operator',
    displayName: 'Forge Desktop Operator',
    provider: 'local-macos',
    pluginVersion: '0.1.0',
    protocolVersion: '1.0',
    scope: 'controller',
    transport: { kind: 'unix_socket_jsonl', socketPath, healthTimeoutMs: 100, actionTimeoutMs: 500 },
    permissions: [{ scope: 'desktop.observe', mode: 'read', description: 'Observe desktop.', granted: true, required: true }],
    capabilities: [{ capabilityId: 'desktop-observe', title: 'Desktop observe', description: 'Observe desktop.', scopes: ['desktop.observe'], actions: ['desktop_status'] }],
    actions: [{ actionId: 'desktop_status', title: 'Desktop status', description: 'Read status.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 500, cancellable: true, idempotent: true, scopes: ['desktop.observe'], resourceClaims: [], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false } }],
  });
  return { controllerHome, socketPath, repository: controllerPluginRepository(controllerHome) };
}

async function liveFixture() {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-external-store-live-'));
  roots.push(controllerHome);
  const socketPath = join(controllerHome, 'desktop.sock');
  const serverPath = join(controllerHome, 'provider.cjs');
  writeFileSync(serverPath, `
const net = require('net');
const fs = require('fs');
const socketPath = process.argv[2];
try { fs.unlinkSync(socketPath); } catch (_) {}
const providerManifest = { id: 'desktop_operator', name: 'Forge Desktop Operator', version: '0.1.0', protocolVersion: '1.0', mode: 'external', scope: 'controller', provider: 'local-macos', capabilities: ['desktop.status'], actions: ['desktop_status'] };
const server = net.createServer((socket) => {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const newline = buffer.indexOf('\\n');
    if (newline < 0) return;
    const request = JSON.parse(buffer.slice(0, newline));
    if (request.method === 'manifest') socket.end(JSON.stringify({ id: request.id, ok: true, result: providerManifest }) + '\\n');
    else if (request.method === 'health') socket.end(JSON.stringify({ id: request.id, ok: true, result: { state: 'ready', warnings: [] } }) + '\\n');
    else if (request.method === 'execute') socket.end(JSON.stringify({ id: request.id, ok: false, error: { code: 'DESKTOP_TEST_FAILURE', message: 'synthetic provider failure', retryable: false, domain: 'desktop' } }) + '\\n');
    else socket.end(JSON.stringify({ id: request.id, ok: false, error: { code: 'METHOD_NOT_FOUND', message: request.method, retryable: false } }) + '\\n');
  });
});
server.listen(socketPath, () => process.stdout.write('ready\\n'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
  const child = spawn(process.execPath, [serverPath, socketPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error('provider did not start')), 5_000);
    child.once('error', reject);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes('ready\\n')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  installExternalPluginRegistration(controllerHome, {
    pluginId: 'desktop_operator', providerPluginId: 'desktop_operator', displayName: 'Forge Desktop Operator', provider: 'local-macos', pluginVersion: '0.1.0', protocolVersion: '1.0', scope: 'controller',
    transport: { kind: 'unix_socket_jsonl', socketPath, healthTimeoutMs: 500, actionTimeoutMs: 1_000 },
    permissions: [{ scope: 'desktop.observe', mode: 'read', description: 'Observe desktop.', granted: true, required: true }],
    capabilities: [{ capabilityId: 'desktop-observe', title: 'Desktop observe', description: 'Observe desktop.', scopes: ['desktop.observe'], actions: ['desktop_status'] }],
    actions: [{ actionId: 'desktop_status', title: 'Desktop status', description: 'Read status.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 500, cancellable: true, idempotent: true, scopes: ['desktop.observe'], resourceClaims: [], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false } }],
  });
  return { controllerHome, repository: controllerPluginRepository(controllerHome) };
}

describe('external plugin store integration', () => {
  test('lists trusted external registrations through the existing plugin surface with truthful degraded health', () => {
    const fx = fixture();
    const manifests = listAssistantPluginManifests(fx.controllerHome, fx.repository, { forceRefresh: true });
    const external = manifests.find((manifest) => manifest.pluginId === 'desktop_operator');
    expect(external).toBeDefined();
    expect(external).toMatchObject({
      pluginId: 'desktop_operator',
      displayName: 'Forge Desktop Operator',
      enabled: true,
      lifecycle: { state: 'degraded' },
      health: { ready: false, probed: true },
    });
    expect(assistantPluginScope('desktop_operator', fx.controllerHome)).toBe('controller');
  });

  test('get uses the same external adapter registration rather than a second manifest authority', () => {
    const fx = fixture();
    listAssistantPluginManifests(fx.controllerHome, fx.repository, { forceRefresh: true });
    const manifest = getAssistantPluginManifest(fx.controllerHome, fx.repository, 'desktop_operator');
    expect(manifest.authority.sourceOfTruth[0]).toContain('controllerHome:system/plugins/external/registrations/desktop_operator.json');
    expect(manifest.actions.map((action) => action.actionId)).toEqual(['desktop_status']);
  });

  test('execute reaches the registered external provider and preserves its structured error', async () => {
    const fx = await liveFixture();
    const manifests = listAssistantPluginManifests(fx.controllerHome, fx.repository, { forceRefresh: true });
    expect(manifests.find((manifest) => manifest.pluginId === 'desktop_operator')?.health.ready).toBe(true);
    await expect(executeAssistantPluginAction({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      repoRoot: fx.repository.canonicalRoot,
      pluginId: 'desktop_operator',
      actionId: 'desktop_status',
      requestId: 'external-store-request-1',
      args: {},
      origin: { surface: 'mcp' },
      timeoutMs: 1_000,
    })).rejects.toThrow('DESKTOP_TEST_FAILURE');
  });

  test('built-in adapters retain precedence over colliding external registration IDs in Phase 1', () => {
    const fx = fixture();
    installExternalPluginRegistration(fx.controllerHome, {
      pluginId: 'desktop', providerPluginId: 'desktop_operator', displayName: 'External Collision', provider: 'local-macos', pluginVersion: '0.1.0', protocolVersion: '1.0', scope: 'controller',
      transport: { kind: 'unix_socket_jsonl', socketPath: fx.socketPath, healthTimeoutMs: 100 },
      permissions: [], capabilities: [], actions: [],
    });
    const manifests = listAssistantPluginManifests(fx.controllerHome, fx.repository, { forceRefresh: true });
    const desktop = manifests.find((manifest) => manifest.pluginId === 'desktop');
    expect(desktop?.displayName).toBe('Forge Desktop');
    expect(manifests.filter((manifest) => manifest.pluginId === 'desktop')).toHaveLength(1);
  });
});
