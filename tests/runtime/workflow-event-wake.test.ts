import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowGraphAssetDraft } from '../../packages/workflow-runtime/api/index';
import { writeWorkflowGraphAssetContent } from '../../src/runtime/control-plane/persistence/workflow-content-store';
import {
  recordWorkflowBindings,
  registerWorkflowFeatureAsset,
} from '../../src/runtime/control-plane/persistence/workflow-registry-store';
import { registerRepository } from '../../src/runtime/repositories/registry';
import { executionIdentityForRepository } from '../../src/runtime/control-plane/execution/execution-identity';
import { executeRegisteredWorkflowGraph } from '../../src/runtime/workflows/graph-runtime';
import { findWorkflowGraphEventWaits, resumeWorkflowGraphEventWait } from '../../src/runtime/workflows/event-wake';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function home() {
  const v = mkdtempSync(join(tmpdir(), 'forge-workflow-event-wake-'));
  roots.push(v);
  return v;
}
function install(h: string) {
  const draft: WorkflowGraphAssetDraft = {
    schemaVersion: 2,
    workflowId: 'wake.demo',
    version: '1',
    inputContract: { case_id: { type: 'string', required: true } },
    entryNodeId: 'wait',
    nodes: [
      {
        kind: 'wait_event',
        nodeId: 'wait',
        sources: ['agentmail.watch'],
        eventTypes: ['mail.reply'],
        correlation: { kind: 'input', name: 'case_id' },
        timeoutMs: 60000,
      },
      { kind: 'capability', nodeId: 'done', capabilityId: 'case.done', idempotency: 'idempotent' },
    ],
    edges: [{ edgeId: 'e1', from: 'wait', to: 'done', on: 'success' }],
  };
  const written = writeWorkflowGraphAssetContent({ kind: 'controller', controllerHome: h }, draft);
  const registered = registerWorkflowFeatureAsset({
    controllerHome: h,
    scope: { kind: 'controller' },
    asset: written.asset,
    contentLocation: { kind: 'controller', path: written.path },
    status: 'active',
  });
  return recordWorkflowBindings({
    controllerHome: h,
    scope: { kind: 'controller' },
    expectedIdentity: registered.value,
    bindings: [{ capabilityId: 'case.done', pluginId: 'case', actionId: 'done' }],
  });
}
function repo(h: string) {
  const root = mkdtempSync(join(tmpdir(), 'forge-wake-repo-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  return registerRepository({ controllerHome: h, path: root, displayName: 'Wake Repo' });
}
async function waiting(h: string) {
  install(h);
  const repository = repo(h);
  const scopeId = `repository:${repository.repoId}:checkout:${repository.activeCheckoutId}:workflow:wake.demo`;
  await executeRegisteredWorkflowGraph(
    {
      controllerHome: h,
      repository,
      executionIdentity: executionIdentityForRepository(repository),
      scopeId,
      runId: 'run-1',
      registryScope: { kind: 'controller' },
      workflowId: 'wake.demo',
      inputs: { case_id: 'case-1' },
    },
    { now: () => new Date('2026-11-26T00:00:00.000Z') },
  );
  return { repository, scopeId };
}
const signal = {
  eventId: 'event-1',
  source: 'agentmail.watch',
  eventType: 'mail.reply',
  correlationKey: 'case-1',
  occurredAt: '2026-11-26T00:00:10.000Z',
  receivedAt: '2026-11-26T00:00:11.000Z',
  payload: { subject: 'reply' },
};

describe('Workflow Graph durable event wake', () => {
  test('discovers matching waits directly from workflow_run without a second subscription ledger', async () => {
    const h = home();
    await waiting(h);
    expect(findWorkflowGraphEventWaits(h, signal)).toMatchObject([
      {
        runId: 'run-1',
        workflowId: 'wake.demo',
        nodeId: 'wait',
        repositoryId: expect.any(String),
        checkoutId: expect.any(String),
      },
    ]);
    expect(findWorkflowGraphEventWaits(h, { ...signal, correlationKey: 'other' })).toEqual([]);
    expect(findWorkflowGraphEventWaits(h, { ...signal, eventType: 'other' })).toEqual([]);
  });
  test('resolves exact wait and continues downstream through the existing Plugin owner', async () => {
    const h = home();
    await waiting(h);
    const [match] = findWorkflowGraphEventWaits(h, signal);
    expect(match).toBeDefined();
    let calls = 0;
    const result = await resumeWorkflowGraphEventWait(h, match!, signal, {
      submitPluginAction: async (_home, _repo, request) => {
        calls++;
        return {
          receipt: {
            receiptId: 'done-1',
            requestId: request.requestId,
            pluginId: 'case',
            actionId: 'done',
            status: 'succeeded',
            createdAt: signal.receivedAt,
          } as never,
          result: {
            schemaVersion: 1,
            plugin: { pluginId: 'case' },
            action: { actionId: 'done', requestId: request.requestId },
            result: { ok: true },
          },
        } as never;
      },
      now: () => new Date(signal.receivedAt),
    });
    expect(calls).toBe(1);
    expect(result.status).toBe('succeeded');
    expect(findWorkflowGraphEventWaits(h, signal)).toEqual([]);
  });
  test('duplicate/stale wake is fenced by run revision and no longer matches', async () => {
    const h = home();
    await waiting(h);
    const [match] = findWorkflowGraphEventWaits(h, signal);
    await resumeWorkflowGraphEventWait(h, match!, signal, {
      submitPluginAction: async (_home, _repo, request) =>
        ({
          receipt: {
            receiptId: 'done-1',
            requestId: request.requestId,
            pluginId: 'case',
            actionId: 'done',
            status: 'succeeded',
            createdAt: signal.receivedAt,
          } as never,
          result: {
            schemaVersion: 1,
            plugin: { pluginId: 'case' },
            action: { actionId: 'done', requestId: request.requestId },
            result: { ok: true },
          },
        }) as never,
      now: () => new Date(signal.receivedAt),
    });
    await expect(resumeWorkflowGraphEventWait(h, match!, signal)).rejects.toThrow('WORKFLOW_EVENT_WAIT_MATCH_STALE');
  });
  test('events after the persisted expiry do not match', async () => {
    const h = home();
    await waiting(h);
    expect(findWorkflowGraphEventWaits(h, { ...signal, occurredAt: '2026-11-26T00:01:01.000Z' })).toEqual([]);
  });
});
