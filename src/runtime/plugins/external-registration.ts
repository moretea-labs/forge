import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { isAbsolute, join } from 'path';
import { controllerSystemRoot, ensureControllerHome } from '../../cli/repositories/controller-home';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../shared/json-files';
import type {
  AssistantPluginActionDescriptor,
  AssistantPluginCapability,
  AssistantPluginPermissionScope,
  AssistantPluginScope,
} from './types';

const EXTERNAL_REGISTRATION_SCHEMA_VERSION = 1;
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const PROTOCOL_VERSION_PATTERN = /^\d+\.\d+$/;

export interface ExternalPluginUnixSocketTransport {
  kind: 'unix_socket_jsonl';
  socketPath: string;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  healthTimeoutMs?: number;
  actionTimeoutMs?: number;
}

export interface ExternalPluginManagedCliTransport {
  kind: 'managed_cli_json';
  runtimeExecutable: string;
  helperPath: string;
  runtimeArgs?: string[];
  cwd?: string;
  requiredCapabilities?: string[];
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  healthTimeoutMs?: number;
  actionTimeoutMs?: number;
}

export type ExternalPluginTransport = ExternalPluginUnixSocketTransport | ExternalPluginManagedCliTransport;

export interface ExternalPluginVerifiedUserLaunchAgentLifecycle {
  kind: 'verified_user_launch_agent';
  label: string;
  expectedProgramContains: string;
}

export type ExternalPluginLifecycle = ExternalPluginVerifiedUserLaunchAgentLifecycle;

export interface ExternalPluginRegistration {
  schemaVersion: 1;
  revision: number;
  pluginId: string;
  providerPluginId: string;
  displayName: string;
  provider: string;
  pluginVersion: string;
  protocolVersion: string;
  scope: AssistantPluginScope;
  enabled: boolean;
  /** Product registrations appear in normal plugin listings; provider registrations are internal implementation bindings. */
  exposure?: 'product' | 'provider';
  transport: ExternalPluginTransport;
  lifecycle?: ExternalPluginLifecycle;
  permissions: AssistantPluginPermissionScope[];
  capabilities: AssistantPluginCapability[];
  actions: AssistantPluginActionDescriptor[];
  legacyIdentities?: string[];
  registrationFingerprint: string;
  installedAt: string;
  updatedAt: string;
}

export interface ExternalPluginRegistrationInput {
  pluginId: string;
  providerPluginId?: string;
  displayName: string;
  provider: string;
  pluginVersion: string;
  protocolVersion: string;
  scope: AssistantPluginScope;
  enabled?: boolean;
  /** Defaults to product for backward compatibility with schema-v1 registrations. */
  exposure?: 'product' | 'provider';
  transport: ExternalPluginTransport;
  lifecycle?: ExternalPluginLifecycle;
  permissions: AssistantPluginPermissionScope[];
  capabilities: AssistantPluginCapability[];
  actions: AssistantPluginActionDescriptor[];
  legacyIdentities?: string[];
}

function registrationRoot(controllerHome: string): string {
  ensureControllerHome(controllerHome);
  return join(controllerSystemRoot(controllerHome), 'plugins', 'external', 'registrations');
}

export function externalPluginRegistrationPath(controllerHome: string, pluginId: string): string {
  return join(registrationRoot(controllerHome), `${sanitizeFileComponent(pluginId)}.json`);
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function normalizedTransport(input: ExternalPluginTransport): ExternalPluginTransport {
  if (input.kind === 'unix_socket_jsonl') {
    const socketPath = input.socketPath.trim();
    if (!socketPath || !isAbsolute(socketPath)) {
      throw new Error('EXTERNAL_PLUGIN_SOCKET_PATH_INVALID: trusted registrations require an absolute Unix socket path');
    }
    return {
      kind: 'unix_socket_jsonl',
      socketPath,
      maxRequestBytes: boundedInteger(input.maxRequestBytes, 1_048_576, 1_024, 4 * 1_048_576),
      maxResponseBytes: boundedInteger(input.maxResponseBytes, 1_048_576, 1_024, 16 * 1_048_576),
      healthTimeoutMs: boundedInteger(input.healthTimeoutMs, 2_000, 100, 10_000),
      actionTimeoutMs: boundedInteger(input.actionTimeoutMs, 30_000, 100, 120_000),
    };
  }
  if (input.kind === 'managed_cli_json') {
    const runtimeExecutable = input.runtimeExecutable.trim();
    const helperPath = input.helperPath.trim();
    const cwd = input.cwd?.trim();
    if (!runtimeExecutable || !isAbsolute(runtimeExecutable)) throw new Error('EXTERNAL_PLUGIN_MANAGED_RUNTIME_INVALID: trusted registrations require an absolute runtime executable');
    if (!helperPath || !isAbsolute(helperPath)) throw new Error('EXTERNAL_PLUGIN_MANAGED_HELPER_INVALID: trusted registrations require an absolute helper path');
    if (cwd && !isAbsolute(cwd)) throw new Error('EXTERNAL_PLUGIN_MANAGED_CWD_INVALID: trusted registrations require an absolute cwd');
    const runtimeArgs = (input.runtimeArgs ?? []).map((value) => value.trim()).filter(Boolean);
    if (runtimeArgs.length > 20 || runtimeArgs.some((value) => value.length > 1_000)) throw new Error('EXTERNAL_PLUGIN_MANAGED_RUNTIME_ARGS_INVALID');
    const requiredCapabilities = Array.from(new Set((input.requiredCapabilities ?? []).map((value) => value.trim()).filter(Boolean)));
    if (requiredCapabilities.length > 100 || requiredCapabilities.some((value) => value.length > 128)) throw new Error('EXTERNAL_PLUGIN_MANAGED_CAPABILITIES_INVALID');
    return {
      kind: 'managed_cli_json', runtimeExecutable, helperPath,
      runtimeArgs,
      cwd,
      requiredCapabilities,
      maxRequestBytes: boundedInteger(input.maxRequestBytes, 1_048_576, 1_024, 16 * 1_048_576),
      maxResponseBytes: boundedInteger(input.maxResponseBytes, 1_048_576, 1_024, 16 * 1_048_576),
      healthTimeoutMs: boundedInteger(input.healthTimeoutMs, 2_000, 100, 10_000),
      actionTimeoutMs: boundedInteger(input.actionTimeoutMs, 30_000, 100, 120_000),
    };
  }
  throw new Error(`EXTERNAL_PLUGIN_TRANSPORT_UNSUPPORTED: ${String((input as { kind?: unknown }).kind)}`);
}

function normalizedString(value: string, field: string, max = 256): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`EXTERNAL_PLUGIN_${field.toUpperCase()}_REQUIRED`);
  return normalized.slice(0, max);
}

function assertPluginId(value: string, field: string): string {
  const normalized = value.trim();
  if (!PLUGIN_ID_PATTERN.test(normalized)) throw new Error(`EXTERNAL_PLUGIN_${field.toUpperCase()}_INVALID: ${normalized}`);
  return normalized;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

function registrationFingerprint(input: Omit<ExternalPluginRegistration, 'revision' | 'registrationFingerprint' | 'installedAt' | 'updatedAt'>): string {
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}

function normalizedLifecycle(input: ExternalPluginLifecycle | undefined): ExternalPluginLifecycle | undefined {
  if (!input) return undefined;
  if (input.kind !== 'verified_user_launch_agent') throw new Error(`EXTERNAL_PLUGIN_LIFECYCLE_UNSUPPORTED: ${String((input as { kind?: unknown }).kind)}`);
  const label = input.label.trim();
  if (!/^[A-Za-z0-9._-]{3,200}$/.test(label)) throw new Error(`EXTERNAL_PLUGIN_LIFECYCLE_LABEL_INVALID: ${label}`);
  const expectedProgramContains = input.expectedProgramContains.trim();
  if (expectedProgramContains.length < 4 || expectedProgramContains.length > 1024) throw new Error('EXTERNAL_PLUGIN_LIFECYCLE_PROGRAM_IDENTITY_INVALID');
  return { kind: 'verified_user_launch_agent', label, expectedProgramContains };
}

function validatePolicy(input: ExternalPluginRegistrationInput): void {
  const permissionScopes = new Set<string>();
  for (const permission of input.permissions) {
    const scope = normalizedString(permission.scope, 'permission_scope', 128);
    if (permissionScopes.has(scope)) throw new Error(`EXTERNAL_PLUGIN_PERMISSION_DUPLICATE: ${scope}`);
    permissionScopes.add(scope);
  }

  const actionIds = new Set<string>();
  for (const action of input.actions) {
    const actionId = normalizedString(action.actionId, 'action_id', 128);
    if (actionIds.has(actionId)) throw new Error(`EXTERNAL_PLUGIN_ACTION_DUPLICATE: ${actionId}`);
    actionIds.add(actionId);
    for (const scope of action.scopes) {
      if (!permissionScopes.has(scope)) throw new Error(`EXTERNAL_PLUGIN_ACTION_SCOPE_UNDECLARED: ${actionId}/${scope}`);
    }
    if (action.readOnly && action.risk !== 'readonly') throw new Error(`EXTERNAL_PLUGIN_ACTION_RISK_INVALID: read-only action ${actionId} must use readonly risk`);
    if (!action.readOnly && action.risk === 'readonly') throw new Error(`EXTERNAL_PLUGIN_ACTION_RISK_INVALID: write action ${actionId} cannot use readonly risk`);
    if (action.risk === 'destructive' && action.confirmation !== 'strong_confirmation') {
      throw new Error(`EXTERNAL_PLUGIN_DESTRUCTIVE_CONFIRMATION_REQUIRED: ${actionId}`);
    }
  }

  if (input.lifecycle) {
    const reservedActions = new Set(['provider_start', 'provider_stop', 'provider_restart']);
    for (const actionId of actionIds) {
      if (reservedActions.has(actionId)) throw new Error(`EXTERNAL_PLUGIN_LIFECYCLE_ACTION_RESERVED: ${actionId}`);
    }
    if (permissionScopes.has('external-provider.lifecycle')) throw new Error('EXTERNAL_PLUGIN_LIFECYCLE_SCOPE_RESERVED');
  }

  const capabilityIds = new Set<string>();
  for (const capability of input.capabilities) {
    const capabilityId = normalizedString(capability.capabilityId, 'capability_id', 128);
    if (capabilityIds.has(capabilityId)) throw new Error(`EXTERNAL_PLUGIN_CAPABILITY_DUPLICATE: ${capabilityId}`);
    capabilityIds.add(capabilityId);
    if (input.lifecycle && capabilityId === 'external-provider-lifecycle') throw new Error('EXTERNAL_PLUGIN_LIFECYCLE_CAPABILITY_RESERVED');
    for (const actionId of capability.actions) {
      if (!actionIds.has(actionId)) throw new Error(`EXTERNAL_PLUGIN_CAPABILITY_ACTION_UNKNOWN: ${capabilityId}/${actionId}`);
    }
    for (const scope of capability.scopes) {
      if (!permissionScopes.has(scope)) throw new Error(`EXTERNAL_PLUGIN_CAPABILITY_SCOPE_UNDECLARED: ${capabilityId}/${scope}`);
    }
  }
}

function normalizeRegistrationInput(input: ExternalPluginRegistrationInput): Omit<ExternalPluginRegistration, 'revision' | 'registrationFingerprint' | 'installedAt' | 'updatedAt'> {
  validatePolicy(input);
  const pluginId = assertPluginId(input.pluginId, 'plugin_id');
  const providerPluginId = assertPluginId(input.providerPluginId ?? pluginId, 'provider_plugin_id');
  const protocolVersion = normalizedString(input.protocolVersion, 'protocol_version', 32);
  if (!PROTOCOL_VERSION_PATTERN.test(protocolVersion)) throw new Error(`EXTERNAL_PLUGIN_PROTOCOL_VERSION_INVALID: ${protocolVersion}`);
  if (!['controller', 'repository'].includes(input.scope)) throw new Error(`EXTERNAL_PLUGIN_SCOPE_INVALID: ${String(input.scope)}`);
  if (input.exposure !== undefined && !['product', 'provider'].includes(input.exposure)) {
    throw new Error(`EXTERNAL_PLUGIN_EXPOSURE_INVALID: ${String(input.exposure)}`);
  }
  return {
    schemaVersion: EXTERNAL_REGISTRATION_SCHEMA_VERSION,
    pluginId,
    providerPluginId,
    displayName: normalizedString(input.displayName, 'display_name'),
    provider: normalizedString(input.provider, 'provider'),
    pluginVersion: normalizedString(input.pluginVersion, 'plugin_version', 64),
    protocolVersion,
    scope: input.scope,
    enabled: input.enabled !== false,
    ...(input.exposure !== undefined ? { exposure: input.exposure } : {}),
    transport: normalizedTransport(input.transport),
    lifecycle: normalizedLifecycle(input.lifecycle),
    permissions: structuredClone(input.permissions),
    capabilities: structuredClone(input.capabilities),
    actions: structuredClone(input.actions),
    legacyIdentities: Array.from(new Set((input.legacyIdentities ?? []).map((value) => value.trim()).filter(Boolean))).slice(0, 20),
  };
}

export function validateExternalPluginRegistration(value: ExternalPluginRegistration): ExternalPluginRegistration {
  if (value.schemaVersion !== EXTERNAL_REGISTRATION_SCHEMA_VERSION) throw new Error('EXTERNAL_PLUGIN_REGISTRATION_SCHEMA_UNSUPPORTED');
  const normalized = normalizeRegistrationInput(value);
  if (!Number.isInteger(value.revision) || value.revision < 1) throw new Error('EXTERNAL_PLUGIN_REGISTRATION_REVISION_INVALID');
  if (!value.installedAt || !value.updatedAt) throw new Error('EXTERNAL_PLUGIN_REGISTRATION_TIMESTAMP_REQUIRED');
  const expectedFingerprint = registrationFingerprint(normalized);
  if (value.registrationFingerprint !== expectedFingerprint) throw new Error('EXTERNAL_PLUGIN_REGISTRATION_FINGERPRINT_MISMATCH');
  return {
    ...normalized,
    revision: value.revision,
    registrationFingerprint: expectedFingerprint,
    installedAt: value.installedAt,
    updatedAt: value.updatedAt,
  };
}

export function getExternalPluginRegistration(controllerHome: string, pluginId: string): ExternalPluginRegistration | undefined {
  const path = externalPluginRegistrationPath(controllerHome, pluginId);
  if (!existsSync(path)) return undefined;
  return validateExternalPluginRegistration(readJsonFile<ExternalPluginRegistration>(path));
}

export function listExternalPluginRegistrations(controllerHome: string): ExternalPluginRegistration[] {
  const root = registrationRoot(controllerHome);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .flatMap((entry) => {
      try {
        return [validateExternalPluginRegistration(readJsonFile<ExternalPluginRegistration>(join(root, entry.name)))];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

export interface ExternalPluginRegistrationPreview {
  pluginId: string;
  currentRevision: number;
  nextRevision: number;
  registrationFingerprint: string;
  currentFingerprint?: string;
  wouldChange: boolean;
  registration: Omit<ExternalPluginRegistration, 'revision' | 'registrationFingerprint' | 'installedAt' | 'updatedAt'>;
}

export function previewExternalPluginRegistration(
  controllerHome: string,
  input: ExternalPluginRegistrationInput,
): ExternalPluginRegistrationPreview {
  const normalized = normalizeRegistrationInput(input);
  const existing = getExternalPluginRegistration(controllerHome, normalized.pluginId);
  const fingerprint = registrationFingerprint(normalized);
  return {
    pluginId: normalized.pluginId,
    currentRevision: existing?.revision ?? 0,
    nextRevision: existing && existing.registrationFingerprint === fingerprint ? existing.revision : (existing?.revision ?? 0) + 1,
    registrationFingerprint: fingerprint,
    currentFingerprint: existing?.registrationFingerprint,
    wouldChange: existing?.registrationFingerprint !== fingerprint,
    registration: normalized,
  };
}

export function installExternalPluginRegistration(
  controllerHome: string,
  input: ExternalPluginRegistrationInput,
  options: { expectedRevision?: number; now?: Date } = {},
): ExternalPluginRegistration {
  const normalized = normalizeRegistrationInput(input);
  const existing = getExternalPluginRegistration(controllerHome, normalized.pluginId);
  const fingerprint = registrationFingerprint(normalized);
  // Identical desired state is idempotent, including a replay carrying the old
  // expected revision after the first write committed.
  if (existing?.registrationFingerprint === fingerprint) return existing;
  const currentRevision = existing?.revision ?? 0;
  if (options.expectedRevision !== undefined && currentRevision !== options.expectedRevision) {
    throw new Error(`EXTERNAL_PLUGIN_REGISTRATION_REVISION_CONFLICT: expected ${options.expectedRevision}, current ${currentRevision}`);
  }
  const at = (options.now ?? new Date()).toISOString();
  const next: ExternalPluginRegistration = {
    ...normalized,
    revision: currentRevision + 1,
    registrationFingerprint: fingerprint,
    installedAt: existing?.installedAt ?? at,
    updatedAt: at,
  };
  mkdirSync(registrationRoot(controllerHome), { recursive: true, mode: 0o700 });
  writeJsonAtomic(externalPluginRegistrationPath(controllerHome, next.pluginId), next);
  return next;
}

function registrationInputFromStored(
  registration: ExternalPluginRegistration,
  patch: Partial<Pick<ExternalPluginRegistrationInput, 'enabled'>> = {},
): ExternalPluginRegistrationInput {
  return {
    pluginId: registration.pluginId,
    providerPluginId: registration.providerPluginId,
    displayName: registration.displayName,
    provider: registration.provider,
    pluginVersion: registration.pluginVersion,
    protocolVersion: registration.protocolVersion,
    scope: registration.scope,
    enabled: patch.enabled ?? registration.enabled,
    transport: structuredClone(registration.transport),
    lifecycle: registration.lifecycle ? structuredClone(registration.lifecycle) : undefined,
    permissions: structuredClone(registration.permissions),
    capabilities: structuredClone(registration.capabilities),
    actions: structuredClone(registration.actions),
    legacyIdentities: [...(registration.legacyIdentities ?? [])],
  };
}

export function disableExternalPluginRegistration(
  controllerHome: string,
  pluginId: string,
  options: { expectedRevision?: number; now?: Date } = {},
): ExternalPluginRegistration {
  const existing = getExternalPluginRegistration(controllerHome, pluginId);
  if (!existing) throw new Error(`EXTERNAL_PLUGIN_REGISTRATION_NOT_FOUND: ${pluginId}`);
  return installExternalPluginRegistration(controllerHome, registrationInputFromStored(existing, { enabled: false }), options);
}

export function removeExternalPluginRegistration(
  controllerHome: string,
  pluginId: string,
  options: { expectedRevision?: number } = {},
): ExternalPluginRegistration {
  const existing = getExternalPluginRegistration(controllerHome, pluginId);
  if (!existing) throw new Error(`EXTERNAL_PLUGIN_REGISTRATION_NOT_FOUND: ${pluginId}`);
  if (options.expectedRevision !== undefined && existing.revision !== options.expectedRevision) {
    throw new Error(`EXTERNAL_PLUGIN_REGISTRATION_REVISION_CONFLICT: expected ${options.expectedRevision}, current ${existing.revision}`);
  }
  rmSync(externalPluginRegistrationPath(controllerHome, existing.pluginId));
  return existing;
}
