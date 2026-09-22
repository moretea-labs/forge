import {
  bindControllerSessionBinding,
  getRequirementControllerRoundRelay,
  type ControllerBinding,
  type ControllerHost,
  type ControllerSession,
} from '../../../packages/kernel/controller/api/index';
import { createChatgptControllerHost } from '../../../adapters/chatgpt/controller-host';
import { upsertChatgptControllerBinding } from '../../../adapters/chatgpt/controller-binding-store';
import { getWorkContract } from '../../../packages/kernel/work/api/index';
import { inheritWorkflowSupervisorConversationBinding } from './workflow-supervisor-composition';
import { getChatgptWorkConversationBinding } from '../../../adapters/chatgpt/work-conversation-binding-store';
import { createProcessControllerHost } from '../../../adapters/controller-process/controller-host';
import { upsertProcessControllerBinding, type ProcessControllerType } from '../../../adapters/controller-process/binding-store';

// Kernel V2 composition root: Scheduler selects Kernel continuation; this file wires concrete provider adapters.
export function ensureScheduledControllerBinding(
  options: { controllerHome: string; repoId: string },
  input: { workId: string; session: ControllerSession; scheduleName?: string; args: Record<string, unknown> },
): ControllerBinding {
  let binding: ControllerBinding;
  if (input.session.controllerType === 'chatgpt') {
    const durable = getChatgptWorkConversationBinding(options, input.workId);
    binding = upsertChatgptControllerBinding(options, {
      workId: input.workId, sessionId: input.session.sessionId,
      browserSessionId: durable?.latestBrowserSessionId ?? (typeof input.args.browser_session_id === 'string' ? input.args.browser_session_id : undefined),
      conversationUrl: durable?.conversationUrl ?? (typeof input.args.conversation_url === 'string' ? input.args.conversation_url : undefined),
      authorizationGrantRefs: [
        ...(durable?.authorizationGrantRefs ?? []),
        ...(Array.isArray(input.args.authorization_grant_refs) ? input.args.authorization_grant_refs.map(String) : []),
      ].map(value => value.trim()).filter(Boolean).filter((value, index, values) => values.indexOf(value) === index),
      title: input.scheduleName,
      model: typeof input.args.model === 'string' ? input.args.model : 'gpt-5.6',
      reasoning: input.args.reasoning === 'medium' || input.args.reasoning === 'high' || input.args.reasoning === 'xhigh' ? input.args.reasoning : 'medium',
      tabPolicy: input.args.tab_policy === 'reuse' || input.args.tab_policy === 'new' ? input.args.tab_policy : 'auto',
      timeoutMs: typeof input.args.timeout_ms === 'number' ? input.args.timeout_ms : undefined,
    }).binding;
  } else if (input.session.controllerType !== 'human') {
    binding = upsertProcessControllerBinding(options, {
      workId: input.workId, sessionId: input.session.sessionId, controllerType: input.session.controllerType as ProcessControllerType,
      executable: typeof input.args.executable === 'string' ? input.args.executable : undefined,
      launchArgs: Array.isArray(input.args.launch_args) ? input.args.launch_args.map(String) : [],
      handoffId: typeof input.args.handoff_id === 'string' ? input.args.handoff_id : undefined,
      launchReservationMs: typeof input.args.launch_reservation_ms === 'number' ? input.args.launch_reservation_ms : undefined,
    }).binding;
  } else {
    throw new Error('SCHEDULE_CONTINUATION_HUMAN_HOST_UNSUPPORTED');
  }
  bindControllerSessionBinding(options, { workId: input.workId, sessionId: input.session.sessionId, binding });
  return binding;
}

export function ensureScheduledControllerBindingForWork(
  options: { controllerHome: string; repoId: string },
  input: { workId: string; session: ControllerSession; scheduleName?: string; args: Record<string, unknown> },
): ControllerBinding {
  if (input.session.controllerType === 'chatgpt') {
    const work = getWorkContract(options, input.workId);
    if (work?.requirementId && !getChatgptWorkConversationBinding(options, input.workId)) {
      const requirementRelay = getRequirementControllerRoundRelay(options, work.requirementId);
      if (requirementRelay?.originWorkId && requirementRelay.originWorkId !== input.workId) {
        inheritWorkflowSupervisorConversationBinding(options, requirementRelay.originWorkId, input.workId);
      }
    }
  }
  return ensureScheduledControllerBinding(options, input);
}

export function controllerHostForScheduledBinding(
  options: { controllerHome: string; repoId: string; repoRoot: string },
  binding: ControllerBinding,
): ControllerHost {
  return binding.hostKind === 'chatgpt' ? createChatgptControllerHost(options) : createProcessControllerHost(options);
}
