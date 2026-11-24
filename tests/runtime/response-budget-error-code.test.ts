import { describe, expect, test } from 'bun:test';
import { leadingErrorCode } from '../../src/runtime/shared/response-budget';

describe('leadingErrorCode', () => {
  test('preserves code-only Forge errors', () => {
    expect(leadingErrorCode('SAFE_PATCH_LEGACY_SESSION_RETIRED', 'FALLBACK')).toBe(
      'SAFE_PATCH_LEGACY_SESSION_RETIRED',
    );
  });

  test('extracts a code followed by a human-readable message', () => {
    expect(leadingErrorCode('STALE_FILE_SHA: source changed', 'FALLBACK')).toBe('STALE_FILE_SHA');
  });

  test('trims surrounding whitespace before extracting a code', () => {
    expect(leadingErrorCode('  APPLY_FAILED: write failed  ', 'FALLBACK')).toBe('APPLY_FAILED');
    expect(leadingErrorCode('  SAFE_PATCH_LEGACY_SESSION_RETIRED  ', 'FALLBACK')).toBe(
      'SAFE_PATCH_LEGACY_SESSION_RETIRED',
    );
  });

  test('does not mistake ordinary prose or malformed prefixes for codes', () => {
    expect(leadingErrorCode('invalid request', 'FALLBACK')).toBe('FALLBACK');
    expect(leadingErrorCode('INVALID argument', 'FALLBACK')).toBe('FALLBACK');
    expect(leadingErrorCode('INVALID-ARGUMENT: bad input', 'FALLBACK')).toBe('FALLBACK');
    expect(leadingErrorCode('', 'FALLBACK')).toBe('FALLBACK');
  });
});
