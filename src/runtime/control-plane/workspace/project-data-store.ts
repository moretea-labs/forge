import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  assertSemanticSyncRecordBounds,
  MAX_SEMANTIC_SYNC_JOURNAL_KEY_SAMPLES,
  readForgeInstanceIdentity,
  scopeRef,
  semanticRecordMetadata,
  semanticSyncRecordKey,
  type SemanticSyncBundle,
  type SemanticSyncImportReceipt,
  type SemanticSyncRecord,
  type SemanticSyncRecordKind,
} from '../../../../packages/kernel/identity/api/index';
import { SEMANTIC_SCOPE_KEY } from '../../../effects/controller-home';
import type { PlanContract } from '../facade/types';
import { assertControlPlaneMetadataPayload } from '../persistence/metadata-payload-policy';
import type { Requirement } from '../persistence/requirement-store';
import {
  ControlPlaneConflictError,
  listControlPlaneRecords,
  readControlPlaneRecordWithinTransaction,
  withControlPlaneTransaction,
  writeControlPlaneRecordWithinTransaction,
  type SqliteDatabase,
} from '../persistence/sqlite-store';
import {
  SEMANTIC_SYNC_JOURNAL_NAMESPACE,
  SEMANTIC_SYNC_REPLICA_NAMESPACE,
  boundedSemanticSyncJournal,
  type SemanticSyncJournalEntry,
  type SemanticSyncReplica,
} from './semantic-sync-service';
import {
  PROJECT_SEMANTIC_NAMESPACE,
  WORKSPACE_SEMANTIC_NAMESPACE,
  readProjectIdentity,
  readProjectPlacement,
  readWorkspaceIdentity,
} from './workspace-store';

export const PROJECT_DATA_ROOT = '.forge/project-data';
export const PROJECT_DATA_MANIFEST_NAME = 'manifest.json';

const CONTROLLER_SCOPE = 'controller';
const FORBIDDEN_PROGRESS_KEYS = [
  'state',
  'status',
  'priority',
  'assignee',
  'progressSummary',
  'remainingWork',
  'acceptedEvidenceRefs',
  'needsAttention',
] as const;

export interface ProjectDataRequirementDefinition {
  schemaVersion: 1;
  requirementId: string;
  title: string;
  outcomeStatement: string;
  acceptanceCriteria: string[];
  requiredDeliveryReferences: string[];
  parentRequirementId?: string;
  rootRequirementId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProjectDataPlanDefinition {
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
  steps: Array<{
    id: string;
    objective: string;
    dependencies: string[];
    acceptanceCriteria: string[];
  }>;
  supersedes?: string[];
  supersededBy?: string;
  supersessionReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDataRecordFile<T> {
  schemaVersion: 1;
  kind: 'requirement' | 'plan' | 'workspace' | 'project';
  id: string;
  revision: number;
  updatedAt: string;
  digest: string;
  value: T;
}

export interface ProjectDataManifest {
  schemaVersion: 1;
  kind: 'forge_project_data_manifest';
  workspaceId: string;
  projectId: string;
  generatedAt: string;
  sourceForgeInstanceId: string;
  baseGitSha: string | null;
  records: Array<{
    kind: ProjectDataRecordFile<unknown>['kind'];
    id: string;
    path: string;
    revision: number;
    digest: string;
  }>;
  contentDigest: string;
}

export interface ProjectDataSnapshot {
  manifest: ProjectDataManifest;
  workspace: ProjectDataRecordFile<Record<string, unknown>>;
  project: ProjectDataRecordFile<Record<string, unknown>>;
  requirements: ProjectDataRecordFile<ProjectDataRequirementDefinition>[];
  plans: ProjectDataRecordFile<ProjectDataPlanDefinition>[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function assertNoProgressFields(value: Record<string, unknown>, label: string): void {
  for (const key of FORBIDDEN_PROGRESS_KEYS) {
    if (Object.hasOwn(value, key)) {
      throw new Error(`PROJECT_DATA_PROGRESS_FIELD_FORBIDDEN:${label}:${key}`);
    }
  }
}

export function projectDataRequirementDefinition(requirement: Requirement): ProjectDataRequirementDefinition {
  const value: ProjectDataRequirementDefinition = {
    schemaVersion: 1,
    requirementId: requirement.requirementId,
    title: requirement.title,
    outcomeStatement: requirement.outcomeStatement,
    acceptanceCriteria: [...requirement.acceptanceCriteria],
    requiredDeliveryReferences: [...requirement.requiredDeliveryReferences],
    ...(requirement.parentRequirementId ? { parentRequirementId: requirement.parentRequirementId } : {}),
    ...(requirement.rootRequirementId ? { rootRequirementId: requirement.rootRequirementId } : {}),
    ...(typeof requirement.createdAt === 'string' ? { createdAt: requirement.createdAt } : {}),
    ...(typeof requirement.updatedAt === 'string' ? { updatedAt: requirement.updatedAt } : {}),
  };
  assertNoProgressFields(value as unknown as Record<string, unknown>, `requirement:${requirement.requirementId}`);
  return value;
}

export function projectDataPlanDefinition(plan: PlanContract): ProjectDataPlanDefinition {
  const value: ProjectDataPlanDefinition = {
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
    steps: plan.steps.map((step) => ({
      id: step.id,
      objective: step.objective,
      dependencies: [...step.dependencies],
      acceptanceCriteria: [...step.acceptanceCriteria],
    })),
    ...(plan.supersedes ? { supersedes: [...plan.supersedes] } : {}),
    ...(plan.supersededBy ? { supersededBy: plan.supersededBy } : {}),
    ...(plan.supersessionReason ? { supersessionReason: plan.supersessionReason } : {}),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
  assertNoProgressFields(value as unknown as Record<string, unknown>, `plan:${plan.planId}`);
  for (const step of value.steps) {
    assertNoProgressFields(step as unknown as Record<string, unknown>, `plan:${plan.planId}:step:${step.id}`);
  }
  return value;
}

function recordDigestBase<T>(
  record: Omit<ProjectDataRecordFile<T>, 'digest'>,
): Omit<ProjectDataRecordFile<T>, 'digest'> {
  return {
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    id: record.id,
    revision: record.revision,
    updatedAt: record.updatedAt,
    value: record.value,
  };
}

function assertRecordDigest<T>(record: ProjectDataRecordFile<T>): void {
  if (sha256(recordDigestBase(record)) !== record.digest) {
    throw new Error(`PROJECT_DATA_RECORD_DIGEST_MISMATCH:${record.kind}:${record.id}`);
  }
}

function recordFile<T>(input: {
  kind: ProjectDataRecordFile<T>['kind'];
  id: string;
  revision: number;
  updatedAt: string;
  value: T;
}): ProjectDataRecordFile<T> {
  const base = recordDigestBase({
    schemaVersion: 1,
    kind: input.kind,
    id: input.id,
    revision: input.revision,
    updatedAt: input.updatedAt,
    value: input.value,
  });
  return { ...base, digest: sha256(base) };
}

function relativeRecordPath(kind: ProjectDataRecordFile<unknown>['kind'], id: string): string {
  if (kind === 'workspace') return 'workspace.json';
  if (kind === 'project') return 'project.json';
  if (kind === 'requirement') return join('requirements', `${id}.json`);
  return join('plans', `${id}.json`);
}

/**
 * Build a stage-1 Git project-data snapshot from Controller Home semantics.
 * Progress fields are stripped; placements and local paths are never included.
 */
export function buildProjectDataSnapshot(input: {
  controllerHome: string;
  workspaceId: string;
  projectId: string;
  baseGitSha?: string | null;
  now?: () => string;
}): ProjectDataSnapshot {
  const instance = readForgeInstanceIdentity(input.controllerHome);
  if (!instance) throw new Error('PROJECT_DATA_FORGE_INSTANCE_IDENTITY_REQUIRED');
  const workspace = readWorkspaceIdentity(input.controllerHome, input.workspaceId);
  if (!workspace) throw new Error(`PROJECT_DATA_WORKSPACE_NOT_FOUND:${input.workspaceId}`);
  const project = readProjectIdentity(input.controllerHome, workspace.value.workspaceId, input.projectId);
  if (!project) throw new Error(`PROJECT_DATA_PROJECT_NOT_FOUND:${input.projectId}`);
  const placement = readProjectPlacement(input.controllerHome, instance.instanceId, project.value.projectId);
  if (!placement) throw new Error(`PROJECT_DATA_PROJECT_PLACEMENT_NOT_FOUND:${project.value.projectId}`);

  const repoId = placement.value.repositoryId;
  const plans = listControlPlaneRecords<PlanContract>(input.controllerHome, {
    namespace: 'plan_contract',
    scope: repoId,
    limit: 1_000,
  });
  const planRequirementIds = new Set<string>();
  for (const plan of plans) {
    if (plan.value.requirementId?.trim()) planRequirementIds.add(plan.value.requirementId.trim());
  }
  const projectId = project.value.projectId;
  const requirements = listControlPlaneRecords<Requirement>(input.controllerHome, {
    namespace: 'requirement',
    scope: CONTROLLER_SCOPE,
    limit: 5_000,
  }).filter((entry) => {
    const ownedByProject = entry.value.projectId?.trim() === projectId;
    return ownedByProject || planRequirementIds.has(entry.value.requirementId);
  });

  const workspaceRecord = recordFile({
    kind: 'workspace',
    id: workspace.value.workspaceId,
    revision: workspace.revision,
    updatedAt: workspace.updatedAt,
    value: { ...workspace.value } as Record<string, unknown>,
  });
  const projectRecord = recordFile({
    kind: 'project',
    id: project.value.projectId,
    revision: project.revision,
    updatedAt: project.updatedAt,
    value: {
      projectId: project.value.projectId,
      workspaceId: project.value.workspaceId,
      displayName: project.value.displayName,
      ...(project.value.sourceFingerprint ? { sourceFingerprint: project.value.sourceFingerprint } : {}),
      ...(project.value.rootRequirementId ? { rootRequirementId: project.value.rootRequirementId } : {}),
    },
  });
  const requirementRecords = requirements
    .map((entry) =>
      recordFile({
        kind: 'requirement',
        id: entry.value.requirementId,
        revision: entry.revision,
        updatedAt: entry.updatedAt,
        value: projectDataRequirementDefinition(entry.value),
      }),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const planRecords = plans
    .map((entry) =>
      recordFile({
        kind: 'plan',
        id: entry.value.planId,
        revision: entry.revision,
        updatedAt: entry.updatedAt,
        value: projectDataPlanDefinition(entry.value),
      }),
    )
    .sort((left, right) => left.id.localeCompare(right.id));

  const recordIndex = [
    {
      kind: workspaceRecord.kind,
      id: workspaceRecord.id,
      path: relativeRecordPath(workspaceRecord.kind, workspaceRecord.id),
      revision: workspaceRecord.revision,
      digest: workspaceRecord.digest,
    },
    {
      kind: projectRecord.kind,
      id: projectRecord.id,
      path: relativeRecordPath(projectRecord.kind, projectRecord.id),
      revision: projectRecord.revision,
      digest: projectRecord.digest,
    },
    ...requirementRecords.map((entry) => ({
      kind: entry.kind,
      id: entry.id,
      path: relativeRecordPath(entry.kind, entry.id),
      revision: entry.revision,
      digest: entry.digest,
    })),
    ...planRecords.map((entry) => ({
      kind: entry.kind,
      id: entry.id,
      path: relativeRecordPath(entry.kind, entry.id),
      revision: entry.revision,
      digest: entry.digest,
    })),
  ];
  const manifestBase = {
    schemaVersion: 1 as const,
    kind: 'forge_project_data_manifest' as const,
    workspaceId: workspace.value.workspaceId,
    projectId: project.value.projectId,
    generatedAt: input.now?.() ?? new Date().toISOString(),
    sourceForgeInstanceId: instance.instanceId,
    baseGitSha: input.baseGitSha ?? null,
    records: recordIndex,
  };
  const manifest: ProjectDataManifest = { ...manifestBase, contentDigest: sha256(manifestBase) };
  return {
    manifest,
    workspace: workspaceRecord,
    project: projectRecord,
    requirements: requirementRecords,
    plans: planRecords,
  };
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, `${stableJson(value)}\n`, 'utf8');
  renameSync(tempPath, path);
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/**
 * Materialize a project-data snapshot under repositoryRoot/.forge/project-data.
 * Fails closed when expectedBaseGitSha is supplied and does not match current HEAD.
 */
export function writeProjectDataSnapshot(input: {
  repositoryRoot: string;
  snapshot: ProjectDataSnapshot;
  expectedBaseGitSha?: string | null;
  resolveHeadSha?: () => string | null;
}): { root: string; writtenPaths: string[] } {
  const expected = input.expectedBaseGitSha ?? input.snapshot.manifest.baseGitSha;
  if (expected) {
    const head = (input.resolveHeadSha ?? (() => null))();
    if (!head) throw new Error('PROJECT_DATA_BASE_GIT_SHA_UNRESOLVED');
    if (head !== expected) throw new Error(`PROJECT_DATA_BASE_GIT_SHA_MISMATCH:expected=${expected},actual=${head}`);
  }

  const root = join(input.repositoryRoot, PROJECT_DATA_ROOT);
  const staging = join(input.repositoryRoot, `.forge/.project-data-staging-${process.pid}-${Date.now()}`);
  mkdirSync(staging, { recursive: true });
  try {
    const written: Array<{ absolute: string; relative: string; value: unknown }> = [
      { absolute: join(staging, 'workspace.json'), relative: 'workspace.json', value: input.snapshot.workspace },
      { absolute: join(staging, 'project.json'), relative: 'project.json', value: input.snapshot.project },
      ...input.snapshot.requirements.map((entry) => ({
        absolute: join(staging, 'requirements', `${entry.id}.json`),
        relative: join('requirements', `${entry.id}.json`),
        value: entry,
      })),
      ...input.snapshot.plans.map((entry) => ({
        absolute: join(staging, 'plans', `${entry.id}.json`),
        relative: join('plans', `${entry.id}.json`),
        value: entry,
      })),
      {
        absolute: join(staging, PROJECT_DATA_MANIFEST_NAME),
        relative: PROJECT_DATA_MANIFEST_NAME,
        value: input.snapshot.manifest,
      },
    ];
    for (const entry of written) writeJsonAtomic(entry.absolute, entry.value);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(dirname(root), { recursive: true });
    renameSync(staging, root);
    return {
      root,
      writtenPaths: written.map((entry) => join(PROJECT_DATA_ROOT, entry.relative)),
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function readProjectDataSnapshot(repositoryRoot: string): ProjectDataSnapshot {
  const root = join(repositoryRoot, PROJECT_DATA_ROOT);
  const manifestPath = join(root, PROJECT_DATA_MANIFEST_NAME);
  if (!existsSync(manifestPath)) throw new Error('PROJECT_DATA_MANIFEST_NOT_FOUND');
  const manifest = readJsonFile<ProjectDataManifest>(manifestPath);
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'forge_project_data_manifest') {
    throw new Error('PROJECT_DATA_MANIFEST_SCHEMA_INVALID');
  }
  const { contentDigest: _ignored, ...manifestBase } = manifest;
  if (sha256(manifestBase) !== manifest.contentDigest) throw new Error('PROJECT_DATA_MANIFEST_DIGEST_MISMATCH');

  const workspace = readJsonFile<ProjectDataRecordFile<Record<string, unknown>>>(join(root, 'workspace.json'));
  const project = readJsonFile<ProjectDataRecordFile<Record<string, unknown>>>(join(root, 'project.json'));
  assertRecordDigest(workspace);
  assertRecordDigest(project);

  const requirementsDir = join(root, 'requirements');
  const plansDir = join(root, 'plans');
  const requirementFiles = existsSync(requirementsDir)
    ? readdirSync(requirementsDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : [];
  const planFiles = existsSync(plansDir)
    ? readdirSync(plansDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : [];

  const requirements = requirementFiles.map((name) => {
    const record = readJsonFile<ProjectDataRecordFile<ProjectDataRequirementDefinition>>(join(requirementsDir, name));
    assertNoProgressFields(record.value as unknown as Record<string, unknown>, `requirement:${record.id}`);
    assertRecordDigest(record);
    return record;
  });
  const plans = planFiles.map((name) => {
    const record = readJsonFile<ProjectDataRecordFile<ProjectDataPlanDefinition>>(join(plansDir, name));
    assertNoProgressFields(record.value as unknown as Record<string, unknown>, `plan:${record.id}`);
    for (const step of record.value.steps) {
      assertNoProgressFields(step as unknown as Record<string, unknown>, `plan:${record.id}:step:${step.id}`);
    }
    assertRecordDigest(record);
    return record;
  });

  return { manifest, workspace, project, requirements, plans };
}

/** Resolve the exact 40-hex HEAD SHA for project-data base CAS. */
export function resolveProjectDataHeadSha(repositoryRoot: string): string | null {
  const result = spawnSync('git', ['-C', repositoryRoot, 'rev-parse', '--verify', 'HEAD'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.status !== 0) return null;
  const sha = String(result.stdout ?? '')
    .trim()
    .toLowerCase();
  return /^[a-f0-9]{40}$/.test(sha) ? sha : null;
}

/**
 * Build and materialize stage-1 project-data under the canonical repository.
 * When expectedBaseGitSha is omitted, current HEAD is used for both the
 * manifest base and the fail-closed write precondition.
 */
export function materializeProjectDataToRepository(input: {
  controllerHome: string;
  workspaceId: string;
  projectId: string;
  repositoryRoot: string;
  expectedBaseGitSha?: string | null;
  now?: () => string;
}): { snapshot: ProjectDataSnapshot; writtenPaths: string[]; headSha: string | null } {
  const headSha = resolveProjectDataHeadSha(input.repositoryRoot);
  const expected = input.expectedBaseGitSha === undefined ? headSha : input.expectedBaseGitSha;
  if (expected && !headSha) throw new Error('PROJECT_DATA_BASE_GIT_SHA_UNRESOLVED');
  if (expected && headSha && expected !== headSha) {
    throw new Error(`PROJECT_DATA_BASE_GIT_SHA_MISMATCH:expected=${expected},actual=${headSha}`);
  }
  const snapshot = buildProjectDataSnapshot({
    controllerHome: input.controllerHome,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    baseGitSha: expected ?? null,
    now: input.now,
  });
  const written = writeProjectDataSnapshot({
    repositoryRoot: input.repositoryRoot,
    snapshot,
    expectedBaseGitSha: expected ?? null,
    resolveHeadSha: () => resolveProjectDataHeadSha(input.repositoryRoot),
  });
  return { snapshot, writtenPaths: written.writtenPaths, headSha };
}

function syncRecordFromProjectData<T>(input: {
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

/** Convert a stage-1 Git snapshot into a semantic-sync bundle for replica import. */
export function projectDataSnapshotToSemanticSyncBundle(
  snapshot: ProjectDataSnapshot,
  targetReplicaRevisions?: Readonly<Record<string, number>>,
): SemanticSyncBundle {
  const expected = (kind: SemanticSyncRecordKind, id: string): number | null =>
    targetReplicaRevisions?.[semanticSyncRecordKey(kind, id)] ?? null;
  const source = snapshot.manifest.sourceForgeInstanceId;
  const records: SemanticSyncRecord[] = [
    syncRecordFromProjectData({
      kind: 'workspace',
      id: snapshot.workspace.id,
      revision: snapshot.workspace.revision,
      updatedAt: snapshot.workspace.updatedAt,
      sourceForgeInstanceId: source,
      value: snapshot.workspace.value,
      expectedRevision: expected('workspace', snapshot.workspace.id),
    }),
    syncRecordFromProjectData({
      kind: 'project',
      id: snapshot.project.id,
      revision: snapshot.project.revision,
      updatedAt: snapshot.project.updatedAt,
      sourceForgeInstanceId: source,
      value: snapshot.project.value,
      expectedRevision: expected('project', snapshot.project.id),
    }),
    ...snapshot.requirements.map((entry) =>
      syncRecordFromProjectData({
        kind: 'requirement',
        id: entry.id,
        revision: entry.revision,
        updatedAt: entry.updatedAt,
        sourceForgeInstanceId: source,
        value: entry.value,
        expectedRevision: expected('requirement', entry.id),
      }),
    ),
    ...snapshot.plans.map((entry) =>
      syncRecordFromProjectData({
        kind: 'plan',
        id: entry.id,
        revision: entry.revision,
        updatedAt: entry.updatedAt,
        sourceForgeInstanceId: source,
        value: entry.value,
        expectedRevision: expected('plan', entry.id),
      }),
    ),
  ];
  records.sort((left, right) =>
    semanticSyncRecordKey(left.kind, left.id).localeCompare(semanticSyncRecordKey(right.kind, right.id)),
  );
  assertSemanticSyncRecordBounds(records);
  const base = {
    schemaVersion: 1 as const,
    kind: 'forge_semantic_sync_bundle' as const,
    workspaceId: snapshot.manifest.workspaceId,
    projectId: snapshot.manifest.projectId,
    sourceForgeInstanceId: source,
    generatedAt: snapshot.manifest.generatedAt,
    records,
  };
  const bundle: SemanticSyncBundle = { ...base, contentFingerprint: sha256(base) };
  assertControlPlaneMetadataPayload(bundle, 'semantic_sync_bundle');
  return bundle;
}

function localProjectDataValue(
  database: SqliteDatabase,
  input: { kind: SemanticSyncRecordKind; id: string; workspaceId: string; repositoryId?: string },
): unknown | undefined {
  if (input.kind === 'workspace') {
    const record = readControlPlaneRecordWithinTransaction(
      database,
      WORKSPACE_SEMANTIC_NAMESPACE,
      CONTROLLER_SCOPE,
      input.id,
    );
    return record?.value;
  }
  if (input.kind === 'project') {
    const record = readControlPlaneRecordWithinTransaction(
      database,
      PROJECT_SEMANTIC_NAMESPACE,
      input.workspaceId,
      input.id,
    );
    if (!record) return undefined;
    const value = record.value as Record<string, unknown>;
    return {
      projectId: value.projectId,
      workspaceId: value.workspaceId,
      displayName: value.displayName,
      ...(typeof value.sourceFingerprint === 'string' ? { sourceFingerprint: value.sourceFingerprint } : {}),
      ...(typeof value.rootRequirementId === 'string' ? { rootRequirementId: value.rootRequirementId } : {}),
    };
  }
  if (input.kind === 'requirement') {
    const record = readControlPlaneRecordWithinTransaction<Requirement>(
      database,
      'requirement',
      CONTROLLER_SCOPE,
      input.id,
    );
    return record ? projectDataRequirementDefinition(record.value) : undefined;
  }
  if (input.kind === 'plan') {
    const semantic = readControlPlaneRecordWithinTransaction<PlanContract>(
      database,
      'plan_contract',
      SEMANTIC_SCOPE_KEY,
      input.id,
    );
    const record =
      semantic ??
      (input.repositoryId
        ? readControlPlaneRecordWithinTransaction<PlanContract>(database, 'plan_contract', input.repositoryId, input.id)
        : undefined);
    return record ? projectDataPlanDefinition(record.value) : undefined;
  }
  return undefined;
}

function applyProjectDataReplicaRecord(input: {
  database: SqliteDatabase;
  incoming: SemanticSyncRecord;
  workspaceId: string;
  repositoryId?: string;
  scope: string;
  sourceForgeInstanceId: string;
  importedAt: string;
  applied: string[];
  converged: string[];
  replicaRevisions: Record<string, number>;
}): void {
  const key = semanticSyncRecordKey(input.incoming.kind, input.incoming.id);
  const localValue = localProjectDataValue(input.database, {
    kind: input.incoming.kind,
    id: input.incoming.id,
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
  });
  if (localValue !== undefined) {
    if (stableJson(localValue) !== stableJson(input.incoming.envelope.value)) {
      throw new Error(`PROJECT_DATA_LOCAL_AUTHORITY_CONFLICT:${key}`);
    }
    input.converged.push(key);
    return;
  }
  const currentReplica = readControlPlaneRecordWithinTransaction<SemanticSyncReplica>(
    input.database,
    SEMANTIC_SYNC_REPLICA_NAMESPACE,
    input.scope,
    key,
  );
  if (currentReplica?.value.record.fingerprint === input.incoming.fingerprint) {
    input.converged.push(key);
    input.replicaRevisions[key] = currentReplica.revision;
    return;
  }
  try {
    const written = writeControlPlaneRecordWithinTransaction(input.database, {
      namespace: SEMANTIC_SYNC_REPLICA_NAMESPACE,
      scope: input.scope,
      key,
      schemaVersion: 1,
      value: {
        schemaVersion: 1,
        sourceForgeInstanceId: input.sourceForgeInstanceId,
        importedAt: input.importedAt,
        record: input.incoming,
      } satisfies SemanticSyncReplica,
      action: 'project_data_replica_import',
      expectedRevision: input.incoming.condition.expectedRevision,
    });
    input.applied.push(key);
    input.replicaRevisions[key] = written.revision;
  } catch (error) {
    if (error instanceof ControlPlaneConflictError) {
      throw new Error(
        `PROJECT_DATA_REPLICA_REVISION_CONFLICT:${key}:expected=${error.expectedRevision ?? 'absent'}:actual=${error.actualRevision ?? 'absent'}`,
      );
    }
    throw error;
  }
}

/**
 * Import stage-1 Git project-data as semantic replicas on another Forge instance.
 * Local authority that already matches the definition converges; conflicting
 * local definitions fail closed. Progress fields are never imported from Git.
 */
export function importProjectDataSnapshot(input: {
  controllerHome: string;
  snapshot: ProjectDataSnapshot;
  targetReplicaRevisions?: Readonly<Record<string, number>>;
  now?: () => string;
}): SemanticSyncImportReceipt {
  const bundle = projectDataSnapshotToSemanticSyncBundle(input.snapshot, input.targetReplicaRevisions);
  const instance = readForgeInstanceIdentity(input.controllerHome);
  if (!instance) throw new Error('PROJECT_DATA_FORGE_INSTANCE_IDENTITY_REQUIRED');
  if (instance.instanceId === bundle.sourceForgeInstanceId) throw new Error('PROJECT_DATA_SELF_IMPORT_REFUSED');
  const placement = readProjectPlacement(input.controllerHome, instance.instanceId, bundle.projectId);
  const repositoryId = placement?.value.repositoryId;
  const importedAt = input.now?.() ?? new Date().toISOString();
  const scope = `${bundle.workspaceId.trim()}:${bundle.projectId.trim()}`;
  const applied: string[] = [];
  const converged: string[] = [];
  const replicaRevisions: Record<string, number> = {};

  withControlPlaneTransaction(input.controllerHome, (database) => {
    for (const incoming of bundle.records) {
      applyProjectDataReplicaRecord({
        database,
        incoming,
        workspaceId: bundle.workspaceId,
        repositoryId,
        scope,
        sourceForgeInstanceId: bundle.sourceForgeInstanceId,
        importedAt,
        applied,
        converged,
        replicaRevisions,
      });
    }
    const currentJournal = readControlPlaneRecordWithinTransaction<{
      schemaVersion: 1;
      entries: SemanticSyncJournalEntry[];
    }>(database, SEMANTIC_SYNC_JOURNAL_NAMESPACE, scope, 'journal');
    const entries = boundedSemanticSyncJournal([
      ...(currentJournal?.value.entries ?? []),
      {
        schemaVersion: 1,
        sourceForgeInstanceId: bundle.sourceForgeInstanceId,
        bundleFingerprint: bundle.contentFingerprint,
        importedAt,
        appliedCount: applied.length,
        convergedCount: converged.length,
        sampledKeys: [...applied, ...converged].slice(0, MAX_SEMANTIC_SYNC_JOURNAL_KEY_SAMPLES),
      },
    ]);
    const journalValue = { schemaVersion: 1 as const, entries };
    assertControlPlaneMetadataPayload(journalValue, 'semantic_sync_journal');
    writeControlPlaneRecordWithinTransaction(database, {
      namespace: SEMANTIC_SYNC_JOURNAL_NAMESPACE,
      scope,
      key: 'journal',
      schemaVersion: 1,
      value: journalValue,
      action: 'project_data_journal_append',
      expectedRevision: currentJournal?.revision ?? null,
    });
  });

  return {
    schemaVersion: 1,
    workspaceId: bundle.workspaceId,
    projectId: bundle.projectId,
    sourceForgeInstanceId: bundle.sourceForgeInstanceId,
    targetForgeInstanceId: instance.instanceId,
    bundleFingerprint: bundle.contentFingerprint,
    importedAt,
    applied,
    converged,
    replicaRevisions,
  };
}

export function importProjectDataFromRepository(input: {
  controllerHome: string;
  repositoryRoot: string;
  targetReplicaRevisions?: Readonly<Record<string, number>>;
  now?: () => string;
}): SemanticSyncImportReceipt {
  const snapshot = readProjectDataSnapshot(input.repositoryRoot);
  return importProjectDataSnapshot({
    controllerHome: input.controllerHome,
    snapshot,
    targetReplicaRevisions: input.targetReplicaRevisions,
    now: input.now,
  });
}
