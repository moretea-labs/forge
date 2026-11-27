import { closeSync, existsSync, openSync, readSync, statSync } from 'fs';
import { appendFile, mkdir, rename, rm, stat } from 'fs/promises';
import { join, resolve } from 'path';

export interface McpTimingTrace {
  tool: string;
  traceId?: string;
  requestId?: string;
  rpcId?: string | number;
  /** Public Connector ingress versus the authoritative loopback Runtime span. */
  layer?: 'public_gateway' | 'canonical_runtime';
  /** Wall-clock start for joining nested spans and later client-side timing when available. */
  startedAt?: string;
  outcome?: 'ok' | 'error' | 'exception';
  errorCode?: string;
  sessionResolutionMs?: number;
  authenticationAuthorizationMs?: number;
  repositoryResolutionMs?: number;
  /** Claim/handle preflight duration. */
  handleValidationMs?: number;
  controllerQueueWaitMs?: number;
  commandExecutionMs?: number;
  resultSerializationMs?: number;
  resultPersistenceMs?: number;
  /** Public Gateway only: resolve current Canonical Runtime identity/token/endpoint. */
  gatewayProxyResolveMs?: number;
  /** Public Gateway only: wait for an available existing bounded proxy lane. */
  gatewayProxyLaneWaitMs?: number;
  /** Public Gateway only: release handoff wait and retirement of previous lanes. */
  gatewayProxyHandoffWaitMs?: number;
  /** Public Gateway only: establish or await a Canonical Runtime MCP client connection. */
  gatewayProxyConnectMs?: number;
  /** Public Gateway only: MCP call duration after a client is acquired, including Canonical Runtime work. */
  gatewayProxyCallMs?: number;
  /** Public Gateway only: time from forwarding the tool call until the Canonical Runtime handler starts. */
  gatewayProxyCanonicalDispatchLagMs?: number;
  /** Canonical Runtime server duration projected back through the proxy response. */
  gatewayProxyCanonicalDurationMs?: number;
  /** Exact join to the existing canonical_runtime audit span; diagnostic only. */
  gatewayProxyCanonicalTraceId?: string;
  /** Public Gateway only: response/transport tail after canonical handler completion. */
  gatewayProxyReturnMs?: number;
  gatewayProxyConnectionState?: 'reused' | 'cold_connect' | 'coalesced_connect' | 'identity_reconnect';
  totalToolDurationMs: number;
  sessionId?: string;
  /** Request-scoped ChatGPT conversation correlation from MCP host metadata; diagnostic only, never semantic authority. */
  hostConversationSessionId?: string;
  repoId?: string;
  processId?: string;
  route?: string;
}

export type McpTransportEventKind = 'interruption' | 'session_closed' | 'session_initialized';

export interface McpTransportEvent {
  schemaVersion: 1;
  at: string;
  kind: McpTransportEventKind;
  sessionId: string;
  connectionId: string;
  route: string;
  principalId: string;
  reason?: string;
}

export interface McpIncident {
  traceId: string;
  requestId: string;
  rpcId?: string | number;
  tool: string;
  kind: 'tool_error' | 'exception' | 'supervisor_probe';
  code: string;
  message: string;
  repoId?: string;
  sessionId?: string;
  details?: Record<string, unknown>;
}

const MCP_DIAGNOSTIC_MAX_BYTES = 32 * 1024 * 1024;
const MCP_DIAGNOSTIC_MAX_PENDING_ENTRIES = 4_096;
const MCP_DIAGNOSTIC_MAX_BATCH_BYTES = 256 * 1024;
const MCP_INCIDENT_MEMORY_WINDOW_LIMIT = 1_024;
const MCP_INCIDENT_MEMORY_LEDGER_LIMIT = 64;
const MCP_TRANSPORT_EVENT_TAIL_BYTES = 256 * 1024;
const MCP_TRANSPORT_EVENT_READ_LIMIT = 64;

interface PendingDiagnosticLedger {
  readonly root: string;
  readonly fileName: string;
  pending: string[];
  pendingBytes: number;
  drain?: Promise<void>;
}

const diagnosticLedgers = new Map<string, PendingDiagnosticLedger>();
const recentIncidents = new Map<string, Array<McpIncident & { at: string }>>();
const recentTransportEvents = new Map<string, McpTransportEvent[]>();

function ledgerFor(controllerHome: string, fileName: string): PendingDiagnosticLedger {
  const root = join(resolve(controllerHome), 'audit');
  const key = `${root}\0${fileName}`;
  let ledger = diagnosticLedgers.get(key);
  if (!ledger) {
    ledger = { root, fileName, pending: [], pendingBytes: 0 };
    diagnosticLedgers.set(key, ledger);
  }
  return ledger;
}

async function existingSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

async function rotateLedger(path: string): Promise<void> {
  const previous = `${path}.previous`;
  // This is diagnostic evidence, not a control-plane authority. Keep one bounded
  // previous segment so a stalled disk cannot turn unbounded telemetry into MCP
  // dispatch latency.
  await rm(previous, { force: true });
  await rename(path, previous);
}

async function drainLedger(ledger: PendingDiagnosticLedger): Promise<void> {
  const path = join(ledger.root, ledger.fileName);
  await mkdir(ledger.root, { recursive: true, mode: 0o700 });
  let size = await existingSize(path);
  while (ledger.pending.length > 0) {
    const records: string[] = [];
    let bytes = 0;
    while (ledger.pending.length > 0 && (records.length === 0 || bytes < MCP_DIAGNOSTIC_MAX_BATCH_BYTES)) {
      const record = ledger.pending.shift()!;
      ledger.pendingBytes -= Buffer.byteLength(record);
      records.push(record);
      bytes += Buffer.byteLength(record);
    }
    if (size > 0 && size + bytes > MCP_DIAGNOSTIC_MAX_BYTES) {
      await rotateLedger(path);
      size = 0;
    }
    const batch = records.join('');
    await appendFile(path, batch, 'utf-8');
    size += bytes;
  }
}

function scheduleLedgerDrain(ledger: PendingDiagnosticLedger): void {
  if (ledger.drain) return;
  ledger.drain = drainLedger(ledger)
    // Observability is deliberately best-effort. A write failure must not turn
    // into a failed tool request or retain an unbounded queue in memory.
    .catch(() => {
      ledger.pending.length = 0;
      ledger.pendingBytes = 0;
    })
    .finally(() => {
      ledger.drain = undefined;
      if (ledger.pending.length > 0) scheduleLedgerDrain(ledger);
    });
}

function appendDiagnostic(controllerHome: string, fileName: string, value: Record<string, unknown>): void {
  const ledger = ledgerFor(controllerHome, fileName);
  if (ledger.pending.length >= MCP_DIAGNOSTIC_MAX_PENDING_ENTRIES) return;
  const record = `${JSON.stringify(value)}\n`;
  ledger.pending.push(record);
  ledger.pendingBytes += Buffer.byteLength(record);
  scheduleLedgerDrain(ledger);
}

/** Wait for queued diagnostic evidence in tests and explicit diagnostic consumers. */
export async function flushMcpDiagnostics(controllerHome?: string): Promise<void> {
  const ledgers = controllerHome
    ? [...diagnosticLedgers.values()].filter((ledger) => ledger.root === join(resolve(controllerHome), 'audit'))
    : [...diagnosticLedgers.values()];
  await Promise.all(
    ledgers.map(async (ledger) => {
      while (ledger.drain) await ledger.drain;
    }),
  );
}

interface PendingMcpHttpTransportTrace {
  traceId: string;
  requestId?: string;
  rpcId: string | number;
  sessionId: string;
  tool: string;
  layer: NonNullable<McpTimingTrace['layer']>;
  expiresAt: number;
}

export interface McpHttpTransportSpanInput {
  sessionId: string;
  rpcId: string | number;
  tool: string;
  route: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  statusCode: number;
  layer: NonNullable<McpTimingTrace['layer']>;
  outcome: 'finished' | 'closed';
  /** Number of simultaneous canonical POSTs observed when this POST entered the route. */
  concurrentPostsAtStart?: number;
  /** Gateway-generated identity shared by every tool call in one inbound HTTP POST. */
  ingressRequestId?: string;
  /** Diagnostic-only upstream identifiers; never used for authorization or routing. */
  upstreamRequestId?: string;
  clientTraceId?: string;
  cloudflareRay?: string;
  /** Optional ISO-8601 client timestamp. Missing means the caller did not provide one. */
  clientStartedAt?: string;
  clientStartObserved?: boolean;
  clientToGatewayMs?: number;
}

const MCP_HTTP_TRANSPORT_TRACE_TTL_MS = 60_000;
const MCP_HTTP_TRANSPORT_TRACE_MAX_PENDING = 4_096;
const pendingMcpHttpTransportTraces = new Map<string, PendingMcpHttpTransportTrace>();

function mcpHttpTransportTraceKey(
  controllerHome: string,
  sessionId: string,
  rpcId: string | number,
  layer: NonNullable<McpTimingTrace['layer']>,
  tool: string,
): string {
  return JSON.stringify([resolve(controllerHome), sessionId, typeof rpcId, String(rpcId), layer, tool]);
}

function pruneExpiredPendingMcpHttpTransportTraces(now: number): void {
  for (const [key, pending] of pendingMcpHttpTransportTraces) {
    if (pending.expiresAt <= now) pendingMcpHttpTransportTraces.delete(key);
  }
}

function evictOldestPendingMcpHttpTransportTracesIfNeeded(): void {
  while (pendingMcpHttpTransportTraces.size >= MCP_HTTP_TRANSPORT_TRACE_MAX_PENDING) {
    const oldestKey = pendingMcpHttpTransportTraces.keys().next().value;
    if (oldestKey === undefined) break;
    pendingMcpHttpTransportTraces.delete(oldestKey);
  }
}

function rememberPendingMcpHttpTransportTrace(controllerHome: string, trace: McpTimingTrace): void {
  const sessionId = trace.sessionId?.trim();
  const traceId = trace.traceId?.trim();
  const tool = trace.tool.trim();
  const layer = trace.layer;
  if (!sessionId || !traceId || trace.rpcId === undefined || !tool || !layer) return;

  const now = Date.now();
  pruneExpiredPendingMcpHttpTransportTraces(now);
  const key = mcpHttpTransportTraceKey(controllerHome, sessionId, trace.rpcId, layer, tool);
  if (!pendingMcpHttpTransportTraces.has(key)) {
    evictOldestPendingMcpHttpTransportTracesIfNeeded();
  }
  pendingMcpHttpTransportTraces.set(key, {
    traceId,
    ...(trace.requestId ? { requestId: trace.requestId } : {}),
    rpcId: trace.rpcId,
    sessionId,
    tool,
    layer,
    expiresAt: now + MCP_HTTP_TRANSPORT_TRACE_TTL_MS,
  });
}

export function recordMcpTiming(controllerHome: string, trace: McpTimingTrace): void {
  try {
    rememberPendingMcpHttpTransportTrace(controllerHome, trace);
  } catch {
    // Correlation is best-effort and must never change the tool result.
  }
  try {
    appendDiagnostic(controllerHome, 'mcp-timings.jsonl', { schemaVersion: 1, at: new Date().toISOString(), ...trace });
  } catch {
    // Timing is diagnostic evidence; it must never change the tool result.
  }
}

export function recordMcpHttpTransportSpan(controllerHome: string, span: McpHttpTransportSpanInput): boolean {
  const sessionId = span.sessionId.trim();
  const tool = span.tool.trim();
  if (!sessionId || !tool) return false;

  const now = Date.now();
  pruneExpiredPendingMcpHttpTransportTraces(now);
  const key = mcpHttpTransportTraceKey(controllerHome, sessionId, span.rpcId, span.layer, tool);
  const pending = pendingMcpHttpTransportTraces.get(key);
  if (!pending) return false;
  pendingMcpHttpTransportTraces.delete(key);

  try {
    appendDiagnostic(controllerHome, 'mcp-timings.jsonl', {
      schemaVersion: 1,
      at: span.finishedAt,
      spanKind: 'http_transport',
      tool: '__http_transport__',
      mcpTool: pending.tool,
      traceId: pending.traceId,
      ...(pending.requestId ? { requestId: pending.requestId } : {}),
      rpcId: pending.rpcId,
      layer: pending.layer,
      sessionId: pending.sessionId,
      route: span.route,
      httpStartedAt: span.startedAt,
      httpFinishedAt: span.finishedAt,
      httpDurationMs: Number.isFinite(span.durationMs) ? Math.max(0, Math.round(span.durationMs * 100) / 100) : 0,
      httpStatusCode: span.statusCode,
      httpOutcome: span.outcome,
      ...(typeof span.concurrentPostsAtStart === 'number' && Number.isFinite(span.concurrentPostsAtStart)
        ? { concurrentPostsAtStart: Math.max(1, Math.trunc(span.concurrentPostsAtStart)) }
        : {}),
      ...(span.ingressRequestId ? { ingressRequestId: span.ingressRequestId } : {}),
      ...(span.upstreamRequestId ? { upstreamRequestId: span.upstreamRequestId } : {}),
      ...(span.clientTraceId ? { clientTraceId: span.clientTraceId } : {}),
      ...(span.cloudflareRay ? { cloudflareRay: span.cloudflareRay } : {}),
      ...(span.clientStartedAt ? { clientStartedAt: span.clientStartedAt } : {}),
      clientStartObserved: span.clientStartObserved ?? false,
      ...(typeof span.clientToGatewayMs === 'number' && Number.isFinite(span.clientToGatewayMs)
        ? { clientToGatewayMs: Math.round(span.clientToGatewayMs * 100) / 100 }
        : {}),
    });
    return true;
  } catch {
    // HTTP timing is diagnostic evidence; it must never change the tool result.
    return false;
  }
}

export function recordMcpIncident(controllerHome: string, incident: McpIncident): void {
  const root = resolve(controllerHome);
  let remembered = recentIncidents.get(root);
  if (!remembered) {
    if (recentIncidents.size >= MCP_INCIDENT_MEMORY_LEDGER_LIMIT) {
      const oldest = recentIncidents.keys().next().value;
      if (oldest) recentIncidents.delete(oldest);
    }
    remembered = [];
    recentIncidents.set(root, remembered);
  }
  remembered.push({ ...incident, at: new Date().toISOString() });
  if (remembered.length > MCP_INCIDENT_MEMORY_WINDOW_LIMIT) {
    remembered.splice(0, remembered.length - MCP_INCIDENT_MEMORY_WINDOW_LIMIT);
  }
  try {
    appendDiagnostic(controllerHome, 'mcp-incidents.jsonl', {
      schemaVersion: 1,
      at: new Date().toISOString(),
      ...incident,
    });
  } catch {
    // Incident recording is diagnostic evidence; it must never change the tool result.
  }
}

/**
 * The repair classifier needs to count immediately repeated incidents before an
 * asynchronous diagnostic batch reaches disk. This bounded volatile view is
 * supplemental evidence only; the JSONL ledger remains the restart-safe history.
 */
export function recentMcpIncidents(controllerHome: string): Array<McpIncident & { at: string }> {
  return [...(recentIncidents.get(resolve(controllerHome)) ?? [])];
}

function readDiagnosticTail<T>(controllerHome: string, fileName: string, maxBytes: number): T[] {
  const path = join(resolve(controllerHome), 'audit', fileName);
  if (!existsSync(path)) return [];
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, maxBytes);
    const start = Math.max(0, size - length);
    const buffer = Buffer.alloc(length);
    fd = openSync(path, 'r');
    const read = readSync(fd, buffer, 0, length, start);
    let text = buffer.subarray(0, read).toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline >= 0 ? text.slice(newline + 1) : '';
    }
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as T;
          return parsed && typeof parsed === 'object' ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface McpTimingPercentiles {
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface McpToolTimingSummary {
  tool: string;
  layer: NonNullable<McpTimingTrace['layer']>;
  sampleCount: number;
  outcomes: { ok: number; error: number; exception: number };
  totalToolDurationMs: McpTimingPercentiles;
  /** HTTP ingress to tools/call handler start; includes transport/SDK dispatch wait. */
  preHandlerDispatchMs?: McpTimingPercentiles;
  /** Tool handler completion to HTTP response finish; includes response encoding/flush. */
  responseTailMs?: McpTimingPercentiles;
  /** Maximum number of concurrent canonical HTTP POSTs observed at ingress. */
  maxConcurrentHttpPosts?: number;
  gatewayProxyCallMs?: McpTimingPercentiles;
  gatewayProxyLaneWaitMs?: McpTimingPercentiles;
  gatewayProxyCanonicalDispatchLagMs?: McpTimingPercentiles;
  gatewayProxyCanonicalDurationMs?: McpTimingPercentiles;
}

export interface RecentMcpTimingSummary {
  observation: 'observed' | 'empty';
  sampleCount: number;
  httpSpanCount: number;
  tools: McpToolTimingSummary[];
}

function timingPercentiles(values: readonly number[]): McpTimingPercentiles | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number =>
    Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]! * 100) / 100;
  return {
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: Math.round(sorted[sorted.length - 1]! * 100) / 100,
  };
}

function finiteTiming(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function timingTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Bounded read-only summary for the performance diagnostic. It joins tool-handler
 * spans to HTTP ingress/finish spans by traceId, exposing pre-handler dispatch
 * wait and response-tail time without returning request/session identifiers.
 */
export function readRecentMcpTimingSummary(controllerHome: string, limit = 128): RecentMcpTimingSummary {
  const records = readDiagnosticTail<Record<string, unknown>>(controllerHome, 'mcp-timings.jsonl', 512 * 1024);
  const boundedLimit = Math.max(1, Math.min(512, Math.trunc(limit) || 128));
  const httpSpans = records.filter((record) => record.spanKind === 'http_transport');
  const httpByTrace = new Map<string, Record<string, unknown>>();
  for (const span of httpSpans) {
    if (typeof span.traceId === 'string') httpByTrace.set(span.traceId, span);
  }
  const toolRows = records
    .filter(
      (record) =>
        record.spanKind !== 'http_transport' &&
        typeof record.tool === 'string' &&
        (record.layer === 'public_gateway' || record.layer === 'canonical_runtime') &&
        finiteTiming(record.totalToolDurationMs) !== undefined,
    )
    .slice(-boundedLimit);
  type Bucket = {
    tool: string;
    layer: NonNullable<McpTimingTrace['layer']>;
    outcomes: { ok: number; error: number; exception: number };
    total: number[];
    preHandler: number[];
    responseTail: number[];
    maxConcurrentHttpPosts: number;
    gatewayCall: number[];
    laneWait: number[];
    dispatchLag: number[];
    canonicalDuration: number[];
  };
  const buckets = new Map<string, Bucket>();
  for (const row of toolRows) {
    const tool = String(row.tool);
    const layer = row.layer as NonNullable<McpTimingTrace['layer']>;
    const key = JSON.stringify([layer, tool]);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        tool,
        layer,
        outcomes: { ok: 0, error: 0, exception: 0 },
        total: [],
        preHandler: [],
        responseTail: [],
        maxConcurrentHttpPosts: 0,
        gatewayCall: [],
        laneWait: [],
        dispatchLag: [],
        canonicalDuration: [],
      };
      buckets.set(key, bucket);
    }
    const total = finiteTiming(row.totalToolDurationMs)!;
    bucket.total.push(total);
    if (row.outcome === 'ok' || row.outcome === 'error' || row.outcome === 'exception') {
      bucket.outcomes[row.outcome] += 1;
    }
    const traceId = typeof row.traceId === 'string' ? row.traceId : undefined;
    const http = traceId ? httpByTrace.get(traceId) : undefined;
    if (http && http.layer === layer) {
      const concurrentPostsAtStart = finiteTiming(http.concurrentPostsAtStart);
      if (concurrentPostsAtStart !== undefined) {
        bucket.maxConcurrentHttpPosts = Math.max(bucket.maxConcurrentHttpPosts, Math.trunc(concurrentPostsAtStart));
      }
      const httpStart = timingTimestamp(http.httpStartedAt);
      const toolStart = timingTimestamp(row.startedAt);
      const httpFinish = timingTimestamp(http.httpFinishedAt);
      if (httpStart !== undefined && toolStart !== undefined && toolStart >= httpStart) {
        bucket.preHandler.push(toolStart - httpStart);
      }
      if (httpFinish !== undefined && toolStart !== undefined && httpFinish >= toolStart + total) {
        bucket.responseTail.push(httpFinish - toolStart - total);
      }
    }
    const gatewayCall = finiteTiming(row.gatewayProxyCallMs);
    const laneWait = finiteTiming(row.gatewayProxyLaneWaitMs);
    const dispatchLag = finiteTiming(row.gatewayProxyCanonicalDispatchLagMs);
    const canonicalDuration = finiteTiming(row.gatewayProxyCanonicalDurationMs);
    if (gatewayCall !== undefined) bucket.gatewayCall.push(gatewayCall);
    if (laneWait !== undefined) bucket.laneWait.push(laneWait);
    if (dispatchLag !== undefined) bucket.dispatchLag.push(dispatchLag);
    if (canonicalDuration !== undefined) bucket.canonicalDuration.push(canonicalDuration);
  }
  const tools = [...buckets.values()]
    .map(
      (bucket): McpToolTimingSummary => ({
        tool: bucket.tool,
        layer: bucket.layer,
        sampleCount: bucket.total.length,
        outcomes: bucket.outcomes,
        totalToolDurationMs: timingPercentiles(bucket.total)!,
        ...(timingPercentiles(bucket.preHandler)
          ? { preHandlerDispatchMs: timingPercentiles(bucket.preHandler)! }
          : {}),
        ...(timingPercentiles(bucket.responseTail) ? { responseTailMs: timingPercentiles(bucket.responseTail)! } : {}),
        ...(bucket.maxConcurrentHttpPosts > 0 ? { maxConcurrentHttpPosts: bucket.maxConcurrentHttpPosts } : {}),
        ...(timingPercentiles(bucket.gatewayCall)
          ? { gatewayProxyCallMs: timingPercentiles(bucket.gatewayCall)! }
          : {}),
        ...(timingPercentiles(bucket.laneWait) ? { gatewayProxyLaneWaitMs: timingPercentiles(bucket.laneWait)! } : {}),
        ...(timingPercentiles(bucket.dispatchLag)
          ? { gatewayProxyCanonicalDispatchLagMs: timingPercentiles(bucket.dispatchLag)! }
          : {}),
        ...(timingPercentiles(bucket.canonicalDuration)
          ? { gatewayProxyCanonicalDurationMs: timingPercentiles(bucket.canonicalDuration)! }
          : {}),
      }),
    )
    .sort((left, right) => right.totalToolDurationMs.p95Ms - left.totalToolDurationMs.p95Ms);
  return {
    observation: toolRows.length > 0 ? 'observed' : 'empty',
    sampleCount: toolRows.length,
    httpSpanCount: httpSpans.length,
    tools,
  };
}

/**
 * Durable transport evidence only. It is deliberately separate from MCP tool
 * incidents so normal reconnects cannot trigger incident-repair Work. The
 * bounded JSONL tail survives Gateway restart without owning any lifecycle.
 */
export function recordMcpTransportEvent(
  controllerHome: string,
  event: Omit<McpTransportEvent, 'schemaVersion' | 'at'> & { at?: string },
): void {
  try {
    const root = resolve(controllerHome);
    const record: McpTransportEvent = {
      schemaVersion: 1,
      at: event.at ?? new Date().toISOString(),
      kind: event.kind,
      sessionId: event.sessionId,
      connectionId: event.connectionId,
      route: event.route,
      principalId: event.principalId,
      ...(event.reason ? { reason: event.reason } : {}),
    };
    const remembered = recentTransportEvents.get(root) ?? [];
    remembered.push(record);
    if (remembered.length > MCP_TRANSPORT_EVENT_READ_LIMIT) {
      remembered.splice(0, remembered.length - MCP_TRANSPORT_EVENT_READ_LIMIT);
    }
    recentTransportEvents.set(root, remembered);
    appendDiagnostic(controllerHome, 'mcp-transport-events.jsonl', { ...record });
  } catch {
    // Transport observability is diagnostic-only and must never affect protocol
    // initialization, request routing, or session lifecycle.
  }
}

export function readRecentMcpTransportEvents(
  controllerHome: string,
  limit = MCP_TRANSPORT_EVENT_READ_LIMIT,
): McpTransportEvent[] {
  const boundedLimit = Math.max(1, Math.min(limit, MCP_TRANSPORT_EVENT_READ_LIMIT));
  const durable = readDiagnosticTail<McpTransportEvent>(
    controllerHome,
    'mcp-transport-events.jsonl',
    MCP_TRANSPORT_EVENT_TAIL_BYTES,
  );
  const memory = recentTransportEvents.get(resolve(controllerHome)) ?? [];
  const unique = new Map<string, McpTransportEvent>();
  for (const event of [...durable, ...memory]) {
    if (
      event.schemaVersion !== 1 ||
      (event.kind !== 'interruption' && event.kind !== 'session_closed' && event.kind !== 'session_initialized') ||
      typeof event.at !== 'string' ||
      !Number.isFinite(Date.parse(event.at)) ||
      typeof event.sessionId !== 'string' ||
      typeof event.connectionId !== 'string' ||
      typeof event.route !== 'string' ||
      typeof event.principalId !== 'string'
    )
      continue;
    unique.set(`${event.at}\0${event.kind}\0${event.sessionId}`, event);
  }
  return [...unique.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, boundedLimit);
}
