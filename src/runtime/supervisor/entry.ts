#!/usr/bin/env bun
import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';
import { ensureControllerHome } from '../../cli/repositories/controller-home';
import { readActiveSlotAuthority } from '../../cli/controller/runtime-slots';
import { resolveMcpRepoRoot } from '../../cli/mcp/repo';
import { runtimeAuthorityPath, runtimeConfigPath, readRuntimeAuthority, readRuntimeConfig } from '../bootstrap/runtime-authority';
import { resolveControllerRuntimeSourceRoot } from '../control-plane/runtime-generation';
import { acquireSupervisorLock } from './lock';
import { supervisorLogPath, readCurrentRelease, readSupervisorRelease } from './paths';
import { readSupervisorState } from './state-store';
import { StableSupervisorRuntime } from './supervisor-runtime';
import { createStableIngressRouter } from './ingress-router';
import { stableIngressSessionStorePath } from './ingress-session-store';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function numberOption(name: string, fallback: number): number {
  const value = Number(option(name) ?? process.env.REPO_HARNESS_SUPERVISOR_CONTROL_PORT ?? fallback);
  return Number.isInteger(value) && value >= 0 && value <= 65_535 ? value : fallback;
}

function integerOption(name: string, fallback: number): number {
  const value = Number(option(name) ?? fallback);
  return Number.isInteger(value) && value >= 0 && value <= 65_535 ? value : fallback;
}

function processIdOption(name: string): number {
  const value = Number(option(name));
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function resolveStableIngressSlot(controllerHome: string): 'blue' | 'green' {
  const stateSlot = readSupervisorState(controllerHome)?.ingress.activeUpstreamSlot;
  return stateSlot === 'blue' || stateSlot === 'green'
    ? stateSlot
    : readActiveSlotAuthority(controllerHome).activeSlot;
}

export async function runStableIngressChild(): Promise<void> {
  const repoRoot = resolveMcpRepoRoot(option('--repo') ?? process.cwd());
  const controllerHome = ensureControllerHome(option('--controller-home'));
  const host = option('--stable-ingress-host') ?? '127.0.0.1';
  const port = integerOption('--stable-ingress-port', 8765);
  const rescueHost = option('--rescue-host') ?? '127.0.0.1';
  const rescuePort = integerOption('--rescue-port', 8770);
  const blueUpstreamPort = integerOption('--blue-upstream-port', port + 20);
  const greenUpstreamPort = integerOption('--green-upstream-port', port + 30);
  const parentPid = processIdOption('--parent-pid');
  if (parentPid <= 0) throw new Error('SUPERVISOR_INGRESS_PARENT_PID_REQUIRED');

  const router = await createStableIngressRouter({
    host,
    port,
    rescueHost,
    rescuePort,
    authorityObservation: () => {
      const authority = readRuntimeAuthority(controllerHome);
      return authority
        ? {
          term: authority.authorityTerm,
          revision: authority.active.releaseRevision,
        }
        : undefined;
    },
    sessionStorePath: stableIngressSessionStorePath(controllerHome),
    upstream: () => {
      // Routing is switched only after the newly-authoritative runtime has
      // restarted with the committed writer claim and passed readiness. The
      // activation authority may change earlier to fence the old writer.
      const slot = resolveStableIngressSlot(controllerHome);
      return {
        host: '127.0.0.1',
        port: slot === 'green' ? greenUpstreamPort : blueUpstreamPort,
        key: slot,
      };
    },
  });
  process.send?.({
    type: 'repo-harness-ingress-ready',
    host: router.host,
    port: router.port,
    pid: process.pid,
    parentPid,
  });

  let stopping = false;
  const stop = async (code: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(parentMonitor);
    await router.close().catch(() => undefined);
    try { process.disconnect?.(); } catch { /* parent may already be gone */ }
    process.exit(code);
  };
  const parentMonitor = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      void stop(1);
    }
  }, 1_000);
  parentMonitor.unref?.();
  process.once('SIGINT', () => { void stop(0); });
  process.once('SIGTERM', () => { void stop(0); });
  process.once('disconnect', () => { void stop(1); });
  console.error(`[repo-harness ingress] isolated data plane listening on ${router.host}:${router.port} parent=${parentPid} repo=${repoRoot}`);
  await new Promise<void>(() => { /* ingress server and parent monitor own the event loop */ });
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
  const repoRoot = resolveMcpRepoRoot(option('--repo') ?? process.cwd());
  const controllerHome = ensureControllerHome(option('--controller-home'));
  const standalone = process.env.REPO_HARNESS_RUNTIME_EXECUTION === 'standalone-binary';
  const releaseEntrypoint = standalone
    ? process.execPath
    : process.argv[1] ? resolve(process.argv[1]) : undefined;
  const releaseRoot = standalone
    ? readCurrentRelease(controllerHome) ?? (releaseEntrypoint ? dirname(releaseEntrypoint) : undefined)
    : releaseEntrypoint ? dirname(releaseEntrypoint) : undefined;
  const release = readSupervisorRelease(releaseRoot);
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
  const runtimeRoot = standalone && releaseRoot
    ? releaseRoot
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
    ingressExecutable: releaseEntrypoint,
    runtimeExecutable,
    daemonExecutable,
    ...(releaseRoot ? { releasePath: releaseRoot } : {}),
    ...(standalone ? { runtimeExecution: 'standalone-binary' as const } : {}),
    logPath: supervisorLogPath(controllerHome),
    controlHost: option('--control-host') ?? '127.0.0.1',
    controlPort: numberOption('--control-port', 8770),
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

if (process.argv.includes('--ingress-child')) {
  await runStableIngressChild();
} else if (import.meta.main || /[\\/]supervisor(?:\.bundle)?\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  await runStableSupervisor();
}
