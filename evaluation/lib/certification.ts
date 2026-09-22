import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const V2_CERTIFICATION_SCHEMA = 'forge-v2-candidate-certification/v1' as const;
export const REQUIRED_ENGINEERING_TASKS = [
  'cross-file-bug-fix-1',
  'cross-file-bug-fix-2',
  'feature-with-failure-path-1',
  'feature-with-failure-path-2',
  'compatible-refactor',
  'interrupted-multi-stage-task',
] as const;
export const REQUIRED_PLATFORMS = ['macos', 'wsl'] as const;
export const REQUIRED_ARMS = ['baseline', 'candidate'] as const;
export const REQUIRED_PLATFORM_EVIDENCE = ['install', 'upgrade', 'rollback', 'stability24h', 'cycles20'] as const;

export type CertificationPlatform = typeof REQUIRED_PLATFORMS[number];
export type CertificationArm = typeof REQUIRED_ARMS[number];
export type CertificationTask = typeof REQUIRED_ENGINEERING_TASKS[number];
export type CertificationPlatformEvidence = typeof REQUIRED_PLATFORM_EVIDENCE[number];

export interface CertificationEvidenceRef {
  status: 'pass' | 'fail' | 'missing';
  receiptDigest?: string;
  note?: string;
}

export interface CertificationPlatformReport {
  evidence: Record<CertificationPlatformEvidence, CertificationEvidenceRef>;
  engineering: Record<CertificationArm, Record<CertificationTask, {
    repetitions: number;
    passed: number;
    receiptDigest?: string;
  }>>;
}

export interface V2CertificationManifest {
  schemaVersion: typeof V2_CERTIFICATION_SCHEMA;
  candidate: { sourceRevision: string; artifactDigest: string; versionLabel: string };
  baseline: { sourceRevision: string; artifactDigest: string; versionLabel: string };
  integrated: {
    threeStep: CertificationEvidenceRef;
    failureFencing: CertificationEvidenceRef;
  };
  platforms: Record<CertificationPlatform, CertificationPlatformReport>;
  quality: { openP0P1: number; candidateRegressions: number };
  performance: {
    confidenceLevel: number;
    platforms: Record<CertificationPlatform, {
      coreRegressionRatio: number;
      discoveryBoundedMutationImprovementRatio: number;
      evidenceDigest?: string;
    }>;
  };
  ab: {
    manifestDigest: string;
    protocolDigest: string;
    verdict: 'go' | 'no_go' | 'inconclusive_missing_metrics';
    failures: number;
    timeouts: number;
  };
}

export interface CertificationResult {
  verdict: 'go' | 'no_go';
  blockers: string[];
  warnings: string[];
  manifestDigest: string;
}

const digestPattern = /^sha256:[0-9a-f]{64}$/i;
const commitPattern = /^[0-9a-f]{40,64}$/i;

function fail(message: string): never {
  throw new Error(`V2_CERTIFICATION_INVALID: ${message}`);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${field} is required`);
  return value.trim();
}

function digest(value: unknown, field: string): string {
  const normalized = requiredText(value, field);
  if (!digestPattern.test(normalized)) fail(`${field} must be sha256:<64 hex characters>`);
  return normalized;
}

function commit(value: unknown, field: string): string {
  const normalized = requiredText(value, field);
  if (!commitPattern.test(normalized)) fail(`${field} must be an immutable Git commit id`);
  return normalized;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${field} must be finite`);
  return value;
}

function evidence(value: unknown, field: string): CertificationEvidenceRef {
  if (!value || typeof value !== 'object') fail(`${field} is required`);
  const entry = value as Record<string, unknown>;
  const status = entry.status;
  if (status !== 'pass' && status !== 'fail' && status !== 'missing') fail(`${field}.status is invalid`);
  const result: CertificationEvidenceRef = { status };
  if (entry.receiptDigest !== undefined) result.receiptDigest = digest(entry.receiptDigest, `${field}.receiptDigest`);
  if (status === 'pass' && !result.receiptDigest) fail(`${field}.receiptDigest is required for pass`);
  if (entry.note !== undefined) result.note = requiredText(entry.note, `${field}.note`);
  return result;
}

function taskResult(value: unknown, field: string): CertificationPlatformReport['engineering'][CertificationArm][CertificationTask] {
  if (!value || typeof value !== 'object') fail(`${field} is required`);
  const entry = value as Record<string, unknown>;
  const repetitions = finite(entry.repetitions, `${field}.repetitions`);
  const passed = finite(entry.passed, `${field}.passed`);
  if (!Number.isInteger(repetitions) || repetitions < 2) fail(`${field}.repetitions must be an integer >= 2`);
  if (!Number.isInteger(passed) || passed < 0 || passed > repetitions) fail(`${field}.passed must be an integer between 0 and repetitions`);
  const result = { repetitions, passed } as CertificationPlatformReport['engineering'][CertificationArm][CertificationTask];
  if (entry.receiptDigest !== undefined) result.receiptDigest = digest(entry.receiptDigest, `${field}.receiptDigest`);
  if (passed === repetitions && !result.receiptDigest) fail(`${field}.receiptDigest is required for a passing task result`);
  return result;
}

function platformReport(value: unknown, platform: CertificationPlatform): CertificationPlatformReport {
  if (!value || typeof value !== 'object') fail(`platforms.${platform} is required`);
  const entry = value as Record<string, unknown>;
  const rawEvidence = entry.evidence;
  if (!rawEvidence || typeof rawEvidence !== 'object') fail(`platforms.${platform}.evidence is required`);
  const evidenceMap = {} as Record<CertificationPlatformEvidence, CertificationEvidenceRef>;
  for (const kind of REQUIRED_PLATFORM_EVIDENCE) evidenceMap[kind] = evidence((rawEvidence as Record<string, unknown>)[kind], `platforms.${platform}.evidence.${kind}`);

  const rawEngineering = entry.engineering;
  if (!rawEngineering || typeof rawEngineering !== 'object') fail(`platforms.${platform}.engineering is required`);
  const engineering = {} as CertificationPlatformReport['engineering'];
  for (const arm of REQUIRED_ARMS) {
    const rawArm = (rawEngineering as Record<string, unknown>)[arm];
    if (!rawArm || typeof rawArm !== 'object') fail(`platforms.${platform}.engineering.${arm} is required`);
    engineering[arm] = {} as CertificationPlatformReport['engineering'][CertificationArm];
    for (const task of REQUIRED_ENGINEERING_TASKS) {
      engineering[arm][task] = taskResult((rawArm as Record<string, unknown>)[task], `platforms.${platform}.engineering.${arm}.${task}`);
    }
  }
  return { evidence: evidenceMap, engineering };
}

export function parseV2CertificationManifest(raw: unknown): V2CertificationManifest {
  if (!raw || typeof raw !== 'object') fail('manifest must be an object');
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== V2_CERTIFICATION_SCHEMA) fail(`schemaVersion must equal ${V2_CERTIFICATION_SCHEMA}`);
  const identity = (input: unknown, field: 'candidate' | 'baseline') => {
    if (!input || typeof input !== 'object') fail(`${field} is required`);
    const entry = input as Record<string, unknown>;
    return {
      sourceRevision: commit(entry.sourceRevision, `${field}.sourceRevision`),
      artifactDigest: digest(entry.artifactDigest, `${field}.artifactDigest`),
      versionLabel: requiredText(entry.versionLabel, `${field}.versionLabel`),
    };
  };
  if (!value.integrated || typeof value.integrated !== 'object') fail('integrated is required');
  const integrated = value.integrated as Record<string, unknown>;
  if (!value.platforms || typeof value.platforms !== 'object') fail('platforms is required');
  const platforms = value.platforms as Record<string, unknown>;
  const platformReports = {} as Record<CertificationPlatform, CertificationPlatformReport>;
  for (const platform of REQUIRED_PLATFORMS) platformReports[platform] = platformReport(platforms[platform], platform);

  if (!value.quality || typeof value.quality !== 'object') fail('quality is required');
  const qualityValue = value.quality as Record<string, unknown>;
  const quality = { openP0P1: finite(qualityValue.openP0P1, 'quality.openP0P1'), candidateRegressions: finite(qualityValue.candidateRegressions, 'quality.candidateRegressions') };
  if (![quality.openP0P1, quality.candidateRegressions].every((n) => Number.isInteger(n) && n >= 0)) fail('quality counts must be non-negative integers');

  if (!value.performance || typeof value.performance !== 'object') fail('performance is required');
  const performanceValue = value.performance as Record<string, unknown>;
  const confidenceLevel = finite(performanceValue.confidenceLevel, 'performance.confidenceLevel');
  if (confidenceLevel !== 0.95) fail('performance.confidenceLevel must be 0.95');
  const rawPerformancePlatforms = performanceValue.platforms;
  if (!rawPerformancePlatforms || typeof rawPerformancePlatforms !== 'object') fail('performance.platforms is required');
  const performancePlatforms = {} as V2CertificationManifest['performance']['platforms'];
  for (const platform of REQUIRED_PLATFORMS) {
    const entry = (rawPerformancePlatforms as Record<string, unknown>)[platform];
    if (!entry || typeof entry !== 'object') fail(`performance.platforms.${platform} is required`);
    const record = entry as Record<string, unknown>;
    const coreRegressionRatio = finite(record.coreRegressionRatio, `performance.platforms.${platform}.coreRegressionRatio`);
    const discoveryBoundedMutationImprovementRatio = finite(record.discoveryBoundedMutationImprovementRatio, `performance.platforms.${platform}.discoveryBoundedMutationImprovementRatio`);
    if (coreRegressionRatio < 0 || discoveryBoundedMutationImprovementRatio < -1 || discoveryBoundedMutationImprovementRatio > 1) fail(`performance.platforms.${platform} ratios are out of range`);
    performancePlatforms[platform] = { coreRegressionRatio, discoveryBoundedMutationImprovementRatio };
    if (record.evidenceDigest !== undefined) performancePlatforms[platform].evidenceDigest = digest(record.evidenceDigest, `performance.platforms.${platform}.evidenceDigest`);
  }

  if (!value.ab || typeof value.ab !== 'object') fail('ab is required');
  const abValue = value.ab as Record<string, unknown>;
  const verdict = abValue.verdict;
  if (verdict !== 'go' && verdict !== 'no_go' && verdict !== 'inconclusive_missing_metrics') fail('ab.verdict is invalid');
  const failures = finite(abValue.failures, 'ab.failures');
  const timeouts = finite(abValue.timeouts, 'ab.timeouts');
  if (![failures, timeouts].every((n) => Number.isInteger(n) && n >= 0)) fail('ab failures/timeouts must be non-negative integers');
  const candidate = identity(value.candidate, 'candidate');
  const baseline = identity(value.baseline, 'baseline');
  if (candidate.sourceRevision === baseline.sourceRevision && candidate.artifactDigest === baseline.artifactDigest) fail('candidate and baseline identities must differ');
  return {
    schemaVersion: V2_CERTIFICATION_SCHEMA,
    candidate,
    baseline,
    integrated: { threeStep: evidence(integrated.threeStep, 'integrated.threeStep'), failureFencing: evidence(integrated.failureFencing, 'integrated.failureFencing') },
    platforms: platformReports,
    quality,
    performance: { confidenceLevel, platforms: performancePlatforms },
    ab: { manifestDigest: digest(abValue.manifestDigest, 'ab.manifestDigest'), protocolDigest: digest(abValue.protocolDigest, 'ab.protocolDigest'), verdict, failures, timeouts },
  };
}

function manifestDigest(value: V2CertificationManifest): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export function evaluateV2Certification(value: V2CertificationManifest): CertificationResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (value.ab.verdict !== 'go') blockers.push(`ab.verdict=${value.ab.verdict}`);
  if (value.ab.failures !== 0) blockers.push(`ab.failures=${value.ab.failures}`);
  if (value.ab.timeouts !== 0) blockers.push(`ab.timeouts=${value.ab.timeouts}`);
  if (value.quality.openP0P1 !== 0) blockers.push(`quality.openP0P1=${value.quality.openP0P1}`);
  if (value.quality.candidateRegressions !== 0) blockers.push(`quality.candidateRegressions=${value.quality.candidateRegressions}`);
  if (value.integrated.threeStep.status !== 'pass') blockers.push(`integrated.threeStep=${value.integrated.threeStep.status}`);
  if (value.integrated.failureFencing.status !== 'pass') blockers.push(`integrated.failureFencing=${value.integrated.failureFencing.status}`);
  for (const platform of REQUIRED_PLATFORMS) {
    const report = value.platforms[platform];
    for (const kind of REQUIRED_PLATFORM_EVIDENCE) if (report.evidence[kind].status !== 'pass') blockers.push(`platforms.${platform}.evidence.${kind}=${report.evidence[kind].status}`);
    for (const arm of REQUIRED_ARMS) for (const task of REQUIRED_ENGINEERING_TASKS) {
      const result = report.engineering[arm][task];
      if (result.repetitions !== 2 || result.passed !== 2) blockers.push(`platforms.${platform}.engineering.${arm}.${task}=${result.passed}/${result.repetitions}`);
    }
    const perf = value.performance.platforms[platform];
    if (perf.coreRegressionRatio > 0.10) blockers.push(`performance.${platform}.coreRegressionRatio=${perf.coreRegressionRatio}`);
    if (perf.discoveryBoundedMutationImprovementRatio < 0.15) blockers.push(`performance.${platform}.discoveryBoundedMutationImprovementRatio=${perf.discoveryBoundedMutationImprovementRatio}`);
    if (!perf.evidenceDigest) blockers.push(`performance.${platform}.evidenceDigest=missing`);
  }
  return { verdict: blockers.length === 0 ? 'go' : 'no_go', blockers, warnings, manifestDigest: manifestDigest(value) };
}

export function readAndEvaluateV2Certification(path: string): CertificationResult {
  const parsed = parseV2CertificationManifest(JSON.parse(readFileSync(path, 'utf8')));
  return evaluateV2Certification(parsed);
}
