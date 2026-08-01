import { describe, expect, test } from 'bun:test';
import {
  ADVANCED_CONTROLLER_TOOL_NAMES,
  CORE_CONTROLLER_TOOL_NAMES,
  DEFAULT_CONTROLLER_TOOL_NAMES,
  PREFERRED_FACADE_TOOL_NAMES,
  STABLE_CONTROLLER_TOOL_NAMES,
  classifyControllerToolExposure,
  controllerExposureSnapshot,
  controllerToolNamesForToolset,
  exposedControllerToolDefinitions,
  isControllerToolExposed,
  normalizeMcpToolset,
} from '../../src/cli/mcp/toolset';
import { parseMcpToolset } from '../../src/cli/mcp/multi-repository';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';

function stubCtx(toolset: 'core' | 'advanced' | 'full'): MultiRepositoryMcpToolContext {
  return {
    repoRoot: process.cwd(),
    controllerHome: process.cwd(),
    policy: getMcpPolicy('controller'),
    toolset,
    enableChatgptBrowser: false,
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext;
}

describe('MCP tool exposure profiles', () => {
  test('stable connector surface stays unique and below the schema budget', () => {
    expect(new Set(STABLE_CONTROLLER_TOOL_NAMES).size).toBe(STABLE_CONTROLLER_TOOL_NAMES.length);
    expect(STABLE_CONTROLLER_TOOL_NAMES.length).toBeLessThanOrEqual(133);
    expect(STABLE_CONTROLLER_TOOL_NAMES).toEqual(expect.arrayContaining([
      'process_get',
      'process_wait',
      'process_logs',
      'process_cancel',
    ]));
    expect(STABLE_CONTROLLER_TOOL_NAMES.length).toBeGreaterThanOrEqual(100);
  });

  test('preferred facade remains compact while profiles are ordered by capability', () => {
    expect([...PREFERRED_FACADE_TOOL_NAMES]).toEqual([
      'rh_access',
      'rh_status',
      'rh_inbox',
      'rh_context',
      'rh_work',
    ]);
    for (const name of PREFERRED_FACADE_TOOL_NAMES) {
      expect(DEFAULT_CONTROLLER_TOOL_NAMES).toContain(name);
      expect(classifyControllerToolExposure(name)).toBe('facade');
    }

    const profiles = (['core', 'advanced', 'full'] as const).map((toolset) =>
      exposedControllerToolDefinitions(stubCtx(toolset)).map((tool) => tool.name),
    );
    // Core is the compact model-facing surface; advanced keeps every stable
    // typed capability; full is the exhaustive compatibility surface.
    expect(profiles[0].length).toBeLessThan(profiles[1].length);
    expect(profiles[1].length).toBeLessThan(profiles[2].length);
    for (const name of profiles[0]) expect(profiles[1]).toContain(name);
    for (const name of profiles[1]) expect(profiles[2]).toContain(name);
    for (const required of [
      'rh_access',
      'repository_access_get',
      'repository_safe_patch_apply',
    ]) expect(profiles[0]).toContain(required);
    for (const required of [
      'repository_command_execute',
      'repository_git_status',
      'create_campaign',
      'dispatch_task',
      'ios_simulator_screenshot',
      'repository_access_set',
    ]) expect(profiles[1]).toContain(required);
  });

  test('exposure snapshot is the single truthful source for expected and actual tools', () => {
    const snapshot = controllerExposureSnapshot(stubCtx('core'));
    expect(snapshot.ready).toBe(true);
    expect(snapshot.schemaStableAcrossAccessModes).toBe(true);
    expect(snapshot.expectedToolNames).toEqual(snapshot.actualToolNames);
    expect(snapshot.missingToolNames).toEqual([]);
    expect(snapshot.unexpectedToolNames).toEqual([]);
    expect(snapshot.duplicateToolNames).toEqual([]);
    expect(snapshot.actualToolNames.slice(0, PREFERRED_FACADE_TOOL_NAMES.length))
      .toEqual([...PREFERRED_FACADE_TOOL_NAMES]);
    expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test('legacy profile labels resolve to the stable advanced surface', () => {
    expect(ADVANCED_CONTROLLER_TOOL_NAMES).toEqual(DEFAULT_CONTROLLER_TOOL_NAMES);
    // Core is deliberately small; advanced and full never hide stable tools.
    expect([...CORE_CONTROLLER_TOOL_NAMES].every((name) => ADVANCED_CONTROLLER_TOOL_NAMES.includes(name))).toBe(true);
    expect(controllerToolNamesForToolset('advanced')).toEqual(ADVANCED_CONTROLLER_TOOL_NAMES);
    expect(controllerToolNamesForToolset('full')).toBeNull();
    for (const toolset of ['core', 'advanced', 'full'] as const) {
      expect(isControllerToolExposed(stubCtx(toolset), 'repository_safe_patch_apply')).toBe(true);
    }
    // Specialist tools are advanced/full only; a core facade must reject them.
    expect(isControllerToolExposed(stubCtx('core'), 'dispatch_task')).toBe(false);
    expect(isControllerToolExposed(stubCtx('advanced'), 'dispatch_task')).toBe(true);
    expect(isControllerToolExposed(stubCtx('core'), 'quick_agent_session')).toBe(false);
    expect(isControllerToolExposed(stubCtx('advanced'), 'quick_agent_session')).toBe(true);
    expect(classifyControllerToolExposure('create_campaign')).toBe('advanced');
  });

  test('parseMcpToolset accepts legacy labels and defaults controller to advanced', () => {
    expect(parseMcpToolset(undefined, 'controller')).toBe('advanced');
    expect(parseMcpToolset('core', 'controller')).toBe('core');
    expect(parseMcpToolset('advanced', 'controller')).toBe('advanced');
    expect(parseMcpToolset('full', 'controller')).toBe('full');
    expect(parseMcpToolset('CORE', 'controller')).toBe('core');
    expect(() => parseMcpToolset('legacy', 'controller')).toThrow(/invalid MCP toolset/);
    expect(parseMcpToolset('core', 'planner')).toBe('full');
    expect(normalizeMcpToolset('advanced')).toBe('advanced');
    expect(normalizeMcpToolset('nope')).toBe('advanced');
  });
});
