import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyEngineeringBlockerDisposition,
  buildEngineeringContextReceipt,
  engineeringWorkProfileForRisk,
  evaluateEngineeringAdmission,
} from '../../packages/kernel/work/domain/engineering-profile';
import { getWorkContract } from '../../packages/kernel/work/api/index';
import { continueGoalWorkloop, routeWorkStart } from '../../src/runtime/control-plane/facade/goal-workloop';
import {
  buildDesignDecisionContractReceipt,
  buildEngineeringBlockerDispositionReceipt,
  buildIndependentCritiqueReceipt,
  buildProductDoDReceipt,
} from '../../packages/kernel/work/domain/engineering-design';
import { contextClosureReceiptIdentity } from '../../packages/kernel/work/domain/context-closure-receipt';
import type { ContextClosureReceipt, EngineeringAdmissionEvidence } from '../../packages/kernel/work/domain/engineering-contracts';
import { trustedEngineeringEvidence } from '../helpers/engineering-evidence';

const recordedAt = '2026-09-03T00:00:00.000Z';

const roots: string[] = [];
function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function projectContract(sourceRevision = 'revision-a') {
  return {
    schemaVersion: 1 as const,
    contractPath: '.forge/project-engineering.json',
    projectId: 'project-a',
    contractId: 'engineering-a',
    contractVersion: '1',
    sourceRevision,
    contentDigest: 'a'.repeat(64),
    provenance: { source: 'repository' as const, loadedAt: recordedAt },
  };
}

function readyClosure(sourceRevision = 'revision-a'): ContextClosureReceipt {
  const receipt: ContextClosureReceipt = {
    schemaVersion: 1,
    receiptId: '',
    sourceRevision,
    generatedAt: recordedAt,
    contextPackSchemaVersion: 10,
    repository: { branch: 'kernel-v2/architecture', dirty: false, activeWorkIds: [] },
    projectContractStatus: 'missing',
    guidance: { status: 'none', paths: [] },
    detected: { languages: ['typescript'], platforms: [] },
    skills: { status: 'not_required', requiredKinds: [], resolved: [], unresolvedKinds: [] },
    semanticTools: { required: false, status: 'not_required', providers: [], reasonCodes: [], compilerEvidenceRequired: false },
    sourceEvidence: {
      currentPaths: ['src/example.ts'],
      testPaths: ['tests/example.test.ts'],
      recentChanges: [],
      rawSourceStatus: 'current',
      structuralStatus: 'disabled',
    },
    readiness: { status: 'ready', reasonCodes: [] },
    provenance: { source: 'rh_context', contextGeneratedAt: recordedAt },
  };
  receipt.receiptId = contextClosureReceiptIdentity(receipt);
  return receipt;
}

function decisions() {
  return {
    ownership: 'Kernel Work owns engineering admission state.',
    singleWriter: 'Work store remains the only durable writer.',
    transaction: 'Existing Work transaction boundaries are reused.',
    lifecycle: 'No new lifecycle is introduced.',
    concurrency: 'Semantic scope is explicit before mutation.',
    persistence: 'Receipts persist only inside existing Work state.',
    failure: 'Invalid or stale evidence fails closed.',
    projectionCache: 'No new projection authority is introduced.',
    time: 'All receipts carry exact recorded time and source revision.',
    performance: 'No extra repository scan is added to mutation admission.',
    compatibility: 'Legacy ids remain audit-only and cannot authorize high-risk mutation.',
  };
}

function completeEvidence(sourceRevision = 'revision-a', critiqueDecision: 'approved' | 'changes_required' = 'approved'): EngineeringAdmissionEvidence {
  const contextClosureReceipt = readyClosure(sourceRevision);
  const productDodReceipt = buildProductDoDReceipt({
    sourceRevision,
    userOutcome: 'Material changes enter mutation only after explicit upstream product and design authority.',
    completionConditions: ['High-risk admission consumes exact structured receipts.'],
    nonRegression: ['Low-risk fast paths remain lightweight.'],
    performanceExpectations: ['No duplicate Context retrieval on admission.'],
    nonGoals: ['Do not create another planning lifecycle.'],
    recordedAt,
  });
  const designDecisionReceipt = buildDesignDecisionContractReceipt({
    sourceRevision,
    contextClosureReceiptId: contextClosureReceipt.receiptId,
    productDodReceiptId: productDodReceipt.receiptId,
    semanticScopeKeys: ['kernel.work.engineering-admission'],
    mutationClass: 'integration_write',
    decisions: decisions(),
    complexityBudget: {
      addedWriters: 0,
      addedDurableMechanisms: 0,
      projectionPaths: 0,
      globalInvalidations: 0,
      lifecycleHooks: 0,
      synchronousCriticalPathWork: 0,
      notes: ['Reuse current Work authority.'],
    },
    recordedAt,
  });
  const independentCritiqueReceipt = buildIndependentCritiqueReceipt({
    sourceRevision,
    contextClosureReceiptId: contextClosureReceipt.receiptId,
    productDodReceiptId: productDodReceipt.receiptId,
    designDecisionReceiptId: designDecisionReceipt.receiptId,
    requirementDigest: 'b'.repeat(64),
    projectContractDigest: 'a'.repeat(64),
    decision: critiqueDecision,
    findings: critiqueDecision === 'approved' ? [] : [{ severity: 'high', summary: 'Design must be revised before mutation.' }],
    recordedAt,
  });
  return {
    projectContractReceipt: projectContract(sourceRevision),
    contextClosureReceipt,
    productDodReceipt,
    designDecisionReceipt,
    independentCritiqueReceipt,
  };
}

describe('Stage7C upstream engineering authority', () => {
  test('legacy bare receipt ids are audit-only and cannot authorize high-risk mutation', () => {
    const receipt = buildEngineeringContextReceipt({
      risk: 'high',
      sourceIdentity: { kind: 'revision', revision: 'revision-a' },
      evidence: {
        projectContractReceipt: projectContract(),
        contextClosureReceiptId: 'context-looking-id',
        productDodReceiptId: 'dod-looking-id',
        designDecisionReceiptId: 'design-looking-id',
        independentCritiqueReceiptId: 'critique-looking-id',
      },
      recordedAt,
    });
    expect(receipt.missingAdmissionEvidence).toEqual(['context_closure', 'product_dod', 'design_decision', 'independent_critique']);
    expect(evaluateEngineeringAdmission({ profile: engineeringWorkProfileForRisk('high'), receipt, mutation: true })).toMatchObject({
      allowed: false,
      code: 'ENGINEERING_ADMISSION_EVIDENCE_REQUIRED',
    });
  });

  test('exact structured receipts authorize high-risk mutation only after an approved independent critique', () => {
    const approved = buildEngineeringContextReceipt({
      risk: 'high', sourceIdentity: { kind: 'revision', revision: 'revision-a' }, evidence: completeEvidence(), recordedAt,
    });
    expect(approved.missingAdmissionEvidence).toEqual([]);
    expect(approved.semanticScope).toEqual({ keys: ['kernel.work.engineering-admission'], mutationClass: 'integration_write' });
    expect(evaluateEngineeringAdmission({ profile: engineeringWorkProfileForRisk('high'), receipt: approved, mutation: true })).toEqual({ allowed: true });

    const changesRequired = buildEngineeringContextReceipt({
      risk: 'high', sourceIdentity: { kind: 'revision', revision: 'revision-a' }, evidence: completeEvidence('revision-a', 'changes_required'), recordedAt,
    });
    expect(changesRequired.missingAdmissionEvidence).toContain('independent_critique');
    expect(evaluateEngineeringAdmission({ profile: engineeringWorkProfileForRisk('high'), receipt: changesRequired, mutation: true }).allowed).toBe(false);
  });

  test('rejects source drift and cross-receipt authority mismatch', () => {
    const evidence = completeEvidence();
    evidence.productDodReceipt = buildProductDoDReceipt({
      sourceRevision: 'revision-b',
      userOutcome: 'wrong source',
      completionConditions: ['wrong source'],
      nonRegression: ['wrong source'],
      performanceExpectations: ['wrong source'],
      nonGoals: ['wrong source'],
      recordedAt,
    });
    expect(() => buildEngineeringContextReceipt({
      risk: 'high', sourceIdentity: { kind: 'revision', revision: 'revision-a' }, evidence, recordedAt,
    })).toThrow('ENGINEERING_PRODUCT_DOD_SOURCE_DRIFT');
  });

  test('same-root blockers force design re-entry while unrelated blockers preserve current design authority', () => {
    const base = buildEngineeringContextReceipt({
      risk: 'high', sourceIdentity: { kind: 'revision', revision: 'revision-a' }, evidence: completeEvidence(), recordedAt,
    });
    const sameRoot = applyEngineeringBlockerDisposition(base, buildEngineeringBlockerDispositionReceipt({
      sourceRevision: 'revision-a', blockerId: 'blocker-root', classification: 'same_root_cause',
      semanticScopeKeys: ['kernel.work.engineering-admission'], rationale: 'The blocker invalidates the current design assumption.', recordedAt,
    }));
    expect(sameRoot.designState).toBe('revisit_required');
    expect(evaluateEngineeringAdmission({ profile: engineeringWorkProfileForRisk('high'), receipt: sameRoot, mutation: true })).toMatchObject({
      allowed: false, code: 'ENGINEERING_DESIGN_REVISIT_REQUIRED',
    });

    const unrelated = applyEngineeringBlockerDisposition(base, buildEngineeringBlockerDispositionReceipt({
      sourceRevision: 'revision-a', blockerId: 'blocker-unrelated', classification: 'unrelated',
      semanticScopeKeys: ['other.scope'], linkedWorkId: 'work-linked-test', rationale: 'The blocker belongs to a disjoint product scope.', recordedAt,
    }));
    expect(unrelated.designState).toBe('ready');
    expect(unrelated.semanticScope).toEqual(base.semanticScope);
    expect(unrelated.blockerDispositions?.at(-1)?.action).toBe('linked_work');
  });

  test('same-root Work re-entry requires an explicit superseding design before continue can resume', () => {
    const root = temp('stage7c-design-supersession-');
    const context = {
      workStore: { root: join(root, 'work') },
      handoffStore: { root: join(root, 'handoff') },
      repoId: 'repo-a',
      checkoutId: 'checkout-a',
      principalId: 'principal-a',
      controllerInstanceId: 'controller-a',
      sourceRevision: 'revision-a',
    };
    const baseEvidence = trustedEngineeringEvidence('revision-a');
    const started = routeWorkStart(context, {
      objective: 'Exercise same-root design re-entry.',
      acceptanceCriteria: ['Design supersession is explicit.'],
      modeInput: { scopeClear: true, mutation: true, requiresRecovery: true, remoteWrite: true, risk: 'remote_write' },
      verifiedEngineeringEvidence: baseEvidence,
    });
    expect(started.status).toBe('ok');
    const workId = (started.data as { work?: { workId?: string } }).work?.workId;
    expect(workId).toBeTruthy();

    const blocked = continueGoalWorkloop(context, {
      workId: workId!,
      engineeringBlocker: {
        blockerId: 'root-cause-1',
        classification: 'same_root_cause',
        rationale: 'The blocker invalidates the prior lifecycle assumption.',
      },
    });
    expect(blocked.status).toBe('blocked');
    expect(getWorkContract(context.workStore, workId!)?.engineeringContext?.designState).toBe('revisit_required');

    const withoutSupersession = continueGoalWorkloop(context, { workId: workId!, verifiedEngineeringEvidence: trustedEngineeringEvidence('revision-a') });
    expect(withoutSupersession.status).toBe('blocked');
    expect(withoutSupersession.summary).toContain('ENGINEERING_DESIGN_SUPERSESSION_REQUIRED');

    const prior = baseEvidence.designDecisionReceipt!;
    const nextDesign = buildDesignDecisionContractReceipt({
      sourceRevision: prior.sourceRevision,
      contextClosureReceiptId: prior.contextClosureReceiptId,
      productDodReceiptId: prior.productDodReceiptId,
      semanticScopeKeys: prior.semanticScopeKeys,
      mutationClass: prior.mutationClass,
      decisions: { ...prior.decisions, lifecycle: 'Revised lifecycle closes the same-root blocker before mutation resumes.' },
      complexityBudget: prior.complexityBudget,
      supersedesReceiptId: prior.receiptId,
      recordedAt: '2026-09-03T00:01:00.000Z',
    });
    const refreshed = trustedEngineeringEvidence('revision-a');
    refreshed.designDecisionReceipt = nextDesign;
    refreshed.independentCritiqueReceipt = buildIndependentCritiqueReceipt({
      sourceRevision: 'revision-a',
      contextClosureReceiptId: refreshed.contextClosureReceipt!.receiptId,
      productDodReceiptId: refreshed.productDodReceipt!.receiptId,
      designDecisionReceiptId: nextDesign.receiptId,
      requirementDigest: 'b'.repeat(64),
      projectContractDigest: 'a'.repeat(64),
      decision: 'approved',
      findings: [],
      recordedAt: '2026-09-03T00:01:00.000Z',
    });
    const resumed = continueGoalWorkloop(context, { workId: workId!, verifiedEngineeringEvidence: refreshed });
    expect(resumed.summary).not.toContain('ENGINEERING_DESIGN_SUPERSESSION_REQUIRED');
    expect(getWorkContract(context.workStore, workId!)?.engineeringContext).toMatchObject({
      designState: 'ready',
      evidence: { designDecisionReceipt: { supersedesReceiptId: prior.receiptId } },
    });
  });


  test('unrelated blockers create one deterministic linked investigation Work without widening the owner scope', () => {
    const root = temp('stage7c-linked-work-');
    const context = {
      workStore: { root: join(root, 'work') },
      handoffStore: { root: join(root, 'handoff') },
      repoId: 'repo-a',
      checkoutId: 'checkout-a',
      principalId: 'principal-a',
      controllerInstanceId: 'controller-a',
      sourceRevision: 'revision-a',
    };
    const started = routeWorkStart(context, {
      objective: 'Own the primary semantic scope.',
      acceptanceCriteria: ['Primary scope remains unchanged.'],
      modeInput: { scopeClear: true, mutation: true, requiresRecovery: true, remoteWrite: true, risk: 'remote_write' },
      verifiedEngineeringEvidence: trustedEngineeringEvidence('revision-a'),
    });
    const workId = (started.data as { work?: { workId?: string } }).work?.workId!;
    const before = getWorkContract(context.workStore, workId)!;
    const semanticScope = before.engineeringContext?.semanticScope;

    const first = continueGoalWorkloop(context, {
      workId,
      engineeringBlocker: {
        blockerId: 'external-disjoint-blocker',
        classification: 'unrelated',
        rationale: 'A separate dependency needs investigation outside this semantic scope.',
        semanticScopeKeys: ['dependency.external'],
      },
    });
    expect(first.status).toBe('blocked');
    const firstData = first.data as { engineeringBlocker?: { linkedWorkId?: string }; linkedWork?: { workId?: string } };
    expect(firstData.engineeringBlocker?.linkedWorkId).toBeTruthy();
    expect(firstData.linkedWork?.workId).toBe(firstData.engineeringBlocker?.linkedWorkId);
    const linked = getWorkContract(context.workStore, firstData.linkedWork!.workId!)!;
    expect(linked).toMatchObject({ workKind: 'investigation' });
    expect(linked.allowedPaths).toEqual([]);
    expect(getWorkContract(context.workStore, workId)?.engineeringContext?.semanticScope).toEqual(semanticScope);

    const second = continueGoalWorkloop(context, {
      workId,
      engineeringBlocker: {
        blockerId: 'external-disjoint-blocker',
        classification: 'unrelated',
        rationale: 'A separate dependency needs investigation outside this semantic scope.',
        semanticScopeKeys: ['dependency.external'],
      },
    });
    const secondData = second.data as { engineeringBlocker?: { linkedWorkId?: string } };
    expect(secondData.engineeringBlocker?.linkedWorkId).toBe(firstData.engineeringBlocker?.linkedWorkId);
  });

});
