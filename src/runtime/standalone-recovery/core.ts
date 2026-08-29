import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { observeRuntimeStatus } from '../root/status';
import {
  activeRuntimeEntrypoint,
  activeRuntimeLaunchSpec,
  ensureForgeRuntimeLaunchAgentContract,
  forgeRuntimeServicePaths,
  inspectForgeRuntimeLaunchAgentContract,
  readForgeRuntimeServiceConfig,
} from '../root/service';
import { loadRuntimeReleaseManifest } from '../root/release-manifest';
import { assertRuntimeReleaseFiles, stageRuntimeReleaseFromCandidateSource, type StagedRuntimeRelease } from '../root/release-materialize';
import {
  publishRuntimeRelease,
  readRuntimeReleaseAuthority,
  rollbackRuntimeRelease,
  type RuntimePublishedRelease,
  type RuntimeReleaseAuthority,
} from '../root/release-store';
import type { RuntimeReleaseManifest } from '../root/types';
import { ensurePackageConnectorService, packageConnectorServicePaths, type PackageConnectorReleaseBinding } from '../root/package-connector-service';
import { createRecoveryHttpTransport, type RecoveryHttpTransport } from './http-transport';
import { observeRecoveryWatchdogHealth } from './watchdog-heartbeat';
import { RECOVERY_GATEWAY_LABEL, RECOVERY_WATCHDOG_LABEL } from './service-labels';
import {
  migrateStoppedRepoLocalControllerHomeStorage,
  repoLocalControllerHomeStorageNeedsMigration,
  rollbackStoppedRepoLocalControllerHomeStorage,
  type ControllerHomeStorageMigration,
} from '../../cli/repositories/controller-home';

/** Standalone recovery reads only canonical Runtime observation and whole-release authority. */
export interface PublicTunnelServiceConfig {
  platform: 'launchd';
  label: string;
  plistPath?: string;
  minimumFailures?: number;
  minimumFailureDurationMs?: number;
  cooldownMs?: number;
  postRestartVerifyTimeoutMs?: number;
}

export interface PrimaryRuntimeServiceConfig {
  platform: 'launchd';
  minimumFailures?: number;
  minimumFailureDurationMs?: number;
  restartCooldownMs?: number;
  maximumRestartAttempts?: number;
  /** Continuous healthy time required before the same release earns a fresh restart budget. */
  restartBudgetStableDurationMs?: number;
  recoveryCooldownMs?: number;
  postRestartVerifyTimeoutMs?: number;
}

export interface PrimaryConnectorServiceConfig {
  platform: 'launchd';
  label: string;
  plistPath?: string;
  /** Local OAuth MCP endpoint used to distinguish Connector failure from tunnel failure. */
  localMcpUrl?: string;
  minimumFailures?: number;
  minimumFailureDurationMs?: number;
  restartCooldownMs?: number;
  maximumRestartAttempts?: number;
  postRestartVerifyTimeoutMs?: number;
}

export interface RecoveryConfig {
  schemaVersion: 1;
  controllerHome: string;
  publicMcpUrl?: string;
  recoveryPublicUrl?: string;
  recoveryTunnelService?: PublicTunnelServiceConfig;
  /** Optional public tunnel serving publicMcpUrl; independent from the OAuth Connector process. */
  primaryPublicTunnelService?: PublicTunnelServiceConfig;
  primaryRuntimeService?: PrimaryRuntimeServiceConfig;
  primaryRuntimeSourceRoot?: string;
  primaryConnectorService?: PrimaryConnectorServiceConfig;
  mainMcpTokenFile?: string;
  expectedToolFingerprint?: string;
  readOnlyTool?: { name: string; arguments?: Record<string, unknown> };
  gateway?: { host: string; port: number; bearerTokenFile: string };
}

interface ReleaseEvidence {
  path: string;
  revision: string;
  artifactIdentity: string;
  manifestSha256: string;
  workerProtocolVersion: number;
  controllerHome?: string;
  releaseAuthorityRevision?: number;
  releaseFencingTokenSha256?: string;
  attestedAt?: string;
}

interface KnownGoodStore {
  schemaVersion: 1;
  releases: ReleaseEvidence[];
  updatedAt: string;
}

export type RecoveryMutationAction =
  | 'attest_known_good'
  | 'rollback_previous'
  | 'restart_primary_runtime'
  | 'recover_primary_runtime'
  | 'activate_runtime_release'
  | 'stage_and_activate_runtime_release'
  | 'restart_primary_connector'
  | 'restart_recovery_gateway'
  | 'restart_recovery_watchdog'
  | 'repair_public_tunnel';

interface RecoveryLock {
  schemaVersion?: 1;
  pid: number;
  instanceId: string;
  processStartTime?: string;
  acquiredAt: string;
  action?: RecoveryMutationAction;
  requestId?: string;
}

interface RecoveryLockIntent {
  action: RecoveryMutationAction;
  requestId?: string;
}

type RecoveryLockAttempt<T> =
  | { acquired: true; value: T }
  | { acquired: false; owner: RecoveryLock };

export interface VerifyResult {
  ok: boolean;
  at: string;
  runtime: { ok: boolean; running: boolean; ready: boolean; stale: boolean; reasonCodes: string[] };
  releases: { active?: ReleaseEvidence; previous?: ReleaseEvidence; knownGood?: ReleaseEvidence; coherent: boolean };
  probes: Record<string, { ok: boolean; detail: string; status?: number; value?: unknown }>;
}

export interface VerifyStableRuntimeOptions {
  probeMcpProtocol?: boolean;
}

/** Bounded, release-scoped explanation for a failed watchdog verification. */
export interface RecoveryWatchdogDiagnosticEvidence {
  fingerprint: string;
  releaseIdentity: string;
  components: Array<'runtime' | 'gateway' | 'public_mcp' | 'recovery_gateway' | 'recovery_watchdog' | 'recovery_tunnel'>;
  failedProbes: Array<{ name: string; component: 'runtime' | 'gateway' | 'public_mcp' | 'recovery_gateway' | 'recovery_watchdog' | 'recovery_tunnel'; detail: string; status?: number }>;
  firstObservedAt: string;
  lastObservedAt: string;
  occurrences: number;
}

interface RecoveryWatchdogDiagnosticStore {
  schemaVersion: 1;
  entries: RecoveryWatchdogDiagnosticEvidence[];
}

export interface RollbackResult {
  ok: boolean;
  noOp?: boolean;
  operationId?: string;
  detail: string;
  verify?: VerifyResult;
}

export interface WatchdogDecision {
  action: 'healthy' | 'degraded' | 'repair_public_tunnel' | 'restart_recovery_gateway' | 'restart_primary_connector' | 'restart_primary_runtime' | 'rollback' | 'recovery_exhausted';
  reason: string;
}

export interface WatchdogState {
  failures: number;
  firstFailureAt?: number;
  rollbackUsed: boolean;
  runtimeRestartAttempts?: number;
  runtimeRestartFailures?: number;
  runtimeRestartLastAttemptAt?: number;
  /** Exact active Runtime release for the persisted restart budget. */
  runtimeRestartBudgetIdentity?: string;
  /** First continuously healthy observation for the active Runtime release. */
  runtimeHealthySince?: number;
  /** First observation that exhausted the active release's automatic recovery budget. */
  runtimeRestartBudgetExhaustedAt?: number;
  runtimeRecoveryFailures?: number;
  runtimeRecoveryLastAttemptAt?: number;
  publicTunnelFailures?: number;
  publicTunnelFirstFailureAt?: number;
  publicTunnelRepairFailures?: number;
  primaryConnectorFailures?: number;
  primaryConnectorFirstFailureAt?: number;
  primaryConnectorRestartAttempts?: number;
  primaryConnectorRestartFailures?: number;
  primaryConnectorRestartLastAttemptAt?: number;
  recoveryGatewayRestartUsed?: boolean;
  recoveryReleaseRevision?: string;
  lastFullVerifyAt?: number;
  lastDecision?: WatchdogDecision['action'];
  lastReason?: string;
  updatedAt?: string;
}

export interface PublicTunnelRepairResult {
  ok: boolean;
  attempted: boolean;
  noOp?: boolean;
  detail: string;
  serviceLabel?: string;
  serviceTarget?: string;
  verify: VerifyResult;
  localVerify?: VerifyResult;
}

export interface PrimaryRuntimeRestartResult {
  ok: boolean;
  attempted: boolean;
  noOp?: boolean;
  detail: string;
  serviceTarget?: string;
  verify: VerifyResult;
}

export interface PrimaryConnectorRestartResult {
  ok: boolean;
  attempted: boolean;
  noOp?: boolean;
  detail: string;
  serviceTarget?: string;
  verify: VerifyResult;
}

export interface ConfiguredRuntimeActivationResult {
  ok: boolean;
  attempted: boolean;
  noOp?: boolean;
  detail: string;
  staged?: StagedRuntimeRelease;
  activation?: RuntimeReleaseActivationResult;
}

export interface PrimaryRuntimeRecoveryResult {
  ok: boolean;
  attempted: boolean;
  noOp?: boolean;
  detail: string;
  serviceTarget?: string;
  rollback?: RollbackResult;
  verify: VerifyResult;
}

export interface RuntimeReleaseActivationResult {
  ok: boolean;
  attempted: boolean;
  noOp?: boolean;
  detail: string;
  serviceTarget?: string;
  operationId?: string;
  rollback?: RollbackResult;
  verify?: VerifyResult;
}

// This must be a bounded, stable tool that succeeds before a repository has
// been selected. rh_status is repository-scoped in multi-repository homes, so
// it can report REPOSITORY_AMBIGUOUS even when the Runtime is healthy.
const STABLE_RECOVERY_READ_ONLY_TOOL = { name: 'repository_list', arguments: {} } as const;
const RETIRED_RECOVERY_READ_ONLY_TOOLS = new Set(['controller_context', 'controller_ready']);

function normalizeRecoveryReadOnlyTool(
  input: RecoveryConfig['readOnlyTool'] | undefined,
): NonNullable<RecoveryConfig['readOnlyTool']> {
  if (!input || RETIRED_RECOVERY_READ_ONLY_TOOLS.has(input.name)) {
    return { name: STABLE_RECOVERY_READ_ONLY_TOOL.name, arguments: { ...STABLE_RECOVERY_READ_ONLY_TOOL.arguments } };
  }
  return input;
}

const DEFAULT_CONFIG: Omit<RecoveryConfig, 'controllerHome'> = {
  schemaVersion: 1,
  readOnlyTool: { name: STABLE_RECOVERY_READ_ONLY_TOOL.name, arguments: { ...STABLE_RECOVERY_READ_ONLY_TOOL.arguments } },
  primaryRuntimeService: { platform: 'launchd' },
};

function json<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch { /* best effort */ }
  renameSync(temporary, path);
}

function recoveryRoot(config: RecoveryConfig): string { return join(resolve(config.controllerHome), 'recovery'); }
function statePath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'state', 'known-good.json'); }
function lockPath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'locks', 'operation.lock'); }
function auditPath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'audit', 'recovery.jsonl'); }
function watchdogDiagnosticPath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'state', 'watchdog-diagnostics.json'); }
function quarantinePath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'state', 'quarantine.json'); }
function publicTunnelRepairStatePath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'state', 'public-tunnel-repair.json'); }
function watchdogStatePath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'state', 'watchdog.json'); }
export function loadWatchdogState(config: RecoveryConfig): WatchdogState {
  const state = json<WatchdogState>(watchdogStatePath(config));
  if (!state || !Number.isInteger(state.failures) || state.failures < 0 || typeof state.rollbackUsed !== 'boolean') {
    return { failures: 0, rollbackUsed: false, publicTunnelFailures: 0, publicTunnelRepairFailures: 0 };
  }
  return state;
}

export function saveWatchdogState(config: RecoveryConfig, state: WatchdogState): WatchdogState {
  const persisted = { ...state, updatedAt: new Date().toISOString() };
  writeJson(watchdogStatePath(config), persisted);
  return persisted;
}

function configuredRecoveryTunnel(config: RecoveryConfig): PublicTunnelServiceConfig | undefined {
  return config.recoveryTunnelService;
}

function configuredPrimaryPublicTunnel(config: RecoveryConfig): PublicTunnelServiceConfig | undefined {
  return config.primaryPublicTunnelService;
}

function configuredRecoveryPublicUrl(config: RecoveryConfig): string | undefined {
  return config.recoveryPublicUrl;
}

export const STANDALONE_RECOVERY_REQUIRED_RELEASE_FILES = [
  'manifest.json',
  'forge-runtime.mjs',
] as const;

export function recoveryConfigPath(controllerHome: string): string {
  return join(resolve(controllerHome), 'recovery', 'config', 'recovery.json');
}

export function loadRecoveryConfig(controllerHome: string, explicit?: string): RecoveryConfig {
  const configPath = explicit ?? recoveryConfigPath(controllerHome);
  const loaded = json<Partial<RecoveryConfig> & Record<string, unknown>>(configPath) ?? {};
  const readOnlyTool = normalizeRecoveryReadOnlyTool(loaded.readOnlyTool);
  const config: RecoveryConfig = {
    ...DEFAULT_CONFIG,
    schemaVersion: 1,
    controllerHome: resolve(typeof loaded.controllerHome === 'string' ? loaded.controllerHome : controllerHome),
    ...(typeof loaded.publicMcpUrl === 'string' ? { publicMcpUrl: loaded.publicMcpUrl } : {}),
    ...(typeof loaded.recoveryPublicUrl === 'string' ? { recoveryPublicUrl: loaded.recoveryPublicUrl } : {}),
    ...(loaded.recoveryTunnelService ? { recoveryTunnelService: loaded.recoveryTunnelService } : {}),
    ...(loaded.primaryPublicTunnelService ? { primaryPublicTunnelService: loaded.primaryPublicTunnelService } : {}),
    ...(loaded.primaryRuntimeService ? { primaryRuntimeService: loaded.primaryRuntimeService } : {}),
    ...(typeof loaded.primaryRuntimeSourceRoot === 'string' ? { primaryRuntimeSourceRoot: resolve(loaded.primaryRuntimeSourceRoot) } : {}),
    ...(loaded.primaryConnectorService ? { primaryConnectorService: loaded.primaryConnectorService } : {}),
    ...(typeof loaded.mainMcpTokenFile === 'string' ? { mainMcpTokenFile: loaded.mainMcpTokenFile } : {}),
    ...(typeof loaded.expectedToolFingerprint === 'string' ? { expectedToolFingerprint: loaded.expectedToolFingerprint } : {}),
    readOnlyTool,
    ...(loaded.gateway ? { gateway: loaded.gateway } : {}),
  };
  if (!config.controllerHome) throw new Error('RECOVERY_CONTROLLER_HOME_REQUIRED');
  return config;
}

export function createRecoveryConfig(controllerHome: string, input?: Partial<RecoveryConfig>): RecoveryConfig {
  const config = loadRecoveryConfig(controllerHome);
  const next: RecoveryConfig = {
    ...config,
    ...input,
    schemaVersion: 1,
    controllerHome: resolve(controllerHome),
    readOnlyTool: normalizeRecoveryReadOnlyTool(input?.readOnlyTool ?? config.readOnlyTool),
  };
  writeJson(recoveryConfigPath(controllerHome), next);
  return next;
}

function releaseEvidence(
  controllerHome: string,
  release: RuntimePublishedRelease | undefined,
  authority: RuntimeReleaseAuthority | undefined,
): ReleaseEvidence | undefined {
  if (!release || !authority) return undefined;
  return {
    path: release.manifestPath,
    revision: release.releaseId,
    artifactIdentity: release.artifactIdentity,
    manifestSha256: release.manifestSha256,
    workerProtocolVersion: release.workerProtocolVersion,
    controllerHome: resolve(controllerHome),
    releaseAuthorityRevision: authority.revision,
    releaseFencingTokenSha256: createHash('sha256').update(authority.fencingToken).digest('hex'),
  };
}

function releaseAuthority(config: RecoveryConfig): RuntimeReleaseAuthority | undefined {
  return readRuntimeReleaseAuthority(config.controllerHome);
}

function activeAuthorityRelease(config: RecoveryConfig): ReleaseEvidence | undefined {
  const authority = releaseAuthority(config);
  return releaseEvidence(config.controllerHome, authority?.active, authority);
}

function previousAuthorityRelease(config: RecoveryConfig): ReleaseEvidence | undefined {
  const authority = releaseAuthority(config);
  return releaseEvidence(config.controllerHome, authority?.previous, authority);
}

function knownGoodEvidence(config: RecoveryConfig, entry: ReleaseEvidence | undefined): ReleaseEvidence | undefined {
  if (!entry || !entry.attestedAt || !entry.releaseFencingTokenSha256 || typeof entry.controllerHome !== 'string') return undefined;
  if (resolve(entry.controllerHome) !== resolve(config.controllerHome)) return undefined;
  const authority = releaseAuthority(config);
  const candidates = [
    releaseEvidence(config.controllerHome, authority?.active, authority),
    releaseEvidence(config.controllerHome, authority?.previous, authority),
  ].filter((item): item is ReleaseEvidence => Boolean(item));
  const matched = candidates.find((release) =>
    release.path === entry.path
    && release.revision === entry.revision
    && release.artifactIdentity === entry.artifactIdentity
    && release.manifestSha256 === entry.manifestSha256
    && release.workerProtocolVersion === entry.workerProtocolVersion,
  );
  return matched ? entry : undefined;
}

function knownGood(config: RecoveryConfig): KnownGoodStore {
  return json<KnownGoodStore>(statePath(config)) ?? { schemaVersion: 1, releases: [], updatedAt: new Date(0).toISOString() };
}

function matchingKnownGood(config: RecoveryConfig, release: ReleaseEvidence | undefined): ReleaseEvidence | undefined {
  if (!release) return undefined;
  return knownGoodEvidence(config, knownGood(config).releases.find((entry) =>
    entry.revision === release.revision && entry.manifestSha256 === release.manifestSha256 && entry.path === release.path,
  ));
}


function audit(config: RecoveryConfig, event: string, detail: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), event, detail });
  mkdirSync(dirname(auditPath(config)), { recursive: true, mode: 0o700 });
  writeFileSync(auditPath(config), `${line}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
}

const WATCHDOG_DIAGNOSTIC_LIMIT = 32;

function watchdogProbeComponent(name: string): RecoveryWatchdogDiagnosticEvidence['components'][number] {
  if (name === 'runtime_status') return 'runtime';
  if (name === 'active_gateway') return 'gateway';
  if (name === 'recovery_gateway') return 'recovery_gateway';
  if (name === 'recovery_watchdog') return 'recovery_watchdog';
  if (name === 'recovery_external_http') return 'recovery_tunnel';
  return 'public_mcp';
}

function persistWatchdogDiagnosticEvidence(config: RecoveryConfig, result: VerifyResult): RecoveryWatchdogDiagnosticEvidence | undefined {
  if (result.ok) return undefined;
  const failedProbes = Object.entries(result.probes)
    .filter(([, probe]) => !probe.ok)
    .map(([name, probe]) => ({
      name,
      component: watchdogProbeComponent(name),
      detail: probe.detail.slice(0, 240),
      ...(probe.status === undefined ? {} : { status: probe.status }),
    }));
  if (!result.runtime.ok && !failedProbes.some((probe) => probe.name === 'runtime_status')) {
    failedProbes.unshift({ name: 'runtime_readiness', component: 'runtime', detail: result.runtime.reasonCodes.join(', ') || 'runtime is not ready' });
  }
  const active = result.releases.active;
  const releaseIdentity = [active?.revision, active?.artifactIdentity, active?.manifestSha256].filter(Boolean).join(':') || 'unresolved-release';
  const fingerprint = createHash('sha256').update(JSON.stringify({ releaseIdentity, failedProbes })).digest('hex').slice(0, 24);
  const observedAt = result.at;
  const previous = json<RecoveryWatchdogDiagnosticStore>(watchdogDiagnosticPath(config));
  const entries = Array.isArray(previous?.entries) ? previous.entries : [];
  const existing = entries.find((entry) => entry.fingerprint === fingerprint);
  const evidence: RecoveryWatchdogDiagnosticEvidence = existing
    ? { ...existing, lastObservedAt: observedAt, occurrences: existing.occurrences + 1 }
    : {
      fingerprint,
      releaseIdentity,
      components: [...new Set(failedProbes.map((probe) => probe.component))],
      failedProbes,
      firstObservedAt: observedAt,
      lastObservedAt: observedAt,
      occurrences: 1,
    };
  writeJson(watchdogDiagnosticPath(config), {
    schemaVersion: 1,
    entries: [evidence, ...entries.filter((entry) => entry.fingerprint !== fingerprint)].slice(0, WATCHDOG_DIAGNOSTIC_LIMIT),
  } satisfies RecoveryWatchdogDiagnosticStore);
  return evidence;
}

function processStartTime(pid: number): string | undefined {
  const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 4_096,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
  return result.stdout.trim() || undefined;
}

function recoveryLockOwnerAlive(lock: RecoveryLock): boolean {
  if (!pidAlive(lock.pid)) return false;
  if (!lock.processStartTime) return true;
  const observed = processStartTime(lock.pid);
  return observed === undefined || observed === lock.processStartTime;
}

function recoveryLockOwnerAttributable(owner: RecoveryLock): boolean {
  return Boolean(owner.action && owner.requestId?.trim());
}

function recoveryLockIdentityFailure(owner: RecoveryLock): string {
  return `RECOVERY_OPERATION_LOCK_IDENTITY_UNCERTAIN: live mutation lock pid=${owner.pid} instance=${owner.instanceId} is missing action/request identity`;
}

function assertRecoveryLockOwnerAttributable(config: RecoveryConfig, owner: RecoveryLock): void {
  if (recoveryLockOwnerAttributable(owner)) return;
  audit(config, 'recovery_operation_lock_identity_uncertain', {
    pid: owner.pid,
    instanceId: owner.instanceId,
    action: owner.action ?? null,
    requestId: owner.requestId ?? null,
    acquiredAt: owner.acquiredAt,
  });
  throw new Error(recoveryLockIdentityFailure(owner));
}

function recoveryBusyDetail(owner: RecoveryLock): string {
  return `Recovery mutation already in progress: action=${owner.action ?? 'invalid'} request=${owner.requestId ?? 'invalid'} pid=${owner.pid} instance=${owner.instanceId}`;
}

async function withLock<T>(
  config: RecoveryConfig,
  intent: RecoveryLockIntent,
  action: (lock: RecoveryLock) => Promise<T>,
): Promise<RecoveryLockAttempt<T>> {
  const path = lockPath(config);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const instanceId = randomUUID();
  const requestId = intent.requestId?.trim() || `internal:${intent.action}:${instanceId}`;
  const lock: RecoveryLock = {
    schemaVersion: 1,
    pid: process.pid,
    instanceId,
    processStartTime: processStartTime(process.pid),
    acquiredAt: new Date().toISOString(),
    action: intent.action,
    requestId,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number | undefined;
    let acquired = false;
    try {
      try {
        fd = openSync(path, 'wx', 0o600);
        writeFileSync(fd, JSON.stringify(lock));
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = json<RecoveryLock>(path);
        if (!existing || !Number.isInteger(existing.pid) || typeof existing.instanceId !== 'string') {
          throw new Error('RECOVERY_OPERATION_LOCK_UNCERTAIN');
        }
        if (recoveryLockOwnerAlive(existing)) {
          assertRecoveryLockOwnerAttributable(config, existing);
          return { acquired: false, owner: existing };
        }
        const latest = json<RecoveryLock>(path);
        if (!latest || latest.instanceId !== existing.instanceId) {
          if (attempt === 1) {
            if (latest && recoveryLockOwnerAlive(latest)) {
              assertRecoveryLockOwnerAttributable(config, latest);
              return { acquired: false, owner: latest };
            }
            audit(config, 'recovery_operation_lock_race', {
              existingInstanceId: existing.instanceId,
              existingPid: existing.pid,
              latestInstanceId: latest?.instanceId ?? null,
              latestPid: latest?.pid ?? null,
            });
            throw new Error('RECOVERY_OPERATION_LOCK_RACE');
          }
          continue;
        }
        if (recoveryLockOwnerAlive(latest)) {
          assertRecoveryLockOwnerAttributable(config, latest);
          return { acquired: false, owner: latest };
        }
        try { writeFileSync(`${path}.stale-${Date.now()}-${existing.instanceId}`, readFileSync(path)); } catch { /* evidence best effort */ }
        rmSync(path, { force: true });
        continue;
      }
      return { acquired: true, value: await action(lock) };
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (acquired) {
        const current = json<RecoveryLock>(path);
        if (current?.instanceId === lock.instanceId) rmSync(path, { force: true });
      }
    }
  }
  throw new Error('RECOVERY_OPERATION_LOCK_BUSY');
}

export async function runtimeStatus(config: RecoveryConfig) {
  const observation = observeRuntimeStatus(config.controllerHome);
  const watchdog = loadWatchdogState(config);
  return {
    ...observation,
    recoveryWatchdog: {
      lastDecision: watchdog.lastDecision,
      lastReason: watchdog.lastReason,
      updatedAt: watchdog.updatedAt,
      failures: watchdog.failures,
      rollbackUsed: watchdog.rollbackUsed,
      runtimeRestartAttempts: watchdog.runtimeRestartAttempts ?? 0,
      runtimeRestartFailures: watchdog.runtimeRestartFailures ?? 0,
      primaryConnectorFailures: watchdog.primaryConnectorFailures ?? 0,
      primaryConnectorRestartAttempts: watchdog.primaryConnectorRestartAttempts ?? 0,
      primaryConnectorRestartFailures: watchdog.primaryConnectorRestartFailures ?? 0,
    },
  };
}

async function probe(transport: RecoveryHttpTransport, url: string, timeoutMs = 4_000): Promise<{ ok: boolean; detail: string; status?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('RECOVERY_HTTP_TIMEOUT'), timeoutMs);
  try {
    const response = await transport.request({ url, headers: { accept: 'application/json' }, timeoutMs, signal: controller.signal });
    return { ok: response.ok, detail: `HTTP ${response.status}`, status: response.status };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message.slice(0, 180) : 'request failed' };
  } finally { clearTimeout(timer); }
}

async function probeExternalMcp(transport: RecoveryHttpTransport, url: string): Promise<{ ok: boolean; detail: string; status?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('RECOVERY_HTTP_TIMEOUT'), 4_000);
  try {
    // The MCP transport is POST-based. A GET on the MCP path returns 404 on
    // some gateway implementations, so probe with an initialize request and
    // accept the unauthenticated OAuth Bearer challenge.
    const response = await transport.request({
      url,
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'forge-standalone-recovery', version: '1' } },
      }),
      timeoutMs: 4_000,
      signal: controller.signal,
    });
    const challenge = response.headers['www-authenticate'] ?? '';
    const ok = response.ok || (response.status === 401 && /\bBearer\b/i.test(challenge));
    return { ok, detail: ok && response.status === 401 ? 'HTTP 401 OAuth challenge' : `HTTP ${response.status}`, status: response.status };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message.slice(0, 180) : 'request failed' };
  } finally { clearTimeout(timer); }
}

function publicGatewayReadinessEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.pathname = '/transport-ready';
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function probePublicGatewayReadiness(
  transport: RecoveryHttpTransport,
  endpoint: string,
): Promise<{ ok: boolean; detail: string; status?: number; value?: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('RECOVERY_HTTP_TIMEOUT'), 4_000);
  const surface = 'transport-ready';
  try {
    const response = await transport.request({
      url: publicGatewayReadinessEndpoint(endpoint),
      headers: { accept: 'application/json' },
      timeoutMs: 4_000,
      signal: controller.signal,
    });
    if (response.status === 404 || response.status === 405) {
      // Older Connectors predate the transport-scoped capacity surface. Their
      // whole-control-plane /ready route is intentionally not a transport
      // liveness contract and can depend on the Runtime that Recovery is in the
      // middle of restarting. Falling back to it creates a circular cutover
      // dependency. Verify the actual MCP transport instead: a successful
      // initialize response or the expected OAuth Bearer challenge proves the
      // legacy Connector transport is reachable without weakening 5xx/timeout
      // failure handling.
      const legacy = await probeExternalMcp(transport, endpoint);
      return { ...legacy, detail: `legacy-mcp ${legacy.detail}` };
    }
    let sessionCapacity: unknown;
    try {
      const payload = JSON.parse(response.body) as { sessionCapacity?: unknown };
      sessionCapacity = payload.sessionCapacity;
    } catch { /* malformed readiness payload remains a failed/opaque probe */ }
    const recoveryRecommended = Boolean(
      sessionCapacity
      && typeof sessionCapacity === 'object'
      && (sessionCapacity as { recoveryRecommended?: unknown }).recoveryRecommended === true,
    );
    return {
      ok: response.ok && !recoveryRecommended,
      detail: `${surface} HTTP ${response.status}${recoveryRecommended ? '; session capacity recommends Connector recovery' : ''}`,
      status: response.status,
      ...(sessionCapacity === undefined ? {} : { value: sessionCapacity }),
    };
  } catch (error) {
    return { ok: false, detail: `${surface} ${error instanceof Error ? error.message.slice(0, 180) : 'request failed'}` };
  } finally {
    clearTimeout(timer);
  }
}

function connectorCapacityRecoveryRecommended(verified: VerifyResult): boolean {
  const value = verified.probes.primary_connector_ready?.value;
  return Boolean(
    value
    && typeof value === 'object'
    && (value as { recoveryRecommended?: unknown }).recoveryRecommended === true,
  );
}

function mainToken(config: RecoveryConfig): string | undefined {
  const candidate = config.mainMcpTokenFile ?? join(config.controllerHome, 'mcp', 'mcp.tokens.json');
  const parsed = json<{ bearerToken?: unknown }>(candidate);
  return typeof parsed?.bearerToken === 'string' && parsed.bearerToken.length >= 24 ? parsed.bearerToken : undefined;
}

interface RecoveryMcpCallResult {
  ok: boolean;
  payload?: Record<string, unknown>;
  detail: string;
  sessionId?: string;
}

function parseRecoveryMcpPayload(text: string, contentType: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (contentType.includes('text/event-stream')) {
    const data = trimmed
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .find((line) => line && line !== '[DONE]');
    if (!data) return undefined;
    try { return JSON.parse(data) as Record<string, unknown>; } catch { return undefined; }
  }
  try { return JSON.parse(trimmed) as Record<string, unknown>; } catch { return undefined; }
}

async function mcpCall(
  transport: RecoveryHttpTransport,
  url: string,
  token: string,
  id: number | undefined,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
): Promise<RecoveryMcpCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('RECOVERY_HTTP_TIMEOUT'), 8_000);
  try {
    const response = await transport.request({
      url, method: 'POST', timeoutMs: 8_000, signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) }),
    });
    const payload = parseRecoveryMcpPayload(response.body, response.headers['content-type'] ?? '');
    const returnedSessionId = response.headers['mcp-session-id']?.trim() || sessionId;
    return {
      ok: response.ok && !payload?.error,
      payload,
      detail: `HTTP ${response.status}`,
      ...(returnedSessionId ? { sessionId: returnedSessionId } : {}),
    };
  } catch (error) { return { ok: false, detail: error instanceof Error ? error.message.slice(0, 180) : 'MCP request failed' }; } finally { clearTimeout(timer); }
}

async function closeRecoveryMcpSession(transport: RecoveryHttpTransport, url: string, token: string, sessionId: string): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('RECOVERY_HTTP_TIMEOUT'), 5_000);
  try {
    const response = await transport.request({
      url,
      method: 'DELETE',
      timeoutMs: 5_000,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
    });
    return { ok: response.ok, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message.slice(0, 180) : 'MCP session close failed' };
  } finally {
    clearTimeout(timer);
  }
}

function runtimeEndpoint(config: RecoveryConfig): string | undefined {
  return observeRuntimeStatus(config.controllerHome).snapshot?.endpoint;
}

function runtimeHealthEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  // The canonical Runtime serves the whole-Runtime readiness probe at /ready.
  url.pathname = '/ready';
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function probeMcp(config: RecoveryConfig, transport: RecoveryHttpTransport): Promise<Record<string, { ok: boolean; detail: string; value?: unknown }>> {
  const url = config.publicMcpUrl ?? runtimeEndpoint(config);
  if (!url) return { mcp_initialize: { ok: false, detail: 'canonical Runtime MCP endpoint is unavailable' } };
  const token = mainToken(config);
  if (!token) return { mcp_initialize: { ok: false, detail: 'main MCP probe credential is unavailable' } };
  const initialized = await mcpCall(transport, url, token, 1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'standalone-recovery', version: '1' },
  });
  if (!initialized.ok || !initialized.sessionId) {
    return {
      mcp_initialize: {
        ok: false,
        detail: initialized.ok ? `${initialized.detail}; session id missing` : initialized.detail,
      },
    };
  }
  const sessionId = initialized.sessionId;
  const acknowledged = await mcpCall(transport, url, token, undefined, 'notifications/initialized', undefined, sessionId);
  if (!acknowledged.ok) {
    const closed = await closeRecoveryMcpSession(transport, url, token, sessionId);
    return {
      mcp_initialize: { ok: true, detail: initialized.detail },
      mcp_initialized_notification: { ok: false, detail: acknowledged.detail },
      mcp_session_close: { ok: closed.ok, detail: closed.detail },
    };
  }
  const listed = await mcpCall(transport, url, token, 2, 'tools/list', undefined, sessionId);
  const tools = Array.isArray((listed.payload?.result as { tools?: unknown } | undefined)?.tools)
    ? ((listed.payload!.result as { tools: Array<{ name?: unknown }> }).tools)
    : [];
  const names = tools.map((tool) => typeof tool.name === 'string' ? tool.name : '').filter(Boolean).sort();
  const fingerprint = createHash('sha256').update(names.join('\n')).digest('hex');
  const expected = config.expectedToolFingerprint;
  const expectedMatches = !expected || (expected.length === fingerprint.length && timingSafeEqual(Buffer.from(expected), Buffer.from(fingerprint)));
  const toolListOk = listed.ok && names.length > 0 && expectedMatches;
  const readOnly = normalizeRecoveryReadOnlyTool(config.readOnlyTool);
  const called = toolListOk
    ? await mcpCall(transport, url, token, 3, 'tools/call', { name: readOnly.name, arguments: readOnly.arguments ?? {} }, sessionId)
    : undefined;
  const closed = await closeRecoveryMcpSession(transport, url, token, sessionId);
  return {
    mcp_initialize: { ok: initialized.ok, detail: initialized.detail },
    mcp_initialized_notification: { ok: acknowledged.ok, detail: acknowledged.detail },
    mcp_tools_list: { ok: toolListOk, detail: `${listed.detail}; count=${names.length}; fingerprint=${fingerprint}`, value: { count: names.length, fingerprint } },
    mcp_read_only_call: { ok: Boolean(called?.ok), detail: called?.detail ?? 'tools/list failed' },
    mcp_session_close: { ok: closed.ok, detail: closed.detail },
  };
}

export async function verifyStableRuntime(
  config: RecoveryConfig,
  transport = createRecoveryHttpTransport(config.controllerHome),
  options: VerifyStableRuntimeOptions = {},
): Promise<VerifyResult> {
  const observation = observeRuntimeStatus(config.controllerHome);
  const authority = releaseAuthority(config);
  const active = activeAuthorityRelease(config);
  const previous = previousAuthorityRelease(config);
  const known = matchingKnownGood(config, active);
  const probes: VerifyResult['probes'] = {
    runtime_status: {
      ok: observation.running && !observation.stale,
      detail: observation.running
        ? observation.stale ? 'canonical Runtime status is stale' : 'canonical Runtime owner is live'
        : 'canonical Runtime is not running',
    },
  };
  const endpoint = observation.snapshot?.endpoint;
  probes.active_gateway = endpoint
    ? await probe(transport, runtimeHealthEndpoint(endpoint))
    : { ok: false, detail: 'canonical Runtime endpoint is unavailable' };
  if (config.publicMcpUrl) {
    probes.external_mcp_http = await probeExternalMcp(transport, config.publicMcpUrl);
    const connectorReadinessEndpoint = config.primaryConnectorService?.localMcpUrl?.trim() || config.publicMcpUrl;
    probes.primary_connector_ready = await probePublicGatewayReadiness(transport, connectorReadinessEndpoint);
  }
  const primaryConnectorLocal = await probePrimaryConnectorLocal(config, transport);
  if (primaryConnectorLocal) probes.primary_connector_local = primaryConnectorLocal;
  if (config.gateway) probes.recovery_gateway = await probe(transport, `http://${config.gateway.host}:${config.gateway.port}/health`);
  const watchdogHealth = observeRecoveryWatchdogHealth(config.controllerHome);
  probes.recovery_watchdog = {
    ok: watchdogHealth.ok,
    detail: watchdogHealth.detail,
    value: {
      pulseAgeMs: watchdogHealth.pulseAgeMs,
      tickAgeMs: watchdogHealth.tickAgeMs,
      currentReleaseRevision: watchdogHealth.currentReleaseRevision,
      watchdogReleaseRevision: watchdogHealth.runtimeIdentity?.releaseRevision,
      watchdogPid: watchdogHealth.runtimeIdentity?.pid,
    },
  };
  const recoveryPublicUrl = configuredRecoveryPublicUrl(config);
  if (recoveryPublicUrl) probes.recovery_external_http = await probeExternalMcp(transport, recoveryPublicUrl);
  if (options.probeMcpProtocol !== false) Object.assign(probes, await probeMcp(config, transport));
  const coreChecks = Object.entries(probes)
    .filter(([name]) => !name.startsWith('recovery_'))
    .every(([, entry]) => entry.ok);
  const runtimeHealthy = observation.running && observation.ready && !observation.stale;
  const coherent = Boolean(
    authority
    && active
    && observation.snapshot?.releaseId === active.revision
    && observation.snapshot?.artifactIdentity === active.artifactIdentity
    && authority.active.workerProtocolVersion === active.workerProtocolVersion,
  );
  const ok = Boolean(coreChecks && runtimeHealthy && coherent);
  const result: VerifyResult = {
    ok,
    at: new Date().toISOString(),
    runtime: {
      ok: runtimeHealthy,
      running: observation.running,
      ready: observation.ready,
      stale: observation.stale,
      reasonCodes: [...observation.reasonCodes],
    },
    releases: { active, previous, knownGood: known, coherent },
    probes,
  };
  const diagnosticEvidence = persistWatchdogDiagnosticEvidence(config, result);
  audit(config, 'verify', {
    ok,
    activeRevision: active?.revision,
    previousRevision: previous?.revision,
    coherent,
    ...(diagnosticEvidence ? {
      diagnostic: {
        fingerprint: diagnosticEvidence.fingerprint,
        components: diagnosticEvidence.components,
        failedProbes: diagnosticEvidence.failedProbes,
        occurrences: diagnosticEvidence.occurrences,
      },
    } : {}),
  });
  return result;
}
/** Explicitly records evidence only after the full independent verification passed. */
function persistVerifiedKnownGood(config: RecoveryConfig, verified: VerifyResult): ReleaseEvidence {
  const authority = releaseAuthority(config);
    const active = verified.releases.active;
    if (
      !verified.ok
      || !authority
      || !active
      || authority.active.releaseId !== active.revision
      || authority.active.artifactIdentity !== active.artifactIdentity
      || authority.active.manifestSha256 !== active.manifestSha256
      || authority.active.workerProtocolVersion !== active.workerProtocolVersion
    ) {
      throw new Error('RECOVERY_KNOWN_GOOD_ATTESTATION_REQUIRES_FULL_VERIFY_AND_RELEASE_AUTHORITY');
    }
    const attested: ReleaseEvidence = {
      ...active,
      controllerHome: resolve(config.controllerHome),
      releaseAuthorityRevision: authority.revision,
      releaseFencingTokenSha256: createHash('sha256').update(authority.fencingToken).digest('hex'),
      attestedAt: new Date().toISOString(),
    };
    const store = knownGood(config);
    const releases = [
      attested,
      ...store.releases.filter((entry) => entry.path !== active.path && existsSync(entry.path)),
    ].slice(0, 8);
    writeJson(statePath(config), { schemaVersion: 1, releases, updatedAt: new Date().toISOString() } satisfies KnownGoodStore);
    audit(config, 'known_good_attested', {
      revision: active.revision,
      artifactIdentity: active.artifactIdentity,
      manifestSha256: active.manifestSha256,
      releaseAuthorityRevision: authority.revision,
    });
  return attested;
}

export async function attestKnownGood(config: RecoveryConfig): Promise<ReleaseEvidence> {
  const locked = await withLock(config, { action: 'attest_known_good' }, async () => (
    persistVerifiedKnownGood(config, await verifyStableRuntime(config))
  ));
  if (!locked.acquired) throw new Error(recoveryBusyDetail(locked.owner));
  return locked.value;
}

function quarantine(config: RecoveryConfig, release: ReleaseEvidence | undefined, reason: string): void {
  if (!release) return;
  const current = json<{ schemaVersion: 1; releases: Array<ReleaseEvidence & { reason: string; at: string }> }>(quarantinePath(config)) ?? { schemaVersion: 1, releases: [] };
  const releases = [{ ...release, reason, at: new Date().toISOString() }, ...current.releases.filter((item) => item.path !== release.path)].slice(0, 32);
  writeJson(quarantinePath(config), { schemaVersion: 1, releases });
}

async function rollbackPreviousLocked(config: RecoveryConfig, reason: string): Promise<RollbackResult> {
  const before = await verifyStableRuntime(config);
  const active = before.releases.active;
  if (before.ok && matchingKnownGood(config, active)) {
    return { ok: true, noOp: true, detail: 'active whole-Runtime release is currently healthy and independently attested known-good', verify: before };
  }
  if (before.runtime.running) {
    return {
      ok: false,
      noOp: true,
      detail: 'rollback refused: stop the complete Canonical Runtime before restoring its release and SQLite backup',
      verify: before,
    };
  }
  const target = matchingKnownGood(config, before.releases.previous);
  if (!active || !target) {
    audit(config, 'rollback_refused', {
      reason: 'the atomic previous whole-Runtime release is not independently attested known-good',
      activeRevision: active?.revision,
    });
    return {
      ok: false,
      detail: 'rollback refused: no attested previous whole-Runtime release with a bound SQLite backup is available',
      verify: before,
    };
  }
  const operationId = `recovery-rollback-${Date.now()}-${randomUUID().slice(0, 8)}`;
  try {
    const committed = rollbackRuntimeRelease(config.controllerHome, operationId);
    if (
      committed.active.releaseId !== target.revision
      || committed.active.artifactIdentity !== target.artifactIdentity
      || committed.active.manifestSha256 !== target.manifestSha256
    ) throw new Error('RECOVERY_ROLLBACK_AUTHORITY_MISMATCH');
    quarantine(config, active, 'whole-Runtime rollback completed');
    audit(config, 'rollback_succeeded', {
      operationId,
      reason: reason.slice(0, 500),
      activeRevision: active.revision,
      restoredRevision: target.revision,
      restoredManifestSha256: target.manifestSha256,
    });
    return {
      ok: true,
      operationId,
      detail: 'whole-Runtime release and SQLite backup restored; Canonical Runtime remains stopped until its sole launcher starts it',
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'whole-Runtime rollback failed';
    audit(config, 'rollback_failed', { operationId, activeRevision: active.revision, targetRevision: target.revision, detail });
    return { ok: false, operationId, detail };
  }
}

export async function rollbackPrevious(config: RecoveryConfig, reason = 'standalone recovery'): Promise<RollbackResult> {
  const locked = await withLock(config, { action: 'rollback_previous' }, () => rollbackPreviousLocked(config, reason));
  if (!locked.acquired) return { ok: false, noOp: true, detail: recoveryBusyDetail(locked.owner), verify: await verifyStableRuntime(config) };
  return locked.value;
}

export async function reconnectMain(config: RecoveryConfig): Promise<{ ok: boolean; detail: string; verify: VerifyResult }> {
  // A recovery connector must survive a main failure; this action is therefore
  // intentionally a bounded health/reconnect observation, never a rollout.
  const verified = await verifyStableRuntime(config);
  const publicProbe = verified.probes.external_mcp_http;
  const ok = verified.probes.active_gateway?.ok === true
    && verified.probes.primary_connector_ready?.ok !== false
    && (publicProbe?.ok === true || publicProbe?.status === 401);
  audit(config, 'reconnect_main', { ok, externalStatus: publicProbe?.status });
  return { ok, detail: ok ? 'canonical Runtime Gateway and primary endpoint are reachable; client session may refresh' : 'primary endpoint remains unavailable; recovery channel remains independent', verify: verified };
}

async function verifyLocalRuntime(
  config: RecoveryConfig,
  options: VerifyStableRuntimeOptions = {},
): Promise<VerifyResult> {
  // Do not let an external tunnel outage masquerade as a local MCP failure.
  // Local and public verification intentionally probe the same stable facade
  // tool so Recovery cannot depend on retired atomic tools that are absent from
  // the bounded default MCP surface.
  return verifyStableRuntime({
    ...config,
    publicMcpUrl: undefined,
    recoveryPublicUrl: undefined,
    readOnlyTool: { name: STABLE_RECOVERY_READ_ONLY_TOOL.name, arguments: { ...STABLE_RECOVERY_READ_ONLY_TOOL.arguments } },
  }, createRecoveryHttpTransport(config.controllerHome), options);
}

function isExternalTunnelFailure(config: RecoveryConfig, verified: VerifyResult, localVerify: VerifyResult): boolean {
  const external = verified.probes.recovery_external_http ?? verified.probes.external_mcp_http;
  const localRecoveryGatewayHealthy = localVerify.probes.recovery_gateway?.ok ?? true;
  return Boolean(configuredRecoveryTunnel(config) && configuredRecoveryPublicUrl(config) && localVerify.ok && localRecoveryGatewayHealthy && external?.ok !== true);
}

export const WATCHDOG_RUNTIME_STARTUP_GRACE_MS = 60_000;
export const WATCHDOG_RUNTIME_RESTART_BUDGET_STABLE_MS = 5 * 60_000;

export function watchdogRuntimeStartupGraceMs(
  config: Pick<RecoveryConfig, 'primaryRuntimeService'>,
): number {
  const configuredVerifyTimeout = config.primaryRuntimeService?.postRestartVerifyTimeoutMs;
  return Math.max(
    WATCHDOG_RUNTIME_STARTUP_GRACE_MS,
    Number.isFinite(configuredVerifyTimeout) ? Math.max(0, configuredVerifyTimeout ?? 0) : 0,
  );
}

export function runtimeWithinWatchdogStartupGrace(
  input: { running: boolean; stale: boolean; snapshot?: { startedAt?: string } },
  nowMs = Date.now(),
  graceMs = WATCHDOG_RUNTIME_STARTUP_GRACE_MS,
): boolean {
  const startedAtMs = input.snapshot?.startedAt ? Date.parse(input.snapshot.startedAt) : Number.NaN;
  return Boolean(
    input.running
    && !input.stale
    && Number.isFinite(startedAtMs)
    && nowMs >= startedAtMs
    && nowMs - startedAtMs < Math.max(0, graceMs),
  );
}

export function runtimeRestartBudgetIdentity(release: Pick<ReleaseEvidence, 'revision' | 'artifactIdentity' | 'manifestSha256'> | undefined): string | undefined {
  if (!release?.revision || !release.artifactIdentity || !release.manifestSha256) return undefined;
  return `${release.revision}:${release.artifactIdentity}:${release.manifestSha256}`;
}

/**
 * Bind primary Runtime restart accounting to the exact immutable Runtime release.
 * A missing identity is a legacy-state migration: retain its counters and bind
 * them to the currently observed release so a watchdog upgrade cannot mint a
 * fresh restart budget for an already failing Runtime.
 */
export function scopeWatchdogStateToRuntimeRelease(
  state: WatchdogState,
  release: Pick<ReleaseEvidence, 'revision' | 'artifactIdentity' | 'manifestSha256'> | undefined,
): WatchdogState {
  const identity = runtimeRestartBudgetIdentity(release);
  if (!identity || state.runtimeRestartBudgetIdentity === identity) return state;
  if (!state.runtimeRestartBudgetIdentity) return { ...state, runtimeRestartBudgetIdentity: identity };
  return {
    ...state,
    failures: 0,
    firstFailureAt: undefined,
    rollbackUsed: false,
    runtimeRestartAttempts: 0,
    runtimeRestartFailures: 0,
    runtimeRestartLastAttemptAt: undefined,
    runtimeHealthySince: undefined,
    runtimeRestartBudgetExhaustedAt: undefined,
    runtimeRecoveryFailures: 0,
    runtimeRecoveryLastAttemptAt: undefined,
    runtimeRestartBudgetIdentity: identity,
  };
}

export function recordWatchdogRuntimeHealthy(
  state: WatchdogState,
  nowMs: number,
  stableDurationMs = WATCHDOG_RUNTIME_RESTART_BUDGET_STABLE_MS,
): WatchdogState {
  const runtimeHealthySince = state.runtimeHealthySince ?? nowMs;
  if (nowMs - runtimeHealthySince < Math.max(0, stableDurationMs)) {
    return { ...state, runtimeHealthySince };
  }
  return {
    ...state,
    runtimeHealthySince,
    runtimeRestartAttempts: 0,
    runtimeRestartFailures: 0,
    runtimeRestartLastAttemptAt: undefined,
    runtimeRestartBudgetExhaustedAt: undefined,
  };
}

export function watchdogRuntimeRestartBudgetStableMs(
  config: Pick<RecoveryConfig, 'primaryRuntimeService'>,
): number {
  const configured = config.primaryRuntimeService?.restartBudgetStableDurationMs;
  return Number.isFinite(configured)
    ? Math.max(0, configured ?? 0)
    : WATCHDOG_RUNTIME_RESTART_BUDGET_STABLE_MS;
}

export function decideWatchdog(input: {
  failures: number;
  firstFailureAt?: number;
  evidenceClasses: string[];
  activeKnownGood: boolean;
  previousKnownGood: boolean;
  rollbackUsed: boolean;
  recoveryGatewayFailed?: boolean;
  recoveryGatewayRestartUsed?: boolean;
  primaryConnectorConfigured?: boolean;
  primaryConnectorFailed?: boolean;
  primaryConnectorFailures?: number;
  primaryConnectorFirstFailureAt?: number;
  primaryConnectorRestartAttempts?: number;
  primaryConnectorMaximumRestartAttempts?: number;
  primaryConnectorRestartLastAttemptAt?: number;
  primaryConnectorRestartCooldownMs?: number;
  primaryConnectorMinimumFailures?: number;
  primaryConnectorMinimumFailureDurationMs?: number;
  primaryRuntimeFailed?: boolean;
  runtimeRestartAttempts?: number;
  runtimeMaximumRestartAttempts?: number;
  runtimeRestartLastAttemptAt?: number;
  runtimeRestartCooldownMs?: number;
  runtimeMinimumFailures?: number;
  runtimeMinimumFailureDurationMs?: number;
  runtimeRecoveryLastAttemptAt?: number;
  runtimeRecoveryCooldownMs?: number;
  publicTunnelConfigured?: boolean;
  publicTunnelFailed?: boolean;
  publicTunnelFailures?: number;
  publicTunnelFirstFailureAt?: number;
  publicTunnelRepairFailures?: number;
  publicTunnelMinimumFailures?: number;
  publicTunnelMinimumFailureDurationMs?: number;
  nowMs?: number;
}): WatchdogDecision {
  const now = input.nowMs ?? Date.now();
  if (input.publicTunnelConfigured && input.publicTunnelFailed) {
    const failures = input.publicTunnelFailures ?? 0;
    const minimumFailures = input.publicTunnelMinimumFailures ?? 2;
    const minimumDuration = input.publicTunnelMinimumFailureDurationMs ?? 5_000;
    const sustained = input.publicTunnelFirstFailureAt !== undefined && now - input.publicTunnelFirstFailureAt >= minimumDuration;
    if (failures >= minimumFailures && sustained) return { action: 'repair_public_tunnel', reason: 'local runtime and Recovery Gateway are healthy while the dedicated Recovery public endpoint is unavailable' };
    return { action: 'degraded', reason: 'Recovery tunnel failure has not yet met the bounded repair threshold' };
  }
  if (input.primaryConnectorConfigured && input.primaryConnectorFailed) {
    const failures = input.primaryConnectorFailures ?? 0;
    const minimumFailures = Math.max(1, input.primaryConnectorMinimumFailures ?? 2);
    const minimumDurationMs = Math.max(0, input.primaryConnectorMinimumFailureDurationMs ?? 5_000);
    const sustained = input.primaryConnectorFirstFailureAt !== undefined && now - input.primaryConnectorFirstFailureAt >= minimumDurationMs;
    const attempts = input.primaryConnectorRestartAttempts ?? 0;
    const maximumAttempts = Math.max(1, input.primaryConnectorMaximumRestartAttempts ?? 3);
    const cooldownMs = Math.max(0, input.primaryConnectorRestartCooldownMs ?? 30_000);
    const cooldownElapsed = input.primaryConnectorRestartLastAttemptAt === undefined || now - input.primaryConnectorRestartLastAttemptAt >= cooldownMs;
    if (failures >= minimumFailures && sustained && attempts < maximumAttempts && cooldownElapsed) {
      return { action: 'restart_primary_connector', reason: `local Runtime is healthy but the primary Connector endpoint is unavailable; restart attempt ${attempts + 1}/${maximumAttempts}` };
    }
    return { action: 'degraded', reason: attempts >= maximumAttempts
      ? `primary Connector restart budget exhausted (${attempts}/${maximumAttempts}); keeping the local Runtime available for independent Recovery`
      : 'primary Connector failure has not yet met its bounded restart threshold or cooldown' };
  }
  if (input.failures === 0) return { action: 'healthy', reason: 'all recovery probes healthy' };
  const recoveryRestartSustained = input.firstFailureAt !== undefined && now - input.firstFailureAt >= 5_000;
  if (input.failures >= 2 && recoveryRestartSustained && input.recoveryGatewayFailed && !input.recoveryGatewayRestartUsed) {
    return { action: 'restart_recovery_gateway', reason: 'the independent Recovery Gateway health endpoint failed after a sustained bounded failure window' };
  }

  const restartAttempts = input.runtimeRestartAttempts ?? 0;
  const maximumRestartAttempts = Math.max(1, input.runtimeMaximumRestartAttempts ?? 3);
  const restartMinimumFailures = Math.max(1, input.runtimeMinimumFailures ?? 2);
  const restartMinimumDurationMs = Math.max(0, input.runtimeMinimumFailureDurationMs ?? 5_000);
  const restartSustained = input.firstFailureAt !== undefined && now - input.firstFailureAt >= restartMinimumDurationMs;
  const restartCooldownMs = Math.max(0, input.runtimeRestartCooldownMs ?? 10_000);
  const restartCooldownElapsed = input.runtimeRestartLastAttemptAt === undefined || now - input.runtimeRestartLastAttemptAt >= restartCooldownMs;
  if (
    input.primaryRuntimeFailed
    && input.failures >= restartMinimumFailures
    && restartSustained
    && restartAttempts < maximumRestartAttempts
    && restartCooldownElapsed
  ) {
    return { action: 'restart_primary_runtime', reason: `canonical Runtime failed sustained verification; attempt bounded whole-Runtime restart ${restartAttempts + 1}/${maximumRestartAttempts}` };
  }

  const rollbackSustained = input.firstFailureAt !== undefined && now - input.firstFailureAt >= 30_000;
  const recoveryCooldownMs = Math.max(0, input.runtimeRecoveryCooldownMs ?? 60_000);
  const recoveryCooldownElapsed = input.runtimeRecoveryLastAttemptAt === undefined || now - input.runtimeRecoveryLastAttemptAt >= recoveryCooldownMs;
  const independentEvidence = new Set(input.evidenceClasses).size >= 2;
  if (
    input.primaryRuntimeFailed
    && restartAttempts >= maximumRestartAttempts
    && input.failures >= 6
    && rollbackSustained
    && independentEvidence
    && !input.activeKnownGood
    && input.previousKnownGood
    && !input.rollbackUsed
    && recoveryCooldownElapsed
  ) {
    return { action: 'rollback', reason: 'bounded primary Runtime restarts were exhausted and sustained multi-signal evidence permits previous whole-release recovery' };
  }
  if (
    input.primaryRuntimeFailed
    && restartAttempts >= maximumRestartAttempts
    && input.failures >= restartMinimumFailures
    && restartSustained
    && recoveryCooldownElapsed
  ) {
    return { action: 'recovery_exhausted', reason: `automatic restart budget exhausted for the active Runtime release (${restartAttempts}/${maximumRestartAttempts}); holding for rollback eligibility or operator handoff` };
  }
  return { action: 'degraded', reason: 'restart or rollback threshold, duration, cooldown, or independent-evidence quorum not met' };
}

export async function diagnose(config: RecoveryConfig): Promise<Record<string, unknown>> {
  const verified = await verifyStableRuntime(config);
  return { verified, knownGood: knownGood(config), quarantine: json(quarantinePath(config)) ?? { releases: [] } };
}

export async function listReleases(config: RecoveryConfig): Promise<Record<string, unknown>> {
  const observation = observeRuntimeStatus(config.controllerHome);
  return {
    runtimeRunning: observation.running,
    runtimeReady: observation.ready,
    active: activeAuthorityRelease(config),
    previous: previousAuthorityRelease(config),
    knownGood: knownGood(config).releases,
  };
}

interface CommandResult { ok: boolean; status: number | null; stdout: string; stderr: string; }
type CommandRunner = (commandName: string, args: string[], timeoutMs?: number) => Promise<CommandResult>;
interface LaunchdService { uid: number; domain: string; target: string; label: string; plistPath: string; }

export interface PublicTunnelRepairDependencies {
  platform?: NodeJS.Platform;
  currentUid?: () => Promise<number | undefined>;
  runCommand?: CommandRunner;
  verify?: (config: RecoveryConfig) => Promise<VerifyResult>;
  verifyLocal?: (config: RecoveryConfig) => Promise<VerifyResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function command(commandName: string, args: string[], timeoutMs = 10_000, options: { cwd?: string; maxOutputBytes?: number } = {}): Promise<CommandResult> {
  return new Promise((resolveCommand) => {
    const child = spawn(commandName, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: options.cwd });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolveCommand(result);
    };
    const signalChild = (signalName: NodeJS.Signals) => {
      if (!child.pid || child.exitCode != null) return;
      try { process.kill(child.pid, signalName); } catch { /* Process already exited. */ }
    };
    const stop = () => {
      if (child.exitCode != null) return;
      signalChild('SIGTERM');
      killTimer = setTimeout(() => signalChild('SIGKILL'), 1_000);
    };
    const timeout = setTimeout(stop, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxOutputBytes) stdout.push(Buffer.from(chunk)); else stop();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxOutputBytes) stderr.push(Buffer.from(chunk)); else stop();
    });
    child.once('error', () => finish({ ok: false, status: null, stdout: '', stderr: 'command spawn failed' }));
    child.once('close', (status) => finish({ ok: status === 0, status, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}

async function currentUid(): Promise<number | undefined> {
  if (typeof process.getuid === 'function') return process.getuid();
  const result = await command('id', ['-u'], 2_000);
  const value = Number(result.stdout.trim());
  return result.ok && Number.isInteger(value) ? value : undefined;
}

async function ensureLaunchdServiceStarted(service: LaunchdService, runCommand: CommandRunner = command): Promise<{ ok: boolean; detail: string }> {
  const printed = await runCommand('launchctl', ['print', service.target], 5_000);
  if (!printed.ok) {
    if (!existsSync(service.plistPath)) return { ok: false, detail: `launchd plist is missing: ${service.plistPath}` };
    const bootstrapped = await runCommand('launchctl', ['bootstrap', service.domain, service.plistPath], 15_000);
    if (!bootstrapped.ok && !/already|in progress|Input\/output error/i.test(`${bootstrapped.stderr}\n${bootstrapped.stdout}`)) {
      return { ok: false, detail: `launchd bootstrap failed: ${bootstrapped.stderr || bootstrapped.stdout || bootstrapped.status}` };
    }
    const loaded = await runCommand('launchctl', ['print', service.target], 5_000);
    if (!loaded.ok) {
      return { ok: false, detail: `launchd bootstrap did not load service: ${loaded.stderr || loaded.stdout || loaded.status}` };
    }
    await runCommand('launchctl', ['enable', service.target], 5_000);
  }
  const started = await runCommand('launchctl', ['kickstart', '-k', service.target], 15_000);
  const alreadyInProgress = started.status === 37 || /already|in progress/i.test(`${started.stderr}\n${started.stdout}`);
  if (!started.ok && !alreadyInProgress) {
    return { ok: false, detail: `launchd kickstart failed: ${started.stderr || started.stdout || started.status}` };
  }
  return { ok: true, detail: service.target };
}

export interface PrimaryRuntimeRecoveryDependencies {
  platform?: NodeJS.Platform;
  currentUid?: () => Promise<number | undefined>;
  runCommand?: CommandRunner;
  verifyLocal?: (config: RecoveryConfig) => Promise<VerifyResult>;
  runtimeRunning?: (config: RecoveryConfig) => boolean;
  ensureRuntimeLaunchContract?: (controllerHome: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RuntimeReleaseActivationGuard {
  /** External caller identity for audit/lock attribution. */
  requestId?: string;
  /** Authority snapshot observed when the caller decided to activate; null means the caller observed no authority. */
  expectedAuthorityRevision?: number | null;
  /** Active release observed when the caller decided to activate; null means the caller observed no active release. */
  expectedActiveReleaseId?: string | null;
}

function configuredPrimaryRuntimeService(config: RecoveryConfig): PrimaryRuntimeServiceConfig {
  return config.primaryRuntimeService ?? { platform: 'launchd' };
}

function primaryRuntimeLaunchdService(config: RecoveryConfig, uid: number): LaunchdService | undefined {
  const configured = configuredPrimaryRuntimeService(config);
  if (configured.platform !== 'launchd') return undefined;
  const paths = forgeRuntimeServicePaths(config.controllerHome);
  if (!existsSync(paths.installedPlistPath)) return undefined;
  const domain = `gui/${uid}`;
  return {
    uid,
    domain,
    target: `${domain}/${paths.label}`,
    label: paths.label,
    plistPath: paths.installedPlistPath,
  };
}

export interface PrimaryConnectorRecoveryDependencies {
  /** Durable caller identity propagated into the Recovery mutation lock and audit trail. */
  requestId?: string;
  platform?: NodeJS.Platform;
  currentUid?: () => Promise<number | undefined>;
  runCommand?: CommandRunner;
  verifyLocal?: (config: RecoveryConfig) => Promise<VerifyResult>;
  reconnect?: (config: RecoveryConfig) => Promise<{ ok: boolean; detail: string; verify: VerifyResult }>;
  probeConnectorLocal?: (config: RecoveryConfig) => Promise<{ ok: boolean; detail: string; status?: number } | undefined>;
  probeConnectorOwnership?: (config: RecoveryConfig) => Promise<{ ok: boolean; detail: string }>;
  repairConnectorBinding?: (config: RecoveryConfig) => Promise<{ ok: boolean; attempted: boolean; noOp?: boolean; detail: string }>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function primaryConnectorLaunchdService(config: RecoveryConfig, uid: number): LaunchdService | undefined {
  const configured = config.primaryConnectorService;
  if (!configured || configured.platform !== 'launchd' || !configured.label.trim()) return undefined;
  const label = configured.label.trim();
  const plistPath = resolve(configured.plistPath ?? join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`));
  if (!existsSync(plistPath)) return undefined;
  const domain = `gui/${uid}`;
  return { uid, domain, target: `${domain}/${label}`, label, plistPath };
}

async function probePrimaryConnectorLocal(
  config: RecoveryConfig,
  transport = createRecoveryHttpTransport(config.controllerHome),
): Promise<{ ok: boolean; detail: string; status?: number } | undefined> {
  const localMcpUrl = config.primaryConnectorService?.localMcpUrl?.trim();
  if (!localMcpUrl) return undefined;
  return probeExternalMcp(transport, localMcpUrl);
}

function activePackageConnectorReleaseBinding(config: RecoveryConfig): PackageConnectorReleaseBinding | undefined {
  const configured = config.primaryConnectorService;
  if (!configured || configured.platform !== 'launchd' || !configured.localMcpUrl?.trim()) return undefined;
  const authority = readRuntimeReleaseAuthority(config.controllerHome);
  if (!authority) return undefined;
  const releaseRoot = dirname(resolve(authority.active.manifestPath));
  const packageRoot = join(releaseRoot, 'package');
  const paths = packageConnectorServicePaths(config.controllerHome);
  const configuredPlist = resolve(configured.plistPath ?? paths.installedPlistPath);
  if (configured.label !== paths.label || configuredPlist !== resolve(paths.installedPlistPath)) return undefined;
  if (!existsSync(join(packageRoot, 'src', 'cli', 'index.ts')) || !existsSync(join(packageRoot, 'src', 'runtime', 'shared', 'node-ts-loader.mjs'))) return undefined;
  return { releaseId: authority.active.releaseId, releaseRoot, packageRoot };
}

async function repairPrimaryConnectorBinding(config: RecoveryConfig): Promise<{ ok: boolean; attempted: boolean; noOp?: boolean; detail: string }> {
  const release = activePackageConnectorReleaseBinding(config);
  const endpoint = config.primaryConnectorService?.localMcpUrl?.trim();
  if (!release || !endpoint) return { ok: true, attempted: false, noOp: true, detail: 'primary Connector does not use the canonical package-release binding contract' };
  try {
    const result = await ensurePackageConnectorService({ release, controllerHome: config.controllerHome, endpoint, platform: 'darwin' });
    const attempted = result.reused !== true;
    return {
      ok: true,
      attempted,
      ...(attempted ? {} : { noOp: true }),
      detail: attempted
        ? `primary Connector binding repaired to active immutable Runtime release ${release.releaseId}`
        : `primary Connector binding already matches active immutable Runtime release ${release.releaseId}`,
    };
  } catch (error) {
    return { ok: false, attempted: true, detail: error instanceof Error ? error.message : 'primary Connector binding repair failed' };
  }
}

async function probePrimaryConnectorOwnership(
  config: RecoveryConfig,
  service: LaunchdService,
  runCommand: CommandRunner = command,
): Promise<{ ok: boolean; detail: string }> {
  const localMcpUrl = config.primaryConnectorService?.localMcpUrl?.trim();
  if (!localMcpUrl) return { ok: false, detail: 'primary Connector local MCP endpoint is not configured' };
  let port: number;
  try {
    const parsed = new URL(localMcpUrl);
    const rawPort = parsed.port || (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '');
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('invalid port');
  } catch {
    return { ok: false, detail: `primary Connector local MCP endpoint has no verifiable TCP port: ${localMcpUrl}` };
  }
  const printed = await runCommand('launchctl', ['print', service.target], 5_000);
  const pidMatch = printed.ok ? printed.stdout.match(/\bpid\s*=\s*(\d+)/) : null;
  const pid = pidMatch ? Number(pidMatch[1]) : undefined;
  if (!pid || !Number.isInteger(pid)) {
    return { ok: false, detail: `configured primary Connector launchd service has no live pid: ${service.target}` };
  }
  const listening = await runCommand('lsof', ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], 5_000);
  const listenerPids = listening.stdout.split(/\s+/).map((value) => Number(value)).filter(Number.isInteger);
  const ok = listening.ok && listenerPids.includes(pid);
  return {
    ok,
    detail: ok
      ? `configured primary Connector pid ${pid} owns TCP ${port}`
      : `configured primary Connector pid ${pid} does not own TCP ${port}`,
  };
}

export async function restartPrimaryConnector(
  config: RecoveryConfig,
  dependencies: PrimaryConnectorRecoveryDependencies = {},
): Promise<PrimaryConnectorRestartResult> {
  const verifyLocal = dependencies.verifyLocal ?? verifyLocalRuntime;
  const initialLocal = await verifyLocal(config);
  // `verifyLocalRuntime` also reports the Connector's own loopback probe.
  // That probe is expected to be false when this recovery action is needed,
  // so it must not prevent a healthy canonical Runtime from repairing the
  // Connector service.
  const canonicalRuntimeHealthy = initialLocal.runtime.ok
    && initialLocal.runtime.running
    && initialLocal.runtime.ready
    && !initialLocal.runtime.stale
    && initialLocal.probes.active_gateway?.ok === true;
  if (!canonicalRuntimeHealthy) {
    return {
      ok: false,
      attempted: false,
      noOp: true,
      detail: 'Canonical Runtime must be locally healthy before the primary Connector is restarted',
      verify: initialLocal,
    };
  }
  if ((dependencies.platform ?? process.platform) !== 'darwin') {
    return { ok: false, attempted: false, noOp: true, detail: 'primary Connector restart currently requires the configured macOS launchd service', verify: initialLocal };
  }
  const uid = await (dependencies.currentUid ?? currentUid)();
  const service = uid === undefined ? undefined : primaryConnectorLaunchdService(config, uid);
  if (!service) {
    return { ok: false, attempted: false, noOp: true, detail: 'primary Connector launchd service is not configured or installed', verify: initialLocal };
  }
  const reconnect = dependencies.reconnect ?? reconnectMain;
  const probeConnectorLocal = dependencies.probeConnectorLocal ?? probePrimaryConnectorLocal;
  const runCommand = dependencies.runCommand ?? command;
  const probeConnectorOwnership = dependencies.probeConnectorOwnership
    ?? ((candidateConfig: RecoveryConfig) => probePrimaryConnectorOwnership(candidateConfig, service, runCommand));
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.sleep ?? sleep;
  const timeoutMs = config.primaryConnectorService?.postRestartVerifyTimeoutMs ?? 30_000;
  const locked = await withLock(config, { action: 'restart_primary_connector', requestId: dependencies.requestId }, async () => {
    const tunnelConfigured = Boolean(configuredPrimaryPublicTunnel(config));
    const repairConnectorBinding = dependencies.repairConnectorBinding ?? repairPrimaryConnectorBinding;
    const bindingRepair = await repairConnectorBinding(config);
    if (bindingRepair.attempted) {
      audit(config, bindingRepair.ok ? 'primary_connector_binding_repaired' : 'primary_connector_binding_repair_failed', { detail: bindingRepair.detail });
    }
    if (!bindingRepair.ok) {
      return { ok: false, attempted: true, detail: `primary Connector immutable release binding repair failed: ${bindingRepair.detail}`, serviceTarget: service.target, verify: initialLocal } satisfies PrimaryConnectorRestartResult;
    }
    let localConnector = await probeConnectorLocal(config);
    let connectorOwnership = localConnector?.ok ? await probeConnectorOwnership(config) : undefined;
    let observed = localConnector?.ok && connectorOwnership?.ok ? await reconnect(config) : undefined;
    if (observed?.ok) {
      return {
        ok: true,
        attempted: bindingRepair.attempted,
        ...(bindingRepair.attempted ? {} : { noOp: true }),
        detail: bindingRepair.attempted
          ? 'primary Connector immutable release binding was repaired and the public MCP endpoint recovered'
          : 'primary Connector and public MCP endpoint recovered before restart',
        serviceTarget: service.target,
        verify: observed.verify,
      } satisfies PrimaryConnectorRestartResult;
    }

    // A healthy local OAuth endpoint proves the Connector is not the broken hop.
    // If a distinct primary tunnel is configured, skip the pointless Gateway
    // restart and repair the public hop directly.
    const restartConnector = !localConnector?.ok || !connectorOwnership?.ok || !tunnelConfigured;
    if (restartConnector) {
      const restarted = await ensureLaunchdServiceStarted(service, runCommand);
      if (!restarted.ok) {
        audit(config, 'primary_connector_restart_failed', { serviceTarget: service.target, detail: restarted.detail });
        return { ok: false, attempted: true, detail: restarted.detail, serviceTarget: service.target, verify: initialLocal } satisfies PrimaryConnectorRestartResult;
      }

      const localDeadline = now() + timeoutMs;
      localConnector = await probeConnectorLocal(config);
      while (localConnector && !localConnector.ok && now() < localDeadline) {
        await wait(1_000);
        localConnector = await probeConnectorLocal(config);
      }
      connectorOwnership = localConnector?.ok ? await probeConnectorOwnership(config) : undefined;
      if (localConnector && (!localConnector.ok || !connectorOwnership?.ok)) {
        const detail = localConnector.ok
          ? (connectorOwnership?.detail ?? 'configured primary Connector listener ownership could not be verified')
          : localConnector.detail;
        audit(config, 'primary_connector_restart_local_unverified', { serviceTarget: service.target, detail });
        return {
          ok: false,
          attempted: true,
          detail: localConnector.ok
            ? 'primary Connector restarted but the configured launchd service does not own its local MCP listener'
            : 'primary Connector restarted but its local MCP endpoint did not recover before timeout',
          serviceTarget: service.target,
          verify: initialLocal,
        } satisfies PrimaryConnectorRestartResult;
      }
    }

    observed ??= await reconnect(config);
    if (!observed.ok && localConnector?.ok && connectorOwnership?.ok && configuredPrimaryPublicTunnel(config)) {
      const tunnel = primaryPublicTunnelService(config, service.uid);
      if (tunnel) {
        const tunnelRestarted = await ensureLaunchdServiceStarted(tunnel, dependencies.runCommand ?? command);
        if (!tunnelRestarted.ok) {
          audit(config, 'primary_public_tunnel_restart_failed', { serviceTarget: tunnel.target, detail: tunnelRestarted.detail });
          return {
            ok: false,
            attempted: true,
            detail: `primary Connector is locally healthy but public tunnel restart failed: ${tunnelRestarted.detail}`,
            serviceTarget: service.target,
            verify: observed.verify,
          } satisfies PrimaryConnectorRestartResult;
        }
        const tunnelDeadline = now() + (configuredPrimaryPublicTunnel(config)?.postRestartVerifyTimeoutMs ?? 20_000);
        while (!observed.ok && now() < tunnelDeadline) {
          await wait(1_000);
          observed = await reconnect(config);
        }
        audit(config, observed.ok ? 'primary_public_tunnel_restart_succeeded' : 'primary_public_tunnel_restart_unverified', {
          serviceTarget: tunnel.target,
          detail: observed.detail,
        });
      }
    } else {
      const deadline = now() + timeoutMs;
      while (!observed.ok && now() < deadline) {
        await wait(1_000);
        observed = await reconnect(config);
      }
    }

    audit(config, observed.ok ? 'primary_connector_restart_succeeded' : 'primary_connector_restart_unverified', {
      serviceTarget: service.target,
      detail: observed.detail,
    });
    return {
      ok: observed.ok,
      attempted: true,
      detail: observed.ok
        ? 'primary Connector recovery completed and the public MCP endpoint is reachable'
        : 'primary Connector recovery completed but the public MCP endpoint did not recover before timeout',
      serviceTarget: service.target,
      verify: observed.verify,
    } satisfies PrimaryConnectorRestartResult;
  });
  if (!locked.acquired) {
    return { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner), serviceTarget: service.target, verify: initialLocal };
  }
  return locked.value;
}

async function waitForPrimaryRuntimeState(input: {
  config: RecoveryConfig;
  expectedRunning: boolean;
  timeoutMs: number;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  runtimeRunning: (config: RecoveryConfig) => boolean;
}): Promise<boolean> {
  const deadline = input.now() + input.timeoutMs;
  while (input.now() < deadline) {
    if (input.runtimeRunning(input.config) === input.expectedRunning) return true;
    await input.wait(500);
  }
  return input.runtimeRunning(input.config) === input.expectedRunning;
}

async function waitForLaunchdServiceUnloaded(input: {
  service: LaunchdService;
  timeoutMs: number;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  runCommand: CommandRunner;
}): Promise<boolean> {
  const deadline = input.now() + input.timeoutMs;
  while (input.now() < deadline) {
    const printed = await input.runCommand('launchctl', ['print', input.service.target], 5_000);
    if (!printed.ok) return true;
    await input.wait(250);
  }
  const printed = await input.runCommand('launchctl', ['print', input.service.target], 5_000);
  return !printed.ok;
}

interface PrimaryRuntimePortObservation {
  port: number;
  pids: number[];
  uncertain?: string;
}

interface PrimaryRuntimePortCleanupResult {
  released: boolean;
  cleaned: boolean;
  detail: string;
  pid?: number;
  signal?: 'SIGTERM' | 'SIGKILL';
}

async function observePrimaryRuntimePort(config: RecoveryConfig, runCommand: CommandRunner): Promise<PrimaryRuntimePortObservation> {
  const paths = forgeRuntimeServicePaths(config.controllerHome);
  let port: number;
  try {
    port = readForgeRuntimeServiceConfig(paths.configPath).port;
  } catch {
    return { port: -1, pids: [], uncertain: 'primary Runtime service port could not be read' };
  }
  const result = await runCommand('lsof', ['-nP', '-Fp', `-iTCP:${port}`, '-sTCP:LISTEN'], 3_000);
  if (result.status === 1 && result.stderr.trim().length === 0) return { port, pids: [] };
  if (!result.ok) {
    return { port, pids: [], uncertain: `primary Runtime listener observation failed: ${result.stderr || result.stdout || result.status}` };
  }
  const pids = [...new Set(result.stdout.split(/\r?\n/)
    .map((line) => /^p(\d+)$/.exec(line.trim())?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0))];
  if (result.stdout.trim().length > 0 && pids.length === 0) {
    return { port, pids: [], uncertain: 'primary Runtime listener identity was not machine-readable' };
  }
  return { port, pids };
}

async function waitForPrimaryRuntimePortReleased(input: {
  config: RecoveryConfig;
  timeoutMs: number;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  runCommand: CommandRunner;
}): Promise<boolean> {
  const deadline = input.now() + input.timeoutMs;
  while (input.now() < deadline) {
    const observation = await observePrimaryRuntimePort(input.config, input.runCommand);
    if (!observation.uncertain && observation.pids.length === 0) return true;
    await input.wait(250);
  }
  const observation = await observePrimaryRuntimePort(input.config, input.runCommand);
  return !observation.uncertain && observation.pids.length === 0;
}

function commandLineHasArgument(commandLine: string, flag: string, value: string): boolean {
  const candidates = [
    `${flag} ${value}`,
    `${flag} "${value}"`,
    `${flag} '${value}'`,
  ];
  return candidates.some((candidate) => {
    const index = commandLine.indexOf(candidate);
    if (index < 0) return false;
    const before = index === 0 ? '' : commandLine[index - 1];
    const afterIndex = index + candidate.length;
    const after = afterIndex >= commandLine.length ? '' : commandLine[afterIndex];
    return (!before || /\s/.test(before)) && (!after || /\s/.test(after));
  });
}

async function verifyPrimaryRuntimeListenerIdentity(input: {
  config: RecoveryConfig;
  pid: number;
  uid: number;
  port: number;
  runCommand: CommandRunner;
}): Promise<{ ok: boolean; detail: string }> {
  const paths = forgeRuntimeServicePaths(input.config.controllerHome);
  const physicalEntrypoint = activeRuntimeEntrypoint(input.config.controllerHome);
  const launchSpec = activeRuntimeLaunchSpec(input.config.controllerHome);
  if (!physicalEntrypoint || !launchSpec) return { ok: false, detail: 'active Runtime release identity is unavailable' };
  const manifestIndex = launchSpec.args.indexOf('--release-manifest');
  const manifestPath = manifestIndex >= 0 ? launchSpec.args[manifestIndex + 1] : undefined;
  if (!manifestPath) return { ok: false, detail: 'active Runtime release manifest identity is unavailable' };

  const result = await input.runCommand('ps', ['-ww', '-p', String(input.pid), '-o', 'uid=', '-o', 'command='], 3_000);
  if (!result.ok) return { ok: false, detail: `listener process identity could not be read: ${result.stderr || result.stdout || result.status}` };
  const line = result.stdout.trim().split(/\r?\n/).find(Boolean) ?? '';
  const match = /^\s*(\d+)\s+(.+)$/.exec(line);
  if (!match) return { ok: false, detail: 'listener process identity was not machine-readable' };
  const observedUid = Number(match[1]);
  const commandLine = match[2]!.trim();
  if (observedUid !== input.uid) return { ok: false, detail: `listener uid ${observedUid} does not match Recovery uid ${input.uid}` };
  const executableMatches = [resolve(paths.activeEntrypointPath), resolve(physicalEntrypoint)]
    .some((candidate) => commandLine === candidate || commandLine.startsWith(`${candidate} `));
  if (!executableMatches) return { ok: false, detail: 'listener executable is not the active Forge Runtime entrypoint' };
  if (!commandLineHasArgument(commandLine, '--controller-home', resolve(input.config.controllerHome))) {
    return { ok: false, detail: 'listener controller-home identity does not match' };
  }
  if (!commandLineHasArgument(commandLine, '--port', String(input.port))) {
    return { ok: false, detail: 'listener port identity does not match' };
  }
  if (!commandLineHasArgument(commandLine, '--release-manifest', resolve(manifestPath))) {
    return { ok: false, detail: 'listener release-manifest identity does not match' };
  }
  return { ok: true, detail: 'listener matches the current Forge Runtime release and controller identity' };
}

async function cleanupVerifiedStalePrimaryRuntimeListener(input: {
  config: RecoveryConfig;
  uid: number;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  runCommand: CommandRunner;
}): Promise<PrimaryRuntimePortCleanupResult> {
  const initial = await observePrimaryRuntimePort(input.config, input.runCommand);
  if (initial.uncertain) return { released: false, cleaned: false, detail: initial.uncertain };
  if (initial.pids.length === 0) return { released: true, cleaned: false, detail: 'primary Runtime port is already released' };
  if (initial.pids.length !== 1) return { released: false, cleaned: false, detail: `primary Runtime port has ${initial.pids.length} listeners; cleanup requires exactly one` };
  const pid = initial.pids[0]!;
  const identity = await verifyPrimaryRuntimeListenerIdentity({ config: input.config, pid, uid: input.uid, port: initial.port, runCommand: input.runCommand });
  if (!identity.ok) return { released: false, cleaned: false, detail: identity.detail, pid };

  const term = await input.runCommand('kill', ['-TERM', String(pid)], 3_000);
  const releasedAfterTerm = await waitForPrimaryRuntimePortReleased({ ...input, timeoutMs: 5_000 });
  if (releasedAfterTerm) return { released: true, cleaned: true, detail: 'verified stale Forge Runtime listener released after SIGTERM', pid, signal: 'SIGTERM' };
  if (!term.ok) return { released: false, cleaned: false, detail: `verified listener SIGTERM failed: ${term.stderr || term.stdout || term.status}`, pid };

  const beforeKill = await observePrimaryRuntimePort(input.config, input.runCommand);
  if (beforeKill.uncertain || beforeKill.pids.length !== 1 || beforeKill.pids[0] !== pid) {
    return { released: false, cleaned: false, detail: 'listener identity changed after SIGTERM; refusing SIGKILL', pid };
  }
  const identityBeforeKill = await verifyPrimaryRuntimeListenerIdentity({ config: input.config, pid, uid: input.uid, port: beforeKill.port, runCommand: input.runCommand });
  if (!identityBeforeKill.ok) return { released: false, cleaned: false, detail: `listener identity changed after SIGTERM: ${identityBeforeKill.detail}`, pid };
  const killed = await input.runCommand('kill', ['-KILL', String(pid)], 3_000);
  if (!killed.ok) return { released: false, cleaned: false, detail: `verified listener SIGKILL failed: ${killed.stderr || killed.stdout || killed.status}`, pid };
  const releasedAfterKill = await waitForPrimaryRuntimePortReleased({ ...input, timeoutMs: 5_000 });
  return releasedAfterKill
    ? { released: true, cleaned: true, detail: 'verified stale Forge Runtime listener released after SIGKILL', pid, signal: 'SIGKILL' }
    : { released: false, cleaned: false, detail: 'verified stale Forge Runtime listener remained on the port after SIGKILL', pid };
}

interface PrimaryRuntimeStoppedTransition {
  ok: boolean;
  detail: string;
  staleListenerCleanup?: PrimaryRuntimePortCleanupResult;
}

/**
 * Stop the one canonical Runtime service and prove that every execution owner
 * boundary is gone before release authority may change. This is the shared
 * transition primitive for activation and recovery; callers must not publish
 * or roll back a release after a partial stop.
 */
async function stopPrimaryRuntimeForReleaseTransition(input: {
  config: RecoveryConfig;
  service: LaunchdService;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  runCommand: CommandRunner;
  runtimeRunning: (config: RecoveryConfig) => boolean;
}): Promise<PrimaryRuntimeStoppedTransition> {
  const stopped = await input.runCommand('launchctl', ['bootout', input.service.target], 15_000);
  const stoppedCleanly = stopped.ok || /not found|no such process|could not find service|service is not loaded/i.test(`${stopped.stderr}\n${stopped.stdout}`);
  if (!stoppedCleanly) {
    return { ok: false, detail: `primary Runtime bootout failed: ${stopped.stderr || stopped.stdout || stopped.status}` };
  }
  const runtimeStopped = await waitForPrimaryRuntimeState({
    config: input.config,
    expectedRunning: false,
    timeoutMs: 20_000,
    now: input.now,
    wait: input.wait,
    runtimeRunning: input.runtimeRunning,
  });
  if (!runtimeStopped) return { ok: false, detail: 'primary Runtime owner remained live after bounded launchd bootout' };
  const serviceUnloaded = await waitForLaunchdServiceUnloaded({
    service: input.service,
    timeoutMs: 20_000,
    now: input.now,
    wait: input.wait,
    runCommand: input.runCommand,
  });
  if (!serviceUnloaded) return { ok: false, detail: 'primary Runtime launchd service remained loaded after bounded bootout' };

  let portReleased = await waitForPrimaryRuntimePortReleased({
    config: input.config,
    timeoutMs: 20_000,
    now: input.now,
    wait: input.wait,
    runCommand: input.runCommand,
  });
  let staleListenerCleanup: PrimaryRuntimePortCleanupResult | undefined;
  if (!portReleased) {
    staleListenerCleanup = await cleanupVerifiedStalePrimaryRuntimeListener({
      config: input.config,
      uid: input.service.uid,
      now: input.now,
      wait: input.wait,
      runCommand: input.runCommand,
    });
    portReleased = staleListenerCleanup.released;
  }
  if (!portReleased) {
    return {
      ok: false,
      detail: `primary Runtime TCP port remained occupied after bounded launchd bootout: ${staleListenerCleanup?.detail ?? 'listener did not release'}`,
      staleListenerCleanup,
    };
  }
  return { ok: true, detail: 'primary Runtime service, owner, and TCP listener are stopped', staleListenerCleanup };
}

async function verifyPrimaryRuntimeAfterStart(input: {
  config: RecoveryConfig;
  timeoutMs: number;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  verifyLocal: (config: RecoveryConfig) => Promise<VerifyResult>;
}): Promise<VerifyResult> {
  const deadline = input.now() + input.timeoutMs;
  let observed = await input.verifyLocal(input.config);
  while (!observed.ok && input.now() < deadline) {
    await input.wait(1_000);
    observed = await input.verifyLocal(input.config);
  }
  return observed;
}

interface PrimaryRuntimeRebindStartResult {
  ok: boolean;
  detail: string;
  verify: VerifyResult;
}

/**
 * Complete the only safe restart sequence after release authority changes:
 * rebind the release-pinned launchd contract, start the sole Runtime service,
 * and require whole-Runtime verification. A started-but-unverified Runtime is
 * stopped again so callers never leave a restart loop behind.
 */
async function rebindStartAndVerifyPrimaryRuntime(input: {
  config: RecoveryConfig;
  service: LaunchdService;
  runCommand: CommandRunner;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  verifyLocal: (config: RecoveryConfig) => Promise<VerifyResult>;
  ensureRuntimeLaunchContract?: (controllerHome: string) => void;
  beforeStart?: () => void;
  contractFailureContext?: string;
  timeoutMs: number;
  successDetail: string;
}): Promise<PrimaryRuntimeRebindStartResult> {
  try {
    const ensureRuntimeLaunchContract = input.ensureRuntimeLaunchContract
      ?? ((controllerHome: string) => { ensureForgeRuntimeLaunchAgentContract({ controllerHome, installUserLaunchAgent: true }); });
    ensureRuntimeLaunchContract(input.config.controllerHome);
  } catch (error) {
    return {
      ok: false,
      detail: `primary Runtime launchd contract rebuild failed ${input.contractFailureContext ?? 'after release transition'}: ${error instanceof Error ? error.message : String(error)}`,
      verify: await input.verifyLocal(input.config),
    };
  }

  try {
    input.beforeStart?.();
  } catch (error) {
    return {
      ok: false,
      detail: `release transition pre-start preparation failed: ${error instanceof Error ? error.message : String(error)}`,
      verify: await input.verifyLocal(input.config),
    };
  }

  const started = await ensureLaunchdServiceStarted(input.service, input.runCommand);
  if (!started.ok) {
    return { ok: false, detail: started.detail, verify: await input.verifyLocal(input.config) };
  }
  const verify = await verifyPrimaryRuntimeAfterStart({
    config: input.config,
    timeoutMs: input.timeoutMs,
    now: input.now,
    wait: input.wait,
    verifyLocal: input.verifyLocal,
  });
  if (verify.ok) return { ok: true, detail: input.successDetail, verify };
  await input.runCommand('launchctl', ['bootout', input.service.target], 15_000);
  return {
    ok: false,
    detail: 'release transition started a Runtime that failed whole-Runtime verification; service was stopped to prevent a restart loop',
    verify,
  };
}

export async function restartPrimaryRuntime(
  config: RecoveryConfig,
  dependencies: PrimaryRuntimeRecoveryDependencies = {},
): Promise<PrimaryRuntimeRestartResult> {
  const verifyLocal = dependencies.verifyLocal ?? verifyLocalRuntime;
  const initial = await verifyLocal(config);
  if (initial.ok) return { ok: true, attempted: false, noOp: true, detail: 'Canonical Forge Runtime is already healthy', verify: initial };
  if ((dependencies.platform ?? process.platform) !== 'darwin') {
    return { ok: false, attempted: false, noOp: true, detail: 'primary Runtime automatic restart currently requires the configured macOS launchd service', verify: initial };
  }
  const uid = await (dependencies.currentUid ?? currentUid)();
  const service = uid === undefined ? undefined : primaryRuntimeLaunchdService(config, uid);
  if (!service) return { ok: false, attempted: false, noOp: true, detail: 'primary Forge Runtime launchd service is not installed', verify: initial };
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.sleep ?? sleep;
  const locked = await withLock(config, { action: 'restart_primary_runtime' }, async () => {
    const before = await verifyLocal(config);
    if (before.ok) return { ok: true, attempted: false, noOp: true, detail: 'Canonical Forge Runtime recovered before restart', serviceTarget: service.target, verify: before } satisfies PrimaryRuntimeRestartResult;
    const started = await ensureLaunchdServiceStarted(service, dependencies.runCommand ?? command);
    if (!started.ok) {
      audit(config, 'primary_runtime_restart_failed', { serviceTarget: service.target, detail: started.detail });
      return { ok: false, attempted: true, detail: started.detail, serviceTarget: service.target, verify: before } satisfies PrimaryRuntimeRestartResult;
    }
    const after = await verifyPrimaryRuntimeAfterStart({
      config,
      timeoutMs: configuredPrimaryRuntimeService(config).postRestartVerifyTimeoutMs ?? 30_000,
      now,
      wait,
      verifyLocal,
    });
    if (after.ok) {
      audit(config, 'primary_runtime_restart_succeeded', { serviceTarget: service.target, release: after.releases.active?.revision });
      return { ok: true, attempted: true, detail: 'Canonical Forge Runtime restarted and passed whole-Runtime verification', serviceTarget: service.target, verify: after } satisfies PrimaryRuntimeRestartResult;
    }
    audit(config, 'primary_runtime_restart_unverified', { serviceTarget: service.target, reasonCodes: after.runtime.reasonCodes });
    return { ok: false, attempted: true, detail: 'Canonical Forge Runtime restarted but did not pass whole-Runtime verification before timeout', serviceTarget: service.target, verify: after } satisfies PrimaryRuntimeRestartResult;
  });
  if (!locked.acquired) return { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner), serviceTarget: service.target, verify: initial };
  return locked.value;
}

export async function recoverPrimaryRuntime(
  config: RecoveryConfig,
  reason = 'watchdog exhausted bounded primary Runtime restarts',
  dependencies: PrimaryRuntimeRecoveryDependencies = {},
): Promise<PrimaryRuntimeRecoveryResult> {
  const verifyLocal = dependencies.verifyLocal ?? verifyLocalRuntime;
  const initial = await verifyLocal(config);
  if (initial.ok) return { ok: true, attempted: false, noOp: true, detail: 'Canonical Forge Runtime recovered before rollback', verify: initial };
  if ((dependencies.platform ?? process.platform) !== 'darwin') {
    return { ok: false, attempted: false, noOp: true, detail: 'automatic whole-Runtime recovery currently requires the configured macOS launchd service', verify: initial };
  }
  const uid = await (dependencies.currentUid ?? currentUid)();
  const service = uid === undefined ? undefined : primaryRuntimeLaunchdService(config, uid);
  if (!service) return { ok: false, attempted: false, noOp: true, detail: 'primary Forge Runtime launchd service is not installed', verify: initial };
  const runCommand = dependencies.runCommand ?? command;
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.sleep ?? sleep;
  const runtimeRunning = dependencies.runtimeRunning ?? ((value: RecoveryConfig) => observeRuntimeStatus(value.controllerHome).running);
  const locked = await withLock(config, { action: 'recover_primary_runtime' }, async () => {
    const before = await verifyLocal(config);
    if (before.ok) return { ok: true, attempted: false, noOp: true, detail: 'Canonical Forge Runtime recovered before rollback', serviceTarget: service.target, verify: before } satisfies PrimaryRuntimeRecoveryResult;

    const stopped = await stopPrimaryRuntimeForReleaseTransition({ config, service, now, wait, runCommand, runtimeRunning });
    if (!stopped.ok) {
      const action = stopped.detail.startsWith('primary Runtime bootout failed')
        ? 'primary_runtime_recovery_stop_failed'
        : 'primary_runtime_recovery_stop_unverified';
      audit(config, action, { serviceTarget: service.target, detail: stopped.detail, pid: stopped.staleListenerCleanup?.pid });
      return { ok: false, attempted: true, detail: stopped.detail, serviceTarget: service.target, verify: await verifyLocal(config) } satisfies PrimaryRuntimeRecoveryResult;
    }
    if (stopped.staleListenerCleanup?.cleaned) {
      audit(config, 'primary_runtime_recovery_stale_listener_cleaned', {
        serviceTarget: service.target,
        pid: stopped.staleListenerCleanup.pid,
        signal: stopped.staleListenerCleanup.signal,
        detail: stopped.staleListenerCleanup.detail,
      });
    }

    const rollback = await rollbackPreviousLocked(config, reason);
    if (!rollback.ok) {
      audit(config, 'primary_runtime_recovery_rollback_failed', { serviceTarget: service.target, detail: rollback.detail });
      return { ok: false, attempted: true, detail: rollback.detail, serviceTarget: service.target, rollback, verify: rollback.verify ?? await verifyLocal(config) } satisfies PrimaryRuntimeRecoveryResult;
    }

    const restarted = await rebindStartAndVerifyPrimaryRuntime({
      config,
      service,
      runCommand,
      now,
      wait,
      verifyLocal,
      ensureRuntimeLaunchContract: dependencies.ensureRuntimeLaunchContract,
      contractFailureContext: 'after rollback',
      timeoutMs: configuredPrimaryRuntimeService(config).postRestartVerifyTimeoutMs ?? 45_000,
      successDetail: 'previous whole-Runtime release and SQLite backup restored, restarted, and verified',
    });
    if (restarted.ok) {
      audit(config, 'primary_runtime_recovery_succeeded', { serviceTarget: service.target, rollbackOperationId: rollback.operationId, restoredRelease: restarted.verify.releases.active?.revision });
      return { ok: true, attempted: true, detail: restarted.detail, serviceTarget: service.target, rollback, verify: restarted.verify } satisfies PrimaryRuntimeRecoveryResult;
    }
    const contractFailure = restarted.detail.startsWith('primary Runtime launchd contract rebuild failed');
    audit(config, contractFailure ? 'primary_runtime_recovery_launchd_contract_failed' : 'primary_runtime_recovery_unverified', {
      serviceTarget: service.target,
      rollbackOperationId: rollback.operationId,
      detail: restarted.detail,
      reasonCodes: restarted.verify.runtime.reasonCodes,
    });
    return { ok: false, attempted: true, detail: restarted.detail, serviceTarget: service.target, rollback, verify: restarted.verify } satisfies PrimaryRuntimeRecoveryResult;
  });
  if (!locked.acquired) return { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner), serviceTarget: service.target, verify: initial };
  return locked.value;
}

function canonicalRuntimeManifestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalRuntimeManifestValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalRuntimeManifestValue(entry)]),
  );
}

function runtimeBehaviorIdentity(manifestPath: string): string {
  const parsed = JSON.parse(readFileSync(resolve(manifestPath), 'utf8')) as Record<string, unknown>;
  const behavior = { ...parsed };
  // These fields identify a build/release event but do not change the process or
  // any co-located runtime helper. Every other manifest field participates by
  // default so newly added sidecars cannot silently bypass restart detection.
  for (const field of ['releaseId', 'sourceCommit', 'releaseRevision', 'cleanWorkspace', 'createdAt']) {
    delete behavior[field];
  }
  return createHash('sha256').update(JSON.stringify(canonicalRuntimeManifestValue(behavior))).digest('hex');
}

function runtimeBehaviorEquivalent(leftManifestPath: string, rightManifestPath: string): boolean {
  return runtimeBehaviorIdentity(leftManifestPath) === runtimeBehaviorIdentity(rightManifestPath);
}

function validateRuntimeReleaseCandidate(
  config: RecoveryConfig,
  manifestPath: string,
): { manifest: RuntimeReleaseManifest; releaseRoot: string; manifestPath: string } {
  if (!isAbsolute(manifestPath)) throw new Error('RUNTIME_RELEASE_CANDIDATE_PATH_REQUIRED: an absolute release manifest path is required');
  if (!existsSync(manifestPath)) throw new Error(`RUNTIME_RELEASE_CANDIDATE_MANIFEST_MISSING: ${manifestPath}`);
  const resolvedManifestPath = resolve(manifestPath);
  const manifest = loadRuntimeReleaseManifest(resolvedManifestPath, config.controllerHome);
  const releaseRoot = dirname(resolvedManifestPath);
  if (basename(releaseRoot) !== manifest.releaseId) {
    throw new Error('RUNTIME_RELEASE_CANDIDATE_ID_MISMATCH: manifest releaseId must match the immutable release directory');
  }
  const executable = join(releaseRoot, manifest.entrypoint);
  if (!existsSync(executable)) throw new Error(`RUNTIME_RELEASE_CANDIDATE_ENTRYPOINT_MISSING: ${executable}`);
  const identity = `sha256:${createHash('sha256').update(readFileSync(executable)).digest('hex')}`;
  if (identity !== manifest.artifactIdentity) {
    throw new Error(`RUNTIME_RELEASE_CANDIDATE_ARTIFACT_MISMATCH: expected ${manifest.artifactIdentity} observed ${identity}`);
  }
  return { manifest, releaseRoot, manifestPath: resolvedManifestPath };
}

/**
 * Activate an already staged and validated immutable Runtime release without
 * depending on the primary Runtime execution plane. The transaction mirrors
 * recoverPrimaryRuntime: stop the complete canonical service, atomically switch
 * active/previous whole-release authority (with a local SQLite backup), start
 * the one Runtime service, require whole-Runtime verification, and on failure
 * restore the previous whole release and its SQLite backup before restarting.
 */
export async function activateRuntimeRelease(
  config: RecoveryConfig,
  candidateManifestPath: string,
  dependencies: PrimaryRuntimeRecoveryDependencies = {},
  guard: RuntimeReleaseActivationGuard = {},
): Promise<RuntimeReleaseActivationResult> {
  let candidate: { manifest: RuntimeReleaseManifest; releaseRoot: string; manifestPath: string };
  try {
    candidate = validateRuntimeReleaseCandidate(config, candidateManifestPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'runtime release candidate validation failed';
    audit(config, 'runtime_release_activation_candidate_invalid', { detail, ...(guard.requestId ? { requestId: guard.requestId } : {}) });
    return { ok: false, attempted: false, noOp: true, detail };
  }
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'darwin') {
    return { ok: false, attempted: false, noOp: true, detail: 'Runtime release activation currently requires the configured macOS launchd service' };
  }
  const uid = await (dependencies.currentUid ?? currentUid)();
  const service = uid === undefined ? undefined : primaryRuntimeLaunchdService(config, uid);
  if (!service) return { ok: false, attempted: false, noOp: true, detail: 'primary Forge Runtime launchd service is not installed', verify: await verifyStableRuntime(config) };
  const runCommand = dependencies.runCommand ?? command;
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.sleep ?? sleep;
  const runtimeRunning = dependencies.runtimeRunning ?? ((value: RecoveryConfig) => observeRuntimeStatus(value.controllerHome).running);
  const verifyLocal = dependencies.verifyLocal ?? verifyLocalRuntime;
  const operationId = `recovery-activate-runtime-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const lockRequestId = guard.requestId?.trim() || operationId;
  const locked = await withLock(config, { action: 'activate_runtime_release', requestId: lockRequestId }, async () => {
    // Re-read authority only after acquiring the mutation lock. A caller may
    // have selected its candidate before another activation completed; stale
    // decisions must fail before bootout/publish rather than overwrite the newer
    // active release.
    const current = releaseAuthority(config);
    const previousActive = current?.active;
    const expectedRevision = guard.expectedAuthorityRevision;
    const expectedActiveReleaseId = typeof guard.expectedActiveReleaseId === 'string' ? guard.expectedActiveReleaseId.trim() : guard.expectedActiveReleaseId;
    if (expectedRevision !== undefined && (expectedRevision === null ? current !== undefined : current?.revision !== expectedRevision)) {
      const detail = `RUNTIME_RELEASE_ACTIVATION_STALE_BASE: expected authority revision ${expectedRevision}, observed ${current?.revision ?? 'none'}`;
      audit(config, 'runtime_release_activation_stale_base', {
        operationId,
        requestId: lockRequestId,
        candidateRevision: candidate.manifest.releaseId,
        expectedAuthorityRevision: expectedRevision,
        observedAuthorityRevision: current?.revision,
        expectedActiveReleaseId,
        observedActiveReleaseId: current?.active.releaseId,
      });
      return { ok: false, attempted: false, noOp: true, detail, operationId } satisfies RuntimeReleaseActivationResult;
    }
    if (expectedActiveReleaseId !== undefined && (expectedActiveReleaseId === null ? current?.active !== undefined : current?.active.releaseId !== expectedActiveReleaseId)) {
      const detail = `RUNTIME_RELEASE_ACTIVATION_STALE_BASE: expected active release ${expectedActiveReleaseId}, observed ${current?.active.releaseId ?? 'none'}`;
      audit(config, 'runtime_release_activation_stale_base', {
        operationId,
        requestId: lockRequestId,
        candidateRevision: candidate.manifest.releaseId,
        expectedAuthorityRevision: expectedRevision,
        observedAuthorityRevision: current?.revision,
        expectedActiveReleaseId,
        observedActiveReleaseId: current?.active.releaseId,
      });
      return { ok: false, attempted: false, noOp: true, detail, operationId } satisfies RuntimeReleaseActivationResult;
    }
    let storageMigrationRequired = false;
    try {
      storageMigrationRequired = repoLocalControllerHomeStorageNeedsMigration(config.controllerHome, platform);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Controller Home storage migration preflight failed';
      audit(config, 'runtime_release_activation_storage_preflight_failed', { operationId, requestId: lockRequestId, detail });
      return { ok: false, attempted: false, noOp: true, detail, operationId } satisfies RuntimeReleaseActivationResult;
    }
    if (current && current.active.releaseId === candidate.manifest.releaseId) {
      if (storageMigrationRequired) {
        const detail = 'CONTROLLER_HOME_STORAGE_MIGRATION_REQUIRES_STAGED_RELEASE: stage a fresh immutable Runtime release so Recovery can migrate storage inside the activation transaction';
        return { ok: false, attempted: false, noOp: true, detail, operationId } satisfies RuntimeReleaseActivationResult;
      }
      return {
        ok: true,
        attempted: false,
        noOp: true,
        detail: 'requested Runtime release is already the active whole-Runtime release',
        operationId,
        verify: await verifyLocal(config),
      } satisfies RuntimeReleaseActivationResult;
    }
    if (current) {
      const behaviorEquivalent = runtimeBehaviorEquivalent(current.active.manifestPath, candidate.manifestPath);
      let serviceContractMatches = false;
      if (behaviorEquivalent && !storageMigrationRequired) {
        try {
          serviceContractMatches = inspectForgeRuntimeLaunchAgentContract({
            controllerHome: config.controllerHome,
            inspectUserLaunchAgent: true,
          }).matches;
        } catch (error) {
          audit(config, 'runtime_release_activation_service_contract_inspection_failed', {
            operationId,
            requestId: lockRequestId,
            activeRevision: current.active.releaseId,
            candidateRevision: candidate.manifest.releaseId,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (behaviorEquivalent && !storageMigrationRequired && serviceContractMatches) {
        const verify = await verifyLocal(config);
        audit(config, 'runtime_release_activation_behavior_identical', {
          operationId,
          requestId: lockRequestId,
          activeRevision: current.active.releaseId,
          candidateRevision: candidate.manifest.releaseId,
          artifactIdentity: candidate.manifest.artifactIdentity,
        });
        return {
          ok: verify.ok,
          attempted: false,
          noOp: true,
          detail: verify.ok
            ? 'candidate Runtime behavior and launchd service contract are identical to the active release; restart skipped'
            : 'candidate Runtime behavior and launchd service contract are identical to the active release, but the active Runtime is unhealthy',
          operationId,
          verify,
        } satisfies RuntimeReleaseActivationResult;
      }
    }
    if (current?.previous?.releaseId === candidate.manifest.releaseId) {
      const detail = 'RUNTIME_RELEASE_REVERSE_ACTIVATION_REQUIRES_ROLLBACK: activate_runtime_release cannot replace the active release with current.previous; use rollback_previous or recover_primary_runtime';
      audit(config, 'runtime_release_reverse_activation_rejected', {
        operationId,
        requestId: lockRequestId,
        candidateRevision: candidate.manifest.releaseId,
        activeRevision: current.active.releaseId,
        authorityRevision: current.revision,
      });
      return { ok: false, attempted: false, noOp: true, detail, operationId } satisfies RuntimeReleaseActivationResult;
    }
    const before = await verifyLocal(config);
    const stopped = await stopPrimaryRuntimeForReleaseTransition({ config, service, now, wait, runCommand, runtimeRunning });
    if (!stopped.ok) {
      const action = stopped.detail.startsWith('primary Runtime bootout failed')
        ? 'runtime_release_activation_stop_failed'
        : 'runtime_release_activation_stop_unverified';
      audit(config, action, { serviceTarget: service.target, operationId, detail: stopped.detail, pid: stopped.staleListenerCleanup?.pid });
      return { ok: false, attempted: true, detail: stopped.detail, serviceTarget: service.target, verify: await verifyLocal(config) } satisfies RuntimeReleaseActivationResult;
    }
    if (stopped.staleListenerCleanup?.cleaned) {
      audit(config, 'runtime_release_activation_stale_listener_cleaned', {
        serviceTarget: service.target,
        operationId,
        pid: stopped.staleListenerCleanup.pid,
        signal: stopped.staleListenerCleanup.signal,
        detail: stopped.staleListenerCleanup.detail,
      });
    }
    let committed: RuntimeReleaseAuthority;
    try {
      committed = publishRuntimeRelease(config.controllerHome, candidate.manifestPath, operationId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'runtime release authority publish failed';
      audit(config, 'runtime_release_activation_publish_failed', { serviceTarget: service.target, operationId, detail });
      return { ok: false, attempted: true, detail, serviceTarget: service.target, verify: await verifyLocal(config) } satisfies RuntimeReleaseActivationResult;
    }
    if (committed.active.releaseId !== candidate.manifest.releaseId || committed.active.artifactIdentity !== candidate.manifest.artifactIdentity) {
      const detail = 'runtime release activation commit identity mismatch';
      audit(config, 'runtime_release_activation_commit_mismatch', { serviceTarget: service.target, operationId });
      return { ok: false, attempted: true, detail, serviceTarget: service.target, verify: await verifyLocal(config) } satisfies RuntimeReleaseActivationResult;
    }
    let storageMigration: ControllerHomeStorageMigration | undefined;
    const activated = await rebindStartAndVerifyPrimaryRuntime({
      config,
      service,
      runCommand,
      now,
      wait,
      verifyLocal,
      timeoutMs: configuredPrimaryRuntimeService(config).postRestartVerifyTimeoutMs ?? 60_000,
      successDetail: 'requested Runtime release started and passed whole-Runtime verification',
      beforeStart: () => {
        storageMigration = migrateStoppedRepoLocalControllerHomeStorage(config.controllerHome, platform);
        if (storageMigration.migrated) {
          audit(config, 'runtime_controller_home_noindex_migrated', {
            serviceTarget: service.target,
            operationId,
            logicalHome: storageMigration.logicalHome,
            physicalHome: storageMigration.physicalHome,
          });
        }
      },
    });
    let after = activated.verify;
    let activationFailureDetail: string | undefined;
    if (activated.ok && after.releases.active?.revision === candidate.manifest.releaseId) {
      audit(config, 'runtime_release_activation_succeeded', { serviceTarget: service.target, operationId, requestId: lockRequestId, activeRevision: after.releases.active?.revision, expectedAuthorityRevision: guard.expectedAuthorityRevision, expectedActiveReleaseId: guard.expectedActiveReleaseId, controllerHomeStorageMigrated: storageMigration?.migrated === true });
      return { ok: true, attempted: true, detail: storageMigration?.migrated ? 'requested Runtime release activated, Controller Home migrated to .noindex storage, and whole-Runtime verification passed' : 'requested Runtime release activated and passed whole-Runtime verification', serviceTarget: service.target, operationId, verify: after } satisfies RuntimeReleaseActivationResult;
    }
    if (!activated.ok) {
      activationFailureDetail = activated.detail;
      const auditAction = activated.detail.startsWith('primary Runtime launchd contract rebuild failed')
        ? 'runtime_release_activation_launchd_contract_failed'
        : activated.detail.startsWith('release transition pre-start preparation failed')
          ? 'runtime_controller_home_noindex_migration_failed'
          : activated.detail.includes('start')
            ? 'runtime_release_activation_start_failed'
            : 'runtime_release_activation_unverified';
      audit(config, auditAction, { serviceTarget: service.target, operationId, detail: activated.detail });
    } else {
      activationFailureDetail = `activated Runtime release identity mismatch: expected ${candidate.manifest.releaseId}, observed ${after.releases.active?.revision ?? 'none'}`;
      audit(config, 'runtime_release_activation_commit_mismatch', { serviceTarget: service.target, operationId, detail: activationFailureDetail });
    }

    // Activation failed: stop, restore the previous whole release and its SQLite
    // backup, restart the one service, and require verification again.
    let rollback: RollbackResult;
    const rollbackStop = await stopPrimaryRuntimeForReleaseTransition({ config, service, now, wait, runCommand, runtimeRunning });
    if (!rollbackStop.ok) {
      rollback = {
        ok: false,
        detail: rollbackStop.detail
          .replace('primary Runtime', 'candidate Runtime')
          .replace('bounded launchd bootout', 'bounded rollback bootout'),
      };
    } else {
      try {
        const rollbackOperationId = `recovery-activate-runtime-rollback-${Date.now()}-${randomUUID().slice(0, 8)}`;
        const restored = rollbackRuntimeRelease(config.controllerHome, rollbackOperationId);
        if (storageMigration?.migrated) {
          rollbackStoppedRepoLocalControllerHomeStorage(storageMigration);
          audit(config, 'runtime_controller_home_noindex_migration_rolled_back', {
            serviceTarget: service.target,
            operationId,
            rollbackOperationId,
            logicalHome: storageMigration.logicalHome,
            physicalHome: storageMigration.physicalHome,
          });
        }
        const previousRevision = previousActive?.releaseId ?? '';
        const previousIdentity = previousActive?.artifactIdentity;
        if (
          restored.active.releaseId !== previousRevision
          || (previousIdentity !== undefined && restored.active.artifactIdentity !== previousIdentity)
        ) {
          throw new Error('RECOVERY_RUNTIME_RELEASE_ROLLBACK_AUTHORITY_MISMATCH');
        }
        const restarted = await rebindStartAndVerifyPrimaryRuntime({
          config,
          service,
          runCommand,
          now,
          wait,
          verifyLocal,
          contractFailureContext: 'after rollback',
          timeoutMs: configuredPrimaryRuntimeService(config).postRestartVerifyTimeoutMs ?? 60_000,
          successDetail: 'previous whole-Runtime release and SQLite backup restored, restarted, and verified',
        });
        rollback = { ok: restarted.ok, operationId: rollbackOperationId, detail: restarted.detail, verify: restarted.verify };
      } catch (error) {
        rollback = { ok: false, detail: error instanceof Error ? error.message : 'previous whole-Runtime release rollback failed' };
      }
    }
    audit(config, 'runtime_release_activation_failed', {
      serviceTarget: service.target,
      operationId,
      candidateRevision: candidate.manifest.releaseId,
      rollbackOperationId: rollback.operationId,
      rollbackOk: rollback.ok,
      rollbackDetail: rollback.detail,
      reasonCodes: after.runtime.reasonCodes,
    });
    return {
      ok: false,
      attempted: true,
      detail: activationFailureDetail
        ? `requested Runtime release failed to start; previous release restored: ${activationFailureDetail}`
        : 'requested Runtime release activated but failed whole-Runtime verification; previous release restored',
      serviceTarget: service.target,
      operationId,
      rollback,
      verify: after,
    } satisfies RuntimeReleaseActivationResult;
  });
  if (!locked.acquired) {
    return { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner), serviceTarget: service.target, verify: await verifyStableRuntime(config) };
  }
  return locked.value;
}

export interface ConfiguredRuntimeActivationDependencies {
  stage?: typeof stageRuntimeReleaseFromCandidateSource;
  activate?: (config: RecoveryConfig, manifestPath: string, guard: RuntimeReleaseActivationGuard) => Promise<RuntimeReleaseActivationResult>;
}

export async function stageAndActivateConfiguredRuntimeRelease(
  config: RecoveryConfig,
  dependencies: ConfiguredRuntimeActivationDependencies = {},
  requestId?: string,
): Promise<ConfiguredRuntimeActivationResult> {
  const sourceRoot = config.primaryRuntimeSourceRoot?.trim();
  if (!sourceRoot) {
    return { ok: false, attempted: false, noOp: true, detail: 'primary Runtime source root is not configured in standalone Recovery' };
  }
  // Capture the base before staging. Staging can take long enough for another
  // activation to win; the later publish must prove this base is still current.
  const expectedAuthority = releaseAuthority(config);
  let staged: StagedRuntimeRelease;
  try {
    staged = (dependencies.stage ?? stageRuntimeReleaseFromCandidateSource)({ controllerHome: config.controllerHome, sourceRoot });
    assertRuntimeReleaseFiles(staged);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Runtime release staging failed';
    audit(config, 'runtime_release_stage_failed', { sourceRoot, detail });
    return { ok: false, attempted: false, noOp: true, detail };
  }
  const activationGuard: RuntimeReleaseActivationGuard = {
    ...(requestId?.trim() ? { requestId: requestId.trim() } : {}),
    expectedAuthorityRevision: expectedAuthority?.revision ?? null,
    expectedActiveReleaseId: expectedAuthority?.active.releaseId ?? null,
  };
  const activation = dependencies.activate
    ? await dependencies.activate(config, staged.manifestPath, activationGuard)
    : await activateRuntimeRelease(config, staged.manifestPath, {}, activationGuard);
  audit(config, activation.ok ? 'runtime_release_stage_and_activate_succeeded' : 'runtime_release_stage_and_activate_failed', {
    sourceRoot,
    ...(requestId?.trim() ? { requestId: requestId.trim() } : {}),
    expectedAuthorityRevision: activationGuard.expectedAuthorityRevision,
    expectedActiveReleaseId: activationGuard.expectedActiveReleaseId,
    releaseId: staged.releaseId,
    sourceCommit: staged.sourceCommit,
    activationAttempted: activation.attempted,
    activationDetail: activation.detail,
  });
  return {
    ok: activation.ok,
    attempted: activation.attempted,
    noOp: activation.noOp,
    detail: activation.ok ? 'configured Runtime source was staged as one immutable release and activated through standalone Recovery' : activation.detail,
    staged,
    activation,
  };
}

function tunnelLaunchdService(configured: PublicTunnelServiceConfig | undefined, uid: number): LaunchdService | undefined {
  if (!configured || configured.platform !== 'launchd') return undefined;
  if (!/^com\.[A-Za-z0-9._-]{1,180}$/.test(configured.label)) return undefined;
  const plistPath = configured.plistPath;
  if (plistPath !== undefined && (!isAbsolute(plistPath) || !existsSync(plistPath))) return undefined;
  return {
    uid,
    domain: `gui/${uid}`,
    target: `gui/${uid}/${configured.label}`,
    label: configured.label,
    plistPath: plistPath ?? join(homedir(), 'Library', 'LaunchAgents', `${configured.label}.plist`),
  };
}

function recoveryTunnelService(config: RecoveryConfig, uid: number): LaunchdService | undefined {
  return tunnelLaunchdService(configuredRecoveryTunnel(config), uid);
}

function primaryPublicTunnelService(config: RecoveryConfig, uid: number): LaunchdService | undefined {
  return tunnelLaunchdService(configuredPrimaryPublicTunnel(config), uid);
}

function tunnelRepairAllowed(config: RecoveryConfig, now: number): boolean {
  const cooldownMs = configuredRecoveryTunnel(config)?.cooldownMs ?? 60_000;
  const prior = json<{ lastAttemptAt?: unknown }>(publicTunnelRepairStatePath(config));
  return typeof prior?.lastAttemptAt !== 'number' || now - prior.lastAttemptAt >= cooldownMs;
}

export async function repairPublicTunnel(config: RecoveryConfig, dependencies: PublicTunnelRepairDependencies = {}): Promise<PublicTunnelRepairResult> {
  const verify = dependencies.verify ?? verifyStableRuntime;
  const verifyLocal = dependencies.verifyLocal ?? verifyLocalRuntime;
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.sleep ?? sleep;
  const initial = await verify(config);
  const configured = configuredRecoveryTunnel(config);
  if (!configured) return { ok: false, attempted: false, noOp: true, detail: 'public tunnel repair is not configured', verify: initial };
  const localVerify = await verifyLocal(config);
  if (!isExternalTunnelFailure(config, initial, localVerify)) {
    return { ok: (initial.probes.recovery_external_http ?? initial.probes.external_mcp_http)?.ok === true, attempted: false, noOp: true, detail: 'Recovery tunnel repair requires a healthy local runtime and failed Recovery external endpoint', verify: initial, localVerify };
  }
  if ((dependencies.platform ?? process.platform) !== 'darwin') {
    return { ok: false, attempted: false, noOp: true, detail: 'public tunnel repair is only supported for explicitly configured launchd services', verify: initial, localVerify };
  }
  const uid = await (dependencies.currentUid ?? currentUid)();
  const service = uid === undefined ? undefined : recoveryTunnelService(config, uid);
  if (!service) return { ok: false, attempted: false, noOp: true, detail: 'public tunnel launchd configuration is invalid or unavailable', verify: initial, localVerify };
  if (!tunnelRepairAllowed(config, now())) {
    return { ok: false, attempted: false, noOp: true, detail: 'public tunnel repair is in cooldown', serviceLabel: service.label, serviceTarget: service.target, verify: initial, localVerify };
  }
  const locked = await withLock(config, { action: 'repair_public_tunnel' }, async () => {
    // Recheck after acquiring ownership so a concurrent watchdog never causes a restart storm.
    const before = await verify(config);
    const localBefore = await verifyLocal(config);
    if (!isExternalTunnelFailure(config, before, localBefore)) {
      return { ok: (before.probes.recovery_external_http ?? before.probes.external_mcp_http)?.ok === true, attempted: false, noOp: true, detail: 'Recovery tunnel recovered before restart', serviceLabel: service.label, serviceTarget: service.target, verify: before, localVerify: localBefore };
    }
    writeJson(publicTunnelRepairStatePath(config), { lastAttemptAt: now(), serviceLabel: service.label });
    const started = await ensureLaunchdServiceStarted(service, dependencies.runCommand ?? command);
    if (!started.ok) {
      audit(config, 'public_tunnel_restart_failed', { serviceLabel: service.label, detail: started.detail });
      return { ok: false, attempted: true, detail: started.detail, serviceLabel: service.label, serviceTarget: service.target, verify: before, localVerify: localBefore };
    }
    const timeoutMs = configured.postRestartVerifyTimeoutMs ?? 20_000;
    const deadline = now() + timeoutMs;
    let after = before;
    while (now() < deadline) {
      await wait(1_000);
      after = await verify(config);
      if ((after.probes.recovery_external_http ?? after.probes.external_mcp_http)?.ok === true) {
        audit(config, 'public_tunnel_restart_succeeded', { serviceLabel: service.label, serviceTarget: service.target });
        return { ok: true, attempted: true, detail: 'public tunnel service restarted and external endpoint verified', serviceLabel: service.label, serviceTarget: service.target, verify: after, localVerify: await verifyLocal(config) };
      }
    }
    audit(config, 'public_tunnel_restart_unverified', { serviceLabel: service.label, serviceTarget: service.target });
    return { ok: false, attempted: true, detail: 'public tunnel service restarted but external endpoint did not recover before timeout', serviceLabel: service.label, serviceTarget: service.target, verify: after, localVerify: await verifyLocal(config) };
  });
  if (!locked.acquired) return { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner), serviceLabel: service.label, serviceTarget: service.target, verify: initial, localVerify };
  return locked.value;
}


export interface RecoveryGatewayRestartResult {
  ok: boolean;
  attempted: boolean;
  noOp?: boolean;
  detail: string;
  serviceTarget?: string;
}

export interface RecoveryWatchdogRestartResult {
  ok: boolean;
  attempted: boolean;
  noOp?: boolean;
  detail: string;
  serviceTarget?: string;
}

interface RecoveryRoleRestartDependencies {
  platform?: NodeJS.Platform;
  currentUid?: () => Promise<number | undefined>;
  runCommand?: CommandRunner;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RecoveryGatewayRestartDependencies extends RecoveryRoleRestartDependencies {
  probeGateway?: (config: RecoveryConfig) => Promise<{ ok: boolean; detail: string }>;
}

export interface RecoveryWatchdogRestartDependencies extends RecoveryRoleRestartDependencies {
  probeWatchdog?: (config: RecoveryConfig) => Promise<{ ok: boolean; detail: string }>;
}

function recoveryRoleLaunchdService(config: RecoveryConfig, uid: number, role: 'gateway' | 'watchdog'): LaunchdService {
  const label = role === 'gateway' ? RECOVERY_GATEWAY_LABEL : RECOVERY_WATCHDOG_LABEL;
  const generated = join(recoveryRoot(config), 'launchd', `${label}.plist`);
  const installed = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  return {
    uid,
    domain: `gui/${uid}`,
    target: `gui/${uid}/${label}`,
    label,
    plistPath: existsSync(installed) ? installed : generated,
  };
}

async function probeRecoveryGateway(config: RecoveryConfig): Promise<{ ok: boolean; detail: string }> {
  if (!config.gateway) return { ok: false, detail: 'Recovery Gateway is not configured' };
  return probe(createRecoveryHttpTransport(config.controllerHome), `http://${config.gateway.host}:${config.gateway.port}/health`);
}

async function probeRecoveryWatchdog(config: RecoveryConfig): Promise<{ ok: boolean; detail: string }> {
  const health = observeRecoveryWatchdogHealth(config.controllerHome);
  return { ok: health.ok, detail: health.detail };
}

async function restartRecoveryRole(input: {
  config: RecoveryConfig;
  role: 'gateway' | 'watchdog';
  action: 'restart_recovery_gateway' | 'restart_recovery_watchdog';
  check: (config: RecoveryConfig) => Promise<{ ok: boolean; detail: string }>;
  dependencies: RecoveryRoleRestartDependencies;
}): Promise<RecoveryGatewayRestartResult> {
  const display = input.role === 'gateway' ? 'Recovery Gateway' : 'Recovery Watchdog';
  if ((input.dependencies.platform ?? process.platform) !== 'darwin') return { ok: false, attempted: false, noOp: true, detail: `${display} launchd restart is only supported on macOS` };
  const initial = await input.check(input.config);
  if (initial.ok) return { ok: true, attempted: false, noOp: true, detail: `${display} is already healthy` };
  const uid = await (input.dependencies.currentUid ?? currentUid)();
  if (uid === undefined) return { ok: false, attempted: false, noOp: true, detail: `${display} launchd UID is unavailable` };
  const service = recoveryRoleLaunchdService(input.config, uid, input.role);
  if (!existsSync(service.plistPath)) return { ok: false, attempted: false, noOp: true, detail: `${display} launchd plist is missing: ${service.plistPath}`, serviceTarget: service.target };
  const eventPrefix = input.role === 'gateway' ? 'recovery_gateway' : 'recovery_watchdog';
  const locked = await withLock(input.config, { action: input.action }, async () => {
    const before = await input.check(input.config);
    if (before.ok) return { ok: true, attempted: false, noOp: true, detail: `${display} recovered before restart`, serviceTarget: service.target } satisfies RecoveryGatewayRestartResult;
    const started = await ensureLaunchdServiceStarted(service, input.dependencies.runCommand ?? command);
    if (!started.ok) {
      audit(input.config, `${eventPrefix}_restart_failed`, { serviceTarget: service.target, detail: started.detail });
      return { ok: false, attempted: true, detail: started.detail, serviceTarget: service.target } satisfies RecoveryGatewayRestartResult;
    }
    const now = input.dependencies.now ?? Date.now;
    const wait = input.dependencies.sleep ?? sleep;
    const deadline = now() + 20_000;
    let observed = before;
    while (now() < deadline) {
      await wait(1_000);
      observed = await input.check(input.config);
      if (observed.ok) {
        audit(input.config, `${eventPrefix}_restart_succeeded`, { serviceTarget: service.target });
        return { ok: true, attempted: true, detail: `${display} restarted and passed local health verification`, serviceTarget: service.target } satisfies RecoveryGatewayRestartResult;
      }
    }
    audit(input.config, `${eventPrefix}_restart_unverified`, { serviceTarget: service.target, detail: observed.detail });
    return { ok: false, attempted: true, detail: `${display} restarted but did not pass local health verification before timeout`, serviceTarget: service.target } satisfies RecoveryGatewayRestartResult;
  });
  if (!locked.acquired) return { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner), serviceTarget: service.target };
  return locked.value;
}

export async function restartRecoveryGateway(
  config: RecoveryConfig,
  dependencies: RecoveryGatewayRestartDependencies = {},
): Promise<RecoveryGatewayRestartResult> {
  if (!config.gateway) return { ok: false, attempted: false, noOp: true, detail: 'Recovery Gateway is not configured' };
  return restartRecoveryRole({
    config,
    role: 'gateway',
    action: 'restart_recovery_gateway',
    check: dependencies.probeGateway ?? probeRecoveryGateway,
    dependencies,
  });
}

export async function restartRecoveryWatchdog(
  config: RecoveryConfig,
  dependencies: RecoveryWatchdogRestartDependencies = {},
): Promise<RecoveryWatchdogRestartResult> {
  return restartRecoveryRole({
    config,
    role: 'watchdog',
    action: 'restart_recovery_watchdog',
    check: dependencies.probeWatchdog ?? probeRecoveryWatchdog,
    dependencies,
  });
}

function pidAlive(pid: number | undefined): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function gatewayToken(config: RecoveryConfig): string | undefined {
  const file = config.gateway?.bearerTokenFile;
  const parsed = file ? json<{ token?: unknown; expiresAt?: unknown }>(file) : undefined;
  if (typeof parsed?.expiresAt === 'string' && Date.parse(parsed.expiresAt) <= Date.now()) return undefined;
  return typeof parsed?.token === 'string' && parsed.token.length >= 32 ? parsed.token : undefined;
}

export function initializeStandaloneRecovery(
  controllerHome: string,
  port = 8787,
  extensions: Partial<Pick<RecoveryConfig, 'publicMcpUrl' | 'recoveryPublicUrl' | 'recoveryTunnelService' | 'primaryPublicTunnelService' | 'primaryRuntimeService' | 'primaryRuntimeSourceRoot' | 'primaryConnectorService' | 'readOnlyTool'>> = {},
): RecoveryConfig {
  const root = resolve(controllerHome);
  const tokenPath = join(root, 'recovery', 'config', 'gateway-token.json');
  if (!existsSync(tokenPath)) {
    mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, `${JSON.stringify({ token: randomBytes(32).toString('base64url'), createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    try { chmodSync(tokenPath, 0o600); } catch { /* best effort */ }
  }
  return createRecoveryConfig(root, {
    gateway: { host: '127.0.0.1', port, bearerTokenFile: tokenPath },
    ...extensions,
  });
}

export function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function watchdogTick(config: RecoveryConfig, prior: WatchdogState): Promise<{
  state: WatchdogState;
  decision: WatchdogDecision;
  verify: VerifyResult;
  rollback?: RollbackResult;
  publicTunnelRepair?: PublicTunnelRepairResult;
  recoveryGatewayRestart?: RecoveryGatewayRestartResult;
  primaryConnectorRestart?: PrimaryConnectorRestartResult;
  primaryRuntimeRestart?: PrimaryRuntimeRestartResult;
  primaryRuntimeRecovery?: PrimaryRuntimeRecoveryResult;
}> {
  const now = Date.now();
  const scopedPrior = scopeWatchdogStateToRuntimeRelease(prior, activeAuthorityRelease(config));
  const runtimeObservation = observeRuntimeStatus(config.controllerHome);
  const runtimeStartupGrace = runtimeWithinWatchdogStartupGrace(
    runtimeObservation,
    now,
    watchdogRuntimeStartupGraceMs(config),
  );
  // Five-second watchdog ticks must stay cheap while the system is healthy.
  // Full MCP protocol verification serializes the entire tool surface, so run
  // it periodically and immediately escalate to it when a local health probe
  // fails. A live Runtime that was just started gets a bounded grace window so
  // startup/reconciliation cannot itself trigger a Recovery restart storm.
  // Explicit verify/attest/release operations remain strict by default.
  const fullVerifyDue = !runtimeStartupGrace
    && (scopedPrior.lastFullVerifyAt === undefined || now - scopedPrior.lastFullVerifyAt >= 60_000);
  let fullVerificationPerformed = fullVerifyDue;
  let verified = await verifyStableRuntime(
    config,
    createRecoveryHttpTransport(config.controllerHome),
    { probeMcpProtocol: fullVerifyDue },
  );
  let localVerify = await verifyLocalRuntime(config, { probeMcpProtocol: fullVerifyDue });
  if (!localVerify.ok && !fullVerifyDue && !runtimeStartupGrace) {
    verified = await verifyStableRuntime(config);
    localVerify = await verifyLocalRuntime(config);
    fullVerificationPerformed = true;
  }
  const lastFullVerifyAt = fullVerificationPerformed ? now : scopedPrior.lastFullVerifyAt;
  if (runtimeStartupGrace && !localVerify.ok) {
    const state: WatchdogState = {
      ...scopedPrior,
      failures: 0,
      firstFailureAt: undefined,
      runtimeHealthySince: undefined,
      lastFullVerifyAt,
      lastDecision: 'degraded',
      lastReason: 'canonical Runtime is within startup grace; restart escalation suppressed',
    };
    return {
      state,
      decision: { action: 'degraded', reason: 'canonical Runtime is within startup grace; restart escalation suppressed' },
      verify: verified,
    };
  }
  const recoveryHealthy = verified.probes.recovery_gateway?.ok !== false
    && verified.probes.recovery_external_http?.ok !== false;
  const primaryRuntimeHealthy = localVerify.ok;
  const primaryConnectorConfigured = Boolean(config.primaryConnectorService);
  const primaryConnectorLocalFailed = verified.probes.primary_connector_local?.ok === false;
  const primaryConnectorCapacityFailed = connectorCapacityRecoveryRecommended(verified);
  const primaryPublicTransportManaged = Boolean(configuredPrimaryPublicTunnel(config));
  const primaryPublicTransportFailed = Boolean(
    config.publicMcpUrl
    && primaryRuntimeHealthy
    && !primaryConnectorCapacityFailed
    && (
      verified.probes.external_mcp_http?.ok === false
      || verified.probes.primary_connector_ready?.ok === false
    ),
  );
  const primaryConnectorFailed = Boolean(
    primaryConnectorConfigured
    && primaryRuntimeHealthy
    && (
      primaryConnectorLocalFailed
      || primaryConnectorCapacityFailed
      || (primaryPublicTransportManaged && primaryPublicTransportFailed)
    ),
  );
  if (primaryRuntimeHealthy && !primaryConnectorFailed && !primaryPublicTransportFailed && recoveryHealthy) {
    if (fullVerificationPerformed && verified.ok && !matchingKnownGood(config, verified.releases.active)) {
      try {
        const attestation = await withLock(config, { action: 'attest_known_good' }, async () => persistVerifiedKnownGood(config, verified));
        if (!attestation.acquired) {
          audit(config, 'known_good_attestation_deferred', { reason: recoveryBusyDetail(attestation.owner) });
        }
      } catch (error) {
        audit(config, 'known_good_attestation_deferred', {
          reason: error instanceof Error ? error.message : 'watchdog known-good attestation failed',
        });
      }
    }
    const stable = recordWatchdogRuntimeHealthy(
      scopeWatchdogStateToRuntimeRelease(scopedPrior, verified.releases.active),
      now,
      watchdogRuntimeRestartBudgetStableMs(config),
    );
    const state: WatchdogState = {
      ...stable,
      failures: 0,
      firstFailureAt: undefined,
      runtimeRecoveryFailures: 0,
      runtimeRecoveryLastAttemptAt: undefined,
      publicTunnelFailures: 0,
      publicTunnelFirstFailureAt: undefined,
      publicTunnelRepairFailures: 0,
      primaryConnectorFailures: 0,
      primaryConnectorFirstFailureAt: undefined,
      primaryConnectorRestartAttempts: 0,
      primaryConnectorRestartFailures: 0,
      primaryConnectorRestartLastAttemptAt: undefined,
      recoveryGatewayRestartUsed: false,
      lastFullVerifyAt,
      lastDecision: 'healthy',
      lastReason: 'primary runtime and standalone Recovery verification passed',
    };
    return { state, decision: { action: 'healthy', reason: 'primary runtime and standalone Recovery verification passed' }, verify: verified };
  }
  if (primaryRuntimeHealthy && !primaryConnectorFailed && primaryPublicTransportFailed && recoveryHealthy) {
    const reason = primaryPublicTransportManaged
      ? 'primary public transport is unavailable but no safely repairable primary Connector path was established'
      : 'primary public transport is unavailable while the local Connector is healthy, but no managed primary public tunnel is configured; external transport repair is required';
    const state: WatchdogState = {
      ...recordWatchdogRuntimeHealthy(
        scopeWatchdogStateToRuntimeRelease(scopedPrior, verified.releases.active),
        now,
        watchdogRuntimeRestartBudgetStableMs(config),
      ),
      failures: scopedPrior.failures + 1,
      firstFailureAt: scopedPrior.firstFailureAt ?? now,
      primaryConnectorFailures: 0,
      primaryConnectorFirstFailureAt: undefined,
      lastFullVerifyAt,
      lastDecision: 'degraded',
      lastReason: reason,
    };
    return { state, decision: { action: 'degraded', reason }, verify: verified };
  }
  const publicTunnelFailed = isExternalTunnelFailure(config, verified, localVerify);
  const evidenceClasses = Object.entries(localVerify.probes)
    .filter(([name, value]) => !name.startsWith('recovery_') && !value.ok)
    .map(([name]) => name.startsWith('mcp') ? 'mcp' : name.startsWith('active') ? 'gateway' : name);
  if (!localVerify.runtime.ok) evidenceClasses.push('runtime');
  const activeKnownGood = Boolean(matchingKnownGood(config, verified.releases.active));
  const previousKnownGood = Boolean(matchingKnownGood(config, verified.releases.previous));
  const budgetPrior = primaryRuntimeHealthy
    ? recordWatchdogRuntimeHealthy(
      scopeWatchdogStateToRuntimeRelease(scopedPrior, verified.releases.active),
      now,
      watchdogRuntimeRestartBudgetStableMs(config),
    )
    : scopedPrior;
  const state: WatchdogState = publicTunnelFailed
    ? {
      ...budgetPrior,
      lastFullVerifyAt,
      failures: budgetPrior.failures + 1,
      firstFailureAt: budgetPrior.firstFailureAt ?? now,
      publicTunnelFailures: (budgetPrior.publicTunnelFailures ?? 0) + 1,
      publicTunnelFirstFailureAt: budgetPrior.publicTunnelFirstFailureAt ?? now,
      primaryConnectorFailures: 0,
      primaryConnectorFirstFailureAt: undefined,
    }
    : primaryConnectorFailed
      ? {
        ...budgetPrior,
        lastFullVerifyAt,
        failures: budgetPrior.failures + 1,
        firstFailureAt: budgetPrior.firstFailureAt ?? now,
        publicTunnelFailures: 0,
        publicTunnelFirstFailureAt: undefined,
        primaryConnectorFailures: (budgetPrior.primaryConnectorFailures ?? 0) + 1,
        primaryConnectorFirstFailureAt: budgetPrior.primaryConnectorFirstFailureAt ?? now,
      }
      : {
        ...budgetPrior,
        lastFullVerifyAt,
        failures: budgetPrior.failures + 1,
        firstFailureAt: budgetPrior.firstFailureAt ?? now,
        publicTunnelFailures: 0,
        publicTunnelFirstFailureAt: undefined,
        primaryConnectorFailures: 0,
        primaryConnectorFirstFailureAt: undefined,
      };
  if (!localVerify.ok) state.runtimeHealthySince = undefined;
  const primaryConfig = configuredPrimaryRuntimeService(config);
  const decision = decideWatchdog({
    ...state,
    nowMs: now,
    evidenceClasses,
    activeKnownGood,
    previousKnownGood,
    primaryRuntimeFailed: !localVerify.ok,
    runtimeMaximumRestartAttempts: primaryConfig.maximumRestartAttempts,
    runtimeRestartCooldownMs: primaryConfig.restartCooldownMs,
    runtimeMinimumFailures: primaryConfig.minimumFailures,
    runtimeMinimumFailureDurationMs: primaryConfig.minimumFailureDurationMs,
    runtimeRecoveryLastAttemptAt: state.runtimeRecoveryLastAttemptAt,
    runtimeRecoveryCooldownMs: primaryConfig.recoveryCooldownMs,
    recoveryGatewayFailed: verified.probes.recovery_gateway?.ok === false,
    primaryConnectorConfigured,
    primaryConnectorFailed,
    primaryConnectorFailures: state.primaryConnectorFailures,
    primaryConnectorFirstFailureAt: state.primaryConnectorFirstFailureAt,
    primaryConnectorRestartAttempts: state.primaryConnectorRestartAttempts,
    primaryConnectorMaximumRestartAttempts: config.primaryConnectorService?.maximumRestartAttempts,
    primaryConnectorRestartLastAttemptAt: state.primaryConnectorRestartLastAttemptAt,
    primaryConnectorRestartCooldownMs: config.primaryConnectorService?.restartCooldownMs,
    primaryConnectorMinimumFailures: config.primaryConnectorService?.minimumFailures,
    primaryConnectorMinimumFailureDurationMs: config.primaryConnectorService?.minimumFailureDurationMs,
    publicTunnelConfigured: Boolean(configuredRecoveryTunnel(config)),
    publicTunnelFailed,
    publicTunnelMinimumFailures: configuredRecoveryTunnel(config)?.minimumFailures,
    publicTunnelMinimumFailureDurationMs: configuredRecoveryTunnel(config)?.minimumFailureDurationMs,
  });
  state.lastDecision = decision.action;
  state.lastReason = decision.reason;
  if (decision.action === 'repair_public_tunnel') {
    const publicTunnelRepair = await repairPublicTunnel(config);
    const nextState = publicTunnelRepair.ok
      ? { ...state, failures: 0, publicTunnelFailures: 0, publicTunnelRepairFailures: 0, firstFailureAt: undefined, publicTunnelFirstFailureAt: undefined }
      : { ...state, publicTunnelRepairFailures: (state.publicTunnelRepairFailures ?? 0) + 1 };
    return { state: nextState, decision, verify: verified, publicTunnelRepair };
  }
  if (decision.action === 'restart_recovery_gateway') {
    const recoveryGatewayRestart = await restartRecoveryGateway(config);
    return { state: { ...state, recoveryGatewayRestartUsed: true }, decision, verify: verified, recoveryGatewayRestart };
  }
  if (decision.action === 'restart_primary_connector') {
    const primaryConnectorRestart = await restartPrimaryConnector(config, {
      requestId: `watchdog:restart_primary_connector:${now}`,
    });
    const attempts = (state.primaryConnectorRestartAttempts ?? 0) + (primaryConnectorRestart.attempted ? 1 : 0);
    const nextState: WatchdogState = primaryConnectorRestart.ok
      ? {
        ...state,
        failures: 0,
        firstFailureAt: undefined,
        primaryConnectorFailures: 0,
        primaryConnectorFirstFailureAt: undefined,
        primaryConnectorRestartAttempts: 0,
        primaryConnectorRestartFailures: 0,
        primaryConnectorRestartLastAttemptAt: now,
      }
      : {
        ...state,
        primaryConnectorRestartAttempts: attempts,
        primaryConnectorRestartFailures: (state.primaryConnectorRestartFailures ?? 0) + (primaryConnectorRestart.attempted ? 1 : 0),
        primaryConnectorRestartLastAttemptAt: now,
      };
    return { state: nextState, decision, verify: verified, primaryConnectorRestart };
  }
  if (decision.action === 'restart_primary_runtime') {
    const primaryRuntimeRestart = await restartPrimaryRuntime(config);
    const attempts = (state.runtimeRestartAttempts ?? 0) + (primaryRuntimeRestart.attempted ? 1 : 0);
    const nextState: WatchdogState = primaryRuntimeRestart.ok
      ? {
        ...state,
        failures: 0,
        firstFailureAt: undefined,
        runtimeRestartAttempts: attempts,
        runtimeRestartFailures: state.runtimeRestartFailures ?? 0,
        runtimeRestartLastAttemptAt: now,
        runtimeHealthySince: undefined,
      }
      : {
        ...state,
        runtimeRestartAttempts: attempts,
        runtimeRestartFailures: (state.runtimeRestartFailures ?? 0) + 1,
        runtimeRestartLastAttemptAt: now,
      };
    return { state: nextState, decision, verify: verified, primaryRuntimeRestart };
  }
  if (decision.action === 'rollback') {
    const primaryRuntimeRecovery = await recoverPrimaryRuntime(config, 'watchdog exhausted bounded primary Runtime restarts with sustained multi-signal failure');
    const rollbackCommitted = primaryRuntimeRecovery.rollback?.ok === true && primaryRuntimeRecovery.rollback.noOp !== true;
    return {
      state: {
        ...state,
        rollbackUsed: state.rollbackUsed || rollbackCommitted,
        runtimeRestartAttempts: rollbackCommitted ? 0 : state.runtimeRestartAttempts,
        runtimeRestartFailures: rollbackCommitted ? 0 : state.runtimeRestartFailures,
        runtimeRestartLastAttemptAt: rollbackCommitted ? undefined : state.runtimeRestartLastAttemptAt,
        runtimeRecoveryFailures: primaryRuntimeRecovery.ok ? 0 : (state.runtimeRecoveryFailures ?? 0) + 1,
        runtimeRecoveryLastAttemptAt: now,
      },
      decision,
      verify: verified,
      primaryRuntimeRecovery,
      ...(primaryRuntimeRecovery.rollback ? { rollback: primaryRuntimeRecovery.rollback } : {}),
    };
  }
  if (decision.action === 'recovery_exhausted') {
    if (state.runtimeRestartBudgetExhaustedAt === undefined) {
      audit(config, 'primary_runtime_restart_budget_exhausted', {
        runtimeRestartBudgetIdentity: state.runtimeRestartBudgetIdentity,
        attempts: state.runtimeRestartAttempts ?? 0,
        maximumRestartAttempts: primaryConfig.maximumRestartAttempts ?? 3,
        activeKnownGood,
        previousKnownGood,
        evidenceClasses,
      });
    }
    return {
      state: { ...state, runtimeRestartBudgetExhaustedAt: state.runtimeRestartBudgetExhaustedAt ?? now },
      decision,
      verify: verified,
    };
  }
  return { state, decision, verify: verified };
}
