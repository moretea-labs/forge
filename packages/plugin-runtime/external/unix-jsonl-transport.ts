import { createConnection, type Socket } from 'net';
import { isAbsolute } from 'path';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const MAX_TIMEOUT_MS = 120_000;
export const EXTERNAL_RPC_METHOD_PATTERN = /^[a-z][a-z0-9_]{0,127}$/;

export type ExternalUnixJsonlMethod = string;

export interface ExternalUnixJsonlCallOptions {
  socketPath: string;
  requestId: string;
  method: ExternalUnixJsonlMethod;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export interface NormalizedExternalUnixJsonlCall {
  socketPath: string;
  requestId: string;
  method: string;
  params: Record<string, unknown>;
  timeoutMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  envelope: string;
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

export class ExternalUnixJsonlTransportError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly detailMessage: string;

  constructor(code: string, message: string, options: { retryable?: boolean; details?: Record<string, unknown> } = {}) {
    const boundedMessage = message.slice(0, 1_000);
    super(`${code}: ${boundedMessage}`);
    this.name = 'ExternalUnixJsonlTransportError';
    this.code = code;
    this.retryable = options.retryable ?? true;
    this.details = options.details;
    this.detailMessage = boundedMessage;
  }
}

function transportError(code: string, message: string, options: { retryable?: boolean; details?: Record<string, unknown> } = {}): ExternalUnixJsonlTransportError {
  return new ExternalUnixJsonlTransportError(code, message, options);
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function validateSocketPath(socketPath: string): string {
  const normalized = socketPath.trim();
  if (!normalized || !isAbsolute(normalized)) {
    throw transportError('EXTERNAL_PLUGIN_SOCKET_PATH_INVALID', 'External provider socket path must be absolute.', { retryable: false });
  }
  return normalized;
}

function validateRpcMethod(method: string): string {
  if (!EXTERNAL_RPC_METHOD_PATTERN.test(method)) {
    throw transportError(
      'EXTERNAL_PLUGIN_METHOD_INVALID',
      'External provider RPC method must be 1-128 lowercase ASCII letters, digits, or underscores and start with a letter.',
      { retryable: false },
    );
  }
  return method;
}

function normalizeResult(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

export function normalizeExternalUnixJsonlCall(
  options: ExternalUnixJsonlCallOptions,
  health = false,
): NormalizedExternalUnixJsonlCall {
  const socketPath = validateSocketPath(options.socketPath);
  const method = validateRpcMethod(options.method);
  const params = options.params ?? {};
  const maxRequestBytes = boundedInteger(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, 1_024, 4 * DEFAULT_MAX_REQUEST_BYTES);
  const maxResponseBytes = boundedInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1_024, 4 * DEFAULT_MAX_RESPONSE_BYTES);
  const timeoutMs = boundedInteger(options.timeoutMs, health ? DEFAULT_HEALTH_TIMEOUT_MS : DEFAULT_TIMEOUT_MS, 100, MAX_TIMEOUT_MS);
  const envelope = `${JSON.stringify({ id: options.requestId, method, params })}\n`;
  if (Buffer.byteLength(envelope, 'utf8') > maxRequestBytes) {
    throw transportError('EXTERNAL_PLUGIN_REQUEST_TOO_LARGE', 'External provider request exceeded the bounded input limit.', { retryable: false });
  }
  return { socketPath, requestId: options.requestId, method, params, timeoutMs, maxRequestBytes, maxResponseBytes, envelope };
}

export function decodeExternalUnixJsonlResponse(raw: string, requestId: string): Record<string, unknown> {
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
  if (response.ok === true) return normalizeResult((response as RpcSuccess).result);
  const failure = response as RpcFailure;
  if (!failure.error || typeof failure.error.code !== 'string' || typeof failure.error.message !== 'string') {
    throw transportError('EXTERNAL_PLUGIN_PROTOCOL_ERROR', 'External provider returned an invalid structured error.');
  }
  throw transportError(failure.error.code, failure.error.message, {
    retryable: failure.error.retryable === true,
    details: {
      ...(typeof failure.error.domain === 'string' ? { domain: failure.error.domain } : {}),
      ...(failure.error.details && typeof failure.error.details === 'object' && !Array.isArray(failure.error.details)
        ? { providerDetails: failure.error.details as Record<string, unknown> }
        : {}),
    },
  });
}

export async function callExternalUnixJsonl(
  options: ExternalUnixJsonlCallOptions,
): Promise<Record<string, unknown>> {
  const normalized = normalizeExternalUnixJsonlCall(
    options,
    options.method === 'health' || options.method === 'handshake' || options.method === 'manifest',
  );
  if (options.signal?.aborted) {
    throw transportError('EXTERNAL_PLUGIN_ABORTED', 'External provider request was cancelled before connection.');
  }

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
    const fail = (error: unknown): void => finish(() => reject(error instanceof ExternalUnixJsonlTransportError
      ? error
      : transportError('EXTERNAL_PLUGIN_TRANSPORT_FAILED', error instanceof Error ? error.message : String(error))));
    const succeed = (raw: string): void => finish(() => {
      try {
        resolve(decodeExternalUnixJsonlResponse(raw, normalized.requestId));
      } catch (error) {
        reject(error);
      }
    });
    const onAbort = (): void => fail(transportError('EXTERNAL_PLUGIN_ABORTED', 'External provider request was cancelled.'));

    timer = setTimeout(() => fail(transportError('EXTERNAL_PLUGIN_TIMEOUT', `External provider request timed out after ${normalized.timeoutMs}ms.`)), normalized.timeoutMs);
    timer.unref?.();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      socket = createConnection({ path: normalized.socketPath });
    } catch (error) {
      fail(error);
      return;
    }
    socket.once('connect', () => socket?.write(normalized.envelope));
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      if (buffer.length + chunk.length > normalized.maxResponseBytes) {
        fail(transportError('EXTERNAL_PLUGIN_RESPONSE_TOO_LARGE', 'External provider response exceeded the bounded output limit.', { retryable: false }));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0A);
      if (newline < 0) return;
      succeed(buffer.subarray(0, newline).toString('utf8'));
    });
    socket.once('error', (error) => fail(transportError('EXTERNAL_PLUGIN_SOCKET_UNAVAILABLE', error.message)));
    socket.once('end', () => {
      if (!settled) fail(transportError('EXTERNAL_PLUGIN_PROTOCOL_ERROR', 'External provider closed the socket before returning a complete response.'));
    });
  });
}
