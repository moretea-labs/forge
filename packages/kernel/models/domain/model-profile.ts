export type ModelProfileTier = 'fast_classification' | 'balanced' | 'deep_reasoning';
export type ModelProfileProtocol = 'chat_completions' | 'responses';

/** Reusable provider-neutral model configuration. Credentials and executable permissions live elsewhere. */
export interface ModelProfileV1 {
  schemaVersion: 1;
  profileId: string;
  revision: number;
  enabled: boolean;
  providerId: string;
  connectionId: string;
  modelId: string;
  protocol: ModelProfileProtocol;
  tier: ModelProfileTier;
  instructionTemplateId: string;
  outputSchemaId: string;
  fallbackProfileId?: string;
  fallbackOn: Array<'unavailable' | 'rate_limited' | 'timeout'>;
  budget: {
    timeoutMs: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxCostMicros?: number;
  };
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(code);
}
function identifier(value: unknown, code: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(code);
  return value;
}
function boundedInteger(value: unknown, min: number, max: number, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(code);
  return Number(value);
}

export function validateModelProfileV1(value: unknown): ModelProfileV1 {
  if (!record(value)) throw new Error('MODEL_PROFILE_INVALID');
  exact(
    value,
    [
      'schemaVersion',
      'profileId',
      'revision',
      'enabled',
      'providerId',
      'connectionId',
      'modelId',
      'protocol',
      'tier',
      'instructionTemplateId',
      'outputSchemaId',
      'fallbackProfileId',
      'fallbackOn',
      'budget',
    ],
    'MODEL_PROFILE_FIELD_UNSUPPORTED',
  );
  if (value.schemaVersion !== 1) throw new Error('MODEL_PROFILE_SCHEMA_VERSION_UNSUPPORTED');
  const profileId = identifier(value.profileId, 'MODEL_PROFILE_ID_INVALID');
  const revision = boundedInteger(value.revision, 1, Number.MAX_SAFE_INTEGER, 'MODEL_PROFILE_REVISION_INVALID');
  if (typeof value.enabled !== 'boolean') throw new Error('MODEL_PROFILE_ENABLED_INVALID');
  const providerId = identifier(value.providerId, 'MODEL_PROFILE_PROVIDER_INVALID');
  const connectionId = identifier(value.connectionId, 'MODEL_PROFILE_CONNECTION_INVALID');
  const modelId = identifier(value.modelId, 'MODEL_PROFILE_MODEL_INVALID');
  if (value.protocol !== 'chat_completions' && value.protocol !== 'responses')
    throw new Error('MODEL_PROFILE_PROTOCOL_INVALID');
  if (!['fast_classification', 'balanced', 'deep_reasoning'].includes(String(value.tier)))
    throw new Error('MODEL_PROFILE_TIER_INVALID');
  const instructionTemplateId = identifier(value.instructionTemplateId, 'MODEL_PROFILE_INSTRUCTION_TEMPLATE_INVALID');
  const outputSchemaId = identifier(value.outputSchemaId, 'MODEL_PROFILE_OUTPUT_SCHEMA_INVALID');
  const fallbackProfileId =
    value.fallbackProfileId === undefined
      ? undefined
      : identifier(value.fallbackProfileId, 'MODEL_PROFILE_FALLBACK_INVALID');
  if (fallbackProfileId === profileId) throw new Error('MODEL_PROFILE_FALLBACK_SELF_REFERENCE');
  if (
    !Array.isArray(value.fallbackOn) ||
    value.fallbackOn.some((item) => !['unavailable', 'rate_limited', 'timeout'].includes(String(item))) ||
    new Set(value.fallbackOn).size !== value.fallbackOn.length
  )
    throw new Error('MODEL_PROFILE_FALLBACK_CONDITIONS_INVALID');
  if (value.fallbackOn.length > 0 && !fallbackProfileId) throw new Error('MODEL_PROFILE_FALLBACK_TARGET_REQUIRED');
  if (!record(value.budget)) throw new Error('MODEL_PROFILE_BUDGET_INVALID');
  exact(
    value.budget,
    ['timeoutMs', 'maxInputTokens', 'maxOutputTokens', 'maxCostMicros'],
    'MODEL_PROFILE_BUDGET_FIELD_UNSUPPORTED',
  );
  const budget = {
    timeoutMs: boundedInteger(value.budget.timeoutMs, 100, 120000, 'MODEL_PROFILE_TIMEOUT_RANGE_INVALID'),
    maxInputTokens: boundedInteger(value.budget.maxInputTokens, 128, 2_000_000, 'MODEL_PROFILE_INPUT_BUDGET_INVALID'),
    maxOutputTokens: boundedInteger(value.budget.maxOutputTokens, 16, 65_536, 'MODEL_PROFILE_OUTPUT_BUDGET_INVALID'),
    ...(value.budget.maxCostMicros === undefined
      ? {}
      : {
          maxCostMicros: boundedInteger(
            value.budget.maxCostMicros,
            1,
            Number.MAX_SAFE_INTEGER,
            'MODEL_PROFILE_COST_BUDGET_INVALID',
          ),
        }),
  };
  return {
    schemaVersion: 1,
    profileId,
    revision,
    enabled: value.enabled,
    providerId,
    connectionId,
    modelId,
    protocol: value.protocol,
    tier: value.tier as ModelProfileTier,
    instructionTemplateId,
    outputSchemaId,
    ...(fallbackProfileId ? { fallbackProfileId } : {}),
    fallbackOn: [...value.fallbackOn] as ModelProfileV1['fallbackOn'],
    budget,
  };
}
