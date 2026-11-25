import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventRuleV1 } from '../../packages/kernel/events';
import { createEventActionDefinition } from '../../src/runtime/events/event-action-registry-store';
import { applyEventRuleProposal, preflightEventRuleProposal } from '../../src/runtime/events/event-rule-authoring';
import { readEventRule } from '../../src/runtime/events/event-rule-store';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function home() {
  const value = mkdtempSync(join(tmpdir(), 'forge-rule-authoring-'));
  roots.push(value);
  return value;
}
function rule(enabled = true): EventRuleV1 {
  return {
    schemaVersion: 1,
    ruleId: 'apple-mail',
    revision: 1,
    enabled,
    trigger: { sources: ['agentmail.watch'], providers: ['agentmail'] },
    condition: { kind: 'fact', key: 'mail.sender_domain', operator: 'equals', value: 'apple.com' },
    routing: 'first_matching',
    routes: [
      {
        routeId: 'notify',
        action: { actionRef: 'notification.owner', inputs: { message: { kind: 'fact', key: 'mail.subject' } } },
      },
    ],
    failure: { onConditionError: 'hold', onRouteError: 'quarantine' },
  };
}
function proposal(author: 'human' | 'ui' | 'model' | 'import' = 'model', enabled = true) {
  return {
    schemaVersion: 1 as const,
    proposalId: 'proposal-1',
    author: { kind: author, id: author + '-author' },
    operation: { kind: 'create' as const },
    rule: rule(enabled),
  };
}
function registerNotification(h: string, risk: 'read' | 'external_write' = 'read') {
  createEventActionDefinition(h, {
    schemaVersion: 1,
    actionRef: 'notification.owner',
    revision: 1,
    enabled: true,
    handler: { kind: 'capability', capabilityId: 'owner.notification' },
    inputContract: { message: { type: 'string', required: true } },
    authorization: { risk, requiresApproval: risk === 'external_write' },
  });
}

describe('Event Rule Authoring', () => {
  test('uses the same deterministic proposal interface for model, UI and human authors', () => {
    const h = home();
    registerNotification(h);
    for (const author of ['model', 'ui', 'human'] as const) {
      const checked = preflightEventRuleProposal(h, { ...proposal(author), proposalId: 'proposal-' + author });
      expect(checked.valid).toBe(true);
      expect(checked.author.kind).toBe(author);
      expect(checked.actionRefs).toEqual(['notification.owner']);
    }
  });
  test('model-authored proposals can be applied when the caller has rule authority; author kind itself grants nothing', () => {
    const h = home();
    registerNotification(h);
    expect(() => applyEventRuleProposal(h, proposal('model'), { canWriteRules: false, canEnableRules: true })).toThrow(
      'EVENT_RULE_AUTHORING_WRITE_NOT_AUTHORIZED',
    );
    const created = applyEventRuleProposal(h, proposal('model'), { canWriteRules: true, canEnableRules: true });
    expect(created.value.ruleId).toBe('apple-mail');
    expect(readEventRule(h, 'apple-mail')?.value.enabled).toBe(true);
  });
  test('allows drafting disabled rules without enable authority', () => {
    const h = home();
    registerNotification(h);
    const created = applyEventRuleProposal(h, proposal('model', false), { canWriteRules: true, canEnableRules: false });
    expect(created.value.enabled).toBe(false);
  });
  test('rejects dangling actions and missing required action inputs before persistence', () => {
    const h = home();
    expect(preflightEventRuleProposal(h, proposal()).issues.map((x) => x.code)).toContain(
      'EVENT_RULE_ACTION_NOT_FOUND',
    );
    registerNotification(h);
    const bad = {
      ...proposal(),
      rule: { ...rule(), routes: [{ routeId: 'notify', action: { actionRef: 'notification.owner' } }] },
    };
    expect(preflightEventRuleProposal(h, bad).issues.map((x) => x.code)).toContain('EVENT_RULE_ACTION_INPUT_REQUIRED');
  });
  test('requires explicit sensitive-action approval when enabling a rule', () => {
    const h = home();
    registerNotification(h, 'external_write');
    const checked = preflightEventRuleProposal(h, proposal());
    expect(checked.sensitiveActionRefs).toEqual(['notification.owner']);
    expect(() => applyEventRuleProposal(h, proposal(), { canWriteRules: true, canEnableRules: true })).toThrow(
      'EVENT_RULE_AUTHORING_SENSITIVE_ACTION_APPROVAL_REQUIRED:notification.owner',
    );
    const created = applyEventRuleProposal(h, proposal(), {
      canWriteRules: true,
      canEnableRules: true,
      approvedSensitiveActionRefs: ['notification.owner'],
    });
    expect(created.value.enabled).toBe(true);
  });
  test('preflights update record revision and logical revision instead of overwriting concurrent edits', () => {
    const h = home();
    registerNotification(h);
    const created = applyEventRuleProposal(h, proposal('human'), { canWriteRules: true, canEnableRules: true });
    const update = {
      schemaVersion: 1 as const,
      proposalId: 'proposal-update',
      author: { kind: 'model' as const, id: 'model-author' },
      operation: { kind: 'update' as const, ruleId: 'apple-mail', expectedRecordRevision: created.revision },
      rule: { ...created.value, revision: 2, enabled: false },
    };
    expect(preflightEventRuleProposal(h, update).valid).toBe(true);
    applyEventRuleProposal(h, update, { canWriteRules: true, canEnableRules: false });
    const stale = { ...update, proposalId: 'proposal-stale', rule: { ...update.rule, revision: 3 } };
    expect(preflightEventRuleProposal(h, stale).issues.map((x) => x.code)).toContain('EVENT_RULE_REVISION_CONFLICT');
  });
});
