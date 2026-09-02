import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { resolveControllerHome } from '../../cli/repositories/controller-home';
import { isProcessAlive } from '../shared/process-tree';
import { readRuntimeOwner } from './ownership';
import type {
  RuntimeDiagnosticEvidence,
  RuntimeReadiness,
  RuntimeStatusObservation,
  RuntimeStatusSnapshot,
} from './types';

export function runtimeStatusPath(controllerHome: string): string {
  return join(resolveControllerHome(controllerHome), 'runtime', 'status.json');
}

function validDiagnostic(value: unknown): value is RuntimeDiagnosticEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const diagnostic = value as RuntimeDiagnosticEvidence;
  return ['pass', 'fail', 'not_observed'].includes(diagnostic.outcome)
    && (diagnostic.reasonCode === undefined || typeof diagnostic.reasonCode === 'string');
}

function validReadiness(value: unknown): value is RuntimeReadiness {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const readiness = value as RuntimeReadiness;
  const diagnostics = readiness.diagnostics;
  return typeof readiness.ready === 'boolean'
    && Array.isArray(readiness.reasonCodes)
    && readiness.reasonCodes.every((reason) => typeof reason === 'string')
    && typeof readiness.observedAt === 'string'
    && Boolean(diagnostics)
    && validDiagnostic(diagnostics.database)
    && validDiagnostic(diagnostics.scheduler)
    && validDiagnostic(diagnostics.releaseCoherence)
    && validDiagnostic(diagnostics.mcpEndToEnd);
}

function validSnapshot(value: unknown): value is RuntimeStatusSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as RuntimeStatusSnapshot;
  return snapshot.schemaVersion === 1
    && (snapshot.forgeInstanceId === undefined || (typeof snapshot.forgeInstanceId === 'string' && snapshot.forgeInstanceId.length > 0))
    && typeof snapshot.runtimeInstanceId === 'string'
    && snapshot.runtimeInstanceId.length > 0
    && Number.isInteger(snapshot.pid)
    && snapshot.pid > 0
    && typeof snapshot.releaseId === 'string'
    && snapshot.releaseId.length > 0
    && typeof snapshot.artifactIdentity === 'string'
    && snapshot.artifactIdentity.length > 0
    && (snapshot.toolSurfaceFingerprint === undefined || typeof snapshot.toolSurfaceFingerprint === 'string')
    && (snapshot.endpoint === undefined || typeof snapshot.endpoint === 'string')
    && typeof snapshot.startedAt === 'string'
    && typeof snapshot.updatedAt === 'string'
    && validReadiness(snapshot.readiness);
}

export function writeRuntimeStatusSnapshot(controllerHome: string, snapshot: RuntimeStatusSnapshot): void {
  const path = runtimeStatusPath(controllerHome);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

export function readRuntimeStatusSnapshot(controllerHome: string): RuntimeStatusSnapshot | undefined {
  const path = runtimeStatusPath(controllerHome);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return validSnapshot(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function removeRuntimeStatusSnapshot(
  controllerHome: string,
  runtimeInstanceId: string,
  pid: number,
): void {
  const path = runtimeStatusPath(controllerHome);
  const snapshot = readRuntimeStatusSnapshot(controllerHome);
  if (snapshot?.runtimeInstanceId !== runtimeInstanceId || snapshot.pid !== pid) return;
  try { unlinkSync(path); } catch { /* already removed */ }
}

/**
 * This is a read-only projection, never lifecycle authority. A stored ready=true
 * is accepted only while the live Runtime owner has the same instance and PID.
 */
export function observeRuntimeStatus(
  controllerHome: string,
  now: () => string = () => new Date().toISOString(),
): RuntimeStatusObservation {
  const snapshot = readRuntimeStatusSnapshot(controllerHome);
  const owner = readRuntimeOwner(controllerHome);
  const ownerAlive = Boolean(owner && isProcessAlive(owner.pid));
  if (!snapshot) {
    return {
      schemaVersion: 1,
      running: ownerAlive,
      ready: false,
      stale: false,
      reasonCodes: [ownerAlive ? 'RUNTIME_STATUS_NOT_PUBLISHED' : 'RUNTIME_NOT_RUNNING'],
      observedAt: now(),
    };
  }
  const identityMatches = Boolean(owner
    && owner.runtimeInstanceId === snapshot.runtimeInstanceId
    && owner.pid === snapshot.pid);
  const running = ownerAlive && identityMatches;
  const stale = !running;
  const reasonCodes = stale
    ? [...new Set([...snapshot.readiness.reasonCodes, 'RUNTIME_STATUS_STALE'])]
    : [...snapshot.readiness.reasonCodes];
  return {
    schemaVersion: 1,
    running,
    ready: running && snapshot.readiness.ready,
    stale,
    reasonCodes,
    snapshot,
    observedAt: now(),
  };
}
