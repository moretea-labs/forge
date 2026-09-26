import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_CONTROLLER_TOOL_NAMES, STABLE_CONTROLLER_TOOL_NAMES } from '../../src/cli/mcp/toolset-names';
import { classifyGatewayExecutionPath, runsAsInteractiveSyncWrite } from '../../src/runtime/gateway/mcp/router';
import { runtimeToolDefinitions } from '../../adapters/mcp/runtime-gateway/runtime-tool-definitions';

describe('interactive sync routing policy', () => {
  test('router marks interactive write tools as sync-by-default and supports wait', () => {
    const routerSource = readFileSync(join(import.meta.dir, '../../adapters/mcp/runtime-gateway/router.ts'), 'utf8');
    const policySource = readFileSync(join(import.meta.dir, '../../adapters/mcp/runtime-gateway/routing-policy.ts'), 'utf8');
    expect(policySource).toContain('INTERACTIVE_SYNC_WRITE_TOOLS');
    expect(policySource).toContain('repository_safe_patch_apply');
    expect(policySource).toContain('begin_edit_session');
    expect(policySource).toContain('apply_patch');
    expect(policySource).toContain('wantsAsyncExecution');
    expect(routerSource).toContain('EXECUTION_JOB_RETIRED');
    expect(routerSource).not.toContain('createExecutionJob');
    expect(routerSource).not.toContain('waitForExecutionJob');
    expect(routerSource).not.toContain('buildAcceptedQueuedDigest');
  });

  test('legacy Run terminalization remains synchronous while relocation is blocked', () => {
    expect(runsAsInteractiveSyncWrite('finish_task_run')).toBe(true);
    expect(runsAsInteractiveSyncWrite('cancel_task_run')).toBe(true);
    expect(runsAsInteractiveSyncWrite('finish_task_run', { apply_mode: 'async' })).toBe(false);
    expect(runsAsInteractiveSyncWrite('dispatch_task')).toBe(false);
  });

  test('protected console prepare/unlock are exposed but stay on the direct non-durable boundary', () => {
    const prepareDefinition = runtimeToolDefinitions.find((tool) => tool.name === 'computer_console_unlock_prepare');
    const unlockDefinition = runtimeToolDefinitions.find((tool) => tool.name === 'computer_console_unlock');
    expect(prepareDefinition).toBeDefined();
    expect(unlockDefinition).toBeDefined();
    expect(classifyGatewayExecutionPath('computer_console_unlock_prepare', {
      confirm_authorization: true,
    }, { definition: prepareDefinition })).toMatchObject({ path: 'direct', reasons: ['bounded_direct_control_write'] });
    expect(classifyGatewayExecutionPath('computer_console_unlock', {
      credential_handle: '11111111-1111-4111-8111-111111111111',
      confirm_authorization: true,
    }, { definition: unlockDefinition })).toMatchObject({ path: 'direct', reasons: ['bounded_direct_control_write'] });
  });

  test('stable connector surface stays identical to the bounded default surface', () => {
    expect(STABLE_CONTROLLER_TOOL_NAMES).toEqual(DEFAULT_CONTROLLER_TOOL_NAMES);
    expect(STABLE_CONTROLLER_TOOL_NAMES).toHaveLength(20);
    expect(STABLE_CONTROLLER_TOOL_NAMES).toContain('repository_safe_patch_apply');
    expect(STABLE_CONTROLLER_TOOL_NAMES).toContain('plugin_action_execute');
    const stableNames = new Set<string>(STABLE_CONTROLLER_TOOL_NAMES);
    expect(stableNames.has('computer_console_unlock_prepare')).toBe(false);
    expect(stableNames.has('computer_console_unlock')).toBe(false);
    expect(STABLE_CONTROLLER_TOOL_NAMES).not.toContain('repository_git_create_branch');
    expect(STABLE_CONTROLLER_TOOL_NAMES).not.toContain('work_wait');
    expect(STABLE_CONTROLLER_TOOL_NAMES).not.toContain('git_commit_paths');
  });
});
