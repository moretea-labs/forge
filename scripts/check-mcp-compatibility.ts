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

const policy = runtimePolicy(process.cwd(), {
  profile: 'controller',
  enableDevRunner: true,
  devRunnerAgents: 'codex,claude',
});

const sourceGroups = {
  runtime: runtimeToolDefinitions.map((tool) => tool.name),
  execution: executionToolDefinitions.map((tool) => tool.name),
  process: processToolDefinitions.map((tool) => tool.name),
  access: accessToolDefinitions.map((tool) => tool.name),
  repository: repositoryToolDefinitions.map((tool) => tool.name),
  legacyCompatibility: buildMcpToolDefinitions(policy).map((tool) => tool.name),
};
const fullNames = [...new Set(Object.values(sourceGroups).flat())];
const defaultNames: string[] = [...DEFAULT_CONTROLLER_TOOL_NAMES];
const coreNames: string[] = [...CORE_CONTROLLER_TOOL_NAMES];
const advancedNames: string[] = [...ADVANCED_CONTROLLER_TOOL_NAMES];
const catalogNames: string[] = [...STABLE_CONTROLLER_TOOL_NAMES];
const preferredNames: string[] = [...PREFERRED_FACADE_TOOL_NAMES];
const defaultFingerprint = forgeToolSurfaceFingerprint(defaultNames);
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
