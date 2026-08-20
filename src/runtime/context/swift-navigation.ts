import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, relative, resolve, sep } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

export type SwiftNavigationKind = 'definition' | 'references' | 'implementations';

export interface SwiftNavigationRequest {
  navigation: SwiftNavigationKind;
  path: string;
  line: number;
  column: number;
}

export interface SwiftNavigationLocation {
  path: string;
  line: number;
  column: number;
}

export interface SwiftNavigationResult {
  navigation: SwiftNavigationKind;
  target: { path: string; line: number; column: number };
  locations: SwiftNavigationLocation[];
  workspace: {
    root: string;
    kind: 'swiftpm' | 'build_server' | 'compilation_database';
  };
  timingsMs: {
    initialize: number;
    navigation: number;
  };
}

export type SwiftNavigationOutcome =
  | { ok: true; result: SwiftNavigationResult }
  | { ok: false; code: string; message: string };

export interface SwiftNavigationAccess {
  allowRepositoryPath(relativePath: string): boolean;
}

type SwiftWorkspace = {
  root: string;
  relativeRoot: string;
  kind: SwiftNavigationResult['workspace']['kind'];
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 2_500;
const MAX_STDERR_CHARS = 8_000;

function normalizedRelative(root: string, absolute: string): string | undefined {
  const value = relative(root, absolute).split(sep).join('/');
  if (!value || value === '.' || value === '..' || value.startsWith('../')) return undefined;
  return value;
}

function directoryHasXcodeProject(directory: string): boolean {
  try {
    return readdirSync(directory, { withFileTypes: true }).some((entry) => entry.isDirectory() && (entry.name.endsWith('.xcodeproj') || entry.name.endsWith('.xcworkspace')));
  } catch {
    return false;
  }
}

export function resolveSwiftSemanticWorkspace(repoRoot: string, requestPath: string): SwiftWorkspace {
  const root = resolve(repoRoot);
  const target = resolve(root, requestPath);
  const targetRelative = normalizedRelative(root, target);
  if (!targetRelative || !targetRelative.endsWith('.swift')) {
    throw new Error('SWIFT_SEMANTIC_TARGET_INVALID: Swift semantic navigation requires a repository-relative .swift file.');
  }
  if (!existsSync(target)) {
    throw new Error(`SWIFT_SEMANTIC_TARGET_MISSING: ${targetRelative}`);
  }

  let current = dirname(target);
  let sawXcodeProject = false;
  while (current === root || current.startsWith(`${root}${sep}`)) {
    const relativeRoot = normalizedRelative(root, current) ?? '.';
    if (existsSync(resolve(current, 'buildServer.json'))) return { root: current, relativeRoot, kind: 'build_server' };
    if (existsSync(resolve(current, 'Package.swift'))) return { root: current, relativeRoot, kind: 'swiftpm' };
    if (existsSync(resolve(current, 'compile_commands.json')) || existsSync(resolve(current, 'compile_flags.txt'))) {
      return { root: current, relativeRoot, kind: 'compilation_database' };
    }
    sawXcodeProject ||= directoryHasXcodeProject(current);
    if (current === root) break;
    current = dirname(current);
  }

  if (sawXcodeProject) {
    throw new Error('SWIFT_SEMANTIC_BUILD_SETTINGS_UNAVAILABLE: Xcode project detected but no buildServer.json is available. SourceKit-LSP must not be started without Xcode build settings; use an existing BSP/xcode-build-server configuration or structural fallback.');
  }
  throw new Error('SWIFT_SEMANTIC_BUILD_SETTINGS_UNAVAILABLE: no Package.swift, buildServer.json, or compilation database was found for this Swift file.');
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^([A-Z][A-Z0-9_]+):/.exec(message);
  return match?.[1] ?? 'SWIFT_SEMANTIC_NAVIGATION_FAILED';
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

class SourceKitLspClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stdout = Buffer.alloc(0);
  private stderr = '';
  private processError: Error | undefined;

  constructor(
    private readonly repoRoot: string,
    private readonly workspaceRoot: string,
  ) {
    this.child = process.platform === 'darwin'
      ? spawn('xcrun', ['sourcekit-lsp'], { cwd: workspaceRoot, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn('sourcekit-lsp', [], { cwd: workspaceRoot, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-MAX_STDERR_CHARS);
    });
    this.child.on('error', (error) => {
      this.processError = error;
      this.rejectAll(new Error(`SWIFT_SEMANTIC_SOURCEKIT_UNAVAILABLE: ${error.message}`));
    });
    this.child.on('exit', (code, signal) => {
      if (this.pending.size === 0) return;
      const detail = this.stderr.trim() || `exit=${String(code)} signal=${String(signal)}`;
      this.rejectAll(new Error(`SWIFT_SEMANTIC_SOURCEKIT_EXITED: ${detail}`));
    });
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
        this.rejectAll(new Error('SWIFT_SEMANTIC_PROTOCOL_ERROR: SourceKit-LSP response omitted Content-Length.'));
        return;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.stdout.length < bodyStart + length) return;
      const raw = this.stdout.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.stdout = this.stdout.subarray(bodyStart + length);
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(raw) as typeof message;
      } catch {
        this.rejectAll(new Error('SWIFT_SEMANTIC_PROTOCOL_ERROR: SourceKit-LSP returned invalid JSON.'));
        return;
      }
      if (typeof message.id !== 'number') continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`SWIFT_SEMANTIC_SOURCEKIT_REQUEST_FAILED: ${message.error.message ?? 'unknown SourceKit-LSP error'}`));
      else pending.resolve(message.result);
    }
  }

  private write(message: Record<string, unknown>): void {
    if (this.processError) throw this.processError;
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  request(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`SWIFT_SEMANTIC_TIMEOUT: ${method} exceeded ${timeoutMs}ms.`));
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

  async initialize(): Promise<number> {
    const startedAt = performance.now();
    const uri = pathToFileURL(this.workspaceRoot).href;
    await this.request('initialize', {
      processId: process.pid,
      rootUri: uri,
      workspaceFolders: [{ uri, name: this.workspaceRoot.split(sep).pop() || 'workspace' }],
      capabilities: { workspace: { workspaceFolders: true } },
      clientInfo: { name: 'Forge', version: '1' },
    });
    this.notify('initialized', {});
    return roundMs(performance.now() - startedAt);
  }

  open(relativePath: string): void {
    const absolute = resolve(this.workspaceRoot, relativePath);
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri: pathToFileURL(absolute).href,
        languageId: 'swift',
        version: 1,
        text: readFileSync(absolute, 'utf8'),
      },
    });
  }

  async navigate(request: SwiftNavigationRequest, workspaceRelativePath: string): Promise<{ locations: SwiftNavigationLocation[]; navigationMs: number }> {
    const uri = pathToFileURL(resolve(this.workspaceRoot, workspaceRelativePath)).href;
    const params = {
      textDocument: { uri },
      position: { line: request.line - 1, character: request.column - 1 },
    };
    const startedAt = performance.now();
    const raw = request.navigation === 'references'
      ? await this.request('textDocument/references', { ...params, context: { includeDeclaration: true } })
      : request.navigation === 'implementations'
        ? await this.request('textDocument/implementation', params)
        : await this.request('textDocument/definition', params);
    const navigationMs = roundMs(performance.now() - startedAt);
    const values = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    const locations: SwiftNavigationLocation[] = [];
    for (const value of values) {
      if (!value || typeof value !== 'object') continue;
      const item = value as Record<string, unknown>;
      const locationUri = typeof item.uri === 'string' ? item.uri : typeof item.targetUri === 'string' ? item.targetUri : undefined;
      const range = (item.range ?? item.targetSelectionRange ?? item.targetRange) as Record<string, unknown> | undefined;
      const start = range?.start as Record<string, unknown> | undefined;
      if (!locationUri?.startsWith('file:') || typeof start?.line !== 'number' || typeof start?.character !== 'number') continue;
      let absolute: string;
      try { absolute = fileURLToPath(locationUri); } catch { continue; }
      const repoRelative = normalizedRelative(this.repoRoot, absolute);
      if (!repoRelative) continue;
      locations.push({ path: repoRelative, line: start.line + 1, column: start.character + 1 });
    }
    return { locations, navigationMs };
  }

  async close(): Promise<void> {
    try { await this.request('shutdown', null, 500); } catch { /* bounded best effort */ }
    try { this.notify('exit', null); } catch { /* process may already be gone */ }
    this.child.kill();
  }
}

function dedupeLocations(locations: SwiftNavigationLocation[]): SwiftNavigationLocation[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${location.path}:${location.line}:${location.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function navigateSwiftSymbols(
  repoRoot: string,
  requests: SwiftNavigationRequest[],
  access?: SwiftNavigationAccess,
): Promise<SwiftNavigationOutcome[]> {
  const root = resolve(repoRoot);
  const outcomes: Array<SwiftNavigationOutcome | undefined> = new Array(requests.length);
  const groups = new Map<string, Array<{ index: number; request: SwiftNavigationRequest; workspace: SwiftWorkspace; workspaceRelativePath: string }>>();

  requests.forEach((request, index) => {
    try {
      if (!Number.isInteger(request.line) || request.line < 1 || !Number.isInteger(request.column) || request.column < 1) {
        throw new Error('SWIFT_SEMANTIC_TARGET_INVALID: line and column must be positive 1-based integers.');
      }
      const workspace = resolveSwiftSemanticWorkspace(root, request.path);
      const repoRelative = request.path.split(sep).join('/');
      if (access && !access.allowRepositoryPath(repoRelative)) {
        throw new Error(`SWIFT_SEMANTIC_POLICY_DENIED: ${repoRelative}`);
      }
      const absolute = resolve(root, request.path);
      const workspaceRelativePath = relative(workspace.root, absolute).split(sep).join('/');
      const group = groups.get(workspace.root) ?? [];
      group.push({ index, request, workspace, workspaceRelativePath });
      groups.set(workspace.root, group);
    } catch (error) {
      outcomes[index] = { ok: false, code: errorCode(error), message: error instanceof Error ? error.message : String(error) };
    }
  });

  for (const group of groups.values()) {
    const client = new SourceKitLspClient(root, group[0]!.workspace.root);
    let initializeMs = 0;
    try {
      initializeMs = await client.initialize();
      for (const path of new Set(group.map((entry) => entry.workspaceRelativePath))) client.open(path);
      for (const entry of group) {
        try {
          const navigated = await client.navigate(entry.request, entry.workspaceRelativePath);
          const locations = dedupeLocations(navigated.locations)
            .filter((location) => !access || access.allowRepositoryPath(location.path));
          if (locations.length === 0) {
            outcomes[entry.index] = {
              ok: false,
              code: 'SWIFT_SEMANTIC_EMPTY_RESULT',
              message: `SourceKit-LSP returned no repository locations for ${entry.request.navigation} at ${entry.request.path}:${entry.request.line}:${entry.request.column}; treat static closure as incomplete and use structural/lexical evidence or refresh build/index data.`,
            };
            continue;
          }
          outcomes[entry.index] = {
            ok: true,
            result: {
              navigation: entry.request.navigation,
              target: { path: entry.request.path, line: entry.request.line, column: entry.request.column },
              locations,
              workspace: {
                root: entry.workspace.relativeRoot,
                kind: entry.workspace.kind,
              },
              timingsMs: { initialize: initializeMs, navigation: navigated.navigationMs },
            },
          };
        } catch (error) {
          outcomes[entry.index] = { ok: false, code: errorCode(error), message: error instanceof Error ? error.message : String(error) };
        }
      }
    } catch (error) {
      for (const entry of group) {
        outcomes[entry.index] = { ok: false, code: errorCode(error), message: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      await client.close();
    }
  }

  return outcomes.map((outcome) => outcome ?? ({ ok: false, code: 'SWIFT_SEMANTIC_NAVIGATION_FAILED', message: 'Swift semantic navigation produced no outcome.' }));
}
