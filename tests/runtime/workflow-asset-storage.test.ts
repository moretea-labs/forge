import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  workflowContentIdentity,
  type WorkflowAssetDraft,
} from '../../packages/workflow-runtime/api/index';
import {
  readWorkflowAssetContent,
  writeWorkflowAssetContent,
  type ProjectWorkflowAssetContract,
} from '../../src/runtime/control-plane/persistence/workflow-content-store';
import {
  readWorkflowRegistryEntry,
  recordWorkflowBindings,
  registerWorkflowAsset,
} from '../../src/runtime/control-plane/persistence/workflow-registry-store';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});
function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function draft(version = '1.0.0', prompt = 'prepare one generic note'): WorkflowAssetDraft {
  return {
    schemaVersion: 1,
    workflowId: 'publish-note',
    version,
    title: 'Publish note',
    credentialRefs: { account: { credentialRef: 'credential://existing/account' } },
    requiredCapabilities: ['browser.navigate', 'browser.fill'],
    steps: [
      { stepId: 'open', capabilityId: 'browser.navigate', idempotency: 'idempotent' },
      { stepId: 'submit', capabilityId: 'browser.fill', idempotency: 'non_idempotent', reconcileWithCapabilityId: 'browser.query' },
    ],
    prompts: { compose: prompt },
    scripts: { normalize: { runtime: 'node', body: 'process.stdout.write("normalized")', deterministic: true } },
    templates: { note: '{{title}}\n{{body}}' },
    selectors: { title: '[data-title]' },
    resources: { guidance: 'Human-editable runtime content.' },
  };
}

describe('Workflow Asset content and machine registry authority', () => {
  test('stores editable content under Controller Home while SQLite keeps metadata-only bindings', () => {
    const controllerHome = temp('forge-workflow-controller-');
    const written = writeWorkflowAssetContent({ kind: 'controller', controllerHome }, draft());
    expect(written.path).toContain(join(controllerHome, 'workflows', 'publish-note', '1.0.0', 'workflow.json'));
    expect(readWorkflowAssetContent({ kind: 'controller', controllerHome }, 'publish-note', '1.0.0').asset).toEqual(written.asset);

    const installed = registerWorkflowAsset({
      controllerHome,
      scope: { kind: 'controller' },
      asset: written.asset,
      contentLocation: { kind: 'controller', path: written.path },
      status: 'active',
      now: new Date('2026-09-06T00:00:00.000Z'),
    });
    const bound = recordWorkflowBindings({
      controllerHome,
      scope: { kind: 'controller' },
      expectedIdentity: workflowContentIdentity(written.asset),
      capabilityGrantRefs: ['grant-browser-publish'],
      bindings: [{ capabilityId: 'browser.navigate', providerId: 'browser.default' }],
      executionReceiptReuseRefs: ['receipt-safe-reuse'],
      expectedRevision: installed.revision,
      now: new Date('2026-09-06T00:01:00.000Z'),
    });
    expect(bound.value.capabilityGrantRefs).toEqual(['grant-browser-publish']);
    expect(bound.value.bindings).toEqual([{ capabilityId: 'browser.navigate', providerId: 'browser.default' }]);

    expect(() => recordWorkflowBindings({
      controllerHome,
      scope: { kind: 'controller' },
      expectedIdentity: workflowContentIdentity(written.asset),
      bindings: [
        { capabilityId: 'browser.navigate', providerId: 'browser.default' },
        { capabilityId: 'browser.navigate', providerId: 'browser.secondary' },
      ],
      expectedRevision: bound.revision,
    })).toThrow('WORKFLOW_REGISTRY_BINDING_CAPABILITY_DUPLICATE: browser.navigate');

    const machinePayload = JSON.stringify(readWorkflowRegistryEntry(controllerHome, { kind: 'controller' }, 'publish-note')!.value);
    expect(machinePayload).not.toContain('prepare one generic note');
    expect(machinePayload).not.toContain('process.stdout.write');
    expect(machinePayload).not.toContain('{{title}}');
    expect(readFileSync(written.path, 'utf8')).toContain('prepare one generic note');
  });

  test('content identity changes invalidate stale grants, bindings and receipt reuse', () => {
    const controllerHome = temp('forge-workflow-invalidation-');
    const first = writeWorkflowAssetContent({ kind: 'controller', controllerHome }, draft());
    const installed = registerWorkflowAsset({ controllerHome, scope: { kind: 'controller' }, asset: first.asset, contentLocation: { kind: 'controller', path: first.path } });
    recordWorkflowBindings({
      controllerHome,
      scope: { kind: 'controller' },
      expectedIdentity: workflowContentIdentity(first.asset),
      capabilityGrantRefs: ['grant-1'],
      bindings: [{ capabilityId: 'browser.navigate', providerId: 'browser.default' }],
      executionReceiptReuseRefs: ['receipt-1'],
      expectedRevision: installed.revision,
    });

    const second = writeWorkflowAssetContent({ kind: 'controller', controllerHome }, draft('1.0.1', 'changed human content'));
    const refreshed = registerWorkflowAsset({
      controllerHome,
      scope: { kind: 'controller' },
      asset: second.asset,
      contentLocation: { kind: 'controller', path: second.path },
    });
    expect(second.asset.contentDigest).not.toBe(first.asset.contentDigest);
    expect(refreshed.value.capabilityGrantRefs).toEqual([]);
    expect(refreshed.value.bindings).toEqual([]);
    expect(refreshed.value.executionReceiptReuseRefs).toEqual([]);
    expect(() => recordWorkflowBindings({
      controllerHome,
      scope: { kind: 'controller' },
      expectedIdentity: workflowContentIdentity(first.asset),
      bindings: [],
    })).toThrow('WORKFLOW_REGISTRY_CONTENT_IDENTITY_CHANGED');
  });

  test('project-owned content requires an explicit bounded project contract', () => {
    const projectRoot = temp('forge-workflow-project-');
    const contract: ProjectWorkflowAssetContract = {
      schemaVersion: 1,
      projectId: 'sample-project',
      projectRoot,
      workflowAssetDirectory: 'automation/workflows',
    };
    const written = writeWorkflowAssetContent({ kind: 'project', contract }, draft());
    expect(written.path).toContain(join(projectRoot, 'automation', 'workflows'));

    expect(() => writeWorkflowAssetContent({
      kind: 'project',
      contract: { ...contract, workflowAssetDirectory: '../outside' },
    }, draft())).toThrow('WORKFLOW_PROJECT_ASSET_DIRECTORY_OUTSIDE_PROJECT');
    expect(() => writeWorkflowAssetContent({
      kind: 'project',
      contract: { ...contract, workflowAssetDirectory: '.forge/workflows' },
    }, draft())).toThrow('WORKFLOW_PROJECT_ASSET_DIRECTORY_HIDDEN_RUNTIME_STATE_FORBIDDEN');
  });
});
