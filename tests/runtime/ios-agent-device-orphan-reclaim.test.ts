import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  executeIosAgentDeviceAction,
  resetIosAgentDeviceRuntimeHooksForTest,
  setIosAgentDeviceRuntimeHooksForTest,
} from '../../src/runtime/plugins/ios-agent-device';
import { patchInteractionSession, readInteractionSession, writeInteractionSession } from '../../src/runtime/plugins/interaction-session';
import { acquireExecutionLeases, listActiveLeases, releaseExecutionLeases } from '../../src/runtime/resources/leases/store';

const roots: string[] = [];
const oldId = 'ios_agent_device_old_simulator';
const oldSession = 'forge-old-simulator-session';
const targetId = '96EDA0C4-D3A9-407C-8692-BE28234C5F43';
const simulatorResource = 'host-service:ios-simulator-test:udid:' + targetId;
const otherResource = 'host-service:ios-simulator-test:udid:633B2CBC-B2A5-4DAD-A9AE-BC3B1E883A9A';

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

function installMock(
  sessions: unknown,
  closeResponse: 'already_absent' | 'success' = 'already_absent',
  now = new Date('2026-11-02T08:38:00.000Z'),
  onAction?: (action: string) => void,
) {
  const calls: string[] = [];
  const runCommand = (command: string, args: string[]) => {
    const action = args[0] ?? '';
    calls.push(action);
    onAction?.(action);
    const data = action === '--version' ? '0.19.3'
      : action === 'devices' ? JSON.stringify({ success: true, data: { devices: [
        { platform: 'ios', id: targetId, name: 'OCR QA', kind: 'simulator', booted: true },
      ] } })
      : action === 'session' ? JSON.stringify({ success: true, data: { sessions } })
      : action === 'open' ? JSON.stringify({ success: true, data: { session: 'new-session' } })
      : action === 'events' ? JSON.stringify({ success: true, data: { events: [] } })
      : action === 'close' ? (closeResponse === 'success'
        ? JSON.stringify({ success: true, data: { closed: true } })
        : JSON.stringify({ success: false, error: { code: 'SESSION_NOT_FOUND' } }))
      : '';
    const ok = action !== 'help' && (action !== 'close' || closeResponse === 'success');
    return { ok, status: ok ? 0 : 1, stdout: data, stderr: '', command: [command, ...args] };
  };
  setIosAgentDeviceRuntimeHooksForTest({
    platform: () => 'darwin',
    now: () => now,
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
  it('reports one scoped active Simulator owner without mutating the provider or leaking app instructions', async () => {
    const f = fixture();
    const calls = installMock([{ session: oldSession }]);
    const status = () => executeIosAgentDeviceAction({
      controllerHome: f.controllerHome, repoId: 'repo-ios-192', repoRoot: f.repoRoot,
      pluginId: 'ios', actionId: 'agent_device_status', requestId: 'observe-owner',
      args: {}, origin: { surface: 'local-ui', actor: 'test' },
    });
    const observed = await status();
    expect(observed.activeInteractions).toEqual([{
      interactionId: oldId, provider: 'ios-simulator', targetId,
      status: 'waiting_for_user', owner: { repoId: 'repo-ios-192' },
      expiresAt: '2026-11-02T09:19:11.000Z',
    }]);
    expect(JSON.stringify(observed.activeInteractions)).not.toContain('com.example.medication');
    expect(calls).not.toContain('session');
    expect(calls).not.toContain('close');
    expect(calls).not.toContain('open');

    patchInteractionSession(f.repoRoot, 'ios-simulator', oldId, { status: 'closed' });
    expect((await status()).activeInteractions).toEqual([]);
  });

  it('releases scoped Simulator occupancy while waiting for user and retains it through an unverified close (#192)', async () => {
    const f = fixture();
    patchInteractionSession(f.repoRoot, 'ios-simulator', oldId, { status: 'closed' });
    const calls = installMock([]);
    const claim = [{ resourceKey: simulatorResource, mode: 'write' as const }];

    // Reverse ordering: a running XCTest/Simulator owner prevents AgentDevice
    // from starting its provider session. No second ownership path is consulted.
    expect(acquireExecutionLeases(
      f.controllerHome, 'repo-other-xctest', 'xctest-before-agent', claim, { visibility: 'ephemeral' },
    ).acquired).toBe(true);
    await expect(open(f)).rejects.toMatchObject({ code: 'PLUGIN_RESOURCE_BUSY' });
    expect(calls).not.toContain('open');
    releaseExecutionLeases(f.controllerHome, 'repo-other-xctest', 'xctest-before-agent');

    // The provider-open command owns the scoped UDID only while it is running.
    const opened = await open(f);
    const interactionId = (opened.interaction as { interactionId: string }).interactionId;
    expect((opened.interaction as { status: string }).status).toBe('waiting_for_user');
    expect((opened.interaction as { expiresAt: string }).expiresAt).toBe('2026-11-02T08:48:00.000Z');
    expect(listActiveLeases(f.controllerHome, 'repo-ios-192')
      .filter((lease) => lease.resourceKey === simulatorResource)).toEqual([]);
    // Device B does not wait for AgentDevice/XCTest on device A.
    const separate = acquireExecutionLeases(
      f.controllerHome, 'repo-other-xctest', 'independent-device', [{
        resourceKey: otherResource, mode: 'write',
      }], { visibility: 'ephemeral' },
    );
    expect(separate.acquired).toBe(true);
    releaseExecutionLeases(f.controllerHome, 'repo-other-xctest', 'independent-device');
    // A waiting interaction leaves the legacy host-wide resource available.
    const legacy = acquireExecutionLeases(
      f.controllerHome, 'repo-legacy-xctest', 'legacy-fence', [{
        resourceKey: 'host-service:ios-simulator-test', mode: 'write',
      }], { visibility: 'ephemeral' },
    );
    expect(legacy.acquired).toBe(true);
    releaseExecutionLeases(f.controllerHome, 'repo-legacy-xctest', 'legacy-fence');


    // A waiting_for_user interaction is idle and does not fence another XCTest.
    const blocked = acquireExecutionLeases(
      f.controllerHome, 'repo-other-xctest', 'xctest-after-agent', claim, { visibility: 'ephemeral' },
    );
    expect(blocked.acquired).toBe(true);
    releaseExecutionLeases(f.controllerHome, 'repo-other-xctest', 'xctest-after-agent');

    // A provider close acknowledgement alone is insufficient: if its scoped
    // session inventory still contains this exact session, keep the lease fenced.
    const sessionId = (opened.interaction as { sessionId: string }).sessionId;
    const closeLeaseCounts: number[] = [];
    installMock([{ session: sessionId }], 'success', undefined, (action) => {
      if (action === 'close' || action === 'session') {
        closeLeaseCounts.push(listActiveLeases(f.controllerHome, 'repo-ios-192')
          .filter((lease) => lease.resourceKey === simulatorResource).length);
      }
    });
    await expect(executeIosAgentDeviceAction({
      controllerHome: f.controllerHome, repoId: 'repo-ios-192', repoRoot: f.repoRoot,
      pluginId: 'ios', actionId: 'agent_device_close', requestId: 'close-new-unverified',
      args: { interaction_id: interactionId },
      origin: { surface: 'local-ui', actor: 'test' },
    })).rejects.toMatchObject({ code: 'AGENT_DEVICE_CLEANUP_UNVERIFIED' });
    expect(closeLeaseCounts).toEqual([1, 1]);
    expect(listActiveLeases(f.controllerHome, 'repo-ios-192')
      .filter((lease) => lease.resourceKey === simulatorResource)).toHaveLength(1);

    // Provider-confirmed terminal close releases the exact lifetime owner.
    installMock([], 'already_absent');
    const closed = await executeIosAgentDeviceAction({
      controllerHome: f.controllerHome, repoId: 'repo-ios-192', repoRoot: f.repoRoot,
      pluginId: 'ios', actionId: 'agent_device_close', requestId: 'close-new-confirmed',
      args: { interaction_id: interactionId },
      origin: { surface: 'local-ui', actor: 'test' },
    });
    expect((closed.interaction as { status: string }).status).toBe('closed');
    expect(listActiveLeases(f.controllerHome, 'repo-ios-192')
      .filter((lease) => lease.resourceKey === simulatorResource)).toEqual([]);

    expect(acquireExecutionLeases(
      f.controllerHome, 'repo-other-xctest', 'xctest-after-close', claim, { visibility: 'ephemeral' },
    ).acquired).toBe(true);
    releaseExecutionLeases(f.controllerHome, 'repo-other-xctest', 'xctest-after-close');
  });

  it('holds a scoped Simulator lease only while an AgentDevice command is running', async () => {
    const f = fixture();
    patchInteractionSession(f.repoRoot, 'ios-simulator', oldId, { status: 'closed' });
    let interactionId = '';
    let openLeaseCount = 0;
    let commandLeaseCount = 0;
    let sameDeviceBlocked = false;
    let differentDeviceAcquired = false;
    let legacyBlocked = false;
    const calls = installMock([], 'already_absent', new Date('2026-11-02T08:38:00.000Z'), (action) => {
      if (action === 'open') {
        openLeaseCount = listActiveLeases(f.controllerHome, 'repo-ios-192')
          .filter((lease) => lease.resourceKey === simulatorResource).length;
      }
      if (action === 'events') {
        commandLeaseCount = listActiveLeases(f.controllerHome, 'repo-ios-192')
          .filter((lease) => lease.ownerJobId === 'ios-agent-device:' + interactionId).length;
        const same = acquireExecutionLeases(
          f.controllerHome, 'repo-other-xctest', 'same-udid-during-command',
          [{ resourceKey: simulatorResource, mode: 'write' }], { visibility: 'ephemeral' },
        );
        sameDeviceBlocked = !same.acquired;
        if (same.acquired) releaseExecutionLeases(f.controllerHome, 'repo-other-xctest', 'same-udid-during-command');
        const different = acquireExecutionLeases(
          f.controllerHome, 'repo-other-xctest', 'different-udid-during-command',
          [{ resourceKey: otherResource, mode: 'write' }], { visibility: 'ephemeral' },
        );
        differentDeviceAcquired = different.acquired;
        if (different.acquired) releaseExecutionLeases(f.controllerHome, 'repo-other-xctest', 'different-udid-during-command');
        const legacy = acquireExecutionLeases(
          f.controllerHome, 'repo-other-xctest', 'legacy-global-during-command',
          [{ resourceKey: 'host-service:ios-simulator-test', mode: 'write' }], { visibility: 'ephemeral' },
        );
        legacyBlocked = !legacy.acquired;
        if (legacy.acquired) releaseExecutionLeases(f.controllerHome, 'repo-other-xctest', 'legacy-global-during-command');
      }
    });
    const opened = await open(f);
    interactionId = (opened.interaction as { interactionId: string }).interactionId;
    expect(openLeaseCount).toBe(1);
    expect(listActiveLeases(f.controllerHome, 'repo-ios-192')).toEqual([]);

    await executeIosAgentDeviceAction({
      controllerHome: f.controllerHome, repoId: 'repo-ios-192', repoRoot: f.repoRoot,
      pluginId: 'ios', actionId: 'agent_device_events', requestId: 'scoped-command-lease',
      args: { interaction_id: interactionId },
      origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(calls).toContain('events');
    expect(commandLeaseCount).toBe(1);
    expect(sameDeviceBlocked).toBe(true);
    expect(differentDeviceAcquired).toBe(true);
    expect(legacyBlocked).toBe(true);
    expect(listActiveLeases(f.controllerHome, 'repo-ios-192')).toEqual([]);
  });

  it('renews an in-flight legacy global Simulator lease without minting a second device owner', async () => {
    const f = fixture();
    installMock([], 'already_absent');
    const legacyResource = 'host-service:ios-simulator-test';
    expect(acquireExecutionLeases(
      f.controllerHome, 'repo-ios-192', 'ios-agent-device:' + oldId, [
        { resourceKey: legacyResource, mode: 'write' },
      ], { visibility: 'durable' },
    ).acquired).toBe(true);

    await executeIosAgentDeviceAction({
      controllerHome: f.controllerHome, repoId: 'repo-ios-192', repoRoot: f.repoRoot,
      pluginId: 'ios', actionId: 'agent_device_events', requestId: 'legacy-session-renew',
      args: { interaction_id: oldId },
      origin: { surface: 'local-ui', actor: 'test' },
    });
    const held = listActiveLeases(f.controllerHome, 'repo-ios-192')
      .filter((lease) => lease.ownerJobId === 'ios-agent-device:' + oldId);
    expect(held).toHaveLength(1);
    expect(held[0]?.resourceKey).toBe(legacyResource);
    expect(acquireExecutionLeases(
      f.controllerHome, 'repo-other-xctest', 'cannot-pass-old-global', [
        { resourceKey: otherResource, mode: 'write' },
      ], { visibility: 'ephemeral' },
    ).acquired).toBe(false);
    releaseExecutionLeases(f.controllerHome, 'repo-ios-192', 'ios-agent-device:' + oldId);
  });

  it('extends the interaction TTL only on real session activity, never on status polling', async () => {
    const f = fixture();
    patchInteractionSession(f.repoRoot, 'ios-simulator', oldId, { status: 'closed' });
    installMock([], 'already_absent', new Date('2026-11-02T08:38:00.000Z'));
    const opened = await open(f);
    const interactionId = (opened.interaction as { interactionId: string }).interactionId;
    const ownerJobId = `ios-agent-device:${interactionId}`;
    expect((opened.interaction as { expiresAt: string }).expiresAt).toBe('2026-11-02T08:48:00.000Z');
    expect(listActiveLeases(f.controllerHome, 'repo-ios-192')
      .filter((lease) => lease.ownerJobId === ownerJobId)).toEqual([]);

    // Read-only status must not silently extend resource ownership.
    installMock([], 'already_absent', new Date('2026-11-02T08:43:00.000Z'));
    await executeIosAgentDeviceAction({
      controllerHome: f.controllerHome, repoId: 'repo-ios-192', repoRoot: f.repoRoot,
      pluginId: 'ios', actionId: 'agent_device_status', requestId: 'status-no-heartbeat',
      args: {}, origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(readInteractionSession(f.repoRoot, 'ios-simulator', interactionId)?.expiresAt)
      .toBe('2026-11-02T08:48:00.000Z');
    expect(listActiveLeases(f.controllerHome, 'repo-ios-192')
      .filter((lease) => lease.ownerJobId === ownerJobId)).toEqual([]);

    // Real provider activity extends the interaction TTL and uses a scoped
    // lease only for the duration of the command.
    await executeIosAgentDeviceAction({
      controllerHome: f.controllerHome, repoId: 'repo-ios-192', repoRoot: f.repoRoot,
      pluginId: 'ios', actionId: 'agent_device_events', requestId: 'activity-renews-owner',
      args: { interaction_id: interactionId }, origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(readInteractionSession(f.repoRoot, 'ios-simulator', interactionId)?.expiresAt)
      .toBe('2026-11-02T08:53:00.000Z');
    expect(listActiveLeases(f.controllerHome, 'repo-ios-192')
      .filter((lease) => lease.ownerJobId === ownerJobId)).toEqual([]);
  });

  it('allows cross-repository XCTest admission immediately while waiting for user', async () => {
    const f = fixture();
    patchInteractionSession(f.repoRoot, 'ios-simulator', oldId, { status: 'closed' });
    installMock([], 'already_absent');
    const opened = await open(f);
    const interactionId = (opened.interaction as { interactionId: string }).interactionId;
    expect((opened.interaction as { status: string }).status).toBe('waiting_for_user');
    expect(listActiveLeases(f.controllerHome, 'repo-ios-192')
      .filter((lease) => lease.ownerJobId === 'ios-agent-device:' + interactionId)).toEqual([]);

    const claim = [{ resourceKey: simulatorResource, mode: 'write' as const }];
    const admission = acquireExecutionLeases(
      f.controllerHome, 'repo-other-xctest', 'xctest-while-waiting-for-user', claim,
      { visibility: 'ephemeral' },
    );
    expect(admission.acquired).toBe(true);
    releaseExecutionLeases(f.controllerHome, 'repo-other-xctest', 'xctest-while-waiting-for-user');
  });

  it('keeps the scoped Simulator lease through a queued command after the prior command goes idle', async () => {
    const f = fixture();
    patchInteractionSession(f.repoRoot, 'ios-simulator', oldId, { status: 'closed' });
    let interactionId = '';
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
    const leaseCountsAtProvider: number[] = [];
    let eventsCalls = 0;
    const scopedLeases = () => listActiveLeases(f.controllerHome, 'repo-ios-192')
      .filter((lease) => lease.ownerJobId === 'ios-agent-device:' + interactionId
        && lease.resourceKey === simulatorResource).length;

    const runCommand = (command: string, args: string[]) => {
      const action = args[0] ?? '';
      const data = action === '--version' ? '0.19.3'
        : action === 'devices' ? JSON.stringify({ success: true, data: { devices: [
          { platform: 'ios', id: targetId, name: 'OCR QA', kind: 'simulator', booted: true },
        ] } })
        : action === 'open' ? JSON.stringify({ success: true, data: { session: 'new-session' } })
        : action === 'events' ? JSON.stringify({ success: true, data: { events: [] } })
        : '';
      const ok = ['--version', 'devices', 'open', 'events'].includes(action);
      return { ok, status: ok ? 0 : 1, stdout: data, stderr: '', command: [command, ...args] };
    };
    const runCommandAsync = async (command: string, args: string[]) => {
      if ((args[0] ?? '') !== 'events') return runCommand(command, args);
      eventsCalls += 1;
      leaseCountsAtProvider.push(scopedLeases());
      if (eventsCalls === 1) {
        firstStarted();
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      return runCommand(command, args);
    };
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-11-02T08:38:00.000Z'),
      runCommand,
      runCommandAsync,
    });

    const opened = await open(f);
    interactionId = (opened.interaction as { interactionId: string }).interactionId;
    const events = (requestId: string) => executeIosAgentDeviceAction({
      controllerHome: f.controllerHome, repoId: 'repo-ios-192', repoRoot: f.repoRoot,
      pluginId: 'ios', actionId: 'agent_device_events', requestId,
      args: { interaction_id: interactionId },
      origin: { surface: 'local-ui', actor: 'test' },
    });

    const first = events('queued-lease-first');
    await firstStartedPromise;
    const second = events('queued-lease-second');
    // Let the second command enter the interaction queue before the first
    // provider call finishes and the interaction becomes idle again.
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseFirst();
    await first;
    await second;

    expect(eventsCalls).toBe(2);
    expect(leaseCountsAtProvider).toEqual([1, 1]);
    expect(scopedLeases()).toBe(0);
  });

  it('does not close an expired waiting session while another XCTest owns its UDID', async () => {
    const f = fixture();
    const calls = installMock([{ session: oldSession }], 'success', new Date('2026-11-02T10:38:00.000Z'));
    const owner = acquireExecutionLeases(
      f.controllerHome, 'repo-other-xctest', 'active-xctest-during-expiry',
      [{ resourceKey: simulatorResource, mode: 'write' }], { visibility: 'ephemeral' },
    );
    expect(owner.acquired).toBe(true);

    await expect(executeIosAgentDeviceAction({
      controllerHome: f.controllerHome, repoId: 'repo-ios-192', repoRoot: f.repoRoot,
      pluginId: 'ios', actionId: 'agent_device_events', requestId: 'expired-session-protected',
      args: { interaction_id: oldId },
      origin: { surface: 'local-ui', actor: 'test' },
    })).rejects.toMatchObject({ code: 'PLUGIN_RESOURCE_BUSY' });
    expect(calls).not.toContain('close');
    expect(readInteractionSession(f.repoRoot, 'ios-simulator', oldId)?.status).toBe('waiting_for_user');
    expect(listActiveLeases(f.controllerHome, 'repo-other-xctest')).toHaveLength(1);
    releaseExecutionLeases(f.controllerHome, 'repo-other-xctest', 'active-xctest-during-expiry');
  });

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

  it('does not claim close succeeded while the provider still owns the Simulator session', async () => {
    const f = fixture();
    const calls = installMock([{ session: oldSession }], 'success');
    const close = () => executeIosAgentDeviceAction({
      controllerHome: f.controllerHome, repoId: 'repo-ios-192', repoRoot: f.repoRoot,
      pluginId: 'ios', actionId: 'agent_device_close', requestId: 'close-old',
      args: { interaction_id: oldId },
      origin: { surface: 'local-ui', actor: 'test' },
    });
    await expect(close()).rejects.toMatchObject({ code: 'AGENT_DEVICE_CLEANUP_UNVERIFIED' });
    expect(readInteractionSession(f.repoRoot, 'ios-simulator', oldId)?.status).toBe('closing');
    expect(listActiveLeases(f.controllerHome, 'repo-ios-192')
      .filter((lease) => lease.resourceKey === simulatorResource)).toHaveLength(1);
    expect(calls).toContain('close');
    expect(calls).toContain('session');
    await expect(open(f)).rejects.toMatchObject({ code: 'PLUGIN_RESOURCE_BUSY' });
    expect(calls).not.toContain('open');

    // Once the scoped provider can prove absence, retrying the same close
    // settles this exact interaction rather than creating a second owner.
    installMock([], 'success');
    const retried = await close();
    expect((retried.interaction as { status: string }).status).toBe('closed');
    expect(readInteractionSession(f.repoRoot, 'ios-simulator', oldId)?.status).toBe('closed');
    expect(listActiveLeases(f.controllerHome, 'repo-ios-192')).toEqual([]);
  });

  it('retains ownership when an expired interaction has an unconfirmed successful close', async () => {
    const f = fixture();
    installMock([{ session: oldSession }], 'success', new Date('2026-11-02T10:38:00.000Z'));
    await expect(open(f)).rejects.toMatchObject({ code: 'PLUGIN_RESOURCE_BUSY' });
    expect(readInteractionSession(f.repoRoot, 'ios-simulator', oldId)).toMatchObject({
      status: 'closing', error: { code: 'AGENT_DEVICE_CLEANUP_FAILED' },
    });
    expect(listActiveLeases(f.controllerHome, 'repo-ios-192')
      .filter((lease) => lease.resourceKey === simulatorResource)).toHaveLength(1);
  });

  it('fails closed when the provider claims close success but inventory is malformed', async () => {
    const f = fixture();
    installMock('unavailable', 'success');
    await expect(executeIosAgentDeviceAction({
      controllerHome: f.controllerHome, repoId: 'repo-ios-192', repoRoot: f.repoRoot,
      pluginId: 'ios', actionId: 'agent_device_close', requestId: 'close-malformed',
      args: { interaction_id: oldId },
      origin: { surface: 'local-ui', actor: 'test' },
    })).rejects.toMatchObject({ code: 'AGENT_DEVICE_CLEANUP_UNVERIFIED' });
    expect(readInteractionSession(f.repoRoot, 'ios-simulator', oldId)?.status).toBe('closing');
    expect(listActiveLeases(f.controllerHome, 'repo-ios-192')
      .filter((lease) => lease.resourceKey === simulatorResource)).toHaveLength(1);
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
