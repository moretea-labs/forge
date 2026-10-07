import type { ScopeRef } from '../../../packages/kernel/identity/api/index';
import type { ActivationPack, MemoryUnit } from '../../../packages/kernel/cognition/api/index';
import { activateCognitiveMemory } from '../control-plane/persistence/cognition-store';
import type { CognitiveUsageFeedback } from '../../../packages/kernel/cognition/api/index';

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
    // Preference is deliberately modest: relevance can promote Workspace over
    // an irrelevant narrow lexical hit, unlike the former fallback algorithm.
    scopePriors: { work: 0.12, requirement: 0.1, plan_step: 0.08, plan: 0.07, project: 0.05, workspace: 0 },
  });
}
