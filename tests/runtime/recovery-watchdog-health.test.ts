import { describe, expect, test } from 'bun:test';
import { observeRecoveryWatchdogHealth } from '../../src/runtime/standalone-recovery/watchdog-heartbeat';

describe('Recovery Watchdog profile-aware health', () => {
  test('disabled profiles ignore missing heartbeat state', () => {
    expect(observeRecoveryWatchdogHealth('/definitely/missing/recovery-home', false)).toEqual({
      ok: true,
      detail: 'Recovery Watchdog is disabled by the configured install profile',
    });
  });
});
