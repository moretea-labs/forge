import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginCapability,
  AssistantPluginHealth,
  AssistantPluginManifest,
  AssistantPluginPermissionScope,
} from './types';
import { AssistantPluginError } from './errors';
import {
  materializedXiaohongshuWorkflow,
  translateXiaohongshuPublishToWorkflow,
  type XiaohongshuWorkflowInvocation,
} from '../workflows/first-party/xiaohongshu';

const PLUGIN_ID = 'xiaohongshu';
const PROVIDER = 'xiaohongshu-workflow-compatibility';

function now(): string { return new Date().toISOString(); }

function invocation(args: Record<string, unknown>): XiaohongshuWorkflowInvocation {
  try {
    return translateXiaohongshuPublishToWorkflow(args);
  } catch (error) {
    throw new AssistantPluginError(
      'PLUGIN_ACTION_ARGUMENT_INVALID',
      error instanceof Error ? error.message : String(error),
      { retryable: false },
    );
  }
}

/**
 * Compatibility projection only. Platform URLs, selectors, login markers,
 * sequencing, verification and effect reconciliation live in the authored
 * Workflow asset. This adapter never dispatches Browser actions.
 */
export function buildXiaohongshuPublishRecipe(args: Record<string, unknown>): Record<string, unknown> {
  const translated = invocation(args);
  const asset = materializedXiaohongshuWorkflow(translated.workflowId);
  return {
    schemaVersion: 1,
    provider: PROVIDER,
    workflowId: asset.workflowId,
    workflowVersion: asset.version,
    workflowContentDigest: asset.contentDigest,
    registryScope: translated.registryScope,
    normalizedMode: translated.normalizedMode,
    generationRequired: translated.generationRequired,
    inputs: translated.inputs,
    execution: {
      tool: 'rh_work',
      operation: 'workflow_execute',
      requiredRuntimeFields: ['work_id', 'workflow_run_id', 'controller_authority_id', 'relay_scope_id'],
      workflow_id: asset.workflowId,
      workflow_inputs: translated.inputs,
    },
    ...(translated.generationRequired ? {
      generationHandoff: {
        status: 'required',
        requiredInput: 'image_paths',
        minImages: 1,
        maxImages: 18,
        resumeAction: 'publish_note',
        resumeMode: 'generated_image_note',
      },
    } : {}),
  };
}

export async function executeXiaohongshuPluginAction(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  if (input.actionId !== 'get_publish_recipe' && input.actionId !== 'publish_note') {
    throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', `xiaohongshu/${input.actionId} is not supported.`, { retryable: false });
  }
  const recipe = buildXiaohongshuPublishRecipe(input.args);
  if (input.actionId === 'get_publish_recipe') return recipe;
  return {
    ...recipe,
    status: recipe.generationRequired === true ? 'generation_required' : 'workflow_required',
    next: recipe.generationRequired === true
      ? 'Generate one or more image files and request the same compatibility translation with image_paths.'
      : 'Execute the returned Workflow through rh_work workflow_execute under the exact claimed Work/controller authority.',
  };
}

function health(): AssistantPluginHealth {
  return {
    state: 'ready', checkedAt: now(), ready: true, probed: true, errors: [],
    warnings: ['This compatibility adapter is read-only. Xiaohongshu external effects are owned exclusively by the versioned Workflow Runtime and generic Browser capabilities.'],
    details: { workflowRuntimeRequired: true, browserSessionRequired: true },
  };
}

function permissions(): AssistantPluginPermissionScope[] {
  return [{
    scope: 'xiaohongshu.recipe', mode: 'read',
    description: 'Translate legacy Xiaohongshu publish inputs into the canonical first-party Workflow invocation.',
    granted: true, required: true,
  }];
}

function capabilities(): AssistantPluginCapability[] {
  return [{
    capabilityId: 'xiaohongshu-workflow-compatibility',
    title: 'Xiaohongshu Workflow Compatibility',
    description: 'Read-only translation into versioned first-party Workflow assets. It does not own publishing effects.',
    scopes: ['xiaohongshu.recipe'],
    actions: ['get_publish_recipe', 'publish_note'],
  }];
}

function recipeSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['image_note', 'generated_image_note', 'long_text'] },
      session_id: { type: 'string' },
      account: { type: 'string' },
      profile_url: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
      image_paths: { type: 'array', maxItems: 18, items: { type: 'string' } },
      summary: { type: 'string' },
      template_text: { type: 'string' },
    },
    required: ['mode', 'session_id', 'profile_url', 'title', 'body'],
    additionalProperties: false,
  };
}

function actions(): AssistantPluginActionDescriptor[] {
  const schema = recipeSchema();
  return [
    {
      actionId: 'get_publish_recipe', title: 'Resolve publish Workflow',
      description: 'Translate inputs to the immutable first-party Xiaohongshu Workflow identity and typed inputs without executing Browser effects.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 15_000, cancellable: true, idempotent: true,
      scopes: ['xiaohongshu.recipe'], resourceClaims: [], argumentsSchema: schema,
    },
    {
      actionId: 'publish_note', title: 'Translate legacy publish request',
      description: 'Compatibility-only alias that returns the canonical rh_work workflow_execute invocation. It never publishes directly.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 15_000, cancellable: true, idempotent: true,
      scopes: ['xiaohongshu.recipe'], resourceClaims: [], argumentsSchema: schema,
    },
  ];
}

export function buildXiaohongshuPluginManifest(previousRevision = 0, previousUpdatedAt?: string): AssistantPluginManifest {
  return {
    schemaVersion: 1, manifestVersion: 1, revision: Math.max(1, previousRevision || 1),
    pluginId: PLUGIN_ID, provider: PROVIDER, displayName: 'Xiaohongshu Workflow Compatibility', pluginVersion: '2.0.0',
    authority: {
      strategy: 'derived', duplicateStateAllowed: false,
      sourceOfTruth: [
        'source:assets/workflows/xiaohongshu/*.draft.json',
        'source:src/runtime/workflows/first-party/xiaohongshu.ts',
        'browser-profile:authentication-and-session',
      ],
    },
    enabled: true,
    lifecycle: { state: 'enabled', reason: 'Compatibility translation is available; all publishing effects are Workflow-owned.' },
    health: health(), permissions: permissions(), capabilities: capabilities(), actions: actions(), updatedAt: previousUpdatedAt ?? now(),
  };
}

export const xiaohongshuPluginAdapter = {
  pluginId: PLUGIN_ID,
  buildManifest: buildXiaohongshuPluginManifest,
  executeAction: executeXiaohongshuPluginAction,
};
