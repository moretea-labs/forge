import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { callRepositoryTool } from '../tool-mapping/repository-tools';
import { commitSelectedPaths, restoreSelectedPaths, selectedPathDiff, stageSelectedPaths } from '../../../src/cli/repositories/selected-path-actions';
import { result } from './result-adapter';
import { selected } from './shared-adapter';
import { readControllerConnectionSnapshot, repairControllerConnection } from '../../../src/runtime/control-plane/facade/controller-connection';
import { cancelLocalConversation, readLocalConversationActivity, readLocalConversationModelCatalog, readLocalConversationProviderStatus, sendLocalConversation } from '../../../src/runtime/control-plane/launcher/local-conversation-controller';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export async function callCoreCapabilityAdapter(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (name !== 'capability_execute') return undefined;
  const capabilityId = typeof args.capability_id === 'string' ? args.capability_id.trim() : '';
  const action = typeof args.action === 'string' ? args.action.trim() : '';
  const input = object(args.arguments);

  try {
    if (capabilityId === 'controller.connection') {
      if (action === 'get') return result({ ...readControllerConnectionSnapshot(ctx.controllerHome) });
      if (action === 'repair_connector') return result(repairControllerConnection(ctx.controllerHome));
      return result({ error: { code: 'CORE_CAPABILITY_ACTION_UNSUPPORTED', message: `Unsupported controller.connection action: ${action || '<empty>'}` } }, true);
    }
    if (capabilityId === 'controller.local_conversation') {
      if (action === 'status') return result({ ...await readLocalConversationProviderStatus() });
      if (action === 'models') return result({ ...await readLocalConversationModelCatalog() });
      if (action === 'activity') return result({ ...readLocalConversationActivity(String(input.conversation_id ?? '')) });
      if (action === 'cancel') return result(cancelLocalConversation(String(input.conversation_id ?? '')));
      if (action === 'send') {
        const conversationId = typeof input.conversation_id === 'string' ? input.conversation_id.trim() : '';
        const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
        const providerSessionId = typeof input.provider_session_id === 'string' ? input.provider_session_id.trim() : undefined;
        const model = typeof input.model === 'string' ? input.model.trim() : undefined;
        const reasoningEffort = typeof input.reasoning_effort === 'string' ? input.reasoning_effort.trim() : undefined;
        let imagePaths: string[] | undefined;
        if (input.image_paths !== undefined) {
          if (!Array.isArray(input.image_paths) || input.image_paths.some((value) => typeof value !== 'string')) {
            throw new Error('LOCAL_CONVERSATION_IMAGE_PATHS_INVALID');
          }
          imagePaths = input.image_paths as string[];
        }
        const timeoutMs = typeof input.timeout_ms === 'number' ? input.timeout_ms : undefined;
        const requestedRepoId = typeof args.repo_id === 'string' ? args.repo_id.trim() : '';
        const repository = requestedRepoId ? selected(ctx, args) : undefined;
        return result({ ...await sendLocalConversation({
          controllerHome: ctx.controllerHome,
          conversationId,
          prompt,
          providerSessionId,
          repoId: repository?.repoId,
          model,
          reasoningEffort,
          imagePaths,
          timeoutMs,
        }) });
      }
      return result({ error: { code: 'CORE_CAPABILITY_ACTION_UNSUPPORTED', message: `Unsupported controller.local_conversation action: ${action || '<empty>'}` } }, true);
    }
    if (capabilityId === 'repository.direct_edit') {
      const toolName = action === 'plan'
        ? 'repository_safe_patch_plan'
        : action === 'apply'
          ? 'repository_safe_patch_apply'
          : undefined;
      if (!toolName) {
        return result({ error: { code: 'CORE_CAPABILITY_ACTION_UNSUPPORTED', message: `Unsupported repository.direct_edit action: ${action || '<empty>'}` } }, true);
      }
      const forwarded = await callRepositoryTool(ctx.controllerHome, toolName, {
        ...input,
        ...(typeof args.repo_id === 'string' && args.repo_id.trim() ? { repo_id: args.repo_id.trim() } : {}),
        ...(typeof args.checkout_id === 'string' && args.checkout_id.trim() ? { checkout_id: args.checkout_id.trim() } : {}),
      }, {
        sessionId: ctx.sessionId,
        principalId: ctx.principalId,
        controllerInstanceId: ctx.controllerInstanceId,
      });
      return forwarded ?? result({
        error: { code: 'CORE_CAPABILITY_ROUTE_UNAVAILABLE', message: 'Repository direct-edit capability route is unavailable.' },
      }, true);
    }
    if (capabilityId === 'repository.validation') {
      return result({
        error: {
          code: 'WORK_LIFECYCLE_RETIRED',
          message: 'repository.validation.validate_work is retired; run registered checks directly against repo_id/checkout_id.',
        },
      }, true);
    }
    if (capabilityId !== 'repository.git') {
      return result({ error: { code: 'CORE_CAPABILITY_UNSUPPORTED', message: `Unsupported core capability: ${capabilityId || '<empty>'}` } }, true);
    }
    const repository = selected(ctx, args);
    switch (action) {
      case 'diff_paths':
        return result({
          ...selectedPathDiff(repository, {
            paths: input.paths,
            staged: input.staged === true,
            maxBytes: typeof input.max_bytes === 'number' ? input.max_bytes : undefined,
          }),
        });
      case 'stage_paths': {
        const staged = stageSelectedPaths(ctx.controllerHome, repository, { paths: input.paths });
        return result({
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          ...staged,
        }, staged.execution.ok !== true);
      }
      case 'commit_paths': {
        const committed = commitSelectedPaths(ctx.controllerHome, repository, {
          paths: input.paths,
          message: input.message,
        });
        return result({
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          ...committed,
        }, Boolean(committed.error));
      }
      case 'restore_paths': {
        const restored = restoreSelectedPaths(ctx.controllerHome, repository, {
          paths: input.paths,
          expectedHead: input.expected_head,
          expectedBranch: input.expected_branch,
          expectedPatch: input.expected_patch,
          confirmAuthorization: input.confirm_authorization,
        });
        return result({
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          ...restored,
        }, Boolean(restored.error));
      }
      case 'delete_remote_branch': {
        const forwarded = await callRepositoryTool(ctx.controllerHome, 'repository_git_delete_branch', {
          repo_id: repository.repoId,
          checkout_id: repository.activeCheckoutId,
          branch: input.branch,
          remote: true,
          expected_remote_sha: input.expected_remote_sha,
          ...(typeof input.approval_request_id === 'string' && input.approval_request_id.trim()
            ? { approval_request_id: input.approval_request_id.trim() }
            : {}),
        });
        return forwarded ?? result({
          error: { code: 'CORE_CAPABILITY_ROUTE_UNAVAILABLE', message: 'Repository remote-branch delete route is unavailable.' },
        }, true);
      }
      case 'deliver_work':
      case 'discard_work':
        return result({
          error: {
            code: 'WORK_LIFECYCLE_RETIRED',
            message: `repository.git.${action} is retired; use ordinary Git/checkout capabilities. Historical Work cleanup is maintenance-owned.`,
          },
        }, true);
      default:
        return result({ error: { code: 'CORE_CAPABILITY_ACTION_UNSUPPORTED', message: `Unsupported repository.git action: ${action || '<empty>'}` } }, true);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const structuredCode = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1];
    return result({ error: { code: structuredCode ?? 'CORE_CAPABILITY_FAILED', message } }, true);
  }
}
