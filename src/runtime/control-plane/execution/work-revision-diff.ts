import { spawnSync } from 'child_process';

function gitText(repoRoot: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8' });
  if (result.status !== 0 || result.error || typeof result.stdout !== 'string') {
    throw new Error(`WORK_REVISION_DIFF_GIT_FAILED: git ${args.join(' ')}`);
  }
  return result.stdout.trim();
}

function commitRevision(repoRoot: string, revision: string | undefined, label: string): string {
  if (!revision?.trim()) throw new Error(`WORK_REVISION_DIFF_${label}_MISSING`);
  return gitText(repoRoot, ['rev-parse', `${revision.trim()}^{commit}`]);
}

export function changedPaths(repoRoot: string, baseRevision: string, targetRevision: string): string[] {
  const result = spawnSync('git', ['diff', '--name-only', '-z', baseRevision, targetRevision], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error || typeof result.stdout !== 'string') {
    throw new Error('WORK_REVISION_DIFF_CHANGED_PATHS_UNAVAILABLE');
  }
  return [...new Set(result.stdout.split('\0').filter(Boolean))].sort();
}

export function changedPathsFromUnbornBase(repoRoot: string, targetRevision: string): string[] {
  const targetCommit = commitRevision(repoRoot, targetRevision, 'TARGET_REVISION');
  const result = spawnSync('git', ['ls-tree', '-r', '--name-only', '-z', targetCommit], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error || typeof result.stdout !== 'string') {
    throw new Error('WORK_REVISION_DIFF_UNBORN_CHANGED_PATHS_UNAVAILABLE');
  }
  return [...new Set(result.stdout.split('\0').filter(Boolean))].sort();
}
