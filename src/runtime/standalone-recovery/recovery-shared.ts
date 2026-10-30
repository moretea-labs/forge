import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir, hostname } from 'os';
import { delimiter, dirname, join, resolve } from 'path';
import { assertStorageHeadroom } from '../shared/storage-capacity';
import { runtimeAuthorityFreeEnvironment } from '../shared/process-environment';
import { forgeRuntimeServicePaths } from '../root/service';
import { readRuntimeReleaseAuthority } from '../root/release-store';
import { readCurrentRecoveryRelease, type RecoveryRuntimeRole } from './release';
import { recoveryOperationLockPath, type RecoveryOperationLockRecord } from './operation-lock';
import { RECOVERY_MUTATION_IDENTITY_FIELDS, type RecoveryMutationIdentityArguments } from './mutation-identity-contract';
import type { RuntimeReleaseExecutionCanaryDependencies, StagedRuntimeRelease } from '../root/release-materialize';
import type { RuntimePerformanceEvidence } from './performance';
import type { KnownGoodRecoveryBundle } from '../root/known-good-recovery';
import type { OpenAiSecureTunnelRuntimeObservation } from '../../../adapters/mcp/tunnels/openai-secure-tunnel';
import type { ReleaseSession } from '../release/release-session';

/**
 * Shared low-level Recovery state/config/command helpers extracted from core.ts
 * (audit round 5, pure move). core.ts remains the facade; these helpers have no
 * imports back into core.ts at runtime (type-only edges are compile-time only).
 */

export interface PublicTunnelRecoveryPolicy {
  minimumFailures?: number;
  minimumFailureDurationMs?: number;
  cooldownMs?: number;
  postRestartVerifyTimeoutMs?: number;
}

export interface LaunchdPublicTunnelServiceConfig extends PublicTunnelRecoveryPolicy {
  platform: 'launchd';
  label: string;
  plistPath?: string;
}

export interface OpenAiSecureTunnelServiceConfig extends PublicTunnelRecoveryPolicy {
  platform: 'openai-secure-tunnel';
  /** Stable tunnel-client runtime identity. Recovery must not repoint another alias. */
  alias: string;
  /** Non-secret OpenAI tunnel identity. */
  tunnelId: string;
  /** Loopback MCP endpoint owned by the local service behind this tunnel. */
  mcpServerUrl: string;
  /** Secret reference only (env:NAME or file:/absolute/path). Recovery never reads the secret. */
  runtimeApiKeyRef?: string;
  profile?: string;
  profileDir?: string;
  adminProfile?: string;
}

export type PublicTunnelServiceConfig = LaunchdPublicTunnelServiceConfig | OpenAiSecureTunnelServiceConfig;

export interface SystemdUserRecoveryTunnelServiceConfig extends PublicTunnelRecoveryPolicy {
  platform: 'systemd-user';
  /** Exact systemd --user unit owned by the dedicated Recovery public tunnel. */
  unitName: string;
}

export type RecoveryTunnelServiceConfig = PublicTunnelServiceConfig | SystemdUserRecoveryTunnelServiceConfig;

export interface PrimaryRuntimeServiceConfig {
  platform: 'launchd' | 'systemd-user';
  minimumFailures?: number;
  minimumFailureDurationMs?: number;
  restartCooldownMs?: number;
  maximumRestartAttempts?: number;
  /** Continuous healthy time required before the same release earns a fresh restart budget. */
  restartBudgetStableDurationMs?: number;
  recoveryCooldownMs?: number;
  postRestartVerifyTimeoutMs?: number;
}

export interface PrimaryConnectorRecoveryPolicy {
  /** Local OAuth MCP endpoint used to distinguish Connector failure from tunnel failure. */
  localMcpUrl?: string;
  minimumFailures?: number;
  minimumFailureDurationMs?: number;
  restartCooldownMs?: number;
  maximumRestartAttempts?: number;
  postRestartVerifyTimeoutMs?: number;
}

export interface LaunchdPrimaryConnectorServiceConfig extends PrimaryConnectorRecoveryPolicy {
  platform: 'launchd';
  label: string;
  plistPath?: string;
}

export interface SystemdPrimaryConnectorServiceConfig extends PrimaryConnectorRecoveryPolicy {
  platform: 'systemd-user';
  /** Optional assertion. When present it must equal the package Connector label derived from Controller Home. */
  label?: string;
}

export type PrimaryConnectorServiceConfig = LaunchdPrimaryConnectorServiceConfig | SystemdPrimaryConnectorServiceConfig;

export type RecoveryInstallProfile = 'manual' | 'gateway' | 'self-healing';

export function normalizeRecoveryInstallProfile(value: unknown, fallback: RecoveryInstallProfile = 'self-healing'): RecoveryInstallProfile {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === 'manual' || value === 'gateway' || value === 'self-healing') return value;
  throw new Error(`RECOVERY_INSTALL_PROFILE_INVALID: ${String(value)}`);
}

export function recoveryInstallProfileRoles(profile: RecoveryInstallProfile): RecoveryRuntimeRole[] {
  if (profile === 'manual') return [];
  return ['daemon'];
}

export interface RecoveryConfig {
  schemaVersion: 1;
  controllerHome: string;
  /** Persistent Recovery role selection. Legacy configs default to self-healing. */
  installProfile: RecoveryInstallProfile;
  publicMcpUrl?: string;
  recoveryPublicUrl?: string;
  recoveryTunnelService?: RecoveryTunnelServiceConfig;
  /** Optional public tunnel serving publicMcpUrl; independent from the OAuth Connector process. */
  primaryPublicTunnelService?: PublicTunnelServiceConfig;
  primaryRuntimeService?: PrimaryRuntimeServiceConfig;
  primaryRuntimeSourceRoot?: string;
  /** Repository Registry authority paired with primaryRuntimeSourceRoot. */
  primaryRuntimeSourceRepositoryId?: string;
  primaryConnectorService?: PrimaryConnectorServiceConfig;
  mainMcpTokenFile?: string;
  expectedToolFingerprint?: string;
  readOnlyTool?: { name: string; arguments?: Record<string, unknown> };
  gateway?: { host: string; port: number; bearerTokenFile: string };
}

export interface RecoveryMachineIdentity {
  schemaVersion: 1;
  host: string;
  platform: NodeJS.Platform;
  controllerHome: string;
  recovery: {
    releaseRevision?: string;
    manifestSha256?: string;
  };
  targetRuntime: {
    id: string;
    servicePlatform: 'launchd' | 'systemd-user';
    serviceLabel: string;
    activeReleaseId?: string;
    authorityRevision?: number;
  };
}

export function recoveryMutationIdentityExpectations(identity: Pick<RecoveryMachineIdentity, 'host' | 'platform' | 'controllerHome' | 'recovery' | 'targetRuntime'>): RecoveryMutationIdentityArguments {
  return {
    expected_host: identity.host,
    expected_platform: identity.platform,
    expected_controller_home: identity.controllerHome,
    expected_recovery_release: identity.recovery.releaseRevision ?? 'none',
    expected_target_runtime: identity.targetRuntime.id,
  };
}

export function assertRecoveryMutationIdentity(config: RecoveryConfig, args: Record<string, unknown>): RecoveryMachineIdentity {
  const identity = recoveryMachineIdentity(config);
  const expected = recoveryMutationIdentityExpectations(identity);
  for (const field of RECOVERY_MUTATION_IDENTITY_FIELDS) {
    const supplied = typeof args[field] === 'string' ? args[field].trim() : '';
    if (!supplied) throw new Error(`RECOVERY_TARGET_IDENTITY_REQUIRED:${field}`);
    if (supplied !== expected[field]) throw new Error(`RECOVERY_TARGET_IDENTITY_MISMATCH:${field}`);
  }
  return identity;
}

export interface ReleaseEvidence {
  path: string;
  revision: string;
  artifactIdentity: string;
  manifestSha256: string;
  workerProtocolVersion: number;
  controllerHome?: string;
  sourceRepositoryId?: string;
  releaseAuthorityRevision?: number;
  releaseFencingTokenSha256?: string;
  attestedAt?: string;
  pinnedAt?: string;
  performance?: RuntimePerformanceEvidence;
  recoveryBundle?: KnownGoodRecoveryBundle;
}

export interface KnownGoodStore {
  schemaVersion: 1 | 2;
  releases: ReleaseEvidence[];
  updatedAt: string;
}

export interface RuntimePinStore {
  schemaVersion: 1;
  release: ReleaseEvidence;
  updatedAt: string;
}

export type RecoveryMutationAction =
  | 'attest_known_good'
  | 'rollback_previous'
  | 'restart_primary_runtime'
  | 'recover_primary_runtime'
  | 'activate_runtime_release'
  | 'pin_runtime_release'
  | 'unpin_runtime_release'
  | 'activate_pinned_runtime_release'
  | 'release_session_prepare'
  | 'release_session_candidate_boot'
  | 'release_session_cutover'
  | 'release_session_cancel'
  | 'release_session_rollback'
  | 'release_session_known_good'
  | 'restart_primary_connector'
  | 'restart_recovery_gateway'
  | 'repair_public_tunnel';

export type RecoveryLock = RecoveryOperationLockRecord;

export interface RecoveryLockIntent {
  action: RecoveryMutationAction;
  requestId?: string;
}

export type RecoveryLockAttempt<T> =
  | { acquired: true; value: T }
  | { acquired: false; owner: RecoveryLock };

export interface VerifyResult {
  ok: boolean;
  at: string;
  runtime: { ok: boolean; running: boolean; ready: boolean; stale: boolean; reasonCodes: string[] };
  releases: { active?: ReleaseEvidence; previous?: ReleaseEvidence; knownGood?: ReleaseEvidence; coherent: boolean };
  probes: Record<string, { ok: boolean; detail: string; status?: number; value?: unknown }>;
}

export interface VerifyStableRuntimeOptions extends RuntimeReleaseExecutionCanaryDependencies {
  probeMcpProtocol?: boolean;
}

/**
 * Remote tunnel control-plane lookup is weaker evidence than the live data plane.
 * Once the configured tunnel is locally healthy/ready with matching identities and
 * the public MCP protocol succeeds end-to-end, a degraded/unknown control-plane
 * lookup remains diagnostic instead of vetoing whole-Runtime verification.
 * Any local health, readiness, identity, endpoint, or MCP failure still gates.
 */
export function isPrimaryTunnelControlPlaneOnlyDegradation(
  probe: VerifyResult['probes'][string] | undefined,
  mcpProtocolHealthy: boolean,
): boolean {
  if (!mcpProtocolHealthy || !probe || probe.ok) return false;
  const observed = probe.value as Partial<OpenAiSecureTunnelRuntimeObservation> | undefined;
  return observed?.healthy === true
    && observed.ready === true
    && observed.tunnelMatches === true
    && observed.endpointMatches === true
    && (observed.controlPlaneState === 'degraded' || observed.controlPlaneState === 'unknown');
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

export interface RecoveryWatchdogDiagnosticStore {
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
  releaseSession?: ReleaseSession;
  /** Legacy/home-bound recovery activation only. Fresh portable source candidates never set this during preparation. */
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
export function recoveryMachineIdentity(
  config: RecoveryConfig,
  dependencies: { host?: string; platform?: NodeJS.Platform } = {},
): RecoveryMachineIdentity {
  const controllerHome = resolve(config.controllerHome);
  const platform = dependencies.platform ?? process.platform;
  const host = dependencies.host?.trim() || hostname();
  const recoveryRelease = readCurrentRecoveryRelease(controllerHome);
  const runtimeAuthority = readRuntimeReleaseAuthority(controllerHome);
  const servicePlatform = (config.primaryRuntimeService ?? defaultPrimaryRuntimeServiceConfig(platform)).platform;
  const serviceLabel = forgeRuntimeServicePaths(controllerHome).label;
  const activeReleaseId = runtimeAuthority?.active.releaseId;
  return {
    schemaVersion: 1,
    host,
    platform,
    controllerHome,
    recovery: {
      ...(recoveryRelease ? { releaseRevision: recoveryRelease.releaseRevision, manifestSha256: recoveryRelease.manifestSha256 } : {}),
    },
    targetRuntime: {
      id: `${servicePlatform}:${serviceLabel}:${activeReleaseId ?? 'none'}`,
      servicePlatform,
      serviceLabel,
      ...(activeReleaseId ? { activeReleaseId } : {}),
      ...(runtimeAuthority ? { authorityRevision: runtimeAuthority.revision } : {}),
    },
  };
}

// This must be a bounded, stable tool that succeeds before a repository has
// been selected. rh_status is repository-scoped in multi-repository homes, so
// it can report REPOSITORY_AMBIGUOUS even when the Runtime is healthy.
export const STABLE_RECOVERY_READ_ONLY_TOOL = { name: 'repository_list', arguments: {} } as const;
const RETIRED_RECOVERY_READ_ONLY_TOOLS = new Set(['controller_context', 'controller_ready']);

export function normalizeRecoveryReadOnlyTool(
  input: RecoveryConfig['readOnlyTool'] | undefined,
): NonNullable<RecoveryConfig['readOnlyTool']> {
  if (!input || RETIRED_RECOVERY_READ_ONLY_TOOLS.has(input.name)) {
    return { name: STABLE_RECOVERY_READ_ONLY_TOOL.name, arguments: { ...STABLE_RECOVERY_READ_ONLY_TOOL.arguments } };
  }
  return input;
}

export function defaultPrimaryRuntimeServiceConfig(platform: NodeJS.Platform = process.platform): PrimaryRuntimeServiceConfig {
  return { platform: platform === 'linux' ? 'systemd-user' : 'launchd' };
}
export function json<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; }
}

export function writeJson(path: string, value: unknown): void {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  assertStorageHeadroom(path, {
    operation: 'standalone_recovery_state_write',
    requiredBytes: Buffer.byteLength(content),
    reserveBytes: 16 * 1024 * 1024,
  });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch { /* best effort */ }
  renameSync(temporary, path);
}

export function recoveryRoot(config: RecoveryConfig): string { return join(resolve(config.controllerHome), 'recovery'); }
export function statePath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'state', 'known-good.json'); }
export function runtimePinPath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'state', 'runtime-pin.json'); }
export function lockPath(config: RecoveryConfig): string { return recoveryOperationLockPath(config.controllerHome); }
export function auditPath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'audit', 'recovery.jsonl'); }
export function watchdogDiagnosticPath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'state', 'watchdog-diagnostics.json'); }
export function quarantinePath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'state', 'quarantine.json'); }
export function publicTunnelRepairStatePath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'state', 'public-tunnel-repair.json'); }
export function watchdogStatePath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'state', 'watchdog.json'); }
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

export function configuredRecoveryTunnel(config: RecoveryConfig): RecoveryTunnelServiceConfig | undefined {
  return config.recoveryTunnelService;
}

export function configuredPrimaryPublicTunnel(config: RecoveryConfig): PublicTunnelServiceConfig | undefined {
  return config.primaryPublicTunnelService;
}
export function audit(config: RecoveryConfig, event: string, detail: Record<string, unknown>): void {
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
  if (name === 'recovery_external_http' || name === 'recovery_tunnel_runtime') return 'recovery_tunnel';
  return 'public_mcp';
}

export function persistWatchdogDiagnosticEvidence(config: RecoveryConfig, result: VerifyResult): RecoveryWatchdogDiagnosticEvidence | undefined {
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
export interface CommandResult { ok: boolean; status: number | null; stdout: string; stderr: string; }
export interface CommandOptions { cwd?: string; home?: string; maxOutputBytes?: number; }
export type CommandRunner = (commandName: string, args: string[], timeoutMs?: number, options?: CommandOptions) => Promise<CommandResult>;
/**
 * systemd --user does not necessarily inherit the interactive shell PATH.
 * Recovery owns tunnel repair, so its non-interactive command environment must
 * still find user-installed runtime tools without adding a second service
 * owner or accepting an executable path through RPC.
 */
export function recoveryCommandPath(
  inheritedPath = process.env.PATH ?? '',
  platform: NodeJS.Platform = process.platform,
  accountHome = homedir(),
): string {
  if (platform === 'win32') return inheritedPath;
  const userBin = join(accountHome, '.local', 'bin');
  const entries = inheritedPath.split(delimiter).filter(Boolean);
  return entries.includes(userBin) ? inheritedPath : [userBin, ...entries].join(delimiter);
}
/**
 * Child environment for Recovery-owned commands.
 *
 * Keep the hosting Runtime's private FORGE_* authority out, but preserve the
 * account context: user-installed tools resolve their own per-account state from
 * HOME, and a persistent launchd/systemd service starts without an interactive
 * HOME to inherit. Without it, `tunnel-client` cannot see its own alias registry,
 * so Recovery both misreads a healthy dedicated tunnel as stopped and cannot
 * confirm the tunnel it just reconnected.
 */
export function recoveryCommandEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  accountHome = homedir(),
): NodeJS.ProcessEnv {
  const home = env.HOME?.trim() || accountHome;
  return {
    ...runtimeAuthorityFreeEnvironment(env),
    PATH: recoveryCommandPath(env.PATH ?? '', process.platform, home),
    HOME: home,
  };
}
export function command(commandName: string, args: string[], timeoutMs = 10_000, options: CommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolveCommand) => {
    const child = spawn(commandName, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: options.cwd,
      env: recoveryCommandEnvironment(process.env, options.home),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
    let settled = false;
    let stopping = false;
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
    const stop = (detail: string) => {
      if (child.exitCode != null || stopping) return;
      stopping = true;
      signalChild('SIGTERM');
      killTimer = setTimeout(() => {
        signalChild('SIGKILL');
        finish({
          ok: false,
          status: null,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: [Buffer.concat(stderr).toString('utf8').trim(), detail].filter(Boolean).join('\n'),
        });
      }, 1_000);
    };
    const timeout = setTimeout(() => stop(`command timed out after ${timeoutMs}ms`), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxOutputBytes) stdout.push(Buffer.from(chunk)); else stop(`command output exceeded ${maxOutputBytes} bytes`);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxOutputBytes) stderr.push(Buffer.from(chunk)); else stop(`command output exceeded ${maxOutputBytes} bytes`);
    });
    child.once('error', () => finish({ ok: false, status: null, stdout: '', stderr: 'command spawn failed' }));
    child.once('close', (status) => finish({ ok: status === 0, status, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}
