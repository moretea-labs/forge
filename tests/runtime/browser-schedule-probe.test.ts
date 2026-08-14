import { describe, expect, test } from 'bun:test';
import {
  buildScheduledBrowserFingerprint,
  classifyScheduledBrowserObservation,
} from '../../src/runtime/workflow/schedules/browser-probe';

describe('scheduled browser probe primitives', () => {
  test('fingerprints only selected lines and can strip volatile timestamps', () => {
    const first = buildScheduledBrowserFingerprint([
      '其他邮件 14:02',
      'Apple Support 感谢你提交支持请求。 刚刚',
      '案例 ID CASE-12345 14:03',
    ].join('\n'), ['Apple Support', 'CASE-12345'], ['刚刚', '\\b\\d{1,2}:\\d{2}\\b']);
    const second = buildScheduledBrowserFingerprint([
      '其他邮件 23:59',
      '案例 ID CASE-12345 20:15',
      'Apple Support 感谢你提交支持请求。 15:30',
    ].join('\n'), ['Apple Support', 'CASE-12345'], ['刚刚', '\\b\\d{1,2}:\\d{2}\\b']);

    expect(first.lineCount).toBe(2);
    expect(second.lineCount).toBe(2);
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  test('classifies first observation silently, unchanged state as noop, and later change as wake-worthy', () => {
    const baseline = classifyScheduledBrowserObservation(undefined, 'fp-a');
    expect(baseline).toEqual({ status: 'baseline', shouldWake: false });

    const unchanged = classifyScheduledBrowserObservation('fp-a', 'fp-a');
    expect(unchanged).toEqual({ status: 'unchanged', shouldWake: false });

    const changed = classifyScheduledBrowserObservation('fp-a', 'fp-b');
    expect(changed).toEqual({ status: 'changed', shouldWake: true });

    const explicitFirstWake = classifyScheduledBrowserObservation(undefined, 'fp-a', true);
    expect(explicitFirstWake).toEqual({ status: 'baseline', shouldWake: true });
  });

  test('rejects invalid ignore regex instead of silently corrupting the observation key', () => {
    expect(() => buildScheduledBrowserFingerprint('Apple Support', ['Apple'], ['['])).toThrow('SCHEDULE_BROWSER_PROBE_IGNORE_PATTERN_INVALID');
  });
});
