#!/usr/bin/env bun

/**
 * Forge Work efficiency benchmark.
 *
 * Measures end-to-end controller ceremony for a tiny, real repository change
 * against isolated temporary repository/controller state. It compares the
 * streamlined path (verify -> finalize) with the legacy-style ceremony
 * (verify -> continue -> finalize) without mutating the Forge checkout.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { createMcpToolContext } from '../src/cli/mcp/server';
import type { MultiRepositoryMcpToolContext } from '../src/cli/mcp/multi-repository';
import { ensureControllerHome } from '../src/cli/repositories/controller-home';
import { registerRepository } from '../src/cli/repositories/registry';
import { callRuntimeTool } from '../src/runtime/gateway/mcp/runtime-tools';
import { getWorkContract } from '../src/runtime/control-plane/facade/work-contract-store';
import { waitForProcess } from '../src/runtime/execution/process-runtime';
import { acquireRuntimeOwnership } from '../src/runtime/root/ownership';
import { forgeRuntimeServicePaths } from '../src/runtime/root/service';
import { writeRuntimeStatusSnapshot } from '../src/runtime/root/status';
import { ensureActiveRuntimeRelease } from '../src/runtime/root/release-store';
import { bindRuntimeWriteClaim, clearRuntimeWriteClaimForTests } from '../src/runtime/root/write-fence';

interface TimedCall {
  elapsedMs: number;
  value: Record<string, any>;
}

interface FlowSample {
  mode: 'streamlined' | 'legacy_ceremony';
  sample: number;
  ok: boolean;
  controllerCalls: number;
  processWaits: number;
  startMs: number;
  verifySubmitMs: number;
  verifyWaitMs: number;
  verifyReattachMs: number;
  continueMs: number;
  finalizeMs: number;
  totalMs: number;
  verificationNextStep?: string;
  finalStatus?: string;
  cleanupComplete: boolean;
}

function argNumber(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const parsed = Number(process.argv[index + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(String(result.stderr || `git ${args.join(' ')} failed`));
  return String(result.stdout ?? '').trim();
}

function runtimeManifest(controllerHome: string): string {
  const path = join(controllerHome, 'benchmark-runtime.manifest.json');
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    releaseId: 'release-work-efficiency-benchmark',
    artifactIdentity: 'artifact-work-efficiency-benchmark',
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

function createFixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `forge-work-efficiency-${label}-`));
  const controllerHome = join(root, 'controller');
  const repoRoot = join(root, 'repo');
  ensureControllerHome(controllerHome);
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Work Efficiency Benchmark']);
  git(repoRoot, ['config', 'user.email', 'benchmark@example.test']);
  writeFileSync(join(repoRoot, 'README.md'), 'fixture\n');
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
    name: `work-efficiency-${label}`,
    private: true,
    scripts: { 'check:bench': 'node -e "process.exit(0)"' },
  }, null, 2));
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'fixture']);

  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: `work-efficiency-${label}` });
  const owner = acquireRuntimeOwnership(controllerHome, `runtime-work-efficiency-${label}`);
  const authority = ensureActiveRuntimeRelease(controllerHome, runtimeManifest(controllerHome));
  bindRuntimeWriteClaim({ controllerHome, owner: owner.record, authority });

  const runtimeService = forgeRuntimeServicePaths(controllerHome);
  mkdirSync(runtimeService.serviceRoot, { recursive: true });
  mkdirSync(join(controllerHome, 'mcp'), { recursive: true });
  const runtimeTokenPath = join(controllerHome, 'mcp', 'runtime-token');
  writeFileSync(runtimeTokenPath, `fixture-token-${label}\n`, { mode: 0o600 });
  writeFileSync(runtimeService.configPath, JSON.stringify({
    schemaVersion: 1,
    controllerHome,
    repositoryRoot: repoRoot,
    host: '127.0.0.1',
    port: 9876,
    authTokenFile: runtimeTokenPath,
  }));
  const observedAt = new Date().toISOString();
  writeRuntimeStatusSnapshot(controllerHome, {
    schemaVersion: 1,
    runtimeInstanceId: owner.record.runtimeInstanceId,
    pid: owner.record.pid,
    releaseId: authority.active.releaseId,
    artifactIdentity: authority.active.artifactIdentity,
    endpoint: 'http://127.0.0.1:9876/mcp',
    readiness: {
      ready: true,
      reasonCodes: [],
      diagnostics: {
        database: { outcome: 'pass' },
        scheduler: { outcome: 'pass' },
        releaseCoherence: { outcome: 'pass' },
        mcpEndToEnd: { outcome: 'pass' },
      },
      observedAt,
    },
    startedAt: observedAt,
    updatedAt: observedAt,
  });

  const ctx = createMcpToolContext({
    controllerHome,
    profile: 'controller',
    repo: repoRoot,
    sessionId: `mcp-work-efficiency-${label}`,
    principalId: `principal-work-efficiency-${label}`,
    controllerInstanceId: owner.record.runtimeInstanceId,
  }) as MultiRepositoryMcpToolContext;
  return { root, controllerHome, repoRoot, repository, ctx };
}

async function timedCall(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>): Promise<TimedCall> {
  const startedAt = performance.now();
  const result = await callRuntimeTool(ctx, 'rh_work', args);
  const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100;
  if (!result) throw new Error('rh_work returned no benchmark result');
  const value = (result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? '{}')) as Record<string, any>;
  return { elapsedMs, value };
}

async function runFlow(mode: FlowSample['mode'], sample: number): Promise<FlowSample> {
  const label = `${mode}-${sample}-${Date.now()}`;
  const fx = createFixture(label);
  const wallStartedAt = performance.now();
  let controllerCalls = 0;
  let processWaits = 0;
  try {
    const started = await timedCall(fx.ctx, {
      repo_id: fx.repository.repoId,
      operation: 'start',
      objective: `Benchmark ${mode} work lifecycle`,
      scope_clear: true,
      expected_files: 1,
      expected_changed_lines: 1,
      requires_recovery: true,
      allowed_paths: ['README.md'],
      check_ids: ['package:check:bench'],
      constraints: { workspaceMode: 'isolated' },
      request_id: `work-efficiency-start-${label}`,
    });
    controllerCalls += 1;
    const workId = String(started.value.data?.work?.workId ?? '');
    if (!workId) throw new Error('benchmark Work was not created');
    const store = { controllerHome: fx.controllerHome, repoId: fx.repository.repoId };
    const contract = getWorkContract(store, workId);
    if (!contract?.worktreeRef) throw new Error('benchmark Work has no managed worktree');
    writeFileSync(join(contract.worktreeRef, 'README.md'), `fixture\n${mode}\n`);

    const verifyArgs = {
      repo_id: fx.repository.repoId,
      operation: 'verify',
      work_id: workId,
      check_id: 'package:check:bench',
      request_id: `work-efficiency-verify-${label}`,
    };
    const verifySubmit = await timedCall(fx.ctx, verifyArgs);
    controllerCalls += 1;
    const processId = String(verifySubmit.value.data?.verification?.processId ?? '');
    if (!processId) throw new Error('benchmark verification did not return a Process id');
    const waitStartedAt = performance.now();
    await waitForProcess(fx.controllerHome, fx.repository.repoId, processId, { timeoutMs: 10_000 });
    const verifyWaitMs = Math.round((performance.now() - waitStartedAt) * 100) / 100;
    processWaits += 1;

    const verifyReattach = await timedCall(fx.ctx, verifyArgs);
    controllerCalls += 1;
    const verificationOutcome = String(verifyReattach.value.data?.verification?.outcome ?? '');
    const verificationNextStep = typeof verifyReattach.value.data?.nextStep === 'string'
      ? verifyReattach.value.data.nextStep
      : undefined;
    if (verificationOutcome !== 'valid_pass') throw new Error(`benchmark verification outcome: ${verificationOutcome}`);

    let continueMs = 0;
    if (mode === 'legacy_ceremony') {
      const continued = await timedCall(fx.ctx, {
        repo_id: fx.repository.repoId,
        operation: 'continue',
        work_id: workId,
      });
      controllerCalls += 1;
      continueMs = continued.elapsedMs;
      if (continued.value.data?.nextStep !== 'finalize') throw new Error('legacy ceremony did not reach finalize');
    }

    const finalized = await timedCall(fx.ctx, {
      repo_id: fx.repository.repoId,
      operation: 'finalize',
      work_id: workId,
    });
    controllerCalls += 1;
    const finalStatus = String(finalized.value.data?.finalStatus ?? '');
    const cleanupComplete = !existsSync(contract.worktreeRef);
    const totalMs = Math.round((performance.now() - wallStartedAt) * 100) / 100;
    return {
      mode,
      sample,
      ok: finalStatus === 'completed' && cleanupComplete,
      controllerCalls,
      processWaits,
      startMs: started.elapsedMs,
      verifySubmitMs: verifySubmit.elapsedMs,
      verifyWaitMs,
      verifyReattachMs: verifyReattach.elapsedMs,
      continueMs,
      finalizeMs: finalized.elapsedMs,
      totalMs,
      verificationNextStep,
      finalStatus,
      cleanupComplete,
    };
  } finally {
    clearRuntimeWriteClaimForTests();
    rmSync(fx.root, { recursive: true, force: true });
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return Math.round((sorted[Math.max(0, index)] ?? 0) * 100) / 100;
}

function summarize(samples: FlowSample[]) {
  return {
    count: samples.length,
    allOk: samples.every((sample) => sample.ok),
    controllerCalls: samples[0]?.controllerCalls ?? 0,
    processWaits: samples[0]?.processWaits ?? 0,
    totalMs: {
      p50: percentile(samples.map((sample) => sample.totalMs), 0.5),
      p95: percentile(samples.map((sample) => sample.totalMs), 0.95),
    },
    startMs: { p50: percentile(samples.map((sample) => sample.startMs), 0.5), p95: percentile(samples.map((sample) => sample.startMs), 0.95) },
    verifyWallMs: {
      p50: percentile(samples.map((sample) => sample.verifySubmitMs + sample.verifyWaitMs + sample.verifyReattachMs), 0.5),
      p95: percentile(samples.map((sample) => sample.verifySubmitMs + sample.verifyWaitMs + sample.verifyReattachMs), 0.95),
    },
    continueMs: { p50: percentile(samples.map((sample) => sample.continueMs), 0.5), p95: percentile(samples.map((sample) => sample.continueMs), 0.95) },
    finalizeMs: { p50: percentile(samples.map((sample) => sample.finalizeMs), 0.5), p95: percentile(samples.map((sample) => sample.finalizeMs), 0.95) },
  };
}

async function main(): Promise<void> {
  const sampleCount = Math.min(argNumber('--samples', 3), 10);
  const sourceHeadBefore = git(process.cwd(), ['rev-parse', 'HEAD']);
  const streamlined: FlowSample[] = [];
  const legacy: FlowSample[] = [];

  for (let sample = 1; sample <= sampleCount; sample += 1) {
    if (sample % 2 === 1) {
      streamlined.push(await runFlow('streamlined', sample));
      legacy.push(await runFlow('legacy_ceremony', sample));
    } else {
      legacy.push(await runFlow('legacy_ceremony', sample));
      streamlined.push(await runFlow('streamlined', sample));
    }
  }

  const sourceHeadAfter = git(process.cwd(), ['rev-parse', 'HEAD']);
  const streamlinedSummary = summarize(streamlined);
  const legacySummary = summarize(legacy);
  const result = {
    schemaVersion: 1,
    benchmark: 'work-efficiency',
    revision: sourceHeadAfter,
    generatedAt: new Date().toISOString(),
    sampleCount,
    methodology: 'Real rh_work start + managed Check Process + authoritative reattach + finalize on isolated temporary repositories. Legacy comparison adds only the mechanical continue call.',
    streamlined: streamlinedSummary,
    legacyCeremony: legacySummary,
    productivity: {
      controllerCallsSavedPerWork: legacySummary.controllerCalls - streamlinedSummary.controllerCalls,
      controlRoundTripReductionRatio: legacySummary.controllerCalls > 0
        ? Math.round(((legacySummary.controllerCalls - streamlinedSummary.controllerCalls) / legacySummary.controllerCalls) * 10_000) / 10_000
        : 0,
      measuredContinueCeremonyMsP50: legacySummary.continueMs.p50,
      totalWallClockDeltaMsP50: Math.round((legacySummary.totalMs.p50 - streamlinedSummary.totalMs.p50) * 100) / 100,
    },
    acceptance: {
      sourceCheckoutHeadStable: sourceHeadBefore === sourceHeadAfter,
      streamlinedAllOk: streamlinedSummary.allOk,
      legacyAllOk: legacySummary.allOk,
      streamlinedDirectsFinalPassToFinalize: streamlined.every((sample) => sample.verificationNextStep === 'finalize'),
      oneControllerCallSaved: legacySummary.controllerCalls - streamlinedSummary.controllerCalls === 1,
      cleanupComplete: [...streamlined, ...legacy].every((sample) => sample.cleanupComplete),
    },
    samples: { streamlined, legacyCeremony: legacy },
  };
  const allAccepted = Object.values(result.acceptance).every(Boolean);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!allAccepted) process.exitCode = 1;
}

await main();
