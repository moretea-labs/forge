import { describe, expect, test } from 'bun:test';
import { proxyCanonicalRuntimeToolIfOwned, shouldProxyRuntimeToolCall } from '../../src/cli/mcp/server';

describe('MCP canonical Runtime per-tool proxy routing', () => {
  test('proxies a Runtime-owned tool even when unrelated newer marker tools are absent', () => {
    const olderCanonicalRuntime = {
      tools: [
        { name: 'repository_command_execute' },
        { name: 'controller_ready' },
      ],
    };

    expect(shouldProxyRuntimeToolCall(olderCanonicalRuntime, 'repository_command_execute')).toBe(true);
  });

  test('does not proxy a tool that the canonical Runtime does not expose', () => {
    const canonicalRuntime = {
      tools: [
        { name: 'repository_command_execute' },
        { name: 'controller_ready' },
      ],
    };

    expect(shouldProxyRuntimeToolCall(canonicalRuntime, 'capability_recovery_apply')).toBe(false);
  });

  test('falls back only when Runtime discovery fails before ownership is established', async () => {
    let called = false;
    const routed = await proxyCanonicalRuntimeToolIfOwned({
      name: 'repository_command_execute',
      runtimeReady: false,
      listTools: async () => { throw new Error('runtime unavailable'); },
      callTool: async () => { called = true; return 'unexpected'; },
    });
    expect(routed).toEqual({ handled: false });
    expect(called).toBe(false);
  });

  test('fails closed when a ready Runtime cannot complete tool discovery', async () => {
    await expect(proxyCanonicalRuntimeToolIfOwned({
      name: 'repository_command_execute',
      runtimeReady: true,
      listTools: async () => { throw new Error('runtime discovery failed'); },
      callTool: async () => 'unexpected',
    })).rejects.toThrow('runtime discovery failed');
  });

  test('propagates canonical Runtime call failure after tool ownership is established', async () => {
    await expect(proxyCanonicalRuntimeToolIfOwned({
      name: 'repository_command_execute',
      runtimeReady: true,
      listTools: async () => ({ tools: [{ name: 'repository_command_execute' }] }),
      callTool: async () => { throw new Error('canonical call failed'); },
    })).rejects.toThrow('canonical call failed');
  });
});
