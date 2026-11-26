import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureForgeInstanceIdentity, listCanonicalGrants } from '../../packages/kernel/identity/api/index';
import { persistControllerAccessMode } from '../../adapters/mcp/access-mode';
import { requireHostFullAccess, executeAuthorizedHostCommand } from '../../adapters/mcp/runtime-gateway/process-tools';
import { requireHostProcessIdentity } from '../../src/runtime/execution/process-runtime/host-command-lane';
import { setHostBuildCpuProbeForTest } from '../../src/runtime/resources/leases/host-build-admission';

const dirs: string[] = [];
function fixture(): string {
  const home = mkdtempSync(join(tmpdir(), 'forge-host-permission-'));
  dirs.push(home);
  ensureForgeInstanceIdentity({ controllerHome: home, preferredInstanceId: 'forge_full_access_test' });
  return home;
}
afterEach(() => {
  setHostBuildCpuProbeForTest(undefined);
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('single host command authority', () => {
  test('host argv and shell builds cannot bypass pressure admission or spawn a child', async () => {
    const home = fixture();
    persistControllerAccessMode(home, 'full_access');
    setHostBuildCpuProbeForTest(() => ({ cpus: 10, load: 31 }));
    const marker = join(home, 'spawned');
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const build = join(bin, 'xcodebuild');
    writeFileSync(build, `#!/bin/sh\nprintf spawned > '${marker}'\n`, { mode: 0o700 });
    const bun = join(bin, 'bun');
    writeFileSync(bun, `#!/bin/sh\nprintf spawned > '${marker}'\n`, { mode: 0o700 });
    for (const args of [
      { command: [build, 'build'] },
      { shell_command: `'${build}' build` },
      { command: [bun, 'test'] },
      { command: [bun, 'run', 'check:main'] },
    ]) {
      const result = await executeAuthorizedHostCommand(
        { controllerHome: home, principalId: 'controller-http-client' } as any,
        { ...args, cwd: home },
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('HOST_RESOURCE_PRESSURE');
      expect(existsSync(marker)).toBe(false);
    }
    const ordinary = await executeAuthorizedHostCommand(
      { controllerHome: home, principalId: 'controller-http-client' } as any,
      { command: ['/bin/echo', 'ordinary work continues'], cwd: home },
    );
    expect(ordinary.isError).not.toBe(true);
  });
  test('explicit existing Full Access permits host execution without a second Grant', () => {
    const home = fixture();
    persistControllerAccessMode(home, 'full_access');
    expect(() => requireHostFullAccess(home, 'controller-http-client')).not.toThrow();
    expect(requireHostProcessIdentity(home, 'controller-http-client')).toEqual({
      forgeInstanceId: 'forge_full_access_test',
    });
    expect(listCanonicalGrants(home)).toHaveLength(0);
  });

  test('legacy/default Full Access is not permission enrollment', () => {
    const home = fixture();
    expect(() => requireHostFullAccess(home, 'controller-http-client')).toThrow('HOST_FULL_ACCESS_REQUIRED');
    expect(listCanonicalGrants(home)).toHaveLength(0);
  });

  test('Request mode and missing principal fail before execution', () => {
    const home = fixture();
    persistControllerAccessMode(home, 'request');
    expect(() => requireHostFullAccess(home, 'controller-http-client')).toThrow('HOST_FULL_ACCESS_REQUIRED');
    persistControllerAccessMode(home, 'full_access');
    expect(() => requireHostFullAccess(home, '')).toThrow('HOST_PROCESS_PRINCIPAL_REQUIRED');
    expect(() => requireHostProcessIdentity(home, '')).toThrow('HOST_PROCESS_PRINCIPAL_REQUIRED');
  });

  test('a real host process executes using Full Access without a second Grant', async () => {
    const home = fixture();
    persistControllerAccessMode(home, 'full_access');
    const result = await executeAuthorizedHostCommand(
      { controllerHome: home, principalId: 'controller-http-client' } as any,
      { command: ['/bin/echo', 'HOST_FULL_ACCESS_OK'], cwd: home, interactive_wait_ms: 8000 },
    );
    expect(result.isError).not.toBe(true);
    const body = result.structuredContent as any;
    expect(body?.target?.forgeInstanceId).toBe('forge_full_access_test');
    expect(body?.process?.stdout ?? body?.process?.stdoutTail ?? '').toContain('HOST_FULL_ACCESS_OK');
    expect(listCanonicalGrants(home)).toHaveLength(0);
  });

  test('an unconfirmed setting refuses the real host action', async () => {
    const home = fixture();
    const result = await executeAuthorizedHostCommand(
      { controllerHome: home, principalId: 'controller-http-client' } as any,
      { command: ['/bin/echo', 'MUST_NOT_RUN'], cwd: home },
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('HOST_FULL_ACCESS_REQUIRED');
    expect(listCanonicalGrants(home)).toHaveLength(0);
  });

  test('missing ForgeInstance does not synthesize a host identity', () => {
    const missing = mkdtempSync(join(tmpdir(), 'forge-no-host-identity-'));
    dirs.push(missing);
    persistControllerAccessMode(missing, 'full_access');
    expect(() => requireHostFullAccess(missing, 'controller-http-client')).not.toThrow();
    expect(() => requireHostProcessIdentity(missing, 'controller-http-client')).toThrow(
      'HOST_PROCESS_TARGET_UNAVAILABLE',
    );
  });
});
