import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import type { RepositoryRecord } from '../../../src/cli/repositories/types';
import { result } from './result-adapter';
import { buildFacadeResult, getHandoffItem } from '../../../src/runtime/control-plane/facade';
import { getWorkContract } from '../../../packages/kernel/work/api/index';
import { launchSuperController } from '../../../src/runtime/control-plane/launcher/thin-launcher';
import { runWorkChatgptContinuation } from '../../../src/runtime/control-plane/launcher/chatgpt-work-continuation';
import {
  chatgptControllerRoundBinding,
  renderChatgptControllerRoundPrompt,
} from '../../../src/runtime/root/controller-round-composition';
import {
  beginInitialControllerRoundDispatch,
  finishControllerRoundRelayDispatch,
  getControllerRoundRelay,
  getRequirementControllerRoundRelay,
  retryFailedControllerRoundProviderDispatch,
} from '../../../packages/kernel/controller/api/index';
import { authenticatedFacadeControllerIdentity } from './controller-authority-adapter';
import {
  bindCurrentWorkflowSupervisorConversationForWork,
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
      const transportConversation = args.transport_conversation === 'fresh' ? 'fresh' : 'bound';
      const explicitConversationUrl = typeof args.conversation_url === 'string' && args.conversation_url.trim()
        ? args.conversation_url.trim()
        : undefined;
      let supervisorBoundary = workflowSupervisorBoundaryForWork(store, workId);
      let adoptedCurrentConversation = false;
      if (transportConversation === 'bound' && !explicitConversationUrl && supervisorBoundary.status === 'conversation_pending') {
        const currentConversation = await bindCurrentWorkflowSupervisorConversationForWork(store, workId);
        if (currentConversation.status !== 'bound') {
          throw new Error(currentConversation.reason ?? `WORKFLOW_SUPERVISOR_${currentConversation.status.toUpperCase()}`);
        }
        adoptedCurrentConversation = true;
        supervisorBoundary = workflowSupervisorBoundaryForWork(store, workId);
      }
      if (supervisorBoundary.status === 'outer_turn' && transportConversation !== 'fresh' && !adoptedCurrentConversation) {
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
        if (existingRelay) {
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
      const existingBinding = chatgptControllerRoundBinding(store, workId);
      const relay = beginInitialControllerRoundDispatch(store, {
        workId,
        identity: authenticatedFacadeControllerIdentity(ctx, args),
        requirementId: work.requirementId,
        bindingId: existingBinding?.bindingId,
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
          summary: adoptedCurrentConversation
            ? 'Current ChatGPT conversation bound and enrolled for unattended continuation. No replacement provider send was issued.'
            : 'Existing ChatGPT conversation enrolled for unattended continuation after lower-layer relay recovery. No replacement provider send was issued.',
          data: {
            workId,
            currentConversationBound: true,
            continuationDispatched: false,
            supervisorEnrollment,
            conversationUrl: supervisorBoundary.conversationUrl,
          },
        }) as unknown as Record<string, unknown>);
      }

      const prompt = [
        renderChatgptControllerRoundPrompt(store, relay, { exactOriginWork: true }),
        'Forge continuation transport is active for this Work; provider delivery success is not semantic completion.',
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
          conversationUrl: explicitConversationUrl,
          model: valueForFlag('--model') ?? 'gpt-5.6',
          reasoning: reasoning as 'medium' | 'high' | 'xhigh',
          tabPolicy: tabPolicy as 'auto' | 'reuse' | 'new',
          transportConversation,
          timeoutMs,
        });
        if (dispatched.status === 'failed') {
          throw new Error(`${dispatched.error?.code ?? 'CHATGPT_WORK_CONTINUATION_FAILED'}:${dispatched.error?.message ?? 'ChatGPT Work continuation failed'}`);
        }
      } catch (launchError) {
        const launchFailure = launchError instanceof Error ? launchError.message : String(launchError);
        finishControllerRoundRelayDispatch(store, {
          workId,
          ok: false,
          error: launchFailure,
          outcomeUnknown: /OUTCOME_UNKNOWN/i.test(launchFailure),
        });
        throw launchError;
      }

      const updatedBinding = chatgptControllerRoundBinding(store, workId);
      finishControllerRoundRelayDispatch(store, { workId, ok: true, bindingId: updatedBinding?.bindingId });
      return result(buildFacadeResult({
        summary: 'ChatGPT continuation dispatched. Provider/session and retry bookkeeping remain internal; semantic Work state is unchanged until an explicit semantic update.',
        data: {
          workId,
          continuationDispatched: true,
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
