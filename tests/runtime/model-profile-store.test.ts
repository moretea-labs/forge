import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelProfileV1 } from '../../packages/kernel/models';
import {
  createModelProfile,
  listModelProfiles,
  readModelProfile,
  resolveModelProfile,
  updateModelProfile,
} from '../../src/runtime/models/model-profile-store';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'forge-model-profile-store-'));
  roots.push(value);
  return value;
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

describe('Model Profile persistence and fallback resolution', () => {
  test('creates, reads and lists profiles in the shared Control Plane store', () => {
    const controllerHome = home();
    const created = createModelProfile(controllerHome, profile('fast-classifier'));
    expect(created.revision).toBe(1);
    expect(readModelProfile(controllerHome, 'fast-classifier')?.value).toEqual(profile('fast-classifier'));
    expect(listModelProfiles(controllerHome).map((item) => item.value.profileId)).toEqual(['fast-classifier']);
  });
  test('uses optimistic record revisions and immutable profile IDs for updates', () => {
    const controllerHome = home();
    createModelProfile(controllerHome, profile('fast-classifier'));
    const updated = updateModelProfile(controllerHome, 'fast-classifier', 1, (current) => ({
      ...current,
      revision: 2,
      modelId: 'deepseek-chat-v2',
    }));
    expect(updated.revision).toBe(2);
    expect(updated.value.revision).toBe(2);
    expect(() => updateModelProfile(controllerHome, 'fast-classifier', 1, (current) => current)).toThrow(
      'MODEL_PROFILE_REVISION_CONFLICT',
    );
    expect(() =>
      updateModelProfile(controllerHome, 'fast-classifier', 2, (current) => ({
        ...current,
        revision: 3,
        profileId: 'renamed',
      })),
    ).toThrow('MODEL_PROFILE_ID_IMMUTABLE');
  });
  test('follows only explicitly configured fallback conditions and stops at the first eligible profile', () => {
    const controllerHome = home();
    createModelProfile(controllerHome, profile('fast', { fallbackProfileId: 'balanced', fallbackOn: ['unavailable'] }));
    createModelProfile(
      controllerHome,
      profile('balanced', { tier: 'balanced', fallbackProfileId: 'reasoner', fallbackOn: ['unavailable'] }),
    );
    createModelProfile(controllerHome, profile('reasoner', { tier: 'deep_reasoning' }));
    expect(resolveModelProfile(controllerHome, 'fast').map((item) => item.value.profileId)).toEqual(['fast']);
    expect(resolveModelProfile(controllerHome, 'fast', 'rate_limited').map((item) => item.value.profileId)).toEqual([
      'fast',
    ]);
    expect(resolveModelProfile(controllerHome, 'fast', 'unavailable').map((item) => item.value.profileId)).toEqual([
      'fast',
      'balanced',
      'reasoner',
    ]);
  });
  test('caps fallback traversal to eight profiles', () => {
    const controllerHome = home();
    for (let index = 0; index < 9; index += 1) {
      createModelProfile(
        controllerHome,
        profile('depth-' + index, {
          fallbackProfileId: index < 8 ? 'depth-' + (index + 1) : undefined,
          fallbackOn: index < 8 ? ['timeout'] : [],
        }),
      );
    }
    expect(() => resolveModelProfile(controllerHome, 'depth-0', 'timeout')).toThrow(
      'MODEL_PROFILE_FALLBACK_DEPTH_EXCEEDED',
    );
  });

  test('fails closed on missing, disabled, cyclic or overlong fallback chains', () => {
    const controllerHome = home();
    createModelProfile(
      controllerHome,
      profile('missing-target', { fallbackProfileId: 'not-installed', fallbackOn: ['timeout'] }),
    );
    expect(() => resolveModelProfile(controllerHome, 'missing-target', 'timeout')).toThrow(
      'MODEL_PROFILE_FALLBACK_NOT_FOUND',
    );
    createModelProfile(controllerHome, profile('disabled', { enabled: false }));
    expect(() => resolveModelProfile(controllerHome, 'disabled')).toThrow('MODEL_PROFILE_DISABLED');
    createModelProfile(controllerHome, profile('cycle-a', { fallbackProfileId: 'cycle-b', fallbackOn: ['timeout'] }));
    createModelProfile(controllerHome, profile('cycle-b', { fallbackProfileId: 'cycle-a', fallbackOn: ['timeout'] }));
    expect(() => resolveModelProfile(controllerHome, 'cycle-a', 'timeout')).toThrow('MODEL_PROFILE_FALLBACK_CYCLE');
  });
});
