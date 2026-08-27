import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CONTROLLER_SCOPE_REPO_ID, controllerSystemRoot } from '../../src/cli/repositories/controller-home';
import {
  buildAppStoreConnectPluginManifest,
  executeAppStoreConnectPluginAction,
  resolveAppStoreConnectXcodeAuthenticationReference,
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
    for (const actionId of ['list_bundle_ids', 'list_bundle_id_capabilities', 'list_certificates', 'list_devices', 'list_profiles']) {
      expect(manifest.actions.find((action) => action.actionId === actionId)).toMatchObject({
        readOnly: true,
        risk: 'readonly',
        confirmation: 'none',
        scopes: ['appstoreconnect.developer_resources.read'],
      });
    }
    expect(manifest.capabilities.find((capability) => capability.capabilityId === 'developer-resources-read')?.actions).toEqual([
      'list_bundle_ids', 'list_bundle_id_capabilities', 'list_certificates', 'list_devices', 'list_profiles',
    ]);
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


  test('controller-global profile is inherited by repositories without duplicating credential references', async () => {
    const repoRoot = root();
    const controllerHome = join(repoRoot, '.controller');
    const privateKeyPath = join(repoRoot, 'AuthKey_TEST.p8');
    writeFileSync(privateKeyPath, 'test-key-material-never-persisted-inline');

    const controllerInput = {
      ...input(repoRoot, 'configure', {
        enabled: true,
        provider: 'app-store-connect-api',
        issuer_id: 'issuer-global',
        key_id: 'key-global',
        private_key_path: privateKeyPath,
        team_id: 'TEAMGLOBAL',
      }),
      controllerHome,
      repoId: CONTROLLER_SCOPE_REPO_ID,
      repoRoot: controllerSystemRoot(controllerHome),
    };
    await executeAppStoreConnectPluginAction(controllerInput);

    const manifest = buildAppStoreConnectPluginManifest(1, undefined, repoRoot, {
      controllerHome,
      repoId: 'repo-child',
      repoRoot,
      controllerScoped: false,
    });
    expect(manifest.enabled).toBe(true);
    expect(manifest.health.details).toMatchObject({ teamId: 'TEAMGLOBAL', credentialSource: 'config:privateKeyPath' });
    expect(existsSync(join(repoRoot, '.forge', 'plugins', 'app-store-connect.json'))).toBe(false);

    const globalPath = join(controllerSystemRoot(controllerHome), 'plugins', 'profiles', 'app-store-connect.json');
    const persisted = readFileSync(globalPath, 'utf-8');
    expect(persisted).toContain(privateKeyPath);
    expect(persisted).not.toContain('test-key-material-never-persisted-inline');
  });

  test('resolves a file-backed Xcode authentication reference from the controller-global profile for a repository', async () => {
    const repoRoot = root();
    const controllerHome = join(repoRoot, '.controller');
    const privateKeyPath = join(repoRoot, 'AuthKey_XCODE.p8');
    writeFileSync(privateKeyPath, 'file-backed-test-key');
    await executeAppStoreConnectPluginAction({
      ...input(repoRoot, 'configure', {
        enabled: true,
        provider: 'app-store-connect-api',
        issuer_id: 'issuer-xcode',
        key_id: 'key-xcode',
        private_key_path: privateKeyPath,
      }),
      controllerHome,
      repoId: CONTROLLER_SCOPE_REPO_ID,
      repoRoot: controllerSystemRoot(controllerHome),
    });

    const reference = resolveAppStoreConnectXcodeAuthenticationReference(repoRoot, controllerHome, 'repo-child');
    expect(reference).toEqual({ privateKeyPath, keyId: 'key-xcode', issuerId: 'issuer-xcode' });
    expect(existsSync(join(repoRoot, '.forge', 'plugins', 'app-store-connect.json'))).toBe(false);
  });

  test('repository overlay can override safe defaults or explicitly disable a global profile', async () => {
    const repoRoot = root();
    const controllerHome = join(repoRoot, '.controller');
    await executeAppStoreConnectPluginAction({
      ...input(repoRoot, 'configure', { enabled: true, provider: 'mock', team_id: 'GLOBAL', default_locale: 'en-US' }),
      controllerHome,
      repoId: CONTROLLER_SCOPE_REPO_ID,
      repoRoot: controllerSystemRoot(controllerHome),
    });

    const child = { ...input(repoRoot, 'configure', { default_locale: 'fr-FR' }), controllerHome, repoId: 'repo-child' };
    const configured = await executeAppStoreConnectPluginAction(child) as { config: { enabled: boolean; teamId?: string; defaultLocale?: string } };
    expect(configured.config).toMatchObject({ enabled: true, teamId: 'GLOBAL', defaultLocale: 'fr-FR' });
    const overlayPath = join(repoRoot, '.forge', 'plugins', 'app-store-connect.json');
    const overlay = JSON.parse(readFileSync(overlayPath, 'utf-8')) as Record<string, unknown>;
    expect(overlay).toMatchObject({ schemaVersion: 1, defaultLocale: 'fr-FR' });
    expect(overlay).not.toHaveProperty('teamId');
    expect(overlay).not.toHaveProperty('privateKeyPath');

    await executeAppStoreConnectPluginAction({ ...child, requestId: 'test-disable', args: { enabled: false } });
    const disabled = buildAppStoreConnectPluginManifest(1, undefined, repoRoot, {
      controllerHome,
      repoId: 'repo-child',
      repoRoot,
      controllerScoped: false,
    });
    expect(disabled.enabled).toBe(false);
  });

  test('mock developer-resource reads stay read-only and preserve bounded typed filters', async () => {
    const repoRoot = root();
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', { enabled: true, provider: 'mock' }));
    const bundleIds = await executeAppStoreConnectPluginAction(input(repoRoot, 'list_bundle_ids', { identifier: 'com.example.target', limit: 5 })) as { data: Array<{ attributes: { identifier: string } }> };
    const capabilities = await executeAppStoreConnectPluginAction(input(repoRoot, 'list_bundle_id_capabilities', { bundle_id_resource_id: 'bundle-1' })) as { data: Array<{ attributes: { capabilityType: string } }> };
    const devices = await executeAppStoreConnectPluginAction(input(repoRoot, 'list_devices', { udid: 'DEVICE-UDID' })) as { data: Array<{ attributes: { udid: string } }> };
    expect(bundleIds.data[0]?.attributes.identifier).toBe('com.example.target');
    expect(capabilities.data[0]?.attributes.capabilityType).toBe('ICLOUD');
    expect(devices.data[0]?.attributes.udid).toBe('DEVICE-UDID');
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
