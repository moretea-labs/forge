import {
  listCanonicalGrants,
  recordCanonicalGrant,
  revokeCanonicalGrant,
  type Grant,
} from '../../../packages/kernel/identity/api';

const CAPABILITY = 'credential:use';
export type CredentialUseProvider = 'api' | 'browser_password_manager' | 'forge_local_vault';
const DEFAULT_PROVIDER: CredentialUseProvider = 'api';
const PROVIDERS = new Set<CredentialUseProvider>(['api', 'browser_password_manager', 'forge_local_vault']);

function required(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}
function credentialTarget(credentialRef: string) {
  return { kind: 'credential', id: credentialRef };
}
function ownerScope(credentialRef: string): string {
  return `forge-credential-use:${credentialRef}`;
}
function provider(value?: string): CredentialUseProvider {
  const normalized = value?.trim() || DEFAULT_PROVIDER;
  if (!PROVIDERS.has(normalized as CredentialUseProvider)) throw new Error('CREDENTIAL_PROVIDER_UNSUPPORTED');
  return normalized as CredentialUseProvider;
}
function account(value?: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > 512) throw new Error('CREDENTIAL_ACCOUNT_INVALID');
  return normalized;
}
function constraints(endpoint: string, selectedProvider: CredentialUseProvider, selectedAccount?: string) {
  return { provider: selectedProvider, endpoint, ...(selectedAccount ? { account: selectedAccount } : {}) };
}
function matchingGrant(input: {
  controllerHome: string;
  credentialRef: string;
  endpoint: string;
  provider: CredentialUseProvider;
  account?: string;
  at?: Date;
}): Grant | undefined {
  const at = input.at?.getTime() ?? Date.now();
  return listCanonicalGrants(input.controllerHome, { ownerScope: ownerScope(input.credentialRef) })
    .filter((grant) => !grant.revokedAt && Date.parse(grant.expiresAt) > at)
    .filter((grant) => grant.capabilities.includes(CAPABILITY))
    .filter((grant) => (grant.riskCeiling ?? 'readonly') === 'readonly')
    .filter((grant) => grant.target?.kind === 'credential' && grant.target.id === input.credentialRef)
    .filter((grant) => grant.constraints?.provider === input.provider && grant.constraints?.endpoint === input.endpoint)
    .filter((grant) => input.account === undefined || grant.constraints?.account === input.account)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}
function activeOwnedGrants(controllerHome: string, credentialRef: string): Grant[] {
  const now = Date.now();
  return listCanonicalGrants(controllerHome, { ownerScope: ownerScope(credentialRef) })
    .filter((grant) => !grant.revokedAt && Date.parse(grant.expiresAt) > now && grant.capabilities.includes(CAPABILITY))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function credentialUseStatus(input: {
  controllerHome: string;
  credentialRef: string;
  endpoint: string;
  provider?: string;
  account?: string;
  at?: Date;
}) {
  const credentialRef = required(input.credentialRef, 'CREDENTIAL_REF_REQUIRED');
  const endpoint = required(input.endpoint, 'CREDENTIAL_ENDPOINT_REQUIRED');
  const selectedProvider = provider(input.provider);
  const selectedAccount = account(input.account);
  if ((selectedProvider === 'browser_password_manager' || selectedProvider === 'forge_local_vault') && !selectedAccount)
    throw new Error('CREDENTIAL_ACCOUNT_REQUIRED');
  const grant = matchingGrant({
    controllerHome: input.controllerHome,
    credentialRef,
    endpoint,
    provider: selectedProvider,
    account: selectedAccount,
    at: input.at,
  });
  return {
    authorized: Boolean(grant),
    credentialRef,
    provider: selectedProvider,
    endpoint,
    accountBound: Boolean(selectedAccount),
    grantId: grant?.grantId,
    expiresAt: grant?.expiresAt,
  };
}

export function authorizeCredentialUse(input: {
  controllerHome: string;
  credentialRef: string;
  endpoint: string;
  principalId?: string;
  provider?: string;
  account?: string;
  confirmAuthorization: boolean;
  expiresInMinutes?: number;
}) {
  if (!input.confirmAuthorization) throw new Error('CREDENTIAL_AUTHORIZATION_CONFIRMATION_REQUIRED');
  const credentialRef = required(input.credentialRef, 'CREDENTIAL_REF_REQUIRED');
  const endpoint = required(input.endpoint, 'CREDENTIAL_ENDPOINT_REQUIRED');
  const selectedProvider = provider(input.provider);
  const selectedAccount = account(input.account);
  if ((selectedProvider === 'browser_password_manager' || selectedProvider === 'forge_local_vault') && !selectedAccount)
    throw new Error('CREDENTIAL_ACCOUNT_REQUIRED');
  const current = credentialUseStatus({
    controllerHome: input.controllerHome,
    credentialRef,
    endpoint,
    provider: selectedProvider,
    account: selectedAccount,
  });
  if (current.authorized) {
    const existing = matchingGrant({
      controllerHome: input.controllerHome,
      credentialRef,
      endpoint,
      provider: selectedProvider,
      account: selectedAccount,
    });
    if (!existing) throw new Error('CREDENTIAL_AUTHORIZATION_INCONSISTENT');
    return { grant: existing, reused: true };
  }
  for (const previous of activeOwnedGrants(input.controllerHome, credentialRef)) {
    revokeCanonicalGrant(input.controllerHome, {
      grantId: previous.grantId,
      ownerScope: ownerScope(credentialRef),
      reason: 'credential authorization scope changed',
    });
  }
  const grant = recordCanonicalGrant(input.controllerHome, {
    principalId: input.principalId?.trim() || 'forge-local-user',
    ownerScope: ownerScope(credentialRef),
    capabilities: [CAPABILITY],
    target: credentialTarget(credentialRef),
    riskCeiling: 'readonly',
    constraints: constraints(endpoint, selectedProvider, selectedAccount),
    expiresInMinutes: input.expiresInMinutes,
  });
  return { grant, reused: false };
}

export function revokeCredentialUse(input: { controllerHome: string; credentialRef: string; reason?: string }) {
  const credentialRef = required(input.credentialRef, 'CREDENTIAL_REF_REQUIRED');
  const current = activeOwnedGrants(input.controllerHome, credentialRef);
  if (current.length === 0) return { revoked: false, credentialRef };
  const revoked = current.map((grant) =>
    revokeCanonicalGrant(input.controllerHome, {
      grantId: grant.grantId,
      ownerScope: ownerScope(credentialRef),
      reason: input.reason?.trim() || 'credential authorization revoked',
    }),
  );
  return {
    revoked: true,
    credentialRef,
    grantId: revoked[0]!.grantId,
    grantIds: revoked.map((grant) => grant.grantId),
  };
}

export function assertCredentialUseAuthorized(input: {
  controllerHome: string;
  credentialRef: string;
  endpoint: string;
  provider?: string;
  account?: string;
}): Grant {
  const credentialRef = required(input.credentialRef, 'CREDENTIAL_REF_REQUIRED');
  const endpoint = required(input.endpoint, 'CREDENTIAL_ENDPOINT_REQUIRED');
  const selectedProvider = provider(input.provider);
  const selectedAccount = account(input.account);
  const grant = matchingGrant({
    controllerHome: input.controllerHome,
    credentialRef,
    endpoint,
    provider: selectedProvider,
    account: selectedAccount,
  });
  if (!grant) throw new Error('CREDENTIAL_USE_NOT_AUTHORIZED');
  return grant;
}
