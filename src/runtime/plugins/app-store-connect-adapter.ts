import { createHash, createPrivateKey, sign } from 'crypto';
import { gunzipSync } from 'zlib';
import { accessSync, constants as fsConstants, existsSync, promises as fsPromises, readFileSync, statSync } from 'fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'path';
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
import { readControllerPluginConfig, writeControllerPluginConfig } from './config-store';
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

function loadConfig(_repoRoot: string, controllerHome?: string, _repoId?: string): AppStoreConnectPluginConfig {
  const persisted = controllerHome ? readControllerPluginConfig<Partial<AppStoreConnectPluginConfig>>(controllerHome, APP_STORE_CONNECT_PLUGIN_ID) : undefined;
  return normalizeConfig(persisted ?? {});
}

function definedPatch(patch: Partial<AppStoreConnectPluginConfig>): Partial<AppStoreConnectPluginConfig> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<AppStoreConnectPluginConfig>;
}

function saveConfig(
  _repoRoot: string,
  patch: Partial<AppStoreConnectPluginConfig>,
  controllerHome?: string,
  _repoId?: string,
): AppStoreConnectPluginConfig {
  if (!controllerHome) throw new Error('APP_STORE_CONNECT_CONTROLLER_CONTEXT_REQUIRED');
  const next = normalizeConfig({ ...readControllerPluginConfig<Partial<AppStoreConnectPluginConfig>>(controllerHome, APP_STORE_CONNECT_PLUGIN_ID), ...definedPatch(patch) });
  return writeControllerPluginConfig(controllerHome, APP_STORE_CONNECT_PLUGIN_ID, next);
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
          'PLUGIN_AUTH_REQUIRED',
          'Configured App Store Connect private key is not locally available. Keep File Provider/iCloud credentials downloaded or configure a stable local private_key_path.',
          { retryable: false, details: { credentialSource: source, code, localCredentialUnavailable: true } },
        );
      }
      throw new AssistantPluginError(
        'PLUGIN_AUTH_REQUIRED',
        'Configured App Store Connect private key could not be read.',
        { retryable: false, details: { credentialSource: source, code } },
      );
    }
  }
  throw new AssistantPluginError(
    'PLUGIN_AUTH_REQUIRED',
    'Configured App Store Connect private key is not locally available.',
    { retryable: false, details: { credentialSource: source, localCredentialUnavailable: true } },
  );
}

async function privateKeyMaterial(config: AppStoreConnectPluginConfig): Promise<{ key?: string; source?: string; warning?: string }> {
  const inline = envValue('FORGE_ASC_PRIVATE_KEY');
  if (inline) return { key: inline.replace(/\\n/g, '\n'), source: 'env:FORGE_ASC_PRIVATE_KEY' };
  const envKeyPath = envValue('FORGE_ASC_PRIVATE_KEY_PATH');
  if (envKeyPath) return readPrivateKeyFile(envKeyPath, 'env:FORGE_ASC_PRIVATE_KEY_PATH');
  if (config.privateKeyPath) return readPrivateKeyFile(config.privateKeyPath, 'config:privateKeyPath');
  return {};
}

async function resolveLiveAuthStatus(config: AppStoreConnectPluginConfig): Promise<AppStoreConnectAuthState> {
  const auth = resolveAuth(config);
  if (config.provider !== 'app-store-connect-api' || !config.enabled || !auth.ready) return auth;
  try {
    const material = await privateKeyMaterial(config);
    if (material.key) return auth;
    const detail = material.warning ?? 'Configured App Store Connect private key is not locally readable.';
    return { ...auth, ready: false, authenticated: false, errors: [...auth.errors, detail] };
  } catch (error) {
    if (error instanceof AssistantPluginError && error.code === 'PLUGIN_AUTH_REQUIRED') {
      const detail = error.message.replace(/^PLUGIN_AUTH_REQUIRED:\s*/, '');
      return { ...auth, ready: false, authenticated: false, errors: [...auth.errors, detail] };
    }
    throw error;
  }
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
    permission('appstoreconnect.screenshots.write', 'write', 'Upload and order App Store screenshots in verified app/version/locale/device sets.', ready),
    permission('appstoreconnect.testflight.write', 'write', 'Assign builds to TestFlight groups and prepare beta review submissions.', ready),
    permission('appstoreconnect.release.write', 'write', 'Create App Store versions and gated review submissions.', ready),
    permission('appstoreconnect.xcodecloud.read', 'read', 'Read Xcode Cloud products and workflow configuration.', ready),
    permission('appstoreconnect.xcodecloud.write', 'write', 'Update Xcode Cloud workflow configuration after dry-run review and strong confirmation.', ready),
    permission('appstoreconnect.analytics.read', 'read', 'Read first-party Analytics, search keywords and ASO measurements.', ready),
    permission('appstoreconnect.analytics.write', 'write', 'Request Apple Analytics reports.', ready),
    permission('appstoreconnect.commerce.read', 'read', 'Read In-App Purchases and subscriptions.', ready),
    permission('appstoreconnect.commerce.write', 'write', 'Manage In-App Purchases.', ready),
    permission('appstoreconnect.reviews.read', 'read', 'Read customer reviews and summaries.', ready),
    permission('appstoreconnect.reviews.write', 'write', 'Reply to customer reviews.', ready),
    permission('appstoreconnect.reports.read', 'read', 'Download Apple Sales and Finance gzip reports.', ready),
  ];
}


// Apple API resources remain the authority. These fixed paths only expose typed, bounded reads;
// callers cannot supply an arbitrary URL, method, or API path.
interface AscReadSpec {
  id: string; title: string; scope: string; path: string; required: string[];
  filters?: Record<string, string>; fixedQuery?: Record<string, string>;
}
const additionalAscReads: AscReadSpec[] = [
  { id: 'get_app_store_version', title: 'Read App Store version', scope: 'appstoreconnect.apps.read', path: '/v1/appStoreVersions/:version_id', required: ['version_id'], fixedQuery: { include: 'build,app,appStoreReviewDetail' }, },
  { id: 'get_app_store_version_build', title: 'Read App Store version build', scope: 'appstoreconnect.apps.read', path: '/v1/appStoreVersions/:version_id/build', required: ['version_id'], },
  { id: 'get_review_submission', title: 'Read review submission', scope: 'appstoreconnect.apps.read', path: '/v1/reviewSubmissions/:review_submission_id', required: ['review_submission_id'], },
  { id: 'list_review_submission_items', title: 'List review submission items', scope: 'appstoreconnect.apps.read', path: '/v1/reviewSubmissions/:review_submission_id/items', required: ['review_submission_id'], },
  { id: 'get_app_store_review_detail', title: 'Read App Review details', scope: 'appstoreconnect.apps.read', path: '/v1/appStoreVersions/:version_id/appStoreReviewDetail', required: ['version_id'], },
  { id: 'list_search_keywords', title: 'List configured App Store keywords', scope: 'appstoreconnect.analytics.read', path: '/v1/apps/:app_id/searchKeywords', required: [], filters: { 'locale': 'filter[locale]', 'platform': 'filter[platform]' }, },
  { id: 'list_analytics_report_requests', title: 'List Analytics report requests', scope: 'appstoreconnect.analytics.read', path: '/v1/apps/:app_id/analyticsReportRequests', required: [], },
  { id: 'get_analytics_report_request', title: 'Read Analytics request', scope: 'appstoreconnect.analytics.read', path: '/v1/analyticsReportRequests/:report_request_id', required: ['report_request_id'], },
  { id: 'list_analytics_reports', title: 'List Analytics reports', scope: 'appstoreconnect.analytics.read', path: '/v1/analyticsReportRequests/:report_request_id/reports', required: ['report_request_id'], filters: { 'category': 'filter[category]' }, },
  { id: 'list_analytics_report_instances', title: 'List report periods', scope: 'appstoreconnect.analytics.read', path: '/v1/analyticsReports/:report_id/instances', required: ['report_id'], filters: { 'granularity': 'filter[granularity]', 'processing_date': 'filter[processingDate]' }, },
  { id: 'list_analytics_report_segments', title: 'List downloadable report segments', scope: 'appstoreconnect.analytics.read', path: '/v1/analyticsReportInstances/:instance_id/segments', required: ['instance_id'], },
  { id: 'get_analytics_report_segment', title: 'Get report segment URL and checksum', scope: 'appstoreconnect.analytics.read', path: '/v1/analyticsReportSegments/:segment_id', required: ['segment_id'], },
  { id: 'list_customer_reviews', title: 'List customer reviews', scope: 'appstoreconnect.reviews.read', path: '/v1/apps/:app_id/customerReviews', required: [], filters: { 'rating': 'filter[rating]', 'territory': 'filter[territory]' }, },
  { id: 'get_customer_review', title: 'Read customer review', scope: 'appstoreconnect.reviews.read', path: '/v1/customerReviews/:review_id', required: ['review_id'], },
  { id: 'list_customer_review_summaries', title: 'Read Apple review summaries', scope: 'appstoreconnect.reviews.read', path: '/v1/apps/:app_id/customerReviewSummarizations', required: ['platform'], filters: { 'platform': 'filter[platform]', 'territory': 'filter[territory]' }, },
  { id: 'list_in_app_purchases', title: 'List in-app purchases v2', scope: 'appstoreconnect.commerce.read', path: '/v1/apps/:app_id/inAppPurchasesV2', required: [], },
  { id: 'get_in_app_purchase', title: 'Read in-app purchase v2', scope: 'appstoreconnect.commerce.read', path: '/v2/inAppPurchases/:purchase_id', required: ['purchase_id'], },
  { id: 'list_in_app_purchase_versions', title: 'List in-app purchase versions', scope: 'appstoreconnect.commerce.read', path: '/v2/inAppPurchases/:purchase_id/versions', required: ['purchase_id'], },
  { id: 'list_subscription_groups', title: 'List subscription groups', scope: 'appstoreconnect.commerce.read', path: '/v1/apps/:app_id/subscriptionGroups', required: [], },
  { id: 'list_subscriptions', title: 'List subscriptions in a group', scope: 'appstoreconnect.commerce.read', path: '/v1/subscriptionGroups/:group_id/subscriptions', required: ['group_id'], },
  { id: 'get_subscription', title: 'Read subscription', scope: 'appstoreconnect.commerce.read', path: '/v1/subscriptions/:subscription_id', required: ['subscription_id'], },
  { id: 'get_in_app_purchase_version', title: 'Read IAP metadata version', scope: 'appstoreconnect.commerce.read', path: '/v1/inAppPurchaseVersions/:version_id', required: ['version_id'],  },
  { id: 'list_in_app_purchase_version_localizations', title: 'List IAP version localizations', scope: 'appstoreconnect.commerce.read', path: '/v1/inAppPurchaseVersions/:version_id/localizations', required: ['version_id'],  },
  { id: 'get_in_app_purchase_localization', title: 'Read IAP v2 localization', scope: 'appstoreconnect.commerce.read', path: '/v2/inAppPurchaseLocalizations/:localization_id', required: ['localization_id'],  },
  { id: 'get_in_app_purchase_price_schedule', title: 'Read IAP price schedule', scope: 'appstoreconnect.commerce.read', path: '/v2/inAppPurchases/:purchase_id/iapPriceSchedule', required: ['purchase_id'],  },
  { id: 'list_in_app_purchase_price_points', title: 'List IAP price points', scope: 'appstoreconnect.commerce.read', path: '/v2/inAppPurchases/:purchase_id/pricePoints', required: ['purchase_id'], filters: {'territory':'filter[territory]'},  },
  { id: 'get_in_app_purchase_price_point', title: 'Read IAP price point', scope: 'appstoreconnect.commerce.read', path: '/v1/inAppPurchasePricePoints/:price_point_id', required: ['price_point_id'],  },
  { id: 'get_in_app_purchase_price_schedule_resource', title: 'Read IAP price schedule resource', scope: 'appstoreconnect.commerce.read', path: '/v1/inAppPurchasePriceSchedules/:schedule_id', required: ['schedule_id'],  },
  { id: 'list_in_app_purchase_manual_prices', title: 'Read scheduled manual IAP prices', scope: 'appstoreconnect.commerce.read', path: '/v1/inAppPurchasePriceSchedules/:schedule_id/manualPrices', required: ['schedule_id'], filters: {'territory':'filter[territory]'},  },
  { id: 'list_in_app_purchase_automatic_prices', title: 'Read scheduled automatic IAP prices', scope: 'appstoreconnect.commerce.read', path: '/v1/inAppPurchasePriceSchedules/:schedule_id/automaticPrices', required: ['schedule_id'], filters: {'territory':'filter[territory]'},  },
  { id: 'get_subscription_group', title: 'Read subscription group', scope: 'appstoreconnect.commerce.read', path: '/v1/subscriptionGroups/:group_id', required: ['group_id'],  },
  { id: 'list_subscription_group_versions', title: 'List subscription group metadata versions', scope: 'appstoreconnect.commerce.read', path: '/v1/subscriptionGroups/:group_id/versions', required: ['group_id'],  },
  { id: 'get_subscription_group_version', title: 'Read subscription group version', scope: 'appstoreconnect.commerce.read', path: '/v1/subscriptionGroupVersions/:version_id', required: ['version_id'],  },
  { id: 'list_subscription_group_version_localizations', title: 'List subscription group version localizations', scope: 'appstoreconnect.commerce.read', path: '/v1/subscriptionGroupVersions/:version_id/localizations', required: ['version_id'],  },
  { id: 'list_subscription_versions', title: 'List subscription metadata versions', scope: 'appstoreconnect.commerce.read', path: '/v1/subscriptions/:subscription_id/versions', required: ['subscription_id'], filters: {'state':'filter[state]'},  },
  { id: 'get_subscription_version', title: 'Read subscription metadata version', scope: 'appstoreconnect.commerce.read', path: '/v1/subscriptionVersions/:version_id', required: ['version_id'],  },
  { id: 'list_subscription_version_localizations', title: 'List subscription version localizations', scope: 'appstoreconnect.commerce.read', path: '/v1/subscriptionVersions/:version_id/localizations', required: ['version_id'],  },
  { id: 'list_subscription_version_images', title: 'List subscription version images', scope: 'appstoreconnect.commerce.read', path: '/v1/subscriptionVersions/:version_id/images', required: ['version_id'],  },
  { id: 'get_subscription_localization', title: 'Read subscription v2 localization', scope: 'appstoreconnect.commerce.read', path: '/v2/subscriptionLocalizations/:localization_id', required: ['localization_id'],  },
  { id: 'list_subscription_prices', title: 'List subscription scheduled prices', scope: 'appstoreconnect.commerce.read', path: '/v1/subscriptions/:subscription_id/prices', required: ['subscription_id'], filters: {'territory':'filter[territory]','plan_type':'filter[planType]'},  },
  { id: 'list_subscription_price_points', title: 'List subscription price points', scope: 'appstoreconnect.commerce.read', path: '/v1/subscriptions/:subscription_id/pricePoints', required: ['subscription_id', 'territory'], filters: {'territory':'filter[territory]'},  },
  { id: 'get_subscription_price', title: 'Read subscription price', scope: 'appstoreconnect.commerce.read', path: '/v1/subscriptionPrices/:price_id', required: ['price_id'],  },
  { id: 'get_subscription_price_point', title: 'Read subscription price point', scope: 'appstoreconnect.commerce.read', path: '/v1/subscriptionPricePoints/:point_id', required: ['point_id'],  },
  { id: 'list_subscription_introductory_offers', title: 'List subscription introductory offers', scope: 'appstoreconnect.commerce.read', path: '/v1/subscriptions/:subscription_id/introductoryOffers', required: ['subscription_id'],  },
  { id: 'list_subscription_offer_codes', title: 'List subscription offer codes', scope: 'appstoreconnect.commerce.read', path: '/v1/subscriptions/:subscription_id/offerCodes', required: ['subscription_id'],  },
  { id: 'list_subscription_promotional_offers', title: 'List subscription promotional offers', scope: 'appstoreconnect.commerce.read', path: '/v1/subscriptions/:subscription_id/promotionalOffers', required: ['subscription_id'],  },
  { id: 'get_subscription_availability', title: 'Read subscription territory availability', scope: 'appstoreconnect.commerce.read', path: '/v1/subscriptions/:subscription_id/subscriptionAvailability', required: ['subscription_id'],  },
  { id: 'get_app_price_schedule', title: 'Read app price schedule', scope: 'appstoreconnect.commerce.read', path: '/v1/apps/:app_id/appPriceSchedule', required: [],  },
  { id: 'list_app_price_points', title: 'List app price points', scope: 'appstoreconnect.commerce.read', path: '/v1/apps/:app_id/appPricePoints', required: [], filters: {'territory':'filter[territory]'},  },
  { id: 'get_app_availability', title: 'Read app territory availability', scope: 'appstoreconnect.apps.read', path: '/v1/apps/:app_id/appAvailabilityV2', required: [],  },
  { id: 'list_app_store_version_experiments', title: 'List App Store product page experiments', scope: 'appstoreconnect.analytics.read', path: '/v1/appStoreVersions/:version_id/appStoreVersionExperiments', required: ['version_id'],  },
  { id: 'list_beta_feedback_crash_submissions', title: 'List beta crash feedback', scope: 'appstoreconnect.apps.read', path: '/v1/apps/:app_id/betaFeedbackCrashSubmissions', required: [],  },
  { id: 'list_beta_feedback_screenshot_submissions', title: 'List beta screenshots feedback', scope: 'appstoreconnect.apps.read', path: '/v1/apps/:app_id/betaFeedbackScreenshotSubmissions', required: [],  },
  { id: 'list_prerelease_versions', title: 'List pre-release TestFlight versions', scope: 'appstoreconnect.apps.read', path: '/v1/apps/:app_id/preReleaseVersions', required: [],  },
  { id: 'list_beta_app_localizations', title: 'List TestFlight app localizations', scope: 'appstoreconnect.apps.read', path: '/v1/apps/:app_id/betaAppLocalizations', required: [],  },
  { id: 'get_app_asset_library', title: 'Read Apple App Asset Library for app', scope: 'appstoreconnect.apps.read', path: '/v1/apps/:app_id/assetLibrary', required: [] },
  { id: 'list_app_asset_library_reference_data', title: 'List App Asset Library size and format specifications', scope: 'appstoreconnect.apps.read', path: '/v1/appAssetLibraryRefData', required: [] },
  { id: 'get_app_asset_library_image', title: 'Read App Asset Library image processing state', scope: 'appstoreconnect.apps.read', path: '/v1/appAssetLibraryImages/:asset_id', required: ['asset_id'] },
  { id: 'get_app_asset_library_video', title: 'Read App Asset Library video processing state', scope: 'appstoreconnect.apps.read', path: '/v1/appAssetLibraryVideos/:asset_id', required: ['asset_id'] },
  { id: 'list_app_asset_library_image_placements', title: 'List App Asset Library image placements', scope: 'appstoreconnect.apps.read', path: '/v1/appAssetLibraryImages/:asset_id/placements', required: ['asset_id'] },
  { id: 'list_app_asset_library_images', title: 'List App Store asset library images', scope: 'appstoreconnect.apps.read', path: '/v1/appAssetLibraries/:library_id/images', required: ['library_id'],  },
  { id: 'list_app_asset_library_videos', title: 'List App Store asset library videos', scope: 'appstoreconnect.apps.read', path: '/v1/appAssetLibraries/:library_id/videos', required: ['library_id'],  },
  { id: 'list_build_uploads', title: 'List Build Upload resources', scope: 'appstoreconnect.apps.read', path: '/v1/apps/:app_id/buildUploads', required: [], },
  { id: 'list_xcode_cloud_build_runs', title: 'List Xcode Cloud build runs', scope: 'appstoreconnect.xcodecloud.read', path: '/v1/ciWorkflows/:workflow_id/buildRuns', required: ['workflow_id'], },
  { id: 'list_custom_product_pages', title: 'List custom product pages', scope: 'appstoreconnect.analytics.read', path: '/v1/apps/:app_id/appCustomProductPages', required: [], },
  { id: 'list_in_app_events', title: 'List in-app events', scope: 'appstoreconnect.analytics.read', path: '/v1/apps/:app_id/appEvents', required: [], },
];

function additionalAscActions(): AssistantPluginActionDescriptor[] {
  const reads = additionalAscReads.map((spec): AssistantPluginActionDescriptor => {
    const properties: Record<string, { type: 'string' | 'number' }> = {};
    for (const key of new Set([...spec.required, ...Array.from(spec.path.matchAll(/:([a-z_]+)/g), (m) => m[1]!), ...Object.keys(spec.filters ?? {})])) {
      if (key !== 'app_id') properties[key] = { type: 'string' };
    }
    if (spec.path.includes(':app_id')) properties.app_id = { type: 'string' };
    properties.limit = { type: 'number' };
    if (!spec.id.startsWith('get_')) properties.cursor = { type: 'string' };
    return {
      actionId: spec.id, title: spec.title, description: spec.title + ' through the official App Store Connect API.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000,
      cancellable: true, idempotent: true, scopes: [spec.scope],
      resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: { type: 'object', properties, required: spec.required, additionalProperties: false },
    };
  });
  const writes: Array<{ id: string; title: string; scope: string; fields: string[]; required: string[]; confirmation: 'authorization' | 'strong_confirmation' }> = [
    { id: 'set_app_store_version_build', title: 'Associate processed build with App Store version', scope: 'appstoreconnect.release.write', fields: ['version_id','build_id'], required: ['version_id','build_id'], confirmation: 'strong_confirmation' },
    { id: 'add_review_submission_item', title: 'Add version or purchase version to review submission', scope: 'appstoreconnect.release.write', fields: ['review_submission_id','item_type','item_id'], required: ['review_submission_id','item_type','item_id'], confirmation: 'strong_confirmation' },
    { id: 'update_app_store_review_detail', title: 'Update App Review contact and notes', scope: 'appstoreconnect.metadata.write', fields: ['review_detail_id','contact_first_name','contact_last_name','contact_phone','contact_email','notes','demo_account_required'], required: ['review_detail_id'], confirmation: 'authorization' },
    { id: 'request_analytics_report', title: 'Request historical snapshot or ongoing Analytics reports', scope: 'appstoreconnect.analytics.write', fields: ['app_id','access_type'], required: ['access_type'], confirmation: 'authorization' },
    { id: 'create_in_app_purchase', title: 'Create in-app purchase v2', scope: 'appstoreconnect.commerce.write', fields: ['app_id','name','product_id','purchase_type'], required: ['name','product_id','purchase_type'], confirmation: 'strong_confirmation' },
    { id: 'update_in_app_purchase', title: 'Update in-app purchase v2', scope: 'appstoreconnect.commerce.write', fields: ['purchase_id','name','review_note','family_sharable'], required: ['purchase_id'], confirmation: 'authorization' },
    { id: 'create_customer_review_response', title: 'Respond to customer review', scope: 'appstoreconnect.reviews.write', fields: ['review_id','response_body'], required: ['review_id','response_body'], confirmation: 'strong_confirmation' },
    { id: 'create_in_app_purchase_version', title: 'Create versioned IAP review metadata draft', scope: 'appstoreconnect.commerce.write', fields: ['purchase_id'], required: ['purchase_id'], confirmation: 'strong_confirmation' },
    { id: 'create_in_app_purchase_version_localization', title: 'Create IAP version localization v2', scope: 'appstoreconnect.commerce.write', fields: ['version_id','locale','name','description'], required: ['version_id','locale','name'], confirmation: 'authorization' },
    { id: 'update_in_app_purchase_version_localization', title: 'Update IAP localization v2', scope: 'appstoreconnect.commerce.write', fields: ['localization_id','name','description'], required: ['localization_id'], confirmation: 'authorization' },
    { id: 'create_subscription_group', title: 'Create subscription group', scope: 'appstoreconnect.commerce.write', fields: ['app_id','reference_name'], required: ['reference_name'], confirmation: 'strong_confirmation' },
    { id: 'create_subscription', title: 'Create auto-renewable subscription', scope: 'appstoreconnect.commerce.write', fields: ['group_id','name','product_id','subscription_period','family_sharable'], required: ['group_id','name','product_id','subscription_period'], confirmation: 'strong_confirmation' },
    { id: 'create_subscription_version', title: 'Create subscription metadata version', scope: 'appstoreconnect.commerce.write', fields: ['subscription_id'], required: ['subscription_id'], confirmation: 'strong_confirmation' },
    { id: 'create_subscription_version_localization', title: 'Create subscription version localization v2', scope: 'appstoreconnect.commerce.write', fields: ['version_id','locale','name','description'], required: ['version_id','locale','name'], confirmation: 'authorization' },
    { id: 'create_subscription_group_version', title: 'Create subscription group metadata version', scope: 'appstoreconnect.commerce.write', fields: ['group_id'], required: ['group_id'], confirmation: 'strong_confirmation' },
    { id: 'create_subscription_group_version_localization', title: 'Create subscription group localization v2', scope: 'appstoreconnect.commerce.write', fields: ['version_id','locale','name','custom_app_name'], required: ['version_id','locale','name'], confirmation: 'authorization' },
    { id: 'create_in_app_purchase_price_schedule', title: 'Create or change IAP base-territory price schedule', scope: 'appstoreconnect.commerce.write', fields: ['purchase_id','price_point_id','base_territory','start_date'], required: ['purchase_id','price_point_id','base_territory'], confirmation: 'strong_confirmation' },
    { id: 'create_subscription_price', title: 'Set or schedule a subscription price in one territory', scope: 'appstoreconnect.commerce.write', fields: ['subscription_id','price_point_id','start_date','plan_type'], required: ['subscription_id','price_point_id'], confirmation: 'strong_confirmation' },
  ];
  const reports: AssistantPluginActionDescriptor[] = [
    { actionId: 'check_release_readiness', title: 'Inspect App Store release prerequisites', description: 'Read Apple-owned build, localized metadata and review details without submitting. Returns candidate/unverified, never guarantees Apple acceptance.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 90_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: [{ resource:'remote', mode:'read' }], argumentsSchema: { type:'object',properties:{version_id:{type:'string'},app_id:{type:'string'}},required:['version_id'],additionalProperties:false } },
    { actionId: 'read_analytics_segment_data', title: 'Read Analytics data segment', description: 'Download and verify a signed Apple Analytics TSV segment.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.analytics.read'], resourceClaims: [{resource:'remote',mode:'read'}], argumentsSchema: {type:'object',properties:{segment_id:{type:'string'},max_rows:{type:'number'}},required:['segment_id'],additionalProperties:false} },
    ...['sales', 'finance'].map((kind): AssistantPluginActionDescriptor => ({ actionId: 'read_' + kind + '_report', title: 'Read Apple ' + kind + ' report', description: 'Download and decode a bounded Apple gzip report.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.reports.read'], resourceClaims: [{resource:'remote',mode:'read'}], argumentsSchema: {type:'object',properties:{vendor_number:{type:'string'},report_date:{type:'string'},region_code:{type:'string'},frequency:{type:'string'},report_type:{type:'string'},report_sub_type:{type:'string'},version:{type:'string'},max_rows:{type:'number'}},required:kind==='finance'?['vendor_number','report_date','region_code']:['vendor_number','report_date'],additionalProperties:false} })),
  ];
  return [...reads, ...reports, ...writes.map((spec): AssistantPluginActionDescriptor => {
    const properties: Record<string, unknown> = { dry_run: { type: 'boolean' } };
    for (const field of spec.fields) properties[field] = { type: field === 'demo_account_required' || field === 'family_sharable' ? 'boolean' : 'string' };
    return {
      actionId: spec.id, title: spec.title, description: spec.title + '. Review dry_run before applying.',
      readOnly: false, risk: 'remote_write', confirmation: spec.confirmation,
      ...(spec.confirmation === 'strong_confirmation' ? { requiredConfirmationText: spec.id.replaceAll('_', '-') } : {}),
      defaultTimeoutMs: 60_000, cancellable: true, idempotent: false, scopes: [spec.scope],
      resourceClaims: [{ resource: 'remote', mode: 'exclusive' }],
      argumentsSchema: { type: 'object', properties, required: spec.required, additionalProperties: false },
    };
  })];
}

function additionalAscReadRequest(spec: AscReadSpec, args: Record<string, unknown>, config: AppStoreConnectPluginConfig) {
  for (const required of spec.required) requiredArg(args, required);
  const path = spec.path.replace(/:([a-z_]+)/g, (_match, key: string) =>
    encodeURIComponent(key === 'app_id' ? appId(args, config) : requiredArg(args, key)));
  const query: Record<string, string | number | undefined> = { ...spec.fixedQuery };
  for (const [arg, parameter] of Object.entries(spec.filters ?? {})) query[parameter] = stringValue(args[arg]);
  if (!spec.id.startsWith('get_')) {
    query.limit = limit(args.limit);
    if (args.cursor !== undefined) query.cursor = requiredArg(args, 'cursor');
  }
  return { path, query };
}

function additionalAscWriteRequest(actionId: string, args: Record<string, unknown>, config: AppStoreConnectPluginConfig):
  { path: string; method: 'POST' | 'PATCH'; body: unknown } | undefined {
  const resource = (type: string, id: string) => ({ data: { type, id } });

  if (actionId === 'create_in_app_purchase_version')
    return { method: 'POST', path: '/v1/inAppPurchaseVersions', body: { data: {
      type: 'inAppPurchaseVersions', relationships: { inAppPurchase: resource('inAppPurchases', requiredArg(args, 'purchase_id')) },
    } } };
  if (actionId === 'create_in_app_purchase_version_localization' || actionId === 'update_in_app_purchase_version_localization') {
    const update = actionId.startsWith('update_');
    const id = update ? requiredArg(args, 'localization_id') : undefined;
    const attrs: Record<string, unknown> = {};
    for (const key of ['locale','name','description']) if (args[key] !== undefined && (!update || key !== 'locale')) attrs[key] = args[key];
    if (update && Object.keys(attrs).length === 0)
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'No localization fields to update.', { retryable: false });
    return {
      method: update ? 'PATCH' : 'POST', path: update ? '/v2/inAppPurchaseLocalizations/' + encodeURIComponent(id!) : '/v2/inAppPurchaseLocalizations',
      body: { data: { type: 'inAppPurchaseLocalizations', ...(id ? {id} : {}), attributes: attrs,
        ...(update ? {} : { relationships: { version: resource('inAppPurchaseVersions', requiredArg(args, 'version_id')) } }) } },
    };
  }
  if (actionId === 'create_subscription_group')
    return { method: 'POST', path: '/v1/subscriptionGroups', body: { data: {
      type: 'subscriptionGroups', attributes: { referenceName: requiredArg(args, 'reference_name') },
      relationships: { app: resource('apps', appId(args, config)) },
    } } };
  if (actionId === 'create_subscription') {
    const period = requiredArg(args, 'subscription_period');
    if (!['ONE_WEEK','ONE_MONTH','TWO_MONTHS','THREE_MONTHS','SIX_MONTHS','ONE_YEAR'].includes(period))
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Invalid subscription period.', { retryable: false });
    const attrs: Record<string, unknown> = { name: requiredArg(args, 'name'),
      productId: requiredArg(args, 'product_id'), subscriptionPeriod: period };
    if (args.family_sharable !== undefined) attrs.familySharable = args.family_sharable;
    return { method: 'POST', path: '/v1/subscriptions', body: { data: {
      type: 'subscriptions', attributes: attrs,
      relationships: { group: resource('subscriptionGroups', requiredArg(args, 'group_id')) },
    } } };
  }
  if (actionId === 'create_subscription_version')
    return { method: 'POST', path: '/v1/subscriptionVersions', body: { data: {
      type: 'subscriptionVersions', relationships: { subscription: resource('subscriptions', requiredArg(args, 'subscription_id')) },
    } } };
  if (actionId === 'create_subscription_version_localization') {
    const attrs: Record<string, unknown> = { locale: requiredArg(args, 'locale'), name: requiredArg(args, 'name') };
    if (args.description !== undefined) attrs.description = args.description;
    return { method: 'POST', path: '/v2/subscriptionLocalizations', body: { data: {
      type: 'subscriptionLocalizations', attributes: attrs,
      relationships: { version: resource('subscriptionVersions', requiredArg(args, 'version_id')) },
    } } };
  }
  if (actionId === 'create_subscription_group_version')
    return { method: 'POST', path: '/v1/subscriptionGroupVersions', body: { data: {
      type: 'subscriptionGroupVersions', relationships: { subscriptionGroup: resource('subscriptionGroups', requiredArg(args, 'group_id')) },
    } } };
  if (actionId === 'create_subscription_group_version_localization') {
    const attrs: Record<string, unknown> = { locale: requiredArg(args, 'locale'), name: requiredArg(args, 'name') };
    if (args.custom_app_name !== undefined) attrs.customAppName = args.custom_app_name;
    return { method: 'POST', path: '/v2/subscriptionGroupLocalizations', body: { data: {
      type: 'subscriptionGroupLocalizations', attributes: attrs,
      relationships: { version: resource('subscriptionGroupVersions', requiredArg(args, 'version_id')) },
    } } };
  }

  if (actionId === 'create_in_app_purchase_price_schedule') {
    const purchaseId = requiredArg(args, 'purchase_id');
    const pointId = requiredArg(args, 'price_point_id');
    const territory = requiredArg(args, 'base_territory');
    const date = args.start_date === undefined ? null : requiredArg(args, 'start_date');
    if (!/^[A-Z]{3}$/.test(territory))
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Base territory must be an Apple three-letter territory code.', { retryable: false });
    if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Invalid IAP price start date.', { retryable: false });
    const inlineId = 'price-1';
    return { method: 'POST', path: '/v1/inAppPurchasePriceSchedules', body: {
      data: { type: 'inAppPurchasePriceSchedules', relationships: {
        inAppPurchase: resource('inAppPurchases', purchaseId),
        baseTerritory: resource('territories', territory),
        manualPrices: { data: [{type:'inAppPurchasePrices', id:inlineId}] },
      } },
      included: [{ type: 'inAppPurchasePrices', id: inlineId, attributes: { startDate: date },
        relationships: {
          inAppPurchaseV2: resource('inAppPurchases', purchaseId),
          inAppPurchasePricePoint: resource('inAppPurchasePricePoints', pointId),
        },
      }],
    } };
  }
  if (actionId === 'create_subscription_price') {
    const attrs: Record<string, unknown> = { startDate: args.start_date === undefined ? null : requiredArg(args, 'start_date') };
    if (args.plan_type !== undefined) {
      const plan = requiredArg(args, 'plan_type');
      if (!['MONTHLY','UPFRONT'].includes(plan))
        throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Invalid subscription price plan type.', { retryable: false });
      attrs.planType = plan;
    }
    return { method: 'POST', path: '/v1/subscriptionPrices', body: { data: {
      type: 'subscriptionPrices', attributes: attrs,
      relationships: { subscription: resource('subscriptions', requiredArg(args, 'subscription_id')),
        subscriptionPricePoint: resource('subscriptionPricePoints', requiredArg(args, 'price_point_id')) },
    } } };
  }
  if (actionId === 'set_app_store_version_build')
    return { method: 'PATCH', path: '/v1/appStoreVersions/' + encodeURIComponent(requiredArg(args, 'version_id')) + '/relationships/build',
      body: { data: { type: 'builds', id: requiredArg(args, 'build_id') } } };
  if (actionId === 'add_review_submission_item') {
    const type = requiredArg(args, 'item_type');
    if (!['appStoreVersions', 'inAppPurchaseVersions', 'subscriptionVersions', 'subscriptionGroupVersions'].includes(type))
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Unsupported review submission item type.', { retryable: false });
    return { method: 'POST', path: '/v1/reviewSubmissionItems', body: { data: {
      type: 'reviewSubmissionItems', relationships: {
        reviewSubmission: resource('reviewSubmissions', requiredArg(args, 'review_submission_id')),
        [type === 'appStoreVersions' ? 'appStoreVersion' : type === 'inAppPurchaseVersions' ? 'inAppPurchaseVersion' :
          type === 'subscriptionVersions' ? 'subscriptionVersion' : 'subscriptionGroupVersion']:
          resource(type, requiredArg(args, 'item_id')),
      },
    } } };
  }
  if (actionId === 'update_app_store_review_detail') {
    const id = requiredArg(args, 'review_detail_id');
    const fields: Record<string, string> = { contact_first_name: 'contactFirstName', contact_last_name: 'contactLastName',
      contact_phone: 'contactPhone', contact_email: 'contactEmail', notes: 'notes', demo_account_required: 'demoAccountRequired' };
    const attrs: Record<string, unknown> = {};
    for (const [name, target] of Object.entries(fields)) if (args[name] !== undefined) attrs[target] = args[name];
    if (!Object.keys(attrs).length) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'No App Review fields to change.', { retryable: false });
    return { method: 'PATCH', path: '/v1/appStoreReviewDetails/' + encodeURIComponent(id),
      body: { data: { type: 'appStoreReviewDetails', id, attributes: attrs } } };
  }
  if (actionId === 'request_analytics_report') {
    const accessType = requiredArg(args, 'access_type');
    if (!['ONGOING', 'ONE_TIME_SNAPSHOT'].includes(accessType))
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'access_type must be ONGOING or ONE_TIME_SNAPSHOT.', { retryable: false });
    return { method: 'POST', path: '/v1/analyticsReportRequests', body: { data: {
      type: 'analyticsReportRequests', attributes: { accessType },
      relationships: { app: resource('apps', appId(args, config)) },
    } } };
  }
  if (actionId === 'create_in_app_purchase') {
    const kind = requiredArg(args, 'purchase_type');
    if (!['CONSUMABLE','NON_CONSUMABLE','NON_RENEWING_SUBSCRIPTION'].includes(kind))
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Invalid in-app purchase type.', { retryable: false });
    return { method: 'POST', path: '/v2/inAppPurchases', body: { data: {
      type: 'inAppPurchases', attributes: { name: requiredArg(args, 'name'), productId: requiredArg(args, 'product_id'), inAppPurchaseType: kind },
      relationships: { app: resource('apps', appId(args, config)) },
    } } };
  }
  if (actionId === 'update_in_app_purchase') {
    const id = requiredArg(args, 'purchase_id');
    const attrs: Record<string, unknown> = {};
    if (args.name !== undefined) attrs.name = args.name;
    if (args.review_note !== undefined) attrs.reviewNote = args.review_note;
    if (args.family_sharable !== undefined) attrs.familySharable = args.family_sharable;
    if (!Object.keys(attrs).length) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'No purchase fields to change.', { retryable: false });
    return { method: 'PATCH', path: '/v2/inAppPurchases/' + encodeURIComponent(id),
      body: { data: { type: 'inAppPurchases', id, attributes: attrs } } };
  }
  if (actionId === 'create_customer_review_response')
    return { method: 'POST', path: '/v1/customerReviewResponses', body: { data: {
      type: 'customerReviewResponses', attributes: { responseBody: requiredArg(args, 'response_body') },
      relationships: { review: resource('customerReviews', requiredArg(args, 'review_id')) },
    } } };
  return undefined;
}


const ASC_MAX_COMPRESSED = 16 * 1024 * 1024;
const ASC_MAX_UNCOMPRESSED = 64 * 1024 * 1024;

function decodeAppleReport(buffer: Buffer, requestedRows: unknown) {
  const text = gunzipSync(buffer, { maxOutputLength: ASC_MAX_UNCOMPRESSED }).toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const columns = (lines.shift() ?? '').split('\t');
  const maxRows = typeof requestedRows === 'number' && Number.isInteger(requestedRows)
    ? Math.min(500, Math.max(1, requestedRows)) : 100;
  return { columns, rows: lines.slice(0, maxRows).map(line => line.split('\t')),
    totalRows: lines.length, truncated: lines.length > maxRows, format: 'tsv' };
}

async function fetchAppleGzip(url: string, expectedMd5?: string, config?: AppStoreConnectPluginConfig): Promise<Buffer> {
  const target = new URL(url);
  // Signed URLs come from Apple's authenticated segment metadata; do not forward the Apple JWT to S3.
  if (target.protocol !== 'https:' || !(target.hostname === 'api.appstoreconnect.apple.com'
    || target.hostname.endsWith('.apple.com') || target.hostname.endsWith('.amazonaws.com')))
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Unexpected report download host.', { retryable: false });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error',
      headers: config ? { authorization: 'Bearer ' + await createJwt(config), accept: 'application/a-gzip' }
        : { accept: 'application/a-gzip' } });
    if (!response.ok) throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Apple report download failed.', {
      retryable: response.status >= 500 || response.status === 429, details: { status: response.status },
    });
    if (Number(response.headers.get('content-length')) > ASC_MAX_COMPRESSED)
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Report exceeds the inline download limit.', { retryable: false });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > ASC_MAX_COMPRESSED)
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Report exceeds the inline download limit.', { retryable: false });
    if (expectedMd5 && createHash('md5').update(bytes).digest('hex').toLowerCase() !== expectedMd5.toLowerCase())
      throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Apple Analytics checksum mismatch.', { retryable: false });
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadAppleReport(config: AppStoreConnectPluginConfig, actionId: string, args: Record<string, unknown>):
  Promise<Record<string, unknown>> {
  if (actionId === 'read_analytics_segment_data') {
    const id = requiredArg(args, 'segment_id');
    const segment = await apiRequest<{ data: { attributes?: { checksum?: string; url?: string; sizeInBytes?: number } } }>(config,
      { path: '/v1/analyticsReportSegments/' + encodeURIComponent(id) });
    const { checksum, url, sizeInBytes } = segment.data.attributes ?? {};
    if (!url) throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Apple did not return a segment URL.', { retryable: false });
    if (sizeInBytes && sizeInBytes > ASC_MAX_COMPRESSED)
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Segment exceeds the inline download limit.', { retryable: false });
    const bytes = await fetchAppleGzip(url, checksum);
    return { segmentId: id, checksumVerified: !!checksum, compressedBytes: bytes.length,
      ...decodeAppleReport(bytes, args.max_rows) };
  }
  const finance = actionId === 'read_finance_report';
  const date = requiredArg(args, 'report_date');
  if (!(finance ? /^\d{4}-\d{2}$/.test(date) : /^\d{4}-\d{2}-\d{2}$/.test(date)))
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Invalid report date format.', { retryable: false });
  const vendor = requiredArg(args, 'vendor_number');
  const query = finance
    ? { 'filter[regionCode]': requiredArg(args, 'region_code'), 'filter[reportDate]': date,
      'filter[reportType]': stringValue(args.report_type) ?? 'FINANCIAL', 'filter[vendorNumber]': vendor }
    : { 'filter[frequency]': stringValue(args.frequency) ?? 'DAILY', 'filter[reportDate]': date,
      'filter[reportType]': stringValue(args.report_type) ?? 'SALES',
      'filter[reportSubType]': stringValue(args.report_sub_type) ?? 'SUMMARY',
      'filter[vendorNumber]': vendor, 'filter[version]': stringValue(args.version) ?? '1_0' };
  const bytes = await fetchAppleGzip(API_BASE_URL + (finance ? '/v1/financeReports' : '/v1/salesReports')
    + buildQueryString(query), undefined, config);
  return { reportType: finance ? 'finance' : 'sales', reportDate: date,
    compressedBytes: bytes.length, ...decodeAppleReport(bytes, args.max_rows) };
}


/**
 * Read-only evidence, not an alternative Apple acceptance gate. Apple remains
 * authoritative for completeness and the outcome of Submit for App Review.
 */
async function inspectAppStoreReleaseReadiness(config: AppStoreConnectPluginConfig, args: Record<string, unknown>):
  Promise<Record<string, unknown>> {
  const versionId = requiredArg(args, 'version_id');
  const basePath = '/v1/appStoreVersions/' + encodeURIComponent(versionId);
  const versionResponse = await apiRequest<{
    data: { id: string; attributes?: { versionString?: string; appStoreState?: string; platform?: string };
      relationships?: { app?: { data?: { id?: string } | null }; build?: { data?: { id?: string } | null };
        appStoreReviewDetail?: { data?: { id?: string } | null } } };
  }>(config, { path: basePath, query: { include: 'app,build,appStoreReviewDetail' } });
  const version = versionResponse.data;
  if (!version || version.id !== versionId)
    throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Apple returned a different App Store version.', { retryable: false });
  const appleAppId = version.relationships?.app?.data?.id;
  const expectedAppId = stringValue(args.app_id) ?? config.defaultAppId;
  if (expectedAppId && appleAppId !== expectedAppId)
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'App Store version does not belong to the selected app.', { retryable: false });
  const blockers: string[] = [];
  const evidence: Record<string, unknown> = { versionId, appId: appleAppId,
    versionString: version.attributes?.versionString, state: version.attributes?.appStoreState,
    platform: version.attributes?.platform };
  const buildId = version.relationships?.build?.data?.id;
  if (!buildId) blockers.push('No App Store build assigned to this version.');
  else {
    const buildResponse = await apiRequest<{
      data: { id: string; attributes?: { processingState?: string; expired?: boolean; version?: string } };
    }>(config, { path: basePath + '/build' });
    const attrs = buildResponse.data.attributes;
    evidence.build = { id: buildId, processingState: attrs?.processingState, expired: attrs?.expired === true };
    if (buildResponse.data.id !== buildId || attrs?.expired || attrs?.processingState !== 'VALID')
      blockers.push('App Store build is not confirmed valid and unexpired.');
  }
  const localizationResponse = await apiRequest<{
    data: Array<{ id: string; attributes?: { locale?: string; description?: string; supportUrl?: string } }>;
  }>(config, { path: basePath + '/appStoreVersionLocalizations', query: { limit: 100 } });
  const localizations = localizationResponse.data ?? [];
  evidence.localizations = localizations.map(item => ({
    locale: item.attributes?.locale,
    descriptionPresent: !!item.attributes?.description?.trim(),
    supportUrlPresent: !!item.attributes?.supportUrl?.trim(),
  }));
  if (!localizations.length) blockers.push('No App Store version localizations found.');
  for (const loc of localizations) {
    if (!loc.attributes?.description?.trim() || !loc.attributes?.supportUrl?.trim())
      blockers.push('Required description/support URL appears incomplete for ' + (loc.attributes?.locale ?? loc.id) + '.');
  }
  const reviewId = version.relationships?.appStoreReviewDetail?.data?.id;
  if (!reviewId) blockers.push('No App Review details linked to this version.');
  else {
    const detailResponse = await apiRequest<{
      data: { id: string; attributes?: { contactEmail?: string; contactPhone?: string; contactFirstName?: string;
        contactLastName?: string } };
    }>(config, { path: basePath + '/appStoreReviewDetail' });
    const attrs = detailResponse.data?.attributes;
    const contactComplete = !!attrs?.contactEmail && !!attrs?.contactPhone
      && !!attrs?.contactFirstName && !!attrs?.contactLastName;
    evidence.reviewDetail = { id: reviewId, contactComplete };
    if (!contactComplete) blockers.push('App Review contact details appear incomplete.');
  }
  return { preflightOnly: true, appleSubmissionAcceptanceVerified: false,
    result: blockers.length ? 'incomplete' : 'candidate_unverified',
    blockers, evidence,
    notVerified: [
      'Screenshot device coverage and asset processing state',
      'App Privacy, age rating, trade/export compliance and availability',
      'All required fields and eligibility accepted by the Apple submission endpoint',
    ],
  };
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
      capabilityId: 'app-store-screenshots', title: 'App Store Screenshots',
      description: 'Read screenshot sets and safely upload or order localized screenshots through official Apple reservations and upload operations.',
      scopes: ['appstoreconnect.apps.read', 'appstoreconnect.screenshots.write'],
      actions: ['list_app_screenshot_sets', 'list_app_screenshots', 'upload_app_screenshot', 'reorder_app_screenshots'],
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
      actions: ['create_app_store_version', 'create_review_submission', 'submit_for_review', 'set_app_store_version_build', 'add_review_submission_item', 'get_app_store_version', 'get_app_store_version_build', 'get_review_submission', 'list_review_submission_items', 'get_app_store_review_detail', 'update_app_store_review_detail', 'check_release_readiness'],
      // Additional release/version reads are advertised in the commerce and ASO groups below.
    },
    { capabilityId: 'sales-finance', title: 'Sales and Finance Reports', description: 'Download bounded official TSV reports.', scopes: ['appstoreconnect.reports.read', 'appstoreconnect.analytics.read'], actions: ['read_sales_report', 'read_finance_report', 'read_analytics_segment_data'] },
    { capabilityId: 'analytics-and-aso', title: 'Analytics and ASO', description: 'Read Apple Analytics reports, historical snapshots, keyword configuration, and store discovery.', scopes: ['appstoreconnect.analytics.read','appstoreconnect.analytics.write'], actions: [...additionalAscReads.filter(s => s.scope === 'appstoreconnect.analytics.read').map(s => s.id), 'request_analytics_report'] },
    { capabilityId: 'commerce', title: 'In-App Purchases and Subscriptions', description: 'Read products, subscriptions and manage IAP v2.', scopes: ['appstoreconnect.commerce.read','appstoreconnect.commerce.write'], actions: [...additionalAscReads.filter(s => s.scope === 'appstoreconnect.commerce.read').map(s => s.id), ...['create_in_app_purchase','update_in_app_purchase','create_in_app_purchase_version','create_in_app_purchase_version_localization','update_in_app_purchase_version_localization','create_subscription_group','create_subscription','create_subscription_version','create_subscription_version_localization','create_subscription_group_version','create_subscription_group_version_localization','create_subscription_price','create_in_app_purchase_price_schedule']] },
    { capabilityId: 'customer-reviews', title: 'Customer Reviews', description: 'Read ratings and response to reviews.', scopes: ['appstoreconnect.reviews.read','appstoreconnect.reviews.write'], actions: [...additionalAscReads.filter(s => s.scope === 'appstoreconnect.reviews.read').map(s => s.id), 'create_customer_review_response'] },
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
      scopes: ['appstoreconnect.apps.read', 'appstoreconnect.developer_resources.read', 'appstoreconnect.metadata.write', 'appstoreconnect.screenshots.write', 'appstoreconnect.testflight.write', 'appstoreconnect.release.write', 'appstoreconnect.xcodecloud.read', 'appstoreconnect.xcodecloud.write'], resourceClaims: [{ resource: 'repo-state', mode: 'write' }],
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
    { actionId: 'list_app_screenshot_sets', title: 'List localized screenshot sets', description: 'Read device screenshot sets for a verified exact App/version/locale.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, version_id: { type: 'string' }, localization_id: { type: 'string' }, locale: { type: 'string' } }, required: ['app_id', 'version_id', 'localization_id', 'locale'], additionalProperties: false } },
    { actionId: 'list_app_screenshots', title: 'List localized screenshots', description: 'Read screenshot upload state and checksum for an exact device screenshot set.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, version_id: { type: 'string' }, localization_id: { type: 'string' }, locale: { type: 'string' }, display_type: { type: 'string' } }, required: ['app_id', 'version_id', 'localization_id', 'locale', 'display_type'], additionalProperties: false } },
    { actionId: 'upload_app_screenshot', title: 'Upload localized App screenshot', description: 'Verify exact App/version/locale/device, reserve Apple upload, PUT signed byte ranges, commit MD5, return processing state. Reconcile by checksum before retry.', readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 180_000, cancellable: true, idempotent: false, scopes: ['appstoreconnect.screenshots.write'], resourceClaims: writeRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, version_id: { type: 'string' }, localization_id: { type: 'string' }, locale: { type: 'string' }, display_type: { type: 'string' }, file_path: { type: 'string' }, expected_sha256: { type: 'string' }, dry_run: { type: 'boolean' } }, required: ['app_id', 'version_id', 'localization_id', 'locale', 'display_type', 'file_path'], additionalProperties: false } },
    { actionId: 'reorder_app_screenshots', title: 'Reorder localized screenshots', description: 'Replace exact screenshot ID order after reconciling same-set membership and processing state.', readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 90_000, cancellable: true, idempotent: false, scopes: ['appstoreconnect.screenshots.write'], resourceClaims: writeRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, version_id: { type: 'string' }, localization_id: { type: 'string' }, locale: { type: 'string' }, display_type: { type: 'string' }, screenshot_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 }, dry_run: { type: 'boolean' } }, required: ['app_id', 'version_id', 'localization_id', 'locale', 'display_type', 'screenshot_ids'], additionalProperties: false } },
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
    ...additionalAscActions(),
  ];
}


type AscScreenshotResource = {
  id: string;
  attributes?: {
    locale?: string; platform?: string; appStoreState?: string; screenshotDisplayType?: string; fileName?: string; fileSize?: number;
    sourceFileChecksum?: string | null; assetDeliveryState?: { state?: string; errors?: unknown[] };
    uploadOperations?: Array<{ method: string; url: string; offset: number; length: number;
      requestHeaders?: Array<{ name: string; value: string }> }>;
  };
  relationships?: Record<string, { data?: { id: string } | null }>;
};
type AscScreenshotResponse = { data: AscScreenshotResource };
type AscScreenshotList = { data: AscScreenshotResource[] };
function safeScreenshot(resource: AscScreenshotResource): Record<string, unknown> {
  return { id: resource.id, fileName: resource.attributes?.fileName, fileSize: resource.attributes?.fileSize,
    sourceFileChecksum: resource.attributes?.sourceFileChecksum ?? null,
    state: resource.attributes?.assetDeliveryState?.state,
    processingErrorCount: resource.attributes?.assetDeliveryState?.errors?.length ?? 0 };
}
async function verifyScreenshotOwner(config: AppStoreConnectPluginConfig, args: Record<string, unknown>): Promise<string> {
  const app = requiredArg(args, 'app_id'), versionId = requiredArg(args, 'version_id');
  const locId = requiredArg(args, 'localization_id'), locale = requiredArg(args, 'locale');
  // Use the exact App's version and that version's localization collections:
  // JSON:API relationships may contain only links, not linkage data.
  const versions = await apiRequest<AscScreenshotList>(config, {
    path: '/v1/apps/' + encodeURIComponent(app) + '/appStoreVersions', query: { limit: 200 },
  });
  const exactVersion = versions.data?.find((v) => v.id === versionId);
  if (!exactVersion || exactVersion.attributes?.platform !== 'IOS' ||
      exactVersion.attributes?.appStoreState !== 'PREPARE_FOR_SUBMISSION')
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Screenshot target must be an editable iOS version of the specified App.', { retryable: false });
  const localizations = await apiRequest<AscScreenshotList>(config, {
    path: '/v1/appStoreVersions/' + encodeURIComponent(versionId) + '/appStoreVersionLocalizations',
    query: { 'filter[locale]': locale, limit: 200 },
  });
  if (!localizations.data?.some((loc) => loc.id === locId && loc.attributes?.locale === locale))
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Screenshot version/locale ownership mismatch.', { retryable: false });
  return locId;
}
function screenshotType(args: Record<string, unknown>): string {
  const display = requiredArg(args, 'display_type');
  if (!/^APP_(IPHONE|IPAD|WATCH|APPLE_TV|DESKTOP|APPLE_VISION_PRO)[A-Z0-9_]*$/.test(display))
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Unsupported screenshot display type.', { retryable: false });
  return display;
}
async function listScreenshotSets(config: AppStoreConnectPluginConfig, localizationId: string): Promise<AscScreenshotResource[]> {
  const response = await apiRequest<AscScreenshotList>(config, {
    path: '/v1/appStoreVersionLocalizations/' + encodeURIComponent(localizationId) + '/appScreenshotSets', query: { limit: 100 },
  });
  if (!Array.isArray(response.data)) throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Malformed screenshot sets.', { retryable: false });
  return response.data;
}
async function findScreenshotSet(config: AppStoreConnectPluginConfig, locId: string, display: string, create: boolean): Promise<string | undefined> {
  const matches = (await listScreenshotSets(config, locId)).filter((s) => s.attributes?.screenshotDisplayType === display);
  if (matches.length > 1) throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Duplicate device screenshot sets.', { retryable: false });
  if (matches.length) return matches[0].id;
  if (!create) return undefined;
  const created = await apiRequest<AscScreenshotResponse>(config, { path: '/v1/appScreenshotSets', method: 'POST',
    body: { data: { type: 'appScreenshotSets', attributes: { screenshotDisplayType: display },
      relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: locId } } } } } });
  if (!created.data?.id) throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Apple did not return a screenshot set ID.', { retryable: false });
  return created.data.id;
}
async function listScreenshots(config: AppStoreConnectPluginConfig, setId: string): Promise<AscScreenshotResource[]> {
  const response = await apiRequest<AscScreenshotList>(config, {
    path: '/v1/appScreenshotSets/' + encodeURIComponent(setId) + '/appScreenshots', query: { limit: 100 },
  });
  if (!Array.isArray(response.data)) throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Malformed screenshot inventory.', { retryable: false });
  return response.data;
}
async function screenshotFile(repoRoot: string, inputPath: string) {
  const root = await fsPromises.realpath(repoRoot);
  const path = await fsPromises.realpath(resolve(root, inputPath));
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel))
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Screenshot file must be inside the authorized checkout.', { retryable: false });
  const stat = await fsPromises.stat(path);
  if (!stat.isFile() || stat.size === 0 || stat.size > 25 * 1024 * 1024)
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Screenshot must be a nonempty image under 25 MiB.', { retryable: false });
  const bytes = await fsPromises.readFile(path), name = basename(path), ext = extname(name).toLowerCase();
  const jpeg = (ext === '.jpg' || ext === '.jpeg') && bytes[0] === 0xff && bytes[1] === 0xd8;
  const png = ext === '.png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!jpeg && !png) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Screenshot image extension/signature mismatch.', { retryable: false });
  return { bytes, name, relativePath: rel, sha256: createHash('sha256').update(bytes).digest('hex'), md5: createHash('md5').update(bytes).digest('hex') };
}
async function uploadScreenshotParts(parts: NonNullable<NonNullable<AscScreenshotResource['attributes']>['uploadOperations']>, bytes: Buffer): Promise<void> {
  const ordered = [...parts].sort((a, b) => a.offset - b.offset);
  let cursor = 0;
  for (const part of ordered) {
    if (!Number.isSafeInteger(part.offset) || !Number.isSafeInteger(part.length) || part.length <= 0 ||
        part.offset !== cursor || part.length + cursor > bytes.length || part.method !== 'PUT')
      throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Invalid or non-contiguous Apple upload range.', { retryable: false });
    const url = new URL(part.url);
    if (url.protocol !== 'https:' || !(url.hostname === 'apple.com' || url.hostname.endsWith('.apple.com')) ||
        url.username || url.password)
      throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Unexpected Apple upload host.', { retryable: false });
    for (const h of part.requestHeaders ?? [])
      if (!/^(content-type|content-md5|x-amz-[a-z0-9-]+|x-apple-[a-z0-9-]+)$/i.test(h.name))
        throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Unexpected Apple upload header.', { retryable: false });
    cursor += part.length;
  }
  if (!ordered.length || cursor !== bytes.length)
    throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Apple upload operations do not cover the file.', { retryable: false });
  for (const part of ordered) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(part.url, { method: 'PUT',
        headers: Object.fromEntries((part.requestHeaders ?? []).map((h) => [h.name, h.value])),
        body: new Uint8Array(bytes.subarray(part.offset, part.offset + part.length)), redirect: 'manual', signal: controller.signal });
      if (!response.ok) throw new Error('UPLOAD_HTTP_ERROR');
    } catch {
      throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Screenshot part outcome is unknown. Reconcile reservation before retry.', {
        retryable: false, details: { offset: part.offset, length: part.length } });
    } finally { clearTimeout(timer); }
  }
}
async function waitForScreenshotProcessing(config: AppStoreConnectPluginConfig, screenshotId: string, md5: string):
  Promise<{ resource: AscScreenshotResource; complete: boolean }> {
  // Apple commits asynchronously: UPLOAD_COMPLETE means accepted, not processed.
  // Bounded polling never repeats a reservation or an uncertain upload/commit.
  const deadline = Date.now() + 45_000;
  for (;;) {
    const response = await apiRequest<AscScreenshotResponse>(config, {
      path: '/v1/appScreenshots/' + encodeURIComponent(screenshotId),
      timeoutMs: 15_000,
    });
    const resource = response.data;
    if (!resource || resource.id !== screenshotId)
      throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Apple screenshot identity readback failed; inspect before retry.', {
        retryable: false, details: { screenshotId } });
    const checksum = resource.attributes?.sourceFileChecksum?.toLowerCase();
    if (checksum && checksum !== md5)
      throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Apple screenshot checksum mismatch; inspect before retry.', {
        retryable: false, details: { screenshotId } });
    const state = resource.attributes?.assetDeliveryState?.state;
    if (state === 'FAILED')
      throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Apple screenshot processing failed; inspect before retry.', {
        retryable: false, details: { screenshotId, processingErrorCount: resource.attributes?.assetDeliveryState?.errors?.length ?? 0 } });
    if (state === 'COMPLETE') {
      if (checksum !== md5)
        throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Apple screenshot completed without a confirmed checksum; inspect before retry.', {
          retryable: false, details: { screenshotId } });
      return { resource, complete: true };
    }
    if (Date.now() >= deadline) {
      if (state !== 'UPLOAD_COMPLETE')
        throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Apple screenshot commit state is unresolved; inspect before retry.', {
          retryable: false, details: { screenshotId, state: state ?? null } });
      return { resource, complete: false };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(2_500, deadline - Date.now())));
  }
}
async function uploadOfficialScreenshot(config: AppStoreConnectPluginConfig, args: Record<string, unknown>, repoRoot: string): Promise<Record<string, unknown>> {
  const file = await screenshotFile(repoRoot, requiredArg(args, 'file_path'));
  if (args.expected_sha256 && (stringValue(args.expected_sha256)?.toLowerCase() !== file.sha256))
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Screenshot SHA-256 differs from expected.', { retryable: false });
  const display = screenshotType(args), loc = await verifyScreenshotOwner(config, args);
  const existingSet = await findScreenshotSet(config, loc, display, false);
  const existing = existingSet ? await listScreenshots(config, existingSet) : [];
  const sameName = existing.filter((r) => r.attributes?.fileName === file.name);
  if (sameName.length > 1)
    throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Multiple screenshots share the source filename; inspect before retry.', {
      retryable: false, details: { screenshotIds: sameName.map((r) => r.id) } });
  const complete = sameName.find((r) => r.attributes?.sourceFileChecksum?.toLowerCase() === file.md5 &&
    r.attributes?.assetDeliveryState?.state === 'COMPLETE');
  if (complete) return { applied: false, alreadyPresent: true, processingComplete: true, setId: existingSet, screenshot: safeScreenshot(complete) };
  const committed = sameName.find((r) => r.attributes?.sourceFileChecksum?.toLowerCase() === file.md5 &&
    r.attributes?.assetDeliveryState?.state === 'UPLOAD_COMPLETE');
  if (committed) {
    const processed = await waitForScreenshotProcessing(config, committed.id, file.md5);
    return { applied: false, alreadyPresent: true, processingComplete: processed.complete, setId: existingSet,
      screenshot: safeScreenshot(processed.resource) };
  }
  if (sameName.length) throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Same filename has different, failed or uncommitted contents; inspect before retry.', {
    retryable: false, details: { screenshotIds: sameName.map((r) => r.id), states: sameName.map((r) => r.attributes?.assetDeliveryState?.state) } });
  if (existing.length >= 10) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Device set has ten screenshots already.', { retryable: false });
  if (args.dry_run === true) return { dryRun: true, appId: args.app_id, versionId: args.version_id, locale: args.locale,
    displayType: display, setId: existingSet ?? null, wouldCreateSet: !existingSet,
    file: { relativePath: file.relativePath, name: file.name, size: file.bytes.length, sha256: file.sha256 } };
  const setId = existingSet ?? await findScreenshotSet(config, loc, display, true);
  if (!setId) throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Could not resolve screenshot set.', { retryable: false });
  const reservation = await apiRequest<AscScreenshotResponse>(config, { path: '/v1/appScreenshots', method: 'POST',
    body: { data: { type: 'appScreenshots', attributes: { fileName: file.name, fileSize: file.bytes.length },
      relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: setId } } } } } });
  const r = reservation.data;
  if (!r?.id || !r.attributes?.uploadOperations)
    throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Apple reservation is incomplete; reconcile before retry.', { retryable: false });
  await uploadScreenshotParts(r.attributes.uploadOperations, file.bytes);
  await apiRequest<AscScreenshotResponse>(config, { path: '/v1/appScreenshots/' + encodeURIComponent(r.id),
    method: 'PATCH', body: { data: { type: 'appScreenshots', id: r.id,
      attributes: { uploaded: true, sourceFileChecksum: file.md5 } } } });
  const processed = await waitForScreenshotProcessing(config, r.id, file.md5);
  return { applied: true, setId, sha256: file.sha256, processingComplete: processed.complete,
    screenshot: safeScreenshot(processed.resource),
    ...(processed.complete ? {} : { note: 'Apple accepted the upload but processing remains pending. Read the exact screenshot set before further action.' }) };
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
  const additionalRead = additionalAscReads.find(spec => spec.id === actionId);
  if (actionId === 'check_release_readiness')
    return { preflightOnly: true, appleSubmissionAcceptanceVerified: false, result: 'candidate_unverified', blockers: [], evidence: {versionId: requiredArg(args, 'version_id')}, notVerified: ['Mock provider has no real Apple submission evidence'], provider:'mock' };
  if (['read_analytics_segment_data','read_sales_report','read_finance_report'].includes(actionId))
    return { columns:['Date','Units'], rows:[['2026-11-01','2']], totalRows:1, truncated:false, format:'tsv', provider:'mock' };
  if (additionalRead) return { data: [], meta: { provider: 'mock', resource: additionalAscReadRequest(additionalRead, args, config).path } };
  const additionalWrite = additionalAscWriteRequest(actionId, args, config);
  if (additionalWrite) return { dryRun: args.dry_run === true, request: additionalWrite, provider: 'mock', applied: args.dry_run !== true };
  if (actionId === 'auth_status') {
    return {
      ready: true,
      provider: 'mock',
      warnings: ['Mock provider enabled.'],
      userFacingStatus: 'ready',
      readinessMode: 'mock_provider_ready',
    };
  }
  if (actionId === 'list_app_screenshot_sets') return { data: [{ id: stableMockId('screenshot_set', args), displayType: stringValue(args.display_type) ?? 'APP_IPHONE_61' }], provider: 'mock' };
  if (actionId === 'list_app_screenshots') return { setId: stableMockId('screenshot_set', args), data: [], provider: 'mock' };
  if (actionId === 'upload_app_screenshot' || actionId === 'reorder_app_screenshots')
    throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', 'Mock mode cannot perform screenshot uploads or reordering.', { retryable: false });
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
    pluginVersion: '1.3.0',
    authority: { strategy: 'derived', duplicateStateAllowed: false, sourceOfTruth: ['controller-global:system/plugins/config/app-store-connect.json', 'legacy-import-only:system/plugins/profiles|repositories/<repoId>/plugins/config|.forge/plugins|.repo-harness/plugins', 'env:FORGE_ASC_*'] },
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
    const liveAuth = await resolveLiveAuthStatus(config);
    return {
      ready: config.enabled && liveAuth.ready,
      provider: liveAuth.provider,
      issuerId: liveAuth.issuerId ? 'configured' : undefined,
      keyId: liveAuth.keyId ? 'configured' : undefined,
      credentialSource: liveAuth.credentialSource,
      errors: liveAuth.errors,
      warnings: liveAuth.warnings,
      userFacingStatus: userFacingAscStatus(config, liveAuth),
    };
  }
  if (!config.enabled || !auth.ready) throw new AssistantPluginError('PLUGIN_NOT_READY', 'App Store Connect plugin is not ready.', { retryable: false, details: { enabled: config.enabled, errors: auth.errors } });

  if (input.actionId === 'check_release_readiness') return inspectAppStoreReleaseReadiness(config, input.args);
  if (['read_analytics_segment_data','read_sales_report','read_finance_report'].includes(input.actionId))
    return downloadAppleReport(config, input.actionId, input.args);
  const additionalRead = additionalAscReads.find(spec => spec.id === input.actionId);
  if (additionalRead) {
    const result = await apiRequest<Record<string, unknown>>(config, additionalAscReadRequest(additionalRead, input.args, config));
    if (input.actionId === 'get_app_store_review_detail' && result.data && typeof result.data === 'object') {
      const data = result.data as { attributes?: Record<string, unknown> };
      if (data.attributes && Object.hasOwn(data.attributes, 'demoAccountPassword')) {
        return { ...result, data: { ...data, attributes: { ...data.attributes, demoAccountPassword: '[REDACTED]' } } };
      }
    }
    return result;
  }
  const additionalWrite = additionalAscWriteRequest(input.actionId, input.args, config);
  if (additionalWrite) {
    if (input.args.dry_run === true) return { dryRun: true, request: additionalWrite };
    return apiRequest(config, additionalWrite);
  }

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
      return apiRequest(config, { path: `/v1/apps/${encodeURIComponent(appId(input.args, config))}/appStoreVersions`, query: { limit: limit(input.args.limit) } });
    case 'list_app_store_version_localizations':
      return apiRequest(config, {
        path: `/v1/appStoreVersions/${encodeURIComponent(requiredArg(input.args, 'version_id'))}/appStoreVersionLocalizations`,
        query: { limit: limit(input.args.limit) },
      });
    case 'list_app_screenshot_sets': {
      const locId = await verifyScreenshotOwner(config, input.args);
      const sets = await listScreenshotSets(config, locId);
      return { data: sets.map((s) => ({ id: s.id, displayType: s.attributes?.screenshotDisplayType })) };
    }
    case 'list_app_screenshots': {
      const loc = await verifyScreenshotOwner(config, input.args);
      const display = screenshotType(input.args);
      const setId = await findScreenshotSet(config, loc, display, false);
      return { setId: setId ?? null, data: setId ? (await listScreenshots(config, setId)).map(safeScreenshot) : [] };
    }
    case 'upload_app_screenshot':
      return uploadOfficialScreenshot(config, input.args, input.repoRoot);
    case 'reorder_app_screenshots': {
      const loc = await verifyScreenshotOwner(config, input.args);
      const setId = await findScreenshotSet(config, loc, screenshotType(input.args), false);
      if (!setId) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Cannot reorder a missing screenshot set.', { retryable: false });
      const original = await listScreenshots(config, setId);
      const next = input.args.screenshot_ids;
      if (!Array.isArray(next) || next.some((id) => typeof id !== 'string') ||
          next.length !== original.length || new Set(next).size !== original.length ||
          original.some((entry) => !next.includes(entry.id) || !entry.attributes?.sourceFileChecksum ||
            entry.attributes?.assetDeliveryState?.state !== 'COMPLETE'))
        throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Reorder requires exactly all committed IDs in the same screenshot set.', { retryable: false });
      if (next.every((id, i) => id === original[i].id))
        return { applied: false, alreadyOrdered: true, setId, screenshotIds: next };
      if (input.args.dry_run === true) return { dryRun: true, setId, screenshotIds: next };
      await apiRequest(config, { path: '/v1/appScreenshotSets/' + encodeURIComponent(setId) + '/relationships/appScreenshots',
        method: 'PATCH', body: { data: next.map((id) => ({ type: 'appScreenshots', id })) } });
      const checked = await listScreenshots(config, setId);
      if (!next.every((id, i) => id === checked[i]?.id))
        throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', 'Apple screenshot order does not match the requested order after write.', { retryable: false });
      return { applied: true, setId, screenshotIds: next };
    }
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
  scope: 'controller' as const,
  buildManifest: buildAppStoreConnectPluginManifest,
  executeAction: executeAppStoreConnectPluginAction,
};
