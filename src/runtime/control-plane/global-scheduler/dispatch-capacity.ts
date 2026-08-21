import type { ExecutionJob } from '../../execution/jobs/types';

export type SchedulerAgentProvider = 'codex' | 'claude' | 'github-copilot';

export interface SchedulerDispatchLimits {
  maxWorkers: number;
  maxHeavyChecks: number;
  maxAgentProcesses: number;
  maxCodexProcesses: number;
  maxClaudeProcesses: number;
  maxGitHubProcesses: number;
}

export interface SchedulerDispatchCapacity {
  reservedJobs: ExecutionJob[];
  workers: number;
  heavyChecks: number;
  agents: number;
  providers: Map<SchedulerAgentProvider, number>;
}

export function schedulerAgentProvider(
  job: Pick<ExecutionJob, 'payload'>,
): SchedulerAgentProvider {
  const agent = job.payload.arguments?.agent;
  if (agent === 'claude' || agent === 'github-copilot') return agent;
  return 'codex';
}

export function createSchedulerDispatchCapacity(
  activeJobs: readonly ExecutionJob[],
  limits: SchedulerDispatchLimits,
  pressured: boolean,
): SchedulerDispatchCapacity {
  const reservedJobs = activeJobs.filter((job) => job.status === 'running' || job.status === 'dispatched');
  const reservedAgents = reservedJobs.filter((job) => job.type === 'agent-run' || job.type === 'dispatch-task');
  let workers = limits.maxWorkers - reservedJobs.length;
  let heavyChecks = limits.maxHeavyChecks
    - reservedJobs.filter((job) => job.type === 'check' || job.type === 'verify-edit').length;
  let agents = limits.maxAgentProcesses - reservedAgents.length;
  const providers = new Map<SchedulerAgentProvider, number>([
    ['codex', limits.maxCodexProcesses - reservedAgents.filter((job) => schedulerAgentProvider(job) === 'codex').length],
    ['claude', limits.maxClaudeProcesses - reservedAgents.filter((job) => schedulerAgentProvider(job) === 'claude').length],
    ['github-copilot', limits.maxGitHubProcesses - reservedAgents.filter((job) => schedulerAgentProvider(job) === 'github-copilot').length],
  ]);
  if (pressured) {
    workers = Math.min(workers, 1);
    heavyChecks = Math.min(heavyChecks, 1);
    agents = 0;
    providers.set('codex', 0);
    providers.set('claude', 0);
    providers.set('github-copilot', 0);
  }
  return { reservedJobs, workers, heavyChecks, agents, providers };
}

export function schedulerDispatchCapacityAllows(
  capacity: SchedulerDispatchCapacity,
  job: Pick<ExecutionJob, 'type' | 'payload'>,
): boolean {
  if ((job.type === 'check' || job.type === 'verify-edit') && capacity.heavyChecks <= 0) return false;
  if (job.type === 'agent-run' || job.type === 'dispatch-task') {
    if (capacity.agents <= 0) return false;
    if ((capacity.providers.get(schedulerAgentProvider(job)) ?? 0) <= 0) return false;
  }
  return true;
}

export function consumeSchedulerDispatchCapacity(
  capacity: SchedulerDispatchCapacity,
  job: Pick<ExecutionJob, 'type' | 'payload'>,
): void {
  capacity.workers -= 1;
  if (job.type === 'check' || job.type === 'verify-edit') capacity.heavyChecks -= 1;
  if (job.type === 'agent-run' || job.type === 'dispatch-task') {
    capacity.agents -= 1;
    const provider = schedulerAgentProvider(job);
    capacity.providers.set(provider, (capacity.providers.get(provider) ?? 0) - 1);
  }
}
