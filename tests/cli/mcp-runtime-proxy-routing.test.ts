import { describe, expect, test } from 'bun:test';
import { shouldProxyRuntimeToolCall } from '../../src/cli/mcp/server';

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
});
