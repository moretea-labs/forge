import { describe, expect, test } from 'bun:test';
import {
  REQUIRED_ENGINEERING_TASKS,
  REQUIRED_PLATFORM_EVIDENCE,
  REQUIRED_PLATFORMS,
  REQUIRED_ARMS,
  V2_CERTIFICATION_SCHEMA,
  evaluateV2Certification,
  parseV2CertificationManifest,
} from './lib/certification.ts';

const digest = `sha256:${'a'.repeat(64)}`;
const commit = 'a'.repeat(40);
const baselineDigest = `sha256:${'b'.repeat(64)}`;
const baselineCommit = 'b'.repeat(40);

function passEvidence() {
  return { status: 'pass' as const, receiptDigest: digest };
}

function manifest(): any {
  const platforms = Object.fromEntries(REQUIRED_PLATFORMS.map((platform) => [platform, {
    evidence: Object.fromEntries(REQUIRED_PLATFORM_EVIDENCE.map((kind) => [kind, passEvidence()])),
    engineering: Object.fromEntries(REQUIRED_ARMS.map((arm) => [arm, Object.fromEntries(REQUIRED_ENGINEERING_TASKS.map((task) => [task, { repetitions: 2, passed: 2, receiptDigest: digest }]))])),
  }]));
  return {
    schemaVersion: V2_CERTIFICATION_SCHEMA,
    candidate: { sourceRevision: commit, artifactDigest: digest, versionLabel: 'v2-candidate' },
    baseline: { sourceRevision: baselineCommit, artifactDigest: baselineDigest, versionLabel: 'v1.7.2' },
    integrated: { threeStep: passEvidence(), failureFencing: passEvidence() },
    platforms,
    quality: { openP0P1: 0, candidateRegressions: 0 },
    performance: {
      confidenceLevel: 0.95,
      platforms: Object.fromEntries(REQUIRED_PLATFORMS.map((platform) => [platform, {
        coreRegressionRatio: 0.05,
        discoveryBoundedMutationImprovementRatio: 0.2,
        evidenceDigest: digest,
      }])),
    },
    ab: { manifestDigest: digest, protocolDigest: digest, verdict: 'go' as const, failures: 0, timeouts: 0 },
  };
}

describe('V2 candidate certification evidence', () => {
  test('accepts a complete evidence manifest and returns Go', () => {
    const parsed = parseV2CertificationManifest(manifest());
    const result = evaluateV2Certification(parsed);
    expect(result.verdict).toBe('go');
    expect(result.blockers).toEqual([]);
  });

  test('fails closed when A/B is inconclusive or a required platform receipt is missing', () => {
    const input = manifest();
    input.ab.verdict = 'inconclusive_missing_metrics';
    input.platforms.wsl.evidence.rollback = { status: 'missing' };
    const result = evaluateV2Certification(parseV2CertificationManifest(input));
    expect(result.verdict).toBe('no_go');
    expect(result.blockers).toContain('ab.verdict=inconclusive_missing_metrics');
    expect(result.blockers).toContain('platforms.wsl.evidence.rollback=missing');
  });

  test('rejects invented or malformed identities before evaluating evidence', () => {
    const input = manifest();
    input.candidate.artifactDigest = 'not-a-digest';
    expect(() => parseV2CertificationManifest(input)).toThrow('candidate.artifactDigest must be sha256:<64 hex characters>');
  });

  test('does not allow an unreceipted pass to become release evidence', () => {
    const input = manifest();
    delete input.platforms.macos.evidence.upgrade.receiptDigest;
    expect(() => parseV2CertificationManifest(input)).toThrow('platforms.macos.evidence.upgrade.receiptDigest is required for pass');
  });
});
