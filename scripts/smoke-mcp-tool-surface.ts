#!/usr/bin/env bun
/**
 * Focused smoke: local MCP tool surface + connector freshness semantics.
 * Does not require a live ChatGPT connector session.
 */
import { getMcpPolicy } from '../adapters/mcp/policy';
import {
  PREFERRED_CONTROLLER_TOOL_NAMES,
  PREFERRED_FACADE_TOOL_NAMES,
  exposedControllerToolDefinitions,
} from '../adapters/mcp/toolset';
import {
  EXPECTED_FACADE_TOOLS,
  OPTIONAL_INTERACTIVE_DEVELOPMENT_TOOLS,
  evaluateConnectorFreshness,
} from '../src/cli/local-bridge/connector-freshness';
import type { MultiRepositoryMcpToolContext } from '../adapters/mcp/multi-repository';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`SMOKE_FAIL: ${message}`);
}

const policy = getMcpPolicy('controller');
const fullCtx = {
  policy,
  toolset: 'full' as const,
  controllerHome: process.cwd(),
  repoRoot: process.cwd(),
  enableChatgptBrowser: false,
  audit: () => undefined,
} as unknown as MultiRepositoryMcpToolContext;
const fullExposed = exposedControllerToolDefinitions(fullCtx).map((tool) => tool.name);
const expected = fullExposed;

assert(
  JSON.stringify([...PREFERRED_FACADE_TOOL_NAMES]) === JSON.stringify([...EXPECTED_FACADE_TOOLS]),
  'preferred facade tools must match EXPECTED_FACADE_TOOLS',
);

for (const name of EXPECTED_FACADE_TOOLS) {
  assert(
    (PREFERRED_CONTROLLER_TOOL_NAMES as readonly string[]).includes(name),
    `default exposure missing ${name}`,
  );
  assert(expected.includes(name), `expectedTools missing ${name}`);
}

for (const name of OPTIONAL_INTERACTIVE_DEVELOPMENT_TOOLS) {
  assert(
    (PREFERRED_CONTROLLER_TOOL_NAMES as readonly string[]).includes(name),
    `interactive tool ${name} missing from the preferred capability list`,
  );
  assert(
    (PREFERRED_CONTROLLER_TOOL_NAMES as readonly string[]).includes(name),
    `interactive tool ${name} missing from the preferred routing list`,
  );
}

for (const name of PREFERRED_CONTROLLER_TOOL_NAMES) {
  assert(fullExposed.includes(name), `complete registry missing preferred capability ${name}`);
}
assert(fullExposed.includes('repository_bootstrap_local_project'), 'complete registry missing repository bootstrap');
assert(fullExposed.includes('git_commit_paths'), 'complete registry missing canonical Git operation');
assert(fullExposed.length > PREFERRED_CONTROLLER_TOOL_NAMES.length, 'complete registry must include every registered operation');

const unable = evaluateConnectorFreshness({ localToolNames: expected });
assert(unable.status === 'unable_to_verify_chatgpt_snapshot', `expected unable_to_verify, got ${unable.status}`);
assert(!unable.bannerWarning, 'must not banner-warn when ChatGPT snapshot is unobserved');

const missingSnap = evaluateConnectorFreshness({
  localToolNames: expected,
  connectorToolNames: ['controller_capabilities'],
});
assert(missingSnap.status === 'chatgpt_snapshot_missing_facade', `expected snapshot missing, got ${missingSnap.status}`);
assert(missingSnap.missingConnectorTools.length === EXPECTED_FACADE_TOOLS.length, 'should list all missing rh_*');

const ok = evaluateConnectorFreshness({
  localToolNames: expected,
  connectorToolNames: [...EXPECTED_FACADE_TOOLS],
});
assert(ok.status === 'local_mcp_updated', `expected local_mcp_updated, got ${ok.status}`);
assert(ok.severity === 'ok', 'severity should be ok when snapshot complete');

const localMissing = evaluateConnectorFreshness({
  localToolNames: ['controller_capabilities'],
});
assert(localMissing.status === 'local_mcp_missing_facade', `expected local missing, got ${localMissing.status}`);

console.log(JSON.stringify({
  ok: true,
  expectedFacadeTools: EXPECTED_FACADE_TOOLS,
  preferredTools: PREFERRED_FACADE_TOOL_NAMES,
  exposedToolCount: fullExposed.length,
  preferredToolCount: PREFERRED_CONTROLLER_TOOL_NAMES.length,
  expectedToolsHasFacade: EXPECTED_FACADE_TOOLS.every((name) => expected.includes(name)),
  fullHasInteractive: OPTIONAL_INTERACTIVE_DEVELOPMENT_TOOLS.every((name) => fullExposed.includes(name)),
  states: {
    unable: unable.status,
    missingSnap: missingSnap.status,
    ok: ok.status,
    localMissing: localMissing.status,
  },
}, null, 2));
