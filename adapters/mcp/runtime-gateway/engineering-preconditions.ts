import {
  buildDesignDecisionContractReceipt,
  buildIndependentCritiqueReceipt,
  buildProductDoDReceipt,
  engineeringRequirementContextDigest,
  type ContextClosureReceipt,
  type EngineeringAdmissionEvidence,
  type IndependentCritiqueFinding,
  type ProjectEngineeringContractReceipt,
} from '../../../packages/kernel/work/api/index';
import { loadProjectEngineeringContract } from '../../../src/runtime/context/project-engineering-contract';
import { validateRuntimeIssuedContextClosureReceipt } from '../../../src/runtime/context/context-closure';

type RecordValue = Record<string, unknown>;
function object(value: unknown, code: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as RecordValue;
}
function text(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
}
function strings(value: unknown, code: string): string[] {
  if (!Array.isArray(value)) throw new Error(code);
  return value.map((entry) => text(entry, code));
}

export function mintEngineeringAdmissionEvidence(input: {
  repoRoot: string;
  sourceRevision: string;
  draft: unknown;
  requirementContext: { objective: string; acceptanceCriteria: string[] };
  existingProjectContractReceipt?: ProjectEngineeringContractReceipt;
  now?: () => string;
}): EngineeringAdmissionEvidence {
  const draft = object(input.draft, 'ENGINEERING_PRECONDITIONS_INVALID');
  const sourceRevision = text(input.sourceRevision, 'ENGINEERING_PRECONDITIONS_SOURCE_REQUIRED');
  const closure = validateRuntimeIssuedContextClosureReceipt(object(draft.context_closure, 'ENGINEERING_CONTEXT_CLOSURE_REQUIRED') as unknown as ContextClosureReceipt);
  if (closure.sourceRevision !== sourceRevision) throw new Error('ENGINEERING_CONTEXT_CLOSURE_SOURCE_DRIFT');
  if (closure.readiness.status !== 'ready') throw new Error(`ENGINEERING_CONTEXT_CLOSURE_NOT_READY: ${closure.readiness.reasonCodes.join(',') || closure.readiness.status}`);

  const loadedProject = input.existingProjectContractReceipt
    ? { status: 'ready' as const, receipt: input.existingProjectContractReceipt }
    : loadProjectEngineeringContract({ repoRoot: input.repoRoot, sourceRevision });
  const projectContractReceipt = loadedProject.status === 'ready' ? loadedProject.receipt : undefined;
  if (!projectContractReceipt) throw new Error('ENGINEERING_PROJECT_CONTRACT_REQUIRED');
  const requirementDigest = engineeringRequirementContextDigest(input.requirementContext);
  const recordedAt = (input.now ?? (() => new Date().toISOString()))();

  const dod = object(draft.product_dod, 'ENGINEERING_PRODUCT_DOD_REQUIRED');
  const productDodReceipt = buildProductDoDReceipt({
    sourceRevision,
    userOutcome: text(dod.user_outcome, 'ENGINEERING_PRODUCT_DOD_USER_OUTCOME_REQUIRED'),
    completionConditions: strings(dod.completion_conditions, 'ENGINEERING_PRODUCT_DOD_COMPLETION_REQUIRED'),
    nonRegression: strings(dod.non_regression, 'ENGINEERING_PRODUCT_DOD_NON_REGRESSION_REQUIRED'),
    performanceExpectations: strings(dod.performance_expectations, 'ENGINEERING_PRODUCT_DOD_PERFORMANCE_REQUIRED'),
    nonGoals: strings(dod.non_goals, 'ENGINEERING_PRODUCT_DOD_NON_GOALS_REQUIRED'),
    recordedAt,
  });

  const design = object(draft.design_decision, 'ENGINEERING_DESIGN_DECISION_REQUIRED');
  const decisionsInput = object(design.decisions, 'ENGINEERING_DESIGN_DECISIONS_REQUIRED');
  const decisions = {
    ownership: text(decisionsInput.ownership, 'ENGINEERING_DESIGN_OWNERSHIP_REQUIRED'),
    singleWriter: text(decisionsInput.single_writer, 'ENGINEERING_DESIGN_SINGLE_WRITER_REQUIRED'),
    transaction: text(decisionsInput.transaction, 'ENGINEERING_DESIGN_TRANSACTION_REQUIRED'),
    lifecycle: text(decisionsInput.lifecycle, 'ENGINEERING_DESIGN_LIFECYCLE_REQUIRED'),
    concurrency: text(decisionsInput.concurrency, 'ENGINEERING_DESIGN_CONCURRENCY_REQUIRED'),
    persistence: text(decisionsInput.persistence, 'ENGINEERING_DESIGN_PERSISTENCE_REQUIRED'),
    failure: text(decisionsInput.failure, 'ENGINEERING_DESIGN_FAILURE_REQUIRED'),
    projectionCache: text(decisionsInput.projection_cache, 'ENGINEERING_DESIGN_PROJECTION_CACHE_REQUIRED'),
    time: text(decisionsInput.time, 'ENGINEERING_DESIGN_TIME_REQUIRED'),
    performance: text(decisionsInput.performance, 'ENGINEERING_DESIGN_PERFORMANCE_REQUIRED'),
    compatibility: text(decisionsInput.compatibility, 'ENGINEERING_DESIGN_COMPATIBILITY_REQUIRED'),
  };
  const budgetInput = object(design.complexity_budget, 'ENGINEERING_COMPLEXITY_BUDGET_REQUIRED');
  const complexityBudget = {
    addedWriters: Number(budgetInput.added_writers ?? 0),
    addedDurableMechanisms: Number(budgetInput.added_durable_mechanisms ?? 0),
    projectionPaths: Number(budgetInput.projection_paths ?? 0),
    globalInvalidations: Number(budgetInput.global_invalidations ?? 0),
    lifecycleHooks: Number(budgetInput.lifecycle_hooks ?? 0),
    synchronousCriticalPathWork: Number(budgetInput.synchronous_critical_path_work ?? 0),
    notes: Array.isArray(budgetInput.notes) ? budgetInput.notes.map(String) : [],
  };
  const mutationClass = design.mutation_class;
  if (mutationClass !== 'readonly' && mutationClass !== 'isolated_write' && mutationClass !== 'integration_write' && mutationClass !== 'external_effect') {
    throw new Error('ENGINEERING_MUTATION_CLASS_INVALID');
  }
  const designDecisionReceipt = buildDesignDecisionContractReceipt({
    sourceRevision,
    contextClosureReceiptId: closure.receiptId,
    productDodReceiptId: productDodReceipt.receiptId,
    semanticScopeKeys: strings(design.semantic_scope_keys, 'ENGINEERING_SEMANTIC_SCOPE_REQUIRED'),
    mutationClass,
    decisions,
    complexityBudget,
    ...(typeof design.supersedes_receipt_id === 'string' && design.supersedes_receipt_id.trim() ? { supersedesReceiptId: design.supersedes_receipt_id.trim() } : {}),
    recordedAt,
  });

  const critique = object(draft.independent_critique, 'ENGINEERING_INDEPENDENT_CRITIQUE_REQUIRED');
  const decision = critique.decision;
  if (decision !== 'approved' && decision !== 'changes_required' && decision !== 'blocked') throw new Error('ENGINEERING_CRITIQUE_DECISION_INVALID');
  const findings = Array.isArray(critique.findings)
    ? critique.findings.map((entry) => {
        const finding = object(entry, 'ENGINEERING_CRITIQUE_FINDING_INVALID');
        const severity = finding.severity;
        if (severity !== 'critical' && severity !== 'high' && severity !== 'medium' && severity !== 'low' && severity !== 'info') throw new Error('ENGINEERING_CRITIQUE_SEVERITY_INVALID');
        return { severity: severity as IndependentCritiqueFinding['severity'], summary: text(finding.summary, 'ENGINEERING_CRITIQUE_SUMMARY_REQUIRED') };
      })
    : [];
  const independentCritiqueReceipt = buildIndependentCritiqueReceipt({
    sourceRevision,
    contextClosureReceiptId: closure.receiptId,
    productDodReceiptId: productDodReceipt.receiptId,
    designDecisionReceiptId: designDecisionReceipt.receiptId,
    requirementDigest,
    projectContractDigest: projectContractReceipt.contentDigest,
    decision,
    findings,
    recordedAt,
  });

  return {
    projectContractReceipt,
    contextClosureReceipt: closure,
    contextClosureReceiptId: closure.receiptId,
    productDodReceipt,
    designDecisionReceipt,
    independentCritiqueReceipt,
  };
}
