#!/usr/bin/env bun
import { homedir } from 'os';
import { join, resolve } from 'path';
import { installWindowsHostRecoveryPlugin } from '../src/runtime/plugins/windows-host-recovery-install';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

const controllerHome = resolve(option('--controller-home') ?? process.env.FORGE_CONTROLLER_HOME ?? join(homedir(), '.forge', 'controller'));
const result = installWindowsHostRecoveryPlugin({
  controllerHome,
  rescueRoot: option('--rescue-root'),
  helperSource: option('--helper-source'),
  recoveryScriptHostPath: option('--recovery-script-host') ?? option('--recovery-script'),
  recoveryScriptWindowsPath: option('--recovery-script-windows'),
  powershellHostPath: option('--powershell-host'),
  powershellWindowsPath: option('--powershell-windows'),
  enabled: !process.argv.includes('--disabled'),
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
