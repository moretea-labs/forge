import {
  listControlPlaneRecords,
  readControlPlaneRecord,
  writeControlPlaneRecord,
  type ControlPlaneRecord,
} from '../control-plane/persistence/sqlite-store';
import { validateModelProfileV1, type ModelProfileV1 } from '../../../packages/kernel/models';

const NAMESPACE = 'model_profile';
const SCOPE = 'global';
const MAX_FALLBACK_DEPTH = 8;
export type ModelProfileFallbackCondition = 'unavailable' | 'rate_limited' | 'timeout';

export function createModelProfile(controllerHome: string, input: unknown): ControlPlaneRecord<ModelProfileV1> {
  const profile = validateModelProfileV1(input);
  if (profile.revision !== 1) throw new Error('MODEL_PROFILE_CREATE_REVISION_INVALID');
  return writeControlPlaneRecord(controllerHome, {
    namespace: NAMESPACE,
    scope: SCOPE,
    key: profile.profileId,
    schemaVersion: 1,
    value: profile,
    action: 'model_profile_created',
    expectedRevision: null,
  });
}

export function readModelProfile(
  controllerHome: string,
  profileId: string,
): ControlPlaneRecord<ModelProfileV1> | undefined {
  const record = readControlPlaneRecord<unknown>(controllerHome, NAMESPACE, SCOPE, profileId);
  if (!record) return undefined;
  const value = validateModelProfileV1(record.value);
  if (value.profileId !== record.key || value.profileId !== profileId) throw new Error('MODEL_PROFILE_KEY_MISMATCH');
  return { ...record, value };
}

export function listModelProfiles(controllerHome: string, limit = 256): ControlPlaneRecord<ModelProfileV1>[] {
  return listControlPlaneRecords<unknown>(controllerHome, {
    namespace: NAMESPACE,
    scope: SCOPE,
    limit: Math.max(1, Math.min(Math.trunc(limit), 1_000)),
  }).map((record) => {
    const value = validateModelProfileV1(record.value);
    if (value.profileId !== record.key) throw new Error('MODEL_PROFILE_KEY_MISMATCH');
    return { ...record, value };
  });
}

export function updateModelProfile(
  controllerHome: string,
  profileId: string,
  expectedRecordRevision: number,
  mutate: (current: ModelProfileV1) => ModelProfileV1,
): ControlPlaneRecord<ModelProfileV1> {
  const current = readModelProfile(controllerHome, profileId);
  if (!current) throw new Error('MODEL_PROFILE_NOT_FOUND: ' + profileId);
  if (current.revision !== expectedRecordRevision) throw new Error('MODEL_PROFILE_REVISION_CONFLICT');
  const next = validateModelProfileV1(mutate(structuredClone(current.value)));
  if (next.profileId !== profileId) throw new Error('MODEL_PROFILE_ID_IMMUTABLE');
  if (next.revision !== current.value.revision + 1) throw new Error('MODEL_PROFILE_LOGICAL_REVISION_INVALID');
  return writeControlPlaneRecord(controllerHome, {
    namespace: NAMESPACE,
    scope: SCOPE,
    key: profileId,
    schemaVersion: 1,
    value: next,
    action: 'model_profile_updated',
    expectedRevision: current.revision,
  });
}

/** Resolve only the configured fallback condition. Credentials and provider calls remain owned by Model Client. */
export function resolveModelProfile(
  controllerHome: string,
  profileId: string,
  condition?: ModelProfileFallbackCondition,
): ControlPlaneRecord<ModelProfileV1>[] {
  const chain: ControlPlaneRecord<ModelProfileV1>[] = [];
  const visited = new Set<string>();
  let nextId: string | undefined = profileId;
  while (nextId) {
    if (visited.has(nextId)) throw new Error('MODEL_PROFILE_FALLBACK_CYCLE: ' + nextId);
    if (chain.length >= MAX_FALLBACK_DEPTH) throw new Error('MODEL_PROFILE_FALLBACK_DEPTH_EXCEEDED');
    visited.add(nextId);
    const record = readModelProfile(controllerHome, nextId);
    if (!record) throw new Error('MODEL_PROFILE_FALLBACK_NOT_FOUND: ' + nextId);
    if (!record.value.enabled) throw new Error('MODEL_PROFILE_DISABLED: ' + nextId);
    chain.push(record);
    if (!condition || !record.value.fallbackOn.includes(condition)) break;
    nextId = record.value.fallbackProfileId;
    if (!nextId) throw new Error('MODEL_PROFILE_FALLBACK_TARGET_REQUIRED: ' + record.value.profileId);
  }
  return chain;
}
