/**
 * Atomic activation authority transaction.
 *
 * Single source of truth:
 *   bootstrap/runtime-authority.json
 *
 * Compatibility projections (written only after the primary commit):
 *   bootstrap/active-runtime.json
 *   bootstrap/writer-authority.json
 *   active-slot.json
 *
 * Protocol:
 *   1. Write prepare journal (activation-authority.prepare.json)
 *   2. Write full authority record to temporary path
 *   3. Atomic rename → activation-authority.json (commit)
 *   4. Update compatibility projections
 *   5. Clear prepare journal
 *
 * Crash recovery:
 *   - prepare only → incomplete (not succeeded)
 *   - authority committed, projections partial → recover projections from authority
 *   - incomplete must never be reported as succeeded
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { ensureControllerHome } from '../../cli/repositories/controller-home';
import type { RuntimeSlotId } from '../../cli/controller/runtime-slots';
import type { WriterAuthority } from '../../cli/controller/stable-state/writer-authority';
import type { ActiveRuntimePointer } from './stable-bootstrap';
import { assertThisRuntimeMayWriteOrThrow } from '../../cli/controller/stable-state/runtime-writer-context';
import {
  migrateRuntimeAuthority,
  migrateRuntimeConfig,
  readRuntimeAuthority,
  runtimeConfigHash,
  writeRuntimeAuthority,
  type RuntimeAuthority,
} from './runtime-authority';

export type ActivationTxStatus =
  | 'committed'
  | 'prepared'
  | 'incomplete'
  | 'missing';

/**
 * Full previous runtime snapshot for true rollback (not slot-only swap).
 * Compatible with older authorities that only store previousSlot/previousEpoch.
 */
export interface PreviousRuntimeSnapshot {
  activeSlot: RuntimeSlotId;
  generation?: string;
  releaseRevision?: string;
  releasePath?: string;
  daemonPort?: number;
  gatewayPort?: number;
  writerEpoch?: string;
  fencingToken?: string;
  transactionId?: string;
}

export interface ActivationAuthorityRecord {
  schemaVersion: 1;
  status: 'committed';
  activeSlot: RuntimeSlotId;
  generation?: string;
  releaseRevision?: string;
  releasePath?: string;
  writerEpoch: string;
  fencingToken: string;
  daemonPort?: number;
  gatewayPort?: number;
  reason?: string;
  previousEpoch?: string;
  previousSlot?: RuntimeSlotId;
  /** Full previous runtime snapshot for authentic rollback. */
  previousRuntime?: PreviousRuntimeSnapshot;
  rollbackUntil?: string;
  committedAt: string;
  transactionId: string;
}

export interface ActivationPrepareJournal {
  schemaVersion: 1;
  status: 'prepared';
  transactionId: string;
  preparedAt: string;
  intended: Omit<ActivationAuthorityRecord, 'schemaVersion' | 'status' | 'committedAt'>;
}

export interface ActivationTransactionResult {
  ok: boolean;
  status: ActivationTxStatus;
  authority?: ActivationAuthorityRecord;
  recovered?: boolean;
  error?: string;
}

function root(controllerHome: string): string {
  return ensureControllerHome(controllerHome);
}

export function activationAuthorityPath(controllerHome: string): string {
  return join(root(controllerHome), 'bootstrap', 'activation-authority.json');
}

export function activationPreparePath(controllerHome: string): string {
  return join(root(controllerHome), 'bootstrap', 'activation-authority.prepare.json');
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function safeUnlink(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* best-effort */
  }
}

function primaryAuthorityToActivation(value: RuntimeAuthority): ActivationAuthorityRecord {
  const previousRuntime = value.previous && value.previousLegacySlot
    ? {
        activeSlot: value.previousLegacySlot,
        generation: value.previous.instanceId,
        ...(value.previous.releaseRevision ? { releaseRevision: value.previous.releaseRevision } : {}),
        ...(value.previous.releasePath ? { releasePath: value.previous.releasePath } : {}),
      }
    : undefined;
  return {
    schemaVersion: 1,
    status: 'committed',
    activeSlot: value.legacySlot,
    generation: value.generation,
    ...(value.active.releaseRevision ? { releaseRevision: value.active.releaseRevision } : {}),
    ...(value.active.releasePath ? { releasePath: value.active.releasePath } : {}),
    writerEpoch: value.authorityTerm,
    fencingToken: value.fencingToken,
    daemonPort: value.daemon.port,
    gatewayPort: value.gateway.port,
    ...(value.previousLegacySlot ? { previousSlot: value.previousLegacySlot } : {}),
    ...(previousRuntime ? { previousRuntime } : {}),
    ...(value.rollbackUntil ? { rollbackUntil: value.rollbackUntil } : {}),
    committedAt: value.committedAt,
    transactionId: value.activationId,
    ...(value.operationId ? { reason: value.operationId } : {}),
  };
}

export function readActivationAuthority(controllerHome: string): ActivationAuthorityRecord | undefined {
  const primary = readRuntimeAuthority(controllerHome);
  if (primary) return primaryAuthorityToActivation(primary);
  try {
    return primaryAuthorityToActivation(migrateRuntimeAuthority(controllerHome));
  } catch (error) {
    if (error instanceof Error && error.message === 'RUNTIME_AUTHORITY_MISSING') return undefined;
    throw error;
  }
}

export function readActivationPrepare(controllerHome: string): ActivationPrepareJournal | undefined {
  const value = readJson<ActivationPrepareJournal>(activationPreparePath(controllerHome));
  if (!value || value.schemaVersion !== 1 || value.status !== 'prepared') return undefined;
  return value;
}

/**
 * Inspect activation state for operators and recovery.
 * incomplete = prepare present without a committed record matching transactionId.
 */
export function inspectActivationTransaction(controllerHome: string): ActivationTransactionResult {
  const authority = readActivationAuthority(controllerHome);
  const prepare = readActivationPrepare(controllerHome);
  if (prepare && (!authority || authority.transactionId !== prepare.transactionId)) {
    return {
      ok: false,
      status: prepare && !authority ? 'prepared' : 'incomplete',
      authority: authority,
      error: 'activation_prepare_without_matching_commit',
    };
  }
  if (authority) return { ok: true, status: 'committed', authority };
  if (prepare) return { ok: false, status: 'prepared', error: 'prepared_not_committed' };
  return { ok: false, status: 'missing' };
}

function writeCompatibilityProjections(
  controllerHome: string,
  authority: ActivationAuthorityRecord,
): void {
  const home = root(controllerHome);
  const bootstrap = join(home, 'bootstrap');
  mkdirSync(bootstrap, { recursive: true });

  // writer-authority.json projection
  const writer: WriterAuthority = {
    schemaVersion: 1,
    epoch: authority.writerEpoch,
    activeSlot: authority.activeSlot,
    fencingToken: authority.fencingToken,
    ...(authority.generation ? { generation: authority.generation } : {}),
    ...(authority.releaseRevision ? { releaseRevision: authority.releaseRevision } : {}),
    ...(authority.releasePath ? { releasePath: authority.releasePath } : {}),
    updatedAt: authority.committedAt,
    ...(authority.reason ? { reason: authority.reason } : {}),
  };
  atomicWrite(join(bootstrap, 'writer-authority.json'), writer);

  // active-runtime.json projection
  const pointer: ActiveRuntimePointer = {
    schemaVersion: 1,
    activeSlot: authority.activeSlot,
    ...(authority.generation ? { generation: authority.generation } : {}),
    ...(authority.releaseRevision ? { releaseRevision: authority.releaseRevision } : {}),
    ...(authority.releasePath ? { releasePath: authority.releasePath } : {}),
    writerEpoch: authority.writerEpoch,
    fencingToken: authority.fencingToken,
    ...(authority.daemonPort !== undefined ? { daemonPort: authority.daemonPort } : {}),
    ...(authority.gatewayPort !== undefined ? { gatewayPort: authority.gatewayPort } : {}),
    updatedAt: authority.committedAt,
  };
  atomicWrite(join(bootstrap, 'active-runtime.json'), pointer);

  // active-slot.json projection (root)
  const activeSlot = {
    schemaVersion: 1,
    activeSlot: authority.activeSlot,
    ...(authority.previousSlot ? { previousSlot: authority.previousSlot } : {}),
    ...(authority.generation ? { generation: authority.generation } : {}),
    ...(authority.reason ? { reason: authority.reason } : {}),
    ...(authority.rollbackUntil ? { rollbackUntil: authority.rollbackUntil } : {}),
    updatedAt: authority.committedAt,
  };
  atomicWrite(join(home, 'active-slot.json'), activeSlot);
}

/**
 * Commit a new activation authority in one transaction.
 * Throws on CAS failure or IO failure — never silently ignores.
 */
export function commitActivationTransaction(
  controllerHome: string,
  input: {
    activeSlot: RuntimeSlotId;
    generation?: string;
    releaseRevision?: string;
    releasePath?: string;
    daemonPort?: number;
    gatewayPort?: number;
    reason?: string;
    previousEpoch?: string;
    previousSlot?: RuntimeSlotId;
    previousRuntime?: PreviousRuntimeSnapshot;
    rollbackUntil?: string;
    /**
     * Bootstrap / activation authority holder may commit without holding the
     * runtime claim that is about to be replaced.
     */
    bootstrapMutation?: boolean;
    /** Test hook: stop after prepare journal is written. */
    crashAfterPrepare?: boolean;
    /** Test hook: stop after authority commit, before projections. */
    crashAfterCommitBeforeProjections?: boolean;
  },
): ActivationAuthorityRecord {
  const home = root(controllerHome);
  mkdirSync(join(home, 'bootstrap'), { recursive: true });

  // Activation/cutover/rollback is itself the bootstrap authority mutation.
  // Default bootstrapMutation=true so Bootstrap does not need the claim it is replacing.
  // Callers that want to require an active runtime claim must pass bootstrapMutation: false.
  if (input.bootstrapMutation === false) {
    try {
      assertThisRuntimeMayWriteOrThrow('release_mutation', home);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('WRITER_FENCED:')) throw error;
      /* unbound legacy */
    }
  }

  const existing = readActivationAuthority(home);
  if (input.previousEpoch) {
    const currentEpoch = existing?.writerEpoch
      ?? readJson<WriterAuthority>(join(home, 'bootstrap', 'writer-authority.json'))?.epoch;
    if (currentEpoch && currentEpoch !== input.previousEpoch) {
      throw new Error(
        `ACTIVATION_CAS_FAILED: expected previous epoch ${input.previousEpoch}, found ${currentEpoch}`,
      );
    }
  }

  const transactionId = `atx-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const writerEpoch = `wa-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const fencingToken = randomUUID();

  // Capture full previous runtime snapshot for authentic rollback.
  const previousRuntime: PreviousRuntimeSnapshot | undefined = input.previousRuntime
    ?? (existing
      ? {
          activeSlot: existing.activeSlot,
          generation: existing.generation,
          releaseRevision: existing.releaseRevision,
          releasePath: existing.releasePath,
          daemonPort: existing.daemonPort,
          gatewayPort: existing.gatewayPort,
          writerEpoch: existing.writerEpoch,
          fencingToken: existing.fencingToken,
          transactionId: existing.transactionId,
        }
      : undefined);

  const previousEpoch = input.previousEpoch ?? existing?.writerEpoch;
  const previousSlot = input.previousSlot ?? existing?.activeSlot;
  const intended: ActivationPrepareJournal['intended'] = {
    transactionId,
    activeSlot: input.activeSlot,
    ...(input.generation ? { generation: input.generation } : {}),
    ...(input.releaseRevision ? { releaseRevision: input.releaseRevision } : {}),
    ...(input.releasePath ? { releasePath: input.releasePath } : {}),
    writerEpoch,
    fencingToken,
    ...(input.daemonPort !== undefined ? { daemonPort: input.daemonPort } : {}),
    ...(input.gatewayPort !== undefined ? { gatewayPort: input.gatewayPort } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(previousEpoch ? { previousEpoch } : {}),
    ...(previousSlot ? { previousSlot } : {}),
    ...(previousRuntime ? { previousRuntime } : {}),
    ...(input.rollbackUntil ? { rollbackUntil: input.rollbackUntil } : {}),
  };

  const prepare: ActivationPrepareJournal = {
    schemaVersion: 1,
    status: 'prepared',
    transactionId,
    preparedAt: new Date().toISOString(),
    intended,
  };
  atomicWrite(activationPreparePath(home), prepare);

  if (input.crashAfterPrepare) {
    throw new Error('ACTIVATION_INJECTED_CRASH:after_prepare');
  }

  const committedAt = new Date().toISOString();
  const authority: ActivationAuthorityRecord = {
    schemaVersion: 1,
    status: 'committed',
    ...intended,
    committedAt,
  };

  // Commit the primary Runtime authority first. The historical activation,
  // writer, active-runtime and active-slot files are projections only.
  const config = migrateRuntimeConfig(home);
  const previous = previousRuntime && input.rollbackUntil
    ? {
        instanceId: previousRuntime.generation ?? previousRuntime.transactionId ?? `previous-${previousRuntime.activeSlot}`,
        ...(previousRuntime.releasePath ? { releasePath: previousRuntime.releasePath } : {}),
        ...(previousRuntime.releaseRevision ? { releaseRevision: previousRuntime.releaseRevision } : {}),
        publishedAt: committedAt,
        rollbackUntil: input.rollbackUntil,
      }
    : undefined;
  writeRuntimeAuthority(home, {
    schemaVersion: 2,
    status: 'committed',
    authorityTerm: writerEpoch,
    activationId: transactionId,
    generation: input.generation ?? `generation-${transactionId}`,
    configRevision: config.configRevision,
    configHash: runtimeConfigHash(home)!,
    fencingToken,
    active: {
      instanceId: input.generation ?? transactionId,
      ...(input.releasePath ? { releasePath: input.releasePath } : {}),
      ...(input.releaseRevision ? { releaseRevision: input.releaseRevision } : {}),
      publishedAt: committedAt,
    },
    ...(previous ? { previous } : {}),
    ingress: config.ingress,
    daemon: { port: input.daemonPort ?? config.daemon.port },
    gateway: { host: config.gateway.host, port: input.gatewayPort ?? config.gateway.port },
    legacySlot: input.activeSlot,
    ...(previousSlot ? { previousLegacySlot: previousSlot } : {}),
    ...(input.rollbackUntil ? { rollbackUntil: input.rollbackUntil } : {}),
    ...(input.reason ? { operationId: input.reason } : {}),
    committedAt,
  });
  atomicWrite(activationAuthorityPath(home), authority);

  if (input.crashAfterCommitBeforeProjections) {
    throw new Error('ACTIVATION_INJECTED_CRASH:after_commit_before_projections');
  }

  // Projections — if this fails, recoverActivationTransaction can rebuild them.
  writeCompatibilityProjections(home, authority);
  safeUnlink(activationPreparePath(home));
  return authority;
}

/**
 * After crash recovery rules:
 * - prepare.transactionId === authority.transactionId → authority committed; rebuild projections; clear matching prepare.
 * - prepare.transactionId !== authority.transactionId → keep prepare; report incomplete / prepared_pending_resolution.
 * - prepare only → do not invent authority.
 * Never silently delete a mismatched prepare based on time alone.
 */
export function recoverActivationTransaction(controllerHome: string): ActivationTransactionResult {
  const home = root(controllerHome);
  const primary = readRuntimeAuthority(home);
  if (primary) {
    const authority = primaryAuthorityToActivation(primary);
    atomicWrite(activationAuthorityPath(home), authority);
    writeCompatibilityProjections(home, authority);
    const prepare = readActivationPrepare(home);
    if (prepare && prepare.transactionId !== authority.transactionId) {
      return {
        ok: false,
        status: 'incomplete',
        authority,
        recovered: false,
        error: `prepared_pending_resolution: prepare ${prepare.transactionId} does not match committed ${authority.transactionId}`,
      };
    }
    if (prepare) safeUnlink(activationPreparePath(home));
    return { ok: true, status: 'committed', authority, recovered: true };
  }
  const inspect = inspectActivationTransaction(home);
  const authority = readActivationAuthority(home);
  const prepare = readActivationPrepare(home);

  if (authority && prepare) {
    if (prepare.transactionId === authority.transactionId) {
      // Matching prepare: commit already landed; rebuild projections and clear prepare.
      writeCompatibilityProjections(home, authority);
      safeUnlink(activationPreparePath(home));
      return { ok: true, status: 'committed', authority, recovered: true };
    }
    // Mismatched prepare belongs to another in-flight transaction — preserve it.
    writeCompatibilityProjections(home, authority);
    return {
      ok: false,
      status: 'incomplete',
      authority,
      recovered: false,
      error: `prepared_pending_resolution: prepare ${prepare.transactionId} does not match committed ${authority.transactionId}`,
    };
  }

  if (authority) {
    writeCompatibilityProjections(home, authority);
    return { ok: true, status: 'committed', authority, recovered: true };
  }

  if (prepare) {
    // Prepared but never committed — leave prepare for operator visibility; do not invent authority.
    return {
      ok: false,
      status: 'prepared',
      recovered: false,
      error: 'incomplete_activation_prepare_only; re-run activation',
    };
  }

  // One-way legacy migration is strict: all available projections must agree.
  // An ambiguous split-brain is operator-visible and never defaults to blue.
  try {
    const migrated = migrateRuntimeAuthority(home);
    const synthesized = primaryAuthorityToActivation(migrated);
    atomicWrite(activationAuthorityPath(home), synthesized);
    writeCompatibilityProjections(home, synthesized);
    return { ok: true, status: 'committed', authority: synthesized, recovered: true };
  } catch (error) {
    if (error instanceof Error && error.message === 'RUNTIME_AUTHORITY_MISSING') return inspect;
    return {
      ok: false,
      status: 'incomplete',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Rollback activation: restore the full previousRuntime snapshot (slot, generation,
 * release path/revision, ports) with a NEW writer epoch / fencing token.
 * The pre-rollback runtime is saved as the next previousRuntime for limited re-rollback.
 */
export function rollbackActivationTransaction(
  controllerHome: string,
  input: {
    generation?: string;
    reason?: string;
    crashMidway?: boolean;
    /** Explicit bootstrap context — rollback is an authority mutation. */
    bootstrapMutation?: boolean;
  } = {},
): ActivationAuthorityRecord {
  const current = readActivationAuthority(controllerHome)
    ?? recoverActivationTransaction(controllerHome).authority;
  if (!current) {
    throw new Error('ACTIVATION_ROLLBACK_FAILED: no committed authority to roll back');
  }

  const snapshot = current.previousRuntime;
  const previousSlot = snapshot?.activeSlot
    ?? current.previousSlot
    ?? (current.activeSlot === 'blue' ? 'green' : 'blue');

  // Prefer full snapshot metadata; fall back carefully without inventing mixed slot/release.
  const targetGeneration = snapshot?.generation ?? input.generation;
  const targetReleaseRevision = snapshot?.releaseRevision;
  const targetReleasePath = snapshot?.releasePath;
  const targetDaemonPort = snapshot?.daemonPort;
  const targetGatewayPort = snapshot?.gatewayPort;

  if (targetReleasePath) {
    // release path must still be under a controlled releases root when present.
    const normalized = targetReleasePath.replace(/\\/g, '/');
    if (!normalized.includes('/releases/') && !normalized.includes('/release/')) {
      throw new Error(
        `ACTIVATION_ROLLBACK_FAILED: previous release path is not under a controlled releases root: ${targetReleasePath}`,
      );
    }
  }

  // Save current as previousRuntime so a later rollback can re-enter this state.
  const rollbackPrevious: PreviousRuntimeSnapshot = {
    activeSlot: current.activeSlot,
    generation: current.generation,
    releaseRevision: current.releaseRevision,
    releasePath: current.releasePath,
    daemonPort: current.daemonPort,
    gatewayPort: current.gatewayPort,
    writerEpoch: current.writerEpoch,
    fencingToken: current.fencingToken,
    transactionId: current.transactionId,
  };

  if (input.crashMidway) {
    return commitActivationTransaction(controllerHome, {
      activeSlot: previousSlot,
      previousSlot: current.activeSlot,
      generation: targetGeneration,
      releaseRevision: targetReleaseRevision,
      releasePath: targetReleasePath,
      daemonPort: targetDaemonPort,
      gatewayPort: targetGatewayPort,
      reason: input.reason ?? 'rollback',
      previousEpoch: current.writerEpoch,
      previousRuntime: rollbackPrevious,
      bootstrapMutation: input.bootstrapMutation ?? true,
      crashAfterPrepare: true,
    });
  }

  return commitActivationTransaction(controllerHome, {
    activeSlot: previousSlot,
    previousSlot: current.activeSlot,
    generation: targetGeneration,
    releaseRevision: targetReleaseRevision,
    releasePath: targetReleasePath,
    daemonPort: targetDaemonPort,
    gatewayPort: targetGatewayPort,
    reason: input.reason ?? 'rollback',
    previousEpoch: current.writerEpoch,
    previousRuntime: rollbackPrevious,
    bootstrapMutation: input.bootstrapMutation ?? true,
  });
}
