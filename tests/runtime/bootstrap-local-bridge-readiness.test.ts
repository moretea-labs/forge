import { describe, expect, test } from 'bun:test';
import { classifyBootstrapReadiness } from '../../src/cli/local-bridge/facade-api';
import type { BootstrapSnapshot } from '../../src/runtime/control-plane/bootstrap';

function snapshot(status: BootstrapSnapshot['status'], blockerKind?: BootstrapSnapshot['blockers'][number]['kind']): BootstrapSnapshot {
  return {
    schemaVersion: 1, status, revision: 1, stateFingerprint: 'f', controllerHome: '/tmp/forge',
    desired: { schemaVersion: 1, primaryController: 'chatgpt', controllers: ['chatgpt'], connectivity: { mode: 'remote' }, capabilityIntents: [] },
    observations: [], actions: [], steps: [],
    blockers: blockerKind ? [{ code: 'B', kind: blockerKind, stepId: 'setup', summary: 'blocked', actionIds: [] }] : [],
    createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z',
  };
}

describe('Local Bridge V2 bootstrap readiness projection', () => {
  test('treats missing or recoverable bootstrap state as setup work, not a system crash', () => {
    expect(classifyBootstrapReadiness({ runtimeReady: false, repositoryEnabled: true })).toBe('needs_setup');
    expect(classifyBootstrapReadiness({ bootstrap: snapshot('blocked', 'automatic_retry'), runtimeReady: false, repositoryEnabled: true })).toBe('needs_setup');
    expect(classifyBootstrapReadiness({ bootstrap: snapshot('blocked', 'user_action'), runtimeReady: false, repositoryEnabled: true })).toBe('needs_setup');
  });

  test('blocks only fatal bootstrap state or live Runtime loss after bootstrap was ready', () => {
    expect(classifyBootstrapReadiness({ bootstrap: snapshot('blocked', 'unsupported'), runtimeReady: false, repositoryEnabled: true })).toBe('blocked');
    expect(classifyBootstrapReadiness({ bootstrap: snapshot('blocked', 'failed'), runtimeReady: true, repositoryEnabled: true })).toBe('blocked');
    expect(classifyBootstrapReadiness({ bootstrap: snapshot('ready'), runtimeReady: false, repositoryEnabled: true })).toBe('blocked');
  });

  test('requires both ready bootstrap and enabled repository for ready state', () => {
    expect(classifyBootstrapReadiness({ bootstrap: snapshot('ready'), runtimeReady: true, repositoryEnabled: true })).toBe('ready');
    expect(classifyBootstrapReadiness({ bootstrap: snapshot('ready'), runtimeReady: true, repositoryEnabled: false })).toBe('needs_setup');
  });
});
