import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import type { RepositoryRecord } from '../../../src/cli/repositories/types';
import { result } from './result-adapter';
import { buildFacadeResult, getHandoffItem } from '../../../src/runtime/control-plane/facade';
import { getWorkContract } from '../../../packages/kernel/work/api/index';
import { launchSuperController } from '../../../src/runtime/control-plane/launcher/thin-launcher';
import { prepareWorkChatgptContinuationTransport } from '../../../src/runtime/control-plane/launcher/chatgpt-work-continuation';
import {
  chatgptControllerRoundBinding,
  chatgptControllerRoundBindingId,
  upsertChatgptControllerRoundTransportBinding,
} from '../../../src/runtime/root/controller-round-composition';
import { touchSchedulerWakeSignal } from '../../../src/runtime/control-plane/global-scheduler/wake-signal';
import {
  beginInitialControllerRoundDispatch,
  bindControllerSessionBinding,
  controllerRoundBlockerClass,
  finishControllerRoundRelayDispatch,
  getControllerRoundRelay,
  getRequirementControllerRoundRelay,
  releaseObservedControllerSession,
  retryFailedControllerRoundProviderDispatch,
} from '../../../packages/kernel/controller/api/index';
import { authenticatedFacadeControllerIdentity, bindFacadeControllerOwnership } from './controller-authority-adapter';
import {
  ensureWorkflowSupervisorEnrollmentForWork,
  workflowSupervisorBoundaryForWork,
} from '../../../src/runtime/root/workflow-supervisor-composition';

const RH_WORK_CONTROLLER_OPERATIONS = new Set(['launcher_start']);

export function isRhWorkControllerOperation(operation: string): boolean {
  return RH_WORK_CONTROLLER_OPERATIONS.has(operation);
}

export async function callRhWorkControllerOperation(
  ctx: MultiRepositoryMcpToolContext,
  repository: RepositoryRecord,
  operation: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (operation !== 'launcher_start') return undefined;
  const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
  try {
    const controllerType = String(args.controller_type ?? 'codex');
    if (!['chatgpt', 'codex', 'grok', 'claude'].includes(controllerType)) throw new Error('CONTROLLER_TYPE_INVALID');
    const workId = String(args.work_id ?? '').trim();
    const launchArgs = Array.isArray(args.launch_args) ? args.launch_args.map(String) : [];

    if (controllerType === 'chatgpt') {
      const work = getWorkContract(store, workId);
      if (!work) throw new Error(`WORK_NOT_FOUND: ${workId}`);
      const explicitConversationUrl = typeof args.conversation_url === 'string' && args.conversation_url.trim()
        ? args.conversation_url.trim()
        : undefined;
      const launchRequestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
      if (!launchRequestId) throw new Error('LAUNCHER_START_REQUEST_ID_REQUIRED');
      const existingBinding = chatgptControllerRoundBinding(store, workId);
      const requestedTransportConversation = args.transport_conversation === 'fresh'
        ? 'fresh'
        : args.transport_conversation === 'bound' ? 'bound' : undefined;
      const transportConversation = requestedTransportConversation
        ?? (existingBinding || explicitConversationUrl ? 'bound' : 'fresh');
      if (requestedTransportConversation === 'bound' && !existingBinding && !explicitConversationUrl) {
        throw new Error('WORKFLOW_SUPERVISOR_BOUND_CONVERSATION_REQUIRED');
      }
      const supervisorBoundary = workflowSupervisorBoundaryForWork(store, workId);
      if (supervisorBoundary.status === 'outer_turn' && transportConversation !== 'fresh') {
        let supervisorEnrollment = await ensureWorkflowSupervisorEnrollmentForWork(store, workId);
        if (supervisorEnrollment.status === 'enrolled') {
          return result(buildFacadeResult({
            summary: 'Existing ChatGPT conversation re-enrolled for unattended continuation. No replacement provider send was issued.',
            data: {
              workId,
              currentConversationBound: true,
              continuationDispatched: false,
              supervisorEnrollment,
              conversationUrl: supervisorBoundary.conversationUrl,
            },
          }) as unknown as Record<string, unknown>);
        }
        if (supervisorEnrollment.status !== 'lower_layer_not_ready') {
          throw new Error(supervisorEnrollment.reason ?? `WORKFLOW_SUPERVISOR_${supervisorEnrollment.status.toUpperCase()}`);
        }
        const existingRelay = getControllerRoundRelay(store, workId)
          ?? (work.requirementId ? getRequirementControllerRoundRelay(store, work.requirementId) : undefined);
        if (existingRelay
          && existingRelay.originWorkId === workId
          && existingRelay.status === 'failed'
          && !existingRelay.failureClass
          && existingRelay.authorityId?.trim()) {
          retryFailedControllerRoundProviderDispatch(store, {
            workId,
            relayScopeId: existingRelay.relayScopeId,
            authorityId: existingRelay.authorityId,
            expectedUpdatedAt: existingRelay.updatedAt,
            ...(existingRelay.occurrenceId ? { occurrenceId: existingRelay.occurrenceId } : {}),
          });
          supervisorEnrollment = await ensureWorkflowSupervisorEnrollmentForWork(store, workId);
          if (supervisorEnrollment.status === 'enrolled') {
            return result(buildFacadeResult({
              summary: 'Existing ChatGPT conversation recovered the same failed provider round and re-enrolled without creating a replacement semantic round.',
              data: {
                workId,
                currentConversationBound: true,
                continuationDispatched: false,
                supervisorEnrollment,
                conversationUrl: supervisorBoundary.conversationUrl,
              },
            }) as unknown as Record<string, unknown>);
          }
          throw new Error(supervisorEnrollment.reason ?? `WORKFLOW_SUPERVISOR_${supervisorEnrollment.status.toUpperCase()}`);
        }
        const explicitFreshRoundBudgetOccurrence = existingRelay?.status === 'blocked'
          && controllerRoundBlockerClass(existingRelay) === 'round_budget_exhausted'
          && existingRelay.occurrenceId !== `launcher_start:${work.workId}:${launchRequestId}`;
        if (existingRelay && !explicitFreshRoundBudgetOccurrence) {
          throw new Error(supervisorEnrollment.reason ?? `WORKFLOW_SUPERVISOR_LOWER_LAYER_NOT_READY:${existingRelay.status}`);
        }
      }

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
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        throw new Error(`CHATGPT_LAUNCH_TIMEOUT_INVALID: ${timeoutValue}`);
      }

      const continuationPrompt = typeof args.continuation_prompt === 'string' ? args.continuation_prompt.trim() : '';
      const identity = authenticatedFacadeControllerIdentity(ctx, args);
      const occurrenceId = `launcher_start:${work.workId}:${launchRequestId}`;
      const initialContinuationPrompt = [
        handoff ? `Handoff: ${handoff.summary}\nNext: ${handoff.recommendedContinuationPrompt ?? handoff.recommendedPrompt}` : '',
        continuationPrompt ? `Continuation: ${continuationPrompt}` : '',
      ].filter(Boolean).join('\n') || undefined;
      const relay = beginInitialControllerRoundDispatch(store, {
        workId,
        identity,
        requirementId: work.requirementId,
        bindingId: chatgptControllerRoundBindingId(workId),
        occurrenceId,
        authorizeRoundBudgetOccurrence: true,
      });
      if (relay.status === 'blocked') {
        throw new Error(`CHATGPT_CONTINUATION_LAUNCH_BLOCKED:${relay.blockedReason ?? 'transport_not_ready'}`);
      }

      if (supervisorBoundary.status === 'outer_turn' && transportConversation !== 'fresh') {
        const supervisorEnrollment = await ensureWorkflowSupervisorEnrollmentForWork(store, workId);
        if (supervisorEnrollment.status !== 'enrolled') {
          throw new Error(supervisorEnrollment.reason ?? `WORKFLOW_SUPERVISOR_${supervisorEnrollment.status.toUpperCase()}`);
        }
        return result(buildFacadeResult({
          summary: 'Existing ChatGPT conversation enrolled for unattended continuation after lower-layer relay recovery. No replacement provider send was issued.',
          data: {
            workId,
            currentConversationBound: true,
            continuationDispatched: false,
            supervisorEnrollment,
            conversationUrl: supervisorBoundary.conversationUrl,
          },
        }) as unknown as Record<string, unknown>);
      }

      const initialControllerBinding = upsertChatgptControllerRoundTransportBinding(store, {
        workId,
        sessionId: relay.sessionId,
        browserSessionId: undefined,
        conversationUrl: transportConversation === 'bound' ? explicitConversationUrl ?? existingBinding?.conversationUrl : undefined,
        model: valueForFlag('--model') ?? 'gpt-5.6',
        reasoning: reasoning as 'medium' | 'high' | 'xhigh',
        tabPolicy: tabPolicy as 'auto' | 'reuse' | 'new',
        timeoutMs,
        transportConversation,
        continuationPrompt: initialContinuationPrompt,
        authorizationGrantRefs: [],
      });
      try {
        const prepared = await prepareWorkChatgptContinuationTransport({
          controllerHome: ctx.controllerHome,
          repoId: repository.repoId,
          workId,
          occurrenceId,
          transportConversation,
          browserSessionId: typeof args.browser_session_id === 'string' ? args.browser_session_id : undefined,
          conversationUrl: transportConversation === 'bound' ? explicitConversationUrl ?? existingBinding?.conversationUrl : undefined,
          timeoutMs,
          authorizationGrantRefs: transportConversation === 'bound' ? existingBinding?.authorizationGrantRefs : undefined,
        });
        const preparedControllerBinding = upsertChatgptControllerRoundTransportBinding(store, {
          workId,
          sessionId: relay.sessionId,
          browserSessionId: prepared.browserSessionId,
          conversationUrl: prepared.conversationUrl,
          model: valueForFlag('--model') ?? 'gpt-5.6',
          reasoning: reasoning as 'medium' | 'high' | 'xhigh',
          tabPolicy: tabPolicy as 'auto' | 'reuse' | 'new',
          timeoutMs,
          transportConversation,
          continuationPrompt: initialControllerBinding.payload.continuationPrompt,
          authorizationGrantRefs: prepared.authorizationGrantRefs,
        });
        // Launcher admission is the one moment where the authenticated control
        // request and the freshly prepared provider transport are both present.
        // Persist that mechanical resume identity, then immediately release the
        // live lease. Scheduler/Runtime rotation can later recover the same
        // execution conversation without turning semantic Work into ownership.
        const launchOwner = bindFacadeControllerOwnership(ctx, store, workId, identity, {
          allowClaimIfMissing: true,
          leaseMs: 60_000,
          relayScopeId: relay.relayScopeId,
        });
        bindControllerSessionBinding(store, {
          workId,
          sessionId: launchOwner.sessionId,
          binding: preparedControllerBinding.binding,
        });
        const released = releaseObservedControllerSession(store, {
          workId,
          actor: `launcher-start-retain:${workId}`,
          owner: launchOwner,
        });
        if (!released.allowed) {
          throw new Error(`CONTROLLER_LAUNCH_RESUME_IDENTITY_RELEASE_FAILED:${workId}:${released.reason}`);
        }
      } catch (launchError) {
        const launchFailure = launchError instanceof Error ? launchError.message : String(launchError);
        finishControllerRoundRelayDispatch(store, {
          workId,
          ok: false,
          error: launchFailure,
          recovery: true,
        });
        throw launchError;
      }

      touchSchedulerWakeSignal(ctx.controllerHome, `controller-round-ready:${workId}`);
      return result(buildFacadeResult({
        summary: 'ChatGPT continuation queued on the durable ControllerRound. Interactive admission prepared only the authorized provider transport; Scheduler owns provider dispatch and retry.',
        data: {
          workId,
          continuationQueued: true,
          continuationDispatched: false,
          relayScopeId: relay.relayScopeId,
          transportConversation,
        },
      }) as unknown as Record<string, unknown>);
    }

    const launched = await launchSuperController({ work: store, handoff: store }, {
      controllerType: controllerType as 'codex' | 'grok' | 'claude',
      executable: typeof args.executable === 'string' && args.executable.trim() ? args.executable.trim() : undefined,
      args: launchArgs,
      workId,
      launchReservationMs: typeof args.launch_reservation_ms === 'number'
        ? args.launch_reservation_ms
        : typeof args.lease_ms === 'number' ? args.lease_ms : undefined,
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
    return result(buildFacadeResult({
      status: 'blocked',
      summary: error instanceof Error ? error.message : 'Launcher failed.',
      data: {},
    }) as unknown as Record<string, unknown>, true);
  }
}
