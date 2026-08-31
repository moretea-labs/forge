import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { materializePackageRuntimeRelease } from '../../src/runtime/root/package-runtime-release';
import { assertStorageHeadroom, readStorageCapacity } from '../../src/runtime/shared/storage-capacity';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(): { home: string; packageRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'forge-package-runtime-release-'));
  roots.push(root);
  const home = join(root, 'home');
  const packageRoot = join(root, 'package-source');
  for (const dir of ['src/runtime/root', 'src/runtime/shared', 'bin', 'assets', 'scripts']) {
    mkdirSync(join(packageRoot, dir), { recursive: true });
  }
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@moretea-labs/forge', version: '9.9.9-test' }));
  writeFileSync(join(packageRoot, 'src', 'runtime.ts'), 'export const runtime = 1;\n');
  writeFileSync(join(packageRoot, 'src', 'runtime', 'root', 'entry.ts'), 'process.exit(0);\n');
  writeFileSync(join(packageRoot, 'src', 'runtime', 'shared', 'node-ts-loader.mjs'), 'export async function load(url, context, nextLoad) { return nextLoad(url, context); }\n');
  writeFileSync(join(packageRoot, 'bin', 'forge-runtime.mjs'), 'process.exit(99);\n');
  mkdirSync(join(packageRoot, 'node_modules', 'runtime-dependency'), { recursive: true });
  writeFileSync(join(packageRoot, 'node_modules', 'runtime-dependency', 'index.js'), 'export const dependency = 1;\n');
  writeFileSync(join(packageRoot, 'node_modules', 'runtime-dependency', 'linked.js'), 'export const linked = 1;\n');
  symlinkSync(join(packageRoot, 'node_modules', 'runtime-dependency', 'linked.js'), join(packageRoot, 'node_modules', 'runtime-dependency', 'linked-copy.js'));
  return { home, packageRoot };
}

describe('package Runtime release immutability', () => {
  test('launches from an internal package snapshot after the source tree changes or disappears', () => {
    const { home, packageRoot } = fixture();
    const release = materializePackageRuntimeRelease({ controllerHome: home, packageRoot, operationId: 'snapshot-source' });

    expect(release.packageRoot).toBe(join(release.releaseRoot, 'package'));
    expect(readFileSync(join(release.packageRoot, 'src', 'runtime.ts'), 'utf8')).toBe('export const runtime = 1;\n');
    expect(readFileSync(join(release.packageRoot, 'node_modules', 'runtime-dependency', 'index.js'), 'utf8')).toBe('export const dependency = 1;\n');
    expect(readFileSync(join(release.packageRoot, 'node_modules', 'runtime-dependency', 'linked-copy.js'), 'utf8')).toBe('export const linked = 1;\n');

    writeFileSync(join(packageRoot, 'src', 'runtime.ts'), 'export const runtime = 2;\n');
    rmSync(packageRoot, { recursive: true, force: true });
    expect(existsSync(packageRoot)).toBe(false);

    const launched = spawnSync(release.entrypointPath, [], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
    expect(launched.status).toBe(0);
  });

  test('fails closed when bytes inside an existing immutable package snapshot change', () => {
    const { home, packageRoot } = fixture();
    const release = materializePackageRuntimeRelease({ controllerHome: home, packageRoot, operationId: 'snapshot-first' });
    const snapshotFile = join(release.packageRoot, 'src', 'runtime.ts');
    writeFileSync(snapshotFile, 'export const runtime = 999;\n');

    expect(() => materializePackageRuntimeRelease({ controllerHome: home, packageRoot, operationId: 'snapshot-repeat' }))
      .toThrow('PACKAGE_RUNTIME_RELEASE_IMMUTABILITY_VIOLATION');
    expect(readFileSync(snapshotFile, 'utf8')).toBe('export const runtime = 999;\n');
  });
  test('fails before a storage mutation when required bytes exceed proven filesystem headroom', () => {
    const { home } = fixture();
    const capacity = readStorageCapacity(home);
    expect(capacity.availableBytes).toBeNumber();
    expect(() => assertStorageHeadroom(home, {
      operation: 'test_impossible_write',
      requiredBytes: (capacity.availableBytes ?? 0) + 1,
      reserveBytes: 0,
    })).toThrow('FORGE_STORAGE_HEADROOM_LOW');
  });

});
