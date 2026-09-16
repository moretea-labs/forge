import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { admitRequirement, continueRequirement } from '../../../src/runtime/control-plane/facade/requirement-authority';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade';
import { result } from './result-adapter';

const RH_WORK_REQUIREMENT_OPERATIONS = new Set([
  'requirement_create',
  'requirement_continue',
]);

export function isRhWorkRequirementOperation(operation: string): boolean {
  return RH_WORK_REQUIREMENT_OPERATIONS.has(operation);
}

export async function callRhWorkRequirementOperation(
  ctx: MultiRepositoryMcpToolContext,
  operation: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (!isRhWorkRequirementOperation(operation)) return undefined;

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
          requirement: continued.requirement,
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
    const admission = admitRequirement({ controllerHome: ctx.controllerHome }, {
      requirementId,
      title,
      outcomeStatement,
      acceptanceCriteria: Array.isArray(args.requirement_acceptance_criteria) ? args.requirement_acceptance_criteria.map(String) : [],
      requiredDeliveryReferences: Array.isArray(args.requirement_delivery_references) ? args.requirement_delivery_references.map(String) : [],
      legacyAliases: Array.isArray(args.requirement_legacy_aliases) ? args.requirement_legacy_aliases.map(String) : [],
    });
    if (admission.decision === 'existing_conflict') {
      return result(buildFacadeResult({
        status: 'blocked',
        summary: `REQUIREMENT_ALREADY_EXISTS_CONFLICT: ${admission.requirement.requirementId}. Existing Requirement authority was not changed.`,
        data: { requirement: admission.requirement, requirementCreated: false, admissionDecision: admission.decision },
        suggestedNextActions: [],
      }) as unknown as Record<string, unknown>, true);
    }
    return result(buildFacadeResult({
      summary: admission.decision === 'created'
        ? `Requirement ${admission.requirement.requirementId} created. Requirement authority does not imply a Plan; Controller chooses the next action.`
        : `REQUIREMENT_AUTHORITY_REUSED: ${admission.requirement.requirementId}. Requirement authority does not imply a Plan; Controller chooses the next action.`,
      data: { requirement: admission.requirement, requirementCreated: admission.created, admissionDecision: admission.decision },
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
