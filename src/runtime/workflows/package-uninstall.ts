import { withControllerLock } from '../../effects/controller-locks';
import { deleteControlPlaneRecord } from '../control-plane/persistence/sqlite-store';
import {
  readWorkflowRegistryEntry,
  WORKFLOW_REGISTRY_NAMESPACE,
  type WorkflowRegistryScope,
} from '../control-plane/persistence/workflow-registry-store';
import { readWorkflowPackageInstallation } from './package-installation-store';
import { assertNoActiveWorkflowPackageDependents } from './package-dependencies';
import { assertNoNonterminalWorkflowRuns } from './package-run-safety';

export interface WorkflowPackageUninstallAuthorization {
  canUninstallWorkflows: boolean;
}

export interface WorkflowPackageUninstallResultV1 {
  schemaVersion: 1;
  workflowId: string;
  version: string;
  contentDigest: string;
  packageDigest: string;
  uninstalled: true;
  retainedVersionedContent: true;
  retainedInstallationIdentity: true;
}

function scopeKey(scope: WorkflowRegistryScope): string {
  return scope.kind === 'controller' ? '__controller__' : `project:${scope.projectId}`;
}

function lockScopeKey(scope: WorkflowRegistryScope): string {
  return scope.kind === 'controller' ? 'controller' : `project:${scope.projectId}`;
}

/**
 * Removes the current Registry installation only. Versioned executable/package
 * content and immutable package-installation identity are retained for audit,
 * exact re-install, and run/history safety.
 */
export function uninstallWorkflowPackage(input: {
  controllerHome: string;
  scope: WorkflowRegistryScope;
  workflowId: string;
  expectedRegistryRevision: number;
  authorization: WorkflowPackageUninstallAuthorization;
}): WorkflowPackageUninstallResultV1 {
  if (!input.authorization.canUninstallWorkflows) throw new Error('WORKFLOW_PACKAGE_UNINSTALL_NOT_AUTHORIZED');
  return withControllerLock(
    input.controllerHome,
    {
      scope: 'global',
      resource: `workflow-package-install:${lockScopeKey(input.scope)}:${input.workflowId}`,
    },
    `workflow-package-uninstall:${input.workflowId}`,
    () => {
      const registry = readWorkflowRegistryEntry(input.controllerHome, input.scope, input.workflowId);
      if (!registry) throw new Error('WORKFLOW_PACKAGE_UNINSTALL_NOT_INSTALLED:' + input.workflowId);
      if (registry.revision !== input.expectedRegistryRevision)
        throw new Error('WORKFLOW_PACKAGE_UNINSTALL_REVISION_CONFLICT');
      if (registry.value.status === 'active') throw new Error('WORKFLOW_PACKAGE_UNINSTALL_ACTIVE');
      const installation = readWorkflowPackageInstallation(
        input.controllerHome,
        input.scope,
        registry.value.workflowId,
        registry.value.version,
      );
      if (!installation) throw new Error('WORKFLOW_PACKAGE_UNINSTALL_PACKAGE_IDENTITY_REQUIRED');
      if (
        installation.value.contentDigest !== registry.value.contentDigest ||
        installation.value.workflowId !== registry.value.workflowId ||
        installation.value.version !== registry.value.version
      )
        throw new Error('WORKFLOW_PACKAGE_UNINSTALL_INSTALLATION_IDENTITY_MISMATCH');
      assertNoActiveWorkflowPackageDependents(input.controllerHome, input.scope, registry.value, {
        ignoreInvalidWorkflowId: input.workflowId,
      });
      assertNoNonterminalWorkflowRuns(
        input.controllerHome,
        registry.value,
        'WORKFLOW_PACKAGE_UNINSTALL_NONTERMINAL_RUNS',
      );
      const deleted = deleteControlPlaneRecord(input.controllerHome, {
        namespace: WORKFLOW_REGISTRY_NAMESPACE,
        scope: scopeKey(input.scope),
        key: input.workflowId,
        action: 'workflow_package_uninstall',
        expectedRevision: registry.revision,
      });
      if (!deleted) throw new Error('WORKFLOW_PACKAGE_UNINSTALL_REGISTRY_DELETE_FAILED');
      return {
        schemaVersion: 1,
        workflowId: registry.value.workflowId,
        version: registry.value.version,
        contentDigest: registry.value.contentDigest,
        packageDigest: installation.value.packageDigest,
        uninstalled: true,
        retainedVersionedContent: true,
        retainedInstallationIdentity: true,
      };
    },
  );
}
