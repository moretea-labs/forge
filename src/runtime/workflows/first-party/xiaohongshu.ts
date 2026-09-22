import { readFileSync } from 'fs';
import { resolve } from 'path';
import { materializeWorkflowAsset, type WorkflowAssetDefinition, type WorkflowAssetDraft, type WorkflowJsonValue } from '../../../../packages/workflow-runtime/api/index';
import { writeWorkflowAssetContent } from '../../control-plane/persistence/workflow-content-store';
import { readWorkflowRegistryEntry, recordWorkflowBindings, registerWorkflowAsset, type WorkflowCapabilityBinding } from '../../control-plane/persistence/workflow-registry-store';

export const XIAOHONGSHU_WORKFLOW_IDS = {
  imageNote: 'xiaohongshu.publish-image-note',
  longText: 'xiaohongshu.publish-long-text',
  metrics: 'xiaohongshu.collect-metrics',
} as const;

export type XiaohongshuPublishMode = 'image_note' | 'generated_image_note' | 'long_text';

const ASSET_FILES: Record<string, string> = {
  [XIAOHONGSHU_WORKFLOW_IDS.imageNote]: 'xiaohongshu.publish-image-note.v1.draft.json',
  [XIAOHONGSHU_WORKFLOW_IDS.longText]: 'xiaohongshu.publish-long-text.v1.draft.json',
  [XIAOHONGSHU_WORKFLOW_IDS.metrics]: 'xiaohongshu.collect-metrics.v1.draft.json',
};

function assetPath(workflowId: string): string {
  const filename = ASSET_FILES[workflowId];
  if (!filename) throw new Error(`XHS_WORKFLOW_UNKNOWN: ${workflowId}`);
  return resolve(import.meta.dir, '../../../../assets/workflows/xiaohongshu', filename);
}

export function readAuthoredXiaohongshuWorkflowDraft(workflowId: string): WorkflowAssetDraft {
  const parsed = JSON.parse(readFileSync(assetPath(workflowId), 'utf8')) as WorkflowAssetDraft;
  return parsed;
}

export function materializedXiaohongshuWorkflow(workflowId: string): WorkflowAssetDefinition {
  return materializeWorkflowAsset(readAuthoredXiaohongshuWorkflowDraft(workflowId));
}

function browserBindings(asset: WorkflowAssetDefinition): WorkflowCapabilityBinding[] {
  return (asset.requiredCapabilities ?? []).map((capabilityId) => {
    if (!capabilityId.startsWith('browser.')) throw new Error(`XHS_WORKFLOW_CAPABILITY_UNSUPPORTED: ${capabilityId}`);
    const actionId = capabilityId.slice('browser.'.length);
    if (!actionId) throw new Error(`XHS_WORKFLOW_CAPABILITY_INVALID: ${capabilityId}`);
    return { capabilityId, pluginId: 'browser', actionId };
  });
}

/**
 * Materialize authored first-party content into Controller Home and bind only
 * generic Browser capabilities. This is idempotent and never owns Browser auth.
 */
export function ensureXiaohongshuWorkflowInstalled(controllerHome: string, workflowId: string) {
  const draft = readAuthoredXiaohongshuWorkflowDraft(workflowId);
  const written = writeWorkflowAssetContent({ kind: 'controller', controllerHome }, draft);
  const scope = { kind: 'controller' } as const;
  const existing = readWorkflowRegistryEntry(controllerHome, scope, workflowId);
  const registered = registerWorkflowAsset({
    controllerHome,
    scope,
    asset: written.asset,
    contentLocation: { kind: 'controller', path: written.path },
    status: 'active',
    expectedRevision: existing?.revision ?? null,
  });
  return recordWorkflowBindings({
    controllerHome,
    scope,
    expectedIdentity: written.asset,
    bindings: browserBindings(written.asset),
    expectedRevision: registered.revision,
  });
}

export function ensureAllXiaohongshuWorkflowsInstalled(controllerHome: string): void {
  for (const workflowId of Object.values(XIAOHONGSHU_WORKFLOW_IDS)) ensureXiaohongshuWorkflowInstalled(controllerHome, workflowId);
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`XHS_${label.toUpperCase()}_REQUIRED`);
  return value.trim();
}

function imagePaths(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim()) || value.length > 18) {
    throw new Error('XHS_IMAGE_PATHS_INVALID');
  }
  return value.map((entry) => String(entry).trim());
}

export interface XiaohongshuWorkflowInvocation {
  workflowId: string;
  registryScope: { kind: 'controller' };
  inputs: Record<string, WorkflowJsonValue>;
  generationRequired: boolean;
  normalizedMode: 'image_note' | 'long_text';
}

/** Compatibility translation only. It never dispatches Browser effects. */
export function translateXiaohongshuPublishToWorkflow(args: Record<string, unknown>): XiaohongshuWorkflowInvocation {
  const mode = args.mode;
  if (mode !== 'image_note' && mode !== 'generated_image_note' && mode !== 'long_text') throw new Error('XHS_MODE_INVALID');
  const normalizedMode = mode === 'long_text' ? 'long_text' : 'image_note';
  const paths = imagePaths(args.image_paths);
  if (mode === 'image_note' && paths.length < 1) throw new Error('XHS_IMAGE_PATHS_REQUIRED');
  const profileUrl = text(args.profile_url, 'profile_url');
  const account = typeof args.account === 'string' && args.account.trim() ? args.account.trim() : profileUrl;
  const generationRequired = mode === 'generated_image_note' && paths.length === 0;
  return {
    workflowId: normalizedMode === 'long_text' ? XIAOHONGSHU_WORKFLOW_IDS.longText : XIAOHONGSHU_WORKFLOW_IDS.imageNote,
    registryScope: { kind: 'controller' },
    generationRequired,
    normalizedMode,
    inputs: {
      account,
      session_id: text(args.session_id, 'session_id'),
      profile_url: profileUrl,
      title: text(args.title, 'title'),
      body: text(args.body, 'body'),
      image_paths: paths,
      ...(typeof args.summary === 'string' && args.summary.trim() ? { summary: args.summary.trim() } : {}),
      ...(typeof args.template_text === 'string' && args.template_text.trim() ? { template_text: args.template_text.trim() } : {}),
    },
  };
}
