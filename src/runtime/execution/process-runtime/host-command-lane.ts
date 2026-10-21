/**
 * Canonical host-local command lane.
 *
 * The target is the serving ForgeInstance; `cwd` is an execution argument and no
 * repository registration, checkout identity, or Work is required. Raw process
 * execution is deliberately a broad host capability: Forge does not attempt to
 * prove per-path safety by parsing command text. Narrow path/repository
 * guarantees belong to typed filesystem/source/git capabilities.
 *
 * Authorization is one explicit canonical Grant for `process:exec` whose typed
 * target is the exact ForgeInstance. Anything else fails closed.
 */

import { existsSync, realpathSync, statSync } from 'fs';
import { isAbsolute } from 'path';
import { readForgeInstanceIdentity } from '../../../../packages/kernel/identity/api/index';
import {
  startLightweightHostCommand,
  type StartLightweightHostCommandInput,
} from './lightweight-managed';
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_PROCESS_TIMEOUT_MS, type ProcessHandle } from './types';

/** Broad host process-execution capability. `process:*` also satisfies it. */
const HOST_INTERACTIVE_WAIT_DEFAULT_MS = 8_000;
const HOST_INTERACTIVE_WAIT_MAX_MS = 120_000;
const HOST_TIMEOUT_MAX_MS = 24 * 60 * 60_000;

export interface HostCommandRequest {
  controllerHome: string;
  principalId: string;
  /** Typed argv command; `command[0]` is the executable. */
  command?: readonly string[];
  /** Explicit broad shell form; never parsed for path safety. */
  shellCommand?: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  interactiveWaitMs?: number;
  maxOutputBytes?: number;
  commandId?: string;
  workId?: string;
  signal?: AbortSignal;
}

export interface HostCommandIdentity {
  forgeInstanceId: string;
}

/**
 * The authenticated MCP entrypoint validates the existing Full Access setting.
 * This lane still verifies the exact local instance and caller identity.
 */
export function requireHostProcessIdentity(controllerHome: string, principalId: string | undefined): HostCommandIdentity {
  const identity = readForgeInstanceIdentity(controllerHome);
  if (!identity?.instanceId) {
    throw new Error('HOST_PROCESS_TARGET_UNAVAILABLE: the serving ForgeInstance identity is not initialized');
  }
  if (!principalId?.trim()) {
    throw new Error('HOST_PROCESS_PRINCIPAL_REQUIRED: host process execution requires an authenticated principal');
  }
  return { forgeInstanceId: identity.instanceId };
}

/** Canonical absolute working directory for a host-local command. */
export function resolveHostCommandCwd(cwd: string): string {
  const requested = cwd?.trim();
  if (!requested) throw new Error('HOST_COMMAND_CWD_REQUIRED: host process execution requires an explicit cwd');
  if (!isAbsolute(requested)) throw new Error(`HOST_COMMAND_CWD_NOT_ABSOLUTE: ${requested}`);
  if (!existsSync(requested)) throw new Error(`HOST_COMMAND_CWD_MISSING: ${requested}`);
  let canonical: string;
  try {
    canonical = realpathSync(requested);
  } catch {
    throw new Error(`HOST_COMMAND_CWD_UNRESOLVABLE: ${requested}`);
  }
  if (!statSync(canonical).isDirectory()) throw new Error(`HOST_COMMAND_CWD_NOT_A_DIRECTORY: ${requested}`);
  return canonical;
}

function boundedNumber(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.trunc(value), max));
}

export interface HostCommandResult {
  handle: ProcessHandle;
  metrics: Awaited<ReturnType<typeof startLightweightHostCommand>>['metrics'];
  target: HostCommandIdentity & { cwd: string };
}

/**
 * Execute one host-local command on the ForgeInstance target.
 * Long-running commands return a running handle under the same logical
 * invocation; they are never re-executed.
 */
export async function executeHostCommand(request: HostCommandRequest): Promise<HostCommandResult> {
  const target = requireHostProcessIdentity(request.controllerHome, request.principalId);
  const cwd = resolveHostCommandCwd(request.cwd);
  const interactiveWaitMs = boundedNumber(
    request.interactiveWaitMs,
    HOST_INTERACTIVE_WAIT_DEFAULT_MS,
    HOST_INTERACTIVE_WAIT_MAX_MS,
  );
  const timeoutMs = Math.max(
    interactiveWaitMs + 1,
    boundedNumber(request.timeoutMs, DEFAULT_PROCESS_TIMEOUT_MS, HOST_TIMEOUT_MAX_MS),
  );
  const maxOutputBytes = boundedNumber(request.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 8 * 1024 * 1024);
  const input: StartLightweightHostCommandInput = {
    controllerHome: request.controllerHome,
    ...(request.command ? { command: request.command } : {}),
    ...(request.shellCommand ? { shellCommand: request.shellCommand } : {}),
    cwd,
    ...(request.env ? { env: request.env } : {}),
    interactiveWaitMs,
    timeoutMs,
    maxOutputBytes,
    ...(request.commandId ? { commandId: request.commandId } : {}),
    ...(request.workId ? { workId: request.workId } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
    principalId: request.principalId.trim(),
  };
  const started = await startLightweightHostCommand(input);
  return { handle: started.handle, metrics: started.metrics, target: { ...target, cwd } };
}
