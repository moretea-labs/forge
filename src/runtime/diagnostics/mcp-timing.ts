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
  workHandleValidationMs?: number;
  controllerQueueWaitMs?: number;
  commandExecutionMs?: number;
  resultSerializationMs?: number;
  resultPersistenceMs?: number;
  /** Public Gateway only: resolve current Canonical Runtime identity/token/endpoint. */
  gatewayProxyResolveMs?: number;
  /** Public Gateway only: establish or await a Canonical Runtime MCP client connection. */
  gatewayProxyConnectMs?: number;
  /** Public Gateway only: MCP call duration after a client is acquired, including Canonical Runtime work. */
  gatewayProxyCallMs?: number;
  /** Public Gateway only: time from forwarding the tool call until the Canonical Runtime handler starts. */
  gatewayProxyCanonicalDispatchLagMs?: number;
  /** Canonical Runtime server duration projected back through the proxy response. */
  gatewayProxyCanonicalDurationMs?: number;
  /** Public Gateway only: response/transport tail after canonical handler completion. */
  gatewayProxyReturnMs?: number;
  gatewayProxyConnectionState?: 'reused' | 'cold_connect' | 'coalesced_connect' | 'identity_reconnect';
  totalToolDurationMs: number;
  sessionId?: string;
  repoId?: string;
  workId?: string;
  processId?: string;
  route?: string;
}


export type McpTransportEventKind = 'interruption' | 'session_initialized';

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
  workId?: string;
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
  await Promise.all(ledgers.map(async (ledger) => {
    while (ledger.drain) await ledger.drain;
  }));
}

export function recordMcpTiming(controllerHome: string, trace: McpTimingTrace): void {
  try {
    appendDiagnostic(controllerHome, 'mcp-timings.jsonl', { schemaVersion: 1, at: new Date().toISOString(), ...trace });
  } catch {
    // Timing is diagnostic evidence; it must never change the tool result.
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
    return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
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
    if (event.schemaVersion !== 1
      || (event.kind !== 'interruption' && event.kind !== 'session_initialized')
      || typeof event.at !== 'string'
      || !Number.isFinite(Date.parse(event.at))
      || typeof event.sessionId !== 'string'
      || typeof event.connectionId !== 'string'
      || typeof event.route !== 'string'
      || typeof event.principalId !== 'string') continue;
    unique.set(`${event.at}\0${event.kind}\0${event.sessionId}`, event);
  }
  return [...unique.values()]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, boundedLimit);
}
