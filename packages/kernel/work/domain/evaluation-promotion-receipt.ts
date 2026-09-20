import { createHash } from 'crypto';
import type { WorkImplementationReviewEvidenceIdentity } from './implementation-review';

export const EVALUATION_PROMOTION_RECEIPT_SCHEMA = 'forge-evaluation-promotion-receipt/v1' as const;
export const EVALUATION_PROMOTION_RECEIPT_AUTHORITY = 'evaluation_evidence_only' as const;
export const EVALUATION_CANDIDATE_IDENTITY_SCHEMA = 'forge-candidate-identity/v1' as const;

export interface EvaluationPromotionCandidateIdentity {
  schemaVersion: typeof EVALUATION_CANDIDATE_IDENTITY_SCHEMA;
  candidateId: string;
  versionLabel: string;
  artifactDigest: string;
  sourceRevision?: string;
  executionSurface: 'public_cli' | 'public_mcp';
}

export interface EvaluationPromotionReceipt {
  schemaVersion: typeof EVALUATION_PROMOTION_RECEIPT_SCHEMA;
  authority: typeof EVALUATION_PROMOTION_RECEIPT_AUTHORITY;
  receiptId: string;
  baseline: EvaluationPromotionCandidateIdentity;
  candidate: EvaluationPromotionCandidateIdentity;
  evidence: {
    paired: {
      protocolDigest: string;
      environmentFingerprint: string;
      pairCount: number;
      evidenceDigest: string;
    };
    shadow: {
      protocolDigest: string;
      pairedScenarioCount: number;
      evidenceDigest: string;
    };
    certification?: {
      manifestDigest: string;
    };
  };
}

export type EvaluationPromotionReceiptCore = Omit<EvaluationPromotionReceipt, 'receiptId'>;

function requiredText(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`EVALUATION_PROMOTION_RECEIPT_${field.toUpperCase()}_REQUIRED`);
  return normalized;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`EVALUATION_PROMOTION_RECEIPT_${field.toUpperCase()}_INVALID`);
  }
  return Number(value);
}

function candidateIdentity(value: unknown, field: 'baseline' | 'candidate'): EvaluationPromotionCandidateIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`EVALUATION_PROMOTION_RECEIPT_${field.toUpperCase()}_REQUIRED`);
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== EVALUATION_CANDIDATE_IDENTITY_SCHEMA) {
    throw new Error(`EVALUATION_PROMOTION_RECEIPT_${field.toUpperCase()}_SCHEMA_INVALID`);
  }
  if (input.executionSurface !== 'public_cli' && input.executionSurface !== 'public_mcp') {
    throw new Error(`EVALUATION_PROMOTION_RECEIPT_${field.toUpperCase()}_SURFACE_INVALID`);
  }
  const sourceRevision = typeof input.sourceRevision === 'string' && input.sourceRevision.trim()
    ? input.sourceRevision.trim()
    : undefined;
  return {
    schemaVersion: EVALUATION_CANDIDATE_IDENTITY_SCHEMA,
    candidateId: requiredText(input.candidateId, `${field}_candidate_id`),
    versionLabel: requiredText(input.versionLabel, `${field}_version_label`),
    artifactDigest: requiredText(input.artifactDigest, `${field}_artifact_digest`),
    ...(sourceRevision ? { sourceRevision } : {}),
    executionSurface: input.executionSurface,
  };
}

function receiptCore(value: unknown): EvaluationPromotionReceiptCore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('EVALUATION_PROMOTION_RECEIPT_INVALID');
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== EVALUATION_PROMOTION_RECEIPT_SCHEMA) {
    throw new Error('EVALUATION_PROMOTION_RECEIPT_SCHEMA_INVALID');
  }
  if (input.authority !== EVALUATION_PROMOTION_RECEIPT_AUTHORITY) {
    throw new Error('EVALUATION_PROMOTION_RECEIPT_AUTHORITY_INVALID');
  }
  if (!input.evidence || typeof input.evidence !== 'object' || Array.isArray(input.evidence)) {
    throw new Error('EVALUATION_PROMOTION_RECEIPT_EVIDENCE_REQUIRED');
  }
  const evidence = input.evidence as Record<string, unknown>;
  if (!evidence.paired || typeof evidence.paired !== 'object' || Array.isArray(evidence.paired)) {
    throw new Error('EVALUATION_PROMOTION_RECEIPT_PAIRED_REQUIRED');
  }
  if (!evidence.shadow || typeof evidence.shadow !== 'object' || Array.isArray(evidence.shadow)) {
    throw new Error('EVALUATION_PROMOTION_RECEIPT_SHADOW_REQUIRED');
  }
  const paired = evidence.paired as Record<string, unknown>;
  const shadow = evidence.shadow as Record<string, unknown>;
  let certification: EvaluationPromotionReceipt['evidence']['certification'];
  if (evidence.certification !== undefined) {
    if (!evidence.certification || typeof evidence.certification !== 'object' || Array.isArray(evidence.certification)) {
      throw new Error('EVALUATION_PROMOTION_RECEIPT_CERTIFICATION_INVALID');
    }
    certification = {
      manifestDigest: requiredText(
        (evidence.certification as Record<string, unknown>).manifestDigest,
        'certification_manifest_digest',
      ),
    };
  }
  return {
    schemaVersion: EVALUATION_PROMOTION_RECEIPT_SCHEMA,
    authority: EVALUATION_PROMOTION_RECEIPT_AUTHORITY,
    baseline: candidateIdentity(input.baseline, 'baseline'),
    candidate: candidateIdentity(input.candidate, 'candidate'),
    evidence: {
      paired: {
        protocolDigest: requiredText(paired.protocolDigest, 'paired_protocol_digest'),
        environmentFingerprint: requiredText(paired.environmentFingerprint, 'paired_environment_fingerprint'),
        pairCount: nonNegativeInteger(paired.pairCount, 'paired_pair_count'),
        evidenceDigest: requiredText(paired.evidenceDigest, 'paired_evidence_digest'),
      },
      shadow: {
        protocolDigest: requiredText(shadow.protocolDigest, 'shadow_protocol_digest'),
        pairedScenarioCount: nonNegativeInteger(shadow.pairedScenarioCount, 'shadow_paired_scenario_count'),
        evidenceDigest: requiredText(shadow.evidenceDigest, 'shadow_evidence_digest'),
      },
      ...(certification ? { certification } : {}),
    },
  };
}

function receiptIdentity(core: EvaluationPromotionReceiptCore): string {
  const digest = createHash('sha256')
    .update(EVALUATION_PROMOTION_RECEIPT_SCHEMA)
    .update('\0')
    .update(JSON.stringify(core))
    .digest('hex');
  return `evaluation-promotion:sha256:${digest}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * Identity constructor only. Eligibility authority remains in evaluation/.
 * Callers outside the evaluator must not treat this helper as proof that A/B,
 * shadow, or certification gates ran.
 */
export function buildEvaluationPromotionReceipt(coreInput: EvaluationPromotionReceiptCore): EvaluationPromotionReceipt {
  const core = receiptCore(coreInput);
  return deepFreeze({ ...core, receiptId: receiptIdentity(core) });
}

export function validateEvaluationPromotionReceipt(value: unknown): EvaluationPromotionReceipt {
  const core = receiptCore(value);
  const receiptId = requiredText((value as Record<string, unknown>).receiptId, 'receipt_id');
  const expected = receiptIdentity(core);
  if (receiptId !== expected) throw new Error('EVALUATION_PROMOTION_RECEIPT_ID_INVALID');
  return deepFreeze({ ...core, receiptId });
}

export function evaluationPromotionReceiptArchitectureEvidence(
  value: unknown,
  expectedSourceRevision: string,
): WorkImplementationReviewEvidenceIdentity {
  const receipt = validateEvaluationPromotionReceipt(value);
  const sourceRevision = receipt.candidate.sourceRevision?.trim() ?? '';
  const expected = expectedSourceRevision.trim();
  if (!expected || !sourceRevision || sourceRevision !== expected) {
    throw new Error(`EVALUATION_PROMOTION_RECEIPT_CANDIDATE_SOURCE_MISMATCH: expected=${expected || 'missing'} actual=${sourceRevision || 'missing'}`);
  }
  return {
    evidenceId: receipt.receiptId,
    digest: receipt.receiptId.slice('evaluation-promotion:'.length),
  };
}
