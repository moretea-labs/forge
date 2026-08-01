import { describe, expect, test } from 'bun:test';
import { effectiveVerificationEvidence, verificationInputFingerprint } from '../../src/runtime/control-plane/execution/verification-evidence';

describe('exact-revision verification evidence', () => {
  test('accepts only evidence with the exact revision and check inputs', () => {
    const expected = { sourceRevision: 'a'.repeat(40), checkId: 'package:test', requestedChecks: ['package:test', 'typecheck'] };
    const current = {
      checkId: expected.checkId,
      outcome: 'valid_pass' as const,
      summary: 'passed',
      recordedAt: '2026-08-01T00:00:00.000Z',
      sourceRevision: expected.sourceRevision,
      verificationInputFingerprint: verificationInputFingerprint(expected),
    };
    const staleRevision = { ...current, sourceRevision: 'b'.repeat(40) };
    const staleInputs = { ...current, verificationInputFingerprint: verificationInputFingerprint({ ...expected, requestedChecks: ['package:test'] }) };
    const legacy = { checkId: expected.checkId, outcome: 'valid_pass' as const, summary: 'legacy', recordedAt: current.recordedAt };

    const result = effectiveVerificationEvidence([current, staleRevision, staleInputs, legacy], expected);
    expect(result.map((entry) => entry.current)).toEqual([true, false, false, false]);
    expect(result.slice(1).map((entry) => entry.staleReason)).toEqual([
      `source revision changed: ${'b'.repeat(40)} -> ${'a'.repeat(40)}`,
      'verification inputs changed',
      'legacy evidence has no exact input identity',
    ]);
  });
});
