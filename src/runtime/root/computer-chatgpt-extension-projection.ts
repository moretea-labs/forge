import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveControllerHome } from '../../effects/controller-home';
import { loadRuntimeReleaseManifest } from './release-manifest';
import { readRuntimeReleaseAuthority } from './release-store';

export const COMPUTER_CHATGPT_NATIVE_HOST_NAME = 'com.moretea.forge.computer';
const EXTENSION_FILES = ['manifest.json', 'background.js', 'content.js', 'core.js'] as const;
const FORGE_NATIVE_MESSAGING_DECLARATION = 'forge-native-messaging-host.json';

export type ComputerChatgptExtensionProjectionState =
  | 'ready'
  | 'not_installed'
  | 'projection_stale'
  | 'runtime_release_incomplete';

export interface ComputerChatgptBrowserInstallation {
  browser: 'chrome' | 'chrome-for-testing' | 'chromium' | 'vivaldi';
  nativeMessagingRoot: string;
}

export interface ComputerChatgptExtensionActiveRelease {
  releaseId: string;
  extensionSourcePath: string;
  nativeHostSourcePath: string;
}

export interface ComputerChatgptExtensionProjectionDependencies {
  homeDir?: string;
  browserInstallations?: readonly ComputerChatgptBrowserInstallation[];
  activeRelease?: (controllerHome: string) => ComputerChatgptExtensionActiveRelease;
}

export interface ComputerChatgptExtensionProjectionStatus {
  state: ComputerChatgptExtensionProjectionState;
  extensionPath: string;
  extensionId?: string;
  nativeHostPath: string;
  activeReleaseId?: string;
  nativeManifestPaths: string[];
  projectionCurrent: boolean;
  detail: string;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function computerChatgptExtensionIdFromManifestKey(value: string): string {
  const key = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key)) throw new Error('COMPUTER_CHATGPT_EXTENSION_KEY_INVALID');
  const bytes = Buffer.from(key, 'base64');
  if (bytes.length < 64 || bytes.toString('base64').replace(/=+$/, '') !== key.replace(/=+$/, '')) {
    throw new Error('COMPUTER_CHATGPT_EXTENSION_KEY_INVALID');
  }
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, (nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16)));
}

function extensionIdFromPath(path: string): string {
  const manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as { key?: unknown };
  if (typeof manifest.key !== 'string') throw new Error('COMPUTER_CHATGPT_EXTENSION_KEY_REQUIRED');
  return computerChatgptExtensionIdFromManifestKey(manifest.key);
}

export function computerChatgptExtensionControllerPaths(controllerHome: string) {
  const home = resolveControllerHome(controllerHome);
  // Keep the historical unpacked-extension path so Chrome continues loading the
  // same extension id without a manual Load Unpacked retarget.
  return {
    extensionPath: join(home, 'supervisor', 'browser-adapter', 'chrome-extension'),
    nativeHostPath: join(home, 'computer', 'chatgpt-native-host.mjs'),
  };
}

function defaultBrowserInstallations(homeDir = process.env.HOME ?? homedir()): ComputerChatgptBrowserInstallation[] {
  return [
    { browser: 'chrome', nativeMessagingRoot: join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts') },
    { browser: 'chrome-for-testing', nativeMessagingRoot: join(homeDir, 'Library', 'Application Support', 'Google', 'ChromeForTesting', 'NativeMessagingHosts') },
    { browser: 'chromium', nativeMessagingRoot: join(homeDir, 'Library', 'Application Support', 'Chromium', 'NativeMessagingHosts') },
    { browser: 'vivaldi', nativeMessagingRoot: join(homeDir, 'Library', 'Application Support', 'Vivaldi', 'NativeMessagingHosts') },
  ];
}

function activeComputerChatgptExtensionRelease(controllerHome: string): ComputerChatgptExtensionActiveRelease {
  const home = resolveControllerHome(controllerHome);
  const authority = readRuntimeReleaseAuthority(home);
  if (!authority) throw new Error('COMPUTER_CHATGPT_EXTENSION_RUNTIME_RELEASE_MISSING');
  const manifest = loadRuntimeReleaseManifest(authority.active.manifestPath, home);
  if (!manifest.packageRoot) throw new Error('COMPUTER_CHATGPT_EXTENSION_RUNTIME_RELEASE_INCOMPLETE');
  const releaseRoot = dirname(authority.active.manifestPath);
  const packageRoot = join(releaseRoot, manifest.packageRoot);
  return {
    releaseId: authority.active.releaseId,
    extensionSourcePath: join(packageRoot, 'adapters', 'computer', 'chatgpt-provider-extension'),
    nativeHostSourcePath: join(packageRoot, 'adapters', 'computer', 'chatgpt-native-host.mjs'),
  };
}

function assertRegularFile(path: string, code: string): void {
  if (!existsSync(path)) throw new Error(`${code}: ${path}`);
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile()) throw new Error(`${code}: ${path}`);
}

function renderNativeManifest(input: { executablePath: string; extensionId: string }): string {
  return `${JSON.stringify({
    name: COMPUTER_CHATGPT_NATIVE_HOST_NAME,
    description: 'Forge Computer ChatGPT Provider native host',
    path: input.executablePath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${input.extensionId}/`],
  }, null, 2)}\n`;
}

function projectExtension(source: string, destination: string): void {
  const staging = `${destination}.staging-${randomUUID().slice(0, 12)}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    for (const file of EXTENSION_FILES) {
      const sourcePath = join(source, file);
      assertRegularFile(sourcePath, 'COMPUTER_CHATGPT_EXTENSION_SOURCE_INVALID');
      writeFileSync(join(staging, file), readFileSync(sourcePath), { mode: 0o600 });
    }
    const backup = `${destination}.backup-${randomUUID().slice(0, 12)}`;
    const hadDestination = existsSync(destination);
    if (hadDestination) renameSync(destination, backup);
    try {
      renameSync(staging, destination);
    } catch (error) {
      if (hadDestination) renameSync(backup, destination);
      throw error;
    }
    if (hadDestination) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function projectNativeHost(source: string, destination: string): void {
  assertRegularFile(source, 'COMPUTER_CHATGPT_NATIVE_HOST_SOURCE_INVALID');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID().slice(0, 12)}.tmp`;
  writeFileSync(temporary, readFileSync(source), { mode: 0o700 });
  chmodSync(temporary, 0o700);
  renameSync(temporary, destination);
}

function extensionProjectionCurrent(source: string, destination: string): boolean {
  return EXTENSION_FILES.every((file) => {
    const sourcePath = join(source, file);
    const destinationPath = join(destination, file);
    return existsSync(sourcePath)
      && existsSync(destinationPath)
      && sha256File(sourcePath) === sha256File(destinationPath);
  });
}

function nativeManifestPath(installation: ComputerChatgptBrowserInstallation): string {
  return join(installation.nativeMessagingRoot, `${COMPUTER_CHATGPT_NATIVE_HOST_NAME}.json`);
}

function nativeManifestReady(path: string, nativeHostPath: string, exactExtensionId: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      name?: unknown;
      path?: unknown;
      allowed_origins?: unknown;
    };
    return manifest.name === COMPUTER_CHATGPT_NATIVE_HOST_NAME
      && manifest.path === nativeHostPath
      && JSON.stringify(manifest.allowed_origins) === JSON.stringify([`chrome-extension://${exactExtensionId}/`]);
  } catch {
    return false;
  }
}

function inspectWithRelease(
  controllerHome: string,
  release: ComputerChatgptExtensionActiveRelease,
  dependencies: ComputerChatgptExtensionProjectionDependencies,
): ComputerChatgptExtensionProjectionStatus {
  const paths = computerChatgptExtensionControllerPaths(controllerHome);
  const exactExtensionId = extensionIdFromPath(release.extensionSourcePath);
  const hostCurrent = existsSync(paths.nativeHostPath)
    && sha256File(paths.nativeHostPath) === sha256File(release.nativeHostSourcePath);
  const declarationPath = join(paths.extensionPath, FORGE_NATIVE_MESSAGING_DECLARATION);
  const extensionCurrent = existsSync(paths.extensionPath)
    && extensionProjectionCurrent(release.extensionSourcePath, paths.extensionPath)
    && nativeManifestReady(declarationPath, paths.nativeHostPath, exactExtensionId);
  const installations = dependencies.browserInstallations
    ?? defaultBrowserInstallations(dependencies.homeDir);
  const nativeManifestPaths = installations.map(nativeManifestPath);
  const manifestsCurrent = nativeManifestPaths.every((path) => (
    nativeManifestReady(path, paths.nativeHostPath, exactExtensionId)
  ));
  const projectionCurrent = hostCurrent && extensionCurrent && manifestsCurrent;
  return {
    state: projectionCurrent
      ? 'ready'
      : (existsSync(paths.extensionPath) || existsSync(paths.nativeHostPath) ? 'projection_stale' : 'not_installed'),
    extensionPath: paths.extensionPath,
    extensionId: exactExtensionId,
    nativeHostPath: paths.nativeHostPath,
    activeReleaseId: release.releaseId,
    nativeManifestPaths,
    projectionCurrent,
    detail: projectionCurrent
      ? 'Computer ChatGPT extension is projected from the active Runtime release and Native Messaging is registered for com.moretea.forge.computer.'
      : 'Controller Computer ChatGPT extension projection does not match the active Runtime release.',
  };
}

export function inspectComputerChatgptExtensionProjection(
  controllerHome: string,
  dependencies: ComputerChatgptExtensionProjectionDependencies = {},
): ComputerChatgptExtensionProjectionStatus {
  const paths = computerChatgptExtensionControllerPaths(controllerHome);
  try {
    return inspectWithRelease(
      controllerHome,
      (dependencies.activeRelease ?? activeComputerChatgptExtensionRelease)(controllerHome),
      dependencies,
    );
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

export function projectComputerChatgptExtension(
  controllerHome: string,
  dependencies: ComputerChatgptExtensionProjectionDependencies = {},
): ComputerChatgptExtensionProjectionStatus {
  const release = (dependencies.activeRelease ?? activeComputerChatgptExtensionRelease)(controllerHome);
  const paths = computerChatgptExtensionControllerPaths(controllerHome);
  const exactExtensionId = extensionIdFromPath(release.extensionSourcePath);
  projectExtension(release.extensionSourcePath, paths.extensionPath);
  projectNativeHost(release.nativeHostSourcePath, paths.nativeHostPath);
  writeFileSync(
    join(paths.extensionPath, FORGE_NATIVE_MESSAGING_DECLARATION),
    renderNativeManifest({ executablePath: paths.nativeHostPath, extensionId: exactExtensionId }),
    { mode: 0o600 },
  );
  for (const installation of dependencies.browserInstallations ?? defaultBrowserInstallations(dependencies.homeDir)) {
    const path = nativeManifestPath(installation);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID().slice(0, 12)}.tmp`;
    writeFileSync(temporary, renderNativeManifest({
      executablePath: paths.nativeHostPath,
      extensionId: exactExtensionId,
    }), { mode: 0o600 });
    renameSync(temporary, path);
  }
  return inspectWithRelease(controllerHome, release, dependencies);
}
