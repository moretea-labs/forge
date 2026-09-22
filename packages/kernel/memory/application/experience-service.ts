import { matchesExperienceApplicability, validateExperience, type ExperienceApplicability, type ExperienceDraft, type ExperienceRecord } from '../domain/experience';
import type { ScopeRef } from '../../identity/api/index';

/** Ports are supplied by trusted composition, never deserialized from a tool call. */
export interface ExperienceStorePort {
  transaction<T>(operation: () => T): T;
  assertWriteAuthority(scope: ScopeRef, sourceWorkId: string, sourceRoundId: string): void;
  evidenceAvailable(ref: string, scope: ScopeRef, sourceWorkId: string): boolean;
  read(scope: ScopeRef, id: string): ExperienceRecord | undefined;
  list(scope: ScopeRef, limit: number): ExperienceRecord[];
  write(record: ExperienceRecord, expectedRevision: number | null): void;
  assertSafePayload(record: ExperienceRecord): void;
}

const DAY = 86_400_000;
export const MAX_EXPERIENCES_PER_SCOPE = 1000;

function normalized(draft: ExperienceDraft): ExperienceRecord {
  const expiresAt = draft.expiresAt ?? (draft.kind === 'lesson' ? undefined : new Date(Date.parse(draft.recordedAt) + (draft.kind === 'observation' ? 30 : 90) * DAY).toISOString());
  return validateExperience({ ...structuredClone(draft), schemaVersion: 1, revision: 1, expiresAt });
}

function contentIdentity(record: ExperienceRecord): string {
  const { revision: _revision, retractedAt: _at, retractionReason: _reason, retractionSourceWorkId: _work, retractionSourceRoundId: _round, ...content } = record;
  // Stable property order comes from the validated draft shape supplied by callers.
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)])) : v;
  return JSON.stringify(canonical(content));
}

export function recordExperience(store: ExperienceStorePort, draft: ExperienceDraft, now = new Date().toISOString()): ExperienceRecord {
  return store.transaction(() => {
    const record = normalized(draft);
    if (!Number.isFinite(Date.parse(now)) || Date.parse(record.recordedAt) > Date.parse(now)) throw new Error('EXPERIENCE_FUTURE_OBSERVATION');
    if (record.supersedesId) throw new Error('EXPERIENCE_USE_SUPERSEDE');
    store.assertWriteAuthority(record.scope, record.sourceWorkId, record.sourceRoundId);
    store.assertSafePayload(record);
    const current = store.read(record.scope, record.id);
    if (current) {
      if (current.retractedAt || contentIdentity(current) !== contentIdentity(record)) throw new Error('EXPERIENCE_IDENTITY_CONFLICT');
      return current;
    }
    for (const ref of [...record.evidenceRefs, ...record.counterEvidenceRefs]) {
      if (!store.evidenceAvailable(ref, record.scope, record.sourceWorkId)) throw new Error('EXPERIENCE_EVIDENCE_UNAVAILABLE');
    }
    if (store.list(record.scope, MAX_EXPERIENCES_PER_SCOPE).length >= MAX_EXPERIENCES_PER_SCOPE) throw new Error('EXPERIENCE_CAPACITY_REACHED');
    store.write(record, null);
    return record;
  });
}

export function queryExperiences(store: Pick<ExperienceStorePort, 'list' | 'evidenceAvailable'>, input: {
  scopes: readonly ScopeRef[]; applicability: ExperienceApplicability; now: string; limit?: number;
}): { records: ExperienceRecord[]; gaps: string[] } {
  if (!Number.isFinite(Date.parse(input.now))) throw new Error('EXPERIENCE_QUERY_TIME_INVALID');
  const records: ExperienceRecord[] = [], gaps: string[] = [];
  for (const scope of input.scopes.slice(0, 8)) {
    const candidates = store.list(scope, MAX_EXPERIENCES_PER_SCOPE);
    if (candidates.length >= MAX_EXPERIENCES_PER_SCOPE) gaps.push('experience_candidate_limit');
    for (const candidate of candidates) {
      try { validateExperience(candidate); } catch { gaps.push('experience_record_invalid'); continue; }
      if (candidate.scope.kind !== scope.kind || candidate.scope.id !== scope.id || candidate.retractedAt
        || candidate.expiresAt && Date.parse(candidate.expiresAt) <= Date.parse(input.now)
        || !matchesExperienceApplicability(candidate.applicability, input.applicability)) continue;
      if ([...candidate.evidenceRefs, ...candidate.counterEvidenceRefs].some(ref => !store.evidenceAvailable(ref, scope, candidate.sourceWorkId))) { gaps.push(`experience_evidence_unavailable:${candidate.id}`); continue; }
      records.push(candidate);
    }
  }
  const limit = Math.max(1, Math.min(input.limit ?? 32, 32));
  records.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id));
  if (records.length > limit) gaps.push('experience_result_limit');
  return { records: records.slice(0, limit), gaps: [...new Set(gaps)] };
}

export function retractExperience(store: ExperienceStorePort, input: {
  scope: ScopeRef; id: string; expectedRevision: number; sourceWorkId: string; sourceRoundId: string; reason: string; now: string;
}): ExperienceRecord {
  return store.transaction(() => {
    store.assertWriteAuthority(input.scope, input.sourceWorkId, input.sourceRoundId);
    const current = store.read(input.scope, input.id);
    if (current?.retractedAt === input.now && current.retractionReason === input.reason
      && current.revision === input.expectedRevision + 1 && current.retractionSourceWorkId === input.sourceWorkId
      && current.retractionSourceRoundId === input.sourceRoundId) return current;
    if (!current || current.revision !== input.expectedRevision) throw new Error('EXPERIENCE_REVISION_CONFLICT');
    if (current.retractedAt) throw new Error('EXPERIENCE_REVISION_CONFLICT');
    const next = validateExperience({ ...current, revision: current.revision + 1, retractedAt: input.now, retractionReason: input.reason,
      retractionSourceWorkId: input.sourceWorkId, retractionSourceRoundId: input.sourceRoundId });
    store.assertSafePayload(next); store.write(next, current.revision);
    return next;
  });
}

export function supersedeExperience(store: ExperienceStorePort, input: {
  previousId: string; expectedRevision: number; draft: ExperienceDraft; now: string;
}): ExperienceRecord {
  return store.transaction(() => {
    if (input.previousId === input.draft.id) throw new Error('EXPERIENCE_SUPERSEDE_SELF');
    const proposed = normalized({ ...input.draft, supersedesId: undefined });
    store.assertWriteAuthority(proposed.scope, proposed.sourceWorkId, proposed.sourceRoundId);
    store.assertSafePayload(proposed);
    const previous = store.read(input.draft.scope, input.previousId);
    const replacement = store.read(input.draft.scope, input.draft.id);
    if (previous?.revision === input.expectedRevision + 1 && previous.retractedAt === input.now
      && previous.retractionReason === `superseded:${input.draft.id}`
      && previous.retractionSourceWorkId === proposed.sourceWorkId && previous.retractionSourceRoundId === proposed.sourceRoundId
      && replacement?.supersedesId === previous.id && !replacement.retractedAt
      && contentIdentity({ ...replacement, supersedesId: undefined }) === contentIdentity(proposed)) return replacement;
    if (replacement) throw new Error('EXPERIENCE_IDENTITY_CONFLICT');
    if (!previous || previous.revision !== input.expectedRevision || previous.retractedAt) throw new Error('EXPERIENCE_REVISION_CONFLICT');
    // Admission is shared with ordinary recording; both writes commit atomically.
    const created = recordExperience(store, { ...input.draft, supersedesId: undefined }, input.now);
    const next = validateExperience({ ...created, supersedesId: previous.id, revision: created.revision + 1 });
    store.write(next, created.revision);
    retractExperience(store, { scope: previous.scope, id: previous.id, expectedRevision: previous.revision,
      sourceWorkId: input.draft.sourceWorkId, sourceRoundId: input.draft.sourceRoundId, reason: `superseded:${next.id}`, now: input.now });
    return next;
  });
}
