import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';
import { AssistantPluginError, toAssistantPluginError } from './errors';
import {
  interactionAutomationEngine,
  interactionMayOwnTarget,
  isInteractionSessionActive,
  listInteractionSessions,
  patchInteractionSession,
  pruneInteractionSessions,
  readInteractionSession,
  writeInteractionSession,
  type InteractionSessionRecord,
} from './interaction-session';
import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginCapability,
} from './types';
import { executeRemoteXpcHidInput, prewarmRemoteXpcHid, remoteXpcHidStatus } from './ios/remote-xpc-hid';

const PROVIDER = 'ios-device' as const;
const SESSION_EXPIRY_MS = 2 * 60 * 60_000;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_EVENTS = 200;

interface CommandResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  command: string[];
}

interface CommandOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface IosPhysicalDeviceRuntimeHooks {
  platform(): NodeJS.Platform;
  now(): Date;
  runCommand(command: string, args: string[], options?: CommandOptions): CommandResult;
}

const defaultHooks: IosPhysicalDeviceRuntimeHooks = {
  platform: () => process.platform,
  now: () => new Date(),
  runCommand: (command, args, options = {}) => {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? result.error?.message ?? ''),
      command: [command, ...args],
    };
  },
};

let hooks: IosPhysicalDeviceRuntimeHooks = { ...defaultHooks };

export function setIosPhysicalDeviceRuntimeHooksForTest(overrides: Partial<IosPhysicalDeviceRuntimeHooks>): void {
  hooks = { ...defaultHooks, ...overrides };
}

export function resetIosPhysicalDeviceRuntimeHooksForTest(): void {
  hooks = { ...defaultHooks };
}

interface PhysicalDevice {
  identifier: string;
  udid?: string;
  name: string;
  model?: string;
  productType?: string;
  osVersion?: string;
  osBuild?: string;
  pairingState?: string;
  tunnelState?: string;
  transportType?: string;
  bootState?: string;
  developerMode?: string;
  ddiServicesAvailable: boolean;
  screenshotAvailable: boolean;
  connected: boolean;
}

interface PhysicalDeviceCapabilitySummary {
  applicationControl: boolean;
  screenshot: boolean;
  displayInfo: boolean;
  lockState: boolean;
  viewDeviceScreen: boolean;
  hidDigitizer: boolean;
  hidKeyboard: boolean;
  hidScroll: boolean;
  hidButton: boolean;
  universalHid: boolean;
}

interface InstalledApp {
  name: string;
  bundleIdentifier: string;
  bundleVersion?: string;
  version?: string;
  removable?: boolean;
}

interface PhysicalEvent {
  at: string;
  type: string;
  details?: unknown;
}

interface PhysicalSessionState {
  schemaVersion: 1;
  interactionId: string;
  device: PhysicalDevice;
  bundleId: string;
  events: PhysicalEvent[];
}

function timestamp(): string {
  return hooks.now().toISOString();
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'ios-device';
}

function controllerRoot(input: AssistantPluginActionExecutionInput): string {
  return repositoryControllerRoot(input.controllerHome, input.repoId);
}

function providerRoot(input: AssistantPluginActionExecutionInput): string {
  const path = join(controllerRoot(input), 'interactions', 'ios-physical-device');
  mkdirSync(path, { recursive: true });
  return path;
}

function statePath(input: AssistantPluginActionExecutionInput, interactionId: string): string {
  return join(providerRoot(input), 'state', `${sanitize(interactionId)}.json`);
}

function artifactDir(input: AssistantPluginActionExecutionInput, interactionId: string): string {
  const path = join(controllerRoot(input), 'artifacts', 'ios', 'physical-device', sanitize(interactionId));
  mkdirSync(path, { recursive: true });
  return path;
}

function readState(input: AssistantPluginActionExecutionInput, interactionId: string): PhysicalSessionState | undefined {
  const value = readJsonFile<PhysicalSessionState | undefined>(statePath(input, interactionId), undefined);
  return value?.schemaVersion === 1 && value.interactionId === interactionId ? value : undefined;
}

function writeState(input: AssistantPluginActionExecutionInput, state: PhysicalSessionState): PhysicalSessionState {
  writeJsonAtomic(statePath(input, state.interactionId), state);
  return state;
}

function redacted(value: unknown, key = ''): unknown {
  if (/^(text|value|password|passcode|token|authorization|cookie)$/i.test(key)) return '<redacted>';
  if (Array.isArray(value)) return value.map((entry) => redacted(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([entryKey, entry]) => [entryKey, redacted(entry, entryKey)]));
  }
  return value;
}

function bounded(value: unknown): unknown {
  const safe = redacted(value);
  const text = JSON.stringify(safe);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= MAX_JSON_BYTES) return safe;
  return {
    truncated: true,
    byteLength: bytes,
    preview: Buffer.from(text, 'utf8').subarray(0, MAX_JSON_BYTES).toString('utf8'),
  };
}

function appendEvent(
  input: AssistantPluginActionExecutionInput,
  interactionId: string,
  type: string,
  details?: unknown,
): PhysicalSessionState | undefined {
  const state = readState(input, interactionId);
  if (!state) return undefined;
  state.events.push({ at: timestamp(), type, details: redacted(details) });
  state.events = state.events.slice(-MAX_EVENTS);
  return writeState(input, state);
}

function requireString(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `${name} is required.`, { retryable: false });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requireFiniteNumber(value: unknown, name: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `${name} must be a finite number.`, { retryable: false });
}

function requireBundleId(value: unknown): string {
  const bundleId = requireString(value, 'bundle_id');
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(bundleId) || !bundleId.includes('.') || /^[a-z][a-z0-9+.-]*:\/\//i.test(bundleId)) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'bundle_id must be an installed application bundle identifier, not a URL or deep link.', { retryable: false });
  }
  return bundleId;
}

function commandFailure(result: CommandResult, code: string, fallback: string): never {
  throw new AssistantPluginError(code, result.stderr.trim() || result.stdout.trim() || fallback, {
    retryable: false,
    details: {
      status: result.status,
      command: result.command,
      stdout: result.stdout.slice(0, 8_000),
      stderr: result.stderr.slice(0, 8_000),
    },
  });
}

function runCoreJson(
  input: AssistantPluginActionExecutionInput,
  args: string[],
  code: string,
  timeoutMs = 30_000,
): Record<string, unknown> {
  if (hooks.platform() !== 'darwin') {
    throw new AssistantPluginError('PLUGIN_DEPENDENCY_MISSING', 'Physical iOS device support requires macOS and Xcode CoreDevice.', { retryable: false });
  }
  const result = hooks.runCommand('xcrun', ['devicectl', ...args, '--json-output', '-'], {
    cwd: input.repoRoot,
    timeoutMs,
  });
  if (!result.ok) return commandFailure(result, code, 'CoreDevice command failed.');
  let parsed: Record<string, unknown> | undefined;
  try {
    const value = JSON.parse(result.stdout.trim());
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    // Structured error below.
  }
  const info = parsed?.info && typeof parsed.info === 'object' ? parsed.info as Record<string, unknown> : undefined;
  if (!parsed || info?.outcome === 'failure') return commandFailure(result, code, 'CoreDevice returned invalid JSON.');
  return parsed;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' && String(value[key]).trim() ? String(value[key]).trim() : undefined;
}

function capabilityNames(value: unknown): string[] {
  return (Array.isArray(value) ? value : [])
    .map((entry) => stringField(objectValue(entry), 'name'))
    .filter((entry): entry is string => Boolean(entry));
}

function capabilitySummary(names: string[]): PhysicalDeviceCapabilitySummary {
  const features = new Set(names);
  return {
    applicationControl: features.has('Application Control') || features.has('Launch Application'),
    screenshot: features.has('Capture Screenshot'),
    displayInfo: features.has('Get Display Information'),
    lockState: features.has('Get Lock State'),
    viewDeviceScreen: features.has('View Device Screen'),
    hidDigitizer: features.has('HID Digitizer'),
    hidKeyboard: features.has('HID Keyboard'),
    hidScroll: features.has('HID Scroll'),
    hidButton: features.has('HID Button'),
    universalHid: features.has('Universal HID Service Pool') || features.has('UniversalHIDService'),
  };
}

function physicalDevices(input: AssistantPluginActionExecutionInput): PhysicalDevice[] {
  const response = runCoreJson(input, ['list', 'devices'], 'IOS_DEVICE_LIST_FAILED');
  const result = objectValue(response.result);
  const entries = Array.isArray(result.devices) ? result.devices : [];
  return entries
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    .map((entry) => {
      const hardware = objectValue(entry.hardwareProperties);
      const device = objectValue(entry.deviceProperties);
      const connection = objectValue(entry.connectionProperties);
      const capabilities = capabilityNames(entry.capabilities);
      const pairingState = stringField(connection, 'pairingState');
      const tunnelState = stringField(connection, 'tunnelState');
      const bootState = stringField(device, 'bootState');
      return {
        identifier: stringField(entry, 'identifier') ?? '',
        udid: stringField(hardware, 'udid'),
        name: stringField(device, 'name') ?? '',
        model: stringField(hardware, 'marketingName'),
        productType: stringField(hardware, 'productType'),
        osVersion: stringField(device, 'osVersionNumber'),
        osBuild: stringField(device, 'osBuildUpdate'),
        pairingState,
        tunnelState,
        transportType: stringField(connection, 'transportType'),
        bootState,
        developerMode: stringField(device, 'developerModeStatus'),
        ddiServicesAvailable: device.ddiServicesAvailable === true,
        screenshotAvailable: capabilities.includes('Capture Screenshot'),
        connected: pairingState === 'paired'
          && bootState !== 'shutdown'
          && (tunnelState === 'connected'
            || device.ddiServicesAvailable === true
            || capabilities.includes('Application Control')
            || capabilities.includes('Launch Application')
            || connection.transportType === 'usb'
            || connection.transportType === 'wired'),
        reality: stringField(hardware, 'reality'),
        platform: stringField(hardware, 'platform'),
      } as PhysicalDevice & { reality?: string; platform?: string };
    })
    .filter((entry) => entry.identifier && entry.name
      && (entry as PhysicalDevice & { reality?: string }).reality === 'physical'
      && (entry as PhysicalDevice & { platform?: string }).platform === 'iOS')
    .map(({ reality: _reality, platform: _platform, ...entry }) => entry);
}

function selectDevice(input: AssistantPluginActionExecutionInput, selectorValue: unknown): PhysicalDevice {
  const selector = requireString(selectorValue, 'device');
  const inventory = physicalDevices(input);
  const matches = inventory.filter((entry) => entry.identifier === selector || entry.udid === selector || entry.name === selector);
  if (matches.length === 0) {
    throw new AssistantPluginError('IOS_DEVICE_NOT_FOUND', 'No paired physical iPhone matches the exact device selector.', {
      retryable: false,
      details: { selector, available: inventory.map((entry) => ({ identifier: entry.identifier, name: entry.name, connected: entry.connected })) },
    });
  }
  if (matches.length !== 1) {
    throw new AssistantPluginError('IOS_DEVICE_AMBIGUOUS', 'The physical iPhone selection is ambiguous; provide the exact CoreDevice identifier or UDID.', {
      retryable: false,
      details: { selector, matches: matches.map((entry) => ({ identifier: entry.identifier, name: entry.name })) },
    });
  }
  const selected = matches[0]!;
  if (selected.pairingState !== 'paired') {
    throw new AssistantPluginError('IOS_DEVICE_NOT_PAIRED', 'The selected iPhone is not paired with this Mac.', { retryable: false, details: { device: selected } });
  }
  return selected;
}

function physicalDeviceLockState(input: AssistantPluginActionExecutionInput, device: PhysicalDevice): Record<string, unknown> {
  const response = runCoreJson(input, [
    'device', 'info', 'lockState', '--device', device.identifier,
  ], 'IOS_DEVICE_LOCK_STATE_FAILED', 30_000);
  return objectValue(response.result);
}

function requirePhysicalDeviceUnlocked(input: AssistantPluginActionExecutionInput, device: PhysicalDevice): void {
  const lockState = physicalDeviceLockState(input, device);
  if (lockState.passcodeRequired !== true) return;
  throw new AssistantPluginError(
    'IOS_DEVICE_LOCKED',
    `The selected iPhone ${device.name} is locked. Unlock it before launching an app through CoreDevice.`,
    {
      retryable: true,
      details: {
        device: { identifier: device.identifier, name: device.name },
        lockState: bounded(lockState),
      },
    },
  );
}

function physicalDisplayGeometry(input: AssistantPluginActionExecutionInput, device: PhysicalDevice): { width: number; height: number; pointScale?: number } {
  const displayResponse = runCoreJson(input, [
    'device', 'info', 'displays', '--device', device.identifier,
  ], 'IOS_DEVICE_DISPLAY_INFO_FAILED', 30_000);
  const result = objectValue(displayResponse.result);
  const displays = Array.isArray(result.displays) ? result.displays : [];
  const rows = displays.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry));
  const primary = rows.find((entry) => entry.primary === true) ?? rows[0];
  if (!primary) {
    throw new AssistantPluginError('IOS_HID_DISPLAY_INVALID', 'CoreDevice did not report a usable iPhone display for input coordinate mapping.', { retryable: true });
  }
  const bounds = Array.isArray(primary.bounds) ? primary.bounds : undefined;
  const size = bounds && Array.isArray(bounds[1]) ? bounds[1] : Array.isArray(primary.nativeSize) ? primary.nativeSize : undefined;
  const width = Number(size?.[0]);
  const height = Number(size?.[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 1 || height <= 1) {
    throw new AssistantPluginError('IOS_HID_DISPLAY_INVALID', 'CoreDevice returned invalid display dimensions for input coordinate mapping.', {
      retryable: true,
      details: { display: bounded(primary) },
    });
  }
  return {
    width: Math.trunc(width),
    height: Math.trunc(height),
    pointScale: typeof primary.pointScale === 'number' && Number.isFinite(primary.pointScale) ? primary.pointScale : undefined,
  };
}

function physicalDeviceInfo(input: AssistantPluginActionExecutionInput, device: PhysicalDevice): Record<string, unknown> {
  const detailsResponse = runCoreJson(input, [
    'device', 'info', 'details', '--device', device.identifier,
  ], 'IOS_DEVICE_DETAILS_FAILED', 60_000);
  const details = objectValue(detailsResponse.result);
  const deviceProperties = objectValue(details.deviceProperties);
  const names = capabilityNames(details.capabilities);

  const lockState = physicalDeviceLockState(input, device);
  const displayResponse = runCoreJson(input, [
    'device', 'info', 'displays', '--device', device.identifier,
  ], 'IOS_DEVICE_DISPLAY_INFO_FAILED', 30_000);

  return {
    device,
    capabilities: capabilitySummary(names),
    capabilityCount: names.length,
    screenViewingURL: stringField(deviceProperties, 'screenViewingURL'),
    lockState: bounded(lockState),
    displays: bounded(displayResponse.result),
    inputBackend: remoteXpcHidStatus(input.controllerHome),
  };
}

function installedApps(
  input: AssistantPluginActionExecutionInput,
  device: PhysicalDevice,
  bundleId: string,
): InstalledApp[] {
  let response: Record<string, unknown>;
  try {
    response = runCoreJson(input, [
      'device', 'info', 'apps', '--device', device.identifier,
      '--include-all-apps', '--bundle-id', bundleId,
    ], 'IOS_DEVICE_APPS_FAILED', 60_000);
  } catch (error) {
    if (!device.connected) {
      throw new AssistantPluginError('IOS_DEVICE_UNAVAILABLE', 'The selected iPhone is paired but its CoreDevice connection is currently unavailable. Unlock the phone and restore its USB or local-network connection, then retry.', {
        retryable: true,
        details: { device: { identifier: device.identifier, name: device.name, pairingState: device.pairingState, tunnelState: device.tunnelState, transportType: device.transportType } },
      });
    }
    throw error;
  }
  const result = objectValue(response.result);
  const entries = Array.isArray(result.apps) ? result.apps : [];
  return entries
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    .map((entry) => ({
      name: stringField(entry, 'name') ?? '',
      bundleIdentifier: stringField(entry, 'bundleIdentifier') ?? '',
      bundleVersion: stringField(entry, 'bundleVersion'),
      version: stringField(entry, 'version'),
      removable: typeof entry.removable === 'boolean' ? entry.removable : undefined,
    }))
    .filter((entry) => entry.bundleIdentifier === bundleId);
}

function requireRecord(input: AssistantPluginActionExecutionInput, allowTerminal = false): { record: InteractionSessionRecord; state: PhysicalSessionState } {
  const interactionId = requireString(input.args.interaction_id, 'interaction_id');
  const record = readInteractionSession(input.repoRoot, PROVIDER, interactionId);
  if (!record) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Unknown physical iOS interaction: ${interactionId}`, { retryable: false });
  }
  const engine = interactionAutomationEngine(record);
  if (engine !== 'coredevice') {
    throw new AssistantPluginError(
      'PLUGIN_ACTION_ARGUMENT_INVALID',
      `Physical iOS interaction ${interactionId} belongs to ${engine ?? 'an unknown engine'}, not the CoreDevice engine.`,
      { retryable: false, details: { interactionId, expectedEngine: 'coredevice', actualEngine: engine } },
    );
  }
  const state = readState(input, interactionId);
  if (!state) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Unknown physical iOS interaction state: ${interactionId}`, { retryable: false });
  }
  if (!isInteractionSessionActive(record.status) && !allowTerminal) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Physical iOS interaction is ${record.status}.`, {
      retryable: false, details: { interactionId, status: record.status },
    });
  }
  if (isInteractionSessionActive(record.status) && hooks.now().getTime() >= Date.parse(record.expiresAt)) {
    patchInteractionSession(input.repoRoot, PROVIDER, interactionId, {
      status: 'failed',
      error: { code: 'IOS_DEVICE_SESSION_EXPIRED', message: 'The physical iOS interaction expired.' },
    });
    throw new AssistantPluginError('IOS_DEVICE_SESSION_EXPIRED', 'The physical iOS interaction expired; open a new session.', { retryable: false });
  }
  return { record, state };
}

export function iosPhysicalDeviceStatus() {
  if (hooks.platform() !== 'darwin') {
    return {
      available: false,
      platform: hooks.platform(),
      coreDeviceReady: false,
      reason: 'Physical iOS device support requires macOS and Xcode.',
    };
  }
  const result = hooks.runCommand('xcrun', ['devicectl', '--version'], { timeoutMs: 5_000 });
  return {
    available: result.ok,
    platform: hooks.platform(),
    coreDeviceReady: result.ok,
    devicectlVersion: result.ok ? result.stdout.trim() : undefined,
    reason: result.ok ? undefined : (result.stderr || result.stdout || 'xcrun devicectl is unavailable.'),
  };
}

export function isIosPhysicalDeviceAction(actionId: string): boolean {
  return actionId.startsWith('physical_device_');
}

export function iosPhysicalDeviceCapabilities(): AssistantPluginCapability[] {
  return [{
    capabilityId: 'ios-physical-device',
    title: 'Physical iOS Computer Use',
    description: 'CoreDevice lifecycle/observation plus runnerless RemoteXPC HID input for physical iPhones. XCTest remains only an explicit semantic fallback.',
    scopes: ['ios.discover', 'ios.device'],
    actions: iosPhysicalDeviceActions().map((action) => action.actionId),
  }];
}

export function iosPhysicalDeviceActions(): AssistantPluginActionDescriptor[] {
  const stateClaim = [{ resource: 'repo-state' as const, mode: 'write' as const }];
  const mutationClaims = [
    { resource: 'workspace' as const, mode: 'write' as const },
    { resource: 'repo-state' as const, mode: 'write' as const },
  ];
  const interactionProperty = { interaction_id: { type: 'string' } };
  return [
    {
      actionId: 'physical_device_status', title: 'Physical iOS device status',
      description: 'Report CoreDevice readiness. This provider has no XCTest/WDA Runner lifecycle.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 30_000, cancellable: true, idempotent: true,
      scopes: ['ios.discover'], resourceClaims: [], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: 'physical_device_list', title: 'List paired physical iPhones',
      description: 'List bounded CoreDevice metadata for paired physical iOS devices; serial numbers and ECIDs are omitted.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 30_000, cancellable: true, idempotent: true,
      scopes: ['ios.discover'], resourceClaims: [], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: 'physical_device_info', title: 'Inspect physical iPhone capabilities',
      description: 'Read CoreDevice details, lock state, display metadata, View Device Screen URL, and HID capability availability without starting a Runner.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 90_000, cancellable: true, idempotent: true,
      scopes: ['ios.device'], resourceClaims: [],
      argumentsSchema: { type: 'object', properties: { device: { type: 'string' } }, required: ['device'], additionalProperties: false },
    },
    {
      actionId: 'physical_device_apps', title: 'Find installed physical-device app',
      description: 'Verify one exact bundle identifier is installed on an exact paired iPhone without reading its data container.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['ios.device'], resourceClaims: stateClaim,
      argumentsSchema: { type: 'object', properties: { device: { type: 'string' }, bundle_id: { type: 'string' } }, required: ['device', 'bundle_id'], additionalProperties: false },
    },
    {
      actionId: 'physical_device_open', title: 'Open physical iOS app session',
      description: 'Launch one installed third-party app through CoreDevice and create a bounded interaction session. Optionally start a nonblocking runnerless HID warmup. This action never starts, installs, probes, or attaches an XCTest/WDA Runner.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 2 * 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.device'], resourceClaims: mutationClaims,
      argumentsSchema: { type: 'object', properties: { device: { type: 'string' }, bundle_id: { type: 'string' }, relaunch: { type: 'boolean' }, prewarm_input: { type: 'boolean' } }, required: ['device', 'bundle_id'], additionalProperties: false },
    },
    {
      actionId: 'physical_device_screenshot', title: 'Capture physical iOS screenshot',
      description: 'Capture the exact paired iPhone display through CoreDevice into Controller-owned bounded artifact storage.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.device'], resourceClaims: mutationClaims,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, label: { type: 'string' } }, required: ['interaction_id'], additionalProperties: false },
    },
    {
      actionId: 'physical_device_tap', title: 'Tap physical iPhone coordinate',
      description: 'Send one runnerless touch through the existing macOS trusted CoreDevice/RemoteXPC tunnel. Coordinates are pixels in the current CoreDevice screenshot/display space.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false,
      scopes: ['ios.device'], resourceClaims: mutationClaims,
      argumentsSchema: {
        type: 'object',
        properties: { ...interactionProperty, x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 } },
        required: ['interaction_id', 'x', 'y'], additionalProperties: false,
      },
    },
    {
      actionId: 'physical_device_swipe', title: 'Swipe physical iPhone',
      description: 'Send one runnerless touchscreen swipe through RemoteXPC HID using current CoreDevice display pixels.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false,
      scopes: ['ios.device'], resourceClaims: mutationClaims,
      argumentsSchema: {
        type: 'object',
        properties: {
          ...interactionProperty,
          x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 },
          to_x: { type: 'number', minimum: 0 }, to_y: { type: 'number', minimum: 0 },
          duration_ms: { type: 'number', minimum: 80, maximum: 3000 },
        },
        required: ['interaction_id', 'x', 'y', 'to_x', 'to_y'], additionalProperties: false,
      },
    },
    {
      actionId: 'physical_device_type_text', title: 'Type physical iPhone text',
      description: 'Type bounded ASCII text through a reusable runnerless RemoteXPC HID keyboard. Unicode is rejected until a separate pasteboard/input-method backend is proven on the active iOS version.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false,
      scopes: ['ios.device'], resourceClaims: mutationClaims,
      argumentsSchema: {
        type: 'object',
        properties: { ...interactionProperty, text: { type: 'string', maxLength: 2048 } },
        required: ['interaction_id', 'text'], additionalProperties: false,
      },
    },
    {
      actionId: 'physical_device_events', title: 'Read physical iOS events',
      description: 'Read bounded, redacted provider events without input text or credentials.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 30_000, cancellable: true, idempotent: true,
      scopes: ['ios.device'], resourceClaims: stateClaim,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, limit: { type: 'number' } }, required: ['interaction_id'], additionalProperties: false },
    },
    {
      actionId: 'physical_device_close', title: 'Close physical iOS session',
      description: 'Release Controller ownership without shutting down or modifying the iPhone. No XCTest/WDA Runner is owned by this provider.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['ios.device'], resourceClaims: mutationClaims,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty }, required: ['interaction_id'], additionalProperties: false },
    },
  ];
}

export async function executeIosPhysicalDeviceAction(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  if (input.actionId === 'physical_device_status') {
    return { provider: 'coredevice', ...iosPhysicalDeviceStatus() };
  }
  const status = iosPhysicalDeviceStatus();
  if (!status.coreDeviceReady) {
    throw new AssistantPluginError('PLUGIN_DEPENDENCY_MISSING', status.reason ?? 'Xcode CoreDevice is unavailable.', { retryable: false, details: status });
  }
  if (input.actionId === 'physical_device_list') {
    return { provider: 'coredevice', devices: physicalDevices(input) };
  }
  if (input.actionId === 'physical_device_info') {
    const selected = selectDevice(input, input.args.device);
    return { provider: 'coredevice', ...physicalDeviceInfo(input, selected) };
  }
  if (input.actionId === 'physical_device_apps') {
    const selected = selectDevice(input, input.args.device);
    const bundleId = requireBundleId(input.args.bundle_id);
    return { provider: 'coredevice', device: selected, apps: installedApps(input, selected, bundleId) };
  }
  if (input.actionId === 'physical_device_open') {
    const selected = selectDevice(input, input.args.device);
    const bundleId = requireBundleId(input.args.bundle_id);
    const apps = installedApps(input, selected, bundleId);
    if (apps.length !== 1) {
      throw new AssistantPluginError('IOS_DEVICE_APP_NOT_INSTALLED', `The app ${bundleId} is not installed on the selected iPhone.`, { retryable: false });
    }
    requirePhysicalDeviceUnlocked(input, selected);
    const selectedAliases = [selected.identifier, selected.udid];
    const conflict = listInteractionSessions(input.repoRoot, PROVIDER).find((entry) =>
      isInteractionSessionActive(entry.status) && interactionMayOwnTarget(entry, selectedAliases));
    if (conflict) {
      throw new AssistantPluginError('PLUGIN_RESOURCE_BUSY', 'The selected iPhone already has an active forge interaction.', {
        retryable: true,
        details: {
          interactionId: conflict.interactionId,
          targetId: conflict.targetId,
          resourceProvider: conflict.provider,
          automationEngine: interactionAutomationEngine(conflict),
        },
      });
    }
    pruneInteractionSessions(input.repoRoot, PROVIDER, 100);
    const interactionId = `ios_device_${randomUUID()}`;
    const createdAt = timestamp();
    const record: InteractionSessionRecord = {
      schemaVersion: 1,
      interactionId,
      provider: PROVIDER,
      engine: 'coredevice',
      sessionId: `forge-${sanitize(interactionId).slice(-40)}`,
      targetId: selected.identifier,
      targetAliases: selectedAliases.filter((value): value is string => Boolean(value)),
      status: 'starting',
      reason: 'ios_physical_device_automation',
      instructions: bundleId,
      owner: { repoId: input.repoId, requestId: input.requestId, jobId: input.jobId },
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(hooks.now().getTime() + SESSION_EXPIRY_MS).toISOString(),
    };
    writeInteractionSession(input.repoRoot, record);
    const state: PhysicalSessionState = {
      schemaVersion: 1,
      interactionId,
      device: selected,
      bundleId,
      events: [{ at: createdAt, type: 'session_created', details: { bundleId, deviceIdentifier: selected.identifier } }],
    };
    writeState(input, state);
    try {
      const args = ['device', 'process', 'launch', '--device', selected.identifier];
      if (input.args.relaunch === true) args.push('--terminate-existing');
      args.push(bundleId);
      const launch = runCoreJson(input, args, 'IOS_DEVICE_LAUNCH_FAILED', 60_000);
      appendEvent(input, interactionId, 'app_launched', { bundleId, relaunch: input.args.relaunch === true });
      const inputPrewarm = input.args.prewarm_input === true && selected.udid
        ? prewarmRemoteXpcHid({ controllerHome: input.controllerHome, deviceIdentifier: selected.identifier, udid: selected.udid })
        : { backend: 'remote-xpc-hid', state: 'not_requested', runnerOwned: false };
      // CoreDevice is the default physical-device substrate. Never probe, start,
      // build, install, or attach an XCTest/WDA runner during ordinary app open.
      // Semantic automation is an explicit opt-in action so repeated computer-use
      // workflows cannot accidentally create fresh Runner lifecycles.
      const active = patchInteractionSession(input.repoRoot, PROVIDER, interactionId, { status: 'waiting_for_user' }) ?? record;
      return {
        provider: 'coredevice',
        interaction: active,
        device: selected,
        app: apps[0],
        launch: bounded(launch),
        inputPrewarm,
        controlPlane: {
          lifecycle: 'coredevice',
          observation: 'coredevice',
          input: 'remote-xpc-hid',
          semanticFallback: 'agent-device',
          runnerOwned: false,
        },
      };
    } catch (error) {
      const normalized = toAssistantPluginError(error, {
        code: 'IOS_DEVICE_OPEN_FAILED',
        message: 'The physical iOS app could not be opened.',
        retryable: false,
      });
      patchInteractionSession(input.repoRoot, PROVIDER, interactionId, {
        status: 'failed',
        error: { code: normalized.code, message: normalized.message },
      });
      appendEvent(input, interactionId, 'open_failed', { code: normalized.code, message: normalized.message });
      throw normalized;
    }
  }

  const { record, state } = requireRecord(input, input.actionId === 'physical_device_close');
  const reactivateTargetApp = (): unknown => {
    const reactivation = runCoreJson(input, [
      'device', 'process', 'launch', '--device', state.device.identifier, state.bundleId,
    ], 'IOS_DEVICE_REACTIVATE_FAILED', 30_000);
    appendEvent(input, record.interactionId, 'app_reactivated', { bundleId: state.bundleId, terminateExisting: false });
    return bounded(reactivation);
  };
  switch (input.actionId) {
    case 'physical_device_screenshot': {
      const label = sanitize(optionalString(input.args.label) ?? 'screenshot');
      const path = join(artifactDir(input, record.interactionId), `${label}-${hooks.now().getTime()}.png`);
      const result = runCoreJson(input, [
        'device', 'capture', 'screenshot', '--device', state.device.identifier, '--destination', path,
      ], 'IOS_DEVICE_SCREENSHOT_FAILED', 60_000);
      if (!existsSync(path)) {
        throw new AssistantPluginError('IOS_DEVICE_SCREENSHOT_MISSING', 'CoreDevice succeeded without creating the requested screenshot.', { retryable: false });
      }
      appendEvent(input, record.interactionId, 'screenshot', { label });
      return {
        provider: 'coredevice', interaction: record, result: bounded(result),
        artifactCandidates: [{ kind: 'ios_physical_device_screenshot', mediaType: 'image/png', path }],
      };
    }
    case 'physical_device_tap': {
      requirePhysicalDeviceUnlocked(input, state.device);
      if (!state.device.udid) throw new AssistantPluginError('IOS_HID_UDID_MISSING', 'The selected iPhone does not expose a hardware UDID for RemoteXPC HID.', { retryable: false });
      const display = physicalDisplayGeometry(input, state.device);
      const x = requireFiniteNumber(input.args.x, 'x');
      const y = requireFiniteNumber(input.args.y, 'y');
      const foregroundFence = reactivateTargetApp();
      const result = await executeRemoteXpcHidInput({
        controllerHome: input.controllerHome,
        deviceIdentifier: state.device.identifier,
        udid: state.device.udid,
        width: display.width,
        height: display.height,
        action: 'tap', x, y,
      });
      appendEvent(input, record.interactionId, 'tap', { x, y, width: display.width, height: display.height, reusedWorker: result.reusedWorker });
      return { provider: 'coredevice', inputBackend: 'remote-xpc-hid', interaction: record, display, foregroundFence, result: bounded(result) };
    }
    case 'physical_device_swipe': {
      requirePhysicalDeviceUnlocked(input, state.device);
      if (!state.device.udid) throw new AssistantPluginError('IOS_HID_UDID_MISSING', 'The selected iPhone does not expose a hardware UDID for RemoteXPC HID.', { retryable: false });
      const display = physicalDisplayGeometry(input, state.device);
      const x = requireFiniteNumber(input.args.x, 'x');
      const y = requireFiniteNumber(input.args.y, 'y');
      const x2 = requireFiniteNumber(input.args.to_x, 'to_x');
      const y2 = requireFiniteNumber(input.args.to_y, 'to_y');
      const durationMs = typeof input.args.duration_ms === 'number' ? Math.trunc(input.args.duration_ms) : 250;
      const foregroundFence = reactivateTargetApp();
      const result = await executeRemoteXpcHidInput({
        controllerHome: input.controllerHome,
        deviceIdentifier: state.device.identifier,
        udid: state.device.udid,
        width: display.width,
        height: display.height,
        action: 'swipe', x, y, x2, y2, durationMs,
      });
      appendEvent(input, record.interactionId, 'swipe', { from: [x, y], to: [x2, y2], durationMs, reusedWorker: result.reusedWorker });
      return { provider: 'coredevice', inputBackend: 'remote-xpc-hid', interaction: record, display, foregroundFence, result: bounded(result) };
    }
    case 'physical_device_type_text': {
      requirePhysicalDeviceUnlocked(input, state.device);
      if (!state.device.udid) throw new AssistantPluginError('IOS_HID_UDID_MISSING', 'The selected iPhone does not expose a hardware UDID for RemoteXPC HID.', { retryable: false });
      const text = requireString(input.args.text, 'text');
      const display = physicalDisplayGeometry(input, state.device);
      const foregroundFence = reactivateTargetApp();
      const result = await executeRemoteXpcHidInput({
        controllerHome: input.controllerHome,
        deviceIdentifier: state.device.identifier,
        udid: state.device.udid,
        width: display.width,
        height: display.height,
        action: 'type', text,
      });
      appendEvent(input, record.interactionId, 'type_text', { length: text.length, reusedWorker: result.reusedWorker });
      return { provider: 'coredevice', inputBackend: 'remote-xpc-hid', interaction: record, foregroundFence, result: bounded(result), text: '<redacted>' };
    }
    case 'physical_device_events': {
      const limit = Math.max(1, Math.min(MAX_EVENTS, typeof input.args.limit === 'number' ? Math.trunc(input.args.limit) : 50));
      return { provider: 'coredevice', interaction: record, events: bounded(state.events.slice(-limit)) };
    }
    case 'physical_device_close': {
      const wasActive = isInteractionSessionActive(record.status);
      if (!wasActive) return { provider: 'coredevice', interaction: record, alreadyClosed: true, deviceUnmodified: true };
      patchInteractionSession(input.repoRoot, PROVIDER, record.interactionId, { status: 'closing' });
      appendEvent(input, record.interactionId, 'session_closed');
      const finalRecord = patchInteractionSession(input.repoRoot, PROVIDER, record.interactionId, { status: 'closed', error: undefined }) ?? record;
      return { provider: 'coredevice', interaction: finalRecord, deviceUnmodified: true };
    }
    default:
      throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', `ios/${input.actionId} is not supported.`, { retryable: false });
  }
}
