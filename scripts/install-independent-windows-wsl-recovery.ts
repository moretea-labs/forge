#!/usr/bin/env bun
/**
 * Bootstrap only: install immutable fixed-command rescue scripts outside the
 * Forge checkout. This script never invokes Forge Runtime, MCP, Controller,
 * or the existing Recovery implementation.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';
import {
  createIndependentHostRescueConfig,
  renderIndependentHostRescueEnv,
  renderIndependentHostRescueSystemdUnit,
  renderWindowsHostRescueConfig,
} from '../src/runtime/standalone-recovery/independent-host-rescue';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function writeAtomic(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode });
  renameSync(temporary, path);
  chmodSync(path, mode);
}

function copyAtomic(source: string, destination: string, mode: number): void {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.tmp`;
  copyFileSync(source, temporary);
  chmodSync(temporary, mode);
  renameSync(temporary, destination);
}

function command(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`HOST_RESCUE_COMMAND_FAILED: ${command} ${args.join(' ')}: ${(result.stderr || result.stdout || result.error?.message || 'unknown error').trim()}`);
  }
}

const sourceRoot = resolve(process.cwd());
const home = homedir();
const rescueRoot = resolve(option('--rescue-root') ?? join(home, '.forge-recovery'));
const windowsRoot = resolve(option('--windows-root') ?? '/mnt/c/ProgramData/ForgeRecovery');
const controllerHome = resolve(option('--controller-home') ?? join(home, '.forge', 'controller'));
const tunnelClient = resolve(option('--tunnel-client') ?? join(home, '.local', 'bin', 'tunnel-client'));
const stageOnly = process.argv.includes('--stage-only');
const installWindowsLogonTask = process.argv.includes('--install-windows-logon-task');
if (!existsSync(join(sourceRoot, '.git'))) throw new Error('HOST_RESCUE_SOURCE_ROOT_NOT_GIT');
if (rescueRoot !== resolve(home, '.forge-recovery')) throw new Error('HOST_RESCUE_ROOT_CANONICAL_REQUIRED');
if (windowsRoot !== resolve('/mnt/c/ProgramData/ForgeRecovery')) throw new Error('HOST_RESCUE_WINDOWS_ROOT_CANONICAL_REQUIRED');

const config = createIndependentHostRescueConfig({
  wslDistro: option('--distro') ?? process.env.WSL_DISTRO_NAME ?? '',
  controllerHome,
  sourceRoot,
  rescueRoot,
  tunnelClient,
  tunnelAlias: option('--tunnel-alias') ?? '',
  tunnelId: option('--tunnel-id') ?? '',
  tunnelProfile: option('--tunnel-profile'),
  tunnelProfileDir: option('--tunnel-profile-dir') ?? join(home, '.config', 'tunnel-client'),
  tunnelAdminProfile: option('--tunnel-admin-profile'),
  localMcpUrl: option('--local-mcp-url'),
});

const assetRoot = join(sourceRoot, 'assets', 'recovery');
copyAtomic(join(assetRoot, 'forge-wsl-rescue'), join(rescueRoot, 'bin', 'forge-wsl-rescue'), 0o700);
writeAtomic(join(rescueRoot, 'config', 'rescue.env'), renderIndependentHostRescueEnv(config), 0o600);
copyAtomic(join(assetRoot, 'ForgeRecovery.ps1'), join(windowsRoot, 'ForgeRecovery.ps1'), 0o600);
writeAtomic(join(windowsRoot, 'config.json'), renderWindowsHostRescueConfig(config), 0o600);

const unitPath = join(home, '.config', 'systemd', 'user', config.recoveryUnit);
writeAtomic(unitPath, renderIndependentHostRescueSystemdUnit(config), 0o644);
if (!stageOnly) {
  command('systemctl', ['--user', 'daemon-reload']);
  command('systemctl', ['--user', 'enable', '--now', config.recoveryUnit]);
}
let windowsLogonTask: { name: string; installed: boolean; error?: string } | undefined;
if (installWindowsLogonTask) {
  const scriptPath = 'C:\\ProgramData\\ForgeRecovery\\ForgeRecovery.ps1';
  const taskName = 'Forge Independent Recovery WSL';
  const commandText = [
    "$ErrorActionPreference='Stop'",
    `$taskName='${taskName}'`,
    `$scriptPath='${scriptPath}'`,
    "$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -File \"' + $scriptPath + '\" full_recover')",
    '$trigger=New-ScheduledTaskTrigger -AtLogOn',
    "$null=Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Description 'Forge independent Windows/WSL rescue cold-start trigger.' -Force",
  ].join('; ');
  try {
    command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', commandText]);
    windowsLogonTask = { name: taskName, installed: true };
  } catch (error) {
    // The external agent and WSL watchdog remain valid without a logon task.
    // Task Scheduler permission is a Windows elevation boundary, not a reason
    // to report a fully staged host-rescue installation as absent.
    windowsLogonTask = {
      name: taskName,
      installed: false,
      error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
    };
  }
}

process.stdout.write(`${JSON.stringify({
  status: stageOnly ? 'staged' : 'installed',
  rescueRoot,
  windowsRoot,
  controllerHome: config.controllerHome,
  units: { runtime: config.runtimeUnit, connector: config.connectorUnit, recovery: config.recoveryUnit },
  tunnel: { alias: config.tunnelAlias, id: config.tunnelId, localMcpUrl: config.localMcpUrl },
  ...(windowsLogonTask ? { windowsLogonTask } : {}),
}, null, 2)}\n`);
