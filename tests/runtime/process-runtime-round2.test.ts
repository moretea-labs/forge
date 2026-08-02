import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerRepository } from '../../src/cli/repositories/registry';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { executionIdentityForRepository } from '../../src/runtime/control-plane/execution/execution-identity';
import {
  __resetLiveMonitorsForTests,
  processRuntimeResourceDiagnostics,
  spawnManagedProcess,
  waitForProcess,
} from '../../src/runtime/execution/process-runtime';

const roots: string[] = [];

afterEach(() => {
  __resetLiveMonitorsForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-process-round2-'));
  roots.push(root);
  const repoRoot = join(root, 'repo');
  const controllerHome = join(root, 'controller');
  mkdirSync(repoRoot, { recursive: true });
  ensureControllerHome(controllerHome);
  writeFileSync(join(repoRoot, 'README.md'), 'round2\n');
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'round2'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'round2@example.test'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['commit', '-m', 'round2'], { cwd: repoRoot, stdio: 'ignore' });
  const repository = registerRepository({ path: repoRoot, controllerHome });
  return { repoRoot, controllerHome, repository };
}

describe('process runtime round two resource lifecycle', () => {
  test('terminal process releases monitor, log poller, timeout and waiters', async () => {
    const fx = fixture();
    const started = await spawnManagedProcess({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      executionIdentity: executionIdentityForRepository(fx.repository),
      command: {
        kind: 'argv',
        executable: 'node',
        args: ['-e', 'setTimeout(() => process.exit(0), 250)'],
        cwd: fx.repoRoot,
      },
      interactiveWaitMs: 0,
      timeoutMs: 5_000,
    });
    const active = processRuntimeResourceDiagnostics();
    expect(active.monitorCount).toBe(1);
    // Attached runners stream redacted chunks over pipes; the disk-log poller
    // is only a legacy fallback and is never active for new runners.
    expect(active.logPollerCount).toBe(0);
    expect(active.timeoutCount).toBe(1);
    await waitForProcess(fx.controllerHome, fx.repository.repoId, started.processId, { timeoutMs: 5_000 });
    await Bun.sleep(30);
    expect(processRuntimeResourceDiagnostics()).toMatchObject({
      monitorCount: 0,
      logPollerCount: 0,
      timeoutCount: 0,
      waiterCount: 0,
      activeProcessIds: [],
    });
  });
});
