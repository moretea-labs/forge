import { describe, expect, test } from 'bun:test';
import { mcpPluginExecutionOrigin } from '../../src/runtime/plugins/execution-origin';

describe('MCP plugin execution origin', () => {
  test('uses the authenticated principal instead of the generic tool actor', () => {
    expect(mcpPluginExecutionOrigin(
      ' oauth-client:test-principal ',
      'plugin_action_execute',
      'request-1',
    )).toEqual({
      surface: 'mcp',
      actor: 'oauth-client:test-principal',
      correlationId: 'request-1',
    });
  });

  test('retains the explicit compatibility actor when no principal exists', () => {
    expect(mcpPluginExecutionOrigin(undefined, 'plugin_action_execute', 'request-2')).toEqual({
      surface: 'mcp',
      actor: 'plugin_action_execute',
      correlationId: 'request-2',
    });
  });
});
