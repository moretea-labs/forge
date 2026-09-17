import {
  parseControllerDispositionCompatibilityCapability,
  parseControllerRoundCompatibilityCapability,
  parsePlanObligationCompatibilityCapability,
} from '../controller-round-compatibility';
import { parseFrozenSemanticCompatibilityCapability } from '../frozen-client-semantic-compatibility';

export type RhWorkInputCompatibilityResult =
  | { ok: true; args: Record<string, unknown>; operation: string; scheduleIdOverride?: string; requirementOperationArgs?: Record<string, unknown> }
  | { ok: false; summary: string; data: Record<string, unknown> };

function failure(summary: string, data: Record<string, unknown> = {}): RhWorkInputCompatibilityResult {
  return { ok: false, summary, data };
}

/**
 * Normalize frozen-client rh_work compatibility carriers into canonical facade
 * input. This module has no Work/Plan/Controller persistence or lifecycle
 * authority; it only parses bounded transport compatibility envelopes and
 * rejects conflicting native fields.
 */
export function normalizeRhWorkInputCompatibility(input: Record<string, unknown>): RhWorkInputCompatibilityResult {
  const args = { ...input };
  const requestedOperation = String(args.operation ?? 'start');
  const scheduleIdOverride = requestedOperation === 'repair'
    && typeof args.capability_id === 'string'
    && args.capability_id.startsWith('schedule.delete:')
      ? args.capability_id.slice('schedule.delete:'.length).trim()
      : '';
  let frozenImplementationReview: { decision: 'approved' | 'changes_required' | 'blocked'; workId: string } | undefined;
  let frozenControllerDisposition: ReturnType<typeof parseControllerDispositionCompatibilityCapability>;
  let frozenControllerRoundOperation: ReturnType<typeof parseControllerRoundCompatibilityCapability>;
  let frozenPlanObligationDispositions: ReturnType<typeof parsePlanObligationCompatibilityCapability>;
  let frozenSemanticOperation: ReturnType<typeof parseFrozenSemanticCompatibilityCapability>;

  try {
    if (requestedOperation === 'repair' && typeof args.capability_id === 'string') {
      const capability = args.capability_id.trim();
      const prefix = 'work.review:';
      if (capability.startsWith(prefix)) {
        const remainder = capability.slice(prefix.length);
        const separator = remainder.indexOf(':');
        if (separator <= 0 || separator === remainder.length - 1) throw new Error('WORK_IMPLEMENTATION_REVIEW_COMPATIBILITY_INVALID');
        const decision = remainder.slice(0, separator);
        const workId = remainder.slice(separator + 1).trim();
        if (!['approved', 'changes_required', 'blocked'].includes(decision) || !workId) throw new Error('WORK_IMPLEMENTATION_REVIEW_COMPATIBILITY_INVALID');
        frozenImplementationReview = { decision: decision as 'approved' | 'changes_required' | 'blocked', workId };
      }
    }
    frozenControllerDisposition = parseControllerDispositionCompatibilityCapability(requestedOperation, args.capability_id);
    frozenControllerRoundOperation = parseControllerRoundCompatibilityCapability(requestedOperation, args.capability_id);
    frozenPlanObligationDispositions = parsePlanObligationCompatibilityCapability(requestedOperation, args.capability_id);
    frozenSemanticOperation = parseFrozenSemanticCompatibilityCapability(requestedOperation, args.capability_id);
    if (frozenControllerDisposition
      && (args.relay_scope_id !== undefined || (frozenControllerDisposition.authorityId && args.controller_authority_id !== undefined))) {
      throw new Error('CONTROLLER_RELAY_DISPOSITION_COMPATIBILITY_CONFLICT');
    }
    if (frozenPlanObligationDispositions && Array.isArray(args.obligation_dispositions)) {
      throw new Error('PLAN_OBLIGATION_COMPATIBILITY_CONFLICT');
    }
    if (frozenSemanticOperation) {
      const requirementScoped = frozenSemanticOperation.operation !== 'work_review';
      if (requirementScoped) {
        const requirementId = typeof args.requirement_id === 'string' ? args.requirement_id.trim() : '';
        if (!requirementId) throw new Error('FROZEN_SEMANTIC_COMPATIBILITY_SCOPE_REQUIRED: requirement_id must remain explicit outside the compatibility envelope');
      }
      for (const key of Object.keys(frozenSemanticOperation.args)) {
        if (args[key] !== undefined) throw new Error(`FROZEN_SEMANTIC_COMPATIBILITY_CONFLICT: native field ${key} is also present`);
      }
      if (frozenSemanticOperation.operation === 'work_review') {
        const explicitWorkId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
        if (!explicitWorkId) throw new Error('FROZEN_SEMANTIC_COMPATIBILITY_SCOPE_REQUIRED: work_id must remain explicit outside the work_review envelope');
        if (frozenImplementationReview) throw new Error('WORK_IMPLEMENTATION_REVIEW_COMPATIBILITY_CONFLICT');
        if (args.review_decision !== undefined || args.review_rationale !== undefined) {
          throw new Error('WORK_IMPLEMENTATION_REVIEW_COMPATIBILITY_CONFLICT');
        }
      }
    }
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'Controller round compatibility input is invalid.');
  }

  if (frozenControllerRoundOperation) {
    args.relay_scope_id = frozenControllerRoundOperation.relayScopeId;
    args.controller_authority_id = frozenControllerRoundOperation.authorityId;
    if (frozenControllerRoundOperation.operation === 'review') {
      if (args.review_decision !== undefined || args.review_rationale !== undefined) {
        return failure('CONTROLLER_ROUND_REVIEW_COMPATIBILITY_CONFLICT: native review fields cannot be combined with the frozen review carrier.');
      }
      args.review_decision = frozenControllerRoundOperation.reviewDecision;
      args.review_rationale = typeof args.reason === 'string' ? args.reason : '';
    }
  }
  if (frozenControllerDisposition) {
    args.relay_scope_id = frozenControllerDisposition.relayScopeId;
    args.disposition = frozenControllerDisposition.disposition;
    if (frozenControllerDisposition.authorityId) args.controller_authority_id = frozenControllerDisposition.authorityId;
  }
  if (frozenPlanObligationDispositions) args.obligation_dispositions = frozenPlanObligationDispositions;
  if (frozenSemanticOperation?.operation === 'plan_create') {
    args.obligation_dispositions = frozenSemanticOperation.args.obligation_dispositions;
  }
  if (frozenSemanticOperation?.operation === 'start') Object.assign(args, frozenSemanticOperation.args);
  if (frozenSemanticOperation?.operation === 'work_review') {
    args.review_decision = frozenSemanticOperation.args.decision;
    args.review_rationale = typeof args.reason === 'string' ? args.reason : '';
  }
  if (frozenImplementationReview) {
    const explicitWorkId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
    if (!explicitWorkId || explicitWorkId !== frozenImplementationReview.workId) {
      return failure(
        `WORK_IMPLEMENTATION_REVIEW_SCOPE_MISMATCH: capability targets ${frozenImplementationReview.workId}; exact work_id is required.`,
        { workId: frozenImplementationReview.workId, implementationReviewRecorded: false },
      );
    }
    args.review_decision = frozenImplementationReview.decision;
    args.review_rationale = typeof args.reason === 'string' ? args.reason : '';
  }

  const frozenSemanticFacadeOperation = frozenSemanticOperation?.operation === 'work_review'
    ? 'review'
    : frozenSemanticOperation?.operation;
  const operation = frozenSemanticFacadeOperation ?? frozenControllerRoundOperation?.operation ?? (frozenControllerDisposition
    ? 'controller_disposition'
    : frozenImplementationReview ? 'review'
    : scheduleIdOverride ? 'schedule_delete' : requestedOperation);

  const requirementOperationArgs = frozenSemanticOperation?.operation === 'requirement_create'
    ? { ...args, ...frozenSemanticOperation.args }
    : undefined;
  return {
    ok: true,
    args,
    operation,
    ...(scheduleIdOverride ? { scheduleIdOverride } : {}),
    ...(requirementOperationArgs ? { requirementOperationArgs } : {}),
  };
}
