import type { WorkRisk } from './types';
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
    case 'context_closure': return Boolean(receipt.evidence.contextClosureReceiptId);
    case 'product_dod': return Boolean(receipt.evidence.productDodReceiptId);
    case 'design_decision': return Boolean(receipt.evidence.designDecisionReceiptId);
    case 'independent_critique': return Boolean(receipt.evidence.independentCritiqueReceiptId);
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
  if (
    projectContractReceipt
    && input.sourceIdentity.kind === 'revision'
    && projectContractReceipt.sourceRevision !== input.sourceIdentity.revision
  ) {
    throw new Error('ENGINEERING_PROJECT_CONTRACT_SOURCE_DRIFT');
  }
  const receipt: EngineeringContextReceipt = {
    schemaVersion: 1,
    profileVersion: ENGINEERING_WORK_PROFILE_VERSION,
    riskClass: profile.riskClass,
    sourceIdentity: input.sourceIdentity,
    projectContractReceipt,
    evidence: {
      contextClosureReceiptId: evidence.contextClosureReceiptId?.trim() || undefined,
      productDodReceiptId: evidence.productDodReceiptId?.trim() || undefined,
      designDecisionReceiptId: evidence.designDecisionReceiptId?.trim() || undefined,
      independentCritiqueReceiptId: evidence.independentCritiqueReceiptId?.trim() || undefined,
      semanticToolReceiptIds: ids(evidence.semanticToolReceiptIds),
      validationReceiptIds: ids(evidence.validationReceiptIds),
      journeyReceiptIds: ids(evidence.journeyReceiptIds),
      freshReviewReceiptId: evidence.freshReviewReceiptId?.trim() || undefined,
    },
    conditions: {
      semanticToolsRequired: evidence.conditions?.semanticToolsRequired === true,
      realJourneyRequired: evidence.conditions?.realJourneyRequired === true,
    },
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
  if (input.receipt.missingAdmissionEvidence.length > 0) {
    return { allowed: false, code: 'ENGINEERING_ADMISSION_EVIDENCE_REQUIRED', missing: input.receipt.missingAdmissionEvidence };
  }
  return { allowed: true };
}
