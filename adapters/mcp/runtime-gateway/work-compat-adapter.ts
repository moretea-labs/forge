import type { McpToolDefinition, CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { boundedPluginArtifactImageContent, jsonPreview, result, resultWithPluginArtifactImages } from './result-adapter';
import { expectedRevision, repositoryRootForRepoId, selected, stringList } from './shared-adapter';
import { ageMs, callStatusInboxAdapter, controllerReadinessEvidence, GIT_IDENTITY_SAMPLE_TTL_MS, localControllerDiagnosticMatchesRuntime, probeLocalControllerHealth, runtimeSourceSnapshotStatus, summarizeInvalidActiveWorkCandidate, summarizeWorkListItem, type ControllerReadinessSignals } from './status-inbox-adapter';
import { cancelExecutionJob, findExecutionJob, getExecutionJob, getExecutionJobByRequestId, listExecutionJobs } from '../../../src/runtime/execution/jobs/store';
import { waitForExecutionJob } from '../../../src/runtime/execution/jobs/wait';
import type { ExecutionJob } from '../../../src/runtime/execution/jobs/types';
import { getProcessHandle, listRecoverableProcessRecords, processRuntimeResourceDiagnostics } from '../../../src/runtime/execution/process-runtime';
import { getRepositoryCommandProcess, waitRepositoryCommandProcess } from '../../../src/runtime/execution/process-runtime/command-facade';
import { buildJobOperationDigest } from '../../../src/runtime/control-plane/facade/operation-digest';
import { readWorkHandle, transitionWorkHandle, type WorkHandleState } from '../../../src/runtime/control-plane/execution/work-handle-store';
import { buildControllerTaskLedgerProjection } from '../../../src/cli/controller/task-ledger';
import {
  summarizeExecutionJobForMcp,
  summarizeJobResultForLowInterception,
  summarizePluginForLowInterception,
} from '../../../src/runtime/safe-tooling';
import { acknowledgeHandoffItem, createHandoffItem, countHandoffItems, dismissHandoffItem, listCapabilityDescriptors, getCapabilityDescriptor, getPluginActionCapabilitySchema, searchCapabilityDescriptors, summarizeCapabilityGroups, listHandoffItems, runHandoffInboxApplication, summarizeHandoffItem, buildWorkContinuationSnapshot, type FacadeTool } from '../../../src/runtime/control-plane/facade';
import {
  getWorkContract,
  getWorkContractByRequestId,
  listWorkContracts,
  readActiveWorkCandidates,
  type InvalidActiveWorkCandidate,
} from '../../../packages/kernel/work/api/index';
import { reconcileWorkValidation } from './work-validation-reconciler';
import { summarizeJobEvents, summarizeExecutionJob } from './runtime-tool-shared';

function workPhase(status: ExecutionJob['status']): 'queued' | 'running' | 'attention' | 'completed' {
  if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(status)) return 'completed';
  if (['orphaned', 'stale', 'human_attention_required'].includes(status)) return 'attention';
  if (status === 'running' || status === 'dispatched') return 'running';
  return 'queued';
}

function summarizeWork(job: ExecutionJob, repoRoot?: string): Record<string, unknown> {
  const summary = summarizeExecutionJob(job, repoRoot);
  return {
    workId: job.jobId,
    requestId: job.requestId,
    repoId: job.repoId,
    operation: typeof job.payload?.operation === 'string' ? job.payload.operation : job.type,
    phase: workPhase(job.status),
    resumable: true,
    ...summary,
  };
}

const TERMINAL_WORK_HANDLE_STATES = new Set<WorkHandleState['state']>(['cleaned', 'failed']);

function workHandlePhase(handle: WorkHandleState): 'implementation' | 'verification' | 'delivery' | 'cleanup' | 'completed' | 'attention' {
  if (handle.state === 'cleaned') return 'completed';
  if (handle.state === 'failed') return 'attention';
  if (handle.state === 'validating') return 'verification';
  if (handle.state === 'committed') return 'delivery';
  if (handle.state === 'merged') return 'cleanup';
  return 'implementation';
}

function reconcileReadableWorkHandle(
  controllerHome: string,
  repoId: string,
  workId: string,
): WorkHandleState | undefined {
  const handle = readWorkHandle(controllerHome, repoId, workId);
  if (!handle) return undefined;
  try {
    return reconcileWorkValidation(controllerHome, handle).handle;
  } catch (error) {
    const current = readWorkHandle(controllerHome, repoId, workId);
    if (current && current.recordRevision !== handle.recordRevision) return current;
    throw error;
  }
}

async function waitForReadableWorkHandle(
  controllerHome: string,
  repoId: string,
  workId: string,
  waitMs: number,
): Promise<{ handle?: WorkHandleState; timedOut: boolean; waitedMs: number }> {
  const startedAt = Date.now();
  let handle = reconcileReadableWorkHandle(controllerHome, repoId, workId);
  while (handle && !TERMINAL_WORK_HANDLE_STATES.has(handle.state) && Date.now() - startedAt < waitMs) {
    const remaining = waitMs - (Date.now() - startedAt);
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(100, remaining))));
    handle = reconcileReadableWorkHandle(controllerHome, repoId, workId);
  }
  const waitedMs = Date.now() - startedAt;
  return {
    handle,
    timedOut: Boolean(handle && !TERMINAL_WORK_HANDLE_STATES.has(handle.state)),
    waitedMs,
  };
}

function summarizeWorkHandle(
  handle: WorkHandleState,
  contract?: NonNullable<ReturnType<typeof getWorkContract>>,
): Record<string, unknown> {
  const terminal = TERMINAL_WORK_HANDLE_STATES.has(handle.state);
  const summary = contract?.objective?.trim()
    ? contract.objective.slice(0, 240)
    : `Work ${handle.workId} is ${handle.state}.`;
  return {
    kind: 'work_handle',
    workId: handle.workId,
    repoId: handle.repositoryId,
    checkoutId: handle.checkoutId,
    state: handle.state,
    phase: workHandlePhase(handle),
    statusLabel: handle.state,
    summary,
    terminal,
    resumable: !terminal,
    branch: handle.branch,
    expectedHead: handle.expectedHead,
    validation: handle.finalization.validation,
    updatedAt: handle.updatedAt,
    nextAction: terminal
      ? undefined
      : handle.state === 'validating'
        ? 'Wait for persisted validation receipts.'
        : 'Continue the existing WorkHandle.',
  };
}

function summarizeSubmittedWorkContract(contract: NonNullable<ReturnType<typeof getWorkContract>>): Record<string, unknown> {
  const operation = contract.submittedOperation;
  const continuation = buildWorkContinuationSnapshot(contract);
  return {
    kind: 'work_contract',
    workId: contract.workId,
    repoId: contract.repoId,
    status: contract.status,
    operation: operation?.name,
    requestId: contract.requestId,
    deduplicated: undefined,
    nextAction: continuation.nextSafeAction,
    mode: contract.mode,
    objective: contract.objective,
    updatedAt: contract.updatedAt,
    resourceClaims: operation?.resourceClaims ?? [],
    operationMetadata: operation
      ? {
          mode: operation.mode,
          idempotent: operation.idempotent,
          replayable: operation.replayable,
          resourceClaims: operation.resourceClaims,
        }
      : undefined,
    summary: contract.objective.slice(0, 240),
    phase: contract.status === 'running'
      ? 'running'
      : contract.status === 'failed' || contract.status === 'cancelled'
        ? 'attention'
        : contract.status === 'completed'
          ? 'completed'
          : 'queued',
    statusLabel: contract.status,
    semantics: continuation.semantics,
    reconciliationRequired: continuation.reconciliationRequired,
  };
}

function summarizeWorkContractListItem(contract: NonNullable<ReturnType<typeof getWorkContract>>): Record<string, unknown> {
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(contract.status);
  return {
    workId: contract.workId,
    kind: 'work_contract',
    mode: contract.mode,
    objective: contract.objective,
    status: contract.status,
    phase: terminal ? 'completed' : contract.status === 'running' ? 'running' : 'attention',
    statusLabel: terminal ? '已完成' : contract.status === 'running' ? '运行中' : '待审查',
    summary: `WorkContract ${contract.status}: ${contract.objective.slice(0, 240)}`,
    terminal,
    resumable: !terminal,
    changedFileCount: 0,
    evidenceCount: contract.evidenceRefs.length,
    checkCount: contract.checkRefs.length,
    createdAt: contract.createdAt,
    updatedAt: contract.updatedAt,
    suggestedNextAction: contract.suggestedNextActions[0],
    semantics: buildWorkContinuationSnapshot(contract).semantics,
    reconciliationRequired: buildWorkContinuationSnapshot(contract).reconciliationRequired,
    detailPointer: { tool: 'work_get', work_id: contract.workId },
  };
}

function resolveWorkJob(
  ctx: MultiRepositoryMcpToolContext,
  repoId: string,
  args: Record<string, unknown>,
): ExecutionJob | undefined {
  const workId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
  const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
  if (!workId && !requestId) throw new Error('WORK_ID_REQUIRED: provide work_id or request_id');
  if (workId) {
    try { return getExecutionJob(ctx.controllerHome, repoId, workId); }
    catch { return undefined; }
  }
  return getExecutionJobByRequestId(ctx.controllerHome, requestId, repoId);
}

function managedProcessOperationDigest(
  handle: NonNullable<ReturnType<typeof getProcessHandle>>,
): Record<string, unknown> {
  const terminal = handle.completed === true;
  const phase = terminal
    ? handle.ok === true
      ? 'succeeded'
      : handle.timedOut === true
        ? 'timed_out'
        : handle.cancelled === true
          ? 'cancelled'
          : 'failed'
    : 'running';
  return {
    schemaVersion: 1,
    operationId: handle.processId,
    operationType: 'managed-process',
    workRef: handle.processId,
    status: handle.status,
    phase,
    terminal,
    resumable: !terminal,
    completed: handle.completed === true,
    ok: handle.ok,
    exitCode: handle.exitCode,
    timedOut: handle.timedOut,
    cancelled: handle.cancelled,
    startedAt: handle.startedAt,
    summary: terminal
      ? `Managed process ${handle.processId} completed with status ${handle.status}.`
      : `Managed process ${handle.processId} is still ${handle.status}.`,
    // A running Process is not itself a request to poll. The controller should
    // keep making independent progress, then join only at its real dependency
    // boundary through the Process lifecycle surface.
    suggestedNextActions: [],
  };
}

export async function callWorkCompatibilityAdapter(ctx: MultiRepositoryMcpToolContext, name: string, args: Record<string, unknown>): Promise<CallToolResult | undefined> {
  try {
    switch (name) {
      case 'work_get': {
              const repository = selected(ctx, args);
              const workId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
              const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
              const contract = workId
                ? getWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, workId)
                : requestId
                  ? getWorkContractByRequestId(ctx.controllerHome, requestId, repository.repoId)
                  : undefined;
              const handleId = workId || contract?.workId || '';
              if (handleId) {
                const waited = args.wait === true || typeof args.wait_ms === 'number';
                const waitMs = typeof args.wait_ms === 'number' ? Math.max(0, args.wait_ms) : 15_000;
                const resolved = waited
                  ? await waitForReadableWorkHandle(ctx.controllerHome, repository.repoId, handleId, waitMs)
                  : { handle: reconcileReadableWorkHandle(ctx.controllerHome, repository.repoId, handleId), timedOut: false, waitedMs: 0 };
                if (resolved.handle) {
                  const work = summarizeWorkHandle(resolved.handle, contract);
                  return result({
                    work,
                    workHandle: resolved.handle,
                    ...(contract ? {
                      workContract: contract,
                      continuation: buildWorkContinuationSnapshot(contract),
                    } : {}),
                    summary: work.summary,
                    phase: work.phase,
                    statusLabel: work.statusLabel,
                    waited,
                    timedOut: resolved.timedOut,
                    waitedMs: resolved.waitedMs,
                    next: work.nextAction,
                  }, resolved.handle.state === 'failed');
                }
              }
              let job = resolveWorkJob(ctx, repository.repoId, args);
              if (!job) {
                if (contract) {
                  const work = summarizeSubmittedWorkContract(contract);
                  const waited = args.wait === true || typeof args.wait_ms === 'number';
                  const terminal = contract.status === 'completed' || contract.status === 'failed' || contract.status === 'cancelled';
                  return result({
                    work,
                    workContract: contract,
                    continuation: buildWorkContinuationSnapshot(contract),
                    summary: work.summary,
                    phase: work.phase,
                    statusLabel: work.statusLabel,
                    waited,
                    timedOut: waited ? !terminal : false,
                    waitedMs: waited && typeof args.wait_ms === 'number' ? args.wait_ms : 0,
                    next: work.nextAction,
                  });
                }
                return result({ error: { code: 'WORK_NOT_FOUND', message: 'No Work matched this repository and identifier.', errorClass: 'not_found', summary: '未找到对应任务。' } }, true);
              }
              let timedOut = false;
              let waitedMs = 0;
              if (args.wait === true) {
                const waited = await waitForExecutionJob({
                  controllerHome: ctx.controllerHome,
                  repoId: repository.repoId,
                  jobId: job.jobId,
                  timeoutMs: typeof args.wait_ms === 'number' ? args.wait_ms : 15_000,
                });
                job = waited.job;
                timedOut = waited.timedOut;
                waitedMs = waited.waitedMs;
              }
              const digest = buildJobOperationDigest(job, { waited: args.wait === true, stillRunning: timedOut });
              return result({
                work: summarizeWork(job, repository.canonicalRoot),
                digest,
                summary: digest.summary,
                phase: digest.phase,
                statusLabel: digest.statusLabel,
                errorClass: digest.errorClass,
                errorMessage: digest.errorMessage,
                waited: args.wait === true || typeof args.wait_ms === 'number',
                timedOut,
                waitedMs,
                ...(args.include_events === true ? { events: summarizeJobEvents(ctx.controllerHome, job.repoId, job.jobId) } : {}),
              }, digest.phase === 'failed' || digest.phase === 'timed_out');
            }
      case 'work_wait': {
              const repository = selected(ctx, args);
              const waitMs = typeof args.wait_ms === 'number' ? Math.max(0, args.wait_ms) : 15_000;
              const workId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
              const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
              const contract = workId
                ? getWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, workId)
                : requestId
                  ? getWorkContractByRequestId(ctx.controllerHome, requestId, repository.repoId)
                  : undefined;
              const handleId = workId || contract?.workId || '';
              if (handleId) {
                const resolved = await waitForReadableWorkHandle(ctx.controllerHome, repository.repoId, handleId, waitMs);
                if (resolved.handle) {
                  const work = summarizeWorkHandle(resolved.handle, contract);
                  return result({
                    work,
                    workHandle: resolved.handle,
                    ...(contract ? {
                      workContract: contract,
                      continuation: buildWorkContinuationSnapshot(contract),
                    } : {}),
                    summary: work.summary,
                    phase: work.phase,
                    statusLabel: work.statusLabel,
                    waited: true,
                    timedOut: resolved.timedOut,
                    waitedMs: resolved.waitedMs,
                    next: work.nextAction,
                  }, resolved.handle.state === 'failed');
                }
              }
              const job = resolveWorkJob(ctx, repository.repoId, args);
              if (!job) {
                const processRef = String(args.work_id ?? args.request_id ?? '').trim();
                const process = getRepositoryCommandProcess(ctx.controllerHome, repository.repoId, processRef);
                if (!process) return result({ error: { code: 'WORK_NOT_FOUND', message: 'No Work or managed process matched this repository and identifier.', errorClass: 'not_found', summary: '未找到对应任务。' } }, true);
                const waitedProcess = await waitRepositoryCommandProcess(ctx.controllerHome, repository.repoId, processRef, { timeoutMs: waitMs });
                const digest = managedProcessOperationDigest(waitedProcess);
                return result({
                  work: { kind: 'managed_process', processId: processRef },
                  digest,
                  summary: digest.summary,
                  phase: digest.phase,
                  suggestedNextActions: digest.suggestedNextActions,
                  waited: true,
                  timedOut: waitedProcess.completed !== true,
                  waitedMs: waitMs,
                }, digest.phase === 'failed' || digest.phase === 'timed_out');
              }
              const waited = await waitForExecutionJob({
                controllerHome: ctx.controllerHome,
                repoId: repository.repoId,
                jobId: job.jobId,
                timeoutMs: waitMs,
              });
              const digest = buildJobOperationDigest(waited.job, { waited: true, stillRunning: waited.timedOut });
              return result({
                work: summarizeWork(waited.job, repository.canonicalRoot),
                digest,
                summary: digest.summary,
                phase: digest.phase,
                statusLabel: digest.statusLabel,
                errorClass: digest.errorClass,
                errorMessage: digest.errorMessage,
                changedFiles: digest.changedFiles,
                suggestedNextActions: digest.suggestedNextActions,
                waited: true,
                timedOut: waited.timedOut,
                waitedMs: waited.waitedMs,
              }, digest.phase === 'failed' || digest.phase === 'timed_out');
            }
      case 'work_list': {
              const repository = selected(ctx, args);
              const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(Math.trunc(args.limit), 100)) : 50;
              const jobs = listExecutionJobs(ctx.controllerHome, repository.repoId, limit).map(summarizeWorkListItem);
              const contracts = listWorkContracts({
                controllerHome: ctx.controllerHome,
                repoId: repository.repoId,
                status: 'all',
                limit,
              }).map(summarizeWorkContractListItem);
              const works = [...jobs, ...contracts]
                .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
                .slice(0, limit);
              return result({ detailLevel: 'summary', works, next: 'Call work_get for bounded details.' });
            }
      case 'work_cancel': {
              const repository = selected(ctx, args);
              const job = resolveWorkJob(ctx, repository.repoId, args);
              if (!job) return result({ error: { code: 'WORK_NOT_FOUND', message: 'No Work matched this repository and identifier.', errorClass: 'not_found', summary: '未找到对应任务。' } }, true);
              const cancelled = await cancelExecutionJob(
                ctx.controllerHome,
                repository.repoId,
                job.jobId,
                typeof args.reason === 'string' ? args.reason : undefined,
              );
              const digest = buildJobOperationDigest(cancelled);
              return result({ work: summarizeWork(cancelled, repository.canonicalRoot), digest, summary: digest.summary, phase: digest.phase });
            }
      case 'work_result_summary': {
              const repository = selected(ctx, args);
              const jobId = String(args.job_id ?? '').trim();
              const job = getExecutionJob(ctx.controllerHome, repository.repoId, jobId);
              const taskLedger = buildControllerTaskLedgerProjection(repository.canonicalRoot);
              return result({
                summary: summarizeJobResultForLowInterception(job),
                taskLedgerStatus: taskLedger.status,
                next: taskLedger.status.nextAction,
              });
            }
      case 'work_status_digest': {
              const repository = selected(ctx, args);
              const workRef = String(args.work_ref ?? '').trim();
              let job: ExecutionJob | undefined;
              try { job = getExecutionJob(ctx.controllerHome, repository.repoId, workRef); }
              catch { job = undefined; }
              const taskLedger = buildControllerTaskLedgerProjection(repository.canonicalRoot);
              if (job) {
                return result({
                  digest: summarizeJobResultForLowInterception(job),
                  workRef,
                  taskLedgerStatus: taskLedger.status,
                  next: taskLedger.status.nextAction,
                });
              }
              const contract = getWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, workRef);
              if (contract) {
                const continuation = buildWorkContinuationSnapshot(contract);
                return result({
                  digest: continuation,
                  workRef,
                  taskLedgerStatus: taskLedger.status,
                  next: continuation.nextSafeAction,
                }, contract.status === 'failed' || continuation.reconciliationRequired);
              }
              const process = getRepositoryCommandProcess(ctx.controllerHome, repository.repoId, workRef);
              if (!process) return result({ error: { code: 'WORK_NOT_FOUND', message: 'No Work or managed process matched work_ref.', errorClass: 'not_found', summary: '未找到对应任务。' } }, true);
              const digest = managedProcessOperationDigest(process);
              return result({
                digest,
                workRef,
                taskLedgerStatus: taskLedger.status,
                next: process.completed === true
                  ? 'Managed process is terminal; inspect the bounded digest above.'
                  : `Continue independent work. Use process_get only if an observation can change the next decision; join once with process_wait when this exact result becomes a dependency. Do not re-run the original operation.`,
              }, digest.phase === 'failed' || digest.phase === 'timed_out');
            }
      case 'request_release_gate': {
              const repository = selected(ctx, args);
              const requestId = typeof args.request_id === 'string' && args.request_id.trim()
                ? args.request_id.trim()
                : `release:${repository.repoId}:${Math.floor(Date.now() / 60_000)}`;
              return result({
                accepted: false,
                mode: 'external_controller_required',
                requestId,
                repoId: repository.repoId,
                rejectCode: 'EXECUTION_JOB_RETIRED',
                message: 'Release Gate no longer creates an ExecutionJob. An external Controller must claim the related Work and execute release evidence explicitly.',
                suggestedOperation: 'rh_work.controller_claim followed by Process Runtime checks and explicit release authorization.',
              });
            }
      default: return undefined;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const structuredCode = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1];
    return result({ error: { code: structuredCode ?? 'RUNTIME_TOOL_FAILED', message } }, true);
  }
}
