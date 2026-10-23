import { readFileSync } from 'fs';
import { FORGE_TOOL_SURFACE, FORGE_VERSION, forgeToolSurfaceFingerprint } from '../src/cli/controller/runtime-config';
import { injectCognitionSettlementFields } from '../adapters/mcp/runtime-gateway/cognition-settlement';
import { injectDurableCommandFields } from '../adapters/mcp/runtime-gateway/router';
import { runtimePolicy } from '../adapters/mcp/multi-repository';
import { buildMcpToolDefinitions } from '../adapters/mcp/tool-mapping/tools';
import { controllerExposureSnapshot } from '../adapters/mcp/toolset';
import type { MultiRepositoryMcpToolContext } from '../adapters/mcp/multi-repository';
import { accessToolDefinitions } from '../adapters/mcp/tool-mapping/access-tools';
import { repositoryToolDefinitions } from '../adapters/mcp/tool-mapping/repository-tools';
import { runtimeToolDefinitions } from '../adapters/mcp/runtime-gateway/runtime-tools';
import { executionToolDefinitions } from '../adapters/mcp/runtime-gateway/execution-tools';
import { processToolDefinitions } from '../adapters/mcp/runtime-gateway/process-tools';
import { PREFERRED_CONTROLLER_TOOL_NAMES, PREFERRED_FACADE_TOOL_NAMES } from '../adapters/mcp/toolset';

// The preferred model-routing list remains small; actual tools/list always
// exposes the complete authoritative registry, without exposure modes.
const MAX_PREFERRED_TOOL_COUNT = 24;
// 2026-10-21: retiring the eleven redundant ios_* MCP aliases intentionally
// changes the complete registry; preferred tool names/schema remain unchanged.
// 2026-10-21: two error-only retired Agent/Local Job submission aliases were
// deleted from the public MCP registry; keep all other schema/name guards.
// 2026-10-21 audit round 3: four legacy compatibility names were retired from
// the public registry because the modern registry already owns the capability
// (repository_git_diff/git_diff_paths for get_git_diff; the GitHub plugin
// manifest via get_plugin and plugin_action_execute action 'configure' for
// github_status, get_github_plugin_status, configure_github_plugin).
// 2026-10-21 audit round 3 (cont.): the project does not integrate Codex or
// other external agent controllers, so the Codex-specific MCP surface was
// retired with it (run_workflow_check, search_repository,
// prepare_codex_goal_from_sprint, write_codex_goal) together with the
// `forge mcp setup codex` CLI, the doctor Codex report, and the
// fixedWorkflowCheck policy flag.
// Explicit ABI retirement: legacy prepare_transfer_artifacts invoked the already-retired
// task-ledger writer and had no usable output. Preferred ChatGPT Tool ABI is unchanged.
const EXPECTED_EXPOSED_NAME_FINGERPRINT = '82b27cd7cf273e27';

// #197 decomposition authority: the public/frozen Tool Contract is an explicit
// baseline, independent from whichever internal adapter currently defines a
// tool. Adapter extraction may move implementation ownership without silently
// changing names, descriptions, input schemas, or annotations.
const EXPECTED_PREFERRED_CONTROLLER_TOOL_NAMES = [
  'rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work', 'capability_execute',
  'repository_list', 'repository_get', 'repository_register', 'execute_command',
  'read_repository_file', 'repository_safe_patch_apply', 'run_check', 'plugin_action_execute',
  'process_get', 'process_wait', 'process_logs', 'process_cancel', 'result_read', 'result_search',
] as const;
// The stable bounded surface now includes the generic typed capability executor
// already shipped on main. V3 Work objective relations intentionally extend only
// the existing rh_work input schema; both changes must invalidate stale Connector
// schema snapshots without adding a parallel execution or graph authority.
const EXPECTED_PREFERRED_TOOL_NAME_FINGERPRINT = 'f22e635a213b45fa';
// Every public object-schema tool carries shared transport metadata only through
// the final tools/list materialization path. Tool schema revisions
// intentionally invalidate stale Connector schema snapshots.
// 2026-10-15: rh_context gained model-authored search_terms in 5a0f8d839.
// 2026-10-20: rh_context now accepts explicit model-authored equivalent recall
// queries; this intentional input-schema revision invalidates stale Connector
// tool snapshots without adding an internal semantic model or provider.
// 2026-10-21: rh_context documents bounded flat semantic navigation locations.
const EXPECTED_PREFERRED_TOOL_SCHEMA_FINGERPRINT = 'f169b76886e344eb';

const policy = runtimePolicy(process.cwd(), {
  profile: 'controller',
  enableDevRunner: true,
  devRunnerAgents: 'claude',
});

const sourceDefinitionGroups = {
  runtime: runtimeToolDefinitions,
  execution: executionToolDefinitions,
  process: processToolDefinitions,
  access: accessToolDefinitions,
  repository: repositoryToolDefinitions,
  legacyCompatibility: buildMcpToolDefinitions(policy),
};
const sourceGroups = Object.fromEntries(
  Object.entries(sourceDefinitionGroups).map(([group, definitions]) => [group, definitions.map((tool) => tool.name)]),
) as Record<keyof typeof sourceDefinitionGroups, string[]>;
const allDefinitions = Object.values(sourceDefinitionGroups).flat();
const definitionByName = new Map(allDefinitions.map((tool) => [tool.name, tool]));
const fullNames = [...new Set(Object.values(sourceGroups).flat())];
const defaultNames: string[] = [...PREFERRED_CONTROLLER_TOOL_NAMES];
const preferredNames: string[] = [...PREFERRED_FACADE_TOOL_NAMES];
const defaultFingerprint = forgeToolSurfaceFingerprint(defaultNames);
const stableDefinitions = defaultNames
  .map((name) => definitionByName.get(name)).filter((tool) => tool !== undefined)
  .map((tool) => injectCognitionSettlementFields(injectDurableCommandFields(tool)));
const stableSchemaFingerprint = forgeToolSurfaceFingerprint(stableDefinitions);
const fullFingerprint = forgeToolSurfaceFingerprint(fullNames);
const duplicateDefault = defaultNames.filter((name, index) => defaultNames.indexOf(name) !== index);
const missingDefault = defaultNames.filter((name) => !fullNames.includes(name));
const sourceCollisions = Object.entries(sourceGroups).flatMap(([group, names], groupIndex, entries) =>
  names.filter((name) => entries.slice(0, groupIndex).some(([, earlier]) => earlier.includes(name)))
    .map((name) => `${group}:${name}`));
const recoveryMcpSource = readFileSync(new URL('../src/runtime/standalone-recovery/mcp-server.ts', import.meta.url), 'utf8');
const recoveryStatelessMarkers = [
  'createMcpHandler',
  'toNodeHandler',
  "legacy: 'stateless'",
  "responseMode: 'auto'",
];
const recoverySessionAuthorityMarkers = [
  'McpSessionRegistry',
  'NodeStreamableHTTPServerTransport',
  'Mcp-Session-Reset',
  'sessionIdGenerator',
];

const failures: string[] = [];
for (const marker of recoveryStatelessMarkers) {
  if (!recoveryMcpSource.includes(marker)) {
    failures.push(`Standalone Recovery MCP must remain stateless across protocol eras: missing ${marker}`);
  }
}
for (const marker of recoverySessionAuthorityMarkers) {
  if (recoveryMcpSource.includes(marker)) {
    failures.push(`Standalone Recovery MCP must not own transport-session state: found ${marker}`);
  }
}
if (defaultNames.join('\n') !== EXPECTED_PREFERRED_CONTROLLER_TOOL_NAMES.join('\n')) {
  failures.push(`preferred-name schema contract names changed: ${defaultNames.join(', ')}`);
}
if (defaultFingerprint !== EXPECTED_PREFERRED_TOOL_NAME_FINGERPRINT) {
  failures.push(`stable ChatGPT tool-name fingerprint changed: ${defaultFingerprint} != ${EXPECTED_PREFERRED_TOOL_NAME_FINGERPRINT}`);
}
if (stableDefinitions.length !== defaultNames.length) {
  failures.push(`preferred-name schema contract definitions are incomplete: ${stableDefinitions.length}/${defaultNames.length}`);
} else if (stableSchemaFingerprint !== EXPECTED_PREFERRED_TOOL_SCHEMA_FINGERPRINT) {
  failures.push(`preferred-name schema contract schema fingerprint changed: ${stableSchemaFingerprint} != ${EXPECTED_PREFERRED_TOOL_SCHEMA_FINGERPRINT}`);
}
if (defaultNames.length > MAX_PREFERRED_TOOL_COUNT) {
  failures.push(`preferred controller tool list exceeds its advisory size budget: ${defaultNames.length} > ${MAX_PREFERRED_TOOL_COUNT}`);
}
if (duplicateDefault.length) failures.push(`preferred-name duplicate names: ${[...new Set(duplicateDefault)].join(', ')}`);
if (missingDefault.length) failures.push(`preferred tools missing from registered definitions: ${missingDefault.join(', ')}`);
if (sourceCollisions.length) failures.push(`tool schema authority collisions: ${sourceCollisions.join(', ')}`);
for (const name of ['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work']) {
  if (!preferredNames.includes(name)) failures.push(`preferred facade surface missing: ${name}`);
  if (!defaultNames.includes(name)) failures.push(`preferred list missing facade tool: ${name}`);
}
if (fullNames.length < defaultNames.length) {
  failures.push('complete MCP registry is missing preferred capability names');
}
if (fullFingerprint !== EXPECTED_EXPOSED_NAME_FINGERPRINT) {
  failures.push(`complete MCP tool-name fingerprint changed: ${fullFingerprint} != ${EXPECTED_EXPOSED_NAME_FINGERPRINT}`);
}
const projectedNames = controllerExposureSnapshot({
  policy, toolset: 'full', controllerHome: process.cwd(), repoRoot: process.cwd(),
} as MultiRepositoryMcpToolContext).actualToolNames.sort();
if (projectedNames.join('\n') !== [...fullNames].sort().join('\n')) {
  failures.push('controller_capabilities expectation differs from the complete MCP registry');
}

const rhWorkDefinition = runtimeToolDefinitions.find((tool) => tool.name === 'rh_work');
const rhWorkProperties = (rhWorkDefinition?.inputSchema?.properties ?? {}) as Record<string, unknown>;
for (const field of [
  'checkout_id',
  'workflow_id',
  'workflow_run_id',
  'outcome_observation',
  'experience_draft',
] as const) {
  if (!(field in rhWorkProperties)) failures.push(`stable rh_work Tool Contract missing ${field}`);
}
if (failures.length) {
  console.error('[mcp-compatibility] FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(JSON.stringify({
  status: 'ok',
  toolSurface: FORGE_TOOL_SURFACE,
  version: FORGE_VERSION,
  preferredToolCount: defaultNames.length,
  preferredFingerprint: defaultFingerprint,
  preferredSchemaFingerprint: stableSchemaFingerprint,
  preferredToolBudget: MAX_PREFERRED_TOOL_COUNT,
  exposedToolCount: fullNames.length,
  exposedNameFingerprint: fullFingerprint,
  sourceToolCounts: Object.fromEntries(Object.entries(sourceGroups).map(([name, tools]) => [name, tools.length])),
  sourceCollisions: [...new Set(sourceCollisions)].sort(),
  accessModeChangesSchema: false,
}, null, 2));
