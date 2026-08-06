import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ensureSlotHome,
  isRollbackWindowOpen,
  markCutoverAuthority,
  markRollbackAuthority,
  oppositeSlot,
  readActiveSlotAuthority,
  readSlotIdentity,
  writeActiveSlotAuthority,
  writeSlotIdentity,
} from '../../src/cli/controller/runtime-slots';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe('runtime slot authority (level 1)', () => {
  test('slot authority requires an explicit root Controller Home', () => {
    const home = temp('repo-harness-slot-authority-root-');
    writeActiveSlotAuthority(home, {
      activeSlot: 'green',
      previousSlot: 'blue',
      generation: 'generation-green',
      reason: 'test-cutover',
    });
    const greenHome = ensureSlotHome(home, 'green');

    expect(readActiveSlotAuthority(home)).toMatchObject({
      activeSlot: 'green',
      previousSlot: 'blue',
      generation: 'generation-green',
    });
    expect(() => readActiveSlotAuthority(greenHome)).toThrow('RUNTIME_SLOT_ROOT_REQUIRED');
    expect(() => ensureSlotHome(greenHome, 'blue')).toThrow('RUNTIME_SLOT_ROOT_REQUIRED');
  });

  test('defaults to blue and keeps distinct slot homes', () => {
    const home = temp('repo-harness-slots-');
    const authority = readActiveSlotAuthority(home);
    expect(authority.activeSlot).toBe('blue');
    const blue = ensureSlotHome(home, 'blue');
    const green = ensureSlotHome(home, 'green');
    expect(blue).not.toBe(green);
    expect(blue).toContain('/runtime-slots/blue');
    expect(green).toContain('/runtime-slots/green');
  });

  test('cutover flips active authority and enables rollback window', () => {
    const home = temp('repo-harness-cutover-');
    writeActiveSlotAuthority(home, { activeSlot: 'blue', reason: 'test' });
    const after = markCutoverAuthority(home, 'green', 'runtime-gen-1', 60_000);
    expect(after.activeSlot).toBe('green');
    expect(after.previousSlot).toBe('blue');
    expect(after.generation).toBe('runtime-gen-1');
    expect(isRollbackWindowOpen(after)).toBe(true);

    const rolled = markRollbackAuthority(home, 'runtime-gen-0');
    expect(rolled.activeSlot).toBe('blue');
    expect(rolled.previousSlot).toBe('green');
  });

  test('opposite slot is deterministic', () => {
    expect(oppositeSlot('blue')).toBe('green');
    expect(oppositeSlot('green')).toBe('blue');
  });

  test('slot identity records role without becoming active authority', () => {
    const home = temp('repo-harness-identity-');
    writeSlotIdentity(home, {
      schemaVersion: 1,
      slot: 'green',
      role: 'candidate',
      controllerHome: home,
      slotHome: ensureSlotHome(home, 'green'),
      mcpPort: 8775,
      localControllerPort: 8776,
      updatedAt: new Date().toISOString(),
      logDir: join(home, 'runtime-slots', 'green', 'logs'),
    });
    expect(readActiveSlotAuthority(home).activeSlot).toBe('blue');
    const identity = readSlotIdentity(home, 'green');
    expect(identity?.resources?.[0]).toMatchObject({
      type: 'runtime_slot',
      owner: { kind: 'runtime_slot' },
      state: 'active',
      path: identity?.slotHome,
    });
  });
});
