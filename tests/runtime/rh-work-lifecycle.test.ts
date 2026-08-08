import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { createMcpToolContext } from '../../src/cli/mcp/server';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { callExecutionTool } from '../../src/runtime/gateway/mcp/execution-tools';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';
import { acquireRuntimeOwnership } from '../../src/runtime/root/ownership';
import { ensureActiveRuntimeRelease } from '../../src/runtime/root/release-store';
import { bindRuntimeWriteClaim, clearRuntimeWriteClaimForTests } from '../../src/runtime/root/write-fence';

const roots: string[] = [];

afterEach(() => {
  clearRuntimeWriteClaimForTests();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(String(result.stderr || `git ${args.join(' ')} failed`));
  return String(result.stdout ?? '').trim();
}

function runtimeManifest(controllerHome: string): string {
  const path = join(controllerHome, 'lifecycle-test.manifest.json');
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    releaseId: 'release-lifecycle-test',
    artifactIdentity: 'artifact-lifecycle-test',
    entrypoint: 'forge-runtime',
    arguments: [],
    configurationSchemaVersion: 1,
    controllerHome,
    databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
    workerProtocolVersion: 1,
    createdAt: new Date().toISOString(),
  }));
  return path;
}

function fixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `forge-rh-work-lifecycle-${label}-`));
  roots.push(root);
  const controllerHome = join(root, 'controller');
  const repoRoot = join(root, 'repo');
  ensureControllerHome(controllerHome);
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Lifecycle Test']);
  git(repoRoot, ['config', 'user.email', 'lifecycle@example.test']);
  writeFileSync(join(repoRoot, 'README.md'), 'fixture\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'fixture']);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: `lifecycle-${label}` });
  const owner = acquireRuntimeOwnership(controllerHome, `runtime-lifecycle-${label}`);
  const authority = ensureActiveRuntimeRelease(controllerHome, runtimeManifest(controllerHome));
  bindRuntimeWriteClaim({ controllerHome, owner: owner.record, authority });
  const ctx = createMcpToolContext({
    controllerHome,
    profile: 'controller',
    repo: repoRoot,
    sessionId: `mcp-lifecycle-${label}`,
    principalId: `principal-lifecycle-${label}`,
    controllerInstanceId: `runtime-lifecycle-${label}`,
  });
  return { root, controllerHome, repoRoot, repository, ctx };
}

async function prepareManagedWork(fx: ReturnType<typeof fixture>, objective: string) {
  const started = await callExecutionTool(fx.ctx, 'session_start', {});
  const sessionId = String((started?.structuredContent as { session?: { sessionId?: string } })?.session?.sessionId ?? '');
  expect(sessionId).toBeTruthy();
  const bound = await callExecutionTool(fx.ctx, 'session_bind_repository', {
    session_id: sessionId,
    repo_id: fx.repository.repoId,
  });
  expect(bound?.isError).not.toBe(true);
  const prepared = await callExecutionTool(fx.ctx, 'work_prepare', {
    session_id: sessionId,
    repo_id: fx.repository.repoId,
    objective,
    acceptance_criteria: ['Temporary managed Git resources are removed after delivery or stop.'],
    checks: [],
    isolation: 'new_worktree',
    request_id: `prepare-${objective.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
  });
  expect(prepared?.isError).not.toBe(true);
  return (prepared?.structuredContent as { work: { workId: string; worktreePath: string; branch: string } }).work;
}

function branchExists(root: string, branch: string): boolean {
  return spawnSync('git', ['-C', root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
}

describe('rh_work managed lifecycle closure', () => {
  test('finalize commits, merges, removes the managed worktree, and deletes the branch', async () => {
    const fx = fixture('finalize');
    const work = await prepareManagedWork(fx, 'Add one lifecycle acceptance file');
    writeFileSync(join(work.worktreePath, 'lifecycle.txt'), 'closed-loop\n');

    const finalized = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'finalize',
      work_id: work.workId,
    });
    expect(finalized?.isError).not.toBe(true);
    const payload = finalized?.structuredContent as { status?: string; data?: { lifecycleClosed?: boolean } };
    expect(payload.status).toBe('ok');
    expect(payload.data?.lifecycleClosed).toBe(true);
    expect(readFileSync(join(fx.repoRoot, 'lifecycle.txt'), 'utf8')).toBe('closed-loop\n');
    expect(existsSync(work.worktreePath)).toBe(false);
    expect(branchExists(fx.repoRoot, work.branch)).toBe(false);
  });

  test('stop cancels and automatically removes the managed worktree and branch', async () => {
    const fx = fixture('stop');
    const work = await prepareManagedWork(fx, 'Disposable no-change acceptance Work');

    const stopped = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'stop',
      work_id: work.workId,
      reason: 'acceptance complete',
    });
    expect(stopped?.isError).not.toBe(true);
    const payload = stopped?.structuredContent as { status?: string; data?: { worktreeDeleted?: boolean; cleanupPending?: boolean } };
    expect(payload.status).toBe('ok');
    expect(payload.data?.worktreeDeleted).toBe(true);
    expect(payload.data?.cleanupPending).toBe(false);
    expect(existsSync(work.worktreePath)).toBe(false);
    expect(branchExists(fx.repoRoot, work.branch)).toBe(false);
  });
});
