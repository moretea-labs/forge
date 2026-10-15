import { existsSync } from 'fs';
import {
  loadMcpServiceLocalConfig,
  mcpControllerHomeLocalConfigPath,
  mcpLocalConfigPath,
  type McpLocalConfig,
  writeMcpServiceLocalConfig,
} from './auth';
import {
  isAccessMode,
  type AccessMode,
} from '../../src/runtime/control-plane/governance/access-policy';

export type ControllerAccessConfigSource =
  | 'controller_home.access_mode'
  | 'repo_local_fallback.access_mode'
  | 'default';

export interface ControllerAccessState {
  configuredAccessMode: AccessMode;
  effectiveAccessMode: AccessMode;
  /** The complete MCP capability registry is always available. */
  effectiveToolset: 'full';
  source: ControllerAccessConfigSource;
  lastAppliedAt?: string;
  exposureRevision: number;
  configPathSource: 'controller_home' | 'repo_local_fallback' | 'default';
  schemaStableAcrossAccessModes: true;
}

export interface ResolveControllerAccessStateInput {
  controllerHome: string;
  repoRoot?: string;
}

export interface PersistControllerAccessModeResult {
  configPath: string;
  config: McpLocalConfig;
  state: ControllerAccessState;
}

function configLocation(controllerHome: string, repoRoot?: string): 'controller_home' | 'repo_local_fallback' | 'default' {
  if (existsSync(mcpControllerHomeLocalConfigPath(controllerHome))) return 'controller_home';
  if (repoRoot && existsSync(mcpLocalConfigPath(repoRoot))) return 'repo_local_fallback';
  return 'default';
}

/** One-way interpretation of old persisted permissions, not a toolset selector. */
export function configuredControllerAccessMode(config: McpLocalConfig | null | undefined): AccessMode {
  if (isAccessMode(config?.accessMode)) return config.accessMode;
  // Historically, core without an explicit accessMode meant Request, not Full Access.
  // Preserve that permission until the next canonical config write retires toolset.
  return (config as { toolset?: unknown } | null | undefined)?.toolset === 'core'
    ? 'request'
    : 'full_access';
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
  const configuredAccessMode = configuredControllerAccessMode(config);
  const source: ControllerAccessConfigSource = isAccessMode(config?.accessMode)
    ? (location === 'controller_home' ? 'controller_home.access_mode' : 'repo_local_fallback.access_mode')
    : 'default';
  return {
    configuredAccessMode,
    effectiveAccessMode: configuredAccessMode,
    effectiveToolset: 'full',
    source,
    lastAppliedAt,
    exposureRevision,
    configPathSource: location,
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
  const config: McpLocalConfig = {
    ...existing,
    version: Math.max(existing.version ?? 1, 2),
    profile: existing.profile ?? 'controller',
    accessMode: mode,
    accessModeUpdatedAt,
    accessModeRevision,
  };
  // Stored legacy profile values are not part of the one-surface contract.
  delete (config as Record<string, unknown>).toolset;
  delete (config as Record<string, unknown>).toolsetExplicit;
  const configPath = writeMcpServiceLocalConfig(controllerHome, config);
  return {
    configPath,
    config,
    state: resolveControllerAccessState({ controllerHome, repoRoot }),
  };
}
