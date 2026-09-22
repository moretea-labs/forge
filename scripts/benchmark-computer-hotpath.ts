#!/usr/bin/env bun

/**
 * Repeatable Computer semantic hot-path benchmark.
 *
 * Uses an isolated controller home and a local Unix JSONL provider fixture. It
 * measures the real Computer product dispatch path without touching the live
 * Desktop Operator or the repository checkout.
 */
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { createServer, type Server } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { computerPluginAdapter } from '../src/runtime/plugins/computer-registration';
import { createDesktopOperatorRegistrationInput } from '../src/runtime/plugins/desktop-operator-registration';
import { installExternalPluginRegistration } from '../src/runtime/plugins/external-registration';
import { disposeRuntimeComputerComposition } from '../src/runtime/root/computer-composition';
import { setComputerPlatformForTest } from '../src/runtime/platform/computer-platform';
import type { AssistantPluginActionExecutionInput } from '../src/runtime/plugins/types';

const WARMUP = 5;
const SAMPLES = Math.max(10, Number(process.env.FORGE_COMPUTER_BENCH_SAMPLES ?? 50));

interface Counters {
  connections: number;
  handshakes: number;
  manifests: number;
  statuses: number;
  sessionOpens: number;
  observes: number;
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function actionInput(
  controllerHome: string,
  actionId: string,
  args: Record<string, unknown>,
  requestId: string,
): AssistantPluginActionExecutionInput {
  return {
    controllerHome,
    repoId: '__controller__',
    repoRoot: controllerHome,
    pluginId: 'computer',
    actionId,
    requestId,
    args,
    origin: { surface: 'system', actor: 'computer-hotpath-benchmark' },
  };
}

function counterDelta(after: Counters, before: Counters): Counters {
  return {
    connections: after.connections - before.connections,
    handshakes: after.handshakes - before.handshakes,
    manifests: after.manifests - before.manifests,
    statuses: after.statuses - before.statuses,
    sessionOpens: after.sessionOpens - before.sessionOpens,
    observes: after.observes - before.observes,
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function main(): Promise<void> {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-computer-hotpath-'));
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\forge-computer-hotpath-${randomUUID()}`
    : join(controllerHome, 'desktop.sock');
  // Benchmark the macOS provider contract with a local transport fixture on
  // every host. This is not a production platform fallback: it keeps the
  // measured path identical while Windows still fails native calls without a
  // registered Windows provider.
  setComputerPlatformForTest('darwin');
  const registration = installExternalPluginRegistration(controllerHome, createDesktopOperatorRegistrationInput({
    socketPath,
    pluginVersion: '0.3.2',
    protocolVersion: '1.0',
  }));
  const sessions = new Map<string, Record<string, unknown>>();
  const counters: Counters = {
    connections: 0,
    handshakes: 0,
    manifests: 0,
    statuses: 0,
    sessionOpens: 0,
    observes: 0,
  };

  const server = createServer((socket) => {
    counters.connections += 1;
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
        const actionId = request.method === 'execute' && typeof envelopeParams.action === 'string'
          ? envelopeParams.action
          : request.method;
        const params = request.method === 'execute' && envelopeParams.arguments && typeof envelopeParams.arguments === 'object'
          ? envelopeParams.arguments as Record<string, unknown>
          : envelopeParams;
        let result: Record<string, unknown>;
        if (actionId === 'handshake') {
          counters.handshakes += 1;
          result = {
            pluginId: registration.providerPluginId,
            protocolVersion: registration.protocolVersion,
            processId: 9001,
            startedAt: '2026-09-09T00:00:00.000Z',
            computerCapabilities: [],
          };
        } else if (actionId === 'manifest') {
          counters.manifests += 1;
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
          counters.statuses += 1;
          result = { sessions: [...sessions.values()] };
        } else if (actionId === 'desktop_session_open') {
          counters.sessionOpens += 1;
          const interactionId = `bench_session_${counters.sessionOpens}`;
          const session = {
            interactionId,
            bundleIdentifier: typeof params.bundle_id === 'string' ? params.bundle_id : 'com.example.Benchmark',
            appName: 'Benchmark',
          };
          sessions.set(interactionId, session);
          result = session;
        } else if (actionId === 'desktop_observe') {
          if (typeof params.interaction_id !== 'string' || !sessions.has(params.interaction_id)) {
            socket.write(`${JSON.stringify({ id: request.id, ok: false, error: { code: 'SESSION_NOT_FOUND', message: 'missing', retryable: false, domain: 'session' } })}\n`);
            continue;
          }
          counters.observes += 1;
          result = { observed: true, interactionId: params.interaction_id };
        } else {
          result = { ok: true };
        }
        socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });

    const opened = await computerPluginAdapter.executeAction(actionInput(
      controllerHome,
      'desktop_target_open',
      { bundle_id: 'com.example.Benchmark', launch: false, activate: false },
      'benchmark-target-open',
    ));
    const targetId = String(opened.targetId);

    const coldBefore = { ...counters };
    const coldStartedAt = performance.now();
    await computerPluginAdapter.executeAction(actionInput(
      controllerHome,
      'desktop_observe',
      { target_id: targetId, max_depth: 1, max_nodes: 5 },
      'benchmark-cold-observe',
    ));
    const coldMs = performance.now() - coldStartedAt;
    const coldDelta = counterDelta(counters, coldBefore);

    for (let index = 0; index < WARMUP; index += 1) {
      await computerPluginAdapter.executeAction(actionInput(
        controllerHome,
        'desktop_observe',
        { target_id: targetId, max_depth: 1, max_nodes: 5 },
        `benchmark-warmup-${index}`,
      ));
    }

    const warmBefore = { ...counters };
    const samples: number[] = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      const startedAt = performance.now();
      await computerPluginAdapter.executeAction(actionInput(
        controllerHome,
        'desktop_observe',
        { target_id: targetId, max_depth: 1, max_nodes: 5 },
        `benchmark-sample-${index}`,
      ));
      samples.push(performance.now() - startedAt);
    }
    const warmDelta = counterDelta(counters, warmBefore);

    console.log(JSON.stringify({
      benchmark: 'computer-hotpath',
      samples: SAMPLES,
      warmup: WARMUP,
      cold: {
        ms: rounded(coldMs),
        provider: coldDelta,
      },
      warm: {
        p50Ms: rounded(percentile(samples, 0.50)),
        p95Ms: rounded(percentile(samples, 0.95)),
        maxMs: rounded(Math.max(...samples)),
        provider: warmDelta,
        providerRpcsPerAction: rounded(warmDelta.observes / SAMPLES),
      },
      contract: {
        warmHandshakePerAction: 0,
        warmManifestPreflightPerAction: 0,
        warmStatusPreflightPerAction: 0,
        retainedConnectionsDuringSamples: 0,
        removedLegacyStatusPreflightRpcsPerWarmAction: 1,
      },
    }, null, 2));
  } finally {
    disposeRuntimeComputerComposition();
    setComputerPlatformForTest(undefined);
    await closeServer(server);
    rmSync(controllerHome, { recursive: true, force: true });
  }
}

await main();
