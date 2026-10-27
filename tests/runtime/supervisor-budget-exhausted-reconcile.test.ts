import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { WorkflowSupervisorStore, WORKFLOW_SUPERVISOR_MAX_DISPATCH_GENERATIONS } from '../../supervisor/store';
import { WorkflowSupervisorControlPlane } from '../../supervisor/control-plane';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

test('dispatch budget exhausted with outcome_unknown continues reconcile observation', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-budget-exhausted-reconcile-'));
  roots.push(root);
  const clock = { nowMs: Date.now() };
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'), { now: () => clock.nowMs });
  const control = new WorkflowSupervisorControlPlane(store);
  
  const taskId = 'budget-exhausted-task';
  const conversationId = '12345678-abcd-1234-abcd-123456789012';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  
  control.registerTask({
    taskId,
    conversationId,
    conversationUrl,
    objective: 'Test budget exhausted but outcome_unknown still reconciles.',
    completionContract: {},
    continuationPolicy: {},
    userBlockerPolicy: {},
  });
  
  const effect = control.reserveEnrollment(taskId);
  
  // Use confirmedProviderNonApplication proof (doesn't create refund, but authorizes retry)
  const nonRefundingProof = (gen: number, dispatchId: string) => ({
    provider_receipt: 'confirmed_not_applied_after_dispatch' as const,
    send_clicked: true,
    effect_id: effect.effectId,
    dispatch_generation: gen,
    dispatch_id: dispatchId,
    target_id: 'test-target',
    surface: 'test-surface',
    reason: 'composer_disappeared_after_click',
  });
  
  // Dispatch 3 generations with non-refunding proofs
  for (let gen = 1; gen <= 3; gen++) {
    if (gen > 1) clock.nowMs += 600_000;
    
    const dispatchId = `dispatch-${gen}`;
    expect(store.recordEffectDispatchStarted(effect.effectId, gen, dispatchId, { surface: 'test-surface', target_id: 'test-target' })).toBe(true);
    // This returns false but still records effect_not_applied
    store.recordEffectNotAppliedProof(effect.effectId, `proof-${gen}`, nonRefundingProof(gen, dispatchId));
  }
  
  // Record unknown outcome for generation 3
  store.recordEffectObservation(effect.effectId, 'unknown-3', 'unknown', {
    dispatch_generation: 3,
    reason: 'observation_timeout',
    surface: 'test-surface',
  });
  
  // Budget is now exhausted: 3 generations, 0 refunds
  const budget = store.effectDispatchBudget(effect.effectId);
  expect(budget.generations).toBe(WORKFLOW_SUPERVISOR_MAX_DISPATCH_GENERATIONS);
  expect(budget.exhausted).toBe(true);
  
  // Critical test: budget exhausted but should still return reconcile mode
  // Not undefined, because reconcile is read-only and can accept late provider evidence
  clock.nowMs += 10_000; // Advance past observation spacing
  const next = store.nextBrowserEffect(taskId, { nowMs: clock.nowMs });
  expect(next).toBeDefined();
  expect(next?.mode).toBe('reconcile');
  expect(next?.generation).toBe(3);
  
  // Even more time passes, reconcile should still be available
  clock.nowMs += 120_000;
  const laterNext = store.nextBrowserEffect(taskId, { nowMs: clock.nowMs });
  expect(laterNext).toBeDefined();
  expect(laterNext?.mode).toBe('reconcile');
  expect(laterNext?.generation).toBe(3);
  
  // Verify we cannot start generation 4
  expect(store.recordEffectDispatchStarted(effect.effectId, 4, 'should-fail')).toBe(false);
  
  store.close();
});
