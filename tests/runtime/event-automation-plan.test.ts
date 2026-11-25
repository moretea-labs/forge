import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventEnvelope, type EventRuleV1 } from '../../packages/kernel/events';
import type { ModelProfileV1 } from '../../packages/kernel/models';
import { createEventActionDefinition } from '../../src/runtime/events/event-action-registry-store';
import { buildEventAutomationPlans } from '../../src/runtime/events/event-automation-plan';
import { createEventRule, evaluatePersistedEventRules } from '../../src/runtime/events/event-rule-store';
import {
  ensureAgentMailEventWorkflowInstalled,
  AGENTMAIL_EVENT_WORKFLOW_ID,
} from '../../src/runtime/workflows/first-party/agentmail-event';
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
    ensureAgentMailEventWorkflowInstalled(h);
    createEventActionDefinition(h, {
      schemaVersion: 1,
      actionRef: 'workflow.agentmail',
      revision: 1,
      enabled: true,
      handler: { kind: 'workflow', workflowId: AGENTMAIL_EVENT_WORKFLOW_ID, registryScope: { kind: 'controller' } },
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
      handler: { kind: 'workflow', workflowId: AGENTMAIL_EVENT_WORKFLOW_ID },
      inputs: { message_id: 'm1' },
      authorization: { state: 'not_authorized', risk: 'workspace_write', requiresApproval: false },
      execution: 'not_executed',
    });
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
