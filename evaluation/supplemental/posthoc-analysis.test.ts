import { describe, expect, test } from 'bun:test';
import { deriveSupplementalMetrics } from './posthoc-analysis.ts';

describe('supplemental posthoc analysis', () => {
  test('derives accuracy roles from existing validator evidence without inventing change precision', () => {
    const trial: any = { report: { metrics: { taskSuccessRate: 1, changePrecision: null }, trace: { validation: [
      { id: 'behavior', status: 'passed' }, { id: 'source-repository-unchanged', status: 'passed' },
    ] } } };
    const metrics = deriveSupplementalMetrics(trial, {
      applicableMetrics: ['task_correctness','behavioral_invariant_success','regression_reintroduction_rate','impact_coverage'],
      behavioralInvariantValidatorIds: ['behavior'], regressionGuardValidatorIds: ['behavior'],
      domainCoverage: [{ domain: 'routing', validatorIds: ['behavior'] }],
    } as any);
    expect(metrics).toEqual({ task_correctness: 1, behavioral_invariant_success: 1, regression_reintroduction_rate: 0, impact_coverage: 1 });
    expect(metrics.change_precision).toBeUndefined();
  });

  test('fails closed when a declared oracle is absent', () => {
    const trial: any = { report: { metrics: { taskSuccessRate: 1, changePrecision: 1 }, trace: { validation: [] } } };
    expect(() => deriveSupplementalMetrics(trial, {
      applicableMetrics: ['behavioral_invariant_success'], behavioralInvariantValidatorIds: ['missing'], regressionGuardValidatorIds: ['missing'], domainCoverage: [],
    } as any)).toThrow('SUPPLEMENTAL_ORACLE_MISSING:missing');
  });
});
