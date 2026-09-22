import { expect, test } from 'bun:test';
import { deriveExecutionQualitySignals, type VerificationObservation } from '../../packages/kernel/controller/domain/execution-quality';
const base = { repeatedStateCount: 2, maxRepeatedState: 3, waiting: false, roundRef: 'round:2' };
const check = (evidenceRef: string, outcome: 'passed' | 'failed' = 'passed', sourceDigest = 'source-a'): VerificationObservation => ({ checkId: 'type', sourceDigest, environment: 'env-a', outcome, evidenceRef });

test('warns before blocking only with known absent progress and no legitimate wait', () => {
  expect(deriveExecutionQualitySignals(base)).toEqual([]);
  expect(deriveExecutionQualitySignals({ ...base, hasNewVerifiedProgress: true })).toEqual([]);
  expect(deriveExecutionQualitySignals({ ...base, hasNewVerifiedProgress: false })[0]?.code).toBe('repeated_semantic_state');
  expect(deriveExecutionQualitySignals({ ...base, waiting: true, hasNewVerifiedProgress: false })).toEqual([]);
  expect(deriveExecutionQualitySignals({ ...base, repeatedStateCount: 1, maxRepeatedState: 2, hasNewVerifiedProgress: false })).toHaveLength(1);
});
test('requires three distinct comparable verification receipts', () => {
  expect(deriveExecutionQualitySignals({ ...base, verifications: [check('a'), check('a'), check('a')] })).toEqual([]);
  expect(deriveExecutionQualitySignals({ ...base, verifications: [check('a'), check('b'), check('c')] })[0]?.code).toBe('repeated_verification');
  expect(deriveExecutionQualitySignals({ ...base, verifications: [check('a'), check('b'), { ...check('c'), environment: 'other' }] })).toEqual([]);
});
test('neither intermittent failure nor changed source establishes regression causality', () => {
  for (const source of ['source-a', 'source-b']) {
    const signals = deriveExecutionQualitySignals({ ...base, verifications: [check('a'), check('b', 'failed', source)] });
    expect(signals.map(signal => signal.code)).toEqual(['suspected_regression']);
  }
  expect(deriveExecutionQualitySignals({ ...base, verifications: [check('a'), { ...check('b', 'failed'), environment: '' }] })).toEqual([]);
});
test('root cause hints require two distinct confirmed dispositions within one design scope', () => {
  const cause = { dispositionRef: 'a', rootCauseId: 'root', designScope: 'design-v2', controllerConfirmed: true };
  expect(deriveExecutionQualitySignals({ ...base, rootCauses: [cause, cause] })).toEqual([]);
  expect(deriveExecutionQualitySignals({ ...base, rootCauses: [cause, { ...cause, dispositionRef: 'b', controllerConfirmed: false }] })).toEqual([]);
  expect(deriveExecutionQualitySignals({ ...base, rootCauses: [cause, { ...cause, dispositionRef: 'b' }] })[0]?.code).toBe('repeated_root_cause');
});

test('replayed window receipts do not fabricate repeated checks or duplicate regression hints', () => {
  const observations = [check('a'), check('b', 'failed')];
  const signals = deriveExecutionQualitySignals({ ...base, verifications: [...observations, ...observations, ...observations] });
  expect(signals.map(signal => signal.code)).toEqual(['suspected_regression']);
});
