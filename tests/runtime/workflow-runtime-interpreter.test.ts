import { createWorkContract } from '../../packages/kernel/work/api/index';
import { claimControllerSession, mintControllerSessionAuthority } from '../../packages/kernel/controller/api/index';
import { startExecutionSession } from '../../src/runtime/control-plane/execution/session-store';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RepositoryRecord } from '../../src/cli/repositories/types';
import { writeWorkflowAssetContent } from '../../src/runtime/control-plane/persistence/workflow-content-store';
import { readWorkflowRun, writeWorkflowRunCheckpoint } from '../../src/runtime/control-plane/persistence/workflow-run-store';
import { recordWorkflowBindings, registerWorkflowAsset } from '../../src/runtime/control-plane/persistence/workflow-registry-store';
import { executeRegisteredWorkflow } from '../../src/runtime/workflows/runtime';
import type { WorkflowAssetDraft } from '../../packages/workflow-runtime/api/index';

const roots: string[] = [];
const controllers = new Map<string, { controllerId: string; authorityId: string }>();
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});
function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
function repository(root: string): RepositoryRecord {
  return {
    repoId: 'repo-workflow-test',
    displayName: 'workflow test',
    enabled: true,
    localRoot: root,
    canonicalRoot: root,
    activeCheckoutId: 'checkout-workflow-test',
    remoteUrl: undefined,
    defaultBranch: 'main',
    repositoryType: 'git',
    lastSeenAt: new Date().toISOString(),
  } as RepositoryRecord;
}
function identity(root: string) {
  return {
    schemaVersion: 1 as const,
    authority: 'repository' as const,
    repositoryId: 'repo-workflow-test',
    checkoutId: 'checkout-workflow-test',
    canonicalRoot: root,
    workId: 'work-workflow-test',
  };
}
function draft(): WorkflowAssetDraft {
  return {
    schemaVersion: 1,
    workflowId: 'runtime-proof',
    version: '1.0.0',
    inputContract: {
      url: { type: 'string', required: true },
      title: { type: 'string', required: true },
    },
    requiredCapabilities: ['browser.navigate', 'browser.submit'],
    steps: [
      { stepId: 'open', capabilityId: 'browser.navigate', idempotency: 'idempotent', input: { url: '{{input.url}}' } },
      { stepId: 'normalize', kind: 'script', scriptRef: 'normalize', idempotency: 'idempotent', input: { title: '{{input.title}}' } },
    ],
    scripts: { normalize: { runtime: 'node', deterministic: true, body: 'process.stdout.write(process.argv[1] ?? "")' } },
  };
}

async function installedRuntime(controllerHome: string, root: string, assetDraft: WorkflowAssetDraft) {
  const store = { controllerHome, repoId: 'repo-workflow-test' };
  createWorkContract(store, { workId: 'work-workflow-test', repoId: store.repoId, checkoutId: 'checkout-workflow-test', mode: 'direct_control',
    objective: 'workflow authority fixture', acceptanceCriteria: ['safe execution'], constraints: {}, allowedPaths: [], forbiddenPaths: [], checks: [], requestedBy: 'user' });
  startExecutionSession(controllerHome, { sessionId: 'session', principalId: 'controller', controllerInstanceId: 'instance' });
  const capability = mintControllerSessionAuthority();
  claimControllerSession(store, { workId: 'work-workflow-test', controllerId: 'controller', controllerType: 'chatgpt', sessionId: 'session',
    principalId: 'controller', controllerInstanceId: 'instance', authorityDigest: capability.authorityDigest, leaseMs: 60_000 });
  controllers.set(controllerHome, { controllerId: 'controller', authorityId: capability.authorityId });
  const written = writeWorkflowAssetContent({ kind: 'controller', controllerHome }, assetDraft);
  const installed = registerWorkflowAsset({
    controllerHome,
    scope: { kind: 'controller' },
    asset: written.asset,
    contentLocation: { kind: 'controller', path: written.path },
    status: 'active',
  });
  recordWorkflowBindings({
    controllerHome,
    scope: { kind: 'controller' },
    expectedIdentity: written.asset,
    expectedRevision: installed.revision,
    bindings: [
      { capabilityId: 'browser.navigate', providerId: 'browser.default', pluginId: 'browser', actionId: 'navigate' },
      { capabilityId: 'browser.submit', providerId: 'browser.default', pluginId: 'browser', actionId: 'submit' },
    ],
  });
  return { written, repository: repository(root) };
}

describe('thin Workflow Runtime interpreter', () => {
  test('validates typed inputs, resolves references and delegates capability/script execution in order', async () => {
    const controllerHome = temp('forge-workflow-runtime-home-');
    const root = temp('forge-workflow-runtime-repo-');
    const { repository: repo } = await installedRuntime(controllerHome, root, draft());
    const calls: string[] = [];
    const submittedArgs: Record<string, unknown>[] = [];
    const result = await executeRegisteredWorkflow({
      controllerHome,
      repository: repo,
      executionIdentity: identity(root),
      controller: controllers.get(controllerHome)!,
      workId: 'work-workflow-test',
      runId: 'run-1',
      registryScope: { kind: 'controller' },
      workflowId: 'runtime-proof',
      inputs: { url: 'https://example.test/new', title: 'Human title is not machine state' },
    }, {
      submitPluginAction: (async (_home: string, _repo: RepositoryRecord, request: any) => {
        calls.push(`capability:${request.pluginId}/${request.actionId}`);
        submittedArgs.push(request.args);
        return {
          manifest: {}, action: {}, job: {}, deduplicated: false, result: { navigated: true },
          receipt: { schemaVersion: 1, receiptId: 'receipt-open', requestId: request.requestId, repoId: repo.repoId, pluginId: request.pluginId, actionId: request.actionId, semanticKey: 'key', status: 'succeeded', createdAt: new Date().toISOString() },
        } as any;
      }) as any,
      executeCommand: (async (input: any) => {
        calls.push(`script:${input.command[0]}`);
        expect(input.workId).toBe('work-workflow-test');
        expect(JSON.stringify(input.command)).toContain('Human title is not machine state');
        return { route: 'process_direct', reason: 'test', ok: true, exitCode: 0, stdout: 'normalized', stderr: '', durableSideEffects: { executionJobCount: 0, localJobCount: 0, workerSpawnCount: 0, projectionUpdateCount: 0 } };
      }) as any,
    });
    expect(result.status).toBe('succeeded');
    expect(calls).toEqual(['capability:browser/navigate', 'script:node']);
    expect(submittedArgs).toEqual([{ url: 'https://example.test/new' }]);
    const stored = readWorkflowRun(controllerHome, 'work-workflow-test', 'run-1')!;
    expect(stored.value.status).toBe('succeeded');
    expect(JSON.stringify(stored.value)).not.toContain('Human title is not machine state');
    expect(stored.value.inputDigest).toStartWith('sha256:');
  });

  test('non-idempotent outcome_unknown requires reconciliation and the same run cannot blind replay', async () => {
    const controllerHome = temp('forge-workflow-runtime-reconcile-home-');
    const root = temp('forge-workflow-runtime-reconcile-repo-');
    const asset = draft();
    asset.steps = [
      { stepId: 'publish', capabilityId: 'browser.submit', idempotency: 'non_idempotent', reconcileWithCapabilityId: 'browser.query', input: { title: '{{input.title}}' } },
      { stepId: 'after', capabilityId: 'browser.navigate', idempotency: 'idempotent', input: { url: '{{input.url}}' } },
    ];
    const { repository: repo } = await installedRuntime(controllerHome, root, asset);
    let calls = 0;
    const dependencies = {
      submitPluginAction: (async (_home: string, _repo: RepositoryRecord, request: any) => {
        calls += 1;
        return {
          manifest: {}, action: {}, job: { status: 'human_attention_required' }, deduplicated: false, result: { outcome: 'outcome_unknown' },
          receipt: { schemaVersion: 1, receiptId: 'receipt-unknown', requestId: request.requestId, repoId: repo.repoId, pluginId: request.pluginId, actionId: request.actionId, semanticKey: 'key', status: 'failed', effectOutcome: 'outcome_unknown', createdAt: new Date().toISOString(), error: { code: 'PLUGIN_BROWSER_MUTATION_OUTCOME_UNKNOWN', message: 'dispatch outcome is unknown' } },
        } as any;
      }) as any,
    };
    const request = {
      controllerHome,
      repository: repo,
      executionIdentity: identity(root),
      controller: controllers.get(controllerHome)!,
      workId: 'work-workflow-test',
      runId: 'run-reconcile',
      registryScope: { kind: 'controller' } as const,
      workflowId: 'runtime-proof',
      inputs: { url: 'https://example.test', title: 'publish once' },
    };
    const result = await executeRegisteredWorkflow(request, dependencies);
    expect(result.status).toBe('reconcile_required');
    expect(result.reconcileStepId).toBe('publish');
    expect(result.reconcileWithCapabilityId).toBe('browser.query');
    expect(result.nextStepIndex).toBe(0);
    expect(calls).toBe(1);
    await expect(executeRegisteredWorkflow(request, dependencies)).rejects.toThrow('WORKFLOW_RUN_RECONCILIATION_REQUIRED: publish');
    expect(calls).toBe(1);
  });

  test('a retained succeeded checkpoint cannot authenticate itself without the canonical provider receipt', async () => {
    const controllerHome = temp('forge-workflow-runtime-forged-checkpoint-home-');
    const root = temp('forge-workflow-runtime-forged-checkpoint-repo-');
    const { written, repository: repo } = await installedRuntime(controllerHome, root, draft());
    const inputs = { url: 'https://example.test', title: 'recover safely' };
    writeWorkflowRunCheckpoint({ controllerHome, inputs, checkpoint: {
      schemaVersion: 1, binding: { workId: 'work-workflow-test', runId: 'run-forged-checkpoint' }, workflowId: written.asset.workflowId,
      version: written.asset.version, contentDigest: written.asset.contentDigest, status: 'running', nextStepIndex: 1,
      receipts: [{ stepId: 'open', outcome: 'succeeded', receiptRef: 'missing-provider-receipt', recordedAt: new Date().toISOString() }], outputs: { open: {} },
    } });
    let dispatched = 0;
    await expect(executeRegisteredWorkflow({ controllerHome, repository: repo, executionIdentity: identity(root), controller: controllers.get(controllerHome)!,
      workId: 'work-workflow-test', runId: 'run-forged-checkpoint', registryScope: { kind: 'controller' }, workflowId: 'runtime-proof', inputs }, {
      submitPluginAction: (async () => { dispatched += 1; throw new Error('must not dispatch'); }) as any,
    })).rejects.toThrow('WORKFLOW_RETAINED_PLUGIN_RECEIPT_MISMATCH: open');
    expect(dispatched).toBe(0);
  });

  test('rejects unknown or mistyped inputs before any execution', async () => {
    const controllerHome = temp('forge-workflow-runtime-input-home-');
    const root = temp('forge-workflow-runtime-input-repo-');
    const { repository: repo } = await installedRuntime(controllerHome, root, draft());
    const base = {
      controllerHome,
      repository: repo,
      executionIdentity: identity(root),
      controller: controllers.get(controllerHome)!,
      workId: 'work-workflow-test',
      registryScope: { kind: 'controller' } as const,
      workflowId: 'runtime-proof',
    };
    await expect(executeRegisteredWorkflow({ ...base, runId: 'run-bad-type', inputs: { url: 3, title: 'x' } })).rejects.toThrow('WORKFLOW_INPUT_TYPE_MISMATCH: url:string');
    await expect(executeRegisteredWorkflow({ ...base, runId: 'run-unknown', inputs: { url: 'x', title: 'y', surprise: true } })).rejects.toThrow('WORKFLOW_INPUT_UNKNOWN: surprise');
  });
});

test('checkpoint outputs refuse lossy JSON values and normalize retained fields', async () => {
  const { retainWorkflowOutput } = await import('../../packages/workflow-runtime/api/index');
  const step = { stepId: 'output', capabilityId: 'read', idempotency: 'idempotent' as const,
    outputContract: { data: { type: 'json' as const, required: true } } };
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const data of [{ n: NaN }, { n: Infinity }, { f: () => 1 }, { x: undefined }, new Date(), cycle, [undefined], Array(2)]) {
    expect(() => retainWorkflowOutput(step, { data })).toThrow('WORKFLOW_JSON_VALUE_INVALID');
  }
  expect(retainWorkflowOutput(step, { data: { count: 0, missing: null }, undeclared: 'discard' })).toEqual({ data: { count: 0, missing: null } });
});

test('stale claim and wrong checkout are rejected before dispatch', async () => {
  const controllerHome = temp('forge-workflow-owner-home-'), root = temp('forge-workflow-owner-repo-');
  const { repository } = await installedRuntime(controllerHome, root, draft());
  const input = { controllerHome, repository, executionIdentity: identity(root), controller: controllers.get(controllerHome)!,
    workId: 'work-workflow-test', runId: 'owner-test', registryScope: { kind: 'controller' as const }, workflowId: 'runtime-proof',
    inputs: { url: 'https://example.test', title: 'test' } };
  await expect(executeRegisteredWorkflow({ ...input, controller: { ...input.controller, authorityId: 'stale' } })).rejects.toThrow('WORKFLOW_CONTROLLER_AUTHORITY_STALE');
  await expect(executeRegisteredWorkflow({ ...input, executionIdentity: { ...input.executionIdentity, checkoutId: 'foreign' } })).rejects.toThrow('WORKFLOW_EXECUTION_IDENTITY_MISMATCH');
  expect(readWorkflowRun(controllerHome, input.workId, input.runId)).toBeUndefined();
});

test('different runs cannot dispatch concurrently for the same Work', async () => {
  const controllerHome = temp('forge-workflow-race-home-'), root = temp('forge-workflow-race-repo-');
  const asset = draft(); asset.steps = [asset.steps[0]!];
  const { repository } = await installedRuntime(controllerHome, root, asset);
  const input = { controllerHome, repository, executionIdentity: identity(root), controller: controllers.get(controllerHome)!,
    workId: 'work-workflow-test', runId: 'first', registryScope: { kind: 'controller' as const }, workflowId: 'runtime-proof',
    inputs: { url: 'https://example.test', title: 'test' } };
  let dispatched = 0;
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const dependencies = { submitPluginAction: (async () => {
    dispatched++; entered(); await blocked;
    return { receipt: { receiptId: 'receipt', status: 'succeeded' }, result: {} };
  }) as any };
  const first = executeRegisteredWorkflow(input, dependencies);
  await started;
  try {
    await expect(executeRegisteredWorkflow({ ...input, runId: 'second' }, dependencies)).rejects.toThrow('LOCK_HELD');
    expect(dispatched).toBe(1);
  } finally { release(); await first; }
});


test('sensitive retained outputs are refused before a Workflow checkpoint is persisted', async () => {
  const controllerHome = temp('forge-workflow-sensitive-home-'), root = temp('forge-workflow-sensitive-repo-');
  const asset = draft();
  asset.steps = [{
    stepId: 'read-sensitive', capabilityId: 'browser.navigate', idempotency: 'idempotent',
    input: { url: '{{input.url}}' }, outputContract: { access_token: { type: 'string', required: true } },
  }];
  const { repository } = await installedRuntime(controllerHome, root, asset);
  const runId = 'sensitive-output';
  await expect(executeRegisteredWorkflow({
    controllerHome, repository, executionIdentity: identity(root), controller: controllers.get(controllerHome)!,
    workId: 'work-workflow-test', runId, registryScope: { kind: 'controller' }, workflowId: 'runtime-proof',
    inputs: { url: 'https://example.test', title: 'not retained' },
  }, {
    submitPluginAction: (async (_home: string, repo: RepositoryRecord, request: any) => ({
      manifest: {}, action: {}, job: {}, deduplicated: false, result: { access_token: 'not-a-secret-pattern-but-a-forbidden-field' },
      receipt: { schemaVersion: 1, receiptId: 'receipt-sensitive', requestId: request.requestId, repoId: repo.repoId,
        pluginId: request.pluginId, actionId: request.actionId, semanticKey: 'key', status: 'succeeded', createdAt: new Date().toISOString() },
    })) as any,
  })).rejects.toThrow('CONTROL_PLANE_METADATA_FIELD_REFUSED: workflow_run.outputs.read-sensitive.access_token');
  const stored = readWorkflowRun(controllerHome, 'work-workflow-test', runId)!;
  expect(stored.value.status).toBe('running');
  expect(stored.value.inFlightStepId).toBe('read-sensitive');
  expect(stored.value.outputs).toEqual({});
  expect(JSON.stringify(stored.value)).not.toContain('not-a-secret-pattern-but-a-forbidden-field');
});

test('publication receipt binds real publication identity and is durably persisted with verification evidence', async () => {
  const controllerHome = temp('forge-workflow-publication-home-'), root = temp('forge-workflow-publication-repo-');
  const contentDigest = `sha256:${'a'.repeat(64)}`;
  const publishedAt = '2026-09-08T00:00:00.000Z';
  const asset = draft();
  asset.inputContract = {
    url: { type: 'string', required: true }, title: { type: 'string', required: true }, account: { type: 'string', required: true },
  };
  asset.steps = [
    { stepId: 'publish', capabilityId: 'browser.submit', idempotency: 'non_idempotent', reconcileWithCapabilityId: 'browser.navigate', input: { title: '{{input.title}}' } },
    { stepId: 'discover', capabilityId: 'browser.navigate', idempotency: 'idempotent', input: { url: '{{input.url}}' }, outputContract: {
      postId: { type: 'string', required: true }, postUrl: { type: 'string', required: true }, contentDigest: { type: 'string', required: true },
    } },
    { stepId: 'verify', capabilityId: 'browser.navigate', idempotency: 'idempotent', input: { url: '{{output.discover.postUrl}}' }, outputContract: {
      verified: { type: 'boolean', required: true },
    } },
  ];
  asset.publication = {
    channel: 'xiaohongshu', accountInput: 'account', effectStepId: 'publish',
    contentDigestOutput: { stepId: 'discover', field: 'contentDigest' },
    postIdOutput: { stepId: 'discover', field: 'postId' }, postUrlOutput: { stepId: 'discover', field: 'postUrl' },
    verificationStepIds: ['verify'],
  };
  const { repository } = await installedRuntime(controllerHome, root, asset);
  let call = 0;
  const runId = 'publication-receipt';
  const result = await executeRegisteredWorkflow({
    controllerHome, repository, executionIdentity: identity(root), controller: controllers.get(controllerHome)!,
    workId: 'work-workflow-test', runId, registryScope: { kind: 'controller' }, workflowId: 'runtime-proof',
    inputs: { url: 'https://creator.example.test/post/123', title: 'publish once', account: 'xhs-account-1' },
  }, {
    submitPluginAction: (async (_home: string, repo: RepositoryRecord, request: any) => {
      call += 1;
      const output = call === 1 ? { matched: true, verified: true }
        : call === 2 ? { postId: 'post-123', postUrl: 'https://www.xiaohongshu.com/explore/post-123', contentDigest }
          : { verified: true };
      return {
        manifest: {}, action: {}, job: {}, deduplicated: false, result: output,
        receipt: { schemaVersion: 1, receiptId: `receipt-${call}`, requestId: request.requestId, repoId: repo.repoId,
          pluginId: request.pluginId, actionId: request.actionId, semanticKey: `key-${call}`, status: 'succeeded',
          createdAt: call === 1 ? publishedAt : `2026-09-08T00:00:0${call}.000Z` },
      } as any;
    }) as any,
  });
  expect(result.status).toBe('succeeded');
  expect(result.publicationReceipt).toMatchObject({
    workflowId: 'runtime-proof', channel: 'xiaohongshu', account: 'xhs-account-1', postId: 'post-123',
    postUrl: 'https://www.xiaohongshu.com/explore/post-123', contentDigest,
    timeSource: 'effect_receipt_recorded_at', effectReceiptRef: 'receipt-1', verificationEvidenceRefs: ['receipt-3'],
  });
  expect(result.publicationReceipt?.receiptId).toStartWith('workflow-publication-');
  const stored = readWorkflowRun(controllerHome, 'work-workflow-test', runId)!;
  const effectReceipt = stored.value.receipts.find(receipt => receipt.stepId === 'publish')!;
  expect(result.publicationReceipt?.publishedAt).toBe(effectReceipt.recordedAt);
  expect(Date.parse(result.publicationReceipt!.publishedAt)).toBeGreaterThanOrEqual(Date.parse(publishedAt) - 24 * 60 * 60 * 1000);
  expect(stored.value.publicationReceipt).toEqual(result.publicationReceipt);
  expect(stored.value.evidenceRef).toStartWith('workflow-run-');
});
