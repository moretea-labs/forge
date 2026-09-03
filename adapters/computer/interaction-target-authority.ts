import { randomUUID } from 'crypto';
import type {
  ComputerApplicationStableIdentity,
  ComputerApplicationTarget,
  ComputerApplicationTargetLease,
  ComputerInteractionTargetAuthorityPort,
  ComputerInteractionTargetEntry,
  ComputerProviderTargetBinding,
} from '../../packages/plugin-runtime/computer/target-authority';
import type {
  ComputerTargetPersistencePort,
  ComputerTargetPersistenceRecord,
} from '../../packages/plugin-runtime/computer/target-persistence';

const COMPUTER_TARGET_NAMESPACE = 'computer_interaction_target';
const COMPUTER_TARGET_SCOPE = 'controller';

function now(): string { return new Date().toISOString(); }

function normalizeStableIdentity(identity: ComputerApplicationStableIdentity): ComputerApplicationStableIdentity {
  const bundleId = identity.bundleId?.trim();
  const appName = identity.appName?.trim();
  if (!bundleId && !appName) throw new Error('COMPUTER_TARGET_STABLE_IDENTITY_REQUIRED: bundleId or appName is required');
  return { ...(bundleId ? { bundleId } : {}), ...(appName ? { appName } : {}) };
}

function normalizeProviderBinding(binding: ComputerProviderTargetBinding): ComputerProviderTargetBinding {
  const providerId = binding.providerId.trim();
  const providerSessionId = binding.providerSessionId.trim();
  const observedAt = binding.observedAt.trim();
  if (!providerId) throw new Error('COMPUTER_TARGET_PROVIDER_ID_REQUIRED');
  if (!providerSessionId) throw new Error('COMPUTER_TARGET_PROVIDER_SESSION_ID_REQUIRED');
  if (!observedAt || !Number.isFinite(Date.parse(observedAt))) throw new Error('COMPUTER_TARGET_PROVIDER_OBSERVED_AT_INVALID');
  return { providerId, providerSessionId, observedAt };
}

function targetKey(targetId: string): string {
  const normalized = targetId.trim();
  if (!/^computer_target_[a-f0-9]{32}$/.test(normalized)) throw new Error(`COMPUTER_TARGET_ID_INVALID: ${targetId}`);
  return normalized;
}

export function createComputerInteractionTargetAuthority(
  persistence: ComputerTargetPersistencePort,
): ComputerInteractionTargetAuthorityPort {
  function requireActiveTargetRecord(
    controllerHome: string,
    targetId: string,
  ): ComputerTargetPersistenceRecord<ComputerInteractionTargetEntry> {
    const current = persistence.read<ComputerInteractionTargetEntry>(
      controllerHome, COMPUTER_TARGET_NAMESPACE, COMPUTER_TARGET_SCOPE, targetId,
    );
    if (!current || current.value.status !== 'active') throw new Error(`COMPUTER_TARGET_NOT_FOUND: ${targetId}`);
    return current;
  }

  function create(
    controllerHome: string,
    input: { stableIdentity: ComputerApplicationStableIdentity; providerBinding?: ComputerProviderTargetBinding },
  ): ComputerApplicationTarget {
    const at = now();
    const targetId = `computer_target_${randomUUID().replaceAll('-', '')}`;
    const target: ComputerApplicationTarget = {
      schemaVersion: 1,
      targetId,
      kind: 'application',
      stableIdentity: normalizeStableIdentity(input.stableIdentity),
      ...(input.providerBinding ? { providerBinding: normalizeProviderBinding(input.providerBinding) } : {}),
      createdAt: at,
      updatedAt: at,
    };
    persistence.write(controllerHome, {
      namespace: COMPUTER_TARGET_NAMESPACE,
      scope: COMPUTER_TARGET_SCOPE,
      key: targetId,
      schemaVersion: 1,
      value: { schemaVersion: 1, status: 'active', target } satisfies ComputerInteractionTargetEntry,
      action: 'computer_target_create',
      expectedRevision: null,
    });
    return target;
  }

  function get(controllerHome: string, targetId: string): ComputerApplicationTarget | undefined {
    const entry = persistence.read<ComputerInteractionTargetEntry>(
      controllerHome, COMPUTER_TARGET_NAMESPACE, COMPUTER_TARGET_SCOPE, targetKey(targetId),
    )?.value;
    return entry?.status === 'active' ? entry.target : undefined;
  }

  function requireTarget(controllerHome: string, targetId: string): ComputerApplicationTarget {
    const target = get(controllerHome, targetId);
    if (!target) throw new Error(`COMPUTER_TARGET_NOT_FOUND: ${targetId}`);
    return target;
  }

  async function withLease<T>(
    controllerHome: string,
    targetId: string,
    operation: (lease: ComputerApplicationTargetLease) => Promise<T>,
  ): Promise<T> {
    const key = targetKey(targetId);
    return persistence.withTargetLock(controllerHome, key, async () => {
      let record = requireActiveTargetRecord(controllerHome, key);
      const lease: ComputerApplicationTargetLease = {
        current: () => structuredClone(record.value.target),
        bind(binding) {
          const target: ComputerApplicationTarget = {
            ...record.value.target,
            providerBinding: normalizeProviderBinding(binding),
            updatedAt: now(),
          };
          record = persistence.write(controllerHome, {
            namespace: COMPUTER_TARGET_NAMESPACE,
            scope: COMPUTER_TARGET_SCOPE,
            key,
            schemaVersion: 1,
            value: { schemaVersion: 1, status: 'active', target },
            action: 'computer_target_bind_provider',
            expectedRevision: record.revision,
          });
          return structuredClone(target);
        },
        tombstone() {
          const at = now();
          const target: ComputerApplicationTarget = { ...record.value.target, updatedAt: at };
          record = persistence.write(controllerHome, {
            namespace: COMPUTER_TARGET_NAMESPACE,
            scope: COMPUTER_TARGET_SCOPE,
            key,
            schemaVersion: 1,
            value: { schemaVersion: 1, status: 'tombstoned', target, tombstonedAt: at },
            action: 'computer_target_tombstone',
            expectedRevision: record.revision,
          });
          return structuredClone(target);
        },
      };
      return operation(lease);
    });
  }

  return { create, get, require: requireTarget, withLease };
}
