import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowAssetDraft, WorkflowGraphAssetDraft } from '../../packages/workflow-runtime/api/index';
import {
  writeWorkflowAssetContent,
  writeWorkflowGraphAssetContent,
} from '../../src/runtime/control-plane/persistence/workflow-content-store';
import {
  recordWorkflowBindings,
  registerWorkflowFeatureAsset,
  setWorkflowRegistryStatus,
} from '../../src/runtime/control-plane/persistence/workflow-registry-store';
import {
  getWorkflowCatalogEntry,
  listWorkflowCatalog,
  prepareWorkflowInvocation,
  prepareWorkflowInvocationIntent,
} from '../../src/runtime/workflows/catalog';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function home() {
  const v = mkdtempSync(join(tmpdir(), 'forge-workflow-catalog-'));
  roots.push(v);
  return v;
}
const sequenceDraft: WorkflowAssetDraft = {
  schemaVersion: 1,
  workflowId: 'demo.sequence',
  version: '1',
  title: 'Sequence demo',
  description: 'Independent sequence workflow',
  inputContract: { message: { type: 'string', required: true } },
  steps: [{ stepId: 'notify', capabilityId: 'owner.notification', input: { message: '{{input.message}}' } }],
};
const graphDraft: WorkflowGraphAssetDraft = {
  schemaVersion: 2,
  workflowId: 'demo.graph',
  version: '1',
  title: 'Graph demo',
  description: 'Independent graph workflow',
  inputContract: { case_id: { type: 'string', required: true } },
  entryNodeId: 'start',
  nodes: [
    { kind: 'capability', nodeId: 'start', capabilityId: 'case.inspect', idempotency: 'idempotent' },
    { kind: 'workflow', nodeId: 'child', workflowId: 'demo.sequence' },
  ],
  edges: [{ edgeId: 'e1', from: 'start', to: 'child', on: 'success' }],
};
function installSequence(h: string, status: 'installed' | 'active' = 'active') {
  const written = writeWorkflowAssetContent({ kind: 'controller', controllerHome: h }, sequenceDraft);
  return registerWorkflowFeatureAsset({
    controllerHome: h,
    scope: { kind: 'controller' },
    asset: written.asset,
    contentLocation: { kind: 'controller', path: written.path },
    status,
  });
}
function installGraph(h: string, status: 'installed' | 'active' = 'active') {
  const written = writeWorkflowGraphAssetContent({ kind: 'controller', controllerHome: h }, graphDraft);
  return registerWorkflowFeatureAsset({
    controllerHome: h,
    scope: { kind: 'controller' },
    asset: written.asset,
    contentLocation: { kind: 'controller', path: written.path },
    status,
  });
}

describe('Workflow first-class feature catalog', () => {
  test('discovers sequence and graph workflows through one independent catalog', () => {
    const h = home();
    const seq = installSequence(h);
    const graph = installGraph(h);
    recordWorkflowBindings({
      controllerHome: h,
      scope: { kind: 'controller' },
      expectedIdentity: seq.value,
      bindings: [{ capabilityId: 'owner.notification', pluginId: 'notify', actionId: 'send' }],
    });
    recordWorkflowBindings({
      controllerHome: h,
      scope: { kind: 'controller' },
      expectedIdentity: graph.value,
      bindings: [{ capabilityId: 'case.inspect', pluginId: 'case', actionId: 'inspect' }],
    });
    const catalog = listWorkflowCatalog(h, { kind: 'controller' });
    expect(catalog.map((x) => [x.descriptor.workflowId, x.descriptor.engine])).toEqual([
      ['demo.graph', 'graph_v2'],
      ['demo.sequence', 'sequence_v1'],
    ]);
    expect(
      getWorkflowCatalogEntry(h, { kind: 'controller' }, 'demo.graph')?.descriptor.childWorkflowDependencies,
    ).toEqual(['demo.sequence']);
  });
  test('prepares invocations from user, event, model and plugin without executing', () => {
    const h = home();
    const installed = installSequence(h);
    recordWorkflowBindings({
      controllerHome: h,
      scope: { kind: 'controller' },
      expectedIdentity: installed.value,
      bindings: [{ capabilityId: 'owner.notification', pluginId: 'notify', actionId: 'send' }],
    });
    for (const kind of ['user', 'event', 'model', 'plugin'] as const) {
      const plan = prepareWorkflowInvocation({
        controllerHome: h,
        scope: { kind: 'controller' },
        workflowId: 'demo.sequence',
        origin: { kind, id: kind + '-1' },
        inputs: { message: 'hello' },
      });
      expect(plan).toMatchObject({
        readiness: 'ready',
        authorization: 'not_authorized',
        execution: 'not_executed',
        origin: { kind },
        workflow: { workflowId: 'demo.sequence', engine: 'sequence_v1' },
        inputs: { message: 'hello' },
      });
    }
  });
  test('owns lifecycle activation independently from event/model callers', () => {
    const h = home();
    const installed = installSequence(h, 'installed');
    recordWorkflowBindings({
      controllerHome: h,
      scope: { kind: 'controller' },
      expectedIdentity: installed.value,
      bindings: [{ capabilityId: 'owner.notification', pluginId: 'notify', actionId: 'send' }],
    });
    const before = prepareWorkflowInvocation({
      controllerHome: h,
      scope: { kind: 'controller' },
      workflowId: 'demo.sequence',
      origin: { kind: 'model', id: 'model-1' },
      inputs: { message: 'hello' },
    });
    expect(before).toMatchObject({ readiness: 'blocked', blockers: ['WORKFLOW_NOT_ACTIVE'] });
    setWorkflowRegistryStatus({
      controllerHome: h,
      scope: { kind: 'controller' },
      workflowId: 'demo.sequence',
      status: 'active',
      expectedRevision: 2,
    });
    const after = prepareWorkflowInvocation({
      controllerHome: h,
      scope: { kind: 'controller' },
      workflowId: 'demo.sequence',
      origin: { kind: 'event', id: 'event-1' },
      inputs: { message: 'hello' },
    });
    expect(after).toMatchObject({ readiness: 'ready', authorization: 'not_authorized', execution: 'not_executed' });
  });

  test('validates workflow inputs independently of the caller', () => {
    const h = home();
    const installed = installSequence(h);
    recordWorkflowBindings({
      controllerHome: h,
      scope: { kind: 'controller' },
      expectedIdentity: installed.value,
      bindings: [{ capabilityId: 'owner.notification', pluginId: 'notify', actionId: 'send' }],
    });
    expect(() =>
      prepareWorkflowInvocation({
        controllerHome: h,
        scope: { kind: 'controller' },
        workflowId: 'demo.sequence',
        origin: { kind: 'model' },
        inputs: {},
      }),
    ).toThrow('WORKFLOW_INPUT_REQUIRED: message');
    expect(() =>
      prepareWorkflowInvocation({
        controllerHome: h,
        scope: { kind: 'controller' },
        workflowId: 'demo.sequence',
        origin: { kind: 'event' },
        inputs: { message: 'x', extra: true },
      }),
    ).toThrow('WORKFLOW_INPUT_UNKNOWN: extra');
  });
  test('reports lifecycle, capability and child-workflow blockers instead of hiding them in event code', () => {
    const h = home();
    installGraph(h, 'installed');
    const plan = prepareWorkflowInvocation({
      controllerHome: h,
      scope: { kind: 'controller' },
      workflowId: 'demo.graph',
      origin: { kind: 'user' },
      inputs: { case_id: 'c1' },
    });
    expect(plan.readiness).toBe('blocked');
    expect(plan.blockers).toEqual([
      'WORKFLOW_NOT_ACTIVE',
      'WORKFLOW_CAPABILITY_BINDING_MISSING:case.inspect',
      'WORKFLOW_CHILD_NOT_ACTIVE:demo.sequence',
    ]);
    const graph = getWorkflowCatalogEntry(h, { kind: 'controller' }, 'demo.graph')!;
    expect(graph.descriptor.engine).toBe('graph_v2');
  });
  test('keeps historical registry entries without engine compatible as sequence v1', () => {
    const h = home();
    const written = writeWorkflowAssetContent({ kind: 'controller', controllerHome: h }, sequenceDraft);
    const registered = registerWorkflowFeatureAsset({
      controllerHome: h,
      scope: { kind: 'controller' },
      asset: written.asset,
      contentLocation: { kind: 'controller', path: written.path },
      status: 'active',
    });
    expect(registered.value.engine).toBe('sequence_v1');
  });
  test('uses one Invocation Intent contract for Schedule, Skill, Plugin and Event callers', () => {
    const h = home();
    const installed = installSequence(h);
    recordWorkflowBindings({
      controllerHome: h,
      scope: { kind: 'controller' },
      expectedIdentity: installed.value,
      bindings: [{ capabilityId: 'owner.notification', pluginId: 'notify', actionId: 'send' }],
    });
    for (const kind of ['schedule', 'skill', 'plugin', 'event'] as const) {
      const plan = prepareWorkflowInvocationIntent(h, {
        schemaVersion: 1,
        workflowId: 'demo.sequence',
        registryScope: { kind: 'controller' },
        origin: { kind, id: `${kind}-1` },
        inputs: { message: 'hello' },
        binding: { scopeId: 'repository:r:workflow:demo.sequence', runId: `${kind}-run` },
      });
      expect(plan).toMatchObject({
        readiness: 'ready',
        origin: { kind },
        binding: { runId: `${kind}-run` },
        execution: 'not_executed',
      });
    }
  });
  test('Catalog includes compensation and reconciliation capabilities in readiness dependencies', () => {
    const h = home();
    const draft: WorkflowGraphAssetDraft = {
      schemaVersion: 2,
      workflowId: 'demo.reconciliation-deps',
      version: '1',
      failurePolicy: { mode: 'compensate' },
      entryNodeId: 'effect',
      nodes: [
        {
          kind: 'capability',
          nodeId: 'effect',
          capabilityId: 'effect.write',
          idempotency: 'non_idempotent',
          reconcileWithCapabilityId: 'effect.observe',
          compensation: {
            kind: 'capability',
            capabilityId: 'effect.undo',
            idempotency: 'non_idempotent',
            reconcileWithCapabilityId: 'effect.observe_undo',
          },
        },
      ],
      edges: [],
    };
    const written = writeWorkflowGraphAssetContent({ kind: 'controller', controllerHome: h }, draft);
    registerWorkflowFeatureAsset({
      controllerHome: h,
      scope: { kind: 'controller' },
      asset: written.asset,
      contentLocation: { kind: 'controller', path: written.path },
      status: 'active',
    });
    const entry = getWorkflowCatalogEntry(h, { kind: 'controller' }, 'demo.reconciliation-deps');
    expect(entry?.descriptor.capabilityDependencies).toEqual([
      'effect.observe',
      'effect.observe_undo',
      'effect.undo',
      'effect.write',
    ]);
    expect(entry?.missingCapabilityBindings).toEqual(entry?.descriptor.capabilityDependencies);
  });
});
