import { isLegacyMachineRequirementWait, readRequirement } from '../src/runtime/control-plane/persistence/requirement-store';
import { getWorkContract, isTerminalWorkContractStatus } from '../packages/kernel/work/api/index';
import type { WorkflowContractValidation, WorkflowSupervisorProposal, WorkflowSupervisorTask, WorkflowSupervisorValidators } from './types';

function contractText(task: WorkflowSupervisorTask, key: string): string | undefined {
  const value = task.completionContract[key] ?? task.userBlockerPolicy[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requirementFor(task: WorkflowSupervisorTask, proposal?: WorkflowSupervisorProposal) {
  const controllerHome = contractText(task, 'controller_home');
  const repoId = contractText(task, 'repo_id');
  const workId = contractText(task, 'work_id');
  const workRequirementId = controllerHome && repoId && workId
    ? getWorkContract({ controllerHome, repoId }, workId)?.requirementId
    : undefined;
  // activeScope is legacy read compatibility only. New receipts never make model
  // output authoritative for Requirement identity.
  const legacyRequirementId = proposal?.activeScope?.startsWith('requirement:') ? proposal.activeScope.slice('requirement:'.length).trim() : undefined;
  const requirementId = contractText(task, 'requirement_id') ?? workRequirementId ?? legacyRequirementId;
  if (!controllerHome || !requirementId) return undefined;
  return readRequirement({ controllerHome }, requirementId)?.value;
}

function unsupported(reason: string): WorkflowContractValidation { return { valid: false, reason }; }

function workFor(task: WorkflowSupervisorTask) {
  const controllerHome = contractText(task, 'controller_home');
  const repoId = contractText(task, 'repo_id');
  const workId = contractText(task, 'work_id');
  return controllerHome && repoId && workId ? getWorkContract({ controllerHome, repoId }, workId) : undefined;
}

/**
 * Workflow Supervisor validates only the already-authoritative Forge Goal state.
 * It never re-derives Work/Plan completion and never turns infrastructure failure
 * into a user blocker on its own.
 */
export function forgeWorkflowSupervisorValidators(): WorkflowSupervisorValidators {
  return {
    completionContract: async (task, proposal) => {
      if (task.completionContract.kind === 'forge_work_done') {
        const work = workFor(task);
        return work && isTerminalWorkContractStatus(work.status)
          ? { valid: true, reason: 'work_terminal_committed' }
          : unsupported('work_not_terminal');
      }
      if (!['forge_requirement_done', 'forge_dynamic_requirement_done'].includes(String(task.completionContract.kind ?? ''))) return unsupported('completion_contract_kind_unsupported');
      const requirement = requirementFor(task, proposal);
      if (!requirement) return unsupported('requirement_not_found');
      if (requirement.state !== 'done' || !requirement.semanticAcceptance) {
        return { valid: false, reason: `requirement_not_semantically_done:${requirement.state}`, evidence: requirement.auditRefs.slice(-8) };
      }
      return { valid: true, reason: 'requirement_semantic_acceptance_committed', evidence: requirement.auditRefs.slice(-8) };
    },
    userBlockerPolicy: async (task, proposal) => {
      if (task.userBlockerPolicy.kind === 'forge_work_waiting_for_user') {
        const work = workFor(task);
        return { valid: work?.status === 'blocked', reason: work?.status === 'blocked' ? 'work_blocked_committed' : 'work_not_blocked' };
      }
      if (!['forge_requirement_waiting_for_user', 'forge_dynamic_requirement_waiting_for_user'].includes(String(task.userBlockerPolicy.kind ?? ''))) return unsupported('user_blocker_policy_kind_unsupported');
      const requirement = requirementFor(task, proposal);
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
