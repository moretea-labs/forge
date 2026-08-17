import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  executeIosPhysicalDeviceAction,
  resetIosPhysicalDeviceRuntimeHooksForTest,
  setIosPhysicalDeviceRuntimeHooksForTest,
} from '../../src/runtime/plugins/ios-physical-device';
import {
  resetRemoteXpcHidForTest,
  setRemoteXpcHidExecutorForTest,
} from '../../src/runtime/plugins/ios/remote-xpc-hid';
import { AssistantPluginError } from '../../src/runtime/plugins/errors';

const roots: string[] = [];

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-ios-physical-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-ios-physical-controller-'));
  roots.push(repoRoot, controllerHome);
  return { repoRoot, controllerHome, repoId: 'repo-ios-physical-test' };
}

function input(
  value: ReturnType<typeof fixture>,
  actionId: string,
  args: Record<string, unknown>,
) {
  return {
    controllerHome: value.controllerHome,
    repoId: value.repoId,
    repoRoot: value.repoRoot,
    pluginId: 'ios',
    actionId,
    requestId: `request-${actionId}`,
    args,
    origin: { surface: 'local-ui' as const, actor: 'test' },
  };
}

function json(result: Record<string, unknown>): string {
  return JSON.stringify({ info: { outcome: 'success' }, result });
}

function deviceEntry() {
  return {
    identifier: 'CORE-DEVICE-1',
    hardwareProperties: {
      udid: '00008150-TEST',
      marketingName: 'iPhone 17',
      productType: 'iPhone18,3',
      reality: 'physical',
      platform: 'iOS',
    },
    deviceProperties: {
      name: 'greyson',
      osVersionNumber: '27.0',
      osBuildUpdate: '24A000',
      bootState: 'booted',
      developerModeStatus: 'enabled',
      ddiServicesAvailable: true,
      screenViewingURL: 'devices://device/open?id=CORE-DEVICE-1',
    },
    connectionProperties: {
      pairingState: 'paired',
      tunnelState: 'connected',
      transportType: 'usb',
    },
    capabilities: [
      { name: 'Application Control' },
      { name: 'Capture Screenshot' },
      { name: 'Get Display Information' },
      { name: 'Get Lock State' },
      { name: 'View Device Screen' },
      { name: 'HID Digitizer' },
      { name: 'HID Keyboard' },
      { name: 'HID Scroll' },
      { name: 'HID Button' },
      { name: 'Universal HID Service Pool' },
    ],
  };
}

afterEach(() => {
  resetIosPhysicalDeviceRuntimeHooksForTest();
  resetRemoteXpcHidForTest();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('CoreDevice-first physical iPhone provider', () => {
  it('yields the event loop while a CoreDevice action subprocess is pending', async () => {
    const value = fixture();
    let releaseList!: () => void;
    let markListStarted!: () => void;
    const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
    const listStarted = new Promise<void>((resolve) => { markListStarted = resolve; });

    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommandAsync: async (command, args) => {
        if (args[0] === 'devicectl' && args[1] === '--version') {
          return { ok: true, status: 0, stdout: '636.3\n', stderr: '', command: [command, ...args] };
        }
        if (args.join(' ').includes('list devices')) {
          markListStarted();
          await listGate;
          return { ok: true, status: 0, stdout: json({ devices: [deviceEntry()] }), stderr: '', command: [command, ...args] };
        }
        throw new Error(`unexpected async command: ${[command, ...args].join(' ')}`);
      },
    });

    const action = executeIosPhysicalDeviceAction(input(value, 'physical_device_list', {}));
    await listStarted;
    let timerFired = false;
    setTimeout(() => { timerFired = true; }, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(timerFired).toBe(true);

    releaseList();
    const result = await action;
    expect((result.devices as Array<{ identifier: string }>)[0]?.identifier).toBe('CORE-DEVICE-1');
  });

  it('opens, types, and screenshots without probing or creating a semantic Runner session', async () => {
    const value = fixture();
    const commands: string[][] = [];
    setRemoteXpcHidExecutorForTest(async (request) => ({
      backend: 'remote-xpc-hid', reusedWorker: true,
      endpoint: { host: 'fd00::1', port: 53194 }, result: { action: request.action },
      timings: { workerStartupMs: 0, workerReadyMs: 0, requestMs: 40, hidMs: 36 },
    }));

    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-08-17T08:00:00.000Z'),
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === 'devicectl' && args[1] === '--version') {
          return { ok: true, status: 0, stdout: '636.3\n', stderr: '', command: [command, ...args] };
        }
        const joined = args.join(' ');
        if (joined.includes('list devices')) {
          return { ok: true, status: 0, stdout: json({ devices: [deviceEntry()] }), stderr: '', command: [command, ...args] };
        }
        if (joined.includes('device info apps')) {
          return {
            ok: true, status: 0,
            stdout: json({ apps: [{ name: '小红书', bundleIdentifier: 'com.xingin.discover', bundleVersion: '1', version: '1.0', removable: true }] }),
            stderr: '', command: [command, ...args],
          };
        }
        if (joined.includes('device info lockState')) {
          return { ok: true, status: 0, stdout: json({ passcodeRequired: false, unlockedSinceBoot: true }), stderr: '', command: [command, ...args] };
        }
        if (joined.includes('device process launch')) {
          return { ok: true, status: 0, stdout: json({ processIdentifier: 123, launchOptions: { activatedWhenStarted: true } }), stderr: '', command: [command, ...args] };
        }
        if (joined.includes('device capture screenshot')) {
          const destination = args[args.indexOf('--destination') + 1]!;
          writeFileSync(destination, 'png');
          return { ok: true, status: 0, stdout: json({ destination }), stderr: '', command: [command, ...args] };
        }
        throw new Error(`unexpected command: ${[command, ...args].join(' ')}`);
      },
    });

    const opened = await executeIosPhysicalDeviceAction(input(value, 'physical_device_open', {
      device: 'greyson', bundle_id: 'com.xingin.discover',
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    expect(opened.provider).toBe('coredevice');
    expect(opened.controlPlane).toMatchObject({ lifecycle: 'coredevice', observation: 'coredevice', semanticFallback: 'agent-device', runnerOwned: false });
    const typed = await executeIosPhysicalDeviceAction(input(value, 'physical_device_type_text', {
      interaction_id: interactionId, text: 'Forge123',
    }));
    expect(typed.text).toBe('<redacted>');
    expect(commands.some((argv) => argv.join(' ').includes('device info displays'))).toBe(false);

    const screenshot = await executeIosPhysicalDeviceAction(input(value, 'physical_device_screenshot', {
      interaction_id: interactionId, label: 'xhs',
    }));
    const artifact = (screenshot.artifactCandidates as Array<Record<string, unknown>>)[0]!;
    expect(existsSync(String(artifact.path))).toBe(true);
    expect(commands.some((argv) => argv.includes('xcodebuild'))).toBe(false);
    expect(commands.some((argv) => argv.includes('prepare'))).toBe(false);

    const closed = await executeIosPhysicalDeviceAction(input(value, 'physical_device_close', { interaction_id: interactionId }));
    expect(closed.inputWorkerRelease).toMatchObject({ backend: 'remote-xpc-hid', state: 'stopped', runnerOwned: false });
  });

  it('reconciles an expired physical session before resource-conflict detection', async () => {
    const value = fixture();
    let now = new Date('2026-08-17T08:00:00.000Z');
    let launchCount = 0;
    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => now,
      runCommand: (command, args) => {
        if (args[0] === 'devicectl' && args[1] === '--version') return { ok: true, status: 0, stdout: '636.3\n', stderr: '', command: [command, ...args] };
        const joined = args.join(' ');
        if (joined.includes('list devices')) return { ok: true, status: 0, stdout: json({ devices: [deviceEntry()] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info apps')) return { ok: true, status: 0, stdout: json({ apps: [{ name: '小红书', bundleIdentifier: 'com.xingin.discover' }] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info lockState')) return { ok: true, status: 0, stdout: json({ passcodeRequired: false, unlockedSinceBoot: true }), stderr: '', command: [command, ...args] };
        if (joined.includes('device process launch')) {
          launchCount += 1;
          return { ok: true, status: 0, stdout: json({ processIdentifier: 100 + launchCount, launchOptions: { activatedWhenStarted: true } }), stderr: '', command: [command, ...args] };
        }
        throw new Error(`unexpected command: ${[command, ...args].join(' ')}`);
      },
    });

    const first = await executeIosPhysicalDeviceAction(input(value, 'physical_device_open', {
      device: 'greyson', bundle_id: 'com.xingin.discover',
    }));
    const firstInteractionId = String((first.interaction as Record<string, unknown>).interactionId);
    now = new Date('2026-08-17T10:00:01.000Z');

    const second = await executeIosPhysicalDeviceAction(input(value, 'physical_device_open', {
      device: 'greyson', bundle_id: 'com.xingin.discover',
    }));
    expect((second.interaction as Record<string, unknown>).status).toBe('waiting_for_user');
    expect(launchCount).toBe(2);

    const oldClose = await executeIosPhysicalDeviceAction(input(value, 'physical_device_close', { interaction_id: firstInteractionId }));
    expect(oldClose.alreadyClosed).toBe(true);
    expect((oldClose.interaction as Record<string, unknown>).status).toBe('failed');
  });

  it('fails initial open when CoreDevice does not confirm foreground activation and releases the failed interaction fence', async () => {
    const value = fixture();
    let launchCount = 0;
    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        if (args[0] === 'devicectl' && args[1] === '--version') return { ok: true, status: 0, stdout: '636.3\\n', stderr: '', command: [command, ...args] };
        const joined = args.join(' ');
        if (joined.includes('list devices')) return { ok: true, status: 0, stdout: json({ devices: [deviceEntry()] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info apps')) return { ok: true, status: 0, stdout: json({ apps: [{ name: '小红书', bundleIdentifier: 'com.xingin.discover' }] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info lockState')) return { ok: true, status: 0, stdout: json({ passcodeRequired: false, unlockedSinceBoot: true }), stderr: '', command: [command, ...args] };
        if (joined.includes('device process launch')) {
          launchCount += 1;
          return {
            ok: true, status: 0,
            stdout: json({ processIdentifier: 123, launchOptions: { activatedWhenStarted: launchCount > 1 } }),
            stderr: '', command: [command, ...args],
          };
        }
        throw new Error(`unexpected command: ${[command, ...args].join(' ')}`);
      },
    });

    await expect(executeIosPhysicalDeviceAction(input(value, 'physical_device_open', {
      device: 'greyson', bundle_id: 'com.xingin.discover',
    }))).rejects.toMatchObject({ code: 'IOS_DEVICE_FOREGROUND_ACTIVATION_UNCONFIRMED', retryable: true });
    const opened = await executeIosPhysicalDeviceAction(input(value, 'physical_device_open', {
      device: 'greyson', bundle_id: 'com.xingin.discover',
    }));
    expect((opened.interaction as Record<string, unknown>).status).toBe('waiting_for_user');
    expect(launchCount).toBe(2);
  });

  it('fails early with a retryable lock-state error instead of misclassifying CoreDevice launch failure', async () => {
    const value = fixture();
    const commands: string[][] = [];
    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === 'devicectl' && args[1] === '--version') {
          return { ok: true, status: 0, stdout: '636.3\n', stderr: '', command: [command, ...args] };
        }
        const joined = args.join(' ');
        if (joined.includes('list devices')) return { ok: true, status: 0, stdout: json({ devices: [deviceEntry()] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info apps')) return { ok: true, status: 0, stdout: json({ apps: [{ name: 'Test', bundleIdentifier: 'com.example.locked' }] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info lockState')) return { ok: true, status: 0, stdout: json({ passcodeRequired: true, unlockedSinceBoot: true }), stderr: '', command: [command, ...args] };
        throw new Error(`unexpected command: ${[command, ...args].join(' ')}`);
      },
    });

    try {
      await executeIosPhysicalDeviceAction(input(value, 'physical_device_open', { device: 'greyson', bundle_id: 'com.example.locked' }));
      throw new Error('expected physical_device_open to reject');
    } catch (error) {
      expect(error).toMatchObject({ code: 'IOS_DEVICE_LOCKED', retryable: true });
    }
    expect(commands.some((argv) => argv.join(' ').includes('device process launch'))).toBe(false);
  });

  it('routes tap, swipe, and text through runnerless RemoteXPC HID with current display pixels', async () => {
    const value = fixture();
    const commands: string[][] = [];
    const hidCalls: Array<Record<string, unknown>> = [];
    let callCount = 0;
    setRemoteXpcHidExecutorForTest(async (request) => {
      hidCalls.push({ ...request, text: request.text === undefined ? undefined : '<redacted>' });
      callCount += 1;
      return {
        backend: 'remote-xpc-hid',
        reusedWorker: callCount > 1,
        endpoint: { host: 'fd00::1', port: 53194 },
        result: { action: request.action },
        timings: {
          workerStartupMs: callCount === 1 ? 420 : 0,
          workerReadyMs: callCount === 1 ? 80 : 0,
          requestMs: request.action === 'swipe' ? 310 : 120,
          hidMs: request.action === 'swipe' ? 280 : 60,
        },
      };
    });
    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-08-17T08:00:00.000Z'),
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === 'devicectl' && args[1] === '--version') {
          return { ok: true, status: 0, stdout: '636.3\n', stderr: '', command: [command, ...args] };
        }
        const joined = args.join(' ');
        if (joined.includes('list devices')) return { ok: true, status: 0, stdout: json({ devices: [deviceEntry()] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info apps')) return { ok: true, status: 0, stdout: json({ apps: [{ name: '小红书', bundleIdentifier: 'com.xingin.discover' }] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info lockState')) return { ok: true, status: 0, stdout: json({ passcodeRequired: false, unlockedSinceBoot: true }), stderr: '', command: [command, ...args] };
        if (joined.includes('device process launch')) return { ok: true, status: 0, stdout: json({ processIdentifier: 123, launchOptions: { activatedWhenStarted: true } }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info displays')) {
          return { ok: true, status: 0, stdout: json({ displays: [{ bounds: [[0, 0], [1206, 2622]], nativeSize: [1206, 2622], pointScale: 3, primary: true }] }), stderr: '', command: [command, ...args] };
        }
        throw new Error(`unexpected command: ${[command, ...args].join(' ')}`);
      },
    });

    const opened = await executeIosPhysicalDeviceAction(input(value, 'physical_device_open', {
      device: 'greyson', bundle_id: 'com.xingin.discover', relaunch: true, prewarm_input: true,
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    expect(opened.controlPlane).toMatchObject({ input: 'remote-xpc-hid', runnerOwned: false });
    expect(opened.inputPrewarm).toMatchObject({ backend: 'remote-xpc-hid', state: 'test', runnerOwned: false });

    const tapped = await executeIosPhysicalDeviceAction(input(value, 'physical_device_tap', {
      interaction_id: interactionId, x: 1082, y: 2456,
    }));
    expect(tapped.inputBackend).toBe('remote-xpc-hid');
    expect(tapped.display).toEqual({ width: 1206, height: 2622, pointScale: 3 });

    await executeIosPhysicalDeviceAction(input(value, 'physical_device_swipe', {
      interaction_id: interactionId, x: 600, y: 2100, to_x: 600, to_y: 600, duration_ms: 280,
    }));
    const typed = await executeIosPhysicalDeviceAction(input(value, 'physical_device_type_text', {
      interaction_id: interactionId, text: 'Forge123',
    }));
    expect(typed.text).toBe('<redacted>');
    expect(hidCalls).toHaveLength(3);
    expect(hidCalls[0]).toMatchObject({
      controllerHome: value.controllerHome,
      deviceIdentifier: 'CORE-DEVICE-1', udid: '00008150-TEST',
      width: 1206, height: 2622, action: 'tap', x: 1082, y: 2456,
    });
    expect(hidCalls[1]).toMatchObject({ action: 'swipe', x: 600, y: 2100, x2: 600, y2: 600, durationMs: 280 });
    expect(hidCalls[2]).toMatchObject({ action: 'type', text: '<redacted>' });
    expect(hidCalls[2]).not.toHaveProperty('width');
    expect(hidCalls[2]).not.toHaveProperty('height');
    const launches = commands.filter((argv) => argv.join(' ').includes('device process launch'));
    expect(launches).toHaveLength(4);
    expect(launches[0]).toContain('--terminate-existing');
    expect(launches[0]).toContain('--activate');
    for (const launch of launches.slice(1)) {
      expect(launch).toContain('--activate');
      expect(launch).not.toContain('--terminate-existing');
    }
    const versions = commands.filter((argv) => argv[0] === 'xcrun' && argv[1] === 'devicectl' && argv[2] === '--version');
    const locks = commands.filter((argv) => argv.join(' ').includes('device info lockState'));
    const displays = commands.filter((argv) => argv.join(' ').includes('device info displays'));
    expect(versions).toHaveLength(1);
    expect(locks).toHaveLength(1);
    expect(displays).toHaveLength(1);
    expect(commands.some((argv) => argv.includes('xcodebuild'))).toBe(false);
    expect(commands.some((argv) => argv.includes('prepare'))).toBe(false);
    expect(commands.some((argv) => argv.some((arg) => arg.includes('agent-device')))).toBe(false);

    const events = await executeIosPhysicalDeviceAction(input(value, 'physical_device_events', { interaction_id: interactionId }));
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('Forge123');
    expect(serialized).toContain('type_text');
  });

  it('batches known form edits with one foreground activation and runnerless Unicode replacement', async () => {
    const value = fixture();
    const commands: string[][] = [];
    const hidCalls: Array<Record<string, unknown>> = [];
    setRemoteXpcHidExecutorForTest(async (request) => {
      hidCalls.push({ ...request, text: request.text === undefined ? undefined : '<redacted>' });
      return {
        backend: 'remote-xpc-hid', reusedWorker: hidCalls.length > 1,
        endpoint: { host: 'fd00::1', port: 53194 },
        result: { action: request.action, ...(request.action === 'type' ? { inputMode: 'pasteboard' } : {}) },
        timings: { workerStartupMs: hidCalls.length === 1 ? 120 : 0, workerReadyMs: 0, requestMs: 50, hidMs: 40 },
      };
    });
    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-08-17T08:00:00.000Z'),
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === 'devicectl' && args[1] === '--version') return { ok: true, status: 0, stdout: '636.3\n', stderr: '', command: [command, ...args] };
        const joined = args.join(' ');
        if (joined.includes('list devices')) return { ok: true, status: 0, stdout: json({ devices: [deviceEntry()] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info apps')) return { ok: true, status: 0, stdout: json({ apps: [{ name: '小红书', bundleIdentifier: 'com.xingin.discover' }] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info lockState')) return { ok: true, status: 0, stdout: json({ passcodeRequired: false, unlockedSinceBoot: true }), stderr: '', command: [command, ...args] };
        if (joined.includes('device process launch')) return { ok: true, status: 0, stdout: json({ processIdentifier: 123, launchOptions: { activatedWhenStarted: true } }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info displays')) return { ok: true, status: 0, stdout: json({ displays: [{ bounds: [[0, 0], [1206, 2622]], nativeSize: [1206, 2622], pointScale: 3, primary: true }] }), stderr: '', command: [command, ...args] };
        throw new Error(`unexpected command: ${[command, ...args].join(' ')}`);
      },
    });

    const opened = await executeIosPhysicalDeviceAction(input(value, 'physical_device_open', {
      device: 'greyson', bundle_id: 'com.xingin.discover',
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    const batched = await executeIosPhysicalDeviceAction(input(value, 'physical_device_batch', {
      interaction_id: interactionId,
      steps: [
        { kind: 'tap', x: 600, y: 900 },
        { kind: 'wait', duration_ms: 0 },
        { kind: 'type', text: '小红书资料', input_mode: 'auto', replace_existing: true },
        { kind: 'swipe', x: 600, y: 1800, to_x: 600, to_y: 900, duration_ms: 200 },
      ],
    }));

    expect(hidCalls).toHaveLength(3);
    expect(hidCalls[0]).toMatchObject({ action: 'tap', width: 1206, height: 2622, x: 600, y: 900 });
    expect(hidCalls[1]).toMatchObject({ action: 'type', text: '<redacted>', textMode: 'auto', replaceExisting: true });
    expect(hidCalls[1]).not.toHaveProperty('width');
    expect(hidCalls[1]).not.toHaveProperty('height');
    expect(hidCalls[2]).toMatchObject({ action: 'swipe', width: 1206, height: 2622, x: 600, y: 1800, x2: 600, y2: 900 });
    expect(batched.executionPlan).toEqual({
      foregroundActivations: 1,
      unlockChecks: 0,
      displayLookups: 1,
      pluginRoundTrips: 1,
      runnerOwned: false,
    });
    expect((batched.completed as Array<Record<string, unknown>>)[2]).toMatchObject({ kind: 'type', inputMode: 'pasteboard' });

    const launches = commands.filter((argv) => argv.join(' ').includes('device process launch'));
    const locks = commands.filter((argv) => argv.join(' ').includes('device info lockState'));
    const displays = commands.filter((argv) => argv.join(' ').includes('device info displays'));
    expect(launches).toHaveLength(2);
    expect(locks).toHaveLength(1);
    expect(displays).toHaveLength(1);
    expect(commands.some((argv) => argv.includes('xcodebuild'))).toBe(false);
    expect(commands.some((argv) => argv.some((arg) => arg.includes('agent-device')))).toBe(false);

    const events = await executeIosPhysicalDeviceAction(input(value, 'physical_device_events', { interaction_id: interactionId }));
    expect(JSON.stringify(events)).not.toContain('小红书资料');
    expect(JSON.stringify(events)).toContain('batch_input');
  });

  it('preflights every touch coordinate before dispatching any batch mutation', async () => {
    const value = fixture();
    const commands: string[][] = [];
    let hidCalls = 0;
    setRemoteXpcHidExecutorForTest(async (request) => {
      hidCalls += 1;
      return {
        backend: 'remote-xpc-hid', reusedWorker: true,
        endpoint: { host: 'fd00::1', port: 53194 }, result: { action: request.action },
        timings: { workerStartupMs: 0, workerReadyMs: 0, requestMs: 1, hidMs: 1 },
      };
    });
    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-08-17T08:00:00.000Z'),
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === 'devicectl' && args[1] === '--version') return { ok: true, status: 0, stdout: '636.3\n', stderr: '', command: [command, ...args] };
        const joined = args.join(' ');
        if (joined.includes('list devices')) return { ok: true, status: 0, stdout: json({ devices: [deviceEntry()] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info apps')) return { ok: true, status: 0, stdout: json({ apps: [{ name: '小红书', bundleIdentifier: 'com.xingin.discover' }] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info lockState')) return { ok: true, status: 0, stdout: json({ passcodeRequired: false, unlockedSinceBoot: true }), stderr: '', command: [command, ...args] };
        if (joined.includes('device process launch')) return { ok: true, status: 0, stdout: json({ processIdentifier: 123, launchOptions: { activatedWhenStarted: true } }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info displays')) return { ok: true, status: 0, stdout: json({ displays: [{ bounds: [[0, 0], [1206, 2622]], primary: true }] }), stderr: '', command: [command, ...args] };
        throw new Error(`unexpected command: ${[command, ...args].join(' ')}`);
      },
    });
    const opened = await executeIosPhysicalDeviceAction(input(value, 'physical_device_open', {
      device: 'greyson', bundle_id: 'com.xingin.discover',
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    await expect(executeIosPhysicalDeviceAction(input(value, 'physical_device_batch', {
      interaction_id: interactionId,
      steps: [
        { kind: 'tap', x: 600, y: 900 },
        { kind: 'tap', x: 5000, y: 900 },
      ],
    }))).rejects.toMatchObject({ code: 'IOS_HID_COORDINATE_OUT_OF_BOUNDS', retryable: false });
    expect(hidCalls).toBe(0);
    const launches = commands.filter((argv) => argv.join(' ').includes('device process launch'));
    expect(launches).toHaveLength(1);
  });

  it('allows a whole-batch retry only when the input backend proves no mutation was sent', async () => {
    const value = fixture();
    let hidCalls = 0;
    setRemoteXpcHidExecutorForTest(async () => {
      hidCalls += 1;
      throw new AssistantPluginError('IOS_HID_INPUT_NOT_READY', 'worker still warming', {
        retryable: true,
        details: { mutationDispatched: false },
      });
    });
    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-08-17T08:00:00.000Z'),
      runCommand: (command, args) => {
        if (args[0] === 'devicectl' && args[1] === '--version') return { ok: true, status: 0, stdout: '636.3\n', stderr: '', command: [command, ...args] };
        const joined = args.join(' ');
        if (joined.includes('list devices')) return { ok: true, status: 0, stdout: json({ devices: [deviceEntry()] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info apps')) return { ok: true, status: 0, stdout: json({ apps: [{ name: '小红书', bundleIdentifier: 'com.xingin.discover' }] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info lockState')) return { ok: true, status: 0, stdout: json({ passcodeRequired: false, unlockedSinceBoot: true }), stderr: '', command: [command, ...args] };
        if (joined.includes('device process launch')) return { ok: true, status: 0, stdout: json({ processIdentifier: 123, launchOptions: { activatedWhenStarted: true } }), stderr: '', command: [command, ...args] };
        throw new Error(`unexpected command: ${[command, ...args].join(' ')}`);
      },
    });
    const opened = await executeIosPhysicalDeviceAction(input(value, 'physical_device_open', {
      device: 'greyson', bundle_id: 'com.xingin.discover',
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    try {
      await executeIosPhysicalDeviceAction(input(value, 'physical_device_batch', {
        interaction_id: interactionId,
        steps: [{ kind: 'type', text: '资料', replace_existing: true }],
      }));
      throw new Error('expected physical_device_batch to reject');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'IOS_HID_BATCH_FAILED', retryable: true,
        details: { completedMutations: 0, retryWholeBatch: true, causeCode: 'IOS_HID_INPUT_NOT_READY' },
      });
    }
    expect(hidCalls).toBe(1);
  });

  it('stops a partially-mutated physical batch without retrying earlier steps', async () => {
    const value = fixture();
    const commands: string[][] = [];
    let hidCalls = 0;
    setRemoteXpcHidExecutorForTest(async (request) => {
      hidCalls += 1;
      if (hidCalls === 2) throw new Error('synthetic type failure');
      return {
        backend: 'remote-xpc-hid', reusedWorker: true,
        endpoint: { host: 'fd00::1', port: 53194 }, result: { action: request.action },
        timings: { workerStartupMs: 0, workerReadyMs: 0, requestMs: 10, hidMs: 8 },
      };
    });
    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-08-17T08:00:00.000Z'),
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === 'devicectl' && args[1] === '--version') return { ok: true, status: 0, stdout: '636.3\n', stderr: '', command: [command, ...args] };
        const joined = args.join(' ');
        if (joined.includes('list devices')) return { ok: true, status: 0, stdout: json({ devices: [deviceEntry()] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info apps')) return { ok: true, status: 0, stdout: json({ apps: [{ name: '小红书', bundleIdentifier: 'com.xingin.discover' }] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info lockState')) return { ok: true, status: 0, stdout: json({ passcodeRequired: false, unlockedSinceBoot: true }), stderr: '', command: [command, ...args] };
        if (joined.includes('device process launch')) return { ok: true, status: 0, stdout: json({ processIdentifier: 123, launchOptions: { activatedWhenStarted: true } }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info displays')) return { ok: true, status: 0, stdout: json({ displays: [{ bounds: [[0, 0], [1206, 2622]], primary: true }] }), stderr: '', command: [command, ...args] };
        throw new Error(`unexpected command: ${[command, ...args].join(' ')}`);
      },
    });
    const opened = await executeIosPhysicalDeviceAction(input(value, 'physical_device_open', {
      device: 'greyson', bundle_id: 'com.xingin.discover',
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    try {
      await executeIosPhysicalDeviceAction(input(value, 'physical_device_batch', {
        interaction_id: interactionId,
        steps: [
          { kind: 'tap', x: 600, y: 900 },
          { kind: 'type', text: '不会重放', replace_existing: true },
          { kind: 'tap', x: 900, y: 2200 },
        ],
      }));
      throw new Error('expected physical_device_batch to reject');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'IOS_HID_BATCH_FAILED', retryable: false,
        details: { failedStepIndex: 1, completedSteps: 1, completedMutations: 1, retryWholeBatch: false },
      });
    }
    expect(hidCalls).toBe(2);
    const launches = commands.filter((argv) => argv.join(' ').includes('device process launch'));
    expect(launches).toHaveLength(2);
  });

  it('fails closed before HID when CoreDevice does not confirm foreground activation', async () => {
    const value = fixture();
    const commands: string[][] = [];
    let hidDispatched = false;
    let launchCount = 0;
    setRemoteXpcHidExecutorForTest(async (request) => {
      hidDispatched = true;
      return {
        backend: 'remote-xpc-hid', reusedWorker: true,
        endpoint: { host: 'fd00::1', port: 53194 }, result: { action: request.action },
        timings: { workerStartupMs: 0, workerReadyMs: 0, requestMs: 0, hidMs: 0 },
      };
    });
    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-08-17T08:00:00.000Z'),
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === 'devicectl' && args[1] === '--version') {
          return { ok: true, status: 0, stdout: '636.3\n', stderr: '', command: [command, ...args] };
        }
        const joined = args.join(' ');
        if (joined.includes('list devices')) return { ok: true, status: 0, stdout: json({ devices: [deviceEntry()] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info apps')) return { ok: true, status: 0, stdout: json({ apps: [{ name: '小红书', bundleIdentifier: 'com.xingin.discover' }] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info lockState')) return { ok: true, status: 0, stdout: json({ passcodeRequired: false, unlockedSinceBoot: true }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info displays')) {
          return { ok: true, status: 0, stdout: json({ displays: [{ bounds: [[0, 0], [1206, 2622]], nativeSize: [1206, 2622], pointScale: 3, primary: true }] }), stderr: '', command: [command, ...args] };
        }
        if (joined.includes('device process launch')) {
          launchCount += 1;
          return {
            ok: true, status: 0,
            stdout: json({ processIdentifier: 123, launchOptions: { activatedWhenStarted: launchCount === 1 } }),
            stderr: '', command: [command, ...args],
          };
        }
        throw new Error(`unexpected command: ${[command, ...args].join(' ')}`);
      },
    });

    const opened = await executeIosPhysicalDeviceAction(input(value, 'physical_device_open', {
      device: 'greyson', bundle_id: 'com.xingin.discover', prewarm_input: true,
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    await expect(executeIosPhysicalDeviceAction(input(value, 'physical_device_tap', {
      interaction_id: interactionId, x: 1082, y: 2456,
    }))).rejects.toMatchObject({ code: 'IOS_DEVICE_FOREGROUND_ACTIVATION_UNCONFIRMED', retryable: true });
    expect(hidDispatched).toBe(false);
    const launches = commands.filter((argv) => argv.join(' ').includes('device process launch'));
    expect(launches).toHaveLength(2);
    expect(launches[1]).toContain('--activate');
    expect(launches[1]).not.toContain('--terminate-existing');
  });

  it('surfaces CoreDevice display, lock, View Device Screen, and HID capabilities without a Runner', async () => {
    const value = fixture();
    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        if (args[0] === 'devicectl' && args[1] === '--version') {
          return { ok: true, status: 0, stdout: '636.3\n', stderr: '', command: [command, ...args] };
        }
        const joined = args.join(' ');
        if (joined.includes('list devices')) {
          return { ok: true, status: 0, stdout: json({ devices: [deviceEntry()] }), stderr: '', command: [command, ...args] };
        }
        if (joined.includes('device info details')) {
          return { ok: true, status: 0, stdout: json(deviceEntry()), stderr: '', command: [command, ...args] };
        }
        if (joined.includes('device info lockState')) {
          return { ok: true, status: 0, stdout: json({ passcodeRequired: false, unlockedSinceBoot: true }), stderr: '', command: [command, ...args] };
        }
        if (joined.includes('device info displays')) {
          return { ok: true, status: 0, stdout: json({ displays: [{ nativeBounds: { width: 1206, height: 2622 }, pointScale: 3 }] }), stderr: '', command: [command, ...args] };
        }
        throw new Error(`unexpected command: ${[command, ...args].join(' ')}`);
      },
    });

    const info = await executeIosPhysicalDeviceAction(input(value, 'physical_device_info', { device: 'greyson' }));
    expect(info.screenViewingURL).toBe('devices://device/open?id=CORE-DEVICE-1');
    expect(info.capabilities).toEqual({
      applicationControl: true,
      screenshot: true,
      displayInfo: true,
      lockState: true,
      viewDeviceScreen: true,
      hidDigitizer: true,
      hidKeyboard: true,
      hidScroll: true,
      hidButton: true,
      universalHid: true,
    });
  });

});
