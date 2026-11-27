import { createHash } from 'crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'fs';
import { resolve } from 'path';
import { spawn, spawnSync } from 'child_process';
import { capProcessOutput, redactProcessOutput } from '../../effects/process-runner';
import { commandEnvironment, collectOutput } from './command-process';

export type RepositoryCommandMutationEvidence = 'observed' | 'readonly_unobserved' | 'not_applicable';

export interface RepositoryCommandSnapshot {
  /** Whether this value contains authoritative mutation evidence for comparison. */
  mutationEvidence: RepositoryCommandMutationEvidence;
  head: string | null;
  branch: string | null;
  status: string;
  dirty: boolean;
  refsHash: string;
  paths: string[];
  pathFingerprints: Record<string, string>;
  fingerprintScope: 'none' | 'selected' | 'all_dirty';
  pathFingerprintError?: { code: string; message: string };
}

function neutralSnapshot(
  mutationEvidence: Exclude<RepositoryCommandMutationEvidence, 'observed'>,
): RepositoryCommandSnapshot {
  return {
    mutationEvidence,
    head: null,
    branch: null,
    status: '',
    dirty: false,
    refsHash: createHash('sha256').update('').digest('hex'),
    paths: [],
    pathFingerprints: {},
    fingerprintScope: 'none',
  };
}

export function emptyWorkspaceSnapshot(): RepositoryCommandSnapshot {
  return neutralSnapshot('not_applicable');
}

/** Proven-readonly execution deliberately owns no before/after mutation observation. */
export function readonlyUnobservedRepositorySnapshot(): RepositoryCommandSnapshot {
  return neutralSnapshot('readonly_unobserved');
}

function commandOutput(
  command: string,
  args: string[],
  cwd: string,
  maxOutputBytes: number,
): { ok: boolean; stdout: string } {
  const result = spawnSync(command, args, {
    cwd,
    env: commandEnvironment(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    maxBuffer: Math.max(maxOutputBytes, 1024 * 1024),
  });
  return {
    ok: result.status === 0 && !result.error,
    stdout: capProcessOutput(
      redactProcessOutput(typeof result.stdout === 'string' ? result.stdout : ''),
      maxOutputBytes,
    ),
  };
}
function gitText(root: string, args: string[]): string {
  const output = commandOutput('git', ['-C', root, ...args], root, 256 * 1024);
  return output.ok ? output.stdout.trim() : '';
}
const SNAPSHOT_PATHS = ['.', ':(exclude).ai/harness/**', ':(exclude)_ops/controller-home/**'];
function statusPath(line: string): string | undefined {
  if (!line.trim() || line.startsWith('##')) return undefined;
  const raw = line.length > 3 ? line.slice(3) : '';
  const path = raw.includes(' -> ') ? raw.split(' -> ').at(-1) : raw;
  return path?.replace(/^"|"$/g, '');
}
function pathFingerprint(
  root: string,
  relativePath: string,
  statusLines: string[],
  budget: { total: number; maxTotal: number },
): string {
  const hash = createHash('sha256').update(statusLines.join('\n'));
  const absolute = resolve(root, relativePath);
  if (!existsSync(absolute)) return hash.update('\nmissing').digest('hex');
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) hash.update('\nsymlink:' + readlinkSync(absolute));
    else if (stat.isFile()) {
      if (stat.size > MAX_FINGERPRINT_FILE_BYTES) {
        throw new Error(
          'SNAPSHOT_FINGERPRINT_BUDGET: ' + relativePath + ' exceeds ' + MAX_FINGERPRINT_FILE_BYTES + ' bytes',
        );
      }
      if (budget.total + stat.size > budget.maxTotal) {
        throw new Error('SNAPSHOT_FINGERPRINT_BUDGET: selected files exceed ' + budget.maxTotal + ' bytes');
      }
      const body = readFileSync(absolute);
      if (budget.total + body.length > budget.maxTotal) {
        throw new Error('SNAPSHOT_FINGERPRINT_BUDGET: selected files exceed ' + budget.maxTotal + ' bytes');
      }
      budget.total += body.length;
      hash.update('\nfile:').update(body);
    } else hash.update('\nmode:' + stat.mode + ':size:' + stat.size);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('SNAPSHOT_FINGERPRINT_BUDGET')) throw error;
    hash.update('\nunreadable:' + message);
  }
  return hash.digest('hex');
}
const MAX_FINGERPRINT_PATHS = 200;
const MAX_FINGERPRINT_FILE_BYTES = 256 * 1024;
const MAX_FINGERPRINT_TOTAL_BYTES = 8 * 1024 * 1024;

function buildSnapshot(
  root: string,
  head: string | null,
  branch: string | null,
  status: string,
  refs: string,
  options: { pathFingerprints?: boolean; fingerprintPaths?: readonly string[] } = {},
): RepositoryCommandSnapshot {
  const lines = status.split(/\r?\n/).filter((line) => line && !line.startsWith('##'));
  const byPath = new Map<string, string[]>();
  for (const line of lines) {
    const path = statusPath(line);
    if (!path) continue;
    byPath.set(path, [...(byPath.get(path) ?? []), line]);
  }
  const paths = [...byPath.keys()].sort();
  const fingerprintScope =
    options.pathFingerprints === false
      ? 'none'
      : options.fingerprintPaths !== undefined
        ? 'selected'
        : options.pathFingerprints === true
          ? 'all_dirty'
          : 'none';
  const requested = [
    ...new Set(
      (options.fingerprintPaths ?? [])
        .map((path) => path.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
        .filter(Boolean),
    ),
  ];
  const fingerprintPaths =
    fingerprintScope === 'none'
      ? []
      : fingerprintScope === 'all_dirty'
        ? paths
        : paths.filter((path) =>
            requested.some(
              (scope) => scope === '.' || path === scope || path.startsWith(scope.replace(/\/+$/, '') + '/'),
            ),
          );
  const pathFingerprints: Record<string, string> = {};
  let pathFingerprintError: { code: string; message: string } | undefined;
  if (fingerprintPaths.length > MAX_FINGERPRINT_PATHS) {
    pathFingerprintError = {
      code: 'SNAPSHOT_FINGERPRINT_BUDGET',
      message:
        fingerprintPaths.length + ' selected paths exceeds the bounded fingerprint budget of ' + MAX_FINGERPRINT_PATHS,
    };
  } else if (fingerprintPaths.length > 0) {
    try {
      const budget = { total: 0, maxTotal: MAX_FINGERPRINT_TOTAL_BYTES };
      for (const path of fingerprintPaths)
        pathFingerprints[path] = pathFingerprint(root, path, byPath.get(path) ?? [], budget);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pathFingerprintError = {
        code: message.includes(':') ? message.slice(0, message.indexOf(':')) : 'SNAPSHOT_FINGERPRINT_FAILED',
        message,
      };
      for (const path of Object.keys(pathFingerprints)) delete pathFingerprints[path];
    }
  }
  return {
    mutationEvidence: 'observed',
    head,
    branch,
    status,
    dirty: paths.length > 0,
    refsHash: createHash('sha256').update(refs).digest('hex'),
    paths,
    pathFingerprints,
    fingerprintScope,
    pathFingerprintError,
  };
}

export function repositorySnapshot(
  root: string,
  options: { pathFingerprints?: boolean; fingerprintPaths?: readonly string[] } = {},
): RepositoryCommandSnapshot {
  return buildSnapshot(
    root,
    gitText(root, ['rev-parse', '--verify', 'HEAD']) || null,
    gitText(root, ['branch', '--show-current']) || null,
    gitText(root, ['status', '--porcelain=v1', '--branch', '--untracked-files=all', '--', ...SNAPSHOT_PATHS]),
    gitText(root, ['show-ref']),
    options,
  );
}

interface GitResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}
async function gitAsync(root: string, args: string[], signal?: AbortSignal): Promise<GitResult> {
  if (signal?.aborted)
    return { ok: false, exitCode: 1, stdout: '', stderr: 'cancelled', timedOut: false, cancelled: true };
  return await new Promise((resolveResult) => {
    const child = spawn('git', ['-C', root, ...args], {
      cwd: root,
      env: commandEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const stdout = collectOutput(256 * 1024);
    const stderr = collectOutput(64 * 1024);
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    const finish = (exitCode: number, forcedError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      resolveResult({
        ok: exitCode === 0 && !timedOut && !cancelled,
        exitCode,
        stdout: stdout.complete().trim(),
        stderr: forcedError ?? stderr.complete(),
        timedOut,
        cancelled,
      });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {}
      finish(1, `git ${args.join(' ')} timed out`);
    }, 10_000);
    timeout.unref();
    const abort = () => {
      cancelled = true;
      try {
        child.kill();
      } catch {}
      finish(1, 'cancelled');
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk) => stdout.write(chunk));
    child.stderr?.on('data', (chunk) => stderr.write(chunk));
    child.on('error', (error) => finish(1, error.message));
    child.on('close', (code) => finish(code ?? 1));
  });
}

export async function repositorySnapshotAsync(
  root: string,
  signal?: AbortSignal,
  options: { pathFingerprints?: boolean; fingerprintTimeoutMs?: number; fingerprintPaths?: readonly string[] } = {},
): Promise<RepositoryCommandSnapshot> {
  const [headResult, branchResult, statusResult, refsResult] = await Promise.all([
    gitAsync(root, ['rev-parse', '--verify', 'HEAD'], signal),
    gitAsync(root, ['branch', '--show-current'], signal),
    gitAsync(root, ['status', '--porcelain=v1', '--branch', '--untracked-files=all', '--', ...SNAPSHOT_PATHS], signal),
    gitAsync(root, ['show-ref'], signal),
  ]);
  if ([headResult, branchResult, statusResult, refsResult].some((result) => result.cancelled))
    throw new Error('CANCELLED: repository snapshot aborted');
  if (statusResult.timedOut || headResult.timedOut) throw new Error('SNAPSHOT_TIMEOUT: git snapshot timed out');
  if (!statusResult.ok)
    throw new Error(`SNAPSHOT_FAILED: git status exit ${statusResult.exitCode}: ${statusResult.stderr}`);
  let head: string | null = null;
  if (headResult.ok) head = headResult.stdout || null;
  else if (
    !(
      headResult.exitCode === 128 ||
      /unknown revision|bad revision|Needed a single revision|ambiguous argument|not a valid object name/i.test(
        headResult.stderr,
      )
    )
  )
    throw new Error(`SNAPSHOT_FAILED: git rev-parse HEAD exit ${headResult.exitCode}: ${headResult.stderr}`);
  const refs =
    refsResult.ok ||
    (refsResult.exitCode === 1 &&
      (!refsResult.stderr.trim() || /expected|no match|no references/i.test(refsResult.stderr)))
      ? refsResult.stdout || ''
      : (() => {
          throw new Error(`SNAPSHOT_FAILED: git show-ref exit ${refsResult.exitCode}: ${refsResult.stderr}`);
        })();
  if (signal?.aborted) throw new Error('CANCELLED: repository snapshot aborted');
  const lines = statusResult.stdout.split(/\r?\n/).filter((line) => line && !line.startsWith('##'));
  const fingerprintScope =
    options.pathFingerprints === false
      ? 'none'
      : options.fingerprintPaths !== undefined
        ? 'selected'
        : options.pathFingerprints === true
          ? 'all_dirty'
          : 'none';
  const includePathFingerprints = fingerprintScope !== 'none';
  const byPath = new Map<string, string[]>();
  for (const line of lines) {
    const path = statusPath(line);
    if (path) byPath.set(path, [...(byPath.get(path) ?? []), line]);
  }
  const paths = [...byPath.keys()].sort();
  const requestedFingerprintPaths = [
    ...new Set(
      (options.fingerprintPaths ?? [])
        .map((path) => path.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
        .filter(Boolean),
    ),
  ];
  const fingerprintPaths = !includePathFingerprints
    ? []
    : fingerprintScope === 'all_dirty'
      ? paths
      : paths.filter((path) =>
          requestedFingerprintPaths.some(
            (scope) => scope === '.' || path === scope || path.startsWith(scope.replace(/\/+$/, '') + '/'),
          ),
        );
  let pathFingerprints: Record<string, string> = {};
  let pathFingerprintError: { code: string; message: string } | undefined;
  if (fingerprintPaths.length > MAX_FINGERPRINT_PATHS) {
    pathFingerprintError = {
      code: 'SNAPSHOT_FINGERPRINT_BUDGET',
      message:
        fingerprintPaths.length + ' selected paths exceeds the bounded fingerprint budget of ' + MAX_FINGERPRINT_PATHS,
    };
  } else if (fingerprintPaths.length > 0) {
    const { computePathFingerprintsAsync } = await import('../execution/thin-harness/fingerprint-worker');
    const fingerprintTimeoutMs =
      typeof options.fingerprintTimeoutMs === 'number' && Number.isFinite(options.fingerprintTimeoutMs)
        ? Math.max(1, Math.trunc(options.fingerprintTimeoutMs))
        : 5_000;
    const fingerprintStatusByPath = Object.fromEntries(fingerprintPaths.map((path) => [path, byPath.get(path) ?? []]));
    try {
      const fingerprint = await computePathFingerprintsAsync(
        {
          root,
          paths: fingerprintPaths,
          statusByPath: fingerprintStatusByPath,
          maxFileBytes: MAX_FINGERPRINT_FILE_BYTES,
          maxTotalBytes: MAX_FINGERPRINT_TOTAL_BYTES,
          maxPaths: MAX_FINGERPRINT_PATHS,
        },
        { signal, timeoutMs: fingerprintTimeoutMs },
      );
      pathFingerprints = fingerprint.pathFingerprints;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('CANCELLED')) throw error instanceof Error ? error : new Error(message);
      pathFingerprintError = {
        code: message.includes(':') ? message.slice(0, message.indexOf(':')) : 'SNAPSHOT_FINGERPRINT_FAILED',
        message,
      };
    }
  }
  return {
    mutationEvidence: 'observed',
    head,
    branch: branchResult.ok ? branchResult.stdout || null : null,
    status: statusResult.stdout,
    dirty: paths.length > 0,
    refsHash: createHash('sha256').update(refs).digest('hex'),
    paths,
    pathFingerprints,
    fingerprintScope,
    pathFingerprintError,
  };
}

function assertMutationEvidenceComparable(before: RepositoryCommandSnapshot, after: RepositoryCommandSnapshot): void {
  if (before.mutationEvidence === 'readonly_unobserved' || after.mutationEvidence === 'readonly_unobserved') {
    throw new Error('SNAPSHOT_COMPARISON_UNOBSERVED: readonly execution has no mutation snapshot to compare');
  }
}

function snapshotStatusByPath(snapshot: RepositoryCommandSnapshot): Map<string, string[]> {
  const byPath = new Map<string, string[]>();
  for (const line of snapshot.status.split(/\r?\n/).filter((value) => value && !value.startsWith('##'))) {
    const path = statusPath(line);
    if (path) byPath.set(path, [...(byPath.get(path) ?? []), line]);
  }
  return byPath;
}

export function changedSnapshotPaths(
  before: RepositoryCommandSnapshot,
  after: RepositoryCommandSnapshot,
  scopePaths?: readonly string[],
): string[] {
  assertMutationEvidenceComparable(before, after);
  const beforeStatus = snapshotStatusByPath(before);
  const afterStatus = snapshotStatusByPath(after);
  const inScope = (path: string) =>
    !scopePaths ||
    scopePaths.some((scope) => scope === '.' || path === scope || path.startsWith(scope.replace(/\/+$/, '') + '/'));
  return [...new Set([...before.paths, ...after.paths])]
    .filter((path) => {
      if (!inScope(path)) return false;
      if ((beforeStatus.get(path) ?? []).join('\n') !== (afterStatus.get(path) ?? []).join('\n')) return true;
      const beforeFingerprint = before.pathFingerprints[path];
      const afterFingerprint = after.pathFingerprints[path];
      return (
        beforeFingerprint !== undefined && afterFingerprint !== undefined && beforeFingerprint !== afterFingerprint
      );
    })
    .sort();
}
export function snapshotChanged(before: RepositoryCommandSnapshot, after: RepositoryCommandSnapshot): boolean {
  assertMutationEvidenceComparable(before, after);
  return (
    before.head !== after.head ||
    before.branch !== after.branch ||
    before.refsHash !== after.refsHash ||
    changedSnapshotPaths(before, after).length > 0
  );
}
