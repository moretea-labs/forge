import { createHash } from 'crypto';
import { basename } from 'path';
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

export interface WorkBoundRepositoryRemoteEffectProcessEvidence extends WorkBoundRepositoryProcessEvidence {
  authority: 'repository_process';
  actionId: 'git_push';
  requestId: string;
  semanticKey: string;
  resultDigest: string;
}

function isSuccessfulWorkRepositoryProcess(
  record: ReturnType<typeof listProcessRecords>[number],
  input: { workId: string; checkoutId: string },
): boolean {
  return record.workId === input.workId
    && record.checkoutId === input.checkoutId
    && record.origin?.surface === 'command'
    && record.origin.toolName === 'repository_command_execute'
    && record.origin.correlationId === input.workId
    && isManagedProcessTerminal(record)
    && record.terminalWritten === true
    && effectiveProcessStatus(record, true) === 'succeeded'
    && record.exitCode === 0
    && record.timedOut !== true
    && record.cancelled !== true
    && !record.error;
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
    .filter((record) => isSuccessfulWorkRepositoryProcess(record, { workId, checkoutId }))
    .map((record) => ({
      processId: record.processId,
      ...(record.commandId ? { commandId: record.commandId } : {}),
      ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    }));
}

/**
 * Re-derive the narrow repository-command authority allowed to complete a pure
 * remote_effect Work. Only a trusted argv-form `git push` that held the exact
 * repository remote lease may qualify. Shell commands, generic successful
 * commands, untrusted PID identity, and processes from another Work/checkout
 * remain non-authoritative.
 */
export function listWorkBoundRepositoryRemoteEffectProcessEvidence(input: {
  controllerHome: string;
  repoId: string;
  checkoutId: string;
  workId: string;
  limit?: number;
}): WorkBoundRepositoryRemoteEffectProcessEvidence[] {
  const workId = input.workId.trim();
  const checkoutId = input.checkoutId.trim();
  if (!workId || !checkoutId) return [];

  return listProcessRecords(input.controllerHome, input.repoId, input.limit ?? 500)
    .filter((record) => isSuccessfulWorkRepositoryProcess(record, { workId, checkoutId }))
    .filter((record) => (
      record.identity !== undefined
      && record.identityUntrusted !== true
      && record.command.kind === 'argv'
      && basename(record.command.executable ?? '') === 'git'
      && record.command.args?.[0] === 'push'
      && record.resourceClaims.some((claim) => (
        claim.resourceKey === `remote:${input.repoId}`
        && claim.mode === 'exclusive'
        && claim.repoId === input.repoId
        && claim.workId === workId
      ))
    ))
    .map((record) => {
      const requestId = record.origin?.requestId?.trim() || record.commandId?.trim() || record.processId;
      const semanticKey = createHash('sha256').update(JSON.stringify({
        repoId: input.repoId,
        checkoutId,
        workId,
        command: record.command,
        resourceClaims: record.resourceClaims,
      })).digest('hex');
      const resultDigest = createHash('sha256').update(JSON.stringify({
        processId: record.processId,
        exitCode: record.exitCode,
        finishedAt: record.finishedAt,
        terminalWritten: record.terminalWritten,
      })).digest('hex');
      return {
        processId: record.processId,
        ...(record.commandId ? { commandId: record.commandId } : {}),
        ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
        authority: 'repository_process' as const,
        actionId: 'git_push' as const,
        requestId,
        semanticKey,
        resultDigest,
      };
    });
}
