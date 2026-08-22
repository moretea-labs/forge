import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { ensureControllerHome } from '../src/cli/repositories/controller-home';
import {
  addRepositoryCheckout,
  registerRepository,
  selectRepositoryCheckout,
} from '../src/cli/repositories/registry';
import { createMcpToolContext } from '../src/cli/mcp/server';
import { callMultiRepositoryTool } from '../src/cli/mcp/multi-repository';
import { callRuntimeTool } from '../src/runtime/gateway/mcp/runtime-tools';
import { createWorkContract } from '../src/runtime/control-plane/facade/work-contract-store';
import { createRequirement } from '../src/runtime/control-plane/persistence/requirement-store';
import { startGoalWorkloop } from '../src/runtime/control-plane/facade/goal-workloop';
import { withPrimaryWorkAdmissionLockAsync } from '../src/runtime/control-plane/facade/semantic-admission';
import { executionIdentityForRepository } from '../src/runtime/control-plane/execution/execution-identity';
import { acquireRuntimeOwnership } from '../src/runtime/root/ownership';
import { ensureActiveRuntimeRelease } from '../src/runtime/root/release-store';
import { bindRuntimeWriteClaim, clearRuntimeWriteClaimForTests } from '../src/runtime/root/write-fence';
import {
  acquireCheckoutMutationGate,
  releaseCheckoutMutationGateOwned,
} from '../src/runtime/execution/thin-harness/mutation-gate';
import {
  getProcessHandle,
  spawnManagedProcess,
  waitForProcess,
} from '../src/runtime/execution/process-runtime';
import { controllerCheckExecutionIdentity } from '../src/cli/controller/check-runner';

const PHASES = [
  'wallClockMs',
  'queueTimeMs',
  'lockWaitMs',
  'leaseWaitMs',
  'storageTimeMs',
  'gitObservationMs',
  'workerProcessMs',
  'projectionMs',
  'serializationMs',
] as const;
type Phase = (typeof PHASES)[number];
type Outcome = 'success' | 'timeout' | 'contention' | 'failed';
type Phases = Record<Phase, number>;
interface Sample {
  phases: Phases;
  outcome: Outcome;
  metrics?: Record<string, number>;
}

interface SemanticAdmissionWorkerResult {
  index: number;
  requirementId: string;
  status: string;
  decision: string;
  created: boolean;
  authorityWorkId?: string;
  criticalSectionMs: number;
  criticalSectionCpuMs: number;
  totalAdmissionMs: number;
}

interface SemanticAdmissionBurstResult {
  controllers: number;
  createdAuthorities: number;
  uniqueAuthorityCount: number;
  deterministicResolutions: number;
  criticalSectionP50Ms: number;
  criticalSectionP95Ms: number;
  criticalSectionCpuP95Ms: number;
  totalAdmissionP95Ms: number;
  success: boolean;
}

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
    metrics: Object.fromEntries([...new Set(samples.flatMap((sample) => Object.keys(sample.metrics ?? {})))]
      .sort()
      .map((key) => [key, samples.reduce((total, sample) => total + (sample.metrics?.[key] ?? 0), 0)])),
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
  writeFileSync(join(repoRoot, '.gitignore'), '.benchmark/\n.forge/repository.json\n.ai/harness/checks/\n');
  mkdirSync(join(repoRoot, '.forge'), { recursive: true });
  writeFileSync(join(repoRoot, '.forge', 'checks.json'), `${JSON.stringify({
    version: 1,
    checks: {
      'benchmark:semantic': {
        description: 'Content-bound benchmark check',
        command: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 100)'],
        timeoutMs: 10_000,
        effects: { reads: ['.'], temp: 'isolated', git: 'read' },
      },
    },
  }, null, 2)}\n`);
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'init']);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: name });
  return {
    repoRoot,
    repository,
    context: createMcpToolContext({ controllerHome, profile: 'controller', repo: repoRoot }),
  };
}

function worktreeFixture(
  root: string,
  controllerHome: string,
  source: ReturnType<typeof repositoryFixture>,
) {
  const repoRoot = join(root, 'repository-a-isolated');
  git(source.repoRoot, ['worktree', 'add', '-b', 'benchmark-isolated', repoRoot, 'HEAD']);
  const withCheckout = addRepositoryCheckout({
    controllerHome,
    repoId: source.repository.repoId,
    path: repoRoot,
    activate: false,
  });
  const checkout = withCheckout.checkouts.find((entry) => entry.worktree && entry.branch === 'benchmark-isolated');
  if (!checkout) throw new Error('benchmark worktree checkout registration failed');
  return {
    repoRoot,
    repository: selectRepositoryCheckout(withCheckout, checkout.checkoutId),
  };
}

function physicalCommand(marker: string, output: string, delayMs = 80) {
  return {
    kind: 'argv' as const,
    executable: process.execPath,
    args: ['-e', `const fs=require('fs'); fs.mkdirSync('.benchmark',{recursive:true}); setTimeout(()=>{fs.writeFileSync(${JSON.stringify(marker)},${JSON.stringify(output)}); process.stdout.write(${JSON.stringify(output)});},${delayMs})`],
  };
}
async function guarded(operation: () => Promise<Sample>): Promise<Sample> {
  try {
    return await operation();
  } catch {
    return { phases: phases(), outcome: 'failed' };
  }
}

function cliValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

async function semanticAdmissionWorker(): Promise<void> {
  const controllerHome = cliValue('--controller-home');
  const repoId = cliValue('--repo-id');
  const storeRoot = cliValue('--store-root');
  const requirementId = cliValue('--requirement-id');
  const mode = cliValue('--semantic-mode');
  const index = Number(cliValue('--worker-index'));
  const startAt = Number(cliValue('--start-at'));
  if (!controllerHome || !repoId || !storeRoot || !requirementId || !['same', 'independent'].includes(mode ?? '') || !Number.isFinite(index) || !Number.isFinite(startAt)) {
    throw new Error('semantic admission worker arguments are incomplete');
  }
  const delayMs = Math.max(0, startAt - Date.now());
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  let criticalSectionMs = 0;
  let criticalSectionCpuMs = 0;
  const started = performance.now();
  const facade = await withPrimaryWorkAdmissionLockAsync({ controllerHome, repoId }, () => {
    const entered = performance.now();
    const cpuEntered = process.cpuUsage();
    const value = startGoalWorkloop({
      workStore: { controllerHome, repoId },
      handoffStore: { root: join(storeRoot, 'handoff') },
      repoId,
      checkoutId: `semantic-${mode}-${index}`,
      principalId: `semantic-principal-${index}`,
      controllerInstanceId: `semantic-controller-${index}`,
      sourceRevision: 'semantic-admission-benchmark',
      semanticAdmissionLocked: true,
    }, {
      objective: mode === 'same'
        ? 'Own the semantic admission benchmark requirement'
        : `Own independent semantic admission requirement ${index}`,
      requirementId,
      requestedBy: 'chatgpt',
      modeInput: {
        scopeClear: true,
        mutation: true,
        expectedFiles: 4,
        expectedChangedLines: 200,
        requiresRecovery: true,
        risk: 'local_repo_write',
      },
    });
    criticalSectionMs = elapsed(entered);
    const cpuElapsed = process.cpuUsage(cpuEntered);
    criticalSectionCpuMs = (cpuElapsed.user + cpuElapsed.system) / 1_000;
    return value;
  });
  const data = facade.data && typeof facade.data === 'object' ? facade.data as Record<string, unknown> : {};
  const work = data.work && typeof data.work === 'object' ? data.work as Record<string, unknown> : undefined;
  const recommendedWork = data.recommendedWork && typeof data.recommendedWork === 'object' ? data.recommendedWork as Record<string, unknown> : undefined;
  const candidates = Array.isArray(data.candidates) ? data.candidates as Record<string, unknown>[] : [];
  const authorityWorkId = [work?.workId, recommendedWork?.workId, candidates[0]?.workId]
    .find((value): value is string => typeof value === 'string' && value.length > 0);
  const result: SemanticAdmissionWorkerResult = {
    index,
    requirementId,
    status: facade.status,
    decision: typeof data.admissionDecision === 'string'
      ? data.admissionDecision
      : data.workContractCreated === true ? 'create_new' : 'unknown',
    created: data.workContractCreated === true,
    ...(authorityWorkId ? { authorityWorkId } : {}),
    criticalSectionMs: Math.round(criticalSectionMs * 1000) / 1000,
    criticalSectionCpuMs: Math.round(criticalSectionCpuMs * 1000) / 1000,
    totalAdmissionMs: Math.round(elapsed(started) * 1000) / 1000,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function runSemanticAdmissionBurst(input: {
  controllerHome: string;
  repoId: string;
  storeRoot: string;
  mode: 'same' | 'independent';
  controllers?: number;
}): Promise<SemanticAdmissionBurstResult> {
  const controllers = input.controllers ?? 32;
  mkdirSync(input.storeRoot, { recursive: true });
  const startAt = Date.now() + 1_500;
  const scriptPath = process.argv[1]!;
  const children = Array.from({ length: controllers }, (_, index) => {
    const requirementId = input.mode === 'same'
      ? 'REQ-semantic-admission-benchmark-shared'
      : `REQ-semantic-admission-benchmark-${index}`;
    return Bun.spawn([
      process.execPath,
      scriptPath,
      '--semantic-admission-worker',
      '--controller-home', input.controllerHome,
      '--repo-id', input.repoId,
      '--store-root', input.storeRoot,
      '--requirement-id', requirementId,
      '--semantic-mode', input.mode,
      '--worker-index', String(index),
      '--start-at', String(startAt),
    ], { stdout: 'pipe', stderr: 'pipe' });
  });
  const rows = await Promise.all(children.map(async (child) => {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`semantic admission worker failed (${exitCode}): ${stderr || stdout}`);
    return JSON.parse(stdout.trim()) as SemanticAdmissionWorkerResult;
  }));
  const createdAuthorities = rows.filter((row) => row.created).length;
  const authorityIds = new Set(rows.map((row) => row.authorityWorkId).filter((value): value is string => Boolean(value)));
  const deterministicResolutions = rows.filter((row) => row.created || row.decision === 'reuse_existing' || row.decision === 'resolution_required').length;
  const criticalValues = rows.map((row) => row.criticalSectionMs);
  const success = input.mode === 'same'
    ? createdAuthorities === 1 && authorityIds.size === 1 && deterministicResolutions === controllers
    : createdAuthorities === controllers && authorityIds.size === controllers && deterministicResolutions === controllers;
  return {
    controllers,
    createdAuthorities,
    uniqueAuthorityCount: authorityIds.size,
    deterministicResolutions,
    criticalSectionP50Ms: percentile(criticalValues, 0.50),
    criticalSectionP95Ms: percentile(criticalValues, 0.95),
    criticalSectionCpuP95Ms: percentile(rows.map((row) => row.criticalSectionCpuMs), 0.95),
    totalAdmissionP95Ms: percentile(rows.map((row) => row.totalAdmissionMs), 0.95),
    success,
  };
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
    const firstIsolated = worktreeFixture(root, controllerHome, first);
    createRequirement({ controllerHome }, {
      requirementId: 'REQ-semantic-admission-benchmark-shared',
      title: 'Semantic admission benchmark shared authority',
      outcomeStatement: 'Measure deterministic concurrent admission for one shared Requirement authority.',
    });
    for (let index = 0; index < 32; index += 1) {
      createRequirement({ controllerHome }, {
        requirementId: `REQ-semantic-admission-benchmark-${index}`,
        title: `Semantic admission benchmark independent authority ${index}`,
        outcomeStatement: 'Measure deterministic concurrent admission for an independent Requirement authority.',
      });
    }
    const sameAuthorityAdmission = await runSemanticAdmissionBurst({ controllerHome, repoId: first.repository.repoId, storeRoot: join(root, 'semantic-same-authority'), mode: 'same' });
    const independentRequirementAdmission = await runSemanticAdmissionBurst({ controllerHome, repoId: first.repository.repoId, storeRoot: join(root, 'semantic-independent-requirements'), mode: 'independent' });
    const semanticAdmissionCriticalP95Ms = Math.max(sameAuthorityAdmission.criticalSectionP95Ms, independentRequirementAdmission.criticalSectionP95Ms);
    const semanticAdmission = {
      sameAuthority: sameAuthorityAdmission,
      independentRequirements: independentRequirementAdmission,
      acceptance: {
        minimumControllers: 32,
        criticalSectionP95ThresholdMs: 10,
        criticalSectionP95TargetMs: 5,
        observedCriticalSectionP95Ms: semanticAdmissionCriticalP95Ms,
        passed: sameAuthorityAdmission.success
          && independentRequirementAdmission.success
          && semanticAdmissionCriticalP95Ms <= 10,
      },
    };
    const results = new Map<string, Sample[]>();
    const run = async (name: string, operation: () => Promise<Sample>) => {
      results.set(name, [...(results.get(name) ?? []), await guarded(operation)]);
    };

    for (let index = 0; index < iterations; index += 1) {
      await run('context_cold_read', async () => {
        const timing = phases();
        const started = performance.now();
        const projectionStarted = performance.now();
        const value = await callRuntimeTool(first.context, 'rh_context', {
          repo_id: first.repository.repoId,
          operation: 'search',
          query: 'benchmark repository context cold read',
          structural_context: 'off',
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
        const value = await callRuntimeTool(first.context, 'rh_context', {
          repo_id: first.repository.repoId,
          operation: 'search',
          query: 'benchmark repository context cold read',
          structural_context: 'off',
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

      await run('known_long_process_handle_return', async () => {
        const timing = phases();
        const started = performance.now();
        const handle = await spawnManagedProcess({
          controllerHome,
          repoId: first.repository.repoId,
          checkoutId: first.repository.activeCheckoutId,
          executionIdentity: executionIdentityForRepository(first.repository),
          commandId: `benchmark-long-${index}`,
          origin: { surface: 'system', requestId: `benchmark-long-${index}` },
          command: {
            kind: 'argv',
            executable: process.execPath,
            args: ['-e', 'setTimeout(() => process.exit(0), 250)'],
            cwd: first.repoRoot,
          },
          interactiveWaitMs: 1,
          timeoutMs: 5_000,
          returnHandleImmediately: true,
        });
        timing.wallClockMs = elapsed(started);
        const completed = await waitForProcess(controllerHome, first.repository.repoId, handle.processId, { timeoutMs: 5_000 });
        return { phases: timing, outcome: handle.completed === false && completed.ok ? 'success' : 'failed' };
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
        const queueStarted = performance.now();
        const markerA = `.benchmark/multi-a-${index}.txt`;
        const markerB = `.benchmark/multi-b-${index}.txt`;
        const [handleA, handleB] = await Promise.all([
          spawnManagedProcess({
            controllerHome,
            repoId: first.repository.repoId,
            checkoutId: first.repository.activeCheckoutId,
            executionIdentity: executionIdentityForRepository(first.repository),
            commandId: `benchmark-multi-a-${index}`,
            origin: { surface: 'system', requestId: `benchmark-multi-a-${index}` },
            command: { ...physicalCommand(markerA, `repo-a-${index}`), cwd: first.repoRoot },
            resourceClaims: [{ resourceKey: `workspace:${first.repository.activeCheckoutId}`, mode: 'write' }],
            returnHandleImmediately: true,
            timeoutMs: 5_000,
          }),
          spawnManagedProcess({
            controllerHome,
            repoId: second.repository.repoId,
            checkoutId: second.repository.activeCheckoutId,
            executionIdentity: executionIdentityForRepository(second.repository),
            commandId: `benchmark-multi-b-${index}`,
            origin: { surface: 'system', requestId: `benchmark-multi-b-${index}` },
            command: { ...physicalCommand(markerB, `repo-b-${index}`), cwd: second.repoRoot },
            resourceClaims: [{ resourceKey: `workspace:${second.repository.activeCheckoutId}`, mode: 'write' }],
            returnHandleImmediately: true,
            timeoutMs: 5_000,
          }),
        ]);
        timing.queueTimeMs = elapsed(queueStarted);
        const processStarted = performance.now();
        const [completedA, completedB] = await Promise.all([
          waitForProcess(controllerHome, first.repository.repoId, handleA.processId, { timeoutMs: 5_000 }),
          waitForProcess(controllerHome, second.repository.repoId, handleB.processId, { timeoutMs: 5_000 }),
        ]);
        timing.workerProcessMs = elapsed(processStarted);
        timing.wallClockMs = elapsed(started);
        const isolated = handleA.processId !== handleB.processId
          && readFileSync(join(first.repoRoot, markerA), 'utf8') === `repo-a-${index}`
          && readFileSync(join(second.repoRoot, markerB), 'utf8') === `repo-b-${index}`
          && completedA.stdout === `repo-a-${index}`
          && completedB.stdout === `repo-b-${index}`;
        return {
          phases: timing,
          outcome: completedA.ok && completedB.ok && isolated ? 'success' : 'failed',
          metrics: { physicalExecutions: 2, logicalSubscribers: 2, isolatedRepoIds: isolated ? 2 : 0 },
        };
      });

      await run('same_repository_different_checkout_load', async () => {
        const timing = phases();
        const started = performance.now();
        const queueStarted = performance.now();
        const markerA = `.benchmark/checkout-main-${index}.txt`;
        const markerB = `.benchmark/checkout-isolated-${index}.txt`;
        const [handleA, handleB] = await Promise.all([
          spawnManagedProcess({
            controllerHome,
            repoId: first.repository.repoId,
            checkoutId: first.repository.activeCheckoutId,
            executionIdentity: executionIdentityForRepository(first.repository),
            commandId: `benchmark-checkout-main-${index}`,
            origin: { surface: 'system', requestId: `benchmark-checkout-main-${index}` },
            command: { ...physicalCommand(markerA, `main-${index}`), cwd: first.repoRoot },
            resourceClaims: [{ resourceKey: `workspace:${first.repository.activeCheckoutId}`, mode: 'write' }],
            returnHandleImmediately: true,
            timeoutMs: 5_000,
          }),
          spawnManagedProcess({
            controllerHome,
            repoId: firstIsolated.repository.repoId,
            checkoutId: firstIsolated.repository.activeCheckoutId,
            executionIdentity: executionIdentityForRepository(firstIsolated.repository),
            commandId: `benchmark-checkout-isolated-${index}`,
            origin: { surface: 'system', requestId: `benchmark-checkout-isolated-${index}` },
            command: { ...physicalCommand(markerB, `isolated-${index}`), cwd: firstIsolated.repoRoot },
            resourceClaims: [{ resourceKey: `workspace:${firstIsolated.repository.activeCheckoutId}`, mode: 'write' }],
            returnHandleImmediately: true,
            timeoutMs: 5_000,
          }),
        ]);
        timing.queueTimeMs = elapsed(queueStarted);
        const processStarted = performance.now();
        const [completedA, completedB] = await Promise.all([
          waitForProcess(controllerHome, first.repository.repoId, handleA.processId, { timeoutMs: 5_000 }),
          waitForProcess(controllerHome, first.repository.repoId, handleB.processId, { timeoutMs: 5_000 }),
        ]);
        timing.workerProcessMs = elapsed(processStarted);
        timing.wallClockMs = elapsed(started);
        const isolated = first.repository.activeCheckoutId !== firstIsolated.repository.activeCheckoutId
          && handleA.processId !== handleB.processId
          && readFileSync(join(first.repoRoot, markerA), 'utf8') === `main-${index}`
          && readFileSync(join(firstIsolated.repoRoot, markerB), 'utf8') === `isolated-${index}`;
        return {
          phases: timing,
          outcome: completedA.ok && completedB.ok && isolated ? 'success' : 'failed',
          metrics: { physicalExecutions: 2, logicalSubscribers: 2, distinctCheckouts: isolated ? 2 : 0 },
        };
      });

      await run('same_checkout_contention', async () => {
        const timing = phases();
        const started = performance.now();
        const marker = `.benchmark/contention-${index}.txt`;
        const live = await spawnManagedProcess({
          controllerHome,
          repoId: first.repository.repoId,
          checkoutId: first.repository.activeCheckoutId,
          executionIdentity: executionIdentityForRepository(first.repository),
          commandId: `benchmark-contention-live-${index}`,
          origin: { surface: 'system', requestId: `benchmark-contention-live-${index}` },
          command: { ...physicalCommand(marker, `winner-${index}`, 200), cwd: first.repoRoot },
          resourceClaims: [{ resourceKey: `workspace:${first.repository.activeCheckoutId}`, mode: 'write' }],
          returnHandleImmediately: true,
          timeoutMs: 5_000,
        });
        const lockStarted = performance.now();
        const blocked = await spawnManagedProcess({
          controllerHome,
          repoId: first.repository.repoId,
          checkoutId: first.repository.activeCheckoutId,
          executionIdentity: executionIdentityForRepository(first.repository),
          commandId: `benchmark-contention-blocked-${index}`,
          origin: { surface: 'system', requestId: `benchmark-contention-blocked-${index}` },
          command: { ...physicalCommand(`.benchmark/blocked-${index}.txt`, `blocked-${index}`), cwd: first.repoRoot },
          resourceClaims: [{ resourceKey: `workspace:${first.repository.activeCheckoutId}`, mode: 'write' }],
          returnHandleImmediately: true,
          timeoutMs: 5_000,
        });
        timing.lockWaitMs = elapsed(lockStarted);
        timing.leaseWaitMs = timing.lockWaitMs;
        const completed = await waitForProcess(controllerHome, first.repository.repoId, live.processId, { timeoutMs: 5_000 });
        timing.wallClockMs = elapsed(started);
        const correctlyBlocked = completed.ok
          && blocked.ok === false
          && blocked.stderr?.includes('PROCESS_LEASE_CONFLICT')
          && existsSync(join(first.repoRoot, marker))
          && !existsSync(join(first.repoRoot, `.benchmark/blocked-${index}.txt`));
        return {
          phases: timing,
          outcome: correctlyBlocked ? 'contention' : 'failed',
          metrics: { physicalExecutions: correctlyBlocked ? 1 : 0, logicalSubscribers: 2, leaseConflicts: correctlyBlocked ? 1 : 0 },
        };
      });

      await run('check_cache_coalescing_reuse', async () => {
        const timing = phases();
        const started = performance.now();
        const requestedTimeoutMs = 5_000 + index;
        const sourceIdentity = controllerCheckExecutionIdentity(
          first.repoRoot,
          'benchmark:semantic',
          requestedTimeoutMs,
        );
        const isolatedIdentity = controllerCheckExecutionIdentity(
          firstIsolated.repoRoot,
          'benchmark:semantic',
          requestedTimeoutMs,
        );
        const command = {
          kind: 'argv' as const,
          executable: process.execPath,
          args: ['-e', 'setTimeout(() => process.exit(0), 100)'],
        };
        const runCheck = (
          repository: typeof first.repository,
          repoRoot: string,
          requestId: string,
          executionSessionId: string,
          identity: typeof sourceIdentity,
        ) => spawnManagedProcess({
          controllerHome,
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          executionIdentity: executionIdentityForRepository(repository),
          commandId: requestId,
          origin: { surface: 'check', checkId: 'benchmark:semantic', requestId, executionSessionId },
          command: { ...command, cwd: repoRoot },
          checkExecution: {
            ...identity,
            scopeKey: identity.reuseScope === 'repository'
              ? 'repository'
              : `checkout:${repository.activeCheckoutId}`,
          },
          resourceClaims: [{ resourceKey: `workspace:${repository.activeCheckoutId}`, mode: 'read' }],
          returnHandleImmediately: true,
          timeoutMs: requestedTimeoutMs,
        });

        const queueStarted = performance.now();
        const [firstSubscriber, secondSubscriber] = await Promise.all([
          runCheck(first.repository, first.repoRoot, `benchmark-check-a-${index}`, `session-a-${index}`, sourceIdentity),
          runCheck(first.repository, first.repoRoot, `benchmark-check-b-${index}`, `session-b-${index}`, sourceIdentity),
        ]);
        timing.queueTimeMs = elapsed(queueStarted);
        const completed = await waitForProcess(
          controllerHome,
          first.repository.repoId,
          firstSubscriber.processId,
          { timeoutMs: 5_000 },
        );
        const crossCheckoutReuse = await runCheck(
          firstIsolated.repository,
          firstIsolated.repoRoot,
          `benchmark-check-cross-${index}`,
          `session-cross-${index}`,
          isolatedIdentity,
        );

        const dirtyPath = join(firstIsolated.repoRoot, `dirty-${index}.txt`);
        writeFileSync(dirtyPath, `dirty-${index}\n`);
        const dirtyIdentity = controllerCheckExecutionIdentity(
          firstIsolated.repoRoot,
          'benchmark:semantic',
          requestedTimeoutMs,
        );
        const invalidated = await runCheck(
          firstIsolated.repository,
          firstIsolated.repoRoot,
          `benchmark-check-dirty-${index}`,
          `session-dirty-${index}`,
          dirtyIdentity,
        );
        const invalidatedCompleted = await waitForProcess(
          controllerHome,
          first.repository.repoId,
          invalidated.processId,
          { timeoutMs: 5_000 },
        );
        rmSync(dirtyPath);
        timing.workerProcessMs = elapsed(started) - timing.queueTimeMs;
        timing.wallClockMs = elapsed(started);
        const coalesced = firstSubscriber.processId === secondSubscriber.processId
          && secondSubscriber.semanticDeduplicated === true;
        const reused = crossCheckoutReuse.processId === firstSubscriber.processId
          && crossCheckoutReuse.semanticDeduplicated === true
          && sourceIdentity.cacheKey === isolatedIdentity.cacheKey
          && sourceIdentity.reuseScope === 'repository'
          && isolatedIdentity.reuseScope === 'repository';
        const cacheInvalidated = dirtyIdentity.cacheKey !== sourceIdentity.cacheKey
          && dirtyIdentity.reuseScope === 'checkout'
          && invalidated.processId !== firstSubscriber.processId;
        return {
          phases: timing,
          outcome: completed.ok && invalidatedCompleted.ok && coalesced && reused && cacheInvalidated ? 'success' : 'failed',
          metrics: {
            physicalExecutions: 2,
            logicalSubscribers: 4,
            coalesced: coalesced ? 1 : 0,
            cacheHits: reused ? 1 : 0,
            invalidations: cacheInvalidated ? 1 : 0,
            crossCheckoutReuses: reused ? 1 : 0,
          },
        };
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
        physicalConcurrency: 'The multi-repository and multi-checkout scenarios launch real Process Runners that write isolated marker files under temporary Git repositories and a real git worktree.',
        sameCheckoutContention: 'leaseWaitMs is the bounded end-to-end admission time for the conflicting second Process, including identity/persistence work around the Lease decision.',
        checkIdentity: 'The cache identity is derived from repository-scoped storage plus content revision, check definition digest, environment/toolchain fingerprint, timeout contract, and reuse scope. Session and request ids are subscribers, not cache-key inputs.',
        checkCacheMetrics: 'physicalExecutions/logicalSubscribers/coalesced/cacheHits/invalidations/crossCheckoutReuses are summed across measured iterations.',
        semanticAdmission: 'Two 32-process bursts share one repository-scoped semantic admission lock: one contends for a single Requirement authority and one admits 32 independent Requirement identities. Critical-section latency measures only canonical ownership resolution and persistence inside the lock.',
      },
      semanticAdmission,
      scenarios: Object.fromEntries([...results].map(([name, samples]) => [name, summarize(samples)])),
    };
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (outputPath) {
      mkdirSync(join(outputPath, '..'), { recursive: true });
      writeFileSync(outputPath, serialized);
    }
    process.stdout.write(serialized);
    if (!semanticAdmission.acceptance.passed) process.exitCode = 1;
  } finally {
    clearRuntimeWriteClaimForTests();
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv.includes('--semantic-admission-worker')) {
  await semanticAdmissionWorker();
} else {
  await main();
}
