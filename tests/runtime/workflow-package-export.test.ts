import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeWorkflowAssetContent,
  writeWorkflowGraphAssetContent,
} from '../../src/runtime/control-plane/persistence/workflow-content-store';
import { registerWorkflowFeatureAsset } from '../../src/runtime/control-plane/persistence/workflow-registry-store';
import {
  readWorkflowPackageBundleContent,
  writeWorkflowPackageBundleContent,
} from '../../src/runtime/workflows/package-content-store';
import { exportInstalledWorkflowPackage } from '../../src/runtime/workflows/package-export';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function home() {
  const value = mkdtempSync(join(tmpdir(), 'forge-workflow-package-export-'));
  roots.push(value);
  return value;
}
function installChild(h: string) {
  const written = writeWorkflowAssetContent(
    { kind: 'controller', controllerHome: h },
    {
      schemaVersion: 1,
      workflowId: 'child.workflow',
      version: '7',
      steps: [{ stepId: 'noop', kind: 'script', scriptRef: 'noop' }],
      scripts: { noop: { runtime: 'node', deterministic: true, body: 'process.stdout.write("ok")' } },
    },
  );
  return registerWorkflowFeatureAsset({
    controllerHome: h,
    scope: { kind: 'controller' },
    asset: written.asset,
    contentLocation: { kind: 'controller', path: written.path },
    status: 'active',
  });
}
function installParent(h: string) {
  const written = writeWorkflowGraphAssetContent(
    { kind: 'controller', controllerHome: h },
    {
      schemaVersion: 2,
      workflowId: 'parent.workflow',
      version: '3',
      entryNodeId: 'inspect',
      nodes: [
        { kind: 'capability', nodeId: 'inspect', capabilityId: 'case.inspect' },
        { kind: 'workflow', nodeId: 'child', workflowId: 'child.workflow' },
      ],
      edges: [{ edgeId: 'e1', from: 'inspect', to: 'child', on: 'success' }],
    },
  );
  return registerWorkflowFeatureAsset({
    controllerHome: h,
    scope: { kind: 'controller' },
    asset: written.asset,
    contentLocation: { kind: 'controller', path: written.path },
    status: 'active',
  });
}
function metadata() {
  return {
    tags: ['case-management'],
    runtimeCompatibility: { minRuntimeVersion: '1.8.0' },
    risk: { level: 'workspace_write' as const, requiresApproval: false },
    publisher: { kind: 'user' as const, id: 'greyson' },
  };
}

describe('Workflow Package export and content store', () => {
  test('exports an installed workflow and locks child workflow identity exactly', () => {
    const h = home();
    const child = installChild(h);
    installParent(h);
    const bundle = exportInstalledWorkflowPackage({
      controllerHome: h,
      scope: { kind: 'controller' },
      workflowId: 'parent.workflow',
      metadata: metadata(),
    });
    expect(bundle.manifest).toMatchObject({
      workflowId: 'parent.workflow',
      workflowVersion: '3',
      engine: 'graph_v2',
      requiredCapabilities: ['case.inspect'],
      requiredWorkflows: [{ workflowId: 'child.workflow', version: '7', contentDigest: child.value.contentDigest }],
    });
  });
  test('fails export when a declared child workflow is not installed', () => {
    const h = home();
    installParent(h);
    expect(() =>
      exportInstalledWorkflowPackage({
        controllerHome: h,
        scope: { kind: 'controller' },
        workflowId: 'parent.workflow',
        metadata: metadata(),
      }),
    ).toThrow('WORKFLOW_PACKAGE_EXPORT_CHILD_NOT_INSTALLED:child.workflow');
  });
  test('writes and reads a validated bundle beside workflow content without lifecycle authority', () => {
    const h = home();
    installChild(h);
    installParent(h);
    const bundle = exportInstalledWorkflowPackage({
      controllerHome: h,
      scope: { kind: 'controller' },
      workflowId: 'parent.workflow',
      metadata: metadata(),
    });
    const stored = writeWorkflowPackageBundleContent({ kind: 'controller', controllerHome: h }, bundle);
    expect(stored.path.endsWith('/parent.workflow/3/package.json')).toBe(true);
    const read = readWorkflowPackageBundleContent({ kind: 'controller', controllerHome: h }, 'parent.workflow', '3');
    expect(read.bundle).toEqual(bundle);
    expect(JSON.stringify(read.bundle)).not.toContain('"status"');
  });
  test('package content is idempotent only for the exact same package digest', () => {
    const h = home();
    installChild(h);
    installParent(h);
    const first = exportInstalledWorkflowPackage({
      controllerHome: h,
      scope: { kind: 'controller' },
      workflowId: 'parent.workflow',
      metadata: metadata(),
    });
    const firstWrite = writeWorkflowPackageBundleContent({ kind: 'controller', controllerHome: h }, first);
    const replay = writeWorkflowPackageBundleContent({ kind: 'controller', controllerHome: h }, first);
    expect(replay.bundle.manifest.packageDigest).toBe(firstWrite.bundle.manifest.packageDigest);

    const changedMetadata = exportInstalledWorkflowPackage({
      controllerHome: h,
      scope: { kind: 'controller' },
      workflowId: 'parent.workflow',
      metadata: { ...metadata(), tags: ['changed'], publisher: { kind: 'user', id: 'other-owner' } },
    });
    expect(changedMetadata.manifest.packageDigest).not.toBe(first.manifest.packageDigest);
    expect(() => writeWorkflowPackageBundleContent({ kind: 'controller', controllerHome: h }, changedMetadata)).toThrow(
      'WORKFLOW_PACKAGE_CONTENT_IMMUTABLE_CONFLICT:parent.workflow:3',
    );
    expect(
      readWorkflowPackageBundleContent({ kind: 'controller', controllerHome: h }, 'parent.workflow', '3').bundle,
    ).toEqual(first);
  });

  test('export never mutates installed lifecycle state', () => {
    const h = home();
    installChild(h);
    const parent = installParent(h);
    exportInstalledWorkflowPackage({
      controllerHome: h,
      scope: { kind: 'controller' },
      workflowId: 'parent.workflow',
      metadata: metadata(),
    });
    expect(parent.value.status).toBe('active');
  });
});
