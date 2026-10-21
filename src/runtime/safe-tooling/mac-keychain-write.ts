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
}
