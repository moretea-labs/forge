#!/usr/bin/env bun
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { resolveRepoPreferredControllerHome } from '../src/cli/repositories/controller-home';
import { cleanupTerminalWork } from '../src/runtime/control-plane/execution/work-terminal-cleanup';
import { listWorkHandles, type WorkTerminalOutcome } from '../src/runtime/control-plane/execution/work-handle-store';
import { runProcess } from '../src/effects/process-runner';

interface CheckReceipt {
  id: string;
  command: string[];
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdoutTail?: string;
  stderrTail?: string;
}

interface CleanupReceiptSummary {
  workId: string;
  checkoutId: string;
  branch: string;
  attempted: boolean;
  complete: boolean;
  blockers: string[];
  reason?: string;
}

interface SourceBaselineState {
  schemaVersion: 1;
  requestId: string;
  repoId: string;
  repoRoot: string;
  controllerHome: string;
  expectedHead: string;
  phase: 'scheduled' | 'running_checks' | 'cleaning_terminal_work' | 'succeeded' | 'failed';
  requestedAt: string;
  updatedAt: string;
  coordinatorPid?: number;
  completedAt?: string;
  checks: CheckReceipt[];
  cleanup: CleanupReceiptSummary[];
  error?: string;
}

interface CheckDefinition {
  id: string;
  args: string[];
  timeoutMs: number;
}

const CHECKS: readonly CheckDefinition[] = [
  { id: 'package:check:type', args: ['run', 'check:type'], timeoutMs: 10 * 60_000 },
  { id: 'package:check:runtime-architecture', args: ['run', 'check:runtime-architecture'], timeoutMs: 3 * 60_000 },
  ...[
    'tests/runtime/process-runtime.test.ts',
    'tests/runtime/work-terminal-cleanup.test.ts',
    'tests/runtime/canonical-single-runtime.test.ts',
    'tests/cli/runtime-command.test.ts',
    'tests/runtime/stable-state-and-bootstrap.test.ts',
    'tests/cli/mcp-controller.test.ts',
  ].map((path) => ({
    id: `focused:runtime-architecture-replacement:${path}`,
    args: ['test', '--max-concurrency', '1', path],
    timeoutMs: 5 * 60_000,
  })),
  { id: 'package:test:core', args: ['run', 'test:core'], timeoutMs: 30 * 60_000 },
];

function option(args: string[], name: string): string | undefined {
  const index = args.lastIndexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function safeId(value: string | undefined): string {
  const id = value?.trim() || `source-baseline-${Date.now()}-${randomUUID().slice(0, 8)}`;
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(id)) throw new Error('SOURCE_BASELINE_REQUEST_ID_INVALID');
  return id;
}

function boundedTail(value: string, maxChars = 20_000): string | undefined {
  if (!value) return undefined;
  return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}

function git(repoRoot: string, args: string[], timeoutMs = 10_000): string {
  const result = runProcess('git', args, { cwd: repoRoot, timeoutMs, maxOutputBytes: 200_000 });
  if (!result.ok) {
    throw new Error(`SOURCE_BASELINE_GIT_FAILED: git ${args.join(' ')}: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function assertCleanMain(repoRoot: string, expectedHead?: string): string {
  const branch = git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') throw new Error(`SOURCE_BASELINE_MAIN_REQUIRED: current branch is ${branch}`);
  const head = git(repoRoot, ['rev-parse', 'HEAD']);
  if (expectedHead && head !== expectedHead) {
    throw new Error(`SOURCE_BASELINE_HEAD_CHANGED: expected ${expectedHead}, found ${head}`);
  }
  const status = git(repoRoot, ['status', '--porcelain']);
  if (status) throw new Error(`SOURCE_BASELINE_DIRTY_WORKTREE: ${status.split('\n').slice(0, 20).join(', ')}`);
  return head;
}

function repositoryId(repoRoot: string): string {
  const configPath = join(repoRoot, '.ai', 'harness', 'repository.json');
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { repoId?: unknown };
  if (typeof parsed.repoId !== 'string' || !parsed.repoId.trim()) {
    throw new Error('SOURCE_BASELINE_REPOSITORY_ID_UNAVAILABLE');
  }
  return parsed.repoId.trim();
}

function statePath(controllerHome: string, requestId: string): string {
  return join(controllerHome, 'source-baseline', 'requests', `${requestId}.json`);
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function updateState(state: SourceBaselineState, patch: Partial<SourceBaselineState>): SourceBaselineState {
  const next = { ...state, ...patch, updatedAt: new Date().toISOString() };
  atomicWrite(statePath(next.controllerHome, next.requestId), next);
  atomicWrite(join(next.controllerHome, 'source-baseline', 'current.json'), next);
  return next;
}

function runCheck(repoRoot: string, definition: CheckDefinition): CheckReceipt {
  const started = Date.now();
  const result = runProcess(process.execPath, definition.args, {
    cwd: repoRoot,
    timeoutMs: definition.timeoutMs,
    maxOutputBytes: 2 * 1024 * 1024,
    env: {
      ...process.env,
      FORGE_TEST_NO_INHERIT: '1',
    },
  });
  return {
    id: definition.id,
    command: [process.execPath, ...definition.args],
    ok: result.ok,
    exitCode: result.status,
    timedOut: result.timedOut,
    durationMs: Date.now() - started,
    stdoutTail: boundedTail(result.stdout),
    stderrTail: boundedTail(result.stderr),
  };
}

function terminalOutcome(handle: ReturnType<typeof listWorkHandles>[number]): WorkTerminalOutcome {
  return handle.cleanupReceipt?.terminalOutcome ?? 'cancelled';
}

function cleanupSafety(repoRoot: string, worktreePath: string): { safe: boolean; reason?: string } {
  if (!existsSync(worktreePath)) return { safe: true };
  const repository = runProcess('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: worktreePath,
    timeoutMs: 10_000,
    maxOutputBytes: 100_000,
  });
  if (!repository.ok || repository.stdout.trim() !== 'true') return { safe: false, reason: 'WORKTREE_NOT_GIT_REPOSITORY' };
  const status = git(worktreePath, ['status', '--porcelain']);
  if (status) return { safe: false, reason: 'WORKTREE_DIRTY' };
  const head = git(worktreePath, ['rev-parse', 'HEAD']);
  const contained = runProcess('git', ['merge-base', '--is-ancestor', head, 'HEAD'], {
    cwd: repoRoot,
    timeoutMs: 10_000,
    maxOutputBytes: 100_000,
  });
  return contained.ok
    ? { safe: true }
    : { safe: false, reason: `WORKTREE_HEAD_NOT_CONTAINED_IN_MAIN: ${head}` };
}

async function request(args: string[]): Promise<void> {
  const repoRoot = resolve(option(args, '--repo') ?? process.cwd());
  const controllerHome = resolveRepoPreferredControllerHome(repoRoot, option(args, '--controller-home'));
  const requestId = safeId(option(args, '--request-id'));
  const expectedHead = assertCleanMain(repoRoot, option(args, '--expected-head'));
  const repoId = repositoryId(repoRoot);
  const requestedAt = new Date().toISOString();
  let state: SourceBaselineState = {
    schemaVersion: 1,
    requestId,
    repoId,
    repoRoot,
    controllerHome,
    expectedHead,
    phase: 'scheduled',
    requestedAt,
    updatedAt: requestedAt,
    checks: [],
    cleanup: [],
  };
  const logPath = join(controllerHome, 'source-baseline', 'activate-source-baseline.log');
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, 'a');
  try {
    const child = spawn(process.execPath, [
      fileURLToPath(import.meta.url),
      'run',
      '--repo', repoRoot,
      '--controller-home', controllerHome,
      '--request-id', requestId,
      '--expected-head', expectedHead,
    ], {
      cwd: repoRoot,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        FORGE_CONTROLLER_HOME: controllerHome,
        FORGE_CONTROLLER_RUNTIME_SOURCE_ROOT: repoRoot,
        FORGE_SOURCE_ROOT: repoRoot,
      },
    });
    child.unref();
    state = updateState(state, { coordinatorPid: child.pid });
  } finally {
    closeSync(logFd);
  }
  console.log(JSON.stringify({
    accepted: true,
    requestId,
    expectedHead,
    statePath: statePath(controllerHome, requestId),
    coordinatorPid: state.coordinatorPid,
  }));
}

async function run(args: string[]): Promise<void> {
  const repoRoot = resolve(option(args, '--repo') ?? process.cwd());
  const controllerHome = resolveRepoPreferredControllerHome(repoRoot, option(args, '--controller-home'));
  const requestId = safeId(option(args, '--request-id'));
  const expectedHead = option(args, '--expected-head');
  if (!expectedHead) throw new Error('SOURCE_BASELINE_EXPECTED_HEAD_REQUIRED');
  const repoId = repositoryId(repoRoot);
  const requestedAt = new Date().toISOString();
  let state: SourceBaselineState = {
    schemaVersion: 1,
    requestId,
    repoId,
    repoRoot,
    controllerHome,
    expectedHead,
    phase: 'scheduled',
    requestedAt,
    updatedAt: requestedAt,
    coordinatorPid: process.pid,
    checks: [],
    cleanup: [],
  };
  atomicWrite(statePath(controllerHome, requestId), state);
  atomicWrite(join(controllerHome, 'source-baseline', 'current.json'), state);
  try {
    assertCleanMain(repoRoot, expectedHead);
    state = updateState(state, { phase: 'running_checks' });
    for (const definition of CHECKS) {
      const receipt = runCheck(repoRoot, definition);
      state = updateState(state, { checks: [...state.checks, receipt] });
      if (!receipt.ok) throw new Error(`SOURCE_BASELINE_CHECK_FAILED: ${definition.id}`);
      assertCleanMain(repoRoot, expectedHead);
    }

    state = updateState(state, { phase: 'cleaning_terminal_work' });
    const candidates = listWorkHandles(controllerHome, repoId)
      .filter((handle) => handle.managedWorktree && handle.state === 'failed_terminal_cleanup');
    for (const handle of candidates) {
      const safety = cleanupSafety(repoRoot, handle.worktreePath);
      if (!safety.safe) {
        state = updateState(state, {
          cleanup: [...state.cleanup, {
            workId: handle.workId,
            checkoutId: handle.checkoutId,
            branch: handle.branch,
            attempted: false,
            complete: false,
            blockers: [],
            reason: safety.reason,
          }],
        });
        continue;
      }
      const result = await cleanupTerminalWork({
        controllerHome,
        handle,
        targetBranch: 'main',
        deleteBranch: true,
        terminalOutcome: terminalOutcome(handle),
        failureReason: handle.failureReason ?? 'source baseline terminal cleanup reconciliation',
      });
      const summary: CleanupReceiptSummary = {
        workId: handle.workId,
        checkoutId: handle.checkoutId,
        branch: handle.branch,
        attempted: true,
        complete: result.receipt.complete,
        blockers: [...result.receipt.blockers],
      };
      state = updateState(state, { cleanup: [...state.cleanup, summary] });
      if (!result.receipt.complete) {
        throw new Error(`SOURCE_BASELINE_CLEANUP_BLOCKED: ${handle.workId}: ${result.receipt.blockers.join('; ')}`);
      }
    }

    assertCleanMain(repoRoot, expectedHead);
    state = updateState(state, { phase: 'succeeded', completedAt: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    updateState(state, {
      phase: 'failed',
      completedAt: new Date().toISOString(),
      error: message.slice(0, 4_000),
    });
    throw error;
  }
}

const [action, ...args] = process.argv.slice(2);
if (action === 'request') await request(args);
else if (action === 'run') await run(args);
else throw new Error(`SOURCE_BASELINE_ACTION_INVALID: ${action ?? '(missing)'}`);
