import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  callExternalUnixJsonl,
  decodeExternalUnixJsonlResponse,
  ExternalUnixJsonlTransportError,
  normalizeExternalUnixJsonlCall,
  type ExternalUnixJsonlCallOptions,
  type ExternalUnixJsonlMethod,
} from '../../../packages/plugin-runtime/external/index';
import { resolveBunExecutable } from '../shared/process-environment';
import { AssistantPluginError } from './errors';

const MAX_DIAGNOSTIC_CHARS = 4_000;

export type ExternalUnixSocketMethod = ExternalUnixJsonlMethod;
export interface ExternalUnixSocketCallOptions extends ExternalUnixJsonlCallOptions {}

function transportError(code: string, message: string, options: { retryable?: boolean; details?: Record<string, unknown> } = {}): AssistantPluginError {
  return new AssistantPluginError(code, message.slice(0, 1_000), { retryable: options.retryable ?? true, details: options.details });
}

function toAssistantPluginError(error: unknown): AssistantPluginError {
  if (error instanceof AssistantPluginError) return error;
  if (error instanceof ExternalUnixJsonlTransportError) {
    return new AssistantPluginError(error.code, error.detailMessage, {
      retryable: error.retryable,
      details: error.details,
    });
  }
  return transportError('EXTERNAL_PLUGIN_TRANSPORT_FAILED', error instanceof Error ? error.message : String(error));
}

export async function callExternalUnixSocket(
  options: ExternalUnixSocketCallOptions,
): Promise<Record<string, unknown>> {
  try {
    return await callExternalUnixJsonl(options);
  } catch (error) {
    throw toAssistantPluginError(error);
  }
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
  try {
    const normalized = normalizeExternalUnixJsonlCall(options, true);
    const sidecarPath = resolveExternalPluginProbeSidecarPath();
    const probeRuntime = resolveExternalPluginProbeRuntime();
    const input = JSON.stringify({
      socketPath: normalized.socketPath,
      requestId: normalized.requestId,
      method: normalized.method,
      params: normalized.params,
      timeoutMs: normalized.timeoutMs,
      maxRequestBytes: normalized.maxRequestBytes,
      maxResponseBytes: normalized.maxResponseBytes,
    });
    const execution = spawnSync(probeRuntime, [sidecarPath], {
      input,
      encoding: 'utf8',
      timeout: normalized.timeoutMs + 1_000,
      maxBuffer: normalized.maxResponseBytes + 16_384,
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
    return decodeExternalUnixJsonlResponse(String(execution.stdout ?? '').trim(), normalized.requestId);
  } catch (error) {
    throw toAssistantPluginError(error);
  }
}
