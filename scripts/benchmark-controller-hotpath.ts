#!/usr/bin/env bun

/**
 * Repeatable controller_context hot-path benchmark.
 *
 * This intentionally uses isolated temporary repositories so it does not
 * mutate the checkout being developed. Output is JSON for CI/local comparison.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { getToolPolicy } from '../src/runtime/control-plane/tool-policy';
import { createMcpToolContext } from '../adapters/mcp/multi-repository';
import { exposedControllerToolDefinitions } from '../adapters/mcp/toolset';
import {
  cachedGitIdentity,
  clearGitIdentityCacheForTest,
  clearGitSnapshotCacheForTest,
  gitIdentityPerformanceSnapshot,
  gitSnapshot,
  gitSnapshotPerformanceSnapshot,
} from '../src/runtime/repositories/inspector';
import { registerRepository } from '../src/runtime/repositories/registry';
import { callRuntimeTool } from '../adapters/mcp/runtime-gateway/runtime-tools';
import type { MultiRepositoryMcpToolContext } from '../adapters/mcp/multi-repository';

const HOT_READS = 30;
const COLD_GIT_READS = 20;
const SCALES = [0, 25, 100, 200];

function gitInit(repoRoot: string): void {
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'hotpath-benchmark'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'hotpath@example.invalid'], { cwd: repoRoot, stdio: 'ignore' });
  writeFileSync(join(repoRoot, 'README.md'), 'controller hotpath benchmark\n');
  spawnSync('git', ['add', 'README.md'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['commit', '-m', 'benchmark fixture'], { cwd: repoRoot, stdio: 'ignore' });
}

export function percentile(values: number[], quantile: number): number {
  if (values.length === 0) throw new Error('CONTROLLER_HOTPATH_PERCENTILE_EMPTY_SAMPLE');
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
    throw new Error('CONTROLLER_HOTPATH_PERCENTILE_INVALID_QUANTILE');
  }
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error('CONTROLLER_HOTPATH_PERCENTILE_INVALID_SAMPLE');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(sorted.length * quantile));
  return sorted[rank - 1]!;
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const startedAt = performance.now();
  const value = fn();
  return { value, ms: Math.round((performance.now() - startedAt) * 100) / 100 };
}

function writeIssueFixture(repoRoot: string, index: number): void {
  const id = `ISS-BENCH-${String(index).padStart(4, '0')}`;
  const slug = `fixture-${index}`;
  writeFileSync(join(repoRoot, 'tasks', 'issues', `${id}-${slug}.issue.json`), `${JSON.stringify({
    schemaVersion: 5,
    id,
    slug,
    kind: 'feature',
    status: 'planned',
    title: `Benchmark Issue ${index}`,
    summary: 'Synthetic controller hotpath fixture.',
    goals: [],
    nonGoals: [],
    acceptanceCriteria: [],
    tasks: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    repoId: 'benchmark',
  }, null, 2)}\n`);
}

export function duration(result: { isError?: boolean; structuredContent?: unknown; content?: Array<{ text?: string }> } | undefined): { ms: number; bytes: number; cacheHit: boolean; phaseTimingsMs: Record<string, number>; largestFields: Array<{ key: string; bytes: number }> } {
  if (result?.isError === true) throw new Error('CONTROLLER_HOTPATH_TOOL_ERROR: benchmark cannot time a failed tool call');
  const value = (result?.structuredContent
    ?? JSON.parse(result?.content?.[0]?.text ?? '{}')) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.status === 'error') {
    throw new Error('CONTROLLER_HOTPATH_TOOL_ERROR: benchmark requires a successful tool result');
  }
  const responseMeta = (value.responseMeta ?? {}) as Record<string, unknown>;
  const serverDurationMs = responseMeta.serverDurationMs;
  if (typeof serverDurationMs !== 'number' || !Number.isFinite(serverDurationMs) || serverDurationMs < 0) {
    throw new Error('CONTROLLER_HOTPATH_SERVER_DURATION_MISSING: no valid responseMeta.serverDurationMs');
  }
  const projection = (value.contextProjection ?? {}) as Record<string, unknown>;
  return {
    ms: serverDurationMs,
    bytes: Buffer.byteLength(JSON.stringify(value), 'utf8'),
    cacheHit: responseMeta.cacheHit === true || projection.cacheHit === true,
    phaseTimingsMs: responseMeta.phaseTimingsMs && typeof responseMeta.phaseTimingsMs === 'object'
      ? responseMeta.phaseTimingsMs as Record<string, number>
      : {},
    largestFields: Object.entries(value)
      .map(([key, field]) => ({ key, bytes: Buffer.byteLength(JSON.stringify(field) ?? 'null', 'utf8') }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 4),
  };
}

async function benchmarkScale(scale: number): Promise<Record<string, unknown>> {
  const workspace = mkdtempSync(join(tmpdir(), 'forge-hotpath-'));
  try {
    const controllerHome = join(workspace, 'controller-home');
    const repoRoot = join(workspace, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(join(repoRoot, 'tasks', 'issues'), { recursive: true });
    gitInit(repoRoot);
    for (let index = 0; index < scale; index += 1) writeIssueFixture(repoRoot, index);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: `scale-${scale}` });
    const ctx = createMcpToolContext({
      repo: repoRoot,
      profile: 'controller',
      controllerHome,
    }) as unknown as MultiRepositoryMcpToolContext;

    const coldSummary = duration(await callRuntimeTool(ctx, 'controller_context', { repo_id: repository.repoId }));
    const sectionReadResult = await callRuntimeTool(ctx, 'controller_context', {
      repo_id: repository.repoId,
      sections: ['git', 'focus'],
    });
    const sectionRead = duration(sectionReadResult);
    const sectionValue = (sectionReadResult?.structuredContent
      ?? JSON.parse(sectionReadResult?.content?.[0]?.text ?? '{}')) as Record<string, unknown>;
    const returnedSections = sectionValue.sections && typeof sectionValue.sections === 'object'
      ? sectionValue.sections as Record<string, unknown>
      : {};
    if (sectionValue.detailLevel !== 'sections' || !('git' in returnedSections) || !('focus' in returnedSections)
      || 'taskLedger' in returnedSections || 'readiness' in returnedSections) {
      throw new Error('CONTROLLER_CONTEXT_SECTION_SELECTION_FAILED: requested sections were not isolated');
    }
    const coldResult = await callRuntimeTool(ctx, 'controller_context', { repo_id: repository.repoId, detail_level: 'detail' });
    const cold = duration(coldResult!);
    const samples: number[] = [];
    let cacheHits = 0;
    let maxSummaryBytes = 0;
    let lastHotSample = cold;
    for (let index = 0; index < HOT_READS; index += 1) {
      const sample = duration(await callRuntimeTool(ctx, 'controller_context', { repo_id: repository.repoId }));
      lastHotSample = sample;
      samples.push(sample.ms);
      cacheHits += sample.cacheHit ? 1 : 0;
      maxSummaryBytes = Math.max(maxSummaryBytes, sample.bytes);
    }
    return {
      scale,
      coldSummaryMs: coldSummary.ms,
      coldSummaryPhaseTimingsMs: coldSummary.phaseTimingsMs,
      coldSummaryResponseBytes: coldSummary.bytes,
      requestedSectionReadMs: sectionRead.ms,
      requestedSectionResponseBytes: sectionRead.bytes,
      coldMs: cold.ms,
      coldPhaseTimingsMs: cold.phaseTimingsMs,
      coldResponseBytes: cold.bytes,
      hotP50Ms: percentile(samples, 0.5),
      hotP95Ms: percentile(samples, 0.95),
      hotMaxMs: Math.max(...samples, 0),
      cacheHits,
      cacheHitRate: cacheHits / HOT_READS,
      maxSummaryBytes,
      largestHotFields: lastHotSample.largestFields,
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function benchmarkGitSampling(): Record<string, unknown> {
  const workspace = mkdtempSync(join(tmpdir(), 'forge-git-sampling-'));
  try {
    gitInit(workspace);
    const coldSamples: number[] = [];
    for (let index = 0; index < COLD_GIT_READS; index += 1) {
      clearGitIdentityCacheForTest();
      coldSamples.push(timed(() => cachedGitIdentity(workspace)).ms);
    }

    clearGitIdentityCacheForTest();
    cachedGitIdentity(workspace);
    const warmSamples: number[] = [];
    for (let index = 0; index < HOT_READS; index += 1) {
      warmSamples.push(timed(() => cachedGitIdentity(workspace)).ms);
    }
    const identityCounters = gitIdentityPerformanceSnapshot();

    clearGitIdentityCacheForTest();
    clearGitSnapshotCacheForTest();
    const snapshot = timed(() => gitSnapshot(workspace));
    return {
      coldReads: COLD_GIT_READS,
      coldP50Ms: percentile(coldSamples, 0.5),
      coldP95Ms: percentile(coldSamples, 0.95),
      warmReads: HOT_READS,
      warmP50Ms: percentile(warmSamples, 0.5),
      warmP95Ms: percentile(warmSamples, 0.95),
      identityCounters,
      snapshotMs: snapshot.ms,
      snapshotCounters: gitSnapshotPerformanceSnapshot(),
      snapshotIdentityCounters: gitIdentityPerformanceSnapshot(),
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

export function controllerHotpathAcceptance(scales: Array<{ scale: number; coldSummaryMs: number; coldSummaryResponseBytes: number; coldSummaryPhaseTimingsMs: Record<string, number>; hotP95Ms: number; maxSummaryBytes: number }>, gitSampling: { identityCounters: { subprocesses: number }; snapshotCounters: { subprocesses: number }; snapshotIdentityCounters: { subprocesses: number } }) {
  const thresholds = { coldSummaryMs: 25, maxColdSummaryBytes: 8 * 1024, warmP95Ms: 100, maxSummaryBytes: 32 * 1024, identitySubprocessesPerSample: 1, snapshotUniqueSubprocesses: 2 };
  const forbiddenSummaryPhases = ['gitIdentity', 'build.task_board', 'build.task_ledger', 'build.readiness', 'build.git', 'build.jobs', 'build.checks', 'build.plugins'];
  const failures: string[] = [];
  for (const scale of scales) {
    if (!Number.isFinite(scale.coldSummaryMs) || scale.coldSummaryMs < 0 || scale.coldSummaryMs > thresholds.coldSummaryMs) failures.push(`scale=${scale.scale}: coldSummaryMs=${scale.coldSummaryMs}`);
    if (!Number.isFinite(scale.coldSummaryResponseBytes) || scale.coldSummaryResponseBytes < 1 || scale.coldSummaryResponseBytes > thresholds.maxColdSummaryBytes) failures.push(`scale=${scale.scale}: coldSummaryResponseBytes=${scale.coldSummaryResponseBytes}`);
    const eagerPhases = forbiddenSummaryPhases.filter((phase) => Object.hasOwn(scale.coldSummaryPhaseTimingsMs, phase));
    if (eagerPhases.length) failures.push(`scale=${scale.scale}: summary eagerly executed ${eagerPhases.join(', ')}`);
    if (!Number.isFinite(scale.hotP95Ms) || scale.hotP95Ms < 0 || scale.hotP95Ms > thresholds.warmP95Ms) failures.push(`scale=${scale.scale}: hotP95Ms=${scale.hotP95Ms}`);
    if (!Number.isFinite(scale.maxSummaryBytes) || scale.maxSummaryBytes < 1 || scale.maxSummaryBytes > thresholds.maxSummaryBytes) failures.push(`scale=${scale.scale}: maxSummaryBytes=${scale.maxSummaryBytes}`);
  }
  if (!scales.length) failures.push('no scale samples');
  if (!Number.isFinite(gitSampling.identityCounters.subprocesses) || gitSampling.identityCounters.subprocesses > thresholds.identitySubprocessesPerSample) failures.push('git identity subprocess budget exceeded');
  const snapshotProcesses = gitSampling.snapshotCounters.subprocesses + gitSampling.snapshotIdentityCounters.subprocesses;
  if (!Number.isFinite(snapshotProcesses) || snapshotProcesses > thresholds.snapshotUniqueSubprocesses) failures.push('git snapshot subprocess budget exceeded');
  return { ...thresholds, passed: failures.length === 0, failures };
}

async function main(): Promise<void> {
  const scaleResults = [];
  for (const scale of SCALES) scaleResults.push(await benchmarkScale(scale));
  const gitSampling = benchmarkGitSampling();
  const profileRepo = mkdtempSync(join(tmpdir(), 'forge-tool-profile-'));
  try {
    const controllerHome = join(profileRepo, 'controller-home');
    const repoRoot = join(profileRepo, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    gitInit(repoRoot);
    const ctx = createMcpToolContext({ repo: repoRoot, profile: 'controller', controllerHome }) as MultiRepositoryMcpToolContext;
    const exposedTools = exposedControllerToolDefinitions(ctx).length;
    const acceptance = controllerHotpathAcceptance(scaleResults as Array<{ scale: number; coldSummaryMs: number; coldSummaryResponseBytes: number; coldSummaryPhaseTimingsMs: Record<string, number>; hotP95Ms: number; maxSummaryBytes: number }>, gitSampling as { identityCounters: { subprocesses: number }; snapshotCounters: { subprocesses: number }; snapshotIdentityCounters: { subprocesses: number } });
    console.log(JSON.stringify({
      benchmark: 'controller-hotpath',
      hotReads: HOT_READS,
      scales: scaleResults,
      gitSampling,
      exposedTools,
      acceptance,
    }, null, 2));
    if (!acceptance.passed) throw new Error(`CONTROLLER_HOTPATH_ACCEPTANCE_FAILED: ${acceptance.failures.join('; ')}`);
  } finally {
    rmSync(profileRepo, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
