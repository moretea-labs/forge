import { createHash } from 'crypto';
import { realpathSync } from 'fs';
import { FORGE_PRODUCT_ID, FORGE_VERSION } from '../../version';
export { FORGE_VERSION } from '../../version';

/** Product identity exposed by every Forge runtime surface. */
export const FORGE_TOOL_SURFACE = FORGE_PRODUCT_ID;
/** Payload schema for MCP health/config records; this is not a product/component version. */
export const FORGE_MCP_SCHEMA_VERSION = 10;

export function forgeToolSurfaceFingerprint(toolNames: string[] = []): string {
  const normalizedNames = [...new Set(toolNames.map((name) => name.trim()).filter(Boolean))].sort();
  return createHash('sha256')
    .update(JSON.stringify({
      product: FORGE_PRODUCT_ID,
      version: FORGE_VERSION,
      schemaVersion: FORGE_MCP_SCHEMA_VERSION,
      toolNames: normalizedNames,
    }))
    .digest('hex')
    .slice(0, 16);
}

export const MIN_AGENT_TIMEOUT_MS = 5_000;
export const DEFAULT_AGENT_TIMEOUT_MS = 60 * 60 * 1000;
export const MAX_AGENT_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_LOCAL_AGENT_RUNNERS = ['codex', 'claude'] as const;

export function defaultLocalAgentRunners(): Array<(typeof DEFAULT_LOCAL_AGENT_RUNNERS)[number]> {
  return [...DEFAULT_LOCAL_AGENT_RUNNERS];
}

export function normalizeAgentTimeoutMs(
  value: unknown,
  options: { defaultMs?: number; maxMs?: number; label?: string } = {},
): number {
  const defaultMs = options.defaultMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const maxMs = options.maxMs ?? MAX_AGENT_TIMEOUT_MS;
  const label = options.label ?? 'timeout_ms';
  const parsed = value === undefined || value === null || value === ''
    ? defaultMs
    : typeof value === 'number'
      ? value
      : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number of milliseconds`);
  const integer = Math.trunc(parsed);
  if (integer < MIN_AGENT_TIMEOUT_MS || integer > maxMs) {
    throw new Error(`${label} must be between ${MIN_AGENT_TIMEOUT_MS} and ${maxMs} milliseconds (received ${integer})`);
  }
  return integer;
}

export function formatDurationMs(value: number): string {
  if (value % 3_600_000 === 0) return `${value / 3_600_000}h`;
  if (value % 60_000 === 0) return `${value / 60_000}m`;
  if (value % 1_000 === 0) return `${value / 1_000}s`;
  return `${value}ms`;
}

export function repositoryIdentity(repoRoot: string): string {
  return createHash('sha256').update(realpathSync(repoRoot)).digest('hex').slice(0, 16);
}
