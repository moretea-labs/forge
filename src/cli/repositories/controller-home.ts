import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'fs';
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

export function ensureControllerHome(explicit?: string): string {
  const home = ensureControllerHomeStorage(resolveControllerHome(explicit));
  for (const child of ['', 'repositories', 'system', 'locks', 'indexes', 'audit', 'mcp', 'sessions', 'work-handles']) {
    mkdirSync(join(home, child), { recursive: true });
  }
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
