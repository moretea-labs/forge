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
import { codexMcpConfigArgs, resolveProviderMcpBootstrap, type ProviderMcpBootstrap } from './provider-mcp-bootstrap';
import { repositoryChildProcessEnvironment } from '../../shared/process-environment';
import { redactProcessOutput } from '../../../effects/process-runner';

export interface ThinLauncherRequest {
  controllerType: Exclude<ControllerType, 'human'>;
  executable?: string;
  args?: string[];
  workId: string;
  /** Short reservation prevents duplicate spawns and scopes provider bootstrap identity; Work is not a semantic ownership lock. */
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

export interface ThinLauncherDependencies {
  resolveProviderMcpBootstrap?: typeof resolveProviderMcpBootstrap;
}

export function launcherProcessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const repositoryEnv = repositoryChildProcessEnvironment(env);
  return {
    ...env,
    PATH: repositoryEnv.PATH,
  };
}

export function resolveLauncherExecutable(
  request: Pick<ThinLauncherRequest, 'controllerType' | 'executable' | 'cwd'>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (request.controllerType === 'chatgpt') {
    throw new Error('LAUNCHER_CHATGPT_SUPERVISOR_OWNED');
  }
  const configured = request.executable?.trim();
  if (configured) return configured;
  const executable = request.controllerType === 'codex'
    ? 'codex'
    : request.controllerType === 'claude'
      ? 'claude'
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
    };
    const persistDiagnostics = () => {
      if (!stdoutTail && !stderrTail) return;
      try {
        recordExternalControllerLaunchDiagnostics(stores.work, workId, reservationId, { stdoutTail, stderrTail });
      } catch {
        // Startup diagnostics are evidence only; preserve the primary process outcome.
      }
    };
    const releaseFailure = (reason: string) => {
      try {
        releaseExternalControllerLaunchReservation(stores.work, workId, reservationId, reason);
      } catch {
        // Preserve the primary startup failure if diagnostic persistence races.
      }
    };
    const fail = (error: Error, reason: string) => {
      if (startupSettled) return;
      startupSettled = true;
      if (timer) clearTimeout(timer);
      persistDiagnostics();
      closeStartupPipes();
      releaseFailure(reason);
      const diagnostics = startupDiagnosticSummary(stdoutTail, stderrTail);
      reject(diagnostics ? new Error(`${error.message}${diagnostics}`) : error);
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
        // Exit evidence is best-effort after another authority released the reservation.
      }
      if (startupSettled) return;
      fail(
        new Error(`LAUNCHER_STARTUP_FAILED: external Controller exited during startup grace (code=${String(exitCode ?? 'null')}, signal=${signal ?? 'none'})`),
        'startup_exit',
      );
    });

    timer = setTimeout(() => {
      if (startupSettled) return;
      startupSettled = true;
      timer = undefined;
      closeStartupPipes();
      resolve();
    }, LAUNCHER_STARTUP_GRACE_MS);
  });
}

export interface CodexControllerInvocationRequest {
  executable: string;
  prompt: string;
  mcpBootstrap: ProviderMcpBootstrap;
  sandbox: 'read-only' | 'workspace-write';
  args?: string[];
  resumeSessionId?: string;
  json?: boolean;
}

export function buildCodexControllerInvocation(
  request: CodexControllerInvocationRequest,
): { executable: string; args: string[] } {
  const prefix = [
    '--ask-for-approval', 'never',
    // Every Codex controller gets an invocation-scoped Forge MCP transport and
    // never inherits an unrelated globally configured Forge tool surface.
    '--disable', 'apps',
    ...codexMcpConfigArgs(request.mcpBootstrap),
    'exec',
  ];
  if (request.resumeSessionId?.trim()) {
    return {
      executable: request.executable,
      args: [
        ...prefix,
        'resume', '--ignore-user-config',
        ...(request.json ? ['--json'] : []),
        ...(request.args ?? []),
        request.resumeSessionId.trim(),
        request.prompt,
      ],
    };
  }
  return {
    executable: request.executable,
    args: [
      ...prefix,
      '--ignore-user-config', '--sandbox', request.sandbox,
      ...(request.json ? ['--json'] : []),
      ...(request.args ?? []),
      request.prompt,
    ],
  };
}

export function buildSuperControllerInvocation(
  request: ThinLauncherRequest,
  executable: string,
  prompt: string,
  mcpBootstrap?: ProviderMcpBootstrap,
): { executable: string; args: string[] } {
  if (request.controllerType === 'codex') {
    if (!mcpBootstrap) throw new Error('LAUNCHER_CODEX_FORGE_MCP_REQUIRED');
    return buildCodexControllerInvocation({
      executable,
      prompt,
      mcpBootstrap,
      sandbox: 'workspace-write',
      args: request.args,
    });
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
  if (request.controllerType === 'chatgpt') {
    throw new Error('LAUNCHER_CHATGPT_SUPERVISOR_OWNED');
  }
  return { executable, args: [...(request.args ?? []), prompt] };
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
  if (request.controllerType === 'chatgpt') {
    throw new Error('LAUNCHER_CHATGPT_SUPERVISOR_OWNED');
  }
  const reservation = reserveExternalControllerLaunch(stores.work, {
    workId: work.workId,
    controllerType: request.controllerType,
    ttlMs: request.launchReservationMs,
  });
  const handoff = request.handoffId ? getHandoffItem(stores.handoff, request.handoffId) : undefined;
  const prompt = [
    `Work: ${work.workId}`,
    `Objective: ${work.objective}`,
    `Acceptance: ${work.acceptanceCriteria.join('; ') || 'none declared'}`,
    `Semantic state: ${work.semanticState}; dispatch: ${work.dispatchState}`,
    handoff ? `Handoff: ${handoff.summary}\nNext: ${handoff.recommendedContinuationPrompt ?? handoff.recommendedPrompt}` : '',
    request.continuationPrompt?.trim() ? `Continuation: ${request.continuationPrompt.trim()}` : '',
    `Forge maintains provider/session binding, transport recovery, effect dedupe, and retry bookkeeping internally. Continue this exact Work using repository capabilities; pass work_id=${work.workId} when durable source attribution is needed, validate with normal capability evidence, and update semantic Work only when objective/result state changes. Surface genuine human decisions through the existing user-request/inbox path.`,
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
    );
    child.unref();
    return { controllerType: request.controllerType, reservationId: reservation.reservationId, pid: child.pid, prompt, executable };
  } catch (error) {
    releaseExternalControllerLaunchReservation(stores.work, work.workId, reservation.reservationId, 'spawn_failed');
    throw error;
  }
}
