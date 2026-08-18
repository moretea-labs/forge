import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  executeRemoteXpcHidInput,
  parseMacOSTrustedRsdEndpoints,
  remoteXpcHidEndpointCacheForTest,
  remoteXpcHidNovelEndpointsForTest,
  remoteXpcHidPersistentEndpointCacheForTest,
  remoteXpcHidWarmupFailureErrorForTest,
  remoteXpcHidWorkerSourceForTest,
  remoteXpcHidStatus,
  resetRemoteXpcHidForTest,
  setRemoteXpcHidExecutorForTest,
} from '../../src/runtime/plugins/ios/remote-xpc-hid';

afterEach(() => resetRemoteXpcHidForTest());

describe('RemoteXPC HID backend', () => {
  it('pairs RSD ports only with the latest trusted macOS tunnel host', () => {
    const udid = '00008150-000429063E01401C';
    const log = [
      `2026-08-17 16:40:00 remotepairingd device-21 (${udid}): Tunnel established - interface: utun10, local fd00:1::2-> remote fd00:1::1`,
      `2026-08-17 16:40:00 remotepairingd device-21 (${udid}): Creating RSD backend client device for server port 53190`,
      `2026-08-17 16:44:08 remotepairingd device-21 (${udid}): Tunnel established - interface: utun10, local fd00:2::2-> remote fd00:2::1`,
      `2026-08-17 16:44:08 remotepairingd device-21 (${udid}): Creating RSD backend client device for server port 53194`,
    ].join('\n');
    expect(parseMacOSTrustedRsdEndpoints(log, udid)).toEqual([
      { host: 'fd00:2::1', port: 53194 },
    ]);
  });

  it('keeps direct ASCII/backspace on the connected CoreDevice keyboard and isolates modifier chords', () => {
    const source = remoteXpcHidWorkerSourceForTest();
    expect(source).toContain("'keyboardSource': 'connected_coredevice' if direct_keyboard_service is not None else 'none'");
    expect(source).toContain("needs_modifier_keyboard = use_pasteboard or replace_existing");
    expect(source).toContain("result = await dispatch_text(hid, direct_keyboard_service, 'connected_coredevice', 0.0)");
    expect(source).toContain('async def isolated_modifier_keyboard(host, port):');
    expect(source).toContain('async with RemoteServiceDiscoveryService((host, port)) as modifier_rsd:');
    expect(source).toContain('async with UniversalHIDServiceService(modifier_rsd) as modifier_hid:');
    expect(source).toContain("service_id = await modifier_hid.create_keyboard_service(product='Forge modifier keyboard')");
    expect(source).not.toContain('modifier_keyboard_service =');
    expect(source).not.toContain('async with touch_session(modifier_rsd)');
  });

  it('keeps only recent ports from the latest tunnel host and never falls back to an older host', () => {
    const udid = '00008150-000429063E01401C';
    const log = [
      `2026-08-17 16:40:00 remotepairingd (${udid}): Tunnel established - interface: utun10, local fd00:1::2-> remote fd00:1::1`,
      `2026-08-17 16:40:00 remotepairingd (${udid}): Creating RSD backend client device for server port 51001`,
      `2026-08-17 16:50:00 remotepairingd (${udid}): Tunnel established - interface: utun11, local fd00:2::2-> remote fd00:2::1`,
      `2026-08-17 16:50:00 remotepairingd (${udid}): Creating RSD backend client device for server port 52001`,
      `2026-08-17 16:51:00 remotepairingd (${udid}): Creating RSD backend client device for server port 52002`,
    ].join('\n');
    expect(parseMacOSTrustedRsdEndpoints(log, udid)).toEqual([
      { host: 'fd00:2::1', port: 52002 },
      { host: 'fd00:2::1', port: 52001 },
    ]);
  });

  it('reuses fresh RSD endpoints briefly and expires stale cached tunnel data', () => {
    const endpoints = [{ host: 'fd00:2::1', port: 52002 }];
    expect(remoteXpcHidEndpointCacheForTest('UDID-CACHE', endpoints, 0)).toEqual(endpoints);
    expect(remoteXpcHidEndpointCacheForTest('UDID-CACHE', endpoints, 30_001)).toBeUndefined();
  });

  it('retries only newly discovered RSD endpoints after a cached tunnel generation fails', () => {
    const cached = [
      { host: 'fd00:old::1', port: 51001 },
      { host: 'fd00:old::1', port: 51002 },
    ];
    const refreshed = [
      { host: 'fd00:new::1', port: 52001 },
      { host: 'fd00:old::1', port: 51002 },
    ];
    expect(remoteXpcHidNovelEndpointsForTest(cached, refreshed)).toEqual([
      { host: 'fd00:new::1', port: 52001 },
    ]);
  });

  it('does not pay a second worker startup when forced RSD refresh returns only already-tried endpoints', () => {
    const attempted = [{ host: 'fd00:same::1', port: 53001 }];
    expect(remoteXpcHidNovelEndpointsForTest(attempted, [
      { host: 'fd00:same::1', port: 53001 },
      { host: 'fd00:same::1', port: 53001 },
    ])).toEqual([]);
  });

  it('persists only a short-lived successful RSD endpoint across Runtime memory loss', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-rxpc-endpoint-cache-'));
    try {
      const endpoint = { host: 'fd00:cafe::1', port: 54001 };
      expect(remoteXpcHidPersistentEndpointCacheForTest(controllerHome, 'UDID-PERSIST', endpoint, 0)).toEqual(endpoint);
      expect(remoteXpcHidPersistentEndpointCacheForTest(controllerHome, 'UDID-PERSIST')).toEqual(endpoint);
      expect(remoteXpcHidPersistentEndpointCacheForTest(controllerHome, 'UDID-PERSIST', endpoint, 10 * 60_000 + 1)).toBeUndefined();
      expect(remoteXpcHidPersistentEndpointCacheForTest(controllerHome, 'UDID-PERSIST')).toBeUndefined();
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  it('surfaces the bounded warmup failure instead of degrading it to a generic still-warming error', () => {
    const error = remoteXpcHidWarmupFailureErrorForTest('device-1', 'RSD handshake closed before ready');
    expect(error).toMatchObject({
      code: 'IOS_HID_INPUT_NOT_SENT',
      retryable: true,
      details: {
        deviceIdentifier: 'device-1',
        mutationDispatched: false,
        phase: 'worker_warmup',
      },
    });
    expect(error.message).toContain('RSD handshake closed before ready');
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

  it('maps backspace through the direct built-in keyboard report path', () => {
    const source = remoteXpcHidWorkerSourceForTest();
    expect(source).toContain('KEY_BACKSPACE');
    expect(source).toContain("if char == '\\b':");
    expect(source).toContain('return (KEY_BACKSPACE, False)');
    expect(source).toContain('mapping = keyboard_mapping(char)');
    expect(source).toContain("result = await dispatch_text(hid, direct_keyboard_service, 'connected_coredevice', 0.0)");
    expect(source).toContain("needs_modifier_keyboard = use_pasteboard or replace_existing");
  });

  it('always attempts keyboard release in finally and preserves the primary chord error', () => {
    const source = remoteXpcHidWorkerSourceForTest();
    const helperStart = source.indexOf('async def send_keyboard_chord');
    const helperEnd = source.indexOf('def normalized_point', helperStart);
    const helper = source.slice(helperStart, helperEnd);
    expect(helper).toContain('finally:');
    expect(helper).toContain('await hid.send_keyboard(service_id, [])');
    expect(helper).toContain('primary_error = error');
    expect(helper).toContain('release_error = error');
    expect(helper).toContain('raise KeyboardChordError(primary_error or release_error, release_error)');
    expect(source).toContain("primary_error = error.primary_error if isinstance(error, KeyboardChordError) else error");
    expect(source).toContain("error_details['releaseFailure'] = f'{type(release_error).__name__}: {release_error}'[:512]");
    expect(source).toContain("error=f'{type(primary_error).__name__}: {primary_error}'");
  });

  it('uses an isolated modifier-only virtual keyboard for Command-A and Command-V whole-field replacement', () => {
    const source = remoteXpcHidWorkerSourceForTest();
    expect(source).toContain("phase = 'hid_modifier_session_connect'");
    expect(source).toContain('async with isolated_modifier_keyboard(args.host, args.port) as (modifier_hid, modifier_service, modifier_create_ms):');
    expect(source).toContain("phase = 'hid_keyboard_select_all'");
    expect(source).toContain('await send_keyboard_chord(keyboard_hid, keyboard_service, [select_usage, KEY_LEFT_GUI])');
    expect(source).toContain("phase = 'hid_keyboard_paste'");
    expect(source).toContain('await send_keyboard_chord(keyboard_hid, keyboard_service, [paste_usage, KEY_LEFT_GUI], settle_s=0.120)');
    expect(source).not.toContain("phase = 'replace_existing_preflight'");
  });

  it('isolates pasteboard and modifier traffic from the primary RSD worker and stages text before selecting existing content', () => {
    const source = remoteXpcHidWorkerSourceForTest();
    expect(source).toContain('async with RemoteServiceDiscoveryService((args.host, args.port)) as pasteboard_rsd:');
    expect(source).toContain('async with PasteboardService(pasteboard_rsd) as pasteboard:');
    expect(source).not.toContain('async with PasteboardService(rsd) as pasteboard:');
    expect(source).toContain('async with RemoteServiceDiscoveryService((host, port)) as modifier_rsd:');
    expect(source).toContain('async with UniversalHIDServiceService(modifier_rsd) as modifier_hid:');
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
