import { createHash, randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { basename, join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { readMcpServiceOAuthPassphrase } from '../../../adapters/mcp/auth';
import { FORGE_VERSION } from '../../version';
import type { Tool } from '@modelcontextprotocol/server';
import { RecoveryMcpServer } from './mcp-server';
import {
  activateRuntimeRelease,
  activatePinnedRuntimeRelease,
  bootAndVerifyConfiguredRuntimeReleaseSessionCandidate,
  cancelConfiguredRuntimeReleaseSession,
  cutoverConfiguredRuntimeReleaseSession,
  assertRecoveryMutationIdentity,
  attestKnownGood,
  configuredRuntimeReleaseSourceState,
  measureConfiguredRuntimePerformance,
  RECOVERY_INTERNAL_PERFORMANCE_COMMAND,
  diagnose,
  gatewayToken,
  listReleases,
  pinRuntimeRelease,
  prepareConfiguredRuntimeReleaseSession,
  promoteConfiguredRuntimeReleaseSessionKnownGood,
  rollbackConfiguredRuntimeReleaseSession,
  loadRecoveryConfig,
  loadWatchdogState,
  saveWatchdogState,
  reconnectMain,
  recoverPrimaryRuntime,
  recoveryMachineIdentity,
  repairPublicTunnel,
  restartPrimaryConnector,
  restartPrimaryRuntime,
  stageAndActivateConfiguredRuntimeRelease,
  unpinRuntimeRelease,
  rollbackPrevious,
  secureEqual,
  runtimeStatus,
  verifyStableRuntime,
  verifyConfiguredRuntimeReleaseSessionStaticGates,
  watchdogTick,
  type WatchdogState,
  type RecoveryConfig,
  type RecoveryMachineIdentity,
} from './core';
import {
  createRecoveryWatchdogHeartbeat,
  observeRecoveryWatchdogHealth,
  writeRecoveryWatchdogHeartbeat,
  type RecoveryWatchdogHeartbeat,
} from './watchdog-heartbeat';
import {
  RECOVERY_RELEASE_ROLE_CANARY_ARG,
  readCurrentRecoveryRelease,
  writeRecoveryRuntimeIdentity,
  type RecoveryRuntimeIdentity,
  type RecoveryRuntimeRole,
} from './release';
import { RECOVERY_MUTATION_IDENTITY_CONTRACT, RECOVERY_MUTATION_IDENTITY_FIELDS } from './mutation-identity-contract';
import { readReleaseSession } from '../release/release-session';
import { migrateReleaseDurableState } from '../release/release-state-migration';
import {
  advanceConfiguredRuntimeRelease,
  advanceConfiguredRuntimeReleaseStep,
  decideConfiguredRuntimeReleaseReconciliation,
  type RuntimeReleaseProvider,
} from '../release/release-coordinator';
import { runBoundedChild } from '../shared/bounded-child-supervisor';
import { runtimeAuthorityFreeEnvironment } from '../shared/process-environment';

const RECOVERY_RUNTIME_RELEASE_PROVIDER: RuntimeReleaseProvider<RecoveryConfig> = {
  prepare: (config, requestId) => prepareConfiguredRuntimeReleaseSession(config, {}, requestId),
  verifyStatic: (config, sessionId, requestId) => verifyConfiguredRuntimeReleaseSessionStaticGates(config, sessionId, requestId),
  verifyCandidate: (config, sessionId, requestId) => bootAndVerifyConfiguredRuntimeReleaseSessionCandidate(config, sessionId, requestId),
  cutover: (config, sessionId, requestId) => cutoverConfiguredRuntimeReleaseSession(config, sessionId, requestId),
  promoteKnownGood: (config, sessionId, requestId) => promoteConfiguredRuntimeReleaseSessionKnownGood(config, sessionId, {}, requestId),
};

const RECOVERY_INTERNAL_RELEASE_RECONCILE_COMMAND = '__reconcile-runtime-release-step';
const RECOVERY_AUTOMATIC_RELEASE_INTERVAL_MS = 15_000;
/**
 * Upper bound for retrying one non-converging release step. A stuck release must
 * still be retried, but never at a cadence that can starve the daemon that owns it.
 */
const RECOVERY_AUTOMATIC_RELEASE_FAILURE_BACKOFF_MAX_MS = 15 * 60_000;
const RECOVERY_AUTOMATIC_RELEASE_STEP_TIMEOUT_MS = 15 * 60_000;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function controllerHome(): string {
  const home = option('--controller-home') ?? process.env.FORGE_CONTROLLER_HOME;
  if (!home) throw new Error('RECOVERY_CONTROLLER_HOME_REQUIRED');
  return resolve(home);
}

function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

import { runRecoveryControllerHomeMigrationWorker, scheduleRecoveryControllerHomeMigration } from './controller-home-migration';

export const RECOVERY_CLI_COMMANDS = [
  'status',
  'daemon',
  'verify',
  'verify-external',
  'list-releases',
  'attest-known-good',
  'rollback-previous',
  'restart-primary-runtime',
  'restart-primary-connector',
  'recover-primary-runtime',
  'activate-runtime-release',
  'stage-and-activate-runtime-release',
  'release-session-status',
  'release-session-advance',
  'release-session-prepare',
  'release-session-static-verify',
  'release-session-candidate-verify',
  'release-session-cutover',
  'release-session-cancel',
  'release-session-rollback',
  'release-session-known-good',
  'migrate-controller-home-worker',
  'restart-public-tunnel',
  'diagnose',
  'reconnect-main',
] as const;

function usage(): never {
  throw new Error(`RECOVERY_USAGE: ${RECOVERY_CLI_COMMANDS.join(' | ')}`);
}

export function recoveryRuntimeRoleFromExecutable(executable = process.execPath): RecoveryRuntimeRole | undefined {
  const name = basename(executable);
  if (name === 'forge-recovery-gateway') return 'gateway';
  if (name === 'forge-recovery-watchdog') return 'watchdog';
  return undefined;
}

async function cli(): Promise<void> {
  const command = process.argv.find((value, index) => index >= 2 && !value.startsWith('-') && process.argv[index - 1] !== '--controller-home') ?? 'status';
  const config = loadRecoveryConfig(controllerHome(), option('--config'));
  // Internal durable state has one current schema. Every Recovery entrypoint,
  // including gateway/watchdog startup, crosses the same migration boundary as
  // Canonical Runtime before reading or mutating release semantics.
  migrateReleaseDurableState(config.controllerHome);
  const executableRole = recoveryRuntimeRoleFromExecutable();
  if (executableRole) {
    if (command !== executableRole) {
      throw new Error(executableRole === 'gateway' ? 'RECOVERY_GATEWAY_ROLE_ONLY' : 'RECOVERY_WATCHDOG_ROLE_ONLY');
    }
    if (process.argv.includes(RECOVERY_RELEASE_ROLE_CANARY_ARG)) {
      output({ status: 'ok', role: executableRole, executable: basename(process.execPath) });
      return;
    }
    if (executableRole === 'gateway') await startGateway(config);
    else await startWatchdog(config);
    return;
  }
  if (command === RECOVERY_INTERNAL_PERFORMANCE_COMMAND) {
    try {
      output({ schemaVersion: 1, ok: true, evidence: await measureConfiguredRuntimePerformance(config) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      output({
        schemaVersion: 1,
        ok: false,
        error: /^RECOVERY_PERFORMANCE_(?:UNKNOWN|REJECTED):/.test(detail)
          ? detail
          : 'RECOVERY_PERFORMANCE_UNKNOWN: isolated sampler failed',
      });
    }
    return;
  }
  if (command === RECOVERY_INTERNAL_RELEASE_RECONCILE_COMMAND) {
    try {
      const decision = decideConfiguredRuntimeReleaseReconciliation(
        config.controllerHome,
        () => configuredRuntimeReleaseSourceState(config),
      );
      if (!decision.required) {
        output({ schemaVersion: 1, ok: true, attempted: false, noOp: true, decision });
        return;
      }
      const result = await advanceConfiguredRuntimeReleaseStep(
        config,
        RECOVERY_RUNTIME_RELEASE_PROVIDER,
        `recovery-auto-release:${process.pid}:${Date.now()}`,
      );
      output({ schemaVersion: 1, ok: result.ok, attempted: result.attempted, decision, result });
    } catch (error) {
      output({ schemaVersion: 1, ok: false, attempted: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  switch (command) {
    case 'status': output(await runtimeStatus(config)); return;
    case 'daemon': {
      if (process.argv.includes(RECOVERY_RELEASE_ROLE_CANARY_ARG)) {
        output({ status: 'ok', role: 'daemon', executable: basename(process.execPath) });
        return;
      }
      await startRecoveryDaemon(config);
      return;
    }
    case 'verify': output(await verifyStableRuntime(config)); return;
    case 'verify-external': {
      const verified = await verifyStableRuntime(config);
      output({ ok: verified.probes.external_mcp_http?.ok === true, external: verified.probes.external_mcp_http, mcp: verified.probes.mcp_initialize });
      return;
    }
    case 'list-releases': output(await listReleases(config)); return;
    case 'attest-known-good': output(await attestKnownGood(config)); return;
    case 'rollback-previous': output(await rollbackPrevious(config)); return;
    case 'restart-primary-runtime': output(await restartPrimaryRuntime(config)); return;
    case 'restart-primary-connector': output(await restartPrimaryConnector(config)); return;
    case 'recover-primary-runtime': output(await recoverPrimaryRuntime(config)); return;
    case 'activate-runtime-release': {
      const releasePath = option('--release-manifest') ?? option('--release-path');
      const expectedActiveReleaseId = option('--expected-active-release');
      const expectedAuthorityRevisionRaw = option('--expected-authority-revision');
      const expectedAuthorityRevision = Number(expectedAuthorityRevisionRaw);
      if (!releasePath) throw new Error('RECOVERY_RELEASE_MANIFEST_REQUIRED: pass --release-manifest <absolute-path>');
      if (!expectedActiveReleaseId?.trim()) throw new Error('RECOVERY_EXPECTED_ACTIVE_RELEASE_REQUIRED: run list-releases and pass --expected-active-release <release-id>');
      if (!Number.isInteger(expectedAuthorityRevision) || expectedAuthorityRevision < 1) throw new Error('RECOVERY_EXPECTED_AUTHORITY_REVISION_REQUIRED: run list-releases and pass --expected-authority-revision <revision>');
      output(await activateRuntimeRelease(config, releasePath, {}, {
        requestId: `recovery-cli:${process.pid}:${Date.now()}`,
        expectedActiveReleaseId: expectedActiveReleaseId.trim(),
        expectedAuthorityRevision,
      }));
      return;
    }
    case 'stage-and-activate-runtime-release': output(await stageAndActivateConfiguredRuntimeRelease(config, {}, `recovery-cli:${process.pid}:${Date.now()}`)); return;
    case 'release-session-status': {
      const sessionId = option('--session-id');
      if (!sessionId) throw new Error('RECOVERY_RELEASE_SESSION_ID_REQUIRED');
      output(readReleaseSession(config.controllerHome, sessionId) ?? null);
      return;
    }
    case 'release-session-advance': output(await advanceConfiguredRuntimeRelease(config, RECOVERY_RUNTIME_RELEASE_PROVIDER, `recovery-cli:${process.pid}:${Date.now()}`)); return;
    case 'release-session-prepare': output(await prepareConfiguredRuntimeReleaseSession(config, {}, `recovery-cli:${process.pid}:${Date.now()}`)); return;
    case 'release-session-static-verify': {
      const sessionId = option('--session-id');
      if (!sessionId) throw new Error('RECOVERY_RELEASE_SESSION_ID_REQUIRED');
      output(await verifyConfiguredRuntimeReleaseSessionStaticGates(config, sessionId, `recovery-cli:${process.pid}:${Date.now()}`));
      return;
    }
    case 'release-session-candidate-verify': {
      const sessionId = option('--session-id');
      if (!sessionId) throw new Error('RECOVERY_RELEASE_SESSION_ID_REQUIRED');
      output(await bootAndVerifyConfiguredRuntimeReleaseSessionCandidate(config, sessionId, `recovery-cli:${process.pid}:${Date.now()}`));
      return;
    }
    case 'release-session-cutover': {
      const sessionId = option('--session-id');
      if (!sessionId) throw new Error('RECOVERY_RELEASE_SESSION_ID_REQUIRED');
      output(await cutoverConfiguredRuntimeReleaseSession(config, sessionId, `recovery-cli:${process.pid}:${Date.now()}`));
      return;
    }
    case 'release-session-cancel': {
      const sessionId = option('--session-id');
      if (!sessionId) throw new Error('RECOVERY_RELEASE_SESSION_ID_REQUIRED');
      output(await cancelConfiguredRuntimeReleaseSession(config, sessionId, `recovery-cli:${process.pid}:${Date.now()}`));
      return;
    }
    case 'release-session-rollback': {
      const sessionId = option('--session-id');
      if (!sessionId) throw new Error('RECOVERY_RELEASE_SESSION_ID_REQUIRED');
      output(await rollbackConfiguredRuntimeReleaseSession(config, sessionId, {}, `recovery-cli:${process.pid}:${Date.now()}`));
      return;
    }
    case 'release-session-known-good': {
      const sessionId = option('--session-id');
      if (!sessionId) throw new Error('RECOVERY_RELEASE_SESSION_ID_REQUIRED');
      output(await promoteConfiguredRuntimeReleaseSessionKnownGood(config, sessionId, {}, `recovery-cli:${process.pid}:${Date.now()}`));
      return;
    }
    case 'migrate-controller-home-worker': {
      const canonicalSourceRoot = option('--canonical-source-root');
      const expectedSourceRevision = option('--expected-source-revision');
      const migrationRequestId = option('--request-id');
      if (!canonicalSourceRoot) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_SOURCE_REQUIRED');
      if (!expectedSourceRevision) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_SOURCE_REVISION_REQUIRED');
      if (!migrationRequestId) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      output(await runRecoveryControllerHomeMigrationWorker(config, {
        requestId: migrationRequestId,
        canonicalSourceRoot,
        expectedSourceRevision,
      }));
      return;
    }
    case 'restart-public-tunnel': output(await repairPublicTunnel(config)); return;
    case 'diagnose': output(await diagnose(config)); return;
    case 'reconnect-main': output(await reconnectMain(config)); return;
    default: usage();
  }
}

export function resetWatchdogStateForRecoveryRelease(
  state: WatchdogState,
  releaseRevision: string,
): WatchdogState {
  if (state.recoveryReleaseRevision === releaseRevision) return state;
  return {
    ...state,
    // Recovery binary handoff must never mint a new primary Runtime restart
    // budget. Those counters are bound to the Runtime release and survive both
    // watchdog process exits and immutable Recovery release activation.
    recoveryGatewayRestartUsed: false,
    primaryConnectorFailures: 0,
    primaryConnectorFirstFailureAt: undefined,
    primaryConnectorRestartAttempts: 0,
    primaryConnectorRestartFailures: 0,
    primaryConnectorRestartLastAttemptAt: undefined,
    recoveryReleaseRevision: releaseRevision,
  };
}

async function startWatchdog(config: RecoveryConfig, daemonIdentity?: RecoveryRuntimeIdentity): Promise<void> {
  const runtimeIdentity = daemonIdentity ?? writeRecoveryRuntimeIdentity(config.controllerHome, 'watchdog');
  let heartbeat: RecoveryWatchdogHeartbeat = createRecoveryWatchdogHeartbeat(runtimeIdentity);
  const persistHeartbeat = (patch: Partial<RecoveryWatchdogHeartbeat> = {}) => {
    heartbeat = writeRecoveryWatchdogHeartbeat(config.controllerHome, { ...heartbeat, ...patch });
  };
  persistHeartbeat();
  const pulse = setInterval(() => persistHeartbeat({ lastPulseAt: new Date().toISOString() }), 5_000);
  pulse.unref?.();
  process.stdout.write(JSON.stringify({ status: 'ready', role: 'watchdog', runtimeIdentity }) + '\n');
  const loadedState = loadWatchdogState(config);
  let state = runtimeIdentity?.releaseRevision
    ? resetWatchdogStateForRecoveryRelease(loadedState, runtimeIdentity.releaseRevision)
    : loadedState;
  if (state !== loadedState) state = saveWatchdogState(config, state);
  for (;;) {
    const tickStartedAt = new Date().toISOString();
    persistHeartbeat({ lastPulseAt: tickStartedAt, lastTickStartedAt: tickStartedAt, lastError: undefined });
    try {
      const result = await watchdogTick(config, state);
      state = saveWatchdogState(config, result.state);
      const tickCompletedAt = new Date().toISOString();
      persistHeartbeat({ lastPulseAt: tickCompletedAt, lastTickCompletedAt: tickCompletedAt, lastError: undefined });
      process.stdout.write(JSON.stringify({
        at: new Date().toISOString(),
        action: result.decision.action,
        reason: result.decision.reason,
        failures: state.failures,
        publicTunnelFailures: state.publicTunnelFailures ?? 0,
        runtimeRestartAttempts: state.runtimeRestartAttempts ?? 0,
        runtimeRestartFailures: state.runtimeRestartFailures ?? 0,
        runtimeRestartBudgetIdentity: state.runtimeRestartBudgetIdentity,
        runtimeHealthySince: state.runtimeHealthySince,
        runtimeRestartBudgetExhaustedAt: state.runtimeRestartBudgetExhaustedAt,
        primaryRuntimeRestartDetail: result.primaryRuntimeRestart?.detail,
        primaryRuntimeRecoveryDetail: result.primaryRuntimeRecovery?.detail,
        rollbackDetail: result.rollback?.detail,
        publicTunnelDetail: result.publicTunnelRepair?.detail,
        primaryConnectorRestartDetail: result.primaryConnectorRestart?.detail,
      }) + '\n');
    } catch (error) {
      state = saveWatchdogState(config, { ...state, failures: state.failures + 1, firstFailureAt: state.firstFailureAt ?? Date.now() });
      const detail = error instanceof Error ? error.message : String(error);
      const failedAt = new Date().toISOString();
      persistHeartbeat({ lastPulseAt: failedAt, lastTickFailedAt: failedAt, lastError: detail.slice(0, 500) });
      process.stderr.write(`watchdog probe failed: ${detail}\n`);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 5_000));
  }
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  setCorsHeaders(response);
  response.setHeader('content-type', 'application/json');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(payload));
}

function html(response: ServerResponse, status: number, payload: string): void {
  response.statusCode = status;
  setCorsHeaders(response);
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(payload);
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  response.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-session-id, mcp-protocol-version');
  response.setHeader('access-control-expose-headers', 'www-authenticate, mcp-session-id');
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function auditGateway(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
}

function matchesPath(url: string | undefined, path: string): boolean {
  return url === path || Boolean(url?.startsWith(`${path}?`));
}

function matchesAnyPath(url: string | undefined, paths: string[]): boolean {
  return paths.some((path) => matchesPath(url, path));
}

function mutationInputSchema(
  extraProperties: Record<string, unknown> = {},
  extraRequired: string[] = [],
): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      request_id: { type: 'string', minLength: 8, maxLength: 120 },
      ...RECOVERY_MUTATION_IDENTITY_CONTRACT,
      ...extraProperties,
    },
    required: ['request_id', ...RECOVERY_MUTATION_IDENTITY_FIELDS, ...extraRequired],
    additionalProperties: false,
  };
}

export const RECOVERY_TOOLS = [
  { name: 'runtime_status', description: 'Read canonical Runtime ownership, readiness, endpoint, release observation, and exact Recovery machine identity.', inputSchema: { type: 'object', additionalProperties: false } },
  { name: 'list_releases', description: 'Read active, previous, and known-good whole-Runtime release evidence.', inputSchema: { type: 'object', additionalProperties: false } },
  { name: 'verify_stable_runtime', description: 'Run independent stable runtime verification.', inputSchema: { type: 'object', additionalProperties: false } },
  { name: 'verify_external_runtime', description: 'Verify the external primary MCP endpoint.', inputSchema: { type: 'object', additionalProperties: false } },
  { name: 'attest_known_good', description: 'Record the active release as known-good only after full independent verification succeeds.', inputSchema: mutationInputSchema() },
  { name: 'rollback_previous', description: 'While Canonical Runtime is stopped, atomically restore its attested previous whole-Runtime release and SQLite backup.', inputSchema: mutationInputSchema() },
  { name: 'restart_primary_runtime', description: 'Restart the installed canonical Forge Runtime service only after exact Recovery machine identity matches.', inputSchema: mutationInputSchema() },
  { name: 'restart_primary_connector', description: 'Restart the explicitly configured primary OAuth/Connector service only after exact Recovery machine identity and local Canonical Runtime verification succeed.', inputSchema: mutationInputSchema() },
  { name: 'recover_primary_runtime', description: 'Stop the canonical Runtime, restore the attested previous whole-Runtime release and SQLite backup, restart it, and require verification.', inputSchema: mutationInputSchema() },
  { name: 'activate_runtime_release', description: 'Activate an already staged immutable Runtime release only if machine identity and caller-observed active release/authority revision are still current. Reverse activation of current.previous is rejected; use rollback_previous/recover_primary_runtime instead.', inputSchema: mutationInputSchema({ release_path: { type: 'string', minLength: 8, maxLength: 1024, description: 'Absolute path to the staged immutable Runtime release directory.' }, expected_active_release_id: { type: 'string', minLength: 1, maxLength: 256 }, expected_authority_revision: { type: 'integer', minimum: 1 } }, ['release_path', 'expected_active_release_id', 'expected_authority_revision']) },
  { name: 'pin_runtime_release', description: 'Pin one extant legacy/home-bound immutable Runtime release so retention preserves it for explicit Runtime-only recovery activation. Portable source candidates are rejected and must use ReleaseSession.', inputSchema: mutationInputSchema({ release_path: { type: 'string', minLength: 8, maxLength: 1024, description: 'Absolute path to the immutable Runtime release directory or manifest.' } }, ['release_path']) },
  { name: 'unpin_runtime_release', description: 'Remove the explicit stable Runtime retention pin without deleting or activating any release.', inputSchema: mutationInputSchema() },
  { name: 'activate_pinned_runtime_release', description: 'Activate the explicitly pinned legacy/home-bound Runtime release without restoring an older SQLite backup; portable source candidates are rejected and must use ReleaseSession.', inputSchema: mutationInputSchema({ expected_active_release_id: { type: 'string', minLength: 1, maxLength: 256 }, expected_authority_revision: { type: 'integer', minimum: 1 } }, ['expected_active_release_id', 'expected_authority_revision']) },
  { name: 'stage_and_activate_runtime_release', description: 'Compatibility alias: freeze the fixed configured source, create isolated Candidate B, and build one portable immutable Runtime release into a durable ReleaseSession. It no longer activates Stable A.', inputSchema: mutationInputSchema() },
  { name: 'release_session_status', description: 'Read one durable ReleaseSession and its exact Stable A/Candidate B phase and evidence.', inputSchema: { type: 'object', properties: { session_id: { type: 'string', minLength: 8, maxLength: 120 } }, required: ['session_id'], additionalProperties: false } },
  { name: 'advance_runtime_release_session', description: 'Run the single active normal Runtime ReleaseSession autonomously through all immediately executable phases until known-good or a genuine provider/safety boundary. ReleaseSession remains the sole durable progression authority and no Work is created per phase.', inputSchema: mutationInputSchema() },
  { name: 'prepare_runtime_release_session', description: 'Freeze configured source and Stable A authority, create isolated Candidate B, and build a portable byte-identifiable Runtime artifact without stopping Stable A.', inputSchema: mutationInputSchema() },
  { name: 'verify_runtime_release_session_static', description: 'Run canonical static gates on the frozen source revision and advance only that exact ReleaseSession.', inputSchema: mutationInputSchema({ session_id: { type: 'string', minLength: 8, maxLength: 120 } }, ['session_id']) },
  { name: 'verify_runtime_release_session_candidate', description: 'Boot Candidate B in its isolated ControllerHome/service/port, run whole-Runtime and Recovery restart canaries, and mark the session cutover-eligible while Stable A stays active.', inputSchema: mutationInputSchema({ session_id: { type: 'string', minLength: 8, maxLength: 120 } }, ['session_id']) },
  { name: 'cutover_runtime_release_session', description: 'Perform the single fenced cutover attempt for a cutover-eligible ReleaseSession using the byte-identical verified Candidate B artifact. Failed cutover restores exact Stable A and terminalizes without retry.', inputSchema: mutationInputSchema({ session_id: { type: 'string', minLength: 8, maxLength: 120 } }, ['session_id']) },
  { name: 'cancel_runtime_release_session', description: 'Retire a superseded or rejected Candidate B before cutover, terminalizing the ReleaseSession with the existing failed state and leaving Stable A unchanged.', inputSchema: mutationInputSchema({ session_id: { type: 'string', minLength: 8, maxLength: 120 } }, ['session_id']) },
  { name: 'rollback_runtime_release_session', description: 'Abort the exact in-flight ReleaseSession activation transaction and restore its frozen Stable A whole-Runtime release plus SQLite backup.', inputSchema: mutationInputSchema({ session_id: { type: 'string', minLength: 8, maxLength: 120 } }, ['session_id']) },
  { name: 'promote_runtime_release_session_known_good', description: 'After committed cutover soak, require full verification and performance observation, create a recoverable release+SQLite+service bundle, and terminalize the ReleaseSession known-good.', inputSchema: mutationInputSchema({ session_id: { type: 'string', minLength: 8, maxLength: 120 } }, ['session_id']) },
  { name: 'migrate_controller_home', description: 'Schedule a Linux-only standalone Recovery transaction that relocates this Forge installation to the stable user-level Controller Home, reinstalls immutable Runtime/Connector/Recovery owners, verifies them, and rolls back on failure.', inputSchema: mutationInputSchema({ canonical_source_root: { type: 'string', minLength: 1, maxLength: 1024 }, expected_source_revision: { type: 'string', minLength: 7, maxLength: 80 } }, ['canonical_source_root', 'expected_source_revision']) },
  { name: 'restart_public_tunnel', description: 'Restart the explicitly configured public tunnel only after exact Recovery machine identity and local runtime verification succeeds and the external endpoint is unavailable.', inputSchema: mutationInputSchema() },
  { name: 'reconnect_primary_connector', description: 'Check canonical Runtime Gateway and primary MCP reconnection readiness without publishing a release.', inputSchema: { type: 'object', additionalProperties: false } },
] as const;

const RECOVERY_OAUTH_SCOPE = 'forge';
export const RECOVERY_VERIFIER_OAUTH_CLIENT_ID = 'forge-recovery-verifier-v1';
export const RECOVERY_VERIFIER_OAUTH_CLIENT_NAME = 'Forge Recovery Verification';
export const RECOVERY_VERIFIER_OAUTH_REDIRECT_URI = 'http://127.0.0.1/forge-recovery-oauth-callback';
const RECOVERY_OAUTH_CODE_TTL_MS = 10 * 60_000;
const RECOVERY_MAX_PENDING_OAUTH_CODES = 512;
const RECOVERY_MAX_PENDING_OAUTH_CODES_PER_CLIENT = 32;
const RECOVERY_ACCESS_TOKEN_EXPIRES_IN_SECONDS = 10 * 365 * 24 * 60 * 60;
const TOOL_SECURITY_SCHEMES = [{ type: 'oauth2', scopes: [RECOVERY_OAUTH_SCOPE] }] as const;
const SUPPORTED_TOKEN_AUTH_METHODS = ['client_secret_basic', 'client_secret_post', 'none'] as const;
type TokenAuthMethod = typeof SUPPORTED_TOKEN_AUTH_METHODS[number];

type PendingOAuthCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  resource?: string;
  scope?: string;
  createdAt: number;
};

type OAuthClient = {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: TokenAuthMethod;
  owner: 'recovery_verifier' | 'external';
  createdAt: number;
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export function recoveryOAuthClientRegistrationIdentity(
  body: Record<string, unknown>,
  generatedClientId: string = randomUUID(),
): { clientId: string; owner: 'recovery_verifier' | 'external' } {
  const requestedClientId = typeof body.client_id === 'string' && body.client_id.trim() ? body.client_id.trim() : '';
  if (requestedClientId === RECOVERY_VERIFIER_OAUTH_CLIENT_ID) {
    const validVerifierMetadata = body.client_name === RECOVERY_VERIFIER_OAUTH_CLIENT_NAME
      && stringArray(body.redirect_uris).includes(RECOVERY_VERIFIER_OAUTH_REDIRECT_URI)
      && body.token_endpoint_auth_method === 'none'
      && stringArray(body.grant_types).includes('authorization_code')
      && stringArray(body.response_types).includes('code');
    if (!validVerifierMetadata) throw new Error('RECOVERY_OAUTH_VERIFIER_CLIENT_METADATA_INVALID');
    return { clientId: RECOVERY_VERIFIER_OAUTH_CLIENT_ID, owner: 'recovery_verifier' };
  }
  return { clientId: requestedClientId || generatedClientId, owner: 'external' };
}

function reserveRecoveryOAuthCodeCapacity(
  codes: Map<string, PendingOAuthCode>,
  clientId: string,
  now = Date.now(),
): void {
  for (const [code, pending] of codes) {
    if (now - pending.createdAt > RECOVERY_OAUTH_CODE_TTL_MS) codes.delete(code);
  }
  const evictOldest = (predicate: (pending: PendingOAuthCode) => boolean): boolean => {
    let oldest: { code: string; createdAt: number } | undefined;
    for (const [code, pending] of codes) {
      if (!predicate(pending)) continue;
      if (!oldest || pending.createdAt < oldest.createdAt) oldest = { code, createdAt: pending.createdAt };
    }
    return oldest ? codes.delete(oldest.code) : false;
  };
  while ([...codes.values()].filter((pending) => pending.clientId === clientId).length >= RECOVERY_MAX_PENDING_OAUTH_CODES_PER_CLIENT) {
    if (!evictOldest((pending) => pending.clientId === clientId)) break;
  }
  while (codes.size >= RECOVERY_MAX_PENDING_OAUTH_CODES) {
    if (!evictOldest(() => true)) break;
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body) > 64 * 1024) { request.destroy(); reject(new Error('RECOVERY_REQUEST_TOO_LARGE')); }
    });
    request.on('end', () => resolveBody(body));
    request.on('error', reject);
  });
}

function requestUrl(request: IncomingMessage): URL {
  const host = String(request.headers['x-forwarded-host'] ?? request.headers.host ?? '').split(',')[0].trim() || '127.0.0.1';
  const forwardedProto = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const proto = forwardedProto || (/^(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::\d+)?$/i.test(host) ? 'http' : 'https');
  return new URL(request.url ?? '/', `${proto}://${host}`);
}

function publicOrigin(request: IncomingMessage, config?: Pick<RecoveryConfig, 'recoveryPublicUrl'>): string {
  if (config?.recoveryPublicUrl) return new URL(config.recoveryPublicUrl).origin;
  const url = requestUrl(request);
  return `${url.protocol}//${url.host}`;
}

function resourcePathFromRequest(_request: IncomingMessage): '/recovery/mcp' {
  // Tailscale Serve path-prefix handlers strip the public prefix before
  // proxying to this process. The externally configured Recovery Connector is
  // always advertised at /recovery/mcp even when the local request path is /mcp.
  return '/recovery/mcp';
}

function recoveryResource(request: IncomingMessage, config: Pick<RecoveryConfig, 'recoveryPublicUrl'>): string {
  return `${publicOrigin(request, config)}${resourcePathFromRequest(request)}`;
}

function recoveryAuthorizationServerMetadata(request: IncomingMessage, config: Pick<RecoveryConfig, 'recoveryPublicUrl'>): Record<string, unknown> {
  const origin = publicOrigin(request, config);
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/recovery/oauth/authorize`,
    token_endpoint: `${origin}/recovery/oauth/token`,
    registration_endpoint: `${origin}/recovery/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: SUPPORTED_TOKEN_AUTH_METHODS,
    scopes_supported: [RECOVERY_OAUTH_SCOPE],
  };
}

function recoveryProtectedResourceMetadata(request: IncomingMessage, config: Pick<RecoveryConfig, 'recoveryPublicUrl'>): Record<string, unknown> {
  const origin = publicOrigin(request, config);
  return {
    resource: recoveryResource(request, config),
    authorization_servers: [origin],
    scopes_supported: [RECOVERY_OAUTH_SCOPE],
    bearer_methods_supported: ['header'],
    resource_documentation: `${origin}/recovery/health`,
  };
}

export function recoveryWwwAuthenticate(request: IncomingMessage, config: Pick<RecoveryConfig, 'recoveryPublicUrl'>): string {
  const metadata = `${publicOrigin(request, config)}/.well-known/oauth-protected-resource${resourcePathFromRequest(request)}`;
  return `Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="${metadata}"`;
}

export function recoveryUnauthorizedBody(): { error: string; message: string } {
  return { error: 'invalid_token', message: 'Missing Authorization header' };
}

export type RecoveryMcpRequestClassification = 'not_mcp' | 'auth_required' | 'method_not_supported' | 'mcp';

export function classifyRecoveryMcpRequest(
  request: Pick<IncomingMessage, 'method' | 'url' | 'headers'>,
  expectedToken: string | undefined,
): RecoveryMcpRequestClassification {
  if (!matchesAnyPath(request.url, ['/mcp', '/recovery/mcp'])) return 'not_mcp';
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  if (!expectedToken || !supplied || !secureEqual(supplied, expectedToken)) return 'auth_required';
  if (request.method !== 'POST' && request.method !== 'GET' && request.method !== 'DELETE') return 'method_not_supported';
  return 'mcp';
}

function parseUrlEncoded(input: string): URLSearchParams {
  return new URLSearchParams(input);
}

async function parseRequestParameters(request: IncomingMessage): Promise<URLSearchParams> {
  const raw = await readBody(request);
  if (!raw.trim()) return new URLSearchParams();
  if (/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] ?? ''))) {
    const jsonBody = JSON.parse(raw) as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(jsonBody)) {
      if (typeof value === 'string') params.set(key, value);
      else if (typeof value === 'number' || typeof value === 'boolean') params.set(key, String(value));
    }
    return params;
  }
  return parseUrlEncoded(raw);
}

function parseBasicClientCredentials(request: IncomingMessage): { clientId: string; clientSecret: string } | undefined {
  const authorization = String(request.headers.authorization ?? '');
  const match = authorization.match(/^Basic\s+(.+)$/i);
  if (!match) return undefined;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return undefined;
  return {
    clientId: decodeURIComponent(decoded.slice(0, separator)),
    clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
  };
}

function tokenAuthMethod(value: unknown): TokenAuthMethod {
  return SUPPORTED_TOKEN_AUTH_METHODS.includes(value as TokenAuthMethod) ? value as TokenAuthMethod : 'client_secret_basic';
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderAuthorizeForm(params: URLSearchParams, error?: string): string {
  const hidden = Array.from(params.entries())
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('\n');
  return `<!doctype html>
<meta charset="utf-8">
<title>Authorize Forge Recovery</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 3rem auto; max-width: 38rem; line-height: 1.45; color: #111827; }
  label, input, button { display: block; width: 100%; box-sizing: border-box; }
  input { margin: .4rem 0 1rem; padding: .7rem; font: inherit; }
  button { padding: .75rem 1rem; font: inherit; border: 0; border-radius: .5rem; background: #111827; color: white; cursor: pointer; }
  .error { color: #b91c1c; }
  .hint { color: #4b5563; }
</style>
<h1>Authorize Forge Recovery</h1>
<p class="hint">Enter the local MCP passphrase to let ChatGPT use the recovery-only MCP connector.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post">
${hidden}
  <label>Passphrase
    <input name="passphrase" type="password" autocomplete="current-password" autofocus required>
  </label>
  <button type="submit">Authorize</button>
</form>`;
}

function codeChallengeMatches(verifier: string, challenge: string | undefined, method: string | undefined): boolean {
  if (!challenge) return true;
  if ((method ?? 'plain') === 'plain') return verifier === challenge;
  if (method !== 'S256') return false;
  return createHash('sha256').update(verifier).digest('base64url') === challenge;
}

function isOAuthMetadataPath(request: IncomingMessage): boolean {
  const path = requestUrl(request).pathname;
  return path === '/.well-known/oauth-authorization-server'
    || path === '/.well-known/openid-configuration'
    || path === '/oauth-authorization-server'
    || path === '/openid-configuration'
    || path === '/recovery/.well-known/oauth-authorization-server'
    || path === '/recovery/.well-known/openid-configuration';
}

function isProtectedResourceMetadataPath(request: IncomingMessage): boolean {
  const path = requestUrl(request).pathname;
  return path === '/.well-known/oauth-protected-resource'
    || path === '/.well-known/oauth-protected-resource/mcp'
    || path === '/.well-known/oauth-protected-resource/recovery/mcp'
    || path === '/oauth-protected-resource'
    || path === '/oauth-protected-resource/mcp'
    || path === '/oauth-protected-resource/recovery/mcp'
    || path === '/recovery/.well-known/oauth-protected-resource';
}

function isAuthorizePath(request: IncomingMessage): boolean {
  return requestUrl(request).pathname === '/oauth/authorize' || requestUrl(request).pathname === '/recovery/oauth/authorize';
}

function isTokenPath(request: IncomingMessage): boolean {
  return requestUrl(request).pathname === '/oauth/token' || requestUrl(request).pathname === '/recovery/oauth/token';
}

function isRegisterPath(request: IncomingMessage): boolean {
  return requestUrl(request).pathname === '/oauth/register' || requestUrl(request).pathname === '/recovery/oauth/register';
}

function requestId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{8,120}$/.test(value) ? value : undefined;
}

function mutationResponse(config: RecoveryConfig, payload: unknown): Record<string, unknown> {
  const result = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : { result: payload };
  return { ...result, identity: recoveryMachineIdentity(config) };
}

function assertRecoveryGatewayMutationIdentity(config: RecoveryConfig, args: Record<string, unknown>): RecoveryMachineIdentity {
  const suppliedFields = RECOVERY_MUTATION_IDENTITY_FIELDS.filter((field) => typeof args[field] === 'string' && String(args[field]).trim());
  if (suppliedFields.length === 0) return recoveryMachineIdentity(config);
  return assertRecoveryMutationIdentity(config, args);
}

export async function dispatchRecoveryTool(config: RecoveryConfig, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'runtime_status': return runtimeStatus(config);
    case 'list_releases': return listReleases(config);
    case 'verify_stable_runtime': return verifyStableRuntime(config);
    case 'verify_external_runtime': {
      const verified = await verifyStableRuntime(config);
      const externalConfigured = Boolean(config.publicMcpUrl);
      return {
        ok: externalConfigured ? verified.probes.external_mcp_http?.ok === true : verified.ok,
        externalConfigured,
        external: verified.probes.external_mcp_http,
        mcp: verified.probes.mcp_initialize,
      };
    }
    case 'attest_known_good': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      assertRecoveryGatewayMutationIdentity(config, args);
      return mutationResponse(config, await attestKnownGood(config));
    }
    case 'rollback_previous': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      assertRecoveryGatewayMutationIdentity(config, args);
      return mutationResponse(config, await rollbackPrevious(config, `recovery-gateway:${args.request_id}`));
    }
    case 'restart_primary_runtime': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      assertRecoveryGatewayMutationIdentity(config, args);
      return mutationResponse(config, await restartPrimaryRuntime(config));
    }
    case 'restart_primary_connector': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      assertRecoveryGatewayMutationIdentity(config, args);
      return mutationResponse(config, await restartPrimaryConnector(config, { requestId: `recovery-gateway:${args.request_id}` }));
    }
    case 'recover_primary_runtime': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      assertRecoveryGatewayMutationIdentity(config, args);
      return mutationResponse(config, await recoverPrimaryRuntime(config, `recovery-gateway:${args.request_id}`));
    }
    case 'activate_runtime_release': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      assertRecoveryGatewayMutationIdentity(config, args);
      if (typeof args.release_path !== 'string' || !args.release_path.trim()) throw new Error('RECOVERY_RELEASE_PATH_REQUIRED');
      if (typeof args.expected_active_release_id !== 'string' || !args.expected_active_release_id.trim()) throw new Error('RECOVERY_EXPECTED_ACTIVE_RELEASE_REQUIRED');
      if (!Number.isInteger(args.expected_authority_revision) || Number(args.expected_authority_revision) < 1) throw new Error('RECOVERY_EXPECTED_AUTHORITY_REVISION_REQUIRED');
      const releasePath = args.release_path.trim();
      const manifestPath = basename(releasePath) === 'manifest.json' ? releasePath : join(releasePath, 'manifest.json');
      return mutationResponse(config, await activateRuntimeRelease(config, manifestPath, {}, {
        requestId: `recovery-gateway:${args.request_id}`,
        expectedActiveReleaseId: args.expected_active_release_id.trim(),
        expectedAuthorityRevision: Number(args.expected_authority_revision),
      }));
    }
    case 'pin_runtime_release': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      assertRecoveryGatewayMutationIdentity(config, args);
      if (typeof args.release_path !== 'string' || !args.release_path.trim()) throw new Error('RECOVERY_RELEASE_PATH_REQUIRED');
      const releasePath = args.release_path.trim();
      const manifestPath = basename(releasePath) === 'manifest.json' ? releasePath : join(releasePath, 'manifest.json');
      return mutationResponse(config, await pinRuntimeRelease(config, manifestPath, `recovery-gateway:${args.request_id}`));
    }
    case 'unpin_runtime_release': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      assertRecoveryGatewayMutationIdentity(config, args);
      return mutationResponse(config, await unpinRuntimeRelease(config, `recovery-gateway:${args.request_id}`));
    }
    case 'activate_pinned_runtime_release': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      assertRecoveryGatewayMutationIdentity(config, args);
      if (typeof args.expected_active_release_id !== 'string' || !args.expected_active_release_id.trim()) throw new Error('RECOVERY_EXPECTED_ACTIVE_RELEASE_REQUIRED');
      if (!Number.isInteger(args.expected_authority_revision) || Number(args.expected_authority_revision) < 1) throw new Error('RECOVERY_EXPECTED_AUTHORITY_REVISION_REQUIRED');
      return mutationResponse(config, await activatePinnedRuntimeRelease(config, {}, {
        requestId: `recovery-gateway:${args.request_id}`,
        expectedActiveReleaseId: args.expected_active_release_id.trim(),
        expectedAuthorityRevision: Number(args.expected_authority_revision),
      }));
    }
    case 'stage_and_activate_runtime_release': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      assertRecoveryGatewayMutationIdentity(config, args);
      return mutationResponse(config, await stageAndActivateConfiguredRuntimeRelease(config, {}, `recovery-gateway:${args.request_id}`));
    }
    case 'release_session_status': {
      if (typeof args.session_id !== 'string' || !args.session_id.trim()) throw new Error('RECOVERY_RELEASE_SESSION_ID_REQUIRED');
      return readReleaseSession(config.controllerHome, args.session_id.trim()) ?? null;
    }
    case 'advance_runtime_release_session': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      assertRecoveryGatewayMutationIdentity(config, args);
      return mutationResponse(config, await advanceConfiguredRuntimeRelease(config, RECOVERY_RUNTIME_RELEASE_PROVIDER, `recovery-gateway:${args.request_id}`));
    }
    case 'prepare_runtime_release_session': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      assertRecoveryGatewayMutationIdentity(config, args);
      return mutationResponse(config, await prepareConfiguredRuntimeReleaseSession(config, {}, `recovery-gateway:${args.request_id}`));
    }
    case 'verify_runtime_release_session_static': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      assertRecoveryGatewayMutationIdentity(config, args);
      if (typeof args.session_id !== 'string' || !args.session_id.trim()) throw new Error('RECOVERY_RELEASE_SESSION_ID_REQUIRED');
      return mutationResponse(config, await verifyConfiguredRuntimeReleaseSessionStaticGates(config, args.session_id.trim(), `recovery-gateway:${args.request_id}`));
    }
    case 'verify_runtime_release_session_candidate': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      assertRecoveryGatewayMutationIdentity(config, args);
      if (typeof args.session_id !== 'string' || !args.session_id.trim()) throw new Error('RECOVERY_RELEASE_SESSION_ID_REQUIRED');
      return mutationResponse(config, await bootAndVerifyConfiguredRuntimeReleaseSessionCandidate(config, args.session_id.trim(), `recovery-gateway:${args.request_id}`));
    }
    case 'cutover_runtime_release_session': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      assertRecoveryGatewayMutationIdentity(config, args);
      if (typeof args.session_id !== 'string' || !args.session_id.trim()) throw new Error('RECOVERY_RELEASE_SESSION_ID_REQUIRED');
      return mutationResponse(config, await cutoverConfiguredRuntimeReleaseSession(config, args.session_id.trim(), `recovery-gateway:${args.request_id}`));
    }
    case 'cancel_runtime_release_session': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      assertRecoveryGatewayMutationIdentity(config, args);
      if (typeof args.session_id !== 'string' || !args.session_id.trim()) throw new Error('RECOVERY_RELEASE_SESSION_ID_REQUIRED');
      return mutationResponse(config, await cancelConfiguredRuntimeReleaseSession(config, args.session_id.trim(), `recovery-gateway:${args.request_id}`));
    }
    case 'rollback_runtime_release_session': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      assertRecoveryGatewayMutationIdentity(config, args);
      if (typeof args.session_id !== 'string' || !args.session_id.trim()) throw new Error('RECOVERY_RELEASE_SESSION_ID_REQUIRED');
      return mutationResponse(config, await rollbackConfiguredRuntimeReleaseSession(config, args.session_id.trim(), {}, `recovery-gateway:${args.request_id}`));
    }
    case 'promote_runtime_release_session_known_good': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      assertRecoveryGatewayMutationIdentity(config, args);
      if (typeof args.session_id !== 'string' || !args.session_id.trim()) throw new Error('RECOVERY_RELEASE_SESSION_ID_REQUIRED');
      return mutationResponse(config, await promoteConfiguredRuntimeReleaseSessionKnownGood(config, args.session_id.trim(), {}, `recovery-gateway:${args.request_id}`));
    }
    case 'migrate_controller_home': {
      const migrationRequestId = requestId(args.request_id);
      if (!migrationRequestId) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      assertRecoveryGatewayMutationIdentity(config, args);
      if (typeof args.canonical_source_root !== 'string' || !args.canonical_source_root.trim()) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_SOURCE_REQUIRED');
      if (typeof args.expected_source_revision !== 'string' || !args.expected_source_revision.trim()) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_SOURCE_REVISION_REQUIRED');
      return scheduleRecoveryControllerHomeMigration(config, {
        requestId: migrationRequestId,
        canonicalSourceRoot: args.canonical_source_root.trim(),
        expectedSourceRevision: args.expected_source_revision.trim(),
      });
    }
    case 'restart_public_tunnel': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      assertRecoveryGatewayMutationIdentity(config, args);
      return mutationResponse(config, await repairPublicTunnel(config));
    }
    case 'reconnect_primary_connector': return reconnectMain(config);
    default: throw new Error('RECOVERY_TOOL_NOT_FOUND');
  }
}

/**
 * Stable identity of the release step the daemon is currently driving. A step
 * that keeps failing without progressing (same session, phase, and revision)
 * must not fork a full Recovery executable every interval forever.
 */
function releaseReconciliationFingerprint(decision: { action?: unknown; session?: { sessionId?: unknown; phase?: unknown; revision?: unknown } }): string {
  return [
    typeof decision.action === 'string' ? decision.action : 'none',
    typeof decision.session?.sessionId === 'string' ? decision.session.sessionId : 'none',
    typeof decision.session?.phase === 'string' ? decision.session.phase : 'none',
    typeof decision.session?.revision === 'number' ? String(decision.session.revision) : 'none',
  ].join(':');
}

/**
 * Retry schedule for the automatic release driver. A step that fails without
 * progressing (same fingerprint) backs off exponentially up to a bounded cap so a
 * non-converging release degrades into a slow retry instead of a
 * full-executable fork storm that starves this daemon, the Recovery gateway it
 * serves, and every tunnel behind it. Progress, or a new session/step, resets the
 * schedule; a successful step restores the base interval.
 */
export function nextReleaseReconcileBackoff(
  prior: { fingerprint?: string; consecutiveFailures: number },
  failed: boolean,
  fingerprint: string | undefined,
): { fingerprint?: string; consecutiveFailures: number; delayMs: number } {
  if (!failed) {
    return { fingerprint: undefined, consecutiveFailures: 0, delayMs: RECOVERY_AUTOMATIC_RELEASE_INTERVAL_MS };
  }
  const nextFingerprint = fingerprint ?? 'unknown';
  const consecutiveFailures = nextFingerprint === prior.fingerprint ? Math.max(1, prior.consecutiveFailures) + 1 : 1;
  return {
    fingerprint: nextFingerprint,
    consecutiveFailures,
    delayMs: Math.min(RECOVERY_AUTOMATIC_RELEASE_INTERVAL_MS * 2 ** (consecutiveFailures - 1), RECOVERY_AUTOMATIC_RELEASE_FAILURE_BACKOFF_MAX_MS),
  };
}

async function runAutomaticReleaseReconciliationStep(
  config: RecoveryConfig,
  observed: { fingerprint?: string } = {},
): Promise<void> {
  // Most daemon ticks are no-ops. Decide that in the resident process first so
  // a healthy/current source does not fork a complete Recovery executable every
  // fifteen seconds merely to rediscover the same result. The short-lived child
  // remains the mutation boundary whenever a durable release action is needed.
  const decision = decideConfiguredRuntimeReleaseReconciliation(
    config.controllerHome,
    () => configuredRuntimeReleaseSourceState(config),
  );
  observed.fingerprint = decision.required ? releaseReconciliationFingerprint(decision) : undefined;
  if (!decision.required) return;

  const release = readCurrentRecoveryRelease(config.controllerHome);
  if (!release) throw new Error('RECOVERY_AUTOMATIC_RELEASE_CURRENT_RECOVERY_UNKNOWN');
  const executable = join(release.releasePath, 'forge-recovery');
  if (!existsSync(executable)) throw new Error('RECOVERY_AUTOMATIC_RELEASE_EXECUTABLE_UNAVAILABLE');
  const result = await runBoundedChild(
    executable,
    [RECOVERY_INTERNAL_RELEASE_RECONCILE_COMMAND, '--controller-home', config.controllerHome],
    {
      timeoutMs: RECOVERY_AUTOMATIC_RELEASE_STEP_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
      forwardSignals: false,
      env: runtimeAuthorityFreeEnvironment(process.env),
    },
  );
  if (result.status !== 0 || result.failureCode || result.timedOut) {
    const detail = result.failureCode ?? result.error ?? (result.stderr.trim() || `exit=${result.status}`);
    throw new Error(`RECOVERY_AUTOMATIC_RELEASE_STEP_FAILED: ${detail.slice(0, 500)}`);
  }
  let envelope: unknown;
  try { envelope = JSON.parse(result.stdout); }
  catch { throw new Error('RECOVERY_AUTOMATIC_RELEASE_PROTOCOL_INVALID'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('RECOVERY_AUTOMATIC_RELEASE_PROTOCOL_INVALID');
  const parsed = envelope as {
    ok?: unknown;
    attempted?: unknown;
    error?: unknown;
    decision?: { reason?: unknown; action?: unknown };
    result?: { detail?: unknown };
  };
  if (parsed.ok !== true) {
    const detail = typeof parsed.error === 'string'
      ? parsed.error
      : typeof parsed.result?.detail === 'string'
        ? parsed.result.detail
        : 'automatic release reconciliation failed';
    throw new Error(`RECOVERY_AUTOMATIC_RELEASE_STEP_FAILED: ${detail.slice(0, 500)}`);
  }
  if (parsed.decision?.action) {
    process.stdout.write(JSON.stringify({
      at: new Date().toISOString(),
      action: 'automatic_release_reconcile',
      reason: parsed.decision?.reason,
      releaseAction: parsed.decision?.action,
    }) + '\n');
  }
}

async function startAutomaticReleaseReconciliation(config: RecoveryConfig): Promise<never> {
  let lastFailedFingerprint: string | undefined;
  let consecutiveFailures = 0;
  for (;;) {
    const observed: { fingerprint?: string } = {};
    let failure: string | undefined;
    try {
      await runAutomaticReleaseReconciliationStep(config, observed);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      process.stderr.write(`automatic release reconciliation failed: ${failure}\n`);
    }
    const backoff = nextReleaseReconcileBackoff(
      { fingerprint: lastFailedFingerprint, consecutiveFailures },
      Boolean(failure),
      observed.fingerprint,
    );
    lastFailedFingerprint = backoff.fingerprint;
    consecutiveFailures = backoff.consecutiveFailures;
    if (failure && backoff.delayMs > RECOVERY_AUTOMATIC_RELEASE_INTERVAL_MS) {
      process.stderr.write(
        `automatic release reconciliation backing off ${Math.round(backoff.delayMs / 1000)}s after ${backoff.consecutiveFailures} consecutive failures of ${backoff.fingerprint}\n`,
      );
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, backoff.delayMs));
  }
}

async function startRecoveryDaemon(config: RecoveryConfig): Promise<void> {
  const runtimeIdentity = writeRecoveryRuntimeIdentity(config.controllerHome, 'daemon');

  // The Recovery gateway is the control plane used to repair every other
  // Recovery subsystem. Bind it before starting background work. A reconcile
  // or watchdog tick may perform expensive synchronous setup before its first
  // await, so invoking those loops first can leave a live daemon process with
  // no listening gateway.
  const backgroundTimer = setTimeout(() => {
    void startAutomaticReleaseReconciliation(config).catch((error) => {
      process.stderr.write(`Recovery release driver failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
    if (config.installProfile === 'self-healing') {
      void startWatchdog(config, runtimeIdentity).catch((error) => {
        process.stderr.write(`Recovery monitor failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      });
    }
  }, 0);
  backgroundTimer.unref?.();

  await startGateway(config, runtimeIdentity);
}

async function startGateway(config: RecoveryConfig, daemonIdentity?: RecoveryRuntimeIdentity): Promise<void> {
  const gateway = config.gateway;
  if (!gateway || gateway.host !== '127.0.0.1' || !Number.isInteger(gateway.port) || gateway.port < 1024 || gateway.port > 65535) {
    throw new Error('RECOVERY_GATEWAY_CONFIG_INVALID');
  }
  let runtimeIdentity: RecoveryRuntimeIdentity | undefined = daemonIdentity;
  const recentMutations = new Map<string, number[]>();
  const oauthCodes = new Map<string, PendingOAuthCode>();
  const oauthClients = new Map<string, OAuthClient>();
  const recoveryTools = RECOVERY_TOOLS.map((tool) => ({
    ...tool,
    securitySchemes: TOOL_SECURITY_SCHEMES,
    _meta: { securitySchemes: TOOL_SECURITY_SCHEMES },
  })) as unknown as Tool[];
  const recoveryMcp = new RecoveryMcpServer({
    tools: recoveryTools,
    dispatchTool: async (name, args, context) => {
      if (name === 'attest_known_good' || name === 'rollback_previous' || name === 'restart_primary_runtime' || name === 'restart_primary_connector' || name === 'recover_primary_runtime' || name === 'activate_runtime_release' || name === 'pin_runtime_release' || name === 'unpin_runtime_release' || name === 'activate_pinned_runtime_release' || name === 'stage_and_activate_runtime_release' || name === 'prepare_runtime_release_session' || name === 'verify_runtime_release_session_static' || name === 'verify_runtime_release_session_candidate' || name === 'cutover_runtime_release_session' || name === 'promote_runtime_release_session_known_good' || name === 'migrate_controller_home' || name === 'restart_public_tunnel') {
        const now = Date.now();
        const window = (recentMutations.get(context.remoteAddress) ?? []).filter((at) => now - at < 60_000);
        if (window.length >= 3) throw new Error('Recovery mutation rate limit exceeded.');
        window.push(now);
        recentMutations.set(context.remoteAddress, window);
      }
      return await dispatchRecoveryTool(config, name, args);
    },
  });
  const server = createServer(async (request, response) => {
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      setCorsHeaders(response);
      response.end();
      return;
    }
    if (request.method === 'GET' && matchesAnyPath(request.url, ['/health', '/recovery/health'])) {
      const watchdog = config.installProfile === 'self-healing'
        ? observeRecoveryWatchdogHealth(config.controllerHome)
        : { ok: true, detail: 'Recovery monitor disabled by gateway install profile' };
      json(response, 200, {
        status: watchdog.ok ? 'ok' : 'degraded',
        service: 'forge-standalone-recovery',
        watchdog: {
          ok: watchdog.ok,
          detail: watchdog.detail,
          pulseAgeMs: 'pulseAgeMs' in watchdog ? watchdog.pulseAgeMs : undefined,
          tickAgeMs: 'tickAgeMs' in watchdog ? watchdog.tickAgeMs : undefined,
          releaseRevision: 'runtimeIdentity' in watchdog ? watchdog.runtimeIdentity?.releaseRevision : runtimeIdentity?.releaseRevision,
          pid: 'runtimeIdentity' in watchdog ? watchdog.runtimeIdentity?.pid : runtimeIdentity?.pid,
        },
        version: FORGE_VERSION,
        ...(runtimeIdentity ? {
          releasePath: runtimeIdentity.releasePath,
          releaseRevision: runtimeIdentity.releaseRevision,
          sourceCommit: runtimeIdentity.sourceCommit,
          manifestSha256: runtimeIdentity.manifestSha256,
        } : {}),
      });
      return;
    }
    if (request.method === 'GET' && isProtectedResourceMetadataPath(request)) { json(response, 200, recoveryProtectedResourceMetadata(request, config)); return; }
    if (request.method === 'GET' && isOAuthMetadataPath(request)) { json(response, 200, recoveryAuthorizationServerMetadata(request, config)); return; }
    if ((request.method === 'GET' || request.method === 'POST') && isAuthorizePath(request)) {
      const params = request.method === 'GET'
        ? requestUrl(request).searchParams
        : parseUrlEncoded(await readBody(request));
      const redirectUri = params.get('redirect_uri');
      const clientId = params.get('client_id');
      const responseType = params.get('response_type');
      if (!redirectUri || !clientId || responseType !== 'code') { json(response, 400, { error: 'invalid_request' }); return; }
      if (request.method === 'GET') { html(response, 200, renderAuthorizeForm(params)); return; }
      const expectedPassphrase = readMcpServiceOAuthPassphrase(config.controllerHome);
      const suppliedPassphrase = params.get('passphrase') ?? '';
      if (!expectedPassphrase || !secureEqual(suppliedPassphrase, expectedPassphrase)) {
        html(response, 401, renderAuthorizeForm(params, 'Invalid passphrase.'));
        return;
      }
      reserveRecoveryOAuthCodeCapacity(oauthCodes, clientId);
      const code = randomUUID();
      oauthCodes.set(code, {
        clientId,
        redirectUri,
        codeChallenge: params.get('code_challenge') ?? undefined,
        codeChallengeMethod: params.get('code_challenge_method') ?? undefined,
        resource: params.get('resource') ?? undefined,
        scope: params.get('scope') ?? undefined,
        createdAt: Date.now(),
      });
      const callback = new URL(redirectUri);
      callback.searchParams.set('code', code);
      const state = params.get('state');
      if (state) callback.searchParams.set('state', state);
      response.statusCode = 302;
      response.setHeader('location', callback.toString());
      response.end();
      return;
    }
    if (request.method === 'POST' && isRegisterPath(request)) {
      let body: Record<string, unknown> = {};
      try {
        const raw = await readBody(request);
        body = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {};
      } catch { /* tolerate minimal DCR clients */ }
      let registrationIdentity: ReturnType<typeof recoveryOAuthClientRegistrationIdentity>;
      try {
        registrationIdentity = recoveryOAuthClientRegistrationIdentity(body);
      } catch (error) {
        auditGateway({ oauth: 'register', outcome: 'invalid_client_metadata' });
        json(response, 400, { error: 'invalid_client_metadata', error_description: error instanceof Error ? error.message : String(error) });
        return;
      }
      const { clientId, owner } = registrationIdentity;
      const reused = oauthClients.has(clientId);
      const clientSecret = randomUUID();
      const authMethod = tokenAuthMethod(body.token_endpoint_auth_method);
      oauthClients.set(clientId, {
        clientId,
        clientSecret: authMethod === 'none' ? undefined : clientSecret,
        tokenEndpointAuthMethod: authMethod,
        owner,
        createdAt: Date.now(),
      });
      auditGateway({ oauth: 'register', outcome: reused ? 'reused' : 'created', client_owner: owner, token_endpoint_auth_method: authMethod });
      json(response, 201, {
        ...body,
        client_id: clientId,
        ...(authMethod === 'none' ? {} : { client_secret: clientSecret }),
        client_secret_expires_at: 0,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: authMethod,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        ...(owner === 'recovery_verifier' ? { forge_client_owner: owner, forge_client_reused: reused } : {}),
      });
      return;
    }
    if (request.method === 'POST' && isTokenPath(request)) {
      let params: URLSearchParams;
      try {
        params = await parseRequestParameters(request);
      } catch {
        auditGateway({ oauth: 'token', outcome: 'invalid_request' });
        json(response, 400, { error: 'invalid_request' });
        return;
      }
      if (params.get('grant_type') !== 'authorization_code') {
        auditGateway({ oauth: 'token', outcome: 'unsupported_grant_type' });
        json(response, 400, { error: 'unsupported_grant_type' });
        return;
      }
      const basicCredentials = parseBasicClientCredentials(request);
      const code = params.get('code');
      const clientId = basicCredentials?.clientId ?? params.get('client_id') ?? '';
      const clientSecret = basicCredentials?.clientSecret ?? params.get('client_secret') ?? '';
      const redirectUri = params.get('redirect_uri') ?? '';
      const verifier = params.get('code_verifier') ?? '';
      const pending = code ? oauthCodes.get(code) : undefined;
      if (!code || !pending || pending.clientId !== clientId || pending.redirectUri !== redirectUri || Date.now() - pending.createdAt > RECOVERY_OAUTH_CODE_TTL_MS) {
        auditGateway({ oauth: 'token', outcome: 'invalid_grant' });
        json(response, 400, { error: 'invalid_grant' });
        return;
      }
      const registeredClient = oauthClients.get(clientId);
      if (registeredClient?.clientSecret && !secureEqual(clientSecret, registeredClient.clientSecret)) {
        auditGateway({ oauth: 'token', outcome: 'invalid_client', token_endpoint_auth_method: registeredClient.tokenEndpointAuthMethod });
        response.setHeader('www-authenticate', 'Basic realm="forge-recovery-oauth"');
        json(response, 401, { error: 'invalid_client' });
        return;
      }
      if (!codeChallengeMatches(verifier, pending.codeChallenge, pending.codeChallengeMethod)) {
        auditGateway({ oauth: 'token', outcome: 'invalid_grant_pkce' });
        json(response, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }
      oauthCodes.delete(code);
      const token = gatewayToken(config);
      if (!token) {
        auditGateway({ oauth: 'token', outcome: 'server_error' });
        json(response, 503, { error: 'server_error', error_description: 'Recovery token is not configured' });
        return;
      }
      auditGateway({ oauth: 'token', outcome: 'issued' });
      json(response, 200, {
        access_token: token,
        token_type: 'Bearer',
        expires_in: RECOVERY_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
        scope: pending.scope || RECOVERY_OAUTH_SCOPE,
      });
      return;
    }
    const mcpRequest = classifyRecoveryMcpRequest(request, gatewayToken(config));
    if (mcpRequest === 'not_mcp' || mcpRequest === 'method_not_supported') { json(response, 404, { error: 'NOT_FOUND' }); return; }
    if (mcpRequest === 'auth_required') { response.setHeader('www-authenticate', recoveryWwwAuthenticate(request, config)); json(response, 401, recoveryUnauthorizedBody()); return; }
    let body: unknown;
    if (request.method === 'POST') {
      if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] ?? ''))) { json(response, 415, { error: 'RECOVERY_CONTENT_TYPE_REQUIRED' }); return; }
      try { body = JSON.parse(await readBody(request)); } catch { json(response, 400, rpcError(null, -32700, 'Invalid JSON.')); return; }
    }
    await recoveryMcp.handle(request, response, body);
  });
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(gateway.port, gateway.host, () => resolveListen()); });
  runtimeIdentity ??= writeRecoveryRuntimeIdentity(config.controllerHome, 'gateway');
  process.stdout.write(JSON.stringify({ status: 'ready', host: gateway.host, port: gateway.port, runtimeIdentity }) + '\n');
}

const isDirectExecution = import.meta.main === true
  || Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);

if (isDirectExecution) {
  void cli().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
