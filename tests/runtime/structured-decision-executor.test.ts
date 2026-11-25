import { describe, expect, test } from 'bun:test';
import type { StructuredModelDecisionRequestV1 } from '../../packages/kernel/models';
import {
  executeStructuredDecision,
  type StructuredDecisionProviderAdapter,
} from '../../src/runtime/model-clients/structured-decision-executor';

function request(overrides: Partial<StructuredModelDecisionRequestV1> = {}): StructuredModelDecisionRequestV1 {
  return {
    schemaVersion: 1,
    requestId: 'event-decision:' + 'a'.repeat(64),
    event: {
      eventId: 'event-1',
      source: 'agentmail.watch',
      provider: 'agentmail',
      eventType: 'mail.watch.matched',
      occurredAt: '2026-11-25T10:00:00.000Z',
      scope: { kind: 'account', id: 'account-1' },
      subject: { kind: 'mail.message', id: 'message-1' },
      payloadRef: { store: 'provider', key: 'agentmail://event/1', digest: 'b'.repeat(64) },
    },
    context: { facts: { sender_domain: 'apple.com' }, evidenceRefs: [] },
    policy: {
      policyId: 'mail-triage',
      revision: 1,
      allowedActions: [{ actionId: 'mail.label', permission: 'workspace_write', requiresApproval: false }],
    },
    model: {
      profileId: 'fast',
      revision: 1,
      providerId: 'fake',
      connectionId: 'fake-primary',
      modelId: 'fake-model',
      protocol: 'chat_completions',
      tier: 'fast_classification',
    },
    instruction: { schemaVersion: 1, templateId: 'event-v1', revision: 1, content: 'Return structured decision JSON.' },
    output: { schemaVersion: 1, schemaId: 'decision-v1', revision: 1, jsonSchema: { type: 'object' } },
    budget: { timeoutMs: 100, maxInputBytes: 4096, maxInputTokens: 2048, maxOutputTokens: 128 },
    safety: { toolCalling: false, actionExecution: false, rawPayloadIncluded: false, authorizationOwner: 'forge' },
    ...overrides,
  };
}
function adapter(execute: StructuredDecisionProviderAdapter['execute']): StructuredDecisionProviderAdapter {
  return { providerId: 'fake', protocols: ['chat_completions'], execute };
}

describe('Structured Decision Executor', () => {
  test('executes one provider-neutral decision round and keeps execution authority outside the adapter', async () => {
    const seen: StructuredModelDecisionRequestV1[] = [];
    const receipt = await executeStructuredDecision(
      request(),
      adapter(async (input) => {
        seen.push(input);
        return {
          ok: true,
          output: { outcome: 'ignore', confidence: 0.99 },
          usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        };
      }),
    );
    expect(seen).toHaveLength(1);
    expect(receipt).toMatchObject({
      providerId: 'fake',
      profileId: 'fast',
      modelId: 'fake-model',
      result: { ok: true, output: { outcome: 'ignore', confidence: 0.99 } },
      safety: { toolCalling: false, actionExecution: false, authorizationOwner: 'forge' },
    });
  });

  test('rejects provider/protocol mismatch before invoking the adapter', async () => {
    let invoked = false;
    const fake = adapter(async () => {
      invoked = true;
      return { ok: true, output: {} };
    });
    await expect(
      executeStructuredDecision(request({ model: { ...request().model, providerId: 'other' } }), fake),
    ).rejects.toThrow('STRUCTURED_DECISION_PROVIDER_MISMATCH');
    await expect(
      executeStructuredDecision(request({ model: { ...request().model, protocol: 'responses' } }), fake),
    ).rejects.toThrow('STRUCTURED_DECISION_PROTOCOL_UNSUPPORTED');
    expect(invoked).toBe(false);
  });

  test('converts provider exceptions to bounded provider_error receipts', async () => {
    const receipt = await executeStructuredDecision(
      request(),
      adapter(async () => {
        throw new Error('provider exploded');
      }),
    );
    expect(receipt.result).toEqual({ ok: false, failure: 'provider_error', message: 'provider exploded' });
  });

  test('enforces timeout using the request budget', async () => {
    const receipt = await executeStructuredDecision(
      request(),
      adapter(
        (_input, signal) =>
          new Promise((resolve) => {
            signal.addEventListener(
              'abort',
              () => resolve({ ok: false, failure: 'timeout', message: 'adapter observed abort' }),
              { once: true },
            );
          }),
      ),
    );
    expect(receipt.result).toMatchObject({ ok: false, failure: 'timeout' });
  });

  test('rejects requests that attempt to weaken Forge safety boundaries', async () => {
    const fake = adapter(async () => ({ ok: true, output: {} }));
    await expect(
      executeStructuredDecision(
        request({
          safety: {
            toolCalling: true as never,
            actionExecution: false,
            rawPayloadIncluded: false,
            authorizationOwner: 'forge',
          },
        }),
        fake,
      ),
    ).rejects.toThrow('STRUCTURED_DECISION_SAFETY_BOUNDARY_INVALID');
  });
});
