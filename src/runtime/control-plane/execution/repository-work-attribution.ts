import { readExecutionSession } from './session-store';
import { controllerSessionPrincipalId, getControllerSession, listControllerSessions } from '../facade/controller-session-store';
import { getWorkContract } from '../../../../packages/kernel/work/api/index';
import { isTerminalWorkContractStatus } from '../facade/types';

export interface RepositoryWorkAttributionCaller {
  sessionId?: string;
  principalId?: string;
  controllerInstanceId?: string;
}

export interface RepositoryWorkAttributionTarget {
  repoId: string;
  activeCheckoutId: string;
}

export function resolveExplicitClaimedRepositoryWork(
  controllerHome: string,
  target: RepositoryWorkAttributionTarget,
  caller: RepositoryWorkAttributionCaller | undefined,
  workId: string,
) {
  if (!caller?.principalId?.trim()) return undefined;
  const work = getWorkContract({ controllerHome, repoId: target.repoId }, workId);
  if (!work || isTerminalWorkContractStatus(work.status)) throw new Error(`WORK_ATTRIBUTION_INVALID: ${workId}`);
  const owner = getControllerSession({ controllerHome, repoId: target.repoId }, workId);
  if (!owner) throw new Error(`WORK_CONTROLLER_CLAIM_REQUIRED: ${workId}`);
  if (controllerSessionPrincipalId(owner) !== caller.principalId.trim()) {
    throw new Error(`WORK_CONTROLLER_OWNERSHIP_MISMATCH: ${workId}`);
  }
  if (work.checkoutId && work.checkoutId !== target.activeCheckoutId) {
    throw new Error(
      `WORK_CHECKOUT_MISMATCH: work=${workId}; resolved_checkout=${target.activeCheckoutId}; expected_work_checkout=${work.checkoutId}; retry with checkout_id=${work.checkoutId} and the same work_id`,
    );
  }
  return work;
}

export function assertNoBoundExecutionSessionMutation(
  controllerHome: string,
  target: RepositoryWorkAttributionTarget,
  caller?: RepositoryWorkAttributionCaller,
): void {
  if (!caller?.principalId?.trim() || !caller.sessionId?.trim()) return;
  const executionSession = readExecutionSession(controllerHome, {
    sessionId: caller.sessionId,
    principalId: caller.principalId,
    controllerInstanceId: caller.controllerInstanceId,
  });
  const workId = executionSession?.activeWorkId?.trim();
  if (!workId || executionSession?.activeRepositoryId !== target.repoId) return;
  const work = getWorkContract({ controllerHome, repoId: target.repoId }, workId);
  if (!work) throw new Error(`WORK_ATTRIBUTION_INVALID: ${workId}`);
  if (isTerminalWorkContractStatus(work.status)) {
    throw new Error(`WORK_ATTRIBUTION_TERMINAL: ${work.workId}:${work.status}`);
  }
  throw new Error(`WORK_ATTRIBUTION_REQUIRED: ${work.workId}; active execution session mutations must pass work_id explicitly`);
}

export function resolveClaimedRepositoryWorkId(
  controllerHome: string,
  target: RepositoryWorkAttributionTarget,
  caller?: RepositoryWorkAttributionCaller,
  explicitWorkId?: unknown,
): string | undefined {
  const requestedWorkId = typeof explicitWorkId === 'string' ? explicitWorkId.trim() : '';
  if (requestedWorkId) {
    const work = resolveExplicitClaimedRepositoryWork(controllerHome, target, caller, requestedWorkId);
    return work?.workId;
  }
  if (!caller?.principalId?.trim()) return undefined;
  if (caller.sessionId?.trim()) {
    const executionSession = readExecutionSession(controllerHome, {
      sessionId: caller.sessionId,
      principalId: caller.principalId,
      controllerInstanceId: caller.controllerInstanceId,
    });
    const workId = executionSession?.activeWorkId?.trim();
    if (workId
      && executionSession?.activeRepositoryId === target.repoId
      && (!executionSession.activeCheckoutId || executionSession.activeCheckoutId === target.activeCheckoutId)) {
      const work = getWorkContract({ controllerHome, repoId: target.repoId }, workId);
      if (work && isTerminalWorkContractStatus(work.status)) {
        throw new Error(`WORK_ATTRIBUTION_TERMINAL: ${work.workId}:${work.status}`);
      }
      const owner = getControllerSession({ controllerHome, repoId: target.repoId }, workId);
      if (work && owner?.sessionId === caller.sessionId && controllerSessionPrincipalId(owner) === caller.principalId.trim()) {
        return workId;
      }
    }
  }
  const principal = caller.principalId.trim();
  const candidates = listControllerSessions({ controllerHome, repoId: target.repoId })
    .filter((owner) => controllerSessionPrincipalId(owner) === principal)
    .map((owner) => ({ owner, work: getWorkContract({ controllerHome, repoId: target.repoId }, owner.workId) }))
    .filter((entry): entry is { owner: ReturnType<typeof listControllerSessions>[number]; work: NonNullable<ReturnType<typeof getWorkContract>> } => Boolean(
      entry.work
      && !isTerminalWorkContractStatus(entry.work.status)
      && (!entry.work.checkoutId || entry.work.checkoutId === target.activeCheckoutId),
    ));
  if (candidates.length === 1) return candidates[0].work.workId;
  if (candidates.length > 1) {
    throw new Error(`WORK_ATTRIBUTION_AMBIGUOUS: principal ${principal} owns ${candidates.length} active Works on checkout ${target.activeCheckoutId}`);
  }
  return undefined;
}
