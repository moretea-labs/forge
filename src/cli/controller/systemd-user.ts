import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { mkdirSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

export interface SystemdUserUnitInput {
  description?: string;
  executable: string;
  args: string[];
  environment: Record<string, string>;
  restart?: 'no' | 'on-failure' | 'always';
  restartSec?: number;
}

function atomicWrite(path: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode });
  renameSync(temporary, path);
}

export function systemdEscape(value: string): string {
  return `"${value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function renderSystemdUserUnit(input: SystemdUserUnitInput): string {
  const environment = Object.entries(input.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `Environment=${systemdEscape(`${key}=${value}`)}`)
    .join('\n');
  return [
    '[Unit]',
    `Description=${input.description ?? 'Forge service'}`,
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${[input.executable, ...input.args].map(systemdEscape).join(' ')}`,
    ...(environment ? [environment] : []),
    `Restart=${input.restart ?? 'on-failure'}`,
    `RestartSec=${Math.max(1, Math.trunc(input.restartSec ?? 5))}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function commandSucceeded(command: string, args: string[], env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync(command, args, { encoding: 'utf8', env, timeout: 30_000 });
}

export function systemdUserAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return commandSucceeded('systemctl', ['--user', 'show-environment'], env).status === 0;
}

export function systemdUserUnitName(label: string): string {
  const normalized = label.trim();
  if (!normalized) throw new Error('SYSTEMD_USER_UNIT_LABEL_REQUIRED');
  return normalized.endsWith('.service') ? normalized : `${normalized}.service`;
}

export function systemdUserUnitPath(unitName: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? homedir(), '.config', 'systemd', 'user', systemdUserUnitName(unitName));
}

export function systemdUserInstallCommands(unitName: string): string[][] {
  const unit = systemdUserUnitName(unitName);
  return [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', unit],
    ['--user', 'restart', unit],
  ];
}

export function writeSystemdUserUnit(
  unitName: string,
  input: SystemdUserUnitInput,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const unitPath = systemdUserUnitPath(unitName, env);
  atomicWrite(unitPath, renderSystemdUserUnit(input), 0o644);
  return unitPath;
}

export function installSystemdUserUnit(input: {
  unitName: string;
  unit: SystemdUserUnitInput;
  env?: NodeJS.ProcessEnv;
  errorPrefix?: string;
}): string {
  const env = input.env ?? process.env;
  const unit = systemdUserUnitName(input.unitName);
  const unitPath = writeSystemdUserUnit(unit, input.unit, env);
  for (const args of systemdUserInstallCommands(unit)) {
    const result = commandSucceeded('systemctl', args, env);
    if (result.status !== 0) {
      const prefix = input.errorPrefix?.trim() || 'SYSTEMD_USER_INSTALL_FAILED';
      throw new Error(`${prefix}: systemctl ${args.join(' ')}: ${(result.stderr || result.stdout || '').trim()}`);
    }
  }
  return unitPath;
}

export function systemdUserServicePid(unitName: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const result = commandSucceeded('systemctl', ['--user', 'show', '--property', 'MainPID', '--value', systemdUserUnitName(unitName)], env);
  if (result.status !== 0) return undefined;
  const pid = Number(result.stdout.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}
