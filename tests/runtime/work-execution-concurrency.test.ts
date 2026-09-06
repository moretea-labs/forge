import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildWorkExecutionConcurrencyContract,
  createWorkContract,
  evaluateWorkExecutionCompatibility,
  getWorkContract,
  readActiveWorkCandidates,
  type WorkContract,
} from '../../packages/kernel/work/api/index';
import {
  evaluateManagedProcessWorkCompatibility,
  recordWorkExecutionConcurrencyWait,
  reconcileWorkExecutionConcurrencyWaits,
} from '../../src/runtime/control-plane/concurrency/work-execution-concurrency';
import { repositoryControllerRoot } from '../../src/cli/repositories/controller-home';
import { routeWorkStart } from '../../src/runtime/control-plane/facade/goal-workloop';
import { readControlPlaneRecord, writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { createProcessRecord } from '../../src/runtime/execution/process-runtime/store';
import type { ManagedProcessRecord, ProcessResourceClaim } from '../../src/runtime/execution/process-runtime/types';
import { acquireExecutionLeases, listActiveLeases, releaseExecutionLeases } from '../../src/runtime/resources/leases/store';

const roots: string[] = [];
function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-work-concurrency-'));
  roots.push(root);
  return root;
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function work(input: {
  controllerHome: string;
  repoId: string;
  workId: string;
  stepId: string;
  workKind?: WorkContract['workKind'];
  isolation?: 'shared' | 'isolated';
}): WorkContract {
  const isolated = input.isolation !== 'shared';
  return createWorkContract({ controllerHome: input.controllerHome, repoId: input.repoId }, {
    workId: input.workId,
    repoId: input.repoId,
    checkoutId: `checkout-${input.workId}`,
    mode: 'goal_workloop',
    objective: `Exercise concurrency semantics for ${input.workId}.`,
    acceptanceCriteria: ['Concurrency semantics are deterministic.'],
    constraints: { requireHandoffOnAmbiguity: true, workspaceMode: isolated ? 'isolated' : 'auto', requireWorktree: isolated },
    worktreePolicy: isolated
      ? { required: true, reason: 'Concurrency test isolated fixture.' }
      : { required: false, reason: 'Concurrency test shared-checkout fixture.' },
    requestedBy: 'chatgpt',
    status: 'running',
    planId: 'PLAN-CONCURRENCY',
    planStepId: input.stepId,
    workKind: input.workKind,
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
  });
}

function activeProcess(input: {
  controllerHome: string;
  repoId: string;
  processId: string;
  workId: string;
  claim: ProcessResourceClaim;
}): void {
  const now = new Date().toISOString();
  createProcessRecord({
    schemaVersion: 1,
    processId: input.processId,
    repoId: input.repoId,
    checkoutId: input.claim.checkoutId,
    workId: input.workId,
    controllerHome: input.controllerHome,
    status: 'running',
    route: 'managed',
    command: { kind: 'argv', executable: 'node', args: ['-e', 'setTimeout(() => {}, 1000)'], cwd: '/tmp' },
    resourceClaims: [input.claim],
    interactiveWaitMs: 0,
    timeoutMs: 30_000,
    maxOutputBytes: 1_024,
    startedAt: now,
    updatedAt: now,
    terminalFenceToken: 1,
  } satisfies ManagedProcessRecord);
}

function intent(resourceKey: string, mode: 'read' | 'write' | 'exclusive' = 'write') {
  return [{ resourceKey, mode }];
}

describe('Work execution concurrency', () => {
  test('blocks distinct mutating Works in the same semantic scope but allows disjoint isolated Works', () => {
    const home = tempHome(), repoId = 'repo-concurrency';
    const left = work({ controllerHome: home, repoId, workId: 'work-left', stepId: 'same-step' });
    const right = work({ controllerHome: home, repoId, workId: 'work-right', stepId: 'same-step' });
    const disjoint = work({ controllerHome: home, repoId, workId: 'work-disjoint', stepId: 'other-step' });
    const leftContract = buildWorkExecutionConcurrencyContract(left, { resourceIntents: intent('path:checkout-left:src/a.ts') });
    const rightContract = buildWorkExecutionConcurrencyContract(right, { resourceIntents: intent('path:checkout-right:src/b.ts') });
    const blocked = evaluateWorkExecutionCompatibility(rightContract, [leftContract]);
    expect(blocked.compatible).toBe(false);
    expect(blocked.blockers[0]).toMatchObject({
      code: 'same_semantic_scope_mutation',
      blockingWorkId: 'work-left',
      wakeTrigger: { kind: 'work_terminal', workId: 'work-left' },
    });
    const disjointDecision = evaluateWorkExecutionCompatibility(
      buildWorkExecutionConcurrencyContract(disjoint, { resourceIntents: intent('path:checkout-disjoint:src/c.ts') }),
      [leftContract],
    );
    expect(disjointDecision).toEqual({ compatible: true, blockers: [] });
  });

  test('prevents shared-versus-isolated mutation-lane cycles while preserving shared checkout serialization', () => {
    const home = tempHome(), repoId = 'repo-shared-isolated';
    const sharedA = work({ controllerHome: home, repoId, workId: 'work-shared-a', stepId: 'shared-a', isolation: 'shared' });
    const sharedB = work({ controllerHome: home, repoId, workId: 'work-shared-b', stepId: 'shared-b', isolation: 'shared' });
    const isolated = work({ controllerHome: home, repoId, workId: 'work-isolated', stepId: 'isolated' });
    const sharedAContract = buildWorkExecutionConcurrencyContract(sharedA, { resourceIntents: intent('workspace:shared-a') });
    const sharedBContract = buildWorkExecutionConcurrencyContract(sharedB, { resourceIntents: intent('workspace:shared-b') });
    const isolatedContract = buildWorkExecutionConcurrencyContract(isolated, { resourceIntents: intent('workspace:isolated') });

    expect(sharedAContract).toMatchObject({ lane: 'integration_write', isolation: 'shared' });
    expect(isolatedContract).toMatchObject({ lane: 'isolated_write', isolation: 'isolated' });
    expect(evaluateWorkExecutionCompatibility(isolatedContract, [sharedAContract])).toEqual({ compatible: true, blockers: [] });
    expect(evaluateWorkExecutionCompatibility(sharedAContract, [isolatedContract])).toEqual({ compatible: true, blockers: [] });
    expect(evaluateWorkExecutionCompatibility(sharedBContract, [sharedAContract]).blockers[0]).toMatchObject({
      code: 'shared_mutation_lane_conflict', blockingWorkId: sharedA.workId,
      wakeTrigger: { kind: 'work_terminal', workId: sharedA.workId },
    });
  });

  test('keeps malformed active rows explicit while allowing disjoint isolated Work admission', () => {
    const home = tempHome(), repoId = 'repo-invalid-admission';
    const malformed = work({ controllerHome: home, repoId, workId: 'work-malformed-admission', stepId: 'legacy-step' });
    const record = readControlPlaneRecord<WorkContract>(home, 'work_contract', repoId, malformed.workId)!;
    writeControlPlaneRecord(home, {
      namespace: 'work_contract', scope: repoId, key: malformed.workId, schemaVersion: 2,
      expectedRevision: record.revision, action: 'test_malformed_goal_work_admission',
      value: {
        ...record.value,
        phase: 'delivery',
        phaseEvidence: {
          ...record.value.phaseEvidence,
          implementation: { ...record.value.phaseEvidence.implementation, state: 'satisfied' },
          verification: { ...record.value.phaseEvidence.verification, state: 'satisfied' },
          review: { ...record.value.phaseEvidence.review, state: 'pending' },
          delivery: { ...record.value.phaseEvidence.delivery, state: 'active' },
        },
      },
    });

    const snapshot = readActiveWorkCandidates({ controllerHome: home, repoId });
    expect(snapshot.contracts.some((candidate) => candidate.workId === malformed.workId)).toBe(false);
    expect(snapshot.invalid).toEqual([expect.objectContaining({
      workId: malformed.workId,
      planId: 'PLAN-CONCURRENCY',
      planStepId: 'legacy-step',
      isolation: 'isolated',
      error: expect.stringContaining('WORK_PHASE_EVIDENCE_PREVIOUS_NOT_SATISFIED: review'),
    })]);

    const started = routeWorkStart({
      workStore: { controllerHome: home, repoId },
      handoffStore: { root: join(home, 'handoff') },
      repoId,
      checkoutId: 'checkout-canonical',
      principalId: 'principal-admission',
      controllerInstanceId: 'controller-admission',
      sourceRevision: 'revision-admission',
      availableChecks: [],
    }, {
      objective: 'Repair an independent adapter capability.',
      acceptanceCriteria: ['Independent isolated Work starts without accepting malformed legacy authority.'],
      allowedPaths: ['adapters/mcp/runtime-gateway/runtime-tools.ts'],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true, workspaceMode: 'isolated', requireWorktree: true },
      workKind: 'repository_change',
      workRelation: 'new_goal',
      modeInput: {
        scopeClear: true,
        mutation: true,
        expectedFiles: 1,
        expectedChangedLines: 20,
        requiresInvestigation: true,
        requiresRecovery: true,
        requiresParallelism: true,
        risk: 'local_repo_write',
      },
    });
    expect(started.status).toBe('ok');
    expect(started.data).toMatchObject({ workContractCreated: true });

    const exactInvalid = routeWorkStart({
      workStore: { controllerHome: home, repoId },
      handoffStore: { root: join(home, 'handoff-exact') },
      repoId,
      checkoutId: 'checkout-canonical',
      principalId: 'principal-admission',
      controllerInstanceId: 'controller-admission',
      sourceRevision: 'revision-admission',
      availableChecks: [],
    }, {
      objective: 'Attempt to reuse malformed authority.',
      acceptanceCriteria: ['Malformed exact authority is rejected.'],
      allowedPaths: [],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true, workspaceMode: 'isolated', requireWorktree: true },
      workKind: 'repository_change',
      relatedWorkId: malformed.workId,
      workRelation: 'parallel',
      modeInput: {
        scopeClear: true,
        mutation: true,
        expectedFiles: 1,
        expectedChangedLines: 20,
        requiresInvestigation: true,
        requiresRecovery: true,
        requiresParallelism: true,
        risk: 'local_repo_write',
      },
    });
    expect(exactInvalid.status).toBe('blocked');
    expect(exactInvalid.summary).toContain('WORK_RELATED_CONTRACT_INVALID');
  });

  test('isolates malformed active sibling Work without weakening semantic-scope fencing', () => {
    const home = tempHome(), repoId = 'repo-invalid-sibling';
    const candidate = work({ controllerHome: home, repoId, workId: 'work-candidate', stepId: 'candidate-step' });
    const malformed = work({ controllerHome: home, repoId, workId: 'work-malformed', stepId: 'other-step' });
    const record = readControlPlaneRecord<WorkContract>(home, 'work_contract', repoId, malformed.workId)!;
    writeControlPlaneRecord(home, {
      namespace: 'work_contract', scope: repoId, key: malformed.workId, schemaVersion: 2,
      expectedRevision: record.revision, action: 'test_malformed_concurrency_sibling',
      value: {
        ...record.value,
        phase: 'delivery',
        phaseEvidence: {
          ...record.value.phaseEvidence,
          implementation: { ...record.value.phaseEvidence.implementation, state: 'satisfied' },
          verification: { ...record.value.phaseEvidence.verification, state: 'satisfied' },
          review: { ...record.value.phaseEvidence.review, state: 'pending' },
          delivery: { ...record.value.phaseEvidence.delivery, state: 'active' },
        },
      },
    });
    expect(() => getWorkContract({ controllerHome: home, repoId }, malformed.workId))
      .toThrow('WORK_PHASE_EVIDENCE_PREVIOUS_NOT_SATISFIED: review');

    const independent = evaluateManagedProcessWorkCompatibility({
      controllerHome: home, repoId, processId: 'process-independent', workId: candidate.workId,
      resourceClaims: [{ resourceKey: 'path:checkout-work-candidate:src/a.ts', mode: 'write', checkoutId: candidate.checkoutId! }],
    });
    expect(independent).toEqual({ compatible: true, hardBlocked: false });

    const sameScopeRecord = readControlPlaneRecord<WorkContract>(home, 'work_contract', repoId, malformed.workId)!;
    writeControlPlaneRecord(home, {
      namespace: 'work_contract', scope: repoId, key: malformed.workId, schemaVersion: 2,
      expectedRevision: sameScopeRecord.revision, action: 'test_malformed_same_scope',
      value: { ...sameScopeRecord.value, planStepId: 'candidate-step' },
    });
    const blocked = evaluateManagedProcessWorkCompatibility({
      controllerHome: home, repoId, processId: 'process-same-scope', workId: candidate.workId,
      resourceClaims: [{ resourceKey: 'path:checkout-work-candidate:src/a.ts', mode: 'write', checkoutId: candidate.checkoutId! }],
    });
    expect(blocked).toMatchObject({
      compatible: false, hardBlocked: true,
      wait: { blockerCode: 'work_contract_invalid', blockingWorkId: malformed.workId, disposition: 'invalid' },
    });
  });

  test('keeps same-Work process overlap outside Work compatibility and keeps reviewer lanes read-only', () => {
    const home = tempHome(), repoId = 'repo-same-work';
    const mutable = work({ controllerHome: home, repoId, workId: 'work-mutable', stepId: 'same-step' });
    const reviewer = work({ controllerHome: home, repoId, workId: 'work-review', stepId: 'same-step', workKind: 'read_only_review' });
    const mutableContract = buildWorkExecutionConcurrencyContract(mutable, { resourceIntents: intent('path:checkout-work-mutable:src/a.ts') });
    expect(evaluateWorkExecutionCompatibility(mutableContract, [mutableContract])).toEqual({ compatible: true, blockers: [] });
    const reviewContract = buildWorkExecutionConcurrencyContract(reviewer, { resourceIntents: [{ resourceKey: 'workspace:review', mode: 'read' }] });
    expect(evaluateWorkExecutionCompatibility(mutableContract, [reviewContract])).toEqual({ compatible: true, blockers: [] });
    const invalidReview = buildWorkExecutionConcurrencyContract(reviewer, {
      lane: 'isolated_write',
      resourceIntents: intent('path:checkout-work-review:src/a.ts'),
    });
    expect(evaluateWorkExecutionCompatibility(invalidReview, []).blockers[0]).toMatchObject({
      code: 'reviewer_mutation_forbidden', disposition: 'invalid',
    });
    const disguisedReviewMutation = buildWorkExecutionConcurrencyContract(reviewer, {
      lane: 'review',
      resourceIntents: intent('path:checkout-work-review:src/a.ts'),
    });
    expect(evaluateWorkExecutionCompatibility(disguisedReviewMutation, []).blockers[0]).toMatchObject({
      code: 'reviewer_mutation_forbidden', disposition: 'invalid',
    });
  });

  test('lets read-only review checks coordinate cache/temp capacity without granting source or authority mutation', () => {
    const home = tempHome(), repoId = 'repo-review-check';
    const reviewer = work({ controllerHome: home, repoId, workId: 'work-review-check', stepId: 'review-step', workKind: 'read_only_review' });
    const claim = (resourceKey: string, mode: ProcessResourceClaim['mode']): ProcessResourceClaim => ({
      resourceKey, mode, repoId, checkoutId: reviewer.checkoutId, workId: reviewer.workId,
    });
    const checkExecution = {
      schemaVersion: 1 as const,
      checkId: 'package:check:type',
      cacheKey: 'review-check-cache',
      revision: 'review-check-revision',
      definitionDigest: 'review-check-definition',
      environmentFingerprint: 'review-check-environment',
      timeoutMs: 10_000,
      reuseScope: 'checkout' as const,
      scopeKey: reviewer.checkoutId!,
    };

    expect(evaluateManagedProcessWorkCompatibility({
      controllerHome: home,
      repoId,
      processId: 'proc-review-check',
      workId: reviewer.workId,
      checkExecution,
      resourceClaims: [
        claim(`workspace:${reviewer.checkoutId}`, 'read'),
        claim(`build-cache:${repoId}`, 'write'),
        claim(`temp:${repoId}:package-check-type`, 'write'),
        claim(`heavy-check:${repoId}`, 'exclusive'),
      ],
    })).toEqual({ compatible: true, hardBlocked: false });

    for (const forbidden of [
      claim(`workspace:${reviewer.checkoutId}`, 'write'),
      claim(`path:${reviewer.checkoutId}:src/a.ts`, 'write'),
      claim(`git-index:${reviewer.checkoutId}`, 'exclusive'),
      claim(`git-refs:${repoId}`, 'exclusive'),
      claim(`integration:${repoId}`, 'exclusive'),
      claim(`release:${repoId}`, 'exclusive'),
      claim(`remote:${repoId}`, 'exclusive'),
      claim(`network:${repoId}`, 'write'),
      claim('host-service:canonical-runtime', 'write'),
    ]) {
      expect(evaluateManagedProcessWorkCompatibility({
        controllerHome: home,
        repoId,
        processId: `proc-review-forbidden-${forbidden.resourceKey}`,
        workId: reviewer.workId,
        checkExecution,
        resourceClaims: [claim(`workspace:${reviewer.checkoutId}`, 'read'), forbidden],
      })).toMatchObject({
        compatible: false,
        hardBlocked: true,
        wait: { blockerCode: 'reviewer_mutation_forbidden', disposition: 'invalid' },
      });
    }
  });

  test('serializes shared integration/external targets while allowing distinct targets', () => {
    const home = tempHome(), repoId = 'repo-targets';
    const first = work({ controllerHome: home, repoId, workId: 'work-first', stepId: 'first' });
    const second = work({ controllerHome: home, repoId, workId: 'work-second', stepId: 'second' });
    const firstIntegration = buildWorkExecutionConcurrencyContract(first, { lane: 'integration_write', resourceIntents: intent(`integration:${repoId}:main`, 'exclusive') });
    const sameIntegration = buildWorkExecutionConcurrencyContract(second, { lane: 'integration_write', resourceIntents: intent(`integration:${repoId}:main`, 'exclusive') });
    expect(evaluateWorkExecutionCompatibility(sameIntegration, [firstIntegration]).blockers[0]?.code).toBe('integration_target_conflict');
    const otherIntegration = buildWorkExecutionConcurrencyContract(second, { lane: 'integration_write', resourceIntents: intent(`integration:${repoId}:release`, 'exclusive') });
    expect(evaluateWorkExecutionCompatibility(otherIntegration, [firstIntegration]).compatible).toBe(true);

    const remoteA = work({ controllerHome: home, repoId, workId: 'work-remote-a', stepId: 'remote-a', workKind: 'remote_effect' });
    const remoteB = work({ controllerHome: home, repoId, workId: 'work-remote-b', stepId: 'remote-b', workKind: 'remote_effect' });
    const targetA = buildWorkExecutionConcurrencyContract(remoteA, { resourceIntents: intent('provider-state:gmail:thread-1', 'exclusive') });
    const sameTarget = buildWorkExecutionConcurrencyContract(remoteB, { resourceIntents: intent('provider-state:gmail:thread-1', 'exclusive') });
    expect(evaluateWorkExecutionCompatibility(sameTarget, [targetA]).blockers[0]?.code).toBe('external_effect_target_conflict');
    const otherTarget = buildWorkExecutionConcurrencyContract(remoteB, { resourceIntents: intent('provider-state:gmail:thread-2', 'exclusive') });
    expect(evaluateWorkExecutionCompatibility(otherTarget, [targetA]).compatible).toBe(true);
    const unknownTarget = buildWorkExecutionConcurrencyContract(remoteB);
    expect(evaluateWorkExecutionCompatibility(unknownTarget, [targetA]).blockers[0]).toMatchObject({ code: 'external_effect_target_unknown', disposition: 'invalid' });
  });

  test('uses persisted Work semantic scope for live Process admission without self-deadlocking the same Work', () => {
    const home = tempHome(), repoId = 'repo-process';
    const first = work({ controllerHome: home, repoId, workId: 'work-process-a', stepId: 'shared-step' });
    const second = work({ controllerHome: home, repoId, workId: 'work-process-b', stepId: 'shared-step' });
    const claimA: ProcessResourceClaim = { resourceKey: `path:${first.checkoutId}:src/a.ts`, mode: 'write', repoId, checkoutId: first.checkoutId, workId: first.workId };
    activeProcess({ controllerHome: home, repoId, processId: 'proc-active-a', workId: first.workId, claim: claimA });
    const claimB: ProcessResourceClaim = { resourceKey: `path:${second.checkoutId}:src/b.ts`, mode: 'write', repoId, checkoutId: second.checkoutId, workId: second.workId };
    const blocked = evaluateManagedProcessWorkCompatibility({ controllerHome: home, repoId, processId: 'proc-candidate-b', workId: second.workId, resourceClaims: [claimB] });
    expect(blocked.compatible).toBe(false);
    expect(blocked.wait).toMatchObject({ blockerCode: 'same_semantic_scope_mutation', blockingWorkId: first.workId, wakeTrigger: { kind: 'work_terminal', workId: first.workId } });
    const sameWork = evaluateManagedProcessWorkCompatibility({ controllerHome: home, repoId, processId: 'proc-candidate-a2', workId: first.workId, resourceClaims: [claimA] });
    // The candidate does not self-deadlock on proc-active-a; Work B is the
    // truthful semantic blocker because it is a distinct active writer in the
    // same Plan step even before it owns a Process.
    expect(sameWork).toMatchObject({ compatible: false, hardBlocked: false, wait: { blockingWorkId: second.workId } });
    expect(sameWork.wait?.blockingWorkId).not.toBe(first.workId);
  });

  test('runtime admission does not make disjoint shared and isolated Works wait on each other', () => {
    const home = tempHome(), repoId = 'repo-runtime-shared-isolated';
    const shared = work({ controllerHome: home, repoId, workId: 'work-runtime-shared', stepId: 'shared-step', isolation: 'shared' });
    const isolated = work({ controllerHome: home, repoId, workId: 'work-runtime-isolated', stepId: 'isolated-step' });
    const sharedClaim: ProcessResourceClaim = {
      resourceKey: `workspace:${shared.checkoutId}`, mode: 'write', repoId, checkoutId: shared.checkoutId, workId: shared.workId,
    };
    const isolatedClaim: ProcessResourceClaim = {
      resourceKey: `workspace:${isolated.checkoutId}`, mode: 'write', repoId, checkoutId: isolated.checkoutId, workId: isolated.workId,
    };

    expect(evaluateManagedProcessWorkCompatibility({
      controllerHome: home, repoId, processId: 'proc-isolated-candidate', workId: isolated.workId, resourceClaims: [isolatedClaim],
    })).toEqual({ compatible: true, hardBlocked: false });
    expect(evaluateManagedProcessWorkCompatibility({
      controllerHome: home, repoId, processId: 'proc-shared-candidate', workId: shared.workId, resourceClaims: [sharedClaim],
    })).toEqual({ compatible: true, hardBlocked: false });

    const targetClaim: ProcessResourceClaim = {
      resourceKey: `integration:${repoId}:main`, mode: 'exclusive', repoId, checkoutId: isolated.checkoutId, workId: isolated.workId,
    };
    activeProcess({ controllerHome: home, repoId, processId: 'proc-isolated-target-owner', workId: isolated.workId, claim: targetClaim });
    const conflictingSharedClaim: ProcessResourceClaim = {
      resourceKey: targetClaim.resourceKey, mode: 'exclusive', repoId, checkoutId: shared.checkoutId, workId: shared.workId,
    };
    expect(evaluateManagedProcessWorkCompatibility({
      controllerHome: home, repoId, processId: 'proc-shared-target-conflict', workId: shared.workId, resourceClaims: [conflictingSharedClaim],
    })).toMatchObject({
      compatible: false, hardBlocked: false,
      wait: { blockerCode: 'integration_target_conflict', blockingWorkId: isolated.workId, wakeTrigger: { kind: 'resource_release' } },
    });
  });

  test('keeps every active Lease authoritative beyond the former 5000-entry scan boundary', () => {
    const home = tempHome(), repoId = 'repo-lease-authority';
    const root = join(repositoryControllerRoot(home, repoId), 'leases', 'active');
    mkdirSync(root, { recursive: true });
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const resourceKey = `integration:${repoId}:kernel-v2`;
    for (let index = 0; index < 5_001; index += 1) {
      const leaseId = `LEASE-boundary-${String(index).padStart(5, '0')}`;
      writeFileSync(join(root, `${leaseId}.json`), JSON.stringify({
        schemaVersion: 1,
        leaseId,
        repoId,
        resourceKey,
        mode: 'exclusive',
        ownerJobId: `process:blocker-${index}`,
        fencingToken: index + 1,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt,
        visibility: 'ephemeral',
      }));
    }

    expect(listActiveLeases(home, repoId)).toHaveLength(5_001);
    const acquisition = acquireExecutionLeases(home, repoId, 'process:candidate', [
      { resourceKey, mode: 'exclusive', repoId },
    ], {
      ttlMs: 30_000,
      visibility: 'ephemeral',
      notifyScheduler: false,
      invalidateProjection: false,
      emitRuntimeEvent: false,
    });
    expect(acquisition.acquired).toBe(false);
    expect(acquisition.blockers).toHaveLength(5_001);
  });

  test('physically reaps expired resource leases before they can block a new acquisition', () => {
    const home = tempHome(), repoId = 'repo-expired-lease-reap';
    const root = join(repositoryControllerRoot(home, repoId), 'leases', 'active');
    mkdirSync(root, { recursive: true });
    const resourceKey = `workspace:${repoId}`;
    const leasePath = join(root, 'LEASE-expired.json');
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(leasePath, JSON.stringify({
      schemaVersion: 1,
      leaseId: 'LEASE-expired',
      repoId,
      resourceKey,
      mode: 'exclusive',
      ownerJobId: 'process:stale',
      fencingToken: 1,
      acquiredAt: expiredAt,
      heartbeatAt: expiredAt,
      expiresAt: expiredAt,
      visibility: 'ephemeral',
    }));

    expect(listActiveLeases(home, repoId)).toEqual([]);
    expect(existsSync(leasePath)).toBe(false);
    const acquisition = acquireExecutionLeases(home, repoId, 'process:replacement', [
      { resourceKey, mode: 'exclusive', repoId },
    ], {
      ttlMs: 30_000,
      visibility: 'ephemeral',
      notifyScheduler: false,
      invalidateProjection: false,
      emitRuntimeEvent: false,
    });
    expect(acquisition.acquired).toBe(true);
    expect(acquisition.blockers).toEqual([]);
  });

  test('keeps the Lease store authoritative while Scheduler reconciliation clears a resolved Work wait projection', () => {
    const home = tempHome(), repoId = 'repo-wake';
    const blockedWork = work({ controllerHome: home, repoId, workId: 'work-waiting', stepId: 'waiting' });
    const blockingWork = work({ controllerHome: home, repoId, workId: 'work-blocking', stepId: 'blocking' });
    const resourceKey = `integration:${repoId}`;
    const acquisition = acquireExecutionLeases(home, repoId, 'process:blocker', [{ resourceKey, mode: 'exclusive', repoId, checkoutId: blockingWork.checkoutId, workId: blockingWork.workId }], 30_000);
    expect(acquisition.acquired).toBe(true);
    recordWorkExecutionConcurrencyWait({
      controllerHome: home,
      repoId,
      workId: blockedWork.workId,
      attemptId: 'proc-waiting',
      resourceClaims: [{ resourceKey, mode: 'exclusive' }],
      wait: {
        schemaVersion: 1,
        source: 'resource_lease',
        blockerCode: 'resource_claim_conflict',
        disposition: 'wait',
        blockingWorkId: blockingWork.workId,
        semanticScopeKeys: [],
        resourceKeys: [resourceKey],
        wakeTrigger: { kind: 'resource_release', resourceKeys: [resourceKey] },
        observedAt: new Date().toISOString(),
      },
    });
    expect(getWorkContract({ controllerHome: home, repoId }, blockedWork.workId)?.executionConcurrency).toMatchObject({
      status: 'waiting', blockerCode: 'resource_claim_conflict', blockingWorkId: blockingWork.workId,
    });
    expect(reconcileWorkExecutionConcurrencyWaits({ controllerHome: home, repoId })).toMatchObject({ waiting: 1, cleared: 0 });
    releaseExecutionLeases(home, repoId, 'process:blocker');
    expect(reconcileWorkExecutionConcurrencyWaits({ controllerHome: home, repoId })).toMatchObject({ waiting: 1, cleared: 1, workIds: [blockedWork.workId] });
    expect(getWorkContract({ controllerHome: home, repoId }, blockedWork.workId)?.executionConcurrency).toBeUndefined();
  });
});
