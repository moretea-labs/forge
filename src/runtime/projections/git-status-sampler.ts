import { join } from 'path';
import { repositoryControllerRoot } from '../../effects/controller-home';
import { selectRepositoryCheckout } from '../repositories/registry';
import { porcelainBranchIdentity, splitRepositoryGitStatus, type RepositoryGitStatusSnapshot } from '../repositories/structured-git';
import type { RepositoryRecord } from '../../core/repository/types';
import { runBoundedGit } from '../execution/thin-harness/async-process';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../shared/json-files';

export interface RepositoryGitStatusSample extends RepositoryGitStatusSnapshot {
  sampleSource: 'live' | 'daemon-sample';
  sampledBy: 'scheduler' | 'caller';
}

function samplePath(controllerHome: string, repoId: string, checkoutId: string): string {
  return join(
    repositoryControllerRoot(controllerHome, repoId),
    'projections',
    'git-status',
    `${sanitizeFileComponent(checkoutId)}.json`,
  );
}

const GIT_STATUS_SAMPLE_TIMEOUT_MS = 5_000;
const GIT_STATUS_SAMPLE_MAX_BYTES = 512 * 1024;

async function gitSample(repository: RepositoryRecord, args: readonly string[], maxOutputBytes = GIT_STATUS_SAMPLE_MAX_BYTES) {
  return runBoundedGit(repository.canonicalRoot, args, {
    timeoutMs: GIT_STATUS_SAMPLE_TIMEOUT_MS,
    maxOutputBytes,
  });
}

export async function writeRepositoryGitStatusSample(
  controllerHome: string,
  repository: RepositoryRecord,
  sampledBy: RepositoryGitStatusSample['sampledBy'] = 'caller',
): Promise<RepositoryGitStatusSample> {
  const observedAt = new Date().toISOString();
  const [porcelainResult, headResult] = await Promise.all([
    gitSample(repository, ['status', '--porcelain=v1', '--branch', '--untracked-files=all', '--', '.', ':(exclude).ai/harness/**']),
    gitSample(repository, ['rev-parse', '--verify', 'HEAD'], 64 * 1024),
  ]);
  if (!porcelainResult.ok) {
    throw new Error(`GIT_STATUS_SAMPLE_FAILED: ${porcelainResult.stderr || `exit ${porcelainResult.exitCode}`}`);
  }
  const porcelain = porcelainResult.stdout;
  const split = splitRepositoryGitStatus(porcelain);
  // Reuse the live-status parser and layout: only one worktree scan per
  // scheduler sample. Unknown headers still resolve identity through Git.
  let identity = porcelainBranchIdentity(porcelain);
  if (!identity) {
    const [branchResult, upstreamResult] = await Promise.all([
      gitSample(repository, ['branch', '--show-current'], 64 * 1024),
      gitSample(repository, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], 64 * 1024),
    ]);
    identity = {
      branch: branchResult.ok ? branchResult.stdout.trim() || null : null,
      upstream: upstreamResult.ok ? upstreamResult.stdout.trim() || null : null,
    };
  }
  const sample: RepositoryGitStatusSample = {
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    observedAt,
    staleAgeMs: 0,
    sampleSource: sampledBy === 'scheduler' ? 'daemon-sample' : 'live',
    sampledBy,
    branch: identity.branch,
    head: headResult.ok && headResult.stdout.trim() ? headResult.stdout.trim() : null,
    upstream: identity.upstream,
    porcelain,
    shortStatus: porcelain,
    ...split,
    clean: split.staged.length === 0 && split.unstaged.length === 0 && split.untracked.length === 0,
  };
  writeJsonAtomic(samplePath(controllerHome, sample.repoId, sample.checkoutId), sample);
  return sample;
}

export function readRepositoryGitStatusSample(
  controllerHome: string,
  repoId: string,
  checkoutId: string,
): RepositoryGitStatusSample | undefined {
  try {
    const sample = readJsonFile<RepositoryGitStatusSample>(samplePath(controllerHome, repoId, checkoutId));
    const observedMs = Date.parse(sample.observedAt);
    return {
      ...sample,
      staleAgeMs: Number.isFinite(observedMs) ? Math.max(0, Date.now() - observedMs) : Number.POSITIVE_INFINITY,
    };
  } catch {
    return undefined;
  }
}

export async function sampleRepositoryGitStatusForRepositories(
  controllerHome: string,
  repositories: RepositoryRecord[],
): Promise<{ sampled: number; failed: Array<{ repoId: string; checkoutId: string; message: string }> }> {
  const outcomes = await Promise.all(repositories.map(async (repository) => {
    try {
      // Scheduler projections consume only the currently selected checkout.
      // Historical/parallel checkouts can be refreshed explicitly when selected;
      // sampling all of them turns stale registry history into Runtime hot-path work.
      await writeRepositoryGitStatusSample(
        controllerHome,
        selectRepositoryCheckout(repository, repository.activeCheckoutId),
        'scheduler',
      );
      return { ok: true as const, repository };
    } catch (error) {
      return {
        ok: false as const,
        repository,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }));
  const failed = outcomes
    .filter((outcome): outcome is Extract<(typeof outcomes)[number], { ok: false }> => !outcome.ok)
    .map((outcome) => ({
      repoId: outcome.repository.repoId,
      checkoutId: outcome.repository.activeCheckoutId,
      message: outcome.message,
    }));
  return { sampled: outcomes.length - failed.length, failed };
}
