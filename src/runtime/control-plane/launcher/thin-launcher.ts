import { spawn, spawnSync, type ChildProcess } from 'child_process';
import {
  getHandoffItem,
  getWorkContract,
  type HandoffInboxStoreOptions,
  type WorkContractStoreOptions,
} from '../facade';
import {
  attachExternalControllerLaunchPid,
  recordExternalControllerLaunchDiagnostics,
  recordExternalControllerLaunchExit,
  releaseExternalControllerLaunchReservation,
  reserveExternalControllerLaunch,
} from './launch-reservation-store';
import type { ControllerType } from '../facade/types';
import { getControllerSession } from '../../../../packages/kernel/controller/api/index';
import { codexMcpConfigArgs, resolveProviderMcpBootstrap, type ProviderMcpBootstrap } from './provider-mcp-bootstrap';
import { getChatgptWorkConversationBinding } from './chatgpt-work-binding-store';
import { repositoryChildProcessEnvironment } from '../../shared/process-environment';
import { redactProcessOutput } from '../../../effects/process-runner';

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
const CODEX_WORK_CLAIM_TIMEOUT_MS = 30_000;
const CODEX_WORK_CLAIM_SETTLEMENT_GRACE_MS = 1_500;
const CODEX_WORK_CLAIM_POLL_INTERVAL_MS = 100;
const STARTUP_DIAGNOSTIC_BYTES = 8 * 1024;

function appendStartupDiagnosticTail(current: string, chunk: unknown): string {
  const text = redactProcessOutput(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? ''));
  const buffer = Buffer.from(`${current}${text}`, 'utf8');
  return buffer.length <= STARTUP_DIAGNOSTIC_BYTES
    ? buffer.toString('utf8')
    : buffer.subarray(buffer.length - STARTUP_DIAGNOSTIC_BYTES).toString('utf8');
}

function startupDiagnosticSummary(stdoutTail: string, stderrTail: string): string {
  const value = redactProcessOutput(stderrTail.trim() || stdoutTail.trim()).replace(/\s+/g, ' ').slice(0, 1200);
  return value ? `; startup_output=${value}` : '';
}

interface ExternalControllerClaimExpectation {
  controllerType: 'codex';
  controllerId: string;
  principalId: string;
  sessionId: string;
}

export interface ThinLauncherDependencies {
  resolveProviderMcpBootstrap?: typeof resolveProviderMcpBootstrap;
  claimTimeoutMs?: number;
  claimSettlementGraceMs?: number;
  claimPollIntervalMs?: number;
}

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
  claimExpectation?: ExternalControllerClaimExpectation,
  options: { claimTimeoutMs?: number; claimSettlementGraceMs?: number; claimPollIntervalMs?: number } = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let startupSettled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stdoutTail = '';
    let stderrTail = '';
    const captureStdout = (chunk: unknown) => { stdoutTail = appendStartupDiagnosticTail(stdoutTail, chunk); };
    const captureStderr = (chunk: unknown) => { stderrTail = appendStartupDiagnosticTail(stderrTail, chunk); };
    child.stdout?.on('data', captureStdout);
    child.stderr?.on('data', captureStderr);
    const closeStartupPipes = () => {
      child.stdout?.off('data', captureStdout);
      child.stderr?.off('data', captureStderr);
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const persistDiagnostics = () => {
      if (!stdoutTail && !stderrTail) return;
      try {
        recordExternalControllerLaunchDiagnostics(stores.work, workId, reservationId, { stdoutTail, stderrTail });
      } catch {
        // Startup diagnostics are evidence only; preserve the primary ownership/claim outcome.
      }
    };
    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const releaseFailure = (reason: string) => {
      try {
        releaseExternalControllerLaunchReservation(stores.work, workId, reservationId, reason);
      } catch {
        // Preserve the primary startup failure if diagnostic persistence itself races or fails.
      }
    };
    const terminateUnclaimedChild = () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill('SIGTERM'); } catch { /* process may already be exiting */ }
    };
    const fail = (error: Error, reason: string, terminate = false) => {
      if (startupSettled) return;
      startupSettled = true;
      clearTimer();
      persistDiagnostics();
      closeStartupPipes();
      if (terminate) terminateUnclaimedChild();
      releaseFailure(reason);
      const diagnostics = startupDiagnosticSummary(stdoutTail, stderrTail);
      reject(diagnostics ? new Error(`${error.message}${diagnostics}`) : error);
    };
    const expectedClaimMatches = (): { matches: boolean; mismatch?: string } => {
      if (!claimExpectation) return { matches: true };
      const owner = getControllerSession(stores.work, workId);
      if (!owner) return { matches: false };
      const ownerPrincipal = owner.principalId?.trim() || owner.controllerId;
      const matches = owner.controllerType === claimExpectation.controllerType
        && owner.controllerId === claimExpectation.controllerId
        && ownerPrincipal === claimExpectation.principalId
        && owner.sessionId === claimExpectation.sessionId;
      return matches
        ? { matches: true }
        : {
          matches: false,
          mismatch: `observed type=${owner.controllerType} controller=${owner.controllerId} principal=${ownerPrincipal} session=${owner.sessionId}`,
        };
    };

    child.once('error', (error) => {
      fail(new Error(`LAUNCHER_STARTUP_FAILED: ${error.message}`), `spawn_error:${error.message}`);
    });

    child.once('exit', (exitCode, signal) => {
      try {
        recordExternalControllerLaunchExit(stores.work, workId, reservationId, {
          exitCode,
          signal: signal ? String(signal) : null,
          stdoutTail,
          stderrTail,
        });
      } catch {
        // Exit evidence is best-effort after another authority has already released the reservation.
      }
      if (startupSettled) return;
      startupSettled = true;
      clearTimer();
      closeStartupPipes();
      const phase = claimExpectation ? 'before exact Work claim became live' : 'during startup grace';
      reject(new Error(`LAUNCHER_STARTUP_FAILED: external Controller exited ${phase} (code=${String(exitCode ?? 'null')}, signal=${signal ?? 'none'})${startupDiagnosticSummary(stdoutTail, stderrTail)}`));
    });

    if (!claimExpectation) {
      timer = setTimeout(() => {
        if (startupSettled) return;
        startupSettled = true;
        closeStartupPipes();
        resolve();
      }, LAUNCHER_STARTUP_GRACE_MS);
      return;
    }

    const claimTimeoutMs = Math.max(100, Math.min(options.claimTimeoutMs ?? CODEX_WORK_CLAIM_TIMEOUT_MS, 60_000));
    const claimSettlementGraceMs = Math.max(0, Math.min(options.claimSettlementGraceMs ?? CODEX_WORK_CLAIM_SETTLEMENT_GRACE_MS, 5_000));
    const claimPollIntervalMs = Math.max(10, Math.min(options.claimPollIntervalMs ?? CODEX_WORK_CLAIM_POLL_INTERVAL_MS, 1_000));
    const claimDeadline = Date.now() + claimTimeoutMs;
    const claimSettlementDeadline = claimDeadline + claimSettlementGraceMs;
    const pollClaim = () => {
      if (startupSettled) return;
      let observation: ReturnType<typeof expectedClaimMatches>;
      try {
        observation = expectedClaimMatches();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail(new Error(`LAUNCHER_CLAIM_OBSERVATION_FAILED: ${message}`), `claim_observation_failed:${message}`, true);
        return;
      }
      if (observation.mismatch) {
        fail(
          new Error(`LAUNCHER_CLAIM_MISMATCH: Work ${workId} expected type=${claimExpectation.controllerType} controller=${claimExpectation.controllerId} principal=${claimExpectation.principalId} session=${claimExpectation.sessionId}; ${observation.mismatch}`),
          'claim_mismatch',
          true,
        );
        return;
      }
      if (observation.matches) {
        timer = setTimeout(() => {
          if (startupSettled) return;
          try {
            const confirmation = expectedClaimMatches();
            if (!confirmation.matches || confirmation.mismatch) {
              fail(new Error(`LAUNCHER_CLAIM_LOST: Codex claim for exact Work ${workId} was not live after startup grace`), 'claim_lost', true);
              return;
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            fail(new Error(`LAUNCHER_CLAIM_OBSERVATION_FAILED: ${message}`), `claim_observation_failed:${message}`, true);
            return;
          }
          startupSettled = true;
          timer = undefined;
          closeStartupPipes();
          resolve();
        }, LAUNCHER_STARTUP_GRACE_MS);
        return;
      }
      if (Date.now() >= claimSettlementDeadline) {
        fail(
          new Error(`LAUNCHER_CLAIM_TIMEOUT: Codex pid=${String(child.pid ?? 'unknown')} did not claim exact Work ${workId} through Forge MCP within ${claimTimeoutMs}ms plus ${claimSettlementGraceMs}ms settlement grace`),
          `claim_timeout:${claimTimeoutMs}ms+${claimSettlementGraceMs}ms_settlement`,
          true,
        );
        return;
      }
      timer = setTimeout(pollClaim, claimPollIntervalMs);
    };
    pollClaim();
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
  dependencies: ThinLauncherDependencies = {},
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
      `No Controller ownership was preclaimed for this continued conversation. First call rh_work operation=controller_claim with repo_id=${work.repoId}, work_id=${work.workId}, and controller_type=chatgpt through your authenticated MCP session; do not invent controller_id/session_id. When that exact Work claim succeeds, capture data.controllerAuthorityId from the response as the opaque Work-bound controller capability. Pass that exact value unchanged as controller_authority_id on the following rh_work operation=continue and every later lifecycle call for this Work, including verify, finalize, stop, and controller_release; if the current frozen client schema does not expose controller_authority_id, pass the same opaque value as session_id compatibility carrier. Never use data.session.sessionId as the durable capability because MCP execution sessions may be replaced or invalidated. Treat Forge Work/Plan/evidence as source of truth; do not invent new scope from chat history. If the claim does not succeed, do not mutate. Continue the next safe action, finalize only when acceptance passes, and create a HandoffItem when judgement is required.`,
    ].filter(Boolean).join('\n')
    : [
      `Work: ${work.workId}`,
      `Objective: ${work.objective}`,
      `Acceptance: ${work.acceptanceCriteria.join('; ') || 'none declared'}`,
      `Current status: ${work.status}`,
      handoff ? `Handoff: ${handoff.summary}\nNext: ${handoff.recommendedContinuationPrompt ?? handoff.recommendedPrompt}` : '',
      request.continuationPrompt?.trim() ? `Continuation: ${request.continuationPrompt.trim()}` : '',
      `No Controller ownership was preclaimed for you. First call rh_work operation=controller_claim with repo_id=${work.repoId}, work_id=${work.workId}, and controller_type=${request.controllerType} through your authenticated MCP session; do not invent controller_id/session_id. When that exact Work claim succeeds, capture data.controllerAuthorityId from the response as the opaque Work-bound controller capability. Pass that exact value unchanged as controller_authority_id on the following rh_work operation=continue and every later lifecycle call for this Work, including verify, finalize, stop, and controller_release; if the current frozen client schema does not expose controller_authority_id, pass the same opaque value as session_id compatibility carrier. Never use data.session.sessionId as the durable capability because MCP execution sessions may be replaced or invalidated. If the claim does not succeed, do not mutate the repository: create no patch, command, commit, or test run until ownership is established. Then use the repository MCP facade, record verification evidence, finalize only when acceptance passes, and create a HandoffItem when judgement is required.`,
    ].filter(Boolean).join('\n');
  try {
    const mcpBootstrap = request.controllerType === 'codex'
      ? (dependencies.resolveProviderMcpBootstrap ?? resolveProviderMcpBootstrap)(stores.work.controllerHome, 'codex', reservation.reservationId)
      : undefined;
    const invocation = buildSuperControllerInvocation({ ...request, controllerHome: stores.work.controllerHome, repoId: work.repoId }, executable, prompt, mcpBootstrap);
    const child = spawn(invocation.executable, invocation.args, {
      cwd: request.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: launcherProcessEnvironment(mcpBootstrap?.env ?? process.env),
    });
    attachExternalControllerLaunchPid(stores.work, work.workId, reservation.reservationId, child.pid);
    await awaitExternalControllerStartup(
      child,
      stores,
      work.workId,
      reservation.reservationId,
      mcpBootstrap ? {
        controllerType: 'codex',
        controllerId: mcpBootstrap.principalId,
        principalId: mcpBootstrap.principalId,
        sessionId: mcpBootstrap.sessionId,
      } : undefined,
      {
        claimTimeoutMs: dependencies.claimTimeoutMs,
        claimSettlementGraceMs: dependencies.claimSettlementGraceMs,
        claimPollIntervalMs: dependencies.claimPollIntervalMs,
      },
    );
    child.unref();
    return { controllerType: request.controllerType, reservationId: reservation.reservationId, pid: child.pid, prompt, executable };
  } catch (error) {
    releaseExternalControllerLaunchReservation(stores.work, work.workId, reservation.reservationId, 'spawn_failed');
    throw error;
  }
}
