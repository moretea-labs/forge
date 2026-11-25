import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventEnvelope, type EventPolicyV1 } from '../../packages/kernel/events';
import type { ModelProfileV1 } from '../../packages/kernel/models';
import { createEventPolicy } from '../../src/runtime/events/event-policy-store';
import { previewEventPolicies } from '../../src/runtime/events/event-policy-preview';
import { createModelProfile } from '../../src/runtime/models/model-profile-store';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});
function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'forge-event-policy-preview-'));
  roots.push(value);
  return value;
}
function policy(policyId: string, overrides: Partial<EventPolicyV1> = {}): EventPolicyV1 {
  return {
    schemaVersion: 1,
    policyId,
    revision: 1,
    enabled: true,
    match: { sources: ['agentmail.watch'], providers: ['agentmail'], eventTypes: ['mail.watch.matched'] },
    decision: { mode: 'deterministic' },
    allowedActions: [{ actionId: 'mail.label', permission: 'workspace_write', requiresApproval: false }],
    budget: { timeoutMs: 5000, maxInputBytes: 32000, maxOutputTokens: 256 },
    failure: { onTimeout: 'hold', onInvalidDecision: 'quarantine' },
    ...overrides,
  };
}
function profile(profileId: string, overrides: Partial<ModelProfileV1> = {}): ModelProfileV1 {
  return {
    schemaVersion: 1,
    profileId,
    revision: 1,
    enabled: true,
    providerId: 'deepseek',
    connectionId: 'primary-deepseek',
    modelId: 'deepseek-chat',
    protocol: 'chat_completions',
    tier: 'fast_classification',
    instructionTemplateId: 'event-classifier-v1',
    outputSchemaId: 'event-decision-v1',
    fallbackOn: [],
    budget: { timeoutMs: 5000, maxInputTokens: 32000, maxOutputTokens: 512 },
    ...overrides,
  };
}
const event = createEventEnvelope({
  eventId: 'mail:account-1:message-42',
  source: 'agentmail.watch',
  provider: 'agentmail',
  eventType: 'mail.watch.matched',
  occurredAt: '2026-11-25T10:00:00.000Z',
  receivedAt: '2026-11-25T10:00:03.000Z',
  scope: { kind: 'account', id: 'account-1' },
  subject: { kind: 'mail.message', id: 'message-42' },
  idempotencyKey: 'mail-event-42',
  payloadRef: {
    store: 'provider',
    key: 'agentmail://event/42',
    mediaType: 'application/json',
    schemaVersion: 1,
    digest: { algorithm: 'sha256', value: 'a'.repeat(64), bytes: 100 },
  },
});

describe('Event Policy preview', () => {
  test('previews deterministic actions without executing anything', () => {
    const controllerHome = home();
    createEventPolicy(controllerHome, policy('mail-label'));
    const preview = previewEventPolicies(controllerHome, event);
    expect(preview.matchedPolicyCount).toBe(1);
    expect(preview.policies[0]).toEqual({
      policyId: 'mail-label',
      revision: 1,
      decisionMode: 'deterministic',
      actions: [{ actionId: 'mail.label', permission: 'workspace_write', requiresApproval: false }],
      approvalRequired: false,
      readiness: 'ready',
      execution: 'not_executed',
    });
  });

  test('resolves a model profile and all configured fallback chains without model invocation', () => {
    const controllerHome = home();
    createModelProfile(
      controllerHome,
      profile('fast', {
        fallbackProfileId: 'balanced',
        fallbackOn: ['unavailable', 'timeout'],
      }),
    );
    createModelProfile(controllerHome, profile('balanced', { tier: 'balanced' }));
    createEventPolicy(
      controllerHome,
      policy('mail-triage', {
        decision: { mode: 'model', modelProfileId: 'fast', minimumConfidence: 0.85 },
        allowedActions: [{ actionId: 'mail.send_reply', permission: 'external_write', requiresApproval: true }],
      }),
    );
    const preview = previewEventPolicies(controllerHome, event);
    expect(preview.policies[0]).toMatchObject({
      policyId: 'mail-triage',
      decisionMode: 'model',
      minimumConfidence: 0.85,
      approvalRequired: true,
      readiness: 'ready',
      execution: 'not_executed',
      modelProfile: {
        profileId: 'fast',
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
        fallbackChains: [
          { condition: 'unavailable', profileIds: ['fast', 'balanced'] },
          { condition: 'timeout', profileIds: ['fast', 'balanced'] },
        ],
      },
    });
    expect(preview.policies[0]?.modelProfile).not.toHaveProperty('connectionId');
  });

  test('fails closed in preview when the configured model profile cannot resolve', () => {
    const controllerHome = home();
    createEventPolicy(
      controllerHome,
      policy('mail-triage', {
        decision: { mode: 'model', modelProfileId: 'missing-profile' },
      }),
    );
    expect(previewEventPolicies(controllerHome, event).policies[0]).toMatchObject({
      readiness: 'blocked',
      blocker: 'MODEL_PROFILE_FALLBACK_NOT_FOUND: missing-profile',
      execution: 'not_executed',
    });
  });

  test('returns an empty preview when no policy matches the event', () => {
    const controllerHome = home();
    createEventPolicy(
      controllerHome,
      policy('github-only', {
        match: { sources: ['github.issue.watch'], providers: ['github'] },
      }),
    );
    expect(previewEventPolicies(controllerHome, event)).toMatchObject({
      matchedPolicyCount: 0,
      policies: [],
    });
  });
});
