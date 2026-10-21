import { spawnSync } from 'child_process';

/**
 * macOS security(1) explicitly calls -w <password> insecure. Its interactive
 * command reader accepts the write through stdin, so the secret never appears
 * in the child's argv. No output is retained: security -i can echo commands.
 * This is an I/O primitive for the existing Keychain, not another secret store.
 */
export function writeMacKeychainGenericPassword(
  service: string,
  account: string,
  value: string,
  keychainPath?: string,
): void {
  if (process.platform !== 'darwin') throw new Error('MAC_KEYCHAIN_UNAVAILABLE');
  const quote = (input: string): string => {
    if (!input || /[\x00-\x1f\x7f]/.test(input)) throw new Error('MAC_KEYCHAIN_ARGUMENT_INVALID');
    return '"' + input.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
  };
  const command = [
    'add-generic-password', '-U',
    '-s', quote(service),
    '-a', quote(account),
    '-w', quote(value),
    ...(keychainPath ? [quote(keychainPath)] : []),
  ].join(' ') + '\n';
  const outcome = spawnSync('/usr/bin/security', ['-i'], {
    input: command,
    encoding: 'utf8',
    stdio: ['pipe', 'ignore', 'ignore'],
    timeout: 5_000,
  });
  if (outcome.error || outcome.signal || outcome.status !== 0) {
    throw new Error('MAC_KEYCHAIN_WRITE_FAILED');
  }
  // security -i may exit 0 even when add-generic-password fails. Its command
  // output can echo the secret, so it stays suppressed. Verify the exact value
  // against the same Keychain; never expose readback to logs, errors or callers.
  const observed = spawnSync('/usr/bin/security', [
    'find-generic-password', '-s', service, '-a', account, '-w',
    ...(keychainPath ? [keychainPath] : []),
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
  });
  if (observed.error || observed.signal || observed.status !== 0
    || typeof observed.stdout !== 'string'
    || observed.stdout.replace(/\r?\n$/, '') !== value) {
    throw new Error('MAC_KEYCHAIN_WRITE_FAILED');
  }
}
