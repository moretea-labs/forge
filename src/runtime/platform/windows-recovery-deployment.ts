import { join, resolve } from 'path';
import {
  hostPathToWindowsPath,
  windowsPathToHostPath,
  type WindowsHostEnvironment,
} from './windows-host-discovery';

export interface WindowsRecoveryDeploymentBinding {
  schemaVersion: 1;
  rescueRoot: string;
  recoveryScriptHostPath: string;
  recoveryScriptWindowsPath: string;
  powershellHostPath: string;
  powershellWindowsPath: string;
  source: 'discovered' | 'override';
}

function pair(input: {
  hostPath?: string;
  windowsPath?: string;
  defaultHostPath?: string;
  defaultWindowsPath?: string;
  host?: WindowsHostEnvironment;
  code: string;
}): { hostPath: string; windowsPath: string; overridden: boolean } {
  const hostPath = input.hostPath?.trim() || input.defaultHostPath;
  const windowsPath = input.windowsPath?.trim() || input.defaultWindowsPath;
  const resolvedHost = hostPath || (windowsPath && input.host ? windowsPathToHostPath(windowsPath, input.host.driveMounts) : undefined);
  const resolvedWindows = windowsPath || (hostPath && input.host ? hostPathToWindowsPath(hostPath, input.host.driveMounts) : undefined);
  if (!resolvedHost || !resolvedWindows) throw new Error(`${input.code}: explicit host/windows path pair or discoverable Windows host binding is required`);
  return { hostPath: resolve(resolvedHost), windowsPath: resolvedWindows, overridden: Boolean(input.hostPath || input.windowsPath) };
}

export function resolveWindowsRecoveryDeployment(input: {
  rescueRoot: string;
  host?: WindowsHostEnvironment;
  recoveryScriptHostPath?: string;
  recoveryScriptWindowsPath?: string;
  powershellHostPath?: string;
  powershellWindowsPath?: string;
}): WindowsRecoveryDeploymentBinding {
  const recovery = pair({
    hostPath: input.recoveryScriptHostPath,
    windowsPath: input.recoveryScriptWindowsPath,
    defaultHostPath: input.host?.programData ? join(input.host.programData, 'ForgeRecovery', 'ForgeRecovery.ps1') : undefined,
    defaultWindowsPath: input.host?.programDataWindows ? `${input.host.programDataWindows}\\ForgeRecovery\\ForgeRecovery.ps1` : undefined,
    host: input.host,
    code: 'WINDOWS_RECOVERY_SCRIPT_DEPLOYMENT_UNRESOLVED',
  });
  const powershell = pair({
    hostPath: input.powershellHostPath,
    windowsPath: input.powershellWindowsPath,
    defaultHostPath: input.host?.systemRoot ? join(input.host.systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : undefined,
    defaultWindowsPath: input.host?.systemRootWindows ? `${input.host.systemRootWindows}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : undefined,
    host: input.host,
    code: 'WINDOWS_RECOVERY_POWERSHELL_DEPLOYMENT_UNRESOLVED',
  });
  return {
    schemaVersion: 1,
    rescueRoot: resolve(input.rescueRoot),
    recoveryScriptHostPath: recovery.hostPath,
    recoveryScriptWindowsPath: recovery.windowsPath,
    powershellHostPath: powershell.hostPath,
    powershellWindowsPath: powershell.windowsPath,
    source: recovery.overridden || powershell.overridden ? 'override' : 'discovered',
  };
}
