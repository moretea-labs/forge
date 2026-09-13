import { readFileSync } from 'fs';
import { FORGE_TOOL_SURFACE, FORGE_VERSION, forgeToolSurfaceFingerprint } from '../src/cli/controller/runtime-config';
import { runtimePolicy } from '../src/cli/mcp/multi-repository';
import { buildMcpToolDefinitions } from '../src/cli/mcp/tools';
import { accessToolDefinitions } from '../src/cli/mcp/access-tools';
import { repositoryToolDefinitions } from '../src/cli/mcp/repository-tools';
import { runtimeToolDefinitions } from '../src/runtime/gateway/mcp/runtime-tools';
import { executionToolDefinitions } from '../src/runtime/gateway/mcp/execution-tools';
import { processToolDefinitions } from '../src/runtime/gateway/mcp/process-tools';
import {
  buildPlanObligationCompatibilityCapability,
  parseControllerRoundCompatibilityCapability,
  parsePlanObligationCompatibilityCapability,
} from '../adapters/mcp/controller-round-compatibility';
import {
  buildFrozenSemanticCompatibilityCapability,
  parseFrozenSemanticCompatibilityCapability,
} from '../adapters/mcp/frozen-client-semantic-compatibility';
import {
  ADVANCED_CONTROLLER_TOOL_NAMES,
  CORE_CONTROLLER_TOOL_NAMES,
  DEFAULT_CONTROLLER_TOOL_NAMES,
  PREFERRED_FACADE_TOOL_NAMES,
  STABLE_CONTROLLER_TOOL_NAMES,
} from '../src/cli/mcp/toolset';

// The served ChatGPT schema is intentionally much smaller than the exhaustive
// compatibility catalog. Keep a tight budget so accidental tool additions are
// caught before they become discovery latency and schema-cache churn.
const MAX_DEFAULT_TOOL_COUNT = 24;

// #197 decomposition authority: the public/frozen Tool Contract is an explicit
// baseline, independent from whichever internal adapter currently defines a
// tool. Adapter extraction may move implementation ownership without silently
// changing names, descriptions, input schemas, or annotations.
const EXPECTED_STABLE_CONTROLLER_TOOL_NAMES = [
  'rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work',
  'repository_list', 'repository_get', 'repository_register', 'repository_command_execute',
  'read_repository_file', 'repository_safe_patch_apply', 'run_check', 'plugin_action_execute',
  'process_get', 'process_wait', 'process_logs', 'process_cancel', 'result_read', 'result_search',
] as const;
const EXPECTED_STABLE_TOOL_NAME_FINGERPRINT = '8e6613493e480a26';
const EXPECTED_STABLE_TOOL_SCHEMA_FINGERPRINT = 'a6c8a8cb0af7f7d8';

const policy = runtimePolicy(process.cwd(), {
  profile: 'controller',
  enableDevRunner: true,
  devRunnerAgents: 'codex,claude',
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
const defaultNames: string[] = [...DEFAULT_CONTROLLER_TOOL_NAMES];
const coreNames: string[] = [...CORE_CONTROLLER_TOOL_NAMES];
const advancedNames: string[] = [...ADVANCED_CONTROLLER_TOOL_NAMES];
const catalogNames: string[] = [...STABLE_CONTROLLER_TOOL_NAMES];
const preferredNames: string[] = [...PREFERRED_FACADE_TOOL_NAMES];
const defaultFingerprint = forgeToolSurfaceFingerprint(defaultNames);
const stableDefinitions = defaultNames.map((name) => definitionByName.get(name)).filter((tool) => tool !== undefined);
const stableSchemaFingerprint = forgeToolSurfaceFingerprint(stableDefinitions);
const catalogFingerprint = forgeToolSurfaceFingerprint(catalogNames);
const fullFingerprint = forgeToolSurfaceFingerprint(fullNames);
const duplicateDefault = defaultNames.filter((name, index) => defaultNames.indexOf(name) !== index);
const missingDefault = defaultNames.filter((name) => !fullNames.includes(name));
const missingCatalog = catalogNames.filter((name) => !fullNames.includes(name));
const sourceCollisions = Object.entries(sourceGroups).flatMap(([group, names], groupIndex, entries) =>
  names.filter((name) => entries.slice(0, groupIndex).some(([, earlier]) => earlier.includes(name)))
    .map((name) => `${group}:${name}`));
const currentToolNames = new Set([
  ...sourceGroups.runtime,
  ...sourceGroups.execution,
  ...sourceGroups.process,
  ...sourceGroups.access,
  ...sourceGroups.repository,
]);
const legacyHandlerSource = readFileSync(new URL('../src/cli/mcp/legacy-tool-service.ts', import.meta.url), 'utf8');
const legacyHandlerNames = [...legacyHandlerSource.matchAll(/case\s+["']([^"']+)["']\s*:/g)].map((match) => match[1]);
const legacyHandlerCollisions = [...new Set(legacyHandlerNames.filter((name) => currentToolNames.has(name)))].sort();

const failures: string[] = [];
if (defaultNames.join('\n') !== EXPECTED_STABLE_CONTROLLER_TOOL_NAMES.join('\n')) {
  failures.push(`stable ChatGPT Tool Contract names changed: ${defaultNames.join(', ')}`);
}
if (defaultFingerprint !== EXPECTED_STABLE_TOOL_NAME_FINGERPRINT) {
  failures.push(`stable ChatGPT tool-name fingerprint changed: ${defaultFingerprint} != ${EXPECTED_STABLE_TOOL_NAME_FINGERPRINT}`);
}
if (stableDefinitions.length !== defaultNames.length) {
  failures.push(`stable ChatGPT Tool Contract definitions are incomplete: ${stableDefinitions.length}/${defaultNames.length}`);
} else if (stableSchemaFingerprint !== EXPECTED_STABLE_TOOL_SCHEMA_FINGERPRINT) {
  failures.push(`stable ChatGPT Tool Contract schema fingerprint changed: ${stableSchemaFingerprint} != ${EXPECTED_STABLE_TOOL_SCHEMA_FINGERPRINT}`);
}
if (defaultNames.length > MAX_DEFAULT_TOOL_COUNT) {
  failures.push(`default ChatGPT tools/list exceeds the schema budget: ${defaultNames.length} > ${MAX_DEFAULT_TOOL_COUNT}`);
}
if (duplicateDefault.length) failures.push(`default duplicate names: ${[...new Set(duplicateDefault)].join(', ')}`);
if (missingDefault.length) failures.push(`default tools missing from registered definitions: ${missingDefault.join(', ')}`);
if (missingCatalog.length) failures.push(`compatibility catalog tools missing from registered definitions: ${missingCatalog.join(', ')}`);
if (sourceCollisions.length) failures.push(`tool schema authority collisions: ${sourceCollisions.join(', ')}`);
if (legacyHandlerCollisions.length) failures.push(`legacy execution authority collisions: ${legacyHandlerCollisions.join(', ')}`);
if (coreNames.join('\n') !== defaultNames.join('\n')) {
  failures.push('core surface must alias the bounded default ChatGPT surface');
}
if (advancedNames.join('\n') !== defaultNames.join('\n')) {
  failures.push('advanced surface must alias the bounded default ChatGPT surface');
}
for (const name of ['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work']) {
  if (!preferredNames.includes(name)) failures.push(`preferred facade surface missing: ${name}`);
  if (!defaultNames.includes(name)) failures.push(`default surface missing facade tool: ${name}`);
}
if (fullNames.length < defaultNames.length) {
  failures.push(`full compatibility surface is smaller than default surface: ${fullNames.length} < ${defaultNames.length}`);
}

const rhWorkDefinition = runtimeToolDefinitions.find((tool) => tool.name === 'rh_work');
const rhWorkProperties = (rhWorkDefinition?.inputSchema?.properties ?? {}) as Record<string, unknown>;
if (!('capability_id' in rhWorkProperties)) failures.push('rh_work compatibility carrier capability_id is missing');
if (!('obligation_dispositions' in rhWorkProperties)) failures.push('rh_work native obligation_dispositions schema is missing');

const planCompatibilityFixture = [
  {
    predecessor_plan_id: 'PLAN-predecessor',
    obligation_id: 'step:p0:acceptance:0',
    disposition: 'change' as const,
    successor_refs: ['step:p0:acceptance:0'],
    rationale: 'successor expands the same obligation',
  },
  {
    predecessor_plan_id: 'PLAN-predecessor',
    obligation_id: 'step:p1',
    disposition: 'keep' as const,
    successor_refs: ['step:p1'],
  },
];
try {
  const capability = buildPlanObligationCompatibilityCapability(planCompatibilityFixture);
  const parsed = parsePlanObligationCompatibilityCapability('plan_create', capability);
  if (JSON.stringify(parsed) !== JSON.stringify(planCompatibilityFixture)) {
    failures.push('frozen Plan obligation compatibility round-trip changed the typed payload');
  }
  if (parsePlanObligationCompatibilityCapability('repair', capability) !== undefined) {
    failures.push('frozen Plan obligation compatibility must be scoped to plan_create');
  }
  try {
    parsePlanObligationCompatibilityCapability('plan_create', 'plan.obligations.v1:not+base64');
    failures.push('frozen Plan obligation compatibility accepted malformed payload');
  } catch {
    // Expected: malformed frozen-client transport input remains fail-closed.
  }
} catch (error) {
  failures.push(`frozen Plan obligation compatibility failed: ${error instanceof Error ? error.message : String(error)}`);
}

try {
  const authorityId = `cra_${'a'.repeat(32)}`;
  const relayScopeId = 'goal:work-frozen-review-compatibility';
  const parsedReview = parseControllerRoundCompatibilityCapability(
    'repair',
    `controller.round:review:approved:${authorityId}:${relayScopeId}`,
  );
  if (JSON.stringify(parsedReview) !== JSON.stringify({ operation: 'review', authorityId, relayScopeId, reviewDecision: 'approved' })) {
    failures.push('frozen ControllerRound review compatibility changed authority, scope, or review decision');
  }
  const parsedVerify = parseControllerRoundCompatibilityCapability(
    'repair',
    `controller.round:verify:${authorityId}:${relayScopeId}`,
  );
  if (JSON.stringify(parsedVerify) !== JSON.stringify({ operation: 'verify', authorityId, relayScopeId })) {
    failures.push('legacy ControllerRound compatibility changed non-review operation semantics');
  }
  for (const invalid of [
    `controller.round:review:${authorityId}:${relayScopeId}`,
    `controller.round:review:maybe:${authorityId}:${relayScopeId}`,
  ]) {
    try {
      parseControllerRoundCompatibilityCapability('repair', invalid);
      failures.push('frozen ControllerRound review compatibility accepted a missing or invalid explicit decision');
    } catch {
      // Expected: frozen review must carry one explicit canonical review decision.
    }
  }
} catch (error) {
  failures.push(`frozen ControllerRound review compatibility failed: ${error instanceof Error ? error.message : String(error)}`);
}

try {
  const semanticFixture = {
    operation: 'requirement_create' as const,
    args: {
      requirement_title: 'Frozen semantic compatibility',
      requirement_outcome: 'Use the canonical Requirement authority through an old rh_work schema.',
      requirement_acceptance_criteria: ['Compatibility remains transport-only.'],
    },
  };
  const capability = buildFrozenSemanticCompatibilityCapability(semanticFixture);
  const parsed = parseFrozenSemanticCompatibilityCapability('repair', capability);
  if (JSON.stringify(parsed) !== JSON.stringify(semanticFixture)) {
    failures.push('frozen semantic compatibility round-trip changed the typed payload');
  }
  const planFixture = {
    operation: 'plan_create' as const,
    args: {
      obligation_dispositions: [{
        predecessor_plan_id: 'PLAN-R1',
        obligation_id: 'obl-example',
        disposition: 'keep' as const,
        successor_refs: ['step:implementation'],
      }],
    },
  };
  const planCapability = buildFrozenSemanticCompatibilityCapability(planFixture);
  const parsedPlan = parseFrozenSemanticCompatibilityCapability('repair', planCapability);
  if (JSON.stringify(parsedPlan) !== JSON.stringify(planFixture)) {
    failures.push('frozen Plan successor semantic compatibility changed obligation dispositions');
  }
  try {
    parseFrozenSemanticCompatibilityCapability('plan_create', capability);
    failures.push('frozen semantic compatibility accepted a non-repair transport operation');
  } catch {
    // Expected: the generic semantic envelope is reachable only through the stable repair transport.
  }
  const unknownOperation = `semantic.v1:${Buffer.from(JSON.stringify({ v: 1, op: 'finalize', a: {} }), 'utf8').toString('base64url')}`;
  try {
    parseFrozenSemanticCompatibilityCapability('repair', unknownOperation);
    failures.push('frozen semantic compatibility accepted an operation outside the explicit allowlist');
  } catch {
    // Expected: compatibility cannot grow into an arbitrary-operation tunnel.
  }
  const unknownField = `semantic.v1:${Buffer.from(JSON.stringify({ v: 1, op: 'requirement_create', a: { requirement_title: 'x', requirement_outcome: 'y', remote_write: true } }), 'utf8').toString('base64url')}`;
  try {
    parseFrozenSemanticCompatibilityCapability('repair', unknownField);
    failures.push('frozen semantic compatibility accepted an unknown operation argument');
  } catch {
    // Expected: each allowlisted operation has an exact transport schema.
  }
} catch (error) {
  failures.push(`frozen semantic compatibility failed: ${error instanceof Error ? error.message : String(error)}`);
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
  stableToolCount: defaultNames.length,
  stableFingerprint: defaultFingerprint,
  stableSchemaFingerprint,
  defaultToolBudget: MAX_DEFAULT_TOOL_COUNT,
  compatibilityCatalogToolCount: catalogNames.length,
  compatibilityCatalogFingerprint: catalogFingerprint,
  fullCompatibilityToolCount: fullNames.length,
  fullCompatibilityFingerprint: fullFingerprint,
  sourceToolCounts: Object.fromEntries(Object.entries(sourceGroups).map(([name, tools]) => [name, tools.length])),
  sourceCollisions: [...new Set(sourceCollisions)].sort(),
  legacyHandlerCollisions,
  accessModeChangesSchema: false,
}, null, 2));
