#!/usr/bin/env bun
import { readFileSync } from 'fs';
import { performance } from 'perf_hooks';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readMcpServiceBearerToken } from '../adapters/mcp/auth';
import { resolveRepoPreferredControllerHome } from '../src/effects/controller-home';
import {
  aggregateMcpTransportLatencySamples,
  extractForgeServerDuration,
  normalizeMcpTransportLatencySample,
  mcpServerStartSpreadMs,
  type McpTransportLatencySample,
} from '../src/runtime/diagnostics/mcp-transport-benchmark';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function integerAtLeast(name: string, fallback: number, minimum: number): number {
  const raw = option(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    const requirement = minimum === 0 ? 'a non-negative integer' : `an integer >= ${minimum}`;
    throw new Error(`${name} must be ${requirement}`);
  }
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  return integerAtLeast(name, fallback, 1);
}

function readSamples(path: string): McpTransportLatencySample[] {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    const values = JSON.parse(text);
    if (!Array.isArray(values)) throw new Error('--input JSON must be an array or JSONL');
    return values.map(normalizeMcpTransportLatencySample);
  }
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => normalizeMcpTransportLatencySample(JSON.parse(line)));
}

export function timingLedgerServerDuration(
  path: string | undefined,
  tool: string,
  meta: Record<string, unknown>,
): number | undefined {
  if (!path) return undefined;
  const traceId = typeof meta.traceId === 'string' ? meta.traceId : undefined;
  const requestId = typeof meta.requestId === 'string' ? meta.requestId : undefined;
  if (!traceId && !requestId) return undefined;
  try {
    const text = readFileSync(path, 'utf8').trim();
    if (!text) return undefined;
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(lines[index]!) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (value.tool !== tool) continue;
      if (traceId && value.traceId !== traceId) continue;
      if (requestId && value.requestId !== requestId) continue;
      const duration = value.totalToolDurationMs;
      if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) return duration;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export interface McpConcurrentBatch<T> {
  batchIndex: number;
  clientBatchTotalMs: number;
  outcomes: PromiseSettledResult<T>[];
}

// Requests within a batch start together; batches themselves are sequential.
// allSettled preserves failures and prevents one rejection from hiding sibling outcomes.
export async function runMcpConcurrentBatches<T>(
  count: number,
  concurrency: number,
  call: (requestIndex: number, batchIndex: number) => Promise<T>,
): Promise<McpConcurrentBatch<T>[]> {
  if (!Number.isInteger(count) || count < 0 || !Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('MCP_TRANSPORT_BATCH_INVALID: count must be non-negative and concurrency positive');
  }
  const batches: McpConcurrentBatch<T>[] = [];
  for (let start = 0; start < count; start += concurrency) {
    const batchIndex = batches.length;
    const started = performance.now();
    const outcomes = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, count - start) }, (_, offset) => call(start + offset, batchIndex)),
    );
    batches.push({ batchIndex, clientBatchTotalMs: performance.now() - started, outcomes });
  }
  return batches;
}

interface ProbeResult {
  samples: McpTransportLatencySample[];
  failures: Array<{ requestIndex: number; batchIndex: number; error: string }>;
  batches: Array<{
    batchIndex: number;
    attemptCount: number;
    successCount: number;
    failureCount: number;
    clientBatchTotalMs: number;
    serverStartSpreadMs?: number;
  }>;
}

async function probe(): Promise<ProbeResult> {
  const endpointRaw = option('--endpoint');
  if (!endpointRaw) throw new Error('--endpoint is required unless --input is used');
  const endpoint = new URL(endpointRaw);
  const label = option('--label')?.trim() || endpoint.hostname;
  const tool = option('--tool')?.trim() || 'rh_status';
  const iterations = positiveInteger('--iterations', 30);
  const concurrency = positiveInteger('--concurrency', 1);
  const warmup = integerAtLeast('--warmup', 3, 0);
  const timeoutMs = positiveInteger('--timeout-ms', 120_000);
  const timingLog = option('--timing-log')?.trim();
  const includeConnect = process.argv.includes('--include-connect');
  const timingScope = includeConnect ? ('connect_and_tool_call' as const) : ('tool_call' as const);
  const tokenEnv = option('--token-env')?.trim() || 'FORGE_MCP_BENCH_TOKEN';
  const localServiceAuth = process.argv.includes('--local-service-auth');
  const token =
    process.env[tokenEnv]?.trim() ||
    (localServiceAuth
      ? readMcpServiceBearerToken(resolveRepoPreferredControllerHome(process.cwd()))?.trim()
      : undefined);
  if (!token) {
    throw new Error(
      localServiceAuth
        ? 'MCP_BENCH_LOCAL_SERVICE_TOKEN_UNAVAILABLE: no local Forge service bearer credential was found'
        : `${tokenEnv} is not set; use --local-service-auth on the Forge host or keep benchmark bearer credentials in the environment, never CLI args`,
    );
  }
  const argumentsRaw = option('--arguments');
  const args = argumentsRaw ? (JSON.parse(argumentsRaw) as Record<string, unknown>) : {};
  const repoId = option('--repo-id')?.trim();
  if (repoId && args.repo_id === undefined) args.repo_id = repoId;

  const createClient = () => {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: 'forge-mcp-transport-benchmark', version: '1.0.0' });
    return { client, transport };
  };
  const steadyState = includeConnect ? undefined : createClient();
  const call = async (): Promise<{
    response: unknown;
    totalMs: number;
    clientStartedAt: string;
    clientFinishedAt: string;
  }> => {
    const connection = steadyState ?? createClient();
    const clientStartedAt = new Date().toISOString();
    const started = performance.now();
    try {
      if (includeConnect) await connection.client.connect(connection.transport);
      const response = await connection.client.callTool({ name: tool, arguments: args }, { timeout: timeoutMs });
      return {
        response,
        totalMs: performance.now() - started,
        clientStartedAt,
        clientFinishedAt: new Date().toISOString(),
      };
    } finally {
      if (includeConnect) await connection.client.close().catch(() => undefined);
    }
  };
  const samples: McpTransportLatencySample[] = [];
  const failures: ProbeResult['failures'] = [];
  const batchSummaries: ProbeResult['batches'] = [];
  try {
    if (steadyState) await steadyState.client.connect(steadyState.transport);
    for (let index = 0; index < warmup; index += 1) await call();
    const batches = await runMcpConcurrentBatches(iterations, concurrency, () => call());
    let requestIndex = 0;
    for (const batch of batches) {
      let successCount = 0;
      for (const outcome of batch.outcomes) {
        const currentIndex = requestIndex++;
        if (outcome.status === 'rejected') {
          failures.push({ requestIndex: currentIndex, batchIndex: batch.batchIndex, error: String(outcome.reason) });
          continue;
        }
        const { response, totalMs, clientStartedAt, clientFinishedAt } = outcome.value;
        const structured =
          response && typeof response === 'object' && !Array.isArray(response)
            ? (response as Record<string, unknown>).structuredContent
            : undefined;
        const responseMeta =
          structured && typeof structured === 'object' && !Array.isArray(structured)
            ? (structured as Record<string, unknown>).responseMeta
            : undefined;
        const meta =
          responseMeta && typeof responseMeta === 'object' && !Array.isArray(responseMeta)
            ? (responseMeta as Record<string, unknown>)
            : {};
        const serverDurationMs =
          extractForgeServerDuration(response) ?? timingLedgerServerDuration(timingLog, tool, meta);
        if (serverDurationMs === undefined || (response as { isError?: boolean })?.isError === true) {
          failures.push({
            requestIndex: currentIndex,
            batchIndex: batch.batchIndex,
            error: serverDurationMs === undefined ? 'MCP_SERVER_DURATION_MISSING' : 'MCP_TOOL_ERROR',
          });
          continue;
        }
        successCount += 1;
        samples.push({
          label,
          tool,
          timingScope,
          concurrency,
          batchIndex: batch.batchIndex,
          batchClientTotalMs: batch.clientBatchTotalMs,
          clientStartedAt,
          clientFinishedAt,
          ...(typeof meta.serverStartedAt === 'string' ? { serverStartedAt: meta.serverStartedAt } : {}),
          clientTotalMs: totalMs,
          serverDurationMs,
          ...(typeof meta.traceId === 'string' ? { traceId: meta.traceId } : {}),
          ...(typeof meta.requestId === 'string' ? { requestId: meta.requestId } : {}),
          observedAt: new Date().toISOString(),
        });
      }
      const serverStartSpreadMs = mcpServerStartSpreadMs(
        samples.filter((sample) => sample.batchIndex === batch.batchIndex),
      );
      batchSummaries.push({
        batchIndex: batch.batchIndex,
        attemptCount: batch.outcomes.length,
        successCount,
        failureCount: batch.outcomes.length - successCount,
        clientBatchTotalMs: batch.clientBatchTotalMs,
        ...(serverStartSpreadMs === undefined ? {} : { serverStartSpreadMs }),
      });
    }
  } finally {
    if (steadyState) await steadyState.client.close().catch(() => undefined);
  }
  return { samples, failures, batches: batchSummaries };
}

if (import.meta.main) {
  const input = option('--input');
  const measurement: ProbeResult = input ? { samples: readSamples(input), failures: [], batches: [] } : await probe();
  const report = aggregateMcpTransportLatencySamples(measurement.samples);
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        ...report,
        attemptCount: measurement.samples.length + measurement.failures.length,
        successCount: measurement.samples.length,
        failureCount: measurement.failures.length,
        batches: measurement.batches,
        failures: measurement.failures,
        ...(process.argv.includes('--summary-only') ? {} : { samples: measurement.samples }),
      },
      null,
      2,
    ),
  );
}
