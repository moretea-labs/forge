import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  assertCredentialUseAuthorized,
  authorizeCredentialUse,
  credentialUseStatus,
  revokeCredentialUse,
} from '../../src/runtime/safe-tooling/managed-credential-authorization';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'forge-credential-auth-'));
  roots.push(value);
  return value;
}

describe('credential use authorization', () => {
  test('requires explicit enrollment and reuses the exact active credential grant', () => {
    const controllerHome = home();
    expect(() => authorizeCredentialUse({
      controllerHome, credentialRef: 'cred_alpha', endpoint: 'https://api.example.com/v1',
      confirmAuthorization: false,
    })).toThrow('CREDENTIAL_AUTHORIZATION_CONFIRMATION_REQUIRED');
    const first = authorizeCredentialUse({
      controllerHome, credentialRef: 'cred_alpha', endpoint: 'https://api.example.com/v1',
      confirmAuthorization: true,
    });
    const second = authorizeCredentialUse({
      controllerHome, credentialRef: 'cred_alpha', endpoint: 'https://api.example.com/v1',
      confirmAuthorization: true,
    });
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.grant.grantId).toBe(first.grant.grantId);
  });

  test('fails closed for endpoint mismatch, expiry and revoke', () => {
    const controllerHome = home();
    authorizeCredentialUse({
      controllerHome, credentialRef: 'cred_alpha', endpoint: 'https://api.example.com/v1',
      confirmAuthorization: true, expiresInMinutes: 1,
    });
    expect(credentialUseStatus({
      controllerHome, credentialRef: 'cred_alpha', endpoint: 'https://other.example.com/v1',
    }).authorized).toBe(false);
    expect(() => assertCredentialUseAuthorized({
      controllerHome, credentialRef: 'cred_alpha', endpoint: 'https://other.example.com/v1',
    })).toThrow('CREDENTIAL_USE_NOT_AUTHORIZED');
    expect(credentialUseStatus({
      controllerHome, credentialRef: 'cred_alpha', endpoint: 'https://api.example.com/v1',
      at: new Date(Date.now() + 120_000),
    }).authorized).toBe(false);
    expect(revokeCredentialUse({ controllerHome, credentialRef: 'cred_alpha' }).revoked).toBe(true);
    expect(credentialUseStatus({
      controllerHome, credentialRef: 'cred_alpha', endpoint: 'https://api.example.com/v1',
    }).authorized).toBe(false);
  });

  test('status is metadata-only', () => {
    const controllerHome = home();
    const status = credentialUseStatus({
      controllerHome, credentialRef: 'cred_alpha', endpoint: 'https://api.example.com/v1',
    });
    const serialized = JSON.stringify(status);
    expect(status.authorized).toBe(false);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('apiKey');
  });
});
