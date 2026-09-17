import { isLegacyMachineRequirementWait, readRequirement } from '../src/runtime/control-plane/persistence/requirement-store';
import type { WorkflowContractValidation, WorkflowSupervisorTask, WorkflowSupervisorValidators } from './types';

function contractText(task: WorkflowSupervisorTask, key: string): string | undefined {
  const value = task.completionContract[key] ?? task.userBlockerPolicy[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requirementFor(task: WorkflowSupervisorTask) {
  const controllerHome = contractText(task, 'controller_home');
  const requirementId = contractText(task, 'requirement_id');
  if (!controllerHome || !requirementId) return undefined;
  return readRequirement({ controllerHome }, requirementId)?.value;
}

function unsupported(reason: string): WorkflowContractValidation { return { valid: false, reason }; }

/**
 * Workflow Supervisor validates only the already-authoritative Forge Goal state.
 * It never re-derives Work/Plan completion and never turns infrastructure failure
 * into a user blocker on its own.
 */
export function forgeWorkflowSupervisorValidators(): WorkflowSupervisorValidators {
  return {
    completionContract: async (task) => {
      if (task.completionContract.kind !== 'forge_requirement_done') return unsupported('completion_contract_kind_unsupported');
      const requirement = requirementFor(task);
      if (!requirement) return unsupported('requirement_not_found');
      if (requirement.state !== 'done' || !requirement.semanticAcceptance) {
        return { valid: false, reason: `requirement_not_semantically_done:${requirement.state}`, evidence: requirement.auditRefs.slice(-8) };
      }
      return { valid: true, reason: 'requirement_semantic_acceptance_committed', evidence: requirement.auditRefs.slice(-8) };
    },
    userBlockerPolicy: async (task) => {
      if (task.userBlockerPolicy.kind !== 'forge_requirement_waiting_for_user') return unsupported('user_blocker_policy_kind_unsupported');
      const requirement = requirementFor(task);
      if (!requirement) return unsupported('requirement_not_found');
      const genuineUserWait = requirement.state === 'waiting_for_user'
        && requirement.needsAttention
        && !isLegacyMachineRequirementWait(requirement);
      return {
        valid: genuineUserWait,
        reason: genuineUserWait ? 'requirement_waiting_for_user_committed' : `requirement_not_waiting_for_user:${requirement.state}`,
        evidence: requirement.auditRefs.slice(-8),
      };
    },
  };
}
