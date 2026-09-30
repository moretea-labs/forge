import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import type { RepositoryRecord } from '../../../src/cli/repositories/types';
import { result } from './result-adapter';
import { buildFacadeResult, getHandoffItem } from '../../../src/runtime/control-plane/facade';
import { getWorkContract } from '../../../packages/kernel/work/api/index';
import { launchSuperController } from '../../../src/runtime/control-plane/launcher/thin-launcher';
import {
  upsertChatgptControllerRoundTransportBinding,
} from '../../../src/runtime/root/controller-round-composition';
import { touchSchedulerWakeSignal } from '../../../src/runtime/control-plane/global-scheduler/wake-signal';
import {
  bindControllerSessionBinding,
  controllerRoundBlockerClass,
  getControllerRoundRelay,
  releaseObservedControllerSession,
} from '../../../packages/kernel/controller/api/index';
import { authenticatedFacadeControllerIdentity, bindFacadeControllerOwnership } from './controller-authority-adapter';
import {
  bindCurrentWorkflowSupervisorConversationForWork,
  bindWorkflowSupervisorConversationForWork,
  getWorkflowSupervisorConversationBindingForWork,
} from '../../../src/runtime/root/workflow-supervisor-composition';
import { reconcileControllerProgression } from '../../../src/runtime/root/controller-progression-composition';

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
      const launchRequestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
      if (!launchRequestId) throw new Error('LAUNCHER_START_REQUEST_ID_REQUIRED');

      const explicitConversationUrl = typeof args.conversation_url === 'string' && args.conversation_url.trim()
        ? args.conversation_url.trim()
        : undefined;
      const enrollCurrentConversation = args.enroll_current_conversation === true;
      if (enrollCurrentConversation && explicitConversationUrl) {
        throw new Error('CURRENT_CONVERSATION_ENROLLMENT_EXPLICIT_URL_CONFLICT');
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
        if (!launchArgs[index + 1] || launchArgs[index + 1]!.startsWith('--')) {
          throw new Error(`CHATGPT_LAUNCH_ARG_VALUE_REQUIRED: ${flag}`);
        }
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
      const initialContinuationPrompt = [
        handoff ? `Handoff: ${handoff.summary}\nNext: ${handoff.recommendedContinuationPrompt ?? handoff.recommendedPrompt}` : '',
        continuationPrompt ? `Continuation: ${continuationPrompt}` : '',
      ].filter(Boolean).join('\n') || undefined;

      const requestedTransportConversation = args.transport_conversation === 'fresh'
        ? 'fresh'
        : args.transport_conversation === 'bound' ? 'bound' : undefined;
      if (enrollCurrentConversation && requestedTransportConversation === 'fresh') {
        throw new Error('CURRENT_CONVERSATION_ENROLLMENT_FRESH_TRANSPORT_CONFLICT');
      }

      // All request/identity and clearly terminal round validation happens before
      // any conversation binding is persisted. Frozen compatibility must be
      // transport-only: an invalid launcher request is a zero-write request.
      const identity = authenticatedFacadeControllerIdentity(ctx, args);
      const existingRound = getControllerRoundRelay(store, workId);
      if (existingRound?.status === 'failed') {
        throw new Error(existingRound.lastError ?? `CONTROLLER_RELAY_FAILED:${workId}`);
      }
      if (existingRound?.status === 'blocked'
        && controllerRoundBlockerClass(existingRound) !== 'provider_dispatch_outcome_unknown') {
        throw new Error(`CONTROLLER_RELAY_LAUNCH_BLOCKED:${existingRound.blockedReason ?? existingRound.relayScopeId}`);
      }
      if (existingRound && ['pending_release', 'goal_complete', 'handed_off'].includes(existingRound.status)) {
        throw new Error(`CONTROLLER_RELAY_NOT_PROGRESSABLE:${existingRound.status}`);
      }

      let conversationBinding = getWorkflowSupervisorConversationBindingForWork(store, workId);
      if (requestedTransportConversation === 'fresh' && conversationBinding) {
        throw new Error('CHATGPT_FRESH_CONVERSATION_EXISTING_BINDING_CONFLICT');
      }
      if (enrollCurrentConversation) {
        const currentBinding = await bindCurrentWorkflowSupervisorConversationForWork(store, workId);
        if (currentBinding.status !== 'bound') {
          throw new Error(currentBinding.reason ?? `CURRENT_CONVERSATION_ENROLLMENT_${currentBinding.status.toUpperCase()}`);
        }
        conversationBinding = currentBinding.binding;
      } else if (explicitConversationUrl) {
        if (args.transport_conversation === 'fresh') {
          throw new Error('CHATGPT_FRESH_CONVERSATION_EXPLICIT_URL_CONFLICT');
        }
        conversationBinding = bindWorkflowSupervisorConversationForWork(store, {
          workId,
          conversationUrl: explicitConversationUrl,
          localAlias: 'Forge autonomous execution',
        });
      }

      const transportConversation = requestedTransportConversation
        ?? (conversationBinding ? 'bound' : 'fresh');
      if (transportConversation === 'bound' && !conversationBinding) {
        throw new Error('WORKFLOW_SUPERVISOR_BOUND_CONVERSATION_REQUIRED');
      }

      const occurrenceId = `launcher_start:${work.workId}:${launchRequestId}`;
      const relayScopeId = work.requirementId ? `requirement:${work.requirementId}` : `goal:${work.workId}`;

      let launchOwner;
      if (!existingRound) {
        launchOwner = bindFacadeControllerOwnership(ctx, store, workId, identity, {
          allowClaimIfMissing: true,
          leaseMs: 60_000,
        });
        const controllerBinding = upsertChatgptControllerRoundTransportBinding(store, {
          workId,
          sessionId: launchOwner.sessionId,
          browserSessionId: undefined,
          conversationUrl: transportConversation === 'bound' ? conversationBinding?.conversationUrl : undefined,
          model: valueForFlag('--model') ?? 'gpt-5.6',
          reasoning: reasoning as 'medium' | 'high' | 'xhigh',
          tabPolicy: tabPolicy as 'auto' | 'reuse' | 'new',
          timeoutMs,
          transportConversation,
          continuationPrompt: initialContinuationPrompt,
          authorizationGrantRefs: conversationBinding?.authorizationGrantRefs ?? [],
        });
        bindControllerSessionBinding(store, {
          workId,
          sessionId: launchOwner.sessionId,
          binding: controllerBinding.binding,
        });
      }

      let progression;
      try {
        progression = await reconcileControllerProgression(
          {
            controllerHome: ctx.controllerHome,
            repoId: repository.repoId,
            repoRoot: repository.canonicalRoot,
          },
          {
            workId,
            occurrenceId,
            relayScopeId,
            continuationHint: initialContinuationPrompt,
            scheduleName: 'launcher-start',
          },
        );
      } finally {
        if (launchOwner) {
          const released = releaseObservedControllerSession(store, {
            workId,
            actor: `launcher-start-retain:${workId}`,
            owner: launchOwner,
          });
          if (!released.allowed) {
            throw new Error(`CONTROLLER_LAUNCH_RESUME_IDENTITY_RELEASE_FAILED:${workId}:${released.reason}`);
          }
        }
      }

      touchSchedulerWakeSignal(ctx.controllerHome, `controller-round-ready:${workId}`);
      if (progression.status === 'rejected') {
        throw new Error(progression.reason ?? 'CHATGPT_CONTINUATION_LAUNCH_REJECTED');
      }
      if (progression.status === 'terminal_or_missing') {
        throw new Error(progression.reason);
      }
      if (progression.status === 'retained_session_missing' || progression.status === 'human_controller') {
        throw new Error(progression.reason);
      }

      return result(buildFacadeResult({
        summary: progression.status === 'chatgpt_enrolled'
          ? 'ChatGPT continuation enrolled with Workflow Supervisor effect authority.'
          : progression.status === 'chatgpt_not_enrolled'
            ? 'ChatGPT continuation is durably queued; Workflow Supervisor enrollment will retry without consuming provider failure budget.'
            : `ChatGPT continuation is waiting in canonical progression state: ${progression.status}.`,
        data: {
          workId,
          continuationQueued: true,
          continuationDispatched: false,
          relayScopeId: 'relayScopeId' in progression ? progression.relayScopeId : relayScopeId,
          transportConversation,
          progressionStatus: progression.status,
          ...(progression.status === 'chatgpt_enrolled' || progression.status === 'chatgpt_not_enrolled'
            ? { supervisorEnrollment: progression.supervisorEnrollment }
            : {}),
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
