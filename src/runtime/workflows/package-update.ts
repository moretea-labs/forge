import { existsSync, rmSync } from 'fs';
import { withControllerLock } from '../../effects/controller-locks';
import type {
  WorkflowAssetDefinition,
  WorkflowAssetDraft,
} from '../../../packages/workflow-runtime/domain/workflow-asset';
import type {
  WorkflowGraphAssetDefinition,
  WorkflowGraphAssetDraft,
} from '../../../packages/workflow-runtime/domain/workflow-graph';
import {
  validateWorkflowPackageBundle,
  type WorkflowPackageBundleV1,
} from '../../../packages/workflow-runtime/domain/workflow-package-bundle';
import {
  readWorkflowRegistryEntry,
  registerWorkflowFeatureAsset,
  type WorkflowRegistryScope,
} from '../control-plane/persistence/workflow-registry-store';
import {
  writeWorkflowAssetContent,
  writeWorkflowGraphAssetContent,
  type WorkflowAssetContentLocation,
} from '../control-plane/persistence/workflow-content-store';
import { writeWorkflowPackageBundleContent, workflowPackageContentPath } from './package-content-store';
import { assertWorkflowPackageExecutableTarget } from './package-content-guard';
import { assertNoActiveWorkflowPackageDependents } from './package-dependencies';
import { preflightWorkflowPackageImport } from './package-import';
import { assertWorkflowPackageLocationMatchesScope } from './package-location';
import { recordWorkflowPackageInstallation } from './package-installation-store';

export interface WorkflowPackageUpdateAuthorization {
  canUpdateWorkflows: boolean;
}

export interface WorkflowPackageUpdateResultV1 {
  schemaVersion: 1;
  workflowId: string;
  previousVersion: string;
  previousContentDigest: string;
  version: string;
  contentDigest: string;
  registryRevision: number;
  lifecycleStatus: 'installed';
  activation: 'required';
  bindingsReset: true;
  contentPath: string;
  packagePath: string;
}

function scopeKey(scope: WorkflowRegistryScope): string {
  return scope.kind === 'controller' ? 'controller' : `project:${scope.projectId}`;
}

function sequenceDraft(asset: WorkflowAssetDefinition): WorkflowAssetDraft {
  const { contentDigest: _contentDigest, ...draft } = asset;
  return structuredClone(draft);
}

function graphDraft(asset: WorkflowGraphAssetDefinition): WorkflowGraphAssetDraft {
  const { contentDigest: _contentDigest, ...draft } = asset;
  return structuredClone(draft);
}

function writeExecutable(location: WorkflowAssetContentLocation, bundle: WorkflowPackageBundleV1) {
  return bundle.asset.schemaVersion === 1
    ? writeWorkflowAssetContent(location, sequenceDraft(bundle.asset))
    : writeWorkflowGraphAssetContent(location, graphDraft(bundle.asset));
}

type WorkflowPackageUpdateInput = {
  controllerHome: string;
  scope: WorkflowRegistryScope;
  location: WorkflowAssetContentLocation;
  workflowId: string;
  bundle: unknown;
  runtimeVersion: string;
  expectedRegistryRevision: number;
  authorization: WorkflowPackageUpdateAuthorization;
};

type WorkflowRegistryRecord = NonNullable<ReturnType<typeof readWorkflowRegistryEntry>>;

function validateUpdateIdentity(
  input: WorkflowPackageUpdateInput,
  bundle: WorkflowPackageBundleV1,
): WorkflowRegistryRecord {
  const existing = readWorkflowRegistryEntry(input.controllerHome, input.scope, input.workflowId);
  if (!existing) throw new Error('WORKFLOW_PACKAGE_UPDATE_NOT_INSTALLED:' + input.workflowId);
  if (existing.revision !== input.expectedRegistryRevision)
    throw new Error('WORKFLOW_PACKAGE_UPDATE_REVISION_CONFLICT');
  if (
    existing.value.version === bundle.manifest.workflowVersion &&
    existing.value.contentDigest === bundle.manifest.contentDigest
  ) {
    throw new Error('WORKFLOW_PACKAGE_UPDATE_IDENTITY_UNCHANGED');
  }
  if (existing.value.version === bundle.manifest.workflowVersion) {
    throw new Error('WORKFLOW_PACKAGE_UPDATE_VERSION_CONTENT_CONFLICT');
  }
  assertNoActiveWorkflowPackageDependents(input.controllerHome, input.scope, existing.value);
  return existing;
}

function validateUpdatePreflight(input: WorkflowPackageUpdateInput, bundle: WorkflowPackageBundleV1): void {
  const preflight = preflightWorkflowPackageImport({
    controllerHome: input.controllerHome,
    scope: input.scope,
    bundle,
    runtimeVersion: input.runtimeVersion,
  });
  const blockingIssues = preflight.issues.filter(
    (issue) => issue.code !== 'WORKFLOW_PACKAGE_EXISTING_IDENTITY_CONFLICT',
  );
  if (blockingIssues.length > 0) {
    throw new Error('WORKFLOW_PACKAGE_UPDATE_PREFLIGHT_FAILED:' + blockingIssues.map((issue) => issue.code).join('|'));
  }
}

function persistUpdate(
  input: WorkflowPackageUpdateInput,
  bundle: WorkflowPackageBundleV1,
  existing: WorkflowRegistryRecord,
): WorkflowPackageUpdateResultV1 {
  const executableTarget = assertWorkflowPackageExecutableTarget(input.location, bundle);
  const packagePath = workflowPackageContentPath(
    input.location,
    bundle.manifest.workflowId,
    bundle.manifest.workflowVersion,
  );
  const packageExisted = existsSync(packagePath);
  const written = writeExecutable(input.location, bundle);
  let packageContent: ReturnType<typeof writeWorkflowPackageBundleContent> | undefined;
  try {
    packageContent = writeWorkflowPackageBundleContent(input.location, bundle);
    recordWorkflowPackageInstallation({
      controllerHome: input.controllerHome,
      scope: input.scope,
      workflowId: bundle.manifest.workflowId,
      version: bundle.manifest.workflowVersion,
      contentDigest: bundle.manifest.contentDigest,
      packageDigest: bundle.manifest.packageDigest,
      contentPath: written.path,
      packagePath: packageContent.path,
    });
    const registered = registerWorkflowFeatureAsset({
      controllerHome: input.controllerHome,
      scope: input.scope,
      asset: written.asset,
      contentLocation: {
        kind: input.location.kind,
        path: written.path,
        ...(input.location.kind === 'project' ? { projectId: input.location.contract.projectId } : {}),
      },
      status: 'installed',
      expectedRevision: existing.revision,
    });
    return {
      schemaVersion: 1,
      workflowId: registered.value.workflowId,
      previousVersion: existing.value.version,
      previousContentDigest: existing.value.contentDigest,
      version: registered.value.version,
      contentDigest: registered.value.contentDigest,
      registryRevision: registered.revision,
      lifecycleStatus: 'installed',
      activation: 'required',
      bindingsReset: true,
      contentPath: written.path,
      packagePath: packageContent.path,
    };
  } catch (error) {
    if (!executableTarget.existed) rmSync(written.path, { force: true });
    if (!packageExisted && packageContent) rmSync(packageContent.path, { force: true });
    throw error;
  }
}

/**
 * Switches the installed Workflow identity to a new package version. Existing
 * Runs are insulated by immutable execution snapshots and keep their exact old
 * content/bindings; versioned content is retained. The new identity is always
 * installed (not active) and capability bindings are reset.
 */
export function updateWorkflowPackage(input: WorkflowPackageUpdateInput): WorkflowPackageUpdateResultV1 {
  if (!input.authorization.canUpdateWorkflows) throw new Error('WORKFLOW_PACKAGE_UPDATE_NOT_AUTHORIZED');
  assertWorkflowPackageLocationMatchesScope(input.scope, input.location);
  const bundle = validateWorkflowPackageBundle(input.bundle);
  if (bundle.manifest.workflowId !== input.workflowId) throw new Error('WORKFLOW_PACKAGE_UPDATE_WORKFLOW_ID_MISMATCH');
  const resource = `workflow-package-install:${scopeKey(input.scope)}:${input.workflowId}`;
  return withControllerLock(
    input.controllerHome,
    { scope: 'global', resource },
    `workflow-package-update:${input.workflowId}`,
    () => {
      const existing = validateUpdateIdentity(input, bundle);
      validateUpdatePreflight(input, bundle);
      return persistUpdate(input, bundle, existing);
    },
  );
}
