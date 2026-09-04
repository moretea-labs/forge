import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureCodegraphCacheCompatibilityLink } from '../../src/cli/tools/codegraph';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});
function root(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix)); roots.push(value); return value;
}

describe('CodeGraph Controller Home cache boundary', () => {
  test('migrates repo cache and leaves a compatibility symlink', () => {
    const controllerHome = root('forge-codegraph-home-');
    const repoRoot = root('forge-codegraph-repo-');
    const legacy = join(repoRoot, '.codegraph');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'state.json'), '{"ok":true}\n');
    const target = ensureCodegraphCacheCompatibilityLink(repoRoot, controllerHome);
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(target, 'state.json'), 'utf8')).toContain('"ok":true');
    expect(existsSync(join(repoRoot, '.codegraph', 'state.json'))).toBe(true);
  });
});
