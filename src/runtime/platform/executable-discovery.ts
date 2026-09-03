import { existsSync } from 'fs';
import { delimiter, isAbsolute, join } from 'path';

export type ExecutableDiscoveryStatus = 'ready' | 'missing' | 'unsupported';
export interface ExecutableDiscoveryResult {
  id: string;
  status: ExecutableDiscoveryStatus;
  executable?: string;
  source?: 'explicit' | 'path';
  recovery?: string;
}

function executableNames(name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32' || /\.[A-Za-z0-9]+$/.test(name)) return [name];
  const extensions = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((value) => value.trim()).filter(Boolean);
  return [name, ...extensions.map((extension) => `${name}${extension.toLowerCase()}`), ...extensions.map((extension) => `${name}${extension.toUpperCase()}`)];
}

export function discoverExecutable(input: {
  id: string;
  candidates: readonly string[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  explicitPath?: string;
  supportedPlatforms?: readonly NodeJS.Platform[];
  fileExists?: (path: string) => boolean;
  recovery?: string;
}): ExecutableDiscoveryResult {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const fileExists = input.fileExists ?? existsSync;
  if (input.supportedPlatforms && !input.supportedPlatforms.includes(platform)) {
    return { id: input.id, status: 'unsupported', recovery: input.recovery };
  }
  const explicit = input.explicitPath?.trim();
  if (explicit) {
    if (isAbsolute(explicit) && fileExists(explicit)) return { id: input.id, status: 'ready', executable: explicit, source: 'explicit' };
    return { id: input.id, status: 'missing', recovery: input.recovery };
  }
  const pathEntries = (env.PATH ?? '').split(delimiter).map((entry) => entry.trim()).filter(Boolean);
  for (const candidate of input.candidates) {
    if (isAbsolute(candidate)) {
      if (fileExists(candidate)) return { id: input.id, status: 'ready', executable: candidate, source: 'path' };
      continue;
    }
    for (const directory of pathEntries) {
      for (const name of executableNames(candidate, platform, env)) {
        const executable = join(directory, name);
        if (fileExists(executable)) return { id: input.id, status: 'ready', executable, source: 'path' };
      }
    }
  }
  return { id: input.id, status: 'missing', recovery: input.recovery };
}
