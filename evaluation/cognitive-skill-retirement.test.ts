import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { recordCognitiveMemory, type CognitiveWriteAuthorityPort } from '../packages/kernel/cognition/api/index.ts';
import { ensureControllerHome } from '../src/cli/repositories/controller-home.ts';
import { cognitionMemoryStore } from '../src/runtime/control-plane/persistence/cognition-store.ts';
import { applyCognitiveSkillCanary, COGNITIVE_SKILL_CANARY_PROFILES } from '../src/runtime/context/cognitive-skill-canary.ts';
import type { AssistantContextResolution } from '../src/runtime/context/assistant-context.ts';
import { evaluateCognitiveSkillRetirementGate, IOS_COGNITIVE_SKILL_SCENARIOS, runCognitiveSkillRetirementEvaluation, type CognitiveSkillScenario } from './lib/cognitive-skill-retirement.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'forge-cognitive-skill-retirement-'));
  roots.push(root);
  const controllerHome = join(root, 'controller');
  ensureControllerHome(controllerHome);
  const scope = { schemaVersion: 1 as const, kind: 'workspace' as const, id: 'workspace-eval' };
  const authority: CognitiveWriteAuthorityPort = { assertMemoryWrite() {}, assertEdgeWrite() {}, evidenceAvailable() { return true; } };
  const store = cognitionMemoryStore(controllerHome);
  const now = new Date().toISOString();
  recordCognitiveMemory(store, authority, {
    id: 'memory-product', scope,
    facets: ['learning', 'principle', 'source.explicit_human', 'portability.portable'],
    canonicalText: 'Use self explanatory interaction and reserve copy for invisible rules and risks.',
    concepts: ['ios.product-design', 'product.interaction.self-explanatory', 'product.copy.invisible-rules'],
    provenance: { sourceKind: 'controller', sourceId: 'test-product', recordedAt: now, evidenceRefs: [] },
    confidence: 0.95, utility: 0.95, tier: 'hot', validFrom: now, counterEvidenceRefs: [],
  });
  recordCognitiveMemory(store, authority, {
    id: 'memory-state', scope,
    facets: ['learning', 'principle', 'source.explicit_human', 'portability.portable'],
    canonicalText: 'Keep one state owner, explicit draft commit cancel boundaries and one write chain.',
    concepts: ['state.single-owner', 'state.draft-boundary', 'single-write-chain'],
    provenance: { sourceKind: 'controller', sourceId: 'test-state', recordedAt: now, evidenceRefs: [] },
    confidence: 0.95, utility: 0.95, tier: 'hot', validFrom: now, counterEvidenceRefs: [],
  });
  return { controllerHome };
}

const productScenario: CognitiveSkillScenario = {
  id: 'product', domain: 'ios_product_design',
  query: 'self explanatory interaction with copy only for invisible rules and risks',
  skillSourceIds: ['ios'],
  rubrics: [
    { concept: 'ios.product-design', critical: true, skillEvidenceTerms: ['product design'] },
    { concept: 'product.interaction.self-explanatory', critical: true, skillEvidenceTerms: ['self explanatory'] },
    { concept: 'product.copy.invisible-rules', critical: true, skillEvidenceTerms: ['invisible rules'] },
  ],
};

describe('cognitive Skill retirement evaluator', () => {
  test('runs all three modes and Cognitive-only performs zero Skill reads through the real activation store', () => {
    const fx = fixture();
    const report = runCognitiveSkillRetirementEvaluation({
      controllerHome: fx.controllerHome, workspaceId: 'workspace-eval',
      skillSources: [{ id: 'ios', text: 'Product design should be self explanatory and text should focus on invisible rules.' }],
      scenarios: [productScenario],
    });
    expect(report.measurements).toHaveLength(3);
    const cognitive = report.measurements.find(row => row.mode === 'cognitive_only')!;
    expect(cognitive.semanticCoverage).toBe(1);
    expect(cognitive.criticalCoverage).toBe(1);
    expect(cognitive.skillReads).toBe(0);
    expect(cognitive.recalledMemoryIds).toContain('memory-product');
    const hybrid = report.measurements.find(row => row.mode === 'cognitive_with_skill_fallback')!;
    expect(hybrid.fallbackCount).toBe(0);
    expect(hybrid.skillReads).toBe(0);
    expect(report.modelAnswerQuality).toBe('not_measured');
  });

  test('hybrid falls back only when a critical concept is missing', () => {
    const fx = fixture();
    const scenario: CognitiveSkillScenario = {
      ...productScenario, id: 'missing-critical',
      rubrics: [...productScenario.rubrics, { concept: 'progressive-disclosure', critical: true, skillEvidenceTerms: ['progressive disclosure'] }],
    };
    const report = runCognitiveSkillRetirementEvaluation({
      controllerHome: fx.controllerHome, workspaceId: 'workspace-eval',
      skillSources: [{ id: 'ios', text: 'Product design should be self explanatory, preserve invisible rules, and use progressive disclosure.' }],
      scenarios: [scenario],
    });
    const cognitive = report.measurements.find(row => row.mode === 'cognitive_only')!;
    const hybrid = report.measurements.find(row => row.mode === 'cognitive_with_skill_fallback')!;
    expect(cognitive.criticalMissingConcepts).toContain('progressive-disclosure');
    expect(cognitive.skillReads).toBe(0);
    expect(hybrid.fallbackCount).toBe(1);
    expect(hybrid.skillReads).toBe(1);
    expect(hybrid.criticalMissingConcepts).toEqual([]);
  });

  test('canary profiles stay aligned with the frozen scenario critical rubrics and the accepted domain gate', () => {
    const report = JSON.parse(readFileSync(join(import.meta.dir, 'results', 'ios-cognitive-skill-ab-20260921.json'), 'utf8')) as {
      retirementGate: { coveredScenarioIds: string[] };
    };
    const covered = new Set(report.retirementGate.coveredScenarioIds);
    for (const profile of COGNITIVE_SKILL_CANARY_PROFILES) {
      const scenario = IOS_COGNITIVE_SKILL_SCENARIOS.find((candidate) => candidate.id === profile.id);
      expect(scenario).toBeDefined();
      expect([...profile.semanticSkillIds]).toEqual([...(scenario?.skillSourceIds ?? [])]);
      expect([...profile.criticalConcepts].sort()).toEqual(
        (scenario?.rubrics ?? []).filter((rubric) => rubric.critical).map((rubric) => rubric.concept).sort(),
      );
      expect(profile.evaluationGate).toBe(covered.has(profile.id) ? 'covered' : 'fallback');
    }
  });

  test('canary fails toward the product Skill when the primary delivered product memory misses user-job despite noisy SwiftUI context', () => {
    const now = new Date().toISOString();
    const context: AssistantContextResolution = {
      schemaVersion: 1,
      items: [
        {
          kind: 'knowledge', id: 'memory-product', text: 'product', rank: 1100,
          provenance: { uri: 'cognitive:product', modifiedAt: now },
          activation: {
            score: 1.1, reasons: [], path: [], facets: [],
            concepts: ['ios.product-design', 'product.interaction.self-explanatory', 'product.copy.invisible-rules'],
          },
        },
        {
          kind: 'knowledge', id: 'memory-swiftui', text: 'swiftui', rank: 1000,
          provenance: { uri: 'cognitive:swiftui', modifiedAt: now },
          activation: {
            score: 1.05, reasons: [], path: [], facets: [],
            concepts: ['swiftui.state-ownership', 'swiftui.data-flow', 'swiftui.stable-identity', 'async.stale-result'],
          },
        },
      ],
      gaps: [], missingRequiredSources: [], truncated: false, bytes: 1000, estimatedTokens: 250,
    };
    const result = applyCognitiveSkillCanary(context);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toContain('fallback:profile=ios-product-self-explaining-interaction');
    expect(result.gaps[0]).toContain('semantic_skill_read=retain');
    expect(result.gaps[0]).toContain('product.user-job');
  });

  test('canary marks an evaluation-covered interaction context as zero semantic Skill-read while preserving typed procedures', () => {
    const now = new Date().toISOString();
    const context: AssistantContextResolution = {
      schemaVersion: 1,
      items: [{
        kind: 'knowledge', id: 'memory-interaction', text: 'interaction', rank: 1200,
        provenance: { uri: 'cognitive:interaction', modifiedAt: now },
        activation: {
          score: 1.2, reasons: [], path: [], facets: [],
          concepts: ['interaction.state-contract', 'state.single-owner', 'state.draft-boundary', 'external-surface.projection', 'single-write-chain'],
        },
      }],
      gaps: [], missingRequiredSources: [], truncated: false, bytes: 900, estimatedTokens: 225,
    };
    const result = applyCognitiveSkillCanary(context);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toContain('covered:profile=ios-interaction-state-single-owner');
    expect(result.gaps[0]).toContain('semantic_skill_read=skip');
    expect(result.gaps[0]).toContain('procedures=typed_capabilities');
  });

  test('retirement gate keeps dimensions separate and fails on critical regression', () => {
    const fx = fixture();
    const scenario: CognitiveSkillScenario = {
      ...productScenario, id: 'critical-regression',
      rubrics: [...productScenario.rubrics, { concept: 'missing.safety', critical: true, skillEvidenceTerms: ['safety invariant'] }],
    };
    const report = runCognitiveSkillRetirementEvaluation({
      controllerHome: fx.controllerHome, workspaceId: 'workspace-eval',
      skillSources: [{ id: 'ios', text: 'Product design should be self explanatory, preserve invisible rules, and document the safety invariant.' }],
      scenarios: [scenario],
    });
    const gate = evaluateCognitiveSkillRetirementGate(report.measurements);
    expect(gate.noCriticalRegression).toBe(false);
    expect(gate.gaps).toContain('critical_regression');
    expect(gate.passed).toBe(false);
  });
});
