import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'fs';
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
  writeForgeRuntimeServiceConfig,
} from '../../src/runtime/root/service';
import { materializePackageRuntimeRelease } from '../../src/runtime/root/package-runtime-release';
import {
  activateScheduledPackageRuntimeService,
  installPackageRuntimeService,
  readPackageRuntimeActivationReceipt,
  renderPackageRuntimeActivationLaunchAgent,
  renderForgeRuntimeSystemdUserUnit,
  type PackageRuntimeActivationRequest,
} from '../../src/runtime/root/package-runtime-service';
import { readRuntimeReleaseAuthority } from '../../src/runtime/root/release-store';
import { ensurePackageConnectorService, packageConnectorLaunchSpec, packageConnectorServicePaths, readPackageConnectorServiceAuthority, renderPackageConnectorLaunchAgent, renderPackageConnectorSystemdUserUnit } from '../../src/runtime/root/package-connector-service';
import { retireConflictingForgeLaunchAgents } from '../../src/cli/controller/launch-agents';

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
    expect(existsSync(paths.installedPlistPath)).toBe(false);
    const plist = readFileSync(paths.sourcePlistPath, 'utf8');
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
    expect(existsSync(paths.installedPlistPath)).toBe(false);
    expect(readFileSync(paths.sourcePlistPath, 'utf8')).not.toContain('browser-automation-helper');
  });

  test('materializes an npm/package Runtime release without Git or Bun compilation and snapshots package drift', () => {
    const fx = fixture(), packageRoot = join(fx.root, 'package');
    for (const dir of ['src/runtime/root', 'src/runtime/shared', 'bin', 'assets', 'scripts']) mkdirSync(join(packageRoot, dir), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@moretea-labs/forge', version: '9.9.9-test' }));
    writeFileSync(join(packageRoot, 'src', 'runtime.ts'), 'export const runtime = 1;\n');
    writeFileSync(join(packageRoot, 'src', 'runtime', 'root', 'entry.ts'), 'process.exit(0);\n');
    writeFileSync(join(packageRoot, 'src', 'runtime', 'shared', 'node-ts-loader.mjs'), 'export async function load(url, context, nextLoad) { return nextLoad(url, context); }\n');
    writeFileSync(join(packageRoot, 'bin', 'forge-runtime.mjs'), 'process.exit(99);\n');
    const release = materializePackageRuntimeRelease({ controllerHome: fx.home, packageRoot, operationId: 'package-test' });
    expect(release.releaseId).toStartWith('package-9.9.9-test-'); expect(activeRuntimeEntrypoint(fx.home)).toBe(release.entrypointPath);
    const manifestBytes = readFileSync(release.manifestPath, 'utf8');
    const manifest = JSON.parse(manifestBytes); expect(manifest.releaseRevision).toBe(`package:9.9.9-test:${release.packageFingerprint}`); expect(manifest.sourceCommit).toBeUndefined();
    const repeated = materializePackageRuntimeRelease({ controllerHome: fx.home, packageRoot, operationId: 'package-test-repeat' });
    expect(repeated.releaseId).toBe(release.releaseId);
    expect(readFileSync(repeated.manifestPath, 'utf8')).toBe(manifestBytes);
    const launcherBytes = readFileSync(release.entrypointPath, 'utf8');
    expect(launcherBytes).toContain('process.versions?.bun');
    expect(launcherBytes).not.toContain('FORGE_FORCE_NODE');
    const launchdEnvironment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
    const launched = spawnSync(release.entrypointPath, [], { encoding: 'utf8', env: launchdEnvironment }); expect(launched.status).toBe(0);
    writeFileSync(join(packageRoot, 'src', 'runtime.ts'), 'export const runtime = 2;\n');
    const unchanged = spawnSync(release.entrypointPath, [], { encoding: 'utf8', env: launchdEnvironment }); expect(unchanged.status).toBe(0);
    expect(readFileSync(join(release.packageRoot, 'src', 'runtime.ts'), 'utf8')).toBe('export const runtime = 1;\n');
    const changed = materializePackageRuntimeRelease({ controllerHome: fx.home, packageRoot, operationId: 'package-test-changed' });
    expect(changed.releaseId).not.toBe(release.releaseId);
    expect(readFileSync(join(changed.packageRoot, 'src', 'runtime.ts'), 'utf8')).toBe('export const runtime = 2;\n');
  });

  test('fails closed instead of repairing bytes inside an existing package release directory', () => {
    const fx = fixture(), packageRoot = join(fx.root, 'package');
    for (const dir of ['src', 'bin', 'assets', 'scripts']) mkdirSync(join(packageRoot, dir), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@moretea-labs/forge', version: '9.9.9-test' }));
    writeFileSync(join(packageRoot, 'src', 'runtime.ts'), 'export const runtime = 1;\n');
    writeFileSync(join(packageRoot, 'bin', 'forge-runtime.mjs'), 'process.exit(0);\n');
    const release = materializePackageRuntimeRelease({ controllerHome: fx.home, packageRoot, operationId: 'immutable-first' });
    const corrupted = readFileSync(release.manifestPath, 'utf8').replace('"cleanWorkspace": true', '"cleanWorkspace": false');
    writeFileSync(release.manifestPath, corrupted);
    expect(() => materializePackageRuntimeRelease({ controllerHome: fx.home, packageRoot, operationId: 'immutable-repeat' }))
      .toThrow('PACKAGE_RUNTIME_RELEASE_IMMUTABILITY_VIOLATION');
    expect(readFileSync(release.manifestPath, 'utf8')).toBe(corrupted);
  });

  test('schedules launchd activation outside the installing Runtime lifecycle and persists the final receipt', async () => {
    const fx = fixture(), packageRoot = join(fx.root, 'package-self-update');
    for (const dir of ['src', 'bin', 'assets', 'scripts']) mkdirSync(join(packageRoot, dir), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@moretea-labs/forge', version: '9.9.9-test' }));
    writeFileSync(join(packageRoot, 'src', 'runtime.ts'), 'export const runtime = 2;\n');
    writeFileSync(join(packageRoot, 'bin', 'forge-runtime.mjs'), 'process.exit(0);\n');

    let scheduled: PackageRuntimeActivationRequest | undefined;
    let installAttempts = 0;
    const result = await installPackageRuntimeService({
      controllerHome: fx.home,
      packageRoot,
      authTokenFile: fx.token,
      platform: 'darwin',
      refreshConnector: false,
    }, {
      scheduleDarwinActivation: async (request) => {
        scheduled = request;
        return { label: 'com.moretea.forge.runtime-activation.test', servicePath: join(fx.root, 'activation.plist') };
      },
      installDarwinService: async () => {
        installAttempts += 1;
        return forgeRuntimeServicePaths(fx.home);
      },
    });

    expect(result.status).toBe('activation_scheduled');
    expect(installAttempts).toBe(0);
    expect(scheduled).toBeDefined();
    expect(readPackageRuntimeActivationReceipt(result.activation!.receiptPath)?.status).toBe('activation_scheduled');
    const helperPlist = renderPackageRuntimeActivationLaunchAgent(scheduled!);
    expect(helperPlist).toContain(`<string>${scheduled!.nodeExecutable}</string>`);
    expect(helperPlist).toContain(`<string>${join(scheduled!.release.packageRoot, 'src', 'cli', 'index.ts')}</string>`);
    expect(helperPlist).not.toContain(`${join(scheduled!.release.packageRoot, 'bin', 'forge.mjs')}</string>`);

    await activateScheduledPackageRuntimeService(scheduled!, {
      installDarwinService: async () => {
        installAttempts += 1;
        return forgeRuntimeServicePaths(fx.home);
      },
      waitForInstallerExit: async () => {},
      cleanupActivationHelper: async () => {},
    });

    expect(installAttempts).toBe(1);
    const receipt = readPackageRuntimeActivationReceipt(result.activation!.receiptPath);
    expect(receipt?.status).toBe('activated');
    expect(receipt?.releaseId).toBe(result.release.releaseId);
  });

  test('persists failed+rollback when detached activation fails after scheduling', async () => {
    const fx = fixture(), packageRoot = join(fx.root, 'package-detached-failure');
    for (const dir of ['src', 'bin', 'assets', 'scripts']) mkdirSync(join(packageRoot, dir), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@moretea-labs/forge', version: '9.9.9-test' }));
    writeFileSync(join(packageRoot, 'src', 'runtime.ts'), 'export const runtime = 3;\n');
    writeFileSync(join(packageRoot, 'bin', 'forge-runtime.mjs'), 'process.exit(0);\n');

    let scheduled: PackageRuntimeActivationRequest | undefined;
    const result = await installPackageRuntimeService({
      controllerHome: fx.home,
      packageRoot,
      authTokenFile: fx.token,
      platform: 'darwin',
      refreshConnector: false,
    }, {
      scheduleDarwinActivation: async (request) => {
        scheduled = request;
        return { label: request.helperLabel, servicePath: request.helperInstalledPlistPath };
      },
      installDarwinService: async () => forgeRuntimeServicePaths(fx.home),
    });

    await expect(activateScheduledPackageRuntimeService(scheduled!, {
      installDarwinService: async () => { throw new Error('synthetic detached activation failure'); },
      waitForInstallerExit: async () => {},
      cleanupActivationHelper: async () => {},
    })).rejects.toThrow('FORGE_PACKAGE_RUNTIME_ACTIVATION_FAILED_ROLLED_BACK');

    const receipt = readPackageRuntimeActivationReceipt(result.activation!.receiptPath);
    expect(receipt?.status).toBe('failed+rollback');
    expect(receipt?.rollbackSucceeded).toBe(true);
    expect(receipt?.error).toContain('synthetic detached activation failure');
    expect(readRuntimeReleaseAuthority(fx.home)).toBeUndefined();
  });

  test('removes a first package publication when service activation fails', async () => {
    const fx = fixture(), packageRoot = join(fx.root, 'package');
    for (const dir of ['src', 'bin', 'assets', 'scripts']) mkdirSync(join(packageRoot, dir), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@moretea-labs/forge', version: '9.9.9-test' }));
    writeFileSync(join(packageRoot, 'src', 'runtime.ts'), 'export const runtime = 1;\n');
    writeFileSync(join(packageRoot, 'bin', 'forge-runtime.mjs'), 'process.exit(0);\n');
    const paths = forgeRuntimeServicePaths(fx.home);
    let installAttempts = 0;
    await expect(installPackageRuntimeService({
      controllerHome: fx.home,
      packageRoot,
      authTokenFile: fx.token,
      platform: 'darwin',
      refreshConnector: false,
    }, {
      installDarwinService: async () => {
        installAttempts += 1;
        throw new Error('synthetic launchd activation failure');
      },
    })).rejects.toThrow('synthetic launchd activation failure');
    expect(installAttempts).toBe(1);
    expect(readRuntimeReleaseAuthority(fx.home)).toBeUndefined();
    expect(existsSync(paths.configPath)).toBe(false);
    expect(existsSync(paths.activeEntrypointPath)).toBe(false);
  });

  test('restores the previous package authority, config, and service after activation failure', async () => {
    const fx = fixture();
    const makePackage = (name: string, runtimeValue: number) => {
      const packageRoot = join(fx.root, name);
      for (const dir of ['src', 'bin', 'assets', 'scripts']) mkdirSync(join(packageRoot, dir), { recursive: true });
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@moretea-labs/forge', version: '9.9.9-test' }));
      writeFileSync(join(packageRoot, 'src', 'runtime.ts'), `export const runtime = ${runtimeValue};\n`);
      writeFileSync(join(packageRoot, 'bin', 'forge-runtime.mjs'), 'process.exit(0);\n');
      return packageRoot;
    };
    const priorPackageRoot = makePackage('package-prior', 1);
    const candidatePackageRoot = makePackage('package-candidate', 2);
    const priorRelease = materializePackageRuntimeRelease({ controllerHome: fx.home, packageRoot: priorPackageRoot, operationId: 'prior-package' });
    writeForgeRuntimeServiceConfig({
      schemaVersion: 1,
      controllerHome: fx.home,
      repositoryRoot: priorPackageRoot,
      host: '127.0.0.1',
      port: 8765,
      authTokenFile: fx.token,
    });
    syncForgeRuntimeActiveEntrypoint(fx.home);
    const paths = forgeRuntimeServicePaths(fx.home);
    const priorConfigBytes = readFileSync(paths.configPath, 'utf8');
    let installAttempts = 0;
    await expect(installPackageRuntimeService({
      controllerHome: fx.home,
      packageRoot: candidatePackageRoot,
      authTokenFile: fx.token,
      platform: 'darwin',
      refreshConnector: false,
    }, {
      installDarwinService: async () => {
        installAttempts += 1;
        if (installAttempts === 1) throw new Error('synthetic candidate launchd failure');
        return forgeRuntimeServicePaths(fx.home);
      },
    })).rejects.toThrow('synthetic candidate launchd failure');
    expect(installAttempts).toBe(2);
    const authority = readRuntimeReleaseAuthority(fx.home);
    expect(authority?.active.releaseId).toBe(priorRelease.releaseId);
    expect(authority?.previous?.releaseId).not.toBe(priorRelease.releaseId);
    expect(activeRuntimeEntrypoint(fx.home)).toBe(priorRelease.entrypointPath);
    expect(readFileSync(paths.configPath, 'utf8')).toBe(priorConfigBytes);
  });

  test('renders a persistent OAuth connector separate from the bearer-only Runtime port', () => {
    const fx = fixture(), packageRoot = join(fx.root, 'package');
    for (const dir of ['src/cli', 'src/runtime/shared', 'bin', 'assets', 'scripts']) mkdirSync(join(packageRoot, dir), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@moretea-labs/forge', version: '9.9.9-test' }));
    writeFileSync(join(packageRoot, 'bin', 'forge-runtime.mjs'), 'process.exit(0);\n');
    writeFileSync(join(packageRoot, 'src', 'cli', 'index.ts'), '');
    writeFileSync(join(packageRoot, 'src', 'runtime', 'shared', 'node-ts-loader.mjs'), '');
    const release = materializePackageRuntimeRelease({ controllerHome: fx.home, packageRoot, operationId: 'connector-test' });
    const launch = packageConnectorLaunchSpec({ release, controllerHome: fx.home, endpoint: 'http://127.0.0.1:8767/mcp', executable: '/usr/local/bin/node' });
    expect(launch.port).toBe(8767);
    expect(launch.args.join(' ')).toContain('mcp serve');
    expect(launch.args).not.toContain('--repo');
    expect(launch.args.join(' ')).toContain('--port 8767');
    expect(launch.args.join(' ')).toContain('--auth oauth');
    expect(launch.environment.FORGE_CONTROLLER_LIFECYCLE_OWNER).toBe('1');
    const paths = packageConnectorServicePaths(fx.home, fx.root);
    const plist = renderPackageConnectorLaunchAgent({ paths, launch });
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<string>8767</string>');
    expect(plist).toContain('<string>oauth</string>');
    const unit = renderPackageConnectorSystemdUserUnit({ launch });
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('8767');
  });

  test('reuses a healthy persistent public Gateway without rewriting its service or authority', async () => {
    const fx = fixture(), packageRoot = join(fx.root, 'package');
    for (const dir of ['src/cli', 'src/runtime/shared', 'bin', 'assets', 'scripts']) mkdirSync(join(packageRoot, dir), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@moretea-labs/forge', version: '9.9.9-test' }));
    writeFileSync(join(packageRoot, 'bin', 'forge-runtime.mjs'), 'process.exit(0);\n');
    writeFileSync(join(packageRoot, 'src', 'cli', 'index.ts'), '');
    writeFileSync(join(packageRoot, 'src', 'runtime', 'shared', 'node-ts-loader.mjs'), '');
    const release = materializePackageRuntimeRelease({ controllerHome: fx.home, packageRoot, operationId: 'connector-reuse-test' });
    const paths = packageConnectorServicePaths(fx.home, fx.root);
    mkdirSync(paths.serviceRoot, { recursive: true });
    const installedAt = '2026-08-18T00:00:00.000Z';
    writeFileSync(paths.authorityPath, `${JSON.stringify({
      schemaVersion: 1,
      endpoint: 'http://127.0.0.1:8767/mcp',
      releaseId: release.releaseId,
      releaseRoot: release.releaseRoot,
      packageRoot: release.packageRoot,
      mode: 'launchd',
      persistent: true,
      servicePath: paths.installedPlistPath,
      installedAt,
    }, null, 2)}\n`);
    const before = readFileSync(paths.authorityPath, 'utf8');
    let probes = 0;
    const result = await ensurePackageConnectorService({
      release,
      controllerHome: fx.home,
      endpoint: 'http://127.0.0.1:8767/mcp',
      platform: 'darwin',
      env: { HOME: fx.root },
      probeEndpoint: async () => { probes += 1; return true; },
    });
    expect(result.reused).toBe(true);
    expect(result.releaseId).toBe(release.releaseId);
    expect(result.releaseRoot).toBe(release.releaseRoot);
    expect(probes).toBe(1);
    expect(readFileSync(paths.authorityPath, 'utf8')).toBe(before);
    expect(readPackageConnectorServiceAuthority(fx.home)?.installedAt).toBe(installedAt);
    expect(existsSync(paths.sourcePlistPath)).toBe(false);
  });

  test('retires a stale Forge connector owner on the same port before reboot can reload it', async () => {
    const fx = fixture();
    const launchAgents = join(fx.root, 'Library', 'LaunchAgents');
    mkdirSync(launchAgents, { recursive: true });
    const staleLabel = 'com.moretea.forge.mcp-gateway';
    const stalePlist = join(launchAgents, `${staleLabel}.plist`);
    writeFileSync(stalePlist, `<?xml version="1.0"?><plist><dict>
      <key>Label</key><string>${staleLabel}</string>
      <key>ProgramArguments</key><array>
        <string>/usr/local/bin/forge</string><string>mcp</string><string>serve</string>
        <string>--port</string><string>8767</string><string>--auth</string><string>oauth</string>
      </array>
    </dict></plist>`);
    const differentPort = join(launchAgents, 'com.moretea.forge.mcp-gateway.other.plist');
    writeFileSync(differentPort, readFileSync(stalePlist, 'utf8')
      .replaceAll(staleLabel, 'com.moretea.forge.mcp-gateway.other')
      .replace('8767', '9767'));
    const calls: string[] = [];
    const retired = await retireConflictingForgeLaunchAgents({
      accountHome: fx.root,
      desiredLabel: 'com.moretea.forge.mcp-gateway.current',
      labelPrefix: 'com.moretea.forge.mcp-gateway',
      port: 8767,
      requiredArguments: ['mcp', 'serve', '--auth', 'oauth'],
    }, {
      now: () => 1234,
      bootout: async ({ label }) => {
        calls.push(label);
        return { ok: true, attempts: 1, serviceTarget: `gui/501/${label}`, diagnostics: [] };
      },
    });
    expect(calls).toEqual([staleLabel]);
    expect(retired).toEqual([{
      label: staleLabel,
      plistPath: stalePlist,
      backupPath: join(launchAgents, '.forge-retired', `${staleLabel}.1234.plist`),
    }]);
    expect(existsSync(stalePlist)).toBe(false);
    expect(existsSync(retired[0]!.backupPath)).toBe(true);
    expect(existsSync(differentPort)).toBe(true);
  });

  test('fails closed without moving a conflicting Forge owner when bootout fails', async () => {
    const fx = fixture();
    const launchAgents = join(fx.root, 'Library', 'LaunchAgents');
    mkdirSync(launchAgents, { recursive: true });
    const label = 'com.moretea.forge.runtime.stale';
    const plist = join(launchAgents, `${label}.plist`);
    writeFileSync(plist, `<?xml version="1.0"?><plist><dict>
      <key>Label</key><string>${label}</string>
      <key>ProgramArguments</key><array>
        <string>/tmp/forge-runtime</string><string>--controller-home</string><string>/tmp/stale</string>
        <string>--port</string><string>8765</string>
      </array>
    </dict></plist>`);
    await expect(retireConflictingForgeLaunchAgents({
      accountHome: fx.root,
      desiredLabel: 'com.moretea.forge.runtime.current',
      labelPrefix: 'com.moretea.forge.runtime.',
      port: 8765,
      requiredArguments: ['--controller-home'],
    }, {
      bootout: async () => ({ ok: false, attempts: 1, serviceTarget: 'gui/501/stale', diagnostics: ['busy'] }),
    })).rejects.toThrow('FORGE_LAUNCH_AGENT_CONFLICT_RETIRE_FAILED');
    expect(existsSync(plist)).toBe(true);
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
