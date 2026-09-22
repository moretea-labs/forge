import { describe, expect, test } from 'bun:test';
import {
  classifyFailureCode,
  describeFailure,
  httpStatusForFailureCode,
} from '../../packages/protocols/failure';
import { classifyUserFacingError } from '../../src/runtime/control-plane/facade/operation-digest';

describe('Failure Contract authority', () => {
  test('typed and bounded legacy transport codes drive retry, not arbitrary prose', () => {
    expect(describeFailure({ code: 'ECONNRESET', message: 'socket closed' })).toMatchObject({
      code: 'ECONNRESET',
      provenance: 'typed_code',
      retryDisposition: 'transient',
    });
    expect(describeFailure(new Error('EPIPE: broken pipe'))).toMatchObject({
      code: 'EPIPE',
      provenance: 'legacy_code_prefix',
      retryDisposition: 'transient',
    });
    expect(describeFailure(new Error('temporary worker network problem'), { fallbackCode: 'WORKER_EXECUTION_FAILED' })).toMatchObject({
      code: 'WORKER_EXECUTION_FAILED',
      provenance: 'fallback',
      retryDisposition: 'never',
    });
  });

  test('explicit outcome-unknown failures require reconciliation rather than blind retry', () => {
    expect(describeFailure({ code: 'PLUGIN_MUTATION_OUTCOME_UNKNOWN', message: 'remote outcome unknown' }).retryDisposition)
      .toBe('reconcile_before_retry');
  });

  test('mobile HTTP status is projected from stable codes', () => {
    expect(httpStatusForFailureCode('MOBILE_INTENT_RATE_LIMITED')).toBe(429);
    expect(httpStatusForFailureCode('MOBILE_INTENT_SCOPE_DENIED')).toBe(403);
    expect(httpStatusForFailureCode('MOBILE_INTENT_SIGNATURE_INVALID')).toBe(401);
    expect(httpStatusForFailureCode('MOBILE_INTENT_ACTION_REQUIRED')).toBe(400);
  });

  test('structured user-facing failure class wins over misleading prose', () => {
    expect(classifyFailureCode('WORK_NOT_FOUND')).toBe('not_found');
    expect(classifyUserFacingError({
      code: 'WORK_NOT_FOUND',
      message: 'timeout worker network failure that should not override the code',
    })).toBe('not_found');
  });

  test('legacy prose classification remains presentation compatibility only', () => {
    expect(classifyUserFacingError({ message: 'authorization required before continuing' })).toBe('approval_required');
  });
});
