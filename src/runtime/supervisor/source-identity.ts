import { resolve } from 'path';
import { listRepositories } from '../../cli/repositories/registry';
import type { SupervisorSourceIdentity } from './types';

export interface StagedSupervisorSource {
  sourceRoot: string;
  sourceCommit?: string;
  releaseRevision: string;
}

/**
 * Bind an immutable staged release to the selected registered checkout when one
 * exists. This is release identity resolution only; it does not own rollout,
 * slot selection, traffic switching, or Runtime lifecycle.
 */
export function sourceIdentityFor(
  repoRoot: string,
  controllerHome: string,
  staged: StagedSupervisorSource,
): SupervisorSourceIdentity {
  const selected = resolve(repoRoot);
  const matched = listRepositories(controllerHome, { includeRemoved: true })
    .flatMap((repository) => repository.checkouts.map((checkout) => ({ repository, checkout })))
    .filter(({ checkout }) => checkout.lifecycle !== 'removed')
    .find(({ checkout }) => resolve(checkout.canonicalRoot) === selected);
  if (!staged.sourceCommit) throw new Error('SUPERVISOR_SOURCE_COMMIT_MISSING');
  return {
    ...(matched ? { repoId: matched.repository.repoId, checkoutId: matched.checkout.checkoutId } : {}),
    sourcePath: staged.sourceRoot,
    expectedHead: staged.sourceCommit,
    expectedRevision: staged.releaseRevision,
  };
}
