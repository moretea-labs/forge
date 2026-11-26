import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeWorkflowAsset } from '../../packages/workflow-runtime/domain/workflow-asset';
import { materializeWorkflowPackageBundle } from '../../packages/workflow-runtime/domain/workflow-package-bundle';
import { readWorkflowRegistryEntry } from '../../src/runtime/control-plane/persistence/workflow-registry-store';
import { installWorkflowPackage } from '../../src/runtime/workflows/package-install';
import { readWorkflowPackageInstallation } from '../../src/runtime/workflows/package-installation-store';
import { workflowLifecycleMode, setWorkflowLifecycle } from '../../src/runtime/workflows/lifecycle';
import { listWorkflowDiscoveryCatalog } from '../../src/runtime/workflows/package-catalog';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function home() {
  const value = mkdtempSync(join(tmpdir(), 'forge-package-installation-'));
  roots.push(value);
  return value;
}
const scope = { kind: 'controller' as const };
function bundle() {
  const asset = materializeWorkflowAsset({
    schemaVersion: 1,
    workflowId: 'marker.demo',
    version: '1',
    steps: [{ stepId: 'noop', kind: 'script', scriptRef: 'noop' }],
    scripts: { noop: { runtime: 'node', deterministic: true, body: 'process.stdout.write("ok")' } },
  });
  return materializeWorkflowPackageBundle(asset, {
    risk: { level: 'read', requiresApproval: false },
    publisher: { kind: 'user', id: 'owner' },
  });
}

describe('Workflow Package installation identity', () => {
  test('package install records immutable per-version installation metadata', () => {
    const h = home();
    const b = bundle();
    const installed = installWorkflowPackage({
      controllerHome: h,
      scope,
      location: { kind: 'controller', controllerHome: h },
      bundle: b,
      runtimeVersion: '1.8.2',
      authorization: { canInstallWorkflows: true },
    });
    const marker = readWorkflowPackageInstallation(h, scope, 'marker.demo', '1')!;
    expect(marker.value).toMatchObject({
      workflowId: 'marker.demo',
      version: '1',
      contentDigest: b.manifest.contentDigest,
      packageDigest: b.manifest.packageDigest,
      contentPath: installed.contentPath,
      packagePath: installed.packagePath,
    });
  });
  test('deleting package.json cannot downgrade a packaged workflow into legacy lifecycle mode', () => {
    const h = home();
    const b = bundle();
    const installed = installWorkflowPackage({
      controllerHome: h,
      scope,
      location: { kind: 'controller', controllerHome: h },
      bundle: b,
      runtimeVersion: '1.8.2',
      authorization: { canInstallWorkflows: true },
    });
    unlinkSync(installed.packagePath);
    expect(workflowLifecycleMode(h, scope, 'marker.demo')).toBe('packaged');
    expect(listWorkflowDiscoveryCatalog(h, scope)[0]).toMatchObject({
      packageStatus: 'invalid',
      packageError: 'WORKFLOW_DISCOVERY_PACKAGE_CONTENT_MISSING:marker.demo',
    });
    expect(() =>
      setWorkflowLifecycle({
        controllerHome: h,
        scope,
        workflowId: 'marker.demo',
        status: 'active',
        runtimeVersion: '1.8.2',
        authorization: { canActivateWorkflows: true },
      }),
    ).toThrow();
  });
  test('missing package content still permits explicit safe deactivation through packaged lifecycle', () => {
    const h = home();
    const installed = installWorkflowPackage({
      controllerHome: h,
      scope,
      location: { kind: 'controller', controllerHome: h },
      bundle: bundle(),
      runtimeVersion: '1.8.2',
      authorization: { canInstallWorkflows: true },
    });
    setWorkflowLifecycle({
      controllerHome: h,
      scope,
      workflowId: 'marker.demo',
      status: 'active',
      runtimeVersion: '1.8.2',
      authorization: { canActivateWorkflows: true },
    });
    unlinkSync(installed.packagePath);
    const result = setWorkflowLifecycle({
      controllerHome: h,
      scope,
      workflowId: 'marker.demo',
      status: 'inactive',
      authorization: { canActivateWorkflows: true },
    });
    expect(result).toMatchObject({ workflowId: 'marker.demo', status: 'inactive', mode: 'packaged' });
    expect(readWorkflowRegistryEntry(h, scope, 'marker.demo')?.value.status).toBe('inactive');
  });
});
