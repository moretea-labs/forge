import { existsSync, lstatSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import type { McpPolicy } from '../../../adapters/mcp/types';
import type {
  ControllerContextPackOptions,
  ControllerContextPackProjection,
} from '../../cli/controller/context/types';
import { resolveBunExecutable } from '../shared/process-environment';
import { runBoundedChild } from '../shared/bounded-child-supervisor';

const CONTEXT_PACK_SIDECAR_ENTRYPOINT = 'forge-context-pack' as const;
const CONTEXT_PACK_TIMEOUT_MS = 60_000;
const CONTEXT_PACK_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

interface ContextPackSidecarManifestRecord {
  contextPackEntrypoint?: unknown;
  contextPackArtifactIdentity?: unknown;
}

interface ContextPackSidecarResponse {
  schemaVersion: 1;
  pack: ControllerContextPackProjection;
}

function releaseManifestArgument(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--release-manifest');
  const value = index >= 0 ? argv[index + 1]?.trim() : undefined;
  return value ? resolve(value) : undefined;
}

export function resolveContextPackSidecarCommand(
  argv: readonly string[] = process.argv,
): { executable: string; args: string[]; cwd?: string } {
  const manifestPath = releaseManifestArgument(argv);
  if (manifestPath) {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as ContextPackSidecarManifestRecord;
    if (parsed.contextPackEntrypoint !== CONTEXT_PACK_SIDECAR_ENTRYPOINT) {
      throw new Error('CONTEXT_PACK_SIDECAR_MANIFEST_MISSING');
    }
    const identity = typeof parsed.contextPackArtifactIdentity === 'string'
      ? parsed.contextPackArtifactIdentity.trim()
      : '';
    if (!/^sha256:[a-f0-9]{64}$/i.test(identity)) {
      throw new Error('CONTEXT_PACK_SIDECAR_IDENTITY_INVALID');
    }
    const executable = join(dirname(manifestPath), CONTEXT_PACK_SIDECAR_ENTRYPOINT);
    if (!existsSync(executable)) throw new Error('CONTEXT_PACK_SIDECAR_MISSING');
    const status = lstatSync(executable);
    if (status.isSymbolicLink() || !status.isFile() || (status.mode & 0o111) === 0) {
      throw new Error('CONTEXT_PACK_SIDECAR_NOT_EXECUTABLE');
    }
    return {
      executable,
      args: ['--release-manifest', manifestPath],
      cwd: dirname(manifestPath),
    };
  }

  // Deliberately construct this development path at runtime. A literal new URL()
  // to a .ts sidecar makes Bun include the sidecar's heavy Context Plane import
  // graph in the long-lived Runtime bundle.
  const entry = resolve(process.cwd(), 'adapters', 'mcp', 'runtime-gateway', 'context-pack-sidecar.ts');
  if (!existsSync(entry)) throw new Error('CONTEXT_PACK_SOURCE_SIDECAR_MISSING');
  return {
    executable: resolveBunExecutable(process.execPath, process.env),
    args: [entry],
    cwd: process.cwd(),
  };
}

export async function buildControllerContextPackInSidecar(input: {
  repoRoot: string;
  policy: McpPolicy;
  options: ControllerContextPackOptions;
}): Promise<ControllerContextPackProjection> {
  const command = resolveContextPackSidecarCommand();
  const envelope = JSON.stringify({
    schemaVersion: 1,
    repoRoot: resolve(input.repoRoot),
    policy: input.policy,
    options: input.options,
  });
  const execution = await runBoundedChild(command.executable, command.args, {
    cwd: command.cwd ?? input.repoRoot,
    input: envelope,
    timeoutMs: CONTEXT_PACK_TIMEOUT_MS,
    maxOutputBytes: CONTEXT_PACK_MAX_OUTPUT_BYTES,
  });
  if (execution.status !== 0 || execution.timedOut || execution.failureCode) {
    const detail = (execution.stderr || execution.stdout || execution.error || execution.failureCode || 'context-pack sidecar failed').trim();
    throw new Error(`CONTEXT_PACK_SIDECAR_FAILED: ${detail.slice(0, 2_000)}`);
  }
  let response: ContextPackSidecarResponse;
  try {
    response = JSON.parse(execution.stdout) as ContextPackSidecarResponse;
  } catch (error) {
    throw new Error(`CONTEXT_PACK_SIDECAR_RESPONSE_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.schemaVersion !== 1 || !response.pack || response.pack.schemaVersion !== 11) {
    throw new Error('CONTEXT_PACK_SIDECAR_RESPONSE_INVALID: unsupported response');
  }
  return response.pack;
}
