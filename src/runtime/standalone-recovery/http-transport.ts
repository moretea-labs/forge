import { spawn } from 'child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';

export interface RecoveryHttpRequest {
  url: string;
  method?: 'GET' | 'POST' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RecoveryHttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
}

export interface RecoveryHttpTransport {
  request(request: RecoveryHttpRequest): Promise<RecoveryHttpResponse>;
}

export interface RecoveryHttpTransportOptions {
  /** Test-only injection point. Production resolution never consults PATH. */
  resolveCurlExecutable?: () => Promise<string>;
  /** Test-only additions to the fixed minimal child environment. */
  childEnvironment?: () => NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  systemRoot?: string;
  maxHeaderBytes?: number;
  maxBodyBytes?: number;
  maxStderrBytes?: number;
  termGraceMs?: number;
}

const DEFAULT_MAX_HEADER_BYTES = 32 * 1024;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_TERM_GRACE_MS = 1_000;
const MAX_REDIRECTS = 3;

function error(code: string): Error { return new Error(code); }

function appendChunk(chunks: Buffer[], size: { value: number }, chunk: Buffer, maximum: number): boolean {
  size.value += chunk.length;
  if (size.value > maximum) return false;
  chunks.push(chunk);
  return true;
}

function configValue(value: string): string {
  if (/\0|\r|\n/.test(value)) throw error('RECOVERY_HTTP_INVALID_CONFIG_VALUE');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function safeHeaderValue(value: string): string {
  if (/\0|\r|\n/.test(value)) throw error('RECOVERY_HTTP_INVALID_HEADER_VALUE');
  return value;
}

async function writePrivateFile(path: string, value: string): Promise<void> {
  await writeFile(path, value, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}

async function isTrustedSystemCurl(candidate: string, platform: NodeJS.Platform, expectedRoot?: string): Promise<boolean> {
  try {
    const resolved = await realpath(candidate);
    const info = await stat(resolved);
    if (!info.isFile() || (info.mode & 0o022) !== 0) return false;
    if (platform === 'win32') {
      if (!expectedRoot) return false;
      const normalizedRoot = resolve(expectedRoot, 'System32').replace(/\\/g, '/').toLowerCase();
      const normalizedPath = resolved.replace(/\\/g, '/').toLowerCase();
      return normalizedPath === `${normalizedRoot}/curl.exe`;
    }
    return info.uid === 0 && resolved === candidate;
  } catch {
    return false;
  }
}

export async function resolveTrustedRecoveryCurl(
  platform: NodeJS.Platform = process.platform,
  systemRoot = process.env.SystemRoot ?? process.env.WINDIR,
): Promise<string> {
  if (platform === 'darwin' || platform === 'linux') {
    const candidate = '/usr/bin/curl';
    if (await isTrustedSystemCurl(candidate, platform)) return candidate;
    throw error('RECOVERY_CURL_UNAVAILABLE: trusted system curl was not found at /usr/bin/curl');
  }
  if (platform === 'win32') {
    if (!systemRoot) throw error('RECOVERY_CURL_UNAVAILABLE: Windows system root is unavailable');
    const candidate = join(systemRoot, 'System32', 'curl.exe');
    if (await isTrustedSystemCurl(candidate, platform, systemRoot)) return candidate;
    throw error('RECOVERY_CURL_UNAVAILABLE: trusted Windows System32 curl.exe was not found');
  }
  throw error(`RECOVERY_CURL_UNAVAILABLE: no trusted system curl policy for ${platform}`);
}

function parseCurlResponse(output: Buffer, maxHeaderBytes: number, maxBodyBytes: number): RecoveryHttpResponse {
  const text = output.toString('utf8');
  let offset = 0;
  let headerBytes = 0;
  let last: { status: number; headers: Record<string, string> } | undefined;
  while (true) {
    const remaining = text.slice(offset);
    const status = remaining.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:[^\r\n]*)\r?\n/i);
    if (!status) break;
    const separator = remaining.search(/\r?\n\r?\n/);
    if (separator < 0) throw error('RECOVERY_HTTP_INVALID_RESPONSE_HEADERS');
    const raw = remaining.slice(0, separator);
    const delimiterLength = remaining.startsWith('\r\n\r\n', separator) ? 4 : 2;
    headerBytes += Buffer.byteLength(raw) + delimiterLength;
    if (headerBytes > maxHeaderBytes) throw error('RECOVERY_HTTP_HEADER_TOO_LARGE');
    const headers: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/).slice(1)) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
    }
    last = { status: Number(status[1]), headers };
    offset += separator + delimiterLength;
  }
  if (!last || !Number.isInteger(last.status)) throw error('RECOVERY_HTTP_FINAL_RESPONSE_MISSING');
  const body = text.slice(offset);
  if (Buffer.byteLength(body) > maxBodyBytes) throw error('RECOVERY_HTTP_BODY_TOO_LARGE');
  return { status: last.status, ok: last.status >= 200 && last.status < 300, headers: last.headers, body };
}

function minimalCurlEnvironment(platform: NodeJS.Platform, systemRoot?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { LANG: 'C', LC_ALL: 'C' };
  if (platform === 'win32' && systemRoot) {
    environment.SystemRoot = systemRoot;
    environment.WINDIR = systemRoot;
  }
  return environment;
}

async function runCurl(
  executable: string,
  configPath: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  maxOutputBytes: number,
  maxStderrBytes: number,
  termGraceMs: number,
): Promise<Buffer> {
  return new Promise<Buffer>((resolveRun, rejectRun) => {
    let settled = false;
    let stopReason: string | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stdout: Buffer[] = [];
    const stdoutSize = { value: 0 };
    const stderrSize = { value: 0 };
    const child = spawn(executable, ['--disable', '--config', configPath], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: environment,
    });

    const finish = (failure?: Error, output?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      if (failure) rejectRun(failure);
      else resolveRun(output ?? Buffer.concat(stdout));
    };
    const signalChild = (signalName: NodeJS.Signals) => {
      if (!child.pid || child.exitCode != null) return;
      try { process.kill(child.pid, signalName); } catch { /* Process already exited. */ }
    };
    const stop = (reason: string) => {
      if (stopReason) return;
      stopReason = reason;
      signalChild('SIGTERM');
      killTimer = setTimeout(() => signalChild('SIGKILL'), termGraceMs);
    };
    const onAbort = () => stop(signal?.reason === 'RECOVERY_HTTP_TIMEOUT' ? 'RECOVERY_HTTP_TIMEOUT' : 'RECOVERY_HTTP_ABORTED');
    const timeout = setTimeout(() => stop('RECOVERY_HTTP_TIMEOUT'), timeoutMs);

    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (!appendChunk(stdout, stdoutSize, Buffer.from(chunk), maxOutputBytes)) stop('RECOVERY_HTTP_RESPONSE_TOO_LARGE');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrSize.value += Buffer.byteLength(chunk);
      if (stderrSize.value > maxStderrBytes) stop('RECOVERY_HTTP_STDERR_TOO_LARGE');
    });
    child.once('error', () => finish(error('RECOVERY_HTTP_CURL_SPAWN_FAILED')));
    child.once('close', (code) => {
      if (stopReason) { finish(error(stopReason)); return; }
      if (code !== 0) { finish(error('RECOVERY_HTTP_CURL_FAILED')); return; }
      finish(undefined, Buffer.concat(stdout));
    });
  });
}

export class ExternalHttpsRecoveryTransport implements RecoveryHttpTransport {
  private readonly maxHeaderBytes: number;
  private readonly maxBodyBytes: number;
  private readonly maxStderrBytes: number;
  private readonly termGraceMs: number;

  constructor(
    private readonly controllerHome: string,
    private readonly options: RecoveryHttpTransportOptions = {},
  ) {
    this.maxHeaderBytes = options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    this.termGraceMs = options.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
  }

  async request(request: RecoveryHttpRequest): Promise<RecoveryHttpResponse> {
    const initial = new URL(request.url);
    if (initial.protocol !== 'https:') throw error('RECOVERY_HTTP_HTTPS_REQUIRED');
    const platform = this.options.platform ?? process.platform;
    const systemRoot = this.options.systemRoot ?? process.env.SystemRoot ?? process.env.WINDIR;
    const executable = this.options.resolveCurlExecutable
      ? await this.options.resolveCurlExecutable()
      : await resolveTrustedRecoveryCurl(platform, systemRoot);
    const environment = {
      ...minimalCurlEnvironment(platform, systemRoot),
      ...(this.options.childEnvironment?.() ?? {}),
    };
    let url = initial;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const response = await this.requestOnce(executable, environment, { ...request, url: url.toString() });
      const location = response.headers.location;
      if (response.status < 300 || response.status >= 400 || !location) return response;
      if (redirects === MAX_REDIRECTS) throw error('RECOVERY_HTTP_REDIRECT_LIMIT');
      const next = new URL(location, url);
      if (next.protocol !== 'https:') throw error('RECOVERY_HTTP_REDIRECT_SCHEME_REFUSED');
      if (request.headers?.authorization && next.origin !== initial.origin) throw error('RECOVERY_HTTP_CROSS_ORIGIN_REDIRECT_REFUSED');
      url = next;
    }
    throw error('RECOVERY_HTTP_REDIRECT_LIMIT');
  }

  private async requestOnce(executable: string, environment: NodeJS.ProcessEnv, request: RecoveryHttpRequest): Promise<RecoveryHttpResponse> {
    const root = join(resolve(this.controllerHome), 'recovery', 'tmp');
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const directory = await mkdtemp(join(root, 'curl-'));
    await chmod(directory, 0o700);
    try {
      const nonce = randomBytes(18).toString('hex');
      const configPath = join(directory, `${nonce}.conf`);
      const bodyPath = join(directory, `${nonce}.body`);
      const timeoutMs = Math.max(1, Math.min(request.timeoutMs ?? 8_000, 60_000));
      const lines = [
        'silent',
        'show-error',
        'proto = "=https"',
        `url = ${configValue(request.url)}`,
        `request = ${configValue(request.method ?? 'GET')}`,
        `connect-timeout = ${(Math.min(timeoutMs, 4_000) / 1_000).toFixed(3)}`,
        `max-time = ${(timeoutMs / 1_000).toFixed(3)}`,
        `max-filesize = ${this.maxBodyBytes}`,
        'dump-header = "-"',
        'output = "-"',
      ];
      for (const [name, value] of Object.entries(request.headers ?? {})) lines.push(`header = ${configValue(`${name}: ${safeHeaderValue(value)}`)}`);
      if (request.body !== undefined) {
        await writePrivateFile(bodyPath, request.body);
        lines.push(`data-binary = ${configValue(`@${bodyPath}`)}`);
      }
      await writePrivateFile(configPath, `${lines.join('\n')}\n`);
      const output = await runCurl(
        executable,
        configPath,
        environment,
        timeoutMs,
        request.signal,
        this.maxHeaderBytes + this.maxBodyBytes,
        this.maxStderrBytes,
        this.termGraceMs,
      );
      return parseCurlResponse(output, this.maxHeaderBytes, this.maxBodyBytes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

class LocalFetchRecoveryTransport implements RecoveryHttpTransport {
  async request(request: RecoveryHttpRequest): Promise<RecoveryHttpResponse> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => { headers[name] = value; });
    return { status: response.status, ok: response.ok, headers, body: await response.text() };
  }
}

export function createRecoveryHttpTransport(controllerHome: string, options?: RecoveryHttpTransportOptions): RecoveryHttpTransport {
  const external = new ExternalHttpsRecoveryTransport(controllerHome, options);
  const local = new LocalFetchRecoveryTransport();
  return {
    request: async (request) => new URL(request.url).protocol === 'https:' ? external.request(request) : local.request(request),
  };
}
