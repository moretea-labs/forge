import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { AssistantPluginError } from '../errors';

const TOOLCHAIN_VERSION = '10.2.1';
const WORKER_IDLE_MS = 15 * 60_000;
const WORKER_STARTUP_MS = 12_000;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_TEXT_LENGTH = 2048;
const MAX_STDERR = 8 * 1024;

export interface RemoteXpcHidInput {
  controllerHome: string;
  deviceIdentifier: string;
  udid: string;
  width: number;
  height: number;
  action: 'tap' | 'swipe' | 'type';
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

interface WorkerRecord {
  key: string;
  endpoint: RsdEndpoint;
  process: ChildProcessWithoutNullStreams;
  pending: Map<string, PendingRequest>;
  ready: Promise<Record<string, unknown>>;
  lastUsedAt: number;
  stderrTail: string;
  idleTimer?: NodeJS.Timeout;
}

type TestExecutor = (input: RemoteXpcHidInput) => Promise<RemoteXpcHidResult>;
let testExecutor: TestExecutor | undefined;
const workers = new Map<string, WorkerRecord>();

export function setRemoteXpcHidExecutorForTest(executor: TestExecutor | undefined): void {
  testExecutor = executor;
}

export function resetRemoteXpcHidForTest(): void {
  testExecutor = undefined;
  for (const worker of workers.values()) stopWorker(worker);
  workers.clear();
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

from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
from pymobiledevice3.remote.core_device.hid_service import (
    ASCII_TO_HID,
    DIGITIZER_SURFACE_MAIN_TOUCHSCREEN,
    KEYBOARD_SURFACE_DEFAULT_SERVICE_ID,
    KEY_LEFT_SHIFT,
    TOUCHSCREEN_STATE_CONTACT,
    TOUCHSCREEN_STATE_RELEASE,
    touch_session,
)


def normalized_point(x, y, width, height):
    if width <= 1 or height <= 1:
        raise ValueError('display dimensions must be > 1')
    nx = max(0, min(65535, int(x * 65535 / (width - 1))))
    ny = max(0, min(65535, int(y * 65535 / (height - 1))))
    return nx, ny


def response(request_id, ok, result=None, error=None):
    payload = {'id': request_id, 'ok': ok}
    if result is not None:
        payload['result'] = result
    if error is not None:
        payload['error'] = error
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
            print(json.dumps({
                'ready': True,
                'serviceIds': service_ids,
                'pasteboardAvailable': 'com.apple.coredevice.pasteboardservice' in rsd_services,
            }), flush=True)
            keyboard_service = None
            while True:
                line = await asyncio.to_thread(sys.stdin.readline)
                if not line:
                    return
                request = None
                try:
                    request = json.loads(line)
                    request_id = str(request.get('id', ''))
                    action = request.get('action')
                    if action == 'tap':
                        nx, ny = normalized_point(int(request['x']), int(request['y']), int(request['width']), int(request['height']))
                        await hid.send_touchscreen(TOUCHSCREEN_STATE_CONTACT, nx, ny, DIGITIZER_SURFACE_MAIN_TOUCHSCREEN)
                        await asyncio.sleep(0.055)
                        await hid.send_touchscreen(TOUCHSCREEN_STATE_RELEASE, nx, ny, DIGITIZER_SURFACE_MAIN_TOUCHSCREEN)
                        response(request_id, True, {'action': 'tap', 'hid': [nx, ny]})
                    elif action == 'swipe':
                        x, y = int(request['x']), int(request['y'])
                        x2, y2 = int(request['x2']), int(request['y2'])
                        width, height = int(request['width']), int(request['height'])
                        duration_ms = max(80, min(int(request.get('durationMs', 250)), 3000))
                        duration = duration_ms / 1000.0
                        steps = max(4, min(60, round(duration * 60)))
                        for index in range(steps + 1):
                            ratio = index / steps
                            px = round(x + (x2 - x) * ratio)
                            py = round(y + (y2 - y) * ratio)
                            nx, ny = normalized_point(px, py, width, height)
                            await hid.send_touchscreen(TOUCHSCREEN_STATE_CONTACT, nx, ny, DIGITIZER_SURFACE_MAIN_TOUCHSCREEN)
                            await asyncio.sleep(duration / steps)
                        nx2, ny2 = normalized_point(x2, y2, width, height)
                        await hid.send_touchscreen(TOUCHSCREEN_STATE_RELEASE, nx2, ny2, DIGITIZER_SURFACE_MAIN_TOUCHSCREEN)
                        response(request_id, True, {'action': 'swipe', 'durationMs': duration_ms})
                    elif action == 'type':
                        text = str(request.get('text', ''))
                        if keyboard_service is None:
                            keyboard_service = await hid.create_keyboard_service(
                                KEYBOARD_SURFACE_DEFAULT_SERVICE_ID,
                                product='Forge RemoteXPC Keyboard',
                                manufacturer='Forge',
                            )
                        for char in text:
                            mapping = ASCII_TO_HID.get(char)
                            if mapping is None:
                                raise ValueError('unsupported HID character; Unicode text requires a pasteboard/input-method backend')
                            usage, shifted = mapping
                            pressed = [usage]
                            if shifted:
                                pressed.append(KEY_LEFT_SHIFT)
                            await hid.send_keyboard(keyboard_service, pressed)
                            await asyncio.sleep(0.018)
                            await hid.send_keyboard(keyboard_service, [])
                            await asyncio.sleep(0.018)
                        await hid.send_keyboard(keyboard_service, [])
                        response(request_id, True, {'action': 'type', 'length': len(text)})
                    else:
                        raise ValueError('unsupported action')
                except Exception as error:
                    response(str(request.get('id', '')) if isinstance(request, dict) else '', False, error=f'{type(error).__name__}: {error}')


if __name__ == '__main__':
    asyncio.run(main())
`;
}

function materializeWorker(controllerHome: string): string {
  const source = workerSource();
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const root = join(controllerHome, 'runtime', 'device-input');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, `remote-xpc-hid-${hash}.py`);
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

function discoverEndpoints(udid: string): RsdEndpoint[] {
  if (!/^[A-Za-z0-9-]+$/.test(udid)) {
    throw new AssistantPluginError('IOS_HID_DEVICE_ID_INVALID', 'The physical iPhone UDID cannot be used for trusted-tunnel discovery.', { retryable: false });
  }
  const predicate = `process == "remotepairingd" AND eventMessage CONTAINS "${udid}" AND (eventMessage CONTAINS "Tunnel established" OR eventMessage CONTAINS "Creating RSD backend client device for server port")`;
  const result = spawnSync('/usr/bin/log', ['show', '--last', '12h', '--style', 'compact', '--predicate', predicate], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new AssistantPluginError('IOS_HID_RSD_DISCOVERY_FAILED', String(result.stderr || result.stdout || 'macOS trusted-tunnel discovery failed.'), { retryable: true });
  }
  const endpoints = parseMacOSTrustedRsdEndpoints(String(result.stdout ?? ''), udid);
  if (endpoints.length === 0) {
    throw new AssistantPluginError('IOS_HID_RSD_UNAVAILABLE', 'No current macOS trusted CoreDevice RSD endpoint was found for the selected iPhone.', {
      retryable: true,
      details: { udid },
    });
  }
  return endpoints;
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

function startWorker(input: RemoteXpcHidInput, endpoint: RsdEndpoint): WorkerRecord {
  const python = resolvePython(input.controllerHome, process.env);
  if (!python) {
    throw new AssistantPluginError('IOS_HID_TOOLCHAIN_MISSING', `The Controller-owned pymobiledevice3 ${TOOLCHAIN_VERSION} toolchain is unavailable.`, {
      retryable: false,
      details: { expected: join(input.controllerHome, 'toolchains', `pymobiledevice3-${TOOLCHAIN_VERSION}-py39`, 'bin', 'python') },
    });
  }
  const script = materializeWorker(input.controllerHome);
  const workerPath = dirname(python);
  const child = spawn(python, ['-u', script, '--host', endpoint.host, '--port', String(endpoint.port)], {
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
    key, endpoint, process: child, pending, ready, lastUsedAt: Date.now(), stderrTail: '',
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
      request.reject(new Error(typeof payload.error === 'string' ? payload.error : 'RemoteXPC HID request failed.'));
    }
  });
  child.stderr.on('data', (chunk) => {
    worker.stderrTail = `${worker.stderrTail}${String(chunk)}`.slice(-MAX_STDERR);
  });
  child.on('exit', (code, signal) => {
    clearTimeout(startupTimer);
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
    readyReject(error);
  });
  return worker;
}

async function workerRequest(worker: WorkerRecord, input: RemoteXpcHidInput): Promise<Record<string, unknown>> {
  await worker.ready;
  const id = randomUUID();
  const payload: Record<string, unknown> = {
    id,
    action: input.action,
    width: input.width,
    height: input.height,
  };
  if (input.x !== undefined) payload.x = input.x;
  if (input.y !== undefined) payload.y = input.y;
  if (input.x2 !== undefined) payload.x2 = input.x2;
  if (input.y2 !== undefined) payload.y2 = input.y2;
  if (input.durationMs !== undefined) payload.durationMs = input.durationMs;
  if (input.text !== undefined) payload.text = input.text;
  worker.lastUsedAt = Date.now();
  scheduleIdleStop(worker);
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
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
}

function validateInput(input: RemoteXpcHidInput): void {
  if (!input.udid) throw new AssistantPluginError('IOS_HID_UDID_MISSING', 'RemoteXPC HID requires the physical iPhone hardware UDID.', { retryable: false });
  if (!Number.isFinite(input.width) || !Number.isFinite(input.height) || input.width <= 1 || input.height <= 1) {
    throw new AssistantPluginError('IOS_HID_DISPLAY_INVALID', 'RemoteXPC HID requires current positive display pixel dimensions.', { retryable: true });
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
    if (x < 0 || y < 0 || x > input.width - 1 || y > input.height - 1) {
      throw new AssistantPluginError('IOS_HID_COORDINATE_OUT_OF_BOUNDS', `${label} coordinates are outside the current CoreDevice display.`, {
        retryable: false,
        details: { x, y, width: input.width, height: input.height },
      });
    }
  }
  if (input.action === 'type') {
    const text = input.text ?? '';
    if (text.length > MAX_TEXT_LENGTH) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `RemoteXPC HID text is limited to ${MAX_TEXT_LENGTH} characters.`, { retryable: false });
    if ([...text].some((character) => character.charCodeAt(0) > 0x7f)) {
      throw new AssistantPluginError('IOS_HID_UNICODE_TEXT_UNSUPPORTED', 'The current HID keyboard backend accepts ASCII only; Unicode text needs a separate pasteboard/input-method backend.', { retryable: false });
    }
  }
}

async function executeDefault(input: RemoteXpcHidInput): Promise<RemoteXpcHidResult> {
  const existing = workers.get(input.deviceIdentifier);
  if (existing) {
    try {
      const result = await workerRequest(existing, input);
      return { backend: 'remote-xpc-hid', reusedWorker: true, endpoint: existing.endpoint, result };
    } catch {
      stopWorker(existing);
    }
  }

  const endpoints = discoverEndpoints(input.udid);
  let lastError: unknown;
  for (const endpoint of endpoints) {
    const worker = startWorker(input, endpoint);
    try {
      const result = await workerRequest(worker, input);
      return { backend: 'remote-xpc-hid', reusedWorker: false, endpoint, result };
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

export async function executeRemoteXpcHidInput(input: RemoteXpcHidInput): Promise<RemoteXpcHidResult> {
  validateInput(input);
  return testExecutor ? await testExecutor(input) : await executeDefault(input);
}
