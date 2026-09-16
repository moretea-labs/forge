import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { createConnection } from 'node:net';
import { WorkflowSupervisorControlPlane } from '../supervisor/control-plane';
import { SUPERVISOR_BLOCK_END, SUPERVISOR_BLOCK_START } from '../supervisor/protocol';
import { WorkflowSupervisorStore, workflowSupervisorDatabasePath } from '../supervisor/store';
import { createWorkflowSupervisorServer } from '../supervisor/server';
import { renderWorkflowSupervisorLaunchd } from '../supervisor/service';

const home = mkdtempSync(join(tmpdir(), 'forge-workflow-supervisor-'));
try {
  assert.equal(workflowSupervisorDatabasePath(home), join(home, 'supervisor', 'supervisor.sqlite'));
  const control = new WorkflowSupervisorControlPlane(new WorkflowSupervisorStore(home), {
    completionContract: async (_task, proposal) => ({ valid: proposal.evidence.includes('goal-complete'), reason: proposal.evidence.includes('goal-complete') ? 'verified' : 'missing_goal_evidence' }),
    userBlockerPolicy: async () => ({ valid: false, reason: 'not_user_only' }),
  });
  const taskInput = { taskId: 'task-smoke', conversationId: 'conv-smoke', conversationUrl: 'https://chatgpt.com/c/conv-smoke', objective: 'finish smoke goal', completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {} };
  control.registerTask(taskInput);
  assert.throws(() => control.registerTask({ ...taskInput, completionContract: { changed: true } }), /WORKFLOW_SUPERVISOR_TASK_ID_CONFLICT/);
  const enrollment = control.reserveEnrollment('task-smoke');
  assert.match(enrollment.prompt, new RegExp(enrollment.effectId));
  control.observeEffect({ effectId: enrollment.effectId, observationId: 'obs-1', outcome: 'applied' });
  const response = (effect: string, action: 'CONTINUE'|'DONE', evidence: string[] = [], prefix = 'work result') => `${prefix}\n${SUPERVISOR_BLOCK_START}\n${JSON.stringify({ action, source_effect_id: effect, checkpoint: 'checkpoint-1', reason: 'bounded reason', evidence })}\n${SUPERVISOR_BLOCK_END}`;
  const first = await control.observeAssistantTurn({ taskId: 'task-smoke', conversationId: 'conv-smoke', responseText: response(enrollment.effectId, 'CONTINUE') });
  assert(first.successorEffect); assert.equal(first.terminal, false);
  const duplicate = await control.observeAssistantTurn({ taskId: 'task-smoke', conversationId: 'conv-smoke', responseText: response(enrollment.effectId, 'CONTINUE') });
  assert.equal(duplicate.successorEffect?.effectId, first.successorEffect.effectId); assert.equal(duplicate.deduplicated, true);
  await assert.rejects(() => control.observeAssistantTurn({ taskId: 'task-smoke', conversationId: 'conv-smoke', responseText: response(enrollment.effectId, 'CONTINUE', [], 'conflicting second completion') }), /WORKFLOW_SUPERVISOR_SOURCE_EFFECT_COMPLETION_CONFLICT/);
  assert.throws(() => control.registerTask({ taskId: 'task-smoke', conversationId: 'conv-smoke', conversationUrl: 'https://chatgpt.com/c/conv-smoke', objective: 'changed objective', completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {} }), /WORKFLOW_SUPERVISOR_TASK_ID_CONFLICT/);
  control.observeEffect({ effectId: first.successorEffect.effectId, observationId: 'obs-2', outcome: 'applied' });
  const rejected = await control.observeAssistantTurn({ taskId: 'task-smoke', conversationId: 'conv-smoke', responseText: response(first.successorEffect.effectId, 'DONE') });
  assert.equal(rejected.terminal, false); assert.equal(rejected.validation?.valid, false); assert(rejected.successorEffect);
  control.observeEffect({ effectId: rejected.successorEffect.effectId, observationId: 'obs-3', outcome: 'applied' });
  const done = await control.observeAssistantTurn({ taskId: 'task-smoke', conversationId: 'conv-smoke', responseText: response(rejected.successorEffect.effectId, 'DONE', ['goal-complete']) });
  assert.equal(done.terminal, true); assert.equal(done.successorEffect, undefined);

  const socketPath = join(home, 'supervisor-smoke.sock');
  const server = createWorkflowSupervisorServer({ controlPlane: control, socketPath });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const health = await new Promise<Record<string, any>>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    socket.once('error', reject);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      socket.end();
      resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, any>);
    });
    socket.once('connect', () => socket.write(`${JSON.stringify({ id: 'health-1', method: 'health', params: {} })}\n`));
  });
  assert.equal(health.ok, true); assert.equal(health.result.status, 'ready');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const plist = renderWorkflowSupervisorLaunchd({ label: 'com.moretea.forge.workflow-supervisor.smoke', bunExecutable: '/usr/bin/bun', entryPath: '/tmp/supervisor-entry.ts', forgeHome: home, stdoutPath: join(home, 'out.log'), stderrPath: join(home, 'err.log') });
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/); assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  console.log('[workflow-supervisor-smoke] OK');
} finally { rmSync(home, { recursive: true, force: true }); }
