import { spawnSync } from 'child_process';
import { basename, resolve } from 'path';
import { forgeRuntimeServicePaths } from '../root/service';
import { readPackageConnectorServiceAuthority } from '../root/package-connector-service';

export interface WslCommandResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type WslCommandRunner = (command: string, args: string[], timeoutMs: number) => WslCommandResult;

export interface WslConfigSnapshot {
  networkingMode?: 'nat' | 'mirrored' | string;
  autoProxy?: boolean;
  dnsTunneling?: boolean;
  localhostForwarding?: boolean;
}

export interface WslEndpointDiagnostic {
  origin: string;
  ok: boolean;
  status?: number;
  timedOut: boolean;
}

export interface WslDevelopmentNetworkDiagnostic {
  isWsl: boolean;
  distro?: string;
  configured: WslConfigSnapshot;
  observedNetworkingMode?: string;
  proxies: Array<{ name: string; configured: boolean; hostClass?: 'loopback' | 'remote' | 'invalid' }>;
  gitCredentialHelpers: Array<{ scope: 'global' | 'system'; kind: 'windows-gcm' | 'linux-gcm' | 'other' }>;
  endpoints: WslEndpointDiagnostic[];
  issues: Array<{
    code: 'WSL_NETWORKING_MODE_MISMATCH' | 'WSL_NAT_LOCALHOST_PROXY' | 'WSL_WINDOWS_GCM_HELPER' | 'NETWORK_ENDPOINT_STALL';
    detail: string;
  }>;
}

export interface WindowsWslWakeContract {
  distro: string;
  controllerHome: string;
  runtimeUnit: string;
  connectorUnit: string;
  taskName: string;
}

export interface WindowsWslWakeInstallResult {
  ok: boolean;
  contract: WindowsWslWakeContract;
  scriptPath?: string;
  detail: string;
}

function defaultRunner(command: string, args: string[], timeoutMs: number): WslCommandResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    windowsHide: true,
  });
  const timedOut = Boolean(result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT');
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(timedOut ? { timedOut: true } : {}),
  };
}

function booleanValue(value: string): boolean | undefined {
  if (/^(?:true|1)$/i.test(value.trim())) return true;
  if (/^(?:false|0)$/i.test(value.trim())) return false;
  return undefined;
}

export function parseWslConfig(source: string): WslConfigSnapshot {
  let section = '';
  const values: Record<string, string> = {};
  for (const rawLine of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.replace(/[;#].*$/, '').trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1]!.trim().toLowerCase();
      continue;
    }
    if (section !== 'wsl2') continue;
    const assignment = line.match(/^([^=]+)=(.*)$/);
    if (!assignment) continue;
    values[assignment[1]!.trim().toLowerCase()] = assignment[2]!.trim();
  }
  const networkingMode = values.networkingmode?.trim().toLowerCase();
  const autoProxy = values.autoproxy === undefined ? undefined : booleanValue(values.autoproxy);
  const dnsTunneling = values.dnstunneling === undefined ? undefined : booleanValue(values.dnstunneling);
  const localhostForwarding = values.localhostforwarding === undefined ? undefined : booleanValue(values.localhostforwarding);
  return {
    ...(networkingMode ? { networkingMode } : {}),
    ...(autoProxy !== undefined ? { autoProxy } : {}),
    ...(dnsTunneling !== undefined ? { dnsTunneling } : {}),
    ...(localhostForwarding !== undefined ? { localhostForwarding } : {}),
  };
}

function normalizeNetworkingMode(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '');
  if (!normalized) return undefined;
  if (normalized.includes('mirror')) return 'mirrored';
  if (normalized.includes('nat')) return 'nat';
  return normalized;
}

function proxyHostClass(value: string | undefined): 'loopback' | 'remote' | 'invalid' | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = new URL(value.includes('://') ? value : `http://${value}`);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' ? 'loopback' : 'remote';
  } catch {
    return 'invalid';
  }
}

function credentialHelperKind(value: string): 'windows-gcm' | 'linux-gcm' | 'other' {
  const normalized = value.trim().toLowerCase().replace(/\\/g, '/');
  if (/\b(?:git-credential-manager(?:-core)?|manager-core)\.exe\b/.test(normalized) || /\/mnt\/[a-z]\/.+credential.+\.exe\b/.test(normalized)) {
    return 'windows-gcm';
  }
  if (/git-credential-manager(?:-core)?\b/.test(normalized)) return 'linux-gcm';
  return 'other';
}

function nonEmptyLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 32);
}

function readWindowsWslConfig(runner: WslCommandRunner): string {
  const command = "$p = Join-Path $env:USERPROFILE '.wslconfig'; if (Test-Path -LiteralPath $p) { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Content -LiteralPath $p -Raw -Encoding UTF8 }";
  const result = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], 5_000);
  return result.ok ? result.stdout : '';
}

function observedWslNetworkingMode(runner: WslCommandRunner): string | undefined {
  const result = runner('wslinfo', ['--networking-mode'], 3_000);
  return result.ok ? normalizeNetworkingMode(result.stdout) : undefined;
}

function credentialHelpers(scope: 'global' | 'system', runner: WslCommandRunner): Array<{ scope: 'global' | 'system'; kind: 'windows-gcm' | 'linux-gcm' | 'other' }> {
  const result = runner('git', ['config', `--${scope}`, '--get-all', 'credential.helper'], 3_000);
  if (!result.ok && result.status !== 1) return [];
  return nonEmptyLines(result.stdout).map((helper) => ({ scope, kind: credentialHelperKind(helper) }));
}

function endpointOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('WSL_DIAGNOSTIC_ENDPOINT_PROTOCOL_UNSUPPORTED');
  return parsed.origin;
}

function probeEndpoint(value: string, runner: WslCommandRunner): WslEndpointDiagnostic {
  const origin = endpointOrigin(value);
  const result = runner('curl', ['--silent', '--show-error', '--output', '/dev/null', '--write-out', '%{http_code}', '--connect-timeout', '3', '--max-time', '6', origin], 7_000);
  const status = Number(result.stdout.trim());
  const reachedHttp = Number.isInteger(status) && status >= 100 && status <= 599;
  return {
    origin,
    ok: result.ok && reachedHttp,
    ...(reachedHttp ? { status } : {}),
    timedOut: result.timedOut === true || /timed?\s*out/i.test(result.stderr),
  };
}

export function diagnoseWslDevelopmentNetwork(input: {
  env?: NodeJS.ProcessEnv;
  endpoints?: string[];
  runner?: WslCommandRunner;
} = {}): WslDevelopmentNetworkDiagnostic {
  const env = input.env ?? process.env;
  const runner = input.runner ?? defaultRunner;
  const distro = env.WSL_DISTRO_NAME?.trim() || undefined;
  const isWsl = Boolean(distro || env.WSL_INTEROP || env.WSLENV);
  const configured = parseWslConfig(isWsl ? readWindowsWslConfig(runner) : '');
  const observedNetworkingMode = isWsl ? observedWslNetworkingMode(runner) : undefined;
  const proxyNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const;
  const proxies = proxyNames.map((name) => {
    const value = env[name] ?? env[name.toLowerCase()];
    const hostClass = proxyHostClass(value);
    return { name, configured: Boolean(value?.trim()), ...(hostClass ? { hostClass } : {}) };
  });
  const gitCredentialHelpers = isWsl
    ? [...credentialHelpers('global', runner), ...credentialHelpers('system', runner)]
    : [];
  const endpoints = (input.endpoints ?? []).slice(0, 8).map((value) => probeEndpoint(value, runner));
  const issues: WslDevelopmentNetworkDiagnostic['issues'] = [];
  const configuredMode = normalizeNetworkingMode(configured.networkingMode);
  if (configuredMode && observedNetworkingMode && configuredMode !== observedNetworkingMode) {
    issues.push({
      code: 'WSL_NETWORKING_MODE_MISMATCH',
      detail: `.wslconfig requests ${configuredMode}, but the running WSL distro reports ${observedNetworkingMode}. A WSL shutdown/restart is required before treating the configured mode as active.`,
    });
  }
  const effectiveMode = observedNetworkingMode ?? configuredMode;
  if (effectiveMode === 'nat' && proxies.some((proxy) => proxy.hostClass === 'loopback')) {
    issues.push({
      code: 'WSL_NAT_LOCALHOST_PROXY',
      detail: 'WSL is using NAT while at least one proxy points at loopback. Windows localhost proxy mirroring is not assumed in NAT mode; use the Windows host address or switch to mirrored networking and restart WSL.',
    });
  }
  if (gitCredentialHelpers.some((helper) => helper.kind === 'windows-gcm')) {
    issues.push({
      code: 'WSL_WINDOWS_GCM_HELPER',
      detail: 'A Windows Git Credential Manager executable is configured inside WSL. This cross-platform helper can stall non-interactive Git; prefer a Linux-native helper or an explicit WSL credential configuration.',
    });
  }
  if (endpoints.some((endpoint) => !endpoint.ok && endpoint.timedOut)) {
    issues.push({
      code: 'NETWORK_ENDPOINT_STALL',
      detail: 'At least one bounded endpoint probe timed out while another network layer may still be healthy. Treat this as endpoint-specific evidence rather than a generic proxy failure.',
    });
  }
  return {
    isWsl,
    ...(distro ? { distro } : {}),
    configured,
    ...(observedNetworkingMode ? { observedNetworkingMode } : {}),
    proxies,
    gitCredentialHelpers,
    endpoints,
    issues,
  };
}

function safeDistro(value: string): string {
  const distro = value.trim();
  if (!distro || distro.length > 128 || /[\r\n'"`$;&|<>]/.test(distro)) throw new Error('RECOVERY_WSL_DISTRO_INVALID');
  return distro;
}

function psSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function canonicalWslWakeContract(input: { controllerHome: string; distro: string }): WindowsWslWakeContract {
  const controllerHome = resolve(input.controllerHome);
  if (!controllerHome.startsWith('/')) throw new Error('RECOVERY_WSL_CONTROLLER_HOME_ABSOLUTE_REQUIRED');
  const distro = safeDistro(input.distro);
  const runtimeUnit = `${forgeRuntimeServicePaths(controllerHome).label}.service`;
  const connector = readPackageConnectorServiceAuthority(controllerHome);
  if (!connector || connector.mode !== 'systemd-user' || !connector.servicePath) {
    throw new Error('RECOVERY_WSL_CONNECTOR_SYSTEMD_AUTHORITY_REQUIRED');
  }
  const connectorUnit = basename(connector.servicePath);
  if (!connectorUnit.endsWith('.service') || !/^[-A-Za-z0-9_.@]+\.service$/.test(connectorUnit)) {
    throw new Error('RECOVERY_WSL_CONNECTOR_SYSTEMD_UNIT_INVALID');
  }
  const taskSuffix = distro.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'default';
  return {
    distro,
    controllerHome,
    runtimeUnit,
    connectorUnit,
    taskName: `Forge Recovery WSL Wake - ${taskSuffix}`,
  };
}

export function renderWindowsWslRecoveryWakePowerShell(contract: WindowsWslWakeContract): string {
  const distro = psSingleQuoted(safeDistro(contract.distro));
  const runtimeUnit = psSingleQuoted(contract.runtimeUnit);
  const connectorUnit = psSingleQuoted(contract.connectorUnit);
  const controllerHome = psSingleQuoted(resolve(contract.controllerHome));
  return [
    "$ErrorActionPreference = 'Stop'",
    "$wsl = Join-Path $env:WINDIR 'System32\\wsl.exe'",
    `& $wsl --distribution ${distro} --exec systemctl --user start ${runtimeUnit} ${connectorUnit}`,
    "if ($LASTEXITCODE -ne 0) { throw \"Forge Recovery WSL systemd start failed with exit code $LASTEXITCODE\" }",
    `& $wsl --distribution ${distro} --exec systemctl --user is-active ${runtimeUnit} ${connectorUnit}`,
    "if ($LASTEXITCODE -ne 0) { throw \"Forge Recovery WSL service verification failed with exit code $LASTEXITCODE\" }",
    `& $wsl --distribution ${distro} --exec forge recovery status --controller-home ${controllerHome}`,
    "if ($LASTEXITCODE -ne 0) { throw \"Forge Recovery status verification failed with exit code $LASTEXITCODE\" }",
    '',
  ].join('\r\n');
}

export function installWindowsWslRecoveryWakeTask(input: {
  controllerHome: string;
  distro: string;
  runner?: WslCommandRunner;
}): WindowsWslWakeInstallResult {
  const runner = input.runner ?? defaultRunner;
  const contract = canonicalWslWakeContract(input);
  const wakeScript = renderWindowsWslRecoveryWakePowerShell(contract);
  const contentBase64 = Buffer.from(wakeScript, 'utf8').toString('base64');
  const installer = [
    "$ErrorActionPreference = 'Stop'",
    "$root = Join-Path $env:LOCALAPPDATA 'Forge\\Recovery'",
    "New-Item -ItemType Directory -Force -Path $root | Out-Null",
    "$scriptPath = Join-Path $root 'wsl-wake.ps1'",
    `$content = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psSingleQuoted(contentBase64)}))`,
    "[IO.File]::WriteAllText($scriptPath, $content, (New-Object Text.UTF8Encoding($false)))",
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -File "' + $scriptPath + '"')`,
    '$trigger = New-ScheduledTaskTrigger -AtLogOn',
    `$task = Register-ScheduledTask -TaskName ${psSingleQuoted(contract.taskName)} -Action $action -Trigger $trigger -Description 'Forge Recovery WSL cold-start trigger; lifecycle repair remains inside canonical Forge Recovery/systemd authority.' -Force`,
    `$task | Out-Null; Start-ScheduledTask -TaskName ${psSingleQuoted(contract.taskName)}`,
    'Write-Output $scriptPath',
  ].join('; ');
  const installed = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', installer], 20_000);
  const scriptPath = nonEmptyLines(installed.stdout).at(-1);
  return {
    ok: installed.ok,
    contract,
    ...(scriptPath ? { scriptPath } : {}),
    detail: installed.ok
      ? 'Windows Scheduled Task installed and triggered once. It only cold-starts WSL and starts the already-authoritative Forge systemd units; it owns no restart policy or Runtime state.'
      : `Windows WSL wake task installation failed: ${String(installed.stderr || installed.stdout || installed.status || 'unknown error').trim().slice(0, 1_000)}`,
  };
}
