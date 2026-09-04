import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { sanitizeFileComponent, writeJsonAtomic } from '../shared/json-files';

export interface RepositoryPluginConfigContext {
  controllerHome: string;
  repoId: string;
  repoRoot: string;
}

const REPOSITORY_PLUGIN_CONFIG_FILE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  app_store_connect: 'app-store-connect.json',
  browser: 'browser.json',
  gmail: 'gmail.json',
  google_calendar: 'google-calendar.json',
  google_tasks: 'google-tasks.json',
  resend: 'resend.json',
});

export const REPOSITORY_PLUGIN_CONFIG_IDS: readonly string[] = Object.freeze(Object.keys(REPOSITORY_PLUGIN_CONFIG_FILE_NAMES));

export function repositoryPluginConfigFileName(pluginId: string): string {
  return REPOSITORY_PLUGIN_CONFIG_FILE_NAMES[pluginId] ?? `${sanitizeFileComponent(pluginId)}.json`;
}

export function repositoryPluginConfigPath(
  context: Pick<RepositoryPluginConfigContext, 'controllerHome' | 'repoId'>,
  pluginId: string,
): string {
  return join(repositoryControllerRoot(context.controllerHome, context.repoId), 'plugins', 'config', repositoryPluginConfigFileName(pluginId));
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

function readAuthoritativeConfig<T>(path: string): T | undefined {
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

function readLegacyPhysicalConfig<T>(repoRoot: string, pluginId: string): T | undefined {
  const fileName = repositoryPluginConfigFileName(pluginId);
  for (const root of legacyConfigRoots(repoRoot)) {
    if (!existsSync(root)) continue;
    try {
      // A historical compatibility symlink may target a different Controller Home.
      // Never follow it: Controller Home identity is supplied by the invocation.
      if (!lstatSync(root).isDirectory()) continue;
      const file = join(root, fileName);
      if (!existsSync(file) || !lstatSync(file).isFile()) continue;
      const value = parsedObject<T>(file, false);
      if (value) return value;
    } catch {
      // Legacy compatibility is best-effort and never overrides Controller Home.
    }
  }
  return undefined;
}

export function readRepositoryPluginConfig<T>(
  context: RepositoryPluginConfigContext,
  pluginId: string,
): T | undefined {
  const authoritative = readAuthoritativeConfig<T>(repositoryPluginConfigPath(context, pluginId));
  return authoritative ?? readLegacyPhysicalConfig<T>(context.repoRoot, pluginId);
}

function retireLegacyPhysicalConfig(repoRoot: string, pluginId: string): void {
  const fileName = repositoryPluginConfigFileName(pluginId);
  for (const root of legacyConfigRoots(repoRoot)) {
    if (!existsSync(root)) continue;
    try {
      // Never traverse a compatibility symlink. It is retired repository-local
      // state, so unlink the symlink itself while preserving its external target.
      const stat = lstatSync(root);
      if (stat.isSymbolicLink()) {
        rmSync(root, { force: true });
        continue;
      }
      if (!stat.isDirectory()) continue;
      rmSync(join(root, fileName), { force: true });
      if (readdirSync(root).length === 0) rmSync(root, { recursive: true, force: true });
    } catch {
      // The authoritative write already succeeded. Legacy cleanup is best-effort.
    }
  }
}

export function writeRepositoryPluginConfig<T extends object>(
  context: RepositoryPluginConfigContext,
  pluginId: string,
  value: T,
): T {
  const path = repositoryPluginConfigPath(context, pluginId);
  writeJsonAtomic(path, value);
  retireLegacyPhysicalConfig(context.repoRoot, pluginId);
  return value;
}
