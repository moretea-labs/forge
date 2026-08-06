import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

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
    expect(result.stdout).not.toMatch(/^\s+start\b/m);
    expect(result.stdout).not.toMatch(/^\s+stop\b/m);
    expect(result.stdout).not.toMatch(/^\s+restart\b/m);
    expect(result.stdout).not.toMatch(/^\s+doctor\b/m);
  });

  test('root and controller command surfaces expose no legacy lifecycle or component rollout owner', () => {
    const root = spawnSync('bun', [CLI, '--help'], { cwd: ROOT, encoding: 'utf-8' });
    expect(root.status).toBe(0);
    expect(root.stdout).toContain('controller');
    expect(root.stdout).toContain('runtime');
    expect(root.stdout).not.toMatch(/^\s+supervisor\b/m);
    const rootSource = readFileSync(join(ROOT, 'src/cli/index.ts'), 'utf8');
    expect(rootSource).not.toContain("'supervisor'");
    expect(rootSource).not.toContain('bindInheritedRuntimeWriterClaimFromEnvironment');

    const controller = spawnSync('bun', [CLI, 'controller', '--help'], { cwd: ROOT, encoding: 'utf-8' });
    expect(controller.status).toBe(0);
    expect(controller.stdout).toContain('board');
    expect(controller.stdout).toContain('runs');
    expect(controller.stdout).toContain('change-verify');
    for (const legacy of ['start', 'stop', 'status', 'restart', 'logs', 'rollout', 'rollback', 'restart-verify', 'feature-verify']) {
      expect(controller.stdout).not.toMatch(new RegExp(`^\\s+${legacy}\\b`, 'm'));
    }
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
    expect(Object.values(scripts).join('\n')).not.toMatch(/controller-runtime\.sh|restart-repo-harness\.sh|rollout-all-registered-repos\.sh/);
    expect(pkg.bin?.['repo-harness-runtime']).toBe('bin/repo-harness-runtime.mjs');
  });

  test('MCP command surface exposes no KeepAlive or restart lifecycle owner', () => {
    const help = spawnSync('bun', [CLI, 'mcp', '--help'], { cwd: ROOT, encoding: 'utf-8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('serve');
    expect(help.stdout).toContain('doctor');
    expect(help.stdout).toContain('setup');
    expect(help.stdout).not.toMatch(/^\s+keepalive\b/m);
    expect(help.stdout).not.toMatch(/^\s+restart\b/m);
    expect(existsSync(join(ROOT, 'src/cli/mcp/keepalive.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'src/cli/mcp/restart.ts'))).toBe(false);
    const mcpCommand = readFileSync(join(ROOT, 'src/cli/commands/mcp.ts'), 'utf8');
    const lifecycleAuthority = readFileSync(join(ROOT, 'src/cli/controller/lifecycle-authority.ts'), 'utf8');
    const controllerLifecycle = readFileSync(join(ROOT, 'src/cli/controller/lifecycle.ts'), 'utf8');
    const httpTransport = readFileSync(join(ROOT, 'src/cli/mcp/transports/http.ts'), 'utf8');
    const runtimeTools = readFileSync(join(ROOT, 'src/runtime/gateway/mcp/runtime-tools.ts'), 'utf8');
    const toolsetNames = readFileSync(join(ROOT, 'src/cli/mcp/toolset-names.ts'), 'utf8');
    const supervisorRuntime = readFileSync(join(ROOT, 'src/runtime/supervisor/supervisor-runtime.ts'), 'utf8');
    const supervisorProcessManager = readFileSync(join(ROOT, 'src/runtime/supervisor/process-manager.ts'), 'utf8');
    const supervisorIngressRouter = readFileSync(join(ROOT, 'src/runtime/supervisor/ingress-router.ts'), 'utf8');
    const supervisorEntry = readFileSync(join(ROOT, 'src/runtime/supervisor/entry.ts'), 'utf8');
    const supervisorActivation = readFileSync(join(ROOT, 'src/runtime/supervisor/activation-state-machine.ts'), 'utf8');
    const supervisorControl = readFileSync(join(ROOT, 'src/runtime/supervisor/control-server.ts'), 'utf8');
    const supervisorCommand = readFileSync(join(ROOT, 'src/cli/commands/supervisor.ts'), 'utf8');
    const supervisorSourceIdentity = readFileSync(join(ROOT, 'src/runtime/supervisor/source-identity.ts'), 'utf8');
    const supervisorReleaseCoherence = readFileSync(join(ROOT, 'src/runtime/supervisor/release-coherence.ts'), 'utf8');
    const restartCoordinatorEntry = readFileSync(join(ROOT, 'src/cli/controller/restart-coordinator-entry.ts'), 'utf8');
    const compositeOperations = readFileSync(join(ROOT, 'src/cli/controller/composite-operations.ts'), 'utf8');
    const controllerPostcondition = readFileSync(join(ROOT, 'src/cli/controller/postcondition.ts'), 'utf8');
    const localBridgeServer = readFileSync(join(ROOT, 'src/cli/local-bridge/server.ts'), 'utf8');
    const repoActor = readFileSync(join(ROOT, 'src/runtime/control-plane/repo-actor/actor.ts'), 'utf8');
    const executionWorker = readFileSync(join(ROOT, 'src/runtime/execution/workers/executor.ts'), 'utf8');
    const supervisorTypes = readFileSync(join(ROOT, 'src/runtime/supervisor/types.ts'), 'utf8');
    const supervisorStateStore = readFileSync(join(ROOT, 'src/runtime/supervisor/state-store.ts'), 'utf8');
    const facadeActions = readFileSync(join(ROOT, 'src/runtime/control-plane/facade/suggested-actions.ts'), 'utf8');
    const capabilityRegistry = readFileSync(join(ROOT, 'src/runtime/control-plane/facade/capability-registry.ts'), 'utf8');
    expect(mcpCommand).toContain('bindInheritedRuntimeWriterClaimFromEnvironment');
    expect(lifecycleAuthority).toContain('repo-harness-runtime');
    expect(lifecycleAuthority).not.toContain('controller start|stop|restart');
    expect(controllerLifecycle).not.toContain("from './runtime-slots'");
    expect(controllerLifecycle).not.toContain('readActiveSlotAuthority');
    expect(controllerLifecycle).not.toContain('ensureSlotHome');
    expect(controllerLifecycle).not.toContain('slotLocalConfig');
    expect(controllerLifecycle).not.toContain('slotRuntime');
    expect(controllerLifecycle).toContain('observedEndpointBinding(runtime?.server.endpoint)');
    expect(controllerLifecycle).toContain('observedEndpointBinding(runtime?.localController?.endpoint)');
    expect(httpTransport).not.toContain('ensureControllerDaemon');
    expect(httpTransport).toContain('readControllerDaemonStatus');
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
    expect(recoveryApplyBlock).toContain('RUNTIME_LIFECYCLE_ACTION_RETIRED');
    expect(recoveryApplyBlock).not.toContain('stableSupervisorFacadeMutation');
    expect(recoveryApplyBlock).not.toContain('scheduleControllerServiceRestart');
    const selfHealingStart = runtimeTools.indexOf("case 'self_healing_loop_plan':");
    const selfHealingEnd = runtimeTools.indexOf("case 'goal_create':", selfHealingStart);
    const selfHealingBlock = runtimeTools.slice(selfHealingStart, selfHealingEnd);
    expect(selfHealingBlock).toContain('AUTONOMOUS_RUNTIME_RECOVERY_RETIRED');
    expect(selfHealingBlock).not.toContain('buildSelfHealingLoopPlan');
    expect(selfHealingBlock).not.toContain('buildSelfHealingMonitorReport');
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
    expect(readinessEvidenceBlock).not.toContain('readActiveSlotAuthority');
    expect(readinessEvidenceBlock).not.toContain('expectedActiveSlot');
    expect(readinessEvidenceBlock).not.toContain('observedSlot');
    expect(readinessEvidenceBlock).not.toContain('activeSlot:');
    expect(readinessEvidenceBlock).not.toContain('generationMatches');
    expect(runtimeTools).not.toContain("from '../../../cli/controller/runtime-slots'");
    expect(runtimeTools).not.toContain("from '../../../cli/controller/stable-state/stable-home'");
    const supervisorMonitorStart = supervisorRuntime.indexOf('private async monitorTick()');
    const supervisorMonitorEnd = supervisorRuntime.indexOf('private scheduleMonitorTick()', supervisorMonitorStart);
    const supervisorMonitorBlock = supervisorRuntime.slice(supervisorMonitorStart, supervisorMonitorEnd);
    expect(existsSync(join(ROOT, 'src/runtime/supervisor/ingress-process.ts'))).toBe(false);
    expect(supervisorEntry).not.toContain('--ingress-child');
    expect(supervisorEntry).not.toContain('REPO_HARNESS_SUPERVISOR_INGRESS_CHILD');
    expect(supervisorEntry).not.toContain('createStableIngressProcess');
    expect(supervisorActivation).toContain("| 'waiting_runtime_ready'");
    expect(supervisorActivation).not.toContain("| 'waiting_stable_endpoint'");
    expect(supervisorActivation).toContain("value === 'waiting_stable_endpoint'");
    expect(supervisorCommand).toContain("transitionPhase(home, activationId, 'waiting_runtime_ready')");
    expect(supervisorCommand).not.toContain("transitionPhase(home, activationId, 'waiting_stable_endpoint')");
    expect(supervisorCommand).not.toContain('Verify the full readiness chain: ingress');
    expect(supervisorCommand).toContain("from '../../runtime/supervisor/source-identity'");
    expect(supervisorCommand).not.toContain("from '../controller/bluegreen-rollout'");
    expect(supervisorSourceIdentity).toContain('export function sourceIdentityFor');
    expect(supervisorSourceIdentity).not.toContain('runtime-slots');
    expect(supervisorSourceIdentity).not.toContain('sendSupervisorCommand');
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
    expect(localBridgeServer).toContain('RUNTIME_LIFECYCLE_ACTION_RETIRED');
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
    expect(supervisorReleaseCoherence).toContain('ok: releaseCoherent');
    expect(supervisorReleaseCoherence).not.toContain('ActiveSlotAuthority');
    expect(supervisorReleaseCoherence).not.toContain('SlotIdentity');
    expect(supervisorReleaseCoherence).not.toContain('generationCoherent');
    expect(supervisorReleaseCoherence).not.toContain('slotCoherent');
    expect(supervisorReleaseCoherence).not.toContain('input.authority');
    expect(supervisorReleaseCoherence).not.toContain('input.slotIdentity');
    expect(existsSync(join(ROOT, 'src/cli/controller/restart-coordinator.ts'))).toBe(false);
    expect(restartCoordinatorEntry).toContain('RUNTIME_LIFECYCLE_ACTION_RETIRED');
    expect(restartCoordinatorEntry).toContain('process.exitCode = 2');
    expect(restartCoordinatorEntry).not.toContain("from './restart-coordinator'");
    expect(restartCoordinatorEntry).not.toContain("from './lifecycle'");
    expect(restartCoordinatorEntry).not.toContain('spawn');
    expect(runtimeTools).not.toContain('activeSlotRevision');
    expect(runtimeTools).not.toContain('generationCoherent');
    expect(runtimeTools).not.toContain('slotCoherent');
    expect(supervisorControl).toContain('DEFAULT_SUPERVISOR_CONTROL_PORT = 8770');
    expect(supervisorEntry).toContain("numberOption('--control-port', DEFAULT_SUPERVISOR_CONTROL_PORT)");
    expect(supervisorCommand).toContain('port: DEFAULT_SUPERVISOR_CONTROL_PORT');
    expect(supervisorCommand).not.toContain('port: 8765');
    expect(supervisorIngressRouter).toContain('DEFAULT_COMPATIBILITY_ROUTER_PORT = 8765');
    expect(supervisorRuntime).toContain('port: DEFAULT_COMPATIBILITY_ROUTER_PORT');
    expect(supervisorRuntime).not.toContain('this.options.stableIngressPort');
    expect(supervisorRuntime).not.toContain('this.options.stableIngressHost');
    const gatewayBindingStart = supervisorProcessManager.indexOf('gatewayBinding(');
    const gatewayBindingEnd = supervisorProcessManager.indexOf('localControllerBinding(', gatewayBindingStart);
    const gatewayBindingBlock = supervisorProcessManager.slice(gatewayBindingStart, gatewayBindingEnd);
    expect(gatewayBindingBlock).toContain('DEFAULT_SUPERVISOR_GATEWAY_BASE_PORT');
    expect(gatewayBindingBlock).not.toContain('stableIngressPort');
    expect(gatewayBindingBlock).not.toContain('gatewayPortOffset');
    expect(supervisorRuntime).toContain('startCompatibilityIngressRouter');
    expect(supervisorRuntime).not.toContain('replaceIngressRouter');
    expect(supervisorMonitorBlock).not.toContain('createStableIngressRouter');
    expect(supervisorRuntime).not.toContain('supervisorIngressHealthDecision');
    expect(supervisorRuntime).not.toContain('SUPERVISOR_INGRESS_HEALTH_FAILURE_THRESHOLD');
    expect(supervisorMonitorBlock).not.toContain('inline stable ingress router recovery');
    expect(supervisorMonitorBlock).not.toContain('router replacement');
    expect(supervisorMonitorBlock).not.toContain('requestSupervisorSelfRestart');
    expect(supervisorMonitorBlock).toContain('Public endpoint observations are diagnostics only');
    expect(supervisorRuntime).toContain('verifyAuthoritySelectedGateway');
    expect(supervisorRuntime).toContain('SUPERVISOR_ACTIVE_GATEWAY_VERIFY_FAILED');
    expect(supervisorRuntime).not.toContain('verifyStableIngress');
    expect(supervisorRuntime).not.toContain('SUPERVISOR_STABLE_INGRESS_VERIFY_FAILED');
    const cutoverVerificationStart = supervisorRuntime.indexOf('private async verifyAuthoritySelectedGateway');
    const cutoverVerificationEnd = supervisorRuntime.indexOf('private async observeActivatedSlot', cutoverVerificationStart);
    const cutoverVerificationBlock = supervisorRuntime.slice(cutoverVerificationStart, cutoverVerificationEnd);
    expect(cutoverVerificationBlock).toContain("gatewayBinding(input.slot)");
    expect(cutoverVerificationBlock).toContain("/ready");
    expect(cutoverVerificationBlock).not.toContain('stableIngressHost');
    expect(cutoverVerificationBlock).not.toContain('stableIngressPort');
    const legacyIngressSlotAssignments = [...supervisorRuntime.matchAll(/activeUpstreamSlot:\s*([^,\n]+)/g)]
      .map((match) => match[1].trim());
    const legacyIngressPortAssignments = [...supervisorRuntime.matchAll(/activeUpstreamPort:\s*([^,\n]+)/g)]
      .map((match) => match[1].trim());
    expect(legacyIngressSlotAssignments).toEqual([]);
    expect(legacyIngressPortAssignments).toEqual([]);
    expect(supervisorRuntime).not.toContain('this.state.ingress.activeUpstreamSlot');
    expect(supervisorRuntime).not.toContain('this.state.ingress.activeUpstreamPort');
    expect(supervisorTypes).not.toContain('activeUpstreamSlot');
    expect(supervisorTypes).not.toContain('activeUpstreamPort');
    expect(supervisorTypes).not.toContain('  ingress: {');
    expect(supervisorRuntime).not.toContain('this.state.ingress');
    expect(supervisorStateStore).toContain('ingress: _legacyIngress');
    expect(supervisorStateStore).not.toContain('_legacyActiveUpstreamSlot');
    expect(supervisorStateStore).not.toContain('_legacyActiveUpstreamPort');
    expect(supervisorRuntime).toContain("phase: 'activating_runtime'");
    expect(supervisorRuntime).not.toContain("phase: 'switching_ingress'");
    expect(supervisorTypes).toContain("| 'activating_runtime'");
    expect(supervisorStateStore).not.toContain('switching_ingress');
    const supervisorOperationStore = readFileSync(join(ROOT, 'src/runtime/supervisor/operation-store.ts'), 'utf8');
    expect(supervisorOperationStore).toContain("value.phase === 'switching_ingress'");
    expect(supervisorOperationStore).toContain("phase: 'activating_runtime'");
    const supervisorHardeningTests = readFileSync(join(ROOT, 'tests/runtime/stable-supervisor-hardening.test.ts'), 'utf8');
    const stableStateTests = readFileSync(join(ROOT, 'tests/runtime/stable-state-and-bootstrap.test.ts'), 'utf8');
    expect(supervisorHardeningTests).not.toContain('replaceIngressRouter');
    expect(supervisorHardeningTests).toContain('Supervisor state reader strips legacy Ingress route and health telemetry');
    expect(supervisorHardeningTests).toContain("expect(migrated).not.toHaveProperty('ingress')");
    expect([...supervisorHardeningTests.matchAll(/activeUpstreamSlot/g)]).toHaveLength(1);
    expect([...supervisorHardeningTests.matchAll(/activeUpstreamPort/g)]).toHaveLength(1);
    expect([...supervisorHardeningTests.matchAll(/\n\s+ingress:\s*\{/g)]).toHaveLength(1);
    expect(stableStateTests).not.toContain('activeUpstreamSlot');
    expect(stableStateTests).not.toContain('activeUpstreamPort');
    expect(runtimeTools).toContain('readControllerDaemonStatus');
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
      const result = spawnSync('bun', [CLI, 'mcp', legacy, '--help'], { cwd: ROOT, encoding: 'utf-8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('unknown command');
    }
  });

  test('requires an explicit Controller Home for Runtime status', () => {
    const result = spawnSync('bun', [CLI, 'runtime', 'status', '--json'], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("required option '--controller-home <path>' not specified");
  });
});
