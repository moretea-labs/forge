import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { InMemoryTransport, Server } from "@modelcontextprotocol/server";
import { Client, SdkError, SdkErrorCode, SdkHttpError, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { forgeToolSurfaceFingerprint } from '../../src/cli/controller/runtime-config';
import { mcpToolDefinitionToSdk } from '../../packages/protocols/mcp/tool-contract';
import {
  CANONICAL_RUNTIME_CONNECT_TIMEOUT_MS,
  CANONICAL_RUNTIME_HANDOFF_WAIT_MS,
  CANONICAL_RUNTIME_TOOL_CALL_TIMEOUT_MS,
  DEFAULT_CANONICAL_RUNTIME_PROXY_LANES,
  MAX_CANONICAL_RUNTIME_PROXY_LANES,
  callCanonicalRuntimeToolWithReplay,
  canonicalRuntimeForwardingIdentity,
  chatgptHostSessionIdFromMcpMeta,
  canonicalRuntimeProxyLaneLimit,
  canonicalRuntimeReleaseHandoffInProgress,
  canonicalRuntimeToolCallFailureIsCutoverOutcomeUnknown,
  canonicalRuntimeToolCallFailureIsTransient,
  canonicalRuntimeToolCallIsReplaySafe,
  createCanonicalRuntimeProxy,
  createCanonicalRuntimeLaneScheduler,
  createForgeMcpServerFromContext,
  createMcpToolContext,
  deriveCanonicalForwardingTiming,
  readCanonicalRuntimeToolSchema,
  retryCanonicalRuntimeConnectDuringHandoff,
  sameCanonicalRuntimeProxyIdentity,
  waitForCanonicalRuntimeReleaseHandoff,
  type CanonicalRuntimeProxy,
  type CanonicalRuntimeToolSchema,
} from '../../src/cli/mcp/server';
import {
  isMcpToolsListRequest,
  mcpSessionToolSurfaceFingerprintIsCurrent,
  resolveMcpSessionCurrentFingerprint,
} from '../../src/cli/mcp/transports/http';
import {
  RUNTIME_MCP_CUTOVER_OUTCOME_UNKNOWN,
  RUNTIME_MCP_REQUEST_DRAIN_TIMEOUT_MS,
  closeRuntimeMcpTransportResources,
  startRuntimeMcpTransport,
} from '../../src/runtime/root/mcp-transport';
import { writeRuntimeStatusSnapshot } from '../../src/runtime/root/status';
import { registerRepository } from '../../src/cli/repositories/registry';
import {
  callPostFinalizeWorkReadOnlyCommand,
  callRepositoryToolWithPostFinalizeAttribution,
} from '../../src/cli/mcp/post-finalize-work-attribution';
import {
  createWorkContract,
  recordWorkCompletionReceipt,
  recordWorkImplementationReview,
  transitionWorkContractPhase,
} from '../../src/runtime/control-plane/facade/work-contract-store';
import { implementationReviewChangedPathDigest, reviseWorkSemanticContext } from '../../packages/kernel/work/api/index';
import { cognitionReadPort } from '../../src/runtime/control-plane/persistence/cognition-store';

describe('MCP ordinary tool cognition settlement', () => {
  test('exposes and settles model-authored learning after a successful repository tool outcome', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-mcp-cognition-settlement-'));
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    runPostFinalizeGit(repoRoot, ['init', '-b', 'main']);
    runPostFinalizeGit(repoRoot, ['config', 'user.name', 'Forge Cognition Test']);
    runPostFinalizeGit(repoRoot, ['config', 'user.email', 'forge-cognition@example.test']);
    writeFileSync(join(repoRoot, 'README.md'), 'ordinary cognition settlement\n');
    runPostFinalizeGit(repoRoot, ['add', 'README.md']);
    runPostFinalizeGit(repoRoot, ['commit', '-m', 'init']);
    const repository = registerRepository({ path: repoRoot, controllerHome, defaultBranch: 'main' });
    const workId = 'WORK-MCP-COGNITION-SETTLEMENT';
    createWorkContract({ controllerHome, repoId: repository.repoId }, {
      workId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      objective: 'Prove ordinary repository work can settle reusable cognition.',
      acceptanceCriteria: ['successful repository outcome persists model-authored learning'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: {},
      requestedBy: 'chatgpt',
      dispatchState: 'running',
    });

    const context = {
      ...createMcpToolContext({ controllerHome, profile: 'controller' }),
      principalId: 'controller-http-client',
      sessionId: 'session-mcp-cognition-settlement',
      controllerInstanceId: 'runtime-mcp-cognition-settlement',
      controllerType: 'chatgpt' as const,
    };
    const server = createForgeMcpServerFromContext(context);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'mcp-cognition-settlement', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      const repositoryRead = listed.tools.find(tool => tool.name === 'read_repository_file');
      expect((repositoryRead?.inputSchema as any)?.properties?.cognition_settlement).toBeDefined();

      const result = await client.callTool({
        name: 'read_repository_file',
        arguments: {
          repo_id: repository.repoId,
          path: 'README.md',
          work_id: workId,
          cognition_settlement: {
            work_id: workId,
            learning_signals: [{
              scope_kind: 'work',
              kind: 'principle',
              valence: 'positive',
              summary: 'Ordinary repository outcomes can settle reusable learning without a separate learning lifecycle.',
              concepts: ['mcp.cognition.settlement', 'ordinary-work'],
              facets: ['architecture'],
              admission_source: 'controller_observation',
              portability: 'local',
              salience: 0.9,
              confidence: 0.9,
              utility: 0.9,
            }],
          },
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        cognitionSettlement: { recorded: true, storedMemoryIds: [expect.any(String)] },
      });
      const stored = cognitionReadPort(controllerHome).exactByConcept(
        [{ schemaVersion: 1, kind: 'work', id: workId }],
        ['mcp.cognition.settlement'],
        4,
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]?.provenance.sourceWorkId).toBe(workId);
      expect(stored[0]?.provenance.sourceRoundId).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MCP canonical Runtime proxy routing', () => {
  test('bounds inner Runtime proxy lanes and leases them exclusively under concurrency', async () => {
    expect(canonicalRuntimeProxyLaneLimit(undefined)).toBe(DEFAULT_CANONICAL_RUNTIME_PROXY_LANES);
    expect(canonicalRuntimeProxyLaneLimit('0')).toBe(DEFAULT_CANONICAL_RUNTIME_PROXY_LANES);
    expect(canonicalRuntimeProxyLaneLimit('999')).toBe(MAX_CANONICAL_RUNTIME_PROXY_LANES);
    expect(canonicalRuntimeProxyLaneLimit('3')).toBe(3);

    const scheduler = createCanonicalRuntimeLaneScheduler(2);
    const first = await scheduler.acquire();
    const second = await scheduler.acquire();
    expect(first).not.toBe(second);
    expect(scheduler.size()).toBe(2);

    let thirdResolved = false;
    const thirdPromise = scheduler.acquire().then((laneId) => {
      thirdResolved = true;
      return laneId;
    });
    await Bun.sleep(1);
    expect(thirdResolved).toBe(false);

    scheduler.release(first);
    expect(await thirdPromise).toBe(first);
    scheduler.release(second);
    scheduler.release(first);
    scheduler.close();
    await expect(scheduler.acquire()).rejects.toThrow('CANONICAL_RUNTIME_PROXY_CLOSED');
  });

  test('reserves proxy capacity for interactive calls when process_wait saturates its lane budget', async () => {
    const scheduler = createCanonicalRuntimeLaneScheduler(3);
    const waitLane = await scheduler.acquire('wait');
    let secondWaitResolved = false;
    const secondWait = scheduler.acquire('wait').then((laneId) => {
      secondWaitResolved = true;
      return laneId;
    });
    await Bun.sleep(1);
    expect(secondWaitResolved).toBe(false);

    const interactiveLane = await scheduler.acquire('interactive');
    expect(interactiveLane).not.toBe(waitLane);
    scheduler.release(waitLane);
    expect(await secondWait).toBe(waitLane);
    scheduler.release(interactiveLane);
    scheduler.release(waitLane);
    scheduler.close();
  });

  test('invalidates a hot inner lane when the Canonical Runtime instance changes at the same endpoint and token', () => {
    const baseline = {
      endpoint: new URL('http://127.0.0.1:8766/mcp-bearer'),
      token: 'fixture-token',
      runtimeInstanceId: 'runtime-a',
    };
    expect(sameCanonicalRuntimeProxyIdentity(baseline, { ...baseline })).toBe(true);
    expect(sameCanonicalRuntimeProxyIdentity(baseline, { ...baseline, runtimeInstanceId: 'runtime-b' })).toBe(false);
  });

  test('replays one transient inner disconnect only for a keyed Work-attributed repository command', async () => {
    const args = {
      repo_id: 'repo-fixture',
      work_id: 'WORK-REPLAY-SAFE',
      request_id: 'stable-process-request',
      command: ['bun', 'x', 'tsc', '--noEmit'],
    };
    expect(canonicalRuntimeToolCallIsReplaySafe('repository_command_execute', args)).toBe(true);
    expect(canonicalRuntimeToolCallIsReplaySafe('repository_command_execute', { ...args, request_id: '' })).toBe(false);
    expect(canonicalRuntimeToolCallIsReplaySafe('rh_work', args)).toBe(false);
    expect(canonicalRuntimeToolCallIsReplaySafe('computer_console_unlock_prepare', { confirm_authorization: true })).toBe(false);
    for (const name of ['computer_console_unlock_enroll', 'computer_console_unlock_status', 'computer_console_unlock_recover', 'computer_console_unlock_revoke']) {
      expect(canonicalRuntimeToolCallIsReplaySafe(name, { confirm_authorization: true })).toBe(false);
    }
    expect(canonicalRuntimeToolCallIsReplaySafe('computer_console_unlock', { credential_handle: '11111111-1111-4111-8111-111111111111', confirm_authorization: true })).toBe(false);
    expect(canonicalRuntimeToolCallFailureIsTransient(new SdkError(SdkErrorCode.ConnectionClosed, 'connection closed'))).toBe(true);
    expect(canonicalRuntimeToolCallFailureIsTransient(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }))).toBe(true);
    expect(canonicalRuntimeToolCallFailureIsTransient(new SdkHttpError(
      SdkErrorCode.ConnectionClosed,
      'expired inner Runtime session',
      { status: 404, statusText: 'Not Found' },
    ))).toBe(true);
    const cutoverOutcomeUnknown = new SdkHttpError(
      SdkErrorCode.ConnectionClosed,
      'runtime cutover outcome unknown',
      { status: 409, statusText: 'Conflict' },
    );
    expect(canonicalRuntimeToolCallFailureIsTransient(cutoverOutcomeUnknown)).toBe(false);
    expect(canonicalRuntimeToolCallFailureIsCutoverOutcomeUnknown(cutoverOutcomeUnknown)).toBe(true);
    expect(canonicalRuntimeToolCallFailureIsCutoverOutcomeUnknown(new SdkHttpError(
      SdkErrorCode.ConnectionClosed,
      'semantic HTTP conflict',
      { status: 409, statusText: 'Conflict' },
    ))).toBe(false);
    expect(canonicalRuntimeToolCallFailureIsCutoverOutcomeUnknown(new Error('Connection closed'))).toBe(false);
    expect(canonicalRuntimeToolCallFailureIsTransient(new Error('WORK_CONTROLLER_CLAIM_REQUIRED'))).toBe(false);

    let calls = 0;
    let reconnects = 0;
    const result = await callCanonicalRuntimeToolWithReplay({
      name: 'repository_command_execute',
      args,
      call: async () => {
        calls += 1;
        if (calls === 1) throw new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed');
        return 'original-process';
      },
      reconnect: async () => { reconnects += 1; },
    });
    expect(result).toBe('original-process');
    expect(calls).toBe(2);
    expect(reconnects).toBe(1);

    let unkeyedCalls = 0;
    let unkeyedReconnects = 0;
    await expect(callCanonicalRuntimeToolWithReplay({
      name: 'repository_command_execute',
      args: { ...args, request_id: '' },
      call: async () => { unkeyedCalls += 1; throw new Error('Connection closed'); },
      reconnect: async () => { unkeyedReconnects += 1; },
    })).rejects.toThrow('Connection closed');
    expect(unkeyedCalls).toBe(1);
    expect(unkeyedReconnects).toBe(0);

    let cutoverCalls = 0;
    let cutoverReconnects = 0;
    await expect(callCanonicalRuntimeToolWithReplay({
      name: 'repository_command_execute',
      args,
      call: async () => {
        cutoverCalls += 1;
        throw new SdkHttpError(
          SdkErrorCode.ConnectionClosed,
          'runtime cutover outcome unknown',
          { status: 409, statusText: 'Conflict' },
        );
      },
      reconnect: async () => { cutoverReconnects += 1; },
    })).rejects.toThrow(RUNTIME_MCP_CUTOVER_OUTCOME_UNKNOWN);
    expect(cutoverCalls).toBe(1);
    expect(cutoverReconnects).toBe(0);
  });

  test('does not replay keyed Work commands for non-transient failures or beyond one retry', async () => {
    const args = { work_id: 'WORK-REPLAY-BOUND', request_id: 'stable-bound', command: ['true'] };
    let semanticCalls = 0;
    let semanticReconnects = 0;
    await expect(callCanonicalRuntimeToolWithReplay({
      name: 'repository_command_execute',
      args,
      call: async () => { semanticCalls += 1; throw new Error('WORK_CONTROLLER_OWNERSHIP_MISMATCH'); },
      reconnect: async () => { semanticReconnects += 1; },
    })).rejects.toThrow('WORK_CONTROLLER_OWNERSHIP_MISMATCH');
    expect(semanticCalls).toBe(1);
    expect(semanticReconnects).toBe(0);

    let repeatedCalls = 0;
    let repeatedReconnects = 0;
    await expect(callCanonicalRuntimeToolWithReplay({
      name: 'repository_command_execute',
      args,
      call: async () => { repeatedCalls += 1; throw new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed'); },
      reconnect: async () => { repeatedReconnects += 1; },
    })).rejects.toThrow('Connection closed');
    expect(repeatedCalls).toBe(2);
    expect(repeatedReconnects).toBe(1);
  });

  test('reuses one shared Runtime proxy across outer MCP sessions without collapsing caller session identity', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-runtime-proxy-reuse-'));
    const runtimeSchema: CanonicalRuntimeToolSchema = {
      definitions: [{ name: 'rh_status', description: 'fixture', inputSchema: { type: 'object' } }],
      toolNames: ['rh_status'],
      fingerprint: 'fixture-runtime-schema',
    };
    const observedSessions: string[] = [];
    const observedRequestIds: Array<unknown> = [];
    let closeCalls = 0;
    const sharedProxy: CanonicalRuntimeProxy = {
      listTools: async () => ({ tools: runtimeSchema.definitions.map(mcpToolDefinitionToSdk) }),
      callTool: async (ctx, _name, args) => {
        observedSessions.push(ctx.sessionId ?? 'missing');
        observedRequestIds.push(args.request_id);
        return {
          content: [{ type: 'text', text: '{"ok":true}' }],
          structuredContent: { ok: true },
        };
      },
      close: async () => { closeCalls += 1; },
    };
    const invoke = async (sessionId: string, requestId?: string): Promise<void> => {
      const context = {
        ...createMcpToolContext({ controllerHome, profile: 'controller' }),
        principalId: 'oauth-client:fixture',
        sessionId,
        controllerType: 'chatgpt' as const,
      };
      const server = createForgeMcpServerFromContext(context, runtimeSchema, sharedProxy);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: `proxy-client-${sessionId}`, version: '1.0.0' }, { capabilities: {} });
      await client.connect(clientTransport);
      try {
        await client.callTool({ name: 'rh_status', arguments: requestId ? { request_id: requestId } : {} });
      } finally {
        await client.close();
        await server.close();
      }
    };
    try {
      await invoke('outer-session-a', 'explicit-request-a');
      await invoke('outer-session-b');
      await invoke('outer-session-c');
      expect(observedSessions).toEqual(['outer-session-a', 'outer-session-b', 'outer-session-c']);
      expect(observedRequestIds).toEqual(['explicit-request-a', undefined, undefined]);
      expect(closeCalls).toBe(0);
    } finally {
      await sharedProxy.close();
      rmSync(controllerHome, { recursive: true, force: true });
    }
    expect(closeCalls).toBe(1);
  });

  test('keeps the real inner Runtime connection hot from schema discovery through separate outer sessions', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-runtime-proxy-real-reuse-'));
    const runtimeToken = 'fixture-runtime-token';
    const runtimeSchema: CanonicalRuntimeToolSchema = {
      definitions: [{ name: 'rh_status', description: 'fixture', inputSchema: { type: 'object' } }],
      toolNames: ['rh_status'],
      fingerprint: 'fixture-runtime-schema',
    };
    let initializedRuntimeSessions = 0;
    const runtimeTransport = await startRuntimeMcpTransport({
      host: '127.0.0.1',
      port: 0,
      authToken: runtimeToken,
      readiness: () => ({
        ready: true,
        reasonCodes: [],
        observedAt: new Date().toISOString(),
        diagnostics: {
          database: { outcome: 'pass' },
          scheduler: { outcome: 'pass' },
          releaseCoherence: { outcome: 'pass' },
          mcpEndToEnd: { outcome: 'pass' },
        },
      }),
      createServer: () => {
        initializedRuntimeSessions += 1;
        const server = new Server(
          { name: 'fixture-runtime', version: '1.0.0' },
          { capabilities: { tools: { listChanged: false } } },
        );
        server.setRequestHandler('tools/list', async () => ({ tools: runtimeSchema.definitions.map(mcpToolDefinitionToSdk) }));
        server.setRequestHandler('tools/call', async () => ({
          content: [{ type: 'text', text: '{"ok":true}' }],
          structuredContent: { ok: true },
        }));
        return server;
      },
    });
    const observedAt = new Date().toISOString();
    mkdirSync(join(controllerHome, 'mcp'), { recursive: true });
    writeFileSync(join(controllerHome, 'mcp', 'runtime-token'), runtimeToken, 'utf8');
    writeRuntimeStatusSnapshot(controllerHome, {
      schemaVersion: 1,
      runtimeInstanceId: 'runtime-proxy-reuse-fixture',
      pid: process.pid,
      releaseId: 'release-proxy-reuse-fixture',
      artifactIdentity: 'artifact-proxy-reuse-fixture',
      endpoint: runtimeTransport.endpoint,
      readiness: {
        ready: true,
        reasonCodes: [],
        observedAt,
        diagnostics: {
          database: { outcome: 'pass' },
          scheduler: { outcome: 'pass' },
          releaseCoherence: { outcome: 'pass' },
          mcpEndToEnd: { outcome: 'pass' },
        },
      },
      startedAt: observedAt,
      updatedAt: observedAt,
    });
    const baseContext = createMcpToolContext({ controllerHome, profile: 'controller' });
    const proxy = createCanonicalRuntimeProxy(baseContext);
    const invokeOuterSession = async (sessionId: string, schema: CanonicalRuntimeToolSchema): Promise<void> => {
      const server = createForgeMcpServerFromContext({
        ...baseContext,
        principalId: 'oauth-client:fixture',
        sessionId,
        controllerType: 'chatgpt',
      }, schema, proxy);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: `real-proxy-client-${sessionId}`, version: '1.0.0' }, { capabilities: {} });
      await client.connect(clientTransport);
      try {
        await client.callTool({ name: 'rh_status', arguments: { request_id: `req-${sessionId}` } });
      } finally {
        await client.close();
        await server.close();
      }
    };
    try {
      const schema = await readCanonicalRuntimeToolSchema(baseContext, proxy);
      await invokeOuterSession('outer-session-a', schema);
      await invokeOuterSession('outer-session-b', schema);

      // `startRuntimeMcpTransport` creates a Server only for an MCP initialize.
      // One initialize therefore proves schema discovery and both outer sessions
      // shared the same real inner Client instead of reconnecting per request.
      expect(initializedRuntimeSessions).toBe(1);
    } finally {
      await proxy.close();
      await runtimeTransport.close();
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('reclaims idle shared proxy lanes and reconnects on demand', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-runtime-proxy-idle-reclaim-'));
    const runtimeToken = 'runtime-proxy-idle-token';
    let initializedRuntimeSessions = 0;
    const runtimeTransport = await startRuntimeMcpTransport({
      host: '127.0.0.1',
      port: 0,
      authToken: runtimeToken,
      readiness: () => ({
        ready: true,
        reasonCodes: [],
        observedAt: new Date().toISOString(),
        diagnostics: {
          database: { outcome: 'pass' },
          scheduler: { outcome: 'pass' },
          releaseCoherence: { outcome: 'pass' },
          mcpEndToEnd: { outcome: 'pass' },
        },
      }),
      createServer: () => {
        initializedRuntimeSessions += 1;
        const server = new Server(
          { name: 'fixture-runtime-idle-reclaim', version: '1.0.0' },
          { capabilities: { tools: { listChanged: false } } },
        );
        server.setRequestHandler('tools/list', async () => ({ tools: [] }));
        return server;
      },
    });
    const observedAt = new Date().toISOString();
    mkdirSync(join(controllerHome, 'mcp'), { recursive: true });
    writeFileSync(join(controllerHome, 'mcp', 'runtime-token'), runtimeToken, 'utf8');
    writeRuntimeStatusSnapshot(controllerHome, {
      schemaVersion: 1,
      runtimeInstanceId: 'runtime-proxy-idle-reclaim-fixture',
      pid: process.pid,
      releaseId: 'release-proxy-idle-reclaim-fixture',
      artifactIdentity: 'artifact-proxy-idle-reclaim-fixture',
      endpoint: runtimeTransport.endpoint,
      readiness: {
        ready: true,
        reasonCodes: [],
        observedAt,
        diagnostics: {
          database: { outcome: 'pass' },
          scheduler: { outcome: 'pass' },
          releaseCoherence: { outcome: 'pass' },
          mcpEndToEnd: { outcome: 'pass' },
        },
      },
      startedAt: observedAt,
      updatedAt: observedAt,
    });
    const proxy = createCanonicalRuntimeProxy(
      createMcpToolContext({ controllerHome, profile: 'controller' }),
      { idleTtlMs: 5 },
    );
    try {
      await proxy.listTools();
      expect(initializedRuntimeSessions).toBe(1);
      expect(runtimeTransport.sessionSnapshot!().active).toBe(1);

      for (let attempt = 0; attempt < 20 && runtimeTransport.sessionSnapshot!().active !== 0; attempt += 1) {
        await Bun.sleep(5);
      }
      expect(runtimeTransport.sessionSnapshot!().active).toBe(0);

      await proxy.listTools();
      expect(initializedRuntimeSessions).toBe(2);
      expect(runtimeTransport.sessionSnapshot!().active).toBe(1);
    } finally {
      await proxy.close();
      await runtimeTransport.close();
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('bounds orphanable root Runtime sessions and evicts the least-recent idle session', async () => {
    const runtimeToken = 'runtime-session-capacity-fixture';
    const runtimeTransport = await startRuntimeMcpTransport({
      host: '127.0.0.1',
      port: 0,
      authToken: runtimeToken,
      maximumSessions: 2,
      readiness: () => ({
        ready: true,
        reasonCodes: [],
        observedAt: new Date().toISOString(),
        diagnostics: {
          database: { outcome: 'pass' },
          scheduler: { outcome: 'pass' },
          releaseCoherence: { outcome: 'pass' },
          mcpEndToEnd: { outcome: 'pass' },
        },
      }),
      createServer: () => {
        const server = new Server(
          { name: 'fixture-runtime-capacity', version: '1.0.0' },
          { capabilities: { tools: { listChanged: false } } },
        );
        server.setRequestHandler('tools/list', async () => ({ tools: [] }));
        return server;
      },
    });
    const clients: Client[] = [];
    const connect = async (name: string): Promise<Client> => {
      const transport = new StreamableHTTPClientTransport(new URL(runtimeTransport.endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${runtimeToken}` } },
      });
      const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);
      clients.push(client);
      return client;
    };

    try {
      const first = await connect('capacity-first');
      await Bun.sleep(2);
      const second = await connect('capacity-second');
      expect(runtimeTransport.sessionSnapshot!()).toMatchObject({
        active: 2,
        maximum: 2,
        initializing: 0,
        capacityAvailable: 0,
        capacityEvictions: 0,
      });

      const third = await connect('capacity-third');
      expect(runtimeTransport.sessionSnapshot!()).toMatchObject({
        active: 2,
        maximum: 2,
        initializing: 0,
        capacityAvailable: 0,
        capacityEvictions: 1,
      });
      await expect(first.listTools()).rejects.toThrow();
      await expect(second.listTools()).resolves.toMatchObject({ tools: [] });
      await expect(third.listTools()).resolves.toMatchObject({ tools: [] });
    } finally {
      await Promise.allSettled(clients.map(async (client) => await client.close()));
      await runtimeTransport.close();
    }
  });

  test('never evicts a root Runtime session while its request is in flight', async () => {
    const runtimeToken = 'runtime-session-protection-fixture';
    let releaseCall!: () => void;
    let markCallStarted!: () => void;
    const callStarted = new Promise<void>((resolve) => { markCallStarted = resolve; });
    const callReleased = new Promise<void>((resolve) => { releaseCall = resolve; });
    const runtimeTransport = await startRuntimeMcpTransport({
      host: '127.0.0.1',
      port: 0,
      authToken: runtimeToken,
      maximumSessions: 1,
      readiness: () => ({
        ready: true,
        reasonCodes: [],
        observedAt: new Date().toISOString(),
        diagnostics: {
          database: { outcome: 'pass' },
          scheduler: { outcome: 'pass' },
          releaseCoherence: { outcome: 'pass' },
          mcpEndToEnd: { outcome: 'pass' },
        },
      }),
      createServer: () => {
        const server = new Server(
          { name: 'fixture-runtime-protected', version: '1.0.0' },
          { capabilities: { tools: { listChanged: false } } },
        );
        server.setRequestHandler('tools/call', async () => {
          markCallStarted();
          await callReleased;
          return { content: [{ type: 'text', text: 'ok' }] };
        });
        return server;
      },
    });
    const transport = new StreamableHTTPClientTransport(new URL(runtimeTransport.endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${runtimeToken}` } },
    });
    const client = new Client({ name: 'protected-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    try {
      const activeCall = client.callTool({ name: 'block', arguments: {} });
      await callStarted;
      expect(runtimeTransport.sessionSnapshot!()).toMatchObject({ active: 1, protected: 1, capacityEvictions: 0 });
      const initializeAttempt = await fetch(runtimeTransport.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${runtimeToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'capacity-probe', method: 'initialize', params: {} }),
      });
      expect(initializeAttempt.status).toBe(503);
      expect(await initializeAttempt.json()).toEqual({ error: 'mcp_session_capacity_exhausted' });
      expect(runtimeTransport.sessionSnapshot!()).toMatchObject({ active: 1, protected: 1, capacityEvictions: 0 });
      releaseCall();
      await activeCall;
    } finally {
      releaseCall();
      await client.close().catch(() => undefined);
      await runtimeTransport.close();
    }
  });

  test('settles a real in-flight Runtime tool POST as cutover outcome-unknown before socket teardown', async () => {
    const runtimeToken = 'runtime-cutover-token';
    let releaseCall!: () => void;
    let markCallStarted!: () => void;
    const callStarted = new Promise<void>((resolve) => { markCallStarted = resolve; });
    const callReleased = new Promise<void>((resolve) => { releaseCall = resolve; });
    const runtimeTransport = await startRuntimeMcpTransport({
      host: '127.0.0.1',
      port: 0,
      authToken: runtimeToken,
      requestDrainTimeoutMs: 10,
      readiness: () => ({
        ready: true,
        reasonCodes: [],
        observedAt: new Date().toISOString(),
        diagnostics: {
          database: { outcome: 'pass' },
          scheduler: { outcome: 'pass' },
          releaseCoherence: { outcome: 'pass' },
          mcpEndToEnd: { outcome: 'pass' },
        },
      }),
      createServer: () => {
        const server = new Server(
          { name: 'fixture-runtime-cutover', version: '1.0.0' },
          { capabilities: { tools: { listChanged: false } } },
        );
        server.setRequestHandler('tools/call', async () => {
          markCallStarted();
          await callReleased;
          return { content: [{ type: 'text', text: 'late result' }] };
        });
        return server;
      },
    });
    const transport = new StreamableHTTPClientTransport(new URL(runtimeTransport.endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${runtimeToken}` } },
    });
    const client = new Client({ name: 'cutover-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    try {
      const activeCall = client.callTool({ name: 'block', arguments: {} });
      await callStarted;
      const closing = runtimeTransport.close();
      let observed: unknown;
      try { await activeCall; } catch (error) { observed = error; }
      expect(observed).toBeDefined();
      expect(canonicalRuntimeToolCallFailureIsCutoverOutcomeUnknown(observed)).toBe(true);
      releaseCall();
      await closing;
    } finally {
      releaseCall();
      await client.close().catch(() => undefined);
      await runtimeTransport.close().catch(() => undefined);
    }
  });

  test('accepts only bounded internal Runtime forwarding identity metadata', () => {
    expect(canonicalRuntimeForwardingIdentity({
      forgeRuntimeForwarding: {
        principalId: ' oauth-client:fixture ',
        sessionId: ' session-a ',
        controllerType: 'chatgpt',
        hostConversationSessionId: ' host-session-a ',
      },
    })).toEqual({
      principalId: 'oauth-client:fixture',
      sessionId: 'session-a',
      controllerType: 'chatgpt',
      hostConversationSessionId: 'host-session-a',
    });
    expect(canonicalRuntimeForwardingIdentity({
      forgeRuntimeForwarding: { principalId: 'fixture', sessionId: 'session-b', controllerType: 'root' },
    })).toEqual({ principalId: 'fixture', sessionId: 'session-b' });
    expect(canonicalRuntimeForwardingIdentity({ forgeRuntimeForwarding: 'invalid' })).toEqual({});
    expect(chatgptHostSessionIdFromMcpMeta({ 'openai/session': ' chat-session-1 ' })).toBe('chat-session-1');
    expect(chatgptHostSessionIdFromMcpMeta({ 'openai/session': 42 })).toBeUndefined();
    expect(chatgptHostSessionIdFromMcpMeta({})).toBeUndefined();
  });

  test('gracefully drains an in-flight Runtime request before closing sessions and forcing residual connections', async () => {
    const events: string[] = [];
    let releaseRequest!: () => void;
    let releaseListener!: () => void;
    const requestDrain = new Promise<void>((resolve) => { releaseRequest = resolve; });
    const listenerClosed = new Promise<void>((resolve) => { releaseListener = resolve; });
    const closing = closeRuntimeMcpTransportResources({
      closeListener: async () => {
        events.push('listener');
        await listenerClosed;
      },
      waitForRequestDrain: async () => {
        events.push('request-drain');
        await requestDrain;
      },
      closeSessions: [async () => { events.push('session'); }],
      forceCloseConnections: () => {
        events.push('force');
        releaseListener();
      },
      requestDrainTimeoutMs: 1_000,
      sessionCloseTimeoutMs: 1_000,
    });
    await Bun.sleep(10);
    expect(events).toEqual(['listener', 'request-drain']);
    releaseRequest();
    await closing;
    expect(events).toEqual(['listener', 'request-drain', 'session', 'force']);
  });

  test('settles over-budget Runtime requests before session and socket teardown', async () => {
    const events: string[] = [];
    let releaseRequest!: () => void;
    let releaseListener!: () => void;
    const requestDrain = new Promise<void>((resolve) => { releaseRequest = resolve; });
    const listenerClosed = new Promise<void>((resolve) => { releaseListener = resolve; });
    await closeRuntimeMcpTransportResources({
      closeListener: async () => {
        events.push('listener');
        await listenerClosed;
      },
      waitForRequestDrain: async () => {
        events.push('request-drain');
        await requestDrain;
      },
      settleActiveRequests: () => {
        events.push('settle');
        releaseRequest();
      },
      closeSessions: [async () => { events.push('session'); }],
      forceCloseConnections: () => {
        events.push('force');
        releaseListener();
      },
      requestDrainTimeoutMs: 5,
      sessionCloseTimeoutMs: 1_000,
    });
    expect(events).toEqual(['listener', 'request-drain', 'settle', 'session', 'force']);
  });

  test('keeps loopback connect fail-fast without capping valid tool work at five seconds', () => {
    expect(CANONICAL_RUNTIME_CONNECT_TIMEOUT_MS).toBe(5_000);
    expect(CANONICAL_RUNTIME_TOOL_CALL_TIMEOUT_MS).toBeGreaterThan(CANONICAL_RUNTIME_CONNECT_TIMEOUT_MS);
    expect(CANONICAL_RUNTIME_TOOL_CALL_TIMEOUT_MS).toBe(120_000);
    expect(RUNTIME_MCP_REQUEST_DRAIN_TIMEOUT_MS).toBe(5_000);
  });

  test('recognizes only recent Canonical Runtime release handoff states', () => {
    const nowMs = Date.parse('2026-08-18T04:00:30.000Z');
    expect(canonicalRuntimeReleaseHandoffInProgress({
      authorityReleaseId: 'release-new', authorityCommittedAt: '2026-08-18T04:00:25.000Z',
      runtimeReleaseId: 'release-old', runtimeRunning: false, runtimeReady: false,
      runtimeUpdatedAt: '2026-08-18T04:00:24.000Z', nowMs,
    })).toBe(true);
    expect(canonicalRuntimeReleaseHandoffInProgress({
      authorityReleaseId: 'release-new', authorityCommittedAt: '2026-08-18T04:00:25.000Z',
      runtimeReleaseId: 'release-new', runtimeRunning: true, runtimeReady: false,
      runtimeStartedAt: '2026-08-18T04:00:26.000Z', nowMs,
    })).toBe(true);
    expect(canonicalRuntimeReleaseHandoffInProgress({
      authorityReleaseId: 'release-old', authorityCommittedAt: '2026-08-17T04:00:00.000Z',
      runtimeReleaseId: 'release-old', runtimeRunning: false, runtimeReady: false,
      runtimeUpdatedAt: '2026-08-18T04:00:24.000Z', recoveryActivationInProgress: true, nowMs,
    })).toBe(true);
    expect(canonicalRuntimeReleaseHandoffInProgress({
      authorityReleaseId: 'release-old', authorityCommittedAt: '2026-08-17T04:00:00.000Z',
      runtimeReleaseId: 'release-old', runtimeRunning: false, runtimeReady: false,
      runtimeUpdatedAt: '2026-08-18T04:00:29.000Z', recoveryActivationInProgress: false, nowMs,
    })).toBe(false);
    expect(canonicalRuntimeReleaseHandoffInProgress({
      runtimeReleaseId: 'release-old', runtimeRunning: false, runtimeReady: false,
      runtimeUpdatedAt: '2026-08-18T04:00:29.000Z', nowMs,
    })).toBe(false);
  });

  test('waits boundedly for a release handoff to settle', async () => {
    let nowMs = 0;
    let observations = 0;
    const result = await waitForCanonicalRuntimeReleaseHandoff(
      () => ++observations < 4,
      {
        maxWaitMs: 1_000,
        intervalMs: 100,
        now: () => nowMs,
        sleep: async (ms) => { nowMs += ms; },
      },
    );
    expect(result.waited).toBe(true);
    expect(result.settled).toBe(true);
    expect(nowMs).toBe(300);
    expect(observations).toBe(4);
    expect(CANONICAL_RUNTIME_HANDOFF_WAIT_MS).toBeGreaterThan(CANONICAL_RUNTIME_CONNECT_TIMEOUT_MS);
  });

  test('retries only connection establishment during a proven release handoff', async () => {
    let attempts = 0;
    let nowMs = 0;
    let handoff = false;
    const value = await retryCanonicalRuntimeConnectDuringHandoff(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          handoff = true;
          throw new Error('ECONNREFUSED');
        }
        return 'connected';
      },
      () => handoff,
      {
        maxWaitMs: 1_000,
        intervalMs: 100,
        now: () => nowMs,
        sleep: async (ms) => { nowMs += ms; handoff = false; },
      },
    );
    expect(value).toBe('connected');
    expect(attempts).toBe(2);
  });

  test('keeps ordinary Canonical Runtime outages fail-fast when no handoff is active', async () => {
    let attempts = 0;
    await expect(retryCanonicalRuntimeConnectDuringHandoff(
      async () => { attempts += 1; throw new Error('ECONNREFUSED'); },
      () => false,
      { maxWaitMs: 1_000 },
    )).rejects.toThrow('ECONNREFUSED');
    expect(attempts).toBe(1);
  });

  test('derives pre-canonical dispatch and return transport phases from canonical response timing', () => {
    const response = {
      content: [{ type: 'text' as const, text: '{}' }],
      structuredContent: {
        responseMeta: {
          serverStartedAt: '2026-08-17T03:31:46.332Z',
          serverDurationMs: 66.22,
        },
      },
    };
    expect(deriveCanonicalForwardingTiming({
      gatewayCallStartedAtMs: Date.parse('2026-08-17T03:31:41.699Z'),
      gatewayCallDurationMs: 4701.36,
      response,
    })).toEqual({
      gatewayProxyCanonicalDispatchLagMs: 4633,
      gatewayProxyCanonicalDurationMs: 66.22,
      gatewayProxyReturnMs: 2.14,
    });
  });
});

describe('MCP canonical Runtime schema fencing', () => {
  test('recognizes only pure tools/list refresh requests', () => {
    expect(isMcpToolsListRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toBe(true);
    expect(isMcpToolsListRequest([
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ])).toBe(true);
    expect(isMcpToolsListRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call' })).toBe(false);
    expect(isMcpToolsListRequest([
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call' },
    ])).toBe(false);
  });

  test('changes only when the exposed schema changes, not when a release identity changes', () => {
    const surface = [{
      name: 'rh_work',
      description: 'Stable facade.',
      inputSchema: { type: 'object', properties: { operation: { type: 'string' } } },
      annotations: { readOnlyHint: false },
    }];
    const baseline = forgeToolSurfaceFingerprint(surface);
    expect(forgeToolSurfaceFingerprint(structuredClone(surface))).toBe(baseline);
    expect(mcpSessionToolSurfaceFingerprintIsCurrent(baseline, baseline)).toBe(true);
  });

  test('invalidates a session when discovery schema changes', () => {
    const before = forgeToolSurfaceFingerprint([{ name: 'rh_status', inputSchema: { type: 'object' } }]);
    const after = forgeToolSurfaceFingerprint([{ name: 'rh_context', inputSchema: { type: 'object' } }]);
    expect(before).not.toBe(after);
    expect(mcpSessionToolSurfaceFingerprintIsCurrent(before, after)).toBe(false);
  });

  test('uses the published Runtime fingerprint without rediscovering tools on the hot path', async () => {
    let discoveryCalls = 0;
    const fingerprint = await resolveMcpSessionCurrentFingerprint('runtime-schema-v1', async () => {
      discoveryCalls += 1;
      return 'runtime-schema-v1';
    });

    expect(fingerprint).toBe('runtime-schema-v1');
    expect(discoveryCalls).toBe(0);
  });

  test('falls back to live Runtime discovery when the published fingerprint is unavailable', async () => {
    let discoveryCalls = 0;
    const fingerprint = await resolveMcpSessionCurrentFingerprint(undefined, async () => {
      discoveryCalls += 1;
      return 'runtime-schema-v1';
    });

    expect(fingerprint).toBe('runtime-schema-v1');
    expect(discoveryCalls).toBe(1);
  });
});


function runPostFinalizeGit(root: string, args: string[]): string {
  const executed = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (executed.status !== 0) throw new Error(executed.stderr || `git ${args.join(' ')} failed`);
  return executed.stdout.trim();
}

function postFinalizeAttributionFixture() {
  const root = mkdtempSync(join(tmpdir(), 'forge-post-finalize-attribution-'));
  const controllerHome = join(root, 'controller');
  const repoRoot = join(root, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  runPostFinalizeGit(repoRoot, ['init', '-b', 'main']);
  runPostFinalizeGit(repoRoot, ['config', 'user.name', 'Forge Test']);
  runPostFinalizeGit(repoRoot, ['config', 'user.email', 'forge-test@example.com']);
  writeFileSync(join(repoRoot, 'README.md'), 'base\n');
  runPostFinalizeGit(repoRoot, ['add', 'README.md']);
  runPostFinalizeGit(repoRoot, ['commit', '-m', 'init']);
  const targetRevision = runPostFinalizeGit(repoRoot, ['rev-parse', 'HEAD']);
  const repository = registerRepository({ path: repoRoot, controllerHome, defaultBranch: 'main' });
  const workId = 'WORK-POST-FINALIZE-READONLY';
  const principalId = 'principal-post-finalize';
  createWorkContract({ controllerHome, repoId: repository.repoId }, {
    workId,
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    principalId,
    controllerInstanceId: 'runtime-post-finalize',
    objective: 'Exercise post-finalize readonly attribution.',
    acceptanceCriteria: ['readonly observation remains attributable after lifecycle close'],
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    constraints: {},
    requestedBy: 'chatgpt',
    workKind: 'completed_no_change',
    dispatchState: 'running',
  });
  transitionWorkContractPhase({ controllerHome, repoId: repository.repoId }, workId, {
    phase: 'verification',
    state: 'satisfied',
    summary: 'No-change fixture verification is complete before implementation review.',
  });
  const recordedAt = '2026-08-28T00:18:00.000Z';
  recordWorkImplementationReview({ controllerHome, repoId: repository.repoId }, workId, {
    schemaVersion: 1,
    reviewId: 'REV-post-finalize-readonly',
    workId,
    reviewerPrincipalId: principalId,
    decision: 'approved',
    rationale: 'The exact no-change completion candidate was reviewed before closing the Work lifecycle.',
    findings: [],
    sourceRevision: targetRevision,
    workspaceFingerprint: 'post-finalize-no-change-content',
    verificationWorkspaceFingerprint: 'post-finalize-no-change-verification',
    changedPaths: [],
    changedPathDigest: implementationReviewChangedPathDigest([]),
    acceptanceCriteriaSummary: 'readonly observation remains attributable after lifecycle close',
    verificationEvidence: [],
    architectureEvidence: [],
    recordedAt,
  });
  recordWorkCompletionReceipt({ controllerHome, repoId: repository.repoId }, workId, {
    schemaVersion: 1,
    receiptId: 'receipt-post-finalize-readonly',
    source: 'controller_work',
    issueId: 'post-finalize-attribution',
    taskId: workId,
    workId,
    targetBranch: 'main',
    targetRevision,
    changedPaths: [],
    delivery: { kind: 'no_change', status: 'integrated', strategy: 'no_change', reachable: true, recordedAt },
    cleanup: { status: 'complete', warnings: [], blockers: [], recordedAt },
    verifiedAt: recordedAt,
    recordedAt,
  }, 'completed_no_change', 'completed_no_change');
  reviseWorkSemanticContext({ controllerHome, repoId: repository.repoId }, workId, {
    expectedRevision: 1,
    state: 'completed',
  });
  return {
    root,
    controllerHome,
    repoRoot,
    repository,
    workId,
    caller: {
      sessionId: 'session-after-finalize',
      principalId,
      controllerInstanceId: 'runtime-after-finalize',
    },
  };
}

describe('MCP post-finalize Work attribution', () => {
  test('keeps completed Work attribution for bounded typed-argv readonly observations only', async () => {
    const fx = postFinalizeAttributionFixture();
    try {
      const response = await callRepositoryToolWithPostFinalizeAttribution(
        fx.controllerHome,
        'repository_command_execute',
        {
          repo_id: fx.repository.repoId,
          work_id: fx.workId,
          command: ['git', 'status', '-sb'],
          request_id: 'post-finalize-status',
        },
        fx.caller,
      );
      const structured = (response?.structuredContent ?? {}) as Record<string, unknown>;
      expect(structured.accepted).toBe(true);
      expect(structured.ok).toBe(true);
      expect(structured.semanticWorkState).toBe('completed');
      expect(structured.workId).toBe(fx.workId);
      expect(structured.postFinalizeAttribution).toBe('readonly_followup');
      expect(String(structured.stdout)).toContain('## main');

      expect(await callPostFinalizeWorkReadOnlyCommand(
        fx.controllerHome,
        'repository_command_execute',
        {
          repo_id: fx.repository.repoId,
          work_id: fx.workId,
          command: ['git', 'status', '-sb'],
          request_id: 'post-finalize-wrong-principal',
        },
        { ...fx.caller, principalId: 'different-principal' },
      )).toBeUndefined();
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test('does not reopen terminal Work mutation or remote-delivery authority', async () => {
    const fx = postFinalizeAttributionFixture();
    try {
      const mutationPath = join(fx.repoRoot, 'must-not-exist.txt');
      const mutationArgs = {
        repo_id: fx.repository.repoId,
        work_id: fx.workId,
        command: ['touch', 'must-not-exist.txt'],
        request_id: 'post-finalize-mutation',
      };
      expect(await callPostFinalizeWorkReadOnlyCommand(
        fx.controllerHome,
        'repository_command_execute',
        mutationArgs,
        fx.caller,
      )).toBeUndefined();
      expect(await callPostFinalizeWorkReadOnlyCommand(
        fx.controllerHome,
        'repository_command_execute',
        {
          repo_id: fx.repository.repoId,
          work_id: fx.workId,
          command: ['git', 'push', 'origin', 'main'],
          request_id: 'post-finalize-delivery',
        },
        fx.caller,
      )).toBeUndefined();

      let rejection = '';
      try {
        const response = await callRepositoryToolWithPostFinalizeAttribution(
          fx.controllerHome,
          'repository_command_execute',
          mutationArgs,
          fx.caller,
        );
        rejection = JSON.stringify(response?.structuredContent ?? response);
      } catch (error) {
        rejection = error instanceof Error ? error.message : String(error);
      }
      expect(rejection).toContain('WORK_ATTRIBUTION_INVALID');
      expect(existsSync(mutationPath)).toBe(false);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});
