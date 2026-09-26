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
    const managedDeclaration = JSON.parse(readFileSync(join(ready.extensionPath, 'forge-native-messaging-host.json'), 'utf8')) as Record<string, unknown>;
    expect(managedDeclaration.path).toBe(ready.nativeHostPath);
    expect(managedDeclaration.allowed_origins).toEqual(['chrome-extension://' + EXPECTED_EXTENSION_ID + '/']);
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
  test('registers the exact native host for Chrome, Chrome for Testing, Chromium, and Vivaldi by default', () => {
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
      join(homeDir, 'Library', 'Application Support', 'Vivaldi', 'NativeMessagingHosts'),
    ];
    expect(ready.nativeManifestPaths).toEqual(roots.map((root) => join(root, WORKFLOW_SUPERVISOR_NATIVE_HOST_NAME + '.json')));
    for (const root of roots) {
      const manifest = JSON.parse(readFileSync(join(root, WORKFLOW_SUPERVISOR_NATIVE_HOST_NAME + '.json'), 'utf8')) as Record<string, unknown>;
      expect(manifest.path).toBe(ready.nativeHostPath);
      expect(manifest.allowed_origins).toEqual(['chrome-extension://' + EXPECTED_EXTENSION_ID + '/']);
    }
  });
  test('registers the native host in the exact Forge-managed repo Browser user-data directory', () => {
    const f = fixture();
    const repoRoot = temp('forge-supervisor-managed-browser-repo-');
    const ready = installWorkflowSupervisorBrowserAdapter(f.controllerHome, {
      homeDir: temp('forge-supervisor-browser-home-'),
      repository: { repoId: 'repo_test_managed_browser', repoRoot },
      activeRelease: f.activeRelease,
    });
    const managedRoot = join(
      f.controllerHome,
      'repositories',
      'repo_test_managed_browser',
      'browser',
      'profiles',
      'default',
      'NativeMessagingHosts',
    );
    const manifestPath = join(managedRoot, WORKFLOW_SUPERVISOR_NATIVE_HOST_NAME + '.json');
    expect(ready.nativeManifestPaths).toContain(manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(manifest.path).toBe(ready.nativeHostPath);
    expect(manifest.allowed_origins).toEqual(['chrome-extension://' + EXPECTED_EXTENSION_ID + '/']);
  });
  test('contains no Chrome Preferences or profile-discovery dependency', () => {
    const source = readFileSync(join(process.cwd(), 'supervisor', 'browser-adapter-installer.ts'), 'utf8');
    expect(source).not.toContain('Preferences');
    expect(source).not.toContain('Secure Preferences');
    expect(source).not.toContain('userDataRoot');
    expect(source).not.toContain('readdirSync');
  });
});

describe('workflow supervisor Chrome extension conversation identity', () => {
  function core(): {
    parseConversation(value: string): { conversationId: string; canonicalUrl: string } | null;
    sameIdentity(a: unknown, b: unknown): boolean;
    sameConversation(a: unknown, b: unknown): boolean;
    isCommittedAssistantResponse(text: string): boolean;
  } {
    const source = readFileSync(join(process.cwd(), 'supervisor', 'chrome-extension', 'core.js'), 'utf8');
    const sandbox: Record<string, unknown> = {};
    new Function('globalThis', 'URL', source)(sandbox, URL);
    return sandbox.ForgeWorkflowSupervisorChromeCore as ReturnType<typeof core>;
  }

  test('treats a project-routed and a canonical route to one conversation as the same tab', () => {
    const api = core();
    const projectRoute = api.parseConversation('https://chatgpt.com/g/g-p-abc123/c/6ab2124d-a2e4-83ee-a091-43ad398678fa')!;
    const canonicalRoute = api.parseConversation('https://chatgpt.com/c/6ab2124d-a2e4-83ee-a091-43ad398678fa')!;

    expect(projectRoute.canonicalUrl).toBe('https://chatgpt.com/g/g-p-abc123/c/6ab2124d-a2e4-83ee-a091-43ad398678fa');
    // Reuse follows the durable conversation id, so a redirect that drops the
    // project prefix no longer opens a duplicate tab on every refresh pass.
    expect(api.sameConversation(projectRoute, canonicalRoute)).toBe(true);
    // Page-scoped message handling stays strict about the exact route it serves.
    expect(api.sameIdentity(projectRoute, canonicalRoute)).toBe(false);
  });

  test('accepts compact receipts while retaining all legacy completion read formats', () => {
    const api = core();
    expect(api.isCommittedAssistantResponse('C a1b2c3d')).toBe(true);
    expect(api.isCommittedAssistantResponse('D 0123456')).toBe(true);
    expect(api.isCommittedAssistantResponse('C a1b2c3')).toBe(false);
    expect(api.isCommittedAssistantResponse('status\nC a1b2c3d')).toBe(false);
    expect(api.isCommittedAssistantResponse('status\nFORGE_WORKFLOW_SUPERVISOR_V1_BEGIN\n{}\nFORGE_WORKFLOW_SUPERVISOR_V1_END')).toBe(true);
    expect(api.isCommittedAssistantResponse('status\n[[[FORGE_WORKFLOW_SUPERVISOR_V1]]]\n{}\n[[[END_FORGE_WORKFLOW_SUPERVISOR_V1]]]')).toBe(true);
    expect(api.isCommittedAssistantResponse('status\n<<<FORGE_WORKFLOW_SUPERVISOR_V1>>>\n{}\n<<<END_FORGE_WORKFLOW_SUPERVISOR_V1>>>')).toBe(true);
  });

  test('rejects non-ChatGPT or non-conversation routes instead of opening a tab for them', () => {
    const api = core();
    expect(api.parseConversation('https://example.com/c/abc')).toBeNull();
    expect(api.parseConversation('https://chatgpt.com/g/g-p-abc123')).toBeNull();
    expect(api.parseConversation('https://chatgpt.com/c')).toBeNull();
  });
});

describe('workflow supervisor Chrome extension browser-resource authority', () => {
  interface FakeTab { id: number; url: string; title?: string; discarded?: boolean }

  function loadBackground(fixture: { tabs: FakeTab[]; tasks: Array<{ conversationId: string; conversationUrl: string }> }) {
    const createCalls: unknown[] = [];
    const reloadCalls: number[] = [];
    const rpcMethods: string[] = [];
    const tabMessages: Array<{ tabId: number; type: string }> = [];
    const onUpdated: Array<(tabId: number, changeInfo: { status?: string }, tab: FakeTab) => void> = [];
    const extensionRoot = join(process.cwd(), 'supervisor', 'chrome-extension');
    const chrome = {
      runtime: {
        lastError: undefined as { message: string } | undefined,
        sendNativeMessage(_host: string, message: { method: string }, callback: (response: unknown) => void) {
          rpcMethods.push(message.method);
          callback({ ok: true, result: message.method === 'browser_tasks' ? { tasks: fixture.tasks } : {} });
        },
        onMessage: { addListener: () => undefined },
        onInstalled: { addListener: () => undefined },
        onStartup: { addListener: () => undefined },
      },
      tabs: {
        query: async () => fixture.tabs,
        sendMessage: (tabId: number, message: { type: string }, callback: (response: unknown) => void) => {
          tabMessages.push({ tabId, type: message.type });
          callback({});
        },
        create: async (properties: unknown) => {
          createCalls.push(properties);
          return { id: 9_999, url: (properties as { url?: string }).url };
        },
        reload: async (tabId: number) => { reloadCalls.push(tabId); },
        onUpdated: { addListener: (handler: (tabId: number, changeInfo: { status?: string }, tab: FakeTab) => void) => { onUpdated.push(handler); } },
        onActivated: { addListener: () => undefined },
        onRemoved: { addListener: () => undefined },
      },
      windows: { onFocusChanged: { addListener: () => undefined } },
      alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
    };
    const sandbox: Record<string, unknown> = {};
    const importScripts = (name: string): void => {
      new Function('globalThis', 'URL', readFileSync(join(extensionRoot, name), 'utf8'))(sandbox, URL);
    };
    new Function(
      'chrome', 'importScripts', 'globalThis', 'URL', 'crypto', 'console', 'setTimeout', 'clearTimeout',
      readFileSync(join(extensionRoot, 'background.js'), 'utf8'),
    )(chrome, importScripts, sandbox, URL, globalThis.crypto, console, setTimeout, clearTimeout);
    return { createCalls, reloadCalls, rpcMethods, tabMessages, onUpdated };
  }

  const settle = async (): Promise<void> => {
    for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  test('never opens a conversation tab for a task whose tab is not already open', async () => {
    const conversationId = '6ab216dc-ef5c-83e8-8137-5ef5f1b27e08';
    const conversationUrl = `https://chatgpt.com/g/g-p-6a922010db348191a84d1a5306c083e8-forge/c/${conversationId}`;
    const extension = loadBackground({
      // A different chatgpt.com tab is open; the task's own conversation is not.
      tabs: [{ id: 1, url: 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555', title: 'other' }],
      tasks: [{ conversationId, conversationUrl }],
    });

    await settle();
    for (const handler of extension.onUpdated) handler(1, { status: 'complete' }, { id: 1, url: 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555' });
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    await settle();

    expect(extension.rpcMethods).toContain('browser_tasks');
    expect(extension.rpcMethods).toContain('browser_discovery_update');
    expect(extension.createCalls).toEqual([]);
  });

  test('observes an existing conversation tab and refreshes a discarded one without creating anything', async () => {
    const conversationId = '6ab216dc-ef5c-83e8-8137-5ef5f1b27e08';
    const extension = loadBackground({
      tabs: [{ id: 7, url: `https://chatgpt.com/c/${conversationId}`, title: 'chatgpt', discarded: true }],
      tasks: [{ conversationId, conversationUrl: `https://chatgpt.com/c/${conversationId}` }],
    });

    await settle();

    expect(extension.reloadCalls).toEqual([7]);
    expect(extension.createCalls).toEqual([]);
  });
});
