import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  executeIosAgentDeviceAction,
  resetIosAgentDeviceRuntimeHooksForTest,
  setIosAgentDeviceRuntimeHooksForTest,
} from '../../src/runtime/plugins/ios-agent-device';
import { writeInteractionSession } from '../../src/runtime/plugins/interaction-session';
import { resetIosDevelopmentHooksForTest, setIosDevelopmentHooksForTest } from '../../src/runtime/safe-tooling';

const roots: string[] = [];
const udid = '96EDA0C4-D3A9-407C-8692-BE28234C5F43';
const interactionId = 'ios_agent_device_multidisplay_screenshot';

afterEach(() => {
  resetIosAgentDeviceRuntimeHooksForTest();
  resetIosDevelopmentHooksForTest();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('iOS agent-device multi-display screenshot routing', () => {
  it('uses the existing display-addressed Simulator capture without invoking the ambiguous agent-device screenshot', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-agent-duo-repo-'));
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-agent-duo-controller-'));
    roots.push(repoRoot, controllerHome);
    const now = new Date('2026-11-12T14:00:00.000Z');

    writeInteractionSession(repoRoot, {
      schemaVersion: 1,
      interactionId,
      provider: 'ios-simulator',
      engine: 'agent-device',
      sessionId: 'forge-duo-test',
      targetId: udid,
      targetAliases: [udid],
      status: 'waiting_for_user',
      reason: 'ios_simulator_automation',
      instructions: 'com.example.medication',
      owner: { repoId: 'repo-duo-test', requestId: 'open-duo' },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 600_000).toISOString(),
    });

    const agentCalls: string[][] = [];
    const probe = (command: string, args: string[]) => {
      agentCalls.push(args);
      const stdout = args[0] === '--version' ? '0.19.3'
        : args[0] === 'help' ? 'agent-device <command> --json'
        : '';
      return { ok: true, status: 0, stdout, stderr: '', command: [command, ...args] };
    };
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => now,
      runCommand: probe,
      runCommandAsync: async (command, args) => probe(command, args),
    });

    const screenshots: string[][] = [];
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        screenshots.push([command, ...args]);
        const path = args.at(-1)!;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, Buffer.from('mock-png'));
        return { ok: true, status: 0, stdout: '', stderr: '', command: [command, ...args] };
      },
    });

    const captured = await executeIosAgentDeviceAction({
      controllerHome, repoId: 'repo-duo-test', repoRoot,
      pluginId: 'ios', actionId: 'agent_device_screenshot', requestId: 'capture-inner',
      args: { interaction_id: interactionId, display: 3, label: 'duo-inner' },
      origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(screenshots).toHaveLength(1);
    expect(screenshots[0]).toContain('--display=3');
    expect(screenshots[0]?.slice(0, 5)).toEqual(['xcrun', 'simctl', 'io', udid, 'screenshot']);
    expect(agentCalls.some((args) => args[0] === 'screenshot')).toBe(false);
    const artifacts = captured.artifactCandidates as Array<{ path: string }>;
    expect(artifacts).toHaveLength(1);
    expect(existsSync(artifacts[0]!.path)).toBe(true);

    await expect(executeIosAgentDeviceAction({
      controllerHome, repoId: 'repo-duo-test', repoRoot,
      pluginId: 'ios', actionId: 'agent_device_screenshot', requestId: 'reject-overlay',
      args: { interaction_id: interactionId, display: 3, overlay_refs: true },
      origin: { surface: 'local-ui', actor: 'test' },
    })).rejects.toMatchObject({ code: 'PLUGIN_ACTION_ARGUMENT_INVALID' });
    expect(screenshots).toHaveLength(1);
  });
});
