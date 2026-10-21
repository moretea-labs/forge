import type { McpToolDefinition } from '../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from './multi-repository';
import { buildMultiRepositoryToolDefinitions } from './multi-repository';
import { accessToolDefinitions } from './tool-mapping/access-tools';
import {
  resolveControllerAccessState,
  type ControllerAccessState,
} from './access-mode';
import { repositoryToolDefinitions } from './tool-mapping/repository-tools';
import { runtimeToolDefinitions } from './runtime-gateway/runtime-tool-definitions';
import { executionToolDefinitions } from './runtime-gateway/execution-tools';
import { processToolDefinitions } from './runtime-gateway/process-tools';
import { injectDurableCommandFields } from './runtime-gateway/router';
import { injectCognitionSettlementFields } from './runtime-gateway/cognition-settlement';
import { PREFERRED_FACADE_TOOL_NAMES } from './toolset-names';
export { PREFERRED_CONTROLLER_TOOL_NAMES, PREFERRED_FACADE_TOOL_NAMES } from './toolset-names';
import { forgeToolSurfaceFingerprint } from '../../src/cli/controller/runtime-config';

export type ControllerToolProfile = 'full';

export interface ControllerToolInventoryEntry {
  name: string;
  profile: ControllerToolProfile;
  capability: string;
  exposedVia: 'facade' | 'full';
}

/**
 * One authoritative snapshot of the MCP schema actually served to a client.
 * Access mode intentionally does not alter this schema: Request vs Full Access
 * is an execution-policy decision, not a tool-discovery decision.
 */
export interface ControllerExposureSnapshot {
  access: ControllerAccessState;
  toolset: 'full';
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

export function resolveControllerAccessStateForContext(
  ctx: MultiRepositoryMcpToolContext,
): ControllerAccessState {
  return resolveControllerAccessState({
    controllerHome: ctx.controllerHome,
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
  const rawDefinitions = currentDefinitions.concat(
    buildMultiRepositoryToolDefinitions(ctx).filter(
      (legacy) => !currentDefinitions.some((current) => current.name === legacy.name),
    ),
  );
  const unique = uniqueDefinitions(rawDefinitions);
  const expectedToolNames = unique.definitions.map((tool) => tool.name);
  const definitionByName = new Map(unique.definitions.map((definition) => [definition.name, definition]));
  const definitions = expectedToolNames
    .map((name) => definitionByName.get(name))
    .filter((definition): definition is McpToolDefinition => Boolean(definition))
    // Fingerprint the exact definitions that ListTools returns. Shared transport
    // contracts are injected here once rather than re-declared by domain registries.
    .map((definition) => injectCognitionSettlementFields(injectDurableCommandFields(definition)));
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

export function controllerToolInventory(
  toolNames: readonly string[],
): ControllerToolInventoryEntry[] {
  const profile = 'full' as const;
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

export function controllerExposureSnapshot(ctx: MultiRepositoryMcpToolContext): ControllerExposureSnapshot {
  const staticSnapshot = staticControllerExposureSnapshot(ctx);
  return {
    access: resolveControllerAccessStateForContext(ctx),
    toolset: 'full',
    profile: 'full',
    inventory: controllerToolInventory(staticSnapshot.actualToolNames),
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

// Names and public schema are invariant across Request and Full Access.
// Only the diagnostic exposure snapshot needs to read the access-mode config
// and build a category inventory. Ordinary MCP call admission must not.
export function controllerExposedToolNames(ctx: MultiRepositoryMcpToolContext): string[] {
  return staticControllerExposureSnapshot(ctx).actualToolNames;
}

export function exposedControllerToolDefinitions(ctx: MultiRepositoryMcpToolContext): McpToolDefinition[] {
  return staticControllerExposureSnapshot(ctx).definitions;
}

export function isControllerToolExposed(ctx: MultiRepositoryMcpToolContext, name: string): boolean {
  return staticControllerExposureSnapshot(ctx).actualToolNames.includes(name);
}
