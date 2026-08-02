import type { McpLocalConfig } from './auth';
import type { McpToolset } from './types';

export interface ControllerToolsetSelection {
  toolset: McpToolset;
  locked: boolean;
  migratedLegacyAdvanced: boolean;
}

export function normalizeConfiguredMcpToolset(value: unknown): McpToolset | undefined {
  return value === 'core' || value === 'advanced' || value === 'full' ? value : undefined;
}

/**
 * Historical setup wrote `advanced` as the implicit default. Treat that
 * unmarked value as legacy so existing installations converge to Core. Old
 * Core/Full values were opt-in and remain authoritative; new persistent
 * Advanced configuration must set toolsetExplicit=true.
 */
export function configuredControllerToolset(config: McpLocalConfig | null | undefined): McpToolset | undefined {
  const toolset = normalizeConfiguredMcpToolset(config?.toolset);
  if (toolset === 'advanced' && config?.toolsetExplicit !== true) return undefined;
  return toolset;
}

export function resolveControllerToolsetSelection(
  config: McpLocalConfig | null | undefined,
  override?: unknown,
): ControllerToolsetSelection {
  const explicitOverride = normalizeConfiguredMcpToolset(override);
  const configured = configuredControllerToolset(config);
  const rawConfigured = normalizeConfiguredMcpToolset(config?.toolset);
  return {
    toolset: explicitOverride ?? configured ?? 'core',
    locked: explicitOverride !== undefined || configured !== undefined,
    migratedLegacyAdvanced: rawConfigured === 'advanced'
      && config?.toolsetExplicit !== true
      && explicitOverride === undefined,
  };
}

export function migrateControllerToolsetConfig(config: McpLocalConfig | null | undefined): {
  toolset: McpToolset;
  toolsetExplicit: boolean;
} {
  const configured = configuredControllerToolset(config);
  return {
    toolset: configured ?? 'core',
    toolsetExplicit: configured !== undefined,
  };
}
