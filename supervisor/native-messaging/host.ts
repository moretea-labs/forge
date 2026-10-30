#!/usr/bin/env bun
import { callExternalUnixJsonl } from '../../packages/plugin-runtime/external/unix-jsonl-transport';
import { workflowSupervisorSocketPath } from '../paths';
import { encodeNativeMessage, NativeMessageDecoder } from './protocol';

export const WORKFLOW_SUPERVISOR_NATIVE_HOST_NAME = 'com.moretea.forge.workflow_supervisor';
const NATIVE_HEARTBEAT_TIMEOUT_MS = 4_000;
const NATIVE_RPC_TIMEOUT_MS = 30_000;
export const ALLOWED_BROWSER_METHODS = new Set([
  'health','browser_discovery','browser_discovery_update','browser_project_scopes',
  'computer_extension_heartbeat','computer_extension_claim','computer_extension_complete',
]);

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
    const timeoutMs = req.method === 'computer_extension_heartbeat' ? NATIVE_HEARTBEAT_TIMEOUT_MS : NATIVE_RPC_TIMEOUT_MS;
    const result = await callExternalUnixJsonl({ socketPath: workflowSupervisorSocketPath(forgeHome), requestId: req.id, method: req.method, params: req.params, timeoutMs });
    return { id: req.id, ok: true, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id: req.id, ok: false, error: { code: message.includes(':') ? message.slice(0, message.indexOf(':')) : 'WORKFLOW_SUPERVISOR_NATIVE_FORWARD_FAILED', message } };
  }
}
export function runNativeMessagingHost(forgeHome?: string): void {
  const decoder = new NativeMessageDecoder();
  process.stdin.on('data', (chunk: Buffer) => {
    let messages: unknown[];
    try { messages = decoder.push(chunk); } catch (error) { process.stdout.write(encodeNativeMessage({ id: 'invalid', ok: false, error: { code: 'WORKFLOW_SUPERVISOR_NATIVE_FRAME_INVALID', message: String(error) } })); return; }
    // Chrome matches replies by request id, not FIFO position. Each request
    // uses an independent Supervisor socket call. Heartbeat forwarding has a
    // 4s deadline, below the Broker's 15s freshness TTL; command/discovery RPCs
    // retain their existing 30s budget. The Broker remains the sole Effect owner.
    for (const message of messages) {
      void forwardNativeRequest(message, forgeHome).then(
        (response) => { process.stdout.write(encodeNativeMessage(response)); },
        (error) => {
          // Bad individual requests must not poison subsequent heartbeats.
          const id = message && typeof message === 'object' && !Array.isArray(message)
            && typeof (message as { id?: unknown }).id === 'string'
            ? (message as { id: string }).id : 'invalid';
          const detail = error instanceof Error ? error.message : String(error);
          process.stdout.write(encodeNativeMessage({ id, ok: false, error: {
            code: detail.split(':', 1)[0] || 'WORKFLOW_SUPERVISOR_NATIVE_REQUEST_INVALID',
            message: detail,
          } }));
        },
      );
    }
  });
  process.stdin.resume();
}
if (import.meta.main) runNativeMessagingHost(process.env.FORGE_HOME);
