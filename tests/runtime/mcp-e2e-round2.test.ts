import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createMcpToolContext } from '../../src/cli/mcp/multi-repository';
import { exposedControllerToolDefinitions } from '../../src/cli/mcp/toolset';
import { registerRepository } from '../../src/cli/repositories/registry';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';

async function withFixture(fn: (root: string, controllerHome: string, repoId: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-mcp-round2-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-mcp-home-round2-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'round2.ts'), 'export const round2 = true;\n');
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'round2'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'round2@example.test'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'round2'], { cwd: root, stdio: 'ignore' });
    const repository = registerRepository({ path: root, controllerHome });
    await fn(root, controllerHome, repository.repoId);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(controllerHome, { recursive: true, force: true });
  }
}

describe('MCP E2E round two local runtime', () => {
  test('keeps summary within budget and isolates detail projection', async () => {
    await withFixture(async (root, controllerHome, repoId) => {
      const context = createMcpToolContext({
        repo: root,
        controllerHome,
        profile: 'controller',
        toolset: 'advanced',
        sessionId: 'mcp-round2-local',
      });
      const summary = await callRuntimeTool(context, 'controller_context', { repo_id: repoId });
      const detail = await callRuntimeTool(context, 'controller_context', { repo_id: repoId, detail_level: 'detail' });
      const summaryValue = summary?.structuredContent as Record<string, any>;
      const detailValue = detail?.structuredContent as Record<string, any>;
      expect(Buffer.byteLength(JSON.stringify(summaryValue))).toBeLessThanOrEqual(32 * 1024);
      expect(summaryValue.contextProjection.variant).toBe('summary');
      expect(detailValue.contextProjection.variant).toBe('detail');
      expect(summaryValue.contextProjection.sourceIdentity.variant).toBe('summary');
      expect(detailValue.contextProjection.sourceIdentity.variant).toBe('detail');
      expect(summaryValue.responseMeta.routing.repoId).toBe(repoId);
      expect(detailValue.responseMeta.routing.repoId).toBe(repoId);
    });
  });

  test('concurrent summaries preserve repository routing and stable tool exposure', async () => {
    await withFixture(async (root, controllerHome, repoId) => {
      const context = createMcpToolContext({
        repo: root,
        controllerHome,
        profile: 'controller',
        toolset: 'advanced',
        sessionId: 'mcp-round2-concurrent',
      });
      const results = await Promise.all(Array.from({ length: 30 }, () => callRuntimeTool(context, 'controller_context', { repo_id: repoId })));
      expect(results.every((result) => result?.isError !== true)).toBe(true);
      expect(results.every((result) => (result?.structuredContent as any)?.responseMeta?.routing?.repoId === repoId)).toBe(true);
      const advanced = exposedControllerToolDefinitions(context);
      const full = exposedControllerToolDefinitions(createMcpToolContext({ repo: root, controllerHome, profile: 'controller', toolset: 'full' }));
      expect(advanced.length).toBe(133);
      expect(full.length).toBeGreaterThanOrEqual(advanced.length);
      expect(new Set(advanced.map((tool) => tool.name)).size).toBe(advanced.length);
    });
  });
});
