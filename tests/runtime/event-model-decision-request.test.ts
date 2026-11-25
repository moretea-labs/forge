import { describe, expect, test } from 'bun:test';
import { createEventEnvelope, type EventPolicyV1 } from '../../packages/kernel/events';
import type { ModelProfileV1 } from '../../packages/kernel/models';
import { buildEventModelDecisionRequest } from '../../src/runtime/events/event-model-decision-request';

const envelope = createEventEnvelope({
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
const policy: EventPolicyV1 = {
  schemaVersion: 1,
  policyId: 'mail-triage',
  revision: 2,
  enabled: true,
  match: { sources: ['agentmail.watch'], providers: ['agentmail'] },
  decision: { mode: 'model', modelProfileId: 'fast', minimumConfidence: 0.85, instructionTemplateId: 'mail-triage-v2' },
  allowedActions: [
    { actionId: 'mail.label', permission: 'workspace_write', requiresApproval: false },
    { actionId: 'mail.send_reply', permission: 'external_write', requiresApproval: true },
  ],
  budget: { timeoutMs: 4000, maxInputBytes: 12000, maxOutputTokens: 300 },
  failure: { onTimeout: 'hold', onInvalidDecision: 'quarantine' },
};
const profile: ModelProfileV1 = {
  schemaVersion: 1,
  profileId: 'fast',
  revision: 3,
  enabled: true,
  providerId: 'deepseek',
  connectionId: 'primary-deepseek',
  modelId: 'deepseek-chat',
  protocol: 'chat_completions',
  tier: 'fast_classification',
  instructionTemplateId: 'default-event-v1',
  outputSchemaId: 'event-decision-v1',
  fallbackOn: [],
  budget: { timeoutMs: 5000, maxInputTokens: 32000, maxOutputTokens: 512, maxCostMicros: 2500 },
};
const instruction = {
  schemaVersion: 1 as const,
  templateId: 'mail-triage-v2',
  revision: 4,
  content: 'Classify the structured event facts and return only the configured output schema.',
};
const outputSchema = {
  schemaVersion: 1 as const,
  schemaId: 'event-decision-v1',
  revision: 1,
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['outcome', 'confidence'],
    properties: { outcome: { enum: ['act', 'ignore', 'needs_review'] }, confidence: { type: 'number' } },
  },
};
const context = {
  schemaVersion: 1 as const,
  facts: { sender_domain: 'apple.com', subject_class: 'app_review', has_attachment: false },
  evidenceRefs: ['agentmail://event/42#headers'],
};

describe('Structured Event Model Decision Request', () => {
  test('builds a provider-neutral request from configuration without credentials or tools', () => {
    const request = buildEventModelDecisionRequest({ envelope, policy, profile, instruction, outputSchema, context });
    expect(request).toMatchObject({
      schemaVersion: 1,
      event: { eventId: envelope.eventId, eventType: 'mail.watch.matched' },
      model: { profileId: 'fast', providerId: 'deepseek', connectionId: 'primary-deepseek', modelId: 'deepseek-chat' },
      policy: { policyId: 'mail-triage', revision: 2, minimumConfidence: 0.85 },
      budget: {
        timeoutMs: 4000,
        maxInputBytes: 12000,
        maxInputTokens: 32000,
        maxOutputTokens: 300,
        maxCostMicros: 2500,
      },
      safety: { toolCalling: false, actionExecution: false, rawPayloadIncluded: false, authorizationOwner: 'forge' },
    });
    expect(request).not.toHaveProperty('apiKey');
    expect(request).not.toHaveProperty('tools');
    expect(JSON.stringify(request)).not.toContain('Authorization');
  });

  test('uses configured template content and safe structured facts rather than embedding provider payload', () => {
    const request = buildEventModelDecisionRequest({ envelope, policy, profile, instruction, outputSchema, context });
    expect(request.instruction.content).toBe(instruction.content);
    expect(request.context.facts).toEqual({
      has_attachment: false,
      sender_domain: 'apple.com',
      subject_class: 'app_review',
    });
    expect(request.event.payloadRef.key).toBe('agentmail://event/42');
    expect(request).not.toHaveProperty('payload');
  });

  test('creates stable request identity from event, policy revision and model profile revision', () => {
    const first = buildEventModelDecisionRequest({ envelope, policy, profile, instruction, outputSchema, context });
    const same = buildEventModelDecisionRequest({ envelope, policy, profile, instruction, outputSchema, context });
    const updated = buildEventModelDecisionRequest({
      envelope,
      policy: { ...policy, revision: 3 },
      profile,
      instruction,
      outputSchema,
      context,
    });
    expect(first.requestId).toBe(same.requestId);
    expect(first.requestId).not.toBe(updated.requestId);
  });

  test('fails closed on dangling template/schema/profile references and remote schema references', () => {
    expect(() =>
      buildEventModelDecisionRequest({
        envelope,
        policy,
        profile: { ...profile, profileId: 'other' },
        instruction,
        outputSchema,
        context,
      }),
    ).toThrow('EVENT_DECISION_MODEL_PROFILE_MISMATCH');
    expect(() =>
      buildEventModelDecisionRequest({
        envelope,
        policy,
        profile,
        instruction: { ...instruction, templateId: 'wrong' },
        outputSchema,
        context,
      }),
    ).toThrow('EVENT_DECISION_INSTRUCTION_TEMPLATE_MISMATCH');
    expect(() =>
      buildEventModelDecisionRequest({
        envelope,
        policy,
        profile,
        instruction,
        outputSchema: { ...outputSchema, schemaId: 'wrong' },
        context,
      }),
    ).toThrow('EVENT_DECISION_OUTPUT_SCHEMA_MISMATCH');
    expect(() =>
      buildEventModelDecisionRequest({
        envelope,
        policy,
        profile,
        instruction,
        outputSchema: { ...outputSchema, jsonSchema: { $ref: 'https://example.com/schema.json' } },
        context,
      }),
    ).toThrow('MODEL_OUTPUT_SCHEMA_REMOTE_REFERENCE_UNSUPPORTED');
  });

  test('enforces context size and value boundaries before a model client sees the request', () => {
    expect(() =>
      buildEventModelDecisionRequest({
        envelope,
        policy,
        profile,
        instruction,
        outputSchema,
        context: { ...context, facts: { bad: { nested: true } as never } },
      }),
    ).toThrow('EVENT_DECISION_CONTEXT_VALUE_INVALID');
    expect(() =>
      buildEventModelDecisionRequest({
        envelope,
        policy: { ...policy, budget: { ...policy.budget, maxInputBytes: 256 } },
        profile,
        instruction,
        outputSchema,
        context: { ...context, facts: { text: 'x'.repeat(1000) } },
      }),
    ).toThrow('EVENT_DECISION_CONTEXT_BUDGET_EXCEEDED');
  });
});
