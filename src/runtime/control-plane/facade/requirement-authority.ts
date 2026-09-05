import {
  createRequirement,
  readRequirement,
  updateRequirement,
  type CreateRequirementInput,
  type Requirement,
  type RequirementStoreOptions,
} from '../persistence/requirement-store';
import { readPlanContractStore } from './plan-contract-store';
import { withPlanAdmissionLock } from './semantic-admission';
import {
  getControllerRoundRelay,
  submitControllerRoundDisposition,
  type ControllerRoundRelayRecord,
  type SubmitControllerRoundDispositionInput,
} from '../../../../packages/kernel/controller/api/index';
import { getWorkContract } from '../../../../packages/kernel/work/api/index';

export type RequirementAdmissionDecision = 'created' | 'reuse_existing' | 'existing_conflict';

export interface RequirementAdmissionResult {
  decision: RequirementAdmissionDecision;
  requirement: Requirement;
  created: boolean;
}

function bounded(values: readonly string[] | undefined, limit: number, maxLength = 500): string[] {
  return (values ?? [])
    .map((value) => String(value).trim())
    .filter(Boolean)
    .slice(0, limit)
    .map((value) => value.slice(0, maxLength));
}

/**
 * Canonical Requirement bootstrap request. Persistence performs the same
 * defensive bounds before writing, but create/reuse/conflict admission lives
 * only here so MCP/CLI adapters cannot grow their own Requirement lifecycle.
 */
export function normalizeRequirementAdmissionInput(input: CreateRequirementInput): CreateRequirementInput {
  const requirementId = String(input.requirementId ?? '').trim();
  if (!requirementId || requirementId.includes('/') || requirementId.includes('\\')) throw new Error('REQUIREMENT_ID_INVALID');
  const normalized: CreateRequirementInput = {
    requirementId: requirementId.slice(0, 160),
    title: String(input.title ?? '').trim().slice(0, 500),
    outcomeStatement: String(input.outcomeStatement ?? '').trim().slice(0, 2_000),
    acceptanceCriteria: bounded(input.acceptanceCriteria, 50),
    requiredDeliveryReferences: bounded(input.requiredDeliveryReferences, 50),
    legacyAliases: bounded(input.legacyAliases, 20, 160),
  };
  if (!normalized.title || !normalized.outcomeStatement) throw new Error('REQUIREMENT_CONTENT_REQUIRED');
  return normalized;
}

function sameBootstrapIdentity(existing: Requirement, requested: CreateRequirementInput): boolean {
  return existing.requirementId === requested.requirementId
    && existing.title === requested.title
    && existing.outcomeStatement === requested.outcomeStatement
    && JSON.stringify(existing.acceptanceCriteria) === JSON.stringify(requested.acceptanceCriteria ?? [])
    && JSON.stringify(existing.requiredDeliveryReferences) === JSON.stringify(requested.requiredDeliveryReferences ?? [])
    && JSON.stringify(existing.legacyAliases) === JSON.stringify(requested.legacyAliases ?? []);
}

function existingDecision(existing: Requirement, requested: CreateRequirementInput): RequirementAdmissionResult {
  return {
    decision: sameBootstrapIdentity(existing, requested) ? 'reuse_existing' : 'existing_conflict',
    requirement: existing,
    created: false,
  };
}

/**
 * Sole bootstrap admission authority for Requirement identity. A create race is
 * closed by rereading the winner and applying the same identity comparison;
 * adapters therefore never need read/compare/create policy of their own.
 */
export function admitRequirement(
  options: RequirementStoreOptions,
  input: CreateRequirementInput,
): RequirementAdmissionResult {
  const requested = normalizeRequirementAdmissionInput(input);
  const existing = readRequirement(options, requested.requirementId)?.value;
  if (existing) return existingDecision(existing, requested);

  try {
    return { decision: 'created', requirement: createRequirement(options, requested), created: true };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('REQUIREMENT_ALREADY_EXISTS:')) throw error;
    const raced = readRequirement(options, requested.requirementId)?.value;
    if (!raced) throw error;
    return existingDecision(raced, requested);
  }
}


export interface RequirementContinueResult {
  requirement: Requirement;
  resumed: boolean;
}

/**
 * Canonical explicit semantic continue for a Requirement that is waiting on
 * ChatGPT/user judgement. Persistence owns transition legality; this facade
 * owns the semantic meaning so adapters and launchers never mutate Requirement
 * state directly.
 */
export function continueRequirement(
  options: RequirementStoreOptions,
  requirementId: string,
): RequirementContinueResult {
  const normalizedId = String(requirementId ?? '').trim();
  const current = readRequirement(options, normalizedId)?.value;
  if (!current) throw new Error(`REQUIREMENT_NOT_FOUND: ${normalizedId}`);
  if (current.state === 'active') return { requirement: current, resumed: false };
  if (current.state === 'done' || current.state === 'cancelled') {
    throw new Error(`REQUIREMENT_TERMINAL: ${current.requirementId}:${current.state}`);
  }
  if (current.state !== 'waiting_for_user') {
    throw new Error(`REQUIREMENT_CONTINUE_NOT_WAITING: ${current.requirementId}:${current.state}`);
  }

  const requirement = updateRequirement(options, {
    requirementId: current.requirementId,
    action: 'requirement_semantic_continue',
    mutate: (latest) => {
      if (latest.state === 'active') return latest;
      if (latest.state === 'done' || latest.state === 'cancelled') {
        throw new Error(`REQUIREMENT_TERMINAL: ${latest.requirementId}:${latest.state}`);
      }
      if (latest.state !== 'waiting_for_user') {
        throw new Error(`REQUIREMENT_CONTINUE_NOT_WAITING: ${latest.requirementId}:${latest.state}`);
      }
      return {
        ...latest,
        state: 'active',
        needsAttention: false,
        attentionSummary: undefined,
      };
    },
  });
  return { requirement, resumed: true };
}

export interface RequirementAcceptanceResult {
  requirement: Requirement;
  accepted: boolean;
  finalizedPlanIds: string[];
}

export interface RequirementAcceptanceReadiness {
  requirement: Requirement;
  finalizedPlanIds: string[];
}

function requirementAcceptanceContext(
  options: RequirementStoreOptions & { repoId: string },
  input: { requirementId: string; workId: string; reviewer: string; rationale: string },
): RequirementAcceptanceReadiness {
  const requirementId = String(input.requirementId ?? '').trim();
  const workId = String(input.workId ?? '').trim();
  const reviewer = String(input.reviewer ?? '').trim();
  const rationale = String(input.rationale ?? '').trim();
  if (!requirementId) throw new Error('REQUIREMENT_ACCEPTANCE_ID_REQUIRED');
  if (!workId) throw new Error('REQUIREMENT_ACCEPTANCE_WORK_REQUIRED');
  if (!reviewer || !rationale) throw new Error('REQUIREMENT_ACCEPTANCE_METADATA_REQUIRED');

  const current = readRequirement(options, requirementId)?.value;
  if (!current) throw new Error(`REQUIREMENT_NOT_FOUND: ${requirementId}`);
  if (current.state === 'cancelled') throw new Error(`REQUIREMENT_TERMINAL: ${requirementId}:cancelled`);
  if (current.state === 'planned') throw new Error(`REQUIREMENT_ACCEPTANCE_NOT_ACTIVE: ${requirementId}:planned`);
  if (current.state === 'done') {
    return { requirement: current, finalizedPlanIds: current.semanticAcceptance?.planIds ?? [] };
  }

  const currentPlans = readPlanContractStore({ controllerHome: options.controllerHome, repoId: options.repoId, now: options.now })
    .contracts
    .filter((plan) => plan.requirementId === requirementId && !plan.supersededBy?.trim() && plan.status !== 'superseded');
  const incomplete = currentPlans.filter((plan) => plan.status !== 'finalized');
  if (incomplete.length > 0) {
    throw new Error(`REQUIREMENT_ACCEPTANCE_PLAN_INCOMPLETE: ${incomplete.map((plan) => `${plan.planId}:${plan.status}`).join(',')}`);
  }
  const work = getWorkContract({ controllerHome: options.controllerHome, repoId: options.repoId }, workId);
  if (!work) throw new Error(`REQUIREMENT_ACCEPTANCE_WORK_NOT_FOUND: ${workId}`);
  if (work.requirementId !== requirementId) throw new Error(`REQUIREMENT_ACCEPTANCE_WORK_MISMATCH: ${workId}:${work.requirementId ?? 'none'}:${requirementId}`);
  if (work.status !== 'completed') throw new Error(`REQUIREMENT_ACCEPTANCE_WORK_NOT_COMPLETED: ${workId}:${work.status}`);
  return { requirement: current, finalizedPlanIds: currentPlans.map((plan) => plan.planId).sort() };
}

function acceptRequirementOutcomeUnlocked(
  options: RequirementStoreOptions & { repoId: string },
  input: { requirementId: string; workId: string; reviewer: string; rationale: string },
): RequirementAcceptanceResult {
  const context = requirementAcceptanceContext(options, input);
  const requirementId = context.requirement.requirementId;
  const reviewer = String(input.reviewer ?? '').trim();
  const rationale = String(input.rationale ?? '').trim();
  const relay = getControllerRoundRelay({ controllerHome: options.controllerHome, repoId: options.repoId }, input.workId);
  if (!relay) throw new Error(`REQUIREMENT_ACCEPTANCE_GOAL_COMPLETE_REQUIRED: ${input.workId}:missing_relay`);
  if (relay.originWorkId !== input.workId
    || relay.requirementId !== requirementId
    || relay.disposition !== 'goal_complete'
    || relay.status !== 'goal_complete') {
    throw new Error(`REQUIREMENT_ACCEPTANCE_GOAL_COMPLETE_REQUIRED: ${input.workId}:${relay.status}:${relay.disposition}`);
  }
  if (relay.principalId !== reviewer) {
    throw new Error(`REQUIREMENT_ACCEPTANCE_CONTROLLER_MISMATCH: ${input.workId}:${relay.principalId}:${reviewer}`);
  }
  if (context.requirement.state === 'done') {
    return { requirement: context.requirement, accepted: false, finalizedPlanIds: context.finalizedPlanIds };
  }

  const acceptedAt = options.now?.() ?? new Date().toISOString();
  let accepted = false;
  const requirement = updateRequirement(options, {
    requirementId,
    action: 'requirement_semantic_acceptance',
    mutate: (latest) => {
      if (latest.state === 'done') return latest;
      if (latest.state === 'cancelled') throw new Error(`REQUIREMENT_TERMINAL: ${requirementId}:cancelled`);
      if (latest.state === 'planned') throw new Error(`REQUIREMENT_ACCEPTANCE_NOT_ACTIVE: ${requirementId}:planned`);
      accepted = true;
      return {
        ...latest,
        state: 'done',
        needsAttention: false,
        attentionSummary: undefined,
        semanticAcceptance: {
          reviewer: reviewer.slice(0, 256),
          rationale: rationale.slice(0, 2_000),
          planIds: context.finalizedPlanIds,
          acceptedAt,
        },
      };
    },
  });
  return { requirement, accepted, finalizedPlanIds: context.finalizedPlanIds };
}

/**
 * Canonical explicit semantic acceptance for a Requirement. Direct callers are
 * serialized with Plan admission so Requirement completion cannot race a new
 * current Plan slice into existence.
 */
export function acceptRequirementOutcome(
  options: RequirementStoreOptions & { repoId: string },
  input: { requirementId: string; workId: string; reviewer: string; rationale: string },
): RequirementAcceptanceResult {
  return withPlanAdmissionLock(options, () => acceptRequirementOutcomeUnlocked(options, input));
}

export interface RequirementGoalCompletionResult {
  relay: ControllerRoundRelayRecord;
  requirementAcceptance: RequirementAcceptanceResult;
}

/**
 * One Goal application boundary for Requirement-bound goal_complete. The same
 * short semantic lock used by Plan admission covers readiness, ControllerRound
 * disposition persistence, and Requirement acceptance. A retry reuses an
 * already-recorded goal_complete relay and repairs only the missing Requirement
 * projection; no second ControllerRound or Plan authority is created.
 */
export function completeRequirementGoal(
  options: RequirementStoreOptions & { repoId: string },
  input: Omit<SubmitControllerRoundDispositionInput, 'disposition' | 'requirementId' | 'reason'> & {
    requirementId: string;
    rationale: string;
  },
): RequirementGoalCompletionResult {
  return withPlanAdmissionLock(options, () => {
    const reviewer = input.identity.principalId.trim();
    const readinessInput = {
      requirementId: input.requirementId,
      workId: input.workId,
      reviewer,
      rationale: input.rationale,
    };
    requirementAcceptanceContext(options, readinessInput);

    const existing = getControllerRoundRelay(options, input.workId);
    let relay: ControllerRoundRelayRecord;
    if (existing?.status === 'goal_complete' && existing.disposition === 'goal_complete') {
      relay = existing;
    } else {
      try {
        relay = submitControllerRoundDisposition(options, {
          ...input,
          disposition: 'goal_complete',
          requirementId: input.requirementId,
          reason: input.rationale,
        });
      } catch (error) {
        const raced = getControllerRoundRelay(options, input.workId);
        if (!raced || raced.status !== 'goal_complete' || raced.disposition !== 'goal_complete') throw error;
        relay = raced;
      }
    }
    const requirementAcceptance = acceptRequirementOutcomeUnlocked(options, readinessInput);
    return { relay, requirementAcceptance };
  });
}
