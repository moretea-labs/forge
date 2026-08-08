import { spawn } from 'child_process';
import { accessSync, constants, existsSync } from 'fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { AssistantPluginActionExecutionInput } from './types';
import { AssistantPluginError } from './errors';

const BRIDGE_SCHEMA_VERSION = 1;
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_STDERR_CHARS = 8_000;
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 180_000;
const HOST_FLAG = 'FORGE_BROWSER_NODE_BRIDGE_HOST';

const LOCAL_ACTIONS = new Set([
  'configure',
  'list_sessions',
  'close_session',
  'close_page',
  'clear_session',
  'request_human_handoff',
  'get_handoff_status',
  'resolve_handoff',
]);

interface BridgeSuccess {
  schemaVersion: 1;
  ok: true;
  result: Record<string, unknown>;
}

interface BridgeFailure {
  schemaVersion: 1;
  ok: false;
  error: {
    code: string;
    message: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
}

type BridgeResponse = BridgeSuccess | BridgeFailure;

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return existsSync(path);
  } catch {
    return false;
  }
}

function pathCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates = [
    env.FORGE_NODE_EXECUTABLE,
    env.VOLTA_HOME ? join(env.VOLTA_HOME, 'bin', 'node') : undefined,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ];
  for (const entry of (env.PATH ?? '').split(delimiter)) {
    if (entry.trim()) candidates.push(join(entry, process.platform === 'win32' ? 'node.exe' : 'node'));
  }
  return candidates.filter((value): value is string => Boolean(value));
}

export function resolveBrowserBridgeNodeExecutable(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FORGE_NODE_EXECUTABLE) {
    const configured = isAbsolute(env.FORGE_NODE_EXECUTABLE)
      ? env.FORGE_NODE_EXECUTABLE
      : resolve(env.FORGE_NODE_EXECUTABLE);
    if (isExecutable(configured)) return configured;
    throw new AssistantPluginError('PLUGIN_BROWSER_NODE_UNAVAILABLE', 'The configured Browser bridge Node executable is not executable.', {
      retryable: false,
    });
  }
  for (const candidate of pathCandidates(env)) {
    const absolute = isAbsolute(candidate) ? candidate : resolve(candidate);
    if (isExecutable(absolute)) return absolute;
  }
  throw new AssistantPluginError('PLUGIN_BROWSER_NODE_UNAVAILABLE', 'Browser attach operations require a trusted Node executable, but none was found.', {
    retryable: false,
  });
}

export function resolveBrowserNodeBridgeHostPath(options: {
  runtimeExecutable?: string;
  argvEntry?: string;
  sourceHostPath?: string;
  pathExists?: (path: string) => boolean;
} = {}): string {
  const runtimeExecutable = options.runtimeExecutable ?? process.execPath;
  const argvEntry = options.argvEntry ?? process.argv[1];
  const sourceHostPath = options.sourceHostPath
    ?? fileURLToPath(new URL('./browser-node-bridge-host.ts', import.meta.url));
  const pathExists = options.pathExists ?? existsSync;
  const releaseCandidates = [
    runtimeExecutable ? join(dirname(runtimeExecutable), 'browser-node-bridge-host.js') : undefined,
    argvEntry ? join(dirname(argvEntry), 'browser-node-bridge-host.js') : undefined,
  ].filter((value): value is string => Boolean(value));
  for (const candidate of releaseCandidates) {
    if (pathExists(candidate)) return candidate;
  }
  if (sourceHostPath.replace(/\\/g, '/').includes('/$bunfs/')) {
    throw new AssistantPluginError(
      'PLUGIN_BROWSER_NODE_HOST_UNAVAILABLE',
      'The immutable Browser Node bridge host is missing from the active runtime release.',
      { retryable: false },
    );
  }
  if (pathExists(sourceHostPath)) return sourceHostPath;
  throw new AssistantPluginError(
    'PLUGIN_BROWSER_NODE_HOST_UNAVAILABLE',
    'Browser Node bridge host could not be resolved.',
    { retryable: false },
  );
}

export function shouldUseBrowserNodeBridge(
  actionId: string,
  browserMode: string | undefined,
  runtimeHooksCustomized: boolean,
  hasConfiguredCdpEndpoint = false,
): boolean {
  const bunHosted = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
  return bunHosted
    && process.env[HOST_FLAG] !== '1'
    && !runtimeHooksCustomized
    && browserMode === 'attach_preferred'
    && hasConfiguredCdpEndpoint
    && !LOCAL_ACTIONS.has(actionId);
}

function bridgeTimeout(input: AssistantPluginActionExecutionInput): number {
  const requested = typeof input.args.timeout_ms === 'number' && Number.isFinite(input.args.timeout_ms)
    ? Math.trunc(input.args.timeout_ms)
    : 60_000;
  return Math.min(Math.max(requested + 15_000, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function minimalEnvironment(nodeExecutable: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: dirname(nodeExecutable),
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    NODE_PATH: process.env.NODE_PATH,
    [HOST_FLAG]: '1',
  };
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function parseResponse(raw: string): BridgeResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AssistantPluginError('PLUGIN_BROWSER_NODE_PROTOCOL_ERROR', 'Browser Node bridge returned invalid JSON.', { retryable: true });
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { schemaVersion?: unknown }).schemaVersion !== BRIDGE_SCHEMA_VERSION) {
    throw new AssistantPluginError('PLUGIN_BROWSER_NODE_PROTOCOL_ERROR', 'Browser Node bridge returned an unsupported response.', { retryable: true });
  }
  return parsed as BridgeResponse;
}

export async function executeBrowserActionThroughNode(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  const nodeExecutable = resolveBrowserBridgeNodeExecutable();
  const hostPath = resolveBrowserNodeBridgeHostPath();
  const sourceLoaderPath = fileURLToPath(new URL('../shared/node-ts-loader.mjs', import.meta.url));
  const childArgs = hostPath.endsWith('.js')
    ? [hostPath]
    : ['--loader', sourceLoaderPath, hostPath];
  const request = JSON.stringify({ schemaVersion: BRIDGE_SCHEMA_VERSION, input });
  if (Buffer.byteLength(request) > MAX_REQUEST_BYTES) {
    throw new AssistantPluginError('PLUGIN_BROWSER_NODE_REQUEST_TOO_LARGE', 'Browser Node bridge request exceeded the bounded input limit.', { retryable: false });
  }

  return await new Promise<Record<string, unknown>>((resolveResult, reject) => {
    const child = spawn(nodeExecutable, childArgs, {
      cwd: dirname(hostPath),
      env: minimalEnvironment(nodeExecutable),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const fail = (error: AssistantPluginError): void => finish(() => reject(error));
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      fail(new AssistantPluginError('PLUGIN_BROWSER_NODE_TIMEOUT', 'Browser Node bridge timed out.', { retryable: true }));
    }, bridgeTimeout(input));

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_RESPONSE_BYTES) {
        child.kill('SIGTERM');
        fail(new AssistantPluginError('PLUGIN_BROWSER_NODE_RESPONSE_TOO_LARGE', 'Browser Node bridge exceeded the bounded output limit.', { retryable: true }));
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_CHARS);
    });
    child.on('error', (error) => {
      fail(new AssistantPluginError('PLUGIN_BROWSER_NODE_START_FAILED', error.message, { retryable: true }));
    });
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0 && !stdout.trim()) {
        fail(new AssistantPluginError('PLUGIN_BROWSER_NODE_EXITED', 'Browser Node bridge exited before returning a result.', {
          retryable: true,
          details: stderr ? { diagnostic: stderr.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').slice(-2_000) } : undefined,
        }));
        return;
      }
      try {
        const response = parseResponse(stdout.trim());
        if (!response.ok) {
          fail(new AssistantPluginError(response.error.code, response.error.message, {
            retryable: response.error.retryable,
            details: response.error.details,
          }));
          return;
        }
        finish(() => resolveResult(response.result));
      } catch (error) {
        fail(error instanceof AssistantPluginError
          ? error
          : new AssistantPluginError('PLUGIN_BROWSER_NODE_PROTOCOL_ERROR', 'Browser Node bridge response could not be parsed.', { retryable: true }));
      }
    });

    child.stdin.end(request);
  });
}
