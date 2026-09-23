import { createHash } from 'crypto';
import {
  memoryDraftFromLearningSignal,
  recordCognitiveMemory,
  type CognitiveWriteAuthorityPort,
  type LearningSignal,
  type MemoryUnit,
} from '../../../packages/kernel/cognition/api/index';
import { readForgeInstanceIdentity, type ScopeRef } from '../../../packages/kernel/identity/api/index';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { cognitionMemoryStore } from '../control-plane/persistence/cognition-store';
import { resolveProjectForRepositoryPlacement } from '../control-plane/workspace/workspace-store';
import { controllerPluginRepository, findPluginActionReceipt } from '../plugins/store';
import type { ControllerLearningSignalDraft } from './automatic-learning';

export interface DirectControllerLearningResult {
  storedMemoryIds: string[];
  scopes: ScopeRef[];
}

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function directLearningScopes(
  controllerHome: string,
  repository: Pick<RepositoryRecord, 'repoId' | 'activeCheckoutId'>,
): ScopeRef[] {
  const instance = readForgeInstanceIdentity(controllerHome);
  if (!instance) throw new Error('COGNITION_DIRECT_LEARNING_FORGE_INSTANCE_REQUIRED');
  const project = resolveProjectForRepositoryPlacement({
    controllerHome,
    forgeInstanceId: instance.instanceId,
    repositoryId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
  });
  if (!project) throw new Error('COGNITION_DIRECT_LEARNING_PROJECT_PLACEMENT_REQUIRED');
  return [
    { schemaVersion: 1, kind: 'project', id: project.projectId },
    { schemaVersion: 1, kind: 'workspace', id: project.workspaceId },
  ];
}

function semanticSignalId(signal: ControllerLearningSignalDraft, scope: ScopeRef): string {
  const concepts = [...new Set(signal.concepts.map(value => value.trim()).filter(Boolean))].sort();
  const identity = JSON.stringify({
    scope: `${scope.kind}:${scope.id}`,
    kind: signal.kind,
    valence: signal.valence,
    summary: signal.summary,
    concepts,
    admissionSource: signal.admissionSource,
    portability: signal.portability,
  });
  return createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

function directSourceId(input: {
  principalId?: string;
  sessionId?: string;
  controllerInstanceId?: string;
  controllerType?: string;
}): string {
  const identity = [
    input.principalId?.trim() ?? '',
    input.controllerType?.trim() ?? '',
    input.controllerInstanceId?.trim() ?? '',
    input.sessionId?.trim() ?? '',
  ].join(':');
  return `mcp-learning:${createHash('sha256').update(identity || 'anonymous-controller').digest('hex').slice(0, 24)}`;
}

function directLearningAuthority(input: {
  controllerHome: string;
  repository: Pick<RepositoryRecord, 'repoId'>;
  scopes: readonly ScopeRef[];
  principalId?: string;
  sourceId: string;
}): CognitiveWriteAuthorityPort {
  const controllerRepoId = controllerPluginRepository(input.controllerHome).repoId;
  const scopeAllowed = (scope: ScopeRef) => input.scopes.some(candidate => sameScope(candidate, scope));
  return {
    assertMemoryWrite(memory: MemoryUnit) {
      if (!scopeAllowed(memory.scope)
        || memory.provenance.sourceKind !== 'controller'
        || memory.provenance.sourceId !== input.sourceId
        || memory.provenance.sourceWorkId
        || memory.provenance.sourceRoundId) {
        throw new Error('COGNITION_DIRECT_LEARNING_AUTHORITY_INVALID');
      }
      if (memory.scope.kind === 'workspace'
        && (!memory.facets.includes('source.explicit_human') || !memory.facets.includes('portability.portable'))) {
        throw new Error('COGNITION_DIRECT_LEARNING_WORKSPACE_REQUIRES_EXPLICIT_PORTABLE_HUMAN');
      }
    },
    assertEdgeWrite() {
      throw new Error('COGNITION_DIRECT_LEARNING_EDGE_NOT_ALLOWED');
    },
    evidenceAvailable(ref, scope) {
      if (!scopeAllowed(scope)) return false;
      const receipt = findPluginActionReceipt(input.controllerHome, ref);
      if (!receipt) return false;
      if (receipt.repoId === input.repository.repoId || receipt.workRepoId === input.repository.repoId) return true;
      const principal = input.principalId?.trim();
      return receipt.repoId === controllerRepoId
        && Boolean(principal)
        && receipt.origin?.actor === principal;
    },
  };
}

/**
 * Persist semantic learning selected by the model outside Work lifecycle.
 *
 * The caller supplies only meaning. Forge derives source identity/time and limits writes
 * to the repository's semantic Project, or to Workspace for explicit portable human
 * teaching. Work/ControllerRound authority is intentionally absent.
 */
export function persistDirectControllerLearning(input: {
  controllerHome: string;
  repository: Pick<RepositoryRecord, 'repoId' | 'activeCheckoutId'>;
  signals: readonly ControllerLearningSignalDraft[];
  principalId?: string;
  sessionId?: string;
  controllerInstanceId?: string;
  controllerType?: string;
  now?: string;
}): DirectControllerLearningResult {
  const scopes = directLearningScopes(input.controllerHome, input.repository);
  const observedAt = input.now ?? new Date().toISOString();
  const sourceId = directSourceId(input);
  const projectScope = scopes.find(scope => scope.kind === 'project')!;
  const workspaceScope = scopes.find(scope => scope.kind === 'workspace')!;
  const store = cognitionMemoryStore(input.controllerHome);
  const authority = directLearningAuthority({
    controllerHome: input.controllerHome,
    repository: input.repository,
    scopes,
    principalId: input.principalId,
    sourceId,
  });

  const drafts = input.signals.map(signal => {
    const scope = signal.scopeKind === 'project'
      ? projectScope
      : signal.scopeKind === 'workspace'
        ? workspaceScope
        : undefined;
    if (!scope) {
      throw new Error(`COGNITION_DIRECT_LEARNING_SCOPE_REQUIRES_WORK: ${signal.scopeKind}`);
    }
    const id = semanticSignalId(signal, scope);
    const learning: LearningSignal = {
      schemaVersion: 1,
      id: `direct:${id}`,
      scope,
      kind: signal.kind,
      valence: signal.valence,
      summary: signal.summary,
      concepts: [...new Set(signal.concepts.map(value => value.trim()).filter(Boolean))],
      facets: [...new Set(signal.facets.map(value => value.trim()).filter(Boolean))],
      admissionSource: signal.admissionSource,
      portability: signal.portability,
      salience: signal.salience,
      confidence: signal.confidence,
      utility: signal.utility,
      sourceKind: 'controller',
      sourceId,
      observedAt,
      evidenceRefs: [...new Set(signal.evidenceRefs)],
      counterEvidenceRefs: [...new Set(signal.counterEvidenceRefs)],
      ...(signal.expiresAt ? { expiresAt: signal.expiresAt } : {}),
    };
    return memoryDraftFromLearningSignal(learning);
  });

  // Validate all evidence before any write so a multi-signal call cannot partially commit.
  for (const draft of drafts) {
    authority.assertMemoryWrite({ ...draft, schemaVersion: 1, revision: 1 });
    for (const ref of [...draft.provenance.evidenceRefs, ...draft.counterEvidenceRefs]) {
      if (!authority.evidenceAvailable(ref, draft.scope)) {
        throw new Error(`COGNITION_DIRECT_LEARNING_EVIDENCE_UNAVAILABLE: ${ref}`);
      }
    }
  }

  const storedMemoryIds = store.transaction(() => drafts.map(draft =>
    recordCognitiveMemory(store, authority, draft).id));
  return { storedMemoryIds, scopes };
}
