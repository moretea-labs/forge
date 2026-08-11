import { createHash } from 'crypto';
import { realpathSync } from 'fs';
import { FORGE_PRODUCT_ID, FORGE_VERSION } from '../../version';
export { FORGE_VERSION } from '../../version';

/** Product identity exposed by every Forge runtime surface. */
export const FORGE_TOOL_SURFACE = FORGE_PRODUCT_ID;
/** Payload schema for MCP health/config records; this is not a product/component version. */
export const FORGE_MCP_SCHEMA_VERSION = 10;

type ToolSurfaceDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

function canonicalToolSurfaceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalToolSurfaceValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalToolSurfaceValue(entry)]));
  }
  return value;
}

/**
 * Fingerprint the schema that MCP actually exposes, not the Runtime release.
 * A code-only release must therefore preserve existing sessions, while a tool
 * name, description, input schema, or annotation change fences them.
 */
export function forgeToolSurfaceFingerprint(toolSurface: readonly string[] | readonly ToolSurfaceDefinition[] = []): string {
  const definitions = toolSurface.map((tool) => typeof tool === 'string'
    ? { name: tool.trim() }
    : {
      name: tool.name.trim(),
      ...(tool.description === undefined ? {} : { description: tool.description }),
      ...(tool.inputSchema === undefined ? {} : { inputSchema: canonicalToolSurfaceValue(tool.inputSchema) }),
      ...(tool.annotations === undefined ? {} : { annotations: canonicalToolSurfaceValue(tool.annotations) }),
    })
    .filter((tool) => Boolean(tool.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  return createHash('sha256')
    .update(JSON.stringify({
      product: FORGE_PRODUCT_ID,
      schemaVersion: FORGE_MCP_SCHEMA_VERSION,
      tools: definitions,
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
