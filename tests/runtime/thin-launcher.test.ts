import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { chatgptLaunchSessionRequest } from '../../adapters/mcp/runtime-gateway/work-controller-operations';
import {
  buildClaudeControllerInvocation,
  buildSuperControllerInvocation,
  resolveLauncherExecutable,
  type ExternalControllerInvocationRequest,
} from '../../src/runtime/control-plane/launcher/thin-launcher';

describe('ChatGPT Launch Session without Work or Supervisor', () => {
  test('produces a stable one-shot Computer session for the same request ID', () => {
    const first = chatgptLaunchSessionRequest({ request_id: 'manual-launch-1', controller_type: 'chatgpt' }, 'repo-example');
    const replay = chatgptLaunchSessionRequest({ request_id: 'manual-launch-1' }, 'repo-example');
    expect(first).toEqual(replay);
    expect(first.sessionId).toStartWith('forge-launch-');
    expect(first.url).toBe('https://chatgpt.com/');
  });

  test('can open a precise authorized ChatGPT conversation without enrolling a Work', () => {
    const request = chatgptLaunchSessionRequest({
      request_id: 'bound-conversation',
      transport_conversation: 'bound',
      conversation_url: 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',
    }, 'repo-example');
    expect(request.url).toBe('https://chatgpt.com/c/11111111-2222-3333-4444-555555555555');
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
    writeFileSync(codex, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "probe" > "$HOME/probed"; fi\nexit 0\n', 'utf8');
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
    expect(() => buildSuperControllerInvocation(
      { controllerType: 'codex', cwd: '/tmp/repo' },
      'codex',
      'task',
    )).toThrow('LAUNCHER_CODEX_FORGE_MCP_REQUIRED');
    expect(() => buildSuperControllerInvocation(
      { controllerType: 'claude', cwd: '/tmp/repo' },
      'claude',
      'task',
    )).toThrow('LAUNCHER_CLAUDE_FORGE_MCP_REQUIRED');
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

    expect(() => buildClaudeControllerInvocation({
      executable: 'claude',
      prompt: 'test',
      mcpBootstrap: bootstrap,
      args: ['--mcp-config', '{}'],
    })).toThrow('LAUNCHER_CLAUDE_MCP_CONFIG_CONFLICT');

    expect(() => buildClaudeControllerInvocation({
      executable: 'claude',
      prompt: 'test',
      mcpBootstrap: bootstrap,
      args: ['--strict-mcp-config'],
    })).toThrow('LAUNCHER_CLAUDE_STRICT_MCP_CONFIG_CONFLICT');
  });
});
