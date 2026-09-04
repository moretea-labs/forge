import { join } from 'path';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { selectRepositoryCheckout } from '../../cli/repositories/registry';
import type { RepositoryGitStatusSnapshot } from '../../cli/repositories/structured-git';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { runBoundedGit } from '../execution/thin-harness/async-process';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../shared/json-files';

export interface RepositoryGitStatusSample extends RepositoryGitStatusSnapshot {
  sampleSource: 'daemon-sample';
  sampledBy: 'scheduler';
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

function splitStatus(porcelain: string): Pick<RepositoryGitStatusSnapshot, 'staged' | 'unstaged' | 'untracked'> {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  for (const line of porcelain.split(/\r?\n/)) {
    if (!line || line.startsWith('## ')) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3).trim();
    if (code === '??') untracked.push(path);
    else {
      if (code[0] !== ' ' && code[0] !== '?') staged.push(path);
      if (code[1] !== ' ' && code[1] !== '?') unstaged.push(path);
    }
  }
  return { staged, unstaged, untracked };
}

async function gitSample(repository: RepositoryRecord, args: readonly string[], maxOutputBytes = GIT_STATUS_SAMPLE_MAX_BYTES) {
  return runBoundedGit(repository.canonicalRoot, args, {
    timeoutMs: GIT_STATUS_SAMPLE_TIMEOUT_MS,
    maxOutputBytes,
  });
}

export async function writeRepositoryGitStatusSample(
  controllerHome: string,
  repository: RepositoryRecord,
): Promise<RepositoryGitStatusSample> {
  const observedAt = new Date().toISOString();
  const [porcelainResult, shortResult, branchResult, headResult, upstreamResult] = await Promise.all([
    gitSample(repository, ['status', '--porcelain=v1', '--branch', '--untracked-files=all', '--', '.', ':(exclude).ai/harness/**']),
    gitSample(repository, ['status', '--short', '--branch', '--untracked-files=all', '--', '.', ':(exclude).ai/harness/**']),
    gitSample(repository, ['branch', '--show-current'], 64 * 1024),
    gitSample(repository, ['rev-parse', '--verify', 'HEAD'], 64 * 1024),
    gitSample(repository, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], 64 * 1024),
  ]);
  if (!porcelainResult.ok) {
    throw new Error(`GIT_STATUS_SAMPLE_FAILED: ${porcelainResult.stderr || `exit ${porcelainResult.exitCode}`}`);
  }
  const porcelain = porcelainResult.stdout;
  const split = splitStatus(porcelain);
  const sample: RepositoryGitStatusSample = {
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    observedAt,
    staleAgeMs: 0,
    sampleSource: 'daemon-sample',
    sampledBy: 'scheduler',
    branch: branchResult.ok && branchResult.stdout.trim() ? branchResult.stdout.trim() : null,
    head: headResult.ok && headResult.stdout.trim() ? headResult.stdout.trim() : null,
    upstream: upstreamResult.ok && upstreamResult.stdout.trim() ? upstreamResult.stdout.trim() : null,
    porcelain,
    shortStatus: shortResult.ok ? shortResult.stdout : porcelain,
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
      sampleSource: 'daemon-sample',
      staleAgeMs: Number.isFinite(observedMs) ? Math.max(0, Date.now() - observedMs) : Number.POSITIVE_INFINITY,
      sampledBy: 'scheduler',
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
