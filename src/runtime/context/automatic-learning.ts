import { createHash } from 'crypto';
import type { ScopeRef } from '../../../packages/kernel/identity/api/index';
import {
  cognitiveTerms,
  consolidateMemories,
  inferMemoryAssociation,
  recordCognitiveMemory,
  recordCognitiveMemoryEdge,
  type CognitiveWriteAuthorityPort,
  type LearningSignal,
  type MemoryUnit,
} from '../../../packages/kernel/cognition/api/index';
import {
  cognitionMemoryStore,
  cognitionReadPort,
} from '../control-plane/persistence/cognition-store';

export type ControllerLearningScopeKind = 'requirement' | 'project' | 'workspace';
export type ControllerLearningAdmissionSource = 'explicit_human' | 'controller_observation' | 'system_inference';

/**
 * Model-authored semantic draft only. Identity, time and source provenance are
 * intentionally absent. Forge derives them at the persistence boundary from
 * direct non-lifecycle controller provenance and Project/Requirement/Workspace scope.
 */
export interface ControllerLearningSignalDraft {
  scopeKind: ControllerLearningScopeKind;
  kind: LearningSignal['kind'];
  valence: LearningSignal['valence'];
  summary: string;
  concepts: string[];
  facets: string[];
  admissionSource: ControllerLearningAdmissionSource;
  portability: LearningSignal['portability'];
  salience: number;
  confidence: number;
  utility: number;
  evidenceRefs: string[];
  counterEvidenceRefs: string[];
  expiresAt?: string;
}

const CONTROLLER_LEARNING_FIELDS = new Set([
  'scope_kind', 'kind', 'valence', 'summary', 'concepts', 'facets', 'admission_source',
  'portability', 'salience', 'confidence', 'utility', 'evidence_refs', 'counter_evidence_refs', 'expires_at',
]);
export const CONTROLLER_LEARNING_SIGNAL_ENVELOPE_MAX_ITEMS = 32;
const CONTROLLER_LEARNING_KIND = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
const CONTROLLER_LEARNING_VALENCES: readonly LearningSignal['valence'][] = ['positive', 'negative', 'neutral'];
const CONTROLLER_LEARNING_ADMISSION_SOURCES: readonly ControllerLearningAdmissionSource[] = ['explicit_human', 'controller_observation', 'system_inference'];
const CONTROLLER_LEARNING_SCOPE_KINDS: readonly ControllerLearningScopeKind[] = ['requirement', 'project', 'workspace'];

function boundedScore(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`COGNITION_CONTROLLER_LEARNING_${label}_INVALID`);
  }
  return value;
}

function boundedStrings(value: unknown, label: string, maxItems: number, maxLength: number, required = false): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || (required && value.length === 0) || value.length > maxItems) {
    throw new Error(`COGNITION_CONTROLLER_LEARNING_${label}_INVALID`);
  }
  const normalized = value.map(item => typeof item === 'string' ? item.trim() : '');
  if (normalized.some(item => !item || item.length > maxLength) || new Set(normalized).size !== normalized.length) {
    throw new Error(`COGNITION_CONTROLLER_LEARNING_${label}_INVALID`);
  }
  return normalized;
}

/** Validate the frozen MCP draft shape after disposition so learning errors never roll back lifecycle state. */
export function parseControllerLearningSignalDrafts(value: unknown): ControllerLearningSignalDraft[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > CONTROLLER_LEARNING_SIGNAL_ENVELOPE_MAX_ITEMS) throw new Error('COGNITION_CONTROLLER_LEARNING_SIGNALS_INVALID');
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`COGNITION_CONTROLLER_LEARNING_SIGNAL_INVALID:${index}`);
    const raw = entry as Record<string, unknown>;
    if (Object.keys(raw).some(key => !CONTROLLER_LEARNING_FIELDS.has(key))) throw new Error(`COGNITION_CONTROLLER_LEARNING_SIGNAL_FIELD_INVALID:${index}`);
    const scopeKind = raw.scope_kind;
    const kind = typeof raw.kind === 'string' ? raw.kind.trim() : '';
    const valence = raw.valence;
    const admissionSource = raw.admission_source;
    const portability = raw.portability;
    const summary = typeof raw.summary === 'string' ? raw.summary.trim().replace(/\s+/g, ' ') : '';
    if (!CONTROLLER_LEARNING_SCOPE_KINDS.includes(scopeKind as ControllerLearningScopeKind)) throw new Error(`COGNITION_CONTROLLER_LEARNING_SCOPE_INVALID:${index}`);
    if (!CONTROLLER_LEARNING_KIND.test(kind)) throw new Error(`COGNITION_CONTROLLER_LEARNING_KIND_INVALID:${index}`);
    if (!CONTROLLER_LEARNING_VALENCES.includes(valence as LearningSignal['valence'])) throw new Error(`COGNITION_CONTROLLER_LEARNING_VALENCE_INVALID:${index}`);
    if (!CONTROLLER_LEARNING_ADMISSION_SOURCES.includes(admissionSource as ControllerLearningAdmissionSource)) throw new Error(`COGNITION_CONTROLLER_LEARNING_ADMISSION_INVALID:${index}`);
    if (portability !== 'local' && portability !== 'portable') throw new Error(`COGNITION_CONTROLLER_LEARNING_PORTABILITY_INVALID:${index}`);
    if (scopeKind === 'workspace' && portability !== 'portable') {
      throw new Error(`COGNITION_CONTROLLER_LEARNING_WORKSPACE_PORTABILITY_REQUIRED:${index}`);
    }
    if (!summary || summary.length > 2_000) throw new Error(`COGNITION_CONTROLLER_LEARNING_SUMMARY_INVALID:${index}`);
    const expiresAt = typeof raw.expires_at === 'string' && raw.expires_at.trim() ? raw.expires_at.trim() : undefined;
    if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw new Error(`COGNITION_CONTROLLER_LEARNING_EXPIRY_INVALID:${index}`);
    return {
      scopeKind: scopeKind as ControllerLearningScopeKind,
      kind,
      valence: valence as LearningSignal['valence'],
      summary,
      concepts: boundedStrings(raw.concepts, 'CONCEPTS', 32, 256, true),
      facets: boundedStrings(raw.facets, 'FACETS', 12, 128),
      admissionSource: admissionSource as ControllerLearningAdmissionSource,
      portability: portability as LearningSignal['portability'],
      salience: boundedScore(raw.salience, 'SALIENCE'),
      confidence: boundedScore(raw.confidence, 'CONFIDENCE'),
      utility: boundedScore(raw.utility, 'UTILITY'),
      evidenceRefs: boundedStrings(raw.evidence_refs, 'EVIDENCE', 16, 512),
      counterEvidenceRefs: boundedStrings(raw.counter_evidence_refs, 'COUNTER_EVIDENCE', 16, 512),
      ...(expiresAt ? { expiresAt } : {}),
    };
  });
}

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function consolidationAuthority(input: {
  scope: ScopeRef;
  sourceMemories: readonly MemoryUnit[];
}): CognitiveWriteAuthorityPort {
  const supportIds = new Set(input.sourceMemories.map(memory => memory.id));
  const evidence = new Set(input.sourceMemories.flatMap(memory => [
    ...memory.provenance.evidenceRefs,
    ...memory.counterEvidenceRefs,
  ]));
  return {
    assertMemoryWrite(memory) {
      if (!sameScope(memory.scope, input.scope)
        || !memory.id.startsWith('consolidated:')
        || memory.provenance.sourceKind !== 'system') {
        throw new Error('COGNITION_AUTOMATIC_CONSOLIDATION_AUTHORITY_INVALID');
      }
    },
    assertEdgeWrite(edge) {
      if (!sameScope(edge.scope, input.scope)
        || !edge.fromId.startsWith('consolidated:')
        || !supportIds.has(edge.toId)) {
        throw new Error('COGNITION_AUTOMATIC_CONSOLIDATION_EDGE_INVALID');
      }
    },
    evidenceAvailable(ref, scope) {
      return sameScope(scope, input.scope) && evidence.has(ref);
    },
  };
}

function associationAuthority(input: {
  scope: ScopeRef;
  sourceMemories: readonly MemoryUnit[];
  relatedMemories: readonly MemoryUnit[];
}): CognitiveWriteAuthorityPort {
  const sourceIds = new Set(input.sourceMemories.map(memory => memory.id));
  const relatedIds = new Set(input.relatedMemories.map(memory => memory.id));
  const evidence = new Set([...input.sourceMemories, ...input.relatedMemories].flatMap(memory => [
    ...memory.provenance.evidenceRefs,
    ...memory.counterEvidenceRefs,
  ]));
  const allowedRelations = new Set(['supports', 'contradicts', 'analogous_to', 'supersedes']);
  return {
    assertMemoryWrite() {
      throw new Error('COGNITION_AUTOMATIC_ASSOCIATION_MEMORY_NOT_ALLOWED');
    },
    assertEdgeWrite(edge) {
      if (!sameScope(edge.scope, input.scope)
        || !sourceIds.has(edge.fromId)
        || !relatedIds.has(edge.toId)
        || !allowedRelations.has(edge.relation)) {
        throw new Error('COGNITION_AUTOMATIC_ASSOCIATION_AUTHORITY_INVALID');
      }
    },
    evidenceAvailable(ref, scope) {
      return sameScope(scope, input.scope) && evidence.has(ref);
    },
  };
}

function associationCandidates(controllerHome: string, memory: MemoryUnit, now: string): MemoryUnit[] {
  const port = cognitionReadPort(controllerHome);
  const candidates = new Map<string, MemoryUnit>();
  for (const candidate of port.exactByConcept([memory.scope], memory.concepts, 48, now)) candidates.set(candidate.id, candidate);
  const terms = [...cognitiveTerms(`${memory.canonicalText}\n${memory.concepts.join(' ')}`)].slice(0, 48);
  for (const candidate of port.lexical([memory.scope], terms, 64, now)) candidates.set(candidate.id, candidate);
  return [...candidates.values()]
    .filter(candidate => candidate.id !== memory.id)
    .filter(candidate => !candidate.id.startsWith('consolidated:') && !candidate.id.startsWith('promoted:') && !candidate.id.startsWith('candidate:'))
    .slice(0, 64);
}

export function associateStoredMemories(input: {
  controllerHome: string;
  memories: readonly MemoryUnit[];
  now: string;
}): number {
  const store = cognitionMemoryStore(input.controllerHome);
  const currentIds = new Set(input.memories.map(memory => memory.id));
  const seenPairs = new Set<string>();
  const drafts: Array<{
    scope: ScopeRef; from: MemoryUnit; to: MemoryUnit; relation: string; weight: number; evidenceRefs: string[];
  }> = [];
  for (const current of [...input.memories].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const candidate of associationCandidates(input.controllerHome, current, input.now)) {
      const pairKey = [current.id, candidate.id].sort().join('|');
      if (seenPairs.has(`${current.scope.kind}:${current.scope.id}:${pairKey}`)) continue;
      seenPairs.add(`${current.scope.kind}:${current.scope.id}:${pairKey}`);

      let from = current;
      let to = candidate;
      if (currentIds.has(candidate.id)) {
        const candidateCorrection = candidate.facets.includes('correction');
        const currentCorrection = current.facets.includes('correction');
        if ((candidateCorrection && !currentCorrection)
          || (candidateCorrection === currentCorrection && candidate.id.localeCompare(current.id) < 0)) {
          from = candidate;
          to = current;
        }
      }
      if (!currentIds.has(from.id)) continue;
      const association = inferMemoryAssociation(from, to);
      if (!association) continue;
      drafts.push({
        scope: from.scope,
        from,
        to,
        relation: association.relation,
        weight: association.weight,
        evidenceRefs: [...new Set([
          ...from.provenance.evidenceRefs,
          ...from.counterEvidenceRefs,
          ...to.provenance.evidenceRefs,
          ...to.counterEvidenceRefs,
        ])].slice(0, 64),
      });
    }
  }

  const byScope = new Map<string, typeof drafts>();
  for (const draft of drafts) {
    const key = `${draft.scope.kind}:${draft.scope.id}`;
    const group = byScope.get(key) ?? [];
    group.push(draft);
    byScope.set(key, group);
  }
  for (const group of byScope.values()) {
    const scope = group[0]!.scope;
    const sourceMemories = [...new Map(group.map(item => [item.from.id, item.from])).values()];
    const relatedMemories = [...new Map(group.map(item => [item.to.id, item.to])).values()];
    const authority = associationAuthority({
      scope,
      sourceMemories,
      relatedMemories,
    });
    for (const draft of group) {
      const key = createHash('sha256')
        .update(`${scope.kind}:${scope.id}:${draft.from.id}:${draft.relation}:${draft.to.id}`)
        .digest('hex')
        .slice(0, 28);
      recordCognitiveMemoryEdge(store, authority, {
        id: `edge:auto-association:${key}`,
        scope,
        fromId: draft.from.id,
        toId: draft.to.id,
        relation: draft.relation,
        weight: draft.weight,
        evidenceRefs: draft.evidenceRefs,
        recordedAt: input.now,
      });
    }
  }
  return drafts.length;
}

export interface ConsolidatedLearning {
  memory: MemoryUnit;
  supportingMemories: MemoryUnit[];
}

export function consolidateAffectedMemories(
  controllerHome: string,
  scope: ScopeRef,
  triggers: readonly MemoryUnit[],
  now: string,
): ConsolidatedLearning[] {
  const relevantTriggers = triggers.filter(memory => sameScope(memory.scope, scope));
  if (!relevantTriggers.length) return [];
  const port = cognitionReadPort(controllerHome);
  const sources = new Map<string, MemoryUnit>();
  for (const trigger of relevantTriggers) {
    sources.set(trigger.id, trigger);
    for (const memory of port.exactByConcept([scope], trigger.concepts, 64, now)) sources.set(memory.id, memory);
    const terms = [...cognitiveTerms(`${trigger.canonicalText}\n${trigger.concepts.join(' ')}`)].slice(0, 48);
    for (const memory of port.lexical([scope], terms, 64, now)) sources.set(memory.id, memory);
  }
  const sourceMemories = [...sources.values()]
    .filter(memory => memory.facets.includes('learning'))
    .filter(memory => !memory.id.startsWith('consolidated:')
      && !memory.id.startsWith('promoted:')
      && !memory.id.startsWith('candidate:'))
    .slice(0, 128);
  if (sourceMemories.length < 2) return [];
  const result = consolidateMemories(scope, sourceMemories, now);
  const store = cognitionMemoryStore(controllerHome);
  const authority = consolidationAuthority({ scope, sourceMemories });
  const persisted = new Map<string, ConsolidatedLearning>();
  for (const candidate of result.candidates) {
    let memory = store.read(scope, candidate.memory.id);
    if (!memory) {
      const { schemaVersion: _schemaVersion, revision: _revision, ...draft } = candidate.memory;
      memory = recordCognitiveMemory(store, authority, draft);
    }
    const supportingIds = new Set(candidate.supportingIds);
    persisted.set(memory.id, {
      memory,
      supportingMemories: sourceMemories.filter(source => supportingIds.has(source.id)),
    });
  }
  for (const edge of result.edges) {
    const { schemaVersion: _schemaVersion, ...draft } = edge;
    recordCognitiveMemoryEdge(store, authority, draft);
  }
  return [...persisted.values()];
}
