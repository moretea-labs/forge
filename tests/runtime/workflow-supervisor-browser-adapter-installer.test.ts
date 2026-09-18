import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  installWorkflowSupervisorBrowserAdapter,
  inspectWorkflowSupervisorBrowserAdapter,
  workflowSupervisorExtensionIdFromManifestKey,
  type WorkflowSupervisorBrowserInstallation,
} from '../../supervisor/browser-adapter-installer';
import { WORKFLOW_SUPERVISOR_NATIVE_HOST_NAME } from '../../supervisor/native-messaging/host';
import { buildLocalSystemPluginManifest, localSystemPluginAdapter } from '../../src/runtime/plugins/local-system-adapter';

const roots: string[] = [];
const sourceManifestPath = join(process.cwd(), 'supervisor', 'chrome-extension', 'manifest.json');
const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, 'utf8')) as { key: string };
const EXPECTED_EXTENSION_ID = 'glinahpcibpcfcimdcceplmfkgcjehin';

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
  const nativeMessagingRoot = join(root, 'native-hosts');
  mkdirSync(extensionSourcePath, { recursive: true });
  for (const file of ['manifest.json', 'background.js', 'content.js', 'core.js']) {
    const content = file === 'manifest.json' ? readFileSync(sourceManifestPath) : Buffer.from('// fixture\n');
    writeFileSync(join(extensionSourcePath, file), content);
  }
  writeFileSync(nativeHostSourcePath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const browserInstallations: WorkflowSupervisorBrowserInstallation[] = [{ browser: 'chrome', nativeMessagingRoot }];
  const activeRelease = () => ({
    releaseId: 'release-test',
    extensionSourcePath,
    nativeHostSourcePath,
    nativeHostArtifactIdentity: 'sha256:' + sha256(nativeHostSourcePath),
  });
  return { controllerHome, nativeMessagingRoot, browserInstallations, activeRelease };
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
  });
});

describe('Workflow Supervisor browser adapter installer', () => {
  test('derives one stable Chrome extension id from the package-owned public manifest key', () => {
    expect(workflowSupervisorExtensionIdFromManifestKey(sourceManifest.key)).toBe(EXPECTED_EXTENSION_ID);
  });
  test('projects and registers the active release without reading Chrome profile state', () => {
    const f = fixture();
    const before = inspectWorkflowSupervisorBrowserAdapter(f.controllerHome, {
      browserInstallations: f.browserInstallations,
      activeRelease: f.activeRelease,
    });
    expect(before.state).toBe('not_installed');
    const ready = installWorkflowSupervisorBrowserAdapter(f.controllerHome, {
      browserInstallations: f.browserInstallations,
      activeRelease: f.activeRelease,
    });
    expect(ready.state).toBe('ready');
    expect(ready.extensionId).toBe(EXPECTED_EXTENSION_ID);
    expect(ready.projectionCurrent).toBe(true);
    expect(existsSync(join(ready.extensionPath, 'background.js'))).toBe(true);
    expect(existsSync(ready.nativeHostPath)).toBe(true);
    const manifestPath = join(f.nativeMessagingRoot, WORKFLOW_SUPERVISOR_NATIVE_HOST_NAME + '.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(manifest.path).toBe(ready.nativeHostPath);
    expect(manifest.allowed_origins).toEqual(['chrome-extension://' + EXPECTED_EXTENSION_ID + '/']);
    const repeated = installWorkflowSupervisorBrowserAdapter(f.controllerHome, {
      browserInstallations: f.browserInstallations,
      activeRelease: f.activeRelease,
    });
    expect(repeated.state).toBe('ready');
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual(manifest);
  });
  test('registers the exact native host for Chrome, Chrome for Testing, and Chromium by default', () => {
    const f = fixture();
    const homeDir = temp('forge-supervisor-browser-home-');
    const ready = installWorkflowSupervisorBrowserAdapter(f.controllerHome, {
      homeDir,
      activeRelease: f.activeRelease,
    });
    expect(ready.state).toBe('ready');
    const roots = [
      join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'),
      join(homeDir, 'Library', 'Application Support', 'Google', 'ChromeForTesting', 'NativeMessagingHosts'),
      join(homeDir, 'Library', 'Application Support', 'Chromium', 'NativeMessagingHosts'),
    ];
    expect(ready.nativeManifestPaths).toEqual(roots.map((root) => join(root, WORKFLOW_SUPERVISOR_NATIVE_HOST_NAME + '.json')));
    for (const root of roots) {
      const manifest = JSON.parse(readFileSync(join(root, WORKFLOW_SUPERVISOR_NATIVE_HOST_NAME + '.json'), 'utf8')) as Record<string, unknown>;
      expect(manifest.path).toBe(ready.nativeHostPath);
      expect(manifest.allowed_origins).toEqual(['chrome-extension://' + EXPECTED_EXTENSION_ID + '/']);
    }
  });
  test('contains no Chrome Preferences or profile-discovery dependency', () => {
    const source = readFileSync(join(process.cwd(), 'supervisor', 'browser-adapter-installer.ts'), 'utf8');
    expect(source).not.toContain('Preferences');
    expect(source).not.toContain('Secure Preferences');
    expect(source).not.toContain('userDataRoot');
    expect(source).not.toContain('readdirSync');
  });
});
