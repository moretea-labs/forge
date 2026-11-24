import { isDeepStrictEqual } from 'node:util';

export interface SemanticPreviousValue {
  present: boolean;
  value?: unknown;
}

export interface SemanticInverseChangeRecord {
  schemaVersion: 1;
  revision: number;
  nextRevision: number;
  recordedAt: string;
  previous: Record<string, SemanticPreviousValue>;
}

export function createSemanticInverseChange(
  previousView: Record<string, unknown>,
  nextView: Record<string, unknown>,
  input: { revision: number; nextRevision: number; recordedAt: string },
): SemanticInverseChangeRecord {
  const previous: Record<string, SemanticPreviousValue> = {};
  const keys = new Set([...Object.keys(previousView), ...Object.keys(nextView)]);
  for (const key of keys) {
    const previousPresent = Object.prototype.hasOwnProperty.call(previousView, key);
    const nextPresent = Object.prototype.hasOwnProperty.call(nextView, key);
    const previousValue = previousView[key];
    const nextValue = nextView[key];
    if (previousPresent === nextPresent && isDeepStrictEqual(previousValue, nextValue)) continue;
    previous[key] = previousPresent ? { present: true, value: structuredClone(previousValue) } : { present: false };
  }
  return {
    schemaVersion: 1,
    revision: input.revision,
    nextRevision: input.nextRevision,
    recordedAt: input.recordedAt,
    previous,
  };
}

export function applySemanticInverseChange<T extends Record<string, unknown>>(
  currentView: T,
  change: SemanticInverseChangeRecord,
): T {
  const previous = structuredClone(currentView) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(change.previous)) {
    if (!entry.present) {
      delete previous[key];
      continue;
    }
    previous[key] = structuredClone(entry.value);
  }
  return previous as T;
}
