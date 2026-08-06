import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { loadRuntimeReleaseManifest } from './release-manifest';
import { readRuntimeReleaseAuthority } from './release-store';
import { readForgeRuntimeServiceConfig } from './service';

export interface ForgeRuntimeServiceCommand {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function resolveForgeRuntimeServiceCommand(controllerHome: string, configPath: string): ForgeRuntimeServiceCommand {
  const config = readForgeRuntimeServiceConfig(configPath);
  const home = resolve(controllerHome);
  if (config.controllerHome !== home) throw new Error('FORGE_RUNTIME_SERVICE_HOME_MISMATCH');
  const authority = readRuntimeReleaseAuthority(home);
  if (!authority) throw new Error('FORGE_RUNTIME_RELEASE_AUTHORITY_UNAVAILABLE');
  const manifest = loadRuntimeReleaseManifest(authority.active.manifestPath, home);
  const releaseRoot = dirname(resolve(authority.active.manifestPath));
  const executable = join(releaseRoot, manifest.entrypoint);
  if (!existsSync(executable)) throw new Error(`FORGE_RUNTIME_RELEASE_ENTRYPOINT_MISSING: ${executable}`);
  return {
    executable,
    args: [
      '--controller-home', home,
      '--repo', config.repositoryRoot,
      '--release-manifest', authority.active.manifestPath,
      '--host', config.host,
      '--port', String(config.port),
      '--auth-token-file', config.authTokenFile,
      ...manifest.arguments,
      ...(config.exclusiveWorkId ? ['--exclusive-work-id', config.exclusiveWorkId] : []),
    ],
    env: {
      ...process.env,
      FORGE_CONTROLLER_HOME: home,
      FORGE_RELEASE_PATH: releaseRoot,
      FORGE_RELEASE_ID: authority.active.releaseId,
      FORGE_RELEASE_REVISION: authority.active.releaseId,
      FORGE_RELEASE_CLEAN_WORKSPACE: 'true',
    },
  };
}

function forward(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.killed) child.kill(signal);
}

export async function runForgeRuntimeService(controllerHome: string, configPath: string): Promise<number> {
  const command = resolveForgeRuntimeServiceCommand(controllerHome, configPath);
  const child = spawn(command.executable, command.args, { env: command.env, stdio: 'inherit', detached: false, windowsHide: true });
  const onSigint = () => forward(child, 'SIGINT');
  const onSigterm = () => forward(child, 'SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    return await new Promise<number>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolveExit(typeof code === 'number' ? code : signal ? 1 : 0));
    });
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}
