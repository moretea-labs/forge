import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginCapability,
  AssistantPluginManifest,
  AssistantPluginPermissionScope,
} from './types';
import { AssistantPluginError } from './errors';
import {
  disableExternalPluginRegistration,
  getExternalPluginRegistration,
  installExternalPluginRegistration,
  listExternalPluginRegistrations,
  previewExternalPluginRegistration,
  removeExternalPluginRegistration,
  type ExternalPluginRegistrationInput,
} from './external-registration';

const PLUGIN_ID = 'plugin_management';

function now(): string { return new Date().toISOString(); }
function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `${field} is required.`);
  return value.trim();
}
function expectedRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'expected_revision must be a non-negative integer.');
  }
  return value;
}
function registrationInput(value: unknown): ExternalPluginRegistrationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'registration must be an object.');
  }
  return value as ExternalPluginRegistrationInput;
}

function permissions(): AssistantPluginPermissionScope[] {
  return [
    { scope: 'external-plugins.read', mode: 'read', description: 'Read and validate external plugin registrations.', granted: true, required: true },
    { scope: 'external-plugins.write', mode: 'write', description: 'Install, update, and disable validated external plugin registrations.', granted: true, required: true },
    { scope: 'external-plugins.remove', mode: 'write', description: 'Remove one external plugin registration after strong confirmation.', granted: true, required: true },
  ];
}

function capabilities(): AssistantPluginCapability[] {
  return [{
    capabilityId: 'external-plugin-registration-management',
    title: 'External Plugin Registration Management',
    description: 'Preview, install/update, inspect, disable, and remove external provider registrations through the canonical validation authority.',
    scopes: ['external-plugins.read', 'external-plugins.write', 'external-plugins.remove'],
    actions: ['list_registrations', 'get_registration', 'preview_registration', 'install_registration', 'disable_registration', 'remove_registration'],
  }];
}

const registrationProperty = { type: 'object', description: 'ExternalPluginRegistrationInput. Canonical Forge validation rejects invalid identity, transport, lifecycle, permissions, capabilities, and actions.' };
function actions(): AssistantPluginActionDescriptor[] {
  return [
    {
      actionId: 'list_registrations', title: 'List external plugin registrations', description: 'List canonical installed external plugin registrations.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 10_000, cancellable: true, idempotent: true,
      scopes: ['external-plugins.read'], resourceClaims: [{ resource: 'provider-state', mode: 'read' }],
      argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: 'get_registration', title: 'Get external plugin registration', description: 'Read one canonical external plugin registration.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 10_000, cancellable: true, idempotent: true,
      scopes: ['external-plugins.read'], resourceClaims: [{ resource: 'provider-state', mode: 'read' }],
      argumentsSchema: { type: 'object', properties: { plugin_id: { type: 'string' } }, required: ['plugin_id'], additionalProperties: false },
    },
    {
      actionId: 'preview_registration', title: 'Preview external plugin registration', description: 'Validate registration input and return its canonical fingerprint/revision plan without mutation.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 10_000, cancellable: true, idempotent: true,
      scopes: ['external-plugins.read'], resourceClaims: [{ resource: 'provider-state', mode: 'read' }],
      argumentsSchema: { type: 'object', properties: { registration: registrationProperty }, required: ['registration'], additionalProperties: false },
    },
    {
      actionId: 'install_registration', title: 'Install or update external plugin registration', description: 'Install/update through installExternalPluginRegistration with revision guarding.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 10_000, cancellable: true, idempotent: true,
      scopes: ['external-plugins.write'], resourceClaims: [{ resource: 'provider-state', mode: 'write' }],
      argumentsSchema: { type: 'object', properties: { registration: registrationProperty, expected_revision: { type: 'number' } }, required: ['registration'], additionalProperties: false },
    },
    {
      actionId: 'disable_registration', title: 'Disable external plugin registration', description: 'Disable one installed registration while preserving its audited identity and revision history.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 10_000, cancellable: true, idempotent: true,
      scopes: ['external-plugins.write'], resourceClaims: [{ resource: 'provider-state', mode: 'write' }],
      argumentsSchema: { type: 'object', properties: { plugin_id: { type: 'string' }, expected_revision: { type: 'number' } }, required: ['plugin_id'], additionalProperties: false },
    },
    {
      actionId: 'remove_registration', title: 'Remove external plugin registration', description: 'Explicitly remove one canonical external provider registration.',
      readOnly: false, risk: 'destructive', confirmation: 'strong_confirmation', requiredConfirmationText: 'remove-external-plugin-registration', defaultTimeoutMs: 10_000, cancellable: true, idempotent: true,
      scopes: ['external-plugins.remove'], resourceClaims: [{ resource: 'provider-state', mode: 'write' }],
      argumentsSchema: { type: 'object', properties: { plugin_id: { type: 'string' }, expected_revision: { type: 'number' } }, required: ['plugin_id'], additionalProperties: false },
    },
  ];
}

export function buildPluginManagementManifest(previousRevision = 0, previousUpdatedAt?: string): AssistantPluginManifest {
  return {
    schemaVersion: 1, manifestVersion: 1, revision: Math.max(1, previousRevision || 1), pluginId: PLUGIN_ID,
    provider: 'forge-controller', displayName: 'Forge Plugin Management', pluginVersion: '1.0.0',
    authority: { strategy: 'derived', duplicateStateAllowed: false, sourceOfTruth: ['controller-home:plugins/external/registrations'] },
    enabled: true, lifecycle: { state: 'enabled', reason: 'Canonical external plugin registration authority is available.' },
    health: { state: 'ready', checkedAt: now(), ready: true, probed: true, errors: [], warnings: [] },
    permissions: permissions(), capabilities: capabilities(), actions: actions(), updatedAt: previousUpdatedAt ?? now(),
  };
}

export async function executePluginManagementAction(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  switch (input.actionId) {
    case 'list_registrations': return { registrations: listExternalPluginRegistrations(input.controllerHome) };
    case 'get_registration': {
      const pluginId = requiredString(input.args.plugin_id, 'plugin_id');
      const registration = getExternalPluginRegistration(input.controllerHome, pluginId);
      if (!registration) throw new AssistantPluginError('PLUGIN_EXTERNAL_REGISTRATION_NOT_FOUND', `External plugin registration ${pluginId} was not found.`, { retryable: false });
      return { registration };
    }
    case 'preview_registration': return { preview: previewExternalPluginRegistration(input.controllerHome, registrationInput(input.args.registration)) };
    case 'install_registration': return { registration: installExternalPluginRegistration(input.controllerHome, registrationInput(input.args.registration), { expectedRevision: expectedRevision(input.args.expected_revision) }) };
    case 'disable_registration': return { registration: disableExternalPluginRegistration(input.controllerHome, requiredString(input.args.plugin_id, 'plugin_id'), { expectedRevision: expectedRevision(input.args.expected_revision) }) };
    case 'remove_registration': return { removed: removeExternalPluginRegistration(input.controllerHome, requiredString(input.args.plugin_id, 'plugin_id'), { expectedRevision: expectedRevision(input.args.expected_revision) }) };
    default: throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', `${PLUGIN_ID}/${input.actionId} is not supported.`, { retryable: false });
  }
}

function affectedPluginIdsAfterAction(actionId: string, result: Record<string, unknown>): string[] {
  if (!['install_registration', 'disable_registration', 'remove_registration'].includes(actionId)) return [];
  const value = (result.registration ?? result.removed) as { pluginId?: unknown } | undefined;
  return typeof value?.pluginId === 'string' && value.pluginId.trim() ? [value.pluginId.trim()] : [];
}

export const pluginManagementAdapter = {
  pluginId: PLUGIN_ID,
  scope: 'controller' as const,
  buildManifest: buildPluginManagementManifest,
  executeAction: executePluginManagementAction,
  affectedPluginIdsAfterAction,
};
