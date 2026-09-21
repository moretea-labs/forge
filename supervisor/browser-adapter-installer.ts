import { createHash, randomUUID } from 'crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { resolveControllerHome } from '../src/cli/repositories/controller-home';
import { loadRuntimeReleaseManifest } from '../src/runtime/root/release-manifest';
import { readRuntimeReleaseAuthority } from '../src/runtime/root/release-store';
import { ensureBrowserStateInControllerHome } from '../src/runtime/plugins/browser-session-store';
import { renderWorkflowSupervisorNativeManifest } from './native-messaging/manifest';
import { WORKFLOW_SUPERVISOR_NATIVE_HOST_NAME } from './native-messaging/host';

const EXTENSION_FILES = ['manifest.json', 'background.js', 'content.js', 'core.js'] as const;
const FORGE_NATIVE_MESSAGING_DECLARATION = 'forge-native-messaging-host.json';

export interface WorkflowSupervisorBrowserInstallation {
  browser: 'chrome' | 'chrome-for-testing' | 'chromium' | 'vivaldi' | 'forge-managed';
  nativeMessagingRoot: string;
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
  repository?: { repoId: string; repoRoot: string };
}
export interface WorkflowSupervisorBrowserAdapterStatus {
  state: 'ready' | 'not_installed' | 'projection_stale' | 'runtime_release_incomplete';
  extensionPath: string;
  extensionId?: string;
  nativeHostPath: string;
  activeReleaseId?: string;
  nativeManifestPaths: string[];
  projectionCurrent: boolean;
  detail: string;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
export function workflowSupervisorExtensionIdFromManifestKey(value: string): string {
  const key = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key)) throw new Error('WORKFLOW_SUPERVISOR_EXTENSION_KEY_INVALID');
  const bytes = Buffer.from(key, 'base64');
  if (bytes.length < 64 || bytes.toString('base64').replace(/=+$/,'') !== key.replace(/=+$/,'')) {
    throw new Error('WORKFLOW_SUPERVISOR_EXTENSION_KEY_INVALID');
  }
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, (nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16)));
}
function extensionId(path: string): string {
  const manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as { key?: unknown };
  if (typeof manifest.key !== 'string') throw new Error('WORKFLOW_SUPERVISOR_EXTENSION_KEY_REQUIRED');
  return workflowSupervisorExtensionIdFromManifestKey(manifest.key);
}
function controllerPaths(controllerHome: string) {
  const root = join(resolveControllerHome(controllerHome), 'supervisor', 'browser-adapter');
  return {
    extensionPath: join(root, 'chrome-extension'),
    nativeHostPath: join(root, 'forge-workflow-supervisor-native-host'),
  };
}
function defaultBrowserInstallations(
  controllerHome: string,
  homeDir = process.env.HOME ?? homedir(),
  repository?: { repoId: string; repoRoot: string },
): WorkflowSupervisorBrowserInstallation[] {
  const installations: WorkflowSupervisorBrowserInstallation[] = [
    { browser: 'chrome', nativeMessagingRoot: join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts') },
    { browser: 'chrome-for-testing', nativeMessagingRoot: join(homeDir, 'Library', 'Application Support', 'Google', 'ChromeForTesting', 'NativeMessagingHosts') },
    { browser: 'chromium', nativeMessagingRoot: join(homeDir, 'Library', 'Application Support', 'Chromium', 'NativeMessagingHosts') },
    { browser: 'vivaldi', nativeMessagingRoot: join(homeDir, 'Library', 'Application Support', 'Vivaldi', 'NativeMessagingHosts') },
  ];
  if (repository) {
    const browserStateRoot = ensureBrowserStateInControllerHome(controllerHome, repository.repoId, repository.repoRoot);
    installations.push({ browser: 'forge-managed', nativeMessagingRoot: join(browserStateRoot, 'profiles', 'default', 'NativeMessagingHosts') });
  }
  return installations;
}
function activeBrowserAdapterRelease(controllerHome: string): ActiveBrowserAdapterRelease {
  const home = resolveControllerHome(controllerHome);
  const authority = readRuntimeReleaseAuthority(home);
  if (!authority) throw new Error('WORKFLOW_SUPERVISOR_BROWSER_RUNTIME_RELEASE_MISSING');
  const manifest = loadRuntimeReleaseManifest(authority.active.manifestPath, home);
  if (!manifest.packageRoot || !manifest.workflowSupervisorNativeHostEntrypoint || !manifest.workflowSupervisorNativeHostArtifactIdentity) {
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
}
function extensionProjectionCurrent(source: string, destination: string): boolean {
  return EXTENSION_FILES.every((file) => {
    const sourcePath = join(source, file), destinationPath = join(destination, file);
    return existsSync(sourcePath) && existsSync(destinationPath) && sha256(sourcePath) === sha256(destinationPath);
  });
}
function nativeManifestPath(installation: WorkflowSupervisorBrowserInstallation): string {
  return join(installation.nativeMessagingRoot, WORKFLOW_SUPERVISOR_NATIVE_HOST_NAME + '.json');
}
function nativeManifestReady(path: string, nativeHostPath: string, exactExtensionId: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { path?: unknown; allowed_origins?: unknown };
    return manifest.path === nativeHostPath
      && JSON.stringify(manifest.allowed_origins) === JSON.stringify(['chrome-extension://' + exactExtensionId + '/']);
  } catch { return false; }
}
function inspectWithRelease(
  controllerHome: string,
  release: ActiveBrowserAdapterRelease,
  dependencies: WorkflowSupervisorBrowserAdapterDependencies,
): WorkflowSupervisorBrowserAdapterStatus {
  const paths = controllerPaths(controllerHome);
  const exactExtensionId = extensionId(release.extensionSourcePath);
  const hostCurrent = existsSync(paths.nativeHostPath) && 'sha256:' + sha256(paths.nativeHostPath) === release.nativeHostArtifactIdentity;
  const extensionCurrent = existsSync(paths.extensionPath)
    && extensionProjectionCurrent(release.extensionSourcePath, paths.extensionPath)
    && nativeManifestReady(join(paths.extensionPath, FORGE_NATIVE_MESSAGING_DECLARATION), paths.nativeHostPath, exactExtensionId);
  const installations = dependencies.browserInstallations ?? defaultBrowserInstallations(controllerHome, dependencies.homeDir, dependencies.repository);
  const nativeManifestPaths = installations.map(nativeManifestPath);
  const manifestsCurrent = nativeManifestPaths.every((path) => nativeManifestReady(path, paths.nativeHostPath, exactExtensionId));
  const projectionCurrent = hostCurrent && extensionCurrent && manifestsCurrent;
  return {
    state: projectionCurrent ? 'ready' : (existsSync(paths.extensionPath) || existsSync(paths.nativeHostPath) ? 'projection_stale' : 'not_installed'),
    extensionPath: paths.extensionPath,
    extensionId: exactExtensionId,
    nativeHostPath: paths.nativeHostPath,
    activeReleaseId: release.releaseId,
    nativeManifestPaths,
    projectionCurrent,
    detail: projectionCurrent
      ? 'Workflow Supervisor browser adapter is projected from the active Runtime release and Native Messaging is registered for the package-derived extension id. Live browser connectivity is proven separately by Supervisor browser_discovery.'
      : 'Controller browser-adapter projection does not match the active Runtime release.',
  };
}
export function inspectWorkflowSupervisorBrowserAdapter(
  controllerHome: string,
  dependencies: WorkflowSupervisorBrowserAdapterDependencies = {},
): WorkflowSupervisorBrowserAdapterStatus {
  const paths = controllerPaths(controllerHome);
  try {
    return inspectWithRelease(controllerHome, (dependencies.activeRelease ?? activeBrowserAdapterRelease)(controllerHome), dependencies);
  } catch (error) {
    return {
      state: 'runtime_release_incomplete',
      extensionPath: paths.extensionPath,
      nativeHostPath: paths.nativeHostPath,
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
  const exactExtensionId = extensionId(release.extensionSourcePath);
  projectExtension(release.extensionSourcePath, paths.extensionPath);
  projectNativeHost(release.nativeHostSourcePath, release.nativeHostArtifactIdentity, paths.nativeHostPath);
  writeFileSync(
    join(paths.extensionPath, FORGE_NATIVE_MESSAGING_DECLARATION),
    renderWorkflowSupervisorNativeManifest({ executablePath: paths.nativeHostPath, extensionId: exactExtensionId }),
    { mode: 0o600 },
  );
  for (const installation of dependencies.browserInstallations ?? defaultBrowserInstallations(controllerHome, dependencies.homeDir, dependencies.repository)) {
    const path = nativeManifestPath(installation);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = path + '.' + randomUUID().slice(0, 12) + '.tmp';
    writeFileSync(temporary, renderWorkflowSupervisorNativeManifest({
      executablePath: paths.nativeHostPath,
      extensionId: exactExtensionId,
    }), { mode: 0o600 });
    renameSync(temporary, path);
  }
  return inspectWithRelease(controllerHome, release, dependencies);
}
