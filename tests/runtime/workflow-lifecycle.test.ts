import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeWorkflowAsset } from '../../packages/workflow-runtime/domain/workflow-asset';
import { materializeWorkflowPackageBundle } from '../../packages/workflow-runtime/domain/workflow-package-bundle';
import { writeWorkflowAssetContent } from '../../src/runtime/control-plane/persistence/workflow-content-store';
import {
  readWorkflowRegistryEntry,
  registerWorkflowFeatureAsset,
} from '../../src/runtime/control-plane/persistence/workflow-registry-store';
import { installWorkflowPackage } from '../../src/runtime/workflows/package-install';
import {
  requestWorkflowPackageActivationApproval,
  verifyWorkflowPackageActivationApproval,
} from '../../src/runtime/workflows/package-approval';
import { resolveAuthorizationRequest } from '../../src/runtime/control-plane/governance/authorization';
import { setWorkflowLifecycle, workflowLifecycleMode } from '../../src/runtime/workflows/lifecycle';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function home() {
  const value = mkdtempSync(join(tmpdir(), 'forge-workflow-lifecycle-'));
  roots.push(value);
  return value;
}
const scope = { kind: 'controller' as const };
function approval(
  h: string,
  workflowId: string,
  packageDigest: string,
  risk: 'read' | 'workspace_write' | 'external_write' | 'destructive' = 'external_write',
) {
  const requested = requestWorkflowPackageActivationApproval({
    controllerHome: h,
    repositoryId: 'repo-approval',
    scope,
    workflowId,
    packageDigest,
    risk,
    sessionId: 'session-1',
    principalId: 'principal-1',
    permissionSnapshotVersion: 1,
  });
  resolveAuthorizationRequest({
    controllerHome: h,
    repositoryId: 'repo-approval',
    approvalRequestId: requested.approvalRequestId,
    sessionId: 'session-1',
    principalId: 'principal-1',
    permissionSnapshotVersion: 1,
    confirm: true,
  });
  return verifyWorkflowPackageActivationApproval({
    controllerHome: h,
    repositoryId: 'repo-approval',
    approvalRequestId: requested.approvalRequestId,
    scope,
    workflowId,
    packageDigest,
    sessionId: 'session-1',
    principalId: 'principal-1',
    permissionSnapshotVersion: 1,
  });
}
function sensitiveBundle() {
  const asset = materializeWorkflowAsset({
    schemaVersion: 1,
    workflowId: 'packaged.demo',
    version: '1',
    steps: [{ stepId: 'noop', kind: 'script', scriptRef: 'noop' }],
    scripts: { noop: { runtime: 'node', deterministic: true, body: 'process.stdout.write("ok")' } },
  });
  return materializeWorkflowPackageBundle(asset, {
    risk: { level: 'external_write', requiresApproval: true },
    publisher: { kind: 'model', id: 'author-model' },
  });
}
function installPackaged(h: string) {
  const bundle = sensitiveBundle();
  installWorkflowPackage({
    controllerHome: h,
    scope,
    location: { kind: 'controller', controllerHome: h },
    bundle,
    runtimeVersion: '1.8.2',
    authorization: { canInstallWorkflows: true },
  });
  return bundle;
}
function installLegacy(h: string) {
  const written = writeWorkflowAssetContent(
    { kind: 'controller', controllerHome: h },
    {
      schemaVersion: 1,
      workflowId: 'legacy.demo',
      version: '1',
      steps: [{ stepId: 'noop', kind: 'script', scriptRef: 'noop' }],
      scripts: { noop: { runtime: 'node', deterministic: true, body: 'process.stdout.write("ok")' } },
    },
  );
  return registerWorkflowFeatureAsset({
    controllerHome: h,
    scope,
    asset: written.asset,
    contentLocation: { kind: 'controller', path: written.path },
    status: 'installed',
  });
}

describe('Unified Workflow lifecycle owner', () => {
  test('detects packaged versus legacy lifecycle mode from installed content', () => {
    const h = home();
    installPackaged(h);
    installLegacy(h);
    expect(workflowLifecycleMode(h, scope, 'packaged.demo')).toBe('packaged');
    expect(workflowLifecycleMode(h, scope, 'legacy.demo')).toBe('legacy');
  });
  test('packaged activation cannot bypass exact package approval through the generic lifecycle API', () => {
    const h = home();
    const bundle = installPackaged(h);
    expect(() =>
      setWorkflowLifecycle({
        controllerHome: h,
        scope,
        workflowId: 'packaged.demo',
        status: 'active',
        runtimeVersion: '1.8.2',
        authorization: { canActivateWorkflows: true },
      }),
    ).toThrow('WORKFLOW_PACKAGE_ACTIVATE_APPROVAL_REQUIRED:' + bundle.manifest.packageDigest);
    const activated = setWorkflowLifecycle({
      controllerHome: h,
      scope,
      workflowId: 'packaged.demo',
      status: 'active',
      runtimeVersion: '1.8.2',
      authorization: {
        canActivateWorkflows: true,
        approval: approval(h, 'packaged.demo', bundle.manifest.packageDigest),
      },
    });
    expect(activated).toMatchObject({
      status: 'active',
      mode: 'packaged',
      packageDigest: bundle.manifest.packageDigest,
    });
  });
  test('packaged activation requires runtime compatibility context', () => {
    const h = home();
    installPackaged(h);
    expect(() =>
      setWorkflowLifecycle({
        controllerHome: h,
        scope,
        workflowId: 'packaged.demo',
        status: 'active',
        authorization: { canActivateWorkflows: true },
      }),
    ).toThrow('WORKFLOW_LIFECYCLE_RUNTIME_VERSION_REQUIRED');
  });
  test('legacy workflows retain compatibility without package-only approval requirements', () => {
    const h = home();
    const installed = installLegacy(h);
    const activated = setWorkflowLifecycle({
      controllerHome: h,
      scope,
      workflowId: 'legacy.demo',
      status: 'active',
      expectedRegistryRevision: installed.revision,
      authorization: { canActivateWorkflows: true },
    });
    expect(activated).toMatchObject({ workflowId: 'legacy.demo', status: 'active', mode: 'legacy' });
    expect(readWorkflowRegistryEntry(h, scope, 'legacy.demo')?.value.status).toBe('active');
  });
  test('caller lifecycle authority is required for both packaged and legacy workflows', () => {
    const h = home();
    installLegacy(h);
    expect(() =>
      setWorkflowLifecycle({
        controllerHome: h,
        scope,
        workflowId: 'legacy.demo',
        status: 'active',
        authorization: { canActivateWorkflows: false },
      }),
    ).toThrow('WORKFLOW_LIFECYCLE_NOT_AUTHORIZED');
  });
});
