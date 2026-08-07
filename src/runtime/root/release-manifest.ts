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
