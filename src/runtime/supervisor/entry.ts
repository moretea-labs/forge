#!/usr/bin/env bun
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';
import { ensureControllerHome } from '../../cli/repositories/controller-home';
import { resolveMcpRepoRoot } from '../../cli/mcp/repo';
import { runtimeAuthorityPath, runtimeConfigPath, readRuntimeAuthority, readRuntimeConfig } from '../bootstrap/runtime-authority';
import { resolveControllerRuntimeSourceRoot } from '../control-plane/runtime-generation';
import { acquireSupervisorLock } from './lock';
import { supervisorLogPath, readCurrentRelease, readSupervisorRelease } from './paths';
import { readSupervisorState } from './state-store';
import { DEFAULT_SUPERVISOR_CONTROL_PORT } from './control-server';
import { StableSupervisorRuntime } from './supervisor-runtime';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function numberOption(name: string, fallback: number): number {
  const value = Number(option(name) ?? process.env.REPO_HARNESS_SUPERVISOR_CONTROL_PORT ?? fallback);
  return Number.isInteger(value) && value >= 0 && value <= 65_535 ? value : fallback;
}

export function stableSupervisorExitCode(reason: 'unexpected_runtime_stop' | 'explicit_signal'): number {
  return reason === 'unexpected_runtime_stop' ? 1 : 0;
}

export function stableSupervisorActivatesPublishedRelease(
  serviceMode = process.env.REPO_HARNESS_SUPERVISOR_SERVICE_MODE,
): boolean {
  return serviceMode !== 'detached';
}

export async function runStableSupervisor(): Promise<void> {
  const controllerHome = ensureControllerHome(option('--controller-home'));
  const standalone = process.env.REPO_HARNESS_RUNTIME_EXECUTION === 'standalone-binary';
  const repoRoot = standalone
    ? resolve(option('--repo') ?? controllerHome)
    : resolveMcpRepoRoot(option('--repo') ?? process.cwd());
  const releaseEntrypoint = standalone
    ? process.execPath
    : process.argv[1] ? resolve(process.argv[1]) : undefined;
  const releaseRoot = standalone
    ? readCurrentRelease(controllerHome)
    : releaseEntrypoint ? dirname(releaseEntrypoint) : undefined;
  if (standalone && !releaseRoot) throw new Error('SUPERVISOR_CURRENT_RELEASE_MISSING');
  if (standalone && releaseEntrypoint && resolve(dirname(releaseEntrypoint)) !== resolve(releaseRoot!)) {
    throw new Error(`SUPERVISOR_BOOTSTRAP_RELEASE_MISMATCH: current=${releaseRoot} executable=${releaseEntrypoint}`);
  }
  const release = readSupervisorRelease(releaseRoot);
  if (standalone && !release) throw new Error('SUPERVISOR_CURRENT_RELEASE_INVALID');
  const authority = readRuntimeAuthority(controllerHome);
  if (existsSync(runtimeAuthorityPath(controllerHome)) && !authority) {
    throw new Error('RUNTIME_AUTHORITY_INVALID');
  }
  if (authority && release?.releaseRevision && authority.active.releaseRevision !== release.releaseRevision) {
    throw new Error(`RUNTIME_AUTHORITY_RELEASE_MISMATCH: expected ${authority.active.releaseRevision}, got ${release.releaseRevision}`);
  }
  const config = readRuntimeConfig(controllerHome);
  if (existsSync(runtimeConfigPath(controllerHome)) && !config) {
    throw new Error('RUNTIME_CONFIG_INVALID');
  }
  const runtimeRoot = standalone
    ? resolve(releaseRoot!)
    : resolve(option('--runtime-source-root') ?? release?.sourceRoot ?? resolveControllerRuntimeSourceRoot().root ?? repoRoot);
  const previous = readSupervisorState(controllerHome);
  const lock = acquireSupervisorLock(controllerHome, previous);
  let exitScheduled = false;
  const completeExit = (code: number): void => {
    if (exitScheduled) return;
    exitScheduled = true;
    lock.release();
    setTimeout(() => process.exit(code), 25);
  };
  const runtimeExecutable = release?.runtimeExecutable;
  const daemonExecutable = release?.daemonExecutable;
  const runtime = new StableSupervisorRuntime({
    repoRoot,
    controllerHome,
    ownerEpoch: lock.metadata.ownerEpoch,
    runtimeSourceRoot: runtimeRoot,
    runtimeExecutable,
    daemonExecutable,
    ...(releaseRoot ? { releasePath: releaseRoot } : {}),
    ...(standalone ? { runtimeExecution: 'standalone-binary' as const } : {}),
    logPath: supervisorLogPath(controllerHome),
    controlHost: option('--control-host') ?? '127.0.0.1',
    controlPort: numberOption('--control-port', DEFAULT_SUPERVISOR_CONTROL_PORT),
    releaseRevision: option('--release-revision') ?? release?.releaseRevision,
    activatePublishedRelease: stableSupervisorActivatesPublishedRelease(),
    // A runtime-owned stop is unexpected at the top-level service boundary.
    // Exit non-zero so launchd/systemd restart the Stable Supervisor instead
    // of treating the outage as an intentional operator shutdown.
    onHandoff: () => completeExit(0),
    onStopped: () => completeExit(stableSupervisorExitCode('unexpected_runtime_stop')),
  });
  runtime.adoptSupervisorIdentity({
    ...lock.metadata,
    epoch: lock.metadata.ownerEpoch,
    startedAt: new Date().toISOString(),
    ...(option('--release-revision') ? { releaseRevision: option('--release-revision') } : {}),
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.error(`[repo-harness supervisor] ${signal}: stopping managed runtime`);
    try {
      await runtime.stop();
      completeExit(stableSupervisorExitCode('explicit_signal'));
    } catch {
      completeExit(1);
    }
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

  try {
    await runtime.start();
    console.error(`[repo-harness supervisor] running controllerHome=${controllerHome} epoch=${lock.metadata.ownerEpoch}`);
    await new Promise<void>(() => { /* control server and monitor own the event loop */ });
  } catch (error) {
    if (!exitScheduled) lock.release();
    throw error;
  }
}

if (import.meta.main || /[\\/]supervisor(?:\.bundle)?\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  await runStableSupervisor();
}
