import type { ScopeRef } from '../../identity/api/index';
import type { MemoryPayloadRef, MemorySourceKind, MemoryUnitDraft } from './memory';

export type LearningSignalKind =
  | 'knowledge'
  | 'success'
  | 'failure'
  | 'novelty'
  | 'correction'
  | 'contradiction'
  | 'pattern'
  | 'preference'
  | 'principle'
  | 'procedure';

export type LearningValence = 'positive' | 'negative' | 'neutral';

/** A learning trigger is domain-independent. Failure is only one possible signal. */
export interface LearningSignal {
  schemaVersion: 1;
  id: string;
  scope: ScopeRef;
  kind: LearningSignalKind;
  valence: LearningValence;
  summary: string;
  concepts: string[];
  facets?: string[];
  salience: number;
  confidence: number;
  sourceKind: MemorySourceKind;
  sourceId?: string;
  sourceWorkId?: string;
  sourceRoundId?: string;
  observedAt: string;
  evidenceRefs: string[];
  counterEvidenceRefs?: string[];
  payloadRef?: MemoryPayloadRef;
  expiresAt?: string;
}

function score(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`COGNITION_LEARNING_${label}_INVALID`);
}

export function validateLearningSignal(signal: LearningSignal): LearningSignal {
  if (signal.schemaVersion !== 1 || !signal.id.trim() || signal.id.length > 512) throw new Error('COGNITION_LEARNING_ID_INVALID');
  if (!signal.summary.trim() || signal.summary.length > 8_192) throw new Error('COGNITION_LEARNING_SUMMARY_INVALID');
  if (!signal.concepts.length || signal.concepts.length > 64 || new Set(signal.concepts).size !== signal.concepts.length) throw new Error('COGNITION_LEARNING_CONCEPTS_INVALID');
  if (!Number.isFinite(Date.parse(signal.observedAt))) throw new Error('COGNITION_LEARNING_TIME_INVALID');
  score(signal.salience, 'SALIENCE'); score(signal.confidence, 'CONFIDENCE');
  if (signal.expiresAt && Date.parse(signal.expiresAt) <= Date.parse(signal.observedAt)) throw new Error('COGNITION_LEARNING_EXPIRY_INVALID');
  return signal;
}

export function memoryDraftFromLearningSignal(input: LearningSignal): MemoryUnitDraft {
  const signal = validateLearningSignal(input);
  const durable = ['knowledge', 'success', 'correction', 'pattern', 'preference', 'principle', 'procedure'].includes(signal.kind);
  return {
    id: `learning:${signal.id}`,
    scope: signal.scope,
    facets: [...new Set(['learning', signal.kind, `valence.${signal.valence}`, ...(signal.facets ?? [])])].slice(0, 16),
    canonicalText: signal.summary,
    concepts: signal.concepts,
    ...(signal.payloadRef ? { payloadRef: signal.payloadRef } : {}),
    provenance: {
      sourceKind: signal.sourceKind,
      ...(signal.sourceId ? { sourceId: signal.sourceId } : {}),
      ...(signal.sourceWorkId ? { sourceWorkId: signal.sourceWorkId } : {}),
      ...(signal.sourceRoundId ? { sourceRoundId: signal.sourceRoundId } : {}),
      recordedAt: signal.observedAt,
      evidenceRefs: signal.evidenceRefs,
    },
    confidence: signal.confidence,
    utility: signal.salience,
    tier: durable ? 'warm' : 'cold',
    validFrom: signal.observedAt,
    ...(signal.expiresAt ? { expiresAt: signal.expiresAt } : {}),
    counterEvidenceRefs: signal.counterEvidenceRefs ?? [],
  };
}
