import { readFileSync } from 'fs';
import { FORGE_TOOL_SURFACE, FORGE_VERSION, forgeToolSurfaceFingerprint } from '../src/runtime/shared/runtime-config';
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
// Complete-registry migrations are explicit and independent of the stable
// preferred contract. 2026-10-23: retire the nine specialized legacy Markdown,
// PRD/Sprint listing, repository-state summary and controller-packet helpers;
// ordinary repository inspection/Direct Edit and Controller Home remain owners.
// Deliberate retirement: prepare_transfer_artifacts called the already-retired
// task-ledger Writer. The 20 preferred Tool contracts remain unchanged.
// #41 adds one explicit, preview-first registered worktree cleanup operation;
// preferred ChatGPT routing and preferred schemas remain unchanged.
// Forge #313 (2026-11-03): intentional removal of the standalone
// supervisor_task public tool.
// Forge #483 (2026-11-07): Work/WorkHandle/ControllerRound retirement removes
// the remaining Work-bound compatibility tools from the complete registry.
// 2026-11-08: Requirement Autopilot adds one explicit optional rh_autopilot facade.
// It is revision-bound and Runtime-owned; it does not restore Work/Supervisor continuation
// or make Requirement a prerequisite for ordinary Forge use.
// 2026-11-08: managed generic API credentials add one metadata-only rh_credential facade.
// It owns only credential-use AuthorizationGrant lifecycle; macOS Keychain/provider stores remain secret authorities.
// Preferred facade names stay stable; any further complete-registry drift fails closed.
// 2026-11-24 #714: repository_safe_patch_plan/apply, repository_git_diff, and
// repository_git_status are no longer top-level MCP tools; repository.direct_edit and
// repository.git diff/status remain canonical capability_execute routes with the same
// protocol-neutral handlers and status-cache semantics. Refresh the complete registry
// fingerprint for that deliberate contraction; do not relax the preferred tool contract.
const EXPECTED_EXPOSED_NAME_FINGERPRINT = '721b3e0b5bdca1ed';

// #197 decomposition authority: the public/frozen Tool Contract is an explicit
// baseline, independent from whichever internal adapter currently defines a
// tool. Adapter extraction may move implementation ownership without silently
// changing names, descriptions, input schemas, or annotations.
const EXPECTED_PREFERRED_CONTROLLER_TOOL_NAMES = [
  'read_repository_file',
  'execute_command',
  'repository_list',
  'repository_get',
  'repository_register',
  'run_check',
  'plugin_action_execute',
  'process_get',
  'process_wait',
  'process_logs',
  'process_cancel',
  'result_read',
  'result_search',
  'rh_access',
  'rh_status',
  'rh_inbox',
  'rh_context',
  'rh_work',
  'capability_execute',
] as const;
// The stable bounded surface now includes the generic typed capability executor
// already shipped on main. V3 Work objective relations intentionally extend only
// the existing rh_work input schema; both changes must invalidate stale Connector
// schema snapshots without adding a parallel execution or graph authority.
const EXPECTED_PREFERRED_TOOL_NAME_FINGERPRINT = '9ebdaeedde7cf065';
// Every public object-schema tool carries shared transport metadata only through
// the final tools/list materialization path. Tool schema revisions
// intentionally invalidate stale Connector schema snapshots.
// 2026-10-15: rh_context gained model-authored search_terms in 5a0f8d839.
// 2026-10-20: rh_context now accepts explicit model-authored equivalent recall
// queries; this intentional input-schema revision invalidates stale Connector
// tool snapshots without adding an internal semantic model or provider.
// 2026-10-21: rh_context documents bounded flat semantic navigation locations.
// 2026-10-27: rh_context describes conversation-context reuse and compact search
// summaries; only descriptive metadata changes, with names and input types intact.
// 2026-10-29: compose the read-only rh_work get_contract operation with
// #483 A02 typed Requirement progress CAS fields. Refresh the exact combined
// schema fingerprint without relaxing the frozen public-contract assertion.
// 2026-11-05: #478 adds model-authored execute_command mutation_paths so the
// model owns semantic mutation scope while Forge enforces mechanical claims.
// 2026-11-07: #483 retires Work-specific outcome_record/experience_record input
// fields and keeps lifecycle-free learning_record/learning_feedback as the
// canonical advisory-memory write path.
// 2026-11-08: Forge Client planning adds optional parent_plan_id to rh_work
// plan_create. This is an authored Plan refinement edge only; it adds no new
// execution, approval, lifecycle, progress, or scheduling authority.
// 2026-11-08: rh_work adds bounded requirement_list discovery so the native
// Planning client reads current Requirement semantics from their canonical owner
// instead of depending on the retired rh_status requirementBoard projection.
// 2026-11-09: #592 adds rh_inbox.scope (list-only all/global) so scoped counts
// come from the inbox owner. Refresh the exact combined schema fingerprint.
// 2026-11-11: #235 documents bounded process_wait attachments (5000ms) and the
// workspace_root direct-execution cap (30000ms); names and input schemas are
// unchanged. Refresh the exact combined schema fingerprint.
// 2026-11-14 integration: #607 describes model-selected retrieval and optional
// semantic context; #650 adds the fixed supervisor_healthcheck schedule type.
// 2026-11-15 #648 extends canonical Project/Requirement membership for tasks
// without Repository placement. 2026-11-16 adds Project-scoped Requirement
// filters, stable sort keys, offset pagination, and case-insensitive Project/Requirement search.
// Schema v20 adds Project-scoped Requirement get/revise protection; v21 exposes
// Project-only creation of repository-backed tasks through canonical placement.
// Schema v22 adds canonical dependency-blocker filtering to the task list.
// Each canonical fingerprint fences stale Connector snapshots.
// 2026-11-16 #648: optional assigned/unassigned task triage filter; existing
// Requirement storage, assignment writer and revision CAS remain unchanged.
// Schema v23 documents Project-scoped Plan identity and the project_id == scope_key rule.
// 2026-11-18 #313 adds task-bound ChatGPT continuation identity and one bounded
// Prompt to the existing Launch Session action.
// 2026-11-24 #714: Direct Edit now routes through the canonical repository.direct_edit
// capability behind capability_execute; the redundant preferred Safe Patch alias is retired.
// Refresh preferred name/schema fingerprints for that deliberate contraction.
// 2026-11-20: revision-bound Autopilot authorization/checkpoint acceptance and
// atomic parent-Requirement CAS for semantic Plan creation add explicit
// expected-revision and approved-checkpoint identity fields. Project Requirement
// hierarchy additionally adds an explicit root-binding flag and parent edge,
// separate from Requirement dependency edges. Refresh the exact fingerprint so
// stale Connector schema snapshots are invalidated.
// 2026-11-22 #483: delete inert historical Work list/get/get_contract enum tokens
// and advertising from the model-facing rh_work schema; Work has no remaining
// read surface. Refresh the exact schema fingerprint.
// 2026-11-22 #483 follow-up: remove advertised work_id fields from rh_context /
// rh_work input schemas (additionalProperties remains false). Refresh fingerprint.
// 2026-11-23: origin/main drifted past the prior preferred schema fence after
// Work-retirement schema cleanup; refresh the exact fingerprint so Connector
// snapshots invalidate without relaxing the frozen public-contract assertion.
// 2026-11-24 #714: repository.git gained the exact bounded diff contract behind
// capability_execute while the preferred tool-name set itself remains unchanged.
const EXPECTED_PREFERRED_TOOL_SCHEMA_FINGERPRINT = '0908f78dda978027';

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
  .map((name) => definitionByName.get(name))
  .filter((tool) => tool !== undefined)
  .map((tool) => injectCognitionSettlementFields(injectDurableCommandFields(tool)));
const stableSchemaFingerprint = forgeToolSurfaceFingerprint(stableDefinitions);
const fullFingerprint = forgeToolSurfaceFingerprint(fullNames);
const duplicateDefault = defaultNames.filter((name, index) => defaultNames.indexOf(name) !== index);
const missingDefault = defaultNames.filter((name) => !fullNames.includes(name));
const sourceCollisions = Object.entries(sourceGroups).flatMap(([group, names], groupIndex, entries) =>
  names
    .filter((name) => entries.slice(0, groupIndex).some(([, earlier]) => earlier.includes(name)))
    .map((name) => `${group}:${name}`),
);
const recoveryMcpSource = readFileSync(
  new URL('../src/runtime/standalone-recovery/mcp-server.ts', import.meta.url),
  'utf8',
);
const recoveryStatelessMarkers = ['createMcpHandler', 'toNodeHandler', "legacy: 'stateless'", "responseMode: 'auto'"];
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
  failures.push(
    `stable ChatGPT tool-name fingerprint changed: ${defaultFingerprint} != ${EXPECTED_PREFERRED_TOOL_NAME_FINGERPRINT}`,
  );
}
if (stableDefinitions.length !== defaultNames.length) {
  failures.push(
    `preferred-name schema contract definitions are incomplete: ${stableDefinitions.length}/${defaultNames.length}`,
  );
} else if (stableSchemaFingerprint !== EXPECTED_PREFERRED_TOOL_SCHEMA_FINGERPRINT) {
  failures.push(
    `preferred-name schema contract schema fingerprint changed: ${stableSchemaFingerprint} != ${EXPECTED_PREFERRED_TOOL_SCHEMA_FINGERPRINT}`,
  );
}
if (defaultNames.length > MAX_PREFERRED_TOOL_COUNT) {
  failures.push(
    `preferred controller tool list exceeds its advisory size budget: ${defaultNames.length} > ${MAX_PREFERRED_TOOL_COUNT}`,
  );
}
if (duplicateDefault.length)
  failures.push(`preferred-name duplicate names: ${[...new Set(duplicateDefault)].join(', ')}`);
if (missingDefault.length)
  failures.push(`preferred tools missing from registered definitions: ${missingDefault.join(', ')}`);
if (sourceCollisions.length) failures.push(`tool schema authority collisions: ${sourceCollisions.join(', ')}`);
for (const name of ['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work']) {
  if (!preferredNames.includes(name)) failures.push(`preferred facade surface missing: ${name}`);
  if (!defaultNames.includes(name)) failures.push(`preferred list missing facade tool: ${name}`);
}
if (fullNames.length < defaultNames.length) {
  failures.push('complete MCP registry is missing preferred capability names');
}
if (fullFingerprint !== EXPECTED_EXPOSED_NAME_FINGERPRINT) {
  failures.push(
    `complete MCP tool-name fingerprint changed: ${fullFingerprint} != ${EXPECTED_EXPOSED_NAME_FINGERPRINT}`,
  );
}
const projectedNames = controllerExposureSnapshot({
  policy,
  toolset: 'full',
  controllerHome: process.cwd(),
  repoRoot: process.cwd(),
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
  'learning_signals',
  'learning_feedback',
] as const) {
  if (!(field in rhWorkProperties)) failures.push(`stable rh_work Tool Contract missing ${field}`);
}
for (const retiredWorkLearningField of [
  'outcome_observation',
  'experience_draft',
  'quality_adjustment_fingerprint',
] as const) {
  if (retiredWorkLearningField in rhWorkProperties) {
    failures.push(
      `stable rh_work Tool Contract must not restore retired Work-specific learning field ${retiredWorkLearningField}`,
    );
  }
}
if (failures.length) {
  console.error('[mcp-compatibility] FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
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
    },
    null,
    2,
  ),
);
