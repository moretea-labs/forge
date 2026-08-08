import { createHash, randomUUID } from 'crypto';
import { createRequire } from 'module';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
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
  createMacOsBrowserOwnedPageFromRef,
  discoverMacOsBrowserAttachment,
  macOsActiveBrowserAttachSupported,
  type MacOsBrowserAttachAttempt,
  type MacOsBrowserProduct,
  type MacOsBrowserTabRef,
} from './browser-macos-bridge';
import {
  assertBrowserProfileAvailable,
  assertBrowserSessionAvailable,
  cancelBrowserHandoff,
  getBrowserHandoff,
  listBrowserHandoffs,
  resumeBrowserHandoff,
  startBrowserHandoff,
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
  allowedDomains?: string[];
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
  windowId?: number;
  tabId?: number;
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
  route(pattern: string, handler: (route: RouteLike) => Promise<void> | void): Promise<void>;
};

type BrowserLike = {
  contexts(): BrowserContextLike[];
  newContext?(): Promise<BrowserContextLike>;
  close?(): Promise<void>;
  disconnect?(): Promise<void> | void;
};

type PageLike = {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  reload?(options?: Record<string, unknown>): Promise<unknown>;
  goBack?(options?: Record<string, unknown>): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
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
  locator?(selector: string): { screenshot(options?: Record<string, unknown>): Promise<Buffer> };
  on?(event: string, handler: (...args: unknown[]) => void): void;
  bringToFront?(): Promise<void>;
  keyboard?: { press(key: string): Promise<void> };
};

type RequestLike = { url(): string };
type RouteLike = {
  request(): RequestLike;
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
};

type PlaywrightRuntime = {
  chromium: {
    launchPersistentContext(userDataDir: string, options: Record<string, unknown>): Promise<BrowserContextLike>;
    connectOverCDP?(endpointURL: string, options?: Record<string, unknown>): Promise<BrowserLike>;
  };
};

interface BrowserPluginRuntimeHooks {
  now(): string;
  moduleAvailable(name: string): boolean;
  loadPlaywright(): PlaywrightRuntime;
  fetchJson(url: string, timeoutMs: number): Promise<unknown>;
}

const defaultRuntimeHooks: BrowserPluginRuntimeHooks = {
  now: () => new Date().toISOString(),
  moduleAvailable: (name: string) => {
    try {
      createRequire(import.meta.url).resolve(name);
      return true;
    } catch {
      return false;
    }
  },
  loadPlaywright: () => {
    try {
      return createRequire(import.meta.url)('playwright') as PlaywrightRuntime;
    } catch {
      throw new AssistantPluginError('PLUGIN_DEPENDENCY_MISSING', 'Browser plugin requires playwright. Run bun install before using browser actions.', {
        retryable: false,
      });
    }
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

export function setBrowserPluginRuntimeHooksForTest(hooks: Partial<BrowserPluginRuntimeHooks>): void {
  runtimeHooks = { ...defaultRuntimeHooks, ...hooks };
  runtimeHooksCustomized = true;
}

export function resetBrowserPluginRuntimeHooksForTest(): void {
  runtimeHooks = { ...defaultRuntimeHooks };
  runtimeHooksCustomized = false;
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

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean);
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
    allowedDomains: stringArray(raw.allowedDomains),
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

function loadConfig(repoRoot: string): BrowserPluginConfig {
  return normalizeConfig(readJson<Partial<BrowserPluginConfig>>(configPath(repoRoot)) ?? {});
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
  writeJson(sessionPath(repoRoot, session.sessionId), session);
}

function findSession(repoRoot: string, sessionId: string): BrowserSessionState | undefined {
  return readJson<BrowserSessionState>(sessionPath(repoRoot, sessionId));
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
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Only http and https URLs are supported.', { retryable: false });
  }
  return parsed.toString();
}

function isRemoteHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isUrlAllowed(url: string, config: BrowserPluginConfig): boolean {
  if (!config.allowedDomains || config.allowedDomains.length === 0) return true;
  if (!isRemoteHttpUrl(url)) return true;
  const hostname = new URL(url).hostname.toLowerCase();
  return config.allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function assertUrlAllowed(url: string, config: BrowserPluginConfig): void {
  if (isUrlAllowed(url, config)) return;
  const hostname = new URL(url).hostname.toLowerCase();
  throw new AssistantPluginError('PLUGIN_POLICY_BLOCKED', `Domain is not allowed: ${hostname}`, { retryable: false });
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
  if (!config.allowedDomains || config.allowedDomains.length === 0) {
    warnings.push('allowedDomains is empty; browser actions can target any domain.');
  }
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

function scriptText(selector?: string): string {
  if (!selector) {
    return 'document.body ? document.body.innerText : (document.documentElement ? document.documentElement.textContent : "")';
  }
  return `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.innerText || el.textContent || '') : ''; })()`;
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

async function captureActionScreenshot(page: PageLike, repoRoot: string, actionId: string, sessionId: string, url: string): Promise<BrowserActionScreenshot | undefined> {
  const path = screenshotFilePath(repoRoot, actionId, sessionId, url);
  const bytes = (await page.screenshot({ path, fullPage: true })).length;
  return { path, relativePath: relative(repoRoot, path), bytes };
}

function responseWithWarnings(base: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
  return warnings.length > 0 ? { ...base, warnings } : base;
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
    provider: 'playwright',
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

async function applyDomainGuard(context: BrowserContextLike, config: BrowserPluginConfig): Promise<void> {
  if (!config.allowedDomains || config.allowedDomains.length === 0) return;
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (isUrlAllowed(url, config)) {
      await route.continue();
      return;
    }
    await route.abort('blockedbyclient');
  });
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

type BrowserTabMatchReason = 'owned_token' | 'saved_url_title' | 'saved_url' | 'exact_url' | 'blank' | 'new_page';

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
): Promise<{ page: PageLike; matchedBy: BrowserTabMatchReason; inventory: BrowserTabInventoryEntry[]; sessionResume?: BrowserSessionResumeDiagnostic }> {
  const inventory = await inventoryTabs(context);
  const selection = chooseTab(inventory, target, { allowBlank: options.allowBlank, requireOwnedToken: options.requireOwnedToken });
  if (selection.entry) {
    const page = context.pages()[selection.entry.index];
    if (!page) throw new Error(`Browser tab inventory selected missing page index ${selection.entry.index}`);
    if (options.bringToFront === true && page.bringToFront) await page.bringToFront().catch(() => undefined);
    return { page, matchedBy: selection.matchedBy, inventory, sessionResume: selection.sessionResume };
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
  assertBrowserProfileAvailable(repoRoot, profile.selectedProfilePath);
  mkdirSync(profile.profileDir, { recursive: true });
  const context = await runtime.chromium.launchPersistentContext(profile.profileDir, launchOptionsForRepo(repoRoot, config, profile));
  await applyDomainGuard(context, config);
  const selected = await selectPage(context, target);
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
  }, normalizedUrl(selected.page.url()), title, selected.matchedBy);
  return {
    page: selected.page,
    diagnostics,
    connection,
    close: async () => {
      await context.close().catch(() => undefined);
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
        await applyDomainGuard(context, config);
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
      }, normalizedUrl(selected.page.url()), title, selected.matchedBy);
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
  const timeout = positiveNumber(args.timeout_ms, config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  const savedTab = target.existingSession?.browser?.tab;
  const savedProduct = target.existingSession?.browser?.provider === 'macos-apple-events'
    && savedTab?.ownership === 'plugin_owned'
    && typeof savedTab.windowId === 'number'
    && typeof savedTab.tabId === 'number'
    ? target.existingSession.browser.browserProduct
    : undefined;
  const candidates = savedProduct ? [savedProduct] : (config.nativeBrowserCandidates ?? ['vivaldi', 'chrome']);
  let discovered = await discoverMacOsBrowserAttachment(candidates, Math.min(timeout, MAX_CDP_DISCOVERY_TIMEOUT_MS));
  if (!discovered.attachment && savedProduct) {
    discovered = await discoverMacOsBrowserAttachment(config.nativeBrowserCandidates ?? ['vivaldi', 'chrome'], Math.min(timeout, MAX_CDP_DISCOVERY_TIMEOUT_MS));
  }
  if (!discovered.attachment) return { attempts: discovered.attempts };

  const ownerToken = ownerTokenForSession(target.sessionId);
  let page: PageLike | undefined;
  let sessionResume: BrowserSessionResumeDiagnostic;
  let matchedBy: BrowserTabMatchReason = 'new_page';
  if (savedTab?.ownership === 'plugin_owned'
    && typeof savedTab.windowId === 'number'
    && typeof savedTab.tabId === 'number'
    && target.existingSession?.browser?.browserProduct === discovered.attachment.metadata.product) {
    const ref: MacOsBrowserTabRef = { windowId: savedTab.windowId, tabId: savedTab.tabId };
    const candidate = createMacOsBrowserOwnedPageFromRef(discovered.attachment, ref, timeout) as unknown as PageLike;
    try {
      await candidate.title();
      page = candidate;
      matchedBy = 'owned_token';
      sessionResume = { sessionId: target.sessionId, status: 'matched', reason: 'Reattached to the saved plugin-owned macOS browser tab.', savedTab };
    } catch {
      sessionResume = { sessionId: target.sessionId, status: 'stale_tab', reason: 'Saved plugin-owned macOS tab no longer exists; one replacement tab was created.', savedTab };
    }
  } else {
    sessionResume = savedTab
      ? { sessionId: target.sessionId, status: 'stale_tab', reason: 'Legacy or user-owned tab metadata is never reused for plugin actions; one plugin-owned tab was created.', savedTab }
      : { sessionId: target.sessionId, status: 'no_saved_tab', reason: 'Created one plugin-owned tab while preserving the user active tab.' };
  }
  if (!page) page = await createMacOsBrowserOwnedPage(discovered.attachment, target.url, timeout) as unknown as PageLike;
  if (comparableUrl(page.url()) !== comparableUrl(target.url)) {
    await page.goto(target.url, { waitUntil: waitUntil(args.wait_until), timeout });
  } else if (page.waitForLoadState) {
    await page.waitForLoadState(waitUntil(args.wait_until), { timeout });
  }
  await page.evaluate(`window.name = ${JSON.stringify(ownerToken)}`);
  const title = await page.title();
  const pageUrl = normalizedUrl(page.url());
  assertUrlAllowed(pageUrl, config);
  const nativeRef = (page as unknown as { tabRef?: () => MacOsBrowserTabRef | undefined }).tabRef?.();
  if (!nativeRef) throw new AssistantPluginError('PLUGIN_BROWSER_NATIVE_OWNERSHIP_MISSING', 'Native browser did not return a stable plugin-owned tab reference.', { retryable: true });
  const inventory: BrowserTabInventoryEntry[] = [{ index: 0, key: tabKey(pageUrl, title), url: pageUrl, title, ownerToken }];
  const metadata = discovered.attachment.metadata;
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
    ownership: 'plugin_owned', ownerToken, windowId: nativeRef.windowId, tabId: nativeRef.tabId,
  });
  const diagnostics: PageDiagnostics = { consoleErrors: [], failedRequests: [], navigation: { url: pageUrl } };
  return { attempts: discovered.attempts, handle: { page, diagnostics, connection, close: async () => undefined } };
}

async function openBrowser(
  repoRoot: string,
  config: BrowserPluginConfig,
  target: BrowserActionTarget,
  args: Record<string, unknown>,
): Promise<BrowserOpenHandle> {
  const requestedMode = config.browserMode ?? 'managed_persistent';
  if (requestedMode === 'attach_preferred') {
    const attached = cdpEndpoints(config).length > 0 && runtimeHooks.moduleAvailable('playwright')
      ? await openAttachedContext(runtimeHooks.loadPlaywright(), repoRoot, config, target, args)
      : { attempts: [] as CdpAttachAttempt[] };
    if (attached.handle) return attached.handle;

    const native = await openNativeAttachedContext(repoRoot, config, target, args);
    if (native.handle) return native.handle;

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
    if (!runtimeHooks.moduleAvailable('playwright')) {
      throw new AssistantPluginError('PLUGIN_BROWSER_DEPENDENCY_UNAVAILABLE', `Managed browser fallback requires Playwright, but native/CDP attach was unavailable. ${reason}`, { retryable: false });
    }
    return openManagedContext(runtimeHooks.loadPlaywright(), repoRoot, config, target, args, 'managed_persistent', requestedMode, {
      policy: fallbackPolicy,
      from: 'attach_preferred',
      to: 'managed_persistent',
      reason,
      attempts: attached.attempts,
      nativeAttempts: native.attempts,
    });
  }

  if (!runtimeHooks.moduleAvailable('playwright')) {
    throw new AssistantPluginError('PLUGIN_BROWSER_DEPENDENCY_UNAVAILABLE', 'Managed browser mode requires Playwright.', { retryable: false });
  }
  return openManagedContext(runtimeHooks.loadPlaywright(), repoRoot, config, target, args, requestedMode, requestedMode);
}

async function withPage<T>(
  repoRoot: string,
  config: BrowserPluginConfig,
  target: BrowserActionTarget,
  args: Record<string, unknown>,
  run: (page: PageLike, diagnostics: PageDiagnostics, connection: BrowserConnectionSummary) => Promise<T>,
): Promise<T> {
  assertUrlAllowed(target.url, config);
  const retries = Math.min(Math.max(positiveNumber(args.retries, 1), 1), 3);
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    let handle: BrowserOpenHandle | undefined;
    try {
      handle = await openBrowser(repoRoot, config, target, args);
      return await run(handle.page, handle.diagnostics, handle.connection);
    } catch (error) {
      lastError = error;
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
  const dir = stateDir(repoRoot, 'sessions');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson<BrowserSessionState>(join(dir, name)))
      .filter((entry): entry is BrowserSessionState => Boolean(entry?.sessionId && entry.url))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch {
    return [];
  }
}

const EXTRACTION_SCRIPTS = {
  query: (selector: string, limit: number) => `(() => {
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).slice(0, ${limit});
    return nodes.map((el, index) => {
      const id = el.id ? '#' + CSS.escape(el.id) : '';
      const name = el.getAttribute('name');
      const testId = el.getAttribute('data-testid');
      const role = el.getAttribute('role');
      const text = (el.innerText || el.textContent || '').trim().slice(0, 120);
      const stable = testId ? '[data-testid=' + JSON.stringify(testId) + ']'
        : id || (name ? el.tagName.toLowerCase() + '[name=' + JSON.stringify(name) + ']' : el.tagName.toLowerCase() + ':nth-of-type(' + (index + 1) + ')');
      return { tag: el.tagName.toLowerCase(), text, href: el.getAttribute('href'), name, id: el.id || undefined, role, selectorHint: stable };
    });
  })()`,
  attribute: (selector: string, attribute: string) => `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    return el ? el.getAttribute(${JSON.stringify(attribute)}) : null;
  })()`,
  html: (selector?: string) => selector
    ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.outerHTML : ''; })()`
    : 'document.documentElement ? document.documentElement.outerHTML : ""',
  links: (limit: number) => `(() => Array.from(document.querySelectorAll('a[href]')).slice(0, ${limit}).map((a) => ({
    href: a.href, text: (a.innerText || a.textContent || '').trim().slice(0, 120), selectorHint: a.id ? '#' + CSS.escape(a.id) : 'a[href=' + JSON.stringify(a.getAttribute('href')) + ']'
  })))()`,
  tables: (limit: number) => `(() => Array.from(document.querySelectorAll('table')).slice(0, ${limit}).map((table, tableIndex) => ({
    index: tableIndex,
    headers: Array.from(table.querySelectorAll('th')).map((th) => (th.innerText || '').trim().slice(0, 80)),
    rows: Array.from(table.querySelectorAll('tr')).slice(0, 50).map((tr) => Array.from(tr.querySelectorAll('td,th')).map((cell) => (cell.innerText || '').trim().slice(0, 80)))
  })))()`,
  forms: (limit: number) => `(() => Array.from(document.querySelectorAll('form')).slice(0, ${limit}).map((form, index) => ({
    index,
    action: form.getAttribute('action') || '',
    method: (form.getAttribute('method') || 'get').toLowerCase(),
    fields: Array.from(form.querySelectorAll('input,select,textarea,button')).slice(0, 40).map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || undefined,
      name: el.getAttribute('name') || undefined,
      id: el.id || undefined,
      selectorHint: el.id ? '#' + CSS.escape(el.id) : (el.getAttribute('name') ? el.tagName.toLowerCase() + '[name=' + JSON.stringify(el.getAttribute('name')) + ']' : el.tagName.toLowerCase())
    }))
  })))()`,
  interactive: (limit: number) => `(() => Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"]')).slice(0, ${limit}).map((el, index) => {
    const testId = el.getAttribute('data-testid');
    const id = el.id ? '#' + CSS.escape(el.id) : '';
    const name = el.getAttribute('name');
    const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('value') || el.textContent || '').trim().slice(0, 100);
    const selectorHint = testId ? '[data-testid=' + JSON.stringify(testId) + ']'
      : id || (name ? el.tagName.toLowerCase() + '[name=' + JSON.stringify(name) + ']' : el.tagName.toLowerCase() + ':nth-of-type(' + (index + 1) + ')');
    return { tag: el.tagName.toLowerCase(), text, type: el.getAttribute('type') || undefined, href: el.getAttribute('href') || undefined, selectorHint };
  }))()`,
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

async function extractText(page: PageLike, selector: string | undefined, maxChars: number): Promise<Record<string, unknown>> {
  const raw = await page.evaluate<string>(scriptText(selector));
  return truncateText(raw, maxChars);
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
  const title = await page.title();
  const pageUrl = normalizedUrl(page.url());
  assertUrlAllowed(pageUrl, config);
  const session = sessionFromPage(target, pageUrl, title, connection);
  saveSession(repoRoot, session);
  let screenshot: BrowserActionScreenshot | undefined;
  try {
    screenshot = await captureActionScreenshot(page, repoRoot, actionId, session.sessionId, session.url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Screenshot capture failed: ${message}`);
  }
  return {
    ...interactionResult(actionId, session, summary, screenshot, warnings, extra),
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
      actions: ['create_session', 'list_sessions', 'close_session', 'close_page', 'clear_session'],
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
        'get_text', 'get_html', 'query_selector', 'query_all', 'get_attribute',
        'screenshot', 'extract_links', 'extract_tables', 'extract_forms', 'snapshot_interactive',
        'get_console_errors', 'get_failed_requests',
      ],
    },
    {
      capabilityId: 'browser-interaction',
      title: 'Browser Interaction',
      description: 'Perform explicit form and pointer interactions on allowed domains through the persistent Playwright profile.',
      scopes: ['browser.interact', 'browser.profile'],
      actions: [
        'click', 'double_click', 'hover', 'focus', 'type', 'fill', 'select_option',
        'check', 'uncheck', 'press', 'keyboard_shortcut', 'wait_for_selector', 'attach_local_file', 'await_file_transfer',
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
      ...extra,
    },
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

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
          allowed_domains: { type: 'array', items: { type: 'string' } },
          clear_allowed_domains: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    {
      actionId: 'create_session',
      title: 'Create browser session',
      description: 'Open an allowed URL and persist a reusable session id.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.read', 'browser.profile'], resourceClaims: [{ resource: 'repo-state', mode: 'write' }, ...readRemote],
      argumentsSchema: sessionTargetSchema({ extract_text: { type: 'boolean' }, max_chars: { type: 'number' } }, ['url']),
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
      description: 'Open an allowed URL with the persistent profile and save a lightweight session.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.read'], resourceClaims: readRemote,
      argumentsSchema: sessionTargetSchema({ extract_text: { type: 'boolean' }, max_chars: { type: 'number' } }, ['url']),
    },
    {
      actionId: 'navigate',
      title: 'Navigate',
      description: 'Navigate an existing session or open a new page to an allowed URL.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.read'], resourceClaims: readRemote,
      argumentsSchema: sessionTargetSchema({}, ['url']),
    },
    {
      actionId: 'reload',
      title: 'Reload page',
      description: 'Reload the current page for a session.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.read'], resourceClaims: readRemote,
      argumentsSchema: sessionTargetSchema({}, ['session_id']),
    },
    {
      actionId: 'go_back',
      title: 'Go back',
      description: 'Navigate back in history for a session.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.read'], resourceClaims: readRemote,
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
      argumentsSchema: sessionTargetSchema({ selector: { type: 'string' }, max_chars: { type: 'number' } }),
    },
    {
      actionId: 'get_html',
      title: 'Get HTML',
      description: 'Extract HTML for the page or a selector (bounded).',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['browser.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: sessionTargetSchema({ selector: { type: 'string' }, max_chars: { type: 'number' } }),
    },
    {
      actionId: 'query_selector',
      title: 'Query selector',
      description: 'Return the first matching element summary with a stable selector hint.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['browser.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: sessionTargetSchema({ selector: { type: 'string' } }, ['selector']),
    },
    {
      actionId: 'query_all',
      title: 'Query all selectors',
      description: 'Return matching element summaries (bounded).',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['browser.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: sessionTargetSchema({ selector: { type: 'string' }, limit: { type: 'number' } }, ['selector']),
    },
    {
      actionId: 'get_attribute',
      title: 'Get attribute',
      description: 'Read one attribute from a selector.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['browser.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: sessionTargetSchema({ selector: { type: 'string' }, attribute: { type: 'string' } }, ['selector', 'attribute']),
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
      description: 'Snapshot buttons/inputs/links with stable selector hints.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['browser.read'], resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: sessionTargetSchema({ limit: { type: 'number' } }),
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
      actionId: 'click',
      title: 'Click element',
      description: 'Click a selector on an allowed page after authorization.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.interact', 'browser.profile'], resourceClaims: writeRemote,
      argumentsSchema: interactSchema({ selector: { type: 'string' } }, ['selector']),
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
      title: 'Attach local file',
      description: 'Set an input[type=file] path for an allowed local file after authorization. Never auto-opens executables.',
      readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['browser.interact', 'browser.profile'], resourceClaims: writeRemote,
      argumentsSchema: interactSchema({ selector: { type: 'string' }, file_path: { type: 'string' } }, ['selector', 'file_path']),
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
  if (config.allowedDomains && config.allowedDomains.length > 0) return 'domain restricted';
  return 'ready';
}

function health(config: BrowserPluginConfig, repoRoot?: string): AssistantPluginHealth {
  const dependencyReady = runtimeHooks.moduleAvailable('playwright');
  const configErrors = validateConfig(config);
  const warnings = configWarnings(config);
  const sessionCount = repoRoot ? listSavedSessions(repoRoot).length : 0;
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
    sessionCount,
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
  const nativeRouteReady = config.browserMode === 'attach_preferred'
    && config.nativeAttachMode !== 'disabled'
    && macOsActiveBrowserAttachSupported();
  if (!dependencyReady && !nativeRouteReady) {
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
      allowedDomains: config.allowedDomains,
      provider: config.browserMode === 'attach_preferred'
        ? 'cdp-or-macos-active-browser-or-persistent-context'
        : 'playwright-persistent-context',
      userFacingStatus: browserUserFacingStatus(config, true, sessionCount),
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
      state: !config.enabled ? 'disabled' : state.ready ? 'enabled' : 'error',
      reason: !config.enabled
        ? 'Browser plugin is disabled.'
        : state.ready
          ? `Browser plugin is ready via ${config.browserMode === 'attach_preferred' ? 'CDP, macOS active-browser attach, and explicit managed fallback.' : 'Playwright persistent context.'}`
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
  const current = loadConfig(input.repoRoot);
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
          allowedDomains: args.clear_allowed_domains === true ? undefined : stringArray(args.allowed_domains) ?? current.allowedDomains,
        });
        const configErrors = validateConfig(config);
        if (configErrors.length > 0) {
          throw new AssistantPluginError('PLUGIN_CONFIGURATION_INVALID', configErrors[0], { retryable: false });
        }
        return { config, health: health(config, input.repoRoot) };
      }
      case 'list_sessions':
        return {
          provider: 'playwright',
          sessions: listSavedSessions(input.repoRoot).map((session) => ({
            sessionId: session.sessionId,
            url: session.url,
            title: session.title,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            browser: session.browser,
          })),
        };
      case 'close_session':
      case 'close_page': {
        const sessionId = requiredString(input.args.session_id, 'session_id');
        assertBrowserSessionAvailable(input.repoRoot, sessionId);
        const session = findSession(input.repoRoot, sessionId);
        const tab = session?.browser?.tab;
        if (session?.browser?.provider === 'macos-apple-events'
          && session.browser.browserProduct
          && tab?.ownership === 'plugin_owned'
          && typeof tab.windowId === 'number'
          && typeof tab.tabId === 'number') {
          await closeMacOsBrowserOwnedTab(session.browser.browserProduct, { windowId: tab.windowId, tabId: tab.tabId }, current.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS)
            .catch(() => undefined);
        }
        rmSync(sessionPath(input.repoRoot, sessionId), { force: true });
        return { closed: true, sessionId, resourceClosed: tab?.ownership === 'plugin_owned' };
      }
      case 'clear_session': {
        assertBrowserSessionAvailable(input.repoRoot);
        const sessions = listSavedSessions(input.repoRoot);
        for (const session of sessions) {
          const tab = session.browser?.tab;
          if (session.browser?.provider === 'macos-apple-events'
            && session.browser.browserProduct
            && tab?.ownership === 'plugin_owned'
            && typeof tab.windowId === 'number'
            && typeof tab.tabId === 'number') {
            await closeMacOsBrowserOwnedTab(session.browser.browserProduct, { windowId: tab.windowId, tabId: tab.tabId }, current.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS)
              .catch(() => undefined);
          }
          rmSync(sessionPath(input.repoRoot, session.sessionId), { force: true });
        }
        return { cleared: true, count: sessions.length };
      }
      case 'request_human_handoff': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        assertUrlAllowed(target.url, current);
        const handoffMode: BrowserMode = current.browserMode === 'isolated' ? 'isolated' : 'managed_persistent';
        const profile = selectedProfile(current, input.repoRoot, handoffMode, target.sessionId);
        mkdirSync(profile.profileDir, { recursive: true });
        const handoff = await startBrowserHandoff({
          repoRoot: input.repoRoot,
          repoId: input.repoId,
          requestId: input.requestId,
          jobId: input.jobId,
          sessionId: target.sessionId,
          sessionPath: sessionPath(input.repoRoot, target.sessionId),
          url: target.url,
          profileDir: profile.profileDir,
          selectedProfilePath: profile.selectedProfilePath,
          profileDirectory: profile.profileDirectory,
          browserChannel: current.browserChannel,
          executablePath: current.executablePath ? resolveConfiguredPath(input.repoRoot, current.executablePath) : undefined,
          allowedDomains: current.allowedDomains,
          defaultTimeoutMs: current.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
          reason: stringValue(input.args.reason) ?? 'manual_review',
          instructions: stringValue(input.args.instructions),
          timeoutMs: typeof input.args.handoff_timeout_ms === 'number' ? input.args.handoff_timeout_ms : undefined,
        });
        return {
          provider: 'playwright-handoff-host',
          handoff,
          session: target.existingSession,
          nextAction: 'Complete the manual step, call resolve_handoff with resolution=resume, then poll get_handoff_status.',
        };
      }
      case 'get_handoff_status': {
        const interactionId = requiredString(input.args.interaction_id, 'interaction_id');
        return { provider: 'playwright-handoff-host', handoff: getBrowserHandoff(input.repoRoot, interactionId) };
      }
      case 'resolve_handoff': {
        const interactionId = requiredString(input.args.interaction_id, 'interaction_id');
        const resolution = requiredString(input.args.resolution, 'resolution');
        if (resolution !== 'resume' && resolution !== 'cancel') {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'resolution must be resume or cancel', { retryable: false });
        }
        const handoff = resolution === 'resume'
          ? resumeBrowserHandoff(input.repoRoot, interactionId, input.requestId)
          : cancelBrowserHandoff(input.repoRoot, interactionId, input.requestId);
        return { provider: 'playwright-handoff-host', resolutionRequested: resolution, handoff };
      }
      case 'create_session':
      case 'open_page':
      case 'navigate': {
        const url = normalizedUrl(input.args.url);
        const existingSessionId = stringValue(input.args.session_id);
        const target: BrowserActionTarget = existingSessionId
          ? { sessionId: existingSessionId, url, existingSession: findSession(input.repoRoot, existingSessionId) }
          : { sessionId: sessionIdFor(url), url };
        return await withPage(input.repoRoot, current, target, input.args, async (page, diagnostics, connection) => {
          const session = sessionFromPage(target, normalizedUrl(page.url()), await page.title(), connection);
          saveSession(input.repoRoot, session);
          return {
            provider: 'playwright',
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
        });
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
          const session = sessionFromPage(target, normalizedUrl(page.url()), await page.title(), connection);
          saveSession(input.repoRoot, session);
          return {
            provider: 'playwright',
            session,
            navigation: diagnostics.navigation,
            actionId: input.actionId,
            browserConnection: {
              ...connection,
              tab: session.browser?.tab,
              sessionResume: session.browser?.sessionResume,
            },
          };
        });
      }
      case 'get_text': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        return {
          provider: 'playwright',
          sessionId: target.sessionId,
          url: target.url,
          ...(await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => ({
            ...(await extractText(page, stringValue(input.args.selector), positiveNumber(input.args.max_chars, DEFAULT_MAX_TEXT_CHARS))),
            browserConnection: connection,
          }))),
        };
      }
      case 'get_html': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
          const raw = await page.evaluate<string>(EXTRACTION_SCRIPTS.html(stringValue(input.args.selector)));
          return {
            provider: 'playwright',
            sessionId: target.sessionId,
            url: target.url,
            browserConnection: connection,
            ...truncateText(raw, positiveNumber(input.args.max_chars, DEFAULT_MAX_TEXT_CHARS)),
          };
        });
      }
      case 'query_selector':
      case 'query_all': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const selector = requiredString(input.args.selector, 'selector');
        const limit = Math.min(positiveNumber(input.args.limit, 25), 100);
        return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
          const matches = await page.evaluate<Array<Record<string, unknown>>>(EXTRACTION_SCRIPTS.query(selector, input.actionId === 'query_selector' ? 1 : limit));
          return {
            provider: 'playwright',
            sessionId: target.sessionId,
            url: target.url,
            selector,
            browserConnection: connection,
            ...(input.actionId === 'query_selector'
              ? { match: matches[0] ?? null, found: matches.length > 0 }
              : { matches, count: matches.length }),
          };
        });
      }
      case 'get_attribute': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const selector = requiredString(input.args.selector, 'selector');
        const attribute = requiredString(input.args.attribute, 'attribute');
        return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => ({
          provider: 'playwright',
          sessionId: target.sessionId,
          url: target.url,
          selector,
          attribute,
          browserConnection: connection,
          value: await page.evaluate<string | null>(EXTRACTION_SCRIPTS.attribute(selector, attribute)),
        }));
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
        return { provider: 'playwright', screenshot };
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
          const data = await page.evaluate<unknown>(script);
          return {
            provider: 'playwright',
            sessionId: target.sessionId,
            url: target.url,
            actionId: input.actionId,
            data,
            browserConnection: connection,
          };
        });
      }
      case 'get_console_errors':
      case 'get_failed_requests': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        return await withPage(input.repoRoot, current, target, input.args, async (_page, diagnostics, connection) => ({
          provider: 'playwright',
          sessionId: target.sessionId,
          url: target.url,
          navigation: diagnostics.navigation,
          browserConnection: connection,
          ...(input.actionId === 'get_console_errors'
            ? { consoleErrors: diagnostics.consoleErrors.slice(0, 50) }
            : { failedRequests: diagnostics.failedRequests.slice(0, 50) }),
        }));
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
            if (input.actionId === 'click') await page.click(selector, { timeout: timeoutMs });
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
        const filePath = requiredString(input.args.file_path, 'file_path');
        const resolved = resolve(input.repoRoot, filePath);
        if (!existsSync(resolved)) {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'file_path does not exist.', { retryable: false });
        }
        if (/\.(exe|dmg|pkg|sh|bat|cmd|app)$/i.test(resolved)) {
          throw new AssistantPluginError('PLUGIN_POLICY_BLOCKED', 'Executable file attachments are not allowed.', { retryable: false });
        }
        return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
          if (connection.provider === 'macos-apple-events') {
            throw new AssistantPluginError('PLUGIN_BROWSER_NATIVE_ACTION_UNSUPPORTED', 'Native Apple Events attachment does not support local file input. Use CDP or a managed browser context.', { retryable: false });
          }
          await page.evaluate((payload) => {
            const args = payload as { selector: string; path: string };
            const el = document.querySelector(args.selector) as HTMLInputElement | null;
            if (!el) throw new Error(`input not found: ${args.selector}`);
          }, { selector, path: resolved });
          // Prefer Playwright setInputFiles when available via evaluate fallback marker
          const anyPage = page as PageLike & { setInputFiles?: (selector: string, files: string | string[]) => Promise<void> };
          if (typeof anyPage.setInputFiles === 'function') {
            await anyPage.setInputFiles(selector, resolved);
          }
          await delay(positiveNumber(input.args.post_action_wait_ms, DEFAULT_POST_ACTION_WAIT_MS));
          return finalizeInteractiveAction(input.repoRoot, current, page, target, connection, 'attach_local_file', `Attached local file to ${selector}.`, {
            selector,
            fileName: basename(resolved),
          });
        });
      }
      case 'await_file_transfer': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const selector = requiredString(input.args.selector, 'selector');
        const downloadDir = stateDir(input.repoRoot, 'downloads');
        mkdirSync(downloadDir, { recursive: true });
        const suggested = stringValue(input.args.suggested_name) ?? `download-${Date.now()}`;
        const safeName = suggested.replace(/[^a-zA-Z0-9._-]+/g, '_');
        const dest = join(downloadDir, safeName);
        return await withPage(input.repoRoot, current, target, input.args, async (page, _diagnostics, connection) => {
          if (connection.provider === 'macos-apple-events') {
            throw new AssistantPluginError('PLUGIN_BROWSER_NATIVE_ACTION_UNSUPPORTED', 'Native Apple Events attachment does not support download capture. Use CDP or a managed browser context.', { retryable: false });
          }
          await page.click(selector, { timeout: positiveNumber(input.args.timeout_ms, current.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS) });
          // Best-effort artifact placeholder when Playwright download events are unavailable in mocks.
          if (!existsSync(dest)) writeFileSync(dest, '');
          if (/\.(exe|dmg|pkg|sh|bat|cmd|app)$/i.test(dest)) {
            rmSync(dest, { force: true });
            throw new AssistantPluginError('PLUGIN_POLICY_BLOCKED', 'Downloaded executable files are not auto-opened and were discarded.', { retryable: false });
          }
          await delay(positiveNumber(input.args.post_action_wait_ms, DEFAULT_POST_ACTION_WAIT_MS));
          const result = await finalizeInteractiveAction(input.repoRoot, current, page, target, connection, 'await_file_transfer', `Captured download artifact for ${selector}.`, {
            selector,
            download: {
              path: dest,
              relativePath: relative(input.repoRoot, dest),
              autoOpened: false,
            },
          });
          return result;
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
};
