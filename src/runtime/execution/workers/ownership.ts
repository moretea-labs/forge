import { assertRuntimeMayWrite } from "../../root/write-fence";
import { getExecutionJob } from "../jobs/store";
import { assertFencingToken } from "../../resources/leases/store";
import type { ExecutionJob } from "../jobs/types";

export interface ExecutionWorkerInvalidation {
  code:
    | "PARENT_DISCONNECTED"
    | "RUNTIME_UNAVAILABLE"
    | "RUNTIME_AUTHORITY_STALE"
    | "JOB_NOT_RUNNING"
    | "WORKER_REPLACED"
    | "ATTEMPT_REPLACED"
    | "LEASE_INVALID";
  message: string;
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function invalidateExecutionWorker(
  controllerHome: string,
  repoId: string,
  jobId: string,
  options: {
    workerPid: number;
    attempt?: number;
    controllerPid?: number;
    currentParentPid?: number;
    job?: ExecutionJob;
  },
): ExecutionWorkerInvalidation | undefined {
  const currentParentPid = options.currentParentPid ?? process.ppid;
  // Execution Workers are intentionally spawned detached. On macOS/Linux an
  // unref'd detached child may be re-parented to PID 1 while the owning Runtime
  // is still alive. PID 1 is therefore valid here; the Canonical Runtime claim,
  // release identity, Job attempt, and Leases remain authoritative below.
  if (options.controllerPid && currentParentPid !== options.controllerPid && currentParentPid !== 1) {
    return {
      code: "PARENT_DISCONNECTED",
      message: `execution worker parent changed from ${options.controllerPid} to ${currentParentPid}`,
    };
  }
  if (options.controllerPid && !pidAlive(options.controllerPid)) {
    return {
      code: "RUNTIME_UNAVAILABLE",
      message: `Runtime owner process ${options.controllerPid} is no longer running`,
    };
  }
  const runtimeFence = assertRuntimeMayWrite('renew_lease', controllerHome);
  if (!runtimeFence.allowed) {
    return {
      code: "RUNTIME_AUTHORITY_STALE",
      message: `Runtime write authority is unavailable: ${runtimeFence.reason ?? 'denied'}`,
    };
  }
  const job = options.job ?? getExecutionJob(controllerHome, repoId, jobId);
  if (job.status !== "running") {
    return {
      code: "JOB_NOT_RUNNING",
      message: `Execution Job ${jobId} is ${job.status}`,
    };
  }
  if (job.workerPid !== undefined && job.workerPid !== options.workerPid) {
    return {
      code: "WORKER_REPLACED",
      message: `Execution Job ${jobId} belongs to worker PID ${job.workerPid}`,
    };
  }
  if (options.attempt !== undefined && job.attempt !== options.attempt) {
    return {
      code: "ATTEMPT_REPLACED",
      message: `Execution Job ${jobId} attempt ${options.attempt} was replaced by ${job.attempt}`,
    };
  }
  try {
    for (const ref of job.leaseRefs) {
      assertFencingToken(controllerHome, repoId, ref.leaseId, ref.fencingToken);
    }
  } catch (error) {
    return {
      code: "LEASE_INVALID",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return undefined;
}
