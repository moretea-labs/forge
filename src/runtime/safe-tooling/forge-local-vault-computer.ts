import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getExternalPluginRegistration } from '../plugins/external-registration';
import { assertCredentialUseAuthorized } from './managed-credential-authorization';

const providerSessions = new Map<string, {
  root: string;
  registrationRevision: number;
  session: { activeKey(): Buffer; unlock(input: { localUserAuthorized: true }): unknown; status(): { unlockedInProcess: boolean }; lock(): void };
}>();

export class ForgeLocalVaultBridgeError extends Error {
  constructor(readonly code: string) {
    super('Local Forge vault browser handoff rejected.');
  }
}
const deny = (code: string): never => { throw new ForgeLocalVaultBridgeError(code); };

function exactProviderRoot(controllerHome: string): { root: string; revision: number } {
  const installed = getExternalPluginRegistration(controllerHome, 'credentials');
  if (!installed || !installed.enabled || installed.scope !== 'controller'
    || installed.providerPluginId !== 'credentials' || installed.provider !== 'moretea-labs'
    || !/^0\.3\./.test(installed.pluginVersion)
    || installed.transport.kind !== 'managed_cli_json'
    || typeof installed.transport.cwd !== 'string'
    || typeof installed.transport.helperPath !== 'string') {
    return deny('FORGE_VAULT_PROVIDER_NOT_TRUSTED');
  }
  const root = realpathSync(installed.transport.cwd);
  const helper = realpathSync(installed.transport.helperPath);
  if (!helper.startsWith(root + sep) || helper !== join(root, 'scripts', 'forge-provider.mjs')) {
    return deny('FORGE_VAULT_PROVIDER_PATH_INVALID');
  }
  const st = statSync(root);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) {
    return deny('FORGE_VAULT_PROVIDER_PATH_INVALID');
  }
  for (const file of ['src/local-vault.mjs', 'src/local-keychain.mjs',
    'src/vault-unlock-session.mjs', 'src/trusted-browser-fill.mjs']) {
    const resolved = realpathSync(join(root, file));
    if (!resolved.startsWith(root + sep) || !existsSync(resolved)) {
      return deny('FORGE_VAULT_PROVIDER_PATH_INVALID');
    }
  }
  return { root, revision: installed.revision };
}

async function trustedModule(root: string, file: string): Promise<any> {
  // The externally installed credentials implementation is trusted at
  // registration, not through an arbitrary caller-selected path.
  return import(pathToFileURL(join(root, 'src', file)).href);
}

export async function fillForgeVaultPasswordInComputer(input: {
  controllerHome: string;
  credentialRef: string;
  origin: string;
  account: string;
  selector: string;
  usernameSelector: string;
  page: {
    url(): string;
    evaluate<T>(fn: (...args: unknown[]) => unknown, input: unknown): Promise<T>;
    fill(selector: string, value: string): Promise<void>;
  };
  browserProvider: string;
}): Promise<Record<string, unknown>> {
  // Never route plaintext to the native Apple Events adapter: it serializes
  // JavaScript into a process-control command. Playwright is required.
  if (input.browserProvider !== 'playwright') deny('FORGE_VAULT_NATIVE_BROWSER_UNSAFE');
  if (process.platform !== 'darwin') deny('FORGE_VAULT_DEVICE_PLATFORM_UNSUPPORTED');
  const { root, revision } = exactProviderRoot(input.controllerHome);

  // Canonical authorization is checked inside the trusted Runtime, before
  // any vault read or Keychain access. Agent-supplied booleans are ignored.
  const canonicalGrant = () => {
    try {
      return assertCredentialUseAuthorized({
        controllerHome: input.controllerHome,
        credentialRef: input.credentialRef,
        endpoint: input.origin,
        provider: 'forge_local_vault',
        account: input.account,
      });
    } catch { return deny('FORGE_VAULT_CREDENTIAL_NOT_AUTHORIZED'); }
  };
  const grant = canonicalGrant();
  if (!grant || grant.constraints?.account !== input.account
    || grant.constraints?.endpoint !== input.origin) deny('FORGE_VAULT_CREDENTIAL_NOT_AUTHORIZED');

  const [{ LocalVault }, { localKeychainMasterKey }, { VaultUnlockSession },
    { fillForgeVaultPasswordLocally }] = await Promise.all([
    trustedModule(root, 'local-vault.mjs'),
    trustedModule(root, 'local-keychain.mjs'),
    trustedModule(root, 'vault-unlock-session.mjs'),
    trustedModule(root, 'trusted-browser-fill.mjs'),
  ]);

  const identity = resolve(input.controllerHome);
  let cached = providerSessions.get(identity);
  if (cached && (cached.root !== root || cached.registrationRevision !== revision)) {
    cached.session.lock(); providerSessions.delete(identity); cached = undefined;
  }
  if (!cached) {
    const session = new VaultUnlockSession({
      keyProvider: () => localKeychainMasterKey({ create: false }),
    });
    cached = { root, registrationRevision: revision, session };
    providerSessions.set(identity, cached);
  }
  const unlockSession = cached.session;
  const vault = new LocalVault({
    keyProvider: () => {
      if (!unlockSession.status().unlockedInProcess) {
        // Reaching this code requires an existing canonical grant, live exact
        // browser target and a host-authorized Computer mutation.
        unlockSession.unlock({ localUserAuthorized: true });
      }
      return unlockSession.activeKey();
    },
  });
  try {
    const result = await fillForgeVaultPasswordLocally({
      vault, credentialRef: input.credentialRef,
      origin: input.origin, account: input.account,
      selector: input.selector, usernameSelector: input.usernameSelector,
      page: input.page, provider: 'playwright',
      verifyCanonicalGrant: ({ credentialRef, endpoint, account }: {
        credentialRef: string; endpoint: string; account: string;
      }) => {
        if (credentialRef !== input.credentialRef || endpoint !== input.origin || account !== input.account) {
          return deny('FORGE_VAULT_CREDENTIAL_NOT_AUTHORIZED');
        }
        canonicalGrant();
        return { authorized: true, credentialRef, endpoint, account, provider: 'browser_password_manager' };
      },
    });
    return {
      ...result,
      source: 'forge-local-vault',
      credentialMaterialReturned: false,
      vaultSessionActive: unlockSession.status().unlockedInProcess,
      loginVerified: false,
    };
  } catch {
    // Do not serialize an exception from a Keychain, decryptor or browser
    // driver: its error text may accidentally contain secret material.
    return deny('FORGE_VAULT_FILL_REJECTED_OR_UNKNOWN');
  }
}

/** Only for trusted Computer shutdown/logout; never exposed as plugin action. */
export function lockAllForgeVaultComputerSessions(): void {
  for (const cached of providerSessions.values()) cached.session.lock();
  providerSessions.clear();
}
