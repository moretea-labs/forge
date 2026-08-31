import { describe, expect, test } from 'bun:test';
import { createUuRemoteRescueRegistrationInput, UU_REMOTE_RESCUE_CAPABILITIES } from '../../src/runtime/plugins/uu-remote-rescue-registration';

describe('UU Remote rescue registration', () => {
  test('exposes only typed allowlisted rescue actions with no shell/device selector arguments', () => {
    const registration = createUuRemoteRescueRegistrationInput({
      runtimeExecutable: '/usr/bin/node',
      helperPath: '/opt/forge/scripts/forge-uu-remote-rescue-helper.mjs',
      configDirectory: '/tmp/forge-uu-rescue',
    });
    expect(registration).toMatchObject({ pluginId: 'uu_remote_rescue', provider: 'local-macos', scope: 'controller' });
    expect(registration.transport).toMatchObject({ kind: 'managed_cli_json', requiredCapabilities: [...UU_REMOTE_RESCUE_CAPABILITIES] });
    expect(registration.actions.map((action) => action.actionId)).toEqual([
      'device_status', 'wsl_status', 'forge_health', 'runtime_start', 'runtime_restart', 'connector_start', 'connector_restart', 'recovery_start', 'recovery_restart', 'runtime_recover',
    ]);
    for (const action of registration.actions) {
      expect(action.argumentsSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
      expect(JSON.stringify(action.argumentsSchema)).not.toMatch(/command|shell|device|service|path/i);
    }
    expect(registration.actions.find((action) => action.actionId === 'device_status')).toMatchObject({ readOnly: true, risk: 'readonly' });
    for (const id of ['runtime_start', 'runtime_restart', 'connector_start', 'connector_restart', 'recovery_start', 'recovery_restart', 'runtime_recover']) {
      expect(registration.actions.find((action) => action.actionId === id)).toMatchObject({ readOnly: false, risk: 'remote_write', confirmation: 'authorization' });
    }
  });
});
