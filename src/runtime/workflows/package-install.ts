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
import { preflightWorkflowPackageImport } from './package-import';
import { assertWorkflowPackageLocationMatchesScope } from './package-location';
import { recordWorkflowPackageInstallation } from './package-installation-store';

export interface WorkflowPackageInstallAuthorization {
  canInstallWorkflows: boolean;
}

export interface WorkflowPackageInstallResultV1 {
  schemaVersion: 1;
  workflowId: string;
  version: string;
  contentDigest: string;
  registryRevision: number;
  lifecycleStatus: 'installed' | 'active' | 'inactive';
  packagePath: string;
  contentPath: string;
  activation: 'not_requested';
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

type WorkflowPackageInstallInput = {
  controllerHome: string;
  scope: WorkflowRegistryScope;
  location: WorkflowAssetContentLocation;
  bundle: unknown;
  runtimeVersion: string;
  authorization: WorkflowPackageInstallAuthorization;
};

type WorkflowRegistryRecord = NonNullable<ReturnType<typeof readWorkflowRegistryEntry>>;

function validateInstallPreflight(
  input: WorkflowPackageInstallInput,
  bundle: WorkflowPackageBundleV1,
): WorkflowRegistryRecord | undefined {
  const preflight = preflightWorkflowPackageImport({
    controllerHome: input.controllerHome,
    scope: input.scope,
    bundle,
    runtimeVersion: input.runtimeVersion,
  });
  if (!preflight.canInstall) {
    throw new Error(
      'WORKFLOW_PACKAGE_INSTALL_PREFLIGHT_FAILED:' + preflight.issues.map((issue) => issue.code).join('|'),
    );
  }
  const existing = readWorkflowRegistryEntry(input.controllerHome, input.scope, bundle.manifest.workflowId);
  if (
    existing &&
    (existing.value.version !== bundle.manifest.workflowVersion ||
      existing.value.contentDigest !== bundle.manifest.contentDigest)
  ) {
    throw new Error('WORKFLOW_PACKAGE_INSTALL_IDENTITY_CONFLICT');
  }
  return existing;
}

function persistInstall(
  input: WorkflowPackageInstallInput,
  bundle: WorkflowPackageBundleV1,
  existing: WorkflowRegistryRecord | undefined,
): WorkflowPackageInstallResultV1 {
  const executableTarget = assertWorkflowPackageExecutableTarget(input.location, bundle);
  const packagePath = workflowPackageContentPath(
    input.location,
    bundle.manifest.workflowId,
    bundle.manifest.workflowVersion,
  );
  const packageExisted = existsSync(packagePath);
  let written: ReturnType<typeof writeExecutable> | undefined;
  let packageContent: ReturnType<typeof writeWorkflowPackageBundleContent> | undefined;
  try {
    written = writeExecutable(input.location, bundle);
    if (
      written.asset.workflowId !== bundle.manifest.workflowId ||
      written.asset.version !== bundle.manifest.workflowVersion ||
      written.asset.contentDigest !== bundle.manifest.contentDigest
    ) {
      throw new Error('WORKFLOW_PACKAGE_INSTALL_CONTENT_IDENTITY_MISMATCH');
    }
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
      status: existing?.value.status ?? 'installed',
      expectedRevision: existing?.revision ?? null,
    });
    return {
      schemaVersion: 1,
      workflowId: registered.value.workflowId,
      version: registered.value.version,
      contentDigest: registered.value.contentDigest,
      registryRevision: registered.revision,
      lifecycleStatus: registered.value.status,
      packagePath: packageContent.path,
      contentPath: written.path,
      activation: 'not_requested',
    };
  } catch (error) {
    if (!executableTarget.existed && written) rmSync(written.path, { force: true });
    if (!packageExisted && packageContent) rmSync(packageContent.path, { force: true });
    throw error;
  }
}

/**
 * Installs a validated package into the existing Workflow content/registry authority.
 * It never activates, binds capabilities, grants permissions, or executes the Workflow.
 */
export function installWorkflowPackage(input: WorkflowPackageInstallInput): WorkflowPackageInstallResultV1 {
  if (!input.authorization.canInstallWorkflows) throw new Error('WORKFLOW_PACKAGE_INSTALL_NOT_AUTHORIZED');
  assertWorkflowPackageLocationMatchesScope(input.scope, input.location);
  const bundle = validateWorkflowPackageBundle(input.bundle);
  const scopeKey = input.scope.kind === 'controller' ? 'controller' : `project:${input.scope.projectId}`;
  return withControllerLock(
    input.controllerHome,
    { scope: 'global', resource: `workflow-package-install:${scopeKey}:${bundle.manifest.workflowId}` },
    `workflow-package-install:${bundle.manifest.workflowId}`,
    () => persistInstall(input, bundle, validateInstallPreflight(input, bundle)),
  );
}
