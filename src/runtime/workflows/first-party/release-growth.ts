import { readFileSync } from 'fs';
import { resolve } from 'path';
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

const ASSET_FILES: Record<string, string> = {
  [RELEASE_GROWTH_WORKFLOW_IDS.releaseObservation]: 'appstore.observe-release.v1.draft.json',
  [RELEASE_GROWTH_WORKFLOW_IDS.postMetrics]: 'x.observe-post-metrics.v1.draft.json',
};

const BROWSER_READ_ACTIONS = new Set(['navigate', 'verify_state', 'wait_for_selector', 'query_all', 'get_attribute']);

function assetFile(workflowId: string): string {
  const filename = ASSET_FILES[workflowId];
  if (!filename) throw new Error('RELEASE_GROWTH_WORKFLOW_UNKNOWN');
  return resolve(import.meta.dir, '../../../../assets/workflows/release-growth', filename);
}

export function readReleaseGrowthWorkflowDraft(workflowId: string): WorkflowAssetDraft {
  return JSON.parse(readFileSync(assetFile(workflowId), 'utf8')) as WorkflowAssetDraft;
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
    if (capabilityId.startsWith('browser.')) {
      const actionId = capabilityId.slice('browser.'.length);
      if (BROWSER_READ_ACTIONS.has(actionId)) return { capabilityId, pluginId: 'browser', actionId };
    }
    throw new Error(`RELEASE_GROWTH_CAPABILITY_UNSUPPORTED: ${capabilityId}`);
  });
}

/** Only installs versioned content and exact read-only bindings in the existing Workflow registry. */
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
