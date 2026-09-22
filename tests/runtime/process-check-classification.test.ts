import { describe, expect, test } from 'bun:test';
import type { ControllerCheck } from '../../src/cli/controller/check-runner';
import { classifyControllerCheckExecution } from '../../src/runtime/execution/process-runtime/check-classification';

function check(overrides: Partial<ControllerCheck> = {}): ControllerCheck {
  return {
    id: 'ordinary',
    description: 'ordinary check',
    command: ['true'],
    cwd: '.',
    timeoutMs: 10_000,
    source: 'repo-config',
    selection: { costClass: 'L1', riskFloor: 'low', phases: ['post_edit'] },
    ...overrides,
  };
}

describe('ControllerCheck execution classification authority', () => {
  test('human wording cannot promote an explicitly ordinary check to Durable', () => {
    expect(classifyControllerCheckExecution(check({
      id: 'release:migration:deploy:simulator-compile',
      description: 'release rollback blue-green migrate simulator compile',
      selection: { costClass: 'L2', riskFloor: 'medium', phases: ['post_edit', 'pre_finalize'] },
    }))).toEqual({
      executionClass: 'ordinary',
      requiresDurableWorkflow: false,
      reason: 'ordinary_process_check',
    });
  });

  test('release phase is explicit durable authority', () => {
    expect(classifyControllerCheckExecution(check({
      id: 'neutral-name',
      description: 'plain words',
      selection: { costClass: 'L4', riskFloor: 'high', phases: ['release'] },
    })).requiresDurableWorkflow).toBe(true);
  });

  test('live Controller Home authority remains durable regardless of phase', () => {
    expect(classifyControllerCheckExecution(check({
      executionAuthority: 'live_controller_home',
    }))).toMatchObject({
      executionClass: 'live_controller_home',
      requiresDurableWorkflow: true,
    });
  });
});
