import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { writeChatgptBridgeExtension, CHATGPT_BRIDGE_DEFAULT_PORT, CHATGPT_BRIDGE_EXTENSION_RELATIVE_PATH } from './bridge-extension';
import { DEFAULT_CHATGPT_URL, ensureBridgeToken, readBrowserBinding } from './binding';
import { openNativeBrowserPage } from './native-provider';
import { join, resolve } from 'path';
import { resolveRepoPreferredControllerHome } from '../../effects/controller-home';
import { readControllerPluginConfig } from '../../runtime/plugins/config-store';
import { discoverWslWindowsHostEnvironment, hostPathToWindowsPath, windowsPathToHostPath, type WindowsHostEnvironment } from '../../runtime/platform/windows-host-discovery';
import { serveFetchHttp, type FetchHttpServer } from '../../runtime/platform/fetch-http-server';
import type { BrowserConsultInput, BrowserSessionStatus, PromptBundle } from './types';

export interface BridgeProviderResult {
  status: BrowserSessionStatus;
  output: string;
  conversationUrl?: string;
  error?: {
    code: string;
    message: string;
    recovery?: string;
  };
}

interface ExtensionHeartbeat {
  url?: string;
  title?: string;
  composerVisible?: boolean;
  ts?: string;
  receivedAt: number;
}

interface ExtensionTask {
  id: string;
  kind: 'consult';
  prompt: string;
  timeoutMs: number;
  targetUrl?: string;
  dispatchOnly?: boolean;
}

interface ExtensionDispatchReceipt {
  taskId: string;
  conversationUrl?: string;
  outboundFingerprint: string;
  confirmedAt?: string;
}

interface ExtensionResult {
  taskId: string;
  status: BrowserSessionStatus;
  output: string;
  conversationUrl?: string;
  error?: BridgeProviderResult['error'];
}

function corsHeaders(): HeadersInit {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,accept,x-forge-bridge-token',
    'access-control-allow-private-network': 'true',
    'cache-control': 'no-store',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders(),
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

async function readJson(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch (_error) {
    return {};
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
}

interface BrowserPluginCdpConfig {
  enabled?: boolean;
  browserMode?: string;
  cdpEndpoint?: string;
}

function resolveBrowserCdpEndpoint(repoRoot: string): string {
  const config = readControllerPluginConfig<BrowserPluginCdpConfig>(
    resolveRepoPreferredControllerHome(repoRoot),
    'browser',
  );
  if (!config?.enabled || config.browserMode !== 'attach_preferred' || !config.cdpEndpoint) {
    throw new Error('CHATGPT_BRIDGE_BROWSER_CDP_NOT_CONFIGURED');
  }
  const endpoint = new URL(config.cdpEndpoint);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(endpoint.hostname)) {
    throw new Error('CHATGPT_BRIDGE_BROWSER_CDP_ENDPOINT_INVALID');
  }
  return endpoint.toString().replace(/\/+$/, '');
}

function hasBrowserCdpEndpoint(repoRoot: string): boolean {
  try {
    resolveBrowserCdpEndpoint(repoRoot);
    return true;
  } catch {
    return false;
  }
}

interface BridgeCdpConnection {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>;
  close(): void;
}

async function connectBridgeCdp(endpoint: string): Promise<BridgeCdpConnection> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let response: Response;
  try {
    response = await fetch(new URL('/json/version', endpoint), { signal: controller.signal });
  } catch {
    throw new Error('CHATGPT_BRIDGE_CDP_UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error('CHATGPT_BRIDGE_CDP_UNAVAILABLE');
  const version = await response.json() as { webSocketDebuggerUrl?: string };
  if (!version.webSocketDebuggerUrl) throw new Error('CHATGPT_BRIDGE_CDP_WEBSOCKET_MISSING');

  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((resolveConnection, rejectConnection) => {
    const timer = setTimeout(() => {
      socket.close();
      rejectConnection(new Error('CHATGPT_BRIDGE_CDP_CONNECT_TIMEOUT'));
    }, 5000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolveConnection();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      rejectConnection(new Error('CHATGPT_BRIDGE_CDP_CONNECT_FAILED'));
    };
  });

  let nextId = 1;
  const pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const rejectPending = (message: string) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    pending.clear();
  };
  socket.onmessage = (event) => {
    let message: any;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (typeof message.id !== 'number') return;
    const waiting = pending.get(message.id);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    else waiting.resolve(message.result);
  };
  socket.onerror = () => rejectPending('CHATGPT_BRIDGE_CDP_CONNECTION_LOST');
  socket.onclose = () => rejectPending('CHATGPT_BRIDGE_CDP_CONNECTION_CLOSED');

  return {
    send(method, params = {}, sessionId) {
      if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CHATGPT_BRIDGE_CDP_NOT_OPEN'));
      const id = nextId++;
      return new Promise((resolveCommand, rejectCommand) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectCommand(new Error('CDP command timed out: ' + method));
        }, 10000);
        pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
        try {
          socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          rejectCommand(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    close() {
      socket.close();
    },
  };
}

async function readBridgeBrowserProfilePath(cdp: BridgeCdpConnection): Promise<string> {
  const target = await cdp.send('Target.createTarget', { url: 'chrome://version', background: true }) as { targetId?: string };
  if (!target.targetId) throw new Error('CHATGPT_BRIDGE_CDP_PROFILE_TARGET_UNAVAILABLE');
  let sessionId: string | undefined;
  try {
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }) as { sessionId?: string };
    sessionId = attached.sessionId;
    if (!sessionId) throw new Error('CHATGPT_BRIDGE_CDP_PROFILE_SESSION_UNAVAILABLE');
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url: 'chrome://version' }, sessionId);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const evaluated = await cdp.send('Runtime.evaluate', {
        expression: "document.querySelector('#profile_path')?.textContent?.trim() || ''",
        returnByValue: true,
      }, sessionId) as { result?: { value?: unknown } };
      const profilePath = evaluated.result?.value;
      if (typeof profilePath === 'string' && profilePath.trim()) return profilePath.trim();
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error('CHATGPT_BRIDGE_CDP_PROFILE_UNVERIFIED');
  } finally {
    if (sessionId) await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
    await cdp.send('Target.closeTarget', { targetId: target.targetId }).catch(() => undefined);
  }
}

function normalizeBridgeWindowsPath(value: string): string {
  let normalized = value.trim().replace(/^"|"$/g, '').replaceAll('/', '\\').toLowerCase();
  while (normalized.endsWith('\\')) normalized = normalized.slice(0, -1);
  return normalized;
}

async function installBridgeExtensionViaCdp(endpoint: string, extensionPath: string, expectedProfilePath: string): Promise<void> {
  const cdp = await connectBridgeCdp(endpoint);
  try {
    const actualProfilePath = await readBridgeBrowserProfilePath(cdp);
    if (normalizeBridgeWindowsPath(actualProfilePath) !== normalizeBridgeWindowsPath(expectedProfilePath)) {
      throw new Error('CHATGPT_BRIDGE_CDP_PROFILE_MISMATCH');
    }
    const before = await cdp.send('Extensions.getExtensions') as { extensions?: Array<{ id: string; path: string; enabled: boolean }> };
    const existing = (before.extensions ?? []).find((entry) => normalizeBridgeWindowsPath(entry.path) === normalizeBridgeWindowsPath(extensionPath));
    if (existing && !existing.enabled) throw new Error('CHATGPT_BRIDGE_EXTENSION_DISABLED');
    await cdp.send('Extensions.loadUnpacked', { path: extensionPath });

    const after = await cdp.send('Extensions.getExtensions') as { extensions?: Array<{ id: string; path: string; enabled: boolean }> };
    const installed = (after.extensions ?? []).find((entry) => normalizeBridgeWindowsPath(entry.path) === normalizeBridgeWindowsPath(extensionPath));
    if (!installed || !installed.enabled) throw new Error('CHATGPT_BRIDGE_EXTENSION_INSTALL_NOT_CONFIRMED');
  } finally {
    cdp.close();
  }
}

function validStatus(value: unknown): BrowserSessionStatus {
  if (value === 'completed' || value === 'incomplete_capture' || value === 'failed') return value;
  return 'failed';
}

// Status chrome that ChatGPT renders mid-stream and that the DOM-scrape fallback
// can mistake for a final answer. Used by the server-side backstop only.
const STATUS_ONLY_OUTPUTS = new Set(['pro thinking', 'thinking', 'reasoning', 'searching', 'analyzing', 'retry']);

function isStatusOnlyOutput(output: string): boolean {
  return STATUS_ONLY_OUTPUTS.has(output.trim().toLowerCase());
}


function normalizeTargetPage(value: string): { path: string; conversationId?: string } | undefined {
  try {
    const url = new URL(value);
    if (!['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com'].includes(url.hostname)) return undefined;
    const parts = url.pathname.split('/').filter(Boolean);
    const c = parts.lastIndexOf('c');
    const conversationId = c >= 0 ? parts[c + 1] : undefined;
    const path = `/${parts.join('/')}`.replace(/\/$/, '') || '/';
    return { path, conversationId };
  } catch {
    return undefined;
  }
}

export function chatgptBridgeTargetMatchesPage(targetUrl: string | undefined, pageUrl: string | undefined): boolean {
  if (!targetUrl) return true;
  if (!pageUrl) return false;
  const target = normalizeTargetPage(targetUrl);
  const page = normalizeTargetPage(pageUrl);
  if (!target || !page) return false;
  if (target.conversationId) return page.conversationId === target.conversationId;
  return page.path === target.path;
}

function bridgePort(): number {
  const raw = process.env.FORGE_CHATGPT_BRIDGE_PORT;
  if (!raw) return CHATGPT_BRIDGE_DEFAULT_PORT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : CHATGPT_BRIDGE_DEFAULT_PORT;
}

export interface WslWindowsBridgeBrowserCandidate {
  executable: string;
  /** Absolute host-visible profile root. Preferred for discovered providers. */
  profileRoot?: string;
  /** Compatibility fallback relative to the discovered Windows user profile. */
  profileRelativeRoot?: string;
  controlled?: boolean;
  supportsUnpackedExtensionManagement?: boolean;
}

const WSL_WINDOWS_CONTROLLED_PROFILE_ROOT = 'Forge/ChromeAutomation';
const WSL_WINDOWS_CONTROLLED_EXTENSION_ROOT = 'Forge/ChatGPT Bridge';

interface WslWindowsBrowserProductFallback {
  productId: string;
  executableRelativePath: string;
  profileRelativeToLocalAppData?: string;
  supportsUnpackedExtensionManagement?: boolean;
}

/** Bounded adapter fallbacks only. Host discovery and explicit provider registration take precedence. */
const WSL_WINDOWS_BROWSER_PRODUCT_FALLBACKS: readonly WslWindowsBrowserProductFallback[] = [
  { productId: 'google-chrome', executableRelativePath: 'Google/Chrome/Application/chrome.exe', profileRelativeToLocalAppData: 'Google/Chrome/User Data', supportsUnpackedExtensionManagement: true },
  { productId: 'centbrowser', executableRelativePath: 'CentBrowser/Application/chrome.exe', profileRelativeToLocalAppData: 'CentBrowser/User Data', supportsUnpackedExtensionManagement: true },
] as const;

export interface WslWindowsBridgeBrowserBinding {
  executable: string;
  profileDirectory: string;
  extensionDir: string;
  userDataDir?: string;
}

interface WslWindowsBridgeLaunchOptions {
  platform?: NodeJS.Platform;
  wslDistroName?: string;
  osRelease?: string;
  chromeExecutables?: readonly string[];
  browserBinding?: WslWindowsBridgeBrowserBinding;
  fileExists?: typeof existsSync;
  launch?: typeof spawn;
  hostEnvironment?: WindowsHostEnvironment;
  hostDiscovery?: () => WindowsHostEnvironment | undefined;
  toWindowsPath?: (value: string) => string | undefined;
}

function bridgeProfileDirectories(profileRoot: string): string[] {
  if (!existsSync(profileRoot)) return [];
  try {
    return readdirSync(profileRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name)))
      .map((entry) => entry.name)
      .sort((left, right) => left === 'Default' ? -1 : right === 'Default' ? 1 : left.localeCompare(right))
      .slice(0, 20);
  } catch {
    return [];
  }
}

function hostBrowserCandidates(host: WindowsHostEnvironment): WslWindowsBridgeBrowserCandidate[] {
  const candidates: WslWindowsBridgeBrowserCandidate[] = [];
  for (const fallback of WSL_WINDOWS_BROWSER_PRODUCT_FALLBACKS) {
    for (const programFiles of host.programFiles) {
      const executable = join(programFiles, fallback.executableRelativePath);
      candidates.push({
        executable,
        ...(host.localAppData && fallback.profileRelativeToLocalAppData ? { profileRoot: join(host.localAppData, fallback.profileRelativeToLocalAppData) } : {}),
        ...(fallback.supportsUnpackedExtensionManagement ? { supportsUnpackedExtensionManagement: true } : {}),
      });
      if (host.localAppData && fallback.supportsUnpackedExtensionManagement) {
        candidates.push({
          executable,
          profileRoot: join(host.localAppData, WSL_WINDOWS_CONTROLLED_PROFILE_ROOT),
          controlled: true,
          supportsUnpackedExtensionManagement: true,
        });
      }
    }
  }
  return candidates;
}

function resolvedWslHost(options: { hostEnvironment?: WindowsHostEnvironment; hostDiscovery?: () => WindowsHostEnvironment | undefined } = {}): WindowsHostEnvironment | undefined {
  return options.hostEnvironment ?? options.hostDiscovery?.() ?? discoverWslWindowsHostEnvironment();
}

function installedBridgeExtensionPath(setting: any, bridgeUrl: string, token: string, host?: WindowsHostEnvironment): string | undefined {
  const disableReasons = setting?.disable_reasons;
  const enabled = setting?.state === 1 || (setting?.state === undefined && Array.isArray(disableReasons) && disableReasons.length === 0);
  if (!enabled || (Array.isArray(disableReasons) && disableReasons.length > 0) || (disableReasons !== undefined && !Array.isArray(disableReasons))) return undefined;
  const rawPath = setting?.path ?? setting?.path_safe ?? setting?.location_path;
  if (typeof rawPath !== 'string') return undefined;
  const extensionDir = rawPath.startsWith('/') ? rawPath : host ? windowsPathToHostPath(rawPath, host.driveMounts) : undefined;
  if (!extensionDir) return undefined;
  const contentScript = join(extensionDir, 'content-script.js');
  if (!existsSync(contentScript)) return undefined;
  try {
    const source = readFileSync(contentScript, 'utf8');
    return source.includes(bridgeUrl) && source.includes(token) ? extensionDir : undefined;
  } catch {
    return undefined;
  }
}

export function findInstalledWslWindowsBridgeBrowser(
  bridgeUrl: string,
  token: string,
  options: { userName?: string; userRoot?: string; controlledProfileDir?: string; extensionDir?: string; candidates?: readonly WslWindowsBridgeBrowserCandidate[]; hostEnvironment?: WindowsHostEnvironment; hostDiscovery?: () => WindowsHostEnvironment | undefined } = {},
): WslWindowsBridgeBrowserBinding | undefined {
  const host = resolvedWslHost(options);
  const candidates = options.candidates ?? (host ? hostBrowserCandidates(host) : []);
  const orderedCandidates = candidates.filter((candidate) => candidate.controlled);
  const controlledExtensionRoot = host?.localAppData ? join(host.localAppData, WSL_WINDOWS_CONTROLLED_EXTENSION_ROOT) : undefined;
  for (const candidate of orderedCandidates) {
    if (!existsSync(candidate.executable)) continue;
    if (options.controlledProfileDir && candidate.profileRoot
      && resolve(options.controlledProfileDir) !== resolve(candidate.profileRoot)) continue;
    const profileRoot = candidate.profileRoot;
    if (!profileRoot || !controlledExtensionRoot) continue;
    const expectedExtensionDir = resolve(options.extensionDir ?? join(controlledExtensionRoot, CHATGPT_BRIDGE_EXTENSION_RELATIVE_PATH)).toLowerCase();
    for (const profileDirectory of bridgeProfileDirectories(profileRoot).filter((name) => name === 'Default')) {
      for (const fileName of ['Preferences', 'Secure Preferences']) {
        const statePath = join(profileRoot, profileDirectory, fileName);
        if (!existsSync(statePath)) continue;
        try {
          const state = JSON.parse(readFileSync(statePath, 'utf8')) as any;
          const settings = state?.extensions?.settings ?? {};
          for (const setting of Object.values(settings)) {
            const extensionDir = installedBridgeExtensionPath(setting, bridgeUrl, token, host);
            if (extensionDir && resolve(extensionDir).toLowerCase() === expectedExtensionDir) return {
              executable: candidate.executable,
              profileDirectory,
              extensionDir,
              userDataDir: profileRoot,
            };
          }
        } catch {
          // Keep scanning other bounded profiles/state files.
        }
      }
    }
  }
  return undefined;
}

export function isWslWindowsRuntime(
  platform: NodeJS.Platform = process.platform,
  wslDistroName?: string,
  osRelease?: string,
): boolean {
  if (platform !== 'linux') return false;
  const observedDistroName = wslDistroName ?? (osRelease === undefined ? process.env.WSL_DISTRO_NAME : undefined);
  if (observedDistroName?.trim()) return true;
  let observedRelease = osRelease;
  if (observedRelease === undefined) {
    try { observedRelease = readFileSync('/proc/sys/kernel/osrelease', 'utf8'); } catch { observedRelease = ''; }
  }
  return /microsoft|wsl/i.test(observedRelease);
}

export interface WslWindowsBridgeBrowserReadiness {
  required: boolean;
  ready: boolean;
  automatic: boolean;
  summary: string;
  binding?: WslWindowsBridgeBrowserBinding;
}

export function chatgptBridgeUrl(): string {
  return `http://127.0.0.1:${bridgePort()}`;
}


export function observeWslWindowsBridgeBrowser(
  repoRoot: string,
  options: { userName?: string; userRoot?: string; candidates?: readonly WslWindowsBridgeBrowserCandidate[]; fileExists?: typeof existsSync; platform?: NodeJS.Platform; wslDistroName?: string; osRelease?: string; hostEnvironment?: WindowsHostEnvironment; hostDiscovery?: () => WindowsHostEnvironment | undefined } = {},
): WslWindowsBridgeBrowserReadiness {
  if (!isWslWindowsRuntime(options.platform, options.wslDistroName, options.osRelease)) return { required: false, ready: true, automatic: false, summary: 'Windows bridge browser is not required outside WSL2.' };
  const host = resolvedWslHost(options);
  const current = readBrowserBinding(repoRoot).binding;
  const bridgeUrl = chatgptBridgeUrl();
  if (current?.bridgeToken) {
    const binding = findInstalledWslWindowsBridgeBrowser(bridgeUrl, current.bridgeToken, { ...options, ...(host ? { hostEnvironment: host } : {}) });
    if (binding) {
      const cdpReady = hasBrowserCdpEndpoint(repoRoot);
      return { required: true, ready: cdpReady, automatic: cdpReady, binding, summary: cdpReady
        ? 'The Forge-controlled Windows Chrome profile has the current ChatGPT bridge installed.'
        : 'The Bridge extension is installed in the Forge ChromeAutomation profile, but its configured loopback CDP endpoint is unavailable.' };
    }
  }
  const fileExists = options.fileExists ?? existsSync;
  const candidates = options.candidates ?? (host ? hostBrowserCandidates(host) : []);
  const automatic = hasBrowserCdpEndpoint(repoRoot) && candidates.some((candidate) => candidate.controlled && candidate.supportsUnpackedExtensionManagement === true && fileExists(candidate.executable));
  return {
    required: true,
    ready: false,
    automatic,
    summary: automatic
      ? 'Forge can provision a dedicated Windows Chromium profile with the ChatGPT bridge extension without modifying the user browser profile.'
      : host
        ? 'No supported automatic Windows Chromium bridge transport was discovered. Register an extension-capable Chromium provider or load the Forge bridge extension in a dedicated browser profile.'
        : 'Windows host discovery is unavailable from WSL. Configure an explicit Windows host/browser binding before using the ChatGPT bridge.',
  };
}

export async function bootstrapWslWindowsBridgeBrowser(
  repoRoot: string,
  options: {
    userName?: string;
    userRoot?: string;
    controlledRoot?: string;
    userDataDir?: string;
    candidates?: readonly WslWindowsBridgeBrowserCandidate[];
    fileExists?: typeof existsSync;
    launch?: typeof spawn;
    platform?: NodeJS.Platform;
    wslDistroName?: string;
    osRelease?: string;
    toWindowsPath?: (value: string) => string | undefined;
    bridgeToken?: () => string;
    writeExtension?: typeof writeChatgptBridgeExtension;
    hostEnvironment?: WindowsHostEnvironment;
    hostDiscovery?: () => WindowsHostEnvironment | undefined;
  } = {},
): Promise<WslWindowsBridgeBrowserBinding> {
  if (!isWslWindowsRuntime(options.platform, options.wslDistroName, options.osRelease)) throw new Error('CHATGPT_BRIDGE_BOOTSTRAP_WSL_REQUIRED');
  const fileExists = options.fileExists ?? existsSync;
  const host = resolvedWslHost(options);
  const candidates = options.candidates ?? (host ? hostBrowserCandidates(host) : []);
  const executable = Array.from(new Set(candidates
    .filter((candidate) => candidate.controlled && candidate.supportsUnpackedExtensionManagement === true)
    .map((candidate) => candidate.executable)))
    .find((candidate) => fileExists(candidate));
  if (!executable) throw new Error('CHATGPT_BRIDGE_USER_ACTION_REQUIRED: no supported controlled Windows Chromium runtime is installed');
  const userRoot = options.userRoot ?? host?.userProfile;
  const localAppData = host?.localAppData;
  if (!userRoot && !localAppData) throw new Error('CHATGPT_BRIDGE_WINDOWS_HOST_DISCOVERY_REQUIRED');
  const controlledRoot = options.controlledRoot ?? join(localAppData ?? userRoot!, WSL_WINDOWS_CONTROLLED_EXTENSION_ROOT);
  const configuredProfileDir = options.userDataDir ?? readBrowserBinding(repoRoot).binding?.profileDir;
  const userDataDir = configuredProfileDir ?? join(localAppData ?? userRoot!, WSL_WINDOWS_CONTROLLED_PROFILE_ROOT);
  if (localAppData && !resolve(userDataDir).startsWith(`${resolve(localAppData, 'Forge')}/`)) throw new Error('CHATGPT_BRIDGE_PROFILE_MUST_BE_FORGE_CONTROLLED');
  const bridgeUrl = chatgptBridgeUrl();
  const token = (options.bridgeToken ?? (() => ensureBridgeToken(repoRoot)))();
  const extension = (options.writeExtension ?? writeChatgptBridgeExtension)(controlledRoot, bridgeUrl, token);
  const toWindowsPath = options.toWindowsPath ?? ((value: string) => host ? hostPathToWindowsPath(value, host.driveMounts) : undefined);
  const windowsUserDataDir = toWindowsPath(userDataDir);
  const windowsExtensionDir = toWindowsPath(extension.extensionDir);
  if (!windowsUserDataDir || !windowsExtensionDir) throw new Error('CHATGPT_BRIDGE_WINDOWS_PATH_TRANSLATION_FAILED');
  await installBridgeExtensionViaCdp(resolveBrowserCdpEndpoint(repoRoot), windowsExtensionDir, windowsUserDataDir + '\\Default');
  const binding = findInstalledWslWindowsBridgeBrowser(bridgeUrl, token, { controlledProfileDir: userDataDir, extensionDir: extension.extensionDir, hostEnvironment: host });
  if (!binding?.userDataDir || resolve(binding.userDataDir) !== resolve(userDataDir)) {
    throw new Error('CHATGPT_BRIDGE_PROFILE_INSTALL_NOT_PERSISTED');
  }
  const launch = options.launch ?? spawn;
  await new Promise<void>((resolve, reject) => {
    const launched = launch(executable, [
      `--user-data-dir=${windowsUserDataDir}`,
      '--new-window',
      DEFAULT_CHATGPT_URL,
    ], { windowsHide: true, stdio: 'ignore', detached: true });
    let settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; error ? reject(error) : resolve(); };
    launched.once('error', (error) => finish(error));
    launched.once('spawn', () => { launched.unref(); finish(); });
  });
  return binding;
}

export async function openWslWindowsBridgeTarget(
  targetUrl: string,
  options: WslWindowsBridgeLaunchOptions = {},
): Promise<void> {
  if (!isWslWindowsRuntime(options.platform, options.wslDistroName, options.osRelease)) return;
  const parsed = new URL(targetUrl);
  if (parsed.protocol !== 'https:' || !['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com'].includes(parsed.hostname)) {
    throw new Error(`CHATGPT_BRIDGE_TARGET_INVALID: ${targetUrl}`);
  }
  const fileExists = options.fileExists ?? existsSync;
  const legacyChrome = options.chromeExecutables?.find((candidate) => fileExists(candidate));
  const browser = options.browserBinding;
  const executable = browser?.executable ?? legacyChrome;
  if (!executable) {
    throw new Error('CHATGPT_BRIDGE_USER_ACTION_REQUIRED: no enabled Windows Chromium profile with the current Forge bridge extension is available');
  }
  const host = resolvedWslHost(options);
  const toWindowsPath = options.toWindowsPath ?? ((value: string) => host ? hostPathToWindowsPath(value, host.driveMounts) : undefined);
  const args = browser
    ? [
        ...(browser.userDataDir ? [`--user-data-dir=${toWindowsPath(browser.userDataDir) ?? browser.userDataDir}`] : []),
        `--profile-directory=${browser.profileDirectory}`,
        '--new-tab',
        parsed.toString(),
      ]
    : ['--new-tab', parsed.toString()];
  const launch = options.launch ?? spawn;
  await new Promise<void>((resolve, reject) => {
    const launched = launch(executable, args, {
      windowsHide: true,
      stdio: 'ignore',
      detached: true,
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    launched.once('error', (error) => finish(error));
    launched.once('spawn', () => {
      launched.unref();
      finish();
    });
  });
}

export async function runBridgeProvider(input: BrowserConsultInput, bundle: PromptBundle): Promise<BridgeProviderResult> {
  if (input.model || input.thinking) {
    return {
      status: 'failed',
      output: 'ChatGPT bridge provider uses the current web UI model and thinking settings; --model and --thinking are not supported yet.',
      error: {
        code: 'BRIDGE_MODEL_SELECTION_UNSUPPORTED',
        message: 'bridge provider cannot select model or thinking level',
        recovery: 'Omit --model/--thinking for bridge runs, or use the Oracle provider when model selection is required.',
      },
    };
  }

  const timeoutMs = input.timeoutMs ?? 180_000;
  const deadline = Date.now() + timeoutMs;
  const host = '127.0.0.1';
  const port = bridgePort();
  const bridgeUrl = chatgptBridgeUrl();
  // Stable controller/repository binding token; bridge-only bindings are created lazily.
  const token = ensureBridgeToken(input.repoRoot);
  const windowsHost = isWslWindowsRuntime() ? resolvedWslHost() : undefined;
  const extensionRoot = windowsHost?.localAppData ? join(windowsHost.localAppData, WSL_WINDOWS_CONTROLLED_EXTENSION_ROOT) : input.repoRoot;
  const extension = writeChatgptBridgeExtension(extensionRoot, bridgeUrl, token);
  const task: ExtensionTask = {
    id: randomUUID(),
    kind: 'consult',
    prompt: bundle.rendered,
    timeoutMs,
    targetUrl: input.chatgptUrl,
    dispatchOnly: input.dispatchOnly === true,
  };
  const state: {
    heartbeat?: ExtensionHeartbeat;
    claimed: boolean;
    started: boolean;
    dispatched?: ExtensionDispatchReceipt;
    result?: ExtensionResult;
  } = {
    claimed: false,
    started: false,
  };

  let server: FetchHttpServer | undefined;
  try {
    server = await serveFetchHttp({
      hostname: host,
      port,
      async fetch(request) {
        if (request.method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: corsHeaders() });
        }
        // Capability-token gate: only the extension we generated knows the token,
        // so any other local process/page is rejected before it can read the
        // queued prompt or submit a forged result.
        if (request.headers.get('x-forge-bridge-token') !== token) {
          return jsonResponse({ error: { code: 'CHATGPT_BRIDGE_UNAUTHORIZED', message: 'missing or invalid bridge token' } }, 401);
        }
        const url = new URL(request.url);
        if (request.method === 'POST' && url.pathname === '/api/extension/heartbeat') {
          const body = await readJson(request);
          state.heartbeat = {
            url: typeof body.url === 'string' ? body.url : undefined,
            title: typeof body.title === 'string' ? body.title : undefined,
            composerVisible: body.composerVisible === true,
            ts: typeof body.ts === 'string' ? body.ts : undefined,
            receivedAt: Date.now(),
          };
          if (
            body.lastDispatch
            && typeof body.lastDispatch === 'object'
            && body.lastDispatch.taskId === task.id
            && typeof body.lastDispatch.outboundFingerprint === 'string'
            && body.lastDispatch.outboundFingerprint.trim()
          ) {
            state.dispatched = {
              taskId: task.id,
              conversationUrl: typeof body.lastDispatch.conversationUrl === 'string' ? body.lastDispatch.conversationUrl : undefined,
              outboundFingerprint: body.lastDispatch.outboundFingerprint.trim(),
              confirmedAt: typeof body.lastDispatch.confirmedAt === 'string' ? body.lastDispatch.confirmedAt : undefined,
            };
          }
          return jsonResponse({ ok: true });
        }
        if (request.method === 'GET' && url.pathname === '/api/extension/task') {
          if (state.result || state.claimed) return jsonResponse({ kind: 'idle' });
          const pageUrl = url.searchParams.get('pageUrl') ?? undefined;
          if (!chatgptBridgeTargetMatchesPage(task.targetUrl, pageUrl)) return jsonResponse({ kind: 'idle' });
          state.claimed = true;
          return jsonResponse(task);
        }
        if (request.method === 'POST' && url.pathname === '/api/extension/task-started') {
          const body = await readJson(request);
          if (body.taskId !== task.id || !state.claimed || state.started || state.result
            || Date.now() >= deadline || !chatgptBridgeTargetMatchesPage(task.targetUrl, typeof body.url === 'string' ? body.url : undefined)) {
            return jsonResponse({ error: { code: 'CHATGPT_BRIDGE_TASK_NOT_CURRENT', message: 'task is not eligible to start on this target' } }, 409);
          }
          state.started = true;
          return jsonResponse({ ok: true });
        }
        if (request.method === 'POST' && url.pathname === '/api/extension/dispatched') {
          const body = await readJson(request);
          if (body.taskId === task.id && typeof body.outboundFingerprint === 'string' && body.outboundFingerprint.trim()) {
            state.dispatched = {
              taskId: task.id,
              conversationUrl: typeof body.conversationUrl === 'string' ? body.conversationUrl : undefined,
              outboundFingerprint: body.outboundFingerprint.trim(),
              confirmedAt: typeof body.confirmedAt === 'string' ? body.confirmedAt : undefined,
            };
          }
          return jsonResponse({ ok: true });
        }
        if (request.method === 'POST' && url.pathname === '/api/extension/result') {
          const body = await readJson(request);
          if (body.taskId === task.id) {
            const status = validStatus(body.status);
            const output = typeof body.output === 'string' ? body.output : '';
            // Server-side backstop: a `completed` with an empty or status-only
            // body can never be a real answer (the "Pro thinking"/"" capture bug).
            // Coerce it to a failure so it can never persist as success.
            if (status === 'completed' && (output.trim().length === 0 || isStatusOnlyOutput(output))) {
              state.result = {
                taskId: task.id,
                status: 'failed',
                output: output.trim().length === 0 ? 'ChatGPT bridge captured no final assistant message.' : output,
                conversationUrl: typeof body.conversationUrl === 'string' ? body.conversationUrl : undefined,
                error: {
                  code: 'CHATGPT_BRIDGE_NO_FINAL_MESSAGE',
                  message: 'bridge reported completion without a final assistant message',
                  recovery: 'Keep the ChatGPT tab active until the response finishes, then retry; the DOM-scrape fallback cannot confirm completion.',
                },
              };
            } else {
              state.result = {
                taskId: task.id,
                status,
                output,
                conversationUrl: typeof body.conversationUrl === 'string' ? body.conversationUrl : undefined,
                error: body.error && typeof body.error === 'object' ? {
                  code: typeof body.error.code === 'string' ? body.error.code : 'CHATGPT_BRIDGE_TASK_FAILED',
                  message: typeof body.error.message === 'string' ? body.error.message : 'ChatGPT bridge task failed',
                  recovery: typeof body.error.recovery === 'string' ? body.error.recovery : undefined,
                } : undefined,
              };
            }
          }
          return jsonResponse({ ok: true });
        }
        return jsonResponse({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
      },
    });
  } catch (error) {
    return {
      status: 'failed',
      output: error instanceof Error ? error.message : String(error),
      error: {
        code: 'CHATGPT_BRIDGE_PORT_UNAVAILABLE',
        message: `ChatGPT bridge could not listen on ${bridgeUrl}`,
        recovery: `Stop any other forge ChatGPT bridge using ${bridgeUrl}, then retry.`,
      },
    };
  }

  try {
    if (isWslWindowsRuntime()) {
      const browserBinding = findInstalledWslWindowsBridgeBrowser(bridgeUrl, token, { controlledProfileDir: input.profileDir, extensionDir: extension.extensionDir });
      if (!browserBinding?.userDataDir) {
        throw new Error('No Forge-controlled Windows Chrome bridge profile is provisioned. Run the bridge bootstrap before starting a WSL Bridge consult.');
      }
      if (input.profileDir && resolve(input.profileDir) !== resolve(browserBinding.userDataDir)) {
        throw new Error('WSL Bridge consults must use the configured Forge ChromeAutomation profile; refusing to open a different user profile.');
      }
      if (input.profileDirectory && input.profileDirectory !== browserBinding.profileDirectory) {
        throw new Error('WSL Bridge consults must use the configured Forge-controlled Chrome profile directory.');
      }
      const windowsUserDataDir = windowsHost ? hostPathToWindowsPath(browserBinding.userDataDir, windowsHost.driveMounts) : undefined;
      const windowsExtensionDir = windowsHost ? hostPathToWindowsPath(extension.extensionDir, windowsHost.driveMounts) : undefined;
      if (!windowsUserDataDir || !windowsExtensionDir) throw new Error('CHATGPT_BRIDGE_WINDOWS_PATH_TRANSLATION_FAILED');
      await installBridgeExtensionViaCdp(resolveBrowserCdpEndpoint(input.repoRoot), windowsExtensionDir, windowsUserDataDir + '\\' + browserBinding.profileDirectory);
      await openWslWindowsBridgeTarget(input.chatgptUrl ?? DEFAULT_CHATGPT_URL, { browserBinding, hostEnvironment: windowsHost });
    } else if (input.profileDir) {
      openNativeBrowserPage(input.browserChannel ?? 'chrome', input.profileDir, input.chatgptUrl ?? DEFAULT_CHATGPT_URL, input.profileDirectory);
    } else {
      await openWslWindowsBridgeTarget(input.chatgptUrl ?? DEFAULT_CHATGPT_URL);
    }

    while (Date.now() < deadline) {
      if (input.dispatchOnly === true && state.dispatched) {
        return {
          status: 'completed',
          output: 'ChatGPT bridge semantic outbound dispatch confirmed.',
          conversationUrl: state.dispatched.conversationUrl ?? state.heartbeat?.url,
        };
      }
      if (state.result) {
        return {
          status: state.result.status,
          output: state.result.output,
          conversationUrl: state.result.conversationUrl,
          error: state.result.error,
        };
      }
      await sleep(500);
    }

    // A started task can have clicked Send even when its confirmation or result
    // callback was lost. Never turn transport silence into replay permission.
    if (state.started) {
      return {
        status: 'failed',
        output: 'ChatGPT bridge task started but produced no conclusive result before timeout.',
        conversationUrl: state.heartbeat?.url,
        error: {
          code: 'CHATGPT_BRIDGE_MUTATION_OUTCOME_UNKNOWN',
          message: 'ChatGPT bridge began the task but submission and capture outcome remain unconfirmed',
          recovery: 'Do not replay blindly; inspect the exact ChatGPT conversation and reconcile the outbound message.',
        },
      };
    }

    const heartbeatFresh = state.heartbeat && Date.now() - state.heartbeat.receivedAt < 15_000;
    if (!heartbeatFresh) {
      return {
        status: 'failed',
        output: [
          'ChatGPT bridge extension is not connected.',
          `Extension directory: ${extension.extensionDir}`,
          `Bridge URL: ${bridgeUrl}`,
        ].join('\n'),
        error: {
          code: 'CHATGPT_BRIDGE_EXTENSION_NOT_CONNECTED',
          message: 'ChatGPT bridge extension did not connect before timeout',
          recovery: `Load the unpacked extension from ${extension.extensionDir} in the selected Chrome profile, open ChatGPT, grant chatgpt.com loopback-network access in browser Site settings if requested, verify the composer is visible, then retry.`,
        },
      };
    }

    return {
      status: 'failed',
      output: [
        'ChatGPT bridge extension connected, but no result was returned before timeout.',
        `Last extension URL: ${state.heartbeat?.url ?? 'unknown'}`,
        `Composer visible: ${state.heartbeat?.composerVisible === true ? 'yes' : 'no'}`,
      ].join('\n'),
      error: {
        code: 'CHATGPT_BRIDGE_TASK_NOT_CLAIMED',
        message: 'ChatGPT bridge extension did not claim the task before timeout',
        recovery: 'Keep the ChatGPT tab active with the composer visible, then retry with a longer --timeout-ms.',
      },
    };
  } finally {
    server?.stop(true);
  }
}
