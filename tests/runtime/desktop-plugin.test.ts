import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { AssistantPluginError } from '../../src/runtime/plugins/errors';
import { executeManagedPluginProcess } from '../../src/runtime/plugins/managed-process-adapter';
import {
  buildDesktopPluginManifest,
  executeDesktopPluginAction,
  resolveDesktopHelperPath,
  resetDesktopPluginHooksForTest,
  setDesktopPluginHooksForTest,
} from '../../src/runtime/plugins/desktop-adapter';
import {
  clearAssistantPluginManifestCacheForTest,
  controllerPluginRepository,
  getAssistantPluginManifest,
  listAssistantPluginManifests,
  submitAssistantPluginAction,
} from '../../src/runtime/plugins/store';

const roots: string[] = [];

afterEach(() => {
  resetDesktopPluginHooksForTest();
  clearAssistantPluginManifestCacheForTest();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-desktop-plugin-'));
  roots.push(controllerHome);
  return {
    controllerHome,
    repository: controllerPluginRepository(controllerHome),
  };
}

function actionInput(controllerHome: string, actionId: string, args: Record<string, unknown> = {}) {
  return {
    controllerHome,
    repoId: '__controller__',
    repoRoot: join(controllerHome, 'system'),
    pluginId: 'desktop',
    actionId,
    requestId: `desktop-${actionId}-${Date.now()}`,
    args,
    origin: { surface: 'mcp' as const, actor: 'test' },
  };
}

async function expectPluginError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AssistantPluginError);
    expect((error as AssistantPluginError).code).toBe(code);
  }
}

describe('bundled Desktop plugin', () => {
  test('is controller-scoped, bundled, and disabled by default', () => {
    const { repository } = fixture();
    setDesktopPluginHooksForTest({ platform: 'darwin', resolveHelperPath: () => '/bundled/helper.mjs' });
    const manifests = listAssistantPluginManifests(repository.canonicalRoot.replace(/\/system$/, ''), repository);
    const desktop = manifests.find((entry) => entry.pluginId === 'desktop');
    expect(desktop).toBeDefined();
    expect(desktop?.enabled).toBe(false);
    expect(desktop?.health.state).toBe('disabled');
    expect(desktop?.health.details?.runtime).toBe('managed_process');
    expect(desktop?.health.details?.helperPathReturned).toBe(false);
  });

  test('resolves the helper from the validated Supervisor release identity before development fallbacks', () => {
    const releasePath = mkdtempSync(join(tmpdir(), 'repo-harness-desktop-release-'));
    roots.push(releasePath);
    const helperPath = join(releasePath, 'repo-harness-desktop-helper.mjs');
    writeFileSync(helperPath, 'export {};\n');
    writeFileSync(join(releasePath, 'manifest.json'), `${JSON.stringify({
      schemaVersion: 3,
      releaseRevision: 'desktop-release-test',
      sourceCommit: 'desktop-source-test',
    })}\n`);

    expect(resolveDesktopHelperPath({
      env: {
        REPO_HARNESS_RELEASE_PATH: releasePath,
        REPO_HARNESS_RELEASE_REVISION: 'desktop-release-test',
        REPO_HARNESS_RELEASE_SOURCE_COMMIT: 'desktop-source-test',
      },
      argvEntry: '/missing/repo-harness.js',
      runtimeExecutable: '/missing/runtime',
      sourceHelperPath: '/missing/source-helper.mjs',
    })).toBe(helperPath);
  });

  test('configure enables the plugin and status routes through the managed helper', async () => {
    const { controllerHome, repository } = fixture();
    const calls: Array<{ actionId: string; input: Record<string, unknown>; runtimeExecutable?: string }> = [];
    setDesktopPluginHooksForTest({
      platform: 'darwin',
      resolveHelperPath: () => '/bundled/helper.mjs',
      resolveRuntimeExecutable: () => '/trusted/node',
      executeManaged: async (spec, request) => {
        calls.push({ actionId: request.actionId, input: request.input, runtimeExecutable: spec.runtimeExecutable });
        return { managed: true, actionId: request.actionId };
      },
    });

    const configured = await submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'desktop',
      actionId: 'configure',
      requestId: 'desktop-configure-test',
      args: { enabled: true },
      origin: { surface: 'mcp', actor: 'test' },
    });
    expect(configured.result?.result).toMatchObject({ config: { enabled: true } });
    clearAssistantPluginManifestCacheForTest();
    const manifest = getAssistantPluginManifest(controllerHome, repository, 'desktop');
    expect(manifest.enabled).toBe(true);
    expect(manifest.health.state).toBe('ready');

    const status = await submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'desktop',
      actionId: 'status',
      requestId: 'desktop-status-test',
      args: {},
      origin: { surface: 'mcp', actor: 'test' },
    });
    expect(status.result?.result).toEqual({ managed: true, actionId: 'status' });
    expect(calls).toEqual([{ actionId: 'status', input: {}, runtimeExecutable: '/trusted/node' }]);
  });

  test('disabled actions fail closed before the helper starts', async () => {
    const { controllerHome } = fixture();
    let executed = false;
    setDesktopPluginHooksForTest({
      platform: 'darwin',
      resolveHelperPath: () => '/bundled/helper.mjs',
      executeManaged: async () => {
        executed = true;
        return {};
      },
    });
    await expectPluginError(executeDesktopPluginAction(actionInput(controllerHome, 'status')), 'PLUGIN_DISABLED');
    expect(executed).toBe(false);
  });

  test('open_application requires exactly one typed selector', async () => {
    const { controllerHome } = fixture();
    setDesktopPluginHooksForTest({
      platform: 'darwin',
      resolveHelperPath: () => '/bundled/helper.mjs',
      resolveRuntimeExecutable: () => '/trusted/node',
      executeManaged: async () => ({ opened: true }),
    });
    await executeDesktopPluginAction(actionInput(controllerHome, 'configure', { enabled: true }));
    await expectPluginError(executeDesktopPluginAction(actionInput(controllerHome, 'open_application', {})), 'PLUGIN_ACTION_ARGUMENT_INVALID');
    await expectPluginError(executeDesktopPluginAction(actionInput(controllerHome, 'open_application', { app_name: 'Finder', bundle_id: 'com.apple.finder' })), 'PLUGIN_ACTION_ARGUMENT_INVALID');
    const opened = await executeDesktopPluginAction(actionInput(controllerHome, 'open_application', { bundle_id: 'com.apple.finder' }));
    expect(opened).toEqual({ opened: true });
  });

  test('the bundled helper completes an asynchronous observation request', async () => {
    const helperPath = fileURLToPath(new URL('../../bin/repo-harness-desktop-helper.mjs', import.meta.url));
    const result = await executeManagedPluginProcess({
      pluginId: 'desktop',
      helperPath,
      requiredCapabilities: ['status', 'observe', 'open_application'],
      timeoutMs: 10_000,
    }, {
      requestId: 'desktop-bundled-helper-observe-test',
      actionId: 'observe',
      input: {},
    });
    expect(typeof result.observed).toBe('boolean');
    expect(result.permissions).toBeDefined();
  });

  test('non-macOS enablement is truthful and degraded', async () => {
    const { controllerHome } = fixture();
    setDesktopPluginHooksForTest({ platform: 'linux', resolveHelperPath: () => '/bundled/helper.mjs' });
    await executeDesktopPluginAction(actionInput(controllerHome, 'configure', { enabled: true }));
    const manifest = buildDesktopPluginManifest(0, undefined, join(controllerHome, 'system'));
    expect(manifest.enabled).toBe(true);
    expect(manifest.lifecycle.state).toBe('degraded');
    expect(manifest.health.ready).toBe(false);
    await expectPluginError(executeDesktopPluginAction(actionInput(controllerHome, 'observe')), 'PLUGIN_DESKTOP_PLATFORM_UNSUPPORTED');
  });
});
