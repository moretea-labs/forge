import { describe, expect, test } from 'bun:test';
import { assertRepositoryCommandStableHostIdentity } from '../../src/cli/repositories/command-scope';

describe('repository command stable macOS host identity', () => {
  test('rejects direct and shell-wrapped TCC-sensitive tools', () => {
    const denied: Array<string | string[]> = [
      ['/usr/bin/osascript', '-e', 'tell application "Google Chrome" to get URL of active tab of front window'],
      ['/usr/sbin/screencapture', '-x', 'capture.png'],
      `osascript <<'APPLESCRIPT'\ntell application "Google Chrome" to get URL of active tab of front window\nAPPLESCRIPT`,
      ['bash', '-lc', `osascript <<'APPLESCRIPT'\ntell application "Google Chrome" to get URL of active tab of front window\nAPPLESCRIPT`],
      ['zsh', '-c', '/usr/sbin/screencapture -x capture.png'],
    ];

    for (const command of denied) {
      expect(() => assertRepositoryCommandStableHostIdentity(command)).toThrow(/COMMAND_POLICY_DENIED: .*macOS TCC-sensitive.*stable Forge Desktop Operator\/browser capability/);
    }
  });

  test('does not reject ordinary repository text searches that mention TCC tools', () => {
    expect(assertRepositoryCommandStableHostIdentity(['rg', '-n', 'osascript|screencapture', 'src']).kind).toBe('argv');
    expect(assertRepositoryCommandStableHostIdentity('rg -n "osascript|screencapture" src').kind).toBe('shell');
  });

  test('keeps non-TCC typed eval available to Process Runtime policy', () => {
    expect(assertRepositoryCommandStableHostIdentity(['bun', '-e', 'console.log("ok")']).kind).toBe('argv');
  });
});
