import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
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
import { materializePackageRuntimeRelease } from '../../src/runtime/root/package-runtime-release';
import { renderForgeRuntimeSystemdUserUnit } from '../../src/runtime/root/package-runtime-service';

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

    const release = renderForgeRuntimeLaunchAgent({
      paths,
      activeEntrypointPath: paths.activeEntrypointPath,
      runtimeArgs: ['--controller-home', fx.home, '--repo', fx.repo],
      environment: { FORGE_CONTROLLER_HOME: fx.home },
    });
    expect(release).toContain(paths.activeEntrypointPath);
    expect(release).toContain('<string>--repo</string>');
    expect(release).toContain('<key>EnvironmentVariables</key>');
    expect(release).not.toContain('forge-runtime-service.mjs');
    expect(release).not.toContain('<string>--config</string>');
  });

  test('pins launchd persistence to active immutable release once authority exists', () => {
    const fx = fixture();
    const paths = forgeRuntimeServicePaths(fx.home);
    const releaseRoot = join(fx.home, 'runtime', 'releases', 'release-a');
    const entry = join(releaseRoot, 'forge-runtime');
    const cliEntry = join(releaseRoot, 'forge-cli');
    const manifestPath = join(releaseRoot, 'manifest.json');
    mkdirSync(releaseRoot, { recursive: true });
    writeFileSync(entry, 'binary');
    writeFileSync(cliEntry, 'cli');
    writeFileSync(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      releaseId: 'release-a',
      entrypoint: 'forge-runtime',
      diagnosticEntrypoint: 'forge-cli',
      controllerHome: fx.home,
      artifactIdentity: 'sha256:test',
      releaseRevision: 'release-revision-a',
      sourceCommit: 'source-a',
      cleanWorkspace: true,
      arguments: [],
    })}\n`);
    writeFileSync(join(fx.home, 'runtime', 'releases', 'authority.json'), `${JSON.stringify({
      schemaVersion: 1,
      status: 'committed',
      active: { releaseId: 'release-a', manifestPath, artifactIdentity: 'sha256:test' },
    })}\n`);

    mkdirSync(paths.serviceRoot, { recursive: true });
    writeFileSync(paths.configPath, `${JSON.stringify({
      schemaVersion: 1,
      controllerHome: fx.home,
      repositoryRoot: fx.repo,
      host: '127.0.0.1',
      port: 8765,
      authTokenFile: fx.token,
      exclusiveWorkId: 'work-test',
    })}\n`);

    expect(activeRuntimeEntrypoint(fx.home)).toBe(entry);
    const synced = syncForgeRuntimeActiveEntrypoint(fx.home);
    expect(synced.target).toBe(entry);
    expect(readlinkSync(paths.activeEntrypointPath)).toBe(entry);
    const ensured = ensureForgeRuntimeLaunchAgentContract({ controllerHome: fx.home });
    expect(ensured.mode).toBe('release');
    const plist = readFileSync(paths.installedPlistPath, 'utf8');
    expect(plist).toContain(paths.activeEntrypointPath);
    expect(plist).toContain('<string>--repo</string>');
    expect(plist).toContain(`<string>${fx.repo}</string>`);
    expect(plist).toContain('<string>--release-manifest</string>');
    expect(plist).toContain(`<string>${manifestPath}</string>`);
    expect(plist).toContain('<string>--host</string>');
    expect(plist).toContain('<string>127.0.0.1</string>');
    expect(plist).toContain('<string>--port</string>');
    expect(plist).toContain('<string>8765</string>');
    expect(plist).toContain('<string>--auth-token-file</string>');
    expect(plist).toContain(`<string>${fx.token}</string>`);
    expect(plist).toContain('<string>--exclusive-work-id</string>');
    expect(plist).toContain('<string>work-test</string>');
    expect(plist).toContain('<key>FORGE_CONTROLLER_RUNTIME_SOURCE_ROOT</key>');
    expect(plist).toContain('<key>FORGE_CLI_EXECUTABLE</key>');
    expect(plist).toContain(`<string>${cliEntry}</string>`);
    expect(plist).toContain(`<string>${releaseRoot}</string>`);
    expect(plist).toContain('<key>FORGE_RELEASE_ID</key>');
    expect(plist).toContain('<string>release-a</string>');
    expect(plist).toContain('<key>FORGE_RELEASE_REVISION</key>');
    expect(plist).toContain('<string>release-revision-a</string>');
    expect(plist).toContain('<key>FORGE_RELEASE_SOURCE_COMMIT</key>');
    expect(plist).toContain('<string>source-a</string>');
    expect(plist).not.toContain('<string>--config</string>');
    expect(plist).not.toContain('forge-runtime-service.mjs');
  });

  test('does not materialize or reconcile a standalone Browser Automation helper from legacy manifest fields', () => {
    const fx = fixture();
    const releaseRoot = join(fx.home, 'runtime', 'releases', 'release-legacy-helper');
    const entry = join(releaseRoot, 'forge-runtime');
    const manifestPath = join(releaseRoot, 'manifest.json');
    mkdirSync(releaseRoot, { recursive: true });
    writeFileSync(entry, 'runtime');
    writeFileSync(manifestPath, `${JSON.stringify({
      schemaVersion: 1, releaseId: 'release-legacy-helper', entrypoint: 'forge-runtime', controllerHome: fx.home,
      artifactIdentity: 'sha256:runtime', arguments: [], browserAutomationHelperEntrypoint: 'browser-automation-helper',
      browserAutomationHelperArtifactIdentity: `sha256:${'a'.repeat(64)}`, browserAutomationHelperContractIdentity: `sha256:${'b'.repeat(64)}`,
    })}\n`);
    writeFileSync(join(fx.home, 'runtime', 'releases', 'authority.json'), `${JSON.stringify({
      schemaVersion: 1, status: 'committed', active: { releaseId: 'release-legacy-helper', manifestPath, artifactIdentity: 'sha256:runtime' },
    })}\n`);
    const paths = forgeRuntimeServicePaths(fx.home);
    mkdirSync(paths.serviceRoot, { recursive: true });
    writeFileSync(paths.configPath, `${JSON.stringify({ schemaVersion: 1, controllerHome: fx.home, repositoryRoot: fx.repo, host: '127.0.0.1', port: 8765, authTokenFile: fx.token })}\n`);
    expect(ensureForgeRuntimeLaunchAgentContract({ controllerHome: fx.home }).mode).toBe('release');
    expect(readFileSync(paths.installedPlistPath, 'utf8')).not.toContain('browser-automation-helper');
  });

  test('materializes an npm/package Runtime release without Git or Bun compilation and fences package drift', () => {
    const fx = fixture(), packageRoot = join(fx.root, 'package');
    for (const dir of ['src', 'bin', 'assets', 'scripts']) mkdirSync(join(packageRoot, dir), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@moretea-labs/forge', version: '9.9.9-test' })); writeFileSync(join(packageRoot, 'src', 'runtime.ts'), 'export const runtime = 1;\n'); writeFileSync(join(packageRoot, 'bin', 'forge-runtime.mjs'), 'process.exit(0);\n');
    const release = materializePackageRuntimeRelease({ controllerHome: fx.home, packageRoot, operationId: 'package-test' });
    expect(release.releaseId).toStartWith('package-9.9.9-test-'); expect(activeRuntimeEntrypoint(fx.home)).toBe(release.entrypointPath);
    const manifest = JSON.parse(readFileSync(release.manifestPath, 'utf8')); expect(manifest.releaseRevision).toBe(`package:9.9.9-test:${release.packageFingerprint}`); expect(manifest.sourceCommit).toBeUndefined();
    writeFileSync(join(packageRoot, 'src', 'runtime.ts'), 'export const runtime = 2;\n');
    const rejected = spawnSync(release.entrypointPath, [], { encoding: 'utf8' }); expect(rejected.status).toBe(78); expect(rejected.stderr).toContain('FORGE_PACKAGE_RUNTIME_SOURCE_CHANGED');
  });

  test('renders a systemd user owner with restart and release environment', () => {
    const unit = renderForgeRuntimeSystemdUserUnit({ executable: '/var/tmp/forge-user/.forge/runtime/service/active-forge-runtime', args: ['--port', '8765'], environment: { FORGE_RELEASE_ID: 'package-test', FORGE_CONTROLLER_HOME: '/var/tmp/forge-user/.forge' } });
    for (const expected of ['WantedBy=default.target', 'Restart=on-failure', 'ExecStart="/var/tmp/forge-user/.forge/runtime/service/active-forge-runtime" "--port" "8765"', 'Environment="FORGE_RELEASE_ID=package-test"']) expect(unit).toContain(expected);
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
