import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { writeChatgptBridgeExtension, CHATGPT_BRIDGE_DEFAULT_PORT } from './bridge-extension';
import { DEFAULT_CHATGPT_URL, ensureBridgeToken, readBrowserBinding } from './binding';
import { openNativeBrowserPage } from './native-provider';
import { join } from 'path';
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
  supportsUnpackedExtensionLaunch?: boolean;
}

const WSL_WINDOWS_CONTROLLED_PROFILE_ROOT = 'Forge/ChatGPT Bridge/User Data';

interface WslWindowsBrowserProductFallback {
  productId: string;
  executableRelativePath: string;
  profileRelativeToLocalAppData?: string;
  supportsUnpackedExtensionLaunch?: boolean;
}

/** Bounded adapter fallbacks only. Host discovery and explicit provider registration take precedence. */
const WSL_WINDOWS_BROWSER_PRODUCT_FALLBACKS: readonly WslWindowsBrowserProductFallback[] = [
  { productId: 'centbrowser', executableRelativePath: 'CentBrowser/Application/chrome.exe', profileRelativeToLocalAppData: 'CentBrowser/User Data', supportsUnpackedExtensionLaunch: true },
  { productId: 'google-chrome', executableRelativePath: 'Google/Chrome/Application/chrome.exe', profileRelativeToLocalAppData: 'Google/Chrome/User Data' },
] as const;

export interface WslWindowsBridgeBrowserBinding {
  executable: string;
  profileDirectory: string;
  extensionDir: string;
  userDataDir?: string;
  loadExtensionOnLaunch?: boolean;
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
        ...(fallback.supportsUnpackedExtensionLaunch ? { supportsUnpackedExtensionLaunch: true } : {}),
      });
      if (host.localAppData && fallback.supportsUnpackedExtensionLaunch) {
        candidates.push({
          executable,
          profileRoot: join(host.localAppData, WSL_WINDOWS_CONTROLLED_PROFILE_ROOT),
          controlled: true,
          supportsUnpackedExtensionLaunch: true,
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
  if (setting?.state === 0 || setting?.disable_reasons !== undefined) return undefined;
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
  options: { userName?: string; userRoot?: string; candidates?: readonly WslWindowsBridgeBrowserCandidate[]; hostEnvironment?: WindowsHostEnvironment; hostDiscovery?: () => WindowsHostEnvironment | undefined } = {},
): WslWindowsBridgeBrowserBinding | undefined {
  const host = resolvedWslHost(options);
  const userRoot = options.userRoot ?? host?.userProfile;
  const candidates = options.candidates ?? (host ? hostBrowserCandidates(host) : []);
  for (const candidate of candidates) {
    if (!existsSync(candidate.executable)) continue;
    const profileRoot = candidate.profileRoot ?? (userRoot && candidate.profileRelativeRoot ? join(userRoot, candidate.profileRelativeRoot) : undefined);
    if (!profileRoot) continue;
    for (const profileDirectory of bridgeProfileDirectories(profileRoot)) {
      for (const fileName of ['Preferences', 'Secure Preferences']) {
        const statePath = join(profileRoot, profileDirectory, fileName);
        if (!existsSync(statePath)) continue;
        try {
          const state = JSON.parse(readFileSync(statePath, 'utf8')) as any;
          const settings = state?.extensions?.settings ?? {};
          for (const setting of Object.values(settings)) {
            const extensionDir = installedBridgeExtensionPath(setting, bridgeUrl, token, host);
            if (extensionDir) return {
              executable: candidate.executable,
              profileDirectory,
              extensionDir,
              ...(candidate.controlled ? { userDataDir: profileRoot, loadExtensionOnLaunch: true } : {}),
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
    if (binding) return { required: true, ready: true, automatic: binding.loadExtensionOnLaunch === true, binding, summary: 'A Windows Chromium profile with the current Forge ChatGPT bridge is available.' };
  }
  const fileExists = options.fileExists ?? existsSync;
  const candidates = options.candidates ?? (host ? hostBrowserCandidates(host) : []);
  const automatic = candidates.some((candidate) => candidate.supportsUnpackedExtensionLaunch === true && fileExists(candidate.executable));
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
    .filter((candidate) => candidate.supportsUnpackedExtensionLaunch === true)
    .map((candidate) => candidate.executable)))
    .find((candidate) => fileExists(candidate));
  if (!executable) throw new Error('CHATGPT_BRIDGE_USER_ACTION_REQUIRED: no supported controlled Windows Chromium runtime is installed');
  const userRoot = options.userRoot ?? host?.userProfile;
  const localAppData = host?.localAppData;
  if (!userRoot && !localAppData) throw new Error('CHATGPT_BRIDGE_WINDOWS_HOST_DISCOVERY_REQUIRED');
  const controlledRoot = options.controlledRoot ?? join(localAppData ?? userRoot!, WSL_WINDOWS_CONTROLLED_PROFILE_ROOT.replace('/User Data', ''));
  const userDataDir = join(controlledRoot, 'User Data');
  const bridgeUrl = chatgptBridgeUrl();
  const token = (options.bridgeToken ?? (() => ensureBridgeToken(repoRoot)))();
  const extension = (options.writeExtension ?? writeChatgptBridgeExtension)(controlledRoot, bridgeUrl, token);
  const toWindowsPath = options.toWindowsPath ?? ((value: string) => host ? hostPathToWindowsPath(value, host.driveMounts) : undefined);
  const windowsUserDataDir = toWindowsPath(userDataDir);
  const windowsExtensionDir = toWindowsPath(extension.extensionDir);
  if (!windowsUserDataDir || !windowsExtensionDir) throw new Error('CHATGPT_BRIDGE_WINDOWS_PATH_TRANSLATION_FAILED');
  const binding: WslWindowsBridgeBrowserBinding = {
    executable, profileDirectory: 'Default', extensionDir: extension.extensionDir, userDataDir, loadExtensionOnLaunch: true,
  };
  const launch = options.launch ?? spawn;
  await new Promise<void>((resolve, reject) => {
    const launched = launch(executable, [
      `--user-data-dir=${windowsUserDataDir}`,
      `--load-extension=${windowsExtensionDir}`,
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
        ...(browser.loadExtensionOnLaunch ? [`--load-extension=${toWindowsPath(browser.extensionDir) ?? browser.extensionDir}`] : []),
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
  const host = '127.0.0.1';
  const port = bridgePort();
  const bridgeUrl = chatgptBridgeUrl();
  // Stable controller/repository binding token; bridge-only bindings are created lazily.
  const token = ensureBridgeToken(input.repoRoot);
  const extension = writeChatgptBridgeExtension(input.repoRoot, bridgeUrl, token);
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
          if (body.taskId === task.id) state.started = true;
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
    if (input.profileDir) {
      openNativeBrowserPage(input.browserChannel ?? 'chrome', input.profileDir, input.chatgptUrl ?? DEFAULT_CHATGPT_URL, input.profileDirectory);
    } else {
      const browserBinding = isWslWindowsRuntime()
        ? findInstalledWslWindowsBridgeBrowser(bridgeUrl, token)
        : undefined;
      await openWslWindowsBridgeTarget(input.chatgptUrl ?? DEFAULT_CHATGPT_URL, { browserBinding });
    }

    const deadline = Date.now() + timeoutMs;
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
          recovery: `Load the unpacked extension from ${extension.extensionDir} in the selected Chrome profile, open ChatGPT, verify the composer is visible, then retry.`,
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
        code: input.dispatchOnly === true && state.started
          ? 'CHATGPT_BRIDGE_MUTATION_OUTCOME_UNKNOWN'
          : state.started
            ? 'CHATGPT_BRIDGE_RESULT_TIMEOUT'
            : 'CHATGPT_BRIDGE_TASK_NOT_CLAIMED',
        message: input.dispatchOnly === true && state.started
          ? 'ChatGPT bridge started the dispatch task but did not prove the submission postcondition before timeout'
          : state.started
            ? 'ChatGPT bridge task did not finish before timeout'
            : 'ChatGPT bridge extension did not claim the task before timeout',
        recovery: input.dispatchOnly === true && state.started
          ? 'Do not replay blindly; inspect the target ChatGPT conversation before retrying.'
          : 'Keep the ChatGPT tab active with the composer visible, then retry with a longer --timeout-ms.',
      },
    };
  } finally {
    server?.stop(true);
  }
}
