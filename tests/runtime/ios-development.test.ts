import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { isProcessAlive } from '../../src/runtime/shared/process-tree';
import {
  iosAppBuild,
  iosAppInstall,
  iosAppLaunch,
  iosProjectDiscover,
  iosSchemesList,
  iosSimulatorBoot,
  iosSimulatorLogTail,
  iosSimulatorScreenshot,
  iosSimulatorShutdown,
  iosSmokeReview,
  iosXcodeTest,
  resetIosDevelopmentHooksForTest,
  setIosDevelopmentHooksForTest,
  type IosCommandResult,
} from '../../src/runtime/safe-tooling';

const roots: string[] = [];

afterEach(() => {
  resetIosDevelopmentHooksForTest();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function result(command: string, args: string[], input: Partial<IosCommandResult> = {}): IosCommandResult {
  const defaultSimctlInventory = command === 'xcrun' && args[0] === 'simctl' && args[1] === 'list'
    ? JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
      { name: 'Test iPhone', udid: 'D', state: 'Shutdown', isAvailable: true },
      { name: 'Test iPhone 1', udid: 'D1', state: 'Shutdown', isAvailable: true },
      { name: 'Test iPhone 2', udid: 'D2', state: 'Shutdown', isAvailable: true },
    ] } })
    : '';
  return {
    ok: input.ok ?? true,
    status: input.status ?? (input.ok === false ? 1 : 0),
    stdout: input.stdout ?? defaultSimctlInventory,
    stderr: input.stderr ?? '',
    command: [command, ...args],
  };
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'forge-ios-development-'));
  roots.push(root);
  mkdirSync(join(root, 'App.xcodeproj'), { recursive: true });
  const appPath = '.forge/ios/DerivedData/Test.app';
  mkdirSync(join(root, appPath), { recursive: true });
  writeFileSync(join(root, appPath, 'Info.plist'), '<plist/>', 'utf-8');
  return {
    root,
    appPath,
    record: { repoId: 'repo-test', canonicalRoot: root, activeCheckoutId: 'active' } as any,
  };
}

describe('iOS development simulator reliability', () => {
  test('keeps the event loop responsive and reaps only owned compiler descendants on timeout or parent exit', async () => {
    if (process.platform === 'win32') return;
    const repo = repository();
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pidPath = join(repo.root, 'compiler.pid');
    const executable = join(repo.root, 'xcodebuild');
    setIosDevelopmentHooksForTest({ platform: () => 'darwin', xcodebuildExecutable: executable });
    try {
      for (const orphan of [false, true]) {
        writeFileSync(executable, `#!${process.execPath}
          const fs = require('fs');
          if (process.argv.includes('-list')) {
            console.log(JSON.stringify({project:{schemes:['App']}})); process.exit(0);
          }
          const child = require('child_process').spawn(process.execPath,
            ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {stdio:'ignore'});
          fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
          process.on('SIGTERM', () => {});
          ${orphan ? 'setTimeout(() => process.exit(0), 100);' : ''}
          setInterval(() => {}, 1000);
        `);
        chmodSync(executable, 0o700);
        let ticks = 0;
        const heartbeat = setInterval(() => { ticks += 1; }, 10);
        let built;
        try { built = await iosAppBuild(repo.record, { scheme: 'App', timeoutMs: 1_000 }); }
        finally { clearInterval(heartbeat); }
        if (ticks === 0) throw new Error('build did not reach supervised execution: ' + JSON.stringify(built));
        expect(ticks).toBeGreaterThan(0);
        expect(built.ready).toBe(false);
        if (!('stderr' in built)) throw new Error('missing failure evidence');
        expect(built.stderr.content).toContain(orphan ? 'CHILD_SUPERVISOR_RESIDUAL_PROCESS' : 'CHILD_SUPERVISOR_WALL_TIMEOUT');
        expect(isProcessAlive(Number(readFileSync(pidPath, 'utf8')))).toBe(false);
        expect(isProcessAlive(sentinel.pid)).toBe(true);
      }
    } finally {
      sentinel.kill('SIGKILL');
      // Failed assertions must not leave a fault-injected compiler behind.
      if (existsSync(pidPath)) {
        try { process.kill(Number(readFileSync(pidPath, 'utf8')), 'SIGKILL'); } catch { /* already reaped */ }
      }
    }
  }, 15_000);

  test('does not treat generic simctl Unable failures as target-state success', () => {
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => result(command, args, {
        ok: false,
        stderr: args.includes('shutdown')
          ? 'Unable to shutdown device: operation failed'
          : 'Unable to boot device: runtime profile not found',
      }),
    });

    const boot = iosSimulatorBoot({ udid: 'D', openSimulator: false });
    expect(boot.ready).toBe(false);
    expect('alreadyBooted' in boot ? boot.alreadyBooted : undefined).toBe(false);
    expect('booted' in boot ? boot.booted : undefined).toBe(false);

    const shutdown = iosSimulatorShutdown({ udid: 'D' });
    expect(shutdown.ready).toBe(false);
    expect('alreadyShutdown' in shutdown ? shutdown.alreadyShutdown : undefined).toBe(false);
    expect('shutdown' in shutdown ? shutdown.shutdown : undefined).toBe(false);
  });

  test('does not report a simulator as booted when bootstatus cannot confirm readiness', () => {
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        if (args[1] === 'boot') return result(command, args, { ok: false, stderr: 'Unable to boot device in current state: Booted' });
        if (args[1] === 'bootstatus') return result(command, args, { ok: false, stderr: 'bootstatus timed out' });
        return result(command, args);
      },
    });

    const boot = iosSimulatorBoot({ udid: 'D', openSimulator: false });
    expect(boot.ready).toBe(false);
    expect('alreadyBooted' in boot ? boot.alreadyBooted : undefined).toBe(true);
    expect('booted' in boot ? boot.booted : undefined).toBe(false);
    expect('ownership' in boot ? boot.ownership : undefined).toBe('reused');
  });

  test('reuses the exact warm Simulator even at the two-device cap without another boot', () => {
    const commands: string[][] = [];
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (command === 'xcrun' && args[1] === 'list') return result(command, args, {
          stdout: JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
            { name: 'First', udid: 'D1', state: 'Booted' },
            { name: 'Second', udid: 'D2', state: 'Booted' },
          ] } }),
        });
        return result(command, args);
      },
    });
    const reused = iosSimulatorBoot({ udid: 'D1' });
    expect(reused.ready).toBe(true);
    expect('ownership' in reused ? reused.ownership : undefined).toBe('reused');
    expect('alreadyBooted' in reused ? reused.alreadyBooted : undefined).toBe(true);
    expect(commands.filter((argv) => argv[1] === 'simctl' && argv[2] === 'boot')).toHaveLength(0);
    expect(commands.filter((argv) => argv[2] === 'bootstatus')).toHaveLength(1);
    expect(commands.filter((argv) => argv[2] === 'shutdown')).toHaveLength(0);
    expect(commands.filter((argv) => argv[0] === 'open')).toHaveLength(0);
    const manual = iosSimulatorBoot({ udid: 'D2', openSimulator: true });
    expect(manual.ready).toBe(true);
    expect(commands.filter((argv) => argv[0] === 'open')).toHaveLength(1);
  });

  test('a new third iOS Simulator fails closed with current booted owners and never calls boot', () => {
    const commands: string[][] = [];
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (command === 'xcrun' && args[1] === 'list') return result(command, args, {
          stdout: JSON.stringify({ devices: {
            'com.apple.CoreSimulator.SimRuntime.watchOS-27-0': [
              { name: 'Watch', udid: 'W1', state: 'Booted', isAvailable: true },
            ],
            'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
              { name: 'First', udid: 'D1', state: 'Booted', isAvailable: true },
              { name: 'Second', udid: 'D2', state: 'Booted', isAvailable: true },
              { name: 'Third', udid: 'D3', state: 'Shutdown', isAvailable: true },
            ],
          } }),
        });
        return result(command, args);
      },
    });
    const blocked = iosSimulatorBoot({ udid: 'D3', openSimulator: false });
    expect(blocked.ready).toBe(false);
    expect('error' in blocked ? blocked.error?.code : undefined).toBe('IOS_SIMULATOR_CAPACITY_REACHED');
    expect('bootedDevices' in blocked ? blocked.bootedDevices?.map((device) => device.udid) : undefined).toEqual(['D1', 'D2']);
    expect(commands.some((argv) => argv[2] === 'boot' || argv[2] === 'shutdown')).toBe(false);
  });

  test('boots one new Simulator below the cap but never shuts down a successful warm device', () => {
    const commands: string[][] = [];
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (command === 'xcrun' && args[1] === 'list') return result(command, args, {
          stdout: JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
            { name: 'First', udid: 'D1', state: 'Booted', isAvailable: true },
            { name: 'New', udid: 'D2', state: 'Shutdown', isAvailable: true },
          ] } }),
        });
        return result(command, args);
      },
    });
    const started = iosSimulatorBoot({ udid: 'D2', openSimulator: false });
    expect(started.ready).toBe(true);
    expect('ownership' in started ? started.ownership : undefined).toBe('started_by_work');
    expect(commands.filter((argv) => argv[2] === 'boot')).toHaveLength(1);
    expect(commands.filter((argv) => argv[2] === 'bootstatus')).toHaveLength(1);
    expect(commands.filter((argv) => argv[2] === 'shutdown')).toHaveLength(0);
  });

  test('unknown inventory or device state fails closed without starting any Simulator', () => {
    for (const failure of ['inventory', 'state', 'absent'] as const) {
      const commands: string[][] = [];
      setIosDevelopmentHooksForTest({
        platform: () => 'darwin',
        runCommand: (command, args) => {
          commands.push([command, ...args]);
          if (command === 'xcrun' && args[1] === 'list') {
            if (failure === 'inventory') return result(command, args, { ok: false, stderr: 'simctl blocked' });
            return result(command, args, { stdout: JSON.stringify({ devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
                { name: 'New', udid: 'D2', state: failure === 'state' ? 'Booting' : 'Shutdown', isAvailable: true },
              ],
            } }) });
          }
          return result(command, args);
        },
      });
      const blocked = iosSimulatorBoot({ udid: 'D3', openSimulator: false });
      expect(blocked.ready).toBe(false);
      expect('error' in blocked ? blocked.error?.code : undefined).toBe(
        failure === 'inventory' ? 'IOS_SIMULATOR_INVENTORY_UNAVAILABLE' : 'IOS_SIMULATOR_UNAVAILABLE',
      );
      expect(commands.some((argv) => argv[2] === 'boot')).toBe(false);
      if (failure === 'state') {
        const unsettled = iosSimulatorBoot({ udid: 'D2', openSimulator: false });
        expect('error' in unsettled ? unsettled.error?.code : undefined).toBe('IOS_SIMULATOR_STATE_NOT_READY');
      }
    }
  });

  test('XCTest uses an already booted exact UDID and refuses a third implicit destination', async () => {
    const repo = repository();
    const commands: string[][] = [];
    const inventory = { devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
      { name: 'First', udid: 'D1', state: 'Booted', isAvailable: true },
      { name: 'Second', udid: 'D2', state: 'Booted', isAvailable: true },
      { name: 'Third', udid: 'D3', state: 'Shutdown', isAvailable: true },
    ] } };
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (command === 'xcrun' && args[1] === 'list') return result(command, args, { stdout: JSON.stringify(inventory) });
        if (command === 'xcodebuild' && args.includes('-list')) return result(command, args, {
          stdout: JSON.stringify({ project: { schemes: ['AppTests'] } }),
        });
        return result(command, args);
      },
    });
    const blocked = await iosXcodeTest(repo.record, { scheme: 'AppTests', udid: 'D3' });
    expect(blocked.ready).toBe(false);
    expect('error' in blocked ? blocked.error?.code : undefined).toBe('IOS_SIMULATOR_CAPACITY_REACHED');
    expect(commands.some((argv) => argv[0] === 'xcodebuild' && argv[1] === 'test')).toBe(false);

    const reused = await iosXcodeTest(repo.record, { scheme: 'AppTests' });
    expect(reused.ready).toBe(true);
    const testCommand = commands.find((argv) => argv[0] === 'xcodebuild' && argv[1] === 'test');
    expect(testCommand).toContain('platform=iOS Simulator,id=D1');
    expect(commands.some((argv) => argv[2] === 'boot')).toBe(false);
    expect(commands.some((argv) => argv[2] === 'shutdown')).toBe(false);
  });

  test('discovers Xcode projects nested deeply in monorepos while pruning generated dependency trees', () => {
    const repo = repository();
    const deepProject = join(repo.root, 'packages', 'mobile', 'clients', 'apple', 'ios', 'Deep.xcodeproj');
    mkdirSync(deepProject, { recursive: true });
    mkdirSync(join(repo.root, 'packages', 'mobile', 'Pods', 'Ignored.xcodeproj'), { recursive: true });
    setIosDevelopmentHooksForTest({ platform: () => 'darwin' });

    const discovered = iosProjectDiscover(repo.record, { forceRefresh: true });
    expect(discovered.projects).toContain('packages/mobile/clients/apple/ios/Deep.xcodeproj');
    expect(discovered.projects.some((entry) => entry.includes('/Pods/'))).toBe(false);
  });

  test('caches xcodebuild scheme inventory on the hot path', () => {
    const repo = repository();
    let listCalls = 0;
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-08-22T00:00:00.000Z'),
      runCommand: (command, args) => {
        if (command === 'xcodebuild' && args.includes('-list')) {
          listCalls += 1;
          return result(command, args, { stdout: JSON.stringify({ project: { schemes: ['App'] } }) });
        }
        return result(command, args);
      },
    });

    expect(iosSchemesList(repo.record).ready).toBe(true);
    expect(iosSchemesList(repo.record).ready).toBe(true);
    expect(listCalls).toBe(1);
  });

  test('reuses stable build DerivedData while preferring newly produced apps over stale cached products', async () => {
    const repo = repository();
    let buildCalls = 0;
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-08-22T00:00:00.000Z'),
      runCommand: (command, args) => {
        if (command === 'xcodebuild' && args.includes('-list')) {
          return result(command, args, { stdout: JSON.stringify({ project: { schemes: ['Old'] } }) });
        }
        if (command === 'xcodebuild' && args[0] === 'build') {
          buildCalls += 1;
          const derivedDataPath = args[args.indexOf('-derivedDataPath') + 1]!;
          const appName = buildCalls === 1 ? 'Old.app' : buildCalls === 2 ? 'New.app' : `Build${buildCalls}.app`;
          mkdirSync(join(derivedDataPath, 'Build', 'Products', 'Debug-iphonesimulator', appName), { recursive: true });
          return result(command, args);
        }
        return result(command, args);
      },
    });

    const first = await iosAppBuild(repo.record, { scheme: 'Old', udid: 'D1' });
    const second = await iosAppBuild(repo.record, { scheme: 'Old', udid: 'D1' });
    const otherConfiguration = await iosAppBuild(repo.record, { scheme: 'Old', udid: 'D1', configuration: 'Release' });
    const otherDestination = await iosAppBuild(repo.record, { scheme: 'Old', udid: 'D2' });

    expect(first.ready).toBe(true);
    expect(second.ready).toBe(true);
    if (!('command' in first) || !first.command) throw new Error('missing build command');
    expect(first.command.slice(first.command.indexOf('-jobs'), first.command.indexOf('-jobs') + 2)).toEqual(['-jobs', '2']);
    expect(first.command).toContain('OTHER_SWIFT_FLAGS=$(inherited) -j 2');
    if (!(
      'derivedDataPath' in first
      && 'derivedDataPath' in second
      && 'derivedDataPath' in otherConfiguration
      && 'derivedDataPath' in otherDestination
      && 'derivedDataReused' in first
      && 'derivedDataReused' in second
      && 'newBuiltApps' in second
      && 'appPath' in second
    )) throw new Error('expected successful build evidence');
    expect(first.derivedDataPath).toBe(second.derivedDataPath);
    expect(first.derivedDataReused).toBe(false);
    expect(second.derivedDataReused).toBe(true);
    expect(second.appPath?.endsWith('/New.app')).toBe(true);
    expect(second.newBuiltApps.some((entry: string) => entry.endsWith('/New.app'))).toBe(true);
    expect(otherConfiguration.derivedDataPath).not.toBe(first.derivedDataPath);
    expect(otherDestination.derivedDataPath).toBe(first.derivedDataPath);
    const physical = await iosAppBuild(repo.record, { scheme: 'Old', udid: 'P1', destinationPlatform: 'ios' });
    const testRun = await iosXcodeTest(repo.record, { scheme: 'Old', udid: 'D2' });
    const repeatTestRun = await iosXcodeTest(repo.record, { scheme: 'Old', udid: 'D1', onlyTesting: ['OldTests/example'] });
    if (!('derivedDataPath' in physical && 'derivedDataPath' in testRun && 'resultBundlePath' in testRun && 'resultBundlePath' in repeatTestRun)) throw new Error('expected cache evidence');
    expect(physical.derivedDataPath).not.toBe(first.derivedDataPath);
    expect(testRun.derivedDataPath).toBe(first.derivedDataPath);
    expect(repeatTestRun.resultBundlePath).not.toBe(testRun.resultBundlePath);
  });

  test('builds an exact physical iOS destination with provisioning credentials inside the runner while redacting returned evidence', async () => {
    const repo = repository();
    const commands: string[][] = [];
    const privateKeyPath = '/tmp/AuthKey_PRIVATE.p8';
    const keyId = 'KEY-ID-PRIVATE';
    const issuerId = 'ISSUER-ID-PRIVATE';
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (command === 'xcodebuild' && args.includes('-list')) {
          return result(command, args, { stdout: JSON.stringify({ project: { schemes: ['App'] } }) });
        }
        if (command === 'xcodebuild' && args[0] === 'build') {
          const derivedDataPath = args[args.indexOf('-derivedDataPath') + 1]!;
          mkdirSync(join(derivedDataPath, 'Build', 'Products', 'Debug-iphoneos', 'App.app'), { recursive: true });
          return result(command, args, { stdout: `used ${privateKeyPath} ${keyId}`, stderr: `issuer ${issuerId}` });
        }
        return result(command, args);
      },
    });

    const built = await iosAppBuild(repo.record, {
      scheme: 'App',
      udid: 'PHYSICAL-UDID',
      destinationPlatform: 'ios',
      provisioning: {
        allowUpdates: true,
        authentication: { privateKeyPath, keyId, issuerId },
      },
    });
    expect(built.ready).toBe(true);
    if (!('command' in built) || !('stdout' in built) || !('stderr' in built) || !('destination' in built)) {
      throw new Error('expected physical build evidence');
    }
    const internal = commands.find((entry) => entry[0] === 'xcodebuild' && entry[1] === 'build')!;
    expect(internal).toContain('platform=iOS,id=PHYSICAL-UDID');
    expect(internal).toContain('-allowProvisioningUpdates');
    expect(internal).toContain(privateKeyPath);
    expect(internal).toContain(keyId);
    expect(internal).toContain(issuerId);
    expect(built.destination).toBe('platform=iOS,id=PHYSICAL-UDID');
    expect(built.command).toContain('[REDACTED]');
    expect(built.command).not.toContain(privateKeyPath);
    expect(built.command).not.toContain(keyId);
    expect(built.command).not.toContain(issuerId);
    expect(built.stdout.content).not.toContain(privateKeyPath);
    expect(built.stdout.content).not.toContain(keyId);
    expect(built.stderr.content).not.toContain(issuerId);
  });

  test('keeps Xcode tests serial by default but supports bounded opt-in parallel workers', async () => {
    const repo = repository();
    const commands: string[][] = [];
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (command === 'xcodebuild' && args.includes('-list')) {
          return result(command, args, { stdout: JSON.stringify({ project: { schemes: ['AppTests'] } }) });
        }
        return result(command, args);
      },
    });

    const serial = await iosXcodeTest(repo.record, { scheme: 'AppTests', udid: 'D1' });
    const parallel = await iosXcodeTest(repo.record, { scheme: 'AppTests', udid: 'D1', parallelTesting: true, maxParallelTestingWorkers: 4 });
    expect(serial.ready).toBe(true);
    expect(parallel.ready).toBe(true);
    const testCommands = commands.filter((entry) => entry[0] === 'xcodebuild' && entry[1] === 'test');
    expect(testCommands[0]).toContain('NO');
    expect(testCommands[0]).toContain('1');
    expect(testCommands[1]).toContain('YES');
    expect(testCommands[1]!.slice(testCommands[1]!.indexOf('-maximum-parallel-testing-workers') + 1, testCommands[1]!.indexOf('-maximum-parallel-testing-workers') + 2)).toEqual(['2']);
    for (const command of testCommands) expect(command.slice(command.indexOf('-jobs'), command.indexOf('-jobs') + 2)).toEqual(['-jobs', '2']);
  });

  test('uses collision-resistant screenshot artifact names even with a fixed clock', () => {
    const repo = repository();
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-08-22T00:00:00.000Z'),
      runCommand: (command, args) => result(command, args),
    });

    const first = iosSimulatorScreenshot(repo.record, { udid: 'D', label: 'same' });
    const second = iosSimulatorScreenshot(repo.record, { udid: 'D', label: 'same' });
    expect(first.ready).toBe(true);
    expect(second.ready).toBe(true);
    expect('screenshot' in first ? first.screenshot : undefined).not.toBe('screenshot' in second ? second.screenshot : undefined);
  });

  test('accepts Controller-owned prebuilt apps for skip-build smoke while rejecting arbitrary external paths', async () => {
    const repo = repository();
    const artifactRoot = mkdtempSync(join(tmpdir(), 'forge-ios-controller-artifacts-'));
    const outsideRoot = mkdtempSync(join(tmpdir(), 'forge-ios-untrusted-app-'));
    roots.push(artifactRoot, outsideRoot);
    const controllerApp = join(artifactRoot, 'prebuilt', 'Example.app');
    const outsideApp = join(outsideRoot, 'Outside.app');
    mkdirSync(controllerApp, { recursive: true });
    mkdirSync(outsideApp, { recursive: true });
    writeFileSync(join(controllerApp, 'Info.plist'), '<plist/>', 'utf-8');
    writeFileSync(join(outsideApp, 'Info.plist'), '<plist/>', 'utf-8');
    let installedPath = '';
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      sleep: () => {},
      runCommand: (command, args) => {
        if (command === 'xcodebuild' && args.includes('-list')) {
          return result(command, args, { stdout: JSON.stringify({ project: { schemes: ['App'] } }) });
        }
        if (command === 'plutil') {
          return result(command, args, { stdout: args.includes('CFBundleIdentifier') ? 'com.example.app\n' : 'Example\n' });
        }
        if (command === 'xcrun' && args[1] === 'install') {
          installedPath = args[3] ?? '';
          return result(command, args);
        }
        if (command === 'xcrun' && args[1] === 'launch') return result(command, args, { stdout: 'com.example.app: 4242\n' });
        if (command === 'xcrun' && args[1] === 'spawn' && args[3] === 'launchctl') {
          return result(command, args, { stdout: 'program path = /tmp/Example\n' });
        }
        if (command === 'xcrun' && args[1] === 'spawn' && args[3] === 'log') {
          return result(command, args, { stdout: 'target app log\n' });
        }
        return result(command, args);
      },
    });

    const review = await iosSmokeReview(repo.record, {
      scheme: 'App',
      udid: 'D',
      skipBuild: true,
      appPath: 'controller-artifacts/ios/prebuilt/Example.app',
      artifactRoot,
      launchWaitMs: 0,
    });

    expect(review.ready).toBe(true);
    expect(installedPath).toBe(controllerApp);
    expect(review.appExecutable).toBe('Example');
    expect('appPath' in review.install! ? review.install!.appPath : undefined).toBe('controller-artifacts/ios/prebuilt/Example.app');
    expect(() => iosAppInstall(repo.record, { udid: 'D', appPath: outsideApp, artifactRoot })).toThrow('IOS_APP_PATH_NOT_BOUNDED');
  });

  test('keeps smoke stages unique, rechecks Simulator capacity, and filters logs by app executable', async () => {
    const repo = repository();
    let simulatorListCalls = 0;
    let logPredicate = '';
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      sleep: () => {},
      runCommand: (command, args) => {
        if (command === 'xcodebuild' && args.includes('-list')) {
          return result(command, args, { stdout: JSON.stringify({ project: { schemes: ['App'] } }) });
        }
        if (command === 'plutil') {
          return result(command, args, { stdout: args.includes('CFBundleIdentifier') ? 'com.example.app\n' : 'Example\n' });
        }
        if (command === 'open') return result(command, args);
        if (command === 'xcrun' && args[0] === 'simctl' && args[1] === 'list') {
          simulatorListCalls += 1;
          return result(command, args, {
            stdout: JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [
                  { name: 'Apple Watch Series 10', udid: 'WATCH-BOOTED', state: 'Booted', isAvailable: true },
                ],
                'com.apple.CoreSimulator.SimRuntime.iOS-18-4': [
                  { name: 'iPhone 15 Pro', udid: 'BOOTED', state: 'Booted', isAvailable: true },
                  { name: 'iPhone 16 Pro', udid: 'SHUTDOWN', state: 'Shutdown', isAvailable: true },
                ],
              },
            }),
          });
        }
        if (command === 'xcrun' && args[1] === 'boot') {
          return result(command, args, { ok: false, stderr: 'Unable to boot device in current state: Booted' });
        }
        if (command === 'xcrun' && args[1] === 'bootstatus') return result(command, args);
        if (command === 'xcrun' && args[1] === 'install') return result(command, args);
        if (command === 'xcrun' && args[1] === 'launch') return result(command, args, { stdout: 'com.example.app: 4242\n' });
        if (command === 'xcrun' && args[1] === 'spawn' && args[3] === 'launchctl') {
          return result(command, args, { stdout: 'program path = /tmp/Example\n' });
        }
        if (command === 'xcrun' && args[1] === 'io') return result(command, args, { ok: false, stderr: 'screenshot failed' });
        if (command === 'xcrun' && args[1] === 'spawn' && args[3] === 'log') {
          logPredicate = args[args.indexOf('--predicate') + 1] ?? '';
          return result(command, args, { stdout: 'target app log\n' });
        }
        return result(command, args);
      },
    });

    const review = await iosSmokeReview(repo.record, {
      scheme: 'App',
      appPath: repo.appPath,
      skipBuild: true,
      launchWaitMs: 0,
    });

    expect(review.ready).toBe(false);
    expect(review.blockedStage).toBe('screenshot');
    expect(review.udid).toBe('BOOTED');
    expect(simulatorListCalls).toBe(2);
    expect(logPredicate).toContain('process == "Example"');
    const stageIds = review.stages.map((stage) => stage.stage);
    expect(new Set(stageIds).size).toBe(stageIds.length);
    expect(review.stages.find((stage) => stage.stage === 'logs')?.status).toBe('passed');
  });

  test('marks an immediately exited launched app as not ready', () => {
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      sleep: () => {},
      runCommand: (command, args) => {
        if (command === 'xcrun' && args[1] === 'launch') return result(command, args, { stdout: 'com.example.app: 4242\n' });
        if (command === 'xcrun' && args[1] === 'spawn' && args[3] === 'launchctl') {
          return result(command, args, {
            stdout: 'program path = (could not resolve path)\n',
            stderr: 'Could not get proc info PID 4242: 3: No such process\n',
          });
        }
        return result(command, args);
      },
    });

    const launch = iosAppLaunch({ udid: 'D', bundleId: 'com.example.app', waitMs: 0 });
    expect(launch.ready).toBe(false);
    expect('launched' in launch ? launch.launched : undefined).toBe(true);
    expect('alive' in launch ? launch.alive : undefined).toBe(false);
    expect('error' in launch ? launch.error?.code : undefined).toBe('IOS_LAUNCH_PROCESS_EXITED');
  });

  test('treats host log fallback as diagnostic evidence, not simulator log success', () => {
    const repo = repository();
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        if (command === 'xcrun') return result(command, args, { ok: false, stderr: 'simulator log unavailable' });
        if (command === '/usr/bin/log') return result(command, args, { stdout: 'host diagnostic log\n' });
        return result(command, args);
      },
    });

    const logs = iosSimulatorLogTail(repo.record, { udid: 'D', process: 'Example' });
    expect(logs.ready).toBe(false);
    expect('source' in logs ? logs.source : undefined).toBe('host_unified_log_diagnostic_fallback');
    expect('content' in logs ? logs.content : '').toContain('host diagnostic log');
    expect('path' in logs && typeof logs.path === 'string' ? existsSync(join(repo.root, logs.path)) : false).toBe(true);
  });
});
