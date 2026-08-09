import { describe, expect, test } from 'bun:test';
import { createDesktopOperatorRegistrationInput } from '../../src/runtime/plugins/desktop-operator-registration';
import { installExternalPluginRegistration } from '../../src/runtime/plugins/external-registration';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Desktop Operator trusted external registration', () => {
  test('Forge owns the complete provider action policy', () => {
    const input = createDesktopOperatorRegistrationInput({ socketPath: '/tmp/forge-desktop-operator.sock' });
    expect(input.pluginId).toBe('desktop_operator');
    expect(input.providerPluginId).toBe('desktop_operator');
    expect(input.displayName).toBe('Forge Desktop Operator');
    expect(input.capabilities.map((capability) => capability.capabilityId)).toEqual([
      'desktop.status',
      'desktop.session',
      'desktop.observe',
      'desktop.interact',
      'desktop.capture',
      'desktop.batch',
    ]);
    expect(input.actions.map((action) => action.actionId)).toEqual([
      'desktop_status',
      'desktop_session_open',
      'desktop_observe',
      'desktop_press',
      'desktop_type_text',
      'desktop_key',
      'desktop_open_url',
      'desktop_screenshot',
      'desktop_batch',
      'desktop_session_close',
    ]);
    for (const action of input.actions.filter((action) => action.readOnly)) {
      expect(action.risk).toBe('readonly');
    }
    for (const action of input.actions.filter((action) => ['desktop_press', 'desktop_type_text', 'desktop_key', 'desktop_open_url', 'desktop_batch'].includes(action.actionId))) {
      expect(action.risk).toBe('workspace_write');
      expect(action.confirmation).toBe('authorization');
    }
    expect(input.actions.find((action) => action.actionId === 'desktop_screenshot')?.confirmation).toBe('authorization');
  });

  test('binds optional provider lifecycle to one verified user LaunchAgent identity', () => {
    const input = createDesktopOperatorRegistrationInput({
      socketPath: '/tmp/forge-desktop-operator.sock',
      launchAgentLabel: 'com.moretea.desktop-operator',
      expectedProgramContains: 'forge-desktop-operator',
    });
    expect(input.lifecycle).toEqual({
      kind: 'verified_user_launch_agent',
      label: 'com.moretea.desktop-operator',
      expectedProgramContains: 'forge-desktop-operator',
    });
    expect(input.actions.map((action) => action.actionId)).not.toContain('provider_restart');
  });

  test('installs through the existing CAS/fingerprinted registration authority', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-desktop-registration-'));
    const installed = installExternalPluginRegistration(
      controllerHome,
      createDesktopOperatorRegistrationInput({ socketPath: '/tmp/forge-desktop-operator.sock' }),
    );
    expect(installed.revision).toBe(1);
    expect(installed.registrationFingerprint).toHaveLength(64);
    expect(installed.transport.socketPath).toBe('/tmp/forge-desktop-operator.sock');
    expect(installed.legacyIdentities).toContain('Repo Harness Desktop Operator');
  });
});
