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
import { getMcpPolicy } from '../src/cli/mcp/policy';
import { createMcpToolContext } from '../src/cli/mcp/multi-repository';
import { exposedControllerToolDefinitions } from '../src/cli/mcp/toolset';
import { registerRepository } from '../src/cli/repositories/registry';
import { callRuntimeTool } from '../src/runtime/gateway/mcp/runtime-tools';
import type { MultiRepositoryMcpToolContext } from '../src/cli/mcp/multi-repository';

const HOT_READS = 30;
const SCALES = [0, 25, 100, 200];

function gitInit(repoRoot: string): void {
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'hotpath-benchmark'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'hotpath@example.invalid'], { cwd: repoRoot, stdio: 'ignore' });
  writeFileSync(join(repoRoot, 'README.md'), 'controller hotpath benchmark\n');
  spawnSync('git', ['add', 'README.md'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['commit', '-m', 'benchmark fixture'], { cwd: repoRoot, stdio: 'ignore' });
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

function duration(result: { structuredContent?: unknown; content?: Array<{ text?: string }> } | undefined): { ms: number; bytes: number; cacheHit: boolean; largestFields: Array<{ key: string; bytes: number }> } {
  const value = (result?.structuredContent
    ?? JSON.parse(result?.content?.[0]?.text ?? '{}')) as Record<string, unknown>;
  const responseMeta = (value.responseMeta ?? {}) as Record<string, unknown>;
  const projection = (value.contextProjection ?? {}) as Record<string, unknown>;
  return {
    ms: typeof responseMeta.serverDurationMs === 'number' ? responseMeta.serverDurationMs : 0,
    bytes: Buffer.byteLength(JSON.stringify(value), 'utf8'),
    cacheHit: responseMeta.cacheHit === true || projection.cacheHit === true,
    largestFields: Object.entries(value)
      .map(([key, field]) => ({ key, bytes: Buffer.byteLength(JSON.stringify(field) ?? 'null', 'utf8') }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 4),
  };
}

async function benchmarkScale(scale: number): Promise<Record<string, unknown>> {
  const workspace = mkdtempSync(join(tmpdir(), 'repo-harness-hotpath-'));
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
      toolset: 'advanced',
      controllerHome,
    }) as unknown as MultiRepositoryMcpToolContext;

    const coldSummary = duration(await callRuntimeTool(ctx, 'controller_context', { repo_id: repository.repoId }));
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
    const sorted = [...samples].sort((a, b) => a - b);
    return {
      scale,
      coldSummaryMs: coldSummary.ms,
      coldSummaryResponseBytes: coldSummary.bytes,
      coldMs: cold.ms,
      coldResponseBytes: cold.bytes,
      hotP50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
      hotP95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
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

async function main(): Promise<void> {
  const scaleResults = [];
  for (const scale of SCALES) scaleResults.push(await benchmarkScale(scale));
  const profileRepo = mkdtempSync(join(tmpdir(), 'repo-harness-tool-profile-'));
  try {
    const controllerHome = join(profileRepo, 'controller-home');
    const repoRoot = join(profileRepo, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    gitInit(repoRoot);
    const counts: Record<string, number> = {};
    for (const toolset of ['core', 'advanced', 'full'] as const) {
      const ctx = createMcpToolContext({ repo: repoRoot, profile: 'controller', toolset, controllerHome }) as unknown as MultiRepositoryMcpToolContext;
      counts[toolset] = exposedControllerToolDefinitions(ctx).length;
    }
    console.log(JSON.stringify({
      benchmark: 'controller-hotpath',
      hotReads: HOT_READS,
      scales: scaleResults,
      toolsetCounts: counts,
      acceptance: {
        warmP95Ms: 100,
        maxSummaryBytes: 32 * 1024,
        coreMaxTools: 20,
      },
    }, null, 2));
  } finally {
    rmSync(profileRepo, { recursive: true, force: true });
  }
}

await main();
