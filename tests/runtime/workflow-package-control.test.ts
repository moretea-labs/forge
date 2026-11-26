import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeWorkflowAsset } from '../../packages/workflow-runtime/domain/workflow-asset';
import { materializeWorkflowPackageBundle } from '../../packages/workflow-runtime/domain/workflow-package-bundle';
import { executeWorkflowPackageControl } from '../../src/runtime/workflows/package-control';
import { readWorkflowRegistryEntry } from '../../src/runtime/control-plane/persistence/workflow-registry-store';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function home() {
  const value = mkdtempSync(join(tmpdir(), 'forge-workflow-package-control-'));
  roots.push(value);
  return value;
}
const asset = materializeWorkflowAsset({
  schemaVersion: 1,
  workflowId: 'control.demo',
  version: '1',
  title: 'Control Demo',
  description: 'First-class package control fixture',
  steps: [{ stepId: 'noop', kind: 'script', scriptRef: 'noop' }],
  scripts: { noop: { runtime: 'node', deterministic: true, body: 'process.stdout.write("ok")' } },
});
function bundle() {
  return materializeWorkflowPackageBundle(asset, {
    tags: ['demo', 'control'],
    runtimeCompatibility: { minRuntimeVersion: '1.8.0' },
    risk: { level: 'read', requiresApproval: false },
    publisher: { kind: 'import', id: 'fixture' },
  });
}
const scope = { kind: 'controller' as const };

describe('Workflow Package Control Service', () => {
  test('preflights and installs through one package service without activation', () => {
    const h = home();
    const preflight = executeWorkflowPackageControl(h, {
      action: 'preflight',
      scope,
      bundle: bundle(),
      runtimeVersion: '1.8.2',
    });
    expect(preflight).toMatchObject({
      action: 'preflight',
      preflight: {
        canInstall: true,
        canActivate: true,
        lifecycle: { installStatus: 'installed', activation: 'not_requested' },
      },
    });
    const installed = executeWorkflowPackageControl(h, {
      action: 'install',
      scope,
      location: { kind: 'controller', controllerHome: h },
      bundle: bundle(),
      runtimeVersion: '1.8.2',
      authorization: { canInstallWorkflows: true },
    });
    expect(installed).toMatchObject({
      action: 'install',
      install: { workflowId: 'control.demo', lifecycleStatus: 'installed', activation: 'not_requested' },
    });
    expect(readWorkflowRegistryEntry(h, scope, 'control.demo')?.value.status).toBe('installed');
  });
  test('list/search are read-only first-class discovery actions', () => {
    const h = home();
    executeWorkflowPackageControl(h, {
      action: 'install',
      scope,
      location: { kind: 'controller', controllerHome: h },
      bundle: bundle(),
      runtimeVersion: '1.8.2',
      authorization: { canInstallWorkflows: true },
    });
    const listed = executeWorkflowPackageControl(h, { action: 'list', scope });
    expect(listed.action === 'list' && listed.entries.map((entry) => entry.workflow.descriptor.workflowId)).toEqual([
      'control.demo',
    ]);
    const searched = executeWorkflowPackageControl(h, {
      action: 'search',
      scope,
      query: { tags: ['demo'], text: 'control' },
    });
    expect(
      searched.action === 'search' && searched.entries.map((entry) => entry.workflow.descriptor.workflowId),
    ).toEqual(['control.demo']);
    expect(readWorkflowRegistryEntry(h, scope, 'control.demo')?.value.status).toBe('installed');
  });
  test('updates through the package service and requires reactivation for the new identity', () => {
    const h = home();
    const installed = executeWorkflowPackageControl(h, {
      action: 'install',
      scope,
      location: { kind: 'controller', controllerHome: h },
      bundle: bundle(),
      runtimeVersion: '1.8.2',
      authorization: { canInstallWorkflows: true },
    });
    expect(installed.action).toBe('install');
    const nextAsset = materializeWorkflowAsset({
      schemaVersion: 1,
      workflowId: 'control.demo',
      version: '2',
      title: 'Control Demo v2',
      steps: [{ stepId: 'noop', kind: 'script', scriptRef: 'noop' }],
      scripts: { noop: { runtime: 'node', deterministic: true, body: 'process.stdout.write("ok-v2")' } },
    });
    const nextBundle = materializeWorkflowPackageBundle(nextAsset, {
      tags: ['demo', 'control'],
      runtimeCompatibility: { minRuntimeVersion: '1.8.0' },
      risk: { level: 'read', requiresApproval: false },
      publisher: { kind: 'model', id: 'workflow-author' },
    });
    const revision = readWorkflowRegistryEntry(h, scope, 'control.demo')!.revision;
    const updated = executeWorkflowPackageControl(h, {
      action: 'update',
      scope,
      location: { kind: 'controller', controllerHome: h },
      workflowId: 'control.demo',
      bundle: nextBundle,
      runtimeVersion: '1.8.2',
      expectedRegistryRevision: revision,
      authorization: { canUpdateWorkflows: true },
    });
    expect(updated).toMatchObject({
      action: 'update',
      update: {
        previousVersion: '1',
        version: '2',
        lifecycleStatus: 'installed',
        activation: 'required',
        bindingsReset: true,
      },
    });
    expect(readWorkflowRegistryEntry(h, scope, 'control.demo')?.value.version).toBe('2');
  });

  test('export returns a self-contained package without changing lifecycle', () => {
    const h = home();
    executeWorkflowPackageControl(h, {
      action: 'install',
      scope,
      location: { kind: 'controller', controllerHome: h },
      bundle: bundle(),
      runtimeVersion: '1.8.2',
      authorization: { canInstallWorkflows: true },
    });
    const exported = executeWorkflowPackageControl(h, {
      action: 'export',
      scope,
      workflowId: 'control.demo',
      metadata: {
        tags: ['exported'],
        risk: { level: 'read', requiresApproval: false },
        publisher: { kind: 'user', id: 'owner' },
      },
    });
    expect(exported).toMatchObject({
      action: 'export',
      bundle: { manifest: { workflowId: 'control.demo', tags: ['exported'] } },
    });
    expect(readWorkflowRegistryEntry(h, scope, 'control.demo')?.value.status).toBe('installed');
  });
  test('install authority is enforced inside the service, independent of publisher provenance', () => {
    const h = home();
    expect(() =>
      executeWorkflowPackageControl(h, {
        action: 'install',
        scope,
        location: { kind: 'controller', controllerHome: h },
        bundle: bundle(),
        runtimeVersion: '1.8.2',
        authorization: { canInstallWorkflows: false },
      }),
    ).toThrow('WORKFLOW_PACKAGE_INSTALL_NOT_AUTHORIZED');
    expect(readWorkflowRegistryEntry(h, scope, 'control.demo')).toBeUndefined();
  });
  test('the package service surface intentionally exposes no lifecycle activation or execution action', () => {
    const actions = ['list', 'search', 'preflight', 'install', 'update', 'export'];
    expect(actions).not.toContain('activate');
    expect(actions).not.toContain('execute');
  });
});
