import { describe, expect, test } from 'bun:test';
import { executeCapabilityRecoveryAction } from '../../src/runtime/recovery/capability-action-application';
// @ts-expect-error The managed external provider is intentionally plain ESM and validated at its JSON protocol boundary.
import { executeAction, validateProviderConfig } from '../../scripts/forge-local-recovery-helper.mjs';

describe('local_recovery managed transport provider', () => {
  test('generic capability recovery cannot stage a release without the standalone source-selection contract', async () => {
    await expect(
      executeCapabilityRecoveryAction({
        controllerHome: '/tmp/controller',
        actionId: 'recovery.stage_runtime_release',
        reason: 'fixture',
        confirmAuthorization: true,
        callStandaloneRecoveryTool: async () => {
          throw new Error('must not stage');
        },
        recoverySnapshot: async () => ({}),
      }),
    ).rejects.toThrow('RECOVERY_ACTION_UNKNOWN');
  });
  test('accepts only an absolute Controller Home and no provider endpoint overrides', () => {
    expect(validateProviderConfig({ controllerHome: '/tmp/controller' })).toEqual({
      controllerHome: '/tmp/controller',
    });
    expect(() => validateProviderConfig({ controllerHome: 'relative' })).toThrow(/absolute controllerHome/);
    expect(() => validateProviderConfig({ controllerHome: '/tmp/controller', endpoint: 'http://127.0.0.1:1' })).toThrow(
      /accepts only controllerHome/,
    );
  });

  test('read actions delegate exactly to existing Recovery MCP tools with no caller arguments', async () => {
    const calls: Array<{ controllerHome: string; name: string; args: object }> = [];
    const callRecoveryTool = async (controllerHome: string, name: string, args: object) => {
      calls.push({ controllerHome, name, args });
      return { ok: true, name };
    };
    await expect(
      executeAction(
        'runtime_status',
        {},
        { controllerHome: '/tmp/controller' },
        { callRecoveryTool, requestId: 'request-read-1' },
      ),
    ).resolves.toEqual({ ok: true, name: 'runtime_status' });
    await executeAction(
      'list_releases',
      {},
      { controllerHome: '/tmp/controller' },
      { callRecoveryTool, requestId: 'request-read-2' },
    );
    await executeAction(
      'verify_stable_runtime',
      {},
      { controllerHome: '/tmp/controller' },
      { callRecoveryTool, requestId: 'request-read-3' },
    );
    expect(calls).toEqual([
      { controllerHome: '/tmp/controller', name: 'runtime_status', args: {} },
      { controllerHome: '/tmp/controller', name: 'list_releases', args: {} },
      { controllerHome: '/tmp/controller', name: 'verify_stable_runtime', args: {} },
    ]);
  });

  test('exact source selection, staging, and ReleaseSession advance delegate with provider-owned request identity', async () => {
    const calls: Array<{ controllerHome: string; name: string; args: object }> = [];
    const callRecoveryTool = async (controllerHome: string, name: string, args: object) => {
      calls.push({ controllerHome, name, args });
      return { ok: true, staged: { releaseId: 'candidate' } };
    };
    const sourceRevision = 'a'.repeat(40);
    const result = await executeAction(
      'stage_runtime_release',
      { source_repository_id: 'repo_fixture', expected_source_revision: sourceRevision },
      { controllerHome: '/tmp/controller' },
      {
        callRecoveryTool,
        loadRecoveryConfig: () => ({
          controllerHome: '/tmp/controller',
          primaryRuntimeSourceRoot: '/tmp',
          primaryRuntimeSourceRepositoryId: 'repo_fixture',
        }),
        getRepository: () => ({ repoId: 'repo_fixture', enabled: true, canonicalRoot: '/tmp' }),
        findRegisteredRepositoryByCheckoutRoot: () => ({ repoId: 'repo_fixture' }),
        requestId: 'stage-release-1',
      },
    );
    expect(result).toEqual({ ok: true, staged: { releaseId: 'candidate' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ controllerHome: '/tmp/controller', name: 'stage_runtime_release' });
    expect(calls[0]?.args).toEqual({
      source_repository_id: 'repo_fixture',
      expected_source_revision: sourceRevision,
      request_id: expect.stringMatching(/^local-recovery:[a-f0-9]{32}$/),
    });

    await executeAction(
      'prepare_runtime_release_session',
      { source_repository_id: 'repo_fixture', expected_source_revision: sourceRevision.toUpperCase() },
      { controllerHome: '/tmp/controller' },
      {
        callRecoveryTool,
        loadRecoveryConfig: () => ({
          controllerHome: '/tmp/controller',
          primaryRuntimeSourceRoot: '/tmp',
          primaryRuntimeSourceRepositoryId: 'repo_fixture',
        }),
        getRepository: () => ({ repoId: 'repo_fixture', enabled: true, canonicalRoot: '/tmp' }),
        findRegisteredRepositoryByCheckoutRoot: () => ({ repoId: 'repo_fixture' }),
        requestId: 'release-prepare-1',
      },
    );
    expect(calls[1]).toMatchObject({ controllerHome: '/tmp/controller', name: 'prepare_runtime_release_session' });
    expect(calls[1]?.args).toEqual({
      source_repository_id: 'repo_fixture',
      expected_source_revision: sourceRevision,
      request_id: expect.stringMatching(/^local-recovery:[a-f0-9]{32}$/),
    });

    await executeAction(
      'advance_runtime_release_session',
      {},
      { controllerHome: '/tmp/controller' },
      {
        callRecoveryTool,
        loadRecoveryConfig: () => ({
          controllerHome: '/tmp/controller',
          primaryRuntimeSourceRoot: '/tmp',
          primaryRuntimeSourceRepositoryId: 'repo_fixture',
        }),
        getRepository: () => ({ repoId: 'repo_fixture', enabled: true, canonicalRoot: '/tmp' }),
        findRegisteredRepositoryByCheckoutRoot: () => ({ repoId: 'repo_fixture' }),
        requestId: 'release-advance-1',
      },
    );
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({ controllerHome: '/tmp/controller', name: 'advance_runtime_release_session' });
    expect(calls[2]?.args).toEqual({ request_id: expect.stringMatching(/^local-recovery:[a-f0-9]{32}$/) });

    await expect(
      executeAction('prepare_runtime_release_session', {}, { controllerHome: '/tmp/controller' }, { callRecoveryTool }),
    ).rejects.toThrow('expected_source_revision must be one exact 40-hex Git commit.');
    await expect(
      executeAction(
        'advance_runtime_release_session',
        { expected_source_revision: sourceRevision },
        { controllerHome: '/tmp/controller' },
        { callRecoveryTool },
      ),
    ).rejects.toThrow(
      'Local Recovery actions accept no caller endpoint, path, command, token, release, source, or tunnel arguments.',
    );
  });

  test('explicit source selection overrides stale config and never repairs config during advance', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const source = { source_repository_id: 'repo_selected', expected_source_revision: 'a'.repeat(40) };
    const injected = {
      callRecoveryTool: async (_home: string, name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { ok: true };
      },
      loadRecoveryConfig: () => {
        throw new Error('source must not be inferred from config');
      },
      createRecoveryConfig: () => {
        throw new Error('advance must not repair config');
      },
    };
    for (const action of ['stage_runtime_release', 'prepare_runtime_release_session']) {
      await executeAction(action, source, { controllerHome: '/tmp/controller' }, injected);
      expect(calls.at(-1)?.args).toMatchObject(source);
    }
    await executeAction('advance_runtime_release_session', {}, { controllerHome: '/tmp/controller' }, injected);
    expect(calls.at(-1)?.args).toEqual({ request_id: expect.stringMatching(/^local-recovery:[a-f0-9]{32}$/) });
  });

  test('stage requires an explicit repository/commit pair and rejects every other caller-controlled mutation parameter', async () => {
    let called = false;
    const callRecoveryTool = async () => {
      called = true;
      return {};
    };
    for (const input of [
      {},
      { expected_source_revision: 'not-a-sha' },
      { expected_source_revision: 'a'.repeat(40) },
      { source_repository_id: '../path', expected_source_revision: 'a'.repeat(40) },
      { source_root: '/tmp/source' },
      { release_path: '/tmp/release' },
      { endpoint: 'http://127.0.0.1:1' },
      { command: ['forge-recovery'] },
      { request_id: 'caller-owned' },
    ]) {
      await expect(
        executeAction('stage_runtime_release', input, { controllerHome: '/tmp/controller' }, { callRecoveryTool }),
      ).rejects.toThrow();
    }
    expect(called).toBe(false);
  });
});

test('Local Recovery MCP client uses one authenticated loopback session and closes it', async () => {
  // @ts-expect-error The managed external provider is intentionally plain ESM and validated at its JSON protocol boundary.
  const { callRecoveryTool } = await import('../../scripts/forge-local-recovery-helper.mjs');
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const headers = (extra: Record<string, string> = {}) => new Headers(extra);
  const responses = [
    new Response('data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}\n\n', {
      status: 200,
      headers: headers({ 'content-type': 'text/event-stream', 'mcp-session-id': 'session-local-recovery' }),
    }),
    new Response('', { status: 202 }),
    new Response(
      'data: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\\"ok\\":true,\\"source\\":\\"recovery\\"}"}]}}\n\n',
      { status: 200, headers: headers({ 'content-type': 'text/event-stream' }) },
    ),
    new Response('', { status: 204 }),
  ];
  const fakeFetch = async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return next;
  };
  const result = await callRecoveryTool(
    '/tmp/controller',
    'prepare_runtime_release_session',
    { request_id: 'local-recovery:0123456789abcdef0123456789abcdef' },
    {
      loadRecoveryConfig: () => ({
        schemaVersion: 1,
        controllerHome: '/tmp/controller',
        gateway: { host: '127.0.0.1', port: 8787, bearerTokenFile: '/ignored' },
      }),
      gatewayToken: () => 'x'.repeat(32),
      fetch: fakeFetch,
    },
  );
  expect(result).toEqual({ ok: true, source: 'recovery' });
  expect(requests.map((entry) => entry.init.method)).toEqual(['POST', 'POST', 'POST', 'DELETE']);
  expect(requests.every((entry) => entry.url === 'http://127.0.0.1:8787/recovery/mcp')).toBe(true);
  const initialize = JSON.parse(String(requests[0]!.init.body));
  const notification = JSON.parse(String(requests[1]!.init.body));
  const call = JSON.parse(String(requests[2]!.init.body));
  expect(initialize.method).toBe('initialize');
  expect(notification.method).toBe('notifications/initialized');
  expect(call).toMatchObject({
    method: 'tools/call',
    params: {
      name: 'prepare_runtime_release_session',
      arguments: { request_id: 'local-recovery:0123456789abcdef0123456789abcdef' },
    },
  });
  expect((requests[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${'x'.repeat(32)}`);
  expect((requests[2]!.init.headers as Record<string, string>)['mcp-session-id']).toBe('session-local-recovery');
  expect((requests[3]!.init.headers as Record<string, string>)['mcp-session-id']).toBe('session-local-recovery');
});

test('Local Recovery MCP client supports stateless Recovery transport without requiring a session id', async () => {
  // @ts-expect-error The managed external provider is intentionally plain ESM and validated at its JSON protocol boundary.
  const { callRecoveryTool } = await import('../../scripts/forge-local-recovery-helper.mjs');
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const headers = (extra: Record<string, string> = {}) => new Headers(extra);
  const responses = [
    new Response('data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}\n\n', {
      status: 200,
      headers: headers({ 'content-type': 'text/event-stream' }),
    }),
    new Response('', { status: 202 }),
    new Response(
      'data: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\\"ok\\":true,\\"stateless\\":true}"}]}}\n\n',
      { status: 200, headers: headers({ 'content-type': 'text/event-stream' }) },
    ),
  ];
  const fakeFetch = async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return next;
  };
  const result = await callRecoveryTool(
    '/tmp/controller',
    'runtime_status',
    {},
    {
      loadRecoveryConfig: () => ({
        schemaVersion: 1,
        controllerHome: '/tmp/controller',
        gateway: { host: '127.0.0.1', port: 8787, bearerTokenFile: '/tmp/token' },
      }),
      gatewayToken: () => 'x'.repeat(32),
      fetch: fakeFetch,
    },
  );
  expect(result).toEqual({ ok: true, stateless: true });
  expect(requests.map((entry) => entry.init.method)).toEqual(['POST', 'POST', 'POST']);
  expect((requests[1]!.init.headers as Record<string, string>)['mcp-session-id']).toBeUndefined();
  expect((requests[2]!.init.headers as Record<string, string>)['mcp-session-id']).toBeUndefined();
});

test('Local Recovery MCP client preserves Recovery tool errors instead of parsing them as success JSON', async () => {
  // @ts-expect-error The managed external provider is intentionally plain ESM and validated at its JSON protocol boundary.
  const { callRecoveryTool } = await import('../../scripts/forge-local-recovery-helper.mjs');
  const headers = (extra: Record<string, string> = {}) => new Headers(extra);
  const responses = [
    new Response('data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":\"2025-06-18\"}}\n\n', {
      status: 200,
      headers: headers({ 'content-type': 'text/event-stream', 'mcp-session-id': 'session-local-recovery-error' }),
    }),
    new Response('', { status: 202 }),
    new Response(
      'data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"isError\":true,\"content\":[{\"type\":\"text\",\"text\":\"RELEASE_SESSION_STABLE_RUNTIME_NOT_VERIFIED\"}]}}\n\n',
      { status: 200, headers: headers({ 'content-type': 'text/event-stream' }) },
    ),
    new Response('', { status: 204 }),
  ];
  const fakeFetch = async () => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return next;
  };
  await expect(
    callRecoveryTool(
      '/tmp/controller',
      'prepare_runtime_release_session',
      { request_id: 'local-recovery:0123456789abcdef0123456789abcdef' },
      {
        loadRecoveryConfig: () => ({
          schemaVersion: 1,
          controllerHome: '/tmp/controller',
          gateway: { host: '127.0.0.1', port: 8787, bearerTokenFile: '/tmp/token' },
        }),
        gatewayToken: () => 'x'.repeat(32),
        fetch: fakeFetch,
      },
    ),
  ).rejects.toThrow('RELEASE_SESSION_STABLE_RUNTIME_NOT_VERIFIED');
});

test('ReleaseSession actions expose only the exact session id and provider-owned mutation identity', async () => {
  const calls: Array<{ controllerHome: string; name: string; args: Record<string, unknown> }> = [];
  const callRecoveryTool = async (controllerHome: string, name: string, args: Record<string, unknown>) => {
    calls.push({ controllerHome, name, args });
    return { ok: true, name };
  };
  const providerConfig = { controllerHome: '/tmp/controller' };
  const sessionId = 'release-session-fixture-1234';

  await executeAction('release_session_status', { session_id: sessionId }, providerConfig, {
    callRecoveryTool,
    requestId: 'session-status',
  });
  for (const actionId of [
    'verify_runtime_release_session_candidate',
    'cutover_runtime_release_session',
    'cancel_runtime_release_session',
    'rollback_runtime_release_session',
    'promote_runtime_release_session_known_good',
  ]) {
    await executeAction(actionId, { session_id: sessionId }, providerConfig, {
      callRecoveryTool,
      requestId: `request-${actionId}`,
    });
  }

  expect(calls[0]).toEqual({
    controllerHome: '/tmp/controller',
    name: 'release_session_status',
    args: { session_id: sessionId },
  });
  for (const call of calls.slice(1)) {
    expect(call.controllerHome).toBe('/tmp/controller');
    expect(call.args).toEqual({
      session_id: sessionId,
      request_id: expect.stringMatching(/^local-recovery:[a-f0-9]{32}$/),
    });
  }

  await expect(
    executeAction('release_session_status', { session_id: sessionId, endpoint: 'http://127.0.0.1:1' }, providerConfig, {
      callRecoveryTool,
    }),
  ).rejects.toThrow(/accept only session_id/);
  await expect(
    executeAction(
      'cutover_runtime_release_session',
      { session_id: sessionId, request_id: 'caller-owned' },
      providerConfig,
      { callRecoveryTool },
    ),
  ).rejects.toThrow(/accept only session_id/);
  await expect(
    executeAction('verify_runtime_release_session_static', { session_id: sessionId }, providerConfig, {
      callRecoveryTool,
    }),
  ).rejects.toThrow(/Unsupported Local Recovery action/);
  await expect(
    executeAction('verify_runtime_release_session_candidate', { session_id: 'short' }, providerConfig, {
      callRecoveryTool,
    }),
  ).rejects.toThrow(/8 to 120/);
});
