import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import {
  parseCanonicalChatgptConversationIdentity,
  type ComputerChatgptConversationIdentity,
  ComputerChatgptConversationInventory,
  ComputerChatgptConversationTargetPort,
  ComputerChatgptTargetIdentity,
  ComputerChatgptExtensionCommandResult,
  ComputerChatgptExtensionHeartbeat,
} from '../../../packages/plugin-runtime/computer';
import { ChromeExtensionChatgptConversationTargetPort } from '../../../adapters/computer/chatgpt-target-provider';
import { runtimeComputerInteractionTargetAuthority } from './computer-target-composition';

const MAX_REQUEST_BYTES = 1024 * 1024;
const PROVIDER_WAIT_MS = 4_000;
const PROVIDER_POLL_MS = 100;
const TARGET_CONTROL_TIMEOUT_MS = {
  inventory: 5_000,
  ensure: 60_000,
  observe: 60_000,
  find_marker: 60_000,
  prepare: 60_000,
  dispatch: 60_000,
} as const;

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

function requiredConversationIdentity(params: Record<string, unknown>): ComputerChatgptConversationIdentity {
  const raw = params.identity;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('COMPUTER_CHATGPT_EXTENSION_RPC_IDENTITY_REQUIRED');
  }
  const identity = raw as Record<string, unknown>;
  const conversationId = typeof identity.conversationId === 'string' ? identity.conversationId.trim() : '';
  const canonicalUrl = typeof identity.canonicalUrl === 'string' ? identity.canonicalUrl.trim() : '';
  if (identity.namespace !== 'chatgpt.conversation' || !conversationId || !canonicalUrl) {
    throw new Error('COMPUTER_CHATGPT_EXTENSION_RPC_IDENTITY_INVALID');
  }
  return { namespace: 'chatgpt.conversation', conversationId, canonicalUrl };
}

function requiredTargetIdentity(params: Record<string, unknown>): ComputerChatgptTargetIdentity {
  const raw = params.identity;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('COMPUTER_CHATGPT_EXTENSION_RPC_IDENTITY_REQUIRED');
  }
  const identity = raw as Record<string, unknown>;
  if (identity.namespace === 'chatgpt.conversation') return requiredConversationIdentity(params);
  const bootstrapKey = typeof identity.bootstrapKey === 'string' ? identity.bootstrapKey.trim() : '';
  const projectUrl = typeof identity.projectUrl === 'string' ? identity.projectUrl.trim() : '';
  let parsed: URL;
  try { parsed = new URL(projectUrl); }
  catch { throw new Error('COMPUTER_CHATGPT_EXTENSION_RPC_IDENTITY_INVALID'); }
  if (identity.namespace !== 'chatgpt.bootstrap' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(bootstrapKey)
    || parsed.protocol !== 'https:' || parsed.hostname !== 'chatgpt.com' || parsed.username || parsed.password || parsed.search || parsed.hash
    || !/^\/g\/g-p-[a-z0-9]+(?:-[^/]+)?\/project\/?$/i.test(parsed.pathname)) {
    throw new Error('COMPUTER_CHATGPT_EXTENSION_RPC_IDENTITY_INVALID');
  }
  return { namespace: 'chatgpt.bootstrap', bootstrapKey, projectUrl: `https://chatgpt.com${parsed.pathname.replace(/\/+$/, '')}` };
}

function normalizedMode(params: Record<string, unknown>): 'send' | 'resume' | 'recover' {
  return params.mode === 'resume' || params.mode === 'recover' ? params.mode : 'send';
}

async function executeTargetControl(
  port: ChromeExtensionChatgptConversationTargetPort,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (method === 'computer_target_inventory') {
    const inventory = await port.inventory();
    return {
      conversations: inventory.conversations,
      complete: inventory.complete,
      ...(inventory.providerInventoryReady === undefined ? {} : { providerInventoryReady: inventory.providerInventoryReady }),
      unavailableProviders: inventory.unavailableProviders,
    };
  }
  if (method === 'computer_target_find_marker') {
    const bootstrapKey = requiredText(params, 'bootstrapKey');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(bootstrapKey)) throw new Error('COMPUTER_CHATGPT_EXTENSION_RPC_BOOTSTRAP_KEY_INVALID');
    const results = await port.findBySubmittedMarker(requiredText(params, 'marker'), bootstrapKey);
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
      } catch {
        continue;
      }
    }
    return { matches };
  }
  const identity = method === 'computer_target_observe' ? requiredConversationIdentity(params) : requiredTargetIdentity(params);
  const exact = identity.namespace === 'chatgpt.bootstrap'
    ? await port.openBootstrap(identity.projectUrl, identity.bootstrapKey)
    : await port.ensureExact(identity, { createIfMissing: method !== 'computer_target_observe' });
  if (exact.state !== 'ready') {
    return {
      state: exact.state,
      failure: exact.failure,
      ...(exact.observation ? { observation: exact.observation } : {}),
    };
  }
  if (method === 'computer_target_ensure') {
    return {
      state: 'ready',
      targetId: exact.target.targetId,
      identity,
      ...(exact.observation ? { observation: exact.observation } : {}),
    };
  }
  if (method === 'computer_target_observe') {
    return {
      state: 'ready',
      targetId: exact.target.targetId,
      identity,
      observation: exact.observation ?? await exact.target.observe({ includeUserHistory: false, includePageText: false }),
    };
  }
  const prompt = requiredText(params, 'prompt');
  const mode = normalizedMode(params);
  if (method === 'computer_target_prepare') {
    return {
      state: 'ready',
      targetId: exact.target.targetId,
      identity,
      prepare: await exact.target.prepare(prompt, { mode }),
    };
  }
  if (method === 'computer_target_dispatch') {
    return {
      state: 'ready',
      targetId: exact.target.targetId,
      identity,
      dispatch: await exact.target.dispatch(prompt, { mode }),
    };
  }
  throw new Error(`COMPUTER_CHATGPT_EXTENSION_RPC_METHOD_DENIED:${method}`);
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
  if (request.method === 'computer_target_inventory'
    || request.method === 'computer_target_ensure'
    || request.method === 'computer_target_observe'
    || request.method === 'computer_target_find_marker'
    || request.method === 'computer_target_prepare'
    || request.method === 'computer_target_dispatch') {
    return await executeTargetControl(port, request.method, params);
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

async function callComputerChatgptExtensionSocket(
  controllerHome: string,
  method: 'computer_target_inventory' | 'computer_target_ensure' | 'computer_target_observe' | 'computer_target_find_marker' | 'computer_target_prepare' | 'computer_target_dispatch',
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const socketPath = runtimeComputerChatgptExtensionSocketPath(controllerHome);
  const id = `computer-target-${randomUUID()}`;
  return await new Promise((resolve, reject) => {
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
      () => finish(new Error(`COMPUTER_CHATGPT_EXTENSION_CONTROL_TIMEOUT:${method}`)),
      Math.max(1_000, Math.min(timeoutMs, 60_000)),
    );
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id, method, params })}
`);
    });
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_REQUEST_BYTES) {
        finish(new Error('COMPUTER_CHATGPT_EXTENSION_CONTROL_RESPONSE_TOO_LARGE'));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      let envelope: { id?: unknown; ok?: unknown; result?: unknown; error?: { message?: unknown } };
      try {
        envelope = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
      } catch {
        finish(new Error('COMPUTER_CHATGPT_EXTENSION_CONTROL_PROTOCOL_ERROR'));
        return;
      }
      if (envelope.id !== id || typeof envelope.ok !== 'boolean') {
        finish(new Error('COMPUTER_CHATGPT_EXTENSION_CONTROL_PROTOCOL_ERROR'));
        return;
      }
      if (envelope.ok === false) {
        finish(new Error(typeof envelope.error?.message === 'string'
          ? envelope.error.message
          : 'COMPUTER_CHATGPT_EXTENSION_CONTROL_REMOTE_ERROR'));
        return;
      }
      const result = envelope.result;
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        finish(new Error('COMPUTER_CHATGPT_EXTENSION_CONTROL_RESULT_INVALID'));
        return;
      }
      finish(undefined, result as Record<string, unknown>);
    });
    socket.once('error', (error) => finish(new Error(`COMPUTER_CHATGPT_EXTENSION_SOCKET_UNAVAILABLE:${error.message}`)));
    socket.once('end', () => {
      if (!settled) finish(new Error('COMPUTER_CHATGPT_EXTENSION_CONTROL_PROTOCOL_ERROR:socket_closed'));
    });
  });
}

export async function callRuntimeComputerChatgptTargetAction(
  controllerHome: string,
  method: 'inventory' | 'ensure' | 'observe' | 'find_marker' | 'prepare' | 'dispatch',
  params: Record<string, unknown>,
  timeoutMs: number = TARGET_CONTROL_TIMEOUT_MS[method],
): Promise<Record<string, unknown>> {
  return await callComputerChatgptExtensionSocket(
    controllerHome,
    `computer_target_${method}` as 'computer_target_inventory' | 'computer_target_ensure' | 'computer_target_observe' | 'computer_target_find_marker' | 'computer_target_prepare' | 'computer_target_dispatch',
    params,
    timeoutMs,
  );
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
