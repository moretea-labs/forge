import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { controllerSystemRoot } from '../../cli/repositories/controller-home';
import { listRepositories } from '../../cli/repositories/registry';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { sanitizeFileComponent, writeJsonAtomic } from '../shared/json-files';

/** Invocation context carried by adapters; repo identity is not plugin-config authority. */
export interface PluginConfigAdapterContext {
  controllerHome: string;
  repoId: string;
  repoRoot: string;
}

export type LegacyPluginConfigRepository = Pick<RepositoryRecord, 'repoId' | 'canonicalRoot'>;

const CONTROLLER_PLUGIN_CONFIG_FILE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  app_store_connect: 'app-store-connect.json',
  browser: 'browser.json',
  gmail: 'gmail.json',
  google_calendar: 'google-calendar.json',
  google_tasks: 'google-tasks.json',
  resend: 'resend.json',
});

export const CONTROLLER_PLUGIN_CONFIG_IDS: readonly string[] = Object.freeze(Object.keys(CONTROLLER_PLUGIN_CONFIG_FILE_NAMES));

export function controllerPluginConfigFileName(pluginId: string): string {
  return CONTROLLER_PLUGIN_CONFIG_FILE_NAMES[pluginId] ?? `${sanitizeFileComponent(pluginId)}.json`;
}

/** The only writable plugin connection-config path: Controller Home / Forge instance. */
export function controllerPluginConfigPath(controllerHome: string, pluginId: string): string {
  return join(controllerSystemRoot(controllerHome), 'plugins', 'config', controllerPluginConfigFileName(pluginId));
}

function parsedObject<T>(path: string, authority: boolean): T | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as T;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      if (authority) throw new Error(`PLUGIN_CONFIG_AUTHORITY_INVALID: ${path} must contain a JSON object`);
      return undefined;
    }
    return value;
  } catch (error) {
    if (!authority) return undefined;
    if (error instanceof Error && error.message.startsWith('PLUGIN_CONFIG_AUTHORITY_INVALID:')) throw error;
    throw new Error(`PLUGIN_CONFIG_AUTHORITY_INVALID: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertSafeDirectory(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`PLUGIN_CONFIG_AUTHORITY_PATH_INVALID: ${path}`);
  }
  return true;
}

function readAuthoritativeConfig<T>(controllerHome: string, path: string): T | undefined {
  const pluginsRoot = join(controllerSystemRoot(controllerHome), 'plugins');
  const configRoot = join(pluginsRoot, 'config');
  if (!assertSafeDirectory(pluginsRoot) || !assertSafeDirectory(configRoot)) return undefined;
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`PLUGIN_CONFIG_AUTHORITY_PATH_INVALID: ${path}`);
  }
  return parsedObject<T>(path, true);
}

function legacyConfigRoots(repoRoot: string): string[] {
  return [join(repoRoot, '.forge', 'plugins'), join(repoRoot, '.repo-harness', 'plugins')];
}

interface LegacyConfigCandidate<T> {
  path: string;
  value: T;
}

interface LegacyConfigCollection<T> {
  candidates: LegacyConfigCandidate<T>[];
  unresolved: boolean;
}

function inspectLegacyConfig<T>(path: string): LegacyConfigCollection<T> {
  if (!existsSync(path)) return { candidates: [], unresolved: false };
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return { candidates: [], unresolved: true };
    const value = parsedObject<T>(path, false);
    return value
      ? { candidates: [{ path, value }], unresolved: false }
      : { candidates: [], unresolved: true };
  } catch {
    return { candidates: [], unresolved: true };
  }
}

function managedLegacyConfigPath(repositoryRoot: string, pluginId: string): string | undefined {
  const pluginsRoot = join(repositoryRoot, 'plugins');
  const configRoot = join(pluginsRoot, 'config');
  for (const directory of [pluginsRoot, configRoot]) {
    if (!existsSync(directory)) return undefined;
    try {
      const stat = lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
    } catch {
      return undefined;
    }
  }
  return join(configRoot, controllerPluginConfigFileName(pluginId));
}

function inspectManagedLegacyConfig<T>(repositoryRoot: string, pluginId: string): LegacyConfigCollection<T> {
  const path = managedLegacyConfigPath(repositoryRoot, pluginId);
  return path ? inspectLegacyConfig<T>(path) : { candidates: [], unresolved: false };
}

function controllerRepositoryCandidates<T>(controllerHome: string, pluginId: string): LegacyConfigCollection<T> {
  const repositoriesRoot = join(controllerHome, 'repositories');
  if (!existsSync(repositoriesRoot)) return { candidates: [], unresolved: false };
  const rootStat = lstatSync(repositoriesRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`PLUGIN_CONFIG_LEGACY_PATH_INVALID: ${repositoriesRoot}`);
  }
  const candidates: LegacyConfigCandidate<T>[] = [];
  let unresolved = false;
  for (const repoId of readdirSync(repositoriesRoot).sort()) {
    const repositoryRoot = join(repositoriesRoot, repoId);
    let repositoryStat;
    try { repositoryStat = lstatSync(repositoryRoot); } catch { continue; }
    if (repositoryStat.isSymbolicLink() || !repositoryStat.isDirectory()) continue;
    const inspected = inspectManagedLegacyConfig<T>(repositoryRoot, pluginId);
    candidates.push(...inspected.candidates);
    unresolved ||= inspected.unresolved;
  }
  return { candidates, unresolved };
}

function physicalRepositoryCandidates<T>(
  repositories: readonly LegacyPluginConfigRepository[],
  pluginId: string,
): LegacyConfigCollection<T> {
  const candidates: LegacyConfigCandidate<T>[] = [];
  let unresolved = false;
  const fileName = controllerPluginConfigFileName(pluginId);
  for (const repository of repositories) {
    for (const root of legacyConfigRoots(repository.canonicalRoot)) {
      if (!existsSync(root)) continue;
      let rootStat;
      try { rootStat = lstatSync(root); }
      catch { unresolved = true; continue; }
      if (rootStat.isSymbolicLink()) continue; // Unlinked separately; never traverse a compatibility symlink.
      if (!rootStat.isDirectory()) continue;
      const inspected = inspectLegacyConfig<T>(join(root, fileName));
      candidates.push(...inspected.candidates);
      unresolved ||= inspected.unresolved;
    }
  }
  return { candidates, unresolved };
}

function legacyProfileCandidate<T>(controllerHome: string, pluginId: string): LegacyConfigCollection<T> {
  if (pluginId !== 'app_store_connect') return { candidates: [], unresolved: false };
  const pluginsRoot = join(controllerSystemRoot(controllerHome), 'plugins');
  const profileRoot = join(pluginsRoot, 'profiles');
  for (const directory of [pluginsRoot, profileRoot]) {
    if (!existsSync(directory)) return { candidates: [], unresolved: false };
    try {
      const stat = lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return { candidates: [], unresolved: true };
    } catch {
      return { candidates: [], unresolved: true };
    }
  }
  return inspectLegacyConfig<T>(join(profileRoot, 'app-store-connect.json'));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function selectedMigrationCandidate<T>(candidates: LegacyConfigCandidate<T>[]): LegacyConfigCandidate<T> | undefined {
  const unique = new Map<string, LegacyConfigCandidate<T>>();
  for (const candidate of candidates) unique.set(canonicalJson(candidate.value), candidate);
  if (unique.size === 1) return [...unique.values()][0];

  const enabled = candidates.filter((candidate) => (
    Boolean(candidate.value)
    && typeof candidate.value === 'object'
    && (candidate.value as Record<string, unknown>).enabled === true
  ));
  const enabledUnique = new Map<string, LegacyConfigCandidate<T>>();
  for (const candidate of enabled) enabledUnique.set(canonicalJson(candidate.value), candidate);
  return enabledUnique.size === 1 ? [...enabledUnique.values()][0] : undefined;
}

function unlinkLegacyCompatibilitySymlinks(repositories: readonly LegacyPluginConfigRepository[]): void {
  for (const repository of repositories) {
    for (const root of legacyConfigRoots(repository.canonicalRoot)) {
      try {
        if (lstatSync(root).isSymbolicLink()) rmSync(root, { force: true });
      } catch {
        // Missing or inaccessible compatibility entries do not authorize traversal.
      }
    }
  }
}

function retireLegacyControllerPluginConfigCopies(
  controllerHome: string,
  pluginId: string,
  repositories: readonly LegacyPluginConfigRepository[],
): boolean {
  let retired = false;
  const repositoriesRoot = join(controllerHome, 'repositories');
  if (existsSync(repositoriesRoot) && lstatSync(repositoriesRoot).isDirectory() && !lstatSync(repositoriesRoot).isSymbolicLink()) {
    for (const repoId of readdirSync(repositoriesRoot).sort()) {
      const repositoryRoot = join(repositoriesRoot, repoId);
      let stat;
      try { stat = lstatSync(repositoryRoot); } catch { continue; }
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      const path = managedLegacyConfigPath(repositoryRoot, pluginId);
      if (!path) continue;
      try {
        const configStat = lstatSync(path);
        if (configStat.isFile() || configStat.isSymbolicLink()) {
          rmSync(path, { force: true });
          retired = true;
        }
        const configRoot = dirname(path);
        if (readdirSync(configRoot).length === 0) rmSync(configRoot, { recursive: true, force: true });
      } catch {
        // The canonical config is already committed; inaccessible legacy copies remain inert.
      }
    }
  }

  for (const repository of repositories) {
    for (const root of legacyConfigRoots(repository.canonicalRoot)) {
      let stat;
      try { stat = lstatSync(root); } catch { continue; }
      if (stat.isSymbolicLink()) {
        rmSync(root, { force: true });
        retired = true;
        continue;
      }
      if (!stat.isDirectory()) continue;
      const path = join(root, controllerPluginConfigFileName(pluginId));
      try {
        const configStat = lstatSync(path);
        if (configStat.isFile() || configStat.isSymbolicLink()) {
          rmSync(path, { force: true });
          retired = true;
        }
        if (readdirSync(root).length === 0) rmSync(root, { recursive: true, force: true });
      } catch {
        // The canonical config is already committed; inaccessible legacy copies remain inert.
      }
    }
  }

  if (pluginId === 'app_store_connect') {
    const pluginsRoot = join(controllerSystemRoot(controllerHome), 'plugins');
    const profileRoot = join(pluginsRoot, 'profiles');
    const profilePath = join(profileRoot, 'app-store-connect.json');
    try {
      const pluginsStat = lstatSync(pluginsRoot);
      const profileStat = lstatSync(profileRoot);
      if (pluginsStat.isDirectory() && !pluginsStat.isSymbolicLink()
        && profileStat.isDirectory() && !profileStat.isSymbolicLink()) {
        const configStat = lstatSync(profilePath);
        if (configStat.isFile() || configStat.isSymbolicLink()) {
          rmSync(profilePath, { force: true });
          retired = true;
        }
        if (readdirSync(profileRoot).length === 0) rmSync(profileRoot, { recursive: true, force: true });
      }
    } catch {
      // The canonical config is already committed; old profile data is inert.
    }
  }
  return retired;
}

export function readControllerPluginConfig<T>(controllerHome: string, pluginId: string): T | undefined {
  return readAuthoritativeConfig<T>(controllerHome, controllerPluginConfigPath(controllerHome, pluginId));
}

/** The only writer for current user-plugin connection configuration. */
export function writeControllerPluginConfig<T extends object>(
  controllerHome: string,
  pluginId: string,
  value: T,
  repositories: readonly LegacyPluginConfigRepository[] = listRepositories(controllerHome, { includeRemoved: true }),
): T {
  writeJsonAtomic(controllerPluginConfigPath(controllerHome, pluginId), value);
  retireLegacyControllerPluginConfigCopies(controllerHome, pluginId, repositories);
  return value;
}

/**
 * One-way migration from historical repository-local plugin config copies into
 * Controller-global config. Conflicting/unreadable legacy values remain intact
 * until an explicit global configure action establishes the canonical value.
 */
export function migrateLegacyControllerPluginConfigs(
  controllerHome: string,
  normalize?: (pluginId: string, value: unknown) => object,
  legacyRepositories?: readonly LegacyPluginConfigRepository[],
): string[] {
  const repositories = (legacyRepositories ?? listRepositories(controllerHome, { includeRemoved: true }))
    .map((repository) => ({ repoId: repository.repoId, canonicalRoot: repository.canonicalRoot }));
  unlinkLegacyCompatibilitySymlinks(repositories);
  const changedPluginIds: string[] = [];

  for (const pluginId of CONTROLLER_PLUGIN_CONFIG_IDS) {
    const canonicalPath = controllerPluginConfigPath(controllerHome, pluginId);
    const authoritative = readAuthoritativeConfig<unknown>(controllerHome, canonicalPath);
    const managed = controllerRepositoryCandidates<unknown>(controllerHome, pluginId);
    const physical = physicalRepositoryCandidates<unknown>(repositories, pluginId);
    const profile = legacyProfileCandidate<unknown>(controllerHome, pluginId);
    const candidates = [...managed.candidates, ...physical.candidates, ...profile.candidates];

    if (authoritative !== undefined) {
      const normalized = normalize && pluginId === 'browser'
        && (authoritative as Record<string, unknown>).schemaVersion !== 3
        ? normalize(pluginId, authoritative) : authoritative as object;
      const changed = canonicalJson(authoritative) !== canonicalJson(normalized);
      if (changed) {
        writeControllerPluginConfig(controllerHome, pluginId, normalized, repositories);
        changedPluginIds.push(pluginId);
      } else if (retireLegacyControllerPluginConfigCopies(controllerHome, pluginId, repositories)) {
        changedPluginIds.push(pluginId);
      }
      continue;
    }

    if (managed.unresolved || physical.unresolved || profile.unresolved) continue;
    const selected = selectedMigrationCandidate(candidates);
    if (!selected) continue;
    const normalized = normalize ? normalize(pluginId, selected.value) : selected.value as object;
    writeControllerPluginConfig(controllerHome, pluginId, normalized, repositories);
    changedPluginIds.push(pluginId);
  }

  return changedPluginIds;
}
