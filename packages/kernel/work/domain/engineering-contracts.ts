export const ENGINEERING_WORK_PROFILE_VERSION = 'engineering-work-profile-v1' as const;
export const ENGINEERING_RISK_CLASSES = ['low', 'normal', 'high', 'critical'] as const;
export type EngineeringRiskClass = (typeof ENGINEERING_RISK_CLASSES)[number];
export const ENGINEERING_EVIDENCE_KINDS = [
  'project_contract',
  'context_closure',
  'product_dod',
  'design_decision',
  'independent_critique',
  'semantic_tools',
  'focused_validation',
  'real_journey',
  'fresh_review',
] as const;
export type EngineeringEvidenceKind = (typeof ENGINEERING_EVIDENCE_KINDS)[number];
export type EngineeringEvidenceRequirement = 'required' | 'conditional' | 'optional';

/** Exact source-bound reference persisted on Work; the project file remains authority. */
export interface ProjectEngineeringContractReceipt {
  schemaVersion: 1;
  contractPath: string;
  projectId: string;
  contractId: string;
  contractVersion: string;
  sourceRevision: string;
  contentDigest: string;
  provenance: {
    source: 'repository';
    loadedAt: string;
  };
}

export interface EngineeringAdmissionEvidence {
  projectContractReceipt?: ProjectEngineeringContractReceipt;
  contextClosureReceiptId?: string;
  productDodReceiptId?: string;
  designDecisionReceiptId?: string;
  independentCritiqueReceiptId?: string;
  semanticToolReceiptIds?: string[];
  validationReceiptIds?: string[];
  journeyReceiptIds?: string[];
  freshReviewReceiptId?: string;
  conditions?: {
    semanticToolsRequired?: boolean;
    realJourneyRequired?: boolean;
  };
}

export interface EngineeringContextReceipt {
  schemaVersion: 1;
  profileVersion: typeof ENGINEERING_WORK_PROFILE_VERSION;
  riskClass: EngineeringRiskClass;
  sourceIdentity: { kind: 'revision'; revision: string } | { kind: 'unborn' } | { kind: 'unknown' };
  projectContractReceipt?: ProjectEngineeringContractReceipt;
  evidence: {
    contextClosureReceiptId?: string;
    productDodReceiptId?: string;
    designDecisionReceiptId?: string;
    independentCritiqueReceiptId?: string;
    semanticToolReceiptIds: string[];
    validationReceiptIds: string[];
    journeyReceiptIds: string[];
    freshReviewReceiptId?: string;
  };
  conditions: {
    semanticToolsRequired: boolean;
    realJourneyRequired: boolean;
  };
  missingAdmissionEvidence: EngineeringEvidenceKind[];
  missingCompletionEvidence: EngineeringEvidenceKind[];
  recordedAt: string;
}
