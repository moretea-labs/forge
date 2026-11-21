import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolvePlatformServiceManager } from '../../src/runtime/platform/service-manager';
import { systemdCgroupContainsPid } from '../../src/runtime/platform/systemd-user';
import { safeLaunchdHandoff } from '../../src/runtime/platform/launch-agents';

describe('platform service manager selection', () => {
  test('selects persistent adapters only when the host capability is actually available', () => {
    expect(resolvePlatformServiceManager({ platform: 'darwin' })).toMatchObject({ kind: 'launchd', persistent: true });
    expect(resolvePlatformServiceManager({ platform: 'linux', systemdUserAvailable: true })).toMatchObject({
      kind: 'systemd-user',
      persistent: true,
    });
    expect(resolvePlatformServiceManager({ platform: 'linux', systemdUserAvailable: false })).toMatchObject({
      kind: 'portable',
      persistent: false,
      reason: 'linux_systemd_user_unavailable',
    });
  });

  test('matches only processes inside the exact systemd service cgroup', () => {
    const service =
      '/user.slice/user-1001.slice/user@1001.service/app.slice/com.moretea.forge.runtime.f24d2fcb7df7.service';
    expect(systemdCgroupContainsPid(service, `0::${service}\n`)).toBe(true);
    expect(systemdCgroupContainsPid(service, `0::${service}/child.scope\n`)).toBe(true);
    expect(systemdCgroupContainsPid(service, `0::${service}-other.service\n`)).toBe(false);
    expect(systemdCgroupContainsPid(service, '0::/user.slice/other.service\n')).toBe(false);
    expect(systemdCgroupContainsPid('relative/path', `0::${service}\n`)).toBe(false);
  });

  test('refuses launchd enable/bootstrap while the prior PID or port remains active', async () => {
    const scenarios = [
      { oldPid: 123, port: undefined, pidAlive: true, portListening: false, pidWaitClean: false, portWaitClean: true },
      { oldPid: undefined, port: 4321, pidAlive: false, portListening: true, pidWaitClean: true, portWaitClean: false },
    ];
    for (const scenario of scenarios) {
      const commands: string[][] = [];
      const result = await safeLaunchdHandoff(
        {
          label: 'com.moretea.forge.test-handoff',
          plistPath: '/tmp/test-handoff.plist',
          domain: 'gui/501',
          oldPid: scenario.oldPid,
          port: scenario.port,
          maxBootoutWaitMs: 1,
        },
        {
          run: (args) => {
            commands.push(args);
            return { ok: true, stdout: '', stderr: '', exitCode: 0 };
          },
          probe: {
            isServiceRegistered: () => false,
            isPidAlive: () => scenario.pidAlive,
            isPortListening: () => scenario.portListening,
          },
          wait: async () => undefined,
        },
      );
      expect(result).toMatchObject({
        bootstrapAttempts: 0,
        bootoutClean: true,
        pidWaitClean: scenario.pidWaitClean,
        portWaitClean: scenario.portWaitClean,
        plistInstalled: false,
        serviceRegistered: false,
      });
      expect(commands.map(([action]) => action)).toEqual(['bootout']);
    }
  });

  test('honors connector-scale bootout observation beyond the default 15s window (#640)', async () => {
    let clock = 0;
    let registeredProbes = 0;
    const result = await safeLaunchdHandoff(
      {
        label: 'com.moretea.forge.mcp-gateway.test',
        plistPath: '/tmp/connector-handoff.plist',
        domain: 'gui/501',
        port: 8767,
        maxBootoutWaitMs: 55_000,
        pollIntervalMs: 1_000,
      },
      {
        now: () => clock,
        run: (args) => {
          if (args[0] === 'bootout' || args[0] === 'enable' || args[0] === 'bootstrap' || args[0] === 'kickstart') {
            return { ok: true, stdout: '', stderr: '', exitCode: 0 };
          }
          return { ok: false, stdout: '', stderr: `unexpected ${args.join(' ')}`, exitCode: 1 };
        },
        probe: {
          isServiceRegistered: () => {
            registeredProbes += 1;
            // Stay registered past the historical 15s default; clear inside ExitTimeOut+slack.
            return clock < 20_000;
          },
          isPidAlive: () => false,
          isPortListening: () => false,
        },
        wait: async (ms) => {
          clock += ms;
        },
      },
    );
    expect(registeredProbes).toBeGreaterThan(15);
    expect(result).toMatchObject({
      bootoutClean: true,
      pidWaitClean: true,
      portWaitClean: true,
      serviceRegistered: true,
      plistInstalled: true,
    });
  });

  test('still fails closed when the exact service remains after the configured bootout window', async () => {
    let clock = 0;
    const result = await safeLaunchdHandoff(
      {
        label: 'com.moretea.forge.mcp-gateway.test',
        plistPath: '/tmp/connector-handoff.plist',
        domain: 'gui/501',
        maxBootoutWaitMs: 15_000,
        pollIntervalMs: 1_000,
      },
      {
        now: () => clock,
        run: () => ({ ok: true, stdout: '', stderr: '', exitCode: 0 }),
        probe: {
          isServiceRegistered: () => true,
          isPidAlive: () => false,
          isPortListening: () => false,
        },
        wait: async (ms) => {
          clock += ms;
        },
      },
    );
    expect(clock).toBeGreaterThanOrEqual(15_000);
    expect(result).toMatchObject({
      bootstrapAttempts: 0,
      bootoutClean: false,
      serviceRegistered: false,
      plistInstalled: false,
    });
  });

  test('keeps explicit portable mode and native Windows preview truthful', () => {
    expect(resolvePlatformServiceManager({ platform: 'darwin', forcePortable: true })).toEqual({
      kind: 'portable',
      persistent: false,
      reason: 'portable_explicitly_requested',
    });
    expect(resolvePlatformServiceManager({ platform: 'win32' })).toEqual({
      kind: 'portable',
      persistent: false,
      reason: 'windows_native_persistence_preview',
    });
  });

  test('keeps platform service mechanics behind the runtime platform host boundary', () => {
    for (const path of [
      'src/runtime/platform/service-manager.ts',
      'src/runtime/root/service.ts',
      'src/runtime/root/package-runtime-service.ts',
      'src/runtime/root/package-connector-service.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      expect(source).not.toContain("from '../../cli/controller/launch-agents'");
      expect(source).not.toContain("from '../../cli/controller/systemd-user'");
    }
  });

  test('keeps normal ChatGPT Browser package paths free of Bun-only runtime APIs', () => {
    for (const path of [
      'src/cli/chatgpt-browser/bind-server.ts',
      'src/cli/chatgpt-browser/bridge-provider.ts',
      'src/cli/chatgpt-browser/engine.ts',
      'src/cli/chatgpt-browser/native-provider.ts',
      'src/cli/chatgpt-browser/oracle-provider.ts',
    ]) {
      expect(readFileSync(join(process.cwd(), path), 'utf8')).not.toMatch(/\bBun\./);
    }
  });
});
