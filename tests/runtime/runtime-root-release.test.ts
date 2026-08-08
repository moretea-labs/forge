import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { assertRuntimeReleaseFiles, stageRuntimeRelease } from '../../src/runtime/root/release-materialize';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sourceFixture() {
  const root = mkdtempSync(join(tmpdir(), 'forge-runtime-release-source-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-runtime-release-controller-'));
  roots.push(root, controllerHome);
  mkdirSync(join(root, 'src/runtime/plugins'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  writeFileSync(join(root, 'src/runtime/plugins/browser-node-bridge-host.ts'), 'console.log("host");\n');
  writeFileSync(join(root, 'bin/forge-desktop-helper.mjs'), '#!/usr/bin/env node\nconsole.log("desktop-helper");\n');
  spawnSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'forge-test@example.invalid'], { cwd: root, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'Forge Test'], { cwd: root, stdio: 'ignore' });
  spawnSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  spawnSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
  return { root, controllerHome };
}

describe('runtime release materialization', () => {
  test('stages and hashes Browser and Desktop helper artifacts beside immutable runtime executables', () => {
    const { root, controllerHome } = sourceFixture();
    const staged = stageRuntimeRelease({ controllerHome, sourceRoot: root }, {
      now: () => 1_700_000_000_000,
      uuid: () => 'release-test',
      compileBinary: ({ outputPath, entryPath }) => {
        writeFileSync(outputPath, entryPath?.endsWith('cli-sidecar.ts') ? 'cli-binary' : 'runtime-binary');
        return { ok: true };
      },
      bundleNodeHost: ({ outputPath, entryPath }) => {
        expect(entryPath.endsWith('src/runtime/plugins/browser-node-bridge-host.ts')).toBe(true);
        writeFileSync(outputPath, 'node-host-bundle');
        return { ok: true };
      },
    });

    const hostPath = join(staged.releasePath, 'browser-node-bridge-host.js');
    expect(existsSync(hostPath)).toBe(true);
    expect(readFileSync(hostPath, 'utf8')).toBe('node-host-bundle');
    expect(staged.browserNodeBridgeArtifactIdentity).toMatch(/^sha256:/);
    const desktopHelperPath = join(staged.releasePath, 'forge-desktop-helper.mjs');
    expect(existsSync(desktopHelperPath)).toBe(true);
    expect(readFileSync(desktopHelperPath, 'utf8')).toContain('desktop-helper');
    expect(staged.desktopHelperArtifactIdentity).toMatch(/^sha256:/);
    const manifest = JSON.parse(readFileSync(staged.manifestPath, 'utf8')) as Record<string, unknown>;
    expect(manifest.browserNodeBridgeEntrypoint).toBe('browser-node-bridge-host.js');
    expect(manifest.browserNodeBridgeArtifactIdentity).toBe(staged.browserNodeBridgeArtifactIdentity);
    expect(manifest.desktopHelperEntrypoint).toBe('forge-desktop-helper.mjs');
    expect(manifest.desktopHelperArtifactIdentity).toBe(staged.desktopHelperArtifactIdentity);
    assertRuntimeReleaseFiles(staged);
  });

  test('release assertion fails closed when the declared Browser Node bridge host is missing', () => {
    const { root, controllerHome } = sourceFixture();
    const staged = stageRuntimeRelease({ controllerHome, sourceRoot: root }, {
      compileBinary: ({ outputPath }) => {
        writeFileSync(outputPath, 'binary');
        return { ok: true };
      },
      bundleNodeHost: ({ outputPath }) => {
        writeFileSync(outputPath, 'node-host-bundle');
        return { ok: true };
      },
    });
    rmSync(join(staged.releasePath, 'browser-node-bridge-host.js'));
    expect(() => assertRuntimeReleaseFiles(staged)).toThrow('RUNTIME_RELEASE_BROWSER_NODE_HOST_MISSING');
  });
});
