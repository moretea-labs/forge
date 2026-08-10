#!/usr/bin/env bun
import { installExternalPluginRegistration } from '../src/runtime/plugins/external-registration';
import { createDesktopOperatorRegistrationInput } from '../src/runtime/plugins/desktop-operator-registration';
import { homedir } from 'os';
import { join } from 'path';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1]?.trim();
  if (!value || value.startsWith('--')) throw new Error(`DESKTOP_OPERATOR_INSTALL_ARGUMENT_MISSING: ${name}`);
  return value;
}

function usage(): never {
  throw new Error('Usage: bun scripts/install-desktop-operator-registration.ts --controller-home <path> [--socket <absolute-path>] [--launch-agent-label <label>] [--expected-program-contains <identity>] [--version 0.1.0] [--protocol 1.0] [--expected-revision N] [--disabled]');
}

const controllerHome = argument('--controller-home') ?? process.env.FORGE_CONTROLLER_HOME?.trim();
if (!controllerHome) usage();
const userHome = homedir();
const socketPath = argument('--socket') ?? join(userHome, 'Library', 'Caches', 'Forge', 'desktop-operator.sock');
const launchAgentLabel = argument('--launch-agent-label') ?? 'com.moretea.forge.desktop-operator';
const expectedProgramContains = argument('--expected-program-contains')
  ?? join(userHome, 'Applications', 'Forge Desktop Operator.app', 'Contents', 'MacOS', 'desktop-operator');
const expectedRevisionValue = argument('--expected-revision');
const expectedRevision = expectedRevisionValue === undefined ? undefined : Number(expectedRevisionValue);
if (expectedRevisionValue !== undefined && (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 1)) {
  throw new Error('DESKTOP_OPERATOR_INSTALL_EXPECTED_REVISION_INVALID');
}

const registration = installExternalPluginRegistration(
  controllerHome,
  createDesktopOperatorRegistrationInput({
    socketPath,
    launchAgentLabel,
    expectedProgramContains,
    pluginVersion: argument('--version') ?? '0.1.0',
    protocolVersion: argument('--protocol') ?? '1.0',
    enabled: !process.argv.includes('--disabled'),
  }),
  expectedRevision === undefined ? {} : { expectedRevision },
);

process.stdout.write(`${JSON.stringify(registration, null, 2)}\n`);
