import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import type { RepositoryRecord } from '../../../src/cli/repositories/types';
import { createHash } from 'crypto';
import { result } from './result-adapter';
import { callPluginAdapter } from './plugin-adapter';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade';
import { launchSuperController } from '../../../src/runtime/control-plane/launcher/thin-launcher';

// The existing Computer create_session action owns browser/session state.
// This thin launcher validates intent only; it never sends a model message.
export function chatgptLaunchSessionRequest(args: Record<string, unknown>, repoId: string): {
  requestId: string;
  sessionId: string;
  url: string;
} {
  const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
  if (!requestId) throw new Error('LAUNCH_SESSION_REQUEST_ID_REQUIRED');
  if (typeof args.continuation_prompt === 'string' && args.continuation_prompt.trim()) {
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
  try { parsed = new URL(url); } catch { throw new Error('LAUNCH_SESSION_URL_INVALID'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'chatgpt.com'
    || parsed.username || parsed.password || parsed.port) {
    throw new Error('LAUNCH_SESSION_CHATGPT_ORIGIN_REQUIRED');
  }
  const suppliedSessionId = typeof args.browser_session_id === 'string' ? args.browser_session_id.trim() : '';
  const sessionId = suppliedSessionId
    || 'forge-launch-' + createHash('sha256').update(repoId + ':' + requestId).digest('hex').slice(0, 20);
  return { requestId, sessionId, url: parsed.href };
}

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
      const launch = chatgptLaunchSessionRequest(args, repository.repoId);
      const launched = await callPluginAdapter(ctx, 'plugin_action_execute', {
        plugin_id: 'computer',
        action_id: 'create_session',
        request_id: launch.requestId,
        arguments: {
          session_id: launch.sessionId,
          url: launch.url,
          wait_until: 'domcontentloaded',
        },
      });
      if (!launched) throw new Error('LAUNCH_SESSION_COMPUTER_ACTION_UNAVAILABLE');
      return launched;
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
