import { randomUUID } from 'crypto';
import { withControllerLock } from '../../../cli/repositories/locks';
import {
  readControlPlaneRecord,
  writeControlPlaneRecord,
} from '../persistence/sqlite-store';
import type { ControllerType } from '../facade/types';

const NAMESPACE = 'external_controller_launch_reservation';
const DEFAULT_TTL_MS = 2 * 60_000;
const MAX_TTL_MS = 10 * 60_000;

export interface ExternalControllerLaunchReservation {
  schemaVersion: 1;
  repoId: string;
  workId: string;
  reservationId: string;
  controllerType: Exclude<ControllerType, 'human'>;
  createdAt: string;
  expiresAt: string;
  pid?: number;
  releasedAt?: string;
  releaseReason?: string;
}

export interface LaunchReservationStoreOptions {
  controllerHome: string;
  repoId: string;
  now?: () => string;
}

function nowIso(options: LaunchReservationStoreOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

function record(options: LaunchReservationStoreOptions, workId: string) {
  return readControlPlaneRecord<ExternalControllerLaunchReservation>(
    options.controllerHome,
    NAMESPACE,
    options.repoId,
    workId,
  );
}

function active(value: ExternalControllerLaunchReservation | undefined, at = Date.now()): ExternalControllerLaunchReservation | undefined {
  if (!value || value.releasedAt) return undefined;
  return Date.parse(value.expiresAt) > at ? value : undefined;
}

export function getExternalControllerLaunchReservation(
  options: LaunchReservationStoreOptions,
  workId: string,
): ExternalControllerLaunchReservation | undefined {
  return active(record(options, workId)?.value);
}

export function reserveExternalControllerLaunch(
  options: LaunchReservationStoreOptions,
  input: {
    workId: string;
    controllerType: Exclude<ControllerType, 'human'>;
    ttlMs?: number;
  },
): ExternalControllerLaunchReservation {
  if (!input.workId.trim()) throw new Error('CONTROLLER_LAUNCH_WORK_REQUIRED');
  return withControllerLock(
    options.controllerHome,
    { scope: 'task', repoId: options.repoId, taskId: `controller-launch-${input.workId}` },
    `controller-launch-reserve:${input.workId}`,
    () => {
      const existing = record(options, input.workId);
      const current = active(existing?.value);
      if (current) {
        throw new Error(`CONTROLLER_LAUNCH_ALREADY_RESERVED: ${input.workId}:${current.reservationId}`);
      }
      const createdAt = nowIso(options);
      const ttlMs = Math.max(5_000, Math.min(input.ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS));
      const reservation: ExternalControllerLaunchReservation = {
        schemaVersion: 1,
        repoId: options.repoId,
        workId: input.workId,
        reservationId: randomUUID(),
        controllerType: input.controllerType,
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
      };
      writeControlPlaneRecord(options.controllerHome, {
        namespace: NAMESPACE,
        scope: options.repoId,
        key: input.workId,
        schemaVersion: 1,
        value: reservation,
        action: 'external_controller_launch_reserve',
        expectedRevision: existing?.revision ?? null,
      });
      return reservation;
    },
  );
}

export function attachExternalControllerLaunchPid(
  options: LaunchReservationStoreOptions,
  workId: string,
  reservationId: string,
  pid: number | undefined,
): ExternalControllerLaunchReservation {
  return withControllerLock(
    options.controllerHome,
    { scope: 'task', repoId: options.repoId, taskId: `controller-launch-${workId}` },
    `controller-launch-bind:${reservationId}`,
    () => {
      const existing = record(options, workId);
      if (!existing || existing.value.reservationId !== reservationId) {
        throw new Error(`CONTROLLER_LAUNCH_RESERVATION_STALE: ${workId}:${reservationId}`);
      }
      const next = { ...existing.value, ...(pid ? { pid } : {}) };
      writeControlPlaneRecord(options.controllerHome, {
        namespace: NAMESPACE,
        scope: options.repoId,
        key: workId,
        schemaVersion: 1,
        value: next,
        action: 'external_controller_launch_bind_pid',
        expectedRevision: existing.revision,
      });
      return next;
    },
  );
}

export function releaseExternalControllerLaunchReservation(
  options: LaunchReservationStoreOptions,
  workId: string,
  reservationId: string,
  reason: string,
): void {
  withControllerLock(
    options.controllerHome,
    { scope: 'task', repoId: options.repoId, taskId: `controller-launch-${workId}` },
    `controller-launch-release:${reservationId}`,
    () => {
      const existing = record(options, workId);
      if (!existing || existing.value.reservationId !== reservationId || existing.value.releasedAt) return;
      const releasedAt = nowIso(options);
      writeControlPlaneRecord(options.controllerHome, {
        namespace: NAMESPACE,
        scope: options.repoId,
        key: workId,
        schemaVersion: 1,
        value: {
          ...existing.value,
          expiresAt: releasedAt,
          releasedAt,
          releaseReason: reason.slice(0, 240),
        },
        action: 'external_controller_launch_release',
        expectedRevision: existing.revision,
      });
    },
  );
}
