import {
  validateWorkflowPackageBundle,
  type WorkflowPackageBundleV1,
} from '../../../packages/workflow-runtime/domain/workflow-package-bundle';
import type { WorkflowPackageChildDependencyV1 } from '../../../packages/workflow-runtime/domain/workflow-package';
import {
  readWorkflowRegistryEntry,
  type WorkflowRegistryScope,
} from '../control-plane/persistence/workflow-registry-store';

export interface WorkflowPackageImportIssue {
  code: string;
  message: string;
  workflowId?: string;
  capabilityId?: string;
}

export interface WorkflowPackageDependencyStatusV1 {
  workflowId: string;
  status: 'ready' | 'missing' | 'inactive' | 'version_mismatch' | 'digest_mismatch';
  requiredVersion?: string;
  requiredContentDigest?: string;
  installedVersion?: string;
  installedContentDigest?: string;
}

export interface WorkflowPackageImportPreflightV1 {
  schemaVersion: 1;
  manifest: WorkflowPackageBundleV1['manifest'];
  canInstall: boolean;
  canActivate: boolean;
  issues: WorkflowPackageImportIssue[];
  warnings: WorkflowPackageImportIssue[];
  childDependencies: WorkflowPackageDependencyStatusV1[];
  missingCapabilityBindings: string[];
  lifecycle: {
    installStatus: 'installed';
    activation: 'not_requested';
  };
  approvalRequired: boolean;
}

function parseRuntimeVersion(value: string): [number, number, number] {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error('WORKFLOW_PACKAGE_RUNTIME_VERSION_INVALID');
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareRuntimeVersion(left: string, right: string): number {
  const a = parseRuntimeVersion(left);
  const b = parseRuntimeVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! < b[index]!) return -1;
    if (a[index]! > b[index]!) return 1;
  }
  return 0;
}

function dependencyStatus(
  controllerHome: string,
  scope: WorkflowRegistryScope,
  dependency: WorkflowPackageChildDependencyV1,
): WorkflowPackageDependencyStatusV1 {
  const installed = readWorkflowRegistryEntry(controllerHome, scope, dependency.workflowId);
  if (!installed) {
    return {
      workflowId: dependency.workflowId,
      status: 'missing',
      ...(dependency.version ? { requiredVersion: dependency.version } : {}),
      ...(dependency.contentDigest ? { requiredContentDigest: dependency.contentDigest } : {}),
    };
  }
  const base = {
    workflowId: dependency.workflowId,
    ...(dependency.version ? { requiredVersion: dependency.version } : {}),
    ...(dependency.contentDigest ? { requiredContentDigest: dependency.contentDigest } : {}),
    installedVersion: installed.value.version,
    installedContentDigest: installed.value.contentDigest,
  };
  if (dependency.version && dependency.version !== installed.value.version)
    return { ...base, status: 'version_mismatch' };
  if (dependency.contentDigest && dependency.contentDigest !== installed.value.contentDigest)
    return { ...base, status: 'digest_mismatch' };
  if (installed.value.status !== 'active') return { ...base, status: 'inactive' };
  return { ...base, status: 'ready' };
}

function runtimeIssues(runtimeVersion: string, bundle: WorkflowPackageBundleV1): WorkflowPackageImportIssue[] {
  const issues: WorkflowPackageImportIssue[] = [];
  const compatibility = bundle.manifest.runtimeCompatibility;
  parseRuntimeVersion(runtimeVersion);
  if (compatibility.minRuntimeVersion && compareRuntimeVersion(runtimeVersion, compatibility.minRuntimeVersion) < 0) {
    issues.push({
      code: 'WORKFLOW_PACKAGE_RUNTIME_TOO_OLD',
      message: `Runtime ${runtimeVersion} is below required ${compatibility.minRuntimeVersion}.`,
    });
  }
  if (
    compatibility.maxRuntimeVersionExclusive &&
    compareRuntimeVersion(runtimeVersion, compatibility.maxRuntimeVersionExclusive) >= 0
  ) {
    issues.push({
      code: 'WORKFLOW_PACKAGE_RUNTIME_TOO_NEW',
      message: `Runtime ${runtimeVersion} is outside the supported range below ${compatibility.maxRuntimeVersionExclusive}.`,
    });
  }
  return issues;
}

/** Read-only package inspection. It never installs, binds capabilities, grants approval, or activates a Workflow. */
export function preflightWorkflowPackageImport(input: {
  controllerHome: string;
  scope: WorkflowRegistryScope;
  bundle: unknown;
  runtimeVersion: string;
}): WorkflowPackageImportPreflightV1 {
  const bundle = validateWorkflowPackageBundle(input.bundle);
  const issues = runtimeIssues(input.runtimeVersion, bundle);
  const childDependencies = bundle.manifest.requiredWorkflows.map((dependency) =>
    dependencyStatus(input.controllerHome, input.scope, dependency),
  );
  const existing = readWorkflowRegistryEntry(input.controllerHome, input.scope, bundle.manifest.workflowId);
  if (existing && existing.value.contentDigest !== bundle.manifest.contentDigest) {
    issues.push({
      code: 'WORKFLOW_PACKAGE_EXISTING_IDENTITY_CONFLICT',
      message: `Workflow ${bundle.manifest.workflowId} is already installed with different content.`,
      workflowId: bundle.manifest.workflowId,
    });
  }
  const boundCapabilities = new Set(existing?.value.bindings.map((binding) => binding.capabilityId) ?? []);
  const missingCapabilityBindings = bundle.manifest.requiredCapabilities.filter(
    (capabilityId) => !boundCapabilities.has(capabilityId),
  );
  const warnings: WorkflowPackageImportIssue[] = [
    ...childDependencies
      .filter((dependency) => dependency.status !== 'ready')
      .map((dependency) => ({
        code: `WORKFLOW_PACKAGE_CHILD_${dependency.status.toUpperCase()}`,
        message: `Child Workflow ${dependency.workflowId} is ${dependency.status}.`,
        workflowId: dependency.workflowId,
      })),
    ...missingCapabilityBindings.map((capabilityId) => ({
      code: 'WORKFLOW_PACKAGE_CAPABILITY_BINDING_REQUIRED',
      message: `Capability ${capabilityId} requires a local binding before activation.`,
      capabilityId,
    })),
  ];
  const canInstall = issues.length === 0;
  const canActivate =
    canInstall &&
    childDependencies.every((dependency) => dependency.status === 'ready') &&
    missingCapabilityBindings.length === 0;
  return {
    schemaVersion: 1,
    manifest: bundle.manifest,
    canInstall,
    canActivate,
    issues,
    warnings,
    childDependencies,
    missingCapabilityBindings,
    lifecycle: { installStatus: 'installed', activation: 'not_requested' },
    approvalRequired: bundle.manifest.risk.requiresApproval,
  };
}
