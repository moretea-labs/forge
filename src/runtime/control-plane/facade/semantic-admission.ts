import { withControllerLock, withControllerLockAsync } from '../../../cli/repositories/locks';
import { sanitizeFileComponent } from '../../shared/json-files';
import { isTerminalPlanContractStatus, type PlanContract } from './types';

export const PLAN_ADMISSION_RELATIONS = ['extend', 'parallel'] as const;
export type PlanAdmissionRelation = (typeof PLAN_ADMISSION_RELATIONS)[number];

export type PlanAdmissionReason =
  | 'exact_scope_authority'
  | 'requirement_relation_required'
  | 'extension_target_required'
  | 'extend_existing'
  | 'create_new';

export interface PlanAdmissionInput {
  requirementId?: string;
  scopeKey: string;
  planRelation?: PlanAdmissionRelation;
  relatedPlanId?: string;
}

export interface PlanAdmissionResolution {
  admissionDecision: 'reuse_existing' | 'resolution_required' | 'extend_existing' | 'create_new';
  resolutionRequired: boolean;
  reason: PlanAdmissionReason;
  normalizedScopeKey: string;
  plan?: PlanContract;
  candidates: PlanContract[];
  allowedPlanRelations?: readonly PlanAdmissionRelation[];
}

export function normalizePlanScopeKey(value: string): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const normalized = sanitizeFileComponent(raw).toLowerCase().slice(0, 160);
  return normalized === 'unknown' ? '' : normalized;
}

export function resolvePlanAdmission(
  plans: readonly PlanContract[],
  input: PlanAdmissionInput,
): PlanAdmissionResolution {
  const activePlans = plans.filter((plan) => !isTerminalPlanContractStatus(plan.status));
  const normalizedScopeKey = normalizePlanScopeKey(input.scopeKey);
  const exactScopeAuthority = normalizedScopeKey
    ? activePlans.find((candidate) => candidate.scopeKey === normalizedScopeKey)
    : undefined;
  if (exactScopeAuthority) {
    return {
      admissionDecision: 'reuse_existing',
      resolutionRequired: false,
      reason: 'exact_scope_authority',
      normalizedScopeKey,
      plan: exactScopeAuthority,
      candidates: [exactScopeAuthority],
    };
  }

  const requirementId = input.requirementId?.trim() || undefined;
  const requirementPlans = requirementId
    ? activePlans.filter((candidate) => candidate.requirementId === requirementId)
    : [];
  const relatedPlanId = input.relatedPlanId?.trim() || undefined;
  const relatedPlan = relatedPlanId
    ? requirementPlans.find((candidate) => candidate.planId === relatedPlanId)
    : requirementPlans.length === 1 ? requirementPlans[0] : undefined;

  if (requirementPlans.length > 0 && !input.planRelation) {
    return {
      admissionDecision: 'resolution_required',
      resolutionRequired: true,
      reason: 'requirement_relation_required',
      normalizedScopeKey,
      candidates: requirementPlans.slice(0, 8),
      allowedPlanRelations: PLAN_ADMISSION_RELATIONS,
    };
  }

  if (requirementPlans.length > 0 && input.planRelation === 'extend') {
    if (!relatedPlan) {
      return {
        admissionDecision: 'resolution_required',
        resolutionRequired: true,
        reason: 'extension_target_required',
        normalizedScopeKey,
        candidates: requirementPlans.slice(0, 8),
        allowedPlanRelations: PLAN_ADMISSION_RELATIONS,
      };
    }
    return {
      admissionDecision: 'extend_existing',
      resolutionRequired: false,
      reason: 'extend_existing',
      normalizedScopeKey,
      plan: relatedPlan,
      candidates: requirementPlans.slice(0, 8),
    };
  }

  return {
    admissionDecision: 'create_new',
    resolutionRequired: false,
    reason: 'create_new',
    normalizedScopeKey,
    candidates: requirementPlans.slice(0, 8),
  };
}

/**
 * Short per-repository semantic admission critical section. The fixed task key
 * keeps admission independent from repository/worktree execution locks while
 * still coordinating competing controller processes for the same repository.
 */
const planAdmissionLockKey = (repoId: string) => ({
  scope: 'task' as const,
  repoId,
  taskId: 'semantic-plan-admission',
});

export function withPlanAdmissionLock<T>(
  options: { controllerHome?: string; repoId?: string },
  operation: () => T,
): T {
  if (!options.controllerHome?.trim() || !options.repoId?.trim()) return operation();
  return withControllerLock(
    options.controllerHome,
    planAdmissionLockKey(options.repoId),
    'semantic-plan-admission',
    operation,
  );
}

/** Gateway-facing admission waits briefly for a competing controller to finish
 * its tiny create/approve decision, then re-reads canonical state under lock. */
export async function withPlanAdmissionLockAsync<T>(
  options: { controllerHome?: string; repoId?: string },
  operation: () => T | Promise<T>,
): Promise<T> {
  if (!options.controllerHome?.trim() || !options.repoId?.trim()) return await operation();
  return await withControllerLockAsync(
    options.controllerHome,
    planAdmissionLockKey(options.repoId),
    'semantic-plan-admission',
    async () => await operation(),
    undefined,
    500,
  );
}
