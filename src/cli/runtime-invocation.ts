import { existsSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

export type CliRuntimeKind =
  | 'compiled_bun_release'
  | 'bun_source'
  | 'node_source'
  | 'package_launcher';

export interface CliRuntimeTarget {
  entry: string;
  cwd: string;
  runtimeKind: CliRuntimeKind;
  sourceRevision: string;
  immutable: boolean;
  explanation: string;
}

export interface CliChildInvocation {
  executable: string;
  args: string[];
  /** Alias used by Process command contracts and diagnostics. */
  readonly argv?: string[];
  readonly runtimeKind?: CliRuntimeKind;
  readonly sourceRevision?: string;
  readonly immutable?: boolean;
  readonly diagnostic?: string;
}

export interface CliChildInvocationOptions {
  runtimeExecutable?: string;
  runtimeKind?: CliRuntimeKind;
  sourceRevision?: string;
  immutable?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Explicit package/global shim entry. Never inferred from a file extension. */
  launcherEntry?: string;
}

export interface CurrentCliRuntimeOptions extends CliChildInvocationOptions {
  argv?: readonly string[];
  moduleUrl?: string;
  sourceRoot?: string;
  cwd?: string;
  entryExists?: (path: string) => boolean;
}

export class CliRuntimeResolutionError extends Error {
  readonly code = 'CLI_RUNTIME_UNRESOLVED';
  readonly diagnostics: string[];

  constructor(diagnostics: string[]) {
    super(`CLI_RUNTIME_UNRESOLVED: ${diagnostics.join('; ')}`);
    this.name = 'CliRuntimeResolutionError';
    this.diagnostics = diagnostics;
  }
}

function normalizedRevision(value: string | undefined): string {
  const revision = value?.trim();
  return revision || 'unversioned';
}

function runtimeKindFromExecutable(executable: string): 'bun' | 'node' | undefined {
  const name = basename(executable).toLowerCase();
  if (name === 'bun' || name.startsWith('bun-')) return 'bun';
  if (name === 'node' || name.startsWith('node-')) return 'node';
  return undefined;
}

function metadata<T extends { executable: string; args: string[] }>(
  base: T,
  details: Omit<CliChildInvocation, 'executable' | 'args'>,
): CliChildInvocation {
  // Keep executable/args enumerable for compatibility with existing command
  // contracts while exposing the richer identity as typed, immutable fields.
  return Object.defineProperties(base, {
    argv: { value: details.argv, enumerable: false, writable: false },
    runtimeKind: { value: details.runtimeKind, enumerable: false, writable: false },
    sourceRevision: { value: details.sourceRevision, enumerable: false, writable: false },
    immutable: { value: details.immutable, enumerable: false, writable: false },
    diagnostic: { value: details.diagnostic, enumerable: false, writable: false },
  }) as unknown as CliChildInvocation;
}

/**
 * Resolve one child invocation from an explicit runtime target.
 *
 * No file-extension guessing is used. Runtime identity comes from an explicit
 * kind, the immutable-release marker, the Bun virtual filesystem marker, or
 * the executable identity (bun/node). Package/global launchers require an
 * explicit launcherEntry so shims and paths containing spaces remain argv-safe.
 */
export function resolveCliChildInvocation(
  cliEntry: string,
  args: readonly string[],
  options: CliChildInvocationOptions = {},
): CliChildInvocation {
  const env = options.env ?? process.env;
  const executable = options.runtimeExecutable?.trim() || process.execPath;
  const revision = normalizedRevision(
    options.sourceRevision
      ?? env.FORGE_RUNTIME_SOURCE_REVISION
      ?? env.FORGE_ACTIVE_RUNTIME_REVISION,
  );
  const diagnostics: string[] = [];
  let kind = options.runtimeKind;

  if (!kind && env.FORGE_RUNTIME_EXECUTION === 'standalone-binary') {
    kind = 'compiled_bun_release';
    diagnostics.push('runtime execution marker identifies an immutable Bun release');
  }
  if (!kind && cliEntry.replace(/\\/g, '/').includes('/$bunfs/')) {
    kind = 'compiled_bun_release';
    diagnostics.push('Bun virtual filesystem entry identifies an immutable compiled release');
  }
  if (!kind && options.launcherEntry?.trim()) {
    kind = 'package_launcher';
    diagnostics.push('explicit package/global launcher entry supplied');
  }
  if (!kind) {
    const executableKind = runtimeKindFromExecutable(executable);
    if (executableKind === 'bun') {
      kind = 'bun_source';
      diagnostics.push('runtime executable identity is Bun');
    } else if (executableKind === 'node') {
      kind = 'node_source';
      diagnostics.push('runtime executable identity is Node');
    }
  }

  if (!kind) {
    throw new CliRuntimeResolutionError([
      `executable=${basename(executable) || '<empty>'}`,
      'no explicit runtime kind, immutable marker, Bun virtual entry, or package launcher identity',
    ]);
  }

  let childArgs: string[];
  let immutable = options.immutable ?? false;
  if (kind === 'compiled_bun_release') {
    childArgs = [...args];
    immutable = true;
  } else if (kind === 'package_launcher') {
    const launcherEntry = options.launcherEntry?.trim();
    if (!launcherEntry) {
      throw new CliRuntimeResolutionError(['package_launcher requires launcherEntry']);
    }
    childArgs = [launcherEntry, ...args];
  } else {
    const entry = cliEntry.trim();
    if (!entry) throw new CliRuntimeResolutionError([`${kind} requires a source entry`]);
    childArgs = [entry, ...args];
  }

  const diagnostic = [
    `kind=${kind}`,
    `sourceRevision=${revision}`,
    `immutable=${immutable}`,
    ...diagnostics,
  ].join('; ');
  return metadata(
    { executable, args: childArgs },
    {
      argv: childArgs,
      runtimeKind: kind,
      sourceRevision: revision,
      immutable,
      diagnostic,
    },
  );
}

/**
 * Locate the current CLI target once. Callers still use the single resolver
 * above to build executable/argv. Missing or ambiguous identities fail closed.
 */
export function currentCliRuntimeTarget(options: CurrentCliRuntimeOptions = {}): CliRuntimeTarget {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const exists = options.entryExists ?? existsSync;
  const cwd = resolve(options.cwd ?? process.cwd());
  const sourceRevision = normalizedRevision(
    options.sourceRevision
      ?? env.FORGE_RUNTIME_SOURCE_REVISION
      ?? env.FORGE_ACTIVE_RUNTIME_REVISION,
  );
  const runtimeExecutable = options.runtimeExecutable?.trim() || process.execPath;

  if (options.runtimeKind === 'compiled_bun_release'
    || env.FORGE_RUNTIME_EXECUTION === 'standalone-binary') {
    return {
      entry: argv[1]?.trim() || runtimeExecutable,
      cwd,
      runtimeKind: 'compiled_bun_release',
      sourceRevision,
      immutable: true,
      explanation: 'explicit immutable standalone runtime identity',
    };
  }

  const configured = env.FORGE_RUNTIME_CLI_ENTRY?.trim();
  if (configured) {
    if (!exists(configured)) {
      throw new CliRuntimeResolutionError([`configured CLI entry does not exist: ${configured}`]);
    }
    const executableKind = runtimeKindFromExecutable(runtimeExecutable);
    const kind = options.runtimeKind
      ?? (options.launcherEntry ? 'package_launcher' : undefined)
      ?? (executableKind === 'node' ? 'node_source' : executableKind === 'bun' ? 'bun_source' : undefined);
    if (!kind) {
      throw new CliRuntimeResolutionError([
        `configured entry is explicit but runtime executable identity is unknown: ${basename(runtimeExecutable)}`,
      ]);
    }
    return {
      entry: resolve(configured),
      cwd,
      runtimeKind: kind,
      sourceRevision,
      immutable: options.immutable ?? false,
      explanation: 'explicit FORGE_RUNTIME_CLI_ENTRY',
    };
  }

  const argvEntry = argv[1]?.trim();
  if (argvEntry && exists(argvEntry)) {
    const normalized = resolve(argvEntry);
    if (normalized.replace(/\\/g, '/').includes('/$bunfs/')) {
      return {
        entry: normalized,
        cwd,
        runtimeKind: 'compiled_bun_release',
        sourceRevision,
        immutable: true,
        explanation: 'current argv entry is inside the Bun immutable virtual filesystem',
      };
    }
    const executableKind = runtimeKindFromExecutable(runtimeExecutable);
    if (executableKind) {
      return {
        entry: normalized,
        cwd,
        runtimeKind: executableKind === 'node' ? 'node_source' : 'bun_source',
        sourceRevision,
        immutable: options.immutable ?? false,
        explanation: 'current argv entry exists and runtime executable identity is explicit',
      };
    }
  }

  if (options.moduleUrl) {
    try {
      const moduleDir = dirname(fileURLToPath(options.moduleUrl));
      const installed = join(moduleDir, 'forge.js');
      if (exists(installed)) {
        return {
          entry: installed,
          cwd,
          runtimeKind: options.runtimeKind ?? 'package_launcher',
          sourceRevision,
          immutable: options.immutable ?? true,
          explanation: 'co-located package/global launcher bundle',
        };
      }
    } catch (error) {
      throw new CliRuntimeResolutionError([
        `module URL resolution failed: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  }

  const sourceRoot = options.sourceRoot?.trim()
    || env.FORGE_CONTROLLER_RUNTIME_SOURCE_ROOT?.trim();
  if (sourceRoot) {
    const resolvedSourceRoot = resolve(sourceRoot);
    const sourceEntry = join(resolvedSourceRoot, 'src', 'cli', 'index.ts');
    if (!exists(sourceEntry)) {
      const immutableRuntime = join(resolvedSourceRoot, 'forge-runtime');
      const immutableCli = join(resolvedSourceRoot, 'forge-cli');
      if (exists(immutableCli)) {
        return {
          entry: immutableCli,
          cwd: resolvedSourceRoot,
          runtimeKind: 'compiled_bun_release',
          sourceRevision,
          immutable: true,
          explanation: 'explicit controller runtime source root provides the same-version immutable forge-cli diagnostic sidecar',
        };
      }
      if (exists(immutableRuntime)) {
        throw new CliRuntimeResolutionError([
          `immutable Runtime release is missing forge-cli diagnostic sidecar: ${immutableCli}`,
        ]);
      }
      throw new CliRuntimeResolutionError([`source runtime entry does not exist: ${sourceEntry}`]);
    }
    const executableKind = runtimeKindFromExecutable(runtimeExecutable);
    if (!executableKind) {
      throw new CliRuntimeResolutionError([
        `source entry found but runtime executable is neither Bun nor Node: ${basename(runtimeExecutable)}`,
      ]);
    }
    return {
      entry: sourceEntry,
      cwd: resolvedSourceRoot,
      runtimeKind: executableKind === 'node' ? 'node_source' : 'bun_source',
      sourceRevision,
      immutable: false,
      explanation: 'explicit controller runtime source root',
    };
  }

  throw new CliRuntimeResolutionError([
    'no standalone marker, configured entry, existing argv entry, co-located package bundle, or explicit source root',
  ]);
}
