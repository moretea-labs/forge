import { classifyRepositoryCommand } from '../../../src/cli/repositories/command-classifier';
import { resolveRepositorySelection } from '../../../src/cli/repositories/registry';
import { executionIdentityForRepository } from '../../../src/runtime/control-plane/execution/execution-identity';
import { getWorkContract } from '../../../packages/kernel/work/api';
import { isTerminalWorkContractStatus } from '../../../src/runtime/control-plane/facade/types';
import {
  classifyRepositoryCommandRoute,
  executeRepositoryCommandViaProcessRuntime,
} from '../../../src/runtime/execution/process-runtime/command-facade';
import {
  callRepositoryTool,
  type RepositoryToolCallerContext,
} from './repository-tools';
import type { CallToolResult } from './tools';

function result(payload: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * A completed Work is historical attribution, never mutation authority.
 *
 * Finalize cleanup may remove the Work-owned checkout and release its Controller
 * lease, but a Controller can still need to observe the repository immediately
 * afterwards (for example `git status -sb`). Keep that observation attributed to
 * the completed Work without reopening the Work lifecycle or writer lease.
 *
 * This path intentionally accepts only typed argv commands that the same command
 * classifier used by Process Runtime proves readonly. Everything else falls
 * through to the normal repository facade so active-Work ownership, terminal
 * mutation fences, and completion-receipt remote-delivery rules stay authoritative.
 */
export async function callPostFinalizeWorkReadOnlyCommand(
  controllerHome: string,
  name: string,
  args: Record<string, unknown>,
  caller?: RepositoryToolCallerContext,
): Promise<CallToolResult | undefined> {
  if (name !== 'repository_command_execute') return undefined;
  if (typeof args.workspace_root === 'string' && args.workspace_root.trim()) return undefined;

  const requestedWorkId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
  const principalId = caller?.principalId?.trim() ?? '';
  const command = args.command;
  if (!requestedWorkId || !principalId || !Array.isArray(command) || !command.every((entry) => typeof entry === 'string')) {
    return undefined;
  }

  const repository = resolveRepositorySelection({
    repoId: typeof args.repo_id === 'string' && args.repo_id.trim() ? args.repo_id.trim() : undefined,
    controllerHome,
    allowSoleRepository: true,
  });
  if (!repository) return undefined;

  const work = getWorkContract({ controllerHome, repoId: repository.repoId }, requestedWorkId);
  if (
    !work
    || !isTerminalWorkContractStatus(work.status)
    || work.status !== 'completed'
    || !work.completionReceipt
    || work.completionReceipt.workId !== requestedWorkId
    || !work.principalId?.trim()
    || work.principalId.trim() !== principalId
  ) {
    return undefined;
  }

  const classification = classifyRepositoryCommand(command, repository.defaultBranch);
  if (classification.risk !== 'readonly') return undefined;
  const route = classifyRepositoryCommandRoute(command, {
    defaultBranch: repository.defaultBranch,
    timeoutMs: optionalNumber(args.timeout_ms),
  });
  if (route.route !== 'process_direct' || route.reason !== 'readonly_fast_path') return undefined;

  const executionIdentity = executionIdentityForRepository(repository, { workId: requestedWorkId });
  const execution = await executeRepositoryCommandViaProcessRuntime({
    controllerHome,
    repository,
    command,
    cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
    timeoutMs: optionalNumber(args.timeout_ms),
    interactiveWaitMs: optionalNumber(args.interactive_wait_ms),
    maxOutputBytes: optionalNumber(args.max_output_bytes),
    requestId: typeof args.request_id === 'string' ? args.request_id : undefined,
    workId: requestedWorkId,
    executionIdentity,
  });

  if (execution.route !== 'process_direct' || execution.process) {
    return result({
      accepted: false,
      mode: 'reject',
      path: 'post_finalize_readonly_route_mismatch',
      route: 'reject',
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      workId: requestedWorkId,
      lifecycleClosed: true,
      error: {
        code: 'POST_FINALIZE_READONLY_ROUTE_MISMATCH',
        message: 'Post-finalize Work attribution may execute only through the bounded readonly direct lane.',
      },
    }, true);
  }

  return result({
    accepted: true,
    mode: 'process_direct',
    path: 'process_direct',
    route: 'process_direct',
    reason: 'post_finalize_work_readonly_followup',
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    workId: requestedWorkId,
    lifecycleClosed: true,
    postFinalizeAttribution: 'readonly_followup',
    completed: true,
    ok: execution.ok === true,
    exitCode: execution.exitCode,
    stdout: execution.stdout,
    stderr: execution.stderr,
    durableSideEffects: execution.durableSideEffects,
    next: 'Post-finalize readonly observation completed without reopening Work mutation authority or creating durable execution state.',
  });
}

export async function callRepositoryToolWithPostFinalizeAttribution(
  controllerHome: string,
  name: string,
  args: Record<string, unknown>,
  caller?: RepositoryToolCallerContext,
): Promise<CallToolResult | undefined> {
  const followup = await callPostFinalizeWorkReadOnlyCommand(controllerHome, name, args, caller);
  return followup ?? callRepositoryTool(controllerHome, name, args, caller);
}
