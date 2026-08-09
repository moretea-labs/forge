import { spawnSync } from 'child_process';
import { accessSync, constants, existsSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const SCHEMA_VERSION = 1;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_STDERR_CHARS = 8_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const ALLOWED_OPERATIONS = new Set<CodeGraphReadOperation>(['status', 'search', 'context', 'impact', 'file_dependencies']);

export type CodeGraphReadOperation = 'status' | 'search' | 'context' | 'impact' | 'file_dependencies';
export type CodeGraphProviderStatus = 'ready' | 'stale' | 'unavailable' | 'degraded';

export interface CodeGraphNodeSummary {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  signature?: string;
}

export interface CodeGraphEdgeSummary {
  source: string;
  target: string;
  kind: string;
  line?: number;
  provenance?: string;
}

export interface CodeGraphIndexMetadata {
  initialized: boolean;
  lastIndexedAt: number | null;
  buildVersion: string | null;
  extractionVersion: number | null;
  staleEngine: boolean;
  changedFiles: {
    added: string[];
    modified: string[];
    removed: string[];
  };
  stats?: {
    nodeCount: number;
    edgeCount: number;
    fileCount: number;
    dbSizeBytes: number;
    lastUpdated: number;
  };
  backend?: string;
  journalMode?: string;
}

export interface CodeGraphReadRequest {
  operation: CodeGraphReadOperation;
  query?: string;
  nodeId?: string;
  filePath?: string;
  limit?: number;
  maxNodes?: number;
  maxDepth?: number;
}

export interface CodeGraphReadProviderResponse {
  schemaVersion: 1;
  provider: 'codegraph';
  operation: CodeGraphReadOperation;
  ok: boolean;
  status: CodeGraphProviderStatus;
  metadata?: CodeGraphIndexMetadata;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
  timingsMs: {
    total: number;
    process?: number;
    open?: number;
    query?: number;
  };
}

interface SidecarSuccess {
  schemaVersion: 1;
  ok: true;
  operation: CodeGraphReadOperation;
  metadata: CodeGraphIndexMetadata;
  result: Record<string, unknown>;
  timingsMs?: { open?: number; query?: number };
}

interface SidecarFailure {
  schemaVersion: 1;
  ok: false;
  operation?: CodeGraphReadOperation;
  error: { code: string; message: string };
  timingsMs?: { open?: number; query?: number };
}

type SidecarResponse = SidecarSuccess | SidecarFailure;

function isExecutable(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export function resolveCodeGraphBundledRuntime(options: { runtimeRoot?: string } = {}): {
  nodeExecutable: string;
  sidecarPath: string;
  libraryPath: string;
  platformPackage: string;
  source: 'release' | 'dependency';
} {
  const target = `${process.platform}-${process.arch}`;
  const platformPackage = `@colbymchenry/codegraph-${target}`;
  const runtimeRoot = options.runtimeRoot ?? dirname(process.execPath);
  const releaseNode = join(runtimeRoot, 'codegraph-node');
  const releaseSidecar = join(runtimeRoot, 'codegraph-sidecar.cjs');
  const releaseLibrary = join(runtimeRoot, 'codegraph-lib', 'dist', 'index.js');
  if (isExecutable(releaseNode) && existsSync(releaseSidecar) && existsSync(releaseLibrary)) {
    return {
      nodeExecutable: releaseNode,
      sidecarPath: releaseSidecar,
      libraryPath: releaseLibrary,
      platformPackage,
      source: 'release',
    };
  }
  let packageJson: string;
  try {
    packageJson = require.resolve(`${platformPackage}/package.json`);
  } catch {
    throw new Error(`CODEGRAPH_PLATFORM_BUNDLE_MISSING: ${platformPackage} is not installed`);
  }
  const nodeExecutable = join(dirname(packageJson), process.platform === 'win32' ? 'node.exe' : 'node');
  if (!isExecutable(nodeExecutable)) {
    throw new Error(`CODEGRAPH_BUNDLED_NODE_UNAVAILABLE: bundled Node runtime is missing for ${platformPackage}`);
  }
  const sidecarPath = fileURLToPath(new URL('./codegraph-sidecar.cjs', import.meta.url));
  if (!existsSync(sidecarPath)) {
    throw new Error('CODEGRAPH_SIDECAR_MISSING: packaged read-only sidecar could not be resolved');
  }
  const libraryPath = join(dirname(packageJson), 'lib', 'dist', 'index.js');
  if (!existsSync(libraryPath)) {
    throw new Error(`CODEGRAPH_LIBRARY_UNAVAILABLE: compiled library is missing for ${platformPackage}`);
  }
  return { nodeExecutable, sidecarPath, libraryPath, platformPackage, source: 'dependency' };
}

function minimalEnvironment(runtime: ReturnType<typeof resolveCodeGraphBundledRuntime>): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries({
    PATH: dirname(runtime.nodeExecutable),
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    CODEGRAPH_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
    CODEGRAPH_NO_DAEMON: '1',
    FORGE_CODEGRAPH_LIBRARY_PATH: runtime.libraryPath,
  }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function parseSidecarResponse(raw: string): SidecarResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('CODEGRAPH_PROTOCOL_ERROR: sidecar returned invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION) {
    throw new Error('CODEGRAPH_PROTOCOL_ERROR: sidecar returned an unsupported response');
  }
  return parsed as SidecarResponse;
}

function providerStatus(metadata: CodeGraphIndexMetadata): CodeGraphProviderStatus {
  if (!metadata.initialized) return 'unavailable';
  if (metadata.staleEngine) return 'stale';
  if (metadata.changedFiles.added.length > 0 || metadata.changedFiles.modified.length > 0 || metadata.changedFiles.removed.length > 0) return 'stale';
  return 'ready';
}

function errorResponse(operation: CodeGraphReadOperation, code: string, message: string, total: number): CodeGraphReadProviderResponse {
  const unavailable = code.includes('MISSING') || code.includes('UNAVAILABLE') || code.includes('NOT_INITIALIZED');
  return {
    schemaVersion: 1,
    provider: 'codegraph',
    operation,
    ok: false,
    status: unavailable ? 'unavailable' : 'degraded',
    error: { code, message: message.slice(0, 1_000) },
    timingsMs: { total },
  };
}

export function queryCodeGraphReadProvider(
  repoRoot: string,
  request: CodeGraphReadRequest,
  options: { timeoutMs?: number } = {},
): CodeGraphReadProviderResponse {
  const startedAt = performance.now();
  if (!ALLOWED_OPERATIONS.has(request.operation)) {
    return errorResponse(request.operation, 'CODEGRAPH_OPERATION_NOT_ALLOWED', `Unsupported read operation: ${String(request.operation)}`, performance.now() - startedAt);
  }

  let runtime: ReturnType<typeof resolveCodeGraphBundledRuntime>;
  try {
    runtime = resolveCodeGraphBundledRuntime();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const [code] = message.split(':', 1);
    return errorResponse(request.operation, code || 'CODEGRAPH_RUNTIME_UNAVAILABLE', message, performance.now() - startedAt);
  }

  const normalizedRequest = {
    schemaVersion: SCHEMA_VERSION,
    operation: request.operation,
    projectRoot: resolve(repoRoot),
    ...(typeof request.query === 'string' ? { query: request.query.slice(0, 2_000) } : {}),
    ...(typeof request.nodeId === 'string' ? { nodeId: request.nodeId.slice(0, 1_000) } : {}),
    ...(typeof request.filePath === 'string' ? { filePath: request.filePath.slice(0, 2_000) } : {}),
    limit: boundedInteger(request.limit, 12, 1, 40),
    maxNodes: boundedInteger(request.maxNodes, 40, 1, 80),
    maxDepth: boundedInteger(request.maxDepth, 2, 1, 5),
  };
  const input = JSON.stringify(normalizedRequest);
  if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) {
    return errorResponse(request.operation, 'CODEGRAPH_REQUEST_TOO_LARGE', 'CodeGraph request exceeded the bounded input limit.', performance.now() - startedAt);
  }

  const processStartedAt = performance.now();
  const execution = spawnSync(runtime.nodeExecutable, [runtime.sidecarPath], {
    cwd: resolve(repoRoot),
    input,
    encoding: 'utf8',
    env: minimalEnvironment(runtime),
    timeout: boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 60_000),
    maxBuffer: MAX_RESPONSE_BYTES,
    windowsHide: true,
    shell: false,
  });
  const processMs = performance.now() - processStartedAt;
  if (execution.error) {
    const code = (execution.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'CODEGRAPH_TIMEOUT' : 'CODEGRAPH_START_FAILED';
    return errorResponse(request.operation, code, execution.error.message, performance.now() - startedAt);
  }
  if (Buffer.byteLength(execution.stdout ?? '') > MAX_RESPONSE_BYTES) {
    return errorResponse(request.operation, 'CODEGRAPH_RESPONSE_TOO_LARGE', 'CodeGraph response exceeded the bounded output limit.', performance.now() - startedAt);
  }
  if (execution.status !== 0) {
    const stderr = String(execution.stderr ?? '').slice(-MAX_STDERR_CHARS);
    return errorResponse(request.operation, 'CODEGRAPH_SIDECAR_FAILED', stderr || `CodeGraph sidecar exited with status ${String(execution.status)}`, performance.now() - startedAt);
  }

  let parsed: SidecarResponse;
  try {
    parsed = parseSidecarResponse(String(execution.stdout ?? ''));
  } catch (error) {
    return errorResponse(request.operation, 'CODEGRAPH_PROTOCOL_ERROR', error instanceof Error ? error.message : String(error), performance.now() - startedAt);
  }
  if (!parsed.ok) {
    return errorResponse(request.operation, parsed.error.code, parsed.error.message, performance.now() - startedAt);
  }
  return {
    schemaVersion: 1,
    provider: 'codegraph',
    operation: request.operation,
    ok: parsed.metadata.initialized,
    status: providerStatus(parsed.metadata),
    metadata: parsed.metadata,
    result: parsed.result,
    timingsMs: {
      total: Math.round((performance.now() - startedAt) * 100) / 100,
      process: Math.round(processMs * 100) / 100,
      ...(typeof parsed.timingsMs?.open === 'number' ? { open: parsed.timingsMs.open } : {}),
      ...(typeof parsed.timingsMs?.query === 'number' ? { query: parsed.timingsMs.query } : {}),
    },
  };
}
