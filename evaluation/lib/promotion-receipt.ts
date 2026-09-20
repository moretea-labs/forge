import { createHash } from 'node:crypto';
import {
  buildEvaluationPromotionReceipt,
  validateEvaluationPromotionReceipt,
  type EvaluationPromotionReceipt,
} from '../../packages/kernel/work/api/index.ts';
import {
  buildCrossVersionPairedStatistics,
  type CrossVersionPairedStatistics,
} from './metrics.ts';
import {
  freezeCandidateIdentity,
  type EvaluationCandidateIdentity,
  type FrozenEvaluationProtocol,
} from './protocol.ts';
import type { PairedCandidateRun } from './candidate-runner.ts';
import {
  evaluateOperationalShadowPairs,
  type FrozenOperationalShadowProtocol,
  type OperationalShadowEvaluationReport,
  type OperationalShadowPair,
} from './shadow-operational-prior.ts';
import {
  evaluateV2Certification,
  parseV2CertificationManifest,
  type V2CertificationManifest,
} from './certification.ts';

export type { EvaluationPromotionReceipt } from '../../packages/kernel/work/api/index.ts';

export interface EvaluationPromotionInput {
  baseline: EvaluationCandidateIdentity;
  candidate: EvaluationCandidateIdentity;
  paired: {
    protocol: FrozenEvaluationProtocol;
    runs: readonly PairedCandidateRun[];
  };
  shadow: {
    protocol: FrozenOperationalShadowProtocol;
    pairs: readonly OperationalShadowPair[];
  };
  /**
   * Release-level candidates may add V2 certification as a stronger gate.
   * Strategy candidates are not forced through release install/rollback evidence.
   * When supplied, certification is blocking and identity-bound.
   */
  certification?: V2CertificationManifest;
}

function digest(label: string, value: unknown): string {
  return `sha256:${createHash('sha256').update(label).update('\0').update(JSON.stringify(value)).digest('hex')}`;
}

function canonicalPairedEvidence(runs: readonly PairedCandidateRun[]): unknown {
  return [...runs]
    .sort((left, right) => left.scenarioId.localeCompare(right.scenarioId))
    .map((run) => ({
      ...run,
      trials: [...run.trials].sort((left, right) =>
        left.cacheMode.localeCompare(right.cacheMode)
        || left.repetition - right.repetition
        || left.candidateIndex - right.candidateIndex),
    }));
}

function canonicalShadowEvidence(pairs: readonly OperationalShadowPair[]): unknown {
  return [...pairs].sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function candidateKey(value: EvaluationCandidateIdentity): string {
  return JSON.stringify(freezeCandidateIdentity({
    candidateId: value.candidateId,
    versionLabel: value.versionLabel,
    artifactDigest: value.artifactDigest,
    sourceRevision: value.sourceRevision,
    executionSurface: value.executionSurface,
  }));
}

function observedCandidate(
  runs: readonly PairedCandidateRun[],
  candidateIndex: 0 | 1,
): EvaluationCandidateIdentity {
  let observed: EvaluationCandidateIdentity | undefined;
  let observedKey: string | undefined;
  for (const run of runs) {
    for (const trial of run.trials) {
      if (trial.candidateIndex !== candidateIndex) continue;
      const candidate = freezeCandidateIdentity(trial.runIdentity.candidate);
      const key = candidateKey(candidate);
      if (observedKey !== undefined && observedKey !== key) {
        throw new Error(`EVALUATION_PROMOTION_PAIRED_IDENTITY_AMBIGUOUS:${candidateIndex}`);
      }
      observed = candidate;
      observedKey = key;
    }
  }
  if (!observed) throw new Error(`EVALUATION_PROMOTION_PAIRED_IDENTITY_MISSING:${candidateIndex}`);
  return observed;
}

function assertIdentity(expected: EvaluationCandidateIdentity, observed: EvaluationCandidateIdentity, label: string): void {
  if (candidateKey(expected) !== candidateKey(observed)) {
    throw new Error(`EVALUATION_PROMOTION_${label.toUpperCase()}_IDENTITY_MISMATCH`);
  }
}

function assertPairedEligible(statistics: CrossVersionPairedStatistics): void {
  if (statistics.verdict.status !== 'eligible_for_superiority_assessment') {
    throw new Error(`EVALUATION_PROMOTION_PAIRED_NOT_ELIGIBLE:${statistics.verdict.status}`);
  }
  if (statistics.verdict.newlyIntroducedFailureCount !== 0 || statistics.verdict.newlyIntroducedTimeoutCount !== 0) {
    throw new Error('EVALUATION_PROMOTION_PAIRED_NEW_FAILURE');
  }
  const regressed = Object.values(statistics.tiers)
    .filter((tier) => tier.status === 'regressed')
    .map((tier) => tier.tier)
    .sort();
  if (regressed.length > 0) {
    throw new Error(`EVALUATION_PROMOTION_PAIRED_REGRESSION:${regressed.join(',')}`);
  }
}

function assertShadowEligible(
  candidate: EvaluationCandidateIdentity,
  protocol: FrozenOperationalShadowProtocol,
  report: OperationalShadowEvaluationReport,
): void {
  if (!candidate.sourceRevision) throw new Error('EVALUATION_PROMOTION_CANDIDATE_SOURCE_REVISION_REQUIRED');
  if (protocol.candidateRevision !== candidate.sourceRevision || report.candidateRevision !== candidate.sourceRevision) {
    throw new Error('EVALUATION_PROMOTION_SHADOW_CANDIDATE_MISMATCH');
  }
  if (!report.passed) throw new Error('EVALUATION_PROMOTION_SHADOW_NOT_ELIGIBLE');
}

function assertCertificationIdentity(
  baseline: EvaluationCandidateIdentity,
  candidate: EvaluationCandidateIdentity,
  manifest: V2CertificationManifest,
): string {
  if (!baseline.sourceRevision || !candidate.sourceRevision) {
    throw new Error('EVALUATION_PROMOTION_CERTIFICATION_SOURCE_REVISION_REQUIRED');
  }
  if (
    manifest.baseline.sourceRevision !== baseline.sourceRevision
    || manifest.baseline.artifactDigest !== baseline.artifactDigest
    || manifest.baseline.versionLabel !== baseline.versionLabel
  ) {
    throw new Error('EVALUATION_PROMOTION_CERTIFICATION_BASELINE_MISMATCH');
  }
  if (
    manifest.candidate.sourceRevision !== candidate.sourceRevision
    || manifest.candidate.artifactDigest !== candidate.artifactDigest
    || manifest.candidate.versionLabel !== candidate.versionLabel
  ) {
    throw new Error('EVALUATION_PROMOTION_CERTIFICATION_CANDIDATE_MISMATCH');
  }
  const result = evaluateV2Certification(manifest);
  if (result.verdict !== 'go') {
    throw new Error(`EVALUATION_PROMOTION_CERTIFICATION_NOT_ELIGIBLE:${result.blockers.join(',')}`);
  }
  return result.manifestDigest;
}

/**
 * Produce an immutable evidence receipt only after existing evaluators pass.
 *
 * The receipt is not a lifecycle or policy authority. It cannot mutate source,
 * Cognitive memory, Requirement, Plan, or Work. Callers that want to act on the
 * evidence must carry receiptId into an existing authority such as
 * Requirement.requiredDeliveryReferences.
 */
export function mintEvaluationPromotionReceipt(input: EvaluationPromotionInput): EvaluationPromotionReceipt {
  const baseline = freezeCandidateIdentity(input.baseline);
  const candidate = freezeCandidateIdentity(input.candidate);
  if (candidateKey(baseline) === candidateKey(candidate)) throw new Error('EVALUATION_PROMOTION_CANDIDATES_MUST_DIFFER');

  const pairedStatistics = buildCrossVersionPairedStatistics({
    protocol: input.paired.protocol,
    runs: input.paired.runs,
  });
  assertIdentity(baseline, observedCandidate(input.paired.runs, 0), 'baseline');
  assertIdentity(candidate, observedCandidate(input.paired.runs, 1), 'candidate');
  if (pairedStatistics.baselineCandidateId !== baseline.candidateId || pairedStatistics.candidateId !== candidate.candidateId) {
    throw new Error('EVALUATION_PROMOTION_PAIRED_CANDIDATE_SET_MISMATCH');
  }
  assertPairedEligible(pairedStatistics);

  const shadowReport = evaluateOperationalShadowPairs(input.shadow.protocol, input.shadow.pairs);
  assertShadowEligible(candidate, input.shadow.protocol, shadowReport);

  let certificationManifestDigest: string | undefined;
  if (input.certification !== undefined) {
    const certification = parseV2CertificationManifest(input.certification);
    if (certification.ab.protocolDigest !== input.paired.protocol.protocolDigest) {
      throw new Error('EVALUATION_PROMOTION_CERTIFICATION_PROTOCOL_MISMATCH');
    }
    certificationManifestDigest = assertCertificationIdentity(baseline, candidate, certification);
  }

  return buildEvaluationPromotionReceipt({
    schemaVersion: 'forge-evaluation-promotion-receipt/v1',
    authority: 'evaluation_evidence_only',
    baseline,
    candidate,
    evidence: {
      paired: {
        protocolDigest: pairedStatistics.protocolDigest,
        environmentFingerprint: pairedStatistics.environmentFingerprint,
        pairCount: pairedStatistics.pairCount,
        evidenceDigest: digest('forge-paired-promotion-evidence/v1', {
          statistics: pairedStatistics,
          runs: canonicalPairedEvidence(input.paired.runs),
        }),
      },
      shadow: {
        protocolDigest: shadowReport.protocolDigest,
        pairedScenarioCount: shadowReport.pairedScenarioCount,
        evidenceDigest: digest('forge-operational-shadow-promotion-evidence/v1', {
          report: shadowReport,
          pairs: canonicalShadowEvidence(input.shadow.pairs),
        }),
      },
      ...(certificationManifestDigest ? {
        certification: { manifestDigest: certificationManifestDigest },
      } : {}),
    },
  });
}

export function promotionReceiptReference(receipt: EvaluationPromotionReceipt): string {
  return validateEvaluationPromotionReceipt(receipt).receiptId;
}
