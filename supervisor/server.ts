import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { WorkflowSupervisorControlPlane } from './control-plane';
import { parseChatgptConversationIdentity } from './chatgpt-conversation';

interface RpcRequest { id: string; method: string; params: Record<string, unknown> }
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_DISCOVERED_CONVERSATIONS = 64;
const MAX_DISCOVERY_TITLE_CHARS = 512;

export interface WorkflowSupervisorDiscoveredConversation {
  conversationId: string;
  canonicalUrl: string;
  title?: string;
}
export interface WorkflowSupervisorDiscoverySnapshot {
  observedAt: string;
  conversations: WorkflowSupervisorDiscoveredConversation[];
}
export class WorkflowSupervisorEphemeralDiscovery {
  private snapshot: WorkflowSupervisorDiscoverySnapshot = { observedAt: '', conversations: [] };
  update(value: unknown): WorkflowSupervisorDiscoverySnapshot {
    if (!Array.isArray(value) || value.length > MAX_DISCOVERED_CONVERSATIONS) throw new Error('WORKFLOW_SUPERVISOR_DISCOVERY_INVALID');
    const seen = new Set<string>();
    const conversations: WorkflowSupervisorDiscoveredConversation[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('WORKFLOW_SUPERVISOR_DISCOVERY_INVALID');
      const record = entry as Record<string, unknown>;
      const identity = parseChatgptConversationIdentity(String(record.canonical_url ?? ''));
      if (String(record.conversation_id ?? '') !== identity.conversationId) throw new Error('WORKFLOW_SUPERVISOR_DISCOVERY_IDENTITY_MISMATCH');
      if (seen.has(identity.conversationId)) continue;
      seen.add(identity.conversationId);
      const rawTitle = typeof record.title === 'string' ? record.title.trim() : '';
      conversations.push({ conversationId: identity.conversationId, canonicalUrl: identity.canonicalUrl, ...(rawTitle ? { title: rawTitle.slice(0, MAX_DISCOVERY_TITLE_CHARS) } : {}) });
    }
    this.snapshot = { observedAt: new Date().toISOString(), conversations };
    return this.get();
  }
  get(): WorkflowSupervisorDiscoverySnapshot { return structuredClone(this.snapshot); }
}

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
  const discovery = new WorkflowSupervisorEphemeralDiscovery();
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
          try { const req = request(JSON.parse(raw)); id = req.id; reply(socket, id, await dispatch(input.controlPlane, discovery, req)); } catch (error) { fail(socket, id, error); }
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

async function dispatch(control: WorkflowSupervisorControlPlane, discovery: WorkflowSupervisorEphemeralDiscovery, req: RpcRequest): Promise<unknown> {
  const p = req.params;
  if (req.method === 'health') return { status: 'ready', writer: 'workflow-supervisor-daemon' };
  if (req.method === 'browser_discovery') return discovery.get();
  if (req.method === 'browser_discovery_update') return discovery.update(p.conversations);
  if (req.method === 'browser_tasks') return { tasks: control.browserTasks() };
  if (req.method === 'browser_poll') return control.browserPoll({ conversationId: text(p, 'conversation_id'), conversationUrl: text(p, 'conversation_url') });
  if (req.method === 'browser_begin_effect') return control.browserBeginEffect({ conversationId: text(p, 'conversation_id'), conversationUrl: text(p, 'conversation_url'), effectId: text(p, 'effect_id'), dispatchId: text(p, 'dispatch_id'), dispatchGeneration: positiveInteger(p, 'dispatch_generation'), evidence: object(p.evidence) });
  if (req.method === 'browser_observe_effect') { const outcome = text(p, 'outcome'); if (!['applied','not_applied','unknown'].includes(outcome)) throw new Error('WORKFLOW_SUPERVISOR_RPC_OUTCOME_INVALID'); return control.browserObserveEffect({ conversationId: text(p, 'conversation_id'), conversationUrl: text(p, 'conversation_url'), effectId: text(p, 'effect_id'), observationId: text(p, 'observation_id'), outcome: outcome as 'applied'|'not_applied'|'unknown', evidence: object(p.evidence) }); }
  if (req.method === 'browser_observe_assistant') return control.browserObserveAssistant({ conversationId: text(p, 'conversation_id'), conversationUrl: text(p, 'conversation_url'), responseText: text(p, 'response_text') });
  if (req.method === 'task_register') return control.registerTask({ taskId: text(p, 'task_id'), conversationId: text(p, 'conversation_id'), conversationUrl: text(p, 'conversation_url'), objective: text(p, 'objective'), completionContract: object(p.completion_contract), continuationPolicy: object(p.continuation_policy), userBlockerPolicy: object(p.user_blocker_policy) });
  if (req.method === 'reserve_enrollment') return control.reserveEnrollment(text(p, 'task_id'));
  if (req.method === 'observe_effect') { const outcome = text(p, 'outcome'); if (!['applied','unknown'].includes(outcome)) throw new Error('WORKFLOW_SUPERVISOR_RPC_OUTCOME_INVALID'); control.observeEffect({ effectId: text(p, 'effect_id'), observationId: text(p, 'observation_id'), outcome: outcome as 'applied'|'unknown', evidence: object(p.evidence) }); return { recorded: true }; }
  if (req.method === 'observe_assistant') return control.observeAssistantTurn({ taskId: text(p, 'task_id'), conversationId: text(p, 'conversation_id'), responseText: text(p, 'response_text') });
  if (req.method === 'task_get') return control.getTask(text(p, 'task_id')) ?? null;
  if (req.method === 'effect_get') return control.getEffect(text(p, 'effect_id')) ?? null;
  throw new Error('WORKFLOW_SUPERVISOR_RPC_METHOD_UNKNOWN');
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function positiveInteger(params: Record<string, unknown>, key: string): number { const value = Number(params[key]); if (!Number.isInteger(value) || value < 1 || value > 1_000_000) throw new Error(`WORKFLOW_SUPERVISOR_RPC_${key.toUpperCase()}_INVALID`); return value; }
