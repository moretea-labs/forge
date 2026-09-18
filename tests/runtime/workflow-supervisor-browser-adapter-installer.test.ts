import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  installWorkflowSupervisorBrowserAdapter,
  inspectWorkflowSupervisorBrowserAdapter,
  type WorkflowSupervisorBrowserInstallation,
} from '../../supervisor/browser-adapter-installer';
import { WORKFLOW_SUPERVISOR_NATIVE_HOST_NAME } from '../../supervisor/native-messaging/host';
import { buildLocalSystemPluginManifest, localSystemPluginAdapter } from '../../src/runtime/plugins/local-system-adapter';
const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});
function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function fixture() {
  const root = temp('forge-supervisor-browser-adapter-');
  const controllerHome = join(root, 'controller');
  const releaseRoot = join(root, 'release');
  const extensionSourcePath = join(releaseRoot, 'package', 'supervisor', 'chrome-extension');
  const nativeHostSourcePath = join(releaseRoot, 'forge-workflow-supervisor-native-host');
  const userDataRoot = join(root, 'chrome');
  const nativeMessagingRoot = join(root, 'native-hosts');
  mkdirSync(extensionSourcePath, { recursive: true });
  mkdirSync(join(userDataRoot, 'Default'), { recursive: true });
  for (const file of ['manifest.json', 'background.js', 'content.js', 'core.js']) {
    writeFileSync(join(extensionSourcePath, file), file === 'manifest.json' ? '{"manifest_version":3}\n' : '// fixture\n');
  }
  writeFileSync(nativeHostSourcePath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const browserInstallations: WorkflowSupervisorBrowserInstallation[] = [{
    browser: 'chrome',
    userDataRoot,
    nativeMessagingRoot,
  }];
  const activeRelease = () => ({
    releaseId: 'release-test',
    extensionSourcePath,
    nativeHostSourcePath,
    nativeHostArtifactIdentity: 'sha256:' + sha256(nativeHostSourcePath),
  });
  return { controllerHome, userDataRoot, nativeMessagingRoot, browserInstallations, activeRelease };
}
describe('local_system Workflow Supervisor browser adapter surface', () => {
  test('exposes only bounded argument-free Controller actions', () => {
    const manifest = buildLocalSystemPluginManifest();
    expect(localSystemPluginAdapter.scope).toBe('controller');
    const status = manifest.actions.find((entry) => entry.actionId === 'workflow_supervisor_browser_adapter_status');
    const install = manifest.actions.find((entry) => entry.actionId === 'install_workflow_supervisor_browser_adapter');
    expect(status?.argumentsSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    expect(status?.readOnly).toBe(true);
    expect(install?.argumentsSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    expect(install?.confirmation).toBe('authorization');
    expect(install?.resourceClaims).toEqual([{ resource: 'provider-state', mode: 'write' }]);
    expect(manifest.capabilities.find((entry) => entry.capabilityId === 'local-system-workflow-supervisor-browser-adapter')?.actions)
      .toEqual(['workflow_supervisor_browser_adapter_status', 'install_workflow_supervisor_browser_adapter']);
  });
});
describe('Workflow Supervisor browser adapter installer', () => {
  test('projects active release artifacts but reports Chrome authorization as an explicit boundary', () => {
    const f = fixture();
    const before = inspectWorkflowSupervisorBrowserAdapter(f.controllerHome, {
      browserInstallations: f.browserInstallations,
      activeRelease: f.activeRelease,
    });
    expect(before.state).toBe('not_installed');
    const status = installWorkflowSupervisorBrowserAdapter(f.controllerHome, {
      browserInstallations: f.browserInstallations,
      activeRelease: f.activeRelease,
    });
    expect(status.state).toBe('extension_authorization_required');
    expect(status.projectionCurrent).toBe(true);
    expect(existsSync(join(status.extensionPath, 'background.js'))).toBe(true);
    expect(existsSync(status.nativeHostPath)).toBe(true);
    expect(status.extensionBindings).toEqual([]);
    expect(existsSync(join(f.nativeMessagingRoot, WORKFLOW_SUPERVISOR_NATIVE_HOST_NAME + '.json'))).toBe(false);
  });
  test('discovers exact enabled extension identity and registers only exact allowed origins', () => {
    const f = fixture();
    const projected = installWorkflowSupervisorBrowserAdapter(f.controllerHome, {
      browserInstallations: f.browserInstallations,
      activeRelease: f.activeRelease,
    });
    const extensionId = 'a'.repeat(32);
    writeFileSync(join(f.userDataRoot, 'Default', 'Preferences'), JSON.stringify({
      extensions: { settings: { [extensionId]: { state: 1, path: projected.extensionPath } } },
    }));
    const ready = installWorkflowSupervisorBrowserAdapter(f.controllerHome, {
      browserInstallations: f.browserInstallations,
      activeRelease: f.activeRelease,
    });
    expect(ready.state).toBe('ready');
    expect(ready.extensionBindings).toEqual([expect.objectContaining({
      extensionId,
      profileDirectory: 'Default',
      browser: 'chrome',
    })]);
    const manifestPath = join(f.nativeMessagingRoot, WORKFLOW_SUPERVISOR_NATIVE_HOST_NAME + '.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(manifest.path).toBe(ready.nativeHostPath);
    expect(manifest.allowed_origins).toEqual(['chrome-extension://' + extensionId + '/']);
    const repeated = installWorkflowSupervisorBrowserAdapter(f.controllerHome, {
      browserInstallations: f.browserInstallations,
      activeRelease: f.activeRelease,
    });
    expect(repeated.state).toBe('ready');
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual(manifest);
  });
});
