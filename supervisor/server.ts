import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
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

/** Ephemeral socket binding to the Canonical Runtime's durable incarnation. */
export interface WorkflowSupervisorWriterIdentity {
  runtimeInstanceId: string;
  fencingGeneration: number;
  pid: number;
}

export interface WorkflowSupervisorSocketOwner extends WorkflowSupervisorWriterIdentity {
  schemaVersion: 1;
  recordedAt: string;
}

export function workflowSupervisorSocketOwnerPath(socketPath: string): string {
  return `${socketPath}.owner.json`;
}

function writeSocketOwner(socketPath: string, identity: WorkflowSupervisorWriterIdentity): void {
  const path = workflowSupervisorSocketOwnerPath(socketPath);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, ...identity, recordedAt: new Date().toISOString() } satisfies WorkflowSupervisorSocketOwner)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

export function readWorkflowSupervisorSocketOwner(socketPath: string): WorkflowSupervisorSocketOwner | undefined {
  const path = workflowSupervisorSocketOwnerPath(socketPath);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as WorkflowSupervisorSocketOwner;
    if (value.schemaVersion !== 1 || !value.runtimeInstanceId || !Number.isInteger(value.fencingGeneration) || value.fencingGeneration < 1 || !Number.isInteger(value.pid) || value.pid < 1) return undefined;
    return value;
  } catch { return undefined; }
}

function sameWriterIdentity(left: WorkflowSupervisorWriterIdentity, right: WorkflowSupervisorWriterIdentity): boolean {
  return left.runtimeInstanceId === right.runtimeInstanceId
    && left.fencingGeneration === right.fencingGeneration
    && left.pid === right.pid;
}

function writerProcessStillAlive(writer: WorkflowSupervisorWriterIdentity): boolean {
  try {
    process.kill(writer.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
}


export interface WorkflowSupervisorSocketInspection {
  exists: boolean;
  isSocket: boolean;
  acceptsConnections: boolean;
  owner?: WorkflowSupervisorSocketOwner;
}

export async function inspectWorkflowSupervisorSocket(socketPath: string): Promise<WorkflowSupervisorSocketInspection> {
  if (!existsSync(socketPath)) {
    return { exists: false, isSocket: false, acceptsConnections: false };
  }
  let isSocket = false;
  try { isSocket = lstatSync(socketPath).isSocket(); } catch { /* raced with cleanup */ }
  if (!isSocket) {
    return {
      exists: existsSync(socketPath),
      isSocket: false,
      acceptsConnections: false,
      owner: readWorkflowSupervisorSocketOwner(socketPath),
    };
  }
  return {
    exists: true,
    isSocket: true,
    acceptsConnections: await socketAcceptsConnections(socketPath),
    owner: readWorkflowSupervisorSocketOwner(socketPath),
  };
}

/**
 * Recovery uses this only after the Runtime service and Runtime ownership have
 * been proven stopped. It never removes a live socket. The owner sidecar is
 * forensic evidence, not independent lifecycle authority.
 */
export async function reconcileStoppedWorkflowSupervisorSocket(socketPath: string): Promise<{
  ok: boolean;
  changed: boolean;
  detail: string;
  inspection: WorkflowSupervisorSocketInspection;
}> {
  const inspection = await inspectWorkflowSupervisorSocket(socketPath);
  if (!inspection.exists) {
    return { ok: true, changed: false, detail: 'Workflow Supervisor socket is already quiescent', inspection };
  }
  if (!inspection.isSocket) {
    return { ok: false, changed: false, detail: 'WORKFLOW_SUPERVISOR_SOCKET_PATH_OCCUPIED', inspection };
  }
  if (inspection.acceptsConnections) {
    return { ok: false, changed: false, detail: 'WORKFLOW_SUPERVISOR_WRITER_STILL_LIVE', inspection };
  }
  try { unlinkSync(socketPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try { unlinkSync(workflowSupervisorSocketOwnerPath(socketPath)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { ok: true, changed: true, detail: 'stale Workflow Supervisor socket authority was reconciled after Runtime shutdown', inspection };
}

/**
 * A stale socket is removable only after it rejects a connection and its
 * recorded writer is not the incoming incarnation. A live socket remains a
 * hard conflict; this is fencing/reconciliation, not a retry special case.
 */
export async function reconcileWorkflowSupervisorSocket(input: {
  socketPath: string;
  incoming: WorkflowSupervisorWriterIdentity;
}): Promise<void> {
  if (!existsSync(input.socketPath)) return;
  if (!lstatSync(input.socketPath).isSocket()) throw new Error('WORKFLOW_SUPERVISOR_SOCKET_PATH_OCCUPIED');
  if (await socketAcceptsConnections(input.socketPath)) throw new Error('WORKFLOW_SUPERVISOR_WRITER_ALREADY_PRESENT');
  const owner = readWorkflowSupervisorSocketOwner(input.socketPath);
  if (owner && sameWriterIdentity(owner, input.incoming)) {
    throw new Error('WORKFLOW_SUPERVISOR_SOCKET_STALE_FOR_CURRENT_INCARNATION');
  }
  if (owner && writerProcessStillAlive(owner)) {
    throw new Error('WORKFLOW_SUPERVISOR_WRITER_PROCESS_STILL_LIVE');
  }
  try { unlinkSync(input.socketPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try { unlinkSync(workflowSupervisorSocketOwnerPath(input.socketPath)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
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

export function createWorkflowSupervisorServer(input: { controlPlane: WorkflowSupervisorControlPlane; socketPath: string; discovery?: WorkflowSupervisorEphemeralDiscovery; writer?: WorkflowSupervisorWriterIdentity }): Server {
  const discovery = input.discovery ?? new WorkflowSupervisorEphemeralDiscovery();
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
  server.once('listening', () => {
    chmodSync(input.socketPath, 0o600);
    if (input.writer) writeSocketOwner(input.socketPath, input.writer);
  });
  server.once('close', () => {
    const owner = readWorkflowSupervisorSocketOwner(input.socketPath);
    if (input.writer && (!owner || !sameWriterIdentity(owner, input.writer))) return;
    if (existsSync(input.socketPath)) unlinkSync(input.socketPath);
    const ownerPath = workflowSupervisorSocketOwnerPath(input.socketPath);
    if (existsSync(ownerPath)) unlinkSync(ownerPath);
  });
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
  if (req.method === 'reserve_scheduler_recovery') return control.reserveSchedulerRecovery(text(p, 'task_id'), typeof p.recovery_key === 'string' ? p.recovery_key : undefined) ?? null;
  if (req.method === 'observe_effect') { const outcome = text(p, 'outcome'); if (!['applied','unknown'].includes(outcome)) throw new Error('WORKFLOW_SUPERVISOR_RPC_OUTCOME_INVALID'); control.observeEffect({ effectId: text(p, 'effect_id'), observationId: text(p, 'observation_id'), outcome: outcome as 'applied'|'unknown', evidence: object(p.evidence) }); return { recorded: true }; }
  if (req.method === 'observe_assistant') return control.observeAssistantTurn({ taskId: text(p, 'task_id'), conversationId: text(p, 'conversation_id'), responseText: text(p, 'response_text') });
  if (req.method === 'task_get') return control.getTask(text(p, 'task_id')) ?? null;
  if (req.method === 'effect_get') return control.getEffect(text(p, 'effect_id')) ?? null;
  throw new Error('WORKFLOW_SUPERVISOR_RPC_METHOD_UNKNOWN');
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function positiveInteger(params: Record<string, unknown>, key: string): number { const value = Number(params[key]); if (!Number.isInteger(value) || value < 1 || value > 1_000_000) throw new Error(`WORKFLOW_SUPERVISOR_RPC_${key.toUpperCase()}_INVALID`); return value; }
