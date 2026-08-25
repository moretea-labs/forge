import type { McpToolDefinition } from './tools';
import type { MultiRepositoryMcpToolContext } from './multi-repository';
import { buildMultiRepositoryToolDefinitions } from './multi-repository';
import { accessToolDefinitions } from './access-tools';
import {
  resolveControllerAccessState,
  type ControllerAccessState,
} from './access-mode';
import { repositoryToolDefinitions } from './repository-tools';
import { runtimeToolDefinitions } from '../../runtime/gateway/mcp/runtime-tools';
import { executionToolDefinitions } from '../../runtime/gateway/mcp/execution-tools';
import { processToolDefinitions } from '../../runtime/gateway/mcp/process-tools';
import { injectDurableCommandFields } from '../../runtime/gateway/mcp/router';
import { DEFAULT_CONTROLLER_TOOL_NAMES, PREFERRED_FACADE_TOOL_NAMES, STABLE_CONTROLLER_TOOL_NAMES } from './toolset-names';
export { BOOTSTRAP_CONTROLLER_TOOL_NAMES, CORE_CONTROLLER_TOOL_NAMES, DEFAULT_CONTROLLER_TOOL_NAMES, PREFERRED_FACADE_TOOL_NAMES, STABLE_CONTROLLER_TOOL_NAMES } from './toolset-names';
import type { McpToolset } from './types';
import { forgeToolSurfaceFingerprint } from '../controller/runtime-config';

export type ToolExposureClass = 'facade' | 'advanced' | 'internal' | 'compatibility';
export type ControllerToolProfile = 'facade' | 'core' | 'advanced' | 'full';

export interface ControllerToolInventoryEntry {
  name: string;
  profile: ControllerToolProfile;
  capability: string;
  exposedVia: 'facade' | 'core' | 'advanced' | 'full';
}

/**
 * One authoritative snapshot of the MCP schema actually served to a client.
 * Access mode intentionally does not alter this schema: Request vs Full Access
 * is an execution-policy decision, not a tool-discovery decision.
 */
export interface ControllerExposureSnapshot {
  access: ControllerAccessState;
  toolset: McpToolset;
  profile: ControllerToolProfile;
  definitions: McpToolDefinition[];
  toolNames: string[];
  expectedToolNames: string[];
  actualToolNames: string[];
  missingToolNames: string[];
  unexpectedToolNames: string[];
  duplicateToolNames: string[];
  fingerprint: string;
  inventory: ControllerToolInventoryEntry[];
  schemaStableAcrossAccessModes: true;
  ready: boolean;
}

/**
 * Cached schema/readiness projection for hot paths that do not need access
 * policy or a per-tool inventory. Status uses this rather than rebuilding a
 * complete controller exposure response on every read.
 */
export interface ControllerToolSurfaceStatus {
  expectedToolNames: string[];
  actualToolNames: string[];
  missingToolNames: string[];
  unexpectedToolNames: string[];
  duplicateToolNames: string[];
  fingerprint: string;
  schemaStableAcrossAccessModes: true;
  ready: boolean;
}

/**
 * Core and Advanced expose the same bounded default ChatGPT surface
 * (DEFAULT_CONTROLLER_TOOL_NAMES). Full remains the exhaustive compatibility
 * surface for legacy integrations; internal atomic handlers are never deleted.
 */

/** Historical Advanced name retained for compatibility. */
export const ADVANCED_CONTROLLER_TOOL_NAMES = DEFAULT_CONTROLLER_TOOL_NAMES;

const DEFAULT_CONTROLLER_TOOL_SET = new Set<string>(DEFAULT_CONTROLLER_TOOL_NAMES);

interface StaticControllerExposureSnapshot {
  definitions: McpToolDefinition[];
  toolNames: string[];
  expectedToolNames: string[];
  actualToolNames: string[];
  missingToolNames: string[];
  unexpectedToolNames: string[];
  duplicateToolNames: string[];
  fingerprint: string;
  schemaStableAcrossAccessModes: true;
  ready: boolean;
}

const STATIC_EXPOSURE_CACHE_MAX_ENTRIES = 64;
const staticControllerExposureCache = new Map<string, StaticControllerExposureSnapshot>();

function pruneStaticExposureCache(): void {
  while (staticControllerExposureCache.size > STATIC_EXPOSURE_CACHE_MAX_ENTRIES) {
    const oldest = staticControllerExposureCache.keys().next().value as string | undefined;
    if (!oldest) break;
    staticControllerExposureCache.delete(oldest);
  }
}

export function normalizeMcpToolset(value: unknown): McpToolset {
  if (value === 'full' || value === 'advanced' || value === 'core' || value === 'facade') return value;
  return 'advanced';
}

/**
 * null means expose every registered definition. Profile membership only
 * changes schema discovery; authorization remains an independent policy.
 */
export function controllerToolNamesForToolset(
  toolset: McpToolset,
  _ctx?: MultiRepositoryMcpToolContext,
): readonly string[] | null {
  if (toolset === 'full') return null;
  if (toolset === 'facade') return PREFERRED_FACADE_TOOL_NAMES;
  return DEFAULT_CONTROLLER_TOOL_NAMES;
}

export function resolveControllerAccessStateForContext(
  ctx: MultiRepositoryMcpToolContext,
): ControllerAccessState {
  return resolveControllerAccessState({
    controllerHome: ctx.controllerHome,
    repoRoot: ctx.explicitRepository?.canonicalRoot,
    toolsetOverride: ctx.toolset,
    toolsetLocked: ctx.toolsetLocked ?? false,
  });
}

function uniqueDefinitions(definitions: McpToolDefinition[]): {
  definitions: McpToolDefinition[];
  duplicates: string[];
} {
  const byName = new Map<string, McpToolDefinition>();
  const duplicates = new Set<string>();
  for (const definition of definitions) {
    if (byName.has(definition.name)) {
      duplicates.add(definition.name);
      continue;
    }
    byName.set(definition.name, definition);
  }
  const preferredOrder = new Map<string, number>(
    (PREFERRED_FACADE_TOOL_NAMES as readonly string[]).map((name, index) => [name, index]),
  );
  const orderedDefinitions = [...byName.values()].sort((left, right) => {
    const leftOrder = preferredOrder.get(left.name);
    const rightOrder = preferredOrder.get(right.name);
    if (leftOrder !== undefined || rightOrder !== undefined) {
      if (leftOrder === undefined) return 1;
      if (rightOrder === undefined) return -1;
      return leftOrder - rightOrder;
    }
    return 0;
  });
  return { definitions: orderedDefinitions, duplicates: [...duplicates].sort() };
}

function staticExposureCacheKey(ctx: MultiRepositoryMcpToolContext): string {
  return JSON.stringify({
    controllerHome: ctx.controllerHome,
    repoRoot: ctx.repoRoot,
    explicitRepositoryId: ctx.explicitRepository?.repoId,
    toolset: ctx.toolset,
    profile: ctx.policy.profile,
    enableChatgptBrowser: ctx.enableChatgptBrowser === true,
    devAgentRunner: ctx.policy.execution.agentRunner,
    allowedAgents: [...ctx.policy.execution.allowedAgents].sort(),
    runnerTimeoutMs: ctx.policy.execution.runnerTimeoutMs,
    runnerMaxTimeoutMs: ctx.policy.execution.runnerMaxTimeoutMs,
  });
}

function buildStaticControllerExposureSnapshot(
  ctx: MultiRepositoryMcpToolContext,
): StaticControllerExposureSnapshot {
  const currentDefinitions = runtimeToolDefinitions.concat(
    executionToolDefinitions,
    processToolDefinitions,
    accessToolDefinitions,
    repositoryToolDefinitions,
  );
  const rawDefinitions = ctx.toolset === 'full'
    ? currentDefinitions.concat(
      buildMultiRepositoryToolDefinitions(ctx).filter(
        (legacy) => !currentDefinitions.some((current) => current.name === legacy.name),
      ),
    )
    : currentDefinitions;
  const unique = uniqueDefinitions(rawDefinitions);
  const allowed = controllerToolNamesForToolset(ctx.toolset, ctx);
  const expectedToolNames = allowed === null
    ? unique.definitions.map((tool) => tool.name)
    : [...new Set(allowed)];
  const definitionByName = new Map(unique.definitions.map((definition) => [definition.name, definition]));
  const definitions = expectedToolNames
    .map((name) => definitionByName.get(name))
    .filter((definition): definition is McpToolDefinition => Boolean(definition))
    // Fingerprint the definitions that ListTools actually returns. The server
    // adds durable command fields to every object schema, so calculating the
    // fence from the pre-injection form would miss a change to those fields.
    .map(injectDurableCommandFields);
  const actualToolNames = definitions.map((tool) => tool.name);
  const actualSet = new Set(actualToolNames);
  const expectedSet = new Set(expectedToolNames);
  const missingToolNames = expectedToolNames.filter((name) => !actualSet.has(name));
  const unexpectedToolNames = actualToolNames.filter((name) => !expectedSet.has(name));
  const fingerprint = forgeToolSurfaceFingerprint(definitions);
  return {
    definitions,
    toolNames: actualToolNames,
    expectedToolNames,
    actualToolNames,
    missingToolNames,
    unexpectedToolNames,
    duplicateToolNames: unique.duplicates,
    fingerprint,
    schemaStableAcrossAccessModes: true,
    ready: missingToolNames.length === 0 && unexpectedToolNames.length === 0 && unique.duplicates.length === 0,
  };
}

function staticControllerExposureSnapshot(
  ctx: MultiRepositoryMcpToolContext,
): StaticControllerExposureSnapshot {
  const key = staticExposureCacheKey(ctx);
  const cached = staticControllerExposureCache.get(key);
  if (cached) return cached;
  const built = buildStaticControllerExposureSnapshot(ctx);
  staticControllerExposureCache.set(key, built);
  pruneStaticExposureCache();
  return built;
}

function capabilityForToolName(name: string): string {
  if (name.startsWith('rh_')) return 'facade';
  if (name.startsWith('git_') || name.startsWith('repository_git_')) return 'git';
  if (/(^|_)(issue|task|project|worklog)(_|$)/.test(name)) return 'issue-task';
  if (name.startsWith('repository_') || name.startsWith('search_') || name.startsWith('read_')) return 'repository';
  if (name.startsWith('ios_')) return 'ios';
  if (name.startsWith('web_')) return 'browser';
  if (name.includes('plugin')) return 'plugin';
  if (name.startsWith('result_') || name.includes('artifact') || name.includes('evidence')) return 'evidence';
  if (name.includes('controller_')) return 'controller';
  if (name.startsWith('process_') || name.startsWith('schedule_') || name.startsWith('runtime_') || name.startsWith('maintenance_')) return 'runtime-maintenance';
  if (name.startsWith('work_') || name.startsWith('session_')) return 'workflow';
  return 'compatibility';
}

function profileForToolset(toolset: McpToolset): ControllerToolProfile {
  return toolset === 'full' ? 'full' : toolset === 'facade' ? 'facade' : toolset === 'core' ? 'core' : 'advanced';
}

export function controllerToolInventory(
  toolNames: readonly string[],
  toolset: McpToolset,
): ControllerToolInventoryEntry[] {
  const profile = profileForToolset(toolset);
  return toolNames.map((name) => ({
    name,
    profile,
    capability: capabilityForToolName(name),
    exposedVia: name.startsWith('rh_') ? 'facade' : profile,
  }));
}

export function clearControllerExposureCacheForTest(): void {
  staticControllerExposureCache.clear();
}

export function allControllerToolDefinitions(ctx: MultiRepositoryMcpToolContext): McpToolDefinition[] {
  return uniqueDefinitions(
    runtimeToolDefinitions.concat(executionToolDefinitions, processToolDefinitions, accessToolDefinitions, repositoryToolDefinitions, buildMultiRepositoryToolDefinitions(ctx)),
  ).definitions;
}

export function controllerExposureSnapshot(ctx: MultiRepositoryMcpToolContext): ControllerExposureSnapshot {
  const staticSnapshot = staticControllerExposureSnapshot(ctx);
  return {
    access: resolveControllerAccessStateForContext(ctx),
    toolset: ctx.toolset,
    profile: profileForToolset(ctx.toolset),
    inventory: controllerToolInventory(staticSnapshot.actualToolNames, ctx.toolset),
    ...staticSnapshot,
  };
}

export function controllerToolSurfaceStatus(ctx: MultiRepositoryMcpToolContext): ControllerToolSurfaceStatus {
  const snapshot = staticControllerExposureSnapshot(ctx);
  return {
    expectedToolNames: snapshot.expectedToolNames,
    actualToolNames: snapshot.actualToolNames,
    missingToolNames: snapshot.missingToolNames,
    unexpectedToolNames: snapshot.unexpectedToolNames,
    duplicateToolNames: snapshot.duplicateToolNames,
    fingerprint: snapshot.fingerprint,
    schemaStableAcrossAccessModes: snapshot.schemaStableAcrossAccessModes,
    ready: snapshot.ready,
  };
}

export function controllerExposedToolNames(ctx: MultiRepositoryMcpToolContext): string[] {
  return controllerExposureSnapshot(ctx).actualToolNames;
}

export function classifyControllerToolExposure(toolName: string): ToolExposureClass {
  if ((PREFERRED_FACADE_TOOL_NAMES as readonly string[]).includes(toolName)) return 'facade';
  if (toolName.startsWith('rh_')) return 'facade';
  if (DEFAULT_CONTROLLER_TOOL_SET.has(toolName)) return 'advanced';
  return 'compatibility';
}

export function controllerToolExposureMetadata(toolNames: readonly string[]): {
  preferredTools: string[];
  advancedTools: string[];
  compatibilityTools: string[];
  classification: Record<string, ToolExposureClass>;
} {
  const classification: Record<string, ToolExposureClass> = {};
  for (const name of toolNames) classification[name] = classifyControllerToolExposure(name);
  return {
    preferredTools: toolNames.filter((name) => classification[name] === 'facade'),
    advancedTools: toolNames.filter((name) => classification[name] === 'advanced'),
    compatibilityTools: toolNames.filter((name) => classification[name] === 'compatibility'),
    classification,
  };
}

export function exposedControllerToolDefinitions(ctx: MultiRepositoryMcpToolContext): McpToolDefinition[] {
  return controllerExposureSnapshot(ctx).definitions;
}

export function isControllerToolExposed(ctx: MultiRepositoryMcpToolContext, name: string): boolean {
  return controllerExposureSnapshot(ctx).actualToolNames.includes(name);
}
