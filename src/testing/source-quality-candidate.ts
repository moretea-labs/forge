import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

function git(repoRoot: string, args: string[]): Buffer {
  return execFileSync('git', args, { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 });
}

function gitPaths(output: Buffer): string[] {
  return output.toString('utf8').split('\0').filter(Boolean);
}

function requireRepositoryPath(path: string): void {
  if (
    !path ||
    path.startsWith('/') ||
    path === '..' ||
    path.startsWith('../') ||
    path.includes('/../') ||
    path.includes('\\') ||
    path.startsWith('./')
  ) {
    throw new Error(`Invalid committed source path: ${path}`);
  }
}

/** Select only paths in the exact committed candidate; other Writers' dirty and untracked files are not inputs. */
export function committedSourceCandidate(
  repoRoot: string,
  baseRef: string,
  targetRef = 'HEAD',
): {
  revision: string;
  paths: string[];
} {
  const revision = git(repoRoot, ['rev-parse', '--verify', `${targetRef}^{commit}`])
    .toString('utf8')
    .trim();
  const changed = committedChangedPaths(repoRoot, baseRef, revision);
  const atRevision = new Set(gitPaths(git(repoRoot, ['ls-tree', '-r', '--name-only', '-z', revision])));
  const paths = [...new Set(changed)].filter((path) => atRevision.has(path)).sort();
  for (const path of paths) requireRepositoryPath(path);
  return { revision, paths };
}

/**
 * Temporary source-quality input only, not a Git checkout/worktree/branch.
 * Biome uses the pinned candidate's config and EditorConfig; no source mutations touch the shared checkout.
 */
export function materializeCommittedSourceCandidate(repoRoot: string, revision: string, paths: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-source-quality-'));
  try {
    const fileSet = new Set(gitPaths(git(repoRoot, ['ls-tree', '-r', '--name-only', '-z', revision])));
    const inputs = [...new Set([...paths, 'biome.json', 'biome.jsonc', '.editorconfig'])].filter((path) =>
      fileSet.has(path),
    );
    if (!inputs.some((path) => path === 'biome.json' || path === 'biome.jsonc')) {
      throw new Error('Committed source candidate has no Biome configuration');
    }
    for (const path of inputs) {
      requireRepositoryPath(path);
      const destination = resolve(root, path);
      if (!destination.startsWith(root + sep)) throw new Error(`Source path escapes candidate snapshot: ${path}`);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, git(repoRoot, ['show', `${revision}:${path}`]));
    }
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Read-only TypeScript check input from a pinned commit, never a second Git worktree.
 * Restore the tracked source files without Git metadata; reuse only the existing
 * dependency directory, and leave the canonical checkout and index untouched.
 */
export function materializeCommittedTypeScriptCandidate(repoRoot: string, candidateRef: string): string {
  const revision = git(repoRoot, ['rev-parse', '--verify', `${candidateRef}^{commit}`])
    .toString('utf8')
    .trim();
  const dependencies = resolve(repoRoot, 'node_modules');
  if (!existsSync(dependencies)) throw new Error('Committed typecheck requires installed dependencies');
  const root = mkdtempSync(join(tmpdir(), 'forge-committed-typecheck-'));
  try {
    const tarPath = join(root, 'candidate.tar');
    const archive = spawnSync('git', ['archive', '--format=tar', '--output', tarPath, revision], { cwd: repoRoot });
    if (archive.error || archive.status !== 0) {
      throw new Error(
        `Cannot archive committed TypeScript candidate: ${archive.error?.message ?? archive.stderr?.toString() ?? archive.status}`,
      );
    }
    const extracted = spawnSync('tar', ['-xf', tarPath, '-C', root], { cwd: repoRoot });
    if (extracted.error || extracted.status !== 0) {
      throw new Error(
        `Cannot extract committed TypeScript candidate: ${extracted.error?.message ?? extracted.stderr?.toString() ?? extracted.status}`,
      );
    }
    unlinkSync(tarPath);
    if (existsSync(join(root, '.git')) || existsSync(join(root, 'node_modules'))) {
      throw new Error('Committed TypeScript candidate contains a forbidden Git or dependency entry');
    }
    symlinkSync(dependencies, join(root, 'node_modules'), 'dir');
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Include deleted source paths when deciding which committed regressions to run. */
export function committedChangedPaths(repoRoot: string, baseRef: string, revisionRef: string): string[] {
  const revision = git(repoRoot, ['rev-parse', '--verify', `${revisionRef}^{commit}`])
    .toString('utf8')
    .trim();
  const paths = [...new Set(gitPaths(git(repoRoot, ['diff', '--name-only', '-z', `${baseRef}...${revision}`])))].sort();
  for (const path of paths) requireRepositoryPath(path);
  return paths;
}

/**
 * Disposable test fixture for the pinned commit, not another development
 * checkout or task ledger. Git metadata exists only to let tests detect
 * tracked source mutations inside this isolated tree.
 */
export function materializeCommittedTestCandidate(repoRoot: string, revision: string): string {
  const root = materializeCommittedTypeScriptCandidate(repoRoot, revision);
  const runGit = (args: string[]): void => {
    const result = spawnSync('git', args, { cwd: root });
    if (result.error || result.status !== 0) {
      throw new Error(
        `Cannot initialize committed test fixture: ${result.error?.message ?? result.stderr?.toString() ?? result.status}`,
      );
    }
  };
  try {
    runGit(['init', '-q', '-b', 'main']);
    // Preserve even tracked files matched by ignore rules in the source archive.
    // The node_modules symlink is a dependency only, never a test-source input.
    runGit(['add', '-f', '-A', '--', '.', ':!node_modules']);
    runGit([
      '-c',
      'user.name=Forge Test Fixture',
      '-c',
      'user.email=forge-test@invalid.local',
      'commit',
      '-q',
      '-m',
      'pinned committed test candidate',
    ]);
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
