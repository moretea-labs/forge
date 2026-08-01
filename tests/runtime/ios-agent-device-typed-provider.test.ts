import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resetAgentDeviceTypedProviderHooksForTest,
  setAgentDeviceTypedProviderHooksForTest,
  TypedAgentDeviceReadProvider,
  typedAgentDeviceIdentity,
} from '../../src/runtime/plugins/ios/agent-device-typed-provider';
import {
  agentDeviceProviderVersionsMatch,
  configuredAgentDeviceBackendMode,
} from '../../src/runtime/plugins/ios/agent-device-provider';

const roots: string[] = [];

afterEach(() => {
  resetAgentDeviceTypedProviderHooksForTest();
  delete process.env.REPO_HARNESS_AGENT_DEVICE_BACKEND;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeModulePath(version = '0.20.2'): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-device-typed-provider-'));
  roots.push(root);
  const dist = join(root, 'dist', 'src');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'agent-device', version }));
  const module = join(dist, 'index.js');
  writeFileSync(module, 'export {};');
  return module;
}

describe('agent-device typed read provider', () => {
  it('parses backend modes and requires exact typed/CLI provider version identity', () => {
    expect(configuredAgentDeviceBackendMode(undefined)).toBe('auto');
    expect(configuredAgentDeviceBackendMode('typed')).toBe('typed');
    expect(configuredAgentDeviceBackendMode('CLI')).toBe('cli');
    expect(configuredAgentDeviceBackendMode('future-mode')).toBe('auto');
    expect(agentDeviceProviderVersionsMatch('0.20.2', '0.20.2')).toBe(true);
    expect(agentDeviceProviderVersionsMatch('v0.20.2', '0.20.2')).toBe(true);
    expect(agentDeviceProviderVersionsMatch('0.20.1', '0.20.2')).toBe(false);
    expect(agentDeviceProviderVersionsMatch(undefined, '0.20.2')).toBe(false);
  });

  it('fails closed before module resolution when the runtime is below Node 22.12', async () => {
    let resolved = 0;
    let loaded = 0;
    setAgentDeviceTypedProviderHooksForTest({
      runtimeNodeVersion: () => '20.10.0',
      resolveModule: () => {
        resolved += 1;
        return fakeModulePath();
      },
      loadModule: async () => {
        loaded += 1;
        throw new Error('must not load');
      },
    });

    const identity = typedAgentDeviceIdentity();
    expect(identity).toMatchObject({
      kind: 'typed',
      available: false,
      runtimeVersion: '20.10.0',
      minimumRuntimeVersion: '22.12.0',
    });
    expect(identity.reason).toContain('requires Node >=22.12.0');
    expect(resolved).toBe(0);

    const provider = new TypedAgentDeviceReadProvider(identity);
    await expect(provider.snapshot({
      stateDir: '/tmp/state', session: 's', device: 'd', platform: 'ios', requestId: 'r', cwd: '/', timeoutMs: 100,
    }, {})).rejects.toMatchObject({ code: 'AGENT_DEVICE_TYPED_PROVIDER_UNAVAILABLE' });
    expect(loaded).toBe(0);
  });

  it('reports exact module identity and maps semantic snapshot options without argv', async () => {
    const resolvedModule = fakeModulePath();
    const calls: Array<{ config: Record<string, unknown>; options: Record<string, unknown> }> = [];
    setAgentDeviceTypedProviderHooksForTest({
      resolveModule: () => resolvedModule,
      loadModule: async () => ({
        createAgentDeviceClient: (config = {}) => ({
          capture: {
            snapshot: async (options) => {
              calls.push({ config, options });
              return {
                nodes: [{ ref: 'e39', type: 'SearchField', depth: 14 }],
                truncated: false,
                refsGeneration: 7,
                identifiers: {},
              };
            },
          },
        }),
      }),
    });

    const identity = typedAgentDeviceIdentity();
    expect(identity).toMatchObject({
      kind: 'typed',
      available: true,
      version: '0.20.2',
    });
    expect(identity.resolvedModule).toContain('dist/src/index.js');

    const provider = new TypedAgentDeviceReadProvider(identity);
    const result = await provider.snapshot({
      stateDir: '/tmp/repo-harness-agent-state',
      session: 'session-1',
      device: 'PHONE-UDID',
      platform: 'ios',
      requestId: 'request-1',
      cwd: '/repo',
      timeoutMs: 4_000,
    }, {
      interactiveOnly: false,
      raw: true,
      depth: 20,
      scope: '首页',
      forceFull: true,
    });

    expect(result).toMatchObject({ success: true, provider: 'typed' });
    expect(result.data.nodes).toHaveLength(1);
    expect(calls).toEqual([{
      config: {
        stateDir: '/tmp/repo-harness-agent-state',
        session: 'session-1',
        requestId: 'request-1',
        cwd: '/repo',
        cost: true,
        responseLevel: 'full',
      },
      options: {
        platform: 'ios',
        device: 'PHONE-UDID',
        session: 'session-1',
        requestId: 'request-1',
        interactiveOnly: false,
        raw: true,
        forceFull: true,
        depth: 20,
        scope: '首页',
        timeoutMs: 4_000,
        noRecord: true,
      },
    }]);
  });

  it('classifies a missing optional module separately from provider command failure', async () => {
    const resolvedModule = fakeModulePath();
    setAgentDeviceTypedProviderHooksForTest({
      resolveModule: () => resolvedModule,
      loadModule: async () => { throw new Error('module removed'); },
    });
    const unavailable = new TypedAgentDeviceReadProvider(typedAgentDeviceIdentity());
    await expect(unavailable.snapshot({
      stateDir: '/tmp/state', session: 's', device: 'd', platform: 'ios', requestId: 'r', cwd: '/', timeoutMs: 100,
    }, {})).rejects.toMatchObject({ code: 'AGENT_DEVICE_TYPED_PROVIDER_UNAVAILABLE' });

    setAgentDeviceTypedProviderHooksForTest({
      loadModule: async () => ({
        createAgentDeviceClient: () => ({
          capture: {
            snapshot: async () => {
              throw { code: 'RUNNER_DISCONNECTED', message: 'runner lost', retriable: true };
            },
          },
        }),
      }),
    });
    const failed = new TypedAgentDeviceReadProvider(typedAgentDeviceIdentity());
    await expect(failed.snapshot({
      stateDir: '/tmp/state', session: 's', device: 'd', platform: 'ios', requestId: 'r', cwd: '/', timeoutMs: 100,
    }, {})).rejects.toMatchObject({
      code: 'AGENT_DEVICE_TYPED_COMMAND_FAILED',
      details: { providerCode: 'RUNNER_DISCONNECTED', providerBackend: 'typed' },
    });
  });
});
