#!/usr/bin/env bun
/**
 * Real iOS agent-device latency benchmark.
 *
 * Compares the compatibility fresh-session JD workflow with the trusted warm
 * path that reuses one exact active JD interaction. It never invents baseline
 * data and never runs without an explicitly selected --device. Every selected
 * profile performs one warmup followed by at least three measured runs.
 *
 * Fresh-session profile:
 *   inventory -> open -> search/evidence -> screenshot -> close, for every run
 *
 * Reused-session profile:
 *   open once -> repeated search/evidence batches without screenshot -> close once
 *
 * Example:
 *   bun scripts/benchmark-ios-agent-device.ts \
 *     --repo-id repo_... --device "iPhone" --query "宽楦男鞋" \
 *     --search-selector 'type="SearchField"' --submit-selector 'label="搜索"' \
 *     --result-text "宽楦男鞋" --profile both --runs 5 --json
 */
import { performance } from 'perf_hooks';
import { resolve } from 'path';
import { executeIosAgentDeviceAction } from '../src/runtime/plugins/ios-agent-device';

type EvidenceTier = 'exact_wait' | 'scoped_snapshot' | 'full_snapshot' | 'unknown';
export type BenchmarkProfile = 'fresh_session' | 'reused_session';

export interface NumericSummary {
  count: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

interface PhaseTimings {
  targetSelection?: number;
  open?: number;
  targetDiscovery?: number;
  interactionAndEvidence?: number;
  screenshot?: number;
  close?: number;
  total?: number;
}

export interface IosBenchmarkSample {
  index: number;
  warmup: boolean;
  profile: BenchmarkProfile;
  totalMs: number;
  harnessOverheadMs?: number;
  tier: EvidenceTier;
  sessionReused: boolean;
  sessionKept: boolean;
  screenshotCaptured: boolean;
  deviceInventoryRequests: number;
  accessibilitySnapshotRequests: number;
  nativeBatchRequests: number;
  nativeBatchSteps: number;
  staleRefRecovery: boolean;
  exactWaitFallback: boolean;
  runnerRoundTrips?: number;
  providerWallClockMs?: number;
  phaseTimingsMs?: PhaseTimings;
}

export interface IosBenchmarkProfileReport {
  profile: BenchmarkProfile;
  warmupCount: number;
  measuredRunCount: number;
  setup?: { openMs: number };
  cleanup?: { closeMs: number; completed: boolean };
  measured: Record<string, unknown>;
  samples: IosBenchmarkSample[];
}

const JD_BUNDLE_ID = 'com.360buy.jdmobile';

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

export function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(0, Math.min(1, percentileValue)) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower]!;
  const weight = rank - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

export function summarize(values: number[]): NumericSummary {
  if (values.length === 0) return { count: 0, min: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  return {
    count: values.length,
    min: rounded(Math.min(...values)),
    p50: rounded(percentile(values, 0.5)),
    p95: rounded(percentile(values, 0.95)),
    max: rounded(Math.max(...values)),
    mean: rounded(values.reduce((sum, value) => sum + value, 0) / values.length),
  };
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function integerOption(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function requiredOption(name: string): string {
  const value = option(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function selectedProfiles(): BenchmarkProfile[] {
  const value = (option('profile') ?? 'both').trim().toLowerCase();
  if (value === 'both') return ['fresh_session', 'reused_session'];
  if (value === 'fresh' || value === 'fresh_session') return ['fresh_session'];
  if (value === 'warm' || value === 'reused' || value === 'reused_session') return ['reused_session'];
  throw new Error('--profile must be fresh, warm, or both');
}

function stringRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function findCost(value: unknown): { wallClockMs?: number; runnerRoundTrips?: number } {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCost(item);
      if (found.wallClockMs !== undefined || found.runnerRoundTrips !== undefined) return found;
    }
    return {};
  }
  const record = stringRecord(value);
  if (!record) return {};
  const cost = stringRecord(record.cost);
  if (cost) {
    return {
      wallClockMs: typeof cost.wallClockMs === 'number' ? cost.wallClockMs : undefined,
      runnerRoundTrips: typeof cost.runnerRoundTrips === 'number' ? cost.runnerRoundTrips : undefined,
    };
  }
  for (const child of Object.values(record)) {
    const found = findCost(child);
    if (found.wallClockMs !== undefined || found.runnerRoundTrips !== undefined) return found;
  }
  return {};
}

function sampleFromResult(
  profile: BenchmarkProfile,
  index: number,
  warmup: boolean,
  totalMs: number,
  result: Record<string, unknown>,
): IosBenchmarkSample {
  const executionPlan = stringRecord(result.executionPlan) ?? {};
  const phaseTimingsMs = stringRecord(executionPlan.timingsMs) as PhaseTimings | undefined;
  const providerTotal = phaseTimingsMs?.total;
  const cost = findCost(result);
  return {
    index,
    warmup,
    profile,
    totalMs: rounded(totalMs),
    harnessOverheadMs: typeof providerTotal === 'number'
      ? rounded(Math.max(0, totalMs - providerTotal))
      : undefined,
    tier: typeof executionPlan.accessibilityEvidenceTier === 'string'
      ? executionPlan.accessibilityEvidenceTier as EvidenceTier
      : 'unknown',
    sessionReused: executionPlan.sessionReused === true,
    sessionKept: executionPlan.sessionKept === true,
    screenshotCaptured: executionPlan.screenshotCaptured === true,
    deviceInventoryRequests: Number(executionPlan.deviceInventoryRequests ?? 0),
    accessibilitySnapshotRequests: Number(executionPlan.accessibilitySnapshotRequests ?? 0),
    nativeBatchRequests: Number(executionPlan.nativeBatchRequests ?? 0),
    nativeBatchSteps: Number(executionPlan.nativeBatchSteps ?? 0),
    staleRefRecovery: executionPlan.staleRefRecovery === true,
    exactWaitFallback: executionPlan.exactWaitFallback === true,
    runnerRoundTrips: cost.runnerRoundTrips,
    providerWallClockMs: cost.wallClockMs,
    phaseTimingsMs,
  };
}

const PHASE_NAMES: Array<keyof PhaseTimings> = [
  'targetSelection',
  'open',
  'targetDiscovery',
  'interactionAndEvidence',
  'screenshot',
  'close',
  'total',
];

export function summarizeProfileSamples(samples: IosBenchmarkSample[]): Record<string, unknown> {
  const measured = samples.filter((sample) => !sample.warmup);
  const phaseTimingsMs = Object.fromEntries(PHASE_NAMES.map((phase) => [
    phase,
    summarize(measured.flatMap((sample) => {
      const value = sample.phaseTimingsMs?.[phase];
      return typeof value === 'number' ? [value] : [];
    })),
  ]));
  const byTier = Object.fromEntries(
    [...new Set(measured.map((sample) => sample.tier))].map((tier) => [
      tier,
      {
        totalMs: summarize(measured.filter((sample) => sample.tier === tier).map((sample) => sample.totalMs)),
        providerWallClockMs: summarize(measured
          .filter((sample) => sample.tier === tier && sample.providerWallClockMs !== undefined)
          .map((sample) => sample.providerWallClockMs!)),
        runnerRoundTrips: summarize(measured
          .filter((sample) => sample.tier === tier && sample.runnerRoundTrips !== undefined)
          .map((sample) => sample.runnerRoundTrips!)),
      },
    ]),
  );
  return {
    totalMs: summarize(measured.map((sample) => sample.totalMs)),
    harnessOverheadMs: summarize(measured
      .filter((sample) => sample.harnessOverheadMs !== undefined)
      .map((sample) => sample.harnessOverheadMs!)),
    deviceInventoryRequests: summarize(measured.map((sample) => sample.deviceInventoryRequests)),
    accessibilitySnapshotRequests: summarize(measured.map((sample) => sample.accessibilitySnapshotRequests)),
    nativeBatchRequests: summarize(measured.map((sample) => sample.nativeBatchRequests)),
    nativeBatchSteps: summarize(measured.map((sample) => sample.nativeBatchSteps)),
    runnerRoundTrips: summarize(measured
      .filter((sample) => sample.runnerRoundTrips !== undefined)
      .map((sample) => sample.runnerRoundTrips!)),
    phaseTimingsMs,
    byTier,
    invariants: {
      allSessionsReused: measured.length > 0 && measured.every((sample) => sample.sessionReused),
      allScreenshotsSkipped: measured.length > 0 && measured.every((sample) => !sample.screenshotCaptured),
      allInventorySkipped: measured.length > 0 && measured.every((sample) => sample.deviceInventoryRequests === 0),
      maxNativeBatchRequests: measured.length > 0 ? Math.max(...measured.map((sample) => sample.nativeBatchRequests)) : 0,
    },
  };
}

export function compareProfileReports(
  fresh: IosBenchmarkProfileReport | undefined,
  reused: IosBenchmarkProfileReport | undefined,
): Record<string, unknown> | undefined {
  if (!fresh || !reused) return undefined;
  const freshTotal = (fresh.measured.totalMs as NumericSummary).p50;
  const reusedTotal = (reused.measured.totalMs as NumericSummary).p50;
  const freshP95 = (fresh.measured.totalMs as NumericSummary).p95;
  const reusedP95 = (reused.measured.totalMs as NumericSummary).p95;
  return {
    p50SavedMs: rounded(freshTotal - reusedTotal),
    p95SavedMs: rounded(freshP95 - reusedP95),
    p50Speedup: reusedTotal > 0 ? rounded(freshTotal / reusedTotal) : null,
    p95Speedup: reusedP95 > 0 ? rounded(freshP95 / reusedP95) : null,
    note: 'Fresh-session includes per-run inventory/open/screenshot/close; reused-session excludes one-time setup and cleanup from measured search latency.',
  };
}

function usage(): string {
  return [
    'Usage: bun scripts/benchmark-ios-agent-device.ts --repo-id <id> --device <name> --query <text> [options]',
    '',
    'Required:',
    '  --repo-id <id>             Repository id used for Controller-owned interaction state',
    '  --device <name>            Exact connected physical iPhone or booted Simulator name',
    '  --query <text>              Non-sensitive product-information query',
    '',
    'Evidence targeting:',
    '  --search-selector <value>   Stable selector; preferred over snapshot-scoped refs',
    '  --search-target <ref>       Cached accessibility ref fallback',
    '  --submit-selector <value>   Stable submit selector',
    '  --submit-target <ref>       Cached submit ref fallback',
    '  --result-text <text>        Exact text wait',
    '  --result-selector <value>   Exact selector wait',
    '  --result-scope <value>      Scoped snapshot fallback',
    '  --snapshot-depth <1..20>    Snapshot depth, default 8',
    '',
    'Execution:',
    '  --profile <fresh|warm|both> Profiles to measure, default both',
    '  --runs <3..20>              Measured runs per profile after one warmup, default 3',
    '  --timeout-ms <ms>           Absolute timeout per action, default 60000',
    '  --controller-home <path>    Defaults to FORGE_CONTROLLER_HOME or _ops/controller-home',
    '  --repo-root <path>          Defaults to current working directory',
    '  --relaunch                  Relaunch JD for each fresh run and the warm-profile setup open',
    '  --json                      Emit machine-readable JSON',
  ].join('\n');
}

interface BenchmarkContext {
  controllerHome: string;
  repoId: string;
  repoRoot: string;
  device: string;
  query: string;
  timeoutMs: number;
  relaunch: boolean;
  runs: number;
  baseArgs: Record<string, unknown>;
  runNonce: string;
}

async function executeAction(
  context: BenchmarkContext,
  actionId: string,
  suffix: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return executeIosAgentDeviceAction({
    controllerHome: context.controllerHome,
    repoId: context.repoId,
    repoRoot: context.repoRoot,
    pluginId: 'ios',
    actionId,
    requestId: `ios-latency-benchmark-${context.runNonce}-${suffix}`,
    args,
    timeoutMs: context.timeoutMs,
    origin: { surface: 'local-ui', actor: 'ios-latency-benchmark' },
  });
}

async function executeSearchSample(
  context: BenchmarkContext,
  profile: BenchmarkProfile,
  index: number,
  args: Record<string, unknown>,
): Promise<IosBenchmarkSample> {
  const startedAt = performance.now();
  const result = await executeAction(context, 'agent_device_jd_search', `${profile}-${index}`, args);
  return sampleFromResult(profile, index, index === 0, performance.now() - startedAt, result);
}

async function runFreshSessionProfile(context: BenchmarkContext): Promise<IosBenchmarkProfileReport> {
  const samples: IosBenchmarkSample[] = [];
  for (let index = 0; index <= context.runs; index += 1) {
    samples.push(await executeSearchSample(context, 'fresh_session', index, {
      ...context.baseArgs,
      relaunch: context.relaunch,
      keep_session: false,
      capture_screenshot: true,
    }));
  }
  return {
    profile: 'fresh_session',
    warmupCount: 1,
    measuredRunCount: context.runs,
    measured: summarizeProfileSamples(samples),
    samples,
  };
}

async function runReusedSessionProfile(context: BenchmarkContext): Promise<IosBenchmarkProfileReport> {
  const openStartedAt = performance.now();
  const opened = await executeAction(context, 'agent_device_open', 'warm-open', {
    app: JD_BUNDLE_ID,
    device: context.device,
    relaunch: context.relaunch,
  });
  const openMs = rounded(performance.now() - openStartedAt);
  const interaction = stringRecord(opened.interaction);
  const interactionId = typeof interaction?.interactionId === 'string' ? interaction.interactionId : undefined;
  if (!interactionId) throw new Error('agent_device_open did not return an interaction_id');

  const samples: IosBenchmarkSample[] = [];
  let closeMs = 0;
  let cleanupCompleted = false;
  try {
    for (let index = 0; index <= context.runs; index += 1) {
      samples.push(await executeSearchSample(context, 'reused_session', index, {
        ...context.baseArgs,
        interaction_id: interactionId,
        keep_session: true,
        capture_screenshot: false,
        relaunch: false,
      }));
    }
  } finally {
    const closeStartedAt = performance.now();
    try {
      await executeAction(context, 'agent_device_close', 'warm-close', { interaction_id: interactionId });
      cleanupCompleted = true;
    } finally {
      closeMs = rounded(performance.now() - closeStartedAt);
    }
  }
  return {
    profile: 'reused_session',
    warmupCount: 1,
    measuredRunCount: context.runs,
    setup: { openMs },
    cleanup: { closeMs, completed: cleanupCompleted },
    measured: summarizeProfileSamples(samples),
    samples,
  };
}

export async function runBenchmark(): Promise<Record<string, unknown>> {
  if (hasFlag('help')) {
    console.log(usage());
    return { help: true };
  }
  const repoId = requiredOption('repo-id');
  const device = requiredOption('device');
  const query = requiredOption('query');
  const runs = integerOption('runs', 3, 3, 20);
  const timeoutMs = integerOption('timeout-ms', 60_000, 1_000, 600_000);
  const snapshotDepth = integerOption('snapshot-depth', 8, 1, 20);
  const repoRoot = resolve(option('repo-root') ?? process.cwd());
  const controllerHome = resolve(
    option('controller-home')
      ?? process.env.FORGE_CONTROLLER_HOME
      ?? resolve(repoRoot, '_ops/controller-home'),
  );
  const baseArgs: Record<string, unknown> = { device, query, snapshot_depth: snapshotDepth };
  for (const [flag, key] of [
    ['search-selector', 'search_selector'],
    ['search-target', 'search_target'],
    ['submit-selector', 'submit_selector'],
    ['submit-target', 'submit_target'],
    ['result-text', 'result_text'],
    ['result-selector', 'result_selector'],
    ['result-scope', 'result_scope'],
  ] as const) {
    const value = option(flag)?.trim();
    if (value) baseArgs[key] = value;
  }
  const profiles = selectedProfiles();
  const context: BenchmarkContext = {
    controllerHome,
    repoId,
    repoRoot,
    device,
    query,
    timeoutMs,
    relaunch: hasFlag('relaunch'),
    runs,
    baseArgs,
    runNonce: `${Date.now()}-${process.pid}`,
  };

  const reports: Partial<Record<BenchmarkProfile, IosBenchmarkProfileReport>> = {};
  for (const profile of profiles) {
    reports[profile] = profile === 'fresh_session'
      ? await runFreshSessionProfile(context)
      : await runReusedSessionProfile(context);
  }
  const comparison = compareProfileReports(reports.fresh_session, reports.reused_session);
  return {
    schemaVersion: 2,
    kind: 'ios_agent_device_latency_benchmark',
    generatedAt: new Date().toISOString(),
    environment: {
      repoId,
      device,
      relaunch: context.relaunch,
      profiles,
      measuredRunsPerProfile: runs,
      warmupsPerProfile: 1,
      timeoutMs,
      evidenceInputs: {
        hasSearchSelector: typeof baseArgs.search_selector === 'string',
        hasSearchTarget: typeof baseArgs.search_target === 'string',
        hasSubmitSelector: typeof baseArgs.submit_selector === 'string',
        hasSubmitTarget: typeof baseArgs.submit_target === 'string',
        hasResultText: typeof baseArgs.result_text === 'string',
        hasResultSelector: typeof baseArgs.result_selector === 'string',
        resultScope: baseArgs.result_scope ?? null,
        snapshotDepth,
      },
    },
    profiles: reports,
    ...(comparison ? { comparison } : {}),
    note: 'Results are actual provider executions. No historical or unavailable device data is synthesized. Fresh-session and reused-session have intentionally different setup, screenshot, and cleanup costs.',
  };
}

if (import.meta.main) {
  try {
    const report = await runBenchmark();
    if (!('help' in report)) {
      if (hasFlag('json')) console.log(JSON.stringify(report, null, 2));
      else {
        console.log('iOS agent-device latency benchmark');
        console.log(JSON.stringify({ profiles: report.profiles, comparison: report.comparison }, null, 2));
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('\n' + usage());
    process.exitCode = 1;
  }
}
