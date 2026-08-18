import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { performance } from 'perf_hooks';
import { AssistantPluginError } from '../errors';

const TOOLCHAIN_VERSION = '10.2.1';
const WORKER_IDLE_MS = 15 * 60_000;
const WORKER_STARTUP_MS = 12_000;
const MUTATION_READY_BUDGET_MS = 2_500;
const REQUEST_TIMEOUT_MS = 12_000;
const RSD_ENDPOINT_CACHE_TTL_MS = 30_000;
const RSD_ENDPOINT_PERSISTED_TTL_MS = 10 * 60_000;
const MAX_TEXT_LENGTH = 2048;
const MAX_STDERR = 8 * 1024;

export interface RemoteXpcHidInput {
  controllerHome: string;
  deviceIdentifier: string;
  udid: string;
  width?: number;
  height?: number;
  action: 'tap' | 'swipe' | 'type';
  textMode?: 'auto' | 'keys' | 'pasteboard';
  replaceExisting?: boolean;
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  durationMs?: number;
  text?: string;
}

export interface RemoteXpcHidResult {
  backend: 'remote-xpc-hid';
  reusedWorker: boolean;
  endpoint: { host: string; port: number };
  result: Record<string, unknown>;
  timings: {
    workerStartupMs: number;
    workerReadyMs: number;
    requestMs: number;
    hidMs?: number;
  };
}

interface RsdEndpoint {
  host: string;
  port: number;
}

interface PendingRequest {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

class WorkerRequestError extends Error {
  readonly phase?: string;
  readonly mutationDispatched?: boolean;

  constructor(message: string, details: { phase?: string; mutationDispatched?: boolean } = {}) {
    super(message);
    this.name = 'WorkerRequestError';
    this.phase = details.phase;
    this.mutationDispatched = details.mutationDispatched;
  }
}

interface WarmupFailure {
  generation: number;
  recordedAt: number;
  message: string;
}

interface EndpointCacheEntry {
  observedAt: number;
  endpoints: RsdEndpoint[];
}

interface WorkerRecord {
  key: string;
  endpoint: RsdEndpoint;
  process: ChildProcessWithoutNullStreams;
  pending: Map<string, PendingRequest>;
  ready: Promise<Record<string, unknown>>;
  readyState: 'starting' | 'ready' | 'failed';
  lastUsedAt: number;
  stderrTail: string;
  idleTimer?: NodeJS.Timeout;
}

type TestExecutor = (input: RemoteXpcHidInput) => Promise<RemoteXpcHidResult>;
let testExecutor: TestExecutor | undefined;
const workers = new Map<string, WorkerRecord>();
const warmups = new Map<string, Promise<void>>();
const workerGenerations = new Map<string, number>();
const warmupFailures = new Map<string, WarmupFailure>();
const endpointCache = new Map<string, EndpointCacheEntry>();

export function setRemoteXpcHidExecutorForTest(executor: TestExecutor | undefined): void {
  testExecutor = executor;
}

export function resetRemoteXpcHidForTest(): void {
  testExecutor = undefined;
  for (const worker of workers.values()) stopWorker(worker);
  workers.clear();
  warmups.clear();
  workerGenerations.clear();
  warmupFailures.clear();
  endpointCache.clear();
}

export function remoteXpcHidStatus(controllerHome: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const python = resolvePython(controllerHome, env);
  return {
    backend: 'remote-xpc-hid',
    available: Boolean(python),
    python,
    toolchainVersion: TOOLCHAIN_VERSION,
    transport: 'macos-trusted-coredevice-rsd',
    runnerOwned: false,
  };
}

function resolvePython(controllerHome: string, env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.FORGE_IOS_HID_PYTHON?.trim();
  const candidates = [
    explicit,
    join(controllerHome, 'toolchains', `pymobiledevice3-${TOOLCHAIN_VERSION}-py39`, 'bin', 'python'),
    join(controllerHome, 'toolchains', `pymobiledevice3-${TOOLCHAIN_VERSION}`, 'bin', 'python'),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(candidate));
}

function workerSource(): string {
  return String.raw`#!/usr/bin/env python3
import argparse
import asyncio
import contextlib
import json
import sys
import time

from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
from pymobiledevice3.remote.core_device.pasteboard_service import PasteboardService
from pymobiledevice3.remote.core_device.hid_service import (
    ASCII_TO_HID,
    DIGITIZER_SURFACE_MAIN_TOUCHSCREEN,
    KEY_BACKSPACE,
    KEY_LEFT_GUI,
    KEY_LEFT_SHIFT,
    TOUCHSCREEN_STATE_CONTACT,
    TOUCHSCREEN_STATE_RELEASE,
    UniversalHIDServiceService,
    touch_session,
)


def keyboard_mapping(char):
    if char == '\b':
        return (KEY_BACKSPACE, False)
    return ASCII_TO_HID.get(char)


class KeyboardChordError(RuntimeError):
    def __init__(self, primary_error, release_error=None):
        super().__init__(str(primary_error))
        self.primary_error = primary_error
        self.release_error = release_error


class PasteboardOperationError(RuntimeError):
    def __init__(self, primary_error, primary_phase, restore_error=None):
        super().__init__(str(primary_error))
        self.primary_error = primary_error
        self.primary_phase = primary_phase
        self.restore_error = restore_error


async def send_keyboard_chord(hid, service_id, usage_codes, hold_s=0.040, settle_s=0.040):
    primary_error = None
    release_error = None
    try:
        try:
            await hid.send_keyboard(service_id, usage_codes)
            await asyncio.sleep(hold_s)
        except Exception as error:
            primary_error = error
    finally:
        try:
            await hid.send_keyboard(service_id, [])
        except Exception as error:
            release_error = error
    if primary_error is not None or release_error is not None:
        raise KeyboardChordError(primary_error or release_error, release_error) from (primary_error or release_error)
    await asyncio.sleep(settle_s)


@contextlib.asynccontextmanager
async def isolated_modifier_keyboard(host, port):
    async with RemoteServiceDiscoveryService((host, port)) as modifier_rsd:
        async with UniversalHIDServiceService(modifier_rsd) as modifier_hid:
            started = time.perf_counter()
            service_id = await modifier_hid.create_keyboard_service(product='Forge modifier keyboard')
            create_ms = (time.perf_counter() - started) * 1000.0
            await modifier_hid.send_keyboard(service_id, [])
            await asyncio.sleep(0.060)
            try:
                yield modifier_hid, service_id, create_ms
            finally:
                try:
                    await modifier_hid.send_keyboard(service_id, [])
                except Exception:
                    pass


def normalized_point(x, y, width, height):
    if width <= 1 or height <= 1:
        raise ValueError('display dimensions must be > 1')
    nx = max(0, min(65535, int(x * 65535 / (width - 1))))
    ny = max(0, min(65535, int(y * 65535 / (height - 1))))
    return nx, ny


def response(request_id, ok, result=None, error=None, details=None):
    payload = {'id': request_id, 'ok': ok}
    if result is not None:
        payload['result'] = result
    if error is not None:
        payload['error'] = error
    if details is not None:
        payload['details'] = details
    print(json.dumps(payload, ensure_ascii=False), flush=True)


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', required=True, type=int)
    args = parser.parse_args()
    async with RemoteServiceDiscoveryService((args.host, args.port)) as rsd:
        async with touch_session(rsd) as hid:
            connected = await hid.list_connected_services()
            service_rows = connected.get('connectedServices', []) if isinstance(connected, dict) else []
            service_ids = [row.get('_ServiceID') for row in service_rows if isinstance(row, dict)]
            rsd_services = sorted((getattr(rsd, 'peer_info', {}) or {}).get('Services', {}).keys())
            direct_keyboard_service = None
            direct_keyboard_product = None
            for row in service_rows:
                if not isinstance(row, dict):
                    continue
                service_id = row.get('_ServiceID')
                if not isinstance(service_id, int) or service_id <= 0:
                    continue
                device_hint = str(row.get('DeviceTypeHint') or '').lower()
                product = str(row.get('Product') or '')
                if device_hint == 'keyboard' or 'keyboard' in product.lower():
                    direct_keyboard_service = service_id
                    direct_keyboard_product = product or None
                    break
            print(json.dumps({
                'ready': True,
                'serviceIds': service_ids,
                'keyboardReady': direct_keyboard_service is not None,
                'keyboardReused': direct_keyboard_service is not None,
                'keyboardSource': 'connected_coredevice' if direct_keyboard_service is not None else 'none',
                'keyboardProduct': direct_keyboard_product,
                'modifierKeyboardSource': 'virtual_coredevice_lazy',
                'pasteboardAvailable': 'com.apple.coredevice.pasteboardservice' in rsd_services,
                'pasteboardTransport': 'independent_rsd',
            }), flush=True)
            while True:
                line = await asyncio.to_thread(sys.stdin.readline)
                if not line:
                    return
                request = None
                phase = 'request_decode'
                mutation_dispatched = False
                try:
                    request = json.loads(line)
                    request_id = str(request.get('id', ''))
                    action = request.get('action')
                    request_started = time.perf_counter()
                    hid_started = time.perf_counter()
                    if action == 'tap':
                        phase = 'hid_prepare_tap'
                        nx, ny = normalized_point(int(request['x']), int(request['y']), int(request['width']), int(request['height']))
                        phase = 'hid_tap_contact'
                        mutation_dispatched = True
                        await hid.send_touchscreen(TOUCHSCREEN_STATE_CONTACT, nx, ny, DIGITIZER_SURFACE_MAIN_TOUCHSCREEN)
                        await asyncio.sleep(0.055)
                        await hid.send_touchscreen(TOUCHSCREEN_STATE_RELEASE, nx, ny, DIGITIZER_SURFACE_MAIN_TOUCHSCREEN)
                        result = {'action': 'tap', 'hid': [nx, ny]}
                    elif action == 'swipe':
                        x, y = int(request['x']), int(request['y'])
                        x2, y2 = int(request['x2']), int(request['y2'])
                        width, height = int(request['width']), int(request['height'])
                        duration_ms = max(80, min(int(request.get('durationMs', 250)), 3000))
                        duration = duration_ms / 1000.0
                        steps = max(4, min(60, round(duration * 60)))
                        phase = 'hid_swipe_contact'
                        mutation_dispatched = True
                        for index in range(steps + 1):
                            ratio = index / steps
                            px = round(x + (x2 - x) * ratio)
                            py = round(y + (y2 - y) * ratio)
                            nx, ny = normalized_point(px, py, width, height)
                            await hid.send_touchscreen(TOUCHSCREEN_STATE_CONTACT, nx, ny, DIGITIZER_SURFACE_MAIN_TOUCHSCREEN)
                            await asyncio.sleep(duration / steps)
                        nx2, ny2 = normalized_point(x2, y2, width, height)
                        await hid.send_touchscreen(TOUCHSCREEN_STATE_RELEASE, nx2, ny2, DIGITIZER_SURFACE_MAIN_TOUCHSCREEN)
                        result = {'action': 'swipe', 'durationMs': duration_ms}
                    elif action == 'type':
                        text = str(request.get('text', ''))
                        text_mode = str(request.get('textMode', 'auto'))
                        if text_mode not in ('auto', 'keys', 'pasteboard'):
                            raise ValueError('unsupported textMode')
                        key_supported = all(keyboard_mapping(char) is not None for char in text)
                        replace_existing = bool(request.get('replaceExisting', False))
                        pasteboard_available = 'com.apple.coredevice.pasteboardservice' in rsd_services
                        use_pasteboard = text_mode == 'pasteboard' or (text_mode == 'auto' and (not key_supported or len(text) >= 32))
                        if use_pasteboard and not pasteboard_available:
                            if text_mode == 'auto' and key_supported:
                                use_pasteboard = False
                            else:
                                raise RuntimeError('CoreDevice pasteboard service is unavailable for Unicode/pasteboard text input')
                        if text_mode == 'keys' and not key_supported:
                            raise ValueError('unsupported HID character in keys mode')

                        needs_modifier_keyboard = use_pasteboard or replace_existing

                        async def dispatch_text(keyboard_hid, keyboard_service, keyboard_source, keyboard_create_ms):
                            nonlocal phase, mutation_dispatched
                            if use_pasteboard:
                                phase = 'pasteboard_connect'
                                pasteboard_restored = True
                                async with RemoteServiceDiscoveryService((args.host, args.port)) as pasteboard_rsd:
                                    async with PasteboardService(pasteboard_rsd) as pasteboard:
                                        phase = 'pasteboard_snapshot'
                                        previous = await pasteboard.get()
                                        previous_snapshot = previous.get('pasteboard') if isinstance(previous.get('pasteboard'), dict) else previous
                                        previous_items = previous_snapshot.get('items') if isinstance(previous_snapshot, dict) else None
                                        previous_source = previous_snapshot.get('sourceMetadata') if isinstance(previous_snapshot, dict) else None
                                        if not isinstance(previous_items, list):
                                            raise RuntimeError('CoreDevice pasteboard snapshot is not restorable; refusing temporary clipboard overwrite')
                                        operation_error = None
                                        operation_phase = None
                                        restore_error = None
                                        try:
                                            phase = 'pasteboard_set_text'
                                            mutation_dispatched = True
                                            await pasteboard.set_text(text)
                                            if replace_existing:
                                                select_mapping = keyboard_mapping('a')
                                                if select_mapping is None:
                                                    raise RuntimeError('HID A key mapping unavailable')
                                                select_usage, _ = select_mapping
                                                phase = 'hid_keyboard_select_all'
                                                await send_keyboard_chord(keyboard_hid, keyboard_service, [select_usage, KEY_LEFT_GUI])
                                            paste_mapping = keyboard_mapping('v')
                                            if paste_mapping is None:
                                                raise RuntimeError('HID V key mapping unavailable')
                                            paste_usage, _ = paste_mapping
                                            phase = 'hid_keyboard_paste'
                                            await send_keyboard_chord(keyboard_hid, keyboard_service, [paste_usage, KEY_LEFT_GUI], settle_s=0.120)
                                        except Exception as error:
                                            operation_error = error
                                            operation_phase = phase
                                        finally:
                                            phase = 'pasteboard_restore'
                                            try:
                                                await pasteboard.set(previous_items, source_metadata=previous_source if isinstance(previous_source, dict) else None)
                                            except Exception as error:
                                                pasteboard_restored = False
                                                restore_error = error
                                        if operation_error is not None or restore_error is not None:
                                            primary_error = operation_error or restore_error
                                            primary_phase = operation_phase or 'pasteboard_restore'
                                            raise PasteboardOperationError(primary_error, primary_phase, restore_error) from primary_error
                                return {
                                    'action': 'type',
                                    'length': len(text),
                                    'inputMode': 'pasteboard',
                                    'replaceExisting': replace_existing,
                                    'keyboardSource': keyboard_source,
                                    'keyboardCreateMs': round(keyboard_create_ms, 2),
                                    'pasteboardTransport': 'independent_rsd',
                                    'pasteboardRestored': pasteboard_restored,
                                }

                            if replace_existing:
                                select_mapping = keyboard_mapping('a')
                                if select_mapping is None:
                                    raise RuntimeError('HID A key mapping unavailable')
                                select_usage, _ = select_mapping
                                phase = 'hid_keyboard_select_all'
                                mutation_dispatched = True
                                await send_keyboard_chord(keyboard_hid, keyboard_service, [select_usage, KEY_LEFT_GUI])
                            if replace_existing and not text:
                                phase = 'hid_keyboard_delete_selection'
                                mutation_dispatched = True
                                await send_keyboard_chord(keyboard_hid, keyboard_service, [KEY_BACKSPACE])
                            else:
                                for char in text:
                                    mapping = keyboard_mapping(char)
                                    if mapping is None:
                                        raise ValueError('unsupported HID character in keys mode')
                                    usage, shifted = mapping
                                    pressed = [usage]
                                    if shifted:
                                        pressed.append(KEY_LEFT_SHIFT)
                                    phase = 'hid_keyboard_write'
                                    mutation_dispatched = True
                                    await send_keyboard_chord(keyboard_hid, keyboard_service, pressed, hold_s=0.018, settle_s=0.018)
                            await keyboard_hid.send_keyboard(keyboard_service, [])
                            return {
                                'action': 'type',
                                'length': len(text),
                                'inputMode': 'keys',
                                'replaceExisting': replace_existing,
                                'keyboardSource': keyboard_source,
                                'keyboardCreateMs': round(keyboard_create_ms, 2),
                            }

                        if not needs_modifier_keyboard and direct_keyboard_service is not None:
                            result = await dispatch_text(hid, direct_keyboard_service, 'connected_coredevice', 0.0)
                        else:
                            phase = 'hid_modifier_session_connect'
                            async with isolated_modifier_keyboard(args.host, args.port) as (modifier_hid, modifier_service, modifier_create_ms):
                                modifier_source = 'isolated_virtual_modifier' if needs_modifier_keyboard else 'isolated_virtual_fallback'
                                result = await dispatch_text(modifier_hid, modifier_service, modifier_source, modifier_create_ms)
                    else:
                        raise ValueError('unsupported action')
                    hid_ms = (time.perf_counter() - hid_started) * 1000.0
                    result['timings'] = {
                        'hidMs': round(hid_ms, 2),
                        'requestMs': round((time.perf_counter() - request_started) * 1000.0, 2),
                    }
                    result['mutationDispatched'] = mutation_dispatched
                    response(request_id, True, result)
                except Exception as error:
                    if isinstance(error, PasteboardOperationError):
                        primary_error = error.primary_error
                        error_phase = error.primary_phase
                        release_error = None
                        pasteboard_restore_error = error.restore_error
                    else:
                        primary_error = error.primary_error if isinstance(error, KeyboardChordError) else error
                        error_phase = phase
                        release_error = error.release_error if isinstance(error, KeyboardChordError) else None
                        pasteboard_restore_error = None
                    error_details = {'phase': error_phase, 'mutationDispatched': mutation_dispatched}
                    if release_error is not None:
                        error_details['releaseFailure'] = f'{type(release_error).__name__}: {release_error}'[:512]
                    if pasteboard_restore_error is not None:
                        error_details['pasteboardRestoreFailure'] = f'{type(pasteboard_restore_error).__name__}: {pasteboard_restore_error}'[:512]
                    response(
                        str(request.get('id', '')) if isinstance(request, dict) else '',
                        False,
                        error=f'{type(primary_error).__name__}: {primary_error}',
                        details=error_details,
                    )


if __name__ == '__main__':
    asyncio.run(main())
`;
}

export function remoteXpcHidWorkerSourceForTest(): string {
  return workerSource();
}

function deviceInputRoot(controllerHome: string): string {
  const root = join(controllerHome, 'runtime', 'device-input');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function materializeWorker(controllerHome: string): string {
  const source = workerSource();
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const path = join(deviceInputRoot(controllerHome), `remote-xpc-hid-${hash}.py`);
  if (!existsSync(path)) writeFileSync(path, source, { encoding: 'utf8', mode: 0o700 });
  return path;
}

function persistentEndpointPath(controllerHome: string, udid: string): string {
  const identity = createHash('sha256').update(udid).digest('hex').slice(0, 24);
  return join(deviceInputRoot(controllerHome), `rsd-endpoint-${identity}.json`);
}

function validEndpoint(value: unknown): RsdEndpoint | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const endpoint = value as Record<string, unknown>;
  if (typeof endpoint.host !== 'string' || !/^[0-9a-fA-F:]+$/.test(endpoint.host)) return undefined;
  if (typeof endpoint.port !== 'number' || !Number.isInteger(endpoint.port) || endpoint.port <= 0 || endpoint.port > 65_535) return undefined;
  return { host: endpoint.host, port: endpoint.port };
}

function readPersistentEndpoint(controllerHome: string, udid: string, now = Date.now()): RsdEndpoint | undefined {
  const path = persistentEndpointPath(controllerHome, udid);
  if (!existsSync(path)) return undefined;
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const observedAt = typeof record.observedAt === 'number' ? record.observedAt : Number.NaN;
    const ageMs = now - observedAt;
    const endpoint = record.schemaVersion === 1 ? validEndpoint(record.endpoint) : undefined;
    if (!endpoint || !Number.isFinite(ageMs) || ageMs < -5_000 || ageMs > RSD_ENDPOINT_PERSISTED_TTL_MS) {
      try { unlinkSync(path); } catch {}
      return undefined;
    }
    return endpoint;
  } catch {
    try { unlinkSync(path); } catch {}
    return undefined;
  }
}

function rememberPersistentEndpoint(
  controllerHome: string,
  udid: string,
  endpoint: RsdEndpoint,
  observedAt = Date.now(),
): void {
  const path = persistentEndpointPath(controllerHome, udid);
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, observedAt, endpoint }), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    try { unlinkSync(tmp); } catch {}
  }
}

export function remoteXpcHidPersistentEndpointCacheForTest(
  controllerHome: string,
  udid: string,
  endpoint?: RsdEndpoint,
  ageMs = 0,
): RsdEndpoint | undefined {
  if (endpoint) rememberPersistentEndpoint(controllerHome, udid, endpoint, Date.now() - Math.max(0, ageMs));
  return readPersistentEndpoint(controllerHome, udid);
}

function persistedEndpointActiveInIfconfig(host: string, output: string): boolean | undefined {
  const normalizedHost = host.toLowerCase();
  const remoteMatch = normalizedHost.match(/^([0-9a-f:]+)::1$/);
  if (!remoteMatch) return undefined;
  const expectedLocal = `${remoteMatch[1]}::2`;
  let inUtun = false;
  let sawUtun = false;
  for (const line of output.split(/\r?\n/)) {
    const interfaceMatch = line.match(/^([A-Za-z0-9._-]+):/);
    if (interfaceMatch) {
      inUtun = interfaceMatch[1].startsWith('utun');
      if (inUtun) sawUtun = true;
      continue;
    }
    if (!inUtun) continue;
    const ipv6 = line.match(/\binet6\s+([0-9a-fA-F:]+)\s+prefixlen\s+(\d+)/);
    if (!ipv6 || Number(ipv6[2]) !== 64) continue;
    if (ipv6[1].toLowerCase() === expectedLocal) return true;
  }
  return sawUtun ? false : undefined;
}

function persistedEndpointActive(host: string): boolean | undefined {
  const result = spawnSync('/sbin/ifconfig', [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000 });
  if (result.status !== 0 || result.error || typeof result.stdout !== 'string') return undefined;
  return persistedEndpointActiveInIfconfig(host, result.stdout);
}

function invalidatePersistentEndpoint(controllerHome: string, udid: string): void {
  try { unlinkSync(persistentEndpointPath(controllerHome, udid)); } catch {}
}

export function remoteXpcHidPersistedEndpointActiveForTest(host: string, ifconfigOutput: string): boolean | undefined {
  return persistedEndpointActiveInIfconfig(host, ifconfigOutput);
}

export function parseMacOSTrustedRsdEndpoints(output: string, udid: string): RsdEndpoint[] {
  const endpoints: RsdEndpoint[] = [];
  let host: string | undefined;
  let latestHost: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes(udid)) continue;
    const tunnel = line.match(/remote\s+([0-9a-fA-F:]+)\s*$/);
    if (tunnel) {
      host = tunnel[1];
      latestHost = host;
      continue;
    }
    const portMatch = line.match(/Creating RSD backend client device for server port\s+(\d+)/);
    if (portMatch && host) {
      const port = Number(portMatch[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) endpoints.push({ host, port });
    }
  }
  if (!latestHost) return [];
  const unique = new Map<string, RsdEndpoint>();
  for (const endpoint of endpoints) {
    if (endpoint.host === latestHost) unique.set(`${endpoint.host}:${endpoint.port}`, endpoint);
  }
  return [...unique.values()].slice(-3).reverse();
}

function cachedEndpoints(udid: string, now = Date.now()): RsdEndpoint[] | undefined {
  const cached = endpointCache.get(udid);
  if (!cached) return undefined;
  if (now - cached.observedAt > RSD_ENDPOINT_CACHE_TTL_MS) {
    endpointCache.delete(udid);
    return undefined;
  }
  return cached.endpoints.map((endpoint) => ({ ...endpoint }));
}

function rememberEndpoints(udid: string, endpoints: RsdEndpoint[], now = Date.now()): void {
  endpointCache.set(udid, { observedAt: now, endpoints: endpoints.map((endpoint) => ({ ...endpoint })) });
}

export function remoteXpcHidEndpointCacheForTest(
  udid: string,
  endpoints: RsdEndpoint[],
  ageMs = 0,
): RsdEndpoint[] | undefined {
  rememberEndpoints(udid, endpoints, Date.now() - Math.max(0, ageMs));
  return cachedEndpoints(udid);
}

function endpointIdentity(endpoint: RsdEndpoint): string {
  return `${endpoint.host}:${endpoint.port}`;
}

function novelEndpoints(previous: readonly RsdEndpoint[], refreshed: readonly RsdEndpoint[]): RsdEndpoint[] {
  const attempted = new Set(previous.map(endpointIdentity));
  return refreshed.filter((endpoint) => !attempted.has(endpointIdentity(endpoint)));
}

export function remoteXpcHidNovelEndpointsForTest(
  previous: readonly RsdEndpoint[],
  refreshed: readonly RsdEndpoint[],
): RsdEndpoint[] {
  return novelEndpoints(previous, refreshed);
}

function trustedTunnelLogArgs(udid: string): string[] {
  if (!/^[A-Za-z0-9-]+$/.test(udid)) {
    throw new AssistantPluginError('IOS_HID_DEVICE_ID_INVALID', 'The physical iPhone UDID cannot be used for trusted-tunnel discovery.', { retryable: false });
  }
  const predicate = `process == "remotepairingd" AND eventMessage CONTAINS "${udid}" AND (eventMessage CONTAINS "Tunnel established" OR eventMessage CONTAINS "Creating RSD backend client device for server port")`;
  return ['show', '--last', '12h', '--style', 'compact', '--predicate', predicate];
}

async function discoverEndpoints(udid: string, forceRefresh = false): Promise<RsdEndpoint[]> {
  if (!forceRefresh) {
    const cached = cachedEndpoints(udid);
    if (cached?.length) return cached;
  }
  const args = trustedTunnelLogArgs(udid);
  return await new Promise<RsdEndpoint[]>((resolve, reject) => {
    const child = spawn('/usr/bin/log', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish(new Error('macOS trusted-tunnel discovery timed out after 15000ms.'));
    }, 15_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(new AssistantPluginError('IOS_HID_RSD_DISCOVERY_FAILED', error.message, { retryable: true }));
        return;
      }
      const endpoints = parseMacOSTrustedRsdEndpoints(stdout, udid);
      if (endpoints.length === 0) {
        reject(new AssistantPluginError('IOS_HID_RSD_UNAVAILABLE', 'No current macOS trusted CoreDevice RSD endpoint was found for the selected iPhone.', {
          retryable: true,
          details: { udid },
        }));
        return;
      }
      rememberEndpoints(udid, endpoints);
      resolve(endpoints);
    };
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-2 * 1024 * 1024);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-MAX_STDERR);
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || `macOS trusted-tunnel discovery exited with code ${code}.`));
    });
  });
}

function stopWorker(worker: WorkerRecord): void {
  if (worker.idleTimer) clearTimeout(worker.idleTimer);
  for (const pending of worker.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error('RemoteXPC HID worker stopped.'));
  }
  worker.pending.clear();
  try { worker.process.stdin.end(); } catch {}
  try { worker.process.kill('SIGTERM'); } catch {}
  if (workers.get(worker.key) === worker) workers.delete(worker.key);
}

function scheduleIdleStop(worker: WorkerRecord): void {
  if (worker.idleTimer) clearTimeout(worker.idleTimer);
  worker.idleTimer = setTimeout(() => stopWorker(worker), WORKER_IDLE_MS);
  worker.idleTimer.unref?.();
}

function workerGeneration(deviceIdentifier: string): number {
  return workerGenerations.get(deviceIdentifier) ?? 0;
}

function warmupFailureError(deviceIdentifier: string, failure: WarmupFailure): AssistantPluginError {
  return new AssistantPluginError(
    'IOS_HID_INPUT_NOT_SENT',
    `RemoteXPC HID warmup failed before any input was sent: ${failure.message}`,
    {
      retryable: true,
      details: {
        deviceIdentifier,
        mutationDispatched: false,
        phase: 'worker_warmup',
        warmupFailureAgeMs: Math.max(0, Date.now() - failure.recordedAt),
      },
    },
  );
}

export function remoteXpcHidWarmupFailureErrorForTest(deviceIdentifier: string, message: string): AssistantPluginError {
  return warmupFailureError(deviceIdentifier, {
    generation: workerGeneration(deviceIdentifier),
    recordedAt: Date.now(),
    message: message.slice(0, 1024),
  });
}

export function stopRemoteXpcHidForDevice(deviceIdentifier: string): Record<string, unknown> {
  const worker = workers.get(deviceIdentifier);
  const cancelledWarmup = warmups.has(deviceIdentifier);
  workerGenerations.set(deviceIdentifier, workerGeneration(deviceIdentifier) + 1);
  warmups.delete(deviceIdentifier);
  warmupFailures.delete(deviceIdentifier);
  if (worker) stopWorker(worker);
  return {
    backend: 'remote-xpc-hid',
    state: 'stopped',
    workerStopped: Boolean(worker),
    warmupCancelled: cancelledWarmup,
    runnerOwned: false,
  };
}

function startWorker(input: Pick<RemoteXpcHidInput, 'controllerHome' | 'deviceIdentifier'>, endpoint: RsdEndpoint): WorkerRecord {
  const python = resolvePython(input.controllerHome, process.env);
  if (!python) {
    throw new AssistantPluginError('IOS_HID_TOOLCHAIN_MISSING', `The Controller-owned pymobiledevice3 ${TOOLCHAIN_VERSION} toolchain is unavailable.`, {
      retryable: false,
      details: { expected: join(input.controllerHome, 'toolchains', `pymobiledevice3-${TOOLCHAIN_VERSION}-py39`, 'bin', 'python') },
    });
  }
  const script = materializeWorker(input.controllerHome);
  const workerPath = dirname(python);
  const child = spawn(python, [
    '-u', script,
    '--host', endpoint.host,
    '--port', String(endpoint.port),
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: `${workerPath}:/usr/bin:/bin:/usr/sbin:/sbin`,
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
    },
  });
  const key = input.deviceIdentifier;
  const pending = new Map<string, PendingRequest>();
  let readyResolve!: (value: Record<string, unknown>) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const worker: WorkerRecord = {
    key, endpoint, process: child, pending, ready, readyState: 'starting', lastUsedAt: Date.now(), stderrTail: '',
  };
  workers.set(key, worker);

  const startupTimer = setTimeout(() => {
    readyReject(new Error(`RemoteXPC HID worker startup timed out after ${WORKER_STARTUP_MS}ms.`));
    stopWorker(worker);
  }, WORKER_STARTUP_MS);

  const stdout = createInterface({ input: child.stdout });
  stdout.on('line', (line) => {
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (payload.ready === true) {
      clearTimeout(startupTimer);
      worker.readyState = 'ready';
      readyResolve(payload);
      scheduleIdleStop(worker);
      return;
    }
    const id = typeof payload.id === 'string' ? payload.id : '';
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    if (payload.ok === true && payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)) {
      request.resolve(payload.result as Record<string, unknown>);
    } else {
      const details = payload.details && typeof payload.details === 'object' && !Array.isArray(payload.details)
        ? payload.details as Record<string, unknown>
        : {};
      request.reject(new WorkerRequestError(
        typeof payload.error === 'string' ? payload.error : 'RemoteXPC HID request failed.',
        {
          phase: typeof details.phase === 'string' ? details.phase : undefined,
          mutationDispatched: typeof details.mutationDispatched === 'boolean' ? details.mutationDispatched : undefined,
        },
      ));
    }
  });
  child.stderr.on('data', (chunk) => {
    worker.stderrTail = `${worker.stderrTail}${String(chunk)}`.slice(-MAX_STDERR);
  });
  child.on('exit', (code, signal) => {
    clearTimeout(startupTimer);
    worker.readyState = 'failed';
    const message = `RemoteXPC HID worker exited (${code ?? signal ?? 'unknown'}). ${worker.stderrTail}`.trim();
    readyReject(new Error(message));
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    pending.clear();
    if (workers.get(key) === worker) workers.delete(key);
  });
  child.on('error', (error) => {
    clearTimeout(startupTimer);
    worker.readyState = 'failed';
    readyReject(error);
  });
  return worker;
}

async function workerRequest(worker: WorkerRecord, input: RemoteXpcHidInput): Promise<{
  result: Record<string, unknown>;
  workerReadyMs: number;
  requestMs: number;
}> {
  const readyStartedAt = performance.now();
  await worker.ready;
  const workerReadyMs = Math.round((performance.now() - readyStartedAt) * 100) / 100;
  const id = randomUUID();
  const payload: Record<string, unknown> = {
    id,
    action: input.action,
  };
  if (input.width !== undefined) payload.width = input.width;
  if (input.height !== undefined) payload.height = input.height;
  if (input.x !== undefined) payload.x = input.x;
  if (input.y !== undefined) payload.y = input.y;
  if (input.x2 !== undefined) payload.x2 = input.x2;
  if (input.y2 !== undefined) payload.y2 = input.y2;
  if (input.durationMs !== undefined) payload.durationMs = input.durationMs;
  if (input.textMode !== undefined) payload.textMode = input.textMode;
  if (input.replaceExisting !== undefined) payload.replaceExisting = input.replaceExisting;
  if (input.text !== undefined) payload.text = input.text;
  worker.lastUsedAt = Date.now();
  scheduleIdleStop(worker);
  const requestStartedAt = performance.now();
  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.pending.delete(id);
      reject(new Error(`RemoteXPC HID request timed out after ${REQUEST_TIMEOUT_MS}ms.`));
    }, REQUEST_TIMEOUT_MS);
    worker.pending.set(id, { resolve, reject, timer });
    worker.process.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
      if (!error) return;
      const request = worker.pending.get(id);
      if (!request) return;
      worker.pending.delete(id);
      clearTimeout(request.timer);
      reject(error);
    });
  });
  return {
    result,
    workerReadyMs,
    requestMs: Math.round((performance.now() - requestStartedAt) * 100) / 100,
  };
}

function validateInput(input: RemoteXpcHidInput): void {
  if (!input.udid) throw new AssistantPluginError('IOS_HID_UDID_MISSING', 'RemoteXPC HID requires the physical iPhone hardware UDID.', { retryable: false });
  const requiresDisplay = input.action === 'tap' || input.action === 'swipe';
  if (requiresDisplay && (!Number.isFinite(input.width) || !Number.isFinite(input.height) || input.width! <= 1 || input.height! <= 1)) {
    throw new AssistantPluginError('IOS_HID_DISPLAY_INVALID', 'RemoteXPC touch input requires current positive display pixel dimensions.', { retryable: true });
  }
  const points = input.action === 'tap'
    ? [[input.x, input.y, 'tap'] as const]
    : input.action === 'swipe'
      ? [[input.x, input.y, 'from'] as const, [input.x2, input.y2, 'to'] as const]
      : [];
  for (const [x, y, label] of points) {
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `${label} coordinates must be finite display pixels.`, { retryable: false });
    }
    if (x < 0 || y < 0 || x > input.width! - 1 || y > input.height! - 1) {
      throw new AssistantPluginError('IOS_HID_COORDINATE_OUT_OF_BOUNDS', `${label} coordinates are outside the current CoreDevice display.`, {
        retryable: false,
        details: { x, y, width: input.width, height: input.height },
      });
    }
  }
  if (input.action === 'type') {
    const text = input.text ?? '';
    if (text.length > MAX_TEXT_LENGTH) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `RemoteXPC HID text is limited to ${MAX_TEXT_LENGTH} characters.`, { retryable: false });
    const textMode = input.textMode ?? 'auto';
    if (!['auto', 'keys', 'pasteboard'].includes(textMode)) {
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Unsupported RemoteXPC HID text mode: ${textMode}.`, { retryable: false });
    }
    if (textMode === 'keys' && [...text].some((character) => character.charCodeAt(0) > 0x7f)) {
      throw new AssistantPluginError('IOS_HID_UNICODE_TEXT_UNSUPPORTED', 'RemoteXPC HID keys mode accepts ASCII only; use auto or pasteboard mode for Unicode text.', { retryable: false });
    }
  }
}

async function establishWorker(
  input: Pick<RemoteXpcHidInput, 'controllerHome' | 'deviceIdentifier' | 'udid'>,
  generation = workerGeneration(input.deviceIdentifier),
): Promise<void> {
  if (workers.has(input.deviceIdentifier)) return;
  const cached = cachedEndpoints(input.udid);
  let persisted = cached?.length ? undefined : readPersistentEndpoint(input.controllerHome, input.udid);
  if (persisted && persistedEndpointActive(persisted.host) === false) {
    invalidatePersistentEndpoint(input.controllerHome, input.udid);
    persisted = undefined;
  }
  const initialEndpoints = cached?.length
    ? cached
    : persisted
      ? [persisted]
      : await discoverEndpoints(input.udid, true);
  if (workerGeneration(input.deviceIdentifier) !== generation) return;

  let lastError: unknown;
  let attemptedEndpointCount = 0;
  const tryEndpoints = async (endpoints: readonly RsdEndpoint[]): Promise<'ready' | 'cancelled' | 'failed'> => {
    for (const endpoint of endpoints) {
      if (workerGeneration(input.deviceIdentifier) !== generation) return 'cancelled';
      attemptedEndpointCount += 1;
      const worker = startWorker(input, endpoint);
      try {
        await worker.ready;
        if (workerGeneration(input.deviceIdentifier) !== generation) {
          stopWorker(worker);
          return 'cancelled';
        }
        warmupFailures.delete(input.deviceIdentifier);
        rememberPersistentEndpoint(input.controllerHome, input.udid, endpoint);
        return 'ready';
      } catch (error) {
        lastError = error;
        stopWorker(worker);
      }
    }
    return 'failed';
  };

  const initialResult = await tryEndpoints(initialEndpoints);
  if (initialResult !== 'failed') return;

  let refreshedEndpointCount = 0;
  let novelEndpointCount = 0;
  if (cached?.length || persisted) {
    endpointCache.delete(input.udid);
    try {
      const refreshed = await discoverEndpoints(input.udid, true);
      refreshedEndpointCount = refreshed.length;
      const novel = novelEndpoints(initialEndpoints, refreshed);
      novelEndpointCount = novel.length;
      if (novel.length > 0) {
        const refreshedResult = await tryEndpoints(novel);
        if (refreshedResult !== 'failed') return;
      }
    } catch (error) {
      lastError = error;
    }
  } else {
    endpointCache.delete(input.udid);
  }

  throw new AssistantPluginError('IOS_HID_INPUT_FAILED', lastError instanceof Error ? lastError.message : 'RemoteXPC HID input failed on all discovered trusted tunnel endpoints.', {
    retryable: true,
    details: {
      deviceIdentifier: input.deviceIdentifier,
      endpointCount: attemptedEndpointCount,
      initialEndpointCount: initialEndpoints.length,
      cacheRefreshAttempted: Boolean(cached?.length || persisted),
      persistentEndpointUsed: Boolean(persisted),
      refreshedEndpointCount,
      novelEndpointCount,
    },
  });
}

export function prewarmRemoteXpcHid(input: Pick<RemoteXpcHidInput, 'controllerHome' | 'deviceIdentifier' | 'udid'>): Record<string, unknown> {
  if (testExecutor) return { backend: 'remote-xpc-hid', state: 'test', runnerOwned: false };
  const worker = workers.get(input.deviceIdentifier);
  if (worker?.readyState === 'ready') return { backend: 'remote-xpc-hid', state: 'ready', runnerOwned: false, reusedWorker: true };
  if (worker || warmups.has(input.deviceIdentifier)) return { backend: 'remote-xpc-hid', state: 'warming', runnerOwned: false };
  if (!resolvePython(input.controllerHome, process.env)) {
    return { backend: 'remote-xpc-hid', state: 'unavailable', runnerOwned: false, reason: 'toolchain_missing' };
  }
  const generation = workerGeneration(input.deviceIdentifier);
  warmupFailures.delete(input.deviceIdentifier);
  let warmup!: Promise<void>;
  warmup = establishWorker(input, generation)
    .catch((error) => {
      if (workerGeneration(input.deviceIdentifier) === generation) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 1024);
        warmupFailures.set(input.deviceIdentifier, { generation, recordedAt: Date.now(), message });
      }
    })
    .then(() => undefined)
    .finally(() => {
      if (warmups.get(input.deviceIdentifier) === warmup) warmups.delete(input.deviceIdentifier);
    });
  warmups.set(input.deviceIdentifier, warmup);
  return { backend: 'remote-xpc-hid', state: 'warming_started', runnerOwned: false };
}

export async function awaitRemoteXpcHidPrewarm(
  input: Pick<RemoteXpcHidInput, 'controllerHome' | 'deviceIdentifier' | 'udid'>,
  budgetMs = 4_000,
): Promise<Record<string, unknown>> {
  const boundedBudgetMs = Math.max(0, Math.min(Math.round(budgetMs), 10_000));
  const initial = prewarmRemoteXpcHid(input);
  if (testExecutor) return { ...initial, waitMs: 0 };
  if (initial.state === 'ready' || initial.state === 'unavailable') return { ...initial, waitMs: 0 };
  const startedAt = performance.now();
  const current = workers.get(input.deviceIdentifier);
  const warmup = warmups.get(input.deviceIdentifier);
  const readiness = current
    ? current.ready.then(() => undefined).catch(() => undefined)
    : warmup;
  if (readiness && boundedBudgetMs > 0) {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        readiness,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, boundedBudgetMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const waitMs = Math.round((performance.now() - startedAt) * 100) / 100;
  const worker = workers.get(input.deviceIdentifier);
  if (worker?.readyState === 'ready') {
    return { backend: 'remote-xpc-hid', state: 'ready', runnerOwned: false, reusedWorker: initial.state === 'ready', waitMs };
  }
  const failure = warmupFailures.get(input.deviceIdentifier);
  if (failure?.generation === workerGeneration(input.deviceIdentifier) && !warmups.has(input.deviceIdentifier)) {
    return {
      backend: 'remote-xpc-hid', state: 'failed', runnerOwned: false, waitMs,
      errorCode: 'IOS_HID_INPUT_NOT_SENT', phase: 'worker_warmup', reason: failure.message,
    };
  }
  return {
    backend: 'remote-xpc-hid', state: 'warming', runnerOwned: false, waitMs,
    readinessBudgetMs: boundedBudgetMs,
  };
}

function numberTiming(result: Record<string, unknown>, key: string): number | undefined {
  const timings = result.timings;
  if (!timings || typeof timings !== 'object' || Array.isArray(timings)) return undefined;
  const value = (timings as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function waitForMutationWorker(
  input: Pick<RemoteXpcHidInput, 'controllerHome' | 'deviceIdentifier' | 'udid'>,
): Promise<{ worker: WorkerRecord; waitMs: number; reusedWorker: boolean }> {
  const startedAt = performance.now();
  const initiallyReady = workers.get(input.deviceIdentifier)?.readyState === 'ready';
  if (!workers.has(input.deviceIdentifier) && !warmups.has(input.deviceIdentifier)) {
    prewarmRemoteXpcHid(input);
  }
  const current = workers.get(input.deviceIdentifier);
  const warmup = warmups.get(input.deviceIdentifier);
  const readiness = current
    ? current.ready.then(() => undefined).catch(() => undefined)
    : warmup;
  if (readiness) {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        readiness,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, MUTATION_READY_BUDGET_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const waitMs = Math.round((performance.now() - startedAt) * 100) / 100;
  const worker = workers.get(input.deviceIdentifier);
  if (!worker || worker.readyState !== 'ready') {
    const failure = warmupFailures.get(input.deviceIdentifier);
    if (failure?.generation === workerGeneration(input.deviceIdentifier) && !warmups.has(input.deviceIdentifier)) {
      throw warmupFailureError(input.deviceIdentifier, failure);
    }
    throw new AssistantPluginError(
      'IOS_HID_INPUT_NOT_READY',
      `RemoteXPC HID is still warming after the ${MUTATION_READY_BUDGET_MS}ms mutation readiness budget. No input was sent; retry the same action after prewarm completes.`,
      {
        retryable: true,
        details: {
          deviceIdentifier: input.deviceIdentifier,
          mutationDispatched: false,
          workerReadyWaitMs: waitMs,
          readinessBudgetMs: MUTATION_READY_BUDGET_MS,
          prewarmContinues: warmups.has(input.deviceIdentifier) || worker?.readyState === 'starting',
        },
      },
    );
  }
  return { worker, waitMs, reusedWorker: initiallyReady };
}

async function executeDefault(input: RemoteXpcHidInput): Promise<RemoteXpcHidResult> {
  const readiness = await waitForMutationWorker(input);
  const worker = readiness.worker;
  try {
    const request = await workerRequest(worker, input);
    return {
      backend: 'remote-xpc-hid', reusedWorker: readiness.reusedWorker, endpoint: worker.endpoint, result: request.result,
      timings: {
        workerStartupMs: readiness.reusedWorker ? 0 : readiness.waitMs,
        workerReadyMs: request.workerReadyMs,
        requestMs: request.requestMs,
        hidMs: numberTiming(request.result, 'hidMs'),
      },
    };
  } catch (error) {
    stopWorker(worker);
    const workerError = error instanceof WorkerRequestError ? error : undefined;
    const mutationDispatched = workerError?.mutationDispatched;
    const message = error instanceof Error ? error.message : 'RemoteXPC HID input failed.';
    throw new AssistantPluginError(
      mutationDispatched === false ? 'IOS_HID_INPUT_NOT_SENT' : 'IOS_HID_INPUT_FAILED',
      mutationDispatched === false ? `RemoteXPC input failed before any HID mutation was sent: ${message}` : message,
      {
        retryable: true,
        details: {
          deviceIdentifier: input.deviceIdentifier,
          ...(workerError?.phase ? { phase: workerError.phase } : {}),
          ...(mutationDispatched === undefined ? {} : { mutationDispatched }),
        },
      },
    );
  }
}

export async function executeRemoteXpcHidInput(input: RemoteXpcHidInput): Promise<RemoteXpcHidResult> {
  validateInput(input);
  return testExecutor ? await testExecutor(input) : await executeDefault(input);
}
