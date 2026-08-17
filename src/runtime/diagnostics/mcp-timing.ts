import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ensureControllerHome } from '../../cli/repositories/controller-home';

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

function appendDiagnostic(controllerHome: string, fileName: string, value: Record<string, unknown>): void {
  const root = join(ensureControllerHome(controllerHome), 'audit');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  appendFileSync(join(root, fileName), `${JSON.stringify(value)}\n`, 'utf-8');
}

export function recordMcpTiming(controllerHome: string, trace: McpTimingTrace): void {
  try {
    appendDiagnostic(controllerHome, 'mcp-timings.jsonl', { schemaVersion: 1, at: new Date().toISOString(), ...trace });
  } catch {
    // Timing is diagnostic evidence; it must never change the tool result.
  }
}

export function recordMcpIncident(controllerHome: string, incident: McpIncident): void {
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
