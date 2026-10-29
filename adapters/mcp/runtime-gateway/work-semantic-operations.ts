import { createHash, randomUUID } from 'crypto';
import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import {
  createWorkSemanticContext,
  getWorkContract,
  normalizeWorkObjectiveRelationIds,
  reviseWorkSemanticContext,
  workSemanticView,
  semanticWorkState,
  type WorkContractStoreOptions,
} from '../../../packages/kernel/work/api/index';
import { buildFacadeResult, type BuildFacadeResultOptions } from '../../../src/runtime/control-plane/facade';
import { getPlanContract, currentPlanSemanticRevision, getPlanSemanticRevisionRecord, planSemanticView } from '../../../src/runtime/control-plane/facade/plan-contract-store';
import { readRequirement, currentRequirementSemanticRevision, getRequirementRevisionRecord, requirementSemanticView } from '../../../src/runtime/control-plane/persistence/requirement-store';
import { buildWorkContinuationSnapshot } from '../../../src/runtime/control-plane/facade/work-continuation';
import { result } from './result-adapter';
import { projectWorkExecutionEvidence } from './work-detail-projection';
import { reconcileSingleTerminalWorkCleanup } from '../../../src/runtime/control-plane/execution/work-terminal-cleanup';

import { existsSync } from 'node:fs';
import { getWorkflowSupervisorTask, stopWorkflowSupervisorTask } from '../../../supervisor/client';
import { workflowSupervisorSocketPath } from '../../../supervisor/paths';

async function stopTerminalWorkSupervisor(
  options: WorkContractStoreOptions,
  workId: string,
  state: 'completed' | 'cancelled',
): Promise<{ status: 'stopped' | 'already_terminal' | 'not_enrolled' | 'pending_reconcile'; reason?: string }> {
  const controllerHome = options.controllerHome;
  const repoId = options.repoId?.trim();
  if (!controllerHome || !repoId || !existsSync(workflowSupervisorSocketPath(controllerHome))) {
    return { status: 'pending_reconcile', reason: 'Supervisor socket unavailable; native consumer will reconcile terminal Work on restart.' };
  }
  const taskId = `forge:${repoId}:work:${workId}`;
  try {
    const task = await getWorkflowSupervisorTask(controllerHome, taskId);
    if (!task) return { status: 'not_enrolled' };
    // Fail closed: an unrelated Requirement/standalone Goal must never be
    // stopped by a lower-layer Work transition.
    if (task.taskId !== taskId || task.completionContract?.work_id !== workId
      || task.completionContract?.repo_id !== repoId
      || task.continuationPolicy.kind === 'standalone_supervisor') {
      return { status: 'pending_reconcile', reason: 'Supervisor task contract is not exact Work-owned.' };
    }
    const stopped = await stopWorkflowSupervisorTask(controllerHome, taskId, `Work ${workId} changed to ${state}; its exact Work-owned automatic continuation is closed.`);
    return { status: stopped.deduplicated ? 'already_terminal' : 'stopped' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const code = reason.split(':', 1)[0]?.trim();
    if (code === 'WORKFLOW_SUPERVISOR_TASK_UNKNOWN') return { status: 'not_enrolled' };
    if (code === 'WORKFLOW_SUPERVISOR_TASK_TERMINAL') return { status: 'already_terminal' };
    return { status: 'pending_reconcile', reason };
  }
}

const RH_WORK_SEMANTIC_OPERATIONS = new Set(['start', 'get', 'get_contract', 'revise', 'complete']);

type WorkSemanticFacadeData = Record<string, unknown> & {
  work?: ReturnType<typeof workSemanticView>;
  currentWork?: ReturnType<typeof workSemanticView>;
};

export function buildWorkSemanticFacadeResult(options: BuildFacadeResultOptions<WorkSemanticFacadeData>) {
  const facade = buildFacadeResult(options);
  // These authored projections already have domain limits. Generic diagnostic
  // clipping corrupts their read/revise round trip (100 refs become 50, and a
  // valid objective becomes an ellipsis). Keep execution diagnostics bounded.
  if (options.data.work) facade.data.work = options.data.work;
  if (options.data.currentWork) facade.data.currentWork = options.data.currentWork;
  return facade;
}

/** Resolve semantic version references against existing canonical heads/history. */
function workBasis(store: WorkContractStoreOptions, x: { requirementId?: string; requirementRevision?: number; planId?: string; planRevision?: number }) {
  const plan = x.planId ? getPlanContract(store, x.planId) : undefined;
  if (x.planId && !plan) throw new Error(`WORK_PLAN_NOT_FOUND: ${x.planId}`);
  if (x.requirementId && plan?.requirementId && x.requirementId !== plan.requirementId) {
    throw new Error(`WORK_PLAN_REQUIREMENT_MISMATCH: ${x.planId} belongs to ${plan.requirementId}, not ${x.requirementId}`);
  }
  const requirementId = x.requirementId || plan?.requirementId;
  if (x.requirementRevision !== undefined && !requirementId) throw new Error('WORK_REQUIREMENT_ID_REQUIRED_FOR_REVISION');
  if (x.planRevision !== undefined && !x.planId) throw new Error('WORK_PLAN_ID_REQUIRED_FOR_REVISION');
  if (requirementId && !store.controllerHome) throw new Error('WORK_REQUIREMENT_STORE_UNAVAILABLE');
  const requirement = requirementId ? readRequirement({ controllerHome: store.controllerHome! }, requirementId)?.value : undefined;
  if (requirementId && !requirement) throw new Error(`WORK_REQUIREMENT_NOT_FOUND: ${requirementId}`);
  for (const [kind, revision] of [['REQUIREMENT', x.requirementRevision], ['PLAN', x.planRevision]] as const) {
    if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) throw new Error(`WORK_${kind}_REVISION_INVALID`);
  }
  const requirementRevision = requirement ? x.requirementRevision ?? currentRequirementSemanticRevision(requirement) : undefined;
  const planRevision = plan ? x.planRevision ?? currentPlanSemanticRevision(plan) : undefined;
  if (requirement && requirementRevision !== currentRequirementSemanticRevision(requirement)
    && !getRequirementRevisionRecord({ controllerHome: store.controllerHome! }, requirementId!, requirementRevision!)) {
    throw new Error(`WORK_REQUIREMENT_REVISION_NOT_FOUND: ${requirementId}:r${requirementRevision}`);
  }
  if (plan && planRevision !== currentPlanSemanticRevision(plan)
    && !getPlanSemanticRevisionRecord(store, x.planId!, planRevision!)) {
    throw new Error(`WORK_PLAN_REVISION_NOT_FOUND: ${x.planId}:r${planRevision}`);
  }
  return { requirementId, requirementRevision, planId: x.planId, planRevision };
}

/** On-demand projection for manual and automated continuation; never adopts a head. */
function versionBinding(store: WorkContractStoreOptions, work: NonNullable<ReturnType<typeof getWorkContract>>, detail: boolean) {
  const req = work.requirementId && store.controllerHome
    ? readRequirement({ controllerHome: store.controllerHome }, work.requirementId)?.value : undefined;
  const plan = work.planId ? getPlanContract(store, work.planId) : undefined;
  const reqHead = req ? requirementSemanticView(req) : undefined;
  const planHead = plan ? planSemanticView(plan) : undefined;
  const reqAdopted = detail && reqHead && work.requirementRevision !== reqHead.revision
    ? getRequirementRevisionRecord({ controllerHome: store.controllerHome! }, work.requirementId!, work.requirementRevision!) : undefined;
  const planAdopted = detail && planHead && work.planRevision !== planHead.revision
    ? getPlanSemanticRevisionRecord(store, work.planId!, work.planRevision!) : undefined;
  return {
    ...(work.requirementId ? { requirement: {
      id: work.requirementId, adoptedRevision: work.requirementRevision, currentRevision: reqHead?.revision,
      updateAvailable: Boolean(reqHead && work.requirementRevision !== reqHead.revision),
      ...(detail ? { current: reqHead, adopted: reqAdopted ?? (work.requirementRevision === reqHead?.revision ? reqHead : undefined) } : {}),
    } } : {}),
    ...(work.planId ? { plan: {
      id: work.planId, adoptedRevision: work.planRevision, currentRevision: planHead?.revision,
      updateAvailable: Boolean(planHead && work.planRevision !== planHead.revision),
      ...(detail ? { current: planHead, adopted: planAdopted ?? (work.planRevision === planHead?.revision ? planHead : undefined) } : {}),
    } } : {}),
  };
}


export function semanticWorkId(store: WorkContractStoreOptions, args: Record<string, unknown>): string {
  const explicit = typeof args.work_id === 'string' ? args.work_id.trim() : '';
  if (explicit) return explicit;
  const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
  if (requestId) {
    const scopeKey = store.scopeKey?.trim() || store.repoId?.trim() || 'semantic';
    const digest = createHash('sha256').update(`${scopeKey}\0${requestId}`).digest('hex').slice(0, 12);
    return `work-semantic-${digest}`;
  }
  return `work-semantic-${randomUUID().slice(0, 12)}`;
}

function semanticCreateMatches(existing: ReturnType<typeof getWorkContract>, args: Record<string, unknown>, requestId: string): boolean {
  if (!existing) return false;
  const objective = String(args.objective ?? '').trim();
  const requirementId = typeof args.requirement_id === 'string' ? args.requirement_id.trim() : '';
  const planId = typeof args.plan_id === 'string' ? args.plan_id.trim() : '';
  const semanticParentWorkId = typeof args.semantic_parent_work_id === 'string' ? args.semantic_parent_work_id.trim() : '';
  const dependsOnWorkIds = normalizeWorkObjectiveRelationIds(Array.isArray(args.depends_on_work_ids) ? args.depends_on_work_ids.map(String) : []).sort();
  const existingDependencies = normalizeWorkObjectiveRelationIds(existing.dependsOnWorkIds).sort();
  return existing.objective === objective
    && (planId && !requirementId ? true : (existing.requirementId ?? '') === requirementId)
    && (args.requirement_revision === undefined || existing.requirementRevision === args.requirement_revision)
    && (args.plan_revision === undefined || existing.planRevision === args.plan_revision)
    && (existing.planId ?? '') === planId
    && (existing.semanticParentWorkId ?? '') === semanticParentWorkId
    && existingDependencies.length === dependsOnWorkIds.length
    && existingDependencies.every((id, index) => id === dependsOnWorkIds[index])
    && (existing.requestId ?? '') === requestId;
}

export async function callRhWorkSemanticOperation(
  store: WorkContractStoreOptions,
  operation: string,
  args: Record<string, unknown>,
  repositoryPlacement?: 'current' | 'isolated',
): Promise<CallToolResult | undefined> {
  if (!RH_WORK_SEMANTIC_OPERATIONS.has(operation)) return undefined;
  const workId = operation === 'start' ? semanticWorkId(store, args) : String(args.work_id ?? '').trim();
  if (operation === 'start') {
    const objective = String(args.objective ?? '').trim();
    if (!objective) return result(buildWorkSemanticFacadeResult({
      status: 'blocked', summary: 'WORK_OBJECTIVE_REQUIRED', data: { workId },
    }) as unknown as Record<string, unknown>, true);
    const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
    const existing = getWorkContract(store, workId);
    if (existing) {
      if (repositoryPlacement && (existing.workKind !== 'repository_change' || existing.constraints.workspaceMode !== repositoryPlacement)) {
        return result(buildWorkSemanticFacadeResult({
          status: 'blocked', summary: `WORK_REPOSITORY_ADMISSION_PLACEMENT_CONFLICT: ${workId}`,
          data: { workId, currentWork: workSemanticView(existing) },
        }) as unknown as Record<string, unknown>, true);
      }
      if (!semanticCreateMatches(existing, args, requestId)) return result(buildWorkSemanticFacadeResult({
        status: 'blocked',
        summary: `WORK_SEMANTIC_CREATE_CONFLICT: ${workId}`,
        data: { workId, currentWork: workSemanticView(existing) },
      }) as unknown as Record<string, unknown>, true);
      return result(buildWorkSemanticFacadeResult({
        summary: `Work ${workId} already exists; semantic create was deduplicated.`,
        data: { work: workSemanticView(existing), deduplicated: true },
      }) as unknown as Record<string, unknown>);
    }
    try {
      const basis = workBasis(store, {
        requirementId: typeof args.requirement_id === 'string' ? args.requirement_id.trim() || undefined : undefined,
        requirementRevision: typeof args.requirement_revision === 'number' ? args.requirement_revision : undefined,
        planId: typeof args.plan_id === 'string' ? args.plan_id.trim() || undefined : undefined,
        planRevision: typeof args.plan_revision === 'number' ? args.plan_revision : undefined,
      });
      const created = createWorkSemanticContext(store, {
        workId,
        objective,
        requestedBy: 'chatgpt',
        ...(repositoryPlacement ? { repositoryPlacement } : {}),
        ...basis,
        ...(typeof args.semantic_parent_work_id === 'string' ? { semanticParentWorkId: args.semantic_parent_work_id } : {}),
        ...(Array.isArray(args.depends_on_work_ids) ? { dependsOnWorkIds: args.depends_on_work_ids.map(String) } : {}),
        ...(requestId ? { requestId } : {}),
      });
      return result(buildWorkSemanticFacadeResult({
        summary: `Work ${workId} created as semantic context.`,
        data: { work: workSemanticView(created), deduplicated: false },
      }) as unknown as Record<string, unknown>);
    } catch (error) {
      const raced = getWorkContract(store, workId);
      if (raced && semanticCreateMatches(raced, args, requestId)) return result(buildWorkSemanticFacadeResult({
        summary: `Work ${workId} already exists; semantic create was deduplicated.`,
        data: { work: workSemanticView(raced), deduplicated: true },
      }) as unknown as Record<string, unknown>);
      return result(buildWorkSemanticFacadeResult({
        status: 'blocked',
        summary: error instanceof Error ? error.message : String(error),
        data: { workId },
      }) as unknown as Record<string, unknown>, true);
    }
  }
  if (operation === 'get' || operation === 'get_contract') {
    const work = workId ? getWorkContract(store, workId) : undefined;
    if (!work) return result(buildWorkSemanticFacadeResult({
      status: 'not_found', summary: `Work ${workId || '(missing)'} not found.`, data: { workId },
    }) as unknown as Record<string, unknown>, true);
    if (operation === 'get_contract') {
      return result(buildFacadeResult({
        summary: `Full canonical WorkContract ${work.workId} retrieved read-only.`,
        data: { workContract: work },
      }) as unknown as Record<string, unknown>);
    }
    const semantic = workSemanticView(work);
    const detail = args.detail_level === 'detail';
    return result(buildWorkSemanticFacadeResult({
      summary: `Work ${semantic.workId} retrieved at semantic revision ${semantic.revision}.`,
      data: {
        work: semantic,
        versionBinding: versionBinding(store, work, detail),
        ...(detail ? {
          executionEvidence: projectWorkExecutionEvidence(work),
          continuation: buildWorkContinuationSnapshot(work),
        } : {}),
      },
      detailLevel: args.detail_level === 'detail' ? 'detail' : 'summary',
    }) as unknown as Record<string, unknown>);
  }

  const expectedRevision = Number(args.expected_revision);
  const targetState = operation === 'complete'
    ? 'completed'
    : (args.work_state === 'open' || args.work_state === 'completed' || args.work_state === 'cancelled' ? args.work_state : undefined);
  try {
    const current = getWorkContract(store, workId);
    const choosingVersion = typeof args.requirement_revision === 'number' || typeof args.plan_revision === 'number';
    if (choosingVersion && !current) throw new Error(`WORK_NOT_FOUND: ${workId}`);
    if (choosingVersion && current && semanticWorkState(current) !== 'open') throw new Error(`WORK_TERMINAL_BASIS_IMMUTABLE: ${workId}`);
    const basis = choosingVersion ? workBasis(store, {
      requirementId: current?.requirementId,
      requirementRevision: typeof args.requirement_revision === 'number' ? args.requirement_revision : undefined,
      planId: current?.planId,
      planRevision: typeof args.plan_revision === 'number' ? args.plan_revision : undefined,
    }) : undefined;
    const revised = reviseWorkSemanticContext(store, workId, {
      expectedRevision,
      ...(typeof args.objective === 'string' ? { objective: args.objective } : {}),
      ...(targetState ? { state: targetState } : {}),
      ...(typeof args.requirement_revision === 'number' ? { requirementRevision: basis?.requirementRevision } : {}),
      ...(typeof args.plan_revision === 'number' ? { planRevision: basis?.planRevision } : {}),
      ...(operation === 'revise' && typeof args.semantic_parent_work_id === 'string' ? { semanticParentWorkId: args.semantic_parent_work_id } : {}),
      ...(operation === 'revise' && Array.isArray(args.depends_on_work_ids) ? { dependsOnWorkIds: args.depends_on_work_ids.map(String) } : {}),
      ...(Array.isArray(args.work_result_refs) ? { resultRefs: args.work_result_refs.map(String) } : {}),
    });
    const semantic = workSemanticView(revised);
    const supervisorClosure = semantic.state !== 'open'
      ? await stopTerminalWorkSupervisor(store, semantic.workId, semantic.state)
      : undefined;
    let resourceReconciliation: Awaited<ReturnType<typeof reconcileSingleTerminalWorkCleanup>> | undefined;
    if (
      semantic.state !== 'open'
      && store.controllerHome
      && revised.repoId?.trim()
    ) {
      try {
        resourceReconciliation = await reconcileSingleTerminalWorkCleanup(
          store.controllerHome,
          revised.repoId,
          revised.workId,
        );
      } catch (error) {
        resourceReconciliation = {
          status: 'blocked',
          workId: revised.workId,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return result(buildWorkSemanticFacadeResult({
      summary: `Work ${semantic.workId} revised atomically to semantic revision ${semantic.revision}.`,
      data: {
        work: semantic,
        expectedRevision,
        semanticRevision: semantic.revision,
        versionBinding: versionBinding(store, revised, false),
        ...(supervisorClosure ? { supervisorClosure } : {}),
        ...(resourceReconciliation ? { resourceReconciliation } : {}),
      },
    }) as unknown as Record<string, unknown>);
  } catch (error) {
    const current = workId ? getWorkContract(store, workId) : undefined;
    return result(buildWorkSemanticFacadeResult({
      status: 'blocked', summary: error instanceof Error ? error.message : String(error),
      data: { workId, expectedRevision, ...(current ? { currentWork: workSemanticView(current) } : {}) },
    }) as unknown as Record<string, unknown>, true);
  }
}
