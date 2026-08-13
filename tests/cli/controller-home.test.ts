import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  ensureControllerHomeStorage,
  migrateStoppedRepoLocalControllerHomeStorage,
  repoLocalControllerHomeStorageNeedsMigration,
  repoLocalNoIndexControllerHome,
  resolveRepoPreferredControllerHome,
  rollbackStoppedRepoLocalControllerHomeStorage,
} from '../../src/cli/repositories/controller-home';
import { resolveRuntimeStateControllerHome } from '../../src/cli/commands/runtime';

const roots: string[] = [];
const originalControllerHome = process.env.FORGE_CONTROLLER_HOME;

afterEach(() => {
  if (originalControllerHome === undefined) delete process.env.FORGE_CONTROLLER_HOME;
  else process.env.FORGE_CONTROLLER_HOME = originalControllerHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repo-preferred controller home', () => {
  test('uses repo _ops/controller-home when present and no explicit override exists', () => {
    delete process.env.FORGE_CONTROLLER_HOME;
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-controller-home-'));
    roots.push(repoRoot);
    const controllerHome = join(repoRoot, '_ops', 'controller-home');
    mkdirSync(join(controllerHome, 'mcp'), { recursive: true });
    writeFileSync(join(controllerHome, 'mcp', 'mcp.local.json'), '{}\n');

    expect(resolveRepoPreferredControllerHome(repoRoot)).toBe(resolve(controllerHome));
  });

  test('maps only macOS repo-local controller homes to .noindex physical storage', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-controller-home-'));
    roots.push(repoRoot);
    const logical = join(repoRoot, '_ops', 'controller-home');
    expect(repoLocalNoIndexControllerHome(logical, 'darwin')).toBe(resolve(`${logical}.noindex`));
    expect(repoLocalNoIndexControllerHome(logical, 'linux')).toBeUndefined();
    expect(repoLocalNoIndexControllerHome(join(repoRoot, 'controller-home'), 'darwin')).toBeUndefined();
  });

  test('creates a compatible logical symlink to macOS .noindex storage for a new repo-local home', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-controller-home-'));
    roots.push(repoRoot);
    const logical = join(repoRoot, '_ops', 'controller-home');
    const physical = `${logical}.noindex`;
    mkdirSync(join(repoRoot, '_ops'), { recursive: true });

    expect(ensureControllerHomeStorage(logical, 'darwin')).toBe(resolve(logical));
    expect(lstatSync(logical).isSymbolicLink()).toBe(true);
    expect(realpathSync(logical)).toBe(realpathSync(physical));
    expect(resolveRepoPreferredControllerHome(repoRoot)).toBe(resolve(logical));
  });

  test('migrates an existing repo-local directory only through the stopped-runtime helper and can roll it back', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-controller-home-'));
    roots.push(repoRoot);
    const logical = join(repoRoot, '_ops', 'controller-home');
    const physical = `${logical}.noindex`;
    mkdirSync(logical, { recursive: true });
    writeFileSync(join(logical, 'sentinel.json'), '{}\n');

    expect(repoLocalControllerHomeStorageNeedsMigration(logical, 'darwin')).toBe(true);
    const migration = migrateStoppedRepoLocalControllerHomeStorage(logical, 'darwin');
    expect(migration.migrated).toBe(true);
    expect(lstatSync(logical).isSymbolicLink()).toBe(true);
    expect(realpathSync(logical)).toBe(realpathSync(physical));
    expect(existsSync(join(logical, 'sentinel.json'))).toBe(true);
    expect(repoLocalControllerHomeStorageNeedsMigration(logical, 'darwin')).toBe(false);

    rollbackStoppedRepoLocalControllerHomeStorage(migration);
    expect(lstatSync(logical).isDirectory()).toBe(true);
    expect(existsSync(physical)).toBe(false);
    expect(existsSync(join(logical, 'sentinel.json'))).toBe(true);
  });

  test('does not migrate an existing repo-local directory while it may be live', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-controller-home-'));
    roots.push(repoRoot);
    const logical = join(repoRoot, '_ops', 'controller-home');
    mkdirSync(logical, { recursive: true });

    expect(ensureControllerHomeStorage(logical, 'darwin')).toBe(resolve(logical));
    expect(lstatSync(logical).isDirectory()).toBe(true);
  });


  test('runtime state commands resolve the same explicit authoritative controller home', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-controller-home-runtime-'));
    const explicit = mkdtempSync(join(tmpdir(), 'forge-controller-home-runtime-explicit-'));
    roots.push(repoRoot, explicit);
    mkdirSync(join(repoRoot, '_ops', 'controller-home'), { recursive: true });

    expect(resolveRuntimeStateControllerHome(explicit, repoRoot)).toBe(resolve(explicit));
  });

  test('keeps explicit controller home above repo-local discovery', () => {
    delete process.env.FORGE_CONTROLLER_HOME;
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-controller-home-'));
    const explicit = mkdtempSync(join(tmpdir(), 'forge-controller-home-explicit-'));
    roots.push(repoRoot, explicit);
    mkdirSync(join(repoRoot, '_ops', 'controller-home'), { recursive: true });

    expect(resolveRepoPreferredControllerHome(repoRoot, explicit)).toBe(resolve(explicit));
  });
});
