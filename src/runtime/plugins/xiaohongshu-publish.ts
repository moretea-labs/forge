import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginCapability,
  AssistantPluginHealth,
  AssistantPluginManifest,
  AssistantPluginPermissionScope,
} from './types';
import { AssistantPluginError } from './errors';
import { executeBrowserPluginAction } from './browser-adapter';

const PLUGIN_ID = 'xiaohongshu';
const RECIPE_VERSION = 4;
const CREATOR_BASE_URL = 'https://creator.xiaohongshu.com/publish/publish?source=official';
const CREATOR_ARTICLE_URL = `${CREATOR_BASE_URL}&target=article`;
const IMAGE_TAB_TEXT = '上传图文';
const ARTICLE_NEW_TEXT = '新的创作';
const ARTICLE_LAYOUT_TEXT = '一键排版';
const ARTICLE_NEXT_TEXT = '下一步';
const IMAGE_FILE_SELECTOR = 'input[type=file]';
const IMAGE_TITLE_SELECTOR = 'input[placeholder*="标题"]';
const IMAGE_BODY_SELECTOR = '[contenteditable="true"][role="textbox"]';
const ARTICLE_TITLE_SELECTOR = 'textarea:nth-of-type(1)';
const ARTICLE_BODY_SELECTOR = '[contenteditable="true"]';
const PUBLISH_SELECTOR = 'xhs-publish-btn';
const PUBLISH_EVENT = 'publish';

const LOGIN_URL_MARKERS = ['/login', 'passport.xiaohongshu.com', 'login.xiaohongshu.com'];
const LOGIN_TEXT_MARKERS = ['手机号登录', '扫码登录', '验证码登录'];

type PublishMode = 'image_note' | 'generated_image_note' | 'long_text';
type NormalizedPublishMode = 'image_note' | 'long_text';
type RecipeStep = {
  id: string;
  actionId: string;
  args: Record<string, unknown>;
  expectation?: string;
};

interface XiaohongshuHooks {
  executeBrowserAction?: typeof executeBrowserPluginAction;
  now?: () => string;
}

let hooks: XiaohongshuHooks = {};

export function setXiaohongshuPluginHooksForTest(next: XiaohongshuHooks): void {
  hooks = next;
}

export function resetXiaohongshuPluginHooksForTest(): void {
  hooks = {};
}

function now(): string {
  return hooks.now?.() ?? new Date().toISOString();
}

function browserExecutor(): typeof executeBrowserPluginAction {
  return hooks.executeBrowserAction ?? executeBrowserPluginAction;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, name: string): string {
  const normalized = stringValue(value);
  if (!normalized) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `${name} is required.`, { retryable: false });
  return normalized;
}

function stringList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'image_paths must be a string array.', { retryable: false });
  }
  return value.map((entry) => String(entry).trim());
}

function publishMode(value: unknown): PublishMode {
  if (value === 'image_note' || value === 'generated_image_note' || value === 'long_text') return value;
  throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'mode must be image_note, generated_image_note, or long_text.', { retryable: false });
}

function normalizedMode(mode: PublishMode): NormalizedPublishMode {
  return mode === 'generated_image_note' ? 'image_note' : mode;
}

function validProfileUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname === 'www.xiaohongshu.com' && parsed.pathname.startsWith('/user/profile/');
  } catch {
    return false;
  }
}

export function isXiaohongshuAuthRequired(url: string, text: string): boolean {
  const normalizedUrl = url.toLowerCase();
  return LOGIN_URL_MARKERS.some((marker) => normalizedUrl.includes(marker.toLowerCase()))
    || LOGIN_TEXT_MARKERS.some((marker) => text.includes(marker));
}

export function classifyXiaohongshuPublishState(input: {
  phase: 'preflight' | 'creator_receipt' | 'profile_verify';
  url: string;
  text: string;
  expectedTitle?: string;
}): 'AUTH_REQUIRED' | 'READY' | 'PUBLISHED_RECEIPT' | 'PROFILE_VERIFIED' | 'VERIFY_PENDING' | 'PAGE_SCHEMA_CHANGED' {
  if (isXiaohongshuAuthRequired(input.url, input.text)) return 'AUTH_REQUIRED';
  if (input.phase === 'creator_receipt') {
    return input.url.includes('published=true') ? 'PUBLISHED_RECEIPT' : 'VERIFY_PENDING';
  }
  if (input.phase === 'profile_verify') {
    return input.expectedTitle && input.text.includes(input.expectedTitle) ? 'PROFILE_VERIFIED' : 'VERIFY_PENDING';
  }
  return input.text.includes('创作服务平台') || input.text.includes('发布笔记') ? 'READY' : 'PAGE_SCHEMA_CHANGED';
}

function parseRecipeArgs(args: Record<string, unknown>) {
  const mode = publishMode(args.mode);
  const sessionId = requiredString(args.session_id, 'session_id');
  const profileUrl = requiredString(args.profile_url, 'profile_url');
  if (!validProfileUrl(profileUrl)) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'profile_url must be an https://www.xiaohongshu.com/user/profile/... URL.', { retryable: false });
  }
  const title = requiredString(args.title, 'title');
  const body = requiredString(args.body, 'body');
  const imagePaths = stringList(args.image_paths);
  const summary = stringValue(args.summary);
  const templateText = stringValue(args.template_text);
  if (normalizedMode(mode) === 'image_note' && mode !== 'generated_image_note' && (imagePaths.length < 1 || imagePaths.length > 18)) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'image_note requires 1-18 image_paths.', { retryable: false });
  }
  if (mode === 'generated_image_note' && imagePaths.length > 18) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'generated_image_note accepts at most 18 generated image_paths.', { retryable: false });
  }
  return { mode, normalizedMode: normalizedMode(mode), sessionId, profileUrl, title, body, imagePaths, summary, templateText };
}

export function buildXiaohongshuPublishRecipe(args: Record<string, unknown>): Record<string, unknown> {
  const parsed = parseRecipeArgs(args);
  const generationRequired = parsed.mode === 'generated_image_note' && parsed.imagePaths.length === 0;
  if (generationRequired) {
    return {
      schemaVersion: 1,
      recipeVersion: RECIPE_VERSION,
      provider: 'xiaohongshu-web',
      requestedMode: parsed.mode,
      normalizedMode: parsed.normalizedMode,
      generationRequired: true,
      sessionId: parsed.sessionId,
      profileUrl: parsed.profileUrl,
      generationHandoff: {
        status: 'required',
        requiredInput: 'image_paths',
        minImages: 1,
        maxImages: 18,
        resumeAction: 'publish_note',
        resumeMode: 'generated_image_note',
        next: 'Generate one or more image files, then call publish_note again with image_paths. The publishing path will normalize to image_note.',
      },
      steps: [],
      verification: [],
    };
  }

  const creatorUrl = parsed.normalizedMode === 'long_text' ? CREATOR_ARTICLE_URL : CREATOR_BASE_URL;
  const steps: RecipeStep[] = [
    {
      id: 'preflight.navigate_creator',
      actionId: 'navigate',
      args: { session_id: parsed.sessionId, url: creatorUrl, wait_until: 'domcontentloaded', timeout_ms: 60_000 },
      expectation: 'Creator page remains in the persisted browser profile; raw cookies/tokens are not copied into recipe state.',
    },
    parsed.normalizedMode === 'image_note'
      ? {
          id: 'preflight.probe_image_page',
          actionId: 'query_all',
          args: { session_id: parsed.sessionId, selector: IMAGE_FILE_SELECTOR, limit: 1 },
          expectation: 'A file input structurally proves the image-note Creator surface is ready without extracting the whole page text.',
        }
      : {
          id: 'preflight.read_auth_state',
          actionId: 'get_text',
          args: { session_id: parsed.sessionId, max_chars: 8_000 },
          expectation: 'Classify with phase=preflight; stop as AUTH_REQUIRED before editing if login markers appear.',
        },
  ];

  if (parsed.normalizedMode === 'image_note') {
    steps.push(
      { id: 'image.select_mode', actionId: 'click_text', args: { session_id: parsed.sessionId, text: IMAGE_TAB_TEXT, post_action_wait_ms: 750 }, expectation: 'Exact visible 上传图文 tab.' },
      { id: 'image.wait_file_input', actionId: 'wait_for_selector', args: { session_id: parsed.sessionId, selector: IMAGE_FILE_SELECTOR, state: 'attached', timeout_ms: 30_000 } },
      { id: 'image.attach_files', actionId: 'attach_local_file', args: { session_id: parsed.sessionId, selector: IMAGE_FILE_SELECTOR, file_paths: parsed.imagePaths, post_action_wait_ms: 1_200 }, expectation: 'One input event/change event after all files are selected.' },
      { id: 'image.wait_editor', actionId: 'wait_for_selector', args: { session_id: parsed.sessionId, selector: IMAGE_TITLE_SELECTOR, state: 'visible', timeout_ms: 30_000 } },
      { id: 'image.fill_title', actionId: 'fill', args: { session_id: parsed.sessionId, selector: IMAGE_TITLE_SELECTOR, text: parsed.title } },
      { id: 'image.fill_body', actionId: 'fill', args: { session_id: parsed.sessionId, selector: IMAGE_BODY_SELECTOR, text: parsed.body } },
    );
  } else {
    steps.push(
      { id: 'article.new', actionId: 'click_text', args: { session_id: parsed.sessionId, text: ARTICLE_NEW_TEXT, post_action_wait_ms: 900 }, expectation: 'Exact visible 新的创作 button.' },
      { id: 'article.wait_editor', actionId: 'wait_for_selector', args: { session_id: parsed.sessionId, selector: ARTICLE_TITLE_SELECTOR, state: 'visible', timeout_ms: 30_000 } },
      { id: 'article.fill_title', actionId: 'fill', args: { session_id: parsed.sessionId, selector: ARTICLE_TITLE_SELECTOR, text: parsed.title } },
      { id: 'article.fill_body', actionId: 'fill', args: { session_id: parsed.sessionId, selector: ARTICLE_BODY_SELECTOR, text: parsed.body } },
      { id: 'article.layout', actionId: 'click_text', args: { session_id: parsed.sessionId, text: ARTICLE_LAYOUT_TEXT, post_action_wait_ms: 1_500 } },
    );
    if (parsed.templateText) {
      steps.push({ id: 'article.select_template', actionId: 'click_text', args: { session_id: parsed.sessionId, text: parsed.templateText, post_action_wait_ms: 500 } });
    }
    steps.push(
      { id: 'article.next', actionId: 'click_text', args: { session_id: parsed.sessionId, text: ARTICLE_NEXT_TEXT, post_action_wait_ms: 1_200 } },
      { id: 'article.wait_publish', actionId: 'wait_for_selector', args: { session_id: parsed.sessionId, selector: PUBLISH_SELECTOR, state: 'visible', timeout_ms: 30_000 } },
    );
    if (parsed.summary) {
      steps.push({ id: 'article.fill_summary', actionId: 'fill', args: { session_id: parsed.sessionId, selector: ARTICLE_BODY_SELECTOR, text: parsed.summary } });
    }
  }

  steps.push(
    { id: 'publish.semantic_submit', actionId: 'dispatch_event', args: { session_id: parsed.sessionId, selector: PUBLISH_SELECTOR, event: PUBLISH_EVENT, post_action_wait_ms: 1_500 }, expectation: 'Current XHS closed-shadow publish control emits publish; recipe version must be updated if this semantic event changes.' },
    { id: 'verify.creator_receipt', actionId: 'get_text', args: { session_id: parsed.sessionId, max_chars: 4_000 }, expectation: 'URL must include published=true before profile verification.' },
    { id: 'verify.profile', actionId: 'navigate', args: { session_id: parsed.sessionId, url: parsed.profileUrl, wait_until: 'domcontentloaded', timeout_ms: 60_000 } },
    { id: 'verify.profile_title', actionId: 'get_text', args: { session_id: parsed.sessionId, max_chars: 12_000 }, expectation: `Profile text must contain exact title: ${parsed.title}` },
  );

  return {
    schemaVersion: 1,
    recipeVersion: RECIPE_VERSION,
    provider: 'xiaohongshu-web',
    requestedMode: parsed.mode,
    normalizedMode: parsed.normalizedMode,
    generationRequired: false,
    sessionId: parsed.sessionId,
    profileUrl: parsed.profileUrl,
    authPolicy: {
      loginUrlMarkers: LOGIN_URL_MARKERS,
      loginTextMarkers: LOGIN_TEXT_MARKERS,
      credentialPersistence: 'browser_profile_only',
      onAuthRequired: 'stop_before_edit_and_resume_after_user_login',
    },
    selectors: {
      imageFile: IMAGE_FILE_SELECTOR,
      imageTitle: IMAGE_TITLE_SELECTOR,
      imageBody: IMAGE_BODY_SELECTOR,
      articleTitle: ARTICLE_TITLE_SELECTOR,
      articleBody: ARTICLE_BODY_SELECTOR,
      publish: PUBLISH_SELECTOR,
      publishEvent: PUBLISH_EVENT,
    },
    steps,
    verification: ['creator_url_contains_published=true', 'profile_contains_exact_title'],
  };
}

function resultText(result: Record<string, unknown>): string {
  return typeof result.text === 'string' ? result.text : '';
}

function resultUrl(result: Record<string, unknown>): string {
  if (typeof result.url === 'string') return result.url;
  const session = result.session;
  if (session && typeof session === 'object' && typeof (session as Record<string, unknown>).url === 'string') return String((session as Record<string, unknown>).url);
  const navigation = result.navigation;
  if (navigation && typeof navigation === 'object' && typeof (navigation as Record<string, unknown>).url === 'string') return String((navigation as Record<string, unknown>).url);
  return '';
}

function schemaDriftMessage(message: string): boolean {
  return /not found|does not allow multiple|Timeout waiting for selector|visible exact text not found|file input/i.test(message);
}

export async function executeXiaohongshuPluginAction(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  if (input.actionId === 'get_publish_recipe') return buildXiaohongshuPublishRecipe(input.args);
  if (input.actionId === 'classify_publish_state') {
    const phase = input.args.phase;
    if (phase !== 'preflight' && phase !== 'creator_receipt' && phase !== 'profile_verify') {
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'phase must be preflight, creator_receipt, or profile_verify.', { retryable: false });
    }
    const url = requiredString(input.args.url, 'url');
    const text = typeof input.args.text === 'string' ? input.args.text : '';
    const expectedTitle = stringValue(input.args.expected_title);
    return { state: classifyXiaohongshuPublishState({ phase, url, text, expectedTitle }), recipeVersion: RECIPE_VERSION };
  }
  if (input.actionId !== 'publish_note') {
    throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', `xiaohongshu/${input.actionId} is not supported.`, { retryable: false });
  }

  const parsed = parseRecipeArgs(input.args);
  if (parsed.mode === 'generated_image_note' && parsed.imagePaths.length === 0) {
    return {
      status: 'generation_required',
      recipeVersion: RECIPE_VERSION,
      resumeMode: 'generated_image_note',
      next: 'Generate one or more image files, then call publish_note again with image_paths. The publishing path will normalize to image_note.',
    };
  }

  const recipe = buildXiaohongshuPublishRecipe(input.args);
  const steps = recipe.steps as RecipeStep[];
  const execute = browserExecutor();
  const receipts: Array<{ stepId: string; actionId: string; url?: string }> = [];
  let currentStep = 'preflight';
  let creatorReceipt: Record<string, unknown> | undefined;
  let profileReceipt: Record<string, unknown> | undefined;

  const runStep = async (step: RecipeStep, index: number): Promise<Record<string, unknown>> => {
    currentStep = step.id;
    const result = await execute({
      ...input,
      pluginId: 'browser',
      actionId: step.actionId,
      requestId: `${input.requestId}:xhs:${RECIPE_VERSION}:${index}:${step.actionId}`,
      args: step.args,
    });
    receipts.push({ stepId: step.id, actionId: step.actionId, ...(resultUrl(result) ? { url: resultUrl(result) } : {}) });
    return result;
  };

  try {
    const preflightNavigate = await runStep(steps[0], 0);
    const navigateUrl = resultUrl(preflightNavigate);
    if (isXiaohongshuAuthRequired(navigateUrl, '')) {
      return {
        status: 'auth_required',
        recipeVersion: RECIPE_VERSION,
        checkpoint: 'preflight.navigate_creator',
        sessionId: parsed.sessionId,
        next: 'Complete only the necessary Xiaohongshu login/verification in the existing browser profile, then rerun publish_note with the same inputs.',
        receipts,
      };
    }

    const preflight = await runStep(steps[1], 1);
    const preflightUrl = resultUrl(preflight) || navigateUrl;
    const preflightState = parsed.normalizedMode === 'image_note'
      ? (typeof preflight.count === 'number' && preflight.count > 0 ? 'READY' : 'PAGE_SCHEMA_CHANGED')
      : classifyXiaohongshuPublishState({ phase: 'preflight', url: preflightUrl, text: resultText(preflight) });
    if (preflightState === 'AUTH_REQUIRED') {
      return {
        status: 'auth_required',
        recipeVersion: RECIPE_VERSION,
        checkpoint: steps[1].id,
        sessionId: parsed.sessionId,
        next: 'Complete only the necessary Xiaohongshu login/verification in the existing browser profile, then rerun publish_note with the same inputs.',
        receipts,
      };
    }
    if (preflightState !== 'READY') {
      return { status: 'page_schema_changed', recipeVersion: RECIPE_VERSION, checkpoint: currentStep, receipts };
    }

    for (let index = 2; index < steps.length; index += 1) {
      const step = steps[index];
      const result = await runStep(step, index);
      if (step.id === 'verify.creator_receipt') {
        creatorReceipt = result;
        const state = classifyXiaohongshuPublishState({ phase: 'creator_receipt', url: resultUrl(result), text: resultText(result) });
        if (state === 'AUTH_REQUIRED') {
          return { status: 'auth_required', recipeVersion: RECIPE_VERSION, checkpoint: step.id, receipts, next: 'Restore Xiaohongshu login in the existing browser profile, then verify the draft/publication state before retrying.' };
        }
        if (state !== 'PUBLISHED_RECEIPT') {
          return { status: 'publish_unverified', recipeVersion: RECIPE_VERSION, checkpoint: step.id, creatorUrl: resultUrl(result), receipts };
        }
      }
      if (step.id === 'verify.profile_title') profileReceipt = result;
    }

    const profileState = profileReceipt
      ? classifyXiaohongshuPublishState({ phase: 'profile_verify', url: resultUrl(profileReceipt), text: resultText(profileReceipt), expectedTitle: parsed.title })
      : 'VERIFY_PENDING';
    if (profileState !== 'PROFILE_VERIFIED') {
      return {
        status: 'verification_pending',
        recipeVersion: RECIPE_VERSION,
        creatorReceipt: creatorReceipt ? { url: resultUrl(creatorReceipt) } : undefined,
        profileUrl: parsed.profileUrl,
        expectedTitle: parsed.title,
        receipts,
      };
    }
    return {
      status: 'published',
      recipeVersion: RECIPE_VERSION,
      mode: parsed.mode,
      normalizedMode: parsed.normalizedMode,
      title: parsed.title,
      creatorReceipt: { url: resultUrl(creatorReceipt ?? {}) },
      profileVerification: { url: resultUrl(profileReceipt ?? {}), titleFound: true },
      receipts,
      publishedAt: now(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (schemaDriftMessage(message)) {
      return {
        status: 'page_schema_changed',
        recipeVersion: RECIPE_VERSION,
        checkpoint: currentStep,
        message,
        receipts,
        next: 'Re-discover only the failed semantic anchor, update the Xiaohongshu recipe version, then resume with the same content inputs.',
      };
    }
    throw error;
  }
}

function health(): AssistantPluginHealth {
  return {
    state: 'ready',
    checkedAt: now(),
    ready: true,
    probed: true,
    errors: [],
    warnings: ['Xiaohongshu authentication is owned by the Browser profile; login validity is checked at publish preflight and no raw token/cookie is stored by this recipe.'],
    details: { recipeVersion: RECIPE_VERSION, browserSessionRequired: true },
  };
}

function permissions(): AssistantPluginPermissionScope[] {
  return [
    { scope: 'xiaohongshu.recipe', mode: 'read', description: 'Resolve and classify the versioned Xiaohongshu publishing recipe.', granted: true, required: true },
    { scope: 'xiaohongshu.publish', mode: 'write', description: 'Execute the bounded Xiaohongshu publishing recipe through the existing Browser plugin.', granted: true, required: true },
  ];
}

function capabilities(): AssistantPluginCapability[] {
  return [{
    capabilityId: 'xiaohongshu-publish',
    title: 'Xiaohongshu Publishing Recipe',
    description: 'Versioned Browser-backed publishing flow with auth fencing, image/long-text routing, generated-image handoff, semantic publish activation, and dual verification.',
    scopes: ['xiaohongshu.recipe', 'xiaohongshu.publish'],
    actions: ['get_publish_recipe', 'classify_publish_state', 'publish_note'],
  }];
}

function actions(): AssistantPluginActionDescriptor[] {
  const recipeSchema = {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['image_note', 'generated_image_note', 'long_text'] },
      session_id: { type: 'string' },
      profile_url: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
      image_paths: { type: 'array', minItems: 1, maxItems: 18, items: { type: 'string' } },
      summary: { type: 'string' },
      template_text: { type: 'string' },
    },
    required: ['mode', 'session_id', 'profile_url', 'title', 'body'],
    additionalProperties: false,
  };
  return [
    {
      actionId: 'get_publish_recipe', title: 'Resolve publish recipe', description: 'Return the current deterministic Xiaohongshu Browser action sequence without executing it.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 15_000, cancellable: true, idempotent: true,
      scopes: ['xiaohongshu.recipe'], resourceClaims: [], argumentsSchema: recipeSchema,
    },
    {
      actionId: 'classify_publish_state', title: 'Classify publish state', description: 'Classify observed Xiaohongshu URL/text as ready, auth-required, published receipt, profile verified, pending, or schema drift.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 15_000, cancellable: true, idempotent: true,
      scopes: ['xiaohongshu.recipe'], resourceClaims: [],
      argumentsSchema: {
        type: 'object',
        properties: {
          phase: { type: 'string', enum: ['preflight', 'creator_receipt', 'profile_verify'] },
          url: { type: 'string' }, text: { type: 'string' }, expected_title: { type: 'string' },
        },
        required: ['phase', 'url', 'text'], additionalProperties: false,
      },
    },
    {
      actionId: 'publish_note', title: 'Publish Xiaohongshu note', description: 'Execute the versioned Xiaohongshu publish recipe through the existing persisted Browser session. Stops on login expiry or page-schema drift and only reports published after creator receipt plus profile-title verification.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 180_000, cancellable: true, idempotent: false,
      scopes: ['xiaohongshu.publish'], resourceClaims: [{ resource: 'remote', mode: 'exclusive' }, { resource: 'repo-state', mode: 'write' }], argumentsSchema: recipeSchema,
    },
  ];
}

export function buildXiaohongshuPluginManifest(previousRevision = 0, previousUpdatedAt?: string): AssistantPluginManifest {
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    revision: Math.max(1, previousRevision || 1),
    pluginId: PLUGIN_ID,
    provider: 'xiaohongshu-web-recipe',
    displayName: 'Xiaohongshu Publishing',
    pluginVersion: '1.0.0',
    authority: {
      strategy: 'derived',
      duplicateStateAllowed: false,
      sourceOfTruth: ['source:src/runtime/plugins/xiaohongshu-publish.ts', 'browser-profile:authentication-and-session'],
    },
    enabled: true,
    lifecycle: { state: 'enabled', reason: 'Versioned Xiaohongshu publishing recipe is available; live authentication is fenced at execution time.' },
    health: health(),
    permissions: permissions(),
    capabilities: capabilities(),
    actions: actions(),
    updatedAt: previousUpdatedAt ?? now(),
  };
}

export const xiaohongshuPluginAdapter = {
  pluginId: PLUGIN_ID,
  buildManifest: buildXiaohongshuPluginManifest,
  executeAction: executeXiaohongshuPluginAction,
};
