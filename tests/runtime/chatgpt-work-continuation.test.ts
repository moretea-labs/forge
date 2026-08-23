import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { chatgptBridgeTargetMatchesPage } from '../../src/cli/chatgpt-browser/bridge-provider';
import {
  bindChatgptWorkConversation,
  getChatgptWorkConversationBinding,
  parseChatgptConversationIdentity,
  rebindChatgptWorkConversation,
} from '../../src/runtime/control-plane/launcher/chatgpt-work-binding-store';
import {
  chatgptAutomationControlWaitBudgets,
  chatgptAutomationPageFailure,
  chatgptAutomationReasoningLevelFromLabel,
  chatgptBrowserActionArgs,
  isChatgptConversationUrl,
  resolveChatgptWorkBrowserSessionId,
  runWorkChatgptContinuation,
  stableChatgptWorkBrowserSessionId,
  stableStandaloneChatgptBrowserSessionId,
} from '../../src/runtime/control-plane/launcher/chatgpt-work-continuation';
import { migrateChatgptAutomationSchedule } from '../../src/runtime/workflow/schedules/chatgpt-automation-migration';
import type { RepositorySchedule } from '../../src/runtime/workflow/schedules/types';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('ChatGPT Work conversation binding', () => {
  test('pins ChatGPT automation Browser actions to native Chrome attach without global transport mutation', () => {
    expect(chatgptBrowserActionArgs('open_page', { session_id: 'session-a', url: 'https://chatgpt.com/' })).toMatchObject({
      session_id: 'session-a', browser_mode: 'attach_preferred', cdp_attach_fallback: 'fail_closed',
      native_attach_mode: 'auto', native_browser_candidates: ['chrome'],
    });
    expect(chatgptBrowserActionArgs('get_text', { session_id: 'session-a' })).toMatchObject({ browser_mode: 'attach_preferred' });
    expect(chatgptBrowserActionArgs('configure', { enabled: true })).toEqual({ enabled: true });
  });

  test('uses the ChatGPT conversation id as stable machine identity', () => {
    expect(parseChatgptConversationIdentity('https://www.chatgpt.com/c/abc-123?x=1#tail')).toEqual({
      conversationUrl: 'https://chatgpt.com/c/abc-123',
      conversationId: 'abc-123',
    });
    expect(() => parseChatgptConversationIdentity('https://chatgpt.com/')).toThrow('CHATGPT_WORK_CONVERSATION_ID_MISSING');
    expect(() => parseChatgptConversationIdentity('https://example.com/c/abc')).toThrow('CHATGPT_WORK_CONVERSATION_URL_INVALID');
  });

  test('persists one Work-to-conversation binding and refuses silent rebind', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-chatgpt-work-binding-'));
    roots.push(root);
    const controllerHome = join(root, 'controller');
    ensureControllerHome(controllerHome);
    const options = { controllerHome, repoId: 'repo-chatgpt-work' };
    const first = bindChatgptWorkConversation(options, {
      workId: 'WORK-1',
      conversationUrl: 'https://chatgpt.com/c/conversation-1',
      latestBrowserSessionId: 'chgpt_20260812_120000_first',
      localAlias: 'Forge · YaoZhunShi · Medication V2',
    });
    expect(first.conversationId).toBe('conversation-1');
    expect(getChatgptWorkConversationBinding(options, 'WORK-1')?.latestBrowserSessionId).toBe('chgpt_20260812_120000_first');
    const continued = bindChatgptWorkConversation(options, {
      workId: 'WORK-1',
      conversationUrl: 'https://www.chatgpt.com/c/conversation-1?model=current',
      latestBrowserSessionId: 'chgpt_20260812_130000_followup',
    });
    expect(continued.conversationId).toBe('conversation-1');
    expect(continued.latestBrowserSessionId).toBe('chgpt_20260812_130000_followup');
    expect(() => bindChatgptWorkConversation(options, {
      workId: 'WORK-1',
      conversationUrl: 'https://chatgpt.com/c/other-conversation',
    })).toThrow('CHATGPT_WORK_CONVERSATION_REBIND_REQUIRED');
  });

  test('allows an explicit compare-and-swap rebind after a verified continuation redirect', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-chatgpt-work-rebind-'));
    roots.push(root);
    const controllerHome = join(root, 'controller');
    ensureControllerHome(controllerHome);
    const options = { controllerHome, repoId: 'repo-chatgpt-work' };
    bindChatgptWorkConversation(options, {
      workId: 'WORK-REBIND',
      conversationUrl: 'https://chatgpt.com/c/conversation-old',
      latestBrowserSessionId: 'session-old',
      localAlias: 'Forge workflow',
    });
    const rebound = rebindChatgptWorkConversation(options, {
      workId: 'WORK-REBIND',
      previousConversationId: 'conversation-old',
      conversationUrl: 'https://chatgpt.com/c/conversation-new',
      latestBrowserSessionId: 'session-new',
    });
    expect(rebound.conversationId).toBe('conversation-new');
    expect(rebound.latestBrowserSessionId).toBe('session-new');
    expect(rebound.localAlias).toBe('Forge workflow');
    expect(() => rebindChatgptWorkConversation(options, {
      workId: 'WORK-REBIND',
      previousConversationId: 'conversation-old',
      conversationUrl: 'https://chatgpt.com/c/conversation-third',
    })).toThrow('CHATGPT_WORK_CONVERSATION_REBIND_STALE');
  });

  test('uses a stable per-Work browser session and migrates away from the legacy global tab', () => {
    const first = stableChatgptWorkBrowserSessionId('repo-1', 'WORK-1');
    expect(first).toBe(stableChatgptWorkBrowserSessionId('repo-1', 'WORK-1'));
    expect(first).not.toBe(stableChatgptWorkBrowserSessionId('repo-1', 'WORK-2'));
    expect(resolveChatgptWorkBrowserSessionId({ repoId: 'repo-1', workId: 'WORK-1', boundSessionId: 'forge-chatgpt-supercontroller' })).toBe(first);
    expect(resolveChatgptWorkBrowserSessionId({ repoId: 'repo-1', workId: 'WORK-1', boundSessionId: 'work-owned-session' })).toBe('work-owned-session');
    expect(resolveChatgptWorkBrowserSessionId({ repoId: 'repo-1', workId: 'WORK-1', tabPolicy: 'new' })).toStartWith(`${first}-`);
    const standalone = stableStandaloneChatgptBrowserSessionId('repo-1', 'schedule:SCH-1');
    expect(standalone).toBe(stableStandaloneChatgptBrowserSessionId('repo-1', 'schedule:SCH-1'));
    expect(standalone).not.toBe(stableStandaloneChatgptBrowserSessionId('repo-1', 'schedule:SCH-2'));
    expect(standalone).not.toBe(first);
  });

  test('recognizes only canonical ChatGPT conversation URLs for stale-binding recovery', () => {
    expect(isChatgptConversationUrl('https://chatgpt.com/c/WEB:abc-123')).toBe(true);
    expect(isChatgptConversationUrl('https://www.chatgpt.com/c/abc-123?model=current')).toBe(true);
    expect(isChatgptConversationUrl('https://chatgpt.com/')).toBe(false);
    expect(isChatgptConversationUrl('https://example.com/c/abc-123')).toBe(false);
    expect(isChatgptConversationUrl('javascript:alert(1)')).toBe(false);
  });

  test('recognizes contextual ChatGPT reasoning labels without matching unrelated UI', () => {
    expect(chatgptAutomationReasoningLevelFromLabel('High')).toBe('high');
    expect(chatgptAutomationReasoningLevelFromLabel('Thinking: High')).toBe('high');
    expect(chatgptAutomationReasoningLevelFromLabel('Reasoning · High')).toBe('high');
    expect(chatgptAutomationReasoningLevelFromLabel('推理强度：高')).toBe('high');
    expect(chatgptAutomationReasoningLevelFromLabel('Thinking: Extra High')).toBe('xhigh');
    expect(chatgptAutomationReasoningLevelFromLabel('Medium reasoning')).toBe('medium');
    expect(chatgptAutomationReasoningLevelFromLabel('High contrast')).toBeUndefined();
  });

  test('keeps ChatGPT control readiness probes repeatable within a bounded hydration window', () => {
    expect(chatgptAutomationControlWaitBudgets()).toEqual({ waitBudgetMs: 30_000, probeTimeoutMs: 2_500 });
    expect(chatgptAutomationControlWaitBudgets(8_000)).toEqual({ waitBudgetMs: 8_000, probeTimeoutMs: 2_500 });
    expect(chatgptAutomationControlWaitBudgets(1_000)).toEqual({ waitBudgetMs: 1_000, probeTimeoutMs: 1_000 });
    expect(chatgptAutomationControlWaitBudgets(60_000)).toEqual({ waitBudgetMs: 30_000, probeTimeoutMs: 2_500 });
  });

  test('classifies missing ChatGPT composer as login-required when authentication UI is visible', () => {
    expect(chatgptAutomationPageFailure('Log in  Sign up  Continue with Google', false)).toBe('CHATGPT_AUTOMATION_LOGIN_REQUIRED');
    expect(chatgptAutomationPageFailure('登录  注册  使用 Apple 继续', false)).toBe('CHATGPT_AUTOMATION_LOGIN_REQUIRED');
    expect(chatgptAutomationPageFailure('Something went wrong', false)).toBe('CHATGPT_AUTOMATION_COMPOSER_UNAVAILABLE');
    expect(chatgptAutomationPageFailure('ChatGPT', true)).toBeUndefined();
  });

  test('lets only the exact target ChatGPT conversation claim a bridge task', () => {
    expect(chatgptBridgeTargetMatchesPage('https://chatgpt.com/c/target-id', 'https://chatgpt.com/c/target-id?model=current')).toBe(true);
    expect(chatgptBridgeTargetMatchesPage('https://chatgpt.com/c/target-id', 'https://chatgpt.com/c/other-id')).toBe(false);
    expect(chatgptBridgeTargetMatchesPage('https://chatgpt.com/', 'https://chatgpt.com/')).toBe(true);
    expect(chatgptBridgeTargetMatchesPage('https://chatgpt.com/', 'https://chatgpt.com/c/other-id')).toBe(false);
  });


  test('fails closed when the explicit controller home does not contain the requested WorkContract', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-chatgpt-work-authority-'));
    roots.push(root);
    const controllerHome = join(root, 'controller');
    ensureControllerHome(controllerHome);

    const result = await runWorkChatgptContinuation({
      controllerHome,
      repoId: 'repo-chatgpt-work',
      repoRoot: root,
      workId: 'WORK-missing',
      prompt: 'continue',
    });
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('CHATGPT_WORK_CONTRACT_NOT_FOUND: repo-chatgpt-work:WORK-missing');
  });

  test('keeps automation in Chat mode, prefixes @forge, and submits from the stable prompt editor', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/control-plane/launcher/chatgpt-work-continuation.ts'), 'utf8');
    expect(source).toContain("CHATGPT_PROMPT_SELECTOR = 'div#prompt-textarea[contenteditable=\"true\"]'"); expect(source).toContain("CHATGPT_SEND_SELECTOR = '[data-testid=\"send-button\"], button[aria-label*=\"Send\"], button[data-testid*=\"send\"]'");
    expect(source).toContain("DEFAULT_CHATGPT_AUTOMATION_MODEL = 'gpt-5.6'");
    expect(source).toContain("DEFAULT_CHATGPT_AUTOMATION_REASONING = 'high'");
    expect(source).toContain("DEFAULT_CHATGPT_AUTOMATION_PLUGIN_MENTION = '@forge'"); expect(source).not.toContain('CHATGPT_WORK_MODE_RADIO_SELECTOR');
    expect(source).toContain('CHATGPT_CAPABILITY_MENUITEM_SELECTOR');
    expect(source).toContain('aria-keyshortcuts~=\"ArrowRight\"');
    expect(source).not.toContain(':has-text(');
    expect(source).toContain('waitForChatgptIntelligenceControl'); expect(source).toContain('reasoningLabelMatches'); expect(source).toContain("'main button, main [role=\"button\"]'"); expect(source).toContain("limit: selector.startsWith('main ') ? 80 : 240"); expect(source).toContain('chatgptAutomationReasoningLevelFromLabel'); expect(source).toContain('CHATGPT_AUTOMATION_LOGIN_REQUIRED'); expect(source).not.toContain('runScheduledChatgptPrompt'); const engine = readFileSync(join(process.cwd(), 'src/runtime/workflow/schedules/engine.ts'), 'utf8'); expect(engine).toContain('runWorkChatgptContinuation'); expect(engine).toContain("if (controllerType === 'chatgpt')"); expect(source).toContain('conversationUrl?: string'); expect(source).toContain("binding?.conversationUrl ?? seedUrl ?? 'https://chatgpt.com/'"); expect(engine).toContain("conversationUrl: typeof args.conversation_url === 'string' ? args.conversation_url : undefined");
    expect(source).toContain('CHATGPT_AUTOMATION_SUBMISSION_NOT_CONFIRMED'); expect(source).toContain('workflowToolAttributionInstruction'); expect(source).toContain('repository_command_execute and repository_safe_patch_apply');
    expect(source).toContain('buildBrowserPluginManifest(0, undefined, repoRoot).enabled');
    expect(source).toContain("controllerBrowserAction(controllerHome, workId, 'configure', { enabled: true })");
    expect(source.indexOf('buildBrowserPluginManifest(0, undefined, repoRoot).enabled')).toBeLessThan(source.indexOf("controllerBrowserAction(controllerHome, workId, 'configure', { enabled: true })"));
    expect(source).toContain('runStandaloneChatgptPrompt');
    const standaloneStart = source.indexOf('export async function runStandaloneChatgptPrompt');
    const workStart = source.indexOf('export async function runWorkChatgptContinuation');
    const standaloneSource = source.slice(standaloneStart, workStart);
    expect(standaloneSource).not.toContain('getWorkContract(');
    expect(standaloneSource).not.toContain('bindChatgptWorkConversation(');
    expect(engine).toContain('runStandaloneChatgptPrompt');
    expect(engine).toContain('Standalone browser keepalive auth-required prompt dispatched to ChatGPT.');
    const runtimeTools = readFileSync(join(process.cwd(), 'src/runtime/gateway/mcp/runtime-tools.ts'), 'utf8');
    const launcherStart = runtimeTools.slice(runtimeTools.indexOf("if (operation === 'launcher_start')"), runtimeTools.indexOf('const checks = listControllerChecks', runtimeTools.indexOf("if (operation === 'launcher_start')")));
    expect(launcherStart).toContain("if (controllerType === 'chatgpt')");
    expect(launcherStart).toContain('await runWorkChatgptContinuation({');
    expect(launcherStart).toContain("summary: 'ChatGPT continuation dispatched with a durable controller-round closure obligation.'");
    expect(launcherStart.indexOf('await runWorkChatgptContinuation({')).toBeLessThan(launcherStart.indexOf('const launched = await launchSuperController'));
    expect(launcherStart).toContain("controllerType: controllerType as 'codex' | 'grok' | 'claude'");
  });

  test('migrates legacy ChatGPT schedules idempotently without changing task state', () => {
    const base = {
      schemaVersion: 1, revision: 1, scheduleId: 'SCH-1', requestId: 'req-1', repoId: 'repo-1', name: 'Test', enabled: true,
      trigger: { type: 'interval', everyMinutes: 60 }, policy: { maxActiveOccurrences: 1, maxFailures: 3, cooldownMinutes: 1, dailyBudgetMinutes: 60, shadowMode: false },
      stopConditions: [], consecutiveFailures: 0, createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
    } satisfies Omit<RepositorySchedule, 'action'>;
    const migrated = migrateChatgptAutomationSchedule({ ...base, action: { operation: 'external_controller_wake', arguments: { work_id: 'WORK-1' } } });
    expect(migrated.changed).toBe(true);
    expect(migrated.schedule.enabled).toBe(true);
    expect(migrated.schedule.action.arguments).toMatchObject({ work_id: 'WORK-1', controller_type: 'chatgpt', model: 'gpt-5.6', reasoning: 'high', tab_policy: 'auto', execution_profile: 'chatgpt_browser_v1' });
    expect(migrateChatgptAutomationSchedule(migrated.schedule).changed).toBe(false);
    expect(migrateChatgptAutomationSchedule({ ...base, action: { operation: 'external_controller_wake', arguments: { controller_type: 'codex' } } }).changed).toBe(false);
  });
});


describe('ChatGPT native background-tab recovery', () => {
  test('launcher recovery creates a replacement page when native navigation requires replacement', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/control-plane/launcher/chatgpt-work-continuation.ts'), 'utf8');
    expect(source).toContain('BROWSER_AUTOMATION_BACKGROUND_NAVIGATION_REQUIRES_REPLACEMENT');
    expect(source).toContain("controllerBrowserAction(controllerHome, workId, 'open_page'");
    expect(source).toContain('navigation.browserSessionId');
  });
});
