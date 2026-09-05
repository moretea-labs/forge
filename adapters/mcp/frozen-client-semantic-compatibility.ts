const FROZEN_SEMANTIC_COMPATIBILITY_PREFIX = 'semantic.v1:';
const MAX_FROZEN_SEMANTIC_ENCODED_CHARS = 96 * 1024;
const MAX_FROZEN_SEMANTIC_DECODED_BYTES = 64 * 1024;
const MAX_FROZEN_SEMANTIC_ARRAY_ITEMS = 128;
const MAX_FROZEN_PLAN_OBLIGATION_DISPOSITIONS = 512;
const MAX_FROZEN_PLAN_SUCCESSOR_REFS = 32;
const MAX_FROZEN_SEMANTIC_STRING_CHARS = 16 * 1024;

export const FROZEN_SEMANTIC_COMPATIBILITY_OPERATIONS = ['requirement_create', 'plan_create', 'start'] as const;
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

export interface FrozenPlanObligationDispositionCompatibilityArgs {
  predecessor_plan_id: string;
  obligation_id: string;
  disposition: 'keep' | 'change' | 'defer' | 'drop';
  successor_refs: string[];
  rationale?: string;
}

export interface FrozenPlanCreateCompatibilityArgs {
  obligation_dispositions: FrozenPlanObligationDispositionCompatibilityArgs[];
}

export interface FrozenPlanCreateCompatibilityEnvelope {
  operation: 'plan_create';
  args: FrozenPlanCreateCompatibilityArgs;
}

export const FROZEN_WORK_START_KINDS = [
  'repository_change',
  'completed_no_change',
  'read_only_review',
  'investigation',
  'local_effect',
  'remote_effect',
  'reconciliation',
] as const;
export type FrozenWorkStartKind = (typeof FROZEN_WORK_START_KINDS)[number];

export interface FrozenWorkStartCompatibilityArgs {
  work_kind: FrozenWorkStartKind;
  engineering_preconditions?: Record<string, unknown>;
  controller_authority_id?: string;
  relay_scope_id?: string;
}

export interface FrozenWorkStartCompatibilityEnvelope {
  operation: 'start';
  args: FrozenWorkStartCompatibilityArgs;
}

export type FrozenSemanticCompatibilityEnvelope =
  | FrozenRequirementCreateCompatibilityEnvelope
  | FrozenPlanCreateCompatibilityEnvelope
  | FrozenWorkStartCompatibilityEnvelope;

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

const PLAN_CREATE_KEYS = new Set(['obligation_dispositions']);
const PLAN_OBLIGATION_DISPOSITION_KEYS = new Set([
  'predecessor_plan_id',
  'obligation_id',
  'disposition',
  'successor_refs',
  'rationale',
]);

function normalizePlanObligationDisposition(value: unknown, index: number): FrozenPlanObligationDispositionCompatibilityArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`obligation_dispositions[${index}] must be an object`);
  const entry = value as Record<string, unknown>;
  assertExactKeys(entry, PLAN_OBLIGATION_DISPOSITION_KEYS, `obligation_dispositions[${index}]`);
  const disposition = boundedString(entry.disposition, `obligation_dispositions[${index}].disposition`);
  if (!['keep', 'change', 'defer', 'drop'].includes(disposition)) fail(`obligation_dispositions[${index}].disposition is invalid`);
  const successorRefs = boundedStringArray(entry.successor_refs, `obligation_dispositions[${index}].successor_refs`) ?? [];
  if (successorRefs.length > MAX_FROZEN_PLAN_SUCCESSOR_REFS) fail(`obligation_dispositions[${index}].successor_refs exceeds transport bound`);
  return {
    predecessor_plan_id: boundedString(entry.predecessor_plan_id, `obligation_dispositions[${index}].predecessor_plan_id`),
    obligation_id: boundedString(entry.obligation_id, `obligation_dispositions[${index}].obligation_id`),
    disposition: disposition as FrozenPlanObligationDispositionCompatibilityArgs['disposition'],
    successor_refs: successorRefs,
    ...(entry.rationale !== undefined ? { rationale: boundedString(entry.rationale, `obligation_dispositions[${index}].rationale`) } : {}),
  };
}

function normalizePlanCreateArgs(value: unknown): FrozenPlanCreateCompatibilityArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('plan_create args must be an object');
  const args = value as Record<string, unknown>;
  assertExactKeys(args, PLAN_CREATE_KEYS, 'plan_create args');
  if (!Array.isArray(args.obligation_dispositions) || args.obligation_dispositions.length > MAX_FROZEN_PLAN_OBLIGATION_DISPOSITIONS) {
    fail('obligation_dispositions must be a bounded array');
  }
  return {
    obligation_dispositions: args.obligation_dispositions.map(normalizePlanObligationDisposition),
  };
}

// Retirement boundary: remove the start envelope only after the oldest supported
// frozen rh_work schema exposes work_kind, engineering_preconditions,
// controller_authority_id and relay_scope_id together. Until then this remains a
// bounded transport carrier only; canonical GoalWorkloop/ControllerRound handlers
// still own validation, admission and mutation.
const WORK_START_KEYS = new Set(['work_kind', 'engineering_preconditions', 'controller_authority_id', 'relay_scope_id']);

function boundedObject(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { return fail(`${field} must be JSON serializable`); }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_FROZEN_SEMANTIC_DECODED_BYTES) fail(`${field} exceeds transport bound`);
  return JSON.parse(encoded) as Record<string, unknown>;
}

function normalizeWorkStartArgs(value: unknown): FrozenWorkStartCompatibilityArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('start args must be an object');
  const args = value as Record<string, unknown>;
  assertExactKeys(args, WORK_START_KEYS, 'start args');
  const workKind = boundedString(args.work_kind, 'work_kind');
  if (!FROZEN_WORK_START_KINDS.includes(workKind as FrozenWorkStartKind)) fail('work_kind is invalid');
  const engineeringPreconditions = boundedObject(args.engineering_preconditions, 'engineering_preconditions');
  const authorityId = args.controller_authority_id === undefined
    ? undefined
    : boundedString(args.controller_authority_id, 'controller_authority_id').trim();
  const relayScopeId = args.relay_scope_id === undefined
    ? undefined
    : boundedString(args.relay_scope_id, 'relay_scope_id').trim();
  if ((authorityId === undefined) !== (relayScopeId === undefined)) fail('controller_authority_id and relay_scope_id must be paired');
  if (authorityId !== undefined && !/^cra_[0-9a-f]{32}$/i.test(authorityId)) fail('controller_authority_id is invalid');
  if (relayScopeId !== undefined && !relayScopeId) fail('relay_scope_id is invalid');
  return {
    work_kind: workKind as FrozenWorkStartKind,
    ...(engineeringPreconditions !== undefined ? { engineering_preconditions: engineeringPreconditions } : {}),
    ...(authorityId !== undefined ? { controller_authority_id: authorityId, relay_scope_id: relayScopeId! } : {}),
  };
}


function normalizeEnvelopeArgs(input: FrozenSemanticCompatibilityEnvelope): FrozenSemanticCompatibilityEnvelope['args'] {
  if (input.operation === 'requirement_create') return normalizeRequirementCreateArgs(input.args);
  if (input.operation === 'plan_create') return normalizePlanCreateArgs(input.args);
  if (input.operation === 'start') return normalizeWorkStartArgs(input.args);
  return fail('operation is not allowlisted');
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
  const args = normalizeEnvelopeArgs(input);
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
  if (payload.op === 'requirement_create') {
    return {
      operation: 'requirement_create',
      args: normalizeRequirementCreateArgs(payload.a),
    };
  }
  if (payload.op === 'plan_create') {
    return {
      operation: 'plan_create',
      args: normalizePlanCreateArgs(payload.a),
    };
  }
  if (payload.op === 'start') {
    return {
      operation: 'start',
      args: normalizeWorkStartArgs(payload.a),
    };
  }
  return fail('operation is not allowlisted');
}
