import type { EvaluationMetrics, EvaluationScenario, EvaluationTrace, ValidationResult } from './types.ts';

function rate(results: ValidationResult[]): number | null {
  if (results.length === 0) return null;
  return results.filter((result) => result.status === 'passed').length / results.length;
}

export function calculateMetrics(scenario: EvaluationScenario, trace: EvaluationTrace): EvaluationMetrics {
  const observedDomains = new Set([...trace.contextRetrieval, ...trace.inspectedEvidence].map((evidence) => evidence.domain));
  const execution = trace.commands.find((command) => command.kind === 'forge');
  const invariants = trace.validation.filter((result) => result.kind === 'invariant');
  const regressions = trace.validation.filter((result) => result.kind === 'regression');
  const precision = trace.validation.filter((result) => result.kind === 'change_precision');
  return {
    taskSuccessRate: trace.finalResult.status === 'passed' ? 1 : 0,
    impactCoverage: scenario.groundTruth.affectedDomains.length === 0
      ? null
      : scenario.groundTruth.affectedDomains.filter((domain) => observedDomains.has(domain)).length / scenario.groundTruth.affectedDomains.length,
    behavioralInvariantSuccess: rate(invariants),
    regressionReintroductionRate: regressions.length === 0
      ? null
      : 1 - (rate(regressions) ?? 0),
    changePrecision: rate(precision),
    executionLatencyMs: execution?.durationMs ?? null,
    toolInteractionCount: trace.toolInteractions.length,
  };
}
