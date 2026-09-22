import type { ScopeRef } from '../../identity/api/index';

export interface ExperienceApplicability { channel?: string; account?: string; locale?: string }
export interface ExperienceRecord {
  schemaVersion: 1;
  id: string;
  revision: number;
  scope: ScopeRef;
  applicability: ExperienceApplicability;
  kind: 'observation' | 'hypothesis' | 'lesson';
  statement: string;
  evidenceRefs: string[];
  sourceWorkId: string;
  sourceRoundId: string;
  recordedAt: string;
  expiresAt?: string;
  durableRationale?: string;
  supersedesId?: string;
  counterEvidenceRefs: string[];
  retractedAt?: string;
  retractionReason?: string;
  retractionSourceWorkId?: string;
  retractionSourceRoundId?: string;
}

export type ExperienceDraft = Omit<ExperienceRecord, 'schemaVersion' | 'revision' | 'retractedAt' | 'retractionReason' | 'retractionSourceWorkId' | 'retractionSourceRoundId'>;

/** A metric is an observation at a time, never an automatically additive total. */
export interface OutcomeObservation {
  schemaVersion: 1;
  id: string;
  scope: ScopeRef;
  sourceWorkId: string;
  sourceRoundId: string;
  evidenceRef: string;
  remoteObject: { id: string; url: string; account: string; channel: string };
  observedAt: string;
  window: { start: string; end: string };
  metrics: Array<{ name: string; unit: string; value: number | null; missingReason?: string; cumulative: boolean }>;
}

export function requireExperienceText(value: string, label: string, max = 256): void {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`EXPERIENCE_${label}_INVALID`);
}

export function validateExperienceScope(scope: ScopeRef): void {
  if (scope.schemaVersion !== 1 || !['workspace', 'project', 'requirement', 'plan', 'plan_step', 'work'].includes(scope.kind)) throw new Error('EXPERIENCE_SCOPE_INVALID');
  requireExperienceText(scope.id, 'SCOPE', 512);
}

export function matchesExperienceApplicability(stored: ExperienceApplicability, requested: ExperienceApplicability): boolean {
  return (['channel', 'account', 'locale'] as const).every((key) => stored[key] === undefined || stored[key] === requested[key]);
}

export function validateExperience(record: ExperienceRecord): ExperienceRecord {
  if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error('EXPERIENCE_VERSION_INVALID');
  validateExperienceScope(record.scope);
  for (const [key, value] of Object.entries({ id: record.id, work: record.sourceWorkId, round: record.sourceRoundId })) requireExperienceText(value, key);
  requireExperienceText(record.statement, 'STATEMENT', 4000);
  if (!['observation', 'hypothesis', 'lesson'].includes(record.kind)) throw new Error('EXPERIENCE_KIND_INVALID');
  if (!record.applicability || Object.keys(record.applicability).some(key => !['channel', 'account', 'locale'].includes(key))) throw new Error('EXPERIENCE_APPLICABILITY_INVALID');
  Object.values(record.applicability).forEach(value => requireExperienceText(value, 'APPLICABILITY'));
  if (record.applicability.account && !record.applicability.channel) throw new Error('EXPERIENCE_ACCOUNT_CHANNEL_REQUIRED');
  for (const refs of [record.evidenceRefs, record.counterEvidenceRefs]) {
    if (!Array.isArray(refs) || refs.length > 32 || new Set(refs).size !== refs.length) throw new Error('EXPERIENCE_EVIDENCE_INVALID');
    refs.forEach(ref => requireExperienceText(ref, 'EVIDENCE', 512));
  }
  if (!record.evidenceRefs.length) throw new Error('EXPERIENCE_EVIDENCE_REQUIRED');
  const at = Date.parse(record.recordedAt);
  if (!Number.isFinite(at)) throw new Error('EXPERIENCE_TIME_INVALID');
  if (record.expiresAt && (!Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= at)) throw new Error('EXPERIENCE_EXPIRY_INVALID');
  if (!record.expiresAt && (record.kind !== 'lesson' || !record.durableRationale?.trim())) throw new Error('EXPERIENCE_EXPIRY_REQUIRED');
  if (record.durableRationale) requireExperienceText(record.durableRationale, 'DURABLE_RATIONALE', 2000);
  if (record.supersedesId) requireExperienceText(record.supersedesId, 'SUPERSEDES');
  if (record.retractedAt) {
    if (!Number.isFinite(Date.parse(record.retractedAt)) || Date.parse(record.retractedAt) < at) throw new Error('EXPERIENCE_RETRACTION_INVALID');
    requireExperienceText(record.retractionReason!, 'RETRACTION_REASON', 1000);
    requireExperienceText(record.retractionSourceWorkId!, 'RETRACTION_WORK');
    requireExperienceText(record.retractionSourceRoundId!, 'RETRACTION_ROUND');
  }
  return record;
}

export function validateOutcomeObservation(value: OutcomeObservation): OutcomeObservation {
  if (value.schemaVersion !== 1) throw new Error('OUTCOME_SCHEMA_INVALID');
  validateExperienceScope(value.scope);
  for (const text of [value.id, value.sourceWorkId, value.sourceRoundId, value.evidenceRef, value.remoteObject.id, value.remoteObject.account, value.remoteObject.channel]) requireExperienceText(text, 'OUTCOME_ID', 512);
  const url = new URL(value.remoteObject.url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('OUTCOME_URL_INVALID');
  const times = [value.window.start, value.window.end, value.observedAt].map(Date.parse);
  if (times.some(time => !Number.isFinite(time)) || times[0]! > times[1]! || times[1]! > times[2]!) throw new Error('OUTCOME_WINDOW_INVALID');
  if (!Array.isArray(value.metrics) || value.metrics.length < 1 || value.metrics.length > 32) throw new Error('OUTCOME_METRICS_INVALID');
  const names = new Set<string>();
  for (const metric of value.metrics) {
    requireExperienceText(metric.name, 'METRIC'); requireExperienceText(metric.unit, 'UNIT');
    if (names.has(metric.name)) throw new Error('OUTCOME_METRIC_DUPLICATE');
    names.add(metric.name);
    if (typeof metric.cumulative !== 'boolean') throw new Error('OUTCOME_METRIC_CUMULATIVE_REQUIRED');
    if (metric.value === null) requireExperienceText(metric.missingReason!, 'MISSING_REASON', 1000);
    else if (!Number.isFinite(metric.value) || metric.missingReason !== undefined) throw new Error('OUTCOME_METRIC_VALUE_INVALID');
  }
  return value;
}
