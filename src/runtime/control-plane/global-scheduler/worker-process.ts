import type { ChildProcess } from 'child_process';
import type { SchedulerWorkerStderrCapture } from './worker-stderr';

export interface SchedulerWorkerProcessExit {
  exitCode: number | null;
  signal: string | null;
  stderr: string;
  stderrTruncated: boolean;
  startupError?: string;
}

export function wireSchedulerWorkerProcess(input: {
  jobId: string;
  child: ChildProcess;
  children: Map<string, ChildProcess>;
  stderrCapture: SchedulerWorkerStderrCapture;
  onExit(exit: SchedulerWorkerProcessExit): void;
}): void {
  const { child } = input;
  child.stderr?.on('data', (chunk: Buffer | string) => input.stderrCapture.append(chunk));

  let finalized = false;
  const finalize = (exitCode: number | null, signal: string | null, startupError?: string) => {
    if (finalized) return;
    finalized = true;
    if (input.children.get(input.jobId) === child) input.children.delete(input.jobId);
    const snapshot = input.stderrCapture.snapshot();
    input.onExit({
      exitCode,
      signal,
      stderr: snapshot.stderr,
      stderrTruncated: snapshot.stderrTruncated,
      startupError,
    });
  };

  child.once('error', (error) => finalize(null, null, error.message));
  child.once('close', (code, signal) => finalize(code, signal));
}
