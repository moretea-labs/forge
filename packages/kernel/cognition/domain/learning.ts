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

/** Admission source describes why a signal may become advisory memory; it is not lifecycle authority. */
export type LearningAdmissionSource =
  | 'explicit_human'
  | 'controller_observation'
  | 'verified_outcome'
  | 'execution_quality'
  | 'system_inference';

/** Portability is semantic intent only; cross-scope writes still require the existing write authority. */
export type LearningPortability = 'local' | 'portable';

const AUTOMATIC_ADMISSION_SOURCES: readonly LearningAdmissionSource[] = [
  'controller_observation',
  'verified_outcome',
  'execution_quality',
  'system_inference',
];
const AUTOMATIC_LOCAL_SCOPE_KINDS: readonly ScopeRef['kind'][] = ['work', 'requirement', 'project'];

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
  admissionSource: LearningAdmissionSource;
  portability: LearningPortability;
  /** Extraction-time importance, not truth confidence or learned usefulness. */
  salience: number;
  /** Evidentiary / semantic strength of the claim. */
  confidence: number;
  /** Initial retrieval-usefulness prior, independently learnable from usage feedback. */
  utility: number;
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
  if (!['explicit_human', 'controller_observation', 'verified_outcome', 'execution_quality', 'system_inference'].includes(signal.admissionSource)) throw new Error('COGNITION_LEARNING_ADMISSION_SOURCE_INVALID');
  if (!['local', 'portable'].includes(signal.portability)) throw new Error('COGNITION_LEARNING_PORTABILITY_INVALID');
  if (signal.portability === 'portable' && signal.admissionSource !== 'explicit_human') throw new Error('COGNITION_LEARNING_PORTABILITY_REQUIRES_EXPLICIT_HUMAN');
  if (AUTOMATIC_ADMISSION_SOURCES.includes(signal.admissionSource) && !AUTOMATIC_LOCAL_SCOPE_KINDS.includes(signal.scope.kind)) throw new Error('COGNITION_LEARNING_AUTOMATIC_SCOPE_INVALID');
  if (signal.scope.kind === 'workspace' && (signal.admissionSource !== 'explicit_human' || signal.portability !== 'portable')) throw new Error('COGNITION_LEARNING_WORKSPACE_PROMOTION_REQUIRED');
  score(signal.salience, 'SALIENCE'); score(signal.confidence, 'CONFIDENCE'); score(signal.utility, 'UTILITY');
  if (signal.expiresAt && Date.parse(signal.expiresAt) <= Date.parse(signal.observedAt)) throw new Error('COGNITION_LEARNING_EXPIRY_INVALID');
  return signal;
}

export function memoryDraftFromLearningSignal(input: LearningSignal): MemoryUnitDraft {
  const signal = validateLearningSignal(input);
  const durable = ['knowledge', 'success', 'correction', 'pattern', 'preference', 'principle', 'procedure'].includes(signal.kind);
  return {
    id: `learning:${signal.id}`,
    scope: signal.scope,
    facets: [...new Set([
      'learning',
      'admission.advisory',
      signal.kind,
      `valence.${signal.valence}`,
      `source.${signal.admissionSource}`,
      `portability.${signal.portability}`,
      ...(signal.facets ?? []),
    ])].slice(0, 16),
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
    utility: signal.utility,
    tier: durable ? 'warm' : 'cold',
    validFrom: signal.observedAt,
    ...(signal.expiresAt ? { expiresAt: signal.expiresAt } : {}),
    counterEvidenceRefs: signal.counterEvidenceRefs ?? [],
  };
}
