#!/usr/bin/env bun
import { mkdirSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { controllerSystemRoot } from '../src/cli/repositories/controller-home';
import { installExternalPluginRegistration } from '../src/runtime/plugins/external-registration';
import { createUuRemoteRescueRegistrationInput } from '../src/runtime/plugins/uu-remote-rescue-registration';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1]?.trim();
  if (!value || value.startsWith('--')) throw new Error(`UU_REMOTE_RESCUE_INSTALL_ARGUMENT_MISSING: ${name}`);
  return value;
}

function required(name: string): string {
  const value = argument(name);
  if (!value) throw new Error(`UU_REMOTE_RESCUE_INSTALL_ARGUMENT_REQUIRED: ${name}`);
  return value;
}

function writeConfig(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

const controllerHome = resolve(argument('--controller-home') ?? process.env.FORGE_CONTROLLER_HOME ?? '');
if (!controllerHome || controllerHome === resolve('.')) throw new Error('UU_REMOTE_RESCUE_INSTALL_CONTROLLER_HOME_REQUIRED');
const deviceId = required('--device-id');
const deviceName = required('--device-name');
const wslDistro = required('--wsl-distro');
const remoteControllerHome = required('--remote-controller-home');
if (!remoteControllerHome.startsWith('/')) throw new Error('UU_REMOTE_RESCUE_REMOTE_CONTROLLER_HOME_ABSOLUTE_REQUIRED');

const configDirectory = join(controllerSystemRoot(controllerHome), 'plugins', 'uu-remote-rescue');
const configPath = join(configDirectory, 'config.json');
const helperPath = resolve(argument('--helper') ?? join(dirname(fileURLToPath(import.meta.url)), 'forge-uu-remote-rescue-helper.mjs'));
const runtimeExecutable = resolve(argument('--runtime') ?? process.execPath);
const uuycCliPath = resolve(argument('--uuyc-cli') ?? '/usr/local/bin/uuyc-cli');
const desktopOperatorSocketPath = resolve(argument('--desktop-socket') ?? join(homedir(), 'Library', 'Caches', 'Forge', 'desktop-operator.sock'));
const expectedRevisionValue = argument('--expected-revision');
const expectedRevision = expectedRevisionValue === undefined ? undefined : Number(expectedRevisionValue);
if (expectedRevisionValue !== undefined && (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 1)) {
  throw new Error('UU_REMOTE_RESCUE_INSTALL_EXPECTED_REVISION_INVALID');
}
for (const [name, path] of Object.entries({ helperPath, runtimeExecutable, uuycCliPath, desktopOperatorSocketPath })) {
  if (!isAbsolute(path)) throw new Error(`UU_REMOTE_RESCUE_INSTALL_ABSOLUTE_PATH_REQUIRED: ${name}`);
}

writeConfig(configPath, {
  schemaVersion: 1,
  device: { id: deviceId, name: deviceName, platform: 'windows' },
  wsl: { distro: wslDistro, controllerHome: remoteControllerHome },
  uuycCliPath,
  desktopOperatorSocketPath,
  uuBundleId: 'com.netease.uuremote',
});

const registration = installExternalPluginRegistration(
  controllerHome,
  createUuRemoteRescueRegistrationInput({
    runtimeExecutable,
    helperPath,
    configDirectory,
    enabled: !process.argv.includes('--disabled'),
  }),
  expectedRevision === undefined ? {} : { expectedRevision },
);

process.stdout.write(`${JSON.stringify({ registration, configPath }, null, 2)}\n`);
