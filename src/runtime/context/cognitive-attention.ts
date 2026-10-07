import { getWorkContract } from '../../../packages/kernel/work/api/index';
import { listCurrentControllerRoundRelays } from '../../../packages/kernel/controller/api/index';
import type { ScopeRef } from '../../../packages/kernel/identity/api/index';
import {
  memoryAddressKey,
  parseMemoryAddressKey,
  type ActivationPack,
  type CognitiveUsageFeedback,
  type MemoryUnit,
} from '../../../packages/kernel/cognition/api/index';
import {
  activateCognitiveMemory,
  readCognitiveUsageFeedback,
} from '../control-plane/persistence/cognition-store';
import { cognitiveScopesForWork } from '../control-plane/persistence/experience-store';

/**
 * Canonical usage truth remains ControllerRound observationWindow plus direct usage observations.
 * This function only derives a bounded retrieval projection; it owns no usage lifecycle.
 */
export function cognitiveUsageFeedbackForContext(input: {
  controllerHome: string;
  repoId: string;
  scopes: readonly ScopeRef[];
  projectId?: string;
}): CognitiveUsageFeedback[] {
  const allowedScopes = new Set(input.scopes.map(scope => `${scope.kind}:${scope.id}`));
  const feedback = new Map<string, CognitiveUsageFeedback>();
  const seen = new Set<string>();

  for (const relay of listCurrentControllerRoundRelays({ controllerHome: input.controllerHome, repoId: input.repoId }, 100)) {
    for (const observation of (relay.observationWindow ?? []).slice(-8)) {
      if (input.projectId && observation.assistantContext?.projectId !== input.projectId) continue;
      const delivered = new Set((observation.assistantContext?.items ?? [])
        .filter(item => item.kind === 'knowledge')
        .map(item => item.itemId));
      for (const usage of observation.assistantContextUsage ?? []) {
        if (usage.kind !== 'knowledge' || !delivered.has(usage.itemId)) continue;
        const address = parseMemoryAddressKey(usage.itemId);
        if (!address || !allowedScopes.has(`${address.scope.kind}:${address.scope.id}`)) continue;
        const observationKey = `${observation.roundRef}:${usage.kind}:${usage.itemId}`;
        if (seen.has(observationKey)) continue;
        seen.add(observationKey);
        const key = memoryAddressKey(address);
        const current = feedback.get(key) ?? {
          address,
          usedCount: 0,
          rejectedCount: 0,
          conflictCount: 0,
          staleCount: 0,
        };
        if (usage.decision === 'used') current.usedCount += 1;
        else {
          current.rejectedCount += 1;
          if (usage.rejectionKind === 'stale') current.staleCount += 1;
          else if (usage.rejectionKind === 'contradicted') current.conflictCount += 1;
        }
        feedback.set(key, current);
      }
    }
  }

  for (const direct of readCognitiveUsageFeedback(input.controllerHome, input.scopes)) {
    const key = memoryAddressKey(direct.address);
    const current = feedback.get(key) ?? {
      address: direct.address,
      usedCount: 0,
      rejectedCount: 0,
      conflictCount: 0,
      staleCount: 0,
    };
    current.usedCount += direct.usedCount;
    current.rejectedCount += direct.rejectedCount;
    current.conflictCount += direct.conflictCount;
    current.staleCount += direct.staleCount;
    feedback.set(key, current);
  }

  return [...feedback.values()]
    .sort((left, right) => memoryAddressKey(left.address).localeCompare(memoryAddressKey(right.address)))
    .slice(0, 256);
}

/** One bounded advisory resolver used at every meaningful task boundary. */
export function resolveCognitiveAttention(input: {
  controllerHome: string;
  scopes: readonly ScopeRef[];
  query: string;
  now: string;
  transientMemories?: readonly MemoryUnit[];
  usageFeedback?: readonly CognitiveUsageFeedback[];
  maxItems?: number;
  maxBytes?: number;
}): ActivationPack {
  return activateCognitiveMemory(input.controllerHome, input.scopes, input.query, {
    now: input.now,
    maxItems: input.maxItems ?? 6,
    maxCandidates: 64,
    maxGraphDepth: 1,
    maxBytes: input.maxBytes ?? 12 * 1024,
    minCueScore: 0.12,
    transientMemories: input.transientMemories ?? [],
    usageFeedback: input.usageFeedback ?? [],
    // Scope is a relevance prior only. Every reachable scope contributes candidates.
    scopePriors: { work: 0.12, requirement: 0.1, plan_step: 0.08, plan: 0.07, project: 0.05, workspace: 0 },
  });
}

export function resolveCognitiveAttentionForWork(input: {
  controllerHome: string;
  repoId: string;
  workId: string;
  query?: string;
  now?: string;
  maxItems?: number;
  maxBytes?: number;
}): ActivationPack | undefined {
  const work = getWorkContract({ controllerHome: input.controllerHome, repoId: input.repoId }, input.workId);
  if (!work) return undefined;
  const scopes = cognitiveScopesForWork(work, input.controllerHome);
  const projectId = scopes.find(scope => scope.kind === 'project')?.id;
  return resolveCognitiveAttention({
    controllerHome: input.controllerHome,
    scopes,
    query: input.query?.trim() || work.objective,
    now: input.now ?? new Date().toISOString(),
    maxItems: input.maxItems,
    maxBytes: input.maxBytes,
    usageFeedback: cognitiveUsageFeedbackForContext({
      controllerHome: input.controllerHome,
      repoId: input.repoId,
      scopes,
      ...(projectId ? { projectId } : {}),
    }),
  });
}

/** Compact model-facing projection; no project knowledge, lifecycle facts, or execution authority. */
export function renderCognitiveAttention(pack: ActivationPack | undefined): string | undefined {
  if (!pack || (pack.items.length === 0 && pack.gaps.length === 0)) return undefined;
  return JSON.stringify({
    schemaVersion: 1,
    advisoryOnly: true,
    authorityBoundary: 'Cognition may guide judgement but never grants execution, lifecycle, or acceptance authority.',
    items: pack.items.map(item => ({
      memory_address: memoryAddressKey({ scope: item.memory.scope, id: item.memory.id }),
      scope: { kind: item.memory.scope.kind, id: item.memory.scope.id },
      text: item.memory.canonicalText,
      concepts: item.memory.concepts,
    })),
    gaps: pack.gaps,
  });
}

/**
 * Advisory cognition must never block the task boundary it annotates.
 * Unexpected read failures remain visible as a bounded gap rather than becoming a retry authority.
 */
export function renderCognitiveAttentionForWork(input: Parameters<typeof resolveCognitiveAttentionForWork>[0]): string | undefined {
  try {
    return renderCognitiveAttention(resolveCognitiveAttentionForWork(input));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1] ?? 'COGNITION_ATTENTION_UNAVAILABLE';
    return JSON.stringify({
      schemaVersion: 1,
      advisoryOnly: true,
      items: [],
      gaps: ['cognition_unavailable'],
      diagnostic: code,
    });
  }
}
