export interface ComputerProviderRegistrationSource {
  revision: number;
  enabled: boolean;
  providerPluginId: string;
  protocolVersion: string;
  capabilities: Array<{ capabilityId: string }>;
  transport: {
    kind: string;
    socketPath?: string;
    maxResponseBytes?: number;
    healthTimeoutMs?: number;
    actionTimeoutMs?: number;
  };
}

export interface ComputerProviderRegistrationSnapshot {
  revision: number;
  enabled: boolean;
  providerPluginId: string;
  protocolVersion: string;
  capabilityIds: string[];
  transport: {
    kind: string;
    socketPath?: string;
    maxResponseBytes?: number;
    healthTimeoutMs?: number;
    actionTimeoutMs?: number;
  };
}

export type ComputerProviderRegistrationLookup = (
  providerPluginId: string,
) => ComputerProviderRegistrationSnapshot | undefined;

export function computerProviderRegistrationSnapshot(
  source: ComputerProviderRegistrationSource,
): ComputerProviderRegistrationSnapshot {
  return {
    revision: source.revision,
    enabled: source.enabled,
    providerPluginId: source.providerPluginId,
    protocolVersion: source.protocolVersion,
    capabilityIds: source.capabilities.map((capability) => capability.capabilityId),
    transport: {
      kind: source.transport.kind,
      ...(source.transport.socketPath ? { socketPath: source.transport.socketPath } : {}),
      ...(source.transport.maxResponseBytes !== undefined ? { maxResponseBytes: source.transport.maxResponseBytes } : {}),
      ...(source.transport.healthTimeoutMs !== undefined ? { healthTimeoutMs: source.transport.healthTimeoutMs } : {}),
      ...(source.transport.actionTimeoutMs !== undefined ? { actionTimeoutMs: source.transport.actionTimeoutMs } : {}),
    },
  };
}
