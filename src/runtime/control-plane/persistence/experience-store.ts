import { readForgeInstanceIdentity } from '../../../../packages/kernel/identity/api/index';
import { resolveProjectForRepositoryPlacement } from '../workspace/workspace-store';
import type { ScopeRef } from '../../../../packages/kernel/identity/api/index';
import type { ExperienceRecord, ExperienceStorePort, OutcomeObservation, OutcomeObservationStorePort } from '../../../../packages/kernel/memory/api/index';
import { getWorkContract, isTerminalWorkContractStatus, type WorkContract } from '../../../../packages/kernel/work/api/index';
import { controllerSessionAuthorityMatches, getControllerRoundRelay, getControllerSession } from '../../../../packages/kernel/controller/api/index';
import { readExecutionArtifact } from '../../evidence/artifact-store';
import { readExecutionEvidence } from '../../evidence/evidence-store';
import { assertControlPlaneMetadataPayload } from './metadata-payload-policy';
import { WORKFLOW_RUN_NAMESPACE, type WorkflowRunRecord } from './workflow-run-store';
import { deleteControlPlaneRecordWithinTransaction, listControlPlaneRecords, listControlPlaneRecordsWithinTransaction, readControlPlaneRecord, readControlPlaneRecordWithinTransaction, withControlPlaneTransaction, writeControlPlaneRecordWithinTransaction, type SqliteDatabase } from './sqlite-store';

export const EXPERIENCE_NAMESPACE = 'assistant_experience';
export const OUTCOME_OBSERVATION_NAMESPACE = 'assistant_outcome_observation';
export interface ExperienceWriteIdentity { workId: string; controllerId: string; authorityId: string }

function resolvedProjectForWork(work: WorkContract, controllerHome?: string) {
  if (!controllerHome) return undefined;
  const instance = readForgeInstanceIdentity(controllerHome);
  if (!instance) return undefined;
  const declaredProject = work.scopeRef?.kind === 'project'
    ? work.scopeRef.id
    : work.engineeringContext?.projectContractReceipt?.projectId;
  return resolveProjectForRepositoryPlacement({
    controllerHome,
    forgeInstanceId: instance.instanceId,
    repositoryId: work.repoId,
    checkoutId: work.checkoutId,
    projectId: declaredProject,
  });
}

export function experienceScopesForWork(work: WorkContract, controllerHome?: string): ScopeRef[] {
  const scopes: ScopeRef[] = [{ schemaVersion: 1, kind: 'work', id: work.workId }];
  const declaredProject = work.scopeRef?.kind === 'project'
    ? work.scopeRef.id
    : work.engineeringContext?.projectContractReceipt?.projectId;
  const projectId = resolvedProjectForWork(work, controllerHome)?.projectId ?? declaredProject;
  if (projectId) scopes.push({ schemaVersion: 1, kind: 'project', id: projectId });
  if (work.requirementId) scopes.push({ schemaVersion: 1, kind: 'requirement', id: work.requirementId });
  if (work.planId) scopes.push({ schemaVersion: 1, kind: 'plan', id: work.planId });
  if (work.planStepId) scopes.push({ schemaVersion: 1, kind: 'plan_step', id: work.planStepId });
  if (work.scopeRef && !scopes.some(s => s.kind === work.scopeRef!.kind && s.id === work.scopeRef!.id)) scopes.push(work.scopeRef);
  return scopes;
}

/**
 * Cognitive recall may include portable Workspace guidance shared by sibling
 * Projects. Raw Controller/Experience writes deliberately remain limited to
 * experienceScopesForWork so project-local observations cannot bypass
 * evidence-backed promotion into cross-project memory.
 */
export function cognitiveScopesForWork(work: WorkContract, controllerHome?: string): ScopeRef[] {
  const scopes = experienceScopesForWork(work, controllerHome);
  const workspaceId = resolvedProjectForWork(work, controllerHome)?.workspaceId;
  if (workspaceId && !scopes.some(scope => scope.kind === 'workspace' && scope.id === workspaceId)) {
    scopes.push({ schemaVersion: 1, kind: 'workspace', id: workspaceId });
  }
  return scopes;
}

function matchesExperienceScope(work: WorkContract, scope: ScopeRef, controllerHome: string): boolean {
  return experienceScopesForWork(work, controllerHome).some(candidate => candidate.kind === scope.kind && candidate.id === scope.id);
}

function matchesCognitiveScope(work: WorkContract, scope: ScopeRef, controllerHome: string): boolean {
  return cognitiveScopesForWork(work, controllerHome).some(candidate => candidate.kind === scope.kind && candidate.id === scope.id);
}

export function canonicalWorkflowEvidenceAvailable(input: { controllerHome: string; repoId: string }, ref: string, scope: ScopeRef, sourceWorkId: string): boolean {
  try {
    const source = getWorkContract(input, sourceWorkId);
    if (!source || !matchesCognitiveScope(source, scope, input.controllerHome)) return false;
    const linked = source.evidenceRefs.find(item => item.evidenceId === ref || item.artifactId === ref);
    if (linked) {
      if (ref.startsWith('ART-')) {
        const artifact = readExecutionArtifact(input.controllerHome, input.repoId, ref, 16 * 1024);
        return !artifact.truncated && artifact.artifact.kind === 'evidence';
      }
      if (ref.startsWith('EVD-')) return readExecutionEvidence(input.controllerHome, input.repoId, ref).evidenceId === ref;
    }
    if (source.checkRefs.some(check => check.receipt?.receiptId === ref && ['passed', 'failed'].includes(check.receipt.status))) return true;
    if (source.engineeringContext?.blockerDispositions?.some(disposition => disposition.receiptId === ref)) return true;
    if (ref.startsWith('workflow-run-') || ref.startsWith('workflow-publication-')) {
      const runs = listControlPlaneRecords<WorkflowRunRecord>(input.controllerHome, { namespace: WORKFLOW_RUN_NAMESPACE, scope: sourceWorkId, limit: 1000 });
      return runs.some(row => row.value.evidenceRef === ref || row.value.publicationReceipt?.receiptId === ref);
    }
    const outcome = readControlPlaneRecord<OutcomeObservation>(input.controllerHome, OUTCOME_OBSERVATION_NAMESPACE, `${scope.kind}:${scope.id}`, ref)?.value;
    if (outcome && outcome.sourceWorkId === sourceWorkId) {
      return canonicalWorkflowEvidenceAvailable(input, outcome.evidenceRef, scope, sourceWorkId);
    }
    return false;
  } catch { return false; }
}

export function assertMemoryWriteAuthority(input: { controllerHome: string; repoId: string; identity?: ExperienceWriteIdentity }, scope: ScopeRef, sourceWorkId: string, sourceRoundId: string): void {
  const identity = input.identity;
  if (!identity) throw new Error('EXPERIENCE_CONTROLLER_REQUIRED');
  const current = getWorkContract(input, identity.workId), source = getWorkContract(input, sourceWorkId);
  if (!current || isTerminalWorkContractStatus(current.status) || !source || !matchesExperienceScope(current, scope, input.controllerHome) || !matchesExperienceScope(source, scope, input.controllerHome)) throw new Error('EXPERIENCE_WORK_SCOPE_MISMATCH');
  const owner = getControllerSession(input, identity.workId);
  if (!owner || owner.controllerId !== identity.controllerId) throw new Error('EXPERIENCE_CONTROLLER_NOT_OWNER');
  const relay = getControllerRoundRelay(input, identity.workId);
  if (relay) {
    if (relay.status !== 'claimed' || relay.authorityId !== identity.authorityId || relay.claimGeneration !== owner.claimGeneration
      || sourceRoundId !== `${relay.relayScopeId}:${relay.roundCount}`) throw new Error('EXPERIENCE_ROUND_AUTHORITY_MISMATCH');
  } else if (!controllerSessionAuthorityMatches(owner, identity.authorityId)
    || sourceRoundId !== `${identity.workId}:${owner.claimGeneration}`) throw new Error('EXPERIENCE_CLAIM_AUTHORITY_MISMATCH');
}

/** One SQLite writer; nested domain operations share the same transaction. */
export function controllerExperienceStore(input: { controllerHome: string; repoId: string; identity?: ExperienceWriteIdentity; now?: () => string }): ExperienceStorePort {
  let transaction: SqliteDatabase | undefined;
  const key = (scope: ScopeRef) => `${scope.kind}:${scope.id}`;
  const work = (id: string) => getWorkContract(input, id);
  return {
    transaction(operation) {
      if (transaction) return operation();
      return withControlPlaneTransaction(input.controllerHome, database => {
        transaction = database;
        try { return operation(); } finally { transaction = undefined; }
      });
    },
    assertWriteAuthority(scope, sourceWorkId, sourceRoundId) {
      assertMemoryWriteAuthority(input, scope, sourceWorkId, sourceRoundId);
    },
    evidenceAvailable(ref, scope, sourceWorkId) {
      return canonicalWorkflowEvidenceAvailable(input, ref, scope, sourceWorkId);
    },
    read(scope, id) {
      const row = transaction ? readControlPlaneRecordWithinTransaction<ExperienceRecord>(transaction, EXPERIENCE_NAMESPACE, key(scope), id)
        : readControlPlaneRecord<ExperienceRecord>(input.controllerHome, EXPERIENCE_NAMESPACE, key(scope), id);
      if (row && row.value.revision !== row.revision) throw new Error('EXPERIENCE_STORED_REVISION_MISMATCH');
      return row?.value;
    },
    list(scope, limit) {
      const query = { namespace: EXPERIENCE_NAMESPACE, scope: key(scope), limit };
      return (transaction ? listControlPlaneRecordsWithinTransaction<ExperienceRecord>(transaction, query)
        : listControlPlaneRecords<ExperienceRecord>(input.controllerHome, query)).map(row => row.value);
    },
    write(record, expectedRevision) {
      if (!transaction) throw new Error('EXPERIENCE_TRANSACTION_REQUIRED');
      assertControlPlaneMetadataPayload(record, 'experience', 16 * 1024);
      const row = writeControlPlaneRecordWithinTransaction(transaction, { namespace: EXPERIENCE_NAMESPACE, scope: key(record.scope), key: record.id,
        schemaVersion: 1, value: record, expectedRevision, action: record.retractedAt ? 'experience_retracted' : record.supersedesId ? 'experience_superseded' : 'experience_recorded' });
      if (row.revision !== record.revision) throw new Error('EXPERIENCE_REVISION_CONFLICT');
    },
    assertSafePayload: record => assertControlPlaneMetadataPayload(record, 'experience', 16 * 1024),
  };
}

export function controllerOutcomeObservationStore(input: { controllerHome: string; repoId: string; identity?: ExperienceWriteIdentity; now?: () => string }): OutcomeObservationStorePort {
  let transaction: SqliteDatabase | undefined;
  const key = (scope: ScopeRef) => `${scope.kind}:${scope.id}`;
  return {
    transaction(operation) {
      if (transaction) return operation();
      return withControlPlaneTransaction(input.controllerHome, database => {
        transaction = database;
        try { return operation(); } finally { transaction = undefined; }
      });
    },
    assertWriteAuthority(scope, sourceWorkId, sourceRoundId) { assertMemoryWriteAuthority(input, scope, sourceWorkId, sourceRoundId); },
    evidenceAvailable(ref, scope, sourceWorkId) { return canonicalWorkflowEvidenceAvailable(input, ref, scope, sourceWorkId); },
    read(scope, id) {
      const row = transaction ? readControlPlaneRecordWithinTransaction<OutcomeObservation>(transaction, OUTCOME_OBSERVATION_NAMESPACE, key(scope), id)
        : readControlPlaneRecord<OutcomeObservation>(input.controllerHome, OUTCOME_OBSERVATION_NAMESPACE, key(scope), id);
      return row?.value;
    },
    list(scope, limit) {
      const query = { namespace: OUTCOME_OBSERVATION_NAMESPACE, scope: key(scope), limit };
      return (transaction ? listControlPlaneRecordsWithinTransaction<OutcomeObservation>(transaction, query)
        : listControlPlaneRecords<OutcomeObservation>(input.controllerHome, query)).map(row => row.value);
    },
    write(observation) {
      if (!transaction) throw new Error('OUTCOME_TRANSACTION_REQUIRED');
      assertControlPlaneMetadataPayload(observation, 'outcome_observation', 32 * 1024);
      writeControlPlaneRecordWithinTransaction(transaction, { namespace: OUTCOME_OBSERVATION_NAMESPACE, scope: key(observation.scope), key: observation.id,
        schemaVersion: 1, value: observation, expectedRevision: null, action: 'outcome_observation_recorded' });
    },
    assertSafePayload: observation => assertControlPlaneMetadataPayload(observation, 'outcome_observation', 32 * 1024),
  };
}

/** Called by central maintenance, never by recall. A 30-day terminal grace preserves diagnosis. */
export function cleanupExpiredExperiences(controllerHome: string, now = new Date().toISOString(), limit = 100): number {
  const at = Date.parse(now);
  if (!Number.isFinite(at)) throw new Error('EXPERIENCE_CLEANUP_TIME_INVALID');
  return withControlPlaneTransaction(controllerHome, database => {
    let removed = 0;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('EXPERIENCE_CLEANUP_LIMIT_INVALID');
    // Filter terminal candidates before LIMIT so immortal lessons cannot starve retirement.
    // SQLite parses ISO offsets; lexicographic comparison would be incorrect for mixed offsets.
    const candidates = database.prepare(`SELECT scope, record_key FROM control_plane_records
      WHERE namespace = ? AND julianday(COALESCE(json_extract(payload, '$.retractedAt'), json_extract(payload, '$.expiresAt'))) <= julianday(?)
      ORDER BY updated_at, scope, record_key LIMIT ?`).all(EXPERIENCE_NAMESPACE, new Date(at - 30 * 86_400_000).toISOString(), Math.min(1000, limit)) as Array<{ scope: string; record_key: string }>;
    for (const candidate of candidates) {
      const row = readControlPlaneRecordWithinTransaction<ExperienceRecord>(database, EXPERIENCE_NAMESPACE, candidate.scope, candidate.record_key);
      if (!row) continue;
      deleteControlPlaneRecordWithinTransaction(database, { namespace: EXPERIENCE_NAMESPACE, scope: row.scope, key: row.key, expectedRevision: row.revision, action: 'experience_expired_retention' });
      removed++;
    }
    return removed;
  });
}
