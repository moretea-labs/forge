#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  evaluateOperationalMemoryActivation,
  freezeOperationalMemoryActivationProtocol,
  type OperationalMemoryActivationMeasurement,
  type OperationalMemoryActivationPair,
} from '../evaluation/lib/operational-memory-activation';
import { controllerCheckEnvironmentFingerprint, listControllerChecks } from '../src/cli/controller/check-runner';
import {
  OPERATIONAL_MEMORY_NAMESPACE,
  ingestCheckCompletionGraceProcess,
  resolveCheckCompletionGraceWaitMs,
} from '../src/runtime/control-plane/persistence/operational-prior-store';
import { listControlPlaneRecords } from '../src/runtime/control-plane/persistence/sqlite-store';
import { createProcessRecord } from '../src/runtime/execution/process-runtime/store';
import { startLightweightControllerCheck, waitForLightweightProcess } from '../src/runtime/execution/process-runtime/lightweight-managed';
import type { ManagedProcessRecord, ProcessHandle } from '../src/runtime/execution/process-runtime/types';

interface Scenario {
  id: string;
  kind: 'eligible' | 'guard';
  delayMs: number;
  historicalDurationMs: number;
}

const scenarios: readonly Scenario[] = [
  { id: 'check-grace-eligible-150ms', kind: 'eligible', delayMs: 150, historicalDurationMs: 150 },
  { id: 'check-grace-eligible-180ms', kind: 'eligible', delayMs: 180, historicalDurationMs: 180 },
  { id: 'check-grace-guard-400ms', kind: 'guard', delayMs: 400, historicalDurationMs: 400 },
];
const SAMPLES_PER_ARM = 3;
const CHECK_ID = 'package:check:fixture';
const CANONICAL_WAIT_MS = 100;

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function fixture(delayMs: number, label: string): { root: string; controllerHome: string; repoId: string } {
  const root = mkdtempSync(join(tmpdir(), `forge-stage7f-${label}-repo-`));
  const controllerHome = mkdtempSync(join(tmpdir(), `forge-stage7f-${label}-home-`));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'check:fixture': `sleep ${delayMs / 1000}` } }, null, 2));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'stage7f@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Stage7F Fixture'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return { root, controllerHome, repoId: `repo-stage7f-${label}` };
}

function historicalProcess(input: {
  controllerHome: string;
  repoId: string;
  root: string;
  processId: string;
  environmentFingerprint: string;
  durationMs: number;
  index: number;
}): ManagedProcessRecord {
  const finishMs = Date.now() - (10_000 - input.index * 1_000);
  const startMs = finishMs - input.durationMs;
  return {
    schemaVersion: 1,
    processId: input.processId,
    repoId: input.repoId,
    checkoutId: 'historical-checkout',
    commandId: `historical-command-${input.index}`,
    controllerHome: input.controllerHome,
    status: 'succeeded',
    route: 'direct',
    command: { kind: 'argv', executable: 'sleep', args: [String(input.durationMs / 1000)], cwd: input.root },
    resourceClaims: [],
    leaseRefs: [],
    leasesReleased: true,
    interactiveWaitMs: 0,
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
    startedAt: new Date(startMs).toISOString(),
    updatedAt: new Date(finishMs).toISOString(),
    finishedAt: new Date(finishMs).toISOString(),
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    terminalFenceToken: input.index + 1,
    terminalWritten: true,
    checkExecution: {
      schemaVersion: 1,
      checkId: CHECK_ID,
      cacheKey: `historical-cache-${input.index}`,
      revision: 'historical-revision',
      definitionDigest: 'historical-definition',
      environmentFingerprint: input.environmentFingerprint,
      timeoutMs: 5_000,
      reuseScope: 'repository',
      scopeKey: 'repository',
    },
    origin: {
      surface: 'check',
      checkId: CHECK_ID,
      requestId: `historical-request-${input.index}`,
    },
  };
}

function seedOperationalMemory(input: {
  controllerHome: string;
  repoId: string;
  root: string;
  historicalDurationMs: number;
}): { learnedWaitMs?: number; lookupMs: number; recordBytes: number } {
  const check = listControllerChecks(input.root).find((entry) => entry.id === CHECK_ID);
  if (!check) throw new Error(`STAGE7F_BENCHMARK_CHECK_MISSING:${CHECK_ID}`);
  const environmentFingerprint = controllerCheckEnvironmentFingerprint(check);
  for (let index = 0; index < 3; index += 1) {
    const processId = `proc_stage7f_history_${index}`;
    createProcessRecord(historicalProcess({ ...input, processId, environmentFingerprint, durationMs: input.historicalDurationMs, index }));
    const ingested = ingestCheckCompletionGraceProcess({ controllerHome: input.controllerHome, repoId: input.repoId, processId });
    if (!ingested.stored) throw new Error(`STAGE7F_BENCHMARK_INGEST_FAILED:${processId}`);
  }
  const lookupStart = performance.now();
  const learnedWaitMs = resolveCheckCompletionGraceWaitMs({
    controllerHome: input.controllerHome,
    repoId: input.repoId,
    checkId: CHECK_ID,
    environmentFingerprint,
  });
  const lookupMs = performance.now() - lookupStart;
  const records = listControlPlaneRecords(input.controllerHome, { namespace: OPERATIONAL_MEMORY_NAMESPACE, scope: input.repoId, limit: 16 });
  return { learnedWaitMs, lookupMs, recordBytes: bytes(records) };
}

async function runOne(input: {
  scenario: Scenario;
  active: boolean;
  sample: number;
}): Promise<OperationalMemoryActivationMeasurement> {
  const label = `${input.scenario.id}-${input.active ? 'active' : 'cold'}-${input.sample}`;
  const fx = fixture(input.scenario.delayMs, label);
  try {
    const memory = input.active
      ? seedOperationalMemory({ controllerHome: fx.controllerHome, repoId: fx.repoId, root: fx.root, historicalDurationMs: input.scenario.historicalDurationMs })
      : { learnedWaitMs: undefined, lookupMs: 0, recordBytes: 0 };
    const appliedWaitMs = memory.learnedWaitMs ?? CANONICAL_WAIT_MS;
    const started = performance.now();
    const first = await startLightweightControllerCheck({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      repoRoot: fx.root,
      checkId: CHECK_ID,
      interactiveWaitMs: appliedWaitMs,
      timeoutMs: 5_000,
      commandId: label,
    });
    const firstReturnMs = performance.now() - started;
    const firstHandle: ProcessHandle = first.handle;
    let finalHandle = firstHandle;
    let toolRoundTrips = 1;
    if (!finalHandle.completed) {
      toolRoundTrips += 1;
      finalHandle = await waitForLightweightProcess(fx.controllerHome, fx.repoId, finalHandle.processId, { timeoutMs: 5_000 });
    }
    const terminalLatencyMs = performance.now() - started + memory.lookupMs;
    return {
      toolRoundTrips,
      firstReturnMs,
      terminalLatencyMs,
      completedInOrigin: firstHandle.completed === true,
      controllerVisibleBytes: bytes(firstHandle) + (toolRoundTrips > 1 ? bytes(finalHandle) : 0),
      controllerMemoryPayloadBytes: 0,
      memoryLookupMs: memory.lookupMs,
      memoryRecordBytes: memory.recordBytes,
      appliedWaitMs,
      ...(memory.learnedWaitMs === undefined ? {} : { learnedWaitMs: memory.learnedWaitMs }),
      correctnessPassed: finalHandle.completed === true && finalHandle.ok === true,
    };
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(fx.controllerHome, { recursive: true, force: true });
  }
}

function aggregate(samples: OperationalMemoryActivationMeasurement[]): OperationalMemoryActivationMeasurement {
  const learned = samples.map((sample) => sample.learnedWaitMs).filter((value): value is number => value !== undefined);
  return {
    toolRoundTrips: median(samples.map((sample) => sample.toolRoundTrips)),
    firstReturnMs: median(samples.map((sample) => sample.firstReturnMs)),
    terminalLatencyMs: median(samples.map((sample) => sample.terminalLatencyMs)),
    completedInOrigin: samples.filter((sample) => sample.completedInOrigin).length >= Math.ceil(samples.length / 2),
    controllerVisibleBytes: median(samples.map((sample) => sample.controllerVisibleBytes)),
    controllerMemoryPayloadBytes: median(samples.map((sample) => sample.controllerMemoryPayloadBytes)),
    memoryLookupMs: median(samples.map((sample) => sample.memoryLookupMs)),
    memoryRecordBytes: median(samples.map((sample) => sample.memoryRecordBytes)),
    appliedWaitMs: median(samples.map((sample) => sample.appliedWaitMs)),
    ...(learned.length === 0 ? {} : { learnedWaitMs: median(learned) }),
    correctnessPassed: samples.every((sample) => sample.correctnessPassed),
  };
}

export async function runOperationalMemoryActivationBenchmark(candidateIdentity: string) {
  const protocol = freezeOperationalMemoryActivationProtocol({ candidateIdentity });
  const pairs: OperationalMemoryActivationPair[] = [];
  for (const scenario of scenarios) {
    const cold: OperationalMemoryActivationMeasurement[] = [];
    const active: OperationalMemoryActivationMeasurement[] = [];
    for (let sample = 0; sample < SAMPLES_PER_ARM; sample += 1) {
      cold.push(await runOne({ scenario, active: false, sample }));
      active.push(await runOne({ scenario, active: true, sample }));
    }
    pairs.push({ scenarioId: scenario.id, kind: scenario.kind, candidateIdentity, cold: aggregate(cold), active: aggregate(active) });
  }
  return { schemaVersion: 1 as const, protocol, pairs, report: evaluateOperationalMemoryActivation(protocol, pairs) };
}

function candidateArg(): string | undefined {
  const index = process.argv.indexOf('--candidate');
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  const candidate = candidateArg();
  if (!candidate) throw new Error('Usage: bun scripts/benchmark-operational-memory-activation.ts --candidate <frozen-candidate-identity>');
  const result = await runOperationalMemoryActivationBenchmark(candidate);
  console.log(JSON.stringify(result, null, 2));
  if (!result.report.passed) process.exitCode = 1;
}
