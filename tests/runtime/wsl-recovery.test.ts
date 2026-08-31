import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  canonicalWslWakeContract,
  diagnoseWslDevelopmentNetwork,
  installWindowsWslRecoveryWakeTask,
  parseWslConfig,
  renderWindowsWslRecoveryWakePowerShell,
  type WslCommandRunner,
} from '../../src/runtime/standalone-recovery/wsl-host';
import { packageConnectorServicePaths } from '../../src/runtime/root/package-connector-service';

function runner(fixtures: Record<string, { status?: number; stdout?: string; stderr?: string; timedOut?: boolean }>): WslCommandRunner {
  return (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    const fixture = fixtures[key] ?? fixtures[command] ?? { status: 1 };
    const status = fixture.status ?? 0;
    return {
      ok: status === 0 && !fixture.timedOut,
      status,
      stdout: fixture.stdout ?? '',
      stderr: fixture.stderr ?? '',
      ...(fixture.timedOut ? { timedOut: true } : {}),
    };
  };
}

function controllerHome(): string {
  return mkdtempSync(join(tmpdir(), 'forge-wsl-recovery-'));
}

function writeSystemdConnectorAuthority(home: string): void {
  const paths = packageConnectorServicePaths(home, join(home, 'account'));
  mkdirSync(dirname(paths.authorityPath), { recursive: true });
  writeFileSync(paths.authorityPath, `${JSON.stringify({
    schemaVersion: 1,
    endpoint: 'http://127.0.0.1:9876/mcp',
    releaseId: 'release-test',
    releaseRoot: join(home, 'runtime', 'releases', 'release-test'),
    packageRoot: join(home, 'package'),
    mode: 'systemd-user',
    persistent: true,
    servicePath: join(home, 'account', '.config', 'systemd', 'user', `${paths.label}.service`),
    installedAt: '2026-08-31T00:00:00.000Z',
  }, null, 2)}\n`);
}

describe('Windows/WSL Recovery wake and diagnostics', () => {
  test('parses only [wsl2] network settings', () => {
    expect(parseWslConfig(`
[wsl2]
networkingMode=mirrored
autoProxy=true
dnsTunneling=true
localhostForwarding=false
[experimental]
autoMemoryReclaim=gradual
`)).toEqual({ networkingMode: 'mirrored', autoProxy: true, dnsTunneling: true, localhostForwarding: false });
  });

  test('identifies networking mismatch, NAT loopback proxy, Windows GCM contamination, and endpoint stalls without returning secrets', () => {
    const diagnostic = diagnoseWslDevelopmentNetwork({
      env: {
        WSL_DISTRO_NAME: 'Ubuntu-24.04',
        HTTP_PROXY: 'http://secret-user:secret-pass@127.0.0.1:7890',
      },
      endpoints: ['https://github.com/private/path?token=do-not-return'],
      runner: runner({
        'powershell.exe': { stdout: '[wsl2]\nnetworkingMode=mirrored\nautoProxy=true\n' },
        'wslinfo --networking-mode': { stdout: 'NAT\n' },
        'git config --global --get-all credential.helper': { stdout: '/mnt/c/Program Files/Git/mingw64/bin/git-credential-manager.exe\n' },
        'git config --system --get-all credential.helper': { status: 1 },
        'curl': { status: 28, stderr: 'Operation timed out', timedOut: true },
      }),
    });
    expect(diagnostic.issues.map((issue) => issue.code)).toEqual([
      'WSL_NETWORKING_MODE_MISMATCH',
      'WSL_NAT_LOCALHOST_PROXY',
      'WSL_WINDOWS_GCM_HELPER',
      'NETWORK_ENDPOINT_STALL',
    ]);
    expect(diagnostic.endpoints).toEqual([{ origin: 'https://github.com', ok: false, timedOut: true }]);
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toContain('secret-user');
    expect(serialized).not.toContain('secret-pass');
    expect(serialized).not.toContain('do-not-return');
    expect(serialized).not.toContain('Program Files');
  });

  test('renders a Windows host wake that starts only the existing canonical systemd units', () => {
    const home = controllerHome();
    writeSystemdConnectorAuthority(home);
    const contract = canonicalWslWakeContract({ controllerHome: home, distro: 'Ubuntu-24.04' });
    const script = renderWindowsWslRecoveryWakePowerShell(contract);
    expect(contract.runtimeUnit).toMatch(/^com\.moretea\.forge\.runtime\.[a-f0-9]{12}\.service$/);
    expect(contract.connectorUnit).toMatch(/^com\.moretea\.forge\.mcp-gateway\.[a-f0-9]{12}\.service$/);
    expect(script).toContain("wsl.exe");
    expect(script).toContain("systemctl --user start");
    expect(script).toContain(contract.runtimeUnit);
    expect(script).toContain(contract.connectorUnit);
    expect(script).toContain('forge recovery status');
    expect(script).not.toContain('restart-runtime');
    expect(script).not.toContain('tunnel-client runtimes connect');
  });

  test('fails closed when no systemd Connector authority exists', () => {
    const home = controllerHome();
    expect(() => canonicalWslWakeContract({ controllerHome: home, distro: 'Ubuntu' })).toThrow('RECOVERY_WSL_CONNECTOR_SYSTEMD_AUTHORITY_REQUIRED');
  });

  test('installs one Windows logon task and immediately triggers the same bounded wake path', () => {
    const home = controllerHome();
    writeSystemdConnectorAuthority(home);
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = installWindowsWslRecoveryWakeTask({
      controllerHome: home,
      distro: 'Ubuntu',
      runner: (command, args) => {
        calls.push({ command, args });
        return { ok: true, status: 0, stdout: 'C:\\Users\\greyson\\AppData\\Local\\Forge\\Recovery\\wsl-wake.ps1\r\n', stderr: '' };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.scriptPath).toEndWith('wsl-wake.ps1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('powershell.exe');
    const installerCommand = calls[0]!.args.at(-1)!;
    expect(installerCommand).toContain('Register-ScheduledTask');
    expect(installerCommand).toContain('New-ScheduledTaskTrigger -AtLogOn');
    expect(installerCommand).toContain('Start-ScheduledTask');
    expect(installerCommand).not.toContain('New-ScheduledTaskTrigger -Once');
  });
});
