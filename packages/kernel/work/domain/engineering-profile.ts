import type { WorkRisk } from './types';
import { validateContextClosureReceipt } from './context-closure-receipt';
import {
  validateDesignDecisionContractReceipt,
  validateEngineeringBlockerDispositionReceipt,
  validateIndependentCritiqueReceipt,
  validateProductDoDReceipt,
} from './engineering-design';
import { validateProjectEngineeringContractReceipt } from './project-engineering-contract';
import {
  ENGINEERING_WORK_PROFILE_VERSION,
  type EngineeringAdmissionEvidence,
  type EngineeringContextReceipt,
  type EngineeringEvidenceKind,
  type EngineeringEvidenceRequirement,
  type EngineeringRiskClass,
} from './engineering-contracts';

export * from './engineering-contracts';

export interface EngineeringWorkProfile {
  schemaVersion: 1;
  profileVersion: typeof ENGINEERING_WORK_PROFILE_VERSION;
  riskClass: EngineeringRiskClass;
  admissionEnforcement: 'observe' | 'enforce';
  evidenceRequirements: Record<EngineeringEvidenceKind, EngineeringEvidenceRequirement>;
  admissionEvidence: EngineeringEvidenceKind[];
  completionEvidence: EngineeringEvidenceKind[];
}

const requirement = (
  project_contract: EngineeringEvidenceRequirement,
  context_closure: EngineeringEvidenceRequirement,
  product_dod: EngineeringEvidenceRequirement,
  design_decision: EngineeringEvidenceRequirement,
  independent_critique: EngineeringEvidenceRequirement,
  semantic_tools: EngineeringEvidenceRequirement,
  focused_validation: EngineeringEvidenceRequirement,
  real_journey: EngineeringEvidenceRequirement,
  fresh_review: EngineeringEvidenceRequirement,
): EngineeringWorkProfile['evidenceRequirements'] => ({
  project_contract,
  context_closure,
  product_dod,
  design_decision,
  independent_critique,
  semantic_tools,
  focused_validation,
  real_journey,
  fresh_review,
});

const PROFILES: Record<EngineeringRiskClass, EngineeringWorkProfile> = {
  low: {
    schemaVersion: 1,
    profileVersion: ENGINEERING_WORK_PROFILE_VERSION,
    riskClass: 'low',
    admissionEnforcement: 'observe',
    evidenceRequirements: requirement('optional', 'optional', 'optional', 'optional', 'optional', 'optional', 'conditional', 'optional', 'optional'),
    admissionEvidence: [],
    completionEvidence: [],
  },
  normal: {
    schemaVersion: 1,
    profileVersion: ENGINEERING_WORK_PROFILE_VERSION,
    riskClass: 'normal',
    admissionEnforcement: 'observe',
    evidenceRequirements: requirement('required', 'required', 'required', 'conditional', 'optional', 'conditional', 'required', 'conditional', 'required'),
    admissionEvidence: ['project_contract', 'context_closure', 'product_dod'],
    completionEvidence: ['focused_validation', 'fresh_review'],
  },
  high: {
    schemaVersion: 1,
    profileVersion: ENGINEERING_WORK_PROFILE_VERSION,
    riskClass: 'high',
    admissionEnforcement: 'enforce',
    evidenceRequirements: requirement('required', 'required', 'required', 'required', 'required', 'conditional', 'required', 'conditional', 'required'),
    admissionEvidence: ['project_contract', 'context_closure', 'product_dod', 'design_decision', 'independent_critique'],
    completionEvidence: ['focused_validation', 'fresh_review'],
  },
  critical: {
    schemaVersion: 1,
    profileVersion: ENGINEERING_WORK_PROFILE_VERSION,
    riskClass: 'critical',
    admissionEnforcement: 'enforce',
    evidenceRequirements: requirement('required', 'required', 'required', 'required', 'required', 'required', 'required', 'required', 'required'),
    admissionEvidence: ['project_contract', 'context_closure', 'product_dod', 'design_decision', 'independent_critique', 'semantic_tools'],
    completionEvidence: ['focused_validation', 'real_journey', 'fresh_review'],
  },
};

export function engineeringRiskClassForWorkRisk(risk: WorkRisk): EngineeringRiskClass {
  if (risk === 'readonly' || risk === 'low') return 'low';
  if (risk === 'medium') return 'normal';
  if (risk === 'high') return 'high';
  return 'critical';
}

export function engineeringWorkProfileForRisk(risk: WorkRisk): EngineeringWorkProfile {
  return PROFILES[engineeringRiskClassForWorkRisk(risk)];
}

function ids(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 128);
}

function provided(kind: EngineeringEvidenceKind, receipt: EngineeringContextReceipt): boolean {
  switch (kind) {
    case 'project_contract': return Boolean(receipt.projectContractReceipt);
    case 'context_closure': return receipt.evidence.contextClosureReceipt?.readiness.status === 'ready';
    case 'product_dod': return Boolean(receipt.evidence.productDodReceipt);
    case 'design_decision': return Boolean(receipt.evidence.designDecisionReceipt) && receipt.designState !== 'revisit_required';
    case 'independent_critique': return receipt.evidence.independentCritiqueReceipt?.decision === 'approved' && receipt.designState !== 'revisit_required';
    case 'semantic_tools': return receipt.evidence.semanticToolReceiptIds.length > 0;
    case 'focused_validation': return receipt.evidence.validationReceiptIds.length > 0;
    case 'real_journey': return receipt.evidence.journeyReceiptIds.length > 0;
    case 'fresh_review': return Boolean(receipt.evidence.freshReviewReceiptId);
  }
}

function requiredKinds(profile: EngineeringWorkProfile, phase: 'admission' | 'completion', conditions: EngineeringContextReceipt['conditions']): EngineeringEvidenceKind[] {
  const configured = phase === 'admission' ? profile.admissionEvidence : profile.completionEvidence;
  const out = [...configured];
  if (conditions.semanticToolsRequired && profile.evidenceRequirements.semantic_tools === 'conditional') out.push('semantic_tools');
  if (conditions.realJourneyRequired && profile.evidenceRequirements.real_journey === 'conditional') out.push('real_journey');
  return [...new Set(out)];
}

export function buildEngineeringContextReceipt(input: {
  risk: WorkRisk;
  sourceIdentity: EngineeringContextReceipt['sourceIdentity'];
  evidence?: EngineeringAdmissionEvidence;
  recordedAt: string;
}): EngineeringContextReceipt {
  const profile = engineeringWorkProfileForRisk(input.risk);
  const evidence = input.evidence ?? {};
  const projectContractReceipt = evidence.projectContractReceipt
    ? validateProjectEngineeringContractReceipt(evidence.projectContractReceipt)
    : undefined;
  const contextClosureReceipt = evidence.contextClosureReceipt ? validateContextClosureReceipt(evidence.contextClosureReceipt) : undefined;
  const productDodReceipt = evidence.productDodReceipt ? validateProductDoDReceipt(evidence.productDodReceipt) : undefined;
  const designDecisionReceipt = evidence.designDecisionReceipt ? validateDesignDecisionContractReceipt(evidence.designDecisionReceipt) : undefined;
  const independentCritiqueReceipt = evidence.independentCritiqueReceipt ? validateIndependentCritiqueReceipt(evidence.independentCritiqueReceipt) : undefined;
  const exactRevision = input.sourceIdentity.kind === 'revision' ? input.sourceIdentity.revision : undefined;
  for (const [kind, sourceRevision] of [
    ['PROJECT_CONTRACT', projectContractReceipt?.sourceRevision],
    ['CONTEXT_CLOSURE', contextClosureReceipt?.sourceRevision],
    ['PRODUCT_DOD', productDodReceipt?.sourceRevision],
    ['DESIGN_DECISION', designDecisionReceipt?.sourceRevision],
    ['INDEPENDENT_CRITIQUE', independentCritiqueReceipt?.sourceRevision],
  ] as const) {
    if (exactRevision && sourceRevision && sourceRevision !== exactRevision) throw new Error(`ENGINEERING_${kind}_SOURCE_DRIFT`);
  }
  if (designDecisionReceipt && productDodReceipt && designDecisionReceipt.productDodReceiptId !== productDodReceipt.receiptId) {
    throw new Error('ENGINEERING_DESIGN_PRODUCT_DOD_MISMATCH');
  }
  if (designDecisionReceipt && contextClosureReceipt && designDecisionReceipt.contextClosureReceiptId !== contextClosureReceipt.receiptId) {
    throw new Error('ENGINEERING_DESIGN_CONTEXT_MISMATCH');
  }
  if (independentCritiqueReceipt) {
    if (productDodReceipt && independentCritiqueReceipt.productDodReceiptId !== productDodReceipt.receiptId) throw new Error('ENGINEERING_CRITIQUE_PRODUCT_DOD_MISMATCH');
    if (designDecisionReceipt && independentCritiqueReceipt.designDecisionReceiptId !== designDecisionReceipt.receiptId) throw new Error('ENGINEERING_CRITIQUE_DESIGN_MISMATCH');
    const contextReceiptId = contextClosureReceipt?.receiptId ?? evidence.contextClosureReceiptId?.trim();
    if (contextReceiptId && independentCritiqueReceipt.contextClosureReceiptId !== contextReceiptId) throw new Error('ENGINEERING_CRITIQUE_CONTEXT_MISMATCH');
    if (projectContractReceipt && independentCritiqueReceipt.projectContractDigest !== projectContractReceipt.contentDigest) throw new Error('ENGINEERING_CRITIQUE_PROJECT_CONTRACT_MISMATCH');
  }
  const receipt: EngineeringContextReceipt = {
    schemaVersion: 1,
    profileVersion: ENGINEERING_WORK_PROFILE_VERSION,
    riskClass: profile.riskClass,
    sourceIdentity: input.sourceIdentity,
    projectContractReceipt,
    evidence: {
      contextClosureReceiptId: contextClosureReceipt?.receiptId ?? (evidence.contextClosureReceiptId?.trim() || undefined),
      contextClosureReceipt,
      productDodReceiptId: productDodReceipt?.receiptId ?? (evidence.productDodReceiptId?.trim() || undefined),
      designDecisionReceiptId: designDecisionReceipt?.receiptId ?? (evidence.designDecisionReceiptId?.trim() || undefined),
      independentCritiqueReceiptId: independentCritiqueReceipt?.receiptId ?? (evidence.independentCritiqueReceiptId?.trim() || undefined),
      productDodReceipt,
      designDecisionReceipt,
      independentCritiqueReceipt,
      semanticToolReceiptIds: ids(evidence.semanticToolReceiptIds),
      validationReceiptIds: ids(evidence.validationReceiptIds),
      journeyReceiptIds: ids(evidence.journeyReceiptIds),
      freshReviewReceiptId: evidence.freshReviewReceiptId?.trim() || undefined,
    },
    conditions: {
      semanticToolsRequired: evidence.conditions?.semanticToolsRequired === true,
      realJourneyRequired: evidence.conditions?.realJourneyRequired === true,
    },
    ...(designDecisionReceipt ? {
      semanticScope: { keys: designDecisionReceipt.semanticScopeKeys, mutationClass: designDecisionReceipt.mutationClass },
      complexityBudget: designDecisionReceipt.complexityBudget,
      designState: 'ready' as const,
    } : {}),
    blockerDispositions: [],
    missingAdmissionEvidence: [],
    missingCompletionEvidence: [],
    recordedAt: input.recordedAt,
  };
  receipt.missingAdmissionEvidence = requiredKinds(profile, 'admission', receipt.conditions).filter((kind) => !provided(kind, receipt));
  receipt.missingCompletionEvidence = requiredKinds(profile, 'completion', receipt.conditions).filter((kind) => !provided(kind, receipt));
  return receipt;
}

export function evaluateEngineeringAdmission(input: {
  profile: EngineeringWorkProfile;
  receipt: EngineeringContextReceipt;
  mutation: boolean;
}): { allowed: true } | { allowed: false; code: string; missing: EngineeringEvidenceKind[] } {
  if (!input.mutation || input.profile.admissionEnforcement === 'observe') return { allowed: true };
  if (input.receipt.sourceIdentity.kind === 'unknown') {
    return { allowed: false, code: 'ENGINEERING_SOURCE_IDENTITY_REQUIRED', missing: input.receipt.missingAdmissionEvidence };
  }
  if (input.receipt.designState === 'revisit_required') {
    return { allowed: false, code: 'ENGINEERING_DESIGN_REVISIT_REQUIRED', missing: ['design_decision', 'independent_critique'] };
  }
  if (input.receipt.missingAdmissionEvidence.length > 0) {
    return { allowed: false, code: 'ENGINEERING_ADMISSION_EVIDENCE_REQUIRED', missing: input.receipt.missingAdmissionEvidence };
  }
  return { allowed: true };
}


export function applyEngineeringBlockerDisposition(
  receipt: EngineeringContextReceipt,
  blocker: import('./engineering-design').EngineeringBlockerDispositionReceipt,
): EngineeringContextReceipt {
  const validated = validateEngineeringBlockerDispositionReceipt(blocker);
  if (receipt.sourceIdentity.kind === 'revision' && validated.sourceRevision !== receipt.sourceIdentity.revision) {
    throw new Error('ENGINEERING_BLOCKER_SOURCE_DRIFT');
  }
  const existing = receipt.blockerDispositions ?? [];
  if (existing.some((entry) => entry.receiptId === validated.receiptId)) return receipt;
  return {
    ...receipt,
    blockerDispositions: [...existing, validated].slice(-64),
    ...(validated.action === 'return_to_design' ? { designState: 'revisit_required' as const } : {}),
  };
}
