import {
  readControlPlaneRecord,
  writeControlPlaneRecord,
  type ControlPlaneRecord,
} from '../control-plane/persistence/sqlite-store';
import type { WorkflowRegistryScope } from '../control-plane/persistence/workflow-registry-store';

export const WORKFLOW_PACKAGE_INSTALLATION_NAMESPACE = 'workflow_package_installation';

export interface WorkflowPackageInstallationRecordV1 {
  schemaVersion: 1;
  scope: WorkflowRegistryScope;
  workflowId: string;
  version: string;
  contentDigest: string;
  packageDigest: string;
  contentPath: string;
  packagePath: string;
  recordedAt: string;
}

function scopeKey(scope: WorkflowRegistryScope): string {
  return scope.kind === 'controller' ? '__controller__' : `project:${scope.projectId}`;
}

function recordKey(workflowId: string, version: string): string {
  return `${workflowId}@${version}`;
}

function bounded(value: string, code: string, max = 1024): string {
  if (!value.trim() || value.length > max) throw new Error(code);
  return value;
}

function validate(value: WorkflowPackageInstallationRecordV1): WorkflowPackageInstallationRecordV1 {
  if (value.schemaVersion !== 1) throw new Error('WORKFLOW_PACKAGE_INSTALLATION_SCHEMA_VERSION_UNSUPPORTED');
  bounded(value.workflowId, 'WORKFLOW_PACKAGE_INSTALLATION_WORKFLOW_ID_INVALID', 128);
  bounded(value.version, 'WORKFLOW_PACKAGE_INSTALLATION_VERSION_INVALID', 64);
  bounded(value.contentDigest, 'WORKFLOW_PACKAGE_INSTALLATION_CONTENT_DIGEST_INVALID', 128);
  bounded(value.packageDigest, 'WORKFLOW_PACKAGE_INSTALLATION_PACKAGE_DIGEST_INVALID', 128);
  bounded(value.contentPath, 'WORKFLOW_PACKAGE_INSTALLATION_CONTENT_PATH_INVALID');
  bounded(value.packagePath, 'WORKFLOW_PACKAGE_INSTALLATION_PACKAGE_PATH_INVALID');
  if (!Number.isFinite(Date.parse(value.recordedAt)))
    throw new Error('WORKFLOW_PACKAGE_INSTALLATION_RECORDED_AT_INVALID');
  return value;
}

export function readWorkflowPackageInstallation(
  controllerHome: string,
  scope: WorkflowRegistryScope,
  workflowId: string,
  version: string,
): ControlPlaneRecord<WorkflowPackageInstallationRecordV1> | undefined {
  const record = readControlPlaneRecord<WorkflowPackageInstallationRecordV1>(
    controllerHome,
    WORKFLOW_PACKAGE_INSTALLATION_NAMESPACE,
    scopeKey(scope),
    recordKey(workflowId, version),
  );
  if (!record) return undefined;
  validate(record.value);
  if (
    record.value.workflowId !== workflowId ||
    record.value.version !== version ||
    JSON.stringify(record.value.scope) !== JSON.stringify(scope)
  )
    throw new Error('WORKFLOW_PACKAGE_INSTALLATION_KEY_MISMATCH');
  return record;
}

/** Immutable per-version Package installation identity; lifecycle remains in Workflow Registry. */
export function recordWorkflowPackageInstallation(input: {
  controllerHome: string;
  scope: WorkflowRegistryScope;
  workflowId: string;
  version: string;
  contentDigest: string;
  packageDigest: string;
  contentPath: string;
  packagePath: string;
  now?: Date;
}): ControlPlaneRecord<WorkflowPackageInstallationRecordV1> {
  const existing = readWorkflowPackageInstallation(input.controllerHome, input.scope, input.workflowId, input.version);
  if (existing) {
    if (
      existing.value.contentDigest !== input.contentDigest ||
      existing.value.packageDigest !== input.packageDigest ||
      existing.value.contentPath !== input.contentPath ||
      existing.value.packagePath !== input.packagePath
    )
      throw new Error('WORKFLOW_PACKAGE_INSTALLATION_IMMUTABLE_CONFLICT');
    return existing;
  }
  const value = validate({
    schemaVersion: 1,
    scope: structuredClone(input.scope),
    workflowId: input.workflowId,
    version: input.version,
    contentDigest: input.contentDigest,
    packageDigest: input.packageDigest,
    contentPath: input.contentPath,
    packagePath: input.packagePath,
    recordedAt: (input.now ?? new Date()).toISOString(),
  });
  return writeControlPlaneRecord(input.controllerHome, {
    namespace: WORKFLOW_PACKAGE_INSTALLATION_NAMESPACE,
    scope: scopeKey(input.scope),
    key: recordKey(input.workflowId, input.version),
    schemaVersion: 1,
    value,
    action: 'workflow_package_installation_recorded',
    expectedRevision: null,
  });
}
