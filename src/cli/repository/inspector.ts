import { createHash } from 'crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { runProcess } from '../../effects/process-runner';
import { globMatches, resolveMcpPath } from '../mcp/paths';
import type { McpPolicy } from '../mcp/types';
import {
  collectSessionIdentity,
  getOrCreateSessionCache,
  invalidateSessionCachesForRepository,
  type RepositorySessionCache,
  type SessionIdentity,
} from './session-cache';

// Status/readiness storms call gitSnapshot repeatedly; 1s still re-ran 4 git
// processes per second per repo. 3s is short enough for interactive UX.
const GIT_SNAPSHOT_CACHE_TTL_MS = 3_000;

export interface GitSnapshotPerformanceSnapshot {
  cacheHits: number;
  refreshes: number;
  subprocesses: number;
}

interface GitSnapshotResult {
  branch: string | null;
  head: string | null;
  status: string;
  diffStat: string;
  dirty: boolean;
}

const GIT_SNAPSHOT_CACHE_MAX_ENTRIES = 128;
const gitSnapshotCache = new Map<string, { createdAt: number; value: GitSnapshotResult }>();

export interface CachedGitIdentity {
  sampledAt: number;
  head: string | null;
  branch: string | null;
  /** Dirty state comes from the same porcelain-v2 sample as branch/HEAD. */
  dirty: boolean;
  workingTreeFingerprint?: string;
}

export interface GitIdentityPerformanceSnapshot {
  cacheHits: number;
  samples: number;
  subprocesses: number;
}

/** Git identity sampling TTL: one bounded subprocess, then cheap reads. */
const GIT_IDENTITY_SAMPLE_TTL_MS = Math.max(1_000, Number(process.env.FORGE_GIT_IDENTITY_SAMPLE_TTL_MS ?? 3_000));
const GIT_IDENTITY_CACHE_MAX_ENTRIES = 128;
const gitIdentityCache = new Map<string, CachedGitIdentity>();
const gitIdentityPerformance: GitIdentityPerformanceSnapshot = {
  cacheHits: 0,
  samples: 0,
  subprocesses: 0,
};

function pruneGitIdentityCache(): void {
  while (gitIdentityCache.size > GIT_IDENTITY_CACHE_MAX_ENTRIES) {
    const oldest = gitIdentityCache.keys().next().value as string | undefined;
    if (!oldest) break;
    gitIdentityCache.delete(oldest);
  }
}

function sampleGitIdentity(repoRoot: string): Omit<CachedGitIdentity, 'sampledAt'> {
  // Porcelain v2 branch headers carry HEAD and branch identity together with
  // the worktree status. One Git process therefore replaces the previous
  // rev-parse + branch + status subprocess burst while preserving a coherent
  // point-in-time fingerprint.
  gitIdentityPerformance.samples += 1;
  gitIdentityPerformance.subprocesses += 1;
  try {
    const result = runProcess('git', ['status', '--porcelain=v2', '--branch', '--untracked-files=all'], {
      cwd: repoRoot,
      timeoutMs: 10_000,
      maxOutputBytes: 4 * 1024 * 1024,
    });
    if (!result.ok) return { head: null, branch: null, dirty: false };

    let head: string | null = null;
    let branch: string | null = null;
    const statusLines: string[] = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.startsWith('# branch.oid ')) {
        const value = line.slice('# branch.oid '.length).trim();
        head = value && value !== '(initial)' ? value : null;
      } else if (line.startsWith('# branch.head ')) {
        const value = line.slice('# branch.head '.length).trim();
        branch = value && value !== '(detached)' && value !== '(unknown)' ? value : null;
      } else if (line && !line.startsWith('# ')) {
        statusLines.push(line);
      }
    }
    const status = statusLines.join('\n');
    let dirtyBytes = 0;
    const dirtyContentIdentity = statusLines.slice(0, 500).map((line) => {
      const path = line.startsWith('? ') || line.startsWith('! ')
        ? line.slice(2)
        : line.startsWith('1 ')
          ? line.split(' ').slice(8).join(' ')
          : line.startsWith('2 ')
            ? line.split(' ').slice(9).join(' ').split('\t')[0]
            : line.startsWith('u ')
              ? line.split(' ').slice(10).join(' ')
              : '';
      if (!path) return line;
      try {
        const absolute = join(repoRoot, path);
        const stat = lstatSync(absolute);
        if (!stat.isFile()) return `${path}:${stat.mode}:${stat.size}:${stat.mtimeMs}`;
        if (stat.size <= 256 * 1024 && dirtyBytes + stat.size <= 4 * 1024 * 1024) {
          dirtyBytes += stat.size;
          return `${path}:${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`;
        }
        return `${path}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return `${path}:missing`;
      }
    }).join('\n');
    const workingTreeFingerprint = createHash('sha256')
      .update(`${head ?? ''}\n${branch ?? ''}\n${status}\n${dirtyContentIdentity}`)
      .digest('hex')
      .slice(0, 24);
    return {
      head,
      branch,
      dirty: statusLines.length > 0,
      workingTreeFingerprint: head || status ? workingTreeFingerprint : undefined,
    };
  } catch {
    return { head: null, branch: null, dirty: false };
  }
}

/**
 * Cheap, short-lived Git identity cache. Sampling runs at most once per TTL
 * per repository; repeat hot reads reuse the sampled HEAD/fingerprint so the
 * identity phase does not spawn git subprocesses on every MCP call. The
 * fingerprint is content-based (stable across reads) and the short TTL window
 * keeps checkout routing safe while real mutations invalidate through markers.
 */
export function freshGitIdentity(repoRoot: string): CachedGitIdentity {
  const root = resolve(repoRoot);
  const sampled = sampleGitIdentity(root);
  const entry: CachedGitIdentity = { ...sampled, sampledAt: Date.now() };
  gitIdentityCache.set(root, entry);
  pruneGitIdentityCache();
  return entry;
}

export function cachedGitIdentity(repoRoot: string): CachedGitIdentity {
  const root = resolve(repoRoot);
  const now = Date.now();
  const existing = gitIdentityCache.get(root);
  if (existing && now - existing.sampledAt < GIT_IDENTITY_SAMPLE_TTL_MS) {
    gitIdentityPerformance.cacheHits += 1;
    return existing;
  }
  return freshGitIdentity(root);
}

/**
 * Successful Forge-owned mutations invalidate observations derived from the
 * previous source state. This is intentionally lazy: no graph rebuild, check,
 * or language server is started here; the next read re-samples Git/current bytes.
 */
export function invalidateRepositoryReadCaches(repoRoot: string): void {
  const root = resolve(repoRoot);
  gitIdentityCache.delete(root);
  gitSnapshotCache.delete(root);
  for (const key of [...searchFileInventoryCache.keys()]) {
    try {
      const identity = JSON.parse(key) as { repoRoot?: unknown };
      if (typeof identity.repoRoot === 'string' && resolve(identity.repoRoot) === root) {
        searchFileInventoryCache.delete(key);
      }
    } catch {
      // Cache keys are internal JSON identities. Ignore legacy/unparseable entries.
    }
  }
  invalidateSessionCachesForRepository(root);
}

export function clearGitIdentityCacheForTest(): void {
  gitIdentityCache.clear();
  gitIdentityPerformance.cacheHits = 0;
  gitIdentityPerformance.samples = 0;
  gitIdentityPerformance.subprocesses = 0;
}

export function gitIdentityPerformanceSnapshot(): GitIdentityPerformanceSnapshot {
  return { ...gitIdentityPerformance };
}

function pruneGitSnapshotCache(): void {
  while (gitSnapshotCache.size > GIT_SNAPSHOT_CACHE_MAX_ENTRIES) {
    const oldest = gitSnapshotCache.keys().next().value as string | undefined;
    if (!oldest) break;
    gitSnapshotCache.delete(oldest);
  }
}
const gitSnapshotPerformance: GitSnapshotPerformanceSnapshot = {
  cacheHits: 0,
  refreshes: 0,
  subprocesses: 0,
};
const SEARCH_FILE_INVENTORY_CACHE_TTL_MS = 5_000;
const searchFileInventoryCache = new Map<string, { createdAt: number; files: string[] }>();

/** Optional per-call session cache binding for MCP sessions. */
export interface RepositoryReadSession {
  sessionId: string;
  repoId: string;
  checkoutId: string;
}

function bindSessionCache(repoRoot: string, session?: RepositoryReadSession): RepositorySessionCache | null {
  if (!session?.sessionId || !session.repoId || !session.checkoutId) return null;
  const sampled = cachedGitIdentity(repoRoot);
  const identity: SessionIdentity = {
    repoId: session.repoId,
    checkoutId: session.checkoutId,
    branch: sampled.branch,
    head: sampled.head,
    workingTreeFingerprint: sampled.workingTreeFingerprint
      ?? createHash('sha256').update(`${sampled.head ?? ''}\n${sampled.branch ?? ''}`).digest('hex').slice(0, 24),
  };
  return getOrCreateSessionCache(session.sessionId, repoRoot, identity);
}

/** Shared non-durable cache binding for progressive Context Plane providers. */
export function getRepositoryReadSessionCache(
  repoRoot: string,
  session?: RepositoryReadSession,
): RepositorySessionCache | null {
  return bindSessionCache(repoRoot, session);
}

export function resolveSessionIdentity(
  repoRoot: string,
  repoId: string,
  checkoutId: string,
): SessionIdentity {
  return collectSessionIdentity({ repoRoot, repoId, checkoutId });
}

const DEFAULT_EXCLUDES = [
  '.git/**',
  'node_modules/**',
  'dist/**',
  'build/**',
  'coverage/**',
  '.build/**',
  'DerivedData/**',
  '.ai/harness/backups/**',
  '.ai/harness/edit-sessions/**',
  '.ai/harness/jobs/**',
  '.ai/harness/local-jobs/**',
  '.ai/harness/controller/**',
  '.ai/harness/controller-context-invalidation.json',
];

function isExcluded(path: string, excludes: string[]): boolean {
  return excludes.some((pattern) => globMatches(pattern, path));
}

function isIncluded(path: string, includes: string[]): boolean {
  return includes.length === 0 || includes.some((pattern) => globMatches(pattern, path));
}

const SEARCH_GIT_INVENTORY_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Prefer Git's own tracked+untracked inventory for Git worktrees. This avoids
 * walking generated/runtime directories and, critically, lets include globs be
 * applied before maxFiles is charged. Return null when Git is unavailable or
 * output is truncated so non-Git/ephemeral workspaces retain the filesystem
 * fallback below.
 */
function parseGitSearchFileInventory(stdout: string): string[] {
  return stdout
    .split('\0')
    // NUL framing already gives exact Git paths; do not trim because leading
    // or trailing whitespace is legal in a repository filename.
    .filter((path) => path.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function gitSearchFileInventory(repoRoot: string): string[] | null {
  try {
    const result = runProcess('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: repoRoot,
      timeoutMs: 10_000,
      maxOutputBytes: SEARCH_GIT_INVENTORY_MAX_OUTPUT_BYTES,
    });
    if (!result.ok || result.stdout.includes('[output truncated after')) return null;
    return parseGitSearchFileInventory(result.stdout);
  } catch {
    return null;
  }
}

/** Git provides a fast tracked-file location hint; the normal policy-checked
 * source matcher remains the only authority for actual lexical hits. */
function gitExactSearchCandidateArgs(needle: string, caseSensitive: boolean): string[] {
  // Word-fenced Git candidates avoid a flood of longer-prefix symbols before
  // policy-checked source matching enforces the actual exact code boundary.
  return ['grep', '-l', '-z', '-F', '-w', ...(caseSensitive ? [] : ['-i']), '-e', needle, '--'];
}

function interleaveExactCandidatePaths(lists: readonly string[][], maxFiles: number): string[] {
  const paths = new Set<string>();
  const perQueryLimit = Math.min(8, maxFiles);
  for (let index = 0; index < perQueryLimit; index += 1) {
    for (const list of lists) {
      const path = list[index];
      if (path) paths.add(path);
      if (paths.size >= maxFiles) return [...paths];
    }
  }
  return [...paths];
}

function gitExactSearchCandidatePaths(repoRoot: string, queries: string[], caseSensitive: boolean, maxFiles: number): string[] {
  const lists = queries.map((query) => {
    try {
      const result = runProcess('git', gitExactSearchCandidateArgs(query, caseSensitive), {
        cwd: repoRoot, timeoutMs: 10_000, maxOutputBytes: SEARCH_GIT_INVENTORY_MAX_OUTPUT_BYTES,
      });
      return result.ok && !result.stdout.includes('[output truncated after')
        ? result.stdout.split('\0').filter(Boolean)
        : [];
    } catch { return []; }
  });
  return interleaveExactCandidatePaths(lists, maxFiles);
}

function prioritizeExactSearchCandidates(
  inventory: { files: string[]; candidateCount: number; cacheHit: boolean },
  hints: string[], includes: string[], excludes: string[], maxFiles: number,
): typeof inventory {
  if (!hints.length) return inventory;
  const accepted = hints.filter((path) => isIncluded(path, includes) && !isExcluded(path, excludes));
  return { ...inventory, files: [...new Set([...accepted, ...inventory.files])].slice(0, maxFiles) };
}

function binary(bytes: Buffer): boolean {
  return bytes.subarray(0, Math.min(bytes.length, 8000)).includes(0);
}

function walk(repoRoot: string, root: string, maxFiles: number, excludes: string[], output: string[]): void {
  if (output.length >= maxFiles) return;
  const absolute = join(repoRoot, root);
  if (!existsSync(absolute)) return;
  const info = lstatSync(absolute);
  if (info.isSymbolicLink()) return;
  if (info.isFile()) {
    output.push(root);
    return;
  }
  if (!info.isDirectory()) return;
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (output.length >= maxFiles) break;
    const child = root ? `${root}/${entry.name}` : entry.name;
    if (isExcluded(child, excludes) || isExcluded(`${child}/`, excludes)) continue;
    if (entry.isDirectory()) walk(repoRoot, child, maxFiles, excludes, output);
    else if (entry.isFile()) output.push(child);
  }
}

export interface SearchRepositoryOptions {
  query: string;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  maxResults?: number;
  maxFiles?: number;
  caseSensitive?: boolean;
  /** Source fingerprint supplied by a caller that already sampled Git state. */
  cacheKey?: string;
}

export interface SearchRepositoryManyOptions {
  queries: string[];
  /** Pre-resolved exact candidate files. Skips repository inventory discovery. */
  files?: string[];
  includeGlobs?: string[];
  excludeGlobs?: string[];
  maxResultsPerQuery?: number;
  maxFiles?: number;
  caseSensitive?: boolean;
  cacheKey?: string;
  /**
   * Strict search remains the default. Broad Context discovery may stop once it
   * has enough distinct candidate files across several query hints; guessed
   * natural-language terms are evidence hints, not completeness obligations.
   */
  completionMode?: 'per_query' | 'discovery';
  discoveryTargetFiles?: number;
  discoveryMinQueryCoverage?: number;
  /** Exact caller-supplied needles that discovery must not skip. */
  requiredQueries?: string[];
  /** MCP/controller session identity used for progressive follow-up reuse. */
  session?: RepositoryReadSession;
}

export interface SearchRepositoryManyResult {
  queries: string[];
  results: Array<{ query: string; path: string; line: number; text: string }>;
  scannedFiles: number;
  policyDeniedFiles: number;
  skippedLargeFiles: number;
  skippedBinaryFiles: number;
  truncated: boolean;
  truncationReason?: 'max_results' | 'max_files' | 'discovery_budget';
  cacheHit?: boolean;
}

export interface SearchRepositoryManyCacheIdentity {
  queries: string[];
  maxResultsPerQuery: number;
  maxFiles: number;
  includes: string[];
  excludes: string[];
  directCandidates?: string[];
  completionMode: 'per_query' | 'discovery';
  discoveryTargetFiles: number;
  discoveryMinQueryCoverage: number;
  requiredQueries: string[];
  includeKey: string;
  batchQueryKey: string;
}

/** Shared normalization/cache identity for sync search and worker-prefetched search. */
export function searchRepositoryManyCacheIdentity(opts: SearchRepositoryManyOptions): SearchRepositoryManyCacheIdentity {
  const queries = Array.from(new Set(opts.queries.map((query) => query.trim()).filter(Boolean)));
  if (queries.length === 0) throw new Error('at least one search query is required');
  const maxResultsPerQuery = Math.min(Math.max(opts.maxResultsPerQuery ?? 100, 1), 500);
  const maxFiles = Math.min(Math.max(opts.maxFiles ?? 5000, 1), 20_000);
  const includes = opts.includeGlobs ?? [];
  const excludes = [...(includes.length === 0 ? DEFAULT_EXCLUDES : []), ...(opts.excludeGlobs ?? [])];
  const directFiles = opts.files?.map((path) => path.trim()).filter(Boolean);
  const directCandidates = directFiles
    ? Array.from(new Set(directFiles)).filter((path) => !isExcluded(path, excludes))
    : undefined;
  const completionMode = opts.completionMode === 'discovery' ? 'discovery' : 'per_query';
  const discoveryTargetFiles = completionMode === 'discovery'
    ? Math.min(Math.max(opts.discoveryTargetFiles ?? Math.max(12, Math.ceil(maxResultsPerQuery / 2)), 1), maxFiles)
    : maxFiles;
  const discoveryMinQueryCoverage = completionMode === 'discovery'
    ? Math.min(Math.max(opts.discoveryMinQueryCoverage ?? Math.min(3, queries.length), 1), queries.length)
    : queries.length;
  const requiredQueries = completionMode === 'discovery'
    ? Array.from(new Set((opts.requiredQueries ?? []).map((query) => query.trim()).filter((query) => queries.includes(query))))
    : [];
  const includeKey = JSON.stringify({
    files: directCandidates,
    includes,
    excludes,
    maxResultsPerQuery,
    maxFiles,
    caseSensitive: opts.caseSensitive === true,
    cacheKey: opts.cacheKey,
    completionMode,
    discoveryTargetFiles,
    discoveryMinQueryCoverage,
    requiredQueries,
  });
  return {
    queries,
    maxResultsPerQuery,
    maxFiles,
    includes,
    excludes,
    directCandidates,
    completionMode,
    discoveryTargetFiles,
    discoveryMinQueryCoverage,
    requiredQueries,
    includeKey,
    batchQueryKey: queries.join('\u0000'),
  };
}

function searchInventory(
  repoRoot: string,
  includes: string[],
  excludes: string[],
  maxFiles: number,
  cacheKey?: string,
): { files: string[]; candidateCount: number; cacheHit: boolean } {
  const inventoryKey = JSON.stringify({ repoRoot, excludes, cacheKey });
  const now = Date.now();
  const cachedInventory = searchFileInventoryCache.get(inventoryKey);
  const cacheHit = Boolean(cachedInventory && now - cachedInventory.createdAt < SEARCH_FILE_INVENTORY_CACHE_TTL_MS);
  const inventory = cacheHit
    ? cachedInventory!.files
    : (() => {
      const gitFiles = gitSearchFileInventory(repoRoot);
      const files = gitFiles ?? (() => {
        const walked: string[] = [];
        walk(repoRoot, '', 20_000, excludes, walked);
        return walked;
      })();
      searchFileInventoryCache.set(inventoryKey, { createdAt: now, files });
      return files;
    })();
  const candidates = inventory.filter((path) => isIncluded(path, includes) && !isExcluded(path, excludes));
  return { files: candidates.slice(0, maxFiles), candidateCount: candidates.length, cacheHit };
}

interface SearchManyMatchState {
  queries: string[];
  needles: Array<{ query: string; needle: string }>;
  counts: Map<string, number>;
  results: SearchRepositoryManyResult['results'];
  matchedPaths: Set<string>;
  maxResultsPerQuery: number;
  completionMode: 'per_query' | 'discovery';
  discoveryTargetFiles: number;
  discoveryMinQueryCoverage: number;
  requiredQueries: string[];
  caseSensitive: boolean;
}

function createSearchManyMatchState(
  queries: string[],
  maxResultsPerQuery: number,
  completionMode: 'per_query' | 'discovery',
  discoveryTargetFiles: number,
  discoveryMinQueryCoverage: number,
  requiredQueries: string[],
  caseSensitive: boolean,
): SearchManyMatchState {
  return {
    queries,
    needles: queries.map((query) => ({ query, needle: caseSensitive ? query : query.toLowerCase() })),
    counts: new Map(queries.map((query) => [query, 0])),
    results: [],
    matchedPaths: new Set<string>(),
    maxResultsPerQuery,
    completionMode,
    discoveryTargetFiles,
    discoveryMinQueryCoverage,
    requiredQueries,
    caseSensitive,
  };
}

function searchManyComplete(state: SearchManyMatchState): boolean {
  if (state.completionMode === 'per_query') {
    return state.needles.every(({ query }) => (state.counts.get(query) ?? 0) >= state.maxResultsPerQuery);
  }
  if (state.requiredQueries.some((query) => (state.counts.get(query) ?? 0) === 0)) return false;
  const coveredQueries = state.needles.reduce(
    (count, { query }) => count + ((state.counts.get(query) ?? 0) > 0 ? 1 : 0),
    0,
  );
  return state.matchedPaths.size >= state.discoveryTargetFiles
    && coveredQueries >= state.discoveryMinQueryCoverage;
}

function exactCodeNeedleMatches(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_$])${escaped}(?=$|[^\\p{L}\\p{N}_$])`, 'u').test(haystack);
}

function matchSearchManyLine(state: SearchManyMatchState, path: string, line: number, text: string): void {
  const haystack = state.caseSensitive ? text : text.toLowerCase();
  for (const { query, needle } of state.needles) {
    if ((state.counts.get(query) ?? 0) >= state.maxResultsPerQuery) continue;
    const matches = state.requiredQueries.includes(query)
      ? exactCodeNeedleMatches(haystack, needle)
      : haystack.includes(needle);
    if (!matches) continue;
    state.results.push({ query, path, line, text: text.slice(0, 500) });
    state.matchedPaths.add(path);
    state.counts.set(query, (state.counts.get(query) ?? 0) + 1);
  }
}

function finalizeSearchManyResult(input: {
  state: SearchManyMatchState;
  scannedFiles: number;
  policyDeniedFiles: number;
  skippedLargeFiles: number;
  skippedBinaryFiles: number;
  candidateCount: number;
  inventoryFileCount: number;
  inventoryCacheHit: boolean;
}): SearchRepositoryManyResult {
  const { state } = input;
  const queryPriority = new Map(state.queries.map((query, index) => [query, index]));
  state.results.sort((left, right) => {
    const priority = (queryPriority.get(left.query) ?? state.queries.length) - (queryPriority.get(right.query) ?? state.queries.length);
    if (priority !== 0) return priority;
    const pathOrder = left.path.localeCompare(right.path);
    return pathOrder !== 0 ? pathOrder : left.line - right.line;
  });
  const discoveryBudgetReached = state.completionMode === 'discovery' && searchManyComplete(state);
  const hitResultLimit = state.needles.some(({ query }) => (state.counts.get(query) ?? 0) >= state.maxResultsPerQuery);
  const truncationReason = discoveryBudgetReached
    ? 'discovery_budget' as const
    : hitResultLimit
      ? 'max_results' as const
      : input.candidateCount > input.inventoryFileCount
        ? 'max_files' as const
        : undefined;
  return {
    queries: state.queries,
    results: state.results,
    scannedFiles: input.scannedFiles,
    policyDeniedFiles: input.policyDeniedFiles,
    skippedLargeFiles: input.skippedLargeFiles,
    skippedBinaryFiles: input.skippedBinaryFiles,
    truncated: Boolean(truncationReason),
    truncationReason,
    cacheHit: input.inventoryCacheHit,
  };
}

/**
 * ripgrep owns literal matching and returns line-addressed evidence directly.
 * The caller supplies only policy-checked paths; neither a repository-wide
 * scan nor a second JavaScript file-content scan is permitted.
 */
function ripgrepCandidateLines(
  repoRoot: string,
  allowedPaths: readonly string[],
  queries: readonly string[],
  caseSensitive: boolean,
  maxResultsPerQuery: number,
): Map<string, Array<{ line: number; text: string }>> {
  const found = new Map<string, Array<{ line: number; text: string }>>();
  const searchDeadline = Date.now() + 15_000;
  for (let offset = 0; offset < allowedPaths.length; offset += 128) {
    const paths = allowedPaths.slice(offset, offset + 128);
    const remainingMs = searchDeadline - Date.now();
    if (remainingMs <= 0) throw new Error('RIPGREP_SEARCH_TIMEOUT: source discovery exceeded 15s total budget');
    const result = runProcess('rg', [
      '--json', '--fixed-strings', '--no-ignore', '--no-config', '--no-messages',
      '--max-count', String(Math.min(Math.max(maxResultsPerQuery, 32), 500)),
      ...(caseSensitive ? [] : ['--ignore-case']),
      ...queries.flatMap((query) => ['-e', query]),
      '--', ...paths,
    ], { cwd: repoRoot, timeoutMs: Math.min(remainingMs, 5_000), maxOutputBytes: 16 * 1024 * 1024 });
    if ((result.status !== 0 && result.status !== 1) || result.timedOut
      || result.stdout.includes('[output truncated after')) {
      throw new Error('RIPGREP_SEARCH_FAILED: ' + (result.error || result.stderr || String(result.status)));
    }
    for (const raw of result.stdout.split('\n')) {
      if (!raw || raw[0] !== '{') continue;
      const entry = JSON.parse(raw) as {
        type?: string;
        data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number };
      };
      if (entry.type !== 'match' || !entry.data) continue;
      const path = entry.data.path?.text;
      const line = entry.data.line_number;
      const text = entry.data.lines?.text;
      if (!path || !Number.isInteger(line) || typeof text !== 'string') continue;
      const lines = found.get(path) ?? [];
      lines.push({ line: line!, text: text.replace(/\r?\n$/, '') });
      found.set(path, lines);
    }
  }
  for (const lines of found.values()) lines.sort((a, b) => a.line - b.line);
  return found;
}

/**
 * Internal Context Plane discovery: ripgrep selects matching authorized files,
 * then bounded source materialization owns line-level evidence and ranking.
 */
export function searchRepositoryMany(
  repoRoot: string,
  policy: McpPolicy,
  opts: SearchRepositoryManyOptions,
): SearchRepositoryManyResult {
  const {
    queries,
    maxResultsPerQuery,
    maxFiles,
    includes,
    excludes,
    directCandidates,
    completionMode,
    discoveryTargetFiles,
    discoveryMinQueryCoverage,
    requiredQueries,
    includeKey,
    batchQueryKey,
  } = searchRepositoryManyCacheIdentity(opts);
  const sessionCache = bindSessionCache(repoRoot, opts.session);
  if (sessionCache) {
    const cached = sessionCache.getSearch(batchQueryKey, includeKey);
    if (cached?.result && typeof cached.result === 'object') {
      return { ...(cached.result as SearchRepositoryManyResult), cacheHit: true };
    }
  }
  const inventory = directCandidates && directCandidates.length > 0
    ? {
        files: directCandidates.slice(0, maxFiles),
        candidateCount: directCandidates.length,
        cacheHit: false,
      }
    : searchInventory(repoRoot, includes, excludes, maxFiles, opts.cacheKey);
  const prioritizedInventory = !directCandidates && requiredQueries.length && inventory.candidateCount > maxFiles
    ? prioritizeExactSearchCandidates(inventory,
        gitExactSearchCandidatePaths(repoRoot, requiredQueries, opts.caseSensitive === true, maxFiles), includes, excludes, maxFiles)
    : inventory;
  const matchState = createSearchManyMatchState(
    queries,
    maxResultsPerQuery,
    completionMode,
    discoveryTargetFiles,
    discoveryMinQueryCoverage,
    requiredQueries,
    opts.caseSensitive === true,
  );
  let scannedFiles = 0;
  let policyDeniedFiles = 0;
  let skippedLargeFiles = 0;
  let skippedBinaryFiles = 0;
  const canonicalRepoRoot = realpathSync(repoRoot);

  const authorizedCandidatePaths: string[] = [];
  // No external search process may inspect a file before MCP read authorization.
  for (const path of prioritizedInventory.files) {
    const decision = resolveMcpPath(repoRoot, path, policy, 'read', canonicalRepoRoot);
    if (!decision.ok || !decision.absolutePath) { policyDeniedFiles += 1; continue; }
    const info = statSync(decision.absolutePath);
    if (!info.isFile()) continue;
    if (info.size > policy.maxFileBytes) { skippedLargeFiles += 1; continue; }
    authorizedCandidatePaths.push(path);
  }
  const hitsByPath = authorizedCandidatePaths.length
    ? ripgrepCandidateLines(repoRoot, authorizedCandidatePaths, queries, opts.caseSensitive === true, maxResultsPerQuery)
    : new Map<string, Array<{ line: number; text: string }>>();
  for (const path of authorizedCandidatePaths) {
    if (searchManyComplete(matchState)) break;
    const hits = hitsByPath.get(path);
    if (!hits) continue;
    scannedFiles += 1;
    for (const hit of hits) matchSearchManyLine(matchState, path, hit.line, hit.text);
  }

  // Consumers may bound distinct candidate files after this call. Preserve the
  // caller's query priority so an exact symbol/phrase cannot be displaced by
  // earlier alphabetic files that only matched broad recall tokens.
  const payload = finalizeSearchManyResult({
    state: matchState,
    scannedFiles,
    policyDeniedFiles,
    skippedLargeFiles,
    skippedBinaryFiles,
    candidateCount: inventory.candidateCount,
    inventoryFileCount: prioritizedInventory.files.length,
    inventoryCacheHit: inventory.cacheHit,
  });
  if (sessionCache) {
    sessionCache.putSearch({
      query: batchQueryKey,
      includeKey,
      result: payload,
      scannedFiles,
    });
  }
  return payload;
}

/**
 * Async Context Pack uses the same canonical ripgrep-backed search implementation.
 * A second filesystem scanning implementation would diverge in policy, matching
 * and ranking; this short-lived sidecar does not own a separate search engine.
 */
export async function searchRepositoryManyAsync(
  repoRoot: string,
  policy: McpPolicy,
  opts: SearchRepositoryManyOptions,
): Promise<SearchRepositoryManyResult> {
  return searchRepositoryMany(repoRoot, policy, opts);
}

/** Single-query facade delegates to the canonical policy-checked rg engine. */
export function searchRepository(repoRoot: string, policy: McpPolicy, opts: SearchRepositoryOptions & {
  session?: RepositoryReadSession;
}): {
  query: string;
  results: Array<{ path: string; line: number; text: string }>;
  scannedFiles: number;
  policyDeniedFiles: number;
  skippedLargeFiles: number;
  skippedBinaryFiles: number;
  truncated: boolean;
  truncationReason?: 'max_results' | 'max_files';
  cacheHit?: boolean;
} {
  const results = searchRepositoryMany(repoRoot, policy, {
    queries: [opts.query],
    includeGlobs: opts.includeGlobs,
    excludeGlobs: opts.excludeGlobs,
    maxResultsPerQuery: opts.maxResults,
    maxFiles: opts.maxFiles,
    caseSensitive: opts.caseSensitive,
    cacheKey: opts.cacheKey,
    session: opts.session,
  });
  return {
    ...results,
    query: opts.query,
    results: results.results.map(({ path, line, text }) => ({ path, line, text })),
    truncationReason: results.truncationReason === 'discovery_budget' ? undefined : results.truncationReason,
  };
}

export function clearSearchFileInventoryCacheForTest(): void {
  searchFileInventoryCache.clear();
}

export function readRepositoryRange(
  repoRoot: string,
  policy: McpPolicy,
  path: string,
  startLine = 1,
  endLine = startLine + 199,
  session?: RepositoryReadSession,
): {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  sha256: string;
  cacheHit?: boolean;
} {
  const decision = resolveMcpPath(repoRoot, path, policy, 'read');
  if (!decision.ok || !decision.absolutePath || !decision.relativePath) throw new Error(decision.reason ?? 'path denied');
  const info = statSync(decision.absolutePath);
  if (!info.isFile()) throw new Error(`path is not a file: ${decision.relativePath}`);
  if (info.size > policy.maxFileBytes) throw new Error(`file exceeds ${policy.maxFileBytes} bytes`);
  const requestedStart = Math.max(Math.trunc(startLine), 1);
  const requestedEnd = Math.max(Math.trunc(endLine), requestedStart);

  const sessionCache = bindSessionCache(repoRoot, session);
  if (sessionCache) {
    const cached = sessionCache.getRange(decision.relativePath, requestedStart, requestedEnd);
    if (cached) {
      return {
        path: cached.path,
        startLine: cached.startLine,
        endLine: cached.endLine,
        totalLines: cached.totalLines,
        content: cached.content,
        sha256: cached.fileSha,
        cacheHit: true,
      };
    }
  }

  const bytes = readFileSync(decision.absolutePath);
  if (binary(bytes)) throw new Error('binary files are not supported');
  const raw = bytes.toString('utf-8');
  const lines = raw.split(/\r?\n/);
  const resolvedStart = Math.min(Math.max(Math.trunc(startLine), 1), Math.max(lines.length, 1));
  const resolvedEnd = Math.min(Math.max(Math.trunc(endLine), resolvedStart), lines.length);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const content = lines.slice(resolvedStart - 1, resolvedEnd).map((line, index) => `${resolvedStart + index}: ${line}`).join('\n');
  if (sessionCache) {
    sessionCache.putRange({
      path: decision.relativePath,
      fileSha: sha256,
      startLine: resolvedStart,
      endLine: resolvedEnd,
      content,
      totalLines: lines.length,
      bytes: Buffer.byteLength(content, 'utf8'),
    });
  }
  return {
    path: decision.relativePath,
    startLine: resolvedStart,
    endLine: resolvedEnd,
    totalLines: lines.length,
    sha256,
    content,
    cacheHit: false,
  };
}

export function clearGitSnapshotCacheForTest(): void {
  gitSnapshotCache.clear();
  gitSnapshotPerformance.cacheHits = 0;
  gitSnapshotPerformance.refreshes = 0;
  gitSnapshotPerformance.subprocesses = 0;
}

export function gitSnapshotPerformanceSnapshot(): GitSnapshotPerformanceSnapshot {
  return { ...gitSnapshotPerformance };
}

export function gitSnapshot(repoRoot: string, session?: RepositoryReadSession): GitSnapshotResult {
  const sessionCache = bindSessionCache(repoRoot, session);
  if (sessionCache) {
    const hit = sessionCache.getGitSnapshot();
    if (hit && typeof hit === 'object') {
      gitSnapshotPerformance.cacheHits += 1;
      return hit as GitSnapshotResult;
    }
  }
  const cached = gitSnapshotCache.get(repoRoot);
  const now = Date.now();
  if (cached && now - cached.createdAt <= GIT_SNAPSHOT_CACHE_TTL_MS) {
    gitSnapshotPerformance.cacheHits += 1;
    if (sessionCache) sessionCache.putGitSnapshot(cached.value);
    return cached.value;
  }
  gitSnapshotPerformance.refreshes += 1;
  // Reuse the identity sampled by controller_context (or sample it once here)
  // and keep only the two outputs unique to the full snapshot.
  const identity = cachedGitIdentity(repoRoot);
  gitSnapshotPerformance.subprocesses += 1;
  const statusResult = runProcess('git', ['status', '--short', '--branch'], { cwd: repoRoot, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
  const status = statusResult.ok ? statusResult.stdout.trim() : statusResult.error || statusResult.stderr.trim();
  const changeLines = status.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('##'));
  const dirty = changeLines.length > 0;
  // `git diff --stat` reports only worktree (unstaged/unmerged) changes. For a
  // clean, untracked-only, or staged-only status its output is guaranteed empty,
  // so avoid spawning a second Git process just to rediscover that fact.
  const hasWorktreeDiff = changeLines.some((line) => {
    const code = line.slice(0, 2);
    return code !== '??' && code !== '!!' && code.length === 2 && code[1] !== ' ';
  });
  let diffStat = '';
  if (hasWorktreeDiff) {
    gitSnapshotPerformance.subprocesses += 1;
    const diffResult = runProcess('git', ['diff', '--stat'], { cwd: repoRoot, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
    diffStat = diffResult.ok ? diffResult.stdout.trim() : diffResult.error || diffResult.stderr.trim();
  }
  const value: GitSnapshotResult = {
    branch: identity.branch,
    head: identity.head,
    status,
    diffStat,
    dirty,
  };
  gitSnapshotCache.set(repoRoot, { createdAt: now, value });
  pruneGitSnapshotCache();
  if (sessionCache) sessionCache.putGitSnapshot(value);
  return value;
}

export function gitDiff(repoRoot: string, path?: string, maxBytes = 128 * 1024): { path?: string; diff: string; truncated: boolean } {
  const args = ['diff', '--'];
  if (path?.trim()) args.push(path.trim());
  const result = runProcess('git', args, { cwd: repoRoot, timeoutMs: 20_000, maxOutputBytes: maxBytes });
  if (!result.ok && result.status !== 0) throw new Error(result.error || result.stderr || 'git diff failed');
  return { path: path?.trim() || undefined, diff: result.stdout, truncated: result.stdout.length >= maxBytes };
}
