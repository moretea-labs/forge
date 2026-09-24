import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { admitRequirement, continueRequirement, promoteRequirementCandidate } from '../../../src/runtime/control-plane/facade/requirement-authority';
import { listRequirementRevisionRecords, readRequirement, requirementSemanticView, reviseRequirementSemantic } from '../../../src/runtime/control-plane/persistence/requirement-store';
import { readForgeInstanceIdentity } from '../../../packages/kernel/identity/api/index';
import { resolveProjectForRepositoryPlacement } from '../../../src/runtime/control-plane/workspace/workspace-store';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade';
import { result } from './result-adapter';

const RH_WORK_REQUIREMENT_OPERATIONS = new Set([
  'requirement_create',
  'requirement_get',
  'requirement_revise',
  'requirement_promote_candidate',
  'requirement_continue',
]);

export function isRhWorkRequirementOperation(operation: string): boolean {
  return RH_WORK_REQUIREMENT_OPERATIONS.has(operation);
}

export async function callRhWorkRequirementOperation(
  ctx: MultiRepositoryMcpToolContext,
  repository: { repoId: string; activeCheckoutId?: string } | undefined,
  operation: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (!isRhWorkRequirementOperation(operation)) return undefined;

  if (operation === 'requirement_get') {
    const requirementId = typeof args.requirement_id === 'string' ? args.requirement_id.trim() : '';
    const record = requirementId ? readRequirement({ controllerHome: ctx.controllerHome }, requirementId) : undefined;
    if (!record) return result(buildFacadeResult({
      status: 'not_found', summary: `Requirement ${requirementId || '(missing)'} not found.`, data: { requirementId },
    }) as unknown as Record<string, unknown>, true);
    const semantic = requirementSemanticView(record.value);
    return result(buildFacadeResult({
      summary: `Requirement ${semantic.requirementId} retrieved at semantic revision ${semantic.revision}.`,
      data: {
        requirement: semantic,
        ...(args.detail_level === 'detail' ? { revisionHistory: listRequirementRevisionRecords({ controllerHome: ctx.controllerHome }, semantic.requirementId, 100) } : {}),
      },
      detailLevel: args.detail_level === 'detail' ? 'detail' : 'summary',
    }) as unknown as Record<string, unknown>);
  }

  if (operation === 'requirement_revise') {
    const requirementId = typeof args.requirement_id === 'string' ? args.requirement_id.trim() : '';
    const expectedRevision = Number(args.expected_revision);
    try {
      const revised = reviseRequirementSemantic({ controllerHome: ctx.controllerHome }, requirementId, {
        expectedRevision,
        ...(typeof args.requirement_title === 'string' ? { title: args.requirement_title } : {}),
        ...(typeof args.requirement_outcome === 'string' ? { outcomeStatement: args.requirement_outcome } : {}),
        ...(Array.isArray(args.requirement_acceptance_criteria) ? { acceptanceCriteria: args.requirement_acceptance_criteria.map(String) } : {}),
        ...(Array.isArray(args.requirement_delivery_references) ? { requiredDeliveryReferences: args.requirement_delivery_references.map(String) } : {}),
        ...(args.requirement_state === 'open' || args.requirement_state === 'completed' || args.requirement_state === 'cancelled' ? { state: args.requirement_state } : {}),
      });
      const semantic = requirementSemanticView(revised);
      return result(buildFacadeResult({
        summary: `Requirement ${semantic.requirementId} revised atomically to semantic revision ${semantic.revision}.`,
        data: { requirement: semantic, expectedRevision, semanticRevision: semantic.revision },
      }) as unknown as Record<string, unknown>);
    } catch (error) {
      const current = requirementId ? readRequirement({ controllerHome: ctx.controllerHome }, requirementId)?.value : undefined;
      return result(buildFacadeResult({
        status: 'blocked', summary: error instanceof Error ? error.message : String(error),
        data: { requirementId, expectedRevision, ...(current ? { currentRequirement: requirementSemanticView(current) } : {}) },
      }) as unknown as Record<string, unknown>, true);
    }
  }

  if (operation === 'requirement_continue') {
    const requirementId = typeof args.requirement_id === 'string' ? args.requirement_id.trim() : '';
    if (!requirementId) {
      return result(buildFacadeResult({
        status: 'blocked',
        summary: 'REQUIREMENT_CONTINUE_INPUT_REQUIRED: requirement_id is required.',
        data: { requirementResumed: false },
      }) as unknown as Record<string, unknown>, true);
    }
    try {
      const continued = continueRequirement({ controllerHome: ctx.controllerHome }, requirementId);
      return result(buildFacadeResult({
        summary: continued.resumed
          ? `Requirement ${continued.requirement.requirementId} resumed from waiting_for_user to active by explicit semantic continue.`
          : `REQUIREMENT_ALREADY_ACTIVE: ${continued.requirement.requirementId}. Explicit continue is idempotent.`,
        data: {
          requirement: requirementSemanticView(continued.requirement),
          requirementResumed: continued.resumed,
          semanticDecision: 'continue',
        },
        suggestedNextActions: [],
      }) as unknown as Record<string, unknown>);
    } catch (error) {
      return result(buildFacadeResult({
        status: 'blocked',
        summary: error instanceof Error ? error.message : String(error),
        data: { requirementResumed: false },
        suggestedNextActions: [],
      }) as unknown as Record<string, unknown>, true);
    }
  }

  const requirementId = typeof args.requirement_id === 'string' ? args.requirement_id : '';
  const title = typeof args.requirement_title === 'string' ? args.requirement_title : '';
  const outcomeStatement = typeof args.requirement_outcome === 'string' ? args.requirement_outcome : '';
  if (!requirementId.trim() || !title.trim() || !outcomeStatement.trim()) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: 'REQUIREMENT_CREATE_INPUT_REQUIRED: requirement_id, requirement_title, and requirement_outcome are required.',
      data: { requirementCreated: false },
    }) as unknown as Record<string, unknown>, true);
  }
  try {
    const requirementInput = {
      requirementId,
      title,
      outcomeStatement,
      acceptanceCriteria: Array.isArray(args.requirement_acceptance_criteria) ? args.requirement_acceptance_criteria.map(String) : [],
      requiredDeliveryReferences: Array.isArray(args.requirement_delivery_references) ? args.requirement_delivery_references.map(String) : [],
      legacyAliases: Array.isArray(args.requirement_legacy_aliases) ? args.requirement_legacy_aliases.map(String) : [],
    };
    const admission = operation === 'requirement_promote_candidate'
      ? (() => {
          if (!repository) throw new Error('REQUIREMENT_CANDIDATE_REPOSITORY_PLACEMENT_REQUIRED');
          const candidateMemoryId = typeof args.requirement_candidate_id === 'string' ? args.requirement_candidate_id.trim() : '';
          if (!candidateMemoryId) throw new Error('REQUIREMENT_CANDIDATE_ID_REQUIRED');
          const instance = readForgeInstanceIdentity(ctx.controllerHome);
          if (!instance) throw new Error('REQUIREMENT_CANDIDATE_FORGE_INSTANCE_REQUIRED');
          const project = resolveProjectForRepositoryPlacement({
            controllerHome: ctx.controllerHome,
            forgeInstanceId: instance.instanceId,
            repositoryId: repository.repoId,
            checkoutId: repository.activeCheckoutId,
          });
          if (!project) throw new Error('REQUIREMENT_CANDIDATE_PROJECT_BINDING_REQUIRED');
          return promoteRequirementCandidate({ controllerHome: ctx.controllerHome }, {
            ...requirementInput,
            workspaceId: project.workspaceId,
            candidateMemoryId,
          });
        })()
      : admitRequirement({ controllerHome: ctx.controllerHome }, requirementInput);
    if (admission.decision === 'existing_conflict') {
      return result(buildFacadeResult({
        status: 'blocked',
        summary: `REQUIREMENT_ALREADY_EXISTS_CONFLICT: ${admission.requirement.requirementId}. Existing Requirement authority was not changed.`,
        data: { requirement: requirementSemanticView(admission.requirement), requirementCreated: false, admissionDecision: admission.decision },
        suggestedNextActions: [],
      }) as unknown as Record<string, unknown>, true);
    }
    return result(buildFacadeResult({
      summary: admission.decision === 'created'
        ? operation === 'requirement_promote_candidate'
          ? `Requirement ${admission.requirement.requirementId} created from an explicit Cognitive candidate promotion. Requirement authority does not imply a Plan; Controller chooses the next action.`
          : `Requirement ${admission.requirement.requirementId} created. Requirement authority does not imply a Plan; Controller chooses the next action.`
        : admission.decision === 'candidate_already_promoted'
          ? `REQUIREMENT_CANDIDATE_ALREADY_PROMOTED: ${admission.requirement.requirementId}. Existing Requirement authority was reused; no duplicate Requirement was created.`
          : `REQUIREMENT_AUTHORITY_REUSED: ${admission.requirement.requirementId}. Requirement authority does not imply a Plan; Controller chooses the next action.`,
      data: {
        requirement: requirementSemanticView(admission.requirement),
        requirementCreated: admission.created,
        admissionDecision: admission.decision,
        ...('candidateAuditRef' in admission ? {
          requirementCandidatePromoted: true,
          candidateAuditRef: admission.candidateAuditRef,
          candidateMemoryId: admission.candidateMemoryId,
          workspaceId: admission.workspaceId,
        } : {}),
      },
      suggestedNextActions: [],
    }) as unknown as Record<string, unknown>);
  } catch (error) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: error instanceof Error ? error.message : String(error),
      data: { requirementCreated: false },
    }) as unknown as Record<string, unknown>, true);
  }
}
