import { createHash } from 'crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { controllerSystemRoot } from '../../cli/repositories/controller-home';
import { discoverWslWindowsHostEnvironment, type WindowsHostEnvironment } from '../platform/windows-host-discovery';
import { resolveWindowsRecoveryDeployment } from '../platform/windows-recovery-deployment';
import { installExternalPluginRegistration } from './external-registration';
import { createWindowsHostRecoveryRegistrationInput } from './windows-host-recovery-registration';

function atomicCopy(source: string, destination: string, mode: number): void {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.tmp`;
  copyFileSync(source, temporary);
  chmodSync(temporary, mode);
  renameSync(temporary, destination);
}
function atomicJson(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}
function sha256(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function packagedHelperPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, '..', '..', '..', 'scripts', 'forge-windows-host-recovery-helper.mjs');
}

export function installWindowsHostRecoveryPlugin(options: {
  controllerHome: string;
  rescueRoot?: string;
  helperSource?: string;
  runtimeExecutable?: string;
  enabled?: boolean;
  host?: WindowsHostEnvironment;
  recoveryScriptHostPath?: string;
  recoveryScriptWindowsPath?: string;
  powershellHostPath?: string;
  powershellWindowsPath?: string;
}): Record<string, unknown> {
  const controllerHome = resolve(options.controllerHome);
  const rescueRoot = resolve(options.rescueRoot ?? join(homedir(), '.forge-recovery'));
  const helperSource = resolve(options.helperSource ?? packagedHelperPath());
  const host = options.host ?? discoverWslWindowsHostEnvironment();
  const deployment = resolveWindowsRecoveryDeployment({
    rescueRoot,
    host,
    recoveryScriptHostPath: options.recoveryScriptHostPath,
    recoveryScriptWindowsPath: options.recoveryScriptWindowsPath,
    powershellHostPath: options.powershellHostPath,
    powershellWindowsPath: options.powershellWindowsPath,
  });
  const helperPath = join(rescueRoot, 'bin', 'forge-windows-host-recovery-helper.mjs');
  const configDirectory = join(controllerSystemRoot(controllerHome), 'plugins', 'windows-host-recovery');
  const configPath = join(configDirectory, 'config.json');
  atomicCopy(helperSource, helperPath, 0o700);
  const scriptSha256 = sha256(deployment.recoveryScriptHostPath);
  atomicJson(configPath, { schemaVersion: 1, expectedScriptSha256: scriptSha256, deployment });
  const registration = installExternalPluginRegistration(controllerHome, createWindowsHostRecoveryRegistrationInput({
    runtimeExecutable: options.runtimeExecutable ?? process.execPath,
    helperPath,
    configDirectory,
    enabled: options.enabled !== false,
  }));
  return { registration, helperPath, configPath, deployment, scriptSha256 };
}
