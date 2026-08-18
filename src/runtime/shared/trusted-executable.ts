import { accessSync, constants, existsSync } from 'fs';
import { delimiter, isAbsolute, join, resolve } from 'path';

export interface TrustedExecutableResolution {
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

/**
 * Resolve one local executable without invoking a shell or `which`.
 *
 * A caller-supplied override is authoritative and must already be an absolute,
 * executable path. Invalid explicit configuration fails closed instead of
 * silently selecting a different binary. Fixed trusted locations are checked
 * before PATH so launchd services do not depend on an interactive shell PATH.
 */
export function resolveTrustedExecutable(input: {
  name: string;
  configured?: string;
  preferredPaths?: readonly string[];
  env?: NodeJS.ProcessEnv;
}): TrustedExecutableResolution {
  const env = input.env ?? process.env;
  const configured = input.configured?.trim() || undefined;
  if (configured) {
    if (!isAbsolute(configured)) return { configured, configuredInvalid: true };
    const absolute = resolve(configured);
    return isExecutable(absolute)
      ? { executable: absolute, configured }
      : { configured, configuredInvalid: true };
  }

  const executableName = process.platform === 'win32' && !input.name.toLowerCase().endsWith('.exe')
    ? `${input.name}.exe`
    : input.name;
  const candidates = [
    ...(input.preferredPaths ?? []),
    ...(env.PATH ?? '')
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => join(entry, executableName)),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const absolute = resolve(candidate);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    if (isExecutable(absolute)) return { executable: absolute };
  }
  return {};
}
