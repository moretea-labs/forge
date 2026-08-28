import { describe, expect, test } from 'bun:test';
import { legacyIosPluginInvocation } from '../../src/runtime/gateway/mcp/legacy-ios-tool-adapter';

describe('legacy iOS tool compatibility adapter', () => {
  test('translates legacy build input to the canonical typed iOS plugin action without keeping undefined compatibility fields', () => {
    expect(legacyIosPluginInvocation('ios_app_build', {
      request_id: 'build-request',
      scheme: 'ForgeApp',
      simulator_name: 'iPhone 17',
      timeout_ms: 42_000,
      confirm_authorization: true,
    })).toEqual({
      actionId: 'build',
      requestId: 'build-request',
      arguments: {
        scheme: 'ForgeApp',
        simulator_name: 'iPhone 17',
        timeout_ms: 42_000,
      },
      confirmAuthorization: true,
    });
  });

  test('keeps retired or unrelated tool names outside the compatibility translation boundary', () => {
    expect(legacyIosPluginInvocation('ios_app_install', {})).toBeUndefined();
    expect(legacyIosPluginInvocation('rh_work', {})).toBeUndefined();
  });
});
