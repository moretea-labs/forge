import { describe, expect, test } from 'bun:test';
import { buildSuperControllerInvocation, type ThinLauncherRequest } from '../../src/runtime/control-plane/launcher/thin-launcher';

function request(overrides: Partial<ThinLauncherRequest> = {}): ThinLauncherRequest {
  return {
    controllerType: 'chatgpt',
    workId: 'WORK-1',
    controllerId: 'controller-1',
    sessionId: 'session-1',
    cwd: '/tmp/repo',
    ...overrides,
  };
}

describe('Thin Launcher external Controller invocation', () => {
  test('continues a saved Forge ChatGPT browser session instead of opening a new conversation', () => {
    const invocation = buildSuperControllerInvocation(
      request({ browserSessionId: 'browser-session-123' }),
      'forge',
      'continue bounded work',
    );
    expect(invocation).toEqual({
      executable: 'forge',
      args: [
        'chatgpt', 'browser-followup',
        '--repo', '/tmp/repo',
        '--session', 'browser-session-123',
        '--prompt', 'continue bounded work',
        '--keep-browser',
      ],
    });
  });

  test('can target an explicit ChatGPT conversation URL as the browser fallback', () => {
    const invocation = buildSuperControllerInvocation(
      request({ conversationUrl: 'https://chatgpt.com/c/example' }),
      'forge',
      'continue bounded work',
    );
    expect(invocation.args).toContain('browser-consult');
    expect(invocation.args).toContain('--chatgpt-url');
    expect(invocation.args).toContain('https://chatgpt.com/c/example');
  });

  test('rejects non-ChatGPT URLs from the wake path', () => {
    expect(() => buildSuperControllerInvocation(
      request({ conversationUrl: 'https://example.com/c/example' }),
      'forge',
      'continue bounded work',
    )).toThrow('LAUNCHER_CHATGPT_CONVERSATION_URL_INVALID');
  });

  test('keeps provider-specific CLI controllers on their native executable path', () => {
    const invocation = buildSuperControllerInvocation(
      request({ controllerType: 'codex', args: ['exec', '--full-auto'] }),
      'codex',
      'continue bounded work',
    );
    expect(invocation).toEqual({ executable: 'codex', args: ['exec', '--full-auto', 'continue bounded work'] });
  });
});
