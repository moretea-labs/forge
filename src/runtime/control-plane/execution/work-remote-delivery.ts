import { spawnSync } from 'child_process';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { getWorkContract } from '../facade/work-contract-store';
import { isTerminalWorkContractStatus } from '../facade/types';
import { executeRepositoryCommandViaProcessRuntime, waitRepositoryCommandProcess } from '../../execution/process-runtime/command-facade';
import { executionIdentityForRepository } from './execution-identity';

export interface WorkRemoteDeliveryReceipt {
  targetBranch: string;
  targetRevision: string;
  remoteRevisionBefore: string;
  remoteRevisionAfter: string;
  pushed: boolean;
}

function gitText(root: string, args: string[], timeoutMs = 30_000): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });
  if (result.status !== 0 || result.error || typeof result.stdout !== 'string') {
    throw new Error(`WORK_REMOTE_DELIVERY_GIT_FAILED: git ${args[0] ?? 'command'} failed`);
  }
  return result.stdout.trim();
}

function gitSucceeds(root: string, args: string[]): boolean {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  });
  return result.status === 0 && !result.error;
}

function exactRevision(root: string, revision: string, label: string): string {
  const value = gitText(root, ['rev-parse', '--verify', `${revision}^{commit}`]);
  if (!/^[a-f0-9]{40}$/i.test(value)) throw new Error(`WORK_REMOTE_DELIVERY_${label}_INVALID`);
  return value;
}

function assertTargetBranch(root: string, targetBranch: string): void {
  if (!targetBranch.trim() || !gitSucceeds(root, ['check-ref-format', '--branch', targetBranch])) {
    throw new Error(`WORK_REMOTE_DELIVERY_TARGET_BRANCH_INVALID: ${targetBranch || 'missing'}`);
  }
}

function assertActiveWork(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  workId: string;
}): void {
  const contract = getWorkContract(
    { controllerHome: input.controllerHome, repoId: input.repository.repoId },
    input.workId,
  );
  if (
    !contract
    || contract.repoId !== input.repository.repoId
    || (contract.checkoutId && contract.checkoutId !== input.repository.activeCheckoutId)
    || isTerminalWorkContractStatus(contract.status)
    || Boolean(contract.completionReceipt)
  ) {
    throw new Error(`WORK_REMOTE_DELIVERY_ACTIVE_AUTHORITY_REQUIRED: ${input.workId}`);
  }
}

function remoteHead(root: string, targetBranch: string): string {
  const line = gitText(root, ['ls-remote', '--heads', 'origin', `refs/heads/${targetBranch}`])
    .split(/\r?\n/)
    .find(Boolean);
  const revision = line?.split(/\s+/)[0] ?? '';
  if (!/^[a-f0-9]{40}$/i.test(revision)) {
    throw new Error(`WORK_REMOTE_DELIVERY_REMOTE_BRANCH_MISSING: origin/${targetBranch}`);
  }
  return revision;
}

async function executeGit(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  workId: string;
  command: string[];
  timeoutMs: number;
  commandId: string;
}): Promise<{ ok: boolean; detail: string }> {
  const result = await executeRepositoryCommandViaProcessRuntime({
    controllerHome: input.controllerHome,
    repository: input.repository,
    command: input.command,
    timeoutMs: input.timeoutMs,
    interactiveWaitMs: Math.min(5_000, input.timeoutMs),
    maxOutputBytes: 256 * 1024,
    workId: input.workId,
    commandId: input.commandId,
    executionIdentity: executionIdentityForRepository(input.repository, { workId: input.workId }),
  });
  if (result.route === 'reject' || result.route === 'durable') {
    return { ok: false, detail: result.reason ?? result.route };
  }
  if (result.process && !result.process.completed) {
    const waited = await waitRepositoryCommandProcess(
      input.controllerHome,
      input.repository.repoId,
      result.process.processId,
      { timeoutMs: input.timeoutMs },
    );
    return { ok: waited.ok === true, detail: waited.stderr ?? waited.stdout ?? '' };
  }
  return {
    ok: result.ok === true || result.process?.ok === true,
    detail: result.stderr ?? result.stdout ?? result.process?.stderr ?? result.process?.stdout ?? '',
  };
}

async function fetchRemoteTipObject(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  workId: string;
  targetBranch: string;
  timeoutMs: number;
}): Promise<void> {
  const fetched = await executeGit({
    controllerHome: input.controllerHome,
    repository: input.repository,
    workId: input.workId,
    command: ['git', 'fetch', '--no-tags', '--no-write-fetch-head', 'origin', `refs/heads/${input.targetBranch}`],
    timeoutMs: input.timeoutMs,
    commandId: `work-remote-delivery-fetch:${input.workId}:${input.targetBranch}`,
  });
  if (!fetched.ok) {
    throw new Error(`WORK_REMOTE_DELIVERY_FETCH_FAILED: ${fetched.detail || `origin/${input.targetBranch}`}`);
  }
}

async function observedRemoteContainsTarget(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  workId: string;
  targetBranch: string;
  targetRevision: string;
  remoteRevision: string;
  timeoutMs: number;
}): Promise<boolean> {
  await fetchRemoteTipObject(input);
  if (!gitSucceeds(input.repository.canonicalRoot, ['cat-file', '-e', `${input.remoteRevision}^{commit}`])) {
    throw new Error(`WORK_REMOTE_DELIVERY_REMOTE_OBJECT_UNAVAILABLE: ${input.remoteRevision}`);
  }
  return gitSucceeds(
    input.repository.canonicalRoot,
    ['merge-base', '--is-ancestor', input.targetRevision, input.remoteRevision],
  );
}

export async function pushExactWorkRemoteDelivery(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  workId: string;
  targetBranch: string;
  targetRevision: string;
  timeoutMs?: number;
}): Promise<WorkRemoteDeliveryReceipt> {
  assertTargetBranch(input.repository.canonicalRoot, input.targetBranch);
  assertActiveWork(input);
  const targetRevision = exactRevision(input.repository.canonicalRoot, input.targetRevision, 'TARGET_REVISION');
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 120_000, 5_000), 120_000);
  const remoteRevisionBefore = remoteHead(input.repository.canonicalRoot, input.targetBranch);

  if (await observedRemoteContainsTarget({ ...input, targetRevision, remoteRevision: remoteRevisionBefore, timeoutMs })) {
    return {
      targetBranch: input.targetBranch,
      targetRevision,
      remoteRevisionBefore,
      remoteRevisionAfter: remoteRevisionBefore,
      pushed: false,
    };
  }
  if (!gitSucceeds(input.repository.canonicalRoot, ['merge-base', '--is-ancestor', remoteRevisionBefore, targetRevision])) {
    throw new Error(`WORK_REMOTE_DELIVERY_REMOTE_DIVERGED: ${remoteRevisionBefore} is not an ancestor of ${targetRevision}`);
  }

  // Re-read durable authority immediately before the only remote mutation. A
  // terminal Work may be inspected/reconciled, but it can never be reused as
  // authority for an arbitrary post-finalize push.
  assertActiveWork(input);
  const pushed = await executeGit({
    controllerHome: input.controllerHome,
    repository: input.repository,
    workId: input.workId,
    command: ['git', 'push', '--porcelain', 'origin', `${targetRevision}:refs/heads/${input.targetBranch}`],
    timeoutMs,
    commandId: `work-remote-delivery-push:${input.workId}:${targetRevision}`,
  });

  const remoteRevisionAfter = remoteHead(input.repository.canonicalRoot, input.targetBranch);
  const delivered = await observedRemoteContainsTarget({
    ...input,
    targetRevision,
    remoteRevision: remoteRevisionAfter,
    timeoutMs,
  });
  if (!delivered) {
    throw new Error(
      `WORK_REMOTE_DELIVERY_PUSH_FAILED: ${pushed.detail || `${targetRevision} is not reachable from origin/${input.targetBranch}`}`,
    );
  }
  return {
    targetBranch: input.targetBranch,
    targetRevision,
    remoteRevisionBefore,
    remoteRevisionAfter,
    pushed: pushed.ok,
  };
}
