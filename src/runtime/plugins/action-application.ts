import type { RepositoryRecord } from '../../cli/repositories/types';
import type { ProcessHandle } from '../execution/process-runtime/types';
import { startLightweightPluginAction, waitLightweightPluginAction } from './lightweight-action';
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
    }
  | {
      kind: 'direct_non_persistent';
      manifest: AssistantPluginManifest;
      action: AssistantPluginActionDescriptor;
      result: Record<string, unknown>;
    }
  | {
      kind: 'lightweight_running';
      manifest: AssistantPluginManifest;
      action?: AssistantPluginActionDescriptor;
      requestId: string;
      process: ProcessHandle;
    }
  | {
      kind: 'lightweight_failed';
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

  if (input.repository.repoId !== '__controller__' && action?.executionMode === 'lightweight_process') {
    const timeoutMs = Math.max(1_000, input.request.timeoutMs ?? action.defaultTimeoutMs ?? 10 * 60_000);
    let { handle } = await startLightweightPluginAction({
      controllerHome: input.controllerHome,
      repository: input.repository,
      request: input.request,
      interactiveWaitMs: input.interactiveWaitMs,
      timeoutMs,
    });
    if (!handle.completed && input.wait === true) {
      handle = await waitLightweightPluginAction(
        input.controllerHome,
        input.repository.repoId,
        handle.processId,
        Math.max(1, input.waitMs ?? 15_000),
        input.request.signal,
      );
    }
    if (!handle.completed) {
      return {
        kind: 'lightweight_running',
        manifest,
        action,
        requestId: input.request.requestId,
        process: handle,
      };
    }
    if (!handle.ok) {
      return {
        kind: 'lightweight_failed',
        manifest,
        action,
        requestId: input.request.requestId,
        process: handle,
      };
    }
    // The sidecar writes the authoritative receipt. Re-enter the deterministic
    // store with the same request id to read/bind that receipt without replay.
  }

  return {
    kind: 'submitted',
    submitted: await submitAssistantPluginAction(input.controllerHome, input.repository, input.request),
  };
}
