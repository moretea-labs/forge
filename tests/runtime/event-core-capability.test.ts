import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callCoreCapabilityAdapter } from '../../adapters/mcp/runtime-gateway/core-capability-adapter';
import {
  getCoreCapabilityExecutionSchema,
  listCapabilityDescriptors,
} from '../../src/runtime/control-plane/facade/capability-registry';
import { createEventActionDefinition } from '../../src/runtime/events/event-action-registry-store';

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

function registerInspectAction(controllerHome: string) {
  createEventActionDefinition(controllerHome, {
    schemaVersion: 1,
    actionRef: 'event.inspect',
    revision: 1,
    enabled: true,
    handler: { kind: 'capability', capabilityId: 'event.inspect' },
    ...{ ['author' + 'ization']: { risk: 'read', requiresApproval: false } },
  });
}

function proposal(enabled = true) {
  return {
    schemaVersion: 1,
    proposalId: 'github-rule-proposal',
    author: { kind: 'ui', id: 'forge-client' },
    operation: { kind: 'create' },
    rule: {
      schemaVersion: 1,
      ruleId: 'github-issue-inspect',
      revision: 1,
      enabled,
      trigger: { sources: ['github.issue'], providers: ['github'] },
      routing: 'first_matching',
      routes: [{ routeId: 'inspect', action: { actionRef: 'event.inspect' } }],
      failure: { onConditionError: 'hold', onRouteError: 'quarantine' },
    },
  };
}

function githubEvent() {
  return {
    schemaVersion: 1,
    eventId: 'github-event-1',
    source: 'github.issue',
    provider: 'github',
    eventType: 'issue.updated',
    occurredAt: '2026-11-26T12:00:00Z',
    receivedAt: '2026-11-26T12:00:01Z',
    scope: { kind: 'repository', id: 'moretea-labs/forge' },
    subject: { kind: 'issue', id: '718' },
    correlationId: 'issue-718',
    idempotencyKey: 'github:issue:718:update:1',
    payloadRef: {
      store: 'forge',
      key: 'event-payload/github-718-1',
      mediaType: 'application/json',
      schemaVersion: 1,
      digest: { algorithm: 'sha256', value: '0'.repeat(64), bytes: 1 },
    },
  };
}

describe('event.automation core capability', () => {
  test('is discoverable through the stable capability facade without adding a top-level tool', () => {
    const descriptor = listCapabilityDescriptors().find((item) => item.capabilityId === 'event.automation');
    expect(descriptor).toMatchObject({ domain: 'event', group: 'event', exposedVia: 'capability_execute' });
    expect(getCoreCapabilityExecutionSchema('event.automation')).toMatchObject({
      executeWith: 'capability_execute',
      actions: {
        list_rules: { readOnly: true },
        get_rule: { readOnly: true },
        list_actions: { readOnly: true },
        get_action: { readOnly: true },
        authoring_preflight: { readOnly: true },
        evaluate: { readOnly: true },
        apply: { readOnly: false },
        authoring_apply: { readOnly: false },
      },
    });
  });

  test('uses the existing Event Rule and Action owners for list, preflight and apply', async () => {
    const h = home();
    registerInspectAction(h);
    const preflight = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'event.automation',
        action: 'authoring_preflight',
        request_id: 'event-preflight',
        arguments: { proposal: proposal() },
      }),
    );
    expect(preflight.preflight).toMatchObject({
      valid: true,
      author: { kind: 'ui' },
      actionRefs: ['event.inspect'],
    });

    const applied = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'event.automation',
        action: 'apply',
        request_id: 'event-apply',
        arguments: { proposal: proposal(), allow_enable: true },
      }),
    );
    expect(applied.rule.value).toMatchObject({ ruleId: 'github-issue-inspect', enabled: true });

    const listed = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'event.automation',
        action: 'list_rules',
        request_id: 'event-list',
        arguments: {},
      }),
    );
    expect(listed.rules).toHaveLength(1);

    const got = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'event.automation',
        action: 'get_rule',
        request_id: 'event-get',
        arguments: { rule_id: 'github-issue-inspect' },
      }),
    );
    expect(got.rule.value.ruleId).toBe('github-issue-inspect');

    const actions = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'event.automation',
        action: 'list_actions',
        request_id: 'event-actions',
        arguments: {},
      }),
    );
    expect(actions.actions[0].value.actionRef).toBe('event.inspect');
    const action = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'event.automation',
        action: 'get_action',
        request_id: 'event-get-action',
        arguments: { action_ref: 'event.inspect' },
      }),
    );
    expect(action.action.value.actionRef).toBe('event.inspect');
  });

  test('keeps the legacy authoring_apply alias disabled by default', async () => {
    const h = home();
    registerInspectAction(h);
    const applied = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'event.automation',
        action: 'authoring_apply',
        request_id: 'event-legacy-apply',
        arguments: { proposal: proposal(false) },
      }),
    );
    expect(applied.rule.value).toMatchObject({ ruleId: 'github-issue-inspect', enabled: false });
  });

  test('evaluates a real non-mail envelope but never executes the resolved action', async () => {
    const h = home();
    registerInspectAction(h);
    content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'event.automation',
        action: 'apply',
        request_id: 'event-enable',
        arguments: { proposal: proposal(), allow_enable: true },
      }),
    );
    const evaluated = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'event.automation',
        action: 'evaluate',
        request_id: 'event-evaluate',
        arguments: { event: githubEvent(), facts: {} },
      }),
    );
    expect(evaluated.event).toMatchObject({ source: 'github.issue', provider: 'github', eventType: 'issue.updated' });
    expect(evaluated.matches).toHaveLength(1);
    expect(evaluated.matches[0]).toMatchObject({
      ruleId: 'github-issue-inspect',
      evaluation: { matched: true, actions: [{ actionRef: 'event.inspect' }] },
    });
    expect(evaluated.execution).toBe('not_executed');
  });

  test('does not grant rule enable authority implicitly', async () => {
    const h = home();
    registerInspectAction(h);
    const denied = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'event.automation',
        action: 'apply',
        request_id: 'event-denied-enable',
        arguments: { proposal: proposal() },
      }),
    );
    expect(JSON.stringify(denied)).toContain('EVENT_RULE_AUTHORING_ENABLE_NOT_AUTHORIZED');
  });
});
