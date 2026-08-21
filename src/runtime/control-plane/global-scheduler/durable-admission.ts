import {
  listActiveExecutionJobs,
  markExecutionJobSchedulerObserved,
} from '../../execution/jobs/store';
import { tickSchedules } from '../../workflow/schedules/engine';

const SCHEDULE_TICK_INTERVAL_MS = 30_000;

export interface SchedulerDurableAdmissionDependencies {
  listActiveJobs: typeof listActiveExecutionJobs;
  markSchedulerObserved: typeof markExecutionJobSchedulerObserved;
  tickSchedules: typeof tickSchedules;
}

const DEFAULT_DEPENDENCIES: SchedulerDurableAdmissionDependencies = {
  listActiveJobs: listActiveExecutionJobs,
  markSchedulerObserved: markExecutionJobSchedulerObserved,
  tickSchedules,
};

export async function runSchedulerDurableAdmission(input: {
  controllerHome: string;
  repositoryIds: readonly string[];
  nowMs: number;
  lastScheduleTickAt: number;
}, dependencies: SchedulerDurableAdmissionDependencies = DEFAULT_DEPENDENCIES): Promise<{
  scheduleTicked: boolean;
}> {
  // Observation closes the admission phase for durable Jobs and starts their
  // independent queue budget. Each Job owns its own atomic state transition,
  // so this intentionally remains outside the global dispatch reservation lock.
  for (const job of dependencies.listActiveJobs(input.controllerHome)) {
    if (job.status === 'running' || job.timings?.schedulerObservedAt) continue;
    try {
      dependencies.markSchedulerObserved(input.controllerHome, job.repoId, job.jobId);
    } catch {
      // Another Scheduler instance or a terminal transition won the Job-local race.
    }
  }

  if (input.nowMs - input.lastScheduleTickAt < SCHEDULE_TICK_INTERVAL_MS) {
    return { scheduleTicked: false };
  }
  await dependencies.tickSchedules(input.controllerHome, [...input.repositoryIds]);
  return { scheduleTicked: true };
}
