import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeWorkflowAsset } from '../../packages/workflow-runtime/domain/workflow-asset';
import { materializeWorkflowPackageBundle } from '../../packages/workflow-runtime/domain/workflow-package-bundle';
import { acquireControllerLock, releaseControllerLock } from '../../src/effects/controller-locks';
import {
  readWorkflowRegistryEntry,
  setWorkflowRegistryStatus,
} from '../../src/runtime/control-plane/persistence/workflow-registry-store';
import { readWorkflowPackageBundleContent } from '../../src/runtime/workflows/package-content-store';
import { writeWorkflowAssetContent } from '../../src/runtime/control-plane/persistence/workflow-content-store';
import { installWorkflowPackage } from '../../src/runtime/workflows/package-install';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function home() {
  const value = mkdtempSync(join(tmpdir(), 'forge-workflow-package-install-'));
  roots.push(value);
  return value;
}
const asset = materializeWorkflowAsset({
  schemaVersion: 1,
  workflowId: 'install.demo',
  version: '1',
  title: 'Install demo',
  steps: [{ stepId: 'noop', kind: 'script', scriptRef: 'noop' }],
  scripts: { noop: { runtime: 'node', deterministic: true, body: 'process.stdout.write("ok")' } },
});
function bundle() {
  return materializeWorkflowPackageBundle(asset, {
    runtimeCompatibility: { minRuntimeVersion: '1.8.0' },
    risk: { level: 'read', requiresApproval: false },
    publisher: { kind: 'model', id: 'author-model' },
  });
}

describe('Workflow Package install service', () => {
  test('installs package content and registry entry as installed without activation', () => {
    const h = home();
    const result = installWorkflowPackage({
      controllerHome: h,
      scope: { kind: 'controller' },
      location: { kind: 'controller', controllerHome: h },
      bundle: bundle(),
      runtimeVersion: '1.8.2',
      authorization: { canInstallWorkflows: true },
    });
    expect(result).toMatchObject({
      workflowId: 'install.demo',
      version: '1',
      lifecycleStatus: 'installed',
      activation: 'not_requested',
    });
    expect(readWorkflowRegistryEntry(h, { kind: 'controller' }, 'install.demo')?.value.status).toBe('installed');
    expect(
      readWorkflowPackageBundleContent({ kind: 'controller', controllerHome: h }, 'install.demo', '1').bundle,
    ).toEqual(bundle());
  });
  test('does not allow model provenance to imply install authority', () => {
    const h = home();
    expect(() =>
      installWorkflowPackage({
        controllerHome: h,
        scope: { kind: 'controller' },
        location: { kind: 'controller', controllerHome: h },
        bundle: bundle(),
        runtimeVersion: '1.8.2',
        authorization: { canInstallWorkflows: false },
      }),
    ).toThrow('WORKFLOW_PACKAGE_INSTALL_NOT_AUTHORIZED');
    expect(readWorkflowRegistryEntry(h, { kind: 'controller' }, 'install.demo')).toBeUndefined();
  });
  test('re-importing identical content preserves an existing active lifecycle state', () => {
    const h = home();
    const first = installWorkflowPackage({
      controllerHome: h,
      scope: { kind: 'controller' },
      location: { kind: 'controller', controllerHome: h },
      bundle: bundle(),
      runtimeVersion: '1.8.2',
      authorization: { canInstallWorkflows: true },
    });
    setWorkflowRegistryStatus({
      controllerHome: h,
      scope: { kind: 'controller' },
      workflowId: 'install.demo',
      status: 'active',
      expectedRevision: first.registryRevision,
    });
    const second = installWorkflowPackage({
      controllerHome: h,
      scope: { kind: 'controller' },
      location: { kind: 'controller', controllerHome: h },
      bundle: bundle(),
      runtimeVersion: '1.8.2',
      authorization: { canInstallWorkflows: true },
    });
    expect(second.lifecycleStatus).toBe('active');
    expect(second.activation).toBe('not_requested');
  });
  test('fails before registry mutation when runtime compatibility rejects the package', () => {
    const h = home();
    expect(() =>
      installWorkflowPackage({
        controllerHome: h,
        scope: { kind: 'controller' },
        location: { kind: 'controller', controllerHome: h },
        bundle: bundle(),
        runtimeVersion: '1.7.9',
        authorization: { canInstallWorkflows: true },
      }),
    ).toThrow('WORKFLOW_PACKAGE_INSTALL_PREFLIGHT_FAILED:WORKFLOW_PACKAGE_RUNTIME_TOO_OLD');
    expect(readWorkflowRegistryEntry(h, { kind: 'controller' }, 'install.demo')).toBeUndefined();
  });
  test('serializes same-workflow package writers before any content or registry mutation', () => {
    const h = home();
    const key = { scope: 'global' as const, resource: 'workflow-package-install:controller:install.demo' };
    const held = acquireControllerLock(h, key, 'competing-installer');
    try {
      expect(() =>
        installWorkflowPackage({
          controllerHome: h,
          scope: { kind: 'controller' },
          location: { kind: 'controller', controllerHome: h },
          bundle: bundle(),
          runtimeVersion: '1.8.2',
          authorization: { canInstallWorkflows: true },
        }),
      ).toThrow();
      expect(readWorkflowRegistryEntry(h, { kind: 'controller' }, 'install.demo')).toBeUndefined();
    } finally {
      releaseControllerLock(h, key, held.lockId);
    }
  });
  test('re-import cannot mutate package metadata without a version change', () => {
    const h = home();
    const original = bundle();
    installWorkflowPackage({
      controllerHome: h,
      scope: { kind: 'controller' },
      location: { kind: 'controller', controllerHome: h },
      bundle: original,
      runtimeVersion: '1.8.2',
      authorization: { canInstallWorkflows: true },
    });
    const changed = materializeWorkflowPackageBundle(asset, {
      tags: ['changed'],
      runtimeCompatibility: { minRuntimeVersion: '1.8.0' },
      risk: { level: 'read', requiresApproval: false },
      publisher: { kind: 'model', id: 'different-author' },
    });
    expect(changed.manifest.packageDigest).not.toBe(original.manifest.packageDigest);
    expect(() =>
      installWorkflowPackage({
        controllerHome: h,
        scope: { kind: 'controller' },
        location: { kind: 'controller', controllerHome: h },
        bundle: changed,
        runtimeVersion: '1.8.2',
        authorization: { canInstallWorkflows: true },
      }),
    ).toThrow('WORKFLOW_PACKAGE_CONTENT_IMMUTABLE_CONFLICT:install.demo:1');
    expect(readWorkflowRegistryEntry(h, { kind: 'controller' }, 'install.demo')?.value.status).toBe('installed');
  });

  test('rejects content locations outside the Registry ownership scope', () => {
    const h = home();
    const projectRoot = join(h, 'project-a');
    const otherProjectRoot = join(h, 'project-b');
    expect(() =>
      installWorkflowPackage({
        controllerHome: h,
        scope: { kind: 'controller' },
        location: {
          kind: 'project',
          contract: { schemaVersion: 1, projectId: 'project-a', projectRoot, workflowAssetDirectory: 'workflows' },
        },
        bundle: bundle(),
        runtimeVersion: '1.8.2',
        authorization: { canInstallWorkflows: true },
      }),
    ).toThrow('WORKFLOW_PACKAGE_LOCATION_SCOPE_MISMATCH');
    expect(() =>
      installWorkflowPackage({
        controllerHome: h,
        scope: { kind: 'project', projectId: 'project-a' },
        location: {
          kind: 'project',
          contract: {
            schemaVersion: 1,
            projectId: 'project-b',
            projectRoot: otherProjectRoot,
            workflowAssetDirectory: 'workflows',
          },
        },
        bundle: bundle(),
        runtimeVersion: '1.8.2',
        authorization: { canInstallWorkflows: true },
      }),
    ).toThrow('WORKFLOW_PACKAGE_LOCATION_PROJECT_MISMATCH');
  });

  test('refuses to overwrite pre-existing executable content for the same workflow version', () => {
    const h = home();
    writeWorkflowAssetContent(
      { kind: 'controller', controllerHome: h },
      {
        schemaVersion: 1,
        workflowId: 'install.demo',
        version: '1',
        title: 'conflicting raw content',
        steps: [{ stepId: 'noop', kind: 'script', scriptRef: 'noop' }],
        scripts: { noop: { runtime: 'node', deterministic: true, body: 'process.stdout.write("different")' } },
      },
    );
    expect(() =>
      installWorkflowPackage({
        controllerHome: h,
        scope: { kind: 'controller' },
        location: { kind: 'controller', controllerHome: h },
        bundle: bundle(),
        runtimeVersion: '1.8.2',
        authorization: { canInstallWorkflows: true },
      }),
    ).toThrow('WORKFLOW_PACKAGE_EXECUTABLE_IMMUTABLE_CONFLICT:install.demo:1');
    expect(readWorkflowRegistryEntry(h, { kind: 'controller' }, 'install.demo')).toBeUndefined();
  });

  test('never auto-binds capabilities or executes the workflow during install', () => {
    const h = home();
    const withCapability = materializeWorkflowAsset({
      schemaVersion: 1,
      workflowId: 'install.capability',
      version: '1',
      steps: [{ stepId: 'notify', capabilityId: 'notify.send' }],
    });
    const packageWithCapability = materializeWorkflowPackageBundle(withCapability, {
      risk: { level: 'external_write', requiresApproval: true },
      publisher: { kind: 'import', id: 'bundle-source' },
    });
    const result = installWorkflowPackage({
      controllerHome: h,
      scope: { kind: 'controller' },
      location: { kind: 'controller', controllerHome: h },
      bundle: packageWithCapability,
      runtimeVersion: '1.8.2',
      authorization: { canInstallWorkflows: true },
    });
    const registered = readWorkflowRegistryEntry(h, { kind: 'controller' }, 'install.capability')!;
    expect(result.lifecycleStatus).toBe('installed');
    expect(registered.value.bindings).toEqual([]);
    expect(registered.value.executionReceiptReuseRefs).toEqual([]);
  });
});
