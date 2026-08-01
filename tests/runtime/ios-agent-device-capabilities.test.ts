import { describe, expect, it } from 'bun:test';
import {
  appendSettleFlag,
  compileBatchCommand,
  compileSnapshotCommand,
  detectAgentDeviceCapabilities,
  isSupportedAgentDeviceVersion,
} from '../../src/runtime/plugins/ios/agent-device-capabilities';
import { findSemanticRef, JD_IOS_APP_ADAPTER, normalizedSemanticRef } from '../../src/runtime/plugins/ios/app-adapters';
import jdHome from '../fixtures/ios/jd-home-depth20.json';

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

describe('iOS semantic App adapters', () => {
  it('finds deeply nested JD controls from structured nodes and normalizes provider refs', () => {
    expect(normalizedSemanticRef('e39')).toBe('@e39');
    expect(normalizedSemanticRef('@e41~s701912')).toBe('@e41~s701912');
    expect(findSemanticRef(jdHome, JD_IOS_APP_ADAPTER.search!.isSearchField)).toBe('@e39');
    expect(findSemanticRef(jdHome, JD_IOS_APP_ADAPTER.search!.isSubmit)).toBe('@e41');
    expect(JD_IOS_APP_ADAPTER.search!.discovery).toEqual({ interactiveOnly: false, raw: true, depth: 20 });
  });
});
