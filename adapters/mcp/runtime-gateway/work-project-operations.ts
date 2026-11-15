import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { ensureForgeInstanceIdentity, readForgeInstanceIdentity } from '../../../packages/kernel/identity/api/index';
import type { ProjectIdentity, ProjectPlacement } from '../../../packages/kernel/identity/api/index';
import { normalizeRemoteUrl, portableProjectSourceFingerprint, stablePortableProjectId } from '../../../src/core/repository/identity';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade';
import { blockingRequirementIds, listRequirementsForProject } from '../../../src/runtime/control-plane/facade/requirement-authority';
import { readPlanContractStore } from '../../../src/runtime/control-plane/facade/plan-contract-store';
import { listAutopilotRunSummaries } from '../../../src/runtime/autopilot/read-model';
import { SEMANTIC_SCOPE_KEY } from '../../../src/effects/controller-home';
import { bindRequirementProjectPlacement, bindRequirementRepositoryPlacement, readRequirement, requirementSemanticView, REQUIREMENT_STATES, type RequirementState } from '../../../src/runtime/control-plane/persistence/requirement-store';
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

const RH_WORK_PROJECT_OPERATIONS = new Set(['project_create', 'project_list', 'project_get', 'project_revise', 'project_attach_requirement']);

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

function projectTasks(ctx: MultiRepositoryMcpToolContext, projectId: string) {
  return listRequirementsForProject({ controllerHome: ctx.controllerHome }, projectId, 1000)
    .map((record) => requirementSemanticView(record.value));
}

function projectTaskSummary(tasks: ReturnType<typeof projectTasks>) {
  const taskStatusCounts = Object.fromEntries(REQUIREMENT_STATES.map((status) => [status, 0])) as Record<RequirementState, number>;
  for (const task of tasks) taskStatusCounts[task.status] += 1;
  return { requirementCount: tasks.length, taskStatusCounts };
}

function projectRequirements(ctx: MultiRepositoryMcpToolContext, projectId: string) {
  const all = projectTasks(ctx, projectId);
  const visible = all.slice(0, 100);
  // One Plan/Run store read per distinct scope/repository, not per visible task row.
  const planCountsByScope = new Map<string, Map<string, number>>();
  const autopilotRuns = listAutopilotRunSummaries(ctx.controllerHome, visible);
  const linkedPlanCount = (requirement: (typeof all)[number]): number => {
    const scope = requirement.repoId ?? SEMANTIC_SCOPE_KEY;
    let counts = planCountsByScope.get(scope);
    if (!counts) {
      counts = new Map<string, number>();
      for (const plan of readPlanContractStore({
        controllerHome: ctx.controllerHome,
        ...(requirement.repoId ? { repoId: requirement.repoId } : { scopeKey: SEMANTIC_SCOPE_KEY }),
      }).contracts) {
        if (plan.requirementId) counts.set(plan.requirementId, (counts.get(plan.requirementId) ?? 0) + 1);
      }
      planCountsByScope.set(scope, counts);
    }
    return counts.get(requirement.requirementId) ?? 0;
  };
  return {
    ...projectTaskSummary(all),
    requirements: visible.map((requirement) => ({
      requirementId: requirement.requirementId,
      revision: requirement.revision,
      projectId,
      ...(requirement.repoId ? { repoId: requirement.repoId } : {}),
      title: requirement.title.slice(0, 240),
      status: requirement.status,
      ...(requirement.priority ? { priority: requirement.priority } : {}),
      ...(requirement.assignee ? { assignee: requirement.assignee } : {}),
      progressSummary: requirement.progressSummary.slice(0, 500),
      remainingWorkCount: requirement.remainingWork.length,
      acceptedEvidenceCount: requirement.acceptedEvidenceRefs.length,
      dependencyCount: requirement.dependsOnRequirementIds.length,
      linkedPlanCount: linkedPlanCount(requirement),
      autopilotRun: autopilotRuns.get(requirement.requirementId) ?? null,
      blockingDependencyIds: blockingRequirementIds({ controllerHome: ctx.controllerHome }, requirement.dependsOnRequirementIds),
      updatedAt: requirement.updatedAt,
    })),
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
      const offset = Math.max(0, Math.min(Math.trunc(typeof args.offset === 'number' && Number.isFinite(args.offset) ? args.offset : 0), 100_000));
      const workspaceId = text(args.workspace_id);
      const statusFilter = text(args.project_status);
      const searchQuery = text(args.search_query);
      const normalizedSearchQuery = searchQuery?.toLowerCase();
      if (statusFilter && statusFilter !== 'active' && statusFilter !== 'archived') return blocked('PROJECT_STATUS_INVALID.');
      if (workspaceId && !readWorkspaceIdentity(ctx.controllerHome, workspaceId)) {
        return result(buildFacadeResult({ status: 'not_found', summary: `Workspace ${workspaceId} not found.`, data: { workspaceId } }) as unknown as Record<string, unknown>, true);
      }
      const records = workspaceId
        ? listProjectIdentities(ctx.controllerHome, workspaceId)
        : listAllProjectIdentities(ctx.controllerHome);
      if (records.length >= 1_000) throw new Error('PROJECT_IDENTITY_LOOKUP_LIMIT');
      const filtered = records
        .filter(({ value }) => (!statusFilter || (value.status ?? 'active') === statusFilter)
          && (!normalizedSearchQuery || value.projectId.toLowerCase().includes(normalizedSearchQuery)
            || value.displayName.toLowerCase().includes(normalizedSearchQuery)))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)
          || left.value.projectId.localeCompare(right.value.projectId));
      const totalCount = filtered.length;
      const projects = filtered.slice(offset, offset + limit).map((record) => ({
        ...projectView(ctx, record),
        ...projectTaskSummary(projectTasks(ctx, record.value.projectId)),
      }));
      const hasMore = offset + projects.length < totalCount;
      return result(buildFacadeResult({
        summary: `Listed ${projects.length} of ${totalCount} Forge projects from canonical Project identity${statusFilter ? ` (${statusFilter})` : ''}${searchQuery ? ` matching "${searchQuery}"` : ''}, starting at offset ${offset}.`,
        data: {
          authority: 'project_semantic', progressAuthority: 'github_issue_project', bounded: true, limit, offset, totalCount,
          hasMore, projectsTruncated: hasMore,
          ...(statusFilter ? { statusFilter } : {}),
          ...(searchQuery ? { searchQuery } : {}), projects,
        },
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

    if (!projectId) return blocked('PROJECT_ID_REQUIRED.');
    const workspaceId = text(args.workspace_id);
    const record = findProject(ctx, projectId, workspaceId);
    if (!record) {
      return result(buildFacadeResult({ status: 'not_found', summary: `Project ${projectId} not found.`, data: { projectId, ...(workspaceId ? { workspaceId } : {}) } }) as unknown as Record<string, unknown>, true);
    }

    if (operation === 'project_get') {
      const detailLevel = args.detail_level === 'detail' ? 'detail' : 'summary';
      const project = projectView(ctx, record);
      const taskProjection = detailLevel === 'detail' ? projectRequirements(ctx, project.projectId) : undefined;
      const revisionHistory = detailLevel === 'detail'
        ? listProjectRevisionRecords(ctx.controllerHome, projectId!, 50)
        : undefined;
      return result(buildFacadeResult({
        summary: `Project ${projectId} retrieved at record revision ${record.revision}.`,
        data: {
          authority: 'project_semantic',
          progressAuthority: 'github_issue_project',
          project,
          ...(taskProjection ? taskProjection : {}),
          ...(revisionHistory ? { revisionHistory } : {}),
        },
        detailLevel,
      }) as unknown as Record<string, unknown>);
    }

    if (operation === 'project_attach_requirement') {
      const requirementId = text(args.requirement_id);
      if (!requirementId) return blocked('PROJECT_REQUIREMENT_ID_REQUIRED.');
      const existing = readRequirement({ controllerHome: ctx.controllerHome }, requirementId);
      if (!existing) {
        return result(buildFacadeResult({
          status: 'not_found',
          summary: `Requirement ${requirementId} not found.`,
          data: { projectId, requirementId },
        }) as unknown as Record<string, unknown>, true);
      }

      const requirement = existing.value;
      const placements = currentPlacements(ctx, projectId);
      if (requirement.projectId) {
        if (requirement.projectId !== projectId) {
          return blocked(`REQUIREMENT_PROJECT_CONFLICT:${requirementId}:existing=${requirement.projectId}:requested=${projectId}`, {
            requirementId, existingProjectId: requirement.projectId, projectId,
          });
        }
        return result(buildFacadeResult({
          summary: `Requirement ${requirementId} is already attached to Project ${projectId}; no task or semantic revision was created.`,
          data: {
            authority: 'project_semantic',
            project: projectView(ctx, record),
            requirement: { ...requirementSemanticView(requirement), projectId },
            attachmentCreated: false,
            attachmentStatus: 'already_attached',
          },
        }) as unknown as Record<string, unknown>);
      }

      if (requirement.repoId) {
        if (!placements.some((placement) => placement.repositoryId === requirement.repoId)) {
          return blocked(`REQUIREMENT_REPOSITORY_OUTSIDE_PROJECT:${requirementId}:repository=${requirement.repoId}:project=${projectId}`, {
            requirementId, repositoryId: requirement.repoId, projectId,
          });
        }
        return result(buildFacadeResult({
          summary: `Requirement ${requirementId} is already attached to Project ${projectId} through repository ${requirement.repoId}.`,
          data: {
            authority: 'project_semantic',
            project: projectView(ctx, record),
            requirement: { ...requirementSemanticView(requirement), projectId },
            repositoryId: requirement.repoId,
            attachmentCreated: false,
            attachmentStatus: 'already_attached',
          },
        }) as unknown as Record<string, unknown>);
      }

      if ((record.value.status ?? 'active') === 'archived') return blocked(`PROJECT_ARCHIVED:${projectId}`);
      if (placements.length === 0) {
        if (repository?.repoId) {
          return blocked(`PROJECT_REPOSITORY_NOT_PLACED:${repository.repoId} is not attached to Project ${projectId}.`, {
            projectId, requirementId, repositoryId: repository.repoId,
          });
        }
        const updated = bindRequirementProjectPlacement(
          { controllerHome: ctx.controllerHome },
          requirementId,
          projectId,
        );
        const attachmentCreated = updated.revision > existing.revision;
        return result(buildFacadeResult({
          summary: attachmentCreated
            ? `Requirement ${requirementId} attached directly to standalone Project ${projectId}; its existing semantic state and history were preserved.`
            : `Requirement ${requirementId} is already attached to Project ${projectId}; no duplicate task was created.`,
          data: {
            authority: 'project_semantic',
            project: projectView(ctx, record),
            requirement: requirementSemanticView(updated),
            attachmentCreated,
            attachmentStatus: attachmentCreated ? 'attached' : 'already_attached',
          },
        }) as unknown as Record<string, unknown>);
      }

      const selectedRepositoryId = repository?.repoId
        ?? (placements.length === 1 ? placements[0].repositoryId : undefined);
      if (!selectedRepositoryId) {
        return blocked(placements.length === 0
          ? 'PROJECT_REPOSITORY_PLACEMENT_REQUIRED: attach a repository to this Project before binding an existing Requirement.'
          : 'PROJECT_REPOSITORY_SELECTION_REQUIRED: this Project has multiple repository placements; select repo_id to choose the Requirement placement.', {
          projectId, requirementId, placementCount: placements.length,
        });
      }
      if (!placements.some((placement) => placement.repositoryId === selectedRepositoryId)) {
        return blocked(`PROJECT_REPOSITORY_NOT_PLACED:${selectedRepositoryId} is not attached to Project ${projectId}.`, {
          projectId, requirementId, repositoryId: selectedRepositoryId,
        });
      }

      const updated = bindRequirementRepositoryPlacement(
        { controllerHome: ctx.controllerHome },
        requirementId,
        selectedRepositoryId,
      );
      const attachmentCreated = updated.revision > existing.revision;
      return result(buildFacadeResult({
        summary: attachmentCreated
          ? `Requirement ${requirementId} attached to Project ${projectId}; its existing semantic state and history were preserved.`
          : `Requirement ${requirementId} is already attached to Project ${projectId}; no duplicate task was created.`,
        data: {
          authority: 'project_semantic',
          project: projectView(ctx, record),
          requirement: { ...requirementSemanticView(updated), projectId },
          repositoryId: selectedRepositoryId,
          attachmentCreated,
          attachmentStatus: attachmentCreated ? 'attached' : 'already_attached',
        },
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
