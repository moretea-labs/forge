#!/usr/bin/env bun
import { createHash } from 'crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { resolveControllerHome } from '../src/cli/repositories/controller-home';
import { recoveryConnectorDescriptor, verifyRecoveryConnector } from '../src/cli/commands/recovery';
import { loadRecoveryConfig, verifyStableRuntime } from '../src/runtime/standalone-recovery/core';
import { observeRuntimeStatus } from '../src/runtime/root/status';

interface BaselineReceipt {
  schemaVersion: 1;
  status: 'passed' | 'failed';
  controllerHome: string;
  observedAt: string;
  runtime: ReturnType<typeof observeRuntimeStatus>;
  recovery: {
    connector: ReturnType<typeof recoveryConnectorDescriptor>;
    runtimeVerify: Awaited<ReturnType<typeof verifyStableRuntime>>;
    connectorVerify: Awaited<ReturnType<typeof verifyRecoveryConnector>>;
  };
  blockers: string[];
  receiptId: string;
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

export async function checkStableBaseline(controllerHomeInput?: string): Promise<BaselineReceipt> {
  const controllerHome = resolveControllerHome(controllerHomeInput);
  const config = loadRecoveryConfig(controllerHome);
  const runtime = observeRuntimeStatus(controllerHome);
  const connector = recoveryConnectorDescriptor(controllerHome);
  const runtimeVerify = await verifyStableRuntime(config);
  const connectorVerify = await verifyRecoveryConnector(controllerHome);
  const blockers: string[] = [];

  if (!runtime.running || !runtime.ready) blockers.push(`runtime_not_ready:${runtime.reasonCodes.join(',') || 'unknown'}`);
  if (!runtimeVerify.ok) blockers.push('recovery_runtime_verify_failed');
  if (!runtimeVerify.releases.coherent) blockers.push('runtime_release_not_coherent');
  if (!connector.readyForChatGPT) blockers.push(...connector.warnings.map((warning) => `recovery_connector:${warning}`));
  if (!connectorVerify.ok) blockers.push(...connectorVerify.failures.map((failure) => `recovery_connector_verify:${failure}`));
  if (!connector.currentRelease) blockers.push('recovery_release_missing');

  const observedAt = new Date().toISOString();
  const identity = {
    schemaVersion: 1,
    controllerHome,
    runtimeInstanceId: runtime.runtimeInstanceId,
    runtimeRelease: runtimeVerify.releases.active?.revision,
    runtimeManifest: runtimeVerify.releases.active?.manifestSha256,
    recoveryRelease: connector.currentRelease,
    recoveryUrl: connector.url,
    runtimeReady: runtime.ready,
    runtimeVerifyOk: runtimeVerify.ok,
    connectorVerifyOk: connectorVerify.ok,
  };
  const receiptId = createHash('sha256').update(stableJson(identity)).digest('hex');
  const receipt: BaselineReceipt = {
    schemaVersion: 1,
    status: blockers.length === 0 ? 'passed' : 'failed',
    controllerHome,
    observedAt,
    runtime,
    recovery: { connector, runtimeVerify, connectorVerify },
    blockers,
    receiptId,
  };

  const root = join(controllerHome, 'recovery', 'stable-baseline');
  atomicJson(join(root, `${receiptId}.json`), receipt);
  atomicJson(join(root, 'latest.json'), receipt);
  return receipt;
}

if (import.meta.main) {
  const explicit = argValue('--controller-home');
  if (process.argv.includes('--controller-home') && !explicit) throw new Error('STABLE_BASELINE_CONTROLLER_HOME_REQUIRED');
  const receipt = await checkStableBaseline(explicit);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.status !== 'passed') process.exitCode = 1;
}
