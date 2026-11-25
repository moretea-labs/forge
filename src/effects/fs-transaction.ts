import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import { basename, dirname, relative, resolve } from 'path';
import type {
  AdoptionOperation,
  AdoptionOperationStatus,
  AdoptionPlan,
  AppendManagedBlockOperation,
  MkdirOperation,
  WriteFileOperation,
} from '../core/adoption/operations';
import { isWorkflowContractInstallOperation } from '../core/adoption/workflow-contract-plan';
import { resolveInsideRepo, resolveParentInsideRepo } from './path-safety';
import { upsertManagedBlock } from './managed-block';

const BACKUP_ROOT = '.ai/harness/backups/fs-transaction';
export const SAFE_PATCH_TRANSACTION_ROOT = '.ai/harness/safe-patch-transactions';
const LOCK_SUFFIX = '.forge.lock';
const EMPTY_LOCK_STALE_AFTER_MS = 30_000;
let atomicWriteSequence = 0;
let transactionSequence = 0;
let safePatchTransactionSequence = 0;

export function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const temporaryPath = filePath + '.tmp-' + process.pid + '-' + Date.now();
  writeFileSync(temporaryPath, content, 'utf-8');
  renameSync(temporaryPath, filePath);
}

export interface ApplyOperationResult {
  readonly id: string;
  readonly kind: AdoptionOperation['kind'];
  readonly path?: string;
  readonly status: AdoptionOperationStatus;
  readonly backupPath?: string;
  readonly contentHash?: string;
  readonly error?: string;
}

export interface ApplyAdoptionPlanResult {
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly results: readonly ApplyOperationResult[];
  readonly transactionManifestPath?: string;
}

export interface FsTransactionManifestOperation {
  readonly id: string;
  readonly kind: AdoptionOperation['kind'];
  readonly path?: string;
  readonly status: AdoptionOperationStatus;
  readonly backupPath?: string;
  readonly contentHash?: string;
  readonly rollbackStrategy?: string;
  readonly error?: string;
}

export interface FsTransactionManifest {
  readonly protocol: 1;
  readonly command: 'adopt';
  readonly createdAt: string;
  readonly repoRoot: string;
  readonly mode: AdoptionPlan['mode'];
  readonly operations: readonly FsTransactionManifestOperation[];
  readonly rollback: {
    readonly command: string;
  };
}

export interface RollbackOperationResult {
  readonly id: string;
  readonly kind: AdoptionOperation['kind'];
  readonly path?: string;
  readonly status: 'rolled_back' | 'skipped' | 'failed';
  readonly action: 'restore_backup' | 'delete_created_file' | 'remove_empty_directory' | 'none';
  readonly error?: string;
}

export interface RollbackAdoptionTransactionResult {
  readonly protocol: 1;
  readonly command: 'adopt rollback';
  readonly repoRoot: string;
  readonly transactionManifestPath: string;
  readonly ok: boolean;
  readonly results: readonly RollbackOperationResult[];
}

function failure(operation: AdoptionOperation, error: string): ApplyOperationResult {
  return {
    id: operation.id,
    kind: operation.kind,
    path: operation.path,
    status: 'failed',
    error,
  };
}

export function isSupportedAdoptionOperation(operation: AdoptionOperation): boolean {
  if (operation.kind === 'mkdir' || operation.kind === 'appendManagedBlock') return true;
  return (
    operation.kind === 'writeFile' && (operation.ifMissing === true || isWorkflowContractInstallOperation(operation))
  );
}

function unsupportedOperationReason(operation: AdoptionOperation): string {
  if (operation.kind === 'writeFile') {
    return 'writeFile applicator only supports ifMissing operations and workflow-contract install';
  }
  return `unsupported operation kind: ${operation.kind}`;
}

function ensureParent(repoRoot: string, path: string): string | null {
  const parent = resolveParentInsideRepo(repoRoot, path);
  if (!parent.ok || !parent.path) return parent.error ?? 'failed to resolve parent directory';
  mkdirSync(parent.path, { recursive: true });
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fsyncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EINVAL', 'EPERM', 'ENOTSUP', 'EISDIR'].includes(code ?? '')) throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function writeFileDurably(path: string, content: string, mode?: number): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, mode);
    const data = Buffer.from(content);
    let offset = 0;
    while (offset < data.length) {
      offset += writeSync(fd, data, offset, data.length - offset);
    }
    fsyncSync(fd);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function sanitizeBackupStem(path: string): string {
  return path.replace(/[^a-zA-Z0-9._-]+/g, '__').replace(/^_+|_+$/g, '') || 'file';
}

function contentHash(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function backupPathFor(path: string, backupRoot = BACKUP_ROOT): string {
  atomicWriteSequence += 1;
  return `${backupRoot}/${sanitizeBackupStem(path)}.${Date.now()}-${process.pid}-${atomicWriteSequence}.bak`;
}

function transactionDirFor(): string {
  transactionSequence += 1;
  return `${BACKUP_ROOT}/${Date.now()}-${process.pid}-${transactionSequence}`;
}

const TARGET_LOCK_WAIT_STATE = new Int32Array(new SharedArrayBuffer(4));

function targetLockOwnerIsGone(lockPath: string): boolean {
  let raw = '';
  try {
    raw = readFileSync(lockPath, 'utf-8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }
  const pid = Number(raw);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ESRCH';
    }
  }
  try {
    return Date.now() - statSync(lockPath).mtimeMs >= EMPTY_LOCK_STALE_AFTER_MS;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function acquireTargetLock(lockPath: string, busyRetries = 0, retryDelayMs = 0): number {
  for (let attempt = 0; ; attempt++) {
    try {
      return openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      if (targetLockOwnerIsGone(lockPath)) {
        rmSync(lockPath, { force: true });
        fsyncDirectory(dirname(lockPath));
        continue;
      }
      if (attempt >= busyRetries) throw error;
      Atomics.wait(TARGET_LOCK_WAIT_STATE, 0, 0, retryDelayMs);
    }
  }
}

function withTargetLock<T>(
  targetPath: string,
  fn: () => T,
  options: { busyRetries?: number; retryDelayMs?: number } = {},
): T {
  const lockPath = `${targetPath}${LOCK_SUFFIX}`;
  let fd: number | null = null;
  let locked = false;
  try {
    fd = acquireTargetLock(lockPath, options.busyRetries ?? 0, options.retryDelayMs ?? 0);
    locked = true;
    writeSync(fd, `${process.pid}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    return fn();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new Error(`target is locked: ${lockPath}`);
    throw error;
  } finally {
    if (fd !== null) closeSync(fd);
    if (locked) {
      rmSync(lockPath, { force: true });
      fsyncDirectory(dirname(targetPath));
    }
  }
}

function withTargetLocks<T>(
  targetPaths: string[],
  fn: () => T,
  options: { busyRetries?: number; retryDelayMs?: number } = {},
): T {
  const ordered = [...new Set(targetPaths)].sort();
  const acquire = (index: number): T => {
    const targetPath = ordered[index];
    if (!targetPath) return fn();
    return withTargetLock(targetPath, () => acquire(index + 1), options);
  };
  return acquire(0);
}

export interface AtomicTextGroupEntry {
  readonly path: string;
  readonly expectedSha256: string;
  readonly after: string;
}

export interface AtomicTextGroupReceipt {
  readonly path: string;
  readonly beforeSha256: string;
  readonly afterSha256: string;
}

type AtomicTextGroupTransactionStatus = 'prepared' | 'committing' | 'committed';

interface AtomicTextGroupManifestEntry extends AtomicTextGroupReceipt {
  readonly beforeSnapshot: string;
  readonly afterSnapshot: string;
  readonly mode: number;
}

export interface AtomicTextGroupTransactionManifest {
  readonly protocol: 1;
  readonly kind: 'safe-patch-text-group';
  readonly transactionId: string;
  readonly createdAt: string;
  readonly status: AtomicTextGroupTransactionStatus;
  readonly entries: readonly AtomicTextGroupManifestEntry[];
}

function safePatchTransactionRootPath(repoRoot: string): string {
  const resolved = resolveInsideRepo(repoRoot, SAFE_PATCH_TRANSACTION_ROOT);
  if (!resolved.ok || !resolved.path) throw new Error(resolved.error ?? 'invalid Safe Patch transaction root');
  return resolved.path;
}

function writeJsonDurably(path: string, value: unknown): void {
  const temporary = path + '.' + process.pid + '.' + Date.now() + '.tmp';
  try {
    writeFileDurably(temporary, JSON.stringify(value, null, 2) + '\n', 0o600);
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
  } finally {
    rmSync(temporary, { force: true });
  }
}

function safePatchTransactionDir(repoRoot: string): { transactionId: string; root: string; path: string } {
  const root = safePatchTransactionRootPath(repoRoot);
  mkdirSync(root, { recursive: true });
  fsyncDirectory(dirname(root));
  safePatchTransactionSequence += 1;
  const transactionId = String(Date.now()) + '-' + process.pid + '-' + safePatchTransactionSequence;
  const path = resolve(root, transactionId);
  mkdirSync(path, { recursive: false, mode: 0o700 });
  fsyncDirectory(root);
  return { transactionId, root, path };
}

function manifestPath(transactionPath: string): string {
  return resolve(transactionPath, 'manifest.json');
}

function readAtomicTextGroupManifest(transactionPath: string): AtomicTextGroupTransactionManifest {
  const parsed = JSON.parse(readFileSync(manifestPath(transactionPath), 'utf-8')) as AtomicTextGroupTransactionManifest;
  if (
    parsed?.protocol !== 1 ||
    parsed.kind !== 'safe-patch-text-group' ||
    typeof parsed.transactionId !== 'string' ||
    !['prepared', 'committing', 'committed'].includes(parsed.status) ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length < 2
  ) {
    throw new Error('SAFE_PATCH_TRANSACTION_INVALID: ' + transactionPath);
  }
  for (const entry of parsed.entries) {
    if (
      typeof entry?.path !== 'string' ||
      typeof entry.beforeSha256 !== 'string' ||
      typeof entry.afterSha256 !== 'string' ||
      !/^\d{3}\.before$/.test(entry.beforeSnapshot) ||
      !/^\d{3}\.after$/.test(entry.afterSnapshot) ||
      !Number.isInteger(entry.mode)
    ) {
      throw new Error('SAFE_PATCH_TRANSACTION_INVALID: ' + transactionPath);
    }
  }
  return parsed;
}

function updateAtomicTextGroupManifest(
  transactionPath: string,
  manifest: AtomicTextGroupTransactionManifest,
  status: AtomicTextGroupTransactionStatus,
): AtomicTextGroupTransactionManifest {
  const next = { ...manifest, status };
  writeJsonDurably(manifestPath(transactionPath), next);
  return next;
}

function removeSafePatchTransaction(root: string, transactionPath: string): void {
  rmSync(transactionPath, { recursive: true, force: true });
  fsyncDirectory(root);
}

function restoreTextSnapshot(targetPath: string, snapshotContent: string, mode: number): void {
  const temporary = resolve(
    dirname(targetPath),
    '.' + basename(targetPath) + '.' + process.pid + '.' + Date.now() + '.rollback.tmp',
  );
  try {
    writeFileDurably(temporary, snapshotContent, mode);
    renameSync(temporary, targetPath);
    fsyncDirectory(dirname(targetPath));
  } finally {
    rmSync(temporary, { force: true });
  }
}

function rollbackAtomicTextGroupTransactionLocked(
  repoRoot: string,
  root: string,
  transactionPath: string,
  targets: readonly string[],
): void {
  if (!existsSync(manifestPath(transactionPath))) return;
  const manifest = readAtomicTextGroupManifest(transactionPath);
  if (manifest.status === 'committed' || manifest.status === 'prepared') {
    removeSafePatchTransaction(root, transactionPath);
    return;
  }
  const states = manifest.entries.map((entry, index) => {
    const targetPath = targets[index]!;
    if (!targetPath || !existsSync(targetPath)) {
      throw new Error('SAFE_PATCH_TRANSACTION_RECOVERY_CONFLICT: ' + entry.path + ' is missing');
    }
    const resolved = resolveInsideRepo(repoRoot, entry.path);
    if (!resolved.ok || resolved.path !== targetPath) {
      throw new Error('SAFE_PATCH_TRANSACTION_RECOVERY_CONFLICT: invalid target identity for ' + entry.path);
    }
    statModeForCas(targetPath);
    const currentSha256 = createHash('sha256').update(readFileSync(targetPath, 'utf-8')).digest('hex');
    if (currentSha256 !== entry.beforeSha256 && currentSha256 !== entry.afterSha256) {
      throw new Error(
        'SAFE_PATCH_TRANSACTION_RECOVERY_CONFLICT: ' + entry.path + ' diverged from both transaction images',
      );
    }
    if (currentSha256 !== entry.beforeSha256) {
      const snapshotPath = resolve(transactionPath, entry.beforeSnapshot);
      const beforeContent = readFileSync(snapshotPath, 'utf-8');
      const snapshotSha256 = createHash('sha256').update(beforeContent).digest('hex');
      if (snapshotSha256 !== entry.beforeSha256) {
        throw new Error('SAFE_PATCH_TRANSACTION_SNAPSHOT_INVALID: ' + entry.path);
      }
      return { entry, targetPath, currentSha256, beforeContent };
    }
    return { entry, targetPath, currentSha256, beforeContent: undefined };
  });
  // Validate every before-image before restoring the first target. A corrupt
  // later snapshot must never leave an otherwise recoverable group half-rolled-back.
  for (const state of states) {
    if (state.currentSha256 !== state.entry.afterSha256 || state.beforeContent === undefined) continue;
    restoreTextSnapshot(state.targetPath, state.beforeContent, state.entry.mode);
  }
  removeSafePatchTransaction(root, transactionPath);
}

function recoverAtomicTextGroupTransaction(repoRoot: string, root: string, transactionPath: string): void {
  if (!existsSync(manifestPath(transactionPath))) return;
  const initial = readAtomicTextGroupManifest(transactionPath);
  const targets = initial.entries.map((entry) => {
    const resolved = resolveInsideRepo(repoRoot, entry.path);
    if (!resolved.ok || !resolved.path) throw new Error(resolved.error ?? 'invalid transaction path: ' + entry.path);
    return resolved.path;
  });
  withTargetLocks(targets, () => rollbackAtomicTextGroupTransactionLocked(repoRoot, root, transactionPath, targets), {
    busyRetries: 12,
    retryDelayMs: 5,
  });
}

/**
 * Recover incomplete multi-file Safe Patch text transactions that overlap the
 * requested paths. A transaction that returned success is marked committed;
 * any crash before that point is rolled back to its complete before-image.
 */
export function recoverPendingAtomicTextGroups(repoRoot: string, overlappingPaths?: readonly string[]): number {
  const root = safePatchTransactionRootPath(repoRoot);
  if (!existsSync(root)) return 0;
  const overlap = overlappingPaths ? new Set(overlappingPaths) : undefined;
  let recovered = 0;
  for (const name of readdirSync(root).sort()) {
    const transactionPath = resolve(root, name);
    if (!existsSync(manifestPath(transactionPath))) continue;
    const manifest = readAtomicTextGroupManifest(transactionPath);
    if (overlap && !manifest.entries.some((entry) => overlap.has(entry.path))) continue;
    recoverAtomicTextGroupTransaction(repoRoot, root, transactionPath);
    recovered += 1;
  }
  return recovered;
}

/**
 * Crash-recoverable all-or-none writer for an explicit multi-file text
 * Semantic Change Group. All target locks are acquired in stable path order,
 * every CAS is checked before mutation, and durable before/after images are
 * persisted before the first target rename.
 */
export function atomicCompareAndSwapTextGroup(
  repoRoot: string,
  entries: readonly AtomicTextGroupEntry[],
): { receipts: AtomicTextGroupReceipt[] } {
  if (entries.length < 2) throw new Error('ATOMIC_TEXT_GROUP_REQUIRES_MULTIPLE_PATHS');
  const normalized = entries.map((entry) => {
    const target = resolveInsideRepo(repoRoot, entry.path);
    if (!target.ok || !target.path) throw new Error(target.error ?? 'invalid path: ' + entry.path);
    return { ...entry, targetPath: target.path };
  });
  if (new Set(normalized.map((entry) => entry.targetPath)).size !== normalized.length) {
    throw new Error('ATOMIC_TEXT_GROUP_DUPLICATE_PATH');
  }

  recoverPendingAtomicTextGroups(
    repoRoot,
    normalized.map((entry) => entry.path),
  );

  return withTargetLocks(
    normalized.map((entry) => entry.targetPath),
    () => {
      const beforeImages = normalized.map((entry) => {
        if (!existsSync(entry.targetPath)) throw new Error('TARGET_MISSING: ' + entry.path);
        const mode = statModeForCas(entry.targetPath);
        const before = readFileSync(entry.targetPath, 'utf-8');
        const beforeSha256 = createHash('sha256').update(before).digest('hex');
        if (beforeSha256 !== entry.expectedSha256) {
          throw new Error(
            'STALE_FILE_SHA: ' + entry.path + ': expected ' + entry.expectedSha256 + ', got ' + beforeSha256,
          );
        }
        if (before === entry.after) throw new Error('NO_CHANGE: ' + entry.path);
        return {
          ...entry,
          before,
          beforeSha256,
          afterSha256: createHash('sha256').update(entry.after).digest('hex'),
          mode,
        };
      });

      const transaction = safePatchTransactionDir(repoRoot);
      let manifest: AtomicTextGroupTransactionManifest = {
        protocol: 1,
        kind: 'safe-patch-text-group',
        transactionId: transaction.transactionId,
        createdAt: new Date().toISOString(),
        status: 'prepared',
        entries: [],
      };
      try {
        const manifestEntries: AtomicTextGroupManifestEntry[] = [];
        beforeImages.forEach((entry, index) => {
          const prefix = String(index + 1).padStart(3, '0');
          const beforeSnapshot = prefix + '.before';
          const afterSnapshot = prefix + '.after';
          writeFileDurably(resolve(transaction.path, beforeSnapshot), entry.before, 0o600);
          writeFileDurably(resolve(transaction.path, afterSnapshot), entry.after, 0o600);
          manifestEntries.push({
            path: entry.path,
            beforeSha256: entry.beforeSha256,
            afterSha256: entry.afterSha256,
            beforeSnapshot,
            afterSnapshot,
            mode: entry.mode,
          });
        });
        fsyncDirectory(transaction.path);
        manifest = { ...manifest, entries: manifestEntries };
        writeJsonDurably(manifestPath(transaction.path), manifest);
        manifest = updateAtomicTextGroupManifest(transaction.path, manifest, 'committing');

        for (const entry of beforeImages) {
          const temporary = resolve(
            dirname(entry.targetPath),
            '.' + basename(entry.targetPath) + '.' + process.pid + '.' + Date.now() + '.group.tmp',
          );
          try {
            writeFileDurably(temporary, entry.after, entry.mode);
            renameSync(temporary, entry.targetPath);
            fsyncDirectory(dirname(entry.targetPath));
          } finally {
            rmSync(temporary, { force: true });
          }
        }

        manifest = updateAtomicTextGroupManifest(transaction.path, manifest, 'committed');
        const receipts = manifest.entries.map((entry) => ({
          path: entry.path,
          beforeSha256: entry.beforeSha256,
          afterSha256: entry.afterSha256,
        }));
        // The durable committed manifest is the commit point. Cleanup after
        // that point is best-effort; a later recovery scan can reclaim it
        // without turning a successful source mutation into a false failure.
        try {
          removeSafePatchTransaction(transaction.root, transaction.path);
        } catch {
          // Retain the committed journal for the next recovery scan.
        }
        return { receipts };
      } catch (error) {
        try {
          if (existsSync(manifestPath(transaction.path))) {
            rollbackAtomicTextGroupTransactionLocked(
              repoRoot,
              transaction.root,
              transaction.path,
              beforeImages.map((entry) => entry.targetPath),
            );
          } else {
            removeSafePatchTransaction(transaction.root, transaction.path);
          }
        } catch (recoveryError) {
          const original = errorMessage(error);
          const recovery = errorMessage(recoveryError);
          throw new Error('ATOMIC_TEXT_GROUP_RECOVERY_REQUIRED: ' + original + '; recovery failed: ' + recovery);
        }
        throw error;
      }
    },
    { busyRetries: 12, retryDelayMs: 5 },
  );
}

/**
 * Sessionless single-file source mutation. The expected hash is checked
 * INSIDE the existing target lock before any bytes change. Unlike the legacy
 * retired persistent edit lifecycle, this creates no persistent backup or editing history:
 * a crash before rename leaves the old file, after rename leaves the new one.
 */
export function atomicCompareAndSwapText(
  repoRoot: string,
  path: string,
  expectedSha256: string,
  after: string,
): { beforeSha256: string; afterSha256: string } {
  const target = resolveInsideRepo(repoRoot, path);
  if (!target.ok || !target.path) throw new Error(target.error ?? 'invalid path');
  const targetPath = target.path;
  if (!existsSync(targetPath)) throw new Error(`TARGET_MISSING: ${path}`);
  return withTargetLock(
    targetPath,
    () => {
      // A symlink target is not eligible for sessionless replacement: callers
      // must not have a rename swap the symlink itself behind an alias.
      const before = readFileSync(targetPath, 'utf-8');
      const currentHash = createHash('sha256').update(before).digest('hex');
      if (currentHash !== expectedSha256) {
        throw new Error(`STALE_FILE_SHA: ${path}: expected ${expectedSha256}, got ${currentHash}`);
      }
      if (before === after) throw new Error(`NO_CHANGE: ${path}`);
      const mode = statModeForCas(targetPath);
      const temporary = resolve(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${Date.now()}.cas.tmp`);
      try {
        writeFileDurably(temporary, after, mode);
        renameSync(temporary, targetPath);
        fsyncDirectory(dirname(targetPath));
      } finally {
        rmSync(temporary, { force: true });
      }
      return {
        beforeSha256: currentHash,
        afterSha256: createHash('sha256').update(after).digest('hex'),
      };
    },
    { busyRetries: 12, retryDelayMs: 5 },
  );
}

function statModeForCas(targetPath: string): number {
  // Defer fs stat lookup until after the target lock is acquired; source mode
  // is part of the same immutable write attempt as the expected content.
  const stat = lstatSync(targetPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`CAS_TARGET_NOT_REGULAR_FILE: ${targetPath}`);
  return stat.mode & 0o777;
}

/** Sessionless create with an atomic no-overwrite publish step. */
export function atomicCreateText(repoRoot: string, path: string, content: string): { afterSha256: string } {
  const target = resolveInsideRepo(repoRoot, path);
  if (!target.ok || !target.path) throw new Error(target.error ?? 'invalid path');
  const parentError = ensureParent(repoRoot, path);
  if (parentError) throw new Error(parentError);
  const targetPath = target.path;
  return withTargetLock(targetPath, () => {
    if (existsSync(targetPath)) throw new Error(`CREATE_TARGET_EXISTS: ${path}`);
    const temporary = resolve(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${Date.now()}.create.tmp`);
    try {
      writeFileDurably(temporary, content);
      try {
        linkSync(temporary, targetPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`CREATE_TARGET_EXISTS: ${path}`);
        throw error;
      }
      fsyncDirectory(dirname(targetPath));
    } finally {
      rmSync(temporary, { force: true });
      fsyncDirectory(dirname(targetPath));
    }
    return { afterSha256: createHash('sha256').update(content).digest('hex') };
  });
}

/** Sessionless strict move. Source SHA and destination vacancy are checked under ordered dual-path locks. */
export function atomicCompareAndMoveText(
  repoRoot: string,
  path: string,
  toPath: string,
  expectedSha256: string,
): { beforeSha256: string; afterSha256: string } {
  const source = resolveInsideRepo(repoRoot, path);
  const destination = resolveInsideRepo(repoRoot, toPath);
  if (!source.ok || !source.path) throw new Error(source.error ?? 'invalid source path');
  if (!destination.ok || !destination.path) throw new Error(destination.error ?? 'invalid destination path');
  if (source.path === destination.path) throw new Error(`NO_CHANGE: ${path}`);
  const parentError = ensureParent(repoRoot, toPath);
  if (parentError) throw new Error(parentError);

  return withTargetLocks(
    [source.path, destination.path],
    () => {
      if (!existsSync(source.path!)) throw new Error(`TARGET_MISSING: ${path}`);
      statModeForCas(source.path!);
      if (existsSync(destination.path!)) throw new Error(`MOVE_TARGET_EXISTS: ${toPath}`);
      const before = readFileSync(source.path!, 'utf-8');
      const currentHash = createHash('sha256').update(before).digest('hex');
      if (currentHash !== expectedSha256) {
        throw new Error(`STALE_FILE_SHA: ${path}: expected ${expectedSha256}, got ${currentHash}`);
      }
      renameSync(source.path!, destination.path!);
      fsyncDirectory(dirname(source.path!));
      if (dirname(destination.path!) !== dirname(source.path!)) fsyncDirectory(dirname(destination.path!));
      return { beforeSha256: currentHash, afterSha256: currentHash };
    },
    { busyRetries: 12, retryDelayMs: 5 },
  );
}

/** Sessionless strict delete. The file is removed only if its full-file CAS still matches. */
export function atomicCompareAndDeleteText(
  repoRoot: string,
  path: string,
  expectedSha256: string,
): { beforeSha256: string } {
  const target = resolveInsideRepo(repoRoot, path);
  if (!target.ok || !target.path) throw new Error(target.error ?? 'invalid path');
  const targetPath = target.path;
  return withTargetLock(targetPath, () => {
    if (!existsSync(targetPath)) throw new Error(`TARGET_MISSING: ${path}`);
    statModeForCas(targetPath);
    const before = readFileSync(targetPath, 'utf-8');
    const currentHash = createHash('sha256').update(before).digest('hex');
    if (currentHash !== expectedSha256) {
      throw new Error(`STALE_FILE_SHA: ${path}: expected ${expectedSha256}, got ${currentHash}`);
    }
    rmSync(targetPath);
    fsyncDirectory(dirname(targetPath));
    return { beforeSha256: currentHash };
  });
}

export interface AtomicWriteResult {
  readonly backupPath?: string;
}

export function atomicWriteFile(
  repoRoot: string,
  path: string,
  content: string,
  opts: { readonly mode?: number; readonly backupRoot?: string } = {},
): AtomicWriteResult {
  const target = resolveInsideRepo(repoRoot, path);
  if (!target.ok || !target.path) throw new Error(target.error ?? 'invalid path');
  const targetPath = target.path;
  const parentError = ensureParent(repoRoot, path);
  if (parentError) throw new Error(parentError);

  return withTargetLock(targetPath, () => {
    let backupPath: string | undefined;
    if (existsSync(targetPath)) {
      backupPath = backupPathFor(path, opts.backupRoot);
      const backup = resolveInsideRepo(repoRoot, backupPath);
      if (!backup.ok || !backup.path) throw new Error(backup.error ?? 'invalid backup path');
      const resolvedBackupPath = backup.path;
      const backupParentError = ensureParent(repoRoot, backupPath);
      if (backupParentError) throw new Error(backupParentError);
      writeFileDurably(resolvedBackupPath, readFileSync(targetPath, 'utf-8'));
      fsyncDirectory(dirname(resolvedBackupPath));
    }

    const tempPath = resolve(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
    try {
      writeFileDurably(tempPath, content, opts.mode);
      renameSync(tempPath, targetPath);
      fsyncDirectory(dirname(targetPath));
    } finally {
      rmSync(tempPath, { force: true });
    }

    return { backupPath };
  });
}

/** Durable replacement for transaction metadata and rollback restores. Unlike
 * atomicWriteFile, this intentionally does not create another recovery backup. */
function replaceFileDurably(repoRoot: string, path: string, content: string, mode?: number): void {
  const target = resolveInsideRepo(repoRoot, path);
  if (!target.ok || !target.path) throw new Error(target.error ?? 'invalid path');
  const parentError = ensureParent(repoRoot, path);
  if (parentError) throw new Error(parentError);
  const targetPath = target.path;
  withTargetLock(targetPath, () => {
    const tempPath = resolve(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
    try {
      writeFileDurably(tempPath, content, mode);
      renameSync(tempPath, targetPath);
      fsyncDirectory(dirname(targetPath));
    } finally {
      rmSync(tempPath, { force: true });
    }
  });
}

export function applyMkdirOperation(repoRoot: string, operation: MkdirOperation, dryRun = false): ApplyOperationResult {
  const target = resolveInsideRepo(repoRoot, operation.path);
  if (!target.ok || !target.path) return failure(operation, target.error ?? 'invalid path');
  if (dryRun) return { id: operation.id, kind: operation.kind, path: operation.path, status: 'planned' };
  // Only report an applied (rollback-eligible) result when we actually create the
  // directory. A directory that already existed must never be removed during rollback.
  if (existsSync(target.path)) {
    return { id: operation.id, kind: operation.kind, path: operation.path, status: 'skipped' };
  }
  mkdirSync(target.path, { recursive: true });
  return { id: operation.id, kind: operation.kind, path: operation.path, status: 'applied' };
}

export function applyWriteFileOperation(
  repoRoot: string,
  operation: WriteFileOperation,
  dryRun = false,
  backupRoot?: string,
): ApplyOperationResult {
  const target = resolveInsideRepo(repoRoot, operation.path);
  if (!target.ok || !target.path) return failure(operation, target.error ?? 'invalid path');
  if (operation.ifMissing === true && existsSync(target.path)) {
    return { id: operation.id, kind: operation.kind, path: operation.path, status: 'skipped' };
  }
  if (operation.ifMissing !== true && !isWorkflowContractInstallOperation(operation)) {
    return failure(operation, 'writeFile applicator only supports ifMissing operations and workflow-contract install');
  }
  if (
    operation.ifMissing !== true &&
    existsSync(target.path) &&
    readFileSync(target.path, 'utf-8') === operation.content
  ) {
    return { id: operation.id, kind: operation.kind, path: operation.path, status: 'skipped' };
  }
  if (dryRun) return { id: operation.id, kind: operation.kind, path: operation.path, status: 'planned' };
  try {
    const write = atomicWriteFile(repoRoot, operation.path, operation.content, { mode: operation.mode, backupRoot });
    return {
      id: operation.id,
      kind: operation.kind,
      path: operation.path,
      status: 'applied',
      backupPath: write.backupPath,
      contentHash: contentHash(operation.content),
    };
  } catch (error) {
    return failure(operation, errorMessage(error));
  }
}

export function applyAppendManagedBlockOperation(
  repoRoot: string,
  operation: AppendManagedBlockOperation,
  dryRun = false,
  backupRoot?: string,
): ApplyOperationResult {
  const target = resolveInsideRepo(repoRoot, operation.path);
  if (!target.ok || !target.path) return failure(operation, target.error ?? 'invalid path');
  const existing = existsSync(target.path) ? readFileSync(target.path, 'utf-8') : '';
  const update = upsertManagedBlock(existing, operation);
  if (!update.ok) return failure(operation, update.error ?? 'failed to update managed block');
  if (!update.changed) {
    return { id: operation.id, kind: operation.kind, path: operation.path, status: 'skipped' };
  }
  if (dryRun) return { id: operation.id, kind: operation.kind, path: operation.path, status: 'planned' };
  try {
    const content = update.content ?? '';
    const write = atomicWriteFile(repoRoot, operation.path, content, { backupRoot });
    return {
      id: operation.id,
      kind: operation.kind,
      path: operation.path,
      status: 'applied',
      backupPath: write.backupPath,
      contentHash: contentHash(content),
    };
  } catch (error) {
    return failure(operation, errorMessage(error));
  }
}

function writeTransactionManifest(
  plan: AdoptionPlan,
  transactionDir: string,
  createdAt: string,
  results: readonly ApplyOperationResult[],
): string {
  const manifestPath = `${transactionDir}/manifest.json`;
  const manifest: FsTransactionManifest = {
    protocol: 1,
    command: 'adopt',
    createdAt,
    repoRoot: plan.repoRoot,
    mode: plan.mode,
    operations: results.map((result) => {
      const operation = plan.operations.find((entry) => entry.id === result.id);
      return {
        id: result.id,
        kind: result.kind,
        path: result.path,
        status: result.status,
        backupPath: result.backupPath,
        contentHash: result.contentHash,
        rollbackStrategy: operation?.rollback?.strategy,
        error: result.error,
      };
    }),
    rollback: {
      command: `forge adopt rollback --transaction ${manifestPath}`,
    },
  };
  replaceFileDurably(plan.repoRoot, manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  return manifestPath;
}

export function applyAdoptionPlan(plan: AdoptionPlan, dryRun = false): ApplyAdoptionPlanResult {
  const unsupported = plan.operations.filter((operation) => !isSupportedAdoptionOperation(operation));
  if (unsupported.length > 0) {
    return {
      ok: false,
      dryRun,
      results: unsupported.map((operation) => failure(operation, unsupportedOperationReason(operation))),
    };
  }

  if (dryRun) {
    const results = plan.operations.map((operation) => {
      switch (operation.kind) {
        case 'mkdir':
          return applyMkdirOperation(plan.repoRoot, operation, true);
        case 'writeFile':
          return applyWriteFileOperation(plan.repoRoot, operation, true);
        case 'appendManagedBlock':
          return applyAppendManagedBlockOperation(plan.repoRoot, operation, true);
        default:
          return failure(operation, `unsupported operation kind: ${operation.kind}`);
      }
    });
    return { ok: results.every((result) => result.status !== 'failed'), dryRun: true, results };
  }

  const transactionDir = transactionDirFor();
  const createdAt = new Date().toISOString();
  const results: ApplyOperationResult[] = [];
  let transactionManifestPath: string;
  try {
    // Establish recovery evidence before the first adoption operation mutates
    // repository state. Each completed/failed operation is checkpointed below.
    transactionManifestPath = writeTransactionManifest(plan, transactionDir, createdAt, results);
  } catch (error) {
    return {
      ok: false,
      dryRun: false,
      results: [
        {
          id: 'transaction-manifest',
          kind: 'runCheck',
          status: 'failed',
          error: `failed to initialize transaction manifest: ${errorMessage(error)}`,
        },
      ],
    };
  }

  for (const operation of plan.operations) {
    const result = (() => {
      switch (operation.kind) {
        case 'mkdir':
          return applyMkdirOperation(plan.repoRoot, operation, false);
        case 'writeFile':
          return applyWriteFileOperation(plan.repoRoot, operation, false, transactionDir);
        case 'appendManagedBlock':
          return applyAppendManagedBlockOperation(plan.repoRoot, operation, false, transactionDir);
        default:
          return failure(operation, `unsupported operation kind: ${operation.kind}`);
      }
    })();
    results.push(result);
    try {
      writeTransactionManifest(plan, transactionDir, createdAt, results);
    } catch (error) {
      results.push({
        id: 'transaction-manifest',
        kind: 'runCheck',
        status: 'failed',
        error: `failed to checkpoint transaction manifest: ${errorMessage(error)}`,
      });
      break;
    }
    if (result.status === 'failed') break;
  }

  const ok = results.every((result) => result.status !== 'failed');

  return {
    ok,
    dryRun,
    results,
    transactionManifestPath,
  };
}

function resolveTransactionManifest(
  repoRoot: string,
  transaction: string,
): { ok: true; path: string; rel: string } | { ok: false; error: string } {
  const root = resolve(repoRoot);
  const target = resolve(root, transaction);
  const rel = relative(root, target).replace(/\\/g, '/');
  if (rel === '' || rel.startsWith('..') || rel.includes('\0')) {
    return { ok: false, error: `transaction manifest escapes repo root: ${transaction}` };
  }
  if (!rel.startsWith(`${BACKUP_ROOT}/`) || !rel.endsWith('/manifest.json')) {
    return { ok: false, error: `transaction manifest must be under ${BACKUP_ROOT}/<transaction>/manifest.json` };
  }
  return { ok: true, path: target, rel };
}

function rollbackFailed(
  operation: FsTransactionManifestOperation,
  action: RollbackOperationResult['action'],
  error: string,
): RollbackOperationResult {
  return { id: operation.id, kind: operation.kind, path: operation.path, status: 'failed', action, error };
}

function rollbackFileOperation(repoRoot: string, operation: FsTransactionManifestOperation): RollbackOperationResult {
  if (!operation.path) return rollbackFailed(operation, 'none', 'file operation is missing path');
  const target = resolveInsideRepo(repoRoot, operation.path);
  if (!target.ok || !target.path) return rollbackFailed(operation, 'none', target.error ?? 'invalid path');

  if (operation.backupPath) {
    const backup = resolveInsideRepo(repoRoot, operation.backupPath);
    if (!backup.ok || !backup.path)
      return rollbackFailed(operation, 'restore_backup', backup.error ?? 'invalid backup path');
    if (!existsSync(backup.path))
      return rollbackFailed(operation, 'restore_backup', `missing backup: ${operation.backupPath}`);
    try {
      // Fail closed: never overwrite a target whose current content diverges from
      // what this transaction applied (e.g. the user edited the file after apply).
      // Mirrors the delete_created_file guard so both destructive paths are symmetric.
      if (existsSync(target.path)) {
        if (!operation.contentHash) {
          return rollbackFailed(operation, 'restore_backup', 'missing content hash for replaced file rollback');
        }
        const currentHash = contentHash(readFileSync(target.path, 'utf-8'));
        if (currentHash !== operation.contentHash) {
          return rollbackFailed(operation, 'restore_backup', 'current file hash differs from transaction content hash');
        }
      }
      replaceFileDurably(repoRoot, operation.path, readFileSync(backup.path, 'utf-8'));
      return {
        id: operation.id,
        kind: operation.kind,
        path: operation.path,
        status: 'rolled_back',
        action: 'restore_backup',
      };
    } catch (error) {
      return rollbackFailed(operation, 'restore_backup', errorMessage(error));
    }
  }

  if (!operation.contentHash)
    return rollbackFailed(operation, 'delete_created_file', 'missing content hash for created file rollback');
  if (!existsSync(target.path)) {
    return {
      id: operation.id,
      kind: operation.kind,
      path: operation.path,
      status: 'skipped',
      action: 'delete_created_file',
    };
  }
  try {
    // Read + hash inside the try so an unreadable target (e.g. replaced by a
    // directory) returns a structured failed result instead of throwing to the CLI.
    const currentHash = contentHash(readFileSync(target.path, 'utf-8'));
    if (currentHash !== operation.contentHash) {
      return rollbackFailed(
        operation,
        'delete_created_file',
        'current file hash differs from transaction content hash',
      );
    }
    rmSync(target.path);
    fsyncDirectory(dirname(target.path));
    return {
      id: operation.id,
      kind: operation.kind,
      path: operation.path,
      status: 'rolled_back',
      action: 'delete_created_file',
    };
  } catch (error) {
    return rollbackFailed(operation, 'delete_created_file', errorMessage(error));
  }
}

function rollbackMkdirOperation(repoRoot: string, operation: FsTransactionManifestOperation): RollbackOperationResult {
  if (!operation.path) return rollbackFailed(operation, 'remove_empty_directory', 'mkdir operation is missing path');
  const target = resolveInsideRepo(repoRoot, operation.path);
  if (!target.ok || !target.path)
    return rollbackFailed(operation, 'remove_empty_directory', target.error ?? 'invalid path');
  if (!existsSync(target.path)) {
    return {
      id: operation.id,
      kind: operation.kind,
      path: operation.path,
      status: 'skipped',
      action: 'remove_empty_directory',
    };
  }
  try {
    rmdirSync(target.path);
    fsyncDirectory(dirname(target.path));
    return {
      id: operation.id,
      kind: operation.kind,
      path: operation.path,
      status: 'rolled_back',
      action: 'remove_empty_directory',
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(code ?? '')) {
      return {
        id: operation.id,
        kind: operation.kind,
        path: operation.path,
        status: 'skipped',
        action: 'remove_empty_directory',
      };
    }
    return rollbackFailed(operation, 'remove_empty_directory', errorMessage(error));
  }
}

function isValidManifestOperation(
  operation: unknown,
  transactionDir: string,
): operation is FsTransactionManifestOperation {
  if (typeof operation !== 'object' || operation === null) return false;
  const op = operation as Record<string, unknown>;
  if (typeof op.id !== 'string' || typeof op.kind !== 'string' || typeof op.status !== 'string') return false;
  if (op.path !== undefined && typeof op.path !== 'string') return false;
  if (op.contentHash !== undefined && typeof op.contentHash !== 'string') return false;
  if (op.rollbackStrategy !== undefined && typeof op.rollbackStrategy !== 'string') return false;
  if (op.error !== undefined && typeof op.error !== 'string') return false;
  if (op.backupPath !== undefined) {
    if (typeof op.backupPath !== 'string') return false;
    // A manifest is untrusted file data: pin the restore source to this manifest's
    // own transaction directory so a crafted manifest cannot point backups elsewhere.
    const normalized = op.backupPath.replace(/\\/g, '/');
    if (!normalized.startsWith(`${transactionDir}/`)) return false;
  }
  return true;
}

function readTransactionManifest(
  repoRoot: string,
  transaction: string,
): { manifest?: FsTransactionManifest; rel?: string; error?: string } {
  const resolved = resolveTransactionManifest(repoRoot, transaction);
  if (!resolved.ok) return { error: resolved.error };
  if (!existsSync(resolved.path)) return { error: `transaction manifest not found: ${resolved.rel}` };
  try {
    const manifest = JSON.parse(readFileSync(resolved.path, 'utf-8')) as FsTransactionManifest;
    const transactionDir = resolved.rel.replace(/\/manifest\.json$/, '');
    if (
      manifest.protocol !== 1 ||
      manifest.command !== 'adopt' ||
      !Array.isArray(manifest.operations) ||
      !manifest.operations.every((operation) => isValidManifestOperation(operation, transactionDir))
    ) {
      return { error: `invalid transaction manifest: ${resolved.rel}` };
    }
    return { manifest, rel: resolved.rel };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export function rollbackAdoptionTransaction(opts: {
  readonly repoRoot: string;
  readonly transaction: string;
}): RollbackAdoptionTransactionResult {
  const repoRoot = resolve(opts.repoRoot);
  const loaded = readTransactionManifest(repoRoot, opts.transaction);
  if (!loaded.manifest || !loaded.rel) {
    return {
      protocol: 1,
      command: 'adopt rollback',
      repoRoot,
      transactionManifestPath: opts.transaction,
      ok: false,
      results: [
        {
          id: 'transaction-manifest',
          kind: 'runCheck',
          status: 'failed',
          action: 'none',
          error: loaded.error ?? 'failed to read transaction manifest',
        },
      ],
    };
  }

  const results = [...loaded.manifest.operations].reverse().map((operation) => {
    if (operation.status !== 'applied') {
      return {
        id: operation.id,
        kind: operation.kind,
        path: operation.path,
        status: 'skipped' as const,
        action: 'none' as const,
      };
    }
    if (operation.kind === 'mkdir') return rollbackMkdirOperation(repoRoot, operation);
    if (operation.kind === 'writeFile' || operation.kind === 'appendManagedBlock')
      return rollbackFileOperation(repoRoot, operation);
    return rollbackFailed(operation, 'none', `unsupported rollback operation kind: ${operation.kind}`);
  });

  return {
    protocol: 1,
    command: 'adopt rollback',
    repoRoot,
    transactionManifestPath: loaded.rel,
    ok: results.every((result) => result.status !== 'failed'),
    results,
  };
}
