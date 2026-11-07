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

/**
 * Usage truth comes only from explicit direct learning_feedback observations.
 * Historical Work/ControllerRound data never grants or synthesizes current feedback.
 */
export function cognitiveUsageFeedbackForContext(input: {
  controllerHome: string;
  repoId: string;
  scopes: readonly ScopeRef[];
  projectId?: string;
}): CognitiveUsageFeedback[] {
  const allowedScopes = new Set(input.scopes.map(scope => `${scope.kind}:${scope.id}`));
  const feedback = new Map<string, CognitiveUsageFeedback>();

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
  queryVariants?: readonly string[];
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
    queryVariants: input.queryVariants,
    transientMemories: input.transientMemories ?? [],
    usageFeedback: input.usageFeedback ?? [],
    // Scope is a relevance prior only. Every reachable scope contributes candidates.
    scopePriors: { work: 0.12, requirement: 0.1, plan_step: 0.08, plan: 0.07, project: 0.05, workspace: 0 },
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
