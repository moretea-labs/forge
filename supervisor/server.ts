import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { WorkflowSupervisorControlPlane } from './control-plane';

interface RpcRequest { id: string; method: string; params: Record<string, unknown> }
const MAX_REQUEST_BYTES = 1024 * 1024;

function request(value: unknown): RpcRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('WORKFLOW_SUPERVISOR_RPC_INVALID');
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id || typeof record.method !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(record.method)) throw new Error('WORKFLOW_SUPERVISOR_RPC_INVALID');
  return { id: record.id, method: record.method, params: record.params && typeof record.params === 'object' && !Array.isArray(record.params) ? record.params as Record<string, unknown> : {} };
}
function text(params: Record<string, unknown>, key: string): string { const value = params[key]; if (typeof value !== 'string' || !value.trim()) throw new Error(`WORKFLOW_SUPERVISOR_RPC_${key.toUpperCase()}_REQUIRED`); return value.trim(); }
function reply(socket: Socket, id: string, result: unknown): void { socket.write(`${JSON.stringify({ id, ok: true, result })}\n`); }
function fail(socket: Socket, id: string, error: unknown): void { const message = error instanceof Error ? error.message : String(error); socket.write(`${JSON.stringify({ id, ok: false, error: { code: message.split(':')[0], message } })}\n`); }

export function createWorkflowSupervisorServer(input: { controlPlane: WorkflowSupervisorControlPlane; socketPath: string }): Server {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0); let chain = Promise.resolve();
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_REQUEST_BYTES) { socket.destroy(new Error('WORKFLOW_SUPERVISOR_RPC_TOO_LARGE')); return; }
      let newline = buffer.indexOf(0x0a);
      while (newline >= 0) {
        const raw = buffer.subarray(0, newline).toString('utf8'); buffer = buffer.subarray(newline + 1);
        chain = chain.then(async () => {
          let id = 'invalid';
          try { const req = request(JSON.parse(raw)); id = req.id; reply(socket, id, await dispatch(input.controlPlane, req)); } catch (error) { fail(socket, id, error); }
        });
        newline = buffer.indexOf(0x0a);
      }
    });
  });
  server.once('listening', () => chmodSync(input.socketPath, 0o600));
  server.once('close', () => { if (existsSync(input.socketPath)) unlinkSync(input.socketPath); });
  mkdirSync(dirname(input.socketPath), { recursive: true, mode: 0o700 });
  // The socket path is the daemon's local single-writer fence. Never unlink an
  // existing socket speculatively: it may belong to a live Supervisor writer.
  // Evidence-based stale-socket recovery belongs to the restart-recovery step.
  if (existsSync(input.socketPath)) {
    if (!lstatSync(input.socketPath).isSocket()) throw new Error('WORKFLOW_SUPERVISOR_SOCKET_PATH_OCCUPIED');
    throw new Error('WORKFLOW_SUPERVISOR_WRITER_ALREADY_PRESENT');
  }
  server.listen(input.socketPath);
  return server;
}

async function dispatch(control: WorkflowSupervisorControlPlane, req: RpcRequest): Promise<unknown> {
  const p = req.params;
  if (req.method === 'health') return { status: 'ready', writer: 'workflow-supervisor-daemon' };
  if (req.method === 'task_register') return control.registerTask({ taskId: text(p, 'task_id'), conversationId: text(p, 'conversation_id'), conversationUrl: text(p, 'conversation_url'), objective: text(p, 'objective'), completionContract: object(p.completion_contract), continuationPolicy: object(p.continuation_policy), userBlockerPolicy: object(p.user_blocker_policy) });
  if (req.method === 'reserve_enrollment') return control.reserveEnrollment(text(p, 'task_id'));
  if (req.method === 'observe_effect') { const outcome = text(p, 'outcome'); if (!['applied','not_applied','unknown'].includes(outcome)) throw new Error('WORKFLOW_SUPERVISOR_RPC_OUTCOME_INVALID'); control.observeEffect({ effectId: text(p, 'effect_id'), observationId: text(p, 'observation_id'), outcome: outcome as 'applied'|'not_applied'|'unknown', evidence: object(p.evidence) }); return { recorded: true }; }
  if (req.method === 'observe_assistant') return control.observeAssistantTurn({ taskId: text(p, 'task_id'), conversationId: text(p, 'conversation_id'), responseText: text(p, 'response_text') });
  if (req.method === 'task_get') return control.getTask(text(p, 'task_id')) ?? null;
  if (req.method === 'effect_get') return control.getEffect(text(p, 'effect_id')) ?? null;
  throw new Error('WORKFLOW_SUPERVISOR_RPC_METHOD_UNKNOWN');
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
