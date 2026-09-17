#!/usr/bin/env bun
import { callExternalUnixJsonl } from '../../packages/plugin-runtime/external/unix-jsonl-transport';
import { workflowSupervisorSocketPath } from '../paths';
import { encodeNativeMessage, NativeMessageDecoder } from './protocol';

export const WORKFLOW_SUPERVISOR_NATIVE_HOST_NAME = 'com.moretea.forge.workflow_supervisor';
export const ALLOWED_BROWSER_METHODS = new Set(['health','browser_discovery','browser_discovery_update','browser_tasks','browser_poll','browser_begin_effect','browser_observe_effect','browser_observe_assistant']);

interface BrowserNativeRequest { id: string; method: string; params: Record<string, unknown> }
function request(value: unknown): BrowserNativeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('WORKFLOW_SUPERVISOR_NATIVE_REQUEST_INVALID');
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id || typeof record.method !== 'string' || !ALLOWED_BROWSER_METHODS.has(record.method)) throw new Error('WORKFLOW_SUPERVISOR_NATIVE_METHOD_DENIED');
  return { id: record.id, method: record.method, params: record.params && typeof record.params === 'object' && !Array.isArray(record.params) ? record.params as Record<string, unknown> : {} };
}
export async function forwardNativeRequest(value: unknown, forgeHome?: string): Promise<Record<string, unknown>> {
  const req = request(value);
  try {
    const result = await callExternalUnixJsonl({ socketPath: workflowSupervisorSocketPath(forgeHome), requestId: req.id, method: req.method, params: req.params, timeoutMs: 30_000 });
    return { id: req.id, ok: true, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id: req.id, ok: false, error: { code: message.includes(':') ? message.slice(0, message.indexOf(':')) : 'WORKFLOW_SUPERVISOR_NATIVE_FORWARD_FAILED', message } };
  }
}
export function runNativeMessagingHost(forgeHome?: string): void {
  const decoder = new NativeMessageDecoder();
  let chain = Promise.resolve();
  process.stdin.on('data', (chunk: Buffer) => {
    let messages: unknown[];
    try { messages = decoder.push(chunk); } catch (error) { process.stdout.write(encodeNativeMessage({ id: 'invalid', ok: false, error: { code: 'WORKFLOW_SUPERVISOR_NATIVE_FRAME_INVALID', message: String(error) } })); return; }
    for (const message of messages) chain = chain.then(async () => { process.stdout.write(encodeNativeMessage(await forwardNativeRequest(message, forgeHome))); });
  });
  process.stdin.resume();
}
if (import.meta.main) runNativeMessagingHost(process.env.FORGE_HOME);
