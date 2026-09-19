import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { chmodSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { backupControlPlaneDatabase, type ControlPlaneDatabaseInspection } from '../control-plane/persistence/sqlite-store';
import { forgeRuntimeServicePaths, readForgeRuntimeServiceConfig, writeForgeRuntimeServiceConfig, type ForgeRuntimeServiceConfig } from './service';

export interface StableExecutionLane {
  schemaVersion: 1;
  kind: 'stable';
  controllerHome: string;
  serviceLabel: string;
  port: number;
  authTokenFile: string;
}

export interface CandidateExecutionLane {
  schemaVersion: 1;
  kind: 'candidate';
  sessionId: string;
  controllerHome: string;
  serviceLabel: string;
  port: number;
  authTokenFile: string;
  databaseSnapshotPath: string;
  sourceStableControllerHome: string;
  createdAt: string;
}

function requireSessionId(value: string): string {
  const sessionId = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/.test(sessionId)) {
    throw new Error('RUNTIME_CANDIDATE_SESSION_ID_INVALID');
  }
  return sessionId;
}

function requireCandidatePort(port: number, stablePort: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('RUNTIME_CANDIDATE_PORT_INVALID');
  if (port === stablePort) throw new Error('RUNTIME_CANDIDATE_PORT_COLLIDES_WITH_STABLE');
  return port;
}

function candidateTokenPath(controllerHome: string): string {
  return join(controllerHome, 'mcp', 'runtime-token');
}

export function readStableExecutionLane(controllerHome: string): StableExecutionLane {
  const home = resolve(controllerHome);
  const paths = forgeRuntimeServicePaths(home);
  const config = readForgeRuntimeServiceConfig(paths.configPath);
  return {
    schemaVersion: 1,
    kind: 'stable',
    controllerHome: home,
    serviceLabel: paths.label,
    port: config.port,
    authTokenFile: config.authTokenFile,
  };
}

/** Pure lane derivation. It never starts a service or writes either Home. */
export function planCandidateExecutionLane(input: {
  stable: StableExecutionLane;
  candidateControllerHome: string;
  candidatePort: number;
  sessionId: string;
}): CandidateExecutionLane {
  const candidateHome = resolve(input.candidateControllerHome);
  if (candidateHome === resolve(input.stable.controllerHome)) {
    throw new Error('RUNTIME_CANDIDATE_CONTROLLER_HOME_COLLIDES_WITH_STABLE');
  }
  const port = requireCandidatePort(input.candidatePort, input.stable.port);
  const paths = forgeRuntimeServicePaths(candidateHome);
  if (paths.label === input.stable.serviceLabel) throw new Error('RUNTIME_CANDIDATE_SERVICE_LABEL_COLLIDES_WITH_STABLE');
  return {
    schemaVersion: 1,
    kind: 'candidate',
    sessionId: requireSessionId(input.sessionId),
    controllerHome: candidateHome,
    serviceLabel: paths.label,
    port,
    authTokenFile: candidateTokenPath(candidateHome),
    databaseSnapshotPath: join(candidateHome, 'control-plane.sqlite'),
    sourceStableControllerHome: resolve(input.stable.controllerHome),
    createdAt: new Date().toISOString(),
  };
}

function createPrivateCandidateToken(stableTokenPath: string, destination: string): void {
  if (!existsSync(stableTokenPath) || !statSync(stableTokenPath).isFile()) {
    throw new Error('RUNTIME_CANDIDATE_STABLE_AUTH_TOKEN_MISSING');
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(destination, `${randomBytes(32).toString('base64url')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { chmodSync(destination, 0o600); } catch { /* platform best effort */ }
}

function candidateServiceConfig(stable: ForgeRuntimeServiceConfig, lane: CandidateExecutionLane): ForgeRuntimeServiceConfig {
  return {
    ...stable,
    controllerHome: lane.controllerHome,
    port: lane.port,
    authTokenFile: lane.authTokenFile,
  };
}

/**
 * Create the only permitted Candidate B mutable foundation: a fresh Controller
 * Home with a consistent SQLite snapshot and an independent declarative
 * service contract. It deliberately does not copy Stable A's Runtime release
 * authority and never starts/stops a service; portable artifacts are published into B under B's own authority.
 */
export function createCandidateExecutionLane(input: {
  stableControllerHome: string;
  candidateControllerHome: string;
  candidatePort: number;
  sessionId: string;
}): { stable: StableExecutionLane; candidate: CandidateExecutionLane; database: ControlPlaneDatabaseInspection } {
  const stable = readStableExecutionLane(input.stableControllerHome);
  const candidate = planCandidateExecutionLane({
    stable,
    candidateControllerHome: input.candidateControllerHome,
    candidatePort: input.candidatePort,
    sessionId: input.sessionId,
  });
  if (existsSync(candidate.controllerHome)) throw new Error('RUNTIME_CANDIDATE_CONTROLLER_HOME_ALREADY_EXISTS');
  try {
    createPrivateCandidateToken(stable.authTokenFile, candidate.authTokenFile);
    const database = backupControlPlaneDatabase(stable.controllerHome, candidate.databaseSnapshotPath);
    writeForgeRuntimeServiceConfig(candidateServiceConfig(
      readForgeRuntimeServiceConfig(forgeRuntimeServicePaths(stable.controllerHome).configPath),
      candidate,
    ));
    assertCandidateExecutionLaneIsolation(stable, candidate);
    return { stable, candidate, database };
  } catch (error) {
    // No recursive cleanup is attempted here: this function never guesses at
    // a pre-existing user directory. The only writable target was required to
    // be absent, so the caller can inspect or explicitly retire a partial B.
    throw error;
  }
}

export function assertCandidateExecutionLaneIsolation(
  stable: StableExecutionLane,
  candidate: CandidateExecutionLane,
): void {
  if (resolve(stable.controllerHome) === resolve(candidate.controllerHome)) {
    throw new Error('RUNTIME_CANDIDATE_CONTROLLER_HOME_COLLIDES_WITH_STABLE');
  }
  if (stable.port === candidate.port) throw new Error('RUNTIME_CANDIDATE_PORT_COLLIDES_WITH_STABLE');
  if (stable.serviceLabel === candidate.serviceLabel) throw new Error('RUNTIME_CANDIDATE_SERVICE_LABEL_COLLIDES_WITH_STABLE');
  if (resolve(stable.authTokenFile) === resolve(candidate.authTokenFile)) {
    throw new Error('RUNTIME_CANDIDATE_AUTH_TOKEN_COLLIDES_WITH_STABLE');
  }
  if (resolve(candidate.databaseSnapshotPath) !== resolve(candidate.controllerHome, 'control-plane.sqlite')) {
    throw new Error('RUNTIME_CANDIDATE_DATABASE_PATH_INVALID');
  }
}

/**
 * Remove one retired Candidate B home after its ReleaseSession has reached a
 * terminal state. The path fence is deliberately derived from Stable A and
 * the session identity so terminal cleanup can never target an arbitrary
 * Controller Home.
 */
export function removeRetiredCandidateExecutionLane(
  stable: StableExecutionLane,
  candidate: CandidateExecutionLane,
): void {
  const stableHome = resolve(stable.controllerHome);
  const candidateHome = resolve(candidate.controllerHome);
  const candidateRoot = resolve(dirname(stableHome), 'candidate-runtime-lanes');
  if (candidateHome === stableHome) throw new Error('RUNTIME_CANDIDATE_CLEANUP_STABLE_COLLISION');
  if (resolve(dirname(candidateHome)) !== candidateRoot || basename(candidateHome) !== candidate.sessionId) {
    throw new Error('RUNTIME_CANDIDATE_CLEANUP_PATH_INVALID');
  }
  rmSync(candidateHome, { recursive: true, force: true });
}
