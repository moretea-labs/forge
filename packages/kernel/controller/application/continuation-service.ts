import { getWorkContract, isTerminalWorkContractStatus } from '../../work/api/index';
import type { ControllerRoundRelayRecord } from '../domain/controller-round';
import { controllerRoundBlockerClass } from '../domain/controller-round-transition-policy';
import { getControllerWorkBinding } from '../infrastructure/controller-binding-store';
import {
  beginControllerRoundProviderDispatch,
  beginInitialControllerRoundDispatch,
  bindLegacyControllerRoundOccurrence,
  finishControllerRoundRelayDispatch,
  getControllerRoundRelay,
  getRequirementControllerRoundRelay,
  readControllerRoundSemanticStateFingerprint,
  reconcileControllerRoundAfterTerminalWork,
  type ControllerRoundRelayStoreOptions,
} from '../infrastructure/controller-round-store';
import { controllerSessionPrincipalId, getControllerSession, getRetainedControllerSession } from '../infrastructure/controller-session-store';
import type { ControllerHost } from '../ports/controller-host';

export interface ControllerRoundOccurrenceInput {
  occurrenceId: string;
  workId: string;
  controllerBindingId: string;
  relayScopeId?: string;
  continuationHint?: string;
  /** Scheduler-owned recovery only; normal continuation preserves semantic wait. */
  allowSemanticWaitRecovery?: boolean;
}

export type ControllerRoundOccurrenceOutcome = 'dispatched' | 'semantic_wait' | 'wait_for_user' | 'rejected';

export interface ControllerRoundOccurrenceResult {
  relay: ControllerRoundRelayRecord;
  outcome: ControllerRoundOccurrenceOutcome;
  reused: boolean;
  reason?: string;
  providerDispatchReceiptId?: string;
}

function reusedOccurrenceResult(relay: ControllerRoundRelayRecord): ControllerRoundOccurrenceResult | undefined {
  const blocker = controllerRoundBlockerClass(relay);
  if (blocker === 'provider_dispatch_outcome_unknown') {
    throw new Error(`CONTROLLER_CONTINUATION_OUTCOME_UNKNOWN:${relay.occurrenceId ?? relay.relayScopeId}`);
  }
  if (relay.status === 'dispatching') {
    if (relay.providerDispatchStartedAt) throw new Error(`CONTROLLER_CONTINUATION_ALREADY_DISPATCHING:${relay.occurrenceId ?? relay.originWorkId}`);
    return undefined;
  }
  if (relay.status === 'waiting_for_user') {
    return { relay, outcome: 'wait_for_user', reused: true, reason: relay.lastError };
  }
  if (relay.status === 'failed') {
    return { relay, outcome: 'rejected', reused: true, reason: relay.lastError ?? 'CONTROLLER_HOST_RESUME_REJECTED' };
  }
  if (relay.status === 'blocked') {
    throw new Error(`CONTROLLER_RELAY_LAUNCH_BLOCKED:${relay.blockedReason ?? relay.relayScopeId}`);
  }
  return {
    relay,
    outcome: 'dispatched',
    reused: true,
    providerDispatchReceiptId: relay.providerDispatchReceiptId,
  };
}

/**
 * Prepare the lower-layer ControllerRound without touching the provider. This is
 * the only path used when a Requirement-backed Work has an exact Workflow
 * Supervisor outer-turn boundary: Scheduler repairs/prepares the lower relay,
 * then Supervisor owns the actual ChatGPT message.
 */
export function prepareControllerRoundOccurrence(
  options: ControllerRoundRelayStoreOptions,
  input: ControllerRoundOccurrenceInput,
): ControllerRoundOccurrenceResult {
  const work = getWorkContract(options, input.workId);
  if (!work) throw new Error(`WORK_NOT_FOUND: ${input.workId}`);
  if (isTerminalWorkContractStatus(work.status)) throw new Error(`WORK_ALREADY_TERMINAL: ${work.workId}:${work.status}`);

  const session = getRetainedControllerSession(options, work.workId);
  if (!session) throw new Error(`CONTROLLER_SESSION_NOT_RETAINED: ${work.workId}`);
  const bindingRecord = getControllerWorkBinding(options, work.workId);
  if (!bindingRecord) throw new Error(`CONTROLLER_WORK_BINDING_NOT_FOUND: ${work.workId}`);
  if (bindingRecord.binding.bindingId !== input.controllerBindingId) {
    throw new Error(`CONTROLLER_CONTINUATION_BINDING_DRIFT:${work.workId}:expected=${input.controllerBindingId}:actual=${bindingRecord.binding.bindingId}`);
  }
  if (bindingRecord.binding.hostKind !== session.controllerType) {
    throw new Error(`CONTROLLER_CONTINUATION_HOST_KIND_MISMATCH:${work.workId}`);
  }

  const requestedRelayScopeId = input.relayScopeId?.trim() || undefined;
  const canonicalRelayScopeId = requestedRelayScopeId
    ?? (work.requirementId ? `requirement:${work.requirementId}` : `goal:${work.workId}`);

  // A failed/cancelled predecessor may leave the Requirement scope pointing at
  // its last ControllerRound after the Work itself has already terminalized.
  // Retire only that exact terminal/no-owner relay before preparing the current
  // Work. This is mechanical cleanup, not Requirement-level authority inheritance.
  if (work.requirementId) {
    const scopedRelay = getRequirementControllerRoundRelay(options, work.requirementId);
    if (scopedRelay && scopedRelay.originWorkId !== work.workId) {
      const scopedWork = getWorkContract(options, scopedRelay.originWorkId);
      if (scopedWork && ['failed', 'cancelled'].includes(scopedWork.status) && !getControllerSession(options, scopedWork.workId)) {
        reconcileControllerRoundAfterTerminalWork(options, {
          workId: scopedWork.workId,
          actor: `controller-continuation-terminal-scope-reconcile:${work.workId}`,
        });
      }
    }
  }

  let relay = getControllerRoundRelay(options, work.workId);

  if (relay?.status === 'failed') {
    if (relay.relayScopeId !== canonicalRelayScopeId) throw new Error(`CONTROLLER_CONTINUATION_OCCURRENCE_IDENTITY_CONFLICT:${input.occurrenceId}`);
    if (relay.occurrenceId && relay.occurrenceId !== input.occurrenceId) throw new Error(`CONTROLLER_CONTINUATION_FAILED_OCCURRENCE_MISMATCH:${relay.occurrenceId}`);
    // `failed` is the durable result of a ControllerHost rejection that explicitly
    // did not opt into same-round recovery. A later Scheduler occurrence must not
    // reinterpret that settled failure as recoverable or consume retry budget again.
    // Explicit provider repair/retry paths own any later rearm under their existing
    // authority and evidence fences.
    return reusedOccurrenceResult(relay)!;
  }

  if (relay?.occurrenceId === input.occurrenceId) {
    if (relay.relayScopeId !== canonicalRelayScopeId) throw new Error(`CONTROLLER_CONTINUATION_OCCURRENCE_IDENTITY_CONFLICT:${input.occurrenceId}`);
    const reused = reusedOccurrenceResult(relay);
    if (reused) return reused;
  }

  if (relay?.status === 'waiting' && relay.relayScopeId === canonicalRelayScopeId) {
    const currentFingerprint = readControllerRoundSemanticStateFingerprint(options, work.workId);
    if (currentFingerprint && currentFingerprint === relay.stateFingerprint && !input.allowSemanticWaitRecovery) {
      return {
        relay,
        outcome: 'semantic_wait',
        reused: false,
        reason: `Controller semantic wait remains unchanged for ${canonicalRelayScopeId}; provider dispatch suppressed.`,
      };
    }
  }

  const currentControllerPrincipalId = controllerSessionPrincipalId(session);
  const roundMatchesOccurrence = (candidate: ControllerRoundRelayRecord | undefined): boolean => Boolean(
    candidate
    && candidate.status === 'dispatching'
    && candidate.relayScopeId === canonicalRelayScopeId
    && candidate.occurrenceId === input.occurrenceId
    && candidate.controllerId === session.controllerId
    && candidate.controllerType === session.controllerType
    && candidate.authorityId,
  );
  const bindRecoveredLegacyOccurrence = (candidate: ControllerRoundRelayRecord | undefined): ControllerRoundRelayRecord | undefined => {
    if (!candidate
      || candidate.status !== 'dispatching'
      || candidate.occurrenceId
      || candidate.relayScopeId !== canonicalRelayScopeId
      || candidate.controllerId !== session.controllerId
      || candidate.controllerType !== session.controllerType
      || (candidate.principalId?.trim() || candidate.controllerId) !== currentControllerPrincipalId
      || !candidate.authorityId
      || candidate.providerDispatchStartedAt
      || (candidate.providerRecoveryEpoch ?? 0) < 1
      || !candidate.providerRecoveryEvidenceId) return candidate;
    return bindLegacyControllerRoundOccurrence(options, {
      workId: work.workId,
      relayScopeId: canonicalRelayScopeId,
      occurrenceId: input.occurrenceId,
      authorityId: candidate.authorityId,
      expectedUpdatedAt: candidate.updatedAt,
      identity: { controllerId: session.controllerId, controllerType: session.controllerType, principalId: currentControllerPrincipalId },
    });
  };

  if (relay && !roundMatchesOccurrence(relay)) {
    relay = bindRecoveredLegacyOccurrence(relay);
    if (!roundMatchesOccurrence(relay)) {
      if (['pending_release', 'dispatching', 'dispatched', 'claimed'].includes(relay?.status ?? '')) {
        throw new Error(`CONTROLLER_CONTINUATION_ROUND_ALREADY_OPEN:${input.occurrenceId}:${relay?.relayScopeId ?? canonicalRelayScopeId}`);
      }
      relay = undefined;
    }
  }

  if (!relay) {
    try {
      relay = beginInitialControllerRoundDispatch(options, {
        workId: work.workId,
        relayScopeId: requestedRelayScopeId,
        requirementId: work.requirementId,
        bindingId: bindingRecord.binding.bindingId,
        occurrenceId: input.occurrenceId,
        allowSemanticWaitRecovery: input.allowSemanticWaitRecovery,
        identity: {
          controllerId: session.controllerId,
          controllerType: session.controllerType,
          principalId: currentControllerPrincipalId,
          controllerInstanceId: session.controllerInstanceId?.trim() || session.controllerId,
          sessionId: session.sessionId,
        },
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('CONTROLLER_RELAY_ROUND_ALREADY_OPEN:')) throw error;
      let existing = getControllerRoundRelay(options, work.workId);
      if (!roundMatchesOccurrence(existing)) existing = bindRecoveredLegacyOccurrence(existing);
      if (!roundMatchesOccurrence(existing)) throw new Error(`CONTROLLER_CONTINUATION_ROUND_ALREADY_OPEN:${input.occurrenceId}:${canonicalRelayScopeId}`);
      relay = existing;
    }
  }
  if (!relay) throw new Error(`CONTROLLER_CONTINUATION_ROUND_NOT_AVAILABLE:${input.occurrenceId}:${canonicalRelayScopeId}`);
  if (relay.status === 'blocked') throw new Error(`CONTROLLER_RELAY_LAUNCH_BLOCKED:${relay.blockedReason ?? relay.relayScopeId}`);
  if (!relay.authorityId) throw new Error(`CONTROLLER_ROUND_AUTHORITY_REQUIRED:${relay.relayScopeId}`);
  if (relay.providerDispatchStartedAt) throw new Error(`CONTROLLER_CONTINUATION_ALREADY_DISPATCHING:${input.occurrenceId}`);

  return { relay, outcome: 'dispatched', reused: false };
}

/**
 * Trigger-to-Controller compatibility path for bootstrap/direct provider delivery.
 * Schedule/manual occurrences contribute only exact occurrence identity. Autonomous
 * outer ChatGPT turns are fenced by Workflow Supervisor Effect authority; ControllerRound
 * retains lower-layer claim/resume facts and mirrors direct bootstrap dispatch receipts.
 */
export async function resumeControllerRoundOccurrence(
  options: ControllerRoundRelayStoreOptions,
  input: ControllerRoundOccurrenceInput,
  host: ControllerHost,
): Promise<ControllerRoundOccurrenceResult> {
  const prepared = prepareControllerRoundOccurrence(options, input);
  if (prepared.outcome !== 'dispatched' || prepared.reused) return prepared;

  const work = getWorkContract(options, input.workId);
  if (!work) throw new Error(`WORK_NOT_FOUND: ${input.workId}`);
  const bindingRecord = getControllerWorkBinding(options, work.workId);
  if (!bindingRecord) throw new Error(`CONTROLLER_WORK_BINDING_NOT_FOUND: ${work.workId}`);
  let relay = prepared.relay;

  relay = beginControllerRoundProviderDispatch(options, {
    workId: work.workId,
    authorityId: relay.authorityId!,
    expectedUpdatedAt: relay.updatedAt,
    bindingId: bindingRecord.binding.bindingId,
  });

  try {
    const result = await host.resume(bindingRecord.binding, {
      workId: work.workId,
      relayScopeId: relay.relayScopeId,
      roundNumber: relay.roundCount,
      authorityId: relay.authorityId!,
      occurrenceId: input.occurrenceId,
      exactOriginWork: true,
      continuationHint: input.continuationHint?.trim() || undefined,
    });
    if (!result.accepted) {
      const reason = result.reason ?? 'CONTROLLER_HOST_RESUME_REJECTED';
      if (result.waitForUser) {
        const waiting = finishControllerRoundRelayDispatch(options, { workId: work.workId, ok: false, waitForUser: true, handoffId: result.handoffId, error: reason }) ?? relay;
        return { relay: waiting, outcome: 'wait_for_user', reused: false, reason };
      }
      const rejected = finishControllerRoundRelayDispatch(options, { workId: work.workId, ok: false, error: reason, recovery: result.recoverable === true }) ?? relay;
      return { relay: rejected, outcome: 'rejected', reused: false, reason };
    }
    const dispatched = finishControllerRoundRelayDispatch(options, {
      workId: work.workId,
      ok: true,
      bindingId: bindingRecord.binding.bindingId,
      providerDispatchReceiptId: result.dispatchId,
    }) ?? relay;
    return {
      relay: dispatched,
      outcome: 'dispatched',
      reused: false,
      providerDispatchReceiptId: dispatched.providerDispatchReceiptId ?? result.dispatchId,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const outcomeUnknown = /CONTROLLER_HOST_PROVIDER_DISPATCH_OUTCOME_UNKNOWN|CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN/i.test(reason);
    try { finishControllerRoundRelayDispatch(options, { workId: work.workId, ok: false, error: reason, outcomeUnknown }); } catch {}
    throw error;
  }
}
