import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  COMPUTER_CHATGPT_NATIVE_HOST_NAME,
  computerChatgptExtensionIdFromManifestKey,
  inspectComputerChatgptExtensionProjection,
  projectComputerChatgptExtension,
} from '../../src/runtime/root/computer-chatgpt-extension-projection';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const MANIFEST_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxFzo1eixjsWsZbN1pBuyzdKinJSAAuzTRavD0xFQFwrTIEQ7hxxueEBEhifpGq9nplNnmxmZvIL7PJycEAYT8mrbyXBLCPR1jQBuL4YR775phnlNVpF3dHX5OWDHLWRnHRgOO1FibQ54fM2rKylr66+x+J6/4C7a9dpiSMuxf3fOStXA6wJb0d7A4E22Q1+GGfWgs0NCyVI5k4aczK+J5Ao61ZXKBr8Qw/FCmwhCcDgQdIpURgoMHkyvQH3ryYWocucjRhMVsU8H65adIIKFHkEhPJCiVY64L6bu6kNR2fpf0yJ1GvI5ota6Hf4NAEi7Yt7PL7i3ISyv3pPQWW1nIwIDAQAB';

function writeReleaseSources(root: string) {
  const extensionSource = join(root, 'extension-source');
  const nativeHostSource = join(root, 'chatgpt-native-host.mjs');
  mkdirSync(extensionSource, { recursive: true });
  writeFileSync(join(extensionSource, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Forge Computer ChatGPT Provider',
    version: '0.4.11',
    key: MANIFEST_KEY,
  }, null, 2));
  writeFileSync(join(extensionSource, 'background.js'), "const ALARM_PERIOD_MINUTES = 0.05;\nconst NATIVE_HOST = 'com.moretea.forge.computer';\n");
  writeFileSync(join(extensionSource, 'content.js'), 'export {};\n');
  writeFileSync(join(extensionSource, 'core.js'), 'globalThis.ForgeComputerChatgptCore = {};\n');
  writeFileSync(nativeHostSource, '#!/usr/bin/env node\nconsole.log("host");\n', { mode: 0o700 });
  return { extensionSource, nativeHostSource };
}

describe('Computer ChatGPT extension projection', () => {
  test('projects release files, replaces stale extension contents, and registers the computer native host', () => {
    const root = tempRoot('forge-computer-chatgpt-projection-');
    const controllerHome = join(root, 'controller');
    const homeDir = join(root, 'home');
    const chromeHosts = join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
    const { extensionSource, nativeHostSource } = writeReleaseSources(root);
    const extensionId = computerChatgptExtensionIdFromManifestKey(MANIFEST_KEY);

    const projected = projectComputerChatgptExtension(controllerHome, {
      homeDir,
      browserInstallations: [{ browser: 'chrome', nativeMessagingRoot: chromeHosts }],
      activeRelease: () => ({
        releaseId: 'release-test',
        extensionSourcePath: extensionSource,
        nativeHostSourcePath: nativeHostSource,
      }),
    });

    expect(projected).toMatchObject({
      state: 'ready',
      projectionCurrent: true,
      activeReleaseId: 'release-test',
      extensionId,
    });
    expect(readFileSync(join(projected.extensionPath, 'background.js'), 'utf8')).toContain('ALARM_PERIOD_MINUTES = 0.05');
    expect(readFileSync(join(projected.extensionPath, 'forge-native-messaging-host.json'), 'utf8')).toContain(COMPUTER_CHATGPT_NATIVE_HOST_NAME);
    expect(existsSync(projected.nativeHostPath)).toBe(true);

    const hostManifest = JSON.parse(readFileSync(join(chromeHosts, `${COMPUTER_CHATGPT_NATIVE_HOST_NAME}.json`), 'utf8')) as Record<string, unknown>;
    expect(hostManifest).toMatchObject({
      name: COMPUTER_CHATGPT_NATIVE_HOST_NAME,
      path: projected.nativeHostPath,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`],
    });

    writeFileSync(join(extensionSource, 'background.js'), "const ALARM_PERIOD_MINUTES = 0.05;\nconst NATIVE_HOST = 'com.moretea.forge.computer';\n// refreshed\n");
    const before = inspectComputerChatgptExtensionProjection(controllerHome, {
      homeDir,
      browserInstallations: [{ browser: 'chrome', nativeMessagingRoot: chromeHosts }],
      activeRelease: () => ({
        releaseId: 'release-test',
        extensionSourcePath: extensionSource,
        nativeHostSourcePath: nativeHostSource,
      }),
    });
    expect(before.state).toBe('projection_stale');
    expect(before.projectionCurrent).toBe(false);

    const refreshed = projectComputerChatgptExtension(controllerHome, {
      homeDir,
      browserInstallations: [{ browser: 'chrome', nativeMessagingRoot: chromeHosts }],
      activeRelease: () => ({
        releaseId: 'release-test',
        extensionSourcePath: extensionSource,
        nativeHostSourcePath: nativeHostSource,
      }),
    });
    expect(refreshed.projectionCurrent).toBe(true);
    expect(readFileSync(join(refreshed.extensionPath, 'background.js'), 'utf8')).toContain('// refreshed');
  });

  test('reports runtime_release_incomplete without inventing a projection when authority is absent', () => {
    const root = tempRoot('forge-computer-chatgpt-projection-missing-');
    const status = inspectComputerChatgptExtensionProjection(join(root, 'controller'));
    expect(status.state).toBe('runtime_release_incomplete');
    expect(status.projectionCurrent).toBe(false);
  });
});
