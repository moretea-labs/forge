import { describe, expect, test } from 'bun:test';
import { createDesktopOperatorRegistrationInput } from '../../src/runtime/plugins/desktop-operator-registration';
import { validateMacOsCapabilityBrokerHandshake } from '../../src/runtime/plugins/macos-capability-broker';
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
    expect(input.pluginVersion).toBe('0.2.1');
    expect(input.capabilities.map((capability) => capability.capabilityId)).toEqual([
      'desktop.status',
      'desktop.permissions',
      'desktop.session',
      'desktop.observe',
      'desktop.interact',
      'desktop.capture',
      'desktop.clipboard',
      'desktop.batch',
    ]);
    expect(input.capabilities.find((capability) => capability.capabilityId === 'desktop.interact')?.actions).toEqual([
      'desktop_press',
      'desktop_pointer_click',
      'desktop_type_text',
      'desktop_key',
      'desktop_open_url',
    ]);
    expect(input.actions.map((action) => action.actionId)).toEqual([
      'desktop_status',
      'desktop_permissions_request',
      'desktop_session_open',
      'desktop_observe',
      'desktop_press',
      'desktop_pointer_click',
      'desktop_type_text',
      'desktop_key',
      'desktop_clipboard_read',
      'desktop_clipboard_write',
      'desktop_copy',
      'desktop_paste',
      'desktop_open_url',
      'desktop_screenshot',
      'desktop_batch',
      'desktop_session_close',
    ]);
    for (const action of input.actions.filter((action) => action.readOnly)) {
      expect(action.risk).toBe('readonly');
    }
    for (const action of input.actions.filter((action) => ['desktop_permissions_request', 'desktop_press', 'desktop_pointer_click', 'desktop_type_text', 'desktop_key', 'desktop_clipboard_write', 'desktop_copy', 'desktop_paste', 'desktop_open_url', 'desktop_batch'].includes(action.actionId))) {
      expect(action.risk).toBe('workspace_write');
      expect(action.confirmation).toBe('authorization');
    }
    const press = input.actions.find((action) => action.actionId === 'desktop_press');
    const pressSchema = press?.argumentsSchema as { properties?: Record<string, { enum?: string[] } | undefined> } | undefined;
    expect(pressSchema?.properties?.semantic_action?.enum).toEqual(['press', 'show_menu', 'pick', 'open', 'confirm', 'scroll_down_page', 'scroll_up_page']);
    expect(pressSchema?.properties?.force_coordinate).toBeUndefined();
    expect(pressSchema?.properties?.coordinate_fallback).toBeUndefined();
    expect(press?.description).toContain('one-page list scrolling');
    expect(press?.description).toContain('pointer/coordinate and raw input fallback are intentionally unavailable');
    const pointerClick = input.actions.find((action) => action.actionId === 'desktop_pointer_click');
    expect(pointerClick).toMatchObject({ confirmation: 'authorization', scopes: ['desktop.interact', 'desktop.capture'] });
    expect(pointerClick?.argumentsSchema?.required).toEqual(['interaction_id', 'selector', 'window_id']);
    const pointerSchema = pointerClick?.argumentsSchema as { properties?: Record<string, unknown> } | undefined;
    expect(pointerSchema?.properties?.x).toBeUndefined();
    expect(pointerSchema?.properties?.y).toBeUndefined();
    expect(pointerSchema?.properties?.visual_revision).toBeUndefined();
    expect(pointerClick?.description).toContain('fails closed on stale refs/windows');
    expect(pointerClick?.description).toContain('raw coordinates are never accepted');
    expect(input.actions.find((action) => action.actionId === 'desktop_foreground_pointer_click')).toBeUndefined();
    const observe = input.actions.find((action) => action.actionId === 'desktop_observe');
    const observeSchema = observe?.argumentsSchema as { properties?: {
      root_selector?: { properties?: { ref?: { type?: string } } };
      include_actions?: { type?: string };
      include_windows?: { type?: string };
    } } | undefined;
    expect(observeSchema?.properties?.root_selector?.properties?.ref).toEqual({ type: 'string' });
    expect(observeSchema?.properties?.include_actions).toMatchObject({ type: 'boolean' });
    expect(observeSchema?.properties?.include_windows).toMatchObject({ type: 'boolean' });
    expect(input.actions.find((action) => action.actionId === 'desktop_screenshot')?.confirmation).toBe('authorization');
    const clipboardRead = input.actions.find((action) => action.actionId === 'desktop_clipboard_read');
    expect(clipboardRead).toMatchObject({ readOnly: true, risk: 'readonly', confirmation: 'authorization', scopes: ['desktop.clipboard'] });
    for (const actionId of ['desktop_copy', 'desktop_paste']) {
      const action = input.actions.find((candidate) => candidate.actionId === actionId);
      expect(action?.argumentsSchema?.required).toEqual(['interaction_id']);
      expect(action?.description).toContain('already foreground');
      expect(action?.description).toContain('never activates it');
    }
    expect(input.permissions.some((permission) => permission.scope === 'desktop.clipboard' && permission.granted)).toBe(true);
    const permissionRequest = input.actions.find((action) => action.actionId === 'desktop_permissions_request');
    expect(permissionRequest).toMatchObject({ confirmation: 'authorization', scopes: ['desktop.permissions'], idempotent: true });
    const permissionArgumentsSchema = permissionRequest?.argumentsSchema as {
      properties?: { services?: { minItems?: number; maxItems?: number; uniqueItems?: boolean } };
    } | undefined;
    expect(permissionArgumentsSchema?.properties?.services).toMatchObject({ minItems: 1, maxItems: 2, uniqueItems: true });
    expect(permissionRequest?.description).toContain('macOS may foreground');
    expect(input.permissions.some((permission) => permission.scope === 'desktop.permissions' && permission.granted)).toBe(true);
  });

  test('requires the declared browser capability contract before dispatching an automation action', () => {
    expect(() => validateMacOsCapabilityBrokerHandshake({
      pluginId: 'desktop_operator',
      pluginVersion: '0.2.1',
      protocolVersion: '1.0',
    }, 'metadata')).toThrow('PLUGIN_MACOS_CAPABILITY_BROKER_CAPABILITY_UNSUPPORTED');

    expect(() => validateMacOsCapabilityBrokerHandshake({
      pluginId: 'desktop_operator',
      pluginVersion: '0.2.1',
      protocolVersion: '1.0',
      internalCapabilities: ['macos_browser_automation.v1'],
      browserAutomationProtocolVersion: 1,
      browserAutomationActions: ['metadata'],
    }, 'metadata')).not.toThrow();

    let observed: unknown;
    try {
      validateMacOsCapabilityBrokerHandshake({
        pluginId: 'desktop_operator',
        pluginVersion: '0.2.1',
        protocolVersion: '1.0',
        internalCapabilities: ['macos_browser_automation.v1'],
        browserAutomationProtocolVersion: 1,
        browserAutomationActions: ['reload'],
      }, 'metadata');
    } catch (error) {
      observed = error;
    }
    expect(observed).toMatchObject({ code: 'PLUGIN_MACOS_CAPABILITY_BROKER_CAPABILITY_UNSUPPORTED' });
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
    expect(installed.transport.kind).toBe('unix_socket_jsonl');
    if (installed.transport.kind !== 'unix_socket_jsonl') throw new Error('expected unix socket transport');
    expect(installed.transport.socketPath).toBe('/tmp/forge-desktop-operator.sock');
    expect(installed.legacyIdentities).toContain('Repo Harness Desktop Operator');
  });
});
