import { getWorkContract, semanticWorkState } from '../../../../packages/kernel/work/api/index';

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
  if (!work || semanticWorkState(work) !== 'open') throw new Error(`WORK_ATTRIBUTION_INVALID: ${workId}`);
  if (work.checkoutId && work.checkoutId !== target.activeCheckoutId) {
    throw new Error(
      `WORK_CHECKOUT_MISMATCH: work=${workId}; resolved_checkout=${target.activeCheckoutId}; expected_work_checkout=${work.checkoutId}; retry with checkout_id=${work.checkoutId} and the same work_id`,
    );
  }
  return work;
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
  // A previously bound execution session is *not* an implicit mutation
  // authority. Only an explicit work_id opts into Work-attributed execution;
  // Git/Process/Lease and checkout safety remain enforced by their owners.
  return undefined;
}
