import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeWorkflowAsset } from '../../packages/workflow-runtime/domain/workflow-asset';
import { materializeWorkflowGraphAsset } from '../../packages/workflow-runtime/domain/workflow-graph';
import { materializeWorkflowPackageBundle } from '../../packages/workflow-runtime/domain/workflow-package-bundle';
import {
  writeWorkflowAssetContent,
  writeWorkflowGraphAssetContent,
} from '../../src/runtime/control-plane/persistence/workflow-content-store';
import {
  recordWorkflowBindings,
  registerWorkflowFeatureAsset,
} from '../../src/runtime/control-plane/persistence/workflow-registry-store';
import { preflightWorkflowPackageImport } from '../../src/runtime/workflows/package-import';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function home() {
  const value = mkdtempSync(join(tmpdir(), 'forge-workflow-package-import-'));
  roots.push(value);
  return value;
}
const child = materializeWorkflowAsset({
  schemaVersion: 1,
  workflowId: 'child.workflow',
  version: '1',
  steps: [{ stepId: 'noop', kind: 'script', scriptRef: 'noop' }],
  scripts: { noop: { runtime: 'node', deterministic: true, body: 'process.stdout.write(\"ok\")' } },
});
const graph = materializeWorkflowGraphAsset({
  schemaVersion: 2,
  workflowId: 'parent.workflow',
  version: '2',
  entryNodeId: 'inspect',
  nodes: [
    { kind: 'capability', nodeId: 'inspect', capabilityId: 'case.inspect' },
    { kind: 'workflow', nodeId: 'child', workflowId: 'child.workflow' },
  ],
  edges: [{ edgeId: 'e1', from: 'inspect', to: 'child', on: 'success' }],
});
function bundle() {
  return materializeWorkflowPackageBundle(graph, {
    runtimeCompatibility: { minRuntimeVersion: '1.8.0', maxRuntimeVersionExclusive: '2.0.0' },
    requiredWorkflows: [{ workflowId: 'child.workflow', version: '1', contentDigest: child.contentDigest }],
    risk: { level: 'workspace_write', requiresApproval: false },
    publisher: { kind: 'import', id: 'bundle-source' },
  });
}
function installChild(h: string, status: 'active' | 'installed' = 'active') {
  const written = writeWorkflowAssetContent(
    { kind: 'controller', controllerHome: h },
    {
      schemaVersion: 1,
      workflowId: 'child.workflow',
      version: '1',
      steps: [{ stepId: 'noop', kind: 'script', scriptRef: 'noop' }],
      scripts: { noop: { runtime: 'node', deterministic: true, body: 'process.stdout.write(\"ok\")' } },
    },
  );
  return registerWorkflowFeatureAsset({
    controllerHome: h,
    scope: { kind: 'controller' },
    asset: written.asset,
    contentLocation: { kind: 'controller', path: written.path },
    status,
  });
}

describe('Workflow Package import preflight', () => {
  test('allows install but blocks activation while child and capability bindings are unresolved', () => {
    const h = home();
    const result = preflightWorkflowPackageImport({
      controllerHome: h,
      scope: { kind: 'controller' },
      bundle: bundle(),
      runtimeVersion: '1.8.2',
    });
    expect(result.canInstall).toBe(true);
    expect(result.canActivate).toBe(false);
    expect(result.childDependencies).toEqual([
      expect.objectContaining({ workflowId: 'child.workflow', status: 'missing' }),
    ]);
    expect(result.missingCapabilityBindings).toEqual(['case.inspect']);
    expect(result.lifecycle).toEqual({ installStatus: 'installed', activation: 'not_requested' });
  });
  test('becomes activation-ready only when exact child identity and local capability binding exist', () => {
    const h = home();
    installChild(h, 'active');
    const parentBundle = bundle();
    const written = writeWorkflowGraphAssetContent(
      { kind: 'controller', controllerHome: h },
      {
        schemaVersion: 2,
        workflowId: 'parent.workflow',
        version: '2',
        entryNodeId: 'inspect',
        nodes: [
          { kind: 'capability', nodeId: 'inspect', capabilityId: 'case.inspect' },
          { kind: 'workflow', nodeId: 'child', workflowId: 'child.workflow' },
        ],
        edges: [{ edgeId: 'e1', from: 'inspect', to: 'child', on: 'success' }],
      },
    );
    const registered = registerWorkflowFeatureAsset({
      controllerHome: h,
      scope: { kind: 'controller' },
      asset: written.asset,
      contentLocation: { kind: 'controller', path: written.path },
      status: 'installed',
    });
    recordWorkflowBindings({
      controllerHome: h,
      scope: { kind: 'controller' },
      expectedIdentity: registered.value,
      bindings: [{ capabilityId: 'case.inspect', pluginId: 'case', actionId: 'inspect' }],
    });
    const result = preflightWorkflowPackageImport({
      controllerHome: h,
      scope: { kind: 'controller' },
      bundle: parentBundle,
      runtimeVersion: '1.9.0',
    });
    expect(result.canInstall).toBe(true);
    expect(result.canActivate).toBe(true);
    expect(result.childDependencies).toEqual([expect.objectContaining({ status: 'ready' })]);
    expect(result.missingCapabilityBindings).toEqual([]);
  });
  test('rejects incompatible runtime versions before lifecycle mutation', () => {
    const h = home();
    expect(
      preflightWorkflowPackageImport({
        controllerHome: h,
        scope: { kind: 'controller' },
        bundle: bundle(),
        runtimeVersion: '1.7.9',
      }),
    ).toMatchObject({
      canInstall: false,
      canActivate: false,
      issues: [expect.objectContaining({ code: 'WORKFLOW_PACKAGE_RUNTIME_TOO_OLD' })],
    });
    expect(
      preflightWorkflowPackageImport({
        controllerHome: h,
        scope: { kind: 'controller' },
        bundle: bundle(),
        runtimeVersion: '2.0.0',
      }),
    ).toMatchObject({
      canInstall: false,
      canActivate: false,
      issues: [expect.objectContaining({ code: 'WORKFLOW_PACKAGE_RUNTIME_TOO_NEW' })],
    });
  });
  test('detects exact child version/digest drift', () => {
    const h = home();
    const written = writeWorkflowAssetContent(
      { kind: 'controller', controllerHome: h },
      {
        schemaVersion: 1,
        workflowId: 'child.workflow',
        version: '2',
        steps: [{ stepId: 'noop', kind: 'script', scriptRef: 'noop' }],
        scripts: { noop: { runtime: 'node', deterministic: true, body: 'process.stdout.write(\"ok\")' } },
      },
    );
    registerWorkflowFeatureAsset({
      controllerHome: h,
      scope: { kind: 'controller' },
      asset: written.asset,
      contentLocation: { kind: 'controller', path: written.path },
      status: 'active',
    });
    const result = preflightWorkflowPackageImport({
      controllerHome: h,
      scope: { kind: 'controller' },
      bundle: bundle(),
      runtimeVersion: '1.8.2',
    });
    expect(result.childDependencies[0]?.status).toBe('version_mismatch');
    expect(result.canActivate).toBe(false);
  });
  test('preserves approval requirement as metadata without granting approval', () => {
    const h = home();
    const sensitive = materializeWorkflowPackageBundle(graph, {
      requiredWorkflows: [{ workflowId: 'child.workflow', contentDigest: child.contentDigest }],
      risk: { level: 'external_write', requiresApproval: true },
      publisher: { kind: 'model', id: 'model-author' },
    });
    const result = preflightWorkflowPackageImport({
      controllerHome: h,
      scope: { kind: 'controller' },
      bundle: sensitive,
      runtimeVersion: '1.8.2',
    });
    expect(result.approvalRequired).toBe(true);
    expect(JSON.stringify(result)).not.toContain('authorized');
  });
});
