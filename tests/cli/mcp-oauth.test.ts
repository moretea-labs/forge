import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { McpOAuthTokenStore, createMcpOAuthProvider } from '../../src/cli/mcp/oauth';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'forge-mcp-oauth-'));
  return {
    root,
    primary: join(root, 'mcp.oauth-tokens.json'),
    fallback: join(root, 'mcp.oauth-tokens.fallback.json'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function authInfo(token: string): AuthInfo {
  return {
    token,
    clientId: 'client-test',
    scopes: ['forge'],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function oauthClient(clientId = 'client-test'): OAuthClientInformationFull {
  return {
    client_id: clientId,
    client_id_issued_at: 1,
    client_name: clientId,
    redirect_uris: ['http://127.0.0.1/callback'],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  } as OAuthClientInformationFull;
}

async function issueAuthorizationCode(
  provider: ReturnType<typeof createMcpOAuthProvider>,
  client = oauthClient(),
): Promise<string> {
  let redirected = '';
  await provider.authorize(client, {
    redirectUri: 'http://127.0.0.1/callback',
    codeChallenge: 'challenge-test',
    state: 'state-test',
  } as never, {
    redirect: (_status: number, value: string) => { redirected = value; },
  } as never);
  const code = new URL(redirected).searchParams.get('code');
  if (!code) throw new Error('authorization code missing from redirect');
  return code;
}

describe('MCP OAuth durable state', () => {
  test('persists token pairs as one atomic snapshot with restrictive permissions', () => {
    const fx = fixture();
    try {
      const store = new McpOAuthTokenStore(fx.primary);
      store.setTokenPair('access-a', authInfo('access-a'), 'refresh-a');

      const persisted = JSON.parse(readFileSync(fx.primary, 'utf8'));
      expect(persisted.accessTokens['access-a'].clientId).toBe('client-test');
      expect(persisted.refreshTokens['refresh-a']).toBe('access-a');
      expect(readdirSync(fx.root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      if (process.platform !== 'win32') {
        expect(statSync(fx.primary).mode & 0o777).toBe(0o600);
        expect(statSync(fx.root).mode & 0o777).toBe(0o700);
      }
    } finally {
      fx.cleanup();
    }
  });

  test('repairs a corrupt primary from a valid fallback instead of starting with empty auth state', () => {
    const fx = fixture();
    try {
      writeFileSync(fx.primary, '{"accessTokens":', 'utf8');
      writeFileSync(fx.fallback, JSON.stringify({
        accessTokens: { 'access-fallback': authInfo('access-fallback') },
        refreshTokens: { 'refresh-fallback': 'access-fallback' },
        clients: {},
      }), 'utf8');

      const store = new McpOAuthTokenStore(fx.primary, [fx.fallback]);
      store.load();

      expect(store.getAccessToken('access-fallback')?.clientId).toBe('client-test');
      expect(store.getRefreshToken('refresh-fallback')).toBe('access-fallback');
      expect(() => JSON.parse(readFileSync(fx.primary, 'utf8'))).not.toThrow();
    } finally {
      fx.cleanup();
    }
  });

  test('fails closed when the primary OAuth store is corrupt and no valid fallback exists', () => {
    const fx = fixture();
    try {
      writeFileSync(fx.primary, '{"accessTokens":', 'utf8');
      const store = new McpOAuthTokenStore(fx.primary);
      expect(() => store.load()).toThrow('MCP_OAUTH_STORE_CORRUPT');
    } finally {
      fx.cleanup();
    }
  });

  test('revoking a refresh token removes both refresh and linked access credentials durably', async () => {
    const fx = fixture();
    try {
      const store = new McpOAuthTokenStore(fx.primary);
      store.setTokenPair('access-a', authInfo('access-a'), 'refresh-a');
      const provider = createMcpOAuthProvider(store);

      await provider.revokeToken?.({ client_id: 'client-test' } as never, { token: 'refresh-a' } as never);

      expect(store.getRefreshToken('refresh-a')).toBeUndefined();
      expect(store.getAccessToken('access-a')).toBeUndefined();
      const reloaded = new McpOAuthTokenStore(fx.primary);
      reloaded.load();
      expect(reloaded.getRefreshToken('refresh-a')).toBeUndefined();
      expect(reloaded.getAccessToken('access-a')).toBeUndefined();
      expect(existsSync(fx.primary)).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  test('authorization codes expire and remain bound to the issuing client', async () => {
    const fx = fixture();
    let now = 1_000;
    try {
      const provider = createMcpOAuthProvider(new McpOAuthTokenStore(fx.primary), {
        now: () => now,
        authorizationCodeTtlSeconds: 30,
      });
      const client = oauthClient('client-a');
      const code = await issueAuthorizationCode(provider, client);
      expect(await provider.challengeForAuthorizationCode(client, code)).toBe('challenge-test');
      await expect(provider.challengeForAuthorizationCode(oauthClient('client-b'), code)).rejects.toThrow('Invalid authorization code');

      now = 1_031;
      await expect(provider.challengeForAuthorizationCode(client, code)).rejects.toThrow('Invalid authorization code');
    } finally {
      fx.cleanup();
    }
  });

  test('pending authorization codes are bounded per client and oldest abandoned codes are evicted', async () => {
    const fx = fixture();
    let now = 2_000;
    try {
      const provider = createMcpOAuthProvider(new McpOAuthTokenStore(fx.primary), {
        now: () => now,
        maxPendingAuthorizationCodesPerClient: 2,
        maxPendingAuthorizationCodes: 8,
      });
      const client = oauthClient('client-a');
      const first = await issueAuthorizationCode(provider, client);
      now += 1;
      const second = await issueAuthorizationCode(provider, client);
      now += 1;
      const third = await issueAuthorizationCode(provider, client);

      await expect(provider.challengeForAuthorizationCode(client, first)).rejects.toThrow('Invalid authorization code');
      expect(await provider.challengeForAuthorizationCode(client, second)).toBe('challenge-test');
      expect(await provider.challengeForAuthorizationCode(client, third)).toBe('challenge-test');
    } finally {
      fx.cleanup();
    }
  });
});
