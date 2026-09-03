import { createHash } from 'crypto';
import {
  MAX_SEMANTIC_SYNC_BUNDLE_BYTES,
  MAX_SEMANTIC_SYNC_JOURNAL_ENTRIES,
  MAX_SEMANTIC_SYNC_JOURNAL_KEY_SAMPLES,
  assertSemanticSyncRecordBounds,
  scopeRef,
  semanticRecordMetadata,
  semanticSyncRecordKey,
  type ProjectIdentity,
  type SemanticSyncBundle,
  type SemanticSyncImportReceipt,
  type SemanticSyncRecord,
  type SemanticSyncRecordKind,
  type WorkspaceIdentity,
} from '../../../../packages/kernel/identity/api/index';
import { readForgeInstanceIdentity } from '../../../../packages/kernel/identity/api/index';
import type { WorkContract } from '../../../../packages/kernel/work/api/index';
import { semanticScopeRefForWork } from '../../../../packages/kernel/work/api/index';
import type { PlanContract } from '../facade/types';
import type { Requirement } from '../persistence/requirement-store';
import {
  ControlPlaneConflictError,
  listControlPlaneRecords,
  readControlPlaneRecordWithinTransaction,
  withControlPlaneTransaction,
  writeControlPlaneRecordWithinTransaction,
  type ControlPlaneRecord,
  type SqliteDatabase,
} from '../persistence/sqlite-store';
import { assertControlPlaneMetadataPayload } from '../persistence/metadata-payload-policy';
import {
  PROJECT_PLACEMENT_NAMESPACE,
  PROJECT_SEMANTIC_NAMESPACE,
  WORKSPACE_SEMANTIC_NAMESPACE,
  readProjectIdentity,
  readProjectPlacement,
  readWorkspaceIdentity,
} from './workspace-store';

export const SEMANTIC_SYNC_REPLICA_NAMESPACE = 'semantic_sync_replica';
export const SEMANTIC_SYNC_JOURNAL_NAMESPACE = 'semantic_sync_journal';
const CONTROLLER_SCOPE = 'controller';
const JOURNAL_KEY = 'journal';

export interface RequirementSemanticView {
  schemaVersion: 1;
  requirementId: string;
  title: string;
  outcomeStatement: string;
  acceptanceCriteria: string[];
  requiredDeliveryReferences: string[];
  state: Requirement['state'];
  createdAt?: string;
  updatedAt?: string;
}

export interface PlanSemanticView {
  schemaVersion: 1;
  planId: string;
  requirementId?: string;
  scopeKey: string;
  sourceRevision: string;
  goal: string;
  nonGoals: string[];
  assumptions: string[];
  resolvedDecisions: string[];
  stopConditions: string[];
  replanConditions: string[];
  integrationStrategy?: string;
  status: PlanContract['status'];
  steps: Array<{
    id: string;
    objective: string;
    dependencies: string[];
    acceptanceCriteria: string[];
    status: PlanContract['steps'][number]['status'];
    workId?: string;
  }>;
  supersedes?: string[];
  supersededBy?: string;
  supersessionReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkSemanticView {
  schemaVersion: 1;
  workId: string;
  semanticScope: ReturnType<typeof semanticScopeRefForWork>;
  objective: string;
  acceptanceCriteria: string[];
  status: WorkContract['status'];
  phase: WorkContract['phase'];
  workKind: WorkContract['workKind'];
  lifecycleRole?: WorkContract['lifecycleRole'];
  requirementId?: string;
  planId?: string;
  planStepId?: string;
  predecessorWorkId?: string;
  supersedes?: string[];
  supersededBy?: string;
  supersessionReason?: string;
  completionOutcome?: WorkContract['completionOutcome'];
  createdAt: string;
  updatedAt: string;
}

export interface SemanticSyncReplica {
  schemaVersion: 1;
  sourceForgeInstanceId: string;
  importedAt: string;
  record: SemanticSyncRecord;
}

export interface SemanticSyncJournalEntry {
  schemaVersion: 1;
  sourceForgeInstanceId: string;
  bundleFingerprint: string;
  importedAt: string;
  appliedCount: number;
  convergedCount: number;
  sampledKeys: string[];
}

interface SemanticSyncJournal {
  schemaVersion: 1;
  entries: SemanticSyncJournalEntry[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function projectRequirementSemantic(requirement: Requirement): RequirementSemanticView {
  return {
    schemaVersion: 1,
    requirementId: requirement.requirementId,
    title: requirement.title,
    outcomeStatement: requirement.outcomeStatement,
    acceptanceCriteria: [...requirement.acceptanceCriteria],
    requiredDeliveryReferences: [...requirement.requiredDeliveryReferences],
    state: requirement.state,
    ...('createdAt' in requirement && typeof (requirement as any).createdAt === 'string' ? { createdAt: (requirement as any).createdAt } : {}),
    ...('updatedAt' in requirement && typeof (requirement as any).updatedAt === 'string' ? { updatedAt: (requirement as any).updatedAt } : {}),
  };
}

export function projectPlanSemantic(plan: PlanContract): PlanSemanticView {
  return {
    schemaVersion: 1,
    planId: plan.planId,
    ...(plan.requirementId ? { requirementId: plan.requirementId } : {}),
    scopeKey: plan.scopeKey,
    sourceRevision: plan.sourceRevision,
    goal: plan.goal,
    nonGoals: [...plan.nonGoals],
    assumptions: [...plan.assumptions],
    resolvedDecisions: [...plan.resolvedDecisions],
    stopConditions: [...plan.stopConditions],
    replanConditions: [...plan.replanConditions],
    ...(plan.integrationStrategy ? { integrationStrategy: plan.integrationStrategy } : {}),
    status: plan.status,
    steps: plan.steps.map((step) => ({
      id: step.id,
      objective: step.objective,
      dependencies: [...step.dependencies],
      acceptanceCriteria: [...step.acceptanceCriteria],
      status: step.status,
      ...(step.workId ? { workId: step.workId } : {}),
    })),
    ...(plan.supersedes ? { supersedes: [...plan.supersedes] } : {}),
    ...(plan.supersededBy ? { supersededBy: plan.supersededBy } : {}),
    ...(plan.supersessionReason ? { supersessionReason: plan.supersessionReason } : {}),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

export function projectWorkSemantic(work: WorkContract): WorkSemanticView {
  return {
    schemaVersion: 1,
    workId: work.workId,
    semanticScope: semanticScopeRefForWork(work),
    objective: work.objective,
    acceptanceCriteria: [...work.acceptanceCriteria],
    status: work.status,
    phase: work.phase,
    workKind: work.workKind,
    ...(work.lifecycleRole ? { lifecycleRole: work.lifecycleRole } : {}),
    ...(work.requirementId ? { requirementId: work.requirementId } : {}),
    ...(work.planId ? { planId: work.planId } : {}),
    ...(work.planStepId ? { planStepId: work.planStepId } : {}),
    ...(work.predecessorWorkId ? { predecessorWorkId: work.predecessorWorkId } : {}),
    ...(work.supersedes ? { supersedes: [...work.supersedes] } : {}),
    ...(work.supersededBy ? { supersededBy: work.supersededBy } : {}),
    ...(work.supersessionReason ? { supersessionReason: work.supersessionReason } : {}),
    ...(work.completionOutcome ? { completionOutcome: work.completionOutcome } : {}),
    createdAt: work.createdAt,
    updatedAt: work.updatedAt,
  };
}

function record<T>(input: {
  kind: SemanticSyncRecordKind;
  id: string;
  revision: number;
  updatedAt: string;
  sourceForgeInstanceId: string;
  value: T;
  expectedRevision: number | null;
}): SemanticSyncRecord<T> {
  const envelope = {
    metadata: semanticRecordMetadata({
      scope: scopeRef(input.kind, input.id),
      revision: input.revision,
      updatedAt: input.updatedAt,
      origin: 'local',
      forgeInstanceId: input.sourceForgeInstanceId,
    }),
    value: input.value,
  };
  return {
    schemaVersion: 1,
    kind: input.kind,
    id: input.id,
    envelope,
    condition: { expectedRevision: input.expectedRevision },
    fingerprint: sha256(envelope),
  };
}

function bundleFingerprint(bundle: Omit<SemanticSyncBundle, 'contentFingerprint'>): string {
  return sha256(bundle);
}

function replicaScope(workspaceId: string, projectId: string): string {
  return `${workspaceId.trim()}:${projectId.trim()}`;
}

export function exportSemanticSyncBundle(input: {
  controllerHome: string;
  workspaceId: string;
  projectId: string;
  targetReplicaRevisions?: Readonly<Record<string, number>>;
  now?: () => string;
}): SemanticSyncBundle {
  const instance = readForgeInstanceIdentity(input.controllerHome);
  if (!instance) throw new Error('SEMANTIC_SYNC_FORGE_INSTANCE_IDENTITY_REQUIRED');
  const workspace = readWorkspaceIdentity(input.controllerHome, input.workspaceId);
  if (!workspace) throw new Error(`SEMANTIC_SYNC_WORKSPACE_NOT_FOUND: ${input.workspaceId}`);
  const project = readProjectIdentity(input.controllerHome, workspace.value.workspaceId, input.projectId);
  if (!project) throw new Error(`SEMANTIC_SYNC_PROJECT_NOT_FOUND: ${input.projectId}`);
  const placement = readProjectPlacement(input.controllerHome, instance.instanceId, project.value.projectId);
  if (!placement) throw new Error(`SEMANTIC_SYNC_PROJECT_PLACEMENT_NOT_FOUND: ${project.value.projectId}`);
  const repoId = placement.value.repositoryId;
  const expected = (kind: SemanticSyncRecordKind, id: string): number | null => input.targetReplicaRevisions?.[semanticSyncRecordKey(kind, id)] ?? null;
  const records: SemanticSyncRecord[] = [
    record({ kind: 'workspace', id: workspace.value.workspaceId, revision: workspace.revision, updatedAt: workspace.updatedAt, sourceForgeInstanceId: instance.instanceId, value: workspace.value, expectedRevision: expected('workspace', workspace.value.workspaceId) }),
    record({ kind: 'project', id: project.value.projectId, revision: project.revision, updatedAt: project.updatedAt, sourceForgeInstanceId: instance.instanceId, value: project.value, expectedRevision: expected('project', project.value.projectId) }),
  ];
  const plans = listControlPlaneRecords<PlanContract>(input.controllerHome, { namespace: 'plan_contract', scope: repoId, limit: 1_000 });
  const works = listControlPlaneRecords<WorkContract>(input.controllerHome, { namespace: 'work_contract', scope: repoId, limit: 1_000 });
  const requirementIds = new Set<string>();
  for (const plan of plans) if (plan.value.requirementId?.trim()) requirementIds.add(plan.value.requirementId.trim());
  for (const work of works) if (work.value.requirementId?.trim()) requirementIds.add(work.value.requirementId.trim());
  const requirements = listControlPlaneRecords<Requirement>(input.controllerHome, { namespace: 'requirement', scope: CONTROLLER_SCOPE, limit: 5_000 })
    .filter((entry) => requirementIds.has(entry.value.requirementId));
  for (const entry of requirements) {
    records.push(record({ kind: 'requirement', id: entry.value.requirementId, revision: entry.revision, updatedAt: entry.updatedAt, sourceForgeInstanceId: instance.instanceId, value: projectRequirementSemantic(entry.value), expectedRevision: expected('requirement', entry.value.requirementId) }));
  }
  for (const entry of plans) {
    records.push(record({ kind: 'plan', id: entry.value.planId, revision: entry.revision, updatedAt: entry.updatedAt, sourceForgeInstanceId: instance.instanceId, value: projectPlanSemantic(entry.value), expectedRevision: expected('plan', entry.value.planId) }));
  }
  for (const entry of works) {
    records.push(record({ kind: 'work', id: entry.value.workId, revision: entry.revision, updatedAt: entry.updatedAt, sourceForgeInstanceId: instance.instanceId, value: projectWorkSemantic(entry.value), expectedRevision: expected('work', entry.value.workId) }));
  }
  records.sort((left, right) => semanticSyncRecordKey(left.kind, left.id).localeCompare(semanticSyncRecordKey(right.kind, right.id)));
  assertSemanticSyncRecordBounds(records);
  const base = {
    schemaVersion: 1 as const,
    kind: 'forge_semantic_sync_bundle' as const,
    workspaceId: workspace.value.workspaceId,
    projectId: project.value.projectId,
    sourceForgeInstanceId: instance.instanceId,
    generatedAt: input.now?.() ?? new Date().toISOString(),
    records,
  };
  const bundle: SemanticSyncBundle = { ...base, contentFingerprint: bundleFingerprint(base) };
  assertControlPlaneMetadataPayload(bundle, 'semantic_sync_bundle');
  if (Buffer.byteLength(stableJson(bundle), 'utf8') > MAX_SEMANTIC_SYNC_BUNDLE_BYTES) throw new Error('SEMANTIC_SYNC_BUNDLE_TOO_LARGE');
  return bundle;
}

function localRecordWithinTransaction(database: SqliteDatabase, input: { kind: SemanticSyncRecordKind; id: string; workspaceId: string; repositoryId?: string }): ControlPlaneRecord<unknown> | undefined {
  if (input.kind === 'workspace') return readControlPlaneRecordWithinTransaction(database, WORKSPACE_SEMANTIC_NAMESPACE, CONTROLLER_SCOPE, input.id);
  if (input.kind === 'project') return readControlPlaneRecordWithinTransaction(database, PROJECT_SEMANTIC_NAMESPACE, input.workspaceId, input.id);
  if (input.kind === 'requirement') return readControlPlaneRecordWithinTransaction(database, 'requirement', CONTROLLER_SCOPE, input.id);
  if (!input.repositoryId) return undefined;
  if (input.kind === 'plan') return readControlPlaneRecordWithinTransaction(database, 'plan_contract', input.repositoryId, input.id);
  if (input.kind === 'work') return readControlPlaneRecordWithinTransaction(database, 'work_contract', input.repositoryId, input.id);
  return undefined;
}

function localSemanticValue(kind: SemanticSyncRecordKind, value: unknown): unknown {
  if (kind === 'workspace' || kind === 'project') return value;
  if (kind === 'requirement') return projectRequirementSemantic(value as Requirement);
  if (kind === 'plan') return projectPlanSemantic(value as PlanContract);
  if (kind === 'work') return projectWorkSemantic(value as WorkContract);
  return value;
}

export function boundedSemanticSyncJournal(entries: readonly SemanticSyncJournalEntry[]): SemanticSyncJournalEntry[] {
  return entries.slice(-MAX_SEMANTIC_SYNC_JOURNAL_ENTRIES).map((entry) => ({
    ...entry,
    sampledKeys: [...entry.sampledKeys].slice(0, MAX_SEMANTIC_SYNC_JOURNAL_KEY_SAMPLES),
  }));
}

function assertBundle(bundle: SemanticSyncBundle): void {
  if (bundle.schemaVersion !== 1 || bundle.kind !== 'forge_semantic_sync_bundle') throw new Error('SEMANTIC_SYNC_BUNDLE_SCHEMA_INVALID');
  if (!bundle.workspaceId.trim() || !bundle.projectId.trim() || !bundle.sourceForgeInstanceId.trim()) throw new Error('SEMANTIC_SYNC_BUNDLE_IDENTITY_REQUIRED');
  assertSemanticSyncRecordBounds(bundle.records);
  assertControlPlaneMetadataPayload(bundle, 'semantic_sync_bundle');
  if (Buffer.byteLength(stableJson(bundle), 'utf8') > MAX_SEMANTIC_SYNC_BUNDLE_BYTES) throw new Error('SEMANTIC_SYNC_BUNDLE_TOO_LARGE');
  const { contentFingerprint: _fingerprint, ...base } = bundle;
  if (bundle.contentFingerprint !== bundleFingerprint(base)) throw new Error('SEMANTIC_SYNC_BUNDLE_FINGERPRINT_MISMATCH');
  const workspaceRecords = bundle.records.filter((entry) => entry.kind === 'workspace');
  const projectRecords = bundle.records.filter((entry) => entry.kind === 'project');
  if (workspaceRecords.length !== 1 || workspaceRecords[0]?.id !== bundle.workspaceId) throw new Error('SEMANTIC_SYNC_WORKSPACE_IDENTITY_MISMATCH');
  if (projectRecords.length !== 1 || projectRecords[0]?.id !== bundle.projectId) throw new Error('SEMANTIC_SYNC_PROJECT_IDENTITY_MISMATCH');
  const workspaceValue = workspaceRecords[0]?.envelope.value as { workspaceId?: unknown } | undefined;
  const projectValue = projectRecords[0]?.envelope.value as { projectId?: unknown; workspaceId?: unknown } | undefined;
  if (workspaceValue?.workspaceId !== bundle.workspaceId) throw new Error('SEMANTIC_SYNC_WORKSPACE_PAYLOAD_MISMATCH');
  if (projectValue?.projectId !== bundle.projectId || projectValue?.workspaceId !== bundle.workspaceId) throw new Error('SEMANTIC_SYNC_PROJECT_PAYLOAD_MISMATCH');
  for (const entry of bundle.records) {
    const key = semanticSyncRecordKey(entry.kind, entry.id);
    if (entry.fingerprint !== sha256(entry.envelope)) throw new Error(`SEMANTIC_SYNC_RECORD_FINGERPRINT_MISMATCH: ${key}`);
    if (entry.envelope.metadata.forgeInstanceId !== bundle.sourceForgeInstanceId || entry.envelope.metadata.origin !== 'local') {
      throw new Error(`SEMANTIC_SYNC_RECORD_SOURCE_MISMATCH: ${key}`);
    }
  }
}

export function importSemanticSyncBundle(input: {
  controllerHome: string;
  bundle: SemanticSyncBundle;
  now?: () => string;
}): SemanticSyncImportReceipt {
  assertBundle(input.bundle);
  const instance = readForgeInstanceIdentity(input.controllerHome);
  if (!instance) throw new Error('SEMANTIC_SYNC_FORGE_INSTANCE_IDENTITY_REQUIRED');
  if (instance.instanceId === input.bundle.sourceForgeInstanceId) throw new Error('SEMANTIC_SYNC_SELF_IMPORT_REFUSED');
  const placement = readProjectPlacement(input.controllerHome, instance.instanceId, input.bundle.projectId);
  const repositoryId = placement?.value.repositoryId;
  const importedAt = input.now?.() ?? new Date().toISOString();
  const scope = replicaScope(input.bundle.workspaceId, input.bundle.projectId);
  const applied: string[] = [];
  const converged: string[] = [];
  const replicaRevisions: Record<string, number> = {};

  withControlPlaneTransaction(input.controllerHome, (database) => {
    for (const incoming of input.bundle.records) {
      const key = semanticSyncRecordKey(incoming.kind, incoming.id);
      const local = localRecordWithinTransaction(database, { kind: incoming.kind, id: incoming.id, workspaceId: input.bundle.workspaceId, repositoryId });
      if (local) {
        if (stableJson(localSemanticValue(incoming.kind, local.value)) !== stableJson(incoming.envelope.value)) {
          throw new Error(`SEMANTIC_SYNC_LOCAL_AUTHORITY_CONFLICT: ${key}`);
        }
        converged.push(key);
        continue;
      }
      const currentReplica = readControlPlaneRecordWithinTransaction<SemanticSyncReplica>(database, SEMANTIC_SYNC_REPLICA_NAMESPACE, scope, key);
      if (currentReplica?.value.record.fingerprint === incoming.fingerprint) {
        converged.push(key);
        replicaRevisions[key] = currentReplica.revision;
        continue;
      }
      try {
        const written = writeControlPlaneRecordWithinTransaction(database, {
          namespace: SEMANTIC_SYNC_REPLICA_NAMESPACE,
          scope,
          key,
          schemaVersion: 1,
          value: { schemaVersion: 1, sourceForgeInstanceId: input.bundle.sourceForgeInstanceId, importedAt, record: incoming } satisfies SemanticSyncReplica,
          action: 'semantic_sync_replica_import',
          expectedRevision: incoming.condition.expectedRevision,
        });
        applied.push(key);
        replicaRevisions[key] = written.revision;
      } catch (error) {
        if (error instanceof ControlPlaneConflictError) {
          throw new Error(`SEMANTIC_SYNC_REPLICA_REVISION_CONFLICT: ${key} expected=${error.expectedRevision ?? 'absent'} actual=${error.actualRevision ?? 'absent'}`);
        }
        throw error;
      }
    }
    const currentJournal = readControlPlaneRecordWithinTransaction<SemanticSyncJournal>(database, SEMANTIC_SYNC_JOURNAL_NAMESPACE, scope, JOURNAL_KEY);
    const entries = boundedSemanticSyncJournal([...(currentJournal?.value.entries ?? []), {
      schemaVersion: 1,
      sourceForgeInstanceId: input.bundle.sourceForgeInstanceId,
      bundleFingerprint: input.bundle.contentFingerprint,
      importedAt,
      appliedCount: applied.length,
      convergedCount: converged.length,
      sampledKeys: [...applied, ...converged].slice(0, MAX_SEMANTIC_SYNC_JOURNAL_KEY_SAMPLES),
    }]);
    const journalValue = { schemaVersion: 1, entries } satisfies SemanticSyncJournal;
    assertControlPlaneMetadataPayload(journalValue, 'semantic_sync_journal');
    writeControlPlaneRecordWithinTransaction(database, {
      namespace: SEMANTIC_SYNC_JOURNAL_NAMESPACE,
      scope,
      key: JOURNAL_KEY,
      schemaVersion: 1,
      value: journalValue,
      action: 'semantic_sync_journal_append',
      expectedRevision: currentJournal?.revision ?? null,
    });
  });

  return {
    schemaVersion: 1,
    workspaceId: input.bundle.workspaceId,
    projectId: input.bundle.projectId,
    sourceForgeInstanceId: input.bundle.sourceForgeInstanceId,
    targetForgeInstanceId: instance.instanceId,
    bundleFingerprint: input.bundle.contentFingerprint,
    importedAt,
    applied,
    converged,
    replicaRevisions,
  };
}

export function listSemanticSyncReplicas(input: { controllerHome: string; workspaceId: string; projectId: string; limit?: number }): ControlPlaneRecord<SemanticSyncReplica>[] {
  return listControlPlaneRecords<SemanticSyncReplica>(input.controllerHome, {
    namespace: SEMANTIC_SYNC_REPLICA_NAMESPACE,
    scope: replicaScope(input.workspaceId, input.projectId),
    limit: input.limit ?? 1_000,
  });
}

export function readSemanticSyncJournal(input: { controllerHome: string; workspaceId: string; projectId: string }): SemanticSyncJournalEntry[] {
  const records = listControlPlaneRecords<SemanticSyncJournal>(input.controllerHome, {
    namespace: SEMANTIC_SYNC_JOURNAL_NAMESPACE,
    scope: replicaScope(input.workspaceId, input.projectId),
    limit: 1,
  });
  return records[0]?.value.entries ?? [];
}
