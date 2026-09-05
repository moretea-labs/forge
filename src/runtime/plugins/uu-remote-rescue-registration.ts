import type { ExternalPluginRegistrationInput } from './external-registration';
import type { AssistantPluginActionDescriptor } from './types';

export const UU_REMOTE_RESCUE_PLUGIN_ID = 'uu_remote_rescue';
export const UU_REMOTE_RESCUE_PLUGIN_VERSION = '0.1.1';
export const UU_REMOTE_RESCUE_PROTOCOL_VERSION = '1.0';
export const UU_REMOTE_RESCUE_CAPABILITIES = [
  'uu_remote.device_identity.v1',
  'uu_remote.terminal_transport.v1',
  'forge_wsl.health.v1',
  'forge_wsl.service_recovery.v1',
  'forge_wsl.host_recovery.v1',
] as const;

const REMOTE_WRITE = [{ resource: 'remote' as const, mode: 'write' as const }];
const NO_ARGUMENTS = { type: 'object', properties: {}, additionalProperties: false } as const;

function actions(): AssistantPluginActionDescriptor[] {
  return [
    {
      actionId: 'device_status',
      title: 'Read UU Remote rescue target status',
      description: 'Verify the registration-bound UU Remote Windows device by exact device id, exact device name, platform, and online state.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 10_000,
      cancellable: true,
      idempotent: true,
      foregroundEffect: 'none',
      scopes: ['uu-rescue.device'],
      resourceClaims: [],
      argumentsSchema: NO_ARGUMENTS,
    },
    {
      actionId: 'wsl_status',
      title: 'Read WSL status through UU Remote',
      description: 'Open the exact UU Remote terminal and run only the built-in WSL status/list observation command.',
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 30_000,
      cancellable: true,
      idempotent: true,
      foregroundEffect: 'required',
      scopes: ['uu-rescue.observe'],
      resourceClaims: REMOTE_WRITE,
      argumentsSchema: NO_ARGUMENTS,
    },
    {
      actionId: 'forge_health',
      title: 'Read remote WSL Forge health',
      description: 'Read Controller Home presence, migration record, and the exact Runtime, Connector, and Recovery systemd-user service states through a fixed remote probe.',
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 30_000,
      cancellable: true,
      idempotent: true,
      foregroundEffect: 'required',
      scopes: ['uu-rescue.observe'],
      resourceClaims: REMOTE_WRITE,
      argumentsSchema: NO_ARGUMENTS,
    },
    ...(['runtime_start', 'runtime_restart', 'connector_start', 'connector_restart', 'recovery_start', 'recovery_restart', 'runtime_recover'] as const).map((actionId): AssistantPluginActionDescriptor => ({
      actionId,
      title: ({
        runtime_start: 'Start remote Forge Runtime',
        runtime_restart: 'Restart remote Forge Runtime',
        connector_start: 'Start remote Forge Connector',
        connector_restart: 'Restart remote Forge Connector',
        recovery_start: 'Start remote Forge Recovery services',
        recovery_restart: 'Restart remote Forge Recovery services',
        runtime_recover: 'Recover remote Forge Runtime',
      } as const)[actionId],
      description: actionId === 'runtime_recover'
        ? 'Invoke only the canonical `forge recovery recover --controller-home <configured-home>` transaction inside the configured WSL distro.'
        : 'Operate only the registration-derived canonical systemd-user unit(s); no caller-provided service name or shell command is accepted.',
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'authorization',
      defaultTimeoutMs: actionId === 'runtime_recover' ? 120_000 : 30_000,
      cancellable: true,
      idempotent: actionId.endsWith('_start'),
      foregroundEffect: 'required',
      scopes: ['uu-rescue.recover'],
      resourceClaims: REMOTE_WRITE,
      argumentsSchema: NO_ARGUMENTS,
    })),
    ...(['host_tunnel_restart_dispatch', 'host_full_recover_dispatch'] as const).map((actionId): AssistantPluginActionDescriptor => ({
      actionId,
      title: actionId === 'host_tunnel_restart_dispatch'
        ? 'Dispatch independent host tunnel recovery'
        : 'Dispatch independent host full recovery',
      description: actionId === 'host_tunnel_restart_dispatch'
        ? 'Safely dispatch the fixed independent Windows/WSL Recovery tunnel_restart action to the registration-bound UU Remote Windows host. Success proves only dispatch; Forge Cloud connectivity must verify recovery.'
        : 'Safely dispatch the fixed independent Windows/WSL Recovery full_recover action to the registration-bound UU Remote Windows host. Success proves only dispatch; Forge Cloud connectivity must verify recovery.',
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 30_000,
      cancellable: true,
      idempotent: false,
      foregroundEffect: 'required',
      scopes: ['uu-rescue.recover'],
      resourceClaims: REMOTE_WRITE,
      argumentsSchema: NO_ARGUMENTS,
    })),
  ];
}

export interface UuRemoteRescueRegistrationOptions {
  runtimeExecutable: string;
  helperPath: string;
  configDirectory: string;
  enabled?: boolean;
}

export function createUuRemoteRescueRegistrationInput(
  options: UuRemoteRescueRegistrationOptions,
): ExternalPluginRegistrationInput {
  const registeredActions = actions();
  return {
    pluginId: UU_REMOTE_RESCUE_PLUGIN_ID,
    providerPluginId: UU_REMOTE_RESCUE_PLUGIN_ID,
    displayName: 'Forge UU Remote Rescue',
    provider: 'local-macos',
    pluginVersion: UU_REMOTE_RESCUE_PLUGIN_VERSION,
    protocolVersion: UU_REMOTE_RESCUE_PROTOCOL_VERSION,
    scope: 'controller',
    enabled: options.enabled !== false,
    transport: {
      kind: 'managed_cli_json',
      runtimeExecutable: options.runtimeExecutable,
      helperPath: options.helperPath,
      cwd: options.configDirectory,
      requiredCapabilities: [...UU_REMOTE_RESCUE_CAPABILITIES],
      healthTimeoutMs: 10_000,
      actionTimeoutMs: 120_000,
      maxRequestBytes: 64 * 1024,
      maxResponseBytes: 256 * 1024,
    },
    permissions: [
      { scope: 'uu-rescue.device', mode: 'read', description: 'Read only the exact configured UU Remote device identity and online state.', granted: true, required: true },
      { scope: 'uu-rescue.observe', mode: 'write', description: 'Open the exact configured UU terminal transiently and send only built-in diagnostic commands.', granted: true, required: false },
      { scope: 'uu-rescue.recover', mode: 'write', description: 'Operate only the configured WSL Forge Runtime, Connector, and Recovery service identities using fixed recovery actions.', granted: true, required: false },
    ],
    capabilities: [
      { capabilityId: 'uu-rescue.device', title: 'UU Remote rescue device identity', description: 'Exact device identity and online-state fencing.', scopes: ['uu-rescue.device'], actions: ['device_status'] },
      { capabilityId: 'uu-rescue.observe', title: 'Remote WSL/Forge observation', description: 'Fixed WSL and Forge health probes over the UU Remote terminal.', scopes: ['uu-rescue.observe'], actions: ['wsl_status', 'forge_health'] },
      { capabilityId: 'uu-rescue.recover', title: 'Remote Forge recovery', description: 'Allowlisted start/restart/recovery operations for the existing single Forge service authorities.', scopes: ['uu-rescue.recover'], actions: ['runtime_start', 'runtime_restart', 'connector_start', 'connector_restart', 'recovery_start', 'recovery_restart', 'runtime_recover', 'host_tunnel_restart_dispatch', 'host_full_recover_dispatch'] },
    ],
    actions: registeredActions,
  };
}
