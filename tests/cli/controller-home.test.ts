import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
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
import { forgeRuntimeServicePaths } from '../../src/runtime/root/service';
import { runtimeReleaseAuthorityPath } from '../../src/runtime/root/release-store';
import { createRecoveryConfig } from '../../src/runtime/standalone-recovery/core';
import {
  linuxControllerHomeMigrationSystemdRunArgs,
  readLinuxControllerHomeMigrationReceipt,
  runLinuxControllerHomeMigrationRequest,
  scheduleLinuxControllerHomeMigration,
  type ControllerHomeMigrationServiceObservation,
  type LinuxControllerHomeMigrationRequest,
} from '../../src/runtime/standalone-recovery/controller-home-migration';

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

const migrationRoots: string[] = [];

function observation(base: number): ControllerHomeMigrationServiceObservation {
  return {
    runtimePid: base + 1,
    connectorPid: base + 2,
    recoveryGatewayPid: base + 3,
    recoveryWatchdogPid: base + 4,
  };
}

function fixture(options: { destinationShell?: boolean } = {}): {
  root: string;
  source: string;
  destination: string;
  repo: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'forge-controller-home-transaction-'));
  migrationRoots.push(root);
  const source = join(root, 'old-controller');
  const destination = join(root, 'new-controller');
  const repo = join(root, 'forge-source');
  const token = join(source, 'runtime-token.json');
  const recoveryToken = join(source, 'recovery-token.json');
  mkdirSync(source, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(source, 'sentinel.txt'), 'source-authority\n');
  writeFileSync(token, '{}\n');
  writeFileSync(recoveryToken, '{}\n');
  const runtimePaths = forgeRuntimeServicePaths(source);
  mkdirSync(runtimePaths.serviceRoot, { recursive: true });
  writeFileSync(runtimePaths.configPath, `${JSON.stringify({
    schemaVersion: 1,
    controllerHome: source,
    repositoryRoot: repo,
    host: '127.0.0.1',
    port: 8765,
    authTokenFile: token,
  }, null, 2)}\n`);
  createRecoveryConfig(source, {
    primaryRuntimeSourceRoot: repo,
    primaryRuntimeService: { platform: 'systemd-user' },
    gateway: { host: '127.0.0.1', port: 8787, bearerTokenFile: recoveryToken },
  });
  if (options.destinationShell) {
    mkdirSync(join(destination, 'source-baseline'), { recursive: true });
    writeFileSync(join(destination, 'source-baseline', 'current.json'), '{}\n');
  }
  return { root, source, destination, repo };
}

function schedule(
  fx: ReturnType<typeof fixture>,
  extra: Parameters<typeof scheduleLinuxControllerHomeMigration>[1] = {},
) {
  return scheduleLinuxControllerHomeMigration({
    sourceHome: fx.source,
    destinationHome: fx.destination,
    timeoutMs: 30_000,
  }, {
    platform: 'linux',
    systemdAvailable: () => true,
    systemdPid: () => undefined,
    uuid: () => '11111111-2222-3333-4444-555555555555',
    packageExecutable: () => process.execPath,
    spawnWorker: () => undefined,
    ...extra,
  });
}

afterEach(() => {
  while (migrationRoots.length > 0) rmSync(migrationRoots.pop()!, { recursive: true, force: true });
});

describe('Linux Controller Home migration transaction', () => {
  test('hands off to a restartable transient systemd worker before touching live source services', () => {
    const fx = fixture();
    let handedOff: LinuxControllerHomeMigrationRequest | undefined;
    const scheduled = schedule(fx, {
      systemdPid: () => 4242,
      spawnWorker: (request) => { handedOff = request; },
    });

    expect(handedOff?.operationId).toBe(scheduled.request.operationId);
    expect(scheduled.preflight.liveOwners.length).toBe(4);
    expect(existsSync(fx.source)).toBe(true);
    expect(existsSync(fx.destination)).toBe(false);
    expect(readLinuxControllerHomeMigrationReceipt(scheduled.request.receiptPath)?.status).toBe('scheduled');

    const args = linuxControllerHomeMigrationSystemdRunArgs(scheduled.request);
    expect(args).toContain('--collect');
    expect(args).toContain('--property=Restart=on-failure');
    expect(args).toContain('--unit=forge-controller-home-migration-worker');
    expect(args.some((value) => value.startsWith('--setenv=PATH='))).toBe(true);
    expect(args).toContain(`--property=StandardOutput=append:${scheduled.request.logPath}`);
    expect(args).toContain(process.execPath);
    expect(args).toContain(scheduled.request.workerLauncherPath);
    expect(args).toContain(scheduled.request.requestPath);
    expect(existsSync(scheduled.request.workerLauncherPath)).toBe(true);
    expect(args.some((value) => value.includes(fx.source))).toBe(false);
    expect(args.some((value) => value.includes(fx.destination))).toBe(false);
  });

  test('systemd restart bootstrap survives relocation because its launcher is outside both Controller Homes', () => {
    const fx = fixture();
    const packageRoot = join(fx.source, 'runtime', 'releases', 'worker-fixture', 'package');
    const fakeCli = join(packageRoot, 'src', 'cli', 'index.ts');
    mkdirSync(join(packageRoot, 'src', 'cli'), { recursive: true });
    writeFileSync(fakeCli, `import { writeFileSync } from 'fs';\nwriteFileSync(process.env.FORGE_TEST_WORKER_MARKER!, JSON.stringify(process.argv.slice(2)));\n`);
    const runtimeConfigPath = forgeRuntimeServicePaths(fx.source).configPath;
    const runtimeConfig = JSON.parse(readFileSync(runtimeConfigPath, 'utf8'));
    runtimeConfig.repositoryRoot = packageRoot;
    writeFileSync(runtimeConfigPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`);

    const scheduled = schedule(fx);
    relocateStoppedControllerHomeAuthority({
      sourceHome: fx.source,
      destinationHome: fx.destination,
      archiveExistingDestination: false,
      archiveSuffix: scheduled.request.archiveSuffix,
    });
    expect(existsSync(fx.source)).toBe(false);
    expect(existsSync(scheduled.request.workerLauncherPath)).toBe(true);

    const marker = join(fx.root, 'worker-launch-marker.json');
    const launched = spawnSync(process.execPath, [scheduled.request.workerLauncherPath, scheduled.request.requestPath], {
      encoding: 'utf8',
      timeout: 5_000,
      env: { ...process.env, FORGE_TEST_WORKER_MARKER: marker },
    });
    expect(launched.status).toBe(0);
    expect(launched.stderr).toBe('');
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual([
      'recovery', 'migrate-controller-home-worker', '--request', scheduled.request.requestPath,
    ]);
  });

  test('continues after the initiating MCP call is gone and commits exactly one four-service destination set', async () => {
    const fx = fixture();
    const events: string[] = [];
    const scheduled = schedule(fx, { spawnWorker: () => events.push('handoff') });
    expect(events).toEqual(['handoff']);

    // The initiating CLI/MCP request is intentionally no longer involved here.
    // The durable worker consumes only its request file and owns the transaction.
    const receipt = await runLinuxControllerHomeMigrationRequest(scheduled.request.requestPath, {
      platform: 'linux',
      systemdAvailable: () => true,
      systemdPid: () => undefined,
      stopServices: async (home) => { events.push(`stop:${home}`); },
      installServices: async (home) => { events.push(`install:${home}`); },
      verifyServices: async (home) => {
        events.push(`verify:${home}`);
        return observation(home === fx.destination ? 100 : 200);
      },
    });

    expect(receipt.status).toBe('committed');
    expect(receipt.phase).toBe('complete');
    expect(receipt.destinationServices).toEqual(observation(100));
    expect(new Set(Object.values(receipt.destinationServices!)).size).toBe(4);
    expect(existsSync(fx.source)).toBe(false);
    expect(readFileSync(join(fx.destination, 'sentinel.txt'), 'utf8')).toContain('source-authority');
    expect(events).toEqual([
      'handoff',
      `stop:${fx.source}`,
      `install:${fx.destination}`,
      `verify:${fx.destination}`,
    ]);
  });

  test('preserves source Runtime authority bytes as evidence while publishing one destination authority', async () => {
    const fx = fixture();
    const sourceAuthorityPath = runtimeReleaseAuthorityPath(fx.source);
    mkdirSync(dirname(sourceAuthorityPath), { recursive: true });
    const sourceAuthority = `${JSON.stringify({ marker: 'source-authority', active: { manifestPath: join(fx.source, 'runtime', 'releases', 'source-release', 'manifest.json') } }, null, 2)}\n`;
    writeFileSync(sourceAuthorityPath, sourceAuthority);
    const scheduled = schedule(fx);
    const destinationAuthority = `${JSON.stringify({ marker: 'destination-authority', active: { manifestPath: join(fx.destination, 'runtime', 'releases', 'destination-release', 'manifest.json') } }, null, 2)}\n`;

    const receipt = await runLinuxControllerHomeMigrationRequest(scheduled.request.requestPath, {
      platform: 'linux', systemdAvailable: () => true, systemdPid: () => undefined,
      stopServices: async () => undefined,
      installServices: async (home) => { if (home === fx.destination) writeFileSync(runtimeReleaseAuthorityPath(home), destinationAuthority); },
      verifyServices: async () => observation(250),
    });

    expect(receipt.status).toBe('committed');
    expect(readFileSync(runtimeReleaseAuthorityPath(fx.destination), 'utf8')).toBe(destinationAuthority);
    const evidenceRoot = join(fx.destination, 'runtime', 'releases', 'migration-evidence', scheduled.request.operationId);
    expect(readFileSync(join(evidenceRoot, 'source-authority.json'), 'utf8')).toBe(sourceAuthority);
    expect(existsSync(join(evidenceRoot, 'destination-authority.json'))).toBe(false);
  });

  test('restores source Runtime authority bytes and archives rejected destination authority on rollback', async () => {
    const fx = fixture();
    const sourceAuthorityPath = runtimeReleaseAuthorityPath(fx.source);
    mkdirSync(dirname(sourceAuthorityPath), { recursive: true });
    const sourceAuthority = `${JSON.stringify({ marker: 'source-before-rollback', active: { manifestPath: join(fx.source, 'runtime', 'releases', 'source-release', 'manifest.json') } }, null, 2)}\n`;
    writeFileSync(sourceAuthorityPath, sourceAuthority);
    const scheduled = schedule(fx);
    const rejectedAuthority = `${JSON.stringify({ marker: 'rejected-destination', active: { manifestPath: join(fx.destination, 'runtime', 'releases', 'destination-release', 'manifest.json') } }, null, 2)}\n`;

    const receipt = await runLinuxControllerHomeMigrationRequest(scheduled.request.requestPath, {
      platform: 'linux', systemdAvailable: () => true, systemdPid: () => undefined,
      stopServices: async () => undefined,
      installServices: async (home) => { if (home === fx.destination) writeFileSync(runtimeReleaseAuthorityPath(home), rejectedAuthority); },
      verifyServices: async (home) => { if (home === fx.destination) throw new Error('upstream 502 after destination authority publish'); return observation(275); },
    });

    expect(receipt.status).toBe('rolled_back');
    expect(readFileSync(runtimeReleaseAuthorityPath(fx.source), 'utf8')).toBe(sourceAuthority);
    const evidenceRoot = join(fx.source, 'runtime', 'releases', 'migration-evidence', scheduled.request.operationId);
    expect(readFileSync(join(evidenceRoot, 'destination-authority.json'), 'utf8')).toBe(rejectedAuthority);
    expect(existsSync(join(evidenceRoot, 'source-authority.json'))).toBe(false);
  });

  test('rolls authority and services back automatically when destination verification reproduces upstream 502', async () => {
    const fx = fixture({ destinationShell: true });
    const installed: string[] = [];
    const stopped: string[] = [];
    const scheduled = schedule(fx);

    const receipt = await runLinuxControllerHomeMigrationRequest(scheduled.request.requestPath, {
      platform: 'linux',
      systemdAvailable: () => true,
      systemdPid: () => undefined,
      stopServices: async (home) => { stopped.push(home); },
      installServices: async (home) => { installed.push(home); },
      verifyServices: async (home) => {
        if (home === fx.destination) {
          throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_DESTINATION_UNHEALTHY: upstream 502');
        }
        return observation(300);
      },
    });

    expect(receipt.status).toBe('rolled_back');
    expect(receipt.error).toContain('502');
    expect(receipt.restoredSourceServices).toEqual(observation(300));
    expect(readFileSync(join(fx.source, 'sentinel.txt'), 'utf8')).toContain('source-authority');
    expect(readFileSync(join(fx.destination, 'source-baseline', 'current.json'), 'utf8')).toContain('{}');
    expect(installed).toEqual([fx.destination, fx.source]);
    expect(stopped).toEqual([fx.source, fx.destination, fx.source]);
  });

  test('rollback restores the exact pre-cutover Runtime authority bytes instead of republishing from the Recovery worker', async () => {
    const fx = fixture();
    const authorityPath = join(fx.source, 'runtime', 'releases', 'authority.json');
    const manifestPath = join(fx.source, 'runtime', 'releases', 'original', 'manifest.json');
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, '{}\n');
    const originalAuthority = `${JSON.stringify({ schemaVersion: 1, status: 'committed', active: { manifestPath }, fencingToken: 'original-fence' }, null, 2)}\n`;
    writeFileSync(authorityPath, originalAuthority);
    const scheduled = schedule(fx);

    const receipt = await runLinuxControllerHomeMigrationRequest(scheduled.request.requestPath, {
      platform: 'linux',
      systemdAvailable: () => true,
      systemdPid: () => undefined,
      stopServices: async () => undefined,
      installServices: async (home) => {
        if (home === fx.destination) {
          writeFileSync(join(home, 'runtime', 'releases', 'authority.json'), `${JSON.stringify({ schemaVersion: 1, status: 'committed', active: { manifestPath: join(home, 'runtime', 'releases', 'new', 'manifest.json') }, fencingToken: 'destination-fence' })}\n`);
          return;
        }
        expect(readFileSync(join(home, 'runtime', 'releases', 'authority.json'), 'utf8')).toBe(originalAuthority);
      },
      verifyServices: async (home) => {
        if (home === fx.destination) throw new Error('upstream 502 after destination Runtime publication');
        return observation(350);
      },
    });

    expect(receipt.status).toBe('rolled_back');
    expect(readFileSync(authorityPath, 'utf8')).toBe(originalAuthority);
  });

  test('a replacement transient worker sees an interrupted running receipt and fail-closes to the old authority', async () => {
    const fx = fixture();
    const scheduled = schedule(fx);
    const relocation = relocateStoppedControllerHomeAuthority({
      sourceHome: fx.source,
      destinationHome: fx.destination,
      archiveExistingDestination: false,
      archiveSuffix: scheduled.request.archiveSuffix,
    });
    expect(relocation.migrated).toBe(true);
    const running = {
      ...JSON.parse(readFileSync(scheduled.request.receiptPath, 'utf8')),
      status: 'running',
      phase: 'installing_destination',
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(scheduled.request.receiptPath, `${JSON.stringify(running, null, 2)}\n`);

    const receipt = await runLinuxControllerHomeMigrationRequest(scheduled.request.requestPath, {
      platform: 'linux',
      systemdAvailable: () => true,
      systemdPid: () => undefined,
      stopServices: async () => undefined,
      installServices: async () => undefined,
      verifyServices: async (home) => observation(home === fx.source ? 400 : 500),
    });

    expect(receipt.status).toBe('rolled_back');
    expect(receipt.error).toContain('previous migration worker exited');
    expect(receipt.restoredSourceServices).toEqual(observation(400));
    expect(existsSync(fx.destination)).toBe(false);
    expect(readFileSync(join(fx.source, 'sentinel.txt'), 'utf8')).toContain('source-authority');
  });

  test('overall timeout after relocation triggers the same automatic source restoration', async () => {
    const fx = fixture();
    const scheduled = schedule(fx);
    let clock = 0;
    const receipt = await runLinuxControllerHomeMigrationRequest(scheduled.request.requestPath, {
      platform: 'linux',
      systemdAvailable: () => true,
      systemdPid: () => undefined,
      now: () => clock,
      stopServices: async () => undefined,
      installServices: async (home) => { if (home === fx.destination) clock = 30_001; },
      verifyServices: async () => observation(600),
    });

    expect(receipt.status).toBe('rolled_back');
    expect(receipt.error).toContain('RECOVERY_CONTROLLER_HOME_MIGRATION_TIMEOUT');
    expect(existsSync(fx.destination)).toBe(false);
    expect(readFileSync(join(fx.source, 'sentinel.txt'), 'utf8')).toContain('source-authority');
  });

  test('rejects nested source/destination paths before handing off a worker', () => {
    const fx = fixture();
    let spawned = false;
    expect(() => scheduleLinuxControllerHomeMigration({ sourceHome: fx.source, destinationHome: join(fx.source, 'nested-controller-home') }, {
      platform: 'linux', systemdAvailable: () => true, systemdPid: () => undefined,
      spawnWorker: () => { spawned = true; },
    })).toThrow('RECOVERY_CONTROLLER_HOME_MIGRATION_OVERLAPPING_HOMES');
    expect(spawned).toBe(false);
  });

  test('macOS rejects scheduling and worker execution before any migration evidence or Recovery state is mutated', async () => {
    const fx = fixture();
    let spawned = false;
    expect(() => scheduleLinuxControllerHomeMigration({
      sourceHome: fx.source,
      destinationHome: fx.destination,
    }, {
      platform: 'darwin',
      spawnWorker: () => { spawned = true; },
    })).toThrow('RECOVERY_CONTROLLER_HOME_MIGRATION_LINUX_ONLY');
    expect(spawned).toBe(false);
    expect(existsSync(join(dirname(fx.destination), 'controller-home-migrations'))).toBe(false);
    expect(existsSync(fx.source)).toBe(true);
    await expect(runLinuxControllerHomeMigrationRequest('/definitely/not/a/request.json', { platform: 'darwin' }))
      .rejects.toThrow('RECOVERY_CONTROLLER_HOME_MIGRATION_LINUX_ONLY');
  });
});
