import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import type { WorkflowPackageManifestV1 } from '../../../packages/workflow-runtime/domain/workflow-package';
import { parseWorkflowPackageBundle } from '../../../packages/workflow-runtime/domain/workflow-package-bundle';
import { listWorkflowCatalog, type WorkflowCatalogEntryV1 } from './catalog';
import type { WorkflowRegistryScope } from '../control-plane/persistence/workflow-registry-store';
import { readWorkflowPackageInstallation } from './package-installation-store';

export interface WorkflowDiscoveryEntryV1 {
  schemaVersion: 1;
  workflow: WorkflowCatalogEntryV1;
  packageStatus: 'packaged' | 'legacy_unpacked' | 'invalid';
  package?: WorkflowPackageManifestV1;
  packageError?: string;
}

export interface WorkflowDiscoveryQueryV1 {
  text?: string;
  tags?: string[];
  engine?: 'sequence_v1' | 'graph_v2';
  lifecycle?: 'installed' | 'active' | 'inactive';
  packagedOnly?: boolean;
}

function packagePath(contentPath: string): string {
  return join(dirname(contentPath), 'package.json');
}

function packageFor(
  controllerHome: string,
  scope: WorkflowRegistryScope,
  entry: WorkflowCatalogEntryV1,
): {
  status: 'packaged' | 'legacy_unpacked' | 'invalid';
  manifest?: WorkflowPackageManifestV1;
  error?: string;
} {
  const path = packagePath(entry.contentLocation.path);
  const installation = readWorkflowPackageInstallation(
    controllerHome,
    scope,
    entry.descriptor.workflowId,
    entry.descriptor.version,
  );
  if (!existsSync(path)) {
    return installation
      ? { status: 'invalid', error: 'WORKFLOW_DISCOVERY_PACKAGE_CONTENT_MISSING:' + entry.descriptor.workflowId }
      : { status: 'legacy_unpacked' };
  }
  try {
    const bundle = parseWorkflowPackageBundle(readFileSync(path, 'utf8'));
    if (installation && installation.value.packageDigest !== bundle.manifest.packageDigest) {
      return {
        status: 'invalid',
        error: 'WORKFLOW_DISCOVERY_PACKAGE_INSTALLATION_DIGEST_MISMATCH:' + entry.descriptor.workflowId,
      };
    }
    if (
      bundle.manifest.workflowId !== entry.descriptor.workflowId ||
      bundle.manifest.workflowVersion !== entry.descriptor.version ||
      bundle.manifest.contentDigest !== entry.descriptor.contentDigest ||
      bundle.manifest.engine !== entry.descriptor.engine
    ) {
      return {
        status: 'invalid',
        error: 'WORKFLOW_DISCOVERY_PACKAGE_IDENTITY_MISMATCH:' + entry.descriptor.workflowId,
      };
    }
    return { status: 'packaged', manifest: bundle.manifest };
  } catch (error) {
    return {
      status: 'invalid',
      error: error instanceof Error ? error.message : 'WORKFLOW_DISCOVERY_PACKAGE_INVALID',
    };
  }
}

export function listWorkflowDiscoveryCatalog(
  controllerHome: string,
  scope: WorkflowRegistryScope,
): WorkflowDiscoveryEntryV1[] {
  return listWorkflowCatalog(controllerHome, scope).map((workflow) => {
    const packageState = packageFor(controllerHome, scope, workflow);
    return {
      schemaVersion: 1,
      workflow,
      packageStatus: packageState.status,
      ...(packageState.manifest ? { package: packageState.manifest } : {}),
      ...(packageState.error ? { packageError: packageState.error } : {}),
    };
  });
}

function searchable(entry: WorkflowDiscoveryEntryV1): string[] {
  const descriptor = entry.workflow.descriptor;
  return [
    descriptor.workflowId,
    descriptor.title ?? '',
    descriptor.description ?? '',
    ...descriptor.capabilityDependencies,
    ...descriptor.childWorkflowDependencies,
    ...(entry.package?.tags ?? []),
    entry.package?.publisher.id ?? '',
  ].map((value) => value.toLocaleLowerCase());
}

export function searchWorkflowDiscoveryCatalog(
  controllerHome: string,
  scope: WorkflowRegistryScope,
  query: WorkflowDiscoveryQueryV1,
): WorkflowDiscoveryEntryV1[] {
  const text = query.text?.trim().toLocaleLowerCase();
  const tags = (query.tags ?? []).map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean);
  return listWorkflowDiscoveryCatalog(controllerHome, scope).filter((entry) => {
    if (query.engine && entry.workflow.descriptor.engine !== query.engine) return false;
    if (query.lifecycle && entry.workflow.status !== query.lifecycle) return false;
    if (query.packagedOnly && entry.packageStatus !== 'packaged') return false;
    if (tags.length > 0) {
      const present = new Set((entry.package?.tags ?? []).map((tag) => tag.toLocaleLowerCase()));
      if (tags.some((tag) => !present.has(tag))) return false;
    }
    if (text && !searchable(entry).some((value) => value.includes(text))) return false;
    return true;
  });
}
