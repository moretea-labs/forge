import { accessSync, constants, existsSync } from 'fs';
import { delimiter, isAbsolute, join, resolve } from 'path';

export interface TrustedNodeExecutableResolution {
  executable?: string;
  configured?: string;
  configuredInvalid?: boolean;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return existsSync(path);
  } catch {
    return false;
  }
}

function pathCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates = [
    env.VOLTA_HOME ? join(env.VOLTA_HOME, 'bin', 'node') : undefined,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ];
  for (const entry of (env.PATH ?? '').split(delimiter)) {
    if (entry.trim()) candidates.push(join(entry, process.platform === 'win32' ? 'node.exe' : 'node'));
  }
  return candidates.filter((value): value is string => Boolean(value));
}

export function resolveTrustedNodeExecutable(
  env: NodeJS.ProcessEnv = process.env,
): TrustedNodeExecutableResolution {
  if (env.FORGE_NODE_EXECUTABLE) {
    const configured = isAbsolute(env.FORGE_NODE_EXECUTABLE)
      ? env.FORGE_NODE_EXECUTABLE
      : resolve(env.FORGE_NODE_EXECUTABLE);
    return isExecutable(configured)
      ? { executable: configured, configured }
      : { configured, configuredInvalid: true };
  }
  for (const candidate of pathCandidates(env)) {
    const absolute = isAbsolute(candidate) ? candidate : resolve(candidate);
    if (isExecutable(absolute)) return { executable: absolute };
  }
  return {};
}
