import { spawn, spawnSync } from 'child_process';
import { closeSync, mkdirSync, openSync } from 'fs';
import { dirname } from 'path';
import {
  bootstrapLaunchAgentWithRetryV2,
  bootoutLaunchAgentWithRetryV2,
  currentUserLaunchdDomain,
  installLaunchAgent,
  launchAgentPath,
  retireConflictingForgeLaunchAgents,
} from '../../cli/controller/launch-agents';
import {
  installSystemdUserUnit,
  renderSystemdUserUnit,
  systemdUserAvailable,
  writeSystemdUserUnit,
  systemdUserInstallCommands,
  type SystemdUserUnitInput,
} from '../../cli/controller/systemd-user';

export type { SystemdUserUnitInput } from '../../cli/controller/systemd-user';

export type PlatformServiceManagerKind = 'launchd' | 'systemd-user' | 'portable';

export interface PlatformServiceManagerSelection {
  kind: PlatformServiceManagerKind;
  persistent: boolean;
  reason: string;
}

export interface PlatformDetachedProcessInput {
  executable: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
  errorCode: string;
}

export interface PlatformServiceManagerHost {
  selection: PlatformServiceManagerSelection;
  renderSystemdUserUnit(input: SystemdUserUnitInput): string;
  installSystemdUserUnit(input: { unitName: string; unit: SystemdUserUnitInput; env?: NodeJS.ProcessEnv; errorPrefix: string }): string;
  writeSystemdUserUnit(unitName: string, unit: SystemdUserUnitInput, env?: NodeJS.ProcessEnv): string;
  systemdUserInstallCommands(unitName: string): string[][];
  launchdInstalledPath(label: string, accountHome?: string): string;
  installLaunchd(sourcePath: string, label: string): void;
  bootstrapLaunchd(input: { label: string; plistPath: string }): Promise<{ ok: boolean; diagnostics: string[] }>;
  bootoutLaunchd(input: { label: string; plistPath: string }): Promise<{ ok: boolean; diagnostics: string[] }>;
  retireConflictingLaunchd(input: Parameters<typeof retireConflictingForgeLaunchAgents>[0]): ReturnType<typeof retireConflictingForgeLaunchAgents>;
  launchdDomain(): string;
  detachLaunchdBootout(label: string): void;
  startDetached(input: PlatformDetachedProcessInput): number;
}

/** Pure product-level selection. Platform adapters own probing/install mechanics. */
export function resolvePlatformServiceManager(input: {
  platform: NodeJS.Platform;
  forcePortable?: boolean;
  systemdUserAvailable?: boolean;
}): PlatformServiceManagerSelection {
  if (input.forcePortable === true) {
    return { kind: 'portable', persistent: false, reason: 'portable_explicitly_requested' };
  }
  if (input.platform === 'darwin') {
    return { kind: 'launchd', persistent: true, reason: 'macos_launchd_available' };
  }
  if (input.platform === 'linux' && input.systemdUserAvailable === true) {
    return { kind: 'systemd-user', persistent: true, reason: 'linux_systemd_user_available' };
  }
  if (input.platform === 'linux') {
    return { kind: 'portable', persistent: false, reason: 'linux_systemd_user_unavailable' };
  }
  if (input.platform === 'win32') {
    return { kind: 'portable', persistent: false, reason: 'windows_native_persistence_preview' };
  }
  return { kind: 'portable', persistent: false, reason: 'platform_service_manager_unsupported' };
}

export function createPlatformServiceManagerHost(input: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  forcePortable?: boolean;
  systemdUserAvailable?: boolean;
} = {}): PlatformServiceManagerHost {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const systemdAvailable = input.systemdUserAvailable ?? (platform === 'linux' ? systemdUserAvailable(env) : false);
  const selection = resolvePlatformServiceManager({ platform, forcePortable: input.forcePortable, systemdUserAvailable: systemdAvailable });
  return {
    selection,
    renderSystemdUserUnit,
    installSystemdUserUnit,
    writeSystemdUserUnit,
    systemdUserInstallCommands,
    launchdInstalledPath: launchAgentPath,
    installLaunchd: installLaunchAgent,
    bootstrapLaunchd: bootstrapLaunchAgentWithRetryV2,
    bootoutLaunchd: bootoutLaunchAgentWithRetryV2,
    retireConflictingLaunchd: retireConflictingForgeLaunchAgents,
    launchdDomain: currentUserLaunchdDomain,
    detachLaunchdBootout(label: string): void {
      if (platform !== 'darwin') return;
      const child = spawn('/bin/launchctl', ['bootout', `${currentUserLaunchdDomain()}/${label}`], {
        detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      });
      child.unref();
    },
    startDetached(processInput: PlatformDetachedProcessInput): number {
      mkdirSync(dirname(processInput.stdoutPath), { recursive: true, mode: 0o700 });
      const stdout = openSync(processInput.stdoutPath, 'a', 0o600);
      const stderr = openSync(processInput.stderrPath, 'a', 0o600);
      try {
        const child = spawn(processInput.executable, processInput.args, {
          detached: true, stdio: ['ignore', stdout, stderr], env: processInput.environment,
        });
        if (!child.pid) throw new Error(`${processInput.errorCode}: child pid unavailable`);
        child.unref();
        return child.pid;
      } finally {
        closeSync(stdout);
        closeSync(stderr);
      }
    },
  };
}

export function platformLaunchdInstalledPath(label: string, accountHome?: string): string {
  return launchAgentPath(label, accountHome);
}

export function probeSystemdUserAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return systemdUserAvailable(env);
}

export function probeSystemdUserAvailableDirect(env: NodeJS.ProcessEnv = process.env): boolean {
  return spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8', env, timeout: 30_000 }).status === 0;
}
