import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { ChromeExtensionChatgptConversationTargetPort } from '../../adapters/computer/chatgpt-target-provider';
import { runtimeComputerInteractionTargetAuthority } from '../../src/runtime/root/computer-target-composition';
import {
  callRuntimeComputerChatgptTargetAction,
  closeRuntimeComputerChatgptExtensionForTest,
  ensureRuntimeComputerChatgptExtension,
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

test('heartbeat accepts bounded Windows-to-WSL clock skew without extending the provider lease', async () => {
  const controllerHome = home();
  let now = Date.parse('2026-11-19T00:00:00.000Z');
  const port = new ChromeExtensionChatgptConversationTargetPort(
    controllerHome,
    runtimeComputerInteractionTargetAuthority(),
    () => now,
  );

  expect(port.heartbeat({
    providerId: 'browser.chrome-extension',
    providerInstanceId: 'centbrowser-clock-skew',
    observedAt: new Date(now + 500).toISOString(),
    conversations: [],
  })).toBe(true);

  now += 75_001;
  expect(await port.inventory()).toMatchObject({
    complete: false,
    unavailableProviders: ['browser.chrome-extension'],
  });

  expect(port.heartbeat({
    providerId: 'browser.chrome-extension',
    providerInstanceId: 'centbrowser-clock-skew-excessive',
    observedAt: new Date(now + 5_001).toISOString(),
    conversations: [],
  })).toBe(false);
});

test('provider lease spans MV3 alarm cadence but still expires boundedly', async () => {
  const controllerHome = home();
  let now = Date.parse('2026-11-19T00:00:00.000Z');
  const port = new ChromeExtensionChatgptConversationTargetPort(
    controllerHome,
    runtimeComputerInteractionTargetAuthority(),
    () => now,
  );
  expect(port.heartbeat({
    providerId: 'browser.chrome-extension',
    providerInstanceId: 'centbrowser-mv3',
    observedAt: new Date(now).toISOString(),
    conversations: [],
  })).toBe(true);

  now += 60_001;
  expect(await port.inventory()).toMatchObject({ complete: true, unavailableProviders: [] });

  now += 15_000;
  expect(await port.inventory()).toMatchObject({
    complete: false,
    unavailableProviders: ['browser.chrome-extension'],
  });
});

test('queued command waits for an MV3 alarm while claimed execution stays tightly bounded', async () => {
  const controllerHome = home();
  const delays: number[] = [];
  const timerApi = {
    setTimeout: ((_callback: (...args: unknown[]) => void, ms?: number) => {
      delays.push(Number(ms));
      return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: ((_timer?: ReturnType<typeof setTimeout>) => undefined) as typeof clearTimeout,
  };
  const now = Date.parse('2026-11-19T00:00:00.000Z');
  const port = new ChromeExtensionChatgptConversationTargetPort(
    controllerHome,
    runtimeComputerInteractionTargetAuthority(),
    () => now,
    timerApi,
  );
  const canonicalUrl = 'https://chatgpt.com/c/mv3-queue-123';
  const binding = {
    providerId: 'browser.chrome-extension',
    observedAt: new Date(now).toISOString(),
    providerSessionId: 'centbrowser-mv3',
    browserProduct: 'chrome',
    windowId: '17',
    tabId: '27',
    ownerToken: ['owner', 'mv3', 'queue'].join('-'),
  };
  expect(port.heartbeat({
    providerId: 'browser.chrome-extension',
    providerInstanceId: 'centbrowser-mv3',
    observedAt: new Date(now).toISOString(),
    conversations: [{
      conversationId: 'mv3-queue-123',
      canonicalUrl,
      isCurrent: true,
      providerBinding: binding,
    }],
  })).toBe(true);

  const exactPromise = port.ensureExact({
    namespace: 'chatgpt.conversation',
    conversationId: 'mv3-queue-123',
    canonicalUrl,
  }, { createIfMissing: false });

  for (let attempt = 0; attempt < 20 && delays.length === 0; attempt += 1) await Bun.sleep(1);
  expect(delays[0]).toBe(45_000);

  const command = port.claim('centbrowser-mv3');
  expect(command).toMatchObject({ kind: 'observe' });
  expect(delays.at(-1)).toBe(12_000);

  expect(port.complete('centbrowser-mv3', command!.commandId, {
    kind: 'observation',
    providerBinding: binding,
    observation: {
      url: canonicalUrl,
      title: 'MV3 queue',
      latestUserText: '',
      latestAssistantResponse: '',
      composerText: '',
      providerActivityText: '',
      providerFailureText: '',
      isGenerating: false,
    },
  })).toBe(true);
  expect((await exactPromise).state).toBe('ready');
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


test('control client delegates observe to the existing canonical Computer socket owner', async () => {
  const controllerHome = home();
  const runtime = await ensureRuntimeComputerChatgptExtension(controllerHome);
  const canonicalUrl = 'https://chatgpt.com/c/control-client-123';
  const binding = {
    providerId: 'browser.chrome-extension',
    observedAt: new Date().toISOString(),
    providerSessionId: 'centbrowser-control',
    browserProduct: 'chrome',
    windowId: '11',
    tabId: '22',
    ownerToken: ['owner', 'control', 'client'].join('-'),
  };
  const heartbeat = await jsonlRpc(runtime.socketPath, 'computer_extension_heartbeat', {
    providerId: 'browser.chrome-extension',
    providerInstanceId: 'centbrowser-control',
    observedAt: new Date().toISOString(),
    conversations: [{
      conversationId: 'control-client-123',
      canonicalUrl,
      title: 'Control client test',
      isCurrent: true,
      providerBinding: binding,
    }],
  });
  expect(heartbeat).toMatchObject({ ok: true, result: { recorded: true } });

  const controlPromise = callRuntimeComputerChatgptTargetAction(controllerHome, 'observe', {
    identity: {
      namespace: 'chatgpt.conversation',
      conversationId: 'control-client-123',
      canonicalUrl,
    },
  }, 3_000);

  let claim: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    claim = await jsonlRpc(runtime.socketPath, 'computer_extension_claim', {
      provider_instance_id: 'centbrowser-control',
    });
    if ((claim.result as { command?: unknown } | undefined)?.command) break;
    await Bun.sleep(10);
  }
  const command = (claim!.result as { command: Record<string, unknown> }).command;
  expect(command).toMatchObject({
    kind: 'observe',
    identity: { namespace: 'chatgpt.conversation', conversationId: 'control-client-123', canonicalUrl },
  });

  const observation = {
    url: canonicalUrl,
    title: 'Control client test',
    latestUserText: '',
    latestAssistantResponse: 'ready',
    composerText: '',
    providerActivityText: '',
    providerFailureText: '',
    isGenerating: false,
  };
  const completion = await jsonlRpc(runtime.socketPath, 'computer_extension_complete', {
    provider_instance_id: 'centbrowser-control',
    command_id: command.commandId,
    result: { kind: 'observation', providerBinding: binding, observation },
  });
  expect(completion).toMatchObject({ ok: true, result: { recorded: true } });

  const control = await controlPromise;
  expect(control).toMatchObject({
    state: 'ready',
    identity: {
      namespace: 'chatgpt.conversation',
      conversationId: 'control-client-123',
      canonicalUrl,
    },
    observation,
  });

  // A second owner was never created; the original canonical socket is still
  // serving provider and control RPCs through the same Runtime-owned port.
  const inventory = await jsonlRpc(runtime.socketPath, 'computer_target_inventory', {});
  expect(inventory).toMatchObject({
    ok: true,
    result: {
      complete: true,
      conversations: [expect.objectContaining({
        conversationId: 'control-client-123',
        canonicalUrl,
      })],
    },
  });
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
