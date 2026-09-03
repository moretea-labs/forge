import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createBootstrapControlApi,
  readBootstrapSnapshot,
  type BootstrapEvaluation,
} from '../../src/runtime/control-plane/bootstrap';

function desired() {
  return {
    schemaVersion: 1 as const,
    primaryController: 'chatgpt' as const,
    controllers: ['chatgpt' as const],
    connectivity: { mode: 'remote' as const, preferredTransport: 'openai-secure-tunnel' as const },
    capabilityIntents: ['browser.automation'],
  };
}

function blockedEvaluation(observedAt = '2026-09-03T00:00:00.000Z'): BootstrapEvaluation {
  return {
    desired: desired(),
    observations: [{ id: 'controller.chatgpt', component: 'controller', status: 'blocked', summary: 'Authentication required.', reasonCodes: ['AUTH_REQUIRED'], observedAt }],
    actions: [{ id: 'controller.chatgpt.authenticate', kind: 'authenticate', owner: 'user', summary: 'Authenticate ChatGPT.' }],
    blockers: [{ code: 'BOOTSTRAP_CHATGPT_AUTH_REQUIRED', kind: 'user_action', stepId: 'controller', summary: 'ChatGPT authentication requires the user.', actionIds: ['controller.chatgpt.authenticate'] }],
    steps: [{ id: 'controller', label: 'Controller', state: 'blocked', dependsOn: [], observationIds: ['controller.chatgpt'], blockerCodes: ['BOOTSTRAP_CHATGPT_AUTH_REQUIRED'], actionIds: ['controller.chatgpt.authenticate'] }],
  };
}

function readyEvaluation(observedAt = '2026-09-03T00:01:00.000Z'): BootstrapEvaluation {
  return {
    desired: desired(),
    observations: [{ id: 'controller.chatgpt', component: 'controller', status: 'ready', summary: 'ChatGPT controller ready.', observedAt }],
    actions: [], blockers: [],
    steps: [{ id: 'controller', label: 'Controller', state: 'ready', dependsOn: [], observationIds: ['controller.chatgpt'], blockerCodes: [], actionIds: [] }],
  };
}

describe('V2 product bootstrap Control API', () => {
  test('persists one bounded idempotent instance-level snapshot and excludes observation timestamps from semantic revision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-bootstrap-control-'));
    try {
      let observedAt = '2026-09-03T00:00:00.000Z';
      const api = createBootstrapControlApi({ controllerHome: root, adapter: { observe: () => blockedEvaluation(observedAt) }, now: () => new Date('2026-09-03T00:00:10.000Z') });
      const first = await api.refresh();
      observedAt = '2026-09-03T00:00:20.000Z';
      const second = await api.refresh();
      expect(first.status).toBe('blocked');
      expect(first.revision).toBe(1);
      expect(second).toEqual(first);
      expect(readBootstrapSnapshot(root)).toEqual(first);
      expect(JSON.stringify(first)).not.toContain('token');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('fences user-only actions and lets Forge-owned repair advance the same lifecycle to ready', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-bootstrap-action-'));
    try {
      let ready = false;
      let performed = 0;
      const repair: BootstrapEvaluation = {
        desired: desired(),
        observations: [{ id: 'runtime', component: 'runtime', status: 'missing', summary: 'Runtime missing.', observedAt: '2026-09-03T00:00:00.000Z' }],
        actions: [{ id: 'runtime.install', kind: 'install', owner: 'forge', summary: 'Install packaged Runtime.' }],
        blockers: [{ code: 'BOOTSTRAP_RUNTIME_MISSING', kind: 'automatic_retry', stepId: 'runtime', summary: 'Runtime must be installed.', actionIds: ['runtime.install'] }],
        steps: [{ id: 'runtime', label: 'Runtime', state: 'blocked', dependsOn: [], observationIds: ['runtime'], blockerCodes: ['BOOTSTRAP_RUNTIME_MISSING'], actionIds: ['runtime.install'] }],
      };
      const api = createBootstrapControlApi({
        controllerHome: root,
        adapter: {
          observe: () => ready ? readyEvaluation() : repair,
          perform: (action) => { expect(action.id).toBe('runtime.install'); performed += 1; ready = true; },
        },
      });
      const afterRepair = await api.act('runtime.install');
      expect(performed).toBe(1);
      expect(afterRepair.status).toBe('ready');
      expect(afterRepair.revision).toBe(2);

      const blockedApi = createBootstrapControlApi({ controllerHome: join(root, 'blocked'), adapter: { observe: () => blockedEvaluation() } });
      expect(blockedApi.act('controller.chatgpt.authenticate')).rejects.toThrow('BOOTSTRAP_USER_ACTION_REQUIRED');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('fails closed on dangling step references instead of persisting an incoherent lifecycle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-bootstrap-invalid-'));
    try {
      const invalid = readyEvaluation();
      invalid.steps[0]!.observationIds = ['missing'];
      const api = createBootstrapControlApi({ controllerHome: root, adapter: { observe: () => invalid } });
      expect(api.refresh()).rejects.toThrow('BOOTSTRAP_OBSERVATION_NOT_FOUND');
      expect(readBootstrapSnapshot(root)).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
