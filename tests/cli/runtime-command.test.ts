import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildMcpCommand } from '../../src/cli/commands/mcp';
import { resolveRuntimeOutboundProxyPolicyFromCli } from '../../src/cli/commands/runtime';

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

  test('controller-global Runtime and Recovery status work from a non-Git directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-controller-status-non-git-'));
    const fakeBin = join(root, 'bin');
    const controllerHome = join(root, 'controller-home');
    const gitCalls = join(root, 'git-calls.log');
    try {
      mkdirSync(fakeBin, { recursive: true });
      const fakeGit = join(fakeBin, 'git');
      writeFileSync(fakeGit, '#!/bin/sh\nprintf "called\\n" >> "$FORGE_TEST_GIT_MARKER"\nexit 1\n');
      chmodSync(fakeGit, 0o700);
      const env = {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        FORGE_TEST_GIT_MARKER: gitCalls,
      };

      const runtime = spawnSync(
        process.execPath,
        [CLI, 'runtime', 'status', '--controller-home', controllerHome, '--json'],
        {
          cwd: root,
          encoding: 'utf-8',
          env,
        },
      );
      expect(runtime.status).toBe(0);
      expect(JSON.parse(runtime.stdout)).toMatchObject({ runtime: { running: false }, repositories: [] });

      const recovery = spawnSync(process.execPath, [CLI, 'recovery', 'status', '--controller-home', controllerHome], {
        cwd: root,
        encoding: 'utf-8',
        env,
      });
      expect(recovery.status).toBe(0);
      expect(JSON.parse(recovery.stdout)).toMatchObject({
        connector: { name: 'Forge Recovery' },
        runtime: expect.any(Object),
      });
      expect(existsSync(gitCalls)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runtime service install is the single documented launchd owner surface', () => {
    const service = spawnSync('bun', [CLI, 'runtime', 'service', '--help'], { cwd: ROOT, encoding: 'utf-8' });
    expect(service.status).toBe(0);
    expect(service.stdout).toContain('install');
    expect(service.stdout).not.toMatch(/^\s+start\b/m);
    expect(service.stdout).not.toMatch(/^\s+stop\b/m);
    expect(service.stdout).not.toMatch(/^\s+restart\b/m);
    expect(service.stdout).not.toMatch(/^\s+keepalive\b/m);

    const install = spawnSync('bun', [CLI, 'runtime', 'service', 'install', '--help'], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    expect(install.status).toBe(0);
    expect(install.stdout).toContain('--controller-home');
    expect(install.stdout).toContain('--repo');
    expect(install.stdout).toContain('--port');

    const installPackage = spawnSync('bun', [CLI, 'runtime', 'service', 'install-package', '--help'], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    expect(installPackage.status).toBe(0);
    expect(installPackage.stdout).toContain('--proxy-mode');
    expect(installPackage.stdout).toContain('--http-proxy');
    expect(installPackage.stdout).toContain('--https-proxy');
    expect(installPackage.stdout).toContain('--proxy-bypass');
    expect(install.stdout).not.toMatch(/^\s+keepalive\b/m);
  });

  test('packaged Runtime installer requires an explicit proxy mode and validates WSL proxy configuration', () => {
    expect(
      resolveRuntimeOutboundProxyPolicyFromCli({
        proxyMode: 'explicit',
        httpProxy: 'http://127.0.0.1:7890',
        httpsProxy: 'http://127.0.0.1:7890',
        proxyBypass: 'internal.local',
      }),
    ).toEqual({
      mode: 'explicit',
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
      noProxy: 'internal.local,localhost,127.0.0.1,::1',
    });
    expect(() =>
      resolveRuntimeOutboundProxyPolicyFromCli({
        httpProxy: 'http://127.0.0.1:7890',
      }),
    ).toThrow('RUNTIME_OUTBOUND_PROXY_MODE_REQUIRED');
    expect(() =>
      resolveRuntimeOutboundProxyPolicyFromCli({
        proxyMode: 'explicit',
      }),
    ).toThrow('FORGE_RUNTIME_OUTBOUND_PROXY_ENDPOINT_REQUIRED');
    expect(() =>
      resolveRuntimeOutboundProxyPolicyFromCli({
        proxyMode: 'explicit',
        httpsProxy: 'http://user:password@127.0.0.1:7890',
      }),
    ).toThrow('FORGE_OUTBOUND_PROXY_URL_INVALID');
    expect(resolveRuntimeOutboundProxyPolicyFromCli({ proxyMode: 'direct' })).toEqual({ mode: 'direct' });
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
    expect(Object.values(scripts).join('\n')).not.toMatch(
      /controller-runtime\.sh|restart-forge\.sh|rollout-all-registered-repos\.sh/,
    );
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
    const mcpAuth = readFileSync(join(ROOT, 'adapters/mcp/auth.ts'), 'utf8');
    const httpTransport = readFileSync(join(ROOT, 'adapters/mcp/transports/http.ts'), 'utf8');
    const httpObservation = readFileSync(join(ROOT, 'adapters/mcp/transports/http-observation.ts'), 'utf8');
    const runtimeTools = readFileSync(join(ROOT, 'adapters/mcp/runtime-gateway/runtime-tools.ts'), 'utf8');
    const runtimeObservation = readFileSync(
      join(ROOT, 'adapters/mcp/runtime-gateway/runtime-observation-adapter.ts'),
      'utf8',
    );
    const runtimeReadinessObservation = readFileSync(
      join(ROOT, 'adapters/mcp/runtime-gateway/runtime-readiness-observation.ts'),
      'utf8',
    );
    const recoveryAdapter = readFileSync(join(ROOT, 'adapters/mcp/runtime-gateway/recovery-adapter.ts'), 'utf8');
    const statusInboxAdapter = readFileSync(join(ROOT, 'adapters/mcp/runtime-gateway/status-inbox-adapter.ts'), 'utf8');
    const workAdapter = readFileSync(join(ROOT, 'adapters/mcp/runtime-gateway/rh-project-adapter.ts'), 'utf8');
    const controllerAuthorityAdapter = readFileSync(
      join(ROOT, 'adapters/mcp/runtime-gateway/controller-authority-adapter.ts'),
      'utf8',
    );
    const runtimeGatewaySurface = [
      runtimeTools,
      runtimeObservation,
      runtimeReadinessObservation,
      recoveryAdapter,
      statusInboxAdapter,
      controllerAuthorityAdapter,
      workAdapter,
    ].join('\n');
    const toolsetNames = readFileSync(join(ROOT, 'adapters/mcp/toolset-names.ts'), 'utf8');
    const processGc = readFileSync(join(ROOT, 'src/runtime/execution/process-runtime/gc.ts'), 'utf8');
    const workerOwnership = readFileSync(join(ROOT, 'src/runtime/execution/workers/ownership.ts'), 'utf8');
    const workerEntry = readFileSync(join(ROOT, 'src/cli/execution/worker-entry.ts'), 'utf8');
    const projectionInvalidation = readFileSync(join(ROOT, 'src/runtime/projections/invalidation.ts'), 'utf8');
    const materializedView = readFileSync(join(ROOT, 'src/runtime/projections/materialized-view.ts'), 'utf8');
    const controllerContextProjection = readFileSync(
      join(ROOT, 'src/runtime/projections/controller-context.ts'),
      'utf8',
    );
    const compositeOperations = readFileSync(join(ROOT, 'src/cli/controller/composite-operations.ts'), 'utf8');
    const controllerPostcondition = readFileSync(join(ROOT, 'src/cli/controller/postcondition.ts'), 'utf8');
    const localBridgeServer = readFileSync(join(ROOT, 'src/cli/local-bridge/server.ts'), 'utf8');
    const bridgeConnectorFreshness = readFileSync(join(ROOT, 'src/cli/local-bridge/connector-freshness.ts'), 'utf8');
    const bridgeJobStore = readFileSync(join(ROOT, 'src/cli/local-bridge/job-store.ts'), 'utf8');
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
    const capabilityRegistry = readFileSync(
      join(ROOT, 'src/runtime/control-plane/facade/capability-registry.ts'),
      'utf8',
    );
    const sourceBaseline = readFileSync(join(ROOT, 'scripts/activate-source-baseline.ts'), 'utf8');
    expect(sourceBaseline).toContain("args: ['test', '--max-concurrency', '1', `./${path}`]");
    expect(sourceBaseline).toContain("'tests/cli/mcp-http.test.ts'");
    expect(sourceBaseline).not.toContain("'tests/cli/mcp-controller.test.ts'");
    expect(sourceBaseline).toContain('findRegisteredRepositoryByCheckoutRoot');
    expect(sourceBaseline).toContain('repositoryId(repoRoot, controllerHome)');
    expect(sourceBaseline).not.toContain('workId');
    expect(sourceBaseline).not.toContain('cleaning_terminal_work');
    expect(sourceBaseline).not.toContain('cleanupSafety');
    expect(sourceBaseline).not.toContain(".ai', 'harness', 'repository.json");
    expect(sourceBaseline).not.toContain("targetBranch: 'main'");
    expect(mcpCommand).toContain('bindInheritedRuntimeWriteClaimFromEnvironment');
    expect(mcpCommand).toContain("from '../../runtime/root/write-fence'");
    expect(mcpCommand).not.toContain('stable-state/runtime-writer-context');
    expect(lifecycleAuthority).toContain('forge-runtime');
    expect(lifecycleAuthority).not.toContain('controller start|stop|restart');
    expect(existsSync(join(ROOT, 'src/cli/controller/lifecycle.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'src/cli/commands/supervisor.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'src/cli/controller/stable-state/runtime-writer-context.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'scripts/complete-control-plane-cutover.ts'))).toBe(false);
    expect(mcpAuth).not.toContain('mcpServiceOAuthTokenStoreFallbackPaths');
    expect(mcpAuth).not.toContain('resolveMcpRuntimeAuthority');
    expect(mcpAuth).not.toContain('controllerHomeHasAuthoritativeMcpState');
    expect(bridgeConnectorFreshness).not.toContain('loadMcpLocalConfig');
    expect(bridgeJobStore).not.toContain('loadMcpLocalConfig');
    expect(bridgeConnectorFreshness).toContain('loadMcpServiceLocalConfig(controllerHome)');
    expect(bridgeJobStore).toContain('loadMcpServiceLocalConfig(controllerHome)');
    expect(httpTransport).not.toContain('mcpServiceOAuthTokenStoreFallbackPaths');
    const oauthStore = readFileSync(join(ROOT, 'adapters/mcp/oauth.ts'), 'utf8');
    expect(oauthStore).not.toContain('fallbackPaths');
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
    ])
      expect(existsSync(join(ROOT, legacyAuthorityPath))).toBe(false);
    expect(httpTransport).not.toContain('ensureControllerDaemon');
    expect(httpTransport).not.toContain('readForgeRuntimeStatus');
    expect(httpObservation).toContain('readForgeRuntimeStatus');
    const snapshotSource = readFileSync(join(ROOT, 'src/cli/local-bridge/server.ts'), 'utf8');
    const snapshotBlock = snapshotSource.slice(
      snapshotSource.indexOf('export function buildLocalControllerSnapshot'),
      snapshotSource.indexOf('type LocalControllerSnapshot ='),
    );
    expect(snapshotBlock.match(/buildRequirementBoard\(/g)?.length).toBe(1);
    expect(snapshotBlock).toContain('buildControllerTaskLedgerProjection(repoRoot, legacyBoard, requirementBoard)');
    expect(snapshotBlock).toContain('inspectProjectGovernance(repoRoot, requirementBoard)');
    expect(snapshotSource).toContain('listActiveExecutionJobs(controllerHome, repository.repoId)');
    expect(snapshotSource).toContain('listExecutionJobs(controllerHome, repository.repoId, 12)');
    expect(snapshotSource).not.toContain('listExecutionJobs(controllerHome, repository.repoId, 30)');
    expect(httpObservation).not.toContain('buildControllerTaskLedgerProjection');
    expect(runtimeReadinessObservation).not.toContain('buildControllerTaskLedgerProjection');
    expect(runtimeReadinessObservation).not.toContain('reconcileReadinessProjectionSource');
    expect(runtimeTools).not.toContain('ensureControllerDaemon');
    expect(runtimeTools).not.toContain('cli/mcp/keepalive');
    expect(runtimeObservation).not.toContain('cli/local-bridge/job-store');
    expect(runtimeObservation).toContain("includeRecentEvents: variant !== 'summary'");
    expect(runtimeObservation).toContain('const requestedSections = Array.isArray(args.sections)');
    expect(runtimeObservation).toContain('const selectedSections = requestedSections;');
    expect(runtimeObservation).toContain("if (selectedSections.includes('git'))");
    expect(runtimeObservation).toContain('contextIndex: {');
    expect(runtimeObservation).toContain(
      "status: selectedSections.includes('readiness') ? 'observed' : 'not_requested'",
    );
    expect(runtimeObservation).not.toContain("const liveGit = variant === 'summary'");
    expect(runtimeObservation).toContain(
      "'Working tree has changes; request repository_git_status for bounded detail.'",
    );
    const taskLedgerSource = readFileSync(join(ROOT, 'src/cli/controller/task-ledger.ts'), 'utf8');
    expect(taskLedgerSource).toContain('options.includeRecentEvents === false');
    expect(taskLedgerSource).toContain(
      'cutover.repoId ? { controllerHome: cutover.controllerHome, repoId: cutover.repoId } : undefined',
    );
    const readinessStart = runtimeObservation.indexOf("case 'controller_ready':");
    const readinessEnd = runtimeObservation.indexOf("case 'repository_runtime_snapshot':", readinessStart);
    const readinessBlock = runtimeObservation.slice(readinessStart, readinessEnd);
    expect(readinessStart).toBeGreaterThanOrEqual(0);
    expect(readinessEnd).toBeGreaterThan(readinessStart);
    expect(readinessBlock).toContain('const ready = readiness.ready && mcpReady;');
    expect(readinessBlock).toContain('reasonCodes: [...reasonCodes]');
    expect(readinessBlock).toContain('diagnostics: {');
    expect(readinessBlock).not.toContain('state:');
    const recoveryProbeStart = recoveryAdapter.indexOf("case 'capability_recovery_probe':");
    const recoveryProbeEnd = recoveryAdapter.indexOf("case 'capability_recovery_plan':", recoveryProbeStart);
    const recoveryProbeBlock = recoveryAdapter.slice(recoveryProbeStart, recoveryProbeEnd);
    expect(recoveryProbeBlock).toContain('ownsRuntimeLifecycle: false');
    expect(recoveryProbeBlock).not.toContain('recovery: snapshot');
    expect(recoveryProbeBlock).not.toContain('recommendedActions');
    const recoveryApplyStart = recoveryAdapter.indexOf("case 'capability_recovery_apply':");
    const recoveryApplyEnd = recoveryAdapter.indexOf("case 'runtime_storage_repair_preview':", recoveryApplyStart);
    const recoveryApplyBlock = recoveryAdapter.slice(recoveryApplyStart, recoveryApplyEnd);
    expect(recoveryApplyStart).toBeGreaterThanOrEqual(0);
    expect(recoveryApplyEnd).toBeGreaterThan(recoveryApplyStart);
    expect(recoveryApplyBlock).not.toContain('RUNTIME_LIFECYCLE_ACTION_RETIRED');
    expect(recoveryApplyBlock).not.toContain('recovery.restart_controller');
    expect(recoveryApplyBlock).not.toContain('recovery.restart_local_bridge');
    expect(recoveryApplyBlock).not.toContain('stableSupervisorFacadeMutation');
    expect(recoveryApplyBlock).not.toContain('scheduleControllerServiceRestart');
    expect(runtimeGatewaySurface).not.toContain("case 'self_healing_loop_plan':");
    expect(runtimeGatewaySurface).not.toContain("case 'self_healing_monitor_tick':");
    expect(runtimeGatewaySurface).not.toContain('AUTONOMOUS_RUNTIME_RECOVERY_RETIRED');
    const contextSummaryStart = runtimeObservation.indexOf('function compactControllerContextSummaryPayload');
    const contextSummaryEnd = runtimeObservation.indexOf(
      'export async function controllerReadiness(',
      contextSummaryStart,
    );
    const contextSummaryBlock = runtimeObservation.slice(contextSummaryStart, contextSummaryEnd);
    expect(contextSummaryBlock).toContain('ready: ready.ready === true');
    expect(contextSummaryBlock).toContain('reasonCodes:');
    expect(contextSummaryBlock).not.toContain('state: ready.state');
    expect(contextSummaryBlock).not.toContain('operationalView:');
    const contextHandlerStart = runtimeObservation.indexOf("case 'controller_context':");
    const contextHandlerEnd = runtimeObservation.indexOf("case 'controller_ready':", contextHandlerStart);
    const contextHandlerBlock = runtimeObservation.slice(contextHandlerStart, contextHandlerEnd);
    expect(contextHandlerBlock).toContain('requestedSections');
    expect(contextHandlerBlock).toContain("measureSection('git'");
    expect(contextHandlerBlock).toContain("measureSection('focusTaskLedger.source'");
    expect(contextHandlerBlock).toContain("measureSection('focus'");
    expect(contextHandlerBlock).toContain("measureSection('taskLedger'");
    expect(contextHandlerBlock).toContain("measureSectionAsync('readiness'");
    expect(contextHandlerBlock).toContain("measureSection('activeRuns'");
    expect(contextHandlerBlock).toContain("measureSection('localBridge'");
    expect(contextHandlerBlock).toContain("measureSection('history'");
    expect(contextHandlerBlock).toContain("measureSection('checks'");
    expect(contextHandlerBlock).toContain("measureSection('plugins'");
    expect(contextHandlerBlock).toContain("markPhase('serialization', serializationStartedAt)");
    expect(contextHandlerBlock.indexOf('if (usesSectionRead)')).toBeLessThan(
      contextHandlerBlock.indexOf('cachedGitIdentity('),
    );
    expect(contextHandlerBlock).toContain('CONTROLLER_CONTEXT_UNKNOWN_SECTION');
    expect(contextHandlerBlock).toContain(
      "status: selectedSections.includes('readiness') ? 'observed' : 'not_requested'",
    );
    expect(contextHandlerBlock).toMatch(/await controllerReadiness\(\s*ctx,\s*repository,\s*\{\},\s*\{/s);
    expect(contextHandlerBlock).toContain('taskLedger,');
    expect(contextHandlerBlock).toContain('projectionSnapshot: runtimeSnapshot');
    expect(contextHandlerBlock).toContain('runtimeStorageInspection: storageInspection');
    expect(contextHandlerBlock).not.toContain('buildControllerOperationalPlan');
    expect(contextHandlerBlock).not.toContain('build.operational_plan');
    expect(contextHandlerBlock).toContain("markPhase('build.task_board', taskBoardStartedAt)");
    expect(contextHandlerBlock).toContain("markPhase('build.task_ledger', taskLedgerStartedAt)");
    expect(contextHandlerBlock).not.toContain('await controllerReadinessEvidence(ctx, repository)');
    expect(runtimeReadinessObservation).not.toContain('buildRuntimeOperationalView');
    expect(runtimeReadinessObservation).not.toContain('listExecutionJobs');
    expect(runtimeReadinessObservation).not.toContain('listHandoffItems');
    expect(recoveryAdapter).toContain('buildRuntimeOperationalView');
    expect(recoveryAdapter).toContain('listExecutionJobs(ctx.controllerHome, repository.repoId, 30)');
    expect(contextHandlerBlock).not.toContain('operationalView: readiness.operationalView');
    expect(contextHandlerBlock).toContain('fallbackToLive: false');
    expect(contextHandlerBlock).toContain("markPhase('build.plugins', pluginsStartedAt)");
    expect(contextHandlerBlock).not.toContain("fallbackToLive: variant === 'detail'");
    const statusHandlerStart = statusInboxAdapter.indexOf("if (name === 'rh_status')");
    const statusHandlerEnd = statusInboxAdapter.indexOf("if (name === 'rh_inbox')", statusHandlerStart);
    const statusHandlerBlock = statusInboxAdapter.slice(statusHandlerStart, statusHandlerEnd);
    expect(statusHandlerBlock).toContain("markSummaryPhase('runtime')");
    expect(statusHandlerBlock).toContain('phaseTimingsMs: summaryPhaseTimingsMs');
    expect(statusHandlerBlock).toContain('fallbackToLive: false');
    expect(statusHandlerBlock).toContain("maintenanceObservation: 'not_requested'");
    expect(statusHandlerBlock).toContain('args.include_maintenance === true');
    expect(statusHandlerBlock).toContain('new Date(repositoryIdentity.sampledAt).toISOString()');
    expect(statusHandlerBlock).toContain("observationPolicy: 'bounded_sample_with_mutation_invalidation'");
    expect(contextHandlerBlock).toContain('sourceObservation: gitIdentityObservation');
    const runtimeIdentityStart = controllerAuthorityAdapter.indexOf('export function runtimeIdentitySnapshot');
    const runtimeIdentityEnd = controllerAuthorityAdapter.indexOf(
      'export function authenticatedFacadeControllerIdentity',
      runtimeIdentityStart,
    );
    const runtimeIdentityBlock = controllerAuthorityAdapter.slice(runtimeIdentityStart, runtimeIdentityEnd);
    expect(runtimeIdentityBlock).toContain('observeRuntimeStatus(ctx.controllerHome)');
    expect(runtimeIdentityBlock).toContain('runtimeInstanceId: snapshot?.runtimeInstanceId');
    expect(runtimeIdentityBlock).not.toContain('readSupervisorState');
    expect(runtimeIdentityBlock).not.toContain('readCurrentSupervisorRelease');
    expect(runtimeIdentityBlock).not.toContain('readActiveSlotAuthority');
    expect(runtimeIdentityBlock).not.toContain('previousSlot');
    expect(runtimeIdentityBlock).not.toContain('activeSlot:');
    const localBridgeStart = runtimeObservation.indexOf("case 'local_bridge_status':");
    const localBridgeEnd = runtimeObservation.indexOf("case 'controller_context':", localBridgeStart);
    const localBridgeBlock = runtimeObservation.slice(localBridgeStart, localBridgeEnd);
    expect(localBridgeBlock).toContain('ready: health.components.localBridge.ready');
    expect(localBridgeBlock).not.toContain('readActiveSlotAuthority');
    expect(localBridgeBlock).not.toContain('activeSlot');
    expect(localBridgeBlock).not.toContain('generationMatches');
    expect(localBridgeBlock).not.toContain('health: health.components.localBridge.state');
    expect(localBridgeBlock).not.toContain('state: health.state');
    const readinessEvidenceStart = runtimeReadinessObservation.indexOf(
      'export async function controllerReadinessEvidence',
    );
    const readinessEvidenceEnd = runtimeReadinessObservation.indexOf(
      'export function runtimeSourceSnapshotStatus',
      readinessEvidenceStart,
    );
    const readinessEvidenceBlock = runtimeReadinessObservation.slice(readinessEvidenceStart, readinessEvidenceEnd);
    expect(readinessEvidenceBlock).toContain('expectedSurface: localBridgeExpectedSurface');
    expect(readinessEvidenceBlock).toContain('generation: localBridgeSurface?.generation');
    expect(readinessEvidenceBlock).not.toContain('repoRoot: repository?.canonicalRoot');
    expect(readinessEvidenceBlock).not.toContain('readActiveSlotAuthority');
    expect(readinessEvidenceBlock).not.toContain('expectedActiveSlot');
    expect(readinessEvidenceBlock).not.toContain('observedSlot');
    expect(readinessEvidenceBlock).not.toContain('activeSlot:');
    expect(readinessEvidenceBlock).not.toContain('generationMatches');
    expect(runtimeGatewaySurface).not.toContain("from '../../../cli/controller/runtime-slots'");
    expect(runtimeGatewaySurface).not.toContain("from '../../supervisor/");
    expect(runtimeGatewaySurface).not.toContain('buildControllerReadyRevisionView');
    expect(runtimeGatewaySurface).not.toContain('stableSupervisorRevision');
    expect(runtimeGatewaySurface).not.toContain('activeRuntimeRevision');
    expect(runtimeGatewaySurface).not.toContain('stableIngress: fullPayload.stableIngress');
    expect(runtimeGatewaySurface).not.toContain('activeSlot: identity.activeSlot');
    expect(runtimeGatewaySurface).not.toContain('generation: identity.generation');
    expect(runtimeGatewaySurface).not.toContain("from '../../../cli/controller/stable-state/stable-home'");
    expect(existsSync(join(ROOT, 'src/runtime/supervisor'))).toBe(false);
    for (const legacyPath of [
      'src/runtime/supervisor/entry.ts',
      'src/runtime/supervisor/supervisor-runtime.ts',
      'src/runtime/supervisor/ingress-router.ts',
      'src/runtime/supervisor/ingress-session-store.ts',
      'src/runtime/supervisor/installer.ts',
      'src/runtime/supervisor/operation-store.ts',
      'src/runtime/supervisor/state-store.ts',
    ])
      expect(existsSync(join(ROOT, legacyPath))).toBe(false);
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
    for (const retiredCompletionRoute of [
      '/api/completion/backlog',
      '/api/completion/queues',
      '/api/completion/finish-ready-runs',
      '/api/completion/decision',
      '/api/completion/stuck',
      '/api/completion/stuck/migrate',
      '/api/controller/codex-continuation',
      '/api/runs/:runId/finish',
    ]) {
      expect(localBridgeServer).not.toContain(retiredCompletionRoute);
    }
    expect(localBridgeServer).not.toContain('completionBacklog');
    expect(localBridgeServer).not.toContain('completionQueues');
    expect(localBridgeServer).not.toContain('stuckStates');

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
    expect(localBridgeSurface).toContain('controllerHome: string;');
    expect(localBridgeSurface).toContain('loadMcpServiceRuntimeState(input.controllerHome)');
    expect(localBridgeSurface).toContain('loadMcpServiceLocalConfig(input.controllerHome)');
    expect(localBridgeSurface).not.toContain('loadMcpLocalConfig');
    expect(localBridgeSurface).not.toContain('loadMcpRuntimeState');
    expect(localBridgeSurface).not.toContain("'repo-runtime'");
    expect(localBridgeSurface).not.toContain("'repo-config'");
    const accessModeSource = readFileSync(join(ROOT, 'adapters/mcp/access-mode.ts'), 'utf8');
    expect(accessModeSource).not.toContain('repo_local_fallback');
    expect(accessModeSource).not.toContain('mcpLocalConfigPath');
    expect(localBridgeFacade).toContain('observeRuntimeStatus(ctx.controllerHome)');
    expect(localBridgeFacade).not.toContain("from '../controller/lifecycle'");
    expect(localBridgeFacade).not.toContain('buildRuntimeOperationalView');
    expect(localBridgeFacade).not.toContain('operationalView: undefined');
    expect(localBridgeFacade).not.toContain('const runtimeHealth = undefined');
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
    expect(runtimeGatewaySurface).not.toContain('activeSlotRevision');
    expect(runtimeGatewaySurface).not.toContain('generationCoherent');
    expect(runtimeGatewaySurface).not.toContain('slotCoherent');
    expect(existsSync(join(ROOT, 'tests/runtime/stable-supervisor-hardening.test.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'tests/runtime/stable-supervisor-integration.test.ts'))).toBe(false);
    expect(runtimeGatewaySurface).toContain('readForgeRuntimeStatus');
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
      expect(runtimeGatewaySurface).not.toContain(legacy);
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
