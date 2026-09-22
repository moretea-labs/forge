/** Canonical external mutation identity contract for Standalone Recovery.
 *
 * Both the runtime fencing implementation and the MCP tool schema derive from
 * this single authority. Keep target-identity field names and validation shape
 * here so an upgraded Recovery cannot require fields that its own connector
 * schema forgot to expose.
 */
export const RECOVERY_MUTATION_IDENTITY_CONTRACT = {
  expected_host: { type: 'string', minLength: 1, maxLength: 255 },
  expected_platform: { type: 'string', minLength: 1, maxLength: 64 },
  expected_controller_home: { type: 'string', minLength: 1, maxLength: 2048 },
  expected_recovery_release: { type: 'string', minLength: 1, maxLength: 256 },
  expected_target_runtime: { type: 'string', minLength: 1, maxLength: 1024 },
} as const;

export const RECOVERY_MUTATION_IDENTITY_FIELDS = Object.freeze(
  Object.keys(RECOVERY_MUTATION_IDENTITY_CONTRACT),
) as readonly (keyof typeof RECOVERY_MUTATION_IDENTITY_CONTRACT)[];

export type RecoveryMutationIdentityField = (typeof RECOVERY_MUTATION_IDENTITY_FIELDS)[number];
export type RecoveryMutationIdentityArguments = Record<RecoveryMutationIdentityField, string>;
