import { describe, expect, test } from 'bun:test';
import { validateModelProfileV1 } from '../../packages/kernel/models';

const profile = {
  schemaVersion: 1 as const,
  profileId: 'fast-classifier',
  revision: 2,
  enabled: true,
  providerId: 'deepseek',
  connectionId: 'primary-deepseek',
  modelId: 'deepseek-chat',
  protocol: 'chat_completions' as const,
  tier: 'fast_classification' as const,
  instructionTemplateId: 'event-classifier-v1',
  outputSchemaId: 'event-decision-v1',
  fallbackProfileId: 'balanced-reasoner',
  fallbackOn: ['unavailable', 'rate_limited'] as Array<'unavailable' | 'rate_limited'>,
  budget: { timeoutMs: 5000, maxInputTokens: 32000, maxOutputTokens: 512, maxCostMicros: 2500 },
};

describe('Model Profile v1', () => {
  test('validates reusable provider-neutral model settings without storing credentials', () => {
    expect(validateModelProfileV1(profile)).toEqual(profile);
    expect(validateModelProfileV1(profile)).not.toHaveProperty('apiKey');
  });
  test('rejects secrets and unknown configuration fields', () => {
    expect(() => validateModelProfileV1({ ...profile, apiKey: 'secret' })).toThrow('MODEL_PROFILE_FIELD_UNSUPPORTED');
  });
  test('requires a valid fallback target when fallback conditions are configured', () => {
    expect(() => validateModelProfileV1({ ...profile, fallbackProfileId: undefined })).toThrow(
      'MODEL_PROFILE_FALLBACK_TARGET_REQUIRED',
    );
    expect(() => validateModelProfileV1({ ...profile, fallbackProfileId: profile.profileId })).toThrow(
      'MODEL_PROFILE_FALLBACK_SELF_REFERENCE',
    );
  });
  test('bounds token, timeout and cost budgets', () => {
    expect(() => validateModelProfileV1({ ...profile, budget: { ...profile.budget, maxOutputTokens: 0 } })).toThrow(
      'MODEL_PROFILE_OUTPUT_BUDGET_INVALID',
    );
    expect(() => validateModelProfileV1({ ...profile, budget: { ...profile.budget, timeoutMs: 999999 } })).toThrow(
      'MODEL_PROFILE_TIMEOUT_RANGE_INVALID',
    );
    expect(() => validateModelProfileV1({ ...profile, budget: { ...profile.budget, maxCostMicros: 0 } })).toThrow(
      'MODEL_PROFILE_COST_BUDGET_INVALID',
    );
  });
  test('rejects invalid protocol, tier, and fallback conditions', () => {
    expect(() => validateModelProfileV1({ ...profile, protocol: 'custom' })).toThrow('MODEL_PROFILE_PROTOCOL_INVALID');
    expect(() => validateModelProfileV1({ ...profile, tier: 'cheap' })).toThrow('MODEL_PROFILE_TIER_INVALID');
    expect(() => validateModelProfileV1({ ...profile, fallbackOn: ['any_error'] })).toThrow(
      'MODEL_PROFILE_FALLBACK_CONDITIONS_INVALID',
    );
  });
});
