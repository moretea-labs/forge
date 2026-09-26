import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { createConnection } from 'node:net';
import { createRequirement, updateRequirement } from '../src/runtime/control-plane/persistence/requirement-store';
import {
  registerWorkflowSupervisorTask,
  reserveWorkflowSupervisorEnrollment,
} from '../supervisor/client';
import { WorkflowSupervisorControlPlane } from '../supervisor/control-plane';
import { forgeWorkflowSupervisorValidators } from '../supervisor/forge-validators';
import { workflowSupervisorSocketPath } from '../supervisor/paths';
import { renderSupervisorReceipt } from '../supervisor/protocol';
import { WorkflowSupervisorStore, workflowSupervisorDatabasePath } from '../supervisor/store';
import { createWorkflowSupervisorServer } from '../supervisor/server';

const home = mkdtempSync(join(tmpdir(), 'forge-workflow-supervisor-'));
try {
  assert.equal(workflowSupervisorDatabasePath(home), join(home, 'supervisor', 'supervisor.sqlite'));
  let allowDone = false;
  const control = new WorkflowSupervisorControlPlane(new WorkflowSupervisorStore(home), {
    completionContract: async () => ({ valid: allowDone, reason: allowDone ? 'verified' : 'missing_goal_evidence' }),
    userBlockerPolicy: async () => ({ valid: false, reason: 'not_user_only' }),
  });
  const taskInput = { taskId: 'task-smoke', conversationId: 'conv-smoke', conversationUrl: 'https://chatgpt.com/c/conv-smoke', objective: 'finish smoke goal', completionContract: {}, continuationPolicy: { active_scope: 'goal:task-smoke' }, userBlockerPolicy: {} };
  control.registerTask(taskInput);
  assert.throws(() => control.registerTask({ ...taskInput, completionContract: { changed: true } }), /WORKFLOW_SUPERVISOR_TASK_ID_CONFLICT/);
  const enrollment = control.reserveEnrollment('task-smoke');
  assert.match(enrollment.prompt, new RegExp(enrollment.effectId));
  control.observeEffect({ effectId: enrollment.effectId, observationId: 'obs-1', outcome: 'applied' });
  const response = (effect: string, action: 'CONTINUE'|'DONE') => renderSupervisorReceipt(taskInput, effect, action);
  const first = await control.observeAssistantTurn({ taskId: 'task-smoke', conversationId: 'conv-smoke', responseText: response(enrollment.effectId, 'CONTINUE') });
  assert(first.successorEffect); assert.equal(first.terminal, false);
  const duplicate = await control.observeAssistantTurn({ taskId: 'task-smoke', conversationId: 'conv-smoke', responseText: response(enrollment.effectId, 'CONTINUE') });
  assert.equal(duplicate.successorEffect?.effectId, first.successorEffect.effectId); assert.equal(duplicate.deduplicated, true);
  assert.throws(() => control.registerTask({ taskId: 'task-smoke', conversationId: 'conv-smoke', conversationUrl: 'https://chatgpt.com/c/conv-smoke', objective: 'changed objective', completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {} }), /WORKFLOW_SUPERVISOR_TASK_ID_CONFLICT/);
  control.observeEffect({ effectId: first.successorEffect.effectId, observationId: 'obs-2', outcome: 'applied' });
  const rejected = await control.observeAssistantTurn({ taskId: 'task-smoke', conversationId: 'conv-smoke', responseText: response(first.successorEffect.effectId, 'DONE') });
  assert.equal(rejected.terminal, false); assert.equal(rejected.validation?.valid, false); assert(rejected.successorEffect);
  control.observeEffect({ effectId: rejected.successorEffect.effectId, observationId: 'obs-3', outcome: 'applied' });
  allowDone = true;
  const done = await control.observeAssistantTurn({ taskId: 'task-smoke', conversationId: 'conv-smoke', responseText: response(rejected.successorEffect.effectId, 'DONE') });
  assert.equal(done.terminal, true); assert.equal(done.successorEffect, undefined);

  const socketPath = workflowSupervisorSocketPath(home);
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

  const rpcTaskInput = {
    taskId: 'task-rpc-smoke', conversationId: 'conv-rpc-smoke', conversationUrl: 'https://chatgpt.com/c/conv-rpc-smoke', objective: 'rpc enrollment smoke',
    completionContract: { kind: 'smoke' }, continuationPolicy: { kind: 'smoke' }, userBlockerPolicy: { kind: 'smoke' },
  };
  const rpcTask = await registerWorkflowSupervisorTask(home, rpcTaskInput);
  assert.equal(rpcTask.taskId, rpcTaskInput.taskId);
  const rpcEnrollment = await reserveWorkflowSupervisorEnrollment(home, rpcTask.taskId);
  const rpcEnrollmentReplay = await reserveWorkflowSupervisorEnrollment(home, rpcTask.taskId);
  assert.equal(rpcEnrollmentReplay.effectId, rpcEnrollment.effectId);

  const controllerHome = join(home, 'controller');
  const validators = forgeWorkflowSupervisorValidators();
  createRequirement({ controllerHome }, { requirementId: 'REQ-SUPERVISOR-DONE', title: 'Supervisor done validator', outcomeStatement: 'Validate canonical semantic completion.' });
  updateRequirement({ controllerHome }, { requirementId: 'REQ-SUPERVISOR-DONE', action: 'smoke_activate', mutate: (current) => ({ ...current, state: 'active' }) });
  const doneTask = {
    ...rpcTaskInput,
    taskId: 'task-validator-done',
    completionContract: { kind: 'forge_requirement_done', controller_home: controllerHome, requirement_id: 'REQ-SUPERVISOR-DONE' },
    userBlockerPolicy: { kind: 'forge_requirement_waiting_for_user', controller_home: controllerHome, requirement_id: 'REQ-SUPERVISOR-DONE' },
    createdAt: new Date().toISOString(),
  };
  assert.equal((await validators.completionContract(doneTask, { action: 'DONE', sourceEffectId: 'fx_smokevalidator', checkpoint: 'done', reason: 'done', evidence: [] })).valid, false);
  updateRequirement({ controllerHome }, {
    requirementId: 'REQ-SUPERVISOR-DONE', action: 'smoke_semantic_acceptance',
    mutate: (current) => ({ ...current, state: 'done', semanticAcceptance: { reviewer: 'smoke', rationale: 'validated', planIds: [], acceptedAt: new Date().toISOString() } }),
  });
  assert.equal((await validators.completionContract(doneTask, { action: 'DONE', sourceEffectId: 'fx_smokevalidator', checkpoint: 'done', reason: 'done', evidence: [] })).valid, true);

  createRequirement({ controllerHome }, { requirementId: 'REQ-SUPERVISOR-USER', title: 'Supervisor user validator', outcomeStatement: 'Validate genuine user-only wait.' });
  updateRequirement({ controllerHome }, { requirementId: 'REQ-SUPERVISOR-USER', action: 'smoke_activate', mutate: (current) => ({ ...current, state: 'active' }) });
  updateRequirement({ controllerHome }, {
    requirementId: 'REQ-SUPERVISOR-USER', action: 'smoke_user_wait',
    mutate: (current) => ({ ...current, state: 'waiting_for_user', needsAttention: true, attentionSummary: 'User authorization is required.' }),
  });
  const userTask = { ...doneTask, taskId: 'task-validator-user', completionContract: { kind: 'forge_requirement_done', controller_home: controllerHome, requirement_id: 'REQ-SUPERVISOR-USER' }, userBlockerPolicy: { kind: 'forge_requirement_waiting_for_user', controller_home: controllerHome, requirement_id: 'REQ-SUPERVISOR-USER' } };
  assert.equal((await validators.userBlockerPolicy(userTask, { action: 'NEEDS_USER', sourceEffectId: 'fx_smokevalidator', checkpoint: 'user', reason: 'user action', evidence: [] })).valid, true);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log('[workflow-supervisor-smoke] OK');
} finally { rmSync(home, { recursive: true, force: true }); }
