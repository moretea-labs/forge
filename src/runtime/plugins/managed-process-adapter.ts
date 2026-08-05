import { spawn } from 'child_process';
import { existsSync, statSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { AssistantPluginError } from './errors';

export const MANAGED_PLUGIN_PROTOCOL_VERSION = 1;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_STDERR_CHARS = 8_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

interface ManagedPluginHandshake {
  schemaVersion: 1;
  type: 'handshake';
  protocolVersion: 1;
  pluginId: string;
  helperVersion: string;
  capabilities: string[];
}

interface ManagedPluginSuccess {
  schemaVersion: 1;
  type: 'result';
  requestId: string;
  ok: true;
  result: Record<string, unknown>;
}

interface ManagedPluginFailure {
  schemaVersion: 1;
  type: 'result';
  requestId: string;
  ok: false;
  error: {
    code: string;
    message: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
}

type ManagedPluginResult = ManagedPluginSuccess | ManagedPluginFailure;

export interface ManagedPluginProcessSpec {
  pluginId: string;
  helperPath: string;
  runtimeExecutable?: string;
  runtimeArgs?: string[];
  cwd?: string;
  requiredCapabilities?: string[];
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxStderrChars?: number;
}

export interface ManagedPluginProcessRequest {
  requestId: string;
  actionId: string;
  input: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function managedError(code: string, message: string, options: { retryable?: boolean; details?: Record<string, unknown> } = {}): AssistantPluginError {
  return new AssistantPluginError(code, message, {
    retryable: options.retryable ?? true,
    details: options.details,
  });
}

function boundedTimeout(spec: ManagedPluginProcessSpec, request: ManagedPluginProcessRequest): number {
  const requested = request.timeoutMs ?? spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(requested)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(requested), 50), MAX_TIMEOUT_MS);
}

function minimalEnvironment(runtimeExecutable: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    REPO_HARNESS_MANAGED_PLUGIN: '1',
    REPO_HARNESS_MANAGED_PLUGIN_RUNTIME_DIR: dirname(runtimeExecutable),
  };
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function parseProtocolLine(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw managedError('PLUGIN_MANAGED_PROCESS_PROTOCOL_ERROR', 'Managed plugin helper returned invalid JSON.', { retryable: true });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw managedError('PLUGIN_MANAGED_PROCESS_PROTOCOL_ERROR', 'Managed plugin helper returned an invalid protocol object.', { retryable: true });
  }
  return parsed as Record<string, unknown>;
}

function validateHandshake(value: Record<string, unknown>, spec: ManagedPluginProcessSpec): ManagedPluginHandshake {
  if (value.schemaVersion !== MANAGED_PLUGIN_PROTOCOL_VERSION
    || value.type !== 'handshake'
    || value.protocolVersion !== MANAGED_PLUGIN_PROTOCOL_VERSION
    || value.pluginId !== spec.pluginId
    || typeof value.helperVersion !== 'string'
    || !Array.isArray(value.capabilities)
    || !value.capabilities.every((entry) => typeof entry === 'string')) {
    throw managedError('PLUGIN_MANAGED_PROCESS_HANDSHAKE_INVALID', 'Managed plugin helper returned an incompatible handshake.', { retryable: false });
  }
  const handshake = value as unknown as ManagedPluginHandshake;
  const missing = (spec.requiredCapabilities ?? []).filter((capability) => !handshake.capabilities.includes(capability));
  if (missing.length > 0) {
    throw managedError('PLUGIN_MANAGED_PROCESS_CAPABILITY_MISMATCH', `Managed plugin helper is missing required capabilities: ${missing.join(', ')}.`, {
      retryable: false,
      details: { missingCapabilities: missing },
    });
  }
  return handshake;
}

function validateResult(value: Record<string, unknown>, requestId: string): ManagedPluginResult {
  if (value.schemaVersion !== MANAGED_PLUGIN_PROTOCOL_VERSION || value.type !== 'result' || value.requestId !== requestId || typeof value.ok !== 'boolean') {
    throw managedError('PLUGIN_MANAGED_PROCESS_PROTOCOL_ERROR', 'Managed plugin helper returned a mismatched result envelope.', { retryable: true });
  }
  if (value.ok === true) {
    if (!value.result || typeof value.result !== 'object' || Array.isArray(value.result)) {
      throw managedError('PLUGIN_MANAGED_PROCESS_PROTOCOL_ERROR', 'Managed plugin helper returned an invalid result payload.', { retryable: true });
    }
    return value as unknown as ManagedPluginSuccess;
  }
  if (!value.error || typeof value.error !== 'object' || Array.isArray(value.error)) {
    throw managedError('PLUGIN_MANAGED_PROCESS_PROTOCOL_ERROR', 'Managed plugin helper returned an invalid error payload.', { retryable: true });
  }
  const error = value.error as Record<string, unknown>;
  if (typeof error.code !== 'string' || typeof error.message !== 'string') {
    throw managedError('PLUGIN_MANAGED_PROCESS_PROTOCOL_ERROR', 'Managed plugin helper returned an invalid structured error.', { retryable: true });
  }
  return value as unknown as ManagedPluginFailure;
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(token|secret|password|authorization)\s*[=:]\s*\S+/gi, '$1=[REDACTED]');
}

export async function executeManagedPluginProcess(
  spec: ManagedPluginProcessSpec,
  request: ManagedPluginProcessRequest,
): Promise<Record<string, unknown>> {
  const runtimeExecutable = isAbsolute(spec.runtimeExecutable ?? process.execPath)
    ? (spec.runtimeExecutable ?? process.execPath)
    : resolve(spec.runtimeExecutable ?? process.execPath);
  const helperPath = isAbsolute(spec.helperPath) ? spec.helperPath : resolve(spec.helperPath);
  if (!existsSync(runtimeExecutable) || !statSync(runtimeExecutable).isFile()) {
    throw managedError('PLUGIN_MANAGED_PROCESS_RUNTIME_UNAVAILABLE', 'Managed plugin runtime executable is unavailable.', { retryable: false });
  }
  if (!existsSync(helperPath) || !statSync(helperPath).isFile()) {
    throw managedError('PLUGIN_MANAGED_PROCESS_HELPER_UNAVAILABLE', 'Managed plugin helper is unavailable.', { retryable: false });
  }
  if (request.signal?.aborted) {
    throw managedError('PLUGIN_MANAGED_PROCESS_ABORTED', 'Managed plugin action was cancelled before launch.', { retryable: true });
  }

  const requestEnvelope = JSON.stringify({
    schemaVersion: MANAGED_PLUGIN_PROTOCOL_VERSION,
    type: 'execute',
    requestId: request.requestId,
    actionId: request.actionId,
    input: request.input,
  });
  const maxRequestBytes = spec.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  if (Buffer.byteLength(requestEnvelope, 'utf8') > maxRequestBytes) {
    throw managedError('PLUGIN_MANAGED_PROCESS_REQUEST_TOO_LARGE', 'Managed plugin request exceeded the bounded input limit.', { retryable: false });
  }

  return await new Promise<Record<string, unknown>>((resolveResult, reject) => {
    const child = spawn(runtimeExecutable, [...(spec.runtimeArgs ?? []), helperPath], {
      cwd: spec.cwd ?? dirname(helperPath),
      env: minimalEnvironment(runtimeExecutable),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let stdoutBuffer = '';
    let stdoutBytes = 0;
    let stderr = '';
    let handshakeReceived = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const maxResponseBytes = spec.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const maxStderrChars = spec.maxStderrChars ?? DEFAULT_MAX_STDERR_CHARS;

    const terminate = (): void => {
      if (child.exitCode !== null || child.killed) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 1_000);
      killTimer.unref?.();
    };
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const fail = (error: AssistantPluginError): void => {
      terminate();
      finish(() => reject(error));
    };
    const succeed = (result: Record<string, unknown>): void => {
      terminate();
      finish(() => resolveResult(result));
    };
    const onAbort = (): void => fail(managedError('PLUGIN_MANAGED_PROCESS_ABORTED', 'Managed plugin action was cancelled.', { retryable: true }));

    const handleLine = (line: string): void => {
      if (!line.trim() || settled) return;
      try {
        const parsed = parseProtocolLine(line);
        if (!handshakeReceived) {
          validateHandshake(parsed, spec);
          handshakeReceived = true;
          child.stdin.end(`${requestEnvelope}\n`);
          return;
        }
        const response = validateResult(parsed, request.requestId);
        if (!response.ok) {
          fail(new AssistantPluginError(response.error.code, response.error.message, {
            retryable: response.error.retryable,
            details: response.error.details,
          }));
          return;
        }
        succeed(response.result);
      } catch (error) {
        fail(error instanceof AssistantPluginError
          ? error
          : managedError('PLUGIN_MANAGED_PROCESS_PROTOCOL_ERROR', 'Managed plugin protocol processing failed.', { retryable: true }));
      }
    };

    timer = setTimeout(() => {
      fail(managedError('PLUGIN_MANAGED_PROCESS_TIMEOUT', 'Managed plugin helper timed out.', { retryable: true }));
    }, boundedTimeout(spec, request));
    request.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      stdoutBytes += Buffer.byteLength(chunk, 'utf8');
      if (stdoutBytes > maxResponseBytes) {
        fail(managedError('PLUGIN_MANAGED_PROCESS_RESPONSE_TOO_LARGE', 'Managed plugin helper exceeded the bounded output limit.', { retryable: true }));
        return;
      }
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleLine(line);
        newline = stdoutBuffer.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-maxStderrChars);
    });
    child.on('error', (error) => {
      fail(managedError('PLUGIN_MANAGED_PROCESS_START_FAILED', error.message, { retryable: true }));
    });
    child.on('close', (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      fail(managedError('PLUGIN_MANAGED_PROCESS_EXITED', 'Managed plugin helper exited before returning a complete result.', {
        retryable: true,
        details: {
          exitCode: code,
          signal,
          handshakeReceived,
          ...(stderr ? { diagnostic: redactDiagnostic(stderr).slice(-2_000) } : {}),
        },
      }));
    });
    child.stdin.on('error', (error) => {
      if (!settled) fail(managedError('PLUGIN_MANAGED_PROCESS_STDIN_FAILED', error.message, { retryable: true }));
    });
  });
}
