/**
 * Fine-grained resource claims for Process Runtime and MCP operations.
 * Prefer path / git-index / git-refs / build-cache over whole-repo exclusive locks.
 */

import type { ResourceClaimSpec } from '../jobs/types';
import { lstatSync, readFileSync, realpathSync } from 'fs';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import type { ControllerCheckEffects, ControllerCheckExecutionAuthority } from './check-runner';
import {
  classifyRepositoryCommand,
  fixedShellWrapperCommand,
  shellSegments,
  shellWordsPreservingQuotes,
} from '../../../core/repository-command/classification';
import { normalizeRepositoryCommand } from '../../../core/repository-command/normalization';
import { isProtectedRemoteBranchDeletionTarget } from '../../../core/git-branch-policy';
import { isFocusedCheckCommand } from '../thin-harness/execution-router';
import type { ProcessResourceClaim } from './types';
import {
  IOS_SIMULATOR_TEST_RESOURCE,
  iosSimulatorResourceKey,
  normalizeClaimPath,
  normalizeClaims,
} from '../../resources/claims/conflicts';

export const LIVE_DEVICE_ADMISSION_WAIT_MS = 2 * 60 * 60_000;

/** Capacity is separate from permission and exact device ownership. */
export function claimsRequireHostCapacity(
  claims: readonly { resourceKey: string }[],
  command?: string | readonly string[],
): boolean {
  return (
    claims.some(
      (claim) => claim.resourceKey === 'host-service:ios-build' || claim.resourceKey.startsWith('heavy-check:'),
    ) || Boolean(command && looksLikeBuildOrTest(command) && !isFocusedCheckCommand(command))
  );
}

export function claimsRequireLiveDeviceAdmission(claims: readonly { resourceKey: string }[]): boolean {
  return claims.some(
    (claim) =>
      claim.resourceKey === 'host-service:ios-build' ||
      claim.resourceKey === IOS_SIMULATOR_TEST_RESOURCE ||
      claim.resourceKey.startsWith(`${IOS_SIMULATOR_TEST_RESOURCE}:udid:`) ||
      claim.resourceKey === 'host-service:android-emulator-test',
  );
}

function checkoutScope(checkoutId?: string, repoId?: string): string {
  const checkout = checkoutId?.trim();
  if (checkout) return checkout;
  const repository = repoId?.trim();
  if (repository) return `repository-${repository.replace(/[^a-zA-Z0-9._-]+/g, '-')}`;
  throw new Error('RESOURCE_CLAIM_PLACEMENT_REQUIRED');
}

/**
 * Validation reads a candidate source tree but must not own or lock it.
 * Governed gates verify the source digest before accepting their receipt; if a
 * concurrent edit changes that digest, the result is stale and must be rerun.
 */
export function claimValidationObservation(checkoutId?: string, repoId?: string): ResourceClaimSpec {
  return { resourceKey: `validation-input:${checkoutScope(checkoutId, repoId)}`, mode: 'read' };
}

export function claimPathWrite(path: string, checkoutId?: string, repoId?: string): ResourceClaimSpec | undefined {
  const normalized = normalizeClaimPath(path);
  // An unprovable path takes no source ownership. Concurrent edits are
  // reconciled by the model against the latest source (#713).
  if (!normalized) return undefined;
  return { resourceKey: `path:${checkoutScope(checkoutId, repoId)}:${normalized}`, mode: 'write' };
}

export function claimBuildCacheRead(repoId: string): ResourceClaimSpec {
  return { resourceKey: `build-cache:${repoId}`, mode: 'read' };
}

export function claimBuildCacheWrite(repoId: string): ResourceClaimSpec {
  return { resourceKey: `build-cache:${repoId}`, mode: 'write' };
}

export function claimGitIndexRead(checkoutId?: string, repoId?: string): ResourceClaimSpec {
  return { resourceKey: `git-index:${checkoutScope(checkoutId, repoId)}`, mode: 'read' };
}

export function claimGitIndex(checkoutId?: string, repoId?: string): ResourceClaimSpec {
  return { resourceKey: `git-index:${checkoutScope(checkoutId, repoId)}`, mode: 'exclusive' };
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

export function claimRelease(_repoId: string): ResourceClaimSpec {
  return { resourceKey: 'release:runtime-authority', mode: 'exclusive' };
}

/** Exact source-path claims for every provable path; unprovable paths take none. */
export function claimPathWrites(paths: readonly string[], checkoutId?: string, repoId?: string): ResourceClaimSpec[] {
  return paths.flatMap((path) => claimPathWrite(path, checkoutId, repoId) ?? []);
}

export function claimHeavyCheck(repoId: string): ResourceClaimSpec {
  return { resourceKey: `heavy-check:${repoId}`, mode: 'exclusive' };
}

function claimHostService(serviceKey: string, mode: 'read' | 'write' = 'write'): ResourceClaimSpec {
  const normalized = serviceKey.trim().replace(/\s+/g, '-').slice(0, 240) || 'global';
  return { resourceKey: `host-service:${normalized}`, mode };
}

function xcodeBuildCacheClaims(
  command: string | readonly string[],
  repoId: string,
  cwd?: string,
): ResourceClaimSpec[] | undefined {
  const canonical = normalizeRepositoryCommand(command);
  let words: readonly string[];
  let directory = cwd;
  const wrapped =
    canonical.kind === 'argv'
      ? fixedShellWrapperCommand([canonical.executable!, ...(canonical.args ?? [])])
      : undefined;
  if (canonical.kind === 'shell' || wrapped) {
    const shell = wrapped ?? canonical.shellCommand!;
    // Dynamic paths, redirections and compound build scripts cannot prove one cache.
    if (/[`$<>\n\r*?{}]/.test(shell)) return undefined;
    const segments = shellSegments(shell);
    if (segments.length === 2) {
      const cd = shellWordsPreservingQuotes(segments[0]!);
      if (
        !shell.includes('&&') ||
        /[;|]/.test(shell) ||
        cd.length !== 2 ||
        cd[0] !== 'cd' ||
        !directory ||
        cd[1]!.startsWith('~') ||
        cd[1]!.split(/[\\/]/).includes('..')
      )
        return undefined;
      try {
        directory = realpathSync(resolve(realpathSync(directory), cd[1]!));
      } catch {
        return undefined;
      }
    } else if (segments.length !== 1) return undefined;
    words = shellWordsPreservingQuotes(segments.at(-1)!);
  } else words = [canonical.executable!, ...(canonical.args ?? [])];
  if (basename(words[0] ?? '') === 'xcrun' && words[1] === 'xcodebuild') words = words.slice(1);
  if (basename(words[0] ?? '') !== 'xcodebuild') return undefined;
  // Output/cache overrides can escape DerivedData and require the broad fence.
  if (
    words.some(
      (word) =>
        /^[A-Z0-9_]*(?:ROOT|_DIR|_PATH|CACHE)[A-Z0-9_]*=/.test(word) ||
        [
          'archive',
          'install',
          'installsrc',
          '-exportArchive',
          '-create-xcframework',
          '-archivePath',
          '-resultBundlePath',
          '-clonedSourcePackagesDirPath',
          '-packageCachePath',
          '-xcconfig',
        ].includes(word),
    )
  )
    return undefined;
  const indexes = words.flatMap((word, index) => (word === '-derivedDataPath' ? [index] : []));
  if (indexes.length !== 1) return undefined;
  const path = words[indexes[0]! + 1];
  if (
    !path ||
    path.startsWith('-') ||
    /[\0\r\n]/.test(path) ||
    path.startsWith('~') ||
    path.split(/[\\/]/).includes('..') ||
    (!isAbsolute(path) && !directory)
  )
    return undefined;
  // Resolve existing symlink ancestors even when Xcode has not created the cache.
  let ancestor: string;
  try {
    ancestor = isAbsolute(path) ? resolve(path) : resolve(realpathSync(directory!), path);
  } catch {
    return undefined;
  }
  const suffix: string[] = [];
  for (;;) {
    try {
      ancestor = realpathSync(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) return undefined;
      // A dangling symlink is not a proven nonexistent directory suffix.
      try {
        if (lstatSync(ancestor).isSymbolicLink()) return undefined;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      }
      suffix.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
  // Case/Unicode folding may over-serialize case-sensitive volumes, never split
  // two spellings of the same default macOS cache into independent writers.
  const physical = join(ancestor, ...suffix)
    .replace(/\\/g, '/')
    .normalize('NFD')
    .toLowerCase();
  return [
    claimBuildCacheRead(repoId),
    { resourceKey: `build-cache:${repoId}:xcode-derived-data:${physical}`, mode: 'write' },
  ];
}

const BROWSER_APPLESCRIPT_TARGETS = new Set(['google chrome', 'vivaldi']);
const UNSAFE_BROWSER_APPLESCRIPT =
  /\b(?:do\s+shell\s+script|open\s+for\s+access|set\s+eof|posix\s+file|path\s+to|load\s+script|run\s+script|use\s+framework|current\s+application)\b/i;

function browserAppleScriptHeredocClaims(script: string): ResourceClaimSpec[] | undefined {
  const lines = script.trim().split(/\r?\n/);
  const first = lines[0]?.trim() ?? '';
  const header =
    /^(?:\/usr\/bin\/)?osascript\s+<<-?\s*(?:['"]([a-zA-Z_][a-zA-Z0-9_-]*)['"]|([a-zA-Z_][a-zA-Z0-9_-]*))\s*$/.exec(
      first,
    );
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

function shellXcodebuildCommands(shell: string): string[] {
  // Inspect executable command positions, not arbitrary words in a shell
  // script, heredoc, grep pattern or generated source payload. Otherwise a
  // TypeScript test containing "xcodebuild test" monopolizes iOS hardware.
  return shellSegments(shell)
    .flatMap((segment) => segment.split(/\r?\n/))
    .map((segment) => segment.trim())
    .filter((segment) => {
      const words = shellWordsPreservingQuotes(segment);
      let index = 0;
      // Literal shell assignments and env are execution prefixes, unlike
      // echo/grep/source text. Keep real native builds under the host lease.
      if (basename(words[index] ?? '') === 'env') {
        index += 1;
        if (words[index] === '--') index += 1;
      }
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) index += 1;
      return (
        basename(words[index] ?? '') === 'xcodebuild' ||
        (basename(words[index] ?? '') === 'xcrun' && words[index + 1] === 'xcodebuild')
      );
    });
}

/**
 * Select a device-specific claim only for an unambiguous literal xcodebuild
 * -destination id=<UDID>. Names, placeholders, multiple destinations or
 * opaque scripts keep the host-wide simulator fence.
 */
function exactXcodebuildSimulatorUdid(command: string | readonly string[]): string | undefined {
  const canonical = normalizeRepositoryCommand(command);
  const argv = canonical.kind === 'argv' ? [canonical.executable ?? '', ...(canonical.args ?? [])] : [];
  const wrapped = canonical.kind === 'argv' ? fixedShellWrapperCommand(argv) : undefined;
  const commands = wrapped
    ? shellXcodebuildCommands(wrapped)
    : canonical.kind === 'argv'
      ? [argv.join(' ')]
      : shellXcodebuildCommands(canonical.shellCommand ?? '');
  if (commands.length !== 1) return undefined;
  const words = canonical.kind === 'argv' && !wrapped ? argv : shellWordsPreservingQuotes(commands[0]!);
  const destinations = words.flatMap((word, index) => (word === '-destination' ? [words[index + 1] ?? ''] : []));
  if (destinations.length !== 1) return undefined;
  const normalized = destinations[0]!.replace(/^['"]|['"]$/g, '');
  const match = /(?:^|,)id=([0-9a-f-]+)(?:,|$)/i.exec(normalized);
  if (!match) return undefined;
  // Guard against a physical iPhone selector disguised as a destination.
  if (/platform=/i.test(normalized) && !/(?:^|,)platform=iOS Simulator(?:,|$)/i.test(normalized)) return undefined;
  const key = iosSimulatorResourceKey(match[1]);
  return key === IOS_SIMULATOR_TEST_RESOURCE ? undefined : match[1];
}

function iosSimulatorTestCommandClaims(
  command: string | readonly string[],
  repoId: string,
  checkoutId?: string,
  cacheClaims: ResourceClaimSpec[] = [claimBuildCacheWrite(repoId)],
): ResourceClaimSpec[] | undefined {
  const canonical = normalizeRepositoryCommand(command);
  const isTestAction = (text: string): boolean => /(?:^|\s)(?:test|test-without-building)(?:\s|$)/i.test(text);
  let matches = false;
  if (canonical.kind === 'argv') {
    const program = (canonical.executable ?? '').split(/[\\/]/).at(-1)?.toLowerCase();
    if (program === 'xcodebuild')
      matches = (canonical.args ?? []).some((arg) => /^(?:test|test-without-building)$/i.test(arg));
    if (!matches) {
      const wrapped = fixedShellWrapperCommand([canonical.executable ?? '', ...(canonical.args ?? [])]);
      matches = Boolean(wrapped && shellXcodebuildCommands(wrapped).some(isTestAction));
    }
  } else {
    const shell = canonical.shellCommand ?? '';
    matches = shellXcodebuildCommands(shell).some(isTestAction);
  }
  if (!matches) return undefined;
  return normalizeClaims([
    claimValidationObservation(checkoutId, repoId),
    ...cacheClaims,
    { resourceKey: iosSimulatorResourceKey(exactXcodebuildSimulatorUdid(command)), mode: 'write' },
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
    if (arg === '--bind') {
      bind = args[index + 1] ?? bind;
      index += 1;
      continue;
    }
    if (arg === '--directory' || arg === '-d' || arg === '--protocol') {
      index += 1;
      continue;
    }
    if (!arg.startsWith('-') && /^\d{1,5}$/.test(arg)) port = arg;
  }
  return [claimHostService(`tcp-listen:${bind}:${port}`, 'write')];
}

/** Only known stdout-only HTTP probes avoid source-file ownership (#713).
 * A typed argv shape prevents shell redirection or interpolation; unknown
 * options may write files and must retain checkout exclusion. This supersedes
 * the old loopback-only heuristic, which missed --output=FILE forms.
 */
function stdoutOnlyCurlClaims(command: string | readonly string[]): ResourceClaimSpec[] | undefined {
  const canonical = normalizeRepositoryCommand(command);
  if (canonical.kind !== 'argv' || basename(canonical.executable ?? '').toLowerCase() !== 'curl') return undefined;
  const args = canonical.args ?? [];
  const urls: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (/^https?:\/\//i.test(arg)) {
      urls.push(arg);
      continue;
    }
    if (/^-[sSfLIv]+$/.test(arg)) continue;
    if (
      ['--silent', '--show-error', '--fail', '--fail-with-body', '--location', '--head', '--compressed'].includes(arg)
    )
      continue;
    if (['--max-time', '--connect-timeout'].includes(arg)) {
      const number = args[index + 1];
      if (!number || !/^\d+(?:\.\d+)?$/.test(number)) return undefined;
      index += 1;
      continue;
    }
    if (arg === '--url') {
      const url = args[index + 1];
      if (!url || !/^https?:\/\//i.test(url)) return undefined;
      urls.push(url);
      index += 1;
      continue;
    }
    return undefined;
  }
  if (urls.length !== 1) return undefined;
  try {
    const url = new URL(urls[0]!);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return undefined;
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase());
    return [claimHostService(loopback ? 'tcp-client:loopback' : 'tcp-client:http', 'read')];
  } catch {
    return undefined;
  }
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
        const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
          scripts?: Record<string, unknown>;
        };
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
    claimHostService(`vite:${checkoutScope(checkoutId, repoId)}`, 'write'),
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

function hostOnlyCommandClaims(
  command: string | readonly string[],
  repoId: string,
  checkoutId?: string,
  repoRoot?: string,
): ResourceClaimSpec[] | undefined {
  const localServer = localHttpServerClaims(command);
  if (localServer) return localServer;
  const stdoutCurl = stdoutOnlyCurlClaims(command);
  if (stdoutCurl) return stdoutCurl;
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

function claimTemp(
  checkId: string,
  repoId: string,
  scope: 'isolated' | 'shared',
  checkoutId?: string,
): ResourceClaimSpec {
  const identity = checkId.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const placement = checkoutScope(checkoutId, repoId);
  return {
    resourceKey: scope === 'shared' ? `temp:${placement}:shared` : `temp:${placement}:${identity}`,
    mode: 'write',
  };
}

function staticAnalysisCheckId(checkId: string): boolean {
  const normalized = checkId.trim().toLowerCase();
  if (!normalized.startsWith('package:')) return false;
  return /(?:^|:)(?:type|typecheck|lint|format:check)$/.test(normalized.slice('package:'.length));
}

function claimsForDeclaredCheckEffects(
  checkId: string,
  effects: ControllerCheckEffects,
  repoId: string,
  checkoutId?: string,
): ResourceClaimSpec[] {
  const claims: ResourceClaimSpec[] = [];
  const hasDeclaredField = Object.keys(effects).length > 0;
  if (!hasDeclaredField) return [];

  // Reading source never grants ownership, and undeclared output scope takes
  // no checkout-wide writer (#713).
  if (effects.reads && effects.reads.length > 0) claims.push(claimValidationObservation(checkoutId, repoId));
  claims.push(...claimPathWrites(effects.writes ?? [], checkoutId, repoId));

  if (effects.cache === 'read') claims.push(claimBuildCacheRead(repoId));
  if (effects.cache === 'write') claims.push(claimBuildCacheWrite(repoId));
  if (effects.temp) claims.push(claimTemp(checkId, repoId, effects.temp, checkoutId));
  if (effects.git === 'read') claims.push(claimGitIndexRead(checkoutId, repoId), claimGitRefsRead(repoId));
  if (effects.git === 'index') claims.push(claimGitIndex(checkoutId, repoId));
  if (effects.git === 'refs') claims.push(claimGitRefs(repoId));
  if (effects.git === 'write') claims.push(claimGitIndex(checkoutId, repoId), claimGitRefs(repoId));
  // A generic network bit has no concrete endpoint/provider identity. Checks
  // that need serialization must name the real shared target in hostServices.
  for (const service of effects.hostServices ?? []) claims.push(claimHostService(service, 'write'));

  return normalizeClaims(claims, { readOnly: claims.every((claim) => claim.mode === 'read') });
}

export function looksLikeBuildOrTest(command: string | readonly string[]): boolean {
  const canonical = normalizeRepositoryCommand(command);
  const buildScript = (value: string | undefined): boolean =>
    /^(?:test(?::.*)?|check(?::.*)?|typecheck|lint(?::.*)?|build(?::.*)?|compile(?::.*)?)$/i.test(value ?? '');
  const base = (value: string | undefined): string =>
    (value ?? '').replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? '';

  if (canonical.kind === 'argv') {
    const program = base(canonical.executable);
    const args = canonical.args ?? [];
    const wrapped = fixedShellWrapperCommand([canonical.executable!, ...args]);
    if (wrapped) return looksLikeBuildOrTest(wrapped);
    if (program === 'xcrun' && args[0] === 'xcodebuild') return true;
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
  return (
    /(?:^|[;&|]\s*)(?:bun|npm|pnpm|yarn)\s+(?:test\b|run\s+(?:test|check|typecheck|lint|build|compile)\b)/.test(
      lower,
    ) ||
    /(?:^|[;&|]\s*)(?:cargo|go|swift)\s+(?:test|check|build|compile)\b/.test(lower) ||
    /(?:^|[;&|]\s*)(?:pytest|xcodebuild|tsc|eslint|biome)\b/.test(lower)
  );
}

/**
 * True when the command is a single argv-like invocation without shell
 * composition, redirection or interpolation. Soft claim narrowing (#713) is
 * only safe for that shape unless every composed segment is also pure
 * build/test validation (see isPureBuildOrTestComposition).
 */
function isSimpleNonComposedCommand(command: string | readonly string[]): boolean {
  const canonical = normalizeRepositoryCommand(command);
  const shell =
    canonical.kind === 'shell'
      ? canonical.shellCommand
      : fixedShellWrapperCommand([canonical.executable!, ...(canonical.args ?? [])]);
  if (shell === undefined) return true;
  if (/[;&|<>\x60$\n\r]/.test(shell)) return false;
  return shellSegments(shell).length === 1;
}

/** `set -euo pipefail` and similar option-only preludes do not mutate the checkout. */
function isShellOptionPrelude(segment: string): boolean {
  const words = shellWordsPreservingQuotes(segment);
  if (words.length === 0) return false;
  const program = words[0]!.toLowerCase();
  if ((program === ':' || program === 'true') && words.length === 1) return true;
  if (program !== 'set' || words.length < 2) return false;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === '-o' || word === '+o') {
      if (index + 1 >= words.length) return false;
      index += 1;
      continue;
    }
    if (!/^[-+][a-zA-Z]+$/.test(word)) return false;
    // `set -euo pipefail`: a flag cluster ending in `o` consumes the option name.
    if (/[+-][a-zA-Z]*o$/.test(word) && index + 1 < words.length && !/^[-+]/.test(words[index + 1]!)) {
      index += 1;
    }
  }
  return true;
}

function segmentHasFileRedirection(segment: string): boolean {
  return /(?:^|[^>&])>(?!&)|(?:^|[^<&])<(?!&)/.test(segment);
}

/** This repository-owned architecture scanner only reads source; no arbitrary Node script inherits this claim. */
function isKnownReadOnlyArchitectureCheck(segment: string): boolean {
  const words = shellWordsPreservingQuotes(segment);
  return words.length === 2 && words[0] === 'node' && words[1] === 'scripts/check-runtime-architecture.mjs';
}

/** A bounded post-validation Git observation does not mutate the checkout.
 * Restrict this to exact command shapes: arbitrary Git flags may invoke
 * external helpers or write output and are not source-read evidence (#713).
 */
function isKnownReadOnlyGitValidationTail(segment: string): boolean {
  if (/[`$<>&|;\\\n\r]/.test(segment)) return false;
  const words = shellWordsPreservingQuotes(segment);
  if (words[0] !== 'git') return false;
  const args = words.slice(1);
  return (
    (args[0] === 'status' &&
      (args.length === 1 || (args.length === 2 && ['--short', '--porcelain', '--porcelain=v1'].includes(args[1]!)))) ||
    (args.length === 2 && args[0] === 'diff' && args[1] === '--check') ||
    (args.length === 2 && args[0] === 'rev-parse' && args[1] === 'HEAD')
  );
}

/**
 * Pure validation composition may observe source + shared build cache without a
 * checkout-wide writer (#713). Any non-build segment, file redirection, or
 * emitting `tsc` keeps the conservative fence.
 */
function isPureBuildOrTestComposition(command: string | readonly string[]): boolean {
  if (!looksLikeBuildOrTest(command) || isPotentiallyEmittingTypeScript(command)) return false;
  if (isSimpleNonComposedCommand(command)) return true;

  const canonical = normalizeRepositoryCommand(command);
  const shell =
    canonical.kind === 'shell'
      ? canonical.shellCommand
      : fixedShellWrapperCommand([canonical.executable!, ...(canonical.args ?? [])]);
  if (shell === undefined) return true;

  const segments = shellSegments(shell);
  if (segments.length === 0) return false;
  let sawValidation = false;
  for (const segment of segments) {
    if (isShellOptionPrelude(segment)) continue;
    if (segmentHasFileRedirection(segment)) return false;
    if (isKnownReadOnlyGitValidationTail(segment)) continue;
    if (
      !isKnownReadOnlyArchitectureCheck(segment) &&
      (!looksLikeBuildOrTest(segment) || isPotentiallyEmittingTypeScript(segment))
    )
      return false;
    sawValidation = true;
  }
  return sawValidation;
}

/** A single source-validation command may redirect stdout to one literal
 * repository-local file without owning every source file (#713). Compound
 * shells and nonliteral destinations remain on the conservative path.
 */
function scopedValidationLogOutput(
  command: string | readonly string[],
  repoId: string,
  checkoutId?: string,
): ResourceClaimSpec[] | undefined {
  const canonical = normalizeRepositoryCommand(command);
  const shell =
    canonical.kind === 'shell'
      ? canonical.shellCommand
      : fixedShellWrapperCommand([canonical.executable!, ...(canonical.args ?? [])]);
  if (!shell) return undefined;
  const match = /^(.*?)\s+>>?\s*([^\s;&|<>]+)(?:\s+2>&1)?\s*$/.exec(shell);
  if (!match) return undefined;
  const sourceCommand = match[1]!;
  const output = match[2]!;
  const runner = shellWordsPreservingQuotes(sourceCommand)[0]?.toLowerCase();
  if (
    !['bun', 'npm', 'pnpm', 'yarn'].includes(runner ?? '') ||
    /[;&|<>`$\n\r]/.test(sourceCommand) ||
    /[;&|<>`$*?\[\]{}\n\r]/.test(output) ||
    /(?:^|\s)--update-snapshots?(?:\s|=|$)/.test(sourceCommand) ||
    normalizeClaimPath(output) === null ||
    !isPureBuildOrTestComposition(sourceCommand)
  )
    return undefined;
  return normalizeClaims([
    claimValidationObservation(checkoutId, repoId),
    claimBuildCacheWrite(repoId),
    claimPathWrite(output, checkoutId, repoId)!,
  ]);
}

/**
 * Emitting `tsc` (including bun x / npx wrappers) can write `.js` beside sources.
 * Soft observation claims are reserved for `--noEmit` via isTypedTypeScriptNoEmit.
 */
function isPotentiallyEmittingTypeScript(command: string | readonly string[]): boolean {
  if (isTypedTypeScriptNoEmit(command)) return false;
  if (!Array.isArray(command) || command.length === 0) {
    const lower = String(command).toLowerCase();
    return /(?:^|[;&|]\s*)(?:bun\s+x\s+|npx\s+)?tsc\b/.test(lower);
  }
  const words = command.map((value) => String(value));
  const base = (value: string): string => value.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? '';
  const program = base(words[0] ?? '');
  if (program === 'bun' && words[1]?.toLowerCase() === 'x' && base(words[2] ?? '') === 'tsc') return true;
  if (program === 'npx' && base(words[1] ?? '') === 'tsc') return true;
  return program === 'tsc';
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
  return (
    args.includes('-u') ||
    args.includes('--update-snapshots') ||
    args.includes('--update-snapshot') ||
    args.some((value) => value.startsWith('--update-snapshots='))
  );
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
  return words
    .filter((word) => {
      if (!word || word.startsWith('-') || word.includes('\n') || word.includes('\r')) return false;
      if (/\b(?:import|require|const|let|function|return)\b/.test(word) || word.includes('=>')) return false;
      return (
        word.includes('/') ||
        word.includes('\\') ||
        /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|swift|test|spec|json|md)$/i.test(word)
      );
    })
    .map((word) => word.replace(/^\.\//, '').replace(/\\/g, '/'));
}

/**
 * Host-wide validation device identity. Pure build/unit checks do not acquire
 * this claim; only live simulator/emulator journeys consume a device slot.
 * Use the same keys as native xcodebuild and declared check hostServices.
 */
function validationDeviceClaims(command: string | readonly string[]): ResourceClaimSpec[] {
  const canonical = normalizeRepositoryCommand(command);
  const wrapped =
    canonical.kind === 'argv'
      ? fixedShellWrapperCommand([canonical.executable ?? '', ...(canonical.args ?? [])])
      : undefined;
  const words = wrapped
    ? shellWordsPreservingQuotes(wrapped)
    : canonical.kind === 'argv'
      ? [canonical.executable ?? '', ...(canonical.args ?? [])]
      : shellWordsPreservingQuotes(canonical.shellCommand ?? '');
  const scripts = words.map((word) => word.split('/').at(-1) ?? word);
  const androidIndex = scripts.indexOf('run_android_check.sh');
  if (androidIndex >= 0) {
    return /^(fast-journey|integration|performance)$/.test(words[androidIndex + 1] ?? '')
      ? [claimHostService('android-emulator-test')]
      : [];
  }
  const layerIndex = scripts.indexOf('run_ios_test_layer.sh');
  if (layerIndex >= 0) {
    return /^(fast-journey|integration-consistency|medication-long-journey|destructive-model|performance-critical|ui-geometry|all)$/.test(
      words[layerIndex + 1] ?? '',
    )
      ? [claimHostService('ios-simulator-test')]
      : [];
  }
  const iosLiveScripts = new Set([
    'run_ios_owner_test.sh',
    'run_ios_test_profile.sh',
    'run_ios_performance_tests.sh',
    'run_medication_long_journeys.sh',
    'run_medication_state_model_tests.sh',
    'run_cross_domain_state_model_tests.sh',
    'verify-runtime-history-queue.sh',
    'verify-medication-property-tests.sh',
    'release_preflight_ios.sh',
    'smoke_preflight_ios.sh',
    'verify_medication_v2_install_matrix.sh',
  ]);
  return scripts.some((script) => iosLiveScripts.has(script)) ? [claimHostService('ios-simulator-test')] : [];
}

/**
 * A literal, exact-SHA CAS deletion of one non-protected remote review branch
 * has no checkout/index/local-ref writer. Keep opaque push/shell commands on
 * their existing broad gate, and leave authorization/classification unchanged.
 */
function exactLeasedRemoteReviewBranchDeletion(
  command: string | readonly string[],
  defaultBranch?: string,
): string | undefined {
  const canonical = normalizeRepositoryCommand(command);
  if (canonical.kind !== 'argv' || basename(canonical.executable ?? '').toLowerCase() !== 'git') return undefined;
  const args = canonical.args ?? [];
  if (args[0] !== 'push') return undefined;
  const options = args.slice(1);
  const leases = options.filter((arg) => arg.startsWith('--force-with-lease='));
  if (leases.length !== 1) return undefined;
  const match = /^--force-with-lease=refs\/heads\/([A-Za-z0-9][A-Za-z0-9._/-]*):([a-fA-F0-9]{40})$/.exec(leases[0]!);
  if (!match) return undefined;
  const branch = match[1]!;
  if (isProtectedRemoteBranchDeletionTarget(branch, defaultBranch)) return undefined;
  const deletingByFlag = options.includes('--delete');
  if (options.some((arg) => arg.startsWith('-') && arg !== leases[0] && arg !== '--porcelain' && arg !== '--delete'))
    return undefined;
  if (
    options.filter((arg) => arg === '--porcelain').length > 1 ||
    options.filter((arg) => arg === '--delete').length > 1
  )
    return undefined;
  const operands = options.filter((arg) => !arg.startsWith('-'));
  return operands.length === 2 &&
    operands[0] === 'origin' &&
    operands[1] === (deletingByFlag ? branch : ':refs/heads/' + branch)
    ? 'refs/heads/' + branch
    : undefined;
}

/**
 * Cargo check/test observes source and writes Cargo build outputs, not a
 * checkout-wide source file. A previous generic build fallback gave these
 * commands a workspace write lease and blocked unrelated Agents (#713).
 *
 * Only a single, direct Cargo invocation qualifies. Shell composition,
 * redirections, interpolation, cargo build/fix and unknown commands keep their
 * existing conservative claims rather than silently claiming to be readonly.
 */
function isCargoSourceValidationCommand(command: string | readonly string[]): boolean {
  const canonical = normalizeRepositoryCommand(command);
  const shell =
    canonical.kind === 'shell'
      ? canonical.shellCommand
      : fixedShellWrapperCommand([canonical.executable!, ...(canonical.args ?? [])]);
  let words: readonly string[];
  if (shell !== undefined) {
    if (/[;&|<>\x60$\n\r]/.test(shell)) return false;
    const segments = shellSegments(shell);
    if (segments.length !== 1) return false;
    words = shellWordsPreservingQuotes(segments[0]!);
  } else {
    words = [canonical.executable!, ...(canonical.args ?? [])];
  }
  if (basename(words[0] ?? '').toLowerCase() !== 'cargo') return false;
  return ['test', 'check'].includes(words[1]?.toLowerCase() ?? '');
}

/** Only literal, bounded Git pathspecs may narrow source mutation claims. */
function literalGitMutationPaths(args: readonly string[]): string[] | undefined {
  const separator = args.indexOf('--');
  const paths = separator >= 0 ? args.slice(separator + 1) : args.slice(1);
  if (paths.length === 0 || paths.length > 16 || (separator < 0 && paths.some((path) => path.startsWith('-')))) {
    return undefined;
  }
  return paths.every((path) => path !== '.' && !/[:*?\[\]{}\\]/.test(path) && normalizeClaimPath(path) !== null)
    ? [...paths]
    : undefined;
}

/** Git staging changes only the index; branch/tag commands change only Git
 * metadata. Neither has source-file ownership, even without a pathspec (#713).
 * This is independent of command authorization and preserves the short
 * atomic Git index/ref leases.
 */
function gitMetadataOnlyClaims(
  command: string | readonly string[],
  repoId: string,
  checkoutId?: string,
): ResourceClaimSpec[] | undefined {
  const canonical = normalizeRepositoryCommand(command);
  const wrapped =
    canonical.kind === 'argv'
      ? fixedShellWrapperCommand([canonical.executable ?? '', ...(canonical.args ?? [])])
      : undefined;
  if ((canonical.kind === 'shell' || wrapped) && !isSimpleNonComposedCommand(command)) return undefined;
  const words =
    canonical.kind === 'argv' && !wrapped
      ? [canonical.executable ?? '', ...(canonical.args ?? [])]
      : shellWordsPreservingQuotes(wrapped ?? canonical.shellCommand ?? '');
  if ((words[0] ?? '').split(/[\\/]/).at(-1)?.toLowerCase() !== 'git') return undefined;
  const args = words.slice(1);
  const sub = args[0]?.toLowerCase();
  if (sub === 'add' || (sub === 'rm' && args.includes('--cached'))) {
    return [claimGitIndex(checkoutId, repoId)];
  }
  if (sub === 'branch' || sub === 'tag') return [claimGitRefs(repoId)];
  // Fetch updates object storage and remote-tracking refs, not the checked-out
  // worktree. Recursive submodule fetch can touch other Git stores, so those
  // explicit modes retain the conservative fallback (#713).
  if (sub === 'fetch' && !args.some((arg) => /^--(?:recurse-submodules|submodule-prefix)(?:=|$)/.test(arg))) {
    return [claimGitRefs(repoId)];
  }
  if (sub === 'restore' && args.includes('--staged') && !args.includes('--worktree')) {
    return [claimGitIndex(checkoutId, repoId)];
  }
  if (sub === 'apply' && args.includes('--cached') && !args.includes('--index')) {
    return [claimGitIndex(checkoutId, repoId)];
  }
  return undefined;
}

/**
 * Classify resource claims for a repository command without taking whole-repo exclusive locks
 * for ordinary readonly / focused validation commands.
 */
function repositoryCommandClaims(
  command: string | readonly string[],
  repoId: string,
  checkoutId?: string,
  defaultBranch?: string,
  repoRoot?: string,
  executionCwd: string | undefined = repoRoot,
): ResourceClaimSpec[] {
  const classification = classifyRepositoryCommand(command, defaultBranch);
  const canonical = normalizeRepositoryCommand(command);
  const commandProgram =
    canonical.kind === 'argv' ? (canonical.executable ?? '').split(/[\\/]/).at(-1)?.toLowerCase() : undefined;
  const commandArgs = canonical.kind === 'argv' ? (canonical.args ?? []) : [];
  const portablePackageCheck =
    ['bun', 'npm'].includes(commandProgram ?? '') &&
    commandArgs[0] === 'run' &&
    commandArgs[1] === 'check:portable-package';
  if (portablePackageCheck) {
    return normalizeClaims([claimValidationObservation(checkoutId, repoId), claimHeavyCheck(repoId)]);
  }
  const stageOnlyRuntimeRelease =
    commandProgram === 'bun' &&
    String(commandArgs[0] ?? '').replace(/^[.][/]/, '') === 'bin/forge.mjs' &&
    commandArgs[1] === 'runtime' &&
    commandArgs[2] === 'service' &&
    commandArgs[3] === 'install' &&
    commandArgs.includes('--stage-only');
  if (stageOnlyRuntimeRelease) {
    return normalizeClaims([
      claimValidationObservation(checkoutId, repoId),
      claimBuildCacheWrite(repoId),
      claimHeavyCheck(repoId),
    ]);
  }
  const focused = isFocusedCheckCommand(command);
  const explicitXcodeCache = xcodeBuildCacheClaims(command, repoId, executionCwd);
  const cacheClaims = explicitXcodeCache ?? [claimBuildCacheWrite(repoId)];
  const iosSimulatorClaims = iosSimulatorTestCommandClaims(command, repoId, checkoutId, cacheClaims);
  if (iosSimulatorClaims) return iosSimulatorClaims;
  const deviceClaims = validationDeviceClaims(command);
  if (deviceClaims.length > 0)
    return normalizeClaims([
      claimValidationObservation(checkoutId, repoId),
      claimBuildCacheWrite(repoId),
      ...deviceClaims,
    ]);
  const hostClaims = hostOnlyCommandClaims(command, repoId, checkoutId, repoRoot);
  if (hostClaims) return hostClaims;
  if (classification.risk !== 'destructive') {
    const redirectedValidation = scopedValidationLogOutput(command, repoId, checkoutId);
    if (redirectedValidation) return redirectedValidation;
  }

  if (classification.risk !== 'destructive' && isCargoSourceValidationCommand(command)) {
    return normalizeClaims([claimValidationObservation(checkoutId, repoId), claimBuildCacheWrite(repoId)]);
  }

  if (classification.risk === 'readonly') {
    // A command observing repository content does not own the checkout. This
    // must remain compatible with pre-retirement workspace-wide write leases.
    return [claimValidationObservation(checkoutId, repoId)];
  }
  // An exact leased remote-only delete cannot alter this checkout. Claim its
  // remote ref, not all remote branches; broad/opaque Git writers still overlap
  // this claim through the shared resource conflict authority.
  const remoteDeletionRef = exactLeasedRemoteReviewBranchDeletion(command, defaultBranch);
  if (remoteDeletionRef) {
    return [{ resourceKey: `remote-ref:${repoId}:origin:${remoteDeletionRef}`, mode: 'exclusive' }];
  }
  if (classification.risk === 'remote_write') {
    // Raw command text cannot prove the external provider/account target. Keep
    // the concrete local Git-ref fence; typed domain APIs own remote-effect
    // identity, idempotency and provider-target serialization.
    return [claimGitRefs(repoId)];
  }
  // Classification may label local branch deletion as destructive. Its source
  // effect is still zero: protect the Git ref, not every checkout file (#713).
  const metadataOnly = gitMetadataOnlyClaims(command, repoId, checkoutId);
  if (metadataOnly) return metadataOnly;
  if (classification.risk === 'destructive') {
    // Destructive effects are gated by policy, not by a checkout-wide writer.
    return [
      claimGitIndex(checkoutId, repoId),
      claimGitRefs(repoId),
      ...(looksLikeBuildOrTest(command) ? [claimBuildCacheWrite(repoId)] : []),
    ];
  }

  // workspace_write — refine. Typed noEmit may write only incremental metadata,
  // while ordinary focused tests are observation unless snapshot-update mode is
  // explicit. Both can share repository source reads without a workspace writer.
  if (isTypedTypeScriptNoEmit(command)) {
    return [claimValidationObservation(checkoutId, repoId), claimBuildCacheWrite(repoId)];
  }
  if (focused) {
    if (!focusedTestRequestsWorkspaceMutation(command)) return [claimValidationObservation(checkoutId, repoId)];
    const claims: ResourceClaimSpec[] = [claimValidationObservation(checkoutId, repoId)];
    claims.push(...claimPathWrites(extractLikelyPaths(command).slice(0, 16), checkoutId, repoId));
    return normalizeClaims(claims);
  }
  // Explicit Xcode derived-data identity already models cache narrowly.
  // Heuristic build/test softens for simple argv and for pure composed validation
  // shells (`set -euo pipefail; bun run check:type`). Redirection, emitting tsc,
  // and unknown side-effect segments keep checkout-wide writers (#713).
  const pureValidation = isPureBuildOrTestComposition(command);
  if (explicitXcodeCache || pureValidation) {
    const validationShell =
      canonical.kind === 'shell'
        ? canonical.shellCommand
        : fixedShellWrapperCommand([canonical.executable!, ...(canonical.args ?? [])]);
    // A shell-composed pure validation has no source output; its script text
    // must not be mistaken for paths. Structured argv keeps exact path claims.
    const paths = pureValidation && validationShell !== undefined ? [] : extractLikelyPaths(command);
    if (paths.length === 0) {
      // Opaque build/test observes source and may write shared build cache only.
      // Do not take a checkout-wide writer as the Agent admission gate (#713).
      return normalizeClaims([claimValidationObservation(checkoutId, repoId), ...cacheClaims]);
    }
    const claims: ResourceClaimSpec[] = [claimValidationObservation(checkoutId, repoId), ...cacheClaims];
    claims.push(...claimPathWrites(paths.slice(0, 16), checkoutId, repoId));
    return normalizeClaims(claims);
  }

  const program =
    canonical.kind === 'argv' ? (canonical.executable ?? '').split(/[\\/]/).at(-1)?.toLowerCase() : undefined;
  const sub = canonical.kind === 'argv' ? canonical.args?.[0]?.toLowerCase() : undefined;
  if (program === 'git') {
    const gitPaths = sub === 'apply' ? undefined : literalGitMutationPaths(canonical.args ?? []);
    if (sub === 'add' || sub === 'rm' || sub === 'mv' || sub === 'restore' || sub === 'apply') {
      if (gitPaths) {
        return normalizeClaims([claimGitIndex(checkoutId, repoId), ...claimPathWrites(gitPaths, checkoutId, repoId)]);
      }
      return [claimGitIndex(checkoutId, repoId)];
    }
    if (sub === 'commit' || sub === 'merge' || sub === 'rebase' || sub === 'cherry-pick' || sub === 'revert') {
      // Index/ref atomicity is the real fence. A path-scoped commit must not
      // monopolize the whole checkout as an Agent admission lock (#713).
      return [claimGitIndex(checkoutId, repoId), claimGitRefs(repoId)];
    }
    if (sub === 'checkout' || sub === 'switch') {
      // Switching the worktree updates the index and refs as well as source.
      return [claimGitIndex(checkoutId, repoId), claimGitRefs(repoId)];
    }
    // Unknown Git subcommands may update index/refs; keep their physical
    // atomic coordination only.
    return [claimGitIndex(checkoutId, repoId), claimGitRefs(repoId)];
  }

  // Opaque mutating commands take no checkout-wide writer (#713). Declared
  // mutation_paths become exact path claims above; build-like shells still
  // serialize the real shared build cache.
  return looksLikeBuildOrTest(command) ? [claimBuildCacheWrite(repoId)] : [];
}

/** One native build at a time per host, using the existing Lease owner. */
export function claimsForRepositoryCommand(
  command: string | readonly string[],
  repoId: string,
  checkoutId?: string,
  defaultBranch?: string,
  repoRoot?: string,
  executionCwd: string | undefined = repoRoot,
  declaredMutationPaths?: readonly string[],
): ResourceClaimSpec[] {
  const canonical = normalizeRepositoryCommand(command);
  let nativeBuild = false;
  const simulatorBoot = (words: readonly string[]): boolean => {
    let index = 0;
    if (basename(words[index] ?? '') === 'env') index += 1;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) index += 1;
    if (basename(words[index] ?? '') === 'xcrun') index += 1;
    return basename(words[index] ?? '') === 'simctl' && words[index + 1] === 'boot';
  };
  const shellBootsSimulator = (shell: string): boolean =>
    shellSegments(shell)
      .flatMap((segment) => segment.split(/\r?\n/))
      .some((segment) => simulatorBoot(shellWordsPreservingQuotes(segment.trim())));
  if (canonical.kind === 'argv') {
    const words = [canonical.executable!, ...(canonical.args ?? [])];
    const wrapped = fixedShellWrapperCommand(words);
    if (wrapped) nativeBuild = shellXcodebuildCommands(wrapped).length > 0 || shellBootsSimulator(wrapped);
    else {
      const program = basename(words[0]!);
      const args = program === 'xcrun' && words[1] === 'xcodebuild' ? words.slice(2) : words.slice(1);
      nativeBuild =
        (program === 'xcodebuild' || (program === 'xcrun' && words[1] === 'xcodebuild')) &&
        !args.some((arg) =>
          ['-list', '-version', '-showsdks', '-showdestinations', '-showBuildSettings', '-help'].includes(arg),
        );
      nativeBuild ||= simulatorBoot(words);
    }
  } else
    nativeBuild =
      shellXcodebuildCommands(canonical.shellCommand ?? '').length > 0 ||
      shellBootsSimulator(canonical.shellCommand ?? '');
  const inferredClaims = repositoryCommandClaims(command, repoId, checkoutId, defaultBranch, repoRoot, executionCwd);
  nativeBuild ||= inferredClaims.some((claim) => claim.resourceKey === 'host-service:ios-simulator-test');
  const nativeBuildClaims = nativeBuild ? [claimHostService('ios-build')] : [];

  if (declaredMutationPaths && declaredMutationPaths.length > 0) {
    // The model/caller owns semantic scope. Forge only turns the declared
    // repository-relative write scope into mechanical claims and preserves
    // independently provable Git/device/exact-cache claims.
    const declaredSourceClaims = claimPathWrites(declaredMutationPaths, checkoutId, repoId);
    const mechanicalClaims = inferredClaims.filter((claim) => {
      const key = claim.resourceKey;
      if (key === `build-cache:${repoId}`) return false;
      return !key.startsWith('path:');
    });
    return normalizeClaims([...mechanicalClaims, ...declaredSourceClaims, ...nativeBuildClaims]);
  }

  return normalizeClaims([...inferredClaims, ...nativeBuildClaims]);
}

/**
 * Claims for run_check by check id / command.
 * Full CI/release/multi-phase checks and compiler-intensive latency gates take
 * heavy-check exclusive. The latter fence protects performance assertions from
 * same-repository CPU/JSC contention; it does not replace their real read/cache
 * claims.
 */
export function claimsForCheck(
  checkId: string,
  command: readonly string[] | undefined,
  repoId: string,
  checkoutId?: string,
  effects?: ControllerCheckEffects,
  executionAuthority?: ControllerCheckExecutionAuthority,
): ResourceClaimSpec[] {
  const heavy =
    /(?:^|:)(?:test(?::coverage)?|check:(?:ci|forge-runtime|public-export|release(?:-[a-z0-9-]+)?|type|typescript-navigation))$/.test(
      checkId,
    ) || /release|migration|integrate/i.test(checkId);
  const baseClaims = effects
    ? claimsForDeclaredCheckEffects(checkId, effects, repoId, checkoutId)
    : staticAnalysisCheckId(checkId)
      ? [claimValidationObservation(checkoutId, repoId), claimBuildCacheWrite(repoId)]
      : command && command.length > 0
        ? claimsForRepositoryCommand(command, repoId, checkoutId)
        : [];
  // Heavy-check is an additional cross-check serialization fence, not a
  // substitute for the resources the check actually reads or writes.
  const liveAuthorityClaims = executionAuthority === 'live_controller_home' ? [claimRelease(repoId)] : [];
  const deviceClaims = command ? validationDeviceClaims(command) : [];
  const buildClaims = command
    ? claimsForRepositoryCommand(command, repoId, checkoutId).filter(
        (claim) => claim.resourceKey === 'host-service:ios-build',
      )
    : [];
  return heavy
    ? normalizeClaims([claimHeavyCheck(repoId), ...liveAuthorityClaims, ...baseClaims, ...deviceClaims, ...buildClaims])
    : normalizeClaims([...liveAuthorityClaims, ...baseClaims, ...deviceClaims, ...buildClaims]);
}

export function scopeResourceClaims(
  claims: ResourceClaimSpec[],
  repoId: string,
  checkoutId?: string,
): ResourceClaimSpec[] {
  const normalizedRepoId = repoId.trim();
  const normalizedCheckoutId = checkoutId?.trim();
  if (!normalizedRepoId) throw new Error('RESOURCE_CLAIM_REPOSITORY_REQUIRED');
  return claims.map((claim) => {
    if (claim.repoId && claim.repoId !== normalizedRepoId) throw new Error('RESOURCE_CLAIM_REPOSITORY_MISMATCH');
    if (claim.checkoutId && normalizedCheckoutId && claim.checkoutId !== normalizedCheckoutId)
      throw new Error('RESOURCE_CLAIM_CHECKOUT_MISMATCH');
    return {
      ...claim,
      repoId: normalizedRepoId,
      ...(normalizedCheckoutId ? { checkoutId: normalizedCheckoutId } : {}),
    };
  });
}

export function toProcessClaims(claims: ResourceClaimSpec[]): ProcessResourceClaim[] {
  return claims.map((claim) => ({
    resourceKey: claim.resourceKey,
    mode: claim.mode,
    ...(claim.repoId ? { repoId: claim.repoId } : {}),
    ...(claim.checkoutId ? { checkoutId: claim.checkoutId } : {}),
  }));
}
