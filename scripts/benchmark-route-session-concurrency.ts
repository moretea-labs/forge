import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { ensureControllerHome } from '../src/cli/repositories/controller-home';
import { registerRepository } from '../src/cli/repositories/registry';
import { createMcpToolContext } from '../src/cli/mcp/server';
import { callMultiRepositoryTool } from '../src/cli/mcp/multi-repository';
import { callRuntimeTool } from '../src/runtime/gateway/mcp/runtime-tools';
import { createWorkContract } from '../src/runtime/control-plane/facade/work-contract-store';
import { executionIdentityForRepository } from '../src/runtime/control-plane/execution/execution-identity';
import { acquireRuntimeOwnership } from '../src/runtime/root/ownership';
import { ensureActiveRuntimeRelease } from '../src/runtime/root/release-store';
import { bindRuntimeWriteClaim, clearRuntimeWriteClaimForTests } from '../src/runtime/root/write-fence';
import {
  acquireCheckoutMutationGate,
  releaseCheckoutMutationGateOwned,
} from '../src/runtime/execution/thin-harness/mutation-gate';
import {
  acquireExecutionLeases,
  releaseExecutionLeases,
} from '../src/runtime/resources/leases/store';
import {
  getProcessHandle,
  spawnManagedProcess,
  waitForProcess,
} from '../src/runtime/execution/process-runtime';

const PHASES = [
  'wallClockMs',
  'queueTimeMs',
  'lockWaitMs',
  'storageTimeMs',
  'gitObservationMs',
  'workerProcessMs',
  'projectionMs',
  'serializationMs',
] as const;
type Phase = (typeof PHASES)[number];
type Outcome = 'success' | 'timeout' | 'contention' | 'failed';
type Phases = Record<Phase, number>;
interface Sample { phases: Phases; outcome: Outcome }

function phases(): Phases {
  return Object.fromEntries(PHASES.map((phase) => [phase, 0])) as Phases;
}
function elapsed(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}
function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return Math.round(sorted[index]! * 100) / 100;
}
function summarize(samples: Sample[]) {
  const rate = (outcome: Outcome) => Math.round(
    samples.filter((sample) => sample.outcome === outcome).length / samples.length * 10_000,
  ) / 10_000;
  const phaseSummary = Object.fromEntries(PHASES.map((phase) => {
    const values = samples.map((sample) => sample.phases[phase]);
    return [phase, {
      p50: percentile(values, 0.50),
      p95: percentile(values, 0.95),
      p99: percentile(values, 0.99),
    }];
  }));
  return {
    samples: samples.length,
    phases: phaseSummary,
    successRate: rate('success'),
    timeoutRate: rate('timeout'),
    contentionRate: rate('contention'),
    failureRate: rate('failed'),
    derivedThresholds: Object.fromEntries(PHASES.map((phase) => {
      const values = samples.map((sample) => sample.phases[phase]);
      const p95 = percentile(values, 0.95);
      const p99 = percentile(values, 0.99);
      return [phase, Math.max(1, Math.ceil(Math.max(p99 * 1.25, p95 * 1.5)))];
    })),
  };
}
function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
}
function bindBenchmarkRuntime(controllerHome: string): void {
  const manifestPath = join(controllerHome, 'benchmark-runtime.manifest.json');
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    releaseId: 'benchmark-runtime-release',
    artifactIdentity: 'benchmark-runtime-artifact',
    entrypoint: 'forge-runtime',
    arguments: [],
    configurationSchemaVersion: 1,
    controllerHome,
    databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
    workerProtocolVersion: 1,
    createdAt: new Date().toISOString(),
  }));
  const owner = acquireRuntimeOwnership(controllerHome, 'benchmark-runtime');
  const authority = ensureActiveRuntimeRelease(controllerHome, manifestPath);
  bindRuntimeWriteClaim({ controllerHome, owner: owner.record, authority });
}

function repositoryFixture(root: string, controllerHome: string, name: string) {
  const repoRoot = join(root, name);
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Benchmark']);
  git(repoRoot, ['config', 'user.email', 'benchmark@example.com']);
  writeFileSync(join(repoRoot, 'README.md'), `${name}\n`);
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'init']);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: name });
  return {
    repoRoot,
    repository,
    context: createMcpToolContext({ controllerHome, profile: 'controller', repo: repoRoot }),
  };
}
async function guarded(operation: () => Promise<Sample>): Promise<Sample> {
  try {
    return await operation();
  } catch {
    return { phases: phases(), outcome: 'failed' };
  }
}

async function main(): Promise<void> {
  const iterationsIndex = process.argv.indexOf('--iterations');
  const outputIndex = process.argv.indexOf('--output');
  const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1]?.trim() : undefined;
  const iterations = Math.max(1, Number(iterationsIndex >= 0 ? process.argv[iterationsIndex + 1] : 7) || 7);
  const root = mkdtempSync(join(tmpdir(), 'route-session-concurrency-'));
  const controllerHome = ensureControllerHome(join(root, 'controller'));
  try {
    bindBenchmarkRuntime(controllerHome);
    const first = repositoryFixture(root, controllerHome, 'repository-a');
    const second = repositoryFixture(root, controllerHome, 'repository-b');
    const results = new Map<string, Sample[]>();
    const run = async (name: string, operation: () => Promise<Sample>) => {
      results.set(name, [...(results.get(name) ?? []), await guarded(operation)]);
    };

    for (let index = 0; index < iterations; index += 1) {
      await run('context_cold_read', async () => {
        const timing = phases();
        const started = performance.now();
        const projectionStarted = performance.now();
        const value = await callRuntimeTool(first.context, 'controller_context_pack', {
          repo_id: first.repository.repoId,
          variant: 'summary',
          force_refresh: true,
        });
        timing.projectionMs = elapsed(projectionStarted);
        timing.gitObservationMs = timing.projectionMs;
        const serializationStarted = performance.now();
        JSON.stringify(value);
        timing.serializationMs = elapsed(serializationStarted);
        timing.wallClockMs = elapsed(started);
        return { phases: timing, outcome: value?.isError ? 'failed' : 'success' };
      });

      await run('context_warm_read', async () => {
        const timing = phases();
        const started = performance.now();
        const projectionStarted = performance.now();
        const value = await callRuntimeTool(first.context, 'controller_context_pack', {
          repo_id: first.repository.repoId,
          variant: 'summary',
        });
        timing.projectionMs = elapsed(projectionStarted);
        const serializationStarted = performance.now();
        JSON.stringify(value);
        timing.serializationMs = elapsed(serializationStarted);
        timing.wallClockMs = elapsed(started);
        return { phases: timing, outcome: value?.isError ? 'failed' : 'success' };
      });

      await run('requirement_board_read', async () => {
        const timing = phases();
        const started = performance.now();
        const storageStarted = performance.now();
        const value = await callMultiRepositoryTool(first.context, 'get_project_board', {
          repo_id: first.repository.repoId,
        });
        timing.storageTimeMs = elapsed(storageStarted);
        timing.wallClockMs = elapsed(started);
        return { phases: timing, outcome: value.isError ? 'failed' : 'success' };
      });

      await run('work_prepare', async () => {
        const timing = phases();
        const started = performance.now();
        const storageStarted = performance.now();
        createWorkContract({ controllerHome, repoId: first.repository.repoId }, {
          workId: `BENCH-WORK-${index}`,
          repoId: first.repository.repoId,
          mode: 'direct_control',
          objective: 'Measure durable Work preparation.',
          acceptanceCriteria: ['Prepared'],
          allowedPaths: [],
          forbiddenPaths: [],
          checks: [],
          constraints: { requireHandoffOnAmbiguity: true },
          requestedBy: 'chatgpt',
          status: 'open',
        });
        timing.storageTimeMs = elapsed(storageStarted);
        timing.wallClockMs = elapsed(started);
        return { phases: timing, outcome: 'success' };
      });

      await run('direct_edit_claim', async () => {
        const timing = phases();
        const started = performance.now();
        const lockStarted = performance.now();
        const claim = await acquireCheckoutMutationGate({
          controllerHome,
          repoId: first.repository.repoId,
          checkoutId: first.repository.activeCheckoutId,
          repoRoot: first.repoRoot,
          owner: `benchmark-direct-${index}`,
          ownerIdentity: {
            repositoryId: first.repository.repoId,
            checkoutId: first.repository.activeCheckoutId,
            worktreeId: first.repository.activeCheckoutId,
            branch: 'main',
            principalId: 'benchmark',
            controllerInstanceId: 'benchmark-controller',
            controllerGeneration: 'benchmark-generation',
          },
        });
        timing.lockWaitMs = elapsed(lockStarted);
        timing.wallClockMs = elapsed(started);
        if ('acquired' in claim && claim.acquired) {
          releaseCheckoutMutationGateOwned(controllerHome, claim.gate);
          return { phases: timing, outcome: 'success' };
        }
        return { phases: timing, outcome: 'contention' };
      });

      await run('durable_job_submit', async () => {
        const timing = phases();
        const started = performance.now();
        const queueStarted = performance.now();
        const handle = await spawnManagedProcess({
          controllerHome,
          repoId: first.repository.repoId,
          checkoutId: first.repository.activeCheckoutId,
          executionIdentity: executionIdentityForRepository(first.repository),
          commandId: `benchmark-submit-${index}`,
          origin: { surface: 'system', requestId: `benchmark-submit-${index}` },
          command: {
            kind: 'argv',
            executable: process.execPath,
            args: ['-e', 'setTimeout(() => process.exit(0), 20)'],
            cwd: first.repoRoot,
          },
          interactiveWaitMs: 1,
          timeoutMs: 5_000,
        });
        timing.queueTimeMs = elapsed(queueStarted);
        timing.wallClockMs = elapsed(started);
        const completed = await waitForProcess(controllerHome, first.repository.repoId, handle.processId, { timeoutMs: 5_000 });
        return { phases: timing, outcome: completed.ok ? 'success' : completed.timedOut ? 'timeout' : 'failed' };
      });

      await run('process_start', async () => {
        const timing = phases();
        const started = performance.now();
        const processStarted = performance.now();
        const handle = await spawnManagedProcess({
          controllerHome,
          repoId: first.repository.repoId,
          checkoutId: first.repository.activeCheckoutId,
          executionIdentity: executionIdentityForRepository(first.repository),
          commandId: `benchmark-process-${index}`,
          origin: { surface: 'system', requestId: `benchmark-process-${index}` },
          command: {
            kind: 'argv',
            executable: process.execPath,
            args: ['-e', 'process.exit(0)'],
            cwd: first.repoRoot,
          },
          interactiveWaitMs: 5_000,
          timeoutMs: 5_000,
        });
        timing.workerProcessMs = elapsed(processStarted);
        timing.wallClockMs = elapsed(started);
        return { phases: timing, outcome: handle.ok ? 'success' : handle.timedOut ? 'timeout' : 'failed' };
      });

      await run('check_completion', async () => {
        const timing = phases();
        const started = performance.now();
        const processStarted = performance.now();
        const handle = await spawnManagedProcess({
          controllerHome,
          repoId: first.repository.repoId,
          checkoutId: first.repository.activeCheckoutId,
          executionIdentity: executionIdentityForRepository(first.repository),
          commandId: `benchmark-check-${index}`,
          origin: { surface: 'check', requestId: `benchmark-check-${index}`, checkId: 'benchmark' },
          command: {
            kind: 'argv',
            executable: process.execPath,
            args: ['-e', 'setTimeout(() => process.exit(0), 10)'],
            cwd: first.repoRoot,
          },
          interactiveWaitMs: 1,
          timeoutMs: 5_000,
        });
        const completed = await waitForProcess(controllerHome, first.repository.repoId, handle.processId, { timeoutMs: 5_000 });
        timing.workerProcessMs = elapsed(processStarted);
        timing.wallClockMs = elapsed(started);
        return { phases: timing, outcome: completed.ok ? 'success' : completed.timedOut ? 'timeout' : 'failed' };
      });

      await run('concurrent_two_repository_load', async () => {
        const timing = phases();
        const started = performance.now();
        const projectionStarted = performance.now();
        const values = await Promise.all([
          callRuntimeTool(first.context, 'controller_context_pack', { repo_id: first.repository.repoId, variant: 'summary' }),
          callRuntimeTool(second.context, 'controller_context_pack', { repo_id: second.repository.repoId, variant: 'summary' }),
        ]);
        timing.projectionMs = elapsed(projectionStarted);
        timing.wallClockMs = elapsed(started);
        return { phases: timing, outcome: values.some((value) => value?.isError) ? 'failed' : 'success' };
      });

      await run('same_repository_different_checkout_load', async () => {
        const timing = phases();
        const started = performance.now();
        const lockStarted = performance.now();
        const ownerA = `benchmark-checkout-a-${index}`;
        const ownerB = `benchmark-checkout-b-${index}`;
        const leaseA = acquireExecutionLeases(controllerHome, first.repository.repoId, ownerA, [
          { repoId: first.repository.repoId, checkoutId: 'checkout-a', resourceKey: 'workspace:checkout-a', mode: 'write' },
        ], { ttlMs: 5_000 });
        const leaseB = acquireExecutionLeases(controllerHome, first.repository.repoId, ownerB, [
          { repoId: first.repository.repoId, checkoutId: 'checkout-b', resourceKey: 'workspace:checkout-b', mode: 'write' },
        ], { ttlMs: 5_000 });
        timing.lockWaitMs = elapsed(lockStarted);
        timing.wallClockMs = elapsed(started);
        releaseExecutionLeases(controllerHome, first.repository.repoId, ownerA);
        releaseExecutionLeases(controllerHome, first.repository.repoId, ownerB);
        return { phases: timing, outcome: leaseA.acquired && leaseB.acquired ? 'success' : 'contention' };
      });

      await run('same_checkout_contention', async () => {
        const timing = phases();
        const started = performance.now();
        const lockStarted = performance.now();
        const owner = `benchmark-live-${index}`;
        const live = acquireExecutionLeases(controllerHome, first.repository.repoId, owner, [
          { repoId: first.repository.repoId, checkoutId: 'checkout-one', resourceKey: 'workspace:checkout-one', mode: 'write' },
        ], { ttlMs: 5_000 });
        const blocked = acquireExecutionLeases(controllerHome, first.repository.repoId, `benchmark-blocked-${index}`, [
          { repoId: first.repository.repoId, checkoutId: 'checkout-one', resourceKey: 'workspace:checkout-one', mode: 'write' },
        ], { ttlMs: 5_000 });
        timing.lockWaitMs = elapsed(lockStarted);
        timing.wallClockMs = elapsed(started);
        releaseExecutionLeases(controllerHome, first.repository.repoId, owner);
        return { phases: timing, outcome: live.acquired && !blocked.acquired ? 'contention' : 'failed' };
      });

      await run('gateway_restart_recovery', async () => {
        const timing = phases();
        const started = performance.now();
        const processStarted = performance.now();
        const handle = await spawnManagedProcess({
          controllerHome,
          repoId: second.repository.repoId,
          checkoutId: second.repository.activeCheckoutId,
          executionIdentity: executionIdentityForRepository(second.repository),
          commandId: `benchmark-recovery-${index}`,
          origin: { surface: 'system', requestId: `benchmark-recovery-${index}` },
          command: {
            kind: 'argv',
            executable: process.execPath,
            args: ['-e', 'setTimeout(() => process.exit(0), 25)'],
            cwd: second.repoRoot,
          },
          interactiveWaitMs: 1,
          timeoutMs: 5_000,
        });
        const storageStarted = performance.now();
        const persisted = getProcessHandle(controllerHome, second.repository.repoId, handle.processId);
        timing.storageTimeMs = elapsed(storageStarted);
        const completed = await waitForProcess(controllerHome, second.repository.repoId, handle.processId, { timeoutMs: 5_000 });
        timing.workerProcessMs = elapsed(processStarted);
        timing.wallClockMs = elapsed(started);
        return { phases: timing, outcome: persisted && completed.ok ? 'success' : completed.timedOut ? 'timeout' : 'failed' };
      });
    }

    const report = {
      schemaVersion: 1,
      measuredAt: new Date().toISOString(),
      iterations,
      thresholdPolicy: 'max(1ms, observed p99 * 1.25, observed p95 * 1.5)',
      notes: {
        durableJobSubmit: 'ExecutionJob creation is retired; this measures durable Process admission and persistence.',
        gatewayRestartRecovery: 'A fresh Process store read is performed before terminal completion.',
      },
      scenarios: Object.fromEntries([...results].map(([name, samples]) => [name, summarize(samples)])),
    };
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (outputPath) {
      mkdirSync(join(outputPath, '..'), { recursive: true });
      writeFileSync(outputPath, serialized);
    }
    process.stdout.write(serialized);
  } finally {
    clearRuntimeWriteClaimForTests();
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
