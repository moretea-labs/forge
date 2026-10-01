import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { SEMANTIC_SCOPE_KEY } from '../../../src/cli/repositories/controller-home';
import { listControllerChecks } from '../../../src/cli/controller/check-runner';
import { repositoryGitStatus } from '../../../src/cli/repositories/structured-git';
import { getWorkContract, updateWorkContract, workSemanticView } from '../../../packages/kernel/work/api/index';
import { ensureRepositoryWorkHandle } from '../../../src/runtime/control-plane/execution/work-handle-authority';
import { ensureManagedWorkspace } from '../../../src/runtime/execution/managed-workspace';
import { ensureRepositoryProjectOnboarding } from '../../../src/runtime/control-plane/workspace/project-onboarding';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade';
import { isRhWorkAcceptedOperation } from '../../../src/runtime/control-plane/facade/rh-work-operation-contract';
import { findControlPlaneRecordsByKey, readControlPlaneRecord } from '../../../src/runtime/control-plane/persistence/sqlite-store';
import { result } from './result-adapter';
import { selected } from './shared-adapter';
import { invalidFacadeOperation } from './status-inbox-adapter';
import { normalizeRhWorkInputCompatibility } from './work-input-compatibility';
import { callRhWorkScheduleAdapter, isRhWorkScheduleOperation } from './scheduler-adapter';
import { callRhWorkRequirementOperation, isRhWorkRequirementOperation } from './work-requirement-operations';
import { callRhWorkSemanticOperation, semanticWorkId } from './work-semantic-operations';
import {
  callRhWorkPlanCreateOperation,
  callRhWorkPlanCreateWithoutRepository,
  callRhWorkPlanOperation,
} from './work-plan-operations';
import { callRhWorkWorkflowOperation } from './work-workflow-operations';
import { callRhWorkLearningOperation } from './work-learning-operations';
import { callRhWorkControllerOperation } from './work-controller-operations';
import { runFacadeRepair } from './work-repair-adapter';
import { isAutomationReceiptCompatibilityCall } from './automation-receipt-adapter';
import { authenticatedFacadeControllerIdentity } from './controller-authority-adapter';

export { runFacadeRepair };
export { runtimeIdentitySnapshot } from './controller-authority-adapter';

export function contextRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function contextText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function boundedStringList(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value.map(String).map((entry) => entry.trim()).filter(Boolean).slice(0, limit)
    : [];
}

function repositoryBoundStartRequested(args: Record<string, unknown>): boolean {
  return typeof args.repo_id === 'string' && args.repo_id.trim().length > 0;
}

async function callRepositoryBoundStart(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
  const workId = semanticWorkId(store, args);
  const semanticStart = await callRhWorkSemanticOperation(store, 'start', { ...args, work_id: workId });
  if (!semanticStart) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: `WORK_REPOSITORY_ADMISSION_SEMANTIC_START_UNAVAILABLE: ${workId}`,
      data: { workId, repoId: repository.repoId },
    }) as unknown as Record<string, unknown>, true);
  }
  if (semanticStart.isError) return semanticStart;
  let contract = getWorkContract(store, workId);
  if (!contract) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: `WORK_REPOSITORY_ADMISSION_SEMANTIC_CONTEXT_MISSING: ${workId}`,
      data: { workId, repoId: repository.repoId },
    }) as unknown as Record<string, unknown>, true);
  }

  try {
    const rawConstraints = contextRecord(args.constraints);
    const requestedWorkspaceMode: 'current' | 'isolated' | 'auto' = rawConstraints.workspace_mode === 'isolated' || rawConstraints.workspace_mode === 'auto' || rawConstraints.workspace_mode === 'current'
      ? rawConstraints.workspace_mode
      : 'current';
    const sourceStatus = repositoryGitStatus(repository);
    const requestedSourceRevision = typeof args.source_revision === 'string' ? args.source_revision.trim() : '';
    if (requestedSourceRevision && sourceStatus.head && requestedWorkspaceMode !== 'isolated' && rawConstraints.require_worktree !== true && requestedSourceRevision !== sourceStatus.head) {
      throw new Error(`WORK_SOURCE_REVISION_MISMATCH: expected ${requestedSourceRevision}, found ${sourceStatus.head}`);
    }
    const requireWorktree = rawConstraints.require_worktree === true
      || rawConstraints.direct_main_prohibited === true
      || requestedWorkspaceMode === 'isolated'
      || (requestedWorkspaceMode === 'auto' && !sourceStatus.clean);
    let checkoutId = repository.activeCheckoutId;
    let worktreeRef: string | undefined;
    let baseRevision = sourceStatus.head ?? undefined;
    if (requireWorktree) {
      const workspace = ensureManagedWorkspace(ctx.controllerHome, repository, {
        requestId: workId,
        title: String(args.objective ?? workId),
        ...(requestedSourceRevision ? { baseRef: requestedSourceRevision } : {}),
        prepareDependencies: args.needs_dependencies === true,
      });
      if (!workspace.managed || !workspace.checkoutId || !workspace.root) throw new Error('MANAGED_WORKSPACE_NOT_MATERIALIZED');
      checkoutId = workspace.checkoutId;
      worktreeRef = workspace.root;
      baseRevision = workspace.baseRevision ?? baseRevision;
    }

    const constraints = {
      ...contract.constraints,
      workspaceMode: requireWorktree ? 'isolated' as const : requestedWorkspaceMode,
      requireWorktree,
      directMainProhibited: rawConstraints.direct_main_prohibited === true || requireWorktree,
      ...(rawConstraints.allow_commit === false ? { allowCommit: false } : rawConstraints.allow_commit === true ? { allowCommit: true } : {}),
      ...(rawConstraints.allow_merge === false ? { allowMerge: false } : rawConstraints.allow_merge === true ? { allowMerge: true } : {}),
      ...(rawConstraints.allow_cleanup === false ? { allowCleanup: false } : rawConstraints.allow_cleanup === true ? { allowCleanup: true } : {}),
      ...(rawConstraints.require_handoff_on_ambiguity === false ? { requireHandoffOnAmbiguity: false } : rawConstraints.require_handoff_on_ambiguity === true ? { requireHandoffOnAmbiguity: true } : {}),
    };
    contract = updateWorkContract(store, workId, {
      checkoutId,
      executionPlacement: { schemaVersion: 1, repositoryId: repository.repoId, checkoutId },
      ...(baseRevision ? { baseRevision } : {}),
      ...(worktreeRef ? { worktreeRef } : {}),
      acceptanceCriteria: boundedStringList(args.acceptance_criteria, 20),
      allowedPaths: boundedStringList(args.allowed_paths, 50),
      forbiddenPaths: boundedStringList(args.forbidden_paths, 50),
      checks: boundedStringList(args.check_ids, 30),
      constraints,
    });
    const identity = authenticatedFacadeControllerIdentity(ctx, args);
    const handle = ensureRepositoryWorkHandle({
      controllerHome: ctx.controllerHome,
      repository,
      workId,
      checkoutId,
      identity: { sessionId: identity.sessionId, principalId: identity.principalId },
    });
    if (!handle) throw new Error(`WORK_REPOSITORY_ADMISSION_HANDLE_REQUIRED: ${workId}`);
    const projectOnboarding = ensureRepositoryProjectOnboarding({
      controllerHome: ctx.controllerHome,
      repository,
      sourceRevision: baseRevision,
    });
    return result(buildFacadeResult({
      summary: `Work ${workId} admitted to repository execution on checkout ${checkoutId}.`,
      data: {
        work: workSemanticView(contract),
        deduplicated: Boolean(contextRecord(semanticStart.structuredContent).data && contextRecord(contextRecord(semanticStart.structuredContent).data).deduplicated),
        projectOnboarding,
        executionHandle: { workId: handle.workId, checkoutId: handle.checkoutId, managedWorktree: handle.managedWorktree, state: handle.state },
      },
    }) as unknown as Record<string, unknown>);
  } catch (error) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: `WORK_REPOSITORY_ADMISSION_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      data: { workId, repoId: repository.repoId, canonicalWorkRetained: true },
    }) as unknown as Record<string, unknown>, true);
  }
}

function semanticStableSpec(operation: string) {
  if (operation === 'work_get' || operation === 'work_revise' || operation === 'work_complete') {
    return { namespace: 'work_contract', idField: 'work_id', kind: 'work' as const };
  }
  if (operation === 'plan_get' || operation === 'plan_revise') {
    return { namespace: 'plan_contract', idField: 'plan_id', kind: 'plan' as const };
  }
  return undefined;
}

async function routeStableSemanticOperation(
  ctx: MultiRepositoryMcpToolContext,
  operation: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  const spec = semanticStableSpec(operation);
  if (!spec) return undefined;

  const id = String(args[spec.idField] ?? '').trim();
  if (!id) {
    return result(buildFacadeResult({
      status: 'not_found',
      summary: `${spec.kind === 'work' ? 'Work' : 'Plan'} stable id is required.`,
      data: {},
    }) as unknown as Record<string, unknown>, true);
  }

  const explicitRepoId = typeof args.repo_id === 'string' && args.repo_id.trim()
    ? args.repo_id.trim()
    : undefined;
  let targetScope: string;
  if (explicitRepoId) {
    const exact = readControlPlaneRecord<unknown>(ctx.controllerHome, spec.namespace, explicitRepoId, id);
    if (!exact) {
      return result(buildFacadeResult({
        status: 'not_found',
        summary: `${spec.kind === 'work' ? 'Work' : 'Plan'} ${id} not found in repository ${explicitRepoId}.`,
        data: spec.kind === 'work' ? { workId: id, repoId: explicitRepoId } : { planId: id, repoId: explicitRepoId },
      }) as unknown as Record<string, unknown>, true);
    }
    targetScope = explicitRepoId;
  } else {
    const canonicalSemantic = readControlPlaneRecord<unknown>(
      ctx.controllerHome,
      spec.namespace,
      SEMANTIC_SCOPE_KEY,
      id,
    );
    const matches = canonicalSemantic
      ? [{ ...canonicalSemantic, scope: SEMANTIC_SCOPE_KEY }]
      : findControlPlaneRecordsByKey<unknown>(ctx.controllerHome, {
          namespace: spec.namespace,
          key: id,
          limit: 2,
        });
    if (matches.length === 0) {
      return result(buildFacadeResult({
        status: 'not_found',
        summary: `${spec.kind === 'work' ? 'Work' : 'Plan'} ${id} not found.`,
        data: spec.kind === 'work' ? { workId: id } : { planId: id },
      }) as unknown as Record<string, unknown>, true);
    }
    if (matches.length > 1) {
      return result(buildFacadeResult({
        status: 'blocked',
        summary: `SEMANTIC_ID_SCOPE_AMBIGUOUS: ${id} resolves to ${matches.length} scopes.`,
        data: { id, scopes: matches.map((record) => record.scope).sort() },
      }) as unknown as Record<string, unknown>, true);
    }
    targetScope = matches[0]!.scope;
  }

  const semanticStore = { controllerHome: ctx.controllerHome, scopeKey: targetScope };
  return spec.kind === 'work'
    ? callRhWorkSemanticOperation(semanticStore, operation, args)
    : callRhWorkPlanOperation(semanticStore, operation, args);
}

/**
 * Thin rh_work router.
 *
 * Work is semantic context only. Repository execution, checks, review, Git
 * delivery and cleanup are separate capabilities and never re-enter a Work
 * lifecycle here.
 */
export async function callWorkAdapter(
  ctx: MultiRepositoryMcpToolContext,
  input: Record<string, unknown>,
): Promise<CallToolResult> {
  const compatibility = normalizeRhWorkInputCompatibility(input);
  if (!compatibility.ok) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: compatibility.summary,
      data: compatibility.data,
    }) as unknown as Record<string, unknown>, true);
  }

  const args = compatibility.args;
  const operation = compatibility.operation;
  if (!isRhWorkAcceptedOperation(operation)) return invalidFacadeOperation('rh_work', operation);

  if (operation === 'repair' && isAutomationReceiptCompatibilityCall(args)) {
    return result(buildFacadeResult({
      summary: 'Workflow Supervisor automation receipt accepted for canonical persistence.',
      data: { automationReceiptCompatibility: true },
    }) as unknown as Record<string, unknown>);
  }

  if (isRhWorkRequirementOperation(operation) && operation !== 'requirement_promote_candidate') {
    const requirement = await callRhWorkRequirementOperation(ctx, undefined, operation, args);
    if (requirement) return requirement;
  }

  const stableSemantic = await routeStableSemanticOperation(ctx, operation, args);
  if (stableSemantic) return stableSemantic;

  const repositoryOptionalPlan = await callRhWorkPlanCreateWithoutRepository(ctx, operation, args);
  if (repositoryOptionalPlan) return repositoryOptionalPlan;

  if (operation === 'start' && !repositoryBoundStartRequested(args)) {
    const semanticStart = await callRhWorkSemanticOperation(
      { controllerHome: ctx.controllerHome, scopeKey: SEMANTIC_SCOPE_KEY },
      operation,
      args,
    );
    if (semanticStart) return semanticStart;
  }

  const repository = selected(ctx, args);
  if (operation === 'start') return callRepositoryBoundStart(ctx, repository, args);
  const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };

  if (isRhWorkScheduleOperation(operation)) {
    return callRhWorkScheduleAdapter(ctx, repository, operation, args);
  }

  if (operation === 'launcher_start') {
    const controller = await callRhWorkControllerOperation(ctx, repository, operation, args);
    if (controller) return controller;
  }

  const workflow = await callRhWorkWorkflowOperation(ctx, repository, operation, args);
  if (workflow) return workflow;

  const learning = callRhWorkLearningOperation(ctx, repository, operation, args);
  if (learning) return learning;

  const requirement = await callRhWorkRequirementOperation(ctx, repository, operation, args);
  if (requirement) return requirement;

  const plan = await callRhWorkPlanOperation(store, operation, args);
  if (plan) return plan;

  const planCreate = await callRhWorkPlanCreateOperation(store, operation, args, {
    controllerHome: ctx.controllerHome,
    repoId: repository.repoId,
    checks: listControllerChecks(repository.canonicalRoot),
  });
  if (planCreate) return planCreate;

  if (operation === 'repair') return runFacadeRepair(ctx, repository, args);

  return invalidFacadeOperation('rh_work', operation);
}
