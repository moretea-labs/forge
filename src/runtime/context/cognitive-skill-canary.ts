import type { AssistantContextResolution } from './assistant-context';

export const COGNITIVE_SKILL_CANARY_VERSION = 'forge-cognitive-skill-canary/v1' as const;
const MIN_PRIMARY_ACTIVATION_SCORE = 1;
const MIN_PRIMARY_CRITICAL_MATCHES = 2;

export type CognitiveSkillCanaryGate = 'covered' | 'fallback';

export interface CognitiveSkillCanaryProfile {
  id: string;
  evaluationGate: CognitiveSkillCanaryGate;
  semanticSkillIds: readonly string[];
  criticalConcepts: readonly string[];
}

export interface CognitiveSkillCanaryClassification {
  profileId: string;
  status: CognitiveSkillCanaryGate;
  evaluationGate: CognitiveSkillCanaryGate;
  semanticSkillIds: string[];
  matchedCriticalConcepts: string[];
  missingCriticalConcepts: string[];
  primaryMemoryId: string;
  primaryScore: number;
}

export const COGNITIVE_SKILL_CANARY_PROFILES: readonly CognitiveSkillCanaryProfile[] = Object.freeze([
  Object.freeze({
    id: 'ios-product-self-explaining-interaction',
    evaluationGate: 'fallback' as const,
    semanticSkillIds: Object.freeze(['ios-engineering']),
    criticalConcepts: Object.freeze([
      'ios.product-design',
      'product.user-job',
      'product.interaction.self-explanatory',
      'product.copy.invisible-rules',
    ]),
  }),
  Object.freeze({
    id: 'ios-interaction-state-single-owner',
    evaluationGate: 'covered' as const,
    semanticSkillIds: Object.freeze(['ios-engineering']),
    criticalConcepts: Object.freeze([
      'interaction.state-contract',
      'state.single-owner',
      'state.draft-boundary',
      'external-surface.projection',
      'single-write-chain',
    ]),
  }),
  Object.freeze({
    id: 'swiftui-state-ownership-performance',
    evaluationGate: 'covered' as const,
    semanticSkillIds: Object.freeze(['ios-engineering', 'swiftui-expert']),
    criticalConcepts: Object.freeze([
      'swiftui.state-ownership',
      'swiftui.data-flow',
      'swiftui.stable-identity',
      'async.stale-result',
    ]),
  }),
  Object.freeze({
    id: 'swiftui-native-accessibility',
    evaluationGate: 'covered' as const,
    semanticSkillIds: Object.freeze(['ios-engineering', 'swiftui-expert']),
    criticalConcepts: Object.freeze([
      'swiftui.native-controls',
      'accessibility.semantics',
      'dynamic-type',
    ]),
  }),
  Object.freeze({
    id: 'swift-concurrency-isolation',
    evaluationGate: 'covered' as const,
    semanticSkillIds: Object.freeze(['swift-concurrency']),
    criticalConcepts: Object.freeze([
      'swift.concurrency',
      'swift.concurrency.isolation',
      'mainactor.ui-ownership',
      'structured-concurrency',
      'sendable.boundary',
      'task.entry-isolation',
    ]),
  }),
  Object.freeze({
    id: 'ios-design-system-governance',
    evaluationGate: 'covered' as const,
    semanticSkillIds: Object.freeze(['ios-design-system']),
    criticalConcepts: Object.freeze([
      'ios.design-system',
      'design-system.tokens',
      'design-system.semantic-tokens',
      'visual.single-source-of-truth',
      'platform.system-first',
    ]),
  }),
]);

function overlap(concepts: ReadonlySet<string>, required: readonly string[]): string[] {
  return required.filter((concept) => concepts.has(concept));
}

export function classifyCognitiveSkillCanary(context: AssistantContextResolution): CognitiveSkillCanaryClassification | undefined {
  const primary = context.items.find((item) => item.activation);
  if (!primary?.activation || primary.activation.score < MIN_PRIMARY_ACTIVATION_SCORE) return undefined;

  const primaryConcepts = new Set(primary.activation.concepts);
  const ranked = COGNITIVE_SKILL_CANARY_PROFILES
    .map((profile) => {
      const matched = overlap(primaryConcepts, profile.criticalConcepts);
      return { profile, matched, ratio: matched.length / profile.criticalConcepts.length };
    })
    .filter((candidate) => candidate.matched.length >= MIN_PRIMARY_CRITICAL_MATCHES)
    .sort((left, right) =>
      right.ratio - left.ratio
      || right.matched.length - left.matched.length
      || left.profile.id.localeCompare(right.profile.id));
  const selected = ranked[0];
  if (!selected) return undefined;

  const deliveredConcepts = new Set(context.items.flatMap((item) => item.activation?.concepts ?? []));
  const matchedCriticalConcepts = overlap(deliveredConcepts, selected.profile.criticalConcepts);
  const matchedSet = new Set(matchedCriticalConcepts);
  const missingCriticalConcepts = selected.profile.criticalConcepts.filter((concept) => !matchedSet.has(concept));
  const status: CognitiveSkillCanaryGate = selected.profile.evaluationGate === 'covered' && missingCriticalConcepts.length === 0
    ? 'covered'
    : 'fallback';

  return {
    profileId: selected.profile.id,
    status,
    evaluationGate: selected.profile.evaluationGate,
    semanticSkillIds: [...selected.profile.semanticSkillIds],
    matchedCriticalConcepts,
    missingCriticalConcepts,
    primaryMemoryId: primary.id,
    primaryScore: primary.activation.score,
  };
}

export function cognitiveSkillCanarySignal(context: AssistantContextResolution): string | undefined {
  const result = classifyCognitiveSkillCanary(context);
  if (!result) return undefined;
  const skills = result.semanticSkillIds.join(',');
  if (result.status === 'covered') {
    return `advisory:cognitive_skill_canary:v1:covered:profile=${result.profileId};semantic_skill_read=skip;skills=${skills};procedures=typed_capabilities`;
  }
  const reason = result.missingCriticalConcepts.length > 0
    ? `missing_critical=${result.missingCriticalConcepts.join(',')}`
    : 'evaluation_gate=not_covered';
  return `advisory:cognitive_skill_canary:v1:fallback:profile=${result.profileId};semantic_skill_read=retain;skills=${skills};${reason};procedures=typed_capabilities`;
}

export function applyCognitiveSkillCanary(context: AssistantContextResolution): AssistantContextResolution {
  const signal = cognitiveSkillCanarySignal(context);
  if (!signal || context.gaps.includes(signal)) return context;
  return { ...context, gaps: [...context.gaps, signal] };
}
