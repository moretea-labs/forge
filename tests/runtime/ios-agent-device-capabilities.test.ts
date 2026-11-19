import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeIosAgentDeviceAction, iosAgentDeviceActions, resetIosAgentDeviceRuntimeHooksForTest, setIosAgentDeviceRuntimeHooksForTest } from '../../src/runtime/plugins/ios-agent-device';
import { readInteractionSession, writeInteractionSession } from '../../src/runtime/plugins/interaction-session';
import {
  appendSettleFlag,
  compileBatchCommand,
  compileSnapshotCommand,
  detectAgentDeviceCapabilities,
  isSupportedAgentDeviceVersion,
} from '../../src/runtime/plugins/ios/agent-device-capabilities';
import { findSemanticRef, JD_IOS_APP_ADAPTER, normalizedSemanticRef } from '../../src/runtime/plugins/ios/app-adapters';
import jdHome from '../fixtures/ios/jd-home-depth20.json';

const swipeTestRoots: string[] = [];
afterEach(() => {
  resetIosAgentDeviceRuntimeHooksForTest();
  for (const root of swipeTestRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const help = {
  root: 'agent-device <command> [--cost] [--json]',
  snapshot: `agent-device snapshot [--diff] [-i] [-d <depth>] [-s <scope>] [--raw] [--force-full] [--timeout <ms>]
Command flags:
  -i Snapshot: interactive elements only
  --depth, -d <depth>
  --scope, -s <scope>
  --raw
  --force-full`,
  press: `agent-device press <@ref|selector|x y>\n  --settle`,
  fill: `agent-device fill <x> <y> <text> | fill <@ref|selector> <text>
  --delay-ms <ms>
  --verify
  --settle`,
  batch: `agent-device batch [--steps <json> | --steps-file <path>]
  --steps <json>
  --on-error stop
  --max-steps <n>`,
  keyboard: `agent-device keyboard [status|get|dismiss|enter|return]`,
};

describe('agent-device capability contract', () => {
  it('compiles only flags proven by the installed help contract', () => {
    const profile = detectAgentDeviceCapabilities('0.20.2', help);
    expect(profile.versionSupported).toBe(true);
    expect(profile.source).toBe('help');
    expect(profile.contractFingerprint).toHaveLength(64);
    const snapshot = compileSnapshotCommand(profile, {
      interactiveOnly: true,
      raw: true,
      depth: 20,
      scope: '搜索结果',
      forceFull: true,
    });
    expect(snapshot).toEqual([
      'snapshot', '-i', '--raw', '--depth', '20', '--scope', '搜索结果', '--force-full',
    ]);
    expect(snapshot).not.toContain('--interactive');
    expect(appendSettleFlag(profile, ['fill', '@e39', '<redacted>'])).toContain('--settle');
    expect(appendSettleFlag(profile, ['press', '@e41'], 'press')).toContain('--settle');
    expect(compileBatchCommand(profile, [{ command: 'press', input: { target: { kind: 'ref', ref: 'e41' } } }], 20))
      .toEqual(expect.arrayContaining(['batch', '--steps', '--on-error', 'stop', '--max-steps', '20']));
    expect(compileBatchCommand(profile, [], 20, { includeCost: true })).toContain('--cost');
  });

  it('fails closed when help does not prove an optional flag', () => {
    const profile = detectAgentDeviceCapabilities('0.20.2', {
      ...help,
      root: 'agent-device <command>',
      snapshot: 'agent-device snapshot [--raw]',
    });
    expect(() => compileSnapshotCommand(profile, { interactiveOnly: true })).toThrow('interactive mode is unsupported');
    expect(compileBatchCommand(profile, [], 20, { includeCost: true })).not.toContain('--cost');
  });

  it('accepts reviewed fallbacks but rejects unknown future pre-1.0 versions without help', () => {
    expect(detectAgentDeviceCapabilities('0.19.3').versionSupported).toBe(true);
    expect(detectAgentDeviceCapabilities('0.20.3').versionSupported).toBe(true);
    expect(detectAgentDeviceCapabilities('0.20.0').versionSupported).toBe(false);
    expect(detectAgentDeviceCapabilities('0.21.0').versionSupported).toBe(false);
    expect(isSupportedAgentDeviceVersion('0.20.0')).toBe(true);
    expect(isSupportedAgentDeviceVersion('0.21.0')).toBe(false);
  });
});

describe('agent-device multi-display screenshot contract', () => {
  it('exposes an explicit simulator display selector while retaining the original optional capture arguments', () => {
    const screenshot = iosAgentDeviceActions().find((action) => action.actionId === 'agent_device_screenshot');
    expect(screenshot).toBeDefined();
    const properties = screenshot?.argumentsSchema?.properties as Record<string, unknown>;
    expect(properties.display).toEqual({ type: 'number', minimum: 0, maximum: 16 });
    expect(properties).toHaveProperty('overlay_refs');
    expect(properties).toHaveProperty('max_size');
  });
});

describe('agent-device coordinate swipe contract', () => {
  it('dispatches explicit content-area coordinates through the owned session', async () => {
    const swipe = iosAgentDeviceActions().find((action) => action.actionId === 'agent_device_swipe');
    expect(swipe).toMatchObject({ readOnly: false, risk: 'workspace_write', idempotent: false });
    const schema = swipe?.argumentsSchema as { required?: string[] };
    expect(schema.required).toEqual(['interaction_id', 'x1', 'y1', 'x2', 'y2']);
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-ios-swipe-repo-'));
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-ios-swipe-home-'));
    swipeTestRoots.push(repoRoot, controllerHome);
    const now = new Date('2026-11-18T08:00:00Z'), interactionId = 'ios_agent_device_coordinate_swipe';
    const targetId = '96EDA0C4-D3A9-407C-8692-BE28234C5F43';
    writeInteractionSession(repoRoot, { schemaVersion: 1, interactionId, provider: 'ios-simulator', engine: 'agent-device',
      sessionId: 'forge-swipe-test', targetId, targetAliases: [targetId], status: 'waiting_for_user',
      reason: 'ios_simulator_automation', instructions: 'com.example.test', owner: { repoId: 'repo-ios-swipe-test', requestId: 'open' },
      createdAt: now.toISOString(), updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString() });
    const calls: string[][] = [];
    const probe = (command: string, args: string[]) => {
      calls.push(args);
      const stdout = args[0] === '--version' ? '0.20.2' : args[0] === 'gesture' ? '{"success":true}' : 'agent-device <command> --json';
      return { ok: true, status: 0, stdout, stderr: '', command: [command, ...args] };
    };
    setIosAgentDeviceRuntimeHooksForTest({ platform: () => 'darwin', now: () => now, runCommand: probe,
      runCommandAsync: async (command, args) => probe(command, args) });
    const executeSwipe = (requestId: string, args: Record<string, unknown>) => executeIosAgentDeviceAction({
      controllerHome, repoId: 'repo-ios-swipe-test', repoRoot, pluginId: 'ios', actionId: 'agent_device_swipe', requestId,
      args: { interaction_id: interactionId, ...args }, origin: { surface: 'local-ui', actor: 'test' },
    });
    await executeSwipe('content-swipe', { x1: 200, y1: 650, x2: 200, y2: 220, duration_ms: 280 });
    expect(calls.find((args) => args[0] === 'gesture')).toEqual([
      'gesture', 'pan', '200', '650', '0', '-430', '280', '--session', 'forge-swipe-test', '--platform', 'ios', '--json',
    ]);
    await executeSwipe('content-swipe-default', { x1: 200, y1: 650, x2: 200, y2: 220 });
    expect(calls.filter((args) => args[0] === 'gesture')[1]).toEqual([
      'gesture', 'pan', '200', '650', '0', '-430', '--session', 'forge-swipe-test', '--platform', 'ios', '--json',
    ]);
    await expect(executeSwipe('invalid-swipe', { x1: -1, y1: 650, x2: 200, y2: 220 }))
      .rejects.toMatchObject({ code: 'PLUGIN_ACTION_ARGUMENT_INVALID' });
    expect(calls.filter((args) => args[0] === 'gesture')).toHaveLength(2);
  });

  it('fences an ambiguous coordinate pan timeout and blocks later mutations', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-ios-swipe-unknown-repo-'));
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-ios-swipe-unknown-home-'));
    swipeTestRoots.push(repoRoot, controllerHome);
    const now = new Date('2026-11-18T08:00:00Z');
    const interactionId = 'ios_agent_device_coordinate_swipe_unknown';
    const targetId = '96EDA0C4-D3A9-407C-8692-BE28234C5F43';
    writeInteractionSession(repoRoot, {
      schemaVersion: 1, interactionId, provider: 'ios-simulator', engine: 'agent-device',
      sessionId: 'forge-swipe-unknown-test', targetId, targetAliases: [targetId], status: 'waiting_for_user',
      reason: 'ios_simulator_automation', instructions: 'com.example.test',
      owner: { repoId: 'repo-ios-swipe-test', requestId: 'open' },
      createdAt: now.toISOString(), updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString(),
    });
    const calls: string[][] = [];
    const probe = (command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'gesture') {
        return { ok: false, status: 1, stdout: '', stderr: 'command timed out after dispatch', command: [command, ...args], timedOut: true };
      }
      return { ok: true, status: 0, stdout: args[0] === '--version' ? '0.20.2' : 'agent-device <command> --json', stderr: '', command: [command, ...args] };
    };
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin', now: () => now, runCommand: probe,
      runCommandAsync: async (command, args) => probe(command, args),
    });
    const execute = (actionId: string, requestId: string, args: Record<string, unknown>) => executeIosAgentDeviceAction({
      controllerHome, repoId: 'repo-ios-swipe-test', repoRoot, pluginId: 'ios', actionId, requestId,
      args: { interaction_id: interactionId, ...args }, origin: { surface: 'local-ui', actor: 'test' },
    });

    await expect(execute('agent_device_swipe', 'ambiguous-pan', { x1: 200, y1: 650, x2: 200, y2: 220 }))
      .rejects.toMatchObject({ code: 'AGENT_DEVICE_OUTCOME_UNKNOWN' });
    expect(readInteractionSession(repoRoot, 'ios-simulator', interactionId)).toMatchObject({
      status: 'unknown', error: { code: 'AGENT_DEVICE_OUTCOME_UNKNOWN' },
    });
    const callsAfterPan = calls.length;
    await expect(execute('agent_device_scroll', 'after-unknown', { direction: 'down' }))
      .rejects.toMatchObject({ code: 'AGENT_DEVICE_OUTCOME_UNKNOWN' });
    expect(calls).toHaveLength(callsAfterPan);
    expect(calls.some((args) => args[0] === 'gesture')).toBe(true);
    expect(calls.some((args) => args[0] === 'scroll')).toBe(false);
  });
});

describe('iOS semantic App adapters', () => {
  it('finds deeply nested JD controls from structured nodes and normalizes provider refs', () => {
    expect(normalizedSemanticRef('e39')).toBe('@e39');
    expect(normalizedSemanticRef('@e41~s701912')).toBe('@e41~s701912');
    expect(findSemanticRef(jdHome, JD_IOS_APP_ADAPTER.search!.isSearchField)).toBe('@e39');
    expect(findSemanticRef(jdHome, JD_IOS_APP_ADAPTER.search!.isSubmit)).toBe('@e41');
    expect(JD_IOS_APP_ADAPTER.search!.discovery).toEqual({ interactiveOnly: false, raw: true, depth: 20 });
  });
});
