import type { EngineeringMutationClass } from './engineering-design';
import type { WorkContract } from './types';

export type WorkExecutionLane = 'read' | 'review' | 'isolated_write' | 'integration_write' | 'external_effect';
export type WorkExecutionIsolation = 'shared' | 'isolated';
export type WorkExecutionControllerRole = 'mutable_owner' | 'reviewer';
export type WorkExecutionResourceMode = 'read' | 'write' | 'exclusive';

export interface WorkExecutionResourceIntent {
  resourceKey: string;
  mode: WorkExecutionResourceMode;
}

export type WorkExecutionWakeTrigger =
  | { kind: 'work_terminal'; workId: string }
  | { kind: 'resource_release'; resourceKeys: string[] }
  | { kind: 'controller_release'; workId: string }
  | { kind: 'scheduler_capacity'; capacityKey: string }
  | { kind: 'work_contract_change'; workId: string };

export interface WorkExecutionConcurrencyBlocker {
  code:
    | 'reviewer_mutation_forbidden'
    | 'same_semantic_scope_mutation'
    | 'shared_mutation_lane_conflict'
    | 'integration_target_conflict'
    | 'external_effect_target_conflict'
    | 'external_effect_target_unknown';
  disposition: 'wait' | 'invalid';
  blockingWorkId?: string;
  semanticScopeKeys: string[];
  resourceKeys: string[];
  wakeTrigger: WorkExecutionWakeTrigger;
}

export interface WorkExecutionConcurrencyContract {
  schemaVersion: 1;
  workId: string;
  sourceRevision?: string;
  observedWorkUpdatedAt: string;
  semanticScopeKeys: string[];
  mutationClass: EngineeringMutationClass;
  lane: WorkExecutionLane;
  resourceIntents: WorkExecutionResourceIntent[];
  blockers: WorkExecutionConcurrencyBlocker[];
  isolation: WorkExecutionIsolation;
  controllerRole: WorkExecutionControllerRole;
}

export interface WorkExecutionConcurrencyInput {
  lane?: WorkExecutionLane;
  resourceIntents?: readonly WorkExecutionResourceIntent[];
  blockers?: readonly WorkExecutionConcurrencyBlocker[];
}

export interface WorkExecutionCompatibilityDecision {
  compatible: boolean;
  blockers: WorkExecutionConcurrencyBlocker[];
}

function normalizedStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function normalizedResourceIntents(values: readonly WorkExecutionResourceIntent[]): WorkExecutionResourceIntent[] {
  const byIdentity = new Map<string, WorkExecutionResourceIntent>();
  for (const value of values) {
    const resourceKey = value.resourceKey.trim();
    if (!resourceKey) continue;
    const identity = `${resourceKey}\u0000${value.mode}`;
    byIdentity.set(identity, { resourceKey, mode: value.mode });
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.resourceKey.localeCompare(right.resourceKey) || left.mode.localeCompare(right.mode));
}

function fallbackMutationClass(work: WorkContract): EngineeringMutationClass {
  if (work.workKind === 'read_only_review'
    || work.workKind === 'investigation'
    || work.workKind === 'completed_no_change'
    || work.workKind === 'reconciliation'
    || work.workKind === 'superseded') return 'readonly';
  if (work.workKind === 'local_effect' || work.workKind === 'remote_effect') return 'external_effect';
  if (work.worktreePolicy.required || work.constraints.workspaceMode === 'isolated' || work.constraints.requireWorktree === true) {
    return 'isolated_write';
  }
  return 'integration_write';
}

function semanticScopeKeys(work: WorkContract): string[] {
  const declared = normalizedStrings(work.engineeringContext?.semanticScope?.keys ?? []);
  if (declared.length > 0) return declared;
  if (work.planId?.trim() && work.planStepId?.trim()) return [`plan-step:${work.planId.trim()}:${work.planStepId.trim()}`];
  return [`work:${work.workId}`];
}

function defaultLane(work: WorkContract, mutationClass: EngineeringMutationClass): WorkExecutionLane {
  if (work.workKind === 'read_only_review') return 'review';
  if (mutationClass === 'readonly') return 'read';
  return mutationClass;
}

export function buildWorkExecutionConcurrencyContract(
  work: WorkContract,
  input: WorkExecutionConcurrencyInput = {},
): WorkExecutionConcurrencyContract {
  const mutationClass = work.engineeringContext?.semanticScope?.mutationClass ?? fallbackMutationClass(work);
  return {
    schemaVersion: 1,
    workId: work.workId,
    sourceRevision: work.baseRevision ?? work.planSourceRevision,
    observedWorkUpdatedAt: work.updatedAt,
    semanticScopeKeys: semanticScopeKeys(work),
    mutationClass,
    lane: input.lane ?? defaultLane(work, mutationClass),
    resourceIntents: normalizedResourceIntents(input.resourceIntents ?? []),
    blockers: [...(input.blockers ?? [])],
    isolation: work.worktreePolicy.required || work.constraints.workspaceMode === 'isolated' || work.constraints.requireWorktree === true
      ? 'isolated'
      : 'shared',
    controllerRole: work.workKind === 'read_only_review' ? 'reviewer' : 'mutable_owner',
  };
}

export function workExecutionLaneMutates(lane: WorkExecutionLane): boolean {
  return lane === 'isolated_write' || lane === 'integration_write' || lane === 'external_effect';
}

function scopesOverlap(left: WorkExecutionConcurrencyContract, right: WorkExecutionConcurrencyContract): string[] {
  const rightKeys = new Set(right.semanticScopeKeys);
  return left.semanticScopeKeys.filter((key) => rightKeys.has(key));
}

function mutableResourceKeys(contract: WorkExecutionConcurrencyContract): string[] {
  return normalizedStrings(contract.resourceIntents
    .filter((intent) => intent.mode !== 'read')
    .map((intent) => intent.resourceKey));
}

function sharedMutableResourceKeys(
  left: WorkExecutionConcurrencyContract,
  right: WorkExecutionConcurrencyContract,
): string[] {
  const rightKeys = new Set(mutableResourceKeys(right));
  return mutableResourceKeys(left).filter((key) => rightKeys.has(key));
}

function invalidReviewerBlocker(contract: WorkExecutionConcurrencyContract): WorkExecutionConcurrencyBlocker | undefined {
  if (contract.controllerRole !== 'reviewer'
    || (!workExecutionLaneMutates(contract.lane) && mutableResourceKeys(contract).length === 0)) return undefined;
  return {
    code: 'reviewer_mutation_forbidden',
    disposition: 'invalid',
    semanticScopeKeys: contract.semanticScopeKeys,
    resourceKeys: mutableResourceKeys(contract),
    wakeTrigger: { kind: 'work_contract_change', workId: contract.workId },
  };
}

export function evaluateWorkExecutionCompatibility(
  candidate: WorkExecutionConcurrencyContract,
  active: readonly WorkExecutionConcurrencyContract[],
): WorkExecutionCompatibilityDecision {
  const blockers: WorkExecutionConcurrencyBlocker[] = [];
  const reviewerBlocker = invalidReviewerBlocker(candidate);
  if (reviewerBlocker) blockers.push(reviewerBlocker);
  if (candidate.lane === 'external_effect' && mutableResourceKeys(candidate).length === 0) {
    blockers.push({
      code: 'external_effect_target_unknown',
      disposition: 'invalid',
      semanticScopeKeys: candidate.semanticScopeKeys,
      resourceKeys: [],
      wakeTrigger: { kind: 'work_contract_change', workId: candidate.workId },
    });
  }
  if (blockers.length > 0) return { compatible: false, blockers };
  if (!workExecutionLaneMutates(candidate.lane)) return { compatible: true, blockers: [] };

  for (const current of active) {
    if (current.workId === candidate.workId) continue;
    const currentReviewerBlocker = invalidReviewerBlocker(current);
    if (currentReviewerBlocker) continue;
    if (!workExecutionLaneMutates(current.lane)) continue;

    const overlap = scopesOverlap(candidate, current);
    if (overlap.length > 0) {
      blockers.push({
        code: 'same_semantic_scope_mutation',
        disposition: 'wait',
        blockingWorkId: current.workId,
        semanticScopeKeys: overlap,
        resourceKeys: [],
        wakeTrigger: { kind: 'work_terminal', workId: current.workId },
      });
      continue;
    }

    if (candidate.lane === 'isolated_write' && current.lane === 'isolated_write'
      && candidate.isolation === 'isolated' && current.isolation === 'isolated') continue;

    if (candidate.lane === 'external_effect' || current.lane === 'external_effect') {
      const candidateTargets = mutableResourceKeys(candidate);
      const currentTargets = mutableResourceKeys(current);
      // An active Work without an executing target does not own a remote-effect
      // resource yet. Same semantic scope was already handled above; physical
      // target conflicts start only once the active Work has declared claims.
      if (current.lane === 'external_effect' && currentTargets.length === 0) continue;
      const sharedTargets = sharedMutableResourceKeys(candidate, current);
      if (sharedTargets.length > 0) {
        blockers.push({
          code: 'external_effect_target_conflict',
          disposition: 'wait',
          blockingWorkId: current.workId,
          semanticScopeKeys: [],
          resourceKeys: sharedTargets,
          wakeTrigger: { kind: 'resource_release', resourceKeys: sharedTargets },
        });
      }
      continue;
    }

    if (candidate.lane === 'integration_write' || current.lane === 'integration_write') {
      const sharedTargets = sharedMutableResourceKeys(candidate, current);
      if (sharedTargets.length > 0) {
        blockers.push({
          code: 'integration_target_conflict',
          disposition: 'wait',
          blockingWorkId: current.workId,
          semanticScopeKeys: [],
          resourceKeys: sharedTargets,
          wakeTrigger: { kind: 'resource_release', resourceKeys: sharedTargets },
        });
        continue;
      }
      if (candidate.isolation === 'shared' || current.isolation === 'shared') {
        blockers.push({
          code: 'shared_mutation_lane_conflict',
          disposition: 'wait',
          blockingWorkId: current.workId,
          semanticScopeKeys: [],
          resourceKeys: [],
          wakeTrigger: { kind: 'work_terminal', workId: current.workId },
        });
      }
    }
  }

  return { compatible: blockers.length === 0, blockers };
}
