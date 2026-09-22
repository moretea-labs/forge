import { getControllerSession, releaseObservedControllerSession } from '../../../../packages/kernel/controller/api/index';
import { getWorkContract, isTerminalWorkContractStatus } from '../../../../packages/kernel/work/api/index';
import { listSchedules } from '../../../../packages/kernel/scheduler/api/index';
import type { HandoffItem } from './types';
import {
  acknowledgeHandoffItem,
  createHandoffItem,
  dismissHandoffItem,
  getHandoffItem,
  listHandoffItems,
  resolveHandoffItem,
  type HandoffInboxStoreOptions,
} from './handoff-inbox-store';

export type HandoffInboxApplicationOperation = 'get' | 'list' | 'ack' | 'accept' | 'resolve' | 'dismiss' | 'create';

export interface HandoffInboxApplicationInput {
  operation: HandoffInboxApplicationOperation;
  store: HandoffInboxStoreOptions & { controllerHome: string; repoId: string };
  handoffId?: string;
  limit?: number;
  workId?: string;
  title?: string;
  reason?: string;
  summary?: string;
  attemptedActions?: string[];
  blockingDecision?: string;
  recommendedDecision?: string;
  recommendedPrompt?: string;
  recommendedContinuationPrompt?: string;
  decision?: string;
  resolver?: string;
  controllerIdentity?: { principalId?: string; sessionId?: string };
}

export type HandoffContinuationOccurrence = { scheduleId: string; occurrenceId?: string; status?: string };

export interface HandoffInboxApplicationPorts {
  triggerResolvedContinuation(item: ReturnType<typeof resolveHandoffItem>): Promise<HandoffContinuationOccurrence[]>;
}

export type HandoffInboxApplicationRunner = (
  input: HandoffInboxApplicationInput,
) => ReturnType<typeof runHandoffInboxApplication>;

export interface HandoffAttentionResolver {
  workIsTerminal(workId: string): boolean | undefined;
  scheduleIsEnabled(scheduleId: string): boolean | undefined;
}

/**
 * Project durable Inbox history into current attention. Unknown lifecycle state
 * remains visible; only canonical terminal/disabled authority can suppress an
 * old pending record. Persistence is never mutated by this projection.
 */
export function handoffRequiresAttention(item: HandoffItem, resolver: HandoffAttentionResolver): boolean {
  if (item.status !== 'pending') return false;
  const workId = item.workId?.trim();
  if (workId && resolver.workIsTerminal(workId) === true) return false;

  const scheduleId = item.currentState.taskId?.trim();
  const scheduleFailure = item.creationReason === 'repeated_infrastructure_failure'
    && Boolean(scheduleId)
    && (item.id.startsWith('schedule-failure-') || item.id.startsWith('schedule-'));
  if (scheduleFailure && scheduleId && resolver.scheduleIsEnabled(scheduleId) === false) return false;
  return true;
}

export function listHandoffAttentionItems(
  store: HandoffInboxStoreOptions & { controllerHome: string; repoId: string },
  limit = 50,
): HandoffItem[] {
  const candidates = listHandoffItems({ ...store, status: 'pending', limit: 100 });
  const scheduleIds = new Set(candidates
    .filter((item) => item.creationReason === 'repeated_infrastructure_failure'
      && (item.id.startsWith('schedule-failure-') || item.id.startsWith('schedule-')))
    .map((item) => item.currentState.taskId?.trim())
    .filter((value): value is string => Boolean(value)));
  const schedules = scheduleIds.size > 0
    ? new Map(listSchedules(store.controllerHome, store.repoId).map((schedule) => [schedule.scheduleId, schedule.enabled] as const))
    : new Map<string, boolean>();
  const resolver: HandoffAttentionResolver = {
    workIsTerminal: (workId) => {
      const work = getWorkContract(store, workId);
      return work ? isTerminalWorkContractStatus(work.status) : undefined;
    },
    scheduleIsEnabled: (scheduleId) => scheduleIds.has(scheduleId)
      ? schedules.get(scheduleId) ?? false
      : undefined,
  };
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
  return candidates.filter((item) => handoffRequiresAttention(item, resolver)).slice(0, boundedLimit);
}

/**
 * Canonical application boundary for Inbox behavior. MCP adapters translate
 * arguments/results only; Handoff persistence, continuation wake-up and exact
 * Controller ownership release remain here.
 */
export async function runHandoffInboxApplication(input: HandoffInboxApplicationInput, ports: HandoffInboxApplicationPorts) {
  const { store, operation } = input;
  if (operation === 'get') return { operation, item: getHandoffItem(store, input.handoffId ?? '') };
  if (operation === 'list') {
    return { operation, items: listHandoffAttentionItems(store, input.limit ?? 50) };
  }
  if (operation === 'ack' || operation === 'accept') {
    return { operation, item: acknowledgeHandoffItem(store, (input.handoffId ?? '').trim()) };
  }
  if (operation === 'resolve') {
    const item = resolveHandoffItem(store, (input.handoffId ?? '').trim(), {
      decision: input.decision ?? 'resolved',
      resolver: input.resolver ?? 'chatgpt',
    });
    const continuationOccurrences = item.workId ? await ports.triggerResolvedContinuation(item) : [];
    return { operation, item, continuationOccurrences };
  }
  if (operation === 'dismiss') {
    const item = dismissHandoffItem(store, (input.handoffId ?? '').trim(), {
      decision: input.decision ?? 'dismissed',
      resolver: input.resolver ?? 'chatgpt',
    });
    return { operation, item };
  }

  const id = (input.handoffId ?? `hnd-${Date.now()}`).trim();
  const item = createHandoffItem(store, {
    id,
    repoId: store.repoId,
    workId: input.workId,
    title: input.title ?? 'Controller handoff',
    severity: 'needs_review',
    creationReason: 'ambiguous_outcome',
    reason: input.reason ?? 'ChatGPT or user judgement is required before continuing.',
    summary: input.summary ?? 'A bounded controller handoff was recorded.',
    currentState: { repoId: store.repoId, statusSummary: 'pending decision', workId: input.workId },
    attemptedActions: input.attemptedActions ?? [],
    evidenceRefs: [],
    blockingDecision: input.blockingDecision,
    recommendedDecision: input.recommendedDecision ?? 'Decide whether to continue, repair, or stop.',
    recommendedPrompt: input.recommendedPrompt ?? `Continue from handoff ${id}.`,
    recommendedContinuationPrompt: input.recommendedContinuationPrompt,
    suggestedNextActions: [],
  });
  let ownershipReleased = false;
  const principalId = input.controllerIdentity?.principalId?.trim();
  const sessionId = input.controllerIdentity?.sessionId?.trim();
  if (item.workId && principalId && sessionId) {
    const owner = getControllerSession(store, item.workId);
    if (owner && owner.controllerId === principalId && owner.sessionId === sessionId) {
      ownershipReleased = releaseObservedControllerSession(store, {
        workId: item.workId,
        actor: `handoff-create:${principalId}`,
        owner,
      }).allowed;
    }
  }
  return { operation, item, ownershipReleased };
}
