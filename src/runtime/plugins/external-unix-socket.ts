import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { createConnection, type Socket } from 'net';
import { dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { COMPUTER_CAPABILITY_EXECUTION_METHOD } from '../../../packages/protocols/computer/index';
import { resolveBunExecutable } from '../shared/process-environment';
import { AssistantPluginError } from './errors';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const MAX_TIMEOUT_MS = 120_000;
const MAX_DIAGNOSTIC_CHARS = 4_000;

export type ExternalUnixSocketMethod =
  | 'handshake'
  | 'manifest'
  | 'health'
  | 'execute'
  | typeof COMPUTER_CAPABILITY_EXECUTION_METHOD
  | 'macos_browser_automation';

export interface ExternalUnixSocketCallOptions {
  socketPath: string;
  requestId: string;
  method: ExternalUnixSocketMethod;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

interface RpcSuccess {
  id: string;
  ok: true;
  result: unknown;
}

interface RpcFailure {
  id: string;
  ok: false;
  error: {
    code: string;
    message: string;
    retryable?: boolean;
    domain?: string;
    details?: unknown;
  };
}

type RpcResponse = RpcSuccess | RpcFailure;

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function transportError(code: string, message: string, options: { retryable?: boolean; details?: Record<string, unknown> } = {}): AssistantPluginError {
  return new AssistantPluginError(code, message.slice(0, 1_000), { retryable: options.retryable ?? true, details: options.details });
}

function validateSocketPath(socketPath: string): string {
  const normalized = socketPath.trim();
  if (!normalized || !isAbsolute(normalized)) throw transportError('EXTERNAL_PLUGIN_SOCKET_PATH_INVALID', 'External provider socket path must be absolute.', { retryable: false });
  return normalized;
}

function requestEnvelope(options: ExternalUnixSocketCallOptions): string {
  const envelope = JSON.stringify({ id: options.requestId, method: options.method, params: options.params ?? {} });
  const maxRequestBytes = boundedInteger(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, 1_024, 4 * DEFAULT_MAX_REQUEST_BYTES);
  if (Buffer.byteLength(envelope, 'utf8') > maxRequestBytes) {
    throw transportError('EXTERNAL_PLUGIN_REQUEST_TOO_LARGE', 'External provider request exceeded the bounded input limit.', { retryable: false });
  }
  return `${envelope}\n`;
}

function parseRpcResponse(raw: string, requestId: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw transportError('EXTERNAL_PLUGIN_PROTOCOL_ERROR', 'External provider returned invalid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw transportError('EXTERNAL_PLUGIN_PROTOCOL_ERROR', 'External provider returned an invalid response envelope.');
  }
  const response = parsed as Partial<RpcResponse>;
  if (response.id !== requestId || typeof response.ok !== 'boolean') {
    throw transportError('EXTERNAL_PLUGIN_PROTOCOL_ERROR', 'External provider returned a mismatched response id or status.');
  }
  if (response.ok === true) return (response as RpcSuccess).result;
  const failure = response as RpcFailure;
  if (!failure.error || typeof failure.error.code !== 'string' || typeof failure.error.message !== 'string') {
    throw transportError('EXTERNAL_PLUGIN_PROTOCOL_ERROR', 'External provider returned an invalid structured error.');
  }
  throw new AssistantPluginError(failure.error.code, failure.error.message, {
    retryable: failure.error.retryable === true,
    details: {
      ...(typeof failure.error.domain === 'string' ? { domain: failure.error.domain } : {}),
      ...(failure.error.details && typeof failure.error.details === 'object' && !Array.isArray(failure.error.details)
        ? { providerDetails: failure.error.details as Record<string, unknown> }
        : {}),
    },
  });
}

function normalizeResult(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

function timeoutFor(options: ExternalUnixSocketCallOptions, health = false): number {
  return boundedInteger(options.timeoutMs, health ? DEFAULT_HEALTH_TIMEOUT_MS : DEFAULT_TIMEOUT_MS, 100, MAX_TIMEOUT_MS);
}

export async function callExternalUnixSocket(
  options: ExternalUnixSocketCallOptions,
): Promise<Record<string, unknown>> {
  const socketPath = validateSocketPath(options.socketPath);
  const envelope = requestEnvelope(options);
  if (options.signal?.aborted) throw transportError('EXTERNAL_PLUGIN_ABORTED', 'External provider request was cancelled before connection.');
  const timeoutMs = timeoutFor(options, options.method === 'health' || options.method === 'handshake' || options.method === 'manifest');
  const maxResponseBytes = boundedInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1_024, 4 * DEFAULT_MAX_RESPONSE_BYTES);

  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    let socket: Socket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let buffer = Buffer.alloc(0);

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (socket && !socket.destroyed) socket.destroy();
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const fail = (error: unknown): void => finish(() => reject(error instanceof AssistantPluginError
      ? error
      : transportError('EXTERNAL_PLUGIN_TRANSPORT_FAILED', error instanceof Error ? error.message : String(error))));
    const succeed = (value: unknown): void => finish(() => resolve(normalizeResult(value)));
    const onAbort = (): void => fail(transportError('EXTERNAL_PLUGIN_ABORTED', 'External provider request was cancelled.'));

    timer = setTimeout(() => fail(transportError('EXTERNAL_PLUGIN_TIMEOUT', `External provider request timed out after ${timeoutMs}ms.`)), timeoutMs);
    timer.unref?.();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      socket = createConnection({ path: socketPath });
    } catch (error) {
      fail(error);
      return;
    }
    socket.once('connect', () => socket?.write(envelope));
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      if (buffer.length + chunk.length > maxResponseBytes) {
        fail(transportError('EXTERNAL_PLUGIN_RESPONSE_TOO_LARGE', 'External provider response exceeded the bounded output limit.', { retryable: false }));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0A);
      if (newline < 0) return;
      const raw = buffer.subarray(0, newline).toString('utf8');
      try {
        succeed(parseRpcResponse(raw, options.requestId));
      } catch (error) {
        fail(error);
      }
    });
    socket.once('error', (error) => fail(transportError('EXTERNAL_PLUGIN_SOCKET_UNAVAILABLE', error.message)));
    socket.once('end', () => {
      if (!settled) fail(transportError('EXTERNAL_PLUGIN_PROTOCOL_ERROR', 'External provider closed the socket before returning a complete response.'));
    });
  });
}

export function resolveExternalPluginProbeSidecarPath(
  execPath: string = process.execPath,
  moduleUrl: string = import.meta.url,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configuredReleaseRoot = env.FORGE_RELEASE_PATH?.trim();
  if (configuredReleaseRoot) {
    const releaseSidecar = join(resolve(configuredReleaseRoot), 'external-unix-socket-probe.cjs');
    if (existsSync(releaseSidecar)) return releaseSidecar;
  }
  const releaseSibling = join(dirname(execPath), 'external-unix-socket-probe.cjs');
  if (existsSync(releaseSibling)) return releaseSibling;
  const moduleSibling = fileURLToPath(new URL('./external-unix-socket-probe.cjs', moduleUrl));
  if (existsSync(moduleSibling)) return moduleSibling;
  throw transportError('EXTERNAL_PLUGIN_PROBE_SIDECAR_MISSING', 'External provider probe sidecar is unavailable.', { retryable: false });
}

export function resolveExternalPluginProbeRuntime(
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
  accountHome?: string,
): string {
  return resolveBunExecutable(execPath, env, accountHome);
}

export function probeExternalUnixSocketSync(
  options: ExternalUnixSocketCallOptions,
): Record<string, unknown> {
  validateSocketPath(options.socketPath);
  const sidecarPath = resolveExternalPluginProbeSidecarPath();
  const probeRuntime = resolveExternalPluginProbeRuntime();
  const timeoutMs = timeoutFor(options, true);
  const input = JSON.stringify({
    socketPath: options.socketPath,
    requestId: options.requestId,
    method: options.method,
    params: options.params ?? {},
    timeoutMs,
    maxRequestBytes: boundedInteger(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, 1_024, 4 * DEFAULT_MAX_REQUEST_BYTES),
    maxResponseBytes: boundedInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1_024, 4 * DEFAULT_MAX_RESPONSE_BYTES),
  });
  const execution = spawnSync(probeRuntime, [sidecarPath], {
    input,
    encoding: 'utf8',
    timeout: timeoutMs + 1_000,
    maxBuffer: boundedInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1_024, 4 * DEFAULT_MAX_RESPONSE_BYTES) + 16_384,
    env: Object.fromEntries(Object.entries({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      FORGE_EXTERNAL_PLUGIN_PROBE: '1',
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    shell: false,
    windowsHide: true,
  });
  if (execution.error) throw transportError('EXTERNAL_PLUGIN_PROBE_FAILED', execution.error.message);
  if (execution.status !== 0) {
    const diagnostic = String(execution.stderr || execution.stdout || '').slice(-MAX_DIAGNOSTIC_CHARS);
    throw transportError('EXTERNAL_PLUGIN_PROBE_FAILED', diagnostic || `Probe sidecar exited with status ${String(execution.status)}.`);
  }
  const raw = String(execution.stdout ?? '').trim();
  return normalizeResult(parseRpcResponse(raw, options.requestId));
}
