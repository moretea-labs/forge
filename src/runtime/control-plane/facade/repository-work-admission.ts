import type { AccessMode } from '../governance/access-policy';
import { createWorkContract, executionPlacementForWork, getWorkContract, updateWorkContract, type WorkContractStoreOptions } from '../../../../packages/kernel/work/api/index';
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
  const currentPlacement = executionPlacementForWork(contract);
  return updateWorkContract(store, workId, {
    checkoutId: workspace.checkoutId,
    executionPlacement: executionPlacement({
      ...(currentPlacement.forgeInstanceId ? { forgeInstanceId: currentPlacement.forgeInstanceId } : {}),
      repositoryId: contract.repoId,
      checkoutId: workspace.checkoutId,
    }),
    baseRevision: workspace.baseRevision ?? contract.baseRevision,
    worktreeRef: workspace.root,
  });
}
