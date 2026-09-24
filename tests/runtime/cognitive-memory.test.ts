import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  consolidateMemories,
  inferMemoryAssociation,
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
  auditCognitiveMemory,
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

  test('infers semantic support, contradiction, analogy, and supersession from canonical memory data', () => {
    const base = { ...draft('mem:base', 'Interaction should be self explanatory; copy explains invisible rules.', ['product.interaction.self-explanatory', 'copy.invisible-rules'], 'E-1'), facets: ['knowledge', 'principle', 'valence.positive'] } as MemoryUnitDraft;
    const related = { ...draft('mem:related', 'Controls and state should communicate how the interface works without tutorial prose.', ['product.interaction.affordance', 'copy.invisible-rules'], 'E-2'), facets: ['knowledge', 'principle', 'valence.positive'] } as MemoryUnitDraft;
    const contradiction = { ...draft('mem:contradiction', 'This observation conflicts with the prior interaction guidance.', ['product.interaction.affordance', 'copy.invisible-rules'], 'E-3'), facets: ['knowledge', 'contradiction', 'valence.negative'] } as MemoryUnitDraft;
    const correction = { ...draft('mem:correction', 'Corrected guidance supersedes the earlier interaction wording.', ['product.interaction.self-explanatory', 'copy.invisible-rules'], 'E-4'), facets: ['knowledge', 'correction', 'valence.positive'] } as MemoryUnitDraft;
    const analogous = { ...draft('mem:analogous', 'A visible workflow should reduce explanation burden.', ['product.workflow.affordance', 'copy.visible-state'], 'E-2'), facets: ['knowledge', 'principle', 'valence.positive'] } as MemoryUnitDraft;
    const asUnit = (value: MemoryUnitDraft): MemoryUnit => ({ ...value, schemaVersion: 1, revision: 1 });

    expect(inferMemoryAssociation(asUnit(base), asUnit(related))?.relation).toBe('supports');
    expect(inferMemoryAssociation(asUnit(contradiction), asUnit(related))?.relation).toBe('contradicts');
    expect(inferMemoryAssociation(asUnit(correction), asUnit(base))?.relation).toBe('supersedes');
    expect(inferMemoryAssociation(asUnit(analogous), asUnit(related))?.relation).toBe('analogous_to');
  });

  test('consolidates two corroborating memories without concatenating raw source text', () => {
    const first = { ...draft('mem:source-a', 'Prefer interaction affordance over explanatory prose.', ['product.interaction', 'copy.invisible-rules'], 'E-1'), provenance: { ...draft('x', 'x', ['x'], 'E-1').provenance, sourceRoundId: 'round:1' } } as MemoryUnitDraft;
    const second = { ...draft('mem:source-b', 'Use visible state and flow to make controls self explanatory.', ['product.interaction', 'ui.visible-state'], 'E-2'), provenance: { ...draft('y', 'y', ['y'], 'E-2').provenance, sourceRoundId: 'round:2' } } as MemoryUnitDraft;
    const units = [first, second].map(value => ({ ...value, schemaVersion: 1 as const, revision: 1 }));
    const result = consolidateMemories(scope, units, at);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.supportingIds).toEqual(['mem:source-a', 'mem:source-b']);
    expect([first.canonicalText, second.canonicalText]).toContain(result.candidates[0]!.memory.canonicalText);
    expect(result.candidates[0]!.memory.canonicalText).not.toContain(' | ');
    expect(result.candidates[0]!.memory.confidence).toBeGreaterThan(0.85);
    expect(result.edges.map(edge => edge.relation)).toEqual(['derived_from', 'derived_from']);
  });

  test('ranks graph propagation by relation semantics and keeps conflict explainable', () => {
    const fx = fixture();
    const seed = recordCognitiveMemory(fx.store, fx.authority, draft('mem:relation-seed', 'Interaction guidance seed.', ['relation.seed'], 'E-1'));
    const support = recordCognitiveMemory(fx.store, fx.authority, draft('mem:relation-support', 'Supported guidance.', ['relation.support'], 'E-2'));
    const analogy = recordCognitiveMemory(fx.store, fx.authority, draft('mem:relation-analogy', 'Analogous guidance.', ['relation.analogy'], 'E-2'));
    const conflict = recordCognitiveMemory(fx.store, fx.authority, { ...draft('mem:relation-conflict', 'Conflicting guidance.', ['relation.conflict'], 'E-3'), counterEvidenceRefs: ['E-4'] });
    recordCognitiveMemoryEdge(fx.store, fx.authority, { id: 'edge:relation-support', scope, fromId: seed.id, toId: support.id, relation: 'supports', weight: 1, evidenceRefs: ['E-1'], recordedAt: at });
    recordCognitiveMemoryEdge(fx.store, fx.authority, { id: 'edge:relation-analogy', scope, fromId: seed.id, toId: analogy.id, relation: 'analogous_to', weight: 1, evidenceRefs: ['E-1'], recordedAt: at });
    recordCognitiveMemoryEdge(fx.store, fx.authority, { id: 'edge:relation-conflict', scope, fromId: seed.id, toId: conflict.id, relation: 'contradicts', weight: 1, evidenceRefs: ['E-1'], recordedAt: at });
    const pack = activateCognitiveMemory(fx.controllerHome, [scope], 'relation.seed', { seedConcepts: ['relation.seed'], maxItems: 8, maxGraphDepth: 1, now: at });
    const scores = new Map(pack.items.map(item => [item.memory.id, item.score]));
    expect(scores.get(support.id)!).toBeGreaterThan(scores.get(analogy.id)!);
    expect(scores.get(analogy.id)!).toBeGreaterThan(scores.get(conflict.id)!);
    expect(pack.items.find(item => item.memory.id === conflict.id)?.reasons).toContainEqual(expect.objectContaining({ signal: 'graph', detail: 'contradicts@1' }));
    expect(pack.items.find(item => item.memory.id === conflict.id)?.reasons).toContainEqual(expect.objectContaining({ signal: 'conflict' }));
  });

  test('supersedes edges prefer the correcting memory when traversed from old knowledge', () => {
    const fx = fixture();
    const old = recordCognitiveMemory(fx.store, fx.authority, draft('mem:old-guidance', 'Old guidance.', ['guidance.topic'], 'E-1'));
    const corrected = recordCognitiveMemory(fx.store, fx.authority, { ...draft('mem:new-guidance', 'Corrected guidance.', ['guidance.corrected'], 'E-2'), facets: ['knowledge', 'correction'] });
    recordCognitiveMemoryEdge(fx.store, fx.authority, { id: 'edge:supersedes-direction', scope, fromId: corrected.id, toId: old.id, relation: 'supersedes', weight: 1, evidenceRefs: ['E-3'], recordedAt: at });
    const fromOld = activateCognitiveMemory(fx.controllerHome, [scope], '', { seedMemoryIds: [old.id], maxItems: 8, maxGraphDepth: 1, now: at });
    const fromNew = activateCognitiveMemory(fx.controllerHome, [scope], '', { seedMemoryIds: [corrected.id], maxItems: 8, maxGraphDepth: 1, now: at });
    const oldToNew = fromOld.items.find(item => item.memory.id === corrected.id)?.reasons.find(reason => reason.detail === 'supersedes@1')?.score ?? 0;
    const newToOld = fromNew.items.find(item => item.memory.id === old.id)?.reasons.find(reason => reason.detail === 'supersedes@1')?.score ?? 0;
    expect(oldToNew).toBeGreaterThan(newToOld);
  });

  test('lets opportunistic recall require an associative cue without changing broad explicit retrieval', () => {
    const fx = fixture();
    const weak = recordCognitiveMemory(fx.store, fx.authority, {
      ...draft('mem:weak-cue', 'High quality reusable work guidance for an unrelated mobile design topic.', ['mobile.design'], 'E-1'),
      confidence: 0.99,
      utility: 0.99,
    });
    const query = 'work cognition recall cadence model attention semantic checkpoint strategy outcome evidence';
    const broad = activateCognitiveMemory(fx.controllerHome, [scope], query, { now: at, maxItems: 8 });
    expect(broad.items.map(item => item.memory.id)).toContain(weak.id);
    const opportunistic = activateCognitiveMemory(fx.controllerHome, [scope], query, {
      now: at,
      maxItems: 8,
      minCueScore: 0.12,
    });
    expect(opportunistic.items.map(item => item.memory.id)).not.toContain(weak.id);
  });

  test('does not penalize long CJK distilled memory when multiple current-task cues match', () => {
    const fx = fixture();
    const relevant = recordCognitiveMemory(fx.store, fx.authority, {
      ...draft(
        'mem:cjk-distilled',
        'Avela 的业务写入完成要区分持久化提交、当前页面可见状态发布，以及通知和共享快照等派生收敛。完成一次服药以后，库存应来自同一事实写链，通知只是可重建投影，当前 UI 不应等待所有远期收敛才更新。',
        ['avela.mutation.convergence'],
        'E-1',
      ),
      confidence: 0.9,
      utility: 0.9,
    });
    const generic = recordCognitiveMemory(fx.store, fx.authority, {
      ...draft(
        'mem:cjk-generic',
        '另一个很长的产品说明只偶然提到一次用户界面，但讨论的是完全不同的主题和历史材料。',
        ['other.product'],
        'E-2',
      ),
      confidence: 0.99,
      utility: 0.99,
    });
    const opportunistic = activateCognitiveMemory(
      fx.controllerHome,
      [scope],
      '用户完成一次服药后 UI、库存和通知应该如何收敛',
      { now: at, maxItems: 8, minCueScore: 0.12 },
    );
    expect(opportunistic.items.map(item => item.memory.id)).toContain(relevant.id);
    expect(opportunistic.items.map(item => item.memory.id)).not.toContain(generic.id);
  });

  test('does not apply CJK long-memory coverage to unrelated ASCII process cues', () => {
    const fx = fixture();
    const unrelated = recordCognitiveMemory(fx.store, fx.authority, {
      ...draft(
        'mem:ascii-noise',
        'Medication notification projection uses a single coordinator and command path for terminal actions, future planning, and local delivery cleanup.',
        ['avela.notification.projection'],
        'E-1',
      ),
      confidence: 0.99,
      utility: 0.99,
    });
    const opportunistic = activateCognitiveMemory(
      fx.controllerHome,
      [scope],
      'inspect local process pid for a stuck command',
      { now: at, maxItems: 8, minCueScore: 0.12 },
    );
    expect(opportunistic.items.map(item => item.memory.id)).not.toContain(unrelated.id);
  });

  test('does not let graph propagation alone admit unrelated opportunistic recall', () => {
    const fx = fixture();
    const seed = recordCognitiveMemory(fx.store, fx.authority, {
      ...draft('mem:direct-cue', 'Use local process inspection for an exact runtime pid.', ['runtime.process.inspect'], 'E-1'),
      confidence: 0.9,
      utility: 0.9,
    });
    const neighbor = recordCognitiveMemory(fx.store, fx.authority, {
      ...draft('mem:graph-only', 'Prefer native SwiftUI controls and accessibility semantics for mobile interfaces.', ['ios.swiftui'], 'E-2'),
      confidence: 0.95,
      utility: 0.95,
    });
    recordCognitiveMemoryEdge(fx.store, fx.authority, {
      id: 'edge:test-cross-topic',
      scope,
      fromId: seed.id,
      toId: neighbor.id,
      relation: 'analogous_to',
      weight: 0.9,
      evidenceRefs: ['E-1', 'E-2'],
      recordedAt: at,
    });
    const query = 'inspect local runtime process pid';
    const broad = activateCognitiveMemory(fx.controllerHome, [scope], query, { now: at, maxItems: 8 });
    expect(broad.items.map(item => item.memory.id)).toContain(neighbor.id);
    const opportunistic = activateCognitiveMemory(fx.controllerHome, [scope], query, {
      now: at,
      maxItems: 8,
      minCueScore: 0.12,
    });
    expect(opportunistic.items.map(item => item.memory.id)).toContain(seed.id);
    expect(opportunistic.items.map(item => item.memory.id)).not.toContain(neighbor.id);
  });

  test('applies used and rejected feedback to retrieval utility without mutating factual confidence', () => {
    const fx = fixture();
    const used = recordCognitiveMemory(fx.store, fx.authority, draft('mem:feedback-used', 'Reusable interaction guidance.', ['feedback.topic'], 'E-1'));
    const rejected = recordCognitiveMemory(fx.store, fx.authority, draft('mem:feedback-rejected', 'Alternative interaction guidance.', ['feedback.topic'], 'E-2'));
    const pack = activateCognitiveMemory(fx.controllerHome, [scope], 'feedback.topic', {
      seedConcepts: ['feedback.topic'], now: at, maxItems: 8,
      usageFeedback: [
        { address: { scope, id: used.id }, usedCount: 2, rejectedCount: 0, conflictCount: 0, staleCount: 0 },
        { address: { scope, id: rejected.id }, usedCount: 0, rejectedCount: 2, conflictCount: 0, staleCount: 0 },
      ],
    });
    const usedItem = pack.items.find(item => item.memory.id === used.id)!;
    const rejectedItem = pack.items.find(item => item.memory.id === rejected.id)!;
    expect(usedItem.score).toBeGreaterThan(rejectedItem.score);
    expect(usedItem.memory.confidence).toBe(used.confidence);
    expect(rejectedItem.memory.confidence).toBe(rejected.confidence);
    expect(usedItem.reasons).toContainEqual(expect.objectContaining({ signal: 'usage', detail: 'used:2;rejected:0' }));
    expect(rejectedItem.reasons).toContainEqual(expect.objectContaining({ signal: 'usage', detail: 'used:0;rejected:2' }));
  });

  test('routes stale or contradicted usage feedback through explainable conflict ranking', () => {
    const fx = fixture();
    const memory = recordCognitiveMemory(fx.store, fx.authority, draft('mem:feedback-stale', 'Previously relevant guidance.', ['feedback.stale'], 'E-1'));
    const pack = activateCognitiveMemory(fx.controllerHome, [scope], 'feedback.stale', {
      seedConcepts: ['feedback.stale'], now: at,
      usageFeedback: [{ address: { scope, id: memory.id }, usedCount: 0, rejectedCount: 1, conflictCount: 1, staleCount: 1 }],
    });
    const item = pack.items.find(candidate => candidate.memory.id === memory.id)!;
    expect(item.memory.counterEvidenceRefs).toEqual([]);
    expect(item.memory.confidence).toBe(memory.confidence);
    expect(item.reasons).toContainEqual(expect.objectContaining({ signal: 'conflict', detail: 'counter-evidence:0;feedback-conflict:1;stale:1' }));
  });

  test('audits canonical memory with provenance and relations through bounded read-only filters', () => {
    const fx = fixture();
    const first = recordCognitiveMemory(fx.store, fx.authority, draft('mem:audit-first', 'Interaction should be self explanatory.', ['product.interaction'], 'E-1'));
    const second = recordCognitiveMemory(fx.store, fx.authority, draft('mem:audit-second', 'Copy explains invisible rules.', ['copy.invisible-rules'], 'E-2'));
    recordCognitiveMemoryEdge(fx.store, fx.authority, {
      id: 'edge:audit-support', scope, fromId: first.id, toId: second.id, relation: 'supports',
      weight: 0.9, evidenceRefs: ['E-3'], recordedAt: at,
    });
    const audit = auditCognitiveMemory(fx.controllerHome, {
      scopes: [scope], concept: 'product.interaction', sourceKind: 'external', limit: 8,
    });
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]?.memory).toMatchObject({
      id: first.id,
      confidence: first.confidence,
      utility: first.utility,
      provenance: { sourceKind: 'external', evidenceRefs: ['E-1'] },
    });
    expect(audit.items[0]?.relations).toContainEqual(expect.objectContaining({
      id: 'edge:audit-support', relation: 'supports', toId: second.id,
    }));
    expect(audit.truncated).toBe(false);
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
    const success = memoryDraftFromLearningSignal({ schemaVersion: 1, id: 'success-1', scope, kind: 'success', valence: 'positive', summary: 'A scene-based teaching series produced better retention.', concepts: ['learning.scene', 'learning.retention'], admissionSource: 'verified_outcome', portability: 'local', salience: 0.9, confidence: 0.8, utility: 0.74, sourceKind: 'external', observedAt: at, evidenceRefs: ['E-1'] });
    const knowledge = memoryDraftFromLearningSignal({ schemaVersion: 1, id: 'knowledge-1', scope, kind: 'knowledge', valence: 'neutral', summary: 'Model-facing memory should remain semantic rather than bytecode.', concepts: ['memory.transport', 'model.semantic'], admissionSource: 'explicit_human', portability: 'local', salience: 0.7, confidence: 0.95, utility: 0.42, sourceKind: 'knowledge', observedAt: at, evidenceRefs: ['E-2'] });
    expect(success.facets).toContain('success');
    expect(success.facets).toContain('valence.positive');
    expect(success.facets).toContain('source.verified_outcome');
    expect(success.tier).toBe('warm');
    expect(knowledge.facets).toContain('knowledge');
    expect(knowledge.facets).toContain('source.explicit_human');
    expect(knowledge.confidence).toBe(0.95);
    expect(knowledge.utility).toBe(0.42);
    expect(knowledge.tier).toBe('warm');
  });

  test('admits one explicit human teaching immediately as advisory memory and recalls it without repetition', () => {
    const fx = fixture();
    const teaching = memoryDraftFromLearningSignal({
      schemaVersion: 1,
      id: 'teaching-self-explanatory-interaction',
      scope,
      kind: 'principle',
      valence: 'positive',
      summary: 'Copy should explain invisible rules, not interaction that should be self-evident from structure, state, and feedback.',
      concepts: ['product.interaction', 'copy.invisible-rules', 'ui.self-explanatory'],
      facets: ['product-design'],
      admissionSource: 'explicit_human',
      portability: 'local',
      salience: 0.96,
      confidence: 0.94,
      utility: 0.61,
      sourceKind: 'controller',
      sourceId: 'explicit-user-teaching:test',
      observedAt: at,
      evidenceRefs: ['E-1'],
    });
    const stored = recordCognitiveMemory(fx.store, fx.authority, teaching);
    const pack = activateCognitiveMemory(fx.controllerHome, [scope], 'self explanatory product interaction', {
      seedConcepts: ['product.interaction'],
      now: at,
    });
    expect(stored.facets).toContain('admission.advisory');
    expect(stored.facets).toContain('source.explicit_human');
    expect(stored.confidence).toBe(0.94);
    expect(stored.utility).toBe(0.61);
    expect(pack.items.map(item => item.memory.id)).toContain(stored.id);
  });

  test('keeps Workspace generalization model-authored instead of admission-source or kind gated', () => {
    const workspaceScope = { schemaVersion: 1 as const, kind: 'workspace' as const, id: 'workspace-cognition' };
    const base = {
      schemaVersion: 1 as const,
      id: 'single-round-inference',
      scope,
      kind: 'pattern' as const,
      valence: 'neutral' as const,
      summary: 'One round suggests a reusable engineering heuristic.',
      concepts: ['engineering.heuristic'],
      admissionSource: 'system_inference' as const,
      portability: 'local' as const,
      salience: 0.7,
      confidence: 0.6,
      utility: 0.55,
      sourceKind: 'system' as const,
      observedAt: at,
      evidenceRefs: ['E-1'],
    };
    expect(memoryDraftFromLearningSignal(base).scope).toEqual(scope);
    expect(() => memoryDraftFromLearningSignal({ ...base, scope: workspaceScope }))
      .toThrow('COGNITION_LEARNING_WORKSPACE_PORTABILITY_REQUIRED');

    const generalized = memoryDraftFromLearningSignal({
      ...base,
      id: 'model-generalized-workspace-learning',
      scope: workspaceScope,
      kind: 'architecture-pattern',
      admissionSource: 'system_inference',
      portability: 'portable',
      confidence: 0.95,
    });
    expect(generalized.facets).toContain('portability.portable');
    expect(generalized.facets).toContain('architecture-pattern');
    expect(generalized.tier).toBe('warm');
  });
});
