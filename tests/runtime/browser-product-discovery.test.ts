import { describe, expect, test } from 'bun:test';
import { describeNativeBrowserProduct, discoverNativeBrowserProduct } from '../../src/runtime/platform/browser-product-discovery';

describe('native browser product discovery portability', () => {
  test('prefers explicit registration over PATH and bounded OS fallback', () => {
    const found = discoverNativeBrowserProduct({
      channel: 'chrome',
      platform: 'darwin',
      env: { HOME: '/Users/test', PATH: '/opt/bin', FORGE_BROWSER_EXECUTABLE: '/custom/chrome' },
      fileExists: (path) => ['/custom/chrome', '/opt/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].includes(path),
    });
    expect(found).toMatchObject({ executable: '/custom/chrome', source: 'explicit' });
  });

  test('uses PATH before static installation candidates', () => {
    const found = discoverNativeBrowserProduct({
      channel: 'chrome',
      platform: 'darwin',
      env: { HOME: '/Users/test', PATH: '/opt/bin' },
      fileExists: (path) => ['/opt/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].includes(path),
    });
    expect(found).toMatchObject({ executable: '/opt/bin/google-chrome', source: 'path' });
  });

  test('keeps known installation paths as bounded adapter fallback only', () => {
    const fallback = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const found = discoverNativeBrowserProduct({
      channel: 'chrome',
      platform: 'darwin',
      env: { HOME: '/Users/test', PATH: '' },
      fileExists: (path) => path === fallback,
    });
    expect(found).toMatchObject({ executable: fallback, source: 'fallback' });
    expect(describeNativeBrowserProduct({ channel: 'chrome', platform: 'darwin', env: { HOME: '/Users/test' } })?.defaultUserDataDir)
      .toBe('/Users/test/Library/Application Support/Google/Chrome');
  });

  test('derives Windows defaults from host environment instead of a fixed user path', () => {
    const executable = 'D:\\Apps\\Google\\Chrome\\Application\\chrome.exe';
    const found = discoverNativeBrowserProduct({
      channel: 'chrome',
      platform: 'win32',
      env: { ProgramFiles: 'D:\\Apps', LOCALAPPDATA: 'E:\\Profiles\\Alice\\Local', PATH: '' },
      fileExists: (path) => path === executable,
    });
    expect(found?.source).toBe('fallback');
    expect(found?.defaultUserDataDir).toBe('E:\\Profiles\\Alice\\Local\\Google\\Chrome\\User Data');
  });
});
