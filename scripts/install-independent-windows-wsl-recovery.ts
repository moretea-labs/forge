#!/usr/bin/env bun
/**
 * Bootstrap only: install immutable fixed-command rescue scripts outside the
 * Forge checkout. This script never invokes Forge Runtime, MCP, Controller,
 * or the existing Recovery implementation.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import {
  createIndependentHostRescueConfig,
  renderIndependentHostRescueEnv,
  renderIndependentHostRescueSystemdUnit,
  renderWindowsHostRescueConfig,
} from '../src/runtime/standalone-recovery/independent-host-rescue';
import { discoverWslWindowsHostEnvironment } from '../src/runtime/platform/windows-host-discovery';
import { resolveWindowsRecoveryDeployment } from '../src/runtime/platform/windows-recovery-deployment';

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

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = homedir();
const rescueRoot = resolve(option('--rescue-root') ?? join(home, '.forge-recovery'));
const host = discoverWslWindowsHostEnvironment();
const discoveredWindowsRoot = host?.programData ? join(host.programData, 'ForgeRecovery') : undefined;
const windowsRootOption = option('--windows-root');
const windowsRoot = resolve(windowsRootOption ?? discoveredWindowsRoot ?? (() => { throw new Error('HOST_RESCUE_WINDOWS_ROOT_DISCOVERY_REQUIRED: provide --windows-root when Windows ProgramData cannot be discovered'); })());
const deployment = resolveWindowsRecoveryDeployment({
  rescueRoot,
  host,
  recoveryScriptHostPath: join(windowsRoot, 'ForgeRecovery.ps1'),
  recoveryScriptWindowsPath: option('--recovery-script-windows'),
  powershellHostPath: option('--powershell-host'),
  powershellWindowsPath: option('--powershell-windows'),
});
const controllerHome = resolve(option('--controller-home') ?? join(home, '.forge', 'controller'));
const tunnelClient = resolve(option('--tunnel-client') ?? join(home, '.local', 'bin', 'tunnel-client'));
const stageOnly = process.argv.includes('--stage-only');
const installWindowsLogonTask = process.argv.includes('--install-windows-logon-task');

const config = createIndependentHostRescueConfig({
  wslDistro: option('--distro') ?? process.env.WSL_DISTRO_NAME ?? '',
  controllerHome,
  sourceRoot,
  rescueRoot,
  tunnelClient,
  tunnelAlias: option('--tunnel-alias') ?? '',
  tunnelId: option('--tunnel-id') ?? '',
  tunnelRuntimeApiKeyRef: option('--tunnel-runtime-api-key-ref') ?? `file:${rescueRoot}/secrets/openai-tunnel-runtime-api-key`,
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
  const scriptPath = deployment.recoveryScriptWindowsPath;
  const taskName = 'Forge Independent Recovery WSL';
  const powershell = deployment.powershellHostPath;
  try {
    command(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, 'task_install']);
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
  deployment,
  controllerHome: config.controllerHome,
  units: { runtime: config.runtimeUnit, connector: config.connectorUnit, recovery: config.recoveryUnit },
  tunnel: { alias: config.tunnelAlias, id: config.tunnelId, localMcpUrl: config.localMcpUrl },
  ...(windowsLogonTask ? { windowsLogonTask } : {}),
}, null, 2)}\n`);
