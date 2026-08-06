import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { runProcess } from '../../effects/process-runner';
import { resolveMcpRepoRoot } from '../mcp/repo';
import { listControllerChecks, runControllerCheck } from './check-runner';
import {
  compositeFailed,
  compositeSucceeded,
  usefulTail,
  type CompositeToolResult,
} from './composite-result';
import { validatePatchSuccess } from './postcondition';
import { gitSnapshot } from '../repository/inspector';

function fileSha(repoRoot: string, relativePath: string): string | null {
  const absolute = join(repoRoot, relativePath);
  if (!existsSync(absolute)) return null;
  return createHash('sha256').update(readFileSync(absolute)).digest('hex');
}

function git(repoRoot: string, args: string[]) {
  return runProcess('git', ['-C', repoRoot, ...args], {
    timeoutMs: 20_000,
    maxOutputBytes: 512 * 1024,
  });
}

export interface RepositoryChangeVerifyInput {
  repo?: string;
  expectedBranch?: string;
  expectedHead?: string;
  /** Relative path -> expected pre-patch sha256. */
  expectedFileShas?: Record<string, string>;
  /** Unified diff or multi-file patch text applied with `git apply`. */
  patch?: string;
  /** Optional allow-list for changed paths after patch. */
  allowedPaths?: string[];
  /** Check ids from listControllerChecks / package scripts. */
  checks?: string[];
  checkTimeoutMs?: number;
}

/**
 * One-shot: validate checkout, apply bounded patch, run checks, return first failure inline.
 */
export function repositoryChangeVerify(input: RepositoryChangeVerifyInput): CompositeToolResult {
  const repoRoot = resolveMcpRepoRoot(input.repo ?? '.');
  const snapshot = gitSnapshot(repoRoot);
  const evidenceRefs: string[] = [];

  if (input.expectedBranch && snapshot.branch !== input.expectedBranch) {
    return compositeFailed({
      phase: 'preflight',
      summary: `branch mismatch: ${snapshot.branch ?? 'detached'} != ${input.expectedBranch}`,
      failedCheck: 'branch',
      keyOutput: snapshot.status,
      nextAction: 'switch to the expected branch before retrying',
    });
  }
  if (input.expectedHead && snapshot.head !== input.expectedHead) {
    return compositeFailed({
      phase: 'preflight',
      summary: `HEAD mismatch: ${snapshot.head ?? 'unknown'} != ${input.expectedHead}`,
      failedCheck: 'head',
      keyOutput: `branch=${snapshot.branch} head=${snapshot.head}`,
      nextAction: 'rebase or re-checkout the expected commit',
    });
  }

  if (input.expectedFileShas) {
    for (const [path, expected] of Object.entries(input.expectedFileShas)) {
      const actual = fileSha(repoRoot, path);
      if (actual !== expected) {
        return compositeFailed({
          phase: 'preflight',
          summary: `file SHA mismatch for ${path}`,
          failedCheck: 'file_sha',
          keyOutput: `expected=${expected}\nactual=${actual ?? 'missing'}`,
          nextAction: 'refresh fingerprints and regenerate the patch',
        });
      }
    }
  }

  let changedFiles: string[] = [];
  if (input.patch?.trim()) {
    const apply = runProcess('git', ['-C', repoRoot, 'apply', '--whitespace=nowarn', '-'], {
      timeoutMs: 20_000,
      maxOutputBytes: 256 * 1024,
      input: input.patch,
    });
    if (!apply.ok) {
      return compositeFailed({
        phase: 'patch',
        summary: 'failed to apply patch',
        failedCheck: 'git_apply',
        exitCode: apply.status,
        keyOutput: usefulTail(apply.stdout, apply.stderr || apply.error || ''),
        nextAction: 'fix patch context against current file SHAs',
      });
    }
  }

  const nameOnly = git(repoRoot, ['diff', '--name-only']);
  const nameOnlyCached = git(repoRoot, ['diff', '--cached', '--name-only']);
  const untracked = git(repoRoot, ['ls-files', '--others', '--exclude-standard']);
  changedFiles = [
    ...new Set([
      ...nameOnly.stdout.split(/\n/).filter(Boolean),
      ...nameOnlyCached.stdout.split(/\n/).filter(Boolean),
      ...untracked.stdout.split(/\n/).filter(Boolean),
    ]),
  ];
  const diffStat = git(repoRoot, ['diff', '--stat']);

  const patchPost = validatePatchSuccess({
    repoRoot,
    expectedFileShas: undefined, // post-patch content intentionally differs
    allowedPaths: input.allowedPaths,
    changedFiles,
  });
  if (!patchPost.ok) {
    return compositeFailed({
      phase: 'patch-postcondition',
      summary: 'patch postcondition failed',
      failedCheck: 'patch_postcondition',
      changedFiles,
      keyOutput: patchPost.failures.join('\n'),
      nextAction: 'revert unexpected paths or conflict markers',
      details: { ...patchPost },
    });
  }

  const checkIds = input.checks?.length
    ? input.checks
    : [];
  const available = new Set(listControllerChecks(repoRoot).map((c) => c.id));
  for (const id of checkIds) {
    if (!available.has(id)) {
      return compositeFailed({
        phase: 'checks',
        summary: `check not found: ${id}`,
        failedCheck: id,
        changedFiles,
        keyOutput: `known checks: ${[...available].slice(0, 20).join(', ')}`,
        nextAction: 'use list_checks and pass valid check ids',
      });
    }
    const result = runControllerCheck(repoRoot, id, input.checkTimeoutMs);
    evidenceRefs.push(result.artifactPath);
    if (!result.ok) {
      return compositeFailed({
        phase: 'checks',
        summary: `check failed: ${id}`,
        failedCheck: id,
        exitCode: result.status,
        changedFiles,
        keyOutput: usefulTail(result.stdout, result.stderr),
        evidenceRefs,
        retryable: result.failureClass === 'infrastructure_failure',
        nextAction: result.failureClass === 'infrastructure_failure'
          ? 'retry the same check after infrastructure recovers'
          : 'fix the failing assertion and re-run repository_change_verify',
        details: {
          timedOut: result.timedOut,
          failureClass: result.failureClass,
          command: result.command,
        },
      });
    }
  }

  const after = gitSnapshot(repoRoot);
  return compositeSucceeded({
    phase: 'complete',
    summary: checkIds.length
      ? `patch applied and ${checkIds.length} check(s) passed`
      : 'patch applied (no checks requested)',
    changedFiles,
    keyOutput: [
      `branch=${after.branch}`,
      `head=${after.head}`,
      `changed=${changedFiles.join(', ') || '(none)'}`,
      diffStat.stdout || snapshot.diffStat,
    ].join('\n'),
    evidenceRefs,
    nextAction: 'review diff, commit when ready; do not push unless requested',
    details: {
      checks: checkIds,
      revision: after.head,
      dirty: after.dirty,
    },
    exitCode: 0,
  });
}
