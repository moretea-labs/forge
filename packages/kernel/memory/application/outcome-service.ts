import type { ScopeRef } from '../../identity/api/index';
import { validateOutcomeObservation, type OutcomeObservation } from '../domain/experience';

export interface OutcomeObservationStorePort {
  transaction<T>(operation: () => T): T;
  assertWriteAuthority(scope: ScopeRef, sourceWorkId: string, sourceRoundId: string): void;
  evidenceAvailable(ref: string, scope: ScopeRef, sourceWorkId: string): boolean;
  read(scope: ScopeRef, id: string): OutcomeObservation | undefined;
  list(scope: ScopeRef, limit: number): OutcomeObservation[];
  write(observation: OutcomeObservation): void;
  assertSafePayload(observation: OutcomeObservation): void;
}

export const MAX_OUTCOME_OBSERVATIONS_PER_SCOPE = 1000;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonical(entry)]));
}

function sameObservation(left: OutcomeObservation, right: OutcomeObservation): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function recordOutcomeObservation(
  store: OutcomeObservationStorePort,
  observation: OutcomeObservation,
  now = new Date().toISOString(),
): OutcomeObservation {
  return store.transaction(() => {
    const value = validateOutcomeObservation(structuredClone(observation));
    const currentTime = Date.parse(now);
    if (!Number.isFinite(currentTime) || Date.parse(value.observedAt) > currentTime) throw new Error('OUTCOME_FUTURE_OBSERVATION');
    store.assertWriteAuthority(value.scope, value.sourceWorkId, value.sourceRoundId);
    store.assertSafePayload(value);
    const existing = store.read(value.scope, value.id);
    if (existing) {
      if (!sameObservation(existing, value)) throw new Error('OUTCOME_IDENTITY_CONFLICT');
      return existing;
    }
    if (!store.evidenceAvailable(value.evidenceRef, value.scope, value.sourceWorkId)) throw new Error('OUTCOME_EVIDENCE_UNAVAILABLE');
    if (store.list(value.scope, MAX_OUTCOME_OBSERVATIONS_PER_SCOPE).length >= MAX_OUTCOME_OBSERVATIONS_PER_SCOPE) throw new Error('OUTCOME_CAPACITY_REACHED');
    store.write(value);
    return value;
  });
}

export function queryOutcomeObservations(
  store: Pick<OutcomeObservationStorePort, 'list' | 'evidenceAvailable'>,
  input: { scopes: readonly ScopeRef[]; channel?: string; account?: string; since?: string; limit?: number },
): { observations: OutcomeObservation[]; gaps: string[] } {
  const since = input.since ? Date.parse(input.since) : undefined;
  if (input.since && !Number.isFinite(since)) throw new Error('OUTCOME_QUERY_TIME_INVALID');
  const observations: OutcomeObservation[] = [];
  const gaps: string[] = [];
  for (const scope of input.scopes.slice(0, 8)) {
    const rows = store.list(scope, MAX_OUTCOME_OBSERVATIONS_PER_SCOPE);
    if (rows.length >= MAX_OUTCOME_OBSERVATIONS_PER_SCOPE) gaps.push('outcome_candidate_limit');
    for (const row of rows) {
      try { validateOutcomeObservation(row); } catch { gaps.push('outcome_record_invalid'); continue; }
      if (row.scope.kind !== scope.kind || row.scope.id !== scope.id) continue;
      if (input.channel && row.remoteObject.channel !== input.channel) continue;
      if (input.account && row.remoteObject.account !== input.account) continue;
      if (since !== undefined && Date.parse(row.observedAt) < since) continue;
      if (!store.evidenceAvailable(row.evidenceRef, scope, row.sourceWorkId)) { gaps.push(`outcome_evidence_unavailable:${row.id}`); continue; }
      observations.push(row);
    }
  }
  const limit = Math.max(1, Math.min(input.limit ?? 32, 32));
  observations.sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id));
  if (observations.length > limit) gaps.push('outcome_result_limit');
  return { observations: observations.slice(0, limit), gaps: [...new Set(gaps)] };
}
