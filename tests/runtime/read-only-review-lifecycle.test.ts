import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  continueGoalWorkloop,
  finalizeGoalWorkloop,
  routeWorkStart,
  stopGoalWorkloop,
} from '../../src/runtime/control-plane/facade/goal-workloop';
import { getWorkContract, recordWorkCompletionReceipt } from '../../src/runtime/control-plane/facade/work-contract-store';
import { runGoalWorkloop as runGoalWorkloopWithAccess } from '../../src/runtime/control-plane/facade/goal-workloop-access';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function reviewContext(prefix: string) {
  const root = temp(prefix);
  return {
    workStore: { root: join(root, 'work') },
    handoffStore: { root: join(root, 'handoffs') },
    repoId: `repo-${prefix}`,
    availableChecks: [],
    sourceRevision: '78a75591f9cb553f3e08a103cefc806df55c0cad',
    workspaceFingerprint: 'workspace-clean-r1',
    workspaceChangedPaths: [] as string[],
  };
}

describe('recoverable read-only review lifecycle', () => {
  test('completes an Avela-style clean review without repository implementation evidence', () => {
    const context = reviewContext('read-only-clean');
    const started = routeWorkStart(context, {
      objective: 'READ-ONLY Clean Review R1 for frozen Avela snapshot. Architecture/concurrency review only. No edits.',
      acceptanceCriteria: ['Frozen source remains unchanged', 'Bounded review paths are inspected', 'No correctness finding remains'],
      workKind: 'read_only_review',
      modeInput: {
        scopeClear: true,
        mutation: false,
        requiresInvestigation: true,
        requiresRecovery: true,
        risk: 'readonly',
      },
    });
    const workId = (started.data as { work?: { workId?: string } }).work?.workId;
    expect(workId).toBeTruthy();
    expect(getWorkContract(context.workStore, workId!)?.workKind).toBe('read_only_review');

    const continued = continueGoalWorkloop(context, {
      workId: workId!,
      inspectedPaths: [
        'ios/App/AppState.swift',
        'ios/Domain/Commands/DoseCommandProcessor.swift',
        'ios/Domain/Services/NotificationService.swift',
      ],
      reviewFindings: [],
    });
    expect(continued.status).toBe('ok');
    expect((continued.data as { nextStep?: string }).nextStep).toBe('finalize');
    const reviewed = getWorkContract(context.workStore, workId!)!;
    expect(reviewed.phase).toBe('delivery');
    expect(reviewed.scopeEvidence?.inspectedPaths).toContain('ios/App/AppState.swift');
    expect(reviewed.readOnlyReviewEvidence).toMatchObject({
      sourceRevision: context.sourceRevision,
      findings: [],
    });

    const finalized = finalizeGoalWorkloop(context, { workId: workId! });
    expect(finalized.status).toBe('ok');
    const completed = getWorkContract(context.workStore, workId!)!;
    expect(completed.status).toBe('completed');
    expect(completed.workKind).toBe('read_only_review');
    expect(completed.completionOutcome).toBe('completed_no_change');
    expect(completed.completionReceipt).toMatchObject({
      source: 'read_only_review',
      baseRevision: context.sourceRevision,
      sourceRevision: context.sourceRevision,
      findingCount: 0,
    });
  });

  test('persists findings but refuses clean no-change completion', () => {
    const context = reviewContext('read-only-findings');
    const started = routeWorkStart(context, {
      objective: 'READ-ONLY architecture review with no edits.',
      workKind: 'read_only_review',
      modeInput: { scopeClear: true, mutation: false, requiresInvestigation: true, requiresRecovery: true, risk: 'readonly' },
    });
    const workId = (started.data as { work?: { workId?: string } }).work?.workId!;
    const continued = continueGoalWorkloop(context, {
      workId,
      inspectedPaths: ['ios/App/AppState.swift'],
      reviewFindings: ['HIGH: two-tier cache invalidation can certify stale data under a new revision'],
    });
    expect(continued.status).toBe('blocked');
    expect(continued.summary).toContain('unresolved semantic findings');
    const persisted = getWorkContract(context.workStore, workId)!;
    expect(persisted.workKind).toBe('read_only_review');
    expect(persisted.phase).toBe('verification');
    expect(persisted.readOnlyReviewEvidence?.findings).toEqual([
      'HIGH: two-tier cache invalidation can certify stale data under a new revision',
    ]);
    expect(persisted.evidenceRefs.some((evidence) => evidence.title === 'read-only review finding')).toBe(true);
    expect(persisted.scopeEvidence?.actualChangedPaths).toEqual([]);

    const finalized = finalizeGoalWorkloop(context, { workId });
    expect(finalized.status).toBe('blocked');
    expect(getWorkContract(context.workStore, workId)?.completionReceipt).toBeUndefined();
  });

  test('fails closed when source identity drifts after review evidence was recorded', () => {
    const context = reviewContext('read-only-drift');
    const started = routeWorkStart(context, {
      objective: 'READ-ONLY frozen source review.',
      workKind: 'read_only_review',
      modeInput: { scopeClear: true, mutation: false, requiresInvestigation: true, requiresRecovery: true, risk: 'readonly' },
    });
    const workId = (started.data as { work?: { workId?: string } }).work?.workId!;
    expect(continueGoalWorkloop(context, { workId, inspectedPaths: ['src/a.ts'], reviewFindings: [] }).status).toBe('ok');

    context.sourceRevision = 'revision-r2';
    context.workspaceFingerprint = 'workspace-r2';
    const blocked = finalizeGoalWorkloop(context, { workId });
    expect(blocked.status).toBe('blocked');
    expect(blocked.summary).toContain('source drifted from frozen base');
    expect(getWorkContract(context.workStore, workId)?.status).not.toBe('completed');
  });

  test('preserves read-only semantics when relay recovery replaces a cancelled review on the same frozen source', () => {
    const context = reviewContext('read-only-replacement');
    const original = routeWorkStart(context, {
      objective: 'Persist recoverable READ-ONLY Clean Review round 1. No edits.',
      workKind: 'read_only_review',
      modeInput: { scopeClear: true, mutation: false, requiresInvestigation: true, requiresRecovery: true, risk: 'readonly' },
    });
    const originalId = (original.data as { work?: { workId?: string } }).work?.workId!;
    expect(stopGoalWorkloop(context, { workId: originalId, reason: 'Relay recovery requires a replacement review Work.' }).status).toBe('ok');
    expect(getWorkContract(context.workStore, originalId)?.status).toBe('cancelled');

    const replacement = routeWorkStart(context, {
      objective: 'READ-ONLY Clean Review R1 replacement. No edits.',
      relatedWorkId: originalId,
      workRelation: 'new_goal',
      modeInput: { scopeClear: true, requiresInvestigation: true, requiresRecovery: true },
    });
    const replacementId = (replacement.data as { work?: { workId?: string } }).work?.workId;
    expect(replacementId).toBeTruthy();
    expect(getWorkContract(context.workStore, replacementId!)?.workKind).toBe('read_only_review');
    expect(getWorkContract(context.workStore, replacementId!)?.risk).toBe('readonly');
  });

  test('rejects a synthetic clean receipt when durable review evidence contains findings', () => {
    const context = reviewContext('read-only-synthetic-clean');
    const started = routeWorkStart(context, {
      objective: 'READ-ONLY review whose findings must remain authoritative.',
      workKind: 'read_only_review',
      modeInput: { scopeClear: true, mutation: false, requiresInvestigation: true, requiresRecovery: true, risk: 'readonly' },
    });
    const workId = (started.data as { work?: { workId?: string } }).work?.workId!;
    continueGoalWorkloop(context, {
      workId,
      inspectedPaths: ['ios/App/AppState.swift'],
      reviewFindings: ['HIGH: correctness finding'],
    });

    expect(() => recordWorkCompletionReceipt(
      context.workStore,
      workId,
      {
        schemaVersion: 1,
        receiptId: 'ROR-WORK-synthetic-clean',
        source: 'read_only_review',
        workId,
        baseRevision: context.sourceRevision,
        sourceRevision: context.sourceRevision,
        workspaceFingerprint: context.workspaceFingerprint,
        workspaceChangedPaths: [],
        inspectedPaths: ['ios/App/AppState.swift'],
        findingCount: 0,
        recordedAt: new Date().toISOString(),
      },
      'completed_no_change',
      'read_only_review',
    )).toThrow('WORK_COMPLETION_RECEIPT_READ_ONLY_REVIEW_CLEAN_SCOPE_REQUIRED');
    expect(getWorkContract(context.workStore, workId)?.status).not.toBe('completed');
  });

  test('keeps repository-change implementation gating strict', () => {
    const context = reviewContext('repository-change-strict');
    const started = routeWorkStart(context, {
      objective: 'Apply a repository change.',
      workKind: 'repository_change',
      modeInput: { scopeClear: true, mutation: true, requiresRecovery: true, expectedFiles: 1, expectedChangedLines: 10 },
    });
    const workId = (started.data as { work?: { workId?: string } }).work?.workId!;
    const blocked = continueGoalWorkloop(context, { workId });
    expect(blocked.status).toBe('blocked');
    expect(blocked.summary).toContain('requires implementation before verification');
    expect(getWorkContract(context.workStore, workId)?.workKind).toBe('repository_change');
  });
});


describe('public rh_work read-only review adapter', () => {
  test('preserves explicit snake_case read-only review semantics through start, continue, and finalize', () => {
    const context = reviewContext('read-only-public-adapter');
    const started = runGoalWorkloopWithAccess(context, 'start', {
      objective: 'READ-ONLY public facade review. No edits.',
      work_kind: 'read_only_review',
      scope_clear: true,
      requires_investigation: true,
      requires_recovery: true,
      acceptance_criteria: ['Frozen source remains unchanged', 'Review paths are inspected', 'No findings remain'],
    });
    const workId = (started.data as { work?: { workId?: string } }).work?.workId;
    expect(started.status).toBe('ok');
    expect(workId).toBeTruthy();
    expect(getWorkContract(context.workStore, workId!)?.workKind).toBe('read_only_review');

    const continued = runGoalWorkloopWithAccess(context, 'continue', {
      work_id: workId,
      inspected_paths: ['src/runtime/control-plane/facade/goal-workloop-access.ts'],
      review_findings: [],
    });
    expect(continued.status).toBe('ok');
    expect((continued.data as { nextStep?: string }).nextStep).toBe('finalize');
    expect(getWorkContract(context.workStore, workId!)?.readOnlyReviewEvidence).toMatchObject({
      sourceRevision: context.sourceRevision,
      findings: [],
    });

    const finalized = runGoalWorkloopWithAccess(context, 'finalize', { work_id: workId });
    expect(finalized.status).toBe('ok');
    const completed = getWorkContract(context.workStore, workId!)!;
    expect(completed.status).toBe('completed');
    expect(completed.workKind).toBe('read_only_review');
    expect(completed.completionOutcome).toBe('completed_no_change');
    expect(completed.completionReceipt).toMatchObject({
      source: 'read_only_review',
      baseRevision: context.sourceRevision,
      sourceRevision: context.sourceRevision,
      findingCount: 0,
    });
  });

  test('keeps explicit public read-only review mutation conflicts fenced', () => {
    const context = reviewContext('read-only-public-mutation-fence');
    const started = runGoalWorkloopWithAccess(context, 'start', {
      objective: 'READ-ONLY public facade review with an invalid mutation request.',
      work_kind: 'read_only_review',
      requires_investigation: true,
      requires_recovery: true,
      requires_external_effect: true,
    });
    expect(started.status).toBe('blocked');
    expect(started.summary).toContain('READ_ONLY_REVIEW_MUTATION_CONFLICT');
    expect((started.data as { workContractCreated?: boolean }).workContractCreated).toBe(false);
  });
});
