import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { readFileSync } from 'fs';
import { relative, resolve, sep } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

export type LspNavigationKind = 'definition' | 'references' | 'implementations';

export interface LspNavigationRequest {
  navigation: LspNavigationKind;
  path: string;
  line: number;
  column: number;
}

export interface LspNavigationLocation {
  path: string;
  line: number;
  column: number;
}

export interface LanguageServerClientErrorCodes {
  unavailable: string;
  exited: string;
  protocol: string;
  requestFailed: string;
  timeout: string;
}

export interface LanguageServerClientOptions {
  repoRoot: string;
  workspaceRoot: string;
  command: readonly string[];
  languageId: string;
  serverName: string;
  errorCodes: LanguageServerClientErrorCodes;
  initializationOptions?: unknown;
  clientCapabilities?: Record<string, unknown>;
  workspaceConfiguration?: unknown;
  maxStderrChars?: number;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

function normalizedRelative(root: string, absolute: string): string | undefined {
  const value = relative(root, absolute).split(sep).join('/');
  if (!value || value === '.' || value === '..' || value.startsWith('../')) return undefined;
  return value;
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Small stdio JSON-RPC/LSP client shared by semantic providers.
 *
 * It deliberately owns transport/lifecycle only. Workspace discovery, build
 * settings readiness, source identity and evidence freshness remain provider or
 * Context Plane responsibilities so a language server can never become source
 * authority merely because it returned a location.
 */
export class LanguageServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly openedDocuments = new Map<string, { version: number; text: string }>();
  private nextId = 1;
  private stdout = Buffer.alloc(0);
  private stderr = '';
  private processError: Error | undefined;
  private closed = false;

  constructor(private readonly options: LanguageServerClientOptions) {
    if (!options.command[0]) throw new Error(`${options.errorCodes.unavailable}: ${options.serverName} command is empty.`);
    this.child = spawn(options.command[0], [...options.command.slice(1)], {
      cwd: options.workspaceRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.unref();
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      (stream as typeof stream & { unref?: () => void }).unref?.();
    }
    this.child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-(options.maxStderrChars ?? 8_000));
    });
    this.child.on('error', (error) => {
      this.processError = error;
      this.rejectAll(new Error(`${options.errorCodes.unavailable}: ${error.message}`));
    });
    this.child.on('exit', (code, signal) => {
      if (this.closed && this.pending.size === 0) return;
      const detail = this.stderr.trim() || `exit=${String(code)} signal=${String(signal)}`;
      const error = new Error(`${options.errorCodes.exited}: ${detail}`);
      this.processError = error;
      if (this.pending.size > 0) this.rejectAll(error);
    });
  }

  pendingRequestCount(): number {
    return this.pending.size;
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private onStdout(chunk: Buffer): void {
    this.stdout = Buffer.concat([this.stdout, chunk]);
    while (true) {
      const headerEnd = this.stdout.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.stdout.subarray(0, headerEnd).toString('utf8');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.rejectAll(new Error(`${this.options.errorCodes.protocol}: ${this.options.serverName} response omitted Content-Length.`));
        return;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.stdout.length < bodyStart + length) return;
      const raw = this.stdout.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.stdout = this.stdout.subarray(bodyStart + length);
      let message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(raw) as typeof message;
      } catch {
        this.rejectAll(new Error(`${this.options.errorCodes.protocol}: ${this.options.serverName} returned invalid JSON.`));
        continue;
      }
      if (message.method) {
        if (message.id !== undefined) this.respondToServerRequest(message.id, message.method, message.params);
        continue;
      }
      if (typeof message.id !== 'number') continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${this.options.errorCodes.requestFailed}: ${message.error.message ?? `unknown ${this.options.serverName} error`}`));
      else pending.resolve(message.result);
    }
  }

  private respondToServerRequest(id: number | string, method: string, params: unknown): void {
    let result: unknown = null;
    if (method === 'workspace/workspaceFolders') {
      const uri = pathToFileURL(this.options.workspaceRoot).href;
      result = [{ uri, name: this.options.workspaceRoot.split(sep).pop() || 'workspace' }];
    } else if (method === 'workspace/configuration') {
      const items = params && typeof params === 'object' && Array.isArray((params as { items?: unknown[] }).items)
        ? (params as { items: unknown[] }).items
        : [];
      result = items.map(() => this.options.workspaceConfiguration ?? null);
    }
    try {
      this.write({ jsonrpc: '2.0', id, result });
    } catch {
      // The process may have exited while handling a best-effort server request.
    }
  }

  private write(message: Record<string, unknown>): void {
    if (this.processError) throw this.processError;
    if (this.closed) throw new Error(`${this.options.errorCodes.exited}: ${this.options.serverName} client is closed.`);
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try {
          this.notify('$/cancelRequest', { id });
        } catch {
          // The language server may already have exited; timeout remains authoritative.
        }
        reject(new Error(`${this.options.errorCodes.timeout}: ${method} exceeded ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  async initialize(timeoutMs: number): Promise<number> {
    const startedAt = performance.now();
    const uri = pathToFileURL(this.options.workspaceRoot).href;
    await this.request('initialize', {
      processId: process.pid,
      rootUri: uri,
      workspaceFolders: [{ uri, name: this.options.workspaceRoot.split(sep).pop() || 'workspace' }],
      capabilities: this.options.clientCapabilities ?? { workspace: { workspaceFolders: true, configuration: true } },
      clientInfo: { name: 'Forge', version: '1' },
      ...(this.options.initializationOptions === undefined ? {} : { initializationOptions: this.options.initializationOptions }),
    }, timeoutMs);
    this.notify('initialized', {});
    return roundMs(performance.now() - startedAt);
  }

  syncDocument(relativePath: string): void {
    const absolute = resolve(this.options.workspaceRoot, relativePath);
    const uri = pathToFileURL(absolute).href;
    const text = readFileSync(absolute, 'utf8');
    const existing = this.openedDocuments.get(relativePath);
    if (!existing) {
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: this.options.languageId, version: 1, text },
      });
      this.openedDocuments.set(relativePath, { version: 1, text });
      return;
    }
    if (existing.text === text) return;
    const version = existing.version + 1;
    this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
    this.openedDocuments.set(relativePath, { version, text });
  }

  async navigate(
    request: LspNavigationRequest,
    workspaceRelativePath: string,
    timeoutMs: number,
  ): Promise<{ locations: LspNavigationLocation[]; navigationMs: number }> {
    const uri = pathToFileURL(resolve(this.options.workspaceRoot, workspaceRelativePath)).href;
    const params = {
      textDocument: { uri },
      position: { line: request.line - 1, character: request.column - 1 },
    };
    const startedAt = performance.now();
    const raw = request.navigation === 'references'
      ? await this.request('textDocument/references', { ...params, context: { includeDeclaration: true } }, timeoutMs)
      : request.navigation === 'implementations'
        ? await this.request('textDocument/implementation', params, timeoutMs)
        : await this.request('textDocument/definition', params, timeoutMs);
    const navigationMs = roundMs(performance.now() - startedAt);
    const values = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    const locations: LspNavigationLocation[] = [];
    for (const value of values) {
      if (!value || typeof value !== 'object') continue;
      const item = value as Record<string, unknown>;
      const locationUri = typeof item.uri === 'string' ? item.uri : typeof item.targetUri === 'string' ? item.targetUri : undefined;
      const range = (item.range ?? item.targetSelectionRange ?? item.targetRange) as Record<string, unknown> | undefined;
      const start = range?.start as Record<string, unknown> | undefined;
      if (!locationUri?.startsWith('file:') || typeof start?.line !== 'number' || typeof start?.character !== 'number') continue;
      let absolute: string;
      try { absolute = fileURLToPath(locationUri); } catch { continue; }
      const repoRelative = normalizedRelative(this.options.repoRoot, absolute);
      if (!repoRelative) continue;
      locations.push({ path: repoRelative, line: start.line + 1, column: start.character + 1 });
    }
    return { locations, navigationMs };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try { await this.request('shutdown', null, 500); } catch { /* bounded best effort */ }
    try { this.notify('exit', null); } catch { /* process may already be gone */ }
    this.closed = true;
    this.child.kill();
    this.rejectAll(new Error(`${this.options.errorCodes.exited}: ${this.options.serverName} client closed.`));
  }
}
