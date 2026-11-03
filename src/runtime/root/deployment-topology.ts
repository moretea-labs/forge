export type RuntimeRemoteControllerKind = 'chatgpt' | 'mcp';

export interface RuntimeDeploymentTopology {
  schemaVersion: 1;
  remoteControllers: RuntimeRemoteControllerKind[];
  capabilityIntents: string[];
  persistentRuntimeRequired: boolean;
}

const REMOTE_CONTROLLERS = new Set<RuntimeRemoteControllerKind>(['chatgpt', 'mcp']);

function normalizeCapabilityIntent(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[-a-z0-9_.]{3,128}$/.test(normalized)) throw new Error(`RUNTIME_TOPOLOGY_CAPABILITY_INTENT_INVALID: ${value}`);
  return normalized;
}

function normalizedRemoteControllers(values: readonly string[] | undefined): RuntimeRemoteControllerKind[] {
  return Array.from(new Set(
    (values ?? [])
      .map((value) => value.trim().toLowerCase())
      .filter((value): value is RuntimeRemoteControllerKind => REMOTE_CONTROLLERS.has(value as RuntimeRemoteControllerKind)),
  )).sort();
}

export function deriveRuntimeDeploymentTopology(input: {
  controllers?: readonly string[];
  capabilityIntents?: readonly string[];
}): RuntimeDeploymentTopology {
  const remoteControllers = normalizedRemoteControllers(input.controllers);
  const capabilityIntents = Array.from(new Set(
    (input.capabilityIntents ?? []).map(normalizeCapabilityIntent),
  )).sort();
  return {
    schemaVersion: 1,
    remoteControllers,
    capabilityIntents,
    persistentRuntimeRequired: remoteControllers.length > 0,
  };
}

/**
 * Missing topology means an installation predates this contract. Preserve the
 * existing ChatGPT RemoteController intent without resurrecting retired automation.
 */
export function legacyRuntimeDeploymentTopology(): RuntimeDeploymentTopology {
  return deriveRuntimeDeploymentTopology({ controllers: ['chatgpt'] });
}

export function normalizeRuntimeDeploymentTopology(value: unknown): RuntimeDeploymentTopology {
  if (value === undefined || value === null) return legacyRuntimeDeploymentTopology();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('RUNTIME_TOPOLOGY_INVALID');
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) throw new Error('RUNTIME_TOPOLOGY_VERSION_UNSUPPORTED');
  if (!Array.isArray(record.remoteControllers)
    || record.remoteControllers.some((entry) => typeof entry !== 'string' || !REMOTE_CONTROLLERS.has(entry as RuntimeRemoteControllerKind))) {
    throw new Error('RUNTIME_TOPOLOGY_REMOTE_CONTROLLERS_INVALID');
  }
  if (!Array.isArray(record.capabilityIntents)
    || record.capabilityIntents.some((entry) => typeof entry !== 'string')) {
    throw new Error('RUNTIME_TOPOLOGY_CAPABILITY_INTENTS_INVALID');
  }
  const remoteControllers = normalizedRemoteControllers(record.remoteControllers as string[]);
  const capabilityIntents = Array.from(new Set(
    (record.capabilityIntents as string[]).map(normalizeCapabilityIntent),
  )).sort();
  const canonical = deriveRuntimeDeploymentTopology({ controllers: remoteControllers, capabilityIntents });
  // Historical persisted Supervisor component flags are not execution authority.
  if (record.persistentRuntimeRequired !== canonical.persistentRuntimeRequired) {
    throw new Error('RUNTIME_TOPOLOGY_DERIVATION_MISMATCH');
  }
  return canonical;
}

export function parseRuntimeDeploymentTopologyArgument(value: string | undefined): RuntimeDeploymentTopology {
  if (!value?.trim()) return legacyRuntimeDeploymentTopology();
  try {
    return normalizeRuntimeDeploymentTopology(JSON.parse(value));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`RUNTIME_TOPOLOGY_ARGUMENT_INVALID: ${detail}`);
  }
}
