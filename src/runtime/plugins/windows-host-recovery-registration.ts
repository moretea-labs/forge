import type { ExternalPluginRegistrationInput } from './external-registration';
import type { AssistantPluginActionDescriptor } from './types';

export const WINDOWS_HOST_RECOVERY_PLUGIN_ID = 'windows_host_recovery';
export const WINDOWS_HOST_RECOVERY_PLUGIN_VERSION = '0.1.3';
export const WINDOWS_HOST_RECOVERY_PROTOCOL_VERSION = '1.0';
export const WINDOWS_HOST_RECOVERY_CAPABILITIES = [
  'windows_host.identity.v1',
  'windows_host.recovery_task.v1',
  'forge_wsl.host_recovery.v1',
] as const;

const NO_ARGUMENTS = { type: 'object', properties: {}, additionalProperties: false } as const;
const REMOTE_WRITE = [{ resource: 'remote' as const, mode: 'write' as const }];
const ACTIONS = [
  'host_status', 'task_status', 'task_install', 'task_run',
  'wsl_status', 'wsl_start', 'forge_source_status', 'controller_status',
  'runtime_status', 'runtime_start', 'runtime_restart',
  'connector_status', 'connector_start', 'connector_restart',
  'recovery_status', 'recovery_start', 'recovery_restart',
  'tunnel_status', 'tunnel_start', 'tunnel_restart',
  'forge_cloud_verify', 'full_recover',
] as const;
const READONLY = new Set<string>(['host_status', 'task_status', 'wsl_status', 'forge_source_status', 'controller_status', 'runtime_status', 'connector_status', 'recovery_status', 'tunnel_status', 'forge_cloud_verify']);

function actionDescriptors(): AssistantPluginActionDescriptor[] {
  return ACTIONS.map((actionId) => {
    const readOnly = READONLY.has(actionId);
    return {
      actionId,
      title: `Windows host recovery: ${actionId}`,
      description: readOnly
        ? 'Read one fixed Windows/WSL recovery status surface; no caller-provided command or target is accepted.'
        : 'Execute one allowlisted Windows/WSL recovery action against the canonical ForgeRecovery.ps1 installation; no caller-provided command, path, task, service, or shell argument is accepted.',
      readOnly,
      risk: readOnly ? 'readonly' : 'remote_write',
      confirmation: readOnly ? 'none' : 'authorization',
      defaultTimeoutMs: actionId === 'full_recover' ? 120_000 : 30_000,
      cancellable: true,
      idempotent: !actionId.endsWith('_restart') && actionId !== 'task_run',
      foregroundEffect: 'none',
      scopes: [readOnly ? 'windows-recovery.observe' : 'windows-recovery.recover'],
      resourceClaims: readOnly ? [] : REMOTE_WRITE,
      argumentsSchema: NO_ARGUMENTS,
    } satisfies AssistantPluginActionDescriptor;
  });
}

export function createWindowsHostRecoveryRegistrationInput(options: {
  runtimeExecutable: string;
  helperPath: string;
  configDirectory: string;
  enabled?: boolean;
}): ExternalPluginRegistrationInput {
  return {
    pluginId: WINDOWS_HOST_RECOVERY_PLUGIN_ID,
    providerPluginId: WINDOWS_HOST_RECOVERY_PLUGIN_ID,
    displayName: 'Forge Windows Host Recovery',
    provider: 'local-wsl-windows',
    pluginVersion: WINDOWS_HOST_RECOVERY_PLUGIN_VERSION,
    protocolVersion: WINDOWS_HOST_RECOVERY_PROTOCOL_VERSION,
    scope: 'controller',
    enabled: options.enabled !== false,
    transport: {
      kind: 'managed_cli_json',
      runtimeExecutable: options.runtimeExecutable,
      helperPath: options.helperPath,
      cwd: options.configDirectory,
      requiredCapabilities: [...WINDOWS_HOST_RECOVERY_CAPABILITIES],
      healthTimeoutMs: 10_000,
      actionTimeoutMs: 120_000,
      maxRequestBytes: 32 * 1024,
      maxResponseBytes: 256 * 1024,
    },
    permissions: [
      { scope: 'windows-recovery.observe', mode: 'read', description: 'Read only fixed Windows host and WSL Recovery status surfaces.', granted: true, required: true },
      { scope: 'windows-recovery.recover', mode: 'write', description: 'Run only fixed Windows Task Scheduler and WSL Forge recovery actions.', granted: true, required: false },
    ],
    capabilities: [
      { capabilityId: 'windows-recovery.observe', title: 'Windows Recovery observation', description: 'Fixed host/task/WSL health observations.', scopes: ['windows-recovery.observe'], actions: ACTIONS.filter((action) => READONLY.has(action)) },
      { capabilityId: 'windows-recovery.recover', title: 'Windows Recovery control', description: 'Allowlisted host cold-start and WSL service recovery actions.', scopes: ['windows-recovery.recover'], actions: ACTIONS.filter((action) => !READONLY.has(action)) },
    ],
    actions: actionDescriptors(),
  };
}
