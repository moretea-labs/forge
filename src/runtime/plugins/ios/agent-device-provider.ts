export type AgentDeviceBackendMode = 'auto' | 'typed' | 'cli';
export type AgentDeviceBackendKind = 'typed' | 'cli';

export interface AgentDeviceProviderIdentity {
  kind: AgentDeviceBackendKind;
  available: boolean;
  version?: string;
  resolvedModule?: string;
  runtimeVersion?: string;
  minimumRuntimeVersion?: string;
  reason?: string;
}

export interface AgentDeviceSessionContext {
  stateDir: string;
  session: string;
  device?: string;
  platform: 'ios';
  requestId: string;
  cwd: string;
  timeoutMs: number;
}

export interface AgentDeviceSnapshotRequest {
  interactiveOnly?: boolean;
  depth?: number;
  scope?: string;
  raw?: boolean;
  forceFull?: boolean;
}

export interface AgentDeviceSnapshotEnvelope {
  success: true;
  data: Record<string, unknown>;
  provider: AgentDeviceBackendKind;
}

export interface AgentDeviceReadProvider {
  readonly identity: AgentDeviceProviderIdentity;
  snapshot(
    context: AgentDeviceSessionContext,
    request: AgentDeviceSnapshotRequest,
  ): Promise<AgentDeviceSnapshotEnvelope>;
}

export function configuredAgentDeviceBackendMode(
  value = process.env.FORGE_AGENT_DEVICE_BACKEND,
): AgentDeviceBackendMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'auto') return 'auto';
  if (normalized === 'typed' || normalized === 'cli') return normalized;
  return 'auto';
}

export function agentDeviceProviderVersionsMatch(
  typedVersion: string | undefined,
  cliVersion: string | undefined,
): boolean {
  const normalize = (value: string | undefined) => value?.trim().replace(/^v/i, '');
  const typed = normalize(typedVersion);
  const cli = normalize(cliVersion);
  return Boolean(typed && cli && typed === cli);
}
