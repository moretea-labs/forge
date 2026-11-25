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
