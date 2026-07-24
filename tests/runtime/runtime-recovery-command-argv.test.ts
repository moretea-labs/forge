import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { submitLocalBridgeJob, executeLocalBridgeJob, getLocalBridgeJob } from '../../src/cli/local-bridge/job-store';
import { executeRepositoryCommand, previewRepositoryCommandExecution } from '../../src/cli/repositories/command-executor';
import { loadRepositoryRegistry, registerRepository, saveRepositoryRegistry } from '../../src/cli/repositories/registry';
import { getExecutionJob, getExecutionJobByRequestId, removeRequestIndex, transitionExecutionJob, attachExecutionWorker, claimExecutionJobForDispatch } from '../../src/runtime/execution/jobs/store';
import { reconcileControllerStartup } from '../../src/runtime/control-plane/startup-recovery';
import { publishReadyAfterStartupRecovery } from '../../src/runtime/control-plane/daemon-entry';
import { acquireExecutionLeases } from '../../src/runtime/resources/leases/store';
import { repositoryControllerRoot } from '../../src/cli/repositories/controller-home';
import { readJsonFile, writeJsonAtomic } from '../../src/runtime/shared/json-files';
import { markRepositoryProjectionDirty, readRepositoryProjectionDirty } from '../../src/runtime/projections/invalidation';
import { rebuildRepositoryProjection } from '../../src/runtime/projections/materialized-view';

const roots: string[] = [];
const daemonPids: number[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
}

function seedRepo(controllerHome: string, root: string, name: string) {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Runtime Recovery Test']);
  git(root, ['config', 'user.email', 'runtime-recovery@example.com']);
  writeFileSync(join(root, 'tracked.txt'), `${name}\n`);
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '-m', 'init']);
  return registerRepository({ path: root, controllerHome, displayName: name });
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(25);
  }
  throw new Error('timed out waiting for runtime state');
}

afterEach(() => {
  for (const pid of daemonPids.splice(0)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('runtime recovery and repository argv boundary', () => {
  test('executes typed argv with spaces, commas, and quotes and keeps preview/execute digests equal', () => {
    const home = tempRoot('runtime-argv-home-');
    const root = tempRoot('runtime-argv-repo-');
    const repository = seedRepo(home, root, 'argv');
    const command = ['/usr/bin/printf', '%s|%s|%s\n', 'embedded space', 'comma,value', 'quote"value'];
    const preview = previewRepositoryCommandExecution(repository, { command, dryRun: true }, home);
    const execution = executeRepositoryCommand(home, repository, {
      command,
      authorization: 'confirmed_plan',
      approvalToken: preview.execution.approvalToken});
    expect(preview.execution.command).toEqual(command);
    expect(execution.command).toEqual(command);
    expect(execution.approvalToken).toBe(preview.execution.approvalToken);
    expect(execution.stdout).toBe('embedded space|comma,value|quote"value\n');
  });

  test('rejects invalid command types and non-string argv members with COMMAND_INVALID', () => {
    const home = tempRoot('runtime-argv-invalid-home-');
    const root = tempRoot('runtime-argv-invalid-repo-');
    const repository = seedRepo(home, root, 'invalid');
    expect(() => previewRepositoryCommandExecution(repository, { command: 42 as unknown as string }, home)).toThrow('COMMAND_INVALID: command must be a shell string or argv string array');
    expect(() => previewRepositoryCommandExecution(repository, { command: ['printf', 42] as unknown as string[] }, home)).toThrow('COMMAND_INVALID: argv[1] must be a string');
    expect(() => previewRepositoryCommandExecution(repository, { command: ['/bin/sh', '-c', 'git status'] }, home)).toThrow('COMMAND_POLICY_DENIED: nested shell execution is not allowed');
  });

  test('skips projection rebuild during startup recovery when persisted state is already clean', () => {
    const home = tempRoot('runtime-recovery-clean-projection-home-');
    const root = tempRoot('runtime-recovery-clean-projection-repo-');
    const repository = seedRepo(home, root, 'clean-projection');
    const persisted = rebuildRepositoryProjection(home, repository.repoId);
    const projectionPath = join(repositoryControllerRoot(home, repository.repoId), 'projections', 'runtime.json');

    const recovered = reconcileControllerStartup(home);
    const repoRecovery = recovered.repositories.find((entry) => entry.repoId === repository.repoId);
    const after = readJsonFile<{ revision: number }>(projectionPath);

    expect(repoRecovery?.projectionRebuilt).toBe(false);
    expect(after.revision).toBe(persisted.revision);
  });

  test('persists starting before recovery and ready only after recovery returns', () => {
    const home = tempRoot('runtime-recovery-order-home-');
    const events: string[] = [];
    const recovery = publishReadyAfterStartupRecovery(home, new Date().toISOString(), (controllerHome) => {
      events.push(readJsonFile<{ status: string }>(join(controllerHome, 'daemon', 'state.json')).status);
      return { completedAt: new Date().toISOString(), repositories: [], errors: [], degraded: false };
    });
    events.push(readJsonFile<{ status: string }>(join(home, 'daemon', 'state.json')).status);
    expect(events).toEqual(['starting', 'ready']);
    expect(recovery.degraded).toBe(false);
  });

  test('isolates one broken repository and reports degraded structured recovery', () => {
    const home = tempRoot('runtime-recovery-isolation-home-');
    const healthyRoot = tempRoot('runtime-recovery-healthy-repo-');
    const brokenRoot = tempRoot('runtime-recovery-broken-repo-');
    const healthy = seedRepo(home, healthyRoot, 'healthy');
    const broken = seedRepo(home, brokenRoot, 'broken');
    const registry = loadRepositoryRegistry(home);
    const brokenEntry = registry.repositories.find((entry) => entry.repoId === broken.repoId)!;
    brokenEntry.canonicalRoot = join(brokenRoot, 'tracked.txt');
    saveRepositoryRegistry(registry, home);
    const result = reconcileControllerStartup(home);
    expect(result.degraded).toBe(true);
    expect(result.repositories.map((entry) => entry.repoId)).toContain(healthy.repoId);
    expect(result.errors.find((entry) => entry.repoId === broken.repoId)?.code).toBeTruthy();
  });
});
