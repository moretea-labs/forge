import { spawn, spawnSync } from 'child_process';
import {
  claimControllerSession,
  getHandoffItem,
  getWorkContract,
  releaseControllerSession,
  type HandoffInboxStoreOptions,
  type WorkContractStoreOptions,
} from '../facade';
import type { ControllerType } from '../facade/types';

export interface ThinLauncherRequest {
  controllerType: Exclude<ControllerType, 'human'>;
  executable?: string;
  args?: string[];
  workId: string;
  controllerId: string;
  sessionId: string;
  leaseMs?: number;
  handoffId?: string;
  /** Saved Forge ChatGPT browser session to continue. */
  browserSessionId?: string;
  /** Explicit ChatGPT conversation URL used when no saved Forge browser session exists. */
  conversationUrl?: string;
  /** Additional bounded continuation instruction, for example a Schedule occurrence. */
  continuationPrompt?: string;
  cwd: string;
}

export interface ThinLauncherResult {
  controllerType: ThinLauncherRequest['controllerType'];
  controllerId: string;
  sessionId: string;
  pid: number | undefined;
  prompt: string;
  executable: string;
}

function resolveLauncherExecutable(request: ThinLauncherRequest): string {
  const configured = request.executable?.trim();
  if (configured) return configured;
  const executable = request.controllerType === 'codex'
    ? 'codex'
    : request.controllerType === 'claude'
      ? 'claude'
      : request.controllerType === 'chatgpt'
        ? process.env.FORGE_CLI_EXECUTABLE?.trim() || 'forge'
        : '';
  if (!executable) throw new Error(`LAUNCHER_EXECUTABLE_REQUIRED: ${request.controllerType} requires an external launcher executable`);
  const probe = spawnSync(executable, ['--version'], {
    cwd: request.cwd,
    stdio: 'ignore',
    timeout: 5_000,
  });
  if (probe.error || probe.status !== 0) {
    throw new Error(`LAUNCHER_EXECUTABLE_UNAVAILABLE: ${executable}`);
  }
  return executable;
}

function assertChatgptConversationUrl(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('LAUNCHER_CHATGPT_CONVERSATION_URL_INVALID');
  }
  if (url.protocol !== 'https:' || !['chatgpt.com', 'www.chatgpt.com'].includes(url.hostname)) {
    throw new Error('LAUNCHER_CHATGPT_CONVERSATION_URL_INVALID');
  }
  return url.toString();
}

export function buildSuperControllerInvocation(request: ThinLauncherRequest, executable: string, prompt: string): { executable: string; args: string[] } {
  if (request.controllerType !== 'chatgpt') {
    return { executable, args: [...(request.args ?? []), prompt] };
  }
  const browserSessionId = request.browserSessionId?.trim();
  const conversationUrl = assertChatgptConversationUrl(request.conversationUrl);
  if (browserSessionId) {
    return {
      executable,
      args: [
        'chatgpt', 'browser-followup',
        '--repo', request.cwd,
        '--session', browserSessionId,
        '--prompt', prompt,
        '--keep-browser',
        ...(request.args ?? []),
      ],
    };
  }
  return {
    executable,
    args: [
      'chatgpt', 'browser-consult',
      '--repo', request.cwd,
      '--prompt', prompt,
      ...(conversationUrl ? ['--chatgpt-url', conversationUrl] : []),
      '--keep-browser',
      ...(request.args ?? []),
    ],
  };
}

/**
 * Starts one external SuperController session. This module deliberately owns
 * provider process selection and prompt construction; the execution Kernel
 * receives neither provider-specific arguments nor model output.
 */
export function launchSuperController(
  stores: {
    work: WorkContractStoreOptions & { controllerHome: string; repoId: string };
    handoff: HandoffInboxStoreOptions;
  },
  request: ThinLauncherRequest,
): ThinLauncherResult {
  if (!request.controllerId.trim() || !request.sessionId.trim()) throw new Error('LAUNCHER_CONTROLLER_SESSION_REQUIRED');
  const executable = resolveLauncherExecutable(request);
  const work = getWorkContract(stores.work, request.workId);
  if (!work) throw new Error(`WORK_NOT_FOUND: ${request.workId}`);
  const session = claimControllerSession(stores.work, {
    workId: work.workId,
    controllerId: request.controllerId,
    controllerType: request.controllerType,
    sessionId: request.sessionId,
    leaseMs: request.leaseMs,
  });
  const handoff = request.handoffId ? getHandoffItem(stores.handoff, request.handoffId) : undefined;
  const prompt = [
    `Work: ${work.workId}`,
    `Objective: ${work.objective}`,
    `Acceptance: ${work.acceptanceCriteria.join('; ') || 'none declared'}`,
    `Current status: ${work.status}`,
    handoff ? `Handoff: ${handoff.summary}\nNext: ${handoff.recommendedContinuationPrompt ?? handoff.recommendedPrompt}` : '',
    request.continuationPrompt?.trim() ? `Continuation: ${request.continuationPrompt.trim()}` : '',
    'Use the repository MCP facade directly. Claim the Work before mutation and create a handoff when control changes.',
  ].filter(Boolean).join('\n');
  try {
    const invocation = buildSuperControllerInvocation(request, executable, prompt);
    const child = spawn(invocation.executable, invocation.args, {
      cwd: request.cwd,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { controllerType: request.controllerType, controllerId: session.controllerId, sessionId: session.sessionId, pid: child.pid, prompt, executable };
  } catch (error) {
    releaseControllerSession(stores.work, work.workId, request.controllerId);
    throw error;
  }
}
