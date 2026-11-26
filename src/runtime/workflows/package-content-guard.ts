import { existsSync } from 'fs';
import type { WorkflowPackageBundleV1 } from '../../../packages/workflow-runtime/domain/workflow-package-bundle';
import {
  readWorkflowExecutableContentFile,
  workflowAssetContentPath,
  type WorkflowAssetContentLocation,
} from '../control-plane/persistence/workflow-content-store';

export interface WorkflowPackageExecutableTargetState {
  path: string;
  existed: boolean;
}

/** Versioned Workflow executable content is immutable once the target path exists. */
export function assertWorkflowPackageExecutableTarget(
  location: WorkflowAssetContentLocation,
  bundle: WorkflowPackageBundleV1,
): WorkflowPackageExecutableTargetState {
  const path = workflowAssetContentPath(location, bundle.manifest.workflowId, bundle.manifest.workflowVersion);
  if (!existsSync(path)) return { path, existed: false };
  const existing = readWorkflowExecutableContentFile(path);
  if (
    existing.workflowId !== bundle.manifest.workflowId ||
    existing.version !== bundle.manifest.workflowVersion ||
    existing.contentDigest !== bundle.manifest.contentDigest
  ) {
    throw new Error(
      `WORKFLOW_PACKAGE_EXECUTABLE_IMMUTABLE_CONFLICT:${bundle.manifest.workflowId}:${bundle.manifest.workflowVersion}`,
    );
  }
  return { path, existed: true };
}
