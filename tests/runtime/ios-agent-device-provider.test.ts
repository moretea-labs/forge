import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { registerRepository } from '../../src/cli/repositories/registry';
import { buildIosPluginManifest, executeIosPluginAction } from '../../src/runtime/plugins/ios-adapter';
import {
  iosAgentDeviceActions,
  resetIosAgentDeviceRuntimeHooksForTest,
  setIosAgentDeviceRuntimeHooksForTest,
} from '../../src/runtime/plugins/ios-agent-device';
import { readInteractionSession } from '../../src/runtime/plugins/interaction-session';
import { resetIosDevelopmentHooksForTest, setIosDevelopmentHooksForTest } from '../../src/runtime/safe-tooling';
import jdHomeDepth20 from '../fixtures/ios/jd-home-depth20.json';
import {
  resetAgentDeviceTypedProviderHooksForTest,
  setAgentDeviceTypedProviderHooksForTest,
} from '../../src/runtime/plugins/ios/agent-device-typed-provider';

const roots: string[] = [];

beforeEach(() => {
  process.env.REPO_HARNESS_AGENT_DEVICE_BACKEND = 'cli';
});

afterEach(() => {
  resetIosAgentDeviceRuntimeHooksForTest();
  resetIosDevelopmentHooksForTest();
  resetAgentDeviceTypedProviderHooksForTest();
  delete process.env.REPO_HARNESS_AGENT_DEVICE_EXECUTABLE;
  delete process.env.REPO_HARNESS_AGENT_DEVICE_BACKEND;
  delete process.env.REPO_HARNESS_CONTROLLER_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-ios-agent-device-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-ios-agent-device-controller-'));
  roots.push(repoRoot, controllerHome);
  process.env.REPO_HARNESS_CONTROLLER_HOME = controllerHome;
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  mkdirSync(join(repoRoot, 'App.xcodeproj'), { recursive: true });
  const repository = registerRepository({ path: repoRoot, controllerHome });
  return { repoRoot, controllerHome, repository };
}

function readyIosTooling(): void {
  setIosDevelopmentHooksForTest({
    platform: () => 'darwin',
    runCommand: (command, args) => {
      const joined = [command, ...args].join(' ');
      if (joined === 'xcode-select -p') return { ok: true, status: 0, stdout: '/Applications/Xcode.app/Contents/Developer\n', stderr: '', command: [command, ...args] };
      if (joined === 'xcodebuild -version') return { ok: true, status: 0, stdout: 'Xcode 18\n', stderr: '', command: [command, ...args] };
      if (joined === 'xcrun simctl help') return { ok: true, status: 0, stdout: 'help\n', stderr: '', command: [command, ...args] };
      return { ok: true, status: 0, stdout: '', stderr: '', command: [command, ...args] };
    },
  });
}

function pluginInput(
  fixtureValue: ReturnType<typeof fixture>,
  actionId: string,
  args: Record<string, unknown>,
  requestId = `request-${actionId}`,
) {
  return {
    controllerHome: fixtureValue.controllerHome,
    repoId: fixtureValue.repository.repoId,
    repoRoot: fixtureValue.repoRoot,
    pluginId: 'ios',
    actionId,
    requestId,
    args,
    origin: { surface: 'local-ui' as const, actor: 'test' },
  };
}

function success(data: Record<string, unknown> = {}): string {
  return JSON.stringify({ success: true, data });
}

function device(id: string, name: string, kind: 'simulator' | 'device', booted: boolean) {
  return { platform: 'ios', appleOs: 'ios', id, name, kind, target: 'mobile', booted };
}

describe('optional agent-device iOS Simulator provider', () => {
  it('keeps existing iOS readiness unchanged when the optional CLI is absent', () => {
    const value = fixture();
    readyIosTooling();
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => ({ ok: false, status: 127, stdout: '', stderr: 'not found', command: [command, ...args] }),
    });

    const manifest = buildIosPluginManifest(0, undefined, value.repoRoot);
    expect(manifest.health.ready).toBe(true);
    expect(manifest.lifecycle.state).toBe('enabled');
    expect((manifest.health.details?.agentDevice as Record<string, unknown>).available).toBe(false);
    expect(manifest.capabilities.map((capability) => capability.capabilityId)).toContain('ios-agent-device-simulator');
    expect(manifest.capabilities.map((capability) => capability.capabilityId)).toContain('ios-agent-device-physical');
    expect(manifest.actions.map((action) => action.actionId)).toContain('agent_device_open');
    expect(manifest.actions.map((action) => action.actionId)).toContain('agent_device_batch');
    expect(manifest.actions.map((action) => action.actionId)).toContain('agent_device_prepare');
    expect(manifest.actions.map((action) => action.actionId)).toContain('agent_device_jd_search');
    expect(manifest.health.warnings).not.toContain('agent-device is not installed.');
  });

  it('rejects an unreviewed provider version when no parseable command contract is available', async () => {
    const value = fixture();
    readyIosTooling();
    const commands: string[][] = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        return { ok: true, status: 0, stdout: '0.20.0\n', stderr: '', command: [command, ...args] };
      },
    });

    const status = await executeIosPluginAction(pluginInput(value, 'agent_device_status', {}));
    expect(status.available).toBe(false);
    expect(status.expectedVersion).toBe('0.20.2');
    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_open', { app: 'App' })))
      .rejects.toThrow('PLUGIN_DEPENDENCY_MISSING');
    expect(commands[0]).toEqual(['agent-device', '--version']);
    expect(commands.slice(1).map((command) => command.slice(1))).toEqual([
      ['help'],
      ['help', 'snapshot'],
      ['help', 'press'],
      ['help', 'fill'],
      ['help', 'batch'],
      ['help', 'keyboard'],
    ]);
  });

  it('accepts one exact connected physical iPhone and rejects unavailable or ambiguous targets', async () => {
    const value = fixture();
    readyIosTooling();
    let inventory = [device('PHONE-1', 'Greyson', 'device', true)];
    const commands: string[][] = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') return { ok: true, status: 0, stdout: success({ devices: inventory }), stderr: '', command: [command, ...args] };
        return { ok: true, status: 0, stdout: success(), stderr: '', command: [command, ...args] };
      },
    });

    const physical = await executeIosPluginAction(pluginInput(value, 'agent_device_open', { app: 'App', device: 'PHONE-1' }));
    expect((physical.interaction as Record<string, unknown>).provider).toBe('ios-device');
    expect(physical.physicalDeviceSupported).toBe(true);

    inventory = [device('SIM-OFF', 'iPhone 17 Pro', 'simulator', false)];
    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_open', { app: 'App', device: 'SIM-OFF' })))
      .rejects.toThrow('connected physical iPhone or already-booted iOS Simulator');

    inventory = [
      device('SIM-1', 'iPhone 17', 'simulator', true),
      device('SIM-2', 'iPhone 17', 'simulator', true),
    ];
    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_open', { app: 'App', device: 'iPhone 17' })))
      .rejects.toThrow('ambiguous');
    expect(commands.filter((command) => command[1] === 'open')).toHaveLength(1);
  });

  it('prepares a signed physical Runner and completes a bounded JD product search', async () => {
    const value = fixture();
    readyIosTooling();
    const developerDir = join(value.repoRoot, 'Xcode.app', 'Contents', 'Developer');
    mkdirSync(developerDir, { recursive: true });
    const commands: Array<{ argv: string[]; env?: NodeJS.ProcessEnv }> = [];
    let snapshotCount = 0;
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-07-20T09:00:00.000Z'),
      runCommand: (command, args, options) => {
        commands.push({ argv: [command, ...args], env: options?.env });
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') {
          return { ok: true, status: 0, stdout: success({ devices: [device('PHONE-1', 'greyson', 'device', true)] }), stderr: '', command: [command, ...args] };
        }
        if (args[0] === 'snapshot') {
          snapshotCount += 1;
          return {
            ok: true, status: 0,
            stdout: success({ tree: '@e1 SearchField label="搜索商品" value=""' }),
            stderr: '', command: [command, ...args],
          };
        }
        if (args[0] === 'batch') {
          const steps = JSON.parse(args[args.indexOf('--steps') + 1]!) as Array<{ command: string; input: Record<string, unknown> }>;
          return {
            ok: true, status: 0,
            stdout: success({
              total: steps.length,
              executed: steps.length,
              results: steps.map((step, index) => ({
                step: index + 1,
                command: step.command,
                ok: true,
                data: step.command === 'snapshot'
                  ? { tree: '@e7 StaticText label="爱他美卓傲 1段 800g"\n@e8 StaticText label="奶粉搜索结果"' }
                  : step.command === 'wait'
                    ? { matched: true, text: step.input.text ?? step.input.selector }
                    : { input: step.input },
              })),
              cost: { wallClockMs: 1200, runnerRoundTrips: 4 },
            }),
            stderr: '', command: [command, ...args],
          };
        }
        if (args[0] === 'screenshot') writeFileSync(args[1]!, 'png');
        return { ok: true, status: 0, stdout: success({ command: args[0] }), stderr: '', command: [command, ...args] };
      },
    });

    const runnerConfig = {
      device: 'greyson',
      team_id: 'TEAM123456',
      runner_bundle_id: 'com.example.agentdevice.runner',
      developer_dir: developerDir,
    };
    const prepared = await executeIosPluginAction(pluginInput(value, 'agent_device_prepare', runnerConfig));
    expect(prepared.physicalDeviceSupported).toBe(true);
    const result = await executeIosPluginAction(pluginInput(value, 'agent_device_jd_search', {
      ...runnerConfig,
      query: '爱他美卓傲 1段 800g',
      search_target: '@e999',
      search_selector: 'type="SearchField"',
      submit_target: '@e998',
      submit_selector: 'label="搜索"',
      result_text: '奶粉搜索结果',
    }));

    expect(result.workflow).toBe('jd_product_search');
    expect(result.app).toBe('com.360buy.jdmobile');
    expect(JSON.stringify(result)).not.toContain('爱他美卓傲 1段 800g');
    expect(JSON.stringify(result.visibleResultText)).toContain('奶粉搜索结果');
    const artifact = (result.artifactCandidates as Array<Record<string, unknown>>)[0]!;
    expect(artifact.mediaType).toBe('image/png');
    expect(existsSync(String(artifact.path))).toBe(true);
    expect((result.interaction as Record<string, unknown>).status).toBe('closed');
    expect(readInteractionSession(value.repoRoot, 'ios-device', String((result.interaction as Record<string, unknown>).interactionId))?.status).toBe('closed');

    const prepare = commands.find(({ argv }) => argv[1] === 'prepare')!;
    expect(prepare.argv).toEqual(expect.arrayContaining(['ios-runner', '--device', 'greyson']));
    expect(prepare.env?.AGENT_DEVICE_IOS_TEAM_ID).toBe('TEAM123456');
    expect(prepare.env?.AGENT_DEVICE_IOS_BUNDLE_ID).toBe('com.example.agentdevice.runner');
    expect(prepare.env?.DEVELOPER_DIR).toBe(developerDir);
    const open = commands.find(({ argv }) => argv[1] === 'open' && argv.includes('com.360buy.jdmobile'))!;
    expect(open.argv).not.toContain('--relaunch');
    const batches = commands.filter(({ argv }) => argv[1] === 'batch');
    expect(snapshotCount).toBe(0);
    expect(batches).toHaveLength(1);
    const steps = JSON.parse(batches[0]!.argv[batches[0]!.argv.indexOf('--steps') + 1]!) as Array<{ command: string; input: Record<string, unknown> }>;
    expect(steps.map((step) => step.command)).toEqual(['fill', 'press', 'wait']);
    expect(steps[0]?.input.settle).toBe(true);
    expect(steps[0]?.input.target).toEqual({ kind: 'selector', selector: 'type="SearchField"' });
    expect(steps[1]?.input.target).toEqual({ kind: 'selector', selector: 'label="搜索"' });
    expect(steps[2]?.input).toEqual({ kind: 'text', text: '奶粉搜索结果', timeoutMs: 15_000 });
    expect(commands.some(({ argv }) => argv[1] === 'keyboard' && argv[2] === 'return')).toBe(false);
    expect((result.executionPlan as Record<string, unknown>).nativeBatchRequests).toBe(1);
    expect((result.executionPlan as Record<string, unknown>).nativeBatchSteps).toBe(3);
    expect((result.executionPlan as Record<string, unknown>).exactResultWait).toBe(true);
    expect((result.executionPlan as Record<string, unknown>).accessibilityEvidenceTier).toBe('exact_wait');
    expect((result.executionPlan as Record<string, unknown>).initialAccessibilitySnapshot).toBe(false);
    expect((result.executionPlan as Record<string, unknown>).accessibilitySnapshotRequests).toBe(0);
    expect((result.executionPlan as Record<string, unknown>).fullAccessibilitySnapshot).toBe(false);
    const phaseTimings = (result.executionPlan as Record<string, unknown>).timingsMs as Record<string, number>;
    expect(Object.keys(phaseTimings).sort()).toEqual([
      'close', 'interactionAndEvidence', 'open', 'screenshot', 'targetDiscovery', 'targetSelection', 'total',
    ].sort());
    expect(Object.values(phaseTimings).every((value) => value >= 0)).toBe(true);
    expect(phaseTimings.total).toBeGreaterThanOrEqual(phaseTimings.open + phaseTimings.close);
    expect(commands.some(({ argv }) => argv[1] === 'close')).toBe(true);
  });

  it('reuses an active JD interaction without inventory, open, screenshot or close overhead', async () => {
    const value = fixture();
    readyIosTooling();
    const commands: string[][] = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-07-20T09:00:00.000Z'),
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') {
          return { ok: true, status: 0, stdout: success({ devices: [device('PHONE-1', 'greyson', 'device', true)] }), stderr: '', command: [command, ...args] };
        }
        if (args[0] === 'batch') {
          const steps = JSON.parse(args[args.indexOf('--steps') + 1]!) as Array<{ command: string; input: Record<string, unknown> }>;
          return {
            ok: true,
            status: 0,
            stdout: success({
              total: steps.length,
              executed: steps.length,
              results: steps.map((step, index) => ({
                step: index + 1,
                command: step.command,
                ok: true,
                data: step.command === 'wait'
                  ? { matched: true, text: step.input.text ?? step.input.selector }
                  : { input: step.input },
              })),
              cost: { wallClockMs: 420, runnerRoundTrips: 3 },
            }),
            stderr: '',
            command: [command, ...args],
          };
        }
        if (args[0] === 'screenshot') writeFileSync(args[1]!, 'png');
        return { ok: true, status: 0, stdout: success({ command: args[0] }), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', {
      app: 'com.360buy.jdmobile',
      device: 'greyson',
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    commands.length = 0;

    const result = await executeIosPluginAction(pluginInput(value, 'agent_device_jd_search', {
      device: 'greyson',
      interaction_id: interactionId,
      query: '40.5码 宽楦 透气男鞋',
      search_selector: 'type="SearchField"',
      submit_selector: 'label="搜索"',
      result_text: '搜索结果',
    }));

    expect(commands.filter((argv) => argv[1] === 'devices')).toHaveLength(0);
    expect(commands.filter((argv) => argv[1] === 'open')).toHaveLength(0);
    expect(commands.filter((argv) => argv[1] === 'batch')).toHaveLength(1);
    expect(commands.filter((argv) => argv[1] === 'screenshot')).toHaveLength(0);
    expect(commands.filter((argv) => argv[1] === 'close')).toHaveLength(0);
    expect(result.artifactCandidates).toBeUndefined();
    expect((result.interaction as Record<string, unknown>).status).toBe('waiting_for_user');
    expect(readInteractionSession(value.repoRoot, 'ios-device', interactionId)?.status).toBe('waiting_for_user');
    const plan = result.executionPlan as Record<string, unknown>;
    expect(plan.sessionReused).toBe(true);
    expect(plan.sessionKept).toBe(true);
    expect(plan.screenshotCaptured).toBe(false);
    expect(plan.deviceInventoryRequests).toBe(0);
    expect(plan.nativeBatchRequests).toBe(1);
  });

  it('rejects reuse of a non-JD interaction before executing a search batch', async () => {
    const value = fixture();
    readyIosTooling();
    const commands: string[][] = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') {
          return { ok: true, status: 0, stdout: success({ devices: [device('PHONE-1', 'greyson', 'device', true)] }), stderr: '', command: [command, ...args] };
        }
        return { ok: true, status: 0, stdout: success({ command: args[0] }), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', {
      app: 'com.example.other',
      device: 'greyson',
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    commands.length = 0;

    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_jd_search', {
      device: 'greyson',
      interaction_id: interactionId,
      query: '宽楦男鞋',
      search_selector: 'type="SearchField"',
      result_text: '搜索结果',
    }))).rejects.toThrow('active physical-iPhone JD session');

    expect(commands.filter((argv) => argv[1] === 'batch')).toHaveLength(0);
    expect(readInteractionSession(value.repoRoot, 'ios-device', interactionId)?.status).toBe('waiting_for_user');
  });

  it('serializes concurrent commands per interaction and caps the provider timeout', async () => {
    const value = fixture();
    readyIosTooling();
    let activeCommands = 0;
    let maxActiveCommands = 0;
    const observedTimeouts: number[] = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') {
          return { ok: true, status: 0, stdout: success({ devices: [device('PHONE-1', 'greyson', 'device', true)] }), stderr: '', command: [command, ...args] };
        }
        return { ok: true, status: 0, stdout: success({ command: args[0] }), stderr: '', command: [command, ...args] };
      },
      runCommandAsync: async (command, args, options) => {
        if (args[0] !== 'press') {
          return { ok: true, status: 0, stdout: success({ command: args[0] }), stderr: '', command: [command, ...args] };
        }
        observedTimeouts.push(options?.timeoutMs ?? -1);
        activeCommands += 1;
        maxActiveCommands = Math.max(maxActiveCommands, activeCommands);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeCommands -= 1;
        return { ok: true, status: 0, stdout: success({ command: args[0] }), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', {
      app: 'com.360buy.jdmobile',
      device: 'greyson',
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);

    await Promise.all([
      executeIosPluginAction({
        ...pluginInput(value, 'agent_device_press', { interaction_id: interactionId, target: '@e1' }, 'press-1'),
        timeoutMs: 250,
      }),
      executeIosPluginAction({
        ...pluginInput(value, 'agent_device_press', { interaction_id: interactionId, target: '@e2' }, 'press-2'),
        timeoutMs: 250,
      }),
    ]);

    expect(maxActiveCommands).toBe(1);
    expect(observedTimeouts).toHaveLength(2);
    expect(observedTimeouts.every((timeout) => timeout > 0 && timeout <= 250)).toBe(true);
    expect(observedTimeouts[1]!).toBeLessThanOrEqual(observedTimeouts[0]!);
    expect(readInteractionSession(value.repoRoot, 'ios-device', interactionId)?.status).toBe('waiting_for_user');
  });

  it('cancels a queued command without touching or terminalizing the active interaction', async () => {
    const value = fixture();
    readyIosTooling();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let asyncCommandCount = 0;
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') {
          return { ok: true, status: 0, stdout: success({ devices: [device('PHONE-1', 'greyson', 'device', true)] }), stderr: '', command: [command, ...args] };
        }
        return { ok: true, status: 0, stdout: success({ command: args[0] }), stderr: '', command: [command, ...args] };
      },
      runCommandAsync: async (command, args) => {
        if (args[0] !== 'press') {
          return { ok: true, status: 0, stdout: success({ command: args[0] }), stderr: '', command: [command, ...args] };
        }
        asyncCommandCount += 1;
        if (asyncCommandCount === 1) {
          markFirstStarted();
          await firstRelease;
        }
        return { ok: true, status: 0, stdout: success({ command: args[0] }), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', {
      app: 'com.360buy.jdmobile',
      device: 'greyson',
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    const first = executeIosPluginAction(pluginInput(value, 'agent_device_press', {
      interaction_id: interactionId,
      target: '@e1',
    }, 'press-holds-session'));
    await firstStarted;

    const abort = new AbortController();
    abort.abort();
    const queued = executeIosPluginAction({
      ...pluginInput(value, 'agent_device_press', { interaction_id: interactionId, target: '@e2' }, 'press-cancelled'),
      signal: abort.signal,
    });
    await expect(queued).rejects.toThrow('cancelled before it acquired the interaction session');

    const timedOut = executeIosPluginAction({
      ...pluginInput(value, 'agent_device_press', { interaction_id: interactionId, target: '@e3' }, 'press-timeout'),
      timeoutMs: 10,
    });
    await expect(timedOut).rejects.toThrow('timed out while waiting for the interaction session');
    expect(asyncCommandCount).toBe(1);
    expect(readInteractionSession(value.repoRoot, 'ios-device', interactionId)?.status).toBe('waiting_for_user');

    releaseFirst();
    await first;
  });

  it('fences an in-flight mutation with unknown outcome and requires explicit close before reuse', async () => {
    const value = fixture();
    readyIosTooling();
    const commands: string[][] = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') {
          return { ok: true, status: 0, stdout: success({ devices: [device('PHONE-1', 'greyson', 'device', true)] }), stderr: '', command: [command, ...args] };
        }
        return { ok: true, status: 0, stdout: success({ command: args[0] }), stderr: '', command: [command, ...args] };
      },
      runCommandAsync: async (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === 'press') {
          return {
            ok: false,
            status: null,
            stdout: '',
            stderr: 'provider response deadline elapsed after dispatch',
            command: [command, ...args],
            timedOut: true,
          };
        }
        return { ok: true, status: 0, stdout: success({ command: args[0] }), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', {
      app: 'com.360buy.jdmobile',
      device: 'greyson',
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);

    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_press', {
      interaction_id: interactionId,
      target: '@e1',
    }))).rejects.toThrow('outcome is unknown');
    expect(readInteractionSession(value.repoRoot, 'ios-device', interactionId)?.status).toBe('unknown');
    expect(commands.filter((command) => command[1] === 'close')).toHaveLength(0);

    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_press', {
      interaction_id: interactionId,
      target: '@e2',
    }, 'must-not-retry-unknown'))).rejects.toThrow('Do not retry it');
    expect(commands.filter((command) => command[1] === 'press')).toHaveLength(1);

    const closed = await executeIosPluginAction(pluginInput(value, 'agent_device_close', {
      interaction_id: interactionId,
    }));
    expect((closed.interaction as Record<string, unknown>).status).toBe('closed');
    expect(commands.filter((command) => command[1] === 'close')).toHaveLength(1);
  });

  it('refreshes one stale cached JD search ref without terminalizing the session', async () => {
    const value = fixture();
    readyIosTooling();
    let batchCount = 0;
    let snapshotCount = 0;
    const commands: string[][] = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-07-20T09:00:00.000Z'),
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') {
          return { ok: true, status: 0, stdout: success({ devices: [device('PHONE-1', 'greyson', 'device', true)] }), stderr: '', command: [command, ...args] };
        }
        if (args[0] === 'snapshot') {
          snapshotCount += 1;
          return { ok: true, status: 0, stdout: success({ tree: '@e7 SearchField label="搜索商品" value=""' }), stderr: '', command: [command, ...args] };
        }
        if (args[0] === 'batch') {
          batchCount += 1;
          if (batchCount === 1) {
            return {
              ok: false,
              status: 1,
              stdout: JSON.stringify({ success: false, error: { message: 'Accessibility ref @e1 is stale and not found.' } }),
              stderr: '',
              command: [command, ...args],
            };
          }
          const steps = JSON.parse(args[args.indexOf('--steps') + 1]!) as Array<{ command: string; input: Record<string, unknown> }>;
          return { ok: true, status: 0, stdout: success({ results: steps.map((step) => ({ command: step.command, data: { matched: true } })) }), stderr: '', command: [command, ...args] };
        }
        if (args[0] === 'screenshot') writeFileSync(args[1]!, 'png');
        return { ok: true, status: 0, stdout: success(), stderr: '', command: [command, ...args] };
      },
    });

    const result = await executeIosPluginAction(pluginInput(value, 'agent_device_jd_search', {
      device: 'greyson',
      query: '奶粉',
      search_target: '@e1',
      submit_selector: 'label="搜索"',
      result_text: '搜索结果',
    }));

    expect(snapshotCount).toBe(1);
    expect(batchCount).toBe(3);
    expect((result.executionPlan as Record<string, unknown>).staleRefRecovery).toBe(true);
    expect((result.executionPlan as Record<string, unknown>).accessibilitySnapshotRequests).toBe(1);
    expect((result.interaction as Record<string, unknown>).status).toBe('closed');
    expect(commands.filter((argv) => argv[1] === 'close')).toHaveLength(1);
    const recoveredFill = commands.filter((argv) => argv[1] === 'batch')[1]!;
    const recoveredSteps = JSON.parse(recoveredFill[recoveredFill.indexOf('--steps') + 1]!) as Array<{ input: Record<string, unknown> }>;
    expect(recoveredSteps[0]?.input.target).toEqual({ kind: 'ref', ref: 'e7' });
  });

  it('escalates an exact wait miss through scoped and full accessibility evidence tiers', async () => {
    for (const scopedHasEvidence of [true, false]) {
      const value = fixture();
      readyIosTooling();
      const snapshots: string[][] = [];
      let batchCount = 0;
      setIosAgentDeviceRuntimeHooksForTest({
        platform: () => 'darwin',
        runCommand: (command, args) => {
          if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
          if (args[0] === 'devices') {
            return { ok: true, status: 0, stdout: success({ devices: [device('PHONE-1', 'greyson', 'device', true)] }), stderr: '', command: [command, ...args] };
          }
          if (args[0] === 'batch') {
            batchCount += 1;
            return {
              ok: false,
              status: 1,
              stdout: JSON.stringify({ success: false, error: { message: 'Wait for expected text timed out without a match.' } }),
              stderr: '',
              command: [command, ...args],
            };
          }
          if (args[0] === 'snapshot') {
            snapshots.push(args);
            const full = args.includes('--force-full');
            const tree = full
              ? '@e9 StaticText label="全部搜索结果"'
              : scopedHasEvidence
                ? '@e8 StaticText label="搜索结果"'
                : '';
            return { ok: true, status: 0, stdout: success({ tree }), stderr: '', command: [command, ...args] };
          }
          if (args[0] === 'screenshot') writeFileSync(args[1]!, 'png');
          return { ok: true, status: 0, stdout: success(), stderr: '', command: [command, ...args] };
        },
      });

      const result = await executeIosPluginAction(pluginInput(value, 'agent_device_jd_search', {
        device: 'greyson',
        query: '奶粉',
        search_selector: 'type="SearchField"',
        submit_selector: 'label="搜索"',
        result_text: '搜索结果',
        result_scope: '搜索结果',
        snapshot_depth: 6,
      }));

      expect(batchCount).toBe(1);
      expect(snapshots[0]).toEqual(expect.arrayContaining(['--scope', '搜索结果', '--depth', '6']));
      expect(snapshots[0]).not.toContain('--force-full');
      const plan = result.executionPlan as Record<string, unknown>;
      expect(plan.exactWaitFallback).toBe(true);
      expect(plan.accessibilityEvidenceTier).toBe(scopedHasEvidence ? 'scoped_snapshot' : 'full_snapshot');
      expect(plan.accessibilitySnapshotRequests).toBe(scopedHasEvidence ? 1 : 2);
      expect(plan.fullAccessibilitySnapshot).toBe(!scopedHasEvidence);
      if (scopedHasEvidence) {
        expect(snapshots).toHaveLength(1);
      } else {
        expect(snapshots).toHaveLength(2);
        expect(snapshots[1]).toContain('--force-full');
      }
      expect((result.interaction as Record<string, unknown>).status).toBe('closed');
    }
  });

  it('does not treat Runner or transport timeout as a recoverable exact wait miss', async () => {
    const value = fixture();
    readyIosTooling();
    let snapshotCount = 0;
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') {
          return { ok: true, status: 0, stdout: success({ devices: [device('PHONE-1', 'greyson', 'device', true)] }), stderr: '', command: [command, ...args] };
        }
        if (args[0] === 'batch') {
          return {
            ok: false,
            status: 1,
            stdout: JSON.stringify({ success: false, error: { message: 'Runner connection timed out while waiting for text.' } }),
            stderr: '',
            command: [command, ...args],
          };
        }
        if (args[0] === 'snapshot') snapshotCount += 1;
        return { ok: true, status: 0, stdout: success(), stderr: '', command: [command, ...args] };
      },
    });

    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_jd_search', {
      device: 'greyson',
      query: '奶粉',
      search_selector: 'type="SearchField"',
      submit_selector: 'label="搜索"',
      result_text: '搜索结果',
      result_scope: '搜索结果',
    }))).rejects.toThrow('Runner connection timed out');
    expect(snapshotCount).toBe(0);
  });

  it('blocks sensitive JD workflow semantics before touching device inventory', async () => {
    const value = fixture();
    readyIosTooling();
    const commands: string[][] = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        return { ok: true, status: 0, stdout: args[0] === '--version' ? '0.20.2\n' : success(), stderr: '', command: [command, ...args] };
      },
    });
    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_jd_search', {
      device: 'greyson', query: '提交订单并付款',
    }))).rejects.toThrow('IOS_DEVICE_SENSITIVE_ACTION_BLOCKED');
    expect(commands.some((command) => command[1] === 'devices')).toBe(false);
  });

  it('runs only typed serial commands in one isolated session and registers bounded artifacts', async () => {
    const value = fixture();
    readyIosTooling();
    const commands: Array<{ argv: string[]; env?: NodeJS.ProcessEnv }> = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-07-19T11:00:00.000Z'),
      runCommand: (command, args, options) => {
        commands.push({ argv: [command, ...args], env: options?.env });
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') {
          return { ok: true, status: 0, stdout: success({ devices: [device('SIM-1', 'iPhone 17 Pro', 'simulator', true)] }), stderr: '', command: [command, ...args] };
        }
        if (args[0] === 'screenshot') writeFileSync(args[1]!, 'png');
        if (args[0] === 'fill') return { ok: true, status: 0, stdout: success({ command: 'fill', text: args[2] }), stderr: '', command: [command, ...args] };
        if (args[0] === 'events') return { ok: true, status: 0, stdout: success({ events: [{ type: 'fill', payload: { text: 'timeline-secret', value: 'timeline-secret' } }] }), stderr: '', command: [command, ...args] };
        return { ok: true, status: 0, stdout: success({ command: args[0] }), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', {
      app: 'com.example.App', device: 'SIM-1', relaunch: true,
    }));
    const interaction = opened.interaction as Record<string, unknown>;
    const interactionId = String(interaction.interactionId);
    const sessionId = String(interaction.sessionId);
    expect(interaction.status).toBe('waiting_for_user');

    await executeIosPluginAction(pluginInput(value, 'agent_device_snapshot', { interaction_id: interactionId, interactive: true }));
    await executeIosPluginAction(pluginInput(value, 'agent_device_press', { interaction_id: interactionId, target: 'label="Continue"' }));
    const filled = await executeIosPluginAction(pluginInput(value, 'agent_device_fill', { interaction_id: interactionId, target: 'id="email"', text: 'qa@example.com', delay_ms: 20 }));
    expect(JSON.stringify(filled)).not.toContain('qa@example.com');
    await executeIosPluginAction(pluginInput(value, 'agent_device_scroll', { interaction_id: interactionId, direction: 'down', amount: 2 }));
    const screenshot = await executeIosPluginAction(pluginInput(value, 'agent_device_screenshot', { interaction_id: interactionId, label: 'home', max_size: 1200 }));
    const events = await executeIosPluginAction(pluginInput(value, 'agent_device_events', { interaction_id: interactionId, limit: 20 }));
    expect(JSON.stringify(events)).not.toContain('timeline-secret');
    const closed = await executeIosPluginAction(pluginInput(value, 'agent_device_close', { interaction_id: interactionId }));
    const closedAgain = await executeIosPluginAction(pluginInput(value, 'agent_device_close', { interaction_id: interactionId }));

    expect((closed.interaction as Record<string, unknown>).status).toBe('closed');
    expect(closedAgain.alreadyClosed).toBe(true);
    expect((screenshot.artifactCandidates as Array<Record<string, unknown>>)[0]?.mediaType).toBe('image/png');
    const screenshotPath = String((screenshot.artifactCandidates as Array<Record<string, unknown>>)[0]?.path);
    expect(existsSync(screenshotPath)).toBe(true);
    const recorded = readInteractionSession(value.repoRoot, 'ios-simulator', interactionId);
    expect(recorded?.status).toBe('closed');
    expect(recorded?.targetId).toBe('SIM-1');

    const openCommand = commands.find(({ argv }) => argv[1] === 'open')!;
    expect(openCommand.argv).toEqual(expect.arrayContaining(['--device', 'iPhone 17 Pro', '--session', sessionId, '--platform', 'ios', '--json', '--relaunch']));
    const sessionCommands = commands.filter(({ argv }) => ['open', 'snapshot', 'press', 'fill', 'scroll', 'screenshot', 'events', 'close'].includes(argv[1]!));
    const stateDirs = new Set(sessionCommands.map(({ env }) => env?.AGENT_DEVICE_STATE_DIR));
    expect(stateDirs.size).toBe(1);
    expect([...stateDirs][0]).toContain(interactionId);
    expect(sessionCommands.every(({ env }) => env?.AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS === '300000')).toBe(true);
    expect(sessionCommands.every(({ env }) => env?.AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS === '300000')).toBe(true);
    expect(sessionCommands.every(({ env }) => env?.AGENT_DEVICE_IOS_RUNNER_RETENTION_MS === undefined)).toBe(true);
    for (const command of commands) expect(command.argv).not.toContain('mcp');
  });

  it('runs multiple allowlisted actions through one native batch and redacts fill text', async () => {
    const value = fixture();
    readyIosTooling();
    const commands: string[][] = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') {
          return { ok: true, status: 0, stdout: success({ devices: [device('SIM-1', 'iPhone 17 Pro', 'simulator', true)] }), stderr: '', command: [command, ...args] };
        }
        if (args[0] === 'batch') {
          const steps = JSON.parse(args[args.indexOf('--steps') + 1]!) as Array<{ command: string; input: Record<string, unknown> }>;
          return {
            ok: true, status: 0,
            stdout: success({
              total: steps.length,
              executed: steps.length,
              results: steps.map((step, index) => ({ step: index + 1, command: step.command, ok: true, data: step.input })),
              cost: { wallClockMs: 800, runnerRoundTrips: steps.length },
            }),
            stderr: '', command: [command, ...args],
          };
        }
        return { ok: true, status: 0, stdout: success(), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', { app: 'App', device: 'SIM-1' }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    const result = await executeIosPluginAction(pluginInput(value, 'agent_device_batch', {
      interaction_id: interactionId,
      steps: [
        { kind: 'press', input: { target: 'label="Continue"' } },
        { kind: 'fill', input: { target: 'id="email"', text: 'private@example.com', delay_ms: 10 } },
        { kind: 'wait', input: { wait_type: 'stable', quiet_ms: 300, timeout_ms: 3_000 } },
        { kind: 'snapshot', input: { interactive: true } },
      ],
    }));

    expect(result.batched).toBe(true);
    expect(result.stepCount).toBe(4);
    expect(JSON.stringify(result)).not.toContain('private@example.com');
    const batches = commands.filter((argv) => argv[1] === 'batch');
    expect(batches).toHaveLength(1);
    const nativeSteps = JSON.parse(batches[0]![batches[0]!.indexOf('--steps') + 1]!) as Array<{ command: string; input: Record<string, unknown> }>;
    expect(nativeSteps.map((step) => step.command)).toEqual(['press', 'fill', 'wait', 'snapshot']);
    expect(nativeSteps[0]?.input.settle).toBe(true);
    expect(nativeSteps[0]?.input.target).toEqual({ kind: 'selector', selector: 'label="Continue"' });
    expect(nativeSteps[1]?.input.settle).toBe(true);
    expect(nativeSteps[1]?.input.target).toEqual({ kind: 'selector', selector: 'id="email"' });
    expect(nativeSteps[1]?.input.delayMs).toBe(10);

    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_batch', {
      interaction_id: interactionId,
      steps: [{ kind: 'press', input: { target: '@e1', command: 'close' } }],
    }))).rejects.toThrow('unsupported fields');
    expect(commands.filter((argv) => argv[1] === 'batch')).toHaveLength(1);
  });

  it('closes failed sessions and redacts fill text from all error evidence', async () => {
    const value = fixture();
    readyIosTooling();
    const commands: string[][] = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') return { ok: true, status: 0, stdout: success({ devices: [device('SIM-1', 'iPhone 17 Pro', 'simulator', true)] }), stderr: '', command: [command, ...args] };
        if (args[0] === 'fill') {
          return {
            ok: false, status: 1,
            stdout: JSON.stringify({ success: false, error: { message: `rejected ${args[2]}` } }),
            stderr: `failed ${args[2]}`,
            command: [command, ...args],
          };
        }
        return { ok: true, status: 0, stdout: success(), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', { app: 'App', device: 'SIM-1' }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    let captured: unknown;
    try {
      await executeIosPluginAction(pluginInput(value, 'agent_device_fill', {
        interaction_id: interactionId, target: 'id="password"', text: 'top-secret-value',
      }));
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(JSON.stringify(captured)).not.toContain('top-secret-value');
    expect(String((captured as Error).message)).toContain('rejected <redacted>');
    expect(commands.some((command) => command[1] === 'close')).toBe(true);
    const fillCommand = commands.find((command) => command[1] === 'fill')!;
    expect(fillCommand).toContain('top-secret-value');
    const record = readInteractionSession(value.repoRoot, 'ios-simulator', interactionId);
    expect(record?.status).toBe('failed');
    expect(JSON.stringify(record)).not.toContain('top-secret-value');
  });

  it('keeps ownership fenced when failure cleanup cannot close the provider session', async () => {
    const value = fixture();
    readyIosTooling();
    let closeSucceeds = false;
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') return { ok: true, status: 0, stdout: success({ devices: [device('SIM-1', 'iPhone 17 Pro', 'simulator', true)] }), stderr: '', command: [command, ...args] };
        if (args[0] === 'press') return { ok: false, status: 1, stdout: '', stderr: 'runner disconnected', command: [command, ...args] };
        if (args[0] === 'close' && !closeSucceeds) return { ok: false, status: 1, stdout: '', stderr: 'daemon unavailable', command: [command, ...args] };
        return { ok: true, status: 0, stdout: success(), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', { app: 'App', device: 'SIM-1' }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_press', { interaction_id: interactionId, target: '@e1' })))
      .rejects.toThrow('AGENT_DEVICE_CLEANUP_FAILED');
    expect(readInteractionSession(value.repoRoot, 'ios-simulator', interactionId)?.status).toBe('closing');
    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_open', { app: 'App', device: 'SIM-1' })))
      .rejects.toThrow('PLUGIN_RESOURCE_BUSY');

    closeSucceeds = true;
    const retried = await executeIosPluginAction(pluginInput(value, 'agent_device_close', { interaction_id: interactionId }));
    expect((retried.interaction as Record<string, unknown>).status).toBe('closed');
  });

  it('treats exact provider SESSION_NOT_FOUND as an idempotent close and releases ownership', async () => {
    const value = fixture();
    readyIosTooling();
    let providerSessionExists = true;
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') return { ok: true, status: 0, stdout: success({ devices: [device('SIM-1', 'iPhone 17 Pro', 'simulator', true)] }), stderr: '', command: [command, ...args] };
        if (args[0] === 'close' && !providerSessionExists) {
          return {
            ok: false,
            status: 1,
            stdout: JSON.stringify({ success: false, error: { code: 'SESSION_NOT_FOUND', message: 'No active session' } }),
            stderr: '',
            command: [command, ...args],
          };
        }
        return { ok: true, status: 0, stdout: success(), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', { app: 'App', device: 'SIM-1' }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    providerSessionExists = false;
    const closed = await executeIosPluginAction(pluginInput(value, 'agent_device_close', { interaction_id: interactionId }));

    expect(closed.providerAlreadyAbsent).toBe(true);
    expect((closed.interaction as Record<string, unknown>).status).toBe('closed');
    expect(readInteractionSession(value.repoRoot, 'ios-simulator', interactionId)?.status).toBe('closed');
    const reopened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', { app: 'App', device: 'SIM-1' }));
    expect((reopened.interaction as Record<string, unknown>).status).toBe('waiting_for_user');
  });

  it('terminalizes an expired interaction when the exact provider session is already absent', async () => {
    const value = fixture();
    readyIosTooling();
    let now = new Date('2026-07-19T11:00:00.000Z');
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => now,
      runCommand: (command, args) => {
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') return { ok: true, status: 0, stdout: success({ devices: [device('SIM-1', 'iPhone 17 Pro', 'simulator', true)] }), stderr: '', command: [command, ...args] };
        if (args[0] === 'close') {
          return {
            ok: false,
            status: 1,
            stdout: JSON.stringify({ success: false, error: { code: 'SESSION_NOT_FOUND', message: 'No active session' } }),
            stderr: '',
            command: [command, ...args],
          };
        }
        return { ok: true, status: 0, stdout: success(), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', { app: 'App', device: 'SIM-1' }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    now = new Date('2026-07-19T14:00:00.000Z');
    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_snapshot', { interaction_id: interactionId })))
      .rejects.toThrow('AGENT_DEVICE_SESSION_EXPIRED');
    expect(readInteractionSession(value.repoRoot, 'ios-simulator', interactionId)?.status).toBe('failed');
  });

  it('closes and terminalizes an expired session before allowing further use', async () => {
    const value = fixture();
    readyIosTooling();
    let now = new Date('2026-07-19T11:00:00.000Z');
    const commands: string[][] = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => now,
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') return { ok: true, status: 0, stdout: success({ devices: [device('SIM-1', 'iPhone 17 Pro', 'simulator', true)] }), stderr: '', command: [command, ...args] };
        return { ok: true, status: 0, stdout: success(), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', { app: 'App', device: 'SIM-1' }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    now = new Date('2026-07-19T14:00:00.000Z');
    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_snapshot', { interaction_id: interactionId })))
      .rejects.toThrow('AGENT_DEVICE_SESSION_EXPIRED');
    expect(commands.some((command) => command[1] === 'close')).toBe(true);
    expect(readInteractionSession(value.repoRoot, 'ios-simulator', interactionId)?.status).toBe('failed');
  });

  it('rejects URL/deep-link app inputs before starting a provider session', async () => {
    const value = fixture();
    readyIosTooling();
    const commands: string[][] = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        return { ok: true, status: 0, stdout: success({ devices: [device('SIM-1', 'iPhone 17 Pro', 'simulator', true)] }), stderr: '', command: [command, ...args] };
      },
    });
    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_open', {
      app: 'myapp://login?token=secret', device: 'SIM-1',
    }))).rejects.toThrow('not a URL or tokenized deep link');
    expect(commands.some((command) => command[1] === 'devices')).toBe(false);
  });

  it('does not dispatch a typed snapshot after the action deadline has expired', async () => {
    const value = fixture();
    readyIosTooling();
    process.env.REPO_HARNESS_AGENT_DEVICE_BACKEND = 'typed';
    let typedSnapshots = 0;
    setAgentDeviceTypedProviderHooksForTest({
      resolveModule: () => join(process.cwd(), 'node_modules', 'agent-device', 'dist', 'src', 'index.js'),
      loadModule: async () => ({
        createAgentDeviceClient: () => ({
          capture: {
            snapshot: async () => {
              typedSnapshots += 1;
              return { nodes: [], truncated: false, identifiers: {} };
            },
          },
        }),
      }),
    });
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') {
          return { ok: true, status: 0, stdout: success({ devices: [device('PHONE-1', 'greyson', 'device', true)] }), stderr: '', command: [command, ...args] };
        }
        return { ok: true, status: 0, stdout: success(), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', {
      app: 'com.360buy.jdmobile',
      device: 'greyson',
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    const expired = {
      ...pluginInput(value, 'agent_device_snapshot', { interaction_id: interactionId }),
      deadlineAtMs: Date.now() - 1,
    };
    await expect(executeIosPluginAction(expired)).rejects.toMatchObject({
      code: 'AGENT_DEVICE_COMMAND_TIMEOUT',
      details: { sessionPreserved: true },
    });
    expect(typedSnapshots).toBe(0);
    expect(readInteractionSession(value.repoRoot, 'ios-device', interactionId)?.status).toBe('waiting_for_user');

    const followUp = await executeIosPluginAction(pluginInput(value, 'agent_device_snapshot', {
      interaction_id: interactionId,
    }, 'snapshot-after-expired-deadline'));
    expect(followUp.backend).toBe('typed');
    expect(typedSnapshots).toBe(1);
    await executeIosPluginAction(pluginInput(value, 'agent_device_close', { interaction_id: interactionId }));
  });

  it('never mixes a typed module version with a different active CLI session version', async () => {
    const value = fixture();
    readyIosTooling();
    process.env.REPO_HARNESS_AGENT_DEVICE_BACKEND = 'auto';
    const commands: string[][] = [];
    let typedLoads = 0;
    const mismatchedModule = mkdtempSync(join(tmpdir(), 'agent-device-mismatched-provider-'));
    roots.push(mismatchedModule);
    mkdirSync(join(mismatchedModule, 'dist', 'src'), { recursive: true });
    writeFileSync(join(mismatchedModule, 'package.json'), JSON.stringify({ name: 'agent-device', version: '0.20.1' }));
    const mismatchedEntry = join(mismatchedModule, 'dist', 'src', 'index.js');
    writeFileSync(mismatchedEntry, 'export {};');
    setAgentDeviceTypedProviderHooksForTest({
      resolveModule: () => mismatchedEntry,
      loadModule: async () => {
        typedLoads += 1;
        throw new Error('mismatched typed module must not load');
      },
    });
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') {
          return { ok: true, status: 0, stdout: success({ devices: [device('PHONE-1', 'greyson', 'device', true)] }), stderr: '', command: [command, ...args] };
        }
        if (args[0] === 'snapshot') {
          return { ok: true, status: 0, stdout: success({ nodes: [], truncated: false }), stderr: '', command: [command, ...args] };
        }
        return { ok: true, status: 0, stdout: success(), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', {
      app: 'com.360buy.jdmobile',
      device: 'greyson',
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    const autoSnapshot = await executeIosPluginAction(pluginInput(value, 'agent_device_snapshot', {
      interaction_id: interactionId,
    }));
    expect(autoSnapshot.backend).toBe('cli');
    expect(autoSnapshot.result).toMatchObject({
      backendFallbackReason: 'typed_cli_version_mismatch',
      typedVersion: '0.20.1',
      cliVersion: '0.20.2',
    });
    expect(typedLoads).toBe(0);

    process.env.REPO_HARNESS_AGENT_DEVICE_BACKEND = 'typed';
    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_snapshot', {
      interaction_id: interactionId,
    }, 'typed-version-mismatch'))).rejects.toMatchObject({
      code: 'AGENT_DEVICE_TYPED_PROVIDER_VERSION_MISMATCH',
      details: { sessionPreserved: true, typedVersion: '0.20.1', cliVersion: '0.20.2' },
    });
    expect(typedLoads).toBe(0);
    expect(readInteractionSession(value.repoRoot, 'ios-device', interactionId)?.status).toBe('waiting_for_user');
    await executeIosPluginAction(pluginInput(value, 'agent_device_close', { interaction_id: interactionId }));
  });

  it('uses the typed read provider for snapshots without spawning a CLI snapshot process', async () => {
    const value = fixture();
    readyIosTooling();
    process.env.REPO_HARNESS_AGENT_DEVICE_BACKEND = 'typed';
    const commands: string[][] = [];
    const typedCalls: Array<{ config: Record<string, unknown>; options: Record<string, unknown> }> = [];
    setAgentDeviceTypedProviderHooksForTest({
      resolveModule: () => join(process.cwd(), 'node_modules', 'agent-device', 'dist', 'src', 'index.js'),
      loadModule: async () => ({
        createAgentDeviceClient: (config = {}) => ({
          capture: {
            snapshot: async (options) => {
              typedCalls.push({ config, options });
              return { nodes: [{ ref: 'e39', type: 'SearchField', depth: 14 }], truncated: false, identifiers: {} };
            },
          },
        }),
      }),
    });
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') {
          return { ok: true, status: 0, stdout: success({ devices: [device('PHONE-1', 'greyson', 'device', true)] }), stderr: '', command: [command, ...args] };
        }
        if (args[0] === 'snapshot') throw new Error('CLI snapshot must not run in typed mode');
        return { ok: true, status: 0, stdout: success(), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', {
      app: 'com.360buy.jdmobile',
      device: 'greyson',
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    const snapshot = await executeIosPluginAction(pluginInput(value, 'agent_device_snapshot', {
      interaction_id: interactionId,
      raw: true,
      depth: 20,
    }));

    expect(snapshot.backend).toBe('typed');
    expect(snapshot.configuredBackend).toBe('typed');
    expect(typedCalls).toHaveLength(1);
    expect(typedCalls[0]?.config).toMatchObject({
      session: String((opened.interaction as Record<string, unknown>).sessionId),
      requestId: 'request-agent_device_snapshot',
      cost: true,
    });
    expect(typedCalls[0]?.options).toMatchObject({
      platform: 'ios',
      device: 'PHONE-1',
      raw: true,
      depth: 20,
    });
    expect(commands.some((command) => command[1] === 'snapshot')).toBe(false);

    await executeIosPluginAction(pluginInput(value, 'agent_device_close', { interaction_id: interactionId }));
  });

  it('falls back from auto to CLI only when the optional typed module cannot load', async () => {
    const value = fixture();
    readyIosTooling();
    process.env.REPO_HARNESS_AGENT_DEVICE_BACKEND = 'auto';
    const commands: string[][] = [];
    setAgentDeviceTypedProviderHooksForTest({
      resolveModule: () => join(process.cwd(), 'node_modules', 'agent-device', 'dist', 'src', 'index.js'),
      loadModule: async () => { throw new Error('optional module unavailable after probe'); },
    });
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') {
          return { ok: true, status: 0, stdout: success({ devices: [device('PHONE-1', 'greyson', 'device', true)] }), stderr: '', command: [command, ...args] };
        }
        if (args[0] === 'snapshot') {
          return { ok: true, status: 0, stdout: success({ nodes: [], truncated: false }), stderr: '', command: [command, ...args] };
        }
        return { ok: true, status: 0, stdout: success(), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', {
      app: 'com.360buy.jdmobile',
      device: 'greyson',
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    const snapshot = await executeIosPluginAction(pluginInput(value, 'agent_device_snapshot', {
      interaction_id: interactionId,
      interactive: true,
    }));

    expect(snapshot.backend).toBe('cli');
    expect(snapshot.configuredBackend).toBe('auto');
    expect(snapshot.result).toMatchObject({
      backendFallbackReason: 'typed_unavailable',
      typedVersion: '0.20.2',
      cliVersion: '0.20.2',
    });
    expect(commands.filter((command) => command[1] === 'snapshot')).toHaveLength(1);
    await executeIosPluginAction(pluginInput(value, 'agent_device_close', { interaction_id: interactionId }));
  });

  it('does not hide a typed Runner failure by silently retrying the snapshot through CLI', async () => {
    const value = fixture();
    readyIosTooling();
    process.env.REPO_HARNESS_AGENT_DEVICE_BACKEND = 'auto';
    const commands: string[][] = [];
    setAgentDeviceTypedProviderHooksForTest({
      resolveModule: () => join(process.cwd(), 'node_modules', 'agent-device', 'dist', 'src', 'index.js'),
      loadModule: async () => ({
        createAgentDeviceClient: () => ({
          capture: {
            snapshot: async () => { throw { code: 'RUNNER_DISCONNECTED', message: 'typed runner lost' }; },
          },
        }),
      }),
    });
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') {
          return { ok: true, status: 0, stdout: success({ devices: [device('PHONE-1', 'greyson', 'device', true)] }), stderr: '', command: [command, ...args] };
        }
        return { ok: true, status: 0, stdout: success(), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', {
      app: 'com.360buy.jdmobile',
      device: 'greyson',
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_snapshot', {
      interaction_id: interactionId,
    }))).rejects.toThrow('typed runner lost');
    expect(commands.some((command) => command[1] === 'snapshot')).toBe(false);
    expect(commands.filter((command) => command[1] === 'close')).toHaveLength(1);
    expect(readInteractionSession(value.repoRoot, 'ios-device', interactionId)?.status).toBe('failed');
  });

  it('discovers deep JD search controls from structured App-adapter evidence without unsupported flags', async () => {
    const value = fixture();
    readyIosTooling();
    const commands: string[][] = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') {
          return { ok: true, status: 0, stdout: success({ devices: [device('PHONE-1', 'greyson', 'device', true)] }), stderr: '', command: [command, ...args] };
        }
        if (args[0] === 'snapshot') {
          return { ok: true, status: 0, stdout: JSON.stringify(jdHomeDepth20), stderr: '', command: [command, ...args] };
        }
        if (args[0] === 'batch') {
          const steps = JSON.parse(args[args.indexOf('--steps') + 1]!) as Array<{ command: string; input: Record<string, unknown> }>;
          return {
            ok: true,
            status: 0,
            stdout: success({
              results: steps.map((step) => ({
                command: step.command,
                ok: true,
                data: step.command === 'wait' ? { matched: true } : { input: step.input },
              })),
              cost: { wallClockMs: 420, runnerRoundTrips: steps.length },
            }),
            stderr: '',
            command: [command, ...args],
          };
        }
        return { ok: true, status: 0, stdout: success(), stderr: '', command: [command, ...args] };
      },
    });

    const result = await executeIosPluginAction(pluginInput(value, 'agent_device_jd_search', {
      device: 'greyson',
      query: '40.5码 宽楦 透气男鞋',
      capture_screenshot: false,
      result_text: '搜索结果',
    }));

    const snapshot = commands.find((argv) => argv[1] === 'snapshot')!;
    expect(snapshot).toEqual(expect.arrayContaining(['--raw', '--depth', '20']));
    expect(snapshot).not.toContain('-i');
    expect(snapshot).not.toContain('--interactive');
    const batches = commands.filter((argv) => argv[1] === 'batch');
    expect(batches).toHaveLength(2);
    const fillSteps = JSON.parse(batches[0]![batches[0]!.indexOf('--steps') + 1]!) as Array<{ command: string; input: Record<string, unknown> }>;
    const submitSteps = JSON.parse(batches[1]![batches[1]!.indexOf('--steps') + 1]!) as Array<{ command: string; input: Record<string, unknown> }>;
    expect(fillSteps[0]?.input.target).toEqual({ kind: 'ref', ref: 'e39' });
    expect(submitSteps[0]?.input.target).toEqual({ kind: 'ref', ref: 'e41' });
    expect((result.executionPlan as Record<string, unknown>).initialAccessibilitySnapshot).toBe(true);
    expect((result.executionPlan as Record<string, unknown>).accessibilitySnapshotRequests).toBe(1);
    expect((result.interaction as Record<string, unknown>).status).toBe('closed');
  });

  it('preserves a healthy session for structured semantic element failures and retains redacted diagnostics', async () => {
    const value = fixture();
    readyIosTooling();
    const commands: string[][] = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.20.2\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') {
          return { ok: true, status: 0, stdout: success({ devices: [device('PHONE-1', 'greyson', 'device', true)] }), stderr: '', command: [command, ...args] };
        }
        if (args[0] === 'fill') {
          return {
            ok: false,
            status: 1,
            stdout: JSON.stringify({ success: false, error: { code: 'ELEMENT_NOT_FOUND', message: `No element accepted ${args[2]}` } }),
            stderr: '',
            command: [command, ...args],
          };
        }
        return { ok: true, status: 0, stdout: success(), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', {
      app: 'com.360buy.jdmobile',
      device: 'greyson',
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    let captured: unknown;
    try {
      await executeIosPluginAction(pluginInput(value, 'agent_device_fill', {
        interaction_id: interactionId,
        target: 'id="search"',
        text: 'private-query-value',
      }));
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(Error);
    expect(String((captured as Error).message)).toContain('No element accepted <redacted>');
    expect(JSON.stringify(captured)).not.toContain('private-query-value');
    expect((captured as { details?: Record<string, unknown> }).details?.sessionPreserved).toBe(true);
    expect((captured as { details?: Record<string, unknown> }).details?.providerCode).toBe('ELEMENT_NOT_FOUND');
    expect(readInteractionSession(value.repoRoot, 'ios-device', interactionId)?.status).toBe('waiting_for_user');
    expect(commands.some((command) => command[1] === 'close')).toBe(false);
  });

  it('serializes all session actions and never exposes arbitrary or nested MCP execution', () => {
    const actions = Object.fromEntries(iosAgentDeviceActions().map((action) => [action.actionId, action]));
    for (const actionId of ['agent_device_open', 'agent_device_batch', 'agent_device_press', 'agent_device_fill', 'agent_device_scroll', 'agent_device_screenshot', 'agent_device_close']) {
      expect(actions[actionId]?.confirmation).toBe(actionId === 'agent_device_screenshot' ? 'none' : 'authorization');
      expect(actions[actionId]?.resourceClaims).toEqual(expect.arrayContaining([
        { resource: 'repo-state', mode: 'write' },
      ]));
    }
    for (const action of Object.values(actions)) {
      expect(action.actionId).not.toContain('mcp');
      expect(JSON.stringify(action.argumentsSchema)).not.toContain('command');
      expect(JSON.stringify(action.argumentsSchema)).not.toContain('args');
    }
  });
});
