import { createHash } from 'crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { CONTROL_PLANE_SCHEMA_VERSION } from '../control-plane/persistence/sqlite-store';
import type { RuntimeReleaseManifest } from './types';

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`RELEASE_MANIFEST_INVALID: ${field} is required`);
  return value.trim();
}

function canonicalExistingPathIdentity(path: string): string {
  const resolved = resolve(path);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

function requireSha256Identity(value: unknown, field: string): string {
  const identity = requireString(value, field);
  if (!/^sha256:[a-f0-9]{64}$/i.test(identity)) {
    throw new Error(`RELEASE_MANIFEST_INVALID: ${field} must be sha256:<64 hex>`);
  }
  return identity;
}

type RuntimeComponentPair<KEntry extends keyof RuntimeReleaseManifest, KIdentity extends keyof RuntimeReleaseManifest> = Pick<
  RuntimeReleaseManifest,
  KEntry | KIdentity
>;

function optionalRuntimeComponent<
  KEntry extends keyof RuntimeReleaseManifest,
  KIdentity extends keyof RuntimeReleaseManifest,
>(input: {
  value: Record<string, unknown>;
  entryField: KEntry;
  identityField: KIdentity;
  canonicalEntry: RuntimeReleaseManifest[KEntry];
}): RuntimeComponentPair<KEntry, KIdentity> | undefined {
  const rawEntry = input.value[input.entryField as string];
  const rawIdentity = input.value[input.identityField as string];
  if (rawEntry === undefined && rawIdentity === undefined) return undefined;
  const entry = requireString(rawEntry, input.entryField as string);
  if (entry !== input.canonicalEntry) {
    throw new Error(`RELEASE_MANIFEST_INVALID: ${String(input.entryField)} must be ${String(input.canonicalEntry)}, got ${entry}`);
  }
  const identity = requireSha256Identity(rawIdentity, input.identityField as string);
  return {
    [input.entryField]: input.canonicalEntry,
    [input.identityField]: identity,
  } as RuntimeComponentPair<KEntry, KIdentity>;
}

export const COMPILED_RUNTIME_RELEASE_COMPONENT_FIELDS = [
  'diagnosticEntrypoint', 'diagnosticArtifactIdentity',
  'browserNodeBridgeEntrypoint', 'browserNodeBridgeArtifactIdentity',
  'browserHandoffEntrypoint', 'browserHandoffArtifactIdentity',
  'processRunnerEntrypoint', 'processRunnerArtifactIdentity',
  'checkRunnerEntrypoint', 'checkRunnerArtifactIdentity',
  'pluginActionSidecarEntrypoint', 'pluginActionSidecarArtifactIdentity',
  'externalPluginProbeEntrypoint', 'externalPluginProbeArtifactIdentity',
  'codeGraphNodeEntrypoint', 'codeGraphNodeArtifactIdentity',
  'codeGraphSidecarEntrypoint', 'codeGraphSidecarArtifactIdentity',
  'codeGraphLibraryRoot', 'codeGraphLibraryArtifactIdentity',
  'packageRoot', 'packageArtifactIdentity',
  'controllerUiRoot', 'controllerUiArtifactIdentity',
] as const satisfies readonly (keyof RuntimeReleaseManifest)[];

/**
 * Compiled self-host candidates have a closed execution surface. Package
 * launcher releases are a separate source-backed release form and therefore
 * intentionally do not satisfy this contract.
 */
export type CompleteCompiledRuntimeReleaseManifest = RuntimeReleaseManifest & Required<Pick<
  RuntimeReleaseManifest,
  typeof COMPILED_RUNTIME_RELEASE_COMPONENT_FIELDS[number]
>>;

export function requireCompleteCompiledRuntimeReleaseManifest(
  manifest: RuntimeReleaseManifest,
): asserts manifest is CompleteCompiledRuntimeReleaseManifest {
  for (const field of COMPILED_RUNTIME_RELEASE_COMPONENT_FIELDS) {
    if (manifest[field] === undefined) {
      throw new Error(`RUNTIME_RELEASE_COMPILED_COMPONENT_MISSING: ${field}`);
    }
  }
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
  if (canonicalExistingPathIdentity(controllerHome) !== canonicalExistingPathIdentity(expectedControllerHome)) {
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
  const diagnostic = optionalRuntimeComponent({
    value,
    entryField: 'diagnosticEntrypoint',
    identityField: 'diagnosticArtifactIdentity',
    canonicalEntry: 'forge-cli',
  });
  const browserNodeBridge = optionalRuntimeComponent({
    value,
    entryField: 'browserNodeBridgeEntrypoint',
    identityField: 'browserNodeBridgeArtifactIdentity',
    canonicalEntry: 'browser-node-bridge-host.js',
  });
  const browserHandoff = optionalRuntimeComponent({
    value,
    entryField: 'browserHandoffEntrypoint',
    identityField: 'browserHandoffArtifactIdentity',
    canonicalEntry: 'browser-handoff-host.js',
  });
  const processRunner = optionalRuntimeComponent({
    value,
    entryField: 'processRunnerEntrypoint',
    identityField: 'processRunnerArtifactIdentity',
    canonicalEntry: 'process-runner.js',
  });
  const checkRunner = optionalRuntimeComponent({
    value,
    entryField: 'checkRunnerEntrypoint',
    identityField: 'checkRunnerArtifactIdentity',
    canonicalEntry: 'forge-check-runner',
  });
  const pluginActionSidecar = optionalRuntimeComponent({
    value,
    entryField: 'pluginActionSidecarEntrypoint',
    identityField: 'pluginActionSidecarArtifactIdentity',
    canonicalEntry: 'forge-plugin-action-sidecar',
  });
  const externalPluginProbe = optionalRuntimeComponent({
    value,
    entryField: 'externalPluginProbeEntrypoint',
    identityField: 'externalPluginProbeArtifactIdentity',
    canonicalEntry: 'external-unix-socket-probe.cjs',
  });
  const packageSnapshot = optionalRuntimeComponent({
    value,
    entryField: 'packageRoot',
    identityField: 'packageArtifactIdentity',
    canonicalEntry: 'package',
  });
  const controllerUi = optionalRuntimeComponent({
    value,
    entryField: 'controllerUiRoot',
    identityField: 'controllerUiArtifactIdentity',
    canonicalEntry: 'ui-dist',
  });
  const browserAutomationHelperFields = [
    value.browserAutomationHelperEntrypoint,
    value.browserAutomationHelperArtifactIdentity,
    value.browserAutomationHelperContractIdentity,
  ];
  const hasBrowserAutomationHelper = browserAutomationHelperFields.some((entry) => entry !== undefined);
  let browserAutomationHelper: Pick<RuntimeReleaseManifest,
    'browserAutomationHelperEntrypoint' | 'browserAutomationHelperArtifactIdentity' | 'browserAutomationHelperContractIdentity'> | undefined;
  if (hasBrowserAutomationHelper) {
    const helperEntrypoint = requireString(value.browserAutomationHelperEntrypoint, 'browserAutomationHelperEntrypoint');
    if (helperEntrypoint !== 'browser-automation-helper') {
      throw new Error(`RELEASE_MANIFEST_INVALID: browserAutomationHelperEntrypoint must be browser-automation-helper, got ${helperEntrypoint}`);
    }
    const helperArtifactIdentity = requireString(value.browserAutomationHelperArtifactIdentity, 'browserAutomationHelperArtifactIdentity');
    const helperContractIdentity = requireString(value.browserAutomationHelperContractIdentity, 'browserAutomationHelperContractIdentity');
    if (!/^sha256:[a-f0-9]{64}$/i.test(helperArtifactIdentity)) {
      throw new Error('RELEASE_MANIFEST_INVALID: browserAutomationHelperArtifactIdentity must be sha256:<64 hex>');
    }
    if (!/^sha256:[a-f0-9]{64}$/i.test(helperContractIdentity)) {
      throw new Error('RELEASE_MANIFEST_INVALID: browserAutomationHelperContractIdentity must be sha256:<64 hex>');
    }
    browserAutomationHelper = {
      browserAutomationHelperEntrypoint: 'browser-automation-helper',
      browserAutomationHelperArtifactIdentity: helperArtifactIdentity,
      browserAutomationHelperContractIdentity: helperContractIdentity,
    };
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
      codeGraphNodeArtifactIdentity: requireSha256Identity(value.codeGraphNodeArtifactIdentity, 'codeGraphNodeArtifactIdentity'),
      codeGraphSidecarEntrypoint: 'codegraph-sidecar.cjs',
      codeGraphSidecarArtifactIdentity: requireSha256Identity(value.codeGraphSidecarArtifactIdentity, 'codeGraphSidecarArtifactIdentity'),
      codeGraphLibraryRoot: 'codegraph-lib',
      codeGraphLibraryArtifactIdentity: requireSha256Identity(value.codeGraphLibraryArtifactIdentity, 'codeGraphLibraryArtifactIdentity'),
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
    ...(diagnostic ?? {}),
    ...(browserNodeBridge ?? {}),
    ...(browserHandoff ?? {}),
    ...(processRunner ?? {}),
    ...(checkRunner ?? {}),
    ...(pluginActionSidecar ?? {}),
    ...(externalPluginProbe ?? {}),
    ...(browserAutomationHelper ?? {}),
    ...(codeGraphRuntime ?? {}),
    ...(packageSnapshot ?? {}),
    ...(controllerUi ?? {}),
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

export interface RuntimeReleaseExecutionSurface {
  manifest: RuntimeReleaseManifest;
  releaseRoot: string;
  entries: Array<{
    name: 'process_runner' | 'check_runner';
    path: string;
    artifactIdentity: string;
  }>;
}

/**
 * Validate the manifest-owned minimum Process Runtime execution surface.
 * This is physical artifact evidence only. Release publication, activation,
 * known-good and rollback authority remain owned by their existing lifecycle.
 */
export function assertRuntimeReleaseExecutionSurface(
  manifestPath: string,
  expectedControllerHome: string,
): RuntimeReleaseExecutionSurface {
  const resolvedManifestPath = resolve(manifestPath);
  const manifest = loadRuntimeReleaseManifest(resolvedManifestPath, expectedControllerHome);
  if (!manifest.processRunnerEntrypoint || !manifest.processRunnerArtifactIdentity
    || !manifest.checkRunnerEntrypoint || !manifest.checkRunnerArtifactIdentity) {
    throw new Error('RUNTIME_RELEASE_PROCESS_RUNTIME_SURFACE_INCOMPLETE: process-runner.js and forge-check-runner are required');
  }
  const releaseRoot = dirname(resolvedManifestPath);
  const entries: RuntimeReleaseExecutionSurface['entries'] = [
    {
      name: 'process_runner',
      path: join(releaseRoot, manifest.processRunnerEntrypoint),
      artifactIdentity: manifest.processRunnerArtifactIdentity,
    },
    {
      name: 'check_runner',
      path: join(releaseRoot, manifest.checkRunnerEntrypoint),
      artifactIdentity: manifest.checkRunnerArtifactIdentity,
    },
  ];
  for (const entry of entries) {
    if (!existsSync(entry.path)) throw new Error(`RUNTIME_RELEASE_EXECUTION_ENTRY_MISSING: ${entry.name}: ${entry.path}`);
    const status = lstatSync(entry.path);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new Error(`RUNTIME_RELEASE_EXECUTION_ENTRY_NOT_REGULAR: ${entry.name}: ${entry.path}`);
    }
    if ((status.mode & 0o111) === 0) {
      throw new Error(`RUNTIME_RELEASE_EXECUTION_ENTRY_NOT_EXECUTABLE: ${entry.name}: ${entry.path}`);
    }
    const observed = `sha256:${createHash('sha256').update(readFileSync(entry.path)).digest('hex')}`;
    if (observed !== entry.artifactIdentity) {
      throw new Error(`RUNTIME_RELEASE_EXECUTION_ENTRY_IDENTITY_MISMATCH: ${entry.name}: expected ${entry.artifactIdentity} observed ${observed}`);
    }
  }
  return { manifest, releaseRoot, entries };
}
