/** Stable semantic identity for one installed Forge authority. */
export interface ForgeInstanceIdentity {
  schemaVersion: 1;
  instanceId: string;
  createdAt: string;
  label?: string;
}

export type PrincipalKind = 'user' | 'oauth_client' | 'bearer_client' | 'controller' | 'system' | 'service';

export interface Principal {
  principalId: string;
  kind: PrincipalKind;
  issuer?: string;
}

/** Reference to credentials owned by an adapter/secret store. Never raw secret material. */
export interface CredentialReference {
  reference: string;
  kind: 'env' | 'file' | 'store' | 'keychain' | 'secret_ref';
  provider?: string;
}

export interface CapabilityGrant {
  grantId: string;
  principalId: string;
  capabilities: string[];
  issuedAt: string;
  expiresAt?: string;
}

/**
 * Semantic adapter connection identity. Endpoint/tunnel/process/session metadata
 * is intentionally absent so transport rotation cannot mint a Forge identity.
 */
export interface ConnectionIdentity {
  schemaVersion: 1;
  connectionId: string;
  forgeInstanceId: string;
  adapterId: string;
  principalId: string;
  credentialReference?: CredentialReference;
  createdAt: string;
}
