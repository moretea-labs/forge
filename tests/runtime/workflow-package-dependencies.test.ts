import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeWorkflowAsset } from '../../packages/workflow-runtime/domain/workflow-asset';
import { materializeWorkflowGraphAsset } from '../../packages/workflow-runtime/domain/workflow-graph';
import { materializeWorkflowPackageBundle } from '../../packages/workflow-runtime/domain/workflow-package-bundle';
import { readWorkflowRegistryEntry } from '../../src/runtime/control-plane/persistence/workflow-registry-store';
import { workflowAssetContentPath } from '../../src/runtime/control-plane/persistence/workflow-content-store';
import { installWorkflowPackage } from '../../src/runtime/workflows/package-install';
import { activateWorkflowPackage, deactivateWorkflowPackage } from '../../src/runtime/workflows/package-lifecycle';
import { listActiveWorkflowPackageDependents } from '../../src/runtime/workflows/package-dependencies';
import { updateWorkflowPackage } from '../../src/runtime/workflows/package-update';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function home() {
  const value = mkdtempSync(join(tmpdir(), 'forge-workflow-package-deps-'));
  roots.push(value);
  return value;
}
const scope = { kind: 'controller' as const };
function childBundle(version: string) {
  const asset = materializeWorkflowAsset({
    schemaVersion: 1,
    workflowId: 'child.pkg',
    version,
    steps: [{ stepId: 'noop', kind: 'script', scriptRef: 'noop' }],
    scripts: { noop: { runtime: 'node', deterministic: true, body: `process.stdout.write("${version}")` } },
  });
  return materializeWorkflowPackageBundle(asset, {
    risk: { level: 'read', requiresApproval: false },
    publisher: { kind: 'user', id: 'owner' },
  });
}
function parentBundle(child: ReturnType<typeof childBundle>) {
  const asset = materializeWorkflowGraphAsset({
    schemaVersion: 2,
    workflowId: 'parent.pkg',
    version: '1',
    entryNodeId: 'child',
    nodes: [{ kind: 'workflow', nodeId: 'child', workflowId: 'child.pkg' }],
    edges: [],
  });
  return materializeWorkflowPackageBundle(asset, {
    requiredWorkflows: [
      { workflowId: 'child.pkg', version: child.manifest.workflowVersion, contentDigest: child.manifest.contentDigest },
    ],
    risk: { level: 'read', requiresApproval: false },
    publisher: { kind: 'user', id: 'owner' },
  });
}
function install(h: string, bundle: ReturnType<typeof childBundle> | ReturnType<typeof parentBundle>) {
  return installWorkflowPackage({
    controllerHome: h,
    scope,
    location: { kind: 'controller', controllerHome: h },
    bundle,
    runtimeVersion: '1.8.2',
    authorization: { canInstallWorkflows: true },
  });
}

describe('Workflow Package reverse dependency safety', () => {
  test('tracks active packaged parents by exact child version/content identity', () => {
    const h = home();
    const child = childBundle('1');
    install(h, child);
    activateWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'child.pkg',
      runtimeVersion: '1.8.2',
      authorization: { canActivateWorkflows: true },
    });
    const parent = parentBundle(child);
    install(h, parent);
    activateWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'parent.pkg',
      runtimeVersion: '1.8.2',
      authorization: { canActivateWorkflows: true },
    });
    expect(
      listActiveWorkflowPackageDependents(h, scope, {
        workflowId: 'child.pkg',
        version: '1',
        contentDigest: child.manifest.contentDigest,
      }),
    ).toEqual(['parent.pkg']);
  });
  test('blocks child update while an active parent is pinned to that exact identity', () => {
    const h = home();
    const child = childBundle('1');
    const installed = install(h, child);
    activateWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'child.pkg',
      runtimeVersion: '1.8.2',
      authorization: { canActivateWorkflows: true },
    });
    const parent = parentBundle(child);
    install(h, parent);
    activateWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'parent.pkg',
      runtimeVersion: '1.8.2',
      authorization: { canActivateWorkflows: true },
    });
    const current = readWorkflowRegistryEntry(h, scope, 'child.pkg')!;
    expect(() =>
      updateWorkflowPackage({
        controllerHome: h,
        scope,
        location: { kind: 'controller', controllerHome: h },
        workflowId: 'child.pkg',
        bundle: childBundle('2'),
        runtimeVersion: '1.8.2',
        expectedRegistryRevision: current.revision,
        authorization: { canUpdateWorkflows: true },
      }),
    ).toThrow('WORKFLOW_PACKAGE_ACTIVE_DEPENDENTS:child.pkg:parent.pkg');
    expect(readWorkflowRegistryEntry(h, scope, 'child.pkg')?.value.version).toBe('1');
    expect(installed.workflowId).toBe('child.pkg');
  });
  test('blocks child deactivation while an active parent depends on it', () => {
    const h = home();
    const child = childBundle('1');
    install(h, child);
    activateWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'child.pkg',
      runtimeVersion: '1.8.2',
      authorization: { canActivateWorkflows: true },
    });
    const parent = parentBundle(child);
    install(h, parent);
    activateWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'parent.pkg',
      runtimeVersion: '1.8.2',
      authorization: { canActivateWorkflows: true },
    });
    expect(() =>
      deactivateWorkflowPackage({
        controllerHome: h,
        scope,
        workflowId: 'child.pkg',
        authorization: { canActivateWorkflows: true },
      }),
    ).toThrow('WORKFLOW_PACKAGE_ACTIVE_DEPENDENTS:child.pkg:parent.pkg');
  });
  test('active invalid package makes reverse dependency graph fail closed', () => {
    const h = home();
    const child = childBundle('1');
    install(h, child);
    activateWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'child.pkg',
      runtimeVersion: '1.8.2',
      authorization: { canActivateWorkflows: true },
    });
    const parent = parentBundle(child);
    install(h, parent);
    activateWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'parent.pkg',
      runtimeVersion: '1.8.2',
      authorization: { canActivateWorkflows: true },
    });
    const parentPackage = workflowAssetContentPath(
      { kind: 'controller', controllerHome: h },
      'parent.pkg',
      '1',
    ).replace(/workflow\.json$/, 'package.json');
    writeFileSync(parentPackage, '{corrupt-package\n', 'utf8');
    const current = readWorkflowRegistryEntry(h, scope, 'child.pkg')!;
    expect(() =>
      updateWorkflowPackage({
        controllerHome: h,
        scope,
        location: { kind: 'controller', controllerHome: h },
        workflowId: 'child.pkg',
        bundle: childBundle('2'),
        runtimeVersion: '1.8.2',
        expectedRegistryRevision: current.revision,
        authorization: { canUpdateWorkflows: true },
      }),
    ).toThrow('WORKFLOW_PACKAGE_DEPENDENCY_GRAPH_INVALID:parent.pkg');
    expect(() =>
      deactivateWorkflowPackage({
        controllerHome: h,
        scope,
        workflowId: 'child.pkg',
        authorization: { canActivateWorkflows: true },
      }),
    ).toThrow('WORKFLOW_PACKAGE_DEPENDENCY_GRAPH_INVALID:parent.pkg');
  });

  test('corrupted active package can deactivate itself as a recovery action', () => {
    const h = home();
    const child = childBundle('1');
    install(h, child);
    activateWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'child.pkg',
      runtimeVersion: '1.8.2',
      authorization: { canActivateWorkflows: true },
    });
    const packagePath = workflowAssetContentPath({ kind: 'controller', controllerHome: h }, 'child.pkg', '1').replace(
      /workflow\.json$/,
      'package.json',
    );
    writeFileSync(packagePath, '{corrupt-package\n', 'utf8');
    const result = deactivateWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'child.pkg',
      authorization: { canActivateWorkflows: true },
    });
    expect(result).toMatchObject({ workflowId: 'child.pkg', status: 'inactive', packageStatus: 'invalid' });
    expect(result.packageDigest).toBeUndefined();
    expect(readWorkflowRegistryEntry(h, scope, 'child.pkg')?.value.status).toBe('inactive');
  });

  test('after invalid parent recovery deactivation, child dependency changes are unblocked', () => {
    const h = home();
    const child = childBundle('1');
    install(h, child);
    activateWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'child.pkg',
      runtimeVersion: '1.8.2',
      authorization: { canActivateWorkflows: true },
    });
    const parent = parentBundle(child);
    install(h, parent);
    activateWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'parent.pkg',
      runtimeVersion: '1.8.2',
      authorization: { canActivateWorkflows: true },
    });
    const parentPackage = workflowAssetContentPath(
      { kind: 'controller', controllerHome: h },
      'parent.pkg',
      '1',
    ).replace(/workflow\.json$/, 'package.json');
    writeFileSync(parentPackage, '{corrupt-package\n', 'utf8');
    const recovered = deactivateWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'parent.pkg',
      authorization: { canActivateWorkflows: true },
    });
    expect(recovered.packageStatus).toBe('invalid');
    const current = readWorkflowRegistryEntry(h, scope, 'child.pkg')!;
    const updated = updateWorkflowPackage({
      controllerHome: h,
      scope,
      location: { kind: 'controller', controllerHome: h },
      workflowId: 'child.pkg',
      bundle: childBundle('2'),
      runtimeVersion: '1.8.2',
      expectedRegistryRevision: current.revision,
      authorization: { canUpdateWorkflows: true },
    });
    expect(updated.version).toBe('2');
  });

  test('after parent deactivation, child may be deactivated or upgraded explicitly', () => {
    const h = home();
    const child = childBundle('1');
    install(h, child);
    activateWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'child.pkg',
      runtimeVersion: '1.8.2',
      authorization: { canActivateWorkflows: true },
    });
    const parent = parentBundle(child);
    install(h, parent);
    activateWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'parent.pkg',
      runtimeVersion: '1.8.2',
      authorization: { canActivateWorkflows: true },
    });
    deactivateWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'parent.pkg',
      authorization: { canActivateWorkflows: true },
    });
    expect(
      deactivateWorkflowPackage({
        controllerHome: h,
        scope,
        workflowId: 'child.pkg',
        authorization: { canActivateWorkflows: true },
      }).status,
    ).toBe('inactive');
  });
});
