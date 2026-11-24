import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  parseCanonicalChatgptConversationIdentity,
  type ComputerChatgptConversationIdentity,
  type ComputerChatgptConversationInventory,
  type ComputerChatgptConversationTargetPort,
  type ComputerChatgptExtensionCommandResult,
  type ComputerChatgptExtensionHeartbeat,
  type ComputerChatgptTargetIdentity,
} from '../../../packages/plugin-runtime/computer';
import { ChromeExtensionChatgptConversationTargetPort } from '../../../adapters/computer/chatgpt-target-provider';
import {
  inspectComputerChatgptExtensionProjection,
  projectComputerChatgptExtension,
} from './computer-chatgpt-extension-projection';
import { runtimeComputerInteractionTargetAuthority } from './computer-target-composition';

const MAX_REQUEST_BYTES = 1024 * 1024;
const PROVIDER_WAIT_MS = 4_000;
const PROVIDER_POLL_MS = 100;

type RuntimeComputerChatgptExtension = {
  controllerHome: string;
  socketPath: string;
  port: ChromeExtensionChatgptConversationTargetPort;
  server: Server;
};

type RpcRequest = {
  id: string;
  method: string;
  params: Record<string, unknown>;
};

export type RuntimeComputerChatgptActionInput =
  | { kind: 'ensure'; identity: ComputerChatgptTargetIdentity }
  | { kind: 'observe'; identity: ComputerChatgptConversationIdentity }
  | { kind: 'refresh'; identity: ComputerChatgptConversationIdentity }
  | { kind: 'find_marker'; marker: string; bootstrapKey: string }
  | { kind: 'prepare' | 'dispatch'; identity: ComputerChatgptTargetIdentity; prompt: string; mode?: 'send' | 'resume' | 'recover' };

const runtimes = new Map<string, Promise<RuntimeComputerChatgptExtension>>();

export function runtimeComputerChatgptExtensionSocketPath(controllerHome: string): string {
  return join(controllerHome, 'computer', 'chatgpt-extension.sock');
}

function request(value: unknown): RpcRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('COMPUTER_CHATGPT_EXTENSION_RPC_INVALID');
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const method = typeof record.method === 'string' ? record.method.trim() : '';
  if (!id || !/^[a-z][a-z0-9_]{0,127}$/.test(method)) throw new Error('COMPUTER_CHATGPT_EXTENSION_RPC_INVALID');
  return {
    id,
    method,
    params: record.params && typeof record.params === 'object' && !Array.isArray(record.params)
      ? record.params as Record<string, unknown>
      : {},
  };
}

function requiredText(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`COMPUTER_CHATGPT_EXTENSION_RPC_${key.toUpperCase()}_REQUIRED`);
  return value.trim();
}

function runtimeConversationIdentity(rawIdentity: unknown): ComputerChatgptConversationIdentity {
  if (!rawIdentity || typeof rawIdentity !== 'object' || Array.isArray(rawIdentity)) {
    throw new Error('COMPUTER_CHATGPT_RUNTIME_ACTION_IDENTITY_INVALID');
  }
  const record = rawIdentity as Record<string, unknown>;
  const conversationId = typeof record.conversationId === 'string' ? record.conversationId.trim() : '';
  const canonicalUrl = typeof record.canonicalUrl === 'string' ? record.canonicalUrl.trim() : '';
  let parsed: ReturnType<typeof parseCanonicalChatgptConversationIdentity>;
  try { parsed = parseCanonicalChatgptConversationIdentity(canonicalUrl); }
  catch { throw new Error('COMPUTER_CHATGPT_RUNTIME_ACTION_IDENTITY_INVALID'); }
  if (record.namespace !== 'chatgpt.conversation' || !conversationId || conversationId !== parsed.conversationId) {
    throw new Error('COMPUTER_CHATGPT_RUNTIME_ACTION_IDENTITY_INVALID');
  }
  return { namespace: 'chatgpt.conversation', conversationId, canonicalUrl: parsed.conversationUrl };
}

function runtimeTargetIdentity(rawIdentity: unknown): ComputerChatgptTargetIdentity {
  if (!rawIdentity || typeof rawIdentity !== 'object' || Array.isArray(rawIdentity)) {
    throw new Error('COMPUTER_CHATGPT_RUNTIME_ACTION_IDENTITY_INVALID');
  }
  const record = rawIdentity as Record<string, unknown>;
  if (record.namespace === 'chatgpt.conversation') return runtimeConversationIdentity(record);
  const bootstrapKey = typeof record.bootstrapKey === 'string' ? record.bootstrapKey.trim() : '';
  const projectUrl = typeof record.projectUrl === 'string' ? record.projectUrl.trim() : '';
  let parsed: URL;
  try { parsed = new URL(projectUrl); }
  catch { throw new Error('COMPUTER_CHATGPT_RUNTIME_ACTION_IDENTITY_INVALID'); }
  if (record.namespace !== 'chatgpt.bootstrap' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(bootstrapKey)
    || parsed.protocol !== 'https:' || parsed.hostname !== 'chatgpt.com' || parsed.username || parsed.password || parsed.search || parsed.hash
    || !/^\/g\/g-p-[a-z0-9]+(?:-[^/]+)?\/project\/?$/i.test(parsed.pathname)) {
    throw new Error('COMPUTER_CHATGPT_RUNTIME_ACTION_IDENTITY_INVALID');
  }
  return { namespace: 'chatgpt.bootstrap', bootstrapKey, projectUrl: `https://chatgpt.com${parsed.pathname.replace(/\/+$/, '')}` };
}

function runtimeActionInput(value: unknown): RuntimeComputerChatgptActionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('COMPUTER_CHATGPT_RUNTIME_ACTION_INVALID');
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (kind === 'find_marker') {
    const marker = typeof record.marker === 'string' ? record.marker.trim() : '';
    const bootstrapKey = typeof record.bootstrapKey === 'string' ? record.bootstrapKey.trim() : '';
    if (!marker || marker.length > 1024 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(bootstrapKey)) {
      throw new Error('COMPUTER_CHATGPT_RUNTIME_ACTION_INVALID');
    }
    return { kind, marker, bootstrapKey };
  }
  if (kind === 'ensure') return { kind, identity: runtimeTargetIdentity(record.identity) };
  if (kind === 'observe' || kind === 'refresh') return { kind, identity: runtimeConversationIdentity(record.identity) };
  if (kind !== 'prepare' && kind !== 'dispatch') throw new Error('COMPUTER_CHATGPT_RUNTIME_ACTION_INVALID');
  const prompt = typeof record.prompt === 'string' ? record.prompt : '';
  if (!prompt.trim()) throw new Error('COMPUTER_CHATGPT_RUNTIME_ACTION_PROMPT_REQUIRED');
  const mode = record.mode === 'resume' || record.mode === 'recover' ? record.mode : 'send';
  return { kind, identity: runtimeTargetIdentity(record.identity), prompt, mode };
}

async function executeRuntimeAction(
  port: ComputerChatgptConversationTargetPort,
  action: RuntimeComputerChatgptActionInput,
): Promise<Record<string, unknown>> {
  if (action.kind === 'find_marker') {
    const results = await port.findBySubmittedMarker(action.marker, action.bootstrapKey);
    const matches: Array<Record<string, unknown>> = [];
    for (const result of results) {
      if (result.state !== 'ready') {
        matches.push({ state: 'unavailable', failure: result.failure, ...(result.observation ? { observation: result.observation } : {}) });
        continue;
      }
      if (!result.observation) continue;
      try {
        const parsed = parseCanonicalChatgptConversationIdentity(result.observation.url);
        matches.push({
          state: 'ready',
          targetId: result.target.targetId,
          identity: { namespace: 'chatgpt.conversation', conversationId: parsed.conversationId, canonicalUrl: parsed.conversationUrl },
          observation: result.observation,
        });
      } catch { continue; }
    }
    return { matches };
  }
  const exact = action.kind === 'refresh'
    ? await port.refreshExact(action.identity)
    : action.identity.namespace === 'chatgpt.bootstrap'
      ? await port.openBootstrap(action.identity.projectUrl, action.identity.bootstrapKey)
      : await port.ensureExact(action.identity, { createIfMissing: action.kind !== 'observe' });
  if (exact.state !== 'ready') {
    return { state: exact.state, failure: exact.failure, ...(exact.observation ? { observation: exact.observation } : {}) };
  }
  if (action.kind === 'ensure') {
    return {
      state: 'ready', targetId: exact.target.targetId, identity: action.identity,
      observation: exact.observation ?? await exact.target.observe({ includeUserHistory: false, includePageText: false }),
    };
  }
  if (action.kind === 'observe' || action.kind === 'refresh') {
    return {
      state: 'ready', targetId: exact.target.targetId, identity: action.identity,
      observation: exact.observation ?? await exact.target.observe({ includeUserHistory: false, includePageText: false }),
    };
  }
  if (action.kind === 'prepare') {
    return { state: 'ready', targetId: exact.target.targetId, identity: action.identity, prepare: await exact.target.prepare(action.prompt, { mode: action.mode }) };
  }
  return { state: 'ready', targetId: exact.target.targetId, identity: action.identity, dispatch: await exact.target.dispatch(action.prompt, { mode: action.mode }) };
}

function response(socket: Socket, id: string, result: unknown): void {
  socket.write(`${JSON.stringify({ id, ok: true, result })}\n`);
}

function failure(socket: Socket, id: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  socket.write(`${JSON.stringify({
    id,
    ok: false,
    error: {
      code: message.includes(':') ? message.slice(0, message.indexOf(':')) : message,
      message,
      retryable: false,
    },
  })}\n`);
}

async function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
}

async function callRuntimeOwnerAction(
  socketPath: string,
  action: RuntimeComputerChatgptActionInput,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const boundedTimeoutMs = Math.max(1_000, Math.min((timeoutMs ?? 20_000) + 1_000, 31_000));
  return await new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result ?? {});
    };
    const timer = setTimeout(
      () => finish(new Error('COMPUTER_CHATGPT_RUNTIME_ACTION_TIMEOUT')),
      boundedTimeoutMs,
    );
    socket.once('error', (error) => finish(error));
    socket.once('connect', () => {
      socket.write(JSON.stringify({ id, method: 'computer_runtime_action', params: { action } }) + '\n');
    });
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_REQUEST_BYTES) {
        finish(new Error('COMPUTER_CHATGPT_RUNTIME_ACTION_RESPONSE_TOO_LARGE'));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const envelope = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as {
          id?: string;
          ok?: boolean;
          result?: Record<string, unknown>;
          error?: { message?: string };
        };
        if (envelope.id !== id || typeof envelope.ok !== 'boolean') {
          finish(new Error('COMPUTER_CHATGPT_RUNTIME_ACTION_PROTOCOL_ERROR'));
          return;
        }
        if (envelope.ok) finish(undefined, envelope.result ?? {});
        else finish(new Error(envelope.error?.message ?? 'COMPUTER_CHATGPT_RUNTIME_ACTION_FAILED'));
      } catch {
        finish(new Error('COMPUTER_CHATGPT_RUNTIME_ACTION_PROTOCOL_ERROR'));
      }
    });
  });
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  if (!existsSync(socketPath)) return;
  if (!lstatSync(socketPath).isSocket()) throw new Error('COMPUTER_CHATGPT_EXTENSION_SOCKET_PATH_OCCUPIED');
  if (await socketAcceptsConnections(socketPath)) throw new Error('COMPUTER_CHATGPT_EXTENSION_SOCKET_ALREADY_OWNED');
  unlinkSync(socketPath);
}

async function dispatch(
  port: ChromeExtensionChatgptConversationTargetPort,
  request: RpcRequest,
): Promise<Record<string, unknown>> {
  const params = request.params;
  if (request.method === 'health') return { status: 'ready', owner: 'computer' };
  if (request.method === 'computer_runtime_action') {
    return await executeRuntimeAction(port, runtimeActionInput(params.action));
  }
  if (request.method === 'computer_extension_heartbeat') {
    return { recorded: port.heartbeat(params as unknown as ComputerChatgptExtensionHeartbeat) };
  }
  if (request.method === 'computer_extension_claim') {
    return { command: port.claim(requiredText(params, 'provider_instance_id')) ?? null };
  }
  if (request.method === 'computer_extension_complete') {
    const result = params.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('COMPUTER_CHATGPT_EXTENSION_RPC_RESULT_REQUIRED');
    }
    return {
      recorded: port.complete(
        requiredText(params, 'provider_instance_id'),
        requiredText(params, 'command_id'),
        result as ComputerChatgptExtensionCommandResult,
      ),
    };
  }
  throw new Error(`COMPUTER_CHATGPT_EXTENSION_RPC_METHOD_DENIED:${request.method}`);
}

function serverFor(port: ChromeExtensionChatgptConversationTargetPort, socketPath: string): Server {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let chain = Promise.resolve();
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_REQUEST_BYTES) {
        socket.destroy(new Error('COMPUTER_CHATGPT_EXTENSION_RPC_TOO_LARGE'));
        return;
      }
      let newline = buffer.indexOf(0x0a);
      while (newline >= 0) {
        const raw = buffer.subarray(0, newline).toString('utf8');
        buffer = buffer.subarray(newline + 1);
        chain = chain.then(async () => {
          let id = 'invalid';
          try {
            const parsed = request(JSON.parse(raw));
            id = parsed.id;
            response(socket, id, await dispatch(port, parsed));
          } catch (error) {
            failure(socket, id, error);
          }
        });
        newline = buffer.indexOf(0x0a);
      }
    });
  });
  server.once('listening', () => chmodSync(socketPath, 0o600));
  server.once('close', () => {
    try {
      if (existsSync(socketPath) && lstatSync(socketPath).isSocket()) unlinkSync(socketPath);
    } catch { /* process shutdown or concurrent cleanup */ }
  });
  return server;
}

async function createRuntimeComputerChatgptExtension(
  controllerHome: string,
): Promise<RuntimeComputerChatgptExtension> {
  // Stage the Chrome-loadable extension + Native Messaging host before the
  // broker listens when an active Runtime release is present. Fixture/tests
  // without a release keep the socket-only path; production Runtime always has
  // a release and must not leave a stale unpacked extension loaded.
  const existingProjection = inspectComputerChatgptExtensionProjection(controllerHome);
  if (existingProjection.state !== 'runtime_release_incomplete') {
    const projection = projectComputerChatgptExtension(controllerHome);
    if (!projection.projectionCurrent) {
      throw new Error(`COMPUTER_CHATGPT_EXTENSION_PROJECTION_FAILED:${projection.state}:${projection.detail}`);
    }
  }
  const socketPath = runtimeComputerChatgptExtensionSocketPath(controllerHome);
  await prepareSocketPath(socketPath);
  const port = new ChromeExtensionChatgptConversationTargetPort(
    controllerHome,
    runtimeComputerInteractionTargetAuthority(),
  );
  const server = serverFor(port, socketPath);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  server.unref();
  return { controllerHome, socketPath, port, server };
}

export async function ensureRuntimeComputerChatgptExtension(
  controllerHome: string,
): Promise<RuntimeComputerChatgptExtension> {
  const existing = runtimes.get(controllerHome);
  if (existing) return await existing;
  const created = createRuntimeComputerChatgptExtension(controllerHome);
  runtimes.set(controllerHome, created);
  try {
    return await created;
  } catch (error) {
    if (runtimes.get(controllerHome) === created) runtimes.delete(controllerHome);
    throw error;
  }
}

export async function runtimeComputerChatgptTargetPort(
  controllerHome: string,
  options: { waitForProvider?: boolean; timeoutMs?: number } = {},
): Promise<ComputerChatgptConversationTargetPort> {
  const runtime = await ensureRuntimeComputerChatgptExtension(controllerHome);
  if (options.waitForProvider === false) return runtime.port;
  const deadline = Date.now() + Math.max(0, Math.min(options.timeoutMs ?? PROVIDER_WAIT_MS, 15_000));
  while (true) {
    const inventory = await runtime.port.inventory();
    if (inventory.providerInventoryReady === true || inventory.complete || inventory.conversations.length > 0) return runtime.port;
    if (Date.now() >= deadline) return runtime.port;
    await new Promise((resolve) => setTimeout(resolve, PROVIDER_POLL_MS));
  }
}

export async function runtimeComputerChatgptAction(
  controllerHome: string,
  input: RuntimeComputerChatgptActionInput,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const action = runtimeActionInput(input);
  const existing = runtimes.get(controllerHome);
  if (existing) return await executeRuntimeAction((await existing).port, action);
  const socketPath = runtimeComputerChatgptExtensionSocketPath(controllerHome);
  if (await socketAcceptsConnections(socketPath)) {
    return await callRuntimeOwnerAction(socketPath, action, timeoutMs);
  }
  return await executeRuntimeAction(
    (await ensureRuntimeComputerChatgptExtension(controllerHome)).port,
    action,
  );
}

export async function runtimeComputerChatgptInventory(
  controllerHome: string,
  timeoutMs?: number,
): Promise<ComputerChatgptConversationInventory> {
  const port = await runtimeComputerChatgptTargetPort(controllerHome, { timeoutMs });
  return await port.inventory();
}

export async function closeRuntimeComputerChatgptExtension(controllerHome: string): Promise<void> {
  const pending = runtimes.get(controllerHome);
  if (!pending) return;
  runtimes.delete(controllerHome);
  const runtime = await pending;
  await runtime.port.close();
  await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
}

export const closeRuntimeComputerChatgptExtensionForTest = closeRuntimeComputerChatgptExtension;
