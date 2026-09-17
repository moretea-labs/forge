import { createHash } from 'crypto';
import type { ControllerSession } from './types';
import type { ControllerRoundDisposition, ControllerRoundRelayIdentity, ControllerRoundRelayRecord } from './controller-round';

export function controllerRoundProviderEffectId(relayScopeId: string, authorityId: string): string {
  return `crpe_${createHash('sha256').update(JSON.stringify([relayScopeId.trim(), authorityId.trim()])).digest('hex')}`;
}

export type ControllerRoundBlockerClass =
  | 'repeated_state'
  | 'consecutive_failures'
  | 'round_budget_exhausted'
  | 'provider_dispatch_outcome_unknown'
  | 'provider_user_action_required';

export function controllerRoundBlockerClass(record: Pick<ControllerRoundRelayRecord, 'status' | 'blockedReason'>): ControllerRoundBlockerClass | undefined {
  if (record.status === 'waiting_for_user' && record.blockedReason === 'provider_user_action_required') return 'provider_user_action_required';
  if (record.status !== 'blocked') return undefined;
  const reason = record.blockedReason ?? '';
  if (reason === 'provider_dispatch_outcome_unknown') return 'provider_dispatch_outcome_unknown';
  if (reason.startsWith('repeated_state:')) return 'repeated_state';
  if (reason.startsWith('consecutive_failures:')) return 'consecutive_failures';
  if (reason.startsWith('round_budget_exhausted:')) return 'round_budget_exhausted';
  return undefined;
}

export type ControllerRoundTransitionEvent =
  | { type: 'occurrence_requested'; at: string; repoId: string; relayScopeId: string; originWorkId: string; requirementId?: string; identity: ControllerRoundRelayIdentity; stateFingerprint: string; proposedAuthorityId: string; maxRounds: number; maxRepeatedState: number; maxFailures: number; bindingId?: string; occurrenceId?: string; abandonedReleaseRecovery: boolean }
  | { type: 'provider_dispatch_started'; at: string; providerDispatchEffectId: string; bindingId?: string }
  | { type: 'provider_dispatch_succeeded'; at: string; providerDispatchEffectId: string; bindingId?: string; providerDispatchReceiptId?: string }
  | { type: 'provider_dispatch_failed'; at: string; error: string; recovery: boolean; nextRecoveryAt?: string }
  | { type: 'provider_dispatch_outcome_unknown'; at: string; error: string; providerDispatchEffectId: string }
  | { type: 'provider_user_action_required'; at: string; error: string; handoffId: string }
  | { type: 'controller_claim_observed'; at: string; session: ControllerSession & { claimGeneration: number }; principalId: string; controllerInstanceId: string }
  | { type: 'controller_turn_settled'; at: string; stateFingerprint: string; completionEvidenceId: string; blockingHandoffId?: string }
  | { type: 'semantic_state_changed'; at: string; stateFingerprint: string; session: ControllerSession & { claimGeneration: number }; principalId: string; controllerInstanceId: string }
  | { type: 'stalled_round_observed'; at: string; stateFingerprint: string; proposedAuthorityId: string; lastError?: string }
  | { type: 'provider_environment_recovered'; at: string; evidenceId: string }
  | { type: 'legacy_occurrence_bound'; at: string; occurrenceId: string }
  | { type: 'semantic_disposition_submitted'; at: string; disposition: ControllerRoundDisposition; stateFingerprint: string; maxRounds: number; maxRepeatedState: number; maxFailures: number; controllerSession: Pick<ControllerSession, 'controllerId' | 'controllerType' | 'principalId' | 'controllerInstanceId' | 'sessionId' | 'claimGeneration'>; handoffId?: string; reason?: string; bindingId?: string; qualityDecisions?: ControllerRoundRelayRecord['qualityDecisions']; qualityAdjustmentResults?: ControllerRoundRelayRecord['qualityAdjustmentResults']; observationWindow?: ControllerRoundRelayRecord['observationWindow'] }
  | { type: 'successor_bound'; at: string; successorWorkId: string }
  | { type: 'controller_release_observed'; at: string; proposedAuthorityId: string }
  | { type: 'successor_release_handoff'; at: string; successorWorkId: string; successorStateFingerprint: string; proposedAuthorityId: string }
  | { type: 'terminal_work_observed'; at: string; error: string }
  | { type: 'abandoned_release_observed'; at: string; error: string }
  | { type: 'authority_recovery_requested'; at: string; proposedAuthorityId: string; keepsConfirmedDispatch: boolean };

export type ControllerRoundTransitionDecision =
  | { kind: 'accept'; next: ControllerRoundRelayRecord; action: string }
  | { kind: 'accept_atomic'; next: ControllerRoundRelayRecord; action: string; relatedWorkId: string; relatedNext: ControllerRoundRelayRecord; relatedAction: string }
  | { kind: 'no_op'; current: ControllerRoundRelayRecord; reason: string }
  | { kind: 'reject'; code: string }
  | { kind: 'needs_evidence'; code: string };

function accept(current: ControllerRoundRelayRecord, patch: Partial<ControllerRoundRelayRecord>, action: string): ControllerRoundTransitionDecision {
  return { kind: 'accept', next: { ...current, ...patch }, action };
}

export function decideControllerRoundTransition(
  current: ControllerRoundRelayRecord | undefined,
  event: ControllerRoundTransitionEvent,
): ControllerRoundTransitionDecision {
  switch (event.type) {
    case 'occurrence_requested': {
      const previous = current;
      if (previous) {
        if (['pending_release', 'dispatching', 'dispatched', 'claimed'].includes(previous.status)) return { kind: 'reject', code: `CONTROLLER_RELAY_ROUND_ALREADY_OPEN:${previous.relayScopeId}` };
        const blocker = controllerRoundBlockerClass(previous);
        if (blocker === 'provider_dispatch_outcome_unknown') return { kind: 'reject', code: `CONTROLLER_RELAY_PROVIDER_DISPATCH_OUTCOME_UNKNOWN:${previous.relayScopeId}` };
        if (blocker) return { kind: 'reject', code: `CONTROLLER_RELAY_BLOCKED_OCCURRENCE_FORBIDDEN:${blocker}` };
        if (previous.status === 'waiting_for_user') return { kind: 'reject', code: 'CONTROLLER_RELAY_USER_RESUME_REQUIRED' };
        if (previous.status === 'goal_complete' || previous.status === 'handed_off') return { kind: 'reject', code: `CONTROLLER_RELAY_TERMINAL_OCCURRENCE_FORBIDDEN:${previous.status}` };
        // A terminal provider failure is still the same relay attempt.  The
        // provider adapter may retry that known, non-ambiguous failure without
        // manufacturing a new semantic occurrence.  A caller that presents an
        // occurrence id is explicitly asking to reopen the failed lineage as
        // an external occurrence, which remains fenced below.  Other prior
        // semantic states require an occurrence id so an external wake cannot
        // silently replay an old lineage.
        if (previous.status !== 'failed' && !event.abandonedReleaseRecovery && !event.occurrenceId?.trim()) return { kind: 'needs_evidence', code: 'CONTROLLER_RELAY_OCCURRENCE_ID_REQUIRED' };
        if (event.occurrenceId?.trim() && previous.occurrenceId === event.occurrenceId.trim()) return { kind: 'reject', code: `CONTROLLER_RELAY_OCCURRENCE_ALREADY_APPLIED:${event.occurrenceId.trim()}` };
        if (previous.status === 'waiting' && previous.stateFingerprint === event.stateFingerprint) return { kind: 'reject', code: 'CONTROLLER_RELAY_WAITING_STATE_UNCHANGED' };
        if (previous.status === 'failed' && !event.abandonedReleaseRecovery && event.occurrenceId?.trim()) return { kind: 'reject', code: 'CONTROLLER_RELAY_FAILED_REQUIRES_EXPLICIT_RESUME' };
        if (event.abandonedReleaseRecovery && previous.status !== 'failed') return { kind: 'reject', code: 'CONTROLLER_RELAY_ABANDONED_RECOVERY_STATE_INVALID' };
      }
      const maxRounds = previous ? Math.min(previous.maxRounds, event.maxRounds) : event.maxRounds;
      const maxRepeatedState = previous ? Math.min(previous.maxRepeatedState, event.maxRepeatedState) : event.maxRepeatedState;
      const maxFailures = previous ? Math.min(previous.maxFailures, event.maxFailures) : event.maxFailures;
      // A legal new semantic occurrence advances the existing lineage budget; it never
      // launders round/repeated history back to an initial record. Provider failure
      // streak is responsibility-local, while providerFailureTotal below remains the
      // durable historical audit across occurrences.
      const roundCount = previous ? previous.roundCount + 1 : 1;
      const repeatedStateCount = previous ? (previous.stateFingerprint === event.stateFingerprint ? previous.repeatedStateCount + 1 : 0) : 0;
      const consecutiveFailures = event.abandonedReleaseRecovery && previous ? previous.consecutiveFailures : 0;
      let blockedReason: string | undefined;
      if (roundCount > maxRounds) blockedReason = `round_budget_exhausted:${roundCount}>${maxRounds}`;
      else if (repeatedStateCount >= maxRepeatedState) blockedReason = `repeated_state:${repeatedStateCount}>=${maxRepeatedState}`;
      else if (consecutiveFailures >= maxFailures) blockedReason = `consecutive_failures:${consecutiveFailures}>=${maxFailures}`;
      const record: ControllerRoundRelayRecord = {
        schemaVersion: 1, repoId: event.repoId, relayScopeId: event.relayScopeId, originWorkId: event.originWorkId,
        ...(event.requirementId ? { requirementId: event.requirementId } : {}), disposition: 'continue_immediately',
        status: blockedReason ? 'blocked' : 'dispatching', lifecycleStage: 'dispatching',
        observationWindow: previous?.observationWindow, qualityDecisions: previous?.qualityDecisions, qualityAdjustmentResults: previous?.qualityAdjustmentResults,
        controllerId: event.identity.controllerId.trim().slice(0, 240) || 'controller-host', controllerType: event.identity.controllerType,
        principalId: event.identity.principalId.trim().slice(0, 240) || event.identity.controllerId.trim().slice(0, 240),
        controllerInstanceId: event.identity.controllerInstanceId.trim().slice(0, 240), sessionId: event.identity.sessionId.trim().slice(0, 240),
        claimGeneration: 0, authorityId: event.proposedAuthorityId, stateFingerprint: event.stateFingerprint, roundCount, repeatedStateCount, consecutiveFailures,
        ...(previous?.providerFailureTotal !== undefined ? { providerFailureTotal: previous.providerFailureTotal } : {}),
        ...(previous?.providerRecoveryEpoch !== undefined ? { providerRecoveryEpoch: previous.providerRecoveryEpoch } : {}),
        ...(previous?.providerRecoveryEvidenceId ? { providerRecoveryEvidenceId: previous.providerRecoveryEvidenceId } : {}),
        maxRounds, maxRepeatedState, maxFailures,
        reason: event.abandonedReleaseRecovery ? 'launcher_start_recovered_abandoned_claim' : 'launcher_start_requested_continuation',
        ...(event.bindingId ? { bindingId: event.bindingId } : previous?.bindingId ? { bindingId: previous.bindingId } : {}),
        ...(event.occurrenceId ? { occurrenceId: event.occurrenceId } : {}), ...(blockedReason ? { blockedReason } : {}), submittedAt: event.at, updatedAt: event.at,
      };
      return { kind: 'accept', next: record, action: blockedReason ? 'controller_round_initial_launch_blocked' : 'controller_round_initial_launch_begin' };
    }
    case 'provider_dispatch_started': {
      if (!current) return { kind: 'reject', code: 'CONTROLLER_RELAY_CURRENT_REQUIRED' };
      if (current.status !== 'dispatching') return { kind: 'reject', code: `CONTROLLER_RELAY_DISPATCH_STATE_INVALID:${current.status}` };
      const providerDispatchEffectId = event.providerDispatchEffectId.trim();
      if (!providerDispatchEffectId) return { kind: 'needs_evidence', code: 'CONTROLLER_RELAY_PROVIDER_EFFECT_ID_REQUIRED' };
      if (current.providerDispatchStartedAt) {
        if (current.providerDispatchEffectId === providerDispatchEffectId) return { kind: 'no_op', current, reason: 'provider_dispatch_already_started' };
        return { kind: 'reject', code: 'CONTROLLER_RELAY_PROVIDER_EFFECT_MISMATCH' };
      }
      return accept(current, {
        providerDispatchEffectId,
        providerDispatchAttempt: (current.providerDispatchAttempt ?? 0) + 1,
        providerDispatchStartedAt: event.at,
        ...(event.bindingId ? { bindingId: event.bindingId } : {}),
        updatedAt: event.at,
      }, 'controller_round_provider_dispatch_started');
    }
    case 'provider_dispatch_succeeded': {
      if (!current) return { kind: 'reject', code: 'CONTROLLER_RELAY_CURRENT_REQUIRED' };
      if (current.status === 'dispatched') return { kind: 'no_op', current, reason: 'dispatch_already_confirmed' };
      if (current.status !== 'dispatching') return { kind: 'reject', code: `CONTROLLER_RELAY_DISPATCH_STATE_INVALID:${current.status}` };
      if (current.providerDispatchEffectId && current.providerDispatchEffectId !== event.providerDispatchEffectId) return { kind: 'reject', code: 'CONTROLLER_RELAY_PROVIDER_EFFECT_MISMATCH' };
      return accept(current, {
        status: 'dispatched', lifecycleStage: 'dispatch_confirmed', consecutiveFailures: 0, providerDispatchEffectId: event.providerDispatchEffectId,
        providerDispatchAttempt: current.providerDispatchAttempt ?? 1, providerDispatchStartedAt: current.providerDispatchStartedAt ?? event.at,
        failureClass: undefined, lastError: undefined, nextRecoveryAt: undefined, blockedReason: undefined,
        ...(event.bindingId ? { bindingId: event.bindingId } : {}),
        ...(event.providerDispatchReceiptId ? { providerDispatchReceiptId: event.providerDispatchReceiptId } : {}),
        dispatchedAt: event.at, updatedAt: event.at,
      }, 'controller_round_relay_dispatched');
    }
    case 'provider_dispatch_outcome_unknown': {
      if (!current) return { kind: 'reject', code: 'CONTROLLER_RELAY_CURRENT_REQUIRED' };
      if (current.status !== 'dispatching') return { kind: 'reject', code: `CONTROLLER_RELAY_DISPATCH_STATE_INVALID:${current.status}` };
      if (!event.providerDispatchEffectId.trim()) return { kind: 'needs_evidence', code: 'CONTROLLER_RELAY_PROVIDER_EFFECT_ID_REQUIRED' };
      if (current.providerDispatchEffectId && current.providerDispatchEffectId !== event.providerDispatchEffectId) return { kind: 'reject', code: 'CONTROLLER_RELAY_PROVIDER_EFFECT_MISMATCH' };
      return accept(current, {
        status: 'blocked', consecutiveFailures: current.consecutiveFailures + 1, providerFailureTotal: (current.providerFailureTotal ?? 0) + 1, nextRecoveryAt: undefined,
        failureClass: undefined, lastError: event.error, blockedReason: 'provider_dispatch_outcome_unknown',
        providerDispatchEffectId: event.providerDispatchEffectId, providerDispatchAttempt: current.providerDispatchAttempt ?? 1,
        providerDispatchStartedAt: current.providerDispatchStartedAt ?? event.at, updatedAt: event.at,
      }, 'controller_round_relay_dispatch_outcome_unknown');
    }
    case 'provider_user_action_required': {
      if (!current) return { kind: 'reject', code: 'CONTROLLER_RELAY_CURRENT_REQUIRED' };
      if (current.status !== 'dispatching') return { kind: 'reject', code: `CONTROLLER_RELAY_DISPATCH_STATE_INVALID:${current.status}` };
      if (!event.handoffId.trim()) return { kind: 'needs_evidence', code: 'CONTROLLER_RELAY_WAIT_FOR_USER_HANDOFF_REQUIRED' };
      return accept(current, {
        status: 'waiting_for_user', nextRecoveryAt: undefined, failureClass: undefined, lastError: event.error,
        blockedReason: 'provider_user_action_required', handoffId: event.handoffId, updatedAt: event.at,
      }, 'controller_round_relay_waiting_for_user');
    }
    case 'provider_dispatch_failed': {
      if (!current) return { kind: 'reject', code: 'CONTROLLER_RELAY_CURRENT_REQUIRED' };
      if (current.status !== 'dispatching') return { kind: 'reject', code: `CONTROLLER_RELAY_DISPATCH_STATE_INVALID:${current.status}` };
      const failures = current.consecutiveFailures + 1;
      if (!event.recovery) {
        return accept(current, { status: 'failed', consecutiveFailures: failures, providerFailureTotal: (current.providerFailureTotal ?? 0) + 1, nextRecoveryAt: undefined, failureClass: undefined, lastError: event.error, updatedAt: event.at }, 'controller_round_relay_failed');
      }
      const blocked = failures >= current.maxFailures;
      return accept(current, {
        status: blocked ? 'blocked' : 'dispatching', consecutiveFailures: failures, providerFailureTotal: (current.providerFailureTotal ?? 0) + 1, failureClass: undefined, lastError: event.error,
        blockedReason: blocked ? `consecutive_failures:${failures}>=${current.maxFailures}` : undefined,
        ...(blocked ? {} : { providerDispatchEffectId: undefined, providerDispatchStartedAt: undefined, providerDispatchReceiptId: undefined }),
        nextRecoveryAt: blocked ? undefined : event.nextRecoveryAt, updatedAt: event.at,
      }, blocked ? 'controller_round_relay_recovery_blocked' : 'controller_round_relay_recovery_retry_scheduled');
    }
    case 'provider_environment_recovered': {
      if (!current) return { kind: 'reject', code: 'CONTROLLER_RELAY_CURRENT_REQUIRED' };
      if (controllerRoundBlockerClass(current) !== 'consecutive_failures') return { kind: 'reject', code: 'CONTROLLER_RELAY_PROVIDER_RECOVERY_BLOCKER_MISMATCH' };
      if (!event.evidenceId.trim()) return { kind: 'needs_evidence', code: 'CONTROLLER_RELAY_PROVIDER_RECOVERY_EVIDENCE_REQUIRED' };
      return accept(current, {
        status: 'dispatching', lifecycleStage: 'dispatching', consecutiveFailures: 0,
        providerRecoveryEpoch: (current.providerRecoveryEpoch ?? 0) + 1, providerRecoveryEvidenceId: event.evidenceId.slice(0, 500),
        providerDispatchEffectId: undefined, providerDispatchStartedAt: undefined, providerDispatchReceiptId: undefined,
        blockedReason: undefined, failureClass: undefined, lastError: undefined, nextRecoveryAt: undefined,
        reason: `provider_environment_recovered:${event.evidenceId.slice(0, 240)}`, updatedAt: event.at,
      }, 'controller_round_relay_provider_environment_recovered');
    }
    case 'legacy_occurrence_bound': {
      if (!current) return { kind: 'reject', code: 'CONTROLLER_RELAY_CURRENT_REQUIRED' };
      if (current.status !== 'dispatching') return { kind: 'reject', code: `CONTROLLER_RELAY_LEGACY_OCCURRENCE_STATE_INVALID:${current.status}` };
      if (current.occurrenceId?.trim()) return { kind: 'reject', code: `CONTROLLER_RELAY_OCCURRENCE_ALREADY_BOUND:${current.occurrenceId.trim()}` };
      if (!current.authorityId?.trim()) return { kind: 'needs_evidence', code: 'CONTROLLER_RELAY_LEGACY_OCCURRENCE_AUTHORITY_REQUIRED' };
      if ((current.providerRecoveryEpoch ?? 0) < 1 || !current.providerRecoveryEvidenceId?.trim()) {
        return { kind: 'needs_evidence', code: 'CONTROLLER_RELAY_LEGACY_OCCURRENCE_PROVIDER_RECOVERY_REQUIRED' };
      }
      const occurrenceId = event.occurrenceId.trim();
      if (!occurrenceId) return { kind: 'needs_evidence', code: 'CONTROLLER_RELAY_OCCURRENCE_ID_REQUIRED' };
      return accept(current, { occurrenceId, updatedAt: event.at }, 'controller_round_relay_legacy_occurrence_bound');
    }
    case 'controller_claim_observed': {
      if (!current) return { kind: 'reject', code: 'CONTROLLER_RELAY_CURRENT_REQUIRED' };
      if (current.status === 'claimed') {
        if (current.controllerId === event.session.controllerId && current.sessionId === event.session.sessionId && current.claimGeneration === event.session.claimGeneration) {
          return { kind: 'no_op', current, reason: 'claim_already_acknowledged' };
        }
        return accept(current, { controllerType: event.session.controllerType, controllerInstanceId: event.controllerInstanceId, sessionId: event.session.sessionId, claimGeneration: event.session.claimGeneration, lifecycleStage: 'controller_claimed', claimedAt: event.at, updatedAt: event.at, failureClass: undefined, lastError: undefined }, 'controller_round_relay_claim_migrated');
      }
      const blocker = controllerRoundBlockerClass(current);
      if (blocker === 'provider_dispatch_outcome_unknown') {
        if (!current.providerDispatchEffectId) return { kind: 'needs_evidence', code: 'CONTROLLER_RELAY_PROVIDER_EFFECT_ID_REQUIRED' };
        return accept(current, { status: 'claimed', lifecycleStage: 'controller_claimed', controllerId: event.session.controllerId, controllerType: event.session.controllerType, principalId: event.principalId, controllerInstanceId: event.controllerInstanceId, sessionId: event.session.sessionId, claimGeneration: event.session.claimGeneration, consecutiveFailures: 0, blockedReason: undefined, failureClass: undefined, lastError: undefined, nextRecoveryAt: undefined, claimedAt: event.at, updatedAt: event.at }, 'controller_round_relay_claim_confirmed_unknown_dispatch');
      }
      if (!['dispatching', 'dispatched'].includes(current.status)) return { kind: 'reject', code: `CONTROLLER_RELAY_CLAIM_STATE_INVALID:${current.status}` };
      return accept(current, { status: 'claimed', lifecycleStage: 'controller_claimed', controllerId: event.session.controllerId, controllerType: event.session.controllerType, principalId: event.principalId, controllerInstanceId: event.controllerInstanceId, sessionId: event.session.sessionId, claimGeneration: event.session.claimGeneration, claimedAt: event.at, updatedAt: event.at, failureClass: undefined, lastError: undefined }, 'controller_round_relay_claim_acknowledged');
    }
    case 'controller_turn_settled': {
      if (!current) return { kind: 'reject', code: 'CONTROLLER_RELAY_CURRENT_REQUIRED' };
      if (current.status !== 'claimed') {
        if (['pending_release', 'waiting', 'waiting_for_user', 'goal_complete', 'handed_off', 'blocked', 'failed'].includes(current.status)) {
          return { kind: 'no_op', current, reason: `controller_turn_already_closed:${current.status}` };
        }
        return { kind: 'reject', code: `CONTROLLER_RELAY_TURN_SETTLED_STATE_INVALID:${current.status}` };
      }
      const completionEvidenceId = event.completionEvidenceId.trim();
      if (!completionEvidenceId) return { kind: 'needs_evidence', code: 'CONTROLLER_RELAY_TURN_COMPLETION_EVIDENCE_REQUIRED' };
      const blockingHandoffId = event.blockingHandoffId?.trim();
      if (blockingHandoffId) {
        return accept(current, {
          disposition: 'wait_for_user', status: 'waiting_for_user', lifecycleStage: 'semantic_round_closed',
          stateFingerprint: event.stateFingerprint, handoffId: blockingHandoffId,
          controllerTurnCompletionEvidenceId: completionEvidenceId, controllerTurnSettledAt: event.at,
          reason: current.reason ?? 'controller_turn_settled_with_blocking_handoff',
          submittedAt: event.at, updatedAt: event.at,
        }, 'controller_round_turn_settled_wait_for_user');
      }
      const roundCount = current.roundCount + 1;
      const repeatedStateCount = current.stateFingerprint === event.stateFingerprint ? current.repeatedStateCount + 1 : 0;
      let blockedReason: string | undefined;
      if (roundCount > current.maxRounds) blockedReason = `round_budget_exhausted:${roundCount}>${current.maxRounds}`;
      else if (repeatedStateCount >= current.maxRepeatedState) blockedReason = `repeated_state:${repeatedStateCount}>=${current.maxRepeatedState}`;
      else if (current.consecutiveFailures >= current.maxFailures) blockedReason = `consecutive_failures:${current.consecutiveFailures}>=${current.maxFailures}`;
      return accept(current, {
        disposition: 'continue_immediately', status: blockedReason ? 'blocked' : 'pending_release', lifecycleStage: 'semantic_round_closed',
        stateFingerprint: event.stateFingerprint, roundCount, repeatedStateCount, blockedReason,
        controllerTurnCompletionEvidenceId: completionEvidenceId, controllerTurnSettledAt: event.at,
        reason: current.reason ?? 'controller_turn_settled_nonterminal_work',
        submittedAt: event.at, updatedAt: event.at,
      }, blockedReason ? 'controller_round_turn_settled_blocked' : 'controller_round_turn_settled_autocontinue');
    }
    case 'semantic_state_changed': {
      if (!current) return { kind: 'reject', code: 'CONTROLLER_RELAY_CURRENT_REQUIRED' };
      if (controllerRoundBlockerClass(current) !== 'repeated_state') return { kind: 'reject', code: 'CONTROLLER_RELAY_SEMANTIC_PROGRESS_BLOCKER_MISMATCH' };
      if (event.stateFingerprint === current.stateFingerprint) return { kind: 'no_op', current, reason: 'semantic_fingerprint_unchanged' };
      if (current.roundCount > current.maxRounds || current.consecutiveFailures >= current.maxFailures) return { kind: 'reject', code: 'CONTROLLER_RELAY_OTHER_BUDGET_EXHAUSTED' };
      return accept(current, { status: 'claimed', lifecycleStage: 'controller_claimed', controllerId: event.session.controllerId, controllerType: event.session.controllerType, principalId: event.principalId, controllerInstanceId: event.controllerInstanceId, sessionId: event.session.sessionId, claimGeneration: event.session.claimGeneration, stateFingerprint: event.stateFingerprint, repeatedStateCount: 0, blockedReason: undefined, failureClass: undefined, lastError: undefined, claimedAt: event.at, updatedAt: event.at }, 'controller_round_relay_claim_rearmed_after_state_change');
    }
    case 'stalled_round_observed': {
      if (!current) return { kind: 'reject', code: 'CONTROLLER_RELAY_CURRENT_REQUIRED' };
      const blocker = controllerRoundBlockerClass(current);
      if (blocker && blocker !== 'repeated_state') return { kind: 'reject', code: `CONTROLLER_RELAY_STALLED_BLOCKER_NOT_RECOVERABLE:${blocker}` };
      if (!['pending_release', 'dispatching', 'dispatched', 'claimed', 'blocked'].includes(current.status)) return { kind: 'reject', code: `CONTROLLER_RELAY_STALLED_STATE_INVALID:${current.status}` };
      if (blocker === 'repeated_state' && event.stateFingerprint === current.stateFingerprint) return { kind: 'no_op', current, reason: 'semantic_fingerprint_unchanged' };
      const resumesUndispatchedRound = current.status === 'pending_release' || current.status === 'dispatching';
      const roundCount = current.roundCount + (resumesUndispatchedRound ? 0 : 1);
      const repeatedStateCount = resumesUndispatchedRound ? current.repeatedStateCount : current.stateFingerprint === event.stateFingerprint ? current.repeatedStateCount + 1 : 0;
      let blockedReason: string | undefined;
      if (roundCount > current.maxRounds) blockedReason = `round_budget_exhausted:${roundCount}>${current.maxRounds}`;
      else if (repeatedStateCount >= current.maxRepeatedState) blockedReason = `repeated_state:${repeatedStateCount}>=${current.maxRepeatedState}`;
      if (blockedReason) return accept(current, { status: 'blocked', stateFingerprint: event.stateFingerprint, roundCount, repeatedStateCount, blockedReason, updatedAt: event.at }, 'controller_round_relay_stalled_blocked');
      const resumesSameDispatch = current.status === 'dispatching';
      const authorityId = resumesSameDispatch && current.authorityId ? current.authorityId : event.proposedAuthorityId;
      return accept(current, { authorityId, status: 'dispatching', lifecycleStage: 'dispatching', stateFingerprint: event.stateFingerprint, roundCount, repeatedStateCount, failureClass: undefined, lastError: blocker === 'repeated_state' ? undefined : event.lastError, reason: blocker === 'repeated_state' ? 'semantic_state_changed_after_repeated_state_block' : current.reason, nextRecoveryAt: undefined, claimedAt: undefined, blockedReason: undefined, controllerTurnCompletionEvidenceId: undefined, controllerTurnSettledAt: undefined, ...(resumesSameDispatch ? {} : { providerDispatchEffectId: undefined, providerDispatchAttempt: 0, providerDispatchStartedAt: undefined, providerDispatchReceiptId: undefined }), updatedAt: event.at }, 'controller_round_relay_stalled_recovery_begin');
    }
    case 'semantic_disposition_submitted': {
      if (!current) return { kind: 'reject', code: 'CONTROLLER_RELAY_CURRENT_REQUIRED' };
      if (current.status !== 'claimed') return { kind: 'reject', code: `CONTROLLER_RELAY_ROUND_NOT_CLAIMED:${current.status}` };
      const maxRounds = Math.min(current.maxRounds, event.maxRounds);
      const maxRepeatedState = Math.min(current.maxRepeatedState, event.maxRepeatedState);
      const maxFailures = Math.min(current.maxFailures, event.maxFailures);
      const continuing = event.disposition === 'continue_immediately';
      const roundCount = current.roundCount + (continuing ? 1 : 0);
      const repeatedStateCount = continuing
        ? (current.stateFingerprint === event.stateFingerprint ? current.repeatedStateCount + 1 : 0)
        : current.repeatedStateCount;
      let blockedReason: string | undefined;
      if (continuing) {
        if (roundCount > maxRounds) blockedReason = `round_budget_exhausted:${roundCount}>${maxRounds}`;
        else if (repeatedStateCount >= maxRepeatedState) blockedReason = `repeated_state:${repeatedStateCount}>=${maxRepeatedState}`;
        else if (current.consecutiveFailures >= maxFailures) blockedReason = `consecutive_failures:${current.consecutiveFailures}>=${maxFailures}`;
      }
      const status = blockedReason ? 'blocked' : continuing ? 'pending_release' : event.disposition === 'wait' ? 'waiting' : event.disposition === 'wait_for_user' ? 'waiting_for_user' : 'goal_complete';
      const sessionIdentity = {
        controllerId: event.controllerSession.controllerId,
        controllerType: event.controllerSession.controllerType,
        principalId: event.controllerSession.principalId?.trim() || event.controllerSession.controllerId,
        controllerInstanceId: event.controllerSession.controllerInstanceId?.trim() || '',
        // A transport/session rollover inside the same Runtime does not change
        // the durable relay owner. A new Runtime instance is the explicit
        // recovery boundary that permits the terminal identity handoff.
        sessionId: event.controllerSession.controllerInstanceId?.trim() !== current.controllerInstanceId?.trim()
          ? event.controllerSession.sessionId
          : current.sessionId,
        claimGeneration: event.controllerSession.claimGeneration ?? current.claimGeneration,
      };
      return accept(current, {
        disposition: event.disposition, status, lifecycleStage: 'semantic_round_closed', stateFingerprint: event.stateFingerprint,
        roundCount, repeatedStateCount, maxRounds, maxRepeatedState, maxFailures,
        ...(status === 'goal_complete' ? sessionIdentity : {}),
        ...(event.qualityDecisions ? { qualityDecisions: event.qualityDecisions } : {}),
        ...(event.qualityAdjustmentResults ? { qualityAdjustmentResults: event.qualityAdjustmentResults } : {}),
        ...(event.observationWindow ? { observationWindow: event.observationWindow } : {}),
        ...(event.handoffId ? { handoffId: event.handoffId } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.bindingId ? { bindingId: event.bindingId } : {}),
        blockedReason, submittedAt: event.at, updatedAt: event.at,
      }, 'controller_round_disposition_submitted');
    }
    case 'successor_bound': {
      if (!current) return { kind: 'reject', code: 'CONTROLLER_RELAY_CURRENT_REQUIRED' };
      if (current.status !== 'claimed') return { kind: 'reject', code: `CONTROLLER_RELAY_SUCCESSOR_BIND_REQUIRES_CLAIMED_ROUND:${current.status}` };
      if (current.successorWorkId === event.successorWorkId) return { kind: 'no_op', current, reason: 'successor_already_bound' };
      if (current.successorWorkId && current.successorWorkId !== event.successorWorkId) return { kind: 'reject', code: `CONTROLLER_RELAY_SUCCESSOR_ALREADY_BOUND:${current.successorWorkId}` };
      return accept(current, { successorWorkId: event.successorWorkId, updatedAt: event.at }, 'controller_round_successor_work_bound');
    }
    case 'successor_release_handoff': {
      if (!current) return { kind: 'reject', code: 'CONTROLLER_RELAY_CURRENT_REQUIRED' };
      if (current.status !== 'pending_release') return { kind: 'reject', code: `CONTROLLER_RELAY_SUCCESSOR_HANDOFF_STATE_INVALID:${current.status}` };
      if (current.successorWorkId !== event.successorWorkId) return { kind: 'reject', code: 'CONTROLLER_RELAY_SUCCESSOR_HANDOFF_STALE' };
      const handedOff: ControllerRoundRelayRecord = { ...current, status: 'handed_off', lifecycleStage: 'semantic_round_closed', authorityId: undefined, updatedAt: event.at };
      const successor: ControllerRoundRelayRecord = {
        ...current, originWorkId: event.successorWorkId, predecessorWorkId: current.originWorkId, successorWorkId: undefined,
        status: 'dispatching', lifecycleStage: 'dispatching', authorityId: event.proposedAuthorityId,
        stateFingerprint: event.successorStateFingerprint, repeatedStateCount: 0, controllerInstanceId: '', sessionId: '', claimGeneration: 0,
        assistantContextSnapshot: undefined, controllerTurnCompletionEvidenceId: undefined, controllerTurnSettledAt: undefined,
        bindingId: undefined, providerDispatchEffectId: undefined, providerDispatchAttempt: 0, providerDispatchStartedAt: undefined, providerDispatchReceiptId: undefined,
        blockedReason: undefined, failureClass: undefined, lastError: undefined, nextRecoveryAt: undefined, dispatchedAt: undefined, claimedAt: undefined, updatedAt: event.at,
      };
      return { kind: 'accept_atomic', next: handedOff, action: 'controller_round_relay_successor_handoff_closed', relatedWorkId: event.successorWorkId, relatedNext: successor, relatedAction: 'controller_round_relay_successor_dispatch_begin' };
    }
    case 'controller_release_observed': {
      if (!current) return { kind: 'reject', code: 'CONTROLLER_RELAY_CURRENT_REQUIRED' };
      if (current.status !== 'pending_release') return { kind: 'no_op', current, reason: 'release_not_pending' };
      return accept(current, { authorityId: event.proposedAuthorityId, status: 'dispatching', lifecycleStage: 'dispatching', assistantContextSnapshot: undefined, controllerTurnCompletionEvidenceId: undefined, controllerTurnSettledAt: undefined, providerDispatchEffectId: undefined, providerDispatchAttempt: 0, providerDispatchStartedAt: undefined, providerDispatchReceiptId: undefined, updatedAt: event.at }, 'controller_round_relay_dispatch_begin');
    }
    case 'terminal_work_observed': {
      if (!current) return { kind: 'reject', code: 'CONTROLLER_RELAY_CURRENT_REQUIRED' };
      return current.status === 'failed' ? { kind: 'no_op', current, reason: 'terminal_work_already_retired' } : accept(current, { status: 'failed', failureClass: 'terminal_work', lastError: event.error, claimedAt: undefined, updatedAt: event.at }, 'controller_round_relay_terminal_work_retired');
    }
    case 'abandoned_release_observed': {
      if (!current) return { kind: 'reject', code: 'CONTROLLER_RELAY_CURRENT_REQUIRED' };
      return current.status !== 'claimed' ? { kind: 'no_op', current, reason: 'round_not_claimed' } : accept(current, { status: 'failed', failureClass: 'abandoned_release', lastError: event.error, claimedAt: undefined, updatedAt: event.at }, 'controller_round_relay_abandoned_release');
    }
    case 'authority_recovery_requested': {
      if (!current) return { kind: 'reject', code: 'CONTROLLER_RELAY_CURRENT_REQUIRED' };
      return accept(current, { authorityId: event.proposedAuthorityId, status: event.keepsConfirmedDispatch ? 'dispatched' : 'dispatching', lifecycleStage: event.keepsConfirmedDispatch ? 'dispatch_confirmed' : 'dispatching', failureClass: undefined, claimedAt: undefined, nextRecoveryAt: undefined, ...(event.keepsConfirmedDispatch ? {} : { providerDispatchEffectId: undefined, providerDispatchAttempt: 0, providerDispatchStartedAt: undefined, providerDispatchReceiptId: undefined }), updatedAt: event.at }, 'controller_round_relay_explicit_authority_recovered');
    }
  }
}
