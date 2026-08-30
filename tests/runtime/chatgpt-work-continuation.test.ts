import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { claimControllerSession, releaseControllerSession } from '../../src/runtime/control-plane/facade/controller-session-store';
import {
  acknowledgeControllerRoundClaim,
  beginControllerRoundRelayAfterRelease,
  beginInitialControllerRoundDispatch,
  finishControllerRoundRelayDispatch,
  submitControllerRoundDisposition,
} from '../../src/runtime/control-plane/facade/controller-round-relay';
import { createWorkContract, updateWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { chatgptBridgeTargetMatchesPage } from '../../src/cli/chatgpt-browser/bridge-provider';
import {
  bindChatgptWorkConversation,
  getChatgptWorkConversationBinding,
  hasChatgptConversationIdentity,
  parseChatgptConversationIdentity,
  rebindChatgptWorkConversation,
} from '../../src/runtime/control-plane/launcher/chatgpt-work-binding-store';
import {
  chatgptAutomationControlQueryLimit,
  chatgptAutomationControlWaitBudgets,
  chatgptAutomationNavigationRequiresReplacement,
  chatgptAutomationPageFailure,
  chatgptAutomationReasoningLevelFromLabel,
  chatgptBrowserActionArgs,
  isChatgptConversationUrl,
  reconciledChatgptOpenPageSessionId,
  resolveChatgptWorkBrowserSessionId,
  runWorkChatgptContinuation,
  stableChatgptWorkBrowserSessionId,
  stableStandaloneChatgptBrowserSessionId,
} from '../../src/runtime/control-plane/launcher/chatgpt-work-continuation';
import { migrateChatgptAutomationSchedule } from '../../src/runtime/workflow/schedules/chatgpt-automation-migration';
import { classifyChatgptWakeFailure } from '../../src/runtime/workflow/schedules/engine';
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
    expect(hasChatgptConversationIdentity('https://chatgpt.com/')).toBe(false);
    expect(hasChatgptConversationIdentity('https://chatgpt.com/g/g-p-project/project')).toBe(false);
    expect(hasChatgptConversationIdentity('https://chatgpt.com/c/abc-123')).toBe(true);
    expect(() => hasChatgptConversationIdentity('https://example.com/c/abc')).toThrow('CHATGPT_WORK_CONVERSATION_URL_INVALID');
    expect(() => parseChatgptConversationIdentity('https://example.com/c/abc')).toThrow('CHATGPT_WORK_CONVERSATION_URL_INVALID');
  });

  test('does not persist a ChatGPT root seed URL without a conversation id', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-chatgpt-root-seed-binding-'));
    roots.push(root);
    const controllerHome = join(root, 'controller');
    ensureControllerHome(controllerHome);
    const options = { controllerHome, repoId: 'repo-chatgpt-root-seed' };
    expect(() => bindChatgptWorkConversation(options, {
      workId: 'WORK-ROOT-SEED',
      conversationUrl: 'https://chatgpt.com/',
      latestBrowserSessionId: 'browser-root-seed',
    })).toThrow('CHATGPT_WORK_CONVERSATION_ID_MISSING');
    expect(getChatgptWorkConversationBinding(options, 'WORK-ROOT-SEED')).toBeUndefined();
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

  test('replaces intentionally closed or stale automation sessions instead of failing continuation', () => {
    expect(chatgptAutomationNavigationRequiresReplacement(new Error('BROWSER_AUTOMATION_BACKGROUND_NAVIGATION_REQUIRES_REPLACEMENT'))).toBe(true);
    expect(chatgptAutomationNavigationRequiresReplacement(new Error('PLUGIN_BROWSER_SESSION_STATE_LOST: closed automation tab'))).toBe(true);
    expect(chatgptAutomationNavigationRequiresReplacement(new Error('PLUGIN_SESSION_NOT_FOUND: closed automation session'))).toBe(true);
    expect(chatgptAutomationNavigationRequiresReplacement(new Error('PLUGIN_BROWSER_NATIVE_TAB_IDENTITY_UNPROVEN: Saved chrome tab 2095932867 no longer exists in live inventory.'))).toBe(true);
    expect(chatgptAutomationNavigationRequiresReplacement(new Error('PLUGIN_BROWSER_NATIVE_OPERATION_FAILED: Google Chrome Apple Events operation failed: PLUGIN_BROWSER_NATIVE_TAB_IDENTITY_UNPROVEN: Saved chrome tab 2095932906 no longer exists in live inventory.'))).toBe(true);
    expect(chatgptAutomationNavigationRequiresReplacement(new Error('PLUGIN_MACOS_CAPABILITY_BROKER_UNAVAILABLE: desktop-operator.sock unavailable'))).toBe(false);
    expect(chatgptAutomationNavigationRequiresReplacement(new Error('CHATGPT_AUTOMATION_LOGIN_REQUIRED'))).toBe(false);
  });

  test('keeps transient native browser loss retryable without hiding user-auth blockers', () => {
    expect(classifyChatgptWakeFailure('PLUGIN_BROWSER_NATIVE_TAB_IDENTITY_UNPROVEN: saved tab disappeared')).toBe('retryable_readiness');
    expect(classifyChatgptWakeFailure('PLUGIN_MACOS_CAPABILITY_BROKER_UNAVAILABLE: desktop-operator.sock unavailable')).toBe('retryable_readiness');
    expect(classifyChatgptWakeFailure('CHATGPT_AUTOMATION_LOGIN_REQUIRED')).toBe('user_action_required');
  });

  test('recognizes contextual ChatGPT reasoning labels without matching unrelated UI', () => {
    expect(chatgptAutomationReasoningLevelFromLabel('High')).toBe('high');
    expect(chatgptAutomationReasoningLevelFromLabel('Thinking: High')).toBe('high');
    expect(chatgptAutomationReasoningLevelFromLabel('Reasoning · High')).toBe('high');
    expect(chatgptAutomationReasoningLevelFromLabel('推理强度：高')).toBe('high');
    expect(chatgptAutomationReasoningLevelFromLabel('高')).toBe('high');
    expect(chatgptAutomationReasoningLevelFromLabel('Thinking: Extra High')).toBe('xhigh');
    expect(chatgptAutomationReasoningLevelFromLabel('Medium reasoning')).toBe('medium');
    expect(chatgptAutomationReasoningLevelFromLabel('High contrast')).toBeUndefined();
  });

  test('keeps ChatGPT control readiness probes repeatable within a bounded hydration window', () => {
    expect(chatgptAutomationControlQueryLimit('main button, main [role="button"]')).toBe(160);
    expect(chatgptAutomationControlQueryLimit('button, [role="button"]')).toBe(320);
    expect(chatgptAutomationControlWaitBudgets()).toEqual({ waitBudgetMs: 30_000, probeTimeoutMs: 5_000 });
    expect(chatgptAutomationControlWaitBudgets(8_000)).toEqual({ waitBudgetMs: 8_000, probeTimeoutMs: 5_000 });
    expect(chatgptAutomationControlWaitBudgets(1_000)).toEqual({ waitBudgetMs: 1_000, probeTimeoutMs: 1_000 });
    expect(chatgptAutomationControlWaitBudgets(60_000)).toEqual({ waitBudgetMs: 30_000, probeTimeoutMs: 5_000 });
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
    expect(source).toContain('waitForChatgptIntelligenceControl'); expect(source).toContain('reasoningLabelMatches'); expect(source).toContain("'main button, main [role=\"button\"]'"); expect(source).toContain('limit: chatgptAutomationControlQueryLimit(selector)'); expect(source).toContain('chatgptAutomationReasoningLevelFromLabel'); expect(source).toContain('CHATGPT_AUTOMATION_LOGIN_REQUIRED'); expect(source).not.toContain('runScheduledChatgptPrompt'); const engine = readFileSync(join(process.cwd(), 'src/runtime/workflow/schedules/engine.ts'), 'utf8'); expect(engine).toContain('runWorkChatgptContinuation'); expect(engine).toContain("if (controllerType === 'chatgpt')"); expect(source).toContain('conversationUrl?: string'); expect(source).toContain("binding?.conversationUrl ?? seedUrl ?? 'https://chatgpt.com/'"); expect(engine).toContain("conversationUrl: typeof args.conversation_url === 'string' ? args.conversation_url : undefined");
    expect(source).toContain('seedUrl && !binding && hasChatgptConversationIdentity(seedUrl)');
    expect(source).toContain('CHATGPT_AUTOMATION_SUBMISSION_NOT_CONFIRMED'); expect(source).toContain('workflowToolAttributionInstruction'); expect(source).toContain('repository_command_execute and repository_safe_patch_apply');
    expect(source).toContain("controllerBrowserAction(controllerHome, workId, 'close_page'");
    expect(source).toContain('closeChatgptAutomationTabAfterDispatch');
    expect(source).toContain('settleWorkChatgptAutomationTab');
    const workContinuation = source.slice(source.indexOf('export async function runWorkChatgptContinuation'));
    expect(workContinuation).not.toContain('closeChatgptAutomationTabAfterDispatch(');
    expect(workContinuation).not.toContain('tabCleanupStatus: tabCleanup.status');
    expect(source).toContain("'PLUGIN_BROWSER_SESSION_STATE_LOST'");
    expect(source).toContain("'PLUGIN_SESSION_NOT_FOUND'");
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
    expect(launcherStart).toContain("summary: 'ChatGPT continuation dispatched;");
    expect(launcherStart).toContain("semantic closure still requires an explicit disposition.'");
    expect(launcherStart.indexOf('await runWorkChatgptContinuation({')).toBeLessThan(launcherStart.indexOf('const launched = await launchSuperController'));
    expect(launcherStart).toContain("controllerType: controllerType as 'codex' | 'grok' | 'claude'");
    const controllerRelease = runtimeTools.slice(runtimeTools.indexOf("if (operation === 'controller_release')"), runtimeTools.indexOf("if (operation === 'launcher_start')"));
    expect(controllerRelease).toContain('await runWorkChatgptContinuation({');
    expect(controllerRelease).not.toContain('await runStandaloneChatgptPrompt({');
    expect(controllerRelease).toContain('settleWorkChatgptAutomationTab({');
    expect(controllerRelease).toContain("status: 'retained_for_immediate_continuation'");
    expect(controllerRelease).toContain("['waiting', 'waiting_for_user', 'goal_complete', 'blocked', 'failed']");
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


describe('ChatGPT scheduled open_page reconciliation', () => {
  test('accepts only one exact live Work session after an unknown open_page outcome', () => {
    const sessionId = stableChatgptWorkBrowserSessionId('repo-1', 'WORK-1');
    expect(reconciledChatgptOpenPageSessionId({ sessions: [
      { sessionId, url: 'https://chatgpt.com/c/exact', liveness: 'live' },
    ] }, sessionId, 'https://chatgpt.com/c/exact')).toBe(sessionId);
    expect(reconciledChatgptOpenPageSessionId({ sessions: [
      { sessionId, url: 'https://chatgpt.com/c/exact', liveness: 'unverified' },
    ] }, sessionId, 'https://chatgpt.com/c/exact')).toBeUndefined();
    expect(reconciledChatgptOpenPageSessionId({ sessions: [
      { sessionId, url: 'https://chatgpt.com/c/other', liveness: 'live' },
    ] }, sessionId, 'https://chatgpt.com/c/exact')).toBeUndefined();
    expect(reconciledChatgptOpenPageSessionId({ sessions: [
      { sessionId, url: 'https://chatgpt.com/c/new-conversation', liveness: 'live' },
    ] }, sessionId, 'https://chatgpt.com/')).toBe(sessionId);
  });

  test('reconciles an unknown open_page outcome read-only instead of replaying the mutation', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/control-plane/launcher/chatgpt-work-continuation.ts'), 'utf8');
    expect(source).toContain("controllerBrowserAction(controllerHome, workId, 'list_sessions'");
    expect(source).toContain("browserMutationOutcomeUnknown(error, 'open_page')");
    expect(source).toContain('session_id: browserSessionId');
  });
});

describe('ChatGPT native background-tab recovery', () => {
  test('launcher recovery creates a replacement page when native navigation requires replacement', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/control-plane/launcher/chatgpt-work-continuation.ts'), 'utf8');
    expect(source).toContain('BROWSER_AUTOMATION_BACKGROUND_NAVIGATION_REQUIRES_REPLACEMENT');
    expect(source).toContain('PLUGIN_BROWSER_NATIVE_TAB_IDENTITY_UNPROVEN');
    expect(source).toContain("controllerBrowserAction(controllerHome, workId, 'open_page'");
    expect(source).toContain('navigation.browserSessionId');
  });
});

describe('controller relay repeated-state rearm', () => {
  test('rearms a blocked relay only after durable child Work state changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-controller-relay-rearm-'));
    roots.push(root);
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome);
    mkdirSync(repoRoot, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'relay@example.test'], ['config', 'user.name', 'Relay Test']] as string[][]) {
      execFileSync('git', args, { cwd: repoRoot });
    }
    writeFileSync(join(repoRoot, 'README.md'), 'relay rearm\n');
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'controller-relay-rearm' });
    const store = { controllerHome, repoId: repository.repoId };
    const workId = 'WORK-RELAY-REARM';
    const childWorkId = 'WORK-RELAY-REARM-CHILD';
    const workInput = {
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop' as const,
      acceptanceCriteria: ['Keep the relay fenced while allowing changed durable state to continue.'],
      allowedPaths: ['**/*'],
      forbiddenPaths: [],
      checks: [],
      constraints: { workspaceMode: 'current' as const, requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt' as const,
      status: 'running' as const,
    };
    createWorkContract(store, { ...workInput, workId, objective: 'Persistent supervisor Work.' });
    createWorkContract(store, {
      ...workInput,
      workId: childWorkId,
      lifecycleRole: 'execution_child',
      parentWorkId: workId,
      objective: 'Bound runtime transaction Work.',
    });
    const relayScopeId = `goal:${workId}`;
    beginInitialControllerRoundDispatch(store, {
      workId,
      relayScopeId,
      identity: { controllerId: 'launcher', principalId: 'launcher', controllerInstanceId: 'runtime-test', sessionId: 'launch-1' },
    });
    finishControllerRoundRelayDispatch(store, { workId, ok: true });
    const firstSession = claimControllerSession(store, {
      workId,
      controllerId: 'chatgpt-controller',
      controllerType: 'chatgpt',
      sessionId: 'chatgpt-session-1',
      principalId: 'chatgpt-principal',
      controllerInstanceId: 'runtime-test',
      leaseMs: 5 * 60_000,
    });
    expect(acknowledgeControllerRoundClaim(store, { workId, session: firstSession })?.status).toBe('claimed');
    const firstContinue = submitControllerRoundDisposition(store, {
      workId,
      relayScopeId,
      identity: {
        controllerId: firstSession.controllerId,
        principalId: firstSession.principalId ?? firstSession.controllerId,
        controllerInstanceId: firstSession.controllerInstanceId ?? 'runtime-test',
        sessionId: firstSession.sessionId,
      },
      disposition: 'continue_immediately',
    });
    expect(firstContinue).toMatchObject({ status: 'pending_release', repeatedStateCount: 1 });
    releaseControllerSession(store, workId, firstSession.controllerId);
    expect(beginControllerRoundRelayAfterRelease(store, { workId, releasedSession: firstSession })?.status).toBe('dispatching');
    finishControllerRoundRelayDispatch(store, { workId, ok: true });
    const secondSession = claimControllerSession(store, {
      workId,
      controllerId: 'chatgpt-controller',
      controllerType: 'chatgpt',
      sessionId: 'chatgpt-session-2',
      principalId: 'chatgpt-principal',
      controllerInstanceId: 'runtime-test',
      leaseMs: 5 * 60_000,
    });
    expect(acknowledgeControllerRoundClaim(store, { workId, session: secondSession })?.status).toBe('claimed');
    const blocked = submitControllerRoundDisposition(store, {
      workId,
      relayScopeId,
      identity: {
        controllerId: secondSession.controllerId,
        principalId: secondSession.principalId ?? secondSession.controllerId,
        controllerInstanceId: secondSession.controllerInstanceId ?? 'runtime-test',
        sessionId: secondSession.sessionId,
      },
      disposition: 'continue_immediately',
    });
    expect(blocked).toMatchObject({ status: 'blocked', repeatedStateCount: 2, blockedReason: 'repeated_state:2>=2' });
    expect(acknowledgeControllerRoundClaim(store, { workId, session: secondSession })).toMatchObject({
      status: 'blocked',
      stateFingerprint: blocked.stateFingerprint,
      blockedReason: 'repeated_state:2>=2',
    });

    updateWorkContract(store, childWorkId, { evidenceState: 'partial' });
    const rearmed = acknowledgeControllerRoundClaim(store, { workId, session: secondSession });
    expect(rearmed).toMatchObject({ status: 'claimed', repeatedStateCount: 0, roundCount: blocked.roundCount });
    expect(rearmed?.stateFingerprint).not.toBe(blocked.stateFingerprint);
    expect(rearmed?.blockedReason).toBeUndefined();

    const continued = submitControllerRoundDisposition(store, {
      workId,
      relayScopeId,
      identity: {
        controllerId: secondSession.controllerId,
        principalId: secondSession.principalId ?? secondSession.controllerId,
        controllerInstanceId: secondSession.controllerInstanceId ?? 'runtime-test',
        sessionId: secondSession.sessionId,
      },
      disposition: 'continue_immediately',
    });
    expect(continued).toMatchObject({ status: 'pending_release', repeatedStateCount: 1 });
  });
});
