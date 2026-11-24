import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverWslWindowsDriveMounts } from './windows-host-discovery';

/**
 * Read-only discovery of Windows UI Automation. It cannot bind a Computer
 * target, click, type, activate a window or invent a provider session.
 * The UIA transport deliberately returns counts rather than window titles,
 * handles, browser URLs or credentials.
 */
export type WindowsComputerObservation = {
  provider: 'windows-uia';
  capability: 'window_inventory';
  state: 'observation_only' | 'unavailable' | 'unsupported';
  topLevelWindowCount?: number;
  browserWindowCount?: number;
  reasonCode?: 'windows_host_missing' | 'uia_probe_failed';
  applications?: Array<{ appName: string; processId: number }>;
};

const PROBE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'Add-Type -AssemblyName UIAutomationClient',
  '$root = [System.Windows.Automation.AutomationElement]::RootElement',
  '$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)',
  '$browserProcesses = @(Get-Process -Name chrome,CentBrowser,CentBrowser64,vivaldi,msedge,firefox -ErrorAction SilentlyContinue)',
  '$ids = @{}',
  'foreach ($process in $browserProcesses) { if ($process.MainWindowHandle -ne 0) { $ids[[int]$process.Id] = $true } }',
  '$matched = 0',
  'for ($i = 0; $i -lt [Math]::Min($windows.Count, 512); $i++) {',
  '  try { if ($ids.ContainsKey([int]$windows.Item($i).Current.ProcessId)) { $matched++ } } catch {}',
  '}',
  '$apps = @() ',
  'foreach ($p in @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 128)) {',
  '  try { $e = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle); if ($e.Current.ProcessId -eq $p.Id) { $apps += [pscustomobject]@{appName=$p.ProcessName;processId=$p.Id} } } catch {}',
  '}',
  '[pscustomobject]@{uiaReady=($null -ne $root);topLevelWindowCount=$windows.Count;browserWindowCount=$matched;applications=$apps} | ConvertTo-Json -Depth 4 -Compress',
].join('\n');

export interface WindowsComputerProbeDependencies {
  platform?: string;
  mountTable?: string;
  fileExists?: (path: string) => boolean;
  run?: (executable: string, args: readonly string[]) => Promise<string>;
}

function boundedCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : undefined;
}

function probeOutput(stdout: string): WindowsComputerObservation {
  const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
  const total = boundedCount(parsed?.topLevelWindowCount);
  const browser = boundedCount(parsed?.browserWindowCount);
  if (parsed?.uiaReady !== true || total === undefined || browser === undefined || browser > total) {
    throw new Error('WINDOWS_COMPUTER_UIA_UNVERIFIED');
  }
  return {
    provider: 'windows-uia',
    capability: 'window_inventory',
    state: 'observation_only',
    topLevelWindowCount: total,
    browserWindowCount: browser,
    ...(Array.isArray(parsed.applications)
      ? {
          applications: parsed.applications.slice(0, 128).flatMap((value) => {
            if (!value || typeof value !== 'object') return [];
            const item = value as Record<string, unknown>;
            return typeof item.appName === 'string' &&
              item.appName.length > 0 &&
              item.appName.length <= 256 &&
              typeof item.processId === 'number' &&
              Number.isInteger(item.processId) &&
              item.processId > 0 &&
              item.processId <= 2147483647
              ? [{ appName: item.appName, processId: item.processId }]
              : [];
          }),
        }
      : {}),
  };
}

async function runWindowsProbe(executable: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        cwd: '/',
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        encoding: 'utf8',
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

export function resolveWindowsComputerPowerShell(
  dependencies: WindowsComputerProbeDependencies = {},
): string | undefined {
  if ((dependencies.platform ?? process.platform) !== 'linux') return undefined;
  let mounts = dependencies.mountTable;
  if (mounts === undefined) {
    try {
      mounts = readFileSync('/proc/mounts', 'utf8');
    } catch {
      mounts = '';
    }
  }
  const driveMounts = discoverWslWindowsDriveMounts(mounts);
  const fileExists = dependencies.fileExists ?? existsSync;
  return Object.values(driveMounts)
    .map((root) => join(root, 'Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
    .find((path) => fileExists(path));
}

/** Internal fixed-script transport. External Computer inputs never supply script source. */
export async function executeWindowsComputerProbe(
  script: string,
  dependencies: WindowsComputerProbeDependencies = {},
): Promise<string> {
  const executable = resolveWindowsComputerPowerShell(dependencies);
  if (!executable) throw new Error('WINDOWS_COMPUTER_HOST_MISSING');
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  return await (dependencies.run ?? runWindowsProbe)(executable, args);
}

export async function probeWindowsComputerObservation(
  dependencies: WindowsComputerProbeDependencies = {},
): Promise<WindowsComputerObservation> {
  const base = { provider: 'windows-uia', capability: 'window_inventory' } as const;
  if ((dependencies.platform ?? process.platform) !== 'linux') return { ...base, state: 'unsupported' };
  if (!resolveWindowsComputerPowerShell(dependencies))
    return { ...base, state: 'unavailable', reasonCode: 'windows_host_missing' };
  try {
    const stdout = await executeWindowsComputerProbe(PROBE_SCRIPT, dependencies);
    return probeOutput(stdout);
  } catch {
    // Never expose Windows process stderr, UIA window names or transport output.
    return { ...base, state: 'unavailable', reasonCode: 'uia_probe_failed' };
  }
}
