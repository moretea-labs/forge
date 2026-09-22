import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import {
  buildXiaohongshuPluginManifest,
  buildXiaohongshuPublishRecipe,
  executeXiaohongshuPluginAction,
} from '../../src/runtime/plugins/xiaohongshu-publish';
import { listFirstPartyPluginAdapters } from '../../src/runtime/plugins/first-party-registry';
import {
  materializedXiaohongshuWorkflow,
  translateXiaohongshuPublishToWorkflow,
  XIAOHONGSHU_WORKFLOW_IDS,
} from '../../src/runtime/workflows/first-party/xiaohongshu';

const profileUrl = 'https://www.xiaohongshu.com/user/profile/5fb3e0fd0000000001008089';
const baseArgs = {
  session_id: 'browser_test_session', profile_url: profileUrl,
  title: '一个可以直接收藏的工具帖', body: '正文内容',
};

describe('xiaohongshu Workflow compatibility', () => {
  test('manifest exposes only read-only translation; remote effects are not plugin-owned', () => {
    const manifest = buildXiaohongshuPluginManifest();
    expect(manifest.pluginId).toBe('xiaohongshu');
    expect(listFirstPartyPluginAdapters().map(adapter => adapter.pluginId)).toContain('xiaohongshu');
    expect(manifest.health.ready).toBe(true);
    expect(manifest.authority.sourceOfTruth).toContain('source:assets/workflows/xiaohongshu/*.draft.json');
    expect(manifest.actions.map(action => action.actionId)).toEqual(['get_publish_recipe', 'publish_note']);
    for (const action of manifest.actions) {
      expect(action.readOnly).toBe(true);
      expect(action.risk).toBe('readonly');
      expect(action.confirmation).toBe('none');
      expect(action.idempotent).toBe(true);
    }
  });

  test('legacy image/generated/long-text inputs translate to exact versioned Workflow identities', () => {
    const image = translateXiaohongshuPublishToWorkflow({ ...baseArgs, mode: 'image_note', image_paths: ['cover.png'] });
    expect(image).toMatchObject({ workflowId: XIAOHONGSHU_WORKFLOW_IDS.imageNote, generationRequired: false, normalizedMode: 'image_note' });
    expect(image.inputs.image_paths).toEqual(['cover.png']);
    const generated = translateXiaohongshuPublishToWorkflow({ ...baseArgs, mode: 'generated_image_note' });
    expect(generated).toMatchObject({ workflowId: XIAOHONGSHU_WORKFLOW_IDS.imageNote, generationRequired: true, normalizedMode: 'image_note' });
    const longText = translateXiaohongshuPublishToWorkflow({ ...baseArgs, mode: 'long_text', summary: '摘要' });
    expect(longText).toMatchObject({ workflowId: XIAOHONGSHU_WORKFLOW_IDS.longText, generationRequired: false, normalizedMode: 'long_text' });
    expect(longText.inputs.summary).toBe('摘要');
  });

  test('auth/selectors/platform sequencing live in assets and uncertain publish has an explicit reconciliation binding', () => {
    const image = materializedXiaohongshuWorkflow(XIAOHONGSHU_WORKFLOW_IDS.imageNote);
    expect(image.resources?.creatorBaseUrl).toContain('creator.xiaohongshu.com');
    expect(image.selectors?.publish).toBe('xhs-publish-btn');
    expect(image.requiredCapabilities).toContain('browser.reconcile_effect');
    const effect = image.steps.find(step => step.stepId === 'publish.semantic_submit');
    expect(effect).toMatchObject({
      capabilityId: 'browser.dispatch_event', idempotency: 'non_idempotent', reconcileWithCapabilityId: 'browser.reconcile_effect',
    });
    expect(image.publication).toMatchObject({ channel: 'xiaohongshu', effectStepId: 'publish.semantic_submit' });
    const source = readFileSync(new URL('../../src/runtime/plugins/xiaohongshu-publish.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('creator.xiaohongshu.com/publish');
    expect(source).not.toContain('xhs-publish-btn');
    expect(source).not.toContain('executeBrowserPluginAction');
  });

  test('compatibility publish_note never reports a remote publish as completed', async () => {
    const result = await executeXiaohongshuPluginAction({
      controllerHome: '/tmp/controller', repoId: 'repo', repoRoot: '/tmp/repo', pluginId: 'xiaohongshu', actionId: 'publish_note', requestId: 'xhs-compat',
      args: { ...baseArgs, mode: 'image_note', image_paths: ['cover.png'] }, origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(result.status).toBe('workflow_required');
    expect(result.execution).toMatchObject({ tool: 'rh_work', operation: 'workflow_execute', workflow_id: XIAOHONGSHU_WORKFLOW_IDS.imageNote });
    expect(result).not.toHaveProperty('publishedAt');
    expect(result).not.toHaveProperty('receipts');
  });

  test('generated image request remains a pure generation handoff until image paths exist', async () => {
    const result = await executeXiaohongshuPluginAction({
      controllerHome: '/tmp/controller', repoId: 'repo', repoRoot: '/tmp/repo', pluginId: 'xiaohongshu', actionId: 'publish_note', requestId: 'xhs-generation',
      args: { ...baseArgs, mode: 'generated_image_note' }, origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(result.status).toBe('generation_required');
    expect(result.generationHandoff).toMatchObject({ requiredInput: 'image_paths', minImages: 1, maxImages: 18 });
  });

  test('recipe projection exposes exact immutable asset identity instead of copied platform steps', () => {
    const recipe = buildXiaohongshuPublishRecipe({ ...baseArgs, mode: 'long_text' });
    const asset = materializedXiaohongshuWorkflow(XIAOHONGSHU_WORKFLOW_IDS.longText);
    expect(recipe).toMatchObject({ workflowId: asset.workflowId, workflowVersion: asset.version, workflowContentDigest: asset.contentDigest });
    expect(recipe).not.toHaveProperty('steps');
    expect(recipe).not.toHaveProperty('selectors');
  });
});
