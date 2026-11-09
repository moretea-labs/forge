import {
  findActiveCanonicalGrant,
  listCanonicalGrants,
  recordCanonicalGrant,
  revokeCanonicalGrant,
  type Grant,
} from '../../../packages/kernel/identity/api';

const CAPABILITY = 'credential:use';
const PROVIDER = 'api';

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
function constraints(endpoint: string) {
  return { provider: PROVIDER, endpoint };
}
function activeOwnedGrant(controllerHome: string, credentialRef: string): Grant | undefined {
  const now = Date.now();
  return listCanonicalGrants(controllerHome, { ownerScope: ownerScope(credentialRef) })
    .filter((grant) => !grant.revokedAt && Date.parse(grant.expiresAt) > now && grant.capabilities.includes(CAPABILITY))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

export function credentialUseStatus(input: {
  controllerHome: string;
  credentialRef: string;
  endpoint: string;
  at?: Date;
}) {
  const credentialRef = required(input.credentialRef, 'CREDENTIAL_REF_REQUIRED');
  const endpoint = required(input.endpoint, 'CREDENTIAL_ENDPOINT_REQUIRED');
  const grant = findActiveCanonicalGrant(input.controllerHome, {
    ownerScope: ownerScope(credentialRef),
    capability: CAPABILITY,
    target: credentialTarget(credentialRef),
    constraints: constraints(endpoint),
    risk: 'readonly',
    at: input.at,
  });
  return {
    authorized: Boolean(grant),
    credentialRef,
    provider: PROVIDER,
    endpoint,
    grantId: grant?.grantId,
    expiresAt: grant?.expiresAt,
  };
}

export function authorizeCredentialUse(input: {
  controllerHome: string;
  credentialRef: string;
  endpoint: string;
  principalId?: string;
  confirmAuthorization: boolean;
  expiresInMinutes?: number;
}) {
  if (!input.confirmAuthorization) throw new Error('CREDENTIAL_AUTHORIZATION_CONFIRMATION_REQUIRED');
  const credentialRef = required(input.credentialRef, 'CREDENTIAL_REF_REQUIRED');
  const endpoint = required(input.endpoint, 'CREDENTIAL_ENDPOINT_REQUIRED');
  const current = credentialUseStatus({ controllerHome: input.controllerHome, credentialRef, endpoint });
  if (current.authorized) {
    const existing = activeOwnedGrant(input.controllerHome, credentialRef);
    if (!existing) throw new Error('CREDENTIAL_AUTHORIZATION_INCONSISTENT');
    return { grant: existing, reused: true };
  }
  const previous = activeOwnedGrant(input.controllerHome, credentialRef);
  if (previous) {
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
    constraints: constraints(endpoint),
    expiresInMinutes: input.expiresInMinutes,
  });
  return { grant, reused: false };
}

export function revokeCredentialUse(input: {
  controllerHome: string;
  credentialRef: string;
  reason?: string;
}) {
  const credentialRef = required(input.credentialRef, 'CREDENTIAL_REF_REQUIRED');
  const current = activeOwnedGrant(input.controllerHome, credentialRef);
  if (!current) return { revoked: false, credentialRef };
  const grant = revokeCanonicalGrant(input.controllerHome, {
    grantId: current.grantId,
    ownerScope: ownerScope(credentialRef),
    reason: input.reason?.trim() || 'credential authorization revoked',
  });
  return { revoked: true, credentialRef, grantId: grant.grantId };
}

export function assertCredentialUseAuthorized(input: {
  controllerHome: string;
  credentialRef: string;
  endpoint: string;
}): Grant {
  const credentialRef = required(input.credentialRef, 'CREDENTIAL_REF_REQUIRED');
  const endpoint = required(input.endpoint, 'CREDENTIAL_ENDPOINT_REQUIRED');
  const grant = findActiveCanonicalGrant(input.controllerHome, {
    ownerScope: ownerScope(credentialRef),
    capability: CAPABILITY,
    target: credentialTarget(credentialRef),
    constraints: constraints(endpoint),
    risk: 'readonly',
  });
  if (!grant) throw new Error('CREDENTIAL_USE_NOT_AUTHORIZED');
  return grant;
}
