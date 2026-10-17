import { isLegacyMachineRequirementWait, readRequirement } from '../src/runtime/control-plane/persistence/requirement-store';
import { getWorkContract, isTerminalSemanticWorkState, readWorkContractLineageSnapshot, type SemanticWorkState } from '../packages/kernel/work/api/index';
import { SEMANTIC_SCOPE_KEY } from '../src/cli/repositories/controller-home';
import type { WorkflowContractValidation, WorkflowSupervisorProposal, WorkflowSupervisorTask, WorkflowSupervisorValidators } from './types';

function contractText(task: WorkflowSupervisorTask, key: string): string | undefined {
  const value = task.completionContract[key] ?? task.userBlockerPolicy[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requirementFor(task: WorkflowSupervisorTask, proposal?: WorkflowSupervisorProposal) {
  const controllerHome = contractText(task, 'controller_home');
  const repoId = contractText(task, 'repo_id');
  const workId = contractText(task, 'work_id');
  const workRequirementId = controllerHome && workId
    ? getWorkContract({ controllerHome, scopeKey: repoId ?? SEMANTIC_SCOPE_KEY }, workId)?.requirementId
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
  return controllerHome && workId
    ? getWorkContract({ controllerHome, scopeKey: repoId ?? SEMANTIC_SCOPE_KEY }, workId) : undefined;
}


function boundWorkLineage(task: WorkflowSupervisorTask, requirementId?: string): WorkflowContractValidation | undefined {
  const controllerHome = contractText(task, 'controller_home');
  const repoId = contractText(task, 'repo_id');
  const workId = requirementId ? undefined : contractText(task, 'work_id');
  if (!controllerHome || (!workId && !requirementId)) return undefined;
  // Repository rows are compatibility evidence; portable semantic rows win by identity.
  const scopes = repoId ? [repoId, SEMANTIC_SCOPE_KEY] : [SEMANTIC_SCOPE_KEY];
  const byId = new Map<string, { workId: string; requirementId?: string; parentWorkId?: string;
    semanticParentWorkId?: string; dependsOnWorkIds?: string[]; predecessorWorkId?: string;
    supersedes?: string[]; supersededBy?: string; semanticState?: SemanticWorkState; error?: string }>();
  for (const scopeKey of new Set(scopes)) {
    const snapshot = readWorkContractLineageSnapshot({ controllerHome, scopeKey });
    if (snapshot.contracts.length + snapshot.invalid.length >= 5_000) return unsupported('work_lineage_read_limit');
    for (const work of [...snapshot.contracts, ...snapshot.invalid]) byId.set(work.workId, work);
  }
  const relevant = new Set<string>(workId ? [workId] : [...byId.values()]
    .filter((work) => work.requirementId === requirementId).map((work) => work.workId));
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const work of byId.values()) {
      if (relevant.has(work.parentWorkId ?? '') || relevant.has(work.semanticParentWorkId ?? '')
        || relevant.has(work.predecessorWorkId ?? '') || (work.supersedes ?? []).some((id) => relevant.has(id))) {
        if (!relevant.has(work.workId)) { relevant.add(work.workId); expanded = true; }
      }
      if (relevant.has(work.workId)) {
        for (const dependency of [...(work.dependsOnWorkIds ?? []), ...(work.supersededBy ? [work.supersededBy] : [])]) {
          if (!relevant.has(dependency)) { relevant.add(dependency); expanded = true; }
        }
      }
    }
  }
  const blockers = [...relevant].filter((id) => {
    const work = byId.get(id);
    return !work || Boolean(work.error) || !work.semanticState || !isTerminalSemanticWorkState(work.semanticState);
  }).sort();
  return blockers.length > 0
    ? { valid: false, reason: 'bound_work_lineage_not_terminal', evidence: blockers.slice(0, 8) }
    : undefined;
}

function validateWorkCompletion(task: WorkflowSupervisorTask): WorkflowContractValidation {
  const work = workFor(task);
  return work && work.semanticState === 'completed'
    ? boundWorkLineage(task) ?? { valid: true, reason: 'work_terminal_committed' }
    : unsupported('work_not_completed');
}

function validateRequirementCompletion(task: WorkflowSupervisorTask, proposal: WorkflowSupervisorProposal): WorkflowContractValidation {
  const requirement = requirementFor(task, proposal);
  if (!requirement) return unsupported('requirement_not_found');
  if (requirement.state !== 'done' || !requirement.semanticAcceptance) {
    return { valid: false, reason: 'requirement_not_semantically_done:' + requirement.state, evidence: requirement.auditRefs.slice(-8) };
  }
  return boundWorkLineage(task, requirement.requirementId)
    ?? { valid: true, reason: 'requirement_semantic_acceptance_committed', evidence: requirement.auditRefs.slice(-8) };
}

/**
 * A standalone task may intentionally have no semantic target. When it names a
 * Work or Requirement, DONE must use the same committed semantic proof as the
 * corresponding typed completion contract. Repository provenance alone is not
 * a semantic binding, and proposal text never creates one.
 */
function validateSemanticCompletionBinding(task: WorkflowSupervisorTask, proposal: WorkflowSupervisorProposal): WorkflowContractValidation {
  const workId = contractText(task, 'work_id');
  const requirementId = contractText(task, 'requirement_id');
  if (workId && requirementId) return unsupported('semantic_completion_binding_ambiguous');
  if (workId) return validateWorkCompletion(task);
  if (requirementId) return validateRequirementCompletion(task, proposal);
  return { valid: true, reason: 'model_semantic_completion' };
}

/** Read committed semantic Goal and explicit Work lineage without changing either authority. */
export function forgeWorkflowSupervisorValidators(): WorkflowSupervisorValidators {
  return {
    completionContract: async (task, proposal) => {
      if (task.completionContract.kind === 'model_semantic_completion') {
        return validateSemanticCompletionBinding(task, proposal);
      }
      if (task.completionContract.kind === 'forge_work_done') return validateWorkCompletion(task);
      if (!['forge_requirement_done', 'forge_dynamic_requirement_done'].includes(String(task.completionContract.kind ?? ''))) return unsupported('completion_contract_kind_unsupported');
      return validateRequirementCompletion(task, proposal);
    },
    userBlockerPolicy: async (task, proposal) => {
      if (task.userBlockerPolicy.kind === 'model_semantic_user_blocker') {
        // Tool visibility is a provider failure, not a decision or permission
        // only the user can supply. Use the immutable completion evidence;
        // do not add another task state or rely on transient browser text.
        return proposal.evidence.includes('NO_TOOL_RECEIPT')
          ? { valid: false, reason: 'tool_unavailable_not_user_blocker' }
          : { valid: true, reason: 'model_semantic_user_blocker' };
      }
      if (task.userBlockerPolicy.kind === 'forge_work_waiting_for_user') {
        const work = workFor(task);
        return { valid: work?.dispatchState === 'blocked', reason: work?.dispatchState === 'blocked' ? 'work_blocked_committed' : 'work_not_blocked' };
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
