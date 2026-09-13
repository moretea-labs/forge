import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { buildWorkspaceAuthStatus, prepareWorkspaceAuthLogin, summarizePluginForLowInterception } from '../../../src/runtime/safe-tooling';
import {
  assistantPluginScope,
  controllerPluginRepository,
  getAssistantPluginManifest,
  listAssistantPluginManifests,
} from '../../../src/runtime/plugins/store';
import { executeAssistantPluginActionApplication } from '../../../src/runtime/plugins/action-application';
import { mcpPluginExecutionOrigin } from '../../../src/runtime/plugins/execution-origin';
import type { AssistantPluginManifest } from '../../../src/runtime/plugins/types';
import { result, resultWithPluginArtifactImages } from './result-adapter';
import { selected } from './shared-adapter';

function pluginRepository(
  ctx: MultiRepositoryMcpToolContext,
  args: Record<string, unknown>,
  pluginId: string,
) {
  return assistantPluginScope(pluginId, ctx.controllerHome) === 'controller'
    ? controllerPluginRepository(ctx.controllerHome)
    : selected(ctx, args);
}

function summarizePlugin(manifest: AssistantPluginManifest): Record<string, unknown> {
  return {
    pluginId: manifest.pluginId,
    provider: manifest.provider,
    displayName: manifest.displayName,
    pluginVersion: manifest.pluginVersion,
    revision: manifest.revision,
    enabled: manifest.enabled,
    lifecycle: manifest.lifecycle,
    health: manifest.health,
    authority: manifest.authority,
    permissions: manifest.permissions,
    capabilities: manifest.capabilities,
    actions: manifest.actions.map((action) => ({
      actionId: action.actionId,
      title: action.title,
      description: action.description,
      readOnly: action.readOnly,
      risk: action.risk,
      confirmation: action.confirmation,
      requiredConfirmationText: action.requiredConfirmationText,
      defaultTimeoutMs: action.defaultTimeoutMs,
      cancellable: action.cancellable,
      idempotent: action.idempotent,
      scopes: action.scopes,
      resourceClaims: action.resourceClaims,
      argumentsSchema: action.argumentsSchema,
    })),
    updatedAt: manifest.updatedAt,
  };
}

function summarizePluginActionReceipt(manifest: AssistantPluginManifest): Record<string, unknown> {
  return {
    pluginId: manifest.pluginId,
    provider: manifest.provider,
    displayName: manifest.displayName,
    pluginVersion: manifest.pluginVersion,
    revision: manifest.revision,
    enabled: manifest.enabled,
    lifecycleState: manifest.lifecycle.state,
    health: {
      state: manifest.health.state,
      ready: manifest.health.ready,
      checkedAt: manifest.health.checkedAt,
      errorCount: manifest.health.errors.length,
      warningCount: manifest.health.warnings.length,
    },
    updatedAt: manifest.updatedAt,
  };
}

function compactSubmittedPluginActionResult(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const nested = value.result;
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return value;
  const work = value.work;
  return {
    ...(nested as Record<string, unknown>),
    ...(work && typeof work === 'object' && !Array.isArray(work) ? { work } : {}),
  };
}

export async function callPluginAdapter(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  switch (name) {
    case 'list_plugins': {
      const controllerRepository = controllerPluginRepository(ctx.controllerHome);
      const controllerPlugins = listAssistantPluginManifests(ctx.controllerHome, controllerRepository, {
        forceRefresh: true,
      }).map(summarizePlugin);
      let repositoryPlugins: ReturnType<typeof summarizePlugin>[] = [];
      let repositoryId: string | undefined;
      try {
        const repository = selected(ctx, args);
        repositoryId = repository.repoId;
        repositoryPlugins = listAssistantPluginManifests(ctx.controllerHome, repository, {
          forceRefresh: true,
        }).map(summarizePlugin);
      } catch (error) {
        if (typeof args.repo_id === 'string' && args.repo_id.trim()) throw error;
      }
      return result({
        scope: repositoryPlugins.length > 0 ? 'combined' : 'controller',
        repositoryId,
        plugins: [...repositoryPlugins, ...controllerPlugins]
          .sort((left, right) => String(left.pluginId).localeCompare(String(right.pluginId))),
      });
    }
    case 'get_plugin': {
      const pluginId = String(args.plugin_id ?? '').trim();
      const repository = pluginRepository(ctx, args, pluginId);
      return result({
        scope: repository.repoId === '__controller__' ? 'controller' : 'repository',
        plugin: summarizePlugin(getAssistantPluginManifest(ctx.controllerHome, repository, pluginId)),
      });
    }
    case 'plugin_action_execute': {
      const pluginId = String(args.plugin_id ?? '').trim();
      const workId = typeof args.work_id === 'string' && args.work_id.trim() ? args.work_id.trim() : undefined;
      const repository = pluginRepository(ctx, args, pluginId);
      const workRepository = workId ? selected(ctx, args) : undefined;
      const actionId = String(args.action_id ?? '').trim();
      const requestId = String(args.request_id ?? '').trim();
      const actionArguments = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
        ? args.arguments as Record<string, unknown>
        : {};
      const request = {
        pluginId,
        actionId,
        requestId,
        workId,
        ...(workId && workRepository ? { workRepoId: workRepository.repoId } : {}),
        args: actionArguments,
        timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
        signal: ctx.signal,
        confirmAuthorization: args.confirm_authorization === true,
        confirmationText: typeof args.confirmation_text === 'string' ? args.confirmation_text : undefined,
        origin: mcpPluginExecutionOrigin(ctx.principalId, 'plugin_action_execute', requestId),
      };
      const application = await executeAssistantPluginActionApplication({
        controllerHome: ctx.controllerHome,
        repository,
        request,
        interactiveWaitMs: typeof args.interactive_wait_ms === 'number' ? args.interactive_wait_ms : 750,
        wait: args.wait === true,
        waitMs: typeof args.wait_ms === 'number' ? args.wait_ms : 15_000,
      });

      if (application.kind === 'direct_read') {
        const value = {
          accepted: true,
          direct: true,
          durable: false,
          plugin: summarizePluginActionReceipt(application.manifest),
          action: {
            actionId: application.action.actionId,
            risk: application.action.risk,
            confirmation: application.action.confirmation,
          },
          scope: repository.repoId === '__controller__' ? 'controller' : 'repository',
          result: application.result,
          detail: {
            tool: 'rh_context',
            arguments: {
              ...(repository.repoId === '__controller__' ? {} : { repo_id: repository.repoId }),
              capability_id: `plugin.${pluginId}.${actionId}`,
              detail_level: 'detail',
            },
          },
          next: 'Continue with the returned bounded result; use rh_context capability detail only when the typed action schema/policy is needed.',
        };
        return resultWithPluginArtifactImages(value, ctx.controllerHome, repository.repoId, application.result);
      }

      if (application.kind === 'direct_non_persistent') {
        return result({
          accepted: true,
          direct: true,
          durable: false,
          replayable: false,
          mode: 'direct_non_persistent',
          plugin: summarizePluginActionReceipt(application.manifest),
          action: {
            actionId: application.action.actionId,
            risk: application.action.risk,
            confirmation: application.action.confirmation,
          },
          scope: repository.repoId === '__controller__' ? 'controller' : 'repository',
          requestId,
          result: application.result,
          detail: {
            tool: 'rh_context',
            arguments: {
              ...(repository.repoId === '__controller__' ? {} : { repo_id: repository.repoId }),
              capability_id: `plugin.${pluginId}.${actionId}`,
              detail_level: 'detail',
            },
          },
          next: 'This protected action completed inline without durable replay state. Use the returned result only for the immediate next protected action.',
        });
      }

      if (application.kind === 'lightweight_running') {
        return result({
          accepted: true,
          direct: false,
          durable: false,
          mode: 'lightweight_process',
          plugin: summarizePluginActionReceipt(application.manifest),
          action: application.action ? {
            actionId: application.action.actionId,
            risk: application.action.risk,
            confirmation: application.action.confirmation,
            requiredConfirmationText: application.action.requiredConfirmationText,
          } : { actionId },
          scope: 'repository',
          requestId,
          process: application.process,
          resultRef: { kind: 'process_logs', processId: application.process.processId },
          next: 'The typed plugin action is isolated from the Canonical Runtime. Use process_wait on processId; after completion, call plugin_action_execute again with the same request_id to retrieve the deduplicated structured receipt.',
        });
      }

      if (application.kind === 'lightweight_failed') {
        const handle = application.process;
        return result({
          accepted: true,
          direct: false,
          durable: false,
          mode: 'lightweight_process',
          requestId,
          process: handle,
          error: {
            code: handle.timedOut ? 'PLUGIN_ACTION_TIMEOUT' : handle.cancelled ? 'PLUGIN_ACTION_CANCELLED' : 'PLUGIN_ACTION_FAILED',
            message: handle.stderrTail || handle.stdoutTail || `Plugin action process exited with code ${String(handle.exitCode)}`,
          },
        }, true);
      }

      const submitted = application.submitted;
      const compactResult = compactSubmittedPluginActionResult(submitted.result);
      const value = {
        accepted: true,
        deduplicated: submitted.deduplicated,
        direct: true,
        durable: false,
        plugin: summarizePluginActionReceipt(submitted.manifest),
        action: {
          actionId: submitted.action.actionId,
          risk: submitted.action.risk,
          confirmation: submitted.action.confirmation,
          requiredConfirmationText: submitted.action.requiredConfirmationText,
        },
        scope: repository.repoId === '__controller__' ? 'controller' : 'repository',
        receiptId: submitted.receipt.receiptId,
        requestId: submitted.receipt.requestId,
        ...(submitted.receipt.workId ? { workId: submitted.receipt.workId } : {}),
        authorization: submitted.authorization,
        result: compactResult,
        detail: {
          tool: 'rh_context',
          arguments: {
            ...(repository.repoId === '__controller__' ? {} : { repo_id: repository.repoId }),
            capability_id: `plugin.${pluginId}.${actionId}`,
            detail_level: 'detail',
          },
        },
        next: 'Continue with the returned bounded plugin result; use rh_context capability detail only when the typed action schema/policy is needed.',
      };
      return resultWithPluginArtifactImages(value, ctx.controllerHome, repository.repoId, compactResult);
    }
    case 'workspace_auth_status': {
      const repository = selected(ctx, args);
      return result(buildWorkspaceAuthStatus(listAssistantPluginManifests(ctx.controllerHome, repository)));
    }
    case 'workspace_auth_login_prepare': {
      selected(ctx, args);
      return result(prepareWorkspaceAuthLogin(ctx.controllerHome, {
        service: typeof args.service === 'string' ? args.service : undefined,
        scopes: Array.isArray(args.scopes) ? args.scopes.map(String) : undefined,
        redirectUri: typeof args.redirect_uri === 'string' ? args.redirect_uri : undefined,
      }));
    }
    case 'toolchain_plugin_summary': {
      const pluginId = String(args.plugin_id ?? '').trim();
      const repository = pluginRepository(ctx, args, pluginId);
      const manifest = getAssistantPluginManifest(ctx.controllerHome, repository, pluginId);
      return result({
        plugin: summarizePluginForLowInterception(manifest),
        nonOpaque: true,
        next: manifest.pluginId === 'browser'
          ? 'Use rh_context for browser capability schemas and plugin_action_execute for typed HTTP(S) browser actions.'
          : undefined,
      });
    }
    default:
      return undefined;
  }
}
