#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';

const MAX_NATIVE_BYTES = 1024 * 1024;
const HEARTBEAT_TIMEOUT_MS = 4_000;
const RPC_TIMEOUT_MS = 30_000;
const ALLOWED_METHODS = new Set([
  'health',
  'computer_extension_heartbeat',
  'computer_extension_claim',
  'computer_extension_complete',
]);

const controllerHome = process.env.FORGE_CONTROLLER_HOME?.trim()
  || join(homedir(), '.forge', 'controller');
const socketPath = join(controllerHome, 'computer', 'chatgpt-extension.sock');

function parseRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('COMPUTER_CHATGPT_NATIVE_REQUEST_INVALID');
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const method = typeof value.method === 'string' ? value.method.trim() : '';
  if (!id || !ALLOWED_METHODS.has(method)) throw new Error('COMPUTER_CHATGPT_NATIVE_METHOD_DENIED');
  const params = value.params && typeof value.params === 'object' && !Array.isArray(value.params) ? value.params : {};
  return { id, method, params };
}

function encodeNative(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length > MAX_NATIVE_BYTES) throw new Error('COMPUTER_CHATGPT_NATIVE_RESPONSE_TOO_LARGE');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function errorResponse(id, error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    id,
    ok: false,
    error: {
      code: message.includes(':') ? message.slice(0, message.indexOf(':')) : 'COMPUTER_CHATGPT_NATIVE_FORWARD_FAILED',
      message,
    },
  };
}

function forward(request) {
  const timeoutMs = request.method === 'computer_extension_heartbeat' ? HEARTBEAT_TIMEOUT_MS : RPC_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error(`COMPUTER_CHATGPT_NATIVE_TIMEOUT:${request.method}`)), timeoutMs);
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id: request.id, method: request.method, params: request.params })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_NATIVE_BYTES) {
        finish(new Error('COMPUTER_CHATGPT_NATIVE_RESPONSE_TOO_LARGE'));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      let envelope;
      try { envelope = JSON.parse(buffer.subarray(0, newline).toString('utf8')); }
      catch { finish(new Error('COMPUTER_CHATGPT_NATIVE_PROTOCOL_ERROR')); return; }
      if (!envelope || envelope.id !== request.id || typeof envelope.ok !== 'boolean') {
        finish(new Error('COMPUTER_CHATGPT_NATIVE_PROTOCOL_ERROR'));
        return;
      }
      if (envelope.ok === true) finish(undefined, envelope.result ?? {});
      else finish(new Error(envelope.error?.message || 'COMPUTER_CHATGPT_NATIVE_REMOTE_ERROR'));
    });
    socket.once('error', (error) => finish(new Error(`COMPUTER_CHATGPT_NATIVE_SOCKET_UNAVAILABLE:${error.message}`)));
    socket.once('end', () => {
      if (!settled) finish(new Error('COMPUTER_CHATGPT_NATIVE_PROTOCOL_ERROR:socket_closed'));
    });
  });
}

let input = Buffer.alloc(0);
let chain = Promise.resolve();

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);
  if (input.length > MAX_NATIVE_BYTES + 4) {
    process.stdout.write(encodeNative(errorResponse('invalid', new Error('COMPUTER_CHATGPT_NATIVE_REQUEST_TOO_LARGE'))));
    input = Buffer.alloc(0);
    return;
  }
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (length <= 0 || length > MAX_NATIVE_BYTES) {
      process.stdout.write(encodeNative(errorResponse('invalid', new Error('COMPUTER_CHATGPT_NATIVE_FRAME_INVALID'))));
      input = Buffer.alloc(0);
      return;
    }
    if (input.length < 4 + length) return;
    const payload = input.subarray(4, 4 + length);
    input = input.subarray(4 + length);
    chain = chain.then(async () => {
      let id = 'invalid';
      try {
        const request = parseRequest(JSON.parse(payload.toString('utf8')));
        id = request.id;
        process.stdout.write(encodeNative({ id, ok: true, result: await forward(request) }));
      } catch (error) {
        process.stdout.write(encodeNative(errorResponse(id, error)));
      }
    });
  }
});
process.stdin.resume();
