import { createHash } from 'node:crypto';
import type { ScopeRef } from '../../identity/api/index';
import {
  cognitiveTerms,
  type MemoryEdge,
  type MemoryUnit,
  validateMemoryEdge,
  validateMemoryUnit,
} from '../domain/memory';

export type InferredMemoryRelation = 'supports' | 'contradicts' | 'analogous_to' | 'supersedes';
export interface MemoryAssociation { relation: InferredMemoryRelation; weight: number; affinity: number }
export interface ConsolidationCandidate { memory: MemoryUnit; supportingIds: string[]; sourceRetained: true }
export interface ConsolidationResult { candidates: ConsolidationCandidate[]; edges: MemoryEdge[]; skipped: Array<{ id: string; reason: string }> }

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function intersection<T>(sets: ReadonlyArray<ReadonlySet<T>>): T[] {
  if (!sets.length) return [];
  return [...sets[0]!].filter(value => sets.every(set => set.has(value)));
}
function sameScope(memory: MemoryUnit, scope: ScopeRef): boolean {
  return memory.scope.kind === scope.kind && memory.scope.id === scope.id;
}
function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const value of left) if (right.has(value)) shared += 1;
  return shared / Math.max(1, Math.min(left.size, right.size));
}
function conceptParts(memory: MemoryUnit): Set<string> {
  return new Set(memory.concepts.flatMap(concept => concept.split(/[._:/-]+/))
    .map(value => value.trim().toLowerCase())
    .filter(value => value.length >= 3));
}
const GENERIC_ASSOCIATION_FACETS = new Set([
  'learning', 'admission.advisory', 'knowledge', 'success', 'failure', 'novelty', 'correction',
  'contradiction', 'pattern', 'preference', 'principle', 'procedure',
]);
function lexicalTerms(memory: MemoryUnit): Set<string> {
  return cognitiveTerms(`${memory.canonicalText}\n${memory.concepts.join(' ')}`);
}
function semanticFacets(memory: MemoryUnit): Set<string> {
  return new Set(memory.facets.filter(value => !GENERIC_ASSOCIATION_FACETS.has(value)
    && !value.startsWith('source.') && !value.startsWith('valence.')
    && !value.startsWith('portability.') && !value.startsWith('admission.')));
}
function facet(memory: MemoryUnit, value: string): boolean {
  return memory.facets.includes(value);
}
function opposedValence(left: MemoryUnit, right: MemoryUnit): boolean {
  return (facet(left, 'valence.positive') && facet(right, 'valence.negative'))
    || (facet(left, 'valence.negative') && facet(right, 'valence.positive'));
}

/**
 * Deterministic semantic association. The Controller has already produced normalized concepts;
 * this layer only compares canonical MemoryUnit data and never invents a second semantic authority.
 */
export function inferMemoryAssociation(from: MemoryUnit, to: MemoryUnit): MemoryAssociation | undefined {
  if (from.id === to.id || !sameScope(from, to.scope)) return undefined;
  const exactConcept = overlap(new Set(from.concepts), new Set(to.concepts));
  const conceptAffinity = overlap(conceptParts(from), conceptParts(to));
  const lexicalAffinity = overlap(lexicalTerms(from), lexicalTerms(to));
  const facetAffinity = overlap(semanticFacets(from), semanticFacets(to));
  const affinity = Math.min(1, Math.max(
    exactConcept,
    conceptAffinity * 0.72 + lexicalAffinity * 0.18 + facetAffinity * 0.10,
    lexicalAffinity * 0.75 + conceptAffinity * 0.25,
  ));
  if (affinity < 0.28) return undefined;

  let relation: InferredMemoryRelation;
  if (facet(from, 'correction') && affinity >= 0.45) relation = 'supersedes';
  else if ((facet(from, 'contradiction') || facet(to, 'contradiction') || opposedValence(from, to)) && affinity >= 0.50) relation = 'contradicts';
  else if (affinity >= 0.55) relation = 'supports';
  else relation = 'analogous_to';

  const confidence = Math.sqrt(Math.max(0, from.confidence) * Math.max(0, to.confidence));
  const weight = Math.max(0.2, Math.min(0.98, affinity * 0.82 + confidence * 0.18));
  return { relation, weight, affinity };
}

function unionFindClusters(memories: readonly MemoryUnit[]): MemoryUnit[][] {
  const parent = memories.map((_, index) => index);
  const find = (index: number): number => {
    let current = index;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]!]!;
      current = parent[current]!;
    }
    return current;
  };
  const join = (left: number, right: number): void => {
    const a = find(left), b = find(right);
    if (a !== b) parent[b] = a;
  };
  for (let left = 0; left < memories.length; left += 1) {
    for (let right = left + 1; right < memories.length; right += 1) {
      const association = inferMemoryAssociation(memories[left]!, memories[right]!);
      if (association?.relation === 'supports'
        || association?.relation === 'analogous_to' && association.affinity >= 0.48) join(left, right);
    }
  }
  const clusters = new Map<number, MemoryUnit[]>();
  for (let index = 0; index < memories.length; index += 1) {
    const root = find(index);
    const group = clusters.get(root) ?? [];
    group.push(memories[index]!);
    clusters.set(root, group);
  }
  return [...clusters.values()].filter(group => group.length >= 2);
}

export function consolidateMemories(scope: ScopeRef, memories: readonly MemoryUnit[], now = new Date().toISOString()): ConsolidationResult {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error('COGNITION_CONSOLIDATION_TIME_INVALID');

  const active = [...new Map(memories
    .filter(memory => sameScope(memory, scope)
      && !memory.retractedAt
      && (!memory.expiresAt || Date.parse(memory.expiresAt) > nowMs))
    .map(memory => [memory.id, memory])).values()]
    .slice(0, 128);

  const candidates: ConsolidationCandidate[] = [];
  const edges: MemoryEdge[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const group of unionFindClusters(active)) {
    const sources = [...group].sort((a, b) => a.id.localeCompare(b.id));
    const evidence = [...new Set(sources.flatMap(memory => memory.provenance.evidenceRefs))].slice(0, 64);
    const traceable = sources.every(memory => Boolean(
      memory.provenance.sourceRoundId || memory.provenance.sourceId || memory.provenance.evidenceRefs.length));
    if (!traceable) {
      skipped.push({ id: sources.map(memory => memory.id).join(','), reason: 'no_provenance' });
      continue;
    }

    const sharedFacets = intersection(sources.map(memory => new Set(memory.facets)));
    const averageUtility = sources.reduce((sum, memory) => sum + memory.utility, 0) / sources.length;
    const averageConfidence = sources.reduce((sum, memory) => sum + memory.confidence, 0) / sources.length;
    const sourceRounds = new Set(sources.map(memory => memory.provenance.sourceRoundId).filter(Boolean));
    const corroborationBoost = Math.min(0.15, Math.max(0, sourceRounds.size - 1) * 0.05);
    const confidence = Math.min(0.99, averageConfidence + corroborationBoost);
    const clusterKey = sources.map(memory => memory.id).sort().join('|');
    const key = digest(`${scope.kind}:${scope.id}:${clusterKey}`).slice(0, 24);
    const orderedByValue = [...sources].sort((a, b) =>
      b.utility - a.utility || b.confidence - a.confidence || b.provenance.recordedAt.localeCompare(a.provenance.recordedAt) || a.id.localeCompare(b.id));
    const representative = orderedByValue[0]!;
    const memory = validateMemoryUnit({
      schemaVersion: 1,
      id: `consolidated:${digest(representative.concepts.join('|') || representative.id).slice(0, 16)}:${key}`,
      revision: 1,
      scope,
      facets: [...new Set(['knowledge', 'pattern', 'consolidated', ...sharedFacets])].slice(0, 16),
      canonicalText: representative.canonicalText,
      concepts: [...new Set(sources.flatMap(item => item.concepts))].slice(0, 64),
      provenance: { sourceKind: 'system', sourceId: `consolidation:${key}`, recordedAt: now, evidenceRefs: evidence },
      confidence,
      utility: Math.min(1, averageUtility + Math.min(0.1, (sources.length - 1) * 0.03)),
      tier: 'warm',
      validFrom: now,
      counterEvidenceRefs: [...new Set(sources.flatMap(memory => memory.counterEvidenceRefs))].slice(0, 64),
    });
    candidates.push({ memory, supportingIds: sources.map(item => item.id), sourceRetained: true });
    for (const source of sources) {
      edges.push(validateMemoryEdge({
        schemaVersion: 1,
        id: `edge:${key}:${digest(source.id).slice(0, 12)}`,
        scope,
        fromId: memory.id,
        toId: source.id,
        relation: 'derived_from',
        weight: Math.max(0.1, source.confidence),
        evidenceRefs: source.provenance.evidenceRefs.slice(0, 64),
        recordedAt: now,
      }));
    }
  }
  return { candidates, edges, skipped };
}
