import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import type {
  ComputerChatgptConversationInventory,
  ComputerChatgptConversationTargetPort,
  ComputerChatgptExtensionCommandResult,
  ComputerChatgptExtensionHeartbeat,
} from '../../../packages/plugin-runtime/computer';
import { ChromeExtensionChatgptConversationTargetPort } from '../../../adapters/computer/chatgpt-target-provider';
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

export async function closeRuntimeComputerChatgptExtensionForTest(controllerHome: string): Promise<void> {
  const pending = runtimes.get(controllerHome);
  if (!pending) return;
  runtimes.delete(controllerHome);
  const runtime = await pending;
  await runtime.port.close();
  await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
}
