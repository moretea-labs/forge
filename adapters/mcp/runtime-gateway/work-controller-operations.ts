import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import type { RepositoryRecord } from '../../../src/cli/repositories/types';
import { result } from './result-adapter';
import { buildFacadeResult, getHandoffItem } from '../../../src/runtime/control-plane/facade';
import { getWorkContract } from '../../../packages/kernel/work/api/index';
import { currentPermissionSnapshotVersion } from '../../../src/runtime/control-plane/execution/validation';
import { readExecutionSession, startExecutionSession, updateExecutionSession } from '../../../src/runtime/control-plane/execution/session-store';
import { launchSuperController } from '../../../src/runtime/control-plane/launcher/thin-launcher';
import { getExternalControllerLaunchReservation } from '../../../src/runtime/control-plane/launcher/launch-reservation-store';
import { providerMcpReservationIdentity } from '../../../src/runtime/control-plane/launcher/provider-mcp-bootstrap';
import { runWorkChatgptContinuation, settleWorkChatgptAutomationTab } from '../../../src/runtime/control-plane/launcher/chatgpt-work-continuation';
import {
  chatgptControllerRoundBinding,
  prepareControllerAssistantContext,
  prepareControllerAssistantContextBundle,
  recordChatgptControllerRoundTabSettlement,
  renderChatgptControllerRoundPrompt,
} from '../../../src/runtime/root/controller-round-composition';
import { assertAutomatedOperationAllowed } from '../../../src/runtime/control-plane/governance/external-effects';
import { ensureControllerDispositionContinuation } from '../../../src/runtime/workflow/schedules/work-continuation';
import { completeRequirementGoal } from '../../../src/runtime/control-plane/facade/requirement-authority';
import { ensureScheduledControllerBindingForWork } from '../../../src/runtime/root/scheduled-controller-composition';
import {
  acknowledgeControllerRoundClaim,
  beginControllerRoundRelayAfterRelease,
  beginInitialControllerRoundDispatch,
  controllerSessionAuthorityDigest,
  controllerSessionAuthorityMatches,
  controllerSessionPrincipalId,
  finishControllerRoundRelayDispatch,
  getControllerRoundRelay,
  getControllerSession,
  readControllerRoundContextSnapshot,
  getRetainedControllerSession,
  mintControllerSessionAuthority,
  reconcileControllerRoundAfterAbandonedRelease,
  releaseControllerSessionWithAuthority,
  resolveRequirementControllerRoundRelayForWork,
  resumeControllerSession,
  submitControllerRoundDisposition,
  type ControllerRoundDisposition,
  type ControllerRoundRelayRecord,
} from '../../../packages/kernel/controller/api/index';
import {
  assertFacadeControllerRoundAuthority,
  authenticatedFacadeControllerIdentity,
  bindFacadeControllerOwnership,
  dispatchedChatgptRelayAuthorizesStaleControllerRecovery,
  runtimeIdentitySnapshot,
} from './controller-authority-adapter';
import { persistAutomaticControllerRoundLearning } from '../../../src/runtime/context/automatic-learning';

const RH_WORK_CONTROLLER_OPERATIONS = new Set([
  'controller_get_owner',
  'controller_claim',
  'controller_disposition',
  'controller_release',
  'launcher_start',
]);

export function isRhWorkControllerOperation(operation: string): boolean {
  return RH_WORK_CONTROLLER_OPERATIONS.has(operation);
}

export async function callRhWorkControllerOperation(
  ctx: MultiRepositoryMcpToolContext,
  repository: RepositoryRecord,
  operation: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (!isRhWorkControllerOperation(operation)) return undefined;
  const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };

  if (operation === 'controller_get_owner') {
    const owner = getControllerSession(store, String(args.work_id ?? '').trim());
    return result(buildFacadeResult({
      summary: owner ? `Work is claimed by ${owner.controllerId}.` : 'Work has no active controller owner.',
      data: { owner },
    }) as unknown as Record<string, unknown>);
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
      if (session.controllerType !== 'human') ensureScheduledControllerBindingForWork(store, { workId, session, args });
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
      const disposition = String(args.disposition ?? '').trim();
      if (!['continue_immediately', 'wait', 'wait_for_user', 'goal_complete'].includes(disposition)) {
        throw new Error('CONTROLLER_RELAY_DISPOSITION_INVALID');
      }
      const identity = authenticatedFacadeControllerIdentity(ctx, args, { allowTransportSessionRollover: true });
      const work = getWorkContract(store, workId);
      if (!work) throw new Error(`WORK_NOT_FOUND: ${workId}`);
      const currentRelay = getControllerRoundRelay(store, workId);
      const automaticLearningRoundId = currentRelay?.status === 'claimed'
        ? `${currentRelay.relayScopeId}:${currentRelay.roundCount}`
        : undefined;
      const automaticLearningSignals = currentRelay?.status === 'claimed'
        ? readControllerRoundContextSnapshot(store, currentRelay).executionQualitySignals ?? []
        : [];
      const terminalGoalComplete = work.status === 'completed' && disposition === 'goal_complete';
      const terminalSuccessorContinuation = work.status === 'completed'
        && disposition === 'continue_immediately'
        && Boolean(currentRelay?.successorWorkId);
      const terminalRoundClosure = terminalGoalComplete || terminalSuccessorContinuation;
      const currentOwner = getControllerSession(store, workId);
      if (!currentOwner && terminalRoundClosure) {
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
        if (controllerSessionPrincipalId(currentOwner) !== identity.principalId) {
          throw new Error(`WORK_CONTROLLER_PRINCIPAL_MISMATCH: ${workId}`);
        }
        if (!terminalRoundClosure) {
          bindFacadeControllerOwnership(ctx, store, workId, { ...identity, controllerType: 'chatgpt' }, {
            relayScopeId: typeof args.relay_scope_id === 'string' ? args.relay_scope_id.trim() : undefined,
          });
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
          relayScopeId: typeof args.relay_scope_id === 'string' ? args.relay_scope_id : undefined,
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
              relayScopeId: typeof args.relay_scope_id === 'string' ? args.relay_scope_id : undefined,
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
      let automaticLearning;
      let automaticLearningWarning: string | undefined;
      if (automaticLearningRoundId) {
        const adjustmentFingerprints = Array.isArray(args.execution_quality_adjustment_results)
          ? args.execution_quality_adjustment_results
            .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
            .map(item => typeof item.fingerprint === 'string' ? item.fingerprint.trim() : '')
            .filter(Boolean)
          : [];
        try {
          automaticLearning = persistAutomaticControllerRoundLearning({
            controllerHome: ctx.controllerHome,
            repoId: repository.repoId,
            workId,
            sourceRoundId: automaticLearningRoundId,
            signals: automaticLearningSignals,
            adjustmentFingerprints,
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          automaticLearningWarning = `Automatic learning failed after the Controller disposition was durably recorded: ${reason}`;
          automaticLearning = {
            storedMemoryIds: [],
            consolidatedMemoryIds: [],
            promotedMemoryIds: [],
            skipped: [],
          };
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
        data: { relay, ...(requirementAcceptance ? { requirementAcceptance } : {}), ...(automaticLearning ? { automaticLearning } : {}), ...(continuationSchedule ? { continuationSchedule } : {}) },
        warnings: automaticLearningWarning ? [automaticLearningWarning] : [],
      }) as unknown as Record<string, unknown>, relay.status === 'blocked');
    } catch (error) {
      return result(buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Controller disposition failed.', data: {} }) as unknown as Record<string, unknown>, true);
    }
  }

  if (operation === 'controller_release') {
    try {
      const workId = String(args.work_id ?? '').trim();
      const identity = authenticatedFacadeControllerIdentity(ctx, args, { allowTransportSessionRollover: true });
      let explicitBlockedRelayCleanup = false;
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
        const blockedRelay = getControllerRoundRelay(store, workId);
        explicitBlockedRelayCleanup = Boolean(
          args.requested_by === 'user'
          && blockedRelay?.status === 'blocked'
          && observed
          && observed.controllerId === identity.controllerId
          && observed.controllerType === identity.controllerType
          && controllerSessionPrincipalId(observed) === identity.principalId
          && (observed.controllerInstanceId?.trim() || '') === identity.controllerInstanceId
          && runtime.running
          && runtime.runtimeInstanceId === identity.controllerInstanceId,
        );
        if (!samePrincipalCanonicalRuntimeMigration && !explicitBlockedRelayCleanup) throw error;
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
        ? (terminalWork || explicitBlockedRelayCleanup)
          ? (() => {
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
          : bindFacadeControllerOwnership(ctx, store, workId, identity, {
              relayScopeId: typeof args.relay_scope_id === 'string' ? args.relay_scope_id.trim() : undefined,
            })
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
            authorizationGrantRefs: relayBinding?.authorizationGrantRefs ?? predecessorBinding?.authorizationGrantRefs,
            tabPolicy: 'reuse',
          });
          if (dispatched.status === 'failed') throw new Error(`${dispatched.error?.code ?? 'CONTROLLER_RELAY_DISPATCH_FAILED'}:${dispatched.error?.message ?? 'Controller relay dispatch failed'}`);
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
            authorizationGrantRefs: binding?.authorizationGrantRefs,
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
      return result(buildFacadeResult({
        summary: `Thin Launcher started ${launched.controllerType}.`,
        data: { pid: launched.pid, executable: launched.executable, workId, reservationId: launched.reservationId },
      }) as unknown as Record<string, unknown>);
    } catch (error) {
      return result(buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Launcher failed.', data: {} }) as unknown as Record<string, unknown>, true);
    }
  }

  return undefined;
}
