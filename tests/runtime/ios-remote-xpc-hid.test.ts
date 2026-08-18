import { afterEach, describe, expect, it } from 'bun:test';
import {
  executeRemoteXpcHidInput,
  parseMacOSTrustedRsdEndpoints,
  remoteXpcHidWorkerSourceForTest,
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

  it('uses a dedicated CoreDevice virtual keyboard for text so modifier chords use the sniffed bitmap protocol', () => {
    const source = remoteXpcHidWorkerSourceForTest();
    expect(source).toContain("keyboardSource': 'virtual_coredevice_lazy'");
    expect(source).toContain("keyboard_service = await hid.create_keyboard_service(product='Forge virtual keyboard')");
    expect(source).toContain("'keyboardSource': 'virtual_coredevice'");
    expect(source).not.toContain("keyboardSource': 'connected_coredevice'");
    expect(source).not.toContain('No connected CoreDevice keyboard HID service is available');
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

  it('types without requiring display geometry', async () => {
    let observed: Record<string, unknown> | undefined;
    setRemoteXpcHidExecutorForTest(async (input) => {
      observed = { ...input, text: '<redacted>' };
      return {
        backend: 'remote-xpc-hid', reusedWorker: true,
        endpoint: { host: 'fd00::1', port: 53194 }, result: { action: input.action },
        timings: { workerStartupMs: 0, workerReadyMs: 0, requestMs: 40, hidMs: 36 },
      };
    });
    await executeRemoteXpcHidInput({
      controllerHome: '/controller', deviceIdentifier: 'device', udid: 'UDID',
      action: 'type', text: 'Forge123',
    });
    expect(observed).toMatchObject({ action: 'type', text: '<redacted>' });
    expect(observed).not.toHaveProperty('width');
    expect(observed).not.toHaveProperty('height');
  });

  it('accepts Unicode in auto pasteboard-capable text mode without display geometry', async () => {
    let observed: Record<string, unknown> | undefined;
    setRemoteXpcHidExecutorForTest(async (input) => {
      observed = { ...input, text: '<redacted>' };
      return {
        backend: 'remote-xpc-hid', reusedWorker: true,
        endpoint: { host: 'fd00::1', port: 53194 }, result: { action: input.action, inputMode: 'pasteboard' },
        timings: { workerStartupMs: 0, workerReadyMs: 0, requestMs: 55, hidMs: 50 },
      };
    });
    await executeRemoteXpcHidInput({
      controllerHome: '/controller', deviceIdentifier: 'device', udid: 'UDID',
      action: 'type', text: '小红书资料', textMode: 'auto', replaceExisting: true,
    });
    expect(observed).toMatchObject({ action: 'type', text: '<redacted>', textMode: 'auto', replaceExisting: true });
    expect(observed).not.toHaveProperty('width');
    expect(observed).not.toHaveProperty('height');
  });

  it('maps backspace through the virtual keyboard report path', () => {
    const source = remoteXpcHidWorkerSourceForTest();
    expect(source).toContain('KEY_BACKSPACE');
    expect(source).toContain("if char == '\\b':");
    expect(source).toContain('return (KEY_BACKSPACE, False)');
    expect(source).toContain('mapping = keyboard_mapping(char)');
  });

  it('uses verified virtual-keyboard Command-A and Command-V chords for whole-field Unicode replacement', () => {
    const source = remoteXpcHidWorkerSourceForTest();
    expect(source).toContain("phase = 'hid_keyboard_select_all'");
    expect(source).toContain('await send_keyboard_chord(hid, keyboard_service, [select_usage, KEY_LEFT_GUI])');
    expect(source).toContain("phase = 'hid_keyboard_paste'");
    expect(source).toContain('await send_keyboard_chord(hid, keyboard_service, [paste_usage, KEY_LEFT_GUI], settle_s=0.120)');
    expect(source).not.toContain("phase = 'replace_existing_preflight'");
  });

  it('isolates pasteboard traffic on a second RSD connection and stages text before selecting existing content', () => {
    const source = remoteXpcHidWorkerSourceForTest();
    expect(source).toContain('async with RemoteServiceDiscoveryService((args.host, args.port)) as pasteboard_rsd:');
    expect(source).toContain('async with PasteboardService(pasteboard_rsd) as pasteboard:');
    expect(source).not.toContain('async with PasteboardService(rsd) as pasteboard:');
    expect(source.indexOf('await pasteboard.set_text(text)')).toBeLessThan(source.indexOf("phase = 'hid_keyboard_select_all'"));
    expect(source).toContain("'pasteboardTransport': 'independent_rsd'");
  });

  it('rejects Unicode only when explicit direct-key mode is requested', async () => {
    let dispatched = false;
    setRemoteXpcHidExecutorForTest(async (input) => {
      dispatched = true;
      return {
        backend: 'remote-xpc-hid', reusedWorker: true,
        endpoint: { host: 'fd00::1', port: 53194 }, result: { action: input.action },
        timings: { workerStartupMs: 0, workerReadyMs: 0, requestMs: 0, hidMs: 0 },
      };
    });
    await expect(executeRemoteXpcHidInput({
      controllerHome: '/controller', deviceIdentifier: 'device', udid: 'UDID',
      action: 'type', text: '中文', textMode: 'keys',
    })).rejects.toMatchObject({ code: 'IOS_HID_UNICODE_TEXT_UNSUPPORTED', retryable: false });
    expect(dispatched).toBe(false);
  });

  it('rejects off-screen coordinates before dispatching to the input worker', async () => {
    let dispatched = false;
    setRemoteXpcHidExecutorForTest(async (input) => {
      dispatched = true;
      return {
        backend: 'remote-xpc-hid', reusedWorker: false,
        endpoint: { host: 'fd00::1', port: 53194 }, result: { action: input.action },
        timings: { workerStartupMs: 0, workerReadyMs: 0, requestMs: 0, foregroundMs: 0, hidMs: 0 },
      };
    });
    await expect(executeRemoteXpcHidInput({
      controllerHome: '/controller', deviceIdentifier: 'device', udid: 'UDID',
      width: 1206, height: 2622, action: 'tap', x: 1206, y: 100,
    })).rejects.toMatchObject({ code: 'IOS_HID_COORDINATE_OUT_OF_BOUNDS' });
    expect(dispatched).toBe(false);
  });
});
