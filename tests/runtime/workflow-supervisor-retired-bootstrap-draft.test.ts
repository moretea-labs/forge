import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowSupervisorControlPlane } from '../../supervisor/control-plane';
import { retiredBootstrapDraftReplacementPrompt } from '../../supervisor/native-browser-adapter';
import { WorkflowSupervisorStore } from '../../supervisor/store';

const roots: string[] = [];
const stores: WorkflowSupervisorStore[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const projectUrl = 'https://chatgpt.com/g/g-p-abc123-forge/project';
const taskInput = (taskId: string, conversationId: string) => ({
  taskId, conversationId, conversationUrl: 'https://chatgpt.com/',
  objective: 'Exercise exact pre-send draft retirement proof.',
  completionContract: { kind: 'model_semantic_completion' },
  continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true },
  userBlockerPolicy: { kind: 'model_semantic_user_blocker' },
});

function fixture(options: { stopOld?: boolean; recordAfterStop?: boolean; oldProjectUrl?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forge-retired-bootstrap-draft-'));
  roots.push(root);
  const store = new WorkflowSupervisorStore(join(root, 'supervisor'));
  stores.push(store);
  const control = new WorkflowSupervisorControlPlane(store);
  const oldTaskId = 'supervisor:retired-bootstrap';
  const currentTaskId = 'supervisor:current-bootstrap';
  control.registerTask(taskInput(oldTaskId, 'bootstrap:' + oldTaskId));
  const oldEffect = control.reserveEnrollment(oldTaskId);
  const draft = oldEffect.prompt;
  const fingerprint = createHash('sha256')
    .update('preflight-composer-v1:' + String.fromCharCode(0) + draft)
    .digest('hex').slice(0, 24);
  const observation = {
    classification: 'current_effect' as const,
    selectorVersion: 'visible-single-v2' as const,
    chars: draft.length,
    fingerprint,
  };
  if (!options.recordAfterStop) store.recordEffectPreparationFailure(oldEffect.effectId, 'COMPUTER_PREPARE_REJECTED', observation);
  if (options.stopOld !== false) control.stopTask(oldTaskId, 'Retire an exact unsent bootstrap draft.');
  if (options.recordAfterStop) store.recordEffectPreparationFailure(oldEffect.effectId, 'COMPUTER_PREPARE_REJECTED', observation);
  control.registerTask(taskInput(currentTaskId, 'bootstrap:' + currentTaskId));
  const currentEffect = control.reserveEnrollment(currentTaskId);
  const projects = new Map<string, string>([
    [oldTaskId, options.oldProjectUrl ?? projectUrl],
    [currentTaskId, projectUrl],
  ]);
  Object.defineProperty(control, 'bootstrapProjectUrl', {
    value: (taskId: string) => {
      const url = projects.get(taskId);
      if (!url) throw new Error('fixture project missing');
      return url;
    },
  });
  const snapshot = {
    url: projectUrl, title: 'Forge', latestUserText: '', latestAssistantResponse: '',
    providerActivityText: '', providerFailureText: '', composerText: draft,
    composerSelectorVersion: 'visible-single-v2', isGenerating: false,
  };
  const replace = (overrides: Record<string, unknown> = {}) =>
    retiredBootstrapDraftReplacementPrompt(
      control, control.getTask(currentTaskId)! as never, { ...snapshot, ...overrides } as never, currentEffect.prompt,
    );
  return { control, oldEffect, currentEffect, draft, fingerprint, replace };
}

test('retired bootstrap replacement requires the canonical pre-terminal no-click digest', () => {
  const f = fixture();
  expect(f.control.preSendComposerObservation(f.oldEffect.effectId)).toMatchObject({
    classification: 'current_effect', selectorVersion: 'visible-single-v2',
    chars: f.draft.length, fingerprint: f.fingerprint,
  });
  expect(f.replace()).toBe(
    '<<<FORGE_RETIRED_DRAFT_V1:' + f.oldEffect.effectId + ':' + f.fingerprint + '>>>\n' + f.currentEffect.prompt,
  );
  expect(f.replace({ composerText: f.draft + '\n' })).toBeUndefined();
  expect(f.replace({ isGenerating: true })).toBeUndefined();
});

test('retired bootstrap replacement rejects foreign projects and nonterminal predecessors', () => {
  expect(fixture({ oldProjectUrl: 'https://chatgpt.com/g/g-p-other-forge/project' }).replace()).toBeUndefined();
  const live = fixture({ stopOld: false });
  expect(live.control.preSendComposerObservation(live.oldEffect.effectId)).toBeUndefined();
  expect(live.replace()).toBeUndefined();
});

test('retired bootstrap replacement rejects no-click evidence recorded after STOPPED', () => {
  const f = fixture({ recordAfterStop: true });
  expect(f.control.preSendComposerObservation(f.oldEffect.effectId)).toBeUndefined();
  expect(f.replace()).toBeUndefined();
});

test('retired bootstrap replacement rejects an effect with any dispatch generation', () => {
  const f = fixture();
  Object.defineProperty(f.control, 'effectDispatchBudget', { value: () => ({ generations: 1 }) });
  expect(f.replace()).toBeUndefined();
});
