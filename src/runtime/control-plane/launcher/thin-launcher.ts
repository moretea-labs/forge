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
    'Use the repository MCP facade directly. Claim the Work before mutation and create a handoff when control changes.',
  ].filter(Boolean).join('\n');
  try {
    const child = spawn(executable, [...(request.args ?? []), prompt], {
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
