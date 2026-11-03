import { describe, expect, test } from 'bun:test';
import { redactSensitiveText } from '../../src/runtime/evidence/sensitive-output';

const swiftDataChangeSource = [
  'private var lastConvergedToken = 0.0',
  'func requiresRefresh(for token: Double) -> Bool {',
  '    token != lastConvergedToken',
  '}',
  'func markConverged(token: Double) {',
  '    lastConvergedToken = token',
  '}',
].join('\n');

describe('Swift source redaction preserves type annotations (Issue #280)', () => {
  test('keeps the original short data-change token source byte-for-byte', () => {
    const result = redactSensitiveText(swiftDataChangeSource);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(swiftDataChangeSource);
    expect(result.redactions).toEqual([]);
  });

  test('keeps the same source inside a 320-line repository read', () => {
    const lines = [
      ...Array.from({ length: 12 }, (_, i) => `// harmless header ${i}`),
      ...swiftDataChangeSource.split('\n'),
      ...Array.from({ length: 301 }, (_, i) => `// harmless suffix ${i}`),
    ];
    expect(lines.length).toBe(320);
    const fullText = lines.join('\n');
    const result = redactSensitiveText(fullText);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(fullText);
    expect(result.redactions).toEqual([]);
  });

  test('does not turn real token assignments into an exemption', () => {
    const credentials = [
      'token: synthetic_opaque_value_abc123',
      'api_key=synthetic_key_value_abc123',
      'password="synthetic_password_value_abc123"',
      'authToken: synthetic_auth_value_abc123',
    ].join('\n');
    const result = redactSensitiveText(credentials);
    expect(result.changed).toBe(true);
    expect(result.redactions).toContainEqual({ type: 'secret_assignment', count: 4 });
    for (const credential of [
      'synthetic_opaque_value_abc123',
      'synthetic_key_value_abc123',
      'synthetic_password_value_abc123',
      'synthetic_auth_value_abc123',
    ]) {
      expect(result.text).not.toContain(credential);
    }
  });

  test('preserves known unquoted Swift type names, not opaque token values', () => {
    const source = 'func f(token: Double, otherToken: String, authToken: opaque_value) {}';
    const result = redactSensitiveText(source);
    expect(result.text).toContain('token: Double');
    expect(result.text).toContain('otherToken: String');
    expect(result.text).not.toContain('opaque_value');
  });
});
