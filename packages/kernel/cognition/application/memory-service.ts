import type { ScopeRef } from '../../identity/api/index';
import {
  validateMemoryEdge,
  validateMemoryUnit,
  type MemoryEdge,
  type MemoryEdgeDraft,
  type MemoryUnit,
  type MemoryUnitDraft,
} from '../domain/memory';

/** Persistence is supplied by trusted composition; it is not a transport-facing authority. */
export interface CognitiveMemoryStorePort {
  transaction<T>(operation: () => T): T;
  read(scope: ScopeRef, id: string): MemoryUnit | undefined;
  write(memory: MemoryUnit, expectedRevision: number | null): MemoryUnit;
  writeEdge(edge: MemoryEdge): MemoryEdge;
}

/**
 * The Cognitive Plane owns knowledge semantics, never lifecycle authority.
 * Existing Kernel authorities decide whether a concrete producer may write.
 */
export interface CognitiveWriteAuthorityPort {
  assertMemoryWrite(memory: MemoryUnit): void;
  assertEdgeWrite(edge: MemoryEdge): void;
  evidenceAvailable(ref: string, scope: ScopeRef, sourceWorkId?: string): boolean;
}

function assertEvidence(authority: CognitiveWriteAuthorityPort, memory: MemoryUnit): void {
  for (const ref of [...memory.provenance.evidenceRefs, ...memory.counterEvidenceRefs]) {
    if (!authority.evidenceAvailable(ref, memory.scope, memory.provenance.sourceWorkId)) {
      throw new Error('COGNITION_EVIDENCE_UNAVAILABLE');
    }
  }
}

export function recordCognitiveMemory(
  store: CognitiveMemoryStorePort,
  authority: CognitiveWriteAuthorityPort,
  draft: MemoryUnitDraft,
): MemoryUnit {
  return store.transaction(() => {
    const existing = store.read(draft.scope, draft.id);
    const memory = validateMemoryUnit({ ...structuredClone(draft), schemaVersion: 1, revision: (existing?.revision ?? 0) + 1 });
    authority.assertMemoryWrite(memory);
    assertEvidence(authority, memory);
    return store.write(memory, existing?.revision ?? null);
  });
}

export function recordCognitiveMemoryEdge(
  store: CognitiveMemoryStorePort,
  authority: CognitiveWriteAuthorityPort,
  draft: MemoryEdgeDraft,
): MemoryEdge {
  return store.transaction(() => {
    const edge = validateMemoryEdge({ ...structuredClone(draft), schemaVersion: 1 });
    authority.assertEdgeWrite(edge);
    for (const ref of edge.evidenceRefs) {
      if (!authority.evidenceAvailable(ref, edge.scope, edge.sourceWorkId)) throw new Error('COGNITION_EDGE_EVIDENCE_UNAVAILABLE');
    }
    return store.writeEdge(edge);
  });
}
