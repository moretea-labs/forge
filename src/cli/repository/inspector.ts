import { createHash } from 'crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { runProcess } from '../../effects/process-runner';
import { globMatches, resolveMcpPath } from '../mcp/paths';
import type { McpPolicy } from '../mcp/types';
import {
  collectSessionIdentity,
  getOrCreateSessionCache,
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
    if (!result.ok) return { head: null, branch: null };

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
    const workingTreeFingerprint = createHash('sha256')
      .update(`${head ?? ''}\n${branch ?? ''}\n${status}`)
      .digest('hex')
      .slice(0, 24);
    return { head, branch, workingTreeFingerprint: head || status ? workingTreeFingerprint : undefined };
  } catch {
    return { head: null, branch: null };
  }
}

/**
 * Cheap, short-lived Git identity cache. Sampling runs at most once per TTL
 * per repository; repeat hot reads reuse the sampled HEAD/fingerprint so the
 * identity phase does not spawn git subprocesses on every MCP call. The
 * fingerprint is content-based (stable across reads) and the short TTL window
 * keeps checkout routing safe while real mutations invalidate through markers.
 */
export function cachedGitIdentity(repoRoot: string): CachedGitIdentity {
  const now = Date.now();
  const existing = gitIdentityCache.get(repoRoot);
  if (existing && now - existing.sampledAt < GIT_IDENTITY_SAMPLE_TTL_MS) {
    gitIdentityPerformance.cacheHits += 1;
    return existing;
  }
  const sampled = sampleGitIdentity(repoRoot);
  const entry: CachedGitIdentity = { ...sampled, sampledAt: now };
  gitIdentityCache.set(repoRoot, entry);
  pruneGitIdentityCache();
  return entry;
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
  const identity = collectSessionIdentity({
    repoRoot,
    repoId: session.repoId,
    checkoutId: session.checkoutId,
  });
  return getOrCreateSessionCache(session.sessionId, repoRoot, identity);
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
function gitSearchFileInventory(repoRoot: string): string[] | null {
  try {
    const result = runProcess('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: repoRoot,
      timeoutMs: 10_000,
      maxOutputBytes: SEARCH_GIT_INVENTORY_MAX_OUTPUT_BYTES,
    });
    if (!result.ok || result.stdout.includes('[output truncated after')) return null;
    return result.stdout
      .split('\0')
      // NUL framing already gives exact Git paths; do not trim because leading
      // or trailing whitespace is legal in a repository filename.
      .filter((path) => path.length > 0)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return null;
  }
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
  includeGlobs?: string[];
  excludeGlobs?: string[];
  maxResultsPerQuery?: number;
  maxFiles?: number;
  caseSensitive?: boolean;
  cacheKey?: string;
}

export interface SearchRepositoryManyResult {
  queries: string[];
  results: Array<{ query: string; path: string; line: number; text: string }>;
  scannedFiles: number;
  policyDeniedFiles: number;
  skippedLargeFiles: number;
  skippedBinaryFiles: number;
  truncated: boolean;
  truncationReason?: 'max_results' | 'max_files';
  cacheHit?: boolean;
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

/**
 * Internal Context Plane batch search. Every candidate file is policy-checked
 * and read at most once while all lexical terms are matched in the same pass.
 * The public search_repository tool remains the simpler single-query primitive.
 */
export function searchRepositoryMany(
  repoRoot: string,
  policy: McpPolicy,
  opts: SearchRepositoryManyOptions,
): SearchRepositoryManyResult {
  const queries = Array.from(new Set(opts.queries.map((query) => query.trim()).filter(Boolean)));
  if (queries.length === 0) throw new Error('at least one search query is required');
  const maxResultsPerQuery = Math.min(Math.max(opts.maxResultsPerQuery ?? 100, 1), 500);
  const maxFiles = Math.min(Math.max(opts.maxFiles ?? 5000, 1), 20_000);
  const includes = opts.includeGlobs ?? [];
  const excludes = [...(includes.length === 0 ? DEFAULT_EXCLUDES : []), ...(opts.excludeGlobs ?? [])];
  const inventory = searchInventory(repoRoot, includes, excludes, maxFiles, opts.cacheKey);
  const needles = queries.map((query) => ({ query, needle: opts.caseSensitive ? query : query.toLowerCase() }));
  const counts = new Map(queries.map((query) => [query, 0]));
  const results: SearchRepositoryManyResult['results'] = [];
  let scannedFiles = 0;
  let policyDeniedFiles = 0;
  let skippedLargeFiles = 0;
  let skippedBinaryFiles = 0;

  for (const path of inventory.files) {
    if (needles.every(({ query }) => (counts.get(query) ?? 0) >= maxResultsPerQuery)) break;
    const decision = resolveMcpPath(repoRoot, path, policy, 'read');
    if (!decision.ok || !decision.absolutePath) {
      policyDeniedFiles += 1;
      continue;
    }
    const size = statSync(decision.absolutePath).size;
    if (size > policy.maxFileBytes) {
      skippedLargeFiles += 1;
      continue;
    }
    const bytes = readFileSync(decision.absolutePath);
    if (binary(bytes)) {
      skippedBinaryFiles += 1;
      continue;
    }
    scannedFiles += 1;
    const lines = bytes.toString('utf-8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index]!;
      const haystack = opts.caseSensitive ? text : text.toLowerCase();
      for (const { query, needle } of needles) {
        if ((counts.get(query) ?? 0) >= maxResultsPerQuery || !haystack.includes(needle)) continue;
        results.push({ query, path, line: index + 1, text: text.slice(0, 500) });
        counts.set(query, (counts.get(query) ?? 0) + 1);
      }
    }
  }

  // Consumers may bound distinct candidate files after this call. Preserve the
  // caller's query priority so an exact symbol/phrase cannot be displaced by
  // earlier alphabetic files that only matched broad recall tokens.
  const queryPriority = new Map(queries.map((query, index) => [query, index]));
  results.sort((left, right) => {
    const priority = (queryPriority.get(left.query) ?? queries.length) - (queryPriority.get(right.query) ?? queries.length);
    if (priority !== 0) return priority;
    const pathOrder = left.path.localeCompare(right.path);
    return pathOrder !== 0 ? pathOrder : left.line - right.line;
  });

  const hitResultLimit = needles.some(({ query }) => (counts.get(query) ?? 0) >= maxResultsPerQuery);
  const truncationReason = hitResultLimit
    ? 'max_results' as const
    : inventory.candidateCount > inventory.files.length
      ? 'max_files' as const
      : undefined;
  return {
    queries,
    results,
    scannedFiles,
    policyDeniedFiles,
    skippedLargeFiles,
    skippedBinaryFiles,
    truncated: Boolean(truncationReason),
    truncationReason,
    cacheHit: inventory.cacheHit,
  };
}

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
  truncationReason?: "max_results" | "max_files";
  cacheHit?: boolean;
} {
  const query = opts.query;
  if (!query.trim()) throw new Error('search query is required');
  const maxResults = Math.min(Math.max(opts.maxResults ?? 100, 1), 500);
  const maxFiles = Math.min(Math.max(opts.maxFiles ?? 5000, 1), 20_000);
  const includes = opts.includeGlobs ?? [];
  // Explicit include globs opt into a targeted scan; MCP read policy remains the single authority.
  const excludes = [...(includes.length === 0 ? DEFAULT_EXCLUDES : []), ...(opts.excludeGlobs ?? [])];
  const includeKey = JSON.stringify({
    includes,
    excludes,
    maxResults,
    maxFiles,
    caseSensitive: opts.caseSensitive === true,
    cacheKey: opts.cacheKey,
  });
  const sessionCache = bindSessionCache(repoRoot, opts.session);
  if (sessionCache) {
    const cached = sessionCache.getSearch(query, includeKey);
    if (cached && cached.result && typeof cached.result === 'object') {
      return { ...(cached.result as ReturnType<typeof searchRepository>), cacheHit: true };
    }
  }
  const inventory = searchInventory(repoRoot, includes, excludes, maxFiles, opts.cacheKey);
  const files = inventory.files;
  const needle = opts.caseSensitive ? query : query.toLowerCase();
  const results: Array<{ path: string; line: number; text: string }> = [];
  let scannedFiles = 0;
  let policyDeniedFiles = 0;
  let skippedLargeFiles = 0;
  let skippedBinaryFiles = 0;
  for (const path of files) {
    if (results.length >= maxResults) break;
    if (!isIncluded(path, includes) || isExcluded(path, excludes)) continue;
    const decision = resolveMcpPath(repoRoot, path, policy, 'read');
    if (!decision.ok || !decision.absolutePath) {
      policyDeniedFiles += 1;
      continue;
    }
    const size = statSync(decision.absolutePath).size;
    if (size > policy.maxFileBytes) {
      skippedLargeFiles += 1;
      continue;
    }
    const bytes = readFileSync(decision.absolutePath);
    if (binary(bytes)) {
      skippedBinaryFiles += 1;
      continue;
    }
    scannedFiles += 1;
    const raw = bytes.toString('utf-8');
    const lines = raw.split(/\r?\n/);
    for (let index = 0; index < lines.length && results.length < maxResults; index += 1) {
      const haystack = opts.caseSensitive ? lines[index] : lines[index].toLowerCase();
      if (haystack.includes(needle)) results.push({ path, line: index + 1, text: lines[index].slice(0, 500) });
    }
  }
  const truncationReason = results.length >= maxResults
    ? 'max_results' as const
    : inventory.candidateCount > files.length
      ? 'max_files' as const
      : undefined;
  const payload = {
    query,
    results,
    scannedFiles,
    policyDeniedFiles,
    skippedLargeFiles,
    skippedBinaryFiles,
    truncated: Boolean(truncationReason),
    truncationReason,
    cacheHit: inventory.cacheHit,
  };
  if (sessionCache) {
    sessionCache.putSearch({
      query,
      includeKey,
      result: payload,
      scannedFiles,
    });
  }
  return payload;
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
  gitSnapshotPerformance.subprocesses += 2;
  const statusResult = runProcess('git', ['status', '--short', '--branch'], { cwd: repoRoot, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
  const diffResult = runProcess('git', ['diff', '--stat'], { cwd: repoRoot, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
  const status = statusResult.ok ? statusResult.stdout.trim() : statusResult.error || statusResult.stderr.trim();
  const value: GitSnapshotResult = {
    branch: identity.branch,
    head: identity.head,
    status,
    diffStat: diffResult.ok ? diffResult.stdout.trim() : diffResult.error || diffResult.stderr.trim(),
    dirty: status.split(/\r?\n/).some((line) => line.trim() && !line.startsWith("##")),
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
