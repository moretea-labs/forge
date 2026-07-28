import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  controllerHomeHasAuthoritativeMcpState,
  loadMcpServiceRuntimeState,
  mcpServiceOAuthTokenStoreFallbackPaths,
  mcpServiceOAuthTokenStorePath,
  readMcpServiceOAuthPassphrase,
  resolveMcpRuntimeAuthority,
} from '../../src/cli/mcp/auth';
import { McpOAuthTokenStore } from '../../src/cli/mcp/oauth';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeOAuthTokenStore(
  path: string,
  entries: Array<{ token: string; clientId: string; expiresAt?: number }>,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    accessTokens: Object.fromEntries(entries.map((entry) => [entry.token, {
      token: entry.token,
      clientId: entry.clientId,
      scopes: ['repo-harness'],
      expiresAt: entry.expiresAt ?? Math.floor(Date.now() / 1000) + 60_000,
    }])),
    refreshTokens: {},
    clients: Object.fromEntries(entries.map((entry) => [entry.clientId, {
      client_id: entry.clientId,
      client_id_issued_at: 1,
      redirect_uris: ['https://chatgpt.com/connector/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }])),
  }, null, 2)}\n`);
}

describe('controller-home MCP authority', () => {
  test('controller-home authority suppresses legacy runtime fallback once any live MCP state exists', () => {
    const repoRoot = tempRoot('repo-harness-mcp-authority-repo-');
    const controllerHome = tempRoot('repo-harness-mcp-authority-home-');
    mkdirSync(join(repoRoot, '.repo-harness'), { recursive: true });
    mkdirSync(join(controllerHome, 'mcp'), { recursive: true });

    writeFileSync(join(repoRoot, '.repo-harness', 'mcp.runtime.json'), JSON.stringify({
      version: 1,
      repo: repoRoot,
      startedAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
      status: 'running',
      tunnelMode: 'none',
      server: { endpoint: 'http://127.0.0.1:8765/mcp', running: true, healthy: true, restartCount: 0 },
    }, null, 2));
    writeFileSync(join(controllerHome, 'mcp', 'mcp.tokens.json'), JSON.stringify({ bearerToken: 'controller-home-token' }));

    expect(controllerHomeHasAuthoritativeMcpState(controllerHome)).toBe(true);
    expect(loadMcpServiceRuntimeState(controllerHome, repoRoot)).toBeNull();

    const authority = resolveMcpRuntimeAuthority(controllerHome, repoRoot, 'runtime-state');
    expect(authority.authority).toBe('controller-home');
    expect(authority.warning).toContain('Controller Home is authoritative');
  });

  test('slot OAuth token store resolves through stable root and absorbs slot snapshots', () => {
    const repoRoot = tempRoot('repo-harness-mcp-authority-repo-');
    const controllerHome = tempRoot('repo-harness-mcp-authority-home-');
    const blueHome = join(controllerHome, 'runtime-slots', 'blue');
    const greenHome = join(controllerHome, 'runtime-slots', 'green');
    const rootStore = join(controllerHome, 'mcp', 'mcp.oauth-tokens.json');
    const blueStore = join(blueHome, 'mcp', 'mcp.oauth-tokens.json');
    const greenStore = join(greenHome, 'mcp', 'mcp.oauth-tokens.json');
    const legacyStore = join(repoRoot, '.repo-harness', 'mcp.oauth-tokens.json');

    writeOAuthTokenStore(rootStore, [{ token: 'root-token', clientId: 'root-client' }]);
    writeOAuthTokenStore(blueStore, [{ token: 'blue-token', clientId: 'chatgpt-client' }]);
    writeOAuthTokenStore(greenStore, [{ token: 'green-token', clientId: 'chatgpt-client' }]);
    writeOAuthTokenStore(legacyStore, [{ token: 'legacy-token', clientId: 'legacy-client' }]);

    expect(mcpServiceOAuthTokenStorePath(blueHome)).toBe(rootStore);
    expect(mcpServiceOAuthTokenStoreFallbackPaths(blueHome, repoRoot)).toEqual([
      blueStore,
      greenStore,
      legacyStore,
    ]);

    const store = new McpOAuthTokenStore(
      mcpServiceOAuthTokenStorePath(blueHome),
      mcpServiceOAuthTokenStoreFallbackPaths(blueHome, repoRoot),
    );
    store.load();

    expect(store.getAccessToken('root-token')?.clientId).toBe('root-client');
    expect(store.getAccessToken('blue-token')?.clientId).toBe('chatgpt-client');
    expect(store.getAccessToken('green-token')?.clientId).toBe('chatgpt-client');
    expect(store.getAccessToken('legacy-token')?.clientId).toBe('legacy-client');

    const persisted = JSON.parse(readFileSync(rootStore, 'utf8')) as { accessTokens: Record<string, unknown> };
    expect(Object.keys(persisted.accessTokens).sort()).toEqual([
      'blue-token',
      'green-token',
      'legacy-token',
      'root-token',
    ]);
  });

  test('slot OAuth passphrase prefers the stable root over slot and legacy state', () => {
    const repoRoot = tempRoot('repo-harness-mcp-authority-repo-');
    const controllerHome = tempRoot('repo-harness-mcp-authority-home-');
    const blueHome = join(controllerHome, 'runtime-slots', 'blue');
    mkdirSync(join(controllerHome, 'mcp'), { recursive: true });
    mkdirSync(join(blueHome, 'mcp'), { recursive: true });
    mkdirSync(join(repoRoot, '.repo-harness'), { recursive: true });

    writeFileSync(join(controllerHome, 'mcp', 'mcp.oauth.json'), JSON.stringify({ passphrase: 'root-passphrase' }));
    writeFileSync(join(blueHome, 'mcp', 'mcp.oauth.json'), JSON.stringify({ passphrase: 'slot-passphrase' }));
    writeFileSync(join(repoRoot, '.repo-harness', 'mcp.oauth.json'), JSON.stringify({ passphrase: 'legacy-passphrase' }));

    expect(readMcpServiceOAuthPassphrase(blueHome, repoRoot)).toBe('root-passphrase');
  });
});
