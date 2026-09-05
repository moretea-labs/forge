import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  cleanupStaleCodegraphLocators,
  codegraphRepositoryCacheRoot,
  createCodegraphCacheLocator,
  migrateLegacyCodegraphCache,
} from '../../src/runtime/context/codegraph-cache-boundary';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});
function root(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix)); roots.push(value); return value;
}

describe('CodeGraph Controller Home cache boundary', () => {
  test('migrates a legacy repo cache without leaving a permanent source-tree compatibility link', () => {
    const controllerHome = root('forge-codegraph-home-');
    const repoRoot = root('forge-codegraph-repo-');
    const legacy = join(repoRoot, '.codegraph');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'state.json'), '{"ok":true}\n');

    const target = migrateLegacyCodegraphCache(repoRoot, controllerHome);

    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(target, 'state.json'), 'utf8')).toContain('"ok":true');
    expect(target).toBe(codegraphRepositoryCacheRoot(controllerHome, repoRoot));
  });

  test('uses a process-scoped locator and removes it on release', () => {
    const controllerHome = root('forge-codegraph-locator-home-');
    const repoRoot = root('forge-codegraph-locator-repo-');
    const target = codegraphRepositoryCacheRoot(controllerHome, repoRoot);
    mkdirSync(target, { recursive: true });

    const locator = createCodegraphCacheLocator(repoRoot, controllerHome, { createTarget: false });
    expect(locator).not.toBeNull();
    expect(locator!.name).toMatch(/^\.codegraph-forge-\d+-[a-f0-9]+$/);
    expect(lstatSync(locator!.path).isSymbolicLink()).toBe(true);
    expect(existsSync(join(repoRoot, '.codegraph'))).toBe(false);

    locator!.release();
    expect(existsSync(locator!.path)).toBe(false);
    expect(readdirSync(repoRoot).filter((name) => name.startsWith('.codegraph-forge-'))).toEqual([]);
  });

  test('reclaims only dead-process locators that point at the exact Forge cache', () => {
    const controllerHome = root('forge-codegraph-stale-home-');
    const repoRoot = root('forge-codegraph-stale-repo-');
    const target = codegraphRepositoryCacheRoot(controllerHome, repoRoot);
    mkdirSync(target, { recursive: true });
    const stale = join(repoRoot, '.codegraph-forge-99999999-deadbeef');
    symlinkSync(target, stale, process.platform === 'win32' ? 'junction' : 'dir');
    const external = root('forge-codegraph-external-');
    const unowned = join(repoRoot, '.codegraph-forge-99999999-unowned');
    symlinkSync(external, unowned, process.platform === 'win32' ? 'junction' : 'dir');

    const report = cleanupStaleCodegraphLocators(repoRoot, controllerHome);

    expect(existsSync(stale)).toBe(false);
    expect(lstatSync(unowned).isSymbolicLink()).toBe(true);
    expect(existsSync(external)).toBe(true);
    expect(report.removed).toEqual(['.codegraph-forge-99999999-deadbeef']);
    expect(report.skippedByReason.locator_target_unproven).toBe(1);
  });

  test('honors a zero locator removal budget and leaves a dead exact locator for a later maintenance cycle', () => {
    const controllerHome = root('forge-codegraph-locator-budget-home-');
    const repoRoot = root('forge-codegraph-locator-budget-repo-');
    const target = codegraphRepositoryCacheRoot(controllerHome, repoRoot);
    mkdirSync(target, { recursive: true });
    const stale = join(repoRoot, '.codegraph-forge-99999999-deadbeef');
    symlinkSync(target, stale, process.platform === 'win32' ? 'junction' : 'dir');

    const report = cleanupStaleCodegraphLocators(repoRoot, controllerHome, 10, 0);

    expect(lstatSync(stale).isSymbolicLink()).toBe(true);
    expect(report.eligible).toBe(1);
    expect(report.attempted).toBe(0);
    expect(report.removed).toEqual([]);
    expect(report.budgetExhausted).toBe(true);
    expect(report.skippedByReason.cleanup_budget_exhausted).toBe(1);
  });

  test('retires the old permanent Forge compatibility symlink during explicit migration', () => {
    const controllerHome = root('forge-codegraph-legacy-link-home-');
    const repoRoot = root('forge-codegraph-legacy-link-repo-');
    const target = codegraphRepositoryCacheRoot(controllerHome, repoRoot);
    mkdirSync(target, { recursive: true });
    const legacy = join(repoRoot, '.codegraph');
    symlinkSync(target, legacy, process.platform === 'win32' ? 'junction' : 'dir');

    expect(migrateLegacyCodegraphCache(repoRoot, controllerHome)).toBe(target);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(target)).toBe(true);
  });
});
