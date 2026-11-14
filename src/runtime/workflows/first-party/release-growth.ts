import releaseObservationDraft from '../../../../assets/workflows/release-growth/appstore.observe-release.v1.draft.json';
import postMetricsDraft from '../../../../assets/workflows/release-growth/x.observe-post-metrics.v1.draft.json';
import publishPostDraft from '../../../../assets/workflows/release-growth/x.publish-post.v1.draft.json';
import replyToCommentDraft from '../../../../assets/workflows/release-growth/x.reply-to-comment.v1.draft.json';
import {
  materializeWorkflowAsset, workflowCapabilityDependencies,
  type WorkflowAssetDefinition, type WorkflowAssetDraft,
} from '../../../../packages/workflow-runtime/api/index';
import { writeWorkflowAssetContent } from '../../control-plane/persistence/workflow-content-store';
import {
  readWorkflowRegistryEntry, recordWorkflowBindings, registerWorkflowAsset,
  type WorkflowCapabilityBinding,
} from '../../control-plane/persistence/workflow-registry-store';

export const RELEASE_GROWTH_WORKFLOW_IDS = {
  releaseObservation: 'appstore.observe-release',
  postMetrics: 'x.observe-post-metrics',
} as const;

export const X_EFFECT_WORKFLOW_IDS = {
  publishPost: 'x.publish-post',
  replyToComment: 'x.reply-to-comment',
} as const;

const AUTHORED_DRAFTS: Record<string, unknown> = {
  [RELEASE_GROWTH_WORKFLOW_IDS.releaseObservation]: releaseObservationDraft,
  [RELEASE_GROWTH_WORKFLOW_IDS.postMetrics]: postMetricsDraft,
  [X_EFFECT_WORKFLOW_IDS.publishPost]: publishPostDraft,
  [X_EFFECT_WORKFLOW_IDS.replyToComment]: replyToCommentDraft,
};

const BROWSER_BASE_ACTIONS = new Set(['navigate', 'verify_state', 'wait_for_selector', 'query_all', 'get_attribute', 'get_text']);
const BROWSER_X_WRITE_ACTIONS = new Set(['click', 'fill', 'reconcile_effect']);
const X_WRITE_WORKFLOW_IDS = new Set<string>(Object.values(X_EFFECT_WORKFLOW_IDS));

export function readReleaseGrowthWorkflowDraft(workflowId: string): WorkflowAssetDraft {
  if (!Object.hasOwn(AUTHORED_DRAFTS, workflowId)) throw new Error('RELEASE_GROWTH_WORKFLOW_UNKNOWN');
  return structuredClone(AUTHORED_DRAFTS[workflowId]) as WorkflowAssetDraft;
}

export function materializedReleaseGrowthWorkflow(workflowId: string): WorkflowAssetDefinition {
  return materializeWorkflowAsset(readReleaseGrowthWorkflowDraft(workflowId));
}

/** Map declared executable steps to existing plugin capabilities. No new provider or credential owner. */
function bindingsFor(asset: WorkflowAssetDefinition): WorkflowCapabilityBinding[] {
  return workflowCapabilityDependencies(asset).map((capabilityId) => {
    if (capabilityId === 'asc.list_app_store_versions') {
      return { capabilityId, pluginId: 'app_store_connect', actionId: 'list_app_store_versions' };
    }
    if (capabilityId === 'asc.list_app_territory_availabilities') {
      return { capabilityId, pluginId: 'app_store_connect', actionId: 'list_app_territory_availabilities' };
    }
    if (capabilityId.startsWith('browser.')) {
      const actionId = capabilityId.slice('browser.'.length);
      if (BROWSER_BASE_ACTIONS.has(actionId)
        || (X_WRITE_WORKFLOW_IDS.has(asset.workflowId) && BROWSER_X_WRITE_ACTIONS.has(actionId))) {
        return { capabilityId, pluginId: 'browser', actionId };
      }
    }
    throw new Error(`RELEASE_GROWTH_CAPABILITY_UNSUPPORTED: ${capabilityId}`);
  });
}

/** Installs versioned assets in the existing Workflow registry; X mutations are limited to the two explicit effect workflows. */
export function ensureReleaseGrowthWorkflowInstalled(controllerHome: string, workflowId: string) {
  const written = writeWorkflowAssetContent({ kind: 'controller', controllerHome }, readReleaseGrowthWorkflowDraft(workflowId));
  const scope = { kind: 'controller' } as const;
  const existing = readWorkflowRegistryEntry(controllerHome, scope, workflowId);
  const registered = registerWorkflowAsset({
    controllerHome, scope, asset: written.asset,
    contentLocation: { kind: 'controller', path: written.path },
    status: 'active',
    expectedRevision: existing?.revision ?? null,
  });
  return recordWorkflowBindings({
    controllerHome, scope, expectedIdentity: written.asset,
    bindings: bindingsFor(written.asset),
    expectedRevision: registered.revision,
  });
}
