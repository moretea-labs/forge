import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { join } from "path";
import { collectRuntimePerformanceDiagnostics } from "../../../src/runtime/diagnostics/performance";
import { mintEngineeringAdmissionEvidence } from "./engineering-preconditions";
import type { CallToolResult } from "../../../packages/protocols/mcp/tool-contract";
import type { MultiRepositoryMcpToolContext } from "../multi-repository";
import { result } from "./result-adapter";
import { selected } from "./shared-adapter";
import { controllerReadinessEvidence, invalidFacadeOperation, repositoryRevisionContains } from "./status-inbox-adapter";
import { freshGitIdentity } from "../../../src/cli/repository/inspector";
import { repositoryCheckoutLifecycle, selectRepositoryCheckout } from "../../../src/cli/repositories/registry";
import { repositoryGitStatus } from "../../../src/cli/repositories/structured-git";
import { DEFAULT_WORK_CHECK_LEASE_WAIT_MS, getProcessRecord, isManagedProcessActive, listProcessRecords, processCheckCompletionReceipt, processRuntimeResourceDiagnostics } from "../../../src/runtime/execution/process-runtime";
import { projectTerminalCheckVerification } from "../../../src/runtime/execution/process-runtime/check-result";
import { listWorkBoundRepositoryProcessEvidence, listWorkBoundRepositoryRemoteEffectProcessEvidence } from "../../../src/runtime/control-plane/execution/work-process-evidence";
import { completeRemoteEffectWorkFromProcessReceipt } from "../../../packages/kernel/work/api/index";
import { readWorkHandle, resolveWorkDeliveryTargetBranch, workDeliveryBaseRevision, type WorkHandleState } from "../../../src/runtime/control-plane/execution/work-handle-store";
import { ensureRepositoryWorkHandle, rebindRepositoryWorkHandleControllerIdentity, reconcileRepositoryWorkHandlePlacement } from "../../../src/runtime/control-plane/execution/work-handle-authority";
import { recoverControllerAuthority } from "../../../src/runtime/control-plane/execution/controller-authority-recovery";
import { reconcileSingleTerminalWorkCleanup, recoverTerminalWorkHandle } from "../../../src/runtime/control-plane/execution/work-terminal-cleanup";
import { commandFingerprint, verificationInputFingerprint, workspaceValidationFingerprint } from "../../../src/runtime/control-plane/execution/verification-evidence";
import { resolveWorkVerificationContext } from "../../../src/runtime/control-plane/execution/work-verification-context";
import { executeWorkVerification, executeWorkVerificationBatch } from "../../../src/runtime/control-plane/execution/work-verification-service";
import { implementationReviewContentFingerprint } from "../../../src/runtime/control-plane/execution/implementation-review-content";
import { implementationReviewCommittedBaseRevision, prepareWorkImplementationReviewCandidate, reconcileDirectCanonicalTargetAdvanceCommand } from "../../../src/runtime/control-plane/execution/work-finalization-service";
import { acceptReviewedDirectEditWorkReconciliation } from "../../../src/runtime/control-plane/execution/direct-edit-work-completion";
import { readForgeRuntimeStatus } from "../../../src/runtime/control-plane/runtime-status-client";
import { ensureControllerDispositionContinuation, repositoryCleanContinuationEventName, triggerWorkContinuationRepositoryEvent } from "../../../src/runtime/workflow/schedules/work-continuation";
import { callRhWorkScheduleAdapter, isRhWorkScheduleOperation } from "./scheduler-adapter";
import { assertAutomatedOperationAllowed } from "../../../src/runtime/control-plane/governance/external-effects";
import { listControllerChecks, readLatestControllerCheckEvidence } from "../../../src/cli/controller/check-runner";
import { finalizeRemoteEffectWorkFromActionReceipt } from "../../../src/runtime/plugins/store";
import { gitSnapshot } from "../../../src/cli/repository/inspector";
import { buildWorkflowWatchdogReport } from "../../../src/runtime/watchdog/workflow-watchdog";
import { applyRuntimeMaintenance, buildRecoveryAuditRecord, buildRuntimeMaintenanceStatus, writeRecoveryAuditRecord, type RecoveryActionDescriptor } from "../../../src/runtime/recovery";
import { callStandaloneRecoveryTool } from "./recovery-client-adapter";
import { callRhWorkControllerOperation } from './work-controller-operations';
import { callRhWorkRequirementOperation } from './work-requirement-operations';
import { callRhWorkPlanCreateOperation, callRhWorkPlanOperation } from './work-plan-operations';
import { runFacadeRepair } from './work-repair-adapter';
export { runFacadeRepair };
import { allowedFacadeOperations, buildFacadeResult, classifyVerificationOutcome, getHandoffItem, runGoalWorkloop, runSelfHealingLoop, delegateToCodexCerebellum, buildWorkContinuationSnapshot, acceptPlanStepEvidence, getPlanContract, withPrimaryWorkAdmissionLockAsync, repairDanglingPlanStepWorkBinding, repairPlanStepForTechnicalRetry, replanActivePlanBoundWorkScope, repairDraftPlanContractAsync, completePlanStepForWork, summarizePlanContract, summarizeWorkContract, verifyGoalWorkloop } from "../../../src/runtime/control-plane/facade";
import { getWorkContract, listWorkContracts, type WorkContract } from "../../../packages/kernel/work/api/index";
import { readExecutionSession, startExecutionSession, updateExecutionSession } from "../../../src/runtime/control-plane/execution/session-store";
import { changedPaths as workChangedPaths, changedPathsFromUnbornBase as workChangedPathsFromUnbornBase } from "../../../src/runtime/control-plane/execution/work-task-receipt";
import { ensureManagedWorkspace } from "../../../src/runtime/execution/managed-workspace";
import { materializeRepositoryWorkPlacement } from "../../../src/runtime/control-plane/facade/repository-work-admission";
import { ensureRunningRepositoryWorkCheckout, reauthorizeRetainedCancelledRepositoryWork } from "../../../src/runtime/control-plane/execution/retained-work-resume";
import { currentPermissionSnapshotVersion } from "../../../src/runtime/control-plane/execution/validation";
import { callExecutionTool } from "./execution-tools";
import { runStandaloneChatgptPrompt } from "../../../src/runtime/control-plane/launcher/chatgpt-work-continuation";
import { controllerRoundBlockerClass, controllerSessionPrincipalId, getControllerSession, getRetainedControllerSession, mintControllerSessionAuthority, releaseObservedControllerSession, resumeControllerSession, withControllerSessionTerminalizationFence, type ControllerTerminalizationAuthority, bindControllerRoundSuccessorWork, reconcileControllerRoundAfterAbandonedRelease, reconcileControllerRoundAfterTerminalWork, getControllerRoundRelay, rearmControllerRoundAfterProviderRecovery, type ControllerRoundRelayRecord } from "../../../packages/kernel/controller/api/index";
import { normalizeRhWorkInputCompatibility } from './work-input-compatibility';
import { callRhWorkWorkflowOperation } from './work-workflow-operations';
import { callRhWorkLearningOperation } from './work-learning-operations';
import {
  assertFacadeControllerRoundAuthority,
  assertSessionlessFacadeControllerAuthority,
  authenticatedFacadeControllerIdentity,
  bindFacadeControllerOwnership,
  currentFacadeTerminalizationAuthority,
  currentTerminalCleanupAuthority,
  dispatchedChatgptRelayAuthorizesStaleControllerRecovery,
  runtimeIdentitySnapshot,
  sessionlessFacadeControllerAuthorityMatches,
} from './controller-authority-adapter';
// Bounded internal compatibility export while remaining runtime-gateway callers migrate to the dedicated owner.
export { runtimeIdentitySnapshot } from './controller-authority-adapter';

export const RH_WORK_VERIFY_LEASE_WAIT_MS = DEFAULT_WORK_CHECK_LEASE_WAIT_MS;

const CONTROLLER_PROVIDER_RECOVERY_CAPABILITY_PREFIX = 'controller.provider.recover:';
const CONTROLLER_PROVIDER_RECOVERY_AUDIT_ACTION: RecoveryActionDescriptor = {
  id: 'recovery.controller_provider_probe',
  title: 'Verify Controller provider recovery',
  description: 'Verify the current ChatGPT provider with a non-semantic probe before rearming one exact blocked ControllerRound.',
  class: 'unknown',
  risk: 'medium',
  confirmation: 'authorization',
  localOnly: false,
  boundedTo: ['controller_round', 'chatgpt_provider'],
};

export interface ControllerProviderRecoveryInput {
  controllerHome: string;
  repoId: string;
  repoRoot: string;
  workId: string;
  relayScopeId: string;
  authorityId: string;
  timeoutMs?: number;
  now?: () => string;
  probe?: typeof runStandaloneChatgptPrompt;
}

export async function recoverControllerRoundAfterVerifiedProviderRepair(input: ControllerProviderRecoveryInput) {
  const store = { controllerHome: input.controllerHome, repoId: input.repoId };
  const workId = input.workId.trim();
  const relayScopeId = input.relayScopeId.trim();
  const authorityId = input.authorityId.trim();
  const blocked = getControllerRoundRelay(store, workId);
  if (!blocked) throw new Error(`CONTROLLER_PROVIDER_RECOVERY_RELAY_REQUIRED: ${workId}`);
  if (blocked.relayScopeId !== relayScopeId) throw new Error(`CONTROLLER_PROVIDER_RECOVERY_SCOPE_MISMATCH: ${workId}`);
  if ((blocked.authorityId?.trim() || '') !== authorityId) throw new Error(`CONTROLLER_PROVIDER_RECOVERY_AUTHORITY_MISMATCH: ${workId}`);
  if (controllerRoundBlockerClass(blocked) !== 'consecutive_failures') throw new Error(`CONTROLLER_PROVIDER_RECOVERY_BLOCKER_MISMATCH: ${workId}`);
  if (getControllerSession(store, workId)) throw new Error(`CONTROLLER_PROVIDER_RECOVERY_ACTIVE_CLAIM: ${workId}`);

  const probe = input.probe ?? runStandaloneChatgptPrompt;
  const nonce = randomUUID();
  const result = await probe({
    controllerHome: input.controllerHome,
    repoId: input.repoId,
    repoRoot: input.repoRoot,
    scopeId: `controller-provider-recovery:${workId}:${authorityId}`,
    prompt: `Forge provider recovery probe ${nonce}. Reply with ACK only. Do not invoke tools or modify external state.`,
    tabPolicy: 'new',
    timeoutMs: input.timeoutMs ?? 60_000,
  });
  if (result.status !== 'dispatched' || result.providerDeliveryStatus !== 'dispatch_confirmed') {
    const code = result.error?.code ?? `CHATGPT_PROVIDER_${result.providerDeliveryStatus?.toUpperCase() ?? 'PROBE_FAILED'}`;
    throw new Error(`CONTROLLER_PROVIDER_RECOVERY_PROBE_FAILED: ${code}: ${result.error?.message ?? result.status}`);
  }

  const verifiedAt = input.now?.() ?? new Date().toISOString();
  if (Date.parse(verifiedAt) <= Date.parse(blocked.updatedAt)) {
    throw new Error(`CONTROLLER_PROVIDER_RECOVERY_EVIDENCE_NOT_FRESH: ${workId}`);
  }
  const audit = writeRecoveryAuditRecord(
    input.controllerHome,
    input.repoId,
    buildRecoveryAuditRecord({
      actor: 'rh_work.controller_provider_recovery',
      action: CONTROLLER_PROVIDER_RECOVERY_AUDIT_ACTION,
      result: 'succeeded',
      reason: `Verified provider recovery for exact ControllerRound ${workId}.`,
      evidence: [{
        source: 'chatgpt_provider_recovery_probe',
        message: 'ChatGPT provider dispatch was confirmed by a non-semantic recovery probe.',
        at: verifiedAt,
        details: {
          workId,
          relayScopeId,
          controllerAuthorityId: authorityId,
          blockedUpdatedAt: blocked.updatedAt,
          provider: result.provider,
          providerDeliveryStatus: result.providerDeliveryStatus,
          browserSessionId: result.browserSessionId,
          executionPreferenceVerified: result.executionPreferenceVerified,
        },
      }],
      at: verifiedAt,
    }),
  );
  const relay = rearmControllerRoundAfterProviderRecovery(store, {
    workId,
    relayScopeId,
    authorityId,
    expectedUpdatedAt: blocked.updatedAt,
    evidenceId: audit.id,
  });
  return { relay, audit, probe: result };
}

export function contextRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function contextText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function ensureFacadeWorkHandle(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  workId: string,
  args: Record<string, unknown>,
): WorkHandleState | undefined {
  const identity = authenticatedFacadeControllerIdentity(ctx, args);
  return ensureRepositoryWorkHandle({
    controllerHome: ctx.controllerHome,
    repository,
    workId,
    identity: { sessionId: identity.sessionId, principalId: identity.principalId },
  });
}

export function materializeFacadeWorkPlacement(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  workId: string,
  args: Record<string, unknown>,
) {
  return materializeRepositoryWorkPlacement(
    { controllerHome: ctx.controllerHome, repoId: repository.repoId },
    workId,
    (contract) => {
      const workspace = ensureManagedWorkspace(ctx.controllerHome, repository, {
        requestId: workId,
        title: contract.objective,
        baseRef: contract.baseRevision,
        prepareDependencies: args.needs_dependencies === true,
      });
      if (workspace.checkoutId === repository.activeCheckoutId) {
        throw new Error('MANAGED_WORKSPACE_NOT_MATERIALIZED');
      }
      return workspace;
    },
  );
}

export function claimNewFacadeWork(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  workId: string,
  args: Record<string, unknown>,
) {
  const identity = authenticatedFacadeControllerIdentity(ctx, args);
  const authority = mintControllerSessionAuthority();
  const session = resumeControllerSession({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, {
    workId,
    controllerId: identity.controllerId,
    controllerType: identity.controllerType,
    sessionId: identity.sessionId,
    authorityDigest: authority.authorityDigest,
    principalId: identity.principalId,
    controllerInstanceId: identity.controllerInstanceId,
    leaseMs: typeof args.lease_ms === 'number' ? args.lease_ms : undefined,
  });
  return { session, controllerAuthorityId: authority.authorityId };
}

export function bindFacadeExecutionSession(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  handle: WorkHandleState,
  args: Record<string, unknown>,
) {
  const identity = authenticatedFacadeControllerIdentity(ctx, args);
  const session = startExecutionSession(ctx.controllerHome, {
    sessionId: identity.sessionId,
    principalId: identity.principalId,
    controllerInstanceId: identity.controllerInstanceId,
    permissionSnapshotVersion: handle.permissionSnapshotVersion,
  });
  return updateExecutionSession(ctx.controllerHome, {
    sessionId: session.sessionId,
    principalId: session.principalId,
    controllerInstanceId: session.controllerInstanceId,
  }, {
    activeRepositoryId: repository.repoId,
    activeCheckoutId: handle.checkoutId,
    activeWorkId: handle.workId,
    permissionSnapshotVersion: handle.permissionSnapshotVersion,
    lastValidatedAt: new Date().toISOString(),
  });
}

export async function finalizeFacadeWorkHandle(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  args: Record<string, unknown>,
  operation: 'finalize' | 'stop',
): Promise<CallToolResult | undefined> {
  const workId = String(args.work_id ?? '').trim();
  if (!workId) return undefined;
  let handle = readWorkHandle(ctx.controllerHome, repository.repoId, workId)
    ?? recoverTerminalWorkHandle(ctx.controllerHome, repository.repoId, workId);
  if (!handle) return undefined;
  const session = bindFacadeExecutionSession(ctx, repository, handle, args);
  const explicitTargetBranch = typeof args.target_branch === 'string' && args.target_branch.trim()
    ? args.target_branch.trim()
    : undefined;
  const targetBranch = resolveWorkDeliveryTargetBranch(handle, repository.defaultBranch, explicitTargetBranch);
  const common = {
    session_id: session.sessionId,
    repo_id: repository.repoId,
    work_id: workId,
    target_branch: targetBranch,
    delete_branch: args.delete_branch !== false,
    cleanup: args.cleanup !== false,
  };

  if (operation === 'stop') {
    return callExecutionTool(ctx, 'work_finalize', {
      ...common,
      commit: false,
      merge: false,
    });
  }

  const handleCheckoutId = handle.checkoutId;
  const registeredCheckout = repository.checkouts.find((candidate) => candidate.checkoutId === handleCheckoutId);
  const registeredLifecycle = registeredCheckout ? repositoryCheckoutLifecycle(registeredCheckout) : undefined;
  const checkoutUnavailable = !registeredCheckout || (registeredLifecycle !== 'active' && registeredLifecycle !== 'archived');
  if (checkoutUnavailable) {
    const exactChangedHead = Boolean(handle.managedWorktree
      && handle.expectedHead
      && handle.baseCommit
      && handle.expectedHead !== handle.baseCommit);
    const retainedNoChangeRecovery = args.completion_outcome === 'completed_no_change'
      && handle.managedWorktree
      && handle.finalization.validation === 'done'
      && handle.finalization.worktreeCleanup === 'done'
      && Boolean(handle.validatedInputFingerprint)
      && (handle.state === 'merged' || handle.state === 'cleaned');
    if ((!exactChangedHead && !retainedNoChangeRecovery) || args.cleanup === false) {
      throw new Error(`WORK_FINALIZATION_CHECKOUT_UNAVAILABLE: ${repository.repoId}/${handle.checkoutId ?? 'unknown'} is ${registeredLifecycle ?? 'unregistered'}`);
    }
    if (retainedNoChangeRecovery) {
      const noChangeEvidence = typeof args.no_change_evidence === 'string' && args.no_change_evidence.trim()
        ? args.no_change_evidence.trim()
        : `Retained exact validation proves Work ${workId} has no repository delta after managed-worktree cleanup.`;
      return callExecutionTool(ctx, 'work_finalize', {
        ...common,
        commit: false,
        merge: false,
        completion_outcome: 'completed_no_change',
        no_change_evidence: noChangeEvidence,
      });
    }
    // Physical cleanup can succeed before the Work completion receipt is
    // persisted. Re-enter the canonical finalizer only after structural registry
    // evidence proves this exact checkout is no longer selectable. No human-
    // readable error message participates in lifecycle authority.
    return callExecutionTool(ctx, 'work_finalize', {
      ...common,
      commit: false,
      merge: false,
      completion_outcome: 'completed_changed',
    });
  }
  const worktree: ReturnType<typeof selectRepositoryCheckout> = selectRepositoryCheckout(repository, handle.checkoutId, { allowArchived: true });
  const status = repositoryGitStatus(worktree);
  const head = status.head ?? handle.expectedHead ?? handle.baseCommit;
  const committedDelta = Boolean(head && handle.baseCommit && head !== handle.baseCommit);
  const requestedCommit = typeof args.commit === 'boolean' ? args.commit : !status.clean;
  // A clean checkout whose HEAD already differs from base is already committed.
  // Treat commit=true as satisfied by that exact candidate instead of trying to
  // manufacture an empty commit and recording GIT_NOTHING_STAGED as a delivery
  // failure. The candidate is still adopted/revalidated and merge-fenced below.
  const commit = status.clean && committedDelta ? false : requestedCommit;
  if (
    status.clean
    && committedDelta
    && commit === false
    && head
    && handle.expectedHead
    && head !== handle.expectedHead
    && (handle.state === 'prepared' || handle.state === 'editing')
  ) {
    // A clean committed successor must enter through the single audited adoption
    // authority before finalization, even when allowedPaths/forbiddenPaths are
    // empty. Empty allowedPaths is repository-scoped authority; work_prepare still
    // fences ancestry, checkout, branch, ownership, cleanliness, and any declared
    // path restrictions before advancing expectedHead.
    const adopted = await callExecutionTool(ctx, 'work_prepare', {
      session_id: session.sessionId,
      repo_id: repository.repoId,
      checkout_id: handle.checkoutId,
      work_id: workId,
      expected_previous_head: handle.expectedHead,
      adopt_candidate_head: head,
    });
    if (!adopted || adopted.isError === true) return adopted;
    handle = readWorkHandle(ctx.controllerHome, repository.repoId, workId) ?? handle;
  }
  const requestedOutcome = args.completion_outcome === 'completed_no_change' || args.completion_outcome === 'completed_changed'
    ? args.completion_outcome
    : undefined;
  const completionOutcome = requestedOutcome ?? (!commit && !committedDelta && status.clean ? 'completed_no_change' : 'completed_changed');
  // A proven no-change completion has nothing to merge. Defaulting merge=true
  // forced the generic Git delivery path to do unnecessary work and conflicted
  // with work_finalize's explicit no-change contract.
  const merge = typeof args.merge === 'boolean' ? args.merge : completionOutcome !== 'completed_no_change';
  const explicitNoChangeEvidence = typeof args.no_change_evidence === 'string' ? args.no_change_evidence.trim() : '';
  const noChangeEvidence = completionOutcome === 'completed_no_change'
    ? explicitNoChangeEvidence || `Validated Work ${workId} has no repository delta from base ${handle.baseCommit ?? 'unknown'} at clean HEAD ${head ?? 'unknown'}.`
    : undefined;
  const finalizeArgs = {
    ...common,
    commit,
    merge,
    no_ff: args.no_ff === true,
    remote_write: args.remote_write === true,
    completion_outcome: completionOutcome,
    ...(noChangeEvidence ? { no_change_evidence: noChangeEvidence } : {}),
  };

  const validateExactWorkspace = async (): Promise<CallToolResult | undefined> => {
    const contract = getWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, workId);
    const validation = await callExecutionTool(ctx, 'work_validate', {
      session_id: session.sessionId,
      repo_id: repository.repoId,
      work_id: workId,
      check_ids: contract?.checks ?? [],
    });
    if (!validation || validation.isError === true) return validation;
    const validationPayload = contextRecord(validation.structuredContent);
    return contextRecord(validationPayload.validation).passed === true ? undefined : validation;
  };

  let physical = await callExecutionTool(ctx, 'work_finalize', finalizeArgs);
  let payload = contextRecord(physical?.structuredContent);
  if (physical?.isError === true && contextRecord(payload.error).code === 'WORK_VALIDATION_REQUIRED') {
    const validationFailure = await validateExactWorkspace();
    if (validationFailure) return validationFailure;
    physical = await callExecutionTool(ctx, 'work_finalize', finalizeArgs);
    payload = contextRecord(physical?.structuredContent);
  }
  if (
    physical
    && physical.isError !== true
    && typeof payload.continuation === 'string'
    && payload.continuation.startsWith('WORK_COMMITTED_REVALIDATION_REQUIRED')
  ) {
    const validationFailure = await validateExactWorkspace();
    if (validationFailure) return validationFailure;
    physical = await callExecutionTool(ctx, 'work_finalize', finalizeArgs);
  }
  return physical;
}

export function repositoryWorkHandleHasSourceDelta(
  repository: ReturnType<typeof selected>,
  handle: WorkHandleState,
): boolean {
  try {
    const checkout = selectRepositoryCheckout(repository, handle.checkoutId, { allowArchived: true });
    const status = repositoryGitStatus(checkout);
    const head = status.head ?? handle.expectedHead ?? handle.baseCommit;
    return !status.clean || Boolean(head && handle.baseCommit && head !== handle.baseCommit);
  } catch (_error) {
    // A checkout may already have been removed by an earlier bounded cleanup
    // attempt. The WorkHandle's fenced expectedHead remains authoritative for
    // whether repository delivery existed and must not be downgraded to an
    // effect-only semantic completion.
    return Boolean(handle.expectedHead && handle.baseCommit && handle.expectedHead !== handle.baseCommit);
  }
}

export function finalizeRemoteEffectWorkFromRepositoryProcessReceipt(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  workId: string,
  checkoutId: string,
) {
  const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
  const evidence = listWorkBoundRepositoryRemoteEffectProcessEvidence({
    controllerHome: ctx.controllerHome,
    repoId: repository.repoId,
    checkoutId,
    workId,
  })[0];
  if (!evidence) return undefined;
  return completeRemoteEffectWorkFromProcessReceipt(store, workId, {
    processId: evidence.processId,
    actionId: evidence.actionId,
    requestId: evidence.requestId,
    semanticKey: evidence.semanticKey,
    resultDigest: evidence.resultDigest,
    recordedAt: evidence.finishedAt ?? new Date().toISOString(),
  });
}

export function reconcileTerminalFacadeWorkVerifications(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  workId: string,
): { sourceRevision?: string; workspaceFingerprint?: string; implementationReviewWorkspaceFingerprint?: string; workspaceChangedPaths?: string[]; reconciledProcessIds: string[]; workBoundProcessEvidenceIds: string[] } {
  const resolvedVerification = resolveWorkVerificationContext({ controllerHome: ctx.controllerHome, repository, workId });
  if (!resolvedVerification.ok) return { reconciledProcessIds: [], workBoundProcessEvidenceIds: [] };
  const { store, workContract, repository: verificationRepository, checks: availableChecks } = resolvedVerification.context;
  if (!workContract || workContract.completionReceipt) return { reconciledProcessIds: [], workBoundProcessEvidenceIds: [] };
  const verificationStatus = repositoryGitStatus(verificationRepository);
  const sourceRevision = verificationStatus.head ?? undefined;
  if (!sourceRevision) return { reconciledProcessIds: [], workBoundProcessEvidenceIds: [] };
  let verificationHandle = readWorkHandle(ctx.controllerHome, repository.repoId, workId);
  const workspaceFingerprint = workspaceValidationFingerprint(verificationRepository.canonicalRoot, verificationStatus);
  // Work-bound repository Process evidence remains semantic/result evidence,
  // never a typed check receipt. repository_change may use it only when no
  // checks are declared. local_effect may bind the same exact durable Process
  // ids for Controller semantic review even when checks are declared; the
  // normal missing-check gate below still requires typed verification receipts.
  const workBoundProcessEvidenceIds = (
    workContract.workKind === 'local_effect'
    || (workContract.workKind === 'repository_change' && workContract.checks.length === 0)
  )
    ? listWorkBoundRepositoryProcessEvidence({
        controllerHome: ctx.controllerHome,
        repoId: repository.repoId,
        checkoutId: verificationRepository.activeCheckoutId,
        workId,
      }).map((evidence) => evidence.processId)
    : [];
  const workloopCtx = {
    workStore: store,
    handoffStore: store,
    repoId: repository.repoId,
    availableChecks,
  };
  const seenChecks = new Set<string>();
  const reconciledProcessIds: string[] = [];
  const candidates = listProcessRecords(ctx.controllerHome, repository.repoId, 500)
    .filter((record) => (
      record.workId === workId
      && record.checkoutId === verificationRepository.activeCheckoutId
      && !isManagedProcessActive(record)
      && record.origin?.workVerificationSnapshot === true
      && typeof record.origin?.checkId === 'string'
      && typeof record.origin?.requestSemanticFingerprint === 'string'
    ));

  for (const record of candidates) {
    const checkId = record.origin?.checkId?.trim() ?? '';
    if (!checkId || seenChecks.has(checkId)) continue;
    seenChecks.add(checkId);
    const classified = classifyVerificationOutcome({ checkId, available: availableChecks });
    if (classified.outcome === 'invalid_check_id' || !classified.normalizedCheckId) continue;
    const normalizedCheckId = classified.normalizedCheckId;
    const requestedChecks = workContract.checks.length ? workContract.checks : [normalizedCheckId];
    const currentFingerprint = verificationInputFingerprint({
      sourceRevision,
      workspaceFingerprint,
      checkId: normalizedCheckId,
      requestedChecks,
    });
    if (record.origin?.requestSemanticFingerprint !== currentFingerprint || !record.checkExecution) continue;

    try {
      const receipt = processCheckCompletionReceipt(record, {
        repoId: verificationRepository.repoId,
        checkoutId: verificationRepository.activeCheckoutId,
        workId,
        checkId: normalizedCheckId,
        processId: record.processId,
        requestId: record.origin?.requestId,
        checkExecution: {
          cacheKey: record.checkExecution.cacheKey,
          revision: record.checkExecution.revision,
          definitionDigest: record.checkExecution.definitionDigest,
          environmentFingerprint: record.checkExecution.environmentFingerprint,
          timeoutMs: record.checkExecution.timeoutMs,
          scopeKey: record.checkExecution.scopeKey,
        },
      });
      const latestContract = getWorkContract(store, workId);
      if (latestContract?.checkRefs.some((entry) => entry.receipt?.receiptId === receipt.receiptId)) continue;

      const legacyEvidence = record.origin?.checkResultReceiptPath
        ? undefined
        : readLatestControllerCheckEvidence(verificationRepository.canonicalRoot, normalizedCheckId);
      const projection = projectTerminalCheckVerification(record, normalizedCheckId, receipt, { legacyEvidence });
      const infrastructureFailed = projection.isInfrastructureIssue;
      const checkFailed = projection.isAcceptanceFailure;
      verifyGoalWorkloop(workloopCtx, {
        workId,
        checkId: normalizedCheckId,
        sourceRevision,
        workspaceFingerprint,
        verificationInputFingerprint: currentFingerprint,
        commandFingerprint: commandFingerprint(normalizedCheckId, receipt.commandId),
        receipt,
        infrastructureFailed,
        checkFailed,
      });
      reconciledProcessIds.push(record.processId);
    } catch {
      // Exact receipt/process identity is mandatory. Any malformed, stale, or
      // mismatched terminal Process remains non-authoritative and is ignored.
    }
  }

  let deliveryBaseRevision = verificationHandle
    ? workDeliveryBaseRevision(verificationHandle)
    : workContract.baseRevision;
  const latestContract = getWorkContract(store, workId) ?? workContract;
  if (latestContract.phase === 'review' && verificationHandle && !verificationHandle.managedWorktree && verificationHandle.expectedHead) {
    const targetBranch = resolveWorkDeliveryTargetBranch(verificationHandle, verificationRepository.defaultBranch);
    const reconciliation = reconcileDirectCanonicalTargetAdvanceCommand({
      controllerHome: ctx.controllerHome,
      repoId: repository.repoId,
      workId,
      handle: verificationHandle,
      root: verificationRepository.canonicalRoot,
      targetBranch,
      status: verificationStatus,
      scope: { allowedPaths: latestContract.allowedPaths, forbiddenPaths: latestContract.forbiddenPaths },
      checkIds: latestContract.checks,
      checkRefs: latestContract.checkRefs,
      evidenceTitle: 'review target advancement reconciled',
    });
    if (reconciliation.reconciled) {
      verificationHandle = reconciliation.handle;
      deliveryBaseRevision = workDeliveryBaseRevision(verificationHandle);
    }
  }

  deliveryBaseRevision = verificationHandle
    ? implementationReviewCommittedBaseRevision(
        verificationRepository,
        verificationHandle,
        workContract.baseRevision,
        sourceRevision,
      )
    : workContract.baseRevision;
  const committedPaths = deliveryBaseRevision
    ? workChangedPaths(verificationRepository.canonicalRoot, deliveryBaseRevision, sourceRevision)
    : workContract.repositoryBaseState === 'unborn'
      ? workChangedPathsFromUnbornBase(verificationRepository.canonicalRoot, sourceRevision)
      : [];
  const workspaceChangedPaths = [...new Set([
    ...committedPaths,
    ...verificationStatus.staged,
    ...verificationStatus.unstaged,
    ...verificationStatus.untracked,
  ])].sort();
  const implementationReviewWorkspaceFingerprint = implementationReviewContentFingerprint(
    verificationRepository.canonicalRoot,
    workspaceChangedPaths,
  );

  return { sourceRevision, workspaceFingerprint, implementationReviewWorkspaceFingerprint, workspaceChangedPaths, reconciledProcessIds, workBoundProcessEvidenceIds };
}

export async function runFacadeVerify(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const workId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
  const checkId = String(args.check_id ?? args.checkId ?? '').trim();
  const hasBatchInput = Object.prototype.hasOwnProperty.call(args, 'check_ids');
  if (checkId && hasBatchInput) {
    const blocked = buildFacadeResult({
      status: 'blocked',
      summary: 'rh_work verify accepts either check_id or check_ids, not both.',
      data: { workId: workId || undefined, verificationStarted: false },
      warnings: ['WORK_VERIFY_CHECK_INPUT_CONFLICT'],
    });
    return result(blocked as unknown as Record<string, unknown>, true);
  }
  if (hasBatchInput && !Array.isArray(args.check_ids)) {
    const blocked = buildFacadeResult({
      status: 'blocked',
      summary: 'rh_work verify check_ids must be an array.',
      data: { workId: workId || undefined, verificationStarted: false },
      warnings: ['WORK_VERIFY_CHECK_IDS_INVALID'],
    });
    return result(blocked as unknown as Record<string, unknown>, true);
  }
  const commonVerificationInput = {
    controllerHome: ctx.controllerHome,
    repository,
    workId: workId || undefined,
    requestId: typeof args.request_id === 'string' && args.request_id.trim() ? args.request_id.trim() : undefined,
    timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
    interactiveWaitMs: 0,
    leaseWaitMs: RH_WORK_VERIFY_LEASE_WAIT_MS,
    simulate: args.simulate_check === true || args.infrastructure_failed === true || args.check_failed === true || args.skipped === true
      ? {
          infrastructureFailed: args.infrastructure_failed === true,
          checkFailed: args.check_failed === true,
          skipped: args.skipped === true,
        }
      : undefined,
    allowDurableCheckExecution: workId ? ({ work }: { work: WorkContract }) => {
      try {
        const identity = authenticatedFacadeControllerIdentity(ctx, args);
        const owner = getControllerSession({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, work.workId);
        if (!sessionlessFacadeControllerAuthorityMatches(owner, identity)) return false;
        return Boolean(
          owner
          && owner.controllerId === identity.controllerId
          && controllerSessionPrincipalId(owner) === identity.principalId
          && owner.controllerInstanceId === identity.controllerInstanceId,
        );
      } catch {
        return false;
      }
    } : undefined,
  };
  const verification = hasBatchInput
    ? await executeWorkVerificationBatch({
        ...commonVerificationInput,
        checkIds: (args.check_ids as unknown[]).map(String),
      })
    : await executeWorkVerification({ ...commonVerificationInput, checkId });
  return result(verification.facade as unknown as Record<string, unknown>, verification.isError);
}

/** MCP rh_work transport adapter. Canonical lifecycle semantics remain in Kernel/application services; this layer normalizes ABI input and orchestrates those services. */
export async function callWorkAdapter(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>): Promise<CallToolResult> {
  {
          const repository = selected(ctx, args);
          const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
          const compatibility = normalizeRhWorkInputCompatibility(args);
          if (!compatibility.ok) {
            return result(buildFacadeResult({
              status: 'blocked',
              summary: compatibility.summary,
              data: compatibility.data,
            }) as unknown as Record<string, unknown>, true);
          }
          args = compatibility.args;
          const operation = compatibility.operation;
          const frozenScheduleDeleteId = compatibility.scheduleIdOverride ?? '';
          if (!allowedFacadeOperations('rh_work').includes(operation)) {
            return invalidFacadeOperation('rh_work', operation);
          }
          if (isRhWorkScheduleOperation(operation)) {
            return await callRhWorkScheduleAdapter(ctx, repository, operation, args, {
              scheduleIdOverride: frozenScheduleDeleteId || undefined,
            });
          }
          const technicalRetryWorkId = operation === 'repair' && typeof args.capability_id === 'string' && args.capability_id.startsWith('plan.step.retry:')
            ? args.capability_id.slice('plan.step.retry:'.length).trim()
            : '';
          if (technicalRetryWorkId) {
            const explicitWorkId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
            if (!explicitWorkId || explicitWorkId !== technicalRetryWorkId) {
              return result(buildFacadeResult({
                status: 'blocked',
                summary: `PLAN_STEP_TECHNICAL_RETRY_SCOPE_MISMATCH: capability targets ${technicalRetryWorkId}; exact work_id is required.`,
                data: { workId: technicalRetryWorkId, repaired: false },
              }) as unknown as Record<string, unknown>, true);
            }
            try {
              const work = getWorkContract(store, technicalRetryWorkId);
              if (!work) throw new Error(`PLAN_STEP_TECHNICAL_RETRY_WORK_NOT_FOUND: ${technicalRetryWorkId}`);
              const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
              if (!reason) throw new Error('PLAN_STEP_TECHNICAL_RETRY_REASON_REQUIRED');
              const handle = readWorkHandle(ctx.controllerHome, repository.repoId, technicalRetryWorkId);
              const cleanupComplete = Boolean(handle
                && handle.managedWorktree
                && handle.state === 'cleaned'
                && handle.finalization.branchCleanup === 'done'
                && handle.finalization.worktreeCleanup === 'done'
                && handle.cleanupReceipt?.complete === true
                && handle.baseCommit
                && handle.expectedHead === handle.baseCommit
                && !existsSync(handle.worktreePath));
              if (!cleanupComplete) throw new Error(`PLAN_STEP_TECHNICAL_RETRY_CLEANUP_INCOMPLETE: ${technicalRetryWorkId}`);
              const conflicting = work.planId && work.planStepId
                ? listWorkContracts({ ...store, status: 'active', limit: 200 }).filter((candidate) => candidate.planId === work.planId && candidate.planStepId === work.planStepId)
                : [];
              if (conflicting.length > 0) throw new Error(`PLAN_STEP_TECHNICAL_RETRY_ACTIVE_WORK_CONFLICT: ${conflicting.map((candidate) => candidate.workId).join(',')}`);
              const repairedPlan = repairPlanStepForTechnicalRetry(store, { work, cleanupComplete, reason });
              return result(buildFacadeResult({
                summary: `Plan step ${work.planId}/${work.planStepId} was restored for an explicit technical retry after terminal Work ${work.workId}; no Work was revived or created.`,
                data: { workId: work.workId, plan: summarizePlanContract(repairedPlan), repaired: true, replacementWorkCreated: false },
              }) as unknown as Record<string, unknown>);
            } catch (error) {
              return result(buildFacadeResult({
                status: 'blocked',
                summary: error instanceof Error ? error.message : 'PLAN_STEP_TECHNICAL_RETRY_FAILED',
                data: { workId: technicalRetryWorkId, repaired: false },
              }) as unknown as Record<string, unknown>, true);
            }
          }
  
          const providerRecoveryWorkId = operation === 'repair' && typeof args.capability_id === 'string' && args.capability_id.startsWith(CONTROLLER_PROVIDER_RECOVERY_CAPABILITY_PREFIX)
            ? args.capability_id.slice(CONTROLLER_PROVIDER_RECOVERY_CAPABILITY_PREFIX.length).trim()
            : '';
          if (providerRecoveryWorkId) {
            const explicitWorkId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
            const relayScopeId = typeof args.relay_scope_id === 'string' ? args.relay_scope_id.trim() : '';
            const authorityId = typeof args.controller_authority_id === 'string' ? args.controller_authority_id.trim() : '';
            if (!explicitWorkId || explicitWorkId !== providerRecoveryWorkId) {
              return result(buildFacadeResult({
                status: 'blocked',
                summary: `CONTROLLER_PROVIDER_RECOVERY_SCOPE_MISMATCH: capability targets ${providerRecoveryWorkId}; exact work_id is required.`,
                data: { workId: providerRecoveryWorkId, providerRecovered: false },
              }) as unknown as Record<string, unknown>, true);
            }
            if (!relayScopeId || !authorityId) {
              return result(buildFacadeResult({
                status: 'blocked',
                summary: 'CONTROLLER_PROVIDER_RECOVERY_AUTHORITY_REQUIRED: exact controller_authority_id and relay_scope_id are required.',
                data: { workId: providerRecoveryWorkId, providerRecovered: false },
              }) as unknown as Record<string, unknown>, true);
            }
            try {
              const recovered = await recoverControllerRoundAfterVerifiedProviderRepair({
                controllerHome: ctx.controllerHome,
                repoId: repository.repoId,
                repoRoot: repository.canonicalRoot,
                workId: providerRecoveryWorkId,
                relayScopeId,
                authorityId,
                timeoutMs: typeof args.probe_timeout_ms === 'number' ? args.probe_timeout_ms : undefined,
              });
              return result(buildFacadeResult({
                summary: `Verified ChatGPT provider recovery and rearmed exact ControllerRound for Work ${providerRecoveryWorkId} without changing semantic round identity or recovery budgets.`,
                data: {
                  workId: providerRecoveryWorkId,
                  providerRecovered: true,
                  recoveryAuditId: recovered.audit.id,
                  provider: recovered.probe.provider,
                  relay: recovered.relay,
                },
              }) as unknown as Record<string, unknown>);
            } catch (error) {
              return result(buildFacadeResult({
                status: 'blocked',
                summary: error instanceof Error ? error.message : 'Controller provider recovery failed.',
                data: { workId: providerRecoveryWorkId, providerRecovered: false },
              }) as unknown as Record<string, unknown>, true);
            }
          }

          const authorityRecoveryWorkId = operation === 'repair' && typeof args.capability_id === 'string' && args.capability_id.startsWith('controller.authority.recover:')
            ? args.capability_id.slice('controller.authority.recover:'.length).trim()
            : '';
          if (authorityRecoveryWorkId) {
            const explicitWorkId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
            if (!explicitWorkId || explicitWorkId !== authorityRecoveryWorkId) {
              return result(buildFacadeResult({
                status: 'blocked',
                summary: `WORK_CONTROLLER_AUTHORITY_RECOVERY_SCOPE_MISMATCH: capability targets ${authorityRecoveryWorkId}; exact work_id is required.`,
                data: { workId: authorityRecoveryWorkId, authorityRecovered: false },
              }) as unknown as Record<string, unknown>, true);
            }
            try {
              const recovered = recoverControllerAuthority({
                controllerHome: ctx.controllerHome,
                repoId: repository.repoId,
                repositoryActiveCheckoutId: repository.activeCheckoutId,
                workId: authorityRecoveryWorkId,
                requestedBy: typeof args.requested_by === 'string' ? args.requested_by : undefined,
                identity: authenticatedFacadeControllerIdentity(ctx, args, { allowTransportSessionRollover: true }),
                runtime: runtimeIdentitySnapshot(ctx),
                leaseMs: typeof args.lease_ms === 'number' ? args.lease_ms : undefined,
              });
              return result(buildFacadeResult({
                summary: `Controller authority for exact Work ${authorityRecoveryWorkId} was recovered without changing semantic Work identity, relay scope, or recovery budgets.`,
                data: recovered,
              }) as unknown as Record<string, unknown>);
            } catch (error) {
              return result(buildFacadeResult({
                status: 'blocked',
                summary: error instanceof Error ? error.message : 'Controller authority recovery failed.',
                data: { workId: authorityRecoveryWorkId, authorityRecovered: false },
              }) as unknown as Record<string, unknown>, true);
            }
          }
  
          const workflowOperationResult = await callRhWorkWorkflowOperation(ctx, repository, operation, args);
          if (workflowOperationResult) return workflowOperationResult;
  
          const learningOperationResult = callRhWorkLearningOperation(ctx, repository, operation, args);
          if (learningOperationResult) return learningOperationResult;
  
          const controllerOperationResult = await callRhWorkControllerOperation(ctx, repository, operation, args);
          if (controllerOperationResult) return controllerOperationResult;
          const requirementOperationArgs = compatibility.requirementOperationArgs ?? args;
          const requirementOperationResult = await callRhWorkRequirementOperation(ctx, operation, requirementOperationArgs);
          if (requirementOperationResult) return requirementOperationResult;
          const planOperationResult = await callRhWorkPlanOperation(store, operation, args);
          if (planOperationResult) return planOperationResult;
  
          const checks = listControllerChecks(repository.canonicalRoot);
          const workloopSource = freshGitIdentity(repository.canonicalRoot);
          const workloopStatus = repositoryGitStatus(repository);
          const workloopChangedPaths = [...new Set([
            ...workloopStatus.staged,
            ...workloopStatus.unstaged,
            ...workloopStatus.untracked,
          ])].sort();
          const workloopCtx = {
            workStore: store,
            handoffStore: store,
            planStore: store,
            repoId: repository.repoId,
            checkoutId: repository.activeCheckoutId,
            principalId: ctx.principalId,
            controllerInstanceId: ctx.controllerInstanceId,
            availableChecks: checks,
            sourceRevision: workloopSource.head ?? undefined,
            sourceBaseState: workloopSource.head ? 'revision' as const : 'unborn' as const,
            workspaceDirty: !workloopStatus.clean,
            workspaceChangedPaths: workloopChangedPaths,
            materializeIsolatedWorkspace: ({ workId, title, baseRef, needsDependencies }: { workId: string; title: string; baseRef?: string; needsDependencies?: boolean }) => {
              const workspace = ensureManagedWorkspace(ctx.controllerHome, repository, {
                requestId: workId,
                title,
                baseRef,
                prepareDependencies: needsDependencies === true,
              });
              if (!workspace.managed || !workspace.checkoutId || !workspace.root) throw new Error('MANAGED_WORKSPACE_NOT_MATERIALIZED');
              return { checkoutId: workspace.checkoutId, root: workspace.root, baseRevision: workspace.baseRevision, managed: true as const };
            },
          };
  
          const planCreateOperationResult = await callRhWorkPlanCreateOperation(store, operation, args, {
            controllerHome: ctx.controllerHome,
            repoId: repository.repoId,
            checks,
          });
          if (planCreateOperationResult) return planCreateOperationResult;

          if (operation.startsWith('plan_')) {
            try {
              if (operation === 'plan_accept_step') {
                const identity = authenticatedFacadeControllerIdentity(ctx, args);
                const planId = String(args.plan_id ?? '').trim();
                const stepId = String(args.plan_step_id ?? '').trim();
                const rationale = String(args.acceptance_rationale ?? '').trim();
                const before = getPlanContract(store, planId);
                const beforeStep = before?.steps.find((candidate) => candidate.id === stepId);
                const predecessorWorkId = beforeStep?.workId?.trim();
                const predecessorWork = predecessorWorkId ? getWorkContract(store, predecessorWorkId) : undefined;
                const claimedRelay = predecessorWorkId ? getControllerRoundRelay(store, predecessorWorkId) : undefined;
                const currentOwner = predecessorWorkId ? getControllerSession(store, predecessorWorkId) : undefined;
                const claimedTerminalRound = Boolean(
                  predecessorWork
                  && predecessorWork.status === 'completed'
                  && claimedRelay?.status === 'claimed'
                );
                if (claimedTerminalRound && predecessorWorkId) {
                  // Semantic acceptance may occur after MCP/Runtime replacement or
                  // physical Work-lease release, but a still-open terminal round is
                  // fenced by its exact opaque capability. Never reclaim the Work.
                  assertFacadeControllerRoundAuthority(ctx, store, predecessorWorkId, args);
                  if (currentOwner) {
                    if (currentOwner.controllerType !== identity.controllerType) throw new Error(`CONTROLLER_RELAY_CONTROLLER_TYPE_MISMATCH: ${predecessorWorkId}`);
                    if (currentOwner.controllerId !== identity.controllerId) throw new Error(`WORK_CONTROLLER_OWNER_MISMATCH: ${predecessorWorkId}`);
                    if (controllerSessionPrincipalId(currentOwner) !== identity.principalId) throw new Error(`WORK_CONTROLLER_PRINCIPAL_MISMATCH: ${predecessorWorkId}`);
                  }
                }
                const plan = acceptPlanStepEvidence(store, {
                  planId,
                  stepId,
                  reviewer: identity.principalId,
                  rationale,
                  acceptedSourceRevision: workloopCtx.sourceRevision,
                });
                const facade = buildFacadeResult({
                  summary: `Plan step ${stepId} semantically accepted by the current Controller. Successor execution remains an explicit Controller start.`,
                  data: {
                    plan: summarizePlanContract(plan),
                    semanticAcceptanceRecorded: true,
                    reviewer: identity.principalId,
                    ...(predecessorWorkId ? { predecessorWorkId } : {}),
                    successorAdmissionRequired: plan.status !== 'finalized',
                  },
                  suggestedNextActions: plan.status === 'finalized'
                    ? []
                    : [{ label: 'Read the next approved Plan step', tool: 'rh_work', operation: 'plan_get', payload: { plan_id: plan.planId }, risk: 'readonly', confidence: 'high' }],
                });
                return result(facade as unknown as Record<string, unknown>);
              }
              throw new Error(`PLAN_OPERATION_NOT_ROUTED: ${operation}`);
            } catch (error) {
              const facade = buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'PlanContract operation failed.', data: { operation, executionStarted: false } });
              return result(facade as unknown as Record<string, unknown>, true);
            }
          }
  
          if (operation === 'repair' && args.capability_id === 'recovery.migrate_controller_home') {
            const workId = String(args.work_id ?? '').trim();
            if (!workId) {
              const blocked = buildFacadeResult({ status: 'blocked', summary: 'RECOVERY_CONTROLLER_HOME_MIGRATION_WORK_REQUIRED', data: { executionStarted: false } });
              return result(blocked as unknown as Record<string, unknown>, true);
            }
            try {
              const work = getWorkContract(store, workId);
              if (!work || ['completed', 'failed', 'cancelled'].includes(work.status)) {
                throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_ACTIVE_WORK_REQUIRED: ${workId}`);
              }
              const identity = authenticatedFacadeControllerIdentity(ctx, args);
              const owner = getControllerSession(store, workId);
              if (!owner || controllerSessionPrincipalId(owner) !== identity.principalId || owner.sessionId !== identity.sessionId) {
                throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_CONTROLLER_CLAIM_REQUIRED: ${workId}`);
              }
              const liveGit = gitSnapshot(repository.canonicalRoot);
              if (!liveGit.head) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_SOURCE_REVISION_REQUIRED');
              const migrationRequestId = typeof args.request_id === 'string' && args.request_id.trim()
                ? args.request_id.trim()
                : `controller-home-migration:${workId}`;
              const scheduled = await callStandaloneRecoveryTool(ctx.controllerHome, 'migrate_controller_home', {
                request_id: migrationRequestId,
                canonical_source_root: repository.canonicalRoot,
                expected_source_revision: liveGit.head,
              });
              const facade = buildFacadeResult({
                summary: `Standalone Recovery accepted the Controller Home migration transaction for Work ${workId}.`,
                data: { workId, migration: scheduled, executionStarted: true },
              });
              return result(facade as unknown as Record<string, unknown>);
            } catch (error) {
              const facade = buildFacadeResult({
                status: 'blocked',
                summary: error instanceof Error ? error.message : 'Controller Home migration scheduling failed.',
                data: { workId, executionStarted: false },
              });
              return result(facade as unknown as Record<string, unknown>, true);
            }
          }
  
          if (operation === 'repair') {
            return await runFacadeRepair(ctx, repository, args);
          }
  
          if (operation === 'verify') {
            const workId = String(args.work_id ?? '').trim();
            try {
              if (workId) assertFacadeControllerRoundAuthority(ctx, store, workId, args);
            } catch (error) {
              const blocked = buildFacadeResult({
                status: 'blocked',
                summary: error instanceof Error ? error.message : `Work ${workId} controller-round authority check failed.`,
                data: { workId, verificationStarted: false },
              });
              return result(blocked as unknown as Record<string, unknown>, true);
            }
            return await runFacadeVerify(ctx, repository, args);
          }
  
          if (operation === 'review') {
            const workId = String(args.work_id ?? '').trim();
            try {
              if (workId) assertFacadeControllerRoundAuthority(ctx, store, workId, args);
              const identity = authenticatedFacadeControllerIdentity(ctx, args);
              const reviewContract = workId ? getWorkContract(store, workId) : undefined;
              const reviewHandle = workId ? readWorkHandle(ctx.controllerHome, repository.repoId, workId) : undefined;
              if (reviewContract?.workKind === 'repository_change' && reviewHandle?.managedWorktree) {
                const reviewSession = bindFacadeExecutionSession(ctx, repository, reviewHandle, args);
                const prepared = await prepareWorkImplementationReviewCandidate(ctx, {
                  ...args,
                  repo_id: repository.repoId,
                  work_id: workId,
                  session_id: reviewSession.sessionId,
                });
                if (prepared.candidatePrepared !== true) {
                  throw new Error(String(prepared.continuation ?? `WORK_IMPLEMENTATION_REVIEW_CANDIDATE_PREPARATION_REQUIRED: ${workId}`));
                }
              }
              const reconciled = workId ? reconcileTerminalFacadeWorkVerifications(ctx, repository, workId) : undefined;
              if (!workId || !reconciled?.sourceRevision || !reconciled.workspaceFingerprint || !reconciled.implementationReviewWorkspaceFingerprint) {
                throw new Error(`WORK_IMPLEMENTATION_REVIEW_SOURCE_IDENTITY_REQUIRED: ${workId || 'work_id_missing'}`);
              }
              const facade = runGoalWorkloop({
                ...workloopCtx,
                principalId: identity.principalId,
                controllerInstanceId: identity.controllerInstanceId,
                sourceRevision: reconciled.sourceRevision,
                workspaceFingerprint: reconciled.workspaceFingerprint,
                implementationReviewWorkspaceFingerprint: reconciled.implementationReviewWorkspaceFingerprint,
                workspaceChangedPaths: reconciled.workspaceChangedPaths,
                workBoundProcessEvidenceIds: reconciled.workBoundProcessEvidenceIds,
              }, 'review', args);
              return result(facade as unknown as Record<string, unknown>, facade.status === 'blocked' || facade.status === 'failed' || facade.status === 'not_found');
            } catch (error) {
              const blocked = buildFacadeResult({
                status: 'blocked',
                summary: error instanceof Error ? error.message : `Work ${workId} implementation review failed.`,
                data: { workId, implementationReviewRecorded: false },
              });
              return result(blocked as unknown as Record<string, unknown>, true);
            }
          }
  
          if (operation === 'delegate') {
            const facade = delegateToCodexCerebellum(
              { repoId: repository.repoId },
              {
                workId: typeof args.work_id === 'string' ? args.work_id : undefined,
                target: args.target === 'grok' || args.target === 'claude' || args.target === 'codex' ? args.target : 'codex',
                objective: typeof args.objective === 'string' ? args.objective : 'Delegated cerebellum work',
                acceptanceCriteria: Array.isArray(args.acceptance_criteria) ? args.acceptance_criteria.map(String) : undefined,
                allowedPaths: Array.isArray(args.allowed_paths) ? args.allowed_paths.map(String) : undefined,
                forbiddenPaths: Array.isArray(args.forbidden_paths) ? args.forbidden_paths.map(String) : undefined,
                available: typeof args.available === 'boolean' ? args.available : undefined,
                codexAvailable: args.codex_available !== false,
                workerOutput: args.worker_output && typeof args.worker_output === 'object' && !Array.isArray(args.worker_output)
                  ? args.worker_output as { uncertain?: boolean; summary?: string; patchProposal?: string; evidenceSummary?: string }
                  : undefined,
              },
            );
            return result(facade as unknown as Record<string, unknown>, facade.status === 'blocked');
          }
  
          if (operation === 'stop') {
            const workId = String(args.work_id ?? '').trim();
            const existingWork = workId ? getWorkContract(store, workId) : undefined;
            const terminalCleanupOnly = Boolean(
              existingWork
              && ['completed', 'failed', 'cancelled'].includes(existingWork.status)
              && args.cleanup !== false,
            );
            if (terminalCleanupOnly && existingWork) {
              // Terminal resource cleanup is not semantic terminalization. Never
              // reacquire/reopen Controller ownership merely to settle an outcome
              // that is already durable. Active ownership/rounds still fence the
              // cleanup path, while the lower terminal cleanup authority preserves
              // dirty/unique source before removing Work-owned resources.
              const owner = getControllerSession(store, workId);
              let cleanupAuthority: ControllerTerminalizationAuthority | undefined;
              if (owner) {
                try {
                  cleanupAuthority = currentTerminalCleanupAuthority(ctx, store, workId, args);
                } catch (error) {
                  return result(buildFacadeResult({
                    status: 'blocked',
                    summary: error instanceof Error ? error.message : `Work ${workId} terminal cleanup authority check failed.`,
                    data: { workId, terminalizationApplied: false, cleanupOnly: true },
                  }) as unknown as Record<string, unknown>, true);
                }
              }
              const relay = getControllerRoundRelay(store, workId);
              if (relay && !['goal_complete', 'handed_off', 'failed'].includes(relay.status)) {
                return result(buildFacadeResult({
                  status: 'blocked',
                  summary: `WORK_TERMINAL_CLEANUP_ACTIVE_ROUND: ${workId}:${relay.status}.`,
                  data: { workId, terminalizationApplied: false, cleanupOnly: true, relayStatus: relay.status },
                }) as unknown as Record<string, unknown>, true);
              }
              try {
                const cleanup = await reconcileSingleTerminalWorkCleanup(
                  ctx.controllerHome,
                  repository.repoId,
                  workId,
                  {
                    targetBranch: typeof args.target_branch === 'string' ? args.target_branch : undefined,
                    deleteBranch: args.delete_branch !== false,
                    controllerAuthority: cleanupAuthority,
                  },
                );
                const cleanupCompleted = cleanup.status === 'cleaned';
                const cleanupRetained = cleanup.status === 'retained';
                const cleanupSettled = cleanupCompleted || cleanupRetained || cleanup.status === 'no_handle';
                return result(buildFacadeResult({
                  status: cleanupSettled ? 'ok' : 'blocked',
                  summary: cleanupCompleted
                    ? `Terminal Work ${workId} outcome was preserved; managed repository cleanup completed without reopening Controller ownership.`
                    : cleanupRetained
                      ? `Terminal Work ${workId} outcome was preserved; managed repository retention was recorded durably.`
                      : cleanup.status === 'no_handle'
                        ? `Terminal Work ${workId} has no managed repository resources requiring cleanup.`
                        : `Terminal Work ${workId} outcome was preserved; managed repository cleanup remains incomplete and visible for retry.`,
                  data: {
                    work: summarizeWorkContract(existingWork),
                    finalStatus: existingWork.status,
                    terminalizationApplied: false,
                    cleanupOnly: true,
                    worktreeDeleted: cleanupCompleted,
                    cleanupPending: !cleanupSettled,
                    cleanupRetained,
                    lifecycleCleanup: cleanup,
                  },
                }) as unknown as Record<string, unknown>, !cleanupSettled);
              } catch (error) {
                return result(buildFacadeResult({
                  status: 'blocked',
                  summary: `Terminal Work ${workId} cleanup-only reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
                  data: {
                    work: summarizeWorkContract(existingWork),
                    finalStatus: existingWork.status,
                    terminalizationApplied: false,
                    cleanupOnly: true,
                    worktreeDeleted: false,
                    cleanupPending: true,
                  },
                }) as unknown as Record<string, unknown>, true);
              }
            }
            const observedOwner = workId ? getControllerSession(store, workId) : undefined;
            const observedRelay = workId ? getControllerRoundRelay(store, workId) : undefined;
            const activeWorkProcess = workId
              ? processRuntimeResourceDiagnostics().activeProcessIds
                  .map((processId) => getProcessRecord(ctx.controllerHome, repository.repoId, processId))
                  .some((process) => Boolean(process && process.workId === workId && isManagedProcessActive(process)))
              : false;
            // Maintenance stop is intentionally narrower than ControllerRound recovery.
            // Once no Controller owns the Work, no Process is active, and the relay is
            // absent or terminally failed/handed-off, the obsolete round capability must
            // not make the durable Work immortal. The ControllerSession task lock below
            // still fences a concurrent fresh claim before Work terminalization.
            const ownerlessMaintenanceStop = Boolean(
              workId
              && !observedOwner
              && !activeWorkProcess
              && Boolean(observedRelay)
              && ['failed', 'handed_off'].includes(observedRelay!.status),
            );
            if (!ownerlessMaintenanceStop) {
              try {
                if (workId) assertFacadeControllerRoundAuthority(ctx, store, workId, args);
              } catch (error) {
                const blocked = buildFacadeResult({
                  status: 'blocked',
                  summary: error instanceof Error ? error.message : `Work ${workId} controller-round authority check failed.`,
                  data: { workId, terminalizationApplied: false },
                });
                return result(blocked as unknown as Record<string, unknown>, true);
              }
            }
            let terminalizationAuthority: ControllerTerminalizationAuthority | undefined;
            if (!ownerlessMaintenanceStop) {
              try {
                terminalizationAuthority = currentFacadeTerminalizationAuthority(ctx, store, workId, args);
              } catch (error) {
                const blocked = buildFacadeResult({
                  status: 'blocked',
                  summary: error instanceof Error ? error.message : `Work ${workId} terminalization authority check failed.`,
                  data: { workId, terminalizationApplied: false },
                });
                return result(blocked as unknown as Record<string, unknown>, true);
              }
            }
  
            const fenced = withControllerSessionTerminalizationFence(
              store,
              {
                workId,
                actor: `rh-work-stop:${terminalizationAuthority?.controllerId ?? String(args.requested_by ?? 'explicit')}`,
                authority: terminalizationAuthority,
              },
              () => runGoalWorkloop({ ...workloopCtx, sourceRevision: workloopCtx.sourceRevision ?? undefined }, 'stop', args),
            );
            if (!fenced.allowed) {
              const blocked = buildFacadeResult({
                status: 'blocked',
                summary: `WORK_TERMINALIZATION_AUTHORITY_FENCED: ${workId}:${fenced.reason}`,
                data: {
                  workId,
                  terminalizationApplied: false,
                  currentClaimGeneration: fenced.owner?.claimGeneration,
                },
              });
              return result(blocked as unknown as Record<string, unknown>, true);
            }
            const facade = fenced.value;
            if (facade.status !== 'ok') {
              return result(facade as unknown as Record<string, unknown>, true);
            }
            const reconcileStoppedRound = () => {
              const stopped = getWorkContract(store, workId);
              if (!stopped || !['failed', 'cancelled'].includes(stopped.status) || getControllerSession(store, workId)) return undefined;
              const terminalRelay = reconcileControllerRoundAfterTerminalWork(store, { workId, actor: 'rh-work-stop-terminal-reconcile' });
              if (terminalRelay) return terminalRelay;
              const retained = getRetainedControllerSession(store, workId);
              if (!retained) return undefined;
              return reconcileControllerRoundAfterAbandonedRelease(
                { controllerHome: ctx.controllerHome, repoId: repository.repoId },
                { workId, releasedSession: retained },
              );
            };
            try {
              const physical = await finalizeFacadeWorkHandle(ctx, repository, args, 'stop');
              if (!physical) {
                const relay = reconcileStoppedRound();
                return result({
                  ...facade,
                  data: { ...(facade.data && typeof facade.data === 'object' ? facade.data : {}), ...(relay ? { relay } : {}) },
                } as unknown as Record<string, unknown>);
              }
              const cleanup = contextRecord(physical.structuredContent);
              const cleanupCompleted = cleanup.cleanupCompleted === true || contextRecord(cleanup.work).state === 'cleaned';
              const cleanupRetained = cleanup.cleanupRetained === true;
              const cleanupSettled = cleanupCompleted || cleanupRetained;
              const stoppedRelay = reconcileStoppedRound();
              const response = {
                ...facade,
                status: cleanupSettled ? 'ok' : 'blocked',
                summary: cleanupCompleted
                  ? `${facade.summary} Managed worktree and branch cleanup completed automatically.`
                  : cleanupRetained
                    ? `${facade.summary} Managed worktree and branch retention was recorded durably; automatic cleanup is disabled for this terminal Work.`
                    : `${facade.summary} Automatic managed-resource cleanup is incomplete and remains visible for retry.`,
                data: {
                  ...(facade.data && typeof facade.data === 'object' ? facade.data : {}),
                  worktreeDeleted: cleanupCompleted,
                  cleanupPending: !cleanupSettled,
                  cleanupRetained,
                  lifecycleCleanup: cleanup,
                  ...(stoppedRelay ? { relay: stoppedRelay } : {}),
                },
              };
              return result(response as unknown as Record<string, unknown>, !cleanupSettled || physical.isError === true);
            } catch (error) {
              const response = {
                ...facade,
                status: 'blocked',
                summary: `${facade.summary} Automatic managed-resource cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
                data: {
                  ...(facade.data && typeof facade.data === 'object' ? facade.data : {}),
                  worktreeDeleted: false,
                  cleanupPending: true,
                },
              };
              return result(response as unknown as Record<string, unknown>, true);
            }
          }
  
          if (operation === 'finalize') {
            const workId = String(args.work_id ?? '').trim();
            try {
              if (workId) assertFacadeControllerRoundAuthority(ctx, store, workId, args);
            } catch (error) {
              const blocked = buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : `Work ${workId} controller-round authority check failed.`, data: { workId, lifecycleClosed: false } });
              return result(blocked as unknown as Record<string, unknown>, true);
            }
            const finalizeReconciliation = workId
              ? reconcileTerminalFacadeWorkVerifications(ctx, repository, workId)
              : undefined;
            const semanticFinalizeContext = {
              ...workloopCtx,
              sourceRevision: finalizeReconciliation?.sourceRevision ?? workloopCtx.sourceRevision ?? undefined,
              workspaceFingerprint: finalizeReconciliation?.workspaceFingerprint,
              implementationReviewWorkspaceFingerprint: finalizeReconciliation?.implementationReviewWorkspaceFingerprint,
              workspaceChangedPaths: finalizeReconciliation?.workspaceChangedPaths,
              workBoundProcessEvidenceIds: finalizeReconciliation?.workBoundProcessEvidenceIds,
            };
            let before = workId ? getWorkContract(store, workId) : undefined;
            let terminalizationAuthority: ControllerTerminalizationAuthority | undefined;
            // Finalize may commit, merge, clean resources, and complete the Work.
            // It therefore shares the same exact-claim authority as stop. Transport
            // or Runtime recovery remains an explicit controller_claim operation;
            // terminalization itself must never rebind an unrelated controller scope.
            if (before && !['completed', 'failed', 'cancelled'].includes(before.status)) {
              try {
                terminalizationAuthority = currentFacadeTerminalizationAuthority(ctx, store, workId, args);
              } catch (error) {
                const blocked = buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : `Work ${workId} terminalization authority check failed.`, data: { workId, terminalizationApplied: false, lifecycleClosed: false } });
                return result(blocked as unknown as Record<string, unknown>, true);
              }
            }
            if (before && !before.completionReceipt && args.reconcile_historical_delivery === true) {
              try {
                const identity = authenticatedFacadeControllerIdentity(ctx, args);
                const owner = getControllerSession(store, workId);
                if (!owner || (controllerSessionPrincipalId(owner)) !== identity.principalId) {
                  throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_CONTROLLER_CLAIM_REQUIRED: ${workId}`);
                }
                const historicalHandle = readWorkHandle(ctx.controllerHome, repository.repoId, workId);
                const explicitTargetBranch = typeof args.target_branch === 'string' && args.target_branch.trim()
                  ? args.target_branch.trim()
                  : undefined;
                const reconciliationTargetBranch = historicalHandle
                  ? resolveWorkDeliveryTargetBranch(historicalHandle, repository.defaultBranch, explicitTargetBranch)
                  : explicitTargetBranch || repository.defaultBranch || 'main';
                if (historicalHandle?.managedWorktree) {
                  const managedCleanupComplete = historicalHandle.finalization.merge === 'done'
                    && historicalHandle.finalization.branchCleanup === 'done'
                    && historicalHandle.finalization.worktreeCleanup === 'done'
                    && !existsSync(historicalHandle.worktreePath);
                  if (!managedCleanupComplete) {
                    let managedCheckout: ReturnType<typeof selectRepositoryCheckout>;
                    try {
                      managedCheckout = selectRepositoryCheckout(repository, historicalHandle.checkoutId, { allowArchived: true });
                    } catch {
                      throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_MANAGED_CLEANUP_REQUIRED: ${workId}`);
                    }
                    const managedStatus = repositoryGitStatus(managedCheckout);
                    const targetRevision = String(args.reconcile_target_revision ?? '').trim();
                    const exactCleanCandidate = existsSync(historicalHandle.worktreePath)
                      && managedStatus.clean
                      && managedStatus.head === targetRevision
                      && historicalHandle.expectedHead?.trim() === targetRevision;
                    if (!exactCleanCandidate) throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_MANAGED_CLEANUP_REQUIRED: ${workId}`);
                  }
                }
                acceptReviewedDirectEditWorkReconciliation({
                  controllerHome: ctx.controllerHome,
                  repoId: repository.repoId,
                  checkoutId: before.checkoutId ?? repository.activeCheckoutId,
                  repoRoot: repository.canonicalRoot,
                  workId,
                  targetBranch: reconciliationTargetBranch,
                  targetRevision: String(args.reconcile_target_revision ?? ''),
                  comparedPaths: Array.isArray(args.reconcile_compared_paths) ? args.reconcile_compared_paths.map(String) : [],
                  reviewer: identity.principalId,
                  rationale: String(args.reconcile_rationale ?? ''),
                  cleanupOwnershipProof: String(args.reconcile_cleanup_proof ?? ''),
                });
                const released = releaseObservedControllerSession(store, {
                  workId,
                  actor: `direct-edit-reconciliation:${identity.principalId}`,
                  owner,
                });
                if (!released.allowed) {
                  throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_CONTROLLER_RELEASE_FENCED: ${workId}:${released.reason}`);
                }
                before = getWorkContract(store, workId);
              } catch (error) {
                const blocked = buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Historical Work delivery reconciliation failed.', data: { workId, lifecycleClosed: false } });
                return result(blocked as unknown as Record<string, unknown>, true);
              }
            }
            const repositoryDeliveryHandle = workId
              ? readWorkHandle(ctx.controllerHome, repository.repoId, workId)
              : undefined;
            const effectHasRepositoryDelta = Boolean(
              before
              && ['local_effect', 'remote_effect'].includes(before.workKind)
              && (
                (repositoryDeliveryHandle && repositoryWorkHandleHasSourceDelta(repository, repositoryDeliveryHandle))
                || (finalizeReconciliation?.workspaceChangedPaths?.length ?? 0) > 0
              )
            );
            if (effectHasRepositoryDelta && !repositoryDeliveryHandle) {
              const blocked = buildFacadeResult({
                status: 'blocked',
                summary: `WORK_EFFECT_REPOSITORY_DELIVERY_HANDLE_REQUIRED: ${workId} has repository source delta and cannot use effect-only terminalization without a physical WorkHandle.`,
                data: { workId, lifecycleClosed: false },
              });
              return result(blocked as unknown as Record<string, unknown>, true);
            }
            // Pure remote effects may complete from either the canonical plugin
            // action receipt or the deliberately narrow trusted repository
            // Process authority (`git push` + exact remote lease). A remote_effect
            // that acquired source delta is no longer pure and must use physical
            // repository delivery instead.
            if (before?.workKind === 'remote_effect' && !before.completionReceipt && !effectHasRepositoryDelta) {
              try {
                before = finalizeRemoteEffectWorkFromActionReceipt(ctx.controllerHome, repository.repoId, workId);
              } catch (pluginError) {
                const checkoutId = before.checkoutId ?? repositoryDeliveryHandle?.checkoutId ?? repository.activeCheckoutId;
                const processCompleted = finalizeRemoteEffectWorkFromRepositoryProcessReceipt(ctx, repository, workId, checkoutId);
                if (processCompleted) {
                  before = processCompleted;
                } else {
                  const blocked = buildFacadeResult({
                    status: 'blocked',
                    summary: pluginError instanceof Error ? pluginError.message : 'Remote-effect semantic finalization failed.',
                    data: { workId, lifecycleClosed: false },
                  });
                  return result(blocked as unknown as Record<string, unknown>, true);
                }
              }
            }
            const completedCleanupPending = Boolean(
              before?.completionReceipt
              && args.cleanup !== false
              && before.worktreeRef?.trim()
              && existsSync(before.worktreeRef),
            );
            const repositoryDeliveryRequired = Boolean(
              before
              && before.workKind !== 'read_only_review'
              && (
                !['local_effect', 'remote_effect'].includes(before.workKind)
                || effectHasRepositoryDelta
              )
            );
            if (before && ((repositoryDeliveryRequired && !before.completionReceipt) || completedCleanupPending)) {
              try {
                const physical = await finalizeFacadeWorkHandle(ctx, repository, args, 'finalize');
                if (physical?.isError === true) return physical;
                const refreshed = getWorkContract(store, workId);
                if (physical && !refreshed?.completionReceipt) return physical;
              } catch (error) {
                const blocked = buildFacadeResult({
                  status: 'blocked',
                  summary: error instanceof Error ? error.message : 'Work delivery/finalization failed.',
                  data: { workId, lifecycleClosed: false },
                });
                return result(blocked as unknown as Record<string, unknown>, true);
              }
            }
            const semanticWork = getWorkContract(store, workId);
            let facade;
            if (semanticWork && !['completed', 'failed', 'cancelled'].includes(semanticWork.status)) {
              try {
                const authority = terminalizationAuthority ?? currentFacadeTerminalizationAuthority(ctx, store, workId, args);
                const fenced = withControllerSessionTerminalizationFence(
                  store,
                  {
                    workId,
                    actor: `rh-work-finalize:${authority.controllerId}:${authority.controllerInstanceId}`,
                    authority,
                  },
                  () => runGoalWorkloop(semanticFinalizeContext, 'finalize', args),
                );
                if (!fenced.allowed) {
                  throw new Error(`WORK_TERMINALIZATION_AUTHORITY_FENCED: ${workId}:${fenced.reason}`);
                }
                facade = fenced.value;
              } catch (error) {
                const blocked = buildFacadeResult({
                  status: 'blocked',
                  summary: error instanceof Error ? error.message : `Work ${workId} semantic finalization authority check failed.`,
                  data: { workId, terminalizationApplied: false, lifecycleClosed: false },
                });
                return result(blocked as unknown as Record<string, unknown>, true);
              }
            } else {
              facade = runGoalWorkloop(semanticFinalizeContext, 'finalize', args);
            }
            let completed = getWorkContract(store, workId);
            const postSemanticCleanupPending = Boolean(
              completed?.completionReceipt
              && args.cleanup !== false
              && completed.worktreeRef?.trim()
              && existsSync(completed.worktreeRef),
            );
            if (postSemanticCleanupPending) {
              try {
                const physical = await finalizeFacadeWorkHandle(ctx, repository, { ...args, commit: false, merge: false }, 'finalize');
                if (physical?.isError === true) return physical;
                completed = getWorkContract(store, workId);
              } catch (error) {
                const blocked = buildFacadeResult({
                  status: 'blocked',
                  summary: error instanceof Error ? error.message : `Work ${workId} terminal cleanup reconciliation failed.`,
                  data: { workId, terminalizationApplied: true, lifecycleClosed: false },
                });
                return result(blocked as unknown as Record<string, unknown>, true);
              }
            }
            // Finalizing a Work proves the Work lifecycle only. A Plan step may aggregate
            // acceptance criteria that are broader than this Work (for example, a canary
            // plus a later stabilization soak), so finalize must never synthesize semantic
            // Plan acceptance. Only the explicit plan_accept_step operation may promote a
            // validating step to completed after the Controller reviews all criteria.
            const completedHandle = readWorkHandle(ctx.controllerHome, repository.repoId, workId);
            const lifecycleClosed = Boolean(completed?.completionReceipt)
              && (!completedHandle || completedHandle.finalization.worktreeCleanup !== 'pending');
            let blockerResolutionOccurrences: Array<{ scheduleId: string; occurrenceId?: string; status?: string }> = [];
            if (lifecycleClosed && facade.status === 'ok') {
              const explicitTargetBranch = typeof args.target_branch === 'string' && args.target_branch.trim()
                ? args.target_branch.trim()
                : undefined;
              const targetBranch = completedHandle
                ? resolveWorkDeliveryTargetBranch(completedHandle, repository.defaultBranch, explicitTargetBranch)
                : explicitTargetBranch || repository.defaultBranch || 'main';
              const targetStatus = repositoryGitStatus(repository);
              if (targetStatus.clean && targetStatus.branch === targetBranch && targetStatus.head) {
                blockerResolutionOccurrences = await triggerWorkContinuationRepositoryEvent(
                  ctx.controllerHome,
                  repository.repoId,
                  repositoryCleanContinuationEventName(targetBranch),
                  `repository-clean:${targetBranch}:${targetStatus.head}`,
                  { data: { targetBranch, targetRevision: targetStatus.head, sourceWorkId: workId } },
                );
              }
            }
            const response = {
              ...facade,
              data: {
                ...(facade.data && typeof facade.data === 'object' ? facade.data : {}),
                lifecycleClosed,
                ...(blockerResolutionOccurrences.length > 0 ? { blockerResolutionOccurrences } : {}),
              },
            };
            return result(response as unknown as Record<string, unknown>, response.status === 'blocked' || response.status === 'failed' || response.status === 'not_found');
          }
  
          let resumedControllerSession: ReturnType<typeof resumeControllerSession> | undefined;
          let cancelledWorkReauthorized = false;
          let reconstructedCancelledCheckout = false;
          let reconstructedRunningCheckout = false;
          let continuationSourceRevision = workloopCtx.sourceRevision;
          let continuationWorkspaceFingerprint: string | undefined;
          let continuationImplementationReviewWorkspaceFingerprint: string | undefined;
          let continuationWorkspaceChangedPaths: string[] | undefined;
          let continuationWorkBoundProcessEvidenceIds: string[] | undefined;
          if (operation === 'continue') {
            try {
              const workId = String(args.work_id ?? '').trim();
              if (workId) assertFacadeControllerRoundAuthority(ctx, store, workId, args);
              let work = getWorkContract(store, workId);
              if (work?.status === 'cancelled') {
                const identity = authenticatedFacadeControllerIdentity(ctx, args);
                const resumed = reauthorizeRetainedCancelledRepositoryWork({
                  controllerHome: ctx.controllerHome,
                  repository,
                  workId,
                  identity,
                  requestedBy: typeof args.requested_by === 'string' ? args.requested_by : undefined,
                  approvalConfirmed: args.approval_confirmed === true,
                  prepareDependencies: args.needs_dependencies === true,
                });
                cancelledWorkReauthorized = true;
                reconstructedCancelledCheckout = resumed.reconstructedCheckout;
                work = getWorkContract(store, workId);
              }
              if (work && !['cancelled', 'completed', 'failed'].includes(work.status)) {
                const identity = authenticatedFacadeControllerIdentity(ctx, args);
                // Continue uses the same Kernel rebind authority as terminalization.
                // MCP transport identity is replaceable; principal/controller and
                // canonical Runtime ownership remain fenced by the ControllerSession.
                resumedControllerSession = bindFacadeControllerOwnership(ctx, store, workId, identity, {
                  allowClaimIfMissing: true,
                  leaseMs: 3_600_000,
                  relayScopeId: typeof args.relay_scope_id === 'string' ? args.relay_scope_id.trim() : undefined,
                });
                rebindRepositoryWorkHandleControllerIdentity({
                  controllerHome: ctx.controllerHome,
                  repositoryId: repository.repoId,
                  workId,
                  identity: { sessionId: identity.sessionId, principalId: identity.principalId },
                });
                reconcileRepositoryWorkHandlePlacement({
                  controllerHome: ctx.controllerHome,
                  repositoryId: repository.repoId,
                  workId,
                });
                const recovered = ensureRunningRepositoryWorkCheckout({
                  controllerHome: ctx.controllerHome,
                  repository,
                  workId,
                  identity,
                  prepareDependencies: args.needs_dependencies === true,
                });
                reconstructedRunningCheckout = recovered.reconstructedCheckout;
                if (reconstructedRunningCheckout) {
                  work = getWorkContract(store, workId);
                  if (!work) throw new Error(`WORK_CONTINUE_RECONSTRUCTION_CONTRACT_MISSING: ${workId}`);
                }
                if (work.worktreePolicy.required === true && !work.worktreeRef) {
                  materializeFacadeWorkPlacement(ctx, repository, workId, args);
                }
              }
              if (workId) {
                const reconciled = reconcileTerminalFacadeWorkVerifications(ctx, repository, workId);
                continuationSourceRevision = reconciled.sourceRevision ?? continuationSourceRevision;
                continuationWorkspaceFingerprint = reconciled.workspaceFingerprint ?? continuationWorkspaceFingerprint;
                continuationImplementationReviewWorkspaceFingerprint = reconciled.implementationReviewWorkspaceFingerprint ?? continuationImplementationReviewWorkspaceFingerprint;
                continuationWorkspaceChangedPaths = reconciled.workspaceChangedPaths ?? continuationWorkspaceChangedPaths;
                continuationWorkBoundProcessEvidenceIds = reconciled.workBoundProcessEvidenceIds;
              }
            } catch (error) {
              const facade = buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Controller resume failed.', data: { operation, executionStarted: false, ownershipResumed: false } });
              return result(facade as unknown as Record<string, unknown>, true);
            }
          }
  
          let terminalSuccessorAdmission: {
            predecessorWorkId: string;
            relay: ControllerRoundRelayRecord;
            identity: ReturnType<typeof authenticatedFacadeControllerIdentity>;
          } | undefined;
          if (operation === 'start' && String(args.work_relation ?? '').trim() === 'continue') {
            const predecessorWorkId = String(args.related_work_id ?? '').trim();
            const predecessorWork = predecessorWorkId ? getWorkContract(store, predecessorWorkId) : undefined;
            if (predecessorWork?.status === 'completed' && predecessorWork.planId) {
              const relay = getControllerRoundRelay(store, predecessorWorkId);
              if (!relay || !['claimed', 'pending_release'].includes(relay.status)) {
                const facade = buildFacadeResult({ status: 'blocked', summary: `TERMINAL_SUCCESSOR_CONTROLLER_ROUND_REQUIRED: ${predecessorWorkId}:${relay?.status ?? 'missing'}`, data: { operation, executionStarted: false, predecessorWorkId } });
                return result(facade as unknown as Record<string, unknown>, true);
              }
              const workKind = typeof args.work_kind === 'string' ? args.work_kind.trim() : '';
              if (!workKind) {
                const facade = buildFacadeResult({ status: 'blocked', summary: `TERMINAL_SUCCESSOR_WORK_KIND_REQUIRED: ${predecessorWorkId}`, data: { operation, executionStarted: false, predecessorWorkId } });
                return result(facade as unknown as Record<string, unknown>, true);
              }
              const explicitAuthorityId = typeof args.controller_authority_id === 'string' ? args.controller_authority_id.trim() : '';
              const explicitRelayScopeId = typeof args.relay_scope_id === 'string' ? args.relay_scope_id.trim() : '';
              if (!explicitAuthorityId || !explicitRelayScopeId) {
                const facade = buildFacadeResult({ status: 'blocked', summary: `TERMINAL_SUCCESSOR_CONTROLLER_ROUND_AUTHORITY_REQUIRED: ${predecessorWorkId}`, data: { operation, executionStarted: false, predecessorWorkId } });
                return result(facade as unknown as Record<string, unknown>, true);
              }
              try {
                assertFacadeControllerRoundAuthority(ctx, store, predecessorWorkId, args);
                const identity = authenticatedFacadeControllerIdentity(ctx, args, { allowTransportSessionRollover: true });
                if (relay.controllerId !== identity.controllerId || relay.principalId !== identity.principalId || relay.controllerType !== identity.controllerType) {
                  throw new Error(`TERMINAL_SUCCESSOR_CONTROLLER_ROUND_IDENTITY_MISMATCH: ${predecessorWorkId}`);
                }
                terminalSuccessorAdmission = { predecessorWorkId, relay, identity };
              } catch (error) {
                const facade = buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Terminal successor ControllerRound authority validation failed.', data: { operation, executionStarted: false, predecessorWorkId } });
                return result(facade as unknown as Record<string, unknown>, true);
              }
            }
          }
  
          const semanticAdmissionRequired = operation === 'start' && Boolean(
            (typeof args.plan_id === 'string' && args.plan_id.trim())
            || (typeof args.plan_step_id === 'string' && args.plan_step_id.trim())
            || (typeof args.requirement_id === 'string' && args.requirement_id.trim())
            || (typeof args.related_work_id === 'string' && args.related_work_id.trim())
            || (typeof args.work_relation === 'string' && args.work_relation.trim()),
          );
          const startContext = {
            ...workloopCtx,
            sourceRevision: continuationSourceRevision ?? undefined,
            workspaceFingerprint: continuationWorkspaceFingerprint,
            implementationReviewWorkspaceFingerprint: continuationImplementationReviewWorkspaceFingerprint,
            workspaceChangedPaths: continuationWorkspaceChangedPaths,
            workBoundProcessEvidenceIds: continuationWorkBoundProcessEvidenceIds,
            semanticAdmissionLocked: semanticAdmissionRequired,
          };
          let trustedEngineeringEvidence: ReturnType<typeof mintEngineeringAdmissionEvidence> | undefined;
          if ((operation === 'start' || operation === 'continue') && args.engineering_preconditions !== undefined) {
            try {
              const sourceRevision = startContext.sourceRevision?.trim();
              if (!sourceRevision) throw new Error('ENGINEERING_PRECONDITIONS_SOURCE_REQUIRED');
              const existingWork = operation === 'continue'
                ? getWorkContract(store, String(args.work_id ?? '').trim())
                : undefined;
              const requirementContext = existingWork
                ? { objective: existingWork.objective, acceptanceCriteria: existingWork.acceptanceCriteria }
                : {
                    objective: String(args.objective ?? ''),
                    acceptanceCriteria: Array.isArray(args.acceptance_criteria) ? args.acceptance_criteria.map(String) : [],
                  };
              const verified = mintEngineeringAdmissionEvidence({
                repoRoot: repository.canonicalRoot,
                sourceRevision,
                draft: args.engineering_preconditions,
                requirementContext,
                existingProjectContractReceipt: existingWork?.engineeringContext?.projectContractReceipt,
              });
              trustedEngineeringEvidence = verified;
            } catch (error) {
              const facade = buildFacadeResult({
                status: 'blocked',
                summary: error instanceof Error ? error.message : 'ENGINEERING_PRECONDITIONS_INVALID',
                data: { operation, executionStarted: false, engineeringPreconditionsAccepted: false },
              });
              return result(facade as unknown as Record<string, unknown>, true);
            }
          }
          const facade = semanticAdmissionRequired
            ? await withPrimaryWorkAdmissionLockAsync(store, () => runGoalWorkloop(startContext, 'start', args, { verifiedEngineeringEvidence: trustedEngineeringEvidence }))
            : runGoalWorkloop(startContext, operation as 'start' | 'continue', args, { verifiedEngineeringEvidence: trustedEngineeringEvidence });
          const facadeData = facade.data && typeof facade.data === 'object' ? facade.data as Record<string, unknown> : {};
          const facadeWorkId = contextText(contextRecord(facadeData.work).workId, 200);
          if (facade.status === 'ok' && facadeWorkId) {
            try {
              if (facadeData.workContractCreated === true) {
                materializeFacadeWorkPlacement(ctx, repository, facadeWorkId, args);
              }
              const handle = ensureFacadeWorkHandle(ctx, repository, facadeWorkId, args);
              if (handle) facadeData.executionHandle = { workId: handle.workId, checkoutId: handle.checkoutId, managedWorktree: handle.managedWorktree, state: handle.state };
              if (facadeData.workContractCreated === true && !terminalSuccessorAdmission) {
                const claimed = claimNewFacadeWork(ctx, repository, facadeWorkId, args);
                facadeData.controllerSession = claimed.session;
                facadeData.controllerAuthorityId = claimed.controllerAuthorityId;
                facadeData.controllerAuthorityCarrier = 'controller_authority_id_or_session_id_compat';
                facadeData.ownershipClaimed = true;
              }
              if (terminalSuccessorAdmission) {
                const currentRelay = getControllerRoundRelay(store, terminalSuccessorAdmission.predecessorWorkId);
                let boundRelay: ControllerRoundRelayRecord;
                if (currentRelay?.status === 'pending_release') {
                  // Idempotent retry after the Controller already submitted its
                  // disposition. Never create/rebind another successor.
                  if (currentRelay.successorWorkId !== facadeWorkId) {
                    throw new Error(`CONTROLLER_RELAY_SUCCESSOR_ALREADY_BOUND: ${terminalSuccessorAdmission.predecessorWorkId}:${currentRelay.successorWorkId ?? 'none'}`);
                  }
                  boundRelay = currentRelay;
                } else {
                  boundRelay = bindControllerRoundSuccessorWork(store, {
                    workId: terminalSuccessorAdmission.predecessorWorkId,
                    successorWorkId: facadeWorkId,
                    identity: terminalSuccessorAdmission.identity,
                    controllerAuthorityId: terminalSuccessorAdmission.relay.authorityId,
                  });
                }
                facadeData.predecessorWorkId = terminalSuccessorAdmission.predecessorWorkId;
                facadeData.successorWorkId = facadeWorkId;
                facadeData.terminalSuccessorRelay = boundRelay;
                facadeData.ownershipClaimed = false;
              }
            } catch (error) {
              const blocked = buildFacadeResult({ status: 'blocked', summary: `WORK_HANDLE_MATERIALIZATION_FAILED: ${error instanceof Error ? error.message : String(error)}`, data: { ...facadeData, workId: facadeWorkId, executionStarted: false, canonicalWorkRetained: true } });
              return result(blocked as unknown as Record<string, unknown>, true);
            }
          }
          const response = resumedControllerSession
            ? {
                ...facade,
                ...(cancelledWorkReauthorized
                  ? {
                      status: 'ok' as const,
                      summary: `Explicit current-user reauthorization resumed ${resumedControllerSession.workId}; implementation may continue on the exact Work identity.`,
                    }
                  : { summary: `Controller ownership resumed for ${resumedControllerSession.workId}. ${facade.summary}` }),
                data: {
                  ...facadeData,
                  ownershipResumed: true,
                  controllerSession: resumedControllerSession,
                  ...(reconstructedRunningCheckout ? { reconstructedRunningCheckout: true } : {}),
                  ...(cancelledWorkReauthorized ? {
                    cancelledWorkReauthorized: true,
                    reconstructedCancelledCheckout,
                    nextStep: 'execute',
                  } : {}),
                },
              }
            : facade;
          return result(response as unknown as Record<string, unknown>, response.status === 'blocked' || response.status === 'failed' || response.status === 'not_found');
        }
}
