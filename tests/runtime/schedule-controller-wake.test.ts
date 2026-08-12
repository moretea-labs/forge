import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { createWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { getControllerSession } from '../../src/runtime/control-plane/facade/controller-session-store';
import { evaluateSchedule } from '../../src/runtime/workflow/schedules/engine';
import { createSchedule } from '../../src/runtime/workflow/schedules/store';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'forge-schedule-wake-'));
  roots.push(root);
  const controllerHome = join(root, 'controller');
  const repoRoot = join(root, 'repo');
  ensureControllerHome(controllerHome);
  mkdirSync(repoRoot, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'wake@example.test'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Wake Test'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'README.md'), 'wake\n');
  execFileSync('git', ['add', '.'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'schedule-wake' });
  const workId = 'WORK-SCHEDULE-WAKE';
  createWorkContract({ controllerHome, repoId: repository.repoId }, {
    workId,
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    mode: 'goal_workloop',
    objective: 'Continue a bounded goal from a scheduled external Controller wake.',
    acceptanceCriteria: ['external controller was launched'],
    allowedPaths: ['**/*'],
    forbiddenPaths: [],
    checks: [],
    constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
    status: 'running',
  });
  return { controllerHome, repository, workId };
}

describe('Schedule external Controller wake', () => {
  test('wakes one bounded Work through Thin Launcher and skips duplicate active ownership', async () => {
    const fx = fixture();
    const schedule = createSchedule(fx.controllerHome, {
      requestId: 'schedule-wake-request',
      repoId: fx.repository.repoId,
      name: 'continue bounded work',
      enabled: true,
      trigger: { type: 'manual' },
      policy: { maxActiveOccurrences: 1, maxFailures: 3, cooldownMinutes: 0, dailyBudgetMinutes: 60, shadowMode: false },
      action: {
        operation: 'external_controller_wake',
        target: 'runtime',
        arguments: {
          work_id: fx.workId,
          controller_type: 'codex',
          executable: '/usr/bin/true',
        },
      },
      stopConditions: [],
    });

    const first = await evaluateSchedule(fx.controllerHome, schedule, true, { source: 'manual' });
    expect(first?.status).toBe('succeeded');
    expect(first?.decision).toBe('execute');
    const owner = getControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, fx.workId);
    expect(owner?.controllerType).toBe('codex');

    const duplicate = await evaluateSchedule(fx.controllerHome, schedule, true, { source: 'manual', eventId: 'second' });
    expect(duplicate?.decision).toBe('nothing_to_do');
    expect(duplicate?.reason).toContain('already has an active Controller');
  });
});
