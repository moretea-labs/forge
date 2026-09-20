import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PairedCandidateRun } from './lib/candidate-runner.ts';
import {
  REQUIRED_ARMS,
  REQUIRED_ENGINEERING_TASKS,
  REQUIRED_PLATFORM_EVIDENCE,
  REQUIRED_PLATFORMS,
  V2_CERTIFICATION_SCHEMA,
  type V2CertificationManifest,
} from './lib/certification.ts';
import {
  freezeCandidateIdentity,
  freezeEnvironmentIdentity,
  freezeEvaluationCorpus,
  freezeEvaluationProtocol,
  freezeEvaluatorIdentity,
  evaluationRunIdentity,
  CROSS_VERSION_EVALUATION_AUTHORITY,
  type EvaluationCandidateIdentity,
} from './lib/protocol.ts';
import {
  freezeOperationalShadowProtocol,
  type OperationalShadowPair,
} from './lib/shadow-operational-prior.ts';
import {
  mintEvaluationPromotionReceipt,
  promotionReceiptReference,
} from './lib/promotion-receipt.ts';
import { createRequirement, readRequirement } from '../src/runtime/control-plane/persistence/requirement-store';

const candidateCommit = 'a'.repeat(40);
const baselineCommit = 'b'.repeat(40);
const candidateDigest = `sha256:${'a'.repeat(64)}`;
const baselineDigest = `sha256:${'b'.repeat(64)}`;
const evidenceDigest = `sha256:${'c'.repeat(64)}`;

function candidates(): { baseline: EvaluationCandidateIdentity; candidate: EvaluationCandidateIdentity } {
  return {
    baseline: freezeCandidateIdentity({
      candidateId: 'baseline',
      versionLabel: 'v1.7.2',
      artifactDigest: baselineDigest,
      sourceRevision: baselineCommit,
      executionSurface: 'public_mcp',
    }),
    candidate: freezeCandidateIdentity({
      candidateId: 'candidate',
      versionLabel: 'v2-candidate',
      artifactDigest: candidateDigest,
      sourceRevision: candidateCommit,
      executionSurface: 'public_mcp',
    }),
  };
}

function protocol() {
  return freezeEvaluationProtocol({
    evaluator: freezeEvaluatorIdentity({
      evaluatorVersion: 'promotion-fixture/v1',
      implementationDigest: evidenceDigest,
    }),
    corpus: freezeEvaluationCorpus({
      'scenario-a': 'sha256:scenario-a',
      'scenario-b': 'sha256:scenario-b',
    }),
    trialPolicy: {
      repetitions: 2,
      warmupTrials: 0,
      cacheModes: ['cold'],
      orderPolicy: 'balanced_alternating',
      timeoutMs: 1_000,
    },
    metrics: [
      { id: 'task_correctness', tier: 'correctness_reliability', direction: 'higher_is_better', unit: 'ratio', gate: 'p0_p1_blocking' },
      { id: 'latency_ms', tier: 'performance', direction: 'lower_is_better', unit: 'ms', gate: 'non_blocking', regressionTolerance: 0 },
    ],
    failureTaxonomy: ['candidate_failure', 'candidate_timeout'],
  });
}

function report(scenarioId: string, correctness: number, latencyMs: number) {
  const sourceState = { clean: true, statusDigest: 'clean' };
  return {
    schemaVersion: 'forge-evaluation-report/v1' as const,
    authority: 'candidate_internal_diagnostic' as const,
    generatedAt: '2026-09-20T00:00:00.000Z',
    scenario: {
      id: scenarioId,
      title: scenarioId,
      userIntent: 'promotion receipt fixture',
      groundTruth: { intendedBehavior: [], affectedDomains: [], behavioralInvariants: [], regressionRisks: [] },
    },
    trace: {
      schemaVersion: 'forge-evaluation-trace/v1' as const,
      scenarioId,
      taskInput: 'promotion receipt fixture',
      snapshot: { commit: 'fixture', sourceStateBefore: sourceState, sourceStateAfter: sourceState },
      sandbox: { strategy: 'git-clone-no-local' as const, retained: false },
      contextRetrieval: [],
      inspectedEvidence: [],
      changedFiles: [],
      commands: [{
        kind: 'forge' as const,
        command: 'fixture',
        arguments: [],
        cwd: '/tmp',
        exitCode: 0,
        startedAt: '2026-09-20T00:00:00.000Z',
        durationMs: latencyMs,
        stdout: '',
        stderr: '',
        timedOut: false,
      }],
      checks: [],
      toolInteractions: [],
      finalResult: { status: 'passed' as const, summary: 'passed' },
      validation: [],
    },
    metrics: {
      taskSuccessRate: correctness,
      impactCoverage: null,
      behavioralInvariantSuccess: null,
      regressionReintroductionRate: null,
      changePrecision: null,
      executionLatencyMs: latencyMs,
      executionCpuTimeMs: latencyMs,
      executionPeakRssBytes: 1024,
      toolInteractionCount: 0,
    },
    diagnosis: [],
  };
}

function runs(input: { candidateCorrectness?: number; candidateLatencyMs?: number } = {}): PairedCandidateRun[] {
  const frozen = protocol();
  const { baseline, candidate } = candidates();
  const environment = freezeEnvironmentIdentity({
    os: 'test',
    arch: 'test',
    hardware: 'test',
    runtime: 'test',
    toolchain: { bun: 'test' },
  });
  return (['scenario-a', 'scenario-b'] as const).map((scenarioId) => {
    const trials = Array.from({ length: 2 }, (_, repetition) => ([
      {
        sequence: repetition * 2,
        repetition,
        cacheMode: 'cold' as const,
        candidateIndex: 0 as const,
        runIdentity: evaluationRunIdentity({ protocol: frozen, candidate: baseline, environment }),
        isolation: {} as never,
        warmupCommands: [],
        report: report(scenarioId, 1, 100),
      },
      {
        sequence: (repetition * 2) + 1,
        repetition,
        cacheMode: 'cold' as const,
        candidateIndex: 1 as const,
        runIdentity: evaluationRunIdentity({ protocol: frozen, candidate, environment }),
        isolation: {} as never,
        warmupCommands: [],
        report: report(scenarioId, input.candidateCorrectness ?? 1, input.candidateLatencyMs ?? 80),
      },
    ])).flat();
    return {
      schemaVersion: 'forge-paired-candidate-run/v1' as const,
      authority: CROSS_VERSION_EVALUATION_AUTHORITY,
      protocolDigest: frozen.protocolDigest,
      environmentFingerprint: environment.fingerprint,
      scenarioId,
      candidateIds: [baseline.candidateId, candidate.candidateId] as const,
      orderPolicy: frozen.trialPolicy.orderPolicy,
      trials,
    };
  });
}

function shadowPairs(candidateRevision = candidateCommit, regress = false): OperationalShadowPair[] {
  const measurement = (toolRoundTrips: number, correctnessPassed = true) => ({
    controllerVisibleBytes: 100,
    contextBytes: 80,
    shadowBytes: 0,
    rhContextEvidenceBytes: 50,
    mechanicalRereads: 2,
    toolRoundTrips,
    latencyMs: 100,
    staleNoValueRetrievals: 0,
    correctnessPassed,
  });
  return [
    {
      scenarioId: 'shadow-engineering',
      domainKind: 'engineering',
      candidateRevision,
      cold: measurement(3),
      shadow: measurement(regress ? 4 : 2, !regress),
    },
    {
      scenarioId: 'shadow-non-engineering',
      domainKind: 'non_engineering',
      candidateRevision,
      cold: measurement(3),
      shadow: measurement(2),
    },
  ];
}

function certification(pairedProtocolDigest: string, noGo = false): V2CertificationManifest {
  const passEvidence = () => ({ status: 'pass' as const, receiptDigest: evidenceDigest });
  return {
    schemaVersion: V2_CERTIFICATION_SCHEMA,
    candidate: { sourceRevision: candidateCommit, artifactDigest: candidateDigest, versionLabel: 'v2-candidate' },
    baseline: { sourceRevision: baselineCommit, artifactDigest: baselineDigest, versionLabel: 'v1.7.2' },
    integrated: { threeStep: passEvidence(), failureFencing: passEvidence() },
    platforms: Object.fromEntries(REQUIRED_PLATFORMS.map((platform) => [platform, {
      evidence: Object.fromEntries(REQUIRED_PLATFORM_EVIDENCE.map((kind) => [kind, passEvidence()])),
      engineering: Object.fromEntries(REQUIRED_ARMS.map((arm) => [arm, Object.fromEntries(
        REQUIRED_ENGINEERING_TASKS.map((task) => [task, { repetitions: 2, passed: 2, receiptDigest: evidenceDigest }]),
      )])),
    }])) as V2CertificationManifest['platforms'],
    quality: { openP0P1: noGo ? 1 : 0, candidateRegressions: 0 },
    performance: {
      confidenceLevel: 0.95,
      platforms: Object.fromEntries(REQUIRED_PLATFORMS.map((platform) => [platform, {
        coreRegressionRatio: 0.05,
        discoveryBoundedMutationImprovementRatio: 0.2,
        evidenceDigest,
      }])) as V2CertificationManifest['performance']['platforms'],
    },
    ab: {
      manifestDigest: evidenceDigest,
      protocolDigest: pairedProtocolDigest,
      verdict: 'go',
      failures: 0,
      timeouts: 0,
    },
  };
}

function promotionInput(options: { pairedRegression?: boolean; shadowRegression?: boolean; certificationNoGo?: boolean } = {}) {
  const frozen = protocol();
  const { baseline, candidate } = candidates();
  const shadowProtocol = freezeOperationalShadowProtocol({
    candidateRevision: candidate.sourceRevision!,
    heldOutScenarioIds: ['shadow-engineering', 'shadow-non-engineering'],
  });
  return {
    baseline,
    candidate,
    paired: {
      protocol: frozen,
      runs: runs({
        candidateCorrectness: options.pairedRegression ? 0 : 1,
        candidateLatencyMs: 80,
      }),
    },
    shadow: {
      protocol: shadowProtocol,
      pairs: shadowPairs(candidate.sourceRevision!, options.shadowRegression),
    },
    certification: certification(frozen.protocolDigest, options.certificationNoGo),
  };
}

describe('evaluation promotion receipt', () => {
  test('mints one deterministic evidence-only receipt from passing existing evaluators', () => {
    const first = mintEvaluationPromotionReceipt(promotionInput());
    const second = mintEvaluationPromotionReceipt(promotionInput());
    const reordered = promotionInput();
    reordered.paired.runs = [...reordered.paired.runs].reverse().map((run) => ({
      ...run,
      trials: [...run.trials].reverse(),
    }));
    reordered.shadow.pairs = [...reordered.shadow.pairs].reverse();
    const sameEvidenceDifferentOrder = mintEvaluationPromotionReceipt(reordered);
    expect(first).toEqual(second);
    expect(sameEvidenceDifferentOrder.receiptId).toBe(first.receiptId);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.authority).toBe('evaluation_evidence_only');
    expect(first.receiptId).toMatch(/^evaluation-promotion:sha256:[0-9a-f]{64}$/);
    expect(first.evidence.certification?.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(promotionReceiptReference(first)).toBe(first.receiptId);
  });

  test('fails closed on regressed or inconclusive evidence instead of minting promotion authority', () => {
    expect(() => mintEvaluationPromotionReceipt(promotionInput({ pairedRegression: true })))
      .toThrow(/EVALUATION_PROMOTION_PAIRED_/);
    expect(() => mintEvaluationPromotionReceipt(promotionInput({ shadowRegression: true })))
      .toThrow('EVALUATION_PROMOTION_SHADOW_NOT_ELIGIBLE');
    expect(() => mintEvaluationPromotionReceipt(promotionInput({ certificationNoGo: true })))
      .toThrow('EVALUATION_PROMOTION_CERTIFICATION_NOT_ELIGIBLE');
  });

  test('binds the receipt to exact candidate identity and paired protocol', () => {
    const input = promotionInput();
    input.candidate = freezeCandidateIdentity({ ...input.candidate, artifactDigest: `sha256:${'d'.repeat(64)}` });
    expect(() => mintEvaluationPromotionReceipt(input)).toThrow('EVALUATION_PROMOTION_CANDIDATE_IDENTITY_MISMATCH');

    const mismatched = promotionInput();
    mismatched.certification = { ...mismatched.certification, ab: { ...mismatched.certification.ab, protocolDigest: evidenceDigest } };
    expect(() => mintEvaluationPromotionReceipt(mismatched)).toThrow('EVALUATION_PROMOTION_CERTIFICATION_PROTOCOL_MISMATCH');
  });

  test('feeds normal Requirement evidence by reference without creating a second lifecycle authority', () => {
    const receipt = mintEvaluationPromotionReceipt(promotionInput());
    const home = mkdtempSync(join(tmpdir(), 'forge-promotion-requirement-'));
    try {
      const requirement = createRequirement({ controllerHome: home }, {
        requirementId: 'REQ-evaluated-strategy-change',
        title: 'Apply evaluated strategy change',
        outcomeStatement: 'The evaluated change proceeds through normal Requirement, Plan and Work authority.',
        requiredDeliveryReferences: [promotionReceiptReference(receipt)],
      });
      expect(requirement.requiredDeliveryReferences).toEqual([receipt.receiptId]);
      expect(readRequirement({ controllerHome: home }, requirement.requirementId)?.value.state).toBe('planned');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
