import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  ensureControllerHomeStorage,
  ensureMacosSpotlightOperationalExclusion,
  repoLocalNoIndexControllerHome,
  resetMacosSpotlightExclusionForTests,
  resolveRepoPreferredControllerHome,
  spotlightOperationalExclusionRoot,
} from '../../src/cli/repositories/controller-home';

const roots: string[] = [];
const originalControllerHome = process.env.FORGE_CONTROLLER_HOME;

afterEach(() => {
  if (originalControllerHome === undefined) delete process.env.FORGE_CONTROLLER_HOME;
  else process.env.FORGE_CONTROLLER_HOME = originalControllerHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  resetMacosSpotlightExclusionForTests();
});

describe('macOS Controller Home Spotlight exclusion', () => {
  test('repo-local controller home excludes only the _ops operational root', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-spotlight-'));
    roots.push(repoRoot);
    const controllerHome = join(repoRoot, '_ops', 'controller-home');
    expect(spotlightOperationalExclusionRoot(controllerHome)).toBe(join(repoRoot, '_ops'));
    const first = ensureMacosSpotlightOperationalExclusion(controllerHome, 'darwin');
    const second = ensureMacosSpotlightOperationalExclusion(controllerHome, 'darwin');
    expect(first).toMatchObject({ attempted: true, excludedRoot: join(repoRoot, '_ops'), created: true });
    expect(second).toMatchObject({ attempted: false, excludedRoot: join(repoRoot, '_ops') });
    expect(existsSync(join(repoRoot, '_ops', '.metadata_never_index'))).toBe(true);
    expect(existsSync(join(repoRoot, '.metadata_never_index'))).toBe(false);
  });

  test('global controller home excludes only itself and other platforms are no-op', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-global-controller-'));
    roots.push(home);
    expect(spotlightOperationalExclusionRoot(home)).toBe(resolve(home));
    expect(ensureMacosSpotlightOperationalExclusion(home, 'linux')).toEqual({ attempted: false });
    expect(existsSync(join(home, '.metadata_never_index'))).toBe(false);
    expect(ensureMacosSpotlightOperationalExclusion(home, 'darwin')).toMatchObject({ created: true, excludedRoot: resolve(home) });
  });
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

  test('does not migrate an existing repo-local directory while it may be live', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-controller-home-'));
    roots.push(repoRoot);
    const logical = join(repoRoot, '_ops', 'controller-home');
    mkdirSync(logical, { recursive: true });

    expect(ensureControllerHomeStorage(logical, 'darwin')).toBe(resolve(logical));
    expect(lstatSync(logical).isDirectory()).toBe(true);
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
