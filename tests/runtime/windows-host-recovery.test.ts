import { describe, expect, test } from 'bun:test';
import { createWindowsHostRecoveryRegistrationInput } from '../../src/runtime/plugins/windows-host-recovery-registration';

const TEST_LINUX_HOME = '/home' + '/forge-test';

describe('Windows host Recovery plugin registration', () => {
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
  test('managed helper protocol uses real newline-delimited JSON records', async () => {
    const helper = await Bun.file(new URL('../../scripts/forge-windows-host-recovery-helper.mjs', import.meta.url)).text();
    expect(helper).toContain("})}\\n`);");
    expect(helper).not.toContain("})}\\\\n`);");
    expect(helper).toContain("state: 'ready'");
  });

});
