import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureBrowserStateInControllerHome } from '../../src/runtime/plugins/browser-session-store';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function root(prefix: string): string { const value = mkdtempSync(join(tmpdir(), prefix)); roots.push(value); return value; }

describe('browser state Controller Home boundary', () => {
  test('migrates provider files and removes the repository-local compatibility path', () => {
    const controllerHome = root('forge-browser-home-');
    const repoRoot = root('forge-browser-repo-');
    const legacy = join(repoRoot, '.forge', 'browser', 'screenshots');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'shot.txt'), 'evidence\n');

    const target = ensureBrowserStateInControllerHome(controllerHome, 'repo-a', repoRoot);

    expect(readFileSync(join(target, 'screenshots', 'shot.txt'), 'utf8')).toBe('evidence\n');
    expect(existsSync(join(repoRoot, '.forge', 'browser'))).toBe(false);
  });

  test('retires an exact legacy compatibility symlink without traversing a foreign target', () => {
    const controllerHome = root('forge-browser-link-home-');
    const repoRoot = root('forge-browser-link-repo-');
    const target = join(controllerHome, 'repositories', 'repo-a', 'browser');
    mkdirSync(target, { recursive: true });
    mkdirSync(join(repoRoot, '.forge'), { recursive: true });
    const legacyLink = join(repoRoot, '.forge', 'browser');
    symlinkSync(target, legacyLink, process.platform === 'win32' ? 'junction' : 'dir');

    expect(ensureBrowserStateInControllerHome(controllerHome, 'repo-a', repoRoot)).toBe(target);
    expect(existsSync(legacyLink)).toBe(false);
  });
});
