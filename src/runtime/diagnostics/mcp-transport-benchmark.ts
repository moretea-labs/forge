export type McpTransportTimingScope = 'tool_call' | 'connect_and_tool_call';

export interface McpTransportLatencySample {
  label: string;
  tool: string;
  timingScope?: McpTransportTimingScope;
  clientTotalMs: number;
  serverDurationMs: number;
  traceId?: string;
  requestId?: string;
  observedAt?: string;
}

export interface McpTransportLatencyStats {
  p50: number;
  p95: number;
  max: number;
}

export interface McpTransportLatencyGroup {
  label: string;
  tool: string;
  timingScope: McpTransportTimingScope;
  sampleCount: number;
  clientTotalMs: McpTransportLatencyStats;
  serverDurationMs: McpTransportLatencyStats;
  externalResidualMs: McpTransportLatencyStats;
  externalSharePct: McpTransportLatencyStats;
  serverExceedsClientCount: number;
}

export interface McpTransportLatencyReport {
  schemaVersion: 1;
  sampleCount: number;
  groups: McpTransportLatencyGroup[];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1));
  return round(sorted[index]!);
}

function stats(values: number[]): McpTransportLatencyStats {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: round(Math.max(...values, 0)),
  };
}

function validDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function normalizeMcpTransportLatencySample(value: unknown): McpTransportLatencySample {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MCP_TRANSPORT_SAMPLE_INVALID: sample must be an object');
  }
  const record = value as Record<string, unknown>;
  const label = typeof record.label === 'string' ? record.label.trim() : '';
  const tool = typeof record.tool === 'string' ? record.tool.trim() : '';
  const timingScope = record.timingScope === undefined || record.timingScope === 'tool_call'
    ? 'tool_call'
    : record.timingScope === 'connect_and_tool_call'
      ? 'connect_and_tool_call'
      : undefined;
  if (!label) throw new Error('MCP_TRANSPORT_SAMPLE_INVALID: label is required');
  if (!tool) throw new Error('MCP_TRANSPORT_SAMPLE_INVALID: tool is required');
  if (!timingScope) throw new Error('MCP_TRANSPORT_SAMPLE_INVALID: timingScope must be tool_call or connect_and_tool_call');
  if (!validDuration(record.clientTotalMs)) throw new Error('MCP_TRANSPORT_SAMPLE_INVALID: clientTotalMs must be a non-negative finite number');
  if (!validDuration(record.serverDurationMs)) throw new Error('MCP_TRANSPORT_SAMPLE_INVALID: serverDurationMs must be a non-negative finite number');
  return {
    label,
    tool,
    timingScope,
    clientTotalMs: record.clientTotalMs,
    serverDurationMs: record.serverDurationMs,
    ...(typeof record.traceId === 'string' && record.traceId.trim() ? { traceId: record.traceId.trim() } : {}),
    ...(typeof record.requestId === 'string' && record.requestId.trim() ? { requestId: record.requestId.trim() } : {}),
    ...(typeof record.observedAt === 'string' && record.observedAt.trim() ? { observedAt: record.observedAt.trim() } : {}),
  };
}

export function extractForgeServerDuration(result: unknown): number | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const structured = (result as Record<string, unknown>).structuredContent;
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return undefined;
  const responseMeta = (structured as Record<string, unknown>).responseMeta;
  if (!responseMeta || typeof responseMeta !== 'object' || Array.isArray(responseMeta)) return undefined;
  const duration = (responseMeta as Record<string, unknown>).serverDurationMs;
  return validDuration(duration) ? duration : undefined;
}

export function aggregateMcpTransportLatencySamples(values: unknown[]): McpTransportLatencyReport {
  const samples = values.map(normalizeMcpTransportLatencySample);
  const grouped = new Map<string, McpTransportLatencySample[]>();
  for (const sample of samples) {
    const key = `${sample.label}\u0000${sample.tool}\u0000${sample.timingScope ?? 'tool_call'}`;
    const entries = grouped.get(key) ?? [];
    entries.push(sample);
    grouped.set(key, entries);
  }
  const groups = [...grouped.values()].map((entries): McpTransportLatencyGroup => {
    const client = entries.map((sample) => sample.clientTotalMs);
    const server = entries.map((sample) => sample.serverDurationMs);
    const residual = entries.map((sample) => Math.max(0, sample.clientTotalMs - sample.serverDurationMs));
    const share = entries.map((sample, index) => client[index]! > 0 ? residual[index]! / client[index]! * 100 : 0);
    return {
      label: entries[0]!.label,
      tool: entries[0]!.tool,
      timingScope: entries[0]!.timingScope ?? 'tool_call',
      sampleCount: entries.length,
      clientTotalMs: stats(client),
      serverDurationMs: stats(server),
      externalResidualMs: stats(residual),
      externalSharePct: stats(share),
      serverExceedsClientCount: entries.filter((sample) => sample.serverDurationMs > sample.clientTotalMs).length,
    };
  }).sort((left, right) => left.label.localeCompare(right.label)
    || left.tool.localeCompare(right.tool)
    || left.timingScope.localeCompare(right.timingScope));
  return { schemaVersion: 1, sampleCount: samples.length, groups };
}
