import { createHash } from 'crypto';
import { withControllerLock } from '../../src/cli/repositories/locks';
import { readControlPlaneRecord, writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';

// Resource-cleanup evidence only. Autonomous outer-turn dispatch authority is the Workflow Supervisor Effect ledger; ControllerRound fields are lower-layer/bootstrap compatibility mirrors.
const NAMESPACE = 'chatgpt_controller_round_settlement';

export type ChatgptControllerRoundSettlementStatus =
  | 'round_open'
  | 'retained_for_immediate_continuation'
  | 'closed'
  | 'preserved_user_owned'
  | 'session_closed'
  | 'failed';

/** Browser/tab resource settlement evidence after a semantic ControllerRound; never proof that a provider prompt was dispatched. */
export interface ChatgptControllerRoundSettlement {
  schemaVersion: 1;
  repoId: string;
  workId: string;
  relayScopeId: string;
  status: ChatgptControllerRoundSettlementStatus;
  recordedAt: string;
  error?: string;
  /**
   * Opaque identity of the browser resource and grants used for this settlement
   * attempt. A matching failed attempt must not repeatedly call the provider.
   */
  attemptIdentity?: string;
}

function settlementKey(workId: string, relayScopeId: string): string {
  return `${workId}:${relayScopeId}`;
}

/**
 * Keep browser-session and grant identifiers out of durable settlement evidence
 * while preserving the exact retry boundary: a changed session or grant set may
 * be retried, an unchanged failed attempt may not.
 */
export function chatgptControllerRoundSettlementAttemptIdentity(input: {
  browserSessionId: string;
  authorizationGrantRefs?: readonly string[];
}): string {
  const identity = {
    browserSessionId: input.browserSessionId.trim(),
    authorizationGrantRefs: [...new Set((input.authorizationGrantRefs ?? [])
      .map((grantRef) => grantRef.trim())
      .filter(Boolean))].sort(),
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

export function getChatgptControllerRoundSettlement(
  options: { controllerHome: string; repoId: string },
  input: { workId: string; relayScopeId: string },
): ChatgptControllerRoundSettlement | undefined {
  return readControlPlaneRecord<ChatgptControllerRoundSettlement>(
    options.controllerHome,
    NAMESPACE,
    options.repoId,
    settlementKey(input.workId, input.relayScopeId),
  )?.value;
}

export function recordChatgptControllerRoundSettlement(
  options: { controllerHome: string; repoId: string; now?: () => string },
  input: {
    workId: string;
    relayScopeId: string;
    status: ChatgptControllerRoundSettlementStatus;
    error?: string;
    attemptIdentity?: string;
  },
): ChatgptControllerRoundSettlement {
  const key = settlementKey(input.workId, input.relayScopeId);
  return withControllerLock(options.controllerHome, { scope: 'task', repoId: options.repoId, taskId: `chatgpt-round-settlement-${input.workId}` }, `chatgpt-round-settlement:${key}`, () => {
    const existing = readControlPlaneRecord<ChatgptControllerRoundSettlement>(options.controllerHome, NAMESPACE, options.repoId, key);
    const error = input.error?.trim().slice(0, 2_000) || undefined;
    const attemptIdentity = input.attemptIdentity?.trim().slice(0, 200) || undefined;
    if (
      existing?.value.status === input.status
      && existing.value.error === error
      && existing.value.attemptIdentity === attemptIdentity
    ) return existing.value;
    const value: ChatgptControllerRoundSettlement = {
      schemaVersion: 1,
      repoId: options.repoId,
      workId: input.workId,
      relayScopeId: input.relayScopeId,
      status: input.status,
      recordedAt: options.now?.() ?? new Date().toISOString(),
      ...(error ? { error } : {}),
      ...(attemptIdentity ? { attemptIdentity } : {}),
    };
    writeControlPlaneRecord(options.controllerHome, { namespace: NAMESPACE, scope: options.repoId, key, schemaVersion: 1, value, action: 'chatgpt_controller_round_settlement', expectedRevision: existing?.revision ?? null });
    return value;
  });
}
