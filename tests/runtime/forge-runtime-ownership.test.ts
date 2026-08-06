import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { forgeRuntimeOwnsPidFile } from '../../src/runtime/control-plane/runtime-pid-ownership';
import { readForgeRuntimeStatus } from '../../src/runtime/control-plane/runtime-status-client';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('Forge Runtime ownership', () => {
  test('status observation does not create Controller Home or start a Runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-runtime-status-readonly-'));
    roots.push(root);
    const controllerHome = join(root, 'missing-controller-home');
    expect(existsSync(controllerHome)).toBe(false);
    expect(readForgeRuntimeStatus(controllerHome)).toMatchObject({ status: 'unavailable' });
    expect(existsSync(controllerHome)).toBe(false);
  });
  test('only the recorded pid owns terminal state writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-runtime-owner-'));
    roots.push(root);
    const pidPath = join(root, 'runtime.pid');
    writeFileSync(pidPath, '200\n', 'utf8');
    expect(forgeRuntimeOwnsPidFile(pidPath, 200)).toBe(true);
    expect(forgeRuntimeOwnsPidFile(pidPath, 100)).toBe(false);
    writeFileSync(pidPath, '300\n', 'utf8');
    expect(forgeRuntimeOwnsPidFile(pidPath, 200)).toBe(false);
    expect(forgeRuntimeOwnsPidFile(pidPath, 300)).toBe(true);
  });
  test('treats missing or malformed pid files as unowned', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-runtime-owner-'));
    roots.push(root);
    const pidPath = join(root, 'runtime.pid');
    expect(forgeRuntimeOwnsPidFile(pidPath, 100)).toBe(false);
    writeFileSync(pidPath, 'not-a-pid\n', 'utf8');
    expect(forgeRuntimeOwnsPidFile(pidPath, 100)).toBe(false);
  });
});
