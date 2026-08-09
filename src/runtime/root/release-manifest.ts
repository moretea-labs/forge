import { readFileSync } from 'fs';
import { resolve } from 'path';
import { CONTROL_PLANE_SCHEMA_VERSION } from '../control-plane/persistence/sqlite-store';
import type { RuntimeReleaseManifest } from './types';

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`RELEASE_MANIFEST_INVALID: ${field} is required`);
  return value.trim();
}

export function loadRuntimeReleaseManifest(
  path: string,
  expectedControllerHome: string,
): RuntimeReleaseManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`RELEASE_MANIFEST_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('RELEASE_MANIFEST_INVALID: root must be an object');
  }
  const value = parsed as Record<string, unknown>;
  if (value.schemaVersion !== 1) throw new Error('RELEASE_MANIFEST_INVALID: schemaVersion must be 1');
  const entrypoint = requireString(value.entrypoint, 'entrypoint');
  if (entrypoint !== 'forge-runtime') {
    throw new Error(`RELEASE_MANIFEST_INVALID: entrypoint must be forge-runtime, got ${entrypoint}`);
  }
  if (value.configurationSchemaVersion !== 1) {
    throw new Error('RELEASE_MANIFEST_INVALID: configurationSchemaVersion must be 1');
  }
  const controllerHome = resolve(requireString(value.controllerHome, 'controllerHome'));
  if (controllerHome !== resolve(expectedControllerHome)) {
    throw new Error('RELEASE_MANIFEST_CONTROLLER_HOME_MISMATCH');
  }
  const compatibility = value.databaseSchemaCompatibility as Record<string, unknown> | undefined;
  const minimum = Number(compatibility?.minimum);
  const maximum = Number(compatibility?.maximum);
  if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum > maximum) {
    throw new Error('RELEASE_MANIFEST_INVALID: databaseSchemaCompatibility is invalid');
  }
  if (CONTROL_PLANE_SCHEMA_VERSION < minimum || CONTROL_PLANE_SCHEMA_VERSION > maximum) {
    throw new Error(
      `RELEASE_DATABASE_SCHEMA_INCOMPATIBLE: runtime=${CONTROL_PLANE_SCHEMA_VERSION} supported=${minimum}-${maximum}`,
    );
  }
  let diagnosticEntrypoint: 'forge-cli' | undefined;
  let diagnosticArtifactIdentity: string | undefined;
  if (value.diagnosticEntrypoint !== undefined) {
    const diagnosticEntry = requireString(value.diagnosticEntrypoint, 'diagnosticEntrypoint');
    if (diagnosticEntry !== 'forge-cli') {
      throw new Error(`RELEASE_MANIFEST_INVALID: diagnosticEntrypoint must be forge-cli, got ${diagnosticEntry}`);
    }
    diagnosticEntrypoint = 'forge-cli';
    diagnosticArtifactIdentity = requireString(value.diagnosticArtifactIdentity, 'diagnosticArtifactIdentity');
  } else if (value.diagnosticArtifactIdentity !== undefined) {
    throw new Error('RELEASE_MANIFEST_INVALID: diagnosticArtifactIdentity requires diagnosticEntrypoint');
  }
  const codeGraphFields = [
    value.codeGraphNodeEntrypoint,
    value.codeGraphNodeArtifactIdentity,
    value.codeGraphSidecarEntrypoint,
    value.codeGraphSidecarArtifactIdentity,
    value.codeGraphLibraryRoot,
    value.codeGraphLibraryArtifactIdentity,
  ];
  const hasCodeGraphRuntime = codeGraphFields.some((entry) => entry !== undefined);
  let codeGraphRuntime: Pick<RuntimeReleaseManifest,
    'codeGraphNodeEntrypoint' | 'codeGraphNodeArtifactIdentity'
    | 'codeGraphSidecarEntrypoint' | 'codeGraphSidecarArtifactIdentity'
    | 'codeGraphLibraryRoot' | 'codeGraphLibraryArtifactIdentity'> | undefined;
  if (hasCodeGraphRuntime) {
    const nodeEntrypoint = requireString(value.codeGraphNodeEntrypoint, 'codeGraphNodeEntrypoint');
    const sidecarEntrypoint = requireString(value.codeGraphSidecarEntrypoint, 'codeGraphSidecarEntrypoint');
    const libraryRoot = requireString(value.codeGraphLibraryRoot, 'codeGraphLibraryRoot');
    if (nodeEntrypoint !== 'codegraph-node' || sidecarEntrypoint !== 'codegraph-sidecar.cjs' || libraryRoot !== 'codegraph-lib') {
      throw new Error('RELEASE_MANIFEST_INVALID: CodeGraph release paths must use the canonical co-located names');
    }
    codeGraphRuntime = {
      codeGraphNodeEntrypoint: 'codegraph-node',
      codeGraphNodeArtifactIdentity: requireString(value.codeGraphNodeArtifactIdentity, 'codeGraphNodeArtifactIdentity'),
      codeGraphSidecarEntrypoint: 'codegraph-sidecar.cjs',
      codeGraphSidecarArtifactIdentity: requireString(value.codeGraphSidecarArtifactIdentity, 'codeGraphSidecarArtifactIdentity'),
      codeGraphLibraryRoot: 'codegraph-lib',
      codeGraphLibraryArtifactIdentity: requireString(value.codeGraphLibraryArtifactIdentity, 'codeGraphLibraryArtifactIdentity'),
    };
  }

  const argumentsValue = value.arguments;
  if (!Array.isArray(argumentsValue) || argumentsValue.some((item) => typeof item !== 'string')) {
    throw new Error('RELEASE_MANIFEST_INVALID: arguments must be a string array');
  }
  const workerProtocolVersion = Number(value.workerProtocolVersion);
  if (!Number.isInteger(workerProtocolVersion) || workerProtocolVersion < 1) {
    throw new Error('RELEASE_MANIFEST_INVALID: workerProtocolVersion must be a positive integer');
  }
  const createdAt = requireString(value.createdAt, 'createdAt');
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('RELEASE_MANIFEST_INVALID: createdAt is invalid');

  return {
    schemaVersion: 1,
    releaseId: requireString(value.releaseId, 'releaseId'),
    artifactIdentity: requireString(value.artifactIdentity, 'artifactIdentity'),
    entrypoint: 'forge-runtime',
    ...(diagnosticEntrypoint ? { diagnosticEntrypoint, diagnosticArtifactIdentity } : {}),
    ...(codeGraphRuntime ?? {}),
    arguments: argumentsValue as string[],
    configurationSchemaVersion: 1,
    controllerHome,
    databaseSchemaCompatibility: { minimum, maximum },
    workerProtocolVersion,
    ...(typeof value.sourceCommit === 'string' && value.sourceCommit.trim() ? { sourceCommit: value.sourceCommit.trim() } : {}),
    ...(typeof value.releaseRevision === 'string' && value.releaseRevision.trim() ? { releaseRevision: value.releaseRevision.trim() } : {}),
    ...(typeof value.cleanWorkspace === 'boolean' ? { cleanWorkspace: value.cleanWorkspace } : {}),
    createdAt,
  };
}
