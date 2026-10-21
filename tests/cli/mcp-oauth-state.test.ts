import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createMcpOAuthProvider, McpOAuthTokenStore } from '../../adapters/mcp/oauth';
import { mcpServiceOAuthTokenStorePath } from '../../adapters/mcp/auth';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function testClient(store: McpOAuthTokenStore, name: string) {
  return store.registerClient({
    redirect_uris: [`http://127.0.0.1/${name}`],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: name,
  });
}

async function issueCode(provider: ReturnType<typeof createMcpOAuthProvider>, client: ReturnType<typeof testClient>): Promise<string> {
  let location = '';
  await provider.authorize(client, {
    redirectUri: client.redirect_uris[0]!,
    codeChallenge: 'challenge',
    state: 'state',
    scopes: ['forge'],
  } as any, { redirect: (_status: number, value: string) => { location = value; } } as any);
  return new URL(location).searchParams.get('code') ?? '';
}

describe('MCP OAuth authorization-code lifecycle', () => {
  test('bounds pending codes, counts expiry/eviction, and keeps diagnostics aggregate-only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-oauth-state-')); roots.push(root);
    const store = new McpOAuthTokenStore(join(root, 'oauth.json'));
    let now = 1_000;
    const provider = createMcpOAuthProvider(store, {
      now: () => now,
      authorizationCodeTtlSeconds: 30,
      maxPendingAuthorizationCodes: 8,
      maxPendingAuthorizationCodesPerClient: 2,
    });
    const client = testClient(store, 'client-a');
    const first = await issueCode(provider, client);
    await issueCode(provider, client);
    await issueCode(provider, client);
    expect(provider.authorizationCodeDiagnostics()).toEqual({ pending: 2, expired: 0, evicted: 1 });
    await expect(provider.challengeForAuthorizationCode(client, first)).rejects.toThrow('Invalid authorization code');

    now += 31;
    const expired = provider.authorizationCodeDiagnostics();
    expect(expired).toEqual({ pending: 0, expired: 2, evicted: 1 });
    expect(Object.keys(expired).sort()).toEqual(['evicted', 'expired', 'pending']);
    expect(JSON.stringify(expired)).not.toContain('challenge');
  });

  test('authorization codes are one-time and global capacity remains bounded across clients', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-oauth-state-')); roots.push(root);
    const store = new McpOAuthTokenStore(join(root, 'oauth.json'));
    const provider = createMcpOAuthProvider(store, { maxPendingAuthorizationCodes: 8, maxPendingAuthorizationCodesPerClient: 2 });
    const client = testClient(store, 'exchange-client');
    const code = await issueCode(provider, client);
    await provider.exchangeAuthorizationCode(client, code);
    await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toThrow('Invalid authorization code');

    for (let index = 0; index < 9; index += 1) {
      const other = testClient(store, `client-${index}`);
      await issueCode(provider, other);
    }
    const diagnostics = provider.authorizationCodeDiagnostics();
    expect(diagnostics.pending).toBe(8);
    expect(diagnostics.evicted).toBeGreaterThanOrEqual(1);
  });
});

describe('MCP OAuth token store single-owner integrity', () => {
  test('corrupt canonical store fails closed with MCP_OAUTH_STORE_CORRUPT and is never silently rewritten', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-oauth-state-')); roots.push(root);
    const path = mcpServiceOAuthTokenStorePath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{not-json', { encoding: 'utf-8' });
    const store = new McpOAuthTokenStore(path);
    expect(() => store.load()).toThrow('MCP_OAUTH_STORE_CORRUPT');
    // A fail-closed load must not become a recovery writer: the corrupt bytes
    // stay untouched instead of being replaced by a fresh empty store.
    expect(readFileSync(path, 'utf-8')).toBe('{not-json');
  });

  test('token state persists and reloads through the one Controller Home file without a fallback source', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-oauth-state-')); roots.push(root);
    const path = mcpServiceOAuthTokenStorePath(root);
    const store = new McpOAuthTokenStore(path);
    store.setTokenPair(
      'access-1',
      { token: 'access-1', clientId: 'single-owner-client', scopes: ['forge'], expiresAt: 4_102_444_800 },
      'refresh-1',
    );
    const reloaded = new McpOAuthTokenStore(path);
    reloaded.load();
    expect(reloaded.getAccessToken('access-1')?.clientId).toBe('single-owner-client');
    expect(reloaded.getRefreshToken('refresh-1')).toBe('access-1');
    expect(reloaded.revokeToken('refresh-1')).toBeUndefined();
    const afterRevoke = new McpOAuthTokenStore(path);
    afterRevoke.load();
    expect(afterRevoke.getAccessToken('access-1')).toBeUndefined();
    expect(afterRevoke.getRefreshToken('refresh-1')).toBeUndefined();
  });
});
