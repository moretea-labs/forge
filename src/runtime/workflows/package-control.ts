import type {
  WorkflowPackageBundleV1,
  WorkflowPackageBundleMetadata,
} from '../../../packages/workflow-runtime/domain/workflow-package-bundle';
import type { WorkflowRegistryScope } from '../control-plane/persistence/workflow-registry-store';
import type { WorkflowAssetContentLocation } from '../control-plane/persistence/workflow-content-store';
import {
  listWorkflowDiscoveryCatalog,
  searchWorkflowDiscoveryCatalog,
  type WorkflowDiscoveryQueryV1,
} from './package-catalog';
import { exportInstalledWorkflowPackage } from './package-export';
import { preflightWorkflowPackageImport } from './package-import';
import { installWorkflowPackage, type WorkflowPackageInstallAuthorization } from './package-install';
import { updateWorkflowPackage, type WorkflowPackageUpdateAuthorization } from './package-update';
import { uninstallWorkflowPackage, type WorkflowPackageUninstallAuthorization } from './package-uninstall';

export type WorkflowPackageControlRequest =
  | { action: 'list'; scope: WorkflowRegistryScope }
  | { action: 'search'; scope: WorkflowRegistryScope; query: WorkflowDiscoveryQueryV1 }
  | { action: 'preflight'; scope: WorkflowRegistryScope; bundle: unknown; runtimeVersion: string }
  | {
      action: 'install';
      scope: WorkflowRegistryScope;
      location: WorkflowAssetContentLocation;
      bundle: unknown;
      runtimeVersion: string;
      authorization: WorkflowPackageInstallAuthorization;
    }
  | {
      action: 'update';
      scope: WorkflowRegistryScope;
      location: WorkflowAssetContentLocation;
      workflowId: string;
      bundle: unknown;
      runtimeVersion: string;
      expectedRegistryRevision: number;
      authorization: WorkflowPackageUpdateAuthorization;
    }
  | {
      action: 'uninstall';
      scope: WorkflowRegistryScope;
      workflowId: string;
      expectedRegistryRevision: number;
      authorization: WorkflowPackageUninstallAuthorization;
    }
  | {
      action: 'export';
      scope: WorkflowRegistryScope;
      workflowId: string;
      metadata: Omit<WorkflowPackageBundleMetadata, 'requiredWorkflows'>;
    };

export type WorkflowPackageControlResult =
  | { action: 'list'; entries: ReturnType<typeof listWorkflowDiscoveryCatalog> }
  | { action: 'search'; entries: ReturnType<typeof searchWorkflowDiscoveryCatalog> }
  | { action: 'preflight'; preflight: ReturnType<typeof preflightWorkflowPackageImport> }
  | { action: 'install'; install: ReturnType<typeof installWorkflowPackage> }
  | { action: 'update'; update: ReturnType<typeof updateWorkflowPackage> }
  | { action: 'uninstall'; uninstall: ReturnType<typeof uninstallWorkflowPackage> }
  | { action: 'export'; bundle: WorkflowPackageBundleV1 };

/**
 * First-class Workflow package service boundary. Adapters (MCP/CLI/Client/model)
 * delegate here; this service intentionally exposes no activate/deactivate/execute action.
 */
export function executeWorkflowPackageControl(
  controllerHome: string,
  request: WorkflowPackageControlRequest,
): WorkflowPackageControlResult {
  switch (request.action) {
    case 'list':
      return { action: 'list', entries: listWorkflowDiscoveryCatalog(controllerHome, request.scope) };
    case 'search':
      return {
        action: 'search',
        entries: searchWorkflowDiscoveryCatalog(controllerHome, request.scope, request.query),
      };
    case 'preflight':
      return {
        action: 'preflight',
        preflight: preflightWorkflowPackageImport({
          controllerHome,
          scope: request.scope,
          bundle: request.bundle,
          runtimeVersion: request.runtimeVersion,
        }),
      };
    case 'install':
      return {
        action: 'install',
        install: installWorkflowPackage({
          controllerHome,
          scope: request.scope,
          location: request.location,
          bundle: request.bundle,
          runtimeVersion: request.runtimeVersion,
          authorization: request.authorization,
        }),
      };
    case 'update':
      return {
        action: 'update',
        update: updateWorkflowPackage({
          controllerHome,
          scope: request.scope,
          location: request.location,
          workflowId: request.workflowId,
          bundle: request.bundle,
          runtimeVersion: request.runtimeVersion,
          expectedRegistryRevision: request.expectedRegistryRevision,
          authorization: request.authorization,
        }),
      };
    case 'uninstall':
      return {
        action: 'uninstall',
        uninstall: uninstallWorkflowPackage({
          controllerHome,
          scope: request.scope,
          workflowId: request.workflowId,
          expectedRegistryRevision: request.expectedRegistryRevision,
          authorization: request.authorization,
        }),
      };
    case 'export':
      return {
        action: 'export',
        bundle: exportInstalledWorkflowPackage({
          controllerHome,
          scope: request.scope,
          workflowId: request.workflowId,
          metadata: request.metadata,
        }),
      };
  }
}
