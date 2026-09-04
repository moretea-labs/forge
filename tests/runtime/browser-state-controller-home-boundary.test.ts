import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureBrowserStateCompatibilityLink } from '../../src/runtime/plugins/browser-session-store';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function root(prefix: string): string { const value = mkdtempSync(join(tmpdir(), prefix)); roots.push(value); return value; }

describe('browser state Controller Home boundary', () => {
  test('migrates provider files and leaves only a compatibility symlink', () => {
    const controllerHome = root('forge-browser-home-');
    const repoRoot = root('forge-browser-repo-');
    const legacy = join(repoRoot, '.forge', 'browser', 'screenshots');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'shot.txt'), 'evidence\n');
    const target = ensureBrowserStateCompatibilityLink(controllerHome, 'repo-a', repoRoot);
    expect(lstatSync(join(repoRoot, '.forge', 'browser')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(target, 'screenshots', 'shot.txt'), 'utf8')).toBe('evidence\n');
    expect(existsSync(join(repoRoot, '.forge', 'browser', 'screenshots', 'shot.txt'))).toBe(true);
  });
});
