import { afterEach, describe, expect, it } from 'bun:test';
import {
  executeRemoteXpcHidInput,
  parseMacOSTrustedRsdEndpoints,
  remoteXpcHidStatus,
  resetRemoteXpcHidForTest,
  setRemoteXpcHidExecutorForTest,
} from '../../src/runtime/plugins/ios/remote-xpc-hid';

afterEach(() => resetRemoteXpcHidForTest());

describe('RemoteXPC HID backend', () => {
  it('pairs trusted macOS tunnel addresses with RSD server ports and prefers newest observations', () => {
    const udid = '00008150-000429063E01401C';
    const log = [
      `2026-08-17 16:40:00 remotepairingd device-21 (${udid}): Tunnel established - interface: utun10, local fd00:1::2-> remote fd00:1::1`,
      `2026-08-17 16:40:00 remotepairingd device-21 (${udid}): Creating RSD backend client device for server port 53190`,
      `2026-08-17 16:44:08 remotepairingd device-21 (${udid}): Tunnel established - interface: utun10, local fd00:2::2-> remote fd00:2::1`,
      `2026-08-17 16:44:08 remotepairingd device-21 (${udid}): Creating RSD backend client device for server port 53194`,
    ].join('\n');
    expect(parseMacOSTrustedRsdEndpoints(log, udid)).toEqual([
      { host: 'fd00:2::1', port: 53194 },
      { host: 'fd00:1::1', port: 53190 },
    ]);
  });

  it('reports a controller-owned toolchain and never claims Runner ownership', () => {
    const status = remoteXpcHidStatus('/controller', {
      FORGE_IOS_HID_PYTHON: '/does/not/exist',
    });
    expect(status).toMatchObject({
      backend: 'remote-xpc-hid',
      available: false,
      toolchainVersion: '10.2.1',
      transport: 'macos-trusted-coredevice-rsd',
      runnerOwned: false,
    });
  });

  it('rejects off-screen coordinates before dispatching to the input worker', async () => {
    let dispatched = false;
    setRemoteXpcHidExecutorForTest(async (input) => {
      dispatched = true;
      return {
        backend: 'remote-xpc-hid', reusedWorker: false,
        endpoint: { host: 'fd00::1', port: 53194 }, result: { action: input.action },
      };
    });
    await expect(executeRemoteXpcHidInput({
      controllerHome: '/controller', deviceIdentifier: 'device', udid: 'UDID',
      width: 1206, height: 2622, action: 'tap', x: 1206, y: 100,
    })).rejects.toMatchObject({ code: 'IOS_HID_COORDINATE_OUT_OF_BOUNDS' });
    expect(dispatched).toBe(false);
  });
});
