const FROZEN_SEMANTIC_COMPATIBILITY_PREFIX = 'semantic.v1:';
const MAX_FROZEN_SEMANTIC_ENCODED_CHARS = 96 * 1024;
const MAX_FROZEN_SEMANTIC_DECODED_BYTES = 64 * 1024;
const MAX_FROZEN_SEMANTIC_ARRAY_ITEMS = 128;
const MAX_FROZEN_SEMANTIC_STRING_CHARS = 16 * 1024;

export const FROZEN_SEMANTIC_COMPATIBILITY_OPERATIONS = ['requirement_create'] as const;
export type FrozenSemanticCompatibilityOperation = (typeof FROZEN_SEMANTIC_COMPATIBILITY_OPERATIONS)[number];

export interface FrozenRequirementCreateCompatibilityArgs {
  requirement_title: string;
  requirement_outcome: string;
  requirement_acceptance_criteria?: string[];
  requirement_delivery_references?: string[];
  requirement_legacy_aliases?: string[];
}

export interface FrozenRequirementCreateCompatibilityEnvelope {
  operation: 'requirement_create';
  args: FrozenRequirementCreateCompatibilityArgs;
}

export type FrozenSemanticCompatibilityEnvelope = FrozenRequirementCreateCompatibilityEnvelope;

const REQUIREMENT_CREATE_KEYS = new Set([
  'requirement_title',
  'requirement_outcome',
  'requirement_acceptance_criteria',
  'requirement_delivery_references',
  'requirement_legacy_aliases',
]);

function fail(message: string): never {
  throw new Error(`FROZEN_SEMANTIC_COMPATIBILITY_INVALID: ${message}`);
}

function assertExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains unsupported field ${key}`);
  }
}

function boundedString(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(`${field} must be a string`);
  if (value.length > MAX_FROZEN_SEMANTIC_STRING_CHARS) fail(`${field} exceeds transport bound`);
  return value;
}

function boundedStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_FROZEN_SEMANTIC_ARRAY_ITEMS) {
    fail(`${field} must be a bounded string array`);
  }
  return value.map((entry, index) => boundedString(entry, `${field}[${index}]`));
}

function normalizeRequirementCreateArgs(value: unknown): FrozenRequirementCreateCompatibilityArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('requirement_create args must be an object');
  const args = value as Record<string, unknown>;
  assertExactKeys(args, REQUIREMENT_CREATE_KEYS, 'requirement_create args');
  const acceptanceCriteria = boundedStringArray(args.requirement_acceptance_criteria, 'requirement_acceptance_criteria');
  const deliveryReferences = boundedStringArray(args.requirement_delivery_references, 'requirement_delivery_references');
  const legacyAliases = boundedStringArray(args.requirement_legacy_aliases, 'requirement_legacy_aliases');
  return {
    requirement_title: boundedString(args.requirement_title, 'requirement_title'),
    requirement_outcome: boundedString(args.requirement_outcome, 'requirement_outcome'),
    ...(acceptanceCriteria !== undefined ? { requirement_acceptance_criteria: acceptanceCriteria } : {}),
    ...(deliveryReferences !== undefined ? { requirement_delivery_references: deliveryReferences } : {}),
    ...(legacyAliases !== undefined ? { requirement_legacy_aliases: legacyAliases } : {}),
  };
}

function parsePayload(capabilityId: string): Record<string, unknown> {
  const encoded = capabilityId.slice(FROZEN_SEMANTIC_COMPATIBILITY_PREFIX.length);
  if (!encoded || encoded.length > MAX_FROZEN_SEMANTIC_ENCODED_CHARS || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    fail('payload encoding is invalid or oversized');
  }
  const decoded = Buffer.from(encoded, 'base64url');
  if (decoded.length === 0 || decoded.length > MAX_FROZEN_SEMANTIC_DECODED_BYTES) fail('payload exceeds decoded transport bound');
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString('utf8'));
  } catch {
    fail('payload is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('payload must be an object');
  return parsed as Record<string, unknown>;
}

export function buildFrozenSemanticCompatibilityCapability(input: FrozenSemanticCompatibilityEnvelope): string {
  const args = input.operation === 'requirement_create' ? normalizeRequirementCreateArgs(input.args) : fail('operation is not allowlisted');
  const json = JSON.stringify({ v: 1, op: input.operation, a: args });
  if (Buffer.byteLength(json, 'utf8') > MAX_FROZEN_SEMANTIC_DECODED_BYTES) fail('payload exceeds decoded transport bound');
  const encoded = Buffer.from(json, 'utf8').toString('base64url');
  if (encoded.length > MAX_FROZEN_SEMANTIC_ENCODED_CHARS) fail('payload exceeds encoded transport bound');
  return `${FROZEN_SEMANTIC_COMPATIBILITY_PREFIX}${encoded}`;
}

/**
 * Decode a forward-compatible semantic operation from an already-stable frozen
 * rh_work carrier. This function owns transport validation only. It never writes
 * Requirement/Plan/Work state and every returned operation must re-enter the
 * current canonical Runtime facade handler.
 */
export function parseFrozenSemanticCompatibilityCapability(
  requestedOperation: string,
  capabilityId: unknown,
): FrozenSemanticCompatibilityEnvelope | undefined {
  if (typeof capabilityId !== 'string') return undefined;
  const normalized = capabilityId.trim();
  if (!normalized.startsWith(FROZEN_SEMANTIC_COMPATIBILITY_PREFIX)) return undefined;
  if (requestedOperation !== 'repair') fail('semantic envelope requires the stable repair transport operation');

  const payload = parsePayload(normalized);
  assertExactKeys(payload, new Set(['v', 'op', 'a']), 'payload');
  if (payload.v !== 1) fail('unsupported envelope version');
  if (payload.op !== 'requirement_create') fail('operation is not allowlisted');
  return {
    operation: 'requirement_create',
    args: normalizeRequirementCreateArgs(payload.a),
  };
}
