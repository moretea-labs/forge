import { describe, expect, test } from 'bun:test';
import { mcpToolCallTraceRequests } from '../../adapters/mcp/transports/http';

describe('MCP HTTP transport trace identity', () => {
  test('extracts the JSON-RPC id, tool name, and forwarded runtime session', () => {
    expect(
      mcpToolCallTraceRequests({
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'rh_status',
          arguments: { detail_level: 'summary' },
          _meta: {
            forgeRuntimeForwarding: {
              sessionId: 'outer-session-21',
            },
          },
        },
      }),
    ).toEqual([
      {
        rpcId: 21,
        tool: 'rh_status',
        forwardedSessionId: 'outer-session-21',
      },
    ]);
  });

  test('supports JSON-RPC batches and ignores non-tool calls and notifications', () => {
    expect(
      mcpToolCallTraceRequests([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'rh_status' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', method: 'tools/call', params: { name: 'rh_context' } },
        { jsonrpc: '2.0', id: 'bad', method: 'tools/call', params: { name: '  ' } },
      ]),
    ).toEqual([{ rpcId: 1, tool: 'rh_status' }]);
  });
});
