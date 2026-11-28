import { createHash, randomUUID } from 'crypto';
import {
  parseCanonicalChatgptConversationIdentity,
  type ComputerChatgptConversationIdentity,
  type ComputerChatgptTargetIdentity,
} from '../../../packages/plugin-runtime/computer';
import type {
  ComputerApplicationLaunchProvenance,
  ComputerApplicationTarget,
  ComputerApplicationStableIdentity,
  ComputerApplicationTargetLease,
} from '../../../packages/plugin-runtime/computer/target-authority';
import {
  COMPUTER_CAPTURE_CAPABILITY,
  COMPUTER_CONSOLE_UNLOCK_CAPABILITY,
  COMPUTER_ELEMENT_ACTION_CAPABILITY,
  COMPUTER_ELEMENT_OBSERVE_CAPABILITY,
  COMPUTER_INPUT_CAPABILITY,
  COMPUTER_OBSERVE_CAPABILITY,
  type ComputerConsoleUnlockCommandRequest,
  type ComputerConsoleUnlockPrepareRequest,
  type ComputerConsoleUnlockRequest,
  type ComputerElementSemanticAction,
  type ComputerElementTarget,
  type ComputerRuntimeExecutionRequest,
  type ComputerSemanticSelector,
} from '../../../packages/protocols/computer/index';
import { executeRuntimeComputer, executeRuntimeComputerConsoleUnlock } from '../root/computer-composition';
import {
  runtimeComputerChatgptAction,
  runtimeComputerChatgptInventory,
  runtimeComputerChatgptLiveProviderStatus,
} from '../root/computer-chatgpt-target';
import { runtimeComputerInteractionTargetAuthority } from '../root/computer-target-composition';
import { currentComputerPlatform } from '../platform/computer-platform';
import {
  probeWindowsComputerObservation,
  resolveWindowsComputerPowerShell,
} from '../platform/windows-computer-observation';
import { createWindowsDesktopSessionProvider, WINDOWS_COMPUTER_PROVIDER_ID } from '../platform/windows-computer-target';
import { isProcessAlive } from '../shared/process-tree';
import {
  buildBrowserPluginManifest,
  executeBrowserPluginAction,
  resolveBrowserPluginAuthorizationContext,
} from './browser-adapter';
import { desktopOperatorActions, DESKTOP_OPERATOR_PROVIDER_STATE_WRITE_CLAIMS } from './desktop-operator-registration';
import { getExternalPluginAdapter } from './external-adapter';
import { AssistantPluginError } from './errors';
import {
  executeIosPhysicalDeviceAction,
  iosPhysicalDeviceActions,
  iosPhysicalDeviceCapabilities,
  iosPhysicalDeviceStatus,
  isIosPhysicalDeviceAction,
  resolveIosPhysicalDeviceAuthorizationContext,
} from './ios-physical-device';
import { remoteXpcHidCachedStatus } from './ios/remote-xpc-hid';
import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginAdapter,
  AssistantPluginAuthorizationContext,
  AssistantPluginBuildContext,
  AssistantPluginCapability,
  AssistantPluginManifest,
  AssistantPluginPermissionScope,
} from './types';

const COMPUTER_CHATGPT_TARGET_INVENTORY_ACTION = 'chatgpt_target_inventory';
const COMPUTER_CHATGPT_TARGET_ENSURE_ACTION = 'chatgpt_target_ensure';
const COMPUTER_CHATGPT_TARGET_OBSERVE_ACTION = 'chatgpt_target_observe';
const COMPUTER_CHATGPT_TARGET_REFRESH_ACTION = 'chatgpt_target_refresh';
const COMPUTER_CHATGPT_TARGET_PROMOTE_ACTION = 'chatgpt_target_promote';
const COMPUTER_CHATGPT_TARGET_FIND_MARKER_ACTION = 'chatgpt_target_find_marker';
const COMPUTER_CHATGPT_TARGET_PREPARE_ACTION = 'chatgpt_target_prepare';
const COMPUTER_CHATGPT_TARGET_DISPATCH_ACTION = 'chatgpt_target_dispatch';
const COMPUTER_CHATGPT_TARGET_ACTION_IDS = new Set([
  COMPUTER_CHATGPT_TARGET_INVENTORY_ACTION,
  COMPUTER_CHATGPT_TARGET_ENSURE_ACTION,
  COMPUTER_CHATGPT_TARGET_OBSERVE_ACTION,
  COMPUTER_CHATGPT_TARGET_REFRESH_ACTION,
  COMPUTER_CHATGPT_TARGET_PROMOTE_ACTION,
  COMPUTER_CHATGPT_TARGET_FIND_MARKER_ACTION,
  COMPUTER_CHATGPT_TARGET_PREPARE_ACTION,
  COMPUTER_CHATGPT_TARGET_DISPATCH_ACTION,
]);

const DESKTOP_PROVIDER_ID = 'desktop_operator';
function activeDesktopProviderId(): string {
  return currentComputerPlatform() === 'linux' ? WINDOWS_COMPUTER_PROVIDER_ID : DESKTOP_PROVIDER_ID;
}
type DesktopSessionProvider = Pick<AssistantPluginAdapter, 'executeAction' | 'resolveAuthorizationContext'>;
const computerTargetAuthority = runtimeComputerInteractionTargetAuthority();
const DESKTOP_TARGET_LIST_ACTION = 'desktop_target_list';
const DESKTOP_TARGET_OPEN_ACTION = 'desktop_target_open';
const DESKTOP_TARGET_CLOSE_ACTION = 'desktop_target_close';
const DESKTOP_ELEMENT_OBSERVE_ACTION = 'desktop_element_observe';
const DESKTOP_ELEMENT_ACTION_ACTION = 'desktop_element_action';
export const COMPUTER_CONSOLE_UNLOCK_PREPARE_ACTION = 'console_unlock_prepare';
export const COMPUTER_CONSOLE_UNLOCK_ACTION = 'console_unlock';
export const COMPUTER_CONSOLE_UNLOCK_ENROLL_ACTION = 'console_unlock_enroll';
export const COMPUTER_CONSOLE_UNLOCK_STATUS_ACTION = 'console_unlock_status';
export const COMPUTER_CONSOLE_UNLOCK_RECOVER_ACTION = 'console_unlock_recover';
export const COMPUTER_CONSOLE_UNLOCK_REVOKE_ACTION = 'console_unlock_revoke';
const DEFAULT_CONSOLE_UNLOCK_TIMEOUT_MS = 15_000;
const MAX_CONSOLE_UNLOCK_TIMEOUT_MS = 30_000;
const CONSOLE_CREDENTIAL_HANDLE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPUTER_ELEMENT_SEMANTIC_ACTIONS = [
  'invoke',
  'click',
  'focus',
  'set_value',
  'toggle',
  'expand',
  'collapse',
  'select',
  'open',
  'show_menu',
  'scroll_page_down',
  'scroll_page_up',
] as const;
const DESKTOP_SEMANTIC_ACTION_IDS = new Set([
  'desktop_observe',
  'desktop_press',
  'desktop_select_rows',
  'desktop_type_text',
  'desktop_key',
  'desktop_open_url',
  'desktop_screenshot',
]);
const DESKTOP_PRODUCT_ACTION_IDS = new Set([
  DESKTOP_TARGET_LIST_ACTION,
  DESKTOP_TARGET_OPEN_ACTION,
  DESKTOP_TARGET_CLOSE_ACTION,
  ...DESKTOP_SEMANTIC_ACTION_IDS,
  DESKTOP_ELEMENT_OBSERVE_ACTION,
  DESKTOP_ELEMENT_ACTION_ACTION,
  COMPUTER_CONSOLE_UNLOCK_PREPARE_ACTION,
  COMPUTER_CONSOLE_UNLOCK_ACTION,
  COMPUTER_CONSOLE_UNLOCK_ENROLL_ACTION,
  COMPUTER_CONSOLE_UNLOCK_STATUS_ACTION,
  COMPUTER_CONSOLE_UNLOCK_RECOVER_ACTION,
  COMPUTER_CONSOLE_UNLOCK_REVOKE_ACTION,
]);

function providerActionDescriptor(actionId: string): AssistantPluginActionDescriptor {
  const descriptor = desktopOperatorActions().find((action) => action.actionId === actionId);
  if (!descriptor) throw new Error(`COMPUTER_DESKTOP_ACTION_DESCRIPTOR_MISSING: ${actionId}`);
  return structuredClone(descriptor);
}

function targetBoundDescriptor(actionId: string): AssistantPluginActionDescriptor {
  const descriptor = providerActionDescriptor(actionId);
  const schema = structuredClone(descriptor.argumentsSchema) as Record<string, unknown>;
  const properties =
    schema.properties && typeof schema.properties === 'object'
      ? { ...(schema.properties as Record<string, unknown>) }
      : {};
  if ('interaction_id' in properties) {
    delete properties.interaction_id;
    properties.target_id = { type: 'string', description: 'Forge-owned durable Computer target id.' };
    schema.properties = properties;
    if (Array.isArray(schema.required)) {
      schema.required = schema.required.map((value) => (value === 'interaction_id' ? 'target_id' : value));
    }
  }
  return { ...descriptor, argumentsSchema: schema };
}

export interface ProtectedConsoleUnlockPreparationInput {
  confirmAuthorization: boolean;
  timeoutMs?: number;
}

export interface ProtectedConsoleUnlockInvocationInput {
  credentialHandle: string;
  confirmAuthorization: boolean;
  timeoutMs?: number;
}

function boundedConsoleUnlockTimeoutMs(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_CONSOLE_UNLOCK_TIMEOUT_MS;
  return Math.min(MAX_CONSOLE_UNLOCK_TIMEOUT_MS, Math.max(1_000, Math.trunc(value!)));
}

function requireConsoleUnlockAuthorization(confirmed: boolean): void {
  if (confirmed !== true) {
    throw new Error(
      'COMPUTER_CONSOLE_UNLOCK_EXPLICIT_AUTHORIZATION_REQUIRED: confirm_authorization=true is required for this one invocation.',
    );
  }
}

export async function executeProtectedConsoleUnlockPreparation(
  input: ProtectedConsoleUnlockPreparationInput,
  controllerHome: string,
): Promise<Record<string, unknown>> {
  requireConsoleUnlockAuthorization(input.confirmAuthorization);
  const invocationId = randomUUID();
  const request: ComputerConsoleUnlockPrepareRequest = {
    capability: COMPUTER_CONSOLE_UNLOCK_CAPABILITY,
    action: 'prepare_unlock_console',
  };
  const providerResult = await executeRuntimeComputerConsoleUnlock(
    request,
    { kind: 'explicit_single_use', confirmed: true, invocationId },
    boundedConsoleUnlockTimeoutMs(input.timeoutMs),
    controllerHome,
  );
  const credentialHandle =
    typeof providerResult.credential_handle === 'string' ? providerResult.credential_handle : undefined;
  if (!credentialHandle || !CONSOLE_CREDENTIAL_HANDLE_PATTERN.test(credentialHandle)) {
    throw new Error(
      'COMPUTER_CONSOLE_UNLOCK_PREPARATION_INVALID: provider did not return a valid opaque credential handle.',
    );
  }
  return {
    capability: COMPUTER_CONSOLE_UNLOCK_CAPABILITY,
    action: 'prepare_unlock_console',
    invocationId,
    prepared: providerResult.prepared === true,
    credentialHandle,
    ...(typeof providerResult.expires_in_ms === 'number' ? { expiresInMs: providerResult.expires_in_ms } : {}),
  };
}

export async function executeProtectedConsoleUnlockInvocation(
  input: ProtectedConsoleUnlockInvocationInput,
  controllerHome: string,
): Promise<Record<string, unknown>> {
  requireConsoleUnlockAuthorization(input.confirmAuthorization);
  if (!CONSOLE_CREDENTIAL_HANDLE_PATTERN.test(input.credentialHandle)) {
    throw new Error(
      'COMPUTER_CONSOLE_UNLOCK_CREDENTIAL_HANDLE_REQUIRED: a provider-local opaque credential handle is required.',
    );
  }
  const invocationId = randomUUID();
  const request: ComputerConsoleUnlockRequest = {
    capability: COMPUTER_CONSOLE_UNLOCK_CAPABILITY,
    action: 'unlock_console',
    credentialHandle: input.credentialHandle,
  };
  const providerResult = await executeRuntimeComputerConsoleUnlock(
    request,
    { kind: 'explicit_single_use', confirmed: true, invocationId },
    boundedConsoleUnlockTimeoutMs(input.timeoutMs),
    controllerHome,
  );
  return {
    capability: COMPUTER_CONSOLE_UNLOCK_CAPABILITY,
    action: 'unlock_console',
    invocationId,
    unlocked: providerResult.unlocked === true,
    verified: providerResult.verified === true,
    ...(typeof providerResult.postcondition === 'string' ? { postcondition: providerResult.postcondition } : {}),
  };
}

export async function executeProtectedConsoleUnlockLifecycle(
  action: 'console_unlock_enroll' | 'console_unlock_status' | 'console_unlock_recover' | 'console_unlock_revoke',
  input: ProtectedConsoleUnlockPreparationInput,
  controllerHome: string,
): Promise<Record<string, unknown>> {
  requireConsoleUnlockAuthorization(input.confirmAuthorization);
  const invocationId = randomUUID();
  const request: ComputerConsoleUnlockCommandRequest = {
    capability: COMPUTER_CONSOLE_UNLOCK_CAPABILITY,
    action,
  };
  const providerResult = await executeRuntimeComputerConsoleUnlock(
    request,
    { kind: 'explicit_single_use', confirmed: true, invocationId },
    boundedConsoleUnlockTimeoutMs(input.timeoutMs),
    controllerHome,
  );
  return {
    capability: COMPUTER_CONSOLE_UNLOCK_CAPABILITY,
    action,
    invocationId,
    ...providerResult,
  };
}

function computerChatgptTargetActions(): AssistantPluginActionDescriptor[] {
  const conversationIdentitySchema = {
    canonical_url: {
      type: 'string',
      minLength: 1,
      maxLength: 2048,
      description: 'Canonical existing ChatGPT conversation URL. Computer derives and verifies the conversation id.',
    },
  };
  const bootstrapIdentitySchema = {
    project_url: {
      type: 'string',
      minLength: 1,
      maxLength: 2048,
      description:
        'ChatGPT bootstrap URL used only for one Computer-owned successor: signed-in root or an exact Project page.',
    },
    bootstrap_key: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      description: 'Stable external-orchestrator identity for one exact Computer-owned ChatGPT bootstrap target.',
    },
  };
  const targetIdentitySchema = { ...conversationIdentitySchema, ...bootstrapIdentitySchema };
  const targetIdentityOneOf = [{ required: ['canonical_url'] }, { required: ['project_url', 'bootstrap_key'] }];
  const modeSchema = { type: 'string', enum: ['send', 'resume', 'recover'] };
  return [
    {
      actionId: COMPUTER_CHATGPT_TARGET_INVENTORY_ACTION,
      title: 'List exact ChatGPT targets',
      description:
        'Read ChatGPT conversations observed by the signed-in Computer browser provider without exposing physical tab identifiers.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 5_000,
      cancellable: true,
      idempotent: true,
      foregroundEffect: 'none',
      scopes: ['browser.read', 'browser.profile'],
      resourceClaims: [],
      argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: COMPUTER_CHATGPT_TARGET_ENSURE_ACTION,
      title: 'Ensure exact ChatGPT target',
      description:
        'Create or reattach one dedicated Computer-owned target for an existing conversation or one exact ChatGPT Project bootstrap without changing the composer or clicking Send.',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'none',
      defaultTimeoutMs: 15_000,
      cancellable: true,
      idempotent: true,
      foregroundEffect: 'possible',
      scopes: ['browser.read', 'browser.profile'],
      resourceClaims: [
        { resource: 'provider-state', mode: 'write' },
        { resource: 'remote', mode: 'write' },
      ],
      argumentsSchema: {
        type: 'object',
        properties: targetIdentitySchema,
        oneOf: targetIdentityOneOf,
        additionalProperties: false,
      },
    },
    {
      actionId: COMPUTER_CHATGPT_TARGET_OBSERVE_ACTION,
      title: 'Observe exact ChatGPT target',
      description:
        'Observe one exact existing ChatGPT conversation and composer state through Computer-owned provider binding. Never creates a conversation or clicks Send.',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'none',
      defaultTimeoutMs: 15_000,
      cancellable: true,
      idempotent: true,
      foregroundEffect: 'none',
      scopes: ['browser.read', 'browser.profile'],
      resourceClaims: [
        { resource: 'provider-state', mode: 'write' },
        { resource: 'remote', mode: 'read' },
      ],
      argumentsSchema: {
        type: 'object',
        properties: conversationIdentitySchema,
        required: ['canonical_url'],
        additionalProperties: false,
      },
    },
    {
      actionId: COMPUTER_CHATGPT_TARGET_REFRESH_ACTION,
      title: 'Refresh exact ChatGPT target',
      description:
        'Close only the attested Computer-owned physical tab for one exact existing conversation and reopen that same conversation with the current browser provider projection. Never changes the composer or clicks Send.',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'none',
      defaultTimeoutMs: 30_000,
      cancellable: true,
      idempotent: true,
      foregroundEffect: 'possible',
      scopes: ['browser.read', 'browser.profile'],
      resourceClaims: [
        { resource: 'provider-state', mode: 'write' },
        { resource: 'remote', mode: 'write' },
      ],
      argumentsSchema: {
        type: 'object',
        properties: conversationIdentitySchema,
        required: ['canonical_url'],
        additionalProperties: false,
      },
    },
    {
      actionId: COMPUTER_CHATGPT_TARGET_PROMOTE_ACTION,
      title: 'Promote ChatGPT bootstrap target',
      description:
        'Atomically transfer one exact Computer-owned bootstrap Surface binding to its proven canonical ChatGPT conversation without sending or changing the composer.',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'none',
      defaultTimeoutMs: 15_000,
      cancellable: true,
      idempotent: true,
      foregroundEffect: 'possible',
      scopes: ['browser.read', 'browser.profile'],
      resourceClaims: [
        { resource: 'provider-state', mode: 'write' },
        { resource: 'remote', mode: 'read' },
      ],
      argumentsSchema: {
        type: 'object',
        properties: {
          ...conversationIdentitySchema,
          bootstrap_key: bootstrapIdentitySchema.bootstrap_key,
        },
        required: ['canonical_url', 'bootstrap_key'],
        additionalProperties: false,
      },
    },
    {
      actionId: COMPUTER_CHATGPT_TARGET_FIND_MARKER_ACTION,
      title: 'Find submitted ChatGPT marker',
      description:
        'Read provider-owned ChatGPT targets for one previously submitted bootstrap marker and return exact conversation identities without sending or changing the composer.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 60_000,
      cancellable: true,
      idempotent: true,
      foregroundEffect: 'none',
      scopes: ['browser.read', 'browser.profile'],
      resourceClaims: [
        { resource: 'provider-state', mode: 'write' },
        { resource: 'remote', mode: 'read' },
      ],
      argumentsSchema: {
        type: 'object',
        properties: {
          marker: { type: 'string', minLength: 1, maxLength: 1024 },
          bootstrap_key: bootstrapIdentitySchema.bootstrap_key,
        },
        required: ['marker', 'bootstrap_key'],
        additionalProperties: false,
      },
    },
    {
      actionId: COMPUTER_CHATGPT_TARGET_PREPARE_ACTION,
      title: 'Prepare exact ChatGPT target',
      description: 'Replace the composer draft for one exact Computer-owned ChatGPT target without clicking Send.',
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 15_000,
      cancellable: true,
      idempotent: false,
      foregroundEffect: 'possible',
      scopes: ['browser.interact', 'browser.profile'],
      resourceClaims: [
        { resource: 'provider-state', mode: 'write' },
        { resource: 'remote', mode: 'write' },
      ],
      argumentsSchema: {
        type: 'object',
        properties: {
          ...targetIdentitySchema,
          prompt: { type: 'string', minLength: 1, maxLength: 60000 },
          expected_draft: {
            type: 'string',
            maxLength: 60000,
            description:
              'Mac-only exact compare-and-swap for a model-reconciled stale draft. A changed draft is preserved; this action never sends.',
          },
          mode: modeSchema,
        },
        required: ['prompt'],
        oneOf: targetIdentityOneOf,
        additionalProperties: false,
      },
    },
    {
      actionId: COMPUTER_CHATGPT_TARGET_DISPATCH_ACTION,
      title: 'Dispatch exact ChatGPT target',
      description:
        'Send one prompt to one exact Computer-owned ChatGPT conversation. A claimed but unacknowledged Send remains outcome-unknown and is never automatically replayed.',
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 20_000,
      cancellable: true,
      idempotent: false,
      foregroundEffect: 'possible',
      scopes: ['browser.interact', 'browser.profile'],
      resourceClaims: [
        { resource: 'provider-state', mode: 'write' },
        { resource: 'remote', mode: 'write' },
      ],
      argumentsSchema: {
        type: 'object',
        properties: {
          ...targetIdentitySchema,
          prompt: { type: 'string', minLength: 1, maxLength: 60000 },
          mode: modeSchema,
        },
        required: ['prompt'],
        oneOf: targetIdentityOneOf,
        additionalProperties: false,
      },
    },
  ];
}

function computerChatgptConversationIdentity(args: Record<string, unknown>): ComputerChatgptConversationIdentity {
  const raw = typeof args.canonical_url === 'string' ? args.canonical_url.trim() : '';
  if (!raw)
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'canonical_url is required.', {
      retryable: false,
    });
  let parsed: ReturnType<typeof parseCanonicalChatgptConversationIdentity>;
  try {
    parsed = parseCanonicalChatgptConversationIdentity(raw);
  } catch (error) {
    throw new AssistantPluginError(
      'PLUGIN_ACTION_ARGUMENT_INVALID',
      error instanceof Error ? error.message : 'Invalid ChatGPT conversation URL.',
      { retryable: false },
    );
  }
  return {
    namespace: 'chatgpt.conversation',
    conversationId: parsed.conversationId,
    canonicalUrl: parsed.conversationUrl,
  };
}

function computerChatgptBootstrapKey(args: Record<string, unknown>): string {
  const value = typeof args.bootstrap_key === 'string' ? args.bootstrap_key.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new AssistantPluginError(
      'PLUGIN_ACTION_ARGUMENT_INVALID',
      'bootstrap_key must be a stable 1-256 character identifier.',
      { retryable: false },
    );
  }
  return value;
}

function computerChatgptTargetIdentity(args: Record<string, unknown>): ComputerChatgptTargetIdentity {
  const canonicalUrl = typeof args.canonical_url === 'string' ? args.canonical_url.trim() : '';
  const projectUrl = typeof args.project_url === 'string' ? args.project_url.trim() : '';
  const bootstrapKey = typeof args.bootstrap_key === 'string' ? args.bootstrap_key.trim() : '';
  if (canonicalUrl && !projectUrl && !bootstrapKey) return computerChatgptConversationIdentity(args);
  if (canonicalUrl || !projectUrl || !bootstrapKey) {
    throw new AssistantPluginError(
      'PLUGIN_ACTION_ARGUMENT_INVALID',
      'Use either canonical_url or project_url + bootstrap_key.',
      { retryable: false },
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(projectUrl);
  } catch {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Invalid ChatGPT Project URL.', {
      retryable: false,
    });
  }
  const isRootBootstrap = parsed.pathname === '/';
  const isProjectBootstrap = /^\/g\/g-p-[a-z0-9]+(?:-[^/]+)?\/project\/?$/i.test(parsed.pathname);
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'chatgpt.com' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (!isRootBootstrap && !isProjectBootstrap)
  ) {
    throw new AssistantPluginError(
      'PLUGIN_ACTION_ARGUMENT_INVALID',
      'project_url must be https://chatgpt.com/ or an exact ChatGPT Project page.',
      { retryable: false },
    );
  }
  return {
    namespace: 'chatgpt.bootstrap',
    bootstrapKey: computerChatgptBootstrapKey(args),
    projectUrl: isRootBootstrap ? 'https://chatgpt.com/' : `https://chatgpt.com${parsed.pathname.replace(/\/+$/, '')}`,
  };
}

function computerChatgptMarker(args: Record<string, unknown>): string {
  const marker = typeof args.marker === 'string' ? args.marker.trim() : '';
  if (!marker || marker.length > 1024) {
    throw new AssistantPluginError(
      'PLUGIN_ACTION_ARGUMENT_INVALID',
      'marker is required and must be at most 1024 characters.',
      { retryable: false },
    );
  }
  return marker;
}

function computerChatgptMode(args: Record<string, unknown>): 'send' | 'resume' | 'recover' {
  const mode = args.mode;
  return mode === 'resume' || mode === 'recover' ? mode : 'send';
}

function computerChatgptPrompt(args: Record<string, unknown>): string {
  const prompt = typeof args.prompt === 'string' ? args.prompt : '';
  if (!prompt.trim())
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'prompt is required.', { retryable: false });
  return prompt;
}

function isComputerChatgptTargetAction(actionId: string): boolean {
  return COMPUTER_CHATGPT_TARGET_ACTION_IDS.has(actionId);
}

async function executeComputerChatgptTargetAction(
  input: AssistantPluginActionExecutionInput,
): Promise<Record<string, unknown>> {
  if (input.actionId === COMPUTER_CHATGPT_TARGET_INVENTORY_ACTION) {
    const inventory = await runtimeComputerChatgptInventory(input.controllerHome, input.timeoutMs);
    return {
      conversations: inventory.conversations,
      complete: inventory.complete,
      ...(inventory.providerInventoryReady === undefined
        ? {}
        : { providerInventoryReady: inventory.providerInventoryReady }),
      unavailableProviders: inventory.unavailableProviders,
    };
  }
  if (input.actionId === COMPUTER_CHATGPT_TARGET_FIND_MARKER_ACTION) {
    return await runtimeComputerChatgptAction(
      input.controllerHome,
      {
        kind: 'find_marker',
        marker: computerChatgptMarker(input.args),
        bootstrapKey: computerChatgptBootstrapKey(input.args),
      },
      input.timeoutMs,
    );
  }
  if (input.actionId === COMPUTER_CHATGPT_TARGET_OBSERVE_ACTION) {
    const identity = computerChatgptConversationIdentity(input.args);
    return await runtimeComputerChatgptAction(input.controllerHome, { kind: 'observe', identity }, input.timeoutMs);
  }
  if (input.actionId === COMPUTER_CHATGPT_TARGET_PROMOTE_ACTION) {
    const identity = computerChatgptConversationIdentity(input.args);
    const bootstrapKey = computerChatgptBootstrapKey(input.args);
    const bootstrap = computerTargetAuthority.findSurfaceByStableIdentity(input.controllerHome, {
      surfaceType: 'browser-tab',
      ownership: 'provider_owned',
      resource: { namespace: 'chatgpt.bootstrap', key: bootstrapKey },
    });
    if (!bootstrap) {
      return await runtimeComputerChatgptAction(input.controllerHome, { kind: 'observe', identity }, input.timeoutMs);
    }
    return await runtimeComputerChatgptAction(
      input.controllerHome,
      { kind: 'promote', targetId: bootstrap.targetId, identity },
      input.timeoutMs,
    );
  }
  if (input.actionId === COMPUTER_CHATGPT_TARGET_REFRESH_ACTION) {
    const identity = computerChatgptConversationIdentity(input.args);
    return await runtimeComputerChatgptAction(input.controllerHome, { kind: 'refresh', identity }, input.timeoutMs);
  }
  const identity = computerChatgptTargetIdentity(input.args);
  if (input.actionId === COMPUTER_CHATGPT_TARGET_ENSURE_ACTION) {
    return await runtimeComputerChatgptAction(input.controllerHome, { kind: 'ensure', identity }, input.timeoutMs);
  }
  const prompt = computerChatgptPrompt(input.args);
  const mode = computerChatgptMode(input.args);
  if (input.actionId === COMPUTER_CHATGPT_TARGET_PREPARE_ACTION) {
    const expectedDraft = input.args.expected_draft;
    if (expectedDraft !== undefined && (typeof expectedDraft !== 'string' || expectedDraft.length > 60000))
      throw new AssistantPluginError(
        'COMPUTER_CHATGPT_EXPECTED_DRAFT_INVALID',
        'expected_draft must be bounded exact text.',
        { retryable: false },
      );
    return await runtimeComputerChatgptAction(
      input.controllerHome,
      { kind: 'prepare', identity, prompt, mode, expectedDraft },
      input.timeoutMs,
    );
  }
  if (input.actionId === COMPUTER_CHATGPT_TARGET_DISPATCH_ACTION) {
    return await runtimeComputerChatgptAction(
      input.controllerHome,
      { kind: 'dispatch', identity, prompt, mode },
      input.timeoutMs,
    );
  }
  throw new AssistantPluginError('PLUGIN_ACTION_UNKNOWN', `Unknown Computer ChatGPT target action: ${input.actionId}`, {
    retryable: false,
  });
}

function resolveComputerChatgptAuthorizationContext(
  input: AssistantPluginActionExecutionInput,
): AssistantPluginAuthorizationContext | undefined {
  if (
    input.actionId === COMPUTER_CHATGPT_TARGET_INVENTORY_ACTION ||
    input.actionId === COMPUTER_CHATGPT_TARGET_OBSERVE_ACTION ||
    input.actionId === COMPUTER_CHATGPT_TARGET_FIND_MARKER_ACTION
  )
    return undefined;
  if (input.actionId === COMPUTER_CHATGPT_TARGET_PROMOTE_ACTION) {
    const identity = computerChatgptConversationIdentity(input.args);
    return { target: { kind: 'chatgpt-conversation', id: identity.conversationId } };
  }
  const identity = computerChatgptTargetIdentity(input.args);
  if (identity.namespace === 'chatgpt.conversation') {
    return { target: { kind: 'chatgpt-conversation', id: identity.conversationId } };
  }
  return {
    target: {
      kind: 'chatgpt-project-bootstrap',
      id: createHash('sha256').update(`${identity.projectUrl}\0${identity.bootstrapKey}`).digest('hex'),
    },
  };
}

function desktopProductActions(): AssistantPluginActionDescriptor[] {
  const open = providerActionDescriptor('desktop_session_open');
  const openSchema = structuredClone(open.argumentsSchema) as Record<string, unknown>;
  const openProperties =
    openSchema.properties && typeof openSchema.properties === 'object'
      ? { ...(openSchema.properties as Record<string, unknown>) }
      : {};
  openProperties.target_id = {
    type: 'string',
    minLength: 1,
    description:
      'Existing Forge-owned durable Computer target id. Reattach this exact target without creating another target.',
  };
  openSchema.properties = openProperties;
  const openAnyOf = Array.isArray(openSchema.anyOf) ? openSchema.anyOf : [];
  openSchema.anyOf = [{ required: ['target_id'] }, ...openAnyOf];
  const close = providerActionDescriptor('desktop_session_close');
  return [
    {
      actionId: DESKTOP_TARGET_LIST_ACTION,
      title: 'List Computer desktop targets',
      description:
        'Read active Forge-owned desktop application targets and provider-binding status without exposing native provider session identifiers.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 5_000,
      cancellable: true,
      idempotent: true,
      foregroundEffect: 'none',
      scopes: ['desktop.session'],
      resourceClaims: [],
      argumentsSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          offset: { type: 'integer', minimum: 0 },
          bundle_id: { type: 'string' },
          app_name: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    {
      ...open,
      actionId: DESKTOP_TARGET_OPEN_ACTION,
      title: 'Open Computer desktop target',
      description:
        'Open a unique application identity or reattach one exact existing target_id. Exact-target reattachment preserves the durable target and rebuilds only its provider session binding.',
      argumentsSchema: openSchema,
    },
    {
      ...close,
      actionId: DESKTOP_TARGET_CLOSE_ACTION,
      title: 'Close Computer desktop target',
      description:
        'Retire one Forge-owned Computer target after its live provider binding is closed or confirmed absent.',
      argumentsSchema: {
        type: 'object',
        properties: { target_id: { type: 'string' } },
        required: ['target_id'],
        additionalProperties: false,
      },
    },
    ...[...DESKTOP_SEMANTIC_ACTION_IDS].map(targetBoundDescriptor),
    {
      actionId: COMPUTER_CONSOLE_UNLOCK_PREPARE_ACTION,
      title: 'Prepare protected console unlock',
      description:
        'Ask the native Computer provider to collect a console credential locally and return only a short-lived opaque single-use handle.',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'authorization',
      defaultTimeoutMs: DEFAULT_CONSOLE_UNLOCK_TIMEOUT_MS,
      cancellable: true,
      idempotent: false,
      executionMode: 'direct_non_persistent',
      foregroundEffect: 'required',
      scopes: ['console.unlock'],
      resourceClaims: [],
      argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: COMPUTER_CONSOLE_UNLOCK_ACTION,
      title: 'Unlock protected console',
      description:
        'Consume one provider-local opaque credential handle to perform and verify one console unlock without durable replay state.',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'authorization',
      defaultTimeoutMs: DEFAULT_CONSOLE_UNLOCK_TIMEOUT_MS,
      cancellable: true,
      idempotent: false,
      executionMode: 'direct_non_persistent',
      foregroundEffect: 'required',
      scopes: ['console.unlock'],
      resourceClaims: [],
      argumentsSchema: {
        type: 'object',
        properties: {
          credential_handle: {
            type: 'string',
            minLength: 36,
            maxLength: 64,
            description: 'Opaque short-lived single-use handle returned by console_unlock_prepare.',
          },
        },
        required: ['credential_handle'],
        additionalProperties: false,
      },
    },
    {
      actionId: COMPUTER_CONSOLE_UNLOCK_ENROLL_ACTION,
      title: 'Enable unattended console recovery',
      description:
        'Enroll provider-local unattended console recovery. Credential collection and Keychain persistence remain entirely inside the native provider.',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'authorization',
      defaultTimeoutMs: DEFAULT_CONSOLE_UNLOCK_TIMEOUT_MS,
      cancellable: true,
      idempotent: false,
      executionMode: 'direct_non_persistent',
      foregroundEffect: 'required',
      scopes: ['console.unlock'],
      resourceClaims: [],
      argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: COMPUTER_CONSOLE_UNLOCK_STATUS_ACTION,
      title: 'Read unattended console recovery status',
      description:
        'Read whether provider-local unattended console recovery is enrolled and available without exposing credential material.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'authorization',
      defaultTimeoutMs: DEFAULT_CONSOLE_UNLOCK_TIMEOUT_MS,
      cancellable: true,
      idempotent: true,
      executionMode: 'direct_non_persistent',
      foregroundEffect: 'none',
      scopes: ['console.unlock'],
      resourceClaims: [],
      argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: COMPUTER_CONSOLE_UNLOCK_RECOVER_ACTION,
      title: 'Recover locked macOS console',
      description:
        'Recover an already-locked console using only the provider-local enrolled credential. No password or credential handle enters Forge.',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'authorization',
      defaultTimeoutMs: DEFAULT_CONSOLE_UNLOCK_TIMEOUT_MS,
      cancellable: true,
      idempotent: false,
      executionMode: 'direct_non_persistent',
      foregroundEffect: 'required',
      scopes: ['console.unlock'],
      resourceClaims: [],
      argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: COMPUTER_CONSOLE_UNLOCK_REVOKE_ACTION,
      title: 'Disable unattended console recovery',
      description: 'Delete the provider-local unattended console recovery credential and disable future recovery.',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'authorization',
      defaultTimeoutMs: DEFAULT_CONSOLE_UNLOCK_TIMEOUT_MS,
      cancellable: true,
      idempotent: true,
      executionMode: 'direct_non_persistent',
      foregroundEffect: 'none',
      scopes: ['console.unlock'],
      resourceClaims: [],
      argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: DESKTOP_ELEMENT_OBSERVE_ACTION,
      title: 'Observe Computer elements',
      description:
        'Observe provider-neutral semantic elements for one Forge-owned desktop target. Returned refs and target context are valid only for the returned observation epoch.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 10_000,
      cancellable: true,
      idempotent: true,
      foregroundEffect: 'none',
      scopes: ['desktop.observe'],
      resourceClaims: [],
      argumentsSchema: {
        type: 'object',
        properties: {
          target_id: { type: 'string', description: 'Forge-owned durable Computer target id.' },
          max_depth: { type: 'integer', minimum: 1, maximum: 20 },
          max_nodes: { type: 'integer', minimum: 1, maximum: 5_000 },
          include_values: { type: 'boolean' },
          root_selector: {
            type: 'object',
            properties: {
              ref: { type: 'string' },
              role: { type: 'string' },
              title: { type: 'string' },
              identifier: { type: 'string' },
            },
            anyOf: [
              { required: ['ref'] },
              { required: ['role'] },
              { required: ['title'] },
              { required: ['identifier'] },
            ],
            additionalProperties: false,
          },
        },
        required: ['target_id'],
        additionalProperties: false,
      },
    },
    {
      actionId: DESKTOP_ELEMENT_ACTION_ACTION,
      title: 'Act on observed Computer element',
      description:
        'Perform one provider-neutral semantic action either against an exact one-shot observed ref or atomically by a stable role/title/identifier selector. Selector mode observes and acts under the same Computer target lease so no model round-trip can stale the intermediate snapshot. Explicit refs remain single-epoch and stale or rebound observations fail closed.',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 10_000,
      cancellable: true,
      idempotent: false,
      foregroundEffect: 'none',
      scopes: ['desktop.interact'],
      resourceClaims: DESKTOP_OPERATOR_PROVIDER_STATE_WRITE_CLAIMS,
      argumentsSchema: {
        type: 'object',
        properties: {
          target_id: { type: 'string', description: 'Forge-owned durable Computer target id.' },
          observation_revision: {
            type: 'integer',
            minimum: 1,
            description:
              'snapshotRevision returned by desktop_element_observe for this target. Provider session identity stays inside Computer.',
          },
          ref: { type: 'string' },
          selector: {
            type: 'object',
            properties: {
              role: { type: 'string' },
              title: { type: 'string' },
              identifier: { type: 'string' },
            },
            anyOf: [{ required: ['role'] }, { required: ['title'] }, { required: ['identifier'] }],
            additionalProperties: false,
            description:
              'Stable semantic selector for atomic observe→act. Snapshot-local refs are intentionally not accepted here.',
          },
          action: { type: 'string', enum: [...COMPUTER_ELEMENT_SEMANTIC_ACTIONS] },
          value: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] },
        },
        required: ['target_id', 'action'],
        anyOf: [{ required: ['observation_revision', 'ref'] }, { required: ['selector'] }],
        additionalProperties: false,
      },
    },
  ];
}

function desktopProductPermissions(ready: boolean, windowsObservation = false): AssistantPluginPermissionScope[] {
  return [
    {
      scope: 'desktop.session',
      mode: 'write',
      description: 'Bind a desktop application target for Computer interaction.',
      granted: ready || windowsObservation,
      required: false,
    },
    {
      scope: 'desktop.observe',
      mode: 'read',
      description: 'Observe bounded desktop accessibility state.',
      granted: ready || windowsObservation,
      required: false,
    },
    {
      scope: 'desktop.interact',
      mode: 'write',
      description: 'Perform bounded semantic desktop interaction.',
      granted: ready,
      required: false,
    },
    {
      scope: 'desktop.capture',
      mode: 'read',
      description: 'Capture an authorized desktop target.',
      granted: ready,
      required: false,
    },
    {
      scope: 'console.unlock',
      mode: 'write',
      description: 'Use provider-local temporary unlock or explicitly enrolled unattended console recovery.',
      granted: ready,
      required: false,
    },
  ];
}

function desktopProductCapabilities(): AssistantPluginCapability[] {
  return [
    {
      capabilityId: 'computer.desktop_target.v1',
      title: 'Desktop targets',
      description: 'Inspect, bind and retire Forge-owned desktop application targets.',
      scopes: ['desktop.session'],
      actions: [DESKTOP_TARGET_LIST_ACTION, DESKTOP_TARGET_OPEN_ACTION, DESKTOP_TARGET_CLOSE_ACTION],
    },
    {
      capabilityId: 'computer.observe.v1',
      title: 'Computer observation',
      description: 'Observe bounded desktop semantic state.',
      scopes: ['desktop.observe'],
      actions: ['desktop_observe'],
    },
    {
      capabilityId: 'computer.input.v1',
      title: 'Computer input',
      description: 'Perform bounded semantic desktop input.',
      scopes: ['desktop.interact'],
      actions: ['desktop_press', 'desktop_select_rows', 'desktop_type_text', 'desktop_key', 'desktop_open_url'],
    },
    {
      capabilityId: 'computer.capture.v1',
      title: 'Computer capture',
      description: 'Capture authorized desktop state.',
      scopes: ['desktop.capture'],
      actions: ['desktop_screenshot'],
    },
    {
      capabilityId: COMPUTER_ELEMENT_OBSERVE_CAPABILITY,
      title: 'Computer element observation',
      description: 'Observe exact provider-neutral semantic element snapshots for a Forge-owned target.',
      scopes: ['desktop.observe'],
      actions: [DESKTOP_ELEMENT_OBSERVE_ACTION],
    },
    {
      capabilityId: COMPUTER_ELEMENT_ACTION_CAPABILITY,
      title: 'Computer element action',
      description: 'Act on exact observed element refs with observation-epoch fencing.',
      scopes: ['desktop.interact'],
      actions: [DESKTOP_ELEMENT_ACTION_ACTION],
    },
    {
      capabilityId: COMPUTER_CONSOLE_UNLOCK_CAPABILITY,
      title: 'Protected console unlock',
      description:
        'Keep console credential material provider-local while supporting temporary one-shot unlock and opt-in unattended recovery.',
      scopes: ['console.unlock'],
      actions: [
        COMPUTER_CONSOLE_UNLOCK_PREPARE_ACTION,
        COMPUTER_CONSOLE_UNLOCK_ACTION,
        COMPUTER_CONSOLE_UNLOCK_ENROLL_ACTION,
        COMPUTER_CONSOLE_UNLOCK_STATUS_ACTION,
        COMPUTER_CONSOLE_UNLOCK_RECOVER_ACTION,
        COMPUTER_CONSOLE_UNLOCK_REVOKE_ACTION,
      ],
    },
  ];
}

function desktopProviderManifest(
  context: AssistantPluginBuildContext | undefined,
): AssistantPluginManifest | undefined {
  if (!context) return undefined;
  const adapter = getExternalPluginAdapter(context.controllerHome, DESKTOP_PROVIDER_ID);
  return adapter?.buildManifest(0, undefined, context.repoRoot, context);
}

function buildComputerManifest(
  previousRevision = 0,
  previousUpdatedAt?: string,
  repoRoot?: string,
  context?: AssistantPluginBuildContext,
): AssistantPluginManifest {
  const browser = buildBrowserPluginManifest(previousRevision, previousUpdatedAt, repoRoot, context, true);
  const scriptedBrowserActions = new Set([
    'configure',
    'install_unpacked_extension',
    'list_unpacked_extensions',
    'clear_session',
  ]);
  const browserActions = browser.actions.filter((action) => !scriptedBrowserActions.has(action.actionId));
  const browserCapabilities = browser.capabilities
    .map((capability) => ({
      ...capability,
      actions: capability.actions.filter((action) => !scriptedBrowserActions.has(action)),
      ...(capability.capabilityId === 'browser-interaction'
        ? {
            description:
              'Interact with existing Chrome or Vivaldi through native Computer; scripted Playwright is a separate explicit capability.',
          }
        : {}),
      ...(capability.capabilityId === 'browser-session'
        ? { description: 'Discover, bind and reuse tabs of the user’s existing browser.' }
        : {}),
      ...(capability.capabilityId === 'browser-human-handoff'
        ? { description: 'Present the exact existing native browser tab for manual interaction.' }
        : {}),
    }))
    .filter((capability) => capability.actions.length > 0);
  const desktop = desktopProviderManifest(context);
  const platform = currentComputerPlatform();
  const desktopSupported = platform === 'darwin';
  const windowsObservationTransport = platform === 'linux' && Boolean(resolveWindowsComputerPowerShell());
  const browserReady = browser.enabled && browser.health.ready;
  const chatgptProvider = context
    ? runtimeComputerChatgptLiveProviderStatus(context.controllerHome)
    : { observed: false, ready: false, providerCount: 0 };
  const desktopReady = desktopSupported && desktop?.enabled === true && desktop.health.ready;
  const physicalRepository = desktopSupported && context?.controllerScoped === false;
  const physicalReady = physicalRepository && iosPhysicalDeviceStatus().coreDeviceReady;
  // Passive manifest reads must never launch Python: input readiness is
  // published only after an explicit HID action verified the exact toolchain.
  const hidStatus = physicalReady && context ? remoteXpcHidCachedStatus(context.controllerHome) : undefined;
  const physicalInputReady = physicalReady && hidStatus?.available === true;
  const ready = browserReady && desktopReady;
  const partial = browserReady || chatgptProvider.ready || desktopReady || windowsObservationTransport || physicalReady;
  const checkedAt = new Date().toISOString();
  return {
    ...browser,
    pluginId: 'computer',
    provider: 'forge-computer',
    displayName: 'Forge Computer',
    pluginVersion: '1.0.0',
    authority: {
      strategy: 'derived',
      duplicateStateAllowed: false,
      sourceOfTruth: [
        // Computer browser is built in and never reads a project's independent
        // Browser-script configuration to decide activation or routing.
        'controllerHome:sqlite/computer_interaction_target',
        'controller-home:repository browser artifacts',
        'controller-home:repository ios-device interactions and Controller-global UDID lock',
      ],
    },
    enabled:
      browser.enabled ||
      chatgptProvider.ready ||
      desktop?.enabled === true ||
      windowsObservationTransport ||
      physicalReady,
    lifecycle: {
      state: ready ? 'enabled' : partial ? 'degraded' : 'error',
      reason: ready
        ? 'Computer Browser and native Desktop semantic capabilities are ready.'
        : desktopSupported
          ? 'Computer is only partially ready; inspect Browser and native Desktop capability health.'
          : chatgptProvider.ready
            ? 'Exact ChatGPT targets are available through the Chrome extension; native Browser/Desktop are unavailable on ' +
              platform +
              '.'
            : 'Computer native Browser/Desktop providers are unavailable on ' +
              platform +
              '; inspect exact ChatGPT provider heartbeat separately.',
    },
    health: {
      state: ready ? 'ready' : partial ? 'degraded' : 'error',
      checkedAt,
      ready,
      probed: browser.health.probed || desktop?.health.probed === true || chatgptProvider.observed,
      errors: ready
        ? []
        : [
            ...browser.health.errors,
            ...(desktopSupported && !desktopReady
              ? ['Native Computer capabilities are unavailable or not ready.']
              : []),
          ],
      warnings: [
        ...browser.health.warnings,
        ...(physicalReady && !physicalInputReady
          ? [
              hidStatus?.reason
                ? // The authoritative live probe ran and failed: the toolchain is
                  // genuinely missing or wrong.
                  `Physical iPhone observation is ready, but RemoteXPC HID input requires Controller-owned pymobiledevice3 ${String(hidStatus?.toolchainVersion ?? 'toolchain')}: ${String(hidStatus.reason)}.`
                : // Passive manifest reads never launch Python: no recent verified
                  // probe in this process is NOT a missing toolchain. inputReady=false
                  // here only means the short-lived verified cache is empty or stale;
                  // the physical input action performs the authoritative live probe
                  // before dispatch (#289).
                  'Physical iPhone observation is ready; RemoteXPC HID input readiness is unverified in this process (manifest reads never launch Python). inputReady=false does not indicate a missing pymobiledevice3 toolchain; the physical input action performs the authoritative live toolchain probe before dispatch.',
            ]
          : []),
        ...(desktopSupported
          ? desktopReady
            ? []
            : ['Native Computer capability diagnostics are available through the internal platform provider.']
          : [`Native Desktop Computer capabilities are unsupported on ${platform}.`]),
      ],
      details: {
        partial: !ready && partial,
        browser: { ready: browserReady, state: browser.health.state },
        chatgpt: {
          supported: true,
          ready: chatgptProvider.ready,
          state: chatgptProvider.ready ? 'ready' : chatgptProvider.observed ? 'unavailable' : 'unobserved',
          provider: 'browser.chrome-extension',
          providerCount: chatgptProvider.providerCount,
          siteScope: 'https://chatgpt.com/*',
        },
        desktop: {
          supported: desktopSupported,
          ready: desktopReady,
          state: desktop?.health.state ?? (desktopSupported ? 'not_installed' : 'unsupported'),
        },
        ...(windowsObservationTransport
          ? {
              windowsDesktop: {
                provider: WINDOWS_COMPUTER_PROVIDER_ID,
                transportDetected: true,
                observationOnly: true,
                ready: false,
                state: 'live_target_probe_required',
              },
            }
          : {}),
        iphone: {
          supported: desktopSupported,
          ready: physicalInputReady,
          observationReady: physicalReady,
          inputReady: physicalInputReady,
          toolchainVersion: hidStatus?.toolchainVersion,
          provider: 'coredevice',
        },
      },
    },
    permissions: [
      ...browser.permissions
        .filter((permission) => permission.scope !== 'browser.extensions')
        .map((permission) =>
          permission.scope === 'browser.profile'
            ? { ...permission, description: 'Bind and persist exact existing native browser tab identities.' }
            : permission,
        ),
      ...desktopProductPermissions(desktopReady, windowsObservationTransport),
      ...(physicalRepository
        ? [
            {
              scope: 'ios.discover' as const,
              mode: 'read' as const,
              description: 'Discover paired physical iPhones through CoreDevice.',
              granted: physicalReady,
              required: false,
            },
            {
              scope: 'ios.device' as const,
              mode: 'write' as const,
              description: 'Use one exact iPhone through the existing CoreDevice/RemoteXPC owner.',
              granted: physicalReady,
              required: false,
            },
          ]
        : []),
    ],
    capabilities: [
      ...browserCapabilities,
      {
        capabilityId: 'computer.chatgpt_target.v1',
        title: 'Exact ChatGPT targets',
        description: 'Observe and operate exact ChatGPT conversations through the Computer-owned browser provider.',
        scopes: ['browser.read', 'browser.interact', 'browser.profile'],
        actions: [...COMPUTER_CHATGPT_TARGET_ACTION_IDS],
      },
      ...desktopProductCapabilities(),
      ...(physicalRepository ? iosPhysicalDeviceCapabilities() : []),
    ],
    actions: [
      ...browserActions,
      ...computerChatgptTargetActions(),
      ...desktopProductActions(),
      ...(physicalRepository ? iosPhysicalDeviceActions() : []),
    ],
    updatedAt: previousUpdatedAt ?? checkedAt,
  };
}

function isDesktopProductAction(actionId: string): boolean {
  return DESKTOP_PRODUCT_ACTION_IDS.has(actionId);
}

function optionalDesktopProvider(input: AssistantPluginActionExecutionInput): DesktopSessionProvider | undefined {
  if (currentComputerPlatform() === 'linux') {
    return resolveWindowsComputerPowerShell() ? createWindowsDesktopSessionProvider() : undefined;
  }
  return getExternalPluginAdapter(input.controllerHome, DESKTOP_PROVIDER_ID);
}

function desktopProvider(input: AssistantPluginActionExecutionInput): DesktopSessionProvider {
  const platform = currentComputerPlatform();
  if (platform !== 'darwin' && !(platform === 'linux' && resolveWindowsComputerPowerShell())) {
    throw new AssistantPluginError(
      'PLUGIN_COMPUTER_DESKTOP_PLATFORM_UNSUPPORTED',
      `Computer native Desktop capabilities are unavailable on ${platform} until a platform provider is installed.`,
      { retryable: false, details: { platform, actionId: input.actionId } },
    );
  }
  const provider = optionalDesktopProvider(input);
  if (!provider) {
    throw new AssistantPluginError(
      'PLUGIN_COMPUTER_DESKTOP_PROVIDER_UNAVAILABLE',
      'Computer native Desktop capabilities require the registered platform provider.',
      { retryable: true, details: { providerId: activeDesktopProviderId(), actionId: input.actionId } },
    );
  }
  return provider;
}

function firstString(value: unknown, ...keys: string[]): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function explicitTargetIdFromArgs(args: Record<string, unknown>): string | undefined {
  const targetId = typeof args.target_id === 'string' ? args.target_id.trim() : '';
  if (!targetId) return undefined;
  const hasIdentity =
    (typeof args.bundle_id === 'string' && Boolean(args.bundle_id.trim())) ||
    (typeof args.app_name === 'string' && Boolean(args.app_name.trim()));
  if (hasIdentity) {
    throw new AssistantPluginError(
      'PLUGIN_COMPUTER_TARGET_SELECTOR_AMBIGUOUS',
      'Specify target_id or bundle_id/app_name, not both.',
      { retryable: false },
    );
  }
  return targetId;
}

function exactDesktopProcessId(args: Record<string, unknown>): number | undefined {
  const pid = args.process_id;
  const bundlePath = args.bundle_path;
  if (pid === undefined) {
    if (bundlePath !== undefined) {
      throw new AssistantPluginError('PLUGIN_COMPUTER_TARGET_SELECTOR_INVALID', 'bundle_path requires process_id.', {
        retryable: false,
      });
    }
    return undefined;
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid > 2_147_483_647 || args.launch === true) {
    throw new AssistantPluginError(
      'PLUGIN_COMPUTER_TARGET_SELECTOR_INVALID',
      'Exact process selection requires a positive process_id and launch=false.',
      { retryable: false },
    );
  }
  if (bundlePath !== undefined && (typeof bundlePath !== 'string' || !bundlePath.startsWith('/'))) {
    throw new AssistantPluginError('PLUGIN_COMPUTER_TARGET_SELECTOR_INVALID', 'bundle_path must be an absolute path.', {
      retryable: false,
    });
  }
  return pid;
}

function exactDesktopSelectorVerified(result: Record<string, unknown>, args: Record<string, unknown>): boolean {
  const pid = exactDesktopProcessId(args);
  if (pid === undefined) return true;
  return (
    result.pid === pid &&
    result.exactProcessId === pid &&
    (args.bundle_path === undefined || result.exactBundlePathVerified === true)
  );
}

function stableIdentityFromArgs(args: Record<string, unknown>): ComputerApplicationStableIdentity {
  const bundleId = typeof args.bundle_id === 'string' ? args.bundle_id.trim() : '';
  const appName = typeof args.app_name === 'string' ? args.app_name.trim() : '';
  if (!bundleId && !appName)
    throw new AssistantPluginError(
      'PLUGIN_COMPUTER_TARGET_IDENTITY_REQUIRED',
      'Desktop target requires bundle_id or app_name.',
      { retryable: false },
    );
  return { ...(bundleId ? { bundleId } : {}), ...(appName ? { appName } : {}) };
}

function targetMatchesProviderSession(target: ComputerApplicationTarget, session: Record<string, unknown>): boolean {
  const bundleId = firstString(session, 'bundleIdentifier', 'bundle_id');
  const appName = firstString(session, 'appName', 'app_name');
  if (target.stableIdentity.bundleId) return bundleId === target.stableIdentity.bundleId;
  return Boolean(target.stableIdentity.appName && appName === target.stableIdentity.appName);
}

function providerInput(
  input: AssistantPluginActionExecutionInput,
  actionId: string,
  args: Record<string, unknown>,
  suffix = actionId,
): AssistantPluginActionExecutionInput {
  return { ...input, pluginId: activeDesktopProviderId(), actionId, args, requestId: `${input.requestId}:${suffix}` };
}

function providerSessionId(result: Record<string, unknown>): string {
  const interactionId = firstString(result, 'interactionId', 'interaction_id');
  if (!interactionId)
    throw new AssistantPluginError(
      'PLUGIN_COMPUTER_PROVIDER_BINDING_MISSING',
      'Native Computer provider did not return a live interaction binding.',
      { retryable: true },
    );
  return interactionId;
}

function desktopComputerRequest(
  actionId: string,
  args: Record<string, unknown>,
  interactionId?: string,
): ComputerRuntimeExecutionRequest {
  const requireInteractionId = (): string => {
    if (interactionId) return interactionId;
    throw new AssistantPluginError(
      'PLUGIN_COMPUTER_PROVIDER_BINDING_MISSING',
      `${actionId} requires a live provider interaction binding.`,
      { retryable: true },
    );
  };
  if (actionId === 'desktop_observe') {
    return {
      capability: COMPUTER_OBSERVE_CAPABILITY,
      action: 'observe',
      interactionId: requireInteractionId(),
      ...(typeof args.max_depth === 'number' ? { maxDepth: args.max_depth } : {}),
      ...(typeof args.max_nodes === 'number' ? { maxNodes: args.max_nodes } : {}),
      ...(typeof args.include_values === 'boolean' ? { includeValues: args.include_values } : {}),
      ...(typeof args.include_actions === 'boolean' ? { includeActions: args.include_actions } : {}),
      ...(typeof args.include_windows === 'boolean' ? { includeWindows: args.include_windows } : {}),
      ...(args.root_selector && typeof args.root_selector === 'object'
        ? { rootSelector: args.root_selector as ComputerSemanticSelector }
        : {}),
    };
  }
  if (actionId === 'desktop_press') {
    return {
      capability: COMPUTER_INPUT_CAPABILITY,
      action: 'press',
      interactionId: requireInteractionId(),
      selector: args.selector as ComputerSemanticSelector,
      ...(typeof args.semantic_action === 'string' ? { semanticAction: args.semantic_action } : {}),
    } as ComputerRuntimeExecutionRequest;
  }
  if (actionId === 'desktop_select_rows') {
    return {
      capability: COMPUTER_INPUT_CAPABILITY,
      action: 'select_rows',
      interactionId: requireInteractionId(),
      selector: args.selector as ComputerSemanticSelector,
      startIndex: args.start_index as number,
      ...(typeof args.end_index === 'number' ? { endIndex: args.end_index } : {}),
    };
  }
  if (actionId === 'desktop_type_text') {
    return {
      capability: COMPUTER_INPUT_CAPABILITY,
      action: 'type_text',
      interactionId: requireInteractionId(),
      selector: args.selector as ComputerSemanticSelector,
      text: String(args.text ?? ''),
      ...(typeof args.replace === 'boolean' ? { replace: args.replace } : {}),
    };
  }
  if (actionId === 'desktop_key') {
    return {
      capability: COMPUTER_INPUT_CAPABILITY,
      action: 'key',
      interactionId: requireInteractionId(),
      keys: Array.isArray(args.keys) ? args.keys.filter((value): value is string => typeof value === 'string') : [],
    };
  }
  if (actionId === 'desktop_open_url') {
    return { capability: COMPUTER_INPUT_CAPABILITY, action: 'open_url', url: String(args.url ?? '') };
  }
  if (actionId === 'desktop_screenshot') {
    return {
      capability: COMPUTER_CAPTURE_CAPABILITY,
      action: 'screenshot',
      ...(args.scope === 'display' || args.scope === 'window' ? { scope: args.scope } : {}),
      ...(interactionId ? { interactionId } : {}),
      ...(typeof args.window_id === 'number' ? { windowId: args.window_id } : {}),
      ...(typeof args.label === 'string' ? { label: args.label } : {}),
    };
  }
  if (actionId === DESKTOP_ELEMENT_OBSERVE_ACTION) {
    return {
      capability: COMPUTER_ELEMENT_OBSERVE_CAPABILITY,
      action: 'observe_elements',
      interactionId: requireInteractionId(),
      ...(typeof args.max_depth === 'number' ? { maxDepth: args.max_depth } : {}),
      ...(typeof args.max_nodes === 'number' ? { maxNodes: args.max_nodes } : {}),
      ...(typeof args.include_values === 'boolean' ? { includeValues: args.include_values } : {}),
      ...(args.root_selector && typeof args.root_selector === 'object'
        ? { rootSelector: args.root_selector as ComputerSemanticSelector }
        : {}),
    };
  }
  if (actionId === DESKTOP_ELEMENT_ACTION_ACTION) {
    const semanticAction =
      typeof args.action === 'string' && (COMPUTER_ELEMENT_SEMANTIC_ACTIONS as readonly string[]).includes(args.action)
        ? (args.action as ComputerElementSemanticAction)
        : undefined;
    if (!semanticAction || !args.target || typeof args.target !== 'object' || typeof args.ref !== 'string') {
      throw new AssistantPluginError(
        'PLUGIN_COMPUTER_ELEMENT_ACTION_INVALID',
        'desktop_element_action requires a Computer-owned element target, ref, and one declared semantic action.',
        { retryable: false },
      );
    }
    return {
      capability: COMPUTER_ELEMENT_ACTION_CAPABILITY,
      action: semanticAction,
      target: args.target as ComputerElementTarget,
      ref: args.ref,
      ...(args.value !== undefined ? { value: args.value } : {}),
    };
  }
  throw new AssistantPluginError(
    'PLUGIN_COMPUTER_DESKTOP_ACTION_UNSUPPORTED',
    `Unsupported retained Desktop Computer action ${actionId}.`,
    { retryable: false },
  );
}

async function executeDesktopProductAction(
  input: AssistantPluginActionExecutionInput,
  actionId: string,
  args: Record<string, unknown>,
  interactionId?: string,
): Promise<Record<string, unknown>> {
  const descriptor = desktopProductActions().find((action) => action.actionId === actionId);
  if (!descriptor)
    throw new AssistantPluginError(
      'PLUGIN_COMPUTER_DESKTOP_ACTION_UNSUPPORTED',
      `Computer product action ${actionId} is not registered.`,
      { retryable: false },
    );
  return await executeRuntimeComputer(
    desktopComputerRequest(actionId, args, interactionId),
    input.timeoutMs ?? descriptor.defaultTimeoutMs ?? 30_000,
    input.controllerHome,
  );
}

async function executeRetainedDesktopAction(
  input: AssistantPluginActionExecutionInput,
  args: Record<string, unknown>,
  interactionId?: string,
): Promise<Record<string, unknown>> {
  return await executeDesktopProductAction(input, input.actionId, args, interactionId);
}

function isMissingProviderSessionFailure(error: unknown): error is AssistantPluginError {
  return (
    error instanceof AssistantPluginError && error.code === 'SESSION_NOT_FOUND' && error.effectOutcome === 'failed'
  );
}

/**
 * Bundle/app-name open may recover after a recycled PID pin fails at the provider.
 * APP_NOT_RUNNING and observe-time PROCESS_ID_MISMATCH stay fail-closed so durable
 * targets remain for explicit relaunch / operator decision.
 */
function isRecoverableStaleDesktopProcessBinding(error: unknown): error is AssistantPluginError {
  return error instanceof AssistantPluginError && error.code === 'APP_PROCESS_NOT_RUNNING';
}

async function rebindProviderSession(
  input: AssistantPluginActionExecutionInput,
  lease: ComputerApplicationTargetLease,
  provider: DesktopSessionProvider,
): Promise<string> {
  const target = lease.current();
  const rebound = await provider.executeAction(
    providerInput(
      input,
      'desktop_session_open',
      {
        ...(target.stableIdentity.bundleId
          ? { bundle_id: target.stableIdentity.bundleId }
          : { app_name: target.stableIdentity.appName }),
        launch: input.args.launch === true,
        activate: input.args.activate === true,
        ...(exactDesktopProcessId(input.args) !== undefined ? { process_id: exactDesktopProcessId(input.args) } : {}),
        ...(input.args.bundle_path !== undefined ? { bundle_path: input.args.bundle_path } : {}),
        ...(exactDesktopProcessId(input.args) !== undefined ? { reuse_existing: false } : {}),
      },
      'binding-reopen',
    ),
  );
  const interactionId = providerSessionId(rebound);
  if (!targetMatchesProviderSession(target, rebound) || !exactDesktopSelectorVerified(rebound, input.args)) {
    try {
      await provider.executeAction(
        providerInput(
          input,
          'desktop_session_close',
          { interaction_id: interactionId },
          'binding-reopen-identity-compensate',
        ),
      );
    } catch (cleanupError) {
      throw new AssistantPluginError(
        'PLUGIN_COMPUTER_TARGET_REBIND_IDENTITY_CLEANUP_UNKNOWN',
        'Computer target rebind returned an unverifiable application identity and provider-session cleanup could not be confirmed.',
        {
          retryable: false,
          details: {
            targetId: target.targetId,
            cleanupCause: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          },
        },
      );
    }
    throw new AssistantPluginError(
      'PLUGIN_COMPUTER_TARGET_REBIND_IDENTITY_MISMATCH',
      'Computer target rebind did not verify the requested application identity, exact PID or bundle path.',
      { retryable: false, details: { targetId: target.targetId, stableIdentity: target.stableIdentity } },
    );
  }
  const processId = providerProcessId(rebound);
  const reportedProvenance = explicitLaunchProvenanceFromProviderResult(rebound, processId);
  // Reattaching the same owned PID keeps its ownership. A newly launched PID
  // must replace stale provenance in the single durable target authority.
  const launchProvenance =
    target.launchProvenance?.kind === 'provider_launched' && target.launchProvenance.processId === processId
      ? target.launchProvenance
      : reportedProvenance;
  lease.bind(
    {
      providerId: activeDesktopProviderId(),
      providerSessionId: interactionId,
      observedAt: new Date().toISOString(),
      ...(processId !== undefined ? { processId } : {}),
    },
    launchProvenance,
  );
  return interactionId;
}

function providerProcessId(result: Record<string, unknown>): number | undefined {
  const value = result.pid ?? result.process_id;
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new AssistantPluginError(
      'PLUGIN_COMPUTER_TARGET_PROCESS_ID_INVALID',
      'Native Computer provider returned an invalid application process identifier.',
      { retryable: false, details: { processId: value } },
    );
  }
  return value;
}

function explicitLaunchProvenanceFromProviderResult(
  result: Record<string, unknown>,
  processId: number | undefined,
): ComputerApplicationLaunchProvenance | undefined {
  const rawOwnership = result.applicationOwnership ?? result.application_ownership;
  const rawOwnedPid = result.ownedProcessIdentifier ?? result.owned_process_identifier;
  if (rawOwnership === undefined && rawOwnedPid === undefined) return undefined;
  if (rawOwnership === 'preexisting' && rawOwnedPid === undefined) return { kind: 'preexisting' };
  if (
    rawOwnership === 'provider_launched' &&
    typeof rawOwnedPid === 'number' &&
    Number.isInteger(rawOwnedPid) &&
    rawOwnedPid > 0 &&
    rawOwnedPid <= 2_147_483_647 &&
    processId === rawOwnedPid
  ) {
    return { kind: 'provider_launched', processId: rawOwnedPid };
  }
  throw new AssistantPluginError(
    'PLUGIN_COMPUTER_TARGET_LAUNCH_PROVENANCE_INVALID',
    'Native Computer provider returned inconsistent application launch provenance.',
    {
      retryable: false,
      details: { applicationOwnership: rawOwnership, ownedProcessIdentifier: rawOwnedPid, processId },
    },
  );
}

function inheritedLaunchProvenance(
  controllerHome: string,
  processId: number | undefined,
): ComputerApplicationLaunchProvenance | undefined {
  if (processId === undefined) return undefined;
  const owner = computerTargetAuthority
    .listAllApplications(controllerHome)
    .find(
      (target) =>
        target.launchProvenance?.kind === 'provider_launched' &&
        target.launchProvenance.processId === processId &&
        target.providerBinding?.processId === processId,
    );
  return owner ? { kind: 'provider_launched', processId } : undefined;
}

function stableIdentityFromProviderResult(
  result: Record<string, unknown>,
  requested: ComputerApplicationStableIdentity,
): ComputerApplicationStableIdentity {
  const returnedBundleId = firstString(result, 'bundleIdentifier', 'bundle_id');
  const returnedAppName = firstString(result, 'appName', 'app_name');
  if (requested.bundleId && returnedBundleId !== requested.bundleId) {
    throw new AssistantPluginError(
      returnedBundleId ? 'PLUGIN_COMPUTER_TARGET_IDENTITY_MISMATCH' : 'PLUGIN_COMPUTER_TARGET_IDENTITY_UNVERIFIED',
      returnedBundleId
        ? 'Native Computer provider opened a different application bundle than the authorized target.'
        : 'Native Computer provider did not return the application bundle required to verify the authorized target.',
      { retryable: false, details: { requestedBundleId: requested.bundleId, returnedBundleId } },
    );
  }
  if (!requested.bundleId && requested.appName && returnedAppName !== requested.appName) {
    throw new AssistantPluginError(
      returnedAppName ? 'PLUGIN_COMPUTER_TARGET_IDENTITY_MISMATCH' : 'PLUGIN_COMPUTER_TARGET_IDENTITY_UNVERIFIED',
      returnedAppName
        ? 'Native Computer provider opened a different application name than the authorized target.'
        : 'Native Computer provider did not return the application name required to verify the authorized target.',
      { retryable: false, details: { requestedAppName: requested.appName, returnedAppName } },
    );
  }
  return {
    ...(returnedBundleId ? { bundleId: returnedBundleId } : requested.bundleId ? { bundleId: requested.bundleId } : {}),
    ...(returnedAppName ? { appName: returnedAppName } : requested.appName ? { appName: requested.appName } : {}),
  };
}

function desktopTargetSummary(target: ComputerApplicationTarget): Record<string, unknown> {
  return {
    targetId: target.targetId,
    kind: target.kind,
    stableIdentity: target.stableIdentity,
    providerBound: target.providerBinding?.providerId === activeDesktopProviderId(),
    ...(target.providerBinding?.processId !== undefined ? { processId: target.providerBinding.processId } : {}),
    launchOwnership: target.launchProvenance?.kind ?? 'unknown',
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
  };
}

async function listDesktopTargets(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  const requestedLimit =
    typeof input.args.limit === 'number' && Number.isInteger(input.args.limit) ? input.args.limit : 50;
  const limit = Math.min(100, Math.max(1, requestedLimit));
  const requestedOffset =
    typeof input.args.offset === 'number' && Number.isInteger(input.args.offset) ? input.args.offset : 0;
  const offset = Math.max(0, requestedOffset);
  const bundleId = typeof input.args.bundle_id === 'string' ? input.args.bundle_id.trim() : '';
  const appName = typeof input.args.app_name === 'string' ? input.args.app_name.trim() : '';
  if (bundleId && appName) {
    throw new AssistantPluginError(
      'PLUGIN_COMPUTER_TARGET_FILTER_AMBIGUOUS',
      'Specify bundle_id or app_name, not both.',
      { retryable: false },
    );
  }
  const all = computerTargetAuthority
    .listAllApplications(input.controllerHome)
    .filter((target) =>
      bundleId
        ? target.stableIdentity.bundleId === bundleId
        : appName
          ? target.stableIdentity.appName === appName
          : true,
    )
    .sort(
      (left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.targetId.localeCompare(right.targetId),
    );
  const targets = all.slice(offset, offset + limit).map(desktopTargetSummary);
  const nextOffset = offset + targets.length < all.length ? offset + targets.length : undefined;
  // WSL may observe the Windows host without claiming any durable application
  // target. Exact target binding remains a separate, explicitly fenced step.
  const windowsHost = currentComputerPlatform() === 'linux' ? await probeWindowsComputerObservation() : undefined;
  return {
    targets,
    total: all.length,
    returned: targets.length,
    truncated: nextOffset !== undefined,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    ...(windowsHost ? { windowsHost } : {}),
  };
}

function sameRequestedApplication(
  target: ComputerApplicationTarget,
  requested: ComputerApplicationStableIdentity,
): boolean {
  return requested.bundleId
    ? target.stableIdentity.bundleId === requested.bundleId
    : target.stableIdentity.appName === requested.appName;
}

let desktopTargetProcessLivenessCheck: ((pid: number) => boolean) | undefined;

/** Test-only override for live-PID disambiguation. Production uses isProcessAlive. */
export function setComputerDesktopTargetProcessLivenessCheckForTest(
  check: ((pid: number) => boolean) | undefined,
): void {
  desktopTargetProcessLivenessCheck = check;
}

function desktopTargetProcessIsLive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  return (desktopTargetProcessLivenessCheck ?? isProcessAlive)(pid);
}

/**
 * Bundle/app-name reopen must not treat dead historical PIDs as reusable
 * identity. Prefer the single still-running binding; if every bound PID is
 * dead (one or many), fall through and open a fresh provider session.
 * Targets without a verified processId stay reusable so legacy reattach /
 * process_id-required fencing remains intact.
 */
function resolveReusableDesktopTargets(candidates: ComputerApplicationTarget[]): {
  reusable?: ComputerApplicationTarget;
  ambiguous: boolean;
  sameProcessDuplicates?: ComputerApplicationTarget[];
} {
  if (candidates.length === 0) return { ambiguous: false };
  const live = candidates.filter((target) => desktopTargetProcessIsLive(target.providerBinding?.processId));
  if (live.length === 1) return { reusable: live[0], ambiguous: false };
  if (live.length > 1) {
    const byProcessId = new Map<number, ComputerApplicationTarget[]>();
    for (const target of live) {
      const processId = target.providerBinding?.processId;
      if (processId === undefined) continue;
      const group = byProcessId.get(processId) ?? [];
      group.push(target);
      byProcessId.set(processId, group);
    }
    // Multiple durable records for one live PID are duplicates, not ambiguity.
    if (byProcessId.size === 1) {
      // Prefer the oldest durable record as the canonical target for this PID.
      const group = [...byProcessId.values()][0]!
        .slice()
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      return {
        reusable: group[0],
        ambiguous: false,
        sameProcessDuplicates: group.slice(1),
      };
    }
    return { ambiguous: true };
  }
  // No live PIDs. A lone unverified historical target may still be reattached;
  // multiple unverified or only-dead piles must open fresh rather than AMBIGUOUS.
  const unverified = candidates.filter((target) => target.providerBinding?.processId === undefined);
  if (unverified.length === 1 && candidates.length === 1) {
    return { reusable: unverified[0], ambiguous: false };
  }
  return { ambiguous: false };
}

/** Tombstone listed application targets. Best-effort; missing leases do not block open. */
async function retireDesktopApplicationTargets(
  controllerHome: string,
  candidates: ComputerApplicationTarget[],
): Promise<void> {
  for (const candidate of candidates) {
    try {
      await computerTargetAuthority.withLease(controllerHome, candidate.targetId, async (lease) => {
        lease.tombstone();
        return { retired: true };
      });
    } catch (error) {
      if (error instanceof AssistantPluginError) continue;
      throw error;
    }
  }
}

function projectElementObservation(result: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = { ...result };
  delete projected.interactionId;
  delete projected.pid;
  delete projected.bundleIdentifier;
  delete projected.appName;
  const root = projected.root;
  if (root && typeof root === 'object' && !Array.isArray(root)) {
    const nextRoot = { ...(root as Record<string, unknown>) };
    delete nextRoot.target;
    projected.root = nextRoot;
  }
  return projected;
}

function staleProviderBinding(targetId: string, providerBound: boolean): AssistantPluginError {
  return new AssistantPluginError(
    'COMPUTER_TARGET_PROVIDER_BINDING_STALE',
    'The stored Computer provider binding is missing or stale. Use desktop_target_open to explicitly reattach the target before observing or acting.',
    { retryable: true, details: { targetId, providerBound } },
  );
}

async function openDesktopTarget(
  input: AssistantPluginActionExecutionInput,
  provider: DesktopSessionProvider,
): Promise<Record<string, unknown>> {
  const requestedTargetId = explicitTargetIdFromArgs(input.args);
  const expectedProcessId = exactDesktopProcessId(input.args);
  if (currentComputerPlatform() === 'linux' && !requestedTargetId && expectedProcessId === undefined) {
    throw new AssistantPluginError(
      'WINDOWS_UIA_EXACT_TARGET_REQUIRED',
      'Windows observation requires an exact process_id when creating a new target.',
      { retryable: false },
    );
  }
  let current: ComputerApplicationTarget | undefined;
  if (requestedTargetId) {
    current = computerTargetAuthority.require(input.controllerHome, requestedTargetId);
  } else {
    const requested = stableIdentityFromArgs(input.args);
    const existing = computerTargetAuthority
      .listAllApplications(input.controllerHome)
      .filter(
        (target) =>
          sameRequestedApplication(target, requested) &&
          (expectedProcessId === undefined || target.providerBinding?.processId === expectedProcessId),
      );
    if (expectedProcessId !== undefined) {
      if (existing.length > 1) {
        throw new AssistantPluginError(
          'PLUGIN_COMPUTER_TARGET_IDENTITY_AMBIGUOUS',
          'More than one active Computer target matches this application identity; specify one exact target_id to reattach without creating another target.',
          { retryable: false, details: { targetIds: existing.map((target) => target.targetId).slice(0, 8) } },
        );
      }
      current = existing[0];
    } else {
      const resolved = resolveReusableDesktopTargets(existing);
      if (resolved.ambiguous) {
        throw new AssistantPluginError(
          'PLUGIN_COMPUTER_TARGET_IDENTITY_AMBIGUOUS',
          'More than one live Computer target matches this application identity; specify one exact target_id or process_id to reattach without creating another target.',
          { retryable: false, details: { targetIds: existing.map((target) => target.targetId).slice(0, 8) } },
        );
      }
      current = resolved.reusable;
      if (resolved.sameProcessDuplicates && resolved.sameProcessDuplicates.length > 0) {
        await retireDesktopApplicationTargets(input.controllerHome, resolved.sameProcessDuplicates);
      }
      if (!current && existing.length > 0) {
        // Nothing reusable: retire dead-PID and unverified historical piles so the
        // next identity open is a single live binding.
        await retireDesktopApplicationTargets(input.controllerHome, existing);
      }
    }
  }
  if (current) {
    try {
      return await computerTargetAuthority.withLease(input.controllerHome, current.targetId, async (lease) => {
        const target = lease.current();
        const binding = target.providerBinding;
        if (
          expectedProcessId !== undefined &&
          binding?.processId !== undefined &&
          binding.processId !== expectedProcessId
        ) {
          throw new AssistantPluginError(
            'PLUGIN_COMPUTER_TARGET_PROCESS_ID_MISMATCH',
            'Existing target is bound to a different process; a requested exact PID cannot silently replace its identity.',
            {
              retryable: false,
              details: { targetId: target.targetId, expectedProcessId, boundProcessId: binding.processId },
            },
          );
        }
        if (binding && binding.providerId !== activeDesktopProviderId()) {
          throw new AssistantPluginError(
            'PLUGIN_COMPUTER_TARGET_PROVIDER_MISMATCH',
            'Computer target is bound to a different provider and cannot be reattached through the active Desktop provider.',
            { retryable: false, details: { targetId: target.targetId, providerId: binding.providerId } },
          );
        }
        if (binding?.providerId === WINDOWS_COMPUTER_PROVIDER_ID) {
          if (input.args.launch === true || input.args.activate === true || input.args.bundle_path !== undefined) {
            throw new AssistantPluginError(
              'WINDOWS_UIA_EXACT_TARGET_REQUIRED',
              'Windows observation never launches or activates a target.',
              { retryable: false },
            );
          }
          const observed = await executeRuntimeComputer(
            {
              capability: COMPUTER_OBSERVE_CAPABILITY,
              action: 'observe',
              interactionId: binding.providerSessionId,
              maxDepth: 1,
              maxNodes: 1,
              includeValues: false,
            },
            input.timeoutMs ?? 10_000,
            input.controllerHome,
          );
          if (
            observed.pid !== binding.processId ||
            observed.appName !== target.stableIdentity.appName ||
            observed.interactionId !== binding.providerSessionId
          ) {
            throw new AssistantPluginError(
              'WINDOWS_UIA_BINDING_STALE',
              'Windows target identity changed; retire the stale target before opening another.',
              { retryable: false },
            );
          }
          return desktopTargetSummary(target);
        }
        // A durable target can represent one of several copies of the same bundle,
        // even when reopened by bundle_id. Never trust a provider session to keep
        // its original process identity without reading back the bound PID.
        const boundProcessId = input.args.launch !== true ? binding?.processId : undefined;
        if (
          requestedTargetId &&
          input.args.launch !== true &&
          expectedProcessId === undefined &&
          boundProcessId === undefined
        ) {
          throw new AssistantPluginError(
            'PLUGIN_COMPUTER_TARGET_PROCESS_ID_REQUIRED',
            'This historical target has no verified process binding; provide the exact live process_id to attach safely.',
            { retryable: false, details: { targetId: target.targetId } },
          );
        }
        if (binding && input.args.activate !== true && expectedProcessId === undefined) {
          try {
            const exactRead = boundProcessId !== undefined;
            const observed = exactRead
              ? await executeRuntimeComputer(
                  {
                    capability: COMPUTER_ELEMENT_OBSERVE_CAPABILITY,
                    action: 'observe_elements',
                    interactionId: binding.providerSessionId,
                    maxDepth: 1,
                    maxNodes: 1,
                    includeValues: false,
                  },
                  input.timeoutMs ?? 30_000,
                  input.controllerHome,
                )
              : await provider.executeAction(
                  providerInput(
                    input,
                    'desktop_observe',
                    {
                      interaction_id: binding.providerSessionId,
                      max_depth: 1,
                      max_nodes: 1,
                    },
                    'target-open-verify-binding',
                  ),
                );
            if (
              exactRead &&
              (observed.pid !== boundProcessId || observed.interactionId !== binding.providerSessionId)
            ) {
              throw new AssistantPluginError(
                'PLUGIN_COMPUTER_TARGET_PROCESS_ID_MISMATCH',
                'The existing Desktop provider session no longer proves the durable target process identity.',
                { retryable: false, details: { targetId: target.targetId, boundProcessId } },
              );
            }
            return desktopTargetSummary(target);
          } catch (error) {
            if (!isMissingProviderSessionFailure(error)) throw error;
          }
        }
        await rebindProviderSession(
          boundProcessId !== undefined && expectedProcessId === undefined
            ? { ...input, args: { ...input.args, process_id: boundProcessId } }
            : input,
          lease,
          provider,
        );
        return desktopTargetSummary(lease.current());
      });
    } catch (error) {
      // Identity-based open (no exact target_id/process_id): a live OS PID can still
      // be the wrong process after recycle. Retire the stale binding and open fresh.
      if (requestedTargetId || expectedProcessId !== undefined || !isRecoverableStaleDesktopProcessBinding(error)) {
        throw error;
      }
      try {
        await computerTargetAuthority.withLease(input.controllerHome, current.targetId, async (lease) => {
          lease.tombstone();
          return { retired: true };
        });
      } catch (retireError) {
        if (!(retireError instanceof AssistantPluginError)) throw retireError;
      }
    }
  }

  const requested = stableIdentityFromArgs(input.args);
  const opened = await provider.executeAction(
    providerInput(
      input,
      'desktop_session_open',
      {
        ...input.args,
        ...(expectedProcessId !== undefined ? { reuse_existing: false } : {}),
      },
      'target-open',
    ),
  );
  const interactionId = providerSessionId(opened);
  let stableIdentity: ComputerApplicationStableIdentity;
  try {
    stableIdentity = stableIdentityFromProviderResult(opened, requested);
    if (!exactDesktopSelectorVerified(opened, input.args)) {
      throw new AssistantPluginError(
        'PLUGIN_COMPUTER_TARGET_PROCESS_ID_MISMATCH',
        'Native provider did not prove that it selected the exact requested process and bundle path.',
        { retryable: false },
      );
    }
  } catch (error) {
    try {
      await provider.executeAction(
        providerInput(
          input,
          'desktop_session_close',
          { interaction_id: interactionId },
          'target-open-identity-compensate',
        ),
      );
    } catch (cleanupError) {
      throw new AssistantPluginError(
        'PLUGIN_COMPUTER_TARGET_IDENTITY_MISMATCH_CLEANUP_UNKNOWN',
        'Computer target identity drift was detected but provider-session cleanup could not be confirmed.',
        {
          retryable: false,
          details: {
            cause: error instanceof Error ? error.message : String(error),
            cleanupCause: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          },
        },
      );
    }
    throw error;
  }
  let processId: number | undefined;
  let explicitProvenance: ComputerApplicationLaunchProvenance | undefined;
  try {
    processId = providerProcessId(opened);
    explicitProvenance = explicitLaunchProvenanceFromProviderResult(opened, processId);
  } catch (error) {
    try {
      await provider.executeAction(
        providerInput(
          input,
          'desktop_session_close',
          { interaction_id: interactionId },
          'target-open-provenance-compensate',
        ),
      );
    } catch (cleanupError) {
      throw new AssistantPluginError(
        'PLUGIN_COMPUTER_TARGET_LAUNCH_PROVENANCE_CLEANUP_UNKNOWN',
        'Computer target launch provenance was invalid and provider-session cleanup could not be confirmed.',
        {
          retryable: false,
          details: {
            cause: error instanceof Error ? error.message : String(error),
            cleanupCause: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          },
        },
      );
    }
    throw error;
  }
  try {
    const launchProvenance =
      explicitProvenance?.kind === 'provider_launched'
        ? explicitProvenance
        : (inheritedLaunchProvenance(input.controllerHome, processId) ?? explicitProvenance);
    const target = computerTargetAuthority.create(input.controllerHome, {
      stableIdentity,
      ...(launchProvenance ? { launchProvenance } : {}),
      providerBinding: {
        providerId: activeDesktopProviderId(),
        providerSessionId: interactionId,
        observedAt: new Date().toISOString(),
        ...(processId !== undefined ? { processId } : {}),
      },
    });
    return desktopTargetSummary(target);
  } catch (error) {
    try {
      await provider.executeAction(
        providerInput(input, 'desktop_session_close', { interaction_id: interactionId }, 'target-open-compensate'),
      );
    } catch (cleanupError) {
      throw new AssistantPluginError(
        'PLUGIN_COMPUTER_TARGET_PERSIST_FAILED',
        'Computer target persistence failed and provider-session cleanup could not be confirmed.',
        {
          retryable: false,
          details: {
            cause: error instanceof Error ? error.message : String(error),
            cleanupCause: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          },
        },
      );
    }
    throw error;
  }
}

async function closeDesktopTarget(
  input: AssistantPluginActionExecutionInput,
  provider: DesktopSessionProvider | undefined,
): Promise<Record<string, unknown>> {
  const targetId = typeof input.args.target_id === 'string' ? input.args.target_id.trim() : '';
  if (!targetId)
    throw new AssistantPluginError('PLUGIN_COMPUTER_TARGET_REQUIRED', 'desktop_target_close requires target_id.', {
      retryable: false,
    });
  return computerTargetAuthority.withLease(input.controllerHome, targetId, async (lease) => {
    const target = lease.current();
    if (target.providerBinding) {
      if (target.providerBinding.providerId !== activeDesktopProviderId()) {
        throw new AssistantPluginError(
          'PLUGIN_COMPUTER_TARGET_PROVIDER_MISMATCH',
          'Computer target is bound to a different provider and cannot be retired through the current Desktop provider.',
          {
            retryable: false,
            details: {
              targetId,
              providerId: target.providerBinding.providerId,
              expectedProviderId: activeDesktopProviderId(),
            },
          },
        );
      }
      if (provider) {
        const activeTargets = computerTargetAuthority.listAllApplications(input.controllerHome);
        const anotherActiveTargetUsesBinding = activeTargets.some(
          (candidate) =>
            candidate.targetId !== target.targetId &&
            candidate.providerBinding?.providerId === target.providerBinding?.providerId &&
            candidate.providerBinding?.providerSessionId === target.providerBinding?.providerSessionId,
        );
        if (!anotherActiveTargetUsesBinding) {
          const ownedProcessId =
            target.launchProvenance?.kind === 'provider_launched' ? target.launchProvenance.processId : undefined;
          const anotherActiveTargetUsesOwnedProcess =
            ownedProcessId !== undefined &&
            activeTargets.some(
              (candidate) =>
                candidate.targetId !== target.targetId && candidate.providerBinding?.processId === ownedProcessId,
            );
          await provider.executeAction(
            providerInput(
              input,
              'desktop_session_close',
              {
                interaction_id: target.providerBinding.providerSessionId,
                ...(ownedProcessId !== undefined && !anotherActiveTargetUsesOwnedProcess
                  ? { terminate_owned_pid: ownedProcessId }
                  : {}),
              },
              'target-close-provider',
            ),
          );
        }
      }
      // A missing registration is authoritative absence only because provider uninstall
      // must stop/remove its native lifecycle before the registration is deleted.
    }
    const retired = lease.tombstone();
    return { targetId: retired.targetId, retired: true, stableIdentity: retired.stableIdentity };
  });
}

function stableElementSelector(value: unknown): ComputerSemanticSelector | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if ('ref' in input) return undefined;
  const selector: ComputerSemanticSelector = {};
  for (const key of ['role', 'title', 'identifier'] as const) {
    const item = input[key];
    if (typeof item === 'string' && item.trim()) selector[key] = item.trim();
  }
  return Object.keys(selector).length > 0 ? selector : undefined;
}

function semanticElementObservation(root: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!root) return undefined;
  const state =
    root.state && typeof root.state === 'object' && !Array.isArray(root.state)
      ? Object.fromEntries(
          Object.entries(root.state as Record<string, unknown>)
            .filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value))
            .sort(([left], [right]) => left.localeCompare(right)),
        )
      : undefined;
  return {
    ...(typeof root.role === 'string' ? { role: root.role } : {}),
    ...(typeof root.identifier === 'string' ? { identifier: root.identifier } : {}),
    ...(typeof root.name === 'string' ? { name: root.name } : {}),
    ...(typeof root.title === 'string' ? { title: root.title } : {}),
    ...(typeof root.description === 'string' ? { description: root.description } : {}),
    ...(root.value === null || ['string', 'number', 'boolean'].includes(typeof root.value)
      ? { value: root.value }
      : {}),
    ...(state ? { state } : {}),
  };
}

function selectorMutationPostconditionConfirmed(
  action: ComputerElementSemanticAction,
  requestedValue: unknown,
  beforeRoot: Record<string, unknown> | undefined,
  afterRoot: Record<string, unknown> | undefined,
): boolean {
  if (!afterRoot) return false;
  const after = semanticElementObservation(afterRoot);
  const before = semanticElementObservation(beforeRoot);
  if (!after) return false;

  const afterState =
    after.state && typeof after.state === 'object' && !Array.isArray(after.state)
      ? (after.state as Record<string, unknown>)
      : undefined;
  if (action === 'set_value') return after.value === requestedValue;
  if (action === 'focus') return afterState?.focused === true;
  if (action === 'expand') return afterState?.expanded === true;
  if (action === 'collapse') return afterState?.expanded === false;
  if (action === 'select') return afterState?.selected === true;

  return JSON.stringify(after) !== JSON.stringify(before);
}

async function executeDesktopSemanticAction(
  input: AssistantPluginActionExecutionInput,
  _provider: DesktopSessionProvider,
): Promise<Record<string, unknown>> {
  if (input.actionId === 'desktop_open_url') {
    return executeRetainedDesktopAction(input, input.args);
  }
  const targetId = typeof input.args.target_id === 'string' ? input.args.target_id.trim() : '';
  if (input.actionId === DESKTOP_ELEMENT_ACTION_ACTION) {
    if (!targetId)
      throw new AssistantPluginError('PLUGIN_COMPUTER_TARGET_REQUIRED', 'desktop_element_action requires target_id.', {
        retryable: false,
      });
    const semanticAction =
      typeof input.args.action === 'string' &&
      (COMPUTER_ELEMENT_SEMANTIC_ACTIONS as readonly string[]).includes(input.args.action)
        ? (input.args.action as ComputerElementSemanticAction)
        : undefined;
    const selector = stableElementSelector(input.args.selector);
    const hasExplicitObservation = input.args.observation_revision !== undefined || input.args.ref !== undefined;
    if (!semanticAction || Boolean(selector) === hasExplicitObservation) {
      throw new AssistantPluginError(
        'PLUGIN_COMPUTER_ELEMENT_ACTION_INVALID',
        'desktop_element_action requires one semantic action and exactly one target mode: selector, or observation_revision + ref.',
        { retryable: false },
      );
    }
    return computerTargetAuthority.withLease(input.controllerHome, targetId, async (lease) => {
      const current = lease.current();
      const binding = current.providerBinding;
      const appName = current.stableIdentity.appName ?? current.stableIdentity.bundleId;
      if (!binding || binding.providerId !== DESKTOP_PROVIDER_ID || typeof binding.processId !== 'number' || !appName) {
        throw staleProviderBinding(targetId, Boolean(binding));
      }

      if (selector) {
        // Provider element snapshots are latest-only. Resolve a stable semantic
        // selector and consume the resulting ref under one target lease so no
        // model/tool round-trip can interleave another observation.
        if (binding.elementSnapshotRevision !== undefined) {
          lease.bind({ ...binding, elementSnapshotRevision: undefined }, current.launchProvenance);
        }
        let observed: Record<string, unknown>;
        try {
          observed = await executeDesktopProductAction(
            input,
            DESKTOP_ELEMENT_OBSERVE_ACTION,
            { root_selector: selector, max_depth: 1, max_nodes: 8 },
            binding.providerSessionId,
          );
        } catch (error) {
          if (isMissingProviderSessionFailure(error)) throw staleProviderBinding(targetId, true);
          throw error;
        }
        const snapshotRevision = observed.snapshotRevision;
        const root =
          observed.root && typeof observed.root === 'object' ? (observed.root as Record<string, unknown>) : undefined;
        const ref = typeof root?.ref === 'string' ? root.ref : '';
        if (!Number.isSafeInteger(snapshotRevision) || Number(snapshotRevision) < 1 || !ref) {
          throw new AssistantPluginError(
            'COMPUTER_ELEMENT_OBSERVATION_INVALID',
            'Atomic element selector did not resolve to one valid observed element.',
            { retryable: false, details: { targetId } },
          );
        }
        const providerArgs = {
          action: semanticAction,
          target: {
            interactionId: binding.providerSessionId,
            pid: binding.processId,
            ...(current.stableIdentity.bundleId ? { bundleIdentifier: current.stableIdentity.bundleId } : {}),
            appName,
            snapshotRevision,
          },
          ref,
          ...(input.args.value !== undefined ? { value: input.args.value } : {}),
        };
        try {
          return await executeDesktopProductAction(
            input,
            DESKTOP_ELEMENT_ACTION_ACTION,
            providerArgs,
            binding.providerSessionId,
          );
        } catch (error) {
          if (isMissingProviderSessionFailure(error)) throw staleProviderBinding(targetId, true);
          if (error instanceof AssistantPluginError && error.effectOutcome === 'outcome_unknown') {
            // Never replay an ambiguous mutation. Reconcile it once by observing
            // the same semantic selector while this target lease is still held.
            try {
              const reconciled = await executeDesktopProductAction(
                input,
                DESKTOP_ELEMENT_OBSERVE_ACTION,
                { root_selector: selector, max_depth: 1, max_nodes: 8, include_values: true },
                binding.providerSessionId,
              );
              const reconciledRoot =
                reconciled.root && typeof reconciled.root === 'object'
                  ? (reconciled.root as Record<string, unknown>)
                  : undefined;
              if (selectorMutationPostconditionConfirmed(semanticAction, input.args.value, root, reconciledRoot)) {
                return {
                  acted: true,
                  action: semanticAction,
                  ref,
                  reconciled: true,
                  reconciliation: {
                    status: 'confirmed_by_observation',
                    causeCode: error.code,
                    snapshotRevision: reconciled.snapshotRevision,
                    ...(typeof reconciledRoot?.ref === 'string' ? { ref: reconciledRoot.ref } : {}),
                  },
                };
              }
            } catch (reconciliationError) {
              if (isMissingProviderSessionFailure(reconciliationError)) throw staleProviderBinding(targetId, true);
            }
          }
          throw error;
        }
      }

      const observationRevision = input.args.observation_revision;
      if (
        !Number.isSafeInteger(observationRevision) ||
        typeof input.args.ref !== 'string' ||
        !input.args.ref ||
        binding.elementSnapshotRevision !== observationRevision
      ) {
        throw new AssistantPluginError(
          'COMPUTER_ELEMENT_OBSERVATION_STALE',
          'Observed element epoch no longer matches the current Computer target. Re-observe the target instead of replaying an old element ref.',
          {
            retryable: true,
            details: { targetId, providerBound: Boolean(binding) },
          },
        );
      }
      // Consume before dispatch: a lost action receipt cannot allow replay.
      // The existing Computer target authority stores this rebuildable epoch,
      // so separate MCP requests/processes agree on the same one-shot guard.
      lease.bind({ ...binding, elementSnapshotRevision: undefined }, current.launchProvenance);
      const providerArgs = {
        action: semanticAction,
        target: {
          interactionId: binding.providerSessionId,
          pid: binding.processId,
          ...(current.stableIdentity.bundleId ? { bundleIdentifier: current.stableIdentity.bundleId } : {}),
          appName,
          snapshotRevision: observationRevision,
        },
        ref: input.args.ref,
        ...(input.args.value !== undefined ? { value: input.args.value } : {}),
      };
      try {
        return await executeDesktopProductAction(
          input,
          DESKTOP_ELEMENT_ACTION_ACTION,
          providerArgs,
          binding.providerSessionId,
        );
      } catch (error) {
        if (isMissingProviderSessionFailure(error)) throw staleProviderBinding(targetId, true);
        throw error;
      }
    });
  }
  if (!targetId) {
    if (input.actionId === 'desktop_screenshot') {
      return executeRetainedDesktopAction(input, input.args);
    }
    throw new AssistantPluginError('PLUGIN_COMPUTER_TARGET_REQUIRED', `${input.actionId} requires target_id.`, {
      retryable: false,
    });
  }
  return computerTargetAuthority.withLease(input.controllerHome, targetId, async (lease) => {
    const binding = lease.current().providerBinding;
    const windowsReadOnly =
      input.actionId === 'desktop_observe' && binding?.providerId === WINDOWS_COMPUTER_PROVIDER_ID;
    if (!binding || (binding.providerId !== DESKTOP_PROVIDER_ID && !windowsReadOnly)) {
      throw staleProviderBinding(targetId, Boolean(binding));
    }
    const { target_id: _targetId, ...rest } = input.args;
    try {
      const result = await executeRetainedDesktopAction(input, rest, binding.providerSessionId);
      if (input.actionId === DESKTOP_ELEMENT_OBSERVE_ACTION) {
        if (!Number.isSafeInteger(result.snapshotRevision) || Number(result.snapshotRevision) < 1) {
          throw new AssistantPluginError(
            'COMPUTER_ELEMENT_OBSERVATION_INVALID',
            'Desktop provider did not return a valid element observation revision.',
            { retryable: false },
          );
        }
        const current = lease.current();
        lease.bind(
          { ...binding, elementSnapshotRevision: result.snapshotRevision as number },
          current.launchProvenance,
        );
        return projectElementObservation(result);
      }
      return result;
    } catch (error) {
      if (isMissingProviderSessionFailure(error)) throw staleProviderBinding(targetId, true);
      throw error;
    }
  });
}

function targetAuthorization(identity: ComputerApplicationStableIdentity): AssistantPluginAuthorizationContext {
  const id = identity.bundleId ?? `app-name:${identity.appName}`;
  const identityFingerprint = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return { target: { kind: 'desktop-application', id, identityFingerprint } };
}

async function resolveDesktopAuthorizationContext(
  input: AssistantPluginActionExecutionInput,
): Promise<AssistantPluginAuthorizationContext | undefined> {
  if (input.actionId === DESKTOP_TARGET_LIST_ACTION) return undefined;
  if (
    [
      COMPUTER_CONSOLE_UNLOCK_PREPARE_ACTION,
      COMPUTER_CONSOLE_UNLOCK_ACTION,
      COMPUTER_CONSOLE_UNLOCK_ENROLL_ACTION,
      COMPUTER_CONSOLE_UNLOCK_STATUS_ACTION,
      COMPUTER_CONSOLE_UNLOCK_RECOVER_ACTION,
      COMPUTER_CONSOLE_UNLOCK_REVOKE_ACTION,
    ].includes(input.actionId)
  )
    return undefined;
  if (input.actionId === DESKTOP_TARGET_OPEN_ACTION) {
    const targetId = explicitTargetIdFromArgs(input.args);
    return targetAuthorization(
      targetId
        ? computerTargetAuthority.require(input.controllerHome, targetId).stableIdentity
        : stableIdentityFromArgs(input.args),
    );
  }
  const targetId = typeof input.args.target_id === 'string' ? input.args.target_id.trim() : '';
  if (targetId)
    return targetAuthorization(computerTargetAuthority.require(input.controllerHome, targetId).stableIdentity);
  const provider = desktopProvider(input);
  return provider.resolveAuthorizationContext?.(providerInput(input, input.actionId, input.args));
}

// Computer's browser subdomain always targets the user's real browser.
// The independent Browser plugin retains explicit Playwright scripting modes,
// but Computer must neither select nor silently fall back to those providers.
function computerNativeBrowserInput(input: AssistantPluginActionExecutionInput): AssistantPluginActionExecutionInput {
  if (
    ['configure', 'install_unpacked_extension', 'list_unpacked_extensions', 'clear_session'].includes(input.actionId)
  ) {
    throw new AssistantPluginError(
      'PLUGIN_COMPUTER_BROWSER_SCRIPT_ACTION_SEPARATE',
      'Browser profile configuration and script-managed extensions belong to the independent Browser plugin.',
      { retryable: false },
    );
  }
  if (
    (input.args.browser_mode !== undefined && input.args.browser_mode !== 'attach_preferred') ||
    (input.args.cdp_attach_fallback !== undefined && input.args.cdp_attach_fallback !== 'fail_closed') ||
    (input.args.native_attach_mode !== undefined && input.args.native_attach_mode !== 'auto')
  ) {
    throw new AssistantPluginError(
      'PLUGIN_COMPUTER_BROWSER_SCRIPT_MODE_SEPARATE',
      'Computer only operates the native browser; use the independent Browser plugin for scripted or isolated profiles.',
      { retryable: false },
    );
  }
  return {
    ...input,
    args: {
      ...input.args,
      browser_mode: 'attach_preferred',
      cdp_attach_fallback: 'fail_closed',
      native_attach_mode: 'auto',
      __forge_computer_native_only: true,
    },
  };
}

export const computerPluginAdapter: AssistantPluginAdapter = {
  pluginId: 'computer',
  scope: 'controller',
  // Computer is controller-scoped for its Browser/Desktop/console surface but
  // still owns the repository-bound physical_device_* iPhone actions; keep the
  // repository manifest surface reachable (see AssistantPluginAdapter.repositorySurface).
  repositorySurface: true,
  buildManifest: buildComputerManifest,
  async resolveAuthorizationContext(input) {
    if (isIosPhysicalDeviceAction(input.actionId)) return resolveIosPhysicalDeviceAuthorizationContext(input);
    if (isComputerChatgptTargetAction(input.actionId)) return resolveComputerChatgptAuthorizationContext(input);
    if (!isDesktopProductAction(input.actionId)) {
      return resolveBrowserPluginAuthorizationContext(computerNativeBrowserInput(input));
    }
    return resolveDesktopAuthorizationContext(input);
  },
  async executeAction(input) {
    if (isIosPhysicalDeviceAction(input.actionId)) return executeIosPhysicalDeviceAction(input);
    if (isComputerChatgptTargetAction(input.actionId)) return executeComputerChatgptTargetAction(input);
    if (!isDesktopProductAction(input.actionId)) {
      return executeBrowserPluginAction(computerNativeBrowserInput(input));
    }
    if (input.actionId === COMPUTER_CONSOLE_UNLOCK_PREPARE_ACTION) {
      return executeProtectedConsoleUnlockPreparation(
        { confirmAuthorization: input.confirmAuthorization === true, timeoutMs: input.timeoutMs },
        input.controllerHome,
      );
    }
    if (input.actionId === COMPUTER_CONSOLE_UNLOCK_ACTION) {
      return executeProtectedConsoleUnlockInvocation(
        {
          credentialHandle: typeof input.args.credential_handle === 'string' ? input.args.credential_handle : '',
          confirmAuthorization: input.confirmAuthorization === true,
          timeoutMs: input.timeoutMs,
        },
        input.controllerHome,
      );
    }
    if (input.actionId === COMPUTER_CONSOLE_UNLOCK_ENROLL_ACTION) {
      return executeProtectedConsoleUnlockLifecycle(
        'console_unlock_enroll',
        { confirmAuthorization: input.confirmAuthorization === true, timeoutMs: input.timeoutMs },
        input.controllerHome,
      );
    }
    if (input.actionId === COMPUTER_CONSOLE_UNLOCK_STATUS_ACTION) {
      return executeProtectedConsoleUnlockLifecycle(
        'console_unlock_status',
        { confirmAuthorization: input.confirmAuthorization === true, timeoutMs: input.timeoutMs },
        input.controllerHome,
      );
    }
    if (input.actionId === COMPUTER_CONSOLE_UNLOCK_RECOVER_ACTION) {
      return executeProtectedConsoleUnlockLifecycle(
        'console_unlock_recover',
        { confirmAuthorization: input.confirmAuthorization === true, timeoutMs: input.timeoutMs },
        input.controllerHome,
      );
    }
    if (input.actionId === COMPUTER_CONSOLE_UNLOCK_REVOKE_ACTION) {
      return executeProtectedConsoleUnlockLifecycle(
        'console_unlock_revoke',
        { confirmAuthorization: input.confirmAuthorization === true, timeoutMs: input.timeoutMs },
        input.controllerHome,
      );
    }
    if (input.actionId === DESKTOP_TARGET_LIST_ACTION) return listDesktopTargets(input);
    if (input.actionId === DESKTOP_TARGET_CLOSE_ACTION)
      return closeDesktopTarget(input, optionalDesktopProvider(input));
    const provider = desktopProvider(input);
    if (input.actionId === DESKTOP_TARGET_OPEN_ACTION) return openDesktopTarget(input, provider);
    return executeDesktopSemanticAction(input, provider);
  },
  shouldRefreshManifestAfterAction(actionId) {
    return actionId === 'configure';
  },
};
