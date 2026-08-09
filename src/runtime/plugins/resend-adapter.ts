import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginCapability,
  AssistantPluginHealth,
  AssistantPluginManifest,
  AssistantPluginPermissionScope,
} from './types';
import { AssistantPluginError, toAssistantPluginError } from './errors';

const RESEND_PLUGIN_ID = 'resend';
const CONFIG_ROOT = '.forge/plugins';
const API_BASE_URL = 'https://api.resend.com';
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

function configPath(repoRoot: string): string {
  return join(repoRoot, CONFIG_ROOT, 'resend.json');
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

function loadConfig(repoRoot: string): ResendPluginConfig {
  const path = configPath(repoRoot);
  if (!existsSync(path)) return normalizeConfig({});
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, 'utf8')) as Partial<ResendPluginConfig>);
  } catch {
    return normalizeConfig({});
  }
}

function saveConfig(repoRoot: string, patch: Partial<ResendPluginConfig>): ResendPluginConfig {
  const next = normalizeConfig({ ...loadConfig(repoRoot), ...patch });
  const path = configPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
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
  if (!credential.value) {
    return {
      ready: false,
      authenticated: false,
      probed: false,
      errors: ['Set FORGE_RESEND_API_KEY or RESEND_API_KEY before invoking live Resend actions.'],
      warnings: [],
    };
  }
  return {
    ready: true,
    authenticated: true,
    probed: false,
    credentialSource: credential.source,
    errors: [],
    warnings: [],
  };
}

function health(config: ResendPluginConfig, auth: ResendAuthState): AssistantPluginHealth {
  if (!config.enabled) {
    return {
      state: 'disabled', checkedAt: now(), ready: false, probed: false,
      errors: [], warnings: ['Plugin is disabled. Enable it before using Resend provider actions.'],
      details: { provider: config.provider, credentialPersistence: 'API keys are read from process environment and are never persisted by Forge' },
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
      credentialPersistence: 'API keys are read from process environment and are never persisted by Forge',
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
      actions: ['auth_status', 'list_domains', 'get_domain', 'smtp_status', 'get_email'],
    },
    {
      capabilityId: 'resend-domain',
      title: 'Resend Domain Verification',
      description: 'Trigger verification for one exact domain after explicit authorization.',
      scopes: ['resend.domain.write'],
      actions: ['verify_domain'],
    },
    {
      capabilityId: 'resend-delivery',
      title: 'Resend Email Delivery',
      description: 'Send a message only after strong confirmation and return a provider receipt for status follow-up.',
      scopes: ['resend.send'],
      actions: ['send_email'],
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
      actionId: 'verify_domain', title: 'Verify Resend domain', description: 'Trigger asynchronous verification for one exact Resend domain.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 45_000,
      cancellable: true, idempotent: false, scopes: ['resend.domain.write'], resourceClaims: [{ resource: 'remote', mode: 'exclusive' }],
      argumentsSchema: { type: 'object', properties: { domain_id: { type: 'string' } }, required: ['domain_id'], additionalProperties: false },
    },
    {
      actionId: 'send_email', title: 'Send email with Resend', description: 'Send one email through Resend after strong confirmation.',
      readOnly: false, risk: 'remote_write', confirmation: 'strong_confirmation', requiredConfirmationText: 'send-resend-email',
      defaultTimeoutMs: 45_000, cancellable: true, idempotent: false, scopes: ['resend.send'], resourceClaims: [{ resource: 'remote', mode: 'exclusive' }],
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
  init: { method?: string; body?: Record<string, unknown> } = {},
): Promise<Record<string, unknown>> {
  if (config.provider === 'mock') {
    if (path === '/domains') return { object: 'list', has_more: false, data: config.sendingDomain ? [{ id: 'domain_mock', name: config.sendingDomain, status: 'verified' }] : [] };
    if (path.startsWith('/domains/domain_mock')) return { object: 'domain', id: 'domain_mock', name: config.sendingDomain, status: 'verified', records: [] };
    if (path === '/emails' && init.method === 'POST') return { id: 'email_mock' };
    if (path === '/emails/email_mock') return { object: 'email', id: 'email_mock', last_event: 'sent' };
    return { object: 'mock', ok: true };
  }

  const credential = apiKey();
  if (!credential.value) throw new AssistantPluginError('PLUGIN_AUTH_REQUIRED', 'Resend API key is required.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.defaultTimeoutMs);
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${credential.value}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
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

export function buildResendPluginManifest(previousRevision = 0, previousUpdatedAt?: string, repoRoot?: string): AssistantPluginManifest {
  const root = repoRoot ?? process.cwd();
  const config = loadConfig(root);
  const auth = resolveAuth(config);
  return {
    schemaVersion: 1, manifestVersion: 1, revision: Math.max(1, previousRevision || 1),
    pluginId: RESEND_PLUGIN_ID, provider: 'resend', displayName: 'Resend Email Plugin', pluginVersion: '1.0.0',
    authority: { strategy: 'derived', duplicateStateAllowed: false, sourceOfTruth: ['repo-local:.forge/plugins/resend.json', 'env:FORGE_RESEND_API_KEY|RESEND_API_KEY'] },
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
  const current = loadConfig(input.repoRoot);
  switch (input.actionId) {
    case 'configure': {
      const args = input.args;
      const config = saveConfig(input.repoRoot, {
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
    case 'auth_status': {
      const auth = resolveAuth(current);
      if (current.provider === 'resend-api') await resendRequest(current, '/domains');
      return { provider: current.provider, ready: auth.ready, authenticated: auth.ready, probed: true, credentialSource: auth.credentialSource };
    }
    case 'list_domains':
      return resendRequest(current, '/domains');
    case 'get_domain':
      return resendRequest(current, `/domains/${encodeURIComponent(requiredString(input.args.domain_id, 'domain_id'))}`);
    case 'verify_domain':
      return resendRequest(current, `/domains/${encodeURIComponent(requiredString(input.args.domain_id, 'domain_id'))}/verify`, { method: 'POST' });
    case 'smtp_status': {
      const domains = await resendRequest(current, '/domains');
      const configured = current.sendingDomain
        ? domainRows(domains).find((domain) => String(domain.name ?? '').toLowerCase() === current.sendingDomain)
        : undefined;
      const domainStatus = stringValue(configured?.status);
      return {
        provider: 'resend', ready: Boolean(apiKey().value || current.provider === 'mock') && domainStatus === 'verified' && Boolean(current.fromEmail),
        domain: current.sendingDomain, domainStatus: domainStatus ?? 'not_configured', fromEmail: current.fromEmail,
        smtp: { host: SMTP_HOST, ports: SMTP_PORTS, username: 'resend', passwordConfigured: Boolean(apiKey().value || current.provider === 'mock'), security: ['implicit_tls', 'starttls'] },
      };
    }
    case 'send_email': {
      const to = stringArray(input.args.to);
      if (!to) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'to must contain at least one recipient.');
      const subject = requiredString(input.args.subject, 'subject');
      const text = stringValue(input.args.text);
      const html = stringValue(input.args.html);
      if (!text && !html) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'text or html is required.');
      const response = await resendRequest(current, '/emails', {
        method: 'POST',
        body: {
          from: stringValue(input.args.from) ?? defaultFrom(current), to, subject,
          ...(text ? { text } : {}), ...(html ? { html } : {}),
          ...(stringArray(input.args.cc) ? { cc: stringArray(input.args.cc) } : {}),
          ...(stringArray(input.args.bcc) ? { bcc: stringArray(input.args.bcc) } : {}),
          ...(stringArray(input.args.reply_to) ? { reply_to: stringArray(input.args.reply_to) } : {}),
        },
      });
      return { provider: 'resend', status: 'sent', emailId: response.id, acceptedAt: now() };
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
