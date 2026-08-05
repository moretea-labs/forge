import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { controllerSystemRoot } from '../../cli/repositories/controller-home';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';
import { AssistantPluginError } from './errors';
import { resolveBrowserBridgeNodeExecutable } from './browser-node-bridge';
import { executeManagedPluginProcess, type ManagedPluginProcessRequest, type ManagedPluginProcessSpec } from './managed-process-adapter';
import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginCapability,
  AssistantPluginHealth,
  AssistantPluginManifest,
  AssistantPluginPermissionScope,
} from './types';

const PLUGIN_ID = 'desktop';
const CONFIG_FILE = 'config.json';
const HELPER_VERSION = '1.0.0';
const REQUIRED_CAPABILITIES = ['status', 'observe', 'open_application'];

interface DesktopPluginConfig {
  schemaVersion: 1;
  enabled: boolean;
}

export interface DesktopPluginHooks {
  now?: () => Date;
  platform?: NodeJS.Platform;
  resolveHelperPath?: () => string;
  resolveRuntimeExecutable?: () => string;
  executeManaged?: (spec: ManagedPluginProcessSpec, request: ManagedPluginProcessRequest) => Promise<Record<string, unknown>>;
}

let hooks: DesktopPluginHooks = {};

export function setDesktopPluginHooksForTest(next: DesktopPluginHooks): void {
  hooks = next;
}

export function resetDesktopPluginHooksForTest(): void {
  hooks = {};
}

function now(): string {
  return (hooks.now?.() ?? new Date()).toISOString();
}

function platform(): NodeJS.Platform {
  return hooks.platform ?? process.platform;
}

function pluginRootFromSystemRoot(systemRoot: string): string {
  const root = join(systemRoot, 'desktop');
  mkdirSync(root, { recursive: true });
  return root;
}

function configPathFromSystemRoot(systemRoot: string): string {
  return join(pluginRootFromSystemRoot(systemRoot), CONFIG_FILE);
}

function loadConfig(systemRoot: string): DesktopPluginConfig {
  try {
    const config = readJsonFile<DesktopPluginConfig>(configPathFromSystemRoot(systemRoot));
    return { schemaVersion: 1, enabled: config.enabled === true };
  } catch {
    return { schemaVersion: 1, enabled: false };
  }
}

function saveConfig(systemRoot: string, config: DesktopPluginConfig): DesktopPluginConfig {
  writeJsonAtomic(configPathFromSystemRoot(systemRoot), config);
  return config;
}

export function resolveDesktopRuntimeExecutable(): string {
  return hooks.resolveRuntimeExecutable?.() ?? resolveBrowserBridgeNodeExecutable();
}

export function resolveDesktopHelperPath(options: {
  argvEntry?: string;
  runtimeExecutable?: string;
  sourceHelperPath?: string;
  pathExists?: (path: string) => boolean;
} = {}): string {
  if (hooks.resolveHelperPath) return hooks.resolveHelperPath();
  const argvEntry = options.argvEntry ?? process.argv[1];
  const runtimeExecutable = options.runtimeExecutable ?? process.execPath;
  const sourceHelperPath = options.sourceHelperPath
    ?? fileURLToPath(new URL('../../../bin/repo-harness-desktop-helper.mjs', import.meta.url));
  const pathExists = options.pathExists ?? existsSync;
  const candidates = [
    argvEntry ? join(dirname(argvEntry), 'repo-harness-desktop-helper.mjs') : undefined,
    runtimeExecutable ? join(dirname(runtimeExecutable), 'repo-harness-desktop-helper.mjs') : undefined,
    sourceHelperPath,
  ].filter((entry): entry is string => Boolean(entry));
  for (const candidate of candidates) {
    if (pathExists(candidate)) return candidate;
  }
  throw new AssistantPluginError('PLUGIN_DESKTOP_HELPER_UNAVAILABLE', 'The bundled Desktop helper is missing from the active Repo Harness installation.', {
    retryable: false,
  });
}

function helperAvailability(): { available: boolean; path?: string; error?: string } {
  try {
    return { available: true, path: resolveDesktopHelperPath() };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function runtimeAvailability(): { available: boolean; path?: string; error?: string } {
  try {
    return { available: true, path: resolveDesktopRuntimeExecutable() };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function health(config: DesktopPluginConfig): AssistantPluginHealth {
  const helper = helperAvailability();
  const currentPlatform = platform();
  const runtime = config.enabled && currentPlatform === 'darwin' ? runtimeAvailability() : undefined;
  const details = {
    provider: 'bundled-managed-desktop',
    scope: 'controller',
    repositoryRegistrationRequired: false,
    runtime: 'managed_process',
    transport: 'stdio-jsonl',
    helperVersion: HELPER_VERSION,
    helperBundled: helper.available,
    helperPathReturned: false,
    runtimeProbed: Boolean(runtime),
    runtimeAvailable: runtime?.available ?? false,
    runtimePathReturned: false,
    readinessMode: 'on_demand_helper',
    platform: currentPlatform,
  };
  if (!config.enabled) {
    return {
      state: 'disabled',
      checkedAt: now(),
      ready: false,
      probed: false,
      errors: [],
      warnings: ['Desktop plugin is disabled.'],
      details,
    };
  }
  if (currentPlatform !== 'darwin') {
    return {
      state: 'degraded',
      checkedAt: now(),
      ready: false,
      probed: true,
      errors: [],
      warnings: ['Desktop plugin currently supports macOS only.'],
      details,
    };
  }
  if (!helper.available) {
    return {
      state: 'error',
      checkedAt: now(),
      ready: false,
      probed: true,
      errors: [helper.error ?? 'Bundled Desktop helper is unavailable.'],
      warnings: [],
      details,
    };
  }
  if (!runtime?.available) {
    return {
      state: 'error',
      checkedAt: now(),
      ready: false,
      probed: true,
      errors: [runtime?.error ?? 'A trusted Node runtime for the Desktop helper is unavailable.'],
      warnings: [],
      details,
    };
  }
  return {
    state: 'ready',
    checkedAt: now(),
    ready: true,
    probed: true,
    errors: [],
    warnings: [],
    details,
  };
}

function actions(): AssistantPluginActionDescriptor[] {
  const controllerWrite = [{ resource: 'repo-state' as const, mode: 'write' as const }];
  return [
    {
      actionId: 'configure',
      title: 'Configure Desktop plugin',
      description: 'Enable or disable the bundled managed Desktop helper.',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 15_000,
      cancellable: true,
      idempotent: true,
      scopes: ['desktop.manage'],
      resourceClaims: controllerWrite,
      argumentsSchema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'], additionalProperties: false },
    },
    {
      actionId: 'status',
      title: 'Desktop helper status',
      description: 'Run a live managed-helper handshake and return bounded macOS readiness diagnostics.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 10_000,
      cancellable: true,
      idempotent: true,
      scopes: ['desktop.observe'],
      resourceClaims: [],
      argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: 'observe',
      title: 'Observe active desktop application',
      description: 'Read the frontmost macOS application without capturing the screen or interacting with UI elements.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 10_000,
      cancellable: true,
      idempotent: true,
      scopes: ['desktop.observe'],
      resourceClaims: [],
      argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: 'open_application',
      title: 'Open desktop application',
      description: 'Open one macOS application by exact name or bundle identifier through the managed helper.',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 30_000,
      cancellable: true,
      idempotent: false,
      scopes: ['desktop.open'],
      resourceClaims: controllerWrite,
      argumentsSchema: {
        type: 'object',
        properties: { app_name: { type: 'string' }, bundle_id: { type: 'string' } },
        additionalProperties: false,
      },
    },
  ];
}

function permissions(): AssistantPluginPermissionScope[] {
  return [
    { scope: 'desktop.observe', mode: 'read', description: 'Read bounded frontmost-application and helper readiness diagnostics.', granted: true, required: true },
    { scope: 'desktop.open', mode: 'write', description: 'Open an application after action authorization.', granted: true, required: false },
    { scope: 'desktop.manage', mode: 'write', description: 'Enable or disable the bundled Desktop plugin.', granted: true, required: true },
  ];
}

function capabilities(): AssistantPluginCapability[] {
  return [
    { capabilityId: 'desktop-observe', title: 'Desktop observation', description: 'Inspect the active macOS application without screen capture or UI interaction.', scopes: ['desktop.observe'], actions: ['status', 'observe'] },
    { capabilityId: 'desktop-open', title: 'Desktop application launch', description: 'Open one macOS application through a bounded managed helper.', scopes: ['desktop.open'], actions: ['open_application'] },
    { capabilityId: 'desktop-lifecycle', title: 'Desktop plugin lifecycle', description: 'Enable or disable the bundled helper without installing external packages.', scopes: ['desktop.manage'], actions: ['configure'] },
  ];
}

export function buildDesktopPluginManifest(previousRevision = 0, previousUpdatedAt?: string, systemRoot?: string): AssistantPluginManifest {
  const root = systemRoot ?? process.cwd();
  const config = loadConfig(root);
  const currentHealth = health(config);
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    revision: Math.max(1, previousRevision || 1),
    pluginId: PLUGIN_ID,
    provider: 'bundled-managed-desktop',
    displayName: 'Repo Harness Desktop',
    pluginVersion: '1.0.0',
    authority: {
      strategy: 'derived',
      duplicateStateAllowed: false,
      sourceOfTruth: ['controllerHome:system/desktop/config.json', 'package:bin/repo-harness-desktop-helper.mjs'],
    },
    enabled: config.enabled,
    lifecycle: {
      state: !config.enabled ? 'disabled' : currentHealth.ready ? 'enabled' : currentHealth.state === 'degraded' ? 'degraded' : 'error',
      reason: !config.enabled
        ? 'Desktop plugin is disabled.'
        : currentHealth.ready
          ? 'Bundled Desktop helper is ready for on-demand managed execution.'
          : currentHealth.errors[0] ?? currentHealth.warnings[0],
    },
    health: currentHealth,
    permissions: permissions(),
    capabilities: capabilities(),
    actions: actions(),
    updatedAt: previousUpdatedAt ?? now(),
  };
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = typeof args[key] === 'string' ? String(args[key]).trim() : '';
  return value || undefined;
}

export async function executeDesktopPluginAction(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  const systemRoot = controllerSystemRoot(input.controllerHome);
  const config = loadConfig(systemRoot);
  if (input.actionId === 'configure') {
    const next = saveConfig(systemRoot, { schemaVersion: 1, enabled: input.args.enabled === true });
    return {
      config: next,
      storage: 'controllerHome/system/desktop/config.json',
      health: health(next),
    };
  }
  if (!config.enabled) {
    throw new AssistantPluginError('PLUGIN_DISABLED', 'Desktop plugin is disabled.', { retryable: false });
  }
  if (platform() !== 'darwin') {
    throw new AssistantPluginError('PLUGIN_DESKTOP_PLATFORM_UNSUPPORTED', 'Desktop plugin currently supports macOS only.', { retryable: false });
  }
  if (!REQUIRED_CAPABILITIES.includes(input.actionId)) {
    throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', `desktop/${input.actionId} is not supported.`, { retryable: false });
  }
  if (input.actionId === 'open_application') {
    const appName = optionalString(input.args, 'app_name');
    const bundleId = optionalString(input.args, 'bundle_id');
    if ((!appName && !bundleId) || (appName && bundleId)) {
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Provide exactly one of app_name or bundle_id.', { retryable: false });
    }
  }
  const helperPath = resolveDesktopHelperPath();
  const runtimeExecutable = resolveDesktopRuntimeExecutable();
  const executeManaged = hooks.executeManaged ?? executeManagedPluginProcess;
  return await executeManaged({
    pluginId: PLUGIN_ID,
    helperPath,
    runtimeExecutable,
    requiredCapabilities: REQUIRED_CAPABILITIES,
    timeoutMs: input.timeoutMs,
  }, {
    requestId: input.requestId,
    actionId: input.actionId,
    input: input.args,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
}

export const desktopPluginAdapter = {
  pluginId: PLUGIN_ID,
  scope: 'controller' as const,
  buildManifest: buildDesktopPluginManifest,
  executeAction: executeDesktopPluginAction,
};
