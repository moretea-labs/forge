import {
  bindRequirementCandidateAuditRef,
  bindRequirementRepositoryPlacement,
  createRequirement,
  listRequirements,
  readRequirement,
  type CreateRequirementInput,
  type Requirement,
  type RequirementStoreOptions,
} from '../persistence/requirement-store';
import { readPlanContractStore } from './plan-contract-store';
import type { PlanContract } from './types';
import { cognitionMemoryStore } from '../persistence/cognition-store';
import { memoryAddressKey, type MemoryUnit } from '../../../../packages/kernel/cognition/api/index';

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
    ...(String(input.repoId ?? '').trim() ? { repoId: String(input.repoId).trim().slice(0, 256) } : {}),
    title: String(input.title ?? '').trim().slice(0, 500),
    outcomeStatement: String(input.outcomeStatement ?? '').trim().slice(0, 2_000),
    acceptanceCriteria: bounded(input.acceptanceCriteria, 50),
    requiredDeliveryReferences: bounded(input.requiredDeliveryReferences, 50),
    legacyAliases: bounded(input.legacyAliases, 20, 160),
    auditRefs: bounded(input.auditRefs, 50),
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

function existingDecision(
  options: RequirementStoreOptions,
  existing: Requirement,
  requested: CreateRequirementInput,
): RequirementAdmissionResult {
  if (!sameBootstrapIdentity(existing, requested)) {
    return { decision: 'existing_conflict', requirement: existing, created: false };
  }
  const requestedRepoId = requested.repoId?.trim();
  const requirement = requestedRepoId
    ? bindRequirementRepositoryPlacement(options, existing.requirementId, requestedRepoId)
    : existing;
  return { decision: 'reuse_existing', requirement, created: false };
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
  if (existing) return existingDecision(options, existing, requested);

  try {
    return { decision: 'created', requirement: createRequirement(options, requested), created: true };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('REQUIREMENT_ALREADY_EXISTS:')) throw error;
    const raced = readRequirement(options, requested.requirementId)?.value;
    if (!raced) throw error;
    return existingDecision(options, raced, requested);
  }
}

export function listRequirementsForRepository(
  options: RequirementStoreOptions,
  repoIdInput?: string,
  limit = 500,
  plans?: readonly PlanContract[],
) {
  const repoId = String(repoIdInput ?? '').trim();
  const all = listRequirements(options, 1000);
  if (!repoId) return all.slice(0, limit);
  // Reuse the board's canonical Plan snapshot instead of rematerializing rows.
  const relatedRequirementIds = new Set(
    (plans ?? readPlanContractStore({ controllerHome: options.controllerHome, repoId }).contracts)
      .map((plan) => plan.requirementId?.trim())
      .filter((requirementId): requirementId is string => Boolean(requirementId)),
  );
  return all
    .filter((record) => record.value.repoId === repoId || relatedRequirementIds.has(record.value.requirementId))
    .slice(0, limit);
}

export type RequirementCandidatePromotionDecision =
  | RequirementAdmissionDecision
  | 'candidate_already_promoted';

export interface RequirementCandidatePromotionResult {
  decision: RequirementCandidatePromotionDecision;
  requirement: Requirement;
  created: boolean;
  candidateAuditRef: string;
  candidateMemoryId: string;
  workspaceId: string;
}

function activeRequirementCandidate(memory: MemoryUnit, at: string): boolean {
  return !memory.retractedAt
    && memory.validFrom <= at
    && (!memory.expiresAt || memory.expiresAt > at)
    && memory.facets.includes('candidate-finding')
    && memory.facets.includes('requirement-candidate')
    && memory.facets.includes('advisory')
    && memory.concepts.includes('forge.requirement-candidate')
    && memory.provenance.sourceKind === 'system'
    && Boolean(memory.provenance.sourceId?.startsWith('cognitive-requirement-candidate:promoted:'))
    && memory.provenance.evidenceRefs.length > 0;
}

function validatedRequirementCandidate(
  options: RequirementStoreOptions,
  workspaceId: string,
  candidateMemoryId: string,
): MemoryUnit {
  const workspace = String(workspaceId ?? '').trim();
  const memoryId = String(candidateMemoryId ?? '').trim();
  if (!workspace || !memoryId) throw new Error('REQUIREMENT_CANDIDATE_SCOPE_REQUIRED');
  const scope = { schemaVersion: 1 as const, kind: 'workspace' as const, id: workspace };
  const store = cognitionMemoryStore(options.controllerHome);
  const candidate = store.read(scope, memoryId);
  if (!candidate || !activeRequirementCandidate(candidate, options.now?.() ?? new Date().toISOString())) {
    throw new Error(`REQUIREMENT_CANDIDATE_INVALID: ${memoryId}`);
  }
  const sourceId = candidate.provenance.sourceId!.slice('cognitive-requirement-candidate:'.length);
  const source = store.read(scope, sourceId);
  if (!source
    || !source.id.startsWith('promoted:')
    || source.retractedAt
    || !source.facets.includes('cross-project')
    || !source.facets.includes('engineering-principle')
    || candidate.provenance.evidenceRefs.some(ref => !source.provenance.evidenceRefs.includes(ref))) {
    throw new Error(`REQUIREMENT_CANDIDATE_SOURCE_INVALID: ${memoryId}`);
  }
  return candidate;
}

export function requirementCandidateAuditRef(workspaceId: string, candidate: Pick<MemoryUnit, 'id' | 'revision'>): string {
  const scope = { schemaVersion: 1 as const, kind: 'workspace' as const, id: String(workspaceId).trim() };
  return `cognitive-requirement-candidate:${memoryAddressKey({ scope, id: candidate.id })}:r${candidate.revision}`;
}

function requirementByCandidateAuditRef(options: RequirementStoreOptions, candidateAuditRef: string): Requirement | undefined {
  return listRequirements(options, 1000)
    .map(record => record.value)
    .find(requirement => requirement.auditRefs.includes(candidateAuditRef));
}

export function promoteRequirementCandidate(
  options: RequirementStoreOptions,
  input: Omit<CreateRequirementInput, 'auditRefs'> & {
    workspaceId: string;
    candidateMemoryId: string;
  },
): RequirementCandidatePromotionResult {
  const candidate = validatedRequirementCandidate(options, input.workspaceId, input.candidateMemoryId);
  const candidateAuditRef = requirementCandidateAuditRef(input.workspaceId, candidate);
  const prior = requirementByCandidateAuditRef(options, candidateAuditRef);
  if (prior && prior.requirementId !== String(input.requirementId ?? '').trim()) {
    return {
      decision: 'candidate_already_promoted',
      requirement: prior,
      created: false,
      candidateAuditRef,
      candidateMemoryId: candidate.id,
      workspaceId: input.workspaceId,
    };
  }

  try {
    const admission = admitRequirement(options, {
      ...input,
      auditRefs: [candidateAuditRef],
    });
    const requirement = admission.decision === 'reuse_existing'
      && !admission.requirement.auditRefs.includes(candidateAuditRef)
      ? bindRequirementCandidateAuditRef(options, admission.requirement.requirementId, candidateAuditRef)
      : admission.requirement;
    return {
      ...admission,
      requirement,
      candidateAuditRef,
      candidateMemoryId: candidate.id,
      workspaceId: input.workspaceId,
    };
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'REQUIREMENT_CANDIDATE_ALREADY_PROMOTED') throw error;
    const raced = requirementByCandidateAuditRef(options, candidateAuditRef);
    if (!raced) throw error;
    return {
      decision: 'candidate_already_promoted',
      requirement: raced,
      created: false,
      candidateAuditRef,
      candidateMemoryId: candidate.id,
      workspaceId: input.workspaceId,
    };
  }
}
