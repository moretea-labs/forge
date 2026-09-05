import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildBrowserPluginManifest } from '../../src/runtime/plugins/browser-adapter';

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-browser-user-authority-'));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function browserDetails(root: string): Record<string, unknown> {
  const manifest = buildBrowserPluginManifest(1, '2026-08-30T00:00:00.000Z', root, {
    controllerHome: join(root, 'controller-home'),
    repoId: 'repo-browser-user-authority',
    repoRoot: root,
    controllerScoped: false,
  });
  return (manifest.health.details ?? {}) as Record<string, unknown>;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('browser user-profile authority', () => {
  test('defaults to the existing user Chrome and disables silent managed fallback', () => {
    const details = browserDetails(fixture());
    expect(details.browserMode).toBe('attach_preferred');
    expect(details.profileMode).toBe('repo_local');
    expect(details.browserChannel).toBe('chrome');
    expect(details.cdpAttachFallback).toBe('fail_closed');
    expect(details.nativeAttachMode).toBe('auto');
    expect(details.nativeBrowserCandidates).toEqual(['chrome']);
    expect(details.provider).not.toBe('playwright-persistent-context');
  });

  test('does not let a legacy ChatGPT managed-profile binding become general browser authority', () => {
    const root = fixture();
    writeJson(join(root, '.forge', 'chatgpt-browser.local.json'), {
      version: 1,
      product: 'chatgpt',
      profileDir: '/tmp/legacy-chatgpt-profile',
      profileDirectory: 'Profile 7',
      browserChannel: 'chromium',
      chatgptUrl: 'https://chatgpt.com/',
      updatedAt: '2026-08-30T00:00:00.000Z',
    });
    const details = browserDetails(root);
    expect(details.profileMode).toBe('repo_local');
    expect(details.profileDir).toBeUndefined();
    expect(details.browserChannel).toBe('chrome');
    expect(details.nativeBrowserCandidates).toEqual(['chrome']);
  });

  test('migrates repository-local v1 managed or Vivaldi routing to Chrome attach fail-closed defaults', () => {
    const root = fixture();
    writeJson(join(root, '.forge', 'plugins', 'browser.json'), {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      browserMode: 'managed_persistent',
      profileMode: 'custom',
      profileDir: '.forge/browser/profiles/legacy',
      browserChannel: 'chromium',
      cdpAttachFallback: 'managed_persistent',
      nativeAttachMode: 'auto',
      nativeBrowserCandidates: ['vivaldi'],
    });
    const details = browserDetails(root);
    expect(details.browserMode).toBe('attach_preferred');
    expect(details.profileMode).toBe('repo_local');
    expect(details.profileDir).toBeUndefined();
    expect(details.browserChannel).toBe('chrome');
    expect(details.cdpAttachFallback).toBe('fail_closed');
    expect(details.nativeBrowserCandidates).toEqual(['chrome']);
  });

  test('preserves an explicit current-schema managed override instead of banning intentional isolation', () => {
    const root = fixture();
    writeJson(join(root, '.forge', 'plugins', 'browser.json'), {
      schemaVersion: 2,
      enabled: true,
      provider: 'playwright',
      browserMode: 'managed_persistent',
      profileMode: 'repo_local',
      browserChannel: 'chrome',
      cdpAttachFallback: 'managed_persistent',
      nativeAttachMode: 'auto',
      nativeBrowserCandidates: ['vivaldi'],
    });
    const details = browserDetails(root);
    expect(details.browserMode).toBe('managed_persistent');
    expect(details.cdpAttachFallback).toBe('managed_persistent');
    expect(details.nativeBrowserCandidates).toEqual(['vivaldi']);
    expect(details.provider).toBe('playwright-persistent-context');
  });
});
