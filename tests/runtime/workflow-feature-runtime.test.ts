import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  WorkflowAssetDraft,
  WorkflowGraphAssetDraft,
  WorkflowRunResult,
} from '../../packages/workflow-runtime/api/index';
import {
  writeWorkflowAssetContent,
  writeWorkflowGraphAssetContent,
} from '../../src/runtime/control-plane/persistence/workflow-content-store';
import { registerWorkflowFeatureAsset } from '../../src/runtime/control-plane/persistence/workflow-registry-store';
import {
  executeRegisteredWorkflowFeature,
  executeWorkflowInvocationIntent,
} from '../../src/runtime/workflows/feature-runtime';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function home() {
  const v = mkdtempSync(join(tmpdir(), 'forge-workflow-feature-runtime-'));
  roots.push(v);
  return v;
}
const repository = { repoId: 'repo-1', activeCheckoutId: 'checkout-1' } as never;
const executionIdentity = { repositoryId: 'repo-1', checkoutId: 'checkout-1' } as never;
function base(h: string, workflowId: string) {
  return {
    controllerHome: h,
    repository,
    executionIdentity,
    scopeId: `repository:repo-1:checkout:checkout-1:workflow:${workflowId}`,
    runId: 'run-1',
    registryScope: { kind: 'controller' as const },
    workflowId,
    inputs: { message: 'hello' },
  };
}
function sequenceDraft(): WorkflowAssetDraft {
  return {
    schemaVersion: 1,
    workflowId: 'feature.sequence',
    version: '1',
    inputContract: { message: { type: 'string', required: true } },
    steps: [{ stepId: 'echo', kind: 'script', scriptRef: 'echo', input: { message: '{{input.message}}' } }],
    scripts: { echo: { runtime: 'node', deterministic: true, body: 'process.stdout.write(process.argv[1]||"")' } },
  };
}
function graphDraft(): WorkflowGraphAssetDraft {
  return {
    schemaVersion: 2,
    workflowId: 'feature.graph',
    version: '1',
    inputContract: { message: { type: 'string', required: true } },
    entryNodeId: 'wait',
    nodes: [
      {
        kind: 'wait_event',
        nodeId: 'wait',
        sources: ['event'],
        correlation: { kind: 'input', name: 'message' },
        timeoutMs: 1000,
      },
    ],
    edges: [],
  };
}
function installSequence(h: string, status: 'installed' | 'active') {
  const written = writeWorkflowAssetContent({ kind: 'controller', controllerHome: h }, sequenceDraft());
  return registerWorkflowFeatureAsset({
    controllerHome: h,
    scope: { kind: 'controller' },
    asset: written.asset,
    contentLocation: { kind: 'controller', path: written.path },
    status,
  });
}
function installGraph(h: string) {
  const written = writeWorkflowGraphAssetContent({ kind: 'controller', controllerHome: h }, graphDraft());
  return registerWorkflowFeatureAsset({
    controllerHome: h,
    scope: { kind: 'controller' },
    asset: written.asset,
    contentLocation: { kind: 'controller', path: written.path },
    status: 'active',
  });
}
const fakeResult: WorkflowRunResult = {
  schemaVersion: 1,
  binding: { scopeId: 's', runId: 'r' },
  workflowId: 'feature.sequence',
  version: '1',
  contentDigest: 'sha256:' + 'a'.repeat(64),
  status: 'succeeded',
  nextStepIndex: 1,
  receipts: [],
  outputs: {},
};

describe('Workflow Feature Runtime', () => {
  test('routes active sequence v1 only after independent Catalog preflight', async () => {
    const h = home();
    installSequence(h, 'active');
    let called = 0;
    const result = await executeRegisteredWorkflowFeature(
      { ...base(h, 'feature.sequence'), origin: { kind: 'model', id: 'm1' } },
      {
        executeSequence: async () => {
          called++;
          return fakeResult;
        },
      },
    );
    expect(called).toBe(1);
    expect(result).toBe(fakeResult);
  });
  test('blocks inactive Workflow before any engine execution', async () => {
    const h = home();
    installSequence(h, 'installed');
    let called = 0;
    await expect(
      executeRegisteredWorkflowFeature(base(h, 'feature.sequence'), {
        executeSequence: async () => {
          called++;
          return fakeResult;
        },
      }),
    ).rejects.toThrow('WORKFLOW_INVOCATION_BLOCKED:WORKFLOW_NOT_ACTIVE');
    expect(called).toBe(0);
  });
  test('routes graph v2 to the graph engine and never coerces it through the legacy sequence interpreter', async () => {
    const h = home();
    installGraph(h);
    let sequenceCalls = 0;
    let graphCalls = 0;
    const result = await executeRegisteredWorkflowFeature(base(h, 'feature.graph'), {
      executeSequence: async () => {
        sequenceCalls++;
        return fakeResult;
      },
      executeGraph: async () => {
        graphCalls++;
        return {
          schemaVersion: 2,
          binding: { scopeId: 's', runId: 'r' },
          workflowId: 'feature.graph',
          version: '1',
          contentDigest: 'sha256:' + 'a'.repeat(64),
          status: 'waiting',
          nodes: [
            {
              nodeId: 'wait',
              status: 'waiting',
              attempts: 1,
              receipts: [],
              wait: {
                kind: 'event',
                correlationKey: 'hello',
                registeredAt: '2026-11-26T00:00:00.000Z',
                expiresAt: '2026-11-26T00:00:01.000Z',
              },
            },
          ],
          edges: [],
        };
      },
    });
    expect(sequenceCalls).toBe(0);
    expect(graphCalls).toBe(1);
    expect(result.status).toBe('waiting');
  });
  test('validates inputs at Feature boundary before dispatch', async () => {
    const h = home();
    installSequence(h, 'active');
    await expect(
      executeRegisteredWorkflowFeature(
        { ...base(h, 'feature.sequence'), inputs: {} },
        { executeSequence: async () => fakeResult },
      ),
    ).rejects.toThrow('WORKFLOW_INPUT_REQUIRED: message');
  });
  test('executes the canonical Invocation Intent from a Skill producer', async () => {
    const h = home();
    installSequence(h, 'active');
    let called = 0;
    const result = await executeWorkflowInvocationIntent(
      {
        controllerHome: h,
        repository,
        executionIdentity,
        intent: {
          schemaVersion: 1,
          workflowId: 'feature.sequence',
          registryScope: { kind: 'controller' },
          origin: { kind: 'skill', id: 'skill-1' },
          inputs: { message: 'hello' },
          binding: {
            scopeId: 'repository:repo-1:checkout:checkout-1:workflow:feature.sequence',
            runId: 'skill-run-1',
          },
        },
      },
      {
        executeSequence: async (runtimeInput) => {
          called += 1;
          expect(runtimeInput.runId).toBe('skill-run-1');
          return fakeResult;
        },
      },
    );
    expect(called).toBe(1);
    expect(result).toBe(fakeResult);
  });
});
