import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureForgeInstanceIdentity,
  findActiveCanonicalGrant,
  listCanonicalGrants,
} from '../../packages/kernel/identity/api/index';
import {
  authorizeHostProcessFromLocalTerminal,
  type HostProcessAuthorizationTerminal,
} from '../../src/cli/commands/host-process-authorization';

const homes: string[] = [];
function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'forge-host-grant-'));
  homes.push(h);
  ensureForgeInstanceIdentity({ controllerHome: h, preferredInstanceId: 'forge_test_host_grant' });
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
const approved: HostProcessAuthorizationTerminal = {
  interactive: true,
  async confirm(prompt) {
    expect(prompt).toContain('Host execution can read local secrets');
    expect(prompt).toContain('forge_test_host_grant');
    return 'AUTHORIZE process:exec forge_test_host_grant controller-http-client';
  },
};

describe('local exact-instance host execution grants', () => {
  test('refuses a non-interactive call and never writes', async () => {
    const h = home();
    await expect(authorizeHostProcessFromLocalTerminal(
      { controllerHome: h, principalId: 'controller-http-client' },
      { interactive: false, async confirm() { throw new Error('must not prompt'); } },
    )).rejects.toThrow('HOST_GRANT_INTERACTIVE_TERMINAL_REQUIRED');
    expect(listCanonicalGrants(h)).toHaveLength(0);
  });

  test('refuses an incorrect confirmation', async () => {
    const h = home();
    await expect(authorizeHostProcessFromLocalTerminal(
      { controllerHome: h, principalId: 'controller-http-client' },
      { interactive: true, async confirm() { return 'yes'; } },
    )).rejects.toThrow('HOST_GRANT_CONFIRMATION_MISMATCH');
    expect(listCanonicalGrants(h)).toHaveLength(0);
  });

  test('validates principal, duration and existing machine identity', async () => {
    const h = home();
    await expect(authorizeHostProcessFromLocalTerminal(
      { controllerHome: h, principalId: '*' }, approved,
    )).rejects.toThrow('HOST_GRANT_PRINCIPAL_INVALID');
    await expect(authorizeHostProcessFromLocalTerminal(
      { controllerHome: h, principalId: 'controller-http-client', minutes: 31 }, approved,
    )).rejects.toThrow('HOST_GRANT_DURATION_INVALID');
    const missing = mkdtempSync(join(tmpdir(), 'forge-no-identity-'));
    homes.push(missing);
    await expect(authorizeHostProcessFromLocalTerminal(
      { controllerHome: missing, principalId: 'controller-http-client' }, approved,
    )).rejects.toThrow('HOST_PROCESS_TARGET_UNAVAILABLE');
    expect(listCanonicalGrants(h)).toHaveLength(0);
  });

  test('creates one exact-risk exact-target time-limited grant', async () => {
    const h = home();
    const grant = await authorizeHostProcessFromLocalTerminal({
      controllerHome: h, principalId: 'controller-http-client', minutes: 5,
    }, approved);
    expect(grant.capabilities).toEqual(['process:exec']);
    expect(grant.riskCeiling).toBe('remote_write');
    expect(grant.target).toEqual({ kind: 'forge_instance', id: 'forge_test_host_grant' });
    expect(grant.principalId).toBe('controller-http-client');
    expect(Date.parse(grant.expiresAt) - Date.parse(grant.createdAt)).toBe(300000);
    expect(findActiveCanonicalGrant(h, {
      principalId: 'controller-http-client',
      capability: 'process:exec',
      target: { kind: 'forge_instance', id: 'forge_test_host_grant' },
      risk: 'remote_write',
    })?.grantId).toBe(grant.grantId);
    expect(findActiveCanonicalGrant(h, {
      principalId: 'another-client',
      capability: 'process:exec',
      target: { kind: 'forge_instance', id: 'forge_test_host_grant' },
      risk: 'remote_write',
    })).toBeUndefined();
    expect(findActiveCanonicalGrant(h, {
      principalId: 'controller-http-client',
      capability: 'process:exec',
      target: { kind: 'forge_instance', id: 'forge_other_machine' },
      risk: 'remote_write',
    })).toBeUndefined();
  });
});
