import { describe, expect, test } from 'bun:test';
// @ts-expect-error The managed external provider is intentionally plain ESM and validated at its JSON protocol boundary.
import { ensureSourceRepositoryProvenance, executeAction, validateProviderConfig } from '../../scripts/forge-local-recovery-helper.mjs';

describe('local_recovery managed transport provider', () => {
  test('accepts only an absolute Controller Home and no provider endpoint overrides', () => {
    expect(validateProviderConfig({ controllerHome: '/tmp/controller' })).toEqual({ controllerHome: '/tmp/controller' });
    expect(() => validateProviderConfig({ controllerHome: 'relative' })).toThrow(/absolute controllerHome/);
    expect(() => validateProviderConfig({ controllerHome: '/tmp/controller', endpoint: 'http://127.0.0.1:1' })).toThrow(/accepts only controllerHome/);
  });

  test('read actions delegate exactly to existing Recovery MCP tools with no caller arguments', async () => {
    const calls: unknown[] = [];
    const callRecoveryTool = async (controllerHome: string, name: string, args: object) => {
      calls.push({ controllerHome, name, args });
      return { ok: true, name };
    };
    await expect(executeAction('runtime_status', {}, { controllerHome: '/tmp/controller' }, { callRecoveryTool, requestId: 'request-read-1' }))
      .resolves.toEqual({ ok: true, name: 'runtime_status' });
    await executeAction('list_releases', {}, { controllerHome: '/tmp/controller' }, { callRecoveryTool, requestId: 'request-read-2' });
    expect(calls).toEqual([
      { controllerHome: '/tmp/controller', name: 'runtime_status', args: {} },
      { controllerHome: '/tmp/controller', name: 'list_releases', args: {} },
    ]);
  });

  test('stage-and-activate delegates only to Recovery-owned transaction with provider-generated request id', async () => {
    const calls: unknown[] = [];
    const callRecoveryTool = async (controllerHome: string, name: string, args: object) => {
      calls.push({ controllerHome, name, args });
      return { ok: true, staged: { releaseId: 'candidate' } };
    };
    const result = await executeAction('stage_and_activate_runtime_release', {}, { controllerHome: '/tmp/controller' }, {
      callRecoveryTool,
      loadRecoveryConfig: () => ({ controllerHome: '/tmp/controller', primaryRuntimeSourceRepositoryId: 'repo_fixture' }),
      requestId: 'bootstrap-cutover-1',
    });
    expect(result).toEqual({ ok: true, staged: { releaseId: 'candidate' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ controllerHome: '/tmp/controller', name: 'stage_and_activate_runtime_release' });
    expect((calls[0] as any).args).toEqual({ request_id: expect.stringMatching(/^local-recovery:[a-f0-9]{32}$/) });
  });

  test('backfills only missing source repository provenance from the registered source-root owner', () => {
    const writes: unknown[] = [];
    const result = ensureSourceRepositoryProvenance('/tmp/controller', {
      loadRecoveryConfig: () => ({ controllerHome: '/tmp/controller', primaryRuntimeSourceRoot: '/workspace/source' }),
      findRegisteredRepositoryByCheckoutRoot: (root: string, controllerHome: string) => {
        expect(root).toBe('/workspace/source');
        expect(controllerHome).toBe('/tmp/controller');
        return { repoId: 'repo_fixture' };
      },
      createRecoveryConfig: (controllerHome: string, patch: object) => {
        writes.push({ controllerHome, patch });
        return { controllerHome, primaryRuntimeSourceRoot: '/workspace/source', primaryRuntimeSourceRepositoryId: 'repo_fixture' };
      },
    });
    expect(result.primaryRuntimeSourceRepositoryId).toBe('repo_fixture');
    expect(writes).toEqual([{ controllerHome: '/tmp/controller', patch: { primaryRuntimeSourceRoot: '/workspace/source', primaryRuntimeSourceRepositoryId: 'repo_fixture' } }]);

    let persisted = false;
    const existing = ensureSourceRepositoryProvenance('/tmp/controller', {
      loadRecoveryConfig: () => ({ controllerHome: '/tmp/controller', primaryRuntimeSourceRoot: '/workspace/source', primaryRuntimeSourceRepositoryId: 'repo_existing' }),
      createRecoveryConfig: () => { persisted = true; return {}; },
    });
    expect(existing.primaryRuntimeSourceRepositoryId).toBe('repo_existing');
    expect(persisted).toBe(false);
  });

  test('rejects every caller-controlled mutation parameter before Recovery dispatch', async () => {
    let called = false;
    const callRecoveryTool = async () => { called = true; return {}; };
    for (const input of [
      { source_root: '/tmp/source' },
      { release_path: '/tmp/release' },
      { endpoint: 'http://127.0.0.1:1' },
      { command: ['forge-recovery'] },
      { request_id: 'caller-owned' },
    ]) {
      await expect(executeAction('stage_and_activate_runtime_release', input, { controllerHome: '/tmp/controller' }, { callRecoveryTool }))
        .rejects.toThrow(/accept no caller/);
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
    new Response('data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}\n\n', { status: 200, headers: headers({ 'content-type': 'text/event-stream', 'mcp-session-id': 'session-local-recovery' }) }),
    new Response('', { status: 202 }),
    new Response('data: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\\"ok\\":true,\\"source\\":\\"recovery\\"}"}]}}\n\n', { status: 200, headers: headers({ 'content-type': 'text/event-stream' }) }),
    new Response('', { status: 204 }),
  ];
  const fakeFetch = async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return next;
  };
  const result = await callRecoveryTool('/tmp/controller', 'stage_and_activate_runtime_release', { request_id: 'local-recovery:0123456789abcdef0123456789abcdef' }, {
    loadRecoveryConfig: () => ({ schemaVersion: 1, controllerHome: '/tmp/controller', gateway: { host: '127.0.0.1', port: 8787, bearerTokenFile: '/ignored' } }),
    gatewayToken: () => 'x'.repeat(32),
    fetch: fakeFetch,
  });
  expect(result).toEqual({ ok: true, source: 'recovery' });
  expect(requests.map((entry) => entry.init.method)).toEqual(['POST', 'POST', 'POST', 'DELETE']);
  expect(requests.every((entry) => entry.url === 'http://127.0.0.1:8787/recovery/mcp')).toBe(true);
  const initialize = JSON.parse(String(requests[0]!.init.body));
  const notification = JSON.parse(String(requests[1]!.init.body));
  const call = JSON.parse(String(requests[2]!.init.body));
  expect(initialize.method).toBe('initialize');
  expect(notification.method).toBe('notifications/initialized');
  expect(call).toMatchObject({ method: 'tools/call', params: { name: 'stage_and_activate_runtime_release', arguments: { request_id: 'local-recovery:0123456789abcdef0123456789abcdef' } } });
  expect((requests[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${'x'.repeat(32)}`);
  expect((requests[2]!.init.headers as Record<string, string>)['mcp-session-id']).toBe('session-local-recovery');
  expect((requests[3]!.init.headers as Record<string, string>)['mcp-session-id']).toBe('session-local-recovery');
});


test('ReleaseSession actions expose only the exact session id and provider-owned mutation identity', async () => {
  const calls: Array<{ controllerHome: string; name: string; args: Record<string, unknown> }> = [];
  const callRecoveryTool = async (controllerHome: string, name: string, args: Record<string, unknown>) => {
    calls.push({ controllerHome, name, args });
    return { ok: true, name };
  };
  const providerConfig = { controllerHome: '/tmp/controller' };
  const sessionId = 'release-session-fixture-1234';

  await executeAction('release_session_status', { session_id: sessionId }, providerConfig, { callRecoveryTool, requestId: 'session-status' });
  for (const actionId of [
    'verify_runtime_release_session_static',
    'verify_runtime_release_session_candidate',
    'cutover_runtime_release_session',
    'cancel_runtime_release_session',
    'rollback_runtime_release_session',
    'promote_runtime_release_session_known_good',
  ]) {
    await executeAction(actionId, { session_id: sessionId }, providerConfig, { callRecoveryTool, requestId: `request-${actionId}` });
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

  await expect(executeAction('release_session_status', { session_id: sessionId, endpoint: 'http://127.0.0.1:1' }, providerConfig, { callRecoveryTool }))
    .rejects.toThrow(/accept only session_id/);
  await expect(executeAction('cutover_runtime_release_session', { session_id: sessionId, request_id: 'caller-owned' }, providerConfig, { callRecoveryTool }))
    .rejects.toThrow(/accept only session_id/);
  await expect(executeAction('verify_runtime_release_session_static', { session_id: 'short' }, providerConfig, { callRecoveryTool }))
    .rejects.toThrow(/8 to 120/);
});
