import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_CONTROLLER_TOOL_NAMES, STABLE_CONTROLLER_TOOL_NAMES } from '../../src/cli/mcp/toolset-names';
import { classifyGatewayExecutionPath, runsAsInteractiveSyncWrite } from '../../src/runtime/gateway/mcp/router';
import { runtimeToolDefinitions } from '../../adapters/mcp/runtime-gateway/runtime-tool-definitions';

describe('interactive sync routing policy', () => {
  test('router marks interactive write tools as sync-by-default and supports wait', () => {
    const source = readFileSync(join(import.meta.dir, '../../adapters/mcp/runtime-gateway/router.ts'), 'utf8');
    expect(source).toContain('INTERACTIVE_SYNC_WRITE_TOOLS');
    expect(source).toContain('repository_safe_patch_apply');
    expect(source).toContain('begin_edit_session');
    expect(source).toContain('apply_patch');
    expect(source).toContain('wantsAsyncExecution');
    expect(source).toContain('EXECUTION_JOB_RETIRED');
    expect(source).not.toContain('createExecutionJob');
    expect(source).not.toContain('waitForExecutionJob');
    expect(source).not.toContain('buildAcceptedQueuedDigest');
  });

  test('legacy Run terminalization remains synchronous while relocation is blocked', () => {
    expect(runsAsInteractiveSyncWrite('finish_task_run')).toBe(true);
    expect(runsAsInteractiveSyncWrite('cancel_task_run')).toBe(true);
    expect(runsAsInteractiveSyncWrite('finish_task_run', { apply_mode: 'async' })).toBe(false);
    expect(runsAsInteractiveSyncWrite('dispatch_task')).toBe(false);
  });

  test('protected console unlock is exposed but stays on the direct non-durable boundary', () => {
    const definition = runtimeToolDefinitions.find((tool) => tool.name === 'computer_console_unlock');
    expect(definition).toBeDefined();
    expect(classifyGatewayExecutionPath('computer_console_unlock', {
      credential: 'fixture-only',
      confirm_authorization: true,
    }, { definition })).toMatchObject({ path: 'direct', reasons: ['bounded_direct_control_write'] });
  });

  test('stable connector surface stays identical to the bounded default surface', () => {
    expect(STABLE_CONTROLLER_TOOL_NAMES).toEqual(DEFAULT_CONTROLLER_TOOL_NAMES);
    expect(STABLE_CONTROLLER_TOOL_NAMES).toContain('repository_safe_patch_apply');
    expect(STABLE_CONTROLLER_TOOL_NAMES).toContain('computer_console_unlock');
    expect(STABLE_CONTROLLER_TOOL_NAMES).not.toContain('repository_git_create_branch');
    expect(STABLE_CONTROLLER_TOOL_NAMES).not.toContain('work_wait');
    expect(STABLE_CONTROLLER_TOOL_NAMES).not.toContain('git_commit_paths');
  });
});
