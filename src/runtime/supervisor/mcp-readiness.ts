import { readMcpServiceBearerToken } from '../../cli/mcp/auth';

export interface SupervisorMcpReadinessResult {
  ok: boolean;
  endpoint: string;
  toolCount?: number;
  sessionId?: string;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function parseMcpPayload(text: string): Record<string, unknown> {
  const dataLine = text.split(/\r?\n/).find((line) => line.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice(6) : text) as Record<string, unknown>;
}

function errorMessage(payload: Record<string, unknown>): string | undefined {
  const error = payload.error;
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  const code = typeof record.code === 'number' || typeof record.code === 'string' ? String(record.code) : 'mcp_error';
  const message = typeof record.message === 'string' ? record.message : 'MCP request failed';
  return `${code}: ${message}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function postMcp(input: {
  endpoint: string;
  token: string;
  payload: Record<string, unknown>;
  sessionId?: string;
  timeoutMs: number;
}): Promise<{ response: Response; payload?: Record<string, unknown>; text: string }> {
  const response = await fetchWithTimeout(input.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(input.sessionId ? { 'mcp-session-id': input.sessionId } : {}),
    },
    body: JSON.stringify(input.payload),
  }, input.timeoutMs);
  const text = await response.text();
  let parsed: Record<string, unknown> | undefined;
  if (text.trim()) {
    try {
      parsed = parseMcpPayload(text);
    } catch (error) {
      throw new Error(`MCP_RESPONSE_PARSE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { response, ...(parsed ? { payload: parsed } : {}), text };
}

async function closeMcpSession(input: {
  endpoint: string;
  token: string;
  sessionId: string;
  timeoutMs: number;
}): Promise<void> {
  try {
    await fetchWithTimeout(input.endpoint, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${input.token}`,
        'mcp-session-id': input.sessionId,
      },
    }, input.timeoutMs);
  } catch {
    // Readiness must not fail solely because best-effort session release failed.
  }
}

export async function probeSupervisorMcpReadiness(input: {
  controllerHome: string;
  repoRoot: string;
  host: string;
  port: number;
  timeoutMs?: number;
  attempts?: number;
  clientName?: string;
}): Promise<SupervisorMcpReadinessResult> {
  const host = input.host === '::1' ? '[::1]' : input.host;
  const endpoint = `http://${host}:${input.port}/mcp-bearer`;
  const token = readMcpServiceBearerToken(input.controllerHome, input.repoRoot);
  if (!token) {
    return { ok: false, endpoint, error: 'MCP_AUTH_TOKEN_MISSING: bearer token is not configured for candidate slot' };
  }
  const attempts = Math.max(1, Math.trunc(input.attempts ?? 3));
  const timeoutMs = Math.max(500, Math.trunc(input.timeoutMs ?? 5_000));
  let lastError = 'MCP_READINESS_NOT_ATTEMPTED';

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let sessionId: string | undefined;
    try {
      const initialized = await postMcp({
        endpoint,
        token,
        timeoutMs,
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: input.clientName ?? 'repo-harness-supervisor-candidate-smoke', version: '1.0.0' },
          },
        },
      });
      if (initialized.response.status !== 200) {
        throw new Error(`MCP_INITIALIZE_FAILED: status=${initialized.response.status} body=${initialized.text.slice(0, 300)}`);
      }
      const initializeError = initialized.payload ? errorMessage(initialized.payload) : undefined;
      if (initializeError) throw new Error(`MCP_INITIALIZE_FAILED: ${initializeError}`);
      sessionId = initialized.response.headers.get('mcp-session-id') ?? undefined;

      const notification = await postMcp({
        endpoint,
        token,
        timeoutMs,
        sessionId,
        payload: { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      });
      if (notification.response.status >= 400) {
        throw new Error(`MCP_INITIALIZED_NOTIFICATION_FAILED: status=${notification.response.status} body=${notification.text.slice(0, 300)}`);
      }

      const listed = await postMcp({
        endpoint,
        token,
        timeoutMs,
        sessionId,
        payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      });
      if (listed.response.status !== 200) {
        throw new Error(`MCP_TOOLS_LIST_FAILED: status=${listed.response.status} body=${listed.text.slice(0, 300)}`);
      }
      const toolsError = listed.payload ? errorMessage(listed.payload) : undefined;
      if (toolsError) throw new Error(`MCP_TOOLS_LIST_FAILED: ${toolsError}`);
      const tools = Array.isArray((listed.payload?.result as { tools?: unknown[] } | undefined)?.tools)
        ? (listed.payload?.result as { tools: unknown[] }).tools
        : [];
      if (tools.length === 0) throw new Error('MCP_TOOLS_LIST_EMPTY');
      return { ok: true, endpoint, toolCount: tools.length, ...(sessionId ? { sessionId } : {}) };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < attempts - 1) await sleep(250);
    } finally {
      if (sessionId) await closeMcpSession({ endpoint, token, sessionId, timeoutMs });
    }
  }

  return { ok: false, endpoint, error: lastError };
}
