import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  ensureControllerHomeStorage,
  migrateStoppedRepoLocalControllerHomeStorage,
  repoLocalControllerHomeStorageNeedsMigration,
  repoLocalNoIndexControllerHome,
  resolveRepoPreferredControllerHome,
  relocateStoppedControllerHomeAuthority,
  rollbackStoppedControllerHomeAuthorityRelocation,
  rollbackStoppedRepoLocalControllerHomeStorage,
} from '../../src/cli/repositories/controller-home';
import { resolveRuntimeStateControllerHome } from '../../src/cli/commands/runtime';
import { recoveryControllerHomeMigrationPreflight } from '../../src/cli/commands/recovery';

const roots: string[] = [];
const originalControllerHome = process.env.FORGE_CONTROLLER_HOME;

afterEach(() => {
  if (originalControllerHome === undefined) delete process.env.FORGE_CONTROLLER_HOME;
  else process.env.FORGE_CONTROLLER_HOME = originalControllerHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repo-preferred controller home', () => {
  test('does not let a retired repo _ops/controller-home override the installed authority', () => {
    delete process.env.FORGE_CONTROLLER_HOME;
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-controller-home-'));
    roots.push(repoRoot);
    const controllerHome = join(repoRoot, '_ops', 'controller-home');
    mkdirSync(join(controllerHome, 'mcp'), { recursive: true });
    writeFileSync(join(controllerHome, 'mcp', 'mcp.local.json'), '{}\n');

    expect(resolveRepoPreferredControllerHome(repoRoot)).not.toBe(resolve(controllerHome));
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
    expect(resolveRepoPreferredControllerHome(repoRoot)).not.toBe(resolve(logical));
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


describe('stopped Controller Home authority relocation', () => {
  test('atomically moves the whole authority and archives an approved empty destination shell', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-controller-relocate-'));
    roots.push(root);
    const source = join(root, 'repo', '_ops', 'controller-home');
    const destination = join(root, '.forge', 'controller');
    mkdirSync(join(source, 'runtime'), { recursive: true });
    mkdirSync(join(destination, 'source-baseline'), { recursive: true });
    writeFileSync(join(source, 'control-plane.sqlite'), 'source-authority');
    writeFileSync(join(source, 'runtime', 'owner.json'), 'runtime-owner');
    writeFileSync(join(destination, 'source-baseline', 'current.json'), 'shell-only');

    const relocation = relocateStoppedControllerHomeAuthority({
      sourceHome: source,
      destinationHome: destination,
      archiveExistingDestination: true,
      archiveSuffix: 'test-shell',
    });
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(join(destination, 'control-plane.sqlite'), 'utf8')).toBe('source-authority');
    expect(readFileSync(join(destination, 'runtime', 'owner.json'), 'utf8')).toBe('runtime-owner');
    expect(relocation.archivedDestinationHome).toBe(`${destination}.pre-migration-test-shell`);
    expect(readFileSync(join(relocation.archivedDestinationHome!, 'source-baseline', 'current.json'), 'utf8')).toBe('shell-only');

    rollbackStoppedControllerHomeAuthorityRelocation(relocation);
    expect(readFileSync(join(source, 'control-plane.sqlite'), 'utf8')).toBe('source-authority');
    expect(readFileSync(join(destination, 'source-baseline', 'current.json'), 'utf8')).toBe('shell-only');
  });

  test('refuses to overwrite an existing destination unless the caller explicitly approved archival', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-controller-relocate-conflict-'));
    roots.push(root);
    const source = join(root, 'old');
    const destination = join(root, 'new');
    mkdirSync(source, { recursive: true });
    mkdirSync(destination, { recursive: true });
    expect(() => relocateStoppedControllerHomeAuthority({ sourceHome: source, destinationHome: destination }))
      .toThrow('CONTROLLER_HOME_RELOCATION_DESTINATION_EXISTS');
    expect(existsSync(source)).toBe(true);
    expect(existsSync(destination)).toBe(true);
  });
});


describe('Recovery Controller Home migration preflight', () => {
  test('accepts an empty user-level shell but refuses any live service owner', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-recovery-controller-preflight-'));
    roots.push(root);
    const source = join(root, 'repo-controller-home');
    const destination = join(root, 'user-controller');
    mkdirSync(source, { recursive: true });
    mkdirSync(join(destination, 'source-baseline'), { recursive: true });
    writeFileSync(join(destination, 'source-baseline', 'current.json'), '{}');
    const databasePath = join(destination, 'control-plane.sqlite');
    writeFileSync(databasePath, 'synthetic');
    const inspected = () => ({ path: databasePath, integrity: 'ok' as const, schemaVersion: 1, recordCount: 0, auditEventCount: 0, orphanRecordCount: 0 });
    const ready = recoveryControllerHomeMigrationPreflight(source, destination, {
      systemdPid: () => undefined,
      inspectDatabaseFile: inspected,
    });
    expect(ready.destinationAuthorityFree).toBe(true);
    expect(ready.liveOwners).toEqual([]);

    const blocked = recoveryControllerHomeMigrationPreflight(source, destination, {
      systemdPid: (label) => label.includes('runtime') ? 1234 : undefined,
      inspectDatabaseFile: inspected,
    });
    expect(blocked.liveOwners.length).toBeGreaterThan(0);
  });

  test('rejects a destination with durable records or unexpected files', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-recovery-controller-preflight-conflict-'));
    roots.push(root);
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    mkdirSync(source, { recursive: true });
    mkdirSync(join(destination, 'mcp'), { recursive: true });
    writeFileSync(join(destination, 'mcp', 'runtime-token'), 'must-not-merge');
    const databasePath = join(destination, 'control-plane.sqlite');
    writeFileSync(databasePath, 'synthetic');
    const result = recoveryControllerHomeMigrationPreflight(source, destination, {
      systemdPid: () => undefined,
      inspectDatabaseFile: () => ({ path: databasePath, integrity: 'ok', schemaVersion: 1, recordCount: 2, auditEventCount: 3, orphanRecordCount: 0 }),
    });
    expect(result.destinationAuthorityFree).toBe(false);
    expect(result.destinationUnexpectedFiles).toContain('mcp/runtime-token');
    expect(result.destinationRecordCount).toBe(2);
  });
});
