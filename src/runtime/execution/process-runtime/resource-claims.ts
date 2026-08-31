/**
 * Fine-grained resource claims for Process Runtime and MCP operations.
 * Prefer path / git-index / git-refs / build-cache over whole-repo exclusive locks.
 */

import type { ResourceClaimSpec } from '../jobs/types';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ControllerCheckEffects } from '../../../cli/controller/check-runner';
import {
  classifyRepositoryCommand,
  fixedShellWrapperCommand,
  shellSegments,
  shellWordsPreservingQuotes,
} from '../../../cli/repositories/command-classifier';
import { normalizeRepositoryCommand } from '../../../cli/repositories/command-normalization';
import { isFocusedCheckCommand } from '../thin-harness/execution-router';
import type { ProcessResourceClaim } from './types';
import { normalizeClaimPath, normalizeClaims } from '../../resources/claims/conflicts';

export type ResourceClaimKind =
  | 'workspace_read'
  | 'path_read'
  | 'path_write'
  | 'build_cache_read'
  | 'build_cache_write'
  | 'temp'
  | 'network'
  | 'git_index'
  | 'git_refs'
  | 'integration'
  | 'migration'
  | 'release'
  | 'remote_mutation'
  | 'heavy_check'
  | 'workspace_write';

function checkoutScope(checkoutId?: string): string {
  return checkoutId?.trim() || 'active';
}

/**
 * Workspace read uses the same resource key as workspace write.
 * Conflict is expressed via mode (read vs write), not a separate key.
 * Legacy workspace-read:* keys are normalized in claims/conflicts.ts.
 */
export function claimWorkspaceRead(checkoutId?: string): ResourceClaimSpec {
  return { resourceKey: `workspace:${checkoutScope(checkoutId)}`, mode: 'read' };
}

export function claimPathRead(path: string, checkoutId?: string): ResourceClaimSpec {
  if (path === '.') return claimWorkspaceRead(checkoutId);
  const normalized = normalizeClaimPath(path);
  if (!normalized) return claimWorkspaceRead(checkoutId);
  return { resourceKey: `path:${checkoutScope(checkoutId)}:${normalized}`, mode: 'read' };
}

export function claimPathWrite(path: string, checkoutId?: string): ResourceClaimSpec {
  const normalized = normalizeClaimPath(path);
  if (!normalized) {
    // Unsafe / ambiguous path → escalate to whole-checkout workspace write.
    return claimWorkspaceWrite(checkoutId);
  }
  return { resourceKey: `path:${checkoutScope(checkoutId)}:${normalized}`, mode: 'write' };
}

export function claimBuildCacheRead(repoId: string): ResourceClaimSpec {
  return { resourceKey: `build-cache:${repoId}`, mode: 'read' };
}

export function claimBuildCacheWrite(repoId: string): ResourceClaimSpec {
  return { resourceKey: `build-cache:${repoId}`, mode: 'write' };
}

export function claimGitIndexRead(checkoutId?: string): ResourceClaimSpec {
  return { resourceKey: `git-index:${checkoutScope(checkoutId)}`, mode: 'read' };
}

export function claimGitIndex(checkoutId?: string): ResourceClaimSpec {
  return { resourceKey: `git-index:${checkoutScope(checkoutId)}`, mode: 'exclusive' };
}

export function claimGitRefsRead(repoId: string): ResourceClaimSpec {
  return { resourceKey: `git-refs:${repoId}`, mode: 'read' };
}

export function claimGitRefs(repoId: string): ResourceClaimSpec {
  return { resourceKey: `git-refs:${repoId}`, mode: 'exclusive' };
}

export function claimIntegration(repoId: string): ResourceClaimSpec {
  return { resourceKey: `integration:${repoId}`, mode: 'exclusive' };
}

export function claimRelease(repoId: string): ResourceClaimSpec {
  return { resourceKey: `release:${repoId}`, mode: 'exclusive' };
}

export function claimRemoteMutation(repoId: string): ResourceClaimSpec {
  return { resourceKey: `remote:${repoId}`, mode: 'exclusive' };
}

export function claimWorkspaceWrite(checkoutId?: string): ResourceClaimSpec {
  return { resourceKey: `workspace:${checkoutScope(checkoutId)}`, mode: 'write' };
}

export function claimHeavyCheck(repoId: string): ResourceClaimSpec {
  return { resourceKey: `heavy-check:${repoId}`, mode: 'exclusive' };
}

function claimHostService(serviceKey: string, mode: 'read' | 'write' = 'write'): ResourceClaimSpec {
  const normalized = serviceKey.trim().replace(/\s+/g, '-').slice(0, 240) || 'global';
  return { resourceKey: `host-service:${normalized}`, mode };
}

const BROWSER_APPLESCRIPT_TARGETS = new Set(['google chrome', 'vivaldi']);
const UNSAFE_BROWSER_APPLESCRIPT = /\b(?:do\s+shell\s+script|open\s+for\s+access|set\s+eof|posix\s+file|path\s+to|load\s+script|run\s+script|use\s+framework|current\s+application)\b/i;

function browserAppleScriptHeredocClaims(script: string): ResourceClaimSpec[] | undefined {
  const lines = script.trim().split(/\r?\n/);
  const first = lines[0]?.trim() ?? '';
  const header = /^(?:\/usr\/bin\/)?osascript\s+<<-?\s*(?:['"]([a-zA-Z_][a-zA-Z0-9_-]*)['"]|([a-zA-Z_][a-zA-Z0-9_-]*))\s*$/.exec(first);
  if (!header) return undefined;
  const marker = header[1] ?? header[2];
  if (!marker) return undefined;
  let end = lines.length - 1;
  while (end > 0 && !(lines[end] ?? '').trim()) end -= 1;
  if ((lines[end] ?? '').trim() !== marker) return undefined;
  const body = lines.slice(1, end).join('\n');
  if (!body.trim() || UNSAFE_BROWSER_APPLESCRIPT.test(body)) return undefined;
  const targets = [...body.matchAll(/\btell\s+application\s+"([^"]+)"/gi)]
    .map((match) => match[1]?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value));
  if (targets.length === 0 || targets.some((target) => !BROWSER_APPLESCRIPT_TARGETS.has(target))) return undefined;
  const uniqueTargets = [...new Set(targets)];
  if (uniqueTargets.length !== 1) return undefined;
  return [claimHostService(`osascript:${uniqueTargets[0]}`, 'write')];
}

function iosSimulatorTestCommandClaims(
  command: string | readonly string[],
  repoId: string,
  checkoutId?: string,
): ResourceClaimSpec[] | undefined {
  const canonical = normalizeRepositoryCommand(command);
  const isTestAction = (text: string): boolean => /(?:^|\s)(?:test|test-without-building)(?:\s|$)/i.test(text);
  let matches = false;
  if (canonical.kind === 'argv') {
    const program = (canonical.executable ?? '').split(/[\\/]/).at(-1)?.toLowerCase();
    if (program === 'xcodebuild') matches = (canonical.args ?? []).some((arg) => /^(?:test|test-without-building)$/i.test(arg));
    if (!matches) {
      const wrapped = fixedShellWrapperCommand([canonical.executable ?? '', ...(canonical.args ?? [])]);
      matches = Boolean(wrapped && /\bxcodebuild\b/i.test(wrapped) && isTestAction(wrapped));
    }
  } else {
    const shell = canonical.shellCommand ?? '';
    matches = /\bxcodebuild\b/i.test(shell) && isTestAction(shell);
  }
  if (!matches) return undefined;
  return normalizeClaims([
    claimWorkspaceRead(checkoutId),
    claimBuildCacheWrite(repoId),
    claimHostService('ios-simulator-test', 'write'),
  ]);
}

function localHttpServerClaims(command: string | readonly string[]): ResourceClaimSpec[] | undefined {
  const canonical = normalizeRepositoryCommand(command);
  if (canonical.kind !== 'argv') return undefined;
  const program = (canonical.executable ?? '').split(/[\\/]/).at(-1)?.toLowerCase();
  if (program !== 'python' && program !== 'python3') return undefined;
  const args = canonical.args ?? [];
  if (args[0] !== '-m' || args[1] !== 'http.server' || args.includes('--cgi')) return undefined;
  let bind = '0.0.0.0';
  let port = '8000';
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--bind') { bind = args[index + 1] ?? bind; index += 1; continue; }
    if (arg === '--directory' || arg === '-d' || arg === '--protocol') { index += 1; continue; }
    if (!arg.startsWith('-') && /^\d{1,5}$/.test(arg)) port = arg;
  }
  return [claimHostService(`tcp-listen:${bind}:${port}`, 'write')];
}

function loopbackCurlClaims(command: string | readonly string[], repoId: string): ResourceClaimSpec[] | undefined {
  const canonical = normalizeRepositoryCommand(command);
  if (canonical.kind !== 'argv') return undefined;
  const program = (canonical.executable ?? '').split(/[\\/]/).at(-1)?.toLowerCase();
  if (program !== 'curl') return undefined;
  const args = canonical.args ?? [];
  if (args.some((arg) => /^(?:-X|--request|-d|--data|--data-raw|--data-binary|-F|--form|-T|--upload-file|-o|--output|-O|--remote-name)$/i.test(arg))) return undefined;
  const explicitMethodIndex = args.findIndex((arg) => arg === '-X' || arg === '--request');
  if (explicitMethodIndex >= 0 && !/^(?:GET|HEAD)$/i.test(args[explicitMethodIndex + 1] ?? '')) return undefined;
  const urls = args.filter((arg) => /^https?:\/\//i.test(arg));
  if (urls.length === 0 || urls.some((url) => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return !['127.0.0.1', 'localhost', '::1'].includes(host);
    } catch { return true; }
  })) return undefined;
  return [claimNetwork(repoId, 'read')];
}

function simpleViteScript(script: string): boolean {
  const normalized = script.trim();
  if (!normalized || /[;&|`$<>\n\r]/.test(normalized)) return false;
  return /^(?:(?:\.\/)?node_modules\/.bin\/)?vite(?:\s|$)/.test(normalized);
}

function viteServiceClaims(
  command: string | readonly string[],
  repoId: string,
  checkoutId?: string,
  repoRoot?: string,
): ResourceClaimSpec[] | undefined {
  const canonical = normalizeRepositoryCommand(command);
  if (canonical.kind !== 'argv') return undefined;
  const program = (canonical.executable ?? '').split(/[\\/]/).at(-1)?.toLowerCase();
  const args = canonical.args ?? [];
  let vite = program === 'vite';
  if (!vite && (program === 'npx' || program === 'bunx') && args[0]?.toLowerCase() === 'vite') vite = true;
  if (!vite && program === 'bun' && args[0]?.toLowerCase() === 'x' && args[1]?.toLowerCase() === 'vite') vite = true;
  if (!vite && repoRoot && ['npm', 'pnpm', 'yarn', 'bun'].includes(program ?? '')) {
    const runIndex = args[0]?.toLowerCase() === 'run' ? 1 : program === 'yarn' ? 0 : -1;
    const scriptName = runIndex >= 0 ? args[runIndex]?.toLowerCase() : undefined;
    if (scriptName === 'dev') {
      try {
        const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
        const script = typeof pkg.scripts?.dev === 'string' ? pkg.scripts.dev : '';
        vite = simpleViteScript(script);
      } catch {
        vite = false;
      }
    }
  }
  if (!vite) return undefined;
  return normalizeClaims([
    claimBuildCacheWrite(repoId),
    claimHostService(`vite:${checkoutScope(checkoutId)}`, 'write'),
  ]);
}

const HOMEBREW_HOST_MUTATION_SUBCOMMANDS = new Set([
  'install',
  'uninstall',
  'reinstall',
  'upgrade',
  'update',
  'cleanup',
  'autoremove',
  'tap',
  'untap',
]);

function homebrewHostMutationClaims(command: string | readonly string[]): ResourceClaimSpec[] | undefined {
  const canonical = normalizeRepositoryCommand(command);
  let words: string[];

  if (canonical.kind === 'argv') {
    const argv = [canonical.executable ?? '', ...(canonical.args ?? [])];
    const wrapped = fixedShellWrapperCommand(argv);
    if (wrapped) {
      const segments = shellSegments(wrapped);
      if (segments.length !== 1) return undefined;
      words = shellWordsPreservingQuotes(segments[0]!);
    } else {
      words = argv;
    }
  } else {
    const segments = shellSegments(canonical.shellCommand ?? '');
    if (segments.length !== 1) return undefined;
    words = shellWordsPreservingQuotes(segments[0]!);
  }

  const program = words[0]?.split(/[\\/]/).at(-1)?.toLowerCase();
  if (program !== 'brew') return undefined;
  const subcommand = words[1]?.toLowerCase();
  if (!subcommand || !HOMEBREW_HOST_MUTATION_SUBCOMMANDS.has(subcommand)) return undefined;

  // Keep local formula files, Brewfiles, and other path-shaped operands under
  // conservative repository workspace coordination. Formula/cask identifiers
  // are deliberately narrow so an ambiguous command still fails closed.
  const positional = words.slice(2).filter((arg) => arg && !arg.startsWith('-'));
  if (positional.some((arg) => !/^[A-Za-z0-9@+_.-]+$/.test(arg))) return undefined;

  return [claimHostService('package-manager:homebrew', 'write')];
}

function hostOnlyCommandClaims(command: string | readonly string[], repoId: string, checkoutId?: string, repoRoot?: string): ResourceClaimSpec[] | undefined {
  const localServer = localHttpServerClaims(command);
  if (localServer) return localServer;
  const loopbackCurl = loopbackCurlClaims(command, repoId);
  if (loopbackCurl) return loopbackCurl;
  const vite = viteServiceClaims(command, repoId, checkoutId, repoRoot);
  if (vite) return vite;
  const homebrew = homebrewHostMutationClaims(command);
  if (homebrew) return homebrew;
  const canonical = normalizeRepositoryCommand(command);
  if (canonical.kind === 'shell') {
    return browserAppleScriptHeredocClaims(canonical.shellCommand ?? '');
  }
  const argv = [canonical.executable ?? '', ...(canonical.args ?? [])];
  const wrapped = fixedShellWrapperCommand(argv);
  if (wrapped) {
    const browserClaims = browserAppleScriptHeredocClaims(wrapped);
    if (browserClaims) return browserClaims;
  }
  const program = (canonical.executable ?? '').split(/[\\/]/).at(-1)?.toLowerCase();
  const args = canonical.args ?? [];
  if (program === 'launchctl') {
    const subcommand = args[0]?.toLowerCase() ?? '';
    const target = [...args].reverse().find((arg) => arg && !arg.startsWith('-')) ?? subcommand ?? 'global';
    if (['print', 'print-disabled', 'list', 'managerpid', 'manageruid'].includes(subcommand)) {
      return [claimHostService(`launchctl:${target}`, 'read')];
    }
    // launchctl mutates launchd/service state, not the Git checkout. Serialize
    // only operations that address the same host service/domain instead of taking
    // the checkout-wide workspace lease.
    return [claimHostService(`launchctl:${target}`, 'write')];
  }
  if (program === 'open') {
    const positional = args.filter((arg) => arg && !arg.startsWith('-'));
    const uriSchemes = positional.map((arg) => /^([a-z][a-z0-9+.-]*):/i.exec(arg)?.[1]?.toLowerCase());
    if (positional.length > 0 && uriSchemes.every((scheme): scheme is string => Boolean(scheme))) {
      // URI-only `open` targets mutate host application/UI state, not repository
      // files. Persist only the scheme in the resource key so URL paths/queries
      // never become lease metadata.
      return [...new Set(uriSchemes)].map((scheme) => claimHostService(`open:${scheme}`, 'write'));
    }
  }
  return undefined;
}

function claimTemp(checkId: string, repoId: string, scope: 'isolated' | 'shared'): ResourceClaimSpec {
  const identity = checkId.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return { resourceKey: scope === 'shared' ? `temp:${repoId}` : `temp:${repoId}:${identity}`, mode: 'write' };
}

function claimNetwork(repoId: string, mode: 'read' | 'write'): ResourceClaimSpec {
  return { resourceKey: `network:${repoId}`, mode };
}

function staticAnalysisCheckId(checkId: string): boolean {
  const normalized = checkId.trim().toLowerCase();
  if (!normalized.startsWith('package:')) return false;
  return /(?:^|:)(?:type|typecheck|lint|format:check|runtime-architecture|mcp-compatibility|forge-runtime)$/.test(
    normalized.slice('package:'.length),
  );
}

function claimsForDeclaredCheckEffects(
  checkId: string,
  effects: ControllerCheckEffects,
  repoId: string,
  checkoutId?: string,
): ResourceClaimSpec[] {
  const claims: ResourceClaimSpec[] = [];
  const hasDeclaredField = Object.keys(effects).length > 0;
  if (!hasDeclaredField) return [claimWorkspaceWrite(checkoutId)];

  // Missing read scope is unknown, so custom checks fail closed. An explicit
  // reads: [] means the command does not inspect repository content.
  if (effects.reads === undefined) claims.push(claimWorkspaceWrite(checkoutId));
  else for (const path of effects.reads) claims.push(claimPathRead(path, checkoutId));
  for (const path of effects.writes ?? []) claims.push(claimPathWrite(path, checkoutId));

  if (effects.cache === 'read') claims.push(claimBuildCacheRead(repoId));
  if (effects.cache === 'write') claims.push(claimBuildCacheWrite(repoId));
  if (effects.temp) claims.push(claimTemp(checkId, repoId, effects.temp));
  if (effects.git === 'read') claims.push(claimGitIndexRead(checkoutId), claimGitRefsRead(repoId));
  if (effects.git === 'index') claims.push(claimGitIndex(checkoutId));
  if (effects.git === 'refs') claims.push(claimGitRefs(repoId));
  if (effects.git === 'write') claims.push(claimWorkspaceWrite(checkoutId), claimGitIndex(checkoutId), claimGitRefs(repoId));
  if (effects.network) claims.push(claimNetwork(repoId, effects.network));
  for (const service of effects.hostServices ?? []) claims.push(claimHostService(service, 'write'));

  return normalizeClaims(claims, { readOnly: claims.every((claim) => claim.mode === 'read') });
}

function looksLikeBuildOrTest(command: string | readonly string[]): boolean {
  const canonical = normalizeRepositoryCommand(command);
  const buildScript = (value: string | undefined): boolean => /^(?:test(?::.*)?|check(?::.*)?|typecheck|lint(?::.*)?|build(?::.*)?|compile(?::.*)?)$/i.test(value ?? '');
  const base = (value: string | undefined): string => (value ?? '').replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? '';

  if (canonical.kind === 'argv') {
    const program = base(canonical.executable);
    const args = canonical.args ?? [];
    const first = args[0]?.toLowerCase();
    const second = args[1]?.toLowerCase();
    if (program === 'bun') {
      if (first === 'test') return true;
      if (first === 'run') return buildScript(second);
      if (first === 'x') return ['tsc', 'eslint', 'biome', 'pytest'].includes(base(args[1]));
      // `bun <package-script>` is supported, but eval/print source must never be
      // inspected as prose for words such as RegExp.prototype.test.
      return buildScript(first);
    }
    if (program === 'npm' || program === 'pnpm' || program === 'yarn') {
      if (first === 'test') return true;
      if (first === 'run') return buildScript(second);
      return program === 'yarn' && buildScript(first);
    }
    if (program === 'cargo' || program === 'go' || program === 'swift') {
      return ['test', 'check', 'build', 'compile'].includes(first ?? '');
    }
    return ['pytest', 'xcodebuild', 'tsc', 'eslint', 'biome'].includes(program);
  }

  // Shell strings cannot be trusted structurally, so only recognize an actual
  // command/subcommand sequence. Do not scan arbitrary quoted source text.
  const lower = canonical.shellCommand?.toLowerCase() ?? '';
  return /(?:^|[;&|]\s*)(?:bun|npm|pnpm|yarn)\s+(?:test\b|run\s+(?:test|check|typecheck|lint|build|compile)\b)/.test(lower)
    || /(?:^|[;&|]\s*)(?:cargo|go|swift)\s+(?:test|check|build|compile)\b/.test(lower)
    || /(?:^|[;&|]\s*)(?:pytest|xcodebuild|tsc|eslint|biome)\b/.test(lower);
}

/**
 * A typed argv TypeScript --noEmit invocation reads source/config and may still
 * update incremental build metadata. Model that metadata as build-cache rather
 * than claiming the whole checkout as a writer. Shell strings and package-script
 * aliases remain conservative because their real effects are not proven here.
 */
function isTypedTypeScriptNoEmit(command: string | readonly string[]): boolean {
  if (!Array.isArray(command) || command.length === 0) return false;
  const words = command.map((value) => String(value));
  const base = (value: string): string => value.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? '';
  let program = base(words[0] ?? '');
  let args = words.slice(1);
  if (program === 'bun' && args[0]?.toLowerCase() === 'x' && base(args[1] ?? '') === 'tsc') {
    program = 'tsc';
    args = args.slice(2);
  } else if (program === 'npx' && base(args[0] ?? '') === 'tsc') {
    program = 'tsc';
    args = args.slice(1);
  }
  if (program !== 'tsc') return false;
  return args.some((arg) => arg === '--noEmit' || arg.toLowerCase() === '--noemit');
}

function focusedTestRequestsWorkspaceMutation(command: string | readonly string[]): boolean {
  const canonical = normalizeRepositoryCommand(command);
  if (canonical.kind !== 'argv') return true;
  const args = (canonical.args ?? []).map((value) => value.toLowerCase());
  return args.includes('-u')
    || args.includes('--update-snapshots')
    || args.includes('--update-snapshot')
    || args.some((value) => value.startsWith('--update-snapshots='));
}

function extractLikelyPaths(command: string | readonly string[]): string[] {
  const canonical = normalizeRepositoryCommand(command);
  let words: string[];
  if (canonical.kind === 'argv') {
    const program = (canonical.executable ?? '').replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? '';
    const args = [...(canonical.args ?? [])];
    words = [];
    for (let index = 0; index < args.length; index += 1) {
      const word = String(args[index] ?? '');
      if ((program === 'bun' || program === 'node') && ['-e', '--eval', '-p', '--print'].includes(word)) {
        index += 1;
        continue;
      }
      if ((program === 'bun' || program === 'node') && /^(?:--eval|--print)=/.test(word)) continue;
      words.push(word);
    }
  } else {
    words = String(canonical.shellCommand ?? command).split(/\s+/);
  }
  return words.filter((word) => {
    if (!word || word.startsWith('-') || word.includes('\n') || word.includes('\r')) return false;
    if (/\b(?:import|require|const|let|function|return)\b/.test(word) || word.includes('=>')) return false;
    return word.includes('/')
      || word.includes('\\')
      || /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|swift|test|spec|json|md)$/i.test(word);
  }).map((word) => word.replace(/^\.\//, '').replace(/\\/g, '/'));
}

/**
 * Classify resource claims for a repository command without taking whole-repo exclusive locks
 * for ordinary readonly / focused validation commands.
 */
export function claimsForRepositoryCommand(
  command: string | readonly string[],
  repoId: string,
  checkoutId?: string,
  defaultBranch?: string,
  repoRoot?: string,
): ResourceClaimSpec[] {
  const classification = classifyRepositoryCommand(command, defaultBranch);
  const canonical = normalizeRepositoryCommand(command);
  const focused = isFocusedCheckCommand(command);
  const iosSimulatorClaims = iosSimulatorTestCommandClaims(command, repoId, checkoutId);
  if (iosSimulatorClaims) return iosSimulatorClaims;
  const hostClaims = hostOnlyCommandClaims(command, repoId, checkoutId, repoRoot);
  if (hostClaims) return hostClaims;

  if (classification.risk === 'readonly') {
    return [claimWorkspaceRead(checkoutId)];
  }
  if (classification.risk === 'remote_write') {
    return [claimRemoteMutation(repoId), claimGitRefs(repoId)];
  }
  if (classification.risk === 'destructive') {
    return [
      claimWorkspaceWrite(checkoutId),
      claimGitIndex(checkoutId),
      claimGitRefs(repoId),
    ];
  }

  // workspace_write — refine. Typed noEmit may write only incremental metadata,
  // while ordinary focused tests are observation unless snapshot-update mode is
  // explicit. Both can share repository source reads without a workspace writer.
  if (isTypedTypeScriptNoEmit(command)) {
    return [claimWorkspaceRead(checkoutId), claimBuildCacheWrite(repoId)];
  }
  if (focused) {
    if (!focusedTestRequestsWorkspaceMutation(command)) return [claimWorkspaceRead(checkoutId)];
    const claims: ResourceClaimSpec[] = [claimWorkspaceRead(checkoutId)];
    for (const path of extractLikelyPaths(command).slice(0, 16)) claims.push(claimPathWrite(path, checkoutId));
    return normalizeClaims(claims);
  }
  if (looksLikeBuildOrTest(command)) {
    const paths = extractLikelyPaths(command);
    if (paths.length === 0) {
      // Broad or opaque build/test commands may create arbitrary artifacts.
      return [claimWorkspaceWrite(checkoutId), claimBuildCacheWrite(repoId)];
    }
    const claims: ResourceClaimSpec[] = [claimWorkspaceRead(checkoutId), claimBuildCacheWrite(repoId)];
    for (const path of paths.slice(0, 16)) claims.push(claimPathWrite(path, checkoutId));
    return normalizeClaims(claims);
  }

  const program = canonical.kind === 'argv'
    ? (canonical.executable ?? '').split(/[\\/]/).at(-1)?.toLowerCase()
    : undefined;
  const sub = canonical.kind === 'argv' ? canonical.args?.[0]?.toLowerCase() : undefined;
  if (program === 'git') {
    if (sub === 'add' || sub === 'rm' || sub === 'mv' || sub === 'restore' || sub === 'apply') {
      return [claimGitIndex(checkoutId), claimWorkspaceWrite(checkoutId)];
    }
    if (sub === 'commit' || sub === 'merge' || sub === 'rebase' || sub === 'cherry-pick' || sub === 'revert') {
      return [claimGitIndex(checkoutId), claimGitRefs(repoId), claimWorkspaceWrite(checkoutId)];
    }
    if (sub === 'checkout' || sub === 'switch' || sub === 'branch' || sub === 'tag') {
      return [claimGitRefs(repoId), claimWorkspaceWrite(checkoutId)];
    }
  }

  // Unknown mutating command — workspace write, not heavy-check exclusive.
  return [claimWorkspaceWrite(checkoutId)];
}

/**
 * Claims for run_check by check id / command.
 * Only full CI / release / multi-phase checks take heavy-check exclusive.
 */
export function claimsForCheck(
  checkId: string,
  command: readonly string[] | undefined,
  repoId: string,
  checkoutId?: string,
  effects?: ControllerCheckEffects,
): ResourceClaimSpec[] {
  const heavy = /(?:^|:)(?:test(?::coverage)?|check:(?:ci|forge-runtime|public-export|release(?:-[a-z0-9-]+)?))$/.test(checkId)
    || /release|migration|integrate/i.test(checkId);
  const baseClaims = effects
    ? claimsForDeclaredCheckEffects(checkId, effects, repoId, checkoutId)
    : staticAnalysisCheckId(checkId)
      ? [claimWorkspaceRead(checkoutId), claimBuildCacheWrite(repoId)]
      : command && command.length > 0
        ? claimsForRepositoryCommand(command, repoId, checkoutId)
        : [claimWorkspaceWrite(checkoutId)];
  // Heavy-check is an additional cross-check serialization fence, not a
  // substitute for the resources the check actually reads or writes.
  return heavy ? normalizeClaims([claimHeavyCheck(repoId), ...baseClaims]) : baseClaims;
}

export function scopeResourceClaims(
  claims: ResourceClaimSpec[],
  repoId: string,
  checkoutId?: string,
  workId?: string,
): ResourceClaimSpec[] {
  const normalizedWorkId = workId?.trim();
  if (!normalizedWorkId) return claims;
  const normalizedRepoId = repoId.trim();
  const normalizedCheckoutId = checkoutId?.trim();
  if (!normalizedRepoId) throw new Error('RESOURCE_CLAIM_REPOSITORY_REQUIRED');
  if (!normalizedCheckoutId) throw new Error(`RESOURCE_CLAIM_CHECKOUT_REQUIRED: ${normalizedWorkId}`);
  return claims.map((claim) => {
    if (claim.repoId && claim.repoId !== normalizedRepoId) throw new Error('RESOURCE_CLAIM_REPOSITORY_MISMATCH');
    if (claim.checkoutId && claim.checkoutId !== normalizedCheckoutId) throw new Error('RESOURCE_CLAIM_CHECKOUT_MISMATCH');
    if (claim.workId && claim.workId !== normalizedWorkId) throw new Error('RESOURCE_CLAIM_WORK_MISMATCH');
    return {
      ...claim,
      repoId: normalizedRepoId,
      checkoutId: normalizedCheckoutId,
      workId: normalizedWorkId,
    };
  });
}

export function toProcessClaims(claims: ResourceClaimSpec[]): ProcessResourceClaim[] {
  return claims.map((claim) => ({
    resourceKey: claim.resourceKey,
    mode: claim.mode,
    ...(claim.repoId ? { repoId: claim.repoId } : {}),
    ...(claim.checkoutId ? { checkoutId: claim.checkoutId } : {}),
    ...(claim.workId ? { workId: claim.workId } : {}),
  }));
}
