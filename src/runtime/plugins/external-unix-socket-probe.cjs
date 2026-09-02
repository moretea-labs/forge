'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');

function fail(message) {
  process.stderr.write(String(message).slice(0, 4000));
  process.exitCode = 1;
}

function bounded(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch (error) {
    fail(error instanceof Error ? error.message : error);
    return;
  }
  if (!input || typeof input.socketPath !== 'string' || !path.isAbsolute(input.socketPath)) {
    fail('EXTERNAL_PLUGIN_SOCKET_PATH_INVALID');
    return;
  }
  if (typeof input.requestId !== 'string' || typeof input.method !== 'string') {
    fail('EXTERNAL_PLUGIN_PROBE_REQUEST_INVALID');
    return;
  }
  if (!/^[a-z][a-z0-9_]{0,127}$/.test(input.method)) {
    fail('EXTERNAL_PLUGIN_METHOD_INVALID');
    return;
  }
  const timeoutMs = bounded(input.timeoutMs, 2000, 100, 10000);
  const maxRequestBytes = bounded(input.maxRequestBytes, 1048576, 1024, 4194304);
  const maxResponseBytes = bounded(input.maxResponseBytes, 1048576, 1024, 4194304);
  const envelope = JSON.stringify({ id: input.requestId, method: input.method, params: input.params || {} }) + '\n';
  if (Buffer.byteLength(envelope) > maxRequestBytes) {
    fail('EXTERNAL_PLUGIN_REQUEST_TOO_LARGE');
    return;
  }

  const socket = net.createConnection({ path: input.socketPath });
  let settled = false;
  let buffer = Buffer.alloc(0);
  const timer = setTimeout(() => finishError(`EXTERNAL_PLUGIN_TIMEOUT: ${timeoutMs}ms`), timeoutMs);
  function cleanup() {
    clearTimeout(timer);
    if (!socket.destroyed) socket.destroy();
  }
  function finishError(message) {
    if (settled) return;
    settled = true;
    cleanup();
    fail(message);
  }
  function finishSuccess(line) {
    if (settled) return;
    settled = true;
    cleanup();
    process.stdout.write(line);
  }
  socket.once('connect', () => socket.write(envelope));
  socket.on('data', (chunk) => {
    if (settled) return;
    if (buffer.length + chunk.length > maxResponseBytes) {
      finishError('EXTERNAL_PLUGIN_RESPONSE_TOO_LARGE');
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    const newline = buffer.indexOf(0x0A);
    if (newline >= 0) finishSuccess(buffer.subarray(0, newline).toString('utf8'));
  });
  socket.once('error', (error) => finishError(`EXTERNAL_PLUGIN_SOCKET_UNAVAILABLE: ${error.message}`));
  socket.once('end', () => {
    if (!settled) finishError('EXTERNAL_PLUGIN_PROTOCOL_ERROR: socket closed before response');
  });
}

main();
