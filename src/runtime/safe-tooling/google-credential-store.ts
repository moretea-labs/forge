import { execFileSync } from 'child_process';

export type StoredGoogleService = 'gmail' | 'calendar' | 'tasks' | 'google-workspace';
export type StoredGoogleCredentialKind = 'refresh-token' | 'client-secret';

export interface GoogleCredentialStoreAdapter {
  available(): boolean;
  read(service: StoredGoogleService, kind?: StoredGoogleCredentialKind): string | undefined;
  write(service: StoredGoogleService, value: string, kind?: StoredGoogleCredentialKind): void;
}

const KEYCHAIN_SERVICE_PREFIX = 'forge.google-oauth';
const KEYCHAIN_ACCOUNT: Record<StoredGoogleCredentialKind, string> = {
  'refresh-token': 'refresh-token',
  'client-secret': 'client-secret',
};
const memoryCache = new Map<string, string>();

function keychainService(service: StoredGoogleService): string {
  return `${KEYCHAIN_SERVICE_PREFIX}.${service}`;
}

function cacheKey(service: StoredGoogleService, kind: StoredGoogleCredentialKind): string {
  return `${service}:${kind}`;
}

const macKeychainAdapter: GoogleCredentialStoreAdapter = {
  available: () => process.platform === 'darwin',
  read(service, kind = 'refresh-token') {
    if (process.platform !== 'darwin') return undefined;
    try {
      const value = execFileSync('/usr/bin/security', [
        'find-generic-password',
        '-s', keychainService(service),
        '-a', KEYCHAIN_ACCOUNT[kind],
        '-w',
      ], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
      }).trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  },
  write(service, value, kind = 'refresh-token') {
    if (process.platform !== 'darwin') {
      throw new Error('GOOGLE_CREDENTIAL_STORE_UNAVAILABLE: macOS Keychain is required for local OAuth credential persistence');
    }
    execFileSync('/usr/bin/security', [
      'add-generic-password',
      '-U',
      '-s', keychainService(service),
      '-a', KEYCHAIN_ACCOUNT[kind],
      '-w', value,
    ], {
      encoding: 'utf-8',
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 5_000,
    });
  },
};

let adapter: GoogleCredentialStoreAdapter = macKeychainAdapter;

export function setGoogleCredentialStoreAdapterForTest(next?: GoogleCredentialStoreAdapter): void {
  adapter = next ?? macKeychainAdapter;
  memoryCache.clear();
}

export function googleCredentialStoreStatus(): Record<string, unknown> {
  return {
    backend: process.platform === 'darwin' ? 'macos-keychain' : 'unavailable',
    available: adapter.available(),
    repositoryPersistence: false,
    controllerStatePersistence: false,
    credentialKinds: ['refresh-token', 'client-secret'],
  };
}

function readStoredGoogleCredential(
  service: StoredGoogleService,
  kind: StoredGoogleCredentialKind,
): { value: string; source: string } | undefined {
  const candidates: StoredGoogleService[] = service === 'google-workspace'
    ? ['google-workspace']
    : [service, 'google-workspace'];
  for (const candidate of candidates) {
    const key = cacheKey(candidate, kind);
    const cached = memoryCache.get(key);
    if (cached) return { value: cached, source: `keychain:${candidate}:${kind}` };
    if (!adapter.available()) continue;
    const value = adapter.read(candidate, kind)?.trim();
    if (!value) continue;
    memoryCache.set(key, value);
    return { value, source: `keychain:${candidate}:${kind}` };
  }
  return undefined;
}

function writeStoredGoogleCredential(service: StoredGoogleService, kind: StoredGoogleCredentialKind, value: string): void {
  const normalized = value.trim();
  if (!normalized) throw new Error(kind === 'refresh-token' ? 'GOOGLE_REFRESH_TOKEN_REQUIRED' : 'GOOGLE_CLIENT_SECRET_REQUIRED');
  if (!adapter.available()) throw new Error('GOOGLE_CREDENTIAL_STORE_UNAVAILABLE');
  adapter.write(service, normalized, kind);
  memoryCache.set(cacheKey(service, kind), normalized);
}

export function readStoredGoogleRefreshToken(service: StoredGoogleService): { token: string; source: string } | undefined {
  const stored = readStoredGoogleCredential(service, 'refresh-token');
  return stored ? { token: stored.value, source: stored.source } : undefined;
}

export function writeStoredGoogleRefreshToken(service: StoredGoogleService, refreshToken: string): void {
  writeStoredGoogleCredential(service, 'refresh-token', refreshToken);
}

export function readStoredGoogleClientSecret(service: StoredGoogleService): { secret: string; source: string } | undefined {
  const stored = readStoredGoogleCredential(service, 'client-secret');
  return stored ? { secret: stored.value, source: stored.source } : undefined;
}

export function writeStoredGoogleClientSecret(service: StoredGoogleService, clientSecret: string): void {
  writeStoredGoogleCredential(service, 'client-secret', clientSecret);
}

export function importStoredGoogleClientSecretFromClipboard(service: StoredGoogleService): Record<string, unknown> {
  if (process.platform !== 'darwin' || !adapter.available()) throw new Error('GOOGLE_CREDENTIAL_STORE_UNAVAILABLE');
  const secret = execFileSync('/usr/bin/pbpaste', [], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2_000,
  }).trim();
  if (!secret || secret.length > 1024 || /\s/.test(secret)) throw new Error('GOOGLE_CLIENT_SECRET_CLIPBOARD_INVALID');
  writeStoredGoogleClientSecret(service, secret);
  execFileSync('/usr/bin/pbcopy', [], {
    encoding: 'utf-8',
    input: '',
    stdio: ['pipe', 'ignore', 'ignore'],
    timeout: 2_000,
  });
  return {
    stored: true,
    service,
    backend: 'macos-keychain',
    clipboardCleared: true,
    credentialMaterialReturned: false,
  };
}
