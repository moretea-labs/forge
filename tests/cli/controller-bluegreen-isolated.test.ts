import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join, relative, sep } from 'path';
import { spawnSync } from 'child_process';
import {
  allocateFreePort,
  createIsolatedControllerFixture,
  destroyAllIsolatedControllerFixtures,
  isolatedControllerEnv,
} from '../fixtures/isolated-controller-home';
import {
  ensureSlotHome,
  readActiveSlotAuthority,
  readSlotIdentity,
  writeActiveSlotAuthority,
  writeSlotIdentity,
} from '../../src/cli/controller/runtime-slots';
import { loadMcpServiceLocalConfig, writeMcpServiceLocalConfig } from '../../src/cli/mcp/auth';
import {
  controllerServiceStatus,
  startControllerService,
  stopControllerService,
} from '../../src/cli/controller/lifecycle';
import { controllerRollback, controllerRollout, startInactiveSlot } from '../../src/cli/controller/bluegreen-rollout';
import { findProcessesByCommand } from '../runtime/process-hygiene';
import { installSupervisorRelease } from '../../src/runtime/supervisor/installer';
import { readCurrentRelease } from '../../src/runtime/supervisor/paths';

const ROOT = join(import.meta.dir, '../..');
const cleanRuntimeSources: string[] = [];

afterEach(async () => {
  for (const path of cleanRuntimeSources.splice(0)) rmSync(path, { recursive: true, force: true });
  await destroyAllIsolatedControllerFixtures();
}, 120_000);

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function createCleanRuntimeSourceRoot(name: string): string {
  const path = join(ROOT, '_ops', `test-runtime-source-${name}-${Date.now()}`);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  const excluded = new Set(['.git', '.codegraph', '.repo-harness', '_ops', 'node_modules']);
  for (const entry of readdirSync(ROOT)) {
    if (excluded.has(entry)) continue;
    cpSync(join(ROOT, entry), join(path, entry), {
      recursive: true,
      filter: (source) => {
        const rel = relative(ROOT, source);
        if (!rel) return true;
        const top = rel.split(sep)[0];
        return !excluded.has(top);
      },
    });
  }
  git(path, ['init']);
  git(path, ['config', 'user.email', 'bluegreen-test@example.invalid']);
  git(path, ['config', 'user.name', 'Bluegreen Test']);
  git(path, ['add', '.']);
  git(path, ['commit', '-m', 'clean runtime source snapshot']);
  cleanRuntimeSources.push(path);
  return path;
}

function seedSlotConfig(
  slotHome: string,
  ports: { mcpPort: number; localControllerPort: number },
): void {
  writeMcpServiceLocalConfig(slotHome, {
    version: 1,
    profile: 'controller',
    auth: { mode: 'bearer' },
    server: { host: '127.0.0.1', port: ports.mcpPort },
    localController: {
      enabled: true,
      host: '127.0.0.1',
      port: ports.localControllerPort,
      autoOpen: false,
    },
    devMode: {
      agentRunner: true,
      allowedAgents: ['codex'],
      timeoutMs: 3_600_000,
      maxTimeoutMs: 43_200_000,
    },
  });
}

describe('blue/green isolated lifecycle (level 2)', () => {
  test('inactive slot failure leaves active authority and processes untouched', async () => {
    const fixture = await createIsolatedControllerFixture();
    const previousHome = process.env.REPO_HARNESS_CONTROLLER_HOME;
    const previousSource = process.env.REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT;
    const previousOwner = process.env.REPO_HARNESS_CONTROLLER_LIFECYCLE_OWNER;
    Object.assign(process.env, isolatedControllerEnv(fixture, {
      REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT: ROOT,
    }));

    try {
      writeActiveSlotAuthority(fixture.controllerHome, { activeSlot: 'blue', reason: 'test' });
      const blueHome = ensureSlotHome(fixture.controllerHome, 'blue');
      seedSlotConfig(blueHome, {
        mcpPort: fixture.mcpPort,
        localControllerPort: fixture.localControllerPort,
      });

      const started = await startControllerService({
        repo: fixture.repoRoot,
        controllerHome: blueHome,
        startTimeoutMs: 45_000,
        logFile: join(blueHome, 'logs', 'controller.log'),
      });
      expect(started.status.running || started.status.ready).toBe(true);
      const beforeAuthority = readActiveSlotAuthority(fixture.controllerHome);
      expect(beforeAuthority.activeSlot).toBe('blue');
      const bluePid = started.status.supervisor.pid;

      // Force green failure by allocating ports already held by blue (collision).
      const failed = await startInactiveSlot({
        repo: fixture.repoRoot,
        controllerHome: fixture.controllerHome,
        candidatePorts: {
          mcpPort: fixture.mcpPort,
          localControllerPort: fixture.localControllerPort,
        },
        startTimeoutMs: 8_000,
        skipDurableJob: true,
      });
      expect(failed.verification.ok).toBe(false);

      const afterAuthority = readActiveSlotAuthority(fixture.controllerHome);
      expect(afterAuthority.activeSlot).toBe('blue');
      const blueAfter = await controllerServiceStatus({
        repo: fixture.repoRoot,
        controllerHome: blueHome,
      });
      expect(blueAfter.supervisor.alive).toBe(true);
      if (bluePid) expect(blueAfter.supervisor.pid).toBe(bluePid);

      await stopControllerService({
        repo: fixture.repoRoot,
        controllerHome: blueHome,
        protectCallerAncestry: false,
        requireFullStop: false,
      });
    } finally {
      if (previousHome === undefined) delete process.env.REPO_HARNESS_CONTROLLER_HOME;
      else process.env.REPO_HARNESS_CONTROLLER_HOME = previousHome;
      if (previousSource === undefined) delete process.env.REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT;
      else process.env.REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT = previousSource;
      if (previousOwner === undefined) delete process.env.REPO_HARNESS_CONTROLLER_LIFECYCLE_OWNER;
      else process.env.REPO_HARNESS_CONTROLLER_LIFECYCLE_OWNER = previousOwner;
    }
  }, 120_000);

  test('candidate port binding is persisted before the candidate lifecycle starts', async () => {
    const fixture = await createIsolatedControllerFixture();
    const previousHome = process.env.REPO_HARNESS_CONTROLLER_HOME;
    const previousSource = process.env.REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT;
    const previousOwner = process.env.REPO_HARNESS_CONTROLLER_LIFECYCLE_OWNER;
    Object.assign(process.env, isolatedControllerEnv(fixture, {
      REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT: ROOT,
    }));

    const observedBinding: { current: ReturnType<typeof readSlotIdentity> } = { current: null };
    try {
      writeActiveSlotAuthority(fixture.controllerHome, { activeSlot: 'blue', reason: 'test' });
      writeMcpServiceLocalConfig(fixture.controllerHome, {
        version: 1,
        profile: 'controller',
        auth: { mode: 'bearer' },
        server: { host: '127.0.0.1', port: fixture.mcpPort },
        localController: {
          enabled: true,
          host: '127.0.0.1',
          port: fixture.localControllerPort,
          autoOpen: false,
        },
      });

      const failed = await startInactiveSlot({
        repo: fixture.repoRoot,
        controllerHome: fixture.controllerHome,
        candidatePorts: {
          mcpPort: fixture.greenMcpPort,
          localControllerPort: fixture.greenLocalPort,
        },
        skipDurableJob: true,
      }, {
        startControllerService: async () => {
          observedBinding.current = readSlotIdentity(fixture.controllerHome, 'green');
          throw new Error('intentional candidate start failure');
        },
        stopControllerService: async () => ({}),
      });

      expect(observedBinding.current).toMatchObject({
        slot: 'green',
        role: 'candidate',
        mcpPort: fixture.greenMcpPort,
        localControllerPort: fixture.greenLocalPort,
      });
      expect(observedBinding.current?.startedAt).toBeTruthy();
      expect(observedBinding.current?.resources?.[0]?.state).toBe('active');
      expect(readActiveSlotAuthority(fixture.controllerHome).activeSlot).toBe('blue');
      expect(failed.verification).toMatchObject({ ok: false, phase: 'green-start' });
      expect(failed.identity).toMatchObject({
        role: 'failed',
        mcpPort: fixture.greenMcpPort,
        localControllerPort: fixture.greenLocalPort,
        startedAt: observedBinding.current?.startedAt,
      });
      expect(failed.identity.resources?.[0]).toMatchObject({
        resourceId: observedBinding.current?.resources?.[0]?.resourceId,
        createdAt: observedBinding.current?.resources?.[0]?.createdAt,
        path: observedBinding.current?.resources?.[0]?.path,
        state: 'retained',
        retentionReason: 'candidate slot failed verification; retained for rollback diagnosis.',
      });
    } finally {
      if (previousHome === undefined) delete process.env.REPO_HARNESS_CONTROLLER_HOME;
      else process.env.REPO_HARNESS_CONTROLLER_HOME = previousHome;
      if (previousSource === undefined) delete process.env.REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT;
      else process.env.REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT = previousSource;
      if (previousOwner === undefined) delete process.env.REPO_HARNESS_CONTROLLER_LIFECYCLE_OWNER;
      else process.env.REPO_HARNESS_CONTROLLER_LIFECYCLE_OWNER = previousOwner;
    }
  }, 60_000);

  test('rollout cutover flips active slot and rollback restores previous', async () => {
    const fixture = await createIsolatedControllerFixture();
    const previousHome = process.env.REPO_HARNESS_CONTROLLER_HOME;
    const previousSource = process.env.REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT;
    Object.assign(process.env, isolatedControllerEnv(fixture, {
      REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT: ROOT,
    }));

    try {
      writeActiveSlotAuthority(fixture.controllerHome, { activeSlot: 'blue', reason: 'test' });
      const blueHome = ensureSlotHome(fixture.controllerHome, 'blue');
      seedSlotConfig(blueHome, {
        mcpPort: fixture.mcpPort,
        localControllerPort: fixture.localControllerPort,
      });
      // Also seed root config for rollout bootstrap.
      writeMcpServiceLocalConfig(fixture.controllerHome, {
        version: 1,
        profile: 'controller',
        auth: { mode: 'bearer' },
        server: { host: '127.0.0.1', port: fixture.mcpPort },
        localController: {
          enabled: true,
          host: '127.0.0.1',
          port: fixture.localControllerPort,
          autoOpen: false,
        },
        devMode: {
          agentRunner: true,
          allowedAgents: ['codex', 'claude'],
          timeoutMs: 3_600_000,
          maxTimeoutMs: 43_200_000,
        },
      });

      await startControllerService({
        repo: fixture.repoRoot,
        controllerHome: blueHome,
        startTimeoutMs: 45_000,
        logFile: join(blueHome, 'logs', 'controller.log'),
      });

      const rollout = await controllerRollout({
        repo: fixture.repoRoot,
        controllerHome: fixture.controllerHome,
        candidatePorts: {
          mcpPort: fixture.greenMcpPort,
          localControllerPort: fixture.greenLocalPort,
        },
        startTimeoutMs: 45_000,
        skipDurableJob: false,
      });
      if (rollout.status !== 'succeeded') {
        throw new Error(`rollout failed: ${rollout.phase} ${rollout.summary}\n${rollout.keyOutput}\n${JSON.stringify(rollout.details, null, 2)}`);
      }
      expect(rollout.status).toBe('succeeded');
      expect(readActiveSlotAuthority(fixture.controllerHome).activeSlot).toBe('green');
      expect(loadMcpServiceLocalConfig(ensureSlotHome(fixture.controllerHome, 'green'), fixture.repoRoot)?.devMode?.allowedAgents)
        .toEqual(['codex', 'claude']);

      const rollback = await controllerRollback({
        repo: fixture.repoRoot,
        controllerHome: fixture.controllerHome,
        skipDurableJob: true,
      });
      if (rollback.status !== 'succeeded') {
        throw new Error(`rollback failed: ${rollback.phase} ${rollback.summary}\n${rollback.keyOutput}\n${JSON.stringify(rollback.details, null, 2)}`);
      }
      expect(rollback.status).toBe('succeeded');
      expect(readActiveSlotAuthority(fixture.controllerHome).activeSlot).toBe('blue');

      // Cleanup both slots.
      for (const slot of ['blue', 'green'] as const) {
        const home = ensureSlotHome(fixture.controllerHome, slot);
        await stopControllerService({
          repo: fixture.repoRoot,
          controllerHome: home,
          protectCallerAncestry: false,
          requireFullStop: true,
        }).catch(() => undefined);
      }
    } finally {
      if (previousHome === undefined) delete process.env.REPO_HARNESS_CONTROLLER_HOME;
      else process.env.REPO_HARNESS_CONTROLLER_HOME = previousHome;
      if (previousSource === undefined) delete process.env.REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT;
      else process.env.REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT = previousSource;
    }
  }, 180_000);

  test('root Stable Supervisor owns staged rollout and rollback without a second global Supervisor', async () => {
    const fixture = await createIsolatedControllerFixture();
    const previousHome = process.env.REPO_HARNESS_CONTROLLER_HOME;
    const previousSource = process.env.REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT;
    const previousControlPort = process.env.REPO_HARNESS_SUPERVISOR_CONTROL_PORT;
    const controlPort = await allocateFreePort();
    const cleanSourceRoot = createCleanRuntimeSourceRoot('stable-rollout');
    Object.assign(process.env, isolatedControllerEnv(fixture, {
      REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT: cleanSourceRoot,
      REPO_HARNESS_SUPERVISOR_CONTROL_PORT: String(controlPort),
    }));

    try {
      writeActiveSlotAuthority(fixture.controllerHome, { activeSlot: 'blue', reason: 'test' });
      writeMcpServiceLocalConfig(fixture.controllerHome, {
        version: 1,
        profile: 'controller',
        auth: { mode: 'bearer' },
        server: { host: '127.0.0.1', port: fixture.mcpPort },
        localController: {
          enabled: true,
          host: '127.0.0.1',
          port: fixture.localControllerPort,
          autoOpen: false,
        },
        devMode: {
          agentRunner: true,
          allowedAgents: ['codex', 'claude'],
          timeoutMs: 3_600_000,
          maxTimeoutMs: 43_200_000,
        },
      });

      const initialRelease = installSupervisorRelease({
        controllerHome: fixture.controllerHome,
        repoRoot: fixture.repoRoot,
        sourceRoot: cleanSourceRoot,
      });
      const started = await startControllerService({
        repo: fixture.repoRoot,
        controllerHome: fixture.controllerHome,
        startTimeoutMs: 60_000,
      });
      expect(started.status.ready).toBe(true);
      // Simulate a stale active-slot policy left by an earlier rollout. The
      // root Controller Home remains authoritative for the candidate.
      seedSlotConfig(ensureSlotHome(fixture.controllerHome, 'blue'), {
        mcpPort: fixture.mcpPort,
        localControllerPort: fixture.localControllerPort,
      });
      const supervisorPid = started.status.supervisor.pid;
      if (!supervisorPid) throw new Error('isolated Stable Supervisor PID missing');
      expect(supervisorPid).toBeNumber();

      const rollout = await controllerRollout({
        repo: fixture.repoRoot,
        controllerHome: fixture.controllerHome,
        startTimeoutMs: 60_000,
        skipDurableJob: false,
        skipRestartDurability: true,
        wait: true,
      });
      if (rollout.status !== 'succeeded') {
        throw new Error(`stable rollout failed: ${rollout.phase} ${rollout.summary}\n${rollout.keyOutput}\n${JSON.stringify(rollout.details, null, 2)}`);
      }
      expect(readActiveSlotAuthority(fixture.controllerHome).activeSlot).toBe('green');
      expect(readCurrentRelease(fixture.controllerHome)).not.toBe(initialRelease.releasePath);
      expect(loadMcpServiceLocalConfig(ensureSlotHome(fixture.controllerHome, 'green'), fixture.repoRoot)?.devMode?.allowedAgents)
        .toEqual(['codex', 'claude']);

      const afterRollout = await controllerServiceStatus({
        repo: fixture.repoRoot,
        controllerHome: fixture.controllerHome,
      });
      expect(afterRollout.supervisor.pid).toBe(supervisorPid);
      const rootSupervisors = findProcessesByCommand([fixture.controllerHome]).filter((process) =>
        process.command.includes('/supervisor/releases/')
        && process.command.includes('/supervisor.js')
        && !process.command.includes('--ingress-child'));
      expect(rootSupervisors.map((process) => process.pid)).toEqual([supervisorPid]);

      const rollback = await controllerRollback({
        repo: fixture.repoRoot,
        controllerHome: fixture.controllerHome,
        startTimeoutMs: 60_000,
        skipRestartDurability: true,
        wait: true,
      });
      if (rollback.status !== 'succeeded') {
        throw new Error(`stable rollback failed: ${rollback.phase} ${rollback.summary}\n${rollback.keyOutput}\n${JSON.stringify(rollback.details, null, 2)}`);
      }
      expect(readActiveSlotAuthority(fixture.controllerHome).activeSlot).toBe('blue');
      expect(realpathSync(readCurrentRelease(fixture.controllerHome)!)).toBe(realpathSync(initialRelease.releasePath));
      const afterRollback = await controllerServiceStatus({
        repo: fixture.repoRoot,
        controllerHome: fixture.controllerHome,
      });
      expect(afterRollback.supervisor.pid).toBe(supervisorPid);

      await stopControllerService({
        repo: fixture.repoRoot,
        controllerHome: fixture.controllerHome,
        protectCallerAncestry: false,
        requireFullStop: true,
      });
    } finally {
      if (previousHome === undefined) delete process.env.REPO_HARNESS_CONTROLLER_HOME;
      else process.env.REPO_HARNESS_CONTROLLER_HOME = previousHome;
      if (previousSource === undefined) delete process.env.REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT;
      else process.env.REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT = previousSource;
      if (previousControlPort === undefined) delete process.env.REPO_HARNESS_SUPERVISOR_CONTROL_PORT;
      else process.env.REPO_HARNESS_SUPERVISOR_CONTROL_PORT = previousControlPort;
    }
  }, 300_000);

  test('slot homes never share PID/state files with each other', async () => {
    const fixture = await createIsolatedControllerFixture();
    const blue = ensureSlotHome(fixture.controllerHome, 'blue');
    const green = ensureSlotHome(fixture.controllerHome, 'green');
    mkdirSync(join(blue, 'daemon'), { recursive: true });
    mkdirSync(join(green, 'daemon'), { recursive: true });
    writeFileSync(join(blue, 'daemon', 'controller.pid'), '111\n');
    writeFileSync(join(green, 'daemon', 'controller.pid'), '222\n');
    expect(blue).not.toBe(green);
    expect(existsSync(join(blue, 'daemon', 'controller.pid'))).toBe(true);
    expect(existsSync(join(green, 'daemon', 'controller.pid'))).toBe(true);
    writeSlotIdentity(fixture.controllerHome, {
      schemaVersion: 1,
      slot: 'blue',
      role: 'active',
      controllerHome: fixture.controllerHome,
      slotHome: blue,
      mcpPort: fixture.mcpPort,
      localControllerPort: fixture.localControllerPort,
      updatedAt: new Date().toISOString(),
      logDir: join(blue, 'logs'),
    });
    // No real controller processes should match the temp fixture after unit-only work.
    const leaked = findProcessesByCommand([fixture.controllerHome]);
    expect(leaked.filter((p) => !p.command.includes('bun test'))).toEqual([]);
  });
});
