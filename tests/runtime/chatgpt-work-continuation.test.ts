import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
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
import { CHATGPT_AUTOMATION_MESSAGE_DELIVERY_TIMED_OUT, ChatgptProviderDeliveryError, classifyChatgptProviderFailure, type ChatgptProviderDeliveryHost } from '../../adapters/chatgpt/provider-delivery';
import { createChatgptBrowserDeliveryHost } from '../../adapters/chatgpt/browser-delivery-host';
import { chatgptAutomationDeliveryFailure, chatgptSubmissionAcceptanceObserved, chatgptSubmissionSettlementWaitBudget, ensureControllerChatgptBrowser } from '../../adapters/chatgpt/browser-delivery-runtime';
import { repositoryPluginConfigPath } from '../../src/runtime/plugins/config-store';
import { controllerPluginRepository } from '../../src/runtime/plugins/store';
import { createHandoffItem } from '../../src/runtime/control-plane/facade/handoff-inbox-store';
import { createWorkContract, recordWorkEvidenceState, updateWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { ensureForgeInstanceIdentity, executionPlacement } from '../../packages/kernel/identity/api/index';
import { bootstrapWslWindowsBridgeBrowser, chatgptBridgeTargetMatchesPage, findInstalledWslWindowsBridgeBrowser, isWslWindowsRuntime, observeWslWindowsBridgeBrowser, openWslWindowsBridgeTarget } from '../../src/cli/chatgpt-browser/bridge-provider';
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
  chatgptBrowserActionResult,
  isChatgptConversationUrl,
  reconciledNewChatgptOpenPageSessionId,
  resolveChatgptWorkBrowserSessionId,
  runStandaloneChatgptPrompt,
  runWorkChatgptContinuation,
  stableChatgptWorkBridgeSessionId,
  stableChatgptWorkBrowserSessionId,
  stableStandaloneChatgptBrowserSessionId,
  settleWorkChatgptAutomationTab,
} from '../../src/runtime/control-plane/launcher/chatgpt-work-continuation';
import { migrateChatgptAutomationSchedule } from '../../src/runtime/workflow/schedules/chatgpt-automation-migration';
import { chatgptAutomationModelFamilyMenuTrigger } from '../../adapters/chatgpt/browser-delivery-runtime';
import { classifyChatgptWakeFailure } from '../../src/runtime/workflow/schedules/engine';
import {
  createWorkContinuationSchedule,
  handoffResolvedContinuationEventName,
  listWorkContinuationSchedules,
  resolveHandoffAndTriggerContinuation,
} from '../../src/runtime/workflow/schedules/work-continuation';
import { createSchedule, listOccurrences } from '../../src/runtime/workflow/schedules/store';
import type { RepositorySchedule } from '../../src/runtime/workflow/schedules/types';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('ChatGPT Browser controller authority', () => {
  test('does not reconfigure an already-enabled controller-scoped Browser', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-chatgpt-controller-browser-enabled-'));
    roots.push(root);
    const controllerHome = join(root, 'controller');
    ensureControllerHome(controllerHome);
    const repository = controllerPluginRepository(controllerHome);
    const configPath = repositoryPluginConfigPath({ controllerHome, repoId: repository.repoId }, 'browser');
    mkdirSync(dirname(configPath), { recursive: true });
    const persisted = `${JSON.stringify({ schemaVersion: 2, enabled: true }, null, 2)}\n`;
    writeFileSync(configPath, persisted, 'utf8');

    await expect(ensureControllerChatgptBrowser(controllerHome, 'WORK-BROWSER-ENABLED')).resolves.toBeUndefined();
    expect(readFileSync(configPath, 'utf8')).toBe(persisted);
  });

  test('keeps disabled Browser enablement behind canonical configure authorization', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-chatgpt-controller-browser-disabled-'));
    roots.push(root);
    const controllerHome = join(root, 'controller');
    ensureControllerHome(controllerHome);
    const repository = controllerPluginRepository(controllerHome);
    const configPath = repositoryPluginConfigPath({ controllerHome, repoId: repository.repoId }, 'browser');
    mkdirSync(dirname(configPath), { recursive: true });
    const persisted = `${JSON.stringify({ schemaVersion: 2, enabled: false }, null, 2)}\n`;
    writeFileSync(configPath, persisted, 'utf8');

    await expect(ensureControllerChatgptBrowser(controllerHome, 'WORK-BROWSER-DISABLED')).rejects.toThrow('EXTERNAL_EFFECT_AUTHORIZATION_REQUIRED');
    expect(readFileSync(configPath, 'utf8')).toBe(persisted);
  });
});

describe('ChatGPT Browser action result contract', () => {
  test('unwraps the typed plugin envelope exactly once and rejects malformed envelopes', () => {
    const raw = { session: { sessionId: 'browser-session-1', url: 'https://chatgpt.com/' }, matched: true };
    expect(chatgptBrowserActionResult({ schemaVersion: 1, plugin: {}, action: {}, result: raw }, 'open_page')).toBe(raw);
    expect(() => chatgptBrowserActionResult({ schemaVersion: 1, plugin: {}, action: {} }, 'open_page')).toThrow('CHATGPT_BROWSER_ACTION_RESULT_INVALID:open_page');
    expect(() => chatgptBrowserActionResult({ result: [] }, 'list_sessions')).toThrow('CHATGPT_BROWSER_ACTION_RESULT_INVALID:list_sessions');
  });
});

describe('ChatGPT provider delivery classification', () => {
  test('preserves typed observed conversation identity across ambiguous browser submission confirmation', async () => {
    const host = createChatgptBrowserDeliveryHost({
      ensureBrowser: async () => undefined,
      navigate: async (_controllerHome, _workId, _browserSessionId, targetUrl) => ({
        submissionTargetUrl: targetUrl,
        recoveredFromStaleBinding: true,
        browserSessionId: 'browser-replacement-session',
      }),
      ensureExecutionPreference: async () => true,
      submitPrompt: async () => {
        throw new ChatgptProviderDeliveryError(
          'CHATGPT_AUTOMATION_SUBMISSION_NOT_CONFIRMED',
          'submission confirmation is ambiguous',
          { conversationUrl: 'https://chatgpt.com/c/typed-observed-conversation' },
        );
      },
    });
    const ambiguous = await host.dispatch({
      controllerHome: '/tmp/controller',
      repoId: 'repo-test',
      repoRoot: '/tmp/repo',
      workId: 'WORK-TYPED-CONVERSATION',
      prompt: 'continue',
      browserSessionId: 'browser-typed-conversation',
      targetUrl: 'https://chatgpt.com/',
      model: 'gpt-5.6',
      reasoning: 'high',
    });
    expect(ambiguous).toMatchObject({
      status: 'outcome_unknown',
      browserSessionId: 'browser-replacement-session',
      conversationUrl: 'https://chatgpt.com/c/typed-observed-conversation',
      error: { code: 'CHATGPT_AUTOMATION_SUBMISSION_NOT_CONFIRMED' },
    });

    const failedHost = createChatgptBrowserDeliveryHost({
      ensureBrowser: async () => undefined,
      navigate: async (_controllerHome, _workId, browserSessionId, targetUrl) => ({
        submissionTargetUrl: targetUrl,
        recoveredFromStaleBinding: false,
        browserSessionId,
      }),
      ensureExecutionPreference: async () => true,
      submitPrompt: async () => { throw new Error('CHATGPT_BRIDGE_DISPATCH_FAILED:known failure'); },
    });
    const failed = await failedHost.dispatch({
      controllerHome: '/tmp/controller',
      repoId: 'repo-test',
      repoRoot: '/tmp/repo',
      workId: 'WORK-KNOWN-FAILURE',
      prompt: 'continue',
      browserSessionId: 'browser-known-failure',
      targetUrl: 'https://chatgpt.com/',
      model: 'gpt-5.6',
      reasoning: 'high',
    });
    expect(failed).toMatchObject({ status: 'failed', conversationUrl: 'https://chatgpt.com/' });

    const preNavigationFailedHost = createChatgptBrowserDeliveryHost({
      ensureBrowser: async () => undefined,
      navigate: async () => { throw new Error('CHATGPT_CONTROLLER_BROWSER_FAILED:navigation failed'); },
      ensureExecutionPreference: async () => true,
      submitPrompt: async () => 'https://chatgpt.com/c/never-reached',
    });
    const preNavigationFailed = await preNavigationFailedHost.dispatch({
      controllerHome: '/tmp/controller',
      repoId: 'repo-test',
      repoRoot: '/tmp/repo',
      workId: 'WORK-PRE-NAVIGATION-FAILURE',
      prompt: 'continue',
      browserSessionId: 'browser-original-session',
      targetUrl: 'https://chatgpt.com/',
      model: 'gpt-5.6',
      reasoning: 'high',
    });
    expect(preNavigationFailed).toMatchObject({ status: 'failed', browserSessionId: 'browser-original-session' });
  });

  test('separates ambiguous mutation, user blockers, and ordinary provider failure', () => {
    expect(classifyChatgptProviderFailure('CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN')).toBe('outcome_unknown');
    expect(classifyChatgptProviderFailure('CHATGPT_AUTOMATION_SUBMISSION_NOT_CONFIRMED')).toBe('outcome_unknown');
    expect(classifyChatgptProviderFailure('CHATGPT_AUTOMATION_LOGIN_REQUIRED')).toBe('wait_for_user');
    expect(classifyChatgptProviderFailure('CHATGPT_PERMISSION_REQUIRED')).toBe('wait_for_user');
    expect(classifyChatgptProviderFailure('CHATGPT_BRIDGE_DISPATCH_FAILED')).toBe('failed');
  });
});

describe('ChatGPT standalone provider routing', () => {
  test('uses the same WSL bridge provider abstraction as Work continuation and preserves typed delivery status', async () => {
    const calls: Array<{ provider: string; workId: string; prompt: string }> = [];
    const browserHost: ChatgptProviderDeliveryHost = {
      async dispatch() {
        throw new Error('browser host must not be selected for a WSL runtime');
      },
    };
    const wslHost: ChatgptProviderDeliveryHost = {
      async dispatch(input) {
        calls.push({ provider: 'chatgpt-bridge', workId: input.workId, prompt: input.prompt });
        return {
          status: 'dispatch_confirmed',
          provider: 'chatgpt-bridge',
          browserSessionId: input.browserSessionId,
          conversationUrl: 'https://chatgpt.com/c/provider-recovery-probe',
          executionPreferenceVerified: false,
        };
      },
    };
    const result = await runStandaloneChatgptPrompt({
      controllerHome: '/tmp/controller',
      repoId: 'repo-provider-recovery',
      repoRoot: '/tmp/repo',
      scopeId: 'provider-recovery',
      prompt: 'provider health probe only',
      tabPolicy: 'new',
    }, { bridgeRuntime: true, browserHost, wslHost });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: 'chatgpt-bridge', workId: 'standalone:provider-recovery', prompt: 'provider health probe only' });
    expect(result).toMatchObject({
      status: 'dispatched',
      provider: 'chatgpt-bridge',
      providerDeliveryStatus: 'dispatch_confirmed',
      conversationUrl: 'https://chatgpt.com/c/provider-recovery-probe',
    });
  });

  test('keeps non-confirmed provider dispositions typed instead of upgrading them to recovery success', async () => {
    const wslHost: ChatgptProviderDeliveryHost = {
      async dispatch(input) {
        return {
          status: 'wait_for_user',
          provider: 'chatgpt-bridge',
          browserSessionId: input.browserSessionId,
          conversationUrl: input.targetUrl,
          executionPreferenceVerified: false,
          error: { code: 'CHATGPT_AUTH_REQUIRED', message: 'login required' },
        };
      },
    };
    const result = await runStandaloneChatgptPrompt({
      controllerHome: '/tmp/controller',
      repoId: 'repo-provider-recovery',
      scopeId: 'provider-recovery-auth',
      prompt: 'provider health probe only',
    }, { bridgeRuntime: true, wslHost });
    expect(result).toMatchObject({
      status: 'failed',
      provider: 'chatgpt-bridge',
      providerDeliveryStatus: 'wait_for_user',
      error: { code: 'CHATGPT_AUTH_REQUIRED' },
    });
  });
});

describe('ChatGPT Work conversation binding', () => {
  test('ChatGPT round prompt keeps other-host Skill wording non-gating without weakening repository constraints', () => {
    const source = readFileSync(join(process.cwd(), 'adapters/chatgpt/controller-round-host.ts'), 'utf8');
    expect(source).toContain('仓库中的工程、验收、安全和权限约束始终有效');
    expect(source).toContain('其他 Controller host/runtime');
    expect(source).toContain('不是 ChatGPT 当前 round 的硬 capability gate');
    expect(source).toContain('不得仅为了满足该 host wording 而 delegate');
  });

  test('keeps ChatGPT automation Browser action envelopes compatible with persisted transport policy', () => {
    expect(chatgptBrowserActionArgs('open_page', { session_id: 'session-a', url: 'https://chatgpt.com/' })).toEqual({
      session_id: 'session-a', url: 'https://chatgpt.com/',
    });
    expect(chatgptBrowserActionArgs('get_text', { session_id: 'session-a' })).toEqual({ session_id: 'session-a' });
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
      authorizationGrantRefs: ['plugin-grant-browser-session', 'plugin-grant-browser-interaction', 'plugin-grant-browser-session'],
      localAlias: 'Forge · YaoZhunShi · Medication V2',
    });
    expect(first.conversationId).toBe('conversation-1');
    expect(getChatgptWorkConversationBinding(options, 'WORK-1')).toMatchObject({
      latestBrowserSessionId: 'chgpt_20260812_120000_first',
      authorizationGrantRefs: ['plugin-grant-browser-session', 'plugin-grant-browser-interaction'],
    });
    const continued = bindChatgptWorkConversation(options, {
      workId: 'WORK-1',
      conversationUrl: 'https://www.chatgpt.com/c/conversation-1?model=current',
      latestBrowserSessionId: 'chgpt_20260812_130000_followup',
    });
    expect(continued.conversationId).toBe('conversation-1');
    expect(continued.latestBrowserSessionId).toBe('chgpt_20260812_130000_followup');
    expect(continued.authorizationGrantRefs).toEqual(['plugin-grant-browser-session', 'plugin-grant-browser-interaction']);
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

  test('renders a language-independent textarea composer selector for localized ChatGPT Web', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-chatgpt-localized-composer-'));
    roots.push(root);
    const extension = writeChatgptBridgeExtension(root, 'http://127.0.0.1:17651', 'fixture-token');
    const source = readFileSync(extension.contentScriptPath, 'utf8');
    expect(source).toContain('textarea[name=\"prompt\"]');
    expect(source).toContain('textarea[placeholder*=\"Message\"]');
  });

  test('discovers only an enabled Windows Chromium profile whose installed Forge bridge matches the current capability', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-wsl-bridge-discovery-'));
    roots.push(root);
    const userRoot = join(root, 'user');
    const executable = join(root, 'CentBrowser', 'chrome.exe');
    const profileRoot = join(userRoot, 'AppData', 'Local', 'CentBrowser', 'User Data', 'Default');
    const extensionDir = join(root, 'installed-bridge');
    mkdirSync(profileRoot, { recursive: true });
    mkdirSync(extensionDir, { recursive: true });
    mkdirSync(join(root, 'CentBrowser'), { recursive: true });
    writeFileSync(executable, '', 'utf8');
    const bridgeUrl = 'http://127.0.0.1:17651';
    const token = 'stage3b-capability-token';
    writeFileSync(join(extensionDir, 'content-script.js'), `const url=${JSON.stringify(bridgeUrl)}; const token=${JSON.stringify(token)};`, 'utf8');
    writeFileSync(join(profileRoot, 'Preferences'), JSON.stringify({
      extensions: { settings: { bridge: { state: 1, path: extensionDir } } },
    }), 'utf8');
    expect(findInstalledWslWindowsBridgeBrowser(bridgeUrl, token, {
      userName: 'fixture',
      userRoot,
      candidates: [{ executable, profileRelativeRoot: 'AppData/Local/CentBrowser/User Data' }],
    })).toEqual({ executable, profileDirectory: 'Default', extensionDir });
    expect(findInstalledWslWindowsBridgeBrowser(bridgeUrl, 'wrong-token', {
      userName: 'fixture',
      userRoot,
      candidates: [{ executable, profileRelativeRoot: 'AppData/Local/CentBrowser/User Data' }],
    })).toBeUndefined();
  });

  test('prefers an existing user browser profile and falls back to the dedicated controlled WSL bridge profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-wsl-controlled-bridge-discovery-'));
    roots.push(root);
    const programFiles = join(root, 'Program Files');
    const localAppData = join(root, 'Users', 'fixture', 'AppData', 'Local');
    const userProfile = join(root, 'Users', 'fixture');
    const executable = join(programFiles, 'CentBrowser', 'Application', 'chrome.exe');
    const controlledRoot = join(localAppData, 'Forge', 'ChatGPT Bridge', 'User Data');
    const ordinaryRoot = join(localAppData, 'CentBrowser', 'User Data');
    const controlledExtension = join(root, 'controlled-bridge');
    const ordinaryExtension = join(root, 'ordinary-bridge');
    const bridgeUrl = 'http://127.0.0.1:17651';
    const token = 'bridge-token';

    mkdirSync(join(controlledRoot, 'Default'), { recursive: true });
    mkdirSync(join(ordinaryRoot, 'Default'), { recursive: true });
    mkdirSync(controlledExtension, { recursive: true });
    mkdirSync(ordinaryExtension, { recursive: true });
    mkdirSync(join(programFiles, 'CentBrowser', 'Application'), { recursive: true });
    writeFileSync(executable, '', 'utf8');
    writeFileSync(join(controlledExtension, 'content-script.js'), `const url=${JSON.stringify(bridgeUrl)}; const token=${JSON.stringify(token)};`, 'utf8');
    writeFileSync(join(ordinaryExtension, 'content-script.js'), `const url=${JSON.stringify(bridgeUrl)}; const token=${JSON.stringify(token)};`, 'utf8');
    writeFileSync(join(controlledRoot, 'Default', 'Preferences'), JSON.stringify({
      extensions: { settings: { bridge: { state: 1, path: controlledExtension } } },
    }), 'utf8');
    writeFileSync(join(ordinaryRoot, 'Default', 'Preferences'), JSON.stringify({
      extensions: { settings: { bridge: { state: 1, path: ordinaryExtension } } },
    }), 'utf8');

    const hostEnvironment = {
      commandExecutable: join(root, 'Windows', 'System32', 'cmd.exe'),
      userProfileWindows: 'C:\\Users\\fixture',
      userProfile,
      localAppDataWindows: 'C:\\Users\\fixture\\AppData\\Local',
      localAppData,
      programFilesWindows: ['C:\\Program Files'],
      programFiles: [programFiles],
      driveMounts: { c: root },
    };

    expect(findInstalledWslWindowsBridgeBrowser(bridgeUrl, token, { hostEnvironment })).toEqual({
      executable,
      profileDirectory: 'Default',
      extensionDir: ordinaryExtension,
    });

    rmSync(ordinaryRoot, { recursive: true, force: true });
    expect(findInstalledWslWindowsBridgeBrowser(bridgeUrl, token, { hostEnvironment })).toEqual({
      executable,
      profileDirectory: 'Default',
      extensionDir: controlledExtension,
      userDataDir: controlledRoot,
      loadExtensionOnLaunch: true,
    });
  });

  test('opens WSL bridge targets with the exact discovered Chromium profile and fails closed otherwise', async () => {
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
      browserBinding: {
        executable: '/mnt/c/Program Files/CentBrowser/Application/chrome.exe',
        profileDirectory: 'Default',
        extensionDir: '/mnt/c/Users/tester/AppData/Local/ForgeDesktop/.ai/harness/chatgpt/bridge-extension',
      },
      launch,
    });
    expect(launches).toEqual([{
      executable: '/mnt/c/Program Files/CentBrowser/Application/chrome.exe',
      args: ['--profile-directory=Default', '--new-tab', 'https://chatgpt.com/c/round-1'],
    }]);
    await expect(openWslWindowsBridgeTarget('https://chatgpt.com/', {
      platform: 'linux',
      wslDistroName: 'UbuntuDev',
      chromeExecutables: ['/missing/chrome.exe'],
      fileExists: () => false,
      launch,
    })).rejects.toThrow('CHATGPT_BRIDGE_USER_ACTION_REQUIRED');
    await expect(openWslWindowsBridgeTarget('https://example.com/', {
      platform: 'linux',
      wslDistroName: 'UbuntuDev',
      fileExists: () => true,
      launch,
    })).rejects.toThrow('CHATGPT_BRIDGE_TARGET_INVALID');
  });

  test('classifies only extension-capable controlled Chromium as automatic WSL bridge bootstrap', () => {
    const controlled = observeWslWindowsBridgeBrowser('/unused', {
      platform: 'linux', wslDistroName: 'UbuntuDev', userName: 'tester', userRoot: '/mnt/c/Users/tester',
      candidates: [{ executable: '/cent/chrome.exe', profileRelativeRoot: 'AppData/Local/Forge/ChatGPT Bridge/User Data', controlled: true, supportsUnpackedExtensionLaunch: true }],
      fileExists: (path) => path === '/cent/chrome.exe',
    });
    expect(controlled).toMatchObject({ required: true, ready: false, automatic: true });

    const chromeOnly = observeWslWindowsBridgeBrowser('/unused', {
      platform: 'linux', wslDistroName: 'UbuntuDev', userName: 'tester', userRoot: '/mnt/c/Users/tester',
      candidates: [{ executable: '/chrome/chrome.exe', profileRelativeRoot: 'AppData/Local/Google/Chrome/User Data' }],
      fileExists: (path) => path === '/chrome/chrome.exe',
    });
    expect(chromeOnly).toMatchObject({ required: true, ready: false, automatic: false });
  });

  test('bootstraps WSL bridge into a dedicated Forge Chromium profile without touching the user profile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-wsl-controlled-bootstrap-'));
    roots.push(root);
    const launches: Array<{ executable: string; args: readonly string[] }> = [];
    const launch = ((executable: string, args: readonly string[]) => {
      launches.push({ executable, args });
      const child: any = {
        once(event: string, listener: (value?: any) => void) { if (event === 'spawn') queueMicrotask(() => listener()); return child; },
        unref() { return child; },
      };
      return child;
    }) as typeof import('child_process').spawn;
    const controlledRoot = join(root, 'Forge', 'ChatGPT Bridge');
    const binding = await bootstrapWslWindowsBridgeBrowser(root, {
      platform: 'linux', wslDistroName: 'UbuntuDev', userName: 'tester', userRoot: root, controlledRoot,
      candidates: [{ executable: '/cent/chrome.exe', profileRelativeRoot: 'ignored', controlled: true, supportsUnpackedExtensionLaunch: true }],
      fileExists: (path) => path === '/cent/chrome.exe',
      launch, bridgeToken: () => 'stage4-test-bridge-token',
      toWindowsPath: (path) => `C:\\ForgeTest\\${path.split('/').filter(Boolean).at(-1)}`,
    });
    expect(binding).toMatchObject({ executable: '/cent/chrome.exe', profileDirectory: 'Default', userDataDir: join(controlledRoot, 'User Data'), loadExtensionOnLaunch: true });
    expect(binding.extensionDir.startsWith(controlledRoot)).toBe(true);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.args).toEqual([
      '--user-data-dir=C:\\ForgeTest\\User Data',
      expect.stringContaining('--load-extension=C:\\ForgeTest\\bridge-extension'),
      '--new-window',
      'https://chatgpt.com/',
    ]);
  });

  test('relaunches a controlled WSL bridge binding with its dedicated user-data and extension arguments', async () => {
    const launches: Array<{ executable: string; args: readonly string[] }> = [];
    const launch = ((executable: string, args: readonly string[]) => {
      launches.push({ executable, args });
      const child: any = {
        once(event: string, listener: (value?: any) => void) { if (event === 'spawn') queueMicrotask(() => listener()); return child; },
        unref() { return child; },
      };
      return child;
    }) as typeof import('child_process').spawn;
    await openWslWindowsBridgeTarget('https://chatgpt.com/c/controlled-round', {
      platform: 'linux', wslDistroName: 'UbuntuDev', launch,
      browserBinding: {
        executable: '/mnt/c/Program Files/CentBrowser/Application/chrome.exe',
        profileDirectory: 'Default',
        userDataDir: '/windows/d/Users/WindowsOwner/AppData/Local/Forge/ChatGPT Bridge/User Data',
        extensionDir: '/windows/d/Users/WindowsOwner/AppData/Local/Forge/ChatGPT Bridge/bridge-extension',
        loadExtensionOnLaunch: true,
      },
      toWindowsPath: (path) => path.replace('/windows/d/', 'D:\\').replaceAll('/', '\\'),
    });
    expect(launches[0]?.args).toEqual([
      '--user-data-dir=D:\\Users\\WindowsOwner\\AppData\\Local\\Forge\\ChatGPT Bridge\\User Data',
      '--load-extension=D:\\Users\\WindowsOwner\\AppData\\Local\\Forge\\ChatGPT Bridge\\bridge-extension',
      '--profile-directory=Default', '--new-tab', 'https://chatgpt.com/c/controlled-round',
    ]);
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

  test('recognizes version-agnostic ChatGPT model-family menu triggers without accepting unrelated GPT UI', () => {
    expect(chatgptAutomationModelFamilyMenuTrigger('GPT-6 Astra\n轻度', 'menu')).toBe(true);
    expect(chatgptAutomationModelFamilyMenuTrigger('GPT-5.6 Sol\nHigh', 'menu')).toBe(true);
    expect(chatgptAutomationModelFamilyMenuTrigger('GPT-6 Astra\n轻度', undefined)).toBe(false);
    expect(chatgptAutomationModelFamilyMenuTrigger('Try GPT-6', 'menu')).toBe(false);
    expect(chatgptAutomationModelFamilyMenuTrigger('GPT Store', 'menu')).toBe(false);
    expect(chatgptAutomationModelFamilyMenuTrigger('Project', 'menu')).toBe(false);
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

  test('requires provider acceptance beyond a local outbound ChatGPT echo and recognizes delivery timeout UI', () => {
    expect(chatgptSubmissionSettlementWaitBudget()).toBe(30_000);
    expect(chatgptSubmissionSettlementWaitBudget(8_000)).toBe(8_000);
    expect(chatgptSubmissionSettlementWaitBudget(60_000)).toBe(30_000);
    expect(chatgptSubmissionAcceptanceObserved({
      outboundConfirmed: true,
      hasConversationIdentity: true,
      assistantResponseObserved: false,
      generationInProgress: false,
    })).toBe(false);
    expect(chatgptSubmissionAcceptanceObserved({
      outboundConfirmed: true,
      hasConversationIdentity: true,
      assistantResponseObserved: true,
      generationInProgress: false,
    })).toBe(true);
    expect(chatgptSubmissionAcceptanceObserved({
      outboundConfirmed: true,
      hasConversationIdentity: true,
      assistantResponseObserved: false,
      generationInProgress: true,
    })).toBe(true);
    expect(chatgptAutomationDeliveryFailure('Message delivery timed out. Please try again.')).toBe(CHATGPT_AUTOMATION_MESSAGE_DELIVERY_TIMED_OUT);
    expect(chatgptAutomationDeliveryFailure('ChatGPT')).toBeUndefined();
    expect(classifyChatgptProviderFailure(CHATGPT_AUTOMATION_MESSAGE_DELIVERY_TIMED_OUT)).toBe('outcome_unknown');
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
    expect(chatgptOutboundMessageMatchesPrompt(`${prompt}\n收起`, prompt)).toBe(true);
    expect(chatgptOutboundMessageMatchesPrompt(`${prompt}\nCollapse`, prompt)).toBe(true);
    expect(chatgptOutboundMessageMatchesPrompt(`${prompt}\nShow less`, prompt)).toBe(true);
    expect(chatgptOutboundMessageMatchesPrompt(`${prompt}\nnot a known UI suffix`, prompt)).toBe(false);
    expect(chatgptOutboundMessageMatchesPrompt(`prefix ${prompt}`, prompt)).toBe(false);
    expect(chatgptOutboundMessageMatchesPrompt(`${prompt.slice(0, 160)} but wrong tail`, prompt)).toBe(false);
    expect(chatgptOutboundMessageMatchesPrompt('', prompt)).toBe(false);
    const largePrompt = `@forge ${'durable-controller-contract '.repeat(8_000)}`;
    const boundedPrefix = largePrompt.slice(0, 100_000);
    expect(chatgptOutboundMessageMatchesPrompt(boundedPrefix, largePrompt, { truncated: true })).toBe(true);
    expect(chatgptOutboundMessageMatchesPrompt(`${boundedPrefix.slice(0, -1)}X`, largePrompt, { truncated: true })).toBe(false);
    expect(chatgptOutboundMessageMatchesPrompt(largePrompt.slice(0, 200), largePrompt, { truncated: true })).toBe(false);
    expect(chatgptOutboundMessageMatchesPrompt(boundedPrefix, largePrompt)).toBe(false);
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
    expect(launcher).toContain('const bridgeRuntime = dependencies.bridgeRuntime ?? isWslWindowsRuntime()'); expect(launcher).toContain('CHATGPT_EXECUTION_PLACEMENT_MISMATCH'); expect(launcher).toContain('dependencies.wslHost ?? createChatgptWslBridgeDeliveryHost()'); expect(launcher).toContain('dependencies.browserHost ?? createChatgptBrowserDeliveryHost({');
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



  test('uses maximum reasoning for Work continuation without changing standalone defaults or explicit overrides', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-chatgpt-controller-reasoning-'));
    roots.push(root);
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome);
    mkdirSync(repoRoot, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'reasoning@example.test'], ['config', 'user.name', 'Reasoning Test']] as string[][]) execFileSync('git', args, { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'reasoning fixture\n');
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'chatgpt-controller-reasoning' });
    const store = { controllerHome, repoId: repository.repoId };
    const workInput = {
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop' as const,
      acceptanceCriteria: [], allowedPaths: ['**/*'], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current' as const, requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt' as const, status: 'running' as const,
    };
    createWorkContract(store, { ...workInput, workId: 'WORK-REASONING-DEFAULT', objective: 'Use maximum controller reasoning.' });
    createWorkContract(store, { ...workInput, workId: 'WORK-REASONING-OVERRIDE', objective: 'Honor explicit controller reasoning.' });

    const observed: Array<{ workId: string; reasoning: string }> = [];
    const browserHost: ChatgptProviderDeliveryHost = {
      dispatch: async (input) => {
        observed.push({ workId: input.workId, reasoning: input.reasoning });
        return {
          status: 'dispatch_confirmed' as const,
          provider: 'controller-browser' as const,
          browserSessionId: input.browserSessionId,
          conversationUrl: `https://chatgpt.com/c/reasoning-${observed.length}`,
          executionPreferenceVerified: true,
        };
      },
    };

    const controllerDefault = await runWorkChatgptContinuation({
      controllerHome, repoId: repository.repoId, repoRoot, workId: 'WORK-REASONING-DEFAULT', prompt: 'continue',
      controllerAuthorityId: 'cra_11111111111111111111111111111111', relayScopeId: 'goal:WORK-REASONING-DEFAULT',
    }, { bridgeRuntime: false, browserHost });
    const standaloneDefault = await runStandaloneChatgptPrompt({
      controllerHome, repoId: repository.repoId, repoRoot, scopeId: 'reasoning-standalone', prompt: 'probe',
    }, { bridgeRuntime: false, browserHost });
    const controllerOverride = await runWorkChatgptContinuation({
      controllerHome, repoId: repository.repoId, repoRoot, workId: 'WORK-REASONING-OVERRIDE', prompt: 'continue', reasoning: 'medium',
      controllerAuthorityId: 'cra_22222222222222222222222222222222', relayScopeId: 'goal:WORK-REASONING-OVERRIDE',
    }, { bridgeRuntime: false, browserHost });

    expect(controllerDefault.reasoning).toBe('xhigh');
    expect(standaloneDefault.reasoning).toBe('high');
    expect(controllerOverride.reasoning).toBe('medium');
    expect(observed.map(({ reasoning }) => reasoning)).toEqual(['xhigh', 'high', 'medium']);
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

  test('rejects a Work targeted at a different Forge instance before provider dispatch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-chatgpt-placement-mismatch-'));
    roots.push(root);
    const controllerHome = join(root, 'controller'), repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome);
    ensureForgeInstanceIdentity({ controllerHome, preferredInstanceId: 'forge-mac' });
    mkdirSync(repoRoot, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'placement@example.test'], ['config', 'user.name', 'Placement Test']] as string[][]) execFileSync('git', args, { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'placement fixture\n'); execFileSync('git', ['add', '.'], { cwd: repoRoot }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'chatgpt-placement-mismatch' });
    createWorkContract({ controllerHome, repoId: repository.repoId }, {
      workId: 'WORK-PLACEMENT-MISMATCH', repoId: repository.repoId,
      executionPlacement: executionPlacement({ forgeInstanceId: 'forge-wsl', repositoryId: repository.repoId }),
      mode: 'goal_workloop', objective: 'Stay on the WSL Forge instance.', acceptanceCriteria: [], allowedPaths: ['**/*'], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
    });
    let dispatches = 0;
    const result = await runWorkChatgptContinuation({
      controllerHome, repoId: repository.repoId, repoRoot, workId: 'WORK-PLACEMENT-MISMATCH', prompt: 'continue',
      controllerAuthorityId: 'cra_44444444444444444444444444444444', relayScopeId: 'goal:WORK-PLACEMENT-MISMATCH',
    }, { bridgeRuntime: false, browserHost: { dispatch: async () => { dispatches += 1; throw new Error('must not dispatch'); } } });
    expect(dispatches).toBe(0);
    expect(result).toMatchObject({ status: 'failed', error: { code: 'CHATGPT_EXECUTION_PLACEMENT_MISMATCH' } });
    expect(result.error?.message).toContain('target=forge-wsl current=forge-mac');
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

  test('persists observed conversation identity when provider delivery is outcome_unknown without upgrading dispatch success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-chatgpt-outcome-unknown-binding-'));
    roots.push(root);
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome);
    mkdirSync(repoRoot, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'binding@example.test'], ['config', 'user.name', 'Binding Test']] as string[][]) {
      execFileSync('git', args, { cwd: repoRoot });
    }
    writeFileSync(join(repoRoot, 'README.md'), 'binding fixture\n');
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'chatgpt-outcome-unknown-binding' });
    const store = { controllerHome, repoId: repository.repoId };
    const workInput = {
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop' as const,
      acceptanceCriteria: ['Keep provider outcome separate from conversation resource identity.'],
      allowedPaths: ['**/*'],
      forbiddenPaths: [],
      checks: [],
      constraints: { workspaceMode: 'current' as const, requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt' as const,
      status: 'running' as const,
    };
    createWorkContract(store, { ...workInput, workId: 'WORK-OUTCOME-UNKNOWN-BINDING', objective: 'Persist observed ChatGPT conversation identity.' });
    createWorkContract(store, { ...workInput, workId: 'WORK-FAILED-NO-BINDING', objective: 'Do not invent a ChatGPT conversation identity.' });
    createWorkContract(store, { ...workInput, workId: 'WORK-FAILED-VALID-CONVERSATION', objective: 'Do not persist a valid conversation URL from a known provider failure.' });

    const outcomeUnknown = await runWorkChatgptContinuation({
      controllerHome,
      repoId: repository.repoId,
      repoRoot,
      workId: 'WORK-OUTCOME-UNKNOWN-BINDING',
      prompt: 'continue',
      controllerAuthorityId: 'cra_11111111111111111111111111111111',
      relayScopeId: 'goal:WORK-OUTCOME-UNKNOWN-BINDING',
    }, {
      bridgeRuntime: false,
      browserHost: {
        dispatch: async () => ({
          status: 'outcome_unknown' as const,
          provider: 'controller-browser' as const,
          browserSessionId: 'browser-outcome-unknown',
          conversationUrl: 'https://chatgpt.com/c/outcome-unknown-binding',
          executionPreferenceVerified: true,
          error: { code: 'CHATGPT_AUTOMATION_SUBMISSION_NOT_CONFIRMED', message: 'submission confirmation is ambiguous' },
        }),
      },
    });
    expect(outcomeUnknown).toMatchObject({
      status: 'failed',
      providerDeliveryStatus: 'outcome_unknown',
      conversationId: 'outcome-unknown-binding',
      conversationUrl: 'https://chatgpt.com/c/outcome-unknown-binding',
    });
    expect(getChatgptWorkConversationBinding(store, 'WORK-OUTCOME-UNKNOWN-BINDING')).toMatchObject({
      conversationId: 'outcome-unknown-binding',
      conversationUrl: 'https://chatgpt.com/c/outcome-unknown-binding',
      latestBrowserSessionId: 'browser-outcome-unknown',
    });

    const ordinaryFailure = await runWorkChatgptContinuation({
      controllerHome,
      repoId: repository.repoId,
      repoRoot,
      workId: 'WORK-FAILED-NO-BINDING',
      prompt: 'continue',
      controllerAuthorityId: 'cra_22222222222222222222222222222222',
      relayScopeId: 'goal:WORK-FAILED-NO-BINDING',
    }, {
      bridgeRuntime: false,
      browserHost: {
        dispatch: async () => ({
          status: 'failed' as const,
          provider: 'controller-browser' as const,
          browserSessionId: 'browser-failed',
          conversationUrl: 'https://chatgpt.com/',
          executionPreferenceVerified: false,
          error: { code: 'CHATGPT_BRIDGE_DISPATCH_FAILED', message: 'known provider failure' },
        }),
      },
    });
    expect(ordinaryFailure).toMatchObject({ status: 'failed', providerDeliveryStatus: 'failed' });
    expect(getChatgptWorkConversationBinding(store, 'WORK-FAILED-NO-BINDING')).toBeUndefined();

    const knownFailureWithConversation = await runWorkChatgptContinuation({
      controllerHome,
      repoId: repository.repoId,
      repoRoot,
      workId: 'WORK-FAILED-VALID-CONVERSATION',
      prompt: 'continue',
      controllerAuthorityId: 'cra_33333333333333333333333333333333',
      relayScopeId: 'goal:WORK-FAILED-VALID-CONVERSATION',
    }, {
      bridgeRuntime: false,
      browserHost: {
        dispatch: async () => ({
          status: 'failed' as const,
          provider: 'controller-browser' as const,
          browserSessionId: 'browser-failed-valid-conversation',
          conversationUrl: 'https://chatgpt.com/c/known-failure-conversation',
          executionPreferenceVerified: false,
          error: { code: 'CHATGPT_BRIDGE_DISPATCH_FAILED', message: 'known provider failure with an observed page' },
        }),
      },
    });
    expect(knownFailureWithConversation).toMatchObject({ status: 'failed', providerDeliveryStatus: 'failed' });
    expect(getChatgptWorkConversationBinding(store, 'WORK-FAILED-VALID-CONVERSATION')).toBeUndefined();
  });

  test('fresh transport starts from ChatGPT root and CAS-rebinds the durable Work to the newly observed conversation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-chatgpt-fresh-transport-'));
    roots.push(root);
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome);
    mkdirSync(repoRoot, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'fresh@example.test'], ['config', 'user.name', 'Fresh Transport Test']] as string[][]) execFileSync('git', args, { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'fresh transport fixture\n');
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'chatgpt-fresh-transport' });
    const store = { controllerHome, repoId: repository.repoId };
    createWorkContract(store, {
      workId: 'WORK-FRESH-TRANSPORT', repoId: repository.repoId, checkoutId: repository.activeCheckoutId, mode: 'goal_workloop',
      objective: 'Isolate ControllerRound transport conversations.', acceptanceCriteria: ['Use a fresh transport conversation without changing Work authority.'],
      allowedPaths: ['**/*'], forbiddenPaths: [], checks: [], constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt', status: 'running',
    });
    bindChatgptWorkConversation(store, {
      workId: 'WORK-FRESH-TRANSPORT', conversationUrl: 'https://chatgpt.com/c/old-transport', latestBrowserSessionId: 'browser-old-transport', localAlias: 'Forge fresh transport',
    });
    let targetUrl = '';
    let dispatchedSessionId = '';
    const result = await runWorkChatgptContinuation({
      controllerHome, repoId: repository.repoId, repoRoot, workId: 'WORK-FRESH-TRANSPORT', prompt: 'continue in a fresh transport',
      controllerAuthorityId: 'cra_44444444444444444444444444444444', relayScopeId: 'goal:WORK-FRESH-TRANSPORT',
      browserSessionId: 'browser-old-transport', conversationUrl: 'https://chatgpt.com/c/old-transport', tabPolicy: 'reuse', transportConversation: 'fresh',
    }, {
      bridgeRuntime: false,
      browserHost: { dispatch: async (input) => {
        targetUrl = input.targetUrl; dispatchedSessionId = input.browserSessionId;
        return {
          status: 'outcome_unknown' as const, provider: 'controller-browser' as const, browserSessionId: input.browserSessionId,
          conversationUrl: 'https://chatgpt.com/c/new-transport', executionPreferenceVerified: true,
          error: { code: 'CHATGPT_AUTOMATION_SUBMISSION_NOT_CONFIRMED', message: 'fresh transport submission confirmation is ambiguous' },
        };
      } },
    });
    expect(targetUrl).toBe('https://chatgpt.com/');
    expect(dispatchedSessionId).not.toBe('browser-old-transport');
    expect(result).toMatchObject({
      status: 'failed', providerDeliveryStatus: 'outcome_unknown', conversationId: 'new-transport',
      conversationUrl: 'https://chatgpt.com/c/new-transport', tabPolicy: 'new',
    });
    expect(getChatgptWorkConversationBinding(store, 'WORK-FRESH-TRANSPORT')).toMatchObject({
      conversationId: 'new-transport', conversationUrl: 'https://chatgpt.com/c/new-transport', latestBrowserSessionId: dispatchedSessionId, localAlias: 'Forge fresh transport',
    });
  });

  test('keeps automation in Chat mode, prefixes @forge, and submits from the stable prompt editor', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/control-plane/launcher/chatgpt-work-continuation.ts'), 'utf8');
    const browserRuntime = readFileSync(join(process.cwd(), 'adapters/chatgpt/browser-delivery-runtime.ts'), 'utf8');
    const providerDelivery = readFileSync(join(process.cwd(), 'adapters/chatgpt/provider-delivery.ts'), 'utf8');
    expect(browserRuntime).toContain("CHATGPT_PROMPT_SELECTOR = 'div#prompt-textarea[contenteditable=\"true\"]'"); expect(browserRuntime).toContain("CHATGPT_SEND_SELECTOR = '[data-testid=\"send-button\"], button[aria-label*=\"Send\"], button[data-testid*=\"send\"]'");
    expect(providerDelivery).toContain("DEFAULT_CHATGPT_AUTOMATION_MODEL = 'gpt-5.6'");
    expect(providerDelivery).toContain("DEFAULT_CHATGPT_AUTOMATION_REASONING = 'high'");
    expect(source).toContain("DEFAULT_CHATGPT_AUTOMATION_PLUGIN_MENTION = '@forge'"); expect(browserRuntime).not.toContain('CHATGPT_WORK_MODE_RADIO_SELECTOR');
    expect(browserRuntime).toContain('new AsyncLocalStorage<ChatgptBrowserActionContext>()');
    expect(browserRuntime).toContain("surface: 'schedule', actor: 'chatgpt-work-continuation'");
    expect(browserRuntime).toContain("origin.surface === 'chatgpt-action' && CHATGPT_BROWSER_AUTHORIZATION_ACTIONS.has(actionId)");
    expect(browserRuntime).toContain(".filter((action) => !action.readOnly && action.confirmation === 'authorization')");
    expect(browserRuntime).toContain('submitAssistantPluginAction(');
    expect(browserRuntime).toContain('controllerPluginRepository(controllerHome)');
    expect(browserRuntime).toContain('authorizationGrantRefs: [...(context?.authorizationGrantRefs ?? [])]');
    expect(source).toContain("originSurface?: 'chatgpt-action' | 'schedule'");
    expect(source).toContain('authorizationGrantRefs?: readonly string[]');
    expect(source).toContain("surface: input.originSurface ?? 'chatgpt-action'");
    const controllerHost = readFileSync(join(process.cwd(), 'adapters/chatgpt/controller-host.ts'), 'utf8');
    const workBinding = readFileSync(join(process.cwd(), 'adapters/chatgpt/work-conversation-binding-store.ts'), 'utf8');
    expect(controllerHost).toContain("originSurface: 'schedule'");
    expect(workBinding).toContain('authorizationGrantRefs?: string[]');
    expect(workBinding).toContain('input.authorizationGrantRefs ?? existing?.value.authorizationGrantRefs ?? []');
    expect(source).toContain('从成功的 controller_claim 响应中取得 data.controllerAuthorityId');
    expect(source).toContain('本次启动的 controller round 已具备 durable controller authority：controller_authority_id=');
    expect(source).toContain('第一次 controller_claim 必须使用这组完全相同的 authority');
    expect(source).toContain('不得先调用不带 scope 的 controller_claim');
    expect(source).toContain('capability_id=controller.round:controller_claim:');
    expect(source).toContain('把同一个 opaque value 作为 session_id compatibility carrier');
    expect(source).toContain('绝不能把 data.session.sessionId 当作 durable capability');
    expect(browserRuntime).toContain('CHATGPT_CAPABILITY_MENUITEM_SELECTOR');
    expect(browserRuntime).toContain('aria-keyshortcuts~=\"ArrowRight\"');
    expect(browserRuntime).not.toContain(':has-text(');
    expect(browserRuntime).toContain('waitForChatgptIntelligenceControl'); expect(browserRuntime).toContain('reasoningLabelMatches'); expect(browserRuntime).toContain("'main button, main [role=\"button\"]'"); expect(browserRuntime).toContain('limit: chatgptAutomationControlQueryLimit(selector)'); expect(browserRuntime).toContain('chatgptAutomationReasoningLevelFromLabel'); expect(browserRuntime).toContain('CHATGPT_AUTOMATION_LOGIN_REQUIRED'); expect(source).not.toContain('runScheduledChatgptPrompt'); const engine = readFileSync(join(process.cwd(), 'src/runtime/workflow/schedules/engine.ts'), 'utf8'); expect(engine).toContain('resumeControllerRoundOccurrence'); expect(engine).toContain('controllerHostForScheduledBinding'); expect(engine).toContain('SCHEDULE_CONTINUATION_CONTROLLER_SESSION_REQUIRED'); expect(engine).not.toContain('runWorkChatgptContinuation'); expect(source).toContain('conversationUrl?: string'); expect(source).toContain("binding?.conversationUrl ?? seedUrl ?? 'https://chatgpt.com/'");
    expect(source).toContain('seedUrl && !binding && hasChatgptConversationIdentity(seedUrl)');
    expect(browserRuntime).toContain('CHATGPT_AUTOMATION_SUBMISSION_NOT_CONFIRMED'); expect(source).toContain('workflowToolAttributionInstruction'); expect(source).toContain('repository_command_execute 和 repository_safe_patch_apply');
    expect(source).toContain("relayScopeId?.startsWith('requirement:') === true");
    expect(source).toContain('实际被本轮语义选择且已成功 claim 的 repository-change Work 的 work_id');
    expect(source).toContain('不得把只读/编排 Supervisor Work 的 work_id 用来归属 child Work 的源码修改');
    expect(source).toContain('本轮每一次 repository_command_execute 和 repository_safe_patch_apply 都必须显式传 work_id=${workId}');
    const maintenance = readFileSync(join(process.cwd(), 'src/runtime/control-plane/global-scheduler/maintenance.ts'), 'utf8');
    expect(maintenance).toContain('exactOriginWork: !dispatchingRecord.requirementId');
    expect(browserRuntime).toContain('CHATGPT_USER_MESSAGE_SELECTOR'); expect(browserRuntime).toContain("from_end: true"); expect(browserRuntime).toContain("browserMutationOutcomeUnknown(error, 'click')"); expect(browserRuntime).toContain('chatgptOutboundMessageMatchesPrompt(fullText.text, renderedPrompt, { truncated: fullText.truncated })');
    expect(browserRuntime).toContain("controllerBrowserAction(controllerHome, workId, 'close_page'");
    expect(source).toContain('closeChatgptAutomationTabAfterDispatch');
    expect(browserRuntime).toContain('settleWorkChatgptAutomationTab');
    const workContinuation = source.slice(source.indexOf('export async function runWorkChatgptContinuation'));
    expect(workContinuation).not.toContain('closeChatgptAutomationTabAfterDispatch(');
    expect(workContinuation).not.toContain('tabCleanupStatus: tabCleanup.status');
    expect(browserRuntime).toContain("'PLUGIN_BROWSER_SESSION_STATE_LOST'");
    expect(browserRuntime).toContain("'PLUGIN_SESSION_NOT_FOUND'");
    expect(source).toContain('runStandaloneChatgptPrompt');
    const standaloneStart = source.indexOf('export async function runStandaloneChatgptPrompt');
    const workStart = source.indexOf('export async function runWorkChatgptContinuation');
    const standaloneSource = source.slice(standaloneStart, workStart);
    expect(standaloneSource).not.toContain('getWorkContract(');
    expect(standaloneSource).not.toContain('bindChatgptWorkConversation(');
    expect(engine).toContain('runStandaloneChatgptPrompt');
    expect(engine).toContain('resumeControllerRoundOccurrence(');
    expect(engine).not.toContain('controllerAuthorityId: relay.authorityId');
    expect(engine).not.toContain('relayScopeId: relay.relayScopeId');
    expect(engine).toContain('Standalone browser keepalive auth-required prompt dispatched to ChatGPT.');
    const runtimeTools = readFileSync(join(process.cwd(), 'adapters/mcp/runtime-gateway/runtime-tools.ts'), 'utf8');
    const controllerOperations = readFileSync(join(process.cwd(), 'adapters/mcp/runtime-gateway/work-controller-operations.ts'), 'utf8');
    const launcherStartIndex = controllerOperations.indexOf("if (operation === 'launcher_start')");
    const launcherStart = controllerOperations.slice(launcherStartIndex);
    expect(launcherStart).toContain("if (controllerType === 'chatgpt')");
    expect(launcherStart).toContain('await runWorkChatgptContinuation({');
    expect(launcherStart).toContain('controllerAuthorityId: relay.authorityId');
    expect(launcherStart).toContain('relayScopeId: relay.relayScopeId');
    expect(launcherStart).toContain("summary: 'ChatGPT continuation dispatched;");
    expect(launcherStart).toContain("semantic closure still requires an explicit disposition.'");
    expect(launcherStart.indexOf('await runWorkChatgptContinuation({')).toBeLessThan(launcherStart.indexOf('const launched = await launchSuperController'));
    expect(launcherStart).toContain("controllerType: controllerType as 'codex' | 'grok' | 'claude'");
    const controllerReleaseStart = controllerOperations.indexOf("if (operation === 'controller_release')");
    const controllerRelease = controllerOperations.slice(controllerReleaseStart, launcherStartIndex);
    expect(controllerRelease).toContain('await runWorkChatgptContinuation({');
    expect(controllerRelease).toContain('controllerAuthorityId: relay.authorityId');
    expect(controllerRelease).toContain('relayScopeId: relay.relayScopeId');
    expect(controllerRelease).not.toContain('await runStandaloneChatgptPrompt({');
    expect(controllerRelease).toContain('settleWorkChatgptAutomationTab({');
    expect(controllerRelease).toContain("status: 'retained_for_immediate_continuation'");
    expect(controllerRelease).toContain("['waiting', 'waiting_for_user', 'goal_complete', 'blocked', 'failed']");
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

  test('creates replacement with the exact Browser session identity and verifies unknown mutation without sessionless selection', () => {
    const source = readFileSync(join(process.cwd(), 'adapters/chatgpt/browser-delivery-runtime.ts'), 'utf8');
    const replacementStart = source.indexOf('const openReplacement = async');
    const replacementEnd = source.indexOf('\n  try {\n    // Prove the exact saved Browser resource is still attachable before dispatching', replacementStart);
    const replacementSource = source.slice(replacementStart, replacementEnd);
    expect(replacementSource).toContain("controllerBrowserAction(controllerHome, workId, 'create_session'");
    expect(replacementSource).toContain('session_id: sessionId');
    expect(replacementSource).not.toContain("'list_sessions'");
    expect(replacementSource).toContain("browserMutationOutcomeUnknown(error, 'create_session')");
    expect(replacementSource).toContain("controllerBrowserAction(controllerHome, workId, 'verify_state'");
    expect(replacementSource).toContain('stringField(verified.sessionId) === sessionId');
  });
});

describe('ChatGPT native background-tab recovery', () => {
  test('native Browser delivery recovery creates a replacement page when navigation identity is stale', () => {
    const browserRuntime = readFileSync(join(process.cwd(), 'adapters/chatgpt/browser-delivery-runtime.ts'), 'utf8');
    const launcher = readFileSync(join(process.cwd(), 'src/runtime/control-plane/launcher/chatgpt-work-continuation.ts'), 'utf8');
    expect(browserRuntime).toContain('BROWSER_AUTOMATION_BACKGROUND_NAVIGATION_REQUIRES_REPLACEMENT');
    expect(browserRuntime).toContain('PLUGIN_BROWSER_NATIVE_TAB_IDENTITY_UNPROVEN');
    expect(browserRuntime).toContain("controllerBrowserAction(controllerHome, workId, 'create_session'");
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

    recordWorkEvidenceState(store, childWorkId, 'partial');
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

  test('keeps native prompt mutation ambiguity explicit while submission-not-confirmed remains separately observable', () => {
    const browserRuntime = readFileSync(join(process.cwd(), 'adapters/chatgpt/browser-delivery-runtime.ts'), 'utf8');
    const providerDelivery = readFileSync(join(process.cwd(), 'adapters/chatgpt/provider-delivery.ts'), 'utf8');
    const host = readFileSync(join(process.cwd(), 'adapters/chatgpt/controller-host.ts'), 'utf8');
    const continuation = readFileSync(join(process.cwd(), 'packages/kernel/controller/application/continuation-service.ts'), 'utf8');
    expect(providerDelivery).toContain("CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN");
    expect(browserRuntime).toContain('submitOutcomeUnknown = true');
    expect(browserRuntime).toContain("'CHATGPT_AUTOMATION_SUBMISSION_NOT_CONFIRMED'");
    expect(host).toContain('CONTROLLER_HOST_PROVIDER_DISPATCH_OUTCOME_UNKNOWN');
    expect(continuation).toContain('const outcomeUnknown =');
    expect(continuation).toContain('outcomeUnknown });');
  });
});
