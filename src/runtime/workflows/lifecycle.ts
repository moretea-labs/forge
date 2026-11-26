import { existsSync } from 'fs';
import { dirname, join } from 'path';
import {
  readWorkflowRegistryEntry,
  setWorkflowRegistryStatus,
  type WorkflowRegistryScope,
} from '../control-plane/persistence/workflow-registry-store';
import type { WorkflowPackageActivationApprovalProof } from './package-approval';
import { readWorkflowPackageInstallation } from './package-installation-store';
import { activateWorkflowPackage, deactivateWorkflowPackage } from './package-lifecycle';

export interface WorkflowLifecycleAuthorization {
  canActivateWorkflows: boolean;
  approval?: WorkflowPackageActivationApprovalProof;
}

export interface WorkflowLifecycleResultV1 {
  schemaVersion: 1;
  workflowId: string;
  status: 'active' | 'inactive';
  mode: 'packaged' | 'legacy';
  registryRevision: number;
  packageDigest?: string;
}

function packagePathFor(contentPath: string): string {
  return join(dirname(contentPath), 'package.json');
}

export function workflowLifecycleMode(
  controllerHome: string,
  scope: WorkflowRegistryScope,
  workflowId: string,
): 'packaged' | 'legacy' {
  const registry = readWorkflowRegistryEntry(controllerHome, scope, workflowId);
  if (!registry) throw new Error('WORKFLOW_LIFECYCLE_NOT_INSTALLED:' + workflowId);
  const installation = readWorkflowPackageInstallation(
    controllerHome,
    scope,
    registry.value.workflowId,
    registry.value.version,
  );
  return installation || existsSync(packagePathFor(registry.value.contentLocation.path)) ? 'packaged' : 'legacy';
}

/**
 * Single lifecycle owner for public callers. Packaged Workflows can never fall
 * through to the legacy Registry setter and thereby bypass package checks.
 */
export function setWorkflowLifecycle(input: {
  controllerHome: string;
  scope: WorkflowRegistryScope;
  workflowId: string;
  status: 'active' | 'inactive';
  runtimeVersion?: string;
  expectedRegistryRevision?: number;
  authorization: WorkflowLifecycleAuthorization;
}): WorkflowLifecycleResultV1 {
  if (!input.authorization.canActivateWorkflows) throw new Error('WORKFLOW_LIFECYCLE_NOT_AUTHORIZED');
  const registry = readWorkflowRegistryEntry(input.controllerHome, input.scope, input.workflowId);
  if (!registry) throw new Error('WORKFLOW_LIFECYCLE_NOT_INSTALLED:' + input.workflowId);
  if (input.expectedRegistryRevision !== undefined && registry.revision !== input.expectedRegistryRevision) {
    throw new Error('WORKFLOW_LIFECYCLE_REVISION_CONFLICT');
  }
  const installation = readWorkflowPackageInstallation(
    input.controllerHome,
    input.scope,
    registry.value.workflowId,
    registry.value.version,
  );
  const mode = installation || existsSync(packagePathFor(registry.value.contentLocation.path)) ? 'packaged' : 'legacy';
  if (mode === 'packaged') {
    if (input.status === 'active') {
      if (!input.runtimeVersion) throw new Error('WORKFLOW_LIFECYCLE_RUNTIME_VERSION_REQUIRED');
      const activated = activateWorkflowPackage({
        controllerHome: input.controllerHome,
        scope: input.scope,
        workflowId: input.workflowId,
        runtimeVersion: input.runtimeVersion,
        authorization: input.authorization,
      });
      return {
        schemaVersion: 1,
        workflowId: activated.workflowId,
        status: activated.status,
        mode,
        registryRevision: activated.registryRevision,
        packageDigest: activated.packageDigest,
      };
    }
    const deactivated = deactivateWorkflowPackage({
      controllerHome: input.controllerHome,
      scope: input.scope,
      workflowId: input.workflowId,
      authorization: input.authorization,
    });
    return {
      schemaVersion: 1,
      workflowId: deactivated.workflowId,
      status: deactivated.status,
      mode,
      registryRevision: deactivated.registryRevision,
      packageDigest: deactivated.packageDigest,
    };
  }

  if (registry.value.status === input.status) {
    return {
      schemaVersion: 1,
      workflowId: registry.value.workflowId,
      status: input.status,
      mode,
      registryRevision: registry.revision,
    };
  }
  const changed = setWorkflowRegistryStatus({
    controllerHome: input.controllerHome,
    scope: input.scope,
    workflowId: input.workflowId,
    status: input.status,
    expectedRevision: registry.revision,
  });
  return {
    schemaVersion: 1,
    workflowId: changed.value.workflowId,
    status: input.status,
    mode,
    registryRevision: changed.revision,
  };
}
