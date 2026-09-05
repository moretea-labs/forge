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
  const generatedHome = suppliedHome ? undefined : mkdtempSync(join(tmpdir(), 'forge-benchmark-round2-'));
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
    writeFileSync(join(repoRoot, '.forge-benchmark-round2-touch'), `${Date.now()}\n`);
    const stale = await call(context, 'controller_context', { repo_id: repository.repoId });
    rmSync(join(repoRoot, '.forge-benchmark-round2-touch'), { force: true });
    const detail = await call(context, 'controller_context', { repo_id: repository.repoId, detail_level: 'detail' });
    const concurrent = await Promise.all(Array.from({ length: 30 }, () => call(context, 'controller_context', { repo_id: repository.repoId })));
    const timings = concurrent.map((item) => item.elapsedMs);
    const readiness = await call(context, 'controller_ready', { repo_id: repository.repoId });
    const statusSummary = await call(context, 'rh_status', { repo_id: repository.repoId, operation: 'get', detail_level: 'summary' });
    const statusDetail = await call(context, 'rh_status', { repo_id: repository.repoId, operation: 'get', detail_level: 'detail' });
    const replacementContext = createMcpToolContext({
      repo: repoRoot,
      controllerHome,
      profile: 'controller',
      toolset: 'advanced',
      sessionId: `benchmark-round2-replacement-${Date.now()}`,
    });
    const replacementSessionContext = await call(replacementContext, 'controller_context', { repo_id: repository.repoId });
    const checkpointStartedAt = performance.now();
    const checkpointStatus = await call(context, 'rh_status', { repo_id: repository.repoId, operation: 'get', detail_level: 'summary' });
    const checkpointContext = await call(context, 'controller_context', { repo_id: repository.repoId });
    const checkpointElapsedMs = Math.round((performance.now() - checkpointStartedAt) * 100) / 100;
    const checkpointCalls = [checkpointStatus, checkpointContext];
    const checkpointStatuses = checkpointCalls.map((entry) => {
      const facadeStatus = typeof entry.value.status === 'string' ? entry.value.status : undefined;
      const contextHealth = entry.value?.health && typeof entry.value.health === 'object' ? entry.value.health as Record<string, unknown> : undefined;
      const status = facadeStatus ?? (contextHealth ? (contextHealth.ready === true ? 'ok' : 'blocked') : 'unknown');
      const facadeReasons = entry.value?.data?.readiness?.reasonCodes;
      const contextReasons = contextHealth?.reasonCodes;
      const reasonCodes = Array.isArray(facadeReasons)
        ? facadeReasons.map(String)
        : Array.isArray(contextReasons) ? contextReasons.map(String) : [];
      return { status, reasonCodes };
    });
    const checkpointNonOk = checkpointStatuses.filter((entry) => entry.status !== 'ok');
    const performanceDiagnostics = await call(context, 'runtime_performance_diagnostics', {
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
        status: {
          summary: { elapsedMs: statusSummary.elapsedMs, bytes: bytes(statusSummary.value), responseMeta: responseMeta(statusSummary.value) },
          detail: { elapsedMs: statusDetail.elapsedMs, bytes: bytes(statusDetail.value), responseMeta: responseMeta(statusDetail.value) },
        },
        replacementSessionContext: {
          elapsedMs: replacementSessionContext.elapsedMs,
          bytes: bytes(replacementSessionContext.value),
          responseMeta: responseMeta(replacementSessionContext.value),
          interpretation: 'persistent projection reuse across controller-session replacement; not a Runtime restart measurement',
        },
        controllerCheckpoint: {
          elapsedMs: checkpointElapsedMs,
          toolRoundTrips: checkpointCalls.length,
          nonOkCount: checkpointNonOk.length,
          nonOkRate: checkpointCalls.length > 0 ? checkpointNonOk.length / checkpointCalls.length : 0,
          statuses: checkpointStatuses,
          statusMs: checkpointStatus.elapsedMs,
          contextMs: checkpointContext.elapsedMs,
          usable: checkpointNonOk.length === 0,
          environment: generatedHome ? 'synthetic_controller_home' : 'supplied_controller_home',
        },
        runtimeRestartContextClosure: {
          status: 'not_measured',
          reason: 'This local benchmark does not own Runtime restart authority; Mac Recovery certification must bind restart-to-first-usable-context latency to the activated revision.',
        },
      },
      transportPhases: {
        local: { status: 'measured', path: 'direct multi-repository runtime tool' },
        external: { status: 'unavailable', reason: 'No external endpoint was supplied to this local benchmark.' },
      },
      resourceCost: performanceDiagnostics.value.resourceCost ?? {},
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
