import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildAppStoreConnectPluginManifest,
  executeAppStoreConnectPluginAction,
} from '../../src/runtime/plugins/app-store-connect-adapter';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'forge-asc-xcode-cloud-'));
  roots.push(value);
  return value;
}

function input(repoRoot: string, actionId: string, args: Record<string, unknown>) {
  return {
    controllerHome: join(repoRoot, '.controller'),
    repoId: 'repo-test',
    repoRoot,
    pluginId: 'app_store_connect',
    actionId,
    requestId: `test-${actionId}`,
    args,
    origin: { surface: 'mcp' as const, actor: 'test' },
  };
}

describe('App Store Connect Xcode Cloud workflow actions', () => {
  test('manifest exposes typed read and strongly-confirmed workflow write actions', async () => {
    const repoRoot = root();
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', { enabled: true, provider: 'mock' }));
    const manifest = buildAppStoreConnectPluginManifest(1, undefined, repoRoot);
    expect(manifest.pluginVersion).toBe('1.1.1');
    expect(manifest.actions.find((action) => action.actionId === 'list_xcode_cloud_workflows')).toMatchObject({ readOnly: true, risk: 'readonly' });
    expect(manifest.actions.find((action) => action.actionId === 'update_xcode_cloud_workflow')).toMatchObject({
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'strong_confirmation',
      requiredConfirmationText: 'update-xcode-cloud-workflow',
    });
  });

  test('reads legacy repo-harness config when the Forge config path has not been migrated yet', async () => {
    const repoRoot = root();
    const legacyRoot = join(repoRoot, '.repo-harness', 'plugins');
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(join(legacyRoot, 'app-store-connect.json'), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      provider: 'mock',
      defaultLocale: 'en-US',
    }, null, 2));

    const manifest = buildAppStoreConnectPluginManifest(1, undefined, repoRoot);
    expect(manifest.enabled).toBe(true);
    expect(manifest.health.ready).toBe(true);
    expect(manifest.authority.sourceOfTruth).toContain('legacy-read-fallback:.repo-harness/plugins/app-store-connect.json');
    const auth = await executeAppStoreConnectPluginAction(input(repoRoot, 'auth_status', {}));
    expect(auth).toMatchObject({ ready: true, provider: 'mock' });
  });

  test('dry-run maps workflow trigger settings onto the official ciWorkflows PATCH resource', async () => {
    const repoRoot = root();
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', { enabled: true, provider: 'mock' }));
    const result = await executeAppStoreConnectPluginAction(input(repoRoot, 'update_xcode_cloud_workflow', {
      workflow_id: 'workflow-1',
      is_enabled: true,
      clean: true,
      branch_start_condition: { source: { isAllMatch: true } },
      scheduled_start_condition: null,
      dry_run: true,
    }));
    expect(result).toMatchObject({
      dryRun: true,
      request: {
        method: 'PATCH',
        path: '/v1/ciWorkflows/workflow-1',
        body: {
          data: {
            type: 'ciWorkflows',
            id: 'workflow-1',
            attributes: {
              isEnabled: true,
              clean: true,
              branchStartCondition: { source: { isAllMatch: true } },
              scheduledStartCondition: null,
            },
          },
        },
      },
    });
  });
});
