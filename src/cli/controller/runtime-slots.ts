import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { ensureControllerHome } from '../repositories/controller-home';
import { managedResource, type ManagedResource } from '../../runtime/resources';
import { atomicActivateRuntime } from '../../runtime/bootstrap/stable-bootstrap';
import {
  hasLegacyRuntimeAuthorityState,
  migrateRuntimeAuthority,
  readRuntimeAuthority,
} from '../../runtime/bootstrap/runtime-authority';

export type RuntimeSlotId = 'blue' | 'green';

export interface ActiveSlotAuthority {
  schemaVersion: 1;
  activeSlot: RuntimeSlotId;
  previousSlot?: RuntimeSlotId;
  generation?: string;
  updatedAt: string;
  reason?: string;
  /** ISO timestamp until which the previous slot may be used for rollback. */
  rollbackUntil?: string;
}

export interface SlotIdentity {
  schemaVersion: 1;
  slot: RuntimeSlotId;
  role: 'active' | 'inactive' | 'candidate' | 'standby' | 'failed';
  controllerHome: string;
  slotHome: string;
  mcpPort: number;
  localControllerPort: number;
  generation?: string;
  sourceCommit?: string;
  releasePath?: string;
  releaseRevision?: string;
  startedAt?: string;
  updatedAt: string;
  processGroupLeader?: number;
  logDir: string;
  /** Additive ownership metadata for slot-home cleanup protection. */
  resources?: ManagedResource[];
}

const DEFAULT_ROLLBACK_WINDOW_MS = 15 * 60_000;

function nowIso(): string {
  return new Date().toISOString();
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function controllerAuthorityHome(controllerHome: string): string {
  const home = ensureControllerHome(controllerHome);
  return runtimeSlotForHome(home) ? dirname(dirname(home)) : home;
}

export function activeSlotAuthorityPath(controllerHome: string): string {
  return join(controllerAuthorityHome(controllerHome), 'active-slot.json');
}

export function runtimeSlotsRoot(controllerHome: string): string {
  return join(controllerAuthorityHome(controllerHome), 'runtime-slots');
}

export function slotHomePath(controllerHome: string, slot: RuntimeSlotId): string {
  return join(runtimeSlotsRoot(controllerHome), slot);
}

export function slotIdentityPath(controllerHome: string, slot: RuntimeSlotId): string {
  return join(slotHomePath(controllerHome, slot), 'slot.json');
}

export function slotLogDir(controllerHome: string, slot: RuntimeSlotId): string {
  return join(slotHomePath(controllerHome, slot), 'logs');
}

export function oppositeSlot(slot: RuntimeSlotId): RuntimeSlotId {
  return slot === 'blue' ? 'green' : 'blue';
}

/** Returns the slot encoded by a dedicated slot home without reading or writing state. */
export function runtimeSlotForHome(controllerHome: string): RuntimeSlotId | undefined {
  const normalized = resolve(controllerHome).replace(/\\/g, '/');
  const match = normalized.match(/\/runtime-slots\/(blue|green)$/);
  return match?.[1] === 'blue' || match?.[1] === 'green' ? match[1] : undefined;
}

export function readActiveSlotAuthority(controllerHome: string): ActiveSlotAuthority {
  const home = controllerAuthorityHome(controllerHome);
  let primary = readRuntimeAuthority(home);
  if (!primary && hasLegacyRuntimeAuthorityState(home)) primary = migrateRuntimeAuthority(home);
  if (primary) {
    return {
      schemaVersion: 1,
      activeSlot: primary.legacySlot,
      ...(primary.previousLegacySlot ? { previousSlot: primary.previousLegacySlot } : {}),
      generation: primary.generation,
      ...(primary.operationId ? { reason: primary.operationId } : {}),
      ...(primary.rollbackUntil ? { rollbackUntil: primary.rollbackUntil } : {}),
      updatedAt: primary.committedAt,
    };
  }
  return {
    schemaVersion: 1,
    activeSlot: 'blue',
    updatedAt: nowIso(),
    reason: 'fresh-bootstrap-default',
  };
}

export function writeActiveSlotAuthority(
  controllerHome: string,
  patch: Omit<ActiveSlotAuthority, 'schemaVersion' | 'updatedAt'> & { updatedAt?: string },
): ActiveSlotAuthority {
  const current = readRuntimeAuthority(controllerAuthorityHome(controllerHome));
  const previousSlot = patch.previousSlot ?? current?.legacySlot;
  const generation = patch.generation ?? current?.generation;
  const activated = atomicActivateRuntime(controllerHome, {
    activeSlot: patch.activeSlot,
    ...(previousSlot ? { previousSlot } : {}),
    ...(generation ? { generation } : {}),
    ...(current?.active.releaseRevision ? { releaseRevision: current.active.releaseRevision } : {}),
    ...(current?.active.releasePath ? { releasePath: current.active.releasePath } : {}),
    ...(current?.daemon.port !== undefined ? { daemonPort: current.daemon.port } : {}),
    ...(current?.gateway.port !== undefined ? { gatewayPort: current.gateway.port } : {}),
    reason: patch.reason ?? 'compatibility-active-slot-write',
    ...(current?.authorityTerm ? { previousEpoch: current.authorityTerm } : {}),
    ...(patch.rollbackUntil ? { rollbackUntil: patch.rollbackUntil } : {}),
  });
  return {
    schemaVersion: 1,
    activeSlot: activated.authority.activeSlot,
    ...(previousSlot ? { previousSlot } : {}),
    ...(activated.authority.generation ? { generation: activated.authority.generation } : {}),
    ...(patch.reason ? { reason: patch.reason } : {}),
    ...(patch.rollbackUntil ? { rollbackUntil: patch.rollbackUntil } : {}),
    updatedAt: patch.updatedAt ?? activated.authority.updatedAt,
  };
}

export function ensureSlotHome(controllerHome: string, slot: RuntimeSlotId): string {
  const home = ensureControllerHome(slotHomePath(controllerHome, slot));
  mkdirSync(slotLogDir(controllerHome, slot), { recursive: true });
  return home;
}

export function readSlotIdentity(controllerHome: string, slot: RuntimeSlotId): SlotIdentity | null {
  const value = readJson<SlotIdentity>(slotIdentityPath(controllerHome, slot));
  if (!value || value.schemaVersion !== 1) return null;
  if (value.slot !== slot) return null;
  return value;
}

export function writeSlotIdentity(controllerHome: string, identity: SlotIdentity): SlotIdentity {
  ensureSlotHome(controllerHome, identity.slot);
  const resourceCreatedAt = identity.resources?.[0]?.createdAt ?? identity.startedAt ?? nowIso();
  const next: SlotIdentity = {
    ...identity,
    schemaVersion: 1,
    updatedAt: nowIso(),
    resources: identity.resources ?? [managedResource({
      resourceId: `runtime-slot:${resolve(identity.controllerHome)}:${identity.slot}`,
      type: 'runtime_slot',
      owner: { kind: 'runtime_slot', id: `${resolve(identity.controllerHome)}:${identity.slot}` },
      createdAt: resourceCreatedAt,
      state: identity.role === 'failed' ? 'retained' : 'active',
      path: identity.slotHome,
      ...(identity.role === 'failed' ? { retentionReason: 'slot marked failed; cleanup requires explicit authority and rollback checks.' } : {}),
    })],
  };
  atomicWrite(slotIdentityPath(controllerHome, identity.slot), next);
  return next;
}

export function markCutoverAuthority(
  controllerHome: string,
  nextActive: RuntimeSlotId,
  generation: string | undefined,
  rollbackWindowMs = DEFAULT_ROLLBACK_WINDOW_MS,
  release?: { releaseRevision?: string; releasePath?: string },
): ActiveSlotAuthority {
  const current = readActiveSlotAuthority(controllerHome);
  const idempotent = current.activeSlot === nextActive;
  const rollbackUntil = idempotent
    ? current.rollbackUntil
    : new Date(Date.now() + Math.max(0, rollbackWindowMs)).toISOString();
  const nextGeneration = generation ?? current.generation;
  const previousSlot = idempotent ? current.previousSlot : current.activeSlot;
  const activated = atomicActivateRuntime(controllerHome, {
    activeSlot: nextActive,
    ...(nextGeneration ? { generation: nextGeneration } : {}),
    ...(release?.releaseRevision ? { releaseRevision: release.releaseRevision } : {}),
    ...(release?.releasePath ? { releasePath: release.releasePath } : {}),
    reason: idempotent ? 'cutover-idempotent' : 'cutover',
    ...(previousSlot ? { previousSlot } : {}),
    ...(rollbackUntil ? { rollbackUntil } : {}),
  });
  const activatedGeneration = activated.authority.generation ?? nextGeneration;
  return {
    schemaVersion: 1,
    activeSlot: activated.authority.activeSlot,
    ...(previousSlot ? { previousSlot } : {}),
    ...(activatedGeneration ? { generation: activatedGeneration } : {}),
    reason: idempotent ? 'cutover-idempotent' : 'cutover',
    ...(rollbackUntil ? { rollbackUntil } : {}),
    updatedAt: activated.authority.updatedAt,
  };
}

export function markRollbackAuthority(
  controllerHome: string,
  generation: string | undefined,
  release?: { releaseRevision?: string; releasePath?: string },
): ActiveSlotAuthority {
  const current = readActiveSlotAuthority(controllerHome);
  const previous = current.previousSlot ?? oppositeSlot(current.activeSlot);
  const activated = atomicActivateRuntime(controllerHome, {
    activeSlot: previous,
    previousSlot: current.activeSlot,
    ...(generation ? { generation } : {}),
    ...(release?.releaseRevision ? { releaseRevision: release.releaseRevision } : {}),
    ...(release?.releasePath ? { releasePath: release.releasePath } : {}),
    reason: 'rollback',
  });
  const activatedGeneration = activated.authority.generation ?? generation;
  return {
    schemaVersion: 1,
    activeSlot: activated.authority.activeSlot,
    previousSlot: current.activeSlot,
    ...(activatedGeneration ? { generation: activatedGeneration } : {}),
    reason: 'rollback',
    updatedAt: activated.authority.updatedAt,
  };
}

export function isRollbackWindowOpen(authority: ActiveSlotAuthority, now = Date.now()): boolean {
  if (!authority.rollbackUntil) return Boolean(authority.previousSlot);
  const until = Date.parse(authority.rollbackUntil);
  return Number.isFinite(until) && until >= now;
}

