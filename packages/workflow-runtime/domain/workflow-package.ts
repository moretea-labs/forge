import { createHash } from 'crypto';
import type { WorkflowExecutableAssetDefinition, WorkflowFeatureEngine } from './workflow-feature';
import {
  workflowFeatureCapabilityDependencies,
  workflowFeatureChildWorkflowDependencies,
  workflowFeatureContentIdentity,
  workflowFeatureDescriptor,
} from './workflow-feature';

export interface WorkflowPackageRuntimeCompatibilityV1 {
  minRuntimeVersion?: string;
  maxRuntimeVersionExclusive?: string;
}

export interface WorkflowPackageChildDependencyV1 {
  workflowId: string;
  version?: string;
  contentDigest?: string;
}

export interface WorkflowPackageRiskV1 {
  level: 'read' | 'workspace_write' | 'external_write' | 'destructive';
  requiresApproval: boolean;
}

export interface WorkflowPackageManifestV1 {
  schemaVersion: 1;
  workflowId: string;
  workflowVersion: string;
  contentDigest: string;
  engine: WorkflowFeatureEngine;
  title?: string;
  description?: string;
  tags: string[];
  runtimeCompatibility: WorkflowPackageRuntimeCompatibilityV1;
  inputContractDigest: string;
  requiredCapabilities: string[];
  requiredWorkflows: WorkflowPackageChildDependencyV1[];
  risk: WorkflowPackageRiskV1;
  publisher: {
    kind: 'first_party' | 'user' | 'model' | 'plugin' | 'import';
    id: string;
  };
  packageDigest: string;
}

export type WorkflowPackageManifestDraftV1 = Omit<WorkflowPackageManifestV1, 'packageDigest'>;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const RUNTIME_VERSION = /^\d+\.\d+\.\d+$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;
}

function boundedId(value: string, code: string): string {
  if (!ID.test(value)) throw new Error(code);
  return value;
}

function boundedVersion(value: string, code: string): string {
  if (!VERSION.test(value)) throw new Error(code);
  return value;
}

function boundedText(value: string | undefined, code: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim() || value.length > max) throw new Error(code);
  return value;
}

export function workflowInputContractDigest(asset: WorkflowExecutableAssetDefinition): string {
  return sha256(workflowFeatureDescriptor(asset).inputContract);
}

export function workflowPackageManifestDigest(
  manifest: WorkflowPackageManifestDraftV1 | WorkflowPackageManifestV1,
): string {
  const content = { ...manifest } as Record<string, unknown>;
  delete content.packageDigest;
  return sha256(content);
}

function validateCompatibility(value: WorkflowPackageRuntimeCompatibilityV1): WorkflowPackageRuntimeCompatibilityV1 {
  const minRuntimeVersion = value.minRuntimeVersion;
  const maxRuntimeVersionExclusive = value.maxRuntimeVersionExclusive;
  if (minRuntimeVersion !== undefined && !RUNTIME_VERSION.test(minRuntimeVersion))
    throw new Error('WORKFLOW_PACKAGE_MIN_RUNTIME_VERSION_INVALID');
  if (maxRuntimeVersionExclusive !== undefined && !RUNTIME_VERSION.test(maxRuntimeVersionExclusive))
    throw new Error('WORKFLOW_PACKAGE_MAX_RUNTIME_VERSION_INVALID');
  return {
    ...(minRuntimeVersion ? { minRuntimeVersion } : {}),
    ...(maxRuntimeVersionExclusive ? { maxRuntimeVersionExclusive } : {}),
  };
}

function validateRequiredWorkflows(
  dependencies: WorkflowPackageChildDependencyV1[],
): WorkflowPackageChildDependencyV1[] {
  if (!Array.isArray(dependencies) || dependencies.length > 64)
    throw new Error('WORKFLOW_PACKAGE_CHILD_DEPENDENCIES_INVALID');
  const seen = new Set<string>();
  return dependencies.map((dependency) => {
    const workflowId = boundedId(dependency.workflowId, 'WORKFLOW_PACKAGE_CHILD_ID_INVALID');
    if (seen.has(workflowId)) throw new Error('WORKFLOW_PACKAGE_CHILD_DUPLICATE:' + workflowId);
    seen.add(workflowId);
    const version =
      dependency.version === undefined
        ? undefined
        : boundedVersion(dependency.version, 'WORKFLOW_PACKAGE_CHILD_VERSION_INVALID');
    const contentDigest = dependency.contentDigest;
    if (contentDigest !== undefined && !DIGEST.test(contentDigest))
      throw new Error('WORKFLOW_PACKAGE_CHILD_DIGEST_INVALID');
    if (!version && !contentDigest) throw new Error('WORKFLOW_PACKAGE_CHILD_PIN_REQUIRED:' + workflowId);
    return { workflowId, ...(version ? { version } : {}), ...(contentDigest ? { contentDigest } : {}) };
  });
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

export function validateWorkflowPackageManifest(
  manifest: WorkflowPackageManifestV1,
  asset: WorkflowExecutableAssetDefinition,
): WorkflowPackageManifestV1 {
  if (manifest.schemaVersion !== 1) throw new Error('WORKFLOW_PACKAGE_SCHEMA_VERSION_UNSUPPORTED');
  const identity = workflowFeatureContentIdentity(asset);
  if (
    manifest.workflowId !== identity.workflowId ||
    manifest.workflowVersion !== identity.version ||
    manifest.contentDigest !== identity.contentDigest
  )
    throw new Error('WORKFLOW_PACKAGE_CONTENT_IDENTITY_MISMATCH');
  const descriptor = workflowFeatureDescriptor(asset);
  if (manifest.engine !== descriptor.engine) throw new Error('WORKFLOW_PACKAGE_ENGINE_MISMATCH');
  if (manifest.inputContractDigest !== workflowInputContractDigest(asset))
    throw new Error('WORKFLOW_PACKAGE_INPUT_CONTRACT_DIGEST_MISMATCH');
  if (!Array.isArray(manifest.tags) || manifest.tags.length > 32 || manifest.tags.some((tag) => !TAG.test(tag)))
    throw new Error('WORKFLOW_PACKAGE_TAGS_INVALID');
  if (new Set(manifest.tags).size !== manifest.tags.length) throw new Error('WORKFLOW_PACKAGE_TAGS_DUPLICATE');
  const requiredCapabilities = manifest.requiredCapabilities.map((capability) =>
    boundedId(capability, 'WORKFLOW_PACKAGE_CAPABILITY_ID_INVALID'),
  );
  if (new Set(requiredCapabilities).size !== requiredCapabilities.length)
    throw new Error('WORKFLOW_PACKAGE_CAPABILITY_DUPLICATE');
  if (!sameSet(requiredCapabilities, workflowFeatureCapabilityDependencies(asset)))
    throw new Error('WORKFLOW_PACKAGE_CAPABILITY_DEPENDENCY_MISMATCH');
  const requiredWorkflows = validateRequiredWorkflows(manifest.requiredWorkflows);
  const childIds = requiredWorkflows.map((dependency) => dependency.workflowId);
  if (!sameSet(childIds, workflowFeatureChildWorkflowDependencies(asset)))
    throw new Error('WORKFLOW_PACKAGE_CHILD_DEPENDENCY_MISMATCH');
  if (!['read', 'workspace_write', 'external_write', 'destructive'].includes(manifest.risk.level))
    throw new Error('WORKFLOW_PACKAGE_RISK_INVALID');
  if (
    (manifest.risk.level === 'external_write' || manifest.risk.level === 'destructive') &&
    !manifest.risk.requiresApproval
  )
    throw new Error('WORKFLOW_PACKAGE_SENSITIVE_APPROVAL_REQUIRED');
  if (!['first_party', 'user', 'model', 'plugin', 'import'].includes(manifest.publisher.kind))
    throw new Error('WORKFLOW_PACKAGE_PUBLISHER_KIND_INVALID');
  boundedId(manifest.publisher.id, 'WORKFLOW_PACKAGE_PUBLISHER_ID_INVALID');
  validateCompatibility(manifest.runtimeCompatibility);
  boundedText(manifest.title, 'WORKFLOW_PACKAGE_TITLE_INVALID', 256);
  boundedText(manifest.description, 'WORKFLOW_PACKAGE_DESCRIPTION_INVALID', 4000);
  if (!DIGEST.test(manifest.packageDigest) || workflowPackageManifestDigest(manifest) !== manifest.packageDigest)
    throw new Error('WORKFLOW_PACKAGE_DIGEST_INVALID');
  return structuredClone(manifest);
}

export function materializeWorkflowPackageManifest(
  asset: WorkflowExecutableAssetDefinition,
  metadata: {
    tags?: string[];
    runtimeCompatibility?: WorkflowPackageRuntimeCompatibilityV1;
    requiredWorkflows?: WorkflowPackageChildDependencyV1[];
    risk: WorkflowPackageRiskV1;
    publisher: WorkflowPackageManifestV1['publisher'];
  },
): WorkflowPackageManifestV1 {
  const descriptor = workflowFeatureDescriptor(asset);
  const draft: WorkflowPackageManifestDraftV1 = {
    schemaVersion: 1,
    workflowId: descriptor.workflowId,
    workflowVersion: descriptor.version,
    contentDigest: descriptor.contentDigest,
    engine: descriptor.engine,
    ...(descriptor.title ? { title: descriptor.title } : {}),
    ...(descriptor.description ? { description: descriptor.description } : {}),
    tags: [...(metadata.tags ?? [])].sort(),
    runtimeCompatibility: validateCompatibility(metadata.runtimeCompatibility ?? {}),
    inputContractDigest: workflowInputContractDigest(asset),
    requiredCapabilities: [...descriptor.capabilityDependencies],
    requiredWorkflows: validateRequiredWorkflows(metadata.requiredWorkflows ?? []),
    risk: structuredClone(metadata.risk),
    publisher: structuredClone(metadata.publisher),
  };
  const manifest = { ...draft, packageDigest: workflowPackageManifestDigest(draft) };
  return validateWorkflowPackageManifest(manifest, asset);
}
