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
const block = (action: 'CONTINUE' | 'DONE', effectId: string, checkpoint: string) => `${SUPERVISOR_BLOCK_START}\n${JSON.stringify({ action, source_effect_id: effectId, checkpoint, reason: action === 'DONE' ? 'complete' : 'continue', evidence: ['recovery-smoke'] })}\n${SUPERVISOR_BLOCK_END}`;
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
  const response1 = block('CONTINUE', enrollment.effectId, 'checkpoint-1');
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

  const response2 = block('CONTINUE', continuation.effectId, 'checkpoint-2');
  const turn2a = await supervisor.browserObserveAssistant({ conversationId, conversationUrl, responseText: response2 });
  const turn2b = await supervisor.browserObserveAssistant({ conversationId, conversationUrl, responseText: response2 });
  assert.equal(turn2a.successorEffect?.effectId, turn2b.successorEffect?.effectId); assert.equal(turn2b.deduplicated, true);
  const terminalEffect = turn2a.successorEffect!;
  poll = supervisor.browserPoll({ conversationId, conversationUrl });
  assert.equal(supervisor.browserBeginEffect({ conversationId, conversationUrl, effectId: terminalEffect.effectId, dispatchId: 'terminal-g1', dispatchGeneration: poll.command!.dispatchGeneration, evidence: { latest_user_text: continuation.prompt, latest_assistant_response: response2 } }).started, true);
  supervisor.browserObserveEffect({ conversationId, conversationUrl, effectId: terminalEffect.effectId, observationId: 'terminal-applied', outcome: 'applied', evidence: { exact_user_message: true } });
  const done = await supervisor.browserObserveAssistant({ conversationId, conversationUrl, responseText: block('DONE', terminalEffect.effectId, 'done') });
  assert.equal(done.terminal, true);
  supervisor = control();
  assert.equal(supervisor.browserTasks().length, 0);
  const terminalPoll = supervisor.browserPoll({ conversationId, conversationUrl });
  assert.equal(terminalPoll.terminal, 'DONE'); assert.equal(terminalPoll.command, undefined);
  console.log('[workflow-supervisor-restart-recovery-smoke] OK');
} finally { rmSync(home, { recursive: true, force: true }); }
