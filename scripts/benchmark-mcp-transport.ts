#!/usr/bin/env bun
import { readFileSync } from 'fs';
import { performance } from 'perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readMcpServiceBearerToken } from '../src/cli/mcp/auth';
import { resolveRepoPreferredControllerHome } from '../src/cli/repositories/controller-home';
import {
  aggregateMcpTransportLatencySamples,
  extractForgeServerDuration,
  normalizeMcpTransportLatencySample,
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
  return text.split(/\r?\n/).filter(Boolean).map((line) => normalizeMcpTransportLatencySample(JSON.parse(line)));
}

async function probe(): Promise<McpTransportLatencySample[]> {
  const endpointRaw = option('--endpoint');
  if (!endpointRaw) throw new Error('--endpoint is required unless --input is used');
  const endpoint = new URL(endpointRaw);
  const label = option('--label')?.trim() || endpoint.hostname;
  const tool = option('--tool')?.trim() || 'rh_status';
  const iterations = positiveInteger('--iterations', 30);
  const warmup = integerAtLeast('--warmup', 3, 0);
  const timeoutMs = positiveInteger('--timeout-ms', 120_000);
  const includeConnect = process.argv.includes('--include-connect');
  const timingScope = includeConnect ? 'connect_and_tool_call' as const : 'tool_call' as const;
  const tokenEnv = option('--token-env')?.trim() || 'FORGE_MCP_BENCH_TOKEN';
  const localServiceAuth = process.argv.includes('--local-service-auth');
  const token = process.env[tokenEnv]?.trim()
    || (localServiceAuth
      ? readMcpServiceBearerToken(resolveRepoPreferredControllerHome(process.cwd()))?.trim()
      : undefined);
  if (!token) {
    throw new Error(localServiceAuth
      ? 'MCP_BENCH_LOCAL_SERVICE_TOKEN_UNAVAILABLE: no local Forge service bearer credential was found'
      : `${tokenEnv} is not set; use --local-service-auth on the Forge host or keep benchmark bearer credentials in the environment, never CLI args`);
  }
  const argumentsRaw = option('--arguments');
  const args = argumentsRaw ? JSON.parse(argumentsRaw) as Record<string, unknown> : {};
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
  const call = async (): Promise<{ response: unknown; totalMs: number }> => {
    const connection = steadyState ?? createClient();
    const started = performance.now();
    try {
      if (includeConnect) await connection.client.connect(connection.transport);
      const response = await connection.client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs });
      return { response, totalMs: performance.now() - started };
    } finally {
      if (includeConnect) await connection.client.close().catch(() => undefined);
    }
  };
  const samples: McpTransportLatencySample[] = [];
  try {
    if (steadyState) await steadyState.client.connect(steadyState.transport);
    for (let index = 0; index < warmup; index += 1) await call();
    for (let index = 0; index < iterations; index += 1) {
      const { response, totalMs } = await call();
      const serverDurationMs = extractForgeServerDuration(response);
      if (serverDurationMs === undefined) {
        throw new Error('MCP_SERVER_DURATION_MISSING: target must return Forge responseMeta.serverDurationMs');
      }
      const structured = response && typeof response === 'object' && !Array.isArray(response)
        ? (response as Record<string, unknown>).structuredContent
        : undefined;
      const responseMeta = structured && typeof structured === 'object' && !Array.isArray(structured)
        ? (structured as Record<string, unknown>).responseMeta
        : undefined;
      const meta = responseMeta && typeof responseMeta === 'object' && !Array.isArray(responseMeta)
        ? responseMeta as Record<string, unknown>
        : {};
      samples.push({
        label,
        tool,
        timingScope,
        clientTotalMs: totalMs,
        serverDurationMs,
        ...(typeof meta.traceId === 'string' ? { traceId: meta.traceId } : {}),
        ...(typeof meta.requestId === 'string' ? { requestId: meta.requestId } : {}),
        observedAt: new Date().toISOString(),
      });
    }
  } finally {
    if (steadyState) await steadyState.client.close().catch(() => undefined);
  }
  return samples;
}

const input = option('--input');
const samples = input ? readSamples(input) : await probe();
const report = aggregateMcpTransportLatencySamples(samples);
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  ...report,
}, null, 2));
