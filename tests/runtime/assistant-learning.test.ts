import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { validateProjectKnowledgeSources } from '../../packages/kernel/engineering/api/index';
import { memoryAddressKey, type ActivationPack, type MemoryUnit } from '../../packages/kernel/cognition/api/index';
import { fileKnowledgeSourcePort, resolveAssistantContext } from '../../src/runtime/context/assistant-context';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const dir = mkdtempSync(join(tmpdir(), 'forge-assistant-'));
  roots.push(dir);
  return dir;
}
const scope = { schemaVersion: 1, kind: 'project', id: 'project-a' } as const;
const now = '2026-09-07T00:00:00.000Z';
describe('assistant context and project knowledge', () => {
  test('projectless cognition preserves scope-qualified identity while project knowledge remains explicitly bound', () => {
    const dir = root();
    const projectScope = { schemaVersion: 1 as const, kind: 'project' as const, id: 'project-projectless' };
    const requirementScope = { schemaVersion: 1 as const, kind: 'requirement' as const, id: 'req-projectless' };
    const memory = (memoryScope: typeof projectScope | typeof requirementScope, text: string): MemoryUnit => ({
      schemaVersion: 1,
      id: 'shared-id',
      revision: 1,
      scope: memoryScope,
      facets: ['knowledge'],
      canonicalText: text,
      concepts: ['projectless.recall'],
      provenance: { sourceKind: 'system', recordedAt: now, evidenceRefs: [] },
      confidence: 0.9,
      utility: 0.8,
      tier: 'hot',
      validFrom: now,
      counterEvidenceRefs: [],
    });
    const memories = [
      memory(projectScope, 'Project-scoped memory.'),
      memory(requirementScope, 'Requirement-scoped memory.'),
    ];
    const activation: ActivationPack = {
      schemaVersion: 1,
      query: 'projectless.recall',
      generatedAt: now,
      items: memories.map((item) => ({ memory: item, score: 1, reasons: [], activationPath: [] })),
      gaps: [],
      truncated: false,
      inspectedCandidates: 2,
      estimatedBytes: 1,
    };
    const resolved = resolveAssistantContext({
      sources: [],
      query: 'projectless.recall',
      now,
      knowledge: fileKnowledgeSourcePort({ repoRoot: dir, sourceRevision: 'test' }),
      activation,
    });
    expect(resolved.projectId).toBeUndefined();
    expect(new Set(resolved.items.map((item) => item.id)).size).toBe(2);
    expect(resolved.items.map((item) => item.id)).toEqual(
      expect.arrayContaining(memories.map((item) => memoryAddressKey({ scope: item.scope, id: item.id }))),
    );

    writeFileSync(join(dir, 'project.md'), 'project-only knowledge');
    expect(() =>
      resolveAssistantContext({
        sources: [{ id: 'project', kind: 'repository', path: 'project.md', required: true }],
        query: 'project',
        now,
        knowledge: fileKnowledgeSourcePort({ repoRoot: dir, sourceRevision: 'test' }),
      }),
    ).toThrow('ASSISTANT_CONTEXT_PROJECT_REQUIRED_FOR_KNOWLEDGE');
  });

  test('Chinese recall survives a fresh reader and source edits invalidate content identity', () => {
    const dir = root();
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs/product.md'), '产品介绍\n开发故事介绍了产品来历\n禁止承诺疗效');
    const sources = validateProjectKnowledgeSources([
      { id: 'product', kind: 'repository', path: 'docs/product.md', required: true },
    ]);
    const resolve = () =>
      resolveAssistantContext({
        projectId: scope.id,
        sources,
        query: '产品推广开发故事',
        now,
        knowledge: fileKnowledgeSourcePort({ repoRoot: dir, sourceRevision: 'working-tree' }),
      });
    const first = resolve();
    expect(first.items[0]?.text).toContain('开发故事');
    expect(resolve()).toEqual(first);
    writeFileSync(join(dir, 'docs/product.md'), '产品介绍\n当前产品版本更新');
    expect(resolve().items[0]?.provenance.digest).not.toBe(first.items[0]?.provenance.digest);
  });

  test('unregistered files, escaped symlinks, expired sources and truncation never become usable required knowledge', () => {
    const dir = root(),
      outside = root();
    writeFileSync(join(outside, 'secret.md'), '产品私密事实');
    symlinkSync(join(outside, 'secret.md'), join(dir, 'linked.md'));
    const sources = validateProjectKnowledgeSources([
      { id: 'link', kind: 'repository', path: 'linked.md', required: true },
    ]);
    const result = resolveAssistantContext({
      projectId: scope.id,
      sources,
      query: '产品',
      now,
      knowledge: fileKnowledgeSourcePort({ repoRoot: dir, sourceRevision: 'test' }),
    });
    expect(result.items).toHaveLength(0);
    expect(result.missingRequiredSources).toEqual(['link']);
    expect(() => validateProjectKnowledgeSources([{ id: 'escape', kind: 'repository', path: '../secret' }])).toThrow(
      'PATH_INVALID',
    );
    writeFileSync(join(dir, 'product.md'), '产品说明'.repeat(1000));
    const bounded = resolveAssistantContext({
      projectId: scope.id,
      sources: [{ id: 'product', kind: 'repository', path: 'product.md', required: true }],
      query: '产品',
      now,
      maxTokens: 10,
      knowledge: fileKnowledgeSourcePort({ repoRoot: dir, sourceRevision: 'test' }),
    });
    expect(bounded.truncated).toBe(true);
    expect(bounded.missingRequiredSources).toEqual(['product']);
  });
});

test('identical required sources retain both provenance records and both truncation gaps', () => {
  const dir = root();
  writeFileSync(join(dir, 'a.md'), '产品边界：不承诺效果');
  writeFileSync(join(dir, 'b.md'), '产品边界：不承诺效果');
  const input = {
    projectId: scope.id,
    query: '产品',
    now,
    sources: validateProjectKnowledgeSources(
      ['a', 'b'].map((id) => ({ id, kind: 'repository', path: `${id}.md`, required: true })),
    ),
    knowledge: fileKnowledgeSourcePort({ repoRoot: dir, sourceRevision: 'test' }),
  };
  const complete = resolveAssistantContext(input);
  expect(complete.items).toHaveLength(1);
  expect(complete.items[0]?.sourceCoverage?.map((source) => source.sourceId)).toEqual(['a', 'b']);
  expect(complete.missingRequiredSources).toEqual([]);
  expect(resolveAssistantContext({ ...input, maxTokens: 1 }).missingRequiredSources).toEqual(['a', 'b']);
});
