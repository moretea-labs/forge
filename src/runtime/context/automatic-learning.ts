import { createHash } from 'crypto';
import type { ScopeRef } from '../../../packages/kernel/identity/api/index';
import {
  consolidateMemories,
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
  skipped: string[];
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
  const scopeAllowed = (scope: ScopeRef) => allowedScopes.some(candidate => sameScope(candidate, scope));
  return {
    assertMemoryWrite(memory) {
      if (memory.provenance.sourceWorkId !== input.work.workId
        || memory.provenance.sourceRoundId !== input.sourceRoundId
        || !scopeAllowed(memory.scope)
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
      return sourceWorkId === input.work.workId
        && scopeAllowed(scope)
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
    salience: input.signal.code === 'repeated_root_cause' ? 0.9 : 0.72,
    confidence: input.signal.code === 'suspected_regression' ? 0.62 : 0.82,
    sourceKind: 'system',
    sourceId: `execution-quality:${fingerprint}`,
    sourceWorkId: input.work.workId,
    sourceRoundId: input.sourceRoundId,
    observedAt: input.observedAt,
    evidenceRefs: [...new Set(input.signal.evidenceRefs)].slice(0, 64),
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
    salience: input.blocker.classification === 'unrelated' ? 0.62 : 0.92,
    confidence: 0.95,
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
    salience: 0.9,
    confidence: 0.95,
    sourceKind: 'controller',
    sourceId: `execution-quality-adjustment:${input.fingerprint}`,
    sourceWorkId: input.work.workId,
    sourceRoundId: input.sourceRoundId,
    observedAt: input.observedAt,
    evidenceRefs: result.evidenceRefs,
  };
  return memoryDraftFromLearningSignal(learning);
}

function consolidateAffectedConcepts(
  controllerHome: string,
  scope: ScopeRef,
  concepts: readonly string[],
  now: string,
): ConsolidatedLearning[] {
  const uniqueConcepts = normalizedConcepts(concepts);
  if (!uniqueConcepts.length) return [];
  const sourceMemories = cognitionReadPort(controllerHome)
    .exactByConcept([scope], uniqueConcepts, 128, now)
    .filter(memory => memory.id.startsWith('learning:auto:'));
  if (sourceMemories.length < 3) return [];
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

  const concepts = stored.flatMap(memory => memory.concepts);
  const consolidated = consolidateAffectedConcepts(input.controllerHome, scope, concepts, observedAt);
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
    skipped,
  };
}
