import { executionIdentityForRepository } from '../control-plane/execution/execution-identity';
import { existsSync } from 'fs';
import { basename, join, resolve } from 'path';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { resolveControllerRuntimeSourceRoot } from '../control-plane/runtime-generation';
import { readProcessLogs, spawnManagedProcess, type ProcessHandle } from '../execution/process-runtime';
import { isReadOnlyDiagnosticTool, type ReadOnlyDiagnosticTool } from './read-only-tool';

const DEFAULT_DIAGNOSTIC_INTERACTIVE_WAIT_MS = 2_000;
const DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 120_000;
const DEFAULT_DIAGNOSTIC_INLINE_MAX_BYTES = 16 * 1024;
const DEFAULT_DIAGNOSTIC_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const ROUTING_ONLY_ARGUMENTS = new Set([
  'repo_id',
  'checkout_id',
  'request_id',
  'apply_mode',
  'wait',
  'wait_ms',
  'admission_timeout_ms',
  'queue_timeout_ms',
  'execution_timeout_ms',
  'interactive_wait_ms',
]);

function runtimeCliEntry(): { entry: string; cwd: string } {
  const currentEntry = process.argv[1] ? resolve(process.argv[1]) : undefined;
  if (currentEntry && existsSync(currentEntry)) {
    const name = basename(currentEntry);
    if (name === 'repo-harness.js' || name === 'index.ts') {
      return { entry: currentEntry, cwd: resolveControllerRuntimeSourceRoot().root ?? process.cwd() };
    }
  }
  // Tests and source worktrees must execute the CLI from the same source tree as
  // this module, not an inherited runtime-source environment pointing at main.
  const moduleSourceRoot = resolve(import.meta.dir, '..', '..', '..');
  const moduleEntry = join(moduleSourceRoot, 'src', 'cli', 'index.ts');
  if (existsSync(moduleEntry)) return { entry: moduleEntry, cwd: moduleSourceRoot };

  const source = resolveControllerRuntimeSourceRoot();
  if (!source.root) {
    throw new Error(`DIAGNOSTIC_RUNTIME_SOURCE_UNAVAILABLE: ${source.reason}`);
  }
  const entry = join(source.root, 'src', 'cli', 'index.ts');
  if (!existsSync(entry)) {
    throw new Error(`DIAGNOSTIC_RUNTIME_ENTRY_MISSING: ${entry}`);
  }
  return { entry, cwd: source.root };
}

function diagnosticArguments(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !ROUTING_ONLY_ARGUMENTS.has(key)));
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.trunc(value), max));
}

function processPointers(repoId: string, processId: string): Record<string, unknown> {
  return {
    get: { tool: 'process_get', arguments: { repo_id: repoId, process_id: processId } },
    wait: { tool: 'process_wait', arguments: { repo_id: repoId, process_id: processId } },
    logs: { tool: 'process_logs', arguments: { repo_id: repoId, process_id: processId } },
  };
}

function processSummary(handle: ProcessHandle): Record<string, unknown> {
  return {
    processId: handle.processId,
    commandId: handle.commandId,
    status: handle.status,
    contractStatus: handle.contractStatus,
    route: handle.route,
    startedAt: handle.startedAt,
    completed: handle.completed === true,
    ok: handle.ok,
    exitCode: handle.exitCode,
    timedOut: handle.timedOut,
    cancelled: handle.cancelled,
  };
}

function readDiagnosticOutput(
  controllerHome: string,
  repoId: string,
  handle: ProcessHandle,
): { output: string; bytes: number } {
  const persisted = readProcessLogs(controllerHome, repoId, handle.processId, DEFAULT_DIAGNOSTIC_MAX_OUTPUT_BYTES);
  const output = handle.stdout ?? handle.stdoutTail ?? persisted?.stdout ?? '';
  return {
    output,
    bytes: persisted?.stdoutBytes ?? Buffer.byteLength(output, 'utf8'),
  };
}

function parseDiagnosticResult(handle: ProcessHandle, output: string): Record<string, unknown> {
  if (!output.trim()) {
    throw new Error(`DIAGNOSTIC_PROCESS_EMPTY_OUTPUT: ${handle.processId}`);
  }
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('diagnostic output is not an object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`DIAGNOSTIC_PROCESS_INVALID_JSON: ${handle.processId}: ${detail}`);
  }
}

export function isProcessIsolatedReadDiagnostic(name: string): name is ReadOnlyDiagnosticTool {
  return isReadOnlyDiagnosticTool(name);
}

export async function runReadOnlyDiagnosticViaProcessRuntime(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  tool: ReadOnlyDiagnosticTool;
  args: Record<string, unknown>;
  /** Internal test/embedding override; MCP callers use the fixed 16KiB budget. */
  inlineMaxBytes?: number;
}): Promise<Record<string, unknown>> {
  const { entry } = runtimeCliEntry();
  const semanticArgs = diagnosticArguments(input.args);
  const encodedArgs = Buffer.from(JSON.stringify(semanticArgs), 'utf8').toString('base64url');
  const returnHandleImmediately = input.args.apply_mode === 'async';
  const interactiveWaitMs = returnHandleImmediately
    ? 0
    : boundedNumber(
      input.args.interactive_wait_ms,
      DEFAULT_DIAGNOSTIC_INTERACTIVE_WAIT_MS,
      0,
      120_000,
    );
  const inlineMaxBytes = boundedNumber(
    input.inlineMaxBytes,
    DEFAULT_DIAGNOSTIC_INLINE_MAX_BYTES,
    1,
    DEFAULT_DIAGNOSTIC_MAX_OUTPUT_BYTES,
  );
  const timeoutMs = boundedNumber(
    input.args.execution_timeout_ms,
    DEFAULT_DIAGNOSTIC_TIMEOUT_MS,
    interactiveWaitMs + 1,
    24 * 60 * 60_000,
  );
  const requestId = typeof input.args.request_id === 'string' ? input.args.request_id.trim() || undefined : undefined;
  const handle = await spawnManagedProcess({
    controllerHome: input.controllerHome,
    repoId: input.repository.repoId,
    checkoutId: input.repository.activeCheckoutId,
    executionIdentity: executionIdentityForRepository(input.repository),
    commandId: `diagnostic:${input.tool}`,
    command: {
      kind: 'argv',
      executable: process.execPath,
      args: [
        entry,
        'runtime',
        'diagnostic-read',
        '--controller-home',
        input.controllerHome,
        '--repo-id',
        input.repository.repoId,
        '--tool',
        input.tool,
        '--args-base64',
        encodedArgs,
      ],
      // The executable entry may live in the repo-harness runtime source tree,
      // but execution ownership belongs to the selected repository checkout.
      // Keeping cwd inside that checkout preserves fail-closed route identity.
      cwd: input.repository.canonicalRoot,
    },
    interactiveWaitMs,
    timeoutMs,
    maxOutputBytes: DEFAULT_DIAGNOSTIC_MAX_OUTPUT_BYTES,
    resourceClaims: [],
    returnHandleImmediately,
    origin: {
      surface: 'mcp',
      toolName: input.tool,
      requestId,
    },
  });

  const pointers = processPointers(input.repository.repoId, handle.processId);
  if (handle.completed === true) {
    if (handle.ok !== true) {
      return {
        accepted: false,
        mode: 'process_direct',
        path: 'process_direct',
        error: {
          code: 'DIAGNOSTIC_PROCESS_FAILED',
          message: handle.stderr || handle.stderrTail || `diagnostic process ${handle.processId} failed`,
        },
        process: processSummary(handle),
        processPointers: pointers,
        durableSideEffects: handle.durableSideEffects,
      };
    }
    const { output, bytes } = readDiagnosticOutput(input.controllerHome, input.repository.repoId, handle);
    if (returnHandleImmediately || bytes > inlineMaxBytes) {
      return {
        accepted: true,
        mode: 'process_managed',
        path: 'process_managed',
        processId: handle.processId,
        deduplicated: handle.deduplicated === true,
        process: processSummary(handle),
        processPointers: pointers,
        result: {
          available: true,
          inline: false,
          bytes,
          inlineLimitBytes: inlineMaxBytes,
          reason: returnHandleImmediately ? 'caller_requested_async' : 'result_exceeds_inline_limit',
        },
        durableSideEffects: handle.durableSideEffects,
      };
    }
    const diagnostic = parseDiagnosticResult(handle, output);
    return {
      ...diagnostic,
      diagnosticExecution: {
        accepted: true,
        mode: 'process_direct',
        path: 'process_direct',
        processId: handle.processId,
        deduplicated: handle.deduplicated === true,
        resultBytes: bytes,
        inlineLimitBytes: inlineMaxBytes,
        durableSideEffects: handle.durableSideEffects,
        processPointers: pointers,
      },
    };
  }

  return {
    accepted: true,
    mode: 'process_managed',
    path: 'process_managed',
    processId: handle.processId,
    deduplicated: handle.deduplicated === true,
    process: processSummary(handle),
    processPointers: pointers,
    result: {
      available: false,
      inline: false,
      reason: returnHandleImmediately ? 'caller_requested_async' : 'interactive_wait_expired',
    },
    durableSideEffects: handle.durableSideEffects,
  };
}
