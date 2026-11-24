import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import {
  admitRequirement,
  blockingRequirementIds,
  listRequirementsForProject,
  listRequirementsForRepository,
  promoteRequirementCandidate,
} from '../../../src/runtime/control-plane/facade/requirement-authority';
import {
  listRequirementActivityEvents,
  listRequirementRevisionRecords,
  listRequirements,
  readRequirement,
  requirementSemanticView,
  reviseRequirementSemantic,
  REQUIREMENT_PRIORITIES,
  REQUIREMENT_STATES,
  type RequirementPriority,
  type RequirementState,
} from '../../../src/runtime/control-plane/persistence/requirement-store';
import { readForgeInstanceIdentity } from '../../../packages/kernel/identity/api/index';
import {
  listAllProjectIdentities,
  listProjectPlacements,
  resolveProjectForRepositoryPlacement,
} from '../../../src/runtime/control-plane/workspace/workspace-store';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade';
import { result } from './result-adapter';
import {
  isCurrentPlanContract,
  planSemanticView,
  readPlanContractStore,
} from '../../../src/runtime/control-plane/facade/plan-contract-store';
import { SEMANTIC_SCOPE_KEY } from '../../../src/effects/controller-home';
import { listAutopilotRunActivityEvents, readAutopilotRun } from '../../../src/runtime/autopilot/store';
import { listAutopilotRunSummaries, summarizeAutopilotRun } from '../../../src/runtime/autopilot/read-model';

const RH_WORK_REQUIREMENT_OPERATIONS = new Set([
  'requirement_create',
  'requirement_list',
  'requirement_manifest',
  'requirement_get',
  'requirement_revise',
  'requirement_promote_candidate',
]);

export function isRhWorkRequirementOperation(operation: string): boolean {
  return RH_WORK_REQUIREMENT_OPERATIONS.has(operation);
}

function projectIdForRepository(
  ctx: MultiRepositoryMcpToolContext,
  repository: { repoId: string; activeCheckoutId?: string } | undefined,
): string | undefined {
  if (!repository) return undefined;
  const instance = readForgeInstanceIdentity(ctx.controllerHome);
  if (!instance) return undefined;
  return resolveProjectForRepositoryPlacement({
    controllerHome: ctx.controllerHome,
    forgeInstanceId: instance.instanceId,
    repositoryId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
  })?.projectId;
}

/** Project board reads and edits must use the same task membership as Project detail. */
function requirementInSelectedScope(
  ctx: MultiRepositoryMcpToolContext,
  repository: { repoId: string } | undefined,
  requirementId: string,
  requestedProjectId: string,
) {
  if (!requirementId) return undefined;
  const record = repository?.repoId
    ? listRequirementsForRepository({ controllerHome: ctx.controllerHome }, repository.repoId, 1000).find(
        (candidate) => candidate.value.requirementId === requirementId,
      )
    : readRequirement({ controllerHome: ctx.controllerHome }, requirementId);
  if (!record || !requestedProjectId) return record;
  return listRequirementsForProject({ controllerHome: ctx.controllerHome }, requestedProjectId, 1000).some(
    (candidate) => candidate.value.requirementId === requirementId,
  )
    ? record
    : undefined;
}

export async function callRhWorkRequirementOperation(
  ctx: MultiRepositoryMcpToolContext,
  repository: { repoId: string; activeCheckoutId?: string } | undefined,
  operation: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (!isRhWorkRequirementOperation(operation)) return undefined;

  if (operation === 'requirement_list') {
    const limit = Math.max(1, Math.min(Math.trunc(typeof args.limit === 'number' ? args.limit : 20), 100));
    const offset = Math.max(
      0,
      Math.min(Math.trunc(typeof args.offset === 'number' && Number.isFinite(args.offset) ? args.offset : 0), 100_000),
    );
    const requestedProjectId = typeof args.project_id === 'string' ? args.project_id.trim() : '';
    const projectId = projectIdForRepository(ctx, repository);
    if (repository && requestedProjectId && requestedProjectId !== projectId) {
      return result(
        buildFacadeResult({
          status: 'blocked',
          summary: `REQUIREMENT_PROJECT_SCOPE_CONFLICT:${requestedProjectId}`,
          data: { requestedProjectId, repositoryId: repository.repoId, selectedProjectId: projectId },
        }) as unknown as Record<string, unknown>,
        true,
      );
    }

    let records;
    if (repository && requestedProjectId) {
      const repositoryTaskIds = new Set(
        listRequirementsForRepository({ controllerHome: ctx.controllerHome }, repository.repoId, 1000).map(
          ({ value }) => value.requirementId,
        ),
      );
      records = listRequirementsForProject({ controllerHome: ctx.controllerHome }, requestedProjectId, 1000).filter(
        ({ value }) => repositoryTaskIds.has(value.requirementId),
      );
    } else if (repository) {
      records = listRequirementsForRepository({ controllerHome: ctx.controllerHome }, repository.repoId, 1000);
    } else if (requestedProjectId) {
      const projects = listAllProjectIdentities(ctx.controllerHome);
      if (projects.length >= 1000) throw new Error('PROJECT_IDENTITY_LOOKUP_LIMIT');
      const matches = projects.filter(({ value }) => value.projectId === requestedProjectId);
      if (matches.length > 1) throw new Error(`PROJECT_IDENTITY_AMBIGUOUS: ${requestedProjectId}`);
      if (!matches.length)
        return result(
          buildFacadeResult({
            status: 'not_found',
            summary: `Project ${requestedProjectId} not found.`,
            data: { projectId: requestedProjectId },
          }) as unknown as Record<string, unknown>,
          true,
        );
      records = listRequirementsForProject({ controllerHome: ctx.controllerHome }, requestedProjectId, 1000);
    } else {
      records = listRequirements({ controllerHome: ctx.controllerHome }, 1000);
    }
    if (records.length >= 1000) throw new Error('REQUIREMENT_LIST_LOOKUP_LIMIT');

    const statusFilter = typeof args.requirement_status === 'string' ? args.requirement_status.trim() : '';
    if (statusFilter && !(REQUIREMENT_STATES as readonly string[]).includes(statusFilter)) {
      return result(
        buildFacadeResult({
          status: 'blocked',
          summary: 'REQUIREMENT_STATUS_FILTER_INVALID.',
          data: { statusFilter },
        }) as unknown as Record<string, unknown>,
        true,
      );
    }
    const priorityFilter = typeof args.requirement_priority === 'string' ? args.requirement_priority.trim() : '';
    if (priorityFilter && !(REQUIREMENT_PRIORITIES as readonly string[]).includes(priorityFilter)) {
      return result(
        buildFacadeResult({
          status: 'blocked',
          summary: 'REQUIREMENT_PRIORITY_FILTER_INVALID.',
          data: { priorityFilter },
        }) as unknown as Record<string, unknown>,
        true,
      );
    }
    const assigneeFilter = typeof args.requirement_assignee === 'string' ? args.requirement_assignee.trim() : '';
    const assignmentFilter = typeof args.assignment_filter === 'string' ? args.assignment_filter.trim() : '';
    if (assignmentFilter && assignmentFilter !== 'assigned' && assignmentFilter !== 'unassigned') {
      return result(
        buildFacadeResult({
          status: 'blocked',
          summary: 'REQUIREMENT_ASSIGNMENT_FILTER_INVALID.',
          data: { assignmentFilter },
        }) as unknown as Record<string, unknown>,
        true,
      );
    }
    if (assignmentFilter === 'unassigned' && assigneeFilter) {
      return result(
        buildFacadeResult({
          status: 'blocked',
          summary: 'REQUIREMENT_ASSIGNMENT_FILTER_CONFLICT.',
          data: { assignmentFilter, assigneeFilter },
        }) as unknown as Record<string, unknown>,
        true,
      );
    }
    const searchQuery = typeof args.search_query === 'string' ? args.search_query.trim() : '';
    const normalizedSearchQuery = searchQuery.toLowerCase();
    const dependencyFilter = typeof args.dependency_filter === 'string' ? args.dependency_filter : '';
    if (dependencyFilter && dependencyFilter !== 'blocked' && dependencyFilter !== 'unblocked') {
      return result(
        buildFacadeResult({
          status: 'blocked',
          summary: 'REQUIREMENT_DEPENDENCY_FILTER_INVALID.',
          data: { dependencyFilter },
        }) as unknown as Record<string, unknown>,
        true,
      );
    }
    const blockers = (dependencyIds: readonly string[]) =>
      blockingRequirementIds({ controllerHome: ctx.controllerHome }, dependencyIds);
    const sortBy = typeof args.sort_by === 'string' ? args.sort_by : 'updated_at';
    const sortOrder = typeof args.sort_order === 'string' ? args.sort_order : 'desc';
    if (
      !['updated_at', 'created_at', 'priority', 'status', 'title', 'assignee'].includes(sortBy) ||
      !['asc', 'desc'].includes(sortOrder)
    ) {
      return result(
        buildFacadeResult({
          status: 'blocked',
          summary: 'REQUIREMENT_SORT_INVALID.',
          data: { sortBy, sortOrder },
        }) as unknown as Record<string, unknown>,
        true,
      );
    }

    const priorityRank = new Map(REQUIREMENT_PRIORITIES.map((value, index) => [value, index]));
    const statusRank = new Map(REQUIREMENT_STATES.map((value, index) => [value, index]));
    const direction = sortOrder === 'asc' ? 1 : -1;
    const filtered = records
      .map((record) => requirementSemanticView(record.value))
      .filter(
        (semantic) =>
          (!statusFilter || semantic.status === statusFilter) &&
          (!priorityFilter || semantic.priority === priorityFilter) &&
          (!assigneeFilter || semantic.assignee === assigneeFilter) &&
          (!assignmentFilter || Boolean(semantic.assignee) === (assignmentFilter === 'assigned')) &&
          (!dependencyFilter ||
            blockers(semantic.dependsOnRequirementIds).length > 0 === (dependencyFilter === 'blocked')) &&
          (!normalizedSearchQuery ||
            [
              semantic.requirementId,
              semantic.title,
              semantic.outcomeStatement,
              semantic.projectId ?? '',
              ...semantic.legacyAliases,
            ].some((value) => value.toLowerCase().includes(normalizedSearchQuery))),
      )
      .sort((left, right) => {
        let compared = 0;
        if (sortBy === 'updated_at') compared = left.updatedAt.localeCompare(right.updatedAt);
        else if (sortBy === 'created_at') compared = left.createdAt.localeCompare(right.createdAt);
        else if (sortBy === 'priority')
          compared =
            (left.priority ? (priorityRank.get(left.priority) ?? -1) : -1) -
            (right.priority ? (priorityRank.get(right.priority) ?? -1) : -1);
        else if (sortBy === 'status')
          compared = (statusRank.get(left.status) ?? -1) - (statusRank.get(right.status) ?? -1);
        else if (sortBy === 'assignee') compared = (left.assignee ?? '').localeCompare(right.assignee ?? '');
        else compared = left.title.localeCompare(right.title);
        return compared === 0 ? left.requirementId.localeCompare(right.requirementId) : compared * direction;
      });
    const totalCount = filtered.length;
    const page = filtered.slice(offset, offset + limit);
    const autopilotRuns = listAutopilotRunSummaries(
      ctx.controllerHome,
      page.map((semantic) => ({
        ...semantic,
        repoId: semantic.repoId ?? repository?.repoId,
      })),
    );
    const requirements = page.map((semantic) => ({
      requirementId: semantic.requirementId,
      revision: semantic.revision,
      ...(semantic.repoId ? { repoId: semantic.repoId } : {}),
      ...(semantic.parentRequirementId ? { parentRequirementId: semantic.parentRequirementId } : {}),
      ...(semantic.rootRequirementId ? { rootRequirementId: semantic.rootRequirementId } : {}),
      title: semantic.title.slice(0, 240),
      outcomeStatement: semantic.outcomeStatement.slice(0, 500),
      state: semantic.state,
      status: semantic.status,
      ...(semantic.priority ? { priority: semantic.priority } : {}),
      ...(semantic.assignee ? { assignee: semantic.assignee } : {}),
      progressSummary: semantic.progressSummary.slice(0, 500),
      remainingWorkCount: semantic.remainingWork.length,
      acceptedEvidenceCount: semantic.acceptedEvidenceRefs.length,
      dependencyCount: semantic.dependsOnRequirementIds.length,
      blockingDependencyIds: blockers(semantic.dependsOnRequirementIds),
      autopilotRun: autopilotRuns.get(semantic.requirementId) ?? null,
      legacyAliases: semantic.legacyAliases,
      ...(semantic.projectId || projectId || requestedProjectId
        ? { projectId: semantic.projectId ?? projectId ?? requestedProjectId }
        : {}),
      createdAt: semantic.createdAt,
      updatedAt: semantic.updatedAt,
    }));
    return result(
      buildFacadeResult({
        summary: `${totalCount} canonical Requirement(s) match the selected Project and filters; returning ${requirements.length} from offset ${offset}.`,
        data: {
          requirements,
          bounded: true,
          limit,
          offset,
          totalCount,
          hasMore: offset + requirements.length < totalCount,
          requirementsTruncated: offset + requirements.length < totalCount,
          sortBy,
          sortOrder,
          filters: {
            ...(requestedProjectId ? { projectId: requestedProjectId } : {}),
            ...(statusFilter ? { status: statusFilter } : {}),
            ...(priorityFilter ? { priority: priorityFilter } : {}),
            ...(assigneeFilter ? { assignee: assigneeFilter } : {}),
            ...(assignmentFilter ? { assignment: assignmentFilter } : {}),
            ...(dependencyFilter ? { dependency: dependencyFilter } : {}),
            ...(searchQuery ? { searchQuery } : {}),
          },
          authority: 'semantic_context_only',
          progressAuthority: 'github_issue_project',
          detailOperation: 'requirement_get',
        },
      }) as unknown as Record<string, unknown>,
    );
  }

  if (operation === 'requirement_manifest') {
    const requirementId = typeof args.requirement_id === 'string' ? args.requirement_id.trim() : '';
    const requestedProjectId = typeof args.project_id === 'string' ? args.project_id.trim() : '';
    const projectId = projectIdForRepository(ctx, repository);
    if (repository && requestedProjectId && requestedProjectId !== projectId)
      return result(
        buildFacadeResult({
          status: 'blocked',
          summary: `REQUIREMENT_PROJECT_SCOPE_CONFLICT:${requestedProjectId}`,
          data: { requirementId, requestedProjectId, repositoryId: repository.repoId, selectedProjectId: projectId },
        }) as unknown as Record<string, unknown>,
        true,
      );
    const record = requirementInSelectedScope(ctx, repository, requirementId, requestedProjectId);
    if (!record)
      return result(
        buildFacadeResult({
          status: 'not_found',
          summary: `Requirement ${requirementId || '(missing)'} not found in the selected ${requestedProjectId ? 'Project' : repository ? 'repository' : 'scope'}.`,
          data: {
            requirementId,
            ...(requestedProjectId ? { projectId: requestedProjectId } : {}),
            ...(repository?.repoId ? { repoId: repository.repoId } : {}),
          },
        }) as unknown as Record<string, unknown>,
        true,
      );

    const semantic = requirementSemanticView(record.value);
    const currentPlans = readPlanContractStore({
      controllerHome: ctx.controllerHome,
      ...(semantic.repoId ? { repoId: semantic.repoId } : { scopeKey: SEMANTIC_SCOPE_KEY }),
    }).contracts.filter((plan) => plan.requirementId === semantic.requirementId && isCurrentPlanContract(plan));
    const plans = currentPlans
      .map((plan) => {
        const view = planSemanticView(plan);
        return {
          planId: view.planId,
          requirementId: semantic.requirementId,
          revision: view.revision,
          ...(view.parentPlanId ? { parentPlanId: view.parentPlanId } : {}),
          ...(view.supersededBy ? { supersededBy: view.supersededBy } : {}),
          updatedAt: view.updatedAt,
        };
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.planId.localeCompare(right.planId));

    if (args.detail_level === 'detail') {
      const planId = typeof args.plan_id === 'string' ? args.plan_id.trim() : '';
      if (!planId)
        return result(
          buildFacadeResult({
            status: 'blocked',
            summary: 'REQUIREMENT_MANIFEST_PLAN_ID_REQUIRED',
            data: {
              requirementId: semantic.requirementId,
              currentPlanIds: plans.map((plan) => plan.planId),
            },
          }) as unknown as Record<string, unknown>,
          true,
        );
      const selectedPlan = currentPlans.find((plan) => plan.planId === planId);
      if (!selectedPlan)
        return result(
          buildFacadeResult({
            status: 'not_found',
            summary: `Current Plan ${planId} was not found for Requirement ${semantic.requirementId}.`,
            data: {
              requirementId: semantic.requirementId,
              planId,
              currentPlanIds: plans.map((plan) => plan.planId),
            },
          }) as unknown as Record<string, unknown>,
          true,
        );
      return result(
        buildFacadeResult({
          summary: `Requirement ${semantic.requirementId} and Plan ${planId} semantic snapshot retrieved atomically.`,
          data: {
            requirement: semantic,
            plan: planSemanticView(selectedPlan),
            plans,
            bounded: true,
            authority: 'semantic_context_only',
          },
        }) as unknown as Record<string, unknown>,
      );
    }

    return result(
      buildFacadeResult({
        summary: `Requirement ${semantic.requirementId} manifest retrieved at semantic revision ${semantic.revision} with ${plans.length} current Plan(s).`,
        data: {
          requirement: {
            requirementId: semantic.requirementId,
            revision: semantic.revision,
            ...(semantic.repoId ? { repoId: semantic.repoId } : {}),
            ...(semantic.projectId || projectId || requestedProjectId
              ? { projectId: semantic.projectId ?? projectId ?? requestedProjectId }
              : {}),
          },
          plans,
          bounded: true,
          authority: 'semantic_context_only',
          detailOperations: {
            requirement: 'requirement_get',
            plan: 'plan_get',
          },
        },
      }) as unknown as Record<string, unknown>,
    );
  }

  if (operation === 'requirement_get') {
    const requirementId = typeof args.requirement_id === 'string' ? args.requirement_id.trim() : '';
    const requestedProjectId = typeof args.project_id === 'string' ? args.project_id.trim() : '';
    const projectId = projectIdForRepository(ctx, repository);
    if (repository && requestedProjectId && requestedProjectId !== projectId)
      return result(
        buildFacadeResult({
          status: 'blocked',
          summary: `REQUIREMENT_PROJECT_SCOPE_CONFLICT:${requestedProjectId}`,
          data: { requirementId, requestedProjectId, repositoryId: repository.repoId, selectedProjectId: projectId },
        }) as unknown as Record<string, unknown>,
        true,
      );
    const record = requirementInSelectedScope(ctx, repository, requirementId, requestedProjectId);
    if (!record)
      return result(
        buildFacadeResult({
          status: 'not_found',
          summary: `Requirement ${requirementId || '(missing)'} not found in the selected ${requestedProjectId ? 'Project' : repository ? 'repository' : 'scope'}.`,
          data: {
            requirementId,
            ...(requestedProjectId ? { projectId: requestedProjectId } : {}),
            ...(repository?.repoId ? { repoId: repository.repoId } : {}),
          },
        }) as unknown as Record<string, unknown>,
        true,
      );
    const semantic = requirementSemanticView(record.value);
    const blockingDependencies = blockingRequirementIds(
      { controllerHome: ctx.controllerHome },
      semantic.dependsOnRequirementIds,
    );
    const runRepoId = semantic.repoId ?? repository?.repoId;
    const autopilotRun =
      args.detail_level === 'detail' && runRepoId
        ? readAutopilotRun(ctx.controllerHome, runRepoId, semantic.requirementId)?.value
        : undefined;
    // The task owns no duplicate Plan relationship: Plan.requirementId is canonical.
    // A global Project-board read resolves the selected task's actual repository.
    const relatedPlans =
      args.detail_level === 'detail'
        ? readPlanContractStore({
            controllerHome: ctx.controllerHome,
            ...(semantic.repoId ? { repoId: semantic.repoId } : { scopeKey: SEMANTIC_SCOPE_KEY }),
          })
            .contracts.filter((plan) => plan.requirementId === semantic.requirementId)
            .map((plan) => {
              const view = planSemanticView(plan);
              return {
                planId: view.planId,
                requirementId: semantic.requirementId,
                ...(semantic.repoId ? { repoId: semantic.repoId } : {}),
                revision: view.revision,
                goal: view.goal.slice(0, 240),
                current: isCurrentPlanContract(plan),
                updatedAt: view.updatedAt,
                ...(view.parentPlanId ? { parentPlanId: view.parentPlanId } : {}),
                ...(view.supersededBy ? { supersededBy: view.supersededBy } : {}),
              };
            })
            .sort(
              (left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.planId.localeCompare(right.planId),
            )
        : undefined;
    const revisionRecords =
      args.detail_level === 'detail'
        ? listRequirementRevisionRecords({ controllerHome: ctx.controllerHome }, requirementId, 21)
        : undefined;
    const revisionHistory = revisionRecords?.slice(0, 20);
    const activityEvents =
      args.detail_level === 'detail'
        ? listRequirementActivityEvents({ controllerHome: ctx.controllerHome }, requirementId, 21)
        : undefined;
    const revisionByNumber = new Map((revisionRecords ?? []).map((revision) => [revision.revision, revision]));
    const activityHistory = activityEvents?.slice(0, 20).map((event, index, events) => {
      // Audit revision is the persisted-record revision; semantic snapshots advance
      // only for requirement_semantic_revised. Placement/promotion events must map
      // to the latest semantic snapshot that existed at their point in the timeline.
      const newerSemanticRevisions = events
        .slice(0, index)
        .filter((newer) => newer.action === 'requirement_semantic_revised').length;
      const semanticRevision = Math.max(1, semantic.revision - newerSemanticRevisions);
      const snapshot = semanticRevision === semantic.revision ? semantic : revisionByNumber.get(semanticRevision);
      return {
        eventId: event.eventId,
        revision: event.revision,
        semanticRevision,
        action: event.action,
        occurredAt: event.occurredAt,
        ...(snapshot
          ? {
              status: snapshot.status,
              priority: snapshot.priority,
              assignee: snapshot.assignee,
              title: snapshot.title,
              progressSummary: snapshot.progressSummary,
            }
          : {}),
      };
    });
    const autopilotRunActivityEvents =
      autopilotRun && runRepoId
        ? listAutopilotRunActivityEvents(ctx.controllerHome, runRepoId, semantic.requirementId, 21)
        : undefined;
    const autopilotRunSummary = autopilotRun
      ? {
          ...summarizeAutopilotRun(autopilotRun, semantic.revision),
          activityHistory: (autopilotRunActivityEvents ?? [])
            .slice(0, 20)
            .map(({ eventId, revision, action, occurredAt }) => ({
              eventId,
              revision,
              action,
              occurredAt,
            })),
          activityHistoryTruncated: (autopilotRunActivityEvents?.length ?? 0) > 20,
        }
      : null;
    const dependencyRequirements =
      args.detail_level === 'detail'
        ? semantic.dependsOnRequirementIds.map((dependencyId) => {
            const dependency = readRequirement({ controllerHome: ctx.controllerHome }, dependencyId)?.value;
            if (!dependency) return { requirementId: dependencyId, missing: true };
            const dependencySemantic = requirementSemanticView(dependency);
            return {
              requirementId: dependencySemantic.requirementId,
              title: dependencySemantic.title,
              status: dependencySemantic.status,
              revision: dependencySemantic.revision,
              ...(dependencySemantic.repoId ? { repoId: dependencySemantic.repoId } : {}),
              ...(dependencySemantic.priority ? { priority: dependencySemantic.priority } : {}),
              ...(dependencySemantic.assignee ? { assignee: dependencySemantic.assignee } : {}),
            };
          })
        : undefined;
    // Reverse dependency navigation is a read-only projection over the same
    // canonical Requirement owner. Scan once, and only on selected-task detail.
    const dependentScan =
      args.detail_level === 'detail' ? listRequirements({ controllerHome: ctx.controllerHome }, 1_000) : undefined;
    const dependentRecords = dependentScan
      ?.filter(({ value }) => (value.dependsOnRequirementIds ?? []).includes(semantic.requirementId))
      .map(({ value }) => requirementSemanticView(value))
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.requirementId.localeCompare(right.requirementId),
      );
    const dependentRequirements = dependentRecords?.slice(0, 20).map((dependent) => ({
      requirementId: dependent.requirementId,
      title: dependent.title.slice(0, 240),
      status: dependent.status,
      revision: dependent.revision,
      ...(dependent.repoId ? { repoId: dependent.repoId } : {}),
      ...(dependent.projectId ? { projectId: dependent.projectId } : {}),
      ...(dependent.priority ? { priority: dependent.priority } : {}),
      ...(dependent.assignee ? { assignee: dependent.assignee } : {}),
      blocksDependent: semantic.status !== 'done',
    }));
    const dependentRequirementsTruncated = Boolean(
      dependentRecords && (dependentRecords.length > 20 || (dependentScan?.length ?? 0) >= 1_000),
    );
    const dependentRequirementCount =
      dependentScan && dependentScan.length < 1_000 ? dependentRecords?.length : undefined;
    return result(
      buildFacadeResult({
        summary: `Requirement ${semantic.requirementId} retrieved at semantic revision ${semantic.revision}.`,
        data: {
          progressAuthority: 'github_issue_project',
          requirement: {
            ...semantic,
            blockingDependencyIds: blockingDependencies,
            ...(projectId || requestedProjectId ? { projectId: projectId ?? requestedProjectId } : {}),
          },
          ...(revisionHistory ? { revisionHistory } : {}),
          ...(activityHistory ? { activityHistory, activityHistoryTruncated: (activityEvents?.length ?? 0) > 20 } : {}),
          ...(dependencyRequirements ? { dependencyRequirements } : {}),
          ...(dependentRequirements
            ? {
                dependentRequirements,
                dependentRequirementsTruncated,
                ...(dependentRequirementCount !== undefined ? { dependentRequirementCount } : {}),
                dependentDetailOperation: 'requirement_get',
              }
            : {}),
          ...(relatedPlans
            ? {
                relatedPlans: relatedPlans.slice(0, 20),
                relatedPlanCount: relatedPlans.length,
                relatedPlansTruncated: relatedPlans.length > 20,
                planDetailOperation: 'plan_get',
              }
            : {}),
          ...(args.detail_level === 'detail' ? { autopilotRun: autopilotRunSummary } : {}),
          progress: {
            source: 'requirement',
            summary: semantic.progressSummary,
            remainingWork: semantic.remainingWork,
            acceptedEvidenceRefs: semantic.acceptedEvidenceRefs,
          },
        },
        detailLevel: args.detail_level === 'detail' ? 'detail' : 'summary',
      }) as unknown as Record<string, unknown>,
    );
  }

  if (operation === 'requirement_revise') {
    const requirementId = typeof args.requirement_id === 'string' ? args.requirement_id.trim() : '';
    const expectedRevision = Number(args.expected_revision);
    const requestedProjectId = typeof args.project_id === 'string' ? args.project_id.trim() : '';
    const selectedProjectId = projectIdForRepository(ctx, repository);
    if (repository && requestedProjectId && requestedProjectId !== selectedProjectId)
      return result(
        buildFacadeResult({
          status: 'blocked',
          summary: `REQUIREMENT_PROJECT_SCOPE_CONFLICT:${requestedProjectId}`,
          data: { requirementId, requestedProjectId, repositoryId: repository.repoId, selectedProjectId },
        }) as unknown as Record<string, unknown>,
        true,
      );
    if (requestedProjectId && !requirementInSelectedScope(ctx, repository, requirementId, requestedProjectId))
      return result(
        buildFacadeResult({
          status: 'blocked',
          summary: `REQUIREMENT_NOT_IN_PROJECT:${requirementId}:${requestedProjectId}`,
          data: { requirementId, projectId: requestedProjectId, expectedRevision },
        }) as unknown as Record<string, unknown>,
        true,
      );
    const hasSemanticUpdate =
      typeof args.requirement_title === 'string' ||
      typeof args.requirement_outcome === 'string' ||
      Array.isArray(args.requirement_acceptance_criteria) ||
      Array.isArray(args.requirement_delivery_references) ||
      typeof args.requirement_progress_summary === 'string' ||
      Array.isArray(args.requirement_remaining_work) ||
      Array.isArray(args.requirement_accepted_evidence_refs) ||
      Array.isArray(args.requirement_dependencies) ||
      Array.isArray(args.requirement_legacy_aliases) ||
      typeof args.requirement_priority === 'string' ||
      typeof args.requirement_assignee === 'string' ||
      typeof args.requirement_status === 'string' ||
      typeof args.requirement_parent_id === 'string' ||
      args.requirement_is_project_root === true ||
      args.requirement_state === 'open' ||
      args.requirement_state === 'completed' ||
      args.requirement_state === 'cancelled';
    if (!hasSemanticUpdate) {
      return result(
        buildFacadeResult({
          status: 'blocked',
          summary: 'REQUIREMENT_REVISION_EMPTY. Supply at least one semantic field.',
          data: { requirementId, expectedRevision },
        }) as unknown as Record<string, unknown>,
        true,
      );
    }
    try {
      const revised = reviseRequirementSemantic({ controllerHome: ctx.controllerHome }, requirementId, {
        expectedRevision,
        ...(repository?.repoId ? { repoId: repository.repoId } : {}),
        ...(typeof args.requirement_title === 'string' ? { title: args.requirement_title } : {}),
        ...(typeof args.requirement_outcome === 'string' ? { outcomeStatement: args.requirement_outcome } : {}),
        ...(Array.isArray(args.requirement_acceptance_criteria)
          ? { acceptanceCriteria: args.requirement_acceptance_criteria.map(String) }
          : {}),
        ...(Array.isArray(args.requirement_delivery_references)
          ? { requiredDeliveryReferences: args.requirement_delivery_references.map(String) }
          : {}),
        ...(typeof args.requirement_progress_summary === 'string'
          ? { progressSummary: args.requirement_progress_summary }
          : {}),
        ...(Array.isArray(args.requirement_remaining_work)
          ? { remainingWork: args.requirement_remaining_work.map(String) }
          : {}),
        ...(Array.isArray(args.requirement_accepted_evidence_refs)
          ? { acceptedEvidenceRefs: args.requirement_accepted_evidence_refs.map(String) }
          : {}),
        ...(Array.isArray(args.requirement_dependencies)
          ? { dependsOnRequirementIds: args.requirement_dependencies.map(String) }
          : {}),
        ...(Array.isArray(args.requirement_legacy_aliases)
          ? { legacyAliases: args.requirement_legacy_aliases.map(String) }
          : {}),
        ...(typeof args.requirement_priority === 'string'
          ? { priority: args.requirement_priority as RequirementPriority }
          : {}),
        ...(typeof args.requirement_assignee === 'string' ? { assignee: args.requirement_assignee } : {}),
        ...(typeof args.requirement_status === 'string' ? { status: args.requirement_status as RequirementState } : {}),
        ...(typeof args.requirement_parent_id === 'string' ? { parentRequirementId: args.requirement_parent_id } : {}),
        ...(args.requirement_is_project_root === true ? { isProjectRoot: true } : {}),
        ...(args.requirement_state === 'open' ||
        args.requirement_state === 'completed' ||
        args.requirement_state === 'cancelled'
          ? { state: args.requirement_state }
          : {}),
      });
      const semantic = requirementSemanticView(revised);
      const projectId = projectIdForRepository(ctx, repository);
      return result(
        buildFacadeResult({
          summary: `Requirement ${semantic.requirementId} revised atomically to semantic revision ${semantic.revision}.`,
          data: {
            requirement: {
              ...semantic,
              ...(projectId || requestedProjectId ? { projectId: projectId ?? requestedProjectId } : {}),
            },
            expectedRevision,
            semanticRevision: semantic.revision,
          },
        }) as unknown as Record<string, unknown>,
      );
    } catch (error) {
      const current = requirementId
        ? readRequirement({ controllerHome: ctx.controllerHome }, requirementId)?.value
        : undefined;
      return result(
        buildFacadeResult({
          status: 'blocked',
          summary: error instanceof Error ? error.message : String(error),
          data: {
            requirementId,
            expectedRevision,
            ...(current ? { currentRequirement: requirementSemanticView(current) } : {}),
          },
        }) as unknown as Record<string, unknown>,
        true,
      );
    }
  }

  const requirementId = typeof args.requirement_id === 'string' ? args.requirement_id : '';
  const title = typeof args.requirement_title === 'string' ? args.requirement_title : '';
  const outcomeStatement = typeof args.requirement_outcome === 'string' ? args.requirement_outcome : '';
  if (!requirementId.trim() || !title.trim() || !outcomeStatement.trim()) {
    return result(
      buildFacadeResult({
        status: 'blocked',
        summary:
          'REQUIREMENT_CREATE_INPUT_REQUIRED: requirement_id, requirement_title, and requirement_outcome are required.',
        data: { requirementCreated: false },
      }) as unknown as Record<string, unknown>,
      true,
    );
  }
  try {
    const requestedProjectId = typeof args.project_id === 'string' ? args.project_id.trim() : '';
    const selectedProjectId = projectIdForRepository(ctx, repository);
    if (repository && requestedProjectId && requestedProjectId !== selectedProjectId)
      throw new Error(`REQUIREMENT_PROJECT_SCOPE_CONFLICT:${requestedProjectId}`);
    let placedRepositoryId = repository?.repoId;
    if (!placedRepositoryId && requestedProjectId) {
      const instance = readForgeInstanceIdentity(ctx.controllerHome);
      if (instance) {
        const placements = listProjectPlacements(ctx.controllerHome, instance.instanceId);
        if (placements.length >= 1000) throw new Error('PROJECT_PLACEMENT_LOOKUP_LIMIT');
        const matches = placements.filter(({ value }) => value.projectId === requestedProjectId);
        if (matches.length > 1) throw new Error(`PROJECT_PLACEMENT_AMBIGUOUS:${requestedProjectId}`);
        placedRepositoryId = matches[0]?.value.repositoryId;
      }
    }
    const requirementInput = {
      requirementId,
      ...(placedRepositoryId ? { repoId: placedRepositoryId } : {}),
      ...(!placedRepositoryId && requestedProjectId ? { projectId: requestedProjectId } : {}),
      title,
      outcomeStatement,
      acceptanceCriteria: Array.isArray(args.requirement_acceptance_criteria)
        ? args.requirement_acceptance_criteria.map(String)
        : [],
      requiredDeliveryReferences: Array.isArray(args.requirement_delivery_references)
        ? args.requirement_delivery_references.map(String)
        : [],
      ...(typeof args.requirement_priority === 'string'
        ? { priority: args.requirement_priority as RequirementPriority }
        : {}),
      ...(typeof args.requirement_assignee === 'string' ? { assignee: args.requirement_assignee } : {}),
      ...(typeof args.requirement_status === 'string' ? { status: args.requirement_status as RequirementState } : {}),
      legacyAliases: Array.isArray(args.requirement_legacy_aliases) ? args.requirement_legacy_aliases.map(String) : [],
      dependsOnRequirementIds: Array.isArray(args.requirement_dependencies)
        ? args.requirement_dependencies.map(String)
        : [],
      ...(typeof args.requirement_parent_id === 'string' ? { parentRequirementId: args.requirement_parent_id } : {}),
      ...(args.requirement_is_project_root === true ? { isProjectRoot: true } : {}),
    };
    const admission =
      operation === 'requirement_promote_candidate'
        ? (() => {
            if (!repository) throw new Error('REQUIREMENT_CANDIDATE_REPOSITORY_PLACEMENT_REQUIRED');
            const candidateMemoryId =
              typeof args.requirement_candidate_id === 'string' ? args.requirement_candidate_id.trim() : '';
            if (!candidateMemoryId) throw new Error('REQUIREMENT_CANDIDATE_ID_REQUIRED');
            const instance = readForgeInstanceIdentity(ctx.controllerHome);
            if (!instance) throw new Error('REQUIREMENT_CANDIDATE_FORGE_INSTANCE_REQUIRED');
            const project = resolveProjectForRepositoryPlacement({
              controllerHome: ctx.controllerHome,
              forgeInstanceId: instance.instanceId,
              repositoryId: repository.repoId,
              checkoutId: repository.activeCheckoutId,
            });
            if (!project) throw new Error('REQUIREMENT_CANDIDATE_PROJECT_BINDING_REQUIRED');
            return promoteRequirementCandidate(
              { controllerHome: ctx.controllerHome },
              {
                ...requirementInput,
                workspaceId: project.workspaceId,
                candidateMemoryId,
              },
            );
          })()
        : admitRequirement({ controllerHome: ctx.controllerHome }, requirementInput);
    if (admission.decision === 'existing_conflict') {
      return result(
        buildFacadeResult({
          status: 'blocked',
          summary: `REQUIREMENT_ALREADY_EXISTS_CONFLICT: ${admission.requirement.requirementId}. Existing Requirement authority was not changed.`,
          data: {
            requirement: requirementSemanticView(admission.requirement),
            requirementCreated: false,
            admissionDecision: admission.decision,
          },
          suggestedNextActions: [],
        }) as unknown as Record<string, unknown>,
        true,
      );
    }
    const projectId = selectedProjectId ?? requestedProjectId;
    return result(
      buildFacadeResult({
        summary:
          admission.decision === 'created'
            ? operation === 'requirement_promote_candidate'
              ? `Requirement ${admission.requirement.requirementId} created from an explicit Cognitive candidate promotion. Requirement authority does not imply a Plan; Controller chooses the next action.`
              : `Requirement ${admission.requirement.requirementId} created. Requirement authority does not imply a Plan; Controller chooses the next action.`
            : admission.decision === 'candidate_already_promoted'
              ? `REQUIREMENT_CANDIDATE_ALREADY_PROMOTED: ${admission.requirement.requirementId}. Existing Requirement authority was reused; no duplicate Requirement was created.`
              : `REQUIREMENT_AUTHORITY_REUSED: ${admission.requirement.requirementId}. Existing status, priority and assignee were preserved; use requirement_revise to change them. Requirement authority does not imply a Plan; Controller chooses the next action.`,
        data: {
          requirement: { ...requirementSemanticView(admission.requirement), ...(projectId ? { projectId } : {}) },
          requirementCreated: admission.created,
          admissionDecision: admission.decision,
          ...('candidateAuditRef' in admission
            ? {
                requirementCandidatePromoted: true,
                candidateAuditRef: admission.candidateAuditRef,
                candidateMemoryId: admission.candidateMemoryId,
                workspaceId: admission.workspaceId,
              }
            : {}),
        },
        suggestedNextActions: [],
      }) as unknown as Record<string, unknown>,
    );
  } catch (error) {
    return result(
      buildFacadeResult({
        status: 'blocked',
        summary: error instanceof Error ? error.message : String(error),
        data: { requirementCreated: false },
      }) as unknown as Record<string, unknown>,
      true,
    );
  }
}
