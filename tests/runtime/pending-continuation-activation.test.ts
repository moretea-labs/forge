import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyPendingContinuationActivations,
  listPendingContinuationActivations,
  queuePendingContinuationActivation,
} from '../../src/runtime/workflow/schedules/pending-activation';
import { createSchedule, getSchedule, saveSchedule } from '../../src/runtime/workflow/schedules/store';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(name: string) {
  const controllerHome = mkdtempSync(join(tmpdir(), `forge-pending-activation-${name}-`));
  roots.push(controllerHome);
  const repoId = `repo_${name}`;
  const schedule = createSchedule(controllerHome, {
    requestId: `request-${name}`,
    repoId,
    name: `Continuation ${name}`,
    enabled: true,
    trigger: { type: 'interval', everyMinutes: 60 },
    policy: {
      maxActiveOccurrences: 1,
      maxFailures: 3,
      cooldownMinutes: 60,
      dailyBudgetMinutes: 120,
      shadowMode: true,
      backoffBaseMinutes: 10,
      backoffMaxMinutes: 240,
    },
    action: {
      operation: 'external_controller_wake',
      target: 'runtime',
      arguments: { work_id: `work-${name}`, controller_type: 'codex' },
    },
    stopConditions: ['work_terminal', 'human_review_required', 'external_blocker'],
  });
  return { controllerHome, repoId, schedule };
}

describe('pending continuation activation', () => {
  test('activates one queued shadow continuation exactly once on Runtime startup', () => {
    const fx = fixture('activate');
    const queued = queuePendingContinuationActivation(fx.controllerHome, fx.repoId, fx.schedule.scheduleId);
    expect(queued.workId).toBe('work-activate');
    expect(queuePendingContinuationActivation(fx.controllerHome, fx.repoId, fx.schedule.scheduleId)).toEqual(queued);
    expect(listPendingContinuationActivations(fx.controllerHome)).toEqual([queued]);

    const applied = applyPendingContinuationActivations(fx.controllerHome);
    expect(applied).toEqual([{ ...queued, status: 'activated' }]);
    expect(getSchedule(fx.controllerHome, fx.repoId, fx.schedule.scheduleId).policy.shadowMode).toBe(false);
    expect(listPendingContinuationActivations(fx.controllerHome)).toEqual([]);
    expect(applyPendingContinuationActivations(fx.controllerHome)).toEqual([]);
  });

  test('keeps a mismatched marker pending and leaves the schedule shadowed', () => {
    const fx = fixture('mismatch');
    const queued = queuePendingContinuationActivation(fx.controllerHome, fx.repoId, fx.schedule.scheduleId);
    const current = getSchedule(fx.controllerHome, fx.repoId, fx.schedule.scheduleId);
    saveSchedule(fx.controllerHome, {
      ...current,
      action: { ...current.action, arguments: { ...current.action.arguments, work_id: 'work-replanned' } },
    });

    const applied = applyPendingContinuationActivations(fx.controllerHome);
    expect(applied).toEqual([{ ...queued, status: 'failed', reason: 'Schedule no longer targets the queued Work continuation.' }]);
    expect(getSchedule(fx.controllerHome, fx.repoId, fx.schedule.scheduleId).policy.shadowMode).toBe(true);
    expect(listPendingContinuationActivations(fx.controllerHome)).toEqual([queued]);
  });

  test('does not reactivate a schedule that was explicitly disabled before restart', () => {
    const fx = fixture('paused');
    const queued = queuePendingContinuationActivation(fx.controllerHome, fx.repoId, fx.schedule.scheduleId);
    saveSchedule(fx.controllerHome, { ...fx.schedule, enabled: false, pausedReason: 'user paused' });

    const applied = applyPendingContinuationActivations(fx.controllerHome);
    expect(applied).toEqual([{ ...queued, status: 'cancelled', reason: 'Schedule was disabled before Runtime activation.' }]);
    const schedule = getSchedule(fx.controllerHome, fx.repoId, fx.schedule.scheduleId);
    expect(schedule.enabled).toBe(false);
    expect(schedule.policy.shadowMode).toBe(true);
    expect(listPendingContinuationActivations(fx.controllerHome)).toEqual([]);
  });
});
