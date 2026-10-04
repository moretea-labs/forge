import { spawnSync } from 'child_process';

function gitText(repoRoot: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8' });
  if (result.status !== 0 || result.error) return '';
  return typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

export function resolveCompletionTargetBranch(repoRoot: string): string {
  const branch = gitText(repoRoot, ['branch', '--show-current']);
  if (!branch) throw new Error('integration target must be an attached branch');
  return branch;
}

export function currentCompletionTarget(repoRoot: string): {
  branch: string;
  revision: string;
  expectedBranch: string;
  onTargetBranch: boolean;
} {
  const branch = gitText(repoRoot, ['branch', '--show-current']);
  const revision = gitText(repoRoot, ['rev-parse', 'HEAD']);
  if (!branch) throw new Error('integration target must be an attached branch');
  if (!revision) throw new Error('integration target revision is unavailable');
  const expectedBranch = resolveCompletionTargetBranch(repoRoot);
  return { branch, revision, expectedBranch, onTargetBranch: branch === expectedBranch };
}
