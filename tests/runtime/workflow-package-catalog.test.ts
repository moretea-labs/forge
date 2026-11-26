import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeWorkflowAsset } from '../../packages/workflow-runtime/domain/workflow-asset';
import { materializeWorkflowPackageBundle } from '../../packages/workflow-runtime/domain/workflow-package-bundle';
import {
  writeWorkflowAssetContent,
  workflowAssetContentPath,
} from '../../src/runtime/control-plane/persistence/workflow-content-store';
import { registerWorkflowFeatureAsset } from '../../src/runtime/control-plane/persistence/workflow-registry-store';
import { installWorkflowPackage } from '../../src/runtime/workflows/package-install';
import {
  listWorkflowDiscoveryCatalog,
  searchWorkflowDiscoveryCatalog,
} from '../../src/runtime/workflows/package-catalog';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function home() {
  const value = mkdtempSync(join(tmpdir(), 'forge-workflow-discovery-'));
  roots.push(value);
  return value;
}
function installPackaged(h: string) {
  const asset = materializeWorkflowAsset({
    schemaVersion: 1,
    workflowId: 'notify.digest',
    version: '1',
    title: 'Daily Digest',
    description: 'Send a daily digest notification',
    steps: [{ stepId: 'notify', capabilityId: 'notify.send' }],
  });
  const bundle = materializeWorkflowPackageBundle(asset, {
    tags: ['notification', 'daily'],
    risk: { level: 'external_write', requiresApproval: true },
    publisher: { kind: 'plugin', id: 'notify-plugin' },
  });
  return installWorkflowPackage({
    controllerHome: h,
    scope: { kind: 'controller' },
    location: { kind: 'controller', controllerHome: h },
    bundle,
    runtimeVersion: '1.8.2',
    authorization: { canInstallWorkflows: true },
  });
}
function installLegacy(h: string) {
  const written = writeWorkflowAssetContent(
    { kind: 'controller', controllerHome: h },
    {
      schemaVersion: 1,
      workflowId: 'legacy.cleanup',
      version: '1',
      title: 'Legacy Cleanup',
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

describe('Workflow Package discovery catalog', () => {
  test('keeps packaged and legacy workflows discoverable through one first-class catalog', () => {
    const h = home();
    installPackaged(h);
    installLegacy(h);
    const entries = listWorkflowDiscoveryCatalog(h, { kind: 'controller' });
    expect(entries.map((entry) => [entry.workflow.descriptor.workflowId, entry.packageStatus])).toEqual([
      ['legacy.cleanup', 'legacy_unpacked'],
      ['notify.digest', 'packaged'],
    ]);
  });
  test('searches package tags and publisher metadata without coupling to Event', () => {
    const h = home();
    installPackaged(h);
    installLegacy(h);
    expect(
      searchWorkflowDiscoveryCatalog(h, { kind: 'controller' }, { tags: ['daily'] }).map(
        (entry) => entry.workflow.descriptor.workflowId,
      ),
    ).toEqual(['notify.digest']);
    expect(
      searchWorkflowDiscoveryCatalog(h, { kind: 'controller' }, { text: 'notify-plugin' }).map(
        (entry) => entry.workflow.descriptor.workflowId,
      ),
    ).toEqual(['notify.digest']);
  });
  test('searches executable capability dependencies and human descriptions', () => {
    const h = home();
    installPackaged(h);
    installLegacy(h);
    expect(
      searchWorkflowDiscoveryCatalog(h, { kind: 'controller' }, { text: 'notify.send' }).map(
        (entry) => entry.workflow.descriptor.workflowId,
      ),
    ).toEqual(['notify.digest']);
    expect(
      searchWorkflowDiscoveryCatalog(h, { kind: 'controller' }, { text: 'cleanup' }).map(
        (entry) => entry.workflow.descriptor.workflowId,
      ),
    ).toEqual(['legacy.cleanup']);
  });
  test('quarantines one corrupted package without making the whole catalog unavailable', () => {
    const h = home();
    installPackaged(h);
    installLegacy(h);
    const path = workflowAssetContentPath({ kind: 'controller', controllerHome: h }, 'notify.digest', '1').replace(
      /workflow\.json$/,
      'package.json',
    );
    writeFileSync(path, '{not-json\n', 'utf8');
    const entries = listWorkflowDiscoveryCatalog(h, { kind: 'controller' });
    expect(entries.find((entry) => entry.workflow.descriptor.workflowId === 'notify.digest')).toMatchObject({
      packageStatus: 'invalid',
    });
    expect(entries.find((entry) => entry.workflow.descriptor.workflowId === 'notify.digest')?.packageError).toContain(
      'WORKFLOW_PACKAGE_BUNDLE_JSON_INVALID',
    );
    expect(entries.find((entry) => entry.workflow.descriptor.workflowId === 'legacy.cleanup')?.packageStatus).toBe(
      'legacy_unpacked',
    );
    expect(
      searchWorkflowDiscoveryCatalog(h, { kind: 'controller' }, { text: 'cleanup' }).map(
        (entry) => entry.workflow.descriptor.workflowId,
      ),
    ).toEqual(['legacy.cleanup']);
  });

  test('supports engine/lifecycle/packaged filters as product-level discovery facets', () => {
    const h = home();
    installPackaged(h);
    installLegacy(h);
    expect(
      searchWorkflowDiscoveryCatalog(h, { kind: 'controller' }, { engine: 'sequence_v1', lifecycle: 'active' }).map(
        (entry) => entry.workflow.descriptor.workflowId,
      ),
    ).toEqual(['legacy.cleanup']);
    expect(
      searchWorkflowDiscoveryCatalog(h, { kind: 'controller' }, { packagedOnly: true }).map(
        (entry) => entry.workflow.descriptor.workflowId,
      ),
    ).toEqual(['notify.digest']);
  });
});
