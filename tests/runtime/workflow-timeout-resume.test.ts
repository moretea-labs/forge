import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowGraphAssetDraft } from '../../packages/workflow-runtime/api/index';
import { executionIdentityForRepository } from '../../src/runtime/control-plane/execution/execution-identity';
import { readAuthorizationRequest } from '../../src/runtime/control-plane/governance/authorization';
import { writeWorkflowGraphAssetContent } from '../../src/runtime/control-plane/persistence/workflow-content-store';
import {
  recordWorkflowBindings,
  registerWorkflowFeatureAsset,
} from '../../src/runtime/control-plane/persistence/workflow-registry-store';
import { addRepositoryCheckout, registerRepository } from '../../src/runtime/repositories/registry';
import { executeRegisteredWorkflowGraph } from '../../src/runtime/workflows/graph-runtime';
import { resumeDueWorkflowGraphWaits } from '../../src/runtime/workflows/timeout-resume';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function home() {
  const v = mkdtempSync(join(tmpdir(), 'forge-workflow-timeout-'));
  roots.push(v);
  return v;
}
function repo(h: string) {
  const root = mkdtempSync(join(tmpdir(), 'forge-timeout-repo-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Forge Test',
      '-c',
      'user.email=forge-test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ],
    { cwd: root },
  );
  return registerRepository({ controllerHome: h, path: root, displayName: 'Timeout Repo' });
}
function install(
  h: string,
  draft: WorkflowGraphAssetDraft,
  bindings: { capabilityId: string; pluginId: string; actionId: string }[] = [],
) {
  const written = writeWorkflowGraphAssetContent({ kind: 'controller', controllerHome: h }, draft);
  const registered = registerWorkflowFeatureAsset({
    controllerHome: h,
    scope: { kind: 'controller' },
    asset: written.asset,
    contentLocation: { kind: 'controller', path: written.path },
    status: 'active',
  });
  return bindings.length
    ? recordWorkflowBindings({
        controllerHome: h,
        scope: { kind: 'controller' },
        expectedIdentity: registered.value,
        bindings,
      })
    : registered;
}
function input(h: string, repository: ReturnType<typeof registerRepository>, workflowId: string) {
  return {
    controllerHome: h,
    repository,
    executionIdentity: executionIdentityForRepository(repository),
    scopeId: `repository:${repository.repoId}:checkout:${repository.activeCheckoutId}:workflow:${workflowId}`,
    runId: 'run-1',
    registryScope: { kind: 'controller' as const },
    workflowId,
    inputs: {},
  };
}
function successReceipt(request: any, pluginId: string, actionId: string) {
  return {
    receipt: {
      receiptId: `${actionId}-r`,
      requestId: request.requestId,
      pluginId,
      actionId,
      status: 'succeeded',
      createdAt: '2026-11-26T00:01:00.000Z',
    } as never,
    result: {
      schemaVersion: 1,
      plugin: { pluginId },
      action: { actionId, requestId: request.requestId },
      result: { ok: true },
    },
  } as never;
}

describe('Workflow due wait resume', () => {
  test('does nothing before expiry and resumes the timeout branch at expiry', async () => {
    const h = home();
    const repository = repo(h);
    const draft: WorkflowGraphAssetDraft = {
      schemaVersion: 2,
      workflowId: 'timeout.event',
      version: '1',
      entryNodeId: 'wait',
      nodes: [
        {
          kind: 'wait_event',
          nodeId: 'wait',
          sources: ['event'],
          correlation: { kind: 'literal', value: 'case-1' },
          timeoutMs: 60000,
        },
        { kind: 'capability', nodeId: 'timeout', capabilityId: 'timeout.handle', idempotency: 'idempotent' },
      ],
      edges: [{ edgeId: 'timeout-edge', from: 'wait', to: 'timeout', on: 'timeout' }],
    };
    install(h, draft, [{ capabilityId: 'timeout.handle', pluginId: 'svc', actionId: 'timeout' }]);
    await executeRegisteredWorkflowGraph(input(h, repository, 'timeout.event'), {
      now: () => new Date('2026-11-26T00:00:00.000Z'),
    });
    expect(await resumeDueWorkflowGraphWaits(h, new Date('2026-11-26T00:00:59.000Z'))).toEqual([]);
    let calls = 0;
    const results = await resumeDueWorkflowGraphWaits(h, new Date('2026-11-26T00:01:00.000Z'), {
      submitPluginAction: async (_home, _repo, request) => {
        calls++;
        return successReceipt(request, 'svc', 'timeout');
      },
      now: () => new Date('2026-11-26T00:01:00.000Z'),
    });
    expect(calls).toBe(1);
    expect(results).toEqual([
      {
        scopeId: input(h, repository, 'timeout.event').scopeId,
        runId: 'run-1',
        workflowId: 'timeout.event',
        status: 'resumed',
        workflowStatus: 'succeeded',
      },
    ]);
  });

  test('invalidates an expired Authorization request before following approval timeout routing', async () => {
    const h = home();
    const repository = repo(h);
    const draft: WorkflowGraphAssetDraft = {
      schemaVersion: 2,
      workflowId: 'timeout.approval',
      version: '1',
      entryNodeId: 'approve',
      nodes: [
        { kind: 'approval', nodeId: 'approve', approvalKey: 'send', prompt: 'Send?', timeoutMs: 60000 },
        { kind: 'capability', nodeId: 'timeout', capabilityId: 'approval.timeout', idempotency: 'idempotent' },
      ],
      edges: [{ edgeId: 'timeout-edge', from: 'approve', to: 'timeout', on: 'timeout' }],
    };
    install(h, draft, [{ capabilityId: 'approval.timeout', pluginId: 'svc', actionId: 'approval_timeout' }]);
    const base = {
      ...input(h, repository, 'timeout.approval'),
      approvalContext: { sessionId: 'session-1', principalId: 'principal-1', permissionSnapshotVersion: 1 },
    };
    const waiting = await executeRegisteredWorkflowGraph(base, { now: () => new Date('2026-11-26T00:00:00.000Z') });
    const approvalState = waiting.nodes.find((node) => node.nodeId === 'approve');
    const requestRef = approvalState?.wait?.kind === 'approval' ? approvalState.wait.requestRef : undefined;
    expect(requestRef).toBeDefined();
    const results = await resumeDueWorkflowGraphWaits(h, new Date('2026-11-26T00:01:00.000Z'), {
      submitPluginAction: async (_home, _repo, request) => successReceipt(request, 'svc', 'approval_timeout'),
      now: () => new Date('2026-11-26T00:01:00.000Z'),
    });
    expect(results[0]).toMatchObject({ status: 'resumed', workflowStatus: 'succeeded' });
    expect(readAuthorizationRequest(h, repository.repoId, requestRef!)).toMatchObject({ status: 'invalidated' });
  });

  test('one blocked due run does not prevent independent due runs from being processed', async () => {
    const h = home();
    const repository = repo(h);
    const good: WorkflowGraphAssetDraft = {
      schemaVersion: 2,
      workflowId: 'timeout.good',
      version: '1',
      entryNodeId: 'wait',
      nodes: [
        {
          kind: 'wait_event',
          nodeId: 'wait',
          sources: ['event'],
          correlation: { kind: 'literal', value: 'x' },
          timeoutMs: 1000,
        },
      ],
      edges: [],
    };
    install(h, good);
    await executeRegisteredWorkflowGraph(input(h, repository, 'timeout.good'), {
      now: () => new Date('2026-11-26T00:00:00.000Z'),
    });
    const replacementParent = mkdtempSync(join(tmpdir(), 'forge-timeout-repo-replacement-'));
    roots.push(replacementParent);
    const replacementRoot = join(replacementParent, 'checkout');
    execFileSync('git', ['worktree', 'add', '--detach', replacementRoot], { cwd: repository.canonicalRoot });
    addRepositoryCheckout({
      repoId: repository.repoId,
      path: replacementRoot,
      controllerHome: h,
      activate: true,
    });
    const results = await resumeDueWorkflowGraphWaits(h, new Date('2026-11-26T00:00:02.000Z'));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: 'blocked', error: 'WORKFLOW_DUE_RESUME_CHECKOUT_DRIFT' });
  });
});
