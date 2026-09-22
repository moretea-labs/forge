import { RECOVERY_MUTATION_IDENTITY_FIELDS } from '../../../src/runtime/standalone-recovery/mutation-identity-contract';

const STATUS_DERIVABLE_RECOVERY_FIELDS = new Set<string>([
  ...RECOVERY_MUTATION_IDENTITY_FIELDS,
  'expected_active_release_id',
  'expected_authority_revision',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasOwn(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

export function recoveryToolRequiredFields(inputSchema: unknown): string[] {
  const schema = record(inputSchema);
  return Array.isArray(schema?.required)
    ? schema.required.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : [];
}

export function isRecoveryStatusDerivableField(field: string): boolean {
  return STATUS_DERIVABLE_RECOVERY_FIELDS.has(field);
}

export function assertCompleteExplicitRecoveryIdentity(toolName: string, args: Record<string, unknown>): void {
  const supplied = RECOVERY_MUTATION_IDENTITY_FIELDS.filter((field) => hasOwn(args, field));
  if (supplied.length === 0 || supplied.length === RECOVERY_MUTATION_IDENTITY_FIELDS.length) return;
  const missing = RECOVERY_MUTATION_IDENTITY_FIELDS.filter((field) => !hasOwn(args, field));
  throw new Error(`RECOVERY_TOOL_IDENTITY_PARTIAL:${toolName}:${missing.join(',')}`);
}

export function recoveryToolUnrepresentableRequiredFields(
  inputSchema: unknown,
  args: Record<string, unknown>,
): string[] {
  return recoveryToolRequiredFields(inputSchema)
    .filter((field) => !hasOwn(args, field) && !isRecoveryStatusDerivableField(field));
}

export function recoveryToolSchemaUnrepresentableError(toolName: string, fields: readonly string[]): Error {
  return new Error(`RECOVERY_TOOL_SCHEMA_UNREPRESENTABLE:${toolName}:${fields.join(',')}`);
}

/**
 * Project only machine facts that Recovery itself exposes through runtime_status.
 * This is transport hydration, not a second fencing authority. Explicit caller
 * expectations always win and are later checked by Standalone Recovery.
 */
export function recoveryStatusDerivedArguments(status: Record<string, unknown>): Record<string, unknown> {
  const identity = record(status.identity);
  if (!identity) return {};
  const recovery = record(identity.recovery);
  const targetRuntime = record(identity.targetRuntime);
  const derived: Record<string, unknown> = {};

  if (typeof identity.host === 'string' && identity.host.trim()) derived.expected_host = identity.host;
  if (typeof identity.platform === 'string' && identity.platform.trim()) derived.expected_platform = identity.platform;
  if (typeof identity.controllerHome === 'string' && identity.controllerHome.trim()) derived.expected_controller_home = identity.controllerHome;
  if (recovery) {
    derived.expected_recovery_release = typeof recovery.releaseRevision === 'string' && recovery.releaseRevision.trim()
      ? recovery.releaseRevision
      : 'none';
  }
  if (targetRuntime && typeof targetRuntime.id === 'string' && targetRuntime.id.trim()) {
    derived.expected_target_runtime = targetRuntime.id;
  }
  if (targetRuntime && typeof targetRuntime.activeReleaseId === 'string' && targetRuntime.activeReleaseId.trim()) {
    derived.expected_active_release_id = targetRuntime.activeReleaseId;
  }
  if (targetRuntime && Number.isInteger(targetRuntime.authorityRevision) && Number(targetRuntime.authorityRevision) >= 1) {
    derived.expected_authority_revision = Number(targetRuntime.authorityRevision);
  }
  return derived;
}

export function hydrateRecoveryToolArguments(input: {
  toolName: string;
  inputSchema: unknown;
  args: Record<string, unknown>;
  status?: Record<string, unknown>;
}): Record<string, unknown> {
  assertCompleteExplicitRecoveryIdentity(input.toolName, input.args);
  const required = recoveryToolRequiredFields(input.inputSchema);
  const hydrated = { ...input.args };
  const derived = input.status ? recoveryStatusDerivedArguments(input.status) : {};

  for (const field of required) {
    if (!hasOwn(hydrated, field) && hasOwn(derived, field)) hydrated[field] = derived[field];
  }

  const unresolved = required.filter((field) => !hasOwn(hydrated, field));
  if (unresolved.length) throw recoveryToolSchemaUnrepresentableError(input.toolName, unresolved);
  return hydrated;
}
