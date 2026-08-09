import { execFileSync } from 'child_process';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

const API_BASE_URL = 'https://api.resend.com';
const USER_AGENT = 'Forge-Resend-Plugin/1.0.0';
const REQUEST_TTL_MS = 10 * 60_000;
const RETAIN_CONSUMED_REQUEST_MS = 24 * 60 * 60_000;
const OAUTH_KEYCHAIN_SERVICE = 'forge.resend-oauth';
const OAUTH_KEYCHAIN_ACCOUNT = 'credential';
const SMTP_KEYCHAIN_SERVICE = 'forge.resend-smtp';
const SMTP_KEYCHAIN_ACCOUNT = 'sending-api-key';

export interface StoredResendOAuthCredential {
  clientId: string;
  refreshToken: string;
  scope: string;
}

interface StoredResendSmtpCredential {
  token: string;
  apiKeyId?: string;
}

export interface ResendCredentialStoreAdapter {
  available(): boolean;
  read(service: string, account: string): string | undefined;
  write(service: string, account: string, value: string): void;
}

interface ResendOAuthRequestRecord {
  schemaVersion: 1;
  requestId: string;
  stateHash: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeVerifier: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

interface AccessTokenCache {
  value: string;
  expiresAt: number;
  source: string;
}

const macKeychainAdapter: ResendCredentialStoreAdapter = {
  available: () => process.platform === 'darwin',
  read(service, account) {
    if (process.platform !== 'darwin') return undefined;
    try {
      const value = execFileSync('/usr/bin/security', [
        'find-generic-password', '-s', service, '-a', account, '-w',
      ], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000,
      }).trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  },
  write(service, account, value) {
    if (process.platform !== 'darwin') throw new Error('RESEND_CREDENTIAL_STORE_UNAVAILABLE');
    execFileSync('/usr/bin/security', [
      'add-generic-password', '-U', '-s', service, '-a', account, '-w', value,
    ], {
      encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 5_000,
    });
  },
};

let credentialStore: ResendCredentialStoreAdapter = macKeychainAdapter;
let accessTokenCache: AccessTokenCache | undefined;

function base64Url(value: Buffer): string {
  return value.toString('base64url');
}

function oauthRoot(controllerHome: string): string {
  return join(controllerHome, 'auth', 'resend-oauth');
}

function requestPath(controllerHome: string, state: string): string {
  return join(oauthRoot(controllerHome), 'requests', `${createHash('sha256').update(state).digest('hex')}.json`);
}

function writeRecord(path: string, value: ResendOAuthRequestRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function pruneRequests(controllerHome: string): void {
  const root = join(oauthRoot(controllerHome), 'requests');
  try {
    for (const name of readdirSync(root).filter((entry) => entry.endsWith('.json')).slice(0, 2_000)) {
      const path = join(root, name);
      try {
        const record = JSON.parse(readFileSync(path, 'utf8')) as Partial<ResendOAuthRequestRecord>;
        const expired = Date.parse(String(record.expiresAt ?? '')) <= Date.now();
        const consumedOld = Boolean(record.consumedAt) && Date.now() - Date.parse(String(record.consumedAt)) > RETAIN_CONSUMED_REQUEST_MS;
        if (expired || consumedOld) unlinkSync(path);
      } catch {
        unlinkSync(path);
      }
    }
  } catch {
    // Request storage is created lazily.
  }
}

function readRequest(controllerHome: string, state: string): { path: string; record: ResendOAuthRequestRecord } {
  const path = requestPath(controllerHome, state);
  if (!existsSync(path)) throw new Error('RESEND_OAUTH_STATE_INVALID: login state was not found');
  let record: ResendOAuthRequestRecord;
  try {
    record = JSON.parse(readFileSync(path, 'utf8')) as ResendOAuthRequestRecord;
  } catch {
    throw new Error('RESEND_OAUTH_STATE_INVALID: login state is unreadable');
  }
  if (record.stateHash !== createHash('sha256').update(state).digest('hex')) throw new Error('RESEND_OAUTH_STATE_INVALID: state hash mismatch');
  if (record.consumedAt) throw new Error('RESEND_OAUTH_STATE_REPLAYED: login state was already consumed');
  if (Date.parse(record.expiresAt) <= Date.now()) throw new Error('RESEND_OAUTH_STATE_EXPIRED: start a new login');
  return { path, record };
}

function validateRedirectUri(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('RESEND_OAUTH_REDIRECT_INVALID: redirect URI must be a URL'); }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new Error('RESEND_OAUTH_REDIRECT_NOT_LOCAL: redirect URI must use loopback HTTP');
  }
  if (parsed.pathname !== '/oauth/resend/callback' || parsed.username || parsed.password || parsed.hash) {
    throw new Error('RESEND_OAUTH_REDIRECT_INVALID: use the local /oauth/resend/callback endpoint');
  }
  return parsed.toString();
}

function parseStoredOAuthCredential(value: string | undefined): StoredResendOAuthCredential | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<StoredResendOAuthCredential>;
    const clientId = typeof parsed.clientId === 'string' ? parsed.clientId.trim() : '';
    const refreshToken = typeof parsed.refreshToken === 'string' ? parsed.refreshToken.trim() : '';
    const scope = typeof parsed.scope === 'string' ? parsed.scope.trim() : '';
    return clientId && refreshToken ? { clientId, refreshToken, scope: scope || 'full_access' } : undefined;
  } catch {
    return undefined;
  }
}

function parseStoredSmtpCredential(value: string | undefined): StoredResendSmtpCredential | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<StoredResendSmtpCredential>;
    const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
    return token ? { token, apiKeyId: typeof parsed.apiKeyId === 'string' ? parsed.apiKeyId : undefined } : undefined;
  } catch {
    return undefined;
  }
}

function writeOAuthCredential(value: StoredResendOAuthCredential): void {
  if (!credentialStore.available()) throw new Error('RESEND_CREDENTIAL_STORE_UNAVAILABLE');
  credentialStore.write(OAUTH_KEYCHAIN_SERVICE, OAUTH_KEYCHAIN_ACCOUNT, JSON.stringify(value));
}

export function setResendCredentialStoreAdapterForTest(adapter?: ResendCredentialStoreAdapter): void {
  credentialStore = adapter ?? macKeychainAdapter;
  accessTokenCache = undefined;
}

export function resetResendOAuthRuntimeForTest(): void {
  credentialStore = macKeychainAdapter;
  accessTokenCache = undefined;
}

export function resendCredentialStoreStatus(): Record<string, unknown> {
  const oauthStored = Boolean(parseStoredOAuthCredential(credentialStore.available() ? credentialStore.read(OAUTH_KEYCHAIN_SERVICE, OAUTH_KEYCHAIN_ACCOUNT) : undefined));
  const smtpStored = Boolean(parseStoredSmtpCredential(credentialStore.available() ? credentialStore.read(SMTP_KEYCHAIN_SERVICE, SMTP_KEYCHAIN_ACCOUNT) : undefined));
  return {
    backend: process.platform === 'darwin' ? 'macos-keychain' : 'unavailable',
    available: credentialStore.available(),
    oauthStored,
    smtpStored,
    repositoryPersistence: false,
    controllerStatePersistence: false,
  };
}

export function readStoredResendOAuthCredential(): StoredResendOAuthCredential | undefined {
  if (!credentialStore.available()) return undefined;
  return parseStoredOAuthCredential(credentialStore.read(OAUTH_KEYCHAIN_SERVICE, OAUTH_KEYCHAIN_ACCOUNT));
}

export function readStoredResendSmtpToken(): { token: string; apiKeyId?: string } | undefined {
  if (!credentialStore.available()) return undefined;
  return parseStoredSmtpCredential(credentialStore.read(SMTP_KEYCHAIN_SERVICE, SMTP_KEYCHAIN_ACCOUNT));
}

export function writeStoredResendSmtpToken(token: string, apiKeyId?: string): void {
  const normalized = token.trim();
  if (!normalized) throw new Error('RESEND_SMTP_TOKEN_REQUIRED');
  if (!credentialStore.available()) throw new Error('RESEND_CREDENTIAL_STORE_UNAVAILABLE');
  credentialStore.write(SMTP_KEYCHAIN_SERVICE, SMTP_KEYCHAIN_ACCOUNT, JSON.stringify({ token: normalized, apiKeyId }));
}

async function oauthJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      'User-Agent': USER_AGENT,
      ...(init.headers ?? {}),
    },
  });
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { parsed = {}; }
  if (!response.ok) {
    const providerError = typeof parsed.error_description === 'string' ? parsed.error_description : typeof parsed.error === 'string' ? parsed.error : `HTTP ${response.status}`;
    throw new Error(`RESEND_OAUTH_PROVIDER_ERROR: ${providerError}`);
  }
  return parsed;
}

function installAccessToken(token: string, expiresIn: number, source: string): void {
  accessTokenCache = {
    value: token,
    expiresAt: Date.now() + Math.max(60, expiresIn) * 1_000,
    source,
  };
}

export async function prepareResendOAuthLogin(
  controllerHome: string,
  input: { redirectUri?: string; scope?: 'emails:send' | 'full_access' } = {},
): Promise<Record<string, unknown>> {
  pruneRequests(controllerHome);
  const redirectUri = validateRedirectUri(input.redirectUri ?? 'http://127.0.0.1:8766/oauth/resend/callback');
  const scope = input.scope ?? 'full_access';
  const registration = await oauthJson(`${API_BASE_URL}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Forge Resend Email Plugin',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope,
    }),
  });
  const clientId = typeof registration.client_id === 'string' ? registration.client_id.trim() : '';
  if (!clientId) throw new Error('RESEND_OAUTH_REGISTRATION_INVALID: client_id missing');

  const state = base64Url(randomBytes(32));
  const codeVerifier = base64Url(randomBytes(64));
  const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + REQUEST_TTL_MS);
  const record: ResendOAuthRequestRecord = {
    schemaVersion: 1,
    requestId: `RSOAUTH-${Date.now()}-${randomUUID().slice(0, 8)}`,
    stateHash: createHash('sha256').update(state).digest('hex'),
    clientId,
    redirectUri,
    scope,
    codeVerifier,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  writeRecord(requestPath(controllerHome, state), record);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return {
    schemaVersion: 1,
    provider: 'resend',
    requestId: record.requestId,
    readyToOpenBrowser: true,
    authorizationUrl: `${API_BASE_URL}/oauth/authorize?${params.toString()}`,
    redirectUri,
    scope,
    expiresAt: record.expiresAt,
    pkce: true,
    dynamicClientRegistration: true,
    credentialStore: resendCredentialStoreStatus(),
    safety: {
      credentialMaterialReturned: false,
      credentialMaterialPersistedInRepository: false,
      opensBrowserAutomatically: false,
    },
  };
}

export async function completeResendOAuthLogin(
  controllerHome: string,
  input: { state?: string; code?: string; error?: string; errorDescription?: string },
): Promise<Record<string, unknown>> {
  const state = input.state?.trim();
  if (!state) throw new Error('RESEND_OAUTH_STATE_REQUIRED');
  const selected = readRequest(controllerHome, state);
  const codeVerifier = selected.record.codeVerifier;
  selected.record.codeVerifier = '';
  selected.record.consumedAt = new Date().toISOString();
  writeRecord(selected.path, selected.record);
  if (input.error) throw new Error(`RESEND_OAUTH_DENIED: ${input.errorDescription || input.error}`);
  const code = input.code?.trim();
  if (!code) throw new Error('RESEND_OAUTH_CODE_REQUIRED');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: selected.record.clientId,
    code,
    redirect_uri: selected.record.redirectUri,
    code_verifier: codeVerifier,
  });
  const parsed = await oauthJson(`${API_BASE_URL}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  const accessToken = typeof parsed.access_token === 'string' ? parsed.access_token.trim() : '';
  const refreshToken = typeof parsed.refresh_token === 'string' ? parsed.refresh_token.trim() : '';
  const scope = typeof parsed.scope === 'string' ? parsed.scope.trim() : selected.record.scope;
  if (!accessToken || !refreshToken) throw new Error('RESEND_OAUTH_EXCHANGE_INVALID: provider did not return both tokens');
  writeOAuthCredential({ clientId: selected.record.clientId, refreshToken, scope });
  const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : 900;
  installAccessToken(accessToken, expiresIn, 'oauth:authorization_code');
  return {
    schemaVersion: 1,
    provider: 'resend',
    requestId: selected.record.requestId,
    authenticated: true,
    scope,
    refreshCredentialStored: true,
    accessTokenExpiresAt: new Date(Date.now() + Math.max(60, expiresIn) * 1_000).toISOString(),
    credentialStore: resendCredentialStoreStatus(),
    safety: {
      credentialMaterialReturned: false,
      credentialMaterialPersistedInRepository: false,
      stateConsumed: true,
    },
  };
}

export async function getResendOAuthAccessToken(timeoutMs = 30_000): Promise<{ token: string; source: string } | undefined> {
  if (accessTokenCache && accessTokenCache.expiresAt - Date.now() > 30_000) {
    return { token: accessTokenCache.value, source: accessTokenCache.source };
  }
  const stored = readStoredResendOAuthCredential();
  if (!stored) return undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: stored.clientId,
      refresh_token: stored.refreshToken,
    });
    const parsed = await oauthJson(`${API_BASE_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });
    const accessToken = typeof parsed.access_token === 'string' ? parsed.access_token.trim() : '';
    const refreshToken = typeof parsed.refresh_token === 'string' ? parsed.refresh_token.trim() : '';
    const scope = typeof parsed.scope === 'string' ? parsed.scope.trim() : stored.scope;
    if (!accessToken || !refreshToken) throw new Error('RESEND_OAUTH_REFRESH_INVALID: provider did not rotate both tokens');
    writeOAuthCredential({ clientId: stored.clientId, refreshToken, scope });
    const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : 900;
    installAccessToken(accessToken, expiresIn, 'oauth:refresh_token');
    return { token: accessToken, source: 'oauth:keychain-refresh' };
  } finally {
    clearTimeout(timeout);
  }
}
