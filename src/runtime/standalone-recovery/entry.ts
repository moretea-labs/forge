import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { resolve } from 'path';
import {
  attestKnownGood,
  diagnose,
  gatewayToken,
  listSlots,
  loadRecoveryConfig,
  reconnectMain,
  restartSupervisor,
  rollbackPrevious,
  secureEqual,
  supervisorStatus,
  verifyStableRuntime,
  watchdogTick,
  type WatchdogState,
  type RecoveryConfig,
} from './core';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function controllerHome(): string {
  const home = option('--controller-home') ?? process.env.REPO_HARNESS_CONTROLLER_HOME;
  if (!home) throw new Error('RECOVERY_CONTROLLER_HOME_REQUIRED');
  return resolve(home);
}

function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

function usage(): never {
  throw new Error('RECOVERY_USAGE: status | verify | verify-external | list-slots | rollback-previous | restart-supervisor | diagnose | reconnect-main | attest-known-good | gateway | watchdog');
}

async function cli(): Promise<void> {
  const command = process.argv.find((value, index) => index >= 2 && !value.startsWith('-') && process.argv[index - 1] !== '--controller-home') ?? 'status';
  const config = loadRecoveryConfig(controllerHome(), option('--config'));
  switch (command) {
    case 'status': output(await supervisorStatus(config)); return;
    case 'verify': output(await verifyStableRuntime(config)); return;
    case 'verify-external': {
      const verified = await verifyStableRuntime(config);
      output({ ok: verified.probes.external_mcp_http?.ok === true, external: verified.probes.external_mcp_http, mcp: verified.probes.mcp_initialize });
      return;
    }
    case 'list-slots': output(await listSlots(config)); return;
    case 'rollback-previous': output(await rollbackPrevious(config)); return;
    case 'restart-supervisor': output(await restartSupervisor(config)); return;
    case 'diagnose': output(await diagnose(config)); return;
    case 'reconnect-main': output(await reconnectMain(config)); return;
    case 'attest-known-good': output(await attestKnownGood(config)); return;
    case 'gateway': await startGateway(config); return;
    case 'watchdog': await startWatchdog(config); return;
    default: usage();
  }
}

async function startWatchdog(config: RecoveryConfig): Promise<void> {
  let state: WatchdogState = { failures: 0, rollbackUsed: false };
  for (;;) {
    try {
      const result = await watchdogTick(config, state);
      state = result.state;
      process.stdout.write(JSON.stringify({ at: new Date().toISOString(), action: result.decision.action, reason: result.decision.reason, failures: state.failures }) + '\n');
    } catch (error) {
      state = { ...state, failures: state.failures + 1, firstFailureAt: state.firstFailureAt ?? Date.now() };
      process.stderr.write(`watchdog probe failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 5_000));
  }
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(payload));
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

const TOOLS = [
  { name: 'supervisor_status', description: 'Read the Stable Supervisor state.', inputSchema: { type: 'object', additionalProperties: false } },
  { name: 'list_slots', description: 'Read active, previous, and known-good release evidence.', inputSchema: { type: 'object', additionalProperties: false } },
  { name: 'verify_stable_runtime', description: 'Run independent stable runtime verification.', inputSchema: { type: 'object', additionalProperties: false } },
  { name: 'verify_external_runtime', description: 'Verify the external primary MCP endpoint.', inputSchema: { type: 'object', additionalProperties: false } },
  { name: 'rollback_previous', description: 'Idempotently restore only a Supervisor-registered known-good previous release.', inputSchema: { type: 'object', properties: { request_id: { type: 'string', minLength: 8, maxLength: 120 } }, required: ['request_id'], additionalProperties: false } },
  { name: 'restart_stable_supervisor', description: 'Request a bounded Stable Supervisor restart.', inputSchema: { type: 'object', properties: { request_id: { type: 'string', minLength: 8, maxLength: 120 } }, required: ['request_id'], additionalProperties: false } },
  { name: 'reconnect_primary_connector', description: 'Check stable ingress and primary MCP reconnection readiness without rolling out.', inputSchema: { type: 'object', additionalProperties: false } },
] as const;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body) > 64 * 1024) { request.destroy(); reject(new Error('RECOVERY_REQUEST_TOO_LARGE')); }
    });
    request.on('end', () => resolveBody(body));
    request.on('error', reject);
  });
}

function requestId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{8,120}$/.test(value) ? value : undefined;
}

async function dispatch(config: RecoveryConfig, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'supervisor_status': return supervisorStatus(config);
    case 'list_slots': return listSlots(config);
    case 'verify_stable_runtime': return verifyStableRuntime(config);
    case 'verify_external_runtime': {
      const verified = await verifyStableRuntime(config);
      return { ok: verified.probes.external_mcp_http?.ok === true, external: verified.probes.external_mcp_http, mcp: verified.probes.mcp_initialize };
    }
    case 'rollback_previous': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      return rollbackPrevious(config, `recovery-gateway:${args.request_id}`);
    }
    case 'restart_stable_supervisor': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      return restartSupervisor(config);
    }
    case 'reconnect_primary_connector': return reconnectMain(config);
    default: throw new Error('RECOVERY_TOOL_NOT_FOUND');
  }
}

async function startGateway(config: RecoveryConfig): Promise<void> {
  const gateway = config.gateway;
  if (!gateway || gateway.host !== '127.0.0.1' || !Number.isInteger(gateway.port) || gateway.port < 1024 || gateway.port > 65535) {
    throw new Error('RECOVERY_GATEWAY_CONFIG_INVALID');
  }
  const recentMutations = new Map<string, number[]>();
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') { json(response, 200, { status: 'ok', service: 'repo-harness-standalone-recovery' }); return; }
    if (request.method !== 'POST' || !(request.url === '/mcp' || request.url?.startsWith('/mcp?'))) { json(response, 404, { error: 'NOT_FOUND' }); return; }
    const expected = gatewayToken(config);
    const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
    if (!expected || !supplied || !secureEqual(supplied, expected)) { response.setHeader('www-authenticate', 'Bearer realm="repo-harness-recovery"'); json(response, 401, { error: 'RECOVERY_AUTH_REQUIRED' }); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] ?? ''))) { json(response, 415, { error: 'RECOVERY_CONTENT_TYPE_REQUIRED' }); return; }
    let message: { id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: unknown } };
    try { message = JSON.parse(await readBody(request)) as typeof message; } catch { json(response, 400, rpcError(null, -32700, 'Invalid JSON.')); return; }
    const id = message.id ?? null;
    if (message.method === 'initialize') { json(response, 200, { jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'repo-harness-standalone-recovery', version: '1.0.0' } } }); return; }
    if (message.method === 'notifications/initialized') { response.statusCode = 202; response.end(); return; }
    if (message.method === 'tools/list') { json(response, 200, { jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }
    if (message.method !== 'tools/call' || typeof message.params?.name !== 'string') { json(response, 200, rpcError(id, -32601, 'Unsupported MCP method.')); return; }
    const name = message.params.name;
    const args = message.params.arguments && typeof message.params.arguments === 'object' && !Array.isArray(message.params.arguments) ? message.params.arguments as Record<string, unknown> : {};
    if (name === 'rollback_previous' || name === 'restart_stable_supervisor') {
      const address = request.socket.remoteAddress ?? 'unknown'; const now = Date.now();
      const window = (recentMutations.get(address) ?? []).filter((at) => now - at < 60_000);
      if (window.length >= 3) { json(response, 429, rpcError(id, -32029, 'Recovery mutation rate limit exceeded.')); return; }
      window.push(now); recentMutations.set(address, window);
    }
    try {
      const payload = await dispatch(config, name, args);
      json(response, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload } });
    } catch (error) { json(response, 200, rpcError(id, -32602, error instanceof Error ? error.message : 'Recovery request rejected')); }
  });
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(gateway.port, gateway.host, () => resolveListen()); });
  process.stdout.write(JSON.stringify({ status: 'ready', host: gateway.host, port: gateway.port }) + '\n');
}

void cli().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
