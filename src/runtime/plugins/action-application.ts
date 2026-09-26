import { MAX_PLUGIN_ACTION_TIMEOUT_MS } from '../../../packages/plugin-runtime/external/index';
import type { RepositoryRecord } from '../../cli/repositories/types';
import type { ProcessHandle } from '../execution/process-runtime/types';
import { startManagedPluginAction, waitManagedPluginAction } from './lightweight-action';
import {
  executeAssistantPluginDirectNonPersistent,
  executeAssistantPluginReadDirect,
  getAssistantPluginManifest,
  isDirectNonPersistentPluginAction,
  isDirectPluginReadAction,
  submitAssistantPluginAction,
} from './store';
import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionRequest,
  AssistantPluginManifest,
} from './types';

export type AssistantPluginActionApplicationResult =
  | {
      kind: 'direct_read';
      manifest: AssistantPluginManifest;
      action: AssistantPluginActionDescriptor;
      result: Record<string, unknown>;
      receipt: Awaited<ReturnType<typeof executeAssistantPluginReadDirect>>['receipt'];
    }
  | {
      kind: 'direct_non_persistent';
      manifest: AssistantPluginManifest;
      action: AssistantPluginActionDescriptor;
      result: Record<string, unknown>;
    }
  | {
      kind: 'managed_running';
      manifest: AssistantPluginManifest;
      action?: AssistantPluginActionDescriptor;
      requestId: string;
      process: ProcessHandle;
    }
  | {
      kind: 'managed_failed';
      manifest: AssistantPluginManifest;
      action?: AssistantPluginActionDescriptor;
      requestId: string;
      process: ProcessHandle;
    }
  | {
      kind: 'submitted';
      submitted: Awaited<ReturnType<typeof submitAssistantPluginAction>>;
    };

/**
 * Canonical plugin execution-path coordinator.
 *
 * MCP/CLI adapters translate transport inputs and render results. They do not
 * decide whether an action executes inline, through the lightweight Process
 * Runtime, or through the deterministic receipt path.
 */
export async function executeAssistantPluginActionApplication(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  request: AssistantPluginActionRequest;
  interactiveWaitMs?: number;
  wait?: boolean;
  waitMs?: number;
}): Promise<AssistantPluginActionApplicationResult> {
  const manifest = getAssistantPluginManifest(input.controllerHome, input.repository, input.request.pluginId);
  const action = manifest.actions.find((entry) => entry.actionId === input.request.actionId);

  if (action && isDirectPluginReadAction(action)) {
    const direct = await executeAssistantPluginReadDirect(input.controllerHome, input.repository, input.request);
    return {
      kind: 'direct_read',
      manifest: direct.manifest,
      action: direct.action,
      result: direct.result,
      receipt: direct.receipt,
    };
  }

  if (action?.executionMode === 'direct_non_persistent') {
    if (!isDirectNonPersistentPluginAction(action)) {
      throw new Error(`PLUGIN_DIRECT_NON_PERSISTENT_CONTRACT_INVALID: ${input.request.pluginId}/${input.request.actionId}`);
    }
    const direct = await executeAssistantPluginDirectNonPersistent(input.controllerHome, input.repository, input.request);
    return {
      kind: 'direct_non_persistent',
      manifest: direct.manifest,
      action: direct.action,
      result: direct.result,
    };
  }

  if (action) {
    const requestedTimeoutMs = Number.isFinite(input.request.timeoutMs)
      ? input.request.timeoutMs!
      : action.defaultTimeoutMs;
    const timeoutMs = Math.min(Math.max(1_000, Math.trunc(requestedTimeoutMs)), MAX_PLUGIN_ACTION_TIMEOUT_MS);
    let { handle } = await startManagedPluginAction({
      controllerHome: input.controllerHome,
      repository: input.repository,
      request: input.request,
      interactiveWaitMs: input.interactiveWaitMs,
      timeoutMs,
    });
    if (!handle.completed && input.wait === true) {
      handle = await waitManagedPluginAction(
        input.controllerHome,
        input.repository.repoId,
        handle.processId,
        Math.max(1, input.waitMs ?? 15_000),
        input.request.signal,
      );
    }
    if (!handle.completed) {
      return {
        kind: 'managed_running',
        manifest,
        action,
        requestId: input.request.requestId,
        process: handle,
      };
    }
    if (!handle.ok) {
      return {
        kind: 'managed_failed',
        manifest,
        action,
        requestId: input.request.requestId,
        process: handle,
      };
    }
    // The durable sidecar writes the authoritative receipt. Re-enter the
    // deterministic store with the same request id to bind/read it without
    // replaying the provider effect.
  }

  return {
    kind: 'submitted',
    submitted: await submitAssistantPluginAction(input.controllerHome, input.repository, input.request),
  };
}
