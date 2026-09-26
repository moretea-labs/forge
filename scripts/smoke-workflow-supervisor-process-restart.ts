#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowSupervisorControlPlane } from '../supervisor/control-plane';
import { SUPERVISOR_BLOCK_END, SUPERVISOR_BLOCK_START } from '../supervisor/protocol';
import { WorkflowSupervisorStore } from '../supervisor/store';

const TASK_ID = 'process-restart-proof-task';
const CONVERSATION_ID = '11111111-aaaa-bbbb-cccc-222222222222';
const CONVERSATION_URL = `https://chatgpt.com/c/${CONVERSATION_ID}`;
const BASELINE_USER = 'before-process-restart-proof';
const BASELINE_ASSISTANT = 'stable-assistant-baseline';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function control(home: string): WorkflowSupervisorControlPlane {
  return new WorkflowSupervisorControlPlane(new WorkflowSupervisorStore(home), {
    completionContract: async () => ({ valid: true, reason: 'ok' }),
    userBlockerPolicy: async () => ({ valid: true, reason: 'ok' }),
  });
}

function sourceBaseline(home: string, effectId: string, checkpoint: string): { latest_user_text: string; latest_assistant_response: string } {
  const store = new WorkflowSupervisorStore(home);
  const effect = store.getEffect(effectId);
  assert.ok(effect?.sourceCompletionFingerprint, `effect ${effectId} must have source completion`);
  const completion = store.getCompletion(effect.sourceCompletionFingerprint);
  assert.ok(completion, `completion ${effect.sourceCompletionFingerprint} must exist`);
  const sourceEffect = store.getEffect(completion.sourceEffectId);
  assert.ok(sourceEffect, `source effect ${completion.sourceEffectId} must exist`);
  return {
    latest_user_text: sourceEffect.prompt,
    latest_assistant_response: block('CONTINUE', sourceEffect.effectId, checkpoint),
  };
}

function block(action: 'CONTINUE' | 'DONE', effectId: string, checkpoint: string): string {
  return `${SUPERVISOR_BLOCK_START}\n${JSON.stringify({
    action,
    source_effect_id: effectId,
    checkpoint,
    reason: action === 'DONE' ? 'complete' : 'continue',
    evidence: ['process-restart-smoke'],
    conversation_id: CONVERSATION_ID,
    task_id: TASK_ID,
    supervisor_state: action === 'DONE' ? 'done' : 'running',
    active_scope: `goal:${TASK_ID}`,
  })}\n${SUPERVISOR_BLOCK_END}`;
}

async function runPhase(home: string, phase: string): Promise<void> {
  const supervisor = control(home);

  if (phase === 'arm-enrollment') {
    supervisor.registerTask({
      taskId: TASK_ID,
      conversationId: CONVERSATION_ID,
      conversationUrl: CONVERSATION_URL,
      objective: 'Prove autonomous continuation survives real process restart.',
      completionContract: {},
      continuationPolicy: {},
      userBlockerPolicy: {},
    });
    const enrollment = supervisor.reserveEnrollment(TASK_ID);
    const poll = supervisor.browserPoll({ conversationId: CONVERSATION_ID, conversationUrl: CONVERSATION_URL });
    assert.equal(poll.command?.effectId, enrollment.effectId);
    assert.equal(poll.command?.mode, 'send');
    assert.equal(poll.command?.dispatchGeneration, 1);
    assert.equal(supervisor.browserBeginEffect({
      conversationId: CONVERSATION_ID,
      conversationUrl: CONVERSATION_URL,
      effectId: enrollment.effectId,
      dispatchId: 'enrollment-g1',
      dispatchGeneration: 1,
      evidence: { latest_user_text: BASELINE_USER, latest_assistant_response: BASELINE_ASSISTANT },
    }).started, true);
    return;
  }

  if (phase === 'prove-not-applied') {
    let poll = supervisor.browserPoll({ conversationId: CONVERSATION_ID, conversationUrl: CONVERSATION_URL });
    assert.equal(poll.command?.mode, 'reconcile');
    assert.equal(poll.command?.dispatchGeneration, 1);
    const effectId = poll.command!.effectId;
    supervisor.browserObserveEffect({
      conversationId: CONVERSATION_ID,
      conversationUrl: CONVERSATION_URL,
      effectId,
      observationId: 'enrollment-g1-not-applied',
      outcome: 'not_applied',
      evidence: {
        latest_user_text: BASELINE_USER,
        latest_assistant_response: BASELINE_ASSISTANT,
        target_marker_present: false,
      },
    });
    poll = supervisor.browserPoll({ conversationId: CONVERSATION_ID, conversationUrl: CONVERSATION_URL });
    assert.equal(poll.command?.effectId, effectId);
    assert.equal(poll.command?.mode, 'send');
    assert.equal(poll.command?.dispatchGeneration, 2);
    assert.equal(supervisor.browserBeginEffect({
      conversationId: CONVERSATION_ID,
      conversationUrl: CONVERSATION_URL,
      effectId,
      dispatchId: 'enrollment-g2',
      dispatchGeneration: 2,
      evidence: { latest_user_text: BASELINE_USER, latest_assistant_response: BASELINE_ASSISTANT },
    }).started, true);
    supervisor.browserObserveEffect({
      conversationId: CONVERSATION_ID,
      conversationUrl: CONVERSATION_URL,
      effectId,
      observationId: 'enrollment-g2-unknown',
      outcome: 'unknown',
      evidence: { send_boundary_crossed: true },
    });
    return;
  }

  if (phase === 'reconcile-unknown-and-continue-1') {
    const poll = supervisor.browserPoll({ conversationId: CONVERSATION_ID, conversationUrl: CONVERSATION_URL });
    assert.equal(poll.command?.mode, 'reconcile');
    assert.equal(poll.command?.dispatchGeneration, 2);
    const effectId = poll.command!.effectId;
    supervisor.browserObserveEffect({
      conversationId: CONVERSATION_ID,
      conversationUrl: CONVERSATION_URL,
      effectId,
      observationId: 'enrollment-g2-applied-after-restart',
      outcome: 'applied',
      evidence: { exact_user_message: true },
    });
    const advanced = await supervisor.browserObserveAssistant({
      conversationId: CONVERSATION_ID,
      conversationUrl: CONVERSATION_URL,
      responseText: block('CONTINUE', effectId, 'round-1'),
    });
    assert.equal(advanced.terminal, false);
    assert.ok(advanced.successorEffect);
    return;
  }

  if (phase === 'continue-2') {
    const poll = supervisor.browserPoll({ conversationId: CONVERSATION_ID, conversationUrl: CONVERSATION_URL });
    assert.equal(poll.command?.mode, 'send');
    assert.equal(poll.command?.dispatchGeneration, 1);
    const effectId = poll.command!.effectId;
    assert.equal(supervisor.browserBeginEffect({
      conversationId: CONVERSATION_ID,
      conversationUrl: CONVERSATION_URL,
      effectId,
      dispatchId: 'round-2-g1',
      dispatchGeneration: 1,
      evidence: sourceBaseline(home, effectId, 'round-1'),
    }).started, true);
    supervisor.browserObserveEffect({
      conversationId: CONVERSATION_ID,
      conversationUrl: CONVERSATION_URL,
      effectId,
      observationId: 'round-2-applied',
      outcome: 'applied',
      evidence: { exact_user_message: true },
    });
    const advanced = await supervisor.browserObserveAssistant({
      conversationId: CONVERSATION_ID,
      conversationUrl: CONVERSATION_URL,
      responseText: block('CONTINUE', effectId, 'round-2'),
    });
    assert.equal(advanced.terminal, false);
    assert.ok(advanced.successorEffect);
    return;
  }

  if (phase === 'done-3') {
    const poll = supervisor.browserPoll({ conversationId: CONVERSATION_ID, conversationUrl: CONVERSATION_URL });
    assert.equal(poll.command?.mode, 'send');
    assert.equal(poll.command?.dispatchGeneration, 1);
    const effectId = poll.command!.effectId;
    assert.equal(supervisor.browserBeginEffect({
      conversationId: CONVERSATION_ID,
      conversationUrl: CONVERSATION_URL,
      effectId,
      dispatchId: 'round-3-g1',
      dispatchGeneration: 1,
      evidence: sourceBaseline(home, effectId, 'round-2'),
    }).started, true);
    supervisor.browserObserveEffect({
      conversationId: CONVERSATION_ID,
      conversationUrl: CONVERSATION_URL,
      effectId,
      observationId: 'round-3-applied',
      outcome: 'applied',
      evidence: { exact_user_message: true },
    });
    const done = await supervisor.browserObserveAssistant({
      conversationId: CONVERSATION_ID,
      conversationUrl: CONVERSATION_URL,
      responseText: block('DONE', effectId, 'round-3'),
    });
    assert.equal(done.terminal, true);
    assert.equal(done.successorEffect, undefined);
    return;
  }

  if (phase === 'quiescent') {
    assert.equal(supervisor.browserTasks().length, 0);
    const poll = supervisor.browserPoll({ conversationId: CONVERSATION_ID, conversationUrl: CONVERSATION_URL });
    assert.equal(poll.terminal, 'DONE');
    assert.equal(poll.command, undefined);
    return;
  }

  throw new Error(`UNKNOWN_PHASE:${phase}`);
}

async function main(): Promise<void> {
  const phase = arg('--phase');
  const homeArg = arg('--home');
  if (phase) {
    if (!homeArg) throw new Error('--home is required with --phase');
    await runPhase(homeArg, phase);
    return;
  }

  const home = mkdtempSync(join(tmpdir(), 'forge-supervisor-process-restart-'));
  const script = fileURLToPath(import.meta.url);
  try {
    for (const nextPhase of [
      'arm-enrollment',
      'prove-not-applied',
      'reconcile-unknown-and-continue-1',
      'continue-2',
      'done-3',
      'quiescent',
    ]) {
      const child = spawnSync(process.execPath, [script, '--phase', nextPhase, '--home', home], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.equal(
        child.status,
        0,
        `phase ${nextPhase} failed\nstdout:\n${child.stdout ?? ''}\nstderr:\n${child.stderr ?? ''}`,
      );
    }
    console.log('[workflow-supervisor-process-restart-smoke] OK');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
