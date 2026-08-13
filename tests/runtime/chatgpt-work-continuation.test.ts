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

  test('lets only the exact target ChatGPT conversation claim a bridge task', () => {
    expect(chatgptBridgeTargetMatchesPage('https://chatgpt.com/c/target-id', 'https://chatgpt.com/c/target-id?model=current')).toBe(true);
    expect(chatgptBridgeTargetMatchesPage('https://chatgpt.com/c/target-id', 'https://chatgpt.com/c/other-id')).toBe(false);
    expect(chatgptBridgeTargetMatchesPage('https://chatgpt.com/', 'https://chatgpt.com/')).toBe(true);
    expect(chatgptBridgeTargetMatchesPage('https://chatgpt.com/', 'https://chatgpt.com/c/other-id')).toBe(false);
  });

  test('submits continuation from the stable prompt editor instead of a send-button selector', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/control-plane/launcher/chatgpt-work-continuation.ts'), 'utf8');
    expect(source).toContain("controllerBrowserAction(input.controllerHome, input.workId, 'press'");
    expect(source).toContain('key: CHATGPT_SEND_KEY');
    expect(source).not.toContain('[data-testid=\"send-button\"]');
  });
});
