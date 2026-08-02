import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createMcpToolContext } from '../src/cli/mcp/multi-repository';
import { callRuntimeTool } from '../src/runtime/gateway/mcp/runtime-tools';
import { exposedControllerToolDefinitions } from '../src/cli/mcp/toolset';
import { registerRepository } from '../src/cli/repositories/registry';

type ToolCall = { value: Record<string, any>; elapsedMs: number };

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function revision(repoRoot: string): string | undefined {
  try { return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return undefined; }
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

async function call(ctx: ReturnType<typeof createMcpToolContext>, name: string, args: Record<string, unknown> = {}): Promise<ToolCall> {
  const startedAt = performance.now();
  const response = await callRuntimeTool(ctx, name, args);
  if (!response) throw new Error(`benchmark tool returned no result: ${name}`);
  const raw = response.content?.[0]?.text ?? '{}';
  const value = (response.structuredContent ?? JSON.parse(raw)) as Record<string, any>;
  return { value, elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100 };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

async function main(): Promise<void> {
  const repoRoot = arg('--repo') ?? process.cwd();
  const suppliedHome = arg('--controller-home');
  const generatedHome = suppliedHome ? undefined : mkdtempSync(join(tmpdir(), 'repo-harness-benchmark-round2-'));
  const controllerHome = suppliedHome ?? generatedHome!;
  mkdirSync(controllerHome, { recursive: true });
  const repository = registerRepository({ path: repoRoot, controllerHome });
  const base = {
    schemaVersion: 2,
    revision: revision(repoRoot),
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    repositoryRoot: repoRoot,
    controllerHome,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      node: process.version,
    },
  };

  try {
    const context = createMcpToolContext({
      repo: repoRoot,
      controllerHome,
      profile: 'controller',
      toolset: 'advanced',
      sessionId: `benchmark-round2-${Date.now()}`,
    });
    const cold = await call(context, 'controller_context', { repo_id: repository.repoId });
    const fresh = await call(context, 'controller_context', { repo_id: repository.repoId });
    writeFileSync(join(repoRoot, '.repo-harness-benchmark-round2-touch'), `${Date.now()}\n`);
    const stale = await call(context, 'controller_context', { repo_id: repository.repoId });
    rmSync(join(repoRoot, '.repo-harness-benchmark-round2-touch'), { force: true });
    const detail = await call(context, 'controller_context', { repo_id: repository.repoId, detail_level: 'detail' });
    const concurrent = await Promise.all(Array.from({ length: 30 }, () => call(context, 'controller_context', { repo_id: repository.repoId })));
    const timings = concurrent.map((item) => item.elapsedMs);
    const readiness = await call(context, 'controller_ready', { repo_id: repository.repoId });
    const performance = await call(context, 'runtime_performance_diagnostics', {
      repo_id: repository.repoId,
      include_processes: false,
      include_temp_dirs: false,
    });

    const toolSurface: Record<string, unknown> = {};
    for (const toolset of ['core', 'advanced', 'full'] as const) {
      const toolContext = createMcpToolContext({ repo: repoRoot, controllerHome, profile: 'controller', toolset });
      const definitions = exposedControllerToolDefinitions(toolContext);
      toolSurface[toolset] = {
        toolCount: definitions.length,
        schemaBytes: definitions.reduce((total, tool) => total + bytes(tool.inputSchema), 0),
        responseBytes: bytes(definitions),
        p50Ms: undefined,
        p95Ms: undefined,
      };
    }
    const surfaceRecord = toolSurface.advanced as Record<string, unknown>;
    surfaceRecord.p50Ms = percentile(timings, 0.5);
    surfaceRecord.p95Ms = percentile(timings, 0.95);

    const responseMeta = (value: Record<string, any>) => value.responseMeta ?? {};
    const result = {
      ...base,
      scenarios: {
        contextProjection: {
          cold: { elapsedMs: cold.elapsedMs, bytes: bytes(cold.value), responseMeta: responseMeta(cold.value) },
          fresh: { elapsedMs: fresh.elapsedMs, bytes: bytes(fresh.value), responseMeta: responseMeta(fresh.value) },
          stale: { elapsedMs: stale.elapsedMs, bytes: bytes(stale.value), responseMeta: responseMeta(stale.value) },
          detail: { elapsedMs: detail.elapsedMs, bytes: bytes(detail.value), responseMeta: responseMeta(detail.value) },
          concurrentSummary: {
            count: concurrent.length,
            p50Ms: percentile(timings, 0.5),
            p95Ms: percentile(timings, 0.95),
            maxMs: Math.max(...timings),
            bytes: concurrent.map((item) => bytes(item.value)),
          },
        },
        readiness: { elapsedMs: readiness.elapsedMs, bytes: bytes(readiness.value) },
      },
      transportPhases: {
        local: { status: 'measured', path: 'direct multi-repository runtime tool' },
        external: { status: 'unavailable', reason: 'No external endpoint was supplied to this local benchmark.' },
      },
      resourceCost: performance.value.resourceCost ?? {},
      toolSurface,
      budgets: {
        controllerContextSummaryBytes: 32 * 1024,
        summaryBytes: bytes(fresh.value),
        summaryWithinBudget: bytes(fresh.value) <= 32 * 1024,
      },
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    if (generatedHome) rmSync(generatedHome, { recursive: true, force: true });
  }
}

await main();
