import { execFile } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import {
  callBrowserAutomationBroker,
  captureBrowserAutomationRegion,
  type BrowserAutomationBrokerAction,
} from './browser-automation-service';
import { AssistantPluginError } from './errors';

const RECORD_SEPARATOR = String.fromCharCode(30);
const DEFAULT_NATIVE_TIMEOUT_MS = 5_000;
const MAX_NATIVE_OUTPUT_BYTES = 1_048_576;

export type MacOsBrowserProduct = 'chrome' | 'vivaldi';

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
}

export interface MacOsBrowserAttachAttempt {
  product: MacOsBrowserProduct;
  appName: string;
  bundleId: string;
  status: 'selected' | 'available' | 'not_installed' | 'not_running' | 'unavailable';
  frontmost?: boolean;
  error?: string;
}

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
  captureRegion?: (region: { x: number; y: number; width: number; height: number }, path: string, timeoutMs: number) => Promise<Buffer>;
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

let runtimeHooks: MacOsBrowserRuntimeHooks = { ...defaultRuntimeHooks };
let lastAttachObservation: MacOsBrowserAttachObservation | undefined;

export function setMacOsBrowserRuntimeHooksForTest(hooks: Partial<MacOsBrowserRuntimeHooks>): void {
  runtimeHooks = { ...defaultRuntimeHooks, ...hooks };
}

export function resetMacOsBrowserRuntimeHooksForTest(): void {
  runtimeHooks = { ...defaultRuntimeHooks };
  lastAttachObservation = undefined;
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
return (frontmost as text) & separator & (URL of targetTab as text) & separator & (title of targetTab as text) & separator & ((item 1 of windowBounds) as text) & separator & ((item 2 of windowBounds) as text) & separator & ((item 3 of windowBounds) as text) & separator & ((item 4 of windowBounds) as text)
`);
}

function targetTabPreamble(ref: MacOsBrowserTabRef): string {
  return `set targetWindow to first window whose id is ${quotedAppleScript(ref.windowId)}\nset targetTab to first tab of targetWindow whose id is ${quotedAppleScript(ref.tabId)}`;
}

function targetMetadataScript(browser: MacOsBrowserDefinition, ref: MacOsBrowserTabRef): string {
  return browserTellScript(browser, `
${targetTabPreamble(ref)}
set windowBounds to bounds of targetWindow
set separator to ASCII character 30
set targetIsActive to ((id of active tab of targetWindow) is (id of targetTab))
return (frontmost as text) & separator & (URL of targetTab as text) & separator & (title of targetTab as text) & separator & ((item 1 of windowBounds) as text) & separator & ((item 2 of windowBounds) as text) & separator & ((item 3 of windowBounds) as text) & separator & ((item 4 of windowBounds) as text) & separator & "" & separator & "" & separator & (targetIsActive as text)
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
      return JSON.stringify({ ok: true, value: value === undefined ? { __forgeUndefined: true } : value });
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

export class MacOsAppleEventsPage {
  private metadata: MacOsBrowserMetadata;
  private readonly browser: MacOsBrowserDefinition;
  private readonly timeoutMs: number;
  private readonly targetRef?: MacOsBrowserTabRef;

  constructor(attachment: MacOsBrowserAttachment, timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS, targetRef?: MacOsBrowserTabRef) {
    this.metadata = { ...attachment.metadata, ...(targetRef ? { windowId: targetRef.windowId, tabId: targetRef.tabId } : {}) };
    this.browser = browserDefinition(attachment.metadata.product);
    this.timeoutMs = timeoutMs;
    this.targetRef = targetRef;
  }

  private async runAutomation(
    request: BrowserAutomationBrokerAction,
    script: string,
    args: string[] = [],
    timeoutMs = this.timeoutMs,
  ): Promise<string> {
    try {
      return await runBrowserAutomationText(request, script, args, timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AssistantPluginError('PLUGIN_BROWSER_NATIVE_OPERATION_FAILED', `${this.browser.appName} Apple Events operation failed: ${message}`, {
        retryable: true,
        details: { browserProduct: this.browser.product, bundleId: this.browser.bundleId },
      });
    }
  }

  private async refreshMetadata(): Promise<MacOsBrowserMetadata> {
    const script = this.targetRef ? targetMetadataScript(this.browser, this.targetRef) : metadataScript(this.browser);
    this.metadata = parseMetadata(this.browser.product, await this.runAutomation(
      { action: 'metadata', product: this.browser.product, ...(this.targetRef ? { ref: this.targetRef } : {}) },
      script,
    ));
    return this.metadata;
  }

  private async executeJavaScriptRaw(source: string, timeoutMs = this.timeoutMs): Promise<string> {
    try {
      return await this.runAutomation(
        { action: 'execute_javascript', product: this.browser.product, ...(this.targetRef ? { ref: this.targetRef } : {}), source },
        executeJavaScriptScript(this.browser, this.targetRef),
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

  async goto(url: string, options: Record<string, unknown> = {}): Promise<unknown> {
    const timeout = typeof options.timeout === 'number' ? Math.trunc(options.timeout) : this.timeoutMs;
    await this.runAutomation(
      { action: 'navigate', product: this.browser.product, ...(this.targetRef ? { ref: this.targetRef } : {}), url },
      navigateScript(this.browser, this.targetRef),
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
      reloadScript(this.browser, this.targetRef),
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
    return (await this.refreshMetadata()).title;
  }

  url(): string {
    return this.metadata.url;
  }

  async content(): Promise<string> {
    return await this.evaluate<string>('document.documentElement ? document.documentElement.outerHTML : ""');
  }

  async evaluate<T>(expression: string | ((...args: unknown[]) => unknown), arg?: unknown): Promise<T> {
    const raw = await this.executeJavaScriptRaw(serializeEvaluation(expression, arg));
    let parsed: { ok?: boolean; value?: unknown; error?: string };
    try {
      parsed = JSON.parse(raw) as { ok?: boolean; value?: unknown; error?: string };
    } catch {
      throw new AssistantPluginError('PLUGIN_BROWSER_NATIVE_PROTOCOL_ERROR', `${this.browser.appName} returned an invalid JavaScript result.`, {
        retryable: true,
      });
    }
    if (!parsed.ok) throw new Error(parsed.error || 'Browser JavaScript evaluation failed.');
    if (parsed.value && typeof parsed.value === 'object' && (parsed.value as { __forgeUndefined?: unknown }).__forgeUndefined === true) {
      return undefined as T;
    }
    return parsed.value as T;
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
    await this.evaluate(selectorSource(selector, 'if (typeof element.click !== "function") throw new Error("Element is not clickable."); element.click(); return true;'));
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
      for (const option of element.options) option.selected = selected.has(option.value) || selected.has(option.label);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return Array.from(element.selectedOptions).map((option) => option.value);
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
    const deadline = Date.now() + timeout;
    while (Date.now() <= deadline) {
      try {
        const readyState = await this.evaluate<string>('document.readyState');
        if (state === 'load' || state === 'networkidle') {
          if (readyState === 'complete') return;
        } else if (readyState === 'interactive' || readyState === 'complete') return;
      } catch (error) {
        if (error instanceof AssistantPluginError && error.code === 'PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED') {
          const metadata = await this.refreshMetadata();
          if (metadata.url && metadata.url !== 'about:blank' && metadata.url !== 'chrome://newtab/' && metadata.url !== 'vivaldi://newtab/') return;
        }
        // Navigation can transiently invalidate the current JavaScript execution context.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timeout waiting for browser load state ${state}.`);
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

export async function readMacOsBrowserOwnedTabMetadata(
  product: MacOsBrowserProduct,
  ref: MacOsBrowserTabRef,
  timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
): Promise<MacOsBrowserMetadata> {
  const browser = browserDefinition(product);
  return parseMetadata(product, await runBrowserAutomationText(
    { action: 'metadata', product, ref },
    targetMetadataScript(browser, ref),
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
  await runBrowserAutomationText(
    { action: 'activate', product, ref },
    activateTargetTabScript(browser, ref),
    [],
    timeoutMs,
  );
  return readMacOsBrowserOwnedTabMetadata(product, ref, timeoutMs);
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
  const raw = await runBrowserAutomationText(
    { action: 'create_tab', product: attachment.metadata.product, url },
    createOwnedTabScript(browser),
    [url],
    timeoutMs,
  );
  const parts = raw.split(RECORD_SEPARATOR);
  if (parts.length < 2) throw new Error(`Browser scripting returned incomplete owned-tab metadata for ${browser.appName}.`);
  const ref = { windowId: parseBrowserId(parts[0] ?? '', 'window id'), tabId: parseBrowserId(parts[1] ?? '', 'tab id') };
  return new MacOsAppleEventsPage({
    ...attachment,
    metadata: { ...attachment.metadata, url, title: '', windowId: ref.windowId, tabId: ref.tabId, active: false },
  }, timeoutMs, ref);
}

export function createMacOsBrowserOwnedPageFromRef(
  attachment: MacOsBrowserAttachment,
  ref: MacOsBrowserTabRef,
  timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
): MacOsAppleEventsPage {
  return new MacOsAppleEventsPage(attachment, timeoutMs, ref);
}

export async function closeMacOsBrowserOwnedTab(
  product: MacOsBrowserProduct,
  ref: MacOsBrowserTabRef,
  timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
): Promise<void> {
  const browser = browserDefinition(product);
  await runBrowserAutomationText(
    { action: 'close_tab', product, ref },
    closeOwnedTabScript(browser, ref),
    [],
    timeoutMs,
  );
}
