#!/usr/bin/env bun
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { controllerSystemRoot } from '../src/cli/repositories/controller-home';
import { installExternalPluginRegistration } from '../src/runtime/plugins/external-registration';
import { createWindowsHostRecoveryRegistrationInput } from '../src/runtime/plugins/windows-host-recovery-registration';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}
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
function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const controllerHome = resolve(option('--controller-home') ?? process.env.FORGE_CONTROLLER_HOME ?? join(homedir(), '.forge', 'controller'));
const rescueRoot = resolve(option('--rescue-root') ?? join(homedir(), '.forge-recovery'));
if (rescueRoot !== resolve(join(homedir(), '.forge-recovery'))) throw new Error('WINDOWS_RECOVERY_PLUGIN_RESCUE_ROOT_CANONICAL_REQUIRED');
const sourceHelper = resolve(option('--helper-source') ?? join(process.cwd(), 'scripts', 'forge-windows-host-recovery-helper.mjs'));
const installedScript = '/mnt/c/ProgramData/ForgeRecovery/ForgeRecovery.ps1';
const helperPath = join(rescueRoot, 'bin', 'forge-windows-host-recovery-helper.mjs');
const configDirectory = join(controllerSystemRoot(controllerHome), 'plugins', 'windows-host-recovery');
const configPath = join(configDirectory, 'config.json');
atomicCopy(sourceHelper, helperPath, 0o700);
atomicJson(configPath, { schemaVersion: 1, expectedScriptSha256: sha256(installedScript) });
const registration = installExternalPluginRegistration(controllerHome, createWindowsHostRecoveryRegistrationInput({
  runtimeExecutable: process.execPath,
  helperPath,
  configDirectory,
  enabled: !process.argv.includes('--disabled'),
}));
process.stdout.write(`${JSON.stringify({ registration, helperPath, configPath, scriptSha256: sha256(installedScript) }, null, 2)}\n`);
