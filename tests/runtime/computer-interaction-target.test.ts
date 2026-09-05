import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { createServer, type Server } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanupRuntimeComputerInteractionTargets, runtimeComputerInteractionTargetAuthority } from '../../src/runtime/root/computer-target-composition';
import { computerPluginAdapter } from '../../src/runtime/plugins/computer-registration';
import { createDesktopOperatorRegistrationInput } from '../../src/runtime/plugins/desktop-operator-registration';
import { installExternalPluginRegistration } from '../../src/runtime/plugins/external-registration';
import type { AssistantPluginActionExecutionInput } from '../../src/runtime/plugins/types';

interface ProviderFixture {
  controllerHome: string;
  server: Server;
  sessions: Map<string, Record<string, unknown>>;
  state: {
    sessionOpenCount: number;
    sessionCloseCount: number;
    observeCount: number;
    pressCount: number;
    failNextPressAfterDispatch: boolean;
    nextOpenBundleId?: string;
  };
}

const fixtures: ProviderFixture[] = [];
const targetAuthority = runtimeComputerInteractionTargetAuthority();

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await closeServer(fixture.server);
    rmSync(fixture.controllerHome, { recursive: true, force: true });
  }
});

async function providerFixture(): Promise<ProviderFixture> {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-computer-target-'));
  const socketPath = join(controllerHome, 'desktop.sock');
  const registrationInput = createDesktopOperatorRegistrationInput({
    socketPath,
    pluginVersion: '0.3.2',
    protocolVersion: '1.0',
  });
  const registration = installExternalPluginRegistration(controllerHome, registrationInput);
  const sessions = new Map<string, Record<string, unknown>>();
  const state = {
    sessionOpenCount: 0,
    sessionCloseCount: 0,
    observeCount: 0,
    pressCount: 0,
    failNextPressAfterDispatch: false,
    nextOpenBundleId: undefined as string | undefined,
  };
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string; params?: Record<string, unknown> };
      const envelopeParams = request.params ?? {};
      const actionId = request.method === 'execute' && typeof envelopeParams.action === 'string' ? envelopeParams.action : request.method;
      const params = request.method === 'execute' && envelopeParams.arguments && typeof envelopeParams.arguments === 'object'
        ? envelopeParams.arguments as Record<string, unknown>
        : envelopeParams;
      let result: Record<string, unknown>;
      if (actionId === 'manifest') {
        result = {
          id: registration.providerPluginId,
          name: registration.displayName,
          version: registration.pluginVersion,
          protocolVersion: registration.protocolVersion,
          mode: 'external',
          scope: registration.scope,
          provider: registration.provider,
          capabilities: registration.capabilities.map((capability) => capability.capabilityId),
          actions: registration.actions.map((action) => action.actionId),
        };
      } else if (actionId === 'health') {
        result = { state: 'ready', warnings: [] };
      } else if (actionId === 'desktop_status') {
        result = { sessions: [...sessions.values()] };
      } else if (actionId === 'desktop_session_open') {
        state.sessionOpenCount += 1;
        const interactionId = `provider_session_${state.sessionOpenCount}`;
        const requestedBundle = typeof params.bundle_id === 'string' ? params.bundle_id : undefined;
        const requestedName = typeof params.app_name === 'string' ? params.app_name : undefined;
        const session = {
          interactionId,
          bundleIdentifier: state.nextOpenBundleId ?? requestedBundle ?? 'com.example.Editor',
          appName: requestedName ?? 'Editor',
        };
        state.nextOpenBundleId = undefined;
        sessions.set(interactionId, session);
        result = session;
      } else if (actionId === 'desktop_session_close') {
        state.sessionCloseCount += 1;
        if (typeof params.interaction_id === 'string') sessions.delete(params.interaction_id);
        result = { closed: true };
      } else if (actionId === 'desktop_observe') {
        state.observeCount += 1;
        result = { observed: true, interactionId: params.interaction_id };
      } else if (actionId === 'desktop_press') {
        state.pressCount += 1;
        if (state.failNextPressAfterDispatch) {
          state.failNextPressAfterDispatch = false;
          socket.destroy();
          return;
        }
        result = { pressed: true, interactionId: params.interaction_id };
      } else {
        result = { ok: true };
      }
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const fixture = { controllerHome, server, sessions, state };
  fixtures.push(fixture);
  return fixture;
}

function actionInput(
  controllerHome: string,
  actionId: string,
  args: Record<string, unknown>,
  requestId = `computer-target-${actionId}`,
): AssistantPluginActionExecutionInput {
  return {
    controllerHome,
    repoId: '__controller__',
    repoRoot: controllerHome,
    pluginId: 'computer',
    actionId,
    requestId,
    args,
    origin: { surface: 'mcp', actor: 'computer-target-test' },
  };
}

async function openTarget(fixture: ProviderFixture): Promise<string> {
  const result = await computerPluginAdapter.executeAction(actionInput(
    fixture.controllerHome,
    'desktop_target_open',
    { bundle_id: 'com.example.Editor', launch: false, activate: false },
  ));
  expect(result.targetId).toBeString();
  return String(result.targetId);
}

describe('Computer durable InteractionTarget authority', () => {
  test('rebinds a lost provider session once and serializes concurrent use of the same target', async () => {
    const fixture = await providerFixture();
    const targetId = await openTarget(fixture);
    expect(fixture.state.sessionOpenCount).toBe(1);
    expect(targetAuthority.get(fixture.controllerHome, targetId)?.providerBinding?.providerSessionId).toBe('provider_session_1');

    // Provider restart/session loss: durable target remains, transport binding disappears.
    fixture.sessions.clear();
    const observeArgs = { target_id: targetId, max_depth: 2, max_nodes: 20 };
    await Promise.all([
      computerPluginAdapter.executeAction(actionInput(fixture.controllerHome, 'desktop_observe', observeArgs, 'observe-a')),
      computerPluginAdapter.executeAction(actionInput(fixture.controllerHome, 'desktop_observe', observeArgs, 'observe-b')),
    ]);

    expect(fixture.state.sessionOpenCount).toBe(2);
    expect(fixture.state.observeCount).toBe(2);
    expect(fixture.sessions.size).toBe(1);
    expect(targetAuthority.get(fixture.controllerHome, targetId)?.providerBinding?.providerSessionId).toBe('provider_session_2');
  });

  test('bounds tombstones without reclaiming active Computer targets', async () => {
    const fixture = await providerFixture();
    const activeTargetId = await openTarget(fixture);
    const staleTargetId = await openTarget(fixture);
    const freshTargetId = await openTarget(fixture);
    await targetAuthority.withLease(fixture.controllerHome, staleTargetId, async (lease) => { lease.tombstone(); });
    await targetAuthority.withLease(fixture.controllerHome, freshTargetId, async (lease) => { lease.tombstone(); });

    const nowMs = Date.now();
    const first = await cleanupRuntimeComputerInteractionTargets(fixture.controllerHome, {
      nowMs, ttlMs: 60_000, maxTombstones: 256, maxRemovals: 32,
    });
    expect(first.activeProtected).toBe(1);
    expect(first.removed).toBe(0);
    expect(targetAuthority.get(fixture.controllerHome, activeTargetId)?.targetId).toBe(activeTargetId);

    const second = await cleanupRuntimeComputerInteractionTargets(fixture.controllerHome, {
      nowMs: nowMs + 61_000, ttlMs: 60_000, maxTombstones: 1, maxRemovals: 32,
    });
    expect(second.removed).toBe(2);
    expect(second.overCapacity).toBe(false);
    expect(targetAuthority.get(fixture.controllerHome, activeTargetId)?.targetId).toBe(activeTargetId);

    const third = await cleanupRuntimeComputerInteractionTargets(fixture.controllerHome, {
      nowMs: nowMs + 62_000, ttlMs: 60_000, maxTombstones: 1, maxRemovals: 32,
    });
    expect(third.removed).toBe(0);
  });

  test('never replays a non-idempotent semantic mutation after provider dispatch becomes unknown', async () => {
    const fixture = await providerFixture();
    const targetId = await openTarget(fixture);
    fixture.state.failNextPressAfterDispatch = true;

    await expect(computerPluginAdapter.executeAction(actionInput(
      fixture.controllerHome,
      'desktop_press',
      { target_id: targetId, selector: { title: 'Save' } },
      'press-outcome-unknown',
    ))).rejects.toThrow();

    expect(fixture.state.pressCount).toBe(1);
    expect(fixture.state.sessionOpenCount).toBe(1);
  });

  test('rejects provider identity drift and compensates the untrusted live session', async () => {
    const fixture = await providerFixture();
    fixture.state.nextOpenBundleId = 'com.example.Other';

    await expect(computerPluginAdapter.executeAction(actionInput(
      fixture.controllerHome,
      'desktop_target_open',
      { bundle_id: 'com.example.Editor', launch: false, activate: false },
      'target-identity-drift',
    ))).rejects.toThrow('PLUGIN_COMPUTER_TARGET_IDENTITY_MISMATCH');

    expect(fixture.state.sessionOpenCount).toBe(1);
    expect(fixture.state.sessionCloseCount).toBe(1);
    expect(fixture.sessions.size).toBe(0);
  });
});
