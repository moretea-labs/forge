import { spawn, spawnSync, type ChildProcess } from 'child_process';
import {
  getHandoffItem,
  getWorkContract,
  type HandoffInboxStoreOptions,
  type WorkContractStoreOptions,
} from '../facade';
import {
  attachExternalControllerLaunchPid,
  recordExternalControllerLaunchExit,
  releaseExternalControllerLaunchReservation,
  reserveExternalControllerLaunch,
} from './launch-reservation-store';
import type { ControllerType } from '../facade/types';
import { codexMcpConfigArgs, resolveProviderMcpBootstrap, type ProviderMcpBootstrap } from './provider-mcp-bootstrap';
import { getChatgptWorkConversationBinding } from './chatgpt-work-binding-store';
import { repositoryChildProcessEnvironment } from '../../shared/process-environment';

export interface ThinLauncherRequest {
  controllerType: Exclude<ControllerType, 'human'>;
  executable?: string;
  args?: string[];
  workId: string;
  /** Short reservation only prevents duplicate spawns; the external MCP session claims Work with its authenticated identity. */
  launchReservationMs?: number;
  handoffId?: string;
  /** Saved Forge ChatGPT browser session to continue. */
  browserSessionId?: string;
  /** Explicit ChatGPT conversation URL used when no saved Forge browser session exists. */
  conversationUrl?: string;
  /** Additional bounded continuation instruction, for example a Schedule occurrence. */
  continuationPrompt?: string;
  cwd: string;
  /** Internal launch context; populated by launchSuperController, not by callers. */
  controllerHome?: string;
  repoId?: string;
}

export interface ThinLauncherResult {
  controllerType: ThinLauncherRequest['controllerType'];
  reservationId: string;
  pid: number | undefined;
  prompt: string;
  executable: string;
}

const LAUNCHER_STARTUP_GRACE_MS = 250;

function launcherProcessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const repositoryEnv = repositoryChildProcessEnvironment(env);
  return {
    ...env,
    PATH: repositoryEnv.PATH,
  };
}

export function resolveLauncherExecutable(
  request: ThinLauncherRequest,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = request.executable?.trim();
  if (configured) return configured;
  const executable = request.controllerType === 'codex'
    ? 'codex'
    : request.controllerType === 'claude'
      ? 'claude'
      : request.controllerType === 'chatgpt'
        ? env.FORGE_CLI_EXECUTABLE?.trim() || 'forge'
        : '';
  if (!executable) throw new Error(`LAUNCHER_EXECUTABLE_REQUIRED: ${request.controllerType} requires an external launcher executable`);
  const probe = spawnSync(executable, ['--version'], {
    cwd: request.cwd,
    stdio: 'ignore',
    timeout: 5_000,
    env: launcherProcessEnvironment(env),
  });
  if (probe.error || probe.status !== 0) {
    throw new Error(`LAUNCHER_EXECUTABLE_UNAVAILABLE: ${executable}`);
  }
  return executable;
}

async function awaitExternalControllerStartup(
  child: ChildProcess,
  stores: { work: WorkContractStoreOptions & { controllerHome: string; repoId: string } },
  workId: string,
  reservationId: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let startupSettled = false;
    const timer = setTimeout(() => {
      startupSettled = true;
      resolve();
    }, LAUNCHER_STARTUP_GRACE_MS);

    child.once('error', (error) => {
      if (startupSettled) return;
      startupSettled = true;
      clearTimeout(timer);
      releaseExternalControllerLaunchReservation(stores.work, workId, reservationId, `spawn_error:${error.message}`);
      reject(new Error(`LAUNCHER_STARTUP_FAILED: ${error.message}`));
    });

    child.once('exit', (exitCode, signal) => {
      try {
        recordExternalControllerLaunchExit(stores.work, workId, reservationId, {
          exitCode,
          signal: signal ? String(signal) : null,
        });
      } catch {
        // Exit evidence is best-effort after another authority has already released the reservation.
      }
      if (startupSettled) return;
      startupSettled = true;
      clearTimeout(timer);
      reject(new Error(`LAUNCHER_STARTUP_FAILED: external Controller exited during startup grace (code=${String(exitCode ?? 'null')}, signal=${signal ?? 'none'})`));
    });
  });
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

export function buildSuperControllerInvocation(
  request: ThinLauncherRequest,
  executable: string,
  prompt: string,
  mcpBootstrap?: ProviderMcpBootstrap,
): { executable: string; args: string[] } {
  if (request.controllerType === 'codex') {
    if (!mcpBootstrap) throw new Error('LAUNCHER_CODEX_FORGE_MCP_REQUIRED');
    return {
      executable,
      args: [
        '--ask-for-approval', 'never',
        ...codexMcpConfigArgs(mcpBootstrap),
        'exec', '--sandbox', 'workspace-write',
        ...(request.args ?? []),
        prompt,
      ],
    };
  }
  if (request.controllerType === 'claude') {
    if (!(request.args ?? []).includes('--mcp-config')) {
      throw new Error('LAUNCHER_CLAUDE_FORGE_MCP_CONFIG_REQUIRED');
    }
    return {
      executable,
      args: ['--print', '--permission-mode', 'auto', ...(request.args ?? []), prompt],
    };
  }
  if (request.controllerType !== 'chatgpt') {
    return { executable, args: [...(request.args ?? []), prompt] };
  }
  const browserSessionId = request.browserSessionId?.trim();
  const conversationUrl = assertChatgptConversationUrl(request.conversationUrl);
  if (!request.controllerHome || !request.repoId) throw new Error('LAUNCHER_CHATGPT_WORK_BINDING_CONTEXT_REQUIRED');
  return {
    executable,
    args: [
      'chatgpt', 'work-continue',
      '--repo', request.cwd,
      '--controller-home', request.controllerHome,
      '--repo-id', request.repoId,
      '--work-id', request.workId,
      '--prompt', prompt,
      ...(browserSessionId ? ['--session', browserSessionId] : []),
      ...(conversationUrl ? ['--conversation-url', conversationUrl] : []),
      ...(request.args ?? []),
    ],
  };
}

/**
 * Starts one external SuperController session. This module deliberately owns
 * provider process selection and prompt construction; the execution Kernel
 * receives neither provider-specific arguments nor model output.
 */
export async function launchSuperController(
  stores: {
    work: WorkContractStoreOptions & { controllerHome: string; repoId: string };
    handoff: HandoffInboxStoreOptions;
  },
  request: ThinLauncherRequest,
): Promise<ThinLauncherResult> {
  const executable = resolveLauncherExecutable(request);
  const work = getWorkContract(stores.work, request.workId);
  if (!work) throw new Error(`WORK_NOT_FOUND: ${request.workId}`);
  const reservation = reserveExternalControllerLaunch(stores.work, {
    workId: work.workId,
    controllerType: request.controllerType,
    ttlMs: request.launchReservationMs,
  });
  const handoff = request.handoffId ? getHandoffItem(stores.handoff, request.handoffId) : undefined;
  const chatgptBinding = request.controllerType === 'chatgpt'
    ? getChatgptWorkConversationBinding(stores.work, work.workId)
    : undefined;
  const prompt = (request.controllerType === 'chatgpt' && chatgptBinding)
    ? [
      `Continue Forge Work ${work.workId} in repo ${work.repoId}.`,
      handoff ? `Handoff: ${handoff.summary}\nNext: ${handoff.recommendedContinuationPrompt ?? handoff.recommendedPrompt}` : '',
      request.continuationPrompt?.trim() ? `Continuation: ${request.continuationPrompt.trim()}` : '',
      `First call rh_work continue with repo_id=${work.repoId} and work_id=${work.workId}. Treat Forge Work/Plan/evidence as source of truth; do not invent new scope from chat history. If the claim fails, do not mutate. Continue the next safe action, finalize only when acceptance passes, and create a HandoffItem when judgement is required.`,
    ].filter(Boolean).join('\n')
    : [
      `Work: ${work.workId}`,
      `Objective: ${work.objective}`,
      `Acceptance: ${work.acceptanceCriteria.join('; ') || 'none declared'}`,
      `Current status: ${work.status}`,
      handoff ? `Handoff: ${handoff.summary}\nNext: ${handoff.recommendedContinuationPrompt ?? handoff.recommendedPrompt}` : '',
      request.continuationPrompt?.trim() ? `Continuation: ${request.continuationPrompt.trim()}` : '',
      `No Controller ownership was preclaimed for you. First call rh_work continue with repo_id=${work.repoId} and work_id=${work.workId} through your authenticated MCP session; do not invent controller_id/session_id. If that claim does not succeed, do not mutate the repository: create no patch, command, commit, or test run until ownership is established. Then use the repository MCP facade, record verification evidence, finalize only when acceptance passes, and create a HandoffItem when judgement is required.`,
    ].filter(Boolean).join('\n');
  try {
    const mcpBootstrap = request.controllerType === 'codex'
      ? resolveProviderMcpBootstrap(stores.work.controllerHome, 'codex', reservation.reservationId)
      : undefined;
    const invocation = buildSuperControllerInvocation({ ...request, controllerHome: stores.work.controllerHome, repoId: work.repoId }, executable, prompt, mcpBootstrap);
    const child = spawn(invocation.executable, invocation.args, {
      cwd: request.cwd,
      detached: true,
      stdio: 'ignore',
      env: launcherProcessEnvironment(mcpBootstrap?.env ?? process.env),
    });
    attachExternalControllerLaunchPid(stores.work, work.workId, reservation.reservationId, child.pid);
    await awaitExternalControllerStartup(child, stores, work.workId, reservation.reservationId);
    child.unref();
    return { controllerType: request.controllerType, reservationId: reservation.reservationId, pid: child.pid, prompt, executable };
  } catch (error) {
    releaseExternalControllerLaunchReservation(stores.work, work.workId, reservation.reservationId, 'spawn_failed');
    throw error;
  }
}
