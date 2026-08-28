import {
  effectiveProcessStatus,
  isManagedProcessTerminal,
  listProcessRecords,
} from '../../execution/process-runtime';

export interface WorkBoundRepositoryProcessEvidence {
  processId: string;
  commandId?: string;
  finishedAt?: string;
}

/**
 * Re-derive bounded completion evidence from the canonical durable Process store.
 *
 * This deliberately does not create a second evidence authority. A qualifying
 * record must be the terminal successful repository_command_execute Process for
 * the exact Work + checkout, and the command-origin correlation must still name
 * the same Work. Lightweight handles never enter listProcessRecords(), so they
 * cannot satisfy this contract.
 */
export function listWorkBoundRepositoryProcessEvidence(input: {
  controllerHome: string;
  repoId: string;
  checkoutId: string;
  workId: string;
  limit?: number;
}): WorkBoundRepositoryProcessEvidence[] {
  const workId = input.workId.trim();
  const checkoutId = input.checkoutId.trim();
  if (!workId || !checkoutId) return [];

  return listProcessRecords(input.controllerHome, input.repoId, input.limit ?? 500)
    .filter((record) => (
      record.workId === workId
      && record.checkoutId === checkoutId
      && record.origin?.surface === 'command'
      && record.origin.toolName === 'repository_command_execute'
      && record.origin.correlationId === workId
      && isManagedProcessTerminal(record)
      && record.terminalWritten === true
      && effectiveProcessStatus(record, true) === 'succeeded'
      && record.exitCode === 0
      && record.timedOut !== true
      && record.cancelled !== true
      && !record.error
    ))
    .map((record) => ({
      processId: record.processId,
      ...(record.commandId ? { commandId: record.commandId } : {}),
      ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    }));
}
