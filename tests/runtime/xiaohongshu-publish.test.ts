import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildXiaohongshuPluginManifest,
  buildXiaohongshuPublishRecipe,
  classifyXiaohongshuPublishState,
  executeXiaohongshuPluginAction,
  resetXiaohongshuPluginHooksForTest,
  setXiaohongshuPluginHooksForTest,
} from '../../src/runtime/plugins/xiaohongshu-publish';
import { listFirstPartyPluginAdapters } from '../../src/runtime/plugins/first-party-registry';

const profileUrl = 'https://www.xiaohongshu.com/user/profile/5fb3e0fd0000000001008089';
const baseArgs = {
  session_id: 'browser_test_session',
  profile_url: profileUrl,
  title: '一个可以直接收藏的工具帖',
  body: '正文内容',
};

afterEach(() => resetXiaohongshuPluginHooksForTest());

describe('xiaohongshu publish recipe', () => {
  test('manifest exposes one bounded recipe and one authorized publish action', () => {
    const manifest = buildXiaohongshuPluginManifest();
    expect(manifest.pluginId).toBe('xiaohongshu');
    expect(listFirstPartyPluginAdapters().map((adapter) => adapter.pluginId)).toContain('xiaohongshu');
    expect(manifest.health.ready).toBe(true);
    const actions = Object.fromEntries(manifest.actions.map((action) => [action.actionId, action]));
    expect(Object.keys(actions)).toEqual(['get_publish_recipe', 'classify_publish_state', 'publish_note']);
    expect(actions.get_publish_recipe.readOnly).toBe(true);
    expect(actions.publish_note.risk).toBe('remote_write');
    expect(actions.publish_note.confirmation).toBe('authorization');
  });

  test('image and generated-image modes share one executable image-note route', () => {
    const image = buildXiaohongshuPublishRecipe({ ...baseArgs, mode: 'image_note', image_paths: ['cover.png', 'detail.png'] });
    expect(image.normalizedMode).toBe('image_note');
    const imageSteps = image.steps as Array<Record<string, any>>;
    expect(imageSteps[1]).toMatchObject({ id: 'preflight.probe_image_page', actionId: 'query_all', args: { selector: 'input[type=file]', limit: 1 } });
    expect(imageSteps.find((step) => step.id === 'image.attach_files')?.args.file_paths).toEqual(['cover.png', 'detail.png']);
    expect(imageSteps.find((step) => step.id === 'publish.semantic_submit')).toMatchObject({
      actionId: 'dispatch_event',
      args: { selector: 'xhs-publish-btn', event: 'publish' },
    });
    expect(image.verification).toEqual(['creator_url_contains_published=true', 'profile_contains_exact_title']);

    const generatedPending = buildXiaohongshuPublishRecipe({ ...baseArgs, mode: 'generated_image_note' });
    expect(generatedPending.normalizedMode).toBe('image_note');
    expect(generatedPending.generationRequired).toBe(true);
    expect(generatedPending.steps).toEqual([]);
    expect(generatedPending.verification).toEqual([]);
    expect(generatedPending.generationHandoff).toMatchObject({ requiredInput: 'image_paths', resumeAction: 'publish_note', minImages: 1, maxImages: 18 });

    const generatedReady = buildXiaohongshuPublishRecipe({ ...baseArgs, mode: 'generated_image_note', image_paths: ['generated.png'] });
    expect(generatedReady.normalizedMode).toBe('image_note');
    expect(generatedReady.generationRequired).toBe(false);
  });

  test('long text route uses the verified article editor path without images', () => {
    const recipe = buildXiaohongshuPublishRecipe({ ...baseArgs, mode: 'long_text', template_text: '清晰明朗', summary: '发布摘要' });
    const steps = recipe.steps as Array<Record<string, any>>;
    expect(recipe.normalizedMode).toBe('long_text');
    expect(steps[0].args.url).toContain('target=article');
    expect(steps.map((step) => step.id)).toEqual(expect.arrayContaining([
      'article.new', 'article.fill_title', 'article.fill_body', 'article.layout', 'article.select_template', 'article.next', 'article.fill_summary',
    ]));
    expect(steps.find((step) => step.id === 'article.new')?.args.text).toBe('新的创作');
    expect(steps.find((step) => step.id === 'article.layout')?.args.text).toBe('一键排版');
  });

  test('auth classification fences login before edit and verification requires both receipts', () => {
    expect(classifyXiaohongshuPublishState({ phase: 'preflight', url: 'https://creator.xiaohongshu.com/login', text: '扫码登录' })).toBe('AUTH_REQUIRED');
    expect(classifyXiaohongshuPublishState({ phase: 'preflight', url: 'https://creator.xiaohongshu.com/publish', text: '创作服务平台 发布笔记' })).toBe('READY');
    expect(classifyXiaohongshuPublishState({ phase: 'creator_receipt', url: 'https://creator.xiaohongshu.com/publish?published=true', text: '' })).toBe('PUBLISHED_RECEIPT');
    expect(classifyXiaohongshuPublishState({ phase: 'profile_verify', url: profileUrl, text: '一个可以直接收藏的工具帖', expectedTitle: '一个可以直接收藏的工具帖' })).toBe('PROFILE_VERIFIED');
    expect(classifyXiaohongshuPublishState({ phase: 'profile_verify', url: profileUrl, text: '还没刷新出来', expectedTitle: '一个可以直接收藏的工具帖' })).toBe('VERIFY_PENDING');
  });

  test('publish_note executes the fixed image recipe and only succeeds after profile verification', async () => {
    const calls: Array<{ actionId: string; args: Record<string, any> }> = [];
    let currentUrl = '';
    let textRead = 0;
    setXiaohongshuPluginHooksForTest({
      now: () => '2026-08-17T04:00:00.000Z',
      executeBrowserAction: async (input) => {
        calls.push({ actionId: input.actionId, args: input.args as Record<string, any> });
        if (input.actionId === 'navigate') {
          currentUrl = String(input.args.url);
          return { url: currentUrl };
        }
        if (input.actionId === 'query_all') return { url: currentUrl, count: 1, matches: [{ tag: 'input' }] };
        if (input.actionId === 'dispatch_event') {
          currentUrl = 'https://creator.xiaohongshu.com/publish/publish?source=official&published=true';
          return { url: currentUrl };
        }
        if (input.actionId === 'get_text') {
          textRead += 1;
          if (textRead === 1) return { url: currentUrl, text: '发布笔记' };
          return { url: currentUrl, text: `懒洋洋睡前故事\n${baseArgs.title}` };
        }
        return { url: currentUrl };
      },
    });

    const result = await executeXiaohongshuPluginAction({
      controllerHome: '/tmp/controller', repoId: 'repo', repoRoot: '/tmp/repo', pluginId: 'xiaohongshu', actionId: 'publish_note', requestId: 'xhs-publish-success',
      args: { ...baseArgs, mode: 'image_note', image_paths: ['cover.png', 'detail.png'] },
      origin: { surface: 'local-ui', actor: 'test' },
    });

    expect(result.status).toBe('published');
    expect(result.profileVerification).toEqual({ url: profileUrl, titleFound: true });
    expect(calls.find((call) => call.actionId === 'attach_local_file')?.args.file_paths).toEqual(['cover.png', 'detail.png']);
    expect(calls.find((call) => call.actionId === 'dispatch_event')?.args).toMatchObject({ selector: 'xhs-publish-btn', event: 'publish' });
    expect(calls.at(-1)?.actionId).toBe('get_text');
  });

  test('publish_note stops at auth-required and generated-image handoff without publishing', async () => {
    const authCalls: string[] = [];
    setXiaohongshuPluginHooksForTest({
      executeBrowserAction: async (input) => {
        authCalls.push(input.actionId);
        if (input.actionId === 'navigate') return { url: 'https://creator.xiaohongshu.com/login?redirectReason=401' };
        return {};
      },
    });
    const auth = await executeXiaohongshuPluginAction({
      controllerHome: '/tmp/controller', repoId: 'repo', repoRoot: '/tmp/repo', pluginId: 'xiaohongshu', actionId: 'publish_note', requestId: 'xhs-auth',
      args: { ...baseArgs, mode: 'image_note', image_paths: ['cover.png'] }, origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(auth.status).toBe('auth_required');
    expect(auth.checkpoint).toBe('preflight.navigate_creator');
    expect(authCalls).toEqual(['navigate']);

    authCalls.length = 0;
    const generation = await executeXiaohongshuPluginAction({
      controllerHome: '/tmp/controller', repoId: 'repo', repoRoot: '/tmp/repo', pluginId: 'xiaohongshu', actionId: 'publish_note', requestId: 'xhs-generation',
      args: { ...baseArgs, mode: 'generated_image_note' }, origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(generation.status).toBe('generation_required');
    expect(authCalls).toEqual([]);
  });
});
