import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  executeIosAgentDeviceAction,
  resetIosAgentDeviceRuntimeHooksForTest,
  setIosAgentDeviceRuntimeHooksForTest,
} from '../../src/runtime/plugins/ios-agent-device';
import { readInteractionSession, writeInteractionSession } from '../../src/runtime/plugins/interaction-session';

const roots: string[] = [];
const oldId = 'ios_agent_device_old_simulator';
const oldSession = 'forge-old-simulator-session';
const targetId = 'SIM-192';

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-ios-orphan-reclaim-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-ios-orphan-controller-'));
  roots.push(repoRoot, controllerHome);
  writeInteractionSession(repoRoot, {
    schemaVersion: 1,
    interactionId: oldId,
    provider: 'ios-simulator',
    engine: 'agent-device',
    sessionId: oldSession,
    targetId,
    targetAliases: [targetId],
    status: 'waiting_for_user',
    reason: 'ios_simulator_automation',
    instructions: 'com.example.medication',
    owner: { repoId: 'repo-ios-192', requestId: 'old-request' },
    createdAt: '2026-11-02T07:19:11.000Z',
    updatedAt: '2026-11-02T07:19:11.000Z',
    expiresAt: '2026-11-02T09:19:11.000Z',
  });
  return { repoRoot, controllerHome };
}

function installMock(sessions: unknown) {
  const calls: string[] = [];
  const runCommand = (command: string, args: string[]) => {
    calls.push(args[0] ?? '');
    const action = args[0];
    const data = action === '--version' ? '0.19.3'
      : action === 'devices' ? JSON.stringify({ success: true, data: { devices: [
        { platform: 'ios', id: targetId, name: 'OCR QA', kind: 'simulator', booted: true },
      ] } })
      : action === 'session' ? JSON.stringify({ success: true, data: { sessions } })
      : action === 'open' ? JSON.stringify({ success: true, data: { session: 'new-session' } })
      : action === 'close' ? JSON.stringify({ success: false, error: { code: 'SESSION_NOT_FOUND' } })
      : '';
    const ok = action !== 'help' && action !== 'close';
    return { ok, status: ok ? 0 : 1, stdout: data, stderr: '', command: [command, ...args] };
  };
  setIosAgentDeviceRuntimeHooksForTest({
    platform: () => 'darwin',
    now: () => new Date('2026-11-02T08:38:00.000Z'),
    runCommand,
    runCommandAsync: async (command, args) => runCommand(command, args),
  });
  return calls;
}

async function open(f: ReturnType<typeof fixture>) {
  return executeIosAgentDeviceAction({
    controllerHome: f.controllerHome, repoId: 'repo-ios-192', repoRoot: f.repoRoot,
    pluginId: 'ios', actionId: 'agent_device_open', requestId: 'open-new',
    args: { app: 'com.example.medication', device: 'OCR QA' },
    origin: { surface: 'local-ui', actor: 'test' },
  });
}

afterEach(() => {
  resetIosAgentDeviceRuntimeHooksForTest();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('iOS agent-device abandoned interaction recovery (Issue #192)', () => {
  it('reclaims an active Forge record when its scoped provider reports no sessions', async () => {
    const f = fixture();
    const calls = installMock([]);
    const result = await open(f);
    expect(readInteractionSession(f.repoRoot, 'ios-simulator', oldId)?.status).toBe('closed');
    expect((result.interaction as { status: string }).status).toBe('waiting_for_user');
    expect(calls).toContain('session');
    expect(calls).toContain('close');
    expect(calls).toContain('open');
  });

  it('never steals an existing provider session', async () => {
    const f = fixture();
    const calls = installMock([{ session: oldSession }]);
    await expect(open(f)).rejects.toMatchObject({ code: 'PLUGIN_RESOURCE_BUSY' });
    expect(readInteractionSession(f.repoRoot, 'ios-simulator', oldId)?.status).toBe('waiting_for_user');
    expect(calls).not.toContain('close');
    expect(calls).not.toContain('open');
  });

  it('fails closed when provider session inventory is malformed', async () => {
    const f = fixture();
    const calls = installMock('unavailable');
    await expect(open(f)).rejects.toMatchObject({ code: 'PLUGIN_RESOURCE_BUSY' });
    expect(readInteractionSession(f.repoRoot, 'ios-simulator', oldId)?.status).toBe('waiting_for_user');
    expect(calls).not.toContain('close');
  });
});
