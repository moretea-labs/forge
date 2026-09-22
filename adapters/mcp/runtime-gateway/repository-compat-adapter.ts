import type { McpToolDefinition, CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { boundedPluginArtifactImageContent, jsonPreview, result, resultWithPluginArtifactImages } from './result-adapter';
import { expectedRevision, repositoryRootForRepoId, selected, stringList } from './shared-adapter';
import { completeReviewedDirectEditWorkAfterCommit, prepareReviewedDirectEditWorkCommit, type ReviewedDirectEditWorkCommitPlan } from '../../../src/runtime/control-plane/execution/direct-edit-work-completion';
import { repositoryChangeVerify } from '../../../src/cli/controller/composite-operations';
import {
  commitSelectedPaths,
  selectedPathDiff,
  stageSelectedPaths,
} from '../../../src/cli/repositories/selected-path-actions';



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
              let reviewedCommitPlan: ReviewedDirectEditWorkCommitPlan | undefined;
              let committed;
              try {
                committed = commitSelectedPaths(ctx.controllerHome, repository, {
                  paths: args.paths,
                  message: args.message,
                  beforeCommitGuard: ({ stagedPaths, currentHead }) => {
                    reviewedCommitPlan = prepareReviewedDirectEditWorkCommit({
                      controllerHome: ctx.controllerHome,
                      repository,
                      stagedPaths,
                      currentHead,
                    });
                  },
                });
              } catch (error) {
                return result({
                  repoId: repository.repoId,
                  checkoutId: repository.activeCheckoutId,
                  error: {
                    code: 'SELECTED_PATH_PRECOMMIT_GUARD_FAILED',
                    message: error instanceof Error ? error.message : String(error),
                  },
                }, true);
              }
              const directEditWorkCompletion = !committed.error && committed.commit?.ok === true && reviewedCommitPlan
                ? completeReviewedDirectEditWorkAfterCommit({
                    controllerHome: ctx.controllerHome,
                    repository,
                    plan: reviewedCommitPlan,
                    fallbackBranch: repository.defaultBranch || 'main',
                  })
                : undefined;
              return result({
                repoId: repository.repoId,
                checkoutId: repository.activeCheckoutId,
                ...committed,
                ...(directEditWorkCompletion ? { directEditWorkCompletion } : {}),
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
