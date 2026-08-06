import { existsSync, lstatSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { runProcess } from '../../effects/process-runner';

export interface PostconditionResult {
  ok: boolean;
  code: string;
  failures: string[];
  details?: Record<string, unknown>;
}

function git(repoRoot: string, args: string[]): { ok: boolean; stdout: string; stderr: string; status: number } {
  const result = runProcess('git', ['-C', repoRoot, ...args], {
    timeoutMs: 15_000,
    maxOutputBytes: 256 * 1024,
  });
  return {
    ok: result.ok,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    status: result.status,
  };
}

export function fileSha256(absolutePath: string): string {
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
}

/**
 * Merge success requires exit 0, no unmerged paths, no MERGE_HEAD, and expected tree state.
 */
export function validateMergeSuccess(repoRoot: string, opts: {
  exitCode: number;
  expectClean?: boolean;
  expectedBranch?: string;
} = { exitCode: 0 }): PostconditionResult {
  const failures: string[] = [];
  if (opts.exitCode !== 0) failures.push(`merge exitCode=${opts.exitCode}`);
  const unmerged = git(repoRoot, ['diff', '--name-only', '--diff-filter=U']);
  if (unmerged.ok && unmerged.stdout) {
    failures.push(`unmerged paths: ${unmerged.stdout.split(/\n/).filter(Boolean).join(', ')}`);
  }
  if (existsSync(join(repoRoot, '.git', 'MERGE_HEAD'))) {
    failures.push('MERGE_HEAD is still present');
  }
  if (opts.expectClean) {
    const status = git(repoRoot, ['status', '--porcelain']);
    if (status.ok && status.stdout) failures.push('working tree is not clean after merge');
  }
  if (opts.expectedBranch) {
    const branch = git(repoRoot, ['branch', '--show-current']);
    if (branch.stdout !== opts.expectedBranch) {
      failures.push(`branch is ${branch.stdout || 'detached'}, expected ${opts.expectedBranch}`);
    }
  }
  return {
    ok: failures.length === 0,
    code: failures.length === 0 ? 'MERGE_OK' : 'MERGE_POSTCONDITION_FAILED',
    failures,
  };
}

export function validateDeleteSuccess(absolutePath: string): PostconditionResult {
  if (existsSync(absolutePath)) {
    return {
      ok: false,
      code: 'DELETE_POSTCONDITION_FAILED',
      failures: [`path still exists: ${absolutePath}`],
    };
  }
  return { ok: true, code: 'DELETE_OK', failures: [] };
}

export function validatePatchSuccess(input: {
  repoRoot: string;
  expectedFileShas?: Record<string, string>;
  allowedPaths?: string[];
  changedFiles: string[];
}): PostconditionResult {
  const failures: string[] = [];
  const root = resolve(input.repoRoot);
  for (const relative of input.changedFiles) {
    if (input.allowedPaths && input.allowedPaths.length > 0) {
      const allowed = input.allowedPaths.some((pattern) =>
        relative === pattern
        || relative.startsWith(`${pattern.replace(/\/$/, '')}/`)
        || pattern.endsWith('/**') && relative.startsWith(pattern.slice(0, -3)));
      if (!allowed) failures.push(`changed path outside allow-list: ${relative}`);
    }
    const absolute = join(root, relative);
    if (!existsSync(absolute)) {
      // deletions are allowed when listed as changed
      continue;
    }
    try {
      const content = readFileSync(absolute, 'utf8');
      if (content.includes('<<<<<<<') || content.includes('>>>>>>>') || content.includes('=======')) {
        failures.push(`conflict markers in ${relative}`);
      }
    } catch {
      // binary/unreadable: skip marker scan
    }
    if (input.expectedFileShas?.[relative]) {
      const actual = fileSha256(absolute);
      if (actual !== input.expectedFileShas[relative]) {
        failures.push(`sha mismatch for ${relative}: ${actual} != ${input.expectedFileShas[relative]}`);
      }
    }
  }

  // Executable bit surprises: if git reports mode change without content intent, flag it.
  const modeDiff = git(root, ['diff', '--summary']);
  if (modeDiff.ok) {
    for (const line of modeDiff.stdout.split(/\n/)) {
      if (/mode change/.test(line) && /100755|100644/.test(line)) {
        failures.push(`unexpected executable-bit change: ${line.trim()}`);
      }
    }
  }

  // Ensure no conflict markers remain in the worktree for touched files only (already scanned).
  return {
    ok: failures.length === 0,
    code: failures.length === 0 ? 'PATCH_OK' : 'PATCH_POSTCONDITION_FAILED',
    failures,
  };
}

export function pathExecutableBit(absolutePath: string): boolean {
  if (!existsSync(absolutePath)) return false;
  const mode = lstatSync(absolutePath).mode;
  return (mode & 0o111) !== 0;
}
