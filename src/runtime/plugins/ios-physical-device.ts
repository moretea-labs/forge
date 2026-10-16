import { createHash, randomUUID } from 'crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { performance } from 'perf_hooks';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { runBoundedProcess } from '../execution/thin-harness/async-process';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';
import { AssistantPluginError, toAssistantPluginError } from './errors';
import { ensureIosDeviceOwnership, iosCoreDeviceOwnershipId, releaseIosDeviceOwnership } from './ios-device-ownership';
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
  AssistantPluginAuthorizationContext,
  AssistantPluginAuthorizationTarget,
  AssistantPluginCapability,
} from './types';
import { executeRemoteXpcHidInput, prewarmRemoteXpcHid, remoteXpcHidStatus, stopRemoteXpcHidForDevice } from './ios/remote-xpc-hid';

const PROVIDER = 'ios-device' as const;
const SESSION_EXPIRY_MS = 2 * 60 * 60_000;
const CORE_DEVICE_READY_CACHE_MS = 5 * 60_000;
const INPUT_UNLOCK_CACHE_MS = 60_000;
const INPUT_DISPLAY_CACHE_MS = 5 * 60_000;
const INPUT_FOREGROUND_OBSERVATION_TTL_MS = 30_000;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_EVENTS = 200;
const MAX_BATCH_STEPS = 20;
const MAX_BATCH_WAIT_MS = 5_000;
const MAX_EXPORTED_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_DOCUMENT_INDEX_BYTES = 512 * 1024;
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;

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
  signal?: AbortSignal;
}

export interface IosPhysicalDeviceRuntimeHooks {
  platform(): NodeJS.Platform;
  now(): Date;
  runCommand(command: string, args: string[], options?: CommandOptions): CommandResult;
  runCommandAsync(command: string, args: string[], options?: CommandOptions): Promise<CommandResult>;
}

function runCommandSync(command: string, args: string[], options: CommandOptions = {}): CommandResult {
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
}

async function runCommandAsync(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  const result = await runBoundedProcess(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxOutputBytes: 4 * 1024 * 1024,
    signal: options.signal,
  });
  return {
    ok: result.ok,
    status: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    command: [command, ...args],
  };
}

const defaultHooks: IosPhysicalDeviceRuntimeHooks = {
  platform: () => process.platform,
  now: () => new Date(),
  runCommand: runCommandSync,
  runCommandAsync,
};

let hooks: IosPhysicalDeviceRuntimeHooks = { ...defaultHooks };

export function setIosPhysicalDeviceRuntimeHooksForTest(overrides: Partial<IosPhysicalDeviceRuntimeHooks>): void {
  hooks = { ...defaultHooks, ...overrides };
  if (overrides.runCommand && !overrides.runCommandAsync) {
    hooks.runCommandAsync = async (command, args, options = {}) => overrides.runCommand!(command, args, options);
  }
}

export function resetIosPhysicalDeviceRuntimeHooksForTest(): void {
  hooks = { ...defaultHooks };
  coreDeviceReadyCache = undefined;
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

interface DisplayGeometry {
  width: number;
  height: number;
  pointScale?: number;
}

interface CachedDisplayGeometry extends DisplayGeometry {
  observedAt: string;
}

interface PhysicalScreenshotObservation {
  observationId: string;
  observedAt: string;
  label: string;
}

interface PhysicalForegroundObservation {
  observationId: string;
  screenshotObservedAt: string;
  confirmedAt: string;
  bundleId: string;
}

interface PhysicalSessionState {
  schemaVersion: 1;
  interactionId: string;
  device: PhysicalDevice;
  bundleId: string;
  display?: CachedDisplayGeometry;
  unlockVerifiedAt?: string;
  lastScreenshot?: PhysicalScreenshotObservation;
  foregroundObservation?: PhysicalForegroundObservation;
  events: PhysicalEvent[];
}

interface CoreDeviceStatus {
  available: boolean;
  platform: NodeJS.Platform;
  coreDeviceReady: boolean;
  devicectlVersion?: string;
  reason?: string;
  probed?: boolean;
}

type TimingStages = Record<string, { ms: number; cached?: boolean }>;
let coreDeviceReadyCache: { checkedAtMs: number; status: CoreDeviceStatus } | undefined;

function timestamp(): string {
  return hooks.now().toISOString();
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function recordTiming(stages: TimingStages, name: string, startedAt: number, cached?: boolean): void {
  stages[name] = { ms: elapsedMs(startedAt), ...(cached === undefined ? {} : { cached }) };
}

function finishTimedResult(
  actionStartedAt: number,
  stages: TimingStages,
  result: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...result,
    timing: {
      totalMs: elapsedMs(actionStartedAt),
      stages,
    },
  };
}

function cacheAgeMs(observedAt: string | undefined): number | undefined {
  if (!observedAt) return undefined;
  const parsed = Date.parse(observedAt);
  return Number.isFinite(parsed) ? Math.max(0, hooks.now().getTime() - parsed) : undefined;
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
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory()) {
    throw new AssistantPluginError('IOS_DEVICE_ARTIFACT_DIR_INVALID', 'The private iPhone artifact directory is not a regular directory.', { retryable: false });
  }
  chmodSync(path, 0o700);
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

function requireAppDocumentPath(value: unknown): string {
  const path = requireString(value, 'path');
  const parts = path.split('/');
  if (parts.length !== 2 || parts[0] !== 'Documents'
    || !/^[^\\/\u0000-\u001f\u007f]+\.(?:pdf|png|jpe?g|heic)$/i.test(parts[1] ?? '')
    || parts[1] === '.' || parts[1] === '..' || path.length > 512) {
    throw new AssistantPluginError('IOS_DEVICE_DOCUMENT_PATH_INVALID',
      'Provide one exact PDF/image filename immediately within the selected app Documents directory.',
      { retryable: false });
  }
  return path;
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

async function runCoreJson(
  input: AssistantPluginActionExecutionInput,
  args: string[],
  code: string,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  if (hooks.platform() !== 'darwin') {
    throw new AssistantPluginError('PLUGIN_DEPENDENCY_MISSING', 'Physical iOS device support requires macOS and Xcode CoreDevice.', { retryable: false });
  }
  const result = await hooks.runCommandAsync('xcrun', ['devicectl', ...args, '--json-output', '-'], {
    cwd: input.repoRoot,
    timeoutMs,
    signal: input.signal,
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

async function physicalDevices(input: AssistantPluginActionExecutionInput): Promise<PhysicalDevice[]> {
  const response = await runCoreJson(input, ['list', 'devices'], 'IOS_DEVICE_LIST_FAILED');
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

async function selectDevice(input: AssistantPluginActionExecutionInput, selectorValue: unknown): Promise<PhysicalDevice> {
  const selector = requireString(selectorValue, 'device');
  const inventory = await physicalDevices(input);
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

async function physicalDeviceLockState(input: AssistantPluginActionExecutionInput, device: PhysicalDevice): Promise<Record<string, unknown>> {
  const response = await runCoreJson(input, [
    'device', 'info', 'lockState', '--device', device.identifier,
  ], 'IOS_DEVICE_LOCK_STATE_FAILED', 30_000);
  return objectValue(response.result);
}

async function requirePhysicalDeviceUnlocked(input: AssistantPluginActionExecutionInput, device: PhysicalDevice): Promise<void> {
  const lockState = await physicalDeviceLockState(input, device);
  if (lockState.passcodeRequired === false) return;
  if (lockState.passcodeRequired !== true) {
    throw new AssistantPluginError('IOS_DEVICE_LOCK_STATE_UNVERIFIED',
      'CoreDevice did not report a verified iPhone lock state; app activation was not attempted.',
      { retryable: false });
  }
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

async function physicalDisplayGeometry(input: AssistantPluginActionExecutionInput, device: PhysicalDevice): Promise<DisplayGeometry> {
  const displayResponse = await runCoreJson(input, [
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

const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

function pngDisplayGeometry(image: Buffer, pointScale?: number): DisplayGeometry | undefined {
  // No screenshot observation is issued until all PNG chunks have valid bounds
  // and CRCs; a plausible header/trailer alone is not a usable image.
  if (image.length < 57 || image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return undefined;
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawImageData = false;
  while (offset + 12 <= image.length) {
    const length = image.readUInt32BE(offset);
    if (length > image.length - offset - 12) return undefined;
    const kind = image.toString('ascii', offset + 4, offset + 8);
    const end = offset + 8 + length;
    if (!/^[A-Za-z]{4}$/.test(kind)) return undefined;
    let crc = 0xffffffff;
    for (let pos = offset + 4; pos < end; pos += 1) {
      crc = PNG_CRC_TABLE[(crc ^ image[pos]!) & 0xff]! ^ (crc >>> 8);
    }
    if (((crc ^ 0xffffffff) >>> 0) !== image.readUInt32BE(end)) return undefined;
    if (kind === 'IHDR') {
      if (offset !== 8 || length !== 13) return undefined;
      width = image.readUInt32BE(offset + 8);
      height = image.readUInt32BE(offset + 12);
      if (width <= 1 || height <= 1 || width > 10_000 || height > 10_000
        || image[offset + 18] !== 0 || image[offset + 19] !== 0 || (image[offset + 20] ?? 2) > 1) return undefined;
    } else if (kind === 'IDAT') {
      if (!width || length === 0) return undefined;
      sawImageData = true;
    } else if (kind === 'IEND') {
      return sawImageData && length === 0 && end + 4 === image.length
        ? { width, height, pointScale } : undefined;
    }
    offset = end + 4;
  }
  return undefined;
}

async function sessionDisplayGeometry(
  input: AssistantPluginActionExecutionInput,
  state: PhysicalSessionState,
): Promise<{ display: DisplayGeometry; cached: boolean }> {
  const age = cacheAgeMs(state.display?.observedAt);
  if (state.display && age !== undefined && age <= INPUT_DISPLAY_CACHE_MS) {
    const { observedAt: _observedAt, ...display } = state.display;
    return { display, cached: true };
  }
  const display = await physicalDisplayGeometry(input, state.device);
  state.display = { ...display, observedAt: timestamp() };
  writeState(input, state);
  return { display, cached: false };
}

async function requireSessionUnlocked(
  input: AssistantPluginActionExecutionInput,
  state: PhysicalSessionState,
): Promise<{ cached: boolean }> {
  const age = cacheAgeMs(state.unlockVerifiedAt);
  if (age !== undefined && age <= INPUT_UNLOCK_CACHE_MS) return { cached: true };
  await requirePhysicalDeviceUnlocked(input, state.device);
  state.unlockVerifiedAt = timestamp();
  writeState(input, state);
  return { cached: false };
}

async function physicalDeviceInfo(input: AssistantPluginActionExecutionInput, device: PhysicalDevice): Promise<Record<string, unknown>> {
  const detailsResponse = await runCoreJson(input, [
    'device', 'info', 'details', '--device', device.identifier,
  ], 'IOS_DEVICE_DETAILS_FAILED', 60_000);
  const details = objectValue(detailsResponse.result);
  const deviceProperties = objectValue(details.deviceProperties);
  const names = capabilityNames(details.capabilities);

  const lockState = await physicalDeviceLockState(input, device);
  const displayResponse = await runCoreJson(input, [
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

async function installedApps(
  input: AssistantPluginActionExecutionInput,
  device: PhysicalDevice,
  bundleId: string,
): Promise<InstalledApp[]> {
  let response: Record<string, unknown>;
  try {
    response = await runCoreJson(input, [
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

function expirePhysicalDeviceSessions(input: AssistantPluginActionExecutionInput): number {
  const nowMs = hooks.now().getTime();
  let expired = 0;
  for (const record of listInteractionSessions(input.repoRoot, PROVIDER)) {
    if (!isInteractionSessionActive(record.status)) continue;
    const expiresAtMs = Date.parse(record.expiresAt);
    if (!Number.isFinite(expiresAtMs) || nowMs < expiresAtMs) continue;
    const state = readState(input, record.interactionId);
    patchInteractionSession(input.repoRoot, PROVIDER, record.interactionId, {
      status: 'failed',
      error: { code: 'IOS_DEVICE_SESSION_EXPIRED', message: 'The physical iOS interaction expired.' },
    });
    appendEvent(input, record.interactionId, 'session_expired');
    if (state?.device.identifier) {
      stopRemoteXpcHidForDevice(state.device.identifier);
      releaseIosDeviceOwnership(input.controllerHome, record.owner.repoId, record.interactionId, iosCoreDeviceOwnershipId(state.device));
    }
    expired += 1;
  }
  return expired;
}

function deviceOwnershipError(
  selected: PhysicalDevice,
  result: ReturnType<typeof ensureIosDeviceOwnership>,
): AssistantPluginError {
  return new AssistantPluginError('PLUGIN_RESOURCE_BUSY', 'The selected iPhone is already owned by another active Forge interaction.', {
    retryable: true,
    details: {
      device: { identifier: selected.identifier, name: selected.name },
      blocker: result.blocker,
    },
  });
}

function reusablePhysicalSession(
  input: AssistantPluginActionExecutionInput,
  selected: PhysicalDevice,
  bundleId: string,
  relaunch: boolean,
): InteractionSessionRecord | undefined {
  if (relaunch) return undefined;
  const aliases = [selected.identifier, selected.udid].filter((value): value is string => Boolean(value));
  return listInteractionSessions(input.repoRoot, PROVIDER).find((entry) => {
    if (!isInteractionSessionActive(entry.status) || interactionAutomationEngine(entry) !== 'coredevice') return false;
    if (!interactionMayOwnTarget(entry, aliases)) return false;
    const state = readState(input, entry.interactionId);
    return state?.device.identifier === selected.identifier && state.bundleId === bundleId;
  });
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
    appendEvent(input, interactionId, 'session_expired');
    stopRemoteXpcHidForDevice(state.device.identifier);
    releaseIosDeviceOwnership(input.controllerHome, record.owner.repoId, interactionId, iosCoreDeviceOwnershipId(state.device));
    throw new AssistantPluginError('IOS_DEVICE_SESSION_EXPIRED', 'The physical iOS interaction expired; open a new session.', { retryable: false });
  }
  if (isInteractionSessionActive(record.status)) {
    const ownership = ensureIosDeviceOwnership(input.controllerHome, input.repoId, interactionId, iosCoreDeviceOwnershipId(state.device));
    if (!ownership.acquired) throw deviceOwnershipError(state.device, ownership);
    const active = patchInteractionSession(input.repoRoot, PROVIDER, interactionId, {
      expiresAt: new Date(hooks.now().getTime() + SESSION_EXPIRY_MS).toISOString(),
    });
    if (active) return { record: active, state };
  }
  return { record, state };
}

function physicalDeviceStatusFromResult(result: CommandResult, platform: NodeJS.Platform): CoreDeviceStatus {
  return {
    available: result.ok,
    platform,
    coreDeviceReady: result.ok,
    devicectlVersion: result.ok ? result.stdout.trim() : undefined,
    reason: result.ok ? undefined : (result.stderr || result.stdout || 'xcrun devicectl is unavailable.'),
    probed: true,
  };
}

export function iosPhysicalDeviceStatus(): CoreDeviceStatus {
  const platform = hooks.platform();
  if (platform !== 'darwin') {
    coreDeviceReadyCache = undefined;
    return {
      available: false,
      platform,
      coreDeviceReady: false,
      reason: 'Physical iOS device support requires macOS and Xcode.',
      probed: true,
    };
  }
  const cached = coreDeviceReadyCache;
  if (cached && hooks.now().getTime() - cached.checkedAtMs <= CORE_DEVICE_READY_CACHE_MS) return cached.status;
  return {
    available: false,
    platform,
    coreDeviceReady: false,
    reason: 'CoreDevice readiness has not been probed by an explicit asynchronous action in this runtime yet.',
    probed: false,
  };
}

async function iosPhysicalDeviceActionStatus(input: AssistantPluginActionExecutionInput): Promise<CoreDeviceStatus> {
  const platform = hooks.platform();
  if (platform !== 'darwin') return iosPhysicalDeviceStatus();
  const result = await hooks.runCommandAsync('xcrun', ['devicectl', '--version'], {
    cwd: input.repoRoot,
    timeoutMs: Math.min(5_000, input.timeoutMs ?? 5_000),
    signal: input.signal,
  });
  const status = physicalDeviceStatusFromResult(result, platform);
  coreDeviceReadyCache = status.coreDeviceReady ? { checkedAtMs: hooks.now().getTime(), status } : undefined;
  return status;
}

async function cachedIosPhysicalDeviceActionStatus(input: AssistantPluginActionExecutionInput): Promise<{ status: CoreDeviceStatus; cached: boolean }> {
  const cached = coreDeviceReadyCache;
  if (cached && hooks.now().getTime() - cached.checkedAtMs <= CORE_DEVICE_READY_CACHE_MS) {
    return { status: cached.status, cached: true };
  }
  return { status: await iosPhysicalDeviceActionStatus(input), cached: false };
}

function recentScreenshotObservation(
  state: PhysicalSessionState,
  observationId: string,
): { observation: PhysicalScreenshotObservation; ageMs: number } {
  const observation = state.lastScreenshot;
  const ageMs = cacheAgeMs(observation?.observedAt);
  if (!observation || observation.observationId !== observationId || ageMs === undefined || ageMs > INPUT_FOREGROUND_OBSERVATION_TTL_MS) {
    throw new AssistantPluginError(
      'IOS_DEVICE_SCREEN_OBSERVATION_REQUIRED',
      'A fresh matching CoreDevice screenshot observation is required before screen-relative physical input.',
      {
        retryable: true,
        details: {
          deviceIdentifier: state.device.identifier,
          expectedObservationId: observation?.observationId,
          providedObservationId: observationId,
          observationAgeMs: ageMs,
          observationTtlMs: INPUT_FOREGROUND_OBSERVATION_TTL_MS,
          hidMutationDispatched: false,
        },
      },
    );
  }
  return { observation, ageMs };
}

function requireObservedPhysicalTargetForeground(state: PhysicalSessionState): PhysicalForegroundObservation {
  const confirmation = state.foregroundObservation;
  const screenshot = state.lastScreenshot;
  const screenshotAgeMs = cacheAgeMs(screenshot?.observedAt);
  const confirmationAgeMs = cacheAgeMs(confirmation?.confirmedAt);
  const valid = Boolean(
    confirmation
      && screenshot
      && confirmation.bundleId === state.bundleId
      && confirmation.observationId === screenshot.observationId
      && confirmation.screenshotObservedAt === screenshot.observedAt
      && screenshotAgeMs !== undefined
      && screenshotAgeMs <= INPUT_FOREGROUND_OBSERVATION_TTL_MS
      && confirmationAgeMs !== undefined
      && confirmationAgeMs <= INPUT_FOREGROUND_OBSERVATION_TTL_MS
  );
  if (!valid || !confirmation) {
    throw new AssistantPluginError(
      'IOS_DEVICE_FOREGROUND_OBSERVATION_REQUIRED',
      `A recent screenshot explicitly confirmed by the Controller as ${state.bundleId} foreground is required before HID input.`,
      {
        retryable: true,
        details: {
          bundleId: state.bundleId,
          deviceIdentifier: state.device.identifier,
          screenshotObservationId: screenshot?.observationId,
          screenshotAgeMs,
          confirmationObservationId: confirmation?.observationId,
          confirmationAgeMs,
          observationTtlMs: INPUT_FOREGROUND_OBSERVATION_TTL_MS,
          hidMutationDispatched: false,
        },
      },
    );
  }
  return confirmation;
}

function resolvePhysicalBatchForegroundObservation(
  state: PhysicalSessionState,
  observationId: string | undefined,
): { foregroundObservation: PhysicalForegroundObservation; source: 'explicit_confirmation'; screenshotAgeMs?: number } {
  // Observation freshness proves only that the screen was captured. It never proves
  // the target app was foreground. Require a separate, model-reviewed confirmation.
  const observed = observationId ? recentScreenshotObservation(state, observationId) : undefined;
  const confirmed = requireObservedPhysicalTargetForeground(state);
  if (observationId && confirmed.observationId !== observationId) {
    throw new AssistantPluginError('IOS_DEVICE_FOREGROUND_OBSERVATION_REQUIRED',
      'The batch observation must match the separately confirmed target-app foreground.',
      { retryable: true, details: { hidMutationDispatched: false } });
  }
  return {
    foregroundObservation: confirmed,
    source: 'explicit_confirmation',
    ...(observed ? { screenshotAgeMs: observed.ageMs } : {}),
  };
}

function consumePhysicalScreenObservation(input: AssistantPluginActionExecutionInput, state: PhysicalSessionState): void {
  state.lastScreenshot = undefined;
  state.foregroundObservation = undefined;
  writeState(input, state);
}

type PhysicalInputBatchKind = 'tap' | 'swipe' | 'type' | 'wait';

interface PhysicalInputBatchStep {
  kind: PhysicalInputBatchKind;
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  durationMs?: number;
  text?: string;
  textMode?: 'auto' | 'keys' | 'pasteboard';
  replaceExisting?: boolean;
}

function physicalInputBatchSteps(value: unknown): PhysicalInputBatchStep[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BATCH_STEPS) {
    throw new AssistantPluginError(
      'PLUGIN_ACTION_ARGUMENT_INVALID',
      `steps must contain between 1 and ${MAX_BATCH_STEPS} physical input steps.`,
      { retryable: false },
    );
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `steps[${index}] must be an object.`, { retryable: false });
    }
    const row = entry as Record<string, unknown>;
    const kind = requireString(row.kind, `steps[${index}].kind`) as PhysicalInputBatchKind;
    if (!['tap', 'swipe', 'type', 'wait'].includes(kind)) {
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Unsupported steps[${index}].kind: ${kind}.`, { retryable: false });
    }
    if (kind === 'tap') {
      return {
        kind,
        x: requireFiniteNumber(row.x, `steps[${index}].x`),
        y: requireFiniteNumber(row.y, `steps[${index}].y`),
      };
    }
    if (kind === 'swipe') {
      const durationMs = typeof row.duration_ms === 'number' && Number.isFinite(row.duration_ms)
        ? Math.max(80, Math.min(3_000, Math.trunc(row.duration_ms)))
        : 250;
      return {
        kind,
        x: requireFiniteNumber(row.x, `steps[${index}].x`),
        y: requireFiniteNumber(row.y, `steps[${index}].y`),
        toX: requireFiniteNumber(row.to_x, `steps[${index}].to_x`),
        toY: requireFiniteNumber(row.to_y, `steps[${index}].to_y`),
        durationMs,
      };
    }
    if (kind === 'type') {
      const textMode = optionalString(row.input_mode) ?? 'auto';
      if (!['auto', 'keys', 'pasteboard'].includes(textMode)) {
        throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Unsupported steps[${index}].input_mode: ${textMode}.`, { retryable: false });
      }
      const text = requireString(row.text, `steps[${index}].text`);
      if (text.length > 2048) {
        throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `steps[${index}].text exceeds the 2048 character input limit.`, { retryable: false });
      }
      if (textMode === 'keys' && [...text].some((character) => character.charCodeAt(0) > 0x7f)) {
        throw new AssistantPluginError('IOS_HID_UNICODE_TEXT_UNSUPPORTED', `steps[${index}] requests keys mode for Unicode text; use auto or pasteboard mode.`, { retryable: false });
      }
      return {
        kind,
        text,
        textMode: textMode as 'auto' | 'keys' | 'pasteboard',
        replaceExisting: row.replace_existing === true,
      };
    }
    const durationMs = typeof row.duration_ms === 'number' && Number.isFinite(row.duration_ms)
      ? Math.max(0, Math.min(MAX_BATCH_WAIT_MS, Math.trunc(row.duration_ms)))
      : 120;
    return { kind, durationMs };
  });
}

function validatePhysicalInputBatchCoordinates(steps: PhysicalInputBatchStep[], display: DisplayGeometry | undefined): void {
  const touchSteps = steps.filter((step) => step.kind === 'tap' || step.kind === 'swipe');
  if (touchSteps.length === 0) return;
  if (!display) {
    throw new AssistantPluginError('IOS_HID_DISPLAY_INVALID', 'Physical input batch contains touch steps without usable display geometry.', { retryable: true });
  }
  const points: Array<{ stepIndex: number; label: string; x: number | undefined; y: number | undefined }> = [];
  steps.forEach((step, stepIndex) => {
    if (step.kind === 'tap' || step.kind === 'swipe') points.push({ stepIndex, label: 'from', x: step.x, y: step.y });
    if (step.kind === 'swipe') points.push({ stepIndex, label: 'to', x: step.toX, y: step.toY });
  });
  for (const point of points) {
    if (point.x === undefined || point.y === undefined || point.x < 0 || point.y < 0 || point.x > display.width - 1 || point.y > display.height - 1) {
      throw new AssistantPluginError(
        'IOS_HID_COORDINATE_OUT_OF_BOUNDS',
        `steps[${point.stepIndex}] ${point.label} coordinate is outside the current CoreDevice display.`,
        { retryable: false, details: { stepIndex: point.stepIndex, label: point.label, x: point.x, y: point.y, width: display.width, height: display.height, mutationDispatched: false } },
      );
    }
  }
}

async function waitPhysicalInputBatch(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (durationMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new AssistantPluginError('PLUGIN_ACTION_CANCELLED', 'Physical iOS input batch was cancelled during a wait step.', { retryable: true }));
    timer = setTimeout(() => finish(), durationMs);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

/** CoreDevice screenshot is the one observation authority for the device. */
async function capturePhysicalScreen(
  input: AssistantPluginActionExecutionInput,
  state: PhysicalSessionState,
  label: string,
): Promise<Record<string, unknown>> {
  const path = join(artifactDir(input, state.interactionId), `${sanitize(label)}-${hooks.now().getTime()}-${randomUUID()}.png`);
  // A new capture supersedes the old screen. A failed observation cannot leave
  // an earlier foreground confirmation available to authorize subsequent HID.
  state.lastScreenshot = undefined;
  state.foregroundObservation = undefined;
  writeState(input, state);
  try {
    const screenshotResult = await runCoreJson(input, [
      'device', 'capture', 'screenshot', '--device', state.device.identifier, '--destination', path,
    ], 'IOS_DEVICE_SCREENSHOT_FAILED', 60_000);
    if (!existsSync(path)) {
      throw new AssistantPluginError('IOS_DEVICE_SCREENSHOT_MISSING', 'CoreDevice succeeded without creating the requested screenshot.', { retryable: false });
    }
    const file = lstatSync(path);
    // The enclosing directory is 0700 during CoreDevice's write; the finished
    // screenshot itself must also be private before it is read or returned.
    if (file.isFile()) chmodSync(path, 0o600);
    const image = file.isFile() && file.size <= MAX_SCREENSHOT_BYTES && file.size > 0 ? readFileSync(path) : undefined;
    const screenshotDisplay = image ? pngDisplayGeometry(image, state.display?.pointScale) : undefined;
    if (!screenshotDisplay || !image) {
      throw new AssistantPluginError('IOS_DEVICE_SCREENSHOT_INVALID', 'CoreDevice did not provide a bounded PNG screenshot with valid image dimensions and terminal marker.', { retryable: false });
    }
    const screenshotSha256 = createHash('sha256').update(image).digest('hex');
    const observedAt = timestamp();
    const observationId = randomUUID();
    state.display = { ...screenshotDisplay, observedAt };
    state.lastScreenshot = { observationId, observedAt, label };
    state.foregroundObservation = undefined;
    state.events.push({ at: observedAt, type: 'screenshot', details: { label, observationId } });
    state.events = state.events.slice(-MAX_EVENTS);
    writeState(input, state);
    return {
      screenshotResult: bounded(screenshotResult),
      observation: { observationId, observedAt, label, ttlMs: INPUT_FOREGROUND_OBSERVATION_TTL_MS,
        screenshotSha256, screenshotBytes: image.length, width: screenshotDisplay.width, height: screenshotDisplay.height },
      foregroundConfirmation: {
        actionId: 'physical_device_confirm_foreground',
        arguments: { interaction_id: state.interactionId, observation_id: observationId, bundle_id: state.bundleId },
        requires: ['independent visual confirmation of target app'],
        ttlMs: INPUT_FOREGROUND_OBSERVATION_TTL_MS,
      },
      artifactCandidates: [{ kind: 'ios_physical_device_screenshot', mediaType: 'image/png', path,
        sha256: screenshotSha256, bytes: image.length }],
    };
  } catch (error) {
    // A partially written or invalid image is not an observation artifact.
    if (existsSync(path)) {
      try { unlinkSync(path); } catch { /* Preserve the original capture failure. */ }
    }
    throw error;
  }
}

/** After a mutation, screenshot failures are observations, never a reason to retry input. */
async function optionalPostActionCapture(
  input: AssistantPluginActionExecutionInput,
  state: PhysicalSessionState,
  label: string,
  timingStages: TimingStages,
): Promise<Record<string, unknown>> {
  const startedAt = performance.now();
  try {
    const capture = await capturePhysicalScreen(input, state, label);
    recordTiming(timingStages, 'postActionScreenshot', startedAt, false);
    const { screenshotResult: _ignored, ...observation } = capture;
    return { ...observation, postActionCapture: { status: 'captured' } };
  } catch (error) {
    recordTiming(timingStages, 'postActionScreenshot', startedAt, false);
    const normalized = toAssistantPluginError(error, {
      code: 'IOS_DEVICE_SCREENSHOT_FAILED',
      message: 'The physical iPhone input completed, but its follow-up screenshot could not be captured.',
      retryable: false,
    });
    // A secondary diagnostic write must not turn a completed HID effect into a replayable error.
    try { appendEvent(input, state.interactionId, 'post_action_screenshot_failed', { code: normalized.code }); } catch { /* observation failure remains explicit */ }
    return {
      postActionCapture: {
        status: 'failed', code: normalized.code,
        mutationAlreadyApplied: true, retryOnly: 'physical_device_screenshot',
      },
    };
  }
}

export function isIosPhysicalDeviceAction(actionId: string): boolean {
  return actionId.startsWith('physical_device_');
}

function physicalDeviceAuthorizationTarget(device: PhysicalDevice): AssistantPluginAuthorizationTarget {
  const identityFingerprint = createHash('sha256')
    .update(`${device.identifier}\0${device.udid ?? ''}`)
    .digest('hex');
  return {
    kind: 'ios-physical-device',
    id: device.identifier,
    identityFingerprint,
  };
}

/**
 * Resolve authorization against the exact CoreDevice identity. Interaction ids are
 * intentionally never grant identities: follow-up input actions must recover and
 * verify the immutable device target stored when the session was opened.
 */
export async function resolveIosPhysicalDeviceAuthorizationContext(
  input: AssistantPluginActionExecutionInput,
): Promise<AssistantPluginAuthorizationContext | undefined> {
  const action = iosPhysicalDeviceActions().find((entry) => entry.actionId === input.actionId);
  if (!action || action.confirmation !== 'authorization') return undefined;

  if (input.actionId === 'physical_device_open') {
    const selected = await selectDevice(input, input.args.device);
    return {
      target: physicalDeviceAuthorizationTarget(selected),
      expiresInMinutes: 30 * 24 * 60,
    };
  }

  const { record, state } = requireRecord(input, input.actionId === 'physical_device_close');
  const aliases = new Set([record.targetId, ...(record.targetAliases ?? [])]);
  if (record.targetId !== state.device.identifier
    || !aliases.has(state.device.identifier)
    || (state.device.udid && !aliases.has(state.device.udid))) {
    throw new AssistantPluginError(
      'IOS_DEVICE_AUTHORIZATION_TARGET_MISMATCH',
      'The persisted physical iOS session no longer matches its exact device authorization identity.',
      {
        retryable: false,
        details: {
          interactionId: record.interactionId,
          sessionTargetId: record.targetId,
          stateDeviceIdentifier: state.device.identifier,
        },
      },
    );
  }
  return {
    target: physicalDeviceAuthorizationTarget(state.device),
    expiresInMinutes: 30 * 24 * 60,
  };
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
  const actions: AssistantPluginActionDescriptor[] = [
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
      description: 'Open or reuse an exact CoreDevice iPhone session; launch metadata never proves foreground. Set observe_after_open=true to return the initial screenshot and short-lived observation in the same call, without authorizing input. prewarm_input=true starts the existing RemoteXPC worker without XCTest.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 2 * 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.device'], resourceClaims: mutationClaims,
      argumentsSchema: { type: 'object', properties: { device: { type: 'string' }, bundle_id: { type: 'string' }, relaunch: { type: 'boolean' }, prewarm_input: { type: 'boolean' }, observe_after_open: { type: 'boolean' } }, required: ['device', 'bundle_id'], additionalProperties: false },
    },
    {
      actionId: 'physical_device_screenshot', title: 'Capture physical iOS screenshot',
      description: 'Capture the exact paired iPhone display through CoreDevice into Controller-owned bounded artifact storage and return a short-lived observation ID. A screenshot alone never authorizes input.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.device'], resourceClaims: mutationClaims,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, label: { type: 'string' } }, required: ['interaction_id'], additionalProperties: false },
    },
    {
      actionId: 'physical_device_confirm_foreground', title: 'Confirm observed physical iPhone foreground',
      description: 'Bind the latest fresh CoreDevice screenshot observation to the session target bundle after the Controller has visually verified that exact app is foreground. This only writes the short-lived observation fence and sends no device input.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: true,
      scopes: ['ios.device'], resourceClaims: stateClaim,
      argumentsSchema: {
        type: 'object',
        properties: { ...interactionProperty, observation_id: { type: 'string' }, bundle_id: { type: 'string' } },
        required: ['interaction_id', 'observation_id', 'bundle_id'], additionalProperties: false,
      },
    },
    {
      actionId: 'physical_device_observed_tap', title: 'Tap a freshly observed physical iPhone screen',
      description: 'One-shot screenshot-bound tap for an independently inspected system-screen navigation, without reactivation. Observation freshness is not app identity: never dispatch from an unseen screenshot or use this system-navigation path for ordinary in-app taps; verify exact target foreground first and use physical_device_confirm_foreground plus physical_device_batch/tap. capture_after=true returns the next screenshot; never retry an uncertain tap.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false,
      scopes: ['ios.device'], resourceClaims: mutationClaims,
      argumentsSchema: {
        type: 'object',
        properties: { ...interactionProperty, observation_id: { type: 'string' }, capture_after: { type: 'boolean' }, x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 } },
        required: ['interaction_id', 'observation_id', 'x', 'y'], additionalProperties: false,
      },
    },
    {
      actionId: 'physical_device_observed_swipe', title: 'Swipe a freshly observed physical iPhone screen',
      description: 'One-shot screenshot-bound swipe for system navigation, consuming the observed screen without app reactivation. capture_after=true returns the next CoreDevice screenshot and new observation in the same call; app form gestures still require foreground confirmation.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false,
      scopes: ['ios.device'], resourceClaims: mutationClaims,
      argumentsSchema: {
        type: 'object',
        properties: { ...interactionProperty, observation_id: { type: 'string' }, capture_after: { type: 'boolean' }, x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 }, to_x: { type: 'number', minimum: 0 }, to_y: { type: 'number', minimum: 0 }, duration_ms: { type: 'number', minimum: 80, maximum: 3000 } },
        required: ['interaction_id', 'observation_id', 'x', 'y', 'to_x', 'to_y'], additionalProperties: false,
      },
    },
    {
      actionId: 'physical_device_batch', title: 'Run fast physical iPhone input batch',
      description: 'Run up to 20 short visually grounded taps, swipes, text edits or waits on the single CoreDevice/HID provider. First independently inspect the screenshot and call physical_device_confirm_foreground with the exact target bundle. observation_id is an optional match check, not an authorization shortcut. capture_after=true returns the NEXT PNG and observation for separate inspection and confirmation. Never retry partially applied or unknown input.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.device'], resourceClaims: mutationClaims,
      argumentsSchema: {
        type: 'object',
        properties: {
          ...interactionProperty,
          observation_id: { type: 'string' },
          capture_after: { type: 'boolean' },
          steps: {
            type: 'array', minItems: 1, maxItems: MAX_BATCH_STEPS,
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['tap', 'swipe', 'type', 'wait'] },
                x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 },
                to_x: { type: 'number', minimum: 0 }, to_y: { type: 'number', minimum: 0 },
                duration_ms: { type: 'number', minimum: 0, maximum: MAX_BATCH_WAIT_MS },
                text: { type: 'string', maxLength: 2048 },
                input_mode: { type: 'string', enum: ['auto', 'keys', 'pasteboard'] },
                replace_existing: { type: 'boolean' },
              },
              required: ['kind'], additionalProperties: false,
            },
          },
        },
        required: ['interaction_id', 'steps'], additionalProperties: false,
      },
    },
    {
      actionId: 'physical_device_tap', title: 'Tap physical iPhone coordinate',
      description: 'Send one runnerless touch through RemoteXPC only while a fresh screenshot observation has been explicitly confirmed as the target app foreground. The observation is consumed before dispatch. For system-screen navigation use physical_device_observed_tap; for known form steps prefer physical_device_batch.',
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
      description: 'Send one runnerless touchscreen swipe through RemoteXPC HID only while a fresh screenshot observation has been explicitly confirmed as the target app foreground; the observation is consumed before dispatch.',
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
      description: 'Type bounded text through reusable runnerless RemoteXPC input only while a fresh screenshot observation has been explicitly confirmed as the target app foreground. Auto mode uses direct HID keys for short ASCII and clipboard-preserving CoreDevice pasteboard + Command-V for Unicode; the observation is consumed before dispatch.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false,
      scopes: ['ios.device'], resourceClaims: mutationClaims,
      argumentsSchema: {
        type: 'object',
        properties: { ...interactionProperty, text: { type: 'string', maxLength: 2048 }, input_mode: { type: 'string', enum: ['auto', 'keys', 'pasteboard'] }, replace_existing: { type: 'boolean' } },
        required: ['interaction_id', 'text'], additionalProperties: false,
      },
    },
    {
      actionId: 'physical_device_documents_list', title: 'Discover selected-app iPhone documents',
      description: 'With explicit interactive confirmation, list bounded PDF/image filenames in the selected app Documents sandbox. No general Files/iCloud or other-app search.',
      readOnly: false, risk: 'workspace_write', confirmation: 'strong_confirmation', requiredConfirmationText: 'list-iphone-app-documents',
      defaultTimeoutMs: 60_000, cancellable: true, idempotent: true, scopes: ['ios.device'], resourceClaims: stateClaim,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, bundle_id: { type: 'string' } }, required: ['interaction_id', 'bundle_id'], additionalProperties: false },
    },
    {
      actionId: 'physical_device_document_export', title: 'Export one selected-app iPhone document',
      description: 'With explicit interactive confirmation, copy one exact PDF/image from the selected app Documents sandbox into private Controller artifacts; no bulk export, deletion or upload.',
      readOnly: false, risk: 'workspace_write', confirmation: 'strong_confirmation', requiredConfirmationText: 'export-iphone-app-document',
      defaultTimeoutMs: 90_000, cancellable: true, idempotent: false, scopes: ['ios.device'], resourceClaims: mutationClaims,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, bundle_id: { type: 'string' }, path: { type: 'string', maxLength: 512 } }, required: ['interaction_id', 'bundle_id', 'path'], additionalProperties: false },
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
  return actions.map((action) => action.readOnly
    ? action
    : { ...action, executionMode: 'runtime' });
}

export async function executeIosPhysicalDeviceAction(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  const actionStartedAt = performance.now();
  const timingStages: TimingStages = {};
  if (input.actionId === 'physical_device_status') {
    const startedAt = performance.now();
    const status = await iosPhysicalDeviceActionStatus(input);
    recordTiming(timingStages, 'coreDeviceStatus', startedAt, false);
    return finishTimedResult(actionStartedAt, timingStages, { provider: 'coredevice', ...status });
  }
  const statusStartedAt = performance.now();
  const readiness = await cachedIosPhysicalDeviceActionStatus(input);
  recordTiming(timingStages, 'coreDeviceStatus', statusStartedAt, readiness.cached);
  const status = readiness.status;
  if (!status.coreDeviceReady) {
    throw new AssistantPluginError('PLUGIN_DEPENDENCY_MISSING', status.reason ?? 'Xcode CoreDevice is unavailable.', { retryable: false, details: { ...status } });
  }
  if (input.actionId === 'physical_device_list') {
    return { provider: 'coredevice', devices: await physicalDevices(input) };
  }
  if (input.actionId === 'physical_device_info') {
    const selected = await selectDevice(input, input.args.device);
    return { provider: 'coredevice', ...await physicalDeviceInfo(input, selected) };
  }
  if (input.actionId === 'physical_device_apps') {
    const selected = await selectDevice(input, input.args.device);
    const bundleId = requireBundleId(input.args.bundle_id);
    return { provider: 'coredevice', device: selected, apps: await installedApps(input, selected, bundleId) };
  }
  if (input.actionId === 'physical_device_open') {
    const selectStartedAt = performance.now();
    const selected = await selectDevice(input, input.args.device);
    recordTiming(timingStages, 'deviceSelection', selectStartedAt, false);
    if (!selected.connected) {
      throw new AssistantPluginError('IOS_DEVICE_NOT_CONNECTED',
        'The selected paired iPhone has no usable CoreDevice connection; app activation was not attempted.',
        { retryable: true });
    }
    const bundleId = requireBundleId(input.args.bundle_id);
    const appsStartedAt = performance.now();
    const lockStartedAt = performance.now();
    const appsPromise = installedApps(input, selected, bundleId)
      .finally(() => recordTiming(timingStages, 'installedAppLookup', appsStartedAt, false));
    const lockPromise = requirePhysicalDeviceUnlocked(input, selected)
      .finally(() => recordTiming(timingStages, 'lockState', lockStartedAt, false));
    const [apps] = await Promise.all([appsPromise, lockPromise]);
    if (apps.length !== 1) {
      throw new AssistantPluginError('IOS_DEVICE_APP_NOT_INSTALLED', `The app ${bundleId} is not installed on the selected iPhone.`, { retryable: false });
    }
    const selectedAliases = [selected.identifier, selected.udid];
    const sessionLookupStartedAt = performance.now();
    const expiredSessionCount = expirePhysicalDeviceSessions(input);
    pruneInteractionSessions(input.repoRoot, PROVIDER, 100);
    const reusable = reusablePhysicalSession(input, selected, bundleId, input.args.relaunch === true);
    const conflict = listInteractionSessions(input.repoRoot, PROVIDER).find((entry) =>
      isInteractionSessionActive(entry.status) && interactionMayOwnTarget(entry, selectedAliases));
    recordTiming(timingStages, 'sessionLookup', sessionLookupStartedAt, false);
    if (expiredSessionCount > 0) timingStages.sessionReconcile = { ms: timingStages.sessionLookup.ms, cached: false };
    if (reusable) {
      const ownership = ensureIosDeviceOwnership(input.controllerHome, input.repoId, reusable.interactionId, iosCoreDeviceOwnershipId(selected));
      if (!ownership.acquired) throw deviceOwnershipError(selected, ownership);
      const existingState = readState(input, reusable.interactionId);
      if (!existingState) {
        patchInteractionSession(input.repoRoot, PROVIDER, reusable.interactionId, {
          status: 'failed',
          error: { code: 'IOS_DEVICE_SESSION_STATE_MISSING', message: 'The existing physical iPhone session has no recoverable state.' },
        });
        appendEvent(input, reusable.interactionId, 'session_state_missing');
        releaseIosDeviceOwnership(input.controllerHome, input.repoId, reusable.interactionId, iosCoreDeviceOwnershipId(selected));
        throw new AssistantPluginError('IOS_DEVICE_SESSION_STATE_MISSING', 'The existing physical iPhone session has no recoverable state.', { retryable: false });
      }
      const active = patchInteractionSession(input.repoRoot, PROVIDER, reusable.interactionId, {
        expiresAt: new Date(hooks.now().getTime() + SESSION_EXPIRY_MS).toISOString(),
      }) ?? reusable;
      const nextObservation = input.args.observe_after_open === true
        ? await optionalPostActionCapture(input, existingState, 'resume', timingStages)
        : {};
      return finishTimedResult(actionStartedAt, timingStages, {
        ...nextObservation,
        provider: 'coredevice',
        interaction: active,
        device: selected,
        app: apps[0],
        reusedSession: true,
        controlPlane: {
          lifecycle: 'coredevice',
          observation: 'coredevice',
          input: 'remote-xpc-hid',
          semanticFallback: 'agent-device',
          runnerOwned: false,
        },
      });
    }
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
    const interactionId = `ios_device_${randomUUID()}`;
    const ownership = ensureIosDeviceOwnership(input.controllerHome, input.repoId, interactionId, iosCoreDeviceOwnershipId(selected));
    if (!ownership.acquired) throw deviceOwnershipError(selected, ownership);
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
      unlockVerifiedAt: createdAt,
      events: [{ at: createdAt, type: 'session_created', details: { bundleId, deviceIdentifier: selected.identifier } }],
    };
    const statePersistStartedAt = performance.now();
    writeState(input, state);
    recordTiming(timingStages, 'eventPersistence', statePersistStartedAt, false);
    try {
      const args = ['device', 'process', 'launch', '--device', selected.identifier, '--activate'];
      if (input.args.relaunch === true) args.push('--terminate-existing');
      args.push(bundleId);
      const prewarmStartedAt = performance.now();
      const prewarmRequested = input.args.prewarm_input === true && Boolean(selected.udid);
      const inputPrewarm: Record<string, unknown> = prewarmRequested && selected.udid
        ? prewarmRemoteXpcHid({
          controllerHome: input.controllerHome,
          deviceIdentifier: selected.identifier,
          udid: selected.udid,
        })
        : { backend: 'remote-xpc-hid', state: 'not_requested', runnerOwned: false };
      recordTiming(
        timingStages,
        'hidPrewarm',
        prewarmStartedAt,
        inputPrewarm.state === 'ready' || inputPrewarm.state === 'test' || input.args.prewarm_input !== true,
      );
      const displayStartedAt = performance.now();
      const display = input.args.prewarm_input === true
        ? await physicalDisplayGeometry(input, selected).then((result) => {
          recordTiming(timingStages, 'displayInfo', displayStartedAt, false);
          return result;
        }, (error) => {
          recordTiming(timingStages, 'displayInfo', displayStartedAt, false);
          throw error;
        })
        : undefined;
      if (input.args.prewarm_input !== true) recordTiming(timingStages, 'displayInfo', displayStartedAt, true);
      if (display) {
        state.display = { ...display, observedAt: createdAt };
        writeState(input, state);
      }
      const launchStartedAt = performance.now();
      const launchPromise = runCoreJson(input, args, 'IOS_DEVICE_LAUNCH_FAILED', 60_000)
        .finally(() => recordTiming(timingStages, 'activationRequest', launchStartedAt, false));
      const launch = await launchPromise;
      const launchEventStartedAt = performance.now();
      appendEvent(input, interactionId, 'app_launched', { bundleId, relaunch: input.args.relaunch === true });
      recordTiming(timingStages, 'eventPersistence', launchEventStartedAt, false);
      if (input.args.prewarm_input === true) {
        appendEvent(input, interactionId, 'input_prewarm', {
          state: inputPrewarm.state,
          ...(typeof inputPrewarm.waitMs === 'number' ? { waitMs: inputPrewarm.waitMs } : {}),
          ...(typeof inputPrewarm.errorCode === 'string' ? { errorCode: inputPrewarm.errorCode } : {}),
          ...(typeof inputPrewarm.phase === 'string' ? { phase: inputPrewarm.phase } : {}),
        });
      }
      // CoreDevice is the default physical-device substrate. Never probe, start,
      // build, install, or attach an XCTest/WDA runner during ordinary app open.
      // Semantic automation is an explicit opt-in action so repeated computer-use
      // workflows cannot accidentally create fresh Runner lifecycles.
      const active = patchInteractionSession(input.repoRoot, PROVIDER, interactionId, { status: 'waiting_for_user' }) ?? record;
      const nextObservation = input.args.observe_after_open === true
        ? await optionalPostActionCapture(input, state, 'open', timingStages)
        : {};
      return finishTimedResult(actionStartedAt, timingStages, {
        ...nextObservation,
        provider: 'coredevice',
        interaction: active,
        device: selected,
        app: apps[0],
        launch: bounded(launch),
        foregroundVerification: {
          authority: 'screenshot_observation',
          required: true,
          coreDeviceActivatedWhenStartedHint: objectValue(objectValue(launch.result).launchOptions).activatedWhenStarted === true,
        },
        inputPrewarm,
        controlPlane: {
          lifecycle: 'coredevice',
          observation: 'coredevice',
          input: 'remote-xpc-hid',
          semanticFallback: 'agent-device',
          runnerOwned: false,
        },
      });
    } catch (error) {
      stopRemoteXpcHidForDevice(selected.identifier);
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
      releaseIosDeviceOwnership(input.controllerHome, input.repoId, interactionId, iosCoreDeviceOwnershipId(selected));
      throw normalized;
    }
  }

  const sessionLookupStartedAt = performance.now();
  const { record, state } = requireRecord(input, input.actionId === 'physical_device_close');
  recordTiming(timingStages, 'sessionLookup', sessionLookupStartedAt, false);
  switch (input.actionId) {
    case 'physical_device_documents_list': {
      if (requireBundleId(input.args.bundle_id) !== state.bundleId) {
        throw new AssistantPluginError('IOS_DEVICE_DOCUMENT_TARGET_MISMATCH', 'Document consent does not match the exact app session.', { retryable: false });
      }
      if (!state.device.connected) {
        throw new AssistantPluginError('IOS_DEVICE_NOT_CONNECTED', 'Exact iPhone is not connected.', { retryable: true });
      }
      let response: Record<string, unknown>;
      try {
        response = await runCoreJson(input, [
          'device', 'info', 'files', '--device', state.device.identifier,
          '--domain-type', 'appDataContainer', '--domain-identifier', state.bundleId,
          '--subdirectory', 'Documents', '--no-recurse',
        ], 'IOS_DEVICE_DOCUMENT_LIST_FAILED', 60_000);
      } catch (error) {
        // CoreDevice's raw errors may contain private document names or paths.
        // Keep the stable failure code, not stderr, stdout or command arguments.
        throw new AssistantPluginError('IOS_DEVICE_DOCUMENT_LIST_UNVERIFIED',
          'The selected app document listing could not be verified.',
          { retryable: false, details: {
            causeCode: error instanceof AssistantPluginError ? error.code : 'COREDEVICE_LIST_FAILURE',
          } });
      }
      const result = objectValue(response.result);
      const entries = Array.isArray(result.files) ? result.files
        : Array.isArray(result.entries) ? result.entries : undefined;
      if (!entries) {
        throw new AssistantPluginError('IOS_DEVICE_DOCUMENT_LIST_SCHEMA_UNKNOWN',
          'CoreDevice did not return a recognized file listing; no documents were verified.',
          { retryable: false });
      }
      // A recognized top-level array with unrecognized row fields is not an
      // empty directory. Reject it rather than falsely reporting no documents.
      const listedNames = entries.map((entry) => typeof entry === 'string' ? entry
        : stringField(objectValue(entry), 'name') ?? stringField(objectValue(entry), 'fileName'));
      if (listedNames.some((name) => typeof name !== 'string' || !name.trim())) {
        throw new AssistantPluginError('IOS_DEVICE_DOCUMENT_LIST_SCHEMA_UNKNOWN',
          'CoreDevice returned file entries without recognizable names; document presence is unverified.',
          { retryable: false });
      }
      const names = (listedNames as string[]).filter((name) =>
        !name.includes('/') && !name.includes('\\')
        && /\.(?:pdf|png|jpe?g|heic)$/i.test(name)).slice(0, 100);
      return { provider: 'coredevice', deviceUnmodified: true,
        interactionId: record.interactionId, bundleId: state.bundleId,
        domain: 'appDataContainer/Documents', names, truncated: entries.length > 100 };
    }
    case 'physical_device_document_export': {
      if (requireBundleId(input.args.bundle_id) !== state.bundleId) {
        throw new AssistantPluginError('IOS_DEVICE_DOCUMENT_TARGET_MISMATCH', 'Document consent does not match the exact app session.', { retryable: false });
      }
      if (!state.device.connected) {
        throw new AssistantPluginError('IOS_DEVICE_NOT_CONNECTED', 'Exact iPhone is not connected.', { retryable: true });
      }
      const path = requireAppDocumentPath(input.args.path);
      const dir = join(artifactDir(input, record.interactionId), 'private-documents');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!lstatSync(dir).isDirectory()) {
        throw new AssistantPluginError('IOS_DEVICE_DOCUMENT_ARTIFACT_INVALID', 'The private document directory is not a regular directory.', { retryable: false });
      }
      chmodSync(dir, 0o700);
      const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
      const destination = join(dir, randomUUID() + ext);
      try {
        // Validate the existing manifest before copying anything from the
        // phone. Corrupt, oversized or foreign records cannot be overwritten.
        const indexPath = join(dir, 'index.json');
        let entries: Array<Record<string, unknown>> = [];
        if (existsSync(indexPath)) {
          const indexFile = lstatSync(indexPath);
          if (!indexFile.isFile() || indexFile.size <= 0 || indexFile.size > MAX_DOCUMENT_INDEX_BYTES) {
            throw new AssistantPluginError('IOS_DEVICE_DOCUMENT_INDEX_INVALID',
              'The private document index is not a bounded regular file.', { retryable: false });
          }
          const prior = readJsonFile<unknown>(indexPath);
          const index = objectValue(prior);
          const stored = index.entries;
          const validEntries = Array.isArray(stored) && stored.length <= 500
            && stored.every((item) => {
              const row = objectValue(item);
              return typeof row.exportedAt === 'string' && !Number.isNaN(Date.parse(row.exportedAt))
                && typeof row.sourcePath === 'string' && /^Documents\/[^/\\]+\.(?:pdf|png|jpe?g|heic)$/i.test(row.sourcePath)
                && typeof row.artifactName === 'string' && /^[a-f0-9-]{36}\.(?:pdf|png|jpe?g|heic)$/i.test(row.artifactName)
                && typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sha256)
                && typeof row.bytes === 'number' && Number.isSafeInteger(row.bytes)
                && row.bytes > 0 && row.bytes <= MAX_EXPORTED_DOCUMENT_BYTES;
            });
          if (index.schemaVersion !== 1 || index.bundleId !== state.bundleId
            || index.interactionId !== record.interactionId || !validEntries) {
            throw new AssistantPluginError('IOS_DEVICE_DOCUMENT_INDEX_INVALID',
              'The private document index belongs to another session or is malformed.', { retryable: false });
          }
          entries = stored as Array<Record<string, unknown>>;
        }
        if (entries.length >= 500) {
          throw new AssistantPluginError('IOS_DEVICE_DOCUMENT_INDEX_FULL',
            'The private document index has reached its 500-item limit.', { retryable: false });
        }
        await runCoreJson(input, [
          'device', 'copy', 'from', '--device', state.device.identifier,
          '--domain-type', 'appDataContainer', '--domain-identifier', state.bundleId,
          '--source', path, '--destination', destination,
        ], 'IOS_DEVICE_DOCUMENT_EXPORT_FAILED', 90_000);
        const file = lstatSync(destination);
        if (!file.isFile() || file.size <= 0 || file.size > MAX_EXPORTED_DOCUMENT_BYTES) {
          throw new AssistantPluginError('IOS_DEVICE_DOCUMENT_EXPORT_INVALID',
            'Expected exactly one nonempty regular document of at most 20 MiB.', { retryable: false });
        }
        chmodSync(destination, 0o600);
        const bytes = readFileSync(destination);
        // Validate more than magic bytes: a truncated CoreDevice copy must not
        // become a successful medical-document export or organized index entry.
        const isExpectedFormat = ext === '.pdf'
          ? bytes.subarray(0, 5).toString('ascii') === '%PDF-'
            && /%%EOF[\x00\x09\x0a\x0c\x0d\x20]*$/.test(bytes.subarray(-2048).toString('latin1'))
          : ext === '.png' ? pngDisplayGeometry(bytes) !== undefined
            : ext === '.jpg' || ext === '.jpeg'
              ? bytes.length > 4 && bytes.subarray(0, 3).toString('hex') === 'ffd8ff'
                && bytes.subarray(-2).toString('hex') === 'ffd9'
              : ext === '.heic' && bytes.length >= 16
                && bytes.subarray(4, 8).toString('ascii') === 'ftyp'
                && /^(?:heic|heix|hevc|hevx|mif1|msf1)$/.test(bytes.subarray(8, 12).toString('ascii'))
                && bytes.readUInt32BE(0) >= 16 && bytes.readUInt32BE(0) <= bytes.length;
        if (!isExpectedFormat) {
          throw new AssistantPluginError('IOS_DEVICE_DOCUMENT_FORMAT_INVALID',
            'Exported document framing is invalid or incomplete for the selected file type.', { retryable: false });
        }
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        // One canonical export writer also maintains a bounded private index of
        // facts; medical meaning and cross-app classification stay with the model.
        const entry = { exportedAt: timestamp(), sourcePath: path,
          artifactName: destination.slice(dir.length + 1), sha256, bytes: file.size };
        // Atomic rename is the last fallible operation before acknowledging the
        // export; a failed index update cannot produce a successful receipt.
        writeJsonAtomic(indexPath, { schemaVersion: 1, bundleId: state.bundleId,
          interactionId: record.interactionId, entries: [...entries, entry] }, { mode: 0o600 });
        return { provider: 'coredevice', deviceUnmodified: true, externallyUploaded: false,
          interactionId: record.interactionId, bundleId: state.bundleId,
          document: { domain: 'appDataContainer', sourcePath: path, localArtifact: destination,
            sha256, bytes: file.size },
          organizedIndex: { localArtifact: indexPath, entryCount: entries.length + 1 } };
      } catch (error) {
        // Raw CoreDevice error details may contain sensitive document filenames.
        // Never expose those details or retry an unknown/partial copy.
        let cleanup = 'no_partial_artifact';
        if (existsSync(destination)) {
          try { unlinkSync(destination); cleanup = 'partial_artifact_deleted'; }
          catch { cleanup = 'partial_artifact_cleanup_failed'; }
        }
        throw new AssistantPluginError('IOS_DEVICE_DOCUMENT_EXPORT_UNVERIFIED',
          'The selected document export was not verified. Input is not replayable.',
          { retryable: false, details: {
            causeCode: error instanceof AssistantPluginError ? error.code : 'FILE_VERIFICATION_FAILED',
            cleanup,
          } });
      }
    }
    case 'physical_device_screenshot': {
      const captured = await capturePhysicalScreen(input, state, sanitize(optionalString(input.args.label) ?? 'screenshot'));
      const { screenshotResult, ...observation } = captured;
      return finishTimedResult(actionStartedAt, timingStages, {
        provider: 'coredevice', interaction: record, result: screenshotResult, ...observation,
      });
    }
    case 'physical_device_confirm_foreground': {
      const observationId = requireString(input.args.observation_id, 'observation_id');
      const bundleId = requireString(input.args.bundle_id, 'bundle_id');
      if (bundleId !== state.bundleId) {
        throw new AssistantPluginError('IOS_DEVICE_FOREGROUND_OBSERVATION_MISMATCH', `Foreground confirmation bundle ${bundleId} does not match session target ${state.bundleId}.`, {
          retryable: false,
          details: { expectedBundleId: state.bundleId, providedBundleId: bundleId, hidMutationDispatched: false },
        });
      }
      const { observation, ageMs } = recentScreenshotObservation(state, observationId);
      const confirmedAt = timestamp();
      state.foregroundObservation = {
        observationId: observation.observationId,
        screenshotObservedAt: observation.observedAt,
        confirmedAt,
        bundleId,
      };
      writeState(input, state);
      appendEvent(input, record.interactionId, 'foreground_confirmed', { observationId, bundleId, screenshotAgeMs: ageMs });
      return {
        provider: 'coredevice',
        interaction: record,
        foregroundObservation: { observationId, bundleId, screenshotObservedAt: observation.observedAt, confirmedAt, ttlMs: INPUT_FOREGROUND_OBSERVATION_TTL_MS },
        deviceUnmodified: true,
      };
    }
    case 'physical_device_observed_tap':
    case 'physical_device_observed_swipe': {
      const lockStartedAt = performance.now();
      const unlock = await requireSessionUnlocked(input, state);
      recordTiming(timingStages, 'lockState', lockStartedAt, unlock.cached);
      if (!state.device.udid) throw new AssistantPluginError('IOS_HID_UDID_MISSING', 'The selected iPhone does not expose a hardware UDID for RemoteXPC HID.', { retryable: false });
      const observationId = requireString(input.args.observation_id, 'observation_id');
      const observationStartedAt = performance.now();
      const { observation, ageMs } = recentScreenshotObservation(state, observationId);
      recordTiming(timingStages, 'screenObservation', observationStartedAt, true);
      const displayStartedAt = performance.now();
      const geometry = await sessionDisplayGeometry(input, state);
      recordTiming(timingStages, 'displayInfo', displayStartedAt, geometry.cached);
      const display = geometry.display;
      const x = requireFiniteNumber(input.args.x, 'x');
      const y = requireFiniteNumber(input.args.y, 'y');
      const swipe = input.actionId === 'physical_device_observed_swipe';
      const x2 = swipe ? requireFiniteNumber(input.args.to_x, 'to_x') : undefined;
      const y2 = swipe ? requireFiniteNumber(input.args.to_y, 'to_y') : undefined;
      const durationMs = swipe && typeof input.args.duration_ms === 'number'
        ? Math.trunc(input.args.duration_ms) : 250;
      consumePhysicalScreenObservation(input, state);
      const hidStartedAt = performance.now();
      const result = await executeRemoteXpcHidInput({
        controllerHome: input.controllerHome, deviceIdentifier: state.device.identifier, udid: state.device.udid,
        width: display.width, height: display.height, action: swipe ? 'swipe' : 'tap',
        x, y, ...(swipe ? { x2, y2, durationMs } : {}),
      });
      timingStages.hidWorkerReady = { ms: result.timings.workerStartupMs + result.timings.workerReadyMs, cached: result.reusedWorker };
      timingStages.hidWriteAck = { ms: result.timings.hidMs ?? result.timings.requestMs, cached: false };
      timingStages.hidRequestTotal = { ms: elapsedMs(hidStartedAt), cached: result.reusedWorker };
      appendEvent(input, record.interactionId, swipe ? 'observed_swipe' : 'observed_tap', {
        requestId: input.requestId, observationId: observation.observationId, observationAgeMs: ageMs,
        x, y, ...(swipe ? { x2, y2, durationMs } : {}), reusedWorker: result.reusedWorker,
      });
      const nextObservation = input.args.capture_after === true
        ? await optionalPostActionCapture(input, state, swipe ? 'swipe' : 'tap', timingStages)
        : {};
      return finishTimedResult(actionStartedAt, timingStages, { ...nextObservation, provider: 'coredevice', inputBackend: 'remote-xpc-hid', interaction: record, display, result: bounded(result), observationConsumed: true });
    }
    case 'physical_device_batch': {
      const lockStartedAt = performance.now();
      const unlock = await requireSessionUnlocked(input, state);
      recordTiming(timingStages, 'lockState', lockStartedAt, unlock.cached);
      if (!state.device.udid) throw new AssistantPluginError('IOS_HID_UDID_MISSING', 'The selected iPhone does not expose a hardware UDID for RemoteXPC HID.', { retryable: false });
      const steps = physicalInputBatchSteps(input.args.steps);
      let display: DisplayGeometry | undefined;
      if (steps.some((step) => step.kind === 'tap' || step.kind === 'swipe')) {
        const displayStartedAt = performance.now();
        const geometry = await sessionDisplayGeometry(input, state);
        recordTiming(timingStages, 'displayInfo', displayStartedAt, geometry.cached);
        display = geometry.display;
      }
      validatePhysicalInputBatchCoordinates(steps, display);
      const foregroundStartedAt = performance.now();
      const observationId = input.args.observation_id === undefined
        ? undefined
        : requireString(input.args.observation_id, 'observation_id');
      const foreground = resolvePhysicalBatchForegroundObservation(state, observationId);
      const foregroundObservation = foreground.foregroundObservation;
      recordTiming(timingStages, 'foregroundObservation', foregroundStartedAt, true);
      consumePhysicalScreenObservation(input, state);
      const batchStartedAt = performance.now();
      const completed: Array<Record<string, unknown>> = [];
      let completedMutations = 0;
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index]!;
        try {
          if (step.kind === 'wait') {
            await waitPhysicalInputBatch(step.durationMs ?? 0, input.signal);
            completed.push({ index, kind: step.kind, durationMs: step.durationMs ?? 0 });
            continue;
          }
          let result: Awaited<ReturnType<typeof executeRemoteXpcHidInput>>;
          if (step.kind === 'tap') {
            result = await executeRemoteXpcHidInput({
              controllerHome: input.controllerHome,
              deviceIdentifier: state.device.identifier,
              udid: state.device.udid,
              width: display?.width,
              height: display?.height,
              action: 'tap', x: step.x, y: step.y,
            });
          } else if (step.kind === 'swipe') {
            result = await executeRemoteXpcHidInput({
              controllerHome: input.controllerHome,
              deviceIdentifier: state.device.identifier,
              udid: state.device.udid,
              width: display?.width,
              height: display?.height,
              action: 'swipe', x: step.x, y: step.y, x2: step.toX, y2: step.toY, durationMs: step.durationMs,
            });
          } else {
            result = await executeRemoteXpcHidInput({
              controllerHome: input.controllerHome,
              deviceIdentifier: state.device.identifier,
              udid: state.device.udid,
              action: 'type', text: step.text, textMode: step.textMode, replaceExisting: step.replaceExisting,
            });
          }
          completedMutations += 1;
          completed.push({
            index,
            kind: step.kind,
            reusedWorker: result.reusedWorker,
            requestMs: result.timings.requestMs,
            hidMs: result.timings.hidMs,
            ...(step.kind === 'type' ? { inputMode: objectValue(result.result).inputMode } : {}),
          });
        } catch (error) {
          const normalized = toAssistantPluginError(error, {
            code: 'IOS_HID_BATCH_FAILED',
            message: `Physical iOS input batch failed at step ${index}.`,
            retryable: false,
          });
          const eventStartedAt = performance.now();
          const causeDetails = normalized.details && typeof normalized.details === 'object' && !Array.isArray(normalized.details)
            ? normalized.details as Record<string, unknown>
            : {};
          const retryWholeBatch = completedMutations === 0 && causeDetails.mutationDispatched === false;
          const causePhase = typeof causeDetails.phase === 'string' ? causeDetails.phase : undefined;
          const causeMutationDispatched = typeof causeDetails.mutationDispatched === 'boolean'
            ? causeDetails.mutationDispatched
            : undefined;
          const causeMessage = normalized.message.startsWith(`${normalized.code}: `)
            ? normalized.message.slice(normalized.code.length + 2, normalized.code.length + 514)
            : normalized.message.slice(0, 512);
          appendEvent(input, record.interactionId, 'batch_failed', {
            requestId: input.requestId,
            failedStepIndex: index,
            failedStepKind: step.kind,
            completedSteps: completed.length,
            completedMutations,
            retryWholeBatch,
            causeCode: normalized.code,
            ...(causePhase ? { causePhase } : {}),
            ...(causeMutationDispatched === undefined ? {} : { mutationDispatched: causeMutationDispatched }),
            causeMessage,
          });
          recordTiming(timingStages, 'eventPersistence', eventStartedAt, false);
          throw new AssistantPluginError(
            'IOS_HID_BATCH_FAILED',
            retryWholeBatch
              ? `Physical iOS input batch stopped at step ${index} before any HID mutation was sent; retrying the whole batch is safe.`
              : `Physical iOS input batch stopped at step ${index}; do not retry the whole batch because an earlier or in-flight step may already have mutated the app.`,
            {
              retryable: retryWholeBatch,
              details: {
                failedStepIndex: index,
                failedStepKind: step.kind,
                completedSteps: completed.length,
                completedMutations,
                retryWholeBatch,
                causeCode: normalized.code,
                ...(causePhase ? { causePhase } : {}),
                ...(causeMutationDispatched === undefined ? {} : { mutationDispatched: causeMutationDispatched }),
                causeMessage,
              },
            },
          );
        }
      }
      recordTiming(timingStages, 'hidBatchTotal', batchStartedAt, false);
      const eventStartedAt = performance.now();
      appendEvent(input, record.interactionId, 'batch_input', {
        requestId: input.requestId,
        stepCount: steps.length,
        mutationCount: completedMutations,
        kinds: steps.map((step) => step.kind),
      });
      recordTiming(timingStages, 'eventPersistence', eventStartedAt, false);
      const nextObservation = input.args.capture_after === true
        ? await optionalPostActionCapture(input, state, 'batch', timingStages)
        : {};
      return finishTimedResult(actionStartedAt, timingStages, {
        ...nextObservation,
        provider: 'coredevice',
        inputBackend: 'remote-xpc-hid',
        interaction: record,
        ...(display ? { display } : {}),
        completed,
        foregroundObservation: {
          ...foregroundObservation,
          consumed: true,
          source: foreground.source,
          ...(foreground.screenshotAgeMs === undefined ? {} : { screenshotAgeMs: foreground.screenshotAgeMs }),
        },
        executionPlan: {
          foregroundActivations: 0,
          foregroundObservationChecks: 1,
          foregroundObservationSource: foreground.source,
          unlockChecks: unlock.cached ? 0 : 1,
          displayLookups: display ? 1 : 0,
          pluginRoundTrips: 1,
          runnerOwned: false,
        },
      });
    }
    case 'physical_device_tap': {
      const lockStartedAt = performance.now();
      const unlock = await requireSessionUnlocked(input, state);
      recordTiming(timingStages, 'lockState', lockStartedAt, unlock.cached);
      if (!state.device.udid) throw new AssistantPluginError('IOS_HID_UDID_MISSING', 'The selected iPhone does not expose a hardware UDID for RemoteXPC HID.', { retryable: false });
      const displayStartedAt = performance.now();
      const geometry = await sessionDisplayGeometry(input, state);
      recordTiming(timingStages, 'displayInfo', displayStartedAt, geometry.cached);
      const display = geometry.display;
      const x = requireFiniteNumber(input.args.x, 'x');
      const y = requireFiniteNumber(input.args.y, 'y');
      const foregroundStartedAt = performance.now();
      const foregroundObservation = requireObservedPhysicalTargetForeground(state);
      recordTiming(timingStages, 'foregroundObservation', foregroundStartedAt, true);
      consumePhysicalScreenObservation(input, state);
      const hidStartedAt = performance.now();
      const result = await executeRemoteXpcHidInput({
        controllerHome: input.controllerHome,
        deviceIdentifier: state.device.identifier,
        udid: state.device.udid,
        width: display.width,
        height: display.height,
        action: 'tap', x, y,
      });
      timingStages.hidWorkerReady = { ms: result.timings.workerStartupMs + result.timings.workerReadyMs, cached: result.reusedWorker };
      timingStages.hidWriteAck = { ms: result.timings.hidMs ?? result.timings.requestMs, cached: false };
      timingStages.hidRequestTotal = { ms: elapsedMs(hidStartedAt), cached: result.reusedWorker };
      const eventStartedAt = performance.now();
      appendEvent(input, record.interactionId, 'tap', { requestId: input.requestId, x, y, width: display.width, height: display.height, reusedWorker: result.reusedWorker });
      recordTiming(timingStages, 'eventPersistence', eventStartedAt, false);
      return finishTimedResult(actionStartedAt, timingStages, { provider: 'coredevice', inputBackend: 'remote-xpc-hid', interaction: record, display, result: bounded(result), foregroundObservation: { ...foregroundObservation, consumed: true } });
    }
    case 'physical_device_swipe': {
      const lockStartedAt = performance.now();
      const unlock = await requireSessionUnlocked(input, state);
      recordTiming(timingStages, 'lockState', lockStartedAt, unlock.cached);
      if (!state.device.udid) throw new AssistantPluginError('IOS_HID_UDID_MISSING', 'The selected iPhone does not expose a hardware UDID for RemoteXPC HID.', { retryable: false });
      const displayStartedAt = performance.now();
      const geometry = await sessionDisplayGeometry(input, state);
      recordTiming(timingStages, 'displayInfo', displayStartedAt, geometry.cached);
      const display = geometry.display;
      const x = requireFiniteNumber(input.args.x, 'x');
      const y = requireFiniteNumber(input.args.y, 'y');
      const x2 = requireFiniteNumber(input.args.to_x, 'to_x');
      const y2 = requireFiniteNumber(input.args.to_y, 'to_y');
      const durationMs = typeof input.args.duration_ms === 'number' ? Math.trunc(input.args.duration_ms) : 250;
      const foregroundStartedAt = performance.now();
      const foregroundObservation = requireObservedPhysicalTargetForeground(state);
      recordTiming(timingStages, 'foregroundObservation', foregroundStartedAt, true);
      consumePhysicalScreenObservation(input, state);
      const hidStartedAt = performance.now();
      const result = await executeRemoteXpcHidInput({
        controllerHome: input.controllerHome,
        deviceIdentifier: state.device.identifier,
        udid: state.device.udid,
        width: display.width,
        height: display.height,
        action: 'swipe', x, y, x2, y2, durationMs,
      });
      timingStages.hidWorkerReady = { ms: result.timings.workerStartupMs + result.timings.workerReadyMs, cached: result.reusedWorker };
      timingStages.hidWriteAck = { ms: result.timings.hidMs ?? result.timings.requestMs, cached: false };
      timingStages.hidRequestTotal = { ms: elapsedMs(hidStartedAt), cached: result.reusedWorker };
      const eventStartedAt = performance.now();
      appendEvent(input, record.interactionId, 'swipe', { requestId: input.requestId, from: [x, y], to: [x2, y2], durationMs, reusedWorker: result.reusedWorker });
      recordTiming(timingStages, 'eventPersistence', eventStartedAt, false);
      return finishTimedResult(actionStartedAt, timingStages, { provider: 'coredevice', inputBackend: 'remote-xpc-hid', interaction: record, display, result: bounded(result), foregroundObservation: { ...foregroundObservation, consumed: true } });
    }
    case 'physical_device_type_text': {
      const lockStartedAt = performance.now();
      const unlock = await requireSessionUnlocked(input, state);
      recordTiming(timingStages, 'lockState', lockStartedAt, unlock.cached);
      if (!state.device.udid) throw new AssistantPluginError('IOS_HID_UDID_MISSING', 'The selected iPhone does not expose a hardware UDID for RemoteXPC HID.', { retryable: false });
      const text = requireString(input.args.text, 'text');
      const textMode = optionalString(input.args.input_mode) ?? 'auto';
      if (!['auto', 'keys', 'pasteboard'].includes(textMode)) {
        throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Unsupported input_mode: ${textMode}.`, { retryable: false });
      }
      const foregroundStartedAt = performance.now();
      const foregroundObservation = requireObservedPhysicalTargetForeground(state);
      recordTiming(timingStages, 'foregroundObservation', foregroundStartedAt, true);
      consumePhysicalScreenObservation(input, state);
      const hidStartedAt = performance.now();
      const result = await executeRemoteXpcHidInput({
        controllerHome: input.controllerHome,
        deviceIdentifier: state.device.identifier,
        udid: state.device.udid,
        action: 'type', text, textMode: textMode as 'auto' | 'keys' | 'pasteboard', replaceExisting: input.args.replace_existing === true,
      });
      timingStages.hidWorkerReady = { ms: result.timings.workerStartupMs + result.timings.workerReadyMs, cached: result.reusedWorker };
      timingStages.hidWriteAck = { ms: result.timings.hidMs ?? result.timings.requestMs, cached: false };
      timingStages.hidRequestTotal = { ms: elapsedMs(hidStartedAt), cached: result.reusedWorker };
      const eventStartedAt = performance.now();
      appendEvent(input, record.interactionId, 'type_text', { requestId: input.requestId, length: text.length, reusedWorker: result.reusedWorker });
      recordTiming(timingStages, 'eventPersistence', eventStartedAt, false);
      return finishTimedResult(actionStartedAt, timingStages, { provider: 'coredevice', inputBackend: 'remote-xpc-hid', interaction: record, result: bounded(result), text: '<redacted>', foregroundObservation: { ...foregroundObservation, consumed: true } });
    }
    case 'physical_device_events': {
      const limit = Math.max(1, Math.min(MAX_EVENTS, typeof input.args.limit === 'number' ? Math.trunc(input.args.limit) : 50));
      return { provider: 'coredevice', interaction: record, events: bounded(state.events.slice(-limit)) };
    }
    case 'physical_device_close': {
      const inputWorkerRelease = stopRemoteXpcHidForDevice(state.device.identifier);
      const wasActive = isInteractionSessionActive(record.status);
      if (!wasActive) return { provider: 'coredevice', interaction: record, alreadyClosed: true, deviceUnmodified: true, inputWorkerRelease };
      patchInteractionSession(input.repoRoot, PROVIDER, record.interactionId, { status: 'closing' });
      appendEvent(input, record.interactionId, 'session_closed', { inputWorkerRelease });
      const finalRecord = patchInteractionSession(input.repoRoot, PROVIDER, record.interactionId, { status: 'closed', error: undefined }) ?? record;
      const deviceOwnershipReleased = releaseIosDeviceOwnership(input.controllerHome, input.repoId, record.interactionId, iosCoreDeviceOwnershipId(state.device));
      return { provider: 'coredevice', interaction: finalRecord, deviceUnmodified: true, inputWorkerRelease, deviceOwnershipReleased };
    }
    default:
      throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', `ios/${input.actionId} is not supported.`, { retryable: false });
  }
}
