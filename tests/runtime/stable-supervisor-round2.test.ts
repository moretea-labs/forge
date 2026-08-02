import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { publishSupervisorRelease } from '../../src/runtime/supervisor/installer';
import { supervisorReleasesRoot } from '../../src/runtime/supervisor/paths';
import { SupervisorProcessManager } from '../../src/runtime/supervisor/process-manager';
import type { ProcessIdentityProbe } from '../../src/runtime/supervisor/identity';

function currentHead(): string {
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`git rev-parse HEAD failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function fakeRelease(controllerHome: string, sourceRoot: string, sourceCommit: string): string {
  const releasePath = join(supervisorReleasesRoot(controllerHome), 'round2-source-root');
  mkdirSync(releasePath, { recursive: true });
  for (const entry of ['supervisor.js', 'repo-harness.js', 'daemon.js', 'worker.js', 'process-runner.js', 'browser-handoff-host.js', 'browser-node-bridge-host.js']) {
    writeFileSync(join(releasePath, entry), '# fixture\n');
  }
  writeFileSync(join(releasePath, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 2,
    releaseRevision: sourceCommit,
    sourceCommit,
    sourceRoot,
    cleanWorkspace: true,
  })}\n`);
  return releasePath;
}

describe('Stable Supervisor round-two recovery boundaries', () => {
  test('normalizes an external same-revision worktree to the authoritative repo root', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-round2-source-root-'));
    const externalSource = mkdtempSync(join(tmpdir(), 'repo-harness-round2-external-runtime-'));
    try {
      mkdirSync(join(externalSource, 'src', 'runtime', 'control-plane'), { recursive: true });
      writeFileSync(join(externalSource, 'package.json'), '{"name":"@moretea-labs/repo-harness-controller"}\n');
      writeFileSync(join(externalSource, 'src', 'runtime', 'control-plane', 'daemon-entry.ts'), 'export {};\n');
      const releasePath = fakeRelease(controllerHome, externalSource, currentHead());
      const published = publishSupervisorRelease({
        controllerHome,
        repoRoot: process.cwd(),
        releasePath,
        allowUnreproducibleReleaseForTests: true,
      });
      const plist = readFileSync(published.launchdPlistPath, 'utf8');
      expect(plist).toContain(process.cwd());
      expect(plist).not.toContain(externalSource);
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
      rmSync(externalSource, { recursive: true, force: true });
    }
  });

  test('candidate preflight reclaims same-epoch daemon duplicates but preserves the adopted PID', async () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-round2-daemon-duplicates-'));
    const slotHome = join(home, 'runtime-slots', 'blue');
    const daemon = join(home, 'supervisor', 'releases', 'round2', 'daemon.js');
    mkdirSync(join(home, 'supervisor', 'releases', 'round2'), { recursive: true });
    const commands = new Map<number, { command: string; startTime: string }>([
      [61001, {
        command: `${process.execPath} ${daemon} --controller-home ${slotHome} --runtime-source-root ${process.cwd()} --owner-epoch 10 --instance-id daemon-adopted --slot blue`,
        startTime: 'Tue Jul 28 01:00:00 2026',
      }],
      [61002, {
        command: `${process.execPath} ${daemon} --controller-home ${slotHome} --runtime-source-root ${process.cwd()} --owner-epoch 10 --instance-id daemon-duplicate --slot blue`,
        startTime: 'Tue Jul 28 01:01:00 2026',
      }],
      [61003, {
        command: `${process.execPath} ${daemon} --controller-home ${slotHome} --runtime-source-root ${process.cwd()} --owner-epoch 11 --instance-id daemon-future --slot blue`,
        startTime: 'Tue Jul 28 01:02:00 2026',
      }],
    ]);
    const probe: ProcessIdentityProbe = {
      isAlive: (pid) => commands.has(pid),
      command: (pid) => commands.get(pid)?.command,
      startTime: (pid) => commands.get(pid)?.startTime,
      listProcesses: () => Array.from(commands.entries()).map(([pid, entry]) => ({ pid, command: entry.command })),
    };
    const manager = new SupervisorProcessManager({
      repoRoot: process.cwd(),
      controllerHome: home,
      runtimeSourceRoot: process.cwd(),
      ownerEpoch: 10,
      logPath: join(home, 'supervisor.log'),
      slot: 'blue',
      identityProbe: probe,
    });

    try {
      const result = await manager.cleanupStaleSlotDaemons('blue', { reason: 'round2_same_epoch_preflight' }, {
        includeCurrentOwnerEpoch: true,
        preservePids: new Set([61001]),
      });
      expect(result.matched).toBe(2);
      expect(result.stopped).toBe(1);
      expect(result.failed).toBe(0);
      expect(commands.has(61001)).toBe(true);
      expect(commands.has(61002)).toBe(true);
      expect(result.refused).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
