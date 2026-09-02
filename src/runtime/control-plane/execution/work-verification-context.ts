import { listControllerChecks, type ControllerCheck } from '../../../cli/controller/check-runner';
import { selectRepositoryCheckout } from '../../../cli/repositories/registry';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { getWorkContract } from '../../../../packages/kernel/work/api/index';
import type { WorkContract } from '../facade/types';

export interface WorkVerificationContext {
  store: { controllerHome: string; repoId: string };
  repository: RepositoryRecord;
  workContract?: WorkContract;
  checks: ControllerCheck[];
}

export type WorkVerificationContextResolution =
  | { ok: true; context: WorkVerificationContext }
  | { ok: false; code: 'WORK_VERIFICATION_CHECKOUT_UNAVAILABLE'; detail: string; workContract?: WorkContract };

/**
 * Resolve the only repository/check-registry context that may be used to verify
 * a Work. A Work-bound checkout is semantic verification authority: if it can no
 * longer be resolved, verification must fail closed instead of silently reading
 * the canonical/main registry.
 */
export function resolveWorkVerificationContext(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  workId?: string;
}): WorkVerificationContextResolution {
  const store = { controllerHome: input.controllerHome, repoId: input.repository.repoId };
  const workId = input.workId?.trim();
  const workContract = workId ? getWorkContract(store, workId) : undefined;
  let repository = input.repository;

  if (workContract?.checkoutId) {
    try {
      repository = selectRepositoryCheckout(input.repository, workContract.checkoutId, { allowArchived: true });
    } catch (error) {
      return {
        ok: false,
        code: 'WORK_VERIFICATION_CHECKOUT_UNAVAILABLE',
        detail: error instanceof Error ? error.message : 'Work checkout could not be resolved',
        workContract,
      };
    }
  }

  return {
    ok: true,
    context: {
      store,
      repository,
      workContract,
      checks: listControllerChecks(repository.canonicalRoot),
    },
  };
}
