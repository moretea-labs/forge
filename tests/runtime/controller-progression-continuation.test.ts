import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  bindControllerSessionBinding,
  claimControllerSession,
  getControllerRoundRelay,
  prepareControllerRoundOccurrence,
  releaseControllerSession,
} from '../../packages/kernel/controller/api/index';
import { createWorkContract } from '../../packages/kernel/work/api/index';
import { upsertChatgptControllerBinding } from '../../adapters/chatgpt/controller-binding-store';
import { reconcileControllerProgression } from '../../src/runtime/root/controller-progression-composition';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-controller-progression-'));
  roots.push(controllerHome);
  const repoId = 'repo-a';
  const workId = 'WORK-SCHEDULE-REUSES-ROUND';
  const store = { controllerHome, repoId };
  createWorkContract(store, {
    workId,
    repoId,
    objective: 'Continue one scheduled ChatGPT Work.',
    acceptanceCriteria: ['Scheduled continuation reuses the existing ControllerRound.'],
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    constraints: { requireHandoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
    dispatchState: 'running',
    baseRevision: 'abc123',
  } as Parameters<typeof createWorkContract>[1]);
  const owner = claimControllerSession(store, {
    workId,
    controllerId: 'controller-a',
    controllerType: 'chatgpt',
    sessionId: 'session-a',
    principalId: 'controller-a',
    controllerInstanceId: 'runtime-a',
    leaseMs: 60_000,
  });
  const adapter = upsertChatgptControllerBinding(store, {
    workId,
    sessionId: owner.sessionId,
    title: 'controller progression test',
    model: 'gpt-5.6',
    reasoning: 'high',
    tabPolicy: 'auto',
  });
  bindControllerSessionBinding(store, {
    workId,
    sessionId: owner.sessionId,
    binding: adapter.binding,
  });
  releaseControllerSession(store, workId, owner.controllerId);
  return { controllerHome, repoId, workId, store, binding: adapter.binding };
}

describe('Controller progression continuation identity', () => {
  test('a fresh schedule occurrence reuses an orphaned dispatching ControllerRound occurrence', async () => {
    const fx = fixture();
    prepareControllerRoundOccurrence(fx.store, {
      occurrenceId: 'durable-controller-round-occurrence',
      workId: fx.workId,
      controllerBindingId: fx.binding.bindingId,
    });
    expect(getControllerRoundRelay(fx.store, fx.workId)).toMatchObject({
      status: 'dispatching',
      occurrenceId: 'durable-controller-round-occurrence',
    });

    let enrollments = 0;
    const result = await reconcileControllerProgression({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      repoRoot: fx.controllerHome,
    }, {
      occurrenceId: 'fresh-schedule-trigger-occurrence',
      workId: fx.workId,
      scheduleName: 'manual continuation',
    }, {
      ensureSupervisorEnrollment: async () => {
        enrollments += 1;
        return { status: 'enrolled' as const, taskId: 'task-a', effectId: 'effect-a' };
      },
    });

    expect(result.status).toBe('chatgpt_enrolled');
    expect(enrollments).toBe(1);
    expect(getControllerRoundRelay(fx.store, fx.workId)).toMatchObject({
      status: 'dispatching',
      occurrenceId: 'durable-controller-round-occurrence',
    });
  });
});
