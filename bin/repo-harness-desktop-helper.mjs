#!/usr/bin/env node
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { createInterface } from 'readline';

const SCHEMA_VERSION = 1;
const PLUGIN_ID = 'desktop';
const HELPER_VERSION = '1.0.0';
const MAX_LINE_BYTES = 1_048_576;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const OSASCRIPT = '/usr/bin/osascript';
const OPEN = '/usr/bin/open';
const CAPABILITIES = ['status', 'observe', 'open_application'];

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function bounded(value, max = 2_000) {
  const source = String(value ?? '').replace(/(token|secret|password|authorization)\s*[=:]\s*\S+/gi, '$1=[REDACTED]');
  return source.length > max ? source.slice(-max) : source;
}

function failure(requestId, code, message, retryable = false, details) {
  write({
    schemaVersion: SCHEMA_VERSION,
    type: 'result',
    requestId,
    ok: false,
    error: { code, message, retryable, ...(details ? { details } : {}) },
  });
}

function success(requestId, result) {
  write({ schemaVersion: SCHEMA_VERSION, type: 'result', requestId, ok: true, result });
}

function run(command, args, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    execFile(command, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      windowsHide: true,
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
      },
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: typeof error?.code === 'number' ? error.code : null,
        stdout: String(stdout ?? ''),
        stderr: bounded(stderr || error?.message || ''),
      });
    });
  });
}

function permissionDiagnostics() {
  return {
    accessibility: {
      state: 'not_probed',
      reason: 'The bundled helper does not trigger macOS consent prompts during status or observation.',
    },
    screenRecording: {
      state: 'not_required',
      reason: 'This version does not capture screenshots or screen pixels.',
    },
  };
}

async function status() {
  return {
    platform: process.platform,
    helperVersion: HELPER_VERSION,
    protocolVersion: SCHEMA_VERSION,
    managed: true,
    transport: 'stdio-jsonl',
    capabilities: CAPABILITIES,
    commands: {
      openAvailable: existsSync(OPEN),
      frontmostApplicationProbeAvailable: existsSync(OSASCRIPT),
    },
    permissions: permissionDiagnostics(),
  };
}

async function observe() {
  if (process.platform !== 'darwin') {
    throw Object.assign(new Error('Desktop observation currently supports macOS only.'), { code: 'PLUGIN_DESKTOP_PLATFORM_UNSUPPORTED' });
  }
  if (!existsSync(OSASCRIPT)) {
    return {
      observed: false,
      frontmostApplication: null,
      permissions: permissionDiagnostics(),
      warnings: ['The macOS NSWorkspace inspection bridge is unavailable.'],
    };
  }
  const script = "ObjC.import('AppKit'); const app=$.NSWorkspace.sharedWorkspace.frontmostApplication; JSON.stringify({name:ObjC.unwrap(app.localizedName),bundleId:ObjC.unwrap(app.bundleIdentifier),pid:Number(app.processIdentifier)})";
  const inspected = await run(OSASCRIPT, ['-l', 'JavaScript', '-e', script], 5_000);
  if (!inspected.ok || !inspected.stdout.trim()) {
    return {
      observed: false,
      frontmostApplication: null,
      permissions: permissionDiagnostics(),
      warnings: [bounded(inspected.stderr || 'Unable to resolve the frontmost application.')],
    };
  }
  try {
    const app = JSON.parse(inspected.stdout.trim());
    return {
      observed: true,
      frontmostApplication: {
        name: typeof app.name === 'string' ? app.name : null,
        bundleId: typeof app.bundleId === 'string' ? app.bundleId : null,
        pid: Number.isInteger(app.pid) && app.pid > 0 ? app.pid : null,
      },
      permissions: permissionDiagnostics(),
      warnings: [],
    };
  } catch {
    return {
      observed: false,
      frontmostApplication: null,
      permissions: permissionDiagnostics(),
      warnings: ['The macOS NSWorkspace bridge returned malformed application metadata.'],
    };
  }
}

async function openApplication(input) {
  if (process.platform !== 'darwin') {
    throw Object.assign(new Error('Application opening currently supports macOS only.'), { code: 'PLUGIN_DESKTOP_PLATFORM_UNSUPPORTED' });
  }
  const appName = typeof input.app_name === 'string' ? input.app_name.trim() : '';
  const bundleId = typeof input.bundle_id === 'string' ? input.bundle_id.trim() : '';
  if ((!appName && !bundleId) || (appName && bundleId)) {
    throw Object.assign(new Error('Provide exactly one of app_name or bundle_id.'), { code: 'PLUGIN_ACTION_ARGUMENT_INVALID' });
  }
  const args = bundleId ? ['-b', bundleId] : ['-a', appName];
  const opened = await run(OPEN, args, 20_000);
  if (!opened.ok) {
    throw Object.assign(new Error(opened.stderr || 'macOS open command failed.'), {
      code: 'PLUGIN_DESKTOP_OPEN_FAILED',
      retryable: true,
    });
  }
  return { opened: true, selector: bundleId ? { bundleId } : { appName } };
}

async function execute(message) {
  if (!message || typeof message !== 'object' || message.schemaVersion !== SCHEMA_VERSION || message.type !== 'execute') {
    throw Object.assign(new Error('Invalid managed Desktop request envelope.'), { code: 'PLUGIN_MANAGED_PROCESS_PROTOCOL_ERROR' });
  }
  if (typeof message.requestId !== 'string' || typeof message.actionId !== 'string' || !message.input || typeof message.input !== 'object' || Array.isArray(message.input)) {
    throw Object.assign(new Error('Invalid managed Desktop request fields.'), { code: 'PLUGIN_MANAGED_PROCESS_PROTOCOL_ERROR' });
  }
  if (message.actionId === 'status') return await status();
  if (message.actionId === 'observe') return await observe();
  if (message.actionId === 'open_application') return await openApplication(message.input);
  throw Object.assign(new Error(`desktop/${message.actionId} is not supported.`), { code: 'PLUGIN_ACTION_NOT_SUPPORTED' });
}

write({
  schemaVersion: SCHEMA_VERSION,
  type: 'handshake',
  protocolVersion: SCHEMA_VERSION,
  pluginId: PLUGIN_ID,
  helperVersion: HELPER_VERSION,
  capabilities: CAPABILITIES,
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let handled = false;
lines.on('line', async (line) => {
  if (handled) return;
  handled = true;
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    failure('unknown', 'PLUGIN_MANAGED_PROCESS_REQUEST_TOO_LARGE', 'Managed Desktop request exceeded the bounded input limit.');
    lines.close();
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
    const result = await execute(message);
    success(message.requestId, result);
  } catch (error) {
    const requestId = typeof message?.requestId === 'string' ? message.requestId : 'unknown';
    failure(
      requestId,
      typeof error?.code === 'string' ? error.code : 'PLUGIN_DESKTOP_ACTION_FAILED',
      bounded(error?.message || error),
      error?.retryable === true,
    );
  } finally {
    lines.close();
  }
});
