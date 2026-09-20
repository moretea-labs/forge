import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { resolveControllerHome } from '../../cli/repositories/controller-home';
import { isProcessAlive, terminateProcessTree, type ProcessTreeTerminationResult } from '../shared/process-tree';
import { defaultProcessIdentityProbe, executableFingerprint, processIdentityMatches } from '../shared/process-identity';

export interface RuntimeOwnerRecord {
  schemaVersion: 1 | 2;
  runtimeInstanceId: string;
  pid: number;
  acquiredAt: string;
  /** Monotonic Controller-Home writer epoch. Schema v1 owners predate it. */
  fencingGeneration?: number;
  /** Optional OS-process identity evidence used only for bounded crash recovery. */
  processStartTime?: string;
  executableFingerprint?: string;
}

export interface RuntimeIncarnationRecord {
  schemaVersion: 1;
  controllerHome: string;
  runtimeInstanceId: string;
  pid: number;
  fencingGeneration: number;
  activatedAt: string;
}

export interface RuntimeOwnershipHandle {
  record: RuntimeOwnerRecord;
  release(): void;
}

export function runtimeOwnerPath(controllerHome: string): string {
  return join(resolveControllerHome(controllerHome), 'runtime', 'active-runtime-owner.json');
}

export function runtimeIncarnationPath(controllerHome: string): string {
  return join(resolveControllerHome(controllerHome), 'runtime', 'runtime-incarnation.json');
}

function readOwnerPath(path: string): RuntimeOwnerRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as RuntimeOwnerRecord;
    if ((value.schemaVersion !== 1 && value.schemaVersion !== 2) || !value.runtimeInstanceId || !Number.isInteger(value.pid)) return undefined;
    if (value.schemaVersion === 2 && (!Number.isInteger(value.fencingGeneration) || value.fencingGeneration! < 1)) return undefined;
    if ((value.processStartTime === undefined) !== (value.executableFingerprint === undefined)) return undefined;
    if (value.processStartTime !== undefined && (!value.processStartTime.trim() || !value.executableFingerprint?.trim())) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function readRuntimeOwner(controllerHome: string): RuntimeOwnerRecord | undefined {
  return readOwnerPath(runtimeOwnerPath(controllerHome));
}

export function readRuntimeIncarnation(controllerHome: string): RuntimeIncarnationRecord | undefined {
  const path = runtimeIncarnationPath(controllerHome);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as RuntimeIncarnationRecord;
    if (
      value.schemaVersion !== 1
      || resolveControllerHome(value.controllerHome) !== resolveControllerHome(controllerHome)
      || !value.runtimeInstanceId
      || !Number.isInteger(value.pid)
      || !Number.isInteger(value.fencingGeneration)
      || value.fencingGeneration < 1
      || !Number.isFinite(Date.parse(value.activatedAt))
    ) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function nextFencingGeneration(controllerHome: string, minimum = 1): number {
  const incarnationGeneration = readRuntimeIncarnation(controllerHome)?.fencingGeneration ?? 0;
  const ownerGeneration = readRuntimeOwner(controllerHome)?.fencingGeneration ?? 0;
  return Math.max(minimum - 1, incarnationGeneration, ownerGeneration) + 1;
}

function writeRuntimeIncarnation(record: RuntimeIncarnationRecord): void {
  const path = runtimeIncarnationPath(record.controllerHome);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}


export interface RuntimeOwnershipInspection {
  owner?: RuntimeOwnerRecord;
  incarnation?: RuntimeIncarnationRecord;
  ownerAlive: boolean;
  incarnationAlive: boolean;
  coherent: boolean;
}

export function inspectRuntimeOwnership(controllerHome: string): RuntimeOwnershipInspection {
  const owner = readRuntimeOwner(controllerHome);
  const incarnation = readRuntimeIncarnation(controllerHome);
  const coherent = Boolean(
    owner
    && incarnation
    && owner.runtimeInstanceId === incarnation.runtimeInstanceId
    && owner.pid === incarnation.pid
    && (owner.fencingGeneration ?? incarnation.fencingGeneration) === incarnation.fencingGeneration,
  );
  // Schema-v2 owners carry OS-process identity. Once present, raw PID liveness
  // is insufficient because a stopped Runtime PID may be reused by another
  // process before Recovery reconciles durable ownership.
  const ownerAlive = Boolean(owner && (
    owner.processStartTime && owner.executableFingerprint
      ? runtimeOwnerProcessIdentityMatches(owner)
      : isProcessAlive(owner.pid)
  ));
  // A coherent incarnation is the same Runtime owner epoch, so inherit the
  // stronger owner identity result instead of re-introducing PID-only liveness.
  // Incarnation-only legacy evidence remains conservative because it has no
  // independent process identity fields.
  const incarnationAlive = Boolean(incarnation && (
    coherent
      ? ownerAlive
      : isProcessAlive(incarnation.pid)
  ));
  return { owner, incarnation, ownerAlive, incarnationAlive, coherent };
}

export function runtimeOwnerProcessIdentityMatches(record: RuntimeOwnerRecord | undefined): boolean {
  if (!record?.processStartTime || !record.executableFingerprint) return false;
  return processIdentityMatches({
    pid: record.pid,
    processStartTime: record.processStartTime,
    executableFingerprint: record.executableFingerprint,
  }, record.pid).matches;
}

/**
 * Recovery calls this only after the service manager and Runtime listener have
 * been proven stopped. It never kills a live process. Dead owner evidence is
 * renamed, not discarded, so fencing generations and forensic evidence survive.
 */
export function reconcileStoppedRuntimeOwnership(controllerHome: string): {
  ok: boolean;
  changed: boolean;
  detail: string;
  inspection: RuntimeOwnershipInspection;
  staleOwnerPath?: string;
} {
  const inspection = inspectRuntimeOwnership(controllerHome);
  if (inspection.ownerAlive || inspection.incarnationAlive) {
    return {
      ok: false,
      changed: false,
      detail: 'RUNTIME_OWNERSHIP_STILL_LIVE',
      inspection,
    };
  }
  const ownerPath = runtimeOwnerPath(controllerHome);
  if (!inspection.owner || !existsSync(ownerPath)) {
    return {
      ok: true,
      changed: false,
      detail: 'Runtime ownership is already quiescent',
      inspection,
    };
  }
  const staleOwnerPath = `${ownerPath}.stale-${Date.now()}`;
  renameSync(ownerPath, staleOwnerPath);
  return {
    ok: true,
    changed: true,
    detail: 'dead Runtime owner evidence was fenced out after service shutdown',
    inspection,
    staleOwnerPath,
  };
}


export async function terminateVerifiedRuntimeOwner(controllerHome: string): Promise<{
  ok: boolean;
  attempted: boolean;
  detail: string;
  owner?: RuntimeOwnerRecord;
  termination?: ProcessTreeTerminationResult;
}> {
  const owner = readRuntimeOwner(controllerHome);
  if (!owner) return { ok: true, attempted: false, detail: 'Runtime owner is already absent' };
  if (!isProcessAlive(owner.pid)) {
    return { ok: true, attempted: false, detail: 'Runtime owner process is already dead', owner };
  }
  if (!owner.processStartTime || !owner.executableFingerprint) {
    return {
      ok: false,
      attempted: false,
      detail: 'RUNTIME_OWNER_IDENTITY_EVIDENCE_MISSING',
      owner,
    };
  }
  if (!runtimeOwnerProcessIdentityMatches(owner)) {
    return {
      ok: false,
      attempted: false,
      detail: 'RUNTIME_OWNER_IDENTITY_CHANGED',
      owner,
    };
  }
  const termination = await terminateProcessTree(owner.pid, {
    gracePeriodMs: 1_500,
    killAfterMs: 5_000,
    pollIntervalMs: 50,
  });
  const exited = termination.exited && !isProcessAlive(owner.pid);
  return {
    ok: exited,
    attempted: true,
    detail: exited
      ? 'verified orphan Runtime owner process tree terminated after service shutdown'
      : `verified orphan Runtime owner did not fully exit; remaining pids=${termination.remainingPids.join(',')}`,
    owner,
    termination,
  };
}

export function acquireRuntimeOwnership(
  controllerHome: string,
  runtimeInstanceId: string,
  now: () => string = () => new Date().toISOString(),
): RuntimeOwnershipHandle {
  if (!runtimeInstanceId.trim()) throw new Error('RUNTIME_INSTANCE_ID_REQUIRED');
  const path = runtimeOwnerPath(controllerHome);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let minimumGeneration = nextFencingGeneration(controllerHome);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const generation = nextFencingGeneration(controllerHome, minimumGeneration);
    const processStartTime = defaultProcessIdentityProbe.startTime(process.pid);
    const processCommand = defaultProcessIdentityProbe.command(process.pid);
    const record: RuntimeOwnerRecord = {
      schemaVersion: 2,
      runtimeInstanceId,
      pid: process.pid,
      acquiredAt: now(),
      fencingGeneration: generation,
      ...(processStartTime && processCommand ? {
        processStartTime,
        executableFingerprint: executableFingerprint(processCommand),
      } : {}),
    };
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      } finally {
        closeSync(fd);
      }
      try {
        writeRuntimeIncarnation({
          schemaVersion: 1,
          controllerHome: resolveControllerHome(controllerHome),
          runtimeInstanceId,
          pid: process.pid,
          fencingGeneration: generation,
          activatedAt: record.acquiredAt,
        });
      } catch (writeError) {
        try { unlinkSync(path); } catch { /* ownership did not become usable */ }
        throw writeError;
      }
      return {
        record,
        release: () => {
          const current = readOwnerPath(path);
          if (current?.runtimeInstanceId === runtimeInstanceId && current.pid === process.pid) {
            try { unlinkSync(path); } catch { /* already released */ }
          }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      const current = readOwnerPath(path);
      if (current && isProcessAlive(current.pid)) {
        throw new Error(
          `RUNTIME_OWNERSHIP_CONFLICT: controller home is owned by ${current.runtimeInstanceId} pid=${current.pid}`,
        );
      }
      minimumGeneration = Math.max(
        minimumGeneration,
        generation + 1,
        (current?.fencingGeneration ?? 0) + 1,
        (readRuntimeIncarnation(controllerHome)?.fencingGeneration ?? 0) + 1,
      );
      const stalePath = `${path}.stale-${Date.now()}-${attempt}`;
      try { renameSync(path, stalePath); } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError;
      }
    }
  }
  throw new Error('RUNTIME_OWNERSHIP_CONFLICT: unable to claim controller home');
}
