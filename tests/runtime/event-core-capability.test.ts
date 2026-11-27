import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventRuleV1 } from '../../packages/kernel/events';
import { callCoreCapabilityAdapter } from '../../adapters/mcp/runtime-gateway/core-capability-adapter';
import {
  getCoreCapabilityExecutionSchema,
  listCapabilityDescriptors,
} from '../../src/runtime/control-plane/facade/capability-registry';
import { createEventActionDefinition } from '../../src/runtime/events/event-action-registry-store';
import { createEventRule } from '../../src/runtime/events/event-rule-store';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function home() {
  const value = mkdtempSync(join(tmpdir(), 'forge-event-capability-'));
  roots.push(value);
  return value;
}

function ctx(controllerHome: string) {
  return {
    controllerHome,
    sessionId: 'test',
    principalId: 'test',
    controllerInstanceId: 'test',
    repositories: [],
  } as never;
}

function content(result: Awaited<ReturnType<typeof callCoreCapabilityAdapter>>) {
  const item = result?.content?.[0];
  if (item?.type !== 'text') throw new Error('EVENT_CORE_CAPABILITY_TEXT_RESULT_REQUIRED');
  return JSON.parse(item.text);
}

function action(h: string) {
  return createEventActionDefinition(h, {
    schemaVersion: 1,
    actionRef: 'audit.issue',
    revision: 1,
    enabled: true,
    handler: { kind: 'capability', capabilityId: 'audit.event' },
    inputContract: { issue: { type: 'string', required: true } },
    authorization: { risk: 'read', requiresApproval: false },
  });
}

function rule(enabled: boolean): EventRuleV1 {
  return {
    schemaVersion: 1,
    ruleId: 'github.issue.audit',
    revision: 1,
    enabled,
    trigger: {
      sources: ['github.issue'],
      providers: ['github'],
      eventTypes: ['issue.updated'],
      scopeKinds: ['repository'],
    },
    condition: { kind: 'fact', key: 'priority', operator: 'equals', value: 'high' },
    routing: 'first_matching',
    routes: [
      {
        routeId: 'audit',
        action: {
          actionRef: 'audit.issue',
          inputs: { issue: { kind: 'event', path: 'subject.id' } },
        },
      },
    ],
    failure: { onConditionError: 'hold', onRouteError: 'quarantine' },
  };
}

function proposal(enabled: boolean) {
  return {
    schemaVersion: 1,
    proposalId: enabled ? 'proposal-enabled' : 'proposal-disabled',
    author: { kind: 'ui', id: 'native-client' },
    operation: { kind: 'create' },
    rule: rule(enabled),
  };
}

const envelope = {
  schemaVersion: 1,
  eventId: 'github.issue:123:updated:1',
  source: 'github.issue',
  provider: 'github',
  eventType: 'issue.updated',
  occurredAt: '2026-11-26T12:00:00.000Z',
  receivedAt: '2026-11-26T12:00:01.000Z',
  scope: { kind: 'repository', id: 'moretea-labs/forge' },
  subject: { kind: 'issue', id: '123' },
  correlationId: 'issue:123',
  idempotencyKey: 'github:issue:123:updated:1',
  payloadRef: {
    store: 'provider',
    key: 'github/issues/123/events/1',
    mediaType: 'application/json',
    schemaVersion: 1,
    digest: { algorithm: 'sha256', value: '0'.repeat(64), bytes: 0 },
  },
};

describe('event.automation core capability', () => {
  test('is a first-class typed event capability without a parallel execution surface', () => {
    expect(listCapabilityDescriptors().find((item) => item.capabilityId === 'event.automation')).toMatchObject({
      domain: 'event',
      group: 'event',
      exposedVia: 'capability_execute',
    });
    expect(getCoreCapabilityExecutionSchema('event.automation')).toMatchObject({
      executeWith: 'capability_execute',
      actions: {
        list_rules: { readOnly: true },
        get_rule: { readOnly: true },
        list_actions: { readOnly: true },
        get_action: { readOnly: true },
        authoring_preflight: { readOnly: true },
        authoring_apply: { readOnly: false },
        evaluate: { readOnly: true },
      },
    });
  });

  test('lists and reads the existing Action Registry and Event Rule stores', async () => {
    const h = home();
    action(h);
    createEventRule(h, rule(true));
    const actions = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'event.automation',
        action: 'list_actions',
        arguments: {},
      }),
    );
    expect(actions.actions).toHaveLength(1);
    expect(actions.actions[0].value.actionRef).toBe('audit.issue');
    const rules = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'event.automation',
        action: 'get_rule',
        arguments: { rule_id: 'github.issue.audit' },
      }),
    );
    expect(rules.rule.value.enabled).toBe(true);
  });

  test('shares deterministic authoring preflight but never grants implicit enable authority', async () => {
    const h = home();
    action(h);
    const preflight = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'event.automation',
        action: 'authoring_preflight',
        arguments: { proposal: proposal(true) },
      }),
    );
    expect(preflight.preflight).toMatchObject({ valid: true, actionRefs: ['audit.issue'] });

    const refused = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'event.automation',
        action: 'authoring_apply',
        arguments: { proposal: proposal(true) },
      }),
    );
    expect(refused.error.code).toBe('EVENT_RULE_AUTHORING_ENABLE_NOT_AUTHORIZED');

    const applied = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'event.automation',
        action: 'authoring_apply',
        arguments: { proposal: proposal(false) },
      }),
    );
    expect(applied.rule.value).toMatchObject({ ruleId: 'github.issue.audit', enabled: false });
  });

  test('evaluates a non-mail Event Envelope through the same persisted rules without executing the Action', async () => {
    const h = home();
    action(h);
    createEventRule(h, rule(true));
    const evaluated = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'event.automation',
        action: 'evaluate',
        arguments: { envelope, facts: { priority: 'high' } },
      }),
    );
    expect(evaluated.execution).toBe('not_executed');
    expect(evaluated.matches).toHaveLength(1);
    expect(evaluated.matches[0]).toMatchObject({
      ruleId: 'github.issue.audit',
      evaluation: {
        matched: true,
        actions: [{ actionRef: 'audit.issue', inputs: { issue: '123' } }],
      },
    });
  });
});
