import {
  REQUIREMENT_STATES,
  isLegacyMachineRequirementWait,
  type Requirement,
  type RequirementState,
} from '../persistence/requirement-store';
import { listRequirementsForRepository } from './requirement-authority';
import { listPlanContracts, summarizePlanContract } from './plan-contract-store';
import type { PlanContract } from './types';

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
  progressSummary: string;
  remainingWork: string[];
  acceptedEvidenceRefs: string[];
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
  // Historical machine completion could project a wait state. Preserve only a
  // real human decision request; Work is never consulted as current authority.
  if (isLegacyMachineRequirementWait(requirement)) return undefined;
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

function projectRequirement(requirement: Requirement, plans: readonly PlanContract[] = []): RequirementBoardItem {
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
    progressSummary: boundedText(requirement.progressSummary, 1_000),
    remainingWork: (requirement.remainingWork ?? []).slice(0, 20).map((entry) => boundedText(entry, 500)),
    acceptedEvidenceRefs: (requirement.acceptedEvidenceRefs ?? []).slice(-20).map((entry) => boundedText(entry, 512)),
    updatedAt: requirement.updatedAt,
    detailPointer: {
      tool: 'get_project_board',
      arguments: { detail_level: 'detail', requirement_id: requirement.requirementId },
    },
  };
}

function loadRequirements(options: RequirementBoardOptions): Requirement[] {
  return listRequirementsForRepository(
    { controllerHome: options.controllerHome },
    options.repoId,
    500,
  )
    .map((record) => record.value)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function requirementCounts(requirements: readonly RequirementBoardItem[]): Record<RequirementState, number> {
  const counts = Object.fromEntries(REQUIREMENT_STATES.map((state) => [state, 0])) as Record<RequirementState, number>;
  for (const requirement of requirements) counts[requirement.state] += 1;
  return counts;
}

export function buildRequirementBoard(options: RequirementBoardOptions): Record<string, unknown> {
  const activePlans = options.repoId?.trim()
    ? listPlanContracts({ controllerHome: options.controllerHome, repoId: options.repoId, status: 'active', limit: 100 })
    : [];
  const allRequirements = loadRequirements(options).map((requirement) => projectRequirement(requirement, activePlans));
  const requirements = allRequirements.slice(0, DEFAULT_REQUIREMENT_LIMIT);
  const counts = requirementCounts(allRequirements);
  return {
    schemaVersion: 2,
    detailLevel: 'summary',
    view: 'requirement_board',
    authority: 'semantic_context_only',
    progressAuthority: 'github_issue_project',
    requirementCount: allRequirements.length,
    counts,
    activeRequirementCount: counts.active + counts.waiting_for_user,
    waitingForUserCount: counts.waiting_for_user,
    needsAttentionCount: allRequirements.filter((requirement) => requirement.needsAttention).length,
    requirements,
    requirementTruncatedCount: Math.max(0, allRequirements.length - requirements.length),
    historicalWorkProjection: 'retired_not_projected',
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

export function buildExecutionDiagnostics(
  options: RequirementBoardOptions & { detailLevel: 'detail' | 'full'; requirementId?: string },
): Record<string, unknown> {
  const limit = options.detailLevel === 'full' ? DIAGNOSTIC_FULL_LIMIT : DIAGNOSTIC_DETAIL_LIMIT;
  const allRequirements = loadRequirements(options);
  const selectedRequirements = options.requirementId
    ? allRequirements.filter((requirement) => requirement.requirementId === options.requirementId)
    : allRequirements;
  const allPlans = options.repoId?.trim()
    ? listPlanContracts({ controllerHome: options.controllerHome, repoId: options.repoId, status: 'all', limit: 100 })
    : [];
  const scopedPlans = options.requirementId
    ? allPlans.filter((plan) => plan.requirementId === options.requirementId
      || (!plan.requirementId && selectedRequirements.some((requirement) => requirement.activePlanId === plan.planId)))
    : allPlans;
  const activePlans = allPlans.filter((plan) => !['finalized', 'superseded', 'cancelled', 'invalidated_by_drift'].includes(plan.status));
  const requirements = selectedRequirements.map((requirement) => projectRequirement(requirement, activePlans));
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
    schemaVersion: 2,
    detailLevel: options.detailLevel,
    view: 'execution_diagnostics',
    authority: 'runtime_and_semantic_context',
    progressAuthority: 'github_issue_project',
    repositoryScope: options.repoId,
    requirementFilter: options.requirementId,
    requirementCount: requirements.length,
    requirements: requirements.slice(0, limit),
    requirementTruncatedCount: Math.max(0, requirements.length - limit),
    planCount: scopedPlans.length,
    plans,
    planTruncatedCount: Math.max(0, scopedPlans.length - plans.length),
    historicalWorkProjection: 'retired_not_projected',
    maintenanceFindings,
    maintenanceFindingTruncatedCount: Math.max(0, requirements.filter((requirement) => requirement.needsAttention).length - maintenanceFindings.length),
    projectionWarnings,
    technicalDetailPointers: [
      { tool: 'rh_context', arguments: { operation: 'list', detail_level: 'detail' } },
      { tool: 'controller_ready', arguments: {} },
      { tool: 'workflow_watchdog_report', arguments: { include_processes: true } },
      { tool: 'get_project_governance', arguments: {} },
    ],
  };
}
