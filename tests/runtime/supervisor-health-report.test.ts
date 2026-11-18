import { describe, expect, test } from 'bun:test';
import { summarizeSupervisorHealthcheckLanes } from '../../src/runtime/workflow/schedules/supervisor-health';

describe('Supervisor health receipt classification', () => {
  test('counts actionable observation and stalled-progress blockers', () => {
    const actions = [
      'deferred_launchd_policy_unavailable',
      'deferred_github_progress_unavailable',
      'progress_review_deferred_github_or_supervisor_unavailable',
      'owned_tab_missing_guarded_recovery_needed',
      'execution_active_issue_review_required',
    ];
    const result = summarizeSupervisorHealthcheckLanes(actions.map(action => ({ action })));
    expect(result).toEqual({
      laneCount: 5, failedTicks: 0, pendingEffects: 0,
      attemptedRecoveries: 0, unhealthy: 5,
    });
  });

  test('does not misclassify healthy, queued, or completed lanes', () => {
    const result = summarizeSupervisorHealthcheckLanes([
      { action: 'none' },
      { action: 'completed_skip' },
      { action: 'safe_progress_review_requested' },
      { action: 'execution_healthy_acceptance_unverified' },
      { action: 'pending_receipt_not_delivery', pending_effect: true },
    ]);
    expect(result).toEqual({
      laneCount: 5, failedTicks: 0, pendingEffects: 1,
      attemptedRecoveries: 0, unhealthy: 0,
    });
  });

  test('preserves explicit failure and recovery attempt counting', () => {
    const result = summarizeSupervisorHealthcheckLanes([
      { action: 'kickstart', kickstart_ok: false, last_exit: 2 },
      { action: 'wake_provider_recovery', pending_effect: true },
      { action: 'restoring_unloaded', restore_ok: false },
      { action: 'progress_stalled_recovery_not_verified' },
    ]);
    expect(result).toEqual({
      laneCount: 4, failedTicks: 1, pendingEffects: 1,
      attemptedRecoveries: 3, unhealthy: 3,
    });
  });
});
