import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowAssetDraft, WorkflowGraphAssetDraft } from '../../packages/workflow-runtime/api/index';
import { readWorkflowRegistryEntry } from '../../src/runtime/control-plane/persistence/workflow-registry-store';
import { readWorkflowPackageBundleContent } from '../../src/runtime/workflows/package-content-store';
import { listWorkflowDiscoveryCatalog } from '../../src/runtime/workflows/package-catalog';
import { applyPackagedWorkflowProposal } from '../../src/runtime/workflows/packaged-authoring';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function home() {
  const value = mkdtempSync(join(tmpdir(), 'forge-packaged-authoring-'));
  roots.push(value);
  return value;
}
const sequence: WorkflowAssetDraft = {
  schemaVersion: 1,
  workflowId: 'auth.packaged',
  version: '1',
  title: 'Packaged authoring',
  steps: [{ stepId: 'noop', kind: 'script', scriptRef: 'noop' }],
  scripts: { noop: { runtime: 'node', deterministic: true, body: 'process.stdout.write("ok")' } },
};
function proposal(
  author: 'human' | 'ui' | 'model' | 'import' = 'model',
  draft: WorkflowAssetDraft | WorkflowGraphAssetDraft = sequence,
) {
  return {
    schemaVersion: 1 as const,
    proposalId: 'proposal-' + author,
    author: { kind: author, id: author + '-author' },
    scope: { kind: 'controller' as const },
    operation: { kind: 'create' as const },
    draft,
  };
}
function apply(h: string, p = proposal(), risk: 'read' | 'external_write' = 'read') {
  return applyPackagedWorkflowProposal({
    controllerHome: h,
    proposal: p,
    destination: { kind: 'controller', controllerHome: h },
    runtimeVersion: '1.8.2',
    package: { tags: ['authored'], risk: { level: risk, requiresApproval: risk === 'external_write' } },
    authorization: { canInstallWorkflows: true, canUpdateWorkflows: true },
  });
}

describe('Packaged Workflow Authoring', () => {
  test('model-authored Workflow is installed as a package, never as legacy_unpacked or active', () => {
    const h = home();
    const result = apply(h, proposal('model'));
    expect(result.operation).toBe('create');
    expect(result.bundle.manifest.publisher).toEqual({ kind: 'model', id: 'model-author' });
    expect(result.bundle.manifest.tags).toEqual(['authored']);
    expect(readWorkflowRegistryEntry(h, { kind: 'controller' }, 'auth.packaged')?.value.status).toBe('installed');
    expect(
      readWorkflowPackageBundleContent({ kind: 'controller', controllerHome: h }, 'auth.packaged', '1').bundle.manifest
        .packageDigest,
    ).toBe(result.bundle.manifest.packageDigest);
    expect(listWorkflowDiscoveryCatalog(h, { kind: 'controller' })[0]?.packageStatus).toBe('packaged');
  });
  test('human and UI authoring map to user publisher provenance without granting activation', () => {
    for (const author of ['human', 'ui'] as const) {
      const h = home();
      const result = apply(h, proposal(author));
      expect(result.bundle.manifest.publisher).toEqual({ kind: 'user', id: author + '-author' });
      expect(readWorkflowRegistryEntry(h, { kind: 'controller' }, 'auth.packaged')?.value.status).toBe('installed');
    }
  });
  test('sensitive authored package remains installed and requires later lifecycle approval', () => {
    const h = home();
    const result = apply(h, proposal('model'), 'external_write');
    expect(result.bundle.manifest.risk).toEqual({ level: 'external_write', requiresApproval: true });
    expect(readWorkflowRegistryEntry(h, { kind: 'controller' }, 'auth.packaged')?.value.status).toBe('installed');
  });
  test('update proposal goes through Package Update and therefore requires a new immutable version', () => {
    const h = home();
    const created = apply(h);
    const registry = readWorkflowRegistryEntry(h, { kind: 'controller' }, 'auth.packaged')!;
    const update = {
      ...proposal('model', { ...sequence, version: '2' }),
      proposalId: 'proposal-update',
      operation: { kind: 'update' as const, expectedRegistryRevision: registry.revision },
    };
    const updated = applyPackagedWorkflowProposal({
      controllerHome: h,
      proposal: update,
      destination: { kind: 'controller', controllerHome: h },
      runtimeVersion: '1.8.2',
      package: { tags: ['authored', 'v2'], risk: { level: 'read', requiresApproval: false } },
      authorization: { canInstallWorkflows: true, canUpdateWorkflows: true },
    });
    expect(created.operation).toBe('create');
    expect(updated).toMatchObject({
      operation: 'update',
      update: { previousVersion: '1', version: '2', lifecycleStatus: 'installed', activation: 'required' },
    });
    expect(updated.bundle.manifest.publisher).toEqual({ kind: 'model', id: 'model-author' });
  });
  test('graph authoring requires exact child package pins rather than silently referencing a floating workflowId', () => {
    const h = home();
    const graph: WorkflowGraphAssetDraft = {
      schemaVersion: 2,
      workflowId: 'graph.authored',
      version: '1',
      entryNodeId: 'child',
      nodes: [{ kind: 'workflow', nodeId: 'child', workflowId: 'missing.child' }],
      edges: [],
    };
    expect(() =>
      applyPackagedWorkflowProposal({
        controllerHome: h,
        proposal: proposal('model', graph),
        destination: { kind: 'controller', controllerHome: h },
        runtimeVersion: '1.8.2',
        package: { risk: { level: 'read', requiresApproval: false } },
        authorization: { canInstallWorkflows: true, canUpdateWorkflows: true },
      }),
    ).toThrow('WORKFLOW_PACKAGE_CHILD_DEPENDENCY_MISMATCH');
  });
  test('author provenance never bypasses package install authority', () => {
    const h = home();
    expect(() =>
      applyPackagedWorkflowProposal({
        controllerHome: h,
        proposal: proposal('model'),
        destination: { kind: 'controller', controllerHome: h },
        runtimeVersion: '1.8.2',
        package: { risk: { level: 'read', requiresApproval: false } },
        authorization: { canInstallWorkflows: false, canUpdateWorkflows: false },
      }),
    ).toThrow('WORKFLOW_PACKAGE_INSTALL_NOT_AUTHORIZED');
    expect(readWorkflowRegistryEntry(h, { kind: 'controller' }, 'auth.packaged')).toBeUndefined();
  });
});
