#!/usr/bin/env bun
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { mkdirSync, openSync, closeSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { runProcess } from '../src/effects/process-runner';
import {
  startControllerService,
  stopControllerService,
} from '../src/cli/controller/lifecycle';
import { resolveRepoPreferredControllerHome } from '../src/cli/repositories/controller-home';

interface SourceBaselineState {
  schemaVersion: 1;
  requestId: string;
  repoRoot: string;
  controllerHome: string;
  expectedHead: string;
  phase: 'scheduled' | 'stopping_old_runtime' | 'starting_source_runtime' | 'succeeded' | 'failed';
  requestedAt: string;
  updatedAt: string;
  coordinatorPid?: number;
  completedAt?: string;
  fallbackRestored?: boolean;
  error?: string;
}

function option(args: string[], name: string): string | undefined {
  const index = args.lastIndexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function safeId(value: string | undefined): string {
  const id = value?.trim() || `source-baseline-${Date.now()}-${randomUUID().slice(0, 8)}`;
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(id)) throw new Error('SOURCE_BASELINE_REQUEST_ID_INVALID');
  return id;
}

function git(repoRoot: string, args: string[]): string {
  const result = runProcess('git', args, { cwd: repoRoot, timeoutMs: 10_000, maxOutputBytes: 100_000 });
  if (!result.ok) throw new Error(`SOURCE_BASELINE_GIT_FAILED: git ${args.join(' ')}: ${(result.stderr || result.stdout).trim()}`);
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

async function request(args: string[]): Promise<void> {
  const repoRoot = resolve(option(args, '--repo') ?? process.cwd());
  const controllerHome = resolveRepoPreferredControllerHome(repoRoot, option(args, '--controller-home'));
  const requestId = safeId(option(args, '--request-id'));
  const expectedHead = assertCleanMain(repoRoot, option(args, '--expected-head'));
  const requestedAt = new Date().toISOString();
  let state: SourceBaselineState = {
    schemaVersion: 1,
    requestId,
    repoRoot,
    controllerHome,
    expectedHead,
    phase: 'scheduled',
    requestedAt,
    updatedAt: requestedAt,
  };
  const logPath = join(controllerHome, 'source-baseline', 'activate-source-baseline.log');
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, 'a');
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', '--repo', repoRoot, '--controller-home', controllerHome, '--request-id', requestId, '--expected-head', expectedHead], {
      cwd: repoRoot,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        REPO_HARNESS_CONTROLLER_HOME: controllerHome,
        REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT: repoRoot,
        REPO_HARNESS_SOURCE_ROOT: repoRoot,
      },
    });
    child.unref();
    state = updateState(state, { coordinatorPid: child.pid });
  } finally {
    closeSync(logFd);
  }
  console.log(JSON.stringify({ accepted: true, requestId, expectedHead, statePath: statePath(controllerHome, requestId), coordinatorPid: state.coordinatorPid }));
}

async function run(args: string[]): Promise<void> {
  const repoRoot = resolve(option(args, '--repo') ?? process.cwd());
  const controllerHome = resolveRepoPreferredControllerHome(repoRoot, option(args, '--controller-home'));
  const requestId = safeId(option(args, '--request-id'));
  const expectedHead = option(args, '--expected-head');
  if (!expectedHead) throw new Error('SOURCE_BASELINE_EXPECTED_HEAD_REQUIRED');
  const requestedAt = new Date().toISOString();
  let state: SourceBaselineState = {
    schemaVersion: 1,
    requestId,
    repoRoot,
    controllerHome,
    expectedHead,
    phase: 'scheduled',
    requestedAt,
    updatedAt: requestedAt,
    coordinatorPid: process.pid,
  };
  atomicWrite(statePath(controllerHome, requestId), state);
  atomicWrite(join(controllerHome, 'source-baseline', 'current.json'), state);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  try {
    assertCleanMain(repoRoot, expectedHead);
    process.env.REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT = repoRoot;
    process.env.REPO_HARNESS_SOURCE_ROOT = repoRoot;
    // Lifecycle derives child entrypoints from argv[1]. Pin it to the real
    // source CLI rather than this coordinator script.
    process.argv[1] = join(repoRoot, 'src', 'cli', 'index.ts');
    state = updateState(state, { phase: 'stopping_old_runtime' });
    await stopControllerService({
      repo: repoRoot,
      controllerHome,
      requireFullStop: true,
      protectCallerAncestry: false,
      stopTimeoutMs: 30_000,
    });
    state = updateState(state, { phase: 'starting_source_runtime' });
    const started = await startControllerService({
      repo: repoRoot,
      controllerHome,
      slotLocalLifecycle: true,
      requireFullStop: true,
      protectCallerAncestry: false,
      startTimeoutMs: 60_000,
    });
    if (!started.status.ready) throw new Error('SOURCE_BASELINE_NOT_READY');
    assertCleanMain(repoRoot, expectedHead);
    state = updateState(state, { phase: 'succeeded', completedAt: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    let fallbackRestored = false;
    try {
      await startControllerService({ repo: repoRoot, controllerHome, startTimeoutMs: 60_000 });
      fallbackRestored = true;
    } catch {
      fallbackRestored = false;
    }
    updateState(state, { phase: 'failed', completedAt: new Date().toISOString(), fallbackRestored, error: message.slice(0, 2_000) });
    throw error;
  }
}

const [action, ...args] = process.argv.slice(2);
if (action === 'request') await request(args);
else if (action === 'run') await run(args);
else throw new Error(`SOURCE_BASELINE_ACTION_INVALID: ${action ?? '(missing)'}`);
