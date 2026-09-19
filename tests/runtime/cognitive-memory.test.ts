import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  consolidateMemories,
  memoryDraftFromLearningSignal,
  recordCognitiveMemory,
  recordCognitiveMemoryEdge,
  type CognitiveWriteAuthorityPort,
  type MemoryUnit,
  type MemoryUnitDraft,
} from '../../packages/kernel/cognition/api/index';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { withControlPlaneTransaction } from '../../src/runtime/control-plane/persistence/sqlite-store';
import {
  activateCognitiveMemory,
  cognitionMemoryStore,
  cognitionReadPort,
  putCognitivePayload,
  readCognitivePayload,
  rebuildCognitionDerivedIndexes,
} from '../../src/runtime/control-plane/persistence/cognition-store';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scope = { schemaVersion: 1 as const, kind: 'project' as const, id: 'project-cognition' };
const at = '2026-09-17T00:00:00.000Z';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'forge-cognition-'));
  roots.push(root);
  const controllerHome = join(root, 'controller');
  ensureControllerHome(controllerHome);
  const evidence = new Set(['E-1', 'E-2', 'E-3', 'E-4']);
  const authority: CognitiveWriteAuthorityPort = {
    assertMemoryWrite() {},
    assertEdgeWrite() {},
    evidenceAvailable(ref) { return evidence.has(ref); },
  };
  return { controllerHome, store: cognitionMemoryStore(controllerHome), authority };
}

function draft(id: string, text: string, concepts: string[], evidenceRef: string): MemoryUnitDraft {
  return {
    id,
    scope,
    facets: ['knowledge', 'successful-pattern'],
    canonicalText: text,
    concepts,
    provenance: { sourceKind: 'external', sourceId: `source:${id}`, recordedAt: at, evidenceRefs: [evidenceRef] },
    confidence: 0.85,
    utility: 0.8,
    tier: 'warm',
    validFrom: at,
    counterEvidenceRefs: [],
  };
}

describe('generic cognitive memory', () => {
  test('learns positive knowledge and associates related memory through a bounded graph', () => {
    const fx = fixture();
    const first = recordCognitiveMemory(fx.store, fx.authority, draft('mem:batch', 'Batch discovery and one coherent patch reduced repeated work.', ['workflow.batch', 'work.efficiency'], 'E-1'));
    const second = recordCognitiveMemory(fx.store, fx.authority, draft('mem:baseline', 'A frozen admission baseline preserves isolated candidate closure.', ['work.isolation', 'baseline.frozen'], 'E-2'));
    recordCognitiveMemoryEdge(fx.store, fx.authority, { id: 'edge:batch-baseline', scope, fromId: first.id, toId: second.id, relation: 'supports', weight: 0.92, evidenceRefs: ['E-3'], recordedAt: at });

    const pack = activateCognitiveMemory(fx.controllerHome, [scope], 'workflow.batch', { seedConcepts: ['workflow.batch'], maxItems: 8, maxGraphDepth: 2, now: at });
    expect(pack.items.map(item => item.memory.id)).toContain(first.id);
    expect(pack.items.map(item => item.memory.id)).toContain(second.id);
    expect(pack.items.find(item => item.memory.id === second.id)?.reasons.some(reason => reason.signal === 'graph')).toBe(true);
    expect(pack.estimatedBytes).toBeLessThanOrEqual(24 * 1024);
  });

  test('uses one revisioned canonical record and rebuildable derived indexes', () => {
    const fx = fixture();
    const first = recordCognitiveMemory(fx.store, fx.authority, draft('mem:revision', 'First observation.', ['knowledge.revision'], 'E-1'));
    const second = recordCognitiveMemory(fx.store, fx.authority, { ...draft('mem:revision', 'Refined observation.', ['knowledge.revision'], 'E-2'), confidence: 0.91 });
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(rebuildCognitionDerivedIndexes(fx.controllerHome)).toBe(1);
    const pack = activateCognitiveMemory(fx.controllerHome, [scope], 'knowledge.revision', { now: at });
    expect(pack.items.find(item => item.memory.id === 'mem:revision')?.memory).toMatchObject({ revision: 2, canonicalText: 'Refined observation.' });
  });

  test('rebuilds missing derived indexes from canonical memory on the normal activation path', () => {
    const fx = fixture();
    recordCognitiveMemory(fx.store, fx.authority, draft('mem:index-loss', 'Canonical memory survives projection loss.', ['index.rebuildable'], 'E-1'));
    withControlPlaneTransaction(fx.controllerHome, database => {
      database.exec('DROP TABLE cognition_concept_index; DROP TABLE cognition_term_index;');
    });
    const rebuilt = activateCognitiveMemory(fx.controllerHome, [scope], 'index.rebuildable', { seedConcepts: ['index.rebuildable'], now: at });
    expect(rebuilt.items.some(item => item.memory.id === 'mem:index-loss')).toBe(true);
    expect(rebuilt.gaps).toContain('derived_index_rebuilt');
    expect(activateCognitiveMemory(fx.controllerHome, [scope], 'index.rebuildable', { seedConcepts: ['index.rebuildable'], now: at }).gaps).not.toContain('derived_index_rebuilt');
  });

  test('keeps identical memory ids isolated by semantic scope', () => {
    const fx = fixture();
    const otherScope = { schemaVersion: 1 as const, kind: 'project' as const, id: 'project-other' };
    recordCognitiveMemory(fx.store, fx.authority, draft('mem:same', 'Primary project memory.', ['scope.primary'], 'E-1'));
    recordCognitiveMemory(fx.store, fx.authority, { ...draft('mem:same', 'Other project memory.', ['scope.other'], 'E-2'), scope: otherScope });
    const pack = activateCognitiveMemory(fx.controllerHome, [scope, otherScope], 'scope.primary', { seedConcepts: ['scope.primary'], now: at });
    const matching = pack.items.filter(item => item.memory.id === 'mem:same');
    expect(matching.some(item => item.memory.scope.id === scope.id && item.memory.canonicalText === 'Primary project memory.')).toBe(true);
    expect(matching.some(item => item.memory.scope.id === otherScope.id && item.memory.canonicalText === 'Other project memory.')).toBe(false);
  });

  test('filters inactive memories and edges before bounded concept, lexical and graph selection', () => {
    const fx = fixture();
    const activeAt = '2026-09-18T00:00:00.000Z';
    recordCognitiveMemory(fx.store, fx.authority, { ...draft('mem:a-expired', 'Temporal candidate shared term.', ['temporal.limit'], 'E-1'), validFrom: '2026-09-15T00:00:00.000Z', expiresAt: '2026-09-16T00:00:00.000Z' });
    recordCognitiveMemory(fx.store, fx.authority, { ...draft('mem:a-future', 'Temporal candidate shared term.', ['temporal.limit'], 'E-1'), validFrom: '2026-09-19T00:00:00.000Z' });
    const live = recordCognitiveMemory(fx.store, fx.authority, { ...draft('mem:z-live', 'Temporal candidate shared term.', ['temporal.limit'], 'E-2'), validFrom: '2026-09-17T00:00:00.000Z' });
    const port = cognitionReadPort(fx.controllerHome);
    expect(port.exactByConcept([scope], ['temporal.limit'], 1, activeAt).map(item => item.id)).toEqual([live.id]);
    expect(port.lexical([scope], ['temporal', 'candidate'], 1, activeAt).map(item => item.id)).toEqual([live.id]);

    const seed = recordCognitiveMemory(fx.store, fx.authority, draft('mem:seed', 'Graph seed.', ['graph.seed'], 'E-1'));
    recordCognitiveMemory(fx.store, fx.authority, { ...draft('mem:a-expired-target', 'Expired graph target.', ['graph.target'], 'E-2'), validFrom: '2026-09-15T00:00:00.000Z', expiresAt: '2026-09-16T00:00:00.000Z' });
    recordCognitiveMemory(fx.store, fx.authority, { ...draft('mem:a-future-target', 'Future graph target.', ['graph.target'], 'E-2'), validFrom: '2026-09-19T00:00:00.000Z' });
    recordCognitiveMemory(fx.store, fx.authority, draft('mem:b-edge-expired-target', 'Live target behind expired edge.', ['graph.target'], 'E-3'));
    const liveTarget = recordCognitiveMemory(fx.store, fx.authority, draft('mem:z-live-target', 'Live graph target.', ['graph.target'], 'E-4'));
    recordCognitiveMemoryEdge(fx.store, fx.authority, { id: 'edge:future-target', scope, fromId: seed.id, toId: 'mem:a-future-target', relation: 'supports', weight: 1, evidenceRefs: ['E-1'], recordedAt: at });
    recordCognitiveMemoryEdge(fx.store, fx.authority, { id: 'edge:expired-target', scope, fromId: seed.id, toId: 'mem:a-expired-target', relation: 'supports', weight: 0.99, evidenceRefs: ['E-1'], recordedAt: at });
    recordCognitiveMemoryEdge(fx.store, fx.authority, { id: 'edge:expired', scope, fromId: seed.id, toId: 'mem:b-edge-expired-target', relation: 'supports', weight: 0.95, evidenceRefs: ['E-2'], recordedAt: at, expiresAt: '2026-09-17T12:00:00.000Z' });
    recordCognitiveMemoryEdge(fx.store, fx.authority, { id: 'edge:live', scope, fromId: seed.id, toId: liveTarget.id, relation: 'supports', weight: 0.5, evidenceRefs: ['E-3'], recordedAt: at });
    expect(port.neighbors([{ scope, id: seed.id }], 1, activeAt).map(item => item.memory.id)).toEqual([liveTarget.id]);
  });

  test('content-addresses large source detail without duplicating it into memory text', () => {
    const fx = fixture();
    const source = 'detailed source evidence\n'.repeat(100);
    const first = putCognitivePayload(fx.controllerHome, source, 'text/plain; charset=utf-8');
    const second = putCognitivePayload(fx.controllerHome, source, 'text/plain; charset=utf-8');
    expect(second).toEqual(first);
    expect(readCognitivePayload(fx.controllerHome, first).toString('utf8')).toBe(source);
    const memory = recordCognitiveMemory(fx.store, fx.authority, { ...draft('mem:cas', 'Dense canonical statement.', ['storage.cas'], 'E-1'), payloadRef: first });
    expect(memory.payloadRef?.bytes).toBeGreaterThan(memory.canonicalText.length);
  });

  test('consolidates repeated successful knowledge while retaining source memories and provenance', () => {
    const fx = fixture();
    const sources: MemoryUnit[] = [
      recordCognitiveMemory(fx.store, fx.authority, draft('mem:s1', 'Batch reads reduced tool round trips.', ['learning.success', 'workflow.common', 'workflow.batch'], 'E-1')),
      recordCognitiveMemory(fx.store, fx.authority, draft('mem:s2', 'Concentrated analysis avoided repeated discovery.', ['learning.success', 'workflow.common', 'analysis.concentrated'], 'E-2')),
      recordCognitiveMemory(fx.store, fx.authority, draft('mem:s3', 'One coherent patch reduced verification churn.', ['learning.success', 'workflow.common', 'patch.coherent'], 'E-3')),
    ];
    const consolidated = consolidateMemories(scope, sources, '2026-09-18T00:00:00.000Z');
    const candidate = consolidated.candidates.find(item => item.memory.concepts.includes('learning.success'));
    expect(consolidated.candidates).toHaveLength(1);
    expect(candidate?.memory.concepts).toContain('workflow.common');
    expect(candidate?.sourceRetained).toBe(true);
    expect(candidate?.supportingIds.sort()).toEqual(['mem:s1', 'mem:s2', 'mem:s3']);
    expect(consolidated.edges.filter(edge => edge.relation === 'derived_from')).toHaveLength(3);
    const sourcePack = activateCognitiveMemory(fx.controllerHome, [scope], 'learning.success', { now: '2026-09-18T00:00:00.000Z' });
    expect(sourcePack.items.some(item => item.memory.id === 'mem:s1')).toBe(true);
  });

  test('encodes success and knowledge as first-class learning signals instead of failure-only lessons', () => {
    const success = memoryDraftFromLearningSignal({ schemaVersion: 1, id: 'success-1', scope, kind: 'success', valence: 'positive', summary: 'A scene-based teaching series produced better retention.', concepts: ['learning.scene', 'learning.retention'], salience: 0.9, confidence: 0.8, sourceKind: 'external', observedAt: at, evidenceRefs: ['E-1'] });
    const knowledge = memoryDraftFromLearningSignal({ schemaVersion: 1, id: 'knowledge-1', scope, kind: 'knowledge', valence: 'neutral', summary: 'Model-facing memory should remain semantic rather than bytecode.', concepts: ['memory.transport', 'model.semantic'], salience: 0.7, confidence: 0.95, sourceKind: 'knowledge', observedAt: at, evidenceRefs: ['E-2'] });
    expect(success.facets).toContain('success');
    expect(success.facets).toContain('valence.positive');
    expect(success.tier).toBe('warm');
    expect(knowledge.facets).toContain('knowledge');
    expect(knowledge.tier).toBe('warm');
  });
});
