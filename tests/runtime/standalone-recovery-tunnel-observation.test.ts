import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  observeOpenAiTunnelLocalHealthFallback,
  observeOpenAiTunnelRuntime,
} from '../../src/runtime/standalone-recovery/probe-observation';

const homes: string[] = [];
afterEach(() => { while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true }); });

function tunnelFixture() {
  const home = mkdtempSync(join(tmpdir(), 'forge-tunnel-observation-'));
  homes.push(home);
  const profileDir = join(home, 'profiles');
  mkdirSync(profileDir, { recursive: true });
  const healthUrlFile = join(home, 'health.url');
  const tunnelId = 'tunnel_abcdef0123456789abcdef0123456789';
  const endpoint = 'http://127.0.0.1:45613/mcp';
  writeFileSync(healthUrlFile, 'http://127.0.0.1:45613\n');
  writeFileSync(join(profileDir, 'forge-current.yaml'), JSON.stringify({
    control_plane: { tunnel_id: tunnelId },
    health: { url_file: healthUrlFile },
    mcp: { server_urls: [{ url: endpoint }] },
  }));
  return {
    configured: {
      platform: 'openai-secure-tunnel' as const,
      alias: 'forge-current',
      tunnelId,
      mcpServerUrl: endpoint,
      profile: 'forge-current',
      profileDir,
    },
    healthUrlFile,
  };
}

function healthPayload(pollAtSeconds: number) {
  return JSON.stringify({
    healthz: { ok: true, status: 200 },
    readyz: { ok: true, status: 200 },
    control_plane_poll: { ok: true, value: pollAtSeconds },
    result: 'ok',
  });
}

test('Recovery accepts a fresh tunnel-client control-plane poll when runtimes status lookup times out', async () => {
  const { configured, healthUrlFile } = tunnelFixture();
  const calls: string[][] = [];
  const result = await observeOpenAiTunnelRuntime(configured, async (_name, args) => {
    calls.push(args);
    if (args[0] === 'runtimes') return { ok: false, status: null, stdout: '', stderr: 'status lookup timed out' };
    if (args[0] === 'health') return {
      ok: true,
      status: 0,
      stdout: healthPayload(Math.floor(Date.now() / 1_000)),
      stderr: '',
    };
    throw new Error('UNEXPECTED_TUNNEL_COMMAND');
  });
  expect(result).toMatchObject({
    ok: true,
    running: true,
    healthy: true,
    ready: true,
    tunnelMatches: true,
    endpointMatches: true,
    controlPlaneState: 'ready',
    observedTunnelId: configured.tunnelId,
  });
  expect(calls).toEqual([
    ['runtimes', 'status', 'forge-current', '--json'],
    ['health', '--json', '--url-file', healthUrlFile, '--require-control-plane-poll'],
  ]);
});

test('Recovery does not treat an old successful control-plane poll as healthy transport', async () => {
  const { configured } = tunnelFixture();
  const now = Date.now();
  const result = await observeOpenAiTunnelLocalHealthFallback(configured, {
    now: () => now,
    runCommand: async () => ({
      ok: true,
      status: 0,
      stdout: healthPayload(Math.floor(now / 1_000) - 240),
      stderr: '',
    }),
  });
  expect(result).toMatchObject({
    ok: false,
    running: true,
    healthy: true,
    ready: true,
    tunnelMatches: true,
    endpointMatches: true,
    controlPlaneState: 'degraded',
  });
  expect(result?.controlPlaneDetail).toContain('stale');
});
