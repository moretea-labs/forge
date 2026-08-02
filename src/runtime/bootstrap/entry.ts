#!/usr/bin/env bun
import { existsSync, readFileSync, statSync } from 'fs';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { readSupervisorRelease, readCurrentRelease, supervisorBootstrapConfigPath } from '../supervisor/paths';

export interface SupervisorBootstrapConfig {
  schemaVersion: 1;
  controllerHome: string;
  repoRoot: string;
  createdAt: string;
  updatedAt: string;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function readSupervisorBootstrapConfig(controllerHome: string): SupervisorBootstrapConfig | undefined {
  const config = readJson<SupervisorBootstrapConfig>(supervisorBootstrapConfigPath(controllerHome));
  if (!config || config.schemaVersion !== 1) return undefined;
  if (resolve(config.controllerHome) !== resolve(controllerHome)) return undefined;
  if (!config.repoRoot || typeof config.repoRoot !== 'string') return undefined;
  return config;
}

export function currentSupervisorBootstrapCommand(
  controllerHome: string,
  options: { repoRoot?: string; processExecutable?: string } = {},
): { command: string; args: string[]; cwd: string; releasePath: string; executionMode: 'standalone-binary' | 'script' } {
  const releasePath = readCurrentRelease(controllerHome);
  const release = readSupervisorRelease(releasePath);
  if (!release) throw new Error('SUPERVISOR_CURRENT_RELEASE_MISSING');
  const executable = release.supervisorExecutable;
  try {
    if (!existsSync(executable) || statSync(executable).size === 0) throw new Error('SUPERVISOR_EXECUTABLE_EMPTY');
  } catch (error) {
    if (error instanceof Error && error.message === 'SUPERVISOR_EXECUTABLE_EMPTY') throw error;
    throw new Error('SUPERVISOR_EXECUTABLE_UNREADABLE');
  }
  const repoRoot = resolve(options.repoRoot ?? readSupervisorBootstrapConfig(controllerHome)?.repoRoot ?? controllerHome);
  const args = ['--repo', repoRoot, '--controller-home', resolve(controllerHome)];
  if (release.executionMode === 'standalone-binary') {
    return {
      command: executable,
      args,
      cwd: repoRoot,
      releasePath: release.releasePath,
      executionMode: 'standalone-binary',
    };
  }
  const runtime = options.processExecutable ?? process.env.REPO_HARNESS_BUN_EXECUTABLE;
  if (!runtime) throw new Error('SUPERVISOR_RELEASE_NOT_STANDALONE');
  return {
    command: runtime,
    args: [executable, ...args],
    cwd: repoRoot,
    releasePath: release.releasePath,
    executionMode: 'script',
  };
}

export async function runSupervisorBootstrap(): Promise<number> {
  const controllerHome = resolve(option('--controller-home') ?? process.env.REPO_HARNESS_CONTROLLER_HOME ?? '');
  if (!controllerHome || controllerHome === resolve('.')) throw new Error('SUPERVISOR_CONTROLLER_HOME_REQUIRED');
  const command = currentSupervisorBootstrapCommand(controllerHome, { repoRoot: option('--repo') });
  const child = spawn(command.command, command.args, {
    cwd: existsSync(command.cwd) ? command.cwd : controllerHome,
    stdio: 'inherit',
    env: {
      ...process.env,
      REPO_HARNESS_CONTROLLER_HOME: controllerHome,
      REPO_HARNESS_SUPERVISOR_BOOTSTRAP: '1',
      REPO_HARNESS_RUNTIME_EXECUTION: command.executionMode,
    },
  });
  return await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        resolveExit(1);
      } else {
        resolveExit(code ?? 1);
      }
    });
  });
}

if (import.meta.main || /[\\/]bootstrap(?:\\.bundle)?\\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  try {
    process.exitCode = await runSupervisorBootstrap();
  } catch (error) {
    console.error(`[repo-harness supervisor bootstrap] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
