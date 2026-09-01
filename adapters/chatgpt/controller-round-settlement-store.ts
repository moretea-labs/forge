import { withControllerLock } from '../../src/cli/repositories/locks';
import { readControlPlaneRecord, writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';

const NAMESPACE = 'chatgpt_controller_round_settlement';

export type ChatgptControllerRoundSettlementStatus =
  | 'round_open'
  | 'retained_for_immediate_continuation'
  | 'closed'
  | 'preserved_user_owned'
  | 'session_closed'
  | 'failed';

export interface ChatgptControllerRoundSettlement {
  schemaVersion: 1;
  repoId: string;
  workId: string;
  relayScopeId: string;
  status: ChatgptControllerRoundSettlementStatus;
  recordedAt: string;
  error?: string;
}

export function recordChatgptControllerRoundSettlement(
  options: { controllerHome: string; repoId: string; now?: () => string },
  input: { workId: string; relayScopeId: string; status: ChatgptControllerRoundSettlementStatus; error?: string },
): ChatgptControllerRoundSettlement {
  const key = `${input.workId}:${input.relayScopeId}`;
  return withControllerLock(options.controllerHome, { scope: 'task', repoId: options.repoId, taskId: `chatgpt-round-settlement-${input.workId}` }, `chatgpt-round-settlement:${key}`, () => {
    const existing = readControlPlaneRecord<ChatgptControllerRoundSettlement>(options.controllerHome, NAMESPACE, options.repoId, key);
    const value: ChatgptControllerRoundSettlement = {
      schemaVersion: 1,
      repoId: options.repoId,
      workId: input.workId,
      relayScopeId: input.relayScopeId,
      status: input.status,
      recordedAt: options.now?.() ?? new Date().toISOString(),
      ...(input.error?.trim() ? { error: input.error.trim().slice(0, 2_000) } : {}),
    };
    writeControlPlaneRecord(options.controllerHome, { namespace: NAMESPACE, scope: options.repoId, key, schemaVersion: 1, value, action: 'chatgpt_controller_round_settlement', expectedRevision: existing?.revision ?? null });
    return value;
  });
}
