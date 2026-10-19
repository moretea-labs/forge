import type { AccessMode } from '../governance/access-policy';
import { createWorkContract, getWorkContract, updateWorkContractPlacement, type WorkContractStoreOptions, type WorkContractPlacementChangeKind } from '../../../../packages/kernel/work/api/index';
import { executionPlacement, readForgeInstanceIdentity } from '../../../../packages/kernel/identity/api/index';
import type { WorkContract } from './types';

function repositoryExecutionPlacement(store: WorkContractStoreOptions, repoId: string, checkoutId?: string) {
  const forgeInstanceId = store.controllerHome ? readForgeInstanceIdentity(store.controllerHome)?.instanceId : undefined;
  return executionPlacement({
    ...(forgeInstanceId ? { forgeInstanceId } : {}),
    repositoryId: repoId,
    ...(checkoutId?.trim() ? { checkoutId: checkoutId.trim() } : {}),
  });
}

export interface PreparedRepositoryWorkAdmissionInput {
  workId: string;
  repoId: string;
  objective: string;
  acceptanceCriteria: string[];
  checks: string[];
  accessMode: AccessMode;
  isolated: boolean;
  requestedBy: WorkContract['requestedBy'];
  requestId: string;
  /** Legacy ingress-only path hints; concrete mutation scope is EditSession-owned. */
  allowedPaths?: string[];
  /** Legacy ingress-only path hints; concrete mutation scope is EditSession-owned. */
  forbiddenPaths?: string[];
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
    executionPlacement: repositoryExecutionPlacement(store, input.repoId),
    objective: input.objective,
    acceptanceCriteria: input.acceptanceCriteria,
    checks: input.checks,
    constraints: {
      accessMode: input.accessMode,
      workspaceMode: input.isolated ? 'isolated' : 'current',
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
  objective: string;
  issueId?: string;
  taskId?: string;
  checks: string[];
  requestedBy: WorkContract['requestedBy'];
  /** Legacy ingress-only path hints; concrete mutation scope is EditSession-owned. */
  allowedPaths?: string[];
  /** Legacy ingress-only path hints; concrete mutation scope is EditSession-owned. */
  forbiddenPaths?: string[];
}

/**
 * Canonical compatibility admission for an Edit Session bound to Direct Work.
 * Direct-edit admission is selected explicitly by this capability boundary;
 * no route/mode token authorizes or rejects the operation.
 */
export function admitDirectEditWorkContract(
  store: WorkContractStoreOptions,
  input: DirectEditWorkAdmissionInput,
): WorkContract {
  return createWorkContract(store, {
    workId: input.workId,
    repoId: input.repoId,
    checkoutId: input.checkoutId,
    executionPlacement: repositoryExecutionPlacement(store, input.repoId, input.checkoutId),
    principalId: input.principalId,
    controllerInstanceId: input.controllerInstanceId,
    baseRevision: input.baseRevision,
    workspaceFingerprint: input.workspaceFingerprint,
    objective: input.objective,
    acceptanceCriteria: [],
    constraints: { workspaceMode: 'current' },
    risk: 'low',
    dispatchState: 'running',
    phase: 'implementation',
    issueId: input.issueId,
    taskId: input.taskId,
    scopeSummary: input.objective,
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


export interface RepositoryWorkPlacementChange {
  kind: WorkContractPlacementChangeKind;
  expectedCheckoutId?: string;
  expectedWorktreeRef?: string;
  checkoutId: string;
  worktreeRef?: string;
  baseRevision?: string | null;
  worktreePolicy?: WorkContract['worktreePolicy'];
  constraints?: WorkContract['constraints'];
}

/** One canonical entry point for initial placement, CAS rebind, and explicit legacy detach/restore. */
export function updateRepositoryWorkPlacement(
  store: WorkContractStoreOptions,
  workId: string,
  input: RepositoryWorkPlacementChange,
): WorkContract {
  const contract = getWorkContract(store, workId);
  if (!contract) throw new Error(`WORK_PLACEMENT_CONTRACT_NOT_FOUND: ${workId}`);
  return updateWorkContractPlacement(store, workId, {
    ...input,
    executionPlacement: repositoryExecutionPlacement(store, contract.repoId, input.checkoutId),
  });
}
