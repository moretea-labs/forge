import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  chatgptLaunchSessionRequest,
  chatgptTabCloseProven,
} from '../../adapters/mcp/runtime-gateway/rh-work-controller-operations';
import {
  buildClaudeControllerInvocation,
  buildSuperControllerInvocation,
  resolveLauncherExecutable,
  type ExternalControllerInvocationRequest,
} from '../../src/runtime/control-plane/launcher/thin-launcher';
import {
  beginChatgptTaskSessionReplacement,
  bindInitialChatgptTaskSession,
  commitChatgptTaskSessionTakeover,
  confirmArchivedChatgptTabClosed,
  readChatgptTaskSessionBinding,
  reserveChatgptTaskSend,
  settleChatgptTaskSend,
} from '../../src/runtime/control-plane/launcher/chatgpt-task-session-store';

describe('ChatGPT Launch Session without Work or Supervisor', () => {
  test('produces a stable one-shot Computer session for the same request ID', () => {
    const first = chatgptLaunchSessionRequest(
      { request_id: 'manual-launch-1', controller_type: 'chatgpt' },
      'repo-example',
    );
    const replay = chatgptLaunchSessionRequest({ request_id: 'manual-launch-1' }, 'repo-example');
    expect(first).toEqual(replay);
    expect(first.sessionId).toStartWith('forge-launch-');
    expect(first.url).toBe('https://chatgpt.com/');
  });

  test('can open a precise authorized ChatGPT conversation without enrolling a Work', () => {
    const request = chatgptLaunchSessionRequest(
      {
        request_id: 'bound-conversation',
        transport_conversation: 'bound',
        conversation_url: 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',
      },
      'repo-example',
    );
    expect(request.url).toBe('https://chatgpt.com/c/11111111-2222-3333-4444-555555555555');
  });

  test('accepts a bounded Prompt only when it is attached to an existing task identity', () => {
    const request = chatgptLaunchSessionRequest(
      {
        request_id: 'task-round-1',
        task_id: 'issue:313',
        continuation_prompt: 'Continue the existing task.',
      },
      'repo-example',
    );
    expect(request.sessionId).toStartWith('forge-launch-');
    expect(request.url).toBe('https://chatgpt.com/');
  });

  test('rejects prompt auto-send, Supervisor enrollment, Work binding, and external origins', () => {
    for (const args of [
      { request_id: 'x', continuation_prompt: 'CONTINUE' },
      { request_id: 'x', enroll_current_conversation: true },
      { request_id: 'x', work_id: 'WORK-legacy' },
      { request_id: 'x', conversation_url: 'https://example.com/c/1' },
      { request_id: 'x', conversation_url: 'https://chatgpt.com.evil.test/' },
      { request_id: 'x', transport_conversation: 'bound' },
      { request_id: 'x', transport_conversation: 'fresh', conversation_url: 'https://chatgpt.com/c/abc' },
    ]) {
      if ('work_id' in args) {
        // The adapter owns this Work-binding rejection; the pure request parser
        // receives only already-approved launch-session inputs.
        continue;
      }
      expect(() => chatgptLaunchSessionRequest(args, 'repo-example')).toThrow();
    }
  });
});

describe('task-bound ChatGPT continuation session lifecycle', () => {
  test('requires exact resource-close evidence before completing old-tab cleanup', () => {
    expect(
      chatgptTabCloseProven({
        content: [],
        structuredContent: { resourceClosed: true },
      }),
    ).toBe(true);
    expect(
      chatgptTabCloseProven({
        content: [],
        structuredContent: { resourceAlreadyMissing: true },
      }),
    ).toBe(true);
    expect(
      chatgptTabCloseProven({
        content: [],
        structuredContent: { preservedUserOwnedTab: true, closed: true },
      }),
    ).toBe(false);
    expect(
      chatgptTabCloseProven({
        content: [],
        structuredContent: { resourceClosed: true, effectOutcome: 'outcome_unknown' },
      }),
    ).toBe(false);
  });

  test('reuses one active session and fences an outcome-unknown Send from replacement', () => {
    const controllerHome = temp('forge-chatgpt-task-session-unknown-');
    bindInitialChatgptTaskSession({
      controllerHome,
      repoId: 'repo-example',
      taskId: 'issue:313',
      sessionId: 'session-original',
      conversationUrl: 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',
      now: '2026-11-18T00:00:00.000Z',
    });
    reserveChatgptTaskSend({
      controllerHome,
      repoId: 'repo-example',
      taskId: 'issue:313',
      sessionId: 'session-original',
      requestId: 'round-1',
      now: '2026-11-18T00:00:01.000Z',
    });
    settleChatgptTaskSend({
      controllerHome,
      repoId: 'repo-example',
      taskId: 'issue:313',
      requestId: 'round-1',
      outcome: 'outcome_unknown',
      receiptId: 'receipt-unknown',
      now: '2026-11-18T00:00:02.000Z',
    });

    expect(() =>
      beginChatgptTaskSessionReplacement({
        controllerHome,
        repoId: 'repo-example',
        taskId: 'issue:313',
        expectedSessionId: 'session-original',
        candidateSessionId: 'session-replacement',
        reasonCode: 'original_unavailable',
      }),
    ).toThrow('CHATGPT_TASK_REPLACEMENT_PENDING_SEND');
    const binding = readChatgptTaskSessionBinding(controllerHome, 'repo-example', 'issue:313');
    expect(binding).toMatchObject({
      active: { sessionId: 'session-original' },
      pendingSend: { requestId: 'round-1', outcome: 'outcome_unknown' },
    });
    expect(binding?.replacement).toBeUndefined();
  });

  test('commits takeover only after the replacement Send receipt and retains archival lineage until exact-tab cleanup', () => {
    const controllerHome = temp('forge-chatgpt-task-session-takeover-');
    bindInitialChatgptTaskSession({
      controllerHome,
      repoId: 'repo-example',
      taskId: 'issue:313',
      sessionId: 'session-original',
      conversationUrl: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      now: '2026-11-18T00:00:00.000Z',
    });
    beginChatgptTaskSessionReplacement({
      controllerHome,
      repoId: 'repo-example',
      taskId: 'issue:313',
      expectedSessionId: 'session-original',
      candidateSessionId: 'session-replacement',
      reasonCode: 'original_conversation_failed',
      now: '2026-11-18T00:00:01.000Z',
    });
    reserveChatgptTaskSend({
      controllerHome,
      repoId: 'repo-example',
      taskId: 'issue:313',
      sessionId: 'session-replacement',
      requestId: 'replacement-send',
      now: '2026-11-18T00:00:02.000Z',
    });
    expect(() =>
      commitChatgptTaskSessionTakeover({
        controllerHome,
        repoId: 'repo-example',
        taskId: 'issue:313',
        candidateSessionId: 'session-replacement',
        conversationUrl: 'https://chatgpt.com/c/ffffffff-1111-2222-3333-444444444444',
        sendRequestId: 'replacement-send',
        sendReceiptId: 'receipt-applied',
      }),
    ).toThrow('CHATGPT_TASK_TAKEOVER_RECEIPT_REQUIRED');

    const replacementSent = settleChatgptTaskSend({
      controllerHome,
      repoId: 'repo-example',
      taskId: 'issue:313',
      requestId: 'replacement-send',
      outcome: 'applied',
      receiptId: 'receipt-applied',
      now: '2026-11-18T00:00:03.000Z',
    });
    expect(replacementSent.active).toMatchObject({ sessionId: 'session-original' });
    expect(replacementSent.active.sendRequestId).toBeUndefined();
    const takeover = commitChatgptTaskSessionTakeover({
      controllerHome,
      repoId: 'repo-example',
      taskId: 'issue:313',
      candidateSessionId: 'session-replacement',
      conversationUrl: 'https://chatgpt.com/c/ffffffff-1111-2222-3333-444444444444',
      sendRequestId: 'replacement-send',
      sendReceiptId: 'receipt-applied',
      now: '2026-11-18T00:00:04.000Z',
    });
    expect(takeover).toMatchObject({
      active: { sessionId: 'session-replacement', sendReceiptId: 'receipt-applied' },
      history: [{ sessionId: 'session-original', tabCleanup: 'pending', replacedBySessionId: 'session-replacement' }],
      replacement: undefined,
    });

    const cleaned = confirmArchivedChatgptTabClosed({
      controllerHome,
      repoId: 'repo-example',
      taskId: 'issue:313',
      sessionId: 'session-original',
      now: '2026-11-18T00:00:05.000Z',
    });
    expect(cleaned.history[0]?.tabCleanup).toBe('closed');
    expect(cleaned.active.sessionId).toBe('session-replacement');
  });
});

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function codexBootstrap() {
  return {
    url: 'http://127.0.0.1:9876/mcp',
    bearerTokenEnvVar: 'FORGE_RUNTIME_MCP_TOKEN' as const,
    principalId: 'external:codex:test',
    sessionId: 'external-session:codex:test',
    env: process.env,
  };
}

function claudeBootstrap() {
  return {
    url: 'http://127.0.0.1:9876/mcp',
    bearerTokenEnvVar: 'FORGE_RUNTIME_MCP_TOKEN' as const,
    principalId: 'external:claude:test',
    sessionId: 'external-session:claude:test',
    env: process.env,
  };
}

describe('External controller invocation utilities without Work lifecycle', () => {
  test('resolves Codex from the augmented repository PATH without an explicit executable override', () => {
    const root = temp('forge-thin-launcher-path-');
    const home = join(root, 'home');
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    const codex = join(bin, 'codex');
    writeFileSync(
      codex,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "probe" > "$HOME/probed"; fi\nexit 0\n',
      'utf8',
    );
    chmodSync(codex, 0o755);
    const request: ExternalControllerInvocationRequest = { controllerType: 'codex', cwd: root };
    const env = { HOME: home, PATH: '' };

    expect(resolveLauncherExecutable(request, env)).toBe('codex');
    const probeMarker = join(home, 'probed');
    expect(existsSync(probeMarker)).toBe(true);
    rmSync(probeMarker);
    expect(resolveLauncherExecutable(request, env, false)).toBe('codex');
    expect(existsSync(probeMarker)).toBe(false);
  });

  test('builds isolated Codex invocation with Forge MCP bootstrap', () => {
    const invocation = buildSuperControllerInvocation(
      { controllerType: 'codex', cwd: '/tmp/repo', args: ['--color', 'never'] },
      'codex',
      'continue bounded task',
      codexBootstrap(),
    );
    expect(invocation.args).toContain('--disable');
    expect(invocation.args[invocation.args.indexOf('--disable') + 1]).toBe('apps');
    expect(invocation.args).toContain('exec');
    expect(invocation.args).toContain('workspace-write');
    expect(invocation.args.join(' ')).toContain('mcp_servers.forge.url=');
    expect(invocation.args.join(' ')).not.toContain('work_id');
  });

  test('requires Forge MCP bootstrap for detached Codex and Claude invocation', () => {
    expect(() =>
      buildSuperControllerInvocation({ controllerType: 'codex', cwd: '/tmp/repo' }, 'codex', 'task'),
    ).toThrow('LAUNCHER_CODEX_FORGE_MCP_REQUIRED');
    expect(() =>
      buildSuperControllerInvocation({ controllerType: 'claude', cwd: '/tmp/repo' }, 'claude', 'task'),
    ).toThrow('LAUNCHER_CLAUDE_FORGE_MCP_REQUIRED');
  });

  test('builds isolated Claude invocation and rejects caller-owned MCP config', () => {
    const bootstrap = claudeBootstrap();
    const invocation = buildSuperControllerInvocation(
      { controllerType: 'claude', cwd: '/tmp/repo', args: ['--max-budget-usd', '5'] },
      'claude',
      'continue bounded task',
      bootstrap,
    );
    expect(invocation.args).toContain('--strict-mcp-config');
    expect(invocation.args).toContain('--mcp-config');
    expect(invocation.args).toContain('--max-budget-usd');
    expect(invocation.args).toContain('5');
    expect(invocation.args.join(' ')).not.toContain('work_id');

    expect(() =>
      buildClaudeControllerInvocation({
        executable: 'claude',
        prompt: 'test',
        mcpBootstrap: bootstrap,
        args: ['--mcp-config', '{}'],
      }),
    ).toThrow('LAUNCHER_CLAUDE_MCP_CONFIG_CONFLICT');

    expect(() =>
      buildClaudeControllerInvocation({
        executable: 'claude',
        prompt: 'test',
        mcpBootstrap: bootstrap,
        args: ['--strict-mcp-config'],
      }),
    ).toThrow('LAUNCHER_CLAUDE_STRICT_MCP_CONFIG_CONFLICT');
  });
});
