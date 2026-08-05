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
    const httpTransport = readFileSync(join(ROOT, 'src/cli/mcp/transports/http.ts'), 'utf8');
    const runtimeTools = readFileSync(join(ROOT, 'src/runtime/gateway/mcp/runtime-tools.ts'), 'utf8');
    const facadeActions = readFileSync(join(ROOT, 'src/runtime/control-plane/facade/suggested-actions.ts'), 'utf8');
    const capabilityRegistry = readFileSync(join(ROOT, 'src/runtime/control-plane/facade/capability-registry.ts'), 'utf8');
    expect(mcpCommand).toContain('bindInheritedRuntimeWriterClaimFromEnvironment');
    expect(lifecycleAuthority).toContain('repo-harness-runtime');
    expect(lifecycleAuthority).not.toContain('controller start|stop|restart');
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
