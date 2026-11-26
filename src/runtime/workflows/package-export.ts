import {
  materializeWorkflowPackageBundle,
  type WorkflowPackageBundleMetadata,
  type WorkflowPackageBundleV1,
} from '../../../packages/workflow-runtime/domain/workflow-package-bundle';
import { workflowFeatureChildWorkflowDependencies } from '../../../packages/workflow-runtime/domain/workflow-feature';
import { readWorkflowExecutableContentFile } from '../control-plane/persistence/workflow-content-store';
import {
  readWorkflowRegistryEntry,
  type WorkflowRegistryScope,
} from '../control-plane/persistence/workflow-registry-store';

/**
 * Export is read-only. Child Workflow dependencies are locked to the exact
 * installed version/content digest so importing the bundle cannot drift silently.
 */
export function exportInstalledWorkflowPackage(input: {
  controllerHome: string;
  scope: WorkflowRegistryScope;
  workflowId: string;
  metadata: Omit<WorkflowPackageBundleMetadata, 'requiredWorkflows'>;
}): WorkflowPackageBundleV1 {
  const registry = readWorkflowRegistryEntry(input.controllerHome, input.scope, input.workflowId);
  if (!registry) throw new Error('WORKFLOW_PACKAGE_EXPORT_NOT_INSTALLED:' + input.workflowId);
  const asset = readWorkflowExecutableContentFile(registry.value.contentLocation.path);
  if (
    asset.workflowId !== registry.value.workflowId ||
    asset.version !== registry.value.version ||
    asset.contentDigest !== registry.value.contentDigest
  )
    throw new Error('WORKFLOW_PACKAGE_EXPORT_CONTENT_IDENTITY_MISMATCH');
  const requiredWorkflows = workflowFeatureChildWorkflowDependencies(asset).map((workflowId) => {
    const child = readWorkflowRegistryEntry(input.controllerHome, input.scope, workflowId);
    if (!child) throw new Error('WORKFLOW_PACKAGE_EXPORT_CHILD_NOT_INSTALLED:' + workflowId);
    return {
      workflowId,
      version: child.value.version,
      contentDigest: child.value.contentDigest,
    };
  });
  return materializeWorkflowPackageBundle(asset, {
    ...input.metadata,
    requiredWorkflows,
  });
}
