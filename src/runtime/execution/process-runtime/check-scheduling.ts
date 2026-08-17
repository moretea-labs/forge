import type { ControllerCheck } from '../../../cli/controller/check-runner';
import type { ResourceClaimSpec } from '../jobs/types';
import { resourceClaimsConflict } from '../../resources/claims/conflicts';
import { claimsForCheck } from './resource-claims';

export interface CheckExecutionWave {
  wave: number;
  checkIds: string[];
  parallelSafe: boolean;
}

export interface CheckExecutionConflict {
  leftCheckId: string;
  rightCheckId: string;
  resources: Array<{
    left: Pick<ResourceClaimSpec, 'resourceKey' | 'mode'>;
    right: Pick<ResourceClaimSpec, 'resourceKey' | 'mode'>;
  }>;
}

interface ScheduledCheck {
  check: ControllerCheck;
  claims: ResourceClaimSpec[];
}

function conflictingResources(left: ScheduledCheck, right: ScheduledCheck): CheckExecutionConflict['resources'] {
  const conflicts: CheckExecutionConflict['resources'] = [];
  for (const leftClaim of left.claims) {
    for (const rightClaim of right.claims) {
      if (!resourceClaimsConflict(leftClaim, rightClaim)) continue;
      conflicts.push({
        left: { resourceKey: leftClaim.resourceKey, mode: leftClaim.mode },
        right: { resourceKey: rightClaim.resourceKey, mode: rightClaim.mode },
      });
    }
  }
  return conflicts;
}

/**
 * Produce deterministic execution waves from the exact same resource-claim model
 * used by Process Runtime. Checks in one wave may overlap; waves run in order.
 * This is advisory scheduling metadata, not a second lease authority.
 */
export function buildCheckExecutionSchedule(input: {
  checks: ControllerCheck[];
  requestedCheckIds: string[];
  repoId: string;
  checkoutId?: string;
}): {
  waves: CheckExecutionWave[];
  conflicts: CheckExecutionConflict[];
  invalidCheckIds: string[];
  maxParallel: number;
  guidance: string[];
  claimsByCheck: Array<{ checkId: string; claims: Array<Pick<ResourceClaimSpec, 'resourceKey' | 'mode'>> }>;
} {
  const byId = new Map(input.checks.map((check) => [check.id, check]));
  const requested = [...new Set(input.requestedCheckIds.filter(Boolean))];
  const invalidCheckIds = requested.filter((checkId) => !byId.has(checkId));
  const scheduled: ScheduledCheck[] = requested.flatMap((checkId) => {
    const check = byId.get(checkId);
    if (!check) return [];
    return [{
      check,
      claims: claimsForCheck(check.id, check.command, input.repoId, input.checkoutId, check.effects),
    }];
  });

  const conflicts: CheckExecutionConflict[] = [];
  for (let leftIndex = 0; leftIndex < scheduled.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < scheduled.length; rightIndex += 1) {
      const left = scheduled[leftIndex]!;
      const right = scheduled[rightIndex]!;
      const resources = conflictingResources(left, right);
      if (resources.length === 0) continue;
      conflicts.push({ leftCheckId: left.check.id, rightCheckId: right.check.id, resources });
    }
  }

  const waves: ScheduledCheck[][] = [];
  for (const entry of scheduled) {
    const compatible = waves.find((wave) => wave.every((other) => conflictingResources(entry, other).length === 0));
    if (compatible) compatible.push(entry);
    else waves.push([entry]);
  }

  const projectedWaves = waves.map((wave, index) => ({
    wave: index + 1,
    checkIds: wave.map((entry) => entry.check.id),
    parallelSafe: wave.length > 1,
  }));
  const maxParallel = projectedWaves.reduce((max, wave) => Math.max(max, wave.checkIds.length), 0);
  const guidance: string[] = [];
  if (projectedWaves.length > 1) {
    guidance.push('Run check waves in order; only checks within the same wave are resource-compatible for overlap.');
  } else if (maxParallel > 1) {
    guidance.push('Requested checks are resource-compatible and may run concurrently for this checkout.');
  } else if (maxParallel === 1) {
    guidance.push('Run the requested check as one focused verification unit.');
  }

  return {
    waves: projectedWaves,
    conflicts,
    invalidCheckIds,
    maxParallel,
    guidance,
    claimsByCheck: scheduled.map((entry) => ({
      checkId: entry.check.id,
      claims: entry.claims.map((claim) => ({ resourceKey: claim.resourceKey, mode: claim.mode })),
    })),
  };
}
