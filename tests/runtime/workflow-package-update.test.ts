import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeWorkflowAsset } from '../../packages/workflow-runtime/domain/workflow-asset';
import { materializeWorkflowPackageBundle } from '../../packages/workflow-runtime/domain/workflow-package-bundle';
import {
  readWorkflowRegistryEntry,
  recordWorkflowBindings,
  setWorkflowRegistryStatus,
} from '../../src/runtime/control-plane/persistence/workflow-registry-store';
import { workflowAssetContentPath } from '../../src/runtime/control-plane/persistence/workflow-content-store';
import { writeWorkflowRunCheckpoint } from '../../src/runtime/control-plane/persistence/workflow-run-store';
import { installWorkflowPackage } from '../../src/runtime/workflows/package-install';
import { updateWorkflowPackage } from '../../src/runtime/workflows/package-update';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function home() {
  const value = mkdtempSync(join(tmpdir(), 'forge-workflow-package-update-'));
  roots.push(value);
  return value;
}
const scope = { kind: 'controller' as const };
function bundle(version: string, capability = 'notify.send', minRuntimeVersion = '1.8.0') {
  const asset = materializeWorkflowAsset({
    schemaVersion: 1,
    workflowId: 'upgrade.demo',
    version,
    title: `Upgrade ${version}`,
    steps: [{ stepId: 'notify', capabilityId: capability }],
  });
  return materializeWorkflowPackageBundle(asset, {
    runtimeCompatibility: { minRuntimeVersion },
    risk: { level: 'external_write', requiresApproval: true },
    publisher: { kind: 'model', id: 'workflow-author' },
  });
}
function installV1(h: string) {
  const first = bundle('1');
  const installed = installWorkflowPackage({
    controllerHome: h,
    scope,
    location: { kind: 'controller', controllerHome: h },
    bundle: first,
    runtimeVersion: '1.8.2',
    authorization: { canInstallWorkflows: true },
  });
  recordWorkflowBindings({
    controllerHome: h,
    scope,
    expectedIdentity: { workflowId: 'upgrade.demo', version: '1', contentDigest: first.manifest.contentDigest },
    bindings: [{ capabilityId: 'notify.send', pluginId: 'notify', actionId: 'send' }],
    expectedRevision: installed.registryRevision,
  });
  const bound = readWorkflowRegistryEntry(h, scope, 'upgrade.demo')!;
  setWorkflowRegistryStatus({
    controllerHome: h,
    scope,
    workflowId: 'upgrade.demo',
    status: 'active',
    expectedRevision: bound.revision,
  });
  return { first, active: readWorkflowRegistryEntry(h, scope, 'upgrade.demo')! };
}

describe('Workflow Package update service', () => {
  test('upgrades exact package identity, preserves old content, resets bindings and requires reactivation', () => {
    const h = home();
    const { active } = installV1(h);
    const oldPath = workflowAssetContentPath({ kind: 'controller', controllerHome: h }, 'upgrade.demo', '1');
    const next = bundle('2', 'notify.send.v2');
    const result = updateWorkflowPackage({
      controllerHome: h,
      scope,
      location: { kind: 'controller', controllerHome: h },
      workflowId: 'upgrade.demo',
      bundle: next,
      runtimeVersion: '1.8.2',
      expectedRegistryRevision: active.revision,
      authorization: { canUpdateWorkflows: true },
    });
    expect(result).toMatchObject({
      previousVersion: '1',
      version: '2',
      lifecycleStatus: 'installed',
      activation: 'required',
      bindingsReset: true,
    });
    expect(existsSync(oldPath)).toBe(true);
    expect(existsSync(result.contentPath)).toBe(true);
    const current = readWorkflowRegistryEntry(h, scope, 'upgrade.demo')!;
    expect(current.value.status).toBe('installed');
    expect(current.value.bindings).toEqual([]);
    expect(current.value.contentDigest).toBe(next.manifest.contentDigest);
  });
  test('requires explicit update authority even when publisher is model', () => {
    const h = home();
    const { active } = installV1(h);
    expect(() =>
      updateWorkflowPackage({
        controllerHome: h,
        scope,
        location: { kind: 'controller', controllerHome: h },
        workflowId: 'upgrade.demo',
        bundle: bundle('2'),
        runtimeVersion: '1.8.2',
        expectedRegistryRevision: active.revision,
        authorization: { canUpdateWorkflows: false },
      }),
    ).toThrow('WORKFLOW_PACKAGE_UPDATE_NOT_AUTHORIZED');
    expect(readWorkflowRegistryEntry(h, scope, 'upgrade.demo')?.value.version).toBe('1');
  });
  test('rejects stale registry revision before writing new version content', () => {
    const h = home();
    const { active } = installV1(h);
    const nextPath = workflowAssetContentPath({ kind: 'controller', controllerHome: h }, 'upgrade.demo', '2');
    expect(() =>
      updateWorkflowPackage({
        controllerHome: h,
        scope,
        location: { kind: 'controller', controllerHome: h },
        workflowId: 'upgrade.demo',
        bundle: bundle('2'),
        runtimeVersion: '1.8.2',
        expectedRegistryRevision: active.revision - 1,
        authorization: { canUpdateWorkflows: true },
      }),
    ).toThrow('WORKFLOW_PACKAGE_UPDATE_REVISION_CONFLICT');
    expect(existsSync(nextPath)).toBe(false);
  });
  test('treats workflow version as immutable content identity', () => {
    const h = home();
    const { active } = installV1(h);
    const conflicting = bundle('1', 'different.capability');
    expect(() =>
      updateWorkflowPackage({
        controllerHome: h,
        scope,
        location: { kind: 'controller', controllerHome: h },
        workflowId: 'upgrade.demo',
        bundle: conflicting,
        runtimeVersion: '1.8.2',
        expectedRegistryRevision: active.revision,
        authorization: { canUpdateWorkflows: true },
      }),
    ).toThrow('WORKFLOW_PACKAGE_UPDATE_VERSION_CONTENT_CONFLICT');
    expect(readWorkflowRegistryEntry(h, scope, 'upgrade.demo')?.value.contentDigest).toBe(active.value.contentDigest);
  });

  test('rejects unchanged identity and wrong workflow id', () => {
    const h = home();
    const { first, active } = installV1(h);
    expect(() =>
      updateWorkflowPackage({
        controllerHome: h,
        scope,
        location: { kind: 'controller', controllerHome: h },
        workflowId: 'upgrade.demo',
        bundle: first,
        runtimeVersion: '1.8.2',
        expectedRegistryRevision: active.revision,
        authorization: { canUpdateWorkflows: true },
      }),
    ).toThrow('WORKFLOW_PACKAGE_UPDATE_IDENTITY_UNCHANGED');
    const otherAsset = materializeWorkflowAsset({
      schemaVersion: 1,
      workflowId: 'other.workflow',
      version: '2',
      steps: [{ stepId: 'noop', kind: 'script', scriptRef: 'noop' }],
      scripts: { noop: { runtime: 'node', deterministic: true, body: 'process.stdout.write("ok")' } },
    });
    const other = materializeWorkflowPackageBundle(otherAsset, {
      risk: { level: 'read', requiresApproval: false },
      publisher: { kind: 'user', id: 'owner' },
    });
    expect(() =>
      updateWorkflowPackage({
        controllerHome: h,
        scope,
        location: { kind: 'controller', controllerHome: h },
        workflowId: 'upgrade.demo',
        bundle: other,
        runtimeVersion: '1.8.2',
        expectedRegistryRevision: active.revision,
        authorization: { canUpdateWorkflows: true },
      }),
    ).toThrow('WORKFLOW_PACKAGE_UPDATE_WORKFLOW_ID_MISMATCH');
  });
  test('blocks identity switch while the current version has a nonterminal run', () => {
    const h = home();
    const { active } = installV1(h);
    writeWorkflowRunCheckpoint({
      controllerHome: h,
      inputs: {},
      checkpoint: {
        schemaVersion: 1,
        binding: { scopeId: 'repository:r:checkout:c:workflow:upgrade.demo', runId: 'run-live' },
        workflowId: 'upgrade.demo',
        version: '1',
        contentDigest: active.value.contentDigest,
        status: 'running',
        nextStepIndex: 0,
        receipts: [],
        outputs: {},
      },
    });
    expect(() =>
      updateWorkflowPackage({
        controllerHome: h,
        scope,
        location: { kind: 'controller', controllerHome: h },
        workflowId: 'upgrade.demo',
        bundle: bundle('2'),
        runtimeVersion: '1.8.2',
        expectedRegistryRevision: active.revision,
        authorization: { canUpdateWorkflows: true },
      }),
    ).toThrow(/WORKFLOW_PACKAGE_UPDATE_NONTERMINAL_RUNS:1:.*run-live:running/);
    expect(readWorkflowRegistryEntry(h, scope, 'upgrade.demo')?.value).toMatchObject({
      version: '1',
      status: 'active',
    });
  });

  test('terminal runs do not block a later package identity switch', () => {
    const h = home();
    const { active } = installV1(h);
    writeWorkflowRunCheckpoint({
      controllerHome: h,
      inputs: {},
      checkpoint: {
        schemaVersion: 1,
        binding: { scopeId: 'repository:r:checkout:c:workflow:upgrade.demo', runId: 'run-done' },
        workflowId: 'upgrade.demo',
        version: '1',
        contentDigest: active.value.contentDigest,
        status: 'succeeded',
        nextStepIndex: 1,
        receipts: [],
        outputs: {},
      },
    });
    const result = updateWorkflowPackage({
      controllerHome: h,
      scope,
      location: { kind: 'controller', controllerHome: h },
      workflowId: 'upgrade.demo',
      bundle: bundle('2'),
      runtimeVersion: '1.8.2',
      expectedRegistryRevision: active.revision,
      authorization: { canUpdateWorkflows: true },
    });
    expect(result.version).toBe('2');
  });

  test('rejects update content locations outside the Registry ownership scope before writing', () => {
    const h = home();
    const { active } = installV1(h);
    expect(() =>
      updateWorkflowPackage({
        controllerHome: h,
        scope,
        location: {
          kind: 'project',
          contract: {
            schemaVersion: 1,
            projectId: 'other',
            projectRoot: join(h, 'other'),
            workflowAssetDirectory: 'workflows',
          },
        },
        workflowId: 'upgrade.demo',
        bundle: bundle('2'),
        runtimeVersion: '1.8.2',
        expectedRegistryRevision: active.revision,
        authorization: { canUpdateWorkflows: true },
      }),
    ).toThrow('WORKFLOW_PACKAGE_LOCATION_SCOPE_MISMATCH');
    expect(readWorkflowRegistryEntry(h, scope, 'upgrade.demo')?.value.version).toBe('1');
  });

  test('refuses to overwrite orphan conflicting content at the target new version', () => {
    const h = home();
    const { active } = installV1(h);
    const { writeWorkflowAssetContent } = require('../../src/runtime/control-plane/persistence/workflow-content-store');
    writeWorkflowAssetContent(
      { kind: 'controller', controllerHome: h },
      {
        schemaVersion: 1,
        workflowId: 'upgrade.demo',
        version: '2',
        title: 'orphan conflict',
        steps: [{ stepId: 'noop', kind: 'script', scriptRef: 'noop' }],
        scripts: { noop: { runtime: 'node', deterministic: true, body: 'process.stdout.write("orphan")' } },
      },
    );
    expect(() =>
      updateWorkflowPackage({
        controllerHome: h,
        scope,
        location: { kind: 'controller', controllerHome: h },
        workflowId: 'upgrade.demo',
        bundle: bundle('2'),
        runtimeVersion: '1.8.2',
        expectedRegistryRevision: active.revision,
        authorization: { canUpdateWorkflows: true },
      }),
    ).toThrow('WORKFLOW_PACKAGE_EXECUTABLE_IMMUTABLE_CONFLICT:upgrade.demo:2');
    expect(readWorkflowRegistryEntry(h, scope, 'upgrade.demo')?.value.version).toBe('1');
  });

  test('runtime incompatibility blocks upgrade without changing active identity', () => {
    const h = home();
    const { active } = installV1(h);
    expect(() =>
      updateWorkflowPackage({
        controllerHome: h,
        scope,
        location: { kind: 'controller', controllerHome: h },
        workflowId: 'upgrade.demo',
        bundle: bundle('2', 'notify.send', '2.0.0'),
        runtimeVersion: '1.8.2',
        expectedRegistryRevision: active.revision,
        authorization: { canUpdateWorkflows: true },
      }),
    ).toThrow(/WORKFLOW_PACKAGE_RUNTIME_TOO_OLD/);
    expect(readWorkflowRegistryEntry(h, scope, 'upgrade.demo')?.value).toMatchObject({
      version: '1',
      status: 'active',
    });
  });
});
