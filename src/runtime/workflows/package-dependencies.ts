import type { WorkflowRegistryScope } from '../control-plane/persistence/workflow-registry-store';
import { listWorkflowDiscoveryCatalog } from './package-catalog';

export interface WorkflowPackageDependencyIdentity {
  workflowId: string;
  version: string;
  contentDigest: string;
}

function dependencyMatches(
  dependency: { workflowId: string; version?: string; contentDigest?: string },
  identity: WorkflowPackageDependencyIdentity,
): boolean {
  if (dependency.workflowId !== identity.workflowId) return false;
  if (dependency.version !== undefined && dependency.version !== identity.version) return false;
  if (dependency.contentDigest !== undefined && dependency.contentDigest !== identity.contentDigest) return false;
  return true;
}

/** Active packaged parents whose exact dependency contract currently points at this identity. */
export function listActiveWorkflowPackageDependents(
  controllerHome: string,
  scope: WorkflowRegistryScope,
  identity: WorkflowPackageDependencyIdentity,
): string[] {
  return listWorkflowDiscoveryCatalog(controllerHome, scope)
    .filter(
      (entry) =>
        entry.workflow.status === 'active' &&
        entry.package?.requiredWorkflows.some((dependency) => dependencyMatches(dependency, identity)),
    )
    .map((entry) => entry.workflow.descriptor.workflowId)
    .sort();
}

export function assertNoActiveWorkflowPackageDependents(
  controllerHome: string,
  scope: WorkflowRegistryScope,
  identity: WorkflowPackageDependencyIdentity,
  options: { ignoreInvalidWorkflowId?: string } = {},
): void {
  const catalog = listWorkflowDiscoveryCatalog(controllerHome, scope);
  const invalidActive = catalog
    .filter(
      (entry) =>
        entry.workflow.status === 'active' &&
        entry.packageStatus === 'invalid' &&
        entry.workflow.descriptor.workflowId !== options.ignoreInvalidWorkflowId,
    )
    .map((entry) => entry.workflow.descriptor.workflowId)
    .sort();
  if (invalidActive.length > 0) {
    throw new Error(`WORKFLOW_PACKAGE_DEPENDENCY_GRAPH_INVALID:${invalidActive.join(',')}`);
  }
  const dependents = catalog
    .filter(
      (entry) =>
        entry.workflow.status === 'active' &&
        entry.package?.requiredWorkflows.some((dependency) => dependencyMatches(dependency, identity)),
    )
    .map((entry) => entry.workflow.descriptor.workflowId)
    .sort();
  if (dependents.length > 0) {
    throw new Error(`WORKFLOW_PACKAGE_ACTIVE_DEPENDENTS:${identity.workflowId}:${dependents.join(',')}`);
  }
}
