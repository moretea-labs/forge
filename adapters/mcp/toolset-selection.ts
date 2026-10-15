import type { McpLocalConfig } from './auth';
import type { McpToolset } from './types';

export interface ControllerToolsetSelection {
  toolset: McpToolset;
  locked: boolean;
  migratedLegacyAdvanced: boolean;
}

export function normalizeConfiguredMcpToolset(value: unknown): McpToolset | undefined {
  // An old 'full' config selects the same canonical bounded ABI, not a second catalog.
  if (value === 'full') return 'advanced';
  return value === 'facade' || value === 'core' || value === 'advanced' ? value : undefined;
}

/** Persisted Core and Advanced are compatibility-equivalent stable profiles. */
export function configuredControllerToolset(config: McpLocalConfig | null | undefined): McpToolset | undefined {
  return normalizeConfiguredMcpToolset(config?.toolset);
}

export function resolveControllerToolsetSelection(
  config: McpLocalConfig | null | undefined,
  override?: unknown,
): ControllerToolsetSelection {
  const explicitOverride = normalizeConfiguredMcpToolset(override);
  const configured = configuredControllerToolset(config);
  return {
    toolset: explicitOverride ?? configured ?? 'advanced',
    locked: explicitOverride !== undefined || configured !== undefined,
    migratedLegacyAdvanced: false,
  };
}

export function migrateControllerToolsetConfig(config: McpLocalConfig | null | undefined): {
  toolset: McpToolset;
  toolsetExplicit: boolean;
} {
  const configured = configuredControllerToolset(config);
  return {
    toolset: configured ?? 'advanced',
    toolsetExplicit: configured !== undefined,
  };
}
