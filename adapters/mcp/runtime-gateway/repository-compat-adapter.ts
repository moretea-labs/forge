import type { McpToolDefinition, CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { boundedPluginArtifactImageContent, jsonPreview, result, resultWithPluginArtifactImages } from './result-adapter';
import { expectedRevision, repositoryRootForRepoId, selected, stringList } from './shared-adapter';
import { repositoryChangeVerify } from '../../../src/cli/controller/composite-operations';
import {
  commitSelectedPaths,
  selectedPathDiff,
  stageSelectedPaths,
} from '../../../src/cli/repositories/selected-path-actions';
import { assertCanonicalRepositoryMutationWorkHandleAvailable, ensureRepositoryMutationWorkHandle } from '../../../src/runtime/control-plane/execution/work-handle-authority';
import { settleWorkHandleExpectedHeadAfterRepositoryCommand } from '../../../src/runtime/control-plane/execution/work-head-settlement';
import type { ResolvedExecutionIdentity } from '../../../src/runtime/control-plane/execution/execution-identity';
import { repositoryGitStatus } from '../../../src/cli/repositories/structured-git';



export async function callRepositoryCompatibilityAdapter(ctx: MultiRepositoryMcpToolContext, name: string, args: Record<string, unknown>): Promise<CallToolResult | undefined> {
  try {
    switch (name) {
      case 'git_diff_paths': {
              const repository = selected(ctx, args);
              return result({
                ...selectedPathDiff(repository, {
                  paths: args.paths,
                  staged: args.staged === true,
                  maxBytes: typeof args.max_bytes === 'number' ? args.max_bytes : undefined,
                }),
              });
            }
      case 'git_stage_paths': {
              const repository = selected(ctx, args);
              const staged = stageSelectedPaths(ctx.controllerHome, repository, { paths: args.paths });
              return result({
                repoId: repository.repoId,
                checkoutId: repository.activeCheckoutId,
                ...staged,
              }, staged.execution.ok !== true);
            }
      case 'git_commit_paths': {
              const repository = selected(ctx, args);
              const workId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
              // Do not allow a sessionless commit to advance an active Work's
              // canonical checkout and leave that Work bound to an old HEAD.
              assertCanonicalRepositoryMutationWorkHandleAvailable({
                controllerHome: ctx.controllerHome,
                repositoryId: repository.repoId,
                checkoutId: repository.activeCheckoutId,
                ...(workId ? { workId } : {}),
              });
              const handle = workId ? ensureRepositoryMutationWorkHandle({
                controllerHome: ctx.controllerHome,
                repository,
                workId,
                principalId: ctx.principalId?.trim() ?? '',
                sessionId: ctx.sessionId,
              }).handle : undefined;
              const executionIdentity: ResolvedExecutionIdentity | undefined = handle ? {
                schemaVersion: 1,
                repositoryId: handle.repositoryId,
                checkoutId: handle.checkoutId,
                canonicalRoot: handle.worktreePath,
                workId: handle.workId,
                branch: handle.branch,
                expectedHead: handle.expectedHead,
              } : undefined;
              let headSettlement: ReturnType<typeof settleWorkHandleExpectedHeadAfterRepositoryCommand> | undefined;
              let settlementError: string | undefined;
              const committed = commitSelectedPaths(ctx.controllerHome, repository, {
                paths: args.paths,
                message: args.message,
                ...(handle ? { beforeStageGuard: () => {
                  const status = repositoryGitStatus(repository);
                  if (status.head !== handle.expectedHead || status.branch !== handle.branch) {
                    throw new Error(`WORK_HANDLE_HEAD_CHANGED: expected ${handle.expectedHead ?? 'missing'} on ${handle.branch}, found ${status.head ?? 'missing'} on ${status.branch ?? 'detached'}`);
                  }
                } } : {}),
                ...(handle ? { beforeCommitGuard: ({ currentHead }: { currentHead: string | null }) => {
                  if (currentHead !== handle.expectedHead) {
                    throw new Error(`WORK_HANDLE_HEAD_CHANGED: expected ${handle.expectedHead ?? 'missing'}, found ${currentHead ?? 'missing'}`);
                  }
                  const branch = repositoryGitStatus(repository).branch;
                  if (branch !== handle.branch) {
                    throw new Error(`WORK_HANDLE_BRANCH_CHANGED: expected ${handle.branch}, found ${branch ?? 'detached'}`);
                  }
                } } : {}),
                ...(executionIdentity ? { afterCommit: () => {
                  try {
                    headSettlement = settleWorkHandleExpectedHeadAfterRepositoryCommand({
                      controllerHome: ctx.controllerHome,
                      repository,
                      executionIdentity,
                      workId,
                      ok: true,
                    });
                  } catch (error) {
                    settlementError = error instanceof Error ? error.message : String(error);
                  }
                } } : {}),
              });
              const requiresReconciliation = Boolean(handle && !committed.error && headSettlement?.settled !== true);
              return result({
                repoId: repository.repoId,
                checkoutId: repository.activeCheckoutId,
                ...committed,
                ...(handle ? { workId, headSettlement: headSettlement ?? null } : {}),
                ...(requiresReconciliation ? { settlementWarning: settlementError ?? `WORK_HEAD_SETTLEMENT_RECONCILIATION_REQUIRED: ${headSettlement?.reason ?? 'no settlement receipt'}` } : {}),
              // Successful Git commit is never misreported as a failed
              // side effect merely because Work HEAD settlement needs repair.
              }, Boolean(committed.error));
            }
      case 'repository_change_verify': {
              const repository = selected(ctx, args);
              const expectedFileShas = args.expected_file_shas && typeof args.expected_file_shas === 'object' && !Array.isArray(args.expected_file_shas)
                ? Object.fromEntries(
                  Object.entries(args.expected_file_shas as Record<string, unknown>)
                    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
                )
                : undefined;
              const payload = repositoryChangeVerify({
                repo: repository.canonicalRoot,
                expectedBranch: typeof args.expected_branch === 'string' ? args.expected_branch : undefined,
                expectedHead: typeof args.expected_head === 'string' ? args.expected_head : undefined,
                expectedFileShas,
                patch: typeof args.patch === 'string' ? args.patch : undefined,
                allowedPaths: Array.isArray(args.allowed_paths)
                  ? args.allowed_paths.filter((value): value is string => typeof value === 'string')
                  : undefined,
                checks: Array.isArray(args.checks)
                  ? args.checks.filter((value): value is string => typeof value === 'string')
                  : undefined,
                checkTimeoutMs: typeof args.check_timeout_ms === 'number' ? args.check_timeout_ms : undefined,
              });
              return result(payload as unknown as Record<string, unknown>, payload.status === 'failed');
            }
      default: return undefined;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const structuredCode = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1];
    return result({ error: { code: structuredCode ?? 'RUNTIME_TOOL_FAILED', message } }, true);
  }
}
