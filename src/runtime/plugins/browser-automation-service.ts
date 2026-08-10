import { createHash, randomUUID } from 'crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { callExternalUnixSocket } from './external-unix-socket';
import { AssistantPluginError } from './errors';

const HELPER_ENTRYPOINT = 'browser-automation-helper' as const;
const BROWSER_AUTOMATION_PROTOCOL_VERSION = 1;
const SOCKET_NAME = 'browser-automation.sock';
const MAX_RESPONSE_BYTES = 4 * 1_048_576;

export type BrowserAutomationProduct = 'chrome' | 'vivaldi';
export interface BrowserAutomationTabRef {
  windowId: string;
  tabId: string;
}
export interface BrowserAutomationRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserAutomationHelperAction =
  | { action: 'metadata'; product: BrowserAutomationProduct; ref?: BrowserAutomationTabRef }
  | { action: 'create_tab'; product: BrowserAutomationProduct; url: string }
  | { action: 'close_tab'; product: BrowserAutomationProduct; ref: BrowserAutomationTabRef }
  | { action: 'navigate'; product: BrowserAutomationProduct; ref?: BrowserAutomationTabRef; url: string }
  | { action: 'reload'; product: BrowserAutomationProduct; ref?: BrowserAutomationTabRef }
  | { action: 'execute_javascript'; product: BrowserAutomationProduct; ref?: BrowserAutomationTabRef; source: string }
  | { action: 'activate'; product: BrowserAutomationProduct; ref?: BrowserAutomationTabRef }
  | { action: 'capture_region'; region: BrowserAutomationRegion };

export interface BrowserAutomationServicePaths {
  controllerHome: string;
  serviceRoot: string;
  executablePath: string;
  metadataPath: string;
  socketPath: string;
  sourcePlistPath: string;
  installedPlistPath: string;
  stdoutPath: string;
  stderrPath: string;
  label: string;
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function atomicWrite(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

function atomicCopyExecutable(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  copyFileSync(source, temporary);
  chmodSync(temporary, 0o700);
  renameSync(temporary, target);
}

export function browserAutomationServicePaths(
  controllerHome: string,
  accountHome = process.env.HOME?.trim() || homedir(),
): BrowserAutomationServicePaths {
  const home = resolve(controllerHome);
  const serviceRoot = join(home, 'runtime', 'browser-automation');
  const suffix = createHash('sha256').update(home).digest('hex').slice(0, 12);
  const label = `com.moretea.forge.browser-automation.${suffix}`;
  return {
    controllerHome: home,
    serviceRoot,
    executablePath: join(serviceRoot, HELPER_ENTRYPOINT),
    metadataPath: join(serviceRoot, 'installed-helper.json'),
    socketPath: join('/tmp', `forge-browser-automation-${typeof process.getuid === 'function' ? process.getuid() : 0}`, `${suffix}-${SOCKET_NAME}`),
    sourcePlistPath: join(serviceRoot, `${label}.plist`),
    installedPlistPath: join(resolve(accountHome), 'Library', 'LaunchAgents', `${label}.plist`),
    stdoutPath: join(serviceRoot, 'logs', 'stdout.log'),
    stderrPath: join(serviceRoot, 'logs', 'stderr.log'),
    label,
  };
}

export function renderBrowserAutomationLaunchAgent(paths: BrowserAutomationServicePaths): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${xml(paths.label)}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${xml(paths.executablePath)}</string>\n    <string>--controller-home</string>\n    <string>${xml(paths.controllerHome)}</string>\n    <string>--socket-path</string>\n    <string>${xml(paths.socketPath)}</string>\n  </array>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>\n  <key>ThrottleInterval</key>\n  <integer>5</integer>\n  <key>ProcessType</key>\n  <string>Interactive</string>\n  <key>StandardOutPath</key>\n  <string>${xml(paths.stdoutPath)}</string>\n  <key>StandardErrorPath</key>\n  <string>${xml(paths.stderrPath)}</string>\n</dict>\n</plist>\n`;
}

export function ensureBrowserAutomationServiceContract(input: {
  controllerHome: string;
  candidatePath: string;
  candidateArtifactIdentity: string;
  candidateContractIdentity: string;
  accountHome?: string;
}): {
  paths: BrowserAutomationServicePaths;
  artifactChanged: boolean;
  plistChanged: boolean;
  changed: boolean;
} {
  const paths = browserAutomationServicePaths(input.controllerHome, input.accountHome);
  const candidatePath = resolve(input.candidatePath);
  if (!existsSync(candidatePath)) throw new Error(`BROWSER_AUTOMATION_HELPER_CANDIDATE_MISSING: ${candidatePath}`);
  const expectedIdentity = input.candidateArtifactIdentity.trim();
  if (!/^sha256:[a-f0-9]{64}$/i.test(expectedIdentity)) throw new Error('BROWSER_AUTOMATION_HELPER_IDENTITY_INVALID');
  const candidateIdentity = `sha256:${sha256File(candidatePath)}`;
  if (candidateIdentity !== expectedIdentity) throw new Error('BROWSER_AUTOMATION_HELPER_IDENTITY_MISMATCH');
  const contractIdentity = input.candidateContractIdentity.trim();
  if (!/^sha256:[a-f0-9]{64}$/i.test(contractIdentity)) throw new Error('BROWSER_AUTOMATION_HELPER_CONTRACT_IDENTITY_INVALID');

  mkdirSync(join(paths.serviceRoot, 'logs'), { recursive: true, mode: 0o700 });
  const stableIdentity = existsSync(paths.executablePath) ? `sha256:${sha256File(paths.executablePath)}` : undefined;
  let installed: { schemaVersion?: unknown; contractIdentity?: unknown; artifactIdentity?: unknown } | undefined;
  try {
    installed = JSON.parse(readFileSync(paths.metadataPath, 'utf8')) as typeof installed;
  } catch {}
  const stableMatchesContract = Boolean(
    stableIdentity
      && installed?.schemaVersion === 1
      && installed.contractIdentity === contractIdentity
      && installed.artifactIdentity === stableIdentity,
  );
  const artifactChanged = !stableMatchesContract;
  if (artifactChanged) {
    atomicCopyExecutable(candidatePath, paths.executablePath);
    atomicWrite(paths.metadataPath, `${JSON.stringify({
      schemaVersion: 1,
      contractIdentity,
      artifactIdentity: candidateIdentity,
    }, null, 2)}\n`, 0o600);
  }

  const plist = renderBrowserAutomationLaunchAgent(paths);
  const currentSource = existsSync(paths.sourcePlistPath) ? readFileSync(paths.sourcePlistPath, 'utf8') : undefined;
  const currentInstalled = existsSync(paths.installedPlistPath) ? readFileSync(paths.installedPlistPath, 'utf8') : undefined;
  const plistChanged = currentSource !== plist || currentInstalled !== plist;
  if (currentSource !== plist) atomicWrite(paths.sourcePlistPath, plist, 0o600);
  if (currentInstalled !== plist) atomicWrite(paths.installedPlistPath, plist, 0o644);
  return { paths, artifactChanged, plistChanged, changed: artifactChanged || plistChanged };
}

function controllerHomeForRuntime(): string {
  const value = process.env.FORGE_CONTROLLER_HOME?.trim();
  if (!value) {
    throw new AssistantPluginError(
      'PLUGIN_BROWSER_AUTOMATION_HELPER_UNAVAILABLE',
      'FORGE_CONTROLLER_HOME is unavailable, so the stable macOS Browser Automation helper cannot be resolved.',
      { retryable: false },
    );
  }
  return resolve(value);
}

export async function callBrowserAutomationHelper(
  request: BrowserAutomationHelperAction,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const paths = browserAutomationServicePaths(controllerHomeForRuntime());
  try {
    return await callExternalUnixSocket({
      socketPath: paths.socketPath,
      requestId: `browser-automation:${randomUUID()}`,
      method: 'execute',
      params: { ...request, timeoutMs, protocolVersion: BROWSER_AUTOMATION_PROTOCOL_VERSION },
      timeoutMs,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    });
  } catch (error) {
    if (error instanceof AssistantPluginError && /^EXTERNAL_PLUGIN_(SOCKET_UNAVAILABLE|TIMEOUT|TRANSPORT_FAILED|PROBE_FAILED)$/.test(error.code)) {
      throw new AssistantPluginError(
        'PLUGIN_BROWSER_AUTOMATION_HELPER_UNAVAILABLE',
        `Stable macOS Browser Automation helper is unavailable at ${paths.socketPath}. Install or restore the Forge Runtime service helper instead of granting Automation permission to a release-specific Runtime binary.`,
        {
          retryable: true,
          details: { socketPath: paths.socketPath, serviceLabel: paths.label, causeCode: error.code },
        },
      );
    }
    throw error;
  }
}

export async function captureBrowserAutomationRegion(region: BrowserAutomationRegion, timeoutMs: number): Promise<Buffer> {
  const result = await callBrowserAutomationHelper({ action: 'capture_region', region }, timeoutMs);
  const base64 = typeof result.base64 === 'string' ? result.base64 : '';
  if (!base64) {
    throw new AssistantPluginError('PLUGIN_BROWSER_AUTOMATION_HELPER_PROTOCOL_ERROR', 'Browser Automation helper returned an invalid screenshot payload.', { retryable: true });
  }
  return Buffer.from(base64, 'base64');
}

export { HELPER_ENTRYPOINT as BROWSER_AUTOMATION_HELPER_ENTRYPOINT };
