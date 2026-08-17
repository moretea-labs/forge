import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  executeIosPhysicalDeviceAction,
  resetIosPhysicalDeviceRuntimeHooksForTest,
  setIosPhysicalDeviceRuntimeHooksForTest,
} from '../../src/runtime/plugins/ios-physical-device';

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
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('CoreDevice-first physical iPhone provider', () => {
  it('opens and screenshots without probing or creating a semantic Runner session', async () => {
    const value = fixture();
    const commands: string[][] = [];

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
          return { ok: true, status: 0, stdout: json({ processIdentifier: 123 }), stderr: '', command: [command, ...args] };
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

    const screenshot = await executeIosPhysicalDeviceAction(input(value, 'physical_device_screenshot', {
      interaction_id: interactionId, label: 'xhs',
    }));
    const artifact = (screenshot.artifactCandidates as Array<Record<string, unknown>>)[0]!;
    expect(existsSync(String(artifact.path))).toBe(true);
    expect(commands.some((argv) => argv.includes('xcodebuild'))).toBe(false);
    expect(commands.some((argv) => argv.includes('prepare'))).toBe(false);

    await executeIosPhysicalDeviceAction(input(value, 'physical_device_close', { interaction_id: interactionId }));
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
