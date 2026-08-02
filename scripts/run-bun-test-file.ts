#!/usr/bin/env bun
import {
  CHILD_SUPERVISOR_FAILURE_CODES,
  cleanupOwnedProcessGroup,
  runBoundedChild,
  type BoundedChildSupervisorOperations,
} from '../src/runtime/shared/bounded-child-supervisor';

export const TEST_FAILURE_CODES = {
  SOURCE_ASSERTION_FAILED: 'TEST_SOURCE_ASSERTION_FAILED',
  FIXTURE_OR_FLAKY_FAILED: 'TEST_FIXTURE_OR_FLAKY_FAILED',
  INFRA_CHILD_START_FAILED: 'TEST_INFRA_CHILD_START_FAILED',
  INFRA_FILE_WALL_TIMEOUT: 'TEST_INFRA_FILE_WALL_TIMEOUT',
  INFRA_PORT_CONFLICT: 'TEST_INFRA_PORT_CONFLICT',
  INFRA_RESIDUAL_PROCESS: 'TEST_INFRA_RESIDUAL_PROCESS',
  INFRA_RUNNER_DID_NOT_CONVERGE: 'TEST_INFRA_RUNNER_DID_NOT_CONVERGE',
  INFRA_WORKTREE_MUTATION: 'TEST_INFRA_WORKTREE_MUTATION',
} as const;

export type TestFailureCode = (typeof TEST_FAILURE_CODES)[keyof typeof TEST_FAILURE_CODES];
export type TestFailureClass = 'source' | 'fixture' | 'infrastructure';

export interface BunTestFileRunResult {
  exitCode: number;
  lingeringPids: number[];
  remainingPids: number[];
  pidReuseFenced?: boolean;
  durationMs?: number;
  failureClass?: TestFailureClass;
  failureCode?: TestFailureCode;
}

export const DEFAULT_FILE_WALL_TIMEOUT_MS = 120_000;

function parseTimeout(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function fileLabel(args: string[]): string {
  return [...args].reverse().find((arg) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(arg))
    ?? [...args].reverse().find((arg) => !arg.startsWith('-'))
    ?? 'Bun test file';
}

export function classifyBunTestExit(exitCode: number, output = ''): {
  failureClass: 'source' | 'fixture';
  failureCode: typeof TEST_FAILURE_CODES.SOURCE_ASSERTION_FAILED | typeof TEST_FAILURE_CODES.FIXTURE_OR_FLAKY_FAILED;
} | undefined {
  if (exitCode === 0) return undefined;
  if (/\b(?:TEST_FIXTURE_FAILURE|TEST_FLAKY_FAILURE|FIXTURE_SETUP_FAILED)\b/.test(output)) {
    return { failureClass: 'fixture', failureCode: TEST_FAILURE_CODES.FIXTURE_OR_FLAKY_FAILED };
  }
  return { failureClass: 'source', failureCode: TEST_FAILURE_CODES.SOURCE_ASSERTION_FAILED };
}

function mapSupervisorFailure(code: string | undefined): TestFailureCode | undefined {
  switch (code) {
    case CHILD_SUPERVISOR_FAILURE_CODES.CHILD_START_FAILED:
      return TEST_FAILURE_CODES.INFRA_CHILD_START_FAILED;
    case CHILD_SUPERVISOR_FAILURE_CODES.WALL_TIMEOUT:
      return TEST_FAILURE_CODES.INFRA_FILE_WALL_TIMEOUT;
    case CHILD_SUPERVISOR_FAILURE_CODES.RESIDUAL_PROCESS:
      return TEST_FAILURE_CODES.INFRA_RESIDUAL_PROCESS;
    case CHILD_SUPERVISOR_FAILURE_CODES.DID_NOT_CONVERGE:
      return TEST_FAILURE_CODES.INFRA_RUNNER_DID_NOT_CONVERGE;
    default:
      return undefined;
  }
}

export type ClosedChildProcessGroupOperations = BoundedChildSupervisorOperations;

export async function cleanupClosedChildProcessGroup(
  pid: number | undefined,
  _label: string,
  exitCode: number,
  operations?: ClosedChildProcessGroupOperations,
): Promise<BunTestFileRunResult> {
  const cleanup = await cleanupOwnedProcessGroup(pid, operations);
  const failureCode = mapSupervisorFailure(cleanup.failureCode);
  return {
    exitCode: failureCode ? 1 : exitCode,
    lingeringPids: cleanup.residualPids,
    remainingPids: cleanup.remainingPids,
    pidReuseFenced: cleanup.pidReuseFenced,
    ...(failureCode ? { failureClass: 'infrastructure' as const, failureCode } : {}),
  };
}

export interface RunBunTestFileOptions {
  fileWallTimeoutMs?: number;
  forwardSignals?: boolean;
  cwd?: string;
}

export async function runBunTestFile(
  args: string[],
  options: RunBunTestFileOptions = {},
): Promise<BunTestFileRunResult> {
  if (args.length === 0) throw new Error('run-bun-test-file requires Bun test arguments');
  const label = fileLabel(args);
  const wallTimeoutMs = options.fileWallTimeoutMs
    ?? parseTimeout(process.env.BUN_TEST_FILE_WALL_TIMEOUT_MS, DEFAULT_FILE_WALL_TIMEOUT_MS);
  const startedAt = performance.now();
  const result = await runBoundedChild(process.execPath, ['test', ...args], {
    cwd: options.cwd ?? process.cwd(),
    env: process.env,
    timeoutMs: wallTimeoutMs,
    stdio: 'capture',
    forwardSignals: options.forwardSignals ?? true,
    termination: { gracePeriodMs: 100, killAfterMs: 2_000, pollIntervalMs: 25 },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  const infrastructureFailure = mapSupervisorFailure(result.failureCode);
  if (result.pidReuseFenced) {
    console.error(`[tests] ownership fence skipped cleanup for reused PID after ${label}`);
  }
  if (result.residualPids.length > 0) {
    const preview = result.residualPids.slice(0, 12).join(', ');
    console.error(`[tests] observed ${result.residualPids.length} residual process(es) after ${label}: ${preview}`);
  }
  if (infrastructureFailure) {
    console.error(`[tests] ${infrastructureFailure}: ${label}`);
    return {
      exitCode: 1,
      lingeringPids: result.residualPids,
      remainingPids: result.remainingPids,
      pidReuseFenced: result.pidReuseFenced,
      durationMs: Math.round(performance.now() - startedAt),
      failureClass: 'infrastructure',
      failureCode: infrastructureFailure,
    };
  }

  if (result.signal === 'SIGINT' || result.signal === 'SIGTERM') {
    return {
      exitCode: result.signal === 'SIGINT' ? 130 : 143,
      lingeringPids: [],
      remainingPids: [],
      pidReuseFenced: result.pidReuseFenced,
      durationMs: Math.round(performance.now() - startedAt),
    };
  }

  if (result.status !== 0 && /(?:EADDRINUSE|address already in use|Failed to listen at)/i.test(`${result.stdout}\n${result.stderr}`)) {
    console.error(`[tests] ${TEST_FAILURE_CODES.INFRA_PORT_CONFLICT}: ${label}`);
    return {
      exitCode: 1,
      lingeringPids: [],
      remainingPids: [],
      pidReuseFenced: result.pidReuseFenced,
      durationMs: Math.round(performance.now() - startedAt),
      failureClass: 'infrastructure',
      failureCode: TEST_FAILURE_CODES.INFRA_PORT_CONFLICT,
    };
  }

  const sourceFailure = classifyBunTestExit(result.status, `${result.stdout}\n${result.stderr}`);
  if (sourceFailure) console.error(`[tests] ${sourceFailure.failureCode}: ${label} exited with code ${result.status}`);
  return {
    exitCode: result.status,
    lingeringPids: [],
    remainingPids: [],
    pidReuseFenced: result.pidReuseFenced,
    durationMs: Math.round(performance.now() - startedAt),
    ...sourceFailure,
  };
}

if (import.meta.main) {
  try {
    const result = await runBunTestFile(process.argv.slice(2));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
