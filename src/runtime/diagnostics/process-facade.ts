import { executionIdentityForRepository } from '../control-plane/execution/execution-identity';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { RepositoryRecord } from '../../cli/repositories/types';
import {
  currentCliRuntimeTarget,
  resolveCliChildInvocation,
  type CliChildInvocation,
  type CliChildInvocationOptions,
  type CliRuntimeTarget,
} from '../../cli/runtime-invocation';
import { readRuntimeGeneration, resolveControllerRuntimeSourceRoot } from '../control-plane/runtime-generation';
import {
  effectiveProcessStatus,
  processContractStatus,
  readProcessLogs,
  spawnManagedProcess,
  waitForProcess,
  type ProcessHandle,
} from '../execution/process-runtime';
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

function runtimeCliTarget(controllerHome: string): CliRuntimeTarget {
  const moduleSourceRoot = resolve(import.meta.dir, '..', '..', '..');
  const moduleEntryExists = existsSync(resolve(moduleSourceRoot, 'src', 'cli', 'index.ts'));
  const source = resolveControllerRuntimeSourceRoot({
    explicitRoot: moduleEntryExists ? moduleSourceRoot : undefined,
  });
  const generation = readRuntimeGeneration(controllerHome);
  const sourceRevision = generation?.source.releaseRevision
    ?? generation?.source.commit
    ?? process.env.FORGE_ACTIVE_RUNTIME_REVISION;
  return currentCliRuntimeTarget({
    env: process.env,
    argv: process.env.FORGE_RUNTIME_EXECUTION === 'standalone-binary' ? process.argv : [],
    moduleUrl: import.meta.url,
    sourceRoot: source.root,
    cwd: source.root ?? moduleSourceRoot,
    sourceRevision,
  });
}

export function resolveDiagnosticCliInvocation(
  entry: string,
  args: readonly string[],
  options: CliChildInvocationOptions = {},
): CliChildInvocation {
  return resolveCliChildInvocation(entry, args, options);
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
  const effective = effectiveProcessStatus(handle, handle.completed === true);
  const status = handle.completed === true && handle.ok === false && (effective === 'starting' || effective === 'running' || effective === 'running_recovered')
    ? 'failed'
    : effective;
  return {
    processId: handle.processId,
    commandId: handle.commandId,
    status,
    contractStatus: processContractStatus(status),
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
  /** Internal test/embedding override for deterministic runtime launch fixtures. */
  cliInvocation?: { entry: string; options?: CliChildInvocationOptions };
}): Promise<Record<string, unknown>> {
  let invocation: CliChildInvocation;
  let target: CliRuntimeTarget | undefined;
  let resolutionFailure: string | undefined;
  try {
    if (input.cliInvocation) {
      invocation = resolveDiagnosticCliInvocation(
        input.cliInvocation.entry,
        [],
        input.cliInvocation.options,
      );
    } else {
      target = runtimeCliTarget(input.controllerHome);
      invocation = resolveDiagnosticCliInvocation(target.entry, [], {
        runtimeExecutable: target.runtimeKind === 'compiled_bun_release' ? target.entry : process.execPath,
        runtimeKind: target.runtimeKind,
        sourceRevision: target.sourceRevision,
        immutable: target.immutable,
        ...(target.runtimeKind === 'package_launcher' ? { launcherEntry: target.entry } : {}),
      });
    }
  } catch (error) {
    resolutionFailure = error instanceof Error ? error.message : String(error);
    invocation = resolveDiagnosticCliInvocation('<runtime-resolution-failure>', [], {
      runtimeExecutable: process.execPath,
      runtimeKind: process.versions.bun ? 'bun_source' : 'node_source',
      sourceRevision: 'resolution-failure',
    });
  }
  const semanticArgs = diagnosticArguments(input.args);
  const encodedArgs = Buffer.from(JSON.stringify(semanticArgs), 'utf8').toString('base64url');
  const returnHandleImmediately = input.args.apply_mode === 'async';
  const interactiveWaitMs = returnHandleImmediately
    ? 0
    : boundedNumber(
      input.args.interactive_wait_ms,
      DEFAULT_DIAGNOSTIC_INTERACTIVE_WAIT_MS,
      0,
      5_000,
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
  const spawned = await spawnManagedProcess({
    controllerHome: input.controllerHome,
    repoId: input.repository.repoId,
    checkoutId: input.repository.activeCheckoutId,
    executionIdentity: executionIdentityForRepository(input.repository),
    commandId: `diagnostic:${input.tool}`,
    command: {
      kind: 'argv',
      ...(resolutionFailure
        ? {
          executable: process.execPath,
          args: ['-e', `console.error(${JSON.stringify(resolutionFailure)}); process.exit(78);`],
        }
        : resolveDiagnosticCliInvocation(
          target?.entry ?? input.cliInvocation!.entry,
          [
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
          target
            ? {
              runtimeExecutable: target.runtimeKind === 'compiled_bun_release' ? target.entry : invocation.executable,
              runtimeKind: target.runtimeKind,
              sourceRevision: target.sourceRevision,
              immutable: target.immutable,
              ...(target.runtimeKind === 'package_launcher' ? { launcherEntry: target.entry } : {}),
            }
            : input.cliInvocation?.options,
        )),
      // The executable entry may live in the forge runtime source tree,
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

  const handle = spawned.completed === true
    ? await waitForProcess(input.controllerHome, input.repository.repoId, spawned.processId, { timeoutMs: 1_000 }).catch(() => spawned)
    : spawned;
  const pointers = processPointers(input.repository.repoId, handle.processId);
  if (handle.completed === true) {
    if (handle.ok !== true) {
      return {
        accepted: false,
        mode: 'process_direct',
        path: 'process_direct',
        error: {
          code: resolutionFailure ? 'DIAGNOSTIC_RUNTIME_UNRESOLVED' : 'DIAGNOSTIC_PROCESS_FAILED',
          message: handle.stderr || handle.stderrTail || `diagnostic process ${handle.processId} failed`,
        },
        process: processSummary(handle),
        processPointers: pointers,
        diagnosticRuntime: {
          runtimeKind: target?.runtimeKind ?? invocation.runtimeKind,
          sourceRevision: target?.sourceRevision ?? invocation.sourceRevision,
          immutable: target?.immutable ?? invocation.immutable,
          explanation: resolutionFailure ?? target?.explanation ?? invocation.diagnostic,
        },
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
        diagnosticRuntime: {
          runtimeKind: target?.runtimeKind ?? invocation.runtimeKind,
          sourceRevision: target?.sourceRevision ?? invocation.sourceRevision,
          immutable: target?.immutable ?? invocation.immutable,
          explanation: target?.explanation ?? invocation.diagnostic,
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
        runtime: {
          runtimeKind: target?.runtimeKind ?? invocation.runtimeKind,
          sourceRevision: target?.sourceRevision ?? invocation.sourceRevision,
          immutable: target?.immutable ?? invocation.immutable,
          explanation: target?.explanation ?? invocation.diagnostic,
        },
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
    diagnosticRuntime: {
      runtimeKind: target?.runtimeKind ?? invocation.runtimeKind,
      sourceRevision: target?.sourceRevision ?? invocation.sourceRevision,
      immutable: target?.immutable ?? invocation.immutable,
      explanation: target?.explanation ?? invocation.diagnostic,
    },
    durableSideEffects: handle.durableSideEffects,
  };
}
