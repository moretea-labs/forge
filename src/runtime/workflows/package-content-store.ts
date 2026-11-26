import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  parseWorkflowPackageBundle,
  serializeWorkflowPackageBundle,
  validateWorkflowPackageBundle,
  type WorkflowPackageBundleV1,
} from '../../../packages/workflow-runtime/domain/workflow-package-bundle';
import {
  workflowAssetContentRoot,
  type WorkflowAssetContentLocation,
} from '../control-plane/persistence/workflow-content-store';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

function safeSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value)) throw new Error(`WORKFLOW_PACKAGE_CONTENT_${label}_INVALID`);
  return value;
}

export function workflowPackageContentPath(
  location: WorkflowAssetContentLocation,
  workflowId: string,
  version: string,
): string {
  return join(
    workflowAssetContentRoot(location),
    safeSegment(workflowId, 'WORKFLOW_ID'),
    safeSegment(version, 'VERSION'),
    'package.json',
  );
}

function writeAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Best effort only; the authoritative path is written atomically.
    }
  }
}

export function writeWorkflowPackageBundleContent(
  location: WorkflowAssetContentLocation,
  bundleInput: WorkflowPackageBundleV1,
): { bundle: WorkflowPackageBundleV1; path: string } {
  const bundle = validateWorkflowPackageBundle(bundleInput);
  const path = workflowPackageContentPath(location, bundle.manifest.workflowId, bundle.manifest.workflowVersion);
  if (existsSync(path)) {
    const existing = parseWorkflowPackageBundle(readFileSync(path, 'utf8'));
    if (existing.manifest.packageDigest !== bundle.manifest.packageDigest) {
      throw new Error(
        `WORKFLOW_PACKAGE_CONTENT_IMMUTABLE_CONFLICT:${bundle.manifest.workflowId}:${bundle.manifest.workflowVersion}`,
      );
    }
    return { bundle: existing, path };
  }
  writeAtomically(path, serializeWorkflowPackageBundle(bundle));
  return { bundle, path };
}

export function readWorkflowPackageBundleContent(
  location: WorkflowAssetContentLocation,
  workflowId: string,
  version: string,
): { bundle: WorkflowPackageBundleV1; path: string } {
  const path = workflowPackageContentPath(location, workflowId, version);
  return { bundle: parseWorkflowPackageBundle(readFileSync(path, 'utf8')), path };
}
