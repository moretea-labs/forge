import { createHash, randomUUID } from 'crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { resolveControllerHome } from '../src/cli/repositories/controller-home';
import { loadRuntimeReleaseManifest } from '../src/runtime/root/release-manifest';
import { readRuntimeReleaseAuthority } from '../src/runtime/root/release-store';
import { renderWorkflowSupervisorNativeManifest } from './native-messaging/manifest';
import { WORKFLOW_SUPERVISOR_NATIVE_HOST_NAME } from './native-messaging/host';
const EXTENSION_FILES = ['manifest.json', 'background.js', 'content.js', 'core.js'] as const;
const EXTENSION_ID = /^[a-p]{32}$/;
export interface WorkflowSupervisorBrowserInstallation {
  browser: 'chrome' | 'chromium';
  userDataRoot: string;
  nativeMessagingRoot: string;
}
export interface WorkflowSupervisorExtensionBinding {
  browser: WorkflowSupervisorBrowserInstallation['browser'];
  userDataRoot: string;
  profileDirectory: string;
  extensionId: string;
  statePath: string;
}
interface ActiveBrowserAdapterRelease {
  releaseId: string;
  extensionSourcePath: string;
  nativeHostSourcePath: string;
  nativeHostArtifactIdentity: string;
}
export interface WorkflowSupervisorBrowserAdapterDependencies {
  homeDir?: string;
  browserInstallations?: readonly WorkflowSupervisorBrowserInstallation[];
  activeRelease?: (controllerHome: string) => ActiveBrowserAdapterRelease;
}
export interface WorkflowSupervisorBrowserAdapterStatus {
  state: 'ready' | 'not_installed' | 'projection_stale' | 'extension_authorization_required' | 'runtime_release_incomplete';
  extensionPath: string;
  nativeHostPath: string;
  activeReleaseId?: string;
  extensionBindings: WorkflowSupervisorExtensionBinding[];
  nativeManifestPaths: string[];
  projectionCurrent: boolean;
  detail: string;
}
function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function controllerPaths(controllerHome: string): { root: string; extensionPath: string; nativeHostPath: string } {
  const root = join(resolveControllerHome(controllerHome), 'supervisor', 'browser-adapter');
  return {
    root,
    extensionPath: join(root, 'chrome-extension'),
    nativeHostPath: join(root, 'forge-workflow-supervisor-native-host'),
  };
}
function defaultBrowserInstallations(homeDir = process.env.HOME ?? homedir()): WorkflowSupervisorBrowserInstallation[] {
  return [
    {
      browser: 'chrome',
      userDataRoot: join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome'),
      nativeMessagingRoot: join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'),
    },
    {
      browser: 'chromium',
      userDataRoot: join(homeDir, 'Library', 'Application Support', 'Chromium'),
      nativeMessagingRoot: join(homeDir, 'Library', 'Application Support', 'Chromium', 'NativeMessagingHosts'),
    },
  ];
}
function activeBrowserAdapterRelease(controllerHome: string): ActiveBrowserAdapterRelease {
  const home = resolveControllerHome(controllerHome);
  const authority = readRuntimeReleaseAuthority(home);
  if (!authority) throw new Error('WORKFLOW_SUPERVISOR_BROWSER_RUNTIME_RELEASE_MISSING');
  const manifest = loadRuntimeReleaseManifest(authority.active.manifestPath, home);
  if (!manifest.packageRoot
    || !manifest.workflowSupervisorNativeHostEntrypoint
    || !manifest.workflowSupervisorNativeHostArtifactIdentity) {
    throw new Error('WORKFLOW_SUPERVISOR_BROWSER_RUNTIME_RELEASE_INCOMPLETE');
  }
  const releaseRoot = dirname(authority.active.manifestPath);
  return {
    releaseId: authority.active.releaseId,
    extensionSourcePath: join(releaseRoot, manifest.packageRoot, 'supervisor', 'chrome-extension'),
    nativeHostSourcePath: join(releaseRoot, manifest.workflowSupervisorNativeHostEntrypoint),
    nativeHostArtifactIdentity: manifest.workflowSupervisorNativeHostArtifactIdentity,
  };
}
function assertRegularFile(path: string, code: string): void {
  if (!existsSync(path)) throw new Error(code + ': ' + path);
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile()) throw new Error(code + ': ' + path);
}
function projectExtension(source: string, destination: string): void {
  const staging = destination + '.staging-' + randomUUID().slice(0, 12);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    for (const file of EXTENSION_FILES) {
      const sourcePath = join(source, file);
      assertRegularFile(sourcePath, 'WORKFLOW_SUPERVISOR_EXTENSION_SOURCE_INVALID');
      writeFileSync(join(staging, file), readFileSync(sourcePath), { mode: 0o600 });
    }
    rmSync(destination, { recursive: true, force: true });
    renameSync(staging, destination);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
function projectNativeHost(source: string, expectedIdentity: string, destination: string): void {
  assertRegularFile(source, 'WORKFLOW_SUPERVISOR_NATIVE_HOST_SOURCE_INVALID');
  if ('sha256:' + sha256(source) !== expectedIdentity) throw new Error('WORKFLOW_SUPERVISOR_NATIVE_HOST_IDENTITY_MISMATCH');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = destination + '.' + randomUUID().slice(0, 12) + '.tmp';
  writeFileSync(temporary, readFileSync(source), { mode: 0o700 });
  chmodSync(temporary, 0o700);
  renameSync(temporary, destination);
  if ('sha256:' + sha256(destination) !== expectedIdentity) {
    rmSync(destination, { force: true });
    throw new Error('WORKFLOW_SUPERVISOR_NATIVE_HOST_PROJECTION_IDENTITY_MISMATCH');
  }
}
function disabledExtensionSetting(setting: Record<string, unknown>): boolean {
  if (setting.state === 0) return true;
  const reasons = setting.disable_reasons;
  if (Array.isArray(reasons)) return reasons.length > 0;
  if (reasons && typeof reasons === 'object') return Object.keys(reasons as Record<string, unknown>).length > 0;
  return typeof reasons === 'number' && reasons !== 0;
}
function discoverBindings(
  extensionPath: string,
  installations: readonly WorkflowSupervisorBrowserInstallation[],
): WorkflowSupervisorExtensionBinding[] {
  const result: WorkflowSupervisorExtensionBinding[] = [];
  const seen = new Set<string>();
  for (const installation of installations) {
    if (!existsSync(installation.userDataRoot)) continue;
    const profiles = readdirSync(installation.userDataRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(installation.userDataRoot, name, 'Preferences')))
      .slice(0, 64);
    for (const profileDirectory of profiles) {
      for (const fileName of ['Preferences', 'Secure Preferences'] as const) {
        const statePath = join(installation.userDataRoot, profileDirectory, fileName);
        if (!existsSync(statePath)) continue;
        try {
          const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
            extensions?: { settings?: Record<string, Record<string, unknown>> };
          };
          for (const [extensionId, setting] of Object.entries(state.extensions?.settings ?? {})) {
            if (!EXTENSION_ID.test(extensionId) || disabledExtensionSetting(setting)) continue;
            const rawPath = [setting.path, setting.path_safe, setting.location_path]
              .find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
            if (!rawPath || resolve(rawPath) !== resolve(extensionPath)) continue;
            const key = installation.userDataRoot + '\0' + profileDirectory + '\0' + extensionId;
            if (seen.has(key)) continue;
            seen.add(key);
            result.push({
              browser: installation.browser,
              userDataRoot: installation.userDataRoot,
              profileDirectory,
              extensionId,
              statePath,
            });
          }
        } catch {
          // Browser state is advisory evidence; keep scanning other bounded profiles/files.
        }
      }
    }
  }
  return result;
}
function nativeManifestPath(installation: WorkflowSupervisorBrowserInstallation): string {
  return join(installation.nativeMessagingRoot, WORKFLOW_SUPERVISOR_NATIVE_HOST_NAME + '.json');
}
function nativeManifestReady(path: string, nativeHostPath: string, extensionIds: readonly string[]): boolean {
  if (!existsSync(path)) return false;
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { path?: unknown; allowed_origins?: unknown };
    const expectedOrigins = extensionIds.map((id) => 'chrome-extension://' + id + '/').sort();
    const observedOrigins = Array.isArray(manifest.allowed_origins)
      ? manifest.allowed_origins.filter((value): value is string => typeof value === 'string').sort()
      : [];
    return manifest.path === nativeHostPath && JSON.stringify(observedOrigins) === JSON.stringify(expectedOrigins);
  } catch {
    return false;
  }
}
function extensionProjectionCurrent(source: string, destination: string): boolean {
  return EXTENSION_FILES.every((file) => {
    const sourcePath = join(source, file);
    const destinationPath = join(destination, file);
    return existsSync(sourcePath) && existsSync(destinationPath) && sha256(sourcePath) === sha256(destinationPath);
  });
}
function inspectWithRelease(
  controllerHome: string,
  release: ActiveBrowserAdapterRelease,
  dependencies: WorkflowSupervisorBrowserAdapterDependencies,
): WorkflowSupervisorBrowserAdapterStatus {
  const paths = controllerPaths(controllerHome);
  const installations = dependencies.browserInstallations ?? defaultBrowserInstallations(dependencies.homeDir);
  const hostCurrent = existsSync(paths.nativeHostPath)
    && 'sha256:' + sha256(paths.nativeHostPath) === release.nativeHostArtifactIdentity;
  const extensionCurrent = existsSync(paths.extensionPath)
    && extensionProjectionCurrent(release.extensionSourcePath, paths.extensionPath);
  const projectionCurrent = hostCurrent && extensionCurrent;
  const extensionBindings = projectionCurrent ? discoverBindings(paths.extensionPath, installations) : [];
  const manifestPaths: string[] = [];
  let allManifestsReady = extensionBindings.length > 0;
  for (const installation of installations) {
    const ids = extensionBindings
      .filter((binding) => binding.userDataRoot === installation.userDataRoot)
      .map((binding) => binding.extensionId)
      .filter((id, index, values) => values.indexOf(id) === index)
      .sort();
    if (ids.length === 0) continue;
    const path = nativeManifestPath(installation);
    manifestPaths.push(path);
    allManifestsReady &&= nativeManifestReady(path, paths.nativeHostPath, ids);
  }
  if (!projectionCurrent) {
    return {
      state: existsSync(paths.extensionPath) || existsSync(paths.nativeHostPath) ? 'projection_stale' : 'not_installed',
      extensionPath: paths.extensionPath,
      nativeHostPath: paths.nativeHostPath,
      activeReleaseId: release.releaseId,
      extensionBindings,
      nativeManifestPaths: manifestPaths,
      projectionCurrent,
      detail: 'Controller browser-adapter projection does not match the active Runtime release.',
    };
  }
  if (extensionBindings.length === 0) {
    return {
      state: 'extension_authorization_required',
      extensionPath: paths.extensionPath,
      nativeHostPath: paths.nativeHostPath,
      activeReleaseId: release.releaseId,
      extensionBindings,
      nativeManifestPaths: manifestPaths,
      projectionCurrent,
      detail: 'Chrome has not enabled the stable Forge Workflow Supervisor extension path in a supported profile.',
    };
  }
  return {
    state: allManifestsReady ? 'ready' : 'projection_stale',
    extensionPath: paths.extensionPath,
    nativeHostPath: paths.nativeHostPath,
    activeReleaseId: release.releaseId,
    extensionBindings,
    nativeManifestPaths: manifestPaths,
    projectionCurrent,
    detail: allManifestsReady
      ? 'Workflow Supervisor browser adapter is projected from the active Runtime release and registered for exact enabled extension origins.'
      : 'Chrome extension identity is known but its Native Messaging host projection is stale.',
  };
}
export function inspectWorkflowSupervisorBrowserAdapter(
  controllerHome: string,
  dependencies: WorkflowSupervisorBrowserAdapterDependencies = {},
): WorkflowSupervisorBrowserAdapterStatus {
  const paths = controllerPaths(controllerHome);
  try {
    const release = (dependencies.activeRelease ?? activeBrowserAdapterRelease)(controllerHome);
    return inspectWithRelease(controllerHome, release, dependencies);
  } catch (error) {
    return {
      state: 'runtime_release_incomplete',
      extensionPath: paths.extensionPath,
      nativeHostPath: paths.nativeHostPath,
      extensionBindings: [],
      nativeManifestPaths: [],
      projectionCurrent: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
export function installWorkflowSupervisorBrowserAdapter(
  controllerHome: string,
  dependencies: WorkflowSupervisorBrowserAdapterDependencies = {},
): WorkflowSupervisorBrowserAdapterStatus {
  const release = (dependencies.activeRelease ?? activeBrowserAdapterRelease)(controllerHome);
  const paths = controllerPaths(controllerHome);
  projectExtension(release.extensionSourcePath, paths.extensionPath);
  projectNativeHost(release.nativeHostSourcePath, release.nativeHostArtifactIdentity, paths.nativeHostPath);
  const installations = dependencies.browserInstallations ?? defaultBrowserInstallations(dependencies.homeDir);
  const bindings = discoverBindings(paths.extensionPath, installations);
  for (const installation of installations) {
    const extensionIds = bindings
      .filter((binding) => binding.userDataRoot === installation.userDataRoot)
      .map((binding) => binding.extensionId)
      .filter((id, index, values) => values.indexOf(id) === index)
      .sort();
    if (extensionIds.length === 0) continue;
    const path = nativeManifestPath(installation);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = path + '.' + randomUUID().slice(0, 12) + '.tmp';
    writeFileSync(temporary, renderWorkflowSupervisorNativeManifest({
      executablePath: paths.nativeHostPath,
      extensionIds,
    }), { mode: 0o600 });
    renameSync(temporary, path);
  }
  return inspectWithRelease(controllerHome, release, dependencies);
}
