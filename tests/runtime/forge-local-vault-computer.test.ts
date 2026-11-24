import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authorizeCredentialUse,
  revokeCredentialUse,
} from '../../src/runtime/safe-tooling/managed-credential-authorization';
import {
  attachForgeLocalVaultNativeOwner,
  assertForgeLocalVaultUnlocked,
  fillForgeVaultPasswordInComputer,
  lockAllForgeVaultComputerSessions,
  type ForgeLocalVaultNativeOwner,
} from '../../src/runtime/safe-tooling/forge-local-vault-computer';

const dirs: string[] = [];
afterEach(() => {
  lockAllForgeVaultComputerSessions();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function fixture() {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-vault-boundary-'));
  dirs.push(controllerHome);
  const origin = 'https://login.example.test';
  const account = 'synthetic@example.test';
  const credentialRef = 'credref:v1:fixture-only-not-a-secret';
  const input = {
    controllerHome,
    origin,
    account,
    credentialRef,
    selector: '#password',
    usernameSelector: '#username',
    page: {
      url: () => origin + '/login',
      evaluate: async <T>(): Promise<T> => {
        throw new Error('unexpected DOM read');
      },
      fill: async () => {
        throw new Error('unexpected mutation');
      },
    },
    browserProvider: 'playwright',
  };
  const authorize = (provider: 'forge_local_vault' | 'browser_password_manager' = 'forge_local_vault') =>
    authorizeCredentialUse({
      controllerHome,
      credentialRef,
      endpoint: origin,
      provider,
      account,
      confirmAuthorization: true,
    });
  return { input, authorize };
}
function mockOwner(unlocked: boolean) {
  let ready = unlocked;
  let calls = 0;
  const owner: ForgeLocalVaultNativeOwner = {
    isUnlocked: () => ready,
    lock: () => {
      ready = false;
    },
    fillAuthorizedForm: async (input) => {
      calls++;
      const proof = input.verifyCanonicalGrant({
        credentialRef: input.credentialRef,
        endpoint: input.origin,
        account: input.account,
        provider: 'forge_local_vault',
      });
      expect(proof.provider).toBe('forge_local_vault');
      return {
        fillDispatched: true,
        accountFieldFilled: false,
        passwordFieldFilled: true,
        formSubmitted: false,
        unexpectedPrivateValue: 'fixture-canary',
      };
    },
  };
  return { owner, calls: () => calls, ready: () => ready };
}

describe('Forge Computer local-vault secret boundary', () => {
  test('native Apple Events is denied without any registration, grant or Keychain access', async () => {
    const { input } = fixture();
    await expect(
      fillForgeVaultPasswordInComputer({ ...input, browserProvider: 'macos-apple-events' }),
    ).rejects.toMatchObject({ code: 'FORGE_VAULT_NATIVE_BROWSER_UNSAFE' });
  });
  test('unsupported host refuses before any browser mutation', async () => {
    if (process.platform === 'darwin') return;
    const { input } = fixture();
    await expect(fillForgeVaultPasswordInComputer(input)).rejects.toMatchObject({
      code: 'FORGE_VAULT_DEVICE_PLATFORM_UNSUPPORTED',
    });
  });
  test('preflight rejects missing and locked native owners without authorizing unlock', () => {
    const { input, authorize } = fixture();
    authorize();
    expect(() => assertForgeLocalVaultUnlocked(input.controllerHome)).toThrow(
      'Local Forge vault browser handoff rejected.',
    );
    const mock = mockOwner(false);
    attachForgeLocalVaultNativeOwner(input.controllerHome, mock.owner);
    expect(() => assertForgeLocalVaultUnlocked(input.controllerHome)).toThrow();
    expect(mock.calls()).toBe(0);
    expect(mock.ready()).toBe(false);
  });
  test('a valid website grant cannot unlock a locked native owner', async () => {
    if (process.platform !== 'darwin') return;
    const { input, authorize } = fixture();
    authorize();
    await expect(fillForgeVaultPasswordInComputer(input)).rejects.toMatchObject({
      code: 'FORGE_VAULT_LOCAL_OWNER_UNAVAILABLE',
    });
    const mock = mockOwner(false);
    attachForgeLocalVaultNativeOwner(input.controllerHome, mock.owner);
    await expect(fillForgeVaultPasswordInComputer(input)).rejects.toMatchObject({
      code: 'FORGE_VAULT_LOCAL_UNLOCK_REQUIRED',
    });
    expect(mock.calls()).toBe(0);
    expect(mock.ready()).toBe(false);
  });
  test('the native owner cannot consume an Apple grant as a Forge grant', async () => {
    if (process.platform !== 'darwin') return;
    const { input, authorize } = fixture();
    authorize('browser_password_manager');
    const mock = mockOwner(true);
    attachForgeLocalVaultNativeOwner(input.controllerHome, mock.owner);
    await expect(fillForgeVaultPasswordInComputer(input)).rejects.toMatchObject({
      code: 'FORGE_VAULT_CREDENTIAL_NOT_AUTHORIZED',
    });
    expect(mock.calls()).toBe(0);
  });
  test('only an independently unlocked local owner receives exact grant and whitelisted receipt', async () => {
    if (process.platform !== 'darwin') return;
    const { input, authorize } = fixture();
    authorize();
    const mock = mockOwner(true);
    const detach = attachForgeLocalVaultNativeOwner(input.controllerHome, mock.owner);
    const receipt = await fillForgeVaultPasswordInComputer(input);
    expect(mock.calls()).toBe(1);
    expect(receipt).toEqual({
      fillDispatched: true,
      accountFieldFilled: false,
      passwordFieldFilled: true,
      formSubmitted: false,
      loginVerified: false,
      source: 'forge-local-vault',
      credentialMaterialReturned: false,
    });
    expect(JSON.stringify(receipt)).not.toContain('fixture-canary');
    detach();
    expect(mock.ready()).toBe(false);
    expect(() => assertForgeLocalVaultUnlocked(input.controllerHome)).toThrow();
  });
  test('revocation between preflight and native dispatch invalidates the canonical grant', async () => {
    if (process.platform !== 'darwin') return;
    const { input, authorize } = fixture();
    authorize();
    const mock = mockOwner(true);
    const original = mock.owner.fillAuthorizedForm;
    mock.owner.fillAuthorizedForm = async (request) => {
      revokeCredentialUse({ controllerHome: input.controllerHome, credentialRef: input.credentialRef });
      return original(request);
    };
    attachForgeLocalVaultNativeOwner(input.controllerHome, mock.owner);
    await expect(fillForgeVaultPasswordInComputer(input)).rejects.toMatchObject({
      code: 'FORGE_VAULT_FILL_REJECTED_OR_UNKNOWN',
    });
  });
  test('shutdown revokes all local owners and does not preserve a remote unlock', () => {
    const { input } = fixture();
    const mock = mockOwner(true);
    attachForgeLocalVaultNativeOwner(input.controllerHome, mock.owner);
    assertForgeLocalVaultUnlocked(input.controllerHome);
    lockAllForgeVaultComputerSessions();
    expect(mock.ready()).toBe(false);
    expect(() => assertForgeLocalVaultUnlocked(input.controllerHome)).toThrow();
  });
});
