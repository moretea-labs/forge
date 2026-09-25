import { CONTROLLER_LEARNING_SIGNAL_ENVELOPE_MAX_ITEMS } from '../../src/runtime/context/automatic-learning';

const FROZEN_SEMANTIC_COMPATIBILITY_PREFIX = 'semantic.v1:';
const MAX_FROZEN_SEMANTIC_ENCODED_CHARS = 96 * 1024;
const MAX_FROZEN_SEMANTIC_DECODED_BYTES = 64 * 1024;
const MAX_FROZEN_SEMANTIC_ARRAY_ITEMS = 128;
const MAX_FROZEN_PLAN_OBLIGATION_DISPOSITIONS = 512;
const MAX_FROZEN_PLAN_SUCCESSOR_REFS = 32;
const MAX_FROZEN_SEMANTIC_STRING_CHARS = 16 * 1024;

export const FROZEN_SEMANTIC_COMPATIBILITY_OPERATIONS = ['requirement_create', 'requirement_get', 'requirement_revise', 'plan_create', 'plan_revise', 'work_get', 'work_revise', 'work_complete', 'start', 'continue', 'work_review', 'controller_disposition'] as const;
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

export interface FrozenRequirementGetCompatibilityEnvelope {
  operation: 'requirement_get';
  args: Record<string, never>;
}

export interface FrozenRequirementReviseCompatibilityArgs {
  expected_revision: number;
  requirement_title?: string;
  requirement_outcome?: string;
  requirement_acceptance_criteria?: string[];
  requirement_delivery_references?: string[];
  requirement_state?: 'open' | 'completed' | 'cancelled';
}

export interface FrozenRequirementReviseCompatibilityEnvelope {
  operation: 'requirement_revise';
  args: FrozenRequirementReviseCompatibilityArgs;
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

export interface FrozenPlanItemCompatibilityArgs {
  id: string;
  objective: string;
  dependencies?: string[];
}

export interface FrozenPlanReviseCompatibilityArgs {
  plan_id: string;
  expected_revision: number;
  requirement_revision?: number;
  source_revision?: string;
  objective?: string;
  non_goals?: string[];
  assumptions?: string[];
  resolved_decisions?: string[];
  stop_conditions?: string[];
  replan_conditions?: string[];
  integration_strategy?: string | null;
  plan_items?: FrozenPlanItemCompatibilityArgs[];
}

export interface FrozenPlanReviseCompatibilityEnvelope {
  operation: 'plan_revise';
  args: FrozenPlanReviseCompatibilityArgs;
}

export interface FrozenWorkGetCompatibilityEnvelope {
  operation: 'work_get';
  args: Record<string, never>;
}

export interface FrozenWorkReviseCompatibilityArgs {
  expected_revision: number;
  objective?: string;
  requirement_revision?: number;
  plan_revision?: number;
  work_result_refs?: string[];
  work_state?: 'open' | 'completed' | 'cancelled';
}

export interface FrozenWorkReviseCompatibilityEnvelope {
  operation: 'work_revise';
  args: FrozenWorkReviseCompatibilityArgs;
}

export interface FrozenWorkCompleteCompatibilityArgs {
  expected_revision: number;
  work_result_refs?: string[];
}

export interface FrozenWorkCompleteCompatibilityEnvelope {
  operation: 'work_complete';
  args: FrozenWorkCompleteCompatibilityArgs;
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

export interface FrozenWorkContinueCompatibilityArgs {
  engineering_preconditions: Record<string, unknown>;
}

export interface FrozenWorkContinueCompatibilityEnvelope {
  operation: 'continue';
  args: FrozenWorkContinueCompatibilityArgs;
}

export interface FrozenWorkReviewCompatibilityArgs {
  decision: 'approved' | 'changes_required' | 'blocked';
}

export interface FrozenWorkReviewCompatibilityEnvelope {
  operation: 'work_review';
  args: FrozenWorkReviewCompatibilityArgs;
}

export interface FrozenControllerDispositionLearningCompatibilityArgs {
  learning_signals: Record<string, unknown>[];
}

export interface FrozenControllerDispositionLearningCompatibilityEnvelope {
  operation: 'controller_disposition';
  args: FrozenControllerDispositionLearningCompatibilityArgs;
}

export interface FrozenLearningRecordCompatibilityEnvelope {
  operation: 'learning_record';
  args: FrozenControllerDispositionLearningCompatibilityArgs;
}

export interface FrozenLearningFeedbackCompatibilityArgs {
  learning_feedback: Record<string, unknown>[];
}

export interface FrozenLearningFeedbackCompatibilityEnvelope {
  operation: 'learning_feedback';
  args: FrozenLearningFeedbackCompatibilityArgs;
}

export type FrozenSemanticCompatibilityEnvelope =
  | FrozenRequirementCreateCompatibilityEnvelope
  | FrozenRequirementGetCompatibilityEnvelope
  | FrozenRequirementReviseCompatibilityEnvelope
  | FrozenPlanCreateCompatibilityEnvelope
  | FrozenPlanReviseCompatibilityEnvelope
  | FrozenWorkGetCompatibilityEnvelope
  | FrozenWorkReviseCompatibilityEnvelope
  | FrozenWorkCompleteCompatibilityEnvelope
  | FrozenWorkStartCompatibilityEnvelope
  | FrozenWorkContinueCompatibilityEnvelope
  | FrozenWorkReviewCompatibilityEnvelope
  | FrozenControllerDispositionLearningCompatibilityEnvelope
  | FrozenLearningRecordCompatibilityEnvelope
  | FrozenLearningFeedbackCompatibilityEnvelope;

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

function boundedPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) fail(`${field} must be a positive integer`);
  return value;
}

function normalizeEmptyArgs(value: unknown, label: string): Record<string, never> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} args must be an object`);
  const args = value as Record<string, unknown>;
  assertExactKeys(args, new Set(), `${label} args`);
  return {};
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

const REQUIREMENT_REVISE_KEYS = new Set([
  'expected_revision', 'requirement_title', 'requirement_outcome',
  'requirement_acceptance_criteria', 'requirement_delivery_references', 'requirement_state',
]);

function normalizeRequirementReviseArgs(value: unknown): FrozenRequirementReviseCompatibilityArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('requirement_revise args must be an object');
  const args = value as Record<string, unknown>;
  assertExactKeys(args, REQUIREMENT_REVISE_KEYS, 'requirement_revise args');
  const state = args.requirement_state;
  if (state !== undefined && state !== 'open' && state !== 'completed' && state !== 'cancelled') fail('requirement_state is invalid');
  return {
    expected_revision: boundedPositiveInteger(args.expected_revision, 'expected_revision'),
    ...(args.requirement_title !== undefined ? { requirement_title: boundedString(args.requirement_title, 'requirement_title') } : {}),
    ...(args.requirement_outcome !== undefined ? { requirement_outcome: boundedString(args.requirement_outcome, 'requirement_outcome') } : {}),
    ...(args.requirement_acceptance_criteria !== undefined ? { requirement_acceptance_criteria: boundedStringArray(args.requirement_acceptance_criteria, 'requirement_acceptance_criteria')! } : {}),
    ...(args.requirement_delivery_references !== undefined ? { requirement_delivery_references: boundedStringArray(args.requirement_delivery_references, 'requirement_delivery_references')! } : {}),
    ...(state !== undefined ? { requirement_state: state } : {}),
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

const PLAN_REVISE_KEYS = new Set([
  'plan_id', 'expected_revision', 'requirement_revision', 'source_revision', 'objective',
  'non_goals', 'assumptions', 'resolved_decisions', 'stop_conditions', 'replan_conditions',
  'integration_strategy', 'plan_items',
]);
const PLAN_ITEM_KEYS = new Set(['id', 'objective', 'dependencies']);

function normalizePlanReviseArgs(value: unknown): FrozenPlanReviseCompatibilityArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('plan_revise args must be an object');
  const args = value as Record<string, unknown>;
  assertExactKeys(args, PLAN_REVISE_KEYS, 'plan_revise args');
  let planItems: FrozenPlanItemCompatibilityArgs[] | undefined;
  if (args.plan_items !== undefined) {
    if (!Array.isArray(args.plan_items) || args.plan_items.length > MAX_FROZEN_SEMANTIC_ARRAY_ITEMS) fail('plan_items must be a bounded array');
    planItems = args.plan_items.map((value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`plan_items[${index}] must be an object`);
      const item = value as Record<string, unknown>;
      assertExactKeys(item, PLAN_ITEM_KEYS, `plan_items[${index}]`);
      const dependencies = boundedStringArray(item.dependencies, `plan_items[${index}].dependencies`);
      return {
        id: boundedString(item.id, `plan_items[${index}].id`),
        objective: boundedString(item.objective, `plan_items[${index}].objective`),
        ...(dependencies !== undefined ? { dependencies } : {}),
      };
    });
  }
  const integrationStrategy = args.integration_strategy;
  if (integrationStrategy !== undefined && integrationStrategy !== null && typeof integrationStrategy !== 'string') fail('integration_strategy must be string or null');
  return {
    plan_id: boundedString(args.plan_id, 'plan_id'),
    expected_revision: boundedPositiveInteger(args.expected_revision, 'expected_revision'),
    ...(args.requirement_revision !== undefined ? { requirement_revision: boundedPositiveInteger(args.requirement_revision, 'requirement_revision') } : {}),
    ...(args.source_revision !== undefined ? { source_revision: boundedString(args.source_revision, 'source_revision') } : {}),
    ...(args.objective !== undefined ? { objective: boundedString(args.objective, 'objective') } : {}),
    ...(args.non_goals !== undefined ? { non_goals: boundedStringArray(args.non_goals, 'non_goals')! } : {}),
    ...(args.assumptions !== undefined ? { assumptions: boundedStringArray(args.assumptions, 'assumptions')! } : {}),
    ...(args.resolved_decisions !== undefined ? { resolved_decisions: boundedStringArray(args.resolved_decisions, 'resolved_decisions')! } : {}),
    ...(args.stop_conditions !== undefined ? { stop_conditions: boundedStringArray(args.stop_conditions, 'stop_conditions')! } : {}),
    ...(args.replan_conditions !== undefined ? { replan_conditions: boundedStringArray(args.replan_conditions, 'replan_conditions')! } : {}),
    ...(integrationStrategy !== undefined ? { integration_strategy: integrationStrategy as string | null } : {}),
    ...(planItems !== undefined ? { plan_items: planItems } : {}),
  };
}

const WORK_REVISE_KEYS = new Set(['expected_revision', 'objective', 'requirement_revision', 'plan_revision', 'work_result_refs', 'work_state']);
const WORK_COMPLETE_KEYS = new Set(['expected_revision', 'work_result_refs']);

function normalizeWorkReviseArgs(value: unknown): FrozenWorkReviseCompatibilityArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('work_revise args must be an object');
  const args = value as Record<string, unknown>;
  assertExactKeys(args, WORK_REVISE_KEYS, 'work_revise args');
  const state = args.work_state;
  if (state !== undefined && state !== 'open' && state !== 'completed' && state !== 'cancelled') fail('work_state is invalid');
  return {
    expected_revision: boundedPositiveInteger(args.expected_revision, 'expected_revision'),
    ...(args.objective !== undefined ? { objective: boundedString(args.objective, 'objective') } : {}),
    ...(args.requirement_revision !== undefined ? { requirement_revision: boundedPositiveInteger(args.requirement_revision, 'requirement_revision') } : {}),
    ...(args.plan_revision !== undefined ? { plan_revision: boundedPositiveInteger(args.plan_revision, 'plan_revision') } : {}),
    ...(args.work_result_refs !== undefined ? { work_result_refs: boundedStringArray(args.work_result_refs, 'work_result_refs')! } : {}),
    ...(state !== undefined ? { work_state: state } : {}),
  };
}

function normalizeWorkCompleteArgs(value: unknown): FrozenWorkCompleteCompatibilityArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('work_complete args must be an object');
  const args = value as Record<string, unknown>;
  assertExactKeys(args, WORK_COMPLETE_KEYS, 'work_complete args');
  return {
    expected_revision: boundedPositiveInteger(args.expected_revision, 'expected_revision'),
    ...(args.work_result_refs !== undefined ? { work_result_refs: boundedStringArray(args.work_result_refs, 'work_result_refs')! } : {}),
  };
}

// Retirement boundary: remove the start envelope only after the oldest supported
// frozen rh_work schema exposes work_kind, engineering_preconditions,
// controller_authority_id and relay_scope_id together. Until then this remains a
// bounded transport carrier only; canonical GoalWorkloop/ControllerRound handlers
// still own validation, admission and mutation.
const WORK_START_KEYS = new Set(['work_kind', 'engineering_preconditions', 'controller_authority_id', 'relay_scope_id']);
const WORK_CONTINUE_KEYS = new Set(['engineering_preconditions']);

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


function normalizeWorkContinueArgs(value: unknown): FrozenWorkContinueCompatibilityArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('continue args must be an object');
  const args = value as Record<string, unknown>;
  assertExactKeys(args, WORK_CONTINUE_KEYS, 'continue args');
  const engineeringPreconditions = boundedObject(args.engineering_preconditions, 'engineering_preconditions');
  if (engineeringPreconditions === undefined) fail('engineering_preconditions is required');
  return { engineering_preconditions: engineeringPreconditions };
}

function normalizeWorkReviewArgs(value: unknown): FrozenWorkReviewCompatibilityArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('work_review args must be an object');
  const args = value as Record<string, unknown>;
  assertExactKeys(args, new Set(['decision']), 'work_review args');
  const decision = boundedString(args.decision, 'decision');
  if (!['approved', 'changes_required', 'blocked'].includes(decision)) fail('decision is invalid');
  return { decision: decision as FrozenWorkReviewCompatibilityArgs['decision'] };
}

function normalizeLearningSignalArgs(value: unknown, label: 'controller_disposition' | 'learning_record'): FrozenControllerDispositionLearningCompatibilityArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} args must be an object`);
  const args = value as Record<string, unknown>;
  assertExactKeys(args, new Set(['learning_signals']), `${label} args`);
  if (!Array.isArray(args.learning_signals) || args.learning_signals.length > CONTROLLER_LEARNING_SIGNAL_ENVELOPE_MAX_ITEMS) {
    fail('learning_signals must be a bounded array');
  }
  return {
    learning_signals: args.learning_signals.map((entry, index) => {
      const normalized = boundedObject(entry, 'learning_signals[' + index + ']');
      if (!normalized) fail('learning_signals[' + index + '] must be an object');
      return normalized;
    }),
  };
}

function normalizeLearningFeedbackArgs(value: unknown): FrozenLearningFeedbackCompatibilityArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('learning_feedback args must be an object');
  const args = value as Record<string, unknown>;
  assertExactKeys(args, new Set(['learning_feedback']), 'learning_feedback args');
  if (!Array.isArray(args.learning_feedback) || args.learning_feedback.length === 0 || args.learning_feedback.length > 32) {
    fail('learning_feedback must be a bounded non-empty array');
  }
  return {
    learning_feedback: args.learning_feedback.map((entry, index) => {
      const normalized = boundedObject(entry, 'learning_feedback[' + index + ']');
      if (!normalized) fail('learning_feedback[' + index + '] must be an object');
      return normalized;
    }),
  };
}

function normalizeEnvelopeArgs(input: FrozenSemanticCompatibilityEnvelope): FrozenSemanticCompatibilityEnvelope['args'] {
  if (input.operation === 'requirement_create') return normalizeRequirementCreateArgs(input.args);
  if (input.operation === 'requirement_get') return normalizeEmptyArgs(input.args, 'requirement_get');
  if (input.operation === 'requirement_revise') return normalizeRequirementReviseArgs(input.args);
  if (input.operation === 'plan_create') return normalizePlanCreateArgs(input.args);
  if (input.operation === 'plan_revise') return normalizePlanReviseArgs(input.args);
  if (input.operation === 'work_get') return normalizeEmptyArgs(input.args, 'work_get');
  if (input.operation === 'work_revise') return normalizeWorkReviseArgs(input.args);
  if (input.operation === 'work_complete') return normalizeWorkCompleteArgs(input.args);
  if (input.operation === 'start') return normalizeWorkStartArgs(input.args);
  if (input.operation === 'continue') return normalizeWorkContinueArgs(input.args);
  if (input.operation === 'work_review') return normalizeWorkReviewArgs(input.args);
  if (input.operation === 'controller_disposition') return normalizeLearningSignalArgs(input.args, 'controller_disposition');
  if (input.operation === 'learning_record') return normalizeLearningSignalArgs(input.args, 'learning_record');
  if (input.operation === 'learning_feedback') return normalizeLearningFeedbackArgs(input.args);
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
  if (payload.op === 'requirement_get') return { operation: 'requirement_get', args: normalizeEmptyArgs(payload.a, 'requirement_get') };
  if (payload.op === 'requirement_revise') return { operation: 'requirement_revise', args: normalizeRequirementReviseArgs(payload.a) };
  if (payload.op === 'plan_create') {
    return {
      operation: 'plan_create',
      args: normalizePlanCreateArgs(payload.a),
    };
  }
  if (payload.op === 'plan_revise') return { operation: 'plan_revise', args: normalizePlanReviseArgs(payload.a) };
  if (payload.op === 'work_get') return { operation: 'work_get', args: normalizeEmptyArgs(payload.a, 'work_get') };
  if (payload.op === 'work_revise') return { operation: 'work_revise', args: normalizeWorkReviseArgs(payload.a) };
  if (payload.op === 'work_complete') return { operation: 'work_complete', args: normalizeWorkCompleteArgs(payload.a) };
  if (payload.op === 'start') {
    return {
      operation: 'start',
      args: normalizeWorkStartArgs(payload.a),
    };
  }
  if (payload.op === 'continue') {
    return {
      operation: 'continue',
      args: normalizeWorkContinueArgs(payload.a),
    };
  }
  if (payload.op === 'work_review') {
    return {
      operation: 'work_review',
      args: normalizeWorkReviewArgs(payload.a),
    };
  }
  if (payload.op === 'controller_disposition') {
    return {
      operation: 'controller_disposition',
      args: normalizeLearningSignalArgs(payload.a, 'controller_disposition'),
    };
  }
  if (payload.op === 'learning_record') {
    return {
      operation: 'learning_record',
      args: normalizeLearningSignalArgs(payload.a, 'learning_record'),
    };
  }
  if (payload.op === 'learning_feedback') {
    return {
      operation: 'learning_feedback',
      args: normalizeLearningFeedbackArgs(payload.a),
    };
  }
  return fail('operation is not allowlisted');
}
