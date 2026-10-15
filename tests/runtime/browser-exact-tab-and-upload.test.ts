import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  chooseTab,
  resolveBrowserAttachmentPaths,
  selectExactNativeTab,
} from '../../src/runtime/plugins/browser-adapter';
import { authorizeWorkspaceTargetGrant } from '../../src/runtime/workspace-targets';
import { browserActions } from '../../src/runtime/plugins/browser-manifest-surface';
import type { AssistantPluginActionExecutionInput } from '../../src/runtime/plugins/types';

const roots: string[] = [];
function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Computer Browser exact tab selection', () => {
  const url = 'https://example.com/work';
  const nativeTab = (windowId: string, tabId: string, active: boolean) => ({
    windowId, tabId, active, url, title: 'Work',
  });
  const inventory = (tabs: ReturnType<typeof nativeTab>[], truncated = false) => ({
    product: 'chrome' as const, tabs, truncated,
  });

  test('does not pick the frontmost of two otherwise identical native tabs', () => {
    const tabs = inventory([nativeTab('1', '11', false), nativeTab('2', '22', true)]);
    expect(selectExactNativeTab(url, tabs)).toEqual({ match: 'ambiguous', candidateCount: 2 });
  });

  test('never treats truncated inventory as proof of uniqueness', () => {
    const tabs = inventory([nativeTab('1', '11', true)], true);
    expect(selectExactNativeTab(url, tabs).match).toBe('ambiguous');
  });

  test('unique complete native inventory still reuses its exact tab', () => {
    const tab = nativeTab('1', '11', false);
    expect(selectExactNativeTab(url, inventory([tab]))).toMatchObject({ match: 'exact_url', candidate: tab });
  });

  test('CDP and isolated contexts refuse a first-match URL or blank tab guess', () => {
    const pages = [
      { index: 0, key: 'a', url, title: 'Work' },
      { index: 1, key: 'b', url, title: 'Work' },
    ];
    expect(() => chooseTab(pages, { sessionId: 'test', url })).toThrow('PLUGIN_BROWSER_REUSABLE_TAB_AMBIGUOUS');
    expect(() => chooseTab(pages.map((page) => ({ ...page, url: 'about:blank' })),
      { sessionId: 'test', url })).toThrow('PLUGIN_BROWSER_REUSABLE_TAB_AMBIGUOUS');
    const titled = pages.map((page, i) => ({ ...page, title: i === 0 ? 'Saved' : 'Other' }));
    const saved = {
      sessionId: 'test', url,
      existingSession: { browser: { tab: { url, title: 'Saved', ownership: 'user_owned' } } },
    } as Parameters<typeof chooseTab>[1];
    expect(() => chooseTab(titled, saved)).toThrow('PLUGIN_BROWSER_REUSABLE_TAB_AMBIGUOUS');
    expect(chooseTab([pages[0]!], { sessionId: 'test', url }).entry?.index).toBe(0);
  });
});

describe('Browser file attachments use canonical local-system authorization', () => {
  test('public file-upload action declares the optional authorized directory key', () => {
    const action = browserActions().find((entry) => entry.actionId === 'attach_local_file');
    const schema = action?.argumentsSchema as { properties?: Record<string, unknown> } | undefined;
    expect(schema?.properties?.target_key).toEqual({ type: 'string' });
  });

  function request(repoRoot: string, controllerHome: string): AssistantPluginActionExecutionInput {
    return {
      controllerHome, repoRoot, repoId: 'test-browser-files',
      pluginId: 'computer', actionId: 'attach_local_file', requestId: 'upload-test',
      args: {}, origin: { surface: 'mcp', actor: 'test-browser-files' },
    };
  }

  test('defaults to repository-only and allows external files only with an owned read grant', () => {
    const repo = temp('forge-browser-repo-');
    const downloads = temp('forge-browser-downloads-');
    const controller = temp('forge-browser-controller-');
    const inside = join(repo, 'inside.txt');
    const external = join(downloads, 'outside.pdf');
    writeFileSync(inside, 'inside');
    writeFileSync(external, 'outside');
    const input = request(repo, controller);
    expect(resolveBrowserAttachmentPaths(input, ['inside.txt'])).toEqual([realpathSync(inside)]);
    expect(() => resolveBrowserAttachmentPaths(input, [external])).toThrow('PLUGIN_POLICY_BLOCKED');
    expect(() => resolveBrowserAttachmentPaths(input, ['outside.pdf'], 'downloads')).toThrow('PLUGIN_POLICY_BLOCKED');
    authorizeWorkspaceTargetGrant(controller, {
      targetKey: 'downloads', rootPath: downloads, ownerScope: 'mcp:test-browser-files',
      access: 'read_only', reason: 'Explicit file upload test',
    });
    expect(resolveBrowserAttachmentPaths(input, ['outside.pdf'], 'downloads')).toEqual([realpathSync(external)]);
    expect(() => resolveBrowserAttachmentPaths(input, [external], 'downloads')).toThrow('PLUGIN_POLICY_BLOCKED');
  });

  test('does not allow traversal, symlink escapes, executables or other callers grants', () => {
    const repo = temp('forge-browser-repo-');
    const downloads = temp('forge-browser-downloads-');
    const outside = temp('forge-browser-other-');
    const controller = temp('forge-browser-controller-');
    const external = join(outside, 'secret.txt');
    writeFileSync(external, 'sensitive');
    writeFileSync(join(downloads, 'setup.sh'), '#!/bin/sh');
    symlinkSync(external, join(downloads, 'escape.txt'));
    symlinkSync(external, join(repo, 'escape.txt'));
    mkdirSync(join(downloads, 'nested'));
    const input = request(repo, controller);
    authorizeWorkspaceTargetGrant(controller, {
      targetKey: 'downloads', rootPath: downloads, ownerScope: 'mcp:test-browser-files',
      access: 'read_only', reason: 'Explicit file upload test',
    });
    expect(() => resolveBrowserAttachmentPaths(input, ['../other/secret.txt'], 'downloads')).toThrow('PLUGIN_POLICY_BLOCKED');
    expect(() => resolveBrowserAttachmentPaths(input, ['escape.txt'], 'downloads')).toThrow('PLUGIN_POLICY_BLOCKED');
    expect(() => resolveBrowserAttachmentPaths(input, ['escape.txt'])).toThrow('PLUGIN_POLICY_BLOCKED');
    expect(() => resolveBrowserAttachmentPaths(input, ['setup.sh'], 'downloads')).toThrow('PLUGIN_POLICY_BLOCKED');
    expect(() => resolveBrowserAttachmentPaths(input, ['nested'], 'downloads')).toThrow('PLUGIN_POLICY_BLOCKED');
    const other: AssistantPluginActionExecutionInput = { ...input, origin: { surface: 'mcp', actor: 'another-caller' } };
    expect(() => resolveBrowserAttachmentPaths(other, ['setup.sh'], 'downloads')).toThrow('PLUGIN_POLICY_BLOCKED');
  });
});
