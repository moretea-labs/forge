import { describe, expect, test } from 'bun:test';
import {
  resolveExternalProviderPolicy,
  type ExternalProviderPolicyContext,
} from '../../src/runtime/plugins/external-provider-policy';
import type { ExternalPluginRegistration } from '../../src/runtime/plugins/external-registration';
import type { AssistantPluginActionExecutionInput } from '../../src/runtime/plugins/types';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const registration = (overrides: Partial<ExternalPluginRegistration> = {}): ExternalPluginRegistration => ({
  schemaVersion: 1,
  revision: 1,
  pluginId: 'agentmail',
  providerPluginId: 'agentmail',
  displayName: 'AgentMail',
  provider: 'moretea-labs',
  pluginVersion: '1.0.0',
  protocolVersion: '1.0',
  scope: 'controller',
  enabled: true,
  transport: { kind: 'unix_socket_jsonl', socketPath: '/tmp/agentmail.sock' },
  permissions: [],
  capabilities: [],
  actions: [],
  legacyIdentities: [],
  registrationFingerprint: 'a'.repeat(64),
  installedAt: '2026-11-17T00:00:00Z',
  updatedAt: '2026-11-17T00:00:00Z',
  ...overrides,
});
const input = (actionId: string, args: Record<string, unknown> = {}): AssistantPluginActionExecutionInput => ({
  controllerHome: '/tmp/controller',
  repoId: 'repo',
  repoRoot: '/tmp/repo',
  pluginId: 'agentmail',
  actionId,
  requestId: 'request-' + actionId,
  args,
  origin: { surface: 'mcp' },
});
function context(rows: Array<{ id: string; email: string; provider: string }>) {
  const calls: string[] = [];
  const value: ExternalProviderPolicyContext = {
    verifyProviderIdentity: async () => {},
    callProvider: async (_id, action, args) => {
      calls.push(action);
      if (action === 'list_account_identities') return { accounts: rows };
      const id = String(args.account_id ?? '').toLowerCase();
      const row = rows.find((entry) => entry.id.toLowerCase() === id);
      if (!row) throw new Error('ACCOUNT_NOT_FOUND');
      return { account_id: row.id, email: row.email, provider: row.provider };
    },
    activateAndVerifyFrontmostApplication: async () => {
      throw new Error('NOT_USED');
    },
  };
  return { value, calls };
}

describe('AgentMail external provider authorization', () => {
  test('list grant fingerprints the complete account set and changes when it changes', async () => {
    const policy = resolveExternalProviderPolicy(registration())!;
    const before = context([
      { id: A, email: 'one@example.com', provider: 'qq' },
      { id: B, email: 'two@example.com', provider: 'apple' },
    ]);
    const after = context([{ id: A, email: 'one@example.com', provider: 'qq' }]);
    const a = await policy.resolveAuthorizationContext!(registration(), input('list_accounts'), before.value);
    const b = await policy.resolveAuthorizationContext!(registration(), input('list_accounts'), after.value);
    expect(a?.target.kind).toBe('mail-account-set');
    expect(a?.target.identityFingerprint).not.toBe(b?.target.identityFingerprint);
    expect(before.calls).toEqual(['list_account_identities']);
  });

  test('read/watch/draft/modify grants are bound to one exact mailbox identity', async () => {
    const policy = resolveExternalProviderPolicy(registration())!;
    const ctx = context([
      { id: A, email: 'one@example.com', provider: 'qq' },
      { id: B, email: 'two@example.com', provider: 'apple' },
    ]);
    const a = await policy.resolveAuthorizationContext!(
      registration(),
      input('watch_next_event', { account_id: A }),
      ctx.value,
    );
    const b = await policy.resolveAuthorizationContext!(
      registration(),
      input('watch_next_event', { account_id: B }),
      ctx.value,
    );
    expect(a?.target).toMatchObject({ kind: 'mail-account', id: A });
    expect(b?.target).toMatchObject({ kind: 'mail-account', id: B });
    expect(a?.target.identityFingerprint).not.toBe(b?.target.identityFingerprint);
    const changed = context([{ id: A, email: 'owner@example.com', provider: 'qq' }]);
    const c = await policy.resolveAuthorizationContext!(
      registration(),
      input('read_message', { account_id: A }),
      changed.value,
    );
    expect(c?.target.identityFingerprint).not.toBe(a?.target.identityFingerprint);
    const archived = await policy.resolveAuthorizationContext!(
      registration(),
      input('archive_message', { account_id: A, provider_message_id: 'Inbox/42' }),
      changed.value,
    );
    expect(archived?.target).toMatchObject({ kind: 'mail-account', id: A });
  });

  test('missing, malformed, and unavailable account IDs fail closed', async () => {
    const policy = resolveExternalProviderPolicy(registration())!;
    await expect(
      policy.resolveAuthorizationContext!(registration(), input('read_message'), context([]).value),
    ).rejects.toThrow('AGENTMAIL_ACCOUNT_SCOPE_REQUIRED');
    await expect(
      policy.resolveAuthorizationContext!(registration(), input('archive_message'), context([]).value),
    ).rejects.toThrow('AGENTMAIL_ACCOUNT_SCOPE_REQUIRED');
    await expect(
      policy.resolveAuthorizationContext!(
        registration(),
        input('read_message', { account_id: 'all' }),
        context([]).value,
      ),
    ).rejects.toThrow('AGENTMAIL_ACCOUNT_SCOPE_REQUIRED');
    await expect(
      policy.resolveAuthorizationContext!(registration(), input('read_message', { account_id: A }), context([]).value),
    ).rejects.toThrow('ACCOUNT_NOT_FOUND');
  });

  test('rejects untrusted provider identity and leaves unrelated providers unchanged', async () => {
    const untrusted = registration({ provider: 'untrusted' });
    const policy = resolveExternalProviderPolicy(untrusted)!;
    await expect(
      policy.resolveAuthorizationContext!(
        untrusted,
        input('read_message', { account_id: A }),
        context([{ id: A, email: 'one@example.com', provider: 'qq' }]).value,
      ),
    ).rejects.toThrow('AGENTMAIL_PROVIDER_IDENTITY_MISMATCH');
    expect(resolveExternalProviderPolicy(registration({ pluginId: 'fixture_provider' }))).toBeUndefined();
  });
});
