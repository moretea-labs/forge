import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, dirname, relative, resolve, sep } from 'path';
import { pathToFileURL } from 'url';
import { LanguageServerClient } from './lsp-client';

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
    buildSettingsFingerprint: string;
  };
  timingsMs: {
    initialize: number;
    navigation: number;
    sessionReused: boolean;
  };
}

export type SwiftNavigationOutcome =
  | { ok: true; result: SwiftNavigationResult }
  | { ok: false; code: string; message: string };

export interface SwiftNavigationAccess {
  allowRepositoryPath(relativePath: string): boolean;
}

type SwiftBuildServerDescriptor = {
  argv: string[];
  kind?: string;
  bspVersion?: string;
};

type SwiftWorkspace = {
  root: string;
  relativeRoot: string;
  kind: SwiftNavigationResult['workspace']['kind'];
  buildServer?: SwiftBuildServerDescriptor;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

const WARM_REQUEST_TIMEOUT_MS = 2_500;
const COLD_REQUEST_TIMEOUT_MS = 8_000;
const SWIFT_SEMANTIC_SESSION_TTL_MS = 120_000;
const SWIFT_BUILD_SETTINGS_PROBE_TTL_MS = 30_000;
const SWIFT_BUILD_SETTINGS_PROBE_TIMEOUT_MS = 1_500;

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

function readSwiftBuildServerDescriptor(directory: string): SwiftBuildServerDescriptor | undefined {
  try {
    const raw = JSON.parse(readFileSync(resolve(directory, 'buildServer.json'), 'utf8')) as Record<string, unknown>;
    const argv = Array.isArray(raw.argv) ? raw.argv.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : [];
    if (argv.length === 0) return undefined;
    return {
      argv,
      kind: typeof raw.kind === 'string' ? raw.kind : undefined,
      bspVersion: typeof raw.bspVersion === 'string' ? raw.bspVersion : undefined,
    };
  } catch {
    return undefined;
  }
}

const SWIFT_BUILD_IDENTITY_FILES = [
  'Package.swift',
  'Package.resolved',
  'buildServer.json',
  'compile_commands.json',
  'compile_flags.txt',
  '.compile',
] as const;

/** Identity for compiler/build settings only; source files are synchronized separately. */
export function swiftBuildSettingsFingerprint(workspaceRoot: string): string {
  const root = resolve(workspaceRoot);
  const hash = createHash('sha256').update('swift-build-settings-v1\0');
  for (const name of SWIFT_BUILD_IDENTITY_FILES) {
    const path = resolve(root, name);
    try {
      const stat = statSync(path);
      hash.update(`${name}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0`);
      if (stat.isFile() && stat.size <= 2 * 1024 * 1024) hash.update(readFileSync(path));
    } catch {
      hash.update(`${name}\0missing\0`);
    }
  }
  return hash.digest('hex').slice(0, 24);
}

export function classifySwiftCompilerArguments(value: unknown): 'usable' | 'fallback' {
  const args = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  const hasSemanticIdentity = args.includes('-module-name') || args.includes('-target');
  const hasSdk = args.includes('-sdk');
  return args.length >= 8 && hasSemanticIdentity && hasSdk ? 'usable' : 'fallback';
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
    if (existsSync(resolve(current, 'buildServer.json'))) {
      return { root: current, relativeRoot, kind: 'build_server', buildServer: readSwiftBuildServerDescriptor(current) };
    }
    if (existsSync(resolve(current, 'Package.swift'))) return { root: current, relativeRoot, kind: 'swiftpm' };
    if (existsSync(resolve(current, 'compile_commands.json')) || existsSync(resolve(current, 'compile_flags.txt'))) {
      return { root: current, relativeRoot, kind: 'compilation_database' };
    }
    sawXcodeProject ||= directoryHasXcodeProject(current);
    if (current === root) break;
    current = dirname(current);
  }

  if (sawXcodeProject) {
    throw new Error('SWIFT_SEMANTIC_BUILD_SETTINGS_UNAVAILABLE: Xcode project detected but no buildServer.json is available. Configure the project once with xcode-build-server (for example `xcode-build-server config -project <project>.xcodeproj` from the Xcode project root) and perform a normal Xcode/xcodebuild build to refresh compile flags/index data; until then use structural/lexical evidence. Forge never performs that build implicitly from rh_context.');
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

type SwiftBuildSettingsProbe =
  | { ok: true; source: 'manual_compile' | 'bsp_probe'; argumentCount: number }
  | { ok: false; code: string; message: string };

type JsonRpcProbeState = { buffer: Buffer };

const swiftBuildSettingsProbeCache = new Map<string, { expiresAt: number; probe: Promise<SwiftBuildSettingsProbe> }>();

function writeJsonRpcProbe(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
  const body = JSON.stringify(message);
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function readJsonRpcProbeResponse(
  child: ChildProcessWithoutNullStreams,
  state: JsonRpcProbeState,
  id: number,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolveResponse, reject) => {
    const timer = setTimeout(() => finish(new Error(`BSP probe response ${id} exceeded ${timeoutMs}ms.`)), timeoutMs);
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`BSP probe exited before response ${id}: code=${String(code)} signal=${String(signal)}`));
    const onData = (chunk: Buffer) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      while (true) {
        const headerEnd = state.buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const header = state.buffer.subarray(0, headerEnd).toString('utf8');
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) return finish(new Error('BSP probe response omitted Content-Length.'));
        const length = Number(match[1]);
        const bodyStart = headerEnd + 4;
        if (state.buffer.length < bodyStart + length) return;
        const raw = state.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
        state.buffer = state.buffer.subarray(bodyStart + length);
        let message: Record<string, unknown>;
        try { message = JSON.parse(raw) as Record<string, unknown>; } catch { return finish(new Error('BSP probe returned invalid JSON.')); }
        if (message.id === id) return finish(undefined, message);
      }
    };
    function finish(error?: Error, value?: Record<string, unknown>): void {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolveResponse(value ?? {});
    }
    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function manualCompileSettingsProbe(workspace: SwiftWorkspace): SwiftBuildSettingsProbe | undefined {
  if (workspace.buildServer?.kind !== 'manual') return undefined;
  try {
    const entries = JSON.parse(readFileSync(resolve(workspace.root, '.compile'), 'utf8')) as Array<Record<string, unknown>>;
    const command = entries.map((entry) => typeof entry.command === 'string' ? entry.command : '').find(Boolean) ?? '';
    const hasSemanticIdentity = /(?:^|\s)-(?:module-name|target)(?:\s|$)/.test(command);
    const hasSdk = /(?:^|\s)-sdk(?:\s|$)/.test(command);
    if (command.length > 100 && hasSemanticIdentity && hasSdk) {
      return { ok: true, source: 'manual_compile', argumentCount: command.split(/\s+/).length };
    }
    return {
      ok: false,
      code: 'SWIFT_SEMANTIC_BUILD_SETTINGS_FALLBACK',
      message: 'xcode-build-server manual mode exists but .compile does not contain complete Swift module/target/SDK settings. Refresh it from real xcodebuild output with `xcode-build-server parse -a` before requesting compiler semantic navigation.',
    };
  } catch {
    return {
      ok: false,
      code: 'SWIFT_SEMANTIC_BUILD_SETTINGS_FALLBACK',
      message: 'xcode-build-server manual mode exists but .compile is missing or unreadable. Refresh it from real xcodebuild output with `xcode-build-server parse -a` before requesting compiler semantic navigation.',
    };
  }
}

async function probeXcodeBuildServerSettings(
  workspace: SwiftWorkspace,
  workspaceRelativePath: string,
  buildSettingsFingerprint: string,
): Promise<SwiftBuildSettingsProbe> {
  const descriptor = workspace.buildServer;
  if (!descriptor?.argv[0] || basename(descriptor.argv[0]) !== 'xcode-build-server') {
    return { ok: true, source: 'bsp_probe', argumentCount: 0 };
  }
  const manual = manualCompileSettingsProbe(workspace);
  if (manual) return manual;

  const key = `${workspace.root}\0${workspaceRelativePath}\0${descriptor.argv.join('\0')}\0${descriptor.kind ?? ''}\0${buildSettingsFingerprint}`;
  const cached = swiftBuildSettingsProbeCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.probe;

  const probe = (async (): Promise<SwiftBuildSettingsProbe> => {
    const child = spawn(descriptor.argv[0]!, descriptor.argv.slice(1), {
      cwd: workspace.root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, XBS_LOGPATH: ':null' },
    });
    const state: JsonRpcProbeState = { buffer: Buffer.alloc(0) };
    try {
      const rootUri = pathToFileURL(workspace.root).href;
      writeJsonRpcProbe(child, {
        jsonrpc: '2.0', id: 1, method: 'build/initialize',
        params: {
          displayName: 'Forge', version: '1', bspVersion: descriptor.bspVersion ?? '2.2.0', rootUri,
          capabilities: { languageIds: ['swift'] },
        },
      });
      const initialized = await readJsonRpcProbeResponse(child, state, 1, SWIFT_BUILD_SETTINGS_PROBE_TIMEOUT_MS);
      if (initialized.error) throw new Error(`build/initialize failed: ${JSON.stringify(initialized.error)}`);
      writeJsonRpcProbe(child, { jsonrpc: '2.0', method: 'build/initialized', params: {} });
      writeJsonRpcProbe(child, { jsonrpc: '2.0', id: 2, method: 'workspace/waitForBuildSystemUpdates', params: {} });
      const synchronized = await readJsonRpcProbeResponse(child, state, 2, SWIFT_BUILD_SETTINGS_PROBE_TIMEOUT_MS);
      if (synchronized.error) throw new Error(`workspace/waitForBuildSystemUpdates failed: ${JSON.stringify(synchronized.error)}`);
      writeJsonRpcProbe(child, {
        jsonrpc: '2.0', id: 3, method: 'textDocument/sourceKitOptions',
        params: { textDocument: { uri: pathToFileURL(resolve(workspace.root, workspaceRelativePath)).href } },
      });
      const response = await readJsonRpcProbeResponse(child, state, 3, SWIFT_BUILD_SETTINGS_PROBE_TIMEOUT_MS);
      const result = response.result && typeof response.result === 'object' ? response.result as Record<string, unknown> : undefined;
      const compilerArguments = result?.compilerArguments;
      const args = Array.isArray(compilerArguments) ? compilerArguments.filter((entry): entry is string => typeof entry === 'string') : [];
      if (classifySwiftCompilerArguments(args) === 'fallback') {
        return {
          ok: false,
          code: 'SWIFT_SEMANTIC_BUILD_SETTINGS_FALLBACK',
          message: `xcode-build-server returned fallback Swift settings (${args.length} compiler arguments) rather than target compile settings. Do not trust SourceKit closure from this state. Capture real xcodebuild output and merge it with \`xcode-build-server parse -a\`; Forge will then retry semantic navigation without requiring a full clean build.`,
        };
      }
      return { ok: true, source: 'bsp_probe', argumentCount: args.length };
    } catch (error) {
      return {
        ok: false,
        code: 'SWIFT_SEMANTIC_BUILD_SETTINGS_PROBE_FAILED',
        message: `Unable to verify xcode-build-server compiler settings within the bounded probe budget: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      child.kill();
    }
  })();
  swiftBuildSettingsProbeCache.set(key, { expiresAt: now + SWIFT_BUILD_SETTINGS_PROBE_TTL_MS, probe });
  return probe;
}

class SourceKitLspClient extends LanguageServerClient {
  constructor(repoRoot: string, workspaceRoot: string) {
    super({
      repoRoot,
      workspaceRoot,
      command: process.platform === 'darwin' ? ['xcrun', 'sourcekit-lsp'] : ['sourcekit-lsp'],
      languageId: 'swift',
      serverName: 'SourceKit-LSP',
      errorCodes: {
        unavailable: 'SWIFT_SEMANTIC_SOURCEKIT_UNAVAILABLE',
        exited: 'SWIFT_SEMANTIC_SOURCEKIT_EXITED',
        protocol: 'SWIFT_SEMANTIC_PROTOCOL_ERROR',
        requestFailed: 'SWIFT_SEMANTIC_SOURCEKIT_REQUEST_FAILED',
        timeout: 'SWIFT_SEMANTIC_TIMEOUT',
      },
    });
  }

  initialize(): Promise<number> {
    return super.initialize(COLD_REQUEST_TIMEOUT_MS);
  }
}

type SwiftSemanticSession = {
  client: SourceKitLspClient;
  initializeMs: number;
  warmed: boolean;
  lastUsedAt: number;
  queue: Promise<void>;
  expiryTimer?: NodeJS.Timeout;
};

const swiftSemanticSessions = new Map<string, Promise<SwiftSemanticSession>>();

function swiftSemanticSessionKey(repoRoot: string, workspaceRoot: string, buildSettingsFingerprint: string): string {
  return `${repoRoot}\0${workspaceRoot}\0${buildSettingsFingerprint}`;
}

function scheduleSwiftSemanticSessionExpiry(key: string, promise: Promise<SwiftSemanticSession>, session: SwiftSemanticSession): void {
  if (session.expiryTimer) clearTimeout(session.expiryTimer);
  session.expiryTimer = setTimeout(() => {
    if (swiftSemanticSessions.get(key) !== promise) return;
    const idleMs = Date.now() - session.lastUsedAt;
    if (idleMs < SWIFT_SEMANTIC_SESSION_TTL_MS || session.client.pendingRequestCount() > 0) {
      scheduleSwiftSemanticSessionExpiry(key, promise, session);
      return;
    }
    swiftSemanticSessions.delete(key);
    void session.client.close();
  }, SWIFT_SEMANTIC_SESSION_TTL_MS);
  session.expiryTimer.unref?.();
}

async function acquireSwiftSemanticSession(
  repoRoot: string,
  workspaceRoot: string,
  buildSettingsFingerprint: string,
): Promise<{ session: SwiftSemanticSession; reused: boolean; key: string }> {
  const key = swiftSemanticSessionKey(repoRoot, workspaceRoot, buildSettingsFingerprint);
  const existing = swiftSemanticSessions.get(key);
  if (existing) {
    const session = await existing;
    session.lastUsedAt = Date.now();
    scheduleSwiftSemanticSessionExpiry(key, existing, session);
    return { session, reused: true, key };
  }
  const promise = (async () => {
    const client = new SourceKitLspClient(repoRoot, workspaceRoot);
    try {
      const initializeMs = await client.initialize();
      return {
        client,
        initializeMs,
        warmed: false,
        lastUsedAt: Date.now(),
        queue: Promise.resolve(),
      } satisfies SwiftSemanticSession;
    } catch (error) {
      await client.close();
      throw error;
    }
  })();
  swiftSemanticSessions.set(key, promise);
  try {
    const session = await promise;
    scheduleSwiftSemanticSessionExpiry(key, promise, session);
    return { session, reused: false, key };
  } catch (error) {
    if (swiftSemanticSessions.get(key) === promise) swiftSemanticSessions.delete(key);
    throw error;
  }
}

async function withSwiftSemanticSessionLock<T>(session: SwiftSemanticSession, action: () => Promise<T>): Promise<T> {
  const previous = session.queue;
  let release!: () => void;
  session.queue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
  await previous.catch(() => undefined);
  try {
    session.lastUsedAt = Date.now();
    return await action();
  } finally {
    session.lastUsedAt = Date.now();
    release();
  }
}

export async function disposeSwiftSemanticSessions(): Promise<void> {
  const sessions = Array.from(swiftSemanticSessions.values());
  swiftSemanticSessions.clear();
  await Promise.all(sessions.map(async (promise) => {
    try {
      const session = await promise;
      if (session.expiryTimer) clearTimeout(session.expiryTimer);
      await session.client.close();
    } catch {
      // Initialization failure already tears down the client.
    }
  }));
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
    try {
      const buildSettingsFingerprint = swiftBuildSettingsFingerprint(group[0]!.workspace.root);
      const verifiedGroup: typeof group = [];
      for (const entry of group) {
        const buildSettings = await probeXcodeBuildServerSettings(entry.workspace, entry.workspaceRelativePath, buildSettingsFingerprint);
        if (!buildSettings.ok) {
          outcomes[entry.index] = { ok: false, code: buildSettings.code, message: buildSettings.message };
          continue;
        }
        verifiedGroup.push(entry);
      }
      if (verifiedGroup.length === 0) continue;

      const acquired = await acquireSwiftSemanticSession(root, verifiedGroup[0]!.workspace.root, buildSettingsFingerprint);
      await withSwiftSemanticSessionLock(acquired.session, async () => {
        for (const path of new Set(verifiedGroup.map((entry) => entry.workspaceRelativePath))) {
          acquired.session.client.syncDocument(path);
        }
        for (let groupIndex = 0; groupIndex < verifiedGroup.length; groupIndex += 1) {
          const entry = verifiedGroup[groupIndex]!;
          const coldRequest = !acquired.session.warmed;
          const timeoutMs = coldRequest ? COLD_REQUEST_TIMEOUT_MS : WARM_REQUEST_TIMEOUT_MS;
          try {
            const navigated = await acquired.session.client.navigate(entry.request, entry.workspaceRelativePath, timeoutMs);
            acquired.session.warmed = true;
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
                  buildSettingsFingerprint,
                },
                timingsMs: {
                  initialize: acquired.session.initializeMs,
                  navigation: navigated.navigationMs,
                  sessionReused: acquired.reused,
                },
              },
            };
          } catch (error) {
            const code = errorCode(error);
            outcomes[entry.index] = { ok: false, code, message: error instanceof Error ? error.message : String(error) };
            if (coldRequest && code === 'SWIFT_SEMANTIC_TIMEOUT') {
              acquired.session.warmed = true;
              for (const remaining of verifiedGroup.slice(groupIndex + 1)) {
                outcomes[remaining.index] = {
                  ok: false,
                  code: 'SWIFT_SEMANTIC_COLD_START_PENDING',
                  message: 'The first SourceKit semantic request exceeded the cold-start budget. The lazy session is retained briefly; retry the targeted Swift semantic request instead of widening lexical discovery.',
                };
              }
              break;
            }
          }
        }
      });
    } catch (error) {
      for (const entry of group) {
        if (outcomes[entry.index]) continue;
        outcomes[entry.index] = { ok: false, code: errorCode(error), message: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  return outcomes.map((outcome) => outcome ?? ({ ok: false, code: 'SWIFT_SEMANTIC_NAVIGATION_FAILED', message: 'Swift semantic navigation produced no outcome.' }));
}
