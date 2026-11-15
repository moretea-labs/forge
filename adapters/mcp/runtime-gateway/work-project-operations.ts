import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { ensureForgeInstanceIdentity, readForgeInstanceIdentity } from '../../../packages/kernel/identity/api/index';
import type { ProjectIdentity, ProjectPlacement } from '../../../packages/kernel/identity/api/index';
import { normalizeRemoteUrl, portableProjectSourceFingerprint, stablePortableProjectId } from '../../../src/core/repository/identity';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade';
import { listRequirementsForRepository } from '../../../src/runtime/control-plane/facade/requirement-authority';
import { listRequirements, requirementSemanticView } from '../../../src/runtime/control-plane/persistence/requirement-store';
import {
  createProjectIdentity,
  DEFAULT_PERSONAL_WORKSPACE_ID,
  ensureProjectWorkspaceBinding,
  listAllProjectIdentities,
  listProjectIdentities,
  listProjectPlacements,
  listProjectRevisionRecords,
  readProjectIdentity,
  readWorkspaceIdentity,
  writeProjectIdentity,
} from '../../../src/runtime/control-plane/workspace/workspace-store';
import { result } from './result-adapter';

const RH_WORK_PROJECT_OPERATIONS = new Set(['project_create', 'project_list', 'project_get', 'project_revise']);

type ProjectRecord = ReturnType<typeof listProjectIdentities>[number];
type Repository = NonNullable<MultiRepositoryMcpToolContext['explicitRepository']>;

export function isRhWorkProjectOperation(operation: string): boolean {
  return RH_WORK_PROJECT_OPERATIONS.has(operation);
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function currentPlacements(ctx: MultiRepositoryMcpToolContext, projectId: string): ProjectPlacement[] {
  const instance = readForgeInstanceIdentity(ctx.controllerHome);
  if (!instance) return [];
  const placements = listProjectPlacements(ctx.controllerHome, instance.instanceId);
  if (placements.length >= 1_000) throw new Error('PROJECT_PLACEMENT_LOOKUP_LIMIT');
  return placements.filter(({ value }) => value.projectId === projectId).map(({ value }) => value);
}

function projectView(ctx: MultiRepositoryMcpToolContext, record: ProjectRecord) {
  const value: ProjectIdentity = record.value;
  return {
    projectId: value.projectId,
    workspaceId: value.workspaceId,
    displayName: value.displayName,
    status: value.status ?? 'active',
    revision: record.revision,
    updatedAt: record.updatedAt,
    placements: currentPlacements(ctx, value.projectId),
  };
}

function projectRequirements(ctx: MultiRepositoryMcpToolContext, projectId: string, placements: readonly ProjectPlacement[]) {
  const requirementsById = new Map<string, ReturnType<typeof requirementSemanticView>>();
  for (const record of listRequirements({ controllerHome: ctx.controllerHome }, 1000)) {
    if (record.value.projectId === projectId) {
      const requirement = requirementSemanticView(record.value);
      requirementsById.set(requirement.requirementId, requirement);
    }
  }
  for (const repoId of new Set(placements.map((placement) => placement.repositoryId))) {
    for (const record of listRequirementsForRepository({ controllerHome: ctx.controllerHome }, repoId, 1000)) {
      const requirement = requirementSemanticView(record.value);
      requirementsById.set(requirement.requirementId, requirement);
    }
  }
  const all = [...requirementsById.values()]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.requirementId.localeCompare(right.requirementId));
  return {
    requirements: all.slice(0, 100).map((requirement) => ({
      requirementId: requirement.requirementId,
      revision: requirement.revision,
      projectId,
      ...(requirement.repoId ? { repoId: requirement.repoId } : {}),
      title: requirement.title.slice(0, 240),
      status: requirement.status,
      ...(requirement.priority ? { priority: requirement.priority } : {}),
      ...(requirement.assignee ? { assignee: requirement.assignee } : {}),
      dependencyCount: requirement.dependsOnRequirementIds.length,
      updatedAt: requirement.updatedAt,
    })),
    requirementCount: all.length,
    requirementsTruncated: all.length > 100,
  };
}

function findProject(ctx: MultiRepositoryMcpToolContext, projectId: string, workspaceId?: string): ProjectRecord | undefined {
  if (workspaceId) return readProjectIdentity(ctx.controllerHome, workspaceId, projectId);
  const projects = listAllProjectIdentities(ctx.controllerHome);
  if (projects.length >= 1_000) throw new Error('PROJECT_IDENTITY_LOOKUP_LIMIT');
  const matches = projects.filter(({ value }) => value.projectId === projectId);
  if (matches.length > 1) throw new Error(`PROJECT_IDENTITY_AMBIGUOUS: ${projectId}`);
  return matches[0];
}

function blocked(message: string, data: Record<string, unknown> = {}): CallToolResult {
  return result(buildFacadeResult({ status: 'blocked', summary: message, data }) as unknown as Record<string, unknown>, true);
}

export function callRhWorkProjectOperation(
  ctx: MultiRepositoryMcpToolContext,
  repository: Repository | undefined,
  operation: string,
  args: Record<string, unknown>,
): CallToolResult | undefined {
  if (!isRhWorkProjectOperation(operation)) return undefined;

  try {
    if (operation === 'project_list') {
      const limit = Math.max(1, Math.min(Math.trunc(typeof args.limit === 'number' ? args.limit : 50), 100));
      const workspaceId = text(args.workspace_id);
      const statusFilter = text(args.project_status);
      if (statusFilter && statusFilter !== 'active' && statusFilter !== 'archived') return blocked('PROJECT_STATUS_INVALID.');
      if (workspaceId && !readWorkspaceIdentity(ctx.controllerHome, workspaceId)) {
        return result(buildFacadeResult({ status: 'not_found', summary: `Workspace ${workspaceId} not found.`, data: { workspaceId } }) as unknown as Record<string, unknown>, true);
      }
      const records = workspaceId
        ? listProjectIdentities(ctx.controllerHome, workspaceId)
        : listAllProjectIdentities(ctx.controllerHome);
      if (records.length >= 1_000) throw new Error('PROJECT_IDENTITY_LOOKUP_LIMIT');
      const projects = records
        .filter(({ value }) => !statusFilter || (value.status ?? 'active') === statusFilter)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, limit)
        .map((record) => projectView(ctx, record));
      return result(buildFacadeResult({
        summary: `Listed ${projects.length} Forge projects from canonical Project identity${statusFilter ? ` (${statusFilter})` : ''}.`,
        data: { authority: 'project_semantic', bounded: true, limit, ...(statusFilter ? { statusFilter } : {}), projects },
      }) as unknown as Record<string, unknown>);
    }

    const projectId = text(args.project_id);
    if (operation !== 'project_create' && !projectId) return blocked('PROJECT_ID_REQUIRED.');

    if (operation === 'project_create') {
      const displayName = text(args.project_display_name);
      if (!displayName) return blocked('PROJECT_DISPLAY_NAME_REQUIRED.');
      const requestedWorkspaceId = text(args.workspace_id);
      const workspaceId = requestedWorkspaceId ?? DEFAULT_PERSONAL_WORKSPACE_ID;
      if (repository) {
        const canonicalRemote = repository.canonicalRemote ?? normalizeRemoteUrl(repository.remoteUrl);
        const fallbackProjectId = canonicalRemote ? stablePortableProjectId(canonicalRemote) : undefined;
        const sourceFingerprint = canonicalRemote ? portableProjectSourceFingerprint(canonicalRemote) : undefined;
        if (!projectId && !fallbackProjectId) return blocked('PROJECT_PORTABLE_IDENTITY_REQUIRED. Select a repository with a canonical remote or provide project_id.');
        if (requestedWorkspaceId) {
          const existingProjects = listAllProjectIdentities(ctx.controllerHome);
          if (existingProjects.length >= 1_000) throw new Error('PROJECT_IDENTITY_LOOKUP_LIMIT');
          const candidateId = projectId ?? fallbackProjectId;
          const existing = existingProjects.filter(({ value }) => value.projectId === candidateId
            || Boolean(sourceFingerprint && value.sourceFingerprint === sourceFingerprint));
          const workspaceMismatch = existing.find(({ value }) => value.workspaceId !== requestedWorkspaceId);
          if (workspaceMismatch) return blocked(`PROJECT_WORKSPACE_MISMATCH: existing project belongs to ${workspaceMismatch.value.workspaceId}.`, { projectId: workspaceMismatch.value.projectId, workspaceId: workspaceMismatch.value.workspaceId });
        }
        const instance = ensureForgeInstanceIdentity({ controllerHome: ctx.controllerHome, label: 'Forge Runtime' });
        const binding = ensureProjectWorkspaceBinding({
          controllerHome: ctx.controllerHome,
          preferredProjectId: projectId,
          fallbackProjectId,
          sourceFingerprint,
          displayName,
          forgeInstanceId: instance.instanceId,
          repositoryId: repository.repoId,
          defaultWorkspaceId: workspaceId,
        });
        if (requestedWorkspaceId && binding.project.workspaceId !== requestedWorkspaceId) {
          return blocked(`PROJECT_WORKSPACE_MISMATCH: existing project belongs to ${binding.project.workspaceId}.`, { projectId: binding.project.projectId, workspaceId: binding.project.workspaceId });
        }
        const record = readProjectIdentity(ctx.controllerHome, binding.project.workspaceId, binding.project.projectId);
        if (!record) throw new Error('PROJECT_IDENTITY_UNRESOLVED_AFTER_CREATE');
        return result(buildFacadeResult({
          summary: binding.createdProject ? `Project ${binding.project.projectId} created and bound to repository ${repository.repoId}.` : `Project ${binding.project.projectId} already exists; its repository placement was reused.`,
          data: { authority: 'project_semantic', project: projectView(ctx, record), projectCreated: binding.createdProject, placementCreated: binding.createdPlacement },
        }) as unknown as Record<string, unknown>);
      }

      if (!projectId) return blocked('PROJECT_ID_REQUIRED when creating a project without a selected repository.');
      const record = createProjectIdentity({
        controllerHome: ctx.controllerHome,
        value: { projectId, workspaceId, displayName },
      });
      return result(buildFacadeResult({
        summary: `Project ${projectId} created in workspace ${workspaceId}.`,
        data: { authority: 'project_semantic', project: projectView(ctx, record), projectCreated: true, placementCreated: false },
      }) as unknown as Record<string, unknown>);
    }

    const workspaceId = text(args.workspace_id);
    const record = findProject(ctx, projectId!, workspaceId);
    if (!record) {
      return result(buildFacadeResult({ status: 'not_found', summary: `Project ${projectId} not found.`, data: { projectId, ...(workspaceId ? { workspaceId } : {}) } }) as unknown as Record<string, unknown>, true);
    }

    if (operation === 'project_get') {
      const detailLevel = args.detail_level === 'detail' ? 'detail' : 'summary';
      const project = projectView(ctx, record);
      const taskProjection = detailLevel === 'detail' ? projectRequirements(ctx, project.projectId, project.placements) : undefined;
      const revisionHistory = detailLevel === 'detail'
        ? listProjectRevisionRecords(ctx.controllerHome, projectId!, 50)
        : undefined;
      return result(buildFacadeResult({
        summary: `Project ${projectId} retrieved at record revision ${record.revision}.`,
        data: {
          authority: 'project_semantic',
          project,
          ...(taskProjection ? taskProjection : {}),
          ...(revisionHistory ? { revisionHistory } : {}),
        },
        detailLevel,
      }) as unknown as Record<string, unknown>);
    }

    const expectedRevision = typeof args.expected_revision === 'number' ? Math.trunc(args.expected_revision) : undefined;
    if (!Number.isInteger(expectedRevision) || expectedRevision! < 1) return blocked('PROJECT_EXPECTED_REVISION_REQUIRED.');
    const displayName = text(args.project_display_name);
    const status = text(args.project_status);
    if (!displayName && !status) return blocked('PROJECT_REVISION_EMPTY. Supply project_display_name or project_status.');
    if (status && status !== 'active' && status !== 'archived') return blocked('PROJECT_STATUS_INVALID.');
    const updated = writeProjectIdentity({
      controllerHome: ctx.controllerHome,
      value: {
        ...record.value,
        ...(displayName ? { displayName } : {}),
        ...(status ? { status: status as ProjectIdentity['status'] } : {}),
      },
      expectedRevision,
    });
    return result(buildFacadeResult({
      summary: `Project ${projectId} revised to record revision ${updated.revision}.`,
      data: { authority: 'project_semantic', expectedRevision, project: projectView(ctx, updated) },
    }) as unknown as Record<string, unknown>);
  } catch (error) {
    return blocked(error instanceof Error ? error.message : String(error), { projectId: text(args.project_id) });
  }
}
