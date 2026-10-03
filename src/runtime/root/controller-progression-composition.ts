import {
  beginControllerRoundRelayAfterRelease,
  controllerRoundBlockerClass,
  getControllerRoundRelay,
  getControllerWorkBinding,
  getRetainedControllerSession,
  prepareControllerRoundOccurrence,
  resumeControllerRoundOccurrence,
  type ControllerBinding,
  type ControllerHost,
} from '../../../packages/kernel/controller/api/index';
import { getWorkContract, semanticWorkState } from '../../../packages/kernel/work/api/index';
import {
  controllerHostForScheduledBinding,
  ensureScheduledControllerBindingForWork,
} from './scheduled-controller-composition';
import {
  ensureWorkflowSupervisorEnrollmentForWork,
  type WorkflowSupervisorEnrollmentStatus,
} from './workflow-supervisor-composition';

export interface ControllerProgressionInput {
  workId: string;
  occurrenceId: string;
  relayScopeId?: string;
  continuationHint?: string;
  allowSemanticWaitRecovery?: boolean;
  scheduleName?: string;
  bindingArgs?: Record<string, unknown>;
}

export interface ControllerProgressionDependencies {
  ensureBinding?: typeof ensureScheduledControllerBindingForWork;
  hostForBinding?: typeof controllerHostForScheduledBinding;
  prepareOccurrence?: typeof prepareControllerRoundOccurrence;
  resumeOccurrence?: typeof resumeControllerRoundOccurrence;
  ensureSupervisorEnrollment?: typeof ensureWorkflowSupervisorEnrollmentForWork;
}

export type ControllerProgressionResult =
  | { status: 'terminal_or_missing'; reason: string }
  | { status: 'retained_session_missing'; reason: string }
  | { status: 'human_controller'; reason: string }
  | { status: 'semantic_wait'; reason?: string; binding: ControllerBinding }
  | { status: 'wait_for_user'; reason?: string; binding: ControllerBinding }
  | { status: 'rejected'; reason?: string; binding: ControllerBinding }
  | {
      status: 'chatgpt_enrolled';
      binding: ControllerBinding;
      relayScopeId: string;
      reused: boolean;
      supervisorEnrollment: {
        status: WorkflowSupervisorEnrollmentStatus;
        taskId?: string;
        effectId?: string;
        reason?: string;
      };
    }
  | {
      status: 'chatgpt_not_enrolled';
      binding: ControllerBinding;
      relayScopeId: string;
      reused: boolean;
      supervisorEnrollment: {
        status: WorkflowSupervisorEnrollmentStatus;
        taskId?: string;
        effectId?: string;
        reason?: string;
      };
    }
  | {
      status: 'provider_dispatched';
      binding: ControllerBinding;
      relayScopeId: string;
      reused: boolean;
      providerDispatchReceiptId?: string;
    };

/**
 * Stateless composition for one already-authorized Controller progression
 * occurrence. It owns no persistence and introduces no lifecycle state.
 *
 * Work decides semantic terminality. ControllerSession/ControllerRound provide
 * retained execution identity and one mechanical occurrence. Workflow Supervisor
 * exclusively reserves and delivers Work-bound ChatGPT effects. Non-ChatGPT
 * ControllerHost remains the direct provider boundary.
 */
export async function reconcileControllerProgression(
  options: { controllerHome: string; repoId: string; repoRoot: string },
  input: ControllerProgressionInput,
  dependencies: ControllerProgressionDependencies = {},
): Promise<ControllerProgressionResult> {
  const store = { controllerHome: options.controllerHome, repoId: options.repoId };
  const work = getWorkContract(store, input.workId);
  if (!work || semanticWorkState(work) !== 'open') {
    return { status: 'terminal_or_missing', reason: work ? `WORK_TERMINAL:${semanticWorkState(work)}` : 'WORK_NOT_FOUND' };
  }

  const retainedSession = getRetainedControllerSession(store, input.workId);
  if (!retainedSession) return { status: 'retained_session_missing', reason: 'CONTROLLER_SESSION_NOT_RETAINED' };
  if (retainedSession.controllerType === 'human') return { status: 'human_controller', reason: 'HUMAN_CONTROLLER' };

  const ensureBinding = dependencies.ensureBinding ?? ensureScheduledControllerBindingForWork;
  const existingBinding = getControllerWorkBinding(store, input.workId)?.binding;
  const binding = existingBinding ?? ensureBinding(store, {
    workId: input.workId,
    session: retainedSession,
    scheduleName: input.scheduleName,
    args: input.bindingArgs ?? {},
  });

  if (retainedSession.controllerType === 'chatgpt') {
    const ensureSupervisorEnrollment = dependencies.ensureSupervisorEnrollment ?? ensureWorkflowSupervisorEnrollmentForWork;
    let existingRound = getControllerRoundRelay(store, input.workId);
    let controllerRoundOccurrenceId = input.occurrenceId;
    if (existingRound?.status === 'pending_release') {
      // The semantic turn already chose continue_immediately. Once its exact
      // ControllerSession lease has been released, reopen that same durable
      // ControllerRound for dispatch before reserving another Supervisor effect.
      // Schedule occurrence ids are trigger evidence, not a replacement
      // ControllerRound identity for an already-open continuation chain.
      existingRound = beginControllerRoundRelayAfterRelease(store, {
        workId: input.workId,
        releasedSession: retainedSession,
      }) ?? getControllerRoundRelay(store, input.workId);
    }
    // An already-open recoverable ControllerRound keeps its durable occurrence
    // identity across Scheduler wake attempts. A fresh ScheduleOccurrence is
    // trigger/evidence identity only; replacing the round occurrence here would
    // manufacture a second open round and permanently self-block continuation.
    if (existingRound?.occurrenceId?.trim()
      && ['dispatching', 'dispatched', 'claimed'].includes(existingRound.status)) {
      controllerRoundOccurrenceId = existingRound.occurrenceId.trim();
    }
    if (existingRound?.status === 'blocked'
      && controllerRoundBlockerClass(existingRound) === 'provider_dispatch_outcome_unknown') {
      const supervisorEnrollment = await ensureSupervisorEnrollment(store, input.workId);
      return {
        status: supervisorEnrollment.status === 'enrolled' ? 'chatgpt_enrolled' : 'chatgpt_not_enrolled',
        binding,
        relayScopeId: existingRound.relayScopeId,
        reused: true,
        supervisorEnrollment,
      };
    }

    const prepareOccurrence = dependencies.prepareOccurrence ?? prepareControllerRoundOccurrence;
    const prepared = prepareOccurrence(store, {
      occurrenceId: controllerRoundOccurrenceId,
      workId: input.workId,
      controllerBindingId: binding.bindingId,
      relayScopeId: input.relayScopeId,
      continuationHint: input.continuationHint,
      allowSemanticWaitRecovery: input.allowSemanticWaitRecovery,
    });
    if (prepared.outcome === 'semantic_wait') return { status: 'semantic_wait', reason: prepared.reason, binding };
    if (prepared.outcome === 'wait_for_user') return { status: 'wait_for_user', reason: prepared.reason, binding };
    if (prepared.outcome === 'rejected') return { status: 'rejected', reason: prepared.reason, binding };

    const supervisorEnrollment = await ensureSupervisorEnrollment(store, input.workId);
    return {
      status: supervisorEnrollment.status === 'enrolled' ? 'chatgpt_enrolled' : 'chatgpt_not_enrolled',
      binding,
      relayScopeId: prepared.relay.relayScopeId,
      reused: prepared.reused,
      supervisorEnrollment,
    };
  }

  const hostForBinding = dependencies.hostForBinding ?? controllerHostForScheduledBinding;
  const host: ControllerHost = hostForBinding(options, binding);
  const resumeOccurrence = dependencies.resumeOccurrence ?? resumeControllerRoundOccurrence;
  const resumed = await resumeOccurrence(store, {
    occurrenceId: input.occurrenceId,
    workId: input.workId,
    controllerBindingId: binding.bindingId,
    relayScopeId: input.relayScopeId,
    continuationHint: input.continuationHint,
    allowSemanticWaitRecovery: input.allowSemanticWaitRecovery,
  }, host);

  if (resumed.outcome === 'semantic_wait') return { status: 'semantic_wait', reason: resumed.reason, binding };
  if (resumed.outcome === 'wait_for_user') return { status: 'wait_for_user', reason: resumed.reason, binding };
  if (resumed.outcome === 'rejected') return { status: 'rejected', reason: resumed.reason, binding };
  return {
    status: 'provider_dispatched',
    binding,
    relayScopeId: resumed.relay.relayScopeId,
    reused: resumed.reused,
    providerDispatchReceiptId: resumed.providerDispatchReceiptId,
  };
}
