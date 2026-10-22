import { cognitiveTerms, validateMemoryUnit, type MemoryUnit } from '../domain/memory';
import type { ExperienceRecord } from '../../memory/api/index';

function stableConcepts(prefix: string, scopeKind: string, scopeId: string, text: string): string[] {
  const lexical = [...cognitiveTerms(text)].filter(term => /^[a-z0-9][a-z0-9._:/-]{0,255}$/i.test(term)).slice(0, 24);
  return [...new Set([prefix, `scope.${scopeKind}:${scopeId}`, ...lexical])].slice(0, 64);
}

/** Compatibility adapter only. It does not persist a second copy of Experience. */
export function memoryUnitFromExperience(record: ExperienceRecord): MemoryUnit {
  const confidence = record.kind === 'lesson' ? 0.82 : record.kind === 'hypothesis' ? 0.55 : 0.68;
  const utility = record.kind === 'lesson' ? 0.82 : record.kind === 'hypothesis' ? 0.58 : 0.52;
  return validateMemoryUnit({
    schemaVersion: 1,
    id: record.id,
    revision: record.revision,
    scope: record.scope,
    facets: ['knowledge', record.kind],
    canonicalText: record.statement,
    concepts: stableConcepts(`experience.${record.kind}`, record.scope.kind, record.scope.id, record.statement),
    provenance: { sourceKind: 'experience', sourceId: record.id, sourceWorkId: record.sourceWorkId, sourceRoundId: record.sourceRoundId, recordedAt: record.recordedAt, evidenceRefs: record.evidenceRefs },
    confidence,
    utility,
    tier: record.kind === 'observation' ? 'cold' : 'warm',
    validFrom: record.recordedAt,
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
    ...(record.supersedesId ? { supersedesId: record.supersedesId } : {}),
    counterEvidenceRefs: record.counterEvidenceRefs,
    ...(record.retractedAt ? { retractedAt: record.retractedAt, retractionReason: record.retractionReason } : {}),
  });
}
