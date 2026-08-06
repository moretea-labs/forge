import { createHash } from 'crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join, normalize, relative, resolve } from 'path';
import {
  capProcessOutput,
  redactProcessOutput,
  runProcess,
  type ProcessRunResult,
} from '../../effects/process-runner';
import { atomicWriteFileSync } from '../installer/shared';
import { runBoundedChild } from '../../runtime/shared/bounded-child-supervisor';
import { signalProcessTree } from '../../runtime/shared/process-tree';
import { repositoryChildProcessEnvironment } from '../../runtime/shared/process-environment';

export interface ControllerCheckEffects {
  /** Repository-relative read scopes. Use [\".\"] for the whole checkout. */
  reads?: string[];
  /** Repository-relative write scopes. Use [\".\"] for the whole checkout. */
  writes?: string[];
  cache?: 'read' | 'write';
  temp?: 'isolated' | 'shared';
  git?: 'read' | 'index' | 'refs' | 'write';
  network?: 'read' | 'write';
}

export interface ControllerCheck {
  id: string;
  description: string;
  command: string[];
  cwd: string;
  timeoutMs: number;
  source: 'repo-config' | 'package-script';
  effects?: ControllerCheckEffects;
}

export interface ControllerCheckSnapshot extends ControllerCheck {
  schemaVersion: 1;
  registryRevision: string;
  definitionDigest: string;
}

interface CheckConfig {
  version?: number;
  checks?: Record<string, {
    description?: string;
    command?: unknown;
    cwd?: string;
    timeoutMs?: number;
    effects?: unknown;
  }>;
}

const CHECK_CONFIG = '.forge/checks.json';
const CHECK_EVIDENCE_ROOT = '.ai/harness/checks/controller';
const HEAVY_CHECK_LOCK = '.ai/harness/controller/heavy-check.lock';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const SAFE_PACKAGE_SCRIPT = /^(test(?::|$)|check(?::|$)|lint(?::|$)|typecheck(?::|$)|format:check$)/;

/**
 * The supervised-check bridge script lives in the runtime source checkout.
 * In a bundled release, import.meta.dir points at the release directory whose
 * manifest records sourceRoot (the managed runtime worktree containing
 * scripts/), so resolve through the manifest before falling back to dev paths.
 */
function syncSupervisorBridgePath(repoRoot: string): string {
  const candidates: string[] = [
    resolve(import.meta.dir, '../../../scripts/run-supervised-command.ts'),
  ];
  try {
    const manifestPath = join(import.meta.dir, 'manifest.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { sourceRoot?: unknown };
      if (typeof manifest.sourceRoot === 'string' && manifest.sourceRoot.trim()) {
        candidates.push(resolve(manifest.sourceRoot, 'scripts/run-supervised-command.ts'));
      }
    }
  } catch {
    /* best-effort manifest probe */
  }
  candidates.push(resolve(repoRoot, 'scripts/run-supervised-command.ts'));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

const CHECK_BRIDGE_RUNTIME_ENV = 'FORGE_BUN_EXECUTABLE';

/**
 * A compiled Bun executable reports itself through process.execPath. In a
 * Supervisor release that path is forge.js, not a JavaScript runtime,
 * so passing the TypeScript bridge as argv would be parsed as a CLI command.
 */
export function resolveSyncSupervisorBridgeRuntime(
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env[CHECK_BRIDGE_RUNTIME_ENV]?.trim();
  if (configured) return configured;
  const executable = basename(execPath).toLowerCase();
  return executable === 'bun' || executable === 'bun.exe' ? execPath : 'bun';
}

function boundedTimeout(value: unknown): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(parsed, 5_000), MAX_TIMEOUT_MS);
}

function normalizeCwd(repoRoot: string, value: string | undefined): string {
  const rel = normalize((value ?? '.').trim() || '.').replace(/\\/g, '/');
  const absolute = resolve(repoRoot, rel);
  const back = relative(repoRoot, absolute).replace(/\\/g, '/');
  if (back === '..' || back.startsWith('../')) throw new Error(`check cwd escapes repository: ${value}`);
  return back || '.';
}

const CHECK_EFFECT_KEYS = new Set(['reads', 'writes', 'cache', 'temp', 'git', 'network']);

function normalizeEffectPaths(repoRoot: string, field: 'reads' | 'writes', value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    throw new Error(`check effects.${field} must be an array of non-empty repository-relative paths`);
  }
  return [...new Set(value.map((entry) => normalizeCwd(repoRoot, String(entry))))].sort();
}

function normalizeEffectMode<T extends string>(field: string, value: unknown, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`check effects.${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function normalizeCheckEffects(repoRoot: string, value: unknown): ControllerCheckEffects | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('check effects must be an object');
  }
  const raw = value as Record<string, unknown>;
  const unsupported = Object.keys(raw).filter((key) => !CHECK_EFFECT_KEYS.has(key));
  if (unsupported.length > 0) throw new Error(`unsupported check effect field(s): ${unsupported.join(', ')}`);
  return {
    ...(raw.reads !== undefined ? { reads: normalizeEffectPaths(repoRoot, 'reads', raw.reads)! } : {}),
    ...(raw.writes !== undefined ? { writes: normalizeEffectPaths(repoRoot, 'writes', raw.writes)! } : {}),
    ...(raw.cache !== undefined ? { cache: normalizeEffectMode('cache', raw.cache, ['read', 'write'] as const)! } : {}),
    ...(raw.temp !== undefined ? { temp: normalizeEffectMode('temp', raw.temp, ['isolated', 'shared'] as const)! } : {}),
    ...(raw.git !== undefined ? { git: normalizeEffectMode('git', raw.git, ['read', 'index', 'refs', 'write'] as const)! } : {}),
    ...(raw.network !== undefined ? { network: normalizeEffectMode('network', raw.network, ['read', 'write'] as const)! } : {}),
  };
}

function inferredPackageCheckEffects(name: string): ControllerCheckEffects | undefined {
  const normalized = name.trim().toLowerCase();
  const staticAnalysis = /(?:^|:)(?:type|typecheck|lint|format:check|runtime-architecture|mcp-compatibility|forge-runtime)$/.test(normalized);
  return staticAnalysis ? { reads: ['.'], cache: 'write' } : undefined;
}

function configuredChecks(repoRoot: string): ControllerCheck[] {
  const path = join(repoRoot, CHECK_CONFIG);
  if (!existsSync(path)) return [];
  const config = JSON.parse(readFileSync(path, 'utf-8')) as CheckConfig;
  return Object.entries(config.checks ?? {}).flatMap(([id, value]) => {
    if (!Array.isArray(value.command) || value.command.length === 0 || value.command.some((part) => typeof part !== 'string' || part.length === 0)) return [];
    return [{
      id,
      description: value.description?.trim() || `Repository check ${id}`,
      command: value.command as string[],
      cwd: normalizeCwd(repoRoot, value.cwd),
      timeoutMs: boundedTimeout(value.timeoutMs),
      source: 'repo-config' as const,
      effects: normalizeCheckEffects(repoRoot, value.effects),
    }];
  });
}

function packageScriptTimeoutMs(name: string): number {
  if (name === 'test') return Math.max(DEFAULT_TIMEOUT_MS, 30 * 60 * 1000);
  return DEFAULT_TIMEOUT_MS;
}

function packageChecks(repoRoot: string): ControllerCheck[] {
  const packagePath = join(repoRoot, 'package.json');
  if (!existsSync(packagePath)) return [];
  const pkg = JSON.parse(readFileSync(packagePath, 'utf-8')) as { scripts?: Record<string, unknown> };
  return Object.entries(pkg.scripts ?? {}).flatMap(([name, value]) => {
    if (typeof value !== 'string' || !SAFE_PACKAGE_SCRIPT.test(name)) return [];
    return [{
      id: `package:${name}`,
      description: `Run package script ${name}`,
      command: ['bun', 'run', name],
      cwd: '.',
      timeoutMs: packageScriptTimeoutMs(name),
      source: 'package-script' as const,
      effects: inferredPackageCheckEffects(name),
    }];
  });
}

export function listControllerChecks(repoRoot: string): ControllerCheck[] {
  const byId = new Map<string, ControllerCheck>();
  for (const check of [...packageChecks(repoRoot), ...configuredChecks(repoRoot)]) byId.set(check.id, check);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export interface ControllerCheckResult {
  check: ControllerCheck;
  ok: boolean;
  status: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  command: readonly string[];
  executedAt: string;
  artifactPath: string;
  /** True when this result came from content-bound evidence rather than a new process. */
  cacheHit?: boolean;
  /** Revision whose content and check definition were validated for this result. */
  validatedRevision?: string;
  /** Original process execution timestamp; retained when a result is served from cache. */
  originalExecutedAt?: string;
  /** A non-zero check result is acceptance failure; runtime/process defects are infrastructure. */
  failureClass?: 'acceptance_failure' | 'infrastructure_failure';
}

export interface ControllerCheckEvidence {
  schemaVersion: 2;
  checkId: string;
  description: string;
  source: ControllerCheck['source'];
  command: readonly string[];
  cwd: string;
  ok: boolean;
  status: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  executedAt: string;
  revision?: string;
  cacheKey?: string;
  completedRevision?: string;
  stale?: boolean;
  cacheHit?: boolean;
  validatedRevision?: string;
  originalExecutedAt?: string;
  failureClass?: 'acceptance_failure' | 'infrastructure_failure';
}

function artifactSlug(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'check';
}

function evidencePath(repoRoot: string, id: string): string {
  return join(repoRoot, CHECK_EVIDENCE_ROOT, `latest-${artifactSlug(id)}.json`);
}

function historicalEvidencePath(repoRoot: string, id: string, cacheKey: string): string {
  return join(repoRoot, CHECK_EVIDENCE_ROOT, artifactSlug(id), `${cacheKey}.json`);
}

const CHECK_REVISION_EXCLUDES = [
  '.ai/harness/jobs/**',
  '.ai/harness/local-jobs/**',
  '.ai/harness/checks/controller/**',
  '.ai/harness/edit-sessions/**',
  '.ai/harness/worktrees/**',
  '.ai/harness/controller/**',
  '.ai/harness/artifacts/**',
  '.ai/harness/local-bridge/**',
  '.ai/harness/ephemeral-issues/**',
];

function checkRevisionPathspecs(): string[] {
  return ['.', ...CHECK_REVISION_EXCLUDES.map((path) => `:(exclude)${path}`)];
}

export function currentControllerCheckRevision(repoRoot: string): string {
  const files = runProcess('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...checkRevisionPathspecs()], {
    cwd: repoRoot,
    timeoutMs: 10_000,
    maxOutputBytes: 8 * 1024 * 1024,
  });
  const revision = createHash('sha256').update('controller-check-content-v2\n');
  if (!files.ok) return revision.update(`git-error:${files.error || files.stderr}`).digest('hex').slice(0, 24);
  for (const relativePath of files.stdout.split('\0').filter(Boolean).sort()) {
    if (relativePath.startsWith('tasks/') || relativePath.startsWith('plans/')) continue;
    revision.update(`${relativePath}\0`);
    try {
      revision.update(readFileSync(resolve(repoRoot, relativePath)));
    } catch (_error) {
      revision.update('missing');
    }
  }
  return revision.digest('hex').slice(0, 24);
}

function checkDefinitionDigest(check: ControllerCheck): string {
  return createHash('sha256').update(JSON.stringify({
    id: check.id,
    description: check.description,
    command: check.command,
    cwd: check.cwd,
    timeoutMs: check.timeoutMs,
    source: check.source,
    effects: check.effects,
  })).digest('hex');
}

export function snapshotControllerCheck(repoRoot: string, id: string): ControllerCheckSnapshot {
  const check = listControllerChecks(repoRoot).find((entry) => entry.id === id);
  if (!check) throw new Error(`check not found: ${id}`);
  return {
    ...structuredClone(check),
    schemaVersion: 1,
    registryRevision: currentControllerCheckRevision(repoRoot),
    definitionDigest: checkDefinitionDigest(check),
  };
}

function validateControllerCheckSnapshot(repoRoot: string, snapshot: ControllerCheckSnapshot): ControllerCheck {
  if (snapshot.schemaVersion !== 1 || snapshot.definitionDigest !== checkDefinitionDigest(snapshot)) {
    throw new Error(`CHECK_SNAPSHOT_INVALID: ${snapshot.id}`);
  }
  // Re-run cwd validation even for persisted input so snapshots cannot escape the checkout.
  return {
    id: snapshot.id,
    description: snapshot.description,
    command: [...snapshot.command],
    cwd: normalizeCwd(repoRoot, snapshot.cwd),
    timeoutMs: boundedTimeout(snapshot.timeoutMs),
    source: snapshot.source,
    effects: normalizeCheckEffects(repoRoot, snapshot.effects),
  };
}

function checkEnvironmentFingerprint(): string {
  return createHash('sha256')
    .update(JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      bun: typeof Bun !== 'undefined' ? Bun.version : undefined,
    }))
    .digest('hex')
    .slice(0, 16);
}

function buildCheckCacheKey(check: ControllerCheck, timeoutMs: number, revision: string): string {
  return createHash('sha256')
    .update(JSON.stringify({
      id: check.id,
      command: check.command,
      cwd: check.cwd,
      timeoutMs,
      revision,
      environment: checkEnvironmentFingerprint(),
    }))
    .digest('hex')
    .slice(0, 24);
}

function persistCheckEvidence(
  repoRoot: string,
  result: Omit<ControllerCheckResult, 'artifactPath'>,
  meta: {
    revision?: string;
    cacheKey?: string;
    completedRevision?: string;
    stale?: boolean;
    cacheHit?: boolean;
    validatedRevision?: string;
  } = {},
): string {
  const path = evidencePath(repoRoot, result.check.id);
  mkdirSync(dirname(path), { recursive: true });
  const evidence: ControllerCheckEvidence = {
    schemaVersion: 2,
    checkId: result.check.id,
    description: result.check.description,
    source: result.check.source,
    command: result.command,
    cwd: result.check.cwd,
    ok: result.ok,
    status: result.status,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    executedAt: result.executedAt,
    revision: meta.revision,
    cacheKey: meta.cacheKey,
    completedRevision: meta.completedRevision,
    stale: meta.stale,
    cacheHit: meta.cacheHit,
    validatedRevision: meta.validatedRevision,
    originalExecutedAt: result.originalExecutedAt ?? result.executedAt,
    failureClass: result.failureClass,
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  atomicWriteFileSync(path, serialized);
  if (meta.cacheKey) {
    const historicalPath = historicalEvidencePath(repoRoot, result.check.id, meta.cacheKey);
    mkdirSync(dirname(historicalPath), { recursive: true });
    atomicWriteFileSync(historicalPath, serialized);
  }
  return relative(repoRoot, path).replace(/\\/g, '/');
}

export function readLatestControllerCheckEvidence(repoRoot: string, id: string): ControllerCheckEvidence | undefined {
  const path = evidencePath(repoRoot, id);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf-8')) as ControllerCheckEvidence;
    return value.schemaVersion === 2 && value.checkId === id ? value : undefined;
  } catch (_error) {
    return undefined;
  }
}

function readControllerCheckEvidenceByKey(repoRoot: string, id: string, cacheKey: string): ControllerCheckEvidence | undefined {
  const path = historicalEvidencePath(repoRoot, id, cacheKey);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf-8')) as ControllerCheckEvidence;
    return value.schemaVersion === 2 && value.checkId === id && value.cacheKey === cacheKey ? value : undefined;
  } catch (_error) {
    return undefined;
  }
}

export function runControllerCheck(repoRoot: string, id: string, requestedTimeoutMs?: number, snapshot?: ControllerCheckSnapshot): ControllerCheckResult {
  const check = snapshot ? validateControllerCheckSnapshot(repoRoot, snapshot) : listControllerChecks(repoRoot).find((entry) => entry.id === id);
  if (!check || check.id !== id) throw new Error(`check not found: ${id}`);
  const timeoutMs = requestedTimeoutMs === undefined ? check.timeoutMs : Math.min(check.timeoutMs, boundedTimeout(requestedTimeoutMs));
  const revision = currentControllerCheckRevision(repoRoot);
  const cacheKey = buildCheckCacheKey(check, timeoutMs, revision);
  const cached = readControllerCheckEvidenceByKey(repoRoot, id, cacheKey)
    ?? readLatestControllerCheckEvidence(repoRoot, id);
  if (cached?.cacheKey === cacheKey && cached.ok) {
    return {
      check,
      ok: cached.ok,
      status: cached.status,
      timedOut: cached.timedOut,
      stdout: cached.stdout,
      stderr: cached.stderr,
      command: cached.command,
      executedAt: cached.executedAt,
      artifactPath: relative(repoRoot, evidencePath(repoRoot, id)).replace(/\\/g, '/'),
      cacheHit: true,
      validatedRevision: cached.validatedRevision ?? cached.completedRevision ?? cached.revision ?? revision,
      originalExecutedAt: cached.originalExecutedAt ?? cached.executedAt,
      failureClass: cached.failureClass,
    };
  }
  const heavy = controllerCheckConcurrencyClass(id) === 'heavy';
  const lease = heavy ? tryAcquireHeavyCheckLock(repoRoot, id) : undefined;
  if (heavy && !lease) throw new Error(`heavy check already running for repository: ${id}`);
  let result: ProcessRunResult;
  try {
    const bridgeRuntime = resolveSyncSupervisorBridgeRuntime();
    const childEnvironment = repositoryChildProcessEnvironment();
    delete childEnvironment[CHECK_BRIDGE_RUNTIME_ENV];
    childEnvironment.FORGE_SUPERVISED_REQUEST = Buffer.from(JSON.stringify({
      command: check.command[0],
      args: check.command.slice(1),
      cwd: resolve(repoRoot, check.cwd),
      timeoutMs,
      maxOutputBytes: 256 * 1024,
    })).toString('base64url');
    const bridgePath = syncSupervisorBridgePath(repoRoot);
    const bridge = runProcess(bridgeRuntime, [bridgePath], {
      cwd: repoRoot,
      env: childEnvironment,
      replaceEnv: true,
      timeoutMs: timeoutMs + 5_000,
      maxOutputBytes: 1024 * 1024,
    });
    if (!bridge.ok) {
      const bridgeFailure = redactProcessOutput(
        `CHECK_SUPERVISOR_BRIDGE_FAILED: ${bridge.error || `bridge exited with status ${bridge.status}`}`,
      );
      result = {
        ok: false,
        status: bridge.status,
        signal: bridge.signal,
        timedOut: bridge.timedOut,
        command: check.command,
        stdout: capProcessOutput(redactProcessOutput(bridge.stdout), 256 * 1024),
        stderr: capProcessOutput(redactProcessOutput([bridge.stderr, bridgeFailure].filter(Boolean).join('\n')), 256 * 1024),
        error: bridgeFailure,
      };
    } else {
      try {
        const supervised = JSON.parse(bridge.stdout) as Awaited<ReturnType<typeof runBoundedChild>>;
        const error = supervised.failureCode
          ? `${supervised.failureCode}${supervised.error ? `: ${supervised.error}` : ''}`
          : supervised.error ?? '';
        result = {
          ok: supervised.status === 0 && !supervised.failureCode,
          status: supervised.status,
          signal: supervised.signal,
          timedOut: supervised.timedOut,
          command: check.command,
          stdout: capProcessOutput(redactProcessOutput(supervised.stdout), 256 * 1024),
          stderr: capProcessOutput(redactProcessOutput([supervised.stderr, error].filter(Boolean).join('\n')), 256 * 1024),
          error: redactProcessOutput(error),
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const protocolFailure = redactProcessOutput(`CHECK_SUPERVISOR_BRIDGE_PROTOCOL_INVALID: ${detail}`);
        result = {
          ok: false,
          status: 1,
          signal: null,
          timedOut: false,
          command: check.command,
          stdout: capProcessOutput(redactProcessOutput(bridge.stdout), 256 * 1024),
          stderr: protocolFailure,
          error: protocolFailure,
        };
      }
    }
  } finally {
    lease?.release();
  }
  const completedRevision = currentControllerCheckRevision(repoRoot);
  const stale = completedRevision !== revision;
  const executedAt = new Date().toISOString();
  const withoutPath = {
    check,
    ok: result.ok && !stale,
    status: stale ? 1 : result.status,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: [
      result.stderr || result.error,
      stale ? 'repository revision changed while the check was running; evidence is stale and the check must be rerun' : '',
    ].filter(Boolean).join('\n'),
    command: result.command,
    executedAt,
    cacheHit: false,
    validatedRevision: stale ? completedRevision : revision,
    originalExecutedAt: executedAt,
    failureClass: stale || result.timedOut || Boolean(result.error) || Boolean(result.signal)
      ? 'infrastructure_failure' as const
      : result.ok ? undefined : 'acceptance_failure' as const,
  };
  return {
    ...withoutPath,
    artifactPath: persistCheckEvidence(repoRoot, withoutPath, {
      revision,
      completedRevision,
      stale,
      cacheKey: stale ? undefined : cacheKey,
      cacheHit: false,
      validatedRevision: stale ? completedRevision : revision,
    }),
  };
}

export interface AsyncControllerCheckOptions {
  snapshot?: ControllerCheckSnapshot;
  requestedTimeoutMs?: number;
  onSpawn?: (pid: number) => void;
  subscriberId?: string;
}

interface ActiveAsyncCheck {
  promise: Promise<ControllerCheckResult>;
  pid?: number;
  spawnListeners: Set<(pid: number) => void>;
  subscriberIds: Set<string>;
  anonymousSubscribers: number;
  cancelWhenSpawned: boolean;
}

const activeAsyncChecks = new Map<string, ActiveAsyncCheck>();
const activeAsyncCheckSubscriptions = new Map<string, ActiveAsyncCheck>();
const heavyCheckQueues = new Map<string, Promise<void>>();

export function controllerCheckConcurrencyClass(id: string): 'heavy' | 'light' {
  return /(?:^|:)(?:test(?::coverage)?|check:(?:ci|forge-runtime|public-export|release(?:-[a-z0-9-]+)?))$/.test(id)
    ? 'heavy'
    : 'light';
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

interface HeavyCheckLockRecord {
  lockId?: string;
  pid?: number;
  controllerPid?: number;
  childPid?: number;
  checkId: string;
  createdAt: string;
}

interface HeavyCheckLease {
  setChildPid(pid: number): void;
  release(): void;
}

function tryAcquireHeavyCheckLock(repoRoot: string, checkId: string): HeavyCheckLease | undefined {
  const path = join(repoRoot, HEAVY_CHECK_LOCK);
  mkdirSync(dirname(path), { recursive: true });
  const lockId = `${process.pid}:${Date.now()}:${checkId}`;
  const record: HeavyCheckLockRecord = {
    lockId,
    controllerPid: process.pid,
    checkId,
    createdAt: new Date().toISOString(),
  };
  try {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf-8');
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let existing: HeavyCheckLockRecord | undefined;
    try {
      existing = JSON.parse(readFileSync(path, 'utf-8')) as HeavyCheckLockRecord;
    } catch (_readError) {
      existing = undefined;
    }
    const orphaned = !isProcessAlive(existing?.controllerPid ?? existing?.pid) && !isProcessAlive(existing?.childPid);
    if (!existing || orphaned) {
      rmSync(path, { force: true });
      return tryAcquireHeavyCheckLock(repoRoot, checkId);
    }
    return undefined;
  }

  const ownsLock = (): boolean => {
    try {
      return (JSON.parse(readFileSync(path, 'utf-8')) as HeavyCheckLockRecord).lockId === lockId;
    } catch (_error) {
      return false;
    }
  };
  return {
    setChildPid(pid: number): void {
      if (ownsLock()) atomicWriteFileSync(path, `${JSON.stringify({ ...record, childPid: pid })}\n`);
    },
    release(): void {
      if (ownsLock()) rmSync(path, { force: true });
    },
  };
}

async function acquireHeavyCheckLock(repoRoot: string, checkId: string): Promise<HeavyCheckLease> {
  const deadline = Date.now() + MAX_TIMEOUT_MS * 2;
  while (true) {
    const lease = tryAcquireHeavyCheckLock(repoRoot, checkId);
    if (lease) return lease;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for repository heavy-check lock before ${checkId}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

export interface ControllerCheckSubscriptionRelease {
  released: boolean;
  remainingSubscribers: number;
  terminationRequested: boolean;
  pid?: number;
}

export function releaseControllerCheckSubscription(subscriberId: string): ControllerCheckSubscriptionRelease {
  const active = activeAsyncCheckSubscriptions.get(subscriberId);
  if (!active) return { released: false, remainingSubscribers: 0, terminationRequested: false };
  activeAsyncCheckSubscriptions.delete(subscriberId);
  active.subscriberIds.delete(subscriberId);
  const remainingSubscribers = active.subscriberIds.size + active.anonymousSubscribers;
  if (remainingSubscribers > 0) {
    return { released: true, remainingSubscribers, terminationRequested: false, pid: active.pid };
  }
  active.cancelWhenSpawned = true;
  if (active.pid) signalProcessTree(active.pid, 'SIGTERM');
  return {
    released: true,
    remainingSubscribers: 0,
    terminationRequested: true,
    pid: active.pid,
  };
}

async function executeControllerCheckAsync(
  repoRoot: string,
  check: ControllerCheck,
  timeoutMs: number,
  onSpawn?: (pid: number) => void,
): Promise<ControllerCheckResult> {
  const maxOutputBytes = 256 * 1024;
  const command = [check.command[0], ...check.command.slice(1)];
  const supervised = await runBoundedChild(check.command[0], check.command.slice(1), {
    cwd: resolve(repoRoot, check.cwd),
    env: repositoryChildProcessEnvironment(),
    timeoutMs,
    maxOutputBytes,
    stdio: 'capture',
    onSpawn,
    termination: { gracePeriodMs: 100, killAfterMs: 2_000, pollIntervalMs: 25 },
  });
  const processTreeError = supervised.failureCode
    ? `${supervised.failureCode}${supervised.remainingPids.length > 0 ? `; remaining processes: ${supervised.remainingPids.join(', ')}` : ''}`
    : '';
  const timeoutMessage = supervised.timedOut
    ? `process timed out after ${timeoutMs}ms: ${command.join(' ')}`
    : '';
  const result = {
    ok: supervised.status === 0 && !supervised.failureCode,
    status: supervised.status,
    timedOut: supervised.timedOut,
    stdout: capProcessOutput(redactProcessOutput(supervised.stdout), maxOutputBytes),
    stderr: capProcessOutput(redactProcessOutput([
      supervised.stderr,
      timeoutMessage || supervised.error || '',
      processTreeError,
    ].filter(Boolean).join('\n')), maxOutputBytes),
    failureClass: supervised.failureCode
      ? 'infrastructure_failure' as const
      : supervised.status === 0 ? undefined : 'acceptance_failure' as const,
  };

  const executedAt = new Date().toISOString();
  const withoutPath = {
    check,
    ok: result.ok,
    status: result.status,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    command: command.map((part) => redactProcessOutput(part)),
    executedAt,
    cacheHit: false,
    validatedRevision: undefined,
    originalExecutedAt: executedAt,
    failureClass: result.failureClass,
  };
  return { ...withoutPath, artifactPath: relative(repoRoot, evidencePath(repoRoot, check.id)).replace(/\\/g, '/') };
}

export function runControllerCheckAsync(
  repoRoot: string,
  id: string,
  options: AsyncControllerCheckOptions = {},
): Promise<ControllerCheckResult> {
  let check: ControllerCheck | undefined;
  try {
    check = options.snapshot ? validateControllerCheckSnapshot(repoRoot, options.snapshot) : listControllerChecks(repoRoot).find((entry) => entry.id === id);
  } catch (error) {
    return Promise.reject(error);
  }
  if (!check || check.id !== id) return Promise.reject(new Error(`check not found: ${id}`));
  const timeoutMs = options.requestedTimeoutMs === undefined
    ? check.timeoutMs
    : Math.min(check.timeoutMs, boundedTimeout(options.requestedTimeoutMs));
  const revision = currentControllerCheckRevision(repoRoot);
  const cacheKey = buildCheckCacheKey(check, timeoutMs, revision);
  const cached = readControllerCheckEvidenceByKey(repoRoot, id, cacheKey)
    ?? readLatestControllerCheckEvidence(repoRoot, id);
  if (cached?.cacheKey === cacheKey && cached.ok) {
    return Promise.resolve({
      check,
      ok: cached.ok,
      status: cached.status,
      timedOut: cached.timedOut,
      stdout: cached.stdout,
      stderr: cached.stderr,
      command: cached.command,
      executedAt: cached.executedAt,
      artifactPath: relative(repoRoot, evidencePath(repoRoot, id)).replace(/\\/g, '/'),
      cacheHit: true,
      validatedRevision: cached.validatedRevision ?? cached.completedRevision ?? cached.revision ?? revision,
      originalExecutedAt: cached.originalExecutedAt ?? cached.executedAt,
      failureClass: cached.failureClass,
    });
  }
  const key = `${resolve(repoRoot)}\u0000${id}\u0000${cacheKey}`;
  const existing = activeAsyncChecks.get(key);
  if (existing) {
    if (options.subscriberId) {
      existing.subscriberIds.add(options.subscriberId);
      activeAsyncCheckSubscriptions.set(options.subscriberId, existing);
    } else {
      existing.anonymousSubscribers += 1;
    }
    if (options.onSpawn) {
      if (existing.pid) options.onSpawn(existing.pid);
      else existing.spawnListeners.add(options.onSpawn);
    }
    return existing.promise;
  }

  const active: ActiveAsyncCheck = {
    promise: Promise.resolve(undefined as never),
    spawnListeners: new Set(),
    subscriberIds: new Set(),
    anonymousSubscribers: options.subscriberId ? 0 : 1,
    cancelWhenSpawned: false,
  };
  if (options.subscriberId) {
    active.subscriberIds.add(options.subscriberId);
    activeAsyncCheckSubscriptions.set(options.subscriberId, active);
  }
  if (options.onSpawn) active.spawnListeners.add(options.onSpawn);
  const notifySpawn = (pid: number): void => {
    active.pid = pid;
    if (active.cancelWhenSpawned && active.subscriberIds.size === 0 && active.anonymousSubscribers === 0) {
      signalProcessTree(pid, 'SIGTERM');
    }
    for (const listener of active.spawnListeners) listener(pid);
    active.spawnListeners.clear();
  };
  const hasActiveSubscribers = (): boolean => active.subscriberIds.size + active.anonymousSubscribers > 0;
  const assertExecutionStillRequested = (): void => {
    if (active.cancelWhenSpawned && !hasActiveSubscribers()) {
      throw new Error(`check execution canceled before process start: ${id}`);
    }
  };
  const execute = async (lease?: HeavyCheckLease) => {
    assertExecutionStillRequested();
    const result = await executeControllerCheckAsync(repoRoot, check, timeoutMs, (pid) => {
      lease?.setChildPid(pid);
      notifySpawn(pid);
    });
    const completedRevision = currentControllerCheckRevision(repoRoot);
    const stale = completedRevision !== revision;
    const finalized = {
      ...result,
      ...(stale ? {
        ok: false,
        status: 1,
        stderr: [
          result.stderr,
          'repository revision changed while the check was running; evidence is stale and the check must be rerun',
        ].filter(Boolean).join('\n'),
        failureClass: 'infrastructure_failure' as const,
      } : {}),
      cacheHit: false,
      validatedRevision: stale ? completedRevision : revision,
    };
    const { artifactPath: _artifactPath, ...withoutPath } = finalized;
    const artifactPath = persistCheckEvidence(repoRoot, withoutPath, {
      revision,
      completedRevision,
      stale,
      cacheKey: stale ? undefined : cacheKey,
      cacheHit: false,
      validatedRevision: stale ? completedRevision : revision,
    });
    return { ...finalized, artifactPath };
  };
  const executeHeavy = async (): Promise<ControllerCheckResult> => {
    assertExecutionStillRequested();
    const lease = await acquireHeavyCheckLock(repoRoot, id);
    try {
      assertExecutionStillRequested();
      const currentRevision = currentControllerCheckRevision(repoRoot);
      if (currentRevision !== revision) {
        throw new Error(`repository revision changed while heavy check ${id} was queued; resubmit the check`);
      }
      const refreshed = readControllerCheckEvidenceByKey(repoRoot, id, cacheKey)
        ?? readLatestControllerCheckEvidence(repoRoot, id);
      if (refreshed?.cacheKey === cacheKey && refreshed.ok) {
        return {
          check,
          ok: refreshed.ok,
          status: refreshed.status,
          timedOut: refreshed.timedOut,
          stdout: refreshed.stdout,
          stderr: refreshed.stderr,
          command: refreshed.command,
          executedAt: refreshed.executedAt,
          artifactPath: relative(repoRoot, evidencePath(repoRoot, id)).replace(/\\/g, '/'),
          cacheHit: true,
          validatedRevision: refreshed.validatedRevision ?? refreshed.completedRevision ?? refreshed.revision ?? revision,
          originalExecutedAt: refreshed.originalExecutedAt ?? refreshed.executedAt,
          failureClass: refreshed.failureClass,
        };
      }
      return execute(lease);
    } finally {
      lease.release();
    }
  };
  const promise = controllerCheckConcurrencyClass(id) === 'heavy'
    ? (() => {
        const repoKey = resolve(repoRoot);
        const previous = heavyCheckQueues.get(repoKey) ?? Promise.resolve();
        const queued = previous.catch(() => undefined).then(executeHeavy);
        const tail = queued.then(() => undefined, () => undefined);
        heavyCheckQueues.set(repoKey, tail);
        void tail.then(() => {
          if (heavyCheckQueues.get(repoKey) === tail) heavyCheckQueues.delete(repoKey);
        });
        return queued;
      })()
    : execute();

  active.promise = promise;
  activeAsyncChecks.set(key, active);
  const cleanup = () => {
    if (activeAsyncChecks.get(key) === active) activeAsyncChecks.delete(key);
    for (const subscriberId of active.subscriberIds) {
      if (activeAsyncCheckSubscriptions.get(subscriberId) === active) {
        activeAsyncCheckSubscriptions.delete(subscriberId);
      }
    }
    active.subscriberIds.clear();
    active.spawnListeners.clear();
  };
  void promise.then(cleanup, cleanup);
  return promise;
}
