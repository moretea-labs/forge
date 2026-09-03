import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolvePlatformServiceManager } from '../../src/runtime/platform/service-manager';

describe('platform service manager selection', () => {
  test('selects persistent adapters only when the host capability is actually available', () => {
    expect(resolvePlatformServiceManager({ platform: 'darwin' })).toMatchObject({ kind: 'launchd', persistent: true });
    expect(resolvePlatformServiceManager({ platform: 'linux', systemdUserAvailable: true })).toMatchObject({ kind: 'systemd-user', persistent: true });
    expect(resolvePlatformServiceManager({ platform: 'linux', systemdUserAvailable: false })).toMatchObject({ kind: 'portable', persistent: false, reason: 'linux_systemd_user_unavailable' });
  });

  test('keeps explicit portable mode and native Windows preview truthful', () => {
    expect(resolvePlatformServiceManager({ platform: 'darwin', forcePortable: true })).toEqual({ kind: 'portable', persistent: false, reason: 'portable_explicitly_requested' });
    expect(resolvePlatformServiceManager({ platform: 'win32' })).toEqual({ kind: 'portable', persistent: false, reason: 'windows_native_persistence_preview' });
  });

  test('keeps platform service mechanics behind the runtime platform host boundary', () => {
    for (const path of ['src/runtime/root/service.ts', 'src/runtime/root/package-runtime-service.ts', 'src/runtime/root/package-connector-service.ts']) {
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
