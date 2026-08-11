import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AssistantPluginError } from '../../src/runtime/plugins/errors';
import { executeManagedPluginProcess, executeManagedPluginProcessSync } from '../../src/runtime/plugins/managed-process-adapter';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function helper(source: string): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-managed-plugin-'));
  roots.push(root);
  const path = join(root, 'helper.mjs');
  writeFileSync(path, source, 'utf8');
  return path;
}

function protocolHelper(handlerSource: string): string {
  return helper(`
import { createInterface } from 'readline';
const write = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
write({ schemaVersion: 1, type: 'handshake', protocolVersion: 1, pluginId: 'fixture', helperVersion: '1.0.0', capabilities: ['echo'] });
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.once('line', async (line) => {
  const request = JSON.parse(line);
  ${handlerSource}
});
`);
}

async function expectPluginError(promise: Promise<unknown>, code: string): Promise<AssistantPluginError> {
  try {
    await promise;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AssistantPluginError);
    expect((error as AssistantPluginError).code).toBe(code);
    return error as AssistantPluginError;
  }
}

describe('managed plugin process adapter', () => {
  test('supports synchronous manifest/health probing for external provider discovery', () => {
    const path = protocolHelper(`
      write({ schemaVersion: 1, type: 'result', requestId: request.requestId, ok: true, result: { state: 'ready', action: request.actionId } });
      lines.close();
    `);
    const result = executeManagedPluginProcessSync({
      pluginId: 'fixture',
      helperPath: path,
      requiredCapabilities: ['echo'],
      timeoutMs: 2_000,
    }, {
      requestId: 'managed-sync-health',
      actionId: 'health',
      input: {},
    });
    expect(result).toEqual({ state: 'ready', action: 'health' });
  });

  test('validates the handshake and routes one bounded request', async () => {
    const path = protocolHelper(`
      write({ schemaVersion: 1, type: 'result', requestId: request.requestId, ok: true, result: { echoed: request.input.value } });
      lines.close();
    `);
    const result = await executeManagedPluginProcess({
      pluginId: 'fixture',
      helperPath: path,
      requiredCapabilities: ['echo'],
      timeoutMs: 2_000,
    }, {
      requestId: 'managed-success',
      actionId: 'echo',
      input: { value: 'ok' },
    });
    expect(result).toEqual({ echoed: 'ok' });
  });

  test('rejects an incompatible handshake before sending the action', async () => {
    const path = helper(`process.stdout.write(JSON.stringify({ schemaVersion: 1, type: 'handshake', protocolVersion: 1, pluginId: 'wrong', helperVersion: '1', capabilities: [] }) + '\\n'); setTimeout(() => {}, 5_000);`);
    await expectPluginError(executeManagedPluginProcess({
      pluginId: 'fixture',
      helperPath: path,
      timeoutMs: 1_000,
    }, {
      requestId: 'managed-bad-handshake',
      actionId: 'echo',
      input: {},
    }), 'PLUGIN_MANAGED_PROCESS_HANDSHAKE_INVALID');
  });

  test('rejects malformed result envelopes', async () => {
    const path = protocolHelper(`
      process.stdout.write('{not-json}\\n');
      lines.close();
    `);
    await expectPluginError(executeManagedPluginProcess({
      pluginId: 'fixture',
      helperPath: path,
      requiredCapabilities: ['echo'],
      timeoutMs: 2_000,
    }, {
      requestId: 'managed-malformed',
      actionId: 'echo',
      input: {},
    }), 'PLUGIN_MANAGED_PROCESS_PROTOCOL_ERROR');
  });

  test('times out and terminates a helper that never responds', async () => {
    const path = protocolHelper(`setTimeout(() => {}, 5_000);`);
    await expectPluginError(executeManagedPluginProcess({
      pluginId: 'fixture',
      helperPath: path,
      requiredCapabilities: ['echo'],
      timeoutMs: 100,
    }, {
      requestId: 'managed-timeout',
      actionId: 'echo',
      input: {},
    }), 'PLUGIN_MANAGED_PROCESS_TIMEOUT');
  });

  test('reports a helper crash after a valid handshake', async () => {
    const path = protocolHelper(`process.exit(23);`);
    const error = await expectPluginError(executeManagedPluginProcess({
      pluginId: 'fixture',
      helperPath: path,
      requiredCapabilities: ['echo'],
      timeoutMs: 2_000,
    }, {
      requestId: 'managed-crash',
      actionId: 'echo',
      input: {},
    }), 'PLUGIN_MANAGED_PROCESS_EXITED');
    expect(error.details?.exitCode).toBe(23);
  });

  test('honors AbortSignal cancellation', async () => {
    const path = protocolHelper(`setTimeout(() => {}, 5_000);`);
    const controller = new AbortController();
    const execution = executeManagedPluginProcess({
      pluginId: 'fixture',
      helperPath: path,
      requiredCapabilities: ['echo'],
      timeoutMs: 5_000,
    }, {
      requestId: 'managed-abort',
      actionId: 'echo',
      input: {},
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expectPluginError(execution, 'PLUGIN_MANAGED_PROCESS_ABORTED');
  });

  test('rejects an oversized response', async () => {
    const path = protocolHelper(`
      write({ schemaVersion: 1, type: 'result', requestId: request.requestId, ok: true, result: { payload: 'x'.repeat(4096) } });
      lines.close();
    `);
    await expectPluginError(executeManagedPluginProcess({
      pluginId: 'fixture',
      helperPath: path,
      requiredCapabilities: ['echo'],
      timeoutMs: 2_000,
      maxResponseBytes: 512,
    }, {
      requestId: 'managed-large',
      actionId: 'echo',
      input: {},
    }), 'PLUGIN_MANAGED_PROCESS_RESPONSE_TOO_LARGE');
  });
});
