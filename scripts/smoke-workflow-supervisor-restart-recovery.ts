import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowSupervisorControlPlane } from '../supervisor/control-plane';
import { SUPERVISOR_BLOCK_END, SUPERVISOR_BLOCK_START } from '../supervisor/protocol';
import { WorkflowSupervisorStore } from '../supervisor/store';

const home = mkdtempSync(join(tmpdir(), 'forge-supervisor-recovery-'));
const validators = { completionContract: async () => ({ valid: true, reason: 'ok' }), userBlockerPolicy: async () => ({ valid: true, reason: 'ok' }) };
const control = () => new WorkflowSupervisorControlPlane(new WorkflowSupervisorStore(home), validators);
const block = (
  action: 'CONTINUE' | 'DONE',
  effectId: string,
  checkpoint: string,
  conversationId: string,
  taskId: string,
) => `${SUPERVISOR_BLOCK_START}\n${JSON.stringify({
  action,
  source_effect_id: effectId,
  checkpoint,
  reason: action === 'DONE' ? 'complete' : 'continue',
  evidence: ['recovery-smoke'],
  conversation_id: conversationId,
  task_id: taskId,
  supervisor_state: action === 'DONE' ? 'done' : 'running',
  active_scope: `goal:${taskId}`,
})}\n${SUPERVISOR_BLOCK_END}`;

try {
  let supervisor = control();
  const conversationId = '99999999-8888-7777-6666-555555555555';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  supervisor.registerTask({ taskId: 'recovery-task', conversationId, conversationUrl, objective: 'Prove restart recovery.', completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {} });
  const enrollment = supervisor.reserveEnrollment('recovery-task');
  let poll = supervisor.browserPoll({ conversationId, conversationUrl });
  assert.equal(poll.command?.mode, 'send'); assert.equal(poll.command?.dispatchGeneration, 1);
  assert.equal(supervisor.browserBeginEffect({ conversationId, conversationUrl, effectId: enrollment.effectId, dispatchId: 'enroll-g1', dispatchGeneration: 1, evidence: { latest_user_text: 'before enrollment', latest_assistant_response: 'existing assistant text' } }).started, true);

  supervisor = control();
  assert.throws(() => supervisor.observeEffect({ effectId: enrollment.effectId, observationId: 'forged-not-applied', outcome: 'not_applied', evidence: { latest_user_text: 'forged' } }), /NOT_APPLIED_PROOF_REQUIRED/);
  poll = supervisor.browserPoll({ conversationId, conversationUrl });
  assert.equal(poll.command?.mode, 'reconcile'); assert.equal(poll.command?.dispatchGeneration, 1);
  supervisor.browserObserveEffect({ conversationId, conversationUrl, effectId: enrollment.effectId, observationId: 'enroll-not-applied', outcome: 'not_applied', evidence: { latest_user_text: 'before enrollment', latest_assistant_response: 'existing assistant text', target_marker_present: false } });
  poll = supervisor.browserPoll({ conversationId, conversationUrl });
  assert.equal(poll.command?.mode, 'send'); assert.equal(poll.command?.dispatchGeneration, 2); assert.equal(poll.command?.effectId, enrollment.effectId);
  assert.equal(supervisor.browserBeginEffect({ conversationId, conversationUrl, effectId: enrollment.effectId, dispatchId: 'enroll-g2', dispatchGeneration: 2, evidence: { latest_user_text: 'before enrollment', latest_assistant_response: 'existing assistant text' } }).started, true);
  supervisor.browserObserveEffect({ conversationId, conversationUrl, effectId: enrollment.effectId, observationId: 'enroll-applied', outcome: 'applied', evidence: { exact_user_message: true } });
  const response1 = block('CONTINUE', enrollment.effectId, 'checkpoint-1', conversationId, 'recovery-task');
  const turn1 = await supervisor.browserObserveAssistant({ conversationId, conversationUrl, responseText: response1 });
  const continuation = turn1.successorEffect!;

  poll = supervisor.browserPoll({ conversationId, conversationUrl });
  assert.equal(poll.command?.effectId, continuation.effectId); assert.equal(poll.command?.dispatchGeneration, 1);
  assert.equal(supervisor.browserBeginEffect({ conversationId, conversationUrl, effectId: continuation.effectId, dispatchId: 'continue-g1', dispatchGeneration: 1, evidence: { latest_user_text: enrollment.prompt, latest_assistant_response: response1 } }).started, true);
  supervisor = control();
  poll = supervisor.browserPoll({ conversationId, conversationUrl }); assert.equal(poll.command?.mode, 'reconcile');
  supervisor.browserObserveEffect({ conversationId, conversationUrl, effectId: continuation.effectId, observationId: 'bad-proof', outcome: 'not_applied', evidence: { latest_user_text: 'conversation drifted', latest_assistant_response: response1, target_marker_present: false } });
  poll = supervisor.browserPoll({ conversationId, conversationUrl }); assert.equal(poll.command?.mode, 'reconcile'); assert.equal(poll.command?.dispatchGeneration, 1);
  supervisor.browserObserveEffect({ conversationId, conversationUrl, effectId: continuation.effectId, observationId: 'good-proof', outcome: 'not_applied', evidence: { latest_user_text: enrollment.prompt, latest_assistant_response: response1, target_marker_present: false } });
  poll = supervisor.browserPoll({ conversationId, conversationUrl }); assert.equal(poll.command?.mode, 'send'); assert.equal(poll.command?.dispatchGeneration, 2); assert.equal(poll.command?.effectId, continuation.effectId);
  assert.equal(supervisor.browserBeginEffect({ conversationId, conversationUrl, effectId: continuation.effectId, dispatchId: 'continue-g2', dispatchGeneration: 2, evidence: { latest_user_text: enrollment.prompt, latest_assistant_response: response1 } }).started, true);
  assert.equal(supervisor.browserBeginEffect({ conversationId, conversationUrl, effectId: continuation.effectId, dispatchId: 'continue-g2-duplicate', dispatchGeneration: 2, evidence: { latest_user_text: enrollment.prompt, latest_assistant_response: response1 } }).started, false);
  supervisor.browserObserveEffect({ conversationId, conversationUrl, effectId: continuation.effectId, observationId: 'continue-applied', outcome: 'applied', evidence: { exact_user_message: true } });

  const response2 = block('CONTINUE', continuation.effectId, 'checkpoint-2', conversationId, 'recovery-task');
  const turn2a = await supervisor.browserObserveAssistant({ conversationId, conversationUrl, responseText: response2 });
  const turn2b = await supervisor.browserObserveAssistant({ conversationId, conversationUrl, responseText: response2 });
  assert.equal(turn2a.successorEffect?.effectId, turn2b.successorEffect?.effectId); assert.equal(turn2b.deduplicated, true);
  const terminalEffect = turn2a.successorEffect!;
  poll = supervisor.browserPoll({ conversationId, conversationUrl });
  assert.equal(supervisor.browserBeginEffect({ conversationId, conversationUrl, effectId: terminalEffect.effectId, dispatchId: 'terminal-g1', dispatchGeneration: poll.command!.dispatchGeneration, evidence: { latest_user_text: continuation.prompt, latest_assistant_response: response2 } }).started, true);
  supervisor.browserObserveEffect({ conversationId, conversationUrl, effectId: terminalEffect.effectId, observationId: 'terminal-applied', outcome: 'applied', evidence: { exact_user_message: true } });
  const done = await supervisor.browserObserveAssistant({ conversationId, conversationUrl, responseText: block('DONE', terminalEffect.effectId, 'done', conversationId, 'recovery-task') });
  assert.equal(done.terminal, true);
  supervisor = control();
  assert.equal(supervisor.browserTasks().length, 0);
  const terminalPoll = supervisor.browserPoll({ conversationId, conversationUrl });
  assert.equal(terminalPoll.terminal, 'DONE'); assert.equal(terminalPoll.command, undefined);

  // Prove the unattended contract across repeated supervisor process/repository
  // re-openings. Every round reconstructs the control plane from durable state,
  // applies exactly one effect, emits CONTINUE, and must publish exactly one
  // successor effect without a user-authored "continue" turn.
  const unattendedTaskId = 'unattended-ten-round-task';
  const unattendedConversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const unattendedConversationUrl = `https://chatgpt.com/c/${unattendedConversationId}`;
  supervisor.registerTask({
    taskId: unattendedTaskId,
    conversationId: unattendedConversationId,
    conversationUrl: unattendedConversationUrl,
    objective: 'Complete ten autonomous continuation rounds across supervisor restart.',
    completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {},
  });
  let effect = supervisor.reserveEnrollment(unattendedTaskId);
  const observedEffectIds = new Set<string>();
  for (let round = 1; round <= 10; round += 1) {
    supervisor = control();
    assert.equal(observedEffectIds.has(effect.effectId), false);
    observedEffectIds.add(effect.effectId);
    supervisor.observeEffect({
      effectId: effect.effectId,
      observationId: `unattended-applied-${round}`,
      outcome: 'applied',
      evidence: { exact_user_message: true },
    });
    const responseText = block('CONTINUE', effect.effectId, `unattended-checkpoint-${round}`, unattendedConversationId, unattendedTaskId);
    const advanced = await supervisor.observeAssistantTurn({
      taskId: unattendedTaskId,
      conversationId: unattendedConversationId,
      responseText,
    });
    assert.equal(advanced.terminal, false);
    assert.ok(advanced.successorEffect);
    const replay = await supervisor.observeAssistantTurn({
      taskId: unattendedTaskId,
      conversationId: unattendedConversationId,
      responseText,
    });
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.successorEffect?.effectId, advanced.successorEffect.effectId);
    effect = advanced.successorEffect;
  }
  assert.equal(observedEffectIds.size, 10);
  supervisor = control();
  supervisor.observeEffect({
    effectId: effect.effectId,
    observationId: 'unattended-terminal-applied',
    outcome: 'applied',
    evidence: { exact_user_message: true },
  });
  const unattendedDone = await supervisor.observeAssistantTurn({
    taskId: unattendedTaskId,
    conversationId: unattendedConversationId,
    responseText: block('DONE', effect.effectId, 'unattended-done', unattendedConversationId, unattendedTaskId),
  });
  assert.equal(unattendedDone.terminal, true);
  supervisor = control();
  assert.equal(supervisor.browserPoll({ conversationId: unattendedConversationId, conversationUrl: unattendedConversationUrl }).terminal, 'DONE');

  console.log('[workflow-supervisor-restart-recovery-smoke] OK');
} finally { rmSync(home, { recursive: true, force: true }); }
