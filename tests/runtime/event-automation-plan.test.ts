import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventEnvelope, type EventRuleV1 } from '../../packages/kernel/events';
import type { ModelProfileV1 } from '../../packages/kernel/models';
import type { WorkflowAssetDraft, WorkflowGraphAssetDraft } from '../../packages/workflow-runtime/api/index';
import { createEventActionDefinition } from '../../src/runtime/events/event-action-registry-store';
import { buildEventAutomationPlans } from '../../src/runtime/events/event-automation-plan';
import { executeEventWorkflowAutomation } from '../../src/runtime/events/event-workflow-runtime';
import { createEventRule, evaluatePersistedEventRules } from '../../src/runtime/events/event-rule-store';
import {
  writeWorkflowAssetContent,
  writeWorkflowGraphAssetContent,
} from '../../src/runtime/control-plane/persistence/workflow-content-store';
import {
  recordWorkflowBindings,
  registerWorkflowFeatureAsset,
} from '../../src/runtime/control-plane/persistence/workflow-registry-store';
import { readWorkflowGraphRun } from '../../src/runtime/control-plane/persistence/workflow-run-store';
import {
  readAuthorizationRequest,
  resolveAuthorizationRequest,
} from '../../src/runtime/control-plane/governance/authorization';
import {
  findWorkflowGraphEventWaits,
  resumeWorkflowGraphEventWait,
  workflowGraphEventSignalFromEnvelope,
} from '../../src/runtime/workflows/event-wake';
import type { WorkflowGraphRuntimeDependencies } from '../../src/runtime/workflows/graph-runtime';
import { registerRepository } from '../../src/runtime/repositories/registry';
import { createModelProfile } from '../../src/runtime/models/model-profile-store';
import {
  createModelInstructionTemplate,
  createModelOutputSchema,
} from '../../src/runtime/models/model-decision-artifact-store';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function home() {
  const v = mkdtempSync(join(tmpdir(), 'forge-event-plan-'));
  roots.push(v);
  return v;
}

const EVENT_GRAPH_WORKFLOW_ID = 'event.graph.workflow';
const TEST_WORKFLOW_ID = 'event.test.workflow';
function installTestWorkflow(h: string) {
  const draft: WorkflowAssetDraft = {
    schemaVersion: 1,
    workflowId: TEST_WORKFLOW_ID,
    version: '1',
    inputContract: { message_id: { type: 'string', required: true } },
    steps: [
      {
        kind: 'script',
        stepId: 'accept',
        scriptRef: 'accept',
        input: { message_id: '{{input.message_id}}' },
      },
    ],
    scripts: {
      accept: { runtime: 'node', deterministic: true, body: 'process.stdout.write(process.argv[1] || "")' },
    },
  };
  const written = writeWorkflowAssetContent({ kind: 'controller', controllerHome: h }, draft);
  return registerWorkflowFeatureAsset({
    controllerHome: h,
    scope: { kind: 'controller' },
    asset: written.asset,
    contentLocation: { kind: 'controller', path: written.path },
    status: 'active',
  });
}

function installEventGraphWorkflow(h: string) {
  const draft: WorkflowGraphAssetDraft = {
    schemaVersion: 2,
    workflowId: EVENT_GRAPH_WORKFLOW_ID,
    version: '1',
    inputContract: {
      message_id: { type: 'string', required: true },
      route: { type: 'string', required: true },
    },
    entryNodeId: 'route',
    nodes: [
      { kind: 'branch', nodeId: 'route' },
      { kind: 'capability', nodeId: 'inspect', capabilityId: 'mail.inspect', idempotency: 'idempotent' },
      { kind: 'capability', nodeId: 'skip', capabilityId: 'mail.skip', idempotency: 'idempotent' },
      { kind: 'capability', nodeId: 'label', capabilityId: 'mail.label', idempotency: 'idempotent' },
      { kind: 'capability', nodeId: 'audit', capabilityId: 'mail.audit', idempotency: 'idempotent' },
      { kind: 'join', nodeId: 'joined', policy: 'all' },
      {
        kind: 'wait_event',
        nodeId: 'reply',
        sources: ['agentmail.watch'],
        eventTypes: ['mail.reply'],
        correlation: { kind: 'input', name: 'message_id' },
        timeoutMs: 60000,
      },
      {
        kind: 'approval',
        nodeId: 'approve',
        approvalKey: 'send-reply',
        prompt: 'Send the prepared reply?',
        timeoutMs: 60000,
      },
      { kind: 'capability', nodeId: 'send', capabilityId: 'mail.send', idempotency: 'idempotent' },
    ],
    edges: [
      {
        edgeId: 'matched',
        from: 'route',
        to: 'inspect',
        on: 'condition',
        condition: {
          kind: 'compare',
          operator: 'equals',
          left: { kind: 'input', name: 'route' },
          right: { kind: 'literal', value: 'matched' },
        },
      },
      { edgeId: 'otherwise', from: 'route', to: 'skip', on: 'default' },
      { edgeId: 'fan-label', from: 'inspect', to: 'label', on: 'success' },
      { edgeId: 'fan-audit', from: 'inspect', to: 'audit', on: 'success' },
      { edgeId: 'label-join', from: 'label', to: 'joined', on: 'success' },
      { edgeId: 'audit-join', from: 'audit', to: 'joined', on: 'success' },
      { edgeId: 'joined-reply', from: 'joined', to: 'reply', on: 'success' },
      { edgeId: 'reply-approve', from: 'reply', to: 'approve', on: 'success' },
      { edgeId: 'approve-send', from: 'approve', to: 'send', on: 'success' },
    ],
  };
  const written = writeWorkflowGraphAssetContent({ kind: 'controller', controllerHome: h }, draft);
  const registered = registerWorkflowFeatureAsset({
    controllerHome: h,
    scope: { kind: 'controller' },
    asset: written.asset,
    contentLocation: { kind: 'controller', path: written.path },
    status: 'active',
  });
  return recordWorkflowBindings({
    controllerHome: h,
    scope: { kind: 'controller' },
    expectedIdentity: registered.value,
    expectedRevision: registered.revision,
    bindings: ['inspect', 'skip', 'label', 'audit', 'send'].map((actionId) => ({
      capabilityId: `mail.${actionId}`,
      pluginId: 'mail',
      actionId,
    })),
  });
}
const event = createEventEnvelope({
  eventId: 'mail:1',
  source: 'agentmail.watch',
  provider: 'agentmail',
  eventType: 'mail.watch.matched',
  occurredAt: '2026-11-25T10:00:00.000Z',
  receivedAt: '2026-11-25T10:00:01.000Z',
  scope: { kind: 'account', id: 'a1' },
  subject: { kind: 'mail.message', id: 'm1' },
  idempotencyKey: 'mail-1',
  payloadRef: {
    store: 'provider',
    key: 'agentmail://watch-events/1',
    mediaType: 'application/json',
    schemaVersion: 1,
    digest: { algorithm: 'sha256', value: 'a'.repeat(64), bytes: 10 },
  },
});
function rule(routes: EventRuleV1['routes']): EventRuleV1 {
  return {
    schemaVersion: 1,
    ruleId: 'mail-rule',
    revision: 1,
    enabled: true,
    trigger: { sources: ['agentmail.watch'] },
    routing: 'all_matching',
    routes,
    failure: { onConditionError: 'hold', onRouteError: 'quarantine' },
  };
}
function profile(): ModelProfileV1 {
  return {
    schemaVersion: 1,
    profileId: 'fast',
    revision: 1,
    enabled: true,
    providerId: 'deepseek',
    connectionId: 'primary',
    modelId: 'deepseek-chat',
    protocol: 'chat_completions',
    tier: 'fast_classification',
    instructionTemplateId: 'mail-v1',
    outputSchemaId: 'decision-v1',
    fallbackOn: [],
    budget: { timeoutMs: 5000, maxInputTokens: 1000, maxOutputTokens: 100 },
  };
}

describe('Event Automation Plan', () => {
  test('resolves one rule to an active existing Workflow without executing it', () => {
    const h = home();
    installTestWorkflow(h);
    createEventActionDefinition(h, {
      schemaVersion: 1,
      actionRef: 'workflow.agentmail',
      revision: 1,
      enabled: true,
      handler: { kind: 'workflow', workflowId: TEST_WORKFLOW_ID, registryScope: { kind: 'controller' } },
      inputContract: { message_id: { type: 'string', required: true } },
      authorization: { risk: 'workspace_write', requiresApproval: false },
    });
    createEventRule(
      h,
      rule([
        {
          routeId: 'workflow',
          action: { actionRef: 'workflow.agentmail', inputs: { message_id: { kind: 'event', path: 'subject.id' } } },
        },
      ]),
    );
    const matches = evaluatePersistedEventRules(h, event, { facts: {} });
    const plans = buildEventAutomationPlans(h, matches);
    expect(plans[0]).toMatchObject({
      readiness: 'ready',
      handler: { kind: 'workflow', workflowId: TEST_WORKFLOW_ID },
      inputs: { message_id: 'm1' },
      authorization: { state: 'not_authorized', risk: 'workspace_write', requiresApproval: false },
      execution: 'not_executed',
    });
  });
  test('routes AgentMail rule into Graph v2 branch, parallel effects, event wait, approval and final receipt', async () => {
    const h = home();
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-event-plan-repo-'));
    roots.push(repoRoot);
    expect(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot }).status).toBe(0);
    const repository = registerRepository({ path: repoRoot, controllerHome: h, displayName: 'Event E2E' });
    installEventGraphWorkflow(h);
    const actionDefinition = {
      schemaVersion: 1,
      actionRef: 'workflow.agentmail.graph',
      revision: 1,
      enabled: true,
      handler: { kind: 'workflow', workflowId: EVENT_GRAPH_WORKFLOW_ID, registryScope: { kind: 'controller' } },
      inputContract: {
        message_id: { type: 'string', required: true },
        route: { type: 'string', required: true },
      },
      ['author' + 'ization']: { risk: 'workspace_write', requiresApproval: false },
    } as never;
    createEventActionDefinition(h, actionDefinition);
    createEventRule(
      h,
      rule([
        {
          routeId: 'graph',
          action: {
            actionRef: 'workflow.agentmail.graph',
            inputs: {
              message_id: { kind: 'event', path: 'subject.id' },
              route: { kind: 'literal', value: 'matched' },
            },
          },
        },
      ]),
    );
    const [plan] = buildEventAutomationPlans(h, evaluatePersistedEventRules(h, event, { facts: {} }));
    expect(plan).toMatchObject({
      readiness: 'ready',
      handler: {
        kind: 'workflow',
        workflowId: EVENT_GRAPH_WORKFLOW_ID,
        engine: 'graph_v2',
        registryScope: { kind: 'controller' },
      },
      inputs: { message_id: 'm1', route: 'matched' },
    });

    let now = '2026-11-25T10:00:02.000Z';
    const actions: string[] = [];
    let receiptSequence = 0;
    const graphDependencies: WorkflowGraphRuntimeDependencies = {
      now: () => new Date(now),
      submitPluginAction: async (_home, _repo, request) => {
        actions.push(request.actionId);
        receiptSequence += 1;
        return {
          receipt: {
            receiptId: `receipt-${request.actionId}-${receiptSequence}`,
            requestId: request.requestId,
            pluginId: 'mail',
            actionId: request.actionId,
            status: 'succeeded',
            createdAt: now,
          },
          result: {
            schemaVersion: 1,
            plugin: { pluginId: 'mail' },
            action: { actionId: request.actionId, requestId: request.requestId },
            result: { ok: true, actionId: request.actionId },
          },
        } as never;
      },
    };
    const executionInput = {
      controllerHome: h,
      event,
      plan: plan!,
      repository,
      approvalContext: {
        sessionId: 'event-session',
        principalId: 'event-principal',
        permissionSnapshotVersion: 1,
      },
      dependencies: { workflowDependencies: { graphDependencies } },
    };

    const started = await executeEventWorkflowAutomation(executionInput);
    expect(started.status).toBe('waiting');
    expect(actions).toEqual(expect.arrayContaining(['inspect', 'label', 'audit']));
    expect(actions).not.toContain('skip');
    expect(actions).not.toContain('send');
    const startedRun = readWorkflowGraphRun(h, started.scopeId, started.runId)!;
    expect(startedRun.value.nodes.find((node) => node.nodeId === 'reply')).toMatchObject({
      status: 'waiting',
      wait: { kind: 'event', correlationKey: 'm1' },
    });

    now = '2026-11-25T10:00:20.000Z';
    const replyEnvelope = createEventEnvelope({
      eventId: 'mail:reply:1',
      source: 'agentmail.watch',
      provider: 'agentmail',
      eventType: 'mail.reply',
      occurredAt: '2026-11-25T10:00:19.000Z',
      receivedAt: now,
      scope: { kind: 'account', id: 'a1' },
      subject: { kind: 'mail.message', id: 'm1' },
      correlationId: 'm1',
      causationId: event.eventId,
      idempotencyKey: 'mail-reply-1',
      payloadRef: {
        store: 'provider',
        key: 'agentmail://reply-events/1',
        mediaType: 'application/json',
        schemaVersion: 1,
        digest: { algorithm: 'sha256', value: 'c'.repeat(64), bytes: 12 },
      },
    });
    const replySignal = workflowGraphEventSignalFromEnvelope(replyEnvelope);
    const [waitMatch] = findWorkflowGraphEventWaits(h, replySignal);
    expect(waitMatch).toMatchObject({ runId: started.runId, nodeId: 'reply' });
    const approvalWaiting = await resumeWorkflowGraphEventWait(h, waitMatch!, replySignal, graphDependencies);
    expect(approvalWaiting.status).toBe('waiting');
    expect(approvalWaiting.nodes.find((node) => node.nodeId === 'reply')?.receipts.at(-1)?.receiptRef).toBe(
      replySignal.receiptRef,
    );
    const approvalState = approvalWaiting.nodes.find((node) => node.nodeId === 'approve');
    const requestRef = approvalState?.wait?.kind === 'approval' ? approvalState.wait.requestRef : undefined;
    expect(requestRef).toBeDefined();
    expect(readAuthorizationRequest(h, repository.repoId, requestRef!)).toMatchObject({
      status: 'pending',
      sessionId: 'event-session',
      principalId: 'event-principal',
      humanSummary: 'Send the prepared reply?',
    });

    resolveAuthorizationRequest({
      controllerHome: h,
      repositoryId: repository.repoId,
      approvalRequestId: requestRef!,
      sessionId: 'event-session',
      principalId: 'event-principal',
      permissionSnapshotVersion: 1,
      confirm: true,
    });
    now = '2026-11-25T10:00:30.000Z';
    const completed = await executeEventWorkflowAutomation(executionInput);
    expect(completed.runId).toBe(started.runId);
    expect(completed.status).toBe('succeeded');
    expect(actions).toContain('send');
    const finalRun = readWorkflowGraphRun(h, completed.scopeId, completed.runId)!;
    const send = finalRun.value.nodes.find((node) => node.nodeId === 'send');
    expect(send).toMatchObject({ status: 'succeeded' });
    expect(send?.receipts.at(-1)?.receiptRef).toMatch(/^receipt-send-/);
  });
  test('treats model request as an optional action handler rather than rule-engine dependency', () => {
    const h = home();
    createModelProfile(h, profile());
    createModelInstructionTemplate(h, {
      schemaVersion: 1,
      templateId: 'mail-v1',
      revision: 1,
      content: 'Classify mail.',
    });
    createModelOutputSchema(h, {
      schemaVersion: 1,
      schemaId: 'decision-v1',
      revision: 1,
      jsonSchema: { type: 'object' },
    });
    createEventActionDefinition(h, {
      schemaVersion: 1,
      actionRef: 'model.mail-classify',
      revision: 1,
      enabled: true,
      handler: { kind: 'model', modelProfileId: 'fast' },
      authorization: { risk: 'read', requiresApproval: false },
    });
    createEventRule(h, rule([{ routeId: 'model', action: { actionRef: 'model.mail-classify' } }]));
    const plans = buildEventAutomationPlans(h, evaluatePersistedEventRules(h, event, { facts: {} }));
    expect(plans[0]).toMatchObject({
      readiness: 'ready',
      handler: {
        kind: 'model',
        modelProfileId: 'fast',
        instructionTemplateId: 'mail-v1',
        outputSchemaId: 'decision-v1',
      },
      execution: 'not_executed',
    });
  });
  test('resolves capability actions generically for notification or connector owners', () => {
    const h = home();
    createEventActionDefinition(h, {
      schemaVersion: 1,
      actionRef: 'notification.owner',
      revision: 1,
      enabled: true,
      handler: { kind: 'capability', capabilityId: 'owner.notification' },
      inputContract: { message: { type: 'string', required: true } },
      authorization: { risk: 'external_write', requiresApproval: true },
    });
    createEventRule(
      h,
      rule([
        {
          routeId: 'notify',
          action: {
            actionRef: 'notification.owner',
            inputs: { message: { kind: 'literal', value: 'Review arrived' } },
          },
        },
      ]),
    );
    expect(buildEventAutomationPlans(h, evaluatePersistedEventRules(h, event, { facts: {} }))[0]).toMatchObject({
      handler: { kind: 'capability', capabilityId: 'owner.notification' },
      authorization: { state: 'not_authorized', requiresApproval: true },
      execution: 'not_executed',
    });
  });
  test('blocks missing action and missing workflow references instead of dispatching', () => {
    const h = home();
    createEventRule(h, rule([{ routeId: 'missing', action: { actionRef: 'missing.action' } }]));
    expect(buildEventAutomationPlans(h, evaluatePersistedEventRules(h, event, { facts: {} }))[0]).toMatchObject({
      readiness: 'blocked',
      blocker: 'EVENT_AUTOMATION_ACTION_NOT_FOUND:missing.action',
    });
    createEventActionDefinition(h, {
      schemaVersion: 1,
      actionRef: 'workflow.missing',
      revision: 1,
      enabled: true,
      handler: { kind: 'workflow', workflowId: 'missing.workflow', registryScope: { kind: 'controller' } },
      authorization: { risk: 'workspace_write', requiresApproval: false },
    });
    createEventRule(h, {
      ...rule([{ routeId: 'wf', action: { actionRef: 'workflow.missing' } }]),
      ruleId: 'missing-workflow',
    });
    const plans = buildEventAutomationPlans(h, evaluatePersistedEventRules(h, event, { facts: {} }));
    expect(plans.find((plan) => plan.actionRef === 'workflow.missing')).toMatchObject({
      readiness: 'blocked',
      blocker: 'EVENT_AUTOMATION_WORKFLOW_NOT_FOUND:missing.workflow',
    });
  });
});
