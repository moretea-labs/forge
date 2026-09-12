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
import { classifyPersistedCheckTerminalEvidence } from "../../../src/runtime/execution/process-runtime/check-result";
import { listWorkBoundRepositoryProcessEvidence, listWorkBoundRepositoryRemoteEffectProcessEvidence } from "../../../src/runtime/control-plane/execution/work-process-evidence";
import { completeRemoteEffectWorkFromProcessReceipt } from "../../../packages/kernel/work/api/index";
import { executionIdentityForRepository } from "../../../src/runtime/control-plane/execution/execution-identity";
import { executeRegisteredWorkflow, observeAndReconcileRegisteredWorkflow } from "../../../src/runtime/workflows/runtime";
import { readWorkflowRun } from "../../../src/runtime/control-plane/persistence/workflow-run-store";
import { schedulePublicationOutcomeCollection } from "../../../src/runtime/root/assistant-learning-loop";
import { recordControllerExperience, recordControllerOutcome, type ControllerExperienceDraft, type ControllerOutcomeObservationDraft } from "../../../src/runtime/context/assistant-work-context";
import { ensureXiaohongshuWorkflowInstalled, XIAOHONGSHU_WORKFLOW_IDS } from "../../../src/runtime/workflows/first-party/xiaohongshu";
import { readWorkHandle, resolveWorkDeliveryTargetBranch, workDeliveryBaseRevision, type WorkHandleState } from "../../../src/runtime/control-plane/execution/work-handle-store";
import { ensureRepositoryWorkHandle, rebindRepositoryWorkHandleControllerIdentity, reconcileRepositoryWorkHandlePlacement } from "../../../src/runtime/control-plane/execution/work-handle-authority";
import { assertControllerInvocationAuthority, assertControllerRoundInvocationAuthority, bindControllerOwnershipForInvocation, controllerInvocationAuthorityMatches, controllerTerminalizationAuthorityForInvocation, recoverControllerAuthority, terminalCleanupAuthorityForInvocation } from "../../../src/runtime/control-plane/execution/controller-authority-recovery";
import { reconcileSingleTerminalWorkCleanup, recoverTerminalWorkHandle } from "../../../src/runtime/control-plane/execution/work-terminal-cleanup";
import { commandFingerprint, verificationInputFingerprint, workspaceValidationFingerprint } from "../../../src/runtime/control-plane/execution/verification-evidence";
import { resolveWorkVerificationContext } from "../../../src/runtime/control-plane/execution/work-verification-context";
import { executeWorkVerification } from "../../../src/runtime/control-plane/execution/work-verification-service";
import { implementationReviewContentFingerprint } from "../../../src/runtime/control-plane/execution/implementation-review-content";
import { implementationReviewCommittedBaseRevision, reconcileDirectCanonicalTargetAdvanceCommand } from "../../../src/runtime/control-plane/execution/work-finalization-service";
import { acceptReviewedDirectEditWorkReconciliation } from "../../../src/runtime/control-plane/execution/direct-edit-work-completion";
import { readForgeRuntimeStatus } from "../../../src/runtime/control-plane/runtime-status-client";
import { deleteSchedule } from "../../../packages/kernel/scheduler/api/index";
import { createWorkContinuationSchedule, ensureControllerDispositionContinuation, getWorkContinuationSchedule, listWorkContinuationSchedules, pauseWorkContinuationSchedule, repositoryCleanContinuationEventName, resumeWorkContinuationSchedule, triggerWorkContinuationRepositoryEvent, triggerWorkContinuationSchedule, type ContinuationControllerType } from "../../../src/runtime/workflow/schedules/work-continuation";
import { assertAutomatedOperationAllowed } from "../../../src/runtime/control-plane/governance/external-effects";
import { listControllerChecks, readLatestControllerCheckEvidence } from "../../../src/cli/controller/check-runner";
import { finalizeRemoteEffectWorkFromActionReceipt } from "../../../src/runtime/plugins/store";
import { gitSnapshot } from "../../../src/cli/repository/inspector";
import { buildWorkflowWatchdogReport } from "../../../src/runtime/watchdog/workflow-watchdog";
import { applyRuntimeMaintenance, buildRuntimeMaintenanceStatus } from "../../../src/runtime/recovery";
import { callStandaloneRecoveryTool } from "./recovery-client-adapter";
import { allowedFacadeOperations, buildFacadeResult, classifyVerificationOutcome, getHandoffItem, normalizeCheckIds, runGoalWorkloop, runSelfHealingLoop, delegateToCodexCerebellum, buildWorkContinuationSnapshot, acceptPlanStepEvidence, admitPlanContractAsync, approvePlanContractAsync, getPlanContract, listPlanContracts, resolvePlanAdmission, withPrimaryWorkAdmissionLockAsync, repairDanglingPlanStepWorkBinding, repairPlanStepForTechnicalRetry, replanActivePlanBoundWorkScope, repairDraftPlanContractAsync, completePlanStepForWork, summarizePlanContract, summarizeWorkContract, supersedePlanContract, verifyGoalWorkloop } from "../../../src/runtime/control-plane/facade";
import { getWorkContract, listWorkContracts } from "../../../packages/kernel/work/api/index";
import { currentControllerInstanceId, readExecutionSession, startExecutionSession, updateExecutionSession } from "../../../src/runtime/control-plane/execution/session-store";
import { changedPaths as workChangedPaths, changedPathsFromUnbornBase as workChangedPathsFromUnbornBase } from "../../../src/runtime/control-plane/execution/work-task-receipt";
import { readRequirement } from "../../../src/runtime/control-plane/persistence/requirement-store";
import { admitRequirement, completeRequirementGoal, continueRequirement } from "../../../src/runtime/control-plane/facade/requirement-authority";
import { ensureManagedWorkspace } from "../../../src/runtime/execution/managed-workspace";
import { materializeRepositoryWorkPlacement } from "../../../src/runtime/control-plane/facade/repository-work-admission";
import { ensureRunningRepositoryWorkCheckout, reauthorizeRetainedCancelledRepositoryWork } from "../../../src/runtime/control-plane/execution/retained-work-resume";
import { currentPermissionSnapshotVersion } from "../../../src/runtime/control-plane/execution/validation";
import { observeRuntimeStatus } from "../../../src/runtime/root/status";
import { callExecutionTool } from "./execution-tools";
import { launchSuperController } from "../../../src/runtime/control-plane/launcher/thin-launcher";
import { getExternalControllerLaunchReservation } from "../../../src/runtime/control-plane/launcher/launch-reservation-store";
import { providerMcpReservationIdentity } from "../../../src/runtime/control-plane/launcher/provider-mcp-bootstrap";
import { runWorkChatgptContinuation, settleWorkChatgptAutomationTab } from "../../../src/runtime/control-plane/launcher/chatgpt-work-continuation";
import { chatgptControllerRoundBinding, chatgptControllerRoundRecoveryAuthorized, recordChatgptControllerRoundTabSettlement, renderChatgptControllerRoundPrompt, prepareControllerAssistantContext, prepareControllerAssistantContextBundle } from "../../../src/runtime/root/controller-round-composition";
import { assertControllerOwnershipAuthority, bindControllerSessionToCurrentRuntime, controllerSessionAuthorityDigest, controllerSessionAuthorityMatches, controllerSessionPrincipalId, getControllerSession, getRetainedControllerSession, mintControllerSessionAuthority, releaseControllerSessionWithAuthority, releaseObservedControllerSession, resumeControllerSession, withControllerSessionTerminalizationFence, type ControllerTerminalizationAuthority, acknowledgeControllerRoundClaim, beginControllerRoundRelayAfterRelease, beginInitialControllerRoundDispatch, bindControllerRoundSuccessorWork, reconcileControllerRoundAfterAbandonedRelease, reconcileControllerRoundAfterTerminalWork, finishControllerRoundRelayDispatch, getControllerRoundRelay, resolveRequirementControllerRoundRelayForWork, submitControllerRoundDisposition, type ControllerRoundRelayRecord, type ControllerRoundDisposition } from "../../../packages/kernel/controller/api/index";
import { parseControllerDispositionCompatibilityCapability, parseControllerRoundCompatibilityCapability, parsePlanObligationCompatibilityCapability } from "../controller-round-compatibility";
import { parseFrozenSemanticCompatibilityCapability } from "../frozen-client-semantic-compatibility";

export const RH_WORK_VERIFY_LEASE_WAIT_MS = DEFAULT_WORK_CHECK_LEASE_WAIT_MS;

export interface RuntimeIdentitySnapshot {
  releaseId?: string;
  artifactIdentity?: string;
  runtimeCommit?: string;
  buildCommit?: string;
  startedAt?: string;
  runtimeInstanceId?: string;
  controllerInstanceId?: string;
  endpoint?: string;
  running?: boolean;
  ready?: boolean;
  reasonCodes?: string[];
  toolset?: string;
  profile?: string;
}

export function runtimeIdentitySnapshot(ctx: MultiRepositoryMcpToolContext): RuntimeIdentitySnapshot {
  const observation = observeRuntimeStatus(ctx.controllerHome);
  const snapshot = observation.snapshot;
  return {
    releaseId: snapshot?.releaseId,
    artifactIdentity: snapshot?.artifactIdentity,
    startedAt: snapshot?.startedAt,
    runtimeInstanceId: snapshot?.runtimeInstanceId,
    controllerInstanceId: snapshot?.runtimeInstanceId,
    endpoint: snapshot?.endpoint,
    running: observation.running,
    ready: observation.ready,
    reasonCodes: observation.reasonCodes,
    toolset: ctx.toolset,
    profile: ctx.policy.profile,
  };
}

export function contextRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function contextText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function authenticatedFacadeControllerIdentity(
  ctx: MultiRepositoryMcpToolContext,
  args: Record<string, unknown>,
  options: { allowTransportSessionRollover?: boolean } = {},
): { controllerId: string; principalId: string; sessionId: string; transportSessionId?: string; controllerAuthorityId?: string; authorityViaSessionCompatibility?: boolean; controllerInstanceId: string; controllerType: 'chatgpt' | 'codex' | 'claude' | 'grok' | 'human' } {
  const principalId = ctx.principalId?.trim();
  const transportSessionId = ctx.sessionId?.trim();
  const requestedControllerId = typeof args.controller_id === 'string' ? args.controller_id.trim() : '';
  const requestedSessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
  const requestedAuthorityId = typeof args.controller_authority_id === 'string' ? args.controller_authority_id.trim() : '';
  if (!principalId) {
    // Preserve the bounded legacy stdio contract when no authenticated
    // transport identity exists at all. Modern MCP requests carry a principal
    // without a protocol session and reach the principal guard below; an
    // unauthenticated legacy request must not silently mint one.
    if (!transportSessionId && !requestedSessionId) {
      throw new Error('CONTROLLER_AUTHENTICATED_SESSION_REQUIRED: reconnect or provide session_id through the authenticated MCP transport');
    }
    throw new Error('CONTROLLER_AUTHENTICATED_PRINCIPAL_REQUIRED: use an authenticated MCP transport');
  }
  // Legacy MCP sessions remain replaceable transport bindings. Modern MCP has no
  // protocol session, so a fresh request-scoped execution binding is minted when
  // the caller does not provide an explicit compatibility carrier. Durable Work
  // authority is never derived from this request binding.
  const sessionId = transportSessionId || requestedSessionId || `mcp_request_${randomUUID().replace(/-/g, '')}`;
  const compatibilityAuthorityId = (!transportSessionId && requestedSessionId ? requestedSessionId : '')
    || (transportSessionId && requestedSessionId !== transportSessionId ? requestedSessionId : '');
  const controllerAuthorityId = requestedAuthorityId || compatibilityAuthorityId;
  const authorityViaSessionCompatibility = !requestedAuthorityId && Boolean(compatibilityAuthorityId);
  if (requestedControllerId && requestedControllerId !== principalId) {
    throw new Error('CONTROLLER_ID_CONTEXT_MISMATCH: controller_id must match the authenticated principal');
  }
  const requestedControllerType = typeof args.controller_type === 'string' && ['chatgpt', 'codex', 'claude', 'grok', 'human'].includes(args.controller_type)
    ? args.controller_type as 'chatgpt' | 'codex' | 'claude' | 'grok' | 'human'
    : undefined;
  const transportControllerType = ctx.controllerType;
  if (transportControllerType && requestedControllerType && requestedControllerType !== transportControllerType) {
    throw new Error('CONTROLLER_TYPE_CONTEXT_MISMATCH: controller_type must match the authenticated transport provider');
  }
  return {
    controllerId: principalId,
    principalId,
    sessionId,
    ...(transportSessionId ? { transportSessionId } : {}),
    ...(controllerAuthorityId ? { controllerAuthorityId } : {}),
    ...(authorityViaSessionCompatibility ? { authorityViaSessionCompatibility: true } : {}),
    controllerType: transportControllerType ?? requestedControllerType ?? 'chatgpt',
    controllerInstanceId: ctx.controllerInstanceId?.trim() || currentControllerInstanceId(),
  };
}

export function dispatchedChatgptRelayAuthorizesStaleControllerRecovery(
  store: { controllerHome: string; repoId: string },
  workId: string,
  relay: ControllerRoundRelayRecord | undefined,
  controllerType: 'chatgpt' | 'codex' | 'claude' | 'grok' | 'human',
): boolean {
  return controllerType === 'chatgpt' && chatgptControllerRoundRecoveryAuthorized(store, workId, relay);
}

export function assertFacadeControllerRoundAuthority(
  ctx: MultiRepositoryMcpToolContext,
  store: { controllerHome: string; repoId: string },
  workId: string,
  args: Record<string, unknown>,
): ControllerRoundRelayRecord | undefined {
  const identity = authenticatedFacadeControllerIdentity(ctx, args);
  return assertControllerRoundInvocationAuthority({
    ...store,
    workId,
    identity,
    relayScopeId: typeof args.relay_scope_id === 'string' ? args.relay_scope_id.trim() : undefined,
  });
}

export function sessionlessFacadeControllerAuthorityMatches(
  owner: NonNullable<ReturnType<typeof getControllerSession>> | undefined,
  identity: { transportSessionId?: string; controllerAuthorityId?: string },
): boolean {
  return controllerInvocationAuthorityMatches(owner, identity);
}

export function assertSessionlessFacadeControllerAuthority(
  owner: NonNullable<ReturnType<typeof getControllerSession>> | undefined,
  identity: { transportSessionId?: string; controllerAuthorityId?: string },
  workId: string,
): void {
  assertControllerInvocationAuthority(owner, identity, workId);
}

export function bindFacadeControllerOwnership(
  ctx: MultiRepositoryMcpToolContext,
  store: { controllerHome: string; repoId: string },
  workId: string,
  identity: ReturnType<typeof authenticatedFacadeControllerIdentity>,
  options: { allowClaimIfMissing?: boolean; leaseMs?: number } = {},
) {
  return bindControllerOwnershipForInvocation({
    ...store,
    workId,
    identity,
    runtime: runtimeIdentitySnapshot(ctx),
    allowClaimIfMissing: options.allowClaimIfMissing,
    leaseMs: options.leaseMs,
  });
}

export function currentFacadeTerminalizationAuthority(
  ctx: MultiRepositoryMcpToolContext,
  store: { controllerHome: string; repoId: string },
  workId: string,
  args: Record<string, unknown>,
): ControllerTerminalizationAuthority {
  const identity = authenticatedFacadeControllerIdentity(ctx, args);
  return controllerTerminalizationAuthorityForInvocation({
    ...store,
    workId,
    identity,
    relayScopeId: typeof args.relay_scope_id === 'string' ? args.relay_scope_id.trim() : undefined,
    runtime: runtimeIdentitySnapshot(ctx),
  });
}

export function currentTerminalCleanupAuthority(
  ctx: MultiRepositoryMcpToolContext,
  store: { controllerHome: string; repoId: string },
  workId: string,
  args: Record<string, unknown>,
): ControllerTerminalizationAuthority {
  const identity = authenticatedFacadeControllerIdentity(ctx, args);
  return terminalCleanupAuthorityForInvocation({
    ...store,
    workId,
    identity,
    relayScopeId: typeof args.relay_scope_id === 'string' ? args.relay_scope_id.trim() : undefined,
  });
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

export function planObligationDispositionsFromArgs(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({
      predecessorPlanId: String(entry.predecessor_plan_id ?? ''),
      obligationId: String(entry.obligation_id ?? ''),
      disposition: String(entry.disposition ?? '') as 'keep' | 'change' | 'defer' | 'drop',
      successorRefs: Array.isArray(entry.successor_refs) ? entry.successor_refs.map(String) : [],
      rationale: typeof entry.rationale === 'string' ? entry.rationale : undefined,
    }));
}

export async function runFacadeRepair(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const store = {
    controllerHome: ctx.controllerHome,
    repoId: repository.repoId,
    revisionContains: (ancestorRevision: string, descendantRevision: string) =>
      repositoryRevisionContains(repository.canonicalRoot, ancestorRevision, descendantRevision),
  };
  let maintenanceSnapshot: ReturnType<typeof buildRuntimeMaintenanceStatus> | undefined;
  let maintenanceStatus: {
    readyForExecution?: boolean;
    recommendedActions?: string[];
    candidates?: Array<{ kind?: string; reason?: string; suggestedAction?: string; safe?: boolean }>;
    warnings?: string[];
  } | undefined;
  try {
    const status = buildRuntimeMaintenanceStatus(repository, ctx.controllerHome, {
      minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
      maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : 20,
    });
    maintenanceSnapshot = status;
    maintenanceStatus = {
      readyForExecution: status.readyForExecution,
      recommendedActions: status.recommendedActions,
      candidates: status.candidates.map((candidate) => ({
        kind: candidate.kind,
        reason: candidate.reason,
        suggestedAction: candidate.suggestedAction,
        safe: candidate.safe,
      })),
      warnings: status.warnings,
    };
  } catch {
    maintenanceStatus = {
      readyForExecution: false,
      recommendedActions: [],
      candidates: [],
      warnings: ['runtime_maintenance_status inspection failed; treating as infrastructure issue, not acceptance failure'],
    };
  }

  const repairOperation = args.repair_operation === 'repair' || args.repair_operation === 'verify' || args.repair_operation === 'handoff'
    ? args.repair_operation
    : 'diagnose';
  const dryRun = args.dry_run === undefined ? true : args.dry_run === true;
  const elevatedRepair = args.destructive === true || args.remote_write === true || args.remote_effect === true;
  const planId = typeof args.plan_id === 'string' ? args.plan_id.trim() : '';
  const planStepId = typeof args.plan_step_id === 'string' ? args.plan_step_id.trim() : '';
  const exactWorkId = typeof args.work_id === 'string' ? args.work_id.trim() : '';

  if (planId && !planStepId) {
    const plan = getPlanContract(store, planId);
    if (!plan) {
      const facade = buildFacadeResult({ status: 'not_found', summary: `PlanContract ${planId} not found.`, data: { operation: repairOperation, dryRun, planId, repaired: false } });
      return result(facade as unknown as Record<string, unknown>, true);
    }
    const pendingRevision = plan.status === 'replanning' ? plan.pendingRevision : undefined;
    if (plan.status !== 'draft' && !pendingRevision) {
      const facade = buildFacadeResult({ status: 'blocked', summary: `PLAN_DRAFT_REPAIR_STATUS_INVALID: ${plan.planId}:${plan.status}`, data: { operation: repairOperation, dryRun, planId, repaired: false } });
      return result(facade as unknown as Record<string, unknown>, true);
    }
    const repairBase = pendingRevision ?? plan;
    if (repairOperation !== 'repair' || dryRun) {
      const facade = buildFacadeResult({
        summary: pendingRevision
          ? `PlanContract ${plan.planId} has staged revision r${pendingRevision.revision}. Exact in-place revision repair is available; stable Plan identity and committed revision remain authoritative until approval.`
          : `PlanContract ${plan.planId} is a draft. Exact in-place repair is available; the Plan identity and Requirement authority are preserved and only a fully valid draft may be persisted.`,
        data: { operation: repairOperation, dryRun, plan: summarizePlanContract(plan), repaired: false, repairRequired: true },
        suggestedNextActions: [{ label: 'Repair this exact draft Plan', tool: 'rh_work', operation: 'repair', payload: { plan_id: plan.planId, repair_operation: 'repair', dry_run: false }, risk: 'workspace_write', confidence: 'high' }],
      });
      return result(facade as unknown as Record<string, unknown>);
    }
    const rawSteps = Array.isArray(args.plan_steps)
      ? args.plan_steps
      : repairBase.steps.map((step) => ({
          id: step.id, objective: step.objective, dependencies: step.dependencies, authoritative_files: step.authoritativeFiles,
          allowed_paths: step.allowedPaths, forbidden_paths: step.forbiddenPaths, check_ids: step.checks, acceptance_criteria: step.acceptanceCriteria,
        }));
    const steps = rawSteps
      .filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === 'object' && !Array.isArray(step))
      .map((step) => ({
        id: String(step.id ?? ''),
        objective: String(step.objective ?? ''),
        dependencies: Array.isArray(step.dependencies) ? step.dependencies.map(String) : [],
        authoritativeFiles: Array.isArray(step.authoritative_files) ? step.authoritative_files.map(String) : [],
        allowedPaths: Array.isArray(step.allowed_paths) ? step.allowed_paths.map(String) : [],
        forbiddenPaths: Array.isArray(step.forbidden_paths) ? step.forbidden_paths.map(String) : [],
        checks: Array.isArray(step.check_ids) ? step.check_ids.map(String) : [],
        acceptanceCriteria: Array.isArray(step.acceptance_criteria) ? step.acceptance_criteria.map(String) : [],
      }));
    const availableChecks = listControllerChecks(repository.canonicalRoot);
    const normalizedPlanChecks = normalizeCheckIds(steps.flatMap((step) => step.checks), availableChecks);
    if (normalizedPlanChecks.invalidCheckIds.length > 0) {
      const facade = buildFacadeResult({
        status: 'failed',
        summary: `PLAN_CHECKS_INVALID: ${normalizedPlanChecks.invalidCheckIds.join(', ')}. Draft repair was not persisted.`,
        data: { operation: repairOperation, dryRun: false, planId, repaired: false, normalizedChecks: normalizedPlanChecks, registeredCheckIds: availableChecks.map((check) => check.id).slice(0, 80) },
        suggestedNextActions: [],
      });
      return result(facade as unknown as Record<string, unknown>, true);
    }
    try {
      const repaired = await repairDraftPlanContractAsync(store, planId, {
        expectedSourceRevision: repairBase.sourceRevision,
        scopeKey: typeof args.scope_key === 'string' ? args.scope_key : plan.scopeKey,
        sourceRevision: typeof args.source_revision === 'string' ? args.source_revision : repairBase.sourceRevision,
        goal: typeof args.objective === 'string' ? args.objective : repairBase.goal,
        nonGoals: Array.isArray(args.non_goals) ? args.non_goals.map(String) : repairBase.nonGoals,
        assumptions: Array.isArray(args.assumptions) ? args.assumptions.map(String) : repairBase.assumptions,
        resolvedDecisions: Array.isArray(args.resolved_decisions) ? args.resolved_decisions.map(String) : repairBase.resolvedDecisions,
        stopConditions: Array.isArray(args.stop_conditions) ? args.stop_conditions.map(String) : repairBase.stopConditions,
        replanConditions: Array.isArray(args.replan_conditions) ? args.replan_conditions.map(String) : repairBase.replanConditions,
        integrationStrategy: typeof args.integration_strategy === 'string' ? args.integration_strategy : repairBase.integrationStrategy,
        obligationDispositions: planObligationDispositionsFromArgs(args.obligation_dispositions) ?? repairBase.obligationDispositions,
        steps,
      });
      const facade = buildFacadeResult({
        summary: pendingRevision ? `PlanContract ${repaired.planId} staged revision repaired in place; stable Plan identity and committed authority were preserved.` : `PlanContract ${repaired.planId} draft repaired in place; identity and Requirement authority were preserved.`,
        data: { operation: repairOperation, dryRun: false, plan: summarizePlanContract(repaired), repaired: true, replacementPlanCreated: false },
        suggestedNextActions: [{ label: 'Approve reviewed plan', tool: 'rh_work', operation: 'plan_approve', payload: { plan_id: repaired.planId }, risk: 'workspace_write', confidence: 'medium' }],
      });
      return result(facade as unknown as Record<string, unknown>);
    } catch (error) {
      const facade = buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'PLAN_DRAFT_REPAIR_FAILED', data: { operation: repairOperation, dryRun: false, planId, repaired: false } });
      return result(facade as unknown as Record<string, unknown>, true);
    }
  }

  if (planStepId && !planId) {
    const facade = buildFacadeResult({ status: 'blocked', summary: 'PLAN_STEP_REPAIR_CONTEXT_REQUIRED: plan_id and plan_step_id are both required.', data: { operation: repairOperation, dryRun, repaired: false } });
    return result(facade as unknown as Record<string, unknown>, true);
  }

  if (planId && planStepId) {
    const plan = getPlanContract(store, planId);
    const step = plan?.steps.find((candidate) => candidate.id === planStepId);
    if (!plan || !step) {
      const facade = buildFacadeResult({ status: 'not_found', summary: !plan ? `PlanContract ${planId} not found.` : `PLAN_STEP_NOT_FOUND: ${planStepId}`, data: { operation: repairOperation, dryRun, planId, planStepId, repaired: false } });
      return result(facade as unknown as Record<string, unknown>, true);
    }
    if (!step.workId) {
      const facade = buildFacadeResult({ summary: `Plan step ${planId}/${planStepId} has no Work binding to repair.`, data: { operation: repairOperation, dryRun, planId, planStepId, repaired: false, repairRequired: false } });
      return result(facade as unknown as Record<string, unknown>);
    }
    const boundWork = getWorkContract(store, step.workId);
    if (boundWork) {
      if (['completed', 'failed', 'cancelled'].includes(boundWork.status)) {
        if (repairOperation !== 'repair' || dryRun) {
          const facade = buildFacadeResult({
            summary: `PLAN_STEP_TERMINAL_WORK_RECONCILIABLE: ${planId}/${planStepId} is bound to existing terminal Work ${boundWork.workId}. Explicit repair can project that exact Work without creating a replacement.`,
            data: { operation: repairOperation, dryRun, planId, planStepId, boundWorkId: boundWork.workId, repaired: false, repairRequired: true, reusedExistingWork: true },
            suggestedNextActions: [{ label: 'Project existing terminal Work', tool: 'rh_work', operation: 'repair', payload: { plan_id: planId, plan_step_id: planStepId, repair_operation: 'repair', dry_run: false }, risk: 'workspace_write', confidence: 'high' }],
          });
          return result(facade as unknown as Record<string, unknown>);
        }
        try {
          const reconciledPlan = completePlanStepForWork(store, { planId, stepId: planStepId, work: boundWork });
          const facade = buildFacadeResult({
            summary: `Reconciled Plan step ${planId}/${planStepId} from its existing terminal Work ${boundWork.workId}; no replacement Work was created.`,
            data: { operation: repairOperation, dryRun: false, plan: summarizePlanContract(reconciledPlan), boundWorkId: boundWork.workId, repaired: true, reusedExistingWork: true },
          });
          return result(facade as unknown as Record<string, unknown>);
        } catch (error) {
          const facade = buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'PLAN_STEP_TERMINAL_WORK_RECONCILIATION_FAILED', data: { operation: repairOperation, dryRun: false, planId, planStepId, boundWorkId: boundWork.workId, repaired: false } });
          return result(facade as unknown as Record<string, unknown>, true);
        }
      }
      const requestedRevisionLabel = typeof args.superseded_by === 'string' ? args.superseded_by.trim() : '';
      const requestedAllowedPaths = Array.isArray(args.allowed_paths)
        ? [...new Set([...step.allowedPaths, ...args.allowed_paths.map(String).map((value) => value.trim()).filter(Boolean)])]
        : step.allowedPaths;
      const scopeReplanRequested = Boolean(requestedRevisionLabel) || requestedAllowedPaths.length > step.allowedPaths.length;
      if (scopeReplanRequested) {
        const requestedSourceRevision = typeof args.source_revision === 'string' ? args.source_revision.trim() : '';
        if (!requestedRevisionLabel || !requestedSourceRevision || requestedAllowedPaths.length === step.allowedPaths.length) {
          const facade = buildFacadeResult({
            status: 'blocked',
            summary: 'PLAN_WORK_SCOPE_REPLAN_INPUT_REQUIRED: superseded_by, source_revision, and at least one new allowed_paths entry are required for an active Plan-bound Work scope replan.',
            data: { operation: repairOperation, dryRun, planId, planStepId, boundWorkId: boundWork.workId, repaired: false, requestedRevisionLabel: requestedRevisionLabel || undefined, requestedSourceRevision: requestedSourceRevision || undefined, requestedAllowedPaths },
          });
          return result(facade as unknown as Record<string, unknown>, true);
        }
        if (repairOperation !== 'repair' || dryRun) {
          const facade = buildFacadeResult({
            summary: `PLAN_WORK_SCOPE_REPLAN_AVAILABLE: ${planId}/${planStepId} can atomically move exact Work ${boundWork.workId} to stable Plan ${planId} revision label ${requestedRevisionLabel} while widening only allowed-path authority.`,
            data: { operation: repairOperation, dryRun, planId, planStepId, boundWorkId: boundWork.workId, requestedRevisionLabel, requestedSourceRevision, requestedAllowedPaths, repaired: false, repairRequired: true, reusedExistingWork: true },
            suggestedNextActions: [{ label: 'Replan exact active Work scope', tool: 'rh_work', operation: 'repair', payload: { plan_id: planId, plan_step_id: planStepId, superseded_by: requestedRevisionLabel, source_revision: requestedSourceRevision, allowed_paths: requestedAllowedPaths, repair_operation: 'repair', dry_run: false }, risk: 'workspace_write', confidence: 'high' }],
          });
          return result(facade as unknown as Record<string, unknown>);
        }
        try {
          const replanned = replanActivePlanBoundWorkScope(store, {
            planId,
            stepId: planStepId,
            workId: boundWork.workId,
            requestedRevisionLabel,
            sourceRevision: requestedSourceRevision,
            allowedPaths: requestedAllowedPaths,
            reason: typeof args.reason === 'string' && args.reason.trim()
              ? args.reason.trim()
              : 'Explicit Controller repair widened a frozen Plan path fence after current-source evidence proved the existing Plan contract omitted a path required by its own acceptance scope.',
          });
          const facade = buildFacadeResult({
            summary: `Replanned ${planId}/${planStepId} as ${replanned.currentPlan.planId} r${replanned.currentPlan.revision ?? 1} and retained the same active Work ${replanned.work.workId} atomically; semantic acceptance and checks were not widened.`,
            data: { operation: repairOperation, dryRun: false, priorPlan: summarizePlanContract(replanned.priorPlan), currentPlan: summarizePlanContract(replanned.currentPlan), work: summarizeWorkContract(replanned.work), repaired: true, replacementWorkCreated: false, reusedExistingWork: true },
          });
          return result(facade as unknown as Record<string, unknown>);
        } catch (error) {
          const facade = buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'PLAN_WORK_SCOPE_REPLAN_FAILED', data: { operation: repairOperation, dryRun: false, planId, planStepId, boundWorkId: boundWork.workId, requestedRevisionLabel, repaired: false } });
          return result(facade as unknown as Record<string, unknown>, true);
        }
      }
      const facade = buildFacadeResult({
        status: 'blocked',
        summary: `PLAN_STEP_BOUND_WORK_STILL_EXISTS: ${planId}/${planStepId} is bound to active Work ${boundWork.workId}; continue that exact Work, or explicitly request a scope-only stable Plan revision instead of replacing the Work.`,
        data: { operation: repairOperation, dryRun, planId, planStepId, boundWorkId: boundWork.workId, repaired: false, repairRequired: false },
        suggestedNextActions: [{ label: 'Continue existing Work', tool: 'rh_work', operation: 'continue', payload: { work_id: boundWork.workId }, risk: 'readonly', confidence: 'high' }],
      });
      return result(facade as unknown as Record<string, unknown>, true);
    }
    const conflicting = listWorkContracts({ ...store, status: 'active', limit: 200 })
      .filter((candidate) => candidate.planId === planId && candidate.planStepId === planStepId && candidate.workId !== step.workId);
    if (conflicting.length > 0) {
      const facade = buildFacadeResult({
        status: 'blocked',
        summary: `PLAN_STEP_REPAIR_CONFLICT: ${planId}/${planStepId} is bound to missing Work ${step.workId}, but ${conflicting.length} other active Work record(s) claim the same step. Resolve the conflicting authority before changing the Plan binding.`,
        data: { operation: repairOperation, dryRun, planId, planStepId, boundWorkId: step.workId, conflictingWorkIds: conflicting.map((candidate) => candidate.workId), repaired: false },
      });
      return result(facade as unknown as Record<string, unknown>, true);
    }
    if (repairOperation !== 'repair' || dryRun) {
      const facade = buildFacadeResult({
        summary: `PLAN_STEP_DANGLING_WORK_BINDING: ${planId}/${planStepId} points to missing Work ${step.workId}. Exact repair is available and will clear only this unchanged ghost binding.`,
        data: { operation: repairOperation, dryRun, planId, planStepId, boundWorkId: step.workId, repaired: false, repairRequired: true },
        suggestedNextActions: [{ label: 'Repair exact dangling binding', tool: 'rh_work', operation: 'repair', payload: { plan_id: planId, plan_step_id: planStepId, repair_operation: 'repair', dry_run: false }, risk: 'workspace_write', confidence: 'high' }],
      });
      return result(facade as unknown as Record<string, unknown>);
    }
    try {
      const repairedPlan = repairDanglingPlanStepWorkBinding(store, {
        planId,
        stepId: planStepId,
        expectedWorkId: step.workId,
        reason: 'Explicit Controller repair confirmed that the exact bound Work record is absent and no other active primary Work claims this Plan step.',
      });
      const facade = buildFacadeResult({
        summary: `Repaired dangling Plan step binding ${planId}/${planStepId}; ${step.workId} was cleared without creating a replacement Work.`,
        data: { operation: repairOperation, dryRun: false, plan: summarizePlanContract(repairedPlan), boundWorkId: step.workId, repaired: true, replacementWorkCreated: false },
      });
      return result(facade as unknown as Record<string, unknown>);
    } catch (error) {
      const facade = buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'PLAN_STEP_DANGLING_WORK_REPAIR_FAILED', data: { operation: repairOperation, dryRun: false, planId, planStepId, boundWorkId: step.workId, repaired: false } });
      return result(facade as unknown as Record<string, unknown>, true);
    }
  }

  // The self-healing facade is a policy/planning surface; the authoritative
  // maintenance executor owns mutations. Execute it here only for an explicit,
  // non-dry-run repair whose entire observed candidate set is already classified
  // safe. Unsafe/destructive/remote repair continues through the approval path.
  if (
    repairOperation === 'repair'
    && !dryRun
    && !elevatedRepair
    && !exactWorkId
    && maintenanceSnapshot
    && maintenanceSnapshot.candidates.length > 0
  ) {
    const applied = applyRuntimeMaintenance(repository, ctx.controllerHome, {
      actionId: 'full_maintenance_pass',
      confirmMaintenance: true,
      minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
      maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : 20,
    });
    const actions = applied.applied.slice(0, 20).map((entry) => ({
      kind: entry.kind,
      id: entry.id,
      applied: entry.applied,
      result: entry.result,
      ...(entry.error ? { error: entry.error.slice(0, 300) } : {}),
    }));
    const appliedCount = applied.applied.filter((entry) => entry.applied).length;
    // Protected stale runtime temp entries are intentionally non-blocking maintenance
    // diagnostics. Keep repair completion semantics aligned with rh_status readiness so
    // their presence does not falsely report a blocked repair after safe debt is cleared.
    const remainingCandidateCount = applied.candidates.filter((candidate) => candidate.kind !== 'stale_runtime_temp_entry').length;
    const blocked = remainingCandidateCount > 0;
    const facade = buildFacadeResult({
      status: blocked ? 'blocked' : 'ok',
      summary: blocked
        ? `Runtime maintenance applied ${appliedCount} candidate(s); ${remainingCandidateCount} candidate(s) remain after the authoritative executor pass.`
        : `Runtime maintenance applied ${appliedCount} candidate(s); no maintenance candidates remain.`,
      data: {
        operation: 'repair',
        dryRun: false,
        applied: appliedCount > 0,
        actionId: 'full_maintenance_pass',
        appliedCount,
        remainingCandidateCount,
        actions,
        classification: 'infrastructure_recovery',
        isAcceptanceFailure: false,
      },
      warnings: applied.warnings.slice(0, 5),
      suggestedNextActions: [{
        label: 'Verify controller status after repair',
        tool: 'rh_status',
        operation: 'get',
        risk: 'readonly',
        confidence: 'high',
      }],
      rawAvailable: false,
    });
    return result(facade as unknown as Record<string, unknown>, blocked);
  }

  let watchdogSummary: string | undefined;
  let performanceSummary: string | undefined;
  try {
    const watchdog = buildWorkflowWatchdogReport(ctx.controllerHome, repository, { includeProcesses: false });
    watchdogSummary = `status=${watchdog.status}; findings=${watchdog.findings.length}; stale=${watchdog.staleWork.length}`.slice(0, 240);
  } catch {
    watchdogSummary = undefined;
  }
  try {
    const perf = collectRuntimePerformanceDiagnostics({
      repoId: repository.repoId,
      repoRoot: repository.canonicalRoot,
      includeProcesses: false,
      includeTempDirs: false,
    });
    performanceSummary = perf.summary.slice(0, 240);
  } catch {
    performanceSummary = undefined;
  }

  const daemon = readForgeRuntimeStatus(ctx.controllerHome);
  const readiness = await controllerReadinessEvidence(ctx, repository);
  const facade = runSelfHealingLoop(
    { repoId: repository.repoId, handoffStore: store },
    {
      operation: repairOperation,
      dryRun,
      approvalConfirmed: args.approval_confirmed === true,
      workId: typeof args.work_id === 'string' ? args.work_id : undefined,
      chatgptPullFailed: args.chatgpt_pull_failed === true,
      destructive: args.destructive === true,
      remoteEffect: args.remote_write === true || args.remote_effect === true,
      maintenanceStatus,
      diagnostics: {
        watchdogSummary,
        performanceSummary,
        controllerDaemonUnhealthy: daemon.status !== 'ready',
        schedulerUnhealthy: readiness.durableScheduler.status !== 'ready',
        codexUnavailable: args.codex_available === false,
        grokUnavailable: args.grok_available === false || args.target === 'grok',
        pluginUnavailable: args.plugin_unavailable === true,
      },
    },
  );
  return result(facade as unknown as Record<string, unknown>, facade.status === 'blocked' || facade.status === 'approval_required' || facade.status === 'failed');
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
      const evidenceState = classifyPersistedCheckTerminalEvidence(record, normalizedCheckId, { legacyEvidence });
      const failureClass = evidenceState.failureClass;
      const infrastructureFailed = receipt.timedOut
        || receipt.cancelled
        || evidenceState.state !== 'matched'
        || (!receipt.ok && failureClass !== 'acceptance_failure');
      const checkFailed = !receipt.ok && !infrastructureFailed;
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
  const verification = await executeWorkVerification({
    controllerHome: ctx.controllerHome,
    repository,
    workId: workId || undefined,
    checkId: String(args.check_id ?? args.checkId ?? '').trim(),
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
    allowDurableCheckExecution: workId ? ({ work }) => {
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
  });
  return result(verification.facade as unknown as Record<string, unknown>, verification.isError);
}

/** MCP rh_work transport adapter. Canonical lifecycle semantics remain in Kernel/application services; this layer normalizes ABI input and orchestrates those services. */
export async function callWorkAdapter(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>): Promise<CallToolResult> {
  {
          const repository = selected(ctx, args);
          const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
          const requestedOperation = String(args.operation ?? 'start');
          const frozenScheduleDeleteId = requestedOperation === 'repair' && typeof args.capability_id === 'string' && args.capability_id.startsWith('schedule.delete:')
            ? args.capability_id.slice('schedule.delete:'.length).trim()
            : '';
          let frozenImplementationReview: { decision: 'approved' | 'changes_required' | 'blocked'; workId: string } | undefined;
          let frozenControllerDisposition: ReturnType<typeof parseControllerDispositionCompatibilityCapability>;
          let frozenControllerRoundOperation: ReturnType<typeof parseControllerRoundCompatibilityCapability>;
          let frozenPlanObligationDispositions: ReturnType<typeof parsePlanObligationCompatibilityCapability>;
          let frozenSemanticOperation: ReturnType<typeof parseFrozenSemanticCompatibilityCapability>;
          try {
            if (requestedOperation === 'repair' && typeof args.capability_id === 'string') {
              const capability = args.capability_id.trim();
              const prefix = 'work.review:';
              if (capability.startsWith(prefix)) {
                const remainder = capability.slice(prefix.length);
                const separator = remainder.indexOf(':');
                if (separator <= 0 || separator === remainder.length - 1) throw new Error('WORK_IMPLEMENTATION_REVIEW_COMPATIBILITY_INVALID');
                const decision = remainder.slice(0, separator);
                const workId = remainder.slice(separator + 1).trim();
                if (!['approved', 'changes_required', 'blocked'].includes(decision) || !workId) throw new Error('WORK_IMPLEMENTATION_REVIEW_COMPATIBILITY_INVALID');
                frozenImplementationReview = { decision: decision as 'approved' | 'changes_required' | 'blocked', workId };
              }
            }
            frozenControllerDisposition = parseControllerDispositionCompatibilityCapability(requestedOperation, args.capability_id);
            frozenControllerRoundOperation = parseControllerRoundCompatibilityCapability(requestedOperation, args.capability_id);
            frozenPlanObligationDispositions = parsePlanObligationCompatibilityCapability(requestedOperation, args.capability_id);
            frozenSemanticOperation = parseFrozenSemanticCompatibilityCapability(requestedOperation, args.capability_id);
            if (frozenControllerDisposition
              && (args.relay_scope_id !== undefined || (frozenControllerDisposition.authorityId && args.controller_authority_id !== undefined))) {
              throw new Error('CONTROLLER_RELAY_DISPOSITION_COMPATIBILITY_CONFLICT');
            }
            if (frozenPlanObligationDispositions && Array.isArray(args.obligation_dispositions)) {
              throw new Error('PLAN_OBLIGATION_COMPATIBILITY_CONFLICT');
            }
            if (frozenSemanticOperation) {
              const requirementScoped = frozenSemanticOperation.operation !== 'work_review';
              if (requirementScoped) {
                const requirementId = typeof args.requirement_id === 'string' ? args.requirement_id.trim() : '';
                if (!requirementId) throw new Error('FROZEN_SEMANTIC_COMPATIBILITY_SCOPE_REQUIRED: requirement_id must remain explicit outside the compatibility envelope');
              }
              for (const key of Object.keys(frozenSemanticOperation.args)) {
                if (args[key] !== undefined) throw new Error(`FROZEN_SEMANTIC_COMPATIBILITY_CONFLICT: native field ${key} is also present`);
              }
              if (frozenSemanticOperation.operation === 'work_review') {
                const explicitWorkId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
                if (!explicitWorkId) throw new Error('FROZEN_SEMANTIC_COMPATIBILITY_SCOPE_REQUIRED: work_id must remain explicit outside the work_review envelope');
                if (frozenImplementationReview) throw new Error('WORK_IMPLEMENTATION_REVIEW_COMPATIBILITY_CONFLICT');
                if (args.review_decision !== undefined || args.review_rationale !== undefined) {
                  throw new Error('WORK_IMPLEMENTATION_REVIEW_COMPATIBILITY_CONFLICT');
                }
              }
            }
          } catch (error) {
            return result(buildFacadeResult({
              status: 'blocked',
              summary: error instanceof Error ? error.message : 'Controller round compatibility input is invalid.',
              data: {},
            }) as unknown as Record<string, unknown>, true);
          }
          if (frozenControllerRoundOperation) {
            args.relay_scope_id = frozenControllerRoundOperation.relayScopeId;
            args.controller_authority_id = frozenControllerRoundOperation.authorityId;
            if (frozenControllerRoundOperation.operation === 'review') {
              if (args.review_decision !== undefined || args.review_rationale !== undefined) {
                return result(buildFacadeResult({
                  status: 'blocked',
                  summary: 'CONTROLLER_ROUND_REVIEW_COMPATIBILITY_CONFLICT: native review fields cannot be combined with the frozen review carrier.',
                  data: {},
                }) as unknown as Record<string, unknown>, true);
              }
              args.review_decision = frozenControllerRoundOperation.reviewDecision;
              args.review_rationale = typeof args.reason === 'string' ? args.reason : '';
            }
          }
          if (frozenControllerDisposition) {
            args.relay_scope_id = frozenControllerDisposition.relayScopeId;
            if (frozenControllerDisposition.authorityId) args.controller_authority_id = frozenControllerDisposition.authorityId;
          }
          if (frozenPlanObligationDispositions) {
            args.obligation_dispositions = frozenPlanObligationDispositions;
          }
          if (frozenSemanticOperation?.operation === 'plan_create') {
            // Frozen semantic compatibility fills only the field absent from the
            // older schema. Plan identity/scope/source/steps/relation remain native
            // arguments and canonical Plan admission/continuity stays authoritative.
            args.obligation_dispositions = frozenSemanticOperation.args.obligation_dispositions;
          }
          if (frozenSemanticOperation?.operation === 'start') {
            // Older rh_work schemas may lack the technical fields required to admit a
            // terminal Plan successor. The bounded envelope fills only those closed
            // fields; objective, Requirement/Plan binding, route policy, engineering
            // verification, ControllerRound authority and lifecycle remain canonical.
            Object.assign(args, frozenSemanticOperation.args);
          }
          if (frozenSemanticOperation?.operation === 'work_review') {
            args.review_decision = frozenSemanticOperation.args.decision;
            args.review_rationale = typeof args.reason === 'string' ? args.reason : '';
          }
          if (frozenImplementationReview) {
            const explicitWorkId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
            if (!explicitWorkId || explicitWorkId !== frozenImplementationReview.workId) {
              return result(buildFacadeResult({
                status: 'blocked',
                summary: `WORK_IMPLEMENTATION_REVIEW_SCOPE_MISMATCH: capability targets ${frozenImplementationReview.workId}; exact work_id is required.`,
                data: { workId: frozenImplementationReview.workId, implementationReviewRecorded: false },
              }) as unknown as Record<string, unknown>, true);
            }
            args.review_decision = frozenImplementationReview.decision;
            args.review_rationale = typeof args.reason === 'string' ? args.reason : '';
          }
          const frozenSemanticFacadeOperation = frozenSemanticOperation?.operation === 'work_review'
            ? 'review'
            : frozenSemanticOperation?.operation;
          const operation = frozenSemanticFacadeOperation ?? frozenControllerRoundOperation?.operation ?? (frozenControllerDisposition
            ? 'controller_disposition'
            : frozenImplementationReview ? 'review'
            : frozenScheduleDeleteId ? 'schedule_delete' : requestedOperation);
          if (!allowedFacadeOperations('rh_work').includes(operation)) {
            return invalidFacadeOperation('rh_work', operation);
          }
          if (operation.startsWith('schedule_')) {
            try {
              const workId = String(args.work_id ?? '').trim();
              const scheduleId = frozenScheduleDeleteId || String(args.schedule_id ?? '').trim();
              if (operation === 'schedule_create') {
                const controllerType = String(args.controller_type ?? 'chatgpt').trim();
                if (!['chatgpt', 'codex', 'claude', 'grok'].includes(controllerType)) throw new Error('CONTROLLER_TYPE_INVALID');
                const triggerTypeRaw = String(args.trigger_type ?? '').trim();
                const triggerType = ['interval', 'cron', 'calendar', 'condition', 'repository-event', 'dependency-checkpoint', 'manual'].includes(triggerTypeRaw)
                  ? triggerTypeRaw as 'interval' | 'cron' | 'calendar' | 'condition' | 'repository-event' | 'dependency-checkpoint' | 'manual'
                  : undefined;
                const scheduleModeRaw = String(args.schedule_mode ?? (workId ? 'continuation' : '')).trim();
                if (!['continuation', 'browser_watch', 'browser_keepalive'].includes(scheduleModeRaw)) throw new Error('SCHEDULE_MODE_REQUIRES_WORK_OR_EXPLICIT_BROWSER_KEEPALIVE');
                const created = createWorkContinuationSchedule(ctx.controllerHome, repository.repoId, {
                  workId,
                  scheduleMode: scheduleModeRaw as 'continuation' | 'browser_watch' | 'browser_keepalive',
                  controllerType: controllerType as ContinuationControllerType,
                  executable: typeof args.executable === 'string' ? args.executable : undefined,
                  launchArgs: Array.isArray(args.launch_args) ? args.launch_args.map(String) : undefined,
                  launchReservationMs: typeof args.launch_reservation_ms === 'number' ? args.launch_reservation_ms : typeof args.lease_ms === 'number' ? args.lease_ms : undefined,
                  handoffId: typeof args.handoff_id === 'string' ? args.handoff_id : undefined,
                  browserSessionId: typeof args.browser_session_id === 'string' ? args.browser_session_id : undefined,
                  conversationUrl: typeof args.conversation_url === 'string' ? args.conversation_url : undefined,
                  continuationPrompt: typeof args.continuation_prompt === 'string' ? args.continuation_prompt : undefined,
                  probeUrl: typeof args.probe_url === 'string' ? args.probe_url : undefined,
                  probeBrowserSessionId: typeof args.probe_browser_session_id === 'string' ? args.probe_browser_session_id : undefined,
                  probeSelector: typeof args.probe_selector === 'string' ? args.probe_selector : undefined,
                  probeMaxChars: typeof args.probe_max_chars === 'number' ? args.probe_max_chars : undefined,
                  probeTimeoutMs: typeof args.probe_timeout_ms === 'number' ? args.probe_timeout_ms : undefined,
                  includeTerms: Array.isArray(args.include_terms) ? args.include_terms.map(String) : undefined,
                  ignorePatterns: Array.isArray(args.ignore_patterns) ? args.ignore_patterns.map(String) : undefined,
                  loginUrlTerms: Array.isArray(args.login_url_terms) ? args.login_url_terms.map(String) : undefined,
                  loginTextTerms: Array.isArray(args.login_text_terms) ? args.login_text_terms.map(String) : undefined,
                  wakeOnFirstObservation: args.wake_on_first_observation === true,
                  wakeOnAuthRequired: args.wake_on_auth_required !== false,
                  authRequiredPrompt: typeof args.auth_required_prompt === 'string' ? args.auth_required_prompt : undefined,
                  scheduleName: typeof args.schedule_name === 'string' ? args.schedule_name : undefined,
                  requestId: typeof args.schedule_request_id === 'string' ? args.schedule_request_id : undefined,
                  triggerType,
                  everyMinutes: typeof args.every_minutes === 'number' ? args.every_minutes : undefined,
                  cronExpression: typeof args.cron_expression === 'string' ? args.cron_expression : undefined,
                  timezone: typeof args.schedule_timezone === 'string' ? args.schedule_timezone : undefined,
                  catchUpMinutes: typeof args.catch_up_minutes === 'number' ? args.catch_up_minutes : undefined,
                  calendarAt: typeof args.calendar_at === 'string' ? args.calendar_at : undefined,
                  condition: args.condition && typeof args.condition === 'object' && !Array.isArray(args.condition) ? args.condition as never : undefined,
                  eventName: typeof args.event_name === 'string' ? args.event_name : undefined,
                  dependencyJobIds: Array.isArray(args.dependency_job_ids) ? args.dependency_job_ids.map(String) : undefined,
                  maxFailures: typeof args.max_failures === 'number' ? args.max_failures : undefined,
                  cooldownMinutes: typeof args.cooldown_minutes === 'number' ? args.cooldown_minutes : undefined,
                  dailyBudgetMinutes: typeof args.daily_budget_minutes === 'number' ? args.daily_budget_minutes : undefined,
                  shadowMode: typeof args.shadow_mode === 'boolean' ? args.shadow_mode : undefined,
                  backoffBaseMinutes: typeof args.backoff_base_minutes === 'number' ? args.backoff_base_minutes : undefined,
                  backoffMaxMinutes: typeof args.backoff_max_minutes === 'number' ? args.backoff_max_minutes : undefined,
                  stopConditions: Array.isArray(args.stop_conditions) ? args.stop_conditions.map(String) : undefined,
                });
                return result(buildFacadeResult({
                  summary: created.work
                    ? `Work schedule ${created.schedule.scheduleId} is configured for Work ${created.work.workId}.`
                    : `Browser keepalive schedule ${created.schedule.scheduleId} is configured without a durable Work.`,
                  data: {
                    schedule: created.schedule,
                    ...(created.work ? { work: buildWorkContinuationSnapshot(created.work) } : {}),
                  },
                }) as unknown as Record<string, unknown>);
              }
              if (operation === 'schedule_list') {
                const schedules = listWorkContinuationSchedules(ctx.controllerHome, repository.repoId, {
                  workId: workId || undefined,
                  includeOccurrences: args.include_occurrences === true,
                });
                const data = args.include_occurrences === true ? schedules : { schedules: schedules.schedules };
                return result(buildFacadeResult({ summary: `Found ${schedules.schedules.length} schedule(s).`, data }) as unknown as Record<string, unknown>);
              }
              if (!scheduleId) throw new Error('SCHEDULE_ID_REQUIRED');
              if (operation === 'schedule_get') {
                const data = getWorkContinuationSchedule(ctx.controllerHome, repository.repoId, scheduleId, args.include_occurrences === true);
                return result(buildFacadeResult({ summary: `Schedule ${scheduleId}.`, data }) as unknown as Record<string, unknown>);
              }
              if (operation === 'schedule_pause') {
                const saved = pauseWorkContinuationSchedule(ctx.controllerHome, repository.repoId, scheduleId, typeof args.reason === 'string' ? args.reason : undefined);
                return result(buildFacadeResult({ summary: `Schedule ${scheduleId} is paused.`, data: { schedule: saved } }) as unknown as Record<string, unknown>);
              }
              if (operation === 'schedule_resume') {
                const saved = resumeWorkContinuationSchedule(ctx.controllerHome, repository.repoId, scheduleId);
                return result(buildFacadeResult({ summary: `Schedule ${scheduleId} is resumed.`, data: { schedule: saved } }) as unknown as Record<string, unknown>);
              }
              if (operation === 'schedule_delete') {
                const schedule = getWorkContinuationSchedule(ctx.controllerHome, repository.repoId, scheduleId).schedule;
                deleteSchedule(ctx.controllerHome, repository.repoId, scheduleId);
                return result(buildFacadeResult({
                  summary: `Schedule ${scheduleId} is deleted; historical occurrences and evidence are retained.`,
                  data: { scheduleId, deleted: true, requestId: schedule.requestId },
                }) as unknown as Record<string, unknown>);
              }
              if (operation === 'schedule_trigger') {
                const repositoryEvent = typeof args.event_name === 'string' && args.event_name.trim().length > 0;
                const explicitEventId = typeof args.event_id === 'string' ? args.event_id.trim() : '';
                const manualRequestId = !repositoryEvent && typeof args.request_id === 'string' ? args.request_id.trim() : '';
                const occurrence = await triggerWorkContinuationSchedule(ctx.controllerHome, repository.repoId, scheduleId, {
                  source: repositoryEvent ? 'repository-event' : 'manual',
                  eventName: typeof args.event_name === 'string' ? args.event_name : undefined,
                  eventId: explicitEventId || manualRequestId || undefined,
                  data: args.event_data && typeof args.event_data === 'object' && !Array.isArray(args.event_data) ? args.event_data as Record<string, unknown> : undefined,
                });
                return result(buildFacadeResult({ summary: occurrence ? `Schedule ${scheduleId} produced ${occurrence.decision}.` : `Schedule ${scheduleId} produced no occurrence.`, data: { occurrence } }) as unknown as Record<string, unknown>);
              }
            } catch (error) {
              return result(buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Schedule operation failed.', data: {} }) as unknown as Record<string, unknown>, true);
            }
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
  
          if (operation === 'workflow_execute' || operation === 'workflow_reconcile') {
            try {
              const workId = String(args.work_id ?? '').trim();
              const workflowId = String(args.workflow_id ?? '').trim();
              const runId = String(args.workflow_run_id ?? '').trim();
              if (!workId || !workflowId || !runId) throw new Error('WORKFLOW_FACADE_IDENTITY_REQUIRED');
              const work = getWorkContract(store, workId);
              if (!work) throw new Error(`WORK_NOT_FOUND: ${workId}`);
              assertFacadeControllerRoundAuthority(ctx, store, workId, args);
              const owner = getControllerSession(store, workId);
              const relay = getControllerRoundRelay(store, workId);
              if (!owner) throw new Error(`WORK_CONTROLLER_OWNER_REQUIRED: ${workId}`);
              const authorityId = relay?.authorityId?.trim() || (typeof args.controller_authority_id === 'string' ? args.controller_authority_id.trim() : '');
              if (!authorityId) throw new Error('WORKFLOW_CONTROLLER_AUTHORITY_REQUIRED');
              const workRepository = selectRepositoryCheckout(repository, work.checkoutId);
              const executionIdentity = executionIdentityForRepository(workRepository, { workId });
              if (Object.values(XIAOHONGSHU_WORKFLOW_IDS).includes(workflowId as never)) {
                ensureXiaohongshuWorkflowInstalled(ctx.controllerHome, workflowId);
              }
              const projectId = typeof args.workflow_scope_project_id === 'string' ? args.workflow_scope_project_id.trim() : '';
              const registryScope = projectId ? { kind: 'project' as const, projectId } : { kind: 'controller' as const };
              const workflowInputs = args.workflow_inputs && typeof args.workflow_inputs === 'object' && !Array.isArray(args.workflow_inputs)
                ? args.workflow_inputs as Record<string, import('../../../packages/workflow-runtime/api/index').WorkflowJsonValue>
                : {};
              const base = {
                controllerHome: ctx.controllerHome,
                repository: workRepository,
                executionIdentity,
                workId,
                controller: { controllerId: owner.controllerId, authorityId },
                runId,
                registryScope,
                workflowId,
                inputs: workflowInputs,
                timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
              };
              const learningMetadata = (workflow: Awaited<ReturnType<typeof executeRegisteredWorkflow>>) => {
                const persisted = readWorkflowRun(ctx.controllerHome, workId, runId)?.value;
                let outcomeCollectionSchedule;
                let outcomeCollectionError: string | undefined;
                if (workflow.status === 'succeeded' && workflow.publicationReceipt) {
                  try {
                    outcomeCollectionSchedule = schedulePublicationOutcomeCollection({ controllerHome: ctx.controllerHome, repoId: repository.repoId, workId, publication: workflow.publicationReceipt, workflowInputs });
                  } catch (error) {
                    outcomeCollectionError = error instanceof Error ? error.message : 'OUTCOME_COLLECTION_SCHEDULE_FAILED';
                  }
                }
                return {
                  ...(persisted?.evidenceRef ? { workflowEvidenceRef: persisted.evidenceRef } : {}),
                  ...(outcomeCollectionSchedule ? { outcomeCollectionSchedule } : {}),
                  ...(outcomeCollectionError ? { outcomeCollectionError } : {}),
                };
              };
              if (operation === 'workflow_reconcile') {
                const reconciliationRequestId = String(args.workflow_reconciliation_request_id ?? '').trim();
                if (!reconciliationRequestId) throw new Error('WORKFLOW_RECONCILIATION_REQUEST_ID_REQUIRED');
                const reconciled = await observeAndReconcileRegisteredWorkflow({ ...base, reconciliationRequestId });
                if (reconciled.status === 'running') {
                  const resumed = await executeRegisteredWorkflow(base);
                  return result(buildFacadeResult({
                    summary: `Workflow ${workflowId}/${runId} reconciled from canonical observation and resumed without replaying the uncertain effect.`,
                    data: { workflow: resumed, ...learningMetadata(resumed) },
                  }) as unknown as Record<string, unknown>);
                }
                return result(buildFacadeResult({
                  status: reconciled.status === 'failed' ? 'blocked' : 'ok',
                  summary: `Workflow ${workflowId}/${runId} reconciliation settled as ${reconciled.status}.`,
                  data: { workflow: reconciled },
                }) as unknown as Record<string, unknown>, reconciled.status === 'failed');
              }
              const executed = await executeRegisteredWorkflow(base);
              return result(buildFacadeResult({
                status: executed.status === 'failed' || executed.status === 'reconcile_required' ? 'blocked' : 'ok',
                summary: `Workflow ${workflowId}/${runId} is ${executed.status}.`,
                data: { workflow: executed, ...learningMetadata(executed) },
              }) as unknown as Record<string, unknown>, executed.status === 'failed' || executed.status === 'reconcile_required');
            } catch (error) {
              return result(buildFacadeResult({
                status: 'blocked',
                summary: error instanceof Error ? error.message : 'Workflow execution failed.',
                data: { workflowExecuted: false },
              }) as unknown as Record<string, unknown>, true);
            }
          }
  
          if (operation === 'outcome_record' || operation === 'experience_record') {
            try {
              const workId = String(args.work_id ?? '').trim();
              if (!workId) throw new Error('LEARNING_LOOP_WORK_ID_REQUIRED');
              const work = getWorkContract(store, workId);
              if (!work) throw new Error(`WORK_NOT_FOUND: ${workId}`);
              assertFacadeControllerRoundAuthority(ctx, store, workId, args);
              const owner = getControllerSession(store, workId);
              const relay = getControllerRoundRelay(store, workId);
              if (!owner) throw new Error(`WORK_CONTROLLER_OWNER_REQUIRED: ${workId}`);
              const authorityId = relay?.authorityId?.trim() || (typeof args.controller_authority_id === 'string' ? args.controller_authority_id.trim() : '');
              if (!authorityId) throw new Error('LEARNING_LOOP_CONTROLLER_AUTHORITY_REQUIRED');
              const identity = { workId, controllerId: owner.controllerId, authorityId };
              if (operation === 'outcome_record') {
                if (!args.outcome_observation || typeof args.outcome_observation !== 'object' || Array.isArray(args.outcome_observation)) {
                  throw new Error('OUTCOME_OBSERVATION_REQUIRED');
                }
                const outcome = recordControllerOutcome({
                  controllerHome: ctx.controllerHome,
                  repoId: repository.repoId,
                  identity,
                  draft: args.outcome_observation as ControllerOutcomeObservationDraft,
                });
                return result(buildFacadeResult({
                  summary: `OutcomeObservation ${outcome.id} recorded from canonical Work/ControllerRound evidence.`,
                  data: { outcome },
                }) as unknown as Record<string, unknown>);
              }
              if (!args.experience_draft || typeof args.experience_draft !== 'object' || Array.isArray(args.experience_draft)) {
                throw new Error('EXPERIENCE_DRAFT_REQUIRED');
              }
              const experience = recordControllerExperience({
                controllerHome: ctx.controllerHome,
                repoId: repository.repoId,
                identity,
                draft: args.experience_draft as ControllerExperienceDraft,
                qualityAdjustmentFingerprint: typeof args.quality_adjustment_fingerprint === 'string' ? args.quality_adjustment_fingerprint.trim() || undefined : undefined,
              });
              return result(buildFacadeResult({
                summary: `Experience ${experience.id} recorded from canonical evidence for reuse by the next ControllerRound.`,
                data: { experience },
              }) as unknown as Record<string, unknown>);
            } catch (error) {
              return result(buildFacadeResult({
                status: 'blocked',
                summary: error instanceof Error ? error.message : 'Learning-loop record failed.',
                data: { recorded: false },
              }) as unknown as Record<string, unknown>, true);
            }
          }
  
          if (operation === 'controller_get_owner') {
            const owner = getControllerSession(store, String(args.work_id ?? '').trim());
            return result(buildFacadeResult({ summary: owner ? `Work is claimed by ${owner.controllerId}.` : 'Work has no active controller owner.', data: { owner } }) as unknown as Record<string, unknown>);
          }
          if (operation === 'controller_claim') {
            try {
              const workId = String(args.work_id ?? '').trim();
              const work = getWorkContract(store, workId);
              if (!work) throw new Error(`WORK_NOT_FOUND: ${workId}`);
              const identity = authenticatedFacadeControllerIdentity(ctx, args);
              const activeLaunchReservation = identity.controllerType === 'codex'
                ? getExternalControllerLaunchReservation(store, workId)
                : undefined;
              if (activeLaunchReservation?.controllerType === 'codex') {
                const expectedLaunchIdentity = providerMcpReservationIdentity('codex', activeLaunchReservation.reservationId);
                if (identity.principalId !== expectedLaunchIdentity.principalId || identity.sessionId !== expectedLaunchIdentity.sessionId) {
                  throw new Error(`WORK_CONTROLLER_LAUNCH_IDENTITY_MISMATCH: ${workId}; active Codex launch reservation requires its exact reservation-scoped MCP identity.`);
                }
              }
              let authorizedRelay = assertFacadeControllerRoundAuthority(ctx, store, workId, args);
              const observedOwner = getControllerSession(store, workId);
              const dispatchedRelay = getControllerRoundRelay(store, workId);
              const requestedRelayScopeId = typeof args.relay_scope_id === 'string' ? args.relay_scope_id.trim() : '';
              if (!authorizedRelay && identity.controllerAuthorityId && requestedRelayScopeId) {
                authorizedRelay = resolveRequirementControllerRoundRelayForWork(store, {
                  workId,
                  authorityId: identity.controllerAuthorityId,
                  relayScopeId: requestedRelayScopeId,
                });
                if (!authorizedRelay) {
                  throw new Error(`WORK_CONTROLLER_ROUND_AUTHORITY_UNBOUND: ${workId}:${requestedRelayScopeId}`);
                }
              }
              if (observedOwner && observedOwner.authorityDigest
                && (observedOwner.sessionId !== identity.sessionId || (observedOwner.controllerInstanceId?.trim() || '') !== identity.controllerInstanceId)
                && !dispatchedRelay?.authorityId?.trim()
                && !controllerSessionAuthorityMatches(observedOwner, identity.controllerAuthorityId)) {
                throw new Error(`WORK_CONTROLLER_SCOPE_MISMATCH: ${workId}; controller_claim requires the existing Work-bound controller authority after transport rotation.`);
              }
              const inheritedRequirementAuthority = !dispatchedRelay?.authorityId?.trim() && authorizedRelay?.authorityId?.trim()
                ? {
                    authorityId: authorizedRelay.authorityId!.trim(),
                    authorityDigest: controllerSessionAuthorityDigest(authorizedRelay.authorityId!),
                  }
                : undefined;
              const directAuthority = dispatchedRelay?.authorityId?.trim() || inheritedRequirementAuthority
                ? undefined
                : mintControllerSessionAuthority();
              const sessionAuthority = inheritedRequirementAuthority ?? directAuthority;
              const crossOwnerRecovery = Boolean(observedOwner)
                && (
                  observedOwner!.controllerId !== identity.controllerId
                  || controllerSessionPrincipalId(observedOwner!) !== identity.principalId
                )
                && dispatchedChatgptRelayAuthorizesStaleControllerRecovery(store, workId, dispatchedRelay, identity.controllerType);
              const session = resumeControllerSession(store, {
                workId,
                controllerId: identity.controllerId,
                controllerType: identity.controllerType,
                sessionId: identity.sessionId,
                ...(sessionAuthority ? { authorityDigest: sessionAuthority.authorityDigest } : {}),
                principalId: identity.principalId,
                controllerInstanceId: identity.controllerInstanceId,
                ...(crossOwnerRecovery
                  ? {
                      expectedClaimGeneration: observedOwner!.claimGeneration,
                      allowStaleRecovery: true,
                    }
                  : {}),
                leaseMs: typeof args.lease_ms === 'number' ? args.lease_ms : undefined,
              });
              const permissionSnapshotVersion = currentPermissionSnapshotVersion(ctx.controllerHome, repository.repoId);
              const executionSession = startExecutionSession(ctx.controllerHome, {
                sessionId: identity.sessionId,
                principalId: identity.principalId,
                controllerInstanceId: identity.controllerInstanceId,
                permissionSnapshotVersion,
              });
              updateExecutionSession(ctx.controllerHome, {
                sessionId: executionSession.sessionId,
                principalId: executionSession.principalId,
                controllerInstanceId: executionSession.controllerInstanceId,
              }, {
                activeRepositoryId: repository.repoId,
                activeCheckoutId: work.checkoutId || repository.activeCheckoutId,
                activeWorkId: work.workId,
                permissionSnapshotVersion,
                lastValidatedAt: new Date().toISOString(),
              });
              const assistantContextBundle = prepareControllerAssistantContextBundle(store, workId);
              const relay = acknowledgeControllerRoundClaim(
                { controllerHome: ctx.controllerHome, repoId: repository.repoId },
                { workId, session, assistantContextSnapshot: assistantContextBundle?.snapshot ?? null },
              );
              return result(buildFacadeResult({
                summary: relay?.status === 'claimed'
                  ? `Controller ${session.controllerId} claimed ${session.workId}; the dispatched ChatGPT round is mechanically acknowledged and still requires an explicit semantic disposition.`
                  : `Controller ${session.controllerId} claimed ${session.workId}.`,
                data: {
                  session,
                  relay,
                  assistantContext: assistantContextBundle?.rendered ?? prepareControllerAssistantContext(store, workId),
                  assistantContextSnapshot: assistantContextBundle?.snapshot,
                  controllerAuthorityId: dispatchedRelay?.authorityId?.trim() || inheritedRequirementAuthority?.authorityId || directAuthority?.authorityId,
                  controllerAuthorityCarrier: dispatchedRelay?.authorityId?.trim() || inheritedRequirementAuthority
                    ? 'controller_authority_id'
                    : 'controller_authority_id_or_session_id_compat',
                },
              }) as unknown as Record<string, unknown>);
            } catch (error) {
              return result(buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Controller claim failed.', data: {} }) as unknown as Record<string, unknown>, true);
            }
          }
          if (operation === 'controller_disposition') {
            try {
              const workId = String(args.work_id ?? '').trim();
              const disposition = frozenControllerDisposition?.disposition ?? String(args.disposition ?? '').trim();
              if (!['continue_immediately', 'wait', 'wait_for_user', 'goal_complete'].includes(disposition)) {
                throw new Error('CONTROLLER_RELAY_DISPOSITION_INVALID');
              }
              const identity = authenticatedFacadeControllerIdentity(ctx, args, { allowTransportSessionRollover: true });
              const work = getWorkContract(store, workId);
              if (!work) throw new Error(`WORK_NOT_FOUND: ${workId}`);
              const currentRelay = getControllerRoundRelay(store, workId);
              const terminalGoalComplete = work.status === 'completed' && disposition === 'goal_complete';
              const terminalSuccessorContinuation = work.status === 'completed'
                && disposition === 'continue_immediately'
                && Boolean(currentRelay?.successorWorkId);
              const terminalRoundClosure = terminalGoalComplete || terminalSuccessorContinuation;
              const currentOwner = getControllerSession(store, workId);
              if (!currentOwner && terminalRoundClosure) {
                // Live ownership remains the compatibility fence for ordinary rounds.
                // Once a terminal predecessor lease is gone, only the exact opaque
                // ControllerRound capability may authorize the semantic close.
                assertFacadeControllerRoundAuthority(ctx, store, workId, args);
              }
              if (!currentOwner && !terminalRoundClosure) {
                if (work.status === 'failed' || work.status === 'cancelled' || work.status === 'completed') {
                  throw new Error(`CONTROLLER_RELAY_WORK_TERMINAL: ${work.status}`);
                }
                throw new Error(`CONTROLLER_RELAY_ACTIVE_CLAIM_REQUIRED: ${workId}`);
              }
              if (currentOwner) {
                if (currentOwner.controllerType !== 'chatgpt') throw new Error(`CONTROLLER_RELAY_CHATGPT_ONLY: ${workId}`);
                if (currentOwner.controllerId !== identity.controllerId) throw new Error(`WORK_CONTROLLER_OWNER_MISMATCH: ${workId}`);
                if ((controllerSessionPrincipalId(currentOwner)) !== identity.principalId) {
                  throw new Error(`WORK_CONTROLLER_PRINCIPAL_MISMATCH: ${workId}`);
                }
                // Finalization may terminalize the Work before the prompt-required
                // goal_complete disposition is submitted. A frozen MCP client may also
                // rotate transport sessions between those two calls. Never resume or
                // rewrite a terminal Work lease here; terminal authorization is fenced
                // by the already-claimed relay lineage in submitControllerRoundDisposition.
                if (!terminalRoundClosure) {
                  bindFacadeControllerOwnership(ctx, store, workId, { ...identity, controllerType: 'chatgpt' });
                }
              }
              const explicitRequirementId = typeof args.requirement_id === 'string' ? args.requirement_id.trim() : '';
              if (explicitRequirementId && work.requirementId && explicitRequirementId !== work.requirementId) {
                throw new Error(`CONTROLLER_RELAY_REQUIREMENT_MISMATCH: Work ${workId} belongs to ${work.requirementId}, not ${explicitRequirementId}`);
              }
              const rationale = typeof args.reason === 'string' ? args.reason.trim() : '';
              const chatgptBinding = chatgptControllerRoundBinding(store, workId);
              let relay: ControllerRoundRelayRecord;
              let requirementAcceptance;
              if (disposition === 'goal_complete' && work.requirementId) {
                if (!rationale) throw new Error('REQUIREMENT_ACCEPTANCE_METADATA_REQUIRED: goal_complete for a Requirement-bound Work requires reason');
                const completedGoal = completeRequirementGoal({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, {
                  workId,
                  identity,
                  requirementId: work.requirementId,
                  rationale,
                  relayScopeId: frozenControllerDisposition?.relayScopeId ?? (typeof args.relay_scope_id === 'string' ? args.relay_scope_id : undefined),
                  handoffId: typeof args.handoff_id === 'string' ? args.handoff_id : undefined,
                  stateFingerprint: typeof args.state_fingerprint === 'string' ? args.state_fingerprint : undefined,
                  bindingId: chatgptBinding?.bindingId,
                  maxRounds: typeof args.max_rounds === 'number' ? args.max_rounds : undefined,
                  maxRepeatedState: typeof args.max_repeated_state === 'number' ? args.max_repeated_state : undefined,
                  maxFailures: typeof args.max_failures === 'number' ? args.max_failures : undefined,
                });
                relay = completedGoal.relay;
                requirementAcceptance = completedGoal.requirementAcceptance;
              } else {
                const existingRelay = disposition === 'goal_complete' ? getControllerRoundRelay(store, workId) : undefined;
                if (existingRelay?.status === 'goal_complete' && existingRelay.disposition === 'goal_complete') {
                  relay = existingRelay;
                } else {
                  try {
                    relay = submitControllerRoundDisposition({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, {
                      workId,
                      identity,
                      disposition: disposition as ControllerRoundDisposition,
                      executionQualityDecisions: args.execution_quality_decisions as Parameters<typeof submitControllerRoundDisposition>[1]['executionQualityDecisions'],
                      executionQualityAdjustmentResults: args.execution_quality_adjustment_results as Parameters<typeof submitControllerRoundDisposition>[1]['executionQualityAdjustmentResults'],
                      assistantContextDigest: typeof args.assistant_context_digest === 'string' ? args.assistant_context_digest : undefined,
                      assistantContextUsage: args.assistant_context_usage as Parameters<typeof submitControllerRoundDisposition>[1]['assistantContextUsage'],
                      relayScopeId: frozenControllerDisposition?.relayScopeId ?? (typeof args.relay_scope_id === 'string' ? args.relay_scope_id : undefined),
                      requirementId: typeof args.requirement_id === 'string' ? args.requirement_id : undefined,
                      handoffId: typeof args.handoff_id === 'string' ? args.handoff_id : undefined,
                      stateFingerprint: typeof args.state_fingerprint === 'string' ? args.state_fingerprint : undefined,
                      reason: typeof args.reason === 'string' ? args.reason : undefined,
                      bindingId: chatgptBinding?.bindingId,
                      maxRounds: typeof args.max_rounds === 'number' ? args.max_rounds : undefined,
                      maxRepeatedState: typeof args.max_repeated_state === 'number' ? args.max_repeated_state : undefined,
                      maxFailures: typeof args.max_failures === 'number' ? args.max_failures : undefined,
                    });
                  } catch (error) {
                    const raced = disposition === 'goal_complete' ? getControllerRoundRelay(store, workId) : undefined;
                    if (!raced || raced.status !== 'goal_complete' || raced.disposition !== 'goal_complete') throw error;
                    relay = raced;
                  }
                }
              }
              const continuationSchedule = ensureControllerDispositionContinuation(
                ctx.controllerHome,
                repository.repoId,
                relay,
              );
              return result(buildFacadeResult({
                status: relay.status === 'blocked' ? 'blocked' : 'ok',
                summary: relay.status === 'pending_release'
                  ? `Controller disposition ${relay.disposition} recorded; relay will dispatch only after the current lease is released.`
                  : continuationSchedule
                    ? `Controller disposition ${relay.disposition} recorded with status ${relay.status}; exact-Work continuation is now event-driven by ${continuationSchedule.trigger.eventName}.`
                    : `Controller disposition ${relay.disposition} recorded with status ${relay.status}.`,
                data: { relay, ...(requirementAcceptance ? { requirementAcceptance } : {}), ...(continuationSchedule ? { continuationSchedule } : {}) },
              }) as unknown as Record<string, unknown>, relay.status === 'blocked');
            } catch (error) {
              return result(buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Controller disposition failed.', data: {} }) as unknown as Record<string, unknown>, true);
            }
          }
          if (operation === 'controller_release') {
            try {
              const workId = String(args.work_id ?? '').trim();
              const identity = authenticatedFacadeControllerIdentity(ctx, args, { allowTransportSessionRollover: true });
              try {
                assertFacadeControllerRoundAuthority(ctx, store, workId, args);
              } catch (error) {
                const observed = getControllerSession(store, workId);
                const runtime = runtimeIdentitySnapshot(ctx);
                const samePrincipalCanonicalRuntimeMigration = Boolean(
                  observed
                  && observed.controllerId === identity.controllerId
                  && observed.controllerType === identity.controllerType
                  && controllerSessionPrincipalId(observed) === identity.principalId
                  && (observed.controllerInstanceId?.trim() || '') !== identity.controllerInstanceId
                  && runtime.running
                  && runtime.runtimeInstanceId === identity.controllerInstanceId,
                );
                if (!samePrincipalCanonicalRuntimeMigration) throw error;
              }
              const observedOwner = getControllerSession(store, workId);
              const work = getWorkContract(store, workId);
              const terminalWork = work ? ['completed', 'failed', 'cancelled'].includes(work.status) : false;
              const pendingTerminalRelay = !observedOwner && work?.status === 'completed'
                ? getControllerRoundRelay(store, workId)
                : undefined;
              const retainedReleaseWitness = pendingTerminalRelay?.status === 'pending_release'
                ? getRetainedControllerSession(store, workId)
                : undefined;
              if (retainedReleaseWitness && pendingTerminalRelay) {
                const retainedPrincipal = controllerSessionPrincipalId(retainedReleaseWitness);
                if (retainedReleaseWitness.controllerId !== identity.controllerId
                  || retainedReleaseWitness.controllerType !== identity.controllerType
                  || retainedPrincipal !== identity.principalId
                  || retainedReleaseWitness.claimGeneration !== pendingTerminalRelay.claimGeneration
                  || pendingTerminalRelay.controllerId !== identity.controllerId
                  || pendingTerminalRelay.principalId !== identity.principalId) {
                  throw new Error(`CONTROLLER_RELAY_RELEASE_FENCE_MISMATCH: ${workId}`);
                }
              }
              const owner = observedOwner
                ? terminalWork
                  ? (() => {
                      // A terminal Work cannot be rebound to a replacement MCP transport.
                      // Authenticate the caller against the observed durable controller epoch
                      // without mutating it; releaseControllerSessionWithAuthority remains the
                      // exact claim-generation CAS authority for physical lease release.
                      const ownerPrincipal = observedOwner.principalId?.trim() || observedOwner.controllerId;
                      const ownerInstanceId = observedOwner.controllerInstanceId?.trim() || '';
                      if (observedOwner.controllerId !== identity.controllerId) {
                        throw new Error(`WORK_CONTROLLER_OWNER_MISMATCH: ${workId}`);
                      }
                      if (observedOwner.controllerType !== identity.controllerType) {
                        throw new Error(`WORK_CONTROLLER_TYPE_MISMATCH: ${workId}`);
                      }
                      if (ownerPrincipal !== identity.principalId) {
                        throw new Error(`WORK_CONTROLLER_PRINCIPAL_MISMATCH: ${workId}`);
                      }
                      if (!ownerInstanceId || ownerInstanceId !== identity.controllerInstanceId) {
                        throw new Error(`WORK_CONTROLLER_INSTANCE_MISMATCH: ${workId}`);
                      }
                      if (typeof observedOwner.claimGeneration !== 'number' || observedOwner.claimGeneration < 1) {
                        throw new Error(`WORK_CONTROLLER_CLAIM_GENERATION_REQUIRED: ${workId}`);
                      }
                      return observedOwner;
                    })()
                  : bindFacadeControllerOwnership(ctx, store, workId, identity)
                : undefined;
              if (owner) {
                const ownerPrincipal = controllerSessionPrincipalId(owner);
                const ownerInstanceId = owner.controllerInstanceId?.trim() || '';
                if (typeof owner.claimGeneration !== 'number' || owner.claimGeneration < 1) {
                  throw new Error(`WORK_CONTROLLER_CLAIM_GENERATION_REQUIRED: ${workId}`);
                }
                const released = releaseControllerSessionWithAuthority(store, {
                  workId,
                  actor: `controller-release:${identity.controllerId}:${identity.controllerInstanceId}`,
                  authority: {
                    controllerId: owner.controllerId,
                    controllerType: owner.controllerType,
                    principalId: ownerPrincipal,
                    controllerInstanceId: ownerInstanceId,
                    claimGeneration: owner.claimGeneration,
                  },
                });
                if (!released.allowed) {
                  throw new Error(`WORK_CONTROLLER_RELEASE_FENCED: ${workId}:${released.reason}`);
                }
              }
              const executionSession = readExecutionSession(ctx.controllerHome, identity);
              if (executionSession?.activeWorkId === workId) {
                updateExecutionSession(ctx.controllerHome, identity, { activeWorkId: undefined, lastValidatedAt: new Date().toISOString() });
              }
              const relayStore = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
              const releasedSession = owner ?? retainedReleaseWitness;
              const relay = releasedSession ? beginControllerRoundRelayAfterRelease(
                relayStore,
                { workId, releasedSession },
              ) : undefined;
              const abandonedRelay = owner && !relay
                ? reconcileControllerRoundAfterAbandonedRelease(relayStore, { workId, releasedSession: owner })
                : undefined;
              if (relay?.status === 'dispatching') {
                const relayWorkId = relay.originWorkId;
                try {
                  assertAutomatedOperationAllowed('external_controller_wake', {
                    controller_type: 'chatgpt',
                    relay_scope_id: relay.relayScopeId,
                    requirement_id: relay.requirementId,
                  });
                  const prompt = renderChatgptControllerRoundPrompt(relayStore, relay);
                  const relayBinding = chatgptControllerRoundBinding(relayStore, relayWorkId);
                  const predecessorBinding = relayWorkId !== workId ? chatgptControllerRoundBinding(relayStore, workId) : undefined;
                  const dispatched = await runWorkChatgptContinuation({
                    controllerHome: ctx.controllerHome,
                    repoId: repository.repoId,
                    repoRoot: repository.canonicalRoot,
                    workId: relayWorkId,
                    prompt,
                    controllerAuthorityId: relay.authorityId,
                    relayScopeId: relay.relayScopeId,
                    browserSessionId: relayBinding?.browserSessionId ?? predecessorBinding?.browserSessionId,
                    conversationUrl: relayBinding?.conversationUrl ?? predecessorBinding?.conversationUrl,
                    tabPolicy: 'reuse',
                  });
                  if (dispatched.status === 'failed') throw new Error(`${dispatched.error?.code ?? 'CONTROLLER_RELAY_DISPATCH_FAILED'}:${dispatched.error?.message ?? 'Controller relay dispatch failed'}`);
                  // The next prompt is externally committed before this transition is
                  // recorded. Provider conversation context may be reused across the
                  // handoff, but the successor Work receives its own binding/authority.
                  recordChatgptControllerRoundTabSettlement(relayStore, {
                    workId: relayWorkId,
                    relayScopeId: relay.relayScopeId,
                    status: 'retained_for_immediate_continuation',
                  });
                  const updatedBinding = chatgptControllerRoundBinding(relayStore, relayWorkId);
                  const completed = finishControllerRoundRelayDispatch(
                    relayStore,
                    { workId: relayWorkId, ok: true, bindingId: updatedBinding?.bindingId },
                  );
                  return result(buildFacadeResult({
                    summary: relayWorkId === workId
                      ? `Controller lease released and immediate relay ${relay.relayScopeId} dispatched through the canonical ChatGPT launcher.`
                      : `Controller lease released; relay ${relay.relayScopeId} handed off from completed ${workId} to successor ${relayWorkId} and dispatched through the canonical ChatGPT launcher.`,
                    data: { relay: completed, dispatch: dispatched, ...(relayWorkId !== workId ? { predecessorWorkId: workId, successorWorkId: relayWorkId } : {}) },
                  }) as unknown as Record<string, unknown>);
                } catch (relayError) {
                  const relayFailure = relayError instanceof Error ? relayError.message : String(relayError);
                  const failed = finishControllerRoundRelayDispatch(
                    relayStore,
                    { workId: relayWorkId, ok: false, error: relayFailure, outcomeUnknown: /OUTCOME_UNKNOWN/i.test(relayFailure) },
                  );
                  return result(buildFacadeResult({
                    status: 'blocked',
                    summary: `Controller lease released, but immediate relay dispatch failed: ${relayError instanceof Error ? relayError.message : String(relayError)}`,
                    data: { relay: failed },
                  }) as unknown as Record<string, unknown>, true);
                }
              }
              const settledRelay = getControllerRoundRelay(relayStore, workId);
              let tabSettlement;
              if (
                owner?.controllerType === 'chatgpt'
                && settledRelay
                && ['waiting', 'waiting_for_user', 'goal_complete', 'blocked', 'failed'].includes(settledRelay.status)
              ) {
                const binding = chatgptControllerRoundBinding(store, workId);
                const browserSessionId = binding?.browserSessionId;
                if (browserSessionId) {
                  tabSettlement = await settleWorkChatgptAutomationTab({
                    controllerHome: ctx.controllerHome,
                    workId,
                    browserSessionId,
                  });
                  recordChatgptControllerRoundTabSettlement(relayStore, {
                    workId,
                    relayScopeId: settledRelay.relayScopeId,
                    status: tabSettlement.status,
                    error: tabSettlement.error?.message,
                  });
                }
              }
              return result(buildFacadeResult({
                summary: abandonedRelay
                  ? 'Controller lease released; the claimed round was mechanically marked abandoned without semantic completion and can be relaunched through the bounded launcher path.'
                  : 'Controller lease released.',
                data: { relay: getControllerRoundRelay(relayStore, workId) ?? abandonedRelay ?? relay, tabSettlement },
              }) as unknown as Record<string, unknown>);
            } catch (error) {
              return result(buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Controller release failed.', data: {} }) as unknown as Record<string, unknown>, true);
            }
          }
          if (operation === 'launcher_start') {
            try {
              const controllerType = String(args.controller_type ?? 'codex');
              if (!['chatgpt', 'codex', 'grok', 'claude'].includes(controllerType)) throw new Error('CONTROLLER_TYPE_INVALID');
              const workId = String(args.work_id ?? '').trim();
              const launchArgs = Array.isArray(args.launch_args) ? args.launch_args.map(String) : [];
              if (controllerType === 'chatgpt') {
                const work = getWorkContract(store, workId);
                if (!work) throw new Error(`WORK_NOT_FOUND: ${workId}`);
                const handoffId = typeof args.handoff_id === 'string' ? args.handoff_id.trim() : '';
                const handoff = handoffId ? getHandoffItem(store, handoffId) : undefined;
                const valueForFlag = (flag: string): string | undefined => {
                  const index = launchArgs.indexOf(flag);
                  if (index < 0) return undefined;
                  const value = launchArgs[index + 1];
                  if (!value || value.startsWith('--')) throw new Error(`CHATGPT_LAUNCH_ARG_VALUE_REQUIRED: ${flag}`);
                  return value;
                };
                const supportedFlags = new Set(['--model', '--reasoning', '--tab-policy', '--timeout-ms']);
                for (let index = 0; index < launchArgs.length; index += 2) {
                  const flag = launchArgs[index];
                  if (!flag || !supportedFlags.has(flag)) throw new Error(`CHATGPT_LAUNCH_ARG_UNSUPPORTED: ${flag ?? ''}`);
                  if (!launchArgs[index + 1] || launchArgs[index + 1]!.startsWith('--')) throw new Error(`CHATGPT_LAUNCH_ARG_VALUE_REQUIRED: ${flag}`);
                }
                const reasoning = valueForFlag('--reasoning') ?? 'high';
                if (!['medium', 'high', 'xhigh'].includes(reasoning)) throw new Error(`CHATGPT_LAUNCH_REASONING_INVALID: ${reasoning}`);
                const tabPolicy = valueForFlag('--tab-policy') ?? 'auto';
                if (!['auto', 'reuse', 'new'].includes(tabPolicy)) throw new Error(`CHATGPT_LAUNCH_TAB_POLICY_INVALID: ${tabPolicy}`);
                const timeoutValue = valueForFlag('--timeout-ms');
                const timeoutMs = timeoutValue === undefined ? undefined : Number(timeoutValue);
                if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error(`CHATGPT_LAUNCH_TIMEOUT_INVALID: ${timeoutValue}`);
                const continuationPrompt = typeof args.continuation_prompt === 'string' ? args.continuation_prompt.trim() : '';
                const relayStore = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
                const existingBinding = chatgptControllerRoundBinding(relayStore, workId);
                const relay = beginInitialControllerRoundDispatch(
                  relayStore,
                  {
                    workId,
                    identity: authenticatedFacadeControllerIdentity(ctx, args),
                    requirementId: work.requirementId,
                    bindingId: existingBinding?.bindingId,
                  },
                );
                if (relay.status === 'blocked') {
                  throw new Error(`CONTROLLER_RELAY_LAUNCH_BLOCKED: ${relay.blockedReason ?? relay.relayScopeId}`);
                }
                const prompt = [
                  renderChatgptControllerRoundPrompt(store, relay, { exactOriginWork: true }),
                  `Controller round: ${relay.relayScopeId}. launcher_start opened this durable round; dispatch success is not semantic completion.`,
                  handoff ? `Handoff: ${handoff.summary}\nNext: ${handoff.recommendedContinuationPrompt ?? handoff.recommendedPrompt}` : '',
                  continuationPrompt ? `Continuation: ${continuationPrompt}` : '',
                ].filter(Boolean).join('\n');
                let dispatched: Awaited<ReturnType<typeof runWorkChatgptContinuation>>;
                try {
                  dispatched = await runWorkChatgptContinuation({
                    controllerHome: ctx.controllerHome,
                    repoId: repository.repoId,
                    repoRoot: repository.canonicalRoot,
                    workId,
                    prompt,
                    controllerAuthorityId: relay.authorityId,
                    relayScopeId: relay.relayScopeId,
                    browserSessionId: typeof args.browser_session_id === 'string' ? args.browser_session_id : undefined,
                    conversationUrl: typeof args.conversation_url === 'string' ? args.conversation_url : undefined,
                    model: valueForFlag('--model') ?? 'gpt-5.6',
                    reasoning: reasoning as 'medium' | 'high' | 'xhigh',
                    tabPolicy: tabPolicy as 'auto' | 'reuse' | 'new',
                    timeoutMs,
                  });
                  if (dispatched.status === 'failed') throw new Error(`${dispatched.error?.code ?? 'CHATGPT_WORK_CONTINUATION_FAILED'}:${dispatched.error?.message ?? 'ChatGPT Work continuation failed'}`);
                } catch (launchError) {
                  const launchFailure = launchError instanceof Error ? launchError.message : String(launchError);
                  finishControllerRoundRelayDispatch(
                    { controllerHome: ctx.controllerHome, repoId: repository.repoId },
                    { workId, ok: false, error: launchFailure, outcomeUnknown: /OUTCOME_UNKNOWN/i.test(launchFailure) },
                  );
                  throw launchError;
                }
                const updatedBinding = chatgptControllerRoundBinding(relayStore, workId);
                const completedRelay = finishControllerRoundRelayDispatch(
                  relayStore,
                  { workId, ok: true, bindingId: updatedBinding?.bindingId },
                );
                return result(buildFacadeResult({
                  summary: 'ChatGPT continuation dispatched; wake completion remains pending until the new ChatGPT Controller claims the Work, and semantic closure still requires an explicit disposition.',
                  data: {
                    workId,
                    relay: completedRelay,
                    browserSessionId: dispatched.browserSessionId,
                    conversationUrl: dispatched.conversationUrl,
                    executionPreferenceVerified: dispatched.executionPreferenceVerified,
                  },
                }) as unknown as Record<string, unknown>);
              }
              const launched = await launchSuperController({ work: store, handoff: store }, {
                controllerType: controllerType as 'codex' | 'grok' | 'claude',
                executable: typeof args.executable === 'string' && args.executable.trim() ? args.executable.trim() : undefined,
                args: launchArgs,
                workId,
                launchReservationMs: typeof args.launch_reservation_ms === 'number' ? args.launch_reservation_ms : typeof args.lease_ms === 'number' ? args.lease_ms : undefined,
                handoffId: typeof args.handoff_id === 'string' ? args.handoff_id : undefined,
                browserSessionId: typeof args.browser_session_id === 'string' ? args.browser_session_id : undefined,
                conversationUrl: typeof args.conversation_url === 'string' ? args.conversation_url : undefined,
                continuationPrompt: typeof args.continuation_prompt === 'string' ? args.continuation_prompt : undefined,
                cwd: repository.canonicalRoot,
              });
              return result(buildFacadeResult({ summary: `Thin Launcher started ${launched.controllerType}.`, data: { pid: launched.pid, executable: launched.executable, workId, reservationId: launched.reservationId } }) as unknown as Record<string, unknown>);
            } catch (error) {
              return result(buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Launcher failed.', data: {} }) as unknown as Record<string, unknown>, true);
            }
          }
          if (operation === 'plan_list') {
            const plans = listPlanContracts({ ...store, status: 'active', limit: typeof args.limit === 'number' ? args.limit : 20 });
            const facade = buildFacadeResult({
              summary: `${plans.length} active PlanContract(s) in this repository.`,
              data: { plans: plans.map(summarizePlanContract), bounded: true },
            });
            return result(facade as unknown as Record<string, unknown>);
          }
          if (operation === 'plan_get') {
            const plan = getPlanContract(store, String(args.plan_id ?? ''));
            const facade = plan
              ? buildFacadeResult({ summary: `PlanContract ${plan.planId} retrieved.`, data: { plan: args.detail_level === 'detail' ? plan : summarizePlanContract(plan) }, detailLevel: args.detail_level === 'detail' ? 'detail' : 'summary' })
              : buildFacadeResult({ status: 'not_found', summary: `PlanContract ${String(args.plan_id ?? '')} not found.`, data: { planId: String(args.plan_id ?? '') } });
            return result(facade as unknown as Record<string, unknown>, !plan);
          }
  
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
  
          if (operation === 'requirement_create') {
            const compatibilityArgs = frozenSemanticOperation?.operation === 'requirement_create' ? frozenSemanticOperation.args : undefined;
            const requirementId = typeof args.requirement_id === 'string' ? args.requirement_id : '';
            const title = compatibilityArgs?.requirement_title ?? (typeof args.requirement_title === 'string' ? args.requirement_title : '');
            const outcomeStatement = compatibilityArgs?.requirement_outcome ?? (typeof args.requirement_outcome === 'string' ? args.requirement_outcome : '');
            if (!requirementId.trim() || !title.trim() || !outcomeStatement.trim()) {
              return result(buildFacadeResult({
                status: 'blocked',
                summary: 'REQUIREMENT_CREATE_INPUT_REQUIRED: requirement_id, requirement_title, and requirement_outcome are required.',
                data: { requirementCreated: false },
              }) as unknown as Record<string, unknown>, true);
            }
            let admission;
            try {
              admission = admitRequirement({ controllerHome: ctx.controllerHome }, {
                requirementId,
                title,
                outcomeStatement,
                acceptanceCriteria: compatibilityArgs?.requirement_acceptance_criteria
                  ?? (Array.isArray(args.requirement_acceptance_criteria) ? args.requirement_acceptance_criteria.map(String) : []),
                requiredDeliveryReferences: compatibilityArgs?.requirement_delivery_references
                  ?? (Array.isArray(args.requirement_delivery_references) ? args.requirement_delivery_references.map(String) : []),
                legacyAliases: compatibilityArgs?.requirement_legacy_aliases
                  ?? (Array.isArray(args.requirement_legacy_aliases) ? args.requirement_legacy_aliases.map(String) : []),
              });
            } catch (error) {
              return result(buildFacadeResult({
                status: 'blocked',
                summary: error instanceof Error ? error.message : String(error),
                data: { requirementCreated: false },
              }) as unknown as Record<string, unknown>, true);
            }
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
          }
  
          if (operation.startsWith('plan_')) {
            try {
              if (operation === 'plan_create') {
                const rawSteps = Array.isArray(args.plan_steps) ? args.plan_steps : [];
                const requestedPlanId = String(args.plan_id ?? '').trim();
                const requestedRequirementId = typeof args.requirement_id === 'string' && args.requirement_id.trim() ? args.requirement_id.trim() : undefined;
                const requestedPlanRelation: 'extend' | 'parallel' | undefined = args.plan_relation === 'extend' || args.plan_relation === 'parallel'
                  ? args.plan_relation
                  : undefined;
                const relatedPlanId = typeof args.related_plan_id === 'string' && args.related_plan_id.trim() ? args.related_plan_id.trim() : undefined;
                if (requestedRequirementId && !readRequirement({ controllerHome: ctx.controllerHome }, requestedRequirementId)) {
                  const facade = buildFacadeResult({
                    status: 'failed',
                    summary: `PLAN_REQUIREMENT_NOT_FOUND: ${requestedRequirementId}. Plan was not persisted; create or reconcile the Requirement authority first.`,
                    data: { executionStarted: false, planContractCreated: false, admissionDecision: 'missing_requirement', requirementId: requestedRequirementId },
                  });
                  return result(facade as unknown as Record<string, unknown>, true);
                }
                const admissionInput = {
                  requirementId: requestedRequirementId,
                  scopeKey: String(args.scope_key ?? ''),
                  planRelation: requestedPlanRelation,
                  relatedPlanId,
                };
                const renderPlanAdmission = (admission: ReturnType<typeof resolvePlanAdmission>): CallToolResult | undefined => {
                  if (admission.admissionDecision === 'create_new') return undefined;
                  if (admission.reason === 'exact_scope_authority' && admission.plan) {
                    const exactDraftRepair = admission.plan.status === 'draft' && requestedPlanId === admission.plan.planId;
                    const facade = buildFacadeResult({
                      summary: exactDraftRepair
                        ? `PLAN_DRAFT_REPAIR_REQUIRED: draft Plan ${admission.plan.planId} already owns scope ${admission.normalizedScopeKey}; preserve that authority and amend it through rh_work repair.`
                        : `PLAN_AUTHORITY_REUSED: active Plan ${admission.plan.planId} already owns scope ${admission.normalizedScopeKey}; no duplicate draft was created.`,
                      data: {
                        plan: summarizePlanContract(admission.plan),
                        executionStarted: false,
                        planContractCreated: false,
                        admissionDecision: 'reuse_existing',
                        resolutionRequired: false,
                        ...(exactDraftRepair ? { repairRequired: true } : {}),
                      },
                      suggestedNextActions: exactDraftRepair
                        ? [{
                            label: 'Repair this exact draft Plan',
                            tool: 'rh_work',
                            operation: 'repair',
                            payload: {
                              plan_id: admission.plan.planId,
                              repair_operation: 'repair',
                              dry_run: false,
                              scope_key: args.scope_key,
                              source_revision: args.source_revision,
                              objective: args.objective,
                              plan_steps: args.plan_steps,
                              non_goals: args.non_goals,
                              assumptions: args.assumptions,
                              resolved_decisions: args.resolved_decisions,
                              stop_conditions: args.stop_conditions,
                              replan_conditions: args.replan_conditions,
                              integration_strategy: args.integration_strategy,
                            },
                            risk: 'workspace_write',
                            confidence: 'high',
                          }]
                        : [{ label: 'Read active Plan', tool: 'rh_work', operation: 'plan_get', payload: { plan_id: admission.plan.planId }, risk: 'readonly', confidence: 'high' }],
                    });
                    return result(facade as unknown as Record<string, unknown>);
                  }
                  if (admission.reason === 'extension_target_required') {
                    const facade = buildFacadeResult({
                      summary: `PLAN_EXTENSION_TARGET_REQUIRED: select related_plan_id from the active Plan slices for Requirement ${requestedRequirementId}.`,
                      data: { executionStarted: false, planContractCreated: false, admissionDecision: 'resolution_required', resolutionRequired: true, candidates: admission.candidates.map(summarizePlanContract) },
                    });
                    return result(facade as unknown as Record<string, unknown>);
                  }
                  if (admission.reason === 'extend_existing' && admission.plan) {
                    // plan_create + plan_relation=extend is a compatibility transport
                    // for revising the explicitly related stable Plan identity. Preflight
                    // must continue into atomic admission; no successor Plan is minted.
                    return undefined;
                  }
                  throw new Error(`PLAN_ADMISSION_RESULT_INVALID: ${admission.admissionDecision}:${admission.reason}`);
                };
                const plans = listPlanContracts({ ...store, status: 'all', limit: 100 });
                const preflightAdmission = resolvePlanAdmission(plans, admissionInput);
                const preflightResult = renderPlanAdmission(preflightAdmission);
                if (preflightResult) return preflightResult;
                const requestedPlanCheckIds = rawSteps
                  .filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === 'object' && !Array.isArray(step))
                  .flatMap((step) => Array.isArray(step.check_ids) ? step.check_ids.map(String) : []);
                const normalizedPlanChecks = normalizeCheckIds(requestedPlanCheckIds, checks);
                if (normalizedPlanChecks.invalidCheckIds.length > 0) {
                  const facade = buildFacadeResult({
                    status: 'failed',
                    summary: `PLAN_CHECKS_INVALID: ${normalizedPlanChecks.invalidCheckIds.join(', ')}. Plan was not persisted; select replacement IDs from registeredCheckIds in this response, then request readiness only for the checks you choose.`,
                    data: {
                      executionStarted: false,
                      planContractCreated: false,
                      admissionDecision: 'invalid_checks',
                      normalizedChecks: normalizedPlanChecks,
                      registeredCheckIds: checks.map((check) => check.id).slice(0, 80),
                    },
                    suggestedNextActions: [],
                  });
                  return result(facade as unknown as Record<string, unknown>, true);
                }
                const admitted = await admitPlanContractAsync(store, {
                  planId: String(args.plan_id ?? ''),
                  repoId: repository.repoId,
                  requirementId: requestedRequirementId,
                  scopeKey: String(args.scope_key ?? ''),
                  planRelation: requestedPlanRelation,
                  relatedPlanId,
                  sourceRevision: String(args.source_revision ?? ''),
                  goal: String(args.objective ?? ''),
                  nonGoals: Array.isArray(args.non_goals) ? args.non_goals.map(String) : undefined,
                  assumptions: Array.isArray(args.assumptions) ? args.assumptions.map(String) : undefined,
                  resolvedDecisions: Array.isArray(args.resolved_decisions) ? args.resolved_decisions.map(String) : undefined,
                  stopConditions: Array.isArray(args.stop_conditions) ? args.stop_conditions.map(String) : undefined,
                  replanConditions: Array.isArray(args.replan_conditions) ? args.replan_conditions.map(String) : undefined,
                  integrationStrategy: typeof args.integration_strategy === 'string' ? args.integration_strategy : undefined,
                  obligationDispositions: planObligationDispositionsFromArgs(args.obligation_dispositions),
                  steps: rawSteps.filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === 'object' && !Array.isArray(step)).map((step) => ({
                    id: String(step.id ?? ''),
                    objective: String(step.objective ?? ''),
                    dependencies: Array.isArray(step.dependencies) ? step.dependencies.map(String) : [],
                    authoritativeFiles: Array.isArray(step.authoritative_files) ? step.authoritative_files.map(String) : [],
                    allowedPaths: Array.isArray(step.allowed_paths) ? step.allowed_paths.map(String) : [],
                    forbiddenPaths: Array.isArray(step.forbidden_paths) ? step.forbidden_paths.map(String) : [],
                    checks: Array.isArray(step.check_ids) ? step.check_ids.map(String) : [],
                    acceptanceCriteria: Array.isArray(step.acceptance_criteria) ? step.acceptance_criteria.map(String) : [],
                  })),
                });
                if (admitted.reason === 'extend_existing' && admitted.plan) {
                  const plan = admitted.plan;
                  const requestedLabel = requestedPlanId && requestedPlanId !== plan.planId ? ` Requested compatibility plan_id ${requestedPlanId} was retained only as revision audit metadata.` : '';
                  const facade = buildFacadeResult({
                    summary: `PLAN_REVISION_REUSED_AUTHORITY: Plan ${plan.planId} was revised in place; no successor PlanContract was created.${requestedLabel}`,
                    data: {
                      plan: summarizePlanContract(plan),
                      executionStarted: false,
                      planContractCreated: false,
                      admissionDecision: 'reuse_existing',
                      resolutionRequired: false,
                    },
                    suggestedNextActions: [{ label: 'Approve revised Plan', tool: 'rh_work', operation: 'plan_approve', payload: { plan_id: plan.planId }, risk: 'workspace_write', confidence: 'high' }],
                  });
                  return result(facade as unknown as Record<string, unknown>);
                }
                const racedAdmissionResult = renderPlanAdmission(admitted);
                if (racedAdmissionResult) return racedAdmissionResult;
                if (!admitted.plan) throw new Error('PLAN_ADMISSION_CREATE_MISSING_PLAN');
                const plan = admitted.plan;
                const facade = buildFacadeResult({
                  summary: `PlanContract ${plan.planId} created as draft after atomic authority admission; no execution was started.`,
                  data: { plan: summarizePlanContract(plan), executionStarted: false, planContractCreated: true, admissionDecision: 'create_new' },
                  suggestedNextActions: [{ label: 'Approve reviewed plan', tool: 'rh_work', operation: 'plan_approve', payload: { plan_id: plan.planId }, risk: 'workspace_write', confidence: 'medium' }],
                });
                return result(facade as unknown as Record<string, unknown>);
              }
              if (operation === 'plan_approve') {
                const plan = await approvePlanContractAsync(store, String(args.plan_id ?? ''));
                const facade = buildFacadeResult({
                  summary: `PlanContract ${plan.planId} approved at source revision ${plan.sourceRevision}; execution remains explicit.`,
                  data: { plan: summarizePlanContract(plan), executionStarted: false },
                });
                return result(facade as unknown as Record<string, unknown>);
              }
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
              const plan = supersedePlanContract(store, String(args.plan_id ?? ''), String(args.superseded_by ?? ''));
              const facade = buildFacadeResult({ summary: `PlanContract ${plan.planId} superseded by ${plan.supersededBy}.`, data: { plan: summarizePlanContract(plan) } });
              return result(facade as unknown as Record<string, unknown>);
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
