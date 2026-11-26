import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWindowsHostRecoveryRegistrationInput } from '../../src/runtime/plugins/windows-host-recovery-registration';
import { installWindowsHostRecoveryPlugin } from '../../src/runtime/plugins/windows-host-recovery-install';
import { parseTaskStatus } from '../../scripts/forge-windows-host-recovery-helper.mjs';

const TEST_LINUX_HOME = '/home' + '/forge-test';

describe('Windows host Recovery plugin registration', () => {
  test('exposes native Windows startup verification as typed status, not only a successful shell result', () => {
    expect(parseTaskStatus(JSON.stringify({ installed: true, method: 'hkcu_run', identityMatches: true }))).toEqual({
      installed: true,
      method: 'hkcu_run',
      identityMatches: true,
    });
    expect(parseTaskStatus(JSON.stringify({ installed: false, method: 'none', identityMatches: false }))).toEqual({
      installed: false,
      method: 'none',
      identityMatches: false,
    });
    expect(
      parseTaskStatus(
        JSON.stringify({
          installed: true,
          method: 'scheduled_task',
          identityMatches: true,
          watchdog: true,
          state: 'Running',
        }),
      ),
    ).toEqual({ installed: true, method: 'scheduled_task', identityMatches: true });
  });

  test('rejects malformed or inconsistent task receipts instead of inferring installation from exit code 0', () => {
    for (const output of [
      'not json',
      '{}',
      '[]',
      '{"installed":"true","method":"hkcu_run"}',
      '{"installed":true,"method":"none"}',
      '{"installed":true,"method":"hkcu_run","identityMatches":false}',
      '{"installed":true,"method":"scheduled_task","identityMatches":false}',
      '{"installed":true,"method":"scheduled_task"}',
    ]) {
      expect(() => parseTaskStatus(output)).toThrow('Windows Recovery task_status');
    }
  });

  test('exposes only fixed no-argument host recovery actions', () => {
    const registration = createWindowsHostRecoveryRegistrationInput({
      runtimeExecutable: '/usr/bin/node',
      helperPath: `${TEST_LINUX_HOME}/.forge-recovery/bin/forge-windows-host-recovery-helper.mjs`,
      configDirectory: `${TEST_LINUX_HOME}/.forge/controller/system/plugins/windows-host-recovery`,
    });
    expect(registration.pluginId).toBe('windows_host_recovery');
    expect(registration.provider).toBe('local-wsl-windows');
    expect(registration.scope).toBe('controller');
    expect(registration.actions.some((action) => action.actionId === 'task_install')).toBe(true);
    expect(registration.actions.some((action) => action.actionId === 'full_recover')).toBe(true);
    for (const action of registration.actions) {
      expect(action.argumentsSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    }
  });

  test('keeps observation read-only and mutations authorization-gated', () => {
    const registration = createWindowsHostRecoveryRegistrationInput({
      runtimeExecutable: '/usr/bin/node',
      helperPath: '/tmp/helper.mjs',
      configDirectory: '/tmp/windows-host-recovery',
    });
    const status = registration.actions.find((action) => action.actionId === 'task_status');
    const install = registration.actions.find((action) => action.actionId === 'task_install');
    expect(status).toMatchObject({ readOnly: true, risk: 'readonly', confirmation: 'none' });
    expect(install).toMatchObject({ readOnly: false, risk: 'remote_write', confirmation: 'authorization' });
  });

  test('installs from the packaged helper without source cwd or canonical rescue-root assumptions', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-windows-recovery-install-'));
    const previousCwd = process.cwd();
    try {
      const controllerHome = join(root, 'controller');
      const rescueRoot = join(root, 'custom-rescue');
      const recoveryScript = join(root, 'ForgeRecovery.ps1');
      const powershell = join(root, 'powershell.exe');
      writeFileSync(recoveryScript, 'Write-Output "fixture"\n', 'utf8');
      writeFileSync(powershell, '', 'utf8');
      process.chdir(tmpdir());
      const result = installWindowsHostRecoveryPlugin({
        controllerHome,
        rescueRoot,
        recoveryScriptHostPath: recoveryScript,
        recoveryScriptWindowsPath: 'D:\\Recovery\\ForgeRecovery.ps1',
        powershellHostPath: powershell,
        powershellWindowsPath: 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      }) as { helperPath: string; configPath: string; deployment: { rescueRoot: string } };
      expect(result.deployment.rescueRoot).toBe(rescueRoot);
      expect(result.helperPath.startsWith(rescueRoot)).toBe(true);
      expect(existsSync(result.helperPath)).toBe(true);
      expect(existsSync(result.configPath)).toBe(true);
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('installs a continuous WSL recovery watchdog instead of one-shot logon recovery', async () => {
    const recoveryScript = await Bun.file(new URL('../../assets/recovery/ForgeRecovery.ps1', import.meta.url)).text();
    expect(recoveryScript).toContain('$WatchCommand');
    expect(recoveryScript).toContain('-ExecutionTimeLimit ([TimeSpan]::Zero)');
    expect(recoveryScript).toContain('-RestartCount 3');
    expect(recoveryScript).toContain('-RestartInterval (New-TimeSpan -Minutes 1)');
    expect(recoveryScript).toContain('-MultipleInstances IgnoreNew');
    expect(recoveryScript).toContain('continuous recovery watchdog');
    expect(recoveryScript).toContain("'forge_cloud_verify', 'full_recover', 'watch'");
  });

  test('managed helper protocol uses real newline-delimited JSON records', async () => {
    const helper = await Bun.file(
      new URL('../../scripts/forge-windows-host-recovery-helper.mjs', import.meta.url),
    ).text();
    expect(helper).toContain('})}\\n`');
    expect(helper).not.toContain('})}\\\\n`');
    expect(helper).toContain("state: 'ready'");
    expect(helper).toContain('config.deployment.powershellHostPath');
    expect(helper).toContain('config.deployment.recoveryScriptWindowsPath');
    expect(helper).not.toContain('C:\\ProgramData\\ForgeRecovery');
    expect(helper).not.toContain('/mnt/c/ProgramData/ForgeRecovery');
  });
});
