import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PREFERRED_CONTROLLER_TOOL_NAMES } from '../../adapters/mcp/toolset-names';
import { runsAsInteractiveSyncWrite } from '../../adapters/mcp/runtime-gateway/router';
import { runtimeToolDefinitions } from '../../adapters/mcp/runtime-gateway/runtime-tool-definitions';

describe('interactive sync routing policy', () => {
  test('router marks interactive write tools as sync-by-default and supports wait', () => {
    const routerSource = readFileSync(join(import.meta.dir, '../../adapters/mcp/runtime-gateway/router.ts'), 'utf8');
    const policySource = readFileSync(
      join(import.meta.dir, '../../adapters/mcp/runtime-gateway/routing-policy.ts'),
      'utf8',
    );
    expect(policySource).toContain('INTERACTIVE_SYNC_WRITE_TOOLS');
    expect(policySource).toContain('repository_safe_patch_apply');
    expect(policySource).toContain('begin_edit_session');
    expect(policySource).toContain('apply_patch');
    expect(policySource).toContain('wantsAsyncExecution');
    expect(routerSource).toContain('EXTERNAL_CONTROLLER_REQUIRED');
    expect(routerSource).not.toContain('EXECUTION_JOB_RETIRED');
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

  test('protected console unlock stays on the computer plugin and is not a public MCP tool', () => {
    const names = [
      'computer_console_unlock_prepare',
      'computer_console_unlock',
      'computer_console_unlock_enroll',
      'computer_console_unlock_status',
      'computer_console_unlock_recover',
      'computer_console_unlock_revoke',
    ];
    for (const name of names) {
      expect(runtimeToolDefinitions.some((tool) => tool.name === name)).toBe(false);
    }
  });

  test('preferred entry points stay stable without hiding the complete MCP surface', () => {
    expect(PREFERRED_CONTROLLER_TOOL_NAMES.length).toBeGreaterThan(0);
    expect(PREFERRED_CONTROLLER_TOOL_NAMES).toContain('repository_safe_patch_apply');
    expect(PREFERRED_CONTROLLER_TOOL_NAMES).toContain('plugin_action_execute');
    const stableNames = new Set<string>(PREFERRED_CONTROLLER_TOOL_NAMES);
    expect(stableNames.has('computer_console_unlock_prepare')).toBe(false);
    expect(stableNames.has('computer_console_unlock')).toBe(false);
    for (const name of [
      'computer_console_unlock_enroll',
      'computer_console_unlock_status',
      'computer_console_unlock_recover',
      'computer_console_unlock_revoke',
    ]) {
      expect(stableNames.has(name)).toBe(false);
    }
    expect(PREFERRED_CONTROLLER_TOOL_NAMES).not.toContain('repository_git_create_branch');
    expect(PREFERRED_CONTROLLER_TOOL_NAMES).not.toContain('work_wait');
    expect(PREFERRED_CONTROLLER_TOOL_NAMES).not.toContain('git_commit_paths');
  });
});
