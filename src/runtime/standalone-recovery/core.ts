import { assertRuntimePerformanceEvidence, measureRuntimePerformance, samePerformanceIdentity, type RuntimePerformanceDependencies, type RuntimePerformanceEvidence, type RuntimePerformanceIdentity } from './performance';
import { runBoundedChild } from '../shared/bounded-child-supervisor';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir, hostname } from 'os';
import { createServer as createNetServer } from 'net';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'path';
import { assertStorageHeadroom, STORAGE_WARNING_BYTES } from '../shared/storage-capacity';
import { resolveBunExecutable, runtimeAuthorityFreeEnvironment } from '../shared/process-environment';
import { backupControlPlaneDatabase } from '../control-plane/persistence/sqlite-store';
import { observeRuntimeStatus, readRuntimeStartupFailureEvidence } from '../root/status';
import { reconcileStoppedRuntimeOwnership, terminateVerifiedRuntimeOwner } from '../root/ownership';
import {
  activeRuntimeEntrypoint,
  activeRuntimeLaunchSpec,
  ensureForgeRuntimeLaunchAgentContract,
  forgeRuntimeServicePaths,
  inspectForgeRuntimeLaunchAgentContract,
  installForgeRuntimeService,
  readForgeRuntimeServiceConfig,
  syncForgeRuntimeActiveEntrypoint,
  uninstallForgeRuntimeService,
} from '../root/service';
import { removeRetiredCandidateExecutionLane } from '../root/runtime-lane';
import {
  inspectKnownGoodRecoveryBundle,
  knownGoodRecoveryBundleRoot,
  sha256FileBounded,
  type KnownGoodRecoveryBundle,
} from '../root/known-good-recovery';
import { systemdUserUnitName, systemdUserUnitPath } from '../../cli/controller/systemd-user';
import {
  openAiSecureTunnelConnectArgs,
  openAiSecureTunnelStatusArgs,
  parseOpenAiSecureTunnelRuntimeStatus,
  type OpenAiSecureTunnelRuntimeObservation,
} from '../../../adapters/mcp/tunnels/openai-secure-tunnel';
import {
  renderPackageRuntimeSystemdUserService,
  systemdRuntimeInstallCommands,
  writePackageRuntimeSystemdUserService,
} from '../root/package-runtime-service';
import { loadRuntimeReleaseManifest } from '../root/release-manifest';
import { assertRuntimeReleaseExecutionCanaries, assertRuntimeReleaseFiles, promotePortableRuntimeRelease, runtimeReleaseTreeSha256, stageRuntimeReleaseFromCandidateSource, withRuntimeReleaseSourceSnapshot, type RuntimeReleaseExecutionCanaryDependencies, type StagedRuntimeRelease } from '../root/release-materialize';
import {
  publishRuntimeRelease,
  readRuntimeReleaseAuthority,
  rollbackRuntimeReleaseWithResult,
  type RuntimeDatabaseRollbackDisposition,
  type RuntimePublishedRelease,
  type RuntimeReleaseAuthority,
} from '../root/release-store';
import type { RuntimeReleaseManifest } from '../root/types';
import { ensurePackageConnectorService, packageConnectorAuthMode, packageConnectorServicePaths, type PackageConnectorReleaseBinding } from '../root/package-connector-service';
import { createRecoveryHttpTransport, type RecoveryHttpTransport } from './http-transport';
import { observeRecoveryWatchdogHealth } from './watchdog-heartbeat';
import { RECOVERY_DAEMON_LABEL } from './service-labels';
import { resolveWorkflowSupervisorForgeHome, workflowSupervisorSocketPath } from '../../../supervisor/paths';
import { reconcileStoppedWorkflowSupervisorSocket } from '../../../supervisor/server';
import {
  migrateStoppedRepoLocalControllerHomeStorage,
  repoLocalControllerHomeStorageNeedsMigration,
  rollbackStoppedRepoLocalControllerHomeStorage,
  type ControllerHomeStorageMigration,
} from '../../cli/repositories/controller-home';
import { readCurrentRecoveryRelease, type RecoveryRuntimeRole } from './release';
import { recoveryOperationLockPath } from './operation-lock';
import { RECOVERY_MUTATION_IDENTITY_FIELDS, type RecoveryMutationIdentityArguments } from './mutation-identity-contract';
import { createCandidateExecutionLane, readStableExecutionLane } from '../root/runtime-lane';
import {
  advanceReleaseSession,
  createReleaseSession,
  listReleaseSessions,
  readReleaseSession,
  recordReleaseSessionTransaction,
  type ReleaseSession,
  type ReleaseSessionCandidateRelease,
  type ReleaseSessionStableRelease,
} from '../release/release-session';

/** Standalone recovery reads only canonical Runtime observation and whole-release authority. */
interface PublicTunnelRecoveryPolicy {
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

interface PrimaryConnectorRecoveryPolicy {
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

interface ReleaseEvidence {
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

interface KnownGoodStore {
  schemaVersion: 1 | 2;
  releases: ReleaseEvidence[];
  updatedAt: string;
}

interface RuntimePinStore {
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
  | 'stage_and_activate_runtime_release'
  | 'release_session_prepare'
  | 'release_session_static_verify'
  | 'release_session_candidate_boot'
  | 'release_session_cutover'
  | 'release_session_cancel'
  | 'release_session_rollback'
  | 'release_session_known_good'
  | 'restart_primary_connector'
  | 'restart_recovery_gateway'
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

export interface VerifyStableRuntimeOptions extends RuntimeReleaseExecutionCanaryDependencies {
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

export function defaultPrimaryRuntimeServiceConfig(platform: NodeJS.Platform = process.platform): PrimaryRuntimeServiceConfig {
  return { platform: platform === 'linux' ? 'systemd-user' : 'launchd' };
}

const DEFAULT_CONFIG: Omit<RecoveryConfig, 'controllerHome'> = {
  schemaVersion: 1,
  installProfile: 'self-healing',
  readOnlyTool: { name: STABLE_RECOVERY_READ_ONLY_TOOL.name, arguments: { ...STABLE_RECOVERY_READ_ONLY_TOOL.arguments } },
  primaryRuntimeService: defaultPrimaryRuntimeServiceConfig(),
};

function json<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; }
}

function writeJson(path: string, value: unknown): void {
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

function recoveryRoot(config: RecoveryConfig): string { return join(resolve(config.controllerHome), 'recovery'); }
function statePath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'state', 'known-good.json'); }
function runtimePinPath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'state', 'runtime-pin.json'); }
function lockPath(config: RecoveryConfig): string { return recoveryOperationLockPath(config.controllerHome); }
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

function configuredRecoveryTunnel(config: RecoveryConfig): RecoveryTunnelServiceConfig | undefined {
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
    installProfile: normalizeRecoveryInstallProfile(loaded.installProfile, 'self-healing'),
    ...(typeof loaded.publicMcpUrl === 'string' ? { publicMcpUrl: loaded.publicMcpUrl } : {}),
    ...(typeof loaded.recoveryPublicUrl === 'string' ? { recoveryPublicUrl: loaded.recoveryPublicUrl } : {}),
    ...(loaded.recoveryTunnelService ? { recoveryTunnelService: loaded.recoveryTunnelService } : {}),
    ...(loaded.primaryPublicTunnelService ? { primaryPublicTunnelService: loaded.primaryPublicTunnelService } : {}),
    ...(loaded.primaryRuntimeService ? { primaryRuntimeService: loaded.primaryRuntimeService } : {}),
    ...(typeof loaded.primaryRuntimeSourceRoot === 'string' ? { primaryRuntimeSourceRoot: resolve(loaded.primaryRuntimeSourceRoot) } : {}),
    ...(typeof loaded.primaryRuntimeSourceRepositoryId === 'string' && loaded.primaryRuntimeSourceRepositoryId.trim() ? { primaryRuntimeSourceRepositoryId: loaded.primaryRuntimeSourceRepositoryId.trim() } : {}),
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

function sameReleaseIdentity(left: ReleaseEvidence, right: ReleaseEvidence): boolean {
  return left.path === right.path
    && left.revision === right.revision
    && left.artifactIdentity === right.artifactIdentity
    && left.manifestSha256 === right.manifestSha256
    && left.workerProtocolVersion === right.workerProtocolVersion;
}

function knownGoodAttestationEvidence(config: RecoveryConfig, entry: ReleaseEvidence | undefined): ReleaseEvidence | undefined {
  if (!entry || !entry.attestedAt || !entry.releaseFencingTokenSha256 || typeof entry.controllerHome !== 'string') return undefined;
  // Legacy metadata-only attestations are audit history, not recoverable authority.
  // The cheap tier requires durable bundle identity but never reads bundle contents.
  if (!entry.recoveryBundle || entry.recoveryBundle.schemaVersion !== 1) return undefined;
  if (resolve(entry.controllerHome) !== resolve(config.controllerHome)) return undefined;
  const authority = releaseAuthority(config);
  const candidates = [
    releaseEvidence(config.controllerHome, authority?.active, authority),
    releaseEvidence(config.controllerHome, authority?.previous, authority),
  ].filter((item): item is ReleaseEvidence => Boolean(item));
  return candidates.some((release) => sameReleaseIdentity(release, entry)) ? entry : undefined;
}

function knownGoodEvidence(config: RecoveryConfig, entry: ReleaseEvidence | undefined): ReleaseEvidence | undefined {
  const attested = knownGoodAttestationEvidence(config, entry);
  if (!attested) return undefined;
  try { inspectKnownGoodRecoveryBundle(config.controllerHome, attested); }
  catch { return undefined; }
  return attested;
}

function knownGood(config: RecoveryConfig): KnownGoodStore {
  return json<KnownGoodStore>(statePath(config)) ?? { schemaVersion: 1, releases: [], updatedAt: new Date(0).toISOString() };
}

function inspectKnownGoodRecoverability(config: RecoveryConfig): {
  available: ReleaseEvidence[];
  unavailable: Array<{ revision: string; path: string; reason: string }>;
} {
  const available: ReleaseEvidence[] = [];
  const unavailable: Array<{ revision: string; path: string; reason: string }> = [];
  const store = knownGood(config);
  // Pre-bundle records remain audit history only. They are deliberately
  // neither usable Recovery authority nor a readiness failure for an
  // otherwise healthy Runtime, because no action can make them restorable.
  if (store.schemaVersion !== 2) return { available, unavailable };
  const releasesRoot = resolve(config.controllerHome, 'runtime', 'releases');
  for (const entry of store.releases) {
    try {
      const inspected = inspectKnownGoodRecoveryBundle(config.controllerHome, entry);
      if (dirname(inspected.releaseRoot) !== releasesRoot) throw new Error('known-good path is outside Runtime release authority');
      available.push(entry);
    } catch (error) {
      unavailable.push({
        revision: entry.revision,
        path: entry.path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { available, unavailable };
}

function matchingKnownGoodAttestation(config: RecoveryConfig, release: ReleaseEvidence | undefined): ReleaseEvidence | undefined {
  if (!release) return undefined;
  return knownGoodAttestationEvidence(config, knownGood(config).releases.find((entry) => sameReleaseIdentity(entry, release)));
}

function matchingKnownGood(config: RecoveryConfig, release: ReleaseEvidence | undefined): ReleaseEvidence | undefined {
  if (!release) return undefined;
  return knownGoodEvidence(config, knownGood(config).releases.find((entry) => sameReleaseIdentity(entry, release)));
}

function sameReleaseEvidenceIdentity(left: ReleaseEvidence | undefined, right: ReleaseEvidence | undefined): boolean {
  return Boolean(
    left
    && right
    && left.path === right.path
    && left.revision === right.revision
    && left.artifactIdentity === right.artifactIdentity
    && left.manifestSha256 === right.manifestSha256
    && left.workerProtocolVersion === right.workerProtocolVersion,
  );
}

function liveRuntimeOwnsRelease(config: RecoveryConfig, release: ReleaseEvidence): boolean {
  const active = activeAuthorityRelease(config);
  const observed = observeRuntimeStatus(config.controllerHome);
  const snapshot = observed.snapshot;
  return Boolean(
    sameReleaseEvidenceIdentity(active, release)
    && observed.running
    && observed.ready
    && !observed.stale
    && snapshot
    && snapshot.releaseId === release.revision
    && snapshot.artifactIdentity === release.artifactIdentity,
  );
}

function runtimePin(config: RecoveryConfig): RuntimePinStore | undefined {
  const path = runtimePinPath(config);
  if (!existsSync(path)) return undefined;
  let parsed: RuntimePinStore;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) as RuntimePinStore; }
  catch (error) { throw new Error(`RUNTIME_PIN_AUTHORITY_INVALID: ${error instanceof Error ? error.message : String(error)}`); }
  const release = parsed?.release;
  if (parsed?.schemaVersion !== 1 || !release || !release.revision?.trim() || !release.path?.trim() || !release.artifactIdentity?.trim() || !release.manifestSha256?.trim() || !Number.isInteger(release.workerProtocolVersion)) {
    throw new Error('RUNTIME_PIN_AUTHORITY_INVALID');
  }
  const releasesRoot = resolve(config.controllerHome, 'runtime', 'releases');
  const manifestPath = resolve(release.path);
  const releaseRoot = dirname(manifestPath);
  if (basename(manifestPath) !== 'manifest.json' || basename(releaseRoot) !== release.revision || dirname(releaseRoot) !== releasesRoot) {
    throw new Error('RUNTIME_PIN_AUTHORITY_PATH_INVALID');
  }
  return parsed;
}

function releaseEvidenceForPin(
  config: RecoveryConfig,
  candidate: { manifest: RuntimeReleaseManifest; manifestPath: string },
): ReleaseEvidence {
  const releasesRoot = resolve(config.controllerHome, 'runtime', 'releases');
  const releaseRoot = dirname(resolve(candidate.manifestPath));
  if (!existsSync(releasesRoot) || dirname(realpathSync(releaseRoot)) !== realpathSync(releasesRoot)) {
    throw new Error('RUNTIME_PIN_RELEASE_OUTSIDE_CONTROLLER_RUNTIME_ROOT');
  }
  const expectedRepositoryId = config.primaryRuntimeSourceRepositoryId?.trim();
  if (expectedRepositoryId && candidate.manifest.sourceRepositoryId !== expectedRepositoryId) {
    throw new Error(`RUNTIME_PIN_SOURCE_REPOSITORY_MISMATCH: expected ${expectedRepositoryId}, got ${candidate.manifest.sourceRepositoryId ?? 'missing'}`);
  }
  return {
    path: candidate.manifestPath,
    revision: candidate.manifest.releaseId,
    artifactIdentity: candidate.manifest.artifactIdentity,
    manifestSha256: createHash('sha256').update(readFileSync(candidate.manifestPath)).digest('hex'),
    workerProtocolVersion: candidate.manifest.workerProtocolVersion,
    controllerHome: resolve(config.controllerHome),
    ...(candidate.manifest.sourceRepositoryId ? { sourceRepositoryId: candidate.manifest.sourceRepositoryId } : {}),
    pinnedAt: new Date().toISOString(),
  };
}

export async function pinRuntimeRelease(config: RecoveryConfig, candidateManifestPath: string, requestId?: string): Promise<Record<string, unknown>> {
  let candidate: { manifest: RuntimeReleaseManifest; releaseRoot: string; manifestPath: string };
  try { candidate = validateRuntimeReleaseCandidate(config, candidateManifestPath); }
  catch (error) { return { ok: false, attempted: false, noOp: true, detail: error instanceof Error ? error.message : String(error) }; }
  if (candidate.manifest.deploymentScope === 'portable') {
    return {
      ok: false,
      attempted: false,
      noOp: true,
      detail: 'RUNTIME_PIN_PORTABLE_RELEASE_FORBIDDEN: portable source candidates require a verified Recovery ReleaseSession',
    };
  }
  let evidence: ReleaseEvidence;
  try { evidence = releaseEvidenceForPin(config, candidate); }
  catch (error) { return { ok: false, attempted: false, noOp: true, detail: error instanceof Error ? error.message : String(error) }; }
  const locked = await withLock(config, { action: 'pin_runtime_release', requestId }, async () => {
    const current = runtimePin(config);
    if (current?.release.revision === evidence.revision && current.release.manifestSha256 === evidence.manifestSha256) {
      return { ok: true, attempted: false, noOp: true, detail: 'requested Runtime release is already pinned', pinned: current.release };
    }
    const store: RuntimePinStore = { schemaVersion: 1, release: evidence, updatedAt: new Date().toISOString() };
    writeJson(runtimePinPath(config), store);
    audit(config, 'runtime_release_pinned', { requestId, revision: evidence.revision, artifactIdentity: evidence.artifactIdentity });
    return { ok: true, attempted: true, detail: 'Runtime release pinned for retention and explicit Runtime-only activation', pinned: evidence };
  });
  return locked.acquired ? locked.value : { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner) };
}

export async function unpinRuntimeRelease(config: RecoveryConfig, requestId?: string): Promise<Record<string, unknown>> {
  const locked = await withLock(config, { action: 'unpin_runtime_release', requestId }, async () => {
    const current = runtimePin(config);
    if (!current) return { ok: true, attempted: false, noOp: true, detail: 'no Runtime release is pinned' };
    rmSync(runtimePinPath(config), { force: true });
    audit(config, 'runtime_release_unpinned', { requestId, revision: current.release.revision, artifactIdentity: current.release.artifactIdentity });
    return { ok: true, attempted: true, detail: 'Runtime release pin removed', unpinned: current.release };
  });
  return locked.acquired ? locked.value : { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner) };
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
  if (name === 'recovery_external_http' || name === 'recovery_tunnel_runtime') return 'recovery_tunnel';
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
  return observed === lock.processStartTime;
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

function liveRecoveryMutationLock(config: RecoveryConfig): RecoveryLock | undefined {
  const owner = json<RecoveryLock>(lockPath(config));
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.instanceId !== 'string' || !owner.instanceId.trim()) return undefined;
  return recoveryLockOwnerAlive(owner) ? owner : undefined;
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
  const identity = recoveryMachineIdentity(config);
  const observation = observeRuntimeStatus(config.controllerHome);
  const watchdog = loadWatchdogState(config);
  return {
    identity,
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

async function probeExternalMcp(
  transport: RecoveryHttpTransport,
  url: string,
  options: { acceptOAuthChallenge?: boolean } = {},
): Promise<{ ok: boolean; detail: string; status?: number }> {
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
    const oauthChallenge = response.status === 401 && /\bBearer\b/i.test(challenge);
    const acceptsOAuthChallenge = options.acceptOAuthChallenge ?? true;
    const ok = response.ok || (acceptsOAuthChallenge && oauthChallenge);
    const detail = oauthChallenge
      ? acceptsOAuthChallenge ? 'HTTP 401 OAuth challenge' : 'HTTP 401 unexpected OAuth challenge for unauthenticated Connector'
      : `HTTP ${response.status}`;
    return { ok, detail, status: response.status };
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
  options: { acceptOAuthChallenge?: boolean } = {},
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
      const legacy = await probeExternalMcp(transport, endpoint, options);
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

function canonicalRuntimeSafeForTargetedConnectorRecovery(verified: VerifyResult): boolean {
  // Targeted Connector/public-transport recovery mutates no Runtime release or
  // Work authority. Use durable Runtime ownership + release/execution evidence
  // as the safety fence; a single failed HTTP gateway/MCP observation is the
  // symptom this action may need to repair and must not deadlock the recovery path.
  return verified.runtime.ok
    && verified.runtime.running
    && verified.runtime.ready
    && !verified.runtime.stale
    && verified.releases.coherent !== false
    && verified.probes.runtime_execution_surface?.ok !== false;
}

function mainToken(config: RecoveryConfig): string | undefined {
  const explicit = config.mainMcpTokenFile?.trim();
  const candidate = explicit || join(config.controllerHome, 'mcp', 'mcp.tokens.json');
  if (explicit) {
    try {
      const raw = readFileSync(candidate, 'utf8').trim();
      if (raw.length >= 24 && !raw.startsWith('{')) return raw;
    } catch {
      return undefined;
    }
  }
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

async function observeOpenAiTunnelRuntime(
  configured: OpenAiSecureTunnelServiceConfig,
  runCommand: CommandRunner = command,
): Promise<OpenAiSecureTunnelRuntimeObservation> {
  let args: string[];
  try {
    args = openAiSecureTunnelStatusArgs(configured.alias, configured);
  } catch (error) {
    return {
      ok: false, running: false, healthy: false, ready: false, tunnelMatches: false, endpointMatches: false,
      alias: configured.alias, tunnelId: configured.tunnelId,
      detail: error instanceof Error ? error.message : 'OpenAI tunnel runtime configuration is invalid',
    };
  }
  const status = await runCommand('tunnel-client', args, 15_000);
  if (!status.stdout.trim()) {
    const local = await observeOpenAiTunnelLocalHealthFallback(configured);
    if (local) return local;
    return {
      ok: false, running: false, healthy: false, ready: false, tunnelMatches: false, endpointMatches: false,
      alias: configured.alias, tunnelId: configured.tunnelId,
      detail: status.stderr.trim() || 'OpenAI tunnel runtime status is unavailable',
    };
  }
  return parseOpenAiSecureTunnelRuntimeStatus(status.stdout, {
    alias: configured.alias, tunnelId: configured.tunnelId, mcpServerUrl: configured.mcpServerUrl,
  });
}

/**
 * tunnel-client's structured status command can itself be delayed by a
 * control-plane query. When that happens, retain a bounded observation of the
 * locally supervised runtime instead of treating a live, identity-matched
 * alias as failed. This reads only the client-owned profile and loopback
 * health URL; it never creates, repoints, or restarts a tunnel.
 */
export async function observeOpenAiTunnelLocalHealthFallback(
  configured: OpenAiSecureTunnelServiceConfig,
  options: {
    request?: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;
  } = {},
): Promise<OpenAiSecureTunnelRuntimeObservation | undefined> {
  if (!configured.profile?.trim() || !configured.profileDir?.trim()) return undefined;
  const profilePath = join(configured.profileDir, `${configured.profile}.yaml`);
  let profile: string;
  try { profile = readFileSync(profilePath, 'utf8'); } catch { return undefined; }
  const identityMatches = profile.includes(configured.tunnelId);
  const endpointMatches = profile.includes(configured.mcpServerUrl);
  const urlFileMatch = profile.match(/["']?url_file["']?\s*:\s*["']([^"']+)["']/i);
  if (!urlFileMatch) return undefined;
  let base: URL;
  try {
    base = new URL(readFileSync(urlFileMatch[1].trim(), 'utf8').trim());
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(base.hostname)) return undefined;
  } catch { return undefined; }
  const request = options.request ?? ((url: string, init: { signal: AbortSignal }) => fetch(url, init));
  const probe = async (pathname: '/healthz' | '/readyz'): Promise<boolean> => {
    const url = new URL(base);
    url.pathname = pathname;
    url.search = '';
    url.hash = '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('RECOVERY_TUNNEL_HEALTH_TIMEOUT'), 4_000);
    try { return (await request(url.toString(), { signal: controller.signal })).ok; } catch { return false; } finally { clearTimeout(timer); }
  };
  const [healthy, ready] = await Promise.all([probe('/healthz'), probe('/readyz')]);
  const ok = healthy && ready && identityMatches && endpointMatches;
  const failures: string[] = [];
  if (!identityMatches) failures.push('profile tunnel id does not match');
  if (!endpointMatches) failures.push('profile MCP endpoint does not match');
  if (!healthy) failures.push('local healthz failed');
  if (!ready) failures.push('local readyz failed');
  return {
    ok,
    running: healthy,
    healthy,
    ready,
    tunnelMatches: identityMatches,
    endpointMatches,
    alias: configured.alias,
    tunnelId: configured.tunnelId,
    ...(identityMatches ? { observedTunnelId: configured.tunnelId } : {}),
    detail: ok
      ? `managed runtime ${configured.alias} is locally healthy and ready for ${configured.tunnelId} (status command unavailable)`
      : failures.join('; ') || 'OpenAI tunnel local health fallback failed',
    profilePath,
  };
}

async function observeOpenAiRecoveryTunnel(
  config: RecoveryConfig,
  runCommand: CommandRunner = command,
): Promise<OpenAiSecureTunnelRuntimeObservation | undefined> {
  const configured = configuredRecoveryTunnel(config);
  if (!configured || configured.platform !== 'openai-secure-tunnel') return undefined;
  return observeOpenAiTunnelRuntime(configured, runCommand);
}

async function ensureOpenAiTunnelRuntimeStarted(
  configured: OpenAiSecureTunnelServiceConfig,
  runCommand: CommandRunner = command,
): Promise<{ ok: boolean; attempted: boolean; noOp?: boolean; detail: string; serviceLabel: string; serviceTarget: string }> {
  const serviceLabel = configured.alias;
  const serviceTarget = `tunnel-client:${configured.alias}`;
  const observed = await observeOpenAiTunnelRuntime(configured, runCommand);
  if (observed.ok) return { ok: true, attempted: false, noOp: true, detail: observed.detail, serviceLabel, serviceTarget };
  if (observed.observedTunnelId && !observed.tunnelMatches) {
    return { ok: false, attempted: false, noOp: true, detail: `OpenAI tunnel alias ${configured.alias} is already bound to a different tunnel id`, serviceLabel, serviceTarget };
  }
  if (observed.profilePath && !observed.endpointMatches) {
    return { ok: false, attempted: false, noOp: true, detail: `OpenAI tunnel alias ${configured.alias} is already bound to a different MCP endpoint`, serviceLabel, serviceTarget };
  }
  let args: string[];
  try {
    args = openAiSecureTunnelConnectArgs({
      alias: configured.alias,
      tunnelId: configured.tunnelId,
      mcpServerUrl: configured.mcpServerUrl,
      runtimeApiKeyRef: configured.runtimeApiKeyRef,
      profile: configured.profile,
      profileDir: configured.profileDir,
      adminProfile: configured.adminProfile,
    });
  } catch (error) {
    return { ok: false, attempted: false, noOp: true, detail: error instanceof Error ? error.message : 'OpenAI tunnel runtime configuration is invalid', serviceLabel, serviceTarget };
  }
  const connected = await runCommand('tunnel-client', args, Math.max(30_000, configured.postRestartVerifyTimeoutMs ?? 20_000));
  return connected.ok
    ? { ok: true, attempted: true, detail: `OpenAI Secure MCP Tunnel runtime ${configured.alias} connect dispatched`, serviceLabel, serviceTarget }
    : { ok: false, attempted: true, detail: `OpenAI Secure MCP Tunnel runtime connect failed: ${connected.stderr || connected.stdout || connected.status}`, serviceLabel, serviceTarget };
}

async function probeOpenAiRecoveryTunnel(
  config: RecoveryConfig,
  runCommand: CommandRunner = command,
): Promise<{ ok: boolean; detail: string; value?: unknown } | undefined> {
  const observed = await observeOpenAiRecoveryTunnel(config, runCommand);
  return observed ? { ok: observed.ok, detail: observed.detail, value: observed } : undefined;
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

function probeRuntimeExecutionSurface(
  config: RecoveryConfig,
  release: ReleaseEvidence | undefined,
  dependencies: RuntimeReleaseExecutionCanaryDependencies = {},
): VerifyResult['probes'][string] {
  if (!release) return { ok: false, detail: 'active immutable Runtime release is unavailable' };
  try {
    const surface = assertRuntimeReleaseExecutionCanaries(release.path, config.controllerHome, dependencies);
    return {
      ok: true,
      detail: 'Process Runtime release entries are manifest-attested, executable, and canary-ready',
      value: { entries: surface.entries.map((entry) => ({ name: entry.name, artifactIdentity: entry.artifactIdentity })) },
    };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
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
  const knownGoodRecoverability = inspectKnownGoodRecoverability(config);
  probes.recovery_known_good_recoverability = {
    ok: knownGoodRecoverability.unavailable.length === 0,
    detail: knownGoodRecoverability.unavailable.length === 0
      ? `${knownGoodRecoverability.available.length} bounded known-good Runtime release(s) are physically recoverable`
      : `${knownGoodRecoverability.unavailable.length} known-good attestation(s) no longer have a matching immutable Runtime release`,
    value: knownGoodRecoverability,
  };
  if (!observation.running || !observation.ready) {
    const startupFailure = readRuntimeStartupFailureEvidence(config.controllerHome);
    if (startupFailure && (!active || !startupFailure.releaseId || startupFailure.releaseId === active.revision)) {
      probes.runtime_startup_failure = {
        ok: false,
        detail: `latest Runtime startup failed during ${startupFailure.stage}: ${startupFailure.reasonCode}${startupFailure.message ? ` — ${startupFailure.message}` : ''}`,
        value: startupFailure,
      };
    }
  }
  const endpoint = observation.snapshot?.endpoint;
  probes.active_gateway = endpoint
    ? await probe(transport, runtimeHealthEndpoint(endpoint))
    : { ok: false, detail: 'canonical Runtime endpoint is unavailable' };
  probes.runtime_execution_surface = probeRuntimeExecutionSurface(config, active, options);
  if (config.publicMcpUrl) {
    probes.external_mcp_http = await probeExternalMcp(transport, config.publicMcpUrl);
    const connectorReadinessEndpoint = config.primaryConnectorService?.localMcpUrl?.trim() || config.publicMcpUrl;
    probes.primary_connector_ready = await probePublicGatewayReadiness(transport, connectorReadinessEndpoint, {
      acceptOAuthChallenge: packageConnectorAuthMode(config.controllerHome) === 'oauth',
    });
  }
  const primaryTunnel = configuredPrimaryPublicTunnel(config);
  if (primaryTunnel?.platform === 'openai-secure-tunnel') {
    const observed = await observeOpenAiTunnelRuntime(primaryTunnel);
    probes.primary_tunnel_runtime = { ok: observed.ok, detail: observed.detail, value: observed };
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
  const recoveryTunnelRuntime = await probeOpenAiRecoveryTunnel(config);
  if (recoveryTunnelRuntime) probes.recovery_tunnel_runtime = recoveryTunnelRuntime;
  if (options.probeMcpProtocol !== false) Object.assign(probes, await probeMcp(config, transport));
  const mcpProtocolProbeNames = ['mcp_initialize', 'mcp_initialized_notification', 'mcp_tools_list', 'mcp_read_only_call', 'mcp_session_close'] as const;
  const mcpProtocolHealthy = options.probeMcpProtocol !== false
    && mcpProtocolProbeNames.every((name) => probes[name]?.ok === true);
  const coreChecks = Object.entries(probes)
    .filter(([name]) => !name.startsWith('recovery_'))
    // The unauthenticated public initialize probe remains diagnostic and is the
    // authority for dedicated external/tunnel verification. Once the stronger
    // authenticated MCP session completes end-to-end, that raw reachability
    // probe cannot independently veto full stable Runtime verification.
    .filter(([name]) => !(name === 'external_mcp_http' && mcpProtocolHealthy))
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
function recoveryBundleId(): string {
  return `attestation-${Date.now()}-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

/**
 * Build a self-contained, Recovery-owned restore point before publishing its
 * attestation.  The copy is intentionally made while the full Runtime is
 * still verified and fenced; a later crash cannot turn a metadata-only record
 * into a false known-good authority.
 */
function createKnownGoodRecoveryBundle(config: RecoveryConfig): KnownGoodRecoveryBundle {
  const attestationId = recoveryBundleId();
  const root = join(knownGoodRecoveryBundleRoot(config.controllerHome), attestationId);
  const databasePath = join(root, 'controller.sqlite');
  const serviceContractPath = join(root, 'service-contract.json');
  try {
    const database = backupControlPlaneDatabase(config.controllerHome, databasePath);
    const servicePaths = forgeRuntimeServicePaths(config.controllerHome);
    const serviceConfig = readForgeRuntimeServiceConfig(servicePaths.configPath);
    const serviceContract = {
      schemaVersion: 1 as const,
      configPath: servicePaths.configPath,
      serviceConfig,
      // The label and fixed executable path are derived, never copied from a
      // mutable launchd plist. Recovery can rebuild that contract from this
      // declarative service configuration plus the immutable release.
      label: servicePaths.label,
      activeEntrypointPath: servicePaths.activeEntrypointPath,
      createdAt: new Date().toISOString(),
    };
    writeJson(serviceContractPath, serviceContract);
    return {
      schemaVersion: 1,
      attestationId,
      root,
      database: {
        path: databasePath,
        sha256: sha256FileBounded(databasePath),
        schemaVersion: database.schemaVersion,
        recordCount: database.recordCount,
        auditEventCount: database.auditEventCount,
      },
      serviceContract: { path: serviceContractPath, sha256: sha256FileBounded(serviceContractPath) },
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function pruneRetiredKnownGoodRecoveryBundles(config: RecoveryConfig, releases: readonly ReleaseEvidence[]): void {
  const root = knownGoodRecoveryBundleRoot(config.controllerHome);
  if (!existsSync(root)) return;
  const retained = new Set(releases.flatMap((release) => release.recoveryBundle ? [resolve(release.recoveryBundle.root)] : []));
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = resolve(root, entry.name);
    if (dirname(path) !== resolve(root) || retained.has(path)) continue;
    rmSync(path, { recursive: true, force: true });
  }
}

/** Explicitly records evidence only after the full independent verification passed. */
function persistVerifiedKnownGood(config: RecoveryConfig, verified: VerifyResult, performance: RuntimePerformanceEvidence): ReleaseEvidence {
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
    assertRuntimePerformanceEvidence(performance, runtimePerformanceIdentity(config));
    const attested: ReleaseEvidence = {
      ...active,
      performance,
      controllerHome: resolve(config.controllerHome),
      releaseAuthorityRevision: authority.revision,
      releaseFencingTokenSha256: createHash('sha256').update(authority.fencingToken).digest('hex'),
      attestedAt: new Date().toISOString(),
      recoveryBundle: createKnownGoodRecoveryBundle(config),
    };
    const store = knownGood(config);
    const releases = [
      attested,
      ...store.releases.filter((entry) => {
        if (entry.path === active.path) return false;
        try { inspectKnownGoodRecoveryBundle(config.controllerHome, entry); return true; }
        catch { return false; }
      }),
    ].slice(0, 8);
    writeJson(statePath(config), { schemaVersion: 2, releases, updatedAt: new Date().toISOString() } satisfies KnownGoodStore);
    // State is durable before cleanup. A crash between these lines leaves an
    // orphaned bundle, which this same owner removes on the next attestation;
    // it never invalidates a published recovery point.
    pruneRetiredKnownGoodRecoveryBundles(config, releases);
    audit(config, 'known_good_attested', {
      revision: active.revision,
      artifactIdentity: active.artifactIdentity,
      manifestSha256: active.manifestSha256,
      releaseAuthorityRevision: authority.revision,
    });
  return attested;
}

function runtimePerformanceIdentity(config: RecoveryConfig): RuntimePerformanceIdentity {
  const authority = releaseAuthority(config);
  const status = observeRuntimeStatus(config.controllerHome);
  const snapshot = status.snapshot;
  if (!authority || !status.running || !status.ready || status.stale || !snapshot
    || snapshot.releaseId !== authority.active.releaseId
    || snapshot.artifactIdentity !== authority.active.artifactIdentity) {
    throw new Error('RECOVERY_PERFORMANCE_UNKNOWN: coherent live Runtime required');
  }
  return {
    releaseId: authority.active.releaseId, authorityRevision: authority.revision,
    pid: snapshot.pid, runtimeInstanceId: snapshot.runtimeInstanceId, startedAt: snapshot.startedAt,
  };
}

export const RECOVERY_INTERNAL_PERFORMANCE_COMMAND = '__measure-runtime-performance';

export async function measureConfiguredRuntimePerformance(
  config: RecoveryConfig,
  dependencies: RuntimePerformanceDependencies = {},
): Promise<RuntimePerformanceEvidence> {
  return await measureRuntimePerformance(() => runtimePerformanceIdentity(config), dependencies);
}

function hasRuntimePerformanceTestSeam(dependencies: RuntimePerformanceDependencies): boolean {
  return dependencies.readCpu !== undefined
    || dependencies.monotonicNow !== undefined
    || dependencies.wallNow !== undefined
    || dependencies.sleep !== undefined;
}

async function measureRuntimePerformanceIsolated(
  config: RecoveryConfig,
  expectedIdentity: RuntimePerformanceIdentity,
): Promise<RuntimePerformanceEvidence> {
  const recoveryBefore = readCurrentRecoveryRelease(config.controllerHome);
  if (!recoveryBefore) throw new Error('RECOVERY_PERFORMANCE_UNKNOWN: current immutable Recovery release unavailable');
  const executable = join(recoveryBefore.releasePath, 'forge-recovery');
  if (!existsSync(executable)) throw new Error('RECOVERY_PERFORMANCE_UNKNOWN: immutable Recovery sampler executable unavailable');

  const result = await runBoundedChild(
    executable,
    [RECOVERY_INTERNAL_PERFORMANCE_COMMAND, '--controller-home', config.controllerHome],
    {
      timeoutMs: 100_000,
      maxOutputBytes: 32 * 1024,
      forwardSignals: false,
      env: runtimeAuthorityFreeEnvironment(process.env),
    },
  );
  if (result.status !== 0 || result.failureCode || result.timedOut) {
    const detail = result.failureCode ?? result.error ?? (result.stderr.trim() || `exit=${result.status}`);
    throw new Error(`RECOVERY_PERFORMANCE_UNKNOWN: isolated sampler failed (${detail.slice(0, 240)})`);
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    throw new Error('RECOVERY_PERFORMANCE_UNKNOWN: isolated sampler returned malformed evidence');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('RECOVERY_PERFORMANCE_UNKNOWN: isolated sampler returned invalid evidence envelope');
  }
  const parsed = envelope as { schemaVersion?: unknown; ok?: unknown; evidence?: unknown; error?: unknown };
  if (parsed.schemaVersion !== 1 || typeof parsed.ok !== 'boolean') {
    throw new Error('RECOVERY_PERFORMANCE_UNKNOWN: isolated sampler returned invalid evidence envelope');
  }
  if (!parsed.ok) {
    const detail = typeof parsed.error === 'string' ? parsed.error : '';
    if (/^RECOVERY_PERFORMANCE_(?:UNKNOWN|REJECTED):/.test(detail)) throw new Error(detail);
    throw new Error('RECOVERY_PERFORMANCE_UNKNOWN: isolated sampler returned an unclassified failure');
  }
  if (!parsed.evidence || typeof parsed.evidence !== 'object' || Array.isArray(parsed.evidence)) {
    throw new Error('RECOVERY_PERFORMANCE_UNKNOWN: isolated sampler omitted performance evidence');
  }
  const performance = parsed.evidence as RuntimePerformanceEvidence;
  assertRuntimePerformanceEvidence(performance, expectedIdentity);

  const recoveryAfter = readCurrentRecoveryRelease(config.controllerHome);
  if (!recoveryAfter
    || recoveryAfter.releaseRevision !== recoveryBefore.releaseRevision
    || recoveryAfter.manifestSha256 !== recoveryBefore.manifestSha256) {
    throw new Error('RECOVERY_PERFORMANCE_UNKNOWN: Recovery release changed during performance observation');
  }
  if (!samePerformanceIdentity(expectedIdentity, runtimePerformanceIdentity(config))) {
    throw new Error('RECOVERY_PERFORMANCE_UNKNOWN: Runtime or release authority changed after performance observation');
  }
  return performance;
}

export async function attestKnownGood(
  config: RecoveryConfig,
  dependencies: RuntimePerformanceDependencies = {},
): Promise<ReleaseEvidence> {
  const initialIdentity = runtimePerformanceIdentity(config);
  const before = await verifyStableRuntime(config);
  if (!before.ok) throw new Error('RECOVERY_KNOWN_GOOD_ATTESTATION_REQUIRES_FULL_VERIFY_AND_RELEASE_AUTHORITY');
  const verifiedIdentity = runtimePerformanceIdentity(config);
  if (!samePerformanceIdentity(initialIdentity, verifiedIdentity)
    || before.releases.active?.revision !== verifiedIdentity.releaseId) {
    throw new Error('RECOVERY_PERFORMANCE_UNKNOWN: Runtime or release authority changed during functional verification');
  }

  // Production observation executes in one short-lived child of the exact
  // immutable Recovery release so Gateway/watchdog work in the persistent
  // daemon cannot stretch the sampler's monotonic windows. Explicit dependency
  // hooks remain the in-process test seam only. Both paths stay read-only and
  // outside the Recovery mutation lock; exact Runtime identity remains fenced.
  const performance = hasRuntimePerformanceTestSeam(dependencies)
    ? await measureRuntimePerformance(() => {
        const current = runtimePerformanceIdentity(config);
        if (!samePerformanceIdentity(verifiedIdentity, current)) {
          throw new Error('RECOVERY_PERFORMANCE_UNKNOWN: Runtime or release authority changed after functional verification');
        }
        return current;
      }, dependencies)
    : await measureRuntimePerformanceIsolated(config, verifiedIdentity);

  const locked = await withLock(config, { action: 'attest_known_good' }, async () => {
    const verified = await verifyStableRuntime(config);
    if (!verified.ok) throw new Error('RECOVERY_KNOWN_GOOD_ATTESTATION_REQUIRES_FULL_VERIFY_AND_RELEASE_AUTHORITY');
    return persistVerifiedKnownGood(config, verified, performance);
  });
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
  const targetExecution = probeRuntimeExecutionSurface(config, target);
  if (!targetExecution.ok) {
    audit(config, 'rollback_refused', {
      reason: 'attested previous release failed Process Runtime execution canary',
      targetRevision: target.revision,
      detail: targetExecution.detail,
    });
    return {
      ok: false,
      detail: `rollback refused: previous whole-Runtime release failed Process Runtime execution verification: ${targetExecution.detail}`,
      verify: before,
    };
  }
  const operationId = `recovery-rollback-${Date.now()}-${randomUUID().slice(0, 8)}`;
  try {
    const rollbackResult = rollbackRuntimeReleaseWithResult(config.controllerHome, operationId);
    const committed = rollbackResult.authority;
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
      databaseDisposition: rollbackResult.databaseDisposition,
      liveAuditEventCount: rollbackResult.liveAuditEventCount,
      rollbackAuditEventCount: rollbackResult.rollbackAuditEventCount,
    });
    return {
      ok: true,
      operationId,
      detail: rollbackResult.databaseDisposition === 'restored_backup'
        ? 'whole-Runtime release and unchanged SQLite backup restored; Canonical Runtime remains stopped until its sole launcher starts it'
        : 'whole-Runtime release restored while newer live SQLite state was preserved; Canonical Runtime remains stopped until its sole launcher starts it',
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
  const primaryTunnel = configuredPrimaryPublicTunnel(config);
  const remoteTransportOk = primaryTunnel?.platform === 'openai-secure-tunnel'
    ? verified.probes.primary_tunnel_runtime?.ok === true
    : (publicProbe?.ok === true || publicProbe?.status === 401);
  const ok = verified.probes.active_gateway?.ok === true
    && verified.probes.primary_connector_ready?.ok !== false
    && remoteTransportOk;
  audit(config, 'reconnect_main', { ok, externalStatus: publicProbe?.status, primaryTunnelPlatform: primaryTunnel?.platform });
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
    recoveryTunnelService: undefined,
    primaryPublicTunnelService: undefined,
    readOnlyTool: { name: STABLE_RECOVERY_READ_ONLY_TOOL.name, arguments: { ...STABLE_RECOVERY_READ_ONLY_TOOL.arguments } },
  }, createRecoveryHttpTransport(config.controllerHome), options);
}

/**
 * Five-second Watchdog cadence owns health observation, not release
 * verification. Keep this path deliberately bounded to already-published
 * Runtime authority/status plus local HTTP transport checks needed for prompt
 * targeted repair. Expensive execution canaries, known-good bundle inspection,
 * tunnel commands, external transport probes and MCP initialize/list/call stay
 * in verifyStableRuntime/verifyLocalRuntime and run only on the periodic
 * verification deadline or after this health tier degrades.
 */
async function observeWatchdogHealthTier(
  config: RecoveryConfig,
  transport = createRecoveryHttpTransport(config.controllerHome),
): Promise<VerifyResult> {
  const observation = observeRuntimeStatus(config.controllerHome);
  const authority = releaseAuthority(config);
  const active = activeAuthorityRelease(config);
  const previous = previousAuthorityRelease(config);
  const runtimeHealthy = observation.running && observation.ready && !observation.stale;
  const coherent = Boolean(
    authority
    && active
    && observation.snapshot?.releaseId === active.revision
    && observation.snapshot?.artifactIdentity === active.artifactIdentity
    && authority.active.workerProtocolVersion === active.workerProtocolVersion
  );
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
  // The dedicated Recovery transport is the only channel that can repair a
  // broken primary transport. It must be observed on every liveness tick, or a
  // dead Recovery tunnel stays invisible while the watchdog keeps reporting a
  // healthy system and never reaches the bounded tunnel-repair path.
  const recoveryTransport = await probeOpenAiRecoveryTunnel(config);
  if (recoveryTransport) probes.recovery_tunnel_runtime = recoveryTransport;
  const localChecks = Object.entries(probes)
    .filter(([name]) => !name.startsWith('recovery_'))
    .every(([, entry]) => entry.ok);
  return {
    ok: Boolean(runtimeHealthy && coherent && localChecks),
    at: new Date().toISOString(),
    runtime: {
      ok: runtimeHealthy,
      running: observation.running,
      ready: observation.ready,
      stale: observation.stale,
      reasonCodes: [...observation.reasonCodes],
    },
    releases: {
      active,
      previous,
      // This tier reports durable attestation identity only. Physical bundle
      // integrity is deliberately reserved for strict verification boundaries.
      knownGood: matchingKnownGoodAttestation(config, active),
      coherent,
    },
    probes,
  };
}

function isExternalTunnelFailure(config: RecoveryConfig, verified: VerifyResult, localVerify: VerifyResult): boolean {
  const configured = configuredRecoveryTunnel(config);
  const localRecoveryGatewayHealthy = localVerify.probes.recovery_gateway?.ok ?? true;
  if (!configured || !localVerify.ok || !localRecoveryGatewayHealthy) return false;
  if (configured.platform === 'openai-secure-tunnel') return verified.probes.recovery_tunnel_runtime?.ok !== true;
  const external = verified.probes.recovery_external_http ?? verified.probes.external_mcp_http;
  return Boolean(configuredRecoveryPublicUrl(config) && external?.ok !== true);
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
  return { verified, knownGood: inspectKnownGoodRecoverability(config), quarantine: json(quarantinePath(config)) ?? { releases: [] } };
}

export async function listReleases(config: RecoveryConfig): Promise<Record<string, unknown>> {
  const observation = observeRuntimeStatus(config.controllerHome);
  const knownGoodRecoverability = inspectKnownGoodRecoverability(config);
  return {
    runtimeRunning: observation.running,
    runtimeReady: observation.ready,
    active: activeAuthorityRelease(config),
    previous: previousAuthorityRelease(config),
    knownGood: knownGoodRecoverability.available,
    knownGoodUnavailable: knownGoodRecoverability.unavailable,
    pinned: runtimePin(config)?.release,
  };
}

interface CommandResult { ok: boolean; status: number | null; stdout: string; stderr: string; }
type CommandRunner = (commandName: string, args: string[], timeoutMs?: number) => Promise<CommandResult>;
interface LaunchdService { uid: number; domain: string; target: string; label: string; plistPath: string; }

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
    const child = spawn(commandName, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: options.cwd,
      env: { ...runtimeAuthorityFreeEnvironment(process.env), PATH: recoveryCommandPath() },
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
  /** Rebind the independently supervised OAuth Connector after a whole-Runtime release switch. */
  repairPrimaryConnectorBinding?: (config: RecoveryConfig) => Promise<{ ok: boolean; attempted: boolean; noOp?: boolean; detail: string }>;
  runtimeRunning?: (config: RecoveryConfig) => boolean;
  ensureRuntimeLaunchContract?: (controllerHome: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RuntimeReleaseKnownGoodDependencies extends RuntimePerformanceDependencies {
  /** Test/host seam for the existing whole-Runtime rollback transaction. */
  rollback?: PrimaryRuntimeRecoveryDependencies;
}

export interface RuntimeReleaseActivationGuard {
  /** External caller identity for audit/lock attribution. */
  requestId?: string;
  /** Internal Recovery-only mode: allow explicit activation of current.previous when it is durably pinned. */
  allowPreviousRelease?: boolean;
  /** Internal Recovery-only mode: restore Runtime authority without restoring an older SQLite backup on activation failure. */
  preserveDatabaseOnFailure?: boolean;
  /** Internal Recovery-only pin fence checked after acquiring the mutation lock. */
  requiredPinnedReleaseRevision?: string;
  /** Authority snapshot observed when the caller decided to activate; null means the caller observed no authority. */
  expectedAuthorityRevision?: number | null;
  /** Active release observed when the caller decided to activate; null means the caller observed no active release. */
  expectedActiveReleaseId?: string | null;
  /** Fresh portable source candidates may activate only after this exact Recovery ReleaseSession becomes cutover-eligible. */
  releaseSessionId?: string;
}

function configuredPrimaryRuntimeService(config: RecoveryConfig, platform: NodeJS.Platform = process.platform): PrimaryRuntimeServiceConfig {
  return config.primaryRuntimeService ?? defaultPrimaryRuntimeServiceConfig(platform);
}

interface PrimaryRuntimeServiceOwner {
  platform: 'launchd' | 'systemd-user';
  target: string;
  uid: number;
  launchd?: LaunchdService;
  unitName?: string;
  unitPath?: string;
}

function primaryRuntimeServiceOwner(
  config: RecoveryConfig,
  platform: NodeJS.Platform,
  uid: number | undefined,
): PrimaryRuntimeServiceOwner | undefined {
  if (uid === undefined) return undefined;
  const configured = configuredPrimaryRuntimeService(config, platform);
  const paths = forgeRuntimeServicePaths(config.controllerHome);
  if (platform === 'darwin' && configured.platform === 'launchd') {
    if (!existsSync(paths.installedPlistPath)) return undefined;
    const domain = `gui/${uid}`;
    const launchd: LaunchdService = {
      uid,
      domain,
      target: `${domain}/${paths.label}`,
      label: paths.label,
      plistPath: paths.installedPlistPath,
    };
    return { platform: 'launchd', target: launchd.target, uid, launchd };
  }
  if (platform === 'linux' && configured.platform === 'systemd-user') {
    const unitName = systemdUserUnitName(paths.label);
    const unitPath = systemdUserUnitPath(unitName);
    if (!existsSync(unitPath)) return undefined;
    return { platform: 'systemd-user', target: unitName, uid, unitName, unitPath };
  }
  return undefined;
}

async function ensurePrimaryRuntimeServiceStarted(
  owner: PrimaryRuntimeServiceOwner,
  runCommand: CommandRunner,
  mode: 'start' | 'restart' = 'start',
): Promise<{ ok: boolean; detail: string }> {
  if (owner.platform === 'launchd') return ensureLaunchdServiceStarted(owner.launchd!, runCommand);
  const action = mode === 'restart' ? 'restart' : 'start';
  const result = await runCommand('systemctl', ['--user', action, owner.unitName!], 15_000);
  return result.ok
    ? { ok: true, detail: owner.target }
    : { ok: false, detail: `systemd-user ${action} failed: ${result.stderr || result.stdout || result.status}` };
}

async function stopPrimaryRuntimeServiceOwner(
  owner: PrimaryRuntimeServiceOwner,
  runCommand: CommandRunner,
): Promise<{ ok: boolean; detail: string }> {
  if (owner.platform === 'launchd') {
    const stopped = await runCommand('launchctl', ['bootout', owner.launchd!.target], 15_000);
    const stoppedCleanly = stopped.ok || /not found|no such process|could not find service|service is not loaded/i.test(`${stopped.stderr}\n${stopped.stdout}`);
    return stoppedCleanly
      ? { ok: true, detail: owner.target }
      : { ok: false, detail: `primary Runtime bootout failed: ${stopped.stderr || stopped.stdout || stopped.status}` };
  }
  const stopped = await runCommand('systemctl', ['--user', 'stop', owner.unitName!], 15_000);
  return stopped.ok
    ? { ok: true, detail: owner.target }
    : { ok: false, detail: `primary Runtime systemd-user stop failed: ${stopped.stderr || stopped.stdout || stopped.status}` };
}

async function waitForPrimaryRuntimeServiceStopped(input: {
  owner: PrimaryRuntimeServiceOwner;
  timeoutMs: number;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  runCommand: CommandRunner;
}): Promise<boolean> {
  if (input.owner.platform === 'launchd') {
    return waitForLaunchdServiceUnloaded({
      service: input.owner.launchd!,
      timeoutMs: input.timeoutMs,
      now: input.now,
      wait: input.wait,
      runCommand: input.runCommand,
    });
  }
  const observe = async () => {
    const result = await input.runCommand('systemctl', ['--user', 'show', '--property', 'ActiveState', '--value', input.owner.unitName!], 5_000);
    if (!result.ok) return false;
    return /^(inactive|failed)$/.test(result.stdout.trim());
  };
  const deadline = input.now() + input.timeoutMs;
  while (input.now() < deadline) {
    if (await observe()) return true;
    await input.wait(250);
  }
  return observe();
}

function primaryRuntimeServiceContractMatches(config: RecoveryConfig, owner: PrimaryRuntimeServiceOwner): boolean {
  if (owner.platform === 'launchd') {
    return inspectForgeRuntimeLaunchAgentContract({
      controllerHome: config.controllerHome,
      inspectUserLaunchAgent: true,
    }).matches;
  }
  try {
    const unit = readFileSync(owner.unitPath!, 'utf8');
    return unit === renderPackageRuntimeSystemdUserService(config.controllerHome);
  } catch {
    return false;
  }
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

interface PrimaryConnectorServiceOwner {
  platform: 'launchd' | 'systemd-user';
  label: string;
  target: string;
  uid: number;
  launchd?: LaunchdService;
  unitName?: string;
  unitPath?: string;
}

function primaryConnectorServiceOwner(
  config: RecoveryConfig,
  platform: NodeJS.Platform,
  uid: number | undefined,
): PrimaryConnectorServiceOwner | undefined {
  const configured = config.primaryConnectorService;
  if (!configured || uid === undefined) return undefined;
  const paths = packageConnectorServicePaths(config.controllerHome);
  if (configured.platform === 'launchd') {
    if (platform !== 'darwin' || !configured.label.trim()) return undefined;
    const label = configured.label.trim();
    const plistPath = resolve(configured.plistPath ?? join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`));
    if (!existsSync(plistPath)) return undefined;
    const domain = `gui/${uid}`;
    const launchd = { uid, domain, target: `${domain}/${label}`, label, plistPath };
    return { platform: 'launchd', label, target: launchd.target, uid, launchd };
  }
  if (platform !== 'linux') return undefined;
  if (configured.label?.trim() && configured.label.trim() !== paths.label) return undefined;
  const unitName = systemdUserUnitName(paths.label);
  return {
    platform: 'systemd-user',
    label: paths.label,
    target: `systemd-user:${unitName}`,
    uid,
    unitName,
    unitPath: systemdUserUnitPath(paths.label),
  };
}

async function ensurePrimaryConnectorServiceStarted(
  owner: PrimaryConnectorServiceOwner,
  runCommand: CommandRunner,
): Promise<{ ok: boolean; detail: string }> {
  if (owner.platform === 'launchd') return ensureLaunchdServiceStarted(owner.launchd!, runCommand);
  const restarted = await runCommand('systemctl', ['--user', 'restart', owner.unitName!], 15_000);
  return restarted.ok
    ? { ok: true, detail: owner.target }
    : { ok: false, detail: `systemd-user restart failed: ${restarted.stderr || restarted.stdout || restarted.status}` };
}

async function probePrimaryConnectorLocal(
  config: RecoveryConfig,
  transport = createRecoveryHttpTransport(config.controllerHome),
): Promise<{ ok: boolean; detail: string; status?: number } | undefined> {
  const localMcpUrl = config.primaryConnectorService?.localMcpUrl?.trim();
  if (!localMcpUrl) return undefined;
  return probeExternalMcp(transport, localMcpUrl, {
    acceptOAuthChallenge: packageConnectorAuthMode(config.controllerHome) === 'oauth',
  });
}

function activePackageConnectorReleaseBinding(config: RecoveryConfig): PackageConnectorReleaseBinding | undefined {
  const configured = config.primaryConnectorService;
  if (!configured || !configured.localMcpUrl?.trim()) return undefined;
  const authority = readRuntimeReleaseAuthority(config.controllerHome);
  if (!authority) return undefined;
  const releaseRoot = dirname(resolve(authority.active.manifestPath));
  const packageRoot = join(releaseRoot, 'package');
  const paths = packageConnectorServicePaths(config.controllerHome);
  if (configured.platform === 'launchd') {
    const configuredPlist = resolve(configured.plistPath ?? paths.installedPlistPath);
    if (configured.label !== paths.label || configuredPlist !== resolve(paths.installedPlistPath)) return undefined;
  } else if (configured.label?.trim() && configured.label.trim() !== paths.label) {
    return undefined;
  }
  if (!existsSync(join(packageRoot, 'src', 'cli', 'index.ts')) || !existsSync(join(packageRoot, 'src', 'runtime', 'shared', 'node-ts-loader.mjs'))) return undefined;
  return { releaseId: authority.active.releaseId, releaseRoot, packageRoot };
}

export function resolveRecoveryPackageConnectorExecutable(
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
  accountHome: string = homedir(),
): string {
  return resolveBunExecutable(execPath, env, accountHome);
}

async function repairPrimaryConnectorBinding(
  config: RecoveryConfig,
  platform: NodeJS.Platform = process.platform,
): Promise<{ ok: boolean; attempted: boolean; noOp?: boolean; detail: string }> {
  const release = activePackageConnectorReleaseBinding(config);
  const endpoint = config.primaryConnectorService?.localMcpUrl?.trim();
  if (!release || !endpoint) return { ok: true, attempted: false, noOp: true, detail: 'primary Connector does not use the canonical package-release binding contract' };
  try {
    const executable = resolveRecoveryPackageConnectorExecutable();
    const result = await ensurePackageConnectorService({ release, controllerHome: config.controllerHome, endpoint, executable, platform });
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
  service: PrimaryConnectorServiceOwner,
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
  let pid: number | undefined;
  if (service.platform === 'launchd') {
    const printed = await runCommand('launchctl', ['print', service.target], 5_000);
    const pidMatch = printed.ok ? printed.stdout.match(/\bpid\s*=\s*(\d+)/) : null;
    pid = pidMatch ? Number(pidMatch[1]) : undefined;
  } else {
    const shown = await runCommand('systemctl', ['--user', 'show', '--property', 'MainPID', '--value', service.unitName!], 5_000);
    const parsed = Number(shown.stdout.trim());
    pid = shown.ok && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  if (!pid || !Number.isInteger(pid)) {
    return { ok: false, detail: `configured primary Connector ${service.platform} service has no live pid: ${service.target}` };
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
  const canonicalRuntimeHealthy = canonicalRuntimeSafeForTargetedConnectorRecovery(initialLocal);
  if (!canonicalRuntimeHealthy) {
    return {
      ok: false,
      attempted: false,
      noOp: true,
      detail: 'Canonical Runtime ownership/release execution authority must be healthy before the primary Connector is restarted',
      verify: initialLocal,
    };
  }
  const platform = dependencies.platform ?? process.platform;
  const uid = await (dependencies.currentUid ?? currentUid)();
  const service = primaryConnectorServiceOwner(config, platform, uid);
  if (!service) {
    return { ok: false, attempted: false, noOp: true, detail: `primary Connector ${config.primaryConnectorService?.platform ?? 'service'} is not configured for ${platform}`, verify: initialLocal };
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
    const repairConnectorBinding = dependencies.repairConnectorBinding ?? ((candidateConfig: RecoveryConfig) => repairPrimaryConnectorBinding(candidateConfig, platform));
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
      const restarted = await ensurePrimaryConnectorServiceStarted(service, runCommand);
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
            ? `primary Connector restarted but the configured ${service.platform} service does not own its local MCP listener`
            : 'primary Connector restarted but its local MCP endpoint did not recover before timeout',
          serviceTarget: service.target,
          verify: initialLocal,
        } satisfies PrimaryConnectorRestartResult;
      }
    }

    observed ??= await reconnect(config);
    const primaryTunnel = configuredPrimaryPublicTunnel(config);
    if (!observed.ok && localConnector?.ok && connectorOwnership?.ok && primaryTunnel) {
      let tunnelRestarted: { ok: boolean; attempted: boolean; detail: string; serviceTarget: string } | undefined;
      if (primaryTunnel.platform === 'launchd') {
        const tunnel = primaryPublicTunnelService(config, service.uid);
        if (tunnel) {
          const result = await ensureLaunchdServiceStarted(tunnel, runCommand);
          tunnelRestarted = { ok: result.ok, attempted: true, detail: result.detail, serviceTarget: tunnel.target };
        }
      } else {
        tunnelRestarted = await ensureOpenAiTunnelRuntimeStarted(primaryTunnel, runCommand);
      }
      if (!tunnelRestarted?.ok) {
        const detail = tunnelRestarted?.detail ?? 'primary public tunnel service configuration is invalid or unavailable';
        audit(config, 'primary_public_tunnel_restart_failed', { serviceTarget: tunnelRestarted?.serviceTarget, detail });
        return {
          ok: false,
          attempted: tunnelRestarted?.attempted ?? false,
          detail: `primary Connector is locally healthy but public tunnel restart failed: ${detail}`,
          serviceTarget: service.target,
          verify: observed.verify,
        } satisfies PrimaryConnectorRestartResult;
      }
      const tunnelDeadline = now() + (primaryTunnel.postRestartVerifyTimeoutMs ?? 20_000);
      while (!observed.ok && now() < tunnelDeadline) {
        await wait(1_000);
        observed = await reconnect(config);
      }
      audit(config, observed.ok ? 'primary_public_tunnel_restart_succeeded' : 'primary_public_tunnel_restart_unverified', {
        serviceTarget: tunnelRestarted.serviceTarget,
        detail: observed.detail,
      });
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
  service: PrimaryRuntimeServiceOwner;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  runCommand: CommandRunner;
  runtimeRunning: (config: RecoveryConfig) => boolean;
}): Promise<PrimaryRuntimeStoppedTransition> {
  const stopped = await stopPrimaryRuntimeServiceOwner(input.service, input.runCommand);
  if (!stopped.ok) return { ok: false, detail: stopped.detail };
  const serviceStopped = await waitForPrimaryRuntimeServiceStopped({
    owner: input.service,
    timeoutMs: 20_000,
    now: input.now,
    wait: input.wait,
    runCommand: input.runCommand,
  });
  if (!serviceStopped) {
    return {
      ok: false,
      detail: input.service.platform === 'launchd'
        ? 'primary Runtime launchd service remained loaded after bounded bootout'
        : 'primary Runtime systemd-user service remained active after bounded stop',
    };
  }

  let runtimeStopped = await waitForPrimaryRuntimeState({
    config: input.config,
    expectedRunning: false,
    timeoutMs: 5_000,
    now: input.now,
    wait: input.wait,
    runtimeRunning: input.runtimeRunning,
  });
  if (!runtimeStopped) {
    const orphanTermination = await terminateVerifiedRuntimeOwner(input.config.controllerHome);
    if (!orphanTermination.ok) {
      return {
        ok: false,
        detail: `primary Runtime owner remained live after service shutdown and bounded identity-verified termination was refused/failed: ${orphanTermination.detail}`,
      };
    }
    runtimeStopped = await waitForPrimaryRuntimeState({
      config: input.config,
      expectedRunning: false,
      timeoutMs: 10_000,
      now: input.now,
      wait: input.wait,
      runtimeRunning: input.runtimeRunning,
    });
    if (!runtimeStopped) {
      return { ok: false, detail: 'primary Runtime owner remained live after verified orphan termination' };
    }
  }

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
      detail: `primary Runtime TCP port remained occupied after bounded ${input.service.platform} stop: ${staleListenerCleanup?.detail ?? 'listener did not release'}`,
      staleListenerCleanup,
    };
  }

  const ownership = reconcileStoppedRuntimeOwnership(input.config.controllerHome);
  if (!ownership.ok) {
    return {
      ok: false,
      detail: `primary Runtime ownership did not quiesce after bounded ${input.service.platform} stop: ${ownership.detail}`,
      staleListenerCleanup,
    };
  }
  const supervisorSocket = workflowSupervisorSocketPath(resolveWorkflowSupervisorForgeHome(input.config.controllerHome));
  const supervisor = await reconcileStoppedWorkflowSupervisorSocket(supervisorSocket);
  if (!supervisor.ok) {
    return {
      ok: false,
      detail: `Workflow Supervisor writer did not quiesce after Runtime stop: ${supervisor.detail}`,
      staleListenerCleanup,
    };
  }
  return {
    ok: true,
    detail: `primary Runtime ${input.service.platform} service, owner, TCP listener, and Workflow Supervisor writer are quiescent`,
    staleListenerCleanup,
  };
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
  service: PrimaryRuntimeServiceOwner;
  runCommand: CommandRunner;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  verifyLocal: (config: RecoveryConfig) => Promise<VerifyResult>;
  ensureRuntimeLaunchContract?: (controllerHome: string) => void;
  beforeStart?: () => void;
  afterRuntimeReady?: () => Promise<{ ok: boolean; detail: string }>;
  contractFailureContext?: string;
  timeoutMs: number;
  successDetail: string;
}): Promise<PrimaryRuntimeRebindStartResult> {
  try {
    if (input.service.platform === 'launchd') {
      const ensureRuntimeLaunchContract = input.ensureRuntimeLaunchContract
        ?? ((controllerHome: string) => { ensureForgeRuntimeLaunchAgentContract({ controllerHome, installUserLaunchAgent: true }); });
      ensureRuntimeLaunchContract(input.config.controllerHome);
    } else {
      const unitPath = writePackageRuntimeSystemdUserService(input.config.controllerHome);
      if (resolve(unitPath) !== resolve(input.service.unitPath!)) {
        throw new Error('canonical package Runtime systemd-user unit path changed during Recovery rebind');
      }
      for (const args of [
        ['--user', 'daemon-reload'],
        ['--user', 'enable', input.service.unitName!],
      ]) {
        const result = await input.runCommand('systemctl', args, 15_000);
        if (!result.ok) throw new Error(`systemctl ${args.join(' ')} failed: ${result.stderr || result.stdout || result.status}`);
      }
    }
  } catch (error) {
    const manager = input.service.platform === 'launchd' ? 'launchd' : 'systemd-user';
    return {
      ok: false,
      detail: `primary Runtime ${manager} contract rebuild failed ${input.contractFailureContext ?? 'after release transition'}: ${error instanceof Error ? error.message : String(error)}`,
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

  const started = await ensurePrimaryRuntimeServiceStarted(input.service, input.runCommand, 'start');
  if (!started.ok) {
    return { ok: false, detail: started.detail, verify: await input.verifyLocal(input.config) };
  }
  if (input.afterRuntimeReady) {
    const deadline = input.now() + input.timeoutMs;
    let runtimeVerify = await input.verifyLocal(input.config);
    const runtimeReady = (value: VerifyResult) => value.runtime.ok && value.runtime.running && value.runtime.ready && !value.runtime.stale;
    while (!runtimeReady(runtimeVerify) && input.now() < deadline) {
      await input.wait(1_000);
      runtimeVerify = await input.verifyLocal(input.config);
    }
    if (!runtimeReady(runtimeVerify)) {
      await stopPrimaryRuntimeServiceOwner(input.service, input.runCommand);
      return {
        ok: false,
        detail: 'release transition candidate Runtime did not reach local readiness before Connector rebinding',
        verify: runtimeVerify,
      };
    }
    const postReady = await input.afterRuntimeReady();
    if (!postReady.ok) {
      await stopPrimaryRuntimeServiceOwner(input.service, input.runCommand);
      return { ok: false, detail: postReady.detail, verify: await input.verifyLocal(input.config) };
    }
  }
  const verify = await verifyPrimaryRuntimeAfterStart({
    config: input.config,
    timeoutMs: input.timeoutMs,
    now: input.now,
    wait: input.wait,
    verifyLocal: input.verifyLocal,
  });
  if (verify.ok) return { ok: true, detail: input.successDetail, verify };
  await stopPrimaryRuntimeServiceOwner(input.service, input.runCommand);
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
  const platform = dependencies.platform ?? process.platform;
  const uid = await (dependencies.currentUid ?? currentUid)();
  const service = primaryRuntimeServiceOwner(config, platform, uid);
  if (!service) {
    return { ok: false, attempted: false, noOp: true, detail: `primary Forge Runtime ${configuredPrimaryRuntimeService(config, platform).platform} service is not installed for ${platform}`, verify: initial };
  }
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.sleep ?? sleep;
  const locked = await withLock(config, { action: 'restart_primary_runtime' }, async () => {
    const before = await verifyLocal(config);
    if (before.ok) return { ok: true, attempted: false, noOp: true, detail: 'Canonical Forge Runtime recovered before restart', serviceTarget: service.target, verify: before } satisfies PrimaryRuntimeRestartResult;
    const runCommand = dependencies.runCommand ?? command;
    const runtimeRunning = dependencies.runtimeRunning ?? ((value: RecoveryConfig) => observeRuntimeStatus(value.controllerHome).running);
    const stopped = await stopPrimaryRuntimeForReleaseTransition({
      config,
      service,
      now,
      wait,
      runCommand,
      runtimeRunning,
    });
    if (!stopped.ok) {
      audit(config, 'primary_runtime_restart_quiescence_failed', { serviceTarget: service.target, detail: stopped.detail });
      return { ok: false, attempted: true, detail: stopped.detail, serviceTarget: service.target, verify: before } satisfies PrimaryRuntimeRestartResult;
    }
    const started = await ensurePrimaryRuntimeServiceStarted(service, runCommand, 'restart');
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

  const releaseAuthoritySnapshot = releaseAuthority(config);
  if (releaseAuthoritySnapshot) {
    const inventory = listReleaseSessions(config.controllerHome, { maxEntries: 512 });
    if (inventory.truncated || inventory.invalidSessionFiles.length > 0) {
      return {
        ok: false,
        attempted: false,
        noOp: true,
        detail: `RELEASE_SESSION_INVENTORY_INCOMPLETE: truncated=${inventory.truncated}; invalid=${inventory.invalidSessionFiles.join(',') || 'none'}`,
        verify: initial,
      };
    }
    const matching = inventory.sessions.filter((session) => (
      ['cutover_attempting', 'cutover_committed', 'soaking'].includes(session.phase)
      && session.transaction
      && session.candidateRelease?.releaseId === releaseAuthoritySnapshot.active.releaseId
      && session.candidateRelease.artifactIdentity === releaseAuthoritySnapshot.active.artifactIdentity
    ));
    if (matching.length > 1) {
      return {
        ok: false,
        attempted: false,
        noOp: true,
        detail: `RELEASE_SESSION_MULTIPLE_ACTIVE_FOR_RUNTIME: ${matching.map((session) => session.sessionId).join(',')}`,
        verify: initial,
      };
    }
    const session = matching[0];
    if (session) {
      const sessionRollback = await rollbackConfiguredRuntimeReleaseSession(
        config,
        session.sessionId,
        dependencies,
        `recover-primary-runtime:${session.transaction!.operationId}`,
      );
      const after = await verifyLocal(config);
      const rollback: RollbackResult = {
        ok: sessionRollback.ok,
        ...(sessionRollback.noOp === true ? { noOp: true } : {}),
        detail: sessionRollback.detail,
        verify: after,
      };
      return {
        ok: sessionRollback.ok,
        attempted: sessionRollback.attempted,
        ...(sessionRollback.noOp === true ? { noOp: true } : {}),
        detail: sessionRollback.detail,
        rollback,
        verify: after,
      };
    }
  }

  const platform = dependencies.platform ?? process.platform;
  const uid = await (dependencies.currentUid ?? currentUid)();
  const service = primaryRuntimeServiceOwner(config, platform, uid);
  if (!service) {
    return { ok: false, attempted: false, noOp: true, detail: `primary Forge Runtime ${configuredPrimaryRuntimeService(config, platform).platform} service is not installed for ${platform}`, verify: initial };
  }
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
    const contractFailure = /^primary Runtime (launchd|systemd-user) contract rebuild failed/.test(restarted.detail);
    audit(config, contractFailure ? 'primary_runtime_recovery_service_contract_failed' : 'primary_runtime_recovery_unverified', {
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
  assertRuntimeReleaseExecutionCanaries(resolvedManifestPath, config.controllerHome);
  return { manifest, releaseRoot, manifestPath: resolvedManifestPath };
}

/**
 * Activate an already staged and validated immutable Runtime release without
 * depending on the primary Runtime execution plane. RuntimeReleaseAuthority
 * changes only physical active/previous identity plus the SQLite backup; when a
 * ReleaseSession owns the cutover, its transaction snapshot is the sole durable
 * semantic rollback authority through soak.
 */
async function activateRuntimeReleaseInternal(
  config: RecoveryConfig,
  candidateManifestPath: string,
  dependencies: PrimaryRuntimeRecoveryDependencies = {},
  guard: RuntimeReleaseActivationGuard = {},
  heldRecoveryLock?: RecoveryLock,
): Promise<RuntimeReleaseActivationResult> {
  let candidate: { manifest: RuntimeReleaseManifest; releaseRoot: string; manifestPath: string };
  try {
    candidate = validateRuntimeReleaseCandidate(config, candidateManifestPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'runtime release candidate validation failed';
    audit(config, 'runtime_release_activation_candidate_invalid', { detail, ...(guard.requestId ? { requestId: guard.requestId } : {}) });
    return { ok: false, attempted: false, noOp: true, detail };
  }
  if (candidate.manifest.deploymentScope === 'portable' && !guard.requiredPinnedReleaseRevision) {
    const releaseSessionId = guard.releaseSessionId?.trim();
    if (!releaseSessionId) {
      const detail = 'RELEASE_SESSION_CUTOVER_REQUIRED: portable Runtime candidates cannot activate outside an exact ReleaseSession';
      audit(config, 'runtime_release_activation_release_session_required', {
        candidateRevision: candidate.manifest.releaseId,
        ...(guard.requestId ? { requestId: guard.requestId } : {}),
      });
      return { ok: false, attempted: false, noOp: true, detail };
    }
    let session: ReleaseSession | undefined;
    try {
      session = readReleaseSession(config.controllerHome, releaseSessionId);
    } catch {
      session = undefined;
    }
    if (!session) {
      return { ok: false, attempted: false, noOp: true, detail: 'RELEASE_SESSION_MISSING' };
    }
    if (session.phase !== 'cutover_attempting') {
      return {
        ok: false,
        attempted: false,
        noOp: true,
        detail: `RELEASE_SESSION_NOT_CUTOVER_ATTEMPTING: ${session.phase}`,
      };
    }
    if (resolve(session.stable.controllerHome) !== resolve(config.controllerHome)) {
      return { ok: false, attempted: false, noOp: true, detail: 'RELEASE_SESSION_STABLE_LANE_MISMATCH' };
    }
    const bound = session.candidateRelease;
    if (!bound) {
      return { ok: false, attempted: false, noOp: true, detail: 'RELEASE_SESSION_CANDIDATE_RELEASE_REQUIRED' };
    }
    const observedManifestSha256 = createHash('sha256').update(readFileSync(candidate.manifestPath)).digest('hex');
    const observedTreeSha256 = runtimeReleaseTreeSha256(candidate.releaseRoot);
    if (
      bound.releaseId !== candidate.manifest.releaseId
      || bound.artifactIdentity !== candidate.manifest.artifactIdentity
      || bound.manifestSha256 !== observedManifestSha256
      || bound.treeSha256 !== observedTreeSha256
    ) {
      return { ok: false, attempted: false, noOp: true, detail: 'RELEASE_SESSION_CANDIDATE_IDENTITY_MISMATCH' };
    }
    try {
      assertStableReleaseSessionIdentityCurrent(config, session.stableRelease);
    } catch (error) {
      return { ok: false, attempted: false, noOp: true, detail: error instanceof Error ? error.message : String(error) };
    }
  }
  const platform = dependencies.platform ?? process.platform;
  const uid = await (dependencies.currentUid ?? currentUid)();
  const service = primaryRuntimeServiceOwner(config, platform, uid);
  if (!service) {
    return { ok: false, attempted: false, noOp: true, detail: `primary Forge Runtime ${configuredPrimaryRuntimeService(config, platform).platform} service is not installed for ${platform}`, verify: await verifyStableRuntime(config) };
  }
  const runCommand = dependencies.runCommand ?? command;
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.sleep ?? sleep;
  const runtimeRunning = dependencies.runtimeRunning ?? ((value: RecoveryConfig) => observeRuntimeStatus(value.controllerHome).running);
  const verifyLocal = dependencies.verifyLocal ?? verifyLocalRuntime;
  const repairConnectorBinding = dependencies.repairPrimaryConnectorBinding
    ?? ((value: RecoveryConfig) => repairPrimaryConnectorBinding(value, platform));
  const operationId = `recovery-activate-runtime-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const lockRequestId = guard.requestId?.trim() || operationId;
  const activateUnderRecoveryAuthority = async () => {
    // Re-read authority only after acquiring the mutation lock. A caller may
    // have selected its candidate before another activation completed; stale
    // decisions must fail before bootout/publish rather than overwrite the newer
    // active release.
    const current = releaseAuthority(config);
    const previousActive = current?.active;
    if (guard.requiredPinnedReleaseRevision) {
      const pinned = runtimePin(config)?.release;
      if (!pinned || pinned.revision !== guard.requiredPinnedReleaseRevision || pinned.revision !== candidate.manifest.releaseId) {
        const detail = `RUNTIME_PIN_AUTHORITY_CHANGED: expected ${guard.requiredPinnedReleaseRevision}, observed ${pinned?.revision ?? 'none'}`;
        return { ok: false, attempted: false, noOp: true, detail, operationId } satisfies RuntimeReleaseActivationResult;
      }
    }
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
        ok: (await repairConnectorBinding(config)).ok,
        attempted: false,
        noOp: true,
        detail: 'requested Runtime release is already the active whole-Runtime release; its persistent Connector binding was reconciled',
        operationId,
        verify: await verifyLocal(config),
      } satisfies RuntimeReleaseActivationResult;
    }
    if (current) {
      const behaviorEquivalent = runtimeBehaviorEquivalent(current.active.manifestPath, candidate.manifestPath);
      let serviceContractMatches = false;
      if (behaviorEquivalent && !storageMigrationRequired) {
        try {
          serviceContractMatches = primaryRuntimeServiceContractMatches(config, service);
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
            ? 'candidate Runtime behavior and installed service contract are identical to the active release; restart skipped'
            : 'candidate Runtime behavior and installed service contract are identical to the active release, but the active Runtime is unhealthy',
          operationId,
          verify,
        } satisfies RuntimeReleaseActivationResult;
      }
    }
    if (!guard.allowPreviousRelease && current?.previous?.releaseId === candidate.manifest.releaseId) {
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
      committed = publishRuntimeRelease(
        config.controllerHome,
        candidate.manifestPath,
        operationId,
      );
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
    // The Connector is independently supervised, but its package snapshot proxies
    // the Canonical Runtime. Starting/rebinding it while the Runtime is stopped
    // creates a dependency cycle: Connector readiness waits on a Runtime that has
    // not started yet. Start the candidate first, require Runtime-only readiness,
    // then rebind the Connector and finally require whole-Runtime verification.
    let candidateConnectorBinding: { ok: boolean; attempted: boolean; noOp?: boolean; detail: string } | undefined;
    let storageMigration: ControllerHomeStorageMigration | undefined;
    let activationFailureDetail: string | undefined;
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
      afterRuntimeReady: async () => {
        candidateConnectorBinding = await repairConnectorBinding(config);
        if (candidateConnectorBinding.ok) return { ok: true, detail: candidateConnectorBinding.detail };
        const detail = `persistent Connector binding failed after Runtime readiness: ${candidateConnectorBinding.detail}`;
        activationFailureDetail = detail;
        audit(config, 'runtime_release_activation_connector_binding_failed', {
          serviceTarget: service.target,
          operationId,
          requestId: lockRequestId,
          detail: candidateConnectorBinding.detail,
        });
        return { ok: false, detail };
      },
    });
    let after = activated.verify;
    if (activated.ok && after.releases.active?.revision === candidate.manifest.releaseId) {
      let activationReady = true;
      let releaseSessionTransactionPersisted = false;
      if (!guard.preserveDatabaseOnFailure && guard.releaseSessionId?.trim()) {
        try {
          const authority = readRuntimeReleaseAuthority(config.controllerHome);
          const session = readReleaseSession(config.controllerHome, guard.releaseSessionId.trim());
          if (
            !authority
            || authority.operationId !== operationId
            || !authority.previous?.databaseBackup
            || !session
            || session.phase !== 'cutover_attempting'
          ) throw new Error('RELEASE_SESSION_TRANSACTION_CAPTURE_PRECONDITION_FAILED');
          recordReleaseSessionTransaction({
            controllerHome: config.controllerHome,
            sessionId: session.sessionId,
            expectedRevision: session.revision,
            transaction: {
              schemaVersion: 1,
              operationId,
              candidateReleaseId: candidate.manifest.releaseId,
              cutoverAuthorityRevision: authority.revision,
              rollbackRelease: authority.previous,
              startedAt: authority.committedAt,
            },
          });
          releaseSessionTransactionPersisted = true;
        } catch (error) {
          activationReady = false;
          activationFailureDetail = `Runtime became healthy but ReleaseSession rollback transaction capture failed: ${error instanceof Error ? error.message : String(error)}`;
          audit(config, 'release_session_transaction_capture_failed', {
            serviceTarget: service.target,
            operationId,
            requestId: lockRequestId,
            releaseSessionId: guard.releaseSessionId.trim(),
            detail: activationFailureDetail,
          });
        }
      }
      if (activationReady) {
        audit(config, 'runtime_release_activation_succeeded', {
          serviceTarget: service.target,
          operationId,
          requestId: lockRequestId,
          activeRevision: after.releases.active?.revision,
          expectedAuthorityRevision: guard.expectedAuthorityRevision,
          expectedActiveReleaseId: guard.expectedActiveReleaseId,
          controllerHomeStorageMigrated: storageMigration?.migrated === true,
          connectorBindingRepaired: candidateConnectorBinding?.attempted === true,
          releaseSessionTransactionPersisted,
          ...(guard.releaseSessionId?.trim() ? { releaseSessionId: guard.releaseSessionId.trim() } : {}),
        });
        return {
          ok: true,
          attempted: true,
          detail: releaseSessionTransactionPersisted
            ? 'requested Runtime release activated and verified; physical activation committed and ReleaseSession owns rollback authority through soak'
            : storageMigration?.migrated
              ? 'requested Runtime release activated, Controller Home migrated to .noindex storage, persistent Connector rebound, and whole-Runtime verification passed'
              : 'requested Runtime release activated, persistent Connector rebound, and whole-Runtime verification passed',
          serviceTarget: service.target,
          operationId,
          verify: after,
        } satisfies RuntimeReleaseActivationResult;
      }
    }
    if (!activated.ok && !activationFailureDetail) {
      activationFailureDetail = activated.detail;
      const auditAction = /^primary Runtime (launchd|systemd-user) contract rebuild failed/.test(activated.detail)
        ? 'runtime_release_activation_service_contract_failed'
        : activated.detail.startsWith('release transition pre-start preparation failed')
          ? 'runtime_controller_home_noindex_migration_failed'
          : activated.detail.includes('start')
            ? 'runtime_release_activation_start_failed'
            : 'runtime_release_activation_unverified';
      audit(config, auditAction, { serviceTarget: service.target, operationId, detail: activated.detail });
    } else if (!activationFailureDetail) {
      activationFailureDetail = `activated Runtime release identity mismatch: expected ${candidate.manifest.releaseId}, observed ${after.releases.active?.revision ?? 'none'}`;
      audit(config, 'runtime_release_activation_commit_mismatch', { serviceTarget: service.target, operationId, detail: activationFailureDetail });
    }

    // Activation failed: stop and restore the previous whole release. SQLite
    // rollback is allowed only when the live durable-mutation generation still
    // equals the captured backup; newer Controller Home state is preserved.
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
        const rollbackOperationId = guard.preserveDatabaseOnFailure
          ? `recovery-activate-runtime-rollback-${Date.now()}-${randomUUID().slice(0, 8)}`
          : operationId;
        let rollbackDatabaseDisposition: RuntimeDatabaseRollbackDisposition | 'preserved_by_guard' = 'preserved_by_guard';
        const restored = guard.preserveDatabaseOnFailure && previousActive
          ? publishRuntimeRelease(config.controllerHome, previousActive.manifestPath, rollbackOperationId)
          : (() => {
            const rollbackResult = rollbackRuntimeReleaseWithResult(config.controllerHome, rollbackOperationId);
            rollbackDatabaseDisposition = rollbackResult.databaseDisposition;
            return rollbackResult.authority;
          })();
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
        let rollbackConnectorBinding: { ok: boolean; attempted: boolean; noOp?: boolean; detail: string } | undefined;
        const restarted = await rebindStartAndVerifyPrimaryRuntime({
          config,
          service,
          runCommand,
          now,
          wait,
          verifyLocal,
          contractFailureContext: 'after rollback',
          timeoutMs: configuredPrimaryRuntimeService(config).postRestartVerifyTimeoutMs ?? 60_000,
          successDetail: rollbackDatabaseDisposition === 'restored_backup'
            ? 'previous whole-Runtime release and unchanged SQLite backup restored, restarted, rebound, and verified'
            : 'previous Runtime release restored while live SQLite state was preserved, restarted, rebound, and verified',
          afterRuntimeReady: async () => {
            rollbackConnectorBinding = await repairConnectorBinding(config);
            if (rollbackConnectorBinding.ok) return { ok: true, detail: rollbackConnectorBinding.detail };
            audit(config, 'runtime_release_activation_rollback_connector_binding_failed', {
              serviceTarget: service.target,
              operationId,
              rollbackOperationId,
              detail: rollbackConnectorBinding.detail,
            });
            return {
              ok: false,
              detail: `previous persistent Connector binding failed after rollback Runtime readiness: ${rollbackConnectorBinding.detail}`,
            };
          },
        });
        rollback = {
          ok: restarted.ok,
          operationId: rollbackOperationId,
          detail: restarted.detail,
          verify: restarted.verify,
        };
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
  };

  if (heldRecoveryLock) {
    const live = liveRecoveryMutationLock(config);
    if (
      !live
      || live.instanceId !== heldRecoveryLock.instanceId
      || live.pid !== heldRecoveryLock.pid
      || live.processStartTime !== heldRecoveryLock.processStartTime
    ) {
      return {
        ok: false,
        attempted: false,
        noOp: true,
        detail: 'RECOVERY_OPERATION_LOCK_AUTHORITY_CHANGED',
        serviceTarget: service.target,
        verify: await verifyStableRuntime(config),
      };
    }
    return activateUnderRecoveryAuthority();
  }

  const locked = await withLock(
    config,
    { action: 'activate_runtime_release', requestId: lockRequestId },
    async () => activateUnderRecoveryAuthority(),
  );
  if (!locked.acquired) {
    return { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner), serviceTarget: service.target, verify: await verifyStableRuntime(config) };
  }
  return locked.value;
}

export async function activateRuntimeRelease(
  config: RecoveryConfig,
  candidateManifestPath: string,
  dependencies: PrimaryRuntimeRecoveryDependencies = {},
  guard: RuntimeReleaseActivationGuard = {},
): Promise<RuntimeReleaseActivationResult> {
  return activateRuntimeReleaseInternal(config, candidateManifestPath, dependencies, guard);
}

export async function activatePinnedRuntimeRelease(
  config: RecoveryConfig,
  dependencies: PrimaryRuntimeRecoveryDependencies = {},
  guard: RuntimeReleaseActivationGuard = {},
): Promise<RuntimeReleaseActivationResult> {
  let pin: RuntimePinStore | undefined;
  try { pin = runtimePin(config); }
  catch (error) { return { ok: false, attempted: false, noOp: true, detail: error instanceof Error ? error.message : String(error) }; }
  if (!pin) return { ok: false, attempted: false, noOp: true, detail: 'RUNTIME_PIN_REQUIRED: no Runtime release is pinned' };
  let candidate: { manifest: RuntimeReleaseManifest; releaseRoot: string; manifestPath: string };
  try { candidate = validateRuntimeReleaseCandidate(config, pin.release.path); }
  catch (error) { return { ok: false, attempted: false, noOp: true, detail: error instanceof Error ? error.message : String(error) }; }
  if (candidate.manifest.deploymentScope === 'portable') {
    return {
      ok: false,
      attempted: false,
      noOp: true,
      detail: 'RUNTIME_PIN_PORTABLE_RELEASE_FORBIDDEN: portable source candidates require a verified Recovery ReleaseSession',
    };
  }
  let observed: ReleaseEvidence;
  try { observed = releaseEvidenceForPin(config, candidate); }
  catch (error) { return { ok: false, attempted: false, noOp: true, detail: error instanceof Error ? error.message : String(error) }; }
  if (observed.revision !== pin.release.revision || observed.artifactIdentity !== pin.release.artifactIdentity || observed.manifestSha256 !== pin.release.manifestSha256) {
    return { ok: false, attempted: false, noOp: true, detail: 'RUNTIME_PIN_IDENTITY_MISMATCH: pinned immutable release changed on disk' };
  }
  return activateRuntimeRelease(config, pin.release.path, dependencies, {
    ...guard,
    allowPreviousRelease: true,
    preserveDatabaseOnFailure: true,
    requiredPinnedReleaseRevision: pin.release.revision,
  });
}


function configuredSourceRevision(sourceRoot: string): string {
  const env = {
    ...runtimeAuthorityFreeEnvironment(process.env),
    PATH: recoveryCommandPath(),
  };
  // ReleaseSession source authority is the exact committed Git object selected
  // internally by Recovery. The configured checkout is only an object/dependency
  // provider: concurrent working-tree edits are intentionally non-authoritative
  // and are excluded by the detached immutable source snapshot used below.
  const head = spawnSync('git', ['-C', sourceRoot, 'rev-parse', '--verify', 'HEAD^{commit}'], {
    encoding: 'utf8',
    env,
    timeout: 10_000,
  });
  const revision = (head.stdout ?? '').trim();
  if (head.status !== 0 || !/^[a-f0-9]{40}$/i.test(revision)) {
    throw new Error('RELEASE_SESSION_SOURCE_REVISION_UNAVAILABLE');
  }
  return revision;
}

export interface ConfiguredRuntimeReleaseSourceState {
  configured: boolean;
  sourceRevision?: string;
  activeSourceCommit?: string;
  activeReleaseId?: string;
}

/**
 * Read the two immutable identities used only to decide whether automatic
 * release reconciliation is warranted. This does not create or advance a
 * ReleaseSession and therefore never becomes release intent authority.
 */
export function configuredRuntimeReleaseSourceState(config: RecoveryConfig): ConfiguredRuntimeReleaseSourceState {
  const sourceRoot = config.primaryRuntimeSourceRoot?.trim();
  if (!sourceRoot) return { configured: false };
  const authority = readRuntimeReleaseAuthority(config.controllerHome);
  if (!authority) throw new Error('RELEASE_AUTOMATION_ACTIVE_RELEASE_AUTHORITY_UNKNOWN');
  const manifest = loadRuntimeReleaseManifest(authority.active.manifestPath, config.controllerHome);
  return {
    configured: true,
    sourceRevision: configuredSourceRevision(sourceRoot),
    activeSourceCommit: manifest.sourceCommit?.trim() || undefined,
    activeReleaseId: authority.active.releaseId,
  };
}

async function allocateCandidateLoopbackPort(stablePort: number): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = await new Promise<number>((resolvePort, rejectPort) => {
      const server = createNetServer();
      server.unref();
      server.once('error', rejectPort);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        const address = server.address();
        const selected = address && typeof address === 'object' ? address.port : 0;
        server.close((error) => error ? rejectPort(error) : resolvePort(selected));
      });
    });
    if (port > 0 && port !== stablePort) return port;
  }
  throw new Error('RELEASE_SESSION_CANDIDATE_PORT_UNAVAILABLE');
}

function stableReleaseSessionIdentity(config: RecoveryConfig): ReleaseSessionStableRelease {
  const authority = releaseAuthority(config);
  if (!authority) throw new Error('RELEASE_SESSION_STABLE_RELEASE_AUTHORITY_REQUIRED');
  return {
    authorityRevision: authority.revision,
    releaseId: authority.active.releaseId,
    artifactIdentity: authority.active.artifactIdentity,
    manifestSha256: authority.active.manifestSha256,
    workerProtocolVersion: authority.active.workerProtocolVersion,
    releaseFencingTokenSha256: createHash('sha256').update(authority.fencingToken).digest('hex'),
  };
}

function sameStableReleaseSessionIdentity(left: ReleaseSessionStableRelease, right: ReleaseSessionStableRelease): boolean {
  return left.authorityRevision === right.authorityRevision
    && left.releaseId === right.releaseId
    && left.artifactIdentity === right.artifactIdentity
    && left.manifestSha256 === right.manifestSha256
    && left.workerProtocolVersion === right.workerProtocolVersion
    && left.releaseFencingTokenSha256 === right.releaseFencingTokenSha256;
}

function assertStableReleaseSessionIdentityCurrent(config: RecoveryConfig, expected: ReleaseSessionStableRelease): void {
  const actual = stableReleaseSessionIdentity(config);
  if (
    actual.authorityRevision !== expected.authorityRevision
    || actual.releaseId !== expected.releaseId
    || actual.artifactIdentity !== expected.artifactIdentity
    || actual.manifestSha256 !== expected.manifestSha256
    || actual.workerProtocolVersion !== expected.workerProtocolVersion
    || actual.releaseFencingTokenSha256 !== expected.releaseFencingTokenSha256
  ) throw new Error('RELEASE_SESSION_STABLE_AUTHORITY_CHANGED');
}

function candidateControllerHomeForSession(config: RecoveryConfig, sessionId: string): string {
  return join(dirname(resolve(config.controllerHome)), 'candidate-runtime-lanes', sessionId);
}

export async function prepareConfiguredRuntimeReleaseSession(
  config: RecoveryConfig,
  dependencies: Pick<ConfiguredRuntimeActivationDependencies, 'stage'> = {},
  requestId?: string,
): Promise<ConfiguredRuntimeActivationResult> {
  const sourceRoot = config.primaryRuntimeSourceRoot?.trim();
  if (!sourceRoot) return { ok: false, attempted: false, noOp: true, detail: 'primary Runtime source root is not configured in standalone Recovery' };
  const sourceRepositoryId = config.primaryRuntimeSourceRepositoryId?.trim();
  if (!sourceRepositoryId) return { ok: false, attempted: false, noOp: true, detail: 'primary Runtime source repository id is not configured in standalone Recovery' };

  const verifiedStable = await verifyStableRuntime(config);
  if (!verifiedStable.ok) {
    return { ok: false, attempted: false, noOp: true, detail: 'RELEASE_SESSION_STABLE_RUNTIME_NOT_VERIFIED' };
  }

  const locked = await withLock(config, {
    action: 'release_session_prepare',
    ...(requestId?.trim() ? { requestId: requestId.trim() } : {}),
  }, async () => {
    const stable = readStableExecutionLane(config.controllerHome);
    const stableRelease = stableReleaseSessionIdentity(config);
    const sourceRevision = configuredSourceRevision(sourceRoot);

    // ReleaseSession owns semantic progression. This Recovery lock serializes only
    // physical preparation. Resume the exact source_frozen session after an
    // interruption instead of inventing a second release authority.
    const inventory = listReleaseSessions(config.controllerHome, { maxEntries: 512 });
    if (inventory.truncated || inventory.invalidSessionFiles.length > 0) {
      return {
        ok: false as const,
        attempted: false,
        noOp: true,
        detail: `RELEASE_SESSION_INVENTORY_INCOMPLETE: truncated=${inventory.truncated}; invalid=${inventory.invalidSessionFiles.join(',') || 'none'}`,
      };
    }
    let resumableSourceFrozen: ReleaseSession | undefined;
    for (const existing of [...inventory.sessions].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))) {
      if (existing.phase === 'failed' || existing.phase === 'rolled_back' || existing.phase === 'known_good') continue;
      if (
        existing.phase === 'source_frozen'
        && existing.sourceRevision === sourceRevision
        && sameStableReleaseSessionIdentity(existing.stableRelease, stableRelease)
      ) {
        if (resumableSourceFrozen) {
          return {
            ok: false as const,
            attempted: false,
            noOp: true,
            detail: `RELEASE_SESSION_MULTIPLE_ACTIVE: ${resumableSourceFrozen.sessionId}:source_frozen,${existing.sessionId}:source_frozen`,
          };
        }
        resumableSourceFrozen = existing;
        continue;
      }
      if (existing.phase === 'cutover_attempting' || existing.phase === 'cutover_committed') {
        return {
          ok: false as const,
          attempted: false,
          noOp: true,
          detail: `RELEASE_SESSION_PREPARE_REQUIRES_RECONCILIATION: ${existing.sessionId}:${existing.phase}`,
          releaseSession: existing,
        };
      }
      if (existing.phase === 'soaking') {
        const candidate = existing.candidateRelease;
        const candidateIsCurrentStable = Boolean(candidate
          && candidate.releaseId === stableRelease.releaseId
          && candidate.artifactIdentity === stableRelease.artifactIdentity);
        if (candidateIsCurrentStable) {
          return {
            ok: false as const,
            attempted: false,
            noOp: true,
            detail: `RELEASE_SESSION_PREPARE_REQUIRES_SOAK_RESOLUTION: ${existing.sessionId}`,
            releaseSession: existing,
          };
        }
        continue;
      }
      const superseded = await cancelReleaseSessionUnderLock(
        config,
        existing,
        'superseded by a newer ReleaseSession source freeze',
      );
      if (!superseded.ok) return superseded;
    }

    // Candidate B currently costs several GiB because it contains a consistent
    // SQLite snapshot plus an immutable Runtime tree. Preserve the host warning
    // reserve *after* admitting a conservative 4 GiB candidate budget.
    const candidateRoot = join(dirname(resolve(config.controllerHome)), 'candidate-runtime-lanes');
    assertStorageHeadroom(candidateRoot, {
      operation: 'release_session_prepare',
      requiredBytes: 4 * 1024 ** 3,
      reserveBytes: STORAGE_WARNING_BYTES,
    });

    let session: ReleaseSession;
    let candidateLane: ReturnType<typeof createCandidateExecutionLane>['candidate'];
    if (resumableSourceFrozen) {
      session = resumableSourceFrozen;
      candidateLane = session.candidate;
    } else {
      const nextSessionId = `release-${Date.now()}-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      const candidatePort = await allocateCandidateLoopbackPort(stable.port);
      candidateLane = createCandidateExecutionLane({
        stableControllerHome: stable.controllerHome,
        candidateControllerHome: candidateControllerHomeForSession(config, nextSessionId),
        candidatePort,
        sessionId: nextSessionId,
      }).candidate;
      session = createReleaseSession({
        controllerHome: config.controllerHome,
        sessionId: nextSessionId,
        stable,
        stableRelease,
        candidate: candidateLane,
        sourceRevision,
      });
    }
    const sessionId = session.sessionId;

    try {
      assertStableReleaseSessionIdentityCurrent(config, stableRelease);
      const staged = withRuntimeReleaseSourceSnapshot({ sourceRoot, sourceRevision }, frozenSourceRoot =>
        (dependencies.stage ?? stageRuntimeReleaseFromCandidateSource)({
          controllerHome: candidateLane.controllerHome,
          sourceRoot: frozenSourceRoot,
          dependencyRoot: sourceRoot,
          sourceRepositoryId,
        }));
      assertRuntimeReleaseFiles(staged);
      if (staged.sourceCommit !== sourceRevision) throw new Error('RELEASE_SESSION_SOURCE_CHANGED_DURING_BUILD');
      const candidateRelease: ReleaseSessionCandidateRelease = {
        releaseId: staged.releaseId,
        manifestPath: staged.manifestPath,
        artifactIdentity: staged.artifactIdentity,
        manifestSha256: staged.manifestSha256,
        treeSha256: runtimeReleaseTreeSha256(staged.releasePath),
        sourceCommit: staged.sourceCommit,
        ...(staged.sourceRepositoryId ? { sourceRepositoryId: staged.sourceRepositoryId } : {}),
      };
      assertStableReleaseSessionIdentityCurrent(config, stableRelease);
      session = advanceReleaseSession({
        controllerHome: config.controllerHome,
        sessionId,
        expectedRevision: session.revision,
        phase: 'built',
        candidateRelease,
        receipts: [{
          id: 'build',
          kind: 'build',
          summary: `portable candidate ${staged.releaseId} built under isolated Candidate B; Stable A unchanged`,
        }],
      });
      audit(config, 'release_session_candidate_built', {
        sessionId,
        sourceRevision,
        stableReleaseId: stableRelease.releaseId,
        stableAuthorityRevision: stableRelease.authorityRevision,
        candidateControllerHome: candidateLane.controllerHome,
        candidatePort: candidateLane.port,
        candidateReleaseId: staged.releaseId,
        candidateTreeSha256: candidateRelease.treeSha256,
      });
      return {
        ok: true as const,
        attempted: true,
        detail: 'configured Runtime source was built into an isolated Candidate B ReleaseSession; Stable A was not stopped or activated',
        staged,
        releaseSession: session,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      try {
        session = advanceReleaseSession({
          controllerHome: config.controllerHome,
          sessionId,
          expectedRevision: session.revision,
          phase: 'failed',
          receipts: [{ id: 'build_failed', kind: 'build', summary: detail.slice(0, 500) }],
        });
      } catch { /* Preserve the original build failure. */ }
      cleanupRetiredCandidateLane(config, session);
      audit(config, 'release_session_candidate_build_failed', { sessionId, sourceRevision, detail });
      return { ok: false as const, attempted: true, detail, releaseSession: session };
    }
  });

  if (!locked.acquired) {
    return { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner) };
  }
  return locked.value;
}


const RELEASE_SESSION_STATIC_GATES = [
  { id: 'type', args: ['run', 'check:type'], timeoutMs: 10 * 60_000 },
  { id: 'runtime_architecture', args: ['run', 'check:runtime-architecture'], timeoutMs: 5 * 60_000 },
  { id: 'architecture_sync', args: ['run', 'check:architecture-sync'], timeoutMs: 5 * 60_000 },
  { id: 'bootstrap', args: ['run', 'check:bootstrap-files'], timeoutMs: 5 * 60_000 },
] as const;

export async function verifyConfiguredRuntimeReleaseSessionStaticGates(
  config: RecoveryConfig,
  sessionId: string,
  requestId?: string,
): Promise<ConfiguredRuntimeActivationResult> {
  const sourceRoot = config.primaryRuntimeSourceRoot?.trim();
  if (!sourceRoot) return { ok: false, attempted: false, noOp: true, detail: 'primary Runtime source root is not configured in standalone Recovery' };
  const locked = await withLock(config, {
    action: 'release_session_static_verify',
    ...(requestId?.trim() ? { requestId: requestId.trim() } : {}),
  }, async () => {
    let session = readReleaseSession(config.controllerHome, sessionId);
    if (!session) return { ok: false as const, attempted: false, noOp: true, detail: 'RELEASE_SESSION_MISSING' };
    if (session.phase !== 'built') {
      return { ok: false as const, attempted: false, noOp: true, detail: `RELEASE_SESSION_STATIC_VERIFY_REQUIRES_BUILT: ${session.phase}`, releaseSession: session };
    }
    const candidate = session.candidateRelease;
    if (!candidate) return { ok: false as const, attempted: false, noOp: true, detail: 'RELEASE_SESSION_CANDIDATE_RELEASE_REQUIRED', releaseSession: session };
    const frozenSourceRevision = session.sourceRevision;
    const stableRelease = session.stableRelease;
    try {
      assertStableReleaseSessionIdentityCurrent(config, stableRelease);
      const manifest = loadRuntimeReleaseManifest(candidate.manifestPath, session.candidate.controllerHome);
      if (
        manifest.deploymentScope !== 'portable'
        || manifest.releaseId !== candidate.releaseId
        || manifest.artifactIdentity !== candidate.artifactIdentity
        || createHash('sha256').update(readFileSync(candidate.manifestPath)).digest('hex') !== candidate.manifestSha256
        || runtimeReleaseTreeSha256(dirname(candidate.manifestPath)) !== candidate.treeSha256
      ) throw new Error('RELEASE_SESSION_CANDIDATE_IDENTITY_MISMATCH');

      const receipts = withRuntimeReleaseSourceSnapshot({
        sourceRoot,
        sourceRevision: frozenSourceRevision,
      }, frozenSourceRoot => {
        const gateReceipts: Array<{ id: string; kind: 'static_gate'; summary: string }> = [];
        for (const gate of RELEASE_SESSION_STATIC_GATES) {
          assertStableReleaseSessionIdentityCurrent(config, stableRelease);
          const startedAt = Date.now();
          const result = spawnSync(resolveBunExecutable(), gate.args, {
            cwd: frozenSourceRoot,
            env: { ...runtimeAuthorityFreeEnvironment(process.env), PATH: recoveryCommandPath() },
            encoding: 'utf8',
            timeout: gate.timeoutMs,
            maxBuffer: 8 * 1024 * 1024,
          });
          const durationMs = Date.now() - startedAt;
          if (result.error || result.status !== 0) {
            const detail = result.error instanceof Error
              ? result.error.message
              : (result.stderr || result.stdout || `exit ${result.status ?? 'unknown'}`).trim().slice(-2000);
            throw new Error(`RELEASE_SESSION_STATIC_GATE_FAILED:${gate.id}: ${detail}`);
          }
          gateReceipts.push({
            id: gate.id,
            kind: 'static_gate',
            summary: `${gate.id} passed on frozen source ${frozenSourceRevision} in ${durationMs}ms`,
          });
        }
        return gateReceipts;
      });
      assertStableReleaseSessionIdentityCurrent(config, session.stableRelease);
      session = advanceReleaseSession({
        controllerHome: config.controllerHome,
        sessionId,
        expectedRevision: session.revision,
        phase: 'static_verified',
        receipts,
      });
      audit(config, 'release_session_static_verified', {
        sessionId,
        sourceRevision: session.sourceRevision,
        candidateReleaseId: candidate.releaseId,
        gates: RELEASE_SESSION_STATIC_GATES.map((gate) => gate.id),
      });
      return {
        ok: true as const,
        attempted: true,
        detail: 'ReleaseSession static gates passed on the frozen source revision; Stable A remained unchanged',
        releaseSession: session,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      try {
        session = advanceReleaseSession({
          controllerHome: config.controllerHome,
          sessionId,
          expectedRevision: session.revision,
          phase: 'failed',
          receipts: [{ id: 'static_failed', kind: 'static_gate', summary: detail.slice(0, 500) }],
        });
      } catch { /* preserve the original static verification failure */ }
      cleanupRetiredCandidateLane(config, session);
      audit(config, 'release_session_static_failed', { sessionId, detail });
      return { ok: false as const, attempted: true, detail, releaseSession: session };
    }
  });
  if (!locked.acquired) return { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner) };
  return locked.value;
}


function candidateRecoveryConfig(session: ReleaseSession): RecoveryConfig {
  return {
    schemaVersion: 1,
    controllerHome: session.candidate.controllerHome,
    installProfile: 'manual',
    primaryRuntimeService: defaultPrimaryRuntimeServiceConfig(),
    mainMcpTokenFile: session.candidate.authTokenFile,
    readOnlyTool: {
      name: STABLE_RECOVERY_READ_ONLY_TOOL.name,
      arguments: { ...STABLE_RECOVERY_READ_ONLY_TOOL.arguments },
    },
  };
}

async function installReleaseSessionCandidateService(
  session: ReleaseSession,
  runCommand: CommandRunner = command,
): Promise<void> {
  const candidateRelease = session.candidateRelease;
  if (!candidateRelease) throw new Error('RELEASE_SESSION_CANDIDATE_RELEASE_REQUIRED');
  const home = session.candidate.controllerHome;
  const serviceConfig = readForgeRuntimeServiceConfig(forgeRuntimeServicePaths(home).configPath);
  if (
    resolve(serviceConfig.controllerHome) !== resolve(home)
    || serviceConfig.port !== session.candidate.port
    || resolve(serviceConfig.authTokenFile) !== resolve(session.candidate.authTokenFile)
  ) throw new Error('RELEASE_SESSION_CANDIDATE_SERVICE_CONTRACT_MISMATCH');

  const operationId = `release-session-candidate-${session.sessionId}`;
  const authority = publishRuntimeRelease(home, candidateRelease.manifestPath, operationId);
  if (
    authority.active.releaseId !== candidateRelease.releaseId
    || authority.active.artifactIdentity !== candidateRelease.artifactIdentity
    || authority.active.manifestSha256 !== candidateRelease.manifestSha256
  ) throw new Error('RELEASE_SESSION_CANDIDATE_AUTHORITY_MISMATCH');
  syncForgeRuntimeActiveEntrypoint(home);

  if (process.platform === 'darwin') {
    await installForgeRuntimeService({
      config: serviceConfig,
      // Ignored in release mode; a non-empty bounded path keeps bootstrap fallback explicit.
      runnerPath: candidateRelease.manifestPath,
    });
    return;
  }
  if (process.platform === 'linux') {
    const env = runtimeAuthorityFreeEnvironment(process.env);
    writePackageRuntimeSystemdUserService(home, env);
    for (const argv of systemdRuntimeInstallCommands(forgeRuntimeServicePaths(home).label)) {
      const [executable, ...args] = argv;
      if (!executable) continue;
      const result = await runCommand(executable, args, 20_000);
      if (!result.ok) throw new Error(`RELEASE_SESSION_CANDIDATE_SYSTEMD_INSTALL_FAILED: ${result.stderr || result.stdout || executable}`);
    }
    return;
  }
  throw new Error(`RELEASE_SESSION_CANDIDATE_SERVICE_PLATFORM_UNSUPPORTED: ${process.platform}`);
}

interface ReleaseSessionCandidateRetirement {
  ok: boolean;
  detail: string;
}

function cleanupRetiredCandidateLane(config: RecoveryConfig, session: ReleaseSession): ReleaseSessionCandidateRetirement {
  try {
    removeRetiredCandidateExecutionLane(session.stable, session.candidate);
    audit(config, 'release_session_candidate_lane_cleaned', {
      sessionId: session.sessionId,
      candidateControllerHome: session.candidate.controllerHome,
      phase: session.phase,
    });
    return { ok: true, detail: 'Candidate B Controller Home was removed after terminal ReleaseSession cleanup' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    audit(config, 'release_session_candidate_lane_cleanup_failed', {
      sessionId: session.sessionId,
      candidateControllerHome: session.candidate.controllerHome,
      phase: session.phase,
      detail,
    });
    return { ok: false, detail };
  }
}

async function stopReleaseSessionCandidateService(
  session: ReleaseSession,
  runCommand: CommandRunner = command,
): Promise<ReleaseSessionCandidateRetirement> {
  const home = session.candidate.controllerHome;
  try {
    if (process.platform === 'darwin') {
      try {
        await uninstallForgeRuntimeService(home);
      } catch (error) {
        const uid = await currentUid();
        if (uid === undefined) {
          return { ok: false, detail: error instanceof Error ? error.message : String(error) };
        }
        const paths = forgeRuntimeServicePaths(home);
        const loaded = await runCommand('launchctl', ['print', `gui/${uid}/${paths.label}`], 5_000);
        if (loaded.ok) {
          return { ok: false, detail: error instanceof Error ? error.message : String(error) };
        }
        // An already-absent launchd job is an idempotent retirement. Remove only
        // its stale installed declaration, then verify the Runtime itself below.
        rmSync(paths.installedPlistPath, { force: true });
      }
    } else if (process.platform === 'linux') {
      const label = forgeRuntimeServicePaths(home).label;
      const unitName = systemdUserUnitName(label);
      const stopped = await runCommand('systemctl', ['--user', 'disable', '--now', unitName], 20_000);
      const stoppedDetail = `${stopped.stderr}\n${stopped.stdout}`;
      if (!stopped.ok && !/not loaded|not found|does not exist|no such file/i.test(stoppedDetail)) {
        return { ok: false, detail: `RELEASE_SESSION_CANDIDATE_SYSTEMD_STOP_FAILED: ${stoppedDetail.trim() || stopped.status}` };
      }
      rmSync(systemdUserUnitPath(unitName), { force: true });
      const reloaded = await runCommand('systemctl', ['--user', 'daemon-reload'], 20_000);
      if (!reloaded.ok) {
        return { ok: false, detail: `RELEASE_SESSION_CANDIDATE_SYSTEMD_RELOAD_FAILED: ${reloaded.stderr || reloaded.stdout || reloaded.status}` };
      }
    } else {
      return { ok: false, detail: `RELEASE_SESSION_CANDIDATE_SERVICE_PLATFORM_UNSUPPORTED: ${process.platform}` };
    }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  const observation = observeRuntimeStatus(home);
  if (observation.running) {
    return { ok: false, detail: 'RELEASE_SESSION_CANDIDATE_STILL_RUNNING_AFTER_RETIREMENT' };
  }
  return { ok: true, detail: 'Candidate B persistent service is absent and its Runtime process is not running' };
}

function candidateCanaryReceipts(
  session: ReleaseSession,
  verified: VerifyResult,
): Array<{ id: string; kind: 'candidate_canary'; summary: string }> {
  const observation = observeRuntimeStatus(session.candidate.controllerHome);
  const diagnostics = observation.snapshot?.readiness.diagnostics;
  const mcpProbeNames = ['mcp_initialize', 'mcp_initialized_notification', 'mcp_tools_list', 'mcp_read_only_call', 'mcp_session_close'];
  const failedMcp = mcpProbeNames.filter((name) => verified.probes[name]?.ok !== true);
  if (failedMcp.length > 0) throw new Error(`RELEASE_SESSION_CANDIDATE_MCP_CANARY_FAILED: ${failedMcp.join(',')}`);
  if (diagnostics?.scheduler.outcome !== 'pass') throw new Error('RELEASE_SESSION_CANDIDATE_SCHEDULER_CANARY_FAILED');
  if (diagnostics?.database.outcome !== 'pass' || diagnostics?.releaseCoherence.outcome !== 'pass' || diagnostics?.mcpEndToEnd.outcome !== 'pass') {
    throw new Error('RELEASE_SESSION_CANDIDATE_RUNTIME_DIAGNOSTICS_FAILED');
  }
  const supervisorSocket = workflowSupervisorSocketPath(resolveWorkflowSupervisorForgeHome(session.candidate.controllerHome));
  if (!existsSync(supervisorSocket)) throw new Error('RELEASE_SESSION_CANDIDATE_SUPERVISOR_CANARY_FAILED');
  return [
    { id: 'recovery', kind: 'candidate_canary', summary: 'Candidate B stopped and restarted through Recovery service lifecycle and returned whole-Runtime healthy' },
    { id: 'mcp', kind: 'candidate_canary', summary: 'Candidate B MCP initialize/tools-list/read-only-call/session-close passed using the Candidate credential' },
    { id: 'scheduler', kind: 'candidate_canary', summary: 'Candidate B scheduler readiness diagnostic passed after recovery restart' },
    { id: 'supervisor', kind: 'candidate_canary', summary: `Candidate B Workflow Supervisor socket is live at ${supervisorSocket}` },
    { id: 'controller', kind: 'candidate_canary', summary: 'Candidate B controller read-only facade completed through MCP after restart' },
  ];
}

export async function bootAndVerifyConfiguredRuntimeReleaseSessionCandidate(
  config: RecoveryConfig,
  sessionId: string,
  requestId?: string,
): Promise<ConfiguredRuntimeActivationResult> {
  const locked = await withLock(config, {
    action: 'release_session_candidate_boot',
    ...(requestId?.trim() ? { requestId: requestId.trim() } : {}),
  }, async () => {
    let session = readReleaseSession(config.controllerHome, sessionId);
    if (!session) return { ok: false as const, attempted: false, noOp: true, detail: 'RELEASE_SESSION_MISSING' };
    if (session.phase === 'candidate_booted') {
      const retirement = await stopReleaseSessionCandidateService(session);
      if (!retirement.ok) {
        return {
          ok: false as const,
          attempted: true,
          detail: `Candidate B boot/restart canary was interrupted and retirement failed: ${retirement.detail}`,
          releaseSession: session,
        };
      }
      session = advanceReleaseSession({
        controllerHome: config.controllerHome,
        sessionId,
        expectedRevision: session.revision,
        phase: 'failed',
        receipts: [{
          id: 'candidate_failed',
          kind: 'candidate_canary',
          summary: 'Candidate B boot/restart canary was interrupted; Candidate B was retired before terminalizing the ReleaseSession',
        }],
      });
      cleanupRetiredCandidateLane(config, session);
      return {
        ok: false as const,
        attempted: true,
        detail: 'Candidate B boot/restart canary was interrupted; Candidate B is retired and the ReleaseSession is terminal failed',
        releaseSession: session,
      };
    }
    if (session.phase !== 'static_verified') {
      return { ok: false as const, attempted: false, noOp: true, detail: `RELEASE_SESSION_CANDIDATE_BOOT_REQUIRES_STATIC_VERIFIED: ${session.phase}`, releaseSession: session };
    }
    const candidateRelease = session.candidateRelease;
    if (!candidateRelease) return { ok: false as const, attempted: false, noOp: true, detail: 'RELEASE_SESSION_CANDIDATE_RELEASE_REQUIRED', releaseSession: session };
    const runCommand = command;
    const candidateConfig = candidateRecoveryConfig(session);
    try {
      assertStableReleaseSessionIdentityCurrent(config, session.stableRelease);
      if (runtimeReleaseTreeSha256(dirname(candidateRelease.manifestPath)) !== candidateRelease.treeSha256) {
        throw new Error('RELEASE_SESSION_CANDIDATE_TREE_CHANGED');
      }
      await installReleaseSessionCandidateService(session, runCommand);

      let initialVerify = await verifyPrimaryRuntimeAfterStart({
        config: candidateConfig,
        timeoutMs: 60_000,
        now: Date.now,
        wait: sleep,
        verifyLocal: verifyLocalRuntime,
      });
      if (!initialVerify.ok) throw new Error(`RELEASE_SESSION_CANDIDATE_BOOT_UNVERIFIED: ${initialVerify.runtime.reasonCodes.join(',')}`);
      assertStableReleaseSessionIdentityCurrent(config, session.stableRelease);
      session = advanceReleaseSession({
        controllerHome: config.controllerHome,
        sessionId,
        expectedRevision: session.revision,
        phase: 'candidate_booted',
        receipts: [{ id: 'candidate_boot', kind: 'candidate_canary', summary: 'Candidate B booted and passed initial whole-Runtime verification while Stable A remained healthy' }],
      });

      const platform = process.platform;
      const uid = await currentUid();
      const service = primaryRuntimeServiceOwner(candidateConfig, platform, uid);
      if (!service) throw new Error('RELEASE_SESSION_CANDIDATE_SERVICE_OWNER_MISSING');
      const stopped = await stopPrimaryRuntimeForReleaseTransition({
        config: candidateConfig,
        service,
        now: Date.now,
        wait: sleep,
        runCommand,
        runtimeRunning: (candidate) => observeRuntimeStatus(candidate.controllerHome).running,
      });
      if (!stopped.ok) throw new Error(`RELEASE_SESSION_CANDIDATE_RECOVERY_STOP_FAILED: ${stopped.detail}`);
      const restarted = await restartPrimaryRuntime(candidateConfig);
      if (!restarted.ok) throw new Error(`RELEASE_SESSION_CANDIDATE_RECOVERY_RESTART_FAILED: ${restarted.detail}`);
      initialVerify = restarted.verify;
      const receipts = candidateCanaryReceipts(session, initialVerify);
      assertStableReleaseSessionIdentityCurrent(config, session.stableRelease);
      session = advanceReleaseSession({
        controllerHome: config.controllerHome,
        sessionId,
        expectedRevision: session.revision,
        phase: 'candidate_verified',
        receipts,
      });
      session = advanceReleaseSession({
        controllerHome: config.controllerHome,
        sessionId,
        expectedRevision: session.revision,
        phase: 'cutover_eligible',
      });
      audit(config, 'release_session_candidate_verified', {
        sessionId,
        candidateReleaseId: candidateRelease.releaseId,
        candidateControllerHome: session.candidate.controllerHome,
        candidatePort: session.candidate.port,
        stableReleaseId: session.stableRelease.releaseId,
      });
      return {
        ok: true as const,
        attempted: true,
        detail: 'Candidate B booted in isolation, survived a Recovery restart canary, passed MCP/Scheduler/Supervisor/Controller canaries, and is cutover-eligible; Stable A remains active',
        releaseSession: session,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const retirement = await stopReleaseSessionCandidateService(session, runCommand);
      const terminalDetail = retirement.ok
        ? detail
        : `${detail}; Candidate B retirement failed: ${retirement.detail}`;
      try {
        const latest = readReleaseSession(config.controllerHome, sessionId) ?? session;
        session = latest;
        if (retirement.ok && !['failed', 'rolled_back', 'known_good'].includes(latest.phase)) {
          session = advanceReleaseSession({
            controllerHome: config.controllerHome,
            sessionId,
            expectedRevision: latest.revision,
            phase: 'failed',
            receipts: [{ id: 'candidate_failed', kind: 'candidate_canary', summary: terminalDetail.slice(0, 500) }],
          });
        }
        if (retirement.ok && ['failed', 'rolled_back'].includes(session.phase)) {
          cleanupRetiredCandidateLane(config, session);
        }
      } catch { /* preserve original Candidate B failure */ }
      audit(config, 'release_session_candidate_failed', {
        sessionId,
        detail,
        candidateRetired: retirement.ok,
        candidateRetirementDetail: retirement.detail,
      });
      return { ok: false as const, attempted: true, detail: terminalDetail, releaseSession: session };
    }
  });
  if (!locked.acquired) return { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner) };
  return locked.value;
}


export async function cutoverConfiguredRuntimeReleaseSession(
  config: RecoveryConfig,
  sessionId: string,
  requestId?: string,
): Promise<ConfiguredRuntimeActivationResult> {
  const locked = await withLock(config, {
    action: 'release_session_cutover',
    ...(requestId?.trim() ? { requestId: requestId.trim() } : {}),
  }, async (releaseSessionLock) => {
    const initialSession = readReleaseSession(config.controllerHome, sessionId);
    if (!initialSession) return { ok: false as const, attempted: false, noOp: true, detail: 'RELEASE_SESSION_MISSING' };
    let session: ReleaseSession = initialSession;
    const candidateRelease = session.candidateRelease;
    if (!candidateRelease) return { ok: false as const, attempted: false, noOp: true, detail: 'RELEASE_SESSION_CANDIDATE_RELEASE_REQUIRED', releaseSession: session };

    const reconcileCutoverAttempt = async (
      reason: string,
      activation?: RuntimeReleaseActivationResult,
    ): Promise<ConfiguredRuntimeActivationResult> => {
      // Activation may have durably captured the ReleaseSession rollback
      // transaction and advanced its CAS revision. Re-read the one semantic
      // authority before any post-cutover phase transition.
      session = readReleaseSession(config.controllerHome, sessionId) ?? session;
      const retirement = await stopReleaseSessionCandidateService(session);
      if (!retirement.ok) {
        audit(config, 'release_session_candidate_retirement_failed', {
          sessionId,
          phase: session.phase,
          candidateControllerHome: session.candidate.controllerHome,
          detail: retirement.detail,
          reconciliationReason: reason,
        });
        return {
          ok: false as const,
          attempted: true,
          detail: `${reason}; Candidate B retirement failed: ${retirement.detail}`,
          releaseSession: session,
          ...(activation ? { activation } : {}),
        };
      }

      const stableNow = observeRuntimeStatus(config.controllerHome);
      const liveRuntimeIdentityVerified = stableNow.running && stableNow.ready && !stableNow.stale;
      const candidateIsStable = Boolean(
        liveRuntimeIdentityVerified
        && stableNow.snapshot?.releaseId === candidateRelease.releaseId
        && stableNow.snapshot?.artifactIdentity === candidateRelease.artifactIdentity,
      );
      const originalStableRestored = Boolean(
        liveRuntimeIdentityVerified
        && stableNow.snapshot?.releaseId === session.stableRelease.releaseId
        && stableNow.snapshot?.artifactIdentity === session.stableRelease.artifactIdentity,
      );

      if (candidateIsStable) {
        if (session.phase === 'cutover_attempting') {
          session = advanceReleaseSession({
            controllerHome: config.controllerHome,
            sessionId,
            expectedRevision: session.revision,
            phase: 'cutover_committed',
            receipts: [{
              id: 'cutover',
              kind: 'cutover',
              summary: `Stable A runs verified Candidate B release ${candidateRelease.releaseId}; Candidate B retired before cutover commit`,
            }],
          });
        }
        session = advanceReleaseSession({
          controllerHome: config.controllerHome,
          sessionId,
          expectedRevision: session.revision,
          phase: 'soaking',
          receipts: [{
            id: 'soak_started',
            kind: 'soak',
            summary: `cutover reconciled at ${new Date().toISOString()}; Candidate B is retired and known-good promotion remains gated on later stable verification`,
          }],
        });
        const cleanup = cleanupRetiredCandidateLane(config, session);
        audit(config, 'release_session_cutover_reconciled_committed', {
          sessionId,
          releaseId: candidateRelease.releaseId,
          candidateRetired: true,
          reason,
        });
        return {
          ok: true as const,
          attempted: true,
          detail: `ReleaseSession cutover reconciled to committed: Stable A runs the verified candidate artifact and Candidate B is retired${cleanup.ok ? '' : `; Candidate B cleanup failed: ${cleanup.detail}`}`,
          releaseSession: session,
          ...(activation ? { activation } : {}),
        };
      }

      if (originalStableRestored) {
        session = advanceReleaseSession({
          controllerHome: config.controllerHome,
          sessionId,
          expectedRevision: session.revision,
          phase: 'rolled_back',
          receipts: [{
            id: 'rollback',
            kind: 'rollback',
            summary: `cutover did not commit; exact Stable A ${session.stableRelease.releaseId} is active and verified, and Candidate B is retired`,
          }],
        });
        const cleanup = cleanupRetiredCandidateLane(config, session);
        audit(config, 'release_session_cutover_reconciled_rolled_back', {
          sessionId,
          restoredStableReleaseId: session.stableRelease.releaseId,
          candidateRetired: true,
          reason,
        });
        return {
          ok: false as const,
          attempted: true,
          detail: `ReleaseSession cutover reconciled to rolled_back: exact Stable A is active and Candidate B is retired${cleanup.ok ? '' : `; Candidate B cleanup failed: ${cleanup.detail}`}`,
          releaseSession: session,
          ...(activation ? { activation } : {}),
        };
      }

      session = advanceReleaseSession({
        controllerHome: config.controllerHome,
        sessionId,
        expectedRevision: session.revision,
        phase: 'failed',
        receipts: [{
          id: 'cutover_failed',
          kind: 'cutover',
          summary: `${reason}; Stable A outcome is not fully verified; Candidate B is retired`.slice(0, 500),
        }],
      });
      const cleanup = cleanupRetiredCandidateLane(config, session);
      audit(config, 'release_session_cutover_reconciled_failed', {
        sessionId,
        candidateReleaseId: candidateRelease.releaseId,
        candidateRetired: true,
        reason,
        observedActiveReleaseId: stableNow.snapshot?.releaseId,
      });
      return {
        ok: false as const,
        attempted: true,
        detail: `${reason}; Candidate B is retired but Stable A cutover/rollback outcome is not fully verified${cleanup.ok ? '' : `; Candidate B cleanup failed: ${cleanup.detail}`}`,
        releaseSession: session,
        ...(activation ? { activation } : {}),
      };
    };

    if (session.phase === 'cutover_attempting' || session.phase === 'cutover_committed') {
      return reconcileCutoverAttempt(`resuming ReleaseSession from ${session.phase} without a second activation attempt`);
    }
    if (session.phase !== 'cutover_eligible') {
      return { ok: false as const, attempted: false, noOp: true, detail: `RELEASE_SESSION_CUTOVER_REQUIRES_ELIGIBLE: ${session.phase}`, releaseSession: session };
    }

    try {
      assertStableReleaseSessionIdentityCurrent(config, session.stableRelease);
      const stableBefore = await verifyLocalRuntime(config);
      if (!stableBefore.ok) {
        const reasonCodes = stableBefore.runtime.reasonCodes.join(',') || 'unknown';
        audit(config, 'release_session_cutover_precondition_deferred', {
          sessionId,
          detail: 'stable Runtime verification is temporarily unavailable before cutover',
          reasonCodes,
        });
        return {
          ok: false as const,
          attempted: false,
          noOp: true,
          detail: `RELEASE_SESSION_STABLE_RUNTIME_VERIFICATION_DEFERRED: ${reasonCodes}`,
          releaseSession: session,
        };
      }
      if (
        stableBefore.releases.active?.revision !== session.stableRelease.releaseId
        || stableBefore.releases.active?.artifactIdentity !== session.stableRelease.artifactIdentity
      ) throw new Error('RELEASE_SESSION_STABLE_RUNTIME_IDENTITY_CHANGED');

      const candidateConfig = candidateRecoveryConfig(session);
      const candidateBefore = await verifyLocalRuntime(candidateConfig);
      if (
        !candidateBefore.ok
        || candidateBefore.releases.active?.revision !== candidateRelease.releaseId
        || candidateBefore.releases.active?.artifactIdentity !== candidateRelease.artifactIdentity
      ) throw new Error('RELEASE_SESSION_CANDIDATE_NO_LONGER_VERIFIED');
      if (runtimeReleaseTreeSha256(dirname(candidateRelease.manifestPath)) !== candidateRelease.treeSha256) {
        throw new Error('RELEASE_SESSION_CANDIDATE_TREE_CHANGED');
      }

      const promoted = promotePortableRuntimeRelease({
        sourceManifestPath: candidateRelease.manifestPath,
        targetControllerHome: config.controllerHome,
        expectedTreeSha256: candidateRelease.treeSha256,
      });
      if (
        promoted.releaseId !== candidateRelease.releaseId
        || promoted.artifactIdentity !== candidateRelease.artifactIdentity
        || promoted.manifestSha256 !== candidateRelease.manifestSha256
        || promoted.treeSha256 !== candidateRelease.treeSha256
      ) throw new Error('RELEASE_SESSION_PROMOTION_IDENTITY_MISMATCH');

      // Promotion writes only a new immutable release tree. Stable A must still
      // be the exact frozen authority before we enter the one cutover attempt.
      assertStableReleaseSessionIdentityCurrent(config, session.stableRelease);
      const stableAfterPromotion = await verifyLocalRuntime(config);
      if (!stableAfterPromotion.ok) {
        const reasonCodes = stableAfterPromotion.runtime.reasonCodes.join(',') || 'unknown';
        audit(config, 'release_session_cutover_post_promotion_verification_deferred', {
          sessionId,
          detail: 'stable Runtime verification is temporarily unavailable after immutable promotion and before activation',
          reasonCodes,
        });
        return {
          ok: false as const,
          attempted: false,
          noOp: true,
          detail: `RELEASE_SESSION_STABLE_POST_PROMOTION_VERIFICATION_DEFERRED: ${reasonCodes}`,
          releaseSession: session,
        };
      }
      if (
        stableAfterPromotion.releases.active?.revision !== session.stableRelease.releaseId
        || stableAfterPromotion.releases.active?.artifactIdentity !== session.stableRelease.artifactIdentity
      ) throw new Error('RELEASE_SESSION_STABLE_CHANGED_DURING_PROMOTION');

      session = advanceReleaseSession({
        controllerHome: config.controllerHome,
        sessionId,
        expectedRevision: session.revision,
        phase: 'cutover_attempting',
        receipts: [{
          id: 'cutover_attempt',
          kind: 'cutover',
          summary: `byte-identical Candidate B ${candidateRelease.releaseId} promoted to Stable A release storage; beginning the single fenced cutover attempt`,
        }],
      });

      const activation = await activateRuntimeReleaseInternal(config, promoted.manifestPath, {}, {
        ...(requestId?.trim() ? { requestId: requestId.trim() } : {}),
        expectedAuthorityRevision: session.stableRelease.authorityRevision,
        expectedActiveReleaseId: session.stableRelease.releaseId,
        releaseSessionId: session.sessionId,
      }, releaseSessionLock);

      return reconcileCutoverAttempt(
        activation.ok
          ? 'cutover activation completed; reconciling canonical Runtime identity before phase progression'
          : `cutover activation returned failure: ${activation.detail}`,
        activation,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const latest = readReleaseSession(config.controllerHome, sessionId) ?? session;
      session = latest;
      if (latest.phase === 'cutover_attempting' || latest.phase === 'cutover_committed') {
        return reconcileCutoverAttempt(`cutover interrupted after entering ${latest.phase}: ${detail}`);
      }
      if (latest.phase === 'cutover_eligible') {
        const retirement = await stopReleaseSessionCandidateService(latest);
        if (!retirement.ok) {
          audit(config, 'release_session_candidate_retirement_failed', {
            sessionId,
            phase: latest.phase,
            candidateControllerHome: latest.candidate.controllerHome,
            detail: retirement.detail,
            cutoverError: detail,
          });
          return {
            ok: false as const,
            attempted: false,
            noOp: true,
            detail: `${detail}; Candidate B retirement failed: ${retirement.detail}`,
            releaseSession: latest,
          };
        }
        try {
          session = advanceReleaseSession({
            controllerHome: config.controllerHome,
            sessionId,
            expectedRevision: latest.revision,
            phase: 'failed',
            receipts: [{
              id: 'cutover_precondition_failed',
              kind: 'cutover',
              summary: `${detail}; Candidate B retired`.slice(0, 500),
            }],
          });
          cleanupRetiredCandidateLane(config, session);
        } catch { /* preserve original cutover precondition failure */ }
        audit(config, 'release_session_cutover_precondition_failed', {
          sessionId,
          detail,
          candidateRetired: true,
        });
      }
      return { ok: false as const, attempted: false, noOp: true, detail, releaseSession: session };
    }
  });
  if (!locked.acquired) return { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner) };
  return locked.value;
}


async function cancelReleaseSessionUnderLock(
  config: RecoveryConfig,
  initialSession: ReleaseSession,
  reason: string,
): Promise<ConfiguredRuntimeActivationResult> {
  let session = initialSession;
  if (session.phase === 'failed') {
    return { ok: true, attempted: false, noOp: true, detail: 'ReleaseSession is already terminal failed', releaseSession: session };
  }
  if (['cutover_attempting', 'cutover_committed', 'soaking'].includes(session.phase)) {
    return {
      ok: false,
      attempted: false,
      noOp: true,
      detail: `RELEASE_SESSION_CANCEL_AFTER_CUTOVER_FORBIDDEN: ${session.phase}; use exact ReleaseSession rollback/soak resolution`,
      releaseSession: session,
    };
  }
  if (session.phase === 'known_good' || session.phase === 'rolled_back') {
    return {
      ok: false,
      attempted: false,
      noOp: true,
      detail: `RELEASE_SESSION_CANCEL_TERMINAL: ${session.phase}`,
      releaseSession: session,
    };
  }

  const priorPhase = session.phase;
  if (['candidate_booted', 'candidate_verified', 'cutover_eligible'].includes(session.phase)) {
    const retirement = await stopReleaseSessionCandidateService(session);
    if (!retirement.ok) {
      return {
        ok: false,
        attempted: true,
        detail: `RELEASE_SESSION_CANCEL_CANDIDATE_RETIRE_FAILED: ${retirement.detail}`,
        releaseSession: session,
      };
    }
  }

  session = advanceReleaseSession({
    controllerHome: config.controllerHome,
    sessionId: session.sessionId,
    expectedRevision: session.revision,
    phase: 'failed',
    receipts: [{
      id: 'candidate_cancelled',
      kind: 'candidate_canary',
      summary: `Candidate B was retired before cutover: ${reason}`.slice(0, 500),
    }],
  });
  const cleanup = cleanupRetiredCandidateLane(config, session);
  audit(config, cleanup.ok ? 'release_session_cancelled' : 'release_session_cancelled_cleanup_failed', {
    sessionId: session.sessionId,
    priorPhase,
    candidateControllerHome: session.candidate.controllerHome,
    reason,
    cleanupDetail: cleanup.detail,
  });
  return {
    ok: cleanup.ok,
    attempted: true,
    detail: cleanup.ok
      ? 'ReleaseSession Candidate B was terminalized failed and its isolated lane was retired before cutover; Stable A remained unchanged'
      : `ReleaseSession was terminalized failed but Candidate B lane cleanup failed: ${cleanup.detail}`,
    releaseSession: session,
  };
}

export async function cancelConfiguredRuntimeReleaseSession(
  config: RecoveryConfig,
  sessionId: string,
  requestId?: string,
): Promise<ConfiguredRuntimeActivationResult> {
  const locked = await withLock(config, {
    action: 'release_session_cancel',
    ...(requestId?.trim() ? { requestId: requestId.trim() } : {}),
  }, async () => {
    const session = readReleaseSession(config.controllerHome, sessionId);
    if (!session) return { ok: false as const, attempted: false, noOp: true, detail: 'RELEASE_SESSION_MISSING' };
    return cancelReleaseSessionUnderLock(config, session, 'explicit Recovery cancellation');
  });
  if (!locked.acquired) {
    return { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner) };
  }
  return locked.value;
}


function releaseSessionRollbackTransaction(
  config: RecoveryConfig,
  session: ReleaseSession,
): NonNullable<ReleaseSession['transaction']> {
  const authority = readRuntimeReleaseAuthority(config.controllerHome);
  const transaction = session.transaction;
  const candidateRelease = session.candidateRelease;
  const previous = authority?.previous;
  if (!authority || !transaction || !candidateRelease || !previous?.databaseBackup) {
    throw new Error('RELEASE_SESSION_ROLLBACK_TRANSACTION_REQUIRED');
  }
  if (
    transaction.candidateReleaseId !== candidateRelease.releaseId
    || authority.active.releaseId !== candidateRelease.releaseId
    || authority.active.artifactIdentity !== candidateRelease.artifactIdentity
    || previous.releaseId !== transaction.rollbackRelease.releaseId
    || previous.artifactIdentity !== transaction.rollbackRelease.artifactIdentity
    || previous.manifestSha256 !== transaction.rollbackRelease.manifestSha256
    || previous.databaseBackup.path !== transaction.rollbackRelease.databaseBackup?.path
    || transaction.rollbackRelease.releaseId !== session.stableRelease.releaseId
    || transaction.rollbackRelease.artifactIdentity !== session.stableRelease.artifactIdentity
    || transaction.rollbackRelease.manifestSha256 !== session.stableRelease.manifestSha256
  ) {
    throw new Error('RELEASE_SESSION_ROLLBACK_TRANSACTION_IDENTITY_MISMATCH');
  }
  return transaction;
}

export async function rollbackConfiguredRuntimeReleaseSession(
  config: RecoveryConfig,
  sessionId: string,
  dependencies: PrimaryRuntimeRecoveryDependencies = {},
  requestId?: string,
): Promise<ConfiguredRuntimeActivationResult> {
  const locked = await withLock(config, {
    action: 'release_session_rollback',
    ...(requestId?.trim() ? { requestId: requestId.trim() } : {}),
  }, async () => {
    let session = readReleaseSession(config.controllerHome, sessionId);
    if (!session) return { ok: false as const, attempted: false, noOp: true, detail: 'RELEASE_SESSION_MISSING' };
    if (session.phase === 'rolled_back') {
      return { ok: true as const, attempted: false, noOp: true, detail: 'ReleaseSession is already rolled back', releaseSession: session };
    }
    if (!['cutover_attempting', 'cutover_committed', 'soaking'].includes(session.phase)) {
      return {
        ok: false as const,
        attempted: false,
        noOp: true,
        detail: `RELEASE_SESSION_ROLLBACK_REQUIRES_CUTOVER: ${session.phase}`,
        releaseSession: session,
      };
    }

    const candidateRelease = session.candidateRelease;
    const transactionBeforeRollback = session.transaction;
    const authorityBeforeRollback = readRuntimeReleaseAuthority(config.controllerHome);
    const rollbackAlreadyCommitted = Boolean(
      candidateRelease
      && transactionBeforeRollback
      && authorityBeforeRollback?.operationId?.startsWith(`release-session-rollback:${session.sessionId}:`)
      && authorityBeforeRollback.active.releaseId === session.stableRelease.releaseId
      && authorityBeforeRollback.active.artifactIdentity === session.stableRelease.artifactIdentity
      && authorityBeforeRollback.active.manifestSha256 === session.stableRelease.manifestSha256
      && authorityBeforeRollback.previous?.releaseId === candidateRelease.releaseId
      && authorityBeforeRollback.previous?.artifactIdentity === candidateRelease.artifactIdentity
      && transactionBeforeRollback.candidateReleaseId === candidateRelease.releaseId
      && transactionBeforeRollback.rollbackRelease.releaseId === session.stableRelease.releaseId
      && transactionBeforeRollback.rollbackRelease.artifactIdentity === session.stableRelease.artifactIdentity
    );
    if (rollbackAlreadyCommitted) {
      const live = observeRuntimeStatus(config.controllerHome);
      const stableIsLive = live.running && live.ready && !live.stale
        && live.snapshot?.releaseId === session.stableRelease.releaseId
        && live.snapshot?.artifactIdentity === session.stableRelease.artifactIdentity;
      if (!stableIsLive) {
        return {
          ok: false as const,
          attempted: false,
          noOp: true,
          detail: 'RELEASE_SESSION_ROLLBACK_COMMITTED_RUNTIME_NOT_YET_OBSERVED',
          releaseSession: session,
        };
      }
      session = advanceReleaseSession({
        controllerHome: config.controllerHome,
        sessionId,
        expectedRevision: session.revision,
        phase: 'rolled_back',
        receipts: [{
          id: 'rollback',
          kind: 'rollback',
          summary: `reconciled already-committed rollback ${authorityBeforeRollback!.operationId}; exact Stable A ${session.stableRelease.releaseId} is live and no rollback effect was replayed`,
        }],
      });
      audit(config, 'release_session_rollback_reconciled_committed', {
        sessionId,
        rollbackOperationId: authorityBeforeRollback!.operationId,
        restoredStableReleaseId: session.stableRelease.releaseId,
        candidateReleaseId: candidateRelease!.releaseId,
      });
      return {
        ok: true as const,
        attempted: false,
        noOp: true,
        detail: 'ReleaseSession reconciled the already-committed Stable A rollback from durable authority without replaying the rollback effect',
        releaseSession: session,
      };
    }

    let transaction: NonNullable<ReleaseSession['transaction']>;
    try {
      transaction = releaseSessionRollbackTransaction(config, session);
    } catch (error) {
      return {
        ok: false as const,
        attempted: false,
        noOp: true,
        detail: error instanceof Error ? error.message : String(error),
        releaseSession: session,
      };
    }

    const platform = dependencies.platform ?? process.platform;
    const uid = await (dependencies.currentUid ?? currentUid)();
    const service = primaryRuntimeServiceOwner(config, platform, uid);
    if (!service) {
      return {
        ok: false as const,
        attempted: false,
        noOp: true,
        detail: `primary Forge Runtime ${configuredPrimaryRuntimeService(config, platform).platform} service is not installed for ${platform}`,
        releaseSession: session,
      };
    }
    const runCommand = dependencies.runCommand ?? command;
    const now = dependencies.now ?? Date.now;
    const wait = dependencies.sleep ?? sleep;
    const runtimeRunning = dependencies.runtimeRunning ?? ((value: RecoveryConfig) => observeRuntimeStatus(value.controllerHome).running);
    const verifyLocal = dependencies.verifyLocal ?? verifyLocalRuntime;
    const repairConnectorBinding = dependencies.repairPrimaryConnectorBinding
      ?? ((value: RecoveryConfig) => repairPrimaryConnectorBinding(value, platform));

    const stopped = await stopPrimaryRuntimeForReleaseTransition({ config, service, now, wait, runCommand, runtimeRunning });
    if (!stopped.ok) {
      return { ok: false as const, attempted: true, detail: stopped.detail, releaseSession: session };
    }

    let restored: RuntimeReleaseAuthority;
    let databaseRollbackDisposition: RuntimeDatabaseRollbackDisposition = 'preserved_unversioned_backup';
    try {
      const rollbackResult = rollbackRuntimeReleaseWithResult(config.controllerHome, `release-session-rollback:${session.sessionId}:${Date.now()}`);
      restored = rollbackResult.authority;
      databaseRollbackDisposition = rollbackResult.databaseDisposition;
      if (
        restored.active.releaseId !== session.stableRelease.releaseId
        || restored.active.artifactIdentity !== session.stableRelease.artifactIdentity
        || restored.active.manifestSha256 !== session.stableRelease.manifestSha256
      ) throw new Error('RELEASE_SESSION_ROLLBACK_STABLE_IDENTITY_MISMATCH');
    } catch (error) {
      const restart = await rebindStartAndVerifyPrimaryRuntime({
        config,
        service,
        runCommand,
        now,
        wait,
        verifyLocal,
        ensureRuntimeLaunchContract: dependencies.ensureRuntimeLaunchContract,
        timeoutMs: configuredPrimaryRuntimeService(config).postRestartVerifyTimeoutMs ?? 60_000,
        successDetail: 'ReleaseSession rollback transaction failed; current authoritative Runtime was restarted and verified',
      });
      return {
        ok: false as const,
        attempted: true,
        detail: `${error instanceof Error ? error.message : String(error)}; authoritative Runtime restart: ${restart.detail}`,
        releaseSession: session,
      };
    }

    let rollbackConnectorBinding: { ok: boolean; attempted: boolean; noOp?: boolean; detail: string } | undefined;
    const restarted = await rebindStartAndVerifyPrimaryRuntime({
      config,
      service,
      runCommand,
      now,
      wait,
      verifyLocal,
      ensureRuntimeLaunchContract: dependencies.ensureRuntimeLaunchContract,
      contractFailureContext: 'after ReleaseSession rollback',
      timeoutMs: configuredPrimaryRuntimeService(config).postRestartVerifyTimeoutMs ?? 60_000,
      successDetail: databaseRollbackDisposition === 'restored_backup'
        ? 'exact Stable A whole-Runtime release and unchanged SQLite backup restored, restarted, rebound, and verified'
        : 'exact Stable A Runtime release restored while newer live SQLite state was preserved, restarted, rebound, and verified',
      afterRuntimeReady: async () => {
        rollbackConnectorBinding = await repairConnectorBinding(config);
        return rollbackConnectorBinding.ok
          ? { ok: true, detail: rollbackConnectorBinding.detail }
          : { ok: false, detail: `Stable A persistent Connector binding failed after ReleaseSession rollback: ${rollbackConnectorBinding.detail}` };
      },
    });

    const latest = readReleaseSession(config.controllerHome, sessionId) ?? session;
    session = advanceReleaseSession({
      controllerHome: config.controllerHome,
      sessionId,
      expectedRevision: latest.revision,
      phase: restarted.ok ? 'rolled_back' : 'failed',
      receipts: [{
        id: restarted.ok ? 'rollback' : 'rollback_failed',
        kind: 'rollback',
        summary: restarted.ok
          ? databaseRollbackDisposition === 'restored_backup'
            ? `exact Stable A ${latest.stableRelease.releaseId} and its unchanged SQLite backup restored from ReleaseSession activation transaction`
            : `exact Stable A ${latest.stableRelease.releaseId} restored while newer live SQLite state was preserved across rollback`
          : `Stable A authority restored but Runtime verification failed after rollback: ${restarted.detail}`.slice(0, 500),
      }],
    });
    audit(config, restarted.ok ? 'release_session_rolled_back' : 'release_session_rollback_restart_failed', {
      sessionId,
      releaseSessionTransactionOperationId: transaction.operationId,
      restoredStableReleaseId: restored.active.releaseId,
      connectorBindingRepaired: rollbackConnectorBinding?.ok === true,
      databaseRollbackDisposition,
      detail: restarted.detail,
    });
    return {
      ok: restarted.ok,
      attempted: true,
      detail: restarted.ok
        ? databaseRollbackDisposition === 'restored_backup'
          ? 'ReleaseSession rollback restored the exact frozen Stable A release, unchanged SQLite backup, service binding, and verified Runtime'
          : 'ReleaseSession rollback restored the exact frozen Stable A release while preserving newer live SQLite state, service binding, and verified Runtime'
        : `ReleaseSession restored Stable A authority but failed post-rollback Runtime verification: ${restarted.detail}`,
      releaseSession: session,
    };
  });
  if (!locked.acquired) {
    return { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner) };
  }
  return locked.value;
}


export async function promoteConfiguredRuntimeReleaseSessionKnownGood(
  config: RecoveryConfig,
  sessionId: string,
  dependencies: RuntimeReleaseKnownGoodDependencies = {},
  requestId?: string,
): Promise<ConfiguredRuntimeActivationResult> {
  const initial = readReleaseSession(config.controllerHome, sessionId);
  if (!initial) return { ok: false, attempted: false, noOp: true, detail: 'RELEASE_SESSION_MISSING' };
  if (initial.phase !== 'soaking') {
    return { ok: false, attempted: false, noOp: true, detail: `RELEASE_SESSION_KNOWN_GOOD_REQUIRES_SOAKING: ${initial.phase}`, releaseSession: initial };
  }
  const candidateRelease = initial.candidateRelease;
  if (!candidateRelease) return { ok: false, attempted: false, noOp: true, detail: 'RELEASE_SESSION_CANDIDATE_RELEASE_REQUIRED', releaseSession: initial };

  let attested: ReleaseEvidence;
  try {
    const active = activeAuthorityRelease(config);
    if (
      !active
      || active.revision !== candidateRelease.releaseId
      || active.artifactIdentity !== candidateRelease.artifactIdentity
      || active.manifestSha256 !== candidateRelease.manifestSha256
    ) throw new Error('RELEASE_SESSION_SOAK_RUNTIME_IDENTITY_MISMATCH');

    const existingAttestation = matchingKnownGood(config, active);
    if (existingAttestation) {
      // A known-good attestation is durable release authority, not a transient
      // observation. Crash/retry reconciliation must reuse it instead of
      // replaying performance observation and public MCP probes. The live
      // Runtime still has to own the exact same release and remain locally
      // live/ready/non-stale before the ReleaseSession can terminalize.
      if (!liveRuntimeOwnsRelease(config, existingAttestation)) {
        throw new Error('RELEASE_SESSION_ATTESTED_RUNTIME_NOT_CURRENT');
      }
      attested = existingAttestation;
    } else {
      const before = await verifyStableRuntime(config);
      if (!before.ok) throw new Error('RELEASE_SESSION_SOAK_RUNTIME_VERIFY_FAILED');
      if (!sameReleaseEvidenceIdentity(before.releases.active, active)) {
        throw new Error('RELEASE_SESSION_SOAK_RUNTIME_IDENTITY_MISMATCH');
      }
      attested = await attestKnownGood(config, dependencies);
    }
    if (
      attested.revision !== candidateRelease.releaseId
      || attested.artifactIdentity !== candidateRelease.artifactIdentity
      || attested.manifestSha256 !== candidateRelease.manifestSha256
      || !attested.recoveryBundle
    ) throw new Error('RELEASE_SESSION_KNOWN_GOOD_ATTESTATION_IDENTITY_MISMATCH');
    inspectKnownGoodRecoveryBundle(config.controllerHome, attested);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    audit(config, 'release_session_known_good_failed', { sessionId, detail });

    // A hard runaway-CPU rejection is terminal acceptance evidence, not a
    // transient observation failure. Keeping Candidate B live in `soaking`
    // caused the automatic release driver to launch another full 60-second
    // sampler on every reconciliation cycle. Restore the exact frozen Stable A
    // through the existing ReleaseSession rollback transaction instead. The
    // coordinator will then treat this source revision as already attempted and
    // will not autonomously replay it until source authority changes.
    if (/^RECOVERY_PERFORMANCE_REJECTED:/.test(detail)) {
      const rollback = await rollbackConfiguredRuntimeReleaseSession(
        config,
        sessionId,
        dependencies.rollback ?? {},
        requestId?.trim() ? `${requestId.trim()}:performance-rejected` : undefined,
      );
      audit(config, 'release_session_known_good_performance_rejected', {
        sessionId,
        detail,
        rollbackOk: rollback.ok,
        rollbackDetail: rollback.detail,
      });
      return {
        ok: false,
        attempted: true,
        detail: rollback.ok
          ? `${detail}; Candidate B rejected by the Recovery runaway-CPU gate and Stable A restored`
          : `${detail}; automatic Stable A rollback failed: ${rollback.detail}`,
        releaseSession: rollback.releaseSession ?? readReleaseSession(config.controllerHome, sessionId) ?? initial,
      };
    }

    return { ok: false, attempted: true, detail, releaseSession: readReleaseSession(config.controllerHome, sessionId) ?? initial };
  }

  const locked = await withLock(config, {
    action: 'release_session_known_good',
    ...(requestId?.trim() ? { requestId: requestId.trim() } : {}),
  }, async () => {
    let session = readReleaseSession(config.controllerHome, sessionId);
    if (!session) return { ok: false as const, attempted: true, detail: 'RELEASE_SESSION_MISSING' };
    if (session.phase !== 'soaking') {
      return { ok: false as const, attempted: true, detail: `RELEASE_SESSION_CHANGED_DURING_KNOWN_GOOD_ATTESTATION: ${session.phase}`, releaseSession: session };
    }
    // The expensive independent verification and performance observation are
    // already embodied by `attested`. Re-running the full network probe suite
    // here created a split-brain transaction: the durable recovery bundle could
    // be published successfully, then one transient Gateway/MCP timeout left the
    // ReleaseSession permanently soaking. Under the mutation lock, only fence
    // the identity that could invalidate that attestation.
    if (!liveRuntimeOwnsRelease(config, attested)) {
      return { ok: false as const, attempted: true, detail: 'RELEASE_SESSION_RUNTIME_CHANGED_AFTER_KNOWN_GOOD_ATTESTATION', releaseSession: session };
    }
    try {
      releaseSessionRollbackTransaction(config, session);
    } catch (error) {
      return {
        ok: false as const,
        attempted: true,
        detail: error instanceof Error ? error.message : String(error),
        releaseSession: session,
      };
    }
    session = advanceReleaseSession({
      controllerHome: config.controllerHome,
      sessionId,
      expectedRevision: session.revision,
      phase: 'known_good',
      receipts: [{
        id: 'known_good',
        kind: 'known_good',
        summary: `release ${attested.revision} passed soak/performance observation and owns recoverable bundle ${attested.recoveryBundle!.attestationId}`,
      }],
    });
    audit(config, 'release_session_known_good', {
      sessionId,
      releaseId: attested.revision,
      attestationId: attested.recoveryBundle!.attestationId,
      releaseAuthorityRevision: attested.releaseAuthorityRevision,
      releaseSessionTransactionOperationId: session.transaction?.operationId,
    });
    return {
      ok: true as const,
      attempted: true,
      detail: 'ReleaseSession became known-good only after full Runtime verification, performance observation, and recoverable release+SQLite+service bundle attestation',
      releaseSession: session,
    };
  });
  if (!locked.acquired) return { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner), releaseSession: initial };
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
  // Frozen-client compatibility alias. It deliberately stops at Candidate B
  // build/session preparation. Activation is a separate ReleaseSession phase.
  return prepareConfiguredRuntimeReleaseSession(config, dependencies, requestId);
}

function tunnelLaunchdService(configured: RecoveryTunnelServiceConfig | undefined, uid: number): LaunchdService | undefined {
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

function recoverySystemdTunnelUnit(config: RecoveryConfig): string | undefined {
  const configured = configuredRecoveryTunnel(config);
  if (!configured || configured.platform !== 'systemd-user') return undefined;
  const unitName = configured.unitName.trim();
  if (!/^[A-Za-z0-9_.@-]{1,180}\.service$/.test(unitName)) return undefined;
  return unitName;
}

function primaryPublicTunnelService(config: RecoveryConfig, uid: number): LaunchdService | undefined {
  return tunnelLaunchdService(configuredPrimaryPublicTunnel(config), uid);
}

function tunnelRepairAllowed(config: RecoveryConfig, now: number): boolean {
  const cooldownMs = configuredRecoveryTunnel(config)?.cooldownMs ?? 60_000;
  const prior = json<{ lastAttemptAt?: unknown }>(publicTunnelRepairStatePath(config));
  return typeof prior?.lastAttemptAt !== 'number' || now - prior.lastAttemptAt >= cooldownMs;
}

async function verifyRecoveryTunnelRepairSurface(config: RecoveryConfig): Promise<VerifyResult> {
  // Recovery tunnel repair is a bootstrap control-plane operation. It must not
  // depend on the primary public MCP/Connector transport that Recovery exists
  // to repair around. Keep canonical Runtime/Recovery authority checks and the
  // dedicated Recovery external probe, but exclude primary transport probes.
  return verifyStableRuntime({
    ...config,
    publicMcpUrl: undefined,
    primaryPublicTunnelService: undefined,
    primaryConnectorService: undefined,
  }, createRecoveryHttpTransport(config.controllerHome), { probeMcpProtocol: false });
}

export async function repairPublicTunnel(config: RecoveryConfig, dependencies: PublicTunnelRepairDependencies = {}): Promise<PublicTunnelRepairResult> {
  const verify = dependencies.verify ?? verifyRecoveryTunnelRepairSurface;
  const verifyLocal = dependencies.verifyLocal ?? verifyLocalRuntime;
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.sleep ?? sleep;
  const runCommand = dependencies.runCommand ?? command;
  const initial = await verify(config);
  const configured = configuredRecoveryTunnel(config);
  if (!configured) return { ok: false, attempted: false, noOp: true, detail: 'public tunnel repair is not configured', verify: initial };
  const localVerify = await verifyLocal(config);
  const tunnelProbe = configured.platform === 'openai-secure-tunnel'
    ? initial.probes.recovery_tunnel_runtime
    : (initial.probes.recovery_external_http ?? initial.probes.external_mcp_http);
  if (!isExternalTunnelFailure(config, initial, localVerify)) {
    return { ok: tunnelProbe?.ok === true, attempted: false, noOp: true, detail: 'Recovery tunnel repair requires a healthy local runtime and failed managed Recovery tunnel', verify: initial, localVerify };
  }

  let serviceLabel: string;
  let serviceTarget: string;
  let launchdService: LaunchdService | undefined;
  let systemdUnitName: string | undefined;
  if (configured.platform === 'launchd') {
    if ((dependencies.platform ?? process.platform) !== 'darwin') {
      return { ok: false, attempted: false, noOp: true, detail: 'configured launchd public tunnel can only be repaired on macOS', verify: initial, localVerify };
    }
    const uid = await (dependencies.currentUid ?? currentUid)();
    launchdService = uid === undefined ? undefined : recoveryTunnelService(config, uid);
    if (!launchdService) return { ok: false, attempted: false, noOp: true, detail: 'public tunnel launchd configuration is invalid or unavailable', verify: initial, localVerify };
    serviceLabel = launchdService.label;
    serviceTarget = launchdService.target;
  } else if (configured.platform === 'systemd-user') {
    if ((dependencies.platform ?? process.platform) !== 'linux') {
      return { ok: false, attempted: false, noOp: true, detail: 'configured systemd-user public tunnel can only be repaired on Linux', verify: initial, localVerify };
    }
    systemdUnitName = recoverySystemdTunnelUnit(config);
    if (!systemdUnitName) return { ok: false, attempted: false, noOp: true, detail: 'public tunnel systemd-user configuration is invalid', verify: initial, localVerify };
    const loaded = await runCommand('systemctl', ['--user', 'show', '--property=LoadState', '--value', systemdUnitName], 5_000);
    if (!loaded.ok || loaded.stdout.trim() !== 'loaded') {
      return { ok: false, attempted: false, noOp: true, detail: `public tunnel systemd-user unit is not loaded: ${systemdUnitName}`, verify: initial, localVerify };
    }
    serviceLabel = systemdUnitName;
    serviceTarget = systemdUnitName;
  } else {
    serviceLabel = configured.alias;
    serviceTarget = `tunnel-client:${configured.alias}`;
    const observed = await observeOpenAiRecoveryTunnel(config, runCommand);
    if (observed?.observedTunnelId && !observed.tunnelMatches) {
      return { ok: false, attempted: false, noOp: true, detail: `OpenAI tunnel alias ${configured.alias} is already bound to a different tunnel id`, serviceLabel, serviceTarget, verify: initial, localVerify };
    }
    if (observed?.profilePath && !observed.endpointMatches) {
      return { ok: false, attempted: false, noOp: true, detail: `OpenAI tunnel alias ${configured.alias} is already bound to a different MCP endpoint`, serviceLabel, serviceTarget, verify: initial, localVerify };
    }
  }

  if (!tunnelRepairAllowed(config, now())) {
    return { ok: false, attempted: false, noOp: true, detail: 'public tunnel repair is in cooldown', serviceLabel, serviceTarget, verify: initial, localVerify };
  }

  const locked = await withLock(config, { action: 'repair_public_tunnel' }, async () => {
    // Recheck after acquiring ownership so a concurrent watchdog never causes a restart storm.
    const before = await verify(config);
    const localBefore = await verifyLocal(config);
    if (!isExternalTunnelFailure(config, before, localBefore)) {
      const recoveredProbe = configured.platform === 'openai-secure-tunnel'
        ? before.probes.recovery_tunnel_runtime
        : (before.probes.recovery_external_http ?? before.probes.external_mcp_http);
      return { ok: recoveredProbe?.ok === true, attempted: false, noOp: true, detail: 'Recovery tunnel recovered before restart', serviceLabel, serviceTarget, verify: before, localVerify: localBefore };
    }
    writeJson(publicTunnelRepairStatePath(config), { lastAttemptAt: now(), serviceLabel, serviceTarget });

    if (configured.platform === 'launchd') {
      const started = await ensureLaunchdServiceStarted(launchdService!, runCommand);
      if (!started.ok) {
        audit(config, 'public_tunnel_restart_failed', { serviceLabel, serviceTarget, detail: started.detail });
        return { ok: false, attempted: true, detail: started.detail, serviceLabel, serviceTarget, verify: before, localVerify: localBefore };
      }
    } else if (configured.platform === 'systemd-user') {
      const restarted = await runCommand('systemctl', ['--user', 'restart', systemdUnitName!], 15_000);
      if (!restarted.ok) {
        const detail = `systemd-user restart failed: ${restarted.stderr || restarted.stdout || restarted.status}`;
        audit(config, 'public_tunnel_restart_failed', { serviceLabel, serviceTarget, detail });
        return { ok: false, attempted: true, detail, serviceLabel, serviceTarget, verify: before, localVerify: localBefore };
      }
    } else {
      const observed = await observeOpenAiRecoveryTunnel(config, runCommand);
      if (observed?.observedTunnelId && !observed.tunnelMatches) {
        const detail = `OpenAI tunnel alias ${configured.alias} changed ownership to ${observed.observedTunnelId}; refusing to repoint it`;
        audit(config, 'public_tunnel_restart_failed', { serviceLabel, serviceTarget, detail });
        return { ok: false, attempted: false, noOp: true, detail, serviceLabel, serviceTarget, verify: before, localVerify: localBefore };
      }
      if (observed?.profilePath && !observed.endpointMatches) {
        const detail = `OpenAI tunnel alias ${configured.alias} targets a different MCP endpoint; refusing to repoint it`;
        audit(config, 'public_tunnel_restart_failed', { serviceLabel, serviceTarget, detail });
        return { ok: false, attempted: false, noOp: true, detail, serviceLabel, serviceTarget, verify: before, localVerify: localBefore };
      }
      let args: string[];
      try {
        args = openAiSecureTunnelConnectArgs({
          alias: configured.alias,
          tunnelId: configured.tunnelId,
          mcpServerUrl: configured.mcpServerUrl,
          runtimeApiKeyRef: configured.runtimeApiKeyRef,
          profile: configured.profile,
          profileDir: configured.profileDir,
          adminProfile: configured.adminProfile,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'OpenAI tunnel runtime configuration is invalid';
        audit(config, 'public_tunnel_restart_failed', { serviceLabel, serviceTarget, detail });
        return { ok: false, attempted: false, noOp: true, detail, serviceLabel, serviceTarget, verify: before, localVerify: localBefore };
      }
      const connected = await runCommand('tunnel-client', args, Math.max(30_000, configured.postRestartVerifyTimeoutMs ?? 20_000));
      if (!connected.ok) {
        const detail = `OpenAI Secure MCP Tunnel runtime connect failed: ${connected.stderr || connected.stdout || connected.status}`;
        audit(config, 'public_tunnel_restart_failed', { serviceLabel, serviceTarget, detail });
        return { ok: false, attempted: true, detail, serviceLabel, serviceTarget, verify: before, localVerify: localBefore };
      }
    }

    const timeoutMs = configured.postRestartVerifyTimeoutMs ?? 20_000;
    const deadline = now() + timeoutMs;
    let after = before;
    while (now() < deadline) {
      await wait(1_000);
      if (configured.platform === 'openai-secure-tunnel') {
        const observed = await observeOpenAiRecoveryTunnel(config, runCommand);
        if (!observed?.ok) continue;
      }
      after = await verify(config);
      const recovered = configured.platform === 'openai-secure-tunnel'
        ? after.probes.recovery_tunnel_runtime?.ok === true
        : (after.probes.recovery_external_http ?? after.probes.external_mcp_http)?.ok === true;
      if (recovered) {
        audit(config, 'public_tunnel_restart_succeeded', { serviceLabel, serviceTarget });
        return { ok: true, attempted: true, detail: 'public tunnel service restarted and external tunnel readiness verified', serviceLabel, serviceTarget, verify: after, localVerify: await verifyLocal(config) };
      }
    }
    after = await verify(config);
    audit(config, 'public_tunnel_restart_unverified', { serviceLabel, serviceTarget });
    return { ok: false, attempted: true, detail: 'public tunnel service restarted but external tunnel readiness did not recover before timeout', serviceLabel, serviceTarget, verify: after, localVerify: await verifyLocal(config) };
  });
  if (!locked.acquired) return { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner), serviceLabel, serviceTarget, verify: initial, localVerify };
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

function recoveryRoleLaunchdService(config: RecoveryConfig, uid: number, _role: 'gateway'): LaunchdService {
  const label = RECOVERY_DAEMON_LABEL;
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

async function restartRecoveryRole(input: {
  config: RecoveryConfig;
  role: 'gateway';
  action: 'restart_recovery_gateway';
  check: (config: RecoveryConfig) => Promise<{ ok: boolean; detail: string }>;
  dependencies: RecoveryRoleRestartDependencies;
}): Promise<RecoveryGatewayRestartResult> {
  const display = 'Recovery daemon';
  if ((input.dependencies.platform ?? process.platform) !== 'darwin') return { ok: false, attempted: false, noOp: true, detail: `${display} launchd restart is only supported on macOS` };
  const initial = await input.check(input.config);
  if (initial.ok) return { ok: true, attempted: false, noOp: true, detail: `${display} is already healthy` };
  const uid = await (input.dependencies.currentUid ?? currentUid)();
  if (uid === undefined) return { ok: false, attempted: false, noOp: true, detail: `${display} launchd UID is unavailable` };
  const service = recoveryRoleLaunchdService(input.config, uid, input.role);
  if (!existsSync(service.plistPath)) return { ok: false, attempted: false, noOp: true, detail: `${display} launchd plist is missing: ${service.plistPath}`, serviceTarget: service.target };
  const eventPrefix = 'recovery_daemon';
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
  extensions: Partial<Pick<RecoveryConfig, 'installProfile' | 'publicMcpUrl' | 'recoveryPublicUrl' | 'recoveryTunnelService' | 'primaryPublicTunnelService' | 'primaryRuntimeService' | 'primaryRuntimeSourceRoot' | 'primaryRuntimeSourceRepositoryId' | 'primaryConnectorService' | 'readOnlyTool'>> = {},
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
  // Watchdog owns bounded health observation only. Never run strict Runtime or
  // known-good bundle verification from startup or the five-second tick, even
  // when the bounded tier degrades: those checks can hash/inspect multi-GB
  // recovery evidence and would make liveness depend on release-acceptance cost.
  // Explicit verify/attest/release/rollback operations remain the sole strict
  // recoverability boundaries. Keep the legacy timestamp as non-authoritative
  // compatibility state so existing persisted WatchdogState remains readable.
  const health = await observeWatchdogHealthTier(config);
  const verified = health;
  const localVerify = health;
  const lastFullVerifyAt = scopedPrior.lastFullVerifyAt ?? now;
  const activeMutation = liveRecoveryMutationLock(config);
  if (activeMutation) {
    const attributable = recoveryLockOwnerAttributable(activeMutation);
    if (!attributable) {
      audit(config, 'recovery_operation_lock_identity_uncertain', {
        pid: activeMutation.pid,
        instanceId: activeMutation.instanceId,
        action: activeMutation.action ?? null,
        requestId: activeMutation.requestId ?? null,
        acquiredAt: activeMutation.acquiredAt,
      });
    }
    const reason = attributable
      ? `Recovery mutation in progress: action=${activeMutation.action} request=${activeMutation.requestId}; watchdog repair escalation suppressed`
      : 'Recovery mutation lock identity is uncertain; watchdog repair escalation suppressed';
    const state: WatchdogState = {
      ...scopedPrior,
      failures: 0,
      firstFailureAt: undefined,
      publicTunnelFailures: 0,
      publicTunnelFirstFailureAt: undefined,
      primaryConnectorFailures: 0,
      primaryConnectorFirstFailureAt: undefined,
      lastFullVerifyAt,
      lastDecision: 'degraded',
      lastReason: reason,
    };
    return { state, decision: { action: 'degraded', reason }, verify: verified };
  }
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
  // Recovery is only usable when the transport the Recovery connector actually
  // reaches is itself verified. Treat the configured Recovery transport as part
  // of the recovery-health gate so a dead tunnel degrades the watchdog and
  // reaches the bounded `repair_public_tunnel` path instead of reporting healthy.
  const recoveryTransportHealthy = configuredRecoveryTunnel(config)?.platform === 'openai-secure-tunnel'
    ? verified.probes.recovery_tunnel_runtime?.ok === true
    : verified.probes.recovery_external_http?.ok !== false;
  const recoveryHealthy = verified.probes.recovery_gateway?.ok !== false
    && recoveryTransportHealthy;
  const primaryRuntimeHealthy = canonicalRuntimeSafeForTargetedConnectorRecovery(localVerify);
  const primaryConnectorConfigured = Boolean(config.primaryConnectorService);
  const primaryConnectorLocalFailed = verified.probes.primary_connector_local?.ok === false;
  const primaryConnectorCapacityFailed = connectorCapacityRecoveryRecommended(verified);
  const primaryPublicTunnel = configuredPrimaryPublicTunnel(config);
  const primaryPublicTransportManaged = Boolean(primaryPublicTunnel);
  const primaryPublicTransportFailed = Boolean(
    primaryRuntimeHealthy
    && !primaryConnectorCapacityFailed
    && (
      (primaryPublicTunnel?.platform === 'openai-secure-tunnel' && verified.probes.primary_tunnel_runtime?.ok === false)
      || (Boolean(config.publicMcpUrl) && (verified.probes.external_mcp_http?.ok === false || verified.probes.primary_connector_ready?.ok === false))
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
  if (!primaryRuntimeHealthy) state.runtimeHealthySince = undefined;
  const primaryConfig = configuredPrimaryRuntimeService(config);
  const decision = decideWatchdog({
    ...state,
    nowMs: now,
    evidenceClasses,
    activeKnownGood,
    previousKnownGood,
    primaryRuntimeFailed: !primaryRuntimeHealthy,
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
