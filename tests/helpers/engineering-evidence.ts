import {
  buildDesignDecisionContractReceipt,
  buildIndependentCritiqueReceipt,
  buildProductDoDReceipt,
} from '../../packages/kernel/work/domain/engineering-design';
import { contextClosureReceiptIdentity } from '../../packages/kernel/work/domain/context-closure-receipt';
import type { ContextClosureReceipt, EngineeringAdmissionEvidence } from '../../packages/kernel/work/domain/engineering-contracts';

const RECORDED_AT = '2026-09-03T00:00:00.000Z';

export function trustedEngineeringEvidence(sourceRevision = 'revision-a'): EngineeringAdmissionEvidence {
  const contextClosureReceipt: ContextClosureReceipt = {
    schemaVersion: 1,
    receiptId: '',
    sourceRevision,
    generatedAt: RECORDED_AT,
    contextPackSchemaVersion: 11,
    repository: { branch: 'main', dirty: false, activeWorkIds: [] },
    projectContractStatus: 'missing',
    guidance: { status: 'none', paths: [] },
    detected: { languages: ['typescript'], platforms: [] },
    skills: { status: 'not_required', requiredKinds: [], resolved: [], unresolvedKinds: [] },
    semanticTools: { required: false, status: 'not_required', providers: [], reasonCodes: [], compilerEvidenceRequired: false },
    sourceEvidence: {
      currentPaths: ['src/runtime/example.ts'],
      testPaths: ['tests/runtime/example.test.ts'],
      recentChanges: [],
      rawSourceStatus: 'current',
      structuralStatus: 'disabled',
    },
    readiness: { status: 'ready', reasonCodes: [] },
    provenance: { source: 'rh_context', contextGeneratedAt: RECORDED_AT },
  };
  contextClosureReceipt.receiptId = contextClosureReceiptIdentity(contextClosureReceipt);

  const productDodReceipt = buildProductDoDReceipt({
    sourceRevision,
    userOutcome: 'High-risk work uses exact structured engineering authority.',
    completionConditions: ['The intended user outcome is delivered against the exact source.'],
    nonRegression: ['Existing safe behavior remains intact.'],
    performanceExpectations: ['No unnecessary synchronous hot-path work is introduced.'],
    nonGoals: ['Do not create a second Work lifecycle.'],
    recordedAt: RECORDED_AT,
  });
  const designDecisionReceipt = buildDesignDecisionContractReceipt({
    sourceRevision,
    contextClosureReceiptId: contextClosureReceipt.receiptId,
    productDodReceiptId: productDodReceipt.receiptId,
    semanticScopeKeys: ['test.engineering-authority'],
    mutationClass: 'integration_write',
    decisions: {
      ownership: 'Existing Kernel Work authority owns the state.',
      singleWriter: 'Existing Work persistence remains the single writer.',
      transaction: 'Reuse current Work transaction boundaries.',
      lifecycle: 'No additional lifecycle authority is introduced.',
      concurrency: 'Scope is explicit before mutation.',
      persistence: 'Only existing Work persistence stores receipts.',
      failure: 'Invalid evidence fails closed.',
      projectionCache: 'No new projection authority is introduced.',
      time: 'Receipts are source-bound and timestamped.',
      performance: 'No duplicate source scan is required.',
      compatibility: 'Legacy ids are audit-only.',
    },
    complexityBudget: {
      addedWriters: 0,
      addedDurableMechanisms: 0,
      projectionPaths: 0,
      globalInvalidations: 0,
      lifecycleHooks: 0,
      synchronousCriticalPathWork: 0,
      notes: [],
    },
    recordedAt: RECORDED_AT,
  });
  const independentCritiqueReceipt = buildIndependentCritiqueReceipt({
    sourceRevision,
    contextClosureReceiptId: contextClosureReceipt.receiptId,
    productDodReceiptId: productDodReceipt.receiptId,
    designDecisionReceiptId: designDecisionReceipt.receiptId,
    requirementDigest: 'b'.repeat(64),
    projectContractDigest: 'a'.repeat(64),
    decision: 'approved',
    findings: [],
    recordedAt: RECORDED_AT,
  });
  return {
    projectContractReceipt: {
      schemaVersion: 1,
      contractPath: '.forge/project-engineering.json',
      projectId: 'forge-test',
      contractId: 'forge-test-engineering',
      contractVersion: '1',
      sourceRevision,
      contentDigest: 'a'.repeat(64),
      provenance: { source: 'repository', loadedAt: RECORDED_AT },
    },
    contextClosureReceipt,
    productDodReceipt,
    designDecisionReceipt,
    independentCritiqueReceipt,
    semanticToolReceiptIds: ['semantic-tool-test'],
  };
}
