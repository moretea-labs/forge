import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { buildMcpToolDefinitions, callMcpTool, type McpToolContext } from '../../src/cli/mcp/tools';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): McpToolContext {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-direct-agent-'));
  roots.push(root);
  mkdirSync(join(root, '.ai/harness'), { recursive: true });
  mkdirSync(join(root, '.repo-harness'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  return { repoRoot: root, policy: getMcpPolicy('controller', { repoRoot: root }) };
}

function value(result: Awaited<ReturnType<typeof callMcpTool>>): Record<string, any> {
  return JSON.parse(result.content[0]!.text);
}

describe('direct local agent entrypoint', () => {
  test('keeps quick_agent_session visible only as a compatibility surface', () => {
    const definitions = buildMcpToolDefinitions(fixture().policy);
    const quick = definitions.find((tool) => tool.name === 'quick_agent_session');
    // May still be advertised for clients, but execution is retired.
    if (quick) {
      expect(JSON.stringify(quick.inputSchema)).toContain('objective');
      expect(JSON.stringify(quick.inputSchema)).not.toContain('issue_id');
    }
  });

  test('dispatch_task returns a structured Agent Run retirement response', async () => {
    const result = value(await callMcpTool(fixture(), 'dispatch_task', { agent: 'codex' }));
    expect(result.error.code).toMatch(/AGENT_RUN_(DEPRECATED|RETIRED)/);
    expect(result.error.message).toMatch(/external SuperController|Thin Launcher|retired|deprecated/i);
  });

  test('quick_agent_session returns a structured Agent Run retirement response', async () => {
    const result = value(await callMcpTool(fixture(), 'quick_agent_session', {
      objective: 'noop',
      agent: 'codex',
    }));
    expect(result.error?.code ?? result.code ?? result.rejectCode ?? '').toMatch(/AGENT_RUN|LOCAL_BRIDGE|RETIRED|DEPRECATED|EXTERNAL_CONTROLLER/i);
  });
});
