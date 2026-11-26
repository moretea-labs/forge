import type { WorkflowAssetContentLocation } from '../control-plane/persistence/workflow-content-store';
import type { WorkflowRegistryScope } from '../control-plane/persistence/workflow-registry-store';

/** Package content and Registry authority must describe the same ownership scope. */
export function assertWorkflowPackageLocationMatchesScope(
  scope: WorkflowRegistryScope,
  location: WorkflowAssetContentLocation,
): void {
  if (scope.kind === 'controller') {
    if (location.kind !== 'controller') throw new Error('WORKFLOW_PACKAGE_LOCATION_SCOPE_MISMATCH');
    return;
  }
  if (location.kind !== 'project') throw new Error('WORKFLOW_PACKAGE_LOCATION_SCOPE_MISMATCH');
  if (location.contract.projectId !== scope.projectId) {
    throw new Error('WORKFLOW_PACKAGE_LOCATION_PROJECT_MISMATCH');
  }
}
