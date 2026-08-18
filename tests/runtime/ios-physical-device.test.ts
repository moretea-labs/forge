import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  executeIosPhysicalDeviceAction,
  resetIosPhysicalDeviceRuntimeHooksForTest,
  resolveIosPhysicalDeviceAuthorizationContext,
  setIosPhysicalDeviceRuntimeHooksForTest,
} from '../../src/runtime/plugins/ios-physical-device';
import {
  resetRemoteXpcHidForTest,
  setRemoteXpcHidExecutorForTest,
} from '../../src/runtime/plugins/ios/remote-xpc-hid';
import { AssistantPluginError } from '../../src/runtime/plugins/errors';
import { readInteractionSession, writeInteractionSession } from '../../src/runtime/plugins/interaction-session';
import { registerRepository } from '../../src/cli/repositories/registry';
import { submitAssistantPluginAction } from '../../src/runtime/plugins/store';
import { listPluginCapabilityAuthorizations } from '../../src/runtime/plugins/capability-authorization-grants';

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

function maybeScreenshotCommand(command: string, args: string[]) {
  if (!args.join(' ').includes('device capture screenshot')) return undefined;
  const destination = args[args.indexOf('--destination') + 1]!;
  writeFileSync(destination, 'png');
  return { ok: true, status: 0, stdout: json({ destination }), stderr: '', command: [command, ...args] };
}

async function observeAndConfirmForeground(
  value: ReturnType<typeof fixture>,
  interactionId: string,
  bundleId = 'com.xingin.discover',
) {
  const screenshot = await executeIosPhysicalDeviceAction(input(value, 'physical_device_screenshot', {
    interaction_id: interactionId,
    label: 'foreground-proof',
  }));
  const observation = screenshot.observation as { observationId: string };
  await executeIosPhysicalDeviceAction(input(value, 'physical_device_confirm_foreground', {
    interaction_id: interactionId,
    observation_id: observation.observationId,
    bundle_id: bundleId,
  }));
  return observation.observationId;
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
  it('overlaps independent open preflights while keeping display readiness ahead of app activation', async () => {
    const value = fixture();
    const order: string[] = [];
    let preflightStarted = 0;
    let releasePreflight!: () => void;
    const preflightGate = new Promise<void>((resolve) => { releasePreflight = resolve; });
    const waitForPeer = async (label: string) => {
      order.push(`${label}-start`);
      preflightStarted += 1;
      if (preflightStarted === 2) releasePreflight();
      await Promise.race([
        preflightGate,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} did not overlap peer preflight`)), 250)),
      ]);
      order.push(`${label}-end`);
    };
    setRemoteXpcHidExecutorForTest(async (request) => ({
      backend: 'remote-xpc-hid', reusedWorker: true,
      endpoint: { host: 'fd00::1', port: 53194 }, result: { action: request.action },
      timings: { workerStartupMs: 0, workerReadyMs: 0, requestMs: 1, hidMs: 1 },
    }));
    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-08-17T08:00:00.000Z'),
      runCommand: (command, args) => {
        if (args[0] === 'devicectl' && args[1] === '--version') return { ok: true, status: 0, stdout: '636.3\n', stderr: '', command: [command, ...args] };
        throw new Error(`unexpected sync command: ${[command, ...args].join(' ')}`);
      },
      runCommandAsync: async (command, args) => {
        if (args[0] === 'devicectl' && args[1] === '--version') return { ok: true, status: 0, stdout: '636.3\n', stderr: '', command: [command, ...args] };
        const joined = args.join(' ');
        if (joined.includes('list devices')) return { ok: true, status: 0, stdout: json({ devices: [deviceEntry()] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info apps')) {
          await waitForPeer('apps');
          return { ok: true, status: 0, stdout: json({ apps: [{ name: '小红书', bundleIdentifier: 'com.xingin.discover' }] }), stderr: '', command: [command, ...args] };
        }
        if (joined.includes('device info lockState')) {
          await waitForPeer('lock');
          return { ok: true, status: 0, stdout: json({ passcodeRequired: false, unlockedSinceBoot: true }), stderr: '', command: [command, ...args] };
        }
        if (joined.includes('device info displays')) {
          order.push('display-start');
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push('display-end');
          return { ok: true, status: 0, stdout: json({ displays: [{ bounds: [[0, 0], [1206, 2622]], nativeSize: [1206, 2622], pointScale: 3, primary: true }] }), stderr: '', command: [command, ...args] };
        }
        if (joined.includes('device process launch')) {
          order.push('launch-start');
          expect(order).toContain('display-end');
          return { ok: true, status: 0, stdout: json({ processIdentifier: 123, launchOptions: { activatedWhenStarted: true } }), stderr: '', command: [command, ...args] };
        }
        throw new Error(`unexpected async command: ${[command, ...args].join(' ')}`);
      },
    });

    const opened = await executeIosPhysicalDeviceAction(input(value, 'physical_device_open', {
      device: 'greyson', bundle_id: 'com.xingin.discover', prewarm_input: true,
    }));
    expect(order.indexOf('apps-start')).toBeLessThan(order.indexOf('apps-end'));
    expect(order.indexOf('lock-start')).toBeLessThan(order.indexOf('lock-end'));
    expect(order.indexOf('apps-start')).toBeLessThan(Math.min(order.indexOf('apps-end'), order.indexOf('lock-end')));
    expect(order.indexOf('lock-start')).toBeLessThan(Math.min(order.indexOf('apps-end'), order.indexOf('lock-end')));
    expect(order.indexOf('display-end')).toBeLessThan(order.indexOf('launch-start'));
    expect(opened.inputPrewarm).toMatchObject({ backend: 'remote-xpc-hid', state: 'test' });
    const timing = opened.timing as { totalMs: number; stages: Record<string, { ms: number }> };
    expect(timing.stages.installedAppLookup.ms).toBeGreaterThanOrEqual(0);
    expect(timing.stages.lockState.ms).toBeGreaterThanOrEqual(0);
    expect(timing.stages.displayInfo.ms).toBeGreaterThanOrEqual(0);
    expect(timing.stages.activationRequest.ms).toBeGreaterThanOrEqual(0);
  });

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
    spawnSync('git', ['init', '-b', 'main'], { cwd: value.repoRoot, stdio: 'ignore' });
    const repository = registerRepository({ path: value.repoRoot, controllerHome: value.controllerHome });
    value.repoId = repository.repoId;
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
        const screenshotResult = maybeScreenshotCommand(command, args);
        if (screenshotResult) return screenshotResult;
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
        throw new Error(`unexpected command: ${[command, ...args].join(' ')}`);
      },
    });

    const openAuthorization = await resolveIosPhysicalDeviceAuthorizationContext(input(value, 'physical_device_open', {
      device: 'greyson', bundle_id: 'com.xingin.discover',
    }));
    expect(openAuthorization?.target).toMatchObject({
      kind: 'ios-physical-device',
      id: 'CORE-DEVICE-1',
    });
    expect(openAuthorization?.target.identityFingerprint).toHaveLength(64);

    const openedSubmission = await submitAssistantPluginAction(value.controllerHome, repository, {
      pluginId: 'ios', actionId: 'physical_device_open', requestId: 'physical-open-grant',
      args: { device: 'greyson', bundle_id: 'com.xingin.discover' }, origin: { surface: 'mcp', actor: 'principal:test-user' },
    });
    expect(openedSubmission.authorization).toMatchObject({ source: 'host_permission_model', reusable: true, established: true, capabilityId: 'ios-physical-device' });
    const opened = openedSubmission.result?.result as Record<string, unknown>;
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    expect(opened.provider).toBe('coredevice');
    expect(opened.controlPlane).toMatchObject({ lifecycle: 'coredevice', observation: 'coredevice', semanticFallback: 'agent-device', runnerOwned: false });
    expect(opened.foregroundVerification).toMatchObject({ authority: 'screenshot_observation', required: true });
    const sessionAuthorization = await resolveIosPhysicalDeviceAuthorizationContext(input(value, 'physical_device_type_text', {
      interaction_id: interactionId, text: 'Forge123',
    }));
    expect(sessionAuthorization?.target).toEqual(openAuthorization?.target);

    await observeAndConfirmForeground(value, interactionId);
    const typed = await executeIosPhysicalDeviceAction(input(value, 'physical_device_type_text', {
      interaction_id: interactionId, text: 'Forge123',
    }));
    expect(typed.text).toBe('<redacted>');
    expect(commands.some((argv) => argv.join(' ').includes('device info displays'))).toBe(false);

    const screenshotSubmission = await submitAssistantPluginAction(value.controllerHome, repository, {
      pluginId: 'ios', actionId: 'physical_device_screenshot', requestId: 'physical-screenshot-grant',
      args: { interaction_id: interactionId, label: 'xhs' }, origin: { surface: 'mcp', actor: 'principal:test-user' },
    });
    expect(screenshotSubmission.authorization).toMatchObject({ source: 'capability_grant', grantId: openedSubmission.authorization?.grantId });
    expect(listPluginCapabilityAuthorizations(value.controllerHome)).toHaveLength(1);
    const screenshot = screenshotSubmission.result?.result as Record<string, unknown>;
    const artifact = (screenshot.artifactCandidates as Array<Record<string, unknown>>)[0]!;
    expect(existsSync(String(artifact.path))).toBe(true);
    expect(commands.some((argv) => argv.includes('xcodebuild'))).toBe(false);
    expect(commands.some((argv) => argv.includes('prepare'))).toBe(false);

    const originalSession = readInteractionSession(value.repoRoot, 'ios-device', interactionId)!;
    writeInteractionSession(value.repoRoot, { ...originalSession, targetId: 'CORE-DEVICE-2' });
    try {
      await resolveIosPhysicalDeviceAuthorizationContext(input(value, 'physical_device_type_text', {
        interaction_id: interactionId, text: 'must-not-authorize',
      }));
      throw new Error('expected tampered session target to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(AssistantPluginError);
      expect((error as AssistantPluginError).code).toBe('IOS_DEVICE_AUTHORIZATION_TARGET_MISMATCH');
    } finally {
      writeInteractionSession(value.repoRoot, originalSession);
    }

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
        const screenshotResult = maybeScreenshotCommand(command, args);
        if (screenshotResult) return screenshotResult;
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

  it('treats CoreDevice activation metadata as a hint rather than foreground authority', async () => {
    const value = fixture();
    let launchCount = 0;
    let hidDispatched = false;
    setRemoteXpcHidExecutorForTest(async (request) => {
      hidDispatched = true;
      return { backend: 'remote-xpc-hid', reusedWorker: true, endpoint: { host: 'fd00::1', port: 53194 }, result: { action: request.action }, timings: { workerStartupMs: 0, workerReadyMs: 0, requestMs: 1, hidMs: 1 } };
    });
    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        const screenshotResult = maybeScreenshotCommand(command, args);
        if (screenshotResult) return screenshotResult;
        if (args[0] === 'devicectl' && args[1] === '--version') return { ok: true, status: 0, stdout: '636.3\n', stderr: '', command: [command, ...args] };
        const joined = args.join(' ');
        if (joined.includes('list devices')) return { ok: true, status: 0, stdout: json({ devices: [deviceEntry()] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info apps')) return { ok: true, status: 0, stdout: json({ apps: [{ name: '小红书', bundleIdentifier: 'com.xingin.discover' }] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info lockState')) return { ok: true, status: 0, stdout: json({ passcodeRequired: false, unlockedSinceBoot: true }), stderr: '', command: [command, ...args] };
        if (joined.includes('device process launch')) {
          launchCount += 1;
          return { ok: true, status: 0, stdout: json({ processIdentifier: 123, launchOptions: { activatedWhenStarted: false } }), stderr: '', command: [command, ...args] };
        }
        throw new Error(`unexpected command: ${[command, ...args].join(' ')}`);
      },
    });

    const opened = await executeIosPhysicalDeviceAction(input(value, 'physical_device_open', {
      device: 'greyson', bundle_id: 'com.xingin.discover',
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    expect(opened.foregroundVerification).toEqual({ authority: 'screenshot_observation', required: true, coreDeviceActivatedWhenStartedHint: false });
    await expect(executeIosPhysicalDeviceAction(input(value, 'physical_device_type_text', {
      interaction_id: interactionId, text: 'must-not-dispatch',
    }))).rejects.toMatchObject({ code: 'IOS_DEVICE_FOREGROUND_OBSERVATION_REQUIRED', retryable: true });
    expect(hidDispatched).toBe(false);
    expect(launchCount).toBe(1);
  });

  it('fails early with a retryable lock-state error instead of misclassifying CoreDevice launch failure', async () => {
    const value = fixture();
    const commands: string[][] = [];
    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        const screenshotResult = maybeScreenshotCommand(command, args);
        if (screenshotResult) return screenshotResult;
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
        const screenshotResult = maybeScreenshotCommand(command, args);
        if (screenshotResult) return screenshotResult;
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

    await observeAndConfirmForeground(value, interactionId);
    const tapped = await executeIosPhysicalDeviceAction(input(value, 'physical_device_tap', {
      interaction_id: interactionId, x: 1082, y: 2456,
    }));
    expect(tapped.inputBackend).toBe('remote-xpc-hid');
    expect(tapped.display).toEqual({ width: 1206, height: 2622, pointScale: 3 });

    await observeAndConfirmForeground(value, interactionId);
    await executeIosPhysicalDeviceAction(input(value, 'physical_device_swipe', {
      interaction_id: interactionId, x: 600, y: 2100, to_x: 600, to_y: 600, duration_ms: 280,
    }));
    await observeAndConfirmForeground(value, interactionId);
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
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain('--terminate-existing');
    expect(launches[0]).toContain('--activate');
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

  it('batches known form edits under one confirmed screenshot fence with runnerless Unicode replacement', async () => {
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
        const screenshotResult = maybeScreenshotCommand(command, args);
        if (screenshotResult) return screenshotResult;
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
    await observeAndConfirmForeground(value, interactionId);
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
      foregroundActivations: 0,
      foregroundObservationChecks: 1,
      foregroundObservationSource: 'explicit_confirmation',
      unlockChecks: 0,
      displayLookups: 1,
      pluginRoundTrips: 1,
      runnerOwned: false,
    });
    expect((batched.completed as Array<Record<string, unknown>>)[2]).toMatchObject({ kind: 'type', inputMode: 'pasteboard' });

    const launches = commands.filter((argv) => argv.join(' ').includes('device process launch'));
    const locks = commands.filter((argv) => argv.join(' ').includes('device info lockState'));
    const displays = commands.filter((argv) => argv.join(' ').includes('device info displays'));
    expect(launches).toHaveLength(1);
    expect(locks).toHaveLength(1);
    expect(displays).toHaveLength(1);
    expect(commands.some((argv) => argv.includes('xcodebuild'))).toBe(false);
    expect(commands.some((argv) => argv.some((arg) => arg.includes('agent-device')))).toBe(false);

    const events = await executeIosPhysicalDeviceAction(input(value, 'physical_device_events', { interaction_id: interactionId }));
    expect(JSON.stringify(events)).not.toContain('小红书资料');
    expect(JSON.stringify(events)).toContain('batch_input');
  });

  it('atomically consumes a fresh screenshot in one batch without a confirm_foreground round-trip', async () => {
    const value = fixture();
    const hidCalls: Array<Record<string, unknown>> = [];
    setRemoteXpcHidExecutorForTest(async (request) => {
      hidCalls.push({ ...request, text: request.text === undefined ? undefined : '<redacted>' });
      return {
        backend: 'remote-xpc-hid', reusedWorker: true,
        endpoint: { host: 'fd00::1', port: 53194 },
        result: { action: request.action, ...(request.action === 'type' ? { inputMode: 'pasteboard' } : {}) },
        timings: { workerStartupMs: 0, workerReadyMs: 0, requestMs: 5, hidMs: 3 },
      };
    });
    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-08-17T08:00:00.000Z'),
      runCommand: (command, args) => {
        const screenshotResult = maybeScreenshotCommand(command, args);
        if (screenshotResult) return screenshotResult;
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
    const screenshot = await executeIosPhysicalDeviceAction(input(value, 'physical_device_screenshot', {
      interaction_id: interactionId, label: 'atomic-batch-proof',
    }));
    const observationId = String((screenshot.observation as Record<string, unknown>).observationId);

    const batched = await executeIosPhysicalDeviceAction(input(value, 'physical_device_batch', {
      interaction_id: interactionId,
      observation_id: observationId,
      steps: [{ kind: 'type', text: '慢慢变富', input_mode: 'auto', replace_existing: true }],
    }));
    expect(hidCalls).toHaveLength(1);
    expect(hidCalls[0]).toMatchObject({ action: 'type', text: '<redacted>', textMode: 'auto', replaceExisting: true });
    expect(batched.foregroundObservation).toMatchObject({ observationId, source: 'atomic_screenshot', consumed: true });
    expect(batched.executionPlan).toMatchObject({ foregroundObservationChecks: 1, foregroundObservationSource: 'atomic_screenshot', pluginRoundTrips: 1 });

    await expect(executeIosPhysicalDeviceAction(input(value, 'physical_device_batch', {
      interaction_id: interactionId,
      observation_id: observationId,
      steps: [{ kind: 'type', text: 'must-not-replay' }],
    }))).rejects.toMatchObject({ code: 'IOS_DEVICE_SCREEN_OBSERVATION_REQUIRED', retryable: true });
    expect(hidCalls).toHaveLength(1);

    const events = await executeIosPhysicalDeviceAction(input(value, 'physical_device_events', { interaction_id: interactionId }));
    expect(JSON.stringify(events)).not.toContain('慢慢变富');
    expect(JSON.stringify(events)).not.toContain('foreground_confirmed');
  });

  it('rejects superseded and stale atomic batch observations before HID dispatch', async () => {
    const value = fixture();
    let now = new Date('2026-08-17T08:00:00.000Z');
    let hidCalls = 0;
    setRemoteXpcHidExecutorForTest(async (request) => {
      hidCalls += 1;
      return { backend: 'remote-xpc-hid', reusedWorker: true, endpoint: { host: 'fd00::1', port: 53194 }, result: { action: request.action }, timings: { workerStartupMs: 0, workerReadyMs: 0, requestMs: 1, hidMs: 1 } };
    });
    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => now,
      runCommand: (command, args) => {
        const screenshotResult = maybeScreenshotCommand(command, args);
        if (screenshotResult) return screenshotResult;
        if (args[0] === 'devicectl' && args[1] === '--version') return { ok: true, status: 0, stdout: '636.3\n', stderr: '', command: [command, ...args] };
        const joined = args.join(' ');
        if (joined.includes('list devices')) return { ok: true, status: 0, stdout: json({ devices: [deviceEntry()] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info apps')) return { ok: true, status: 0, stdout: json({ apps: [{ name: '小红书', bundleIdentifier: 'com.xingin.discover' }] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info lockState')) return { ok: true, status: 0, stdout: json({ passcodeRequired: false, unlockedSinceBoot: true }), stderr: '', command: [command, ...args] };
        if (joined.includes('device process launch')) return { ok: true, status: 0, stdout: json({ processIdentifier: 123, launchOptions: { activatedWhenStarted: true } }), stderr: '', command: [command, ...args] };
        throw new Error(`unexpected command: ${[command, ...args].join(' ')}`);
      },
    });

    const opened = await executeIosPhysicalDeviceAction(input(value, 'physical_device_open', { device: 'greyson', bundle_id: 'com.xingin.discover' }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    const first = await executeIosPhysicalDeviceAction(input(value, 'physical_device_screenshot', { interaction_id: interactionId, label: 'first' }));
    const firstId = String((first.observation as Record<string, unknown>).observationId);
    const second = await executeIosPhysicalDeviceAction(input(value, 'physical_device_screenshot', { interaction_id: interactionId, label: 'second' }));
    const secondId = String((second.observation as Record<string, unknown>).observationId);

    await expect(executeIosPhysicalDeviceAction(input(value, 'physical_device_batch', {
      interaction_id: interactionId, observation_id: firstId, steps: [{ kind: 'type', text: 'must-not-dispatch' }],
    }))).rejects.toMatchObject({ code: 'IOS_DEVICE_SCREEN_OBSERVATION_REQUIRED', retryable: true });
    expect(hidCalls).toBe(0);

    now = new Date('2026-08-17T08:00:31.000Z');
    await expect(executeIosPhysicalDeviceAction(input(value, 'physical_device_batch', {
      interaction_id: interactionId, observation_id: secondId, steps: [{ kind: 'type', text: 'must-not-dispatch' }],
    }))).rejects.toMatchObject({ code: 'IOS_DEVICE_SCREEN_OBSERVATION_REQUIRED', retryable: true });
    expect(hidCalls).toBe(0);
  });

  it('rejects an observation from a closed prior session before HID dispatch', async () => {
    const value = fixture();
    let hidCalls = 0;
    setRemoteXpcHidExecutorForTest(async (request) => {
      hidCalls += 1;
      return { backend: 'remote-xpc-hid', reusedWorker: true, endpoint: { host: 'fd00::1', port: 53194 }, result: { action: request.action }, timings: { workerStartupMs: 0, workerReadyMs: 0, requestMs: 1, hidMs: 1 } };
    });
    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-08-17T08:00:00.000Z'),
      runCommand: (command, args) => {
        const screenshotResult = maybeScreenshotCommand(command, args);
        if (screenshotResult) return screenshotResult;
        if (args[0] === 'devicectl' && args[1] === '--version') return { ok: true, status: 0, stdout: '636.3\n', stderr: '', command: [command, ...args] };
        const joined = args.join(' ');
        if (joined.includes('list devices')) return { ok: true, status: 0, stdout: json({ devices: [deviceEntry()] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info apps')) return { ok: true, status: 0, stdout: json({ apps: [{ name: '小红书', bundleIdentifier: 'com.xingin.discover' }] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info lockState')) return { ok: true, status: 0, stdout: json({ passcodeRequired: false, unlockedSinceBoot: true }), stderr: '', command: [command, ...args] };
        if (joined.includes('device process launch')) return { ok: true, status: 0, stdout: json({ processIdentifier: 123, launchOptions: { activatedWhenStarted: true } }), stderr: '', command: [command, ...args] };
        throw new Error(`unexpected command: ${[command, ...args].join(' ')}`);
      },
    });

    const first = await executeIosPhysicalDeviceAction(input(value, 'physical_device_open', { device: 'greyson', bundle_id: 'com.xingin.discover' }));
    const firstInteractionId = String((first.interaction as Record<string, unknown>).interactionId);
    const screenshot = await executeIosPhysicalDeviceAction(input(value, 'physical_device_screenshot', { interaction_id: firstInteractionId, label: 'prior-session' }));
    const oldObservationId = String((screenshot.observation as Record<string, unknown>).observationId);
    await executeIosPhysicalDeviceAction(input(value, 'physical_device_close', { interaction_id: firstInteractionId }));

    const second = await executeIosPhysicalDeviceAction(input(value, 'physical_device_open', { device: 'greyson', bundle_id: 'com.xingin.discover' }));
    const secondInteractionId = String((second.interaction as Record<string, unknown>).interactionId);
    await expect(executeIosPhysicalDeviceAction(input(value, 'physical_device_batch', {
      interaction_id: secondInteractionId,
      observation_id: oldObservationId,
      steps: [{ kind: 'type', text: 'must-not-dispatch' }],
    }))).rejects.toMatchObject({ code: 'IOS_DEVICE_SCREEN_OBSERVATION_REQUIRED', retryable: true });
    expect(hidCalls).toBe(0);
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
        const screenshotResult = maybeScreenshotCommand(command, args);
        if (screenshotResult) return screenshotResult;
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
        const screenshotResult = maybeScreenshotCommand(command, args);
        if (screenshotResult) return screenshotResult;
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
    await observeAndConfirmForeground(value, interactionId);
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
        const screenshotResult = maybeScreenshotCommand(command, args);
        if (screenshotResult) return screenshotResult;
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
    await observeAndConfirmForeground(value, interactionId);
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
    expect(launches).toHaveLength(1);
  });

  it('fails closed before HID when launch claims activation but no screenshot foreground fence exists', async () => {
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
        const screenshotResult = maybeScreenshotCommand(command, args);
        if (screenshotResult) return screenshotResult;
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
    }))).rejects.toMatchObject({ code: 'IOS_DEVICE_FOREGROUND_OBSERVATION_REQUIRED', retryable: true });
    expect(hidDispatched).toBe(false);
    const launches = commands.filter((argv) => argv.join(' ').includes('device process launch'));
    expect(launches).toHaveLength(1);
  });

  it('rejects a screenshot foreground confirmation for a different bundle before HID', async () => {
    const value = fixture();
    let hidDispatched = false;
    setRemoteXpcHidExecutorForTest(async (request) => {
      hidDispatched = true;
      return { backend: 'remote-xpc-hid', reusedWorker: true, endpoint: { host: 'fd00::1', port: 53194 }, result: { action: request.action }, timings: { workerStartupMs: 0, workerReadyMs: 0, requestMs: 1, hidMs: 1 } };
    });
    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-08-17T08:00:00.000Z'),
      runCommand: (command, args) => {
        const screenshotResult = maybeScreenshotCommand(command, args);
        if (screenshotResult) return screenshotResult;
        if (args[0] === 'devicectl' && args[1] === '--version') return { ok: true, status: 0, stdout: '636.3\n', stderr: '', command: [command, ...args] };
        const joined = args.join(' ');
        if (joined.includes('list devices')) return { ok: true, status: 0, stdout: json({ devices: [deviceEntry()] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info apps')) return { ok: true, status: 0, stdout: json({ apps: [{ name: '小红书', bundleIdentifier: 'com.xingin.discover' }] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info lockState')) return { ok: true, status: 0, stdout: json({ passcodeRequired: false, unlockedSinceBoot: true }), stderr: '', command: [command, ...args] };
        if (joined.includes('device process launch')) return { ok: true, status: 0, stdout: json({ processIdentifier: 123, launchOptions: { activatedWhenStarted: true } }), stderr: '', command: [command, ...args] };
        throw new Error(`unexpected command: ${[command, ...args].join(' ')}`);
      },
    });

    const opened = await executeIosPhysicalDeviceAction(input(value, 'physical_device_open', { device: 'greyson', bundle_id: 'com.xingin.discover' }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    const screenshot = await executeIosPhysicalDeviceAction(input(value, 'physical_device_screenshot', { interaction_id: interactionId, label: 'wrong-bundle-proof' }));
    const observationId = String((screenshot.observation as Record<string, unknown>).observationId);
    await expect(executeIosPhysicalDeviceAction(input(value, 'physical_device_confirm_foreground', {
      interaction_id: interactionId,
      observation_id: observationId,
      bundle_id: 'com.apple.mobilesafari',
    }))).rejects.toMatchObject({ code: 'IOS_DEVICE_FOREGROUND_OBSERVATION_MISMATCH', retryable: false });
    await expect(executeIosPhysicalDeviceAction(input(value, 'physical_device_type_text', { interaction_id: interactionId, text: 'must-not-dispatch' })))
      .rejects.toMatchObject({ code: 'IOS_DEVICE_FOREGROUND_OBSERVATION_REQUIRED', retryable: true });
    expect(hidDispatched).toBe(false);
  });

  it('expires a confirmed screenshot foreground fence before HID dispatch', async () => {
    const value = fixture();
    let now = new Date('2026-08-17T08:00:00.000Z');
    let hidDispatched = false;
    setRemoteXpcHidExecutorForTest(async (request) => {
      hidDispatched = true;
      return { backend: 'remote-xpc-hid', reusedWorker: true, endpoint: { host: 'fd00::1', port: 53194 }, result: { action: request.action }, timings: { workerStartupMs: 0, workerReadyMs: 0, requestMs: 1, hidMs: 1 } };
    });
    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => now,
      runCommand: (command, args) => {
        const screenshotResult = maybeScreenshotCommand(command, args);
        if (screenshotResult) return screenshotResult;
        if (args[0] === 'devicectl' && args[1] === '--version') return { ok: true, status: 0, stdout: '636.3\n', stderr: '', command: [command, ...args] };
        const joined = args.join(' ');
        if (joined.includes('list devices')) return { ok: true, status: 0, stdout: json({ devices: [deviceEntry()] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info apps')) return { ok: true, status: 0, stdout: json({ apps: [{ name: '小红书', bundleIdentifier: 'com.xingin.discover' }] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info lockState')) return { ok: true, status: 0, stdout: json({ passcodeRequired: false, unlockedSinceBoot: true }), stderr: '', command: [command, ...args] };
        if (joined.includes('device process launch')) return { ok: true, status: 0, stdout: json({ processIdentifier: 123, launchOptions: { activatedWhenStarted: true } }), stderr: '', command: [command, ...args] };
        throw new Error(`unexpected command: ${[command, ...args].join(' ')}`);
      },
    });

    const opened = await executeIosPhysicalDeviceAction(input(value, 'physical_device_open', { device: 'greyson', bundle_id: 'com.xingin.discover' }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    await observeAndConfirmForeground(value, interactionId);
    now = new Date('2026-08-17T08:00:31.000Z');
    await expect(executeIosPhysicalDeviceAction(input(value, 'physical_device_type_text', { interaction_id: interactionId, text: 'must-not-dispatch' })))
      .rejects.toMatchObject({ code: 'IOS_DEVICE_FOREGROUND_OBSERVATION_REQUIRED', retryable: true });
    expect(hidDispatched).toBe(false);
  });

  it('uses a screenshot-bound observed tap once without any CoreDevice reactivation', async () => {
    const value = fixture();
    const commands: string[][] = [];
    const hidCalls: Array<Record<string, unknown>> = [];
    setRemoteXpcHidExecutorForTest(async (request) => {
      hidCalls.push({ ...request });
      return { backend: 'remote-xpc-hid', reusedWorker: true, endpoint: { host: 'fd00::1', port: 53194 }, result: { action: request.action }, timings: { workerStartupMs: 0, workerReadyMs: 0, requestMs: 1, hidMs: 1 } };
    });
    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-08-17T08:00:00.000Z'),
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        const screenshotResult = maybeScreenshotCommand(command, args);
        if (screenshotResult) return screenshotResult;
        if (args[0] === 'devicectl' && args[1] === '--version') return { ok: true, status: 0, stdout: '636.3\n', stderr: '', command: [command, ...args] };
        const joined = args.join(' ');
        if (joined.includes('list devices')) return { ok: true, status: 0, stdout: json({ devices: [deviceEntry()] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info apps')) return { ok: true, status: 0, stdout: json({ apps: [{ name: '小红书', bundleIdentifier: 'com.xingin.discover' }] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info lockState')) return { ok: true, status: 0, stdout: json({ passcodeRequired: false, unlockedSinceBoot: true }), stderr: '', command: [command, ...args] };
        if (joined.includes('device info displays')) return { ok: true, status: 0, stdout: json({ displays: [{ bounds: [[0, 0], [1206, 2622]], primary: true }] }), stderr: '', command: [command, ...args] };
        if (joined.includes('device process launch')) return { ok: true, status: 0, stdout: json({ processIdentifier: 123, launchOptions: { activatedWhenStarted: true } }), stderr: '', command: [command, ...args] };
        throw new Error(`unexpected command: ${[command, ...args].join(' ')}`);
      },
    });

    const opened = await executeIosPhysicalDeviceAction(input(value, 'physical_device_open', {
      device: 'greyson', bundle_id: 'com.xingin.discover', prewarm_input: true,
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    const screenshot = await executeIosPhysicalDeviceAction(input(value, 'physical_device_screenshot', { interaction_id: interactionId, label: 'spotlight' }));
    const observationId = String((screenshot.observation as Record<string, unknown>).observationId);
    const tapped = await executeIosPhysicalDeviceAction(input(value, 'physical_device_observed_tap', {
      interaction_id: interactionId, observation_id: observationId, x: 1010, y: 720,
    }));
    expect(tapped.observationConsumed).toBe(true);
    expect(hidCalls).toHaveLength(1);
    expect(hidCalls[0]).toMatchObject({ action: 'tap', x: 1010, y: 720, width: 1206, height: 2622 });
    const launches = commands.filter((argv) => argv.join(' ').includes('device process launch'));
    expect(launches).toHaveLength(1);
    await expect(executeIosPhysicalDeviceAction(input(value, 'physical_device_observed_tap', {
      interaction_id: interactionId, observation_id: observationId, x: 1010, y: 720,
    }))).rejects.toMatchObject({ code: 'IOS_DEVICE_SCREEN_OBSERVATION_REQUIRED', retryable: true });
    expect(hidCalls).toHaveLength(1);
  });

  it('surfaces CoreDevice display, lock, View Device Screen, and HID capabilities without a Runner', async () => {
    const value = fixture();
    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        const screenshotResult = maybeScreenshotCommand(command, args);
        if (screenshotResult) return screenshotResult;
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
