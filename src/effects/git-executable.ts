import { accessSync, constants, existsSync, statSync } from 'fs';
import { delimiter, isAbsolute, join } from 'path';

const GIT_EXECUTABLE_ENV = 'FORGE_GIT_EXECUTABLE';

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return false;
    if (platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['git.exe', 'git.cmd', 'git.bat', 'git'] : ['git'];
}

function standardDirectories(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    return [
      env.ProgramFiles ? join(env.ProgramFiles, 'Git', 'cmd') : undefined,
      env['ProgramFiles(x86)'] ? join(env['ProgramFiles(x86)'], 'Git', 'cmd') : undefined,
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd') : undefined,
    ].filter((value): value is string => Boolean(value));
  }
  return platform === 'darwin'
    ? ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']
    : ['/usr/bin', '/usr/local/bin', '/bin'];
}

export function resolveGitExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = env[GIT_EXECUTABLE_ENV]?.trim();
  if (configured) {
    if (!isAbsolute(configured) || !isExecutableFile(configured, platform)) {
      throw new Error(`GIT_EXECUTABLE_INVALID: ${configured}`);
    }
    return configured;
  }

  const directories = [
    ...(env.PATH ?? '').split(delimiter).filter(Boolean),
    ...standardDirectories(env, platform),
  ];
  const seen = new Set<string>();
  for (const directory of directories) {
    if (seen.has(directory)) continue;
    seen.add(directory);
    for (const name of candidateNames(platform)) {
      const candidate = join(directory, name);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  throw new Error('GIT_EXECUTABLE_NOT_FOUND');
}
