import { createPrivateKey, sign } from 'crypto';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, promises as fsPromises, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { CONTROLLER_SCOPE_REPO_ID, controllerSystemRoot } from '../../cli/repositories/controller-home';
import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginBuildContext,
  AssistantPluginCapability,
  AssistantPluginHealth,
  AssistantPluginManifest,
  AssistantPluginPermissionScope,
} from './types';
import { AssistantPluginError, toAssistantPluginError } from './errors';
import { readRepositoryPluginConfig, writeRepositoryPluginConfig } from './config-store';
import { buildQueryString, encodeBase64Url, stableMockId } from './google-shared';

const APP_STORE_CONNECT_PLUGIN_ID = 'app_store_connect';
const API_BASE_URL = 'https://api.appstoreconnect.apple.com';
const DEFAULT_TIMEOUT_MS = 60_000;
const PRIVATE_KEY_READ_MAX_ATTEMPTS = 4;
const PRIVATE_KEY_READ_RETRY_BASE_MS = 10;

type AppStoreConnectProviderKind = 'mock' | 'app-store-connect-api';

interface AppStoreConnectPluginConfig {
  schemaVersion: 1;
  enabled: boolean;
  provider: AppStoreConnectProviderKind;
  issuerId?: string;
  keyId?: string;
  privateKeyPath?: string;
  teamId?: string;
  defaultAppId?: string;
  defaultLocale?: string;
  defaultTimeoutMs?: number;
}

interface AppStoreConnectAuthState {
  provider: AppStoreConnectProviderKind;
  ready: boolean;
  authenticated: boolean;
  probed: boolean;
  credentialSource?: string;
  issuerId?: string;
  keyId?: string;
  errors: string[];
  warnings: string[];
}

export interface AppStoreConnectXcodeAuthenticationReference {
  privateKeyPath: string;
  keyId: string;
  issuerId: string;
}

function now(): string {
  return new Date().toISOString();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function boundedTimeout(value: unknown): number | undefined {
  const normalized = positiveInteger(value);
  return normalized && normalized <= 10 * 60_000 ? normalized : undefined;
}

function globalConfigPath(controllerHome: string): string {
  return join(controllerSystemRoot(controllerHome), 'plugins', 'profiles', 'app-store-connect.json');
}

function normalizeConfig(raw: Partial<AppStoreConnectPluginConfig>): AppStoreConnectPluginConfig {
  return {
    schemaVersion: 1,
    enabled: raw.enabled === true,
    provider: raw.provider === 'app-store-connect-api' ? 'app-store-connect-api' : 'mock',
    issuerId: stringValue(raw.issuerId),
    keyId: stringValue(raw.keyId),
    privateKeyPath: stringValue(raw.privateKeyPath),
    teamId: stringValue(raw.teamId),
    defaultAppId: stringValue(raw.defaultAppId),
    defaultLocale: stringValue(raw.defaultLocale) ?? 'en-US',
    defaultTimeoutMs: boundedTimeout(raw.defaultTimeoutMs),
  };
}

function readConfigFile(path: string): Partial<AppStoreConnectPluginConfig> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AppStoreConnectPluginConfig>;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function repositoryConfig(repoRoot: string, controllerHome?: string, repoId?: string): Partial<AppStoreConnectPluginConfig> | undefined {
  if (!controllerHome || !repoId) return undefined;
  return readRepositoryPluginConfig<Partial<AppStoreConnectPluginConfig>>({ controllerHome, repoId, repoRoot }, APP_STORE_CONNECT_PLUGIN_ID);
}

function loadConfig(repoRoot: string, controllerHome?: string, repoId?: string): AppStoreConnectPluginConfig {
  const global = controllerHome ? readConfigFile(globalConfigPath(controllerHome)) : undefined;
  if (repoId === CONTROLLER_SCOPE_REPO_ID) return normalizeConfig(global ?? {});
  const local = repositoryConfig(repoRoot, controllerHome, repoId);
  return normalizeConfig({ ...(global ?? {}), ...(local ?? {}) });
}

function definedPatch(patch: Partial<AppStoreConnectPluginConfig>): Partial<AppStoreConnectPluginConfig> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<AppStoreConnectPluginConfig>;
}

function saveConfig(
  repoRoot: string,
  patch: Partial<AppStoreConnectPluginConfig>,
  controllerHome?: string,
  repoId?: string,
): AppStoreConnectPluginConfig {
  const cleanPatch = definedPatch(patch);
  if (controllerHome && repoId === CONTROLLER_SCOPE_REPO_ID) {
    const path = globalConfigPath(controllerHome);
    const next = normalizeConfig({ ...(readConfigFile(path) ?? {}), ...cleanPatch });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    return next;
  }

  if (!controllerHome || !repoId) throw new Error('APP_STORE_CONNECT_CONTROLLER_CONTEXT_REQUIRED');
  // Repository state is an overlay only. Do not materialize inherited global
  // credential references into every repository just because configure ran.
  const existing = repositoryConfig(repoRoot, controllerHome, repoId) ?? {};
  const overlay = { schemaVersion: 1 as const, ...existing, ...cleanPatch };
  writeRepositoryPluginConfig({ controllerHome, repoId, repoRoot }, APP_STORE_CONNECT_PLUGIN_ID, overlay);
  return loadConfig(repoRoot, controllerHome, repoId);
}

function envValue(name: string): string | undefined {
  return stringValue(process.env[name]);
}

interface AppStoreConnectPrivateKeyReference {
  available: boolean;
  source?: string;
  warning?: string;
}

function privateKeyPathReference(path: string, source: string): AppStoreConnectPrivateKeyReference {
  if (!existsSync(path)) {
    return { available: false, source, warning: 'Configured App Store Connect private key path does not exist.' };
  }
  try {
    if (!statSync(path).isFile()) {
      return { available: false, source, warning: 'Configured App Store Connect private key path is not a regular file.' };
    }
    accessSync(path, fsConstants.R_OK);
    return { available: true, source };
  } catch {
    // Capability discovery and auth_status are metadata reads. They must never
    // synchronously consume secret bytes just to decide whether a credential
    // reference is usable; filesystem contention (including macOS EDEADLK)
    // therefore degrades readiness instead of escaping as a raw read error.
    return { available: false, source, warning: 'Configured App Store Connect private key path is not readable.' };
  }
}

function privateKeyReference(config: AppStoreConnectPluginConfig): AppStoreConnectPrivateKeyReference {
  const inline = envValue('FORGE_ASC_PRIVATE_KEY');
  if (inline) return { available: true, source: 'env:FORGE_ASC_PRIVATE_KEY' };
  const envKeyPath = envValue('FORGE_ASC_PRIVATE_KEY_PATH');
  if (envKeyPath) return privateKeyPathReference(envKeyPath, 'env:FORGE_ASC_PRIVATE_KEY_PATH');
  if (config.privateKeyPath) return privateKeyPathReference(config.privateKeyPath, 'config:privateKeyPath');
  return { available: false };
}

function fsErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

async function readPrivateKeyFile(path: string, source: string): Promise<{ key?: string; source: string; warning?: string }> {
  for (let attempt = 1; attempt <= PRIVATE_KEY_READ_MAX_ATTEMPTS; attempt += 1) {
    try {
      return { key: await fsPromises.readFile(path, 'utf-8'), source };
    } catch (error) {
      const code = fsErrorCode(error);
      if (code === 'ENOENT') {
        return { source, warning: 'Configured App Store Connect private key path does not exist.' };
      }
      if (code === 'EDEADLK' && attempt < PRIVATE_KEY_READ_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, PRIVATE_KEY_READ_RETRY_BASE_MS * attempt));
        continue;
      }
      if (code === 'EDEADLK') {
        throw new AssistantPluginError(
          'PLUGIN_PROVIDER_UNAVAILABLE',
          'App Store Connect private key is temporarily unavailable because the filesystem is busy.',
          { retryable: true, details: { credentialSource: source, code } },
        );
      }
      throw new AssistantPluginError(
        'PLUGIN_AUTH_REQUIRED',
        'Configured App Store Connect private key could not be read.',
        { retryable: false, details: { credentialSource: source, code } },
      );
    }
  }
  throw new AssistantPluginError('PLUGIN_PROVIDER_UNAVAILABLE', 'App Store Connect private key is temporarily unavailable.', { retryable: true });
}

async function privateKeyMaterial(config: AppStoreConnectPluginConfig): Promise<{ key?: string; source?: string; warning?: string }> {
  const inline = envValue('FORGE_ASC_PRIVATE_KEY');
  if (inline) return { key: inline.replace(/\\n/g, '\n'), source: 'env:FORGE_ASC_PRIVATE_KEY' };
  const envKeyPath = envValue('FORGE_ASC_PRIVATE_KEY_PATH');
  if (envKeyPath) return readPrivateKeyFile(envKeyPath, 'env:FORGE_ASC_PRIVATE_KEY_PATH');
  if (config.privateKeyPath) return readPrivateKeyFile(config.privateKeyPath, 'config:privateKeyPath');
  return {};
}

function resolveAuth(config: AppStoreConnectPluginConfig): AppStoreConnectAuthState {
  if (config.provider === 'mock') {
    return {
      provider: 'mock',
      ready: true,
      authenticated: true,
      probed: true,
      credentialSource: 'mock-provider',
      issuerId: config.issuerId,
      keyId: config.keyId,
      errors: [],
      warnings: ['Mock provider enabled. No Apple credentials are persisted or required.'],
    };
  }

  const issuerId = envValue('FORGE_ASC_ISSUER_ID') ?? config.issuerId;
  const keyId = envValue('FORGE_ASC_KEY_ID') ?? config.keyId;
  const key = privateKeyReference(config);
  const errors: string[] = [];
  const warnings: string[] = key.warning ? [key.warning] : [];
  if (!issuerId) errors.push('Set FORGE_ASC_ISSUER_ID or configure issuer_id.');
  if (!keyId) errors.push('Set FORGE_ASC_KEY_ID or configure key_id.');
  if (!key.available) errors.push('Set FORGE_ASC_PRIVATE_KEY, FORGE_ASC_PRIVATE_KEY_PATH, or configure private_key_path.');

  return {
    provider: 'app-store-connect-api',
    ready: errors.length === 0,
    authenticated: errors.length === 0,
    probed: true,
    credentialSource: key.source,
    issuerId,
    keyId,
    errors,
    warnings,
  };
}

export function resolveAppStoreConnectXcodeAuthenticationReference(
  repoRoot: string,
  controllerHome: string,
  repoId: string,
): AppStoreConnectXcodeAuthenticationReference {
  const config = loadConfig(repoRoot, controllerHome, repoId);
  if (!config.enabled) {
    throw new AssistantPluginError('PLUGIN_DISABLED', 'App Store Connect is disabled for this repository.', { retryable: false });
  }
  if (config.provider !== 'app-store-connect-api') {
    throw new AssistantPluginError('PLUGIN_DEPENDENCY_MISSING', 'Xcode provisioning requires the App Store Connect API provider.', { retryable: false });
  }
  const privateKeyPath = envValue('FORGE_ASC_PRIVATE_KEY_PATH') ?? config.privateKeyPath;
  const keyId = envValue('FORGE_ASC_KEY_ID') ?? config.keyId;
  const issuerId = envValue('FORGE_ASC_ISSUER_ID') ?? config.issuerId;
  if (!privateKeyPath) {
    throw new AssistantPluginError(
      'PLUGIN_DEPENDENCY_MISSING',
      'Xcode provisioning requires a file-backed App Store Connect private key path; inline key material is not accepted for this path.',
      { retryable: false },
    );
  }
  if (!existsSync(privateKeyPath)) {
    throw new AssistantPluginError('PLUGIN_DEPENDENCY_MISSING', 'Configured App Store Connect private key path does not exist.', { retryable: false });
  }
  if (!keyId || !issuerId) {
    throw new AssistantPluginError('PLUGIN_DEPENDENCY_MISSING', 'App Store Connect key id and issuer id are required for Xcode provisioning.', { retryable: false });
  }
  return { privateKeyPath, keyId, issuerId };
}

function readLength(buffer: Buffer, offset: number): { length: number; next: number } {
  const first = buffer[offset];
  if (first < 0x80) return { length: first, next: offset + 1 };
  const bytes = first & 0x7f;
  let length = 0;
  for (let index = 0; index < bytes; index += 1) length = (length << 8) + buffer[offset + 1 + index];
  return { length, next: offset + 1 + bytes };
}

function derIntegerToJose(buffer: Buffer): Buffer {
  let value = buffer;
  while (value.length > 32 && value[0] === 0) value = value.subarray(1);
  if (value.length > 32) throw new Error('Invalid ES256 signature integer length.');
  if (value.length === 32) return value;
  return Buffer.concat([Buffer.alloc(32 - value.length), value]);
}

function derSignatureToJose(signature: Buffer): string {
  if (signature[0] !== 0x30) throw new Error('Invalid DER signature sequence.');
  let cursor = readLength(signature, 1).next;
  if (signature[cursor] !== 0x02) throw new Error('Invalid DER signature R marker.');
  const rLength = readLength(signature, cursor + 1);
  const r = signature.subarray(rLength.next, rLength.next + rLength.length);
  cursor = rLength.next + rLength.length;
  if (signature[cursor] !== 0x02) throw new Error('Invalid DER signature S marker.');
  const sLength = readLength(signature, cursor + 1);
  const s = signature.subarray(sLength.next, sLength.next + sLength.length);
  return Buffer.concat([derIntegerToJose(r), derIntegerToJose(s)]).toString('base64url');
}

async function createJwt(config: AppStoreConnectPluginConfig): Promise<string> {
  const issuerId = envValue('FORGE_ASC_ISSUER_ID') ?? config.issuerId;
  const keyId = envValue('FORGE_ASC_KEY_ID') ?? config.keyId;
  const key = (await privateKeyMaterial(config)).key;
  if (!issuerId || !keyId || !key) throw new AssistantPluginError('PLUGIN_AUTH_REQUIRED', 'App Store Connect API credentials are incomplete.', { retryable: false });

  const issuedAt = Math.floor(Date.now() / 1000);
  const header = encodeBase64Url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = encodeBase64Url(JSON.stringify({ iss: issuerId, iat: issuedAt, exp: issuedAt + 20 * 60, aud: 'appstoreconnect-v1' }));
  const signingInput = `${header}.${payload}`;
  const privateKey = createPrivateKey({ key, format: 'pem' });
  const der = sign('sha256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${derSignatureToJose(der)}`;
}

async function apiRequest<T>(config: AppStoreConnectPluginConfig, options: {
  path: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  const url = `${API_BASE_URL}${options.path}${buildQueryString(options.query ?? {})}`;
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        authorization: `Bearer ${await createJwt(config)}`,
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const raw = await response.text();
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
    if (response.status === 401 || response.status === 403) {
      throw new AssistantPluginError('PLUGIN_AUTH_FAILED', 'App Store Connect rejected the API token.', { retryable: false, details: { status: response.status, providerError: parsed } });
    }
    if (response.status === 429) {
      throw new AssistantPluginError('PLUGIN_RATE_LIMITED', 'App Store Connect rate limited the request.', { retryable: true, details: { status: response.status, retryAfter: response.headers.get('retry-after') ?? undefined, providerError: parsed } });
    }
    if (response.status >= 500) {
      throw new AssistantPluginError('PLUGIN_PROVIDER_UNAVAILABLE', 'App Store Connect is temporarily unavailable.', { retryable: true, details: { status: response.status, providerError: parsed } });
    }
    if (!response.ok) {
      throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', `App Store Connect returned HTTP ${response.status}.`, { retryable: false, details: { status: response.status, providerError: parsed } });
    }
    return (parsed ?? {}) as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AssistantPluginError('PLUGIN_PROVIDER_TIMEOUT', 'App Store Connect request timed out.', { retryable: true, details: { timeoutMs: options.timeoutMs ?? config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS } });
    }
    throw toAssistantPluginError(error, { code: 'PLUGIN_PROVIDER_ERROR', message: 'App Store Connect request failed.', retryable: true });
  } finally {
    clearTimeout(timeout);
  }
}

function userFacingAscStatus(config: AppStoreConnectPluginConfig, auth: AppStoreConnectAuthState): string {
  if (!config.enabled) return 'auth missing';
  if (config.provider === 'mock' && auth.ready) return 'ready';
  if (!auth.ready) return 'auth missing';
  return 'write gated';
}

function pluginState(config: AppStoreConnectPluginConfig, auth: AppStoreConnectAuthState): { lifecycleState: 'enabled' | 'disabled' | 'degraded' | 'error'; health: AssistantPluginHealth } {
  const missingAuth = config.enabled && config.provider !== 'mock' && !auth.ready;
  const lifecycleState = !config.enabled ? 'disabled' : auth.ready ? 'enabled' : missingAuth ? 'degraded' : 'error';
  const healthState = !config.enabled ? 'disabled' : auth.ready ? 'ready' : missingAuth ? 'degraded' : 'error';
  return {
    lifecycleState,
    health: {
      state: healthState,
      checkedAt: now(),
      ready: config.enabled && auth.ready,
      probed: config.enabled ? auth.probed : false,
      errors: config.enabled && !missingAuth ? [...auth.errors] : [],
      warnings: !config.enabled
        ? ['Plugin is disabled. Enable it before using App Store Connect actions.']
        : [...auth.warnings, ...(missingAuth ? auth.errors : [])],
      details: {
        provider: config.provider,
        issuerId: auth.issuerId ? 'configured' : undefined,
        keyId: auth.keyId ? 'configured' : undefined,
        teamId: config.teamId,
        defaultAppId: config.defaultAppId,
        defaultLocale: config.defaultLocale,
        credentialSource: auth.credentialSource,
        credentialPersistence: 'private keys are read from environment or local path and are never persisted by forge',
        userFacingStatus: userFacingAscStatus(config, auth),
        readinessMode: !config.enabled
          ? 'disabled'
          : config.provider === 'mock'
            ? 'mock_provider_ready'
            : auth.ready
              ? 'live_provider_ready'
              : 'auth_missing',
        writePolicy: 'remote writes require confirmAuthorization; production actions require strong confirmation text',
      },
    },
  };
}

function permission(scope: string, mode: 'read' | 'write', description: string, granted: boolean): AssistantPluginPermissionScope {
  return { scope, mode, description, granted, required: true };
}

function permissions(ready: boolean): AssistantPluginPermissionScope[] {
  return [
    permission('appstoreconnect.apps.read', 'read', 'Read App Store Connect apps, versions, localizations, builds, and TestFlight groups.', ready),
    permission('appstoreconnect.developer_resources.read', 'read', 'Read Apple Developer bundle IDs, capabilities, certificates, devices, and provisioning profiles.', ready),
    permission('appstoreconnect.metadata.write', 'write', 'Patch App Store Connect metadata after dry-run review and authorization.', ready),
    permission('appstoreconnect.testflight.write', 'write', 'Assign builds to TestFlight groups and prepare beta review submissions.', ready),
    permission('appstoreconnect.release.write', 'write', 'Create App Store versions and gated review submissions.', ready),
    permission('appstoreconnect.xcodecloud.read', 'read', 'Read Xcode Cloud products and workflow configuration.', ready),
    permission('appstoreconnect.xcodecloud.write', 'write', 'Update Xcode Cloud workflow configuration after dry-run review and strong confirmation.', ready),
  ];
}

function capabilities(): AssistantPluginCapability[] {
  return [
    {
      capabilityId: 'app-store-read',
      title: 'App Store Status',
      description: 'Query apps, versions, localizations, builds, TestFlight groups/testers, and review submissions.',
      scopes: ['appstoreconnect.apps.read'],
      actions: [
        'auth_status', 'list_apps', 'list_app_store_versions', 'list_app_store_version_localizations',
        'get_app_info', 'list_app_infos', 'list_builds', 'list_testflight_builds', 'get_build_detail',
        'list_beta_groups', 'list_beta_testers', 'list_review_submissions',
      ],
    },
    {
      capabilityId: 'developer-resources-read',
      title: 'Apple Developer Resources',
      description: 'Read Certificates, Identifiers & Profiles resources to diagnose provisioning authorization without mutating Apple Developer state.',
      scopes: ['appstoreconnect.developer_resources.read'],
      actions: ['list_bundle_ids', 'list_bundle_id_capabilities', 'list_certificates', 'list_devices', 'list_profiles'],
    },
    {
      capabilityId: 'app-store-metadata',
      title: 'App Metadata Update',
      description: 'Preview and apply metadata localization updates with dry-run support.',
      scopes: ['appstoreconnect.metadata.write'],
      actions: [
        'preview_app_info_localization_update', 'update_app_info_localization',
        'preview_app_store_version_metadata_update', 'update_app_store_version_metadata',
      ],
    },
    {
      capabilityId: 'app-store-testflight',
      title: 'TestFlight Operations',
      description: 'Assign builds to beta groups and prepare beta App Review submissions with strong confirmation.',
      scopes: ['appstoreconnect.testflight.write'],
      actions: ['assign_build_to_beta_group', 'submit_beta_app_review'],
    },
    {
      capabilityId: 'app-store-release',
      title: 'Release Operations',
      description: 'Create App Store versions and gated review submissions with strong confirmation.',
      scopes: ['appstoreconnect.release.write'],
      actions: ['create_app_store_version', 'create_review_submission', 'submit_for_review'],
    },
    {
      capabilityId: 'xcode-cloud-workflows',
      title: 'Xcode Cloud Workflows',
      description: 'Read Xcode Cloud products/workflows and preview or update a fixed workflow configuration through the official App Store Connect API.',
      scopes: ['appstoreconnect.xcodecloud.read', 'appstoreconnect.xcodecloud.write'],
      actions: ['list_xcode_cloud_products', 'list_xcode_cloud_workflows', 'get_xcode_cloud_workflow', 'preview_xcode_cloud_workflow_update', 'update_xcode_cloud_workflow'],
    },
  ];
}

function actions(): AssistantPluginActionDescriptor[] {
  const readRemote = [{ resource: 'remote' as const, mode: 'read' as const }];
  const writeRemote = [{ resource: 'remote' as const, mode: 'exclusive' as const }];
  return [
    {
      actionId: 'configure', title: 'Configure App Store Connect plugin', description: 'Enable official App Store Connect API access and save non-secret defaults.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: true,
      scopes: ['appstoreconnect.apps.read', 'appstoreconnect.developer_resources.read', 'appstoreconnect.metadata.write', 'appstoreconnect.testflight.write', 'appstoreconnect.release.write', 'appstoreconnect.xcodecloud.read', 'appstoreconnect.xcodecloud.write'], resourceClaims: [{ resource: 'repo-state', mode: 'write' }],
      argumentsSchema: { type: 'object', properties: { enabled: { type: 'boolean' }, provider: { type: 'string', enum: ['mock', 'app-store-connect-api'] }, issuer_id: { type: 'string' }, key_id: { type: 'string' }, private_key_path: { type: 'string' }, clear_private_key_path: { type: 'boolean' }, clear_api_identity: { type: 'boolean' }, team_id: { type: 'string' }, clear_team_id: { type: 'boolean' }, default_app_id: { type: 'string' }, clear_default_app_id: { type: 'boolean' }, default_locale: { type: 'string' }, default_timeout_ms: { type: 'number' } }, additionalProperties: false },
    },
    { actionId: 'auth_status', title: 'Check App Store Connect auth', description: 'Report API readiness without returning secrets.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 10_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: [], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { actionId: 'list_apps', title: 'List apps', description: 'List App Store Connect apps, optionally filtered by bundle ID or name.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { bundle_id: { type: 'string' }, name: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'list_bundle_ids', title: 'List Apple Developer bundle IDs', description: 'Read registered Bundle IDs, optionally filtered by exact identifier or name.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.developer_resources.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { identifier: { type: 'string' }, name: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'list_bundle_id_capabilities', title: 'List Bundle ID capabilities', description: 'Read enabled capabilities for one exact Apple Developer Bundle ID resource.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.developer_resources.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { bundle_id_resource_id: { type: 'string' }, limit: { type: 'number' } }, required: ['bundle_id_resource_id'], additionalProperties: false } },
    { actionId: 'list_certificates', title: 'List Apple Developer certificates', description: 'Read certificates available to the current Apple Developer API identity.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.developer_resources.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { certificate_type: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'list_devices', title: 'List Apple Developer devices', description: 'Read registered devices, optionally filtered by UDID.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.developer_resources.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { udid: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'list_profiles', title: 'List provisioning profiles', description: 'Read Apple Developer provisioning profiles, optionally filtered by profile name or type.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.developer_resources.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { name: { type: 'string' }, profile_type: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'list_app_store_versions', title: 'List App Store versions', description: 'List App Store versions for one app.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'list_app_store_version_localizations', title: 'List App Store version localizations', description: 'List localizations for one App Store version.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { version_id: { type: 'string' }, limit: { type: 'number' } }, required: ['version_id'], additionalProperties: false } },
    { actionId: 'get_app_info', title: 'Get app info', description: 'Get App Info records and localizations for one app.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' } }, additionalProperties: false } },
    { actionId: 'list_app_infos', title: 'List app infos', description: 'List App Info records for one app.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'list_builds', title: 'List builds', description: 'List recent builds for one app with processing state fields.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'list_testflight_builds', title: 'List TestFlight builds', description: 'List builds with TestFlight processing/export compliance fields.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'get_build_detail', title: 'Get build detail', description: 'Get one build record with processing and TestFlight attributes.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { build_id: { type: 'string' } }, required: ['build_id'], additionalProperties: false } },
    { actionId: 'list_beta_groups', title: 'List TestFlight beta groups', description: 'List TestFlight beta groups for one app.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'list_beta_testers', title: 'List beta testers', description: 'List TestFlight beta testers for one app.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'list_review_submissions', title: 'List review submissions', description: 'List App Store review submissions for one app when available.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'list_xcode_cloud_products', title: 'List Xcode Cloud products', description: 'List Xcode Cloud products, optionally filtered to an App Store Connect app.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.xcodecloud.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'list_xcode_cloud_workflows', title: 'List Xcode Cloud workflows', description: 'List workflows for one exact Xcode Cloud product.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.xcodecloud.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { product_id: { type: 'string' }, limit: { type: 'number' } }, required: ['product_id'], additionalProperties: false } },
    { actionId: 'get_xcode_cloud_workflow', title: 'Get Xcode Cloud workflow', description: 'Read one Xcode Cloud workflow including start conditions and actions.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.xcodecloud.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { workflow_id: { type: 'string' } }, required: ['workflow_id'], additionalProperties: false } },
    { actionId: 'preview_xcode_cloud_workflow_update', title: 'Preview Xcode Cloud workflow update', description: 'Build the fixed ciWorkflows PATCH request without sending it.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 10_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.xcodecloud.write'], resourceClaims: [], argumentsSchema: { type: 'object', properties: { workflow_id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, is_enabled: { type: 'boolean' }, clean: { type: 'boolean' }, container_file_path: { type: 'string' }, branch_start_condition: { type: ['object', 'null'], additionalProperties: true }, tag_start_condition: { type: ['object', 'null'], additionalProperties: true }, pull_request_start_condition: { type: ['object', 'null'], additionalProperties: true }, scheduled_start_condition: { type: ['object', 'null'], additionalProperties: true }, manual_branch_start_condition: { type: ['object', 'null'], additionalProperties: true }, manual_tag_start_condition: { type: ['object', 'null'], additionalProperties: true }, manual_pull_request_start_condition: { type: ['object', 'null'], additionalProperties: true }, actions: { type: 'array', items: { type: 'object', additionalProperties: true } } }, required: ['workflow_id'], additionalProperties: false } },
    { actionId: 'update_xcode_cloud_workflow', title: 'Update Xcode Cloud workflow', description: 'Patch one exact Xcode Cloud workflow through the official App Store Connect API. Use dry_run=true before applying.', readOnly: false, risk: 'remote_write', confirmation: 'strong_confirmation', requiredConfirmationText: 'update-xcode-cloud-workflow', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false, scopes: ['appstoreconnect.xcodecloud.write'], resourceClaims: writeRemote, argumentsSchema: { type: 'object', properties: { workflow_id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, is_enabled: { type: 'boolean' }, clean: { type: 'boolean' }, container_file_path: { type: 'string' }, branch_start_condition: { type: ['object', 'null'], additionalProperties: true }, tag_start_condition: { type: ['object', 'null'], additionalProperties: true }, pull_request_start_condition: { type: ['object', 'null'], additionalProperties: true }, scheduled_start_condition: { type: ['object', 'null'], additionalProperties: true }, manual_branch_start_condition: { type: ['object', 'null'], additionalProperties: true }, manual_tag_start_condition: { type: ['object', 'null'], additionalProperties: true }, manual_pull_request_start_condition: { type: ['object', 'null'], additionalProperties: true }, actions: { type: 'array', items: { type: 'object', additionalProperties: true } }, dry_run: { type: 'boolean' } }, required: ['workflow_id'], additionalProperties: false } },
    { actionId: 'preview_app_info_localization_update', title: 'Preview app metadata update', description: 'Build the App Info Localization PATCH payload without sending it.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 10_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.metadata.write'], resourceClaims: [], argumentsSchema: { type: 'object', properties: { localization_id: { type: 'string' }, name: { type: 'string' }, subtitle: { type: 'string' }, privacy_policy_url: { type: 'string' }, privacy_policy_text: { type: 'string' } }, required: ['localization_id'], additionalProperties: false } },
    { actionId: 'update_app_info_localization', title: 'Update app metadata localization', description: 'Patch App Store Connect App Info Localization metadata through the official API. Use dry_run=true before applying.', readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false, scopes: ['appstoreconnect.metadata.write'], resourceClaims: writeRemote, argumentsSchema: { type: 'object', properties: { localization_id: { type: 'string' }, name: { type: 'string' }, subtitle: { type: 'string' }, privacy_policy_url: { type: 'string' }, privacy_policy_text: { type: 'string' }, dry_run: { type: 'boolean' } }, required: ['localization_id'], additionalProperties: false } },
    { actionId: 'preview_app_store_version_metadata_update', title: 'Preview version metadata update', description: 'Build the App Store Version Localization PATCH payload without sending it.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 10_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.metadata.write'], resourceClaims: [], argumentsSchema: { type: 'object', properties: { localization_id: { type: 'string' }, description: { type: 'string' }, keywords: { type: 'string' }, marketing_url: { type: 'string' }, promotional_text: { type: 'string' }, support_url: { type: 'string' }, whats_new: { type: 'string' } }, required: ['localization_id'], additionalProperties: false } },
    { actionId: 'update_app_store_version_metadata', title: 'Update version metadata localization', description: 'Patch App Store Version Localization metadata. Use dry_run=true before applying.', readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false, scopes: ['appstoreconnect.metadata.write'], resourceClaims: writeRemote, argumentsSchema: { type: 'object', properties: { localization_id: { type: 'string' }, description: { type: 'string' }, keywords: { type: 'string' }, marketing_url: { type: 'string' }, promotional_text: { type: 'string' }, support_url: { type: 'string' }, whats_new: { type: 'string' }, dry_run: { type: 'boolean' } }, required: ['localization_id'], additionalProperties: false } },
    {
      actionId: 'create_app_store_version', title: 'Create App Store version', description: 'Create a new App Store version for an app platform. Requires strong confirmation.',
      readOnly: false, risk: 'remote_write', confirmation: 'strong_confirmation', requiredConfirmationText: 'create-app-store-version',
      defaultTimeoutMs: 60_000, cancellable: true, idempotent: false, scopes: ['appstoreconnect.release.write'], resourceClaims: writeRemote,
      argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, version_string: { type: 'string' }, platform: { type: 'string', enum: ['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'] }, copyright: { type: 'string' }, dry_run: { type: 'boolean' } }, required: ['version_string'], additionalProperties: false },
    },
    {
      actionId: 'assign_build_to_beta_group', title: 'Assign build to TestFlight group', description: 'Add a build to a TestFlight beta group. Requires strong confirmation.',
      readOnly: false, risk: 'remote_write', confirmation: 'strong_confirmation', requiredConfirmationText: 'assign-testflight-build',
      defaultTimeoutMs: 60_000, cancellable: true, idempotent: false, scopes: ['appstoreconnect.testflight.write'], resourceClaims: writeRemote,
      argumentsSchema: { type: 'object', properties: { build_id: { type: 'string' }, beta_group_id: { type: 'string' }, dry_run: { type: 'boolean' } }, required: ['build_id', 'beta_group_id'], additionalProperties: false },
    },
    {
      actionId: 'submit_beta_app_review', title: 'Submit beta App Review', description: 'Create a beta app review submission for a build. Requires strong confirmation.',
      readOnly: false, risk: 'remote_write', confirmation: 'strong_confirmation', requiredConfirmationText: 'submit-beta-review',
      defaultTimeoutMs: 60_000, cancellable: true, idempotent: false, scopes: ['appstoreconnect.testflight.write'], resourceClaims: writeRemote,
      argumentsSchema: { type: 'object', properties: { build_id: { type: 'string' }, dry_run: { type: 'boolean' } }, required: ['build_id'], additionalProperties: false },
    },
    {
      actionId: 'create_review_submission', title: 'Create review submission', description: 'Create an App Store review submission shell for an app. Requires strong confirmation.',
      readOnly: false, risk: 'remote_write', confirmation: 'strong_confirmation', requiredConfirmationText: 'submit-app-review',
      defaultTimeoutMs: 60_000, cancellable: true, idempotent: false, scopes: ['appstoreconnect.release.write'], resourceClaims: writeRemote,
      argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, platform: { type: 'string', enum: ['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'] }, dry_run: { type: 'boolean' } }, additionalProperties: false },
    },
    {
      actionId: 'submit_for_review', title: 'Submit for App Review', description: 'Submit an existing review submission. Requires strong confirmation. Prefer dry_run first.',
      readOnly: false, risk: 'remote_write', confirmation: 'strong_confirmation', requiredConfirmationText: 'submit-app-review',
      defaultTimeoutMs: 60_000, cancellable: true, idempotent: false, scopes: ['appstoreconnect.release.write'], resourceClaims: writeRemote,
      argumentsSchema: { type: 'object', properties: { review_submission_id: { type: 'string' }, dry_run: { type: 'boolean' } }, required: ['review_submission_id'], additionalProperties: false },
    },
  ];
}

function appId(args: Record<string, unknown>, config: AppStoreConnectPluginConfig): string {
  const value = stringValue(args.app_id) ?? config.defaultAppId;
  if (!value) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'app_id is required when no default_app_id is configured.', { retryable: false });
  return value;
}

function limit(value: unknown, fallback = 25): number {
  const normalized = positiveInteger(value) ?? fallback;
  return Math.min(Math.max(normalized, 1), 200);
}

function localizationPatch(args: Record<string, unknown>): Record<string, unknown> {
  const attributes: Record<string, string> = {};
  const mapping = new Map([
    ['name', 'name'],
    ['subtitle', 'subtitle'],
    ['privacy_policy_url', 'privacyPolicyUrl'],
    ['privacy_policy_text', 'privacyPolicyText'],
  ]);
  for (const [argName, attributeName] of mapping) {
    const value = stringValue(args[argName]);
    if (value !== undefined) attributes[attributeName] = value;
  }
  if (Object.keys(attributes).length === 0) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Provide at least one metadata field to update.', { retryable: false });
  const id = stringValue(args.localization_id);
  if (!id) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'localization_id is required.', { retryable: false });
  return { data: { type: 'appInfoLocalizations', id, attributes } };
}

function versionLocalizationPatch(args: Record<string, unknown>): Record<string, unknown> {
  const attributes: Record<string, string> = {};
  const mapping = new Map([
    ['description', 'description'],
    ['keywords', 'keywords'],
    ['marketing_url', 'marketingUrl'],
    ['promotional_text', 'promotionalText'],
    ['support_url', 'supportUrl'],
    ['whats_new', 'whatsNew'],
  ]);
  for (const [argName, attributeName] of mapping) {
    const value = stringValue(args[argName]);
    if (value !== undefined) attributes[attributeName] = value;
  }
  if (Object.keys(attributes).length === 0) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Provide at least one version metadata field to update.', { retryable: false });
  const id = stringValue(args.localization_id);
  if (!id) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'localization_id is required.', { retryable: false });
  return { data: { type: 'appStoreVersionLocalizations', id, attributes } };
}

function xcodeCloudWorkflowPatch(args: Record<string, unknown>): Record<string, unknown> {
  const id = requiredArg(args, 'workflow_id');
  const attributes: Record<string, unknown> = {};
  const stringFields = new Map([
    ['name', 'name'],
    ['description', 'description'],
    ['container_file_path', 'containerFilePath'],
  ]);
  for (const [inputName, attributeName] of stringFields) {
    const value = stringValue(args[inputName]);
    if (value !== undefined) attributes[attributeName] = value;
  }
  if (typeof args.is_enabled === 'boolean') attributes.isEnabled = args.is_enabled;
  if (typeof args.clean === 'boolean') attributes.clean = args.clean;
  const objectFields = new Map([
    ['branch_start_condition', 'branchStartCondition'],
    ['tag_start_condition', 'tagStartCondition'],
    ['pull_request_start_condition', 'pullRequestStartCondition'],
    ['scheduled_start_condition', 'scheduledStartCondition'],
    ['manual_branch_start_condition', 'manualBranchStartCondition'],
    ['manual_tag_start_condition', 'manualTagStartCondition'],
    ['manual_pull_request_start_condition', 'manualPullRequestStartCondition'],
  ]);
  for (const [inputName, attributeName] of objectFields) {
    const value = args[inputName];
    if (value === null || (value && typeof value === 'object' && !Array.isArray(value))) attributes[attributeName] = value;
  }
  if (Array.isArray(args.actions)) attributes.actions = args.actions;
  if (Object.keys(attributes).length === 0) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Provide at least one Xcode Cloud workflow field to update.', { retryable: false });
  return { data: { type: 'ciWorkflows', id, attributes } };
}

function requiredArg(args: Record<string, unknown>, name: string): string {
  const value = stringValue(args[name]);
  if (!value) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `${name} is required.`, { retryable: false });
  return value;
}

function mockBuild(id: string) {
  return {
    type: 'builds',
    id: stableMockId('build', { id }),
    attributes: {
      version: '42',
      uploadedDate: now(),
      processingState: 'VALID',
      expired: false,
      usesNonExemptEncryption: false,
      minOsVersion: '17.0',
    },
  };
}

function mockResponse(actionId: string, args: Record<string, unknown>, config: AppStoreConnectPluginConfig): Record<string, unknown> {
  const id = stringValue(args.app_id) ?? config.defaultAppId ?? stableMockId('app', args);
  if (actionId === 'auth_status') {
    return {
      ready: true,
      provider: 'mock',
      warnings: ['Mock provider enabled.'],
      userFacingStatus: 'ready',
      readinessMode: 'mock_provider_ready',
    };
  }
  if (actionId === 'list_apps') return { data: [{ type: 'apps', id, attributes: { name: 'Mock App', bundleId: stringValue(args.bundle_id) ?? 'com.example.app', sku: 'MOCK' } }], meta: { provider: 'mock' } };
  if (actionId === 'list_app_store_versions') return { data: [{ type: 'appStoreVersions', id: stableMockId('version', { id }), attributes: { versionString: '1.0.0', appStoreState: 'PREPARE_FOR_SUBMISSION', platform: 'IOS' } }] };
  if (actionId === 'list_app_store_version_localizations') {
    return {
      data: [{
        type: 'appStoreVersionLocalizations',
        id: stableMockId('vloc', { version: args.version_id }),
        attributes: { locale: config.defaultLocale, description: 'Mock description', keywords: 'mock,app', whatsNew: 'Bug fixes' },
      }],
    };
  }
  if (actionId === 'get_app_info' || actionId === 'list_app_infos') {
    return {
      data: [{ type: 'appInfos', id: stableMockId('info', { id }) }],
      included: [{ type: 'appInfoLocalizations', id: stableMockId('loc', { id }), attributes: { locale: config.defaultLocale, name: 'Mock App' } }],
    };
  }
  if (actionId === 'list_builds' || actionId === 'list_testflight_builds') {
    return {
      data: [mockBuild(id)],
      meta: {
        provider: 'mock',
        testFlightFields: ['processingState', 'usesNonExemptEncryption', 'expired', 'uploadedDate'],
      },
    };
  }
  if (actionId === 'get_build_detail') {
    const buildId = stringValue(args.build_id) ?? stableMockId('build', args);
    return { data: { ...mockBuild(id), id: buildId } };
  }
  if (actionId === 'list_beta_groups') return { data: [{ type: 'betaGroups', id: stableMockId('beta', { id }), attributes: { name: 'Internal Testers', isInternalGroup: true } }] };
  if (actionId === 'list_beta_testers') {
    return {
      data: [{
        type: 'betaTesters',
        id: stableMockId('tester', { id }),
        attributes: { firstName: 'Mock', lastName: 'Tester', email: 'tester@example.com', state: 'ACCEPTED' },
      }],
    };
  }
  if (actionId === 'list_bundle_ids') return { data: [{ type: 'bundleIds', id: stableMockId('bundle_id', args), attributes: { identifier: stringValue(args.identifier) ?? 'com.example.app', name: stringValue(args.name) ?? 'Mock Bundle ID', platform: 'IOS' } }] };
  if (actionId === 'list_bundle_id_capabilities') return { data: [{ type: 'bundleIdCapabilities', id: stableMockId('bundle_capability', args), attributes: { capabilityType: 'ICLOUD', settings: [] } }] };
  if (actionId === 'list_certificates') return { data: [{ type: 'certificates', id: stableMockId('certificate', args), attributes: { certificateType: stringValue(args.certificate_type) ?? 'DEVELOPMENT', displayName: 'Mock Certificate' } }] };
  if (actionId === 'list_devices') return { data: [{ type: 'devices', id: stableMockId('device', args), attributes: { udid: stringValue(args.udid) ?? 'MOCK-UDID', name: 'Mock iPhone', platform: 'IOS', status: 'ENABLED' } }] };
  if (actionId === 'list_profiles') return { data: [{ type: 'profiles', id: stableMockId('profile', args), attributes: { name: stringValue(args.name) ?? 'Mock Profile', profileType: stringValue(args.profile_type) ?? 'IOS_APP_DEVELOPMENT', profileState: 'ACTIVE' } }] };
  if (actionId === 'list_xcode_cloud_products') return { data: [{ type: 'ciProducts', id: stableMockId('ci_product', { id }), attributes: { name: 'Mock Xcode Cloud Product', productType: 'APP' } }] };
  if (actionId === 'list_xcode_cloud_workflows') return { data: [{ type: 'ciWorkflows', id: stableMockId('ci_workflow', { product: args.product_id }), attributes: { name: 'CI', isEnabled: true, clean: false } }] };
  if (actionId === 'get_xcode_cloud_workflow') return { data: { type: 'ciWorkflows', id: requiredArg(args, 'workflow_id'), attributes: { name: 'CI', isEnabled: true, branchStartCondition: {} } } };
  if (actionId === 'preview_xcode_cloud_workflow_update' || (actionId === 'update_xcode_cloud_workflow' && args.dry_run === true)) {
    const body = xcodeCloudWorkflowPatch(args);
    return { dryRun: true, request: { method: 'PATCH', path: `/v1/ciWorkflows/${requiredArg(args, 'workflow_id')}`, body }, provider: 'mock' };
  }
  if (actionId === 'update_xcode_cloud_workflow') return { dryRun: false, provider: 'mock', data: xcodeCloudWorkflowPatch(args).data, applied: true };
  if (actionId === 'list_review_submissions') {
    return {
      data: [{
        type: 'reviewSubmissions',
        id: stableMockId('review', { id }),
        attributes: { state: 'READY_FOR_REVIEW', platform: 'IOS', submittedDate: null },
      }],
    };
  }
  if (actionId === 'preview_app_info_localization_update' || (actionId === 'update_app_info_localization' && args.dry_run === true)) {
    return { dryRun: true, request: { method: 'PATCH', path: `/v1/appInfoLocalizations/${stringValue(args.localization_id) ?? ''}`, body: localizationPatch(args) }, provider: 'mock' };
  }
  if (actionId === 'update_app_info_localization') {
    return { dryRun: false, provider: 'mock', data: localizationPatch(args).data, applied: true };
  }
  if (actionId === 'preview_app_store_version_metadata_update' || (actionId === 'update_app_store_version_metadata' && args.dry_run === true)) {
    return { dryRun: true, request: { method: 'PATCH', path: `/v1/appStoreVersionLocalizations/${stringValue(args.localization_id) ?? ''}`, body: versionLocalizationPatch(args) }, provider: 'mock' };
  }
  if (actionId === 'update_app_store_version_metadata') {
    return { dryRun: false, provider: 'mock', data: versionLocalizationPatch(args).data, applied: true };
  }
  if (actionId === 'create_app_store_version') {
    const body = {
      data: {
        type: 'appStoreVersions',
        attributes: {
          platform: stringValue(args.platform) ?? 'IOS',
          versionString: requiredArg(args, 'version_string'),
          copyright: stringValue(args.copyright),
        },
        relationships: { app: { data: { type: 'apps', id } } },
      },
    };
    if (args.dry_run === true) return { dryRun: true, request: { method: 'POST', path: '/v1/appStoreVersions', body }, provider: 'mock' };
    return { dryRun: false, provider: 'mock', data: { ...body.data, id: stableMockId('version', body) }, applied: true };
  }
  if (actionId === 'assign_build_to_beta_group') {
    const buildId = requiredArg(args, 'build_id');
    const betaGroupId = requiredArg(args, 'beta_group_id');
    const body = { data: [{ type: 'builds', id: buildId }] };
    if (args.dry_run === true) {
      return { dryRun: true, request: { method: 'POST', path: `/v1/betaGroups/${betaGroupId}/relationships/builds`, body }, provider: 'mock' };
    }
    return { dryRun: false, provider: 'mock', assigned: true, buildId, betaGroupId };
  }
  if (actionId === 'submit_beta_app_review') {
    const buildId = requiredArg(args, 'build_id');
    const body = { data: { type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: buildId } } } } };
    if (args.dry_run === true) return { dryRun: true, request: { method: 'POST', path: '/v1/betaAppReviewSubmissions', body }, provider: 'mock' };
    return { dryRun: false, provider: 'mock', data: { type: 'betaAppReviewSubmissions', id: stableMockId('beta_review', { buildId }), attributes: { betaReviewState: 'WAITING_FOR_REVIEW' } }, applied: true };
  }
  if (actionId === 'create_review_submission') {
    const body = {
      data: {
        type: 'reviewSubmissions',
        attributes: { platform: stringValue(args.platform) ?? 'IOS' },
        relationships: { app: { data: { type: 'apps', id } } },
      },
    };
    if (args.dry_run === true) return { dryRun: true, request: { method: 'POST', path: '/v1/reviewSubmissions', body }, provider: 'mock' };
    return { dryRun: false, provider: 'mock', data: { ...body.data, id: stableMockId('review', body) }, applied: true };
  }
  if (actionId === 'submit_for_review') {
    const reviewSubmissionId = requiredArg(args, 'review_submission_id');
    const body = { data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: { data: { type: 'reviewSubmissions', id: reviewSubmissionId } } } } };
    if (args.dry_run === true) {
      return {
        dryRun: true,
        request: { method: 'PATCH', path: `/v1/reviewSubmissions/${reviewSubmissionId}`, body: { data: { type: 'reviewSubmissions', id: reviewSubmissionId, attributes: { submitted: true } } } },
        provider: 'mock',
        note: 'Production submit is gated; dry_run never calls Apple.',
      };
    }
    return {
      dryRun: false,
      provider: 'mock',
      data: { type: 'reviewSubmissions', id: reviewSubmissionId, attributes: { state: 'WAITING_FOR_REVIEW', submittedDate: now() } },
      applied: true,
      related: body,
    };
  }
  throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', `app_store_connect/${actionId} is not supported.`, { retryable: false });
}

export function buildAppStoreConnectPluginManifest(previousRevision = 0, previousUpdatedAt?: string, repoRoot?: string, context?: AssistantPluginBuildContext): AssistantPluginManifest {
  const effectiveRepoRoot = repoRoot ?? context?.repoRoot ?? process.cwd();
  const config = loadConfig(effectiveRepoRoot, context?.controllerHome, context?.repoId);
  const auth = resolveAuth(config);
  const state = pluginState(config, auth);
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    revision: Math.max(1, previousRevision || 1),
    pluginId: APP_STORE_CONNECT_PLUGIN_ID,
    provider: 'apple',
    displayName: 'App Store Connect API Plugin',
    pluginVersion: '1.1.1',
    authority: { strategy: 'derived', duplicateStateAllowed: false, sourceOfTruth: ['controller-global:system/plugins/profiles/app-store-connect.json', 'controller-home:repositories/<repoId>/plugins/config/app-store-connect.json', 'legacy-import-only:.forge/plugins|.repo-harness/plugins/app-store-connect.json', 'env:FORGE_ASC_*'] },
    enabled: config.enabled,
    lifecycle: { state: state.lifecycleState, reason: !config.enabled ? 'App Store Connect plugin is disabled.' : auth.ready ? 'App Store Connect API credentials are ready.' : auth.errors[0] ?? auth.warnings[0] },
    health: state.health,
    permissions: permissions(config.enabled && auth.ready),
    capabilities: capabilities(),
    actions: actions(),
    updatedAt: previousUpdatedAt ?? now(),
  };
}

export async function executeAppStoreConnectPluginAction(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  const config = loadConfig(input.repoRoot, input.controllerHome, input.repoId);
  if (input.actionId === 'configure') {
    const args = input.args;
    const next = saveConfig(input.repoRoot, {
      enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
      provider: args.provider === 'app-store-connect-api' ? 'app-store-connect-api' : args.provider === 'mock' ? 'mock' : undefined,
      issuerId: args.clear_api_identity === true ? '' : stringValue(args.issuer_id),
      keyId: args.clear_api_identity === true ? '' : stringValue(args.key_id),
      privateKeyPath: args.clear_private_key_path === true ? '' : stringValue(args.private_key_path),
      teamId: args.clear_team_id === true ? '' : stringValue(args.team_id),
      defaultAppId: args.clear_default_app_id === true ? '' : stringValue(args.default_app_id),
      defaultLocale: stringValue(args.default_locale),
      defaultTimeoutMs: boundedTimeout(args.default_timeout_ms),
    }, input.controllerHome, input.repoId);
    return { config: next, auth: resolveAuth(next) };
  }

  if (config.provider === 'mock') return mockResponse(input.actionId, input.args, config);
  const auth = resolveAuth(config);
  if (input.actionId === 'auth_status') {
    return {
      ready: config.enabled && auth.ready,
      provider: auth.provider,
      issuerId: auth.issuerId ? 'configured' : undefined,
      keyId: auth.keyId ? 'configured' : undefined,
      credentialSource: auth.credentialSource,
      errors: auth.errors,
      warnings: auth.warnings,
      userFacingStatus: userFacingAscStatus(config, auth),
    };
  }
  if (!config.enabled || !auth.ready) throw new AssistantPluginError('PLUGIN_NOT_READY', 'App Store Connect plugin is not ready.', { retryable: false, details: { enabled: config.enabled, errors: auth.errors } });

  switch (input.actionId) {
    case 'list_apps':
      return apiRequest(config, { path: '/v1/apps', query: { 'filter[bundleId]': stringValue(input.args.bundle_id), 'filter[name]': stringValue(input.args.name), limit: limit(input.args.limit) } });
    case 'list_bundle_ids':
      return apiRequest(config, { path: '/v1/bundleIds', query: { 'filter[identifier]': stringValue(input.args.identifier), 'filter[name]': stringValue(input.args.name), limit: limit(input.args.limit) } });
    case 'list_bundle_id_capabilities':
      return apiRequest(config, { path: `/v1/bundleIds/${encodeURIComponent(requiredArg(input.args, 'bundle_id_resource_id'))}/bundleIdCapabilities`, query: { limit: limit(input.args.limit) } });
    case 'list_certificates':
      return apiRequest(config, { path: '/v1/certificates', query: { 'filter[certificateType]': stringValue(input.args.certificate_type), limit: limit(input.args.limit) } });
    case 'list_devices':
      return apiRequest(config, { path: '/v1/devices', query: { 'filter[udid]': stringValue(input.args.udid), limit: limit(input.args.limit) } });
    case 'list_profiles':
      return apiRequest(config, { path: '/v1/profiles', query: { 'filter[name]': stringValue(input.args.name), 'filter[profileType]': stringValue(input.args.profile_type), limit: limit(input.args.limit) } });
    case 'list_app_store_versions':
      return apiRequest(config, { path: '/v1/appStoreVersions', query: { 'filter[app]': appId(input.args, config), limit: limit(input.args.limit) } });
    case 'list_app_store_version_localizations':
      return apiRequest(config, {
        path: `/v1/appStoreVersions/${encodeURIComponent(requiredArg(input.args, 'version_id'))}/appStoreVersionLocalizations`,
        query: { limit: limit(input.args.limit) },
      });
    case 'get_app_info':
    case 'list_app_infos':
      return apiRequest(config, { path: `/v1/apps/${encodeURIComponent(appId(input.args, config))}/appInfos`, query: { include: 'appInfoLocalizations', limit: limit(input.args.limit) } });
    case 'list_builds':
    case 'list_testflight_builds':
      return apiRequest(config, {
        path: '/v1/builds',
        query: {
          'filter[app]': appId(input.args, config),
          limit: limit(input.args.limit),
          'fields[builds]': 'version,uploadedDate,expirationDate,expired,processingState,usesNonExemptEncryption,minOsVersion,iconAssetToken',
        },
      });
    case 'get_build_detail':
      return apiRequest(config, {
        path: `/v1/builds/${encodeURIComponent(requiredArg(input.args, 'build_id'))}`,
        query: {
          'fields[builds]': 'version,uploadedDate,expirationDate,expired,processingState,usesNonExemptEncryption,minOsVersion,iconAssetToken',
          include: 'buildBetaDetail,preReleaseVersion',
        },
      });
    case 'list_beta_groups':
      return apiRequest(config, { path: '/v1/betaGroups', query: { 'filter[app]': appId(input.args, config), limit: limit(input.args.limit) } });
    case 'list_beta_testers':
      return apiRequest(config, { path: '/v1/betaTesters', query: { 'filter[apps]': appId(input.args, config), limit: limit(input.args.limit) } });
    case 'list_review_submissions':
      return apiRequest(config, { path: '/v1/reviewSubmissions', query: { 'filter[app]': appId(input.args, config), limit: limit(input.args.limit) } });
    case 'list_xcode_cloud_products':
      return apiRequest(config, { path: '/v1/ciProducts', query: { 'filter[app]': stringValue(input.args.app_id), limit: limit(input.args.limit) } });
    case 'list_xcode_cloud_workflows':
      return apiRequest(config, { path: `/v1/ciProducts/${encodeURIComponent(requiredArg(input.args, 'product_id'))}/workflows`, query: { limit: limit(input.args.limit), 'fields[ciWorkflows]': 'name,description,branchStartCondition,tagStartCondition,pullRequestStartCondition,scheduledStartCondition,manualBranchStartCondition,manualTagStartCondition,manualPullRequestStartCondition,actions,isEnabled,isLockedForEditing,clean,containerFilePath,lastModifiedDate' } });
    case 'get_xcode_cloud_workflow':
      return apiRequest(config, { path: `/v1/ciWorkflows/${encodeURIComponent(requiredArg(input.args, 'workflow_id'))}`, query: { 'fields[ciWorkflows]': 'name,description,branchStartCondition,tagStartCondition,pullRequestStartCondition,scheduledStartCondition,manualBranchStartCondition,manualTagStartCondition,manualPullRequestStartCondition,actions,isEnabled,isLockedForEditing,clean,containerFilePath,lastModifiedDate,product,repository,xcodeVersion,macOsVersion', include: 'product,repository,xcodeVersion,macOsVersion' } });
    case 'preview_xcode_cloud_workflow_update': {
      const body = xcodeCloudWorkflowPatch(input.args);
      return { dryRun: true, request: { method: 'PATCH', path: `/v1/ciWorkflows/${requiredArg(input.args, 'workflow_id')}`, body } };
    }
    case 'update_xcode_cloud_workflow': {
      const workflowId = requiredArg(input.args, 'workflow_id');
      const body = xcodeCloudWorkflowPatch(input.args);
      if (input.args.dry_run === true) return { dryRun: true, request: { method: 'PATCH', path: `/v1/ciWorkflows/${workflowId}`, body } };
      return apiRequest(config, { path: `/v1/ciWorkflows/${encodeURIComponent(workflowId)}`, method: 'PATCH', body });
    }
    case 'preview_app_info_localization_update':
      return { dryRun: true, request: { method: 'PATCH', path: `/v1/appInfoLocalizations/${stringValue(input.args.localization_id) ?? ''}`, body: localizationPatch(input.args) } };
    case 'update_app_info_localization': {
      const body = localizationPatch(input.args);
      const localizationId = stringValue(input.args.localization_id) ?? '';
      if (input.args.dry_run === true) return { dryRun: true, request: { method: 'PATCH', path: `/v1/appInfoLocalizations/${localizationId}`, body } };
      return apiRequest(config, { path: `/v1/appInfoLocalizations/${encodeURIComponent(localizationId)}`, method: 'PATCH', body });
    }
    case 'preview_app_store_version_metadata_update':
      return { dryRun: true, request: { method: 'PATCH', path: `/v1/appStoreVersionLocalizations/${stringValue(input.args.localization_id) ?? ''}`, body: versionLocalizationPatch(input.args) } };
    case 'update_app_store_version_metadata': {
      const body = versionLocalizationPatch(input.args);
      const localizationId = stringValue(input.args.localization_id) ?? '';
      if (input.args.dry_run === true) return { dryRun: true, request: { method: 'PATCH', path: `/v1/appStoreVersionLocalizations/${localizationId}`, body } };
      return apiRequest(config, { path: `/v1/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}`, method: 'PATCH', body });
    }
    case 'create_app_store_version': {
      const body = {
        data: {
          type: 'appStoreVersions',
          attributes: {
            platform: stringValue(input.args.platform) ?? 'IOS',
            versionString: requiredArg(input.args, 'version_string'),
            copyright: stringValue(input.args.copyright),
          },
          relationships: { app: { data: { type: 'apps', id: appId(input.args, config) } } },
        },
      };
      if (input.args.dry_run === true) return { dryRun: true, request: { method: 'POST', path: '/v1/appStoreVersions', body } };
      return apiRequest(config, { path: '/v1/appStoreVersions', method: 'POST', body });
    }
    case 'assign_build_to_beta_group': {
      const buildId = requiredArg(input.args, 'build_id');
      const betaGroupId = requiredArg(input.args, 'beta_group_id');
      const body = { data: [{ type: 'builds', id: buildId }] };
      if (input.args.dry_run === true) {
        return { dryRun: true, request: { method: 'POST', path: `/v1/betaGroups/${betaGroupId}/relationships/builds`, body } };
      }
      return apiRequest(config, { path: `/v1/betaGroups/${encodeURIComponent(betaGroupId)}/relationships/builds`, method: 'POST', body });
    }
    case 'submit_beta_app_review': {
      const buildId = requiredArg(input.args, 'build_id');
      const body = {
        data: {
          type: 'betaAppReviewSubmissions',
          relationships: { build: { data: { type: 'builds', id: buildId } } },
        },
      };
      if (input.args.dry_run === true) return { dryRun: true, request: { method: 'POST', path: '/v1/betaAppReviewSubmissions', body } };
      return apiRequest(config, { path: '/v1/betaAppReviewSubmissions', method: 'POST', body });
    }
    case 'create_review_submission': {
      const body = {
        data: {
          type: 'reviewSubmissions',
          attributes: { platform: stringValue(input.args.platform) ?? 'IOS' },
          relationships: { app: { data: { type: 'apps', id: appId(input.args, config) } } },
        },
      };
      if (input.args.dry_run === true) return { dryRun: true, request: { method: 'POST', path: '/v1/reviewSubmissions', body } };
      return apiRequest(config, { path: '/v1/reviewSubmissions', method: 'POST', body });
    }
    case 'submit_for_review': {
      const reviewSubmissionId = requiredArg(input.args, 'review_submission_id');
      const body = {
        data: {
          type: 'reviewSubmissions',
          id: reviewSubmissionId,
          attributes: { submitted: true },
        },
      };
      if (input.args.dry_run === true) {
        return { dryRun: true, request: { method: 'PATCH', path: `/v1/reviewSubmissions/${reviewSubmissionId}`, body } };
      }
      return apiRequest(config, { path: `/v1/reviewSubmissions/${encodeURIComponent(reviewSubmissionId)}`, method: 'PATCH', body });
    }
    default:
      throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', `app_store_connect/${input.actionId} is not supported.`, { retryable: false });
  }
}

export const appStoreConnectPluginAdapter = {
  pluginId: APP_STORE_CONNECT_PLUGIN_ID,
  scope: 'controller_with_repository_overlay' as const,
  buildManifest: buildAppStoreConnectPluginManifest,
  executeAction: executeAppStoreConnectPluginAction,
};
