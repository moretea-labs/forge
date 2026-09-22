import { createHash } from 'crypto';
import type { ScopeRef } from '../../../packages/kernel/identity/api/index';
import { getRepository } from '../../cli/repositories/registry';
import {
  cognitiveTerms,
  consolidateMemories,
  inferMemoryAssociation,
  memoryDraftFromLearningSignal,
  recordCognitiveMemory,
  recordCognitiveMemoryEdge,
  type CognitiveWriteAuthorityPort,
  type LearningSignal,
  type MemoryUnit,
  type MemoryUnitDraft,
} from '../../../packages/kernel/cognition/api/index';
import {
  getControllerRoundRelay,
  type ExecutionQualitySignal,
} from '../../../packages/kernel/controller/api/index';
import { getWorkContract, type WorkContract } from '../../../packages/kernel/work/api/index';
import {
  canonicalWorkflowEvidenceAvailable,
  cognitiveScopesForWork,
  experienceScopesForWork,
  recordClosedRoundExperience,
  recordClosedRoundOutcomeObservation,
} from '../control-plane/persistence/experience-store';
import {
  cognitionMemoryStore,
  cognitionReadPort,
} from '../control-plane/persistence/cognition-store';

export interface AutomaticControllerLearningResult {
  storedMemoryIds: string[];
  consolidatedMemoryIds: string[];
  promotedMemoryIds: string[];
  requirementCandidateIds: string[];
  repairOutcomeObservationIds?: string[];
  repairExperienceIds?: string[];
  skipped: string[];
}

export type ControllerLearningScopeKind = 'work' | 'requirement' | 'project' | 'workspace';
export type ControllerLearningAdmissionSource = 'explicit_human' | 'controller_observation' | 'system_inference';

/**
 * Model-authored semantic draft only. Identity, time, source Work/Round and source kind
 * are intentionally absent and are derived from the exact ControllerRound by Forge.
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
const CONTROLLER_LEARNING_KINDS: readonly LearningSignal['kind'][] = [
  'knowledge', 'success', 'failure', 'novelty', 'correction', 'contradiction', 'pattern', 'preference', 'principle', 'procedure',
];
const CONTROLLER_LEARNING_VALENCES: readonly LearningSignal['valence'][] = ['positive', 'negative', 'neutral'];
const CONTROLLER_LEARNING_ADMISSION_SOURCES: readonly ControllerLearningAdmissionSource[] = ['explicit_human', 'controller_observation', 'system_inference'];
const CONTROLLER_LEARNING_SCOPE_KINDS: readonly ControllerLearningScopeKind[] = ['work', 'requirement', 'project', 'workspace'];

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
  if (!Array.isArray(value) || value.length > 8) throw new Error('COGNITION_CONTROLLER_LEARNING_SIGNALS_INVALID');
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`COGNITION_CONTROLLER_LEARNING_SIGNAL_INVALID:${index}`);
    const raw = entry as Record<string, unknown>;
    if (Object.keys(raw).some(key => !CONTROLLER_LEARNING_FIELDS.has(key))) throw new Error(`COGNITION_CONTROLLER_LEARNING_SIGNAL_FIELD_INVALID:${index}`);
    const scopeKind = raw.scope_kind;
    const kind = raw.kind;
    const valence = raw.valence;
    const admissionSource = raw.admission_source;
    const portability = raw.portability;
    const summary = typeof raw.summary === 'string' ? raw.summary.trim().replace(/\s+/g, ' ') : '';
    if (!CONTROLLER_LEARNING_SCOPE_KINDS.includes(scopeKind as ControllerLearningScopeKind)) throw new Error(`COGNITION_CONTROLLER_LEARNING_SCOPE_INVALID:${index}`);
    if (!CONTROLLER_LEARNING_KINDS.includes(kind as LearningSignal['kind'])) throw new Error(`COGNITION_CONTROLLER_LEARNING_KIND_INVALID:${index}`);
    if (!CONTROLLER_LEARNING_VALENCES.includes(valence as LearningSignal['valence'])) throw new Error(`COGNITION_CONTROLLER_LEARNING_VALENCE_INVALID:${index}`);
    if (!CONTROLLER_LEARNING_ADMISSION_SOURCES.includes(admissionSource as ControllerLearningAdmissionSource)) throw new Error(`COGNITION_CONTROLLER_LEARNING_ADMISSION_INVALID:${index}`);
    if (portability !== 'local' && portability !== 'portable') throw new Error(`COGNITION_CONTROLLER_LEARNING_PORTABILITY_INVALID:${index}`);
    if (scopeKind === 'workspace' && (admissionSource !== 'explicit_human' || portability !== 'portable')) {
      throw new Error(`COGNITION_CONTROLLER_LEARNING_WORKSPACE_REQUIRES_EXPLICIT_PORTABLE_HUMAN:${index}`);
    }
    if (!summary || summary.length > 2_000) throw new Error(`COGNITION_CONTROLLER_LEARNING_SUMMARY_INVALID:${index}`);
    const expiresAt = typeof raw.expires_at === 'string' && raw.expires_at.trim() ? raw.expires_at.trim() : undefined;
    if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw new Error(`COGNITION_CONTROLLER_LEARNING_EXPIRY_INVALID:${index}`);
    return {
      scopeKind: scopeKind as ControllerLearningScopeKind,
      kind: kind as LearningSignal['kind'],
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

function preferredLearningScope(work: WorkContract, controllerHome: string): ScopeRef {
  const scopes = experienceScopesForWork(work, controllerHome);
  return scopes.find(scope => scope.kind === 'project')
    ?? scopes.find(scope => scope.kind === 'requirement')
    ?? scopes[0]!;
}

function controllerLearningScope(work: WorkContract, controllerHome: string, kind: ControllerLearningScopeKind): ScopeRef | undefined {
  const scopes = kind === 'workspace' ? cognitiveScopesForWork(work, controllerHome) : experienceScopesForWork(work, controllerHome);
  return scopes.find(scope => scope.kind === kind);
}

function normalizedConcepts(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean).map(value => value.slice(0, 256)))].slice(0, 64);
}

function signalId(prefix: string, identity: string): string {
  return `auto:${prefix}:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

function sourceRoundObserved(input: { controllerHome: string; repoId: string; workId: string; sourceRoundId: string }): boolean {
  const relay = getControllerRoundRelay({ controllerHome: input.controllerHome, repoId: input.repoId }, input.workId);
  return Boolean(relay?.observationWindow?.some(observation => observation.roundRef === input.sourceRoundId));
}

function roundDerivedAuthority(input: {
  controllerHome: string;
  repoId: string;
  work: WorkContract;
  sourceRoundId: string;
}): CognitiveWriteAuthorityPort {
  const allowedScopes = experienceScopesForWork(input.work, input.controllerHome);
  const workspaceScopes = cognitiveScopesForWork(input.work, input.controllerHome).filter(scope => scope.kind === 'workspace');
  const localScopeAllowed = (scope: ScopeRef) => allowedScopes.some(candidate => sameScope(candidate, scope));
  const scopeAllowed = (memory: MemoryUnit) => localScopeAllowed(memory.scope)
    || workspaceScopes.some(candidate => sameScope(candidate, memory.scope))
      && memory.facets.includes('source.explicit_human')
      && memory.facets.includes('portability.portable');
  return {
    assertMemoryWrite(memory) {
      if (memory.provenance.sourceWorkId !== input.work.workId
        || memory.provenance.sourceRoundId !== input.sourceRoundId
        || !scopeAllowed(memory)
        || !sourceRoundObserved({
          controllerHome: input.controllerHome,
          repoId: input.repoId,
          workId: input.work.workId,
          sourceRoundId: input.sourceRoundId,
        })) {
        throw new Error('COGNITION_AUTOMATIC_LEARNING_ROUND_AUTHORITY_INVALID');
      }
    },
    assertEdgeWrite() {
      throw new Error('COGNITION_AUTOMATIC_LEARNING_EDGE_NOT_ALLOWED');
    },
    evidenceAvailable(ref, scope, sourceWorkId) {
      const scopeReadable = localScopeAllowed(scope) || workspaceScopes.some(candidate => sameScope(candidate, scope));
      return sourceWorkId === input.work.workId
        && scopeReadable
        && canonicalWorkflowEvidenceAvailable(
          { controllerHome: input.controllerHome, repoId: input.repoId },
          ref,
          scope,
          sourceWorkId,
        );
    },
  };
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
        || memory.provenance.sourceKind !== 'system'
        || memory.provenance.sourceWorkId
        || memory.provenance.sourceRoundId) {
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
  controllerHome: string;
  repoId: string;
  work: WorkContract;
  scope: ScopeRef;
  sourceRoundId: string;
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
        || edge.sourceWorkId !== input.work.workId
        || edge.sourceRoundId !== input.sourceRoundId
        || !sourceIds.has(edge.fromId)
        || !relatedIds.has(edge.toId)
        || !allowedRelations.has(edge.relation)
        || !sourceRoundObserved({
          controllerHome: input.controllerHome,
          repoId: input.repoId,
          workId: input.work.workId,
          sourceRoundId: input.sourceRoundId,
        })) {
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

function associateStoredMemories(input: {
  controllerHome: string;
  repoId: string;
  work: WorkContract;
  sourceRoundId: string;
  memories: readonly MemoryUnit[];
  now: string;
}): void {
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
      controllerHome: input.controllerHome,
      repoId: input.repoId,
      work: input.work,
      scope,
      sourceRoundId: input.sourceRoundId,
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
        sourceWorkId: input.work.workId,
        sourceRoundId: input.sourceRoundId,
        recordedAt: input.now,
      });
    }
  }
}

interface ConsolidatedLearning {
  memory: MemoryUnit;
  supportingMemories: MemoryUnit[];
}

function workspacePromotionScope(work: WorkContract, controllerHome: string, projectScope: ScopeRef): ScopeRef | undefined {
  if (projectScope.kind !== 'project') return undefined;
  return cognitiveScopesForWork(work, controllerHome).find(scope => scope.kind === 'workspace');
}

function workspacePromotionAuthority(input: {
  scope: ScopeRef;
  projectScope: ScopeRef;
  sourceMemories: readonly MemoryUnit[];
}): CognitiveWriteAuthorityPort {
  const evidence = new Set(input.sourceMemories.flatMap(memory => [
    ...memory.provenance.evidenceRefs,
    ...memory.counterEvidenceRefs,
  ]));
  return {
    assertMemoryWrite(memory) {
      if (!sameScope(memory.scope, input.scope)
        || !memory.id.startsWith('promoted:')
        || memory.provenance.sourceKind !== 'system'
        || !memory.provenance.sourceId?.startsWith(`project-learning-promotion:${input.projectScope.id}:`)
        || memory.provenance.sourceWorkId
        || memory.provenance.sourceRoundId) {
        throw new Error('COGNITION_WORKSPACE_PROMOTION_AUTHORITY_INVALID');
      }
    },
    assertEdgeWrite() {
      throw new Error('COGNITION_WORKSPACE_PROMOTION_EDGE_NOT_ALLOWED');
    },
    evidenceAvailable(ref, scope) {
      return sameScope(scope, input.scope) && evidence.has(ref);
    },
  };
}

function reusableEngineeringPattern(candidate: ConsolidatedLearning): boolean {
  const sourceRounds = new Set(candidate.supportingMemories
    .map(memory => memory.provenance.sourceRoundId)
    .filter((value): value is string => Boolean(value)));
  const concepts = candidate.memory.concepts;
  return candidate.supportingMemories.length >= 3
    && sourceRounds.size >= 3
    && candidate.memory.facets.includes('automatic')
    && concepts.some(concept => concept.startsWith('forge.execution-quality.') || concept === 'forge.engineering-blocker');
}

function requirementCandidatePattern(memory: MemoryUnit): boolean {
  if (memory.facets.includes('valence.positive')) return false;
  return memory.facets.some(facet => [
    'repeated_root_cause',
    'suspected_regression',
    'failure',
    'correction',
    'regressed',
    'engineering-blocker',
  ].includes(facet));
}

function workspaceRequirementCandidateAuthority(input: {
  scope: ScopeRef;
  sourceMemories: readonly MemoryUnit[];
}): CognitiveWriteAuthorityPort {
  const sourceIds = new Set(input.sourceMemories.map(memory => memory.id));
  const evidence = new Set(input.sourceMemories.flatMap(memory => [
    ...memory.provenance.evidenceRefs,
    ...memory.counterEvidenceRefs,
  ]));
  return {
    assertMemoryWrite(memory) {
      const sourceId = memory.provenance.sourceId?.replace(/^cognitive-requirement-candidate:/, '');
      if (!sameScope(memory.scope, input.scope)
        || !memory.id.startsWith('candidate:')
        || memory.provenance.sourceKind !== 'system'
        || !sourceId
        || !sourceIds.has(sourceId)
        || memory.provenance.sourceWorkId
        || memory.provenance.sourceRoundId) {
        throw new Error('COGNITION_REQUIREMENT_CANDIDATE_AUTHORITY_INVALID');
      }
    },
    assertEdgeWrite() {
      throw new Error('COGNITION_REQUIREMENT_CANDIDATE_EDGE_NOT_ALLOWED');
    },
    evidenceAvailable(ref, scope) {
      return sameScope(scope, input.scope) && evidence.has(ref);
    },
  };
}

function materializeRequirementCandidates(input: {
  controllerHome: string;
  workspaceScope: ScopeRef;
  promotedMemoryIds: readonly string[];
  now: string;
}): string[] {
  if (!input.promotedMemoryIds.length) return [];
  const store = cognitionMemoryStore(input.controllerHome);
  const sources = input.promotedMemoryIds
    .map(id => store.read(input.workspaceScope, id))
    .filter((memory): memory is MemoryUnit => Boolean(memory))
    .filter(requirementCandidatePattern);
  if (!sources.length) return [];
  const authority = workspaceRequirementCandidateAuthority({
    scope: input.workspaceScope,
    sourceMemories: sources,
  });
  const candidates: string[] = [];
  for (const source of sources) {
    const key = createHash('sha256')
      .update(`${input.workspaceScope.id}:${source.id}`)
      .digest('hex')
      .slice(0, 32);
    const id = `candidate:${key}`;
    if (!store.read(input.workspaceScope, id)) {
      recordCognitiveMemory(store, authority, {
        id,
        scope: input.workspaceScope,
        facets: [...new Set([
          'candidate-finding',
          'requirement-candidate',
          'advisory',
          'engineering-improvement',
          ...source.facets,
        ])].slice(0, 16),
        canonicalText: `Candidate finding for normal Requirement promotion only; do not apply as policy or implementation authority. Corroborated Workspace engineering pattern: ${source.canonicalText}`.slice(0, 8_192),
        concepts: [...new Set([
          'forge.requirement-candidate',
          'forge.engineering-improvement',
          ...source.concepts,
        ])].slice(0, 64),
        provenance: {
          sourceKind: 'system',
          sourceId: `cognitive-requirement-candidate:${source.id}`,
          recordedAt: input.now,
          evidenceRefs: source.provenance.evidenceRefs,
        },
        confidence: source.confidence,
        utility: source.utility,
        tier: 'warm',
        validFrom: input.now,
        counterEvidenceRefs: source.counterEvidenceRefs,
      });
    }
    candidates.push(id);
  }
  return [...new Set(candidates)];
}

function promoteConsolidatedLearning(input: {
  controllerHome: string;
  workspaceScope: ScopeRef;
  projectScope: ScopeRef;
  candidates: readonly ConsolidatedLearning[];
  now: string;
}): string[] {
  const promotable = input.candidates.filter(reusableEngineeringPattern);
  if (!promotable.length) return [];
  const sourceMemories = promotable.map(candidate => candidate.memory);
  const authority = workspacePromotionAuthority({
    scope: input.workspaceScope,
    projectScope: input.projectScope,
    sourceMemories,
  });
  const store = cognitionMemoryStore(input.controllerHome);
  const promoted: string[] = [];
  for (const candidate of promotable) {
    const source = candidate.memory;
    const key = createHash('sha256')
      .update(`${input.workspaceScope.id}:${input.projectScope.id}:${source.id}`)
      .digest('hex')
      .slice(0, 32);
    const id = `promoted:${key}`;
    const existing = store.read(input.workspaceScope, id);
    if (!existing) {
      recordCognitiveMemory(store, authority, {
        id,
        scope: input.workspaceScope,
        facets: [...new Set(['knowledge', 'pattern', 'engineering-principle', 'cross-project', ...source.facets])].slice(0, 16),
        canonicalText: source.canonicalText,
        concepts: source.concepts,
        provenance: {
          sourceKind: 'system',
          sourceId: `project-learning-promotion:${input.projectScope.id}:${source.id}`,
          recordedAt: input.now,
          evidenceRefs: source.provenance.evidenceRefs,
        },
        confidence: source.confidence,
        utility: Math.min(1, source.utility + 0.05),
        tier: 'warm',
        validFrom: input.now,
        counterEvidenceRefs: source.counterEvidenceRefs,
      });
    }
    promoted.push(id);
  }
  return [...new Set(promoted)];
}

function persistDraft(
  controllerHome: string,
  authority: CognitiveWriteAuthorityPort,
  draft: MemoryUnitDraft,
): MemoryUnit {
  const store = cognitionMemoryStore(controllerHome);
  const existing = store.read(draft.scope, draft.id);
  if (existing) return existing;
  return recordCognitiveMemory(store, authority, draft);
}

function currentPassedVerificationEvidence(work: WorkContract): Array<{ checkId: string; receiptId: string; recordedAt: string }> {
  const latest = new Map<string, WorkContract['checkRefs'][number]>();
  for (const record of work.checkRefs) {
    if (!latest.has(record.checkId)) latest.set(record.checkId, record);
  }
  return [...latest.values()].flatMap(record => {
    const receiptId = record.receipt?.status === 'passed' ? record.receipt.receiptId?.trim() : '';
    if (record.outcome !== 'valid_pass' || record.staleReason || !receiptId) return [];
    return [{ checkId: record.checkId, receiptId, recordedAt: record.recordedAt }];
  }).sort((left, right) => left.checkId.localeCompare(right.checkId));
}

function persistVerifiedRepairLearning(input: {
  controllerHome: string;
  repoId: string;
  work: WorkContract;
  scope: ScopeRef;
  sourceRoundId: string;
  observedAt: string;
  cognitionAuthority: CognitiveWriteAuthorityPort;
}): { outcomeId?: string; experienceId?: string; memory?: MemoryUnit; skipped?: string } {
  if (!input.work.requestId?.startsWith('forge-incident-repair:')) return {};
  if (input.work.phaseEvidence.verification.state !== 'satisfied') return { skipped: 'repair:verification_not_satisfied' };
  const evidence = currentPassedVerificationEvidence(input.work);
  if (!evidence.length) return { skipped: 'repair:current_passed_verification_evidence_unavailable' };
  const repository = getRepository(input.repoId, input.controllerHome);
  const github = repository.github;
  if (!github?.owner?.trim() || !github.repo?.trim()) return { skipped: 'repair:repository_https_identity_unavailable' };

  const observedAtMs = Date.parse(input.observedAt);
  const windowStart = evidence
    .map(item => item.recordedAt)
    .filter(value => Number.isFinite(Date.parse(value)) && Date.parse(value) <= observedAtMs)
    .sort()[0] ?? input.observedAt;
  const digest = createHash('sha256')
    .update(`${input.work.workId}\0${input.sourceRoundId}\0${evidence.map(item => item.receiptId).join(',')}`)
    .digest('hex')
    .slice(0, 24);
  const outcomeId = `repair-outcome:${digest}`;
  const experienceId = `repair-experience:${digest}`;
  const memoryId = `learning:auto:repair:${digest}`;
  const source = { workId: input.work.workId, sourceRoundId: input.sourceRoundId };
  const evidenceRefs = [...new Set(evidence.map(item => item.receiptId))].slice(0, 30);
  const statement = `Verified recurrent Forge repair candidate ${input.work.requestId} passed ${evidence.length} current checks for "${input.work.objective.slice(0, 900)}". This is evidence-backed advisory learning; mandatory approval, verification, release, and known-good gates remain authoritative.`;

  const outcome = recordClosedRoundOutcomeObservation({
    controllerHome: input.controllerHome,
    repoId: input.repoId,
    authority: source,
    observation: {
      schemaVersion: 1,
      id: outcomeId,
      scope: input.scope,
      sourceWorkId: input.work.workId,
      sourceRoundId: input.sourceRoundId,
      evidenceRef: evidenceRefs[0]!,
      remoteObject: {
        id: `${github.owner}/${github.repo}`,
        url: `https://github.com/${github.owner}/${github.repo}`,
        account: github.owner,
        channel: 'repository',
      },
      observedAt: input.observedAt,
      window: { start: windowStart, end: input.observedAt },
      metrics: [
        { name: 'current_verification_checks_passed', unit: 'checks', value: evidence.length, cumulative: false },
        { name: 'verification_gate_satisfied', unit: 'boolean', value: 1, cumulative: false },
      ],
    },
    now: input.observedAt,
  });

  const experience = recordClosedRoundExperience({
    controllerHome: input.controllerHome,
    repoId: input.repoId,
    authority: source,
    record: {
      schemaVersion: 1,
      revision: 1,
      id: experienceId,
      scope: input.scope,
      applicability: {},
      kind: 'lesson',
      statement,
      evidenceRefs: [outcome.id, ...evidenceRefs].slice(0, 32),
      sourceWorkId: input.work.workId,
      sourceRoundId: input.sourceRoundId,
      recordedAt: input.observedAt,
      durableRationale: 'Verified repair evidence may guide future Forge diagnosis, but learned guidance is advisory and cannot alter mandatory checks, approval, release, or known-good authority.',
      counterEvidenceRefs: [],
    },
    now: input.observedAt,
  });

  const memory = persistDraft(input.controllerHome, input.cognitionAuthority, {
    id: memoryId,
    scope: input.scope,
    facets: ['automatic', 'verified-repair', 'outcome-backed'],
    canonicalText: statement,
    concepts: normalizedConcepts(['forge.repair', 'forge.incident-repair', 'forge.verified-repair', ...(input.work.engineeringContext?.semanticScope?.keys ?? [])]),
    provenance: {
      sourceKind: 'outcome',
      sourceId: outcome.id,
      sourceWorkId: input.work.workId,
      sourceRoundId: input.sourceRoundId,
      recordedAt: input.observedAt,
      evidenceRefs: [outcome.id, ...evidenceRefs].slice(0, 32),
    },
    confidence: 1,
    utility: 0.9,
    tier: 'warm',
    validFrom: input.observedAt,
    counterEvidenceRefs: [],
  });
  return { outcomeId: outcome.id, experienceId: experience.id, memory };
}

function signalLearningDraft(input: {
  signal: ExecutionQualitySignal;
  work: WorkContract;
  scope: ScopeRef;
  sourceRoundId: string;
  observedAt: string;
}): MemoryUnitDraft {
  const fingerprint = input.signal.fingerprint ?? signalId(input.signal.code, JSON.stringify(input.signal.evidenceRefs));
  const kind: LearningSignal['kind'] = input.signal.code === 'suspected_regression'
    ? 'failure'
    : input.signal.code === 'repeated_root_cause'
      ? 'pattern'
      : 'pattern';
  const learning: LearningSignal = {
    schemaVersion: 1,
    id: signalId(`quality.${input.signal.code}`, fingerprint),
    scope: input.scope,
    kind,
    valence: input.signal.code === 'suspected_regression' ? 'negative' : 'neutral',
    summary: `Execution quality signal ${input.signal.code} while working on "${input.work.objective.slice(0, 400)}": ${input.signal.observation}`,
    concepts: normalizedConcepts([
      `forge.execution-quality.${input.signal.code}`,
      ...(input.work.engineeringContext?.semanticScope?.keys ?? []),
    ]),
    facets: ['automatic', 'execution-quality', input.signal.code],
    admissionSource: 'execution_quality',
    portability: 'local',
    salience: input.signal.code === 'repeated_root_cause' ? 0.9 : 0.72,
    confidence: input.signal.code === 'suspected_regression' ? 0.62 : 0.82,
    utility: input.signal.code === 'repeated_root_cause' ? 0.84 : 0.68,
    sourceKind: 'system',
    sourceId: `execution-quality:${fingerprint}`,
    sourceWorkId: input.work.workId,
    sourceRoundId: input.sourceRoundId,
    observedAt: input.observedAt,
    evidenceRefs: [...new Set(input.signal.evidenceRefs)].slice(0, 64),
  };
  return memoryDraftFromLearningSignal(learning);
}

function controllerLearningDraft(input: {
  signal: ControllerLearningSignalDraft;
  work: WorkContract;
  scope: ScopeRef;
  sourceRoundId: string;
  observedAt: string;
}): MemoryUnitDraft {
  const concepts = normalizedConcepts(input.signal.concepts);
  const facets = [...new Set(input.signal.facets.map(value => value.trim()).filter(Boolean))].slice(0, 12);
  const semanticIdentity = JSON.stringify({
    sourceRoundId: input.sourceRoundId,
    scope: `${input.scope.kind}:${input.scope.id}`,
    kind: input.signal.kind,
    valence: input.signal.valence,
    summary: input.signal.summary,
    concepts: [...concepts].sort(),
    admissionSource: input.signal.admissionSource,
    portability: input.signal.portability,
  });
  const id = signalId('controller', semanticIdentity);
  const learning: LearningSignal = {
    schemaVersion: 1,
    id,
    scope: input.scope,
    kind: input.signal.kind,
    valence: input.signal.valence,
    summary: input.signal.summary,
    concepts,
    facets,
    admissionSource: input.signal.admissionSource,
    portability: input.signal.portability,
    salience: input.signal.salience,
    confidence: input.signal.confidence,
    utility: input.signal.utility,
    sourceKind: 'controller',
    sourceId: `controller-learning:${id.slice(id.lastIndexOf(':') + 1)}`,
    sourceWorkId: input.work.workId,
    sourceRoundId: input.sourceRoundId,
    observedAt: input.observedAt,
    evidenceRefs: input.signal.evidenceRefs,
    counterEvidenceRefs: input.signal.counterEvidenceRefs,
    ...(input.signal.expiresAt ? { expiresAt: input.signal.expiresAt } : {}),
  };
  return memoryDraftFromLearningSignal(learning);
}

function blockerLearningDraft(input: {
  blocker: NonNullable<NonNullable<WorkContract['engineeringContext']>['blockerDispositions']>[number];
  work: WorkContract;
  scope: ScopeRef;
  sourceRoundId: string;
  observedAt: string;
}): MemoryUnitDraft {
  const learning: LearningSignal = {
    schemaVersion: 1,
    id: signalId('engineering-blocker', input.blocker.receiptId),
    scope: input.scope,
    kind: input.blocker.classification === 'unrelated' ? 'novelty' : 'principle',
    valence: 'negative',
    summary: `Controller-confirmed engineering blocker ${input.blocker.blockerId} (${input.blocker.classification}): ${input.blocker.rationale}`,
    concepts: normalizedConcepts([
      'forge.engineering-blocker',
      input.blocker.blockerId,
      ...input.blocker.semanticScopeKeys,
    ]),
    facets: ['automatic', 'engineering-blocker', input.blocker.classification],
    admissionSource: 'controller_observation',
    portability: 'local',
    salience: input.blocker.classification === 'unrelated' ? 0.62 : 0.92,
    confidence: 0.95,
    utility: input.blocker.classification === 'unrelated' ? 0.58 : 0.86,
    sourceKind: 'controller',
    sourceId: input.blocker.receiptId,
    sourceWorkId: input.work.workId,
    sourceRoundId: input.sourceRoundId,
    observedAt: input.observedAt,
    evidenceRefs: [input.blocker.receiptId],
  };
  return memoryDraftFromLearningSignal(learning);
}

function adjustmentLearningDraft(input: {
  fingerprint: string;
  work: WorkContract;
  scope: ScopeRef;
  sourceRoundId: string;
  observedAt: string;
  relay: NonNullable<ReturnType<typeof getControllerRoundRelay>>;
}): MemoryUnitDraft | undefined {
  const result = input.relay.qualityAdjustmentResults?.find(candidate => candidate.fingerprint === input.fingerprint);
  if (!result || result.outcome === 'inconclusive') return undefined;
  const decision = input.relay.qualityDecisions?.find(candidate => candidate.fingerprint === input.fingerprint);
  if (!decision) return undefined;
  const learning: LearningSignal = {
    schemaVersion: 1,
    id: signalId('quality-adjustment', input.fingerprint),
    scope: input.scope,
    kind: result.outcome === 'improved' ? 'success' : 'correction',
    valence: result.outcome === 'improved' ? 'positive' : 'negative',
    summary: `Execution adjustment ${result.outcome}. Decision: ${decision.reason} Verification: ${result.reason}`,
    concepts: normalizedConcepts([
      'forge.execution-quality.adjustment',
      ...(input.work.engineeringContext?.semanticScope?.keys ?? []),
    ]),
    facets: ['automatic', 'execution-quality', 'adjustment', result.outcome],
    admissionSource: 'verified_outcome',
    portability: 'local',
    salience: 0.9,
    confidence: 0.95,
    utility: 0.88,
    sourceKind: 'controller',
    sourceId: `execution-quality-adjustment:${input.fingerprint}`,
    sourceWorkId: input.work.workId,
    sourceRoundId: input.sourceRoundId,
    observedAt: input.observedAt,
    evidenceRefs: result.evidenceRefs,
  };
  return memoryDraftFromLearningSignal(learning);
}

function consolidateAffectedMemories(
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
    .filter(memory => memory.id.startsWith('learning:auto:'))
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

export function persistAutomaticControllerRoundLearning(input: {
  controllerHome: string;
  repoId: string;
  workId: string;
  sourceRoundId: string;
  signals: readonly ExecutionQualitySignal[];
  controllerSignals?: readonly ControllerLearningSignalDraft[];
  adjustmentFingerprints?: readonly string[];
  now?: string;
}): AutomaticControllerLearningResult {
  const work = getWorkContract({ controllerHome: input.controllerHome, repoId: input.repoId }, input.workId);
  if (!work) throw new Error('COGNITION_AUTOMATIC_LEARNING_WORK_NOT_FOUND');
  if (!sourceRoundObserved(input)) throw new Error('COGNITION_AUTOMATIC_LEARNING_ROUND_NOT_CLOSED');
  const relay = getControllerRoundRelay({ controllerHome: input.controllerHome, repoId: input.repoId }, input.workId);
  if (!relay) throw new Error('COGNITION_AUTOMATIC_LEARNING_RELAY_NOT_FOUND');

  const scope = preferredLearningScope(work, input.controllerHome);
  const observedAt = input.now ?? new Date().toISOString();
  const authority = roundDerivedAuthority({
    controllerHome: input.controllerHome,
    repoId: input.repoId,
    work,
    sourceRoundId: input.sourceRoundId,
  });
  const stored: MemoryUnit[] = [];
  const skipped: string[] = [];
  const repairOutcomeObservationIds: string[] = [];
  const repairExperienceIds: string[] = [];

  try {
    const repair = persistVerifiedRepairLearning({
      controllerHome: input.controllerHome,
      repoId: input.repoId,
      work,
      scope,
      sourceRoundId: input.sourceRoundId,
      observedAt,
      cognitionAuthority: authority,
    });
    if (repair.skipped) skipped.push(repair.skipped);
    if (repair.outcomeId) repairOutcomeObservationIds.push(repair.outcomeId);
    if (repair.experienceId) repairExperienceIds.push(repair.experienceId);
    if (repair.memory && !stored.some(memory => memory.id === repair.memory!.id)) stored.push(repair.memory);
  } catch (error) {
    skipped.push(`repair:${error instanceof Error ? error.message : 'learning_failed'}`);
  }

  for (const signal of (input.controllerSignals ?? []).slice(0, 8)) {
    const signalScope = controllerLearningScope(work, input.controllerHome, signal.scopeKind);
    if (!signalScope) {
      skipped.push(`controller:${signal.kind}:scope_unavailable:${signal.scopeKind}`);
      continue;
    }
    const refs = [...new Set(signal.evidenceRefs)].slice(0, 16);
    const counterRefs = [...new Set(signal.counterEvidenceRefs)].slice(0, 16);
    const evidenceAvailable = [...refs, ...counterRefs].every(ref => canonicalWorkflowEvidenceAvailable(
      { controllerHome: input.controllerHome, repoId: input.repoId },
      ref,
      signalScope,
      work.workId,
    ));
    if (!evidenceAvailable) {
      skipped.push(`controller:${signal.kind}:evidence_unavailable`);
      continue;
    }
    stored.push(persistDraft(input.controllerHome, authority, controllerLearningDraft({
      signal: { ...signal, evidenceRefs: refs, counterEvidenceRefs: counterRefs },
      work,
      scope: signalScope,
      sourceRoundId: input.sourceRoundId,
      observedAt,
    })));
  }

  for (const signal of input.signals.slice(0, 8)) {
    const refs = [...new Set(signal.evidenceRefs)].slice(0, 64);
    const available = refs.length > 0 && refs.every(ref => canonicalWorkflowEvidenceAvailable(
      { controllerHome: input.controllerHome, repoId: input.repoId },
      ref,
      scope,
      work.workId,
    ));
    if (!available) {
      skipped.push(`signal:${signal.code}:evidence_unavailable`);
      continue;
    }
    stored.push(persistDraft(input.controllerHome, authority, signalLearningDraft({
      signal: { ...signal, evidenceRefs: refs },
      work,
      scope,
      sourceRoundId: input.sourceRoundId,
      observedAt,
    })));
  }

  for (const blocker of (work.engineeringContext?.blockerDispositions ?? []).slice(-8)) {
    if (!canonicalWorkflowEvidenceAvailable(
      { controllerHome: input.controllerHome, repoId: input.repoId },
      blocker.receiptId,
      scope,
      work.workId,
    )) {
      skipped.push(`blocker:${blocker.blockerId}:evidence_unavailable`);
      continue;
    }
    stored.push(persistDraft(input.controllerHome, authority, blockerLearningDraft({
      blocker,
      work,
      scope,
      sourceRoundId: input.sourceRoundId,
      observedAt,
    })));
  }

  for (const fingerprint of [...new Set(input.adjustmentFingerprints ?? [])].slice(0, 8)) {
    const draft = adjustmentLearningDraft({
      fingerprint,
      work,
      scope,
      sourceRoundId: input.sourceRoundId,
      observedAt,
      relay,
    });
    if (!draft) {
      skipped.push(`adjustment:${fingerprint}:not_durable`);
      continue;
    }
    if (!draft.provenance.evidenceRefs.every(ref => canonicalWorkflowEvidenceAvailable(
      { controllerHome: input.controllerHome, repoId: input.repoId },
      ref,
      scope,
      work.workId,
    ))) {
      skipped.push(`adjustment:${fingerprint}:evidence_unavailable`);
      continue;
    }
    stored.push(persistDraft(input.controllerHome, authority, draft));
  }

  associateStoredMemories({
    controllerHome: input.controllerHome,
    repoId: input.repoId,
    work,
    sourceRoundId: input.sourceRoundId,
    memories: stored,
    now: observedAt,
  });
  const consolidated = consolidateAffectedMemories(input.controllerHome, scope, stored, observedAt);
  const workspaceScope = workspacePromotionScope(work, input.controllerHome, scope);
  const promotedMemoryIds = workspaceScope
    ? promoteConsolidatedLearning({
        controllerHome: input.controllerHome,
        workspaceScope,
        projectScope: scope,
        candidates: consolidated,
        now: observedAt,
      })
    : [];
  const requirementCandidateIds = workspaceScope
    ? materializeRequirementCandidates({
        controllerHome: input.controllerHome,
        workspaceScope,
        promotedMemoryIds,
        now: observedAt,
      })
    : [];
  return {
    storedMemoryIds: [...new Set(stored.map(memory => memory.id))],
    consolidatedMemoryIds: consolidated.map(candidate => candidate.memory.id),
    promotedMemoryIds,
    requirementCandidateIds,
    ...(repairOutcomeObservationIds.length ? { repairOutcomeObservationIds } : {}),
    ...(repairExperienceIds.length ? { repairExperienceIds } : {}),
    skipped,
  };
}
