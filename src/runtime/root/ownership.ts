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
import { resolveControllerHome } from '../../effects/controller-home';
import { isProcessAlive, terminateProcessTree, type ProcessTreeTerminationResult } from '../shared/process-tree';
import { forgeRuntimePersistentServiceLabel } from '../platform/service-inventory';
import { systemdUserServiceOwnsPid } from '../platform/systemd-user';
import { defaultProcessIdentityProbe, executableFingerprint, LINUX_PROCESS_START_TIME_PREFIX, processIdentityMatches, type ProcessIdentityProbe } from '../shared/process-identity';

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
  /** Exact OS-process identity retained after the owner lease is removed. */
  processStartTime?: string;
  executableFingerprint?: string;
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
      || (value.processStartTime === undefined) !== (value.executableFingerprint === undefined)
      || (value.processStartTime !== undefined && (!value.processStartTime.trim() || !value.executableFingerprint?.trim()))
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

function runtimeIncarnationProcessAlive(record: RuntimeIncarnationRecord, probe: ProcessIdentityProbe = defaultProcessIdentityProbe): boolean {
  if (!record.processStartTime || !record.executableFingerprint) return probe.isAlive(record.pid);
  const identity = processIdentityMatches({
    pid: record.pid,
    processStartTime: record.processStartTime,
    executableFingerprint: record.executableFingerprint,
  }, record.pid, probe);
  return identity.matches || (identity.reason === 'identity_probe_unavailable' && probe.isAlive(record.pid));
}

type RuntimeSystemdServiceOwnsPidProbe = (unitName: string, pid: number) => boolean;

function legacyRuntimeProcessIdentityMatchesWithSystemd(
  record: { pid: number; processStartTime?: string; executableFingerprint?: string },
  controllerHome: string,
  identity: ReturnType<typeof processIdentityMatches>,
  systemdServiceOwnsPidProbe: RuntimeSystemdServiceOwnsPidProbe,
): boolean {
  if (!record.processStartTime || !record.executableFingerprint) return false;
  // A legacy ps lstart value can shift when WSL adjusts its wall clock.
  // Bridge only that legacy format when the exact Controller-Home systemd
  // unit still owns the same live PID and the executable fingerprint matched.
  return process.platform === 'linux'
    && !record.processStartTime.startsWith(LINUX_PROCESS_START_TIME_PREFIX)
    && identity.reason === 'process_start_time_changed'
    && systemdServiceOwnsPidProbe(forgeRuntimePersistentServiceLabel(controllerHome), record.pid);
}

function runtimeIncarnationProcessAliveWithSystemd(
  record: RuntimeIncarnationRecord,
  systemdServiceOwnsPidProbe: RuntimeSystemdServiceOwnsPidProbe,
): boolean {
  if (!record.processStartTime || !record.executableFingerprint) return isProcessAlive(record.pid);
  const identity = processIdentityMatches({
    pid: record.pid,
    processStartTime: record.processStartTime,
    executableFingerprint: record.executableFingerprint,
  }, record.pid);
  return identity.matches
    || (identity.reason === 'identity_probe_unavailable' && isProcessAlive(record.pid))
    || legacyRuntimeProcessIdentityMatchesWithSystemd(record, record.controllerHome, identity, systemdServiceOwnsPidProbe);
}

export function inspectRuntimeOwnership(
  controllerHome: string,
  systemdServiceOwnsPidProbe: RuntimeSystemdServiceOwnsPidProbe = systemdUserServiceOwnsPid,
): RuntimeOwnershipInspection {
  const owner = readRuntimeOwner(controllerHome);
  const incarnation = readRuntimeIncarnation(controllerHome);
  const coherent = Boolean(
    owner
    && incarnation
    && owner.runtimeInstanceId === incarnation.runtimeInstanceId
    && owner.pid === incarnation.pid
    && (owner.fencingGeneration ?? incarnation.fencingGeneration) === incarnation.fencingGeneration,
  );
  // RuntimeOwner remains the sole liveness authority when present. Legacy
  // wall-clock start times are accepted only while the exact systemd unit
  // still owns the same PID and the executable fingerprint matches.
  const ownerAlive = Boolean(owner && (
    owner.processStartTime && owner.executableFingerprint
      ? runtimeOwnerProcessIdentityMatches(owner, controllerHome, systemdServiceOwnsPidProbe)
      : isProcessAlive(owner.pid)
  ));
  // An incoherent incarnation is historical fencing evidence, not a second
  // process-liveness authority. When no owner exists, its legacy identity can
  // be bridged only through the exact configured systemd service.
  const incarnationAlive = Boolean(incarnation && (
    owner
      ? coherent && ownerAlive
      : runtimeIncarnationProcessAliveWithSystemd(incarnation, systemdServiceOwnsPidProbe)
  ));
  return { owner, incarnation, ownerAlive, incarnationAlive, coherent };
}

function runtimeOwnerProcessIdentityMatchesWithProbe(
  record: RuntimeOwnerRecord | undefined,
  probe: ProcessIdentityProbe = defaultProcessIdentityProbe,
): boolean {
  if (!record?.processStartTime || !record.executableFingerprint) return false;
  return processIdentityMatches({
    pid: record.pid,
    processStartTime: record.processStartTime,
    executableFingerprint: record.executableFingerprint,
  }, record.pid, probe).matches;
}

export function runtimeOwnerProcessIdentityMatches(
  record: RuntimeOwnerRecord | undefined,
  controllerHome: string,
  systemdServiceOwnsPidProbe: RuntimeSystemdServiceOwnsPidProbe = systemdUserServiceOwnsPid,
): boolean {
  if (!record?.processStartTime || !record.executableFingerprint) return false;
  const identity = processIdentityMatches({
    pid: record.pid,
    processStartTime: record.processStartTime,
    executableFingerprint: record.executableFingerprint,
  }, record.pid);
  return identity.matches || legacyRuntimeProcessIdentityMatchesWithSystemd(record, controllerHome, identity, systemdServiceOwnsPidProbe);
}

export interface RuntimeIncarnationIdentityMigrationDependencies {
  platform?: NodeJS.Platform;
  probe?: ProcessIdentityProbe;
  /** Recovery-only proof that the exact process is still inside the configured service's process tree. */
  verifyLegacyProcessOwnership?: (input: {
    owner: RuntimeOwnerRecord;
    incarnation: RuntimeIncarnationRecord;
    observedCommand: string;
    observedProcessStartTime: string;
  }) => boolean;
}

function writeRuntimeOwner(controllerHome: string, record: RuntimeOwnerRecord): void {
  const path = runtimeOwnerPath(controllerHome);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

/** Backfill or refresh an incarnation only from its exact, currently live owner lease. */
export function migrateRuntimeIncarnationProcessIdentity(
  controllerHome: string,
  dependencies: RuntimeIncarnationIdentityMigrationDependencies = {},
): {
  ok: boolean;
  changed: boolean;
  detail: string;
} {
  const incarnation = readRuntimeIncarnation(controllerHome);
  if (!incarnation) {
    return { ok: false, changed: false, detail: 'RUNTIME_INCARNATION_IDENTITY_MIGRATION_INCARNATION_REQUIRED' };
  }
  const owner = readRuntimeOwner(controllerHome);
  if (owner && (
    owner.pid !== incarnation.pid
    || owner.runtimeInstanceId !== incarnation.runtimeInstanceId
    || (owner.fencingGeneration ?? incarnation.fencingGeneration) !== incarnation.fencingGeneration
  )) {
    return { ok: false, changed: false, detail: 'RUNTIME_INCARNATION_OWNER_MISMATCH' };
  }

  const probe = dependencies.probe ?? defaultProcessIdentityProbe;
  const platform = dependencies.platform ?? process.platform;
  const incarnationHasIdentity = Boolean(incarnation.processStartTime && incarnation.executableFingerprint);
  const ownerHasIdentity = Boolean(owner?.processStartTime && owner.executableFingerprint);

  if (incarnationHasIdentity && ownerHasIdentity
    && (owner!.processStartTime !== incarnation.processStartTime
      || owner!.executableFingerprint !== incarnation.executableFingerprint)) {
    // Recover an interrupted two-file migration only from a canonical owner
    // identity that independently verifies against the same live process.
    if (owner!.executableFingerprint === incarnation.executableFingerprint
      && owner!.processStartTime!.startsWith(LINUX_PROCESS_START_TIME_PREFIX)
      && !incarnation.processStartTime!.startsWith(LINUX_PROCESS_START_TIME_PREFIX)
      && runtimeOwnerProcessIdentityMatchesWithProbe(owner, probe)) {
      writeRuntimeIncarnation({
        ...incarnation,
        processStartTime: owner!.processStartTime,
        executableFingerprint: owner!.executableFingerprint,
      });
      return { ok: true, changed: true, detail: 'Runtime incarnation identity was completed from its verified owner lease' };
    }
    if (owner!.executableFingerprint === incarnation.executableFingerprint
      && !owner!.processStartTime!.startsWith(LINUX_PROCESS_START_TIME_PREFIX)
      && incarnation.processStartTime!.startsWith(LINUX_PROCESS_START_TIME_PREFIX)
      && runtimeIncarnationProcessAlive(incarnation, probe)) {
      writeRuntimeOwner(controllerHome, {
        ...owner!,
        processStartTime: incarnation.processStartTime,
        executableFingerprint: incarnation.executableFingerprint,
      });
      return { ok: true, changed: true, detail: 'Runtime owner identity was completed from its verified incarnation' };
    }
    return { ok: false, changed: false, detail: 'RUNTIME_INCARNATION_OWNER_IDENTITY_MISMATCH' };
  }

  if (incarnationHasIdentity && runtimeIncarnationProcessAlive(incarnation, probe)) {
    // If the incarnation write survived but the owner write did not, complete
    // the canonical owner from this independently verified stable identity.
    if (owner && (!ownerHasIdentity || owner!.processStartTime !== incarnation.processStartTime
      || owner!.executableFingerprint !== incarnation.executableFingerprint)) {
      writeRuntimeOwner(controllerHome, {
        ...owner,
        processStartTime: incarnation.processStartTime!,
        executableFingerprint: incarnation.executableFingerprint!,
      });
      return { ok: true, changed: true, detail: 'Runtime owner identity was completed from its verified incarnation' };
    }
    return { ok: true, changed: false, detail: 'Runtime incarnation already has verified process identity' };
  }

  if (!owner) {
    return { ok: false, changed: false, detail: 'RUNTIME_INCARNATION_IDENTITY_MIGRATION_OWNER_REQUIRED' };
  }

  const expectedStartTime = incarnation.processStartTime ?? owner.processStartTime;
  const expectedFingerprint = incarnation.executableFingerprint ?? owner.executableFingerprint;
  const legacyLinuxIdentity = platform === 'linux'
    && Boolean(expectedStartTime)
    && !expectedStartTime!.startsWith(LINUX_PROCESS_START_TIME_PREFIX);
  const identitiesAgree = (!incarnation.processStartTime || !owner.processStartTime
      || incarnation.processStartTime === owner.processStartTime)
    && (!incarnation.executableFingerprint || !owner.executableFingerprint
      || incarnation.executableFingerprint === owner.executableFingerprint);

  if (legacyLinuxIdentity && expectedFingerprint && identitiesAgree
    && owner.acquiredAt === incarnation.activatedAt
    && probe.isAlive(incarnation.pid)
    && dependencies.verifyLegacyProcessOwnership) {
    const observed = probe.inspect?.(incarnation.pid)
      ?? { command: probe.command(incarnation.pid), startTime: probe.startTime(incarnation.pid) };
    if (observed.command
      && observed.startTime?.startsWith(LINUX_PROCESS_START_TIME_PREFIX)
      && executableFingerprint(observed.command) === expectedFingerprint
      && dependencies.verifyLegacyProcessOwnership({
        owner,
        incarnation,
        observedCommand: observed.command,
        observedProcessStartTime: observed.startTime,
      })) {
      const updatedOwner: RuntimeOwnerRecord = {
        ...owner,
        processStartTime: observed.startTime,
        executableFingerprint: expectedFingerprint,
      };
      // Owner is the liveness authority. Write it first; if the second atomic
      // write is interrupted, the next pass can finish from this verified owner.
      writeRuntimeOwner(controllerHome, updatedOwner);
      writeRuntimeIncarnation({
        ...incarnation,
        processStartTime: observed.startTime,
        executableFingerprint: expectedFingerprint,
      });
      return { ok: true, changed: true, detail: 'Legacy Runtime process identity was refreshed from verified service ownership and Linux proc start ticks' };
    }
  }

  if (!incarnationHasIdentity) {
    if (!ownerHasIdentity) {
      return { ok: false, changed: false, detail: 'RUNTIME_OWNER_IDENTITY_EVIDENCE_MISSING' };
    }
    if (!runtimeOwnerProcessIdentityMatchesWithProbe(owner, probe)) {
      return { ok: false, changed: false, detail: 'RUNTIME_OWNER_IDENTITY_CHANGED' };
    }
    writeRuntimeIncarnation({
      ...incarnation,
      processStartTime: owner!.processStartTime,
      executableFingerprint: owner!.executableFingerprint,
    });
    return { ok: true, changed: true, detail: 'Runtime incarnation process identity was backfilled from its matching live owner' };
  }

  return { ok: false, changed: false, detail: 'RUNTIME_INCARNATION_PROCESS_IDENTITY_NOT_LIVE' };
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


export async function terminateVerifiedRuntimeOwner(
  controllerHome: string,
  expectedOwner?: RuntimeOwnerRecord | null,
): Promise<{
  ok: boolean;
  attempted: boolean;
  detail: string;
  owner?: RuntimeOwnerRecord;
  termination?: ProcessTreeTerminationResult;
}> {
  const owner = readRuntimeOwner(controllerHome);
  if (expectedOwner) {
    if (!owner) {
      return {
        ok: true,
        attempted: false,
        detail: 'Runtime owner disappeared during stop',
        owner: expectedOwner,
      };
    }
    if (
      owner.pid !== expectedOwner.pid
      || owner.runtimeInstanceId !== expectedOwner.runtimeInstanceId
      || owner.fencingGeneration !== expectedOwner.fencingGeneration
      || owner.processStartTime !== expectedOwner.processStartTime
      || owner.executableFingerprint !== expectedOwner.executableFingerprint
    ) {
      return {
        ok: false,
        attempted: false,
        detail: 'RUNTIME_OWNER_CHANGED_DURING_STOP',
        owner,
      };
    }
  } else if (owner) {
    return {
      ok: false,
      attempted: false,
      detail: 'RUNTIME_OWNER_APPEARED_DURING_STOP',
      owner,
    };
  }
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
  if (!runtimeOwnerProcessIdentityMatches(owner, controllerHome)) {
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
    const processIdentity = processStartTime && processCommand
      ? { processStartTime, executableFingerprint: executableFingerprint(processCommand) }
      : undefined;
    const record: RuntimeOwnerRecord = {
      schemaVersion: 2,
      runtimeInstanceId,
      pid: process.pid,
      acquiredAt: now(),
      fencingGeneration: generation,
      ...(processIdentity ?? {}),
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
          ...(processIdentity ?? {}),
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
      const currentAlive = Boolean(current && (
        current.processStartTime && current.executableFingerprint
          ? runtimeOwnerProcessIdentityMatches(current, controllerHome)
          : isProcessAlive(current.pid)
      ));
      if (currentAlive) {
        throw new Error(
          `RUNTIME_OWNERSHIP_CONFLICT: controller home is owned by ${current!.runtimeInstanceId} pid=${current!.pid}`,
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
