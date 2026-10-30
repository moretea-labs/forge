import { expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { installLaunchAgent, launchAgentPath } from '../../src/cli/controller/launch-agents';

test.skipIf(process.platform === 'win32')('unchanged secure launchd plist keeps its inode; changed or unsafe targets are replaced', () => {
  const home = mkdtempSync(join(tmpdir(), 'forge-launchagent-idempotence-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const source = join(home, 'source.plist');
    const label = 'com.moretea.forge.test-idempotence';
    const target = launchAgentPath(label);
    writeFileSync(source, 'version-one');
    const original = installLaunchAgent(source, label);
    expect(original.content).toBeUndefined();
    const initial = lstatSync(target);
    expect(initial.isFile()).toBe(true);
    expect(initial.mode & 0o777).toBe(0o600);
    const reused = installLaunchAgent(source, label);
    expect(reused.content?.toString()).toBe('version-one');
    expect(lstatSync(target).ino).toBe(initial.ino);

    writeFileSync(source, 'version-two');
    installLaunchAgent(source, label);
    expect(readFileSync(target, 'utf8')).toBe('version-two');
    expect(lstatSync(target).ino).not.toBe(initial.ino);

    chmodSync(target, 0o644);
    installLaunchAgent(source, label);
    expect(lstatSync(target).mode & 0o777).toBe(0o600);

    rmSync(target);
    symlinkSync(source, target);
    installLaunchAgent(source, label);
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('version-two');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
