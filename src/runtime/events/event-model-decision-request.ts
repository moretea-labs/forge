import { createHash } from 'node:crypto';
import {
  validateEventEnvelopeV1,
  validateEventPolicyV1,
  type EventEnvelopeV1,
  type EventPolicyV1,
} from '../../../packages/kernel/events';
import {
  validateModelProfileV1,
  type ModelInstructionTemplateV1,
  type ModelOutputSchemaV1,
  type ModelProfileV1,
  type StructuredModelDecisionRequestV1,
} from '../../../packages/kernel/models';

export interface EventDecisionContextV1 {
  schemaVersion: 1;
  facts: Record<string, string | number | boolean | null>;
  evidenceRefs: string[];
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validateInstruction(value: ModelInstructionTemplateV1): ModelInstructionTemplateV1 {
  if (
    value.schemaVersion !== 1 ||
    !IDENTIFIER.test(value.templateId) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  )
    throw new Error('MODEL_INSTRUCTION_TEMPLATE_INVALID');
  if (!value.content.trim() || value.content.length > 32_000)
    throw new Error('MODEL_INSTRUCTION_TEMPLATE_CONTENT_INVALID');
  return { ...value };
}

function validateOutputSchema(value: ModelOutputSchemaV1): ModelOutputSchemaV1 {
  if (
    value.schemaVersion !== 1 ||
    !IDENTIFIER.test(value.schemaId) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  )
    throw new Error('MODEL_OUTPUT_SCHEMA_INVALID');
  const serialized = JSON.stringify(value.jsonSchema);
  if (!serialized || serialized.length > 64_000) throw new Error('MODEL_OUTPUT_SCHEMA_SIZE_INVALID');
  if (serialized.includes('"$ref"') || serialized.includes('"$dynamicRef"'))
    throw new Error('MODEL_OUTPUT_SCHEMA_REMOTE_REFERENCE_UNSUPPORTED');
  return { ...value, jsonSchema: structuredClone(value.jsonSchema) };
}

function validateContext(value: EventDecisionContextV1, maxInputBytes: number): EventDecisionContextV1 {
  if (value.schemaVersion !== 1 || !value.facts || typeof value.facts !== 'object' || Array.isArray(value.facts))
    throw new Error('EVENT_DECISION_CONTEXT_INVALID');
  const facts = Object.fromEntries(Object.entries(value.facts).sort(([left], [right]) => left.localeCompare(right)));
  for (const [key, fact] of Object.entries(facts)) {
    if (!IDENTIFIER.test(key)) throw new Error('EVENT_DECISION_CONTEXT_KEY_INVALID');
    if (!['string', 'number', 'boolean'].includes(typeof fact) && fact !== null)
      throw new Error('EVENT_DECISION_CONTEXT_VALUE_INVALID');
    if (typeof fact === 'string' && fact.length > 8_000) throw new Error('EVENT_DECISION_CONTEXT_VALUE_TOO_LARGE');
    if (typeof fact === 'number' && !Number.isFinite(fact)) throw new Error('EVENT_DECISION_CONTEXT_VALUE_INVALID');
  }
  if (
    !Array.isArray(value.evidenceRefs) ||
    value.evidenceRefs.length > 32 ||
    value.evidenceRefs.some((ref) => typeof ref !== 'string' || ref.length > 512)
  )
    throw new Error('EVENT_DECISION_CONTEXT_EVIDENCE_INVALID');
  if (Buffer.byteLength(JSON.stringify(facts), 'utf8') > maxInputBytes)
    throw new Error('EVENT_DECISION_CONTEXT_BUDGET_EXCEEDED');
  return { schemaVersion: 1, facts, evidenceRefs: [...value.evidenceRefs] };
}

function stableRequestId(
  eventId: string,
  policyId: string,
  policyRevision: number,
  profileId: string,
  profileRevision: number,
): string {
  const digest = createHash('sha256')
    .update([eventId, policyId, String(policyRevision), profileId, String(profileRevision)].join('\n'), 'utf8')
    .digest('hex');
  return 'event-decision:' + digest;
}

/** Build only a structured model request. No credentials are read and no model/tool/action is invoked. */
export function buildEventModelDecisionRequest(input: {
  envelope: EventEnvelopeV1;
  policy: EventPolicyV1;
  profile: ModelProfileV1;
  instruction: ModelInstructionTemplateV1;
  outputSchema: ModelOutputSchemaV1;
  context: EventDecisionContextV1;
}): StructuredModelDecisionRequestV1 {
  const envelope = validateEventEnvelopeV1(input.envelope);
  const policy = validateEventPolicyV1(input.policy);
  const profile = validateModelProfileV1(input.profile);
  if (policy.decision.mode !== 'model' || policy.decision.modelProfileId !== profile.profileId)
    throw new Error('EVENT_DECISION_MODEL_PROFILE_MISMATCH');
  const instruction = validateInstruction(input.instruction);
  const requiredTemplateId = policy.decision.instructionTemplateId ?? profile.instructionTemplateId;
  if (instruction.templateId !== requiredTemplateId) throw new Error('EVENT_DECISION_INSTRUCTION_TEMPLATE_MISMATCH');
  const output = validateOutputSchema(input.outputSchema);
  if (output.schemaId !== profile.outputSchemaId) throw new Error('EVENT_DECISION_OUTPUT_SCHEMA_MISMATCH');
  const context = validateContext(input.context, policy.budget.maxInputBytes);

  return {
    schemaVersion: 1,
    requestId: stableRequestId(envelope.eventId, policy.policyId, policy.revision, profile.profileId, profile.revision),
    event: {
      eventId: envelope.eventId,
      source: envelope.source,
      provider: envelope.provider,
      eventType: envelope.eventType,
      occurredAt: envelope.occurredAt,
      scope: { kind: envelope.scope.kind, id: envelope.scope.id },
      subject: { kind: envelope.subject.kind, id: envelope.subject.id },
      payloadRef: {
        store: envelope.payloadRef.store,
        key: envelope.payloadRef.key,
        digest: envelope.payloadRef.digest.value,
      },
    },
    context,
    policy: {
      policyId: policy.policyId,
      revision: policy.revision,
      ...(policy.decision.minimumConfidence === undefined
        ? {}
        : { minimumConfidence: policy.decision.minimumConfidence }),
      allowedActions: policy.allowedActions.map((action) => ({ ...action })),
    },
    model: {
      profileId: profile.profileId,
      revision: profile.revision,
      providerId: profile.providerId,
      connectionId: profile.connectionId,
      modelId: profile.modelId,
      protocol: profile.protocol,
      tier: profile.tier,
    },
    instruction,
    output,
    budget: {
      timeoutMs: Math.min(policy.budget.timeoutMs, profile.budget.timeoutMs),
      maxInputBytes: policy.budget.maxInputBytes,
      maxInputTokens: profile.budget.maxInputTokens,
      maxOutputTokens: Math.min(policy.budget.maxOutputTokens, profile.budget.maxOutputTokens),
      ...(profile.budget.maxCostMicros === undefined ? {} : { maxCostMicros: profile.budget.maxCostMicros }),
    },
    safety: {
      toolCalling: false,
      actionExecution: false,
      rawPayloadIncluded: false,
      authorizationOwner: 'forge',
    },
  };
}
