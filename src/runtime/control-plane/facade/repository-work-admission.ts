import type { AccessMode } from '../governance/access-policy';
import type { RouteDecision } from '../routing/route-policy';
import { createWorkContract, getWorkContract, updateWorkContract, type WorkContractStoreOptions } from '../../../../packages/kernel/work/api/index';
import type { WorkContract } from './types';

export interface PreparedRepositoryWorkAdmissionInput {
  workId: string;
  repoId: string;
  objective: string;
  acceptanceCriteria: string[];
  allowedPaths: string[];
  checks: string[];
  accessMode: AccessMode;
  isolated: boolean;
  requestedBy: WorkContract['requestedBy'];
  requestId: string;
}

/**
 * Canonical WorkContract admission for the compatibility work_prepare surface.
 * Workspace materialization remains an execution concern; this function owns
 * the semantic contract shape so transports cannot invent a parallel policy.
 */
export function admitPreparedRepositoryWorkContract(
  store: WorkContractStoreOptions,
  input: PreparedRepositoryWorkAdmissionInput,
): WorkContract {
  return createWorkContract(store, {
    workId: input.workId,
    repoId: input.repoId,
    mode: input.isolated ? 'goal_workloop' : 'direct_control',
    objective: input.objective,
    acceptanceCriteria: input.acceptanceCriteria,
    allowedPaths: input.allowedPaths,
    forbiddenPaths: [],
    checks: input.checks,
    constraints: {
      accessMode: input.accessMode,
      workspaceMode: input.isolated ? 'isolated' : 'current',
      requireWorktree: input.isolated,
      directMainProhibited: input.isolated,
      allowCommit: true,
      allowMerge: true,
      allowCleanup: true,
    },
    worktreePolicy: {
      required: input.isolated,
      reason: input.isolated ? 'work_prepare selected isolated worktree execution' : 'explicitly reused a registered checkout',
    },
    requestedBy: input.requestedBy,
    requestId: input.requestId,
  });
}

export interface DirectEditWorkAdmissionInput {
  workId: string;
  repoId: string;
  checkoutId?: string;
  principalId?: string;
  controllerInstanceId?: string;
  baseRevision?: string;
  workspaceFingerprint: string;
  routeDecision: RouteDecision;
  objective: string;
  issueId?: string;
  taskId?: string;
  allowedPaths: string[];
  checks: string[];
  requestedBy: WorkContract['requestedBy'];
}

/**
 * Canonical compatibility admission for an Edit Session bound to Direct Work.
 * The caller supplies the canonical Route Policy decision as evidence; this
 * boundary rejects any decision that requires isolation or a non-direct lane.
 */
export function admitDirectEditWorkContract(
  store: WorkContractStoreOptions,
  input: DirectEditWorkAdmissionInput,
): WorkContract {
  if (input.routeDecision.executionMode !== 'direct_control' || input.routeDecision.requiresIsolation) {
    throw new Error('DIRECT_EDIT_WORK_ROUTE_CONFLICT: canonical Route Policy does not permit Direct Control');
  }
  return createWorkContract(store, {
    workId: input.workId,
    repoId: input.repoId,
    checkoutId: input.checkoutId,
    principalId: input.principalId,
    controllerInstanceId: input.controllerInstanceId,
    baseRevision: input.baseRevision,
    workspaceFingerprint: input.workspaceFingerprint,
    routeDecisionFingerprint: input.routeDecision.inputFingerprint,
    routeDecision: input.routeDecision,
    mode: 'direct_control',
    objective: input.objective,
    acceptanceCriteria: [],
    constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
    risk: 'low',
    status: 'running',
    phase: 'implementation',
    issueId: input.issueId,
    taskId: input.taskId,
    scopeSummary: input.objective,
    allowedPaths: input.allowedPaths,
    forbiddenPaths: [],
    checks: input.checks,
    requestedBy: input.requestedBy,
    evidenceRefs: [],
    handoffRefs: [],
    suggestedNextActions: [],
    policyDecisions: [],
    checkRefs: [],
    reconciliations: [],
  });
}


export interface MaterializedRepositoryWorkspace {
  managed: boolean;
  checkoutId?: string;
  root?: string;
  baseRevision?: string | null;
}

/**
 * Canonical placement materialization transition for an admitted isolated
 * WorkContract. The concrete worktree creator is injected by the execution
 * boundary; only this authority decides how its evidence updates the Work.
 */
export function materializeRepositoryWorkPlacement(
  store: WorkContractStoreOptions,
  workId: string,
  materialize: (contract: WorkContract) => MaterializedRepositoryWorkspace,
): WorkContract | undefined {
  const contract = getWorkContract(store, workId);
  if (!contract || contract.worktreePolicy.required !== true || contract.worktreeRef) return contract;
  const workspace = materialize(contract);
  if (!workspace.managed || !workspace.checkoutId || !workspace.root) {
    throw new Error('MANAGED_WORKSPACE_NOT_MATERIALIZED');
  }
  return updateWorkContract(store, workId, {
    checkoutId: workspace.checkoutId,
    baseRevision: workspace.baseRevision ?? contract.baseRevision,
    worktreeRef: workspace.root,
    driver: { ...contract.driver, preferred: 'isolated_worktree', allowDirectEdit: false },
  });
}
