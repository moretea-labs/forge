import type { WorkflowExecutableAssetDefinition } from './workflow-feature';
import {
  materializeWorkflowPackageManifest,
  validateWorkflowPackageManifest,
  type WorkflowPackageManifestV1,
  type WorkflowPackageManifestDraftV1,
  type WorkflowPackageChildDependencyV1,
  type WorkflowPackageRiskV1,
  type WorkflowPackageRuntimeCompatibilityV1,
} from './workflow-package';
import { validateWorkflowExecutableAsset } from './workflow-feature';

export interface WorkflowPackageBundleV1 {
  schemaVersion: 1;
  manifest: WorkflowPackageManifestV1;
  asset: WorkflowExecutableAssetDefinition;
}

export interface WorkflowPackageBundleMetadata {
  tags?: string[];
  runtimeCompatibility?: WorkflowPackageRuntimeCompatibilityV1;
  requiredWorkflows?: WorkflowPackageChildDependencyV1[];
  risk: WorkflowPackageRiskV1;
  publisher: WorkflowPackageManifestV1['publisher'];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateWorkflowPackageBundle(input: unknown): WorkflowPackageBundleV1 {
  if (!record(input)) throw new Error('WORKFLOW_PACKAGE_BUNDLE_INVALID');
  const keys = Object.keys(input);
  if (keys.some((key) => !['schemaVersion', 'manifest', 'asset'].includes(key)))
    throw new Error('WORKFLOW_PACKAGE_BUNDLE_FIELD_UNSUPPORTED');
  if (input.schemaVersion !== 1) throw new Error('WORKFLOW_PACKAGE_BUNDLE_SCHEMA_VERSION_UNSUPPORTED');
  const asset = validateWorkflowExecutableAsset(input.asset);
  const manifest = validateWorkflowPackageManifest(input.manifest as WorkflowPackageManifestV1, asset);
  return { schemaVersion: 1, manifest, asset: structuredClone(asset) };
}

export function materializeWorkflowPackageBundle(
  asset: WorkflowExecutableAssetDefinition,
  metadata: WorkflowPackageBundleMetadata,
): WorkflowPackageBundleV1 {
  const validatedAsset = validateWorkflowExecutableAsset(asset);
  const manifest = materializeWorkflowPackageManifest(validatedAsset, metadata);
  return validateWorkflowPackageBundle({ schemaVersion: 1, manifest, asset: validatedAsset });
}

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

export function serializeWorkflowPackageBundle(bundle: WorkflowPackageBundleV1): string {
  const validated = validateWorkflowPackageBundle(bundle);
  return `${JSON.stringify(canonical(validated), null, 2)}\n`;
}

export function parseWorkflowPackageBundle(serialized: string): WorkflowPackageBundleV1 {
  if (typeof serialized !== 'string' || !serialized.trim()) throw new Error('WORKFLOW_PACKAGE_BUNDLE_CONTENT_INVALID');
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('WORKFLOW_PACKAGE_BUNDLE_JSON_INVALID');
  }
  return validateWorkflowPackageBundle(parsed);
}

// Compile-time guard: package bundle metadata deliberately excludes lifecycle or authority.
type _NoLifecycleAuthority = Extract<
  keyof WorkflowPackageManifestDraftV1,
  'status' | 'active' | 'authorization' | 'credential' | 'secret'
>;
const _noLifecycleAuthority: _NoLifecycleAuthority | undefined = undefined;
void _noLifecycleAuthority;
