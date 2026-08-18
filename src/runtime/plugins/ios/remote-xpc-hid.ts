import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { performance } from 'perf_hooks';
import { AssistantPluginError } from '../errors';

const TOOLCHAIN_VERSION = '10.2.1';
const WORKER_IDLE_MS = 15 * 60_000;
const WORKER_STARTUP_MS = 12_000;
const MUTATION_READY_BUDGET_MS = 2_500;
const REQUEST_TIMEOUT_MS = 12_000;
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

export function setRemoteXpcHidExecutorForTest(executor: TestExecutor | undefined): void {
  testExecutor = executor;
}

export function resetRemoteXpcHidForTest(): void {
  testExecutor = undefined;
  for (const worker of workers.values()) stopWorker(worker);
  workers.clear();
  warmups.clear();
  workerGenerations.clear();
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
    touch_session,
)


def keyboard_mapping(char):
    if char == '\b':
        return (KEY_BACKSPACE, False)
    return ASCII_TO_HID.get(char)


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
            keyboard_started = time.perf_counter()
            keyboard_candidates = []
            for row in service_rows:
                if not isinstance(row, dict):
                    continue
                service_id = row.get('_ServiceID')
                if not isinstance(service_id, int) or service_id <= 0:
                    continue
                device_hint = str(row.get('DeviceTypeHint') or '').lower()
                product = str(row.get('Product') or '').lower()
                if device_hint == 'keyboard' or 'keyboard' in product:
                    keyboard_candidates.append((0 if device_hint == 'keyboard' else 1, service_id, row))
            if not keyboard_candidates:
                raise RuntimeError('No connected CoreDevice keyboard HID service is available; refusing to create a custom virtual keyboard service')
            keyboard_candidates.sort(key=lambda item: (item[0], item[1]))
            _, keyboard_service, keyboard_row = keyboard_candidates[0]
            keyboard_ready_ms = (time.perf_counter() - keyboard_started) * 1000.0
            print(json.dumps({
                'ready': True,
                'serviceIds': service_ids,
                'keyboardReady': True,
                'keyboardReused': True,
                'keyboardSource': 'connected_coredevice',
                'keyboardServiceId': keyboard_service,
                'keyboardProduct': keyboard_row.get('Product'),
                'keyboardReadyMs': round(keyboard_ready_ms, 2),
                'pasteboardAvailable': 'com.apple.coredevice.pasteboardservice' in rsd_services,
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
                        if replace_existing:
                            phase = 'replace_existing_preflight'
                            raise RuntimeError('replace_existing requires a verified modifier-capable keyboard path; no HID mutation was sent')
                        if text_mode == 'keys' and not key_supported:
                            raise ValueError('unsupported HID character in keys mode')
                        if use_pasteboard:
                            phase = 'pasteboard_snapshot'
                            pasteboard_restored = True
                            async with PasteboardService(rsd) as pasteboard:
                                previous = await pasteboard.get()
                                previous_snapshot = previous.get('pasteboard') if isinstance(previous.get('pasteboard'), dict) else previous
                                previous_items = previous_snapshot.get('items') if isinstance(previous_snapshot, dict) else None
                                previous_source = previous_snapshot.get('sourceMetadata') if isinstance(previous_snapshot, dict) else None
                                try:
                                    phase = 'pasteboard_set_text'
                                    await pasteboard.set_text(text)
                                    mapping = ASCII_TO_HID.get('v')
                                    if mapping is None:
                                        raise RuntimeError('HID V key mapping unavailable')
                                    usage, _ = mapping
                                    phase = 'hid_keyboard_paste'
                                    mutation_dispatched = True
                                    await hid.send_keyboard(keyboard_service, [usage, KEY_LEFT_GUI])
                                    await asyncio.sleep(0.040)
                                    await hid.send_keyboard(keyboard_service, [])
                                    await asyncio.sleep(0.080)
                                finally:
                                    phase = 'pasteboard_restore'
                                    if isinstance(previous_items, list):
                                        try:
                                            await pasteboard.set(previous_items, source_metadata=previous_source if isinstance(previous_source, dict) else None)
                                        except Exception:
                                            pasteboard_restored = False
                            result = {'action': 'type', 'length': len(text), 'inputMode': 'pasteboard', 'pasteboardRestored': pasteboard_restored}
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
                                await hid.send_keyboard(keyboard_service, pressed)
                                await asyncio.sleep(0.018)
                                await hid.send_keyboard(keyboard_service, [])
                                await asyncio.sleep(0.018)
                            await hid.send_keyboard(keyboard_service, [])
                            result = {'action': 'type', 'length': len(text), 'inputMode': 'keys'}
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
                    response(
                        str(request.get('id', '')) if isinstance(request, dict) else '',
                        False,
                        error=f'{type(error).__name__}: {error}',
                        details={'phase': phase, 'mutationDispatched': mutation_dispatched},
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

export function parseMacOSTrustedRsdEndpoints(output: string, udid: string): RsdEndpoint[] {
  const endpoints: RsdEndpoint[] = [];
  let host: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes(udid)) continue;
    const tunnel = line.match(/remote\s+([0-9a-fA-F:]+)\s*$/);
    if (tunnel) {
      host = tunnel[1];
      continue;
    }
    const portMatch = line.match(/Creating RSD backend client device for server port\s+(\d+)/);
    if (portMatch && host) {
      const port = Number(portMatch[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) endpoints.push({ host, port });
    }
  }
  const unique = new Map<string, RsdEndpoint>();
  for (const endpoint of endpoints) unique.set(`${endpoint.host}:${endpoint.port}`, endpoint);
  return [...unique.values()].slice(-12).reverse();
}

function trustedTunnelLogArgs(udid: string): string[] {
  if (!/^[A-Za-z0-9-]+$/.test(udid)) {
    throw new AssistantPluginError('IOS_HID_DEVICE_ID_INVALID', 'The physical iPhone UDID cannot be used for trusted-tunnel discovery.', { retryable: false });
  }
  const predicate = `process == "remotepairingd" AND eventMessage CONTAINS "${udid}" AND (eventMessage CONTAINS "Tunnel established" OR eventMessage CONTAINS "Creating RSD backend client device for server port")`;
  return ['show', '--last', '12h', '--style', 'compact', '--predicate', predicate];
}

async function discoverEndpoints(udid: string): Promise<RsdEndpoint[]> {
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

export function stopRemoteXpcHidForDevice(deviceIdentifier: string): Record<string, unknown> {
  const worker = workers.get(deviceIdentifier);
  const cancelledWarmup = warmups.has(deviceIdentifier);
  workerGenerations.set(deviceIdentifier, workerGeneration(deviceIdentifier) + 1);
  warmups.delete(deviceIdentifier);
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
  const endpoints = await discoverEndpoints(input.udid);
  if (workerGeneration(input.deviceIdentifier) !== generation) return;
  let lastError: unknown;
  for (const endpoint of endpoints) {
    if (workerGeneration(input.deviceIdentifier) !== generation) return;
    const worker = startWorker(input, endpoint);
    try {
      await worker.ready;
      if (workerGeneration(input.deviceIdentifier) !== generation) {
        stopWorker(worker);
        return;
      }
      return;
    } catch (error) {
      lastError = error;
      stopWorker(worker);
    }
  }
  throw new AssistantPluginError('IOS_HID_INPUT_FAILED', lastError instanceof Error ? lastError.message : 'RemoteXPC HID input failed on all discovered trusted tunnel endpoints.', {
    retryable: true,
    details: { deviceIdentifier: input.deviceIdentifier, endpointCount: endpoints.length },
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
  let warmup!: Promise<void>;
  warmup = establishWorker(input, generation)
    .catch(() => undefined)
    .then(() => undefined)
    .finally(() => {
      if (warmups.get(input.deviceIdentifier) === warmup) warmups.delete(input.deviceIdentifier);
    });
  warmups.set(input.deviceIdentifier, warmup);
  return { backend: 'remote-xpc-hid', state: 'warming_started', runnerOwned: false };
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
