import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { inspectSavedPasswordTarget } from '../../src/runtime/plugins/browser-password-target-policy';

function inspect(config: Record<string, unknown> = {}) {
  class TestInput {
    type = config.type ?? 'password';
    value = config.value ?? '';
    disabled = config.disabled === true;
    readOnly = config.readOnly === true;
    hidden = config.hidden === true;
    isConnected = config.connected !== false;
    parentElement = config.parent ?? null;
    contains(node: unknown) {
      return node === this;
    }
    hasAttribute(k: string) {
      return k === 'inert' && config.inert === true;
    }
    getAttribute(k: string) {
      return k === 'aria-hidden' && config.ariaHidden === true ? 'true' : null;
    }
    getBoundingClientRect() {
      return { left: config.left ?? 30, top: 35, width: config.width ?? 200, height: 35 };
    }
  }
  const input = new TestInput(),
    self = {};
  return runInNewContext('(' + inspectSavedPasswordTarget.toString() + ')(arg)', {
    arg: { selector: '#form-target', kind: config.kind ?? 'password', expectedAccount: 'owner@example.test' },
    HTMLInputElement: TestInput,
    window: { self, top: config.iframe ? {} : self, innerWidth: 800, innerHeight: 600 },
    document: {
      querySelectorAll: () => (config.count === 0 ? [] : config.count === 2 ? [input, new TestInput()] : [input]),
      elementFromPoint: () => (config.covered === true ? {} : input),
    },
    getComputedStyle: () => ({
      display: config.display ?? 'block',
      visibility: config.visibility ?? 'visible',
      opacity: config.opacity ?? '1',
      pointerEvents: config.pointerEvents ?? 'auto',
    }),
  }) as ReturnType<typeof inspectSavedPasswordTarget>;
}

describe('Forge Computer password target fail-closed checks', () => {
  test('valid top-level password field is actionable without returning its value', () => {
    expect(inspect()).toMatchObject({ count: 1, kindValid: true, actionable: true, filled: false });
    const filled = inspect({ value: 'synthetic-password-value' });
    expect(filled).toMatchObject({ password: true, filled: true, actionable: true });
    expect(JSON.stringify(filled)).not.toContain('synthetic-password-value');
  });
  test('hidden, covered, offscreen or transparent pre-filled fields refuse action', () => {
    for (const flags of [
      { hidden: true },
      { display: 'none' },
      { visibility: 'hidden' },
      { opacity: '0' },
      { pointerEvents: 'none' },
      { covered: true },
      { width: 0 },
      { left: 1000 },
      { ariaHidden: true },
    ])
      expect(inspect({ value: 'synthetic-password-value', ...flags }).actionable).toBe(false);
  });
  test('disabled, read-only, inert, detached fields refuse action', () => {
    for (const flags of [{ disabled: true }, { readOnly: true }, { inert: true }, { connected: false }])
      expect(inspect(flags).actionable).toBe(false);
  });
  test('duplicate, missing, wrong-kind or iframe targets refuse action', () => {
    expect(inspect({ count: 2 }).actionable).toBe(false);
    expect(inspect({ count: 0 }).actionable).toBe(false);
    expect(inspect({ type: 'text' }).actionable).toBe(false);
    expect(inspect({ iframe: true }).actionable).toBe(false);
  });
  test('exact account binding is not satisfied by hidden username fields', () => {
    const ok = inspect({ kind: 'account', type: 'email', value: 'owner@example.test' });
    expect(ok).toMatchObject({ kindValid: true, matches: true, actionable: true });
    expect(inspect({ kind: 'account', type: 'email', value: 'owner@example.test', hidden: true })).toMatchObject({
      matches: true,
      actionable: false,
    });
    expect(inspect({ kind: 'account', type: 'email', value: 'other@example.test' }).matches).toBe(false);
    expect(JSON.stringify(ok)).not.toContain('owner@example.test');
  });
  test('stale detached element cannot be accepted as a post-click target', () => {
    expect(inspect().actionable).toBe(true);
    expect(inspect({ connected: false, value: 'synthetic-password-value' }).actionable).toBe(false);
  });
});
