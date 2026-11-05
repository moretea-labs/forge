import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentGitReview, splitGitDiffFiles } from '../src/agent-git-review';

const patch = [
  'diff --git a/src/one.ts b/src/one.ts',
  'index 0123456..1234567 100644',
  '--- a/src/one.ts',
  '+++ b/src/one.ts',
  '@@ -1,2 +1,2 @@',
  '-old()',
  '+new()',
  ' unchanged',
  'diff --git a/src/deleted.ts b/src/deleted.ts',
  'deleted file mode 100644',
  '--- a/src/deleted.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-deleted()',
].join('\n');

describe('Agent Git diff presentation', () => {
  test('splits file sections without treating ---/+++ headers as changed lines', () => {
    const files = splitGitDiffFiles(patch);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: 'src/one.ts', added: 1, removed: 1 });
    expect(files[1]).toMatchObject({ path: 'src/deleted.ts', added: 0, removed: 1 });
    expect(files[0].patch).toContain('@@ -1,2 +1,2 @@');
  });
  test('empty and truncated responses do not invent changed files', () => {
    expect(splitGitDiffFiles('')).toEqual([]);
    const html = renderToStaticMarkup(createElement(AgentGitReview, {
      diff: { patch: '', stat: '', truncated: true }, staged: false, loading: false,
      onStagedChange() {}, onRefresh() {}, onClose() {},
    }));
    expect(html).toContain('仅展示 Forge 返回的部分 Diff');
    expect(html).toContain('当前没有未暂存的代码变更');
    expect(html).toContain('aria-label="Git 变更类型"');
    const stagedHtml = renderToStaticMarkup(createElement(AgentGitReview, {
      diff: { patch: '', stat: '', truncated: false }, staged: true, loading: false,
      onStagedChange() {}, onRefresh() {}, onClose() {},
    }));
    expect(stagedHtml).toContain('当前没有已暂存的代码变更');
    expect(stagedHtml).toContain('aria-pressed="true"');
  });
  test('renders file navigation and highlighted patch lines with no write controls', () => {
    const html = renderToStaticMarkup(createElement(AgentGitReview, {
      diff: { patch, stat: 'src/one.ts | 2 +-', truncated: false }, staged: false, loading: false,
      onStagedChange() {}, onRefresh() {}, onClose() {},
    }));
    expect(html).toContain('aria-label="已修改文件"');
    expect(html).toContain('src/one.ts');
    expect(html).toContain('src/deleted.ts');
    expect(html).toContain('local-diff-line added');
    expect(html).toContain('local-diff-line removed');
    expect(html).not.toContain('应用补丁');
  });
});
