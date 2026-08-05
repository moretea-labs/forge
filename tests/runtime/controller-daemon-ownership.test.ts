import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { controllerDaemonOwnsPidFile } from '../../src/runtime/control-plane/daemon-ownership';
import { readControllerDaemonStatus } from '../../src/runtime/control-plane/daemon-client';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('controller daemon ownership', () => {
  test('status observation does not create Controller Home or start a daemon', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-daemon-status-readonly-'));
    roots.push(root);
    const controllerHome = join(root, 'missing-controller-home');

    expect(existsSync(controllerHome)).toBe(false);
    expect(readControllerDaemonStatus(controllerHome)).toMatchObject({ status: 'unavailable' });
    expect(existsSync(controllerHome)).toBe(false);
  });

  test('only the pid recorded in the shared pid file owns terminal state writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-daemon-owner-'));
    roots.push(root);
    const pidPath = join(root, 'controller.pid');

    writeFileSync(pidPath, '200\n', 'utf8');
    expect(controllerDaemonOwnsPidFile(pidPath, 200)).toBe(true);
    expect(controllerDaemonOwnsPidFile(pidPath, 100)).toBe(false);

    writeFileSync(pidPath, '300\n', 'utf8');
    expect(controllerDaemonOwnsPidFile(pidPath, 200)).toBe(false);
    expect(controllerDaemonOwnsPidFile(pidPath, 300)).toBe(true);
  });

  test('treats missing or malformed pid files as unowned', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-daemon-owner-'));
    roots.push(root);
    const pidPath = join(root, 'controller.pid');

    expect(controllerDaemonOwnsPidFile(pidPath, 100)).toBe(false);
    writeFileSync(pidPath, 'not-a-pid\n', 'utf8');
    expect(controllerDaemonOwnsPidFile(pidPath, 100)).toBe(false);
  });
});
