import { execFile } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, extname } from 'path';
import {
  callBrowserAutomationBroker,
  captureBrowserAutomationRegion,
  type BrowserAutomationBrokerAction,
  type BrowserAutomationTrustedInput,
} from './browser-automation-service';
import { AssistantPluginError } from './errors';
import type { BrowserNativeAttachAttempt, BrowserNativeProduct } from './browser-session-types';

const RECORD_SEPARATOR = String.fromCharCode(30);
const DEFAULT_NATIVE_TIMEOUT_MS = 5_000;
const MAX_NATIVE_OUTPUT_BYTES = 1_048_576;

export type MacOsBrowserProduct = BrowserNativeProduct;

interface MacOsBrowserDefinition {
  product: MacOsBrowserProduct;
  appName: string;
  bundleId: string;
  processName: string;
  appPaths: string[];
}

export interface MacOsBrowserTabRef {
  windowId: string;
  tabId: string;
}

export interface MacOsBrowserCreateTabNavigationProvenance {
  provenanceVersion: 1;
  requestedUrl: string;
  assignmentAccepted: true;
  acceptedBy?: string;
  observedUrlAfterAssignment?: string;
}

export interface MacOsBrowserCreateTabEvidence {
  ref: MacOsBrowserTabRef;
  refSource: 'structured' | 'legacy_value';
  navigation?: MacOsBrowserCreateTabNavigationProvenance;
}

export interface MacOsBrowserMetadata {
  product: MacOsBrowserProduct;
  appName: string;
  bundleId: string;
  frontmost: boolean;
  url: string;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  windowId?: string;
  tabId?: string;
  active?: boolean;
  loading?: boolean;
}

export interface MacOsBrowserTabInventoryEntry {
  windowId: string;
  tabId: string;
  url: string;
  title: string;
  active: boolean;
}

export interface MacOsBrowserTabInventory {
  product: MacOsBrowserProduct;
  tabs: MacOsBrowserTabInventoryEntry[];
  truncated: boolean;
}

export type MacOsBrowserAttachAttempt = BrowserNativeAttachAttempt;

export interface MacOsBrowserAttachment {
  metadata: MacOsBrowserMetadata;
  attempts: MacOsBrowserAttachAttempt[];
}

export interface MacOsBrowserAttachObservation {
  checkedAt: string;
  ready: boolean;
  selectedProduct?: MacOsBrowserProduct;
  attempts: MacOsBrowserAttachAttempt[];
}

export function macOsBrowserJavaScriptAutomationDisabled(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /Executing JavaScript through AppleScript is turned off|allow JavaScript from Apple Events/i.test(message);
}

interface MacOsBrowserRuntimeHooks {
  platform: NodeJS.Platform;
  appExists(path: string): boolean;
  processRunning(processName: string, timeoutMs: number): Promise<boolean>;
  // Test-only escape hatches. Production intentionally leaves these undefined so
  // Apple Events and screen capture are attributed to the stable helper process.
  runAppleScript?: (script: string, args: string[], timeoutMs: number) => Promise<string>;
  tabInventory?: (product: MacOsBrowserProduct, timeoutMs: number) => Promise<MacOsBrowserTabInventory>;
  captureRegion?: (region: { x: number; y: number; width: number; height: number }, path: string, timeoutMs: number) => Promise<Buffer>;
  trustedInput?: (request: Extract<BrowserAutomationBrokerAction, { action: 'trusted_input' }>, timeoutMs: number) => Promise<void>;
}

function execFileText(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: MAX_NATIVE_OUTPUT_BYTES,
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
      },
    }, (error, stdout, stderr) => {
      if (error) {
        const diagnostic = String(stderr || error.message).trim().slice(-2_000);
        reject(new Error(diagnostic || error.message));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

const defaultRuntimeHooks: MacOsBrowserRuntimeHooks = {
  platform: process.platform,
  appExists: (path) => existsSync(path),
  processRunning: async (processName, timeoutMs) => {
    try {
      await execFileText('/usr/bin/pgrep', ['-x', processName], timeoutMs);
      return true;
    } catch {
      return false;
    }
  },
};

export function parseMacOsBrowserCreateTabBrokerResult(result: Record<string, unknown>): MacOsBrowserCreateTabEvidence {
  const structuredRef = result.ref;
  let ref: MacOsBrowserTabRef;
  let refSource: MacOsBrowserCreateTabEvidence['refSource'];
  if (structuredRef !== undefined) {
    if (!structuredRef || typeof structuredRef !== 'object' || Array.isArray(structuredRef)) {
      throw new AssistantPluginError('PLUGIN_MACOS_CAPABILITY_BROKER_PROTOCOL_ERROR', 'Stable Forge macOS capability broker returned an invalid create-tab ref.', { retryable: true });
    }
    const record = structuredRef as Record<string, unknown>;
    if (typeof record.windowId !== 'string' || !record.windowId.trim() || typeof record.tabId !== 'string' || !record.tabId.trim()) {
      throw new AssistantPluginError('PLUGIN_MACOS_CAPABILITY_BROKER_PROTOCOL_ERROR', 'Stable Forge macOS capability broker returned an incomplete create-tab ref.', { retryable: true });
    }
    ref = { windowId: record.windowId, tabId: record.tabId };
    refSource = 'structured';
    if (typeof result.value === 'string') {
      const legacyParts = result.value.split(RECORD_SEPARATOR);
      if (legacyParts.length >= 2) {
        const legacyRef = {
          windowId: parseBrowserId(legacyParts[0] ?? '', 'window id'),
          tabId: parseBrowserId(legacyParts[1] ?? '', 'tab id'),
        };
        if (legacyRef.windowId !== ref.windowId || legacyRef.tabId !== ref.tabId) {
          throw new AssistantPluginError('PLUGIN_MACOS_CAPABILITY_BROKER_PROTOCOL_ERROR', 'Stable Forge macOS capability broker returned conflicting structured and legacy create-tab refs.', { retryable: true });
        }
      }
    }
  } else {
    if (typeof result.value !== 'string') {
      throw new AssistantPluginError('PLUGIN_MACOS_CAPABILITY_BROKER_PROTOCOL_ERROR', 'Stable Forge macOS capability broker returned no create-tab ref.', { retryable: true });
    }
    const parts = result.value.split(RECORD_SEPARATOR);
    if (parts.length < 2) throw new AssistantPluginError('PLUGIN_MACOS_CAPABILITY_BROKER_PROTOCOL_ERROR', 'Stable Forge macOS capability broker returned incomplete legacy create-tab metadata.', { retryable: true });
    ref = { windowId: parseBrowserId(parts[0] ?? '', 'window id'), tabId: parseBrowserId(parts[1] ?? '', 'tab id') };
    refSource = 'legacy_value';
  }

  const navigationValue = result.navigation;
  if (navigationValue === undefined) return { ref, refSource };
  if (!navigationValue || typeof navigationValue !== 'object' || Array.isArray(navigationValue)) {
    throw new AssistantPluginError('PLUGIN_MACOS_CAPABILITY_BROKER_PROTOCOL_ERROR', 'Stable Forge macOS capability broker returned invalid create-tab navigation provenance.', { retryable: true });
  }
  const navigation = navigationValue as Record<string, unknown>;
  if (navigation.provenanceVersion !== 1
    || typeof navigation.requestedUrl !== 'string'
    || navigation.assignmentAccepted !== true) {
    throw new AssistantPluginError('PLUGIN_MACOS_CAPABILITY_BROKER_PROTOCOL_ERROR', 'Stable Forge macOS capability broker returned incomplete create-tab navigation provenance.', { retryable: true });
  }
  if (navigation.acceptedBy !== undefined && typeof navigation.acceptedBy !== 'string') {
    throw new AssistantPluginError('PLUGIN_MACOS_CAPABILITY_BROKER_PROTOCOL_ERROR', 'Stable Forge macOS capability broker returned invalid create-tab acceptedBy provenance.', { retryable: true });
  }
  if (navigation.observedUrlAfterAssignment !== undefined && typeof navigation.observedUrlAfterAssignment !== 'string') {
    throw new AssistantPluginError('PLUGIN_MACOS_CAPABILITY_BROKER_PROTOCOL_ERROR', 'Stable Forge macOS capability broker returned invalid create-tab observed URL provenance.', { retryable: true });
  }
  const acceptedBy = typeof navigation.acceptedBy === 'string' ? navigation.acceptedBy : undefined;
  const observedUrlAfterAssignment = typeof navigation.observedUrlAfterAssignment === 'string' ? navigation.observedUrlAfterAssignment : undefined;
  return {
    ref,
    refSource,
    navigation: {
      provenanceVersion: 1,
      requestedUrl: navigation.requestedUrl,
      assignmentAccepted: true,
      ...(acceptedBy ? { acceptedBy } : {}),
      ...(observedUrlAfterAssignment ? { observedUrlAfterAssignment } : {}),
    },
  };
}

async function runCreateTabAutomation(
  request: Extract<BrowserAutomationBrokerAction, { action: 'create_tab' }>,
  testScript: string,
  testArgs: string[],
  timeoutMs: number,
): Promise<MacOsBrowserCreateTabEvidence> {
  if (runtimeHooks.runAppleScript) {
    const value = await runtimeHooks.runAppleScript(testScript, testArgs, timeoutMs);
    return parseMacOsBrowserCreateTabBrokerResult({ value });
  }
  return parseMacOsBrowserCreateTabBrokerResult(await callBrowserAutomationBroker(request, timeoutMs));
}

async function runBrowserAutomationText(
  request: BrowserAutomationBrokerAction,
  testScript: string,
  testArgs: string[],
  timeoutMs: number,
): Promise<string> {
  if (runtimeHooks.runAppleScript) return await runtimeHooks.runAppleScript(testScript, testArgs, timeoutMs);
  const result = await callBrowserAutomationBroker(request, timeoutMs);
  if (typeof result.value !== 'string') {
    throw new AssistantPluginError(
      'PLUGIN_MACOS_CAPABILITY_BROKER_PROTOCOL_ERROR',
      'Stable Forge macOS capability broker returned an invalid text result.',
      { retryable: true },
    );
  }
  return result.value;
}

async function captureBrowserAutomation(
  region: { x: number; y: number; width: number; height: number },
  path: string,
  timeoutMs: number,
): Promise<Buffer> {
  if (runtimeHooks.captureRegion) return await runtimeHooks.captureRegion(region, path, timeoutMs);
  const bytes = await captureBrowserAutomationRegion(region, timeoutMs);
  writeFileSync(path, bytes);
  return bytes;
}

async function sendBrowserTrustedInput(
  request: Extract<BrowserAutomationBrokerAction, { action: 'trusted_input' }>,
  timeoutMs: number,
): Promise<void> {
  if (runtimeHooks.trustedInput) {
    await runtimeHooks.trustedInput(request, timeoutMs);
    return;
  }
  let result: Record<string, unknown>;
  try {
    result = await callBrowserAutomationBroker(request, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    if ((error instanceof AssistantPluginError && error.code === 'BROWSER_AUTOMATION_ACTION_UNSUPPORTED')
      || /\bBROWSER_AUTOMATION_ACTION_UNSUPPORTED\b/.test(message)) {
      throw new AssistantPluginError(
        'PLUGIN_BROWSER_TRUSTED_INPUT_UNAVAILABLE',
        'Installed Forge Desktop Operator does not support native browser trusted input. Keep the exact tab explicitly foregrounded and use a separately grounded Desktop Operator interaction, or upgrade the stable Desktop Operator provider.',
        { retryable: false, details: { browserProduct: request.product, requiredProviderAction: 'trusted_input' } },
      );
    }
    throw error;
  }
  if (result.performed !== true) {
    throw new AssistantPluginError(
      'PLUGIN_MACOS_CAPABILITY_BROKER_PROTOCOL_ERROR',
      'Stable Forge macOS capability broker did not confirm trusted browser input.',
      { retryable: true },
    );
  }
}

let runtimeHooks: MacOsBrowserRuntimeHooks = { ...defaultRuntimeHooks };
let lastAttachObservation: MacOsBrowserAttachObservation | undefined;
const MAX_WARM_NATIVE_PAGE_HANDLES = 128;
const warmNativePageHandles = new Map<string, MacOsAppleEventsPage>();

function nativePageHandleKey(product: MacOsBrowserProduct, ref: MacOsBrowserTabRef): string {
  // tabId is the stable browser entity. The windowId is only a mutable placement hint and
  // is re-resolved from live inventory immediately before exact-target Apple Events operations.
  return `${product}:${ref.tabId}`;
}

function rememberMacOsBrowserPageHandle(product: MacOsBrowserProduct, ref: MacOsBrowserTabRef, page: MacOsAppleEventsPage): void {
  const key = nativePageHandleKey(product, ref);
  warmNativePageHandles.delete(key);
  warmNativePageHandles.set(key, page);
  while (warmNativePageHandles.size > MAX_WARM_NATIVE_PAGE_HANDLES) {
    const oldest = warmNativePageHandles.keys().next().value;
    if (typeof oldest !== 'string') break;
    warmNativePageHandles.delete(oldest);
  }
}

export function invalidateMacOsBrowserPageHandle(product: MacOsBrowserProduct, ref: MacOsBrowserTabRef): void {
  warmNativePageHandles.delete(nativePageHandleKey(product, ref));
}

export function invalidateMacOsBrowserPageHandles(): void {
  warmNativePageHandles.clear();
}

export function macOsBrowserPageHandleStale(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /FORGE_BROWSER_TAB_NOT_FOUND|BROWSER_AUTOMATION_TAB_NOT_FOUND|target tab.*not found|can[’']t get tab .*invalid index.*-1719/i.test(message);
}

export function setMacOsBrowserRuntimeHooksForTest(hooks: Partial<MacOsBrowserRuntimeHooks>): void {
  runtimeHooks = { ...defaultRuntimeHooks, ...hooks };
}

export function resetMacOsBrowserRuntimeHooksForTest(): void {
  runtimeHooks = { ...defaultRuntimeHooks };
  lastAttachObservation = undefined;
  warmNativePageHandles.clear();
}

export function getMacOsBrowserAttachObservation(): MacOsBrowserAttachObservation | undefined {
  return lastAttachObservation
    ? { ...lastAttachObservation, attempts: lastAttachObservation.attempts.map((attempt) => ({ ...attempt })) }
    : undefined;
}

const BROWSERS: Record<MacOsBrowserProduct, MacOsBrowserDefinition> = {
  chrome: {
    product: 'chrome',
    appName: 'Google Chrome',
    bundleId: 'com.google.Chrome',
    processName: 'Google Chrome',
    appPaths: ['/Applications/Google Chrome.app', `${homedir()}/Applications/Google Chrome.app`],
  },
  vivaldi: {
    product: 'vivaldi',
    appName: 'Vivaldi',
    bundleId: 'com.vivaldi.Vivaldi',
    processName: 'Vivaldi',
    appPaths: ['/Applications/Vivaldi.app', `${homedir()}/Applications/Vivaldi.app`],
  },
};

function browserDefinition(product: MacOsBrowserProduct): MacOsBrowserDefinition {
  return BROWSERS[product];
}

function quotedAppleScript(value: string): string {
  return JSON.stringify(value);
}

function browserTellScript(browser: MacOsBrowserDefinition, body: string): string {
  return `tell application ${quotedAppleScript(browser.appName)}\n${body}\nend tell`;
}

function metadataScript(browser: MacOsBrowserDefinition): string {
  return browserTellScript(browser, `
if (count of windows) is 0 then error "FORGE_NO_BROWSER_WINDOW"
set targetWindow to front window
set targetTab to active tab of targetWindow
set windowBounds to bounds of targetWindow
set separator to ASCII character 30
return (frontmost as text) & separator & (URL of targetTab as text) & separator & (title of targetTab as text) & separator & ((item 1 of windowBounds) as text) & separator & ((item 2 of windowBounds) as text) & separator & ((item 3 of windowBounds) as text) & separator & ((item 4 of windowBounds) as text) & separator & ((id of targetWindow) as text) & separator & ((id of targetTab) as text) & separator & "true" & separator & (loading of targetTab as text)
`);
}

function listTabsScript(browser: MacOsBrowserDefinition): string {
  return `on replaceText(sourceText, needle, replacement)
  set previousDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to needle
  set sourceItems to every text item of sourceText
  set AppleScript's text item delimiters to replacement
  set resultText to sourceItems as text
  set AppleScript's text item delimiters to previousDelimiters
  return resultText
end replaceText

on cleanField(sourceText, recordSeparator, fieldSeparator)
  set cleaned to my replaceText(sourceText as text, recordSeparator, " ")
  return my replaceText(cleaned, fieldSeparator, " ")
end cleanField

${browserTellScript(browser, `
set recordSeparator to ASCII character 30
set fieldSeparator to ASCII character 31
set maxTabs to 256
set returnedCount to 0
set truncatedInventory to false
set outputText to "false"
repeat with candidateWindow in windows
  set activeTabId to ""
  try
    set activeTabId to ((id of active tab of candidateWindow) as text)
  end try
  repeat with candidateTab in tabs of candidateWindow
    if returnedCount is greater than or equal to maxTabs then
      set truncatedInventory to true
      exit repeat
    end if
    set candidateWindowId to ((id of candidateWindow) as text)
    set candidateTabId to ((id of candidateTab) as text)
    set candidateURL to my cleanField((URL of candidateTab as text), recordSeparator, fieldSeparator)
    set candidateTitle to my cleanField((title of candidateTab as text), recordSeparator, fieldSeparator)
    set candidateActive to (candidateTabId is activeTabId)
    set outputText to outputText & recordSeparator & candidateWindowId & fieldSeparator & candidateTabId & fieldSeparator & (candidateActive as text) & fieldSeparator & candidateURL & fieldSeparator & candidateTitle
    set returnedCount to returnedCount + 1
  end repeat
  if truncatedInventory then exit repeat
end repeat
if truncatedInventory then
  set outputText to "true" & text 6 thru -1 of outputText
end if
return outputText
`)}
`;
}

function parseTabInventory(product: MacOsBrowserProduct, raw: string): MacOsBrowserTabInventory {
  const records = raw.split(RECORD_SEPARATOR);
  const marker = (records.shift() ?? '').trim().toLowerCase();
  if (marker !== 'true' && marker !== 'false') {
    throw new AssistantPluginError(
      'PLUGIN_MACOS_CAPABILITY_BROKER_PROTOCOL_ERROR',
      'Stable Forge macOS capability broker returned an invalid browser tab inventory marker.',
      { retryable: true },
    );
  }
  const tabs: MacOsBrowserTabInventoryEntry[] = [];
  const fieldSeparator = String.fromCharCode(31);
  for (const record of records) {
    if (!record) continue;
    const fields = record.split(fieldSeparator);
    if (fields.length < 5) {
      throw new AssistantPluginError(
        'PLUGIN_MACOS_CAPABILITY_BROKER_PROTOCOL_ERROR',
        'Stable Forge macOS capability broker returned incomplete browser tab inventory metadata.',
        { retryable: true },
      );
    }
    const windowId = (fields[0] ?? '').trim();
    const tabId = (fields[1] ?? '').trim();
    const activeText = (fields[2] ?? '').trim().toLowerCase();
    if (!windowId || !tabId || (activeText !== 'true' && activeText !== 'false')) {
      throw new AssistantPluginError(
        'PLUGIN_MACOS_CAPABILITY_BROKER_PROTOCOL_ERROR',
        'Stable Forge macOS capability broker returned invalid browser tab inventory metadata.',
        { retryable: true },
      );
    }
    tabs.push({ windowId, tabId, active: activeText === 'true', url: fields[3] ?? '', title: fields.slice(4).join(fieldSeparator) });
    if (tabs.length > 256) {
      throw new AssistantPluginError(
        'PLUGIN_MACOS_CAPABILITY_BROKER_PROTOCOL_ERROR',
        'Stable Forge macOS capability broker exceeded the bounded browser tab inventory size.',
        { retryable: true },
      );
    }
  }
  return { product, tabs, truncated: marker === 'true' };
}

function targetTabPreamble(ref: MacOsBrowserTabRef): string {
  return `set targetTabId to ${quotedAppleScript(ref.tabId)}
set targetWindow to missing value
set targetTab to missing value
repeat with candidateWindow in windows
  repeat with candidateTab in tabs of candidateWindow
    if ((id of candidateTab) as text) is targetTabId then
      set targetWindow to candidateWindow
      set targetTab to candidateTab
      exit repeat
    end if
  end repeat
  if targetTab is not missing value then exit repeat
end repeat
if targetTab is missing value then error "FORGE_BROWSER_TAB_NOT_FOUND:" & targetTabId`;
}

function targetMetadataScript(browser: MacOsBrowserDefinition, ref: MacOsBrowserTabRef): string {
  return browserTellScript(browser, `
${targetTabPreamble(ref)}
set windowBounds to bounds of targetWindow
set separator to ASCII character 30
set targetIsActive to ((id of active tab of targetWindow) is (id of targetTab))
return (frontmost as text) & separator & (URL of targetTab as text) & separator & "" & separator & ((item 1 of windowBounds) as text) & separator & ((item 2 of windowBounds) as text) & separator & ((item 3 of windowBounds) as text) & separator & ((item 4 of windowBounds) as text) & separator & ((id of targetWindow) as text) & separator & ((id of targetTab) as text) & separator & (targetIsActive as text) & separator & (loading of targetTab as text)
`);
}

function activateTargetTabScript(browser: MacOsBrowserDefinition, ref: MacOsBrowserTabRef): string {
  return browserTellScript(browser, `
${targetTabPreamble(ref)}
set targetTabIndex to 1
repeat with candidateTab in tabs of targetWindow
  if ((id of candidateTab) as text) is ((id of targetTab) as text) then exit repeat
  set targetTabIndex to targetTabIndex + 1
end repeat
set active tab index of targetWindow to targetTabIndex
set index of targetWindow to 1
activate
`);
}

function createOwnedTabScript(browser: MacOsBrowserDefinition): string {
  return `on run argv
set targetUrl to item 1 of argv
${browserTellScript(browser, `
if (count of windows) is 0 then error "FORGE_NO_BROWSER_WINDOW"
set targetWindow to front window
set originalActiveIndex to active tab index of targetWindow
set targetTab to make new tab at end of tabs of targetWindow with properties {URL:targetUrl}
set targetTabId to id of targetTab
set active tab index of targetWindow to originalActiveIndex
set separator to ASCII character 30
return ((id of targetWindow) as text) & separator & (targetTabId as text)
`)}
end run`;
}

function closeOwnedTabScript(browser: MacOsBrowserDefinition, ref: MacOsBrowserTabRef): string {
  return browserTellScript(browser, `
try
${targetTabPreamble(ref)}
close targetTab
end try
`);
}

function executeJavaScriptScript(browser: MacOsBrowserDefinition, ref?: MacOsBrowserTabRef): string {
  return `on run argv
set javascriptSource to item 1 of argv
${browserTellScript(browser, ref ? `
${targetTabPreamble(ref)}
return execute targetTab javascript javascriptSource
` : `
if (count of windows) is 0 then error "FORGE_NO_BROWSER_WINDOW"
return execute active tab of front window javascript javascriptSource
`)}
end run`;
}

function navigateScript(browser: MacOsBrowserDefinition, ref?: MacOsBrowserTabRef): string {
  return `on run argv
set targetUrl to item 1 of argv
${browserTellScript(browser, ref ? `
${targetTabPreamble(ref)}
set URL of targetTab to targetUrl
return targetUrl
` : `
if (count of windows) is 0 then error "FORGE_NO_BROWSER_WINDOW"
set URL of active tab of front window to targetUrl
return targetUrl
`)}
end run`;
}

function reloadScript(browser: MacOsBrowserDefinition, ref?: MacOsBrowserTabRef): string {
  return browserTellScript(browser, ref ? `
${targetTabPreamble(ref)}
reload targetTab
` : `
if (count of windows) is 0 then error "FORGE_NO_BROWSER_WINDOW"
reload active tab of front window
`);
}

function activateScript(browser: MacOsBrowserDefinition): string {
  return browserTellScript(browser, 'activate');
}

function parseInteger(value: string, field: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${field} returned by browser scripting.`);
  return parsed;
}

function parseBrowserId(value: string, field: string): string {
  const parsed = value.trim();
  if (!parsed) throw new Error(`Invalid ${field} returned by browser scripting.`);
  return parsed;
}

function parseMetadata(product: MacOsBrowserProduct, raw: string): MacOsBrowserMetadata {
  const browser = browserDefinition(product);
  const parts = raw.split(RECORD_SEPARATOR);
  if (parts.length < 7) throw new Error(`Browser scripting returned incomplete metadata for ${browser.appName}.`);
  const left = parseInteger(parts[3] ?? '', 'window left');
  const top = parseInteger(parts[4] ?? '', 'window top');
  const right = parseInteger(parts[5] ?? '', 'window right');
  const bottom = parseInteger(parts[6] ?? '', 'window bottom');
  return {
    product,
    appName: browser.appName,
    bundleId: browser.bundleId,
    frontmost: (parts[0] ?? '').toLowerCase() === 'true',
    url: parts[1] ?? '',
    title: parts[2] ?? '',
    bounds: {
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    },
    windowId: parts[7] ? parseBrowserId(parts[7], 'window id') : undefined,
    tabId: parts[8] ? parseBrowserId(parts[8], 'tab id') : undefined,
    active: parts[9] ? (parts[9] ?? '').toLowerCase() === 'true' : undefined,
    loading: parts[10] ? (parts[10] ?? '').toLowerCase() === 'true' : undefined,
  };
}

async function inspectBrowser(product: MacOsBrowserProduct, timeoutMs: number): Promise<{ metadata?: MacOsBrowserMetadata; attempt: MacOsBrowserAttachAttempt }> {
  const browser = browserDefinition(product);
  const base = { product, appName: browser.appName, bundleId: browser.bundleId };
  if (runtimeHooks.platform !== 'darwin') {
    return { attempt: { ...base, status: 'unavailable', error: 'Apple Events browser attach is available only on macOS.' } };
  }
  if (!browser.appPaths.some((path) => runtimeHooks.appExists(path))) {
    return { attempt: { ...base, status: 'not_installed', error: `${browser.appName} is not installed.` } };
  }
  if (!(await runtimeHooks.processRunning(browser.processName, timeoutMs))) {
    return { attempt: { ...base, status: 'not_running', error: `${browser.appName} is not running.` } };
  }
  try {
    const metadata = parseMetadata(product, await runBrowserAutomationText(
      { action: 'metadata', product },
      metadataScript(browser),
      [],
      timeoutMs,
    ));
    return {
      metadata,
      attempt: {
        ...base,
        status: 'available',
        frontmost: metadata.frontmost,
      },
    };
  } catch (error) {
    return {
      attempt: {
        ...base,
        status: 'unavailable',
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function macOsActiveBrowserAttachSupported(): boolean {
  return runtimeHooks.platform === 'darwin';
}

export async function discoverMacOsBrowserAttachment(
  candidates: MacOsBrowserProduct[],
  timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
): Promise<{ attachment?: MacOsBrowserAttachment; attempts: MacOsBrowserAttachAttempt[] }> {
  const normalized = Array.from(new Set(candidates)).filter((entry): entry is MacOsBrowserProduct => entry === 'chrome' || entry === 'vivaldi');
  const inspected = [] as Array<{ metadata?: MacOsBrowserMetadata; attempt: MacOsBrowserAttachAttempt }>;
  for (const product of normalized) inspected.push(await inspectBrowser(product, timeoutMs));
  const available = inspected.filter((entry): entry is { metadata: MacOsBrowserMetadata; attempt: MacOsBrowserAttachAttempt } => Boolean(entry.metadata));
  const selected = available.find((entry) => entry.metadata.frontmost) ?? available[0];
  const attempts = inspected.map((entry) => ({ ...entry.attempt }));
  if (!selected) {
    lastAttachObservation = { checkedAt: new Date().toISOString(), ready: false, attempts: attempts.map((attempt) => ({ ...attempt })) };
    return { attempts };
  }
  const selectedAttempt = attempts.find((entry) => entry.product === selected.metadata.product);
  if (selectedAttempt) selectedAttempt.status = 'selected';
  lastAttachObservation = {
    checkedAt: new Date().toISOString(),
    ready: true,
    selectedProduct: selected.metadata.product,
    attempts: attempts.map((attempt) => ({ ...attempt })),
  };
  return {
    attempts,
    attachment: {
      metadata: selected.metadata,
      attempts,
    },
  };
}

function serializeEvaluation(expression: string | ((...args: unknown[]) => unknown), arg?: unknown): string {
  const source = typeof expression === 'string'
    ? expression
    : `(${expression.toString()})(${arg === undefined ? 'undefined' : JSON.stringify(arg)})`;
  return `(() => {
    try {
      const value = (${source});
      const page = { url: String(document.location.href || ''), title: String(document.title || '') };
      return JSON.stringify({ ok: true, value: value === undefined ? { __forgeUndefined: true } : value, page });
    } catch (error) {
      return JSON.stringify({ ok: false, error: String(error && (error.stack || error.message) || error) });
    }
  })()`;
}

function selectorSource(selector: string, body: string): string {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error(${JSON.stringify(`Selector not found: ${selector}`)});
    ${body}
  })()`;
}

function keyEventSource(selector: string | undefined, keySpec: string): string {
  const parts = keySpec.split('+').filter(Boolean);
  const key = parts.at(-1) ?? keySpec;
  const modifiers = new Set(parts.slice(0, -1).map((entry) => entry.toLowerCase()));
  const target = selector
    ? `document.querySelector(${JSON.stringify(selector)})`
    : 'document.activeElement || document.body';
  return `(() => {
    const element = ${target};
    if (!element) throw new Error(${JSON.stringify(selector ? `Selector not found: ${selector}` : 'No active element.')});
    if (typeof element.focus === 'function') element.focus();
    const init = {
      key: ${JSON.stringify(key)},
      code: ${JSON.stringify(key.length === 1 ? `Key${key.toUpperCase()}` : key)},
      bubbles: true,
      cancelable: true,
      metaKey: ${modifiers.has('meta') || modifiers.has('cmd') || modifiers.has('command')},
      ctrlKey: ${modifiers.has('control') || modifiers.has('ctrl')},
      altKey: ${modifiers.has('alt') || modifiers.has('option')},
      shiftKey: ${modifiers.has('shift')}
    };
    element.dispatchEvent(new KeyboardEvent('keydown', init));
    element.dispatchEvent(new KeyboardEvent('keypress', init));
    if (${JSON.stringify(key)} === 'Enter') {
      const form = element.form || (typeof element.closest === 'function' ? element.closest('form') : null);
      if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
      else if (typeof element.click === 'function' && /^(BUTTON|A)$/.test(element.tagName || '')) element.click();
    }
    element.dispatchEvent(new KeyboardEvent('keyup', init));
    return true;
  })()`;
}

export function nativeDomLoadStateSatisfied(
  state: string,
  readyState: string,
  currentUrl: string,
  requireHttpUrl: boolean,
): boolean {
  if (requireHttpUrl && !/^https?:\/\//i.test(currentUrl ?? '')) return false;
  return state === 'load' || state === 'networkidle'
    ? readyState === 'complete'
    : readyState === 'interactive' || readyState === 'complete';
}

export class MacOsAppleEventsPage {
  private metadata: MacOsBrowserMetadata;
  private readonly browser: MacOsBrowserDefinition;
  private timeoutMs: number;
  private targetRef?: MacOsBrowserTabRef;
  private readonly createTabEvidence?: MacOsBrowserCreateTabEvidence;

  constructor(attachment: MacOsBrowserAttachment, timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS, targetRef?: MacOsBrowserTabRef, createTabEvidence?: MacOsBrowserCreateTabEvidence) {
    this.metadata = { ...attachment.metadata, ...(targetRef ? { windowId: targetRef.windowId, tabId: targetRef.tabId } : {}) };
    this.browser = browserDefinition(attachment.metadata.product);
    this.timeoutMs = timeoutMs;
    this.targetRef = targetRef;
    this.createTabEvidence = createTabEvidence ? {
      ...createTabEvidence,
      ref: { ...createTabEvidence.ref },
      ...(createTabEvidence.navigation ? { navigation: { ...createTabEvidence.navigation } } : {}),
    } : undefined;
  }

  private async runAutomation(
    request: BrowserAutomationBrokerAction,
    script: string | ((resolvedRef?: MacOsBrowserTabRef) => string),
    args: string[] = [],
    timeoutMs = this.timeoutMs,
  ): Promise<string> {
    try {
      let effectiveRequest = request;
      let resolvedRef: MacOsBrowserTabRef | undefined;
      if ('ref' in request && request.ref) {
        resolvedRef = await resolveCurrentMacOsBrowserTabRef(this.browser.product, request.ref, timeoutMs);
        this.targetRef = resolvedRef;
        effectiveRequest = { ...request, ref: resolvedRef } as BrowserAutomationBrokerAction;
      }
      const effectiveScript = typeof script === 'function' ? script(resolvedRef ?? this.targetRef) : script;
      return await runBrowserAutomationText(effectiveRequest, effectiveScript, args, timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AssistantPluginError('PLUGIN_BROWSER_NATIVE_OPERATION_FAILED', `${this.browser.appName} Apple Events operation failed: ${message}`, {
        retryable: true,
        details: { browserProduct: this.browser.product, bundleId: this.browser.bundleId },
      });
    }
  }

  private async refreshMetadata(): Promise<MacOsBrowserMetadata> {
    this.metadata = parseMetadata(this.browser.product, await this.runAutomation(
      { action: 'metadata', product: this.browser.product, ...(this.targetRef ? { ref: this.targetRef } : {}) },
      (resolvedRef) => resolvedRef ? targetMetadataScript(this.browser, resolvedRef) : metadataScript(this.browser),
    ));
    if (this.targetRef && this.metadata.windowId && this.metadata.tabId) {
      this.targetRef = { windowId: this.metadata.windowId, tabId: this.metadata.tabId };
    }
    return this.metadata;
  }

  private async executeJavaScriptRaw(source: string, timeoutMs = this.timeoutMs): Promise<string> {
    try {
      return await this.runAutomation(
        { action: 'execute_javascript', product: this.browser.product, ...(this.targetRef ? { ref: this.targetRef } : {}), source },
        (resolvedRef) => executeJavaScriptScript(this.browser, resolvedRef),
        [source],
        timeoutMs,
      );
    } catch (error) {
      if (macOsBrowserJavaScriptAutomationDisabled(error)) {
        throw new AssistantPluginError(
          'PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED',
          `${this.browser.appName} allows tab/window automation, but DOM actions require Settings > Privacy > Apple Events > Allow JavaScript from Apple Events.`,
          { retryable: false, details: { browserProduct: this.browser.product, bundleId: this.browser.bundleId } },
        );
      }
      throw error;
    }
  }

  tabRef(): MacOsBrowserTabRef | undefined {
    return this.targetRef ? { ...this.targetRef } : undefined;
  }

  creationEvidence(): MacOsBrowserCreateTabEvidence | undefined {
    return this.createTabEvidence ? {
      ...this.createTabEvidence,
      ref: { ...this.createTabEvidence.ref },
      ...(this.createTabEvidence.navigation ? { navigation: { ...this.createTabEvidence.navigation } } : {}),
    } : undefined;
  }

  updateTimeout(timeoutMs: number): void {
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) this.timeoutMs = Math.trunc(timeoutMs);
  }

  attachmentSnapshot(): MacOsBrowserAttachment {
    return {
      metadata: { ...this.metadata, bounds: { ...this.metadata.bounds } },
      attempts: [{
        product: this.browser.product,
        appName: this.browser.appName,
        bundleId: this.browser.bundleId,
        status: 'selected',
        frontmost: this.metadata.frontmost,
      }],
    };
  }

  async goto(url: string, options: Record<string, unknown> = {}): Promise<unknown> {
    const timeout = typeof options.timeout === 'number' ? Math.trunc(options.timeout) : this.timeoutMs;
    await this.runAutomation(
      { action: 'navigate', product: this.browser.product, ...(this.targetRef ? { ref: this.targetRef } : {}), url },
      (resolvedRef) => navigateScript(this.browser, resolvedRef),
      [url],
      timeout,
    );
    await this.waitForLoadState(String(options.waitUntil ?? 'domcontentloaded'), { timeout });
    await this.refreshMetadata();
    return undefined;
  }

  async reload(options: Record<string, unknown> = {}): Promise<unknown> {
    const timeout = typeof options.timeout === 'number' ? Math.trunc(options.timeout) : this.timeoutMs;
    await this.runAutomation(
      { action: 'reload', product: this.browser.product, ...(this.targetRef ? { ref: this.targetRef } : {}) },
      (resolvedRef) => reloadScript(this.browser, resolvedRef),
      [],
      timeout,
    );
    await this.waitForLoadState(String(options.waitUntil ?? 'domcontentloaded'), { timeout });
    await this.refreshMetadata();
    return undefined;
  }

  async goBack(options: Record<string, unknown> = {}): Promise<unknown> {
    await this.evaluate('history.back()');
    await this.waitForLoadState(String(options.waitUntil ?? 'domcontentloaded'), options);
    await this.refreshMetadata();
    return undefined;
  }

  async title(): Promise<string> {
    if (this.targetRef) {
      try {
        const title = await this.evaluate<string>('document.title || ""');
        this.metadata = { ...this.metadata, title };
        return title;
      } catch {
        // Chrome can expose a valid background tab while refusing AppleScript title/name coercion.
        // A missing tab still fails through the metadata fallback below.
      }
    }
    return (await this.refreshMetadata()).title;
  }

  url(): string {
    return this.metadata.url;
  }

  async identity(): Promise<{ url: string; title: string }> {
    try {
      const identity = await this.evaluate<{ url: string; title: string }>(
        '({ url: String(document.location.href || ""), title: String(document.title || "") })',
      );
      if (identity && typeof identity.url === 'string' && identity.url) {
        const normalized = { url: identity.url, title: typeof identity.title === 'string' ? identity.title : '' };
        this.metadata = { ...this.metadata, ...normalized };
        return normalized;
      }
    } catch (error) {
      if (!macOsBrowserJavaScriptAutomationDisabled(error)
        && !(error instanceof AssistantPluginError && error.code === 'PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED')) throw error;
    }
    const metadata = await this.refreshMetadata();
    return { url: metadata.url, title: metadata.title };
  }

  async content(): Promise<string> {
    return await this.evaluate<string>('document.documentElement ? document.documentElement.outerHTML : ""');
  }

  async evaluate<T>(expression: string | ((...args: unknown[]) => unknown), arg?: unknown): Promise<T> {
    const raw = await this.executeJavaScriptRaw(serializeEvaluation(expression, arg));
    let parsed: { ok?: boolean; value?: unknown; error?: string; page?: { url?: unknown; title?: unknown } };
    try {
      parsed = JSON.parse(raw) as { ok?: boolean; value?: unknown; error?: string; page?: { url?: unknown; title?: unknown } };
    } catch {
      throw new AssistantPluginError('PLUGIN_BROWSER_NATIVE_PROTOCOL_ERROR', `${this.browser.appName} returned an invalid JavaScript result.`, {
        retryable: true,
      });
    }
    if (!parsed.ok) throw new Error(parsed.error || 'Browser JavaScript evaluation failed.');
    if (parsed.page && typeof parsed.page.url === 'string' && parsed.page.url) {
      this.metadata = {
        ...this.metadata,
        url: parsed.page.url,
        title: typeof parsed.page.title === 'string' ? parsed.page.title : this.metadata.title,
      };
    }
    if (parsed.value && typeof parsed.value === 'object' && (parsed.value as { __forgeUndefined?: unknown }).__forgeUndefined === true) {
      return undefined as T;
    }
    return parsed.value as T;
  }

  async setInputFiles(selector: string, files: string | string[]): Promise<void> {
    const filePaths = Array.isArray(files) ? files : [files];
    if (filePaths.length === 0 || filePaths.length > 32) {
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Native browser file input accepts 1-32 local files.', { retryable: false });
    }
    for (const filePath of filePaths) {
      if (!filePath || !existsSync(filePath)) {
        throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Local file does not exist.', { retryable: false });
      }
    }

    if (filePaths.length === 1) {
      const filePath = filePaths[0];
      const bytes = readFileSync(filePath);
      const fileName = basename(filePath);
      const extension = extname(fileName).toLowerCase();
      const mimeType = extension === '.pdf' ? 'application/pdf'
        : extension === '.zip' ? 'application/zip'
        : extension === '.png' ? 'image/png'
        : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
        : 'application/octet-stream';
      const bufferKey = `__forgeLocalFile_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const encoded = bytes.toString('base64');
      const chunkChars = 192 * 1024;
      try {
        await this.evaluate(`(() => { globalThis[${JSON.stringify(bufferKey)}] = ''; return true; })()`);
        for (let offset = 0; offset < encoded.length; offset += chunkChars) {
          const chunk = encoded.slice(offset, offset + chunkChars);
          await this.evaluate(`(() => { globalThis[${JSON.stringify(bufferKey)}] += ${JSON.stringify(chunk)}; return true; })()`);
        }
        const attached = await this.evaluate<{ name?: string; size?: number }>(`(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!(element instanceof HTMLInputElement) || element.type !== 'file') throw new Error('Selector must resolve to an input[type=file].');
          const expectedName = ${JSON.stringify(fileName)};
          const expectedSize = ${bytes.length};
          const encoded = String(globalThis[${JSON.stringify(bufferKey)}] || '');
          const binary = atob(encoded);
          const data = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) data[i] = binary.charCodeAt(i);
          const file = new File([data], expectedName, { type: ${JSON.stringify(mimeType)} });
          const transfer = new DataTransfer();
          transfer.items.add(file);
          element.files = transfer.files;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          const selected = element.files && element.files[0];
          return selected ? { name: selected.name, size: selected.size, expectedName, expectedSize } : null;
        })()`);
        if (attached?.name !== fileName || attached?.size !== bytes.length) {
          throw new AssistantPluginError('PLUGIN_BROWSER_NATIVE_FILE_ATTACH_FAILED', 'Native browser did not retain the requested local file on the target input.', {
            retryable: true,
            details: { expectedName: fileName, expectedSize: bytes.length, actualName: attached?.name, actualSize: attached?.size },
          });
        }
      } finally {
        await this.evaluate(`(() => { try { delete globalThis[${JSON.stringify(bufferKey)}]; } catch {} return true; })()`).catch(() => undefined);
      }
      return;
    }

    const attachments = filePaths.map((filePath) => {
      const bytes = readFileSync(filePath);
      const fileName = basename(filePath);
      const extension = extname(fileName).toLowerCase();
      const mimeType = extension === '.pdf' ? 'application/pdf'
        : extension === '.zip' ? 'application/zip'
        : extension === '.png' ? 'image/png'
        : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
        : 'application/octet-stream';
      return {
        bytes,
        fileName,
        mimeType,
        bufferKey: `__forgeLocalFile_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      };
    });

    if (attachments.length > 1) {
      await this.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!(element instanceof HTMLInputElement) || element.type !== 'file') throw new Error('Selector must resolve to an input[type=file].');
        if (!element.multiple) throw new Error('Target input does not allow multiple files.');
        const transfer = new DataTransfer();
        element.files = transfer.files;
        return true;
      })()`);
    }

    const chunkChars = 192 * 1024;
    try {
      for (let index = 0; index < attachments.length; index += 1) {
        const attachment = attachments[index];
        const encoded = attachment.bytes.toString('base64');
        await this.evaluate(`(() => { globalThis[${JSON.stringify(attachment.bufferKey)}] = ''; return true; })()`);
        for (let offset = 0; offset < encoded.length; offset += chunkChars) {
          const chunk = encoded.slice(offset, offset + chunkChars);
          await this.evaluate(`(() => { globalThis[${JSON.stringify(attachment.bufferKey)}] += ${JSON.stringify(chunk)}; return true; })()`);
        }
        const append = attachments.length > 1 && index > 0;
        await this.evaluate(`(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!(element instanceof HTMLInputElement) || element.type !== 'file') throw new Error('Selector must resolve to an input[type=file].');
          const expectedName = ${JSON.stringify(attachment.fileName)};
          const expectedSize = ${attachment.bytes.length};
          const encoded = String(globalThis[${JSON.stringify(attachment.bufferKey)}] || '');
          const binary = atob(encoded);
          const data = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) data[i] = binary.charCodeAt(i);
          const file = new File([data], expectedName, { type: ${JSON.stringify(attachment.mimeType)} });
          const transfer = new DataTransfer();
          if (${append ? 'true' : 'false'}) {
            for (const existing of Array.from(element.files || [])) transfer.items.add(existing);
          }
          transfer.items.add(file);
          element.files = transfer.files;
          return Array.from(element.files || []).map((selected) => ({ name: selected.name, size: selected.size }));
        })()`);
      }

      const selected = await this.evaluate<Array<{ name?: string; size?: number }>>(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!(element instanceof HTMLInputElement) || element.type !== 'file') throw new Error('Selector must resolve to an input[type=file].');
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return Array.from(element.files || []).map((file) => ({ name: file.name, size: file.size }));
      })()`);
      const expected = attachments.map((attachment) => ({ name: attachment.fileName, size: attachment.bytes.length }));
      const matches = selected.length === expected.length && expected.every((item, index) => selected[index]?.name === item.name && selected[index]?.size === item.size);
      if (!matches) {
        throw new AssistantPluginError('PLUGIN_BROWSER_NATIVE_FILE_ATTACH_FAILED', 'Native browser did not retain the requested local files on the target input.', {
          retryable: true,
          details: { expected, actual: selected },
        });
      }
    } finally {
      for (const attachment of attachments) {
        await this.evaluate(`(() => { try { delete globalThis[${JSON.stringify(attachment.bufferKey)}]; } catch {} return true; })()`).catch(() => undefined);
      }
    }
  }

  async foregroundState(): Promise<{ frontmost: boolean; active: boolean }> {
    const metadata = await this.refreshMetadata();
    return { frontmost: metadata.frontmost, active: metadata.active === true };
  }

  async trustedInput(input: BrowserAutomationTrustedInput): Promise<void> {
    if (!this.targetRef) {
      throw new AssistantPluginError('PLUGIN_BROWSER_TRUSTED_INPUT_UNAVAILABLE', 'Native trusted input requires an exact saved browser tab.', { retryable: false });
    }
    this.targetRef = await resolveCurrentMacOsBrowserTabRef(this.browser.product, this.targetRef, this.timeoutMs);
    await sendBrowserTrustedInput({ action: 'trusted_input', product: this.browser.product, ref: this.targetRef, input }, this.timeoutMs);
    await this.refreshMetadata();
  }

  async screenshot(options: Record<string, unknown>): Promise<Buffer> {
    const path = typeof options.path === 'string' ? options.path : undefined;
    if (!path) throw new Error('Native browser screenshot requires an output path.');
    const metadata = await this.refreshMetadata();
    if (this.targetRef && (!metadata.frontmost || metadata.active !== true)) {
      throw new AssistantPluginError('PLUGIN_BROWSER_FOREGROUND_REQUIRED', 'Native screenshot refused to activate a background plugin-owned tab. Bring the tab to the foreground explicitly before capturing it.', {
        retryable: true,
        details: { browserProduct: this.browser.product, windowId: this.targetRef.windowId, tabId: this.targetRef.tabId },
      });
    }
    return await captureBrowserAutomation(metadata.bounds, path, this.timeoutMs);
  }

  async click(selector: string): Promise<void> {
    await this.evaluate(selectorSource(selector, `
      if (element instanceof HTMLOptionElement) {
        const selectElement = element.closest('select');
        if (!(selectElement instanceof HTMLSelectElement)) throw new Error('Option is not attached to a select.');
        if (element.disabled || selectElement.disabled) throw new Error('Option is disabled.');
        if (!selectElement.multiple) {
          const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
          if (valueSetter) valueSetter.call(selectElement, element.value);
          else selectElement.value = element.value;
        } else {
          element.selected = true;
        }
        selectElement.dispatchEvent(new Event('input', { bubbles: true }));
        selectElement.dispatchEvent(new Event('change', { bubbles: true }));
        if (!Array.from(selectElement.selectedOptions).includes(element)) throw new Error('Option selection did not persist.');
        return true;
      }
      if (typeof element.click !== "function") throw new Error("Element is not clickable.");
      const rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
      const clientX = Number(rect.left || 0) + Number(rect.width || 0) / 2;
      const clientY = Number(rect.top || 0) + Number(rect.height || 0) / 2;
      const mouseInit = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: 1, clientX, clientY };
      if (typeof PointerEvent === 'function') {
        element.dispatchEvent(new PointerEvent('pointerdown', { ...mouseInit, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      }
      element.dispatchEvent(new MouseEvent('mousedown', mouseInit));
      if (typeof element.focus === 'function') element.focus();
      if (typeof PointerEvent === 'function') {
        element.dispatchEvent(new PointerEvent('pointerup', { ...mouseInit, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      }
      element.dispatchEvent(new MouseEvent('mouseup', { ...mouseInit, buttons: 0 }));
      element.click();
      return true;
    `));
  }

  async dblclick(selector: string): Promise<void> {
    await this.evaluate(selectorSource(selector, `element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window })); return true;`));
  }

  async hover(selector: string): Promise<void> {
    await this.evaluate(selectorSource(selector, `for (const type of ['mouseover', 'mouseenter', 'mousemove']) element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); return true;`));
  }

  async focus(selector: string): Promise<void> {
    await this.evaluate(selectorSource(selector, 'if (typeof element.focus !== "function") throw new Error("Element is not focusable."); element.focus(); return true;'));
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.evaluate(selectorSource(selector, `
      if ('value' in element) {
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (setter) setter.call(element, ${JSON.stringify(value)}); else element.value = ${JSON.stringify(value)};
      } else if (element.isContentEditable) element.textContent = ${JSON.stringify(value)};
      else throw new Error('Element does not accept text input.');
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `));
  }

  async type(selector: string, text: string): Promise<void> {
    const current = await this.evaluate<string>(selectorSource(selector, `return 'value' in element ? String(element.value || '') : String(element.textContent || '');`));
    await this.fill(selector, `${current}${text}`);
  }

  async press(selector: string, key: string): Promise<void> {
    await this.evaluate(keyEventSource(selector, key));
  }

  async selectOption(selector: string, values: string | string[]): Promise<unknown> {
    const normalized = Array.isArray(values) ? values : [values];
    return await this.evaluate(selectorSource(selector, `
      if (!(element instanceof HTMLSelectElement)) throw new Error('Element is not a select.');
      const selected = new Set(${JSON.stringify(normalized)});
      let matched = 0;
      for (const option of element.options) {
        const shouldSelect = selected.has(option.value) || selected.has(option.label);
        option.selected = shouldSelect;
        if (shouldSelect) matched += 1;
      }
      if (matched === 0) throw new Error('Requested select option was not found.');
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      const actual = Array.from(element.selectedOptions);
      if (!actual.some((option) => selected.has(option.value) || selected.has(option.label))) {
        throw new Error('Requested select option did not persist.');
      }
      return actual.map((option) => option.value);
    `));
  }

  async check(selector: string): Promise<void> {
    await this.setChecked(selector, true);
  }

  async uncheck(selector: string): Promise<void> {
    await this.setChecked(selector, false);
  }

  private async setChecked(selector: string, checked: boolean): Promise<void> {
    await this.evaluate(selectorSource(selector, `
      if (!('checked' in element)) throw new Error('Element is not checkable.');
      element.checked = ${checked};
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `));
  }

  async waitForSelector(selector: string, options: Record<string, unknown> = {}): Promise<unknown> {
    const timeout = typeof options.timeout === 'number' ? Math.trunc(options.timeout) : this.timeoutMs;
    const state = String(options.state ?? 'visible');
    const deadline = Date.now() + timeout;
    while (Date.now() <= deadline) {
      const observed = await this.evaluate<{ attached: boolean; visible: boolean }>(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return { attached: false, visible: false };
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return { attached: true, visible: style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 };
      })()`);
      const matched = state === 'attached' ? observed.attached
        : state === 'detached' ? !observed.attached
          : state === 'hidden' ? !observed.attached || !observed.visible
            : observed.visible;
      if (matched) return observed;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timeout waiting for selector ${selector} in state ${state}.`);
  }

  async waitForLoadState(state = 'domcontentloaded', options: Record<string, unknown> = {}): Promise<void> {
    const timeout = typeof options.timeout === 'number' ? Math.trunc(options.timeout) : this.timeoutMs;
    const requireHttpUrl = options.requireHttpUrl === true;
    const deadline = Date.now() + timeout;
    while (Date.now() <= deadline) {
      if (this.targetRef) {
        try {
          const metadata = await this.refreshMetadata();
          // Browser actions only admit HTTP(S) targets. Native Chrome/Vivaldi can
          // expose several internal URLs (new-tab, error/interstitial, extension
          // bootstrap pages) while navigation is still settling. Treat every
          // non-HTTP(S) metadata URL as transitional here; the adapter still
          // applies the strict final HTTP(S) URL validator before persisting a
          // session, so this does not widen the accepted navigation surface.
          const transitionalUrl = !/^https?:\/\//i.test(metadata.url ?? '');
          if (transitionalUrl) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
          }
          if (metadata.loading === false) return;
        } catch {
          // Fall through to DOM readiness when native loading metadata is unavailable.
        }
      }
      try {
        const domState = await this.evaluate<{ readyState: string; url: string }>(
          '({ readyState: String(document.readyState || ""), url: String(document.location.href || "") })',
        );
        if (nativeDomLoadStateSatisfied(state, domState.readyState, domState.url, requireHttpUrl)) return;
      } catch (error) {
        if (error instanceof AssistantPluginError && error.code === 'PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED') {
          const metadata = await this.refreshMetadata();
          if (/^https?:\/\//i.test(metadata.url ?? '')) return;
        }
        // Navigation can transiently invalidate the current JavaScript execution context.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new AssistantPluginError(
      'PLUGIN_BROWSER_LOAD_STATE_TIMEOUT',
      `Timed out waiting for native browser load state ${state}.`,
      { retryable: true, details: { state, timeoutMs: timeout, requireHttpUrl } },
    );
  }

  locator(_selector: string): { screenshot: (options?: Record<string, unknown>) => Promise<Buffer> } {
    return { screenshot: async (options = {}) => this.screenshot(options) };
  }

  on(_event: string, _handler: (...args: unknown[]) => void): void {
    // Apple Events does not expose Playwright console/network event streams.
  }

  async bringToFront(): Promise<void> {
    if (this.targetRef) {
      this.metadata = await activateMacOsBrowserOwnedTab(this.browser.product, this.targetRef, this.timeoutMs);
      if (this.metadata.windowId && this.metadata.tabId) {
        this.targetRef = { windowId: this.metadata.windowId, tabId: this.metadata.tabId };
      }
      return;
    }
    await this.runAutomation(
      { action: 'activate', product: this.browser.product },
      activateScript(this.browser),
    );
  }

  keyboard = {
    press: async (key: string): Promise<void> => {
      await this.evaluate(keyEventSource(undefined, key));
    },
  };
}

async function resolveCurrentMacOsBrowserTabRef(
  product: MacOsBrowserProduct,
  ref: MacOsBrowserTabRef,
  timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
): Promise<MacOsBrowserTabRef> {
  // Existing unit-level AppleScript hooks historically model one exact script at a time.
  // Preserve that narrow test seam unless a live inventory hook is explicitly supplied;
  // production always resolves through the stable Desktop Operator broker inventory.
  const inventory = runtimeHooks.tabInventory
    ? await runtimeHooks.tabInventory(product, timeoutMs)
    : runtimeHooks.runAppleScript
      ? undefined
      : await listMacOsBrowserTabs(product, timeoutMs);
  if (!inventory) return ref;

  const matches = inventory.tabs.filter((candidate) => candidate.tabId === ref.tabId);
  if (inventory.truncated || matches.length !== 1) {
    throw new AssistantPluginError(
      'PLUGIN_BROWSER_NATIVE_TAB_IDENTITY_UNPROVEN',
      inventory.truncated
        ? `Cannot prove the current ${product} tab identity because live inventory was truncated.`
        : matches.length === 0
          ? `Saved ${product} tab ${ref.tabId} no longer exists in live inventory.`
          : `Saved ${product} tab ${ref.tabId} is ambiguous in live inventory.`,
      {
        retryable: true,
        details: {
          browserProduct: product,
          tabId: ref.tabId,
          savedWindowId: ref.windowId,
          candidateCount: matches.length,
          inventoryTruncated: inventory.truncated,
        },
      },
    );
  }

  const match = matches[0]!;
  return { windowId: match.windowId, tabId: match.tabId };
}

export async function listMacOsBrowserTabs(
  product: MacOsBrowserProduct,
  timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
): Promise<MacOsBrowserTabInventory> {
  const browser = browserDefinition(product);
  const raw = await runBrowserAutomationText(
    { action: 'list_tabs', product },
    listTabsScript(browser),
    [],
    timeoutMs,
  );
  return parseTabInventory(product, raw);
}

export async function readMacOsBrowserOwnedTabMetadata(
  product: MacOsBrowserProduct,
  ref: MacOsBrowserTabRef,
  timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
): Promise<MacOsBrowserMetadata> {
  const browser = browserDefinition(product);
  const resolvedRef = await resolveCurrentMacOsBrowserTabRef(product, ref, timeoutMs);
  return parseMetadata(product, await runBrowserAutomationText(
    { action: 'metadata', product, ref: resolvedRef },
    targetMetadataScript(browser, resolvedRef),
    [],
    timeoutMs,
  ));
}

export async function activateMacOsBrowserOwnedTab(
  product: MacOsBrowserProduct,
  ref: MacOsBrowserTabRef,
  timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
): Promise<MacOsBrowserMetadata> {
  const browser = browserDefinition(product);
  const resolvedRef = await resolveCurrentMacOsBrowserTabRef(product, ref, timeoutMs);
  await runBrowserAutomationText(
    { action: 'activate', product, ref: resolvedRef },
    activateTargetTabScript(browser, resolvedRef),
    [],
    timeoutMs,
  );
  const metadata = await readMacOsBrowserOwnedTabMetadata(product, resolvedRef, timeoutMs);
  if (metadata.tabId !== resolvedRef.tabId || metadata.active !== true) {
    throw new AssistantPluginError(
      'PLUGIN_BROWSER_NATIVE_ACTIVATION_POSTCONDITION_FAILED',
      `${browser.appName} did not prove that the exact requested tab became active.`,
      {
        retryable: true,
        details: {
          browserProduct: product,
          requestedTabId: resolvedRef.tabId,
          resolvedWindowId: resolvedRef.windowId,
          observedWindowId: metadata.windowId,
          observedTabId: metadata.tabId,
          observedActive: metadata.active,
          observedFrontmost: metadata.frontmost,
        },
      },
    );
  }
  return metadata;
}

export function createMacOsBrowserPage(attachment: MacOsBrowserAttachment, timeoutMs?: number): MacOsAppleEventsPage {
  return new MacOsAppleEventsPage(attachment, timeoutMs);
}

export async function createMacOsBrowserOwnedPage(
  attachment: MacOsBrowserAttachment,
  url: string,
  timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
): Promise<MacOsAppleEventsPage> {
  const browser = browserDefinition(attachment.metadata.product);
  const creationEvidence = await runCreateTabAutomation(
    { action: 'create_tab', product: attachment.metadata.product, url },
    createOwnedTabScript(browser),
    [url],
    timeoutMs,
  );
  const ref = creationEvidence.ref;
  const page = new MacOsAppleEventsPage({
    ...attachment,
    metadata: { ...attachment.metadata, url, title: '', windowId: ref.windowId, tabId: ref.tabId, active: false },
  }, timeoutMs, ref, creationEvidence);
  rememberMacOsBrowserPageHandle(attachment.metadata.product, ref, page);
  return page;
}

export async function reattachMacOsBrowserOwnedPage(
  product: MacOsBrowserProduct,
  ref: MacOsBrowserTabRef,
  timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
): Promise<{ page: MacOsAppleEventsPage; attachment: MacOsBrowserAttachment }> {
  const cacheKey = nativePageHandleKey(product, ref);
  const cached = warmNativePageHandles.get(cacheKey);
  if (cached) {
    cached.updateTimeout(timeoutMs);
    // Refresh insertion order so bounded eviction behaves as a small LRU.
    warmNativePageHandles.delete(cacheKey);
    warmNativePageHandles.set(cacheKey, cached);
    return { page: cached, attachment: cached.attachmentSnapshot() };
  }
  const metadata = await readMacOsBrowserOwnedTabMetadata(product, ref, timeoutMs);
  const attachment: MacOsBrowserAttachment = {
    metadata,
    attempts: [{ product, appName: metadata.appName, bundleId: metadata.bundleId, status: 'selected', frontmost: metadata.frontmost }],
  };
  const resolvedRef = metadata.windowId && metadata.tabId
    ? { windowId: metadata.windowId, tabId: metadata.tabId }
    : ref;
  const page = new MacOsAppleEventsPage(attachment, timeoutMs, resolvedRef);
  rememberMacOsBrowserPageHandle(product, resolvedRef, page);
  return { page, attachment };
}

export async function closeMacOsBrowserOwnedTab(
  product: MacOsBrowserProduct,
  ref: MacOsBrowserTabRef,
  timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
): Promise<void> {
  const browser = browserDefinition(product);
  try {
    const resolvedRef = await resolveCurrentMacOsBrowserTabRef(product, ref, timeoutMs);
    await runBrowserAutomationText(
      { action: 'close_tab', product, ref: resolvedRef },
      closeOwnedTabScript(browser, resolvedRef),
      [],
      timeoutMs,
    );
  } finally {
    invalidateMacOsBrowserPageHandle(product, ref);
  }
}
