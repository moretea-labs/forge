import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  closeSetupSession,
  openSetupSession,
  readSetupSession,
  type InitHookReport,
} from '../../src/cli/commands/init-hook';

function report(status: InitHookReport['status'], withAction = false): InitHookReport {
  return {
    version: 1,
    status,
    target: 'both',
    checkUpdates: false,
    summary: {
      ok: status === 'ok' ? 1 : 0,
      warn: status === 'attention' ? 1 : 0,
      fail: status === 'blocked' ? 1 : 0,
      na: 0,
      needs_agent: withAction ? 1 : 0,
    },
    checks: [],
    agent_actions: withAction ? [{
      id: 'runtime.install',
      status: 'needs_agent',
      reason: 'Install the canonical Forge Runtime service.',
      requires_agent: true,
      risk: 'Installs a user-level launchd service.',
      command: 'forge runtime service install',
      verification: 'forge setup next',
    }] : [],
  };
}

describe('Forge setup session', () => {
  test('opens and resumes one durable session while exposing one next action', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-setup-session-'));
    try {
      const first = openSetupSession({
        setupRoot: root,
        report: report('attention', true),
        uuid: () => 'setup-session-1',
        now: () => new Date('2026-08-06T10:00:00.000Z'),
      });
      const resumed = openSetupSession({
        setupRoot: root,
        report: report('attention', true),
        uuid: () => 'should-not-be-used',
        now: () => new Date('2026-08-06T10:01:00.000Z'),
      });
      expect(first).toMatchObject({ status: 'open', sessionId: 'setup-session-1', nextAction: { id: 'runtime.install' } });
      expect(resumed.sessionId).toBe(first.sessionId);
      expect(readSetupSession({ setupRoot: root })?.updatedAt).toBe('2026-08-06T10:01:00.000Z');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses normal close until the verified checklist is ready', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-setup-close-'));
    try {
      const open = closeSetupSession({
        setupRoot: root,
        report: report('attention', true),
        uuid: () => 'setup-session-2',
        now: () => new Date('2026-08-06T10:00:00.000Z'),
      });
      expect(open.status).toBe('open');
      expect(open.closedAt).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('closes after re-check proves all setup requirements ready', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-setup-ready-'));
    try {
      openSetupSession({
        setupRoot: root,
        report: report('attention', true),
        uuid: () => 'setup-session-3',
        now: () => new Date('2026-08-06T10:00:00.000Z'),
      });
      const closed = closeSetupSession({
        setupRoot: root,
        report: report('ok'),
        now: () => new Date('2026-08-06T10:02:00.000Z'),
      });
      expect(closed).toMatchObject({ status: 'closed', sessionId: 'setup-session-3', closedAt: '2026-08-06T10:02:00.000Z' });
      expect(closed.nextAction).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
