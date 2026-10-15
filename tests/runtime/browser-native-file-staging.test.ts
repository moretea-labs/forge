import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  invalidateMacOsBrowserPageHandles,
  reattachMacOsBrowserOwnedPage,
  resetMacOsBrowserRuntimeHooksForTest,
  setMacOsBrowserRuntimeHooksForTest,
} from '../../src/runtime/plugins/browser-macos-bridge';

const roots: string[] = [];
const separator = String.fromCharCode(30);
const url = 'https://example.com/file-attach-test';
const metadata = ['false', url, 'Upload', '0', '0', '1200', '800', '7', '9', 'false', 'false'].join(separator);

afterEach(() => {
  resetMacOsBrowserRuntimeHooksForTest();
  invalidateMacOsBrowserPageHandles();
  while (roots.length) rmSync(roots.pop()!, { force: true, recursive: true });
});

function fixture(): { first: string; second: string; firstSize: number; secondSize: number } {
  const root = mkdtempSync(join(tmpdir(), 'forge-native-file-batch-'));
  roots.push(root);
  const first = join(root, 'one.txt');
  const second = join(root, 'two.pdf');
  writeFileSync(first, 'one!');
  writeFileSync(second, 'twice!');
  return { first, second, firstSize: 4, secondSize: 6 };
}

function mockBrowser(options: { failOnStage?: number; failPreflight?: boolean } = {}) {
  const scripts: string[] = [];
  let stages = 0;
  setMacOsBrowserRuntimeHooksForTest({
    platform: 'darwin',
    appExists: () => true,
    processRunning: async () => true,
    runAppleScript: async (script, args) => {
      if (!script.includes('execute targetTab javascript')) return metadata;
      const code = args[0] ?? '';
      scripts.push(code);
      if (code.includes('__forgeFileInputPreflight')) {
        if (options.failPreflight) throw new Error('Invalid file input selector');
        return JSON.stringify({ ok: true, value: true, page: { url, title: 'Upload' } });
      }
      if (code.includes('__forgeFileInputStaged')) {
        stages += 1;
        if (stages === options.failOnStage) throw new Error('BROWSER_AUTOMATION_TIMEOUT: staging failed');
        const value = stages === 1 ? { name: 'one.txt', size: 4 } : { name: 'two.pdf', size: 6 };
        return JSON.stringify({ ok: true, value, page: { url, title: 'Upload' } });
      }
      if (code.includes('__forgeFileInputCommit')) {
        return JSON.stringify({ ok: true, value: [
          { name: 'one.txt', size: 4 }, { name: 'two.pdf', size: 6 },
        ], page: { url, title: 'Upload' } });
      }
      return JSON.stringify({ ok: true, value: true, page: { url, title: 'Upload' } });
    },
  });
  return { scripts, count: () => stages };
}

describe('macOS native Browser staged upload', () => {
  test('preflights once, stages all files, then commits selection and change event exactly once', async () => {
    const files = fixture();
    const browser = mockBrowser();
    const attached = await reattachMacOsBrowserOwnedPage('chrome', { windowId: '7', tabId: '9' }, 1000);
    await attached.page.setInputFiles('#upload', [files.first, files.second]);
    const scripts = browser.scripts;
    const preflight = scripts.findIndex((code) => code.includes('__forgeFileInputPreflight'));
    const staged = scripts.map((code, i) => code.includes('__forgeFileInputStaged') ? i : -1).filter((i) => i >= 0);
    const committed = scripts.map((code, i) => code.includes('__forgeFileInputCommit') ? i : -1).filter((i) => i >= 0);
    expect(preflight).toBe(0);
    expect(staged).toHaveLength(2);
    expect(committed).toHaveLength(1);
    expect(preflight).toBeLessThan(staged[0]!);
    expect(staged[1]!).toBeLessThan(committed[0]!);
    expect(scripts.filter((code) => code.includes('element.files = '))).toHaveLength(1);
    const commitScript = scripts[committed[0]!]!;
    expect(commitScript).toContain('element.files = transfer.files');
    expect(commitScript.match(/dispatchEvent\(new Event\('change'/g)).toHaveLength(1);
    expect(scripts.at(-1)).toContain('delete globalThis');
  });

  test('preflight failure does not stream bytes or change file input', async () => {
    const files = fixture();
    const browser = mockBrowser({ failPreflight: true });
    const attached = await reattachMacOsBrowserOwnedPage('chrome', { windowId: '7', tabId: '9' }, 1000);
    await expect(attached.page.setInputFiles('#missing', [files.first, files.second])).rejects.toThrow();
    expect(browser.scripts).toHaveLength(1);
    expect(browser.count()).toBe(0);
    expect(browser.scripts[0]).not.toContain('element.files = ');
  });

  test('failed second-file staging preserves prior page selection and does not commit a partial batch', async () => {
    const files = fixture();
    const browser = mockBrowser({ failOnStage: 2 });
    const attached = await reattachMacOsBrowserOwnedPage('chrome', { windowId: '7', tabId: '9' }, 1000);
    await expect(attached.page.setInputFiles('#upload', [files.first, files.second])).rejects.toThrow();
    expect(browser.count()).toBe(2);
    expect(browser.scripts.some((code) => code.includes('__forgeFileInputCommit'))).toBe(false);
    expect(browser.scripts.every((code) => !code.includes('element.files = '))).toBe(true);
    expect(browser.scripts.at(-1)).toContain('delete globalThis');
  });

  test('oversized native transfer fails before browser interaction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-native-file-limit-'));
    roots.push(root);
    const file = join(root, 'too-large.txt');
    writeFileSync(file, Buffer.alloc(16 * 1024 * 1024 + 1));
    const browser = mockBrowser();
    const attached = await reattachMacOsBrowserOwnedPage('chrome', { windowId: '7', tabId: '9' }, 1000);
    await expect(attached.page.setInputFiles('#upload', file)).rejects.toThrow('PLUGIN_BROWSER_NATIVE_FILE_TOO_LARGE');
    expect(browser.scripts).toHaveLength(0);
  });
});
