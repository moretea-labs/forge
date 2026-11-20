import { existsSync, realpathSync, statSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import type { ExternalFilesystemGrant } from '../safe-tooling/external-filesystem';
import { externalFilesystemGrantExpired } from '../safe-tooling/external-filesystem';
import type { RepositoryRecord } from '../../core/repository/types';
import { normalizeRepositoryCommand, type CanonicalRepositoryCommand } from '../../core/repository-command/normalization';

const MAX_COMMAND_LENGTH = 32 * 1024;

export type RepositoryCommandExternalPathOperation = 'external_read' | 'external_copy_into_workspace' | 'controller_local_effect';

export interface RepositoryCommandExternalPathUsage {
  token: string;
  canonicalPath: string;
  operation: RepositoryCommandExternalPathOperation;
  grantKey: string;
  grantRoot: string;
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  const parentPrefix = `..${process.platform === 'win32' ? '\\' : '/'}`;
  return rel === '' || (rel !== '..' && !rel.startsWith(parentPrefix) && !isAbsolute(rel));
}

function nearestExistingPath(candidate: string): string | undefined {
  let current = candidate;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return current;
}

/**
 * Minimal command execution target. Repository identity stays optional: an
 * arbitrary workspace target carries only its scope key and root, so command
 * policy/audit/cwd checks need no fabricated repository record.
 */
export interface RepositoryCommandScopeTarget {
  canonicalRoot: string;
  /** Registered repository id (`RepositoryRecord.repoId`); absent for an arbitrary workspace target. */
  repoId?: string;
  /** Workspace scope key; present only when the target is not a repository. */
  workspaceScopeKey?: string;
  activeCheckoutId?: string;
  defaultBranch?: string;
  canonicalRemote?: string;
  remoteUrl?: string;
  enabled?: boolean;
}

/** Canonical scope key for command policy/audit/approval storage. */
export function commandExecutionScopeKey(target: RepositoryCommandScopeTarget): string {
  const key = target.repoId?.trim() || target.workspaceScopeKey?.trim();
  if (!key) throw new Error('COMMAND_TARGET_SCOPE_REQUIRED: command target requires a repository id or workspace scope key');
  return key;
}

export function resolveRepositoryCommandCwd(
  repository: RepositoryCommandScopeTarget,
  requestedCwd: string | undefined,
): { root: string; cwd: string; relativeCwd: string } {
  if (repository.enabled === false) throw new Error(`REPOSITORY_DISABLED: ${commandExecutionScopeKey(repository)}`);
  const root = realpathSync(repository.canonicalRoot);
  const raw = requestedCwd?.trim() || '.';
  if (raw.includes('\0')) throw new Error('COMMAND_SCOPE_DENIED: cwd contains a null byte');
  const candidate = resolve(root, raw);
  if (!existsSync(candidate)) throw new Error(`COMMAND_SCOPE_DENIED: cwd does not exist: ${raw}`);
  const cwd = realpathSync(candidate);
  if (!statSync(cwd).isDirectory()) throw new Error(`COMMAND_SCOPE_DENIED: cwd is not a directory: ${raw}`);
  const relativeCwd = relative(root, cwd) || '.';
  if (!pathInside(root, cwd)) throw new Error(`COMMAND_SCOPE_DENIED: cwd escapes repository root: ${raw}`);
  return { root, cwd, relativeCwd };
}

interface RepositoryCommandInputPolicyOptions {
  /** Internal lane hint: preserve repository policy while allowing an already-classified local script shape. */
  allowOpaqueLocalScript?: boolean;
  /** Enforce protected-main-only source topology for the canonical Forge repository. */
  singleCanonicalBranchOnly?: boolean;
  /** Require branch/worktree mutations to use the typed Forge APIs for every managed repository. */
  managedBranchCreationOnly?: boolean;
  /** The canonical remote integration branch for this repository. */
  defaultBranch?: string;
}

export function assertRepositoryCommandAllowed(
  command: string,
  _options: RepositoryCommandInputPolicyOptions = {},
): string {
  const normalized = command.trim();
  if (!normalized) throw new Error('COMMAND_INVALID: command is required');
  if (normalized.length > MAX_COMMAND_LENGTH) {
    throw new Error(`COMMAND_INVALID: command exceeds ${MAX_COMMAND_LENGTH} characters`);
  }
  if (normalized.includes('\0')) throw new Error('COMMAND_INVALID: command contains a null byte');
  // Repository commands are an execution surface, not a shell-language policy
  // engine. Do not maintain an enumerated command/program denylist here: it is
  // necessarily incomplete and turns new CLI/subcommand shapes into false
  // negatives. Structural repository/cwd/external-path authority is enforced
  // separately after normalization.
  return normalized;
}

function macOsTccSensitiveShellTool(command: string): string | undefined {
  const match = command.match(/(?:^|[\n;&|])\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(?:(?:command|exec|sudo|nohup)\s+)?(?:\/usr\/(?:bin|sbin)\/)?(osascript|screencapture)(?=\s|$)/i);
  return match?.[1]?.toLowerCase();
}

function macOsTccSensitiveArgvTool(command: CanonicalRepositoryCommand): string | undefined {
  if (command.kind !== 'argv') return undefined;
  const executableName = command.executable!.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  if (executableName === 'osascript' || executableName === 'screencapture') return executableName;
  if (!['bash', 'sh', 'zsh', 'fish', 'dash', 'cmd', 'powershell', 'pwsh'].includes(executableName)) return undefined;
  const args = command.args ?? [];
  const commandFlagIndex = args.findIndex((arg) => /^(?:-[^-]*c[^-]*|\/c|-Command)$/i.test(arg));
  if (commandFlagIndex < 0) return undefined;
  const shellPayload = args[commandFlagIndex + 1];
  return typeof shellPayload === 'string' ? macOsTccSensitiveShellTool(shellPayload) : undefined;
}

const INLINE_INTERPRETERS = new Set(['node', 'nodejs', 'bun', 'deno']);
const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'fish', 'dash']);
const FORGE_PLUGIN_ACTION_EXECUTOR = /\b(?:submitAssistantPluginAction|executeAssistantPluginAction|executeBrowserPluginAction)\b/;
const FORGE_RUNTIME_PLUGIN_IMPORT = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*['"][^'"]*(?:^|[\\/])(?:src[\\/])?runtime[\\/]plugins[\\/][^'"]+['"]/m;

function inlineEvalPayload(command: CanonicalRepositoryCommand): string | undefined {
  if (command.kind === 'shell') {
    const shell = command.shellCommand ?? '';
    return /(?:^|[;&|]\s*|\s)(?:node|nodejs|bun|deno)(?:\s+[^\n;&|]*)?\s(?:-e|--eval)(?:\s|=)/i.test(shell)
      ? shell
      : undefined;
  }
  const executableName = command.executable!.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  const args = command.args ?? [];
  if (SHELL_INTERPRETERS.has(executableName)) {
    const commandFlagIndex = args.findIndex((arg) => /^(?:-[^-]*c[^-]*)$/i.test(arg));
    const payload = commandFlagIndex >= 0 ? args[commandFlagIndex + 1] : undefined;
    return typeof payload === 'string'
      && /(?:^|[;&|]\s*|\s)(?:node|nodejs|bun|deno)(?:\s+[^\n;&|]*)?\s(?:-e|--eval)(?:\s|=)/i.test(payload)
      ? payload
      : undefined;
  }
  if (!INLINE_INTERPRETERS.has(executableName)) return undefined;
  const evalIndex = args.findIndex((arg) => arg === '-e' || arg === '--eval');
  if (evalIndex >= 0) return args[evalIndex + 1];
  const inline = args.find((arg) => arg.startsWith('--eval='));
  return inline?.slice('--eval='.length);
}

/**
 * Process Runtime deliberately supports bounded direct argv eval for diagnostics
 * and test helpers. What it must not support is using that escape hatch as a
 * second plugin executor: typed plugin actions own authorization, resource
 * claims, receipts, and recovery semantics through plugin_action_execute.
 */
export function assertRepositoryCommandNoPluginExecutionBypass(input: unknown): CanonicalRepositoryCommand {
  const command = normalizeRepositoryCommand(input);
  const payload = inlineEvalPayload(command);
  if (payload && FORGE_PLUGIN_ACTION_EXECUTOR.test(payload) && FORGE_RUNTIME_PLUGIN_IMPORT.test(payload)) {
    throw new Error(
      'PLUGIN_ACTION_EXECUTION_REQUIRES_TYPED_PLUGIN_TOOL: repository commands may not invoke Forge runtime plugin action internals; use plugin_action_execute so typed authorization, resource claims, receipts, and recovery remain authoritative',
    );
  }
  return command;
}

/**
 * Runtime releases live at release-specific executable paths. Never let those
 * binaries become macOS TCC principals: GUI automation and screen capture must
 * be owned by the stable Forge Desktop Operator / typed browser provider.
 */
export function assertRepositoryCommandStableHostIdentity(input: unknown): CanonicalRepositoryCommand {
  const command = normalizeRepositoryCommand(input);
  const tool = command.kind === 'shell'
    ? macOsTccSensitiveShellTool(command.shellCommand!)
    : macOsTccSensitiveArgvTool(command);
  if (tool) {
    throw new Error(
      `COMMAND_POLICY_DENIED: ${tool} is macOS TCC-sensitive and must run through the stable Forge Desktop Operator/browser capability; forge-runtime must not become the permission identity`,
    );
  }
  return command;
}

export function assertRepositoryCommandInputAllowed(
  input: unknown,
  options: RepositoryCommandInputPolicyOptions = {},
): CanonicalRepositoryCommand {
  const command = assertRepositoryCommandStableHostIdentity(input);
  if (options.managedBranchCreationOnly) assertManagedBranchCreationOnly(command, options.defaultBranch?.trim() || 'main');
  if (options.singleCanonicalBranchOnly) assertSingleCanonicalBranchGitCommand(command);
  if (command.kind === 'shell') {
    assertRepositoryCommandAllowed(command.shellCommand!, options);
  }
  // Do not infer execution permission from executable names, shell flags, inline
  // interpreter flags, network utilities, or Git subcommands. Those rules are
  // not complete enough to be an authority boundary. Real repository and
  // external-filesystem scope is validated by assertCommandPathOperandsStayInRepository.
  return command;
}

function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const flush = () => {
    const segment = current.trim();
    if (segment) segments.push(segment);
    current = '';
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) { current += character; escaped = false; continue; }
    if (character === '\\' && quote !== "'") { current += character; escaped = true; continue; }
    if (quote) { current += character; if (character === quote) quote = undefined; continue; }
    if (character === "'" || character === '"') { quote = character; current += character; continue; }
    if (character === ';' || character === '|' || character === '&') {
      flush();
      if (command[index + 1] === character) index += 1;
      continue;
    }
    current += character;
  }
  flush();
  return segments;
}

function shellWords(segment: string): string[] {
  return segment.match(/"(?:\\.|[^"])*"|'[^']*'|[^\s<>]+/g)?.map((word) => word.replace(/^['"]|['"]$/g, '')) ?? [];
}

function stripTrailingPunctuation(token: string): string {
  return token.replace(/[,*?]+$/g, '');
}


function gitInvocation(words: string[]): { subcommand: string; args: string[] } | undefined {
  const executable = words[0]?.split(/[\\\\/]/).at(-1)?.toLowerCase();
  if (executable !== 'git' && executable !== 'git.exe') return undefined;
  let index = 1;
  const valueOptions = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix']);
  const flagOptions = new Set(['--no-pager', '--no-optional-locks', '--literal-pathspecs', '--no-replace-objects', '--bare']);
  while (index < words.length) {
    const token = words[index]!;
    if (valueOptions.has(token)) { index += 2; continue; }
    if (['--git-dir=', '--work-tree=', '--namespace=', '--exec-path='].some((prefix) => token.startsWith(prefix))) { index += 1; continue; }
    if (flagOptions.has(token)) { index += 1; continue; }
    break;
  }
  const subcommand = words[index]?.toLowerCase();
  return subcommand ? { subcommand, args: words.slice(index + 1) } : undefined;
}

function nestedGitInvocations(words: string[], depth = 0): string[][] {
  if (depth > 8 || words.length === 0) return [];
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index += 1;
  if (index >= words.length) return [];
  const executable = words[index]!.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  const args = words.slice(index + 1);
  const descend = (nested: string[]) => nestedGitInvocations(nested, depth + 1);

  if (executable === 'env') {
    let cursor = 0;
    while (cursor < args.length) {
      const value = args[cursor]!;
      if (value === '--') { cursor += 1; break; }
      if (value === '-S' || value === '--split-string') {
        const payload = args[cursor + 1];
        return typeof payload === 'string' ? shellSegments(payload).flatMap((segment) => descend(shellWords(segment))) : [];
      }
      if (['-i', '--ignore-environment', '-0'].includes(value)) { cursor += 1; continue; }
      if (['-u', '--unset', '-C', '--chdir', '--argv0'].includes(value)) { cursor += 2; continue; }
      if (value.startsWith('--unset=') || value.startsWith('--chdir=') || value.startsWith('--argv0=')) { cursor += 1; continue; }
      if (value.startsWith('-')) { cursor += 1; continue; }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) { cursor += 1; continue; }
      break;
    }
    return descend(args.slice(cursor));
  }

  if (['command', 'exec', 'nohup'].includes(executable)) {
    let cursor = 0;
    if (executable === 'command') {
      if (args[0] === '-v' || args[0] === '-V') return [];
      while (args[cursor] === '-p' || args[cursor] === '--') cursor += 1;
    } else if (executable === 'exec') {
      while (cursor < args.length && ['-c', '-l'].includes(args[cursor]!)) cursor += 1;
      if (args[cursor] === '-a') cursor += 2;
    } else if (args[cursor] === '--') cursor += 1;
    return descend(args.slice(cursor));
  }

  if (executable === 'sudo') {
    const valueOptions = new Set(['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-T', '--command-timeout', '-r', '--role', '-t', '--type', '-D', '--chdir']);
    let cursor = 0;
    while (cursor < args.length) {
      const value = args[cursor]!;
      if (value === '--') { cursor += 1; break; }
      if (valueOptions.has(value)) { cursor += 2; continue; }
      if (value.startsWith('-')) { cursor += 1; continue; }
      break;
    }
    return descend(args.slice(cursor));
  }

  if (['timeout', 'nice', 'time'].includes(executable)) {
    let cursor = 0;
    if (executable === 'timeout') {
      while (cursor < args.length && args[cursor]!.startsWith('-')) {
        const flag = args[cursor]!;
        cursor += ['--signal', '-s', '--kill-after', '-k'].includes(flag) ? 2 : 1;
      }
      if (cursor < args.length) cursor += 1;
    } else if (executable === 'nice') {
      if (args[cursor] === '-n' || args[cursor] === '--adjustment') cursor += 2;
    } else if (args[cursor] === '-p' || args[cursor] === '-f') cursor += 1;
    return descend(args.slice(cursor));
  }

  const shell = ['bash', 'sh', 'zsh', 'fish', 'dash', 'cmd', 'cmd.exe', 'powershell', 'pwsh'].includes(executable);
  if (shell) {
    const commandIndex = executable === 'cmd' || executable === 'cmd.exe'
      ? args.findIndex((arg) => /^\/c$/i.test(arg))
      : args.findIndex((arg) => /^(?:-[^-]*c[^-]*|--command|-command)$/i.test(arg));
    if (commandIndex >= 0) {
      const payload = args[commandIndex + 1];
      return typeof payload === 'string'
        ? shellSegments(payload).flatMap((segment) => descend(shellWords(segment)))
        : [];
    }
  }

  return [[...words.slice(index)]];
}

function assertManagedBranchCreationOnly(command: CanonicalRepositoryCommand, defaultBranch: string): void {
  const invocations = command.kind === 'argv'
    ? nestedGitInvocations([command.executable!, ...(command.args ?? [])])
    : shellSegments(command.shellCommand!).flatMap((segment) => nestedGitInvocations(shellWords(segment)));
  const denied = (detail: string) => new Error('GIT_BRANCH_CREATION_REQUIRES_MANAGED_API: ' + detail);
  const readOnlyBranchFlags = new Set([
    '-l', '--list', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose',
    '--show-current', '--contains', '--merged', '--no-merged', '--points-at', '--format', '--sort',
    '--column', '--no-column',
  ]);
  const mutationBranchFlags = new Set(['-c', '-C', '-m', '-M', '-d', '-D', '-f', '--copy', '--move', '--delete', '--force']);
  for (const words of invocations) {
    const parsed = gitInvocation(words);
    if (!parsed) continue;
    const deniedAlias = words.some((arg, index) => (arg === '-c' || arg === '--config-env') && (words[index + 1] ?? '').startsWith('alias.'))
      || words.some((arg) => arg.startsWith('--config-env=alias.'));
    if (deniedAlias) throw denied('Git command aliases cannot override protected branch policy');
    const args = parsed.args;
    if (parsed.subcommand === 'branch') {
      const mutating = args.some((arg) => mutationBranchFlags.has(arg));
      const positional = args.filter((arg) => !arg.startsWith('-') && !arg.includes('='));
      const readOnly = args.length === 0 || args.some((arg) => readOnlyBranchFlags.has(arg));
      if (mutating || (positional.length > 0 && !readOnly)) throw denied('branch creation, rename and deletion must use the typed branch API');
    }
    if (parsed.subcommand === 'switch' && args.some((arg) => ['-c', '-C', '--create', '--force-create', '--orphan', '--detach', '--discard-changes', '-f'].includes(arg))) {
      throw denied('branch creation and detached switching must use the typed branch API');
    }
    if (parsed.subcommand === 'checkout' && args.some((arg) => ['-b', '-B', '--orphan', '--detach', '-f', '--force'].includes(arg))) {
      throw denied('branch creation and detached checkout must use the typed branch API');
    }
    if (parsed.subcommand === 'worktree' && ['add', 'remove', 'move', 'prune', 'repair'].includes(args[0] ?? '')) {
      throw denied('worktree lifecycle must use the managed workspace API');
    }
    if (parsed.subcommand === 'update-ref') {
      throw denied('direct Git ref mutation must use the typed branch API');
    }
    if (parsed.subcommand === 'fetch') {
      const positional = args.filter((arg) => !arg.startsWith('-'));
      const refspecs = positional.slice(1);
      const remote = positional[0];
      const forbiddenFlags = args.some((arg) => ['--all', '--multiple', '--prune', '-p'].includes(arg));
      const invalidRefspec = refspecs.some((refspec) => {
        const [sourceRef = '', destinationRef] = refspec.split(':');
        const source = sourceRef.replace(/^\+/, '').replace(/^refs\/heads\//, '');
        const destination = destinationRef?.replace(/^\+/, '');
        const allowedDestination = destination === undefined
          || destination === 'refs/remotes/' + remote + '/' + defaultBranch;
        return source !== defaultBranch || !allowedDestination;
      });
      if (forbiddenFlags || !remote || refspecs.length !== 1 || invalidRefspec) {
        throw denied('fetch must explicitly target only the canonical default branch and its remote-tracking ref');
      }
    }
    if (parsed.subcommand === 'config') {
      const positional = args.filter((arg) => !arg.startsWith('-'));
      if (positional[0]?.startsWith('alias.')) {
        throw denied('Git alias mutation is disabled for managed repositories');
      }
    }
    if (parsed.subcommand === 'remote' && ['update', 'prune', 'set-url', 'add', 'remove', 'rename'].includes(args[0] ?? '')) {
      throw denied('Git remote mutation is disabled for managed repositories');
    }
    if (parsed.subcommand === 'symbolic-ref' || (parsed.subcommand === 'stash' && args[0] === 'branch')) {
      throw denied('direct Git branch-ref mutation must use the managed API');
    }
    if (parsed.subcommand === 'push') {
      const positional = args.filter((arg) => !arg.startsWith('-'));
      const refspecs = positional.slice(1);
      const forbiddenFlags = args.some((arg) => ['--all', '--multiple', '--prune', '-p'].includes(arg));
      const invalidRefspec = refspecs.some((refspec) => {
        const [sourceRef = '', destinationRef] = refspec.split(':');
        const source = sourceRef.replace(/^\+/, '').replace(/^refs\/heads\//, '');
        const destination = (destinationRef ?? sourceRef).replace(/^\+/, '').replace(/^refs\/heads\//, '');
        return source !== defaultBranch || destination !== defaultBranch;
      });
      const force = args.some((arg) => ['-f', '--force', '--mirror', '--all', '--delete'].includes(arg)
        || arg === '--force-with-lease' || arg.startsWith('--force-with-lease='))
        || refspecs.some((refspec) => refspec.startsWith('+'));
      if (force || !positional[0] || refspecs.length !== 1 || invalidRefspec) {
        throw denied('push must explicitly source and target only the canonical default branch without force or mirror');
      }
    }
  }
}

function assertSingleCanonicalBranchGitCommand(command: CanonicalRepositoryCommand): void {
  const invocations = command.kind === 'argv'
    ? nestedGitInvocations([command.executable!, ...(command.args ?? [])])
    : shellSegments(command.shellCommand!).flatMap((segment) => nestedGitInvocations(shellWords(segment)));
  const denied = (detail: string) => new Error(`SOURCE_BRANCH_POLICY_MAIN_ONLY: ${detail}; use the canonical main checkout`);
  const readOnlyBranchFlags = new Set([
    '-l', '--list', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose',
    '--show-current', '--contains', '--merged', '--no-merged', '--points-at', '--format', '--sort',
    '--column', '--no-column',
  ]);
  const mutationBranchFlags = new Set(['-c', '-C', '-m', '-M', '-d', '-D', '-f', '--copy', '--move', '--delete', '--force']);
  for (const words of invocations) {
    const parsed = gitInvocation(words);
    if (!parsed) continue;
    const deniedAlias = words.some((arg, index) => (arg === '-c' || arg === '--config-env') && (words[index + 1] ?? '').startsWith('alias.'))
      || words.some((arg) => arg.startsWith('--config-env=alias.'));
    if (deniedAlias) throw denied('Git command aliases cannot override protected branch policy');
    const args = parsed.args;
    if (parsed.subcommand === 'branch') {
      const mutating = args.some((arg) => mutationBranchFlags.has(arg));
      const positional = args.filter((arg) => !arg.startsWith('-') && !arg.includes('='));
      const readOnly = args.length === 0 || args.some((arg) => readOnlyBranchFlags.has(arg));
      if (mutating || (positional.length > 0 && !readOnly)) throw denied('branch ref creation, rename and deletion through shell commands are disabled');
    }
    if (parsed.subcommand === 'switch') {
      if (args.some((arg) => ['-c', '-C', '--create', '--force-create', '--detach', '--orphan', '--discard-changes', '-f'].includes(arg))) {
        throw denied('branch creation or detached checkout is disabled');
      }
      const target = args.find((arg) => !arg.startsWith('-'));
      if (target && target !== 'main') throw denied(`checkout of non-main branch '${target}' is disabled`);
    }
    if (parsed.subcommand === 'checkout') {
      if (args.some((arg) => ['-b', '-B', '--orphan', '--detach', '-f', '--force'].includes(arg))) {
        throw denied('branch creation or detached checkout is disabled');
      }
      if (!args.includes('--')) {
        const target = args.find((arg) => !arg.startsWith('-'));
        if (target && target !== 'main') throw denied(`checkout of non-main branch '${target}' is disabled`);
      }
    }
    if (parsed.subcommand === 'worktree' && ['add', 'remove', 'prune', 'move'].includes(args[0] ?? '')) {
      throw denied('writable worktree creation and direct worktree cleanup are disabled');
    }
    if (parsed.subcommand === 'fetch') {
      const positional = args.filter((arg) => !arg.startsWith('-'));
      const refspecs = positional.slice(1);
      const refspec = refspecs[0] ?? '';
      const [sourceRef = '', destinationRef] = refspec.split(':');
      const source = sourceRef.replace(/^\+/, '').replace(/^refs\/heads\//, '');
      const destination = destinationRef?.replace(/^\+/, '');
      const forbiddenFlags = args.some((arg) => ['--all', '--multiple', '--prune', '-p'].includes(arg));
      const writesNonCanonicalDestination = destination !== undefined && destination !== 'refs/remotes/origin/main';
      if (forbiddenFlags || positional[0] !== 'origin' || refspecs.length !== 1 || source !== 'main' || writesNonCanonicalDestination) {
        throw denied('fetch must explicitly target only origin/main without pruning or writing local branch refs');
      }
    }
    if (parsed.subcommand === 'rebase' && !['--abort', '--continue', '--skip'].includes(args[0] ?? '')) {
      throw denied('rebase is disabled');
    }

    if (parsed.subcommand === 'update-ref' || parsed.subcommand === 'symbolic-ref') {
      throw denied('direct Git branch-ref mutation is disabled');
    }
    if (parsed.subcommand === 'stash' && args[0] === 'branch') {
      throw denied('stash branch creation is disabled');
    }
    if (parsed.subcommand === 'config') {
      const readOnlyFlags = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l']);
      if (!args.some((arg) => readOnlyFlags.has(arg))) {
        throw denied('Git config mutation is disabled for protected source');
      }
    }
    if (parsed.subcommand === 'remote') {
      const readOnly = args.length === 0 || ['-v', '--verbose', 'show', 'get-url'].includes(args[0] ?? '');
      if (!readOnly) throw denied('Git remote mutation is disabled for protected source');
    }
    if (parsed.subcommand === 'pull') {
      throw denied('pull is disabled; fetch origin main then merge --ff-only');
    }
    if (parsed.subcommand === 'push') {
      const positional = args.filter((arg) => !arg.startsWith('-'));
      const refspecs = positional.slice(1);
      const sources = refspecs.map((refspec) => (refspec.split(':')[0] ?? '').replace(/^\+/, '').replace(/^refs\/heads\//, ''));
      const targets = refspecs.map((refspec) => (refspec.split(':').at(-1) ?? '').replace(/^\+/, '').replace(/^refs\/heads\//, ''));
      const force = args.some((arg) => ['-f', '--force', '--mirror', '--all', '--delete'].includes(arg)
        || arg === '--force-with-lease' || arg.startsWith('--force-with-lease='))
        || refspecs.some((refspec) => refspec.startsWith('+'));
      if (force || refspecs.length === 0 || sources.some((source) => source !== 'main') || targets.some((target) => target !== 'main')) {
        throw denied('push must explicitly target protected main without force or mirror');
      }
    }
  }
}

function sensitivePathDenied(canonicalPath: string): boolean {
  const lower = canonicalPath.toLowerCase();
  return [
    '/.ssh',
    '/.gnupg',
    '/library/keychains',
    '/library/application support/google/chrome/default/cookies',
    '/library/application support/google/chrome/default/network/cookies',
    '/library/application support/firefox/profiles',
    '/library/application support/1password',
    '/library/group containers/2bua8c4s2c.com.1password',
    '/.aws',
    '/.config/gcloud',
    '/.kube',
    '/id_rsa',
    '/id_dsa',
    '/id_ecdsa',
    '/id_ed25519',
  ].some((fragment) => lower.includes(fragment));
}

function readOnlyProgram(program: string | undefined): boolean {
  return Boolean(program && [
    'pwd', 'ls', 'rg', 'grep', 'egrep', 'fgrep', 'cat', 'head', 'tail', 'wc',
    'sort', 'uniq', 'cut', 'tr', 'stat', 'file', 'basename', 'dirname', 'printf',
    'echo', 'du', 'df', 'realpath', 'readlink', 'jq', 'shasum', 'sha256sum', 'find',
  ].includes(program.toLowerCase()));
}

interface RepositoryCommandPathPolicyOptions {
  controllerHome?: string;
  repositoryId?: string;
}

function grantCoversPath(grant: ExternalFilesystemGrant, canonicalPath: string, operation: RepositoryCommandExternalPathOperation): boolean {
  if (operation === 'controller_local_effect') return false;
  if (externalFilesystemGrantExpired(grant)) return false;
  if (operation === 'external_read' && grant.mode !== 'read') return false;
  if (operation === 'external_copy_into_workspace' && grant.mode !== 'copy_into_repo') return false;
  const rel = relative(grant.canonicalRoot, canonicalPath);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel));
}

function operationForToken(words: string[], index: number, external: string, cwd: string, root: string): RepositoryCommandExternalPathOperation | 'external_write' | 'unsupported' {
  const program = words[0]?.split(/[\\/]/).at(-1)?.toLowerCase();
  if (!program) return 'unsupported';
  if (program === 'cp' || program === 'install') {
    const operands = words.slice(1).filter((word) => word && !word.startsWith('-'));
    const operandIndex = operands.indexOf(external);
    const destination = operands.at(-1);
    if (operandIndex >= 0 && destination && external !== destination) {
      const destinationPath = resolve(cwd, stripTrailingPunctuation(destination));
      const existingDestination = nearestExistingPath(destinationPath);
      const resolvedDestination = existingDestination ? realpathSync(existingDestination) : destinationPath;
      return pathInside(root, resolvedDestination) ? 'external_copy_into_workspace' : 'external_write';
    }
    return 'external_write';
  }
  if (program === 'find' && words.some((word) => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(word))) return 'external_write';
  if (readOnlyProgram(program)) return 'external_read';
  if (index === 0) return 'unsupported';
  return 'external_write';
}

function gitIndexOnlyRepositoryOperand(words: string[], index: number, candidateToken: string, cwd: string, root: string): boolean {
  const executable = words[0]?.split(/[\\/]/).at(-1)?.toLowerCase();
  if (executable !== 'git') return false;
  const subcommand = words[1];
  const indexOnly = subcommand === 'update-index'
    || (subcommand === 'rm' && words.includes('--cached'))
    || (subcommand === 'restore' && words.includes('--staged') && !words.includes('--worktree'));
  if (!indexOnly || index < 2) return false;
  const lexical = candidateToken.startsWith('/') ? resolve(candidateToken) : resolve(cwd, candidateToken);
  return pathInside(root, lexical);
}

export function assertCommandPathOperandsStayInRepository(
  command: string | CanonicalRepositoryCommand,
  cwd: string,
  root: string,
  externalGrants: ExternalFilesystemGrant[] = [],
  options: RepositoryCommandPathPolicyOptions = {},
): RepositoryCommandExternalPathUsage[] {
  const usages: RepositoryCommandExternalPathUsage[] = [];
  const segments = typeof command === 'string'
    ? shellSegments(command).map((segment) => ({ raw: segment, words: shellWords(segment) }))
    : command.kind === 'shell'
      ? shellSegments(command.shellCommand!).map((segment) => ({ raw: segment, words: shellWords(segment) }))
      : [{ raw: '', words: [command.executable!, ...(command.args ?? [])] }];
  for (const { raw: segment, words } of segments) {
    const redirectionTarget = segment.match(/(?:^|\s)(?:\d?>?>)\s*(\/[^\s]+)/)?.[1];
    if (redirectionTarget && !redirectionTarget.startsWith('/dev/null')) {
      throw new Error(`COMMAND_SCOPE_DENIED: external writes are not allowed from repository commands: ${redirectionTarget}`);
    }
    for (let index = 0; index < words.length; index += 1) {
      const token = words[index]!;
      if (!token || token.startsWith('-') || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(token)) continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
      if (index === 0) continue;
      const candidateToken = stripTrailingPunctuation(token);
      const absoluteInput = candidateToken.startsWith('/');
      if (!absoluteInput && !/[./\\*?]/.test(candidateToken) && !existsSync(join(cwd, candidateToken))) continue;
      const candidate = absoluteInput ? resolve(candidateToken) : resolve(cwd, candidateToken);
      // Git index-only operations address the repository entry itself and do not
      // dereference its symlink target. Fence them lexically to the repository;
      // all filesystem-affecting operations still use realpath below.
      if (gitIndexOnlyRepositoryOperand(words, index, candidateToken, cwd, root)) continue;
      const existing = nearestExistingPath(candidate);
      if (!existing) continue;
      const resolved = realpathSync(existing);
      if (pathInside(root, resolved)) continue;
      if (!absoluteInput) {
        throw new Error(`COMMAND_SCOPE_DENIED: command operand escapes repository root through a symlink or parent path: ${token}`);
      }
      if (sensitivePathDenied(resolved)) {
        throw new Error(`COMMAND_SCOPE_DENIED: sensitive external path is never allowed in repository commands: ${token}`);
      }
      const operation = operationForToken(words, index, token, cwd, root);
      if (operation === 'external_write') {
        throw new Error(`COMMAND_SCOPE_DENIED: external writes are not allowed from repository commands: ${token}`);
      }
      if (operation === 'unsupported') {
        throw new Error(`COMMAND_SCOPE_DENIED: external path is only allowed for read-only commands or copy-into-repository sources: ${token}`);
      }
      const grant = externalGrants.find((entry) => grantCoversPath(entry, resolved, operation));
      if (!grant) {
        throw new Error(`EXTERNAL_FILESYSTEM_GRANT_REQUIRED: ${operation} requires an active ${operation === 'external_read' ? 'read' : 'copy_into_repo'} grant for ${token}`);
      }
      usages.push({
        token,
        canonicalPath: resolved,
        operation,
        grantKey: grant.key,
        grantRoot: grant.canonicalRoot,
      });
    }
  }
  return usages;
}
