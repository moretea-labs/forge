import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeWorkflowAsset } from '../../packages/workflow-runtime/domain/workflow-asset';
import { materializeWorkflowPackageBundle } from '../../packages/workflow-runtime/domain/workflow-package-bundle';
import { readWorkflowRegistryEntry } from '../../src/runtime/control-plane/persistence/workflow-registry-store';
import { writeWorkflowRunCheckpoint } from '../../src/runtime/control-plane/persistence/workflow-run-store';
import { installWorkflowPackage } from '../../src/runtime/workflows/package-install';
import { readWorkflowPackageInstallation } from '../../src/runtime/workflows/package-installation-store';
import { activateWorkflowPackage, deactivateWorkflowPackage } from '../../src/runtime/workflows/package-lifecycle';
import { uninstallWorkflowPackage } from '../../src/runtime/workflows/package-uninstall';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function home() {
  const value = mkdtempSync(join(tmpdir(), 'forge-workflow-uninstall-'));
  roots.push(value);
  return value;
}
const scope = { kind: 'controller' as const };
function bundle() {
  const asset = materializeWorkflowAsset({
    schemaVersion: 1,
    workflowId: 'uninstall.demo',
    version: '1',
    steps: [{ stepId: 'noop', kind: 'script', scriptRef: 'noop' }],
    scripts: { noop: { runtime: 'node', deterministic: true, body: 'process.stdout.write("ok")' } },
  });
  return materializeWorkflowPackageBundle(asset, {
    risk: { level: 'read', requiresApproval: false },
    publisher: { kind: 'user', id: 'owner' },
  });
}
function install(h: string) {
  return installWorkflowPackage({
    controllerHome: h,
    scope,
    location: { kind: 'controller', controllerHome: h },
    bundle: bundle(),
    runtimeVersion: '1.8.2',
    authorization: { canInstallWorkflows: true },
  });
}

describe('Workflow Package uninstall', () => {
  test('removes only Registry installation while retaining versioned content and package identity', () => {
    const h = home();
    const installed = install(h);
    const registry = readWorkflowRegistryEntry(h, scope, 'uninstall.demo')!;
    const result = uninstallWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'uninstall.demo',
      expectedRegistryRevision: registry.revision,
      authorization: { canUninstallWorkflows: true },
    });
    expect(result).toMatchObject({
      workflowId: 'uninstall.demo',
      version: '1',
      uninstalled: true,
      retainedVersionedContent: true,
      retainedInstallationIdentity: true,
    });
    expect(readWorkflowRegistryEntry(h, scope, 'uninstall.demo')).toBeUndefined();
    expect(existsSync(installed.contentPath)).toBe(true);
    expect(existsSync(installed.packagePath)).toBe(true);
    expect(readWorkflowPackageInstallation(h, scope, 'uninstall.demo', '1')?.value.packageDigest).toBe(
      result.packageDigest,
    );
  });
  test('requires explicit uninstall authority and exact Registry revision', () => {
    const h = home();
    install(h);
    const registry = readWorkflowRegistryEntry(h, scope, 'uninstall.demo')!;
    expect(() =>
      uninstallWorkflowPackage({
        controllerHome: h,
        scope,
        workflowId: 'uninstall.demo',
        expectedRegistryRevision: registry.revision,
        authorization: { canUninstallWorkflows: false },
      }),
    ).toThrow('WORKFLOW_PACKAGE_UNINSTALL_NOT_AUTHORIZED');
    expect(() =>
      uninstallWorkflowPackage({
        controllerHome: h,
        scope,
        workflowId: 'uninstall.demo',
        expectedRegistryRevision: registry.revision + 1,
        authorization: { canUninstallWorkflows: true },
      }),
    ).toThrow('WORKFLOW_PACKAGE_UNINSTALL_REVISION_CONFLICT');
  });
  test('active package must be explicitly deactivated before uninstall', () => {
    const h = home();
    install(h);
    activateWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'uninstall.demo',
      runtimeVersion: '1.8.2',
      authorization: { canActivateWorkflows: true },
    });
    const active = readWorkflowRegistryEntry(h, scope, 'uninstall.demo')!;
    expect(() =>
      uninstallWorkflowPackage({
        controllerHome: h,
        scope,
        workflowId: 'uninstall.demo',
        expectedRegistryRevision: active.revision,
        authorization: { canUninstallWorkflows: true },
      }),
    ).toThrow('WORKFLOW_PACKAGE_UNINSTALL_ACTIVE');
    deactivateWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'uninstall.demo',
      authorization: { canActivateWorkflows: true },
    });
    const inactive = readWorkflowRegistryEntry(h, scope, 'uninstall.demo')!;
    expect(
      uninstallWorkflowPackage({
        controllerHome: h,
        scope,
        workflowId: 'uninstall.demo',
        expectedRegistryRevision: inactive.revision,
        authorization: { canUninstallWorkflows: true },
      }).uninstalled,
    ).toBe(true);
  });
  test('nonterminal run blocks uninstall even after lifecycle deactivation', () => {
    const h = home();
    const installed = install(h);
    const registry = readWorkflowRegistryEntry(h, scope, 'uninstall.demo')!;
    writeWorkflowRunCheckpoint({
      controllerHome: h,
      inputs: {},
      checkpoint: {
        schemaVersion: 1,
        binding: { scopeId: 'repository:r:checkout:c:workflow:uninstall.demo', runId: 'run-live' },
        workflowId: 'uninstall.demo',
        version: '1',
        contentDigest: installed.contentDigest,
        status: 'running',
        nextStepIndex: 0,
        receipts: [],
        outputs: {},
      },
    });
    expect(() =>
      uninstallWorkflowPackage({
        controllerHome: h,
        scope,
        workflowId: 'uninstall.demo',
        expectedRegistryRevision: registry.revision,
        authorization: { canUninstallWorkflows: true },
      }),
    ).toThrow(/WORKFLOW_PACKAGE_UNINSTALL_NONTERMINAL_RUNS:1:.*run-live:running/);
    expect(readWorkflowRegistryEntry(h, scope, 'uninstall.demo')).toBeDefined();
  });
  test('terminal run does not block uninstall', () => {
    const h = home();
    const installed = install(h);
    const registry = readWorkflowRegistryEntry(h, scope, 'uninstall.demo')!;
    writeWorkflowRunCheckpoint({
      controllerHome: h,
      inputs: {},
      checkpoint: {
        schemaVersion: 1,
        binding: { scopeId: 'repository:r:checkout:c:workflow:uninstall.demo', runId: 'run-done' },
        workflowId: 'uninstall.demo',
        version: '1',
        contentDigest: installed.contentDigest,
        status: 'succeeded',
        nextStepIndex: 1,
        receipts: [],
        outputs: {},
      },
    });
    expect(
      uninstallWorkflowPackage({
        controllerHome: h,
        scope,
        workflowId: 'uninstall.demo',
        expectedRegistryRevision: registry.revision,
        authorization: { canUninstallWorkflows: true },
      }).uninstalled,
    ).toBe(true);
  });
  test('exact retained package can be reinstalled after uninstall', () => {
    const h = home();
    const b = bundle();
    install(h);
    const registry = readWorkflowRegistryEntry(h, scope, 'uninstall.demo')!;
    uninstallWorkflowPackage({
      controllerHome: h,
      scope,
      workflowId: 'uninstall.demo',
      expectedRegistryRevision: registry.revision,
      authorization: { canUninstallWorkflows: true },
    });
    const reinstalled = installWorkflowPackage({
      controllerHome: h,
      scope,
      location: { kind: 'controller', controllerHome: h },
      bundle: b,
      runtimeVersion: '1.8.2',
      authorization: { canInstallWorkflows: true },
    });
    expect(reinstalled.lifecycleStatus).toBe('installed');
    expect(readWorkflowRegistryEntry(h, scope, 'uninstall.demo')).toBeDefined();
  });
});
