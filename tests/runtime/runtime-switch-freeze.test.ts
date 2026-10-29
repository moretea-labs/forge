import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { rollbackPrevious } from '../../src/runtime/standalone-recovery/core';
import { publishRuntimeRelease, rollbackRuntimeReleaseWithResult } from '../../src/runtime/root/release-store';
import { assertRuntimeSwitchNotFrozen, runtimeSwitchFreezePath } from '../../src/runtime/root/runtime-switch-freeze';
import type { RecoveryConfig } from '../../src/runtime/standalone-recovery/recovery-shared';

const homes: string[] = [];
afterEach(() => { while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true }); });

function freeze(): string {
  const home = mkdtempSync(join(tmpdir(), 'forge-runtime-switch-freeze-'));
  homes.push(home);
  const marker = runtimeSwitchFreezePath(home);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, JSON.stringify({ schemaVersion: 1, frozen: true, reason: 'User authorization required' }));
  return home;
}

describe('Runtime switch freeze', () => {
  test('blocks all version-changing Recovery actions, but not same-release restart and staging', () => {
    const home = freeze();
    for (const action of [
      'activate_runtime_release', 'rollback_previous', 'recover_primary_runtime',
      'release_session_cutover', 'release_session_rollback', 'release_session_known_good',
    ]) {
      expect(() => assertRuntimeSwitchNotFrozen(home, action)).toThrow('RUNTIME_SWITCH_FROZEN_USER_AUTHORIZATION_REQUIRED');
    }
    for (const action of ['restart_primary_runtime', 'release_session_prepare', 'release_session_candidate_boot', 'restart_primary_connector']) {
      expect(() => assertRuntimeSwitchNotFrozen(home, action)).not.toThrow();
    }
  });

  test('enforces freeze before acquiring the Recovery mutation lock or performing rollback', async () => {
    const home = freeze();
    const config = { schemaVersion: 1, controllerHome: home, installProfile: 'manual' } as RecoveryConfig;
    await expect(rollbackPrevious(config)).rejects.toThrow('RUNTIME_SWITCH_FROZEN_USER_AUTHORIZATION_REQUIRED');
    expect(() => publishRuntimeRelease(home, join(home, 'nonexistent-manifest.json'), 'test-publish')).toThrow('RUNTIME_SWITCH_FROZEN_USER_AUTHORIZATION_REQUIRED');
    expect(() => rollbackRuntimeReleaseWithResult(home, 'test-rollback')).toThrow('RUNTIME_SWITCH_FROZEN_USER_AUTHORIZATION_REQUIRED');
  });
});
