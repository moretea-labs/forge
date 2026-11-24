import { resolve } from 'node:path';
import { assertCredentialUseAuthorized } from './managed-credential-authorization';

const PROVIDER = 'forge_local_vault' as const;

type VaultGrantRequest = {
  credentialRef: string;
  endpoint: string;
  account: string;
  provider: typeof PROVIDER;
};

type VaultBrowserPage = {
  url(): string;
  evaluate<T>(fn: (...args: unknown[]) => unknown, input: unknown): Promise<T>;
  fill(selector: string, value: string): Promise<void>;
};

type VaultFillInput = {
  controllerHome: string;
  credentialRef: string;
  origin: string;
  account: string;
  selector: string;
  usernameSelector: string;
  page: VaultBrowserPage;
  browserProvider: string;
};

/**
 * Internal composition boundary: only a reviewed, release-owned native service
 * may be attached here, after its own local UI authentication. In particular,
 * neither a canonical site grant nor a JSON action is an unlock assertion.
 * No mutable external plugin module, secret-bearing tool, or caller-provided
 * code is loaded by the Browser action.
 */
export interface ForgeLocalVaultNativeOwner {
  isUnlocked(): boolean;
  lock(): void;
  fillAuthorizedForm(input: {
    credentialRef: string;
    origin: string;
    account: string;
    selector: string;
    usernameSelector: string;
    page: VaultBrowserPage;
    verifyCanonicalGrant(request: VaultGrantRequest): VaultGrantRequest & { authorized: true };
  }): Promise<{
    fillDispatched: boolean;
    accountFieldFilled: boolean;
    passwordFieldFilled: boolean;
    formSubmitted: boolean;
  }>;
}

const nativeOwners = new Map<string, ForgeLocalVaultNativeOwner>();

export class ForgeLocalVaultBridgeError extends Error {
  constructor(readonly code: string) {
    super('Local Forge vault browser handoff rejected.');
  }
}
const deny = (code: string): never => { throw new ForgeLocalVaultBridgeError(code); };

/**
 * Composition-only API, deliberately not exported as a tool, plugin action,
 * CLI command, or remote endpoint. The native UI/composition must supply a
 * release-owned service; this function never unlocks or reads the keychain.
 */
export function attachForgeLocalVaultNativeOwner(
  controllerHome: string, owner: ForgeLocalVaultNativeOwner,
): () => void {
  const identity = resolve(controllerHome);
  const previous = nativeOwners.get(identity);
  if (previous && previous !== owner) previous.lock();
  nativeOwners.set(identity, owner);
  return () => {
    if (nativeOwners.get(identity) === owner) {
      nativeOwners.delete(identity);
      owner.lock();
    }
  };
}

function requireUnlockedOwner(controllerHome: string): ForgeLocalVaultNativeOwner {
  const owner = nativeOwners.get(resolve(controllerHome));
  if (!owner) return deny('FORGE_VAULT_LOCAL_OWNER_UNAVAILABLE');
  try {
    if (owner.isUnlocked() === true) return owner;
  } catch { /* An unavailable local service is never an unlock. */ }
  return deny('FORGE_VAULT_LOCAL_UNLOCK_REQUIRED');
}

/** Safe preflight before opening, attaching, or inspecting a browser tab. */
export function assertForgeLocalVaultUnlocked(controllerHome: string): void {
  requireUnlockedOwner(controllerHome);
}

export async function fillForgeVaultPasswordInComputer(input: VaultFillInput): Promise<Record<string, unknown>> {
  if (input.browserProvider !== 'playwright') return deny('FORGE_VAULT_NATIVE_BROWSER_UNSAFE');
  if (process.platform !== 'darwin') return deny('FORGE_VAULT_DEVICE_PLATFORM_UNSUPPORTED');

  // Check canonical, exact origin/account/provider authority independently
  // from the device unlock. A site grant may never unlock the native service.
  const canonicalGrant = () => {
    try {
      const grant = assertCredentialUseAuthorized({
        controllerHome: input.controllerHome,
        credentialRef: input.credentialRef,
        endpoint: input.origin,
        provider: PROVIDER,
        account: input.account,
      });
      if (grant.constraints?.account !== input.account
        || grant.constraints?.endpoint !== input.origin
        || grant.constraints?.provider !== PROVIDER) {
        return deny('FORGE_VAULT_CREDENTIAL_NOT_AUTHORIZED');
      }
    } catch { return deny('FORGE_VAULT_CREDENTIAL_NOT_AUTHORIZED'); }
  };
  canonicalGrant();
  const owner = requireUnlockedOwner(input.controllerHome);
  if (new URL(input.page.url()).origin !== input.origin) {
    return deny('FORGE_VAULT_BROWSER_ORIGIN_MISMATCH');
  }

  try {
    const result = await owner.fillAuthorizedForm({
      credentialRef: input.credentialRef,
      origin: input.origin,
      account: input.account,
      selector: input.selector,
      usernameSelector: input.usernameSelector,
      page: input.page,
      verifyCanonicalGrant: (request) => {
        if (request.credentialRef !== input.credentialRef
          || request.endpoint !== input.origin || request.account !== input.account
          || request.provider !== PROVIDER) {
          return deny('FORGE_VAULT_CREDENTIAL_NOT_AUTHORIZED');
        }
        canonicalGrant();
        if (requireUnlockedOwner(input.controllerHome) !== owner) {
          return deny('FORGE_VAULT_LOCAL_OWNER_UNAVAILABLE');
        }
        if (new URL(input.page.url()).origin !== input.origin) {
          return deny('FORGE_VAULT_BROWSER_ORIGIN_MISMATCH');
        }
        return {
          authorized: true, credentialRef: input.credentialRef,
          endpoint: input.origin, account: input.account, provider: PROVIDER,
        };
      },
    });
    if (result.fillDispatched !== true || result.passwordFieldFilled !== true
      || result.formSubmitted !== false || typeof result.accountFieldFilled !== 'boolean') {
      return deny('FORGE_VAULT_FILL_REJECTED_OR_UNKNOWN');
    }
    // Explicit allowlist: do not spread provider receipts or arbitrary values.
    return {
      fillDispatched: true, accountFieldFilled: result.accountFieldFilled,
      passwordFieldFilled: true, formSubmitted: false, loginVerified: false,
      source: 'forge-local-vault', credentialMaterialReturned: false,
    };
  } catch {
    // A provider error may contain secret material. Never serialize it.
    return deny('FORGE_VAULT_FILL_REJECTED_OR_UNKNOWN');
  }
}

/** Trusted runtime shutdown/logout boundary; not an externally callable action. */
export function lockAllForgeVaultComputerSessions(): void {
  const owners = Array.from(nativeOwners.values());
  nativeOwners.clear();
  for (const owner of owners) {
    try { owner.lock(); } catch { /* Continue revoking all owners. */ }
  }
}
