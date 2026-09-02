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
  claimStalledControllerRoundRelays,
  finishControllerRoundRelayDispatch,
  getControllerRoundRelay,
  submitControllerRoundDisposition,
} from '../../src/runtime/control-plane/facade/controller-round-relay';
import { classifyChatgptProviderFailure } from '../../adapters/chatgpt/provider-delivery';
import { createHandoffItem } from '../../src/runtime/control-plane/facade/handoff-inbox-store';
import { createWorkContract, updateWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { chatgptBridgeTargetMatchesPage, isWslWindowsRuntime, openWslWindowsBridgeTarget } from '../../src/cli/chatgpt-browser/bridge-provider';
import { writeChatgptBridgeExtension } from '../../src/cli/chatgpt-browser/bridge-extension';
import { ensureBridgeToken, readBrowserBinding } from '../../src/cli/chatgpt-browser/binding';
import {
  bindChatgptWorkConversation,
  getChatgptWorkConversationBinding,
  hasChatgptConversationIdentity,
  parseChatgptConversationIdentity,
  rebindChatgptWorkConversation,
} from '../../src/runtime/control-plane/launcher/chatgpt-work-binding-store';
import {
  chatgptOutboundMessageMatchesPrompt,
  chatgptAutomationControlQueryLimit,
  chatgptAutomationControlWaitBudgets,
  chatgptAutomationNavigationRequiresReplacement,
  chatgptAutomationPageFailure,
  chatgptAutomationReasoningLevelFromLabel,
  chatgptBrowserActionArgs,
  isChatgptConversationUrl,
  reconciledNewChatgptOpenPageSessionId,
  resolveChatgptWorkBrowserSessionId,
  runWorkChatgptContinuation,
  stableChatgptWorkBridgeSessionId,
  stableChatgptWorkBrowserSessionId,
  stableStandaloneChatgptBrowserSessionId,
  settleWorkChatgptAutomationTab,
} from '../../src/runtime/control-plane/launcher/chatgpt-work-continuation';
import { migrateChatgptAutomationSchedule } from '../../src/runtime/workflow/schedules/chatgpt-automation-migration';
import { classifyChatgptWakeFailure } from '../../src/runtime/workflow/schedules/engine';
import {
  createWorkContinuationSchedule,
  eventDrivenContinuationSchedule,
  handoffResolvedContinuationEventName,
  listWorkContinuationSchedules,
  resolveHandoffAndTriggerContinuation,
} from '../../src/runtime/workflow/schedules/work-continuation';
import { createSchedule, listOccurrences } from '../../src/runtime/workflow/schedules/store';
import type { RepositorySchedule } from '../../src/runtime/workflow/schedules/types';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('ChatGPT provider delivery classification', () => {
  test('separates ambiguous mutation, user blockers, and ordinary provider failure', () => {
    expect(classifyChatgptProviderFailure('CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN')).toBe('outcome_unknown');
    expect(classifyChatgptProviderFailure('CHATGPT_AUTOMATION_LOGIN_REQUIRED')).toBe('wait_for_user');
    expect(classifyChatgptProviderFailure('CHATGPT_PERMISSION_REQUIRED')).toBe('wait_for_user');
    expect(classifyChatgptProviderFailure('CHATGPT_BRIDGE_DISPATCH_FAILED')).toBe('failed');
  });
});

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

  test('creates one stable bridge-only capability binding without inventing a native browser profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-chatgpt-bridge-binding-'));
    roots.push(root);
    const first = ensureBridgeToken(root);
    const second = ensureBridgeToken(root);
    expect(second).toBe(first);
    const binding = readBrowserBinding(root).binding;
    expect(binding?.bridgeToken).toBe(first);
    expect(binding?.profileDir).toBeUndefined();
    expect(binding?.chatgptUrl).toBe('https://chatgpt.com/');
  });

  test('selects the Windows bridge only for WSL and gives it a non-Browser session identity', async () => {
    expect(isWslWindowsRuntime('linux', 'UbuntuDev', '6.6.0-linux')).toBe(true);
    expect(isWslWindowsRuntime('linux', undefined, '5.15.153.1-microsoft-standard-WSL2')).toBe(true);
    expect(isWslWindowsRuntime('linux', undefined, '6.8.0-generic')).toBe(false);
    expect(isWslWindowsRuntime('darwin', undefined, 'Darwin')).toBe(false);
    const bridgeSession = stableChatgptWorkBridgeSessionId('repo-1', 'WORK-1');
    expect(bridgeSession).toBe(stableChatgptWorkBridgeSessionId('repo-1', 'WORK-1'));
    expect(bridgeSession).toStartWith('forge-chatgpt-bridge-');
    expect(await settleWorkChatgptAutomationTab({ controllerHome: '/unused', workId: 'WORK-1', browserSessionId: bridgeSession }))
      .toEqual({ status: 'session_closed' });
  });

  test('opens WSL bridge targets with an explicit Google Chrome executable and fails closed otherwise', async () => {
    const launches: Array<{ executable: string; args: readonly string[] }> = [];
    const launch = ((executable: string, args: readonly string[]) => {
      launches.push({ executable, args });
      const child: any = {
        once(event: string, listener: (value?: any) => void) {
          if (event === 'spawn') queueMicrotask(() => listener());
          return child;
        },
        unref() { return child; },
      };
      return child;
    }) as typeof import('child_process').spawn;
    await openWslWindowsBridgeTarget('https://chatgpt.com/c/round-1', {
      platform: 'linux',
      wslDistroName: 'UbuntuDev',
      chromeExecutables: ['/missing/chrome.exe', '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe'],
      fileExists: (path) => path === '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
      launch,
    });
    expect(launches).toEqual([{
      executable: '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
      args: ['--new-tab', 'https://chatgpt.com/c/round-1'],
    }]);
    await expect(openWslWindowsBridgeTarget('https://chatgpt.com/', {
      platform: 'linux',
      wslDistroName: 'UbuntuDev',
      chromeExecutables: ['/missing/chrome.exe'],
      fileExists: () => false,
      launch,
    })).rejects.toThrow('CHATGPT_BRIDGE_CHROME_UNAVAILABLE');
    await expect(openWslWindowsBridgeTarget('https://example.com/', {
      platform: 'linux',
      wslDistroName: 'UbuntuDev',
      fileExists: () => true,
      launch,
    })).rejects.toThrow('CHATGPT_BRIDGE_TARGET_INVALID');
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
  test('native ChatGPT outbound matching is semantic and bounded', () => {
    const prompt = '@forge Continue exact Work work-native-send and preserve the same conversation. '.repeat(6).trim();
    expect(chatgptOutboundMessageMatchesPrompt(prompt, prompt)).toBe(true);
    expect(chatgptOutboundMessageMatchesPrompt(prompt.replace(/\s+/g, '   '), prompt)).toBe(true);
    expect(chatgptOutboundMessageMatchesPrompt(`prefix ${prompt}`, prompt)).toBe(false);
    expect(chatgptOutboundMessageMatchesPrompt(`${prompt.slice(0, 160)} but wrong tail`, prompt)).toBe(false);
    expect(chatgptOutboundMessageMatchesPrompt('', prompt)).toBe(false);
  });

  test('scheduled WSL continuation uses semantic outbound dispatch confirmation instead of Browser replay', () => {
    const launcher = readFileSync(join(process.cwd(), 'src/runtime/control-plane/launcher/chatgpt-work-continuation.ts'), 'utf8');
    const wslHost = readFileSync(join(process.cwd(), 'adapters/chatgpt/wsl-bridge-delivery-host.ts'), 'utf8');
    const provider = readFileSync(join(process.cwd(), 'src/cli/chatgpt-browser/bridge-provider.ts'), 'utf8');
    const extension = readFileSync(join(process.cwd(), 'src/cli/chatgpt-browser/bridge-extension.ts'), 'utf8');
    const engine = readFileSync(join(process.cwd(), 'src/runtime/workflow/schedules/engine.ts'), 'utf8');
    const generatedRoot = mkdtempSync(join(tmpdir(), 'forge-chatgpt-bridge-generated-'));
    roots.push(generatedRoot);
    const generated = writeChatgptBridgeExtension(generatedRoot, 'http://127.0.0.1:17651', 'test-token');
    const generatedScript = readFileSync(generated.contentScriptPath, 'utf8');
    expect(() => new Function(generatedScript)).not.toThrow();
    expect(launcher).toContain('const bridgeRuntime = isWslWindowsRuntime()');
    expect(launcher).toContain('createChatgptWslBridgeDeliveryHost()');
    expect(wslHost).toContain('dispatchOnly: true');
    expect(wslHost).toContain("provider: 'chatgpt-bridge'");
    expect(provider).toContain("url.pathname === '/api/extension/dispatched'");
    expect(provider).toContain('state.dispatched');
    expect(provider).toContain("typeof body.outboundFingerprint === 'string'");
    expect(extension).toContain('forgeLastDispatch');
    expect(extension).toContain('FORGE_CHATGPT_USER');
    expect(extension).toContain('forgeOutboundMessageMatchesPrompt');
    expect(extension).toContain("forgePost('/api/extension/dispatched'");
    expect(generatedScript).toContain('forgeHasConversationIdentity');
    expect(generatedScript).toContain('outboundFingerprint: forgeOutboundFingerprint(prompt)');
    expect(generatedScript).toContain('.split(String.fromCharCode(10)).join');
    expect(generatedScript).not.toContain("replace(/s+/g");
    expect(generatedScript).not.toContain('initialHasConversation = //c/');
    expect(engine).toContain("status: 'dispatched'");
    expect(engine).toContain('semantic round closure is still pending');
    expect(engine).not.toContain('ChatGPT dispatch action succeeded via');
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

  test('fails closed before browser mutation when relay authority inputs are incomplete', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-chatgpt-work-incomplete-authority-'));
    roots.push(root);
    const controllerHome = join(root, 'controller');
    ensureControllerHome(controllerHome);

    const missingScope = await runWorkChatgptContinuation({
      controllerHome,
      repoId: 'repo-chatgpt-work',
      repoRoot: root,
      workId: 'WORK-incomplete-authority',
      prompt: 'continue',
      controllerAuthorityId: 'cra_11111111111111111111111111111111',
    });
    expect(missingScope.status).toBe('failed');
    expect(missingScope.error?.code).toBe('CHATGPT_CONTROLLER_ROUND_AUTHORITY_INCOMPLETE');

    const missingAuthority = await runWorkChatgptContinuation({
      controllerHome,
      repoId: 'repo-chatgpt-work',
      repoRoot: root,
      workId: 'WORK-incomplete-authority',
      prompt: 'continue',
      relayScopeId: 'goal:WORK-incomplete-authority',
    });
    expect(missingAuthority.status).toBe('failed');
    expect(missingAuthority.error?.code).toBe('CHATGPT_CONTROLLER_ROUND_AUTHORITY_INCOMPLETE');
  });

  test('keeps automation in Chat mode, prefixes @forge, and submits from the stable prompt editor', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/control-plane/launcher/chatgpt-work-continuation.ts'), 'utf8');
    const browserRuntime = readFileSync(join(process.cwd(), 'adapters/chatgpt/browser-delivery-runtime.ts'), 'utf8');
    const providerDelivery = readFileSync(join(process.cwd(), 'adapters/chatgpt/provider-delivery.ts'), 'utf8');
    expect(browserRuntime).toContain("CHATGPT_PROMPT_SELECTOR = 'div#prompt-textarea[contenteditable=\"true\"]'"); expect(browserRuntime).toContain("CHATGPT_SEND_SELECTOR = '[data-testid=\"send-button\"], button[aria-label*=\"Send\"], button[data-testid*=\"send\"]'");
    expect(providerDelivery).toContain("DEFAULT_CHATGPT_AUTOMATION_MODEL = 'gpt-5.6'");
    expect(providerDelivery).toContain("DEFAULT_CHATGPT_AUTOMATION_REASONING = 'high'");
    expect(source).toContain("DEFAULT_CHATGPT_AUTOMATION_PLUGIN_MENTION = '@forge'"); expect(browserRuntime).not.toContain('CHATGPT_WORK_MODE_RADIO_SELECTOR');
    expect(source).toContain('Capture data.controllerAuthorityId from that successful controller_claim response');
    expect(source).toContain('This launched round already has durable controller authority controller_authority_id=');
    expect(source).toContain('Use that exact authority on the FIRST controller_claim');
    expect(source).toContain('do not call an unscoped controller_claim');
    expect(source).toContain('capability_id=controller.round:controller_claim:');
    expect(source).toContain('pass the same opaque value as session_id compatibility carrier');
    expect(source).toContain('Never use data.session.sessionId as the durable capability');
    expect(browserRuntime).toContain('CHATGPT_CAPABILITY_MENUITEM_SELECTOR');
    expect(browserRuntime).toContain('aria-keyshortcuts~=\"ArrowRight\"');
    expect(browserRuntime).not.toContain(':has-text(');
    expect(browserRuntime).toContain('waitForChatgptIntelligenceControl'); expect(browserRuntime).toContain('reasoningLabelMatches'); expect(browserRuntime).toContain("'main button, main [role=\"button\"]'"); expect(browserRuntime).toContain('limit: chatgptAutomationControlQueryLimit(selector)'); expect(browserRuntime).toContain('chatgptAutomationReasoningLevelFromLabel'); expect(browserRuntime).toContain('CHATGPT_AUTOMATION_LOGIN_REQUIRED'); expect(source).not.toContain('runScheduledChatgptPrompt'); const engine = readFileSync(join(process.cwd(), 'src/runtime/workflow/schedules/engine.ts'), 'utf8'); expect(engine).toContain('resumeScheduledControllerContinuation'); expect(engine).toContain('controllerHostForScheduledBinding'); expect(engine).toContain('SCHEDULE_CONTINUATION_CONTROLLER_SESSION_REQUIRED'); expect(engine).not.toContain('runWorkChatgptContinuation'); expect(source).toContain('conversationUrl?: string'); expect(source).toContain("binding?.conversationUrl ?? seedUrl ?? 'https://chatgpt.com/'");
    expect(source).toContain('seedUrl && !binding && hasChatgptConversationIdentity(seedUrl)');
    expect(browserRuntime).toContain('CHATGPT_AUTOMATION_SUBMISSION_NOT_CONFIRMED'); expect(source).toContain('workflowToolAttributionInstruction'); expect(source).toContain('repository_command_execute and repository_safe_patch_apply');
    expect(browserRuntime).toContain('CHATGPT_USER_MESSAGE_SELECTOR'); expect(browserRuntime).toContain("from_end: true"); expect(browserRuntime).toContain("browserMutationOutcomeUnknown(error, 'click')"); expect(browserRuntime).toContain('chatgptOutboundMessageMatchesPrompt(fullText, renderedPrompt)');
    expect(browserRuntime).toContain("controllerBrowserAction(controllerHome, workId, 'close_page'");
    expect(source).toContain('closeChatgptAutomationTabAfterDispatch');
    expect(browserRuntime).toContain('settleWorkChatgptAutomationTab');
    const workContinuation = source.slice(source.indexOf('export async function runWorkChatgptContinuation'));
    expect(workContinuation).not.toContain('closeChatgptAutomationTabAfterDispatch(');
    expect(workContinuation).not.toContain('tabCleanupStatus: tabCleanup.status');
    expect(browserRuntime).toContain("'PLUGIN_BROWSER_SESSION_STATE_LOST'");
    expect(browserRuntime).toContain("'PLUGIN_SESSION_NOT_FOUND'");
    expect(browserRuntime).toContain('buildBrowserPluginManifest(0, undefined, repoRoot).enabled');
    expect(browserRuntime).toContain("controllerBrowserAction(controllerHome, workId, 'configure', { enabled: true })");
    expect(browserRuntime.indexOf('buildBrowserPluginManifest(0, undefined, repoRoot).enabled')).toBeLessThan(browserRuntime.indexOf("controllerBrowserAction(controllerHome, workId, 'configure', { enabled: true })"));
    expect(source).toContain('runStandaloneChatgptPrompt');
    const standaloneStart = source.indexOf('export async function runStandaloneChatgptPrompt');
    const workStart = source.indexOf('export async function runWorkChatgptContinuation');
    const standaloneSource = source.slice(standaloneStart, workStart);
    expect(standaloneSource).not.toContain('getWorkContract(');
    expect(standaloneSource).not.toContain('bindChatgptWorkConversation(');
    expect(engine).toContain('runStandaloneChatgptPrompt');
    expect(engine).toContain('resumeScheduledControllerContinuation(');
    expect(engine).not.toContain('controllerAuthorityId: relay.authorityId');
    expect(engine).not.toContain('relayScopeId: relay.relayScopeId');
    expect(engine).toContain('Standalone browser keepalive auth-required prompt dispatched to ChatGPT.');
    const runtimeTools = readFileSync(join(process.cwd(), 'adapters/mcp/runtime-gateway/runtime-tools.ts'), 'utf8');
    const launcherStart = runtimeTools.slice(runtimeTools.indexOf("if (operation === 'launcher_start')"), runtimeTools.indexOf('const checks = listControllerChecks', runtimeTools.indexOf("if (operation === 'launcher_start')")));
    expect(launcherStart).toContain("if (controllerType === 'chatgpt')");
    expect(launcherStart).toContain('await runWorkChatgptContinuation({');
    expect(launcherStart).toContain('controllerAuthorityId: relay.authorityId');
    expect(launcherStart).toContain('relayScopeId: relay.relayScopeId');
    expect(launcherStart).toContain("summary: 'ChatGPT continuation dispatched;");
    expect(launcherStart).toContain("semantic closure still requires an explicit disposition.'");
    expect(launcherStart.indexOf('await runWorkChatgptContinuation({')).toBeLessThan(launcherStart.indexOf('const launched = await launchSuperController'));
    expect(launcherStart).toContain("controllerType: controllerType as 'codex' | 'grok' | 'claude'");
    const controllerRelease = runtimeTools.slice(runtimeTools.indexOf("if (operation === 'controller_release')"), runtimeTools.indexOf("if (operation === 'launcher_start')"));
    expect(controllerRelease).toContain('await runWorkChatgptContinuation({');
    expect(controllerRelease).toContain('controllerAuthorityId: relay.authorityId');
    expect(controllerRelease).toContain('relayScopeId: relay.relayScopeId');
    expect(controllerRelease).not.toContain('await runStandaloneChatgptPrompt({');
    expect(controllerRelease).toContain('settleWorkChatgptAutomationTab({');
    expect(controllerRelease).toContain("status: 'retained_for_immediate_continuation'");
    expect(controllerRelease).toContain("['waiting', 'waiting_for_user', 'goal_complete', 'blocked', 'failed']");
  });

  test('event-driven continuation schedule creation is live and idempotent for one exact Work event', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-event-continuation-idempotent-'));
    roots.push(root);
    const controllerHome = join(root, 'controller');
    ensureControllerHome(controllerHome);
    const repoRoot = join(root, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'forge-test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'fixture\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'event-continuation-idempotent' });
    const store = { controllerHome, repoId: repository.repoId };
    const workId = 'WORK-EVENT-CONTINUATION-IDEMPOTENT';
    createWorkContract(store, {
      workId, repoId: repository.repoId, checkoutId: repository.activeCheckoutId, mode: 'goal_workloop',
      objective: 'Keep one exact event continuation schedule.', acceptanceCriteria: ['event schedule is idempotent'],
      allowedPaths: ['**/*'], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt', status: 'running',
    });
    claimControllerSession(store, {
      workId, controllerId: 'event-schedule-controller', controllerType: 'chatgpt',
      sessionId: 'event-schedule-session', principalId: 'event-schedule-controller', controllerInstanceId: 'event-schedule-runtime', leaseMs: 60_000,
    });
    const eventName = 'handoff-resolved:HND-IDEMPOTENT';
    const first = eventDrivenContinuationSchedule(controllerHome, repository.repoId, { workId, eventName, reason: 'first create' });
    const second = eventDrivenContinuationSchedule(controllerHome, repository.repoId, { workId, eventName, reason: 'second ensure' });
    expect(second.scheduleId).toBe(first.scheduleId);
    expect(first.policy.shadowMode).toBe(false);
    expect(first.trigger).toEqual({ type: 'repository-event', eventName });
    expect(first.action.arguments?.work_id).toBe(workId);
  });

  test('resolving a Handoff triggers only the exact Work repository-event continuation schedule', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-handoff-event-continuation-'));
    roots.push(root);
    const controllerHome = join(root, 'controller');
    ensureControllerHome(controllerHome);
    const repoRoot = join(root, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'forge-test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'fixture\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'handoff-event-continuation' });
    const store = { controllerHome, repoId: repository.repoId };
    const workId = 'WORK-HANDOFF-EVENT';
    createWorkContract(store, {
      workId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop',
      objective: 'Resume when the bounded Handoff is resolved.',
      acceptanceCriteria: ['Only the exact Work continuation schedule may wake.'],
      allowedPaths: ['**/*'],
      forbiddenPaths: [],
      checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });
    claimControllerSession(store, {
      workId,
      controllerId: 'test-controller',
      controllerType: 'chatgpt',
      sessionId: 'test-handoff-controller-session',
      principalId: 'test-controller',
      controllerInstanceId: 'test-runtime',
      leaseMs: 60_000,
    });
    releaseControllerSession(store, workId, 'test-controller');
    const handoffId = 'HND-HANDOFF-EVENT';
    const eventName = handoffResolvedContinuationEventName(handoffId);
    const schedule = createWorkContinuationSchedule(controllerHome, repository.repoId, {
      workId, controllerType: 'chatgpt', triggerType: 'repository-event', eventName, shadowMode: true, cooldownMinutes: 0,
    }).schedule;
    const decoy = createSchedule(controllerHome, {
      requestId: 'decoy-handoff-event',
      repoId: repository.repoId,
      name: 'decoy other Work event continuation',
      enabled: true,
      trigger: { type: 'repository-event', eventName },
      policy: { maxActiveOccurrences: 1, maxFailures: 3, cooldownMinutes: 0, dailyBudgetMinutes: 60, shadowMode: true },
      action: { operation: 'external_controller_wake', target: 'runtime', arguments: { work_id: 'WORK-DECOY', controller_type: 'chatgpt' } },
      stopConditions: [],
    });
    createHandoffItem(store, {
      id: handoffId,
      repoId: repository.repoId,
      workId,
      title: 'Bounded continuation blocker',
      severity: 'needs_review',
      creationReason: 'ambiguous_outcome',
      reason: 'A bounded decision blocks continuation.',
      summary: 'Resume the exact Work after this Handoff resolves.',
      currentState: { repoId: repository.repoId, workId, statusSummary: 'waiting for bounded resolution' },
      attemptedActions: [],
      evidenceRefs: [],
      recommendedDecision: 'Resolve the bounded blocker.',
      recommendedPrompt: 'Resolve the bounded blocker and resume the exact Work.',
      suggestedNextActions: [],
    });

    const resolved = await resolveHandoffAndTriggerContinuation(controllerHome, repository.repoId, handoffId, {
      decision: 'resolved for regression coverage',
      resolver: 'test-controller',
    });

    expect(resolved.item.status).toBe('resolved');
    expect(resolved.continuationOccurrences).toHaveLength(1);
    const scheduleId = resolved.continuationOccurrences[0]?.scheduleId;
    expect(scheduleId).toBe(schedule.scheduleId);
    expect(resolved.continuationOccurrences[0]?.status).toBe('shadowed');
    expect(scheduleId).not.toBe(decoy.scheduleId);
    const exactSchedules = listWorkContinuationSchedules(controllerHome, repository.repoId, { workId }).schedules
      .filter((candidate) => candidate.trigger.type === 'repository-event' && candidate.trigger.eventName === eventName);
    expect(exactSchedules).toHaveLength(1);
    expect(exactSchedules[0]?.scheduleId).toBe(scheduleId);
    const occurrences = listOccurrences(controllerHome, repository.repoId, scheduleId!);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.triggerContext).toMatchObject({ source: 'repository-event', eventName });
    expect(listOccurrences(controllerHome, repository.repoId, decoy.scheduleId)).toHaveLength(0);
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
  test('accepts only one newly-created live matching session after an unknown outcome', () => {
    const before = { sessions: [
      { sessionId: 'existing-match', url: 'https://chatgpt.com/c/exact', liveness: 'live' },
      { sessionId: 'existing-other', url: 'https://chatgpt.com/c/other', liveness: 'live' },
    ] };
    expect(reconciledNewChatgptOpenPageSessionId(before, { sessions: [
      ...before.sessions,
      { sessionId: 'new-match', url: 'https://chatgpt.com/c/exact', liveness: 'live' },
    ] }, 'https://chatgpt.com/c/exact')).toBe('new-match');
    expect(reconciledNewChatgptOpenPageSessionId(before, before, 'https://chatgpt.com/c/exact')).toBeUndefined();
  });

  test('fails closed for ambiguous, unverified, mismatched, or truncated inventory deltas', () => {
    const before = { sessions: [] };
    expect(reconciledNewChatgptOpenPageSessionId(before, { sessions: [
      { sessionId: 'new-a', url: 'https://chatgpt.com/c/exact', liveness: 'live' },
      { sessionId: 'new-b', url: 'https://chatgpt.com/c/exact', liveness: 'live' },
    ] }, 'https://chatgpt.com/c/exact')).toBeUndefined();
    expect(reconciledNewChatgptOpenPageSessionId(before, { sessions: [
      { sessionId: 'new-a', url: 'https://chatgpt.com/c/exact', liveness: 'unverified' },
    ] }, 'https://chatgpt.com/c/exact')).toBeUndefined();
    expect(reconciledNewChatgptOpenPageSessionId(before, { sessions: [
      { sessionId: 'new-a', url: 'https://chatgpt.com/c/other', liveness: 'live' },
    ] }, 'https://chatgpt.com/c/exact')).toBeUndefined();
    expect(reconciledNewChatgptOpenPageSessionId({ ...before, nextCursor: 'more' }, { sessions: [
      { sessionId: 'new-a', url: 'https://chatgpt.com/c/exact', liveness: 'live' },
    ] }, 'https://chatgpt.com/c/exact')).toBeUndefined();
    expect(reconciledNewChatgptOpenPageSessionId(before, { sessions: [
      { sessionId: 'new-root', url: 'https://chatgpt.com/c/not-root', liveness: 'live' },
    ] }, 'https://chatgpt.com/')).toBeUndefined();
  });

  test('lets Browser create replacement identity and reconciles unknown mutation by inventory delta only', () => {
    const source = readFileSync(join(process.cwd(), 'adapters/chatgpt/browser-delivery-runtime.ts'), 'utf8');
    const replacementStart = source.indexOf('const openReplacement = async');
    const replacementEnd = source.indexOf('\n  try {\n    // Prove the exact saved Browser resource is still attachable before dispatching', replacementStart);
    const replacementSource = source.slice(replacementStart, replacementEnd);
    expect(replacementSource).toContain("controllerBrowserAction(controllerHome, workId, 'open_page'");
    expect(replacementSource).not.toContain('session_id:');
    expect(replacementSource.match(/'list_sessions'/g)?.length).toBe(2);
    expect(replacementSource.match(/limit: 200/g)?.length).toBe(2);
    expect(replacementSource).toContain("browserMutationOutcomeUnknown(error, 'open_page')");
    expect(replacementSource).toContain('reconciledNewChatgptOpenPageSessionId(beforeInventory, afterInventory, url)');
  });
});

describe('ChatGPT native background-tab recovery', () => {
  test('native Browser delivery recovery creates a replacement page when navigation identity is stale', () => {
    const browserRuntime = readFileSync(join(process.cwd(), 'adapters/chatgpt/browser-delivery-runtime.ts'), 'utf8');
    const launcher = readFileSync(join(process.cwd(), 'src/runtime/control-plane/launcher/chatgpt-work-continuation.ts'), 'utf8');
    expect(browserRuntime).toContain('BROWSER_AUTOMATION_BACKGROUND_NAVIGATION_REQUIRES_REPLACEMENT');
    expect(browserRuntime).toContain('PLUGIN_BROWSER_NATIVE_TAB_IDENTITY_UNPROVEN');
    expect(browserRuntime).toContain("controllerBrowserAction(controllerHome, workId, 'open_page'");
    expect(browserRuntime).toContain("controllerBrowserAction(controllerHome, workId, 'verify_state'");
    expect(browserRuntime).toContain('discovering staleness only after mutation creates an avoidable outcome-unknown window');
    expect(launcher).toContain('delivery.browserSessionId');
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
      identity: { controllerId: 'launcher', controllerType: 'chatgpt', principalId: 'launcher', controllerInstanceId: 'runtime-test', sessionId: 'launch-1' },
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
        controllerType: firstSession.controllerType,
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
        controllerType: secondSession.controllerType,
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
        controllerType: secondSession.controllerType,
        principalId: secondSession.principalId ?? secondSession.controllerId,
        controllerInstanceId: secondSession.controllerInstanceId ?? 'runtime-test',
        sessionId: secondSession.sessionId,
      },
      disposition: 'continue_immediately',
    });
    expect(continued).toMatchObject({ status: 'pending_release', repeatedStateCount: 1 });
  });
});


describe('provider dispatch outcome-unknown fence', () => {
  function outcomeUnknownFixture() {
    const root = mkdtempSync(join(tmpdir(), 'forge-controller-relay-provider-unknown-'));
    roots.push(root);
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome);
    mkdirSync(repoRoot, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'relay@example.test'], ['config', 'user.name', 'Relay Test']] as string[][]) {
      execFileSync('git', args, { cwd: repoRoot });
    }
    writeFileSync(join(repoRoot, 'README.md'), 'provider outcome unknown\n');
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'provider-outcome-unknown' });
    const store = { controllerHome, repoId: repository.repoId };
    const workId = 'WORK-PROVIDER-OUTCOME-UNKNOWN';
    createWorkContract(store, {
      workId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop',
      objective: 'Fence ambiguous provider dispatch.',
      acceptanceCriteria: ['Never replay a possibly committed provider prompt automatically.'],
      allowedPaths: ['**/*'],
      forbiddenPaths: [],
      checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });
    return { store, workId };
  }

  test('persists provider dispatch outcome_unknown as a non-replayable ControllerRound fence', () => {
    const { store, workId } = outcomeUnknownFixture();
    const relayScopeId = `goal:${workId}`;
    beginInitialControllerRoundDispatch(store, {
      workId,
      relayScopeId,
      identity: { controllerId: 'launcher', controllerType: 'chatgpt', principalId: 'launcher', controllerInstanceId: 'runtime-test', sessionId: 'launch-1' },
    });
    const fenced = finishControllerRoundRelayDispatch(store, {
      workId,
      ok: false,
      outcomeUnknown: true,
      error: 'CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN:https://chatgpt.com/c/target',
    });
    expect(fenced).toMatchObject({
      status: 'blocked',
      blockedReason: 'provider_dispatch_outcome_unknown',
      lastError: 'CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN:https://chatgpt.com/c/target',
    });
    expect(() => beginInitialControllerRoundDispatch(store, {
      workId,
      relayScopeId,
      identity: { controllerId: 'launcher', controllerType: 'chatgpt', principalId: 'launcher', controllerInstanceId: 'runtime-test', sessionId: 'launch-2' },
    })).toThrow('CONTROLLER_RELAY_PROVIDER_DISPATCH_OUTCOME_UNKNOWN');
    expect(claimStalledControllerRoundRelays(store, { nowMs: Date.now() + 60 * 60_000, graceMs: 60_000 })).toEqual([]);
    expect(getControllerRoundRelay(store, workId)).toMatchObject({ status: 'blocked', blockedReason: 'provider_dispatch_outcome_unknown' });
  });

  test('does not turn a known provider failure into the permanent outcome_unknown no-replay fence', () => {
    const { store, workId } = outcomeUnknownFixture();
    const relayScopeId = `goal:${workId}`;
    beginInitialControllerRoundDispatch(store, {
      workId,
      relayScopeId,
      identity: { controllerId: 'launcher', controllerType: 'chatgpt', principalId: 'launcher', controllerInstanceId: 'runtime-test', sessionId: 'launch-known-failure' },
    });
    expect(finishControllerRoundRelayDispatch(store, {
      workId,
      ok: false,
      error: 'CHATGPT_LOGIN_REQUIRED',
    })).toMatchObject({ status: 'failed', lastError: 'CHATGPT_LOGIN_REQUIRED' });
    const retry = beginInitialControllerRoundDispatch(store, {
      workId,
      relayScopeId,
      identity: { controllerId: 'launcher', controllerType: 'chatgpt', principalId: 'launcher', controllerInstanceId: 'runtime-test', sessionId: 'launch-after-known-failure' },
    });
    expect(retry).toMatchObject({ status: 'dispatching' });
    expect(retry).not.toHaveProperty('blockedReason');
  });

  test('keeps native prompt mutation ambiguity distinct from ordinary submission-not-confirmed failure', () => {
    const browserRuntime = readFileSync(join(process.cwd(), 'adapters/chatgpt/browser-delivery-runtime.ts'), 'utf8');
    const providerDelivery = readFileSync(join(process.cwd(), 'adapters/chatgpt/provider-delivery.ts'), 'utf8');
    const host = readFileSync(join(process.cwd(), 'adapters/chatgpt/controller-host.ts'), 'utf8');
    const scheduler = readFileSync(join(process.cwd(), 'packages/kernel/scheduler/application/continuation-service.ts'), 'utf8');
    expect(providerDelivery).toContain("CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN");
    expect(browserRuntime).toContain('submitOutcomeUnknown = true');
    expect(browserRuntime).toContain("'CHATGPT_AUTOMATION_SUBMISSION_NOT_CONFIRMED'");
    expect(host).toContain('CONTROLLER_HOST_PROVIDER_DISPATCH_OUTCOME_UNKNOWN');
    expect(scheduler).toContain('providerDispatchOutcomeUnknown');
    expect(scheduler).toContain('outcomeUnknown: providerDispatchOutcomeUnknown');
  });
});
