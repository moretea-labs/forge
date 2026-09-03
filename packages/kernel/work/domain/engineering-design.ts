import { createHash } from 'crypto';

export const ENGINEERING_MUTATION_CLASSES = ['readonly', 'isolated_write', 'integration_write', 'external_effect'] as const;
export type EngineeringMutationClass = (typeof ENGINEERING_MUTATION_CLASSES)[number];
export const ENGINEERING_DECISION_AREAS = [
  'ownership', 'singleWriter', 'transaction', 'lifecycle', 'concurrency', 'persistence',
  'failure', 'projectionCache', 'time', 'performance', 'compatibility',
] as const;
export type EngineeringDecisionArea = (typeof ENGINEERING_DECISION_AREAS)[number];
export type EngineeringCritiqueDecision = 'approved' | 'changes_required' | 'blocked';
export type EngineeringBlockerClassification = 'same_root_cause' | 'unrelated';
export type EngineeringBlockerAction = 'return_to_design' | 'linked_work';

const MAX_ITEMS = 64;
const MAX_TEXT = 2_000;
const MAX_COMPLEXITY_COUNT = 10_000;

function text(value: unknown, code: string): string {
  if (typeof value !== 'string') throw new Error(code);
  const out = value.trim();
  if (!out || out.length > MAX_TEXT) throw new Error(code);
  return out;
}
function timestamp(value: unknown, code: string): string {
  const out = text(value, code);
  if (!Number.isFinite(Date.parse(out))) throw new Error(code);
  return out;
}
function list(value: unknown, code: string, required = true): string[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error(code);
  const out = value.map((entry) => text(entry, code));
  if (required && out.length === 0) throw new Error(code);
  if (new Set(out).size !== out.length) throw new Error(`${code}_DUPLICATE`);
  return out;
}
function count(value: unknown, code: string): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > MAX_COMPLEXITY_COUNT) throw new Error(code);
  return Number(value);
}
function receiptId(prefix: string, payload: unknown): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32)}`;
}

export function engineeringRequirementContextDigest(input: { objective: string; acceptanceCriteria: string[] }): string {
  const objective = text(input.objective, 'ENGINEERING_REQUIREMENT_OBJECTIVE_REQUIRED');
  const acceptanceCriteria = list(input.acceptanceCriteria, 'ENGINEERING_REQUIREMENT_ACCEPTANCE_REQUIRED', false);
  return createHash('sha256').update(JSON.stringify({ objective, acceptanceCriteria })).digest('hex');
}

function digest(value: unknown, code: string): string {
  const normalized = text(value, code);
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(code);
  return normalized;
}

export interface ProductDoDReceipt {
  schemaVersion: 1;
  receiptId: string;
  sourceRevision: string;
  userOutcome: string;
  completionConditions: string[];
  nonRegression: string[];
  performanceExpectations: string[];
  nonGoals: string[];
  recordedAt: string;
}
export interface ProductDoDDraft extends Omit<ProductDoDReceipt, 'schemaVersion' | 'receiptId'> {}
function normalizeProductDoD(input: ProductDoDDraft): ProductDoDDraft {
  return {
    sourceRevision: text(input.sourceRevision, 'PRODUCT_DOD_SOURCE_REQUIRED'),
    userOutcome: text(input.userOutcome, 'PRODUCT_DOD_USER_OUTCOME_REQUIRED'),
    completionConditions: list(input.completionConditions, 'PRODUCT_DOD_COMPLETION_REQUIRED'),
    nonRegression: list(input.nonRegression, 'PRODUCT_DOD_NON_REGRESSION_REQUIRED'),
    performanceExpectations: list(input.performanceExpectations, 'PRODUCT_DOD_PERFORMANCE_REQUIRED'),
    nonGoals: list(input.nonGoals, 'PRODUCT_DOD_NON_GOALS_REQUIRED'),
    recordedAt: timestamp(input.recordedAt, 'PRODUCT_DOD_RECORDED_AT_INVALID'),
  };
}
export function buildProductDoDReceipt(input: ProductDoDDraft): ProductDoDReceipt {
  const normalized = normalizeProductDoD(input);
  return { schemaVersion: 1, receiptId: receiptId('product_dod', normalized), ...normalized };
}
export function validateProductDoDReceipt(value: ProductDoDReceipt): ProductDoDReceipt {
  if (value.schemaVersion !== 1) throw new Error('PRODUCT_DOD_SCHEMA_INVALID');
  const expected = buildProductDoDReceipt(value);
  if (value.receiptId !== expected.receiptId) throw new Error('PRODUCT_DOD_RECEIPT_ID_INVALID');
  return expected;
}

export interface EngineeringComplexityBudget {
  addedWriters: number;
  addedDurableMechanisms: number;
  projectionPaths: number;
  globalInvalidations: number;
  lifecycleHooks: number;
  synchronousCriticalPathWork: number;
  notes: string[];
}
function normalizeComplexityBudget(value: EngineeringComplexityBudget): EngineeringComplexityBudget {
  return {
    addedWriters: count(value.addedWriters, 'ENGINEERING_COMPLEXITY_WRITERS_INVALID'),
    addedDurableMechanisms: count(value.addedDurableMechanisms, 'ENGINEERING_COMPLEXITY_DURABLE_INVALID'),
    projectionPaths: count(value.projectionPaths, 'ENGINEERING_COMPLEXITY_PROJECTION_INVALID'),
    globalInvalidations: count(value.globalInvalidations, 'ENGINEERING_COMPLEXITY_INVALIDATIONS_INVALID'),
    lifecycleHooks: count(value.lifecycleHooks, 'ENGINEERING_COMPLEXITY_LIFECYCLE_INVALID'),
    synchronousCriticalPathWork: count(value.synchronousCriticalPathWork, 'ENGINEERING_COMPLEXITY_CRITICAL_PATH_INVALID'),
    notes: list(value.notes ?? [], 'ENGINEERING_COMPLEXITY_NOTES_INVALID', false),
  };
}

export interface DesignDecisionContractReceipt {
  schemaVersion: 1;
  receiptId: string;
  sourceRevision: string;
  contextClosureReceiptId: string;
  productDodReceiptId: string;
  semanticScopeKeys: string[];
  mutationClass: EngineeringMutationClass;
  decisions: Record<EngineeringDecisionArea, string>;
  complexityBudget: EngineeringComplexityBudget;
  supersedesReceiptId?: string;
  recordedAt: string;
}
export interface DesignDecisionContractDraft extends Omit<DesignDecisionContractReceipt, 'schemaVersion' | 'receiptId'> {}
function normalizeDesignDecision(input: DesignDecisionContractDraft): DesignDecisionContractDraft {
  if (!ENGINEERING_MUTATION_CLASSES.includes(input.mutationClass)) throw new Error('ENGINEERING_MUTATION_CLASS_INVALID');
  const decisions = {} as Record<EngineeringDecisionArea, string>;
  for (const area of ENGINEERING_DECISION_AREAS) decisions[area] = text(input.decisions?.[area], `DESIGN_DECISION_${area.toUpperCase()}_REQUIRED`);
  const supersedesReceiptId = input.supersedesReceiptId?.trim() || undefined;
  return {
    sourceRevision: text(input.sourceRevision, 'DESIGN_DECISION_SOURCE_REQUIRED'),
    contextClosureReceiptId: text(input.contextClosureReceiptId, 'DESIGN_DECISION_CONTEXT_CLOSURE_REQUIRED'),
    productDodReceiptId: text(input.productDodReceiptId, 'DESIGN_DECISION_PRODUCT_DOD_REQUIRED'),
    semanticScopeKeys: list(input.semanticScopeKeys, 'DESIGN_DECISION_SEMANTIC_SCOPE_REQUIRED'),
    mutationClass: input.mutationClass,
    decisions,
    complexityBudget: normalizeComplexityBudget(input.complexityBudget),
    ...(supersedesReceiptId ? { supersedesReceiptId } : {}),
    recordedAt: timestamp(input.recordedAt, 'DESIGN_DECISION_RECORDED_AT_INVALID'),
  };
}
export function buildDesignDecisionContractReceipt(input: DesignDecisionContractDraft): DesignDecisionContractReceipt {
  const normalized = normalizeDesignDecision(input);
  const id = receiptId('design_decision', normalized);
  if (normalized.supersedesReceiptId === id) throw new Error('DESIGN_DECISION_CANNOT_SUPERSEDE_SELF');
  return { schemaVersion: 1, receiptId: id, ...normalized };
}
export function validateDesignDecisionContractReceipt(value: DesignDecisionContractReceipt): DesignDecisionContractReceipt {
  if (value.schemaVersion !== 1) throw new Error('DESIGN_DECISION_SCHEMA_INVALID');
  const expected = buildDesignDecisionContractReceipt(value);
  if (value.receiptId !== expected.receiptId) throw new Error('DESIGN_DECISION_RECEIPT_ID_INVALID');
  return expected;
}

export interface IndependentCritiqueFinding { severity: 'critical' | 'high' | 'medium' | 'low' | 'info'; summary: string; }
export interface IndependentCritiqueReceipt {
  schemaVersion: 1;
  receiptId: string;
  sourceRevision: string;
  contextClosureReceiptId: string;
  productDodReceiptId: string;
  designDecisionReceiptId: string;
  requirementDigest: string;
  projectContractDigest: string;
  framing: 'fresh_requirement_source_contracts_only';
  decision: EngineeringCritiqueDecision;
  findings: IndependentCritiqueFinding[];
  recordedAt: string;
}
export interface IndependentCritiqueDraft extends Omit<IndependentCritiqueReceipt, 'schemaVersion' | 'receiptId' | 'framing'> {}
function normalizeCritique(input: IndependentCritiqueDraft): Omit<IndependentCritiqueReceipt, 'schemaVersion' | 'receiptId'> {
  if (!['approved', 'changes_required', 'blocked'].includes(input.decision)) throw new Error('ENGINEERING_CRITIQUE_DECISION_INVALID');
  if (!Array.isArray(input.findings) || input.findings.length > MAX_ITEMS) throw new Error('ENGINEERING_CRITIQUE_FINDINGS_INVALID');
  const findings = input.findings.map((finding) => {
    if (!['critical', 'high', 'medium', 'low', 'info'].includes(finding.severity)) throw new Error('ENGINEERING_CRITIQUE_SEVERITY_INVALID');
    return { severity: finding.severity, summary: text(finding.summary, 'ENGINEERING_CRITIQUE_SUMMARY_REQUIRED') };
  });
  if (input.decision !== 'approved' && findings.length === 0) throw new Error('ENGINEERING_CRITIQUE_FINDINGS_REQUIRED');
  return {
    sourceRevision: text(input.sourceRevision, 'ENGINEERING_CRITIQUE_SOURCE_REQUIRED'),
    contextClosureReceiptId: text(input.contextClosureReceiptId, 'ENGINEERING_CRITIQUE_CONTEXT_REQUIRED'),
    productDodReceiptId: text(input.productDodReceiptId, 'ENGINEERING_CRITIQUE_PRODUCT_DOD_REQUIRED'),
    designDecisionReceiptId: text(input.designDecisionReceiptId, 'ENGINEERING_CRITIQUE_DESIGN_REQUIRED'),
    requirementDigest: digest(input.requirementDigest, 'ENGINEERING_CRITIQUE_REQUIREMENT_DIGEST_INVALID'),
    projectContractDigest: digest(input.projectContractDigest, 'ENGINEERING_CRITIQUE_PROJECT_CONTRACT_DIGEST_INVALID'),
    framing: 'fresh_requirement_source_contracts_only',
    decision: input.decision,
    findings,
    recordedAt: timestamp(input.recordedAt, 'ENGINEERING_CRITIQUE_RECORDED_AT_INVALID'),
  };
}
export function buildIndependentCritiqueReceipt(input: IndependentCritiqueDraft): IndependentCritiqueReceipt {
  const normalized = normalizeCritique(input);
  return { schemaVersion: 1, receiptId: receiptId('independent_critique', normalized), ...normalized };
}
export function validateIndependentCritiqueReceipt(value: IndependentCritiqueReceipt): IndependentCritiqueReceipt {
  if (value.schemaVersion !== 1) throw new Error('ENGINEERING_CRITIQUE_SCHEMA_INVALID');
  const expected = buildIndependentCritiqueReceipt(value);
  if (value.receiptId !== expected.receiptId) throw new Error('ENGINEERING_CRITIQUE_RECEIPT_ID_INVALID');
  return expected;
}

export interface EngineeringBlockerDispositionReceipt {
  schemaVersion: 1;
  receiptId: string;
  sourceRevision: string;
  blockerId: string;
  classification: EngineeringBlockerClassification;
  action: EngineeringBlockerAction;
  semanticScopeKeys: string[];
  linkedWorkId?: string;
  rationale: string;
  recordedAt: string;
}
export function buildEngineeringBlockerDispositionReceipt(input: {
  sourceRevision: string;
  blockerId: string;
  classification: EngineeringBlockerClassification;
  semanticScopeKeys?: string[];
  linkedWorkId?: string;
  rationale: string;
  recordedAt: string;
}): EngineeringBlockerDispositionReceipt {
  if (!['same_root_cause', 'unrelated'].includes(input.classification)) throw new Error('ENGINEERING_BLOCKER_CLASSIFICATION_INVALID');
  const linkedWorkId = input.linkedWorkId?.trim() || undefined;
  if (input.classification === 'unrelated' && !linkedWorkId) throw new Error('ENGINEERING_BLOCKER_LINKED_WORK_REQUIRED');
  if (input.classification === 'same_root_cause' && linkedWorkId) throw new Error('ENGINEERING_BLOCKER_LINKED_WORK_FORBIDDEN');
  const core = {
    sourceRevision: text(input.sourceRevision, 'ENGINEERING_BLOCKER_SOURCE_REQUIRED'),
    blockerId: text(input.blockerId, 'ENGINEERING_BLOCKER_ID_REQUIRED'),
    classification: input.classification,
    action: input.classification === 'same_root_cause' ? 'return_to_design' as const : 'linked_work' as const,
    semanticScopeKeys: list(input.semanticScopeKeys ?? [], 'ENGINEERING_BLOCKER_SCOPE_INVALID', false),
    ...(linkedWorkId ? { linkedWorkId: text(linkedWorkId, 'ENGINEERING_BLOCKER_LINKED_WORK_INVALID') } : {}),
    rationale: text(input.rationale, 'ENGINEERING_BLOCKER_RATIONALE_REQUIRED'),
    recordedAt: timestamp(input.recordedAt, 'ENGINEERING_BLOCKER_RECORDED_AT_INVALID'),
  };
  return { schemaVersion: 1, receiptId: receiptId('engineering_blocker', core), ...core };
}

export function validateEngineeringBlockerDispositionReceipt(value: EngineeringBlockerDispositionReceipt): EngineeringBlockerDispositionReceipt {
  if (value.schemaVersion !== 1) throw new Error('ENGINEERING_BLOCKER_SCHEMA_INVALID');
  const expected = buildEngineeringBlockerDispositionReceipt(value);
  if (value.receiptId !== expected.receiptId || value.action !== expected.action) throw new Error('ENGINEERING_BLOCKER_RECEIPT_ID_INVALID');
  return expected;
}
