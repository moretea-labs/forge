import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createMcpHttpSessionRegistry } from '../adapters/mcp/transports/http';
import { authenticatedFacadeControllerIdentity } from '../adapters/mcp/runtime-gateway/controller-authority-adapter';
import { readExecutionSession, startExecutionSession } from '../src/runtime/control-plane/execution/session-store';
import {
  bindControllerSessionBinding,
  claimControllerSession,
  getControllerRoundRelay,
  releaseControllerSession,
  type ControllerHost,
} from '../packages/kernel/controller/api/index';
import { createWorkContract } from '../packages/kernel/work/api/index';
import { upsertChatgptControllerBinding } from '../adapters/chatgpt/controller-binding-store';
import { runSchedulerAutonomousContinuationReconciliation } from '../src/runtime/control-plane/global-scheduler/autonomous-continuation';
import { WorkflowSupervisorControlPlane } from '../supervisor/control-plane';
import { SUPERVISOR_BLOCK_END, SUPERVISOR_BLOCK_START } from '../supervisor/protocol';
import { WorkflowSupervisorStore } from '../supervisor/store';

const root = mkdtempSync(join(tmpdir(), 'forge-unattended-transport-recovery-'));
const controllerHome = join(root, 'controller');
const repoId = 'repo-unattended-recovery';
const workId = 'work-unattended-recovery';
const oldTransportSessionId = 'mcp-transport-old';
const newTransportSessionId = 'mcp-transport-new';
const principalId = 'chatgpt-controller';

const validators = {
  completionContract: async () => ({ valid: true, reason: 'ok' }),
  userBlockerPolicy: async () => ({ valid: true, reason: 'ok' }),
};
const supervisor = () => new WorkflowSupervisorControlPlane(new WorkflowSupervisorStore(controllerHome), validators);

function block(action: 'CONTINUE' | 'DONE', effectId: string, checkpoint: string, conversationId: string, taskId: string): string {
  return `${SUPERVISOR_BLOCK_START}\n${JSON.stringify({
    action,
    source_effect_id: effectId,
    checkpoint,
    reason: action === 'DONE' ? 'complete' : 'continue',
    evidence: ['unattended-transport-recovery-smoke'],
    conversation_id: conversationId,
    task_id: taskId,
    supervisor_state: action === 'DONE' ? 'done' : 'running',
    active_scope: `goal:${taskId}`,
  })}\n${SUPERVISOR_BLOCK_END}`;
}

try {
  // 1) Durable execution is created independently of an MCP stream.
  startExecutionSession(controllerHome, {
    sessionId: oldTransportSessionId,
    principalId,
    controllerInstanceId: 'runtime-before-restart',
  });

  let transportCloseCount = 0;
  const registry = createMcpHttpSessionRegistry<
    { close(): void },
    { sessionId: string; controllerHome: string }
  >();
  registry.register({
    sessionId: oldTransportSessionId,
    transport: { close: () => { transportCloseCount += 1; } },
    toolContext: { sessionId: oldTransportSessionId, controllerHome },
    route: '/mcp',
    principalId,
    connectionId: 'connection-before-disconnect',
    clientIdentity: 'chatgpt-client',
  });
  await registry.close(oldTransportSessionId, 'transport_close');
  assert.equal(transportCloseCount, 1);

  // 2) Transport loss must not invalidate execution authority. Reading through a
  // new runtime instance also exercises restart recovery of the durable session.
  const recoveredExecution = readExecutionSession(controllerHome, {
    sessionId: oldTransportSessionId,
    principalId,
    controllerInstanceId: 'runtime-after-restart',
  });
  assert.ok(recoveredExecution);
  assert.equal(recoveredExecution.controllerInstanceId, 'runtime-after-restart');
  assert.equal(recoveredExecution.invalidatedAt, undefined);

  // 3) A newly authenticated transport can explicitly carry the prior session
  // only on the bounded rollover path. The new transport remains the request
  // binding; the old session is merely the compatibility authority carrier.
  const rolloverIdentity = authenticatedFacadeControllerIdentity({
    principalId,
    sessionId: newTransportSessionId,
    controllerInstanceId: 'runtime-after-restart',
    controllerType: 'chatgpt',
  } as any, {
    session_id: oldTransportSessionId,
  }, { allowTransportSessionRollover: true });
  assert.equal(rolloverIdentity.sessionId, newTransportSessionId);
  assert.equal(rolloverIdentity.transportSessionId, newTransportSessionId);
  assert.equal(rolloverIdentity.controllerAuthorityId, oldTransportSessionId);
  assert.equal(rolloverIdentity.authorityViaSessionCompatibility, true);

  // 4) Scheduler liveness owns unattended Work wake-up. Repeated reconciliation
  // of the same durable state must never duplicate provider dispatch.
  createWorkContract({ controllerHome, repoId }, {
    workId,
    repoId,
    objective: 'Continue without manual user wake-ups.',
    acceptanceCriteria: ['The Work resumes from durable authority.'],
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    constraints: { requireHandoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
    status: 'running',
    baseRevision: 'abc123',
  } as Parameters<typeof createWorkContract>[1]);

  const store = { controllerHome, repoId };
  const controllerAuthorityId = oldTransportSessionId;
  const owner = claimControllerSession(store, {
    workId,
    controllerId: principalId,
    controllerType: 'chatgpt',
    sessionId: oldTransportSessionId,
    authorityDigest: createHash('sha256').update(controllerAuthorityId).digest('hex'),
    principalId,
    controllerInstanceId: 'runtime-before-restart',
    leaseMs: 60_000,
  });
  const binding = upsertChatgptControllerBinding(store, {
    workId,
    sessionId: owner.sessionId,
    title: 'unattended recovery smoke',
    model: 'gpt-5.6',
    reasoning: 'high',
    tabPolicy: 'auto',
  });
  bindControllerSessionBinding(store, { workId, sessionId: owner.sessionId, binding: binding.binding });
  releaseControllerSession(store, workId, owner.controllerId);

  let providerDispatches = 0;
  const host: ControllerHost = {
    resume: async () => {
      providerDispatches += 1;
      return { accepted: true, dispatchId: `dispatch-${providerDispatches}` };
    },
  };
  const schedulerInput = {
    controllerHome,
    nowMs: Date.parse('2026-09-22T12:00:00.000Z'),
    repositories: [{ repoId, canonicalRoot: root, localRoot: root }],
    dependencies: {
      authorizeWake: () => undefined,
      boundaryForWork: () => ({ status: 'not_eligible' as const }),
      hostForBinding: () => host,
    },
  };
  const firstWake = await runSchedulerAutonomousContinuationReconciliation(schedulerInput);
  assert.equal(firstWake.dispatched, 1);
  const duplicateWake = await runSchedulerAutonomousContinuationReconciliation(schedulerInput);
  assert.equal(duplicateWake.dispatched, 0);
  assert.equal(providerDispatches, 1);
  assert.equal(getControllerRoundRelay(store, workId)?.status, 'dispatched');

  // 5) Workflow Supervisor state is durable across process/control-plane
  // reconstruction. Ten CONTINUE rounds publish exactly one successor each, and
  // replaying the same completion never creates a second effect.
  const taskId = 'unattended-transport-recovery-task';
  const conversationId = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  let control = supervisor();
  control.registerTask({
    taskId,
    conversationId,
    conversationUrl,
    objective: 'Continue autonomously across reconnects and runtime restarts.',
    completionContract: {},
    continuationPolicy: { active_scope: `goal:${taskId}` },
    userBlockerPolicy: {},
  });
  let effect = control.reserveEnrollment(taskId);
  control.observeEffect({ effectId: effect.effectId, observationId: 'round-0-applied', outcome: 'applied' });

  for (let round = 1; round <= 10; round += 1) {
    control = supervisor();
    const response = block('CONTINUE', effect.effectId, `checkpoint-${round}`, conversationId, taskId);
    const advanced = await control.browserObserveAssistant({ conversationId, conversationUrl, responseText: response });
    assert.ok(advanced.successorEffect);
    const replay = await control.browserObserveAssistant({ conversationId, conversationUrl, responseText: response });
    assert.equal(replay.successorEffect?.effectId, advanced.successorEffect.effectId);
    assert.equal(replay.deduplicated, true);
    effect = advanced.successorEffect;
    control.observeEffect({
      effectId: effect.effectId,
      observationId: `round-${round}-applied`,
      outcome: 'applied',
    });
  }

  control = supervisor();
  const done = await control.browserObserveAssistant({
    conversationId,
    conversationUrl,
    responseText: block('DONE', effect.effectId, 'complete', conversationId, taskId),
  });
  assert.equal(done.terminal, true);
  assert.equal(control.browserTasks().length, 0);

  console.log(JSON.stringify({
    status: 'ok',
    transportDisconnectedWithoutExecutionInvalidation: true,
    reconnectUsedExplicitRolloverAuthority: true,
    runtimeRestartRecoveredExecution: true,
    schedulerProviderDispatches: providerDispatches,
    unattendedContinuationRounds: 10,
    duplicateSuccessorEffects: 0,
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
