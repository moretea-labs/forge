import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import type { RepositoryRecord } from '../../../src/core/repository/types';
import { createHash } from 'crypto';
import { result } from './result-adapter';
import { callPluginAdapter } from './plugin-adapter';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade';
import {
  beginChatgptTaskSessionReplacement,
  bindInitialChatgptTaskSession,
  commitChatgptTaskSessionTakeover,
  confirmArchivedChatgptTabClosed,
  readChatgptTaskSessionBinding,
  reserveChatgptTaskSend,
  settleChatgptTaskSend,
  updateActiveChatgptTaskConversationUrl,
} from '../../../src/runtime/control-plane/launcher/chatgpt-task-session-store';

// Computer owns browser/session state and plugin effect receipts own Prompt
// delivery. This adapter owns only the task-to-session binding transaction.
export function chatgptLaunchSessionRequest(
  args: Record<string, unknown>,
  repoId: string,
): {
  requestId: string;
  sessionId: string;
  url: string;
} {
  const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
  if (!requestId) throw new Error('LAUNCH_SESSION_REQUEST_ID_REQUIRED');
  if (
    typeof args.continuation_prompt === 'string' &&
    args.continuation_prompt.trim() &&
    !(typeof args.task_id === 'string' && args.task_id.trim())
  ) {
    throw new Error('LAUNCH_SESSION_PROMPT_NOT_SUPPORTED: a Launch Session never auto-sends CONTINUE');
  }
  if (Array.isArray(args.launch_args) && args.launch_args.length > 0) {
    throw new Error('LAUNCH_SESSION_PROVIDER_ARGS_UNSUPPORTED: configure the model in the session');
  }
  if (args.enroll_current_conversation === true) {
    throw new Error('LAUNCH_SESSION_SUPERVISOR_ENROLLMENT_RETIRED');
  }
  const transport = args.transport_conversation;
  if (transport !== undefined && transport !== 'fresh' && transport !== 'bound') {
    throw new Error('LAUNCH_SESSION_TRANSPORT_INVALID');
  }
  const explicitUrl = typeof args.conversation_url === 'string' ? args.conversation_url.trim() : '';
  if (transport === 'fresh' && explicitUrl) throw new Error('LAUNCH_SESSION_FRESH_URL_CONFLICT');
  if (transport === 'bound' && !explicitUrl) throw new Error('LAUNCH_SESSION_BOUND_URL_REQUIRED');
  const url = explicitUrl || 'https://chatgpt.com/';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('LAUNCH_SESSION_URL_INVALID');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'chatgpt.com' ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) {
    throw new Error('LAUNCH_SESSION_CHATGPT_ORIGIN_REQUIRED');
  }
  const suppliedSessionId = typeof args.browser_session_id === 'string' ? args.browser_session_id.trim() : '';
  const sessionId =
    suppliedSessionId ||
    'forge-launch-' +
      createHash('sha256')
        .update(repoId + ':' + requestId)
        .digest('hex')
        .slice(0, 20);
  return { requestId, sessionId, url: parsed.href };
}

const RH_WORK_CONTROLLER_OPERATIONS = new Set(['launcher_start']);

const CHATGPT_COMPOSER_SELECTOR = '#prompt-textarea,[data-testid="prompt-textarea"]';
const CHATGPT_SEND_SELECTOR = '[data-testid="send-button"]';

function nestedValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record[key] !== undefined) return record[key];
  for (const child of Object.values(record)) {
    if (!child || typeof child !== 'object') continue;
    const found = nestedValue(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function resultErrorCode(value: CallToolResult | undefined): string | undefined {
  const code = nestedValue(value?.structuredContent, 'code');
  return typeof code === 'string' ? code : undefined;
}

function observedConversationUrl(value: CallToolResult | undefined): string | undefined {
  const candidates = [
    nestedValue(value?.structuredContent, 'observedUrl'),
    nestedValue(value?.structuredContent, 'url'),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' && url.hostname === 'chatgpt.com') return url.href;
    } catch {
      /* bounded provider result */
    }
  }
  return undefined;
}

function effectReceiptId(value: CallToolResult | undefined): string | undefined {
  const receipt =
    nestedValue(value?.structuredContent, 'receiptId') ?? nestedValue(value?.structuredContent, 'observationReceiptId');
  return typeof receipt === 'string' && receipt.trim() ? receipt.trim() : undefined;
}

function effectOutcomeUnknown(value: CallToolResult | undefined): boolean {
  const outcome = nestedValue(value?.structuredContent, 'effectOutcome');
  const observation = nestedValue(value?.structuredContent, 'outcome');
  return (
    outcome === 'outcome_unknown' ||
    observation === 'unknown_until_process_terminal' ||
    resultErrorCode(value) === 'PLUGIN_BROWSER_MUTATION_OUTCOME_UNKNOWN'
  );
}

export function chatgptTabCloseProven(value: CallToolResult | undefined): boolean {
  if (!value || value.isError === true || effectOutcomeUnknown(value)) return false;
  return (
    nestedValue(value.structuredContent, 'resourceClosed') === true ||
    nestedValue(value.structuredContent, 'resourceAlreadyMissing') === true
  );
}

function preflightProvesUnusable(value: CallToolResult | undefined): { unusable: boolean; reasonCode: string } {
  const code = resultErrorCode(value) ?? 'chatgpt_preflight_inconclusive';
  return {
    unusable:
      /(?:SESSION_STATE_LOST|NATIVE_TAB_IDENTITY_UNPROVEN|NATIVE_TAB_MISSING|PAGE_HANDLE_STALE|SESSION_NOT_FOUND)/.test(
        code,
      ),
    reasonCode: code,
  };
}

async function computerAction(
  ctx: MultiRepositoryMcpToolContext,
  actionId: string,
  requestId: string,
  argumentsValue: Record<string, unknown>,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  return callPluginAdapter(ctx, 'plugin_action_execute', {
    plugin_id: 'computer',
    action_id: actionId,
    request_id: requestId,
    arguments: argumentsValue,
    wait: true,
    wait_ms: 30_000,
    interactive_wait_ms: 30_000,
    ...(args.confirm_authorization === true ? { confirm_authorization: true } : {}),
    ...(typeof args.confirmation_text === 'string' ? { confirmation_text: args.confirmation_text } : {}),
  });
}

async function observeTaskSession(
  ctx: MultiRepositoryMcpToolContext,
  sessionId: string,
  requestId: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  return computerAction(
    ctx,
    'verify_state',
    requestId,
    {
      session_id: sessionId,
      url_contains: 'https://chatgpt.com/',
      selector: CHATGPT_COMPOSER_SELECTOR,
      require_visible: true,
    },
    args,
  );
}

async function observeTaskSessionFailure(
  ctx: MultiRepositoryMcpToolContext,
  sessionId: string,
  requestId: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  return computerAction(
    ctx,
    'verify_state',
    requestId,
    {
      session_id: sessionId,
      url_contains: 'https://chatgpt.com/',
      text_contains_any: ['Unable to load conversation', 'Conversation not found'],
    },
    args,
  );
}

function recoveryPrompt(taskId: string, issueNumber: number | undefined, prompt: string): string {
  const issue = issueNumber ? `GitHub Issue #${issueNumber}` : `the latest durable task record for ${taskId}`;
  return [
    `You are the replacement ChatGPT conversation taking over the existing task ${taskId}.`,
    `Before acting, read ${issue}, current task progress, and confirmed deliveries.`,
    'Continue the same task; do not create a duplicate task, replay an outcome-unknown external effect, or treat chat history as execution authority.',
    '',
    prompt,
  ].join('\n');
}

async function sendTaskPrompt(input: {
  ctx: MultiRepositoryMcpToolContext;
  repository: RepositoryRecord;
  args: Record<string, unknown>;
  taskId: string;
  sessionId: string;
  requestId: string;
  prompt: string;
}): Promise<{ result?: CallToolResult; receiptId?: string; observedUrl?: string; applied: boolean }> {
  reserveChatgptTaskSend({
    controllerHome: input.ctx.controllerHome,
    repoId: input.repository.repoId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    requestId: input.requestId,
  });
  const send = await computerAction(
    input.ctx,
    'run_steps',
    input.requestId,
    {
      session_id: input.sessionId,
      steps: [
        { action: 'fill', selector: CHATGPT_COMPOSER_SELECTOR, text: input.prompt, timeout_ms: 8_000 },
        { action: 'click', selector: CHATGPT_SEND_SELECTOR, timeout_ms: 8_000 },
      ],
      post_action_wait_ms: 1_000,
    },
    input.args,
  );
  const receiptId = effectReceiptId(send);
  if (!send || send.isError === true || effectOutcomeUnknown(send) || !receiptId) {
    settleChatgptTaskSend({
      controllerHome: input.ctx.controllerHome,
      repoId: input.repository.repoId,
      taskId: input.taskId,
      requestId: input.requestId,
      outcome: 'outcome_unknown',
      ...(receiptId ? { receiptId } : {}),
    });
    return { result: send, receiptId, observedUrl: observedConversationUrl(send), applied: false };
  }
  settleChatgptTaskSend({
    controllerHome: input.ctx.controllerHome,
    repoId: input.repository.repoId,
    taskId: input.taskId,
    requestId: input.requestId,
    outcome: 'applied',
    receiptId,
  });
  return { result: send, receiptId, observedUrl: observedConversationUrl(send), applied: true };
}

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
  try {
    const controllerType = String(args.controller_type ?? 'chatgpt');
    if (controllerType !== 'chatgpt') throw new Error('WORK_BOUND_CONTROLLER_LAUNCH_RETIRED');
    if (typeof args.work_id === 'string' && args.work_id.trim()) {
      throw new Error('WORK_BOUND_CONTROLLER_LAUNCH_RETIRED');
    }

    const launch = chatgptLaunchSessionRequest(args, repository.repoId);
    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
    const prompt = typeof args.continuation_prompt === 'string' ? args.continuation_prompt.trim() : '';
    if (prompt.length > 9_000) throw new Error('LAUNCH_SESSION_PROMPT_TOO_LONG');
    const issueNumber =
      typeof args.issue_number === 'number' && Number.isInteger(args.issue_number) && args.issue_number > 0
        ? args.issue_number
        : undefined;
    let binding = taskId ? readChatgptTaskSessionBinding(ctx.controllerHome, repository.repoId, taskId) : undefined;

    if (!binding) {
      const launched = await computerAction(
        ctx,
        'create_session',
        launch.requestId,
        {
          session_id: launch.sessionId,
          url: launch.url,
          wait_until: 'domcontentloaded',
        },
        args,
      );
      if (!launched) throw new Error('LAUNCH_SESSION_COMPUTER_ACTION_UNAVAILABLE');
      if (launched.isError === true || effectOutcomeUnknown(launched)) return launched;
      if (!taskId) return launched;
      binding = bindInitialChatgptTaskSession({
        controllerHome: ctx.controllerHome,
        repoId: repository.repoId,
        taskId,
        sessionId: launch.sessionId,
        conversationUrl: observedConversationUrl(launched) ?? launch.url,
      });
      if (!prompt)
        return result(
          buildFacadeResult({
            status: 'ok',
            summary: 'Task bound to one active ChatGPT conversation and browser tab.',
            data: { taskId, reused: false, active: binding.active, history: binding.history },
          }) as unknown as Record<string, unknown>,
        );
    }

    const pendingTabCleanup = binding.history.find((entry) => entry.tabCleanup === 'pending');
    if (pendingTabCleanup) {
      const cleanupRequestId =
        'chatgpt-task-tab-cleanup-' +
        createHash('sha256')
          .update(`${repository.repoId}:${taskId}:${pendingTabCleanup.sessionId}`)
          .digest('hex')
          .slice(0, 24);
      const cleanup = await computerAction(
        ctx,
        'close_session',
        cleanupRequestId,
        {
          session_id: pendingTabCleanup.sessionId,
        },
        args,
      );
      if (!chatgptTabCloseProven(cleanup)) {
        return result(
          buildFacadeResult({
            status: 'blocked',
            summary:
              'The replacement conversation is active, but exact old-tab cleanup is still pending. No new Prompt was sent.',
            data: { taskId, active: binding.active, archivedSessionId: pendingTabCleanup.sessionId, cleanupRequestId },
          }) as unknown as Record<string, unknown>,
          true,
        );
      }
      binding = confirmArchivedChatgptTabClosed({
        controllerHome: ctx.controllerHome,
        repoId: repository.repoId,
        taskId,
        sessionId: pendingTabCleanup.sessionId,
      });
    }

    if (!prompt)
      return result(
        buildFacadeResult({
          status: 'ok',
          summary: 'Reused the existing task-bound ChatGPT conversation without creating a tab.',
          data: { taskId, reused: true, active: binding.active, history: binding.history },
        }) as unknown as Record<string, unknown>,
      );

    const original = binding.active;
    const preflight = await observeTaskSession(ctx, original.sessionId, `${launch.requestId}:preflight`, args);
    const matched = nestedValue(preflight?.structuredContent, 'matched') === true;
    if (!binding.replacement && preflight && preflight.isError !== true && matched) {
      const sent = await sendTaskPrompt({
        ctx,
        repository,
        args,
        taskId,
        sessionId: original.sessionId,
        requestId: `${launch.requestId}:send`,
        prompt,
      });
      if (!sent.applied)
        return result(
          buildFacadeResult({
            status: 'blocked',
            summary:
              'ChatGPT Send outcome is unknown; the same task/session/request must be reconciled before any retry or replacement.',
            data: {
              taskId,
              sessionId: original.sessionId,
              requestId: `${launch.requestId}:send`,
              receiptId: sent.receiptId,
              outcome: 'outcome_unknown',
            },
          }) as unknown as Record<string, unknown>,
          true,
        );
      const observedUrl = sent.observedUrl;
      if (observedUrl)
        binding = updateActiveChatgptTaskConversationUrl({
          controllerHome: ctx.controllerHome,
          repoId: repository.repoId,
          taskId,
          sessionId: original.sessionId,
          conversationUrl: observedUrl,
        });
      return result(
        buildFacadeResult({
          status: 'ok',
          summary: 'Sent the next Prompt in the original task conversation and original browser tab.',
          data: { taskId, reused: true, active: binding.active, sendReceiptId: sent.receiptId },
        }) as unknown as Record<string, unknown>,
      );
    }

    let unavailable = binding.replacement
      ? { unusable: true, reasonCode: binding.replacement.reasonCode }
      : preflightProvesUnusable(preflight);
    if (!binding.replacement && !unavailable.unusable && preflight && preflight.isError !== true) {
      const failureObservation = await observeTaskSessionFailure(
        ctx,
        original.sessionId,
        `${launch.requestId}:failure-preflight`,
        args,
      );
      if (nestedValue(failureObservation?.structuredContent, 'matched') === true) {
        unavailable = { unusable: true, reasonCode: 'chatgpt_conversation_failure_observed' };
      }
    }
    if (!unavailable.unusable) {
      return result(
        buildFacadeResult({
          status: 'blocked',
          summary:
            'The original ChatGPT conversation could not be proven usable or unusable. Preserved its binding and did not create another tab.',
          data: { taskId, sessionId: original.sessionId, reasonCode: unavailable.reasonCode },
        }) as unknown as Record<string, unknown>,
        true,
      );
    }

    const candidateSessionId =
      binding.replacement?.candidateSessionId ??
      'forge-takeover-' +
        createHash('sha256').update(`${repository.repoId}:${taskId}:${launch.requestId}`).digest('hex').slice(0, 20);
    binding = beginChatgptTaskSessionReplacement({
      controllerHome: ctx.controllerHome,
      repoId: repository.repoId,
      taskId,
      expectedSessionId: original.sessionId,
      candidateSessionId,
      reasonCode: unavailable.reasonCode,
    });
    const replacementLaunch = await computerAction(
      ctx,
      'create_session',
      `${launch.requestId}:replacement-open`,
      {
        session_id: candidateSessionId,
        url: 'https://chatgpt.com/',
        wait_until: 'domcontentloaded',
      },
      args,
    );
    if (!replacementLaunch || replacementLaunch.isError === true || effectOutcomeUnknown(replacementLaunch)) {
      return result(
        buildFacadeResult({
          status: 'blocked',
          summary:
            'Replacement conversation creation is incomplete or unknown. Preserved the original tab and the pending takeover identity.',
          data: {
            taskId,
            originalSessionId: original.sessionId,
            candidateSessionId,
            reasonCode: resultErrorCode(replacementLaunch),
          },
        }) as unknown as Record<string, unknown>,
        true,
      );
    }

    const existingCandidateSend =
      binding.pendingSend?.sessionId === candidateSessionId ? binding.pendingSend : undefined;
    if (existingCandidateSend?.outcome === 'reserved' || existingCandidateSend?.outcome === 'outcome_unknown') {
      return result(
        buildFacadeResult({
          status: 'blocked',
          summary:
            'The pending replacement Send must be reconciled with its original request identity before takeover can continue.',
          data: {
            taskId,
            originalSessionId: original.sessionId,
            candidateSessionId,
            requestId: existingCandidateSend.requestId,
            receiptId: existingCandidateSend.receiptId,
            outcome: existingCandidateSend.outcome,
          },
        }) as unknown as Record<string, unknown>,
        true,
      );
    }
    const replacementSendRequestId = existingCandidateSend?.requestId ?? `${launch.requestId}:replacement-send`;
    const sent =
      existingCandidateSend?.outcome === 'applied' && existingCandidateSend.receiptId
        ? ({ applied: true, receiptId: existingCandidateSend.receiptId, observedUrl: undefined } as const)
        : await sendTaskPrompt({
            ctx,
            repository,
            args,
            taskId,
            sessionId: candidateSessionId,
            requestId: replacementSendRequestId,
            prompt: recoveryPrompt(taskId, issueNumber, prompt),
          });
    if (!sent.applied || !sent.receiptId)
      return result(
        buildFacadeResult({
          status: 'blocked',
          summary:
            'Replacement Send is outcome-unknown. Kept both tabs, did not rebind the task, and requires read-only reconciliation.',
          data: {
            taskId,
            originalSessionId: original.sessionId,
            candidateSessionId,
            requestId: replacementSendRequestId,
            receiptId: sent.receiptId,
          },
        }) as unknown as Record<string, unknown>,
        true,
      );

    const observation = await observeTaskSession(
      ctx,
      candidateSessionId,
      `${launch.requestId}:replacement-observe`,
      args,
    );
    const candidateUrl =
      observedConversationUrl(observation) ?? sent.observedUrl ?? observedConversationUrl(replacementLaunch);
    if (!candidateUrl || !/^https:\/\/chatgpt\.com\/c\//.test(candidateUrl)) {
      return result(
        buildFacadeResult({
          status: 'blocked',
          summary:
            'Replacement Prompt was sent, but the canonical replacement conversation URL is not yet proven. Kept the original binding and both tabs.',
          data: { taskId, originalSessionId: original.sessionId, candidateSessionId, sendReceiptId: sent.receiptId },
        }) as unknown as Record<string, unknown>,
        true,
      );
    }

    binding = commitChatgptTaskSessionTakeover({
      controllerHome: ctx.controllerHome,
      repoId: repository.repoId,
      taskId,
      candidateSessionId,
      conversationUrl: candidateUrl,
      sendRequestId: replacementSendRequestId,
      sendReceiptId: sent.receiptId,
    });
    const closeRequestId =
      'chatgpt-task-tab-cleanup-' +
      createHash('sha256').update(`${repository.repoId}:${taskId}:${original.sessionId}`).digest('hex').slice(0, 24);
    const close = await computerAction(
      ctx,
      'close_session',
      closeRequestId,
      {
        session_id: original.sessionId,
      },
      args,
    );
    const oldTabClosed = chatgptTabCloseProven(close);
    if (oldTabClosed)
      binding = confirmArchivedChatgptTabClosed({
        controllerHome: ctx.controllerHome,
        repoId: repository.repoId,
        taskId,
        sessionId: original.sessionId,
      });
    return result(
      buildFacadeResult({
        status: oldTabClosed ? 'ok' : 'blocked',
        summary: oldTabClosed
          ? 'Replacement conversation took over the original task; archived lineage was retained and the exact old tab was closed.'
          : 'Replacement conversation took over the original task, but exact old-tab cleanup remains pending and will not be guessed.',
        data: {
          taskId,
          reused: false,
          takeover: true,
          active: binding.active,
          history: binding.history,
          oldTabClosed,
          sendReceiptId: sent.receiptId,
        },
      }) as unknown as Record<string, unknown>,
      !oldTabClosed,
    );
  } catch (error) {
    return result(
      buildFacadeResult({
        status: 'blocked',
        summary: error instanceof Error ? error.message : 'Launcher failed.',
        data: {},
      }) as unknown as Record<string, unknown>,
      true,
    );
  }
}
