/**
 * Writer fencing for blue/green runtimes.
 *
 * Stable Bootstrap owns a single active writer authority epoch.
 * Passive candidates may run for readiness but must not:
 *   - consume queues
 *   - renew leases
 *   - write workflow/process terminal state
 *   - perform remote side effects
 *   - run cleanup
 *   - update active projections
 */

import { mkdirSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { ensureControllerHome } from '../../repositories/controller-home';
import type { RuntimeSlotId } from '../runtime-slots';
import {
  hasLegacyRuntimeAuthorityState,
  migrateRuntimeAuthority,
  migrateRuntimeConfig,
  readRuntimeAuthority,
  runtimeConfigHash,
  writeRuntimeAuthority,
} from '../../../runtime/bootstrap/runtime-authority';

export interface WriterAuthority {
  schemaVersion: 1;
  /** Monotonic epoch; any writer with a lower epoch is fenced out immediately. */
  epoch: string;
  activeSlot: RuntimeSlotId;
  fencingToken: string;
  generation?: string;
  releaseRevision?: string;
  releasePath?: string;
  updatedAt: string;
  reason?: string;
}

export interface WriterFenceCheck {
  allowed: boolean;
  reason?: string;
  authority?: WriterAuthority;
}

function authorityPath(controllerHome: string): string {
  return join(ensureControllerHome(controllerHome), 'bootstrap', 'writer-authority.json');
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

export function readWriterAuthority(controllerHome: string): WriterAuthority | undefined {
  let primary = readRuntimeAuthority(controllerHome);
  if (!primary && hasLegacyRuntimeAuthorityState(controllerHome)) {
    primary = migrateRuntimeAuthority(controllerHome);
  }
  if (primary) {
    return {
      schemaVersion: 1,
      epoch: primary.authorityTerm,
      activeSlot: primary.legacySlot,
      fencingToken: primary.fencingToken,
      generation: primary.generation,
      ...(primary.active.releaseRevision ? { releaseRevision: primary.active.releaseRevision } : {}),
      ...(primary.active.releasePath ? { releasePath: primary.active.releasePath } : {}),
      updatedAt: primary.committedAt,
      ...(primary.operationId ? { reason: primary.operationId } : {}),
    };
  }
  return undefined;
}

/**
 * Atomically publish a new writer authority. Old runtimes holding a previous
 * epoch/fencingToken immediately fail assertWriterAuthority checks.
 */
export function publishWriterAuthority(
  controllerHome: string,
  input: {
    activeSlot: RuntimeSlotId;
    generation?: string;
    releaseRevision?: string;
    releasePath?: string;
    reason?: string;
    previousEpoch?: string;
  },
): WriterAuthority {
  const home = ensureControllerHome(controllerHome);
  const existing = readRuntimeAuthority(home)
    ?? (hasLegacyRuntimeAuthorityState(home) ? migrateRuntimeAuthority(home) : undefined);
  if (input.previousEpoch && existing && existing.authorityTerm !== input.previousEpoch) {
    throw new Error(
      `WRITER_AUTHORITY_CAS_FAILED: expected previous epoch ${input.previousEpoch}, found ${existing.authorityTerm}`,
    );
  }
  const config = migrateRuntimeConfig(home);
  const committedAt = new Date().toISOString();
  const authorityTerm = `wa-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const fencingToken = randomUUID();
  const generation = input.generation ?? existing?.generation ?? `generation-${authorityTerm}`;
  const releasePath = input.releasePath ?? existing?.active.releasePath;
  const releaseRevision = input.releaseRevision ?? existing?.active.releaseRevision;
  const previousLegacySlot = existing?.legacySlot !== input.activeSlot ? existing?.legacySlot : existing?.previousLegacySlot;
  writeRuntimeAuthority(home, {
    schemaVersion: 2,
    status: 'committed',
    authorityTerm,
    activationId: `writer-rotation-${randomUUID()}`,
    generation,
    configRevision: config.configRevision,
    configHash: runtimeConfigHash(home)!,
    fencingToken,
    active: {
      instanceId: generation,
      ...(releasePath ? { releasePath } : {}),
      ...(releaseRevision ? { releaseRevision } : {}),
      ...(existing?.active.sourceCommit ? { sourceCommit: existing.active.sourceCommit } : {}),
      ...(existing?.active.manifestHash ? { manifestHash: existing.active.manifestHash } : {}),
      publishedAt: existing?.active.publishedAt ?? committedAt,
    },
    ...(existing?.previous ? { previous: existing.previous } : {}),
    ingress: config.ingress,
    daemon: existing?.daemon ?? config.daemon,
    gateway: existing?.gateway ?? { host: config.gateway.host, port: config.gateway.port },
    legacySlot: input.activeSlot,
    ...(previousLegacySlot ? { previousLegacySlot } : {}),
    ...(existing?.rollbackUntil ? { rollbackUntil: existing.rollbackUntil } : {}),
    ...(input.reason ? { operationId: input.reason } : {}),
    committedAt,
  });
  const next: WriterAuthority = {
    schemaVersion: 1,
    epoch: authorityTerm,
    activeSlot: input.activeSlot,
    fencingToken,
    generation,
    ...(releaseRevision ? { releaseRevision } : {}),
    ...(releasePath ? { releasePath } : {}),
    updatedAt: committedAt,
    ...(input.reason ? { reason: input.reason } : {}),
  };
  atomicWrite(authorityPath(home), next);
  return next;
}

/**
 * Passive candidate must not write. Returns allowed only when the caller's
 * epoch and fencing token match the current authority and the slot is active.
 */
export function assertWriterAuthority(
  controllerHome: string,
  claim: {
    slot: RuntimeSlotId;
    epoch?: string;
    fencingToken?: string;
    /** When true, allow missing authority (legacy single-runtime). */
    allowLegacyMissing?: boolean;
  },
): WriterFenceCheck {
  const authority = readWriterAuthority(controllerHome);
  if (!authority) {
    if (claim.allowLegacyMissing) return { allowed: true, reason: 'legacy_missing_authority' };
    return { allowed: false, reason: 'writer_authority_missing' };
  }
  if (claim.slot !== authority.activeSlot) {
    return { allowed: false, reason: 'passive_candidate_or_stale_slot', authority };
  }
  if (claim.epoch && claim.epoch !== authority.epoch) {
    return { allowed: false, reason: 'epoch_fenced', authority };
  }
  if (claim.fencingToken && claim.fencingToken !== authority.fencingToken) {
    return { allowed: false, reason: 'fencing_token_mismatch', authority };
  }
  return { allowed: true, authority };
}

export function isPassiveRuntime(
  controllerHome: string,
  slot: RuntimeSlotId,
): boolean {
  const authority = readWriterAuthority(controllerHome);
  if (!authority) return false;
  return authority.activeSlot !== slot;
}

/**
 * Operations forbidden on passive candidates.
 */
export const PASSIVE_FORBIDDEN_ACTIONS = [
  'consume_queue',
  'renew_lease',
  'release_lease',
  'write_process_terminal',
  'write_workflow_terminal',
  'remote_side_effect',
  'cleanup',
  'update_active_projection',
  'scheduler_write',
  'integrate_worktree',
  'release_mutation',
  'bootstrap_mutation',
  /** Cancel is a process-control mutation; fence before any signal. */
  'cancel_process',
] as const;

export type PassiveForbiddenAction = (typeof PASSIVE_FORBIDDEN_ACTIONS)[number];

export function assertActiveWriterForAction(
  controllerHome: string,
  claim: {
    slot: RuntimeSlotId;
    epoch?: string;
    fencingToken?: string;
    allowLegacyMissing?: boolean;
  },
  action: PassiveForbiddenAction,
): WriterFenceCheck {
  const check = assertWriterAuthority(controllerHome, claim);
  if (!check.allowed) {
    return {
      allowed: false,
      reason: `passive_forbidden:${action}:${check.reason ?? 'denied'}`,
      authority: check.authority,
    };
  }
  return check;
}
