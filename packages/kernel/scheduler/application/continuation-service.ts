import {
  beginInitialControllerRoundDispatch,
  controllerSessionPrincipalId,
  finishControllerRoundRelayDispatch,
  getControllerRoundRelay,
  getControllerWorkBinding,
  getRetainedControllerSession,
  type ControllerHost,
} from '../../controller/api/index';
import { getWorkContract, isTerminalWorkContractStatus } from '../../work/api/index';
import type { ScheduledControllerContinuationInput, ScheduledContinuationDispatch } from '../domain/continuation';
import {
  getScheduledContinuationDispatch,
  updateScheduledContinuationDispatch,
  type SchedulerContinuationStoreOptions,
} from '../infrastructure/continuation-dispatch-store';

export interface ScheduledControllerContinuationResult {
  dispatch: ScheduledContinuationDispatch;
  reused: boolean;
}

/**
 * Canonical Scheduler continuation path:
 * Schedule occurrence -> exact Work -> Work-scoped durable ControllerBinding -> current Controller delivery session -> ControllerHost.resume.
 * The occurrence record fences external replay independently of transport/provider behavior; ControllerSession ids are observation, not semantic continuation identity.
 */
export async function resumeScheduledControllerContinuation(
  options: SchedulerContinuationStoreOptions,
  input: ScheduledControllerContinuationInput,
  host: ControllerHost,
): Promise<ScheduledControllerContinuationResult> {
  const previous = getScheduledContinuationDispatch(options, input.occurrenceId);
  if (previous) {
    if (
      previous.scheduleId !== input.scheduleId
      || previous.workId !== input.workId
      || previous.controllerBindingId !== input.controllerBindingId
    ) throw new Error(`SCHEDULE_CONTINUATION_OCCURRENCE_IDENTITY_CONFLICT: ${input.occurrenceId}`);
    if (previous.status === 'dispatched' || previous.status === 'wait_for_user' || previous.status === 'rejected') return { dispatch: previous, reused: true };
    if (previous.status === 'outcome_unknown') throw new Error(`SCHEDULE_CONTINUATION_OUTCOME_UNKNOWN: ${input.occurrenceId}`);
    if (previous.status === 'dispatching') throw new Error(`SCHEDULE_CONTINUATION_ALREADY_DISPATCHING: ${input.occurrenceId}`);
  }

  const work = getWorkContract(options, input.workId);
  if (!work) throw new Error(`WORK_NOT_FOUND: ${input.workId}`);
  if (isTerminalWorkContractStatus(work.status)) throw new Error(`WORK_ALREADY_TERMINAL: ${work.workId}:${work.status}`);

  const session = getRetainedControllerSession(options, work.workId);
  if (!session) throw new Error(`CONTROLLER_SESSION_NOT_RETAINED: ${work.workId}`);
  const bindingRecord = getControllerWorkBinding(options, work.workId);
  if (!bindingRecord) throw new Error(`CONTROLLER_WORK_BINDING_NOT_FOUND: ${work.workId}`);
  if (bindingRecord.binding.bindingId !== input.controllerBindingId) {
    throw new Error(`SCHEDULE_CONTINUATION_BINDING_DRIFT: ${work.workId}:expected=${input.controllerBindingId}:actual=${bindingRecord.binding.bindingId}`);
  }
  if (bindingRecord.binding.hostKind !== session.controllerType) {
    throw new Error(`SCHEDULE_CONTINUATION_HOST_KIND_MISMATCH: ${work.workId}`);
  }

  const requestedRelayScopeId = input.relayScopeId?.trim() || undefined;
  const canonicalRelayScopeId = requestedRelayScopeId
    ?? (work.requirementId ? `requirement:${work.requirementId}` : `goal:${work.workId}`);

  // Reserve the exact occurrence before creating a ControllerRound. If Forge dies
  // after the round write but before the authority is copied back here, the next
  // attempt can safely adopt only the exact still-dispatching round for this
  // retained session/binding instead of minting or replaying another wake.
  let prepared = updateScheduledContinuationDispatch(options, input.occurrenceId, 'scheduler_continuation_prepare', (current, at) => current ?? ({
    schemaVersion: 1, repoId: options.repoId, scheduleId: input.scheduleId, occurrenceId: input.occurrenceId,
    workId: work.workId, controllerSessionId: session.sessionId, controllerBindingId: bindingRecord.binding.bindingId,
    relayScopeId: canonicalRelayScopeId, status: 'prepared', createdAt: at, updatedAt: at,
  }));
  if (prepared.status === 'dispatched' || prepared.status === 'wait_for_user' || prepared.status === 'rejected') return { dispatch: prepared, reused: true };
  if (prepared.status === 'outcome_unknown') throw new Error(`SCHEDULE_CONTINUATION_OUTCOME_UNKNOWN: ${input.occurrenceId}`);
  if (prepared.status === 'dispatching') throw new Error(`SCHEDULE_CONTINUATION_ALREADY_DISPATCHING: ${input.occurrenceId}`);

  const roundMatchesReservedOccurrence = (candidate: ReturnType<typeof getControllerRoundRelay>): boolean => Boolean(
    candidate
    && candidate.status === 'dispatching'
    && candidate.relayScopeId === prepared.relayScopeId
    && candidate.controllerId === session.controllerId
    && candidate.controllerType === session.controllerType
    && candidate.bindingId === bindingRecord.binding.bindingId
    && candidate.authorityId,
  );

  let relay = previous ? getControllerRoundRelay(options, work.workId) : undefined;
  if (relay && !roundMatchesReservedOccurrence(relay)) {
    throw new Error(`SCHEDULE_CONTINUATION_ROUND_ALREADY_OPEN: ${input.occurrenceId}:${relay.relayScopeId}`);
  }
  if (!relay) {
    try {
      relay = beginInitialControllerRoundDispatch(options, {
        workId: work.workId,
        relayScopeId: requestedRelayScopeId,
        requirementId: work.requirementId,
        bindingId: bindingRecord.binding.bindingId,
        identity: {
          controllerId: session.controllerId,
          controllerType: session.controllerType,
          principalId: controllerSessionPrincipalId(session),
          controllerInstanceId: session.controllerInstanceId?.trim() || session.controllerId,
          sessionId: session.sessionId,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('CONTROLLER_RELAY_ROUND_ALREADY_OPEN:') && previous) {
        const existing = getControllerRoundRelay(options, work.workId);
        if (roundMatchesReservedOccurrence(existing)) relay = existing;
        else throw new Error(`SCHEDULE_CONTINUATION_ROUND_ALREADY_OPEN: ${input.occurrenceId}:${canonicalRelayScopeId}`);
      } else {
        throw error;
      }
    }
  }
  if (!relay) throw new Error(`SCHEDULE_CONTINUATION_ROUND_MISSING: ${input.occurrenceId}`);
  if (relay.status === 'blocked') throw new Error(`CONTROLLER_RELAY_LAUNCH_BLOCKED: ${relay.blockedReason ?? relay.relayScopeId}`);
  if (!relay.authorityId) throw new Error(`CONTROLLER_ROUND_AUTHORITY_REQUIRED: ${relay.relayScopeId}`);

  prepared = updateScheduledContinuationDispatch(options, input.occurrenceId, 'scheduler_continuation_bind_round', (current, at) => ({
    ...(current ?? prepared), relayScopeId: relay.relayScopeId, controllerAuthorityId: relay.authorityId, status: 'prepared', updatedAt: at,
  }));

  updateScheduledContinuationDispatch(options, input.occurrenceId, 'scheduler_continuation_dispatch_begin', (current, at) => ({
    ...(current ?? prepared), status: 'dispatching', updatedAt: at,
  }));
  try {
    const result = await host.resume(bindingRecord.binding, {
      workId: work.workId,
      relayScopeId: relay.relayScopeId,
      roundNumber: relay.roundCount,
      authorityId: relay.authorityId,
      occurrenceId: input.occurrenceId,
      exactOriginWork: true,
      continuationHint: input.continuationHint?.trim() || undefined,
    });
    if (!result.accepted) {
      const reason = result.reason ?? 'CONTROLLER_HOST_RESUME_REJECTED';
      if (result.waitForUser) {
        finishControllerRoundRelayDispatch(options, { workId: work.workId, ok: false, waitForUser: true, handoffId: result.handoffId, error: reason });
        const waiting = updateScheduledContinuationDispatch(options, input.occurrenceId, 'scheduler_continuation_wait_for_user', (current, at) => ({
          ...(current ?? prepared), status: 'wait_for_user', reason, ...(result.handoffId ? { handoffId: result.handoffId } : {}), updatedAt: at,
        }));
        return { dispatch: waiting, reused: false };
      }
      finishControllerRoundRelayDispatch(options, { workId: work.workId, ok: false, error: reason });
      const rejected = updateScheduledContinuationDispatch(options, input.occurrenceId, 'scheduler_continuation_rejected', (current, at) => ({
        ...(current ?? prepared), status: 'rejected', reason, updatedAt: at,
      }));
      return { dispatch: rejected, reused: false };
    }
    finishControllerRoundRelayDispatch(options, { workId: work.workId, ok: true, bindingId: bindingRecord.binding.bindingId, providerDispatchReceiptId: result.dispatchId });
    const dispatched = updateScheduledContinuationDispatch(options, input.occurrenceId, 'scheduler_continuation_dispatched', (current, at) => ({
      ...(current ?? prepared), status: 'dispatched', ...(result.dispatchId ? { hostDispatchId: result.dispatchId } : {}), updatedAt: at,
    }));
    return { dispatch: dispatched, reused: false };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const providerDispatchOutcomeUnknown = /CONTROLLER_HOST_PROVIDER_DISPATCH_OUTCOME_UNKNOWN|CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN/i.test(reason);
    try { finishControllerRoundRelayDispatch(options, { workId: work.workId, ok: false, error: reason, outcomeUnknown: providerDispatchOutcomeUnknown }); } catch {}
    updateScheduledContinuationDispatch(options, input.occurrenceId, 'scheduler_continuation_outcome_unknown', (current, at) => ({
      ...(current ?? prepared), status: 'outcome_unknown', reason, updatedAt: at,
    }));
    throw error;
  }
}
