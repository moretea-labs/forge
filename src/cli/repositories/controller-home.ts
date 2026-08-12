import { existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, relative, resolve } from 'path';

export function resolveControllerHome(explicit?: string): string {
  const configured = explicit?.trim()
    || process.env.FORGE_CONTROLLER_HOME?.trim()
    || (process.env.XDG_STATE_HOME?.trim()
      ? join(process.env.XDG_STATE_HOME.trim(), 'forge', 'controller')
      : join(homedir(), '.forge', 'controller'));
  return resolve(configured);
}

/**
 * Prefer env, then repo-local self-host layout (`_ops/controller-home`) used by
 * `forge runtime service install`, then the user-global default.
 */
export function resolveRepoPreferredControllerHome(repoRoot?: string, explicit?: string): string {
  const trimmedExplicit = explicit?.trim();
  if (trimmedExplicit) return resolveControllerHome(trimmedExplicit);
  const configured = process.env.FORGE_CONTROLLER_HOME?.trim();
  if (configured) return resolveControllerHome(configured);
  if (repoRoot?.trim()) {
    const opsHome = join(resolve(repoRoot.trim()), '_ops', 'controller-home');
    if (existsSync(join(opsHome, 'mcp', 'mcp.local.json')) || existsSync(opsHome)) {
      return resolve(opsHome);
    }
  }
  return resolveControllerHome();
}

export function repoLocalNoIndexControllerHome(
  controllerHome: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const home = resolve(controllerHome);
  if (platform !== 'darwin' || basename(home) !== 'controller-home' || basename(dirname(home)) !== '_ops') return undefined;
  return `${home}.noindex`;
}

export function ensureControllerHomeStorage(
  controllerHome: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const home = resolve(controllerHome);
  const physical = repoLocalNoIndexControllerHome(home, platform);
  if (!physical || existsSync(home)) return home;

  let logicalEntryExists = false;
  try { logicalEntryExists = lstatSync(home).isSymbolicLink(); } catch { /* absent */ }
  mkdirSync(physical, { recursive: true });
  if (!logicalEntryExists) {
    const target = relative(dirname(home), physical) || basename(physical);
    try {
      symlinkSync(target, home, 'dir');
    } catch (error) {
      if (!existsSync(home)) throw error;
    }
  }
  return home;
}

const SPOTLIGHT_EXCLUSION_MARKER = '.metadata_never_index';
const spotlightExclusionAttempted = new Set<string>();

export interface SpotlightExclusionResult {
  attempted: boolean;
  excludedRoot?: string;
  created?: boolean;
  warning?: string;
}

/**
 * macOS honours .metadata_never_index on a directory without disabling
 * Spotlight for its parent volume. Controller Home changes frequently, so a
 * repo-local home excludes _ops as a whole while a global home excludes only
 * itself. This is deliberately a lifecycle helper: callers cache attempts
 * and never invoke mdutil or alter any broader indexing policy.
 */
export function spotlightOperationalExclusionRoot(controllerHome: string): string {
  const home = resolve(controllerHome);
  const parts = home.split('/');
  const ops = parts.lastIndexOf('_ops');
  return ops >= 0 && parts[ops + 1] === 'controller-home'
    ? parts.slice(0, ops + 1).join('/') || '/'
    : home;
}

export function ensureMacosSpotlightOperationalExclusion(
  controllerHome: string,
  platform = process.platform,
): SpotlightExclusionResult {
  if (platform !== 'darwin') return { attempted: false };
  const excludedRoot = spotlightOperationalExclusionRoot(controllerHome);
  if (spotlightExclusionAttempted.has(excludedRoot)) return { attempted: false, excludedRoot };
  spotlightExclusionAttempted.add(excludedRoot);
  try {
    mkdirSync(excludedRoot, { recursive: true });
    const marker = join(excludedRoot, SPOTLIGHT_EXCLUSION_MARKER);
    if (existsSync(marker)) return { attempted: true, excludedRoot, created: false };
    writeFileSync(marker, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { attempted: true, excludedRoot, created: true };
  } catch (error) {
    return {
      attempted: true,
      excludedRoot,
      warning: `SPOTLIGHT_EXCLUSION_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Test-only cache reset; production attempts are once per Runtime lifecycle. */
export function resetMacosSpotlightExclusionForTests(): void {
  spotlightExclusionAttempted.clear();
}

export function ensureControllerHome(explicit?: string): string {
  const home = ensureControllerHomeStorage(resolveControllerHome(explicit));
  for (const child of ['', 'repositories', 'system', 'locks', 'indexes', 'audit', 'mcp', 'sessions', 'work-handles']) {
    mkdirSync(join(home, child), { recursive: true });
  }
  // Best effort only. Indexing policy must never prevent Controller startup.
  ensureMacosSpotlightOperationalExclusion(home);
  return home;
}

export function ensureRepoPreferredControllerHome(repoRoot?: string, explicit?: string): string {
  return ensureControllerHome(resolveRepoPreferredControllerHome(repoRoot, explicit));
}

export const CONTROLLER_SCOPE_REPO_ID = '__controller__';

export function controllerSystemRoot(controllerHome: string): string {
  return join(resolveControllerHome(controllerHome), 'system');
}

/** Resolve the one durable Controller Home. Runtime slot paths are not valid homes. */
export function durableControllerHome(controllerHome?: string): string {
  return resolveControllerHome(controllerHome);
}

export function repositoryControllerRoot(controllerHome: string, repoId: string): string {
  // Durable repository state lives below the one Controller Home.
  const durableHome = durableControllerHome(controllerHome);
  return repoId === CONTROLLER_SCOPE_REPO_ID
    ? controllerSystemRoot(durableHome)
    : join(resolveControllerHome(durableHome), 'repositories', repoId);
}

export function ensureRepositoryControllerLayout(controllerHome: string, repoId: string): string {
  const root = repositoryControllerRoot(controllerHome, repoId);
  for (const child of [
    '',
    'runs',
    'jobs',
    'worktrees',
    'artifacts',
    'locks',
    'indexes',
    'edit-sessions',
    'controller',
    'local-bridge',
    'ephemeral-issues',
    'work-handles',
    'results',
    'audit',
    'processes',
    'leases',
    'workflows',
    'projections',
  ]) {
    mkdirSync(join(root, child), { recursive: true });
  }
  return root;
}
