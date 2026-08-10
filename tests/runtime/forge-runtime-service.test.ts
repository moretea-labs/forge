import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  activeRuntimeEntrypoint,
  ensureBrowserAutomationLaunchAgentContract,
  ensureBrowserAutomationLaunchAgentRunning,
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
    const manifestPath = join(releaseRoot, 'manifest.json');
    mkdirSync(releaseRoot, { recursive: true });
    writeFileSync(entry, 'binary');
    writeFileSync(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      releaseId: 'release-a',
      entrypoint: 'forge-runtime',
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

  test('uses a short private Unix socket path while keeping the helper executable under Controller Home', () => {
    const fx = fixture();
    const releasesRoot = join(fx.home, 'runtime', 'releases');
    const releaseRoot = join(releasesRoot, 'release-socket');
    const helper = join(releaseRoot, 'browser-automation-helper');
    const manifestPath = join(releaseRoot, 'manifest.json');
    mkdirSync(releaseRoot, { recursive: true });
    writeFileSync(join(releaseRoot, 'forge-runtime'), 'runtime');
    writeFileSync(helper, 'helper');
    const helperIdentity = `sha256:${createHash('sha256').update('helper').digest('hex')}`;
    const helperContractIdentity = `sha256:${createHash('sha256').update('helper-source').digest('hex')}`;
    writeFileSync(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      releaseId: 'release-socket',
      entrypoint: 'forge-runtime',
      controllerHome: fx.home,
      artifactIdentity: 'sha256:runtime-socket',
      arguments: [],
      browserAutomationHelperEntrypoint: 'browser-automation-helper',
      browserAutomationHelperArtifactIdentity: helperIdentity,
      browserAutomationHelperContractIdentity: helperContractIdentity,
    })}\n`);
    writeFileSync(join(releasesRoot, 'authority.json'), `${JSON.stringify({
      schemaVersion: 1,
      status: 'committed',
      active: { releaseId: 'release-socket', manifestPath, artifactIdentity: 'sha256:runtime-socket' },
    })}\n`);
    const contract = ensureBrowserAutomationLaunchAgentContract({ controllerHome: fx.home, accountHome: join(fx.root, 'account-home-socket') });
    expect(contract).toBeDefined();
    expect(contract!.paths.executablePath.startsWith(join(fx.home, 'runtime', 'browser-automation'))).toBe(true);
    expect(contract!.paths.socketPath.startsWith('/tmp/forge-browser-automation-')).toBe(true);
    expect(Buffer.byteLength(contract!.paths.socketPath)).toBeLessThan(100);
    const plist = readFileSync(contract!.paths.installedPlistPath, 'utf8');
    expect(plist).toContain('<string>--socket-path</string>');
    expect(plist).toContain(`<string>${contract!.paths.socketPath}</string>`);
  });

  test('keeps Browser Automation helper identity stable across unrelated Runtime releases', () => {
    const fx = fixture();
    const accountHome = join(fx.root, 'account-home');
    const releasesRoot = join(fx.home, 'runtime', 'releases');
    mkdirSync(releasesRoot, { recursive: true });

    const writeRelease = (releaseId: string, helperBytes: string, helperContractSource: string) => {
      const releaseRoot = join(releasesRoot, releaseId);
      mkdirSync(releaseRoot, { recursive: true });
      const entry = join(releaseRoot, 'forge-runtime');
      const helper = join(releaseRoot, 'browser-automation-helper');
      const manifestPath = join(releaseRoot, 'manifest.json');
      writeFileSync(entry, `runtime-${releaseId}`);
      writeFileSync(helper, helperBytes);
      const helperIdentity = `sha256:${createHash('sha256').update(helperBytes).digest('hex')}`;
      const helperContractIdentity = `sha256:${createHash('sha256').update(helperContractSource).digest('hex')}`;
      writeFileSync(manifestPath, `${JSON.stringify({
        schemaVersion: 1,
        releaseId,
        entrypoint: 'forge-runtime',
        controllerHome: fx.home,
        artifactIdentity: `sha256:${releaseId}`,
        arguments: [],
        browserAutomationHelperEntrypoint: 'browser-automation-helper',
        browserAutomationHelperArtifactIdentity: helperIdentity,
        browserAutomationHelperContractIdentity: helperContractIdentity,
      })}\n`);
      writeFileSync(join(releasesRoot, 'authority.json'), `${JSON.stringify({
        schemaVersion: 1,
        status: 'committed',
        active: { releaseId, manifestPath, artifactIdentity: `sha256:${releaseId}` },
      })}\n`);
      return { helperIdentity, helperContractIdentity };
    };

    const firstRelease = writeRelease('release-a', 'compiled-browser-helper-a', 'browser-helper-contract-v1');
    const first = ensureBrowserAutomationLaunchAgentContract({ controllerHome: fx.home, accountHome });
    expect(first).toBeDefined();
    expect(first!.artifactChanged).toBe(true);
    expect(first!.paths.executablePath).toBe(join(fx.home, 'runtime', 'browser-automation', 'browser-automation-helper'));
    expect(first!.paths.socketPath.startsWith('/tmp/forge-browser-automation-')).toBe(true);
    expect(Buffer.byteLength(first!.paths.socketPath, 'utf8')).toBeLessThan(80);
    expect(readFileSync(first!.paths.executablePath, 'utf8')).toBe('compiled-browser-helper-a');
    expect(readFileSync(first!.paths.installedPlistPath, 'utf8')).toContain(first!.paths.executablePath);

    const secondRelease = writeRelease('release-b', 'compiled-browser-helper-b-nondeterministic', 'browser-helper-contract-v1');
    expect(secondRelease.helperIdentity).not.toBe(firstRelease.helperIdentity);
    expect(secondRelease.helperContractIdentity).toBe(firstRelease.helperContractIdentity);
    const second = ensureBrowserAutomationLaunchAgentContract({ controllerHome: fx.home, accountHome });
    expect(second).toBeDefined();
    expect(second!.paths.executablePath).toBe(first!.paths.executablePath);
    expect(second!.artifactChanged).toBe(false);
    expect(second!.plistChanged).toBe(false);
    expect(second!.changed).toBe(false);
    expect(readFileSync(second!.paths.executablePath, 'utf8')).toBe('compiled-browser-helper-a');

    const changedRelease = writeRelease('release-c', 'compiled-browser-helper-c', 'browser-helper-contract-v2');
    expect(changedRelease.helperContractIdentity).not.toBe(firstRelease.helperContractIdentity);
    const third = ensureBrowserAutomationLaunchAgentContract({ controllerHome: fx.home, accountHome });
    expect(third!.artifactChanged).toBe(true);
    expect(third!.paths.executablePath).toBe(first!.paths.executablePath);
    expect(readFileSync(third!.paths.executablePath, 'utf8')).toBe('compiled-browser-helper-c');
  });

  test('starts the stable Browser Automation helper during release reconciliation and leaves an unchanged registered helper running', () => {
    const fx = fixture();
    const accountHome = join(fx.root, 'account-home-running');
    const releasesRoot = join(fx.home, 'runtime', 'releases');
    const releaseRoot = join(releasesRoot, 'release-helper-running');
    const helper = join(releaseRoot, 'browser-automation-helper');
    const runtime = join(releaseRoot, 'forge-runtime');
    const manifestPath = join(releaseRoot, 'manifest.json');
    mkdirSync(releaseRoot, { recursive: true });
    writeFileSync(helper, 'stable-helper');
    writeFileSync(runtime, 'runtime');
    const helperIdentity = `sha256:${createHash('sha256').update('stable-helper').digest('hex')}`;
    const helperContractIdentity = `sha256:${createHash('sha256').update('helper-source-v1').digest('hex')}`;
    writeFileSync(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      releaseId: 'release-helper-running',
      entrypoint: 'forge-runtime',
      controllerHome: fx.home,
      artifactIdentity: 'sha256:runtime-helper-running',
      arguments: [],
      browserAutomationHelperEntrypoint: 'browser-automation-helper',
      browserAutomationHelperArtifactIdentity: helperIdentity,
      browserAutomationHelperContractIdentity: helperContractIdentity,
    })}\n`);
    mkdirSync(join(fx.home, 'runtime', 'service'), { recursive: true });
    writeFileSync(join(fx.home, 'runtime', 'service', 'config.json'), `${JSON.stringify({
      schemaVersion: 1,
      controllerHome: fx.home,
      repositoryRoot: fx.repo,
      host: '127.0.0.1',
      port: 8765,
      authTokenFile:fx.token,
    })}\n`);
    writeFileSync(join(releasesRoot, 'authority.json'), `${JSON.stringify({
      schemaVersion: 1,
      status: 'committed',
      active: { releaseId: 'release-helper-running', manifestPath, artifactIdentity: 'sha256:runtime-helper-running' },
    })}\n`);

    let registered = false;
    const calls: string[][] = [];
    const runLaunchctl = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'print') return { ok: registered, stdout: '', stderr: registered ? '' : 'not found', status: registered ? 0 : 1 };
      if (args[0] === 'bootstrap') registered = true;
      if (args[0] === 'bootout') registered = false;
      return { ok: true, stdout: '', stderr: '', status: 0 };
    };

    const first = ensureBrowserAutomationLaunchAgentRunning(
      { controllerHome: fx.home, accountHome },
      { runLaunchctl, domain: 'gui/501' },
    );
    expect(first?.registered).toBe(true);
    expect(first?.restarted).toBe(true);
    expect(calls.some((args) => args[0] === 'bootstrap')).toBe(true);

    calls.length = 0;
    const second = ensureBrowserAutomationLaunchAgentRunning(
      { controllerHome: fx.home, accountHome },
      { runLaunchctl, domain: 'gui/501' },
    );
    expect(second?.registered).toBe(true);
    expect(second?.changed).toBe(false);
    expect(second?.restarted).toBe(false);
    expect(calls).toEqual([['print', `gui/501/${second!.paths.label}`]]);

    calls.length = 0;
    ensureForgeRuntimeLaunchAgentContract(
      { controllerHome: fx.home },
      { browserAutomationRunLaunchctl: runLaunchctl, browserAutomationDomain: 'gui/501', browserAutomationAccountHome: accountHome },
    );
    expect(calls).toEqual([['print', `gui/501/${second!.paths.label}`]]);
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
