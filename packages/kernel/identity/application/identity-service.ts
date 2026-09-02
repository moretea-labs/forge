import { createHash } from 'crypto';
import type {
  CapabilityGrant,
  ConnectionIdentity,
  CredentialReference,
  ForgeInstanceIdentity,
  Principal,
  PrincipalKind,
} from '../domain/types';
export { ensureForgeInstanceIdentity, forgeInstanceIdentityPath, readForgeInstanceIdentity } from '../infrastructure/identity-store';
export type { ForgeIdentityStoreOptions } from '../infrastructure/identity-store';

export function principal(principalId: string, kind: PrincipalKind, issuer?: string): Principal {
  const normalized = principalId.trim();
  if (!normalized) throw new Error('PRINCIPAL_ID_REQUIRED');
  return { principalId: normalized.slice(0, 512), kind, ...(issuer?.trim() ? { issuer: issuer.trim().slice(0, 160) } : {}) };
}

export function credentialReference(reference: string, provider?: string): CredentialReference {
  const normalized = reference.trim();
  const match = /^(env|file|store|keychain|secret-ref):(.+)$/.exec(normalized);
  if (!match) throw new Error('CREDENTIAL_REFERENCE_REQUIRED: raw credentials are not accepted by Kernel identity');
  const kind = match[1] === 'secret-ref' ? 'secret_ref' : match[1] as CredentialReference['kind'];
  return { reference: normalized, kind, ...(provider?.trim() ? { provider: provider.trim().slice(0, 160) } : {}) };
}

export function capabilityGrant(input: Omit<CapabilityGrant, 'capabilities'> & { capabilities: readonly string[] }): CapabilityGrant {
  if (!input.grantId.trim() || !input.principalId.trim()) throw new Error('CAPABILITY_GRANT_IDENTITY_REQUIRED');
  const capabilities = [...new Set(input.capabilities.map((value) => value.trim()).filter(Boolean))].sort();
  return { ...input, grantId: input.grantId.trim(), principalId: input.principalId.trim(), capabilities };
}

export function connectionIdentity(input: {
  instance: ForgeInstanceIdentity;
  adapterId: string;
  principal: Principal;
  credentialReference?: CredentialReference;
  now?: () => string;
}): ConnectionIdentity {
  const adapterId = input.adapterId.trim();
  if (!adapterId) throw new Error('CONNECTION_ADAPTER_ID_REQUIRED');
  const semanticKey = [
    input.instance.instanceId,
    adapterId,
    input.principal.principalId,
    input.credentialReference?.reference ?? '',
  ].join('\u0000');
  const connectionId = `conn_${createHash('sha256').update(semanticKey).digest('hex').slice(0, 32)}`;
  return {
    schemaVersion: 1,
    connectionId,
    forgeInstanceId: input.instance.instanceId,
    adapterId,
    principalId: input.principal.principalId,
    ...(input.credentialReference ? { credentialReference: input.credentialReference } : {}),
    createdAt: (input.now ?? (() => new Date().toISOString()))(),
  };
}
