import { createHash, randomUUID } from 'crypto';
import { createRequire } from 'module';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginAuthorizationContext,
  AssistantPluginCapability,
  AssistantPluginHealth,
  AssistantPluginManifest,
  AssistantPluginPermissionScope,
} from './types';
import { AssistantPluginError, toAssistantPluginError } from './errors';
import { executeBrowserActionThroughNode, shouldUseBrowserNodeBridge } from './browser-node-bridge';
import {
  closeMacOsBrowserOwnedTab,
  createMacOsBrowserOwnedPage,
  reattachMacOsBrowserOwnedPage,
  discoverMacOsBrowserAttachment,
  getMacOsBrowserAttachObservation,
  listMacOsBrowserTabs,
  macOsActiveBrowserAttachSupported,
  macOsBrowserJavaScriptAutomationDisabled,
  type MacOsBrowserAttachAttempt,
  type MacOsBrowserProduct,
  type MacOsBrowserTabRef,
} from './browser-macos-bridge';
import {
  assertBrowserProfileAvailable,
  assertBrowserSessionAvailable,
  cancelBrowserHandoff,
  getBrowserHandoff,
  isRuntimeManagedBrowserHandoff,
  listBrowserHandoffs,
  resolveRuntimeManagedBrowserHandoff,
  resumeBrowserHandoff,
  startBrowserHandoff,
  startRuntimeManagedBrowserHandoff,
} from './browser-handoff';

const BROWSER_PLUGIN_ID = 'browser';
const CONFIG_ROOT = '.forge/plugins';
const STATE_ROOT = '.forge/browser';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TEXT_CHARS = 20_000;
const DEFAULT_POST_ACTION_WAIT_MS = 750;
const DEFAULT_CDP_DISCOVERY_TIMEOUT_MS = 1_500;
const MAX_CDP_DISCOVERY_TIMEOUT_MS = 5_000;
const MAX_CDP_ENDPOINT_CANDIDATES = 5;

type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle';
type WaitForSelectorState = 'attached' | 'detached' | 'visible' | 'hidden';
type BrowserMode = 'attach_preferred' | 'managed_persistent' | 'isolated';
type BrowserProfileMode = 'repo_local' | 'custom';
type BrowserChannel = 'chromium' | 'chrome' | 'chrome-beta' | 'chrome-dev' | 'chrome-canary';
type BrowserCdpAttachFallback = 'managed_persistent' | 'fail_closed';
type BrowserNativeAttachMode = 'auto' | 'disabled';

interface BrowserPluginConfig {
  schemaVersion: 1;
  enabled: boolean;
  provider: 'playwright';
  browserMode?: BrowserMode;
  profileMode?: BrowserProfileMode;
  profileDir?: string;
  profileDirectory?: string;
  browserChannel?: BrowserChannel;
  executablePath?: string;
  cdpEndpoint?: string;
  cdpEndpointCandidates?: string[];
  cdpDiscoveryTimeoutMs?: number;
  cdpAttachFallback?: BrowserCdpAttachFallback;
  nativeAttachMode?: BrowserNativeAttachMode;
  nativeBrowserCandidates?: MacOsBrowserProduct[];
  defaultTimeoutMs?: number;
}

interface BrowserTabResumeState {
  key: string;
  index: number;
  url: string;
  title?: string;
  matchedBy: BrowserTabMatchReason;
  inventoryCount: number;
  capturedAt: string;
  ownership?: 'plugin_owned' | 'user_owned';
  ownerToken?: string;
  windowId?: string;
  tabId?: string;
}

interface BrowserSessionConnectionState {
  mode: BrowserMode;
  activeMode: BrowserMode;
  provider: 'playwright-cdp' | 'playwright-persistent-context' | 'macos-apple-events';
  endpoint?: string;
  browserVersion?: string;
  browserProduct?: MacOsBrowserProduct;
  fallback?: BrowserConnectionFallback;
  tab?: BrowserTabResumeState;
  sessionResume?: BrowserSessionResumeDiagnostic;
}

interface BrowserSessionState {
  schemaVersion: 1;
  sessionId: string;
  url: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  browser?: BrowserSessionConnectionState;
}

type BrowserSessionLiveness = 'live' | 'unverified' | 'dead';

type BrowserSessionInventoryItem = {
  session: BrowserSessionState;
  liveness: BrowserSessionLiveness;
  evidence: 'runtime_session_binding' | 'runtime_owner_token' | 'runtime_bound_page_missing' | 'runtime_context_unavailable' | 'runtime_owner_token_not_observed' | 'provider_unverified' | 'native_tab_live' | 'native_tab_missing' | 'native_tab_invalid' | 'native_tab_invalid_closed' | 'native_tab_invalid_close_failed' | 'native_inventory_unavailable';
  pruned?: boolean;
  cleanupError?: string;
};

type BrowserSessionInventory = {
  sessions: BrowserSessionInventoryItem[];
  scannedSessionCount: number;
  savedSessionCount: number;
  liveManagedSessionCount: number;
  liveNativeSessionCount: number;
  unverifiedSessionCount: number;
  deadManagedSessionCount: number;
  deadNativeSessionCount: number;
  closedInvalidNativeSessionCount: number;
  failedNativeCleanupCount: number;
  prunedSessionCount: number;
};

interface BrowserActionTarget {
  sessionId: string;
  url: string;
  existingSession?: BrowserSessionState;
}

interface BrowserActionScreenshot {
  path: string;
  relativePath: string;
  bytes: number;
}

interface BrowserProfileSelection {
  profileDir: string;
  profileDirectory?: string;
  selectedProfilePath: string;
}

type BrowserContextLike = {
  pages(): PageLike[];
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
};

type BrowserLike = {
  contexts(): BrowserContextLike[];
  newContext?(): Promise<BrowserContextLike>;
  close?(): Promise<void>;
  disconnect?(): Promise<void> | void;
};

type FrameLike = {
  url(): string;
  name(): string;
  evaluate<T>(expression: string | ((...args: unknown[]) => unknown), arg?: unknown): Promise<T>;
  frameElement?(): Promise<{ boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> }>;
};

type BrowserDownloadLike = {
  suggestedFilename(): string;
  saveAs(path: string): Promise<void>;
  failure?(): Promise<string | null>;
  delete?(): Promise<void>;
};

type PageLike = {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  reload?(options?: Record<string, unknown>): Promise<unknown>;
  goBack?(options?: Record<string, unknown>): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  identity?(): Promise<{ url: string; title: string }>;
  content?(): Promise<string>;
  evaluate<T>(expression: string | ((...args: unknown[]) => unknown), arg?: unknown): Promise<T>;
  screenshot(options: Record<string, unknown>): Promise<Buffer>;
  click(selector: string, options?: Record<string, unknown>): Promise<void>;
  dblclick?(selector: string, options?: Record<string, unknown>): Promise<void>;
  hover?(selector: string, options?: Record<string, unknown>): Promise<void>;
  focus?(selector: string, options?: Record<string, unknown>): Promise<void>;
  fill(selector: string, value: string, options?: Record<string, unknown>): Promise<void>;
  type?(selector: string, text: string, options?: Record<string, unknown>): Promise<void>;
  press(selector: string, key: string, options?: Record<string, unknown>): Promise<void>;
  selectOption?(selector: string, values: string | string[], options?: Record<string, unknown>): Promise<unknown>;
  check?(selector: string, options?: Record<string, unknown>): Promise<void>;
  uncheck?(selector: string, options?: Record<string, unknown>): Promise<void>;
  waitForSelector(selector: string, options?: Record<string, unknown>): Promise<unknown>;
  waitForLoadState?(state?: string, options?: Record<string, unknown>): Promise<void>;
  waitForEvent?(event: 'download', options?: Record<string, unknown>): Promise<BrowserDownloadLike>;
  frames?(): FrameLike[];
  mainFrame?(): FrameLike;
  locator?(selector: string): { screenshot(options?: Record<string, unknown>): Promise<Buffer> };
  on?(event: string, handler: (...args: unknown[]) => void): void;
  bringToFront?(): Promise<void>;
  mouse?: {
    click(x: number, y: number, options?: { button?: 'left' | 'middle' | 'right'; clickCount?: number }): Promise<void>;
    move(x: number, y: number, options?: { steps?: number }): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
    down(options?: { button?: 'left' | 'middle' | 'right' }): Promise<void>;
    up(options?: { button?: 'left' | 'middle' | 'right' }): Promise<void>;
  };
  keyboard?: { press(key: string): Promise<void>; insertText?(text: string): Promise<void> };
  setInputFiles?: (selector: string, files: string | string[]) => Promise<void>;
  close?(): Promise<void>;
};

type PlaywrightRuntime = {
  chromium: {
    launchPersistentContext(userDataDir: string, options: Record<string, unknown>): Promise<BrowserContextLike>;
    connectOverCDP?(endpointURL: string, options?: Record<string, unknown>): Promise<BrowserLike>;
  };
};

interface BrowserPluginRuntimeHooks {
  now(): string;
  moduleAvailable(name: string, repoRoot?: string): boolean;
  loadPlaywright(repoRoot?: string): PlaywrightRuntime;
  fetchJson(url: string, timeoutMs: number): Promise<unknown>;
}

const defaultRuntimeHooks: BrowserPluginRuntimeHooks = {
  now: () => new Date().toISOString(),
  moduleAvailable: (name: string, repoRoot?: string) => {
    const anchors = [repoRoot ? join(repoRoot, 'package.json') : undefined, import.meta.url]
      .filter((value): value is string => Boolean(value));
    for (const anchor of anchors) {
      try {
        createRequire(anchor).resolve(name);
        return true;
      } catch {
        // Try the next trusted dependency anchor.
      }
    }
    return false;
  },
  loadPlaywright: (repoRoot?: string) => {
    const anchors = [repoRoot ? join(repoRoot, 'package.json') : undefined, import.meta.url]
      .filter((value): value is string => Boolean(value));
    for (const anchor of anchors) {
      try {
        return createRequire(anchor)('playwright') as PlaywrightRuntime;
      } catch {
        // Try the next trusted dependency anchor.
      }
    }
    throw new AssistantPluginError('PLUGIN_DEPENDENCY_MISSING', 'Browser plugin requires playwright. Run bun install before using browser actions.', {
      retryable: false,
    });
  },
  fetchJson: async (url: string, timeoutMs: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  },
};

let runtimeHooks: BrowserPluginRuntimeHooks = { ...defaultRuntimeHooks };
let runtimeHooksCustomized = false;

interface ManagedBrowserContextState {
  repoRoot: string;
  profilePath: string;
  context: BrowserContextLike;
  pagesBySession: Map<string, PageLike>;
}

const managedBrowserContexts = new Map<string, Promise<ManagedBrowserContextState>>();

export function setBrowserPluginRuntimeHooksForTest(hooks: Partial<BrowserPluginRuntimeHooks>): void {
  runtimeHooks = { ...defaultRuntimeHooks, ...hooks };
  runtimeHooksCustomized = true;
}

export function resetBrowserPluginRuntimeHooksForTest(): void {
  runtimeHooks = { ...defaultRuntimeHooks };
  runtimeHooksCustomized = false;
  managedBrowserContexts.clear();
}

function now(): string {
  return runtimeHooks.now();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function requiredFiniteNumber(value: unknown, name: string, min = -100_000, max = 100_000): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `${name} must be a finite number between ${min} and ${max}.`, { retryable: false });
  }
  return value;
}

function browserProfileMode(value: unknown): BrowserProfileMode | undefined {
  return value === 'repo_local' || value === 'custom' ? value : undefined;
}

function browserMode(value: unknown): BrowserMode | undefined {
  return value === 'attach_preferred' || value === 'managed_persistent' || value === 'isolated' ? value : undefined;
}

function browserChannel(value: unknown): BrowserChannel | undefined {
  return value === 'chromium'
    || value === 'chrome'
    || value === 'chrome-beta'
    || value === 'chrome-dev'
    || value === 'chrome-canary'
    ? value
    : undefined;
}

function browserCdpAttachFallback(value: unknown): BrowserCdpAttachFallback | undefined {
  return value === 'managed_persistent' || value === 'fail_closed' ? value : undefined;
}

function browserNativeAttachMode(value: unknown): BrowserNativeAttachMode | undefined {
  return value === 'auto' || value === 'disabled' ? value : undefined;
}

function browserProductList(value: unknown): MacOsBrowserProduct[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((entry) => String(entry).trim().toLowerCase())
    .filter((entry): entry is MacOsBrowserProduct => entry === 'chrome' || entry === 'vivaldi');
  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}


function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}

function configPath(repoRoot: string): string {
  return join(repoRoot, CONFIG_ROOT, 'browser.json');
}

function stateDir(repoRoot: string, name: 'sessions' | 'screenshots' | 'profiles' | 'downloads' | 'diagnostics'): string {
  return join(repoRoot, STATE_ROOT, name);
}

function defaultProfileDir(repoRoot: string): string {
  return join(stateDir(repoRoot, 'profiles'), 'default');
}

function isolatedProfileDir(repoRoot: string, sessionId: string): string {
  return join(stateDir(repoRoot, 'profiles'), 'isolated', sessionId.replace(/[^a-zA-Z0-9_-]/g, '_'));
}

function resolveConfiguredPath(repoRoot: string, value: string): string {
  return resolve(repoRoot, value);
}

function resolveProfileSelection(repoRoot: string, profileDir: string, profileDirectory?: string): BrowserProfileSelection {
  const selectedProfilePath = resolveConfiguredPath(repoRoot, profileDir);
  if (profileDirectory) {
    return {
      profileDir: selectedProfilePath,
      profileDirectory,
      selectedProfilePath: join(selectedProfilePath, profileDirectory),
    };
  }

  const parent = dirname(selectedProfilePath);
  if (existsSync(join(selectedProfilePath, 'Preferences')) && existsSync(join(parent, 'Local State'))) {
    return {
      profileDir: parent,
      profileDirectory: basename(selectedProfilePath),
      selectedProfilePath,
    };
  }

  return {
    profileDir: selectedProfilePath,
    selectedProfilePath,
  };
}

function normalizeConfig(raw: Partial<BrowserPluginConfig>): BrowserPluginConfig {
  const normalizedProfileDir = stringValue(raw.profileDir);
  return {
    schemaVersion: 1,
    enabled: raw.enabled === true,
    provider: 'playwright',
    browserMode: browserMode(raw.browserMode) ?? 'managed_persistent',
    profileMode: browserProfileMode(raw.profileMode) ?? (normalizedProfileDir ? 'custom' : 'repo_local'),
    profileDir: normalizedProfileDir,
    profileDirectory: stringValue(raw.profileDirectory),
    browserChannel: browserChannel(raw.browserChannel) ?? 'chromium',
    executablePath: stringValue(raw.executablePath),
    cdpEndpoint: stringValue(raw.cdpEndpoint),
    cdpEndpointCandidates: stringList(raw.cdpEndpointCandidates)?.slice(0, MAX_CDP_ENDPOINT_CANDIDATES),
    cdpDiscoveryTimeoutMs: typeof raw.cdpDiscoveryTimeoutMs === 'number'
      ? Math.min(positiveNumber(raw.cdpDiscoveryTimeoutMs, DEFAULT_CDP_DISCOVERY_TIMEOUT_MS), MAX_CDP_DISCOVERY_TIMEOUT_MS)
      : undefined,
    cdpAttachFallback: browserCdpAttachFallback(raw.cdpAttachFallback) ?? 'fail_closed',
    nativeAttachMode: browserNativeAttachMode(raw.nativeAttachMode) ?? 'auto',
    nativeBrowserCandidates: browserProductList(raw.nativeBrowserCandidates) ?? ['vivaldi', 'chrome'],
    defaultTimeoutMs: typeof raw.defaultTimeoutMs === 'number' ? positiveNumber(raw.defaultTimeoutMs, DEFAULT_TIMEOUT_MS) : undefined,
  };
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function writeAtomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function readBrowserSessionJson(path: string): BrowserSessionState | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw new AssistantPluginError('PLUGIN_BROWSER_SESSION_STATE_READ_FAILED', 'Saved browser session metadata could not be read.', {
      retryable: true,
      details: { fileName: basename(path), cause: error instanceof Error ? error.message : String(error) },
    });
  }
  try {
    return JSON.parse(raw) as BrowserSessionState;
  } catch (error) {
    throw new AssistantPluginError('PLUGIN_BROWSER_SESSION_STATE_CORRUPT', 'Saved browser session metadata is malformed; refusing to treat corrupt state as a missing session.', {
      retryable: false,
      details: { fileName: basename(path), cause: error instanceof Error ? error.message : String(error) },
    });
  }
}

function loadConfig(repoRoot: string): BrowserPluginConfig {
  return normalizeConfig(readJson<Partial<BrowserPluginConfig>>(configPath(repoRoot)) ?? {});
}

export async function resolveBrowserPluginAuthorizationContext(
  input: AssistantPluginActionExecutionInput,
): Promise<AssistantPluginAuthorizationContext | undefined> {
  const action = actions().find((entry) => entry.actionId === input.actionId);
  if (!action || action.confirmation !== 'authorization' || !action.scopes.includes('browser.interact')) return undefined;

  const config = effectiveBrowserActionConfig(loadConfig(input.repoRoot), input.args);
  const sessionId = stringValue(input.args.session_id);
  if (!sessionId || config.browserMode === 'isolated') return undefined;
  const session = findSession(input.repoRoot, sessionId);
  const connection = session?.browser;
  if (!session || !connection || connection.activeMode === 'isolated') return undefined;

  let origin: string;
  try {
    const parsed = new URL(session.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    origin = parsed.origin.toLowerCase();
  } catch {
    return undefined;
  }

  const profile = selectedProfile(config, input.repoRoot, connection.activeMode, sessionId);
  const providerId = connection.browserProduct ?? connection.provider;
  const identity = {
    provider: connection.provider,
    browserProduct: connection.browserProduct,
    activeMode: connection.activeMode,
    endpoint: connection.endpoint,
    origin,
    browserChannel: config.browserChannel,
    executablePath: config.executablePath ? resolveConfiguredPath(input.repoRoot, config.executablePath) : undefined,
    profileMode: config.profileMode,
    selectedProfilePath: profile.selectedProfilePath,
    profileDirectory: profile.profileDirectory,
    cdpAttachFallback: config.cdpAttachFallback,
    nativeAttachMode: config.nativeAttachMode,
    nativeBrowserCandidates: config.nativeBrowserCandidates,
  };
  return {
    target: {
      kind: 'browser-origin',
      id: `${providerId}@${origin}`,
      identityFingerprint: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
    },
    expiresInMinutes: 30 * 24 * 60,
  };
}

export function readBrowserPluginConfiguration(repoRoot: string): { enabled: boolean } {
  const config = loadConfig(repoRoot);
  return { enabled: config.enabled };
}

function saveConfig(repoRoot: string, patch: Partial<BrowserPluginConfig>): BrowserPluginConfig {
  const next = normalizeConfig({ ...loadConfig(repoRoot), ...patch });
  writeJson(configPath(repoRoot), next);
  return next;
}

function sessionPath(repoRoot: string, sessionId: string): string {
  return join(stateDir(repoRoot, 'sessions'), `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

function saveSession(repoRoot: string, session: BrowserSessionState): void {
  writeAtomicJson(sessionPath(repoRoot, session.sessionId), session);
}

function findSession(repoRoot: string, sessionId: string): BrowserSessionState | undefined {
  return readBrowserSessionJson(sessionPath(repoRoot, sessionId));
}

function listSavedBrowserSessions(repoRoot: string): BrowserSessionState[] {
  const root = stateDir(repoRoot, 'sessions');
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw new AssistantPluginError('PLUGIN_BROWSER_SESSION_STATE_READ_FAILED', 'Saved browser session directory could not be read.', {
      retryable: true,
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => readBrowserSessionJson(join(root, name)))
    .filter((session): session is BrowserSessionState => Boolean(session));
}

function loadSession(repoRoot: string, sessionId: string): BrowserSessionState {
  const state = findSession(repoRoot, sessionId);
  if (!state) {
    throw new AssistantPluginError('PLUGIN_SESSION_NOT_FOUND', `Browser session not found: ${sessionId}`, { retryable: false });
  }
  return state;
}

function normalizedUrl(value: unknown): string {
  const raw = stringValue(value);
  if (!raw) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'url is required.', { retryable: false });
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'url must be absolute.', { retryable: false });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Only http and https URLs are supported; observed protocol: ${parsed.protocol}`, {
      retryable: false,
      details: {
        observedProtocol: parsed.protocol,
        inputType: typeof value,
        inputLength: raw.length,
      },
    });
  }
  return parsed.toString();
}


function waitUntil(value: unknown): WaitUntil {
  return value === 'load' || value === 'networkidle' || value === 'domcontentloaded' ? value : 'domcontentloaded';
}

function waitForSelectorState(value: unknown): WaitForSelectorState {
  return value === 'attached' || value === 'detached' || value === 'hidden' || value === 'visible' ? value : 'visible';
}

function parseProfileModeInput(value: unknown): BrowserProfileMode | undefined {
  if (value === undefined) return undefined;
  const parsed = browserProfileMode(value);
  if (parsed) return parsed;
  throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'profile_mode must be repo_local or custom.', { retryable: false });
}

function parseBrowserModeInput(value: unknown): BrowserMode | undefined {
  if (value === undefined) return undefined;
  const parsed = browserMode(value);
  if (parsed) return parsed;
  throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'browser_mode must be attach_preferred, managed_persistent, or isolated.', { retryable: false });
}

function parseBrowserChannelInput(value: unknown): BrowserChannel | undefined {
  if (value === undefined) return undefined;
  const parsed = browserChannel(value);
  if (parsed) return parsed;
  throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'browser_channel must be chromium, chrome, chrome-beta, chrome-dev, or chrome-canary.', { retryable: false });
}

function parseCdpAttachFallbackInput(value: unknown): BrowserCdpAttachFallback | undefined {
  if (value === undefined) return undefined;
  const parsed = browserCdpAttachFallback(value);
  if (parsed) return parsed;
  throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'cdp_attach_fallback must be managed_persistent or fail_closed.', { retryable: false });
}

function parseNativeAttachModeInput(value: unknown): BrowserNativeAttachMode | undefined {
  if (value === undefined) return undefined;
  const parsed = browserNativeAttachMode(value);
  if (parsed) return parsed;
  throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'native_attach_mode must be auto or disabled.', { retryable: false });
}

function parseNativeBrowserCandidatesInput(value: unknown): MacOsBrowserProduct[] | undefined {
  if (value === undefined) return undefined;
  const parsed = browserProductList(value);
  if (parsed) return parsed;
  throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'native_browser_candidates must contain chrome and/or vivaldi.', { retryable: false });
}

function effectiveBrowserActionConfig(config: BrowserPluginConfig, args: Record<string, unknown>): BrowserPluginConfig {
  return {
    ...config,
    browserMode: parseBrowserModeInput(args.browser_mode) ?? config.browserMode,
    cdpAttachFallback: parseCdpAttachFallbackInput(args.cdp_attach_fallback) ?? config.cdpAttachFallback,
    nativeAttachMode: parseNativeAttachModeInput(args.native_attach_mode) ?? config.nativeAttachMode,
    nativeBrowserCandidates: parseNativeBrowserCandidatesInput(args.native_browser_candidates) ?? config.nativeBrowserCandidates,
  };
}

function cdpEndpoints(config: BrowserPluginConfig): string[] {
  return Array.from(new Set([
    ...(config.cdpEndpoint ? [config.cdpEndpoint] : []),
    ...(config.cdpEndpointCandidates ?? []),
  ].map((entry) => entry.trim()).filter(Boolean))).slice(0, MAX_CDP_ENDPOINT_CANDIDATES);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function cdpEndpointValidationError(endpoint: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return `Invalid CDP endpoint URL: ${endpoint}`;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    return `CDP endpoint must use http, https, ws, or wss: ${endpoint}`;
  }
  if (parsed.username || parsed.password) {
    return `CDP endpoint must not contain credentials: ${endpoint}`;
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    return `CDP endpoint must be loopback-only: ${endpoint}`;
  }
  return undefined;
}

function validateConfig(config: BrowserPluginConfig): string[] {
  const errors: string[] = [];
  const endpoints = cdpEndpoints(config);
  if (config.profileMode === 'custom' && !config.profileDir) {
    errors.push('profileDir is required when profileMode is custom.');
  }
  if (config.profileMode !== 'custom' && config.profileDirectory) {
    errors.push('profileDirectory requires profileMode=custom.');
  }
  if (config.browserChannel && config.browserChannel !== 'chromium' && config.executablePath) {
    errors.push('browserChannel and executablePath cannot both be set.');
  }
  if (endpoints.length > MAX_CDP_ENDPOINT_CANDIDATES) {
    errors.push(`At most ${MAX_CDP_ENDPOINT_CANDIDATES} CDP endpoint candidates are supported.`);
  }
  for (const endpoint of endpoints) {
    const error = cdpEndpointValidationError(endpoint);
    if (error) errors.push(error);
  }
  if (config.browserMode === 'attach_preferred'
    && endpoints.length === 0
    && config.cdpAttachFallback === 'fail_closed'
    && config.nativeAttachMode === 'disabled') {
    errors.push('A CDP endpoint or nativeAttachMode=auto is required when browserMode=attach_preferred and cdpAttachFallback=fail_closed.');
  }
  return errors;
}

function configWarnings(config: BrowserPluginConfig): string[] {
  const warnings: string[] = [];
  if (config.profileMode === 'custom') {
    warnings.push('Custom profile mode uses the configured browser profile directly. If the browser reports the profile is in use, fully close the matching browser instance first.');
    if (!config.executablePath && (config.browserChannel ?? 'chromium') === 'chromium') {
      warnings.push('Custom profile mode is more reliable with an explicit Chrome channel or executable path that matches the selected profile format.');
    }
  }
  if (config.browserMode === 'attach_preferred' && cdpEndpoints(config).length === 0) {
    if (config.nativeAttachMode === 'auto' && macOsActiveBrowserAttachSupported()) {
      warnings.push('browserMode=attach_preferred has no configured CDP endpoint; macOS active-browser attach will be attempted before managed fallback.');
    } else {
      warnings.push('browserMode=attach_preferred has no configured CDP endpoint; actions will use the configured fallback policy.');
    }
  }
  if (config.browserMode === 'isolated') {
    warnings.push('browserMode=isolated uses a per-session repo-local profile and will not share the default browser profile.');
  }
  return warnings;
}

function truncateText(value: string, maxChars: number): Record<string, unknown> {
  const clean = value.replace(/[\t\r ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return {
    text: clean.slice(0, maxChars),
    truncated: clean.length > maxChars,
    charCount: clean.length,
  };
}

function sessionIdFor(url: string): string {
  const digest = createHash('sha256')
    .update(`${Date.now()}:${randomUUID()}:${url}`)
    .digest('hex')
    .slice(0, 16);
  return `browser_${digest}`;
}

function requiredString(value: unknown, field: string): string {
  const normalized = stringValue(value);
  if (!normalized) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `${field} is required.`, { retryable: false });
  }
  return normalized;
}

function openShadowSelectorParts(selector: string): string[] {
  return selector.split(/\s*>>>\s*/).map((part) => part.trim()).filter(Boolean);
}

function openShadowSelectorExpression(selector: string, all = false): string {
  const parts = openShadowSelectorParts(selector);
  if (parts.length <= 1) {
    return all
      ? `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`
      : `document.querySelector(${JSON.stringify(selector)})`;
  }
  return `(() => {
    const parts = ${JSON.stringify(parts)};
    let root = document;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const host = root.querySelector(parts[index]);
      if (!host || !host.shadowRoot) return ${all ? '[]' : 'null'};
      root = host.shadowRoot;
    }
    return ${all ? 'Array.from(root.querySelectorAll(parts[parts.length - 1]))' : 'root.querySelector(parts[parts.length - 1])'};
  })()`;
}

function scriptText(selector?: string): string {
  if (!selector) {
    return 'document.body ? document.body.innerText : (document.documentElement ? document.documentElement.textContent : "")';
  }
  return `(() => { const el = ${openShadowSelectorExpression(selector)}; return el ? (el.innerText || el.textContent || '') : ''; })()`;
}

function resolveActionTarget(repoRoot: string, args: Record<string, unknown>): BrowserActionTarget {
  const directUrl = stringValue(args.url);
  const providedSessionId = stringValue(args.session_id);
  if (!directUrl && !providedSessionId) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Provide either url or session_id.', { retryable: false });
  }
  if (providedSessionId) {
    const existingSession = loadSession(repoRoot, providedSessionId);
    const sessionUrl = normalizedUrl(existingSession.url);
    if (directUrl) {
      const explicitUrl = normalizedUrl(directUrl);
      if (explicitUrl !== sessionUrl) {
        throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'url does not match the saved session.', { retryable: false });
      }
    }
    return { sessionId: providedSessionId, url: sessionUrl, existingSession };
  }
  const url = normalizedUrl(directUrl);
  return { sessionId: sessionIdFor(url), url };
}

function sessionFromPage(target: BrowserActionTarget, pageUrl: string, title: string, connection?: BrowserConnectionSummary): BrowserSessionState {
  const refreshedConnection = connection ? refreshConnectionTab(connection, pageUrl, title) : undefined;
  return {
    schemaVersion: 1,
    sessionId: target.sessionId,
    url: pageUrl,
    title,
    createdAt: target.existingSession?.createdAt ?? now(),
    updatedAt: now(),
    browser: refreshedConnection ? sessionConnectionFromSummary(refreshedConnection) : target.existingSession?.browser,
  };
}

function screenshotFilePath(repoRoot: string, actionId: string, sessionId: string, url: string): string {
  const screenshotDir = stateDir(repoRoot, 'screenshots');
  mkdirSync(screenshotDir, { recursive: true });
  const digest = createHash('sha256').update(url).digest('hex').slice(0, 10);
  const actionLabel = actionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const sessionLabel = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(screenshotDir, `${Date.now()}-${actionLabel}-${sessionLabel}-${digest}.png`);
}

function safeDownloadArtifactName(requestedName: string | undefined, browserSuggestedName: string | undefined): string {
  const fallback = `download-${Date.now()}`;
  const raw = (requestedName || browserSuggestedName || fallback).trim();
  const leaf = basename(raw) || fallback;
  const sanitized = leaf.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180);
  return sanitized && sanitized !== '.' && sanitized !== '..' ? sanitized : fallback;
}

function isBlockedExecutableArtifactName(name: string | undefined): boolean {
  return Boolean(name && /\.(exe|dmg|pkg|sh|bat|cmd|app)$/i.test(basename(name)));
}

function uniqueDownloadArtifactPath(downloadDir: string, fileName: string): string {
  const initial = join(downloadDir, fileName);
  if (!existsSync(initial)) return initial;
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';
  return join(downloadDir, `${stem}-${Date.now()}${ext}`);
}

async function captureActionScreenshot(page: PageLike, repoRoot: string, actionId: string, sessionId: string, url: string): Promise<BrowserActionScreenshot | undefined> {
  const path = screenshotFilePath(repoRoot, actionId, sessionId, url);
  const bytes = (await page.screenshot({ path, fullPage: true })).length;
  return { path, relativePath: relative(repoRoot, path), bytes };
}

function responseWithWarnings(base: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
  return warnings.length > 0 ? { ...base, warnings } : base;
}

function browserResultProvider(provider: BrowserSessionConnectionState['provider'] | BrowserConnectionSummary['provider'] | undefined): 'playwright' | 'macos-apple-events' {
  return provider === 'macos-apple-events' ? 'macos-apple-events' : 'playwright';
}

function interactionResult(
  actionId: string,
  session: BrowserSessionState,
  summary: string,
  screenshot: BrowserActionScreenshot | undefined,
  warnings: string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return responseWithWarnings({
    provider: browserResultProvider(session.browser?.provider),
    session,
    url: session.url,
    title: session.title,
    action: {
      actionId,
      summary,
      ...extra,
    },
    ...(screenshot ? { screenshot } : {}),
  }, warnings);
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}


function selectedProfile(config: BrowserPluginConfig, repoRoot: string, activeMode: BrowserMode = 'managed_persistent', sessionId?: string): BrowserProfileSelection {
  if (activeMode === 'isolated') {
    const profileDir = isolatedProfileDir(repoRoot, sessionId ?? 'anonymous');
    return {
      profileDir,
      selectedProfilePath: profileDir,
    };
  }

  if (config.profileMode === 'custom') {
    if (!config.profileDir) {
      throw new AssistantPluginError('PLUGIN_CONFIGURATION_INVALID', 'Custom browser profile mode requires profileDir.', { retryable: false });
    }
    return resolveProfileSelection(repoRoot, config.profileDir, config.profileDirectory);
  }

  const repoLocal = resolve(defaultProfileDir(repoRoot));
  return {
    profileDir: repoLocal,
    selectedProfilePath: repoLocal,
  };
}

type BrowserTabMatchReason = 'owned_token' | 'recovered_tab' | 'saved_url_title' | 'saved_url' | 'exact_url' | 'blank' | 'new_page';

const BROWSER_OWNER_PREFIX = 'forge-browser-owned:';

interface BrowserTabInventoryEntry {
  index: number;
  key: string;
  url: string;
  title?: string;
  ownerToken?: string;
}

function ownerTokenForSession(sessionId: string): string {
  return `${BROWSER_OWNER_PREFIX}${createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}`;
}

interface BrowserSessionResumeDiagnostic {
  sessionId: string;
  status: 'matched' | 'stale_tab' | 'no_saved_tab';
  reason: string;
  savedTab?: Pick<BrowserTabResumeState, 'key' | 'url' | 'title' | 'index'>;
}

interface BrowserConnectionFallback {
  policy: BrowserCdpAttachFallback;
  from: 'attach_preferred';
  to: 'managed_persistent';
  reason: string;
  attempts: CdpAttachAttempt[];
  nativeAttempts?: MacOsBrowserAttachAttempt[];
}

interface CdpAttachAttempt {
  endpoint: string;
  discoveredEndpoint?: string;
  probeUrl?: string;
  browserVersion?: string;
  error?: string;
}

interface BrowserConnectionSummary {
  requestedMode: BrowserMode;
  mode: BrowserMode;
  provider: 'playwright-cdp' | 'playwright-persistent-context' | 'macos-apple-events';
  attached: boolean;
  endpoint?: string;
  browserVersion?: string;
  browserProduct?: MacOsBrowserProduct;
  fallback?: BrowserConnectionFallback;
  profile: {
    profileMode?: BrowserProfileMode;
    profileDirectory?: string;
    selectedProfilePath: string;
  };
  tab?: BrowserTabResumeState;
  tabInventory?: BrowserTabInventoryEntry[];
  sessionResume?: BrowserSessionResumeDiagnostic;
}

interface BrowserOpenHandle {
  page: PageLike;
  diagnostics: PageDiagnostics;
  connection: BrowserConnectionSummary;
  close(): Promise<void>;
}

interface PageDiagnostics {
  consoleErrors: Array<{ type: string; text: string }>;
  failedRequests: Array<{ url: string; status?: number; failure?: string }>;
  navigation?: { url: string; status?: number };
}

function attachDiagnostics(page: PageLike): PageDiagnostics {
  const diagnostics: PageDiagnostics = { consoleErrors: [], failedRequests: [] };
  if (typeof page.on === 'function') {
    page.on('console', (message) => {
      const entry = message as { type?: () => string; text?: () => string };
      const type = typeof entry.type === 'function' ? entry.type() : 'log';
      if (type === 'error' || type === 'warning') {
        diagnostics.consoleErrors.push({
          type,
          text: typeof entry.text === 'function' ? String(entry.text()).slice(0, 500) : '',
        });
      }
    });
    page.on('requestfailed', (request) => {
      const entry = request as { url?: () => string; failure?: () => { errorText?: string } | null };
      diagnostics.failedRequests.push({
        url: typeof entry.url === 'function' ? entry.url() : '',
        failure: typeof entry.failure === 'function' ? entry.failure()?.errorText : undefined,
      });
    });
    page.on('response', (response) => {
      const entry = response as { url?: () => string; status?: () => number; ok?: () => boolean };
      const status = typeof entry.status === 'function' ? entry.status() : undefined;
      if (typeof status === 'number' && status >= 400) {
        diagnostics.failedRequests.push({
          url: typeof entry.url === 'function' ? entry.url() : '',
          status,
        });
      }
    });
  }
  return diagnostics;
}

function tabKey(url: string, title?: string): string {
  return createHash('sha256').update(`${url}\n${title ?? ''}`).digest('hex').slice(0, 16);
}

function comparableUrl(value: string): string {
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function stableBrowserEntityKey(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    const segments = url.pathname.split('/').filter(Boolean);
    for (let index = 0; index + 1 < segments.length; index += 1) {
      if ((segments[index] ?? '').toLowerCase() !== 'apps') continue;
      const id = segments[index + 1]?.trim();
      if (id) return `${url.origin}/apps/${id}`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function selectReusableNativeTab(
  referenceUrls: string[],
  inventory: Awaited<ReturnType<typeof listMacOsBrowserTabs>>,
  preferredWindowId?: string,
): {
  candidate?: (typeof inventory.tabs)[number];
  match: 'exact_url' | 'stable_entity' | 'none' | 'ambiguous';
  candidateCount: number;
} {
  const normalizedReferences = [...new Set(referenceUrls.filter(Boolean).map(comparableUrl))];
  const entityKeys = new Set(normalizedReferences.map(stableBrowserEntityKey).filter((value): value is string => Boolean(value)));
  const scored = inventory.tabs.map((candidate) => {
    const normalizedCandidate = comparableUrl(candidate.url);
    const entityKey = stableBrowserEntityKey(candidate.url);
    const matchScore = normalizedReferences.includes(normalizedCandidate)
      ? 100
      : entityKey && entityKeys.has(entityKey)
        ? 50
        : 0;
    const score = matchScore === 0
      ? 0
      : matchScore + (preferredWindowId && candidate.windowId === preferredWindowId ? 10 : 0) + (candidate.active ? 1 : 0);
    return { candidate, score, matchScore };
  });
  const maxScore = scored.reduce((max, entry) => Math.max(max, entry.score), 0);
  if (maxScore === 0) return { match: 'none', candidateCount: 0 };
  const matches = scored.filter((entry) => entry.score === maxScore);
  if (matches.length !== 1) return { match: 'ambiguous', candidateCount: matches.length };
  return { candidate: matches[0]!.candidate, match: matches[0]!.matchScore === 100 ? 'exact_url' : 'stable_entity', candidateCount: 1 };
}

function selectLiveForgeOwnedNativeTab(
  repoRoot: string,
  targetUrl: string,
  product: MacOsBrowserProduct,
  inventory: Awaited<ReturnType<typeof listMacOsBrowserTabs>>,
): {
  session?: BrowserSessionState;
  candidate?: (typeof inventory.tabs)[number];
  match: 'exact_url' | 'same_origin' | 'none' | 'ambiguous';
  candidateCount: number;
} {
  const liveByRef = new Map(inventory.tabs.map((tab) => [`${tab.windowId}:${tab.tabId}`, tab]));
  const candidates = new Map<string, { session: BrowserSessionState; candidate: (typeof inventory.tabs)[number] }>();
  for (const session of listSavedBrowserSessions(repoRoot)) {
    const browser = session.browser;
    const tab = browser?.tab;
    if (browser?.provider !== 'macos-apple-events' || browser.browserProduct !== product || tab?.ownership !== 'plugin_owned') continue;
    if (!tab.windowId || !tab.tabId) continue;
    const key = `${tab.windowId}:${tab.tabId}`;
    const live = liveByRef.get(key);
    if (!live) continue;
    const previous = candidates.get(key);
    if (!previous || session.updatedAt > previous.session.updatedAt) candidates.set(key, { session, candidate: live });
  }

  const values = [...candidates.values()];
  const exact = values.filter(({ candidate }) => comparableUrl(candidate.url) === comparableUrl(targetUrl));
  const choose = (matches: typeof values, match: 'exact_url' | 'same_origin') => {
    if (matches.length === 1) return { ...matches[0], match, candidateCount: 1 } as const;
    const active = matches.filter(({ candidate }) => candidate.active);
    if (active.length === 1) return { ...active[0], match, candidateCount: matches.length } as const;
    return { match: 'ambiguous' as const, candidateCount: matches.length };
  };
  if (exact.length > 0) return choose(exact, 'exact_url');

  const sameOriginCandidates = values.filter(({ candidate }) => sameOrigin(candidate.url, targetUrl));
  if (sameOriginCandidates.length > 0) return choose(sameOriginCandidates, 'same_origin');
  return { match: 'none', candidateCount: 0 };
}

function selectExactNativeTab(
  targetUrl: string,
  inventory: Awaited<ReturnType<typeof listMacOsBrowserTabs>>,
): { candidate?: (typeof inventory.tabs)[number]; match: 'exact_url' | 'none' | 'ambiguous'; candidateCount: number } {
  const matches = inventory.tabs.filter((candidate) => comparableUrl(candidate.url) === comparableUrl(targetUrl));
  if (matches.length === 0) return { match: 'none', candidateCount: 0 };
  if (matches.length === 1) return { candidate: matches[0], match: 'exact_url', candidateCount: 1 };
  const active = matches.filter((candidate) => candidate.active);
  if (active.length === 1) return { candidate: active[0], match: 'exact_url', candidateCount: matches.length };
  return { match: 'ambiguous', candidateCount: matches.length };
}

function isBlankPage(url: string): boolean {
  return !url || url === 'about:blank' || url === 'chrome://newtab/';
}

async function inventoryTabs(context: BrowserContextLike): Promise<BrowserTabInventoryEntry[]> {
  const entries: BrowserTabInventoryEntry[] = [];
  const pages = context.pages();
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    if (!page) continue;
    const url = page.url();
    let title: string | undefined;
    let ownerToken: string | undefined;
    try {
      title = await page.title();
    } catch {
      title = undefined;
    }
    try {
      const candidate = await page.evaluate<string>('typeof window !== "undefined" ? String(window.name || "") : ""');
      ownerToken = typeof candidate === 'string' && candidate.startsWith(BROWSER_OWNER_PREFIX) ? candidate : undefined;
    } catch {
      ownerToken = undefined;
    }
    entries.push({ index, key: tabKey(url, title), url, title, ownerToken });
  }
  return entries;
}

function chooseTab(
  inventory: BrowserTabInventoryEntry[],
  target: BrowserActionTarget,
  options: { allowBlank?: boolean; requireOwnedToken?: boolean } = {},
): { entry?: BrowserTabInventoryEntry; matchedBy: BrowserTabMatchReason; sessionResume?: BrowserSessionResumeDiagnostic } {
  const desiredUrl = comparableUrl(target.url);
  const savedTab = target.existingSession?.browser?.tab;
  const expectedOwnerToken = savedTab?.ownership === 'plugin_owned' ? savedTab.ownerToken : undefined;
  if (options.requireOwnedToken) {
    const owned = expectedOwnerToken ? inventory.find((entry) => entry.ownerToken === expectedOwnerToken) : undefined;
    if (owned) {
      return {
        entry: owned,
        matchedBy: 'owned_token',
        sessionResume: { sessionId: target.sessionId, status: 'matched', reason: 'Saved plugin-owned tab marker matched an attached browser tab.', savedTab },
      };
    }
    return {
      matchedBy: 'new_page',
      sessionResume: savedTab
        ? { sessionId: target.sessionId, status: 'stale_tab', reason: 'Saved plugin-owned tab marker was not found; refusing to use a user-owned tab.', savedTab }
        : { sessionId: target.sessionId, status: 'no_saved_tab', reason: 'No plugin-owned tab exists in the attached browser.' },
    };
  }
  const savedUrl = savedTab?.url ? comparableUrl(savedTab.url) : undefined;
  const savedTitle = savedTab?.title;
  const savedUrlTitle = savedUrl && savedTitle
    ? inventory.find((entry) => comparableUrl(entry.url) === savedUrl && entry.title === savedTitle)
    : undefined;
  if (savedUrlTitle) {
    return {
      entry: savedUrlTitle,
      matchedBy: 'saved_url_title',
      sessionResume: {
        sessionId: target.sessionId,
        status: 'matched',
        reason: 'Saved tab URL and title matched an attached browser tab.',
        savedTab,
      },
    };
  }

  const savedUrlOnly = savedUrl
    ? inventory.find((entry) => comparableUrl(entry.url) === savedUrl)
    : undefined;
  if (savedUrlOnly) {
    return {
      entry: savedUrlOnly,
      matchedBy: 'saved_url',
      sessionResume: {
        sessionId: target.sessionId,
        status: savedTab ? 'matched' : 'no_saved_tab',
        reason: savedTab ? 'Saved tab URL matched but the previous title was not present.' : 'No saved tab metadata was available.',
        savedTab,
      },
    };
  }

  const exactUrl = inventory.find((entry) => comparableUrl(entry.url) === desiredUrl);
  if (exactUrl) {
    return {
      entry: exactUrl,
      matchedBy: 'exact_url',
      sessionResume: savedTab
        ? {
            sessionId: target.sessionId,
            status: 'stale_tab',
            reason: 'Saved tab was not found; reused another tab with the target URL.',
            savedTab,
          }
        : {
            sessionId: target.sessionId,
            status: 'no_saved_tab',
            reason: 'No saved tab metadata was available; reused an existing tab with the target URL.',
          },
    };
  }

  const blank = options.allowBlank === false ? undefined : inventory.find((entry) => isBlankPage(entry.url));
  if (blank) {
    return {
      entry: blank,
      matchedBy: 'blank',
      sessionResume: savedTab
        ? {
            sessionId: target.sessionId,
            status: 'stale_tab',
            reason: 'Saved tab was not found; reused a blank tab for navigation.',
            savedTab,
          }
        : {
            sessionId: target.sessionId,
            status: 'no_saved_tab',
            reason: 'No saved tab metadata was available; reused a blank tab for navigation.',
          },
    };
  }

  return {
    matchedBy: 'new_page',
    sessionResume: savedTab
      ? {
          sessionId: target.sessionId,
          status: 'stale_tab',
          reason: 'Saved tab was not found; opened a new tab for navigation.',
          savedTab,
        }
      : {
          sessionId: target.sessionId,
          status: 'no_saved_tab',
          reason: 'No saved tab metadata was available; opened a new tab for navigation.',
        },
  };
}

async function selectPage(
  context: BrowserContextLike,
  target: BrowserActionTarget,
  options: { allowBlank?: boolean; allowNewPage?: boolean; bringToFront?: boolean; requireOwnedToken?: boolean } = {},
): Promise<{ page: PageLike; matchedBy: BrowserTabMatchReason; inventory: BrowserTabInventoryEntry[]; selectedEntry?: BrowserTabInventoryEntry; sessionResume?: BrowserSessionResumeDiagnostic }> {
  const inventory = await inventoryTabs(context);
  const selection = chooseTab(inventory, target, { allowBlank: options.allowBlank, requireOwnedToken: options.requireOwnedToken });
  if (selection.entry) {
    const page = context.pages()[selection.entry.index];
    if (!page) throw new Error(`Browser tab inventory selected missing page index ${selection.entry.index}`);
    if (options.bringToFront === true && page.bringToFront) await page.bringToFront().catch(() => undefined);
    return { page, matchedBy: selection.matchedBy, inventory, selectedEntry: selection.entry, sessionResume: selection.sessionResume };
  }
  if (options.allowNewPage === false) {
    throw new AssistantPluginError(
      'PLUGIN_BROWSER_ATTACHED_TAB_NOT_FOUND',
      'Attached browser had no saved or exact target tab; refusing to reuse a blank tab or open a new tab in the user browser.',
      { retryable: true, details: { sessionId: target.sessionId, targetUrl: target.url, tabCount: inventory.length } },
    );
  }
  const page = await context.newPage();
  return { page, matchedBy: 'new_page', inventory, sessionResume: selection.sessionResume };
}

function sessionConnectionFromSummary(connection: BrowserConnectionSummary): BrowserSessionConnectionState {
  return {
    mode: connection.requestedMode,
    activeMode: connection.mode,
    provider: connection.provider,
    endpoint: connection.endpoint,
    browserVersion: connection.browserVersion,
    browserProduct: connection.browserProduct,
    fallback: connection.fallback,
    tab: connection.tab,
    sessionResume: connection.sessionResume,
  };
}

function refreshConnectionTab(
  connection: BrowserConnectionSummary,
  pageUrl: string,
  title: string,
  matchedBy: BrowserTabMatchReason = connection.tab?.matchedBy ?? 'exact_url',
  ownership?: Pick<BrowserTabResumeState, 'ownership' | 'ownerToken' | 'windowId' | 'tabId'>,
): BrowserConnectionSummary {
  const index = connection.tab?.index ?? connection.tabInventory?.find((entry) => comparableUrl(entry.url) === comparableUrl(pageUrl) && entry.title === title)?.index ?? 0;
  return {
    ...connection,
    tab: {
      key: tabKey(pageUrl, title),
      index,
      url: pageUrl,
      title,
      matchedBy,
      inventoryCount: connection.tabInventory?.length ?? 1,
      capturedAt: now(),
      ownership: ownership?.ownership ?? connection.tab?.ownership,
      ownerToken: ownership?.ownerToken ?? connection.tab?.ownerToken,
      windowId: ownership?.windowId ?? connection.tab?.windowId,
      tabId: ownership?.tabId ?? connection.tab?.tabId,
    },
  };
}

function cdpDiscoveryTimeout(config: BrowserPluginConfig): number {
  return Math.min(config.cdpDiscoveryTimeoutMs ?? DEFAULT_CDP_DISCOVERY_TIMEOUT_MS, MAX_CDP_DISCOVERY_TIMEOUT_MS);
}

async function discoverCdpEndpoint(endpoint: string, timeoutMs: number): Promise<CdpAttachAttempt> {
  const parsed = new URL(endpoint);
  if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') return { endpoint, discoveredEndpoint: endpoint };
  const probeUrl = new URL('/json/version', parsed.origin).toString();
  const body = await runtimeHooks.fetchJson(probeUrl, timeoutMs) as { webSocketDebuggerUrl?: unknown; Browser?: unknown };
  const discoveredEndpoint = typeof body.webSocketDebuggerUrl === 'string' && body.webSocketDebuggerUrl.trim()
    ? body.webSocketDebuggerUrl.trim()
    : endpoint;
  const discoveredError = cdpEndpointValidationError(discoveredEndpoint);
  if (discoveredError) throw new Error(discoveredError);
  return {
    endpoint,
    discoveredEndpoint,
    probeUrl,
    browserVersion: typeof body.Browser === 'string' ? body.Browser : undefined,
  };
}

function launchOptionsForRepo(repoRoot: string, config: BrowserPluginConfig, profile: BrowserProfileSelection): Record<string, unknown> {
  return {
    headless: false,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
    ...(config.executablePath ? { executablePath: resolveConfiguredPath(repoRoot, config.executablePath) } : {}),
    ...(!config.executablePath && config.browserChannel && config.browserChannel !== 'chromium' ? { channel: config.browserChannel } : {}),
    ...(profile.profileDirectory ? { args: [`--profile-directory=${profile.profileDirectory}`] } : {}),
  };
}

function managedContextKey(profile: BrowserProfileSelection): string {
  return resolve(profile.selectedProfilePath);
}

async function evictManagedContext(key: string): Promise<void> {
  const pending = managedBrowserContexts.get(key);
  managedBrowserContexts.delete(key);
  if (!pending) return;
  try {
    const state = await pending;
    await state.context.close().catch(() => undefined);
  } catch {
    // Failed launches are already unusable; removing the cache entry is enough.
  }
}

async function closeManagedContextsForRepo(repoRoot: string, options: { strict?: boolean } = {}): Promise<void> {
  const canonicalRoot = resolve(repoRoot);
  for (const [key, pending] of [...managedBrowserContexts.entries()]) {
    let state: ManagedBrowserContextState;
    try {
      state = await pending;
    } catch {
      managedBrowserContexts.delete(key);
      continue;
    }
    if (state.repoRoot !== canonicalRoot) continue;
    try {
      await state.context.close();
      managedBrowserContexts.delete(key);
    } catch (error) {
      if (options.strict === true) {
        throw new AssistantPluginError('PLUGIN_BROWSER_MANAGED_CONTEXT_CLOSE_FAILED', 'Managed browser context could not be closed; retaining Runtime binding and session metadata for a safe retry.', {
          retryable: true, details: { profilePath: state.profilePath, cause: error instanceof Error ? error.message : String(error) },
        });
      }
      managedBrowserContexts.delete(key);
    }
  }
}

async function managedContextState(
  runtime: PlaywrightRuntime,
  repoRoot: string,
  config: BrowserPluginConfig,
  profile: BrowserProfileSelection,
): Promise<ManagedBrowserContextState> {
  const key = managedContextKey(profile);
  const existing = managedBrowserContexts.get(key);
  if (existing) {
    try {
      const state = await existing;
      state.context.pages();
      return state;
    } catch {
      managedBrowserContexts.delete(key);
    }
  }
  const launch = (async () => {
    const context = await runtime.chromium.launchPersistentContext(profile.profileDir, launchOptionsForRepo(repoRoot, config, profile));
    return {
      repoRoot: resolve(repoRoot),
      profilePath: key,
      context,
      pagesBySession: new Map<string, PageLike>(),
    } satisfies ManagedBrowserContextState;
  })();
  managedBrowserContexts.set(key, launch);
  try {
    return await launch;
  } catch (error) {
    if (managedBrowserContexts.get(key) === launch) managedBrowserContexts.delete(key);
    throw error;
  }
}

async function markManagedPageOwner(page: PageLike, ownerToken: string): Promise<void> {
  await page.evaluate((_token) => {
    if (typeof window !== 'undefined') window.name = String(_token ?? '');
  }, ownerToken).catch(() => undefined);
}

async function selectManagedSessionPage(
  state: ManagedBrowserContextState,
  target: BrowserActionTarget,
  options: { allowReplacement?: boolean } = {},
) {
  const pages = state.context.pages();
  const inventory = await inventoryTabs(state.context);
  const ownerToken = ownerTokenForSession(target.sessionId);
  const mapped = state.pagesBySession.get(target.sessionId);
  if (mapped && pages.includes(mapped)) {
    const index = pages.indexOf(mapped);
    await markManagedPageOwner(mapped, ownerToken);
    return {
      page: mapped,
      matchedBy: 'owned_token' as const,
      inventory,
      selectedEntry: inventory[index],
      sessionResume: {
        sessionId: target.sessionId,
        status: 'matched' as const,
        reason: 'Reused the live managed page bound to this browser session.',
        savedTab: target.existingSession?.browser?.tab,
      },
      ownerToken,
    };
  }
  state.pagesBySession.delete(target.sessionId);

  const ownerIndex = inventory.findIndex((entry) => entry.ownerToken === ownerToken);
  if (ownerIndex >= 0) {
    const page = pages[ownerIndex];
    if (page) {
      state.pagesBySession.set(target.sessionId, page);
      return {
        page,
        matchedBy: 'owned_token' as const,
        inventory,
        selectedEntry: inventory[ownerIndex],
        sessionResume: {
          sessionId: target.sessionId,
          status: 'matched' as const,
          reason: 'Rediscovered the managed page from its stable session owner marker.',
          savedTab: target.existingSession?.browser?.tab,
        },
        ownerToken,
      };
    }
  }

  if (target.existingSession && options.allowReplacement === false) {
    throw new AssistantPluginError(
      'PLUGIN_BROWSER_SESSION_STATE_LOST',
      'Saved managed browser page no longer exists; refusing to create or claim a replacement page for this existing-session action.',
      {
        retryable: false,
        details: { sessionId: target.sessionId, provider: 'playwright-persistent-context' },
      },
    );
  }

  const blankIndex = inventory.findIndex((entry) => isBlankPage(entry.url) && !entry.ownerToken);
  const page = blankIndex >= 0 && pages[blankIndex] ? pages[blankIndex]! : await state.context.newPage();
  const matchedBy: BrowserTabMatchReason = blankIndex >= 0 ? 'blank' : 'new_page';
  await markManagedPageOwner(page, ownerToken);
  state.pagesBySession.set(target.sessionId, page);
  return {
    page,
    matchedBy,
    inventory,
    selectedEntry: blankIndex >= 0 ? inventory[blankIndex] : undefined,
    sessionResume: target.existingSession?.browser?.tab
      ? {
          sessionId: target.sessionId,
          status: 'stale_tab' as const,
          reason: 'The previously owned managed page no longer exists; created one replacement page for this session only.',
          savedTab: target.existingSession.browser.tab,
        }
      : {
          sessionId: target.sessionId,
          status: 'no_saved_tab' as const,
          reason: matchedBy === 'blank'
            ? 'Claimed one unowned blank page for this managed browser session.'
            : 'Created one dedicated managed page for this browser session.',
        },
    ownerToken,
  };
}

async function runtimeManagedPageForSession(
  repoRoot: string,
  config: BrowserPluginConfig,
  session: BrowserSessionState,
): Promise<{ page: PageLike; profile: BrowserProfileSelection } | undefined> {
  if (session.browser?.provider !== 'playwright-persistent-context' || session.browser.activeMode !== 'managed_persistent') return undefined;
  const profile = selectedProfile(config, repoRoot, 'managed_persistent', session.sessionId);
  const pending = managedBrowserContexts.get(managedContextKey(profile));
  if (!pending) return undefined;
  let state: ManagedBrowserContextState;
  try {
    state = await pending;
  } catch {
    return undefined;
  }
  let page = state.pagesBySession.get(session.sessionId);
  if (page && state.context.pages().includes(page)) return { page, profile };
  state.pagesBySession.delete(session.sessionId);
  const expectedOwnerToken = session.browser.tab?.ownerToken ?? ownerTokenForSession(session.sessionId);
  const inventory = await inventoryTabs(state.context).catch(() => [] as BrowserTabInventoryEntry[]);
  const index = inventory.findIndex((entry) => entry.ownerToken === expectedOwnerToken);
  page = index >= 0 ? state.context.pages()[index] : undefined;
  if (!page) return undefined;
  state.pagesBySession.set(session.sessionId, page);
  return { page, profile };
}

async function closeManagedSessionPage(repoRoot: string, config: BrowserPluginConfig, session: BrowserSessionState): Promise<boolean> {
  if (session.browser?.provider !== 'playwright-persistent-context' || session.browser.activeMode !== 'managed_persistent') return false;
  const profile = selectedProfile(config, repoRoot, 'managed_persistent', session.sessionId);
  const pending = managedBrowserContexts.get(managedContextKey(profile));
  if (!pending) return false;
  let state: ManagedBrowserContextState;
  try {
    state = await pending;
  } catch {
    return false;
  }
  let page = state.pagesBySession.get(session.sessionId);
  if (!page) {
    const expectedOwnerToken = session.browser.tab?.ownerToken ?? ownerTokenForSession(session.sessionId);
    const inventory = await inventoryTabs(state.context).catch(() => [] as BrowserTabInventoryEntry[]);
    const index = inventory.findIndex((entry) => entry.ownerToken === expectedOwnerToken);
    if (index >= 0) page = state.context.pages()[index];
  }
  if (!page || typeof page.close !== 'function') {
    state.pagesBySession.delete(session.sessionId);
    return false;
  }
  await page.close();
  state.pagesBySession.delete(session.sessionId);
  return true;
}

async function openManagedContext(
  runtime: PlaywrightRuntime,
  repoRoot: string,
  config: BrowserPluginConfig,
  target: BrowserActionTarget,
  args: Record<string, unknown>,
  activeMode: BrowserMode,
  requestedMode: BrowserMode,
  fallback?: BrowserConnectionFallback,
): Promise<BrowserOpenHandle> {
  const profile = selectedProfile(config, repoRoot, activeMode, target.sessionId);
  const persistentKey = managedContextKey(profile);
  const requireExistingResource = args.__forge_require_existing_resource === true;
  const allowManagedSessionRehydrate = requireExistingResource && args.__forge_allow_managed_session_rehydrate === true;
  const managedContextWasMissing = !managedBrowserContexts.has(persistentKey);
  if (requireExistingResource && target.existingSession && activeMode === 'managed_persistent') {
    const savedConnection = target.existingSession.browser;
    if (savedConnection?.provider !== 'playwright-persistent-context'
      || savedConnection.activeMode !== 'managed_persistent') {
      throw new AssistantPluginError(
        'PLUGIN_BROWSER_SESSION_STATE_LOST',
        'Saved browser session belongs to a different browser provider/mode; refusing to migrate it into a replacement managed browser/page for this existing-session action.',
        {
          retryable: false,
          details: {
            sessionId: target.sessionId,
            savedProvider: savedConnection?.provider,
            savedActiveMode: savedConnection?.activeMode,
            requestedActiveMode: activeMode,
          },
        },
      );
    }
    if (managedContextWasMissing && !allowManagedSessionRehydrate) {
      throw new AssistantPluginError(
        'PLUGIN_BROWSER_SESSION_STATE_LOST',
        'The managed browser context for this saved session is no longer live; refusing to launch a replacement browser/page for this existing-session action.',
        { retryable: false, details: { sessionId: target.sessionId, provider: 'playwright-persistent-context' } },
      );
    }
  }
  assertBrowserProfileAvailable(repoRoot, profile.selectedProfilePath);
  mkdirSync(profile.profileDir, { recursive: true });
  let context: BrowserContextLike;
  let selected: Awaited<ReturnType<typeof selectManagedSessionPage>> | Awaited<ReturnType<typeof selectPage>>;
  let managedState: ManagedBrowserContextState | undefined;
  if (activeMode === 'managed_persistent') {
    managedState = await managedContextState(runtime, repoRoot, config, profile);
    context = managedState.context;
    try {
      selected = await selectManagedSessionPage(managedState, target, { allowReplacement: !requireExistingResource });
    } catch (error) {
      if (requireExistingResource) {
        if (allowManagedSessionRehydrate && managedContextWasMissing) await evictManagedContext(persistentKey);
        throw error;
      }
      await evictManagedContext(persistentKey);
      assertBrowserProfileAvailable(repoRoot, profile.selectedProfilePath);
      managedState = await managedContextState(runtime, repoRoot, config, profile);
      context = managedState.context;
      selected = await selectManagedSessionPage(managedState, target);
    }
  } else {
    context = await runtime.chromium.launchPersistentContext(profile.profileDir, launchOptionsForRepo(repoRoot, config, profile));
    selected = await selectPage(context, target);
  }
  const timeout = positiveNumber(args.timeout_ms, config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: { status?: () => number } | null | undefined;
  if (selected.matchedBy === 'new_page' || selected.matchedBy === 'blank' || comparableUrl(selected.page.url()) !== comparableUrl(target.url)) {
    response = await selected.page.goto(target.url, { waitUntil: waitUntil(args.wait_until), timeout }) as { status?: () => number } | null | undefined;
  }
  if (managedState && 'ownerToken' in selected) await markManagedPageOwner(selected.page, selected.ownerToken);
  const diagnostics = attachDiagnostics(selected.page);
  diagnostics.navigation = {
    url: target.url,
    status: response && typeof response.status === 'function' ? response.status() : undefined,
  };
  const title = await selected.page.title();
  const connection = refreshConnectionTab({
    requestedMode,
    mode: activeMode,
    provider: 'playwright-persistent-context',
    attached: false,
    fallback,
    profile: {
      profileMode: activeMode === 'isolated' ? 'repo_local' : config.profileMode,
      profileDirectory: profile.profileDirectory,
      selectedProfilePath: profile.selectedProfilePath,
    },
    tabInventory: selected.inventory,
    sessionResume: selected.sessionResume,
  }, normalizedUrl(selected.page.url()), title, selected.matchedBy,
  managedState && 'ownerToken' in selected
    ? { ownership: 'plugin_owned', ownerToken: selected.ownerToken }
    : undefined);
  return {
    page: selected.page,
    diagnostics,
    connection,
    close: async () => {
      if (activeMode === 'isolated') await context.close().catch(() => undefined);
    },
  };
}

async function openAttachedContext(
  runtime: PlaywrightRuntime,
  repoRoot: string,
  config: BrowserPluginConfig,
  target: BrowserActionTarget,
  args: Record<string, unknown>,
): Promise<{ handle?: BrowserOpenHandle; attempts: CdpAttachAttempt[] }> {
  const attempts: CdpAttachAttempt[] = [];
  const profile = selectedProfile(config, repoRoot, 'managed_persistent', target.sessionId);
  assertBrowserProfileAvailable(repoRoot, profile.selectedProfilePath);
  const connectOverCDP = runtime.chromium.connectOverCDP;
  if (typeof connectOverCDP !== 'function') {
    return {
      attempts: [{
        endpoint: cdpEndpoints(config)[0] ?? '(none)',
        error: 'Playwright chromium.connectOverCDP is unavailable in this runtime.',
      }],
    };
  }
  for (const endpoint of cdpEndpoints(config)) {
    const attempt: CdpAttachAttempt = { endpoint };
    try {
      const discovered = await discoverCdpEndpoint(endpoint, cdpDiscoveryTimeout(config));
      Object.assign(attempt, discovered);
      const browser = await connectOverCDP.call(runtime.chromium, discovered.discoveredEndpoint ?? endpoint);
      try {
        const context = browser.contexts()[0] ?? (browser.newContext ? await browser.newContext() : undefined);
        if (!context) throw new Error('CDP connection did not expose a browser context.');
        const selected = await selectPage(context, target, { allowBlank: false, allowNewPage: false, requireOwnedToken: true });
      const timeout = positiveNumber(args.timeout_ms, config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
      let response: { status?: () => number } | null | undefined;
      if (selected.matchedBy === 'new_page' || selected.matchedBy === 'blank' || comparableUrl(selected.page.url()) !== comparableUrl(target.url)) {
        response = await selected.page.goto(target.url, { waitUntil: waitUntil(args.wait_until), timeout }) as { status?: () => number } | null | undefined;
      }
      const diagnostics = attachDiagnostics(selected.page);
      diagnostics.navigation = {
        url: target.url,
        status: response && typeof response.status === 'function' ? response.status() : undefined,
      };
      const title = await selected.page.title();
      const connection = refreshConnectionTab({
        requestedMode: 'attach_preferred',
        mode: 'attach_preferred',
        provider: 'playwright-cdp',
        attached: true,
        endpoint: discovered.discoveredEndpoint ?? endpoint,
        browserVersion: discovered.browserVersion,
        profile: {
          profileMode: config.profileMode,
          profileDirectory: profile.profileDirectory,
          selectedProfilePath: profile.selectedProfilePath,
        },
        tabInventory: selected.inventory,
        sessionResume: selected.sessionResume,
      }, normalizedUrl(selected.page.url()), title, selected.matchedBy, selected.selectedEntry?.ownerToken
        ? { ownership: 'plugin_owned', ownerToken: selected.selectedEntry.ownerToken }
        : undefined);
        return {
          attempts,
          handle: {
            page: selected.page,
            diagnostics,
            connection,
            close: async () => {
              if (browser.disconnect) await Promise.resolve(browser.disconnect()).catch(() => undefined);
              else if (browser.close) await browser.close().catch(() => undefined);
            },
          },
        };
      } catch (error) {
        if (browser.disconnect) await Promise.resolve(browser.disconnect()).catch(() => undefined);
        else if (browser.close) await browser.close().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      attempt.error = error instanceof Error ? error.message : String(error);
      attempts.push(attempt);
    }
  }
  return { attempts };
}

async function openNativeAttachedContext(
  repoRoot: string,
  config: BrowserPluginConfig,
  target: BrowserActionTarget,
  args: Record<string, unknown>,
): Promise<{ handle?: BrowserOpenHandle; attempts: MacOsBrowserAttachAttempt[] }> {
  if (config.nativeAttachMode === 'disabled') return { attempts: [] };
  if (!target.existingSession && !stringValue(args.session_id)) {
    await inspectNativeOwnedSessions(repoRoot, config, listSavedSessions(repoRoot), { pruneDead: true });
  }
  const timeout = positiveNumber(args.timeout_ms, config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  const savedTab = target.existingSession?.browser?.tab;
  const savedOwnership = savedTab?.ownership;
  let effectiveOwnership = savedOwnership;
  let recoveredTabTitle = '';
  let recoveredTabUrl: string | undefined;
  const savedProduct = target.existingSession?.browser?.provider === 'macos-apple-events'
    && savedTab
    && (savedOwnership === 'plugin_owned' || savedOwnership === 'user_owned')
    && typeof savedTab.windowId === 'string'
    && typeof savedTab.tabId === 'string'
    ? target.existingSession.browser.browserProduct
    : undefined;
  let page: PageLike | undefined;
  let discovered: Awaited<ReturnType<typeof discoverMacOsBrowserAttachment>> | undefined;
  let sessionResume: BrowserSessionResumeDiagnostic = savedTab
    ? { sessionId: target.sessionId, status: 'stale_tab', reason: 'Saved native tab has not yet been reattached.', savedTab }
    : { sessionId: target.sessionId, status: 'no_saved_tab', reason: 'No saved native tab exists yet.' };
  let matchedBy: BrowserTabMatchReason = 'new_page';

  if (savedProduct && savedTab && typeof savedTab.windowId === 'string' && typeof savedTab.tabId === 'string') {
    const ref: MacOsBrowserTabRef = { windowId: savedTab.windowId, tabId: savedTab.tabId };
    try {
      const reattached = await reattachMacOsBrowserOwnedPage(savedProduct, ref, timeout);
      page = reattached.page as unknown as PageLike;
      discovered = { attachment: reattached.attachment, attempts: reattached.attachment.attempts };
      matchedBy = savedOwnership === 'user_owned' ? 'saved_url' : 'owned_token';
      sessionResume = {
        sessionId: target.sessionId,
        status: 'matched',
        reason: savedOwnership === 'user_owned'
          ? 'Reattached directly to the explicitly adopted user-owned macOS browser tab.'
          : 'Reattached directly to the saved plugin-owned macOS browser tab.',
        savedTab,
      };
    } catch (error) {
      if (savedOwnership === 'user_owned') {
        throw new AssistantPluginError(
          'PLUGIN_BROWSER_SESSION_STATE_LOST',
          'Explicitly adopted user-owned macOS browser tab no longer exists; refusing to silently switch to another user tab.',
          {
            retryable: false,
            details: { sessionId: target.sessionId, browserProduct: savedProduct, ownership: savedOwnership, windowId: savedTab.windowId, tabId: savedTab.tabId, cause: error instanceof Error ? error.message : String(error) },
          },
        );
      }
      let inventory: Awaited<ReturnType<typeof listMacOsBrowserTabs>> | undefined;
      let selection: ReturnType<typeof selectReusableNativeTab> | undefined;
      let recoveryFailure: string | undefined;
      try {
        inventory = await listMacOsBrowserTabs(savedProduct, timeout);
        selection = selectReusableNativeTab(
          [savedTab.url, target.existingSession?.url ?? '', target.url],
          inventory,
          savedTab.windowId,
        );
        if (selection.candidate) {
          const recovered = await reattachMacOsBrowserOwnedPage(savedProduct, { windowId: selection.candidate.windowId, tabId: selection.candidate.tabId }, timeout);
          page = recovered.page as unknown as PageLike;
          discovered = { attachment: recovered.attachment, attempts: recovered.attachment.attempts };
          matchedBy = 'recovered_tab';
          effectiveOwnership = 'user_owned';
          recoveredTabTitle = selection.candidate.title;
          recoveredTabUrl = selection.candidate.url;
          sessionResume = {
            sessionId: target.sessionId,
            status: 'matched',
            reason: selection.match === 'exact_url'
              ? 'Saved plugin-owned tab disappeared; rebound safely to the unique currently open tab with the same URL and preserved it as user-owned.'
              : 'Saved plugin-owned tab disappeared; rebound safely to the unique currently open tab for the same stable app entity and preserved its current page as user-owned.',
            savedTab,
          };
        }
      } catch (recoveryError) {
        recoveryFailure = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
      }
      if (!page) {
        sessionResume = {
          sessionId: target.sessionId,
          status: 'stale_tab',
          reason: recoveryFailure
            ? `Saved plugin-owned macOS browser tab disappeared and current-tab recovery failed (${recoveryFailure}); creating one replacement plugin-owned tab.`
            : selection?.match === 'ambiguous'
              ? 'Saved plugin-owned macOS browser tab disappeared and multiple reusable current tabs matched; refusing to guess between user tabs and creating one replacement plugin-owned tab.'
              : 'Saved plugin-owned macOS browser tab disappeared and no uniquely reusable current tab matched; creating one replacement plugin-owned tab.',
          savedTab,
        };
      }
    }
  } else {
    sessionResume = savedTab
      ? { sessionId: target.sessionId, status: 'stale_tab', reason: 'Legacy or user-owned tab metadata is never reused for plugin actions; one plugin-owned tab was created.', savedTab }
      : { sessionId: target.sessionId, status: 'no_saved_tab', reason: 'Created one plugin-owned tab while preserving the user active tab.' };
  }

  if (!discovered?.attachment) {
    const candidates = savedProduct ? [savedProduct, ...(config.nativeBrowserCandidates ?? ['vivaldi', 'chrome']).filter((product) => product !== savedProduct)] : (config.nativeBrowserCandidates ?? ['vivaldi', 'chrome']);
    discovered = await discoverMacOsBrowserAttachment(candidates, Math.min(timeout, MAX_CDP_DISCOVERY_TIMEOUT_MS));
  }
  if (!discovered.attachment) return { attempts: discovered.attempts };
  let activeAttachment = discovered.attachment;

  let createdThisCallRef: MacOsBrowserTabRef | undefined;
  try {
    if (!page && !savedTab && !stringValue(args.session_id)) {
      const inventory = await listMacOsBrowserTabs(activeAttachment.metadata.product, timeout);
      const ownedSelection = selectLiveForgeOwnedNativeTab(repoRoot, target.url, activeAttachment.metadata.product, inventory);
      if (ownedSelection.match === 'ambiguous') {
        throw new AssistantPluginError(
          'PLUGIN_BROWSER_REUSABLE_TAB_AMBIGUOUS',
          'Multiple live Forge-owned browser tabs can satisfy this sessionless navigation; refusing to open another duplicate tab.',
          { retryable: false, details: { targetUrl: target.url, candidateCount: ownedSelection.candidateCount } },
        );
      }
      if (ownedSelection.candidate) {
        if (ownedSelection.session) {
          target.sessionId = ownedSelection.session.sessionId;
          target.existingSession = ownedSelection.session;
        }
        const rebound = await reattachMacOsBrowserOwnedPage(
          activeAttachment.metadata.product,
          { windowId: ownedSelection.candidate.windowId, tabId: ownedSelection.candidate.tabId },
          timeout,
        );
        page = rebound.page as unknown as PageLike;
        discovered = { attachment: rebound.attachment, attempts: rebound.attachment.attempts };
        activeAttachment = rebound.attachment;
        matchedBy = 'owned_token';
        effectiveOwnership = 'plugin_owned';
        sessionResume = {
          sessionId: target.sessionId,
          status: 'matched',
          reason: ownedSelection.match === 'exact_url'
            ? 'No session id was supplied; reused the unique live Forge-owned native tab already at the target URL.'
            : 'No session id was supplied; reused the unique live Forge-owned native tab for the same origin and navigated it in place.',
          savedTab: ownedSelection.session?.browser?.tab,
        };
      } else {
        const exactSelection = selectExactNativeTab(target.url, inventory);
        if (exactSelection.match === 'ambiguous') {
          throw new AssistantPluginError(
            'PLUGIN_BROWSER_REUSABLE_TAB_AMBIGUOUS',
            'Multiple existing browser tabs already match the target URL; refusing to open another duplicate tab.',
            { retryable: false, details: { targetUrl: target.url, candidateCount: exactSelection.candidateCount } },
          );
        }
        if (exactSelection.candidate) {
          const rebound = await reattachMacOsBrowserOwnedPage(
            activeAttachment.metadata.product,
            { windowId: exactSelection.candidate.windowId, tabId: exactSelection.candidate.tabId },
            timeout,
          );
          page = rebound.page as unknown as PageLike;
          discovered = { attachment: rebound.attachment, attempts: rebound.attachment.attempts };
        activeAttachment = rebound.attachment;
          matchedBy = 'exact_url';
          effectiveOwnership = 'user_owned';
          recoveredTabTitle = exactSelection.candidate.title;
          recoveredTabUrl = exactSelection.candidate.url;
          sessionResume = {
            sessionId: target.sessionId,
            status: 'matched',
            reason: 'No session id was supplied; reused the unique existing native browser tab with the exact target URL instead of opening a duplicate.',
          };
        }
      }
    }
    if (!page) {
      page = await createMacOsBrowserOwnedPage(activeAttachment, target.url, timeout) as unknown as PageLike;
      createdThisCallRef = (page as unknown as { tabRef?: () => MacOsBrowserTabRef | undefined }).tabRef?.();
      const liveIdentity = await (page as unknown as { identity?: () => Promise<{ url: string; title: string }> }).identity?.()
        .catch(() => undefined);
      if (!liveIdentity?.url || isBlankPage(liveIdentity.url) || comparableUrl(liveIdentity.url) !== comparableUrl(target.url)) {
        await page.goto(target.url, { waitUntil: waitUntil(args.wait_until), timeout });
      }
    }
    if (comparableUrl(page.url()) !== comparableUrl(target.url)) {
      const currentRef = (page as unknown as { tabRef?: () => MacOsBrowserTabRef | undefined }).tabRef?.();
      if (effectiveOwnership === 'user_owned') {
        if (matchedBy === 'recovered_tab') {
          sessionResume = { sessionId: target.sessionId, status: 'matched', reason: 'Recovered current user tab was already within the same saved app entity; preserved its current URL instead of navigating it.', savedTab };
        } else {
          throw new AssistantPluginError(
            'PLUGIN_BROWSER_ADOPTED_TAB_URL_MISMATCH',
            'Explicitly adopted user-owned tab no longer matches the saved session URL; refusing to navigate, replace, or close the user tab.',
            { retryable: true, details: { sessionId: target.sessionId, expectedUrl: target.url, actualUrl: page.url(), windowId: savedTab?.windowId, tabId: savedTab?.tabId } },
          );
        }
      }
      const sessionTargetUnchanged = Boolean(target.existingSession?.url) && comparableUrl(target.url) === comparableUrl(target.existingSession?.url ?? '');
      const preserveOwnedSameOriginDrift = matchedBy === 'owned_token' && sessionTargetUnchanged && sameOrigin(page.url(), target.url);
      if (matchedBy === 'recovered_tab' && effectiveOwnership === 'user_owned') {
        // Safe recovery adopts an already-open tab. Its current page is authoritative and must not be navigated.
      } else if (preserveOwnedSameOriginDrift) {
        sessionResume = { sessionId: target.sessionId, status: 'matched', reason: 'Plugin-owned tab navigated within the same origin; preserved the live tab and refreshed its session URL.', savedTab };
      } else {
        await page.goto(target.url, { waitUntil: waitUntil(args.wait_until), timeout });
        if (currentRef) {
          matchedBy = 'owned_token';
          sessionResume = { sessionId: target.sessionId, status: 'matched', reason: 'Navigated the existing plugin-owned tab in place and preserved its stable tab identity.', savedTab };
        }
      }
    }
    if (matchedBy !== 'owned_token' && page.waitForLoadState) {
      await page.waitForLoadState(waitUntil(args.wait_until), { timeout });
    }
    const pageUrl = normalizedUrl(matchedBy === 'recovered_tab' && recoveredTabUrl ? recoveredTabUrl : page.url());
    const nativeRef = (page as unknown as { tabRef?: () => MacOsBrowserTabRef | undefined }).tabRef?.();
    if (!nativeRef) throw new AssistantPluginError('PLUGIN_BROWSER_NATIVE_OWNERSHIP_MISSING', 'Native browser did not return a stable plugin-owned tab reference.', { retryable: true });
    const title = matchedBy === 'owned_token' ? (target.existingSession?.title ?? '') : matchedBy === 'recovered_tab' ? recoveredTabTitle : '';
    const inventory: BrowserTabInventoryEntry[] = [{ index: 0, key: tabKey(pageUrl, title), url: pageUrl, title }];
    const metadata = activeAttachment.metadata;
    const connection = refreshConnectionTab({
      requestedMode: 'attach_preferred',
      mode: 'attach_preferred',
      provider: 'macos-apple-events',
      attached: true,
      browserProduct: metadata.product,
      profile: {
        profileMode: config.profileMode,
        profileDirectory: config.profileDirectory,
        selectedProfilePath: `macos:${metadata.product}:owned-tab`,
      },
      tabInventory: inventory,
      sessionResume,
    }, pageUrl, title, matchedBy, {
      ownership: effectiveOwnership === 'user_owned' ? 'user_owned' : 'plugin_owned',
      windowId: nativeRef.windowId,
      tabId: nativeRef.tabId,
    });
    const diagnostics: PageDiagnostics = { consoleErrors: [], failedRequests: [], navigation: { url: pageUrl } };
    createdThisCallRef = undefined;
    return { attempts: discovered.attempts, handle: { page, diagnostics, connection, close: async () => undefined } };
  } catch (error) {
    if (createdThisCallRef) {
      await closeMacOsBrowserOwnedTab(activeAttachment.metadata.product, createdThisCallRef, timeout).catch(() => undefined);
    }
    throw error;
  }
}

async function openBrowser(
  repoRoot: string,
  config: BrowserPluginConfig,
  target: BrowserActionTarget,
  args: Record<string, unknown>,
): Promise<BrowserOpenHandle> {
  const requestedMode = config.browserMode ?? 'managed_persistent';
  if (requestedMode === 'attach_preferred') {
    const requireExistingResource = args.__forge_require_existing_resource === true;
    const existingProvider = target.existingSession?.browser?.provider;
    const attached = cdpEndpoints(config).length > 0 && runtimeHooks.moduleAvailable('playwright', repoRoot)
      ? await openAttachedContext(runtimeHooks.loadPlaywright(repoRoot), repoRoot, config, target, args)
      : { attempts: [] as CdpAttachAttempt[] };
    if (attached.handle) return attached.handle;
    if (requireExistingResource && existingProvider === 'playwright-cdp') {
      throw new AssistantPluginError(
        'PLUGIN_BROWSER_SESSION_STATE_LOST',
        'Saved CDP browser page is no longer attachable; refusing to fall back to another browser or create a replacement page.',
        { retryable: false, details: { sessionId: target.sessionId, provider: existingProvider } },
      );
    }
    if (requireExistingResource && existingProvider === 'playwright-persistent-context') {
      if (!runtimeHooks.moduleAvailable('playwright', repoRoot)) {
        throw new AssistantPluginError('PLUGIN_BROWSER_DEPENDENCY_UNAVAILABLE', 'Managed browser mode requires Playwright.', { retryable: false });
      }
      return openManagedContext(runtimeHooks.loadPlaywright(repoRoot), repoRoot, config, target, args, 'managed_persistent', requestedMode, {
        policy: config.cdpAttachFallback ?? 'managed_persistent',
        from: 'attach_preferred',
        to: 'managed_persistent',
        reason: 'Reusing the existing managed fallback session without probing or creating a different browser resource.',
        attempts: attached.attempts,
      });
    }

    const native = await openNativeAttachedContext(repoRoot, config, target, args);
    if (native.handle) return native.handle;
    if (requireExistingResource) {
      throw new AssistantPluginError(
        'PLUGIN_BROWSER_SESSION_STATE_LOST',
        'Saved browser resource is no longer attachable; refusing to create a replacement tab/page for this existing-session action.',
        { retryable: false, details: { sessionId: target.sessionId, provider: existingProvider } },
      );
    }

    const fallbackPolicy = config.cdpAttachFallback ?? 'managed_persistent';
    const cdpReason = attached.attempts.map((attempt) => `${attempt.endpoint}: ${attempt.error ?? 'unavailable'}`).join('; ')
      || 'No CDP endpoint candidates were configured.';
    const nativeReason = native.attempts.map((attempt) => `${attempt.appName}: ${attempt.error ?? attempt.status}`).join('; ')
      || (config.nativeAttachMode === 'disabled' ? 'Native browser attach is disabled.' : 'No scriptable macOS browser was available.');
    const reason = `CDP: ${cdpReason} Native: ${nativeReason}`;
    if (fallbackPolicy === 'fail_closed') {
      throw new AssistantPluginError('PLUGIN_BROWSER_ATTACH_UNAVAILABLE', `No configured browser attach provider was available. Fallback policy fail_closed prevented managed launch. ${reason}`, {
        retryable: true,
        details: {
          browserMode: requestedMode,
          fallbackPolicy,
          attempts: attached.attempts,
          nativeAttempts: native.attempts,
        },
      });
    }
    if (!runtimeHooks.moduleAvailable('playwright', repoRoot)) {
      throw new AssistantPluginError('PLUGIN_BROWSER_DEPENDENCY_UNAVAILABLE', `Managed browser fallback requires Playwright, but native/CDP attach was unavailable. ${reason}`, { retryable: false });
    }
    return openManagedContext(runtimeHooks.loadPlaywright(repoRoot), repoRoot, config, target, args, 'managed_persistent', requestedMode, {
      policy: fallbackPolicy,
      from: 'attach_preferred',
      to: 'managed_persistent',
      reason,
      attempts: attached.attempts,
      nativeAttempts: native.attempts,
    });
  }

  if (!runtimeHooks.moduleAvailable('playwright', repoRoot)) {
    throw new AssistantPluginError('PLUGIN_BROWSER_DEPENDENCY_UNAVAILABLE', 'Managed browser mode requires Playwright.', { retryable: false });
  }
  return openManagedContext(runtimeHooks.loadPlaywright(repoRoot), repoRoot, config, target, args, requestedMode, requestedMode);
}

async function withPage<T>(
  repoRoot: string,
  config: BrowserPluginConfig,
  target: BrowserActionTarget,
  args: Record<string, unknown>,
  run: (page: PageLike, diagnostics: PageDiagnostics, connection: BrowserConnectionSummary) => Promise<T>,
  options: { persistSession?: boolean; requireExistingResource?: boolean; pruneStaleSessionMetadata?: boolean } = {},
): Promise<T> {
  const retries = Math.min(Math.max(positiveNumber(args.retries, 1), 1), 3);
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    let handle: BrowserOpenHandle | undefined;
    try {
      if (target.existingSession) assertBrowserSessionAvailable(repoRoot, target.sessionId);
      const requireExistingResource = options.requireExistingResource ?? Boolean(target.existingSession);
      const browserArgs = requireExistingResource
        ? { ...args, __forge_require_existing_resource: true }
        : args;
      handle = await openBrowser(repoRoot, config, target, browserArgs);
      const result = await run(handle.page, handle.diagnostics, handle.connection);
      if (options.persistSession) {
        const identity = await readPageIdentity(handle.page, handle.connection);
        saveSession(repoRoot, sessionFromPage(target, identity.url, identity.title, handle.connection));
      }
      return result;
    } catch (error) {
      lastError = error;
      if (options.pruneStaleSessionMetadata
        && target.existingSession
        && error instanceof AssistantPluginError
        && error.code === 'PLUGIN_BROWSER_SESSION_STATE_LOST') {
        rmSync(sessionPath(repoRoot, target.sessionId), { force: true });
      }
      const message = error instanceof Error ? error.message : String(error);
      const transient = /timeout|net::|ERR_|Navigation failed|Target closed|Protocol error/i.test(message);
      if (!transient || attempt >= retries) throw error;
    } finally {
      if (handle) await handle.close();
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function listSavedSessions(repoRoot: string): BrowserSessionState[] {
  return listSavedBrowserSessions(repoRoot)
    .filter((entry) => Boolean(entry.sessionId && entry.url))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function isDiscardableNativeOwnedTabUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return isBlankPage(normalized)
    || normalized === 'chrome://new-tab-page/'
    || normalized === 'vivaldi://newtab/'
    || normalized === 'vivaldi://startpage/';
}

type NativeOwnedSessionInspection = {
  items: Map<string, BrowserSessionInventoryItem>;
  liveCount: number;
  deadCount: number;
  unverifiedCount: number;
  prunedCount: number;
  closedInvalidCount: number;
  failedCleanupCount: number;
};

async function inspectNativeOwnedSessions(
  repoRoot: string,
  config: BrowserPluginConfig,
  saved: BrowserSessionState[],
  options: { pruneDead?: boolean } = {},
): Promise<NativeOwnedSessionInspection> {
  const items = new Map<string, BrowserSessionInventoryItem>();
  const inventories = new Map<MacOsBrowserProduct, Awaited<ReturnType<typeof listMacOsBrowserTabs>> | Error>();
  const groups = new Map<string, BrowserSessionState[]>();
  let liveCount = 0;
  let deadCount = 0;
  let unverifiedCount = 0;
  let prunedCount = 0;
  let closedInvalidCount = 0;
  let failedCleanupCount = 0;
  const timeout = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (const session of saved) {
    const browser = session.browser;
    const tab = browser?.tab;
    const product = browser?.browserProduct;
    if (browser?.provider !== 'macos-apple-events' || tab?.ownership !== 'plugin_owned' || !product || !tab.windowId || !tab.tabId) continue;
    const key = `${product}:${tab.windowId}:${tab.tabId}`;
    const group = groups.get(key) ?? [];
    group.push(session);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const canonical = group.reduce((latest, session) => session.updatedAt > latest.updatedAt ? session : latest);
    const browser = canonical.browser!;
    const tab = browser.tab!;
    const product = browser.browserProduct!;
    let inventory = inventories.get(product);
    if (!inventory) {
      try {
        inventory = await listMacOsBrowserTabs(product, timeout);
      } catch (error) {
        inventory = error instanceof Error ? error : new Error(String(error));
      }
      inventories.set(product, inventory);
    }
    if (inventory instanceof Error) {
      for (const session of group) items.set(session.sessionId, { session, liveness: 'unverified', evidence: 'native_inventory_unavailable', cleanupError: inventory.message });
      unverifiedCount += group.length;
      continue;
    }

    const live = inventory.tabs.find((entry) => entry.windowId === tab.windowId && entry.tabId === tab.tabId);
    if (!live) {
      const pruned = options.pruneDead === true;
      if (pruned) {
        for (const session of group) rmSync(sessionPath(repoRoot, session.sessionId), { force: true });
        prunedCount += group.length;
      }
      for (const session of group) items.set(session.sessionId, { session, liveness: 'dead', evidence: 'native_tab_missing', pruned });
      deadCount += group.length;
      continue;
    }

    if (isDiscardableNativeOwnedTabUrl(live.url)) {
      deadCount += group.length;
      if (options.pruneDead === true) {
        try {
          await closeMacOsBrowserOwnedTab(product, { windowId: tab.windowId!, tabId: tab.tabId! }, timeout);
          for (const session of group) rmSync(sessionPath(repoRoot, session.sessionId), { force: true });
          prunedCount += group.length;
          closedInvalidCount += 1;
          for (const session of group) items.set(session.sessionId, { session, liveness: 'dead', evidence: 'native_tab_invalid_closed', pruned: true });
        } catch (error) {
          failedCleanupCount += 1;
          const cleanupError = error instanceof Error ? error.message : String(error);
          for (const session of group) items.set(session.sessionId, { session, liveness: 'dead', evidence: 'native_tab_invalid_close_failed', cleanupError });
        }
      } else {
        for (const session of group) items.set(session.sessionId, { session, liveness: 'dead', evidence: 'native_tab_invalid' });
      }
      continue;
    }

    for (const session of group) items.set(session.sessionId, { session, liveness: 'live', evidence: 'native_tab_live' });
    liveCount += group.length;
  }

  return { items, liveCount, deadCount, unverifiedCount, prunedCount, closedInvalidCount, failedCleanupCount };
}

async function closeTrackedNativeOwnedSession(
  session: BrowserSessionState,
  config: BrowserPluginConfig,
): Promise<{ resourceClosed: boolean; resourceAlreadyMissing: boolean }> {
  const browser = session.browser;
  const tab = browser?.tab;
  if (browser?.provider !== 'macos-apple-events' || tab?.ownership !== 'plugin_owned') {
    return { resourceClosed: false, resourceAlreadyMissing: false };
  }
  if (!browser.browserProduct || !tab.windowId || !tab.tabId) {
    throw new AssistantPluginError('PLUGIN_BROWSER_NATIVE_OWNERSHIP_MISSING', 'Tracked plugin-owned native tab is missing stable browser identity; retaining session metadata instead of orphaning the tab.', {
      retryable: false, details: { sessionId: session.sessionId, browserProduct: browser.browserProduct, windowId: tab.windowId, tabId: tab.tabId },
    });
  }
  const timeout = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const inventory = await listMacOsBrowserTabs(browser.browserProduct, timeout);
  const live = inventory.tabs.some((entry) => entry.windowId === tab.windowId && entry.tabId === tab.tabId);
  if (!live) return { resourceClosed: false, resourceAlreadyMissing: true };
  await closeMacOsBrowserOwnedTab(browser.browserProduct, { windowId: tab.windowId, tabId: tab.tabId }, timeout);
  return { resourceClosed: true, resourceAlreadyMissing: false };
}

function nativeOwnedAliasSessionIds(repoRoot: string, session: BrowserSessionState): string[] {
  const browser = session.browser;
  const tab = browser?.tab;
  if (browser?.provider !== 'macos-apple-events' || tab?.ownership !== 'plugin_owned' || !browser.browserProduct || !tab.windowId || !tab.tabId) {
    return [session.sessionId];
  }
  return listSavedSessions(repoRoot)
    .filter((candidate) => candidate.browser?.provider === 'macos-apple-events'
      && candidate.browser.browserProduct === browser.browserProduct
      && candidate.browser.tab?.ownership === 'plugin_owned'
      && candidate.browser.tab.windowId === tab.windowId
      && candidate.browser.tab.tabId === tab.tabId)
    .map((candidate) => candidate.sessionId);
}

async function inspectSavedSessions(
  repoRoot: string,
  config: BrowserPluginConfig,
  options: { pruneDead?: boolean } = {},
): Promise<BrowserSessionInventory> {
  const saved = listSavedSessions(repoRoot);
  const sessions: BrowserSessionInventoryItem[] = [];
  let liveManagedSessionCount = 0;
  let unverifiedSessionCount = 0;
  let deadManagedSessionCount = 0;
  let prunedSessionCount = 0;
  const native = await inspectNativeOwnedSessions(repoRoot, config, saved, options);
  let liveNativeSessionCount = native.liveCount;
  let deadNativeSessionCount = native.deadCount;
  let closedInvalidNativeSessionCount = native.closedInvalidCount;
  let failedNativeCleanupCount = native.failedCleanupCount;
  prunedSessionCount += native.prunedCount;
  unverifiedSessionCount += native.unverifiedCount;

  for (const session of saved) {
    const nativeItem = native.items.get(session.sessionId);
    if (nativeItem) {
      sessions.push(nativeItem);
      continue;
    }
    if (session.browser?.provider !== 'playwright-persistent-context' || session.browser.activeMode !== 'managed_persistent') {
      sessions.push({ session, liveness: 'unverified', evidence: 'provider_unverified' });
      unverifiedSessionCount += 1;
      continue;
    }

    const profile = selectedProfile(config, repoRoot, 'managed_persistent', session.sessionId);
    const pending = managedBrowserContexts.get(managedContextKey(profile));
    if (!pending) {
      sessions.push({ session, liveness: 'unverified', evidence: 'runtime_context_unavailable' });
      unverifiedSessionCount += 1;
      continue;
    }

    let state: ManagedBrowserContextState;
    try {
      state = await pending;
    } catch {
      sessions.push({ session, liveness: 'unverified', evidence: 'runtime_context_unavailable' });
      unverifiedSessionCount += 1;
      continue;
    }

    const pages = state.context.pages();
    const boundPage = state.pagesBySession.get(session.sessionId);
    if (boundPage) {
      if (pages.includes(boundPage)) {
        sessions.push({ session, liveness: 'live', evidence: 'runtime_session_binding' });
        liveManagedSessionCount += 1;
        continue;
      }

      const pruned = options.pruneDead === true;
      if (pruned) {
        state.pagesBySession.delete(session.sessionId);
        rmSync(sessionPath(repoRoot, session.sessionId), { force: true });
        prunedSessionCount += 1;
      }
      sessions.push({ session, liveness: 'dead', evidence: 'runtime_bound_page_missing', pruned });
      deadManagedSessionCount += 1;
      continue;
    }

    const expectedOwnerToken = session.browser.tab?.ownership === 'plugin_owned' ? session.browser.tab.ownerToken : undefined;
    if (expectedOwnerToken) {
      const inventory = await inventoryTabs(state.context).catch(() => [] as BrowserTabInventoryEntry[]);
      const index = inventory.findIndex((entry) => entry.ownerToken === expectedOwnerToken);
      const page = index >= 0 ? state.context.pages()[index] : undefined;
      if (page) {
        state.pagesBySession.set(session.sessionId, page);
        sessions.push({ session, liveness: 'live', evidence: 'runtime_owner_token' });
        liveManagedSessionCount += 1;
        continue;
      }
      sessions.push({ session, liveness: 'unverified', evidence: 'runtime_owner_token_not_observed' });
      unverifiedSessionCount += 1;
      continue;
    }

    sessions.push({ session, liveness: 'unverified', evidence: 'provider_unverified' });
    unverifiedSessionCount += 1;
  }

  return {
    sessions,
    scannedSessionCount: saved.length,
    savedSessionCount: saved.length - prunedSessionCount,
    liveManagedSessionCount,
    liveNativeSessionCount,
    unverifiedSessionCount,
    deadManagedSessionCount,
    deadNativeSessionCount,
    closedInvalidNativeSessionCount,
    failedNativeCleanupCount,
    prunedSessionCount,
  };
}

const STABLE_SELECTOR_HELPERS = `
    const forgeUnique = (selector) => {
      try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
    };
    const forgeAttributeSelector = (el, attribute) => {
      const value = el.getAttribute(attribute);
      if (!value) return '';
      const tag = el.tagName.toLowerCase();
      const attr = '[' + attribute + '=' + JSON.stringify(value) + ']';
      if (forgeUnique(attr)) return attr;
      const tagged = tag + attr;
      return forgeUnique(tagged) ? tagged : '';
    };
    const forgeDirectSelector = (el) => {
      for (const attribute of ['data-testid', 'data-test', 'data-qa', 'data-thread-id', 'data-legacy-thread-id', 'data-legacy-message-id']) {
        const candidate = forgeAttributeSelector(el, attribute);
        if (candidate) return candidate;
      }
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role');
      const ariaLabel = el.getAttribute('aria-label');
      if (role && ariaLabel) {
        const candidate = tag + '[role=' + JSON.stringify(role) + '][aria-label=' + JSON.stringify(ariaLabel) + ']';
        if (forgeUnique(candidate)) return candidate;
      }
      const name = forgeAttributeSelector(el, 'name');
      if (name) return name;
      if (el.id && !/^:/.test(el.id) && !/^elptr_/.test(el.id)) {
        const candidate = '#' + CSS.escape(el.id);
        if (forgeUnique(candidate)) return candidate;
      }
      if (ariaLabel) {
        const candidate = tag + '[aria-label=' + JSON.stringify(ariaLabel) + ']';
        if (forgeUnique(candidate)) return candidate;
      }
      return '';
    };
    const forgeDescendantSelector = (el) => {
      const descendants = Array.from(el.querySelectorAll('[data-testid],[data-test],[data-qa],[data-thread-id],[data-legacy-thread-id],[data-legacy-message-id]')).slice(0, 12);
      for (const descendant of descendants) {
        const inner = forgeDirectSelector(descendant);
        if (!inner) continue;
        const role = el.getAttribute('role');
        const base = el.tagName.toLowerCase() + (role ? '[role=' + JSON.stringify(role) + ']' : '');
        const candidate = base + ':has(' + inner + ')';
        if (forgeUnique(candidate)) return candidate;
      }
      return '';
    };
    const forgeStructuralSelector = (el) => {
      let current = el;
      const tail = [];
      for (let depth = 0; current && current.nodeType === 1 && depth < 8; depth += 1) {
        const direct = forgeDirectSelector(current);
        if (direct) {
          const candidate = tail.length ? direct + ' > ' + tail.join(' > ') : direct;
          if (forgeUnique(candidate)) return candidate;
        }
        const tag = current.tagName.toLowerCase();
        let siblingIndex = 1;
        let sibling = current.previousElementSibling;
        while (sibling) {
          if (sibling.tagName === current.tagName) siblingIndex += 1;
          sibling = sibling.previousElementSibling;
        }
        tail.unshift(tag + ':nth-of-type(' + siblingIndex + ')');
        const candidate = tail.join(' > ');
        if (forgeUnique(candidate)) return candidate;
        current = current.parentElement;
      }
      return tail.join(' > ');
    };
    const forgeSelectorHint = (el) => forgeDirectSelector(el) || forgeDescendantSelector(el) || forgeStructuralSelector(el);
`;

const EXTRACTION_SCRIPTS = {
  query: (selector: string, limit: number) => `(() => {
    ${STABLE_SELECTOR_HELPERS}
    const nodes = ${openShadowSelectorExpression(selector, true)}.slice(0, ${limit});
    return nodes.map((el) => {
      const role = el.getAttribute('role');
      const text = (el.innerText || el.textContent || '').trim().slice(0, 120);
      return { tag: el.tagName.toLowerCase(), text, href: el.getAttribute('href'), name: el.getAttribute('name'), id: el.id || undefined, role, selectorHint: forgeSelectorHint(el) };
    });
  })()`,
  attribute: (selector: string, attribute: string) => `(() => {
    const el = ${openShadowSelectorExpression(selector)};
    return el ? el.getAttribute(${JSON.stringify(attribute)}) : null;
  })()`,
  html: (selector?: string) => selector
    ? `(() => { const el = ${openShadowSelectorExpression(selector)}; return el ? el.outerHTML : ''; })()`
    : 'document.documentElement ? document.documentElement.outerHTML : ""',
  links: (limit: number) => `(() => {
    ${STABLE_SELECTOR_HELPERS}
    return Array.from(document.querySelectorAll('a[href]')).slice(0, ${limit}).map((a) => ({
      href: a.href, text: (a.innerText || a.textContent || '').trim().slice(0, 120), selectorHint: forgeSelectorHint(a)
    }));
  })()`,
  tables: (limit: number) => `(() => Array.from(document.querySelectorAll('table')).slice(0, ${limit}).map((table, tableIndex) => ({
    index: tableIndex,
    headers: Array.from(table.querySelectorAll('th')).map((th) => (th.innerText || '').trim().slice(0, 80)),
    rows: Array.from(table.querySelectorAll('tr')).slice(0, 50).map((tr) => Array.from(tr.querySelectorAll('td,th')).map((cell) => (cell.innerText || '').trim().slice(0, 80)))
  })))()`,
  forms: (limit: number) => `(() => {
    ${STABLE_SELECTOR_HELPERS}
    return Array.from(document.querySelectorAll('form')).slice(0, ${limit}).map((form, index) => ({
      index,
      action: form.getAttribute('action') || '',
      method: (form.getAttribute('method') || 'get').toLowerCase(),
      fields: Array.from(form.querySelectorAll('input,select,textarea,button')).slice(0, 40).map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || undefined,
        name: el.getAttribute('name') || undefined,
        id: el.id || undefined,
        selectorHint: forgeSelectorHint(el)
      }))
    }));
  })()`,
  interactive: (limit: number) => `(() => {
    ${STABLE_SELECTOR_HELPERS}
    const viewport = {
      width: Number(window.innerWidth || document.documentElement?.clientWidth || 0),
      height: Number(window.innerHeight || document.documentElement?.clientHeight || 0),
      scrollX: Number(window.scrollX || window.pageXOffset || 0),
      scrollY: Number(window.scrollY || window.pageYOffset || 0),
      devicePixelRatio: Number(window.devicePixelRatio || 1),
    };
    const elements = Array.from(document.querySelectorAll('a,button,input,select,textarea,[contenteditable="true"],[role="button"],[role="link"],[role="textbox"]')).slice(0, ${limit}).map((el) => {
      const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('value') || el.textContent || '').trim().slice(0, 100);
      const rect = el.getBoundingClientRect();
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : undefined;
      const width = Number(rect.width || 0);
      const height = Number(rect.height || 0);
      const left = Number(rect.left || 0);
      const top = Number(rect.top || 0);
      const right = Number(rect.right || (left + width));
      const bottom = Number(rect.bottom || (top + height));
      const visible = width > 0 && height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden' && Number(style?.opacity ?? 1) !== 0;
      const inViewport = visible && right > 0 && bottom > 0 && left < viewport.width && top < viewport.height;
      const disabled = Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true');
      const editable = !disabled && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || el.getAttribute('role') === 'textbox');
      return {
        tag: el.tagName.toLowerCase(),
        text,
        type: el.getAttribute('type') || undefined,
        href: el.getAttribute('href') || undefined,
        role: el.getAttribute('role') || undefined,
        ariaLabel: el.getAttribute('aria-label') || undefined,
        selectorHint: forgeSelectorHint(el),
        bounds: { x: left, y: top, width, height, right, bottom },
        center: { x: left + width / 2, y: top + height / 2 },
        visible,
        inViewport,
        disabled,
        editable,
      };
    });
    return { geometryVersion: 1, viewport, elements };
  })()`,
};

function selectorRepairHint(selector: string, errorMessage: string): string {
  if (/strict mode violation|resolved to \d+ elements/i.test(errorMessage)) {
    return `Selector "${selector}" matched multiple elements. Prefer a unique #id, [data-testid], or more specific path.`;
  }
  if (/Timeout|waiting for selector|not found/i.test(errorMessage)) {
    return `Selector "${selector}" was not found in time. Use snapshot_interactive or query_all to discover stable selectors, then retry.`;
  }
  return `Check selector "${selector}" against the current page structure.`;
}

type BrowserEvaluationScope = Pick<PageLike, 'evaluate'>;

type BrowserFrameSelection = {
  scope: BrowserEvaluationScope;
  frame?: { url: string; name: string };
  frameHandle?: FrameLike;
};

function requestedFrameSelection(args: Record<string, unknown>): { frameUrl?: string; frameName?: string } {
  return { frameUrl: stringValue(args.frame_url), frameName: stringValue(args.frame_name) };
}

function resolveBrowserEvaluationScope(
  page: PageLike,
  args: Record<string, unknown>,
  connection: BrowserConnectionSummary,
): BrowserFrameSelection {
  const { frameUrl, frameName } = requestedFrameSelection(args);
  if (!frameUrl && !frameName) return { scope: page };
  if (connection.provider === 'macos-apple-events' || !page.frames) {
    throw new AssistantPluginError(
      'PLUGIN_BROWSER_FRAME_SCOPE_UNAVAILABLE',
      'Explicit frame targeting requires a Playwright/CDP-controlled page; native Apple Events sessions fail closed.',
      { retryable: false, details: { provider: connection.provider, frameUrl, frameName } },
    );
  }
  const matches = page.frames().filter((frame) => (!frameUrl || frame.url() === frameUrl) && (!frameName || frame.name() === frameName));
  if (matches.length === 0) {
    throw new AssistantPluginError('PLUGIN_BROWSER_FRAME_NOT_FOUND', 'No browser frame matched the requested exact frame identity.', {
      retryable: true,
      details: { frameUrl, frameName },
    });
  }
  if (matches.length > 1) {
    throw new AssistantPluginError('PLUGIN_BROWSER_FRAME_AMBIGUOUS', 'Multiple browser frames matched the requested frame identity; specify both frame_url and frame_name.', {
      retryable: false,
      details: { frameUrl, frameName, matchCount: matches.length },
    });
  }
  const frame = matches[0]!;
  return { scope: frame, frame: { url: frame.url(), name: frame.name() }, frameHandle: frame };
}

const VIEWPORT_METRICS_SCRIPT = `(() => ({
  viewportMetricsVersion: 1,
  viewport: {
    width: Number(window.innerWidth || document.documentElement?.clientWidth || 0),
    height: Number(window.innerHeight || document.documentElement?.clientHeight || 0),
    scrollX: Number(window.scrollX || window.pageXOffset || 0),
    scrollY: Number(window.scrollY || window.pageYOffset || 0),
    devicePixelRatio: Number(window.devicePixelRatio || 1),
  }
}))()`;

async function resolveFrameViewportOffset(page: PageLike, selection: BrowserFrameSelection): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
  const frame = selection.frameHandle;
  if (!frame) return undefined;
  if (page.mainFrame && page.mainFrame() === frame) return { x: 0, y: 0, width: 0, height: 0 };
  if (!frame.frameElement) {
    throw new AssistantPluginError('PLUGIN_BROWSER_FRAME_GEOMETRY_UNAVAILABLE', 'The selected Playwright frame does not expose a frame element for coordinate grounding.', {
      retryable: false,
      details: selection.frame,
    });
  }
  let box: { x: number; y: number; width: number; height: number } | null;
  try {
    box = await (await frame.frameElement()).boundingBox();
  } catch (error) {
    throw new AssistantPluginError('PLUGIN_BROWSER_FRAME_GEOMETRY_UNAVAILABLE', 'Could not resolve the selected frame element bounding box.', {
      retryable: true,
      details: { ...selection.frame, cause: error instanceof Error ? error.message : String(error) },
    });
  }
  if (!box || ![box.x, box.y, box.width, box.height].every((value) => Number.isFinite(value))) {
    throw new AssistantPluginError('PLUGIN_BROWSER_FRAME_GEOMETRY_UNAVAILABLE', 'The selected frame element has no stable visible bounding box; refusing to guess trusted-input coordinates.', {
      retryable: true,
      details: selection.frame,
    });
  }
  return box;
}

function translateFrameGroundingElements(elements: unknown[], offset: { x: number; y: number }, viewport: unknown): unknown[] {
  const viewportRecord = viewport && typeof viewport === 'object' && !Array.isArray(viewport)
    ? viewport as Record<string, unknown>
    : {};
  const viewportWidth = typeof viewportRecord.width === 'number' && Number.isFinite(viewportRecord.width) ? viewportRecord.width : undefined;
  const viewportHeight = typeof viewportRecord.height === 'number' && Number.isFinite(viewportRecord.height) ? viewportRecord.height : undefined;
  if (viewportWidth === undefined || viewportHeight === undefined) {
    throw new AssistantPluginError('PLUGIN_BROWSER_FRAME_GEOMETRY_UNAVAILABLE', 'Top-level viewport dimensions are not finite for frame grounding.', { retryable: true });
  }
  return elements.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const record = entry as Record<string, unknown>;
    const bounds = record.bounds && typeof record.bounds === 'object' && !Array.isArray(record.bounds)
      ? record.bounds as Record<string, unknown>
      : {};
    const center = record.center && typeof record.center === 'object' && !Array.isArray(record.center)
      ? record.center as Record<string, unknown>
      : {};
    const required = (value: unknown, field: string): number => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new AssistantPluginError('PLUGIN_BROWSER_FRAME_GEOMETRY_UNAVAILABLE', `Frame grounding field ${field} is not finite.`, { retryable: true });
      }
      return value;
    };
    const x = required(bounds.x, 'bounds.x');
    const y = required(bounds.y, 'bounds.y');
    const width = required(bounds.width, 'bounds.width');
    const height = required(bounds.height, 'bounds.height');
    const right = required(bounds.right, 'bounds.right');
    const bottom = required(bounds.bottom, 'bounds.bottom');
    const centerX = required(center.x, 'center.x');
    const centerY = required(center.y, 'center.y');
    const translatedX = x + offset.x;
    const translatedY = y + offset.y;
    const translatedRight = right + offset.x;
    const translatedBottom = bottom + offset.y;
    const frameLocalInViewport = record.inViewport === true;
    const topLevelInViewport = translatedRight > 0
      && translatedBottom > 0
      && translatedX < viewportWidth
      && translatedY < viewportHeight;
    return {
      ...record,
      bounds: {
        x: translatedX,
        y: translatedY,
        width,
        height,
        right: translatedRight,
        bottom: translatedBottom,
      },
      center: { x: centerX + offset.x, y: centerY + offset.y },
      frameLocalInViewport,
      topLevelInViewport,
      inViewport: frameLocalInViewport && topLevelInViewport,
    };
  });
}

async function extractText(scope: BrowserEvaluationScope, selector: string | undefined, maxChars: number): Promise<Record<string, unknown>> {
  const raw = await scope.evaluate<string>(scriptText(selector));
  return truncateText(raw, maxChars);
}

function trustedInputGuardScript(selector: string): string {
  const encodedSelector = JSON.stringify(selector);
  return `(() => {
    let element;
    try { element = document.querySelector(${encodedSelector}); }
    catch (error) { return { trustedInputGuardVersion: 1, found: false, selectorError: String(error) }; }
    if (!element) return { trustedInputGuardVersion: 1, found: false };
    const rect = element.getBoundingClientRect();
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : undefined;
    const visible = Number(rect.width || 0) > 0
      && Number(rect.height || 0) > 0
      && style?.display !== 'none'
      && style?.visibility !== 'hidden'
      && Number(style?.opacity ?? 1) !== 0;
    return {
      trustedInputGuardVersion: 1,
      found: true,
      visible,
      bounds: {
        x: Number(rect.left || 0), y: Number(rect.top || 0),
        width: Number(rect.width || 0), height: Number(rect.height || 0),
        right: Number(rect.right || 0), bottom: Number(rect.bottom || 0),
      },
    };
  })()`;
}

function verifyStateObservationScript(selector: string | undefined, textContains: string | undefined, maxChars: number): string {
  const payload = JSON.stringify({ selector: selector ?? null, textContains: textContains ?? null, maxChars });
  return `(() => {
    const args = ${payload};
    const element = args.selector ? document.querySelector(args.selector) : null;
    const textTarget = element || document.body || document.documentElement;
    const rawText = String(textTarget?.innerText || textTarget?.textContent || '');
    let visible;
    if (args.selector) {
      if (!element) visible = false;
      else {
        const rect = element.getBoundingClientRect();
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : undefined;
        visible = Number(rect.width || 0) > 0
          && Number(rect.height || 0) > 0
          && style?.display !== 'none'
          && style?.visibility !== 'hidden'
          && Number(style?.opacity ?? 1) !== 0;
      }
    }
    return {
      verificationVersion: 1,
      selectorExists: args.selector ? Boolean(element) : undefined,
      visible,
      textContains: args.textContains === null ? undefined : rawText.includes(args.textContains),
      textSample: rawText.slice(0, args.maxChars),
      textLength: rawText.length,
      truncated: rawText.length > args.maxChars,
    };
  })()`;
}

async function readPageIdentity(page: PageLike, connection?: BrowserConnectionSummary): Promise<{ url: string; title: string }> {
  if (connection?.provider === 'macos-apple-events' && typeof page.identity === 'function') {
    const identity = await page.identity();
    return { url: normalizedUrl(identity.url), title: identity.title };
  }
  return { url: normalizedUrl(page.url()), title: await page.title() };
}

async function finalizeInteractiveAction(
  repoRoot: string,
  config: BrowserPluginConfig,
  page: PageLike,
  target: BrowserActionTarget,
  connection: BrowserConnectionSummary,
  actionId: string,
  summary: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const warnings: string[] = [];
  const identity = await readPageIdentity(page, connection);
  const title = identity.title;
  const pageUrl = identity.url;
  const session = sessionFromPage(target, pageUrl, title, connection);
  saveSession(repoRoot, session);
  let screenshot: BrowserActionScreenshot | undefined;
  const silentNativeEvidence = connection.provider === 'macos-apple-events' && connection.tab?.ownership === 'plugin_owned';
  if (!silentNativeEvidence) {
    try {
      screenshot = await captureActionScreenshot(page, repoRoot, actionId, session.sessionId, session.url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Screenshot capture failed: ${message}`);
    }
  }
  return {
    ...interactionResult(actionId, session, summary, screenshot, warnings, extra),
    evidenceMode: silentNativeEvidence ? 'dom' : screenshot ? 'screenshot' : 'summary',
    browserConnection: {
      ...connection,
      tab: session.browser?.tab,
      sessionResume: session.browser?.sessionResume,
    },
  };
}

function permissions(ready: boolean): AssistantPluginPermissionScope[] {
  return [
    {
      scope: 'browser.read',
      mode: 'read',
      description: 'Open pages, extract text, and capture screenshots.',
      granted: ready,
      required: true,
    },
    {
      scope: 'browser.interact',
      mode: 'write',
      description: 'Click, type, press keys, and wait on allowed browser pages after explicit authorization.',
      granted: ready,
      required: true,
    },
    {
      scope: 'browser.profile',
      mode: 'write',
      description: 'Persist the dedicated local browser profile, session metadata, and screenshots.',
      granted: ready,
      required: true,
    },
  ];
}

function capabilities(): AssistantPluginCapability[] {
  return [
    {
      capabilityId: 'browser-session',
      title: 'Browser Sessions',
      description: 'Create, list, reuse, and close persistent browser sessions.',
      scopes: ['browser.read', 'browser.profile'],
      actions: ['create_session', 'list_sessions', 'reconcile_sessions', 'close_session', 'close_page', 'clear_session'],
    },
    {
      capabilityId: 'browser-human-handoff',
      title: 'Browser Human Handoff',
      description: 'Present the persistent browser in the foreground, keep it open for manual verification, and resume safely.',
      scopes: ['browser.read', 'browser.profile'],
      actions: ['request_human_handoff', 'get_handoff_status', 'resolve_handoff'],
    },
    {
      capabilityId: 'browser-readonly',
      title: 'Read-only Browser',
      description: 'Navigate allowed pages, extract DOM/text, capture screenshots, and collect diagnostics.',
      scopes: ['browser.read', 'browser.profile'],
      actions: [
        'open_page', 'navigate', 'reload', 'go_back', 'wait_for_load_state',
        'get_text', 'get_html', 'query_selector', 'query_all', 'get_attribute', 'list_frames', 'verify_state',
        'screenshot', 'extract_links', 'extract_tables', 'extract_forms', 'snapshot_interactive',
        'get_console_errors', 'get_failed_requests',
      ],
    },
    {
      capabilityId: 'browser-interaction',
      title: 'Browser Interaction',
      description: 'Perform explicit form and pointer interactions on HTTP(S) pages through the persistent Playwright profile.',
      scopes: ['browser.interact', 'browser.profile'],
      actions: [
        'activate_page', 'click', 'click_text', 'double_click', 'hover', 'focus', 'type', 'fill', 'select_option',
        'check', 'uncheck', 'press', 'keyboard_shortcut', 'trusted_input', 'dispatch_event', 'wait_for_selector', 'attach_local_file', 'await_file_transfer',
      ],
    },
  ];
}

function sessionTargetSchema(extra: Record<string, unknown> = {}, required: string[] = []): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      session_id: { type: 'string' },
      url: { type: 'string' },
      wait_until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
      timeout_ms: { type: 'number' },
      retries: { type: 'number' },
      browser_mode: { type: 'string', enum: ['attach_preferred', 'managed_persistent', 'isolated'] },
      cdp_attach_fallback: { type: 'string', enum: ['managed_persistent', 'fail_closed'] },
      native_attach_mode: { type: 'string', enum: ['auto', 'disabled'] },
      native_browser_candidates: { type: 'array', items: { type: 'string', enum: ['vivaldi', 'chrome'] }, maxItems: 2 },
      ...extra,
    },
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

const frameScopeProperties = {
  frame_url: { type: 'string' },
  frame_name: { type: 'string' },
};

function interactSchema(extra: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return sessionTargetSchema({
    post_action_wait_ms: { type: 'number' },
    ...extra,
  }, required);
}

function actions(): AssistantPluginActionDescriptor[] {
  const readRemote = [
    { resource: 'remote' as const, mode: 'read' as const },
    { resource: 'repo-state' as const, mode: 'write' as const },
  ];
  const writeRemote = [
    { resource: 'remote' as const, mode: 'exclusive' as const },
    { resource: 'repo-state' as const, mode: 'write' as const },
  ];
  return [
    {
      actionId: 'configure',
      title: 'Configure browser plugin',
      description: 'Enable or update the local browser plugin configuration.',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 30_000,
      cancellable: true,
      idempotent: true,
      scopes: ['browser.profile'],
      resourceClaims: [{ resource: 'repo-state', mode: 'write' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          browser_mode: { type: 'string', enum: ['attach_preferred', 'managed_persistent', 'isolated'] },
          profile_mode: { type: 'string', enum: ['repo_local', 'custom'] },
          profile_dir: { type: 'string' },
          profile_directory: { type: 'string' },
          clear_profile_dir: { type: 'boolean' },
          clear_profile_directory: { type: 'boolean' },
          browser_channel: { type: 'string', enum: ['chromium', 'chrome', 'chrome-beta', 'chrome-dev', 'chrome-canary'] },
          clear_browser_channel: { type: 'boolean' },
          browser_executable_path: { type: 'string' },
          clear_browser_executable_path: { type: 'boolean' },
          cdp_endpoint: { type: 'string' },
          clear_cdp_endpoint: { type: 'boolean' },
          cdp_endpoint_candidates: { type: 'array', items: { type: 'string' }, maxItems: MAX_CDP_ENDPOINT_CANDIDATES },
          clear_cdp_endpoint_candidates: { type: 'boolean' },
          cdp_discovery_timeout_ms: { type: 'number' },
          cdp_attach_fallback: { type: 'string', enum: ['managed_persistent', 'fail_closed'] },
          native_attach_mode: { type: 'string', enum: ['auto', 'disabled'] },
          native_browser_candidates: { type: 'array', items: { type: 'string', enum: ['vivaldi', 'chrome'] }, maxItems: 2 },
          default_timeout_ms: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
    {
      actionId: 'create_session',
      title: 'Create browser session',
      description: 'Open an HTTP(S) URL or explicitly adopt the matching frontmost native tab, then persist a reusable session id.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.read', 'browser.profile'], resourceClaims: [{ resource: 'repo-state', mode: 'write' }, ...readRemote],
      argumentsSchema: sessionTargetSchema({
        extract_text: { type: 'boolean' },
        max_chars: { type: 'number' },
        native_browser_product: { type: 'string', enum: ['chrome', 'vivaldi'] },
        native_window_id: { type: 'string' },
        native_tab_id: { type: 'string' },
        native_active_tab: { type: 'boolean' },
      }, ['url']),
    },
    {
      actionId: 'list_sessions',
      title: 'List browser sessions',
      description: 'List saved browser session metadata without secrets or cookies.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 10_000, cancellable: true, idempotent: true,
      scopes: ['browser.read', 'browser.profile'], resourceClaims: [{ resource: 'repo-state', mode: 'read' }],
      argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: 'reconcile_sessions',
      title: 'Reconcile browser sessions',
      description: 'Prune only saved managed-session metadata whose exact Runtime-bound page is positively proven gone. Never removes profiles, cookies, or unverified native sessions.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 15_000, cancellable: true, idempotent: true,
      scopes: ['browser.read', 'browser.profile'], resourceClaims: [{ resource: 'repo-state', mode: 'write' }],
      argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: 'close_session',
      title: 'Close browser session',
      description: 'Remove one saved session metadata record.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 15_000, cancellable: true, idempotent: true,
      scopes: ['browser.read', 'browser.profile'], resourceClaims: [{ resource: 'repo-state', mode: 'write' }],
      argumentsSchema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'], additionalProperties: false },
    },
    {
      actionId: 'clear_session',
      title: 'Clear all browser sessions',
      description: 'Remove all saved session metadata while keeping the profile.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 15_000, cancellable: true, idempotent: true,
      scopes: ['browser.profile'], resourceClaims: [{ resource: 'repo-state', mode: 'write' }],
      argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: 'request_human_handoff',
      title: 'Request human browser handoff',
      description: 'Keep a saved browser session open for CAPTCHA, login, two-factor authentication, or another manual step.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false,
      scopes: ['browser.read', 'browser.profile'], resourceClaims: readRemote,
      argumentsSchema: sessionTargetSchema({
        reason: { type: 'string', enum: ['captcha', 'login', 'two_factor', 'manual_review', 'sensitive_confirmation'] },
        instructions: { type: 'string' },
        handoff_timeout_ms: { type: 'number' },
      }, ['session_id']),
    },
    {
      actionId: 'get_handoff_status',
      title: 'Get browser handoff status',
      description: 'Read durable browser handoff status and reconcile a stale or crashed host.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 10_000, cancellable: true, idempotent: true,
      scopes: ['browser.read', 'browser.profile'], resourceClaims: [{ resource: 'repo-state', mode: 'read' }],
      argumentsSchema: { type: 'object', properties: { interaction_id: { type: 'string' } }, required: ['interaction_id'], additionalProperties: false },
    },
    {
      actionId: 'resolve_handoff',
      title: 'Resolve browser handoff',
      description: 'Resume or cancel a foreground browser handoff.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 15_000, cancellable: true, idempotent: true,
      scopes: ['browser.read', 'browser.profile'], resourceClaims: [{ resource: 'repo-state', mode: 'write' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          interaction_id: { type: 'string' },
          resolution: { type: 'string', enum: ['resume', 'cancel'] },
        },
        required: ['interaction_id', 'resolution'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'open_page',
      title: 'Open page',
      description: 'Open an HTTP(S) URL with the persistent profile and save a lightweight session.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.read'], resourceClaims: readRemote,
      argumentsSchema: sessionTargetSchema({ extract_text: { type: 'boolean' }, max_chars: { type: 'number' } }, ['url']),
    },
    {
      actionId: 'navigate',
      title: 'Navigate',
      description: 'Navigate an existing session or open a new page to an HTTP(S) URL.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.read', 'browser.interact', 'browser.profile'], resourceClaims: writeRemote,
      argumentsSchema: sessionTargetSchema({}, ['url']),
    },
    {
      actionId: 'reload',
      title: 'Reload page',
      description: 'Reload the current page for a session.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.read', 'browser.interact', 'browser.profile'], resourceClaims: writeRemote,
      argumentsSchema: sessionTargetSchema({}, ['session_id']),
    },
    {
      actionId: 'go_back',
      title: 'Go back',
      description: 'Navigate back in history for a session.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.read', 'browser.interact', 'browser.profile'], resourceClaims: writeRemote,
      argumentsSchema: sessionTargetSchema({}, ['session_id']),
    },
    {
      actionId: 'wait_for_load_state',
      title: 'Wait for load state',
      description: 'Wait for load/domcontentloaded/networkidle on a session page.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['browser.read'], resourceClaims: readRemote,
      argumentsSchema: sessionTargetSchema({ state: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] } }),
    },
    {
      actionId: 'get_text',
      title: 'Get text',
      description: 'Extract text from a URL or saved browser session.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['browser.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: sessionTargetSchema({ selector: { type: 'string' }, max_chars: { type: 'number' }, ...frameScopeProperties }),
    },
    {
      actionId: 'get_html',
      title: 'Get HTML',
      description: 'Extract HTML for the page or a selector (bounded).',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['browser.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: sessionTargetSchema({ selector: { type: 'string' }, max_chars: { type: 'number' }, ...frameScopeProperties }),
    },
    {
      actionId: 'query_selector',
      title: 'Query selector',
      description: 'Return the first matching element summary with a stable selector hint.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['browser.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: sessionTargetSchema({ selector: { type: 'string' }, ...frameScopeProperties }, ['selector']),
    },
    {
      actionId: 'query_all',
      title: 'Query all selectors',
      description: 'Return matching element summaries (bounded).',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['browser.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: sessionTargetSchema({ selector: { type: 'string' }, limit: { type: 'number' }, ...frameScopeProperties }, ['selector']),
    },
    {
      actionId: 'get_attribute',
      title: 'Get attribute',
      description: 'Read one attribute from a selector.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['browser.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: sessionTargetSchema({ selector: { type: 'string' }, attribute: { type: 'string' }, ...frameScopeProperties }, ['selector', 'attribute']),
    },
    {
      actionId: 'list_frames',
      title: 'List page frames',
      description: 'List bounded Playwright/CDP frame identities for explicit frame-scoped DOM observation.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['browser.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: sessionTargetSchema({ limit: { type: 'number', minimum: 1, maximum: 100 } }),
    },
    {
      actionId: 'verify_state',
      title: 'Verify browser state',
      description: 'Observe URL, selector existence/visibility, and bounded text criteria in one read-only call for post-action verification.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['browser.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: sessionTargetSchema({
        expected_url: { type: 'string' },
        url_contains: { type: 'string' },
        selector: { type: 'string' },
        require_visible: { type: 'boolean' },
        text_contains: { type: 'string', maxLength: 10000 },
        max_chars: { type: 'number', minimum: 1, maximum: 100000 },
        ...frameScopeProperties,
      }, ['session_id']),
    },
    {
      actionId: 'screenshot',
      title: 'Screenshot',
      description: 'Capture a page, full-page, or element screenshot under browser artifact storage.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.read'], resourceClaims: readRemote,
      argumentsSchema: sessionTargetSchema({ full_page: { type: 'boolean' }, selector: { type: 'string' } }),
    },
    {
      actionId: 'extract_links',
      title: 'Extract links',
      description: 'Extract anchors with href/text from the page.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['browser.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: sessionTargetSchema({ limit: { type: 'number' } }),
    },
    {
      actionId: 'extract_tables',
      title: 'Extract tables',
      description: 'Extract simple HTML tables as row arrays.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['browser.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: sessionTargetSchema({ limit: { type: 'number' } }),
    },
    {
      actionId: 'extract_forms',
      title: 'Extract forms',
      description: 'Extract form field summaries without values that look like secrets.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['browser.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: sessionTargetSchema({ limit: { type: 'number' } }),
    },
    {
      actionId: 'snapshot_interactive',
      title: 'Snapshot interactive elements',
      description: 'Snapshot interactive elements with stable selector hints plus CSS-pixel viewport geometry for screenshot-to-input grounding.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['browser.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: sessionTargetSchema({ limit: { type: 'number' }, ...frameScopeProperties }),
    },
    {
      actionId: 'get_console_errors',
      title: 'Get console errors',
      description: 'Return captured console error messages for a page open cycle.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['browser.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: sessionTargetSchema({}),
    },
    {
      actionId: 'get_failed_requests',
      title: 'Get failed requests',
      description: 'Return failed network requests captured during a page open cycle.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['browser.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: sessionTargetSchema({}),
    },
    {
      actionId: 'activate_page',
      title: 'Activate browser page',
      description: 'Bring the exact saved browser page/tab to the foreground without opening or replacing a tab.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['browser.interact', 'browser.profile'], resourceClaims: writeRemote,
      argumentsSchema: interactSchema({}, []),
    },
    {
      actionId: 'click',
      title: 'Click element',
      description: 'Click a selector on an allowed page after authorization.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.interact', 'browser.profile'], resourceClaims: writeRemote,
      argumentsSchema: interactSchema({ selector: { type: 'string' } }, ['selector']),
    },
    {
      actionId: 'click_text',
      title: 'Click exact visible text',
      description: 'Click the smallest visible standard DOM element whose normalized text exactly matches the requested text. Closed shadow roots are intentionally not traversed.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.interact', 'browser.profile'], resourceClaims: writeRemote,
      argumentsSchema: interactSchema({ text: { type: 'string', minLength: 1, maxLength: 200 } }, ['text']),
    },
    {
      actionId: 'double_click',
      title: 'Double-click element',
      description: 'Double-click a selector after authorization.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.interact', 'browser.profile'], resourceClaims: writeRemote,
      argumentsSchema: interactSchema({ selector: { type: 'string' } }, ['selector']),
    },
    {
      actionId: 'hover',
      title: 'Hover element',
      description: 'Hover a selector after authorization.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.interact', 'browser.profile'], resourceClaims: writeRemote,
      argumentsSchema: interactSchema({ selector: { type: 'string' } }, ['selector']),
    },
    {
      actionId: 'focus',
      title: 'Focus element',
      description: 'Focus a selector after authorization.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.interact', 'browser.profile'], resourceClaims: writeRemote,
      argumentsSchema: interactSchema({ selector: { type: 'string' } }, ['selector']),
    },
    {
      actionId: 'type',
      title: 'Type into element',
      description: 'Type text into a selector (append-style) after authorization.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.interact', 'browser.profile'], resourceClaims: writeRemote,
      argumentsSchema: interactSchema({ selector: { type: 'string' }, text: { type: 'string' } }, ['selector', 'text']),
    },
    {
      actionId: 'fill',
      title: 'Fill element',
      description: 'Replace the value of a selector after authorization.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.interact', 'browser.profile'], resourceClaims: writeRemote,
      argumentsSchema: interactSchema({ selector: { type: 'string' }, text: { type: 'string' } }, ['selector', 'text']),
    },
    {
      actionId: 'select_option',
      title: 'Select option',
      description: 'Select one or more option values on a <select> after authorization.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.interact', 'browser.profile'], resourceClaims: writeRemote,
      argumentsSchema: interactSchema({ selector: { type: 'string' }, values: { type: 'array', items: { type: 'string' } } }, ['selector', 'values']),
    },
    {
      actionId: 'check',
      title: 'Check checkbox',
      description: 'Check a checkbox/radio after authorization.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.interact', 'browser.profile'], resourceClaims: writeRemote,
      argumentsSchema: interactSchema({ selector: { type: 'string' } }, ['selector']),
    },
    {
      actionId: 'uncheck',
      title: 'Uncheck checkbox',
      description: 'Uncheck a checkbox after authorization.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.interact', 'browser.profile'], resourceClaims: writeRemote,
      argumentsSchema: interactSchema({ selector: { type: 'string' } }, ['selector']),
    },
    {
      actionId: 'press',
      title: 'Press key',
      description: 'Press a key on a selector on an allowed page after authorization.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.interact', 'browser.profile'], resourceClaims: writeRemote,
      argumentsSchema: interactSchema({ selector: { type: 'string' }, key: { type: 'string' } }, ['selector', 'key']),
    },
    {
      actionId: 'keyboard_shortcut',
      title: 'Keyboard shortcut',
      description: 'Press a keyboard shortcut (e.g. Meta+A) after authorization.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.interact', 'browser.profile'], resourceClaims: writeRemote,
      argumentsSchema: interactSchema({ key: { type: 'string' } }, ['key']),
    },
    {
      actionId: 'trusted_input',
      title: 'Trusted background browser input',
      description: 'Send bounded Playwright/CDP mouse, wheel, drag, key, or text input directly to the browser page without OS-level pointer movement. Native-only sessions fail closed.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.interact', 'browser.profile'], resourceClaims: writeRemote,
      argumentsSchema: interactSchema({
        kind: { type: 'string', enum: ['click', 'move', 'wheel', 'drag', 'key', 'text'] },
        x: { type: 'number', minimum: 0, maximum: 100000 },
        y: { type: 'number', minimum: 0, maximum: 100000 },
        from_x: { type: 'number', minimum: 0, maximum: 100000 },
        from_y: { type: 'number', minimum: 0, maximum: 100000 },
        to_x: { type: 'number', minimum: 0, maximum: 100000 },
        to_y: { type: 'number', minimum: 0, maximum: 100000 },
        delta_x: { type: 'number', minimum: -100000, maximum: 100000 },
        delta_y: { type: 'number', minimum: -100000, maximum: 100000 },
        button: { type: 'string', enum: ['left', 'middle', 'right'] },
        click_count: { type: 'number', minimum: 1, maximum: 3 },
        steps: { type: 'number', minimum: 1, maximum: 100 },
        key: { type: 'string', minLength: 1, maxLength: 100 },
        text: { type: 'string', maxLength: 10000 },
        guard_selector: { type: 'string' },
        ...frameScopeProperties,
      }, ['kind']),
    },
    {
      actionId: 'dispatch_event',
      title: 'Dispatch DOM event',
      description: 'Dispatch one named bubbling/composed DOM CustomEvent on an explicit selector after authorization. No arbitrary JavaScript payload is accepted.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.interact', 'browser.profile'], resourceClaims: writeRemote,
      argumentsSchema: interactSchema({ selector: { type: 'string' }, event: { type: 'string', minLength: 1, maxLength: 64 } }, ['selector', 'event']),
    },
    {
      actionId: 'wait_for_selector',
      title: 'Wait for selector',
      description: 'Wait for a selector state on an allowed page after authorization.',
      readOnly: true, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['browser.interact', 'browser.profile'], resourceClaims: readRemote,
      argumentsSchema: sessionTargetSchema({
        selector: { type: 'string' },
        state: { type: 'string', enum: ['attached', 'detached', 'visible', 'hidden'] },
      }, ['selector']),
    },
    {
      actionId: 'attach_local_file',
      title: 'Attach local file(s)',
      description: 'Set one or more allowed local files on input[type=file] after authorization. file_path remains backward-compatible; file_paths supports multiple selection. Never auto-opens executables.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.interact', 'browser.profile'], resourceClaims: writeRemote,
      argumentsSchema: interactSchema({
        selector: { type: 'string' },
        file_path: { type: 'string' },
        file_paths: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string' } },
      }, ['selector']),
    },
    {
      actionId: 'await_file_transfer',
      title: 'Await file transfer',
      description: 'Capture a browser download into bounded artifact storage after authorization. Never auto-opens downloaded files.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 120_000, cancellable: true, idempotent: false,
      scopes: ['browser.interact', 'browser.profile'], resourceClaims: writeRemote,
      argumentsSchema: interactSchema({ selector: { type: 'string' }, suggested_name: { type: 'string' } }, ['selector']),
    },
    {
      actionId: 'close_page',
      title: 'Close session',
      description: 'Remove saved session metadata while keeping the persistent profile.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 15_000, cancellable: true, idempotent: true,
      scopes: ['browser.read', 'browser.profile'], resourceClaims: [{ resource: 'repo-state', mode: 'write' }],
      argumentsSchema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'], additionalProperties: false },
    },
  ];
}

function browserUserFacingStatus(config: BrowserPluginConfig, ready: boolean, sessionCount = 0): string {
  if (!config.enabled) return 'disabled';
  if (!ready) return 'not ready';
  if (sessionCount > 0) return 'session active';
  return 'ready';
}

function health(config: BrowserPluginConfig, repoRoot?: string): AssistantPluginHealth {
  const dependencyReady = runtimeHooks.moduleAvailable('playwright', repoRoot);
  const configErrors = validateConfig(config);
  const warnings = configWarnings(config);
  const savedSessionCount = repoRoot ? listSavedSessions(repoRoot).length : 0;
  const activeHandoffCount = repoRoot
    ? listBrowserHandoffs(repoRoot).filter((entry) => ['starting', 'waiting_for_user', 'closing'].includes(entry.status)).length
    : 0;
  const baseDetails = {
    dependencyReady,
    browserMode: config.browserMode,
    profileMode: config.profileMode,
    profileDir: config.profileDir,
    profileDirectory: config.profileDirectory,
    browserChannel: config.browserChannel,
    executablePath: config.executablePath,
    cdpEndpointCount: cdpEndpoints(config).length,
    cdpAttachFallback: config.cdpAttachFallback,
    cdpDiscoveryTimeoutMs: cdpDiscoveryTimeout(config),
    nativeAttachMode: config.nativeAttachMode,
    nativeBrowserCandidates: config.nativeBrowserCandidates,
    nativeAttachSupported: macOsActiveBrowserAttachSupported(),
    windowMode: 'visible' as const,
    sessionCount: savedSessionCount,
    sessionCountSemantics: 'saved_metadata' as const,
    savedSessionCount,
    activeHandoffCount,
    humanHandoffSupported: true,
    artifactsAvailable: true,
    artifactRoots: {
      screenshots: '.forge/browser/screenshots',
      downloads: '.forge/browser/downloads',
      diagnostics: '.forge/browser/diagnostics',
    },
  };
  if (!config.enabled) {
    return {
      state: 'disabled',
      checkedAt: now(),
      ready: false,
      probed: false,
      errors: [],
      warnings: ['Browser plugin is disabled.'],
      details: { ...baseDetails, userFacingStatus: 'disabled' },
    };
  }
  const nativeAttachConfigured = config.browserMode === 'attach_preferred'
    && config.nativeAttachMode !== 'disabled'
    && macOsActiveBrowserAttachSupported();
  const nativeObservation = nativeAttachConfigured ? getMacOsBrowserAttachObservation() : undefined;
  const cdpRouteReady = config.browserMode === 'attach_preferred'
    && cdpEndpoints(config).length > 0
    && dependencyReady;
  const managedRouteReady = dependencyReady
    && (config.browserMode !== 'attach_preferred' || config.cdpAttachFallback === 'managed_persistent');
  const nativeRouteReady = nativeAttachConfigured && nativeObservation?.ready === true;
  const nativeOnlyRoute = nativeAttachConfigured && !cdpRouteReady && !managedRouteReady;
  const nativeRouteUnverified = nativeOnlyRoute && nativeObservation === undefined;
  const nativeRouteFailed = nativeOnlyRoute && nativeObservation?.ready === false;
  if (nativeRouteUnverified || nativeRouteFailed) {
    const nativeWarnings = nativeRouteFailed
      ? nativeObservation?.attempts.map((attempt) => `${attempt.appName}: ${attempt.error ?? attempt.status}`) ?? []
      : ['Native active-browser attach has not completed a live probe in this Runtime instance.'];
    return {
      state: 'degraded',
      checkedAt: now(),
      ready: false,
      probed: nativeRouteFailed,
      errors: [],
      warnings: [...warnings, ...nativeWarnings],
      details: {
        ...baseDetails,
        nativeAttachObservation: nativeObservation,
        provider: 'macos-active-browser',
        userFacingStatus: 'not ready',
      },
    };
  }
  if (!cdpRouteReady && !managedRouteReady && !nativeRouteReady) {
    return {
      state: 'error',
      checkedAt: now(),
      ready: false,
      probed: true,
      errors: ['Browser plugin requires Playwright for the configured browser mode. Run bun install or configure attach_preferred native attach.'],
      warnings,
      details: { ...baseDetails, install: 'bun install', userFacingStatus: 'not ready' },
    };
  }
  if (configErrors.length > 0) {
    return {
      state: 'error',
      checkedAt: now(),
      ready: false,
      probed: true,
      errors: configErrors,
      warnings,
      details: {
        ...baseDetails,
        provider: config.browserMode === 'attach_preferred'
          ? 'cdp-or-macos-active-browser-or-persistent-context'
          : 'playwright-persistent-context',
        userFacingStatus: 'not ready',
      },
    };
  }
  return {
    state: 'ready',
    checkedAt: now(),
    ready: true,
    probed: true,
    errors: [],
    warnings,
    details: {
      ...baseDetails,
      nativeAttachObservation: nativeObservation,
      provider: config.browserMode === 'attach_preferred'
        ? 'cdp-or-macos-active-browser-or-persistent-context'
        : 'playwright-persistent-context',
      userFacingStatus: browserUserFacingStatus(config, true, savedSessionCount),
    },
  };
}

export function buildBrowserPluginManifest(previousRevision = 0, previousUpdatedAt?: string, repoRoot?: string): AssistantPluginManifest {
  const root = repoRoot ?? process.cwd();
  const config = loadConfig(root);
  const state = health(config, root);
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    revision: Math.max(1, previousRevision || 1),
    pluginId: BROWSER_PLUGIN_ID,
    provider: 'local-browser',
    displayName: 'Controller Browser Plugin',
    pluginVersion: '1.1.0',
    authority: {
      strategy: 'derived',
      duplicateStateAllowed: false,
      sourceOfTruth: ['repo-local:.forge/plugins/browser.json', 'repo-local:.forge/browser/'],
    },
    enabled: config.enabled,
    lifecycle: {
      state: !config.enabled ? 'disabled' : state.state === 'degraded' ? 'degraded' : state.ready ? 'enabled' : 'error',
      reason: !config.enabled
        ? 'Browser plugin is disabled.'
        : state.ready
          ? `Browser plugin is ready via ${config.browserMode === 'attach_preferred' ? 'CDP, macOS active-browser attach, and explicit managed fallback.' : 'Playwright persistent context.'}`
          : state.state === 'degraded'
            ? state.warnings[0] ?? 'Browser plugin requires a successful live native attach probe.'
            : state.errors[0],
    },
    health: state,
    permissions: permissions(state.ready),
    capabilities: capabilities(),
    actions: actions(),
    updatedAt: previousUpdatedAt ?? now(),
  };
}

export async function executeBrowserPluginAction(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  const persisted = loadConfig(input.repoRoot);
  const current = input.actionId === 'configure' ? persisted : effectiveBrowserActionConfig(persisted, input.args);
  if (!current.enabled && input.actionId !== 'configure') {
    throw new AssistantPluginError('PLUGIN_DISABLED', 'Browser plugin is disabled.', { retryable: false });
  }
  if (input.actionId !== 'configure') {
    const configErrors = validateConfig(current);
    if (configErrors.length > 0) {
      throw new AssistantPluginError('PLUGIN_CONFIGURATION_INVALID', configErrors[0], { retryable: false });
    }
  }
  if (shouldUseBrowserNodeBridge(input.actionId, current.browserMode, runtimeHooksCustomized, cdpEndpoints(current).length > 0)) {
    return await executeBrowserActionThroughNode(input);
  }
  try {
    switch (input.actionId) {
      case 'configure': {
        const args = input.args;
        const nextBrowserMode = parseBrowserModeInput(args.browser_mode) ?? current.browserMode;
        const nextProfileMode = parseProfileModeInput(args.profile_mode) ?? current.profileMode;
        if (stringValue(args.profile_dir) && args.profile_mode === undefined && current.profileMode !== 'custom') {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'profile_mode must be set to custom before profile_dir can be used.', { retryable: false });
        }
        const nextProfileDir = args.clear_profile_dir === true ? undefined : stringValue(args.profile_dir) ?? current.profileDir;
        const nextProfileDirectory = args.clear_profile_directory === true ? undefined : stringValue(args.profile_directory) ?? current.profileDirectory;
        const nextBrowserChannel = args.clear_browser_channel === true ? undefined : parseBrowserChannelInput(args.browser_channel) ?? current.browserChannel;
        const nextExecutablePath = args.clear_browser_executable_path === true ? undefined : stringValue(args.browser_executable_path) ?? current.executablePath;
        const nextCdpEndpoint = args.clear_cdp_endpoint === true ? undefined : stringValue(args.cdp_endpoint) ?? current.cdpEndpoint;
        const nextCdpEndpointCandidates = args.clear_cdp_endpoint_candidates === true
          ? undefined
          : stringList(args.cdp_endpoint_candidates) ?? current.cdpEndpointCandidates;
        const nextCdpAttachFallback = parseCdpAttachFallbackInput(args.cdp_attach_fallback) ?? current.cdpAttachFallback;
        const nextNativeAttachMode = parseNativeAttachModeInput(args.native_attach_mode) ?? current.nativeAttachMode;
        const nextNativeBrowserCandidates = parseNativeBrowserCandidatesInput(args.native_browser_candidates) ?? current.nativeBrowserCandidates;
        const config = saveConfig(input.repoRoot, {
          enabled: typeof args.enabled === 'boolean' ? args.enabled : current.enabled,
          browserMode: nextBrowserMode,
          profileMode: nextProfileMode,
          profileDir: nextProfileMode === 'repo_local' ? undefined : nextProfileDir,
          profileDirectory: nextProfileMode === 'repo_local' ? undefined : nextProfileDirectory,
          browserChannel: nextBrowserChannel ?? 'chromium',
          executablePath: nextExecutablePath,
          cdpEndpoint: nextCdpEndpoint,
          cdpEndpointCandidates: nextCdpEndpointCandidates,
          cdpDiscoveryTimeoutMs: typeof args.cdp_discovery_timeout_ms === 'number'
            ? Math.min(positiveNumber(args.cdp_discovery_timeout_ms, DEFAULT_CDP_DISCOVERY_TIMEOUT_MS), MAX_CDP_DISCOVERY_TIMEOUT_MS)
            : current.cdpDiscoveryTimeoutMs,
          cdpAttachFallback: nextCdpAttachFallback,
          nativeAttachMode: nextNativeAttachMode,
          nativeBrowserCandidates: nextNativeBrowserCandidates,
          defaultTimeoutMs: typeof args.default_timeout_ms === 'number'
            ? positiveNumber(args.default_timeout_ms, DEFAULT_TIMEOUT_MS)
            : current.defaultTimeoutMs,
        });
        const configErrors = validateConfig(config);
        if (configErrors.length > 0) {
          throw new AssistantPluginError('PLUGIN_CONFIGURATION_INVALID', configErrors[0], { retryable: false });
        }
        await closeManagedContextsForRepo(input.repoRoot);
        return { config, health: health(config, input.repoRoot) };
      }
      case 'list_sessions': {
        const inventory = await inspectSavedSessions(input.repoRoot, current);
        return {
          provider: 'playwright',
          sessionCountSemantics: 'saved_metadata',
          scannedSessionCount: inventory.scannedSessionCount,
          savedSessionCount: inventory.savedSessionCount,
          liveManagedSessionCount: inventory.liveManagedSessionCount,
          liveNativeSessionCount: inventory.liveNativeSessionCount,
          unverifiedSessionCount: inventory.unverifiedSessionCount,
          deadManagedSessionCount: inventory.deadManagedSessionCount,
          deadNativeSessionCount: inventory.deadNativeSessionCount,
          sessions: inventory.sessions.map(({ session, liveness, evidence, cleanupError }) => ({
            sessionId: session.sessionId,
            url: session.url,
            title: session.title,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            browser: session.browser,
            liveness,
            livenessEvidence: evidence,
            ...(cleanupError ? { cleanupError } : {}),
          })),
        };
      }
      case 'reconcile_sessions': {
        assertBrowserSessionAvailable(input.repoRoot);
        const inventory = await inspectSavedSessions(input.repoRoot, current, { pruneDead: true });
        return {
          reconciled: true,
          sessionCountSemantics: 'saved_metadata',
          scannedSessionCount: inventory.scannedSessionCount,
          savedSessionCount: inventory.savedSessionCount,
          liveManagedSessionCount: inventory.liveManagedSessionCount,
          liveNativeSessionCount: inventory.liveNativeSessionCount,
          unverifiedSessionCount: inventory.unverifiedSessionCount,
          deadManagedSessionCount: inventory.deadManagedSessionCount,
          deadNativeSessionCount: inventory.deadNativeSessionCount,
          closedInvalidNativeSessionCount: inventory.closedInvalidNativeSessionCount,
          failedNativeCleanupCount: inventory.failedNativeCleanupCount,
          prunedSessionCount: inventory.prunedSessionCount,
          prunedSessionIds: inventory.sessions.filter((item) => item.pruned).map((item) => item.session.sessionId),
        };
      }
      case 'close_session':
      case 'close_page': {
        const sessionId = requiredString(input.args.session_id, 'session_id');
        assertBrowserSessionAvailable(input.repoRoot, sessionId);
        const session = findSession(input.repoRoot, sessionId);
        const tab = session?.browser?.tab;
        const managedClosed = session ? await closeManagedSessionPage(input.repoRoot, current, session) : false;
        const nativeClose = session ? await closeTrackedNativeOwnedSession(session, current) : { resourceClosed: false, resourceAlreadyMissing: false };
        const closedSessionIds = session ? nativeOwnedAliasSessionIds(input.repoRoot, session) : [sessionId];
        for (const closedSessionId of closedSessionIds) rmSync(sessionPath(input.repoRoot, closedSessionId), { force: true });
        return {
          closed: true, sessionId,
          resourceClosed: managedClosed || nativeClose.resourceClosed,
          ...(closedSessionIds.length > 1 ? { closedSessionIds } : {}),
          ...(nativeClose.resourceAlreadyMissing ? { resourceAlreadyMissing: true } : {}),
          ...(tab?.ownership === 'user_owned' ? { preservedUserOwnedTab: true } : {}),
        };
      }
      case 'clear_session': {
        assertBrowserSessionAvailable(input.repoRoot);
        const sessions = listSavedSessions(input.repoRoot);
        await closeManagedContextsForRepo(input.repoRoot, { strict: true });
        const failedSessionIds: string[] = [];
        const cleanupErrors: Array<{ sessionId: string; error: string }> = [];
        let removedCount = 0;
        let resourceClosedCount = 0;
        let resourceAlreadyMissingCount = 0;
        for (const session of sessions) {
          try {
            const nativeClose = await closeTrackedNativeOwnedSession(session, current);
            if (nativeClose.resourceClosed) resourceClosedCount += 1;
            if (nativeClose.resourceAlreadyMissing) resourceAlreadyMissingCount += 1;
            rmSync(sessionPath(input.repoRoot, session.sessionId), { force: true });
            removedCount += 1;
          } catch (error) {
            failedSessionIds.push(session.sessionId);
            cleanupErrors.push({ sessionId: session.sessionId, error: error instanceof Error ? error.message : String(error) });
          }
        }
        return {
          cleared: failedSessionIds.length === 0,
          count: removedCount,
          requestedCount: sessions.length,
          resourceClosedCount,
          resourceAlreadyMissingCount,
          failedSessionIds,
          cleanupErrors,
        };
      }
      case 'request_human_handoff': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const managedSession = target.existingSession;
        const managedTarget = managedSession ? await runtimeManagedPageForSession(input.repoRoot, current, managedSession) : undefined;
        if (managedSession && managedTarget) {
          const result = { url: managedTarget.page.url(), title: await managedTarget.page.title().catch(() => managedSession.title) };
          const handoff = startRuntimeManagedBrowserHandoff({
            repoRoot: input.repoRoot,
            repoId: input.repoId,
            requestId: input.requestId,
            jobId: input.jobId,
            sessionId: target.sessionId,
            sessionPath: sessionPath(input.repoRoot, target.sessionId),
            url: target.url,
            profileDir: managedTarget.profile.profileDir,
            selectedProfilePath: managedTarget.profile.selectedProfilePath,
            profileDirectory: managedTarget.profile.profileDirectory,
            browserChannel: current.browserChannel,
            executablePath: current.executablePath ? resolveConfiguredPath(input.repoRoot, current.executablePath) : undefined,
            defaultTimeoutMs: current.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
            reason: stringValue(input.args.reason) ?? 'manual_review',
            instructions: stringValue(input.args.instructions),
            timeoutMs: typeof input.args.handoff_timeout_ms === 'number' ? input.args.handoff_timeout_ms : undefined,
          }, result);
          try {
            if (managedTarget.page.bringToFront) await managedTarget.page.bringToFront();
          } catch (error) {
            resolveRuntimeManagedBrowserHandoff(input.repoRoot, handoff.interactionId, 'cancel', result);
            throw error;
          }
          return {
            provider: 'playwright-runtime-managed-handoff',
            handoff,
            session: managedSession,
            nextAction: 'Complete the manual step, then call resolve_handoff with resolution=resume. Its response contains the updated handoff state; call get_handoff_status only when a later decision needs an observation, not as periodic polling.',
          };
        }
        const nativeSession = target.existingSession;
        const nativeTab = nativeSession?.browser?.tab;
        const nativeBrowser = nativeSession?.browser?.provider === 'macos-apple-events'
          && nativeSession.browser.browserProduct
          && nativeTab?.ownership === 'plugin_owned'
          && typeof nativeTab.windowId === 'string'
          && typeof nativeTab.tabId === 'string'
          ? {
              product: nativeSession.browser.browserProduct,
              ref: { windowId: nativeTab.windowId, tabId: nativeTab.tabId },
            }
          : undefined;
        const handoffMode: BrowserMode = current.browserMode === 'isolated' ? 'isolated' : 'managed_persistent';
        const profile = selectedProfile(current, input.repoRoot, handoffMode, target.sessionId);
        if (!nativeBrowser) mkdirSync(profile.profileDir, { recursive: true });
        const selectedProfilePath = nativeBrowser
          ? `macos-apple-events:${nativeBrowser.product}:${nativeBrowser.ref.windowId}:${nativeBrowser.ref.tabId}`
          : profile.selectedProfilePath;
        const handoff = await startBrowserHandoff({
          repoRoot: input.repoRoot,
          repoId: input.repoId,
          requestId: input.requestId,
          jobId: input.jobId,
          sessionId: target.sessionId,
          sessionPath: sessionPath(input.repoRoot, target.sessionId),
          url: target.url,
          profileDir: profile.profileDir,
          selectedProfilePath,
          profileDirectory: profile.profileDirectory,
          browserChannel: current.browserChannel,
          executablePath: current.executablePath ? resolveConfiguredPath(input.repoRoot, current.executablePath) : undefined,
          defaultTimeoutMs: current.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
          nativeBrowser,
          reason: stringValue(input.args.reason) ?? 'manual_review',
          instructions: stringValue(input.args.instructions),
          timeoutMs: typeof input.args.handoff_timeout_ms === 'number' ? input.args.handoff_timeout_ms : undefined,
        });
        return {
          provider: nativeBrowser ? 'macos-apple-events-handoff-host' : 'playwright-handoff-host',
          handoff,
          session: target.existingSession,
          nextAction: 'Complete the manual step, then call resolve_handoff with resolution=resume. Its response contains the updated handoff state; call get_handoff_status only when a later decision needs an observation, not as periodic polling.',
        };
      }
      case 'get_handoff_status': {
        const interactionId = requiredString(input.args.interaction_id, 'interaction_id');
        const handoff = getBrowserHandoff(input.repoRoot, interactionId);
        return {
          provider: isRuntimeManagedBrowserHandoff(handoff)
            ? 'playwright-runtime-managed-handoff'
            : handoff.targetId.startsWith('macos-apple-events:')
              ? 'macos-apple-events-handoff-host'
              : 'playwright-handoff-host',
          handoff,
        };
      }
      case 'resolve_handoff': {
        const interactionId = requiredString(input.args.interaction_id, 'interaction_id');
        const resolution = requiredString(input.args.resolution, 'resolution');
        if (resolution !== 'resume' && resolution !== 'cancel') {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'resolution must be resume or cancel', { retryable: false });
        }
        const currentHandoff = getBrowserHandoff(input.repoRoot, interactionId);
        if (isRuntimeManagedBrowserHandoff(currentHandoff)) {
          const session = findSession(input.repoRoot, currentHandoff.sessionId);
          const managedTarget = session ? await runtimeManagedPageForSession(input.repoRoot, current, session) : undefined;
          const result = managedTarget
            ? { url: managedTarget.page.url(), title: await managedTarget.page.title().catch(() => session?.title) }
            : currentHandoff.result;
          if (resolution === 'resume' && session && result?.url) {
            saveSession(input.repoRoot, {
              ...session,
              url: result.url,
              title: result.title,
              updatedAt: new Date().toISOString(),
            });
          }
          const handoff = resolveRuntimeManagedBrowserHandoff(input.repoRoot, interactionId, resolution, result);
          return {
            provider: 'playwright-runtime-managed-handoff',
            resolutionRequested: resolution,
            handoff,
          };
        }
        const handoff = resolution === 'resume'
          ? resumeBrowserHandoff(input.repoRoot, interactionId, input.requestId)
          : cancelBrowserHandoff(input.repoRoot, interactionId, input.requestId);
        return {
          provider: handoff.targetId.startsWith('macos-apple-events:') ? 'macos-apple-events-handoff-host' : 'playwright-handoff-host',
          resolutionRequested: resolution,
          handoff,
        };
      }
      case 'create_session':
      case 'open_page':
      case 'navigate': {
        const url = normalizedUrl(input.args.url);
        const existingSessionId = stringValue(input.args.session_id);
        const target: BrowserActionTarget = existingSessionId
          ? { sessionId: existingSessionId, url, existingSession: findSession(input.repoRoot, existingSessionId) }
          : { sessionId: sessionIdFor(url), url };
        const nativeProduct = stringValue(input.args.native_browser_product);
        const normalizedNativeProduct: MacOsBrowserProduct | undefined = nativeProduct === 'chrome' || nativeProduct === 'vivaldi' ? nativeProduct : undefined;
        const nativeWindowId = stringValue(input.args.native_window_id);
        const nativeTabId = stringValue(input.args.native_tab_id);
        const nativeActiveTab = input.args.native_active_tab === true;
        const hasNativeAdoption = Boolean(nativeProduct || nativeWindowId || nativeTabId || nativeActiveTab);
        if (hasNativeAdoption) {
          if (input.actionId !== 'create_session' || (nativeProduct && !normalizedNativeProduct)) {
            throw new AssistantPluginError(
              'PLUGIN_ACTION_ARGUMENT_INVALID',
              'Explicit native tab adoption is only supported by create_session for Chrome or Vivaldi.',
              { retryable: false },
            );
          }
          const timeout = positiveNumber(input.args.timeout_ms, current.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
          let adoptedProduct: MacOsBrowserProduct;
          let adoptedRef: MacOsBrowserTabRef;
          if (nativeActiveTab) {
            if (nativeWindowId || nativeTabId) {
              throw new AssistantPluginError(
                'PLUGIN_ACTION_ARGUMENT_INVALID',
                'native_active_tab cannot be combined with native_window_id or native_tab_id.',
                { retryable: false },
              );
            }
            const configuredCandidates = (current.nativeBrowserCandidates ?? ['vivaldi', 'chrome'])
              .filter((candidate): candidate is MacOsBrowserProduct => candidate === 'chrome' || candidate === 'vivaldi');
            const candidates: MacOsBrowserProduct[] = normalizedNativeProduct ? [normalizedNativeProduct] : configuredCandidates;
            const discovered = await discoverMacOsBrowserAttachment(candidates, Math.min(timeout, MAX_CDP_DISCOVERY_TIMEOUT_MS));
            const activeMetadata = discovered.attachment?.metadata;
            const requiresSystemFrontmost = !normalizedNativeProduct;
            if (!activeMetadata || (requiresSystemFrontmost && !activeMetadata.frontmost) || !activeMetadata.windowId || !activeMetadata.tabId) {
              throw new AssistantPluginError(
                'PLUGIN_BROWSER_ACTIVE_TAB_UNAVAILABLE',
                requiresSystemFrontmost
                  ? 'No frontmost native browser tab with a stable native identity is available for adoption.'
                  : 'The explicitly selected native browser does not expose an active tab with a stable native identity.',
                { retryable: true, details: { browserProduct: nativeProduct, requiresSystemFrontmost, attempts: discovered.attempts } },
              );
            }
            adoptedProduct = activeMetadata.product;
            adoptedRef = { windowId: activeMetadata.windowId, tabId: activeMetadata.tabId };
          } else {
            if (!normalizedNativeProduct || !nativeWindowId || !nativeTabId) {
              throw new AssistantPluginError(
                'PLUGIN_ACTION_ARGUMENT_INVALID',
                'Explicit native tab adoption requires native_active_tab=true or native_browser_product with native_window_id and native_tab_id.',
                { retryable: false },
              );
            }
            adoptedProduct = normalizedNativeProduct;
            adoptedRef = { windowId: nativeWindowId, tabId: nativeTabId };
          }
          const adopted = await reattachMacOsBrowserOwnedPage(adoptedProduct, adoptedRef, timeout);
          const metadata = adopted.attachment.metadata;
          const pageUrl = normalizedUrl(metadata.url);
          if (comparableUrl(pageUrl) !== comparableUrl(url)) {
            throw new AssistantPluginError(
              'PLUGIN_BROWSER_ADOPTED_TAB_URL_MISMATCH',
              'Explicitly adopted native tab URL does not match the requested session URL.',
              { retryable: false, details: { requestedUrl: url, actualUrl: pageUrl, browserProduct: adoptedProduct, windowId: adoptedRef.windowId, tabId: adoptedRef.tabId } },
            );
          }
          const title = metadata.title || '';
          const connection = refreshConnectionTab({
            requestedMode: 'attach_preferred',
            mode: 'attach_preferred',
            provider: 'macos-apple-events',
            attached: true,
            browserProduct: adoptedProduct,
            profile: { selectedProfilePath: `macos:${adoptedProduct}:user-tab` },
            tabInventory: [{ index: 0, key: tabKey(pageUrl, title), url: pageUrl, title }],
            sessionResume: { sessionId: target.sessionId, status: 'matched', reason: nativeActiveTab ? 'Explicitly adopted the matching frontmost user-owned native browser tab.' : 'Explicitly adopted an existing user-owned native browser tab.' },
          }, pageUrl, title, 'saved_url', { ownership: 'user_owned', windowId: adoptedRef.windowId, tabId: adoptedRef.tabId });
          const session = sessionFromPage(target, pageUrl, title, connection);
          saveSession(input.repoRoot, session);
          return {
            provider: 'macos-apple-events',
            session,
            navigation: { url: pageUrl },
            browserConnection: { ...connection, tab: session.browser?.tab, sessionResume: session.browser?.sessionResume },
            ...(input.args.extract_text === true
              ? { text: await extractText(adopted.page as unknown as PageLike, undefined, positiveNumber(input.args.max_chars, DEFAULT_MAX_TEXT_CHARS)) }
              : {}),
          };
        }
        return await withPage(input.repoRoot, current, target, input.args, async (page, diagnostics, connection) => {
          const identity = await readPageIdentity(page, connection);
          const session = sessionFromPage(target, identity.url, identity.title, connection);
          saveSession(input.repoRoot, session);
          return {
            provider: browserResultProvider(connection.provider),
            session,
            navigation: diagnostics.navigation,
            browserConnection: {
              ...connection,
              tab: session.browser?.tab,
              sessionResume: session.browser?.sessionResume,
            },
            ...(input.args.extract_text === true
              ? { text: await extractText(page, undefined, positiveNumber(input.args.max_chars, DEFAULT_MAX_TEXT_CHARS)) }
              : {}),
          };
        }, { requireExistingResource: Boolean(existingSessionId) });
      }
      case 'reload':
      case 'go_back':
      case 'wait_for_load_state': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        return await withPage(input.repoRoot, current, target, input.args, async (page, diagnostics, connection) => {
          if (input.actionId === 'reload') {
            if (page.reload) await page.reload({ waitUntil: waitUntil(input.args.wait_until), timeout: positiveNumber(input.args.timeout_ms, current.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS) });
            else await page.goto(target.url, { waitUntil: waitUntil(input.args.wait_until), timeout: positiveNumber(input.args.timeout_ms, current.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS) });
          } else if (input.actionId === 'go_back') {
            if (page.goBack) await page.goBack({ waitUntil: waitUntil(input.args.wait_until), timeout: positiveNumber(input.args.timeout_ms, current.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS) });
          } else if (page.waitForLoadState) {
            await page.waitForLoadState(waitUntil(input.args.state ?? input.args.wait_until), {
              timeout: positiveNumber(input.args.timeout_ms, current.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS),
            });
          }
          const identity = await readPageIdentity(page, connection);
          const session = sessionFromPage(target, identity.url, identity.title, connection);
          saveSession(input.repoRoot, session);
          return {
            provider: browserResultProvider(connection.provider),
            session,
            navigation: diagnostics.navigation,
            actionId: input.actionId,
            browserConnection: {
              ...connection,
              tab: session.browser?.tab,
              sessionResume: session.browser?.sessionResume,
            },
          };
        }, input.actionId === 'reload'
          ? { requireExistingResource: true, pruneStaleSessionMetadata: true }
          : {});
      }
      case 'get_text': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        return {
          sessionId: target.sessionId,
          url: target.url,
          ...(await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
            const selection = resolveBrowserEvaluationScope(page, input.args, connection);
            return {
              provider: browserResultProvider(connection.provider),
              ...(await extractText(selection.scope, stringValue(input.args.selector), positiveNumber(input.args.max_chars, DEFAULT_MAX_TEXT_CHARS))),
              ...(selection.frame ? { frame: selection.frame } : {}),
              browserConnection: connection,
            };
          }, { persistSession: true })),
        };
      }
      case 'get_html': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
          const selection = resolveBrowserEvaluationScope(page, input.args, connection);
          const raw = await selection.scope.evaluate<string>(EXTRACTION_SCRIPTS.html(stringValue(input.args.selector)));
          return {
            provider: browserResultProvider(connection.provider),
            sessionId: target.sessionId,
            url: target.url,
            ...(selection.frame ? { frame: selection.frame } : {}),
            browserConnection: connection,
            ...truncateText(raw, positiveNumber(input.args.max_chars, DEFAULT_MAX_TEXT_CHARS)),
          };
        }, { persistSession: true });
      }
      case 'query_selector':
      case 'query_all': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const selector = requiredString(input.args.selector, 'selector');
        const limit = Math.min(positiveNumber(input.args.limit, 25), 100);
        return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
          const selection = resolveBrowserEvaluationScope(page, input.args, connection);
          const matches = await selection.scope.evaluate<Array<Record<string, unknown>>>(EXTRACTION_SCRIPTS.query(selector, input.actionId === 'query_selector' ? 1 : limit));
          return {
            provider: browserResultProvider(connection.provider),
            sessionId: target.sessionId,
            url: target.url,
            selector,
            ...(selection.frame ? { frame: selection.frame } : {}),
            browserConnection: connection,
            ...(input.actionId === 'query_selector'
              ? { match: matches[0] ?? null, found: matches.length > 0 }
              : { matches, count: matches.length }),
          };
        }, { persistSession: true });
      }
      case 'get_attribute': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const selector = requiredString(input.args.selector, 'selector');
        const attribute = requiredString(input.args.attribute, 'attribute');
        return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
          const selection = resolveBrowserEvaluationScope(page, input.args, connection);
          return {
            provider: browserResultProvider(connection.provider),
            sessionId: target.sessionId,
            url: target.url,
            selector,
            attribute,
            ...(selection.frame ? { frame: selection.frame } : {}),
            browserConnection: connection,
            value: await selection.scope.evaluate<string | null>(EXTRACTION_SCRIPTS.attribute(selector, attribute)),
          };
        }, { persistSession: true });
      }
      case 'list_frames': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const limit = Math.min(positiveNumber(input.args.limit, 50), 100);
        return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
          if (connection.provider === 'macos-apple-events' || !page.frames) {
            throw new AssistantPluginError('PLUGIN_BROWSER_FRAME_SCOPE_UNAVAILABLE', 'Frame discovery requires a Playwright/CDP-controlled page; native Apple Events sessions fail closed.', {
              retryable: false,
              details: { provider: connection.provider },
            });
          }
          const allFrames = page.frames();
          const frames = allFrames.slice(0, limit).map((frame) => ({ url: frame.url(), name: frame.name() }));
          return {
            provider: browserResultProvider(connection.provider),
            sessionId: target.sessionId,
            url: target.url,
            frames,
            count: allFrames.length,
            truncated: allFrames.length > frames.length,
            browserConnection: connection,
          };
        }, { persistSession: true });
      }
      case 'verify_state': {
        requiredString(input.args.session_id, 'session_id');
        const target = resolveActionTarget(input.repoRoot, input.args);
        const expectedUrlRaw = stringValue(input.args.expected_url);
        const expectedUrl = expectedUrlRaw ? normalizedUrl(expectedUrlRaw) : undefined;
        const urlContains = stringValue(input.args.url_contains);
        const selector = stringValue(input.args.selector);
        const requireVisible = input.args.require_visible === true;
        const textContains = stringValue(input.args.text_contains);
        if (!expectedUrl && !urlContains && !selector && !textContains) {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'verify_state requires at least one of expected_url, url_contains, selector, or text_contains.', { retryable: false });
        }
        if (requireVisible && !selector) {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'require_visible requires selector.', { retryable: false });
        }
        return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
          const selection = resolveBrowserEvaluationScope(page, input.args, connection);
          const observedUrl = selection.frame?.url ?? page.url();
          const checks: Array<Record<string, unknown>> = [];
          if (expectedUrl) checks.push({ criterion: 'url_exact', expected: expectedUrl, observed: observedUrl, matched: observedUrl === expectedUrl });
          if (urlContains) checks.push({ criterion: 'url_contains', expected: urlContains, observed: observedUrl, matched: observedUrl.includes(urlContains) });
          let observation: { verificationVersion?: unknown; selectorExists?: unknown; visible?: unknown; textContains?: unknown; textSample?: unknown; textLength?: unknown; truncated?: unknown } | undefined;
          if (selector || textContains) {
            observation = await selection.scope.evaluate(verifyStateObservationScript(selector, textContains, Math.min(positiveNumber(input.args.max_chars, 2_000), 100_000)));
            if (observation?.verificationVersion !== 1) {
              throw new AssistantPluginError('PLUGIN_BROWSER_VERIFY_STATE_UNAVAILABLE', 'Browser state observation returned an unsupported result.', { retryable: true });
            }
          }
          if (selector) {
            checks.push({ criterion: 'selector_exists', expected: true, observed: observation?.selectorExists === true, matched: observation?.selectorExists === true, selector });
            if (requireVisible) {
              checks.push({ criterion: 'selector_visible', expected: true, observed: observation?.visible === true, matched: observation?.visible === true, selector });
            }
          }
          if (textContains) {
            checks.push({
              criterion: 'text_contains', expected: textContains, observed: observation?.textSample,
              matched: observation?.textContains === true, textLength: observation?.textLength, truncated: observation?.truncated,
              ...(selector ? { selector } : {}),
            });
          }
          return {
            provider: browserResultProvider(connection.provider),
            sessionId: target.sessionId,
            url: target.url,
            observedUrl,
            ...(selection.frame ? { frame: selection.frame } : {}),
            matched: checks.every((check) => check.matched === true),
            checks,
            browserConnection: connection,
          };
        }, { requireExistingResource: true });
      }
      case 'screenshot': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const file = screenshotFilePath(input.repoRoot, 'screenshot', target.sessionId, target.url);
        const selector = stringValue(input.args.selector);
        const screenshot = await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
          let bytes: number;
          if (selector && page.locator) {
            bytes = (await page.locator(selector).screenshot({ path: file })).length;
          } else {
            bytes = (await page.screenshot({ path: file, fullPage: input.args.full_page === true })).length;
          }
          return {
            url: normalizedUrl(page.url()),
            title: await page.title(),
            path: file,
            relativePath: relative(input.repoRoot, file),
            bytes,
            fullPage: input.args.full_page === true,
            selector,
            browserConnection: connection,
          };
        });
        return { provider: browserResultProvider(screenshot.browserConnection.provider), screenshot };
      }
      case 'extract_links':
      case 'extract_tables':
      case 'extract_forms':
      case 'snapshot_interactive': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const limit = Math.min(positiveNumber(input.args.limit, 50), 200);
        return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
          const script = input.actionId === 'extract_links'
            ? EXTRACTION_SCRIPTS.links(limit)
            : input.actionId === 'extract_tables'
              ? EXTRACTION_SCRIPTS.tables(limit)
              : input.actionId === 'extract_forms'
                ? EXTRACTION_SCRIPTS.forms(limit)
                : EXTRACTION_SCRIPTS.interactive(limit);
          const selection = input.actionId === 'snapshot_interactive'
            ? resolveBrowserEvaluationScope(page, input.args, connection)
            : { scope: page } as BrowserFrameSelection;
          const evaluated = await selection.scope.evaluate<unknown>(script);
          const grounded = input.actionId === 'snapshot_interactive' && evaluated && typeof evaluated === 'object' && !Array.isArray(evaluated)
            ? evaluated as { geometryVersion?: unknown; viewport?: unknown; elements?: unknown }
            : undefined;
          let data = grounded && Array.isArray(grounded.elements) ? grounded.elements : evaluated;
          let viewport = grounded?.viewport;
          let frameViewport: unknown;
          let frameOffset: { x: number; y: number; width: number; height: number } | undefined;
          if (grounded?.geometryVersion === 1 && selection.frame && Array.isArray(grounded.elements)) {
            frameOffset = await resolveFrameViewportOffset(page, selection);
            if (!frameOffset) {
              throw new AssistantPluginError('PLUGIN_BROWSER_FRAME_GEOMETRY_UNAVAILABLE', 'Frame geometry offset was not available.', { retryable: true });
            }
            const topMetrics = await page.evaluate<{ viewportMetricsVersion?: unknown; viewport?: unknown }>(VIEWPORT_METRICS_SCRIPT);
            if (topMetrics?.viewportMetricsVersion !== 1 || !topMetrics.viewport) {
              throw new AssistantPluginError('PLUGIN_BROWSER_FRAME_GEOMETRY_UNAVAILABLE', 'Top-level viewport metrics were not available for frame grounding.', { retryable: true });
            }
            frameViewport = grounded.viewport;
            viewport = topMetrics.viewport;
            data = translateFrameGroundingElements(grounded.elements, frameOffset, topMetrics.viewport);
          }
          return {
            provider: browserResultProvider(connection.provider),
            sessionId: target.sessionId,
            url: target.url,
            actionId: input.actionId,
            data,
            ...(selection.frame ? { frame: selection.frame } : {}),
            ...(grounded?.geometryVersion === 1 ? { geometryVersion: 1, viewport } : {}),
            ...(selection.frame && frameOffset ? { coordinateSpace: 'main_viewport_css', frameViewport, frameOffset } : {}),
            browserConnection: connection,
          };
        }, { persistSession: true });
      }
      case 'get_console_errors':
      case 'get_failed_requests': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        return await withPage(input.repoRoot, current, target, input.args, async (_page, diagnostics, connection) => {
          if (connection.provider === 'macos-apple-events') {
            throw new AssistantPluginError(
              'PLUGIN_BROWSER_DIAGNOSTICS_UNAVAILABLE',
              'Console and failed-request diagnostics require a Playwright/CDP-controlled page; native Apple Events sessions do not expose browser diagnostic events.',
              { retryable: false, details: { provider: connection.provider, actionId: input.actionId, sessionId: target.sessionId } },
            );
          }
          return {
            provider: browserResultProvider(connection.provider),
            sessionId: target.sessionId,
            url: target.url,
            navigation: diagnostics.navigation,
            browserConnection: connection,
            ...(input.actionId === 'get_console_errors'
              ? { consoleErrors: diagnostics.consoleErrors.slice(0, 50) }
              : { failedRequests: diagnostics.failedRequests.slice(0, 50) }),
          };
        }, { persistSession: true });
      }
      case 'activate_page': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
          if (!page.bringToFront) {
            throw new AssistantPluginError('PLUGIN_BROWSER_ACTIVATION_UNSUPPORTED', 'The selected browser provider cannot bring the saved page to the foreground.', { retryable: false });
          }
          await page.bringToFront();
          await delay(positiveNumber(input.args.post_action_wait_ms, DEFAULT_POST_ACTION_WAIT_MS));
          return finalizeInteractiveAction(input.repoRoot, current, page, target, connection, 'activate_page', 'Activated the exact saved browser page in the foreground.', {});
        });
      }
      case 'click_text': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const text = requiredString(input.args.text, 'text');
        if (text.length > 200) {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'text must be 200 characters or fewer.', { retryable: false });
        }
        return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
          const clicked = await page.evaluate((payload) => {
            const args = payload as { text: string };
            const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
            const roots: Array<Document | ShadowRoot> = [document];
            const candidates: HTMLElement[] = [];
            for (let index = 0; index < roots.length; index += 1) {
              const root = roots[index];
              candidates.push(...Array.from(root.querySelectorAll<HTMLElement>('button,[role=button],a,div,span')));
              for (const host of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
                if (host.shadowRoot) roots.push(host.shadowRoot);
              }
            }
            const matches = candidates
              .filter((element) => normalize(element.innerText || element.textContent || '') === args.text)
              .filter((element) => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
              })
              .sort((left, right) => {
                const childDelta = left.children.length - right.children.length;
                if (childDelta !== 0) return childDelta;
                const leftRect = left.getBoundingClientRect();
                const rightRect = right.getBoundingClientRect();
                return (leftRect.width * leftRect.height) - (rightRect.width * rightRect.height);
              });
            const element = matches[0];
            if (!element) throw new Error(`visible exact text not found: ${args.text}`);
            element.click();
            return { tag: element.tagName.toLowerCase(), className: element.className || '', text: normalize(element.innerText || element.textContent || '') };
          }, { text });
          await delay(positiveNumber(input.args.post_action_wait_ms, DEFAULT_POST_ACTION_WAIT_MS));
          return finalizeInteractiveAction(input.repoRoot, current, page, target, connection, 'click_text', `Clicked exact visible text ${text}.`, { text, clicked });
        });
      }
      case 'click':
      case 'double_click':
      case 'hover':
      case 'focus':
      case 'check':
      case 'uncheck': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const selector = requiredString(input.args.selector, 'selector');
        const timeoutMs = positiveNumber(input.args.timeout_ms, current.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
        try {
          return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
            if (input.actionId === 'click' && openShadowSelectorParts(selector).length > 1) {
              const parts = openShadowSelectorParts(selector);
              await page.evaluate((payload) => {
                const args = payload as { parts: string[] };
                let root: Document | ShadowRoot = document;
                for (let index = 0; index < args.parts.length - 1; index += 1) {
                  const host: Element | null = root.querySelector(args.parts[index]);
                  if (!host || !host.shadowRoot) throw new Error(`Open shadow root not found for selector segment: ${args.parts[index]}`);
                  root = host.shadowRoot;
                }
                const element = root.querySelector(args.parts[args.parts.length - 1]) as HTMLElement | null;
                if (!element || typeof element.click !== 'function') throw new Error('Shadow selector did not resolve to a clickable element.');
                element.click();
                return true;
              }, { parts });
            } else if (input.actionId === 'click') await page.click(selector, { timeout: timeoutMs });
            else if (input.actionId === 'double_click') {
              if (page.dblclick) await page.dblclick(selector, { timeout: timeoutMs });
              else await page.click(selector, { timeout: timeoutMs, clickCount: 2 } as Record<string, unknown>);
            } else if (input.actionId === 'hover') {
              if (page.hover) await page.hover(selector, { timeout: timeoutMs });
            } else if (input.actionId === 'focus') {
              if (page.focus) await page.focus(selector, { timeout: timeoutMs });
            } else if (input.actionId === 'check') {
              if (page.check) await page.check(selector, { timeout: timeoutMs });
              else await page.click(selector, { timeout: timeoutMs });
            } else if (input.actionId === 'uncheck') {
              if (page.uncheck) await page.uncheck(selector, { timeout: timeoutMs });
              else await page.click(selector, { timeout: timeoutMs });
            }
            await delay(positiveNumber(input.args.post_action_wait_ms, DEFAULT_POST_ACTION_WAIT_MS));
            const summary = input.actionId === 'click'
              ? `Clicked ${selector}.`
              : input.actionId === 'double_click'
                ? `Double-clicked ${selector}.`
                : input.actionId === 'hover'
                  ? `Hovered ${selector}.`
                  : input.actionId === 'focus'
                    ? `Focused ${selector}.`
                    : input.actionId === 'check'
                      ? `Checked ${selector}.`
                      : `Unchecked ${selector}.`;
            return finalizeInteractiveAction(input.repoRoot, current, page, target, connection, input.actionId, summary, { selector });
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new AssistantPluginError('PLUGIN_ACTION_FAILED', message, {
            retryable: true,
            details: { selector, repairHint: selectorRepairHint(selector, message) },
          });
        }
      }
      case 'type':
      case 'fill': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const selector = requiredString(input.args.selector, 'selector');
        const text = requiredString(input.args.text, 'text');
        const timeoutMs = positiveNumber(input.args.timeout_ms, current.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
        return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
          if (input.actionId === 'fill' || !page.type) await page.fill(selector, text, { timeout: timeoutMs });
          else await page.type(selector, text, { timeout: timeoutMs });
          await delay(positiveNumber(input.args.post_action_wait_ms, DEFAULT_POST_ACTION_WAIT_MS));
          return finalizeInteractiveAction(input.repoRoot, current, page, target, connection, input.actionId, `${input.actionId} ${selector} with ${text.length} characters.`, {
            selector,
            textLength: text.length,
          });
        });
      }
      case 'select_option': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const selector = requiredString(input.args.selector, 'selector');
        const values = Array.isArray(input.args.values) ? input.args.values.map(String) : [];
        if (values.length === 0) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'values is required.', { retryable: false });
        return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
          if (page.selectOption) await page.selectOption(selector, values, { timeout: positiveNumber(input.args.timeout_ms, current.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS) });
          await delay(positiveNumber(input.args.post_action_wait_ms, DEFAULT_POST_ACTION_WAIT_MS));
          return finalizeInteractiveAction(input.repoRoot, current, page, target, connection, 'select_option', `Selected ${values.length} option(s) on ${selector}.`, { selector, values });
        });
      }
      case 'press': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const selector = requiredString(input.args.selector, 'selector');
        const key = requiredString(input.args.key, 'key');
        return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
          await page.press(selector, key, { timeout: positiveNumber(input.args.timeout_ms, current.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS) });
          await delay(positiveNumber(input.args.post_action_wait_ms, DEFAULT_POST_ACTION_WAIT_MS));
          return finalizeInteractiveAction(input.repoRoot, current, page, target, connection, 'press', `Pressed ${key} on ${selector}.`, {
            selector,
            key,
          });
        });
      }
      case 'keyboard_shortcut': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const key = requiredString(input.args.key, 'key');
        return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
          if (page.keyboard?.press) await page.keyboard.press(key);
          else await page.press('body', key, { timeout: positiveNumber(input.args.timeout_ms, current.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS) });
          await delay(positiveNumber(input.args.post_action_wait_ms, DEFAULT_POST_ACTION_WAIT_MS));
          return finalizeInteractiveAction(input.repoRoot, current, page, target, connection, 'keyboard_shortcut', `Pressed shortcut ${key}.`, { key });
        });
      }
      case 'trusted_input': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const kind = requiredString(input.args.kind, 'kind');
        if (!['click', 'move', 'wheel', 'drag', 'key', 'text'].includes(kind)) {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'kind must be click, move, wheel, drag, key, or text.', { retryable: false });
        }
        const guardSelector = stringValue(input.args.guard_selector);
        const hasFrameScope = Boolean(stringValue(input.args.frame_url) || stringValue(input.args.frame_name));
        if (hasFrameScope && !guardSelector) {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'trusted_input frame scope requires guard_selector; trusted input coordinates are always main-viewport CSS pixels.', { retryable: false });
        }
        if (guardSelector && kind !== 'click' && kind !== 'drag') {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'guard_selector is supported only for trusted_input click or drag.', { retryable: false });
        }
        return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
          if (connection.provider === 'macos-apple-events' || !page.mouse || !page.keyboard) {
            throw new AssistantPluginError(
              'PLUGIN_BROWSER_TRUSTED_INPUT_UNAVAILABLE',
              'Trusted background input requires a Playwright/CDP-controlled page; native Apple Events sessions are never promoted to foreground or OS-level input as fallback.',
              { retryable: false, details: { provider: connection.provider, sessionId: target.sessionId } },
            );
          }
          const button = input.args.button === 'middle' || input.args.button === 'right' ? input.args.button : 'left';
          let guard: Record<string, unknown> | undefined;
          if (guardSelector) {
            const point = kind === 'click'
              ? { x: requiredFiniteNumber(input.args.x, 'x', 0), y: requiredFiniteNumber(input.args.y, 'y', 0) }
              : { x: requiredFiniteNumber(input.args.from_x, 'from_x', 0), y: requiredFiniteNumber(input.args.from_y, 'from_y', 0) };
            const selection = resolveBrowserEvaluationScope(page, input.args, connection);
            const observed = await selection.scope.evaluate<{
              trustedInputGuardVersion?: unknown; found?: unknown; visible?: unknown; selectorError?: unknown;
              bounds?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown; right?: unknown; bottom?: unknown };
            }>(trustedInputGuardScript(guardSelector));
            if (observed?.trustedInputGuardVersion !== 1 || observed.found !== true || observed.visible !== true || !observed.bounds) {
              throw new AssistantPluginError('PLUGIN_BROWSER_TRUSTED_INPUT_GUARD_MISMATCH', 'Trusted input guard selector is missing or not visibly actionable.', {
                retryable: true,
                details: { selector: guardSelector, frame: selection.frame, found: observed?.found, visible: observed?.visible, selectorError: observed?.selectorError },
              });
            }
            const finite = (value: unknown, field: string): number => {
              if (typeof value !== 'number' || !Number.isFinite(value)) {
                throw new AssistantPluginError('PLUGIN_BROWSER_TRUSTED_INPUT_GUARD_MISMATCH', `Trusted input guard ${field} is not finite.`, { retryable: true });
              }
              return value;
            };
            let bounds = {
              x: finite(observed.bounds.x, 'bounds.x'), y: finite(observed.bounds.y, 'bounds.y'),
              width: finite(observed.bounds.width, 'bounds.width'), height: finite(observed.bounds.height, 'bounds.height'),
              right: finite(observed.bounds.right, 'bounds.right'), bottom: finite(observed.bounds.bottom, 'bounds.bottom'),
            };
            if (selection.frame) {
              const offset = await resolveFrameViewportOffset(page, selection);
              if (!offset) throw new AssistantPluginError('PLUGIN_BROWSER_TRUSTED_INPUT_GUARD_MISMATCH', 'Trusted input frame offset is unavailable.', { retryable: true });
              bounds = {
                ...bounds,
                x: bounds.x + offset.x,
                y: bounds.y + offset.y,
                right: bounds.right + offset.x,
                bottom: bounds.bottom + offset.y,
              };
            }
            const metrics = await page.evaluate<{ viewportMetricsVersion?: unknown; viewport?: { width?: unknown; height?: unknown } }>(VIEWPORT_METRICS_SCRIPT);
            const viewportWidth = metrics?.viewportMetricsVersion === 1 && typeof metrics.viewport?.width === 'number' && Number.isFinite(metrics.viewport.width) ? metrics.viewport.width : undefined;
            const viewportHeight = metrics?.viewportMetricsVersion === 1 && typeof metrics.viewport?.height === 'number' && Number.isFinite(metrics.viewport.height) ? metrics.viewport.height : undefined;
            if (viewportWidth === undefined || viewportHeight === undefined) {
              throw new AssistantPluginError('PLUGIN_BROWSER_TRUSTED_INPUT_GUARD_MISMATCH', 'Trusted input guard could not verify the top-level viewport.', { retryable: true });
            }
            const targetInViewport = bounds.right > 0 && bounds.bottom > 0 && bounds.x < viewportWidth && bounds.y < viewportHeight;
            const pointInViewport = point.x >= 0 && point.y >= 0 && point.x < viewportWidth && point.y < viewportHeight;
            const pointInsideTarget = point.x >= bounds.x && point.x <= bounds.right && point.y >= bounds.y && point.y <= bounds.bottom;
            if (!targetInViewport || !pointInViewport || !pointInsideTarget) {
              throw new AssistantPluginError('PLUGIN_BROWSER_TRUSTED_INPUT_GUARD_MISMATCH', 'Trusted input coordinates no longer match the guarded selector geometry.', {
                retryable: true,
                details: { selector: guardSelector, frame: selection.frame, point, bounds, targetInViewport, pointInViewport, pointInsideTarget },
              });
            }
            guard = { selector: guardSelector, ...(selection.frame ? { frame: selection.frame } : {}), point, bounds, targetInViewport: true, pointInViewport: true, pointInsideTarget: true };
          }
          if (kind === 'click') {
            const x = requiredFiniteNumber(input.args.x, 'x', 0);
            const y = requiredFiniteNumber(input.args.y, 'y', 0);
            const clickCount = Math.min(Math.max(positiveNumber(input.args.click_count, 1), 1), 3);
            await page.mouse.click(x, y, { button, clickCount });
          } else if (kind === 'move') {
            const x = requiredFiniteNumber(input.args.x, 'x', 0);
            const y = requiredFiniteNumber(input.args.y, 'y', 0);
            const steps = Math.min(Math.max(positiveNumber(input.args.steps, 1), 1), 100);
            await page.mouse.move(x, y, { steps });
          } else if (kind === 'wheel') {
            const deltaX = requiredFiniteNumber(input.args.delta_x, 'delta_x');
            const deltaY = requiredFiniteNumber(input.args.delta_y, 'delta_y');
            await page.mouse.wheel(deltaX, deltaY);
          } else if (kind === 'drag') {
            const fromX = requiredFiniteNumber(input.args.from_x, 'from_x', 0);
            const fromY = requiredFiniteNumber(input.args.from_y, 'from_y', 0);
            const toX = requiredFiniteNumber(input.args.to_x, 'to_x', 0);
            const toY = requiredFiniteNumber(input.args.to_y, 'to_y', 0);
            const steps = Math.min(Math.max(positiveNumber(input.args.steps, 10), 1), 100);
            await page.mouse.move(fromX, fromY);
            await page.mouse.down({ button });
            try {
              await page.mouse.move(toX, toY, { steps });
            } finally {
              await page.mouse.up({ button });
            }
          } else if (kind === 'key') {
            await page.keyboard.press(requiredString(input.args.key, 'key'));
          } else {
            if (!page.keyboard.insertText) {
              throw new AssistantPluginError('PLUGIN_BROWSER_TRUSTED_INPUT_UNAVAILABLE', 'This Playwright page does not expose trusted text insertion.', { retryable: false });
            }
            const text = typeof input.args.text === 'string' ? input.args.text : undefined;
            if (text === undefined || text.length > 10_000) {
              throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'text is required and must be at most 10000 characters.', { retryable: false });
            }
            await page.keyboard.insertText(text);
          }
          await delay(positiveNumber(input.args.post_action_wait_ms, DEFAULT_POST_ACTION_WAIT_MS));
          return finalizeInteractiveAction(input.repoRoot, current, page, target, connection, 'trusted_input', `Sent trusted browser input (${kind}).`, { kind, ...(guard ? { guard } : {}) });
        });
      }
      case 'dispatch_event': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const selector = requiredString(input.args.selector, 'selector');
        const event = requiredString(input.args.event, 'event');
        if (!/^[A-Za-z][A-Za-z0-9:_-]{0,63}$/.test(event)) {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'event must be a simple DOM event name (letters, digits, colon, underscore, or hyphen; max 64 chars).', { retryable: false });
        }
        return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
          const dispatched = await page.evaluate((payload) => {
            const args = payload as { selector: string; event: string };
            const element = document.querySelector(args.selector);
            if (!element) throw new Error(`element not found: ${args.selector}`);
            const domEvent = new CustomEvent(args.event, { bubbles: true, composed: true, cancelable: true });
            const accepted = element.dispatchEvent(domEvent);
            return { accepted, defaultPrevented: domEvent.defaultPrevented };
          }, { selector, event });
          await delay(positiveNumber(input.args.post_action_wait_ms, DEFAULT_POST_ACTION_WAIT_MS));
          return finalizeInteractiveAction(input.repoRoot, current, page, target, connection, 'dispatch_event', `Dispatched ${event} on ${selector}.`, {
            selector,
            event,
            dispatched,
          });
        });
      }
      case 'wait_for_selector': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const selector = requiredString(input.args.selector, 'selector');
        const state = waitForSelectorState(input.args.state);
        return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
          await page.waitForSelector(selector, {
            state,
            timeout: positiveNumber(input.args.timeout_ms, current.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS),
          });
          return finalizeInteractiveAction(input.repoRoot, current, page, target, connection, 'wait_for_selector', `Observed ${selector} in state ${state}.`, {
            selector,
            state,
          });
        });
      }
      case 'attach_local_file': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const selector = requiredString(input.args.selector, 'selector');
        const single = stringValue(input.args.file_path);
        const many = stringList(input.args.file_paths);
        if (single && many) {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Use either file_path or file_paths, not both.', { retryable: false });
        }
        const requested = many ?? (single ? [single] : []);
        if (requested.length === 0 || requested.length > 32) {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'attach_local_file requires file_path or 1-32 file_paths.', { retryable: false });
        }
        const repositoryLexicalRoot = resolve(input.repoRoot);
        const repositoryRoot = realpathSync(input.repoRoot);
        const resolved = requested.map((filePath) => {
          const lexicalPath = resolve(input.repoRoot, filePath);
          const lexicalRelative = relative(repositoryLexicalRoot, lexicalPath);
          if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
            throw new AssistantPluginError('PLUGIN_POLICY_BLOCKED', 'Local file attachments must stay inside the repository root.', { retryable: false, details: { fileName: basename(filePath) } });
          }
          if (!existsSync(lexicalPath)) {
            throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Local attachment does not exist: ${basename(lexicalPath)}`, { retryable: false });
          }
          const realPath = realpathSync(lexicalPath);
          const repositoryRelative = relative(repositoryRoot, realPath);
          if (repositoryRelative === '..' || repositoryRelative.startsWith(`..${sep}`) || isAbsolute(repositoryRelative)) {
            throw new AssistantPluginError('PLUGIN_POLICY_BLOCKED', 'Local file attachments must resolve inside the repository root.', { retryable: false, details: { fileName: basename(lexicalPath) } });
          }
          if (!statSync(realPath).isFile()) {
            throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Local attachment is not a regular file: ${basename(lexicalPath)}`, { retryable: false });
          }
          if (/\.(exe|dmg|pkg|sh|bat|cmd|app)$/i.test(realPath)) {
            throw new AssistantPluginError('PLUGIN_POLICY_BLOCKED', 'Executable file attachments are not allowed.', { retryable: false });
          }
          return lexicalPath;
        });
        return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
          await page.evaluate((payload) => {
            const args = payload as { selector: string; count: number };
            const el = document.querySelector(args.selector) as HTMLInputElement | null;
            if (!(el instanceof HTMLInputElement) || el.type !== 'file') throw new Error(`file input not found: ${args.selector}`);
            if (args.count > 1 && !el.multiple) throw new Error(`file input does not allow multiple files: ${args.selector}`);
          }, { selector, count: resolved.length });
          if (typeof page.setInputFiles !== 'function') {
            throw new AssistantPluginError('PLUGIN_BROWSER_FILE_ATTACH_UNSUPPORTED', 'The selected browser provider does not support local file attachment.', { retryable: false });
          }
          await page.setInputFiles(selector, resolved.length === 1 ? resolved[0] : resolved);
          await delay(positiveNumber(input.args.post_action_wait_ms, DEFAULT_POST_ACTION_WAIT_MS));
          const fileNames = resolved.map((path) => basename(path));
          return finalizeInteractiveAction(input.repoRoot, current, page, target, connection, 'attach_local_file', `Attached ${resolved.length} local file(s) to ${selector}.`, {
            selector,
            fileCount: resolved.length,
            fileNames,
            ...(resolved.length === 1 ? { fileName: fileNames[0] } : {}),
          });
        });
      }
      case 'await_file_transfer': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const selector = requiredString(input.args.selector, 'selector');
        const requestedName = stringValue(input.args.suggested_name);
        const downloadDir = stateDir(input.repoRoot, 'downloads');
        mkdirSync(downloadDir, { recursive: true });
        return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
          if (connection.provider === 'macos-apple-events') {
            throw new AssistantPluginError('PLUGIN_BROWSER_NATIVE_ACTION_UNSUPPORTED', 'Native Apple Events attachment does not support download capture. Use CDP or a managed browser context.', { retryable: false });
          }
          if (!page.waitForEvent) {
            throw new AssistantPluginError('PLUGIN_BROWSER_DOWNLOAD_UNAVAILABLE', 'The selected Playwright page does not expose download events; refusing to fabricate a download artifact.', { retryable: false, details: { provider: connection.provider } });
          }
          const timeout = positiveNumber(input.args.timeout_ms, current.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
          let download: BrowserDownloadLike;
          try {
            [download] = await Promise.all([
              page.waitForEvent('download', { timeout }),
              page.click(selector, { timeout }),
            ]);
          } catch (error) {
            throw new AssistantPluginError('PLUGIN_BROWSER_DOWNLOAD_FAILED', 'Browser download did not start successfully after the authorized click.', {
              retryable: true, details: { selector, cause: error instanceof Error ? error.message : String(error) },
            });
          }
          const browserSuggestedName = download.suggestedFilename();
          if (isBlockedExecutableArtifactName(browserSuggestedName) || isBlockedExecutableArtifactName(requestedName)) {
            await download.delete?.().catch(() => undefined);
            throw new AssistantPluginError('PLUGIN_POLICY_BLOCKED', 'Downloaded executable files are not retained or auto-opened and were discarded.', {
              retryable: false, details: { suggestedFilename: browserSuggestedName },
            });
          }
          if (download.failure) {
            const failure = await download.failure();
            if (failure) {
              throw new AssistantPluginError('PLUGIN_BROWSER_DOWNLOAD_FAILED', 'Browser reported that the download failed.', { retryable: true, details: { selector, cause: failure } });
            }
          }
          const safeName = safeDownloadArtifactName(requestedName, browserSuggestedName);
          const dest = uniqueDownloadArtifactPath(downloadDir, safeName);
          try {
            await download.saveAs(dest);
          } catch (error) {
            rmSync(dest, { force: true });
            throw new AssistantPluginError('PLUGIN_BROWSER_DOWNLOAD_FAILED', 'Browser download could not be saved into Forge artifact storage.', {
              retryable: true, details: { selector, cause: error instanceof Error ? error.message : String(error) },
            });
          }
          if (!existsSync(dest)) {
            throw new AssistantPluginError('PLUGIN_BROWSER_DOWNLOAD_FAILED', 'Browser download save completed without producing an artifact; refusing false success.', { retryable: true, details: { selector } });
          }
          await delay(positiveNumber(input.args.post_action_wait_ms, DEFAULT_POST_ACTION_WAIT_MS));
          return finalizeInteractiveAction(input.repoRoot, current, page, target, connection, 'await_file_transfer', `Captured download artifact for ${selector}.`, {
            selector,
            download: {
              path: dest,
              relativePath: relative(input.repoRoot, dest),
              fileName: basename(dest),
              browserSuggestedName,
              autoOpened: false,
            },
          });
        });
      }
      default:
        throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', `browser/${input.actionId} is not supported.`, { retryable: false });
    }
  } catch (error) {
    if (error instanceof AssistantPluginError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const selector = stringValue(input.args.selector);
    throw toAssistantPluginError(error, {
      code: 'PLUGIN_ACTION_FAILED',
      message: `Browser action ${input.actionId} failed.`,
      retryable: true,
      details: {
        pluginId: BROWSER_PLUGIN_ID,
        actionId: input.actionId,
        ...(selector ? { selector, repairHint: selectorRepairHint(selector, message) } : {}),
      },
    });
  }
}

export const browserPluginAdapter = {
  pluginId: BROWSER_PLUGIN_ID,
  buildManifest: buildBrowserPluginManifest,
  executeAction: executeBrowserPluginAction,
  resolveAuthorizationContext: resolveBrowserPluginAuthorizationContext,
};
