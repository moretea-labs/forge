import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { controllerSessionPrincipalId, getControllerRoundRelay, getControllerSession } from '../../../packages/kernel/controller/api/index';
import { getWorkContract } from '../../../packages/kernel/work/api/index';
import {
  admitPlanContractAsync,
  approvePlanContractAsync,
  acceptPlanStepEvidence,
  buildFacadeResult,
  getPlanContract,
  listPlanContracts,
  normalizeCheckIds,
  resolvePlanAdmission,
  summarizePlanContract,
  supersedePlanContract,
  type CheckDefinitionLike,
  type PlanContractStoreOptions,
} from '../../../src/runtime/control-plane/facade';
import { readRequirement } from '../../../src/runtime/control-plane/persistence/requirement-store';
import { assertFacadeControllerRoundAuthority, authenticatedFacadeControllerIdentity } from './controller-authority-adapter';
import { result } from './result-adapter';

const RH_WORK_LIGHTWEIGHT_PLAN_OPERATIONS = new Set([
  'plan_list',
  'plan_get',
  'plan_approve',
  'plan_supersede',
]);

export function isRhWorkLightweightPlanOperation(operation: string): boolean {
  return RH_WORK_LIGHTWEIGHT_PLAN_OPERATIONS.has(operation);
}

export async function callRhWorkPlanOperation(
  store: PlanContractStoreOptions,
  operation: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (!isRhWorkLightweightPlanOperation(operation)) return undefined;

  if (operation === 'plan_list') {
    const plans = listPlanContracts({ ...store, status: 'active', limit: typeof args.limit === 'number' ? args.limit : 20 });
    const facade = buildFacadeResult({
      summary: `${plans.length} active PlanContract(s) in this repository.`,
      data: { plans: plans.map(summarizePlanContract), bounded: true },
    });
    return result(facade as unknown as Record<string, unknown>);
  }

  if (operation === 'plan_get') {
    const plan = getPlanContract(store, String(args.plan_id ?? ''));
    const facade = plan
      ? buildFacadeResult({
          summary: `PlanContract ${plan.planId} retrieved.`,
          data: { plan: args.detail_level === 'detail' ? plan : summarizePlanContract(plan) },
          detailLevel: args.detail_level === 'detail' ? 'detail' : 'summary',
        })
      : buildFacadeResult({
          status: 'not_found',
          summary: `PlanContract ${String(args.plan_id ?? '')} not found.`,
          data: { planId: String(args.plan_id ?? '') },
        });
    return result(facade as unknown as Record<string, unknown>, !plan);
  }

  try {
    if (operation === 'plan_approve') {
      const plan = await approvePlanContractAsync(store, String(args.plan_id ?? ''));
      const facade = buildFacadeResult({
        summary: `PlanContract ${plan.planId} approved at source revision ${plan.sourceRevision}; execution remains explicit.`,
        data: { plan: summarizePlanContract(plan), executionStarted: false },
      });
      return result(facade as unknown as Record<string, unknown>);
    }

    const plan = supersedePlanContract(store, String(args.plan_id ?? ''), String(args.superseded_by ?? ''));
    const facade = buildFacadeResult({
      summary: `PlanContract ${plan.planId} superseded by ${plan.supersededBy}.`,
      data: { plan: summarizePlanContract(plan) },
    });
    return result(facade as unknown as Record<string, unknown>);
  } catch (error) {
    const facade = buildFacadeResult({
      status: 'blocked',
      summary: error instanceof Error ? error.message : 'PlanContract operation failed.',
      data: { operation, executionStarted: false },
    });
    return result(facade as unknown as Record<string, unknown>, true);
  }
}

function planObligationDispositionsFromArgs(value: unknown) {
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

export interface RhWorkPlanCreateContext {
  controllerHome: string;
  repoId: string;
  checks: readonly CheckDefinitionLike[];
}

export async function callRhWorkPlanCreateOperation(
  store: PlanContractStoreOptions,
  operation: string,
  args: Record<string, unknown>,
  context: RhWorkPlanCreateContext,
): Promise<CallToolResult | undefined> {
  if (operation !== 'plan_create') return undefined;

  try {
    const rawSteps = Array.isArray(args.plan_steps) ? args.plan_steps : [];
    const requestedPlanId = String(args.plan_id ?? '').trim();
    const requestedRequirementId = typeof args.requirement_id === 'string' && args.requirement_id.trim() ? args.requirement_id.trim() : undefined;
    const requestedPlanRelation: 'extend' | 'parallel' | undefined = args.plan_relation === 'extend' || args.plan_relation === 'parallel'
      ? args.plan_relation
      : undefined;
    const relatedPlanId = typeof args.related_plan_id === 'string' && args.related_plan_id.trim() ? args.related_plan_id.trim() : undefined;
    if (requestedRequirementId && !readRequirement({ controllerHome: context.controllerHome }, requestedRequirementId)) {
      const facade = buildFacadeResult({
        status: 'failed',
        summary: `PLAN_REQUIREMENT_NOT_FOUND: ${requestedRequirementId}. Plan was not persisted; create or reconcile the Requirement authority first.`,
        data: { executionStarted: false, planContractCreated: false, admissionDecision: 'missing_requirement', requirementId: requestedRequirementId },
      });
      return result(facade as unknown as Record<string, unknown>, true);
    }

    const admissionInput = {
      requirementId: requestedRequirementId,
      scopeKey: String(args.scope_key ?? ''),
      planRelation: requestedPlanRelation,
      relatedPlanId,
    };
    const renderPlanAdmission = (admission: ReturnType<typeof resolvePlanAdmission>): CallToolResult | undefined => {
      if (admission.admissionDecision === 'create_new') return undefined;
      if (admission.reason === 'exact_scope_authority' && admission.plan) {
        const exactDraftRepair = admission.plan.status === 'draft' && requestedPlanId === admission.plan.planId;
        const facade = buildFacadeResult({
          summary: exactDraftRepair
            ? `PLAN_DRAFT_REPAIR_REQUIRED: draft Plan ${admission.plan.planId} already owns scope ${admission.normalizedScopeKey}; preserve that authority and amend it through rh_work repair.`
            : `PLAN_AUTHORITY_REUSED: active Plan ${admission.plan.planId} already owns scope ${admission.normalizedScopeKey}; no duplicate draft was created.`,
          data: {
            plan: summarizePlanContract(admission.plan),
            executionStarted: false,
            planContractCreated: false,
            admissionDecision: 'reuse_existing',
            resolutionRequired: false,
            ...(exactDraftRepair ? { repairRequired: true } : {}),
          },
          suggestedNextActions: exactDraftRepair
            ? [{
                label: 'Repair this exact draft Plan',
                tool: 'rh_work',
                operation: 'repair',
                payload: {
                  plan_id: admission.plan.planId,
                  repair_operation: 'repair',
                  dry_run: false,
                  scope_key: args.scope_key,
                  source_revision: args.source_revision,
                  objective: args.objective,
                  plan_steps: args.plan_steps,
                  non_goals: args.non_goals,
                  assumptions: args.assumptions,
                  resolved_decisions: args.resolved_decisions,
                  stop_conditions: args.stop_conditions,
                  replan_conditions: args.replan_conditions,
                  integration_strategy: args.integration_strategy,
                },
                risk: 'workspace_write',
                confidence: 'high',
              }]
            : [{ label: 'Read active Plan', tool: 'rh_work', operation: 'plan_get', payload: { plan_id: admission.plan.planId }, risk: 'readonly', confidence: 'high' }],
        });
        return result(facade as unknown as Record<string, unknown>);
      }
      if (admission.reason === 'extension_target_required') {
        const facade = buildFacadeResult({
          summary: `PLAN_EXTENSION_TARGET_REQUIRED: select related_plan_id from the active Plan slices for Requirement ${requestedRequirementId}.`,
          data: { executionStarted: false, planContractCreated: false, admissionDecision: 'resolution_required', resolutionRequired: true, candidates: admission.candidates.map(summarizePlanContract) },
        });
        return result(facade as unknown as Record<string, unknown>);
      }
      if (admission.reason === 'extend_existing' && admission.plan) {
        // plan_create + plan_relation=extend revises the explicitly related stable
        // Plan identity in place. Preflight continues into atomic admission.
        return undefined;
      }
      throw new Error(`PLAN_ADMISSION_RESULT_INVALID: ${admission.admissionDecision}:${admission.reason}`);
    };

    const plans = listPlanContracts({ ...store, status: 'all', limit: 100 });
    const preflightAdmission = resolvePlanAdmission(plans, admissionInput);
    const preflightResult = renderPlanAdmission(preflightAdmission);
    if (preflightResult) return preflightResult;

    const requestedPlanCheckIds = rawSteps
      .filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === 'object' && !Array.isArray(step))
      .flatMap((step) => Array.isArray(step.check_ids) ? step.check_ids.map(String) : []);
    const normalizedPlanChecks = normalizeCheckIds(requestedPlanCheckIds, context.checks);
    if (normalizedPlanChecks.invalidCheckIds.length > 0) {
      const facade = buildFacadeResult({
        status: 'failed',
        summary: `PLAN_CHECKS_INVALID: ${normalizedPlanChecks.invalidCheckIds.join(', ')}. Plan was not persisted; select replacement IDs from registeredCheckIds in this response, then request readiness only for the checks you choose.`,
        data: {
          executionStarted: false,
          planContractCreated: false,
          admissionDecision: 'invalid_checks',
          normalizedChecks: normalizedPlanChecks,
          registeredCheckIds: context.checks.map((check) => check.id).slice(0, 80),
        },
        suggestedNextActions: [],
      });
      return result(facade as unknown as Record<string, unknown>, true);
    }

    const admitted = await admitPlanContractAsync(store, {
      planId: String(args.plan_id ?? ''),
      repoId: context.repoId,
      requirementId: requestedRequirementId,
      scopeKey: String(args.scope_key ?? ''),
      planRelation: requestedPlanRelation,
      relatedPlanId,
      sourceRevision: String(args.source_revision ?? ''),
      goal: String(args.objective ?? ''),
      nonGoals: Array.isArray(args.non_goals) ? args.non_goals.map(String) : undefined,
      assumptions: Array.isArray(args.assumptions) ? args.assumptions.map(String) : undefined,
      resolvedDecisions: Array.isArray(args.resolved_decisions) ? args.resolved_decisions.map(String) : undefined,
      stopConditions: Array.isArray(args.stop_conditions) ? args.stop_conditions.map(String) : undefined,
      replanConditions: Array.isArray(args.replan_conditions) ? args.replan_conditions.map(String) : undefined,
      integrationStrategy: typeof args.integration_strategy === 'string' ? args.integration_strategy : undefined,
      obligationDispositions: planObligationDispositionsFromArgs(args.obligation_dispositions),
      steps: rawSteps.filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === 'object' && !Array.isArray(step)).map((step) => ({
        id: String(step.id ?? ''),
        objective: String(step.objective ?? ''),
        dependencies: Array.isArray(step.dependencies) ? step.dependencies.map(String) : [],
        authoritativeFiles: Array.isArray(step.authoritative_files) ? step.authoritative_files.map(String) : [],
        allowedPaths: Array.isArray(step.allowed_paths) ? step.allowed_paths.map(String) : [],
        forbiddenPaths: Array.isArray(step.forbidden_paths) ? step.forbidden_paths.map(String) : [],
        checks: Array.isArray(step.check_ids) ? step.check_ids.map(String) : [],
        acceptanceCriteria: Array.isArray(step.acceptance_criteria) ? step.acceptance_criteria.map(String) : [],
      })),
    });
    if (admitted.reason === 'extend_existing' && admitted.plan) {
      const plan = admitted.plan;
      const requestedLabel = requestedPlanId && requestedPlanId !== plan.planId
        ? ` Requested compatibility plan_id ${requestedPlanId} was retained only as revision audit metadata.`
        : '';
      const facade = buildFacadeResult({
        summary: `PLAN_REVISION_REUSED_AUTHORITY: Plan ${plan.planId} was revised in place; no successor PlanContract was created.${requestedLabel}`,
        data: {
          plan: summarizePlanContract(plan),
          executionStarted: false,
          planContractCreated: false,
          admissionDecision: 'reuse_existing',
          resolutionRequired: false,
        },
        suggestedNextActions: [{ label: 'Approve revised Plan', tool: 'rh_work', operation: 'plan_approve', payload: { plan_id: plan.planId }, risk: 'workspace_write', confidence: 'high' }],
      });
      return result(facade as unknown as Record<string, unknown>);
    }
    const racedAdmissionResult = renderPlanAdmission(admitted);
    if (racedAdmissionResult) return racedAdmissionResult;
    if (!admitted.plan) throw new Error('PLAN_ADMISSION_CREATE_MISSING_PLAN');
    const plan = admitted.plan;
    const facade = buildFacadeResult({
      summary: `PlanContract ${plan.planId} created as draft after atomic authority admission; no execution was started.`,
      data: { plan: summarizePlanContract(plan), executionStarted: false, planContractCreated: true, admissionDecision: 'create_new' },
      suggestedNextActions: [{ label: 'Approve reviewed plan', tool: 'rh_work', operation: 'plan_approve', payload: { plan_id: plan.planId }, risk: 'workspace_write', confidence: 'medium' }],
    });
    return result(facade as unknown as Record<string, unknown>);
  } catch (error) {
    const facade = buildFacadeResult({
      status: 'blocked',
      summary: error instanceof Error ? error.message : 'PlanContract operation failed.',
      data: { operation, executionStarted: false },
    });
    return result(facade as unknown as Record<string, unknown>, true);
  }
}


export interface RhWorkPlanAcceptStepContext {
  sourceRevision?: string;
}

type RhWorkPlanAcceptStepStore = PlanContractStoreOptions & { controllerHome: string; repoId: string };

/**
 * Semantic PlanStep acceptance stays in the Plan adapter while exact terminal
 * ControllerRound authority is proven through the canonical authority adapter.
 */
export function callRhWorkPlanAcceptStepOperation(
  ctx: MultiRepositoryMcpToolContext,
  store: RhWorkPlanAcceptStepStore,
  operation: string,
  args: Record<string, unknown>,
  context: RhWorkPlanAcceptStepContext,
): CallToolResult | undefined {
  if (operation !== 'plan_accept_step') return undefined;
  try {
    const identity = authenticatedFacadeControllerIdentity(ctx, args);
    const planId = String(args.plan_id ?? '').trim();
    const stepId = String(args.plan_step_id ?? '').trim();
    const rationale = String(args.acceptance_rationale ?? '').trim();
    const before = getPlanContract(store, planId);
    const beforeStep = before?.steps.find((candidate) => candidate.id === stepId);
    const predecessorWorkId = beforeStep?.workId?.trim();
    const predecessorWork = predecessorWorkId ? getWorkContract(store, predecessorWorkId) : undefined;
    const claimedRelay = predecessorWorkId ? getControllerRoundRelay(store, predecessorWorkId) : undefined;
    const currentOwner = predecessorWorkId ? getControllerSession(store, predecessorWorkId) : undefined;
    const claimedTerminalRound = Boolean(
      predecessorWork
      && predecessorWork.status === 'completed'
      && claimedRelay?.status === 'claimed'
    );
    if (claimedTerminalRound && predecessorWorkId) {
      assertFacadeControllerRoundAuthority(ctx, store, predecessorWorkId, args);
      if (currentOwner) {
        if (currentOwner.controllerType !== identity.controllerType) throw new Error(`CONTROLLER_RELAY_CONTROLLER_TYPE_MISMATCH: ${predecessorWorkId}`);
        if (currentOwner.controllerId !== identity.controllerId) throw new Error(`WORK_CONTROLLER_OWNER_MISMATCH: ${predecessorWorkId}`);
        if (controllerSessionPrincipalId(currentOwner) !== identity.principalId) throw new Error(`WORK_CONTROLLER_PRINCIPAL_MISMATCH: ${predecessorWorkId}`);
      }
    }
    const plan = acceptPlanStepEvidence(store, {
      planId,
      stepId,
      reviewer: identity.principalId,
      rationale,
      acceptedSourceRevision: context.sourceRevision,
    });
    const facade = buildFacadeResult({
      summary: `Plan step ${stepId} semantically accepted by the current Controller. Successor execution remains an explicit Controller start.`,
      data: {
        plan: summarizePlanContract(plan),
        semanticAcceptanceRecorded: true,
        reviewer: identity.principalId,
        ...(predecessorWorkId ? { predecessorWorkId } : {}),
        successorAdmissionRequired: plan.status !== 'finalized',
      },
      suggestedNextActions: plan.status === 'finalized'
        ? []
        : [{ label: 'Read the next approved Plan step', tool: 'rh_work', operation: 'plan_get', payload: { plan_id: plan.planId }, risk: 'readonly', confidence: 'high' }],
    });
    return result(facade as unknown as Record<string, unknown>);
  } catch (error) {
    const facade = buildFacadeResult({
      status: 'blocked',
      summary: error instanceof Error ? error.message : 'PlanContract operation failed.',
      data: { operation, executionStarted: false },
    });
    return result(facade as unknown as Record<string, unknown>, true);
  }
}
