import {
  buildWorkExecutionConcurrencyContract,
  evaluateWorkExecutionCompatibility,
  getWorkContract,
  isTerminalWorkContractStatus,
  listWorkContracts,
  readActiveWorkCandidates,
  workExecutionLaneMutates,
  updateWorkContract,
  type WorkExecutionConcurrencyBlocker,
  type WorkExecutionConcurrencyContract,
  type WorkExecutionLane,
  type WorkExecutionResourceIntent,
  type WorkExecutionConcurrencyProjection,
} from '../../../../packages/kernel/work/api/index';
import type { ResourceClaimSpec } from '../../execution/jobs/types';
import { listProcessRecords } from '../../execution/process-runtime/store';
import { listActiveLeases } from '../../resources/leases/store';
import { claimsConflict } from '../../resources/claims/conflicts';
import { getControllerSession } from '../../../../packages/kernel/controller/api/index';
import {
  isManagedProcessActive,
  type ExecutionConcurrencyWaitProjection,
  type ManagedProcessRecord,
  type ProcessResourceClaim,
} from '../../execution/process-runtime/types';

function intents(claims: readonly Pick<ResourceClaimSpec, 'resourceKey' | 'mode'>[]): WorkExecutionResourceIntent[] {
  return claims.map((claim) => ({ resourceKey: claim.resourceKey, mode: claim.mode }));
}

function laneForProcess(record: Pick<ManagedProcessRecord, 'checkExecution' | 'origin'>, fallback?: WorkExecutionLane): WorkExecutionLane | undefined {
  if (record.checkExecution || record.origin?.surface === 'check') return 'read';
  return fallback;
}

function blockerProjection(
  blocker: WorkExecutionConcurrencyBlocker,
  source: ExecutionConcurrencyWaitProjection['source'] = 'work_compatibility',
): ExecutionConcurrencyWaitProjection {
  return {
    schemaVersion: 1,
    source,
    blockerCode: blocker.code,
    disposition: blocker.disposition,
    blockingWorkId: blocker.blockingWorkId,
    semanticScopeKeys: blocker.semanticScopeKeys,
    resourceKeys: blocker.resourceKeys,
    wakeTrigger: blocker.wakeTrigger,
    observedAt: new Date().toISOString(),
  };
}

export function executionConcurrencyWaitProjection(
  input: Omit<ExecutionConcurrencyWaitProjection, 'schemaVersion' | 'observedAt'>,
): ExecutionConcurrencyWaitProjection {
  return { schemaVersion: 1, ...input, observedAt: new Date().toISOString() };
}

export function concurrencyWaitEquivalent(
  left: ExecutionConcurrencyWaitProjection | undefined,
  right: ExecutionConcurrencyWaitProjection | undefined,
): boolean {
  if (!left || !right) return left === right;
  const withoutObservedAt = (value: ExecutionConcurrencyWaitProjection) => ({
    source: value.source,
    blockerCode: value.blockerCode,
    disposition: value.disposition,
    blockingWorkId: value.blockingWorkId,
    semanticScopeKeys: value.semanticScopeKeys,
    resourceKeys: value.resourceKeys,
    wakeTrigger: value.wakeTrigger,
  });
  return JSON.stringify(withoutObservedAt(left)) === JSON.stringify(withoutObservedAt(right));
}

export interface RuntimeWorkCompatibilityDecision {
  compatible: boolean;
  hardBlocked: boolean;
  wait?: ExecutionConcurrencyWaitProjection;
}

function invalidActiveWorkCompatibility(
  candidate: WorkExecutionConcurrencyContract,
  invalid: ReturnType<typeof readActiveWorkCandidates>['invalid'],
): ExecutionConcurrencyWaitProjection | undefined {
  if (!workExecutionLaneMutates(candidate.lane)) return undefined;
  for (const current of invalid) {
    if (current.workId === candidate.workId) continue;
    const currentScope = new Set(current.semanticScopeKeys);
    const overlap = candidate.semanticScopeKeys.filter((key) => currentScope.has(key));
    if (overlap.length === 0
      && candidate.lane === 'isolated_write'
      && candidate.isolation === 'isolated'
      && current.isolation === 'isolated') continue;
    return executionConcurrencyWaitProjection({
      source: 'work_compatibility',
      blockerCode: 'work_contract_invalid',
      disposition: 'invalid',
      blockingWorkId: current.workId,
      semanticScopeKeys: overlap.length > 0 ? overlap : current.semanticScopeKeys,
      resourceKeys: candidate.resourceIntents
        .filter((intent) => intent.mode !== 'read')
        .map((intent) => intent.resourceKey),
      wakeTrigger: { kind: 'work_contract_change', workId: current.workId },
    });
  }
  return undefined;
}

function contractForProcess(
  controllerHome: string,
  repoId: string,
  record: ManagedProcessRecord,
): WorkExecutionConcurrencyContract | undefined {
  if (!record.workId) return undefined;
  let work;
  try {
    work = getWorkContract({ controllerHome, repoId }, record.workId);
  } catch {
    return undefined;
  }
  if (!work) return undefined;
  return buildWorkExecutionConcurrencyContract(work, {
    lane: laneForProcess(record),
    resourceIntents: intents(record.resourceClaims),
  });
}

export function evaluateManagedProcessWorkCompatibility(input: {
  controllerHome: string;
  repoId: string;
  processId: string;
  workId?: string;
  resourceClaims: readonly ProcessResourceClaim[];
  checkExecution?: ManagedProcessRecord['checkExecution'];
  origin?: ManagedProcessRecord['origin'];
}): RuntimeWorkCompatibilityDecision {
  if (!input.workId) return { compatible: true, hardBlocked: false };
  const work = getWorkContract({ controllerHome: input.controllerHome, repoId: input.repoId }, input.workId);
  if (!work) {
    return {
      compatible: false,
      hardBlocked: true,
      wait: executionConcurrencyWaitProjection({
        source: 'work_compatibility',
        blockerCode: 'work_contract_missing',
        disposition: 'invalid',
        semanticScopeKeys: [],
        resourceKeys: input.resourceClaims.map((claim) => claim.resourceKey),
        wakeTrigger: { kind: 'work_contract_change', workId: input.workId },
      }),
    };
  }
  const candidate = buildWorkExecutionConcurrencyContract(work, {
    lane: laneForProcess({ checkExecution: input.checkExecution, origin: input.origin }),
    resourceIntents: intents(input.resourceClaims),
  });
  const activeProcessContracts = listProcessRecords(input.controllerHome, input.repoId, 500)
    .filter((record) => record.processId !== input.processId && record.workId && isManagedProcessActive(record))
    .map((record) => contractForProcess(input.controllerHome, input.repoId, record))
    .filter((value): value is WorkExecutionConcurrencyContract => Boolean(value));
  const worksWithActiveProcesses = new Set(activeProcessContracts.map((contract) => contract.workId));
  const activeSnapshot = readActiveWorkCandidates({
    controllerHome: input.controllerHome,
    repoId: input.repoId,
    limit: 1_000,
  });
  const invalidWait = invalidActiveWorkCompatibility(candidate, activeSnapshot.invalid);
  if (invalidWait) return { compatible: false, hardBlocked: true, wait: invalidWait };
  const activeWorkContracts = activeSnapshot.contracts
    .filter((activeWork) => activeWork.workId !== input.workId && !worksWithActiveProcesses.has(activeWork.workId))
    .map((activeWork) => buildWorkExecutionConcurrencyContract(activeWork));
  const decision = evaluateWorkExecutionCompatibility(candidate, [...activeProcessContracts, ...activeWorkContracts]);
  const blocker = decision.blockers[0];
  return blocker
    ? { compatible: false, hardBlocked: blocker.disposition === 'invalid', wait: blockerProjection(blocker) }
    : { compatible: true, hardBlocked: false };
}

function workProjectionSemanticIdentity(value: WorkExecutionConcurrencyProjection): string {
  return JSON.stringify({
    status: value.status,
    source: value.source,
    blockerCode: value.blockerCode,
    blockingWorkId: value.blockingWorkId,
    semanticScopeKeys: value.semanticScopeKeys,
    resourceKeys: value.resourceKeys,
    leaseRepoId: value.leaseRepoId,
    resourceIntents: value.resourceIntents,
    wakeTrigger: value.wakeTrigger,
  });
}

export function recordWorkExecutionConcurrencyWait(input: {
  controllerHome: string;
  repoId: string;
  workId?: string;
  attemptId?: string;
  wait: ExecutionConcurrencyWaitProjection;
  resourceClaims: readonly Pick<ResourceClaimSpec, 'resourceKey' | 'mode'>[];
  leaseRepoId?: string;
}): WorkExecutionConcurrencyProjection | undefined {
  const workId = input.workId?.trim();
  if (!workId) return undefined;
  const work = getWorkContract({ controllerHome: input.controllerHome, repoId: input.repoId }, workId);
  if (!work || isTerminalWorkContractStatus(work.status)) return undefined;
  const projection: WorkExecutionConcurrencyProjection = {
    schemaVersion: 1,
    status: input.wait.disposition === 'invalid' ? 'invalid' : 'waiting',
    source: input.wait.source,
    attemptId: input.attemptId?.trim() || undefined,
    blockerCode: input.wait.blockerCode,
    blockingWorkId: input.wait.blockingWorkId,
    semanticScopeKeys: [...new Set(input.wait.semanticScopeKeys)].sort(),
    resourceKeys: [...new Set(input.wait.resourceKeys)].sort(),
    leaseRepoId: input.leaseRepoId?.trim() || input.repoId,
    resourceIntents: intents(input.resourceClaims),
    wakeTrigger: input.wait.wakeTrigger,
    recordedAt: new Date().toISOString(),
  };
  if (work.executionConcurrency
    && workProjectionSemanticIdentity(work.executionConcurrency) === workProjectionSemanticIdentity(projection)) {
    return work.executionConcurrency;
  }
  return updateWorkContract(
    { controllerHome: input.controllerHome, repoId: input.repoId },
    workId,
    { executionConcurrency: projection },
  ).executionConcurrency;
}

export function clearWorkExecutionConcurrencyWaitForAttempt(input: {
  controllerHome: string;
  repoId: string;
  workId?: string;
  attemptId: string;
}): boolean {
  const workId = input.workId?.trim();
  if (!workId) return false;
  const work = getWorkContract({ controllerHome: input.controllerHome, repoId: input.repoId }, workId);
  if (!work?.executionConcurrency || work.executionConcurrency.attemptId !== input.attemptId) return false;
  updateWorkContract({ controllerHome: input.controllerHome, repoId: input.repoId }, workId, { executionConcurrency: undefined });
  return true;
}

function workConcurrencyWakeResolved(input: {
  controllerHome: string;
  repoId: string;
  workId: string;
  projection: WorkExecutionConcurrencyProjection;
}): boolean {
  const wake = input.projection.wakeTrigger;
  if (input.projection.status === 'invalid' || wake.kind === 'work_contract_change' || wake.kind === 'scheduler_capacity') return false;
  if (wake.kind === 'work_terminal') {
    const blocking = getWorkContract({ controllerHome: input.controllerHome, repoId: input.repoId }, wake.workId);
    return Boolean(blocking && isTerminalWorkContractStatus(blocking.status));
  }
  if (wake.kind === 'controller_release') {
    return !getControllerSession({ controllerHome: input.controllerHome, repoId: input.repoId }, wake.workId);
  }
  const activeLeases = listActiveLeases(input.controllerHome, input.projection.leaseRepoId?.trim() || input.repoId);
  return !input.projection.resourceIntents.some((claim) => activeLeases.some((lease) => claimsConflict(claim, lease)));
}

export function reconcileWorkExecutionConcurrencyWaits(input: {
  controllerHome: string;
  repoId: string;
  limit?: number;
}): { scanned: number; waiting: number; cleared: number; workIds: string[] } {
  const works = listWorkContracts({
    controllerHome: input.controllerHome,
    repoId: input.repoId,
    status: 'active',
    limit: Math.max(1, Math.min(input.limit ?? 500, 1_000)),
  });
  const waiting = works.filter((work) => work.executionConcurrency);
  const cleared: string[] = [];
  for (const work of waiting) {
    const projection = work.executionConcurrency!;
    if (!workConcurrencyWakeResolved({
      controllerHome: input.controllerHome,
      repoId: input.repoId,
      workId: work.workId,
      projection,
    })) continue;
    updateWorkContract(
      { controllerHome: input.controllerHome, repoId: input.repoId },
      work.workId,
      { executionConcurrency: undefined },
    );
    cleared.push(work.workId);
  }
  return { scanned: works.length, waiting: waiting.length, cleared: cleared.length, workIds: cleared.sort() };
}
