import {
  REQUIREMENT_STATES,
  listRequirements,
  type Requirement,
  type RequirementState,
} from '../persistence/requirement-store';
import { isRepositoryCompletionReceipt } from './types';
import { listPlanContracts, summarizePlanContract } from './plan-contract-store';
import { listWorkContracts, summarizeWorkContract } from './work-contract-store';
import type { PlanContract, WorkContract } from './types';

const DEFAULT_REQUIREMENT_LIMIT = 12;
const DIAGNOSTIC_DETAIL_LIMIT = 20;
const DIAGNOSTIC_FULL_LIMIT = 40;

export interface RequirementBoardOptions {
  controllerHome: string;
  repoId?: string;
}

export interface RequirementBoardItem {
  requirementId: string;
  title: string;
  outcome: string;
  state: RequirementState;
  persistedState: RequirementState;
  needsAttention: boolean;
  maintenanceSummary?: string;
  blocker?: string;
  requiredUserDecision?: string;
  /** Compatibility projection for older UI clients; derived from activePlanIds. */
  activePlanId?: string;
  activePlanIds: string[];
  latestDelivery?: {
    workId: string;
    receiptId: string;
    targetBranch: string;
    targetRevision: string;
    deliveryStatus: string;
    cleanupStatus: string;
    recordedAt: string;
  };
  updatedAt: string;
  detailPointer: {
    tool: 'get_project_board';
    arguments: { detail_level: 'detail'; requirement_id: string };
  };
}

function boundedText(value: unknown, maxLength: number): string {
  return String(value ?? '').trim().slice(0, maxLength);
}

function explicitUserDecision(requirement: Requirement): string | undefined {
  if (requirement.state !== 'waiting_for_user') return undefined;
  const decision = boundedText(requirement.attentionSummary, 1_000);
  return decision || undefined;
}

function activePlansForRequirement(requirementId: string, plans: readonly PlanContract[]): PlanContract[] {
  return plans.filter((plan) => plan.requirementId === requirementId);
}

function projectedRequirementState(requirement: Requirement, activePlans: readonly PlanContract[]): RequirementState {
  if (requirement.state !== 'waiting_for_user') return requirement.state;
  if (explicitUserDecision(requirement)) return 'waiting_for_user';
  return activePlans.length > 0 ? 'active' : 'planned';
}

function loadScopedWork(options: RequirementBoardOptions): WorkContract[] {
  if (!options.repoId?.trim()) return [];
  return listWorkContracts({
    controllerHome: options.controllerHome,
    repoId: options.repoId,
    status: 'all',
    limit: 100,
  });
}

function latestDelivery(requirementId: string, work: readonly WorkContract[]): RequirementBoardItem['latestDelivery'] {
  const delivered = work
    .filter((contract) => contract.requirementId === requirementId && contract.completionReceipt)
    .sort((left, right) => {
      const leftAt = left.completionReceipt?.recordedAt ?? left.updatedAt;
      const rightAt = right.completionReceipt?.recordedAt ?? right.updatedAt;
      return rightAt.localeCompare(leftAt);
    })[0];
  const receipt = delivered?.completionReceipt;
  if (!delivered || !receipt || !isRepositoryCompletionReceipt(receipt)) return undefined;
  return {
    workId: delivered.workId,
    receiptId: receipt.receiptId,
    targetBranch: boundedText(receipt.targetBranch, 200),
    targetRevision: boundedText(receipt.targetRevision, 200),
    deliveryStatus: receipt.delivery.status,
    cleanupStatus: receipt.cleanup.status,
    recordedAt: receipt.recordedAt,
  };
}

function projectRequirement(requirement: Requirement, work: readonly WorkContract[], plans: readonly PlanContract[] = []): RequirementBoardItem {
  const activePlans = activePlansForRequirement(requirement.requirementId, plans);
  const activePlanIds = activePlans.map((plan) => plan.planId);
  const state = projectedRequirementState(requirement, activePlans);
  const requiredUserDecision = explicitUserDecision(requirement);
  const maintenanceSummary = requirement.needsAttention
    ? boundedText(requirement.attentionSummary, 1_000) || 'This Requirement has a maintenance finding.'
    : undefined;
  return {
    requirementId: requirement.requirementId,
    title: boundedText(requirement.title, 240),
    outcome: boundedText(requirement.outcomeStatement, 500),
    state,
    persistedState: requirement.state,
    needsAttention: requirement.needsAttention,
    maintenanceSummary,
    blocker: requirement.needsAttention && state !== 'waiting_for_user' ? maintenanceSummary : undefined,
    requiredUserDecision,
    activePlanId: activePlanIds[0],
    activePlanIds,
    latestDelivery: latestDelivery(requirement.requirementId, work),
    updatedAt: requirement.updatedAt,
    detailPointer: {
      tool: 'get_project_board',
      arguments: { detail_level: 'detail', requirement_id: requirement.requirementId },
    },
  };
}

function loadRequirements(options: RequirementBoardOptions): Requirement[] {
  return listRequirements({ controllerHome: options.controllerHome }, 500)
    .map((record) => record.value)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function requirementCounts(requirements: readonly RequirementBoardItem[]): Record<RequirementState, number> {
  const counts = Object.fromEntries(REQUIREMENT_STATES.map((state) => [state, 0])) as Record<RequirementState, number>;
  for (const requirement of requirements) counts[requirement.state] += 1;
  return counts;
}

export function buildRequirementBoard(options: RequirementBoardOptions): Record<string, unknown> {
  const work = loadScopedWork(options);
  const activePlans = options.repoId?.trim()
    ? listPlanContracts({ controllerHome: options.controllerHome, repoId: options.repoId, status: 'active', limit: 100 })
    : [];
  const allRequirements = loadRequirements(options).map((requirement) => projectRequirement(requirement, work, activePlans));
  const requirements = allRequirements.slice(0, DEFAULT_REQUIREMENT_LIMIT);
  const counts = requirementCounts(allRequirements);
  return {
    schemaVersion: 1,
    detailLevel: 'summary',
    view: 'requirement_board',
    requirementCount: allRequirements.length,
    counts,
    activeRequirementCount: counts.active + counts.waiting_for_user,
    waitingForUserCount: counts.waiting_for_user,
    needsAttentionCount: allRequirements.filter((requirement) => requirement.needsAttention).length,
    requirements,
    requirementTruncatedCount: Math.max(0, allRequirements.length - requirements.length),
    detailPointer: {
      tool: 'get_project_board',
      arguments: { detail_level: 'detail' },
    },
  };
}

function summarizeDiagnosticPlan(plan: PlanContract, detailLevel: 'detail' | 'full'): Record<string, unknown> {
  const stepLimit = detailLevel === 'full' ? 10 : 4;
  const evidenceLimit = detailLevel === 'full' ? 10 : 5;
  const steps = plan.steps.slice(0, stepLimit).map((step) => ({
    id: step.id,
    objective: boundedText(step.objective, 500),
    status: step.status,
    workId: step.workId,
    checks: step.checks.slice(0, 5),
    evidenceRefs: step.evidenceRefs.slice(0, evidenceLimit),
  }));
  return {
    ...summarizePlanContract(plan),
    evidenceRefs: plan.evidenceRefs.slice(0, evidenceLimit),
    evidenceTruncatedCount: Math.max(0, plan.evidenceRefs.length - evidenceLimit),
    steps,
    stepTruncatedCount: Math.max(0, plan.steps.length - steps.length),
  };
}

function summarizeDiagnosticWork(work: WorkContract): Record<string, unknown> {
  const checks = work.checkRefs.slice(-3).reverse().map((check) => ({
    checkId: check.checkId,
    outcome: check.outcome,
    summary: boundedText(check.summary, 500),
    sourceRevision: check.sourceRevision,
    recordedAt: check.recordedAt,
    resultArtifactId: check.resultArtifactId,
  }));
  const receipt = work.completionReceipt;
  const repositoryReceipt = receipt && isRepositoryCompletionReceipt(receipt) ? receipt : undefined;
  return {
    ...summarizeWorkContract(work),
    requirementId: work.requirementId,
    planId: work.planId,
    planStepId: work.planStepId,
    dispatchState: work.dispatchState,
    evidenceState: work.evidenceState,
    completionOutcome: work.completionOutcome,
    checks,
    checkTruncatedCount: Math.max(0, work.checkRefs.length - checks.length),
    completionReceipt: repositoryReceipt ? {
      receiptId: repositoryReceipt.receiptId,
      targetBranch: repositoryReceipt.targetBranch,
      targetRevision: repositoryReceipt.targetRevision,
      deliveryStatus: repositoryReceipt.delivery.status,
      cleanupStatus: repositoryReceipt.cleanup.status,
      recordedAt: repositoryReceipt.recordedAt,
    } : undefined,
    executionRefs: {
      workerRef: work.workerRef,
      worktreeRef: work.worktreeRef,
      handoffRefs: work.handoffRefs.slice(-3),
    },
    detailPointer: { tool: 'work_get', arguments: { work_id: work.workId, include_events: true } },
  };
}

export function buildExecutionDiagnostics(
  options: RequirementBoardOptions & { detailLevel: 'detail' | 'full'; requirementId?: string },
): Record<string, unknown> {
  const limit = options.detailLevel === 'full' ? DIAGNOSTIC_FULL_LIMIT : DIAGNOSTIC_DETAIL_LIMIT;
  const allWork = loadScopedWork(options);
  const allRequirements = loadRequirements(options);
  const selectedRequirements = options.requirementId
    ? allRequirements.filter((requirement) => requirement.requirementId === options.requirementId)
    : allRequirements;
  const requirementIds = new Set(selectedRequirements.map((requirement) => requirement.requirementId));
  const scopedWork = options.requirementId
    ? allWork.filter((work) => work.requirementId && requirementIds.has(work.requirementId))
    : allWork;
  const allPlans = options.repoId?.trim()
    ? listPlanContracts({ controllerHome: options.controllerHome, repoId: options.repoId, status: 'all', limit: 100 })
    : [];
  const scopedPlans = options.requirementId
    ? allPlans.filter((plan) => plan.requirementId === options.requirementId
      // Legacy migration compatibility only: current Plans own the forward
      // requirementId relation, so the persisted Requirement pointer is not an
      // execution/lifecycle authority.
      || (!plan.requirementId && selectedRequirements.some((requirement) => requirement.activePlanId === plan.planId)))
    : allPlans;
  const activePlans = allPlans.filter((plan) => !['finalized', 'superseded', 'cancelled', 'invalidated_by_drift'].includes(plan.status));
  const requirements = selectedRequirements.map((requirement) => projectRequirement(requirement, allWork, activePlans));
  const works = scopedWork.slice(0, limit).map(summarizeDiagnosticWork);
  const plans = scopedPlans.slice(0, limit).map((plan) => summarizeDiagnosticPlan(plan, options.detailLevel));
  const maintenanceFindings = requirements
    .filter((requirement) => requirement.needsAttention)
    .slice(0, limit)
    .map((requirement) => ({
      requirementId: requirement.requirementId,
      requirementState: requirement.state,
      summary: requirement.maintenanceSummary,
      lifecycleUnaffected: true,
      source: 'requirement_attention',
    }));
  const projectionWarnings = requirements
    .filter((requirement) => requirement.persistedState === 'waiting_for_user' && requirement.state !== 'waiting_for_user')
    .slice(0, limit)
    .map((requirement) => ({
      code: 'USER_DECISION_REQUIRED_TEXT_MISSING',
      requirementId: requirement.requirementId,
      summary: 'Persisted waiting_for_user was projected as planned/active because no explicit user decision was recorded.',
    }));
  return {
    schemaVersion: 1,
    detailLevel: options.detailLevel,
    view: 'execution_diagnostics',
    repositoryScope: options.repoId,
    requirementFilter: options.requirementId,
    requirementCount: requirements.length,
    requirements: requirements.slice(0, limit),
    requirementTruncatedCount: Math.max(0, requirements.length - limit),
    planCount: scopedPlans.length,
    plans,
    planTruncatedCount: Math.max(0, scopedPlans.length - plans.length),
    workCount: scopedWork.length,
    works,
    workTruncatedCount: Math.max(0, scopedWork.length - works.length),
    maintenanceFindings,
    maintenanceFindingTruncatedCount: Math.max(0, requirements.filter((requirement) => requirement.needsAttention).length - maintenanceFindings.length),
    projectionWarnings,
    technicalDetailPointers: [
      { tool: 'work_list', arguments: { limit: 50 } },
      { tool: 'controller_ready', arguments: {} },
      { tool: 'workflow_watchdog_report', arguments: { include_processes: true } },
      { tool: 'get_project_governance', arguments: {} },
    ],
  };
}
