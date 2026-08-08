import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  activeRuntimeEntrypoint,
  ensureForgeRuntimeLaunchAgentContract,
  forgeRuntimeServicePaths,
  renderForgeRuntimeLaunchAgent,
  syncForgeRuntimeActiveEntrypoint,
  validateForgeRuntimeServiceConfig,
} from '../../src/runtime/root/service';

const roots: string[] = [];
function fixture(): { root: string; home: string; repo: string; token: string } {
  const root = mkdtempSync(join(tmpdir(), 'forge-runtime-service-'));
  roots.push(root);
  const home = join(root, 'controller-home');
  const repo = join(root, 'repo');
  const token = join(root, 'auth-token.json');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(token, '{}\n');
  return { root, home, repo, token };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Forge Runtime service', () => {
  test('derives one stable launchd service identity from Controller Home', () => {
    const fx = fixture();
    const first = forgeRuntimeServicePaths(fx.home);
    const second = forgeRuntimeServicePaths(fx.home);
    expect(first.label).toBe(second.label);
    expect(first.label.startsWith('com.moretea.forge.runtime.')).toBe(true);
    expect(first.configPath).toBe(join(fx.home, 'runtime', 'service', 'config.json'));
    expect(first.activeEntrypointPath).toBe(join(fx.home, 'runtime', 'service', 'active-forge-runtime'));
  });

  test('renders launchd auto-start and abnormal-exit restart contract', () => {
    const fx = fixture();
    const paths = forgeRuntimeServicePaths(fx.home);
    const bootstrap = renderForgeRuntimeLaunchAgent({
      paths,
      nodeExecutable: '/usr/local/bin/node',
      runnerPath: '/package/bin/forge-runtime-service.mjs',
    });
    expect(bootstrap).toContain('<key>RunAtLoad</key>');
    expect(bootstrap).toContain('<key>KeepAlive</key>');
    expect(bootstrap).toContain('<key>SuccessfulExit</key>');
    expect(bootstrap).toContain('<false/>');
    expect(bootstrap).toContain('--controller-home');
    expect(bootstrap).toContain('--config');
    expect(bootstrap).toContain('forge-runtime-service.mjs');

    const release = renderForgeRuntimeLaunchAgent({ paths, activeEntrypointPath: paths.activeEntrypointPath });
    expect(release).toContain(paths.activeEntrypointPath);
    expect(release).not.toContain('forge-runtime-service.mjs');
  });

  test('pins launchd persistence to active immutable release once authority exists', () => {
    const fx = fixture();
    const paths = forgeRuntimeServicePaths(fx.home);
    const releaseRoot = join(fx.home, 'runtime', 'releases', 'release-a');
    const entry = join(releaseRoot, 'forge-runtime');
    const manifestPath = join(releaseRoot, 'manifest.json');
    mkdirSync(releaseRoot, { recursive: true });
    writeFileSync(entry, 'binary');
    writeFileSync(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      releaseId: 'release-a',
      entrypoint: 'forge-runtime',
      controllerHome: fx.home,
      artifactIdentity: 'sha256:test',
    })}\n`);
    writeFileSync(join(fx.home, 'runtime', 'releases', 'authority.json'), `${JSON.stringify({
      schemaVersion: 1,
      status: 'committed',
      active: { releaseId: 'release-a', manifestPath, artifactIdentity: 'sha256:test' },
    })}\n`);

    expect(activeRuntimeEntrypoint(fx.home)).toBe(entry);
    const synced = syncForgeRuntimeActiveEntrypoint(fx.home);
    expect(synced.target).toBe(entry);
    expect(readlinkSync(paths.activeEntrypointPath)).toBe(entry);
    const ensured = ensureForgeRuntimeLaunchAgentContract({ controllerHome: fx.home });
    expect(ensured.mode).toBe('release');
    const plist = readFileSync(paths.installedPlistPath, 'utf8');
    expect(plist).toContain(paths.activeEntrypointPath);
    expect(plist).not.toContain('forge-runtime-service.mjs');
  });

  test('validates the service config before installation', () => {
    const fx = fixture();
    const config = validateForgeRuntimeServiceConfig({
      schemaVersion: 1,
      controllerHome: fx.home,
      repositoryRoot: fx.repo,
      host: '127.0.0.1',
      port: 8765,
      authTokenFile: fx.token,
      exclusiveWorkId: 'work-test',
    });
    expect(config.controllerHome).toBe(fx.home);
    expect(config.repositoryRoot).toBe(fx.repo);
    expect(config.authTokenFile).toBe(fx.token);
    expect(config.exclusiveWorkId).toBe('work-test');
  });
});
