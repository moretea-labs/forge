export interface CliChildInvocation {
  executable: string;
  args: string[];
}

export interface CliChildInvocationOptions {
  runtimeExecutable?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve a child invocation for the current CLI across source runtimes and
 * Bun standalone releases.
 *
 * Source Node/Bun launches need the CLI module as argv[0]. A Bun compiled
 * executable is already the CLI; its embedded /$bunfs entry is not a runnable
 * child path and must never be passed back as a subcommand.
 */
export function resolveCliChildInvocation(
  cliEntry: string,
  args: readonly string[],
  options: CliChildInvocationOptions = {},
): CliChildInvocation {
  const runtimeExecutable = options.runtimeExecutable ?? process.execPath;
  const env = options.env ?? process.env;
  const normalizedEntry = cliEntry.replace(/\\/g, '/');
  const standalone = env.REPO_HARNESS_RUNTIME_EXECUTION === 'standalone-binary'
    || normalizedEntry.includes('/$bunfs/');
  return standalone
    ? { executable: runtimeExecutable, args: [...args] }
    : { executable: runtimeExecutable, args: [cliEntry, ...args] };
}
