import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
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
import { readRepositoryPluginConfig, writeRepositoryPluginConfig, type RepositoryPluginConfigContext } from './config-store';
import {
  getResendOAuthAccessToken,
  prepareResendOAuthLogin,
  readStoredResendOAuthCredential,
  readStoredResendSmtpToken,
  resendCredentialStoreStatus,
  writeStoredResendSmtpToken,
} from '../safe-tooling/resend-oauth';

const RESEND_PLUGIN_ID = 'resend';
const API_BASE_URL = 'https://api.resend.com';
const RESEND_USER_AGENT = 'Forge-Resend-Plugin/1.0.0';
const DEFAULT_TIMEOUT_MS = 30_000;
const SMTP_HOST = 'smtp.resend.com';
const SMTP_PORTS = [465, 587] as const;

type ResendProviderKind = 'mock' | 'resend-api';

interface ResendPluginConfig {
  schemaVersion: 1;
  enabled: boolean;
  provider: ResendProviderKind;
  sendingDomain?: string;
  fromEmail?: string;
  fromName?: string;
  defaultTimeoutMs: number;
}

interface ResendAuthState {
  ready: boolean;
  authenticated: boolean;
  probed: boolean;
  credentialSource?: string;
  errors: string[];
  warnings: string[];
}

function now(): string {
  return new Date().toISOString();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.map((entry) => String(entry).trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function requiredString(value: unknown, name: string): string {
  const normalized = stringValue(value);
  if (!normalized) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `${name} is required.`);
  return normalized;
}

function boundedTimeout(value: unknown, fallback = DEFAULT_TIMEOUT_MS): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 10 * 60_000
    ? Math.trunc(value)
    : fallback;
}

function normalizeConfig(raw: Partial<ResendPluginConfig>): ResendPluginConfig {
  return {
    schemaVersion: 1,
    enabled: raw.enabled === true,
    provider: raw.provider === 'resend-api' ? 'resend-api' : 'mock',
    sendingDomain: stringValue(raw.sendingDomain)?.toLowerCase(),
    fromEmail: stringValue(raw.fromEmail)?.toLowerCase(),
    fromName: stringValue(raw.fromName),
    defaultTimeoutMs: boundedTimeout(raw.defaultTimeoutMs),
  };
}

function loadConfig(repoRoot: string, context?: Pick<RepositoryPluginConfigContext, 'controllerHome' | 'repoId'>): ResendPluginConfig {
  const persisted = context
    ? readRepositoryPluginConfig<Partial<ResendPluginConfig>>({ ...context, repoRoot }, RESEND_PLUGIN_ID)
    : undefined;
  return normalizeConfig(persisted ?? {});
}

function saveConfig(input: Pick<AssistantPluginActionExecutionInput, 'controllerHome' | 'repoId' | 'repoRoot'>, patch: Partial<ResendPluginConfig>): ResendPluginConfig {
  const next = normalizeConfig({ ...loadConfig(input.repoRoot, input), ...patch });
  return writeRepositoryPluginConfig(input, RESEND_PLUGIN_ID, next);
}

function apiKey(): { value?: string; source?: string } {
  const forge = stringValue(process.env.FORGE_RESEND_API_KEY);
  if (forge) return { value: forge, source: 'env:FORGE_RESEND_API_KEY' };
  const standard = stringValue(process.env.RESEND_API_KEY);
  if (standard) return { value: standard, source: 'env:RESEND_API_KEY' };
  return {};
}

function resolveAuth(config: ResendPluginConfig): ResendAuthState {
  if (config.provider === 'mock') {
    return {
      ready: true,
      authenticated: true,
      probed: true,
      credentialSource: 'mock',
      errors: [],
      warnings: ['Mock provider enabled. No Resend credential is used.'],
    };
  }
  const credential = apiKey();
  const oauth = readStoredResendOAuthCredential();
  if (!credential.value && !oauth) {
    return {
      ready: false,
      authenticated: false,
      probed: false,
      errors: ['Connect Resend with OAuth or set FORGE_RESEND_API_KEY / RESEND_API_KEY before invoking live actions.'],
      warnings: [],
    };
  }
  return {
    ready: true,
    authenticated: true,
    probed: false,
    credentialSource: credential.source ?? 'keychain:resend-oauth',
    errors: [],
    warnings: credential.value ? [] : ['A stored Resend OAuth refresh credential is available; access tokens are refreshed on demand.'],
  };
}

function health(config: ResendPluginConfig, auth: ResendAuthState): AssistantPluginHealth {
  if (!config.enabled) {
    return {
      state: 'disabled', checkedAt: now(), ready: false, probed: false,
      errors: [], warnings: ['Plugin is disabled. Enable it before using Resend provider actions.'],
      details: { provider: config.provider, credentialPersistence: 'OAuth/SMTP credentials use macOS Keychain; environment API keys remain supported and are never persisted by Forge', credentialStore: resendCredentialStoreStatus() },
    };
  }
  return {
    state: auth.ready ? 'ready' : 'error',
    checkedAt: now(),
    ready: auth.ready,
    probed: auth.probed,
    errors: auth.errors,
    warnings: auth.warnings,
    details: {
      provider: config.provider,
      credentialSource: auth.credentialSource ?? 'missing',
      credentialPersistence: 'OAuth/SMTP credentials use macOS Keychain; environment API keys remain supported and are never persisted by Forge',
      credentialStore: resendCredentialStoreStatus(),
      sendingDomain: config.sendingDomain,
      fromEmail: config.fromEmail,
      smtpHost: SMTP_HOST,
      smtpPorts: SMTP_PORTS,
      smtpUsername: 'resend',
    },
  };
}

function permissions(ready: boolean): AssistantPluginPermissionScope[] {
  return [
    { scope: 'resend.read', mode: 'read', description: 'Read Resend domain and sent-email status.', granted: ready, required: true },
    { scope: 'resend.domain.write', mode: 'write', description: 'Trigger verification for an exact Resend domain.', granted: ready, required: true },
    { scope: 'resend.send', mode: 'write', description: 'Send email through Resend after strong confirmation.', granted: ready, required: true },
  ];
}

function capabilities(): AssistantPluginCapability[] {
  return [
    {
      capabilityId: 'resend-readiness',
      title: 'Resend Domain and SMTP Readiness',
      description: 'Validate API credentials, sending-domain verification, and derived SMTP settings without exposing secrets.',
      scopes: ['resend.read'],
      actions: ['oauth_login_prepare', 'auth_status', 'list_domains', 'get_domain', 'smtp_status', 'get_email'],
    },
    {
      capabilityId: 'resend-domain',
      title: 'Resend Domain Verification',
      description: 'Trigger verification for one exact domain after explicit authorization.',
      scopes: ['resend.domain.write'],
      actions: ['create_domain', 'verify_domain'],
    },
    {
      capabilityId: 'resend-delivery',
      title: 'Resend Email Delivery',
      description: 'Send a message only after strong confirmation and return a provider receipt for status follow-up.',
      scopes: ['resend.send'],
      actions: ['provision_smtp_credential', 'send_email'],
    },
  ];
}

function actions(): AssistantPluginActionDescriptor[] {
  return [
    {
      actionId: 'configure', title: 'Configure Resend plugin',
      description: 'Enable Resend and save non-secret sending defaults. API keys remain environment-only.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000,
      cancellable: true, idempotent: true,
      scopes: ['resend.read', 'resend.domain.write', 'resend.send'],
      resourceClaims: [{ resource: 'repo-state', mode: 'write' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' }, provider: { type: 'string', enum: ['mock', 'resend-api'] },
          sending_domain: { type: 'string' }, clear_sending_domain: { type: 'boolean' },
          from_email: { type: 'string' }, clear_from_email: { type: 'boolean' },
          from_name: { type: 'string' }, clear_from_name: { type: 'boolean' },
          default_timeout_ms: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
    {
      actionId: 'oauth_login_prepare', title: 'Connect Resend with OAuth',
      description: 'Dynamically register a PKCE public client and return a Resend consent URL. No API key is requested or returned.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 30_000,
      cancellable: true, idempotent: false, scopes: ['resend.read'], resourceClaims: [{ resource: 'remote', mode: 'write' }],
      argumentsSchema: {
        type: 'object', properties: { scope: { type: 'string', enum: ['emails:send', 'full_access'] }, redirect_uri: { type: 'string' } }, additionalProperties: false,
      },
    },
    {
      actionId: 'auth_status', title: 'Check Resend authentication',
      description: 'Validate configured Resend credentials without returning the API key.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 30_000,
      cancellable: true, idempotent: true, scopes: ['resend.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: 'list_domains', title: 'List Resend domains', description: 'List sending domains and verification states.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 30_000,
      cancellable: true, idempotent: true, scopes: ['resend.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: 'get_domain', title: 'Get Resend domain', description: 'Read one exact Resend domain including required DNS records.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 30_000,
      cancellable: true, idempotent: true, scopes: ['resend.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: { type: 'object', properties: { domain_id: { type: 'string' } }, required: ['domain_id'], additionalProperties: false },
    },
    {
      actionId: 'smtp_status', title: 'Check Resend SMTP readiness',
      description: 'Validate the configured sending domain and return non-secret SMTP endpoint settings.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 30_000,
      cancellable: true, idempotent: true, scopes: ['resend.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: 'create_domain', title: 'Create Resend domain', description: 'Create one exact sending-only Resend domain and return its required DNS records.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 45_000,
      cancellable: true, idempotent: false, scopes: ['resend.domain.write'], resourceClaims: [{ resource: 'remote', mode: 'exclusive' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          region: { type: 'string', enum: ['us-east-1', 'eu-west-1', 'sa-east-1', 'ap-northeast-1'] },
        },
        required: ['name'], additionalProperties: false,
      },
    },
    {
      actionId: 'verify_domain', title: 'Verify Resend domain', description: 'Trigger asynchronous verification for one exact Resend domain.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 45_000,
      cancellable: true, idempotent: false, scopes: ['resend.domain.write'], resourceClaims: [{ resource: 'remote', mode: 'exclusive' }],
      argumentsSchema: { type: 'object', properties: { domain_id: { type: 'string' } }, required: ['domain_id'], additionalProperties: false },
    },
    {
      actionId: 'provision_smtp_credential', title: 'Provision Resend SMTP credential',
      description: 'Create one sending-only Resend API key for SMTP and store it directly in macOS Keychain without returning the token.',
      readOnly: false, risk: 'remote_write', confirmation: 'strong_confirmation', requiredConfirmationText: 'provision-resend-smtp',
      defaultTimeoutMs: 45_000, cancellable: true, idempotent: false, scopes: ['resend.send'], resourceClaims: [{ resource: 'remote', mode: 'exclusive' }],
      argumentsSchema: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false },
    },
    {
      actionId: 'send_email', title: 'Send email with Resend', description: 'Send one email through Resend after strong confirmation.',
      readOnly: false, risk: 'remote_write', confirmation: 'strong_confirmation', requiredConfirmationText: 'send-resend-email',
      defaultTimeoutMs: 45_000, cancellable: true, idempotent: false, remoteEffectWorkCompletion: 'terminal', scopes: ['resend.send'], resourceClaims: [{ resource: 'remote', mode: 'exclusive' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          to: { type: 'array', items: { type: 'string' } }, cc: { type: 'array', items: { type: 'string' } },
          bcc: { type: 'array', items: { type: 'string' } }, from: { type: 'string' }, subject: { type: 'string' },
          text: { type: 'string' }, html: { type: 'string' }, reply_to: { type: 'array', items: { type: 'string' } },
        },
        required: ['to', 'subject'], additionalProperties: false,
      },
    },
    {
      actionId: 'get_email', title: 'Get Resend email status', description: 'Retrieve a sent email and its latest provider event.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 30_000,
      cancellable: true, idempotent: true, scopes: ['resend.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: { type: 'object', properties: { email_id: { type: 'string' } }, required: ['email_id'], additionalProperties: false },
    },
  ];
}

function defaultFrom(config: ResendPluginConfig): string {
  const email = config.fromEmail;
  if (!email) throw new AssistantPluginError('PLUGIN_CONFIG_REQUIRED', 'Configure from_email before sending with Resend.');
  return config.fromName ? `${config.fromName} <${email}>` : email;
}

async function resendRequest(
  config: ResendPluginConfig,
  path: string,
  init: { method?: string; body?: Record<string, unknown>; headers?: Record<string, string> } = {},
): Promise<Record<string, unknown>> {
  if (config.provider === 'mock') {
    if (path === '/domains' && init.method === 'POST') return { object: 'domain', id: 'domain_mock_created', name: init.body?.name, status: 'not_started', records: [] };
    if (path === '/domains') return { object: 'list', has_more: false, data: config.sendingDomain ? [{ id: 'domain_mock', name: config.sendingDomain, status: 'verified' }] : [] };
    if (path.startsWith('/domains/domain_mock')) return { object: 'domain', id: 'domain_mock', name: config.sendingDomain, status: 'verified', records: [] };
    if (path === '/api-keys' && init.method === 'POST') return { id: 'api_key_mock', token: 're_mock_smtp_token' };
    if (path === '/emails' && init.method === 'POST') return { id: 'email_mock' };
    if (path === '/emails/email_mock') return { object: 'email', id: 'email_mock', last_event: 'sent' };
    return { object: 'mock', ok: true };
  }

  const environmentCredential = apiKey();
  const oauthCredential = environmentCredential.value ? undefined : await getResendOAuthAccessToken(config.defaultTimeoutMs);
  const credential = environmentCredential.value
    ? { value: environmentCredential.value, source: environmentCredential.source }
    : oauthCredential
      ? { value: oauthCredential.token, source: oauthCredential.source }
      : {};
  if (!credential.value) throw new AssistantPluginError('PLUGIN_AUTH_REQUIRED', 'Connect Resend with OAuth or configure an environment API key.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.defaultTimeoutMs);
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${credential.value}`,
        'User-Agent': RESEND_USER_AGENT,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: Record<string, unknown> = {};
    if (text) {
      try { payload = JSON.parse(text) as Record<string, unknown>; }
      catch { payload = { message: text.slice(0, 1000) }; }
    }
    if (!response.ok) {
      throw new AssistantPluginError('PLUGIN_PROVIDER_REQUEST_FAILED', `Resend request failed with HTTP ${response.status}.`, {
        retryable: response.status === 429 || response.status >= 500,
        details: { provider: 'resend', status: response.status, providerError: payload.message ?? payload.name },
      });
    }
    return payload;
  } catch (error) {
    throw toAssistantPluginError(error, { code: 'PLUGIN_PROVIDER_REQUEST_FAILED', message: 'Resend request failed.', retryable: true });
  } finally {
    clearTimeout(timeout);
  }
}

function domainRows(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(payload.data) ? payload.data.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object') : [];
}

export function buildResendPluginManifest(previousRevision = 0, previousUpdatedAt?: string, repoRoot?: string, context?: AssistantPluginBuildContext): AssistantPluginManifest {
  const root = repoRoot ?? process.cwd();
  const config = loadConfig(root, context);
  const auth = resolveAuth(config);
  return {
    schemaVersion: 1, manifestVersion: 1, revision: Math.max(1, previousRevision || 1),
    pluginId: RESEND_PLUGIN_ID, provider: 'resend', displayName: 'Resend Email Plugin', pluginVersion: '1.0.0',
    authority: { strategy: 'derived', duplicateStateAllowed: false, sourceOfTruth: ['controller-home:repositories/<repoId>/plugins/config/resend.json', 'macos-keychain:forge.resend-oauth|forge.resend-smtp', 'env:FORGE_RESEND_API_KEY|RESEND_API_KEY'] },
    enabled: config.enabled,
    lifecycle: {
      state: !config.enabled ? 'disabled' : auth.ready ? 'enabled' : 'error',
      reason: !config.enabled ? 'Resend plugin is disabled.' : auth.ready ? `Resend credential is ready via ${auth.credentialSource}.` : auth.errors[0],
    },
    health: health(config, auth), permissions: permissions(auth.ready), capabilities: capabilities(), actions: actions(),
    updatedAt: previousUpdatedAt ?? now(),
  };
}

export async function executeResendPluginAction(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  const current = loadConfig(input.repoRoot, input);
  switch (input.actionId) {
    case 'configure': {
      const args = input.args;
      const config = saveConfig(input, {
        enabled: typeof args.enabled === 'boolean' ? args.enabled : current.enabled,
        provider: args.provider === 'resend-api' ? 'resend-api' : args.provider === 'mock' ? 'mock' : current.provider,
        sendingDomain: args.clear_sending_domain === true ? undefined : stringValue(args.sending_domain) ?? current.sendingDomain,
        fromEmail: args.clear_from_email === true ? undefined : stringValue(args.from_email) ?? current.fromEmail,
        fromName: args.clear_from_name === true ? undefined : stringValue(args.from_name) ?? current.fromName,
        defaultTimeoutMs: typeof args.default_timeout_ms === 'number' ? boundedTimeout(args.default_timeout_ms, current.defaultTimeoutMs) : current.defaultTimeoutMs,
      });
      const auth = resolveAuth(config);
      return { config, auth: { ...auth, credentialValue: undefined }, smtp: { host: SMTP_HOST, ports: SMTP_PORTS, username: 'resend', passwordSource: auth.credentialSource } };
    }
    case 'oauth_login_prepare':
      return prepareResendOAuthLogin(input.controllerHome, {
        redirectUri: stringValue(input.args.redirect_uri),
        scope: input.args.scope === 'emails:send' ? 'emails:send' : 'full_access',
      });
    case 'auth_status': {
      const auth = resolveAuth(current);
      if (current.provider === 'resend-api') await resendRequest(current, '/domains');
      return { provider: current.provider, ready: auth.ready, authenticated: auth.ready, probed: true, credentialSource: auth.credentialSource };
    }
    case 'list_domains':
      return resendRequest(current, '/domains');
    case 'get_domain':
      return resendRequest(current, `/domains/${encodeURIComponent(requiredString(input.args.domain_id, 'domain_id'))}`);
    case 'create_domain': {
      const name = requiredString(input.args.name, 'name').toLowerCase();
      const region = stringValue(input.args.region);
      return resendRequest(current, '/domains', {
        method: 'POST',
        body: {
          name,
          ...(region ? { region } : {}),
          capabilities: { sending: 'enabled', receiving: 'disabled' },
        },
      });
    }
    case 'verify_domain':
      return resendRequest(current, `/domains/${encodeURIComponent(requiredString(input.args.domain_id, 'domain_id'))}/verify`, { method: 'POST' });
    case 'smtp_status': {
      const domains = await resendRequest(current, '/domains');
      const configured = current.sendingDomain
        ? domainRows(domains).find((domain) => String(domain.name ?? '').toLowerCase() === current.sendingDomain)
        : undefined;
      const domainStatus = stringValue(configured?.status);
      return {
        provider: 'resend', ready: Boolean(apiKey().value || readStoredResendSmtpToken() || current.provider === 'mock') && domainStatus === 'verified' && Boolean(current.fromEmail),
        domain: current.sendingDomain, domainStatus: domainStatus ?? 'not_configured', fromEmail: current.fromEmail,
        smtp: { host: SMTP_HOST, ports: SMTP_PORTS, username: 'resend', passwordConfigured: Boolean(apiKey().value || readStoredResendSmtpToken() || current.provider === 'mock'), passwordSource: apiKey().value ? apiKey().source : readStoredResendSmtpToken() ? 'keychain:resend-smtp' : undefined, security: ['implicit_tls', 'starttls'] },
      };
    }
    case 'provision_smtp_credential': {
      if (current.provider === 'mock') return { provider: 'mock', stored: true, apiKeyId: 'api_key_mock', credentialStore: resendCredentialStoreStatus() };
      const response = await resendRequest(current, '/api-keys', {
        method: 'POST',
        body: { name: stringValue(input.args.name) ?? 'Forge SMTP', permission: 'sending_access' },
      });
      const token = stringValue(response.token);
      if (!token) throw new AssistantPluginError('PLUGIN_PROVIDER_RESPONSE_INVALID', 'Resend did not return the one-time SMTP API key token.');
      const apiKeyId = stringValue(response.id);
      writeStoredResendSmtpToken(token, apiKeyId);
      return { provider: 'resend', stored: true, apiKeyId, credentialStore: resendCredentialStoreStatus(), credentialMaterialReturned: false };
    }
    case 'send_email': {
      const to = stringArray(input.args.to);
      if (!to) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'to must contain at least one recipient.');
      const subject = requiredString(input.args.subject, 'subject');
      const text = stringValue(input.args.text);
      const html = stringValue(input.args.html);
      if (!text && !html) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'text or html is required.');
      const idempotencyKey = `forge-resend-${input.requestId}`.slice(0, 256);
      const response = await resendRequest(current, '/emails', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: {
          from: stringValue(input.args.from) ?? defaultFrom(current), to, subject,
          ...(text ? { text } : {}), ...(html ? { html } : {}),
          ...(stringArray(input.args.cc) ? { cc: stringArray(input.args.cc) } : {}),
          ...(stringArray(input.args.bcc) ? { bcc: stringArray(input.args.bcc) } : {}),
          ...(stringArray(input.args.reply_to) ? { reply_to: stringArray(input.args.reply_to) } : {}),
        },
      });
      return { provider: 'resend', status: 'sent', emailId: response.id, acceptedAt: now(), idempotencyKey };
    }
    case 'get_email': {
      const emailId = requiredString(input.args.email_id, 'email_id');
      const email = await resendRequest(current, `/emails/${encodeURIComponent(emailId)}`);
      return { provider: 'resend', status: stringValue(email.last_event) ?? 'unknown', email };
    }
    default:
      throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', `resend/${input.actionId} is not supported.`, { retryable: false });
  }
}

export const resendPluginAdapter = {
  pluginId: RESEND_PLUGIN_ID,
  buildManifest: buildResendPluginManifest,
  executeAction: executeResendPluginAction,
};
