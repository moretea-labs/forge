import { describe, expect, test } from 'bun:test';
import {
  fillForgeVaultPasswordInComputer,
  lockAllForgeVaultComputerSessions,
} from '../../src/runtime/safe-tooling/forge-local-vault-computer';

describe('Forge Computer local-vault secret boundary preflight', () => {
  test('native Apple Events is refused before reading registration, grant or Keychain', async () => {
    const input = {
      controllerHome: '/untrusted-no-controller-home',
      credentialRef: 'credref:v1:fake-not-real',
      origin: 'https://login.example.test',
      account: 'synthetic@example.test',
      selector: '#password',
      usernameSelector: '#username',
      page: {
        url: () => 'https://login.example.test/login',
        evaluate: async () => { throw new Error('must not inspect DOM'); },
        fill: async () => { throw new Error('must not fill'); },
      },
      browserProvider: 'macos-apple-events',
    };
    await expect(fillForgeVaultPasswordInComputer(input)).rejects.toMatchObject({
      code: 'FORGE_VAULT_NATIVE_BROWSER_UNSAFE',
    });
    lockAllForgeVaultComputerSessions();
  });
  test('unsupported host refuses before any Keychain or browser mutation', async () => {
    if (process.platform === 'darwin') return;
    const input = {
      controllerHome: '/untrusted-no-controller-home',
      credentialRef: 'credref:v1:fake-not-real',
      origin: 'https://login.example.test',
      account: 'synthetic@example.test',
      selector: '#password',
      usernameSelector: '#username',
      page: {
        url: () => 'https://login.example.test/login',
        evaluate: async () => { throw new Error('must not inspect DOM'); },
        fill: async () => { throw new Error('must not fill'); },
      },
      browserProvider: 'playwright',
    };
    await expect(fillForgeVaultPasswordInComputer(input)).rejects.toMatchObject({
      code: 'FORGE_VAULT_DEVICE_PLATFORM_UNSUPPORTED',
    });
  });
});
