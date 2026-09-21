import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import { memoryAddressKey } from '../../packages/kernel/cognition/api/index.ts';
import type { ScopeRef } from '../../packages/kernel/identity/api/index.ts';
import { resolveAssistantContext } from '../../src/runtime/context/assistant-context.ts';
import { activateCognitiveMemory } from '../../src/runtime/control-plane/persistence/cognition-store.ts';

export const COGNITIVE_SKILL_RETIREMENT_SCHEMA = 'forge-cognitive-skill-retirement/v1' as const;
export const COGNITIVE_SKILL_RETIREMENT_EVALUATOR_VERSION = 'forge-cognitive-skill-retirement-evaluator/v2' as const;
export const COGNITIVE_SKILL_RETIREMENT_THRESHOLD_SET_ID = 'forge-cognitive-skill-retirement-thresholds/v1' as const;

export type CognitiveSkillMode = 'skill_first' | 'cognitive_only' | 'cognitive_with_skill_fallback';
export type CognitiveSkillDomain =
  | 'ios_product_design'
  | 'interaction_state'
  | 'swiftui_state_performance'
  | 'accessibility_native_controls'
  | 'swift_concurrency'
  | 'ios_design_system';

export interface CognitiveSkillRubric {
  concept: string;
  critical: boolean;
  skillEvidenceTerms: readonly string[];
}

export interface CognitiveSkillScenario {
  id: string;
  domain: CognitiveSkillDomain;
  query: string;
  skillSourceIds: readonly string[];
  rubrics: readonly CognitiveSkillRubric[];
}

export interface CognitiveSkillSource {
  id: string;
  text: string;
  readCount?: number;
}

export interface CognitiveSkillMeasurement {
  scenarioId: string;
  domain: CognitiveSkillDomain;
  mode: CognitiveSkillMode;
  matchedConcepts: string[];
  missingConcepts: string[];
  criticalMissingConcepts: string[];
  noiseConcepts: string[];
  semanticCoverage: number;
  criticalCoverage: number;
  noiseRatio: number;
  contextBytes: number;
  estimatedTokens: number;
  retrievalLatencyMs: number;
  skillReads: number;
  fallbackCount: number;
  fallbackReason?: string;
  recalledMemoryIds: string[];
  cognitiveGaps: string[];
  cognitiveTruncated: boolean;
}

export interface CognitiveSkillAggregate {
  mode: CognitiveSkillMode;
  scenarioCount: number;
  meanSemanticCoverage: number;
  meanCriticalCoverage: number;
  medianContextBytes: number;
  medianEstimatedTokens: number;
  medianRetrievalLatencyMs: number;
  totalSkillReads: number;
  totalFallbackCount: number;
}

export interface CognitiveSkillRetirementGate {
  passed: boolean;
  noCriticalRegression: boolean;
  semanticCoverageWithinTwoPoints: boolean;
  medianContextBytesHalved: boolean;
  zeroSkillReadsForCoveredScenarios: boolean;
  coveredScenarioIds: string[];
  gaps: string[];
}

export interface CognitiveSkillEvaluationReport {
  schemaVersion: typeof COGNITIVE_SKILL_RETIREMENT_SCHEMA;
  evaluatorVersion: typeof COGNITIVE_SKILL_RETIREMENT_EVALUATOR_VERSION;
  thresholdSetId: typeof COGNITIVE_SKILL_RETIREMENT_THRESHOLD_SET_ID;
  protocolDigest: string;
  workspaceId: string;
  scenarioIds: string[];
  measurements: CognitiveSkillMeasurement[];
  aggregates: CognitiveSkillAggregate[];
  retirementGate: CognitiveSkillRetirementGate;
  modelAnswerQuality: 'not_measured';
}

export const COGNITIVE_SKILL_RETIREMENT_THRESHOLDS = Object.freeze({
  fallbackSemanticCoverageMin: 0.8,
  maxSemanticCoverageRegression: 0.02,
  maxMedianContextBytesRatio: 0.5,
} as const);

function rubric(concept: string, critical: boolean, ...skillEvidenceTerms: string[]): CognitiveSkillRubric {
  return Object.freeze({ concept, critical, skillEvidenceTerms: Object.freeze(skillEvidenceTerms) });
}

export const IOS_COGNITIVE_SKILL_SCENARIOS: readonly CognitiveSkillScenario[] = Object.freeze([
  Object.freeze({
    id: 'ios-product-self-explaining-interaction',
    domain: 'ios_product_design',
    query: 'A medication settings and confirmation flow is full of explanatory text. Design the interaction so the interface itself communicates meaning while copy is reserved for rules, risks, limits, and consequences users cannot otherwise see.',
    skillSourceIds: Object.freeze(['ios-engineering']),
    rubrics: Object.freeze([
      rubric('ios.product-design', true, 'user goal', 'user job', 'product decision'),
      rubric('product.user-job', true, 'user goal', 'desired outcome', 'user job'),
      rubric('product.interaction.self-explanatory', true, 'self-explanatory', 'interface itself', 'interaction'),
      rubric('product.copy.invisible-rules', true, 'helper text', 'explanatory text', 'rules', 'risk'),
      rubric('product.decision-cost', false, 'decision', 'default', 'friction'),
      rubric('progressive-disclosure', false, 'progressive disclosure', 'disclosure'),
    ]),
  }),
  Object.freeze({
    id: 'ios-interaction-state-single-owner',
    domain: 'interaction_state',
    query: 'Design an edit flow with cancel, retry, stale state, notifications, widgets, shortcuts and deep links while keeping persisted facts, drafts, presentation state, and external entry points under one coherent owner and write chain.',
    skillSourceIds: Object.freeze(['ios-engineering']),
    rubrics: Object.freeze([
      rubric('interaction.state-contract', true, 'loading', 'failure', 'retry', 'disabled', 'dismiss'),
      rubric('state.single-owner', true, 'single owner', 'source of truth', 'ownership'),
      rubric('state.draft-boundary', true, 'draft', 'commit', 'cancel'),
      rubric('external-surface.projection', true, 'widget', 'notification', 'deep link', 'shortcut'),
      rubric('context-retention', false, 'context', 'navigation'),
      rubric('single-write-chain', true, 'write chain', 'single source', 'persistence'),
    ]),
  }),
  Object.freeze({
    id: 'swiftui-state-ownership-performance',
    domain: 'swiftui_state_performance',
    query: 'A SwiftUI screen duplicates mutable model state, uses unstable list identity, performs sorting and persistence work in body, and lets stale async work overwrite newer UI state. Refactor the ownership and data flow.',
    skillSourceIds: Object.freeze(['ios-engineering', 'swiftui-expert']),
    rubrics: Object.freeze([
      rubric('swiftui.state-ownership', true, '@State', '@Binding', 'ownership', 'source of truth'),
      rubric('swiftui.data-flow', true, 'binding', 'observable', 'data flow'),
      rubric('swiftui.stable-identity', true, 'stable identity', 'ForEach', 'Identifiable'),
      rubric('swiftui.render-performance', false, 'body', 'performance', 'sorting'),
      rubric('async.stale-result', true, 'cancel', 'stale', 'task', 'async'),
      rubric('navigation.owner', false, 'navigation', 'presentation', 'dismiss'),
    ]),
  }),
  Object.freeze({
    id: 'swiftui-native-accessibility',
    domain: 'accessibility_native_controls',
    query: 'Build a SwiftUI action screen using native controls that remains understandable with VoiceOver, Dynamic Type, localization, small screens, keyboard changes, and status that is not communicated by color alone.',
    skillSourceIds: Object.freeze(['ios-engineering', 'swiftui-expert']),
    rubrics: Object.freeze([
      rubric('swiftui.native-controls', true, 'Button', 'native control', 'SwiftUI control'),
      rubric('accessibility.semantics', true, 'accessibility', 'VoiceOver', 'label', 'trait'),
      rubric('dynamic-type', true, 'Dynamic Type', 'text style'),
      rubric('touch-target', false, '44', 'touch target', 'tappable'),
      rubric('localization.layout', false, 'localization', 'localized', 'long text'),
      rubric('api.availability', false, 'availability', '#available', 'fallback'),
    ]),
  }),
  Object.freeze({
    id: 'swift-concurrency-isolation',
    domain: 'swift_concurrency',
    query: 'Fix Swift 6 concurrency issues without blanket MainActor. Inspect actual project concurrency settings, reason about actor isolation, Sendable values, structured concurrency, and Task entry behavior before the first await.',
    skillSourceIds: Object.freeze(['swift-concurrency']),
    rubrics: Object.freeze([
      rubric('swift.concurrency', true, 'strict concurrency', 'Swift 6', 'concurrency'),
      rubric('swift.concurrency.isolation', true, 'isolation', 'actor'),
      rubric('mainactor.ui-ownership', true, '@MainActor', 'main actor', 'UI'),
      rubric('structured-concurrency', true, 'structured concurrency', 'task group', 'async let'),
      rubric('sendable.boundary', true, 'Sendable', 'boundary'),
      rubric('task.entry-isolation', true, 'first await', 'Task', 'synchronous'),
    ]),
  }),
  Object.freeze({
    id: 'ios-design-system-governance',
    domain: 'ios_design_system',
    query: 'Design an iOS design system that separates raw, semantic, and component tokens, keeps one visual definition point, prefers platform defaults, embeds accessibility, and prevents feature-local shadow tokens.',
    skillSourceIds: Object.freeze(['ios-design-system']),
    rubrics: Object.freeze([
      rubric('ios.design-system', true, 'design system', 'component'),
      rubric('design-system.tokens', true, 'token', 'raw token'),
      rubric('design-system.semantic-tokens', true, 'semantic token', 'semantic'),
      rubric('visual.single-source-of-truth', true, 'single source', 'one definition', 'central'),
      rubric('platform.system-first', true, 'system color', 'SF Symbols', 'text style', 'platform'),
      rubric('design-system.accessibility', false, 'accessibility', 'contrast'),
      rubric('design-system.incremental-migration', false, 'migration', 'incremental', 'adopt'),
    ]),
  }),
]);

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 1;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function validateScenario(scenario: CognitiveSkillScenario): void {
  if (!scenario.id.trim() || !scenario.query.trim() || !scenario.skillSourceIds.length || !scenario.rubrics.length) throw new Error('COGNITIVE_SKILL_SCENARIO_INVALID');
  const concepts = scenario.rubrics.map(entry => entry.concept);
  if (new Set(concepts).size !== concepts.length) throw new Error('COGNITIVE_SKILL_SCENARIO_DUPLICATE_CONCEPT');
  for (const entry of scenario.rubrics) {
    if (!entry.concept.trim() || !entry.skillEvidenceTerms.length || entry.skillEvidenceTerms.some(term => !term.trim())) throw new Error('COGNITIVE_SKILL_RUBRIC_INVALID');
  }
}

function protocolDigest(scenarios: readonly CognitiveSkillScenario[]): string {
  return createHash('sha256').update(JSON.stringify(scenarios.map(scenario => ({
    id: scenario.id,
    domain: scenario.domain,
    query: scenario.query,
    skillSourceIds: [...scenario.skillSourceIds],
    rubrics: scenario.rubrics.map(entry => ({ concept: entry.concept, critical: entry.critical, skillEvidenceTerms: [...entry.skillEvidenceTerms] })),
  })))).digest('hex');
}

function allRubrics(scenarios: readonly CognitiveSkillScenario[]): CognitiveSkillRubric[] {
  const byConcept = new Map<string, CognitiveSkillRubric>();
  for (const scenario of scenarios) for (const entry of scenario.rubrics) if (!byConcept.has(entry.concept)) byConcept.set(entry.concept, entry);
  return [...byConcept.values()];
}

function matchSkillConcepts(text: string, rubrics: readonly CognitiveSkillRubric[]): string[] {
  const haystack = normalize(text);
  return rubrics.filter(entry => entry.skillEvidenceTerms.some(term => haystack.includes(normalize(term)))).map(entry => entry.concept);
}

function measurement(input: {
  scenario: CognitiveSkillScenario;
  mode: CognitiveSkillMode;
  matchedConcepts: readonly string[];
  allMatchedConcepts: readonly string[];
  contextBytes: number;
  retrievalLatencyMs: number;
  skillReads: number;
  fallbackCount: number;
  fallbackReason?: string;
  recalledMemoryIds?: readonly string[];
  cognitiveGaps?: readonly string[];
  cognitiveTruncated?: boolean;
}): CognitiveSkillMeasurement {
  const required = input.scenario.rubrics.map(entry => entry.concept);
  const critical = input.scenario.rubrics.filter(entry => entry.critical).map(entry => entry.concept);
  const matched = unique(input.matchedConcepts).filter(concept => required.includes(concept));
  const missing = required.filter(concept => !matched.includes(concept));
  const criticalMissing = critical.filter(concept => !matched.includes(concept));
  const noise = unique(input.allMatchedConcepts).filter(concept => !required.includes(concept));
  const result: CognitiveSkillMeasurement = {
    scenarioId: input.scenario.id,
    domain: input.scenario.domain,
    mode: input.mode,
    matchedConcepts: matched,
    missingConcepts: missing,
    criticalMissingConcepts: criticalMissing,
    noiseConcepts: noise,
    semanticCoverage: ratio(matched.length, required.length),
    criticalCoverage: ratio(critical.length - criticalMissing.length, critical.length),
    noiseRatio: ratio(noise.length, Math.max(1, unique(input.allMatchedConcepts).length)),
    contextBytes: Math.max(0, Math.round(input.contextBytes)),
    estimatedTokens: Math.ceil(Math.max(0, input.contextBytes) / 4),
    retrievalLatencyMs: rounded(input.retrievalLatencyMs),
    skillReads: input.skillReads,
    fallbackCount: input.fallbackCount,
    recalledMemoryIds: unique(input.recalledMemoryIds ?? []),
    cognitiveGaps: unique(input.cognitiveGaps ?? []),
    cognitiveTruncated: Boolean(input.cognitiveTruncated),
  };
  if (input.fallbackReason) result.fallbackReason = input.fallbackReason;
  return result;
}

function selectSkillSources(scenario: CognitiveSkillScenario, sources: readonly CognitiveSkillSource[]): CognitiveSkillSource[] {
  const byId = new Map(sources.map(source => [source.id, source]));
  return scenario.skillSourceIds.map(id => {
    const source = byId.get(id);
    if (!source) throw new Error(`COGNITIVE_SKILL_SOURCE_MISSING:${id}`);
    return source;
  });
}

function skillMeasurement(scenario: CognitiveSkillScenario, sources: readonly CognitiveSkillSource[], universe: readonly CognitiveSkillRubric[]): CognitiveSkillMeasurement {
  const selected = selectSkillSources(scenario, sources);
  const started = performance.now();
  const text = selected.map(source => source.text).join('\n');
  const allMatched = matchSkillConcepts(text, universe);
  return measurement({
    scenario,
    mode: 'skill_first',
    matchedConcepts: allMatched,
    allMatchedConcepts: allMatched,
    contextBytes: Buffer.byteLength(text, 'utf8'),
    retrievalLatencyMs: performance.now() - started,
    skillReads: selected.reduce((total, source) => total + Math.max(1, Math.floor(source.readCount ?? 1)), 0),
    fallbackCount: 0,
  });
}

function cognitiveMeasurement(input: { controllerHome: string; workspaceId: string; scenario: CognitiveSkillScenario }): CognitiveSkillMeasurement {
  const scope: ScopeRef = { schemaVersion: 1, kind: 'workspace', id: input.workspaceId };
  const started = performance.now();
  const pack = activateCognitiveMemory(input.controllerHome, [scope], input.scenario.query, { maxItems: 12, maxCandidates: 96, maxGraphDepth: 2, maxBytes: 16 * 1024 });
  const resolved = resolveAssistantContext({
    query: input.scenario.query,
    sources: [],
    knowledge: { read() { throw new Error('COGNITIVE_SKILL_UNEXPECTED_KNOWLEDGE_READ'); } },
    activation: pack,
  });
  const activationByAddress = new Map(pack.items.map(item => [
    memoryAddressKey({ scope: item.memory.scope, id: item.memory.id }),
    item,
  ]));
  const selected = resolved.items
    .map(item => activationByAddress.get(item.id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const allConcepts = unique(selected.flatMap(item => item.memory.concepts));
  return measurement({
    scenario: input.scenario,
    mode: 'cognitive_only',
    matchedConcepts: allConcepts,
    allMatchedConcepts: allConcepts,
    contextBytes: resolved.bytes,
    retrievalLatencyMs: performance.now() - started,
    skillReads: 0,
    fallbackCount: 0,
    recalledMemoryIds: selected.map(item => item.memory.id),
    cognitiveGaps: unique([...pack.gaps, ...resolved.gaps]),
    cognitiveTruncated: pack.truncated || resolved.truncated,
  });
}

function hybridMeasurement(input: { controllerHome: string; workspaceId: string; scenario: CognitiveSkillScenario; sources: readonly CognitiveSkillSource[]; universe: readonly CognitiveSkillRubric[] }): CognitiveSkillMeasurement {
  const cognitive = cognitiveMeasurement(input);
  const needsFallback = cognitive.criticalMissingConcepts.length > 0 || cognitive.semanticCoverage < COGNITIVE_SKILL_RETIREMENT_THRESHOLDS.fallbackSemanticCoverageMin;
  if (!needsFallback) return { ...cognitive, mode: 'cognitive_with_skill_fallback' };
  const selected = selectSkillSources(input.scenario, input.sources);
  const started = performance.now();
  const text = selected.map(source => source.text).join('\n');
  const skillConcepts = matchSkillConcepts(text, input.universe);
  const allMatched = unique([...cognitive.matchedConcepts, ...cognitive.noiseConcepts, ...skillConcepts]);
  return measurement({
    scenario: input.scenario,
    mode: 'cognitive_with_skill_fallback',
    matchedConcepts: allMatched,
    allMatchedConcepts: allMatched,
    contextBytes: cognitive.contextBytes + Buffer.byteLength(text, 'utf8'),
    retrievalLatencyMs: cognitive.retrievalLatencyMs + performance.now() - started,
    skillReads: selected.reduce((total, source) => total + Math.max(1, Math.floor(source.readCount ?? 1)), 0),
    fallbackCount: 1,
    fallbackReason: cognitive.criticalMissingConcepts.length
      ? `critical_concepts_missing:${cognitive.criticalMissingConcepts.join(',')}`
      : `semantic_coverage_below:${COGNITIVE_SKILL_RETIREMENT_THRESHOLDS.fallbackSemanticCoverageMin}`,
    recalledMemoryIds: cognitive.recalledMemoryIds,
    cognitiveGaps: cognitive.cognitiveGaps,
    cognitiveTruncated: cognitive.cognitiveTruncated,
  });
}

function aggregate(mode: CognitiveSkillMode, measurements: readonly CognitiveSkillMeasurement[]): CognitiveSkillAggregate {
  const rows = measurements.filter(row => row.mode === mode);
  return {
    mode,
    scenarioCount: rows.length,
    meanSemanticCoverage: ratio(rows.reduce((sum, row) => sum + row.semanticCoverage, 0), rows.length),
    meanCriticalCoverage: ratio(rows.reduce((sum, row) => sum + row.criticalCoverage, 0), rows.length),
    medianContextBytes: median(rows.map(row => row.contextBytes)),
    medianEstimatedTokens: median(rows.map(row => row.estimatedTokens)),
    medianRetrievalLatencyMs: rounded(median(rows.map(row => row.retrievalLatencyMs))),
    totalSkillReads: rows.reduce((sum, row) => sum + row.skillReads, 0),
    totalFallbackCount: rows.reduce((sum, row) => sum + row.fallbackCount, 0),
  };
}

export function evaluateCognitiveSkillRetirementGate(measurements: readonly CognitiveSkillMeasurement[]): CognitiveSkillRetirementGate {
  const skill = measurements.filter(row => row.mode === 'skill_first');
  const cognitive = measurements.filter(row => row.mode === 'cognitive_only');
  if (!skill.length || skill.length !== cognitive.length) throw new Error('COGNITIVE_SKILL_GATE_PAIRING_REQUIRED');
  const cognitiveByScenario = new Map(cognitive.map(row => [row.scenarioId, row]));
  const paired = skill.map(baseline => {
    const candidate = cognitiveByScenario.get(baseline.scenarioId);
    if (!candidate) throw new Error(`COGNITIVE_SKILL_GATE_SCENARIO_MISSING:${baseline.scenarioId}`);
    return { baseline, candidate };
  });
  const noCriticalRegression = paired.every(({ baseline, candidate }) => candidate.criticalCoverage >= baseline.criticalCoverage);
  const skillCoverage = skill.reduce((sum, row) => sum + row.semanticCoverage, 0) / skill.length;
  const cognitiveCoverage = cognitive.reduce((sum, row) => sum + row.semanticCoverage, 0) / cognitive.length;
  const semanticCoverageWithinTwoPoints = cognitiveCoverage + COGNITIVE_SKILL_RETIREMENT_THRESHOLDS.maxSemanticCoverageRegression >= skillCoverage;
  const skillMedianBytes = median(skill.map(row => row.contextBytes));
  const cognitiveMedianBytes = median(cognitive.map(row => row.contextBytes));
  const medianContextBytesHalved = cognitiveMedianBytes <= skillMedianBytes * COGNITIVE_SKILL_RETIREMENT_THRESHOLDS.maxMedianContextBytesRatio;
  const coveredScenarioIds = paired
    .filter(({ baseline, candidate }) => candidate.criticalCoverage >= baseline.criticalCoverage && candidate.semanticCoverage + COGNITIVE_SKILL_RETIREMENT_THRESHOLDS.maxSemanticCoverageRegression >= baseline.semanticCoverage)
    .map(({ candidate }) => candidate.scenarioId);
  const covered = new Set(coveredScenarioIds);
  const zeroSkillReadsForCoveredScenarios = cognitive.filter(row => covered.has(row.scenarioId)).every(row => row.skillReads === 0);
  const gaps: string[] = [];
  if (!noCriticalRegression) gaps.push('critical_regression');
  if (!semanticCoverageWithinTwoPoints) gaps.push('semantic_coverage_regression');
  if (!medianContextBytesHalved) gaps.push('context_bytes_not_halved');
  if (!zeroSkillReadsForCoveredScenarios) gaps.push('covered_scenario_skill_read');
  return {
    passed: noCriticalRegression && semanticCoverageWithinTwoPoints && medianContextBytesHalved && zeroSkillReadsForCoveredScenarios,
    noCriticalRegression,
    semanticCoverageWithinTwoPoints,
    medianContextBytesHalved,
    zeroSkillReadsForCoveredScenarios,
    coveredScenarioIds,
    gaps,
  };
}

export function runCognitiveSkillRetirementEvaluation(input: {
  controllerHome: string;
  workspaceId: string;
  skillSources: readonly CognitiveSkillSource[];
  scenarios?: readonly CognitiveSkillScenario[];
  modes?: readonly CognitiveSkillMode[];
}): CognitiveSkillEvaluationReport {
  const scenarios = [...(input.scenarios ?? IOS_COGNITIVE_SKILL_SCENARIOS)];
  scenarios.forEach(validateScenario);
  const modes = unique(input.modes ?? ['skill_first', 'cognitive_only', 'cognitive_with_skill_fallback']) as CognitiveSkillMode[];
  const allowedModes: readonly CognitiveSkillMode[] = ['skill_first', 'cognitive_only', 'cognitive_with_skill_fallback'];
  if (!modes.length || modes.some(mode => !allowedModes.includes(mode))) throw new Error('COGNITIVE_SKILL_MODE_INVALID');
  const universe = allRubrics(scenarios);
  const measurements: CognitiveSkillMeasurement[] = [];
  for (const scenario of scenarios) for (const mode of modes) {
    if (mode === 'skill_first') measurements.push(skillMeasurement(scenario, input.skillSources, universe));
    else if (mode === 'cognitive_only') measurements.push(cognitiveMeasurement({ ...input, scenario }));
    else measurements.push(hybridMeasurement({ ...input, scenario, sources: input.skillSources, universe }));
  }
  const aggregates = modes.map(mode => aggregate(mode, measurements));
  const retirementGate = modes.includes('skill_first') && modes.includes('cognitive_only')
    ? evaluateCognitiveSkillRetirementGate(measurements)
    : { passed: false, noCriticalRegression: false, semanticCoverageWithinTwoPoints: false, medianContextBytesHalved: false, zeroSkillReadsForCoveredScenarios: false, coveredScenarioIds: [], gaps: ['skill_first_and_cognitive_only_required'] };
  return {
    schemaVersion: COGNITIVE_SKILL_RETIREMENT_SCHEMA,
    evaluatorVersion: COGNITIVE_SKILL_RETIREMENT_EVALUATOR_VERSION,
    thresholdSetId: COGNITIVE_SKILL_RETIREMENT_THRESHOLD_SET_ID,
    protocolDigest: protocolDigest(scenarios),
    workspaceId: input.workspaceId,
    scenarioIds: scenarios.map(scenario => scenario.id),
    measurements,
    aggregates,
    retirementGate,
    modelAnswerQuality: 'not_measured',
  };
}
