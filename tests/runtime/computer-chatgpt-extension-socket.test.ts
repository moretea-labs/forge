import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import {
  closeRuntimeComputerChatgptExtensionForTest,
  ensureRuntimeComputerChatgptExtension,
  runtimeComputerChatgptAction,
  runtimeComputerChatgptInventory,
} from '../../src/runtime/root/computer-chatgpt-extension';

const homes: string[] = [];
afterEach(async () => {
  while (homes.length) {
    const home = homes.pop()!;
    await closeRuntimeComputerChatgptExtensionForTest(home).catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'forge-computer-chatgpt-'));
  homes.push(value);
  return value;
}

function jsonlRpc(socketPath: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const socket = createConnection(socketPath);
    let buffer = '';
    socket.once('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const value = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      socket.destroy();
      resolve(value);
    });
  });
}

test('Computer heartbeat tolerates bounded Windows-to-WSL clock skew without trusting future freshness', async () => {
  const controllerHome = home();
  const runtime = await ensureRuntimeComputerChatgptExtension(controllerHome);
  const base = Date.now();

  const bounded = await jsonlRpc(runtime.socketPath, 'computer_extension_heartbeat', {
    providerId: 'browser.chrome-extension',
    providerInstanceId: 'centbrowser-skew',
    observedAt: new Date(base + 1_000).toISOString(),
    conversations: [],
  });
  expect(bounded).toMatchObject({ ok: true, result: { recorded: true } });

  const tooFarFuture = await jsonlRpc(runtime.socketPath, 'computer_extension_heartbeat', {
    providerId: 'browser.chrome-extension',
    providerInstanceId: 'centbrowser-skew',
    observedAt: new Date(base + 10_000).toISOString(),
    conversations: [],
  });
  expect(tooFarFuture).toMatchObject({ ok: true, result: { recorded: false } });
});

test('Computer exact-target socket owns heartbeat, claim, and completion without Supervisor state', async () => {
  const controllerHome = home();
  const runtime = await ensureRuntimeComputerChatgptExtension(controllerHome);
  expect(runtime.socketPath).toBe(join(controllerHome, 'computer', 'chatgpt-extension.sock'));

  const canonicalUrl = 'https://chatgpt.com/c/socket-test-123';
  const binding = {
    providerId: 'browser.chrome-extension',
    observedAt: new Date().toISOString(),
    providerSessionId: 'centbrowser-default',
    browserProduct: 'chrome',
    windowId: '7',
    tabId: '42',
    ownerToken: ['owner', 'socket', 'test'].join('-')
  };
  const heartbeat = await jsonlRpc(runtime.socketPath, 'computer_extension_heartbeat', {
    providerId: 'browser.chrome-extension',
    providerInstanceId: 'centbrowser-default',
    observedAt: new Date().toISOString(),
    conversations: [{
      conversationId: 'socket-test-123',
      canonicalUrl,
      title: 'Socket test',
      isCurrent: true,
      providerBinding: binding,
    }],
  });
  expect(heartbeat).toMatchObject({ ok: true, result: { recorded: true } });

  const inventory = await runtimeComputerChatgptInventory(controllerHome, 100);
  expect(inventory.conversations).toContainEqual(expect.objectContaining({
    conversationId: 'socket-test-123',
    canonicalUrl,
  }));

  const exactPromise = runtime.port.ensureExact({
    namespace: 'chatgpt.conversation',
    conversationId: 'socket-test-123',
    canonicalUrl,
  }, { createIfMissing: false });

  let claim: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    claim = await jsonlRpc(runtime.socketPath, 'computer_extension_claim', {
      provider_instance_id: 'centbrowser-default',
    });
    if ((claim.result as { command?: unknown } | undefined)?.command) break;
    await Bun.sleep(10);
  }
  const command = (claim!.result as { command: Record<string, unknown> }).command;
  expect(command).toMatchObject({
    kind: 'observe',
    identity: { namespace: 'chatgpt.conversation', conversationId: 'socket-test-123', canonicalUrl },
  });

  const observation = {
    url: canonicalUrl,
    title: 'Socket test',
    latestUserText: '',
    latestAssistantResponse: '',
    composerText: '',
    providerActivityText: '',
    providerFailureText: '',
    isGenerating: false,
  };
  const completion = await jsonlRpc(runtime.socketPath, 'computer_extension_complete', {
    provider_instance_id: 'centbrowser-default',
    command_id: command.commandId,
    result: { kind: 'observation', providerBinding: binding, observation },
  });
  expect(completion).toMatchObject({ ok: true, result: { recorded: true } });

  const exact = await exactPromise;
  expect(exact.state).toBe('ready');
  if (exact.state === 'ready') {
    expect(exact.target.targetId).toBeTruthy();
    expect(exact.observation).toEqual(observation);
  }
});

test('durable worker proxies observe through the Runtime-owned Computer socket', async () => {
  const controllerHome = home();
  const runtime = await ensureRuntimeComputerChatgptExtension(controllerHome);
  const canonicalUrl = 'https://chatgpt.com/c/socket-worker-456';
  const binding = {
    providerId: 'browser.chrome-extension',
    observedAt: new Date().toISOString(),
    providerSessionId: 'centbrowser-worker',
    browserProduct: 'chrome',
    windowId: '8',
    tabId: '43',
    ownerToken: 'worker-socket-test-owner-token',
  };
  await jsonlRpc(runtime.socketPath, 'computer_extension_heartbeat', {
    providerId: 'browser.chrome-extension',
    providerInstanceId: 'centbrowser-worker',
    observedAt: new Date().toISOString(),
    conversations: [{
      conversationId: 'socket-worker-456',
      canonicalUrl,
      title: 'Worker socket test',
      isCurrent: true,
      providerBinding: binding,
    }],
  });

  const childCode = `
    import { runtimeComputerChatgptAction } from './src/runtime/root/computer-chatgpt-extension.ts';
    const result = await runtimeComputerChatgptAction(process.env.FORGE_CONTROLLER_HOME, {
      kind: 'observe',
      identity: {
        namespace: 'chatgpt.conversation',
        conversationId: 'socket-worker-456',
        canonicalUrl: 'https://chatgpt.com/c/socket-worker-456',
      },
    }, 5000);
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawn(process.execPath, ['-e', childCode], {
    cwd: process.cwd(),
    env: { ...process.env, FORGE_CONTROLLER_HOME: controllerHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let claim: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    claim = await jsonlRpc(runtime.socketPath, 'computer_extension_claim', {
      provider_instance_id: 'centbrowser-worker',
    });
    if ((claim.result as { command?: unknown } | undefined)?.command) break;
    await Bun.sleep(10);
  }
  const command = (claim!.result as { command: Record<string, unknown> }).command;
  expect(command).toMatchObject({ kind: 'observe' });
  const observation = {
    url: canonicalUrl,
    title: 'Worker socket test',
    latestUserText: '',
    latestAssistantResponse: '',
    composerText: '',
    providerActivityText: '',
    providerFailureText: '',
    isGenerating: false,
  };
  await jsonlRpc(runtime.socketPath, 'computer_extension_complete', {
    provider_instance_id: 'centbrowser-worker',
    command_id: command.commandId,
    result: { kind: 'observation', providerBinding: binding, observation },
  });

  const childResult = await new Promise<Record<string, unknown>>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) { reject(new Error(stderr || 'child exited ' + code)); return; }
      resolve(JSON.parse(stdout));
    });
  });
  expect(childResult).toMatchObject({
    state: 'ready',
    identity: { namespace: 'chatgpt.conversation', conversationId: 'socket-worker-456', canonicalUrl },
    observation,
  });
});

test('canonical Computer socket opens one Project bootstrap and reconciles its submitted marker', async () => {
  const controllerHome = home();
  const runtime = await ensureRuntimeComputerChatgptExtension(controllerHome);
  const provider = 'centbrowser-bootstrap';
  await jsonlRpc(runtime.socketPath, 'computer_extension_heartbeat', {
    providerId: 'browser.chrome-extension', providerInstanceId: provider,
    observedAt: new Date().toISOString(), conversations: [],
  });
  const projectUrl = 'https://chatgpt.com/g/g-p-forge-test/project';
  const bootstrapKey = 'supervisor:forge-source';
  const binding = {
    providerId: 'browser.chrome-extension', providerSessionId: provider, browserProduct: 'chrome',
    observedAt: new Date().toISOString(), windowId: '31', tabId: '41', ownerToken: 'bootstrap-owner-token',
  };
  const ensurePromise = runtimeComputerChatgptAction(controllerHome, {
    kind: 'ensure',
    identity: { namespace: 'chatgpt.bootstrap', bootstrapKey, projectUrl },
  }, 3_000);
  let claim: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    claim = await jsonlRpc(runtime.socketPath, 'computer_extension_claim', { provider_instance_id: provider });
    if ((claim.result as { command?: unknown })?.command) break;
    await Bun.sleep(10);
  }
  let command = (claim!.result as { command: Record<string, unknown> }).command;
  expect(command).toMatchObject({ kind: 'ensure', identity: { namespace: 'chatgpt.bootstrap', bootstrapKey, projectUrl } });
  await jsonlRpc(runtime.socketPath, 'computer_extension_complete', {
    provider_instance_id: provider, command_id: command.commandId,
    result: { kind: 'ensured', providerBinding: binding, observation: { url: projectUrl, title: 'Forge', latestUserText: '', latestAssistantResponse: '', composerText: '', providerActivityText: '', providerFailureText: '', isGenerating: false } },
  });
  expect(await ensurePromise).toMatchObject({ state: 'ready', identity: { namespace: 'chatgpt.bootstrap', bootstrapKey, projectUrl } });

  const marker = '[forge-supervisor project=forge-source-wsl run=test]';
  const findPromise = runtimeComputerChatgptAction(controllerHome, { kind: 'find_marker', marker, bootstrapKey }, 3_000);
  claim = undefined;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    claim = await jsonlRpc(runtime.socketPath, 'computer_extension_claim', { provider_instance_id: provider });
    if ((claim.result as { command?: unknown })?.command) break;
    await Bun.sleep(10);
  }
  command = (claim!.result as { command: Record<string, unknown> }).command;
  expect(command).toMatchObject({ kind: 'find_marker', marker, bootstrapKey });
  const canonicalUrl = 'https://chatgpt.com/g/g-p-forge-test/c/successor-123';
  await jsonlRpc(runtime.socketPath, 'computer_extension_complete', {
    provider_instance_id: provider, command_id: command.commandId,
    result: { kind: 'marker_matches', matches: [{
      identity: { namespace: 'chatgpt.conversation', conversationId: 'successor-123', canonicalUrl }, providerBinding: binding,
      observation: { url: canonicalUrl, title: 'Forge successor', latestUserText: marker, latestAssistantResponse: '', composerText: '', providerActivityText: '', providerFailureText: '', isGenerating: true },
    }] },
  });
  expect(await findPromise).toMatchObject({ matches: [{ state: 'ready', identity: { namespace: 'chatgpt.conversation', conversationId: 'successor-123', canonicalUrl } }] });
});

test('standalone native host forwards framed RPC only to Computer socket', async () => {
  const controllerHome = home();
  const computerDir = join(controllerHome, 'computer');
  mkdirSync(computerDir, { recursive: true });
  const socketPath = join(computerDir, 'chatgpt-extension.sock');
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      socket.end(JSON.stringify({ id: request.id, ok: true, result: { recorded: true, owner: 'computer' } }) + '\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  const child = spawn(process.execPath, ['adapters/computer/chatgpt-native-host.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, FORGE_CONTROLLER_HOME: controllerHome },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const request = Buffer.from(JSON.stringify({
    id: 'native-heartbeat-test',
    method: 'computer_extension_heartbeat',
    params: { providerId: 'browser.chrome-extension' },
  }));
  const frame = Buffer.allocUnsafe(4 + request.length);
  frame.writeUInt32LE(request.length, 0);
  request.copy(frame, 4);
  child.stdin.write(frame);

  const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
    let output = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error('native host timeout')), 3_000);
    child.stdout.on('data', (chunk) => {
      output = Buffer.concat([output, chunk]);
      if (output.length < 4) return;
      const length = output.readUInt32LE(0);
      if (output.length < 4 + length) return;
      clearTimeout(timer);
      resolve(JSON.parse(output.subarray(4, 4 + length).toString('utf8')));
    });
    child.once('error', reject);
  });
  expect(response).toMatchObject({
    id: 'native-heartbeat-test',
    ok: true,
    result: { recorded: true, owner: 'computer' },
  });

  child.kill('SIGTERM');
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
