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
} from '../../src/runtime/control-plane/launcher/chatgpt-work-binding-store';
import {
  resolveChatgptWorkBrowserSessionId,
  runWorkChatgptContinuation,
  stableChatgptAutomationBrowserSessionId,
  stableChatgptWorkBrowserSessionId,
} from '../../src/runtime/control-plane/launcher/chatgpt-work-continuation';
import { migrateChatgptAutomationSchedule } from '../../src/runtime/workflow/schedules/chatgpt-automation-migration';
import type { RepositorySchedule } from '../../src/runtime/workflow/schedules/types';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('ChatGPT Work conversation binding', () => {
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

  test('uses a stable per-Work browser session and migrates away from the legacy global tab', () => {
    const first = stableChatgptWorkBrowserSessionId('repo-1', 'WORK-1');
    expect(first).toBe(stableChatgptWorkBrowserSessionId('repo-1', 'WORK-1'));
    expect(first).not.toBe(stableChatgptWorkBrowserSessionId('repo-1', 'WORK-2'));
    expect(resolveChatgptWorkBrowserSessionId({ repoId: 'repo-1', workId: 'WORK-1', boundSessionId: 'forge-chatgpt-supercontroller' })).toBe(first);
    expect(resolveChatgptWorkBrowserSessionId({ repoId: 'repo-1', workId: 'WORK-1', boundSessionId: 'work-owned-session' })).toBe('work-owned-session');
    expect(resolveChatgptWorkBrowserSessionId({ repoId: 'repo-1', workId: 'WORK-1', tabPolicy: 'new' })).toStartWith(`${first}-`);
  });

  test('uses a stable per-automation browser session for standalone scheduled prompts', () => {
    const first = stableChatgptAutomationBrowserSessionId('repo-1', 'SCH-1');
    expect(first).toBe(stableChatgptAutomationBrowserSessionId('repo-1', 'SCH-1'));
    expect(first).not.toBe(stableChatgptAutomationBrowserSessionId('repo-1', 'SCH-2'));
    expect(first).toStartWith('forge-chatgpt-automation-');
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
    expect(source).toContain("CHATGPT_PROMPT_SELECTOR = 'div#prompt-textarea[contenteditable=\"true\"]'"); expect(source).toContain("CHATGPT_SEND_SELECTOR = '[data-testid=\"send-button\"]'");
    expect(source).toContain("DEFAULT_CHATGPT_AUTOMATION_MODEL = 'gpt-5.6'");
    expect(source).toContain("DEFAULT_CHATGPT_AUTOMATION_REASONING = 'high'");
    expect(source).toContain("DEFAULT_CHATGPT_AUTOMATION_PLUGIN_MENTION = '@forge'"); expect(source).not.toContain('CHATGPT_WORK_MODE_RADIO_SELECTOR');
    expect(source).toContain('CHATGPT_CAPABILITY_MENUITEM_SELECTOR');
    expect(source).toContain('aria-keyshortcuts~=\"ArrowRight\"');
    expect(source).not.toContain(':has-text(');
    expect(source).toContain('waitForChatgptIntelligenceControl'); expect(source).toContain('runScheduledChatgptPrompt'); const engine = readFileSync(join(process.cwd(), 'src/runtime/workflow/schedules/engine.ts'), 'utf8'); expect(engine).toContain('runWorkChatgptContinuation'); expect(engine).toContain("if (controllerType === 'chatgpt')"); expect(source).toContain('conversationUrl?: string'); expect(source).toContain("input.conversationUrl?.trim() || 'https://chatgpt.com/'"); expect(engine).toContain("conversationUrl: typeof args.conversation_url === 'string' ? args.conversation_url : undefined"); expect(engine).toContain('conversation_url: durableConversationUrl');
    expect(source).toContain('CHATGPT_AUTOMATION_SUBMISSION_NOT_CONFIRMED'); expect(source).toContain('workflowToolAttributionInstruction'); expect(source).toContain('repository_command_execute and repository_safe_patch_apply');
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
