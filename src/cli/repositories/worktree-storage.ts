import { createHash } from 'crypto';
import { existsSync, mkdirSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, relative, resolve } from 'path';
import { durableControllerHome } from './controller-home';
import type { RepositoryRecord } from './types';

export const MANAGED_WORKTREE_HOME_ENV = 'REPO_HARNESS_WORKTREE_HOME';

function comparablePath(value: string): string {
  const resolved = resolve(value).replace(/\\/g, '/');
  const normalized = process.platform === 'darwin' && resolved.startsWith('/var/')
    ? `/private${resolved}`
    : resolved;
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Resolve symlinked existing ancestors even when the final path does not exist yet. */
export function canonicalManagedPath(value: string): string {
  let cursor = resolve(value);
  const tail: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    tail.unshift(basename(cursor));
    cursor = parent;
  }
  let canonicalBase = cursor;
  try { canonicalBase = realpathSync(cursor); } catch { /* resolved fallback */ }
  return resolve(canonicalBase, ...tail);
}

export function managedPathInside(parent: string, candidate: string): boolean {
  const rel = relative(comparablePath(canonicalManagedPath(parent)), comparablePath(canonicalManagedPath(candidate)));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'));
}

export function registeredRepositoryRoots(records: RepositoryRecord[]): string[] {
  const roots = new Set<string>();
  for (const record of records) {
    for (const candidate of [record.localRoot, record.canonicalRoot, ...record.checkouts.flatMap((checkout) => [checkout.localRoot, checkout.canonicalRoot])]) {
      if (!candidate?.trim()) continue;
      roots.add(canonicalManagedPath(candidate));
    }
  }
  return [...roots];
}

function overlapsRegisteredRoot(candidate: string, roots: string[]): string | undefined {
  return roots.find((root) => managedPathInside(root, candidate) || managedPathInside(candidate, root));
}

function controllerNamespace(controllerHome: string): string {
  return createHash('sha256')
    .update(canonicalManagedPath(durableControllerHome(controllerHome)))
    .digest('hex')
    .slice(0, 16);
}

function globalWorktreeBase(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_STATE_HOME?.trim();
  return xdg
    ? join(xdg, 'repo-harness', 'managed-worktrees')
    : join(homedir(), '.repo-harness', 'managed-worktrees');
}

/**
 * Resolve a stable Controller-owned worktree root that is disjoint from every
 * registered repository checkout. A repo-local self-host Controller Home is
 * therefore never reused as the worktree parent.
 */
export function managedWorktreeStorageRoot(
  controllerHome: string,
  records: RepositoryRecord[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const roots = registeredRepositoryRoots(records);
  const namespace = controllerNamespace(controllerHome);
  const explicit = env[MANAGED_WORKTREE_HOME_ENV]?.trim();
  const candidates = explicit
    ? [join(resolve(explicit), namespace)]
    : [
      join(durableControllerHome(controllerHome), 'managed-worktrees'),
      join(globalWorktreeBase(env), namespace),
    ];

  for (const raw of candidates) {
    const candidate = canonicalManagedPath(raw);
    const overlap = overlapsRegisteredRoot(candidate, roots);
    if (overlap) {
      if (explicit) {
        throw new Error(`MANAGED_WORKTREE_HOME_OVERLAPS_REPOSITORY: ${candidate} overlaps ${overlap}`);
      }
      continue;
    }
    mkdirSync(candidate, { recursive: true });
    return candidate;
  }
  throw new Error('MANAGED_WORKTREE_HOME_UNAVAILABLE: no stable path is disjoint from every registered repository root');
}

function safeSegment(value: string, fallback: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 100) || fallback;
}

export function managedWorktreePath(
  controllerHome: string,
  repoId: string,
  identity: string,
  records: RepositoryRecord[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const storageRoot = managedWorktreeStorageRoot(controllerHome, records, env);
  const candidate = canonicalManagedPath(join(
    storageRoot,
    safeSegment(repoId, 'repository'),
    safeSegment(identity, 'worktree'),
  ));
  if (!managedPathInside(storageRoot, candidate)) {
    throw new Error(`MANAGED_WORKTREE_PATH_ESCAPE: ${candidate}`);
  }
  const overlap = overlapsRegisteredRoot(candidate, registeredRepositoryRoots(records));
  if (overlap) throw new Error(`MANAGED_WORKTREE_PATH_OVERLAPS_REPOSITORY: ${candidate} overlaps ${overlap}`);
  return candidate;
}
