import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { withControllerLock } from '../../effects/controller-locks';
import { parseWorkflowPackageBundle } from '../../../packages/workflow-runtime/domain/workflow-package-bundle';
import {
  readWorkflowRegistryEntry,
  setWorkflowRegistryStatus,
  type WorkflowRegistryScope,
} from '../control-plane/persistence/workflow-registry-store';
import { preflightWorkflowPackageImport } from './package-import';
import { assertNoActiveWorkflowPackageDependents } from './package-dependencies';
import {
  assertWorkflowPackageActivationApproval,
  type WorkflowPackageActivationApprovalProof,
} from './package-approval';

export interface WorkflowPackageLifecycleAuthorization {
  canActivateWorkflows: boolean;
  approval?: WorkflowPackageActivationApprovalProof;
}

export interface WorkflowPackageLifecycleResultV1 {
  schemaVersion: 1;
  workflowId: string;
  packageDigest?: string;
  packageStatus: 'valid' | 'invalid';
  status: 'active' | 'inactive';
  registryRevision: number;
}

function scopeKey(scope: WorkflowRegistryScope): string {
  return scope.kind === 'controller' ? 'controller' : `project:${scope.projectId}`;
}

function packageBundleFor(controllerHome: string, scope: WorkflowRegistryScope, workflowId: string) {
  const registry = readWorkflowRegistryEntry(controllerHome, scope, workflowId);
  if (!registry) throw new Error('WORKFLOW_PACKAGE_LIFECYCLE_NOT_INSTALLED:' + workflowId);
  const path = join(dirname(registry.value.contentLocation.path), 'package.json');
  if (!existsSync(path)) throw new Error('WORKFLOW_PACKAGE_LIFECYCLE_PACKAGE_REQUIRED:' + workflowId);
  const bundle = parseWorkflowPackageBundle(readFileSync(path, 'utf8'));
  if (
    bundle.manifest.workflowId !== registry.value.workflowId ||
    bundle.manifest.workflowVersion !== registry.value.version ||
    bundle.manifest.contentDigest !== registry.value.contentDigest
  ) {
    throw new Error('WORKFLOW_PACKAGE_LIFECYCLE_IDENTITY_MISMATCH');
  }
  return { registry, bundle };
}

function packageStateForDeactivation(
  controllerHome: string,
  scope: WorkflowRegistryScope,
  workflowId: string,
): {
  registry: NonNullable<ReturnType<typeof readWorkflowRegistryEntry>>;
  bundle?: ReturnType<typeof parseWorkflowPackageBundle>;
  error?: string;
} {
  const registry = readWorkflowRegistryEntry(controllerHome, scope, workflowId);
  if (!registry) throw new Error('WORKFLOW_PACKAGE_LIFECYCLE_NOT_INSTALLED:' + workflowId);
  const path = join(dirname(registry.value.contentLocation.path), 'package.json');
  if (!existsSync(path)) {
    return { registry, error: 'WORKFLOW_PACKAGE_LIFECYCLE_PACKAGE_REQUIRED:' + workflowId };
  }
  try {
    const bundle = parseWorkflowPackageBundle(readFileSync(path, 'utf8'));
    if (
      bundle.manifest.workflowId !== registry.value.workflowId ||
      bundle.manifest.workflowVersion !== registry.value.version ||
      bundle.manifest.contentDigest !== registry.value.contentDigest
    ) {
      return { registry, error: 'WORKFLOW_PACKAGE_LIFECYCLE_IDENTITY_MISMATCH' };
    }
    return { registry, bundle };
  } catch (error) {
    return {
      registry,
      error: error instanceof Error ? error.message : 'WORKFLOW_PACKAGE_LIFECYCLE_PACKAGE_INVALID',
    };
  }
}

export function activateWorkflowPackage(input: {
  controllerHome: string;
  scope: WorkflowRegistryScope;
  workflowId: string;
  runtimeVersion: string;
  authorization: WorkflowPackageLifecycleAuthorization;
}): WorkflowPackageLifecycleResultV1 {
  if (!input.authorization.canActivateWorkflows) throw new Error('WORKFLOW_PACKAGE_ACTIVATE_NOT_AUTHORIZED');
  const resource = `workflow-package-install:${scopeKey(input.scope)}:${input.workflowId}`;
  return withControllerLock(
    input.controllerHome,
    { scope: 'global', resource },
    `workflow-package-activate:${input.workflowId}`,
    () => {
      const { registry, bundle } = packageBundleFor(input.controllerHome, input.scope, input.workflowId);
      const preflight = preflightWorkflowPackageImport({
        controllerHome: input.controllerHome,
        scope: input.scope,
        bundle,
        runtimeVersion: input.runtimeVersion,
      });
      if (!preflight.canActivate) {
        const blockers = [
          ...preflight.issues.map((issue) => issue.code),
          ...preflight.warnings.map((warning) => warning.code),
        ];
        throw new Error('WORKFLOW_PACKAGE_ACTIVATE_PREFLIGHT_FAILED:' + blockers.join('|'));
      }
      if (bundle.manifest.risk.requiresApproval) {
        assertWorkflowPackageActivationApproval(
          input.authorization.approval,
          input.scope,
          input.workflowId,
          bundle.manifest.packageDigest,
        );
      }
      if (registry.value.status === 'active') {
        return {
          schemaVersion: 1,
          workflowId: registry.value.workflowId,
          packageDigest: bundle.manifest.packageDigest,
          packageStatus: 'valid',
          status: 'active',
          registryRevision: registry.revision,
        };
      }
      const activated = setWorkflowRegistryStatus({
        controllerHome: input.controllerHome,
        scope: input.scope,
        workflowId: input.workflowId,
        status: 'active',
        expectedRevision: registry.revision,
      });
      return {
        schemaVersion: 1,
        workflowId: activated.value.workflowId,
        packageDigest: bundle.manifest.packageDigest,
        packageStatus: 'valid',
        status: 'active',
        registryRevision: activated.revision,
      };
    },
  );
}

export function deactivateWorkflowPackage(input: {
  controllerHome: string;
  scope: WorkflowRegistryScope;
  workflowId: string;
  authorization: Pick<WorkflowPackageLifecycleAuthorization, 'canActivateWorkflows'>;
}): WorkflowPackageLifecycleResultV1 {
  if (!input.authorization.canActivateWorkflows) throw new Error('WORKFLOW_PACKAGE_DEACTIVATE_NOT_AUTHORIZED');
  const resource = `workflow-package-install:${scopeKey(input.scope)}:${input.workflowId}`;
  return withControllerLock(
    input.controllerHome,
    { scope: 'global', resource },
    `workflow-package-deactivate:${input.workflowId}`,
    () => {
      const state = packageStateForDeactivation(input.controllerHome, input.scope, input.workflowId);
      const { registry, bundle } = state;
      assertNoActiveWorkflowPackageDependents(input.controllerHome, input.scope, registry.value, {
        ignoreInvalidWorkflowId: state.error ? input.workflowId : undefined,
      });
      const packageStatus = state.error ? 'invalid' : 'valid';
      if (registry.value.status === 'inactive') {
        return {
          schemaVersion: 1,
          workflowId: registry.value.workflowId,
          ...(bundle ? { packageDigest: bundle.manifest.packageDigest } : {}),
          packageStatus,
          status: 'inactive',
          registryRevision: registry.revision,
        };
      }
      const deactivated = setWorkflowRegistryStatus({
        controllerHome: input.controllerHome,
        scope: input.scope,
        workflowId: input.workflowId,
        status: 'inactive',
        expectedRevision: registry.revision,
      });
      return {
        schemaVersion: 1,
        workflowId: deactivated.value.workflowId,
        ...(bundle ? { packageDigest: bundle.manifest.packageDigest } : {}),
        packageStatus,
        status: 'inactive',
        registryRevision: deactivated.revision,
      };
    },
  );
}
