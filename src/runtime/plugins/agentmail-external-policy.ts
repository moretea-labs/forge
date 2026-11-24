import { createHash } from 'crypto';
import { AssistantPluginError } from './errors';
import type { ExternalPluginRegistration } from './external-registration';
import type { AssistantPluginActionExecutionInput, AssistantPluginAuthorizationContext } from './types';
import type { ExternalProviderPolicyContext } from './external-provider-policy-context';

const ACCOUNT_ACTIONS = new Set([
  'recent_messages', 'search_messages', 'read_message', 'read_thread', 'archive_message',
  'watch_rules', 'observe_watches', 'watch_next_event', 'acknowledge_watch_event',
  'create_draft', 'reply_draft',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (code: string, message: string) => new AssistantPluginError(code, message, { retryable: false });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function identity(value: unknown): { account_id: string; email: string; provider: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('AGENTMAIL_ACCOUNT_IDENTITY_INVALID', 'AgentMail returned an invalid mailbox identity.');
  const row = value as Record<string, unknown>;
  const account_id = String(row.account_id ?? row.accountId ?? row.id ?? '').trim().toLowerCase();
  const email = String(row.email ?? '').trim().toLowerCase();
  const provider = String(row.provider ?? '').trim().toLowerCase();
  if (!UUID.test(account_id) || !email || !provider) throw fail('AGENTMAIL_ACCOUNT_IDENTITY_INVALID', 'AgentMail returned an incomplete mailbox identity.');
  return { account_id, email, provider };
}

export async function resolveAgentMailAuthorizationContext(
  registration: ExternalPluginRegistration,
  input: AssistantPluginActionExecutionInput,
  context: ExternalProviderPolicyContext,
): Promise<AssistantPluginAuthorizationContext | undefined> {
  if (registration.pluginId !== 'agentmail' || registration.providerPluginId !== 'agentmail'
    || registration.provider !== 'moretea-labs' || registration.scope !== 'controller') {
    throw fail('AGENTMAIL_PROVIDER_IDENTITY_MISMATCH', 'AgentMail authorization requires its trusted controller registration.');
  }
  if (input.actionId !== 'list_accounts' && !ACCOUNT_ACTIONS.has(input.actionId)) return undefined;

  await context.verifyProviderIdentity(input.requestId + ':agentmail-manifest', input.signal);
  if (input.actionId === 'list_accounts') {
    const response = await context.callProvider(input.requestId + ':agentmail-account-set', 'list_account_identities', {}, input.timeoutMs, input.signal);
    const accounts = (Array.isArray(response.accounts) ? response.accounts : []).map(identity)
      .sort((a, b) => a.account_id.localeCompare(b.account_id));
    if (!accounts.length || new Set(accounts.map((account) => account.account_id)).size !== accounts.length) {
      throw fail('AGENTMAIL_ACCOUNT_SET_INVALID', 'AgentMail account discovery requires a non-empty set of unique connected accounts.');
    }
    return {
      target: { kind: 'mail-account-set', id: 'agentmail', identityFingerprint: hash([registration.registrationFingerprint, accounts]) },
      expiresInMinutes: 30 * 24 * 60,
    };
  }

  const accountId = typeof input.args.account_id === 'string' ? input.args.account_id.trim().toLowerCase() : '';
  if (!UUID.test(accountId)) throw fail('AGENTMAIL_ACCOUNT_SCOPE_REQUIRED', input.actionId + ' requires one exact connected account_id.');
  const account = identity(await context.callProvider(
    input.requestId + ':agentmail-account:' + accountId, 'resolve_account_identity',
    { account_id: accountId }, input.timeoutMs, input.signal,
  ));
  if (account.account_id !== accountId) throw fail('AGENTMAIL_ACCOUNT_IDENTITY_MISMATCH', 'AgentMail resolved a different mailbox account.');
  return {
    target: { kind: 'mail-account', id: accountId, identityFingerprint: hash([registration.registrationFingerprint, account]) },
    expiresInMinutes: 30 * 24 * 60,
  };
}
