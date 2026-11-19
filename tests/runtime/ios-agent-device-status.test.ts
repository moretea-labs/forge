import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  executeIosAgentDeviceAction,
  iosAgentDeviceActions,
  resetIosAgentDeviceRuntimeHooksForTest,
  setIosAgentDeviceRuntimeHooksForTest,
} from '../../src/runtime/plugins/ios-agent-device';

const roots: string[] = [];

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-ios-agent-status-repo-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-ios-agent-status-controller-'));
  roots.push(repoRoot, controllerHome);
  return { repoRoot, controllerHome };
}

function statusInput(f: ReturnType<typeof fixture>) {
  return {
    controllerHome: f.controllerHome,
    repoId: 'repo-ios-status',
    repoRoot: f.repoRoot,
    pluginId: 'ios',
    actionId: 'agent_device_status',
    requestId: 'status-probe',
    args: {},
    origin: { surface: 'local-ui' as const, actor: 'test' },
  };
}

afterEach(() => {
  resetIosAgentDeviceRuntimeHooksForTest();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('iOS agent-device readiness probe', () => {
  it('uses the reviewed 0.19.3 profile without redundant help processes', async () => {
    const f = fixture();
    const calls: Array<{ args: string[]; timeoutMs?: number }> = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-11-17T09:00:00.000Z'),
      runCommandAsync: async (command, args, options) => {
        calls.push({ args: [...args], timeoutMs: options?.timeoutMs });
        return {
          ok: true, status: 0, stdout: args[0] === '--version' ? '0.19.3' : '', stderr: '',
          command: [command, ...args],
        };
      },
    });

    const status = await executeIosAgentDeviceAction(statusInput(f));

    expect(status.available).toBe(true);
    expect(status.capabilityProfile).toMatchObject({ version: '0.19.3', source: 'known-version', versionSupported: true });
    expect(calls).toEqual([{ args: ['--version'], timeoutMs: 8_000 }]);
    expect(iosAgentDeviceActions().find((action) => action.actionId === 'agent_device_status')?.defaultTimeoutMs).toBe(30_000);
  });

  it('still inspects help for supported versions without a reviewed fallback profile', async () => {
    const f = fixture();
    const calls: Array<{ args: string[]; timeoutMs?: number }> = [];
    const help: Record<string, string> = {
      help: 'agent-device snapshot press fill batch keyboard --cost',
      snapshot: 'agent-device snapshot -i --depth --scope --raw --force-full',
      press: 'agent-device press --settle',
      fill: 'agent-device fill --settle --delay-ms --verify',
      batch: 'agent-device batch --steps --on-error --max-steps',
      keyboard: 'agent-device keyboard return dismiss',
    };
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-11-17T09:00:00.000Z'),
      runCommandAsync: async (command, args, options) => {
        calls.push({ args: [...args], timeoutMs: options?.timeoutMs });
        const stdout = args[0] === '--version' ? '0.20.1' : help[args[1] ?? 'help'];
        return { ok: true, status: 0, stdout, stderr: '', command: [command, ...args] };
      },
    });

    const status = await executeIosAgentDeviceAction(statusInput(f));

    expect(status.available).toBe(true);
    expect(status.capabilityProfile).toMatchObject({ version: '0.20.1', source: 'help', versionSupported: true });
    expect(calls.map((call) => call.args.join(' '))).toEqual([
      '--version', 'help', 'help snapshot', 'help press', 'help fill', 'help batch', 'help keyboard',
    ]);
    expect(calls.map((call) => call.timeoutMs)).toEqual([8_000, 3_000, 3_000, 3_000, 3_000, 3_000, 3_000]);
  });
});
