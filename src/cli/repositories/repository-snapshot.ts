import { createHash } from 'crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'fs';
import { resolve } from 'path';
import { spawn, spawnSync } from 'child_process';
import { capProcessOutput, redactProcessOutput } from '../../effects/process-runner';
import { commandEnvironment, collectOutput } from './command-process';

export interface RepositoryCommandSnapshot {
  head: string | null;
  branch: string | null;
  status: string;
  dirty: boolean;
  refsHash: string;
  paths: string[];
  pathFingerprints: Record<string, string>;
}

export function emptyWorkspaceSnapshot(): RepositoryCommandSnapshot {
  return { head: null, branch: null, status: '', dirty: false, refsHash: createHash('sha256').update('').digest('hex'), paths: [], pathFingerprints: {} };
}

function commandOutput(command: string, args: string[], cwd: string, maxOutputBytes: number): { ok: boolean; stdout: string } {
  const result = spawnSync(command, args, { cwd, env: commandEnvironment(), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: Math.max(maxOutputBytes, 1024 * 1024) });
  return { ok: result.status === 0 && !result.error, stdout: capProcessOutput(redactProcessOutput(typeof result.stdout === 'string' ? result.stdout : ''), maxOutputBytes) };
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
function pathFingerprint(root: string, relativePath: string, statusLines: string[]): string {
  const hash = createHash('sha256').update(statusLines.join('\n'));
  const absolute = resolve(root, relativePath);
  if (!existsSync(absolute)) return hash.update('\nmissing').digest('hex');
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) hash.update(`\nsymlink:${readlinkSync(absolute)}`);
    else if (stat.isFile()) hash.update('\nfile:').update(readFileSync(absolute));
    else hash.update(`\nmode:${stat.mode}:size:${stat.size}`);
  } catch (error) { hash.update(`\nunreadable:${error instanceof Error ? error.message : String(error)}`); }
  return hash.digest('hex');
}
function buildSnapshot(root: string, head: string | null, branch: string | null, status: string, refs: string): RepositoryCommandSnapshot {
  const lines = status.split(/\r?\n/).filter((line) => line && !line.startsWith('##'));
  const byPath = new Map<string, string[]>();
  for (const line of lines) {
    const path = statusPath(line); if (!path) continue;
    byPath.set(path, [...(byPath.get(path) ?? []), line]);
  }
  const paths = [...byPath.keys()].sort();
  return { head, branch, status, dirty: paths.length > 0, refsHash: createHash('sha256').update(refs).digest('hex'), paths, pathFingerprints: Object.fromEntries(paths.map((path) => [path, pathFingerprint(root, path, byPath.get(path) ?? [])])) };
}

export function repositorySnapshot(root: string): RepositoryCommandSnapshot {
  return buildSnapshot(root, gitText(root, ['rev-parse', '--verify', 'HEAD']) || null, gitText(root, ['branch', '--show-current']) || null, gitText(root, ['status', '--porcelain=v1', '--branch', '--untracked-files=all', '--', ...SNAPSHOT_PATHS]), gitText(root, ['show-ref']));
}

interface GitResult { ok: boolean; exitCode: number; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean }
async function gitAsync(root: string, args: string[], signal?: AbortSignal): Promise<GitResult> {
  if (signal?.aborted) return { ok: false, exitCode: 1, stdout: '', stderr: 'cancelled', timedOut: false, cancelled: true };
  return await new Promise((resolveResult) => {
    const child = spawn('git', ['-C', root, ...args], { cwd: root, env: commandEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const stdout = collectOutput(256 * 1024); const stderr = collectOutput(64 * 1024);
    let settled = false; let timedOut = false; let cancelled = false;
    const finish = (exitCode: number, forcedError?: string) => {
      if (settled) return; settled = true; clearTimeout(timeout); signal?.removeEventListener('abort', abort);
      resolveResult({ ok: exitCode === 0 && !timedOut && !cancelled, exitCode, stdout: stdout.complete().trim(), stderr: forcedError ?? stderr.complete(), timedOut, cancelled });
    };
    const timeout = setTimeout(() => { timedOut = true; try { child.kill(); } catch {} finish(1, `git ${args.join(' ')} timed out`); }, 10_000); timeout.unref();
    const abort = () => { cancelled = true; try { child.kill(); } catch {} finish(1, 'cancelled'); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk) => stdout.write(chunk)); child.stderr?.on('data', (chunk) => stderr.write(chunk));
    child.on('error', (error) => finish(1, error.message)); child.on('close', (code) => finish(code ?? 1));
  });
}

const MAX_DIRTY_PATHS = 200;
export async function repositorySnapshotAsync(
  root: string,
  signal?: AbortSignal,
  options: { pathFingerprints?: boolean; fingerprintTimeoutMs?: number } = {},
): Promise<RepositoryCommandSnapshot> {
  const [headResult, branchResult, statusResult, refsResult] = await Promise.all([
    gitAsync(root, ['rev-parse', '--verify', 'HEAD'], signal), gitAsync(root, ['branch', '--show-current'], signal),
    gitAsync(root, ['status', '--porcelain=v1', '--branch', '--untracked-files=all', '--', ...SNAPSHOT_PATHS], signal), gitAsync(root, ['show-ref'], signal),
  ]);
  if ([headResult, branchResult, statusResult, refsResult].some((result) => result.cancelled)) throw new Error('CANCELLED: repository snapshot aborted');
  if (statusResult.timedOut || headResult.timedOut) throw new Error('SNAPSHOT_TIMEOUT: git snapshot timed out');
  if (!statusResult.ok) throw new Error(`SNAPSHOT_FAILED: git status exit ${statusResult.exitCode}: ${statusResult.stderr}`);
  let head: string | null = null;
  if (headResult.ok) head = headResult.stdout || null;
  else if (!(headResult.exitCode === 128 || /unknown revision|bad revision|Needed a single revision|ambiguous argument|not a valid object name/i.test(headResult.stderr))) throw new Error(`SNAPSHOT_FAILED: git rev-parse HEAD exit ${headResult.exitCode}: ${headResult.stderr}`);
  const refs = refsResult.ok || (refsResult.exitCode === 1 && (!refsResult.stderr.trim() || /expected|no match|no references/i.test(refsResult.stderr))) ? refsResult.stdout || '' : (() => { throw new Error(`SNAPSHOT_FAILED: git show-ref exit ${refsResult.exitCode}: ${refsResult.stderr}`); })();
  if (signal?.aborted) throw new Error('CANCELLED: repository snapshot aborted');
  const lines = statusResult.stdout.split(/\r?\n/).filter((line) => line && !line.startsWith('##'));
  const includePathFingerprints = options.pathFingerprints !== false;
  if (includePathFingerprints && lines.length > MAX_DIRTY_PATHS) throw new Error(`SNAPSHOT_TOO_DIRTY: ${lines.length} dirty paths exceeds Fast Path cap ${MAX_DIRTY_PATHS}`);
  const byPath = new Map<string, string[]>();
  for (const line of lines) { const path = statusPath(line); if (path) byPath.set(path, [...(byPath.get(path) ?? []), line]); }
  const paths = [...byPath.keys()].sort();
  let pathFingerprints: Record<string, string> = {};
  if (includePathFingerprints) {
    const { computePathFingerprintsAsync } = await import('../../runtime/execution/thin-harness/fingerprint-worker');
    const fingerprintTimeoutMs = typeof options.fingerprintTimeoutMs === 'number' && Number.isFinite(options.fingerprintTimeoutMs)
      ? Math.max(1, Math.trunc(options.fingerprintTimeoutMs))
      : 5_000;
    const fingerprint = await computePathFingerprintsAsync({ root, paths, statusByPath: Object.fromEntries(byPath), maxFileBytes: 256 * 1024, maxTotalBytes: 8 * 1024 * 1024, maxPaths: MAX_DIRTY_PATHS }, { signal, timeoutMs: fingerprintTimeoutMs });
    pathFingerprints = fingerprint.pathFingerprints;
  }
  return { head, branch: branchResult.ok ? branchResult.stdout || null : null, status: statusResult.stdout, dirty: paths.length > 0, refsHash: createHash('sha256').update(refs).digest('hex'), paths, pathFingerprints };
}

export function changedSnapshotPaths(before: RepositoryCommandSnapshot, after: RepositoryCommandSnapshot): string[] {
  return [...new Set([...before.paths, ...after.paths])].filter((path) => before.pathFingerprints[path] !== after.pathFingerprints[path]).sort();
}
export function snapshotChanged(before: RepositoryCommandSnapshot, after: RepositoryCommandSnapshot): boolean {
  return before.head !== after.head || before.branch !== after.branch || before.refsHash !== after.refsHash || changedSnapshotPaths(before, after).length > 0;
}
