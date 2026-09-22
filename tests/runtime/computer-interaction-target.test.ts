import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { createServer, type Server } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanupRuntimeComputerInteractionTargets, runtimeComputerInteractionTargetAuthority } from '../../src/runtime/root/computer-target-composition';
import { disposeRuntimeComputerComposition, executeRuntimeComputerConsoleUnlock } from '../../src/runtime/root/computer-composition';
import { setComputerPlatformForTest } from '../../src/runtime/platform/computer-platform';
import { computerPluginAdapter } from '../../src/runtime/plugins/computer-registration';
import { isDirectNonPersistentPluginAction } from '../../src/runtime/plugins/store';
import { createDesktopOperatorRegistrationInput } from '../../src/runtime/plugins/desktop-operator-registration';
import { callProtectedComputerAdapter, executeProtectedConsoleUnlockInvocation, executeProtectedConsoleUnlockPreparation } from '../../adapters/mcp/runtime-gateway/protected-computer-adapter';
import { installExternalPluginRegistration } from '../../src/runtime/plugins/external-registration';
import type { AssistantPluginActionExecutionInput } from '../../src/runtime/plugins/types';

interface ProviderFixture {
  controllerHome: string;
  server: Server;
  sessions: Map<string, Record<string, unknown>>;
  state: {
    connectionCount: number;
    handshakeCount: number;
    manifestCount: number;
    sessionOpenCount: number;
    sessionCloseCount: number;
    lastSessionCloseArgs?: Record<string, unknown>;
    omitLaunchProvenance: boolean;
    reuseProviderSession: boolean;
    statusCount: number;
    observeCount: number;
    pressCount: number;
    elementObserveCount: number;
    elementActionCount: number;
    consolePrepareCount: number;
    consoleUnlockCount: number;
    lastConsoleHandle?: string;
    lastConsoleAuthorization?: Record<string, unknown>;
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

beforeEach(() => {
  setComputerPlatformForTest('darwin');
});

afterEach(async () => {
  disposeRuntimeComputerComposition();
  setComputerPlatformForTest(undefined);
  for (const fixture of fixtures.splice(0)) {
    await closeServer(fixture.server);
    rmSync(fixture.controllerHome, { recursive: true, force: true });
  }
});

async function providerFixture(): Promise<ProviderFixture> {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-computer-target-'));
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\forge-computer-target-${randomUUID()}`
    : join(controllerHome, 'desktop.sock');
  const registrationInput = createDesktopOperatorRegistrationInput({
    socketPath,
    pluginVersion: '0.4.0',
    protocolVersion: '1.0',
  });
  const registration = installExternalPluginRegistration(controllerHome, registrationInput);
  const sessions = new Map<string, Record<string, unknown>>();
  const state = {
    connectionCount: 0,
    handshakeCount: 0,
    manifestCount: 0,
    sessionOpenCount: 0,
    sessionCloseCount: 0,
    lastSessionCloseArgs: undefined as Record<string, unknown> | undefined,
    omitLaunchProvenance: false,
    reuseProviderSession: false,
    statusCount: 0,
    observeCount: 0,
    pressCount: 0,
    elementObserveCount: 0,
    elementActionCount: 0,
    consolePrepareCount: 0,
    consoleUnlockCount: 0,
    lastConsoleHandle: undefined as string | undefined,
    lastConsoleAuthorization: undefined as Record<string, unknown> | undefined,
    failNextPressAfterDispatch: false,
    nextOpenBundleId: undefined as string | undefined,
  };
  const server = createServer((socket) => {
    state.connectionCount += 1;
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const request = JSON.parse(raw) as { id: string; method: string; params?: Record<string, unknown> };
        const envelopeParams = request.params ?? {};
        const computerArguments = request.method === 'computer_execute' && envelopeParams.arguments && typeof envelopeParams.arguments === 'object'
          ? envelopeParams.arguments as Record<string, unknown>
          : undefined;
        const computerCapability = request.method === 'computer_execute' && typeof envelopeParams.capability === 'string' ? envelopeParams.capability : undefined;
        const actionId = request.method === 'execute' && typeof envelopeParams.action === 'string'
          ? envelopeParams.action
          : request.method === 'computer_execute'
            ? computerCapability === 'computer.element.observe.v2'
              ? 'observe_elements'
              : typeof computerArguments?.action === 'string' ? computerArguments.action : request.method
            : request.method;
        const params = request.method === 'execute' && envelopeParams.arguments && typeof envelopeParams.arguments === 'object'
          ? envelopeParams.arguments as Record<string, unknown>
          : computerArguments ?? envelopeParams;
        const respond = (result: Record<string, unknown>) => socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
        const fail = (code: string, message: string) => socket.write(`${JSON.stringify({ id: request.id, ok: false, error: { code, message, retryable: false, domain: 'session' } })}\n`);
        let result: Record<string, unknown>;
        if (actionId === 'handshake') {
          state.handshakeCount += 1;
          result = {
            pluginId: registration.providerPluginId,
            protocolVersion: registration.protocolVersion,
            processId: 4242,
            startedAt: '2026-09-09T00:00:00.000Z',
            pluginVersion: registration.pluginVersion,
            computerCapabilities: [
              { capabilityId: 'computer.observe.v1', protocolVersion: 1, method: 'computer_execute', actions: ['desktop_observe'] },
              { capabilityId: 'computer.input.v1', protocolVersion: 1, method: 'computer_execute', actions: ['desktop_press', 'desktop_type_text', 'desktop_key', 'desktop_open_url'] },
              { capabilityId: 'computer.console.unlock.v1', protocolVersion: 1, method: 'computer_execute', actions: ['prepare_unlock_console', 'unlock_console', 'console_unlock_enroll', 'console_unlock_status', 'console_unlock_recover', 'console_unlock_revoke'] },
              { capabilityId: 'computer.capture.v1', protocolVersion: 1, method: 'computer_execute', actions: ['desktop_screenshot'] },
              { capabilityId: 'computer.element.observe.v2', protocolVersion: 2, method: 'computer_execute', actions: ['observe_elements'] },
              { capabilityId: 'computer.element.action.v2', protocolVersion: 2, method: 'computer_execute', actions: ['invoke', 'focus', 'set_value', 'toggle', 'expand', 'collapse', 'select', 'open', 'show_menu', 'scroll_page_down', 'scroll_page_up'] },
            ],
          };
        } else if (actionId === 'manifest') {
          state.manifestCount += 1;
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
          state.statusCount += 1;
          result = { sessions: [...sessions.values()] };
        } else if (actionId === 'desktop_session_open') {
          state.sessionOpenCount += 1;
          const requestedBundle = typeof params.bundle_id === 'string' ? params.bundle_id : undefined;
          const requestedName = typeof params.app_name === 'string' ? params.app_name : undefined;
          const existing = state.reuseProviderSession ? [...sessions.values()][0] : undefined;
          if (existing) {
            result = existing;
          } else {
            const interactionId = `provider_session_${state.sessionOpenCount}`;
            const processId = 4242;
            const launched = params.launch === true;
            const session = {
              interactionId,
              pid: processId,
              bundleIdentifier: state.nextOpenBundleId ?? requestedBundle ?? 'com.example.Editor',
              appName: requestedName ?? 'Editor',
              ...(!state.omitLaunchProvenance ? launched
                ? { applicationOwnership: 'provider_launched', ownedProcessIdentifier: processId }
                : { applicationOwnership: 'preexisting' } : {}),
            };
            sessions.set(interactionId, session);
            result = session;
          }
          state.nextOpenBundleId = undefined;
        } else if (actionId === 'desktop_session_close') {
          state.sessionCloseCount += 1;
          state.lastSessionCloseArgs = { ...params };
          const closed = typeof params.interaction_id === 'string' ? sessions.delete(params.interaction_id) : false;
          result = { closed, termination_outcome: params.terminate_owned_pid === 4242 ? 'terminated' : 'not_requested' };
        } else if (actionId === 'desktop_observe') {
          if (typeof params.interaction_id !== 'string' || !sessions.has(params.interaction_id)) {
            fail('SESSION_NOT_FOUND', 'Desktop session was not found');
            continue;
          }
          state.observeCount += 1;
          result = { observed: true, interactionId: params.interaction_id };
        } else if (actionId === 'observe_elements') {
          const interactionId = typeof params.interactionId === 'string' ? params.interactionId : '';
          const session = sessions.get(interactionId);
          if (!session) {
            fail('SESSION_NOT_FOUND', 'Desktop session was not found');
            continue;
          }
          state.elementObserveCount += 1;
          const snapshotRevision = state.elementObserveCount * 2 - 1;
          session.snapshotRevision = snapshotRevision;
          const target = { interactionId, pid: 4242, bundleIdentifier: session.bundleIdentifier, appName: session.appName, windowRef: 'ax_window_1', snapshotRevision };
          result = {
            protocolVersion: 2, interactionId, snapshotRevision, pid: 4242, bundleIdentifier: session.bundleIdentifier, appName: session.appName,
            truncated: false, nodeCount: 1,
            root: { ref: `ax_${snapshotRevision}_1`, target, role: 'AXButton', name: 'One', state: { enabled: true }, actions: ['invoke'], children: [] },
          };
        } else if (computerCapability === 'computer.element.action.v2') {
          const target = params.target && typeof params.target === 'object' ? params.target as Record<string, unknown> : undefined;
          const interactionId = typeof target?.interactionId === 'string' ? target.interactionId : '';
          const session = sessions.get(interactionId);
          if (!session) {
            fail('SESSION_NOT_FOUND', 'Desktop session was not found');
            continue;
          }
          if (typeof target?.snapshotRevision !== 'number' || target.snapshotRevision !== session.snapshotRevision) {
            fail('COMPUTER_ELEMENT_OBSERVATION_STALE', 'Observed element epoch is stale');
            continue;
          }
          state.elementActionCount += 1;
          session.snapshotRevision = Number(session.snapshotRevision ?? 0) + 1;
          result = { acted: true, action: params.action, ref: params.ref, interactionId };
        } else if (actionId === 'prepare_unlock_console') {
          state.consolePrepareCount += 1;
          state.lastConsoleAuthorization = params.authorization && typeof params.authorization === 'object' ? params.authorization as Record<string, unknown> : undefined;
          result = { prepared: true, credential_handle: '11111111-1111-4111-8111-111111111111', expires_in_ms: 120_000 };
        } else if (actionId === 'unlock_console') {
          state.consoleUnlockCount += 1;
          state.lastConsoleHandle = typeof params.credential_handle === 'string' ? params.credential_handle : undefined;
          state.lastConsoleAuthorization = params.authorization && typeof params.authorization === 'object' ? params.authorization as Record<string, unknown> : undefined;
          result = { unlocked: true, verified: true, postcondition: 'console_unlocked' };
        } else if (actionId === 'desktop_press') {
          if (typeof params.interaction_id !== 'string' || !sessions.has(params.interaction_id)) {
            fail('SESSION_NOT_FOUND', 'Desktop session was not found');
            continue;
          }
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
        respond(result);
      }
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

async function openTarget(fixture: ProviderFixture, launch = false): Promise<string> {
  const result = await computerPluginAdapter.executeAction(actionInput(
    fixture.controllerHome,
    'desktop_target_open',
    { bundle_id: 'com.example.Editor', launch, activate: false },
  ));
  expect(result.targetId).toBeString();
  return String(result.targetId);
}

describe('Computer durable InteractionTarget authority', () => {
  test('rejects a native Desktop action on an unsupported platform before provider discovery', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-computer-target-unsupported-'));
    setComputerPlatformForTest('win32');
    try {
      await expect(computerPluginAdapter.executeAction(actionInput(
        controllerHome,
        'desktop_target_open',
        { bundle_id: 'com.example.Editor', launch: false, activate: false },
        'target-unsupported-platform',
      ))).rejects.toThrow('PLUGIN_COMPUTER_DESKTOP_PLATFORM_UNSUPPORTED');
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('owns browser surfaces in the same durable authority while treating session and tab handles as compatibility/binding data', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-computer-surface-target-'));
    try {
      const surface = targetAuthority.createSurface(controllerHome, {
        stableIdentity: {
          surfaceType: 'browser-tab',
          ownership: 'plugin_owned',
          application: { bundleId: 'com.google.Chrome', appName: 'Google Chrome' },
        },
        compatibilityAliases: ['legacy-session-a', 'legacy-session-a'],
        repositoryIds: ['repo-a'],
        providerBinding: {
          providerId: 'macos-apple-events',
          observedAt: '2026-09-10T10:00:00.000Z',
          browserProduct: 'chrome',
          windowId: '7',
          tabId: '9',
        },
      });

      expect(surface.kind).toBe('surface');
      expect(surface.compatibilityAliases).toEqual(['legacy-session-a']);
      expect(surface.repositoryIds).toEqual(['repo-a']);
      expect(surface.compatibilityRecords).toEqual([]);
      expect(targetAuthority.get(controllerHome, surface.targetId)).toBeUndefined();
      expect(targetAuthority.getSurface(controllerHome, surface.targetId)).toMatchObject({
        targetId: surface.targetId,
        kind: 'surface',
        stableIdentity: { surfaceType: 'browser-tab', ownership: 'plugin_owned' },
        providerBinding: { providerId: 'macos-apple-events', browserProduct: 'chrome', windowId: '7', tabId: '9' },
      });
      expect(targetAuthority.findSurfaceByAlias(controllerHome, 'legacy-session-a', 'repo-a')?.targetId).toBe(surface.targetId);
      expect(targetAuthority.findSurfaceByAlias(controllerHome, 'legacy-session-a', 'repo-b')).toBeUndefined();

      await targetAuthority.withSurfaceLease(controllerHome, surface.targetId, async (lease) => {
        lease.mergeCompatibility({ compatibilityAliases: ['legacy-session-b'], repositoryIds: ['repo-b'] });
        lease.bind({
          providerId: 'macos-apple-events',
          observedAt: '2026-09-10T10:01:00.000Z',
          browserProduct: 'chrome',
          windowId: '99',
          tabId: '9',
        });
      });

      const rebound = targetAuthority.requireSurface(controllerHome, surface.targetId);
      expect(rebound.compatibilityAliases).toEqual(['legacy-session-a', 'legacy-session-b']);
      expect(rebound.repositoryIds).toEqual(['repo-a', 'repo-b']);
      expect(rebound.providerBinding).toMatchObject({ windowId: '99', tabId: '9' });
      expect(targetAuthority.findSurfaceByAlias(controllerHome, 'legacy-session-b', 'repo-b')?.targetId).toBe(surface.targetId);
      expect(targetAuthority.listSurfaces(controllerHome, { repoId: 'repo-a' }).map((target) => target.targetId)).toContain(surface.targetId);

      await targetAuthority.withSurfaceLease(controllerHome, surface.targetId, async (lease) => {
        lease.putCompatibility({
          namespace: 'browser.session.v1',
          schemaVersion: 1,
          value: { sessionId: 'legacy-session-a', url: 'https://example.com/' },
          updatedAt: '2026-09-10T10:02:00.000Z',
        });
      });
      expect(targetAuthority.requireSurface(controllerHome, surface.targetId).compatibilityRecords).toMatchObject([
        { namespace: 'browser.session.v1', schemaVersion: 1, value: { sessionId: 'legacy-session-a' } },
      ]);

      const converged = targetAuthority.upsertSurface(controllerHome, {
        stableIdentity: surface.stableIdentity,
        compatibilityAliases: ['legacy-session-b', 'legacy-session-c'],
        repositoryIds: ['repo-b', 'repo-c'],
        compatibilityRecords: [{
          namespace: 'browser.session.v1',
          schemaVersion: 1,
          value: { sessionId: 'legacy-session-c', url: 'https://example.com/new' },
          updatedAt: '2026-09-10T10:03:00.000Z',
        }],
        providerBinding: {
          providerId: 'macos-apple-events',
          observedAt: '2026-09-10T10:03:00.000Z',
          browserProduct: 'chrome',
          windowId: '111',
          tabId: '9',
        },
      });
      expect(converged.created).toBe(false);
      expect(converged.target.targetId).toBe(surface.targetId);
      expect(converged.target.compatibilityAliases).toContain('legacy-session-c');
      expect(converged.target.repositoryIds).toContain('repo-c');
      expect(converged.target.providerBinding).toMatchObject({ windowId: '111', tabId: '9' });

      await targetAuthority.withSurfaceLease(controllerHome, surface.targetId, async (lease) => { lease.tombstone(); });
      expect(targetAuthority.getSurface(controllerHome, surface.targetId)).toBeUndefined();
      expect(targetAuthority.findSurfaceByAlias(controllerHome, 'legacy-session-a', 'repo-a')).toBeUndefined();

      expect(() => targetAuthority.createSurface(controllerHome, {
        stableIdentity: { surfaceType: 'browser-tab', ownership: 'user_owned' },
        compatibilityAliases: Array.from({ length: 65 }, (_, index) => `alias-${index}`),
      })).toThrow('COMPUTER_SURFACE_ALIAS_LIMIT_EXCEEDED');
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

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
    expect(fixture.state.statusCount).toBe(0);
    expect(fixture.state.observeCount).toBe(2);
    expect(fixture.state.handshakeCount).toBe(1);
    expect(fixture.sessions.size).toBe(1);
    expect(targetAuthority.get(fixture.controllerHome, targetId)?.providerBinding?.providerSessionId).toBe('provider_session_2');
  });

  test('reuses one negotiated provider connection across warm semantic actions with no manifest/status preflight', async () => {
    const fixture = await providerFixture();
    const targetId = await openTarget(fixture);
    const baselineConnections = fixture.state.connectionCount;
    const baselineManifest = fixture.state.manifestCount;

    for (let index = 0; index < 5; index += 1) {
      await computerPluginAdapter.executeAction(actionInput(
        fixture.controllerHome,
        'desktop_observe',
        { target_id: targetId, max_depth: 1, max_nodes: 5 },
        `warm-observe-${index}`,
      ));
    }

    expect(fixture.state.handshakeCount).toBe(1);
    expect(fixture.state.statusCount).toBe(0);
    expect(fixture.state.manifestCount).toBe(baselineManifest);
    expect(fixture.state.connectionCount - baselineConnections).toBe(1);
    expect(fixture.state.observeCount).toBe(5);
  });

  test('retries a non-idempotent semantic mutation only after explicit pre-effect session loss', async () => {
    const fixture = await providerFixture();
    const targetId = await openTarget(fixture);
    fixture.sessions.clear();

    await computerPluginAdapter.executeAction(actionInput(
      fixture.controllerHome,
      'desktop_press',
      { target_id: targetId, selector: { title: 'Save' } },
      'press-stale-binding',
    ));

    expect(fixture.state.sessionOpenCount).toBe(2);
    expect(fixture.state.statusCount).toBe(0);
    expect(fixture.state.pressCount).toBe(1);
    expect(targetAuthority.get(fixture.controllerHome, targetId)?.providerBinding?.providerSessionId).toBe('provider_session_2');
  });

  test('round-trips exact element v2 observation authority and rejects stale refs after semantic mutation', async () => {
    const fixture = await providerFixture();
    const targetId = await openTarget(fixture);

    const observed = await computerPluginAdapter.executeAction(actionInput(
      fixture.controllerHome,
      'desktop_element_observe',
      { target_id: targetId, max_depth: 2, max_nodes: 20 },
      'element-observe-v2',
    ));
    const root = observed.root as Record<string, unknown>;
    const elementTarget = root.target as Record<string, unknown>;
    const ref = String(root.ref);
    expect(observed.protocolVersion).toBe(2);
    expect(observed.snapshotRevision).toBe(1);
    expect(elementTarget.interactionId).toBe('provider_session_1');

    const acted = await computerPluginAdapter.executeAction(actionInput(
      fixture.controllerHome,
      'desktop_element_action',
      { target_id: targetId, target: elementTarget, ref, action: 'invoke' },
      'element-action-v2',
    ));
    expect(acted).toMatchObject({ acted: true, action: 'invoke', ref });
    expect(fixture.state.sessionOpenCount).toBe(1);
    expect(fixture.state.elementActionCount).toBe(1);

    await expect(computerPluginAdapter.executeAction(actionInput(
      fixture.controllerHome,
      'desktop_element_action',
      { target_id: targetId, target: elementTarget, ref, action: 'invoke' },
      'element-action-v2-stale-replay',
    ))).rejects.toThrow('COMPUTER_ELEMENT_OBSERVATION_STALE');
    expect(fixture.state.sessionOpenCount).toBe(1);
    expect(fixture.state.elementActionCount).toBe(1);

    const refreshed = await computerPluginAdapter.executeAction(actionInput(
      fixture.controllerHome,
      'desktop_element_observe',
      { target_id: targetId, max_depth: 2, max_nodes: 20 },
      'element-reobserve-v2',
    ));
    expect(refreshed.snapshotRevision).toBe(3);
    expect(fixture.state.elementObserveCount).toBe(2);
    expect(fixture.state.handshakeCount).toBe(1);
    expect(fixture.state.sessionOpenCount).toBe(1);
  });

  test('closes a preexisting bound target without terminating its application', async () => {
    const fixture = await providerFixture();
    const targetId = await openTarget(fixture);
    expect(targetAuthority.get(fixture.controllerHome, targetId)?.launchProvenance).toEqual({ kind: 'preexisting' });

    const closed = await computerPluginAdapter.executeAction(actionInput(
      fixture.controllerHome,
      'desktop_target_close',
      { target_id: targetId },
      'target-close-direct',
    ));

    expect(closed.retired).toBe(true);
    expect(fixture.state.statusCount).toBe(0);
    expect(fixture.state.sessionCloseCount).toBe(1);
    expect(fixture.state.lastSessionCloseArgs?.terminate_owned_pid).toBeUndefined();
    expect(targetAuthority.get(fixture.controllerHome, targetId)).toBeUndefined();
  });

  test('keeps a shared provider session alive until the final target then terminates the owned process', async () => {
    const fixture = await providerFixture();
    fixture.state.reuseProviderSession = true;
    const firstTargetId = await openTarget(fixture, true);
    const secondTargetId = await openTarget(fixture, true);
    const first = targetAuthority.get(fixture.controllerHome, firstTargetId);
    const second = targetAuthority.get(fixture.controllerHome, secondTargetId);
    expect(first?.launchProvenance).toEqual({ kind: 'provider_launched', processId: 4242 });
    expect(second?.launchProvenance).toEqual({ kind: 'provider_launched', processId: 4242 });
    expect(second?.providerBinding?.providerSessionId).toBe(first?.providerBinding?.providerSessionId);

    await computerPluginAdapter.executeAction(actionInput(
      fixture.controllerHome,
      'desktop_target_close',
      { target_id: firstTargetId },
      'target-close-shared-first',
    ));
    expect(fixture.state.sessionCloseCount).toBe(0);
    expect(fixture.sessions.size).toBe(1);

    await computerPluginAdapter.executeAction(actionInput(
      fixture.controllerHome,
      'desktop_target_close',
      { target_id: secondTargetId },
      'target-close-shared-last',
    ));
    expect(fixture.state.sessionCloseCount).toBe(1);
    expect(fixture.state.lastSessionCloseArgs?.terminate_owned_pid).toBe(4242);
    expect(fixture.sessions.size).toBe(0);
  });

  test('preserves durable launch ownership across provider-session rebind while refreshing process binding', async () => {
    const fixture = await providerFixture();
    const targetId = await openTarget(fixture, true);
    expect(targetAuthority.get(fixture.controllerHome, targetId)?.launchProvenance).toEqual({ kind: 'provider_launched', processId: 4242 });
    fixture.sessions.clear();

    await computerPluginAdapter.executeAction(actionInput(
      fixture.controllerHome,
      'desktop_observe',
      { target_id: targetId, max_depth: 1, max_nodes: 5 },
      'owned-target-rebind',
    ));

    const rebound = targetAuthority.get(fixture.controllerHome, targetId);
    expect(rebound?.launchProvenance).toEqual({ kind: 'provider_launched', processId: 4242 });
    expect(rebound?.providerBinding?.processId).toBe(4242);
  });

  test('does not invent lifecycle ownership when a legacy provider omits launch provenance', async () => {
    const fixture = await providerFixture();
    fixture.state.omitLaunchProvenance = true;
    const targetId = await openTarget(fixture, true);
    expect(targetAuthority.get(fixture.controllerHome, targetId)?.launchProvenance).toBeUndefined();

    await computerPluginAdapter.executeAction(actionInput(
      fixture.controllerHome,
      'desktop_target_close',
      { target_id: targetId },
      'legacy-target-close',
    ));
    expect(fixture.state.lastSessionCloseArgs?.terminate_owned_pid).toBeUndefined();
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

    try {
      await computerPluginAdapter.executeAction(actionInput(
        fixture.controllerHome,
        'desktop_press',
        { target_id: targetId, selector: { title: 'Save' } },
        'press-outcome-unknown',
      ));
      throw new Error('expected unknown provider outcome');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as { effectOutcome?: string }).effectOutcome).toBe('outcome_unknown');
    }

    expect(fixture.state.pressCount).toBe(1);
    expect(fixture.state.sessionOpenCount).toBe(1);
    expect(fixture.state.statusCount).toBe(0);
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


describe('protected Computer console unlock composition', () => {
  test('protected MCP prepare/unlock require explicit authorization and expose only an opaque handle', async () => {
    const fixture = await providerFixture();

    await expect(executeProtectedConsoleUnlockPreparation({
      confirmAuthorization: false,
      timeoutMs: 5_000,
    }, fixture.controllerHome)).rejects.toThrow('COMPUTER_CONSOLE_UNLOCK_EXPLICIT_AUTHORIZATION_REQUIRED');
    expect(fixture.state.consolePrepareCount).toBe(0);

    const prepared = await executeProtectedConsoleUnlockPreparation({
      confirmAuthorization: true,
      timeoutMs: 5_000,
    }, fixture.controllerHome);
    expect(prepared).toMatchObject({
      capability: 'computer.console.unlock.v1',
      action: 'prepare_unlock_console',
      prepared: true,
      credentialHandle: '11111111-1111-4111-8111-111111111111',
    });
    expect(typeof prepared.invocationId).toBe('string');
    expect(fixture.state.consolePrepareCount).toBe(1);

    const result = await executeProtectedConsoleUnlockInvocation({
      credentialHandle: String(prepared.credentialHandle),
      confirmAuthorization: true,
      timeoutMs: 5_000,
    }, fixture.controllerHome);
    expect(result).toMatchObject({
      capability: 'computer.console.unlock.v1',
      action: 'unlock_console',
      unlocked: true,
      verified: true,
      postcondition: 'console_unlocked',
    });
    expect(typeof result.invocationId).toBe('string');
    expect(fixture.state.consoleUnlockCount).toBe(1);
    expect(fixture.state.lastConsoleHandle).toBe(String(prepared.credentialHandle));
    expect(fixture.state.lastConsoleAuthorization).toMatchObject({ kind: 'explicit_single_use', confirmed: true });
    disposeRuntimeComputerComposition();
  });

  test('supports frozen client schema only as a non-secret prepare/opaque-handle carrier', async () => {
    const fixture = await providerFixture();
    const ctx = { controllerHome: fixture.controllerHome } as any;

    const prepared = await callProtectedComputerAdapter(ctx, 'computer_console_unlock', {
      credential: 'prepare_provider_local',
      confirm_authorization: true,
      timeout_ms: 5_000,
    });
    expect(prepared?.structuredContent).toMatchObject({ accepted: true, action: 'prepare_unlock_console', prepared: true });
    const preparedContent = prepared?.structuredContent as Record<string, unknown> | undefined;
    const handle = String(preparedContent?.credentialHandle ?? '');
    expect(handle).toMatch(/^[0-9a-f-]{36}$/i);

    const unlocked = await callProtectedComputerAdapter(ctx, 'computer_console_unlock', {
      credential: handle,
      confirm_authorization: true,
      timeout_ms: 5_000,
    });
    expect(unlocked?.structuredContent).toMatchObject({ accepted: true, action: 'unlock_console', unlocked: true, verified: true });

    const rejected = await callProtectedComputerAdapter(ctx, 'computer_console_unlock', {
      credential: 'not-an-opaque-handle',
      confirm_authorization: true,
      timeout_ms: 5_000,
    });
    expect(rejected?.structuredContent).toMatchObject({
      accepted: false,
      error: { code: 'COMPUTER_CONSOLE_UNLOCK_FROZEN_CLIENT_CARRIER_INVALID' },
    });
    disposeRuntimeComputerComposition();
  });

  test('keeps provider execution fenced by explicit single-use authorization', async () => {
    const fixture = await providerFixture();
    const request = {
      capability: 'computer.console.unlock.v1' as const,
      action: 'unlock_console' as const,
      credentialHandle: '11111111-1111-4111-8111-111111111111',
    };
    await expect(executeRuntimeComputerConsoleUnlock(
      request,
      { kind: 'explicit_single_use', confirmed: true, invocationId: 'not-a-uuid' },
      5_000,
      fixture.controllerHome,
    )).rejects.toMatchObject({ code: 'COMPUTER_CONSOLE_UNLOCK_EXPLICIT_AUTHORIZATION_REQUIRED' });
    expect(fixture.state.connectionCount).toBe(0);

    const result = await executeRuntimeComputerConsoleUnlock(
      request,
      { kind: 'explicit_single_use', confirmed: true, invocationId: randomUUID() },
      5_000,
      fixture.controllerHome,
    );
    expect(result).toMatchObject({ unlocked: true, verified: true, postcondition: 'console_unlocked' });
    expect(fixture.state.consoleUnlockCount).toBe(1);
    expect(fixture.state.lastConsoleHandle).toBe(request.credentialHandle);
    expect(fixture.state.lastConsoleAuthorization).toMatchObject({ kind: 'explicit_single_use', confirmed: true });
    disposeRuntimeComputerComposition();
  });
});


describe('protected Computer stable plugin transport', () => {
  test('publishes console unlock only as strict direct non-persistent plugin actions', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-computer-direct-manifest-'));
    try {
      const manifest = computerPluginAdapter.buildManifest(0, undefined, root);
      const prepare = manifest.actions.find((action) => action.actionId === 'console_unlock_prepare');
      const unlock = manifest.actions.find((action) => action.actionId === 'console_unlock');
      const status = manifest.actions.find((action) => action.actionId === 'console_unlock_status');
      const recover = manifest.actions.find((action) => action.actionId === 'console_unlock_recover');
      expect(prepare).toBeDefined();
      expect(unlock).toBeDefined();
      expect(status).toBeDefined();
      expect(recover).toBeDefined();
      if (!prepare || !unlock || !status || !recover) throw new Error('protected console actions must be present');

      for (const action of [prepare, unlock, status, recover]) {
        expect(isDirectNonPersistentPluginAction(action)).toBe(true);
        expect(action.executionMode).toBe('direct_non_persistent');
        expect(action.resourceClaims).toEqual([]);
      }
      expect(prepare).toMatchObject({ readOnly: false, risk: 'workspace_write', confirmation: 'authorization', idempotent: false });
      expect(unlock).toMatchObject({ readOnly: false, risk: 'workspace_write', confirmation: 'authorization', idempotent: false });
      expect(status).toMatchObject({ readOnly: true, risk: 'readonly', confirmation: 'none', idempotent: true });
      expect(recover).toMatchObject({ readOnly: false, risk: 'workspace_write', confirmation: 'none', idempotent: false });

      expect(isDirectNonPersistentPluginAction({ ...status, confirmation: 'authorization' })).toBe(false);
      expect(isDirectNonPersistentPluginAction({ ...recover, risk: 'remote_write' })).toBe(false);
      expect(isDirectNonPersistentPluginAction({ ...recover, risk: 'destructive', confirmation: 'strong_confirmation' })).toBe(false);

      expect(prepare.argumentsSchema).toMatchObject({
        type: 'object',
        properties: {},
        additionalProperties: false,
      });
      expect(unlock.argumentsSchema).toMatchObject({
        type: 'object',
        required: ['credential_handle'],
        additionalProperties: false,
      });
      const unlockProperties = (unlock.argumentsSchema.properties ?? {}) as Record<string, unknown>;
      expect(Object.keys(unlockProperties)).toEqual(['credential_handle']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
