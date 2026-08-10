import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { createServer, type Socket } from 'net';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';

const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;
const MAX_CAPTURE_BYTES = 3 * 1_048_576;
const RECORD_SEPARATOR = String.fromCharCode(30);
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const OSASCRIPT = '/usr/bin/osascript';
const SCREENCAPTURE = '/usr/sbin/screencapture';

type Product = 'chrome' | 'vivaldi';
interface TabRef { windowId: string; tabId: string }
interface BrowserDefinition { appName: string }

const BROWSERS: Record<Product, BrowserDefinition> = {
  chrome: { appName: 'Google Chrome' },
  vivaldi: { appName: 'Vivaldi' },
};

function boundedTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(value), 100), MAX_TIMEOUT_MS);
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function browser(product: unknown): BrowserDefinition {
  if (product !== 'chrome' && product !== 'vivaldi') throw new Error('BROWSER_AUTOMATION_PRODUCT_INVALID');
  return BROWSERS[product];
}

function ref(value: unknown): TabRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BROWSER_AUTOMATION_TAB_REF_INVALID');
  const candidate = value as Record<string, unknown>;
  const windowId = typeof candidate.windowId === 'string' ? candidate.windowId.trim() : '';
  const tabId = typeof candidate.tabId === 'string' ? candidate.tabId.trim() : '';
  if (!windowId || !tabId || windowId.length > 128 || tabId.length > 128) throw new Error('BROWSER_AUTOMATION_TAB_REF_INVALID');
  return { windowId, tabId };
}

function optionalRef(value: unknown): TabRef | undefined {
  return value === undefined ? undefined : ref(value);
}

function boundedString(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) throw new Error(`BROWSER_AUTOMATION_${field}_INVALID`);
  return value;
}

function tell(appName: string, body: string): string {
  return `tell application ${quoted(appName)}\n${body}\nend tell`;
}

function targetPreamble(target: TabRef): string {
  return `set targetWindow to first window whose id is ${quoted(target.windowId)}\nset targetTab to first tab of targetWindow whose id is ${quoted(target.tabId)}`;
}

function metadataScript(appName: string, target?: TabRef): string {
  if (target) {
    return tell(appName, `
${targetPreamble(target)}
set windowBounds to bounds of targetWindow
set separator to ASCII character 30
set targetIsActive to ((id of active tab of targetWindow) is (id of targetTab))
return (frontmost as text) & separator & (URL of targetTab as text) & separator & (title of targetTab as text) & separator & ((item 1 of windowBounds) as text) & separator & ((item 2 of windowBounds) as text) & separator & ((item 3 of windowBounds) as text) & separator & ((item 4 of windowBounds) as text) & separator & "" & separator & "" & separator & (targetIsActive as text)
`);
  }
  return tell(appName, `
if (count of windows) is 0 then error "FORGE_NO_BROWSER_WINDOW"
set targetWindow to front window
set targetTab to active tab of targetWindow
set windowBounds to bounds of targetWindow
set separator to ASCII character 30
return (frontmost as text) & separator & (URL of targetTab as text) & separator & (title of targetTab as text) & separator & ((item 1 of windowBounds) as text) & separator & ((item 2 of windowBounds) as text) & separator & ((item 3 of windowBounds) as text) & separator & ((item 4 of windowBounds) as text)
`);
}

function createTabScript(appName: string): string {
  return `on run argv
set targetUrl to item 1 of argv
${tell(appName, `
if (count of windows) is 0 then error "FORGE_NO_BROWSER_WINDOW"
set targetWindow to front window
set originalActiveIndex to active tab index of targetWindow
set targetTab to make new tab at end of tabs of targetWindow with properties {URL:targetUrl}
set targetTabId to id of targetTab
set active tab index of targetWindow to originalActiveIndex
set separator to ASCII character 30
return ((id of targetWindow) as text) & separator & (targetTabId as text)
`)}
end run`;
}

function closeTabScript(appName: string, target: TabRef): string {
  return tell(appName, `
try
${targetPreamble(target)}
close targetTab
end try
`);
}

function navigateScript(appName: string, target?: TabRef): string {
  return `on run argv
set targetUrl to item 1 of argv
${tell(appName, target ? `
${targetPreamble(target)}
set URL of targetTab to targetUrl
return targetUrl
` : `
if (count of windows) is 0 then error "FORGE_NO_BROWSER_WINDOW"
set URL of active tab of front window to targetUrl
return targetUrl
`)}
end run`;
}

function reloadScript(appName: string, target?: TabRef): string {
  return tell(appName, target ? `
${targetPreamble(target)}
reload targetTab
` : `
if (count of windows) is 0 then error "FORGE_NO_BROWSER_WINDOW"
reload active tab of front window
`);
}

function executeJavaScriptScript(appName: string, target?: TabRef): string {
  return `on run argv
set javascriptSource to item 1 of argv
${tell(appName, target ? `
${targetPreamble(target)}
return execute targetTab javascript javascriptSource
` : `
if (count of windows) is 0 then error "FORGE_NO_BROWSER_WINDOW"
return execute active tab of front window javascript javascriptSource
`)}
end run`;
}

function activateScript(appName: string, target?: TabRef): string {
  if (!target) return tell(appName, 'activate');
  return tell(appName, `
${targetPreamble(target)}
set targetTabIndex to 1
repeat with candidateTab in tabs of targetWindow
  if ((id of candidateTab) as text) is ((id of targetTab) as text) then exit repeat
  set targetTabIndex to targetTabIndex + 1
end repeat
set active tab index of targetWindow to targetTabIndex
set index of targetWindow to 1
activate
`);
}

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
      },
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message).trim().slice(-2_000);
        reject(new Error(detail || error.message));
        return;
      }
      resolvePromise(String(stdout).trim());
    });
  });
}

async function runAppleScript(script: string, args: string[], timeoutMs: number): Promise<string> {
  return await run(OSASCRIPT, ['-e', script, '--', ...args], timeoutMs);
}

function region(value: unknown): { x: number; y: number; width: number; height: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BROWSER_AUTOMATION_REGION_INVALID');
  const candidate = value as Record<string, unknown>;
  const x = Number(candidate.x);
  const y = Number(candidate.y);
  const width = Number(candidate.width);
  const height = Number(candidate.height);
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1 || width > 20_000 || height > 20_000) {
    throw new Error('BROWSER_AUTOMATION_REGION_INVALID');
  }
  return { x: Math.trunc(x), y: Math.trunc(y), width: Math.trunc(width), height: Math.trunc(height) };
}

async function captureRegion(value: unknown, timeoutMs: number): Promise<string> {
  const target = region(value);
  const path = join(tmpdir(), `forge-browser-capture-${process.pid}-${randomUUID()}.png`);
  try {
    await run(SCREENCAPTURE, ['-x', '-R', `${target.x},${target.y},${target.width},${target.height}`, path], timeoutMs);
    const bytes = readFileSync(path);
    if (bytes.length > MAX_CAPTURE_BYTES) throw new Error('BROWSER_AUTOMATION_CAPTURE_TOO_LARGE');
    return bytes.toString('base64');
  } finally {
    rmSync(path, { force: true });
  }
}

async function execute(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (params.protocolVersion !== PROTOCOL_VERSION) throw new Error('BROWSER_AUTOMATION_PROTOCOL_VERSION_MISMATCH');
  const action = typeof params.action === 'string' ? params.action : '';
  const timeoutMs = boundedTimeout(params.timeoutMs);
  if (action === 'capture_region') return { base64: await captureRegion(params.region, timeoutMs) };

  const product = params.product;
  const selected = browser(product);
  const target = optionalRef(params.ref);
  if (action === 'metadata') return { value: await runAppleScript(metadataScript(selected.appName, target), [], timeoutMs) };
  if (action === 'create_tab') {
    const url = boundedString(params.url, 'URL', 65_536);
    return { value: await runAppleScript(createTabScript(selected.appName), [url], timeoutMs) };
  }
  if (action === 'close_tab') {
    if (!target) throw new Error('BROWSER_AUTOMATION_TAB_REF_REQUIRED');
    return { value: await runAppleScript(closeTabScript(selected.appName, target), [], timeoutMs) };
  }
  if (action === 'navigate') {
    const url = boundedString(params.url, 'URL', 65_536);
    return { value: await runAppleScript(navigateScript(selected.appName, target), [url], timeoutMs) };
  }
  if (action === 'reload') return { value: await runAppleScript(reloadScript(selected.appName, target), [], timeoutMs) };
  if (action === 'execute_javascript') {
    const source = boundedString(params.source, 'JAVASCRIPT', 768 * 1_024);
    return { value: await runAppleScript(executeJavaScriptScript(selected.appName, target), [source], timeoutMs) };
  }
  if (action === 'activate') return { value: await runAppleScript(activateScript(selected.appName, target), [], timeoutMs) };
  throw new Error('BROWSER_AUTOMATION_ACTION_UNSUPPORTED');
}

function write(socket: Socket, value: unknown): void {
  socket.end(`${JSON.stringify(value)}\n`);
}

function fail(socket: Socket, id: string, error: unknown): void {
  write(socket, {
    id,
    ok: false,
    error: {
      code: 'BROWSER_AUTOMATION_ACTION_FAILED',
      message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      retryable: true,
    },
  });
}

function parseAbsoluteArgument(argv: string[], name: string, errorCode: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || !isAbsolute(value)) throw new Error(errorCode);
  return resolve(value);
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('BROWSER_AUTOMATION_PLATFORM_UNSUPPORTED');
  const argv = process.argv.slice(2);
  parseAbsoluteArgument(argv, '--controller-home', 'BROWSER_AUTOMATION_CONTROLLER_HOME_REQUIRED');
  const socketPath = parseAbsoluteArgument(argv, '--socket-path', 'BROWSER_AUTOMATION_SOCKET_PATH_REQUIRED');
  const socketRoot = dirname(socketPath);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (!existsSync(socketRoot)) mkdirSync(socketRoot, { recursive: true, mode: 0o700 });
  const rootStat = lstatSync(socketRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (currentUid !== undefined && rootStat.uid !== currentUid)) {
    throw new Error('BROWSER_AUTOMATION_SOCKET_ROOT_UNSAFE');
  }
  chmodSync(socketRoot, 0o700);
  if (existsSync(socketPath)) {
    const stat = lstatSync(socketPath);
    if (!stat.isSocket() || (currentUid !== undefined && stat.uid !== currentUid)) throw new Error('BROWSER_AUTOMATION_SOCKET_PATH_OCCUPIED');
    rmSync(socketPath, { force: true });
  }

  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let handled = false;
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      if (buffer.length + chunk.length > MAX_REQUEST_BYTES) {
        handled = true;
        fail(socket, 'unknown', new Error('BROWSER_AUTOMATION_REQUEST_TOO_LARGE'));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0A);
      if (newline < 0) return;
      handled = true;
      let request: Record<string, unknown> | undefined;
      try {
        request = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as Record<string, unknown>;
      } catch (error) {
        fail(socket, 'unknown', error);
        return;
      }
      const id = typeof request.id === 'string' ? request.id : 'unknown';
      const method = typeof request.method === 'string' ? request.method : '';
      const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params)
        ? request.params as Record<string, unknown>
        : {};
      if (method === 'health') {
        write(socket, { id, ok: true, result: { ready: true, helperVersion: 1, protocolVersion: PROTOCOL_VERSION, transport: 'unix_socket_jsonl' } });
        return;
      }
      if (method !== 'execute') {
        fail(socket, id, new Error('BROWSER_AUTOMATION_METHOD_UNSUPPORTED'));
        return;
      }
      void execute(params)
        .then((result) => write(socket, { id, ok: true, result }))
        .catch((error) => fail(socket, id, error));
    });
  });

  const cleanup = (): void => {
    server.close();
    rmSync(socketPath, { force: true });
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o600);
      resolvePromise();
    });
  });
}

void main().catch((error) => {
  process.stderr.write(`${(error instanceof Error ? error.message : String(error)).slice(0, 2_000)}\n`);
  process.exitCode = 1;
});
