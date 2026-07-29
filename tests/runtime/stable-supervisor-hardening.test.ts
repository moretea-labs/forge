import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { bootstrapLaunchAgentWithRetry } from '../../src/cli/controller/launch-agents';
import { selectSupervisorRollbackRelease, serviceActivationStatePath, supervisorActivationMatchesRelease, waitForServiceActivation } from '../../src/cli/commands/supervisor';
import { installSupervisorRelease, publishSupervisorRelease, renderLaunchdSupervisorPlist, renderSystemdSupervisorUnit, stageSupervisorRelease, supervisorServiceLabel, supervisorSystemdUnitName } from '../../src/runtime/supervisor/installer';
import { stableSupervisorActivatesPublishedRelease, stableSupervisorExitCode } from '../../src/runtime/supervisor/entry';
import { createStableIngressRouter } from '../../src/runtime/supervisor/ingress-router';
import { createStableIngressProcess } from '../../src/runtime/supervisor/ingress-process';
import { controllerDaemonMaxLifetimeMs, controllerDaemonPassiveMode, publishReadyAfterStartupRecovery, resolveControllerDaemonShutdownReason } from '../../src/runtime/control-plane/daemon-entry';
import { createSupervisorOperation, readSupervisorOperation, updateSupervisorOperation } from '../../src/runtime/supervisor/operation-store';
import { StableSupervisorRuntime, SUPERVISOR_GATEWAY_HEALTH_FAILURE_THRESHOLD, SUPERVISOR_INGRESS_HEALTH_FAILURE_THRESHOLD, SUPERVISOR_MONITOR_FAILURE_THRESHOLD, automaticRecoveryRequestId, combinedRolloutRollbackFailure, managedProcessNeedsReleaseRefresh, observeCutoverCandidateWithSingleRecovery, observeCutoverReadinessWindow, sampleCutoverReadiness, probeAuthenticatedMcpReadiness, probeSupervisorGatewayHealth, reconcileActiveManagedGenerations, reconcilePendingSupervisorActivations, reconcileSupervisorStateWithAuthority, recoverableCutoverObservationFailure, recoverableWriterClaimRefreshFailure, refreshWriterClaimWithSingleRetry, resumableInterruptedRollout, supervisorGatewayHealthDecision, supervisorGatewayOperational, supervisorGatewayRuntimeReady, supervisorIngressHealthDecision, supervisorMonitorFailureDecision, supervisorOperationRecoverySuppressed, terminalizeInterruptedSupervisorOperations } from '../../src/runtime/supervisor/supervisor-runtime';
import { decideRestart, newRestartBudgetRecord, recordFailure, recordRestart, recordStable } from '../../src/runtime/supervisor/restart-policy';
import { SupervisorProcessManager, runtimeWriterEnvironment, supervisorProcessStopAuditPath } from '../../src/runtime/supervisor/process-manager';
import { ensureMcpControllerHomeBearerToken, writeMcpServiceLocalConfig } from '../../src/cli/mcp/auth';
import { writeActiveSlotAuthority } from '../../src/cli/controller/runtime-slots';
import { publishWriterAuthority } from '../../src/cli/controller/stable-state/writer-authority';
import { readCurrentRelease, readCurrentSupervisorRelease, supervisorReleasesRoot } from '../../src/runtime/supervisor/paths';
import { createSupervisorControlServer, sendSupervisorCommand } from '../../src/runtime/supervisor/control-server';
import type { ProcessIdentityProbe } from '../../src/runtime/supervisor/identity';
import type { SupervisorManagedProcess, SupervisorOperation, SupervisorState } from '../../src/runtime/supervisor/types';
import { evaluateRuntimeReleaseCoherence, evaluateSupervisorServiceReleaseCoherence, extractSupervisorServiceRelease } from '../../src/runtime/supervisor/release-coherence';
import { publishAndScheduleSupervisorRelease } from '../../src/runtime/supervisor/service-activation';
import { probeSupervisorMcpReadiness } from '../../src/runtime/supervisor/mcp-readiness';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server address unavailable');
  return { server, port: address.port };
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

function fakeSupervisorRelease(home: string, name: string, revision: string): string {
  const releasePath = join(supervisorReleasesRoot(home), name);
  mkdirSync(releasePath, { recursive: true });
  const executables = [
    'supervisor.js',
    'repo-harness.js',
    'daemon.js',
    'worker.js',
    'process-runner.js',
    'browser-handoff-host.js',
  ];
  const aggregate = createHash('sha256');
  const artifacts: Record<string, { sha256: string }> = {};
  for (const executable of executables) {
    writeFileSync(join(releasePath, executable), '');
    const sha256 = createHash('sha256').update('').digest('hex');
    artifacts[executable] = { sha256 };
    aggregate.update(executable);
    aggregate.update('\0');
    aggregate.update(sha256);
    aggregate.update('\0');
  }
  writeFileSync(join(releasePath, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 2,
    releaseRevision: revision,
    sourceCommit: '0123456789abcdef0123456789abcdef01234567',
    sourceRoot: process.cwd(),
    cleanWorkspace: true,
    artifactHash: aggregate.digest('hex'),
    artifacts,
  })}\n`);
  return releasePath;
}

function managedProcess(slot: 'blue' | 'green', pid: number, generation: string): SupervisorManagedProcess {
  return {
    pid,
    instanceId: `process-${pid}`,
    processStartTime: `start-${pid}`,
    executableFingerprint: `fingerprint-${pid}`,
    controllerHome: `/tmp/${slot}`,
    slot,
    generation,
    ownerEpoch: 1,
    state: 'running',
    restartCount: 0,
    consecutiveFailures: 0,
  };
}

describe('Stable Supervisor production hardening', () => {
  test('release bundles include the durable Worker entrypoint', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-worker-release-'));
    try {
      const release = installSupervisorRelease({
        controllerHome,
        repoRoot: process.cwd(),
        sourceRoot: process.cwd(),
        allowDirtyRuntimeSourceForTests: true,
        allowUnreproducibleReleaseForTests: true,
      });
      expect(existsSync(join(release.releasePath, 'worker.js'))).toBe(true);
      expect(existsSync(join(release.releasePath, 'browser-handoff-host.js'))).toBe(true);
      const manifest = JSON.parse(readFileSync(join(release.releasePath, 'manifest.json'), 'utf8')) as {
        releaseRevision?: string;
        sourceCommit?: string;
        cleanWorkspace?: boolean;
        workerEntrypoint?: string;
        browserHandoffHostEntrypoint?: string;
        capabilities?: string[];
      };
      if (!release.sourceCommit) throw new Error('release sourceCommit missing');
      const expectedRevision = `${release.sourceCommit}${release.cleanWorkspace ? '' : '-dirty'}`;
      expect(manifest.sourceCommit).toBe(release.sourceCommit);
      expect(manifest.releaseRevision).toBe(expectedRevision);
      expect(release.releaseRevision).toBe(expectedRevision);
      expect(manifest.workerEntrypoint).toBe('worker.js');
      expect(manifest.browserHandoffHostEntrypoint).toBe('browser-handoff-host.js');
      expect(manifest.capabilities).toContain('staged_rollout_release');
      expect(manifest.capabilities).toContain('browser_handoff_host');
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  }, 180_000);

  test('release staging refuses dirty runtime source paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-dirty-release-source-'));
    const controllerHome = join(root, 'controller');
    const sourceRoot = join(root, 'source');
    try {
      mkdirSync(join(sourceRoot, 'src'), { recursive: true });
      mkdirSync(join(sourceRoot, 'scripts'), { recursive: true });
      writeFileSync(join(sourceRoot, 'src', 'runtime.ts'), 'export const version = 1;\n');
      writeFileSync(join(sourceRoot, 'scripts', 'build.sh'), '#!/usr/bin/env bash\n');
      writeFileSync(join(sourceRoot, 'package.json'), '{"name":"fixture"}\n');
      writeFileSync(join(sourceRoot, 'bun.lock'), '\n');
      git(sourceRoot, ['init']);
      git(sourceRoot, ['config', 'user.email', 'release-test@example.invalid']);
      git(sourceRoot, ['config', 'user.name', 'Release Test']);
      git(sourceRoot, ['add', '.']);
      git(sourceRoot, ['commit', '-m', 'initial runtime source']);
      writeFileSync(join(sourceRoot, 'src', 'runtime.ts'), 'export const version = 2;\n');

      expect(() => stageSupervisorRelease({ controllerHome, repoRoot: sourceRoot, sourceRoot }))
        .toThrow(/SUPERVISOR_RELEASE_DIRTY_RUNTIME_SOURCE:.*src\/runtime\.ts/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('release publication rejects dirty or incomplete release identity', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-release-identity-'));
    try {
      const dirty = fakeSupervisorRelease(controllerHome, 'dirty', '87de8ff67d55-dirty');
      writeFileSync(join(dirty, 'manifest.json'), `${JSON.stringify({
        schemaVersion: 2,
        releaseRevision: '87de8ff67d55-dirty',
        sourceCommit: '0123456789abcdef0123456789abcdef01234567',
        sourceRoot: process.cwd(),
        cleanWorkspace: false,
        artifactHash: 'b'.repeat(64),
      })}\n`);
      expect(() => publishSupervisorRelease({ controllerHome, repoRoot: process.cwd(), releasePath: dirty }))
        .toThrow(/SUPERVISOR_RELEASE_NOT_REPRODUCIBLE/);

      const incomplete = fakeSupervisorRelease(controllerHome, 'incomplete', 'revision-incomplete');
      writeFileSync(join(incomplete, 'manifest.json'), `${JSON.stringify({
        schemaVersion: 1,
        releaseRevision: 'revision-incomplete',
        sourceRoot: process.cwd(),
      })}\n`);
      expect(() => publishSupervisorRelease({ controllerHome, repoRoot: process.cwd(), releasePath: incomplete }))
        .toThrow(/SUPERVISOR_RELEASE_NOT_REPRODUCIBLE/);
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('staged releases remain unpublished until candidate verification succeeds', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-staged-release-'));
    try {
      const staged = stageSupervisorRelease({
        controllerHome,
        repoRoot: process.cwd(),
        sourceRoot: process.cwd(),
        allowDirtyRuntimeSourceForTests: true,
      });
      expect(readCurrentRelease(controllerHome)).toBeUndefined();
      expect(readCurrentSupervisorRelease(controllerHome)).toBeUndefined();
      expect(existsSync(join(staged.releasePath, 'worker.js'))).toBe(true);
      expect(existsSync(join(staged.releasePath, 'browser-handoff-host.js'))).toBe(true);

      const published = publishSupervisorRelease({
        controllerHome,
        repoRoot: process.cwd(),
        releasePath: staged.releasePath,
        allowUnreproducibleReleaseForTests: true,
      });
      expect(readCurrentRelease(controllerHome)).toBe(staged.releasePath);
      expect(published.releasePath).toBe(staged.releasePath);
      expect(readCurrentSupervisorRelease(controllerHome)?.releaseRevision).toBe(staged.releaseRevision);
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  }, 180_000);

  test('release publication schedules one activation and restores the previous release when scheduling fails', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-release-activation-'));
    try {
      const previous = fakeSupervisorRelease(controllerHome, 'previous', 'revision-previous');
      const candidate = fakeSupervisorRelease(controllerHome, 'candidate', 'revision-candidate');
      const failedCandidate = fakeSupervisorRelease(controllerHome, 'failed-candidate', 'revision-failed');
      publishSupervisorRelease({ controllerHome, repoRoot: process.cwd(), releasePath: previous });

      const scheduled: Array<{ repo: string; home: string; delay: number }> = [];
      const activated = publishAndScheduleSupervisorRelease({
        controllerHome,
        repoRoot: process.cwd(),
        releasePath: candidate,
        handoffDelayMs: 2_000,
      }, {
        schedule: (repo, home, delay) => {
          scheduled.push({ repo, home, delay: delay ?? 0 });
          return {
            activationId: 'activation-candidate',
            pid: 123,
            statePath: join(home, 'supervisor', 'activation.json'),
            logPath: join(home, 'supervisor', 'logs', 'activation.log'),
            expectedReleaseRevision: 'revision-candidate',
            expectedReleasePath: candidate,
          };
        },
      });
      expect(readCurrentRelease(controllerHome)).toBe(candidate);
      expect(activated.activation.expectedReleaseRevision).toBe('revision-candidate');
      expect(scheduled).toEqual([{ repo: process.cwd(), home: controllerHome, delay: 2_000 }]);

      expect(() => publishAndScheduleSupervisorRelease({
        controllerHome,
        repoRoot: process.cwd(),
        releasePath: failedCandidate,
      }, {
        schedule: () => { throw new Error('spawn denied'); },
      })).toThrow('SUPERVISOR_ACTIVATION_SCHEDULE_FAILED');
      expect(readCurrentRelease(controllerHome)).toBe(candidate);
      expect(readCurrentSupervisorRelease(controllerHome)?.releaseRevision).toBe('revision-candidate');
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('only OS-managed Supervisor services activate newly published releases', () => {
    expect(stableSupervisorActivatesPublishedRelease(undefined)).toBe(true);
    expect(stableSupervisorActivatesPublishedRelease('managed')).toBe(true);
    expect(stableSupervisorActivatesPublishedRelease('detached')).toBe(false);
  });

  test('unexpected runtime stop is restartable while explicit signal remains successful', () => {
    expect(stableSupervisorExitCode('unexpected_runtime_stop')).toBe(1);
    expect(stableSupervisorExitCode('explicit_signal')).toBe(0);
  });

  test('OS services restart crashes but preserve explicit successful stop', () => {
    const plist = renderLaunchdSupervisorPlist({
      label: 'com.example.supervisor',
      bunPath: '/usr/local/bin/bun',
      supervisorPath: '/tmp/supervisor.js',
      repoRoot: '/tmp/repo',
      controllerHome: '/tmp/home',
      runtimeSourceRoot: '/tmp/repo',
      releaseRevision: 'revision-a',
      logPath: '/tmp/supervisor.log',
      homeDir: '/Users/example',
      nvmBin: '/Users/example/.nvm/versions/node/current/bin',
    });
    expect(plist).toContain('<key>SuccessfulExit</key><false/>');
    expect(plist).toContain('--release-revision');
    expect(plist).toContain('revision-a');
    expect(plist).toContain('<key>EnvironmentVariables</key>');
    expect(plist).toContain('<key>PATH</key><string>/usr/local/bin:/Users/example/.bun/bin:/Users/example/.volta/bin:/Users/example/.nvm/versions/node/current/bin:/Users/example/.local/share/mise/shims:/Users/example/.asdf/shims:/Users/example/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>');
    expect(plist).not.toContain('<key>KeepAlive</key><true/>');
    const unit = renderSystemdSupervisorUnit({
      bunPath: '/usr/local/bin/bun',
      supervisorPath: '/tmp/supervisor.js',
      repoRoot: '/tmp/repo',
      controllerHome: '/tmp/home',
      runtimeSourceRoot: '/tmp/repo',
      homeDir: '/Users/example',
      nvmBin: '/Users/example/.nvm/versions/node/current/bin',
    });
    expect(unit).toContain('Environment="PATH=/usr/local/bin:/Users/example/.bun/bin:/Users/example/.volta/bin:/Users/example/.nvm/versions/node/current/bin:/Users/example/.local/share/mise/shims:/Users/example/.asdf/shims:/Users/example/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).not.toContain('Restart=always');
    const spaced = renderSystemdSupervisorUnit({
      bunPath: '/Users/example/My Tools/bun',
      supervisorPath: '/Users/example/Controller Home/supervisor.js',
      repoRoot: '/Users/example/Repo Harness',
      controllerHome: '/Users/example/Controller Home',
      runtimeSourceRoot: '/Users/example/Repo Harness',
      homeDir: '/Users/example',
      nvmBin: '/Users/example/.nvm/versions/node/current/bin',
    });
    expect(spaced).toContain('Environment="PATH=/Users/example/My Tools:/Users/example/.bun/bin:/Users/example/.volta/bin:/Users/example/.nvm/versions/node/current/bin:/Users/example/.local/share/mise/shims:/Users/example/.asdf/shims:/Users/example/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"');
    expect(spaced).toContain('ExecStart="/Users/example/My Tools/bun"');
    expect(supervisorSystemdUnitName('/tmp/a/controller-home')).not.toBe(supervisorSystemdUnitName('/tmp/b/controller-home'));
    expect(supervisorServiceLabel('/tmp/a/controller-home')).not.toBe(supervisorServiceLabel('/tmp/b/controller-home'));
  });

  test('passive candidate daemon skips startup recovery and is explicitly marked read-only', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-passive-daemon-'));
    try {
      let recoveryCalls = 0;
      const result = publishReadyAfterStartupRecovery(
        controllerHome,
        '2026-07-26T00:00:00.000Z',
        () => {
          recoveryCalls += 1;
          return { completedAt: new Date().toISOString(), repositories: [], errors: [], degraded: false };
        },
        { passive: true },
      );
      expect(recoveryCalls).toBe(0);
      expect(result.degraded).toBe(false);
      const state = JSON.parse(readFileSync(join(controllerHome, 'daemon', 'state.json'), 'utf8')) as {
        status?: string;
        passive?: boolean;
        recovery?: { repositories?: unknown[]; errors?: unknown[] };
      };
      expect(state.status).toBe('ready');
      expect(state.passive).toBe(true);
      expect(state.recovery?.repositories).toEqual([]);
      expect(state.recovery?.errors).toEqual([]);
      expect(controllerDaemonPassiveMode({ REPO_HARNESS_RUNTIME_PASSIVE: '1' })).toBe(true);
      expect(controllerDaemonPassiveMode({ REPO_HARNESS_RUNTIME_PASSIVE: '0' })).toBe(false);
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('writer environment marks only the non-authoritative slot passive', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-passive-writer-env-'));
    try {
      publishWriterAuthority(controllerHome, { activeSlot: 'blue', generation: 'generation-blue', reason: 'test' });
      expect(runtimeWriterEnvironment(controllerHome, 'blue').REPO_HARNESS_RUNTIME_PASSIVE).toBe('0');
      expect(runtimeWriterEnvironment(controllerHome, 'green').REPO_HARNESS_RUNTIME_PASSIVE).toBe('1');
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('authenticated cutover probe exercises OAuth, MCP initialize, tools/list, and a read-only call', async () => {
    const observed: string[] = [];
    const endpoint = await listen(async (request, response) => {
      if (request.url === '/mcp') {
        response.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer resource_metadata="/.well-known/oauth-protected-resource"' });
        response.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (request.url !== '/mcp-bearer' || request.headers.authorization !== 'Bearer probe-token') {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const rpc = JSON.parse(body) as { id: number; method: string; params?: { name?: string } };
      observed.push(rpc.method);
      response.setHeader('content-type', 'application/json');
      response.setHeader('mcp-session-id', 'probe-session');
      if (rpc.method === 'initialize') {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } }));
      } else if (rpc.method === 'tools/list') {
        expect(request.headers['mcp-session-id']).toBe('probe-session');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'controller_ready' }] } }));
      } else {
        expect(rpc.params?.name).toBe('controller_ready');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: '{"ready":true}' }] } }));
      }
    });

    const result = await probeAuthenticatedMcpReadiness({
      baseUrl: `http://127.0.0.1:${endpoint.port}`,
      token: 'probe-token',
      timeoutMs: 2_000,
    });
    expect(result).toMatchObject({ healthy: true, toolCount: 1, readOnlyTool: 'controller_ready' });
    expect(observed).toEqual(['initialize', 'tools/list', 'tools/call']);
  });

  test('Gateway health probe distinguishes live process state from MCP readiness', async () => {
    const healthy = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
    });
    const degraded = await listen((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'degraded' }));
    });
    const busy = await listen((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ready: false, sessionCapacity: { acceptingNewSessions: false, recoveryRecommended: false } }));
    });
    const stalled = await listen((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ready: false, sessionCapacity: { acceptingNewSessions: false, recoveryRecommended: true } }));
    });

    expect(await probeSupervisorGatewayHealth(`http://127.0.0.1:${healthy.port}/health`)).toEqual({
      healthy: true,
      statusCode: 200,
      detail: 'ok',
    });
    const unhealthy = await probeSupervisorGatewayHealth(`http://127.0.0.1:${degraded.port}/health`);
    expect(unhealthy.healthy).toBe(false);
    expect(unhealthy.statusCode).toBe(503);
    expect(unhealthy.detail).toContain('status=503');
    expect(await probeSupervisorGatewayHealth(`http://127.0.0.1:${busy.port}/ready`)).toMatchObject({
      healthy: true,
      ready: false,
      recoveryRecommended: false,
    });
    expect(await probeSupervisorGatewayHealth(`http://127.0.0.1:${stalled.port}/ready`)).toMatchObject({
      healthy: true,
      ready: false,
      recoveryRecommended: true,
    });
    expect(SUPERVISOR_GATEWAY_HEALTH_FAILURE_THRESHOLD).toBe(9);
    let failures = 0;
    for (let attempt = 1; attempt < SUPERVISOR_GATEWAY_HEALTH_FAILURE_THRESHOLD; attempt += 1) {
      const decision = supervisorGatewayHealthDecision(failures, false);
      failures = decision.consecutiveFailures;
      expect(decision.shouldRecover).toBe(false);
    }
    const threshold = supervisorGatewayHealthDecision(failures, false);
    expect(threshold.consecutiveFailures).toBe(SUPERVISOR_GATEWAY_HEALTH_FAILURE_THRESHOLD);
    expect(threshold.shouldRecover).toBe(true);
    expect(supervisorGatewayHealthDecision(threshold.consecutiveFailures, true)).toEqual({
      consecutiveFailures: 0,
      shouldRecover: false,
    });
    expect(SUPERVISOR_INGRESS_HEALTH_FAILURE_THRESHOLD).toBe(SUPERVISOR_GATEWAY_HEALTH_FAILURE_THRESHOLD);
    expect(supervisorIngressHealthDecision(SUPERVISOR_INGRESS_HEALTH_FAILURE_THRESHOLD - 2, false)).toEqual({
      consecutiveFailures: SUPERVISOR_INGRESS_HEALTH_FAILURE_THRESHOLD - 1,
      shouldReplace: false,
    });
    expect(supervisorIngressHealthDecision(SUPERVISOR_INGRESS_HEALTH_FAILURE_THRESHOLD - 1, false)).toEqual({
      consecutiveFailures: SUPERVISOR_INGRESS_HEALTH_FAILURE_THRESHOLD,
      shouldReplace: true,
    });
    expect(supervisorIngressHealthDecision(SUPERVISOR_INGRESS_HEALTH_FAILURE_THRESHOLD - 1, false, true)).toEqual({
      consecutiveFailures: SUPERVISOR_INGRESS_HEALTH_FAILURE_THRESHOLD,
      shouldReplace: false,
    });
    expect(supervisorIngressHealthDecision(7, true)).toEqual({ consecutiveFailures: 0, shouldReplace: false });

    // Single HTTP failures only accumulate; success resets the counter.
    let probeFailures = 0;
    const first = supervisorGatewayHealthDecision(probeFailures, false);
    expect(first.shouldRecover).toBe(false);
    probeFailures = first.consecutiveFailures;
    const second = supervisorGatewayHealthDecision(probeFailures, false);
    expect(second.shouldRecover).toBe(false);
    expect(second.consecutiveFailures).toBe(2);
    expect(supervisorGatewayHealthDecision(second.consecutiveFailures, true)).toEqual({
      consecutiveFailures: 0,
      shouldRecover: false,
    });
    // The monitor aggregation must also keep a live Gateway operational below
    // the recovery threshold; otherwise one transient failure still degrades Ingress.
    expect(supervisorGatewayOperational(true, 'running', 1)).toBe(true);
    expect(supervisorGatewayOperational(
      true,
      'running',
      SUPERVISOR_GATEWAY_HEALTH_FAILURE_THRESHOLD - 1,
    )).toBe(true);
    expect(supervisorGatewayOperational(
      true,
      'running',
      SUPERVISOR_GATEWAY_HEALTH_FAILURE_THRESHOLD,
    )).toBe(false);
    expect(supervisorGatewayOperational(false, 'running', 0)).toBe(false);
    expect(supervisorGatewayRuntimeReady({ status: 'degraded', server: { healthy: true } } as any)).toBe(true);
    expect(supervisorGatewayRuntimeReady({ status: 'running', server: { healthy: true } } as any)).toBe(true);
    expect(supervisorGatewayRuntimeReady({ status: 'degraded', server: { healthy: false } } as any)).toBe(false);
    expect(supervisorGatewayRuntimeReady({ status: 'starting', server: { healthy: true } } as any)).toBe(false);

    const invalidBody = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('not-json');
    });
    const networkDown = await listen((_request, response) => {
      response.destroy();
    });
    expect(await probeSupervisorGatewayHealth(`http://127.0.0.1:${invalidBody.port}/health`)).toMatchObject({
      healthy: false,
      detail: expect.stringContaining('invalid_health_body'),
    });
    const network = await probeSupervisorGatewayHealth(`http://127.0.0.1:${networkDown.port}/health`);
    expect(network.healthy).toBe(false);
    // A single network/400/503 style failure must not by itself request recovery.
    expect(supervisorGatewayHealthDecision(0, network.healthy).shouldRecover).toBe(false);
    expect(supervisorGatewayHealthDecision(0, false).shouldRecover).toBe(false);
  });

  test('candidate MCP readiness tolerates a bounded delayed-listener startup window', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-mcp-startup-grace-'));
    try {
      ensureMcpControllerHomeBearerToken(controllerHome);
      let initializeAttempts = 0;
      const server = await listen((request, response) => {
        if (request.method === 'DELETE') {
          response.statusCode = 204;
          response.end();
          return;
        }
        const chunks: Buffer[] = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method?: string };
          response.setHeader('content-type', 'application/json');
          if (payload.method === 'initialize') {
            initializeAttempts += 1;
            if (initializeAttempts <= 4) {
              response.statusCode = 503;
              response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: { code: -32000, message: 'starting' } }));
              return;
            }
            response.setHeader('mcp-session-id', 'startup-grace-session');
            response.end(JSON.stringify({
              jsonrpc: '2.0',
              id: payload.id,
              result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test', version: '1' } },
            }));
            return;
          }
          if (payload.method === 'notifications/initialized') {
            response.statusCode = 202;
            response.end();
            return;
          }
          response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { tools: [{ name: 'controller_ready' }] } }));
        });
      });
      const result = await probeSupervisorMcpReadiness({
        controllerHome,
        repoRoot: process.cwd(),
        host: '127.0.0.1',
        port: server.port,
        timeoutMs: 1_000,
      });
      expect(result.ok).toBe(true);
      expect(result.toolCount).toBe(1);
      expect(initializeAttempts).toBe(5);
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('candidate MCP readiness fails closed on authentication failure', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-mcp-readiness-'));
    try {
      ensureMcpControllerHomeBearerToken(controllerHome);
      const server = await listen((_request, response) => {
        response.statusCode = 401;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ error: 'unauthorized' }));
      });
      const result = await probeSupervisorMcpReadiness({
        controllerHome,
        repoRoot: process.cwd(),
        host: '127.0.0.1',
        port: server.port,
        attempts: 1,
        timeoutMs: 1_000,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('status=401');
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('restart_controller preserves the Gateway and delegates only conditional generation reconciliation', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-controller-only-restart-'));
    try {
      const runtime = new StableSupervisorRuntime({
        repoRoot: process.cwd(),
        controllerHome,
        runtimeSourceRoot: process.cwd(),
        ownerEpoch: 1,
        logPath: join(controllerHome, 'supervisor.log'),
      });
      const accepted = createSupervisorOperation({
        controllerHome,
        repoRoot: process.cwd(),
        requestId: 'controller-only-restart-test',
        kind: 'restart_controller',
        requestedBy: 'test',
        actor: 'test',
      });
      const calls: string[] = [];
      const internal = runtime as unknown as {
        executeOperation: (operation: SupervisorOperation) => Promise<void>;
        restartComponent: (component: 'controllerDaemon' | 'gatewayHost', operationId: string) => Promise<void>;
        ensureRuntime: () => Promise<void>;
        synchronizeActiveRuntimeGeneration: (requireAgreement?: boolean) => string | undefined;
      };
      internal.restartComponent = async (component) => { calls.push(`restart:${component}`); };
      internal.ensureRuntime = async () => { calls.push('ensure-runtime'); };
      internal.synchronizeActiveRuntimeGeneration = () => undefined;

      await internal.executeOperation(accepted.operation);

      expect(calls).toEqual(['restart:controllerDaemon', 'ensure-runtime']);
      expect(readSupervisorOperation(controllerHome, accepted.operation.operationId)?.phase).toBe('succeeded');
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('Supervisor serializes monitor ticks so ingress recovery cannot overlap', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-monitor-serialization-'));
    try {
      const runtime = new StableSupervisorRuntime({
        repoRoot: process.cwd(),
        controllerHome,
        runtimeSourceRoot: process.cwd(),
        ownerEpoch: 1,
        logPath: join(controllerHome, 'supervisor.log'),
      });
      const internal = runtime as unknown as {
        monitorTick: () => Promise<void>;
        scheduleMonitorTick: () => void;
        monitorPromise?: Promise<void>;
      };
      let releaseFirst!: () => void;
      let runs = 0;
      internal.monitorTick = async () => {
        runs += 1;
        if (runs === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      };

      internal.scheduleMonitorTick();
      internal.scheduleMonitorTick();
      await Bun.sleep(0);
      expect(runs).toBe(1);
      releaseFirst();
      await internal.monitorPromise;
      await Bun.sleep(0);

      internal.scheduleMonitorTick();
      await internal.monitorPromise;
      expect(runs).toBe(2);
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('repeated monitor failures request an OS-service restart instead of leaving a false-alive Supervisor', async () => {
    expect(SUPERVISOR_MONITOR_FAILURE_THRESHOLD).toBe(3);
    expect(supervisorMonitorFailureDecision(0, false)).toEqual({ consecutiveFailures: 1, shouldRestart: false });
    expect(supervisorMonitorFailureDecision(1, false)).toEqual({ consecutiveFailures: 2, shouldRestart: false });
    expect(supervisorMonitorFailureDecision(2, false)).toEqual({ consecutiveFailures: 3, shouldRestart: true });
    expect(supervisorMonitorFailureDecision(2, true)).toEqual({ consecutiveFailures: 0, shouldRestart: false });

    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-monitor-self-restart-'));
    let stopped = 0;
    try {
      const runtime = new StableSupervisorRuntime({
        repoRoot: process.cwd(),
        controllerHome,
        runtimeSourceRoot: process.cwd(),
        ownerEpoch: 1,
        logPath: join(controllerHome, 'supervisor.log'),
        onStopped: () => { stopped += 1; },
      });
      const internal = runtime as unknown as {
        monitorTick: () => Promise<void>;
        scheduleMonitorTick: () => void;
        monitorPromise?: Promise<void>;
      };
      internal.monitorTick = async () => { throw new Error('fixture ingress recovery failed'); };

      for (let attempt = 1; attempt <= SUPERVISOR_MONITOR_FAILURE_THRESHOLD; attempt += 1) {
        internal.scheduleMonitorTick();
        await internal.monitorPromise;
        await Bun.sleep(0);
        expect(stopped).toBe(attempt === SUPERVISOR_MONITOR_FAILURE_THRESHOLD ? 1 : 0);
      }

      internal.scheduleMonitorTick();
      await Bun.sleep(0);
      expect(stopped).toBe(1);
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('stable ingress data plane runs in a supervised process separate from lifecycle control', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-ingress-process-'));
    const main = await listen((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ok', source: 'isolated-main' }));
    });
    const rescue = await listen((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ok', path: request.url }));
    });
    const ingress = await createStableIngressProcess({
      executable: join(process.cwd(), 'src/runtime/supervisor/entry.ts'),
      repoRoot: process.cwd(),
      controllerHome,
      host: '127.0.0.1',
      port: 0,
      rescueHost: '127.0.0.1',
      rescuePort: rescue.port,
      blueUpstreamPort: main.port,
      greenUpstreamPort: main.port,
    });
    try {
      expect(ingress.pid).not.toBe(process.pid);
      expect(ingress.alive()).toBe(true);
      const health = await fetch(`http://127.0.0.1:${ingress.port}/health`).then((response) => response.json()) as { source?: string };
      expect(health.source).toBe('isolated-main');
      const rescueHealth = await fetch(`http://127.0.0.1:${ingress.port}/rescue/health`).then((response) => response.json()) as { path?: string };
      expect(rescueHealth.path).toBe('/health');
    } finally {
      await ingress.close();
      rmSync(controllerHome, { recursive: true, force: true });
    }
    expect(ingress.alive()).toBe(false);
  });

  test('stable ingress false-health is observable while its child process remains alive', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-ingress-false-health-'));
    const unavailableUpstream = await listen((_request, response) => {
      response.end('temporary');
    });
    await new Promise<void>((resolve) => unavailableUpstream.server.close(() => resolve()));
    const serverIndex = servers.indexOf(unavailableUpstream.server);
    if (serverIndex >= 0) servers.splice(serverIndex, 1);
    const rescue = await listen((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ok' }));
    });
    const ingress = await createStableIngressProcess({
      executable: join(process.cwd(), 'src/runtime/supervisor/entry.ts'),
      repoRoot: process.cwd(),
      controllerHome,
      host: '127.0.0.1',
      port: 0,
      rescueHost: '127.0.0.1',
      rescuePort: rescue.port,
      blueUpstreamPort: unavailableUpstream.port,
      greenUpstreamPort: unavailableUpstream.port,
    });
    try {
      expect(ingress.alive()).toBe(true);
      const health = await probeSupervisorGatewayHealth(`http://127.0.0.1:${ingress.port}/ready`);
      expect(health).toMatchObject({ healthy: false, statusCode: 503 });
      expect(ingress.alive()).toBe(true);
    } finally {
      await ingress.close();
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('temporary harness daemons self-expire while production homes do not', () => {
    const temporary = join(tmpdir(), 'repo-harness-supervisor-test', 'controller-home');
    expect(controllerDaemonMaxLifetimeMs(temporary, '')).toBe(5 * 60_000);
    expect(controllerDaemonMaxLifetimeMs('/Users/example/controller-home', '')).toBeUndefined();
    expect(controllerDaemonMaxLifetimeMs('/Users/example/controller-home', '2500')).toBe(2500);
  });

  test('Controller Daemon shutdown attribution preserves the highest-signal cause', () => {
    expect(resolveControllerDaemonShutdownReason({ signal: 'SIGTERM' })).toBe('SIGTERM');
    expect(resolveControllerDaemonShutdownReason({ signal: 'SIGINT' })).toBe('SIGINT');
    expect(resolveControllerDaemonShutdownReason({ maxLifetimeExpired: true })).toBe('max_lifetime');
    expect(resolveControllerDaemonShutdownReason({
      signal: 'SIGTERM',
      maxLifetimeExpired: true,
      schedulerFailure: 'scheduler failed',
    })).toBe('scheduler_error');
    expect(resolveControllerDaemonShutdownReason({})).toBe('lifecycle_complete');
  });

  test('stable ingress does not impose a five-second timeout on valid MCP streams', async () => {
    const main = await listen((_request, response) => {
      setTimeout(() => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ status: 'ok', delayed: true }));
      }, 5_100);
    });
    const rescue = await listen((_request, response) => response.end('{}'));
    const router = await createStableIngressRouter({
      host: '127.0.0.1', port: 0, rescueHost: '127.0.0.1', rescuePort: rescue.port,
      upstream: () => ({ host: '127.0.0.1', port: main.port }),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${router.port}/mcp`);
      expect(response.status).toBe(200);
      expect((await response.json() as { delayed?: boolean }).delayed).toBe(true);
    } finally {
      await router.close();
    }
  }, 10_000);

  test('stable ingress keeps recovery routes available when the main Gateway is absent', async () => {
    const main = await listen((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ok', source: 'main' }));
    });
    const rescue = await listen((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ok', path: request.url }));
    });
    let upstream: { host: string; port: number } | null = { host: '127.0.0.1', port: main.port };
    const router = await createStableIngressRouter({
      host: '127.0.0.1',
      port: 0,
      rescueHost: '127.0.0.1',
      rescuePort: rescue.port,
      upstream: () => upstream,
    });
    try {
      const mainHealth = await fetch(`http://127.0.0.1:${router.port}/health`).then((response) => response.json()) as { source?: string };
      expect(mainHealth.source).toBe('main');
      upstream = null;
      const unavailable = await fetch(`http://127.0.0.1:${router.port}/health`);
      expect(unavailable.status).toBe(503);
      const rescueHealth = await fetch(`http://127.0.0.1:${router.port}/rescue/health`).then((response) => response.json()) as { path?: string };
      expect(rescueHealth.path).toBe('/health');
      const discovery = await fetch(`http://127.0.0.1:${router.port}/.well-known/oauth-protected-resource/rescue/mcp`, {
        headers: { host: 'recovery.example.test', 'x-forwarded-proto': 'https' },
      }).then((response) => response.json()) as { resource?: string };
      expect(discovery.resource).toBe('https://recovery.example.test/rescue/mcp');
    } finally {
      await router.close();
    }
  });

  test('Supervisor handoff invokes the non-destructive handler without full stop', async () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-supervisor-handoff-control-'));
    let handoffCalls = 0;
    let stopCalls = 0;
    let callbackCalls = 0;
    const control = await createSupervisorControlServer({
      controllerHome: home,
      repoRoot: process.cwd(),
      controlPort: 0,
      authToken: 'test-token',
      onHandoff: () => { callbackCalls += 1; },
      handlers: {
        getState: () => null,
        getOperation: () => null,
        submitOperation: () => { throw new Error('unexpected mutation'); },
        submitCommand: () => { throw new Error('unexpected mutation'); },
        handoff: async () => { handoffCalls += 1; },
        stop: async () => { stopCalls += 1; },
      },
    });
    try {
      const result = await sendSupervisorCommand(home, { command: 'handoff' });
      expect(result.ok).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(handoffCalls).toBe(1);
      expect(stopCalls).toBe(0);
      expect(callbackCalls).toBe(1);
    } finally {
      await control.close();
    }
  });

  test('Rescue MCP accepts query paths and rejects oversized bodies without dropping the response', async () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-supervisor-control-'));
    const control = await createSupervisorControlServer({
      controllerHome: home,
      repoRoot: process.cwd(),
      controlPort: 0,
      authToken: 'test-recovery-token',
      handlers: {
        getState: () => null,
        getOperation: () => null,
        submitOperation: () => { throw new Error('unexpected mutation'); },
        submitCommand: () => { throw new Error('unexpected mutation'); },
        handoff: async () => undefined,
        stop: async () => undefined,
      },
    });
    try {
      const endpoint = `http://127.0.0.1:${control.port}/rescue/mcp?session=test`;
      const initialized = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: 'Bearer test-recovery-token', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      expect(initialized.status).toBe(200);
      const oversized = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: 'Bearer test-recovery-token', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', padding: 'x'.repeat(129 * 1024) }),
      });
      expect(oversized.status).toBe(413);
      const payload = await oversized.json() as { error?: { code?: string } };
      expect(payload.error?.code).toBe('RESCUE_REQUEST_TOO_LARGE');
    } finally {
      await control.close();
    }
  });

  test('installed release descriptors preserve immutable child executable identity', async () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-supervisor-release-'));
    const release = join(home, 'supervisor', 'releases', 'release-a');
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, 'supervisor.js'), '');
    writeFileSync(join(release, 'repo-harness.js'), '');
    writeFileSync(join(release, 'daemon.js'), 'setInterval(() => undefined, 1000);');
    writeFileSync(join(release, 'manifest.json'), JSON.stringify({ releaseRevision: 'revision-a', sourceRoot: process.cwd() }));
    mkdirSync(join(home, 'supervisor'), { recursive: true });
    symlinkSync(release, join(home, 'supervisor', 'current'), 'dir');
    const descriptor = readCurrentSupervisorRelease(home);
    expect(descriptor).toBeDefined();
    expect(descriptor?.releaseRevision).toBe('revision-a');
    const manager = new SupervisorProcessManager({
      repoRoot: process.cwd(), controllerHome: home, runtimeSourceRoot: process.cwd(), ownerEpoch: 1,
      runtimeExecutable: descriptor?.runtimeExecutable, daemonExecutable: descriptor?.daemonExecutable,
      releasePath: descriptor?.releasePath, releaseRevision: descriptor?.releaseRevision,
      logPath: join(home, 'supervisor.log'), slot: 'green',
    });
    expect(manager.gatewayArgs(join(home, 'runtime-slots', 'green'))[0]).toBe(descriptor!.runtimeExecutable);
    const spawned = await manager.startDaemon();
    try {
      expect(spawned.identity.releasePath).toBe(descriptor!.releasePath);
      expect(spawned.identity.releaseRevision).toBe('revision-a');
    } finally {
      await manager.stop(spawned.identity, {
        reason: 'test_release_identity_cleanup',
        component: 'controllerDaemon',
        operationId: 'test-release-identity',
      });
    }
    const stopEvents = readFileSync(supervisorProcessStopAuditPath(join(home, 'supervisor.log')), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(stopEvents.some((event) => (
      event.phase === 'requested'
      && event.reason === 'test_release_identity_cleanup'
      && event.component === 'controllerDaemon'
      && event.operationId === 'test-release-identity'
      && event.instanceId === spawned.identity.instanceId
    ))).toBe(true);
    expect(stopEvents.some((event) => event.phase === 'completed' && event.stopped === true)).toBe(true);
  });

  test('new Supervisor release handoff replaces healthy persisted children from an older release', () => {
    const oldDaemon = {
      ...managedProcess('blue', 301, 'generation-old'),
      releasePath: '/tmp/releases/old',
      releaseRevision: 'old-revision',
      ownerEpoch: 7,
    };
    const expected = {
      releasePath: '/tmp/releases/current',
      releaseRevision: 'new-revision',
      supervisorExecutable: '/tmp/releases/current/supervisor.js',
      runtimeExecutable: '/tmp/releases/current/repo-harness.js',
      daemonExecutable: '/tmp/releases/current/daemon.js',
    };
    expect(managedProcessNeedsReleaseRefresh(oldDaemon, expected, 8, true)).toBe(true);
    const matchingOldEpoch = {
      ...oldDaemon,
      releasePath: expected.releasePath,
      releaseRevision: expected.releaseRevision,
    };
    expect(managedProcessNeedsReleaseRefresh(matchingOldEpoch, expected, 8, true)).toBe(true);
    expect(managedProcessNeedsReleaseRefresh(
      matchingOldEpoch,
      expected,
      8,
      true,
      { allowOwnerEpochAdoption: true },
    )).toBe(false);
    expect(managedProcessNeedsReleaseRefresh(
      oldDaemon,
      expected,
      8,
      true,
      { allowOwnerEpochAdoption: true },
    )).toBe(true);
    expect(managedProcessNeedsReleaseRefresh({ ...matchingOldEpoch, ownerEpoch: 8 }, expected, 8, true)).toBe(false);
  });

  test('healthy Supervisor status from an older release cannot satisfy activation', () => {
    const control = {
      ok: true,
      state: {
        observedState: 'healthy',
        supervisor: { releaseRevision: 'old-revision' },
        controllerDaemon: { releaseRevision: 'old-revision' },
        gatewayHost: { releaseRevision: 'old-revision' },
      },
    };
    expect(supervisorActivationMatchesRelease(control, 'new-revision')).toBe(false);
    expect(supervisorActivationMatchesRelease({
      ...control,
      state: {
        ...control.state,
        supervisor: { releaseRevision: 'new-revision' },
        controllerDaemon: { releaseRevision: 'new-revision' },
        gatewayHost: { releaseRevision: 'new-revision' },
      },
    }, 'new-revision')).toBe(true);
  });

  test('service activation requires current, generated, installed, and running Supervisor releases to agree', () => {
    const serviceFor = (revision: string) => renderLaunchdSupervisorPlist({
      label: 'com.example.supervisor',
      bunPath: '/usr/local/bin/bun',
      supervisorPath: `/tmp/releases/${revision}/supervisor.js`,
      repoRoot: '/tmp/repo',
      controllerHome: '/tmp/home',
      runtimeSourceRoot: '/tmp/repo',
      releaseRevision: revision,
      logPath: '/tmp/supervisor.log',
      homeDir: '/Users/example',
    });
    const expected = extractSupervisorServiceRelease(serviceFor('revision-a'));
    const coherent = evaluateSupervisorServiceReleaseCoherence({
      expected,
      running: expected,
      generated: expected,
      installed: expected,
    });
    expect(coherent.ok).toBe(true);

    const detached = evaluateSupervisorServiceReleaseCoherence({
      expected,
      running: expected,
      generated: expected,
    });
    expect(detached.ok).toBe(true);
    expect(detached.serviceRegistered).toBe(false);

    const installed = extractSupervisorServiceRelease(serviceFor('revision-old'));
    const drifted = evaluateSupervisorServiceReleaseCoherence({
      expected,
      running: expected,
      generated: expected,
      installed,
      serviceRegistered: true,
    });
    expect(drifted.ok).toBe(false);
    expect(drifted.failures.join('; ')).toContain('installed service Supervisor release mismatch');
    expect(supervisorActivationMatchesRelease({
      ok: true,
      state: {
        observedState: 'healthy',
        supervisor: { releaseRevision: 'revision-a' },
        controllerDaemon: { releaseRevision: 'revision-a' },
        gatewayHost: { releaseRevision: 'revision-a' },
      },
    }, 'revision-a', drifted)).toBe(false);
  });

  test('activation rollback prefers the proven running release over stale current and previous service metadata', () => {
    const selected = selectSupervisorRollbackRelease({
      running: { releasePath: '/tmp/releases/running', releaseRevision: 'running-revision' },
      installed: { releasePath: '/tmp/releases/installed', releaseRevision: 'installed-revision' },
      current: { releasePath: '/tmp/releases/current', releaseRevision: 'current-revision' },
    });
    expect(selected).toEqual({ releasePath: '/tmp/releases/running', releaseRevision: 'running-revision' });
  });

  test('release coherence requires exact path, revision, generation, and active slot agreement', () => {
    const releasePath = '/tmp/releases/revision-a';
    const daemon = { ...managedProcess('green', 501, 'generation-a'), releasePath, releaseRevision: 'revision-a' };
    const gateway = { ...managedProcess('green', 502, 'generation-a'), releasePath, releaseRevision: 'revision-a' };
    const state = {
      schemaVersion: 1,
      supervisor: {
        pid: 500,
        instanceId: 'supervisor-500',
        processStartTime: 'start-500',
        executableFingerprint: 'fingerprint-500',
        controllerHome: '/tmp/controller-home',
        ownerEpoch: 1,
        epoch: 1,
        startedAt: '2026-07-21T00:00:00.000Z',
        releasePath,
        releaseRevision: 'revision-a',
      },
      desiredState: 'running',
      observedState: 'healthy',
      activeSlot: 'green',
      activeGeneration: 'generation-a',
      controllerDaemon: daemon,
      gatewayHost: gateway,
      ingress: { state: 'running', activeUpstreamSlot: 'green' },
      restartBudget: {},
      updatedAt: '2026-07-21T00:00:00.000Z',
    } as SupervisorState;
    const authority = { schemaVersion: 1, activeSlot: 'green', generation: 'generation-a', reason: 'test', updatedAt: '2026-07-21T00:00:00.000Z' } as any;
    const identity = {
      schemaVersion: 1,
      slot: 'green',
      role: 'active',
      controllerHome: '/tmp/controller-home',
      slotHome: '/tmp/controller-home/runtime-slots/green',
      mcpPort: 8795,
      localControllerPort: 8776,
      generation: 'generation-a',
      releasePath,
      releaseRevision: 'revision-a',
      startedAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
      logDir: '/tmp/logs',
    } as any;

    const coherent = evaluateRuntimeReleaseCoherence({ supervisorState: state, authority, slotIdentity: identity });
    expect(coherent.ok).toBe(true);
    expect(coherent.releaseCoherent).toBe(true);
    expect(coherent.generationCoherent).toBe(true);

    const mismatched = evaluateRuntimeReleaseCoherence({
      supervisorState: state,
      authority,
      slotIdentity: { ...identity, releasePath: '/tmp/releases/revision-b' },
    });
    expect(mismatched.ok).toBe(false);
    expect(mismatched.releasePathCoherent).toBe(false);
    expect(mismatched.failures.join('; ')).toContain('release path mismatch');
  });

  test('activation state waits for the matching terminal release instead of treating scheduling as success', async () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-activation-state-'));
    try {
      const statePath = serviceActivationStatePath(home);
      mkdirSync(join(home, 'supervisor'), { recursive: true });
      writeFileSync(statePath, `${JSON.stringify({
        schemaVersion: 1,
        activationId: 'activation-a',
        phase: 'succeeded',
        repoRoot: '/tmp/repo',
        releaseRevision: 'revision-a',
        releasePath: '/tmp/releases/revision-a',
        updatedAt: '2026-07-21T00:00:00.000Z',
      })}\n`);
      const state = await waitForServiceActivation({
        home,
        activationId: 'activation-a',
        expectedReleaseRevision: 'revision-a',
        timeoutMs: 1_000,
        intervalMs: 10,
      });
      expect(state.phase).toBe('succeeded');
      await expect(waitForServiceActivation({
        home,
        activationId: 'activation-a',
        expectedReleaseRevision: 'revision-b',
        timeoutMs: 1_000,
        intervalMs: 10,
      })).rejects.toThrow('SUPERVISOR_ACTIVATION_RELEASE_MISMATCH');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('launchd bootstrap retries bounded macOS error 5', async () => {
    const calls: string[][] = [];
    let bootstrapAttempts = 0;
    const mockResult = (ok: boolean, stderr = '', stdout = '') => ({ ok, stdout, stderr, exitCode: ok ? 0 : 5 });
    const attempts = await bootstrapLaunchAgentWithRetry({
      label: 'com.example.supervisor',
      plistPath: '/Users/example/Library/LaunchAgents/com.example.supervisor.plist',
      domain: 'gui/501',
      retryDelayMs: 0,
    }, {
      run: (args) => {
        calls.push(args);
        if (args[0] === 'enable') return mockResult(true);
        if (args[0] === 'bootout') return mockResult(false, 'Could not find service');
        if (args[0] === 'bootstrap') {
          bootstrapAttempts += 1;
          if (bootstrapAttempts < 3) return mockResult(false, 'Bootstrap failed: 5: Input/output error');
        }
        return mockResult(true);
      },
      wait: async () => undefined,
    });
    expect(attempts).toBeGreaterThanOrEqual(1);
    expect(calls.filter((args) => args[0] === 'bootstrap').length).toBeGreaterThanOrEqual(1);
  });

  test('Gateway hosts bind private slot backends and never own the public tunnel', () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-supervisor-routing-'));
    writeActiveSlotAuthority(home, { activeSlot: 'blue', reason: 'test' });
    writeMcpServiceLocalConfig(home, {
      version: 1,
      profile: 'controller',
      toolset: 'core',
      auth: { mode: 'bearer' },
      server: { host: '127.0.0.1', port: 8765 },
      localController: { enabled: true, host: '127.0.0.1', port: 8766, autoOpen: false },
      chatgpt: { endpoint: 'https://stable.example.test/mcp' },
    });
    const manager = new SupervisorProcessManager({
      repoRoot: process.cwd(),
      controllerHome: home,
      runtimeSourceRoot: process.cwd(),
      ownerEpoch: 1,
      logPath: join(home, 'supervisor.log'),
    });
    const args = manager.gatewayArgs(home);
    expect(args[args.indexOf('--port') + 1]).toBe('8785');
    expect(args[args.indexOf('--tunnel') + 1]).toBe('none');
    expect(manager.localControllerBinding('blue').port).toBe(8786);
    expect(manager.localControllerBinding('green').port).toBe(8796);
    expect(manager.localControllerBinding('blue').port).not.toBe(8766);
  });

  test('candidate slot preflight stops only same-slot older-epoch daemon orphans', async () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-supervisor-stale-slot-'));
    const slotHome = join(home, 'runtime-slots', 'blue');
    const daemon = join(home, 'supervisor', 'releases', 'old', 'daemon.js');
    mkdirSync(join(home, 'supervisor', 'releases', 'old'), { recursive: true });
    writeActiveSlotAuthority(home, { activeSlot: 'green', reason: 'test' });
    const commands = new Map<number, { command: string; startTime: string }>([
      [60001, {
        command: `${process.execPath} ${daemon} --controller-home ${slotHome} --runtime-source-root ${process.cwd()} --owner-epoch 7 --instance-id daemon-old --slot blue`,
        startTime: 'Tue Jul 28 01:00:00 2026',
      }],
      [60002, {
        command: `${process.execPath} ${daemon} --controller-home ${join(home, 'runtime-slots', 'blue-sibling')} --runtime-source-root ${process.cwd()} --owner-epoch 7 --instance-id daemon-sibling --slot blue`,
        startTime: 'Tue Jul 28 01:01:00 2026',
      }],
      [60003, {
        command: `${process.execPath} ${daemon} --controller-home ${slotHome} --runtime-source-root ${process.cwd()} --owner-epoch 9 --instance-id daemon-current --slot blue`,
        startTime: 'Tue Jul 28 01:02:00 2026',
      }],
      [60004, {
        command: `${process.execPath} ${join(home, 'not-daemon.js')} --controller-home ${slotHome} --owner-epoch 7 --instance-id suspicious --slot blue`,
        startTime: 'Tue Jul 28 01:03:00 2026',
      }],
    ]);
    const probe: ProcessIdentityProbe = {
      isAlive: (pid) => commands.has(pid),
      command: (pid) => commands.get(pid)?.command,
      startTime: (pid) => commands.get(pid)?.startTime,
      listProcesses: () => Array.from(commands.entries()).map(([pid, entry]) => ({ pid, command: entry.command })),
    };
    const manager = new SupervisorProcessManager({
      repoRoot: process.cwd(),
      controllerHome: home,
      runtimeSourceRoot: process.cwd(),
      ownerEpoch: 9,
      logPath: join(home, 'supervisor.log'),
      slot: 'blue',
      identityProbe: probe,
    });

    const result = await manager.cleanupStaleSlotDaemons('blue', {
      reason: 'test_candidate_slot_preflight_cleanup',
      operationId: 'test-op',
    });

    expect(result.matched).toBe(3);
    expect(result.stopped).toBe(1);
    expect(result.refused).toBe(1);
    expect(result.failed).toBe(0);
    const stopEvents = readFileSync(supervisorProcessStopAuditPath(join(home, 'supervisor.log')), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(stopEvents.some((event) => event.phase === 'requested' && event.pid === 60001 && event.reason === 'test_candidate_slot_preflight_cleanup')).toBe(true);
    expect(stopEvents.some((event) => event.phase === 'completed' && event.pid === 60001 && event.stopped === true)).toBe(true);
    expect(stopEvents.some((event) => event.phase === 'requested' && event.pid === 60002)).toBe(false);
    expect(stopEvents.some((event) => event.phase === 'requested' && event.pid === 60003)).toBe(false);
    expect(stopEvents.some((event) => event.phase === 'refused' && event.pid === 60004 && event.error === 'SUPERVISOR_STALE_SLOT_DAEMON_COMMAND_MISMATCH')).toBe(true);
  });

  test('a new failure resets the stable recovery window', () => {
    const started = new Date('2026-07-17T00:00:00.000Z');
    const stable = recordStable(newRestartBudgetRecord('controllerDaemon', 'generation-a', started), started);
    const failed = recordFailure(stable, 'process exited', new Date(started.getTime() + 1_000));
    expect(failed.stableSinceAt).toBeUndefined();
  });

  test('restart backoff is temporary and does not become persistent lockout', () => {
    const now = new Date('2026-07-17T00:00:00.000Z');
    const first = recordRestart(newRestartBudgetRecord('gatewayHost', 'generation-a', now), now);
    const decision = decideRestart(first, new Date(now.getTime() + 100), undefined, 0.5);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('backoff');
    expect(first.lockedOut).toBe(false);
    expect(automaticRecoveryRequestId('gatewayHost', 'generation-a', first))
      .not.toBe(automaticRecoveryRequestId('gatewayHost', 'generation-a', { ...first, attempts: first.attempts + 1 }));
  });

  test('restart reconciliation follows active-slot authority after a pre-cutover crash', () => {
    const blueDaemon = managedProcess('blue', 101, 'generation-blue');
    const blueGateway = managedProcess('blue', 102, 'generation-blue');
    const greenDaemon = managedProcess('green', 201, 'generation-green');
    const greenGateway = managedProcess('green', 202, 'generation-green');
    const state: SupervisorState = {
      schemaVersion: 1,
      supervisor: {
        pid: 1,
        instanceId: 'supervisor',
        processStartTime: 'start',
        executableFingerprint: 'fingerprint',
        controllerHome: '/tmp/controller-home',
        ownerEpoch: 1,
        epoch: 1,
        startedAt: '2026-07-17T00:00:00.000Z',
      },
      desiredState: 'running',
      observedState: 'degraded',
      activeSlot: 'green',
      previousSlot: 'blue',
      activeGeneration: 'generation-green',
      controllerDaemon: greenDaemon,
      gatewayHost: greenGateway,
      standby: { slot: 'blue', generation: 'generation-blue', controllerDaemon: blueDaemon, gatewayHost: blueGateway },
      ingress: { state: 'running', activeUpstreamSlot: 'green', activeUpstreamPort: 8795 },
      restartBudget: {},
      currentOperationId: 'rollout-operation',
      lastIncident: null,
      updatedAt: '2026-07-17T00:00:00.000Z',
    };
    const reconciled = reconcileSupervisorStateWithAuthority(state, {
      schemaVersion: 1,
      activeSlot: 'blue',
      updatedAt: '2026-07-17T00:00:01.000Z',
      reason: 'cutover-not-committed',
    });
    expect(reconciled.activeSlot).toBe('blue');
    expect(reconciled.controllerDaemon?.pid).toBe(101);
    expect(reconciled.gatewayHost?.pid).toBe(102);
    expect(reconciled.standby?.slot).toBe('green');
    expect(reconciled.ingress.activeUpstreamSlot).toBe('blue');
  });

  test('a committed rollout authority is resumable after Supervisor restart without blind replay', () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-supervisor-rollout-resume-'));
    try {
      const candidateRelease = fakeSupervisorRelease(home, 'candidate-resume', 'revision-resume');
      const blueDaemon = managedProcess('blue', 101, 'generation-blue');
      const blueGateway = managedProcess('blue', 102, 'generation-blue');
      const greenDaemon = { ...managedProcess('green', 201, 'generation-green'), releasePath: candidateRelease, releaseRevision: 'revision-resume' };
      const greenGateway = { ...managedProcess('green', 202, 'generation-green'), releasePath: candidateRelease, releaseRevision: 'revision-resume' };
      const created = createSupervisorOperation({
        controllerHome: home,
        repoRoot: process.cwd(),
        requestId: 'interrupted-rollout-resume',
        kind: 'rollout',
        requestedBy: 'test',
        actor: 'test',
        candidateReleasePath: candidateRelease,
      });
      updateSupervisorOperation(home, created.operation.operationId, {
        phase: 'switching_ingress',
        result: {
          rolloutCheckpoint: {
            stage: 'authority_committed',
            candidateSlot: 'green',
            previousSlot: 'blue',
            candidateReleasePath: candidateRelease,
            candidateGeneration: 'generation-green',
            previousGeneration: 'generation-blue',
            expectedReleaseRevision: 'revision-resume',
            recordedAt: new Date().toISOString(),
          },
        },
      });
      const state: SupervisorState = {
        schemaVersion: 1,
        supervisor: {
          pid: 1,
          instanceId: 'supervisor',
          processStartTime: 'start',
          executableFingerprint: 'fingerprint',
          controllerHome: home,
          ownerEpoch: 1,
          epoch: 1,
          startedAt: new Date().toISOString(),
        },
        desiredState: 'running',
        observedState: 'degraded',
        activeSlot: 'green',
        previousSlot: 'blue',
        activeGeneration: 'generation-green',
        controllerDaemon: greenDaemon,
        gatewayHost: greenGateway,
        standby: { slot: 'blue', generation: 'generation-blue', controllerDaemon: blueDaemon, gatewayHost: blueGateway },
        ingress: { state: 'running', activeUpstreamSlot: 'green', activeUpstreamPort: 8795 },
        restartBudget: {},
        currentOperationId: created.operation.operationId,
        lastIncident: null,
        updatedAt: new Date().toISOString(),
      };
      const authority = {
        schemaVersion: 1 as const,
        activeSlot: 'green' as const,
        previousSlot: 'blue' as const,
        generation: 'generation-green',
        updatedAt: new Date().toISOString(),
        reason: 'rollout-cutover',
      };
      const recovery = resumableInterruptedRollout(state, authority, [readSupervisorOperation(home, created.operation.operationId)!]);
      expect(recovery).toEqual({
        operationId: created.operation.operationId,
        releasePath: candidateRelease,
        candidateSlot: 'green',
        candidateGeneration: 'generation-green',
      });
      expect(terminalizeInterruptedSupervisorOperations(home, new Set([created.operation.operationId]))).toBe(0);
      expect(readSupervisorOperation(home, created.operation.operationId)?.phase).toBe('switching_ingress');
      expect(resumableInterruptedRollout(state, { ...authority, activeSlot: 'blue' }, [readSupervisorOperation(home, created.operation.operationId)!])).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('automatic component recovery is suppressed while an operation owns the Supervisor writer slot', () => {
    expect(supervisorOperationRecoverySuppressed('sup-op-active')).toBe(true);
    expect(supervisorOperationRecoverySuppressed(null)).toBe(false);
    expect(supervisorOperationRecoverySuppressed(undefined)).toBe(false);
  });

  test('cutover sampling defers Gateway probes until processes and Daemon are ready', async () => {
    let daemonReads = 0;
    let gatewayProbes = 0;
    let daemonGenerationReads = 0;
    let gatewayGenerationReads = 0;
    const sample = async (daemonAlive: boolean, gatewayAlive: boolean, status: string) => await sampleCutoverReadiness({
      daemonAlive,
      gatewayAlive,
      readDaemon: () => {
        daemonReads += 1;
        return { status };
      },
      probeGateway: async () => {
        gatewayProbes += 1;
        return { healthy: true, ready: true, detail: 'ready' };
      },
      readDaemonGeneration: () => {
        daemonGenerationReads += 1;
        return 'generation-green';
      },
      readGatewayGeneration: () => {
        gatewayGenerationReads += 1;
        return 'generation-green';
      },
    });

    expect((await sample(false, true, 'ready')).daemon.status).toBe('unavailable');
    expect(daemonReads).toBe(0);
    expect(gatewayProbes).toBe(0);

    expect((await sample(true, true, 'starting')).daemon.status).toBe('starting');
    expect(daemonReads).toBe(1);
    expect(gatewayProbes).toBe(0);

    const ready = await sample(true, true, 'ready');
    expect(ready.gateway.ready).toBe(true);
    expect(ready.daemonGeneration).toBe('generation-green');
    expect(ready.gatewayGeneration).toBe('generation-green');
    expect(gatewayProbes).toBe(1);
    expect(daemonGenerationReads).toBe(1);
    expect(gatewayGenerationReads).toBe(1);
  });

  test('cutover readiness retries transient startup states and requires a stable window', async () => {
    let now = 0;
    let samples = 0;
    const sequence = [
      { daemon: { status: 'starting' }, gateway: { healthy: false, detail: 'connection refused' } },
      { daemon: { status: 'ready' }, gateway: { healthy: true, ready: false, detail: 'gateway is live but temporarily not ready' } },
      { daemon: { status: 'ready' }, gateway: { healthy: true, ready: true, detail: 'ready' } },
      { daemon: { status: 'ready' }, gateway: { healthy: true, ready: true, detail: 'ready' } },
      { daemon: { status: 'ready' }, gateway: { healthy: true, ready: true, detail: 'ready' } },
    ];
    await observeCutoverReadinessWindow({
      expectedGeneration: 'generation-green',
      timeoutMs: 2_000,
      intervalMs: 250,
      stabilityMs: 500,
      now: () => now,
      wait: async (ms) => { now += ms; },
      sample: () => {
        const state = sequence[Math.min(samples, sequence.length - 1)];
        samples += 1;
        return {
          daemonAlive: true,
          gatewayAlive: true,
          daemon: state.daemon,
          gateway: state.gateway,
          daemonGeneration: 'generation-green',
          gatewayGeneration: 'generation-green',
        };
      },
    });
    expect(samples).toBe(5);
  });

  test('cutover readiness fails immediately on process death or generation mismatch', async () => {
    await expect(observeCutoverReadinessWindow({
      expectedGeneration: 'generation-green',
      timeoutMs: 5_000,
      sample: () => ({
        daemonAlive: false,
        gatewayAlive: true,
        daemon: { status: 'ready' },
        gateway: { healthy: true, ready: true, detail: 'ready' },
        daemonGeneration: 'generation-green',
        gatewayGeneration: 'generation-green',
      }),
    })).rejects.toThrow('SUPERVISOR_CUTOVER_DAEMON_LIVENESS_FAILED');

    await expect(observeCutoverReadinessWindow({
      expectedGeneration: 'generation-green',
      timeoutMs: 5_000,
      sample: () => ({
        daemonAlive: true,
        gatewayAlive: true,
        daemon: { status: 'ready' },
        gateway: { healthy: true, ready: true, detail: 'ready' },
        daemonGeneration: 'generation-blue',
        gatewayGeneration: 'generation-green',
      }),
    })).rejects.toThrow(/SUPERVISOR_CUTOVER_GENERATION_MISMATCH/);
  });

  test('cutover readiness timeout preserves the latest transient failure reason', async () => {
    let now = 0;
    await expect(observeCutoverReadinessWindow({
      timeoutMs: 1_000,
      intervalMs: 250,
      now: () => now,
      wait: async (ms) => { now += ms; },
      sample: () => ({
        daemonAlive: true,
        gatewayAlive: true,
        daemon: { status: 'ready' },
        gateway: { healthy: true, ready: false, detail: 'gateway is live but temporarily not ready' },
      }),
    })).rejects.toThrow(/SUPERVISOR_CUTOVER_GATEWAY_READINESS_FAILED: gateway is live but temporarily not ready/);
  });

  test('cutover observation refreshes a recoverable candidate exactly once', async () => {
    let observations = 0;
    let recoveries = 0;
    const result = await observeCutoverCandidateWithSingleRecovery(
      'candidate-v1',
      async (candidate) => {
        observations += 1;
        if (candidate === 'candidate-v1') {
          throw new Error('SUPERVISOR_CUTOVER_DAEMON_READINESS_FAILED: status=stopped');
        }
      },
      async (candidate, firstFailure) => {
        recoveries += 1;
        expect(candidate).toBe('candidate-v1');
        expect(firstFailure).toContain('status=stopped');
        return 'candidate-v2';
      },
    );
    expect(result).toEqual({
      candidate: 'candidate-v2',
      recovered: true,
      firstFailure: 'SUPERVISOR_CUTOVER_DAEMON_READINESS_FAILED: status=stopped',
    });
    expect(observations).toBe(2);
    expect(recoveries).toBe(1);
    expect(recoverableCutoverObservationFailure(new Error('SUPERVISOR_CUTOVER_GENERATION_MISMATCH'))).toBe(false);
  });

  test('cutover observation fails closed after the single recovery is exhausted', async () => {
    let recoveries = 0;
    await expect(observeCutoverCandidateWithSingleRecovery(
      'candidate-v1',
      async (candidate) => {
        throw new Error(`SUPERVISOR_CUTOVER_GATEWAY_READINESS_FAILED: ${candidate}`);
      },
      async () => {
        recoveries += 1;
        return 'candidate-v2';
      },
    )).rejects.toThrow(/SUPERVISOR_CUTOVER_RECOVERY_EXHAUSTED: initial=.*candidate-v1; second=.*candidate-v2/);
    expect(recoveries).toBe(1);
  });

  test('writer-claim activation retries one transient readiness failure', async () => {
    let attempts = 0;
    const result = await refreshWriterClaimWithSingleRetry(
      'candidate-v1',
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('SUPERVISOR_CONTROLLERDAEMON_READINESS_TIMEOUT');
        return 'candidate-v2';
      },
    );
    expect(result).toEqual({
      candidate: 'candidate-v2',
      retried: true,
      firstFailure: 'SUPERVISOR_CONTROLLERDAEMON_READINESS_TIMEOUT',
    });
    expect(attempts).toBe(2);
    expect(recoverableWriterClaimRefreshFailure(new Error('SUPERVISOR_ACTIVATED_MCP_READINESS_FAILED: unavailable'))).toBe(true);
  });

  test('writer-claim activation never retries identity mismatches and exhausts after one retry', async () => {
    let identityAttempts = 0;
    await expect(refreshWriterClaimWithSingleRetry('candidate', async () => {
      identityAttempts += 1;
      throw new Error('SUPERVISOR_ACTIVATED_GENERATION_MISMATCH');
    })).rejects.toThrow('SUPERVISOR_ACTIVATED_GENERATION_MISMATCH');
    expect(identityAttempts).toBe(1);

    let transientAttempts = 0;
    await expect(refreshWriterClaimWithSingleRetry('candidate', async () => {
      transientAttempts += 1;
      throw new Error(`SUPERVISOR_GATEWAYHOST_PROCESS_DIED: attempt=${transientAttempts}`);
    })).rejects.toThrow(/SUPERVISOR_WRITER_REFRESH_RETRY_EXHAUSTED: initial=.*attempt=1; second=.*attempt=2/);
    expect(transientAttempts).toBe(2);
  });

  test('rollout and rollback failures retain both causal errors', () => {
    const combined = combinedRolloutRollbackFailure(
      new Error('SUPERVISOR_CUTOVER_GATEWAY_READINESS_FAILED: candidate'),
      new Error('SUPERVISOR_CONTROLLERDAEMON_READINESS_TIMEOUT'),
    );
    expect(combined.message).toContain('primary=SUPERVISOR_CUTOVER_GATEWAY_READINESS_FAILED: candidate');
    expect(combined.message).toContain('rollback=SUPERVISOR_CONTROLLERDAEMON_READINESS_TIMEOUT');
  });

  test('published Controller Home release authority outranks the boot release for managed runtime recovery', () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-supervisor-release-authority-'));
    try {
      const bootRelease = fakeSupervisorRelease(home, 'boot-release', 'revision-boot');
      const publishedRelease = fakeSupervisorRelease(home, 'published-release', 'revision-published');
      publishSupervisorRelease({ controllerHome: home, repoRoot: process.cwd(), releasePath: publishedRelease });
      const runtime = new StableSupervisorRuntime({
        repoRoot: process.cwd(),
        controllerHome: home,
        runtimeSourceRoot: process.cwd(),
        ownerEpoch: 1,
        releasePath: bootRelease,
        releaseRevision: 'revision-boot',
        logPath: join(home, 'supervisor.log'),
      });
      const expected = (runtime as unknown as { expectedManagedRelease: () => { releasePath: string; releaseRevision?: string } | undefined }).expectedManagedRelease();
      expect(expected?.releasePath).toBe(publishedRelease);
      expect(expected?.releaseRevision).toBe('revision-published');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('active generation advances only when daemon and Gateway observations agree', () => {
    const daemon = managedProcess('blue', 201, 'generation-old');
    const gateway = managedProcess('blue', 202, 'generation-old');
    const state: SupervisorState = {
      schemaVersion: 1,
      supervisor: {
        pid: 200,
        instanceId: 'supervisor-generation',
        processStartTime: 'start',
        executableFingerprint: 'fingerprint',
        controllerHome: '/tmp/controller-home',
        ownerEpoch: 1,
        epoch: 1,
        startedAt: '2026-07-17T00:00:00.000Z',
      },
      desiredState: 'running',
      observedState: 'healthy',
      activeSlot: 'blue',
      activeGeneration: 'generation-old',
      controllerDaemon: daemon,
      gatewayHost: gateway,
      ingress: { state: 'running', activeUpstreamSlot: 'blue', activeUpstreamPort: 8785 },
      restartBudget: {},
      currentOperationId: null,
      lastIncident: null,
      updatedAt: '2026-07-17T00:00:00.000Z',
    };
    const split = reconcileActiveManagedGenerations(state, {
      controllerDaemon: 'generation-new',
      gatewayHost: 'generation-old',
    });
    expect(split.coherent).toBe(false);
    expect(split.state.controllerDaemon?.generation).toBe('generation-new');
    expect(split.state.gatewayHost?.generation).toBe('generation-old');
    expect(split.state.activeGeneration).toBe('generation-old');

    const synchronized = reconcileActiveManagedGenerations(split.state, {
      controllerDaemon: 'generation-new',
      gatewayHost: 'generation-new',
    });
    expect(synchronized.coherent).toBe(true);
    expect(synchronized.generation).toBe('generation-new');
    expect(synchronized.state.controllerDaemon?.generation).toBe('generation-new');
    expect(synchronized.state.gatewayHost?.generation).toBe('generation-new');
    expect(synchronized.state.activeGeneration).toBe('generation-new');
  });

  test('rollout operation persists only controller-owned staged release paths', () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-supervisor-candidate-release-'));
    try {
      const candidate = join(supervisorReleasesRoot(home), 'candidate-release');
      mkdirSync(candidate, { recursive: true });
      const created = createSupervisorOperation({
        controllerHome: home,
        repoRoot: process.cwd(),
        requestId: 'candidate-release-1',
        kind: 'rollout',
        requestedBy: 'test',
        actor: 'test',
        candidateReleasePath: candidate,
      });
      expect(created.operation.candidateReleasePath).toBe(candidate);
      expect(readSupervisorOperation(home, created.operation.operationId)?.candidateReleasePath).toBe(candidate);
      expect(() => createSupervisorOperation({
        controllerHome: home,
        repoRoot: process.cwd(),
        requestId: 'candidate-release-outside',
        kind: 'rollout',
        requestedBy: 'test',
        actor: 'test',
        candidateReleasePath: join(tmpdir(), 'outside-release'),
      })).toThrow('SUPERVISOR_RELEASE_PATH_OUTSIDE_CONTROLLER_HOME');
      expect(() => createSupervisorOperation({
        controllerHome: home,
        repoRoot: process.cwd(),
        requestId: 'candidate-release-wrong-kind',
        kind: 'restart_full',
        requestedBy: 'test',
        actor: 'test',
        candidateReleasePath: candidate,
      })).toThrow('SUPERVISOR_RELEASE_PATH_ONLY_VALID_FOR_ROLLOUT');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('rollout scheduling remains nonterminal until the replacement Supervisor verifies activation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-supervisor-activation-operation-'));
    try {
      const runtime = new StableSupervisorRuntime({
        repoRoot: process.cwd(),
        controllerHome: home,
        runtimeSourceRoot: process.cwd(),
        ownerEpoch: 1,
        logPath: join(home, 'supervisor.log'),
      });
      const created = createSupervisorOperation({
        controllerHome: home,
        repoRoot: process.cwd(),
        requestId: 'rollout-activation-1',
        kind: 'rollout',
        requestedBy: 'test',
        actor: 'test',
      });
      const internal = runtime as unknown as {
        executeOperation: (operation: SupervisorOperation) => Promise<void>;
        rollout: (operation: SupervisorOperation) => Promise<{
          publication: {
            controllerHome: string;
            releaseRevision: string;
            releasePath: string;
            currentPath: string;
            launchdPlistPath: string;
            systemdUnitPath: string;
          };
          activation: {
            activationId: string;
            pid: number;
            statePath: string;
            logPath: string;
            expectedReleaseRevision: string;
          };
        }>;
        synchronizeActiveRuntimeGeneration: () => string;
      };
      internal.rollout = async () => ({
        publication: {
          controllerHome: home,
          releaseRevision: 'revision-v2',
          releasePath: join(home, 'releases', 'revision-v2'),
          currentPath: join(home, 'current'),
          launchdPlistPath: join(home, 'supervisor.plist'),
          systemdUnitPath: join(home, 'supervisor.service'),
        },
        activation: {
          activationId: 'activation-v2',
          pid: 123,
          statePath: serviceActivationStatePath(home),
          logPath: join(home, 'activation.log'),
          expectedReleaseRevision: 'revision-v2',
        },
      });
      internal.synchronizeActiveRuntimeGeneration = () => 'generation-v2';

      await internal.executeOperation(created.operation);
      const pending = readSupervisorOperation(home, created.operation.operationId);
      expect(pending?.phase).toBe('cutover');
      expect(pending?.completedAt).toBeUndefined();
      expect(terminalizeInterruptedSupervisorOperations(home)).toBe(0);
      expect(readSupervisorOperation(home, created.operation.operationId)?.phase).toBe('cutover');

      mkdirSync(join(home, 'supervisor'), { recursive: true });
      writeFileSync(serviceActivationStatePath(home), `${JSON.stringify({
        schemaVersion: 1,
        activationId: 'activation-v2',
        phase: 'succeeded',
        repoRoot: process.cwd(),
        releaseRevision: 'revision-v2',
        releasePath: join(home, 'releases', 'revision-v2'),
        updatedAt: new Date().toISOString(),
      })}\n`);
      expect(reconcilePendingSupervisorActivations(home)).toBe(1);
      expect(readSupervisorOperation(home, created.operation.operationId)?.phase).toBe('succeeded');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('interrupted mutations become explicit failures instead of blind replay', () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-supervisor-operation-'));
    const created = createSupervisorOperation({
      controllerHome: home,
      repoRoot: process.cwd(),
      requestId: 'interrupted-1',
      kind: 'restart_full',
      requestedBy: 'test',
      actor: 'test',
    });
    updateSupervisorOperation(home, created.operation.operationId, { phase: 'stopping', startedAt: new Date().toISOString() });
    expect(terminalizeInterruptedSupervisorOperations(home)).toBe(1);
    const operation = readSupervisorOperation(home, created.operation.operationId);
    expect(operation?.phase).toBe('failed');
    expect(operation?.error).toBe('SUPERVISOR_RESTART_INTERRUPTED_OPERATION');
  });
});
