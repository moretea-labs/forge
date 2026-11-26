import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeWorkflowAsset } from '../../packages/workflow-runtime/domain/workflow-asset';
import { materializeWorkflowPackageBundle } from '../../packages/workflow-runtime/domain/workflow-package-bundle';
import {
  readWorkflowRegistryEntry,
  recordWorkflowBindings,
} from '../../src/runtime/control-plane/persistence/workflow-registry-store';
import { installWorkflowPackage } from '../../src/runtime/workflows/package-install';
import {
  requestWorkflowPackageActivationApproval,
  verifyWorkflowPackageActivationApproval,
} from '../../src/runtime/workflows/package-approval';
import { resolveAuthorizationRequest } from '../../src/runtime/control-plane/governance/authorization';
import { activateWorkflowPackage, deactivateWorkflowPackage } from '../../src/runtime/workflows/package-lifecycle';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function home() {
  const value = mkdtempSync(join(tmpdir(), 'forge-workflow-package-lifecycle-'));
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
function packageBundle(
  input: {
    workflowId?: string;
    capability?: string;
    risk?: 'read' | 'external_write';
    requiresApproval?: boolean;
  } = {},
) {
  const asset = materializeWorkflowAsset({
    schemaVersion: 1,
    workflowId: input.workflowId ?? 'lifecycle.demo',
    version: '1',
    steps: input.capability
      ? [{ stepId: 'effect', capabilityId: input.capability }]
      : [{ stepId: 'noop', kind: 'script', scriptRef: 'noop' }],
    ...(input.capability
      ? {}
      : {
          scripts: {
            noop: { runtime: 'node' as const, deterministic: true as const, body: 'process.stdout.write("ok")' },
          },
        }),
  });
  return materializeWorkflowPackageBundle(asset, {
    runtimeCompatibility: { minRuntimeVersion: '1.8.0' },
    risk: { level: input.risk ?? 'read', requiresApproval: input.requiresApproval ?? false },
    publisher: { kind: 'user', id: 'owner' },
  });
}
function install(h: string, bundle = packageBundle()) {
  return installWorkflowPackage({
    controllerHome: h,
    scope,
    location: { kind: 'controller', controllerHome: h },
    bundle,
    runtimeVersion: '1.8.2',
    authorization: { canInstallWorkflows: true },
  });
}

describe('Workflow Package lifecycle owner', () => {
  test('activates a ready package only through explicit lifecycle authority', () => {
    const h = home();
    install(h);
    expect(() =>
      activateWorkflowPackage({
        controllerHome: h,
        scope,
        workflowId: 'lifecycle.demo',
        runtimeVersion: '1.8.2',
        authorization: { canActivateWorkflows: false },
      }),
    ).toThrow('WORKFLOW_PACKAGE_ACTIVATE_NOT_AUTHORIZED');
    const result = activateWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'lifecycle.demo',
      runtimeVersion: '1.8.2',
      authorization: { canActivateWorkflows: true },
    });
    expect(result.status).toBe('active');
    expect(readWorkflowRegistryEntry(h, scope, 'lifecycle.demo')?.value.status).toBe('active');
  });
  test('binds sensitive approval to the exact package digest', () => {
    const h = home();
    const bundle = packageBundle({ risk: 'external_write', requiresApproval: true });
    install(h, bundle);
    expect(() =>
      activateWorkflowPackage({
        controllerHome: h,
        scope,
        workflowId: 'lifecycle.demo',
        runtimeVersion: '1.8.2',
        authorization: { canActivateWorkflows: true },
      }),
    ).toThrow('WORKFLOW_PACKAGE_ACTIVATE_APPROVAL_REQUIRED:' + bundle.manifest.packageDigest);
    expect(() =>
      activateWorkflowPackage({
        controllerHome: h,
        scope,
        workflowId: 'lifecycle.demo',
        runtimeVersion: '1.8.2',
        authorization: {
          canActivateWorkflows: true,
          approval: approval(h, 'lifecycle.demo', 'sha256:' + '0'.repeat(64)),
        },
      }),
    ).toThrow('WORKFLOW_PACKAGE_ACTIVATE_APPROVAL_REQUIRED:' + bundle.manifest.packageDigest);
    expect(
      activateWorkflowPackage({
        controllerHome: h,
        scope,
        workflowId: 'lifecycle.demo',
        runtimeVersion: '1.8.2',
        authorization: {
          canActivateWorkflows: true,
          approval: approval(h, 'lifecycle.demo', bundle.manifest.packageDigest),
        },
      }).status,
    ).toBe('active');
  });
  test('blocks activation until declared capability bindings are present', () => {
    const h = home();
    const bundle = packageBundle({
      workflowId: 'needs.binding',
      capability: 'notify.send',
      risk: 'external_write',
      requiresApproval: true,
    });
    const installed = install(h, bundle);
    expect(() =>
      activateWorkflowPackage({
        controllerHome: h,
        scope,
        workflowId: 'needs.binding',
        runtimeVersion: '1.8.2',
        authorization: {
          canActivateWorkflows: true,
          approval: approval(h, 'needs.binding', bundle.manifest.packageDigest),
        },
      }),
    ).toThrow(/WORKFLOW_PACKAGE_CAPABILITY_BINDING_REQUIRED/);
    recordWorkflowBindings({
      controllerHome: h,
      scope,
      expectedIdentity: { workflowId: 'needs.binding', version: '1', contentDigest: bundle.manifest.contentDigest },
      bindings: [{ capabilityId: 'notify.send', pluginId: 'notify', actionId: 'send' }],
      expectedRevision: installed.registryRevision,
    });
    expect(
      activateWorkflowPackage({
        controllerHome: h,
        scope,
        workflowId: 'needs.binding',
        runtimeVersion: '1.8.2',
        authorization: {
          canActivateWorkflows: true,
          approval: approval(h, 'needs.binding', bundle.manifest.packageDigest),
        },
      }).status,
    ).toBe('active');
  });
  test('rechecks runtime compatibility at activation time', () => {
    const h = home();
    install(h);
    expect(() =>
      activateWorkflowPackage({
        controllerHome: h,
        scope,
        workflowId: 'lifecycle.demo',
        runtimeVersion: '1.7.9',
        authorization: { canActivateWorkflows: true },
      }),
    ).toThrow(/WORKFLOW_PACKAGE_RUNTIME_TOO_OLD/);
    expect(readWorkflowRegistryEntry(h, scope, 'lifecycle.demo')?.value.status).toBe('installed');
  });
  test('corrupted package remains impossible to activate', () => {
    const h = home();
    const bundle = packageBundle();
    install(h, bundle);
    const { workflowAssetContentPath } = require('../../src/runtime/control-plane/persistence/workflow-content-store');
    const { writeFileSync } = require('node:fs');
    const path = workflowAssetContentPath({ kind: 'controller', controllerHome: h }, 'lifecycle.demo', '1').replace(
      /workflow\.json$/,
      'package.json',
    );
    writeFileSync(path, '{corrupt\n', 'utf8');
    expect(() =>
      activateWorkflowPackage({
        controllerHome: h,
        scope,
        workflowId: 'lifecycle.demo',
        runtimeVersion: '1.8.2',
        authorization: { canActivateWorkflows: true },
      }),
    ).toThrow();
  });

  test('deactivation is explicit, idempotent and does not require sensitive-effect approval', () => {
    const h = home();
    const bundle = packageBundle({ risk: 'external_write', requiresApproval: true });
    install(h, bundle);
    activateWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'lifecycle.demo',
      runtimeVersion: '1.8.2',
      authorization: {
        canActivateWorkflows: true,
        approval: approval(h, 'lifecycle.demo', bundle.manifest.packageDigest),
      },
    });
    const first = deactivateWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'lifecycle.demo',
      authorization: { canActivateWorkflows: true },
    });
    const second = deactivateWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'lifecycle.demo',
      authorization: { canActivateWorkflows: true },
    });
    expect(first.status).toBe('inactive');
    expect(second.status).toBe('inactive');
    expect(second.registryRevision).toBe(first.registryRevision);
  });
});
