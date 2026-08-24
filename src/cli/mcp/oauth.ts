import { randomUUID } from 'crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname } from 'path';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

interface TokenData {
  accessTokens?: Record<string, AuthInfo>;
  refreshTokens?: Record<string, string>;
  clients?: Record<string, OAuthClientInformationFull>;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function issueToken(): string {
  return randomUUID();
}

function fsyncFile(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function fsyncDirectory(path: string): void {
  try {
    const fd = openSync(path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch {
    // Directory fsync is unavailable on some supported platforms/filesystems.
  }
}

export class McpOAuthTokenStore implements OAuthRegisteredClientsStore {
  private accessTokens = new Map<string, AuthInfo>();
  private refreshTokens = new Map<string, string>();
  private clients = new Map<string, OAuthClientInformationFull>();

  constructor(private readonly path: string, private readonly fallbackPaths: string[] = []) {}

  load(): void {
    this.accessTokens.clear();
    this.refreshTokens.clear();
    this.clients.clear();
    let loaded = false;
    let mergedFallback = false;
    let primaryCorrupt = false;
    for (const [index, path] of [this.path, ...this.fallbackPaths].entries()) {
      if (!existsSync(path)) continue;
      try {
        const data = JSON.parse(readFileSync(path, 'utf-8')) as TokenData;
        const refreshTargets = new Set(Object.values(data.refreshTokens ?? {}));
        for (const [token, info] of Object.entries(data.accessTokens ?? {})) {
          if (!info.expiresAt || info.expiresAt > nowSeconds() || refreshTargets.has(token)) {
            if (index > 0 && !this.accessTokens.has(token)) mergedFallback = true;
            if (index > 0 && this.accessTokens.has(token)) continue;
            this.accessTokens.set(token, info);
          }
        }
        for (const [token, accessToken] of Object.entries(data.refreshTokens ?? {})) {
          if (index > 0 && !this.refreshTokens.has(token)) mergedFallback = true;
          if (index > 0 && this.refreshTokens.has(token)) continue;
          this.refreshTokens.set(token, accessToken);
        }
        for (const [clientId, client] of Object.entries(data.clients ?? {})) {
          if (index > 0 && !this.clients.has(clientId)) mergedFallback = true;
          if (index > 0 && this.clients.has(clientId)) continue;
          this.clients.set(clientId, client);
        }
        loaded = true;
      } catch (_error) {
        if (index === 0) primaryCorrupt = true;
      }
    }
    if (primaryCorrupt && !loaded) {
      throw new Error('MCP_OAUTH_STORE_CORRUPT: primary OAuth state is unreadable and no valid fallback is available');
    }
    if (loaded && (mergedFallback || primaryCorrupt)) this.flush();
  }

  flush(): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const data: TokenData = {
      accessTokens: Object.fromEntries(this.accessTokens),
      refreshTokens: Object.fromEntries(this.refreshTokens),
      clients: Object.fromEntries(this.clients),
    };
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
      chmodSync(temporary, 0o600);
      fsyncFile(temporary);
      renameSync(temporary, this.path);
      chmodSync(this.path, 0o600);
      fsyncDirectory(directory);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): OAuthClientInformationFull {
    const candidate = client as Partial<OAuthClientInformationFull>;
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: candidate.client_id ?? randomUUID(),
      client_id_issued_at: candidate.client_id_issued_at ?? nowSeconds(),
    };
    this.clients.set(full.client_id, full);
    this.flush();
    return full;
  }

  getAccessToken(token: string): AuthInfo | undefined {
    return this.accessTokens.get(token);
  }

  setAccessToken(token: string, info: AuthInfo): void {
    this.accessTokens.set(token, info);
    this.flush();
  }

  deleteAccessToken(token: string): void {
    this.accessTokens.delete(token);
    this.flush();
  }

  getRefreshToken(token: string): string | undefined {
    return this.refreshTokens.get(token);
  }

  setRefreshToken(token: string, accessToken: string): void {
    this.refreshTokens.set(token, accessToken);
    this.flush();
  }

  deleteRefreshToken(token: string): void {
    this.refreshTokens.delete(token);
    this.flush();
  }

  findRefreshTokenByAccessToken(accessToken: string): string | undefined {
    for (const [refreshToken, storedAccessToken] of this.refreshTokens) {
      if (storedAccessToken === accessToken) return refreshToken;
    }
    return undefined;
  }

  setTokenPair(accessToken: string, info: AuthInfo, refreshToken: string): void {
    this.accessTokens.set(accessToken, info);
    this.refreshTokens.set(refreshToken, accessToken);
    this.flush();
  }

  rotateRefreshToken(
    previousRefreshToken: string,
    nextRefreshToken: string,
    accessToken: string,
    info: AuthInfo,
  ): void {
    this.refreshTokens.delete(previousRefreshToken);
    this.accessTokens.set(accessToken, info);
    this.refreshTokens.set(nextRefreshToken, accessToken);
    this.flush();
  }

  revokeToken(token: string): void {
    const linkedAccessToken = this.refreshTokens.get(token);
    if (linkedAccessToken) {
      this.refreshTokens.delete(token);
      this.accessTokens.delete(linkedAccessToken);
      for (const [refreshToken, accessToken] of this.refreshTokens) {
        if (accessToken === linkedAccessToken) this.refreshTokens.delete(refreshToken);
      }
      this.flush();
      return;
    }

    this.accessTokens.delete(token);
    for (const [refreshToken, accessToken] of this.refreshTokens) {
      if (accessToken === token) this.refreshTokens.delete(refreshToken);
    }
    this.flush();
  }
}

interface PendingAuthorizationCode {
  challenge: string;
  clientId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface McpOAuthProviderOptions {
  now?: () => number;
  authorizationCodeTtlSeconds?: number;
  maxPendingAuthorizationCodes?: number;
  maxPendingAuthorizationCodesPerClient?: number;
}

const DEFAULT_AUTHORIZATION_CODE_TTL_SECONDS = 10 * 60;
const DEFAULT_MAX_PENDING_AUTHORIZATION_CODES = 512;
const DEFAULT_MAX_PENDING_AUTHORIZATION_CODES_PER_CLIENT = 32;

export function createMcpOAuthProvider(
  store: McpOAuthTokenStore,
  options: McpOAuthProviderOptions = {},
): OAuthServerProvider {
  const authCodes = new Map<string, PendingAuthorizationCode>();
  const currentTime = options.now ?? nowSeconds;
  const ttlSeconds = Math.max(30, Math.trunc(options.authorizationCodeTtlSeconds ?? DEFAULT_AUTHORIZATION_CODE_TTL_SECONDS));
  const globalLimit = Math.max(8, Math.trunc(options.maxPendingAuthorizationCodes ?? DEFAULT_MAX_PENDING_AUTHORIZATION_CODES));
  const clientLimit = Math.max(2, Math.min(globalLimit, Math.trunc(
    options.maxPendingAuthorizationCodesPerClient ?? DEFAULT_MAX_PENDING_AUTHORIZATION_CODES_PER_CLIENT,
  )));

  const purgeExpiredCodes = (now = currentTime()): void => {
    for (const [code, pending] of authCodes) {
      if (pending.expiresAt <= now) authCodes.delete(code);
    }
  };

  const evictOldest = (predicate: (entry: PendingAuthorizationCode) => boolean): boolean => {
    let oldest: { code: string; issuedAt: number } | undefined;
    for (const [code, pending] of authCodes) {
      if (!predicate(pending)) continue;
      if (!oldest || pending.issuedAt < oldest.issuedAt) oldest = { code, issuedAt: pending.issuedAt };
    }
    if (!oldest) return false;
    authCodes.delete(oldest.code);
    return true;
  };

  const reserveAuthorizationCodeCapacity = (clientId: string, now: number): void => {
    purgeExpiredCodes(now);
    while ([...authCodes.values()].filter((pending) => pending.clientId === clientId).length >= clientLimit) {
      if (!evictOldest((pending) => pending.clientId === clientId)) break;
    }
    while (authCodes.size >= globalLimit) {
      if (!evictOldest(() => true)) break;
    }
  };

  const pendingAuthorizationCode = (
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): PendingAuthorizationCode => {
    const now = currentTime();
    purgeExpiredCodes(now);
    const stored = authCodes.get(authorizationCode);
    if (!stored || stored.clientId !== client.client_id || stored.expiresAt <= now) {
      if (stored?.expiresAt !== undefined && stored.expiresAt <= now) authCodes.delete(authorizationCode);
      throw new InvalidGrantError('Invalid authorization code');
    }
    return stored;
  };

  return {
    get clientsStore(): OAuthRegisteredClientsStore {
      return store;
    },

    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res): Promise<void> {
      const now = currentTime();
      reserveAuthorizationCodeCapacity(client.client_id, now);
      const code = issueToken();
      authCodes.set(code, {
        challenge: params.codeChallenge,
        clientId: client.client_id,
        issuedAt: now,
        expiresAt: now + ttlSeconds,
      });
      const redirectUrl = new URL(params.redirectUri);
      redirectUrl.searchParams.set('code', code);
      if (params.state) redirectUrl.searchParams.set('state', params.state);
      res.redirect(302, redirectUrl.toString());
    },

    async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
      return pendingAuthorizationCode(client, authorizationCode).challenge;
    },

    async exchangeAuthorizationCode(
      client: OAuthClientInformationFull,
      authorizationCode: string,
      _codeVerifier?: string,
    ): Promise<OAuthTokens> {
      pendingAuthorizationCode(client, authorizationCode);
      // Delete before issuing credentials. A failed downstream persistence is
      // retried as a new OAuth flow rather than making an authorization code
      // replayable after a partial token response.
      authCodes.delete(authorizationCode);
      const accessToken = issueToken();
      const refreshToken = issueToken();
      const expiresIn = 30 * 24 * 60 * 60;
      const expiresAt = nowSeconds() + expiresIn;
      store.setTokenPair(accessToken, {
        token: accessToken,
        clientId: client.client_id,
        scopes: ['forge'],
        expiresAt,
      }, refreshToken);
      return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
        refresh_token: refreshToken,
        scope: 'forge',
      };
    },

    async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
      const accessToken = store.getRefreshToken(refreshToken);
      const existing = accessToken ? store.getAccessToken(accessToken) : undefined;
      if (!accessToken || !existing || existing.clientId !== client.client_id) {
        throw new InvalidGrantError('Invalid refresh token');
      }
      const nextRefreshToken = issueToken();
      const expiresIn = 30 * 24 * 60 * 60;
      store.rotateRefreshToken(
        refreshToken,
        nextRefreshToken,
        accessToken,
        { ...existing, expiresAt: nowSeconds() + expiresIn },
      );
      return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
        refresh_token: nextRefreshToken,
        scope: existing.scopes.join(' '),
      };
    },

    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const info = store.getAccessToken(token);
      if (!info) throw new InvalidTokenError('Token not found');
      if (info.expiresAt && info.expiresAt < nowSeconds()) {
        if (!store.findRefreshTokenByAccessToken(token)) {
          store.deleteAccessToken(token);
        }
        throw new InvalidTokenError('Token has expired');
      }
      return info;
    },

    async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
      store.revokeToken(request.token);
    },
  };
}
