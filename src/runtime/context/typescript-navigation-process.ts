import { existsSync, lstatSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { runProcess } from '../../effects/process-runner';
import { resolveBunExecutable } from '../shared/process-environment';
import type {
  SemanticNavigationAccess,
  SemanticNavigationOutcome,
  SemanticNavigationRequest,
} from './semantic-navigation-contract';

const TYPESCRIPT_NAVIGATION_SIDECAR_ENTRYPOINT = 'forge-typescript-navigation' as const;
const TYPESCRIPT_NAVIGATION_TIMEOUT_MS = 60_000;
const TYPESCRIPT_NAVIGATION_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

interface SidecarResponse {
  schemaVersion: 1;
  outcomes: SemanticNavigationOutcome[];
}

interface SourceSymbolsSidecarResponse {
  schemaVersion: 1;
  symbols: Array<{ startLine: number; endLine: number; kind: string; name?: string; enclosing?: string }>;
}

interface SidecarManifestRecord {
  typescriptNavigationEntrypoint?: unknown;
  typescriptNavigationArtifactIdentity?: unknown;
}

function releaseManifestArgument(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--release-manifest');
  const value = index >= 0 ? argv[index + 1]?.trim() : undefined;
  return value ? resolve(value) : undefined;
}

export function resolveTypeScriptNavigationSidecarCommand(
  argv: readonly string[] = process.argv,
): { executable: string; args: string[]; cwd?: string } {
  const manifestPath = releaseManifestArgument(argv);
  if (manifestPath) {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as SidecarManifestRecord;
    if (parsed.typescriptNavigationEntrypoint !== TYPESCRIPT_NAVIGATION_SIDECAR_ENTRYPOINT) {
      throw new Error('TYPESCRIPT_NAVIGATION_SIDECAR_MANIFEST_MISSING');
    }
    const identity = typeof parsed.typescriptNavigationArtifactIdentity === 'string'
      ? parsed.typescriptNavigationArtifactIdentity.trim()
      : '';
    if (!/^sha256:[a-f0-9]{64}$/i.test(identity)) {
      throw new Error('TYPESCRIPT_NAVIGATION_SIDECAR_IDENTITY_INVALID');
    }
    const executable = join(dirname(manifestPath), TYPESCRIPT_NAVIGATION_SIDECAR_ENTRYPOINT);
    if (!existsSync(executable)) throw new Error('TYPESCRIPT_NAVIGATION_SIDECAR_MISSING');
    const status = lstatSync(executable);
    if (status.isSymbolicLink() || !status.isFile() || (status.mode & 0o111) === 0) {
      throw new Error('TYPESCRIPT_NAVIGATION_SIDECAR_NOT_EXECUTABLE');
    }
    return { executable, args: [], cwd: dirname(manifestPath) };
  }

  // Construct the development-only path at runtime. A literal new URL() to the
  // .ts sidecar makes Bun bundle that file as an asset and drags the TypeScript
  // compiler graph back into the long-lived Runtime.
  const entry = resolve(process.cwd(), 'adapters', 'mcp', 'runtime-gateway', 'typescript-navigation-sidecar.ts');
  if (!existsSync(entry)) throw new Error('TYPESCRIPT_NAVIGATION_SOURCE_SIDECAR_MISSING');
  return {
    executable: resolveBunExecutable(process.execPath, process.env),
    args: [entry],
    cwd: dirname(entry),
  };
}

function failedOutcomes(requests: readonly SemanticNavigationRequest[], code: string, message: string): SemanticNavigationOutcome[] {
  return requests.map(() => ({ ok: false as const, code, message }));
}

export function extractTypeScriptSourceSymbolsInSidecar(
  path: string,
  source: string,
): SourceSymbolsSidecarResponse['symbols'] {
  const command = resolveTypeScriptNavigationSidecarCommand();
  const executed = runProcess(command.executable, command.args, {
    cwd: command.cwd ?? process.cwd(),
    input: JSON.stringify({ schemaVersion: 1, operation: 'source_symbols', path, source }),
    timeoutMs: TYPESCRIPT_NAVIGATION_TIMEOUT_MS,
    maxOutputBytes: TYPESCRIPT_NAVIGATION_MAX_OUTPUT_BYTES,
  });
  if (!executed.ok) {
    throw new Error(`TYPESCRIPT_SOURCE_SYMBOL_SIDECAR_FAILED: ${(executed.stderr || executed.stdout || executed.error || 'unknown failure').trim().slice(0, 2_000)}`);
  }
  const response = JSON.parse(executed.stdout) as SourceSymbolsSidecarResponse;
  if (response.schemaVersion !== 1 || !Array.isArray(response.symbols)) {
    throw new Error('TYPESCRIPT_SOURCE_SYMBOL_SIDECAR_RESPONSE_INVALID');
  }
  return response.symbols;
}

export function navigateTypeScriptInSidecar(
  repoRoot: string,
  requests: SemanticNavigationRequest[],
  access: SemanticNavigationAccess,
): SemanticNavigationOutcome[] {
  if (!access.readPolicy) {
    return failedOutcomes(requests, 'SEMANTIC_READ_POLICY_REQUIRED', 'TypeScript semantic navigation requires a serializable repository read policy.');
  }

  let command: ReturnType<typeof resolveTypeScriptNavigationSidecarCommand>;
  try {
    command = resolveTypeScriptNavigationSidecarCommand();
  } catch (error) {
    return failedOutcomes(requests, 'TYPESCRIPT_NAVIGATION_SIDECAR_UNAVAILABLE', error instanceof Error ? error.message : String(error));
  }

  const envelope = {
    schemaVersion: 1,
    operation: 'navigation',
    repoRoot: resolve(repoRoot),
    requests,
    access: {
      cacheScope: access.cacheScope,
      ...(access.sourceIdentity ? { sourceIdentity: access.sourceIdentity } : {}),
      profile: access.profile,
      readPolicy: access.readPolicy,
    },
  };
  const executed = runProcess(command.executable, command.args, {
    cwd: command.cwd ?? repoRoot,
    input: JSON.stringify(envelope),
    timeoutMs: TYPESCRIPT_NAVIGATION_TIMEOUT_MS,
    maxOutputBytes: TYPESCRIPT_NAVIGATION_MAX_OUTPUT_BYTES,
  });
  if (!executed.ok) {
    const detail = (executed.stderr || executed.stdout || executed.error || 'TypeScript navigation sidecar failed').trim();
    return failedOutcomes(requests, 'TYPESCRIPT_NAVIGATION_SIDECAR_FAILED', detail.slice(0, 2_000));
  }

  try {
    const response = JSON.parse(executed.stdout) as SidecarResponse;
    if (response.schemaVersion !== 1 || !Array.isArray(response.outcomes) || response.outcomes.length !== requests.length) {
      throw new Error('invalid sidecar response shape');
    }
    return response.outcomes;
  } catch (error) {
    return failedOutcomes(requests, 'TYPESCRIPT_NAVIGATION_SIDECAR_RESPONSE_INVALID', error instanceof Error ? error.message : String(error));
  }
}
