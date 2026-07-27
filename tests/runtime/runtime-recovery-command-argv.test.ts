import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { submitLocalBridgeJob, executeLocalBridgeJob, getLocalBridgeJob } from '../../src/cli/local-bridge/job-store';
import { executeRepositoryCommand, previewRepositoryCommandExecution } from '../../src/cli/repositories/command-executor';
import { addRepositoryCheckout, consolidateRepositoryRegistry, focusRepository, getRepositoryFocus, loadRepositoryRegistry, registerRepository, resolveRepositorySelection, saveRepositoryRegistry } from '../../src/cli/repositories/registry';
import { getExecutionJob, getExecutionJobByRequestId, removeRequestIndex, transitionExecutionJob, attachExecutionWorker, claimExecutionJobForDispatch } from '../../src/runtime/execution/jobs/store';
import { reconcileControllerStartup } from '../../src/runtime/control-plane/startup-recovery';
import { publishReadyAfterStartupRecovery } from '../../src/runtime/control-plane/daemon-entry';
import { acquireExecutionLeases } from '../../src/runtime/resources/leases/store';
import { repositoryControllerRoot } from '../../src/cli/repositories/controller-home';
import { readJsonFile, writeJsonAtomic } from '../../src/runtime/shared/json-files';
import { markRepositoryProjectionDirty, readRepositoryProjectionDirty } from '../../src/runtime/projections/invalidation';
import { rebuildRepositoryProjection } from '../../src/runtime/projections/materialized-view';
import { createWorkContract, getWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';

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

  test('keeps stable repository selection authoritative until explicit slot Registry consolidation', () => {
    const home = tempRoot('runtime-registry-authority-home-');
    const greenHome = join(home, 'runtime-slots', 'green');
    const root = tempRoot('runtime-registry-authority-repo-');
    const worktreeParent = tempRoot('runtime-registry-authority-worktree-');
    const worktreeRoot = join(worktreeParent, 'stale-green-worktree');
    const repository = seedRepo(home, root, 'stable-authority');
    git(root, ['worktree', 'add', '-b', 'stale-green', worktreeRoot]);

    const staleRegistry = loadRepositoryRegistry(home);
    const staleRepository = staleRegistry.repositories.find((candidate) => candidate.repoId === repository.repoId)!;
    staleRepository.canonicalRoot = worktreeRoot;
    staleRepository.localRoot = worktreeRoot;
    staleRepository.activeCheckoutId = 'checkout_stale_green';
    staleRepository.checkouts.push({
      checkoutId: 'checkout_stale_green',
      localRoot: worktreeRoot,
      canonicalRoot: worktreeRoot,
      worktree: true,
      branch: 'stale-green',
      createdAt: '2026-07-27T01:00:00.000Z',
      updatedAt: '2026-07-27T01:00:00.000Z',
      lastSeenAt: '2026-07-27T01:00:00.000Z',
      lifecycle: 'active',
    });
    staleRegistry.updatedAt = '2026-07-27T01:00:00.000Z';
    mkdirSync(greenHome, { recursive: true });
    writeFileSync(join(greenHome, 'repositories.json'), `${JSON.stringify(staleRegistry, null, 2)}\n`);

    const before = loadRepositoryRegistry(greenHome)
      .repositories.find((candidate) => candidate.repoId === repository.repoId)!;
    const selected = resolveRepositorySelection({ repoId: repository.repoId, controllerHome: greenHome });
    expect(before.activeCheckoutId).toBe(repository.activeCheckoutId);
    expect(before.checkouts.some((checkout) => checkout.checkoutId === 'checkout_stale_green')).toBe(false);
    expect(selected.activeCheckoutId).toBe(repository.activeCheckoutId);
    expect(selected.canonicalRoot).toBe(repository.canonicalRoot);

    const consolidated = consolidateRepositoryRegistry(greenHome)
      .repositories.find((candidate) => candidate.repoId === repository.repoId)!;
    expect(consolidated.activeCheckoutId).toBe(repository.activeCheckoutId);
    expect(consolidated.canonicalRoot).toBe(repository.canonicalRoot);
    expect(consolidated.checkouts.some((checkout) => checkout.checkoutId === 'checkout_stale_green')).toBe(true);
  });

  test('keeps stable repository focus authoritative over newer slot-local focus', () => {
    const home = tempRoot('runtime-focus-authority-home-');
    const greenHome = join(home, 'runtime-slots', 'green');
    const firstRoot = tempRoot('runtime-focus-authority-first-');
    const secondRoot = tempRoot('runtime-focus-authority-second-');
    const first = seedRepo(home, firstRoot, 'focus-first');
    const second = seedRepo(home, secondRoot, 'focus-second');
    focusRepository(first.repoId, home);
    mkdirSync(greenHome, { recursive: true });
    writeFileSync(join(greenHome, 'focus.json'), `${JSON.stringify({
      repoId: second.repoId,
      updatedAt: '2099-01-01T00:00:00.000Z',
    }, null, 2)}\n`);

    expect(getRepositoryFocus(greenHome).repoId).toBe(first.repoId);
  });

  test('cancels reconciled ownerless work after its managed checkout loses Git identity', () => {
    const home = tempRoot('runtime-recovery-work-home-');
    const root = tempRoot('runtime-recovery-work-repo-');
    const worktreeParent = tempRoot('runtime-recovery-worktree-parent-');
    const worktreeRoot = join(worktreeParent, 'orphaned-worktree');
    const repository = seedRepo(home, root, 'orphaned-work');
    git(root, ['worktree', 'add', '-b', 'orphaned-work', worktreeRoot]);
    const withCheckout = addRepositoryCheckout({
      repoId: repository.repoId,
      path: worktreeRoot,
      controllerHome: home,
    });
    const checkout = withCheckout.checkouts.find((candidate) =>
      candidate.checkoutId !== repository.activeCheckoutId && candidate.worktree)!;
    const misleadingNestedRoot = join(root, '_ops', 'controller-home', 'worktrees', 'campaign-orphaned');
    mkdirSync(misleadingNestedRoot, { recursive: true });
    const registry = loadRepositoryRegistry(home);
    const registryRepository = registry.repositories.find((candidate) => candidate.repoId === repository.repoId)!;
    registryRepository.checkouts = registryRepository.checkouts.map((candidate) =>
      candidate.checkoutId === checkout.checkoutId
        ? { ...candidate, localRoot: misleadingNestedRoot, canonicalRoot: misleadingNestedRoot }
        : candidate);
    saveRepositoryRegistry(registry, home);

    createWorkContract({ controllerHome: home, repoId: repository.repoId }, {
      workId: 'work-orphaned-checkout',
      repoId: repository.repoId,
      mode: 'goal_workloop',
      objective: 'Orphaned managed checkout work',
      acceptanceCriteria: [],
      constraints: { requireHandoffOnAmbiguity: true },
      status: 'blocked',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      requestedBy: 'chatgpt',
      evidenceRefs: [{
        title: 'runtime reconciliation required',
        summary: 'Owner disappeared before completion.',
        detailLevel: 'summary',
      }],
      worktreeRef: misleadingNestedRoot,
    });

    const recovered = reconcileControllerStartup(home);
    expect(recovered.repositories.find((entry) => entry.repoId === repository.repoId)?.archivedCheckoutIds)
      .toContain(checkout.checkoutId);
    expect(getWorkContract({ controllerHome: home, repoId: repository.repoId }, 'work-orphaned-checkout')?.status)
      .toBe('cancelled');
  });

  test('consolidates slot Registry history into stable root before retiring an orphaned checkout', () => {
    const home = tempRoot('runtime-recovery-registry-home-');
    const blueHome = join(home, 'runtime-slots', 'blue');
    const root = tempRoot('runtime-recovery-registry-repo-');
    const repository = seedRepo(home, root, 'registry-authority');
    const misleadingNestedRoot = join(root, '_ops', 'controller-home', 'worktrees', 'campaign-slot-orphaned');
    mkdirSync(misleadingNestedRoot, { recursive: true });

    const slotRegistry = loadRepositoryRegistry(home);
    const slotRepository = slotRegistry.repositories.find((candidate) => candidate.repoId === repository.repoId)!;
    slotRepository.checkouts.push({
      checkoutId: 'checkout_slot_orphaned',
      localRoot: misleadingNestedRoot,
      canonicalRoot: misleadingNestedRoot,
      worktree: true,
      branch: 'campaign/slot-orphaned',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      lastSeenAt: '2026-07-01T00:00:00.000Z',
      lifecycle: 'active',
    });
    slotRegistry.updatedAt = '2026-07-01T00:00:00.000Z';
    mkdirSync(blueHome, { recursive: true });
    writeFileSync(join(blueHome, 'repositories.json'), `${JSON.stringify(slotRegistry, null, 2)}\n`);

    createWorkContract({ controllerHome: blueHome, repoId: repository.repoId }, {
      workId: 'work-slot-registry-orphan',
      repoId: repository.repoId,
      mode: 'goal_workloop',
      objective: 'Ownerless work from a slot-only checkout record',
      acceptanceCriteria: [],
      constraints: { requireHandoffOnAmbiguity: true },
      status: 'blocked',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      requestedBy: 'chatgpt',
      evidenceRefs: [{
        title: 'runtime reconciliation required',
        summary: 'Owner disappeared before completion.',
        detailLevel: 'summary',
      }],
      worktreeRef: misleadingNestedRoot,
    });

    const recovered = reconcileControllerStartup(blueHome);
    const consolidated = loadRepositoryRegistry(home)
      .repositories.find((candidate) => candidate.repoId === repository.repoId)!;
    const archived = consolidated.checkouts.find((candidate) => candidate.checkoutId === 'checkout_slot_orphaned');

    expect(recovered.repositories.find((entry) => entry.repoId === repository.repoId)?.archivedCheckoutIds)
      .toContain('checkout_slot_orphaned');
    expect(consolidated.activeCheckoutId).toBe(repository.activeCheckoutId);
    expect(archived?.lifecycle).toBe('archived');
    expect(archived?.lifecycleReason).toContain('no longer a valid Git worktree');
    expect(getWorkContract({ controllerHome: blueHome, repoId: repository.repoId }, 'work-slot-registry-orphan')?.status)
      .toBe('cancelled');
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
