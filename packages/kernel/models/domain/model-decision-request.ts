import type { ModelProfileProtocol, ModelProfileTier } from './model-profile';

export interface ModelInstructionTemplateV1 {
  schemaVersion: 1;
  templateId: string;
  revision: number;
  content: string;
}

export interface ModelOutputSchemaV1 {
  schemaVersion: 1;
  schemaId: string;
  revision: number;
  jsonSchema: Record<string, unknown>;
}

const MODEL_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function modelArtifactRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function modelArtifactExactKeys(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(code);
}

export function validateModelInstructionTemplateV1(value: unknown): ModelInstructionTemplateV1 {
  if (!modelArtifactRecord(value)) throw new Error('MODEL_INSTRUCTION_TEMPLATE_INVALID');
  modelArtifactExactKeys(
    value,
    ['schemaVersion', 'templateId', 'revision', 'content'],
    'MODEL_INSTRUCTION_TEMPLATE_FIELD_UNSUPPORTED',
  );
  if (value.schemaVersion !== 1 || typeof value.templateId !== 'string' || !MODEL_ARTIFACT_ID.test(value.templateId))
    throw new Error('MODEL_INSTRUCTION_TEMPLATE_INVALID');
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1)
    throw new Error('MODEL_INSTRUCTION_TEMPLATE_REVISION_INVALID');
  if (typeof value.content !== 'string' || !value.content.trim() || value.content.length > 32_000)
    throw new Error('MODEL_INSTRUCTION_TEMPLATE_CONTENT_INVALID');
  return { schemaVersion: 1, templateId: value.templateId, revision: Number(value.revision), content: value.content };
}

export function validateModelOutputSchemaV1(value: unknown): ModelOutputSchemaV1 {
  if (!modelArtifactRecord(value)) throw new Error('MODEL_OUTPUT_SCHEMA_INVALID');
  modelArtifactExactKeys(
    value,
    ['schemaVersion', 'schemaId', 'revision', 'jsonSchema'],
    'MODEL_OUTPUT_SCHEMA_FIELD_UNSUPPORTED',
  );
  if (value.schemaVersion !== 1 || typeof value.schemaId !== 'string' || !MODEL_ARTIFACT_ID.test(value.schemaId))
    throw new Error('MODEL_OUTPUT_SCHEMA_INVALID');
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1)
    throw new Error('MODEL_OUTPUT_SCHEMA_REVISION_INVALID');
  if (!modelArtifactRecord(value.jsonSchema)) throw new Error('MODEL_OUTPUT_SCHEMA_INVALID');
  const serialized = JSON.stringify(value.jsonSchema);
  if (!serialized || serialized.length > 64_000) throw new Error('MODEL_OUTPUT_SCHEMA_SIZE_INVALID');
  if (serialized.includes('"$ref"') || serialized.includes('"$dynamicRef"'))
    throw new Error('MODEL_OUTPUT_SCHEMA_REMOTE_REFERENCE_UNSUPPORTED');
  return {
    schemaVersion: 1,
    schemaId: value.schemaId,
    revision: Number(value.revision),
    jsonSchema: structuredClone(value.jsonSchema),
  };
}

export interface StructuredModelDecisionRequestV1 {
  schemaVersion: 1;
  requestId: string;
  event: {
    eventId: string;
    source: string;
    provider: string;
    eventType: string;
    occurredAt: string;
    scope: { kind: string; id: string };
    subject: { kind: string; id: string };
    payloadRef: { store: string; key: string; digest: string };
  };
  context: {
    facts: Record<string, string | number | boolean | null>;
    evidenceRefs: string[];
  };
  policy: {
    policyId: string;
    revision: number;
    minimumConfidence?: number;
    allowedActions: Array<{
      actionId: string;
      permission: 'read' | 'workspace_write' | 'external_write' | 'destructive';
      requiresApproval: boolean;
    }>;
  };
  model: {
    profileId: string;
    revision: number;
    providerId: string;
    connectionId: string;
    modelId: string;
    protocol: ModelProfileProtocol;
    tier: ModelProfileTier;
  };
  instruction: ModelInstructionTemplateV1;
  output: ModelOutputSchemaV1;
  budget: {
    timeoutMs: number;
    maxInputBytes: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxCostMicros?: number;
  };
  safety: {
    toolCalling: false;
    actionExecution: false;
    rawPayloadIncluded: false;
    authorizationOwner: 'forge';
  };
}
