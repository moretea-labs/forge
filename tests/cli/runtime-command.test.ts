import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { buildMcpCommand } from '../../src/cli/commands/mcp';

const ROOT = join(import.meta.dir, '../..');
const CLI = join(ROOT, 'src/cli/index.ts');
const PACKAGE_JSON = join(ROOT, 'package.json');

describe('runtime command surface', () => {
  test('is read-only and exposes no parallel lifecycle owner', () => {
    const result = spawnSync('bun', [CLI, 'runtime', '--help'], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('status');
    expect(result.stdout).toContain('job');
    expect(result.stdout).toContain('jobs');
    expect(result.stdout).toContain('schedules');
    expect(result.stdout).toContain('service');
    expect(result.stdout).not.toMatch(/^\s+start\b/m);
    expect(result.stdout).not.toMatch(/^\s+stop\b/m);
    expect(result.stdout).not.toMatch(/^\s+restart\b/m);
    expect(result.stdout).not.toMatch(/^\s+doctor\b/m);
  });

  test('runtime service install is the single documented launchd owner surface', () => {
    const service = spawnSync('bun', [CLI, 'runtime', 'service', '--help'], { cwd: ROOT, encoding: 'utf-8' });
    expect(service.status).toBe(0);
    expect(service.stdout).toContain('install');
    expect(service.stdout).not.toMatch(/^\s+start\b/m);
    expect(service.stdout).not.toMatch(/^\s+stop\b/m);
    expect(service.stdout).not.toMatch(/^\s+restart\b/m);
    expect(service.stdout).not.toMatch(/^\s+keepalive\b/m);

    const install = spawnSync('bun', [CLI, 'runtime', 'service', 'install', '--help'], { cwd: ROOT, encoding: 'utf-8' });
    expect(install.status).toBe(0);
    expect(install.stdout).toContain('--controller-home');
    expect(install.stdout).toContain('--repo');
    expect(install.stdout).toContain('--port');
    expect(install.stdout).not.toMatch(/^\s+keepalive\b/m);
  });

  test('root public surface keeps the legacy controller lifecycle and component rollout owner retired', () => {
    const root = spawnSync('bun', [CLI, '--help'], { cwd: ROOT, encoding: 'utf-8' });
    expect(root.status).toBe(0);
    expect(root.stdout).toContain('runtime');
    expect(root.stdout).not.toMatch(/^\s+controller\b/m);
    expect(root.stdout).not.toMatch(/^\s+supervisor\b/m);
    const rootSource = readFileSync(join(ROOT, 'src/cli/index.ts'), 'utf8');
    expect(rootSource).not.toContain("'supervisor'");
    expect(rootSource).not.toContain('bindInheritedRuntimeWriterClaimFromEnvironment');
  });

  test('package scripts expose no legacy lifecycle or component rollout owner', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
      scripts?: Record<string, string>;
      bin?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    for (const legacy of [
      'controller:start',
      'controller:stop',
      'controller:status',
      'controller:restart',
      'controller:logs',
      'runtime:restart',
      'repo:rollout',
    ]) {
      expect(scripts).not.toHaveProperty(legacy);
    }
    expect(Object.values(scripts).join('\n')).not.toMatch(/controller-runtime\.sh|restart-forge\.sh|rollout-all-registered-repos\.sh/);
    expect(pkg.bin?.['forge-runtime']).toBe('bin/forge-runtime.mjs');
  });

  test('MCP command surface exposes no KeepAlive or restart lifecycle owner', () => {
    const commandNames = buildMcpCommand().commands.map((command) => command.name());
    for (const expected of ['serve', 'doctor', 'setup']) expect(commandNames).toContain(expected);
    expect(commandNames).not.toContain('keepalive');
    expect(commandNames).not.toContain('restart');
    expect(existsSync(join(ROOT, 'src/cli/mcp/keepalive.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'src/cli/mcp/restart.ts'))).toBe(false);
    const mcpCommand = readFileSync(join(ROOT, 'src/cli/commands/mcp.ts'), 'utf8');
    const lifecycleAuthority = readFileSync(join(ROOT, 'src/cli/controller/lifecycle-authority.ts'), 'utf8');
    const mcpAuth = readFileSync(join(ROOT, 'src/cli/mcp/auth.ts'), 'utf8');
    const httpTransport = readFileSync(join(ROOT, 'src/cli/mcp/transports/http.ts'), 'utf8');
    const runtimeTools = readFileSync(join(ROOT, 'src/runtime/gateway/mcp/runtime-tools.ts'), 'utf8');
    const toolsetNames = readFileSync(join(ROOT, 'src/cli/mcp/toolset-names.ts'), 'utf8');
    const processGc = readFileSync(join(ROOT, 'src/runtime/execution/process-runtime/gc.ts'), 'utf8');
    const workerOwnership = readFileSync(join(ROOT, 'src/runtime/execution/workers/ownership.ts'), 'utf8');
    const workerEntry = readFileSync(join(ROOT, 'src/runtime/execution/workers/worker-entry.ts'), 'utf8');
    const projectionInvalidation = readFileSync(join(ROOT, 'src/runtime/projections/invalidation.ts'), 'utf8');
    const materializedView = readFileSync(join(ROOT, 'src/runtime/projections/materialized-view.ts'), 'utf8');
    const controllerContextProjection = readFileSync(join(ROOT, 'src/runtime/projections/controller-context.ts'), 'utf8');
    const compositeOperations = readFileSync(join(ROOT, 'src/cli/controller/composite-operations.ts'), 'utf8');
    const controllerPostcondition = readFileSync(join(ROOT, 'src/cli/controller/postcondition.ts'), 'utf8');
    const localBridgeServer = readFileSync(join(ROOT, 'src/cli/local-bridge/server.ts'), 'utf8');
    const repoActor = readFileSync(join(ROOT, 'src/runtime/control-plane/repo-actor/actor.ts'), 'utf8');
    const executionWorker = readFileSync(join(ROOT, 'src/runtime/execution/workers/executor.ts'), 'utf8');
    const globalScheduler = readFileSync(join(ROOT, 'src/runtime/control-plane/global-scheduler/scheduler.ts'), 'utf8');
    const processRuntime = readFileSync(join(ROOT, 'src/runtime/execution/process-runtime/runtime.ts'), 'utf8');
    const daemonClient = readFileSync(join(ROOT, 'src/runtime/control-plane/runtime-status-client.ts'), 'utf8');
    const releaseStore = readFileSync(join(ROOT, 'src/runtime/root/release-store.ts'), 'utf8');
    const writeFence = readFileSync(join(ROOT, 'src/runtime/root/write-fence.ts'), 'utf8');
    const operationReceiptStore = readFileSync(join(ROOT, 'src/runtime/execution/jobs/receipt-store.ts'), 'utf8');
    const localBridgeSurface = readFileSync(join(ROOT, 'src/runtime/shared/local-bridge-surface.ts'), 'utf8');
    const localBridgeFacade = readFileSync(join(ROOT, 'src/cli/local-bridge/facade-api.ts'), 'utf8');
    const standaloneRecovery = readFileSync(join(ROOT, 'src/runtime/standalone-recovery/core.ts'), 'utf8');
    const facadeActions = readFileSync(join(ROOT, 'src/runtime/control-plane/facade/suggested-actions.ts'), 'utf8');
    const capabilityRegistry = readFileSync(join(ROOT, 'src/runtime/control-plane/facade/capability-registry.ts'), 'utf8');
    const sourceBaseline = readFileSync(join(ROOT, 'scripts/activate-source-baseline.ts'), 'utf8');
    expect(sourceBaseline).toContain("['rev-parse', '--is-inside-work-tree']");
    expect(sourceBaseline).toContain("reason: 'WORKTREE_NOT_GIT_REPOSITORY'");
    expect(mcpCommand).toContain('bindInheritedRuntimeWriteClaimFromEnvironment');
    expect(mcpCommand).toContain("from '../../runtime/root/write-fence'");
    expect(mcpCommand).not.toContain('stable-state/runtime-writer-context');
    expect(lifecycleAuthority).toContain('forge-runtime');
    expect(lifecycleAuthority).not.toContain('controller start|stop|restart');
    expect(existsSync(join(ROOT, 'src/cli/controller/lifecycle.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'src/cli/commands/supervisor.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'src/cli/controller/stable-state/runtime-writer-context.ts'))).toBe(false);
    const oauthFallbackStart = mcpAuth.indexOf('export function mcpServiceOAuthTokenStoreFallbackPaths');
    const oauthFallbackEnd = mcpAuth.indexOf('export function mcpControllerHomeRuntimeStatePath', oauthFallbackStart);
    const oauthFallbackBlock = mcpAuth.slice(oauthFallbackStart, oauthFallbackEnd);
    expect(oauthFallbackBlock).not.toContain('runtime-slots');
    for (const legacyAuthorityPath of [
      'src/cli/controller/runtime-slots.ts',
      'src/cli/controller/stable-state',
      'src/cli/controller/restart-coordinator-entry.ts',
      'src/runtime/bootstrap/runtime-authority.ts',
      'src/runtime/bootstrap/activation-transaction.ts',
      'src/runtime/bootstrap/stable-bootstrap.ts',
      'scripts/controller-runtime.sh',
      'scripts/activate-source-baseline.command',
      'scripts/restart-forge.sh',
    ]) expect(existsSync(join(ROOT, legacyAuthorityPath))).toBe(false);
    expect(httpTransport).not.toContain('ensureControllerDaemon');
    expect(httpTransport).toContain('readForgeRuntimeStatus');
    expect(runtimeTools).not.toContain('ensureControllerDaemon');
    expect(runtimeTools).not.toContain('cli/mcp/keepalive');
    const readinessStart = runtimeTools.indexOf('const readinessWithToolSurface = {');
    const readinessEnd = runtimeTools.indexOf('const detailLevel', readinessStart);
    const readinessBlock = runtimeTools.slice(readinessStart, readinessEnd);
    expect(readinessStart).toBeGreaterThanOrEqual(0);
    expect(readinessEnd).toBeGreaterThan(readinessStart);
    expect(readinessBlock).toContain('ready: effectiveReady');
    expect(readinessBlock).toContain('reasonCodes:');
    expect(readinessBlock).toContain('diagnostics:');
    expect(readinessBlock).not.toContain('state:');
    expect(readinessBlock).not.toContain('...readiness');
    const recoveryProbeStart = runtimeTools.indexOf("case 'capability_recovery_probe':");
    const recoveryProbeEnd = runtimeTools.indexOf("case 'capability_recovery_plan':", recoveryProbeStart);
    const recoveryProbeBlock = runtimeTools.slice(recoveryProbeStart, recoveryProbeEnd);
    expect(recoveryProbeBlock).toContain('ownsRuntimeLifecycle: false');
    expect(recoveryProbeBlock).not.toContain('recovery: snapshot');
    expect(recoveryProbeBlock).not.toContain('recommendedActions');
    const recoveryApplyStart = runtimeTools.indexOf("case 'capability_recovery_apply':");
    const recoveryApplyEnd = runtimeTools.indexOf("case 'runtime_storage_repair_preview':", recoveryApplyStart);
    const recoveryApplyBlock = runtimeTools.slice(recoveryApplyStart, recoveryApplyEnd);
    expect(recoveryApplyStart).toBeGreaterThanOrEqual(0);
    expect(recoveryApplyEnd).toBeGreaterThan(recoveryApplyStart);
    expect(recoveryApplyBlock).not.toContain('RUNTIME_LIFECYCLE_ACTION_RETIRED');
    expect(recoveryApplyBlock).not.toContain('recovery.restart_controller');
    expect(recoveryApplyBlock).not.toContain('recovery.restart_local_bridge');
    expect(recoveryApplyBlock).not.toContain('stableSupervisorFacadeMutation');
    expect(recoveryApplyBlock).not.toContain('scheduleControllerServiceRestart');
    expect(runtimeTools).not.toContain("case 'self_healing_loop_plan':");
    expect(runtimeTools).not.toContain("case 'self_healing_monitor_tick':");
    expect(runtimeTools).not.toContain('AUTONOMOUS_RUNTIME_RECOVERY_RETIRED');
    const contextSummaryStart = runtimeTools.indexOf('function compactControllerContextSummaryPayload');
    const contextSummaryEnd = runtimeTools.indexOf('function authenticatedFacadeControllerIdentity', contextSummaryStart);
    const contextSummaryBlock = runtimeTools.slice(contextSummaryStart, contextSummaryEnd);
    expect(contextSummaryBlock).toContain('ready: ready.ready === true');
    expect(contextSummaryBlock).toContain('reasonCodes:');
    expect(contextSummaryBlock).not.toContain('state: ready.state');
    expect(contextSummaryBlock).not.toContain('operationalView:');
    const contextHandlerStart = runtimeTools.indexOf("case 'controller_context':");
    const contextHandlerEnd = runtimeTools.indexOf("case 'get_job':", contextHandlerStart);
    const contextHandlerBlock = runtimeTools.slice(contextHandlerStart, contextHandlerEnd);
    expect(contextHandlerBlock).toContain('await controllerReadiness(ctx, repository)');
    expect(contextHandlerBlock).not.toContain('await controllerReadinessEvidence(ctx, repository)');
    expect(contextHandlerBlock).not.toContain('operationalView: readiness.operationalView');
    const runtimeIdentityStart = runtimeTools.indexOf('export function runtimeIdentitySnapshot');
    const runtimeIdentityEnd = runtimeTools.indexOf('function controllerContextAssessment', runtimeIdentityStart);
    const runtimeIdentityBlock = runtimeTools.slice(runtimeIdentityStart, runtimeIdentityEnd);
    expect(runtimeIdentityBlock).toContain('observeRuntimeStatus(ctx.controllerHome)');
    expect(runtimeIdentityBlock).toContain('runtimeInstanceId: snapshot?.runtimeInstanceId');
    expect(runtimeIdentityBlock).not.toContain('readSupervisorState');
    expect(runtimeIdentityBlock).not.toContain('readCurrentSupervisorRelease');
    expect(runtimeIdentityBlock).not.toContain('readActiveSlotAuthority');
    expect(runtimeIdentityBlock).not.toContain('previousSlot');
    expect(runtimeIdentityBlock).not.toContain('activeSlot:');
    const localBridgeStart = runtimeTools.indexOf("case 'local_bridge_status':");
    const localBridgeEnd = runtimeTools.indexOf("case 'get_local_job':", localBridgeStart);
    const localBridgeBlock = runtimeTools.slice(localBridgeStart, localBridgeEnd);
    expect(localBridgeBlock).toContain('ready: health.components.localBridge.ready');
    expect(localBridgeBlock).not.toContain('readActiveSlotAuthority');
    expect(localBridgeBlock).not.toContain('activeSlot');
    expect(localBridgeBlock).not.toContain('generationMatches');
    expect(localBridgeBlock).not.toContain('health: health.components.localBridge.state');
    expect(localBridgeBlock).not.toContain('state: health.state');
    const readinessEvidenceStart = runtimeTools.indexOf('export async function controllerReadinessEvidence');
    const readinessEvidenceEnd = runtimeTools.indexOf('export async function controllerReadiness(', readinessEvidenceStart);
    const readinessEvidenceBlock = runtimeTools.slice(readinessEvidenceStart, readinessEvidenceEnd);
    expect(readinessEvidenceBlock).toContain('expectedSurface: localBridgeExpectedSurface');
    expect(readinessEvidenceBlock).toContain('generation: localBridgeSurface?.generation');
    expect(readinessEvidenceBlock).not.toContain('repoRoot: repository?.canonicalRoot');
    expect(readinessEvidenceBlock).not.toContain('readActiveSlotAuthority');
    expect(readinessEvidenceBlock).not.toContain('expectedActiveSlot');
    expect(readinessEvidenceBlock).not.toContain('observedSlot');
    expect(readinessEvidenceBlock).not.toContain('activeSlot:');
    expect(readinessEvidenceBlock).not.toContain('generationMatches');
    expect(runtimeTools).not.toContain("from '../../../cli/controller/runtime-slots'");
    expect(runtimeTools).not.toContain("from '../../supervisor/");
    expect(runtimeTools).not.toContain('buildControllerReadyRevisionView');
    expect(runtimeTools).not.toContain('stableSupervisorRevision');
    expect(runtimeTools).not.toContain('activeRuntimeRevision');
    expect(runtimeTools).not.toContain('stableIngress: fullPayload.stableIngress');
    expect(runtimeTools).not.toContain('activeSlot: identity.activeSlot');
    expect(runtimeTools).not.toContain('generation: identity.generation');
    expect(runtimeTools).not.toContain("from '../../../cli/controller/stable-state/stable-home'");
    expect(existsSync(join(ROOT, 'src/runtime/supervisor'))).toBe(false);
    for (const legacyPath of [
      'src/runtime/supervisor/entry.ts',
      'src/runtime/supervisor/supervisor-runtime.ts',
      'src/runtime/supervisor/ingress-router.ts',
      'src/runtime/supervisor/ingress-session-store.ts',
      'src/runtime/supervisor/installer.ts',
      'src/runtime/supervisor/operation-store.ts',
      'src/runtime/supervisor/state-store.ts',
    ]) expect(existsSync(join(ROOT, legacyPath))).toBe(false);
    expect(existsSync(join(ROOT, 'src/cli/controller/bluegreen-rollout.ts'))).toBe(false);
    expect(compositeOperations).not.toContain("from './bluegreen-rollout'");
    expect(compositeOperations).not.toContain('controllerRollout');
    expect(compositeOperations).not.toContain('controllerFeatureVerify');
    expect(compositeOperations).not.toContain('controller-bluegreen-isolated.test.ts');
    expect(compositeOperations).not.toContain('allowGreenRollout');
    expect(compositeOperations).not.toContain('controllerRestartVerify');
    expect(compositeOperations).not.toContain('ControllerRestartVerifyInput');
    expect(compositeOperations).not.toContain('runtime-slots');
    expect(compositeOperations).not.toContain('readControllerRestartState');
    expect(compositeOperations).not.toContain('requestControllerServiceRestart');
    expect(compositeOperations).not.toContain('runtimeGeneration');
    expect(controllerPostcondition).not.toContain('validateRestartSuccess');
    expect(controllerPostcondition).not.toContain('ControllerRestartState');
    expect(controllerPostcondition).not.toContain('ControllerServiceStatus');
    expect(controllerPostcondition).not.toContain('runtimeGeneration');
    expect(controllerPostcondition).not.toContain('isProcessAlive');
    expect(localBridgeServer).not.toContain('scheduleControllerServiceRestart');
    expect(localBridgeServer).not.toContain('RUNTIME_LIFECYCLE_ACTION_RETIRED');
    expect(localBridgeServer).not.toContain('detached coordinator owns the full stack restart');
    expect(repoActor).not.toContain('restart-coordinator');
    expect(repoActor).not.toContain('controller_restart_verify');
    expect(repoActor).not.toContain('shouldDeferControllerRestartRetry');
    expect(repoActor).not.toContain('restartStateReader');
    expect(existsSync(join(ROOT, 'src/runtime/execution/jobs/restart-resume.ts'))).toBe(false);
    expect(executionWorker).not.toContain('runtimeToolArgumentsForExecutionJob');
    expect(executionWorker).not.toContain('jobs/restart-resume');
    expect(executionWorker).toContain('const toolArguments = { ...(job.payload.arguments ?? {}) }');
    expect(executionWorker).not.toContain('controller_restart_verify');
    expect(processRuntime).toContain("from '../../shared/process-identity'");
    expect(daemonClient).toContain('observeRuntimeStatus(home)');
    expect(daemonClient).not.toContain('ensureControllerDaemon');
    expect(daemonClient).not.toContain("from 'child_process'");
    expect(daemonClient).not.toContain('daemon-entry.ts');
    expect(daemonClient).not.toContain('isStableSupervisorInstalled');
    expect(existsSync(join(ROOT, 'src/runtime/control-plane/daemon-entry.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'scripts/smoke-runtime-control-plane.ts'))).toBe(false);
    expect(processRuntime).not.toContain("from '../../supervisor/identity'");
    expect(releaseStore).toContain('publishRuntimeRelease');
    expect(releaseStore).toContain('rollbackRuntimeRelease');
    expect(releaseStore).toContain('backupControlPlaneDatabase');
    expect(releaseStore).toContain('restoreControlPlaneDatabase');
    expect(releaseStore).toContain('never part of a release artifact');
    expect(releaseStore).toContain("'runtime', 'releases', 'backups'");
    expect(releaseStore).not.toContain('slot');
    expect(releaseStore).not.toContain('ingress');
    expect(releaseStore).not.toContain('component');
    expect(writeFence).toContain('readRuntimeOwner');
    expect(writeFence).toContain('readRuntimeReleaseAuthority');
    expect(writeFence).toContain('runtime_instance_fenced');
    expect(writeFence).toContain('release_authority_revision_fenced');
    expect(writeFence).not.toContain('activeSlot');
    expect(writeFence).not.toContain('writer-authority.json');
    expect(writeFence).not.toContain('runtime-slots');
    expect(processGc).toContain("from '../../root/write-fence'");
    expect(processGc).not.toContain('runtime-writer-context');
    expect(processGc).not.toContain('assertThisRuntimeMayWrite');
    expect(workerOwnership).toContain('from "../../root/write-fence"');
    expect(workerOwnership).toContain("assertRuntimeMayWrite('renew_lease'");
    expect(workerOwnership).not.toContain('readForgeRuntimeStatus');
    expect(workerOwnership).not.toContain('runtime-status-client');
    expect(workerOwnership).not.toContain('CONTROLLER_EPOCH_STALE');
    expect(workerOwnership).not.toContain('controllerStartedAt');
    expect(workerEntry).not.toContain('--controller-started-at');
    expect(workerEntry).not.toContain('controllerStartedAt');
    expect(globalScheduler).not.toContain('--controller-started-at');
    expect(globalScheduler).not.toContain('controllerStartedAt');
    expect(globalScheduler).not.toContain('ownerStartedAt');
    expect(globalScheduler).not.toContain('ownerEpoch');
    for (const projectionSource of [projectionInvalidation, materializedView, controllerContextProjection]) {
      expect(projectionSource).not.toContain('controllerStartedAt');
      expect(projectionSource).not.toContain('ownerEpoch');
    }
    expect(projectionInvalidation).toContain('runtimeInstanceId?: string');
    expect(materializedView).toContain('currentOwner.runtimeInstanceId !== owner.runtimeInstanceId');
    expect(operationReceiptStore).toContain('runtimeInstanceId?: string');
    expect(operationReceiptStore).toContain('releaseAuthorityRevision?: number');
    expect(operationReceiptStore).toContain('artifactIdentity?: string');
    expect(operationReceiptStore).toContain('workerProtocolVersion?: number');
    expect(operationReceiptStore).toContain("assertRuntimeMayWriteOrThrow('write_operation_receipt'");
    expect(operationReceiptStore).not.toContain('ownerEpoch');
    expect(operationReceiptStore).not.toContain('releaseFencingToken');
    expect(localBridgeSurface).not.toContain("from '../../cli/controller/runtime-slots'");
    expect(localBridgeSurface).not.toContain('readActiveSlotAuthority');
    expect(localBridgeSurface).not.toContain('runtimeSlotForHome');
    expect(localBridgeSurface).not.toContain('slotHomePath');
    expect(localBridgeSurface).not.toContain('activeSlot?:');
    expect(localBridgeSurface).toContain('return controllerHome ? [controllerHome] : []');
    expect(localBridgeFacade).toContain("observeRuntimeStatus(ctx.controllerHome)");
    expect(localBridgeFacade).not.toContain("from '../controller/lifecycle'");
    expect(localBridgeFacade).not.toContain('buildRuntimeOperationalView');
    expect(standaloneRecovery).not.toContain('runtime-slots');
    expect(standaloneRecovery).not.toContain('stableIngressUrl');
    expect(standaloneRecovery).not.toContain('supervisorStatus');
    expect(standaloneRecovery).not.toContain('SupervisorState');
    expect(standaloneRecovery).not.toContain('operation_submit');
    expect(standaloneRecovery).not.toContain('operation_get');
    expect(standaloneRecovery).not.toContain('control.sock');
    expect(standaloneRecovery).not.toContain('runtimeBinding');
    expect(standaloneRecovery).not.toContain('writer-authority.json');
    expect(standaloneRecovery).toContain('observeRuntimeStatus(config.controllerHome)');
    expect(standaloneRecovery).toContain('readRuntimeReleaseAuthority');
    expect(standaloneRecovery).toContain('rollbackRuntimeRelease');
    expect(standaloneRecovery).toContain('export async function listReleases');
    expect(standaloneRecovery).not.toContain('export async function listSlots');
    const recoveryEntry = readFileSync(join(ROOT, 'src/runtime/standalone-recovery/entry.ts'), 'utf8');
    expect(recoveryEntry).toContain("'list-releases'");
    expect(recoveryEntry).toContain("name: 'list_releases'");
    expect(recoveryEntry).toContain("name: 'runtime_status'");
    expect(recoveryEntry).not.toContain("name: 'supervisor_status'");
    expect(recoveryEntry).not.toContain("'list-slots'");
    expect(recoveryEntry).not.toContain("name: 'list_slots'");
    expect(recoveryEntry).not.toContain("'restart-gateway'");
    expect(recoveryEntry).not.toContain("'restart-supervisor'");
    expect(recoveryEntry).not.toContain("name: 'restart_gateway'");
    expect(recoveryEntry).not.toContain("name: 'restart_stable_supervisor'");
    expect(standaloneRecovery).not.toContain("action: 'restart_gateway'");
    expect(standaloneRecovery).not.toContain("action: 'restart_supervisor'");
    expect(standaloneRecovery).not.toContain('gatewayRestartUsed');
    expect(standaloneRecovery).not.toContain('supervisorRestartUsed');
    expect(standaloneRecovery).not.toContain('export async function restartGateway');
    expect(standaloneRecovery).not.toContain('export async function restartSupervisor');
    expect(standaloneRecovery).not.toContain('RestartSupervisorReceipt');
    expect(standaloneRecovery).not.toContain('supervisorActivationPath');
    expect(existsSync(join(ROOT, 'src/cli/controller/restart-coordinator.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'src/cli/controller/restart-coordinator-entry.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'scripts/controller-runtime.sh'))).toBe(false);
    expect(existsSync(join(ROOT, 'scripts/activate-source-baseline.command'))).toBe(false);
    expect(existsSync(join(ROOT, 'scripts/restart-forge.sh'))).toBe(false);
    expect(runtimeTools).not.toContain('activeSlotRevision');
    expect(runtimeTools).not.toContain('generationCoherent');
    expect(runtimeTools).not.toContain('slotCoherent');
    expect(existsSync(join(ROOT, 'tests/runtime/stable-supervisor-hardening.test.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'tests/runtime/stable-supervisor-integration.test.ts'))).toBe(false);
    expect(runtimeTools).toContain('readForgeRuntimeStatus');
    for (const legacy of [
      'controller_restart_verify',
      'controller_feature_verify',
      'controller_rollout',
      'controller_rollback',
      'runRuntimeSupervisorFacade',
      'runtime_restart_controller',
      'runtime_restart_gateway',
      'runtime_restart_full',
      'runtime_rollout',
      'runtime_rollback',
      'runtime_unlock_and_recover',
      'scheduleControllerServiceRestart',
    ]) {
      expect(runtimeTools).not.toContain(legacy);
      expect(facadeActions).not.toContain(legacy);
      expect(toolsetNames).not.toContain(`'${legacy}'`);
    }
    expect(capabilityRegistry).not.toContain('controller.stable_supervisor');

    for (const legacy of ['keepalive', 'restart']) {
      const result = spawnSync('bun', [CLI, 'mcp', legacy], { cwd: ROOT, encoding: 'utf-8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('unknown command');
    }
  }, 15_000);

  test('requires an explicit Controller Home for Runtime status', () => {
    const result = spawnSync('bun', [CLI, 'runtime', 'status', '--json'], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("required option '--controller-home <path>' not specified");
  });
});
