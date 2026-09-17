import { createHash } from 'node:crypto';
import type { ScopeRef } from '../../identity/api/index';
import { type MemoryEdge, type MemoryUnit, validateMemoryEdge, validateMemoryUnit } from '../domain/memory';

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

export function consolidateMemories(scope: ScopeRef, memories: readonly MemoryUnit[], now = new Date().toISOString()): ConsolidationResult {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error('COGNITION_CONSOLIDATION_TIME_INVALID');

  const active = memories.filter(memory => sameScope(memory, scope)
    && !memory.retractedAt
    && (!memory.expiresAt || Date.parse(memory.expiresAt) > nowMs));
  const byConcept = new Map<string, MemoryUnit[]>();
  for (const memory of active) {
    for (const concept of memory.concepts) {
      const group = byConcept.get(concept) ?? [];
      group.push(memory);
      byConcept.set(concept, group);
    }
  }

  const clusters = new Map<string, { sources: MemoryUnit[]; concepts: Set<string> }>();
  for (const [concept, group] of byConcept) {
    const sources = [...new Map(group.map(memory => [memory.id, memory])).values()];
    if (sources.length < 3) continue;
    const clusterKey = sources.map(memory => memory.id).sort().join('|');
    const cluster = clusters.get(clusterKey) ?? { sources, concepts: new Set<string>() };
    cluster.concepts.add(concept);
    clusters.set(clusterKey, cluster);
  }

  const candidates: ConsolidationCandidate[] = [];
  const edges: MemoryEdge[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const [clusterKey, cluster] of clusters) {
    const sources = [...cluster.sources].sort((a, b) => a.id.localeCompare(b.id));
    const triggerConcepts = [...cluster.concepts].sort();
    const evidence = [...new Set(sources.flatMap(memory => memory.provenance.evidenceRefs))].slice(0, 64);
    if (!evidence.length) {
      skipped.push({ id: triggerConcepts.join(','), reason: 'no_provenance' });
      continue;
    }

    const sharedFacets = intersection(sources.map(memory => new Set(memory.facets)));
    const averageUtility = sources.reduce((sum, memory) => sum + memory.utility, 0) / sources.length;
    const confidence = Math.min(0.99,
      sources.reduce((sum, memory) => sum + memory.confidence, 0) / sources.length * Math.min(1, sources.length / 5));
    const key = digest(`${scope.kind}:${scope.id}:${clusterKey}`).slice(0, 24);
    const primaryConcept = triggerConcepts[0]!;
    const orderedByValue = [...sources].sort((a, b) => b.utility - a.utility || b.confidence - a.confidence || a.id.localeCompare(b.id));
    const canonicalText = orderedByValue
      .slice(0, 4)
      .map(memory => memory.canonicalText.trim())
      .filter((text, index, all) => all.indexOf(text) === index)
      .join(' | ')
      .slice(0, 8_192);
    const memory = validateMemoryUnit({
      schemaVersion: 1,
      id: `consolidated:${primaryConcept}:${key}`,
      revision: 1,
      scope,
      facets: [...new Set(['knowledge', 'pattern', ...sharedFacets])].slice(0, 16),
      canonicalText,
      concepts: [...new Set([...triggerConcepts, ...sources.flatMap(item => item.concepts)])].slice(0, 64),
      provenance: { sourceKind: 'system', sourceId: `consolidation:${key}`, recordedAt: now, evidenceRefs: evidence },
      confidence,
      utility: Math.min(1, averageUtility + 0.1),
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
