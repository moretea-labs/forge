import { existsSync } from 'fs';
import {
  loadMcpServiceLocalConfig,
  mcpControllerHomeLocalConfigPath,
  mcpLocalConfigPath,
  type McpLocalConfig,
  writeMcpServiceLocalConfig,
} from './auth';
import type { McpToolset } from './types';
import {
  migrateControllerToolsetConfig,
  normalizeConfiguredMcpToolset,
  resolveControllerToolsetSelection,
} from './toolset-selection';
import {
  isAccessMode,
  type AccessMode,
} from '../../runtime/control-plane/governance/access-policy';

export type ControllerAccessConfigSource =
  | 'controller_home.access_mode'
  | 'repo_local_fallback.access_mode'
  | 'controller_home.legacy_toolset'
  | 'repo_local_fallback.legacy_toolset'
  | 'default';

export interface ControllerAccessState {
  configuredAccessMode: AccessMode;
  effectiveAccessMode: AccessMode;
  /** Selected schema profile; access mode never changes this value. */
  effectiveToolset: McpToolset;
  source: ControllerAccessConfigSource;
  lastAppliedAt?: string;
  exposureRevision: number;
  configPathSource: 'controller_home' | 'repo_local_fallback' | 'default';
  legacyToolset?: McpToolset;
  schemaStableAcrossAccessModes: true;
}

export interface ResolveControllerAccessStateInput {
  controllerHome: string;
  repoRoot?: string;
  toolsetOverride?: McpToolset;
  toolsetLocked?: boolean;
}

export interface PersistControllerAccessModeResult {
  configPath: string;
  config: McpLocalConfig;
  state: ControllerAccessState;
}

export function accessModeForLegacyToolset(toolset: McpToolset): AccessMode {
  return toolset === 'core' ? 'request' : 'full_access';
}

/** Retained for compatibility only; access mode no longer changes schema. */
export function legacyToolsetForAccessMode(_mode: AccessMode): McpToolset {
  return 'core';
}

function configLocation(controllerHome: string, repoRoot?: string): 'controller_home' | 'repo_local_fallback' | 'default' {
  if (existsSync(mcpControllerHomeLocalConfigPath(controllerHome))) return 'controller_home';
  if (repoRoot && existsSync(mcpLocalConfigPath(repoRoot))) return 'repo_local_fallback';
  return 'default';
}

function normalizedRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

export function resolveControllerAccessState(input: ResolveControllerAccessStateInput): ControllerAccessState {
  const location = configLocation(input.controllerHome, input.repoRoot);
  const config = loadMcpServiceLocalConfig(input.controllerHome, input.repoRoot);
  const lastAppliedAt = typeof config?.accessModeUpdatedAt === 'string' && config.accessModeUpdatedAt.trim()
    ? config.accessModeUpdatedAt
    : undefined;
  const exposureRevision = normalizedRevision(config?.accessModeRevision);
  const rawLegacyToolset = normalizeConfiguredMcpToolset(config?.toolset);
  const selectedToolset = resolveControllerToolsetSelection(config, input.toolsetOverride);
  const configuredAccessMode = isAccessMode(config?.accessMode)
    ? config.accessMode
    : rawLegacyToolset
      ? accessModeForLegacyToolset(rawLegacyToolset)
      : 'full_access';
  const source: ControllerAccessConfigSource = isAccessMode(config?.accessMode)
    ? (location === 'controller_home' ? 'controller_home.access_mode' : 'repo_local_fallback.access_mode')
    : rawLegacyToolset
      ? (location === 'controller_home' ? 'controller_home.legacy_toolset' : 'repo_local_fallback.legacy_toolset')
      : 'default';
  return {
    configuredAccessMode,
    effectiveAccessMode: configuredAccessMode,
    effectiveToolset: selectedToolset.toolset,
    source,
    lastAppliedAt,
    exposureRevision,
    configPathSource: location,
    legacyToolset: rawLegacyToolset,
    schemaStableAcrossAccessModes: true,
  };
}

export function persistControllerAccessMode(
  controllerHome: string,
  mode: AccessMode,
  repoRoot?: string,
): PersistControllerAccessModeResult {
  const existing = loadMcpServiceLocalConfig(controllerHome, repoRoot) ?? {};
  const accessModeUpdatedAt = new Date().toISOString();
  const accessModeRevision = normalizedRevision(existing.accessModeRevision) + 1;
  const migratedToolset = migrateControllerToolsetConfig(existing);
  const config: McpLocalConfig = {
    ...existing,
    version: Math.max(existing.version ?? 1, 2),
    profile: existing.profile ?? 'controller',
    accessMode: mode,
    accessModeUpdatedAt,
    accessModeRevision,
    // Access changes preserve an explicit profile and migrate the old implicit
    // Advanced label to Core; they never expand or shrink schema themselves.
    toolset: migratedToolset.toolset,
    toolsetExplicit: migratedToolset.toolsetExplicit,
  };
  const configPath = writeMcpServiceLocalConfig(controllerHome, config);
  return {
    configPath,
    config,
    state: resolveControllerAccessState({ controllerHome, repoRoot }),
  };
}
