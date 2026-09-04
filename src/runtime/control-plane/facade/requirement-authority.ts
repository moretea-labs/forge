import {
  createRequirement,
  readRequirement,
  updateRequirement,
  type CreateRequirementInput,
  type Requirement,
  type RequirementStoreOptions,
} from '../persistence/requirement-store';

export type RequirementAdmissionDecision = 'created' | 'reuse_existing' | 'existing_conflict';

export interface RequirementAdmissionResult {
  decision: RequirementAdmissionDecision;
  requirement: Requirement;
  created: boolean;
}

function bounded(values: readonly string[] | undefined, limit: number, maxLength = 500): string[] {
  return (values ?? [])
    .map((value) => String(value).trim())
    .filter(Boolean)
    .slice(0, limit)
    .map((value) => value.slice(0, maxLength));
}

/**
 * Canonical Requirement bootstrap request. Persistence performs the same
 * defensive bounds before writing, but create/reuse/conflict admission lives
 * only here so MCP/CLI adapters cannot grow their own Requirement lifecycle.
 */
export function normalizeRequirementAdmissionInput(input: CreateRequirementInput): CreateRequirementInput {
  const requirementId = String(input.requirementId ?? '').trim();
  if (!requirementId || requirementId.includes('/') || requirementId.includes('\\')) throw new Error('REQUIREMENT_ID_INVALID');
  const normalized: CreateRequirementInput = {
    requirementId: requirementId.slice(0, 160),
    title: String(input.title ?? '').trim().slice(0, 500),
    outcomeStatement: String(input.outcomeStatement ?? '').trim().slice(0, 2_000),
    acceptanceCriteria: bounded(input.acceptanceCriteria, 50),
    requiredDeliveryReferences: bounded(input.requiredDeliveryReferences, 50),
    legacyAliases: bounded(input.legacyAliases, 20, 160),
  };
  if (!normalized.title || !normalized.outcomeStatement) throw new Error('REQUIREMENT_CONTENT_REQUIRED');
  return normalized;
}

function sameBootstrapIdentity(existing: Requirement, requested: CreateRequirementInput): boolean {
  return existing.requirementId === requested.requirementId
    && existing.title === requested.title
    && existing.outcomeStatement === requested.outcomeStatement
    && JSON.stringify(existing.acceptanceCriteria) === JSON.stringify(requested.acceptanceCriteria ?? [])
    && JSON.stringify(existing.requiredDeliveryReferences) === JSON.stringify(requested.requiredDeliveryReferences ?? [])
    && JSON.stringify(existing.legacyAliases) === JSON.stringify(requested.legacyAliases ?? []);
}

function existingDecision(existing: Requirement, requested: CreateRequirementInput): RequirementAdmissionResult {
  return {
    decision: sameBootstrapIdentity(existing, requested) ? 'reuse_existing' : 'existing_conflict',
    requirement: existing,
    created: false,
  };
}

/**
 * Sole bootstrap admission authority for Requirement identity. A create race is
 * closed by rereading the winner and applying the same identity comparison;
 * adapters therefore never need read/compare/create policy of their own.
 */
export function admitRequirement(
  options: RequirementStoreOptions,
  input: CreateRequirementInput,
): RequirementAdmissionResult {
  const requested = normalizeRequirementAdmissionInput(input);
  const existing = readRequirement(options, requested.requirementId)?.value;
  if (existing) return existingDecision(existing, requested);

  try {
    return { decision: 'created', requirement: createRequirement(options, requested), created: true };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('REQUIREMENT_ALREADY_EXISTS:')) throw error;
    const raced = readRequirement(options, requested.requirementId)?.value;
    if (!raced) throw error;
    return existingDecision(raced, requested);
  }
}


export interface RequirementContinueResult {
  requirement: Requirement;
  resumed: boolean;
}

/**
 * Canonical explicit semantic continue for a Requirement that is waiting on
 * ChatGPT/user judgement. Persistence owns transition legality; this facade
 * owns the semantic meaning so adapters and launchers never mutate Requirement
 * state directly.
 */
export function continueRequirement(
  options: RequirementStoreOptions,
  requirementId: string,
): RequirementContinueResult {
  const normalizedId = String(requirementId ?? '').trim();
  const current = readRequirement(options, normalizedId)?.value;
  if (!current) throw new Error(`REQUIREMENT_NOT_FOUND: ${normalizedId}`);
  if (current.state === 'active') return { requirement: current, resumed: false };
  if (current.state === 'done' || current.state === 'cancelled') {
    throw new Error(`REQUIREMENT_TERMINAL: ${current.requirementId}:${current.state}`);
  }
  if (current.state !== 'waiting_for_user') {
    throw new Error(`REQUIREMENT_CONTINUE_NOT_WAITING: ${current.requirementId}:${current.state}`);
  }

  const requirement = updateRequirement(options, {
    requirementId: current.requirementId,
    action: 'requirement_semantic_continue',
    mutate: (latest) => {
      if (latest.state === 'active') return latest;
      if (latest.state === 'done' || latest.state === 'cancelled') {
        throw new Error(`REQUIREMENT_TERMINAL: ${latest.requirementId}:${latest.state}`);
      }
      if (latest.state !== 'waiting_for_user') {
        throw new Error(`REQUIREMENT_CONTINUE_NOT_WAITING: ${latest.requirementId}:${latest.state}`);
      }
      return {
        ...latest,
        state: 'active',
        needsAttention: false,
        attentionSummary: undefined,
      };
    },
  });
  return { requirement, resumed: true };
}
