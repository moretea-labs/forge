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
import { readWorkflowGraphRun } from '../../src/runtime/control-plane/persistence/workflow-run-store';
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
function installVersion(h: string, version = '1', actionId = 'done', expectedRevision?: number) {
  const draft: WorkflowGraphAssetDraft = {
    schemaVersion: 2,
    workflowId: 'wake.demo',
    version,
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
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
  });
  return recordWorkflowBindings({
    controllerHome: h,
    scope: { kind: 'controller' },
    expectedIdentity: registered.value,
    bindings: [{ capabilityId: 'case.done', pluginId: 'case', actionId }],
    expectedRevision: registered.revision,
  });
}
function repo(h: string) {
  const root = mkdtempSync(join(tmpdir(), 'forge-wake-repo-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  return registerRepository({ controllerHome: h, path: root, displayName: 'Wake Repo' });
}
async function waiting(h: string) {
  installVersion(h);
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
  test('fails closed when pinned graph content is missing instead of falling back to the upgraded Registry', async () => {
    const h = home();
    const { scopeId } = await waiting(h);
    const oldRun = readWorkflowGraphRun(h, scopeId, 'run-1')!;
    const oldPath = oldRun.value.execution.contentLocation.path;
    installVersion(h, '2', 'done-v2', 2);
    rmSync(oldPath, { force: true });
    expect(() => findWorkflowGraphEventWaits(h, signal)).toThrow('WORKFLOW_RUN_EXECUTION_SNAPSHOT_CONTENT_UNAVAILABLE');
  });

  test('survives process restart after Registry upgrade and resumes from the persisted v1 snapshot', async () => {
    const h = home();
    const { scopeId } = await waiting(h);
    const oldRun = readWorkflowGraphRun(h, scopeId, 'run-1')!;
    const oldPath = oldRun.value.execution.contentLocation.path;
    installVersion(h, '2', 'done-v2', 2);

    const eventWakeUrl = new URL('../../src/runtime/workflows/event-wake.ts', import.meta.url).href;
    const child = execFileSync(
      process.execPath,
      [
        '-e',
        `
          const { findWorkflowGraphEventWaits, resumeWorkflowGraphEventWait } = await import(${JSON.stringify(eventWakeUrl)});
          const controllerHome = process.argv[1];
          const signal = JSON.parse(process.argv[2]);
          const [match] = findWorkflowGraphEventWaits(controllerHome, signal);
          if (!match) throw new Error('MATCH_REQUIRED_AFTER_RESTART');
          const actions = [];
          const result = await resumeWorkflowGraphEventWait(controllerHome, match, signal, {
            submitPluginAction: async (_home, _repo, request) => {
              actions.push(request.actionId);
              return {
                receipt: {
                  receiptId: 'restart-done-1',
                  requestId: request.requestId,
                  pluginId: 'case',
                  actionId: request.actionId,
                  status: 'succeeded',
                  createdAt: signal.receivedAt,
                },
                result: {
                  schemaVersion: 1,
                  plugin: { pluginId: 'case' },
                  action: { actionId: request.actionId, requestId: request.requestId },
                  result: { ok: true },
                },
              };
            },
            now: () => new Date(signal.receivedAt),
          });
          process.stdout.write(JSON.stringify({ actions, status: result.status }));
        `,
        h,
        JSON.stringify(signal),
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(child)).toEqual({ actions: ['done'], status: 'succeeded' });
    expect(readWorkflowGraphRun(h, scopeId, 'run-1')?.value).toMatchObject({
      version: '1',
      status: 'succeeded',
      execution: { contentLocation: { path: oldPath } },
    });
  });

  test('pins exact graph content and capability bindings across Registry upgrade', async () => {
    const h = home();
    const { repository, scopeId } = await waiting(h);
    const oldRun = readWorkflowGraphRun(h, scopeId, 'run-1');
    expect(oldRun?.value.execution.bindings).toEqual([
      { capabilityId: 'case.done', pluginId: 'case', actionId: 'done' },
    ]);
    const oldContentPath = oldRun?.value.execution.contentLocation.path;
    expect(oldContentPath).toBeTruthy();

    const currentRegistry = installVersion(h, '2', 'done-v2', 2);
    expect(currentRegistry.value.version).toBe('2');
    expect(currentRegistry.value.bindings).toEqual([
      { capabilityId: 'case.done', pluginId: 'case', actionId: 'done-v2' },
    ]);
    expect(currentRegistry.value.contentLocation.path).not.toBe(oldContentPath);

    const [oldMatch] = findWorkflowGraphEventWaits(h, signal);
    expect(oldMatch?.runId).toBe('run-1');
    const oldActions: string[] = [];
    const oldResult = await resumeWorkflowGraphEventWait(h, oldMatch!, signal, {
      submitPluginAction: async (_home, _repo, request) => {
        oldActions.push(request.actionId);
        return {
          receipt: {
            receiptId: 'done-old',
            requestId: request.requestId,
            pluginId: 'case',
            actionId: request.actionId,
            status: 'succeeded',
            createdAt: signal.receivedAt,
          } as never,
          result: {
            schemaVersion: 1,
            plugin: { pluginId: 'case' },
            action: { actionId: request.actionId, requestId: request.requestId },
            result: { ok: true },
          },
        } as never;
      },
      now: () => new Date(signal.receivedAt),
    });
    expect(oldResult.status).toBe('succeeded');
    expect(oldActions).toEqual(['done']);
    expect(readWorkflowGraphRun(h, scopeId, 'run-1')?.value.execution.contentLocation.path).toBe(oldContentPath);

    await executeRegisteredWorkflowGraph(
      {
        controllerHome: h,
        repository,
        executionIdentity: executionIdentityForRepository(repository),
        scopeId,
        runId: 'run-2',
        registryScope: { kind: 'controller' },
        workflowId: 'wake.demo',
        inputs: { case_id: 'case-2' },
      },
      { now: () => new Date('2026-11-26T00:00:20.000Z') },
    );
    const signal2 = {
      ...signal,
      eventId: 'event-2',
      correlationKey: 'case-2',
      occurredAt: '2026-11-26T00:00:30.000Z',
      receivedAt: '2026-11-26T00:00:31.000Z',
    };
    const [newMatch] = findWorkflowGraphEventWaits(h, signal2);
    expect(newMatch?.runId).toBe('run-2');
    const newActions: string[] = [];
    const newResult = await resumeWorkflowGraphEventWait(h, newMatch!, signal2, {
      submitPluginAction: async (_home, _repo, request) => {
        newActions.push(request.actionId);
        return {
          receipt: {
            receiptId: 'done-new',
            requestId: request.requestId,
            pluginId: 'case',
            actionId: request.actionId,
            status: 'succeeded',
            createdAt: signal2.receivedAt,
          } as never,
          result: {
            schemaVersion: 1,
            plugin: { pluginId: 'case' },
            action: { actionId: request.actionId, requestId: request.requestId },
            result: { ok: true },
          },
        } as never;
      },
      now: () => new Date(signal2.receivedAt),
    });
    expect(newResult.status).toBe('succeeded');
    expect(newActions).toEqual(['done-v2']);
  });
});
