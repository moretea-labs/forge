import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import { getWorkContract, listWorkContracts } from '../../../packages/kernel/work/api/index';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { collectRuntimePerformanceDiagnostics } from '../../../src/runtime/diagnostics/performance';
import { listControllerChecks } from '../../../src/cli/controller/check-runner';
import { readForgeRuntimeStatus } from '../../../src/runtime/control-plane/runtime-status-client';
import { buildWorkflowWatchdogReport } from '../../../src/runtime/watchdog/workflow-watchdog';
import { applyRuntimeMaintenance, buildRuntimeMaintenanceStatus } from '../../../src/runtime/recovery';
import {
  buildFacadeResult,
  getPlanContract,
  normalizeCheckIds,
  repairDanglingPlanStepWorkBinding,
  repairDraftPlanContractAsync,
  replanActivePlanBoundWorkScope,
  runSelfHealingLoop,
  summarizePlanContract,
  summarizeWorkContract,
} from '../../../src/runtime/control-plane/facade';
import { result } from './result-adapter';
import { selected } from './shared-adapter';
import { controllerReadinessEvidence, repositoryRevisionContains } from './status-inbox-adapter';

// Bounded rh_work repair transport orchestration. Canonical lifecycle/persistence authority remains in application services.
export function planObligationDispositionsFromArgs(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({
      predecessorPlanId: String(entry.predecessor_plan_id ?? ''),
      obligationId: String(entry.obligation_id ?? ''),
      disposition: String(entry.disposition ?? '') as 'keep' | 'change' | 'defer' | 'drop',
      successorRefs: Array.isArray(entry.successor_refs) ? entry.successor_refs.map(String) : [],
      rationale: typeof entry.rationale === 'string' ? entry.rationale : undefined,
    }));
}

export async function runFacadeRepair(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const store = {
    controllerHome: ctx.controllerHome,
    repoId: repository.repoId,
    revisionContains: (ancestorRevision: string, descendantRevision: string) =>
      repositoryRevisionContains(repository.canonicalRoot, ancestorRevision, descendantRevision),
  };
  let maintenanceSnapshot: ReturnType<typeof buildRuntimeMaintenanceStatus> | undefined;
  let maintenanceStatus: {
    readyForExecution?: boolean;
    recommendedActions?: string[];
    candidates?: Array<{ kind?: string; reason?: string; suggestedAction?: string; safe?: boolean }>;
    warnings?: string[];
  } | undefined;
  try {
    const status = buildRuntimeMaintenanceStatus(repository, ctx.controllerHome, {
      minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
      maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : 20,
    });
    maintenanceSnapshot = status;
    maintenanceStatus = {
      readyForExecution: status.readyForExecution,
      recommendedActions: status.recommendedActions,
      candidates: status.candidates.map((candidate) => ({
        kind: candidate.kind,
        reason: candidate.reason,
        suggestedAction: candidate.suggestedAction,
        safe: candidate.safe,
      })),
      warnings: status.warnings,
    };
  } catch {
    maintenanceStatus = {
      readyForExecution: false,
      recommendedActions: [],
      candidates: [],
      warnings: ['runtime_maintenance_status inspection failed; treating as infrastructure issue, not acceptance failure'],
    };
  }

  const repairOperation = args.repair_operation === 'repair' || args.repair_operation === 'verify' || args.repair_operation === 'handoff'
    ? args.repair_operation
    : 'diagnose';
  const dryRun = args.dry_run === undefined ? true : args.dry_run === true;
  const elevatedRepair = args.destructive === true || args.remote_write === true || args.remote_effect === true;
  const planId = typeof args.plan_id === 'string' ? args.plan_id.trim() : '';
  const planStepId = typeof args.plan_step_id === 'string' ? args.plan_step_id.trim() : '';
  const exactWorkId = typeof args.work_id === 'string' ? args.work_id.trim() : '';

  if (planId && !planStepId) {
    const plan = getPlanContract(store, planId);
    if (!plan) {
      const facade = buildFacadeResult({ status: 'not_found', summary: `PlanContract ${planId} not found.`, data: { operation: repairOperation, dryRun, planId, repaired: false } });
      return result(facade as unknown as Record<string, unknown>, true);
    }
    const pendingRevision = plan.status === 'replanning' ? plan.pendingRevision : undefined;
    if (plan.status !== 'draft' && !pendingRevision) {
      const facade = buildFacadeResult({ status: 'blocked', summary: `PLAN_DRAFT_REPAIR_STATUS_INVALID: ${plan.planId}:${plan.status}`, data: { operation: repairOperation, dryRun, planId, repaired: false } });
      return result(facade as unknown as Record<string, unknown>, true);
    }
    const repairBase = pendingRevision ?? plan;
    if (repairOperation !== 'repair' || dryRun) {
      const facade = buildFacadeResult({
        summary: pendingRevision
          ? `PlanContract ${plan.planId} has staged revision r${pendingRevision.revision}. Exact in-place revision repair is available; stable Plan identity and committed revision remain authoritative until approval.`
          : `PlanContract ${plan.planId} is a draft. Exact in-place repair is available; the Plan identity and Requirement authority are preserved and only a fully valid draft may be persisted.`,
        data: { operation: repairOperation, dryRun, plan: summarizePlanContract(plan), repaired: false, repairRequired: true },
        suggestedNextActions: [{ label: 'Repair this exact draft Plan', tool: 'rh_work', operation: 'repair', payload: { plan_id: plan.planId, repair_operation: 'repair', dry_run: false }, risk: 'workspace_write', confidence: 'high' }],
      });
      return result(facade as unknown as Record<string, unknown>);
    }
    const rawSteps = Array.isArray(args.plan_steps)
      ? args.plan_steps
      : repairBase.steps.map((step) => ({
          id: step.id, objective: step.objective, dependencies: step.dependencies, authoritative_files: step.authoritativeFiles,
          allowed_paths: step.allowedPaths, forbidden_paths: step.forbiddenPaths, check_ids: step.checks, acceptance_criteria: step.acceptanceCriteria,
        }));
    const steps = rawSteps
      .filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === 'object' && !Array.isArray(step))
      .map((step) => ({
        id: String(step.id ?? ''),
        objective: String(step.objective ?? ''),
        dependencies: Array.isArray(step.dependencies) ? step.dependencies.map(String) : [],
        authoritativeFiles: Array.isArray(step.authoritative_files) ? step.authoritative_files.map(String) : [],
        allowedPaths: Array.isArray(step.allowed_paths) ? step.allowed_paths.map(String) : [],
        forbiddenPaths: Array.isArray(step.forbidden_paths) ? step.forbidden_paths.map(String) : [],
        checks: Array.isArray(step.check_ids) ? step.check_ids.map(String) : [],
        acceptanceCriteria: Array.isArray(step.acceptance_criteria) ? step.acceptance_criteria.map(String) : [],
      }));
    const availableChecks = listControllerChecks(repository.canonicalRoot);
    const normalizedPlanChecks = normalizeCheckIds(steps.flatMap((step) => step.checks), availableChecks);
    if (normalizedPlanChecks.invalidCheckIds.length > 0) {
      const facade = buildFacadeResult({
        status: 'failed',
        summary: `PLAN_CHECKS_INVALID: ${normalizedPlanChecks.invalidCheckIds.join(', ')}. Draft repair was not persisted.`,
        data: { operation: repairOperation, dryRun: false, planId, repaired: false, normalizedChecks: normalizedPlanChecks, registeredCheckIds: availableChecks.map((check) => check.id).slice(0, 80) },
        suggestedNextActions: [],
      });
      return result(facade as unknown as Record<string, unknown>, true);
    }
    try {
      const repaired = await repairDraftPlanContractAsync(store, planId, {
        expectedSourceRevision: repairBase.sourceRevision,
        scopeKey: typeof args.scope_key === 'string' ? args.scope_key : plan.scopeKey,
        sourceRevision: typeof args.source_revision === 'string' ? args.source_revision : repairBase.sourceRevision,
        goal: typeof args.objective === 'string' ? args.objective : repairBase.goal,
        nonGoals: Array.isArray(args.non_goals) ? args.non_goals.map(String) : repairBase.nonGoals,
        assumptions: Array.isArray(args.assumptions) ? args.assumptions.map(String) : repairBase.assumptions,
        resolvedDecisions: Array.isArray(args.resolved_decisions) ? args.resolved_decisions.map(String) : repairBase.resolvedDecisions,
        stopConditions: Array.isArray(args.stop_conditions) ? args.stop_conditions.map(String) : repairBase.stopConditions,
        replanConditions: Array.isArray(args.replan_conditions) ? args.replan_conditions.map(String) : repairBase.replanConditions,
        integrationStrategy: typeof args.integration_strategy === 'string' ? args.integration_strategy : repairBase.integrationStrategy,
        obligationDispositions: planObligationDispositionsFromArgs(args.obligation_dispositions) ?? repairBase.obligationDispositions,
        steps,
      });
      const facade = buildFacadeResult({
        summary: pendingRevision ? `PlanContract ${repaired.planId} staged revision repaired in place; stable Plan identity and committed authority were preserved.` : `PlanContract ${repaired.planId} draft repaired in place; identity and Requirement authority were preserved.`,
        data: { operation: repairOperation, dryRun: false, plan: summarizePlanContract(repaired), repaired: true, replacementPlanCreated: false },
        suggestedNextActions: [{ label: 'Read repaired Plan', tool: 'rh_work', operation: 'plan_get', payload: { plan_id: repaired.planId }, risk: 'readonly', confidence: 'medium' }],
      });
      return result(facade as unknown as Record<string, unknown>);
    } catch (error) {
      const facade = buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'PLAN_DRAFT_REPAIR_FAILED', data: { operation: repairOperation, dryRun: false, planId, repaired: false } });
      return result(facade as unknown as Record<string, unknown>, true);
    }
  }

  if (planStepId && !planId) {
    const facade = buildFacadeResult({ status: 'blocked', summary: 'PLAN_STEP_REPAIR_CONTEXT_REQUIRED: plan_id and plan_step_id are both required.', data: { operation: repairOperation, dryRun, repaired: false } });
    return result(facade as unknown as Record<string, unknown>, true);
  }

  if (planId && planStepId) {
    const plan = getPlanContract(store, planId);
    const step = plan?.steps.find((candidate) => candidate.id === planStepId);
    if (!plan || !step) {
      const facade = buildFacadeResult({ status: 'not_found', summary: !plan ? `PlanContract ${planId} not found.` : `PLAN_STEP_NOT_FOUND: ${planStepId}`, data: { operation: repairOperation, dryRun, planId, planStepId, repaired: false } });
      return result(facade as unknown as Record<string, unknown>, true);
    }
    if (!step.workId) {
      const facade = buildFacadeResult({ summary: `Plan step ${planId}/${planStepId} has no Work binding to repair.`, data: { operation: repairOperation, dryRun, planId, planStepId, repaired: false, repairRequired: false } });
      return result(facade as unknown as Record<string, unknown>);
    }
    const boundWork = getWorkContract(store, step.workId);
    if (boundWork) {
      if (['completed', 'failed', 'cancelled'].includes(boundWork.status)) {
        const facade = buildFacadeResult({
          summary: `PLAN_STEP_TERMINAL_WORK_FACT: ${planId}/${planStepId} is bound to terminal Work ${boundWork.workId}. Execution repair does not mutate model-authored Plan progress; revise the stable Plan explicitly with expected_revision when this fact changes the plan.`,
          data: { operation: repairOperation, dryRun, planId, planStepId, boundWorkId: boundWork.workId, terminalWorkStatus: boundWork.status, repaired: false, repairRequired: false, reusedExistingWork: true },
          suggestedNextActions: [{ label: 'Revise Plan from terminal Work fact', tool: 'rh_work', operation: 'plan_revise', payload: { plan_id: planId, expected_revision: plan.revision }, risk: 'workspace_write', confidence: 'high' }],
        });
        return result(facade as unknown as Record<string, unknown>);
      }
      const requestedRevisionLabel = typeof args.superseded_by === 'string' ? args.superseded_by.trim() : '';
      const requestedAllowedPaths = Array.isArray(args.allowed_paths)
        ? [...new Set([...step.allowedPaths, ...args.allowed_paths.map(String).map((value) => value.trim()).filter(Boolean)])]
        : step.allowedPaths;
      const scopeReplanRequested = Boolean(requestedRevisionLabel) || requestedAllowedPaths.length > step.allowedPaths.length;
      if (scopeReplanRequested) {
        const requestedSourceRevision = typeof args.source_revision === 'string' ? args.source_revision.trim() : '';
        if (!requestedRevisionLabel || !requestedSourceRevision || requestedAllowedPaths.length === step.allowedPaths.length) {
          const facade = buildFacadeResult({
            status: 'blocked',
            summary: 'PLAN_WORK_SCOPE_REPLAN_INPUT_REQUIRED: superseded_by, source_revision, and at least one new allowed_paths entry are required for an active Plan-bound Work scope replan.',
            data: { operation: repairOperation, dryRun, planId, planStepId, boundWorkId: boundWork.workId, repaired: false, requestedRevisionLabel: requestedRevisionLabel || undefined, requestedSourceRevision: requestedSourceRevision || undefined, requestedAllowedPaths },
          });
          return result(facade as unknown as Record<string, unknown>, true);
        }
        if (repairOperation !== 'repair' || dryRun) {
          const facade = buildFacadeResult({
            summary: `PLAN_WORK_SCOPE_REPLAN_AVAILABLE: ${planId}/${planStepId} can atomically move exact Work ${boundWork.workId} to stable Plan ${planId} revision label ${requestedRevisionLabel} while widening only allowed-path authority.`,
            data: { operation: repairOperation, dryRun, planId, planStepId, boundWorkId: boundWork.workId, requestedRevisionLabel, requestedSourceRevision, requestedAllowedPaths, repaired: false, repairRequired: true, reusedExistingWork: true },
            suggestedNextActions: [{ label: 'Replan exact active Work scope', tool: 'rh_work', operation: 'repair', payload: { plan_id: planId, plan_step_id: planStepId, superseded_by: requestedRevisionLabel, source_revision: requestedSourceRevision, allowed_paths: requestedAllowedPaths, repair_operation: 'repair', dry_run: false }, risk: 'workspace_write', confidence: 'high' }],
          });
          return result(facade as unknown as Record<string, unknown>);
        }
        try {
          const replanned = replanActivePlanBoundWorkScope(store, {
            planId,
            stepId: planStepId,
            workId: boundWork.workId,
            requestedRevisionLabel,
            sourceRevision: requestedSourceRevision,
            allowedPaths: requestedAllowedPaths,
            reason: typeof args.reason === 'string' && args.reason.trim()
              ? args.reason.trim()
              : 'Explicit Controller repair widened a frozen Plan path fence after current-source evidence proved the existing Plan contract omitted a path required by its own acceptance scope.',
          });
          const facade = buildFacadeResult({
            summary: `Replanned ${planId}/${planStepId} as ${replanned.currentPlan.planId} r${replanned.currentPlan.revision ?? 1} and retained the same active Work ${replanned.work.workId} atomically; semantic acceptance and checks were not widened.`,
            data: { operation: repairOperation, dryRun: false, priorPlan: summarizePlanContract(replanned.priorPlan), currentPlan: summarizePlanContract(replanned.currentPlan), work: summarizeWorkContract(replanned.work), repaired: true, replacementWorkCreated: false, reusedExistingWork: true },
          });
          return result(facade as unknown as Record<string, unknown>);
        } catch (error) {
          const facade = buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'PLAN_WORK_SCOPE_REPLAN_FAILED', data: { operation: repairOperation, dryRun: false, planId, planStepId, boundWorkId: boundWork.workId, requestedRevisionLabel, repaired: false } });
          return result(facade as unknown as Record<string, unknown>, true);
        }
      }
      const facade = buildFacadeResult({
        status: 'blocked',
        summary: `PLAN_STEP_BOUND_WORK_STILL_EXISTS: ${planId}/${planStepId} is bound to active Work ${boundWork.workId}; continue that exact Work, or explicitly request a scope-only stable Plan revision instead of replacing the Work.`,
        data: { operation: repairOperation, dryRun, planId, planStepId, boundWorkId: boundWork.workId, repaired: false, repairRequired: false },
        suggestedNextActions: [{ label: 'Continue existing Work', tool: 'rh_work', operation: 'continue', payload: { work_id: boundWork.workId }, risk: 'readonly', confidence: 'high' }],
      });
      return result(facade as unknown as Record<string, unknown>, true);
    }
    const conflicting = listWorkContracts({ ...store, status: 'active', limit: 200 })
      .filter((candidate) => candidate.planId === planId && candidate.planStepId === planStepId && candidate.workId !== step.workId);
    if (conflicting.length > 0) {
      const facade = buildFacadeResult({
        status: 'blocked',
        summary: `PLAN_STEP_REPAIR_CONFLICT: ${planId}/${planStepId} is bound to missing Work ${step.workId}, but ${conflicting.length} other active Work record(s) claim the same step. Resolve the conflicting authority before changing the Plan binding.`,
        data: { operation: repairOperation, dryRun, planId, planStepId, boundWorkId: step.workId, conflictingWorkIds: conflicting.map((candidate) => candidate.workId), repaired: false },
      });
      return result(facade as unknown as Record<string, unknown>, true);
    }
    if (repairOperation !== 'repair' || dryRun) {
      const facade = buildFacadeResult({
        summary: `PLAN_STEP_DANGLING_WORK_BINDING: ${planId}/${planStepId} points to missing Work ${step.workId}. Exact repair is available and will clear only this unchanged ghost binding.`,
        data: { operation: repairOperation, dryRun, planId, planStepId, boundWorkId: step.workId, repaired: false, repairRequired: true },
        suggestedNextActions: [{ label: 'Repair exact dangling binding', tool: 'rh_work', operation: 'repair', payload: { plan_id: planId, plan_step_id: planStepId, repair_operation: 'repair', dry_run: false }, risk: 'workspace_write', confidence: 'high' }],
      });
      return result(facade as unknown as Record<string, unknown>);
    }
    try {
      const repairedPlan = repairDanglingPlanStepWorkBinding(store, {
        planId,
        stepId: planStepId,
        expectedWorkId: step.workId,
        reason: 'Explicit Controller repair confirmed that the exact bound Work record is absent and no other active primary Work claims this Plan step.',
      });
      const facade = buildFacadeResult({
        summary: `Repaired dangling Plan step binding ${planId}/${planStepId}; ${step.workId} was cleared without creating a replacement Work.`,
        data: { operation: repairOperation, dryRun: false, plan: summarizePlanContract(repairedPlan), boundWorkId: step.workId, repaired: true, replacementWorkCreated: false },
      });
      return result(facade as unknown as Record<string, unknown>);
    } catch (error) {
      const facade = buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'PLAN_STEP_DANGLING_WORK_REPAIR_FAILED', data: { operation: repairOperation, dryRun: false, planId, planStepId, boundWorkId: step.workId, repaired: false } });
      return result(facade as unknown as Record<string, unknown>, true);
    }
  }

  // The self-healing facade is a policy/planning surface; the authoritative
  // maintenance executor owns mutations. Execute it here only for an explicit,
  // non-dry-run repair whose entire observed candidate set is already classified
  // safe. Unsafe/destructive/remote repair continues through the approval path.
  if (
    repairOperation === 'repair'
    && !dryRun
    && !elevatedRepair
    && !exactWorkId
    && maintenanceSnapshot
    && maintenanceSnapshot.candidates.length > 0
  ) {
    const applied = applyRuntimeMaintenance(repository, ctx.controllerHome, {
      actionId: 'full_maintenance_pass',
      confirmMaintenance: true,
      minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
      maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : 20,
    });
    const actions = applied.applied.slice(0, 20).map((entry) => ({
      kind: entry.kind,
      id: entry.id,
      applied: entry.applied,
      result: entry.result,
      ...(entry.error ? { error: entry.error.slice(0, 300) } : {}),
    }));
    const appliedCount = applied.applied.filter((entry) => entry.applied).length;
    // Protected stale runtime temp entries are intentionally non-blocking maintenance
    // diagnostics. Keep repair completion semantics aligned with rh_status readiness so
    // their presence does not falsely report a blocked repair after safe debt is cleared.
    const remainingCandidateCount = applied.candidates.filter((candidate) => candidate.kind !== 'stale_runtime_temp_entry').length;
    const blocked = remainingCandidateCount > 0;
    const facade = buildFacadeResult({
      status: blocked ? 'blocked' : 'ok',
      summary: blocked
        ? `Runtime maintenance applied ${appliedCount} candidate(s); ${remainingCandidateCount} candidate(s) remain after the authoritative executor pass.`
        : `Runtime maintenance applied ${appliedCount} candidate(s); no maintenance candidates remain.`,
      data: {
        operation: 'repair',
        dryRun: false,
        applied: appliedCount > 0,
        actionId: 'full_maintenance_pass',
        appliedCount,
        remainingCandidateCount,
        actions,
        classification: 'infrastructure_recovery',
        isAcceptanceFailure: false,
      },
      warnings: applied.warnings.slice(0, 5),
      suggestedNextActions: [{
        label: 'Verify controller status after repair',
        tool: 'rh_status',
        operation: 'get',
        risk: 'readonly',
        confidence: 'high',
      }],
      rawAvailable: false,
    });
    return result(facade as unknown as Record<string, unknown>, blocked);
  }

  let watchdogSummary: string | undefined;
  let performanceSummary: string | undefined;
  try {
    const watchdog = buildWorkflowWatchdogReport(ctx.controllerHome, repository, { includeProcesses: false });
    watchdogSummary = `status=${watchdog.status}; findings=${watchdog.findings.length}; stale=${watchdog.staleWork.length}`.slice(0, 240);
  } catch {
    watchdogSummary = undefined;
  }
  try {
    const perf = collectRuntimePerformanceDiagnostics({
      repoId: repository.repoId,
      repoRoot: repository.canonicalRoot,
      includeProcesses: false,
      includeTempDirs: false,
    });
    performanceSummary = perf.summary.slice(0, 240);
  } catch {
    performanceSummary = undefined;
  }

  const daemon = readForgeRuntimeStatus(ctx.controllerHome);
  const readiness = await controllerReadinessEvidence(ctx, repository);
  const facade = runSelfHealingLoop(
    { repoId: repository.repoId, handoffStore: store },
    {
      operation: repairOperation,
      dryRun,
      approvalConfirmed: args.approval_confirmed === true,
      workId: typeof args.work_id === 'string' ? args.work_id : undefined,
      chatgptPullFailed: args.chatgpt_pull_failed === true,
      destructive: args.destructive === true,
      remoteEffect: args.remote_write === true || args.remote_effect === true,
      maintenanceStatus,
      diagnostics: {
        watchdogSummary,
        performanceSummary,
        controllerDaemonUnhealthy: daemon.status !== 'ready',
        schedulerUnhealthy: readiness.durableScheduler.status !== 'ready',
        codexUnavailable: args.codex_available === false,
        grokUnavailable: args.grok_available === false || args.target === 'grok',
        pluginUnavailable: args.plugin_unavailable === true,
      },
    },
  );
  return result(facade as unknown as Record<string, unknown>, facade.status === 'blocked' || facade.status === 'approval_required' || facade.status === 'failed');
}

