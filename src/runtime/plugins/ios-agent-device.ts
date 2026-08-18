import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, realpathSync } from 'fs';
import { delimiter, dirname, isAbsolute, join } from 'path';
import { spawnSync } from 'child_process';
import { performance } from 'perf_hooks';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { runBoundedProcess } from '../execution/thin-harness/async-process';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';
import { resolveTrustedNodeExecutable } from '../shared/trusted-node-executable';
import { AssistantPluginError, toAssistantPluginError } from './errors';
import {
  interactionAutomationEngine,
  interactionMayOwnTarget,
  interactionTargetIdentifiers,
  isInteractionSessionActive,
  listInteractionSessions,
  patchInteractionSession,
  pruneInteractionSessions,
  readInteractionSession,
  writeInteractionSession,
  type InteractionProvider,
  type InteractionSessionRecord,
} from './interaction-session';
import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginCapability,
} from './types';
import {
  appendSettleFlag,
  compileBatchCommand,
  compileSnapshotCommand,
  detectAgentDeviceCapabilities,
  PREFERRED_AGENT_DEVICE_VERSION,
  type AgentDeviceCapabilityProfile,
  type AgentDeviceHelpContract,
} from './ios/agent-device-capabilities';
import { classifyAgentDeviceFailure, preserveSessionFailure } from './ios/agent-device-failures';
import {
  findSemanticNode,
  findSemanticRef,
  JD_IOS_APP_ADAPTER,
  normalizedSemanticRef,
} from './ios/app-adapters';
import {
  agentDeviceProviderVersionsMatch,
  configuredAgentDeviceBackendMode,
  type AgentDeviceSnapshotRequest,
} from './ios/agent-device-provider';
import {
  isTypedProviderUnavailable,
  TypedAgentDeviceReadProvider,
  typedAgentDeviceIdentity,
} from './ios/agent-device-typed-provider';

export const IOS_AGENT_DEVICE_VERSION = PREFERRED_AGENT_DEVICE_VERSION;
const SIMULATOR_PROVIDER = 'ios-simulator' as const;
const DEVICE_PROVIDER = 'ios-device' as const;
const PROVIDERS: InteractionProvider[] = [SIMULATOR_PROVIDER, DEVICE_PROVIDER];
const STATUS_TTL_MS = 60_000;
const MAX_JSON_BYTES = 64 * 1024;
const SESSION_EXPIRY_MS = 2 * 60 * 60_000;
const JD_BUNDLE_ID = 'com.360buy.jdmobile';
const MAX_JD_QUERY_LENGTH = 120;
const MAX_BATCH_STEPS = 20;
const DEFAULT_AGENT_DEVICE_IDLE_MS = '300000';
const BATCH_KINDS = ['snapshot', 'press', 'fill', 'scroll', 'keyboard', 'wait', 'back'] as const;
type AgentDeviceBatchKind = typeof BATCH_KINDS[number];

interface AgentDeviceBatchStep {
  kind: AgentDeviceBatchKind;
  input: Record<string, unknown>;
}

interface PreparedAgentDeviceBatch {
  nativeSteps: Array<{ command: AgentDeviceBatchKind; input: Record<string, unknown> }>;
  redactions: string[];
}
const SENSITIVE_SEMANTICS = /secure\s*text|securetextfield|password|passcode|verification|one[ -]?time|otp|2fa|密码|口令|验证码|校验码|短信码|生物识别|biometric|face\s?id|touch\s?id|支付|付款|购买|下单|提交订单|确认订单|结算|checkout|payment|purchase|confirm\s+order|bank|card|cvv|身份证/i;

interface AgentDeviceSigningConfig {
  schemaVersion: 1;
  teamId?: string;
  bundleId?: string;
  developerDir?: string;
}

interface CommandResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  command: string[];
  timedOut?: boolean;
  cancelled?: boolean;
}

interface CommandOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface IosAgentDeviceRuntimeHooks {
  platform(): NodeJS.Platform;
  now(): Date;
  runCommand(command: string, args: string[], options?: CommandOptions): CommandResult;
  runCommandAsync(command: string, args: string[], options?: CommandOptions): Promise<CommandResult>;
}

const defaultHooks: IosAgentDeviceRuntimeHooks = {
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
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    return {
      ok: result.status === 0 && !timedOut,
      status: result.status,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? result.error?.message ?? ''),
      command: [command, ...args],
      timedOut,
      cancelled: options.signal?.aborted === true,
    };
  },
  runCommandAsync: async (command, args, options = {}) => {
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
      timedOut: result.timedOut,
      cancelled: result.cancelled,
    };
  },
};

let hooks: IosAgentDeviceRuntimeHooks = { ...defaultHooks };
let statusCache: { cacheKey: string; expiresAt: number; value: ReturnType<typeof probeStatus> } | undefined;
const interactionCommandTails = new Map<string, Promise<void>>();

export function setIosAgentDeviceRuntimeHooksForTest(overrides: Partial<IosAgentDeviceRuntimeHooks>): void {
  hooks = { ...defaultHooks, ...overrides };
  if (overrides.runCommand && !overrides.runCommandAsync) {
    hooks.runCommandAsync = async (command, args, options) => overrides.runCommand!(command, args, options);
  }
  statusCache = undefined;
  interactionCommandTails.clear();
}

export function resetIosAgentDeviceRuntimeHooksForTest(): void {
  hooks = { ...defaultHooks };
  statusCache = undefined;
  interactionCommandTails.clear();
}

function configuredExecutable(): string | undefined {
  return process.env.FORGE_AGENT_DEVICE_EXECUTABLE?.trim() || undefined;
}

function repoLocalExecutable(repoRoot?: string): string | undefined {
  if (!repoRoot) return undefined;
  const candidates = [
    join(repoRoot, 'node_modules', '.bin', 'agent-device'),
    join(repoRoot, 'node_modules', 'agent-device', 'bin', 'agent-device.mjs'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try { return realpathSync(candidate); } catch { return candidate; }
  }
  return undefined;
}

function executable(repoRoot?: string): string {
  const configured = configuredExecutable();
  if (configured) return configured;
  return repoLocalExecutable(repoRoot) ?? 'agent-device';
}

function resolvedExecutable(repoRoot?: string): string {
  const configured = executable(repoRoot);
  if (isAbsolute(configured)) {
    try { return realpathSync(configured); } catch { return configured; }
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, configured);
    if (!existsSync(candidate)) continue;
    try { return realpathSync(candidate); } catch { return candidate; }
  }
  return configured;
}

function withTrustedNodePath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const node = resolveTrustedNodeExecutable(env).executable;
  if (!node) return env;
  const path = [dirname(node), env.PATH].filter((value): value is string => Boolean(value)).join(delimiter);
  return { ...env, PATH: path };
}

function timestamp(): string {
  return hooks.now().toISOString();
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'ios-agent-device';
}

function statusProbeCacheKey(repoRoot?: string): string {
  return [
    hooks.platform(),
    repoRoot ?? '',
    executable(repoRoot),
    resolvedExecutable(repoRoot),
    configuredAgentDeviceBackendMode(),
    process.versions.node,
    process.env.PATH ?? '',
  ].join('|');
}

function probeStatus(repoRoot?: string) {
  const backendMode = configuredAgentDeviceBackendMode();
  const typedClient = typedAgentDeviceIdentity({ repoRoot });
  if (hooks.platform() !== 'darwin') {
    return {
      available: false,
      expectedVersion: IOS_AGENT_DEVICE_VERSION,
      supportedVersionPolicy: '>=0.19.3 <0.21.0 with reviewed command contract',
      detectedVersion: undefined,
      executable: executable(repoRoot),
      resolvedExecutable: resolvedExecutable(repoRoot),
      platform: hooks.platform(),
      capabilityProfile: detectAgentDeviceCapabilities('', {}),
      backendMode,
      typedClient,
      reason: 'agent-device iOS support requires macOS.',
    };
  }
  const runtimeEnv = withTrustedNodePath({ ...process.env });
  const result = hooks.runCommand(executable(repoRoot), ['--version'], { cwd: repoRoot, env: runtimeEnv, timeoutMs: 3_000 });
  const detectedVersion = result.ok ? result.stdout.trim() : undefined;
  const help: AgentDeviceHelpContract = {};
  if (result.ok && detectedVersion) {
    const rootHelp = hooks.runCommand(executable(repoRoot), ['help'], { cwd: repoRoot, env: runtimeEnv, timeoutMs: 3_000 });
    if (rootHelp.ok) help.root = rootHelp.stdout || rootHelp.stderr;
    for (const topic of ['snapshot', 'press', 'fill', 'batch', 'keyboard'] as const) {
      const topicResult = hooks.runCommand(executable(repoRoot), ['help', topic], { cwd: repoRoot, env: runtimeEnv, timeoutMs: 3_000 });
      if (topicResult.ok) help[topic] = topicResult.stdout || topicResult.stderr;
    }
  }
  const capabilityProfile = detectAgentDeviceCapabilities(detectedVersion ?? '', help);
  const typedClientWithCompatibility = {
    ...typedClient,
    cliVersion: detectedVersion,
    cliVersionCompatible: agentDeviceProviderVersionsMatch(typedClient.version, detectedVersion),
  };
  const available = result.ok
    && capabilityProfile.versionSupported
    && Boolean(capabilityProfile.snapshot.interactiveFlag)
    && capabilityProfile.press.supported
    && capabilityProfile.fill.supported
    && capabilityProfile.batch.supported;
  return {
    available,
    expectedVersion: IOS_AGENT_DEVICE_VERSION,
    supportedVersionPolicy: '>=0.19.3 <0.21.0 with reviewed command contract',
    detectedVersion,
    executable: executable(repoRoot),
    resolvedExecutable: resolvedExecutable(repoRoot),
    platform: hooks.platform(),
    capabilityProfile,
    backendMode,
    typedClient: typedClientWithCompatibility,
    reason: !result.ok
      ? (result.stderr || result.stdout || 'agent-device is not installed.')
      : !capabilityProfile.versionSupported
        ? `Unsupported agent-device version ${detectedVersion || 'unknown'}; expected the reviewed >=0.19.3 <0.21.0 contract.`
        : !available
          ? 'The installed agent-device command contract is missing required snapshot, press, fill, or batch capabilities.'
          : undefined,
  };
}

function unprobedAgentDeviceStatus(repoRoot?: string): ReturnType<typeof probeStatus> {
  const backendMode = configuredAgentDeviceBackendMode();
  const typedClient = typedAgentDeviceIdentity({ repoRoot });
  return {
    available: false,
    expectedVersion: IOS_AGENT_DEVICE_VERSION,
    supportedVersionPolicy: '>=0.19.3 <0.21.0 with reviewed command contract',
    detectedVersion: undefined,
    executable: executable(repoRoot),
    resolvedExecutable: resolvedExecutable(repoRoot),
    platform: hooks.platform(),
    capabilityProfile: detectAgentDeviceCapabilities('', {}),
    backendMode,
    typedClient: { ...typedClient, cliVersion: undefined, cliVersionCompatible: false },
    reason: 'agent-device readiness has not been probed by an explicit asynchronous action in this runtime yet.',
  };
}

export function iosAgentDeviceStatus(options: { forceRefresh?: boolean; repoRoot?: string } = {}) {
  const nowMs = hooks.now().getTime();
  const cacheKey = statusProbeCacheKey(options.repoRoot);
  if (!options.forceRefresh
    && statusCache
    && statusCache.cacheKey === cacheKey
    && statusCache.expiresAt > nowMs) return statusCache.value;
  if (hooks.platform() !== 'darwin') return probeStatus(options.repoRoot);
  return unprobedAgentDeviceStatus(options.repoRoot);
}

async function probeStatusAsync(input: Pick<AssistantPluginActionExecutionInput, 'repoRoot' | 'signal'>): Promise<ReturnType<typeof probeStatus>> {
  const repoRoot = input.repoRoot;
  const backendMode = configuredAgentDeviceBackendMode();
  const typedClient = typedAgentDeviceIdentity({ repoRoot });
  if (hooks.platform() !== 'darwin') return probeStatus(repoRoot);
  const runtimeEnv = withTrustedNodePath({ ...process.env });
  const result = await hooks.runCommandAsync(executable(repoRoot), ['--version'], {
    cwd: repoRoot,
    env: runtimeEnv,
    timeoutMs: 3_000,
    signal: input.signal,
  });
  const detectedVersion = result.ok ? result.stdout.trim() : undefined;
  const help: AgentDeviceHelpContract = {};
  if (result.ok && detectedVersion) {
    const rootHelp = await hooks.runCommandAsync(executable(repoRoot), ['help'], {
      cwd: repoRoot, env: runtimeEnv, timeoutMs: 3_000, signal: input.signal,
    });
    if (rootHelp.ok) help.root = rootHelp.stdout || rootHelp.stderr;
    for (const topic of ['snapshot', 'press', 'fill', 'batch', 'keyboard'] as const) {
      const topicResult = await hooks.runCommandAsync(executable(repoRoot), ['help', topic], {
        cwd: repoRoot, env: runtimeEnv, timeoutMs: 3_000, signal: input.signal,
      });
      if (topicResult.ok) help[topic] = topicResult.stdout || topicResult.stderr;
    }
  }
  const capabilityProfile = detectAgentDeviceCapabilities(detectedVersion ?? '', help);
  const typedClientWithCompatibility = {
    ...typedClient,
    cliVersion: detectedVersion,
    cliVersionCompatible: agentDeviceProviderVersionsMatch(typedClient.version, detectedVersion),
  };
  const available = result.ok
    && capabilityProfile.versionSupported
    && Boolean(capabilityProfile.snapshot.interactiveFlag)
    && capabilityProfile.press.supported
    && capabilityProfile.fill.supported
    && capabilityProfile.batch.supported;
  return {
    available,
    expectedVersion: IOS_AGENT_DEVICE_VERSION,
    supportedVersionPolicy: '>=0.19.3 <0.21.0 with reviewed command contract',
    detectedVersion,
    executable: executable(repoRoot),
    resolvedExecutable: resolvedExecutable(repoRoot),
    platform: hooks.platform(),
    capabilityProfile,
    backendMode,
    typedClient: typedClientWithCompatibility,
    reason: !result.ok
      ? (result.stderr || result.stdout || 'agent-device is not installed.')
      : !capabilityProfile.versionSupported
        ? `Unsupported agent-device version ${detectedVersion || 'unknown'}; expected the reviewed >=0.19.3 <0.21.0 contract.`
        : !available
          ? 'The installed agent-device command contract is missing required snapshot, press, fill, or batch capabilities.'
          : undefined,
  };
}

async function iosAgentDeviceActionStatus(input: AssistantPluginActionExecutionInput): Promise<ReturnType<typeof probeStatus>> {
  const nowMs = hooks.now().getTime();
  const cacheKey = statusProbeCacheKey(input.repoRoot);
  if (statusCache && statusCache.cacheKey === cacheKey && statusCache.expiresAt > nowMs) return statusCache.value;
  const value = await probeStatusAsync(input);
  statusCache = { cacheKey, expiresAt: nowMs + STATUS_TTL_MS, value };
  return value;
}

function requireDependency(repoRoot?: string): ReturnType<typeof probeStatus> {
  const status = iosAgentDeviceStatus({ repoRoot });
  if (!status.available) {
    throw new AssistantPluginError('PLUGIN_DEPENDENCY_MISSING', status.reason ?? 'A compatible agent-device provider is unavailable.', {
      retryable: false,
      details: status,
    });
  }
  return status;
}

async function requireDependencyAsync(input: AssistantPluginActionExecutionInput): Promise<ReturnType<typeof probeStatus>> {
  const status = await iosAgentDeviceActionStatus(input);
  if (!status.available) {
    throw new AssistantPluginError('PLUGIN_DEPENDENCY_MISSING', status.reason ?? 'A compatible agent-device provider is unavailable.', {
      retryable: false,
      details: status,
    });
  }
  return status;
}

function capabilityProfile(repoRoot?: string): AgentDeviceCapabilityProfile {
  return requireDependency(repoRoot).capabilityProfile;
}

function controllerRoot(input: AssistantPluginActionExecutionInput): string {
  return repositoryControllerRoot(input.controllerHome, input.repoId);
}

function interactionRoot(input: AssistantPluginActionExecutionInput, interactionId: string): string {
  return join(controllerRoot(input), 'interactions', 'ios-agent-device', sanitize(interactionId));
}

function stateDir(input: AssistantPluginActionExecutionInput, interactionId: string): string {
  const path = join(interactionRoot(input, interactionId), 'state');
  mkdirSync(path, { recursive: true });
  return path;
}

function physicalDeviceRuntimeRoot(input: AssistantPluginActionExecutionInput, targetId: string): string {
  const path = join(
    controllerRoot(input),
    'interactions',
    'ios-agent-device',
    'device-runtime',
    sanitize(targetId),
  );
  mkdirSync(path, { recursive: true });
  return path;
}

function physicalDeviceRuntimeStateDir(input: AssistantPluginActionExecutionInput, targetId: string): string {
  const path = join(physicalDeviceRuntimeRoot(input, targetId), 'state');
  mkdirSync(path, { recursive: true });
  return path;
}

function runtimeStateDir(input: AssistantPluginActionExecutionInput, record: InteractionSessionRecord): string {
  // A real iPhone must not get a fresh daemon/Runner cache for every logical
  // interaction. One stable per-device runtime owns provider metadata and any
  // explicitly prepared semantic Runner. Simulator sessions remain isolated.
  return record.provider === DEVICE_PROVIDER
    ? physicalDeviceRuntimeStateDir(input, record.targetId)
    : stateDir(input, record.interactionId);
}

function targetRuntimeStateDir(input: AssistantPluginActionExecutionInput, target: AgentDeviceEntry): string | undefined {
  return target.kind === 'device' ? physicalDeviceRuntimeStateDir(input, target.id) : undefined;
}

function signingConfigPath(input: AssistantPluginActionExecutionInput, interactionId: string): string {
  return join(interactionRoot(input, interactionId), 'signing.json');
}

function readSigningConfig(
  input: AssistantPluginActionExecutionInput,
  interactionId: string,
): AgentDeviceSigningConfig | undefined {
  const value = readJsonFile<AgentDeviceSigningConfig | undefined>(signingConfigPath(input, interactionId), undefined);
  return value?.schemaVersion === 1 ? value : undefined;
}

function writeSigningConfig(
  input: AssistantPluginActionExecutionInput,
  interactionId: string,
  config: AgentDeviceSigningConfig,
): void {
  writeJsonAtomic(signingConfigPath(input, interactionId), config);
}

function signingEnv(config?: AgentDeviceSigningConfig): NodeJS.ProcessEnv {
  return {
    ...(config?.teamId ? { AGENT_DEVICE_IOS_TEAM_ID: config.teamId } : {}),
    ...(config?.bundleId ? { AGENT_DEVICE_IOS_BUNDLE_ID: config.bundleId } : {}),
    ...(config?.developerDir ? { DEVELOPER_DIR: config.developerDir } : {}),
  };
}

function artifactDir(input: AssistantPluginActionExecutionInput, interactionId: string): string {
  const path = join(controllerRoot(input), 'artifacts', 'ios', 'agent-device', sanitize(interactionId));
  mkdirSync(path, { recursive: true });
  return path;
}

function sessionEnv(input: AssistantPluginActionExecutionInput, record: InteractionSessionRecord): NodeJS.ProcessEnv {
  const config = readSigningConfig(input, record.interactionId);
  return withTrustedNodePath({
    ...process.env,
    ...signingEnv(config),
    AGENT_DEVICE_STATE_DIR: runtimeStateDir(input, record),
    AGENT_DEVICE_SESSION: record.sessionId,
    AGENT_DEVICE_PLATFORM: 'ios',
    AGENT_DEVICE_SESSION_LOCK: 'reject',
    // Keep the daemon and an explicitly prepared Runner warm. Physical devices
    // share one stable runtime state directory across logical interactions;
    // Simulator interactions remain isolated.
    AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS:
      process.env.FORGE_AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS?.trim() || DEFAULT_AGENT_DEVICE_IDLE_MS,
    AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS:
      process.env.FORGE_AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS?.trim() || DEFAULT_AGENT_DEVICE_IDLE_MS,
  });
}

function probeEnv(
  input: AssistantPluginActionExecutionInput,
  config?: AgentDeviceSigningConfig,
  requestedStateDir?: string,
): NodeJS.ProcessEnv {
  const path = requestedStateDir ?? join(controllerRoot(input), 'interactions', 'ios-agent-device', 'probe-state');
  mkdirSync(path, { recursive: true });
  return withTrustedNodePath({
    ...process.env,
    ...signingEnv(config),
    AGENT_DEVICE_STATE_DIR: path,
    AGENT_DEVICE_PLATFORM: 'ios',
    AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS:
      process.env.FORGE_AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS?.trim() || DEFAULT_AGENT_DEVICE_IDLE_MS,
    AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS:
      process.env.FORGE_AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS?.trim() || DEFAULT_AGENT_DEVICE_IDLE_MS,
  });
}

function bounded(value: unknown): unknown {
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= MAX_JSON_BYTES) return value;
  return {
    truncated: true,
    byteLength: bytes,
    preview: Buffer.from(text, 'utf8').subarray(0, MAX_JSON_BYTES).toString('utf8'),
  };
}

function redactExactText(value: unknown, text: string): unknown {
  if (!text) return value;
  if (typeof value === 'string') return value.split(text).join('<redacted>');
  if (Array.isArray(value)) return value.map((entry) => redactExactText(entry, text));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, redactExactText(entry, text)]));
  }
  return value;
}

function redactEventEvidence(value: unknown, key = ''): unknown {
  if (/^(args|arguments|input|payload|text|value)$/i.test(key)) return '<redacted>';
  if (Array.isArray(value)) return value.map((entry) => redactEventEvidence(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([entryKey, entry]) => [entryKey, redactEventEvidence(entry, entryKey)]));
  }
  return value;
}

function redactedCommand(command: string[]): string[] {
  if (command[1] !== 'fill') return command;
  const copy = [...command];
  if (copy.length > 3) copy[3] = '<redacted>';
  return copy;
}

function parseJsonResult(result: CommandResult, failureCode: string): Record<string, unknown> {
  let parsed: Record<string, unknown> | undefined;
  try {
    const value = JSON.parse(result.stdout.trim());
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    // The structured failure below includes bounded raw diagnostics.
  }
  const success = result.ok && parsed?.success !== false;
  if (!success) {
    const sensitive = result.command[1] === 'fill';
    const secret = sensitive && result.command.length > 3 ? result.command[3]! : '';
    const providerError = parsed?.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)
      ? parsed.error as Record<string, unknown>
      : undefined;
    const providerCode = typeof providerError?.code === 'string' ? providerError.code : undefined;
    const providerHint = typeof providerError?.hint === 'string' ? providerError.hint : undefined;
    const rawMessage = String(
      (typeof providerError?.message === 'string' ? providerError.message : undefined)
      || result.stderr
      || result.stdout
      || 'agent-device command failed.',
    );
    const message = String(redactExactText(rawMessage, secret));
    const terminalCode = result.cancelled
      ? 'AGENT_DEVICE_COMMAND_CANCELLED'
      : result.timedOut
        ? 'AGENT_DEVICE_COMMAND_TIMEOUT'
        : failureCode;
    throw new AssistantPluginError(terminalCode, message, {
      retryable: result.cancelled === true || result.timedOut === true,
      details: {
        status: result.status,
        command: redactedCommand(result.command),
        providerCode,
        providerHint: providerHint ? redactExactText(providerHint, secret) : undefined,
        stdout: String(redactExactText(result.stdout, secret)).slice(0, 8_000),
        stderr: String(redactExactText(result.stderr, secret)).slice(0, 8_000),
        sensitiveInputRedacted: sensitive,
        timedOut: result.timedOut === true,
        cancelled: result.cancelled === true,
      },
    });
  }
  return parsed ?? { success: true, data: { stdout: result.stdout.trim() } };
}

function actionTimeoutError(message = 'The agent-device action exceeded its request deadline.'): AssistantPluginError {
  return new AssistantPluginError('AGENT_DEVICE_COMMAND_TIMEOUT', message, { retryable: true });
}

function remainingActionTimeout(input: AssistantPluginActionExecutionInput): number | undefined {
  if (typeof input.deadlineAtMs !== 'number' || !Number.isFinite(input.deadlineAtMs)) return undefined;
  return Math.trunc(input.deadlineAtMs - Date.now());
}

function effectiveCommandTimeout(input: AssistantPluginActionExecutionInput, timeoutMs = 30_000): number {
  const remaining = remainingActionTimeout(input);
  if (remaining !== undefined && remaining <= 0) throw actionTimeoutError();
  const requestLimit = remaining !== undefined
    ? remaining
    : typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
      ? Math.max(1, Math.trunc(input.timeoutMs))
      : undefined;
  return requestLimit ? Math.max(1, Math.min(timeoutMs, requestLimit)) : timeoutMs;
}

function runJson(
  input: AssistantPluginActionExecutionInput,
  args: string[],
  options: {
    record?: InteractionSessionRecord;
    signing?: AgentDeviceSigningConfig;
    stateDir?: string;
    timeoutMs?: number;
    failureCode: string;
  },
): Record<string, unknown> {
  const result = hooks.runCommand(executable(input.repoRoot), args, {
    cwd: input.repoRoot,
    timeoutMs: effectiveCommandTimeout(input, options.timeoutMs),
    env: options.record ? sessionEnv(input, options.record) : probeEnv(input, options.signing, options.stateDir),
    signal: input.signal,
  });
  return parseJsonResult(result, options.failureCode);
}

async function runJsonAsync(
  input: AssistantPluginActionExecutionInput,
  args: string[],
  options: {
    record?: InteractionSessionRecord;
    signing?: AgentDeviceSigningConfig;
    stateDir?: string;
    timeoutMs?: number;
    failureCode: string;
  },
): Promise<Record<string, unknown>> {
  const result = await hooks.runCommandAsync(executable(input.repoRoot), args, {
    cwd: input.repoRoot,
    timeoutMs: effectiveCommandTimeout(input, options.timeoutMs),
    env: options.record ? sessionEnv(input, options.record) : probeEnv(input, options.signing, options.stateDir),
    signal: input.signal,
  });
  return parseJsonResult(result, options.failureCode);
}

interface AgentDeviceEntry {
  platform: string;
  appleOs?: string;
  id: string;
  name: string;
  kind: string;
  target?: string;
  booted: boolean;
  /** Stable provider and hardware identifiers that may name the same target. */
  aliases: string[];
}

function devices(input: AssistantPluginActionExecutionInput): AgentDeviceEntry[] {
  const response = runJson(input, ['devices', '--platform', 'ios', '--json'], {
    failureCode: 'AGENT_DEVICE_DEVICES_FAILED',
    timeoutMs: 30_000,
  });
  const data = response.data && typeof response.data === 'object' ? response.data as Record<string, unknown> : {};
  return (Array.isArray(data.devices) ? data.devices : [])
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    .map((entry) => {
      const identifiers = entry.identifiers && typeof entry.identifiers === 'object' && !Array.isArray(entry.identifiers)
        ? entry.identifiers as Record<string, unknown>
        : {};
      const ios = entry.ios && typeof entry.ios === 'object' && !Array.isArray(entry.ios)
        ? entry.ios as Record<string, unknown>
        : {};
      const id = String(entry.id ?? '');
      const aliases = Array.from(new Set([
        id,
        typeof ios.udid === 'string' ? ios.udid : undefined,
        typeof identifiers.udid === 'string' ? identifiers.udid : undefined,
        typeof identifiers.deviceId === 'string' ? identifiers.deviceId : undefined,
      ].filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim())));
      return {
        platform: String(entry.platform ?? ''),
        appleOs: typeof entry.appleOs === 'string' ? entry.appleOs : undefined,
        id,
        name: String(entry.name ?? ''),
        kind: String(entry.kind ?? ''),
        target: typeof entry.target === 'string' ? entry.target : undefined,
        booted: entry.booted === true,
        aliases,
      };
    })
    .filter((entry) => entry.platform === 'ios' && entry.id && entry.name);
}

function providerForDevice(device: AgentDeviceEntry): InteractionProvider {
  return device.kind === 'simulator' ? SIMULATOR_PROVIDER : DEVICE_PROVIDER;
}

function selectTarget(input: AssistantPluginActionExecutionInput, selector?: string): AgentDeviceEntry {
  const inventory = devices(input);
  const normalizedSelector = selector?.trim().toLocaleLowerCase('en-US');
  const exact = selector
    ? inventory.filter((entry) => entry.name === selector
      || entry.aliases.some((alias) => alias.toLocaleLowerCase('en-US') === normalizedSelector))
    : inventory.filter((entry) => entry.booted && entry.kind === 'simulator');
  const ready = exact.filter((entry) => entry.booted && (entry.kind === 'simulator' || entry.kind === 'device'));
  if (ready.length === 0) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', selector
      ? 'Select one connected physical iPhone or already-booted iOS Simulator by exact name or UDID.'
      : 'Select one already-booted iOS Simulator, or provide an exact physical iPhone name or UDID.', {
      retryable: false,
      details: {
        selector,
        matches: exact.map((entry) => ({ id: entry.id, name: entry.name, kind: entry.kind, booted: entry.booted })),
      },
    });
  }
  if (ready.length !== 1) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'The iOS target selection is ambiguous; provide the exact UDID.', {
      retryable: false,
      details: { selector, matches: ready.map((entry) => ({ id: entry.id, name: entry.name, kind: entry.kind })) },
    });
  }
  return ready[0]!;
}

function requireString(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `${name} is required.`, { retryable: false });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function signingFromArgs(args: Record<string, unknown>): AgentDeviceSigningConfig {
  const developerDir = optionalString(args.developer_dir);
  if (developerDir && (!isAbsolute(developerDir) || !developerDir.endsWith('/Contents/Developer') || !existsSync(developerDir))) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'developer_dir must be an existing absolute Xcode Contents/Developer directory.', { retryable: false });
  }
  return {
    schemaVersion: 1,
    teamId: optionalString(args.team_id),
    bundleId: optionalString(args.runner_bundle_id),
    developerDir,
  };
}

function isAgentDeviceInteraction(record: InteractionSessionRecord): boolean {
  return interactionAutomationEngine(record) === 'agent-device';
}

function readAgentDeviceInteraction(repoRoot: string, interactionId: string): InteractionSessionRecord | undefined {
  for (const provider of PROVIDERS) {
    const record = readInteractionSession(repoRoot, provider, interactionId);
    if (record && isAgentDeviceInteraction(record)) return record;
  }
  return undefined;
}

function listAgentDeviceInteractions(repoRoot: string): InteractionSessionRecord[] {
  return PROVIDERS.flatMap((provider) => listInteractionSessions(repoRoot, provider))
    .filter(isAgentDeviceInteraction);
}

function requireRecord(input: AssistantPluginActionExecutionInput, allowTerminal = false): InteractionSessionRecord {
  const interactionId = requireString(input.args.interaction_id, 'interaction_id');
  const record = readAgentDeviceInteraction(input.repoRoot, interactionId);
  if (!record) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Unknown iOS agent-device interaction: ${interactionId}`, { retryable: false });
  }
  if (record.status === 'unknown' && !allowTerminal) {
    throw new AssistantPluginError(
      'AGENT_DEVICE_OUTCOME_UNKNOWN',
      'The previous device mutation has an unknown outcome. Do not retry it; explicitly close or reconcile this interaction first.',
      {
        retryable: false,
        details: { interactionId, status: record.status, sessionRetained: true },
      },
    );
  }
  if (!isInteractionSessionActive(record.status)) {
    if (allowTerminal) return record;
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `iOS agent-device interaction is ${record.status}.`, {
      retryable: false,
      details: { interactionId, status: record.status },
    });
  }
  if (hooks.now().getTime() >= Date.parse(record.expiresAt)) {
    const closed = bestEffortClose(input, record);
    patchInteractionSession(input.repoRoot, record.provider, interactionId, closed
      ? {
        status: 'failed',
        error: { code: 'AGENT_DEVICE_SESSION_EXPIRED', message: 'The agent-device session expired and was closed.' },
      }
      : {
        status: 'closing',
        error: { code: 'AGENT_DEVICE_CLEANUP_FAILED', message: 'The expired agent-device session could not be closed; ownership remains fenced.' },
      });
    throw new AssistantPluginError(
      closed ? 'AGENT_DEVICE_SESSION_EXPIRED' : 'AGENT_DEVICE_CLEANUP_FAILED',
      closed ? 'The agent-device session expired and was closed.' : 'The expired agent-device session could not be closed; retry agent_device_close.',
      { retryable: !closed },
    );
  }
  return record;
}

function providerErrorCode(result: CommandResult): string | undefined {
  try {
    const parsed = JSON.parse(result.stdout.trim()) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === 'string' ? parsed.error.code : undefined;
  } catch {
    return undefined;
  }
}

function providerSessionAlreadyAbsent(result: CommandResult): boolean {
  return providerErrorCode(result) === 'SESSION_NOT_FOUND';
}

function bestEffortClose(input: AssistantPluginActionExecutionInput, record: InteractionSessionRecord): boolean {
  const result = hooks.runCommand(executable(input.repoRoot), ['close', '--session', record.sessionId, '--platform', 'ios', '--json'], {
    cwd: input.repoRoot,
    timeoutMs: 30_000,
    env: sessionEnv(input, record),
  });
  if (providerSessionAlreadyAbsent(result)) return true;
  if (!result.ok) return false;
  try {
    const parsed = JSON.parse(result.stdout.trim()) as { success?: unknown };
    return parsed.success !== false;
  } catch {
    return true;
  }
}

async function closeProviderSession(
  input: AssistantPluginActionExecutionInput,
  record: InteractionSessionRecord,
  args: string[],
): Promise<{ result: Record<string, unknown>; providerAlreadyAbsent: boolean }> {
  const commandResult = await hooks.runCommandAsync(executable(input.repoRoot), [
    ...args,
    '--session', record.sessionId,
    '--platform', 'ios',
    '--json',
  ], {
    cwd: input.repoRoot,
    timeoutMs: effectiveCommandTimeout(input, 60_000),
    env: sessionEnv(input, record),
    signal: input.signal,
  });
  if (providerSessionAlreadyAbsent(commandResult)) {
    return {
      providerAlreadyAbsent: true,
      result: { success: true, data: { alreadyClosed: true, providerCode: 'SESSION_NOT_FOUND' } },
    };
  }
  return {
    providerAlreadyAbsent: false,
    result: parseJsonResult(commandResult, 'AGENT_DEVICE_CLOSE_FAILED'),
  };
}

function reconcileExpiredSessions(input: AssistantPluginActionExecutionInput): void {
  const nowMs = hooks.now().getTime();
  for (const record of listAgentDeviceInteractions(input.repoRoot)) {
    if (!isInteractionSessionActive(record.status) || nowMs < Date.parse(record.expiresAt)) continue;
    const closed = bestEffortClose(input, record);
    patchInteractionSession(input.repoRoot, record.provider, record.interactionId, closed
      ? {
        status: 'failed',
        error: { code: 'AGENT_DEVICE_SESSION_EXPIRED', message: 'The agent-device session expired and was closed before opening another session.' },
      }
      : {
        status: 'closing',
        error: { code: 'AGENT_DEVICE_CLEANUP_FAILED', message: 'The expired agent-device session could not be closed; ownership remains fenced.' },
      });
  }
}

function failSession(input: AssistantPluginActionExecutionInput, record: InteractionSessionRecord, error: unknown): never {
  const closed = bestEffortClose(input, record);
  const normalized = toAssistantPluginError(error, {
    code: 'AGENT_DEVICE_COMMAND_FAILED',
    message: 'The agent-device command failed.',
    retryable: false,
  });
  patchInteractionSession(input.repoRoot, record.provider, record.interactionId, closed
    ? {
      status: 'failed',
      error: { code: normalized.code, message: normalized.message },
    }
    : {
      status: 'closing',
      error: { code: 'AGENT_DEVICE_CLEANUP_FAILED', message: `${normalized.message}; cleanup failed and ownership remains fenced.` },
    });
  if (!closed) {
    throw new AssistantPluginError('AGENT_DEVICE_CLEANUP_FAILED', 'The agent-device action failed and its session could not be closed; retry agent_device_close.', {
      retryable: true,
      details: { originalCode: normalized.code, interactionId: record.interactionId },
    });
  }
  throw normalized;
}

function fenceUnknownSession(
  input: AssistantPluginActionExecutionInput,
  record: InteractionSessionRecord,
  error: unknown,
): never {
  const normalized = toAssistantPluginError(error, {
    code: 'AGENT_DEVICE_COMMAND_FAILED',
    message: 'The agent-device mutation ended without a trustworthy outcome.',
    retryable: false,
  });
  patchInteractionSession(input.repoRoot, record.provider, record.interactionId, {
    status: 'unknown',
    error: {
      code: 'AGENT_DEVICE_OUTCOME_UNKNOWN',
      message: 'A device mutation may have completed, but the provider did not return trustworthy completion evidence.',
    },
  });
  throw new AssistantPluginError(
    'AGENT_DEVICE_OUTCOME_UNKNOWN',
    'The device mutation may have completed, but its outcome is unknown. Do not retry it; explicitly close or reconcile this interaction first.',
    {
      retryable: false,
      details: {
        originalCode: normalized.code,
        interactionId: record.interactionId,
        outcome: 'unknown',
        sessionRetained: true,
      },
    },
  );
}

function isPotentiallyMutatingAgentDeviceCommand(args: string[]): boolean {
  return ['press', 'fill', 'scroll', 'keyboard', 'back', 'batch'].includes(args[0] ?? '');
}

function failWorkflowSession(
  input: AssistantPluginActionExecutionInput,
  record: InteractionSessionRecord,
  error: unknown,
  keepSession: boolean,
): never {
  const classification = classifyAgentDeviceFailure(error);
  if (keepSession && classification.disposition === 'preserve_session') return preserveSessionFailure(error);
  if (classification.disposition === 'fence_unknown') return fenceUnknownSession(input, record, error);
  return failSession(input, record, error);
}

function interactionCommandKey(record: InteractionSessionRecord): string {
  return `${record.provider}:${record.interactionId}`;
}

function interactionCancelledError(): AssistantPluginError {
  return new AssistantPluginError('AGENT_DEVICE_COMMAND_CANCELLED', 'The agent-device action was cancelled before it acquired the interaction session.', {
    retryable: true,
  });
}

async function waitForInteractionTurn(
  previous: Promise<void>,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<void> {
  if (signal?.aborted) throw interactionCancelledError();
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    throw actionTimeoutError('The agent-device action timed out while waiting for the interaction session.');
  }
  if (!signal && timeoutMs === undefined) {
    await previous.catch(() => undefined);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(interactionCancelledError()));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => finish(() => reject(actionTimeoutError(
        'The agent-device action timed out while waiting for the interaction session.',
      ))), Math.max(1, timeoutMs));
      timeoutHandle.unref?.();
    }
    void previous.catch(() => undefined).then(() => finish(resolve));
  });
}

async function serializeInteractionCommand<T>(
  input: AssistantPluginActionExecutionInput,
  record: InteractionSessionRecord,
  command: (current: InteractionSessionRecord) => Promise<T>,
  options: { allowTerminal?: boolean } = {},
): Promise<T> {
  const key = interactionCommandKey(record);
  const previous = interactionCommandTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => current);
  interactionCommandTails.set(key, tail);
  try {
    await waitForInteractionTurn(previous, input.signal, remainingActionTimeout(input));
    if (input.signal?.aborted) throw interactionCancelledError();
    const current = readAgentDeviceInteraction(input.repoRoot, record.interactionId);
    if (!current || current.sessionId !== record.sessionId) {
      throw new AssistantPluginError('AGENT_DEVICE_SESSION_NOT_ACTIVE', 'The interaction session changed or disappeared while this command was queued.', {
        retryable: false,
        details: { interactionId: record.interactionId, status: current?.status ?? 'missing' },
      });
    }
    if (current.status === 'unknown' && options.allowTerminal !== true) {
      throw new AssistantPluginError(
        'AGENT_DEVICE_OUTCOME_UNKNOWN',
        'The previous device mutation has an unknown outcome. Do not retry it; explicitly close or reconcile this interaction first.',
        {
          retryable: false,
          details: { interactionId: record.interactionId, status: current.status, sessionRetained: true },
        },
      );
    }
    if (!isInteractionSessionActive(current.status) && options.allowTerminal !== true) {
      throw new AssistantPluginError('AGENT_DEVICE_SESSION_NOT_ACTIVE', 'The interaction session became terminal while this command was queued.', {
        retryable: false,
        details: { interactionId: record.interactionId, status: current.status },
      });
    }
    return await command(current);
  } finally {
    release();
    if (interactionCommandTails.get(key) === tail) {
      void tail.finally(() => {
        if (interactionCommandTails.get(key) === tail) interactionCommandTails.delete(key);
      });
    }
  }
}

async function runSessionCommand(
  input: AssistantPluginActionExecutionInput,
  record: InteractionSessionRecord,
  args: string[],
  failureCode: string,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  return serializeInteractionCommand(input, record, async () => {
    try {
      return await runJsonAsync(input, [...args, '--session', record.sessionId, '--platform', 'ios', '--json'], {
        record,
        timeoutMs,
        failureCode,
      });
    } catch (error) {
      const classification = classifyAgentDeviceFailure(error);
      if (classification.disposition === 'preserve_session') {
        return preserveSessionFailure(error);
      }
      if (classification.disposition === 'fence_unknown' && isPotentiallyMutatingAgentDeviceCommand(args)) {
        return fenceUnknownSession(input, record, error);
      }
      return failSession(input, record, error);
    }
  });
}

async function runSessionCommandAttempt(
  input: AssistantPluginActionExecutionInput,
  record: InteractionSessionRecord,
  args: string[],
  failureCode: string,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  return serializeInteractionCommand(input, record, async () => runJsonAsync(
    input,
    [...args, '--session', record.sessionId, '--platform', 'ios', '--json'],
    { record, timeoutMs, failureCode },
  ));
}

function boundedProviderTimeout(
  input: AssistantPluginActionExecutionInput,
  requested: number,
): number {
  const remaining = remainingActionTimeout(input);
  if (remaining !== undefined && remaining <= 0) throw actionTimeoutError();
  return Math.max(1, Math.min(requested, remaining ?? requested));
}

async function executeSessionSnapshotBackend(
  input: AssistantPluginActionExecutionInput,
  record: InteractionSessionRecord,
  request: AgentDeviceSnapshotRequest,
  failureCode: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const mode = configuredAgentDeviceBackendMode();
  let backendFallbackReason: 'typed_unavailable' | 'typed_cli_version_mismatch' | undefined;
  let fallbackTypedVersion: string | undefined;
  let fallbackCliVersion: string | undefined;
  if (mode !== 'cli') {
    const dependency = requireDependency(input.repoRoot);
    const typed = new TypedAgentDeviceReadProvider(typedAgentDeviceIdentity({ repoRoot: input.repoRoot }));
    const versionsMatch = agentDeviceProviderVersionsMatch(
      typed.identity.version,
      dependency.detectedVersion,
    );
    if (typed.identity.available && !versionsMatch) {
      fallbackTypedVersion = typed.identity.version;
      fallbackCliVersion = dependency.detectedVersion;
      if (mode === 'typed') {
        throw new AssistantPluginError(
          'AGENT_DEVICE_TYPED_PROVIDER_VERSION_MISMATCH',
          `The typed agent-device module (${typed.identity.version ?? 'unknown'}) does not match the active CLI (${dependency.detectedVersion ?? 'unknown'}).`,
          {
            retryable: false,
            details: {
              providerBackend: 'typed',
              providerCode: 'UNSUPPORTED_OPERATION',
              typedVersion: typed.identity.version,
              cliVersion: dependency.detectedVersion,
            },
          },
        );
      }
      backendFallbackReason = 'typed_cli_version_mismatch';
    } else if (typed.identity.available || mode === 'typed') {
      try {
        return await typed.snapshot({
          stateDir: runtimeStateDir(input, record),
          session: record.sessionId,
          device: record.targetId,
          platform: 'ios',
          requestId: input.requestId,
          cwd: input.repoRoot,
          timeoutMs: boundedProviderTimeout(input, timeoutMs),
        }, request) as unknown as Record<string, unknown>;
      } catch (error) {
        if (mode === 'auto' && isTypedProviderUnavailable(error)) {
          // The optional package was removed or became unloadable after the
          // synchronous status probe. CLI remains the compatibility fallback.
          backendFallbackReason = 'typed_unavailable';
          fallbackTypedVersion = typed.identity.version;
          fallbackCliVersion = dependency.detectedVersion;
        } else if (isTypedProviderUnavailable(error)) {
          throw new AssistantPluginError(
            'AGENT_DEVICE_TYPED_PROVIDER_UNAVAILABLE',
            error instanceof Error ? error.message : 'The typed agent-device provider is unavailable.',
            {
              retryable: false,
              details: {
                providerBackend: 'typed',
                sessionPreserved: true,
                identity: typed.identity,
              },
            },
          );
        } else {
          throw error;
        }
      }
    } else if (mode === 'auto') {
      backendFallbackReason = 'typed_unavailable';
      fallbackTypedVersion = typed.identity.version;
      fallbackCliVersion = dependency.detectedVersion;
    }
  }

  const args = compileSnapshotCommand(capabilityProfile(input.repoRoot), request);
  const result = await runJsonAsync(
    input,
    [...args, '--session', record.sessionId, '--platform', 'ios', '--json'],
    { record, timeoutMs, failureCode },
  );
  return {
    ...result,
    provider: 'cli',
    ...(backendFallbackReason ? {
      backendFallbackReason,
      typedVersion: fallbackTypedVersion,
      cliVersion: fallbackCliVersion,
    } : {}),
  };
}

async function runSessionSnapshotAttempt(
  input: AssistantPluginActionExecutionInput,
  record: InteractionSessionRecord,
  request: AgentDeviceSnapshotRequest,
  failureCode = 'AGENT_DEVICE_SNAPSHOT_FAILED',
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  return serializeInteractionCommand(
    input,
    record,
    async () => executeSessionSnapshotBackend(input, record, request, failureCode, timeoutMs),
  );
}

async function runSessionSnapshot(
  input: AssistantPluginActionExecutionInput,
  record: InteractionSessionRecord,
  request: AgentDeviceSnapshotRequest,
  failureCode = 'AGENT_DEVICE_SNAPSHOT_FAILED',
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  try {
    return await runSessionSnapshotAttempt(input, record, request, failureCode, timeoutMs);
  } catch (error) {
    if (isTypedProviderUnavailable(error)) throw error;
    const classification = classifyAgentDeviceFailure(error);
    // Snapshot is observation-only. A timeout/cancel cannot create an unknown
    // device-side mutation, so retain the session unless the provider supplied
    // concrete Runner/transport-death evidence.
    if (classification.disposition !== 'terminate_session') return preserveSessionFailure(error);
    return failSession(input, record, error);
  }
}

function isStaleAccessibilityRefError(error: unknown): boolean {
  const normalized = toAssistantPluginError(error, {
    code: 'AGENT_DEVICE_COMMAND_FAILED',
    message: 'The agent-device command failed.',
    retryable: false,
  });
  const evidence = `${normalized.message}\n${JSON.stringify(normalized.details ?? {})}`;
  return /(?:accessibility|element|ref|@e\d+)/i.test(evidence)
    && /(?:stale|expired|missing|not[\s_-]*found|no[\s_-]*such)/i.test(evidence);
}

function isExactEvidenceWaitMiss(error: unknown): boolean {
  const normalized = toAssistantPluginError(error, {
    code: 'AGENT_DEVICE_COMMAND_FAILED',
    message: 'The agent-device command failed.',
    retryable: false,
  });
  const evidence = `${normalized.message}\n${JSON.stringify(normalized.details ?? {})}`;
  const waitFailure = /(?:wait|expected\s+(?:text|selector)|text\s+match|selector\s+match)/i.test(evidence)
    && /(?:timed?\s*out|timeout|not[\s_-]*found|no\s+match|missing)/i.test(evidence);
  const infrastructureFailure = /(?:runner|transport|connection|socket|daemon|xctest|device\s+disconnect|spawn|broken\s+pipe)/i.test(evidence);
  return waitFailure && !infrastructureFailure;
}

function hasAccessibilityEvidence(value: unknown): boolean {
  return stringEvidence(value).some((text) => /(?:@e\d+|\b(?:StaticText|SearchField|TextField|Button|Cell|Image|Switch|Link)\b|(?:label|identifier)=)/i.test(text));
}

function stringEvidence(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => stringEvidence(entry, output));
  else if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((entry) => stringEvidence(entry, output));
  }
  return output;
}

function interactiveRef(value: unknown, terms: RegExp): string | undefined {
  for (const text of stringEvidence(value)) {
    for (const line of text.split('\n')) {
      if (!terms.test(line)) continue;
      const match = line.match(/@e\d+(?:~s\d+)?/);
      if (match) return match[0];
    }
  }
  return undefined;
}

function boundedVisibleText(value: unknown, query: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const text of stringEvidence(value)) {
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim().split(query).join('<query>');
      if (!line || line.length > 500 || seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
      if (Buffer.byteLength(lines.join('\n'), 'utf8') >= 8_000) return lines;
    }
  }
  return lines;
}

function validateJdQuery(value: unknown): string {
  const query = requireString(value, 'query');
  if (query.length > MAX_JD_QUERY_LENGTH || /[\u0000-\u001f\u007f]/.test(query)) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `query must be at most ${MAX_JD_QUERY_LENGTH} printable characters.`, { retryable: false });
  }
  if (SENSITIVE_SEMANTICS.test(query)) {
    throw new AssistantPluginError('IOS_DEVICE_SENSITIVE_ACTION_BLOCKED', 'JD search accepts product-information queries only; credentials, verification, checkout, purchase and payment semantics are blocked.', { retryable: false });
  }
  return query;
}

function batchInput(value: unknown, index: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `steps[${index}].input must be an object.`, { retryable: false });
  }
  return value as Record<string, unknown>;
}

function assertBatchKeys(
  input: Record<string, unknown>,
  allowed: string[],
  index: number,
  kind: AgentDeviceBatchKind,
): void {
  const unexpected = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new AssistantPluginError(
      'PLUGIN_ACTION_ARGUMENT_INVALID',
      `steps[${index}] ${kind} contains unsupported fields: ${unexpected.join(', ')}`,
      { retryable: false },
    );
  }
}

function batchInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.trunc(value)))
    : fallback;
}

function assertPhysicalBatchText(record: InteractionSessionRecord, values: Array<string | undefined>): void {
  if (record.provider !== DEVICE_PROVIDER) return;
  if (values.some((value) => value && SENSITIVE_SEMANTICS.test(value))) {
    throw new AssistantPluginError(
      'IOS_DEVICE_SENSITIVE_ACTION_BLOCKED',
      'Batch steps involving credentials, verification, biometrics, checkout, purchase or payment require human interaction.',
      { retryable: false },
    );
  }
}

function nativeBatchTarget(target: string): Record<string, unknown> {
  const ref = target.match(/^@?(e\d+(?:~s\d+)?)$/i)?.[1];
  return ref
    ? { kind: 'ref', ref }
    : { kind: 'selector', selector: target };
}

function prepareAgentDeviceBatch(
  rawSteps: unknown,
  record: InteractionSessionRecord,
): PreparedAgentDeviceBatch {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0 || rawSteps.length > MAX_BATCH_STEPS) {
    throw new AssistantPluginError(
      'PLUGIN_ACTION_ARGUMENT_INVALID',
      `steps must contain between 1 and ${MAX_BATCH_STEPS} typed entries.`,
      { retryable: false },
    );
  }

  const nativeSteps: PreparedAgentDeviceBatch['nativeSteps'] = [];
  const redactions: string[] = [];
  rawSteps.forEach((rawStep, index) => {
    if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) {
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `steps[${index}] must be an object.`, { retryable: false });
    }
    const step = rawStep as Record<string, unknown>;
    const rawKind = requireString(step.kind, `steps[${index}].kind`);
    if (!BATCH_KINDS.includes(rawKind as AgentDeviceBatchKind)) {
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Unsupported batch step kind: ${rawKind}`, { retryable: false });
    }
    const kind = rawKind as AgentDeviceBatchKind;
    const input = batchInput(step.input ?? {}, index);
    let nativeInput: Record<string, unknown>;

    switch (kind) {
      case 'snapshot': {
        assertBatchKeys(input, ['interactive', 'raw', 'depth', 'scope', 'diff', 'force_full', 'timeout_ms'], index, kind);
        const scope = optionalString(input.scope);
        nativeInput = {
          ...(input.interactive === true ? { interactive: true } : {}),
          ...(input.raw === true ? { raw: true } : {}),
          ...(input.diff === true ? { diff: true } : {}),
          ...(input.force_full === true ? { forceFull: true } : {}),
          ...(scope ? { scope } : {}),
          ...(typeof input.depth === 'number'
            ? { depth: batchInteger(input.depth, 8, 1, 20) }
            : {}),
          ...(typeof input.timeout_ms === 'number'
            ? { timeoutMs: batchInteger(input.timeout_ms, 15_000, 100, 60_000) }
            : {}),
        };
        break;
      }
      case 'press': {
        assertBatchKeys(input, ['target', 'x', 'y'], index, kind);
        const target = optionalString(input.target);
        const hasPoint = typeof input.x === 'number' && typeof input.y === 'number';
        if (!target && !hasPoint) {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `steps[${index}] press requires target or x/y.`, { retryable: false });
        }
        assertPhysicalBatchText(record, [target]);
        nativeInput = target
          ? { target: nativeBatchTarget(target), settle: true }
          : {
            target: { kind: 'point', x: Number(input.x), y: Number(input.y) },
            settle: true,
          };
        break;
      }
      case 'fill': {
        assertBatchKeys(input, ['target', 'text', 'delay_ms'], index, kind);
        const target = requireString(input.target, `steps[${index}].input.target`);
        if (typeof input.text !== 'string') {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `steps[${index}] fill requires text.`, { retryable: false });
        }
        const text = input.text;
        assertPhysicalBatchText(record, [target, text]);
        redactions.push(text);
        nativeInput = {
          target: nativeBatchTarget(target),
          text,
          settle: true,
          ...(typeof input.delay_ms === 'number'
            ? { delayMs: batchInteger(input.delay_ms, 0, 0, 5_000) }
            : {}),
        };
        break;
      }
      case 'scroll': {
        assertBatchKeys(input, ['direction', 'amount'], index, kind);
        const direction = requireString(input.direction, `steps[${index}].input.direction`);
        if (!['up', 'down', 'left', 'right', 'top', 'bottom'].includes(direction)) {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Unsupported batch scroll direction: ${direction}`, { retryable: false });
        }
        nativeInput = {
          direction,
          ...(typeof input.amount === 'number'
            ? { amount: batchInteger(input.amount, 1, 1, 100) }
            : {}),
        };
        break;
      }
      case 'keyboard': {
        assertBatchKeys(input, ['action'], index, kind);
        const action = requireString(input.action, `steps[${index}].input.action`);
        if (!['status', 'dismiss'].includes(action)) {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Unsupported keyboard action: ${action}`, { retryable: false });
        }
        nativeInput = { action };
        break;
      }
      case 'wait': {
        assertBatchKeys(input, ['wait_type', 'text', 'selector', 'duration_ms', 'quiet_ms', 'timeout_ms'], index, kind);
        const waitType = optionalString(input.wait_type) ?? 'stable';
        if (!['stable', 'text', 'selector', 'duration'].includes(waitType)) {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Unsupported wait type: ${waitType}`, { retryable: false });
        }
        const timeoutMs = batchInteger(input.timeout_ms, 15_000, 100, 60_000);
        if (waitType === 'text') {
          const text = requireString(input.text, `steps[${index}].input.text`);
          assertPhysicalBatchText(record, [text]);
          nativeInput = { kind: 'text', text, timeoutMs };
        } else if (waitType === 'selector') {
          const selector = requireString(input.selector, `steps[${index}].input.selector`);
          assertPhysicalBatchText(record, [selector]);
          nativeInput = { kind: 'selector', selector, timeoutMs };
        } else if (waitType === 'duration') {
          nativeInput = {
            kind: 'duration',
            durationMs: batchInteger(input.duration_ms, 500, 0, 60_000),
          };
        } else {
          nativeInput = {
            kind: 'stable',
            quietMs: batchInteger(input.quiet_ms, 500, 100, 5_000),
            timeoutMs,
          };
        }
        break;
      }
      case 'back': {
        assertBatchKeys(input, [], index, kind);
        nativeInput = {};
        break;
      }
    }
    nativeSteps.push({ command: kind, input: nativeInput });
  });

  return { nativeSteps, redactions };
}

async function runSessionBatch(
  input: AssistantPluginActionExecutionInput,
  record: InteractionSessionRecord,
  prepared: PreparedAgentDeviceBatch,
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  let result: unknown = await runSessionCommand(
    input,
    record,
    compileBatchCommand(capabilityProfile(input.repoRoot), prepared.nativeSteps, MAX_BATCH_STEPS, { includeCost: true }),
    'AGENT_DEVICE_BATCH_FAILED',
    timeoutMs,
  );
  for (const text of prepared.redactions) result = redactExactText(result, text);
  return result as Record<string, unknown>;
}

async function runSessionBatchAttempt(
  input: AssistantPluginActionExecutionInput,
  record: InteractionSessionRecord,
  prepared: PreparedAgentDeviceBatch,
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  let result: unknown = await runSessionCommandAttempt(
    input,
    record,
    compileBatchCommand(capabilityProfile(input.repoRoot), prepared.nativeSteps, MAX_BATCH_STEPS, { includeCost: true }),
    'AGENT_DEVICE_BATCH_FAILED',
    timeoutMs,
  );
  for (const text of prepared.redactions) result = redactExactText(result, text);
  return result as Record<string, unknown>;
}

async function recoverExactWaitEvidence(
  input: AssistantPluginActionExecutionInput,
  record: InteractionSessionRecord,
  scope: string | undefined,
  depth: number,
  keepSession: boolean,
): Promise<{
  snapshot: Record<string, unknown>;
  tier: 'scoped_snapshot' | 'full_snapshot';
  snapshotRequests: number;
}> {
  let snapshotRequests = 0;
  if (scope) {
    snapshotRequests += 1;
    try {
      const scoped = await runSessionSnapshotAttempt(
        input,
        record,
        {
          interactiveOnly: true,
          depth,
          scope,
        },
        'AGENT_DEVICE_SNAPSHOT_FAILED',
        30_000,
      );
      if (hasAccessibilityEvidence(scoped)) {
        return { snapshot: scoped, tier: 'scoped_snapshot', snapshotRequests };
      }
    } catch (error) {
      if (!isExactEvidenceWaitMiss(error)) {
        return failWorkflowSession(input, record, error, keepSession);
      }
    }
  }

  snapshotRequests += 1;
  try {
    const full = await runSessionSnapshotAttempt(
      input,
      record,
      {
        interactiveOnly: true,
        depth,
        forceFull: true,
      },
      'AGENT_DEVICE_SNAPSHOT_FAILED',
      45_000,
    );
    return { snapshot: full, tier: 'full_snapshot', snapshotRequests };
  } catch (error) {
    return failWorkflowSession(input, record, error, keepSession);
  }
}

function subActionInput(
  input: AssistantPluginActionExecutionInput,
  actionId: string,
  args: Record<string, unknown>,
): AssistantPluginActionExecutionInput {
  return { ...input, actionId, args, requestId: `${input.requestId}:${actionId}` };
}

interface JdSearchTargets {
  editableTarget?: string;
  entryTarget?: string;
  submitTarget?: string;
}

function discoverJdSearchTargets(snapshot: unknown, preferredTarget?: string): JdSearchTargets {
  const adapter = JD_IOS_APP_ADAPTER.search!;
  const preferredRef = normalizedSemanticRef(preferredTarget);
  const preferredNode = preferredRef
    ? findSemanticNode(snapshot, (node) => normalizedSemanticRef(node.ref) === preferredRef)
    : undefined;
  const editableTarget = preferredNode && adapter.isEditableSearchField(preferredNode)
    ? preferredRef
    : findSemanticRef(snapshot, adapter.isEditableSearchField);
  const entryTarget = preferredNode && adapter.isSearchEntry(preferredNode)
    ? preferredRef
    : findSemanticRef(snapshot, adapter.isSearchEntry);
  return {
    editableTarget,
    entryTarget,
    submitTarget: findSemanticRef(snapshot, adapter.isSubmit),
  };
}

async function executeJdSearch(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  const workflowStartedAt = performance.now();
  const timingsMs = {
    targetSelection: 0,
    open: 0,
    targetDiscovery: 0,
    navigation: 0,
    interactionAndEvidence: 0,
    screenshot: 0,
    close: 0,
    total: 0,
  };
  const targetSelectionStartedAt = performance.now();
  const query = validateJdQuery(input.args.query);
  const deviceSelector = requireString(input.args.device, 'device');
  const requestedInteractionId = optionalString(input.args.interaction_id);
  const keepSession = typeof input.args.keep_session === 'boolean'
    ? input.args.keep_session
    : Boolean(requestedInteractionId);
  const captureScreenshot = typeof input.args.capture_screenshot === 'boolean'
    ? input.args.capture_screenshot
    : !requestedInteractionId;
  let selected: AgentDeviceEntry;
  let interaction: InteractionSessionRecord | undefined;
  let sessionReused = false;
  let deviceInventoryRequests = 0;

  if (requestedInteractionId) {
    interaction = requireRecord(subActionInput(input, 'agent_device_jd_search', {
      interaction_id: requestedInteractionId,
    }));
    if (interaction.provider !== DEVICE_PROVIDER || interaction.instructions !== JD_BUNDLE_ID) {
      throw new AssistantPluginError(
        'PLUGIN_ACTION_ARGUMENT_INVALID',
        'interaction_id must reference an active physical-iPhone JD session opened for com.360buy.jdmobile.',
        {
          retryable: false,
          details: {
            interactionId: interaction.interactionId,
            provider: interaction.provider,
            app: interaction.instructions,
          },
        },
      );
    }
    selected = {
      platform: 'ios',
      appleOs: 'ios',
      id: interaction.targetId,
      name: deviceSelector,
      kind: 'device',
      target: 'mobile',
      booted: true,
      aliases: interactionTargetIdentifiers(interaction),
    };
    sessionReused = true;
  } else {
    deviceInventoryRequests += 1;
    selected = selectTarget(input, deviceSelector);
    if (selected.kind !== 'device') {
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'agent_device_jd_search requires one exact connected physical iPhone.', {
        retryable: false,
        details: { device: { id: selected.id, name: selected.name, kind: selected.kind } },
      });
    }
  }
  timingsMs.targetSelection = performance.now() - targetSelectionStartedAt;

  if (!interaction) {
    const sharedArgs = {
      device: selected.name,
      team_id: optionalString(input.args.team_id),
      runner_bundle_id: optionalString(input.args.runner_bundle_id),
      developer_dir: optionalString(input.args.developer_dir),
    };
    const openStartedAt = performance.now();
    const opened = await executeIosAgentDeviceAction(subActionInput(input, 'agent_device_open', {
      ...sharedArgs,
      app: JD_BUNDLE_ID,
      // Foreground an already-running app by default. Relaunch is opt-in because
      // it restarts app state and pays another cold-start/navigation cost.
      relaunch: input.args.relaunch === true,
    }));
    interaction = opened.interaction as InteractionSessionRecord | undefined;
    timingsMs.open = performance.now() - openStartedAt;
  }
  if (!interaction) {
    throw new AssistantPluginError('AGENT_DEVICE_OPEN_FAILED', 'agent-device did not return an interaction for JD.', { retryable: false });
  }
  const interactionId = interaction.interactionId;
  const record = requireRecord(subActionInput(input, 'agent_device_batch', { interaction_id: interactionId }));
  let finalSnapshot: Record<string, unknown> | undefined;
  let screenshot: Record<string, unknown> | undefined;
  const resultText = optionalString(input.args.result_text);
  const resultSelector = optionalString(input.args.result_selector);
  const exactResultWait = Boolean(resultText || resultSelector);
  const resultScope = optionalString(input.args.result_scope);
  const snapshotDepth = batchInteger(input.args.snapshot_depth, 20, 1, 20);
  let accessibilityEvidenceTier: 'exact_wait' | 'scoped_snapshot' | 'full_snapshot' = exactResultWait
    ? 'exact_wait'
    : resultScope
      ? 'scoped_snapshot'
      : 'full_snapshot';
  let initialAccessibilitySnapshot = false;
  let staleRefRecovery = false;
  let exactWaitFallback = false;
  let accessibilitySnapshotRequests = 0;
  let navigationSnapshotRequests = 0;
  let searchFlow: 'explicit_selector' | 'explicit_target' | 'direct_editable' | 'navigated_from_entry' = 'direct_editable';
  let nativeBatchRequests = 0;
  let nativeBatchSteps = 0;
  let targetDiscoveryStartedAt = 0;
  let interactionStartedAt = 0;
  try {
    // Stable selectors can address an already-focused editable control without
    // a discovery round trip. Snapshot-scoped refs are always revalidated before
    // mutation because app foregrounding or a page transition may invalidate them.
    const explicitSelector = optionalString(input.args.search_selector);
    const explicitTarget = optionalString(input.args.search_target);
    let searchTarget = explicitSelector;
    let discoveredSubmitTarget: string | undefined;
    if (explicitSelector) searchFlow = 'explicit_selector';
    if (!searchTarget && explicitTarget && !normalizedSemanticRef(explicitTarget)) {
      searchTarget = explicitTarget;
      searchFlow = 'explicit_target';
    }

    targetDiscoveryStartedAt = performance.now();
    if (!searchTarget) {
      initialAccessibilitySnapshot = true;
      accessibilitySnapshotRequests += 1;
      const discovery = JD_IOS_APP_ADAPTER.search!.discovery;
      let initialSnapshot: Record<string, unknown>;
      try {
        initialSnapshot = await runSessionSnapshotAttempt(
          input,
          record,
          {
            interactiveOnly: discovery.interactiveOnly,
            raw: discovery.raw,
            depth: discovery.depth,
            scope: discovery.scope,
          },
          'AGENT_DEVICE_SNAPSHOT_FAILED',
          30_000,
        );
      } catch (error) {
        return failWorkflowSession(input, record, error, keepSession);
      }
      const initialTargets = discoverJdSearchTargets(initialSnapshot, explicitTarget);
      const initialEntryTarget = initialTargets.entryTarget
        ?? interactiveRef(initialSnapshot, /搜索|搜一搜|search|searchfield|请输入/i);
      searchTarget = initialTargets.editableTarget;
      discoveredSubmitTarget = initialTargets.submitTarget;

      if (!searchTarget && initialEntryTarget) {
        searchFlow = 'navigated_from_entry';
        timingsMs.targetDiscovery = performance.now() - targetDiscoveryStartedAt;
        const navigationStartedAt = performance.now();
        nativeBatchRequests += 1;
        nativeBatchSteps += 2;
        try {
          await runSessionBatchAttempt(input, record, prepareAgentDeviceBatch([
            { kind: 'press', input: { target: initialEntryTarget } },
            { kind: 'wait', input: { wait_type: 'stable', quiet_ms: 500, timeout_ms: 10_000 } },
          ], record), 20_000);
        } catch (error) {
          return failWorkflowSession(input, record, error, keepSession);
        }

        // Never trust the provider's incremental diff as authorization for the
        // next mutation. A JD page transition has returned contradictory zero
        // diffs in production, so force one fresh tree and issue new refs.
        accessibilitySnapshotRequests += 1;
        navigationSnapshotRequests += 1;
        let searchPageSnapshot: Record<string, unknown>;
        try {
          searchPageSnapshot = await runSessionSnapshotAttempt(
            input,
            record,
            {
              interactiveOnly: discovery.interactiveOnly,
              raw: discovery.raw,
              depth: discovery.depth,
              scope: discovery.scope,
              forceFull: true,
            },
            'AGENT_DEVICE_SNAPSHOT_FAILED',
            45_000,
          );
        } catch (error) {
          return failWorkflowSession(input, record, error, keepSession);
        }
        const searchPageTargets = discoverJdSearchTargets(searchPageSnapshot);
        // Newer JD builds expose TextView/TextField; some versions expose a real
        // SearchField on the dedicated page. The latter is safe only after the
        // forced post-navigation snapshot.
        searchTarget = searchPageTargets.editableTarget
          ?? searchPageTargets.entryTarget
          ?? interactiveRef(searchPageSnapshot, /搜索|搜一搜|search|searchfield|请输入/i);
        discoveredSubmitTarget = searchPageTargets.submitTarget
          ?? interactiveRef(searchPageSnapshot, /^(搜索|搜一搜|search)$/i);
        timingsMs.navigation = performance.now() - navigationStartedAt;
      } else {
        searchFlow = 'direct_editable';
      }
    }
    if (!searchTarget) {
      throw new AssistantPluginError('JD_SEARCH_FIELD_NOT_FOUND', 'JD opened, but the App adapter could not find a bounded editable search field.', {
        retryable: false,
        details: {
          adapter: JD_IOS_APP_ADAPTER.id,
          snapshotPolicy: JD_IOS_APP_ADAPTER.search!.discovery,
          searchFlow,
          sessionRetained: keepSession,
        },
      });
    }

    if (timingsMs.targetDiscovery === 0) {
      timingsMs.targetDiscovery = performance.now() - targetDiscoveryStartedAt;
    }
    interactionStartedAt = performance.now();
    const submitTarget = optionalString(input.args.submit_selector)
      ?? optionalString(input.args.submit_target)
      ?? discoveredSubmitTarget;
    const waitStep: AgentDeviceBatchStep = resultText
      ? { kind: 'wait', input: { wait_type: 'text', text: resultText, timeout_ms: 15_000 } }
      : resultSelector
        ? { kind: 'wait', input: { wait_type: 'selector', selector: resultSelector, timeout_ms: 15_000 } }
        : { kind: 'wait', input: { wait_type: 'stable', quiet_ms: 500, timeout_ms: 15_000 } };
    const evidenceSteps: AgentDeviceBatchStep[] = exactResultWait
      ? [waitStep]
      : [
        waitStep,
        {
          kind: 'snapshot',
          input: {
            interactive: true,
            depth: snapshotDepth,
            ...(resultScope ? { scope: resultScope } : {}),
          },
        },
      ];
    let fillStep: AgentDeviceBatchStep = {
      kind: 'fill',
      input: { target: searchTarget, text: query, delay_ms: 20 },
    };
    const cachedSearchRef = !optionalString(input.args.search_selector) && /^@e\d+(?:~s\d+)?$/.test(searchTarget);
    if (cachedSearchRef) {
      nativeBatchRequests += 1;
      nativeBatchSteps += 1;
      try {
        await runSessionBatchAttempt(input, record, prepareAgentDeviceBatch([fillStep], record), 20_000);
      } catch (error) {
        if (!isStaleAccessibilityRefError(error)) return failWorkflowSession(input, record, error, keepSession);
        staleRefRecovery = true;
        initialAccessibilitySnapshot = true;
        accessibilitySnapshotRequests += 1;
        let refreshedSnapshot: Record<string, unknown>;
        try {
          const discovery = JD_IOS_APP_ADAPTER.search!.discovery;
          refreshedSnapshot = await runSessionSnapshotAttempt(
            input,
            record,
            {
              interactiveOnly: discovery.interactiveOnly,
              raw: discovery.raw,
              depth: discovery.depth,
              scope: discovery.scope,
            },
            'AGENT_DEVICE_SNAPSHOT_FAILED',
            30_000,
          );
        } catch (snapshotError) {
          return failWorkflowSession(input, record, snapshotError, keepSession);
        }
        const refreshedTargets = discoverJdSearchTargets(refreshedSnapshot);
        const refreshedTarget = refreshedTargets.editableTarget
          ?? refreshedTargets.entryTarget
          ?? interactiveRef(refreshedSnapshot, /搜索|搜一搜|search|searchfield|请输入/i);
        if (!refreshedTarget) {
          return failWorkflowSession(input, record, new AssistantPluginError(
            'JD_SEARCH_FIELD_NOT_FOUND',
            'The cached JD search ref was stale and no replacement search field was found.',
            { retryable: false, details: { providerCode: 'ELEMENT_NOT_FOUND' } },
          ), keepSession);
        }
        fillStep = { kind: 'fill', input: { target: refreshedTarget, text: query, delay_ms: 20 } };
        nativeBatchRequests += 1;
        nativeBatchSteps += 1;
        await runSessionBatch(input, record, prepareAgentDeviceBatch([fillStep], record), 20_000);
      }
    }
    const fallbackScope = resultScope ?? resultText ?? resultSelector;
    if (submitTarget) {
      nativeBatchRequests += 1;
      nativeBatchSteps += (cachedSearchRef ? 1 : 2) + evidenceSteps.length;
      const prepared = prepareAgentDeviceBatch([
        ...(cachedSearchRef ? [] : [fillStep]),
        { kind: 'press', input: { target: submitTarget } },
        ...evidenceSteps,
      ], record);
      if (exactResultWait) {
        try {
          finalSnapshot = await runSessionBatchAttempt(input, record, prepared, 30_000);
        } catch (error) {
          if (!isExactEvidenceWaitMiss(error)) {
            return failWorkflowSession(input, record, error, keepSession);
          }
          exactWaitFallback = true;
          const recovered = await recoverExactWaitEvidence(input, record, fallbackScope, snapshotDepth, keepSession);
          finalSnapshot = recovered.snapshot;
          accessibilityEvidenceTier = recovered.tier;
          accessibilitySnapshotRequests += recovered.snapshotRequests;
        }
      } else {
        finalSnapshot = await runSessionBatch(input, record, prepared, 30_000);
        accessibilitySnapshotRequests += 1;
      }
    } else {
      nativeBatchRequests += cachedSearchRef ? 1 : 2;
      nativeBatchSteps += (cachedSearchRef ? 0 : 1) + evidenceSteps.length;
      // The current batch schema supports only status/dismiss, so Return stays
      // a separate provider command, but only when the negotiated contract
      // explicitly advertises it.
      if (!capabilityProfile(input.repoRoot).keyboard.returnSupported) {
        return failWorkflowSession(input, record, new AssistantPluginError(
          'PLUGIN_ACTION_NOT_SUPPORTED',
          'The detected agent-device contract does not support keyboard Return.',
          { retryable: false, details: { providerCode: 'UNSUPPORTED_OPERATION' } },
        ), keepSession);
      }
      if (!cachedSearchRef) await runSessionBatch(input, record, prepareAgentDeviceBatch([fillStep], record), 20_000);
      await runSessionCommand(input, record, ['keyboard', 'return'], 'JD_SEARCH_SUBMIT_FAILED');
      const prepared = prepareAgentDeviceBatch(evidenceSteps, record);
      if (exactResultWait) {
        try {
          finalSnapshot = await runSessionBatchAttempt(input, record, prepared, 30_000);
        } catch (error) {
          if (!isExactEvidenceWaitMiss(error)) {
            return failWorkflowSession(input, record, error, keepSession);
          }
          exactWaitFallback = true;
          const recovered = await recoverExactWaitEvidence(input, record, fallbackScope, snapshotDepth, keepSession);
          finalSnapshot = recovered.snapshot;
          accessibilityEvidenceTier = recovered.tier;
          accessibilitySnapshotRequests += recovered.snapshotRequests;
        }
      } else {
        finalSnapshot = await runSessionBatch(input, record, prepared, 30_000);
        accessibilitySnapshotRequests += 1;
      }
    }
    timingsMs.interactionAndEvidence = performance.now() - interactionStartedAt;
    if (captureScreenshot) {
      const screenshotStartedAt = performance.now();
      screenshot = await executeIosAgentDeviceAction(subActionInput(input, 'agent_device_screenshot', {
        interaction_id: interactionId,
        label: 'jd-search-results',
        max_size: 1600,
      }));
      timingsMs.screenshot = performance.now() - screenshotStartedAt;
    }
  } finally {
    if (!keepSession) {
      const closeStartedAt = performance.now();
      await executeIosAgentDeviceAction(subActionInput(input, 'agent_device_close', { interaction_id: interactionId }));
      timingsMs.close = performance.now() - closeStartedAt;
    }
    timingsMs.total = performance.now() - workflowStartedAt;
  }
  return {
    provider: 'agent-device',
    workflow: 'jd_product_search',
    app: JD_BUNDLE_ID,
    device: selected,
    query: '<redacted>',
    runnerReadiness: sessionReused ? 'verified_by_active_session' : 'verified_by_open',
    executionPlan: {
      relaunch: input.args.relaunch === true,
      sessionReused,
      sessionKept: keepSession,
      screenshotCaptured: captureScreenshot,
      deviceInventoryRequests,
      nativeBatchRequests,
      nativeBatchSteps,
      exactResultWait,
      accessibilityEvidenceTier,
      initialAccessibilitySnapshot,
      staleRefRecovery,
      exactWaitFallback,
      accessibilitySnapshotRequests,
      navigationSnapshotRequests,
      searchFlow,
      fullAccessibilitySnapshot: accessibilityEvidenceTier === 'full_snapshot',
      resultScope: resultScope ?? null,
      snapshotDepth: accessibilityEvidenceTier === 'exact_wait' ? null : snapshotDepth,
      timingsMs: Object.fromEntries(
        Object.entries(timingsMs).map(([key, value]) => [key, Math.round(value * 100) / 100]),
      ),
    },
    visibleResultText: boundedVisibleText(finalSnapshot, query),
    result: bounded(redactExactText(finalSnapshot, query)),
    artifactCandidates: screenshot?.artifactCandidates,
    interaction: readAgentDeviceInteraction(input.repoRoot, interactionId),
    safety: {
      allowed: 'product_information_search',
      blocked: ['credentials', 'verification', 'biometrics', 'checkout', 'purchase', 'payment'],
    },
  };
}

export function isIosAgentDeviceAction(actionId: string): boolean {
  return actionId.startsWith('agent_device_');
}

export function iosAgentDeviceCapabilities(): AssistantPluginCapability[] {
  const actions = iosAgentDeviceActions().map((action) => action.actionId);
  return [
    {
      capabilityId: 'ios-agent-device-simulator',
      title: 'agent-device iOS Simulator',
      description: 'Optional capability-negotiated agent-device sessions for bounded iOS Simulator inspection and interaction.',
      scopes: ['ios.discover', 'ios.simulator'],
      actions,
    },
    {
      capabilityId: 'ios-agent-device-physical',
      title: 'agent-device physical iPhone',
      description: 'Opt-in XCTest accessibility fallback for one exact physical iPhone. CoreDevice/RemoteXPC is the default physical-device path. Do not use agent-device for ordinary profile/form editing, Unicode text entry, screenshots, or known-coordinate interaction; use the physical-device provider and its batch fast path instead. Prepare XCTest only when semantic AX inspection is genuinely required.',
      scopes: ['ios.discover', 'ios.device'],
      actions,
    },
  ];
}

export function iosAgentDeviceActions(): AssistantPluginActionDescriptor[] {
  const read = [{ resource: 'repo-state' as const, mode: 'write' as const }];
  const write = [
    { resource: 'workspace' as const, mode: 'write' as const },
    { resource: 'repo-state' as const, mode: 'write' as const },
  ];
  const interactionProperty = { interaction_id: { type: 'string' } };
  return [
    {
      actionId: 'agent_device_status', title: 'agent-device status',
      description: 'Resolve the exact executable and verify a reviewed agent-device command contract.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 5_000, cancellable: true, idempotent: true,
      scopes: ['ios.discover'], resourceClaims: [], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: 'agent_device_doctor', title: 'agent-device doctor',
      description: 'Run the typed local iOS doctor command. This may warm the local XCTest runner cache.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 4 * 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.discover', 'ios.simulator', 'ios.device'], resourceClaims: write,
      argumentsSchema: { type: 'object', properties: { app: { type: 'string' }, device: { type: 'string' }, team_id: { type: 'string' }, runner_bundle_id: { type: 'string' }, developer_dir: { type: 'string' } }, additionalProperties: false },
    },
    {
      actionId: 'agent_device_prepare', title: 'Prepare semantic XCTest fallback',
      description: 'Explicitly build, sign, install and health-check the agent-device XCTest Runner. This is a heavy semantic fallback, not the normal physical-iPhone form-edit path. Physical-device preparation uses one stable per-device runtime so repeated semantic interactions can reuse it.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 10 * 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.discover', 'ios.simulator', 'ios.device'], resourceClaims: write,
      argumentsSchema: {
        type: 'object', properties: { device: { type: 'string' }, team_id: { type: 'string' }, runner_bundle_id: { type: 'string' }, developer_dir: { type: 'string' } },
        required: ['device'], additionalProperties: false,
      },
    },
    {
      actionId: 'agent_device_open', title: 'Open agent-device iOS session',
      description: 'Open an agent-device semantic session on one exact physical iPhone or booted Simulator. On physical iPhone this may start/reconnect an XCTest Runner; prefer physical_device_open plus physical_device_batch for ordinary app navigation and profile/form edits.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 4 * 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.simulator', 'ios.device'], resourceClaims: write,
      argumentsSchema: {
        type: 'object', properties: { app: { type: 'string' }, device: { type: 'string' }, relaunch: { type: 'boolean' }, team_id: { type: 'string' }, runner_bundle_id: { type: 'string' }, developer_dir: { type: 'string' } },
        required: ['app'], additionalProperties: false,
      },
    },
    {
      actionId: 'agent_device_batch', title: 'Run fast typed iOS action batch',
      description: `Run up to ${MAX_BATCH_STEPS} semantic AX steps in one agent-device process and one daemon request. Mutating steps settle before the next step. On a physical iPhone, use this only when accessibility semantics are required; known-coordinate/form workflows should use physical_device_batch to avoid XCTest lifecycle cost.`,
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 2 * 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.simulator', 'ios.device'], resourceClaims: write,
      argumentsSchema: {
        type: 'object',
        properties: {
          ...interactionProperty,
          steps: {
            type: 'array', minItems: 1, maxItems: MAX_BATCH_STEPS,
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: [...BATCH_KINDS] },
                input: { type: 'object', additionalProperties: true },
              },
              required: ['kind', 'input'],
              additionalProperties: false,
            },
          },
          timeout_ms: { type: 'number' },
        },
        required: ['interaction_id', 'steps'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'agent_device_jd_search', title: 'Search JD on a physical iPhone',
      description: 'Search JD with one bounded non-sensitive product query. A fresh one-shot call captures a PNG and closes; an explicitly reused active JD interaction defaults to no screenshot and remains warm. Login, verification, checkout, purchase, payment and biometrics remain human-only.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 10 * 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.device'], resourceClaims: write,
      argumentsSchema: {
        type: 'object', properties: {
          device: { type: 'string' }, query: { type: 'string' }, interaction_id: { type: 'string' },
          keep_session: { type: 'boolean' }, capture_screenshot: { type: 'boolean' },
          team_id: { type: 'string' }, runner_bundle_id: { type: 'string' }, developer_dir: { type: 'string' },
          search_target: { type: 'string' }, search_selector: { type: 'string' },
          submit_target: { type: 'string' }, submit_selector: { type: 'string' }, relaunch: { type: 'boolean' },
          result_text: { type: 'string' }, result_selector: { type: 'string' },
          result_scope: { type: 'string' }, snapshot_depth: { type: 'number' },
        },
        required: ['device', 'query'], additionalProperties: false,
      },
    },
    {
      actionId: 'agent_device_snapshot', title: 'Snapshot agent-device session',
      description: 'Capture bounded accessibility state from an active agent-device iOS session.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['ios.simulator', 'ios.device'], resourceClaims: read,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, interactive: { type: 'boolean' }, raw: { type: 'boolean' }, depth: { type: 'number' }, scope: { type: 'string' }, force_full: { type: 'boolean' } }, required: ['interaction_id'], additionalProperties: false },
    },
    {
      actionId: 'agent_device_press', title: 'Press agent-device target',
      description: 'Press one ref, selector, or explicit coordinate pair. Semantic targets return a settled bounded diff; explicit coordinates bypass accessibility settle for heavy-screen recovery.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.simulator', 'ios.device'], resourceClaims: write,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, target: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['interaction_id'], additionalProperties: false },
    },
    {
      actionId: 'agent_device_fill', title: 'Fill agent-device target',
      description: 'Replace non-sensitive text in one ref or selector and return a redacted settled diff. Use manual UI entry for passwords or verification codes.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.simulator', 'ios.device'], resourceClaims: write,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, target: { type: 'string' }, text: { type: 'string' }, delay_ms: { type: 'number' } }, required: ['interaction_id', 'target', 'text'], additionalProperties: false },
    },
    {
      actionId: 'agent_device_scroll', title: 'Scroll agent-device session',
      description: 'Scroll one active agent-device iOS session serially.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.simulator', 'ios.device'], resourceClaims: write,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, direction: { type: 'string', enum: ['up', 'down', 'left', 'right', 'top', 'bottom'] }, amount: { type: 'number' } }, required: ['interaction_id', 'direction'], additionalProperties: false },
    },
    {
      actionId: 'agent_device_screenshot', title: 'Capture agent-device screenshot',
      description: 'Capture a bounded PNG into Controller-owned iOS artifact storage.',
      readOnly: false, risk: 'workspace_write', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.simulator', 'ios.device'], resourceClaims: write,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, label: { type: 'string' }, overlay_refs: { type: 'boolean' }, max_size: { type: 'number' } }, required: ['interaction_id'], additionalProperties: false },
    },
    {
      actionId: 'agent_device_events', title: 'Read agent-device events',
      description: 'Read a bounded page of daemon-owned session events.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 30_000, cancellable: true, idempotent: true,
      scopes: ['ios.simulator', 'ios.device'], resourceClaims: read,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, limit: { type: 'number' }, cursor: { type: 'string' } }, required: ['interaction_id'], additionalProperties: false },
    },
    {
      actionId: 'agent_device_close', title: 'Close agent-device session',
      description: 'Close the provider session. Shutdown applies only to simulators; physical iPhones are never shut down.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['ios.simulator', 'ios.device'], resourceClaims: write,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, shutdown_simulator: { type: 'boolean' } }, required: ['interaction_id'], additionalProperties: false },
    },
  ];
}

export async function executeIosAgentDeviceAction(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  if (input.deadlineAtMs === undefined && typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)) {
    input = { ...input, deadlineAtMs: Date.now() + Math.max(1, Math.trunc(input.timeoutMs)) };
  }
  if (input.actionId === 'agent_device_status') return { provider: 'agent-device', ...await iosAgentDeviceActionStatus(input) };
  if (input.actionId === 'agent_device_close') {
    const interactionId = requireString(input.args.interaction_id, 'interaction_id');
    const existing = readAgentDeviceInteraction(input.repoRoot, interactionId);
    if (existing && !isInteractionSessionActive(existing.status)) {
      return { provider: 'agent-device', interaction: existing, alreadyClosed: true };
    }
  }
  const dependency = await requireDependencyAsync(input);

  if (input.actionId === 'agent_device_jd_search') return executeJdSearch(input);

  if (input.actionId === 'agent_device_doctor') {
    const selected = selectTarget(input, optionalString(input.args.device));
    const args = ['doctor', '--platform', 'ios', '--device', selected.name];
    const app = optionalString(input.args.app);
    if (app) args.push('--app', app);
    args.push('--json');
    return {
      provider: 'agent-device',
      version: dependency.detectedVersion ?? IOS_AGENT_DEVICE_VERSION,
      contractFingerprint: dependency.capabilityProfile.contractFingerprint,
      device: selected,
      physicalDeviceSupported: selected.kind === 'device',
      result: bounded(await runJsonAsync(input, args, {
        signing: signingFromArgs(input.args),
        stateDir: targetRuntimeStateDir(input, selected),
        failureCode: 'AGENT_DEVICE_DOCTOR_FAILED',
        timeoutMs: 4 * 60_000,
      })),
    };
  }

  if (input.actionId === 'agent_device_prepare') {
    const selected = selectTarget(input, requireString(input.args.device, 'device'));
    const signing = signingFromArgs(input.args);
    return {
      provider: 'agent-device',
      version: dependency.detectedVersion ?? IOS_AGENT_DEVICE_VERSION,
      contractFingerprint: dependency.capabilityProfile.contractFingerprint,
      device: selected,
      physicalDeviceSupported: selected.kind === 'device',
      result: bounded(await runJsonAsync(input, [
        'prepare', 'ios-runner', '--platform', 'ios', '--device', selected.name, '--timeout', '600000', '--json',
      ], {
        signing,
        stateDir: targetRuntimeStateDir(input, selected),
        failureCode: 'AGENT_DEVICE_PREPARE_FAILED',
        timeoutMs: 10 * 60_000,
      })),
    };
  }

  if (input.actionId === 'agent_device_open') {
    reconcileExpiredSessions(input);
    const app = requireString(input.args.app, 'app');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(app)) {
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'agent_device_open accepts an app name or bundle identifier, not a URL or tokenized deep link.', { retryable: false });
    }
    const selected = selectTarget(input, optionalString(input.args.device));
    const provider = providerForDevice(selected);
    const conflict = listInteractionSessions(input.repoRoot, provider).find((entry) =>
      isInteractionSessionActive(entry.status) && interactionMayOwnTarget(entry, selected.aliases));
    if (conflict) {
      throw new AssistantPluginError('PLUGIN_RESOURCE_BUSY', 'The selected iOS target already has an active interaction.', {
        retryable: true,
        details: {
          interactionId: conflict.interactionId,
          targetId: conflict.targetId,
          resourceProvider: conflict.provider,
          automationEngine: interactionAutomationEngine(conflict),
        },
      });
    }
    pruneInteractionSessions(input.repoRoot, provider, 100);
    const interactionId = `ios_agent_device_${randomUUID()}`;
    const createdAt = timestamp();
    const record: InteractionSessionRecord = {
      schemaVersion: 1,
      interactionId,
      provider,
      engine: 'agent-device',
      sessionId: `forge-${sanitize(interactionId).slice(-40)}`,
      targetId: selected.id,
      targetAliases: selected.aliases,
      status: 'starting',
      reason: selected.kind === 'simulator' ? 'ios_simulator_automation' : 'ios_physical_device_automation',
      instructions: app,
      owner: { repoId: input.repoId, requestId: input.requestId, jobId: input.jobId },
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(hooks.now().getTime() + SESSION_EXPIRY_MS).toISOString(),
    };
    writeInteractionSession(input.repoRoot, record);
    writeSigningConfig(input, interactionId, signingFromArgs(input.args));
    const args = ['open', app, '--device', selected.id];
    if (input.args.relaunch === true) args.push('--relaunch');
    try {
      const result = await runJsonAsync(input, [...args, '--session', record.sessionId, '--platform', 'ios', '--json'], {
        record,
        timeoutMs: 4 * 60_000,
        failureCode: 'AGENT_DEVICE_OPEN_FAILED',
      });
      const active = patchInteractionSession(input.repoRoot, provider, interactionId, { status: 'waiting_for_user' }) ?? record;
      return {
        provider: 'agent-device',
        version: dependency.detectedVersion ?? IOS_AGENT_DEVICE_VERSION,
        contractFingerprint: dependency.capabilityProfile.contractFingerprint,
        interaction: active,
        device: selected,
        physicalDeviceSupported: selected.kind === 'device',
        result: bounded(result),
      };
    } catch (error) {
      return failSession(input, record, error);
    }
  }

  const record = requireRecord(input, input.actionId === 'agent_device_close');
  switch (input.actionId) {
    case 'agent_device_batch': {
      const prepared = prepareAgentDeviceBatch(input.args.steps, record);
      const timeoutMs = batchInteger(input.args.timeout_ms, 120_000, 1_000, 180_000);
      return {
        provider: 'agent-device',
        interaction: record,
        batched: true,
        stepCount: prepared.nativeSteps.length,
        result: bounded(await runSessionBatch(input, record, prepared, timeoutMs)),
      };
    }
    case 'agent_device_snapshot': {
      const request: AgentDeviceSnapshotRequest = {
        interactiveOnly: input.args.interactive === true,
        raw: input.args.raw === true,
        depth: typeof input.args.depth === 'number' ? input.args.depth : undefined,
        scope: optionalString(input.args.scope),
        forceFull: input.args.force_full === true,
      };
      const result = await runSessionSnapshot(input, record, request);
      return {
        provider: 'agent-device',
        backend: result.provider === 'typed' ? 'typed' : 'cli',
        configuredBackend: configuredAgentDeviceBackendMode(),
        interaction: record,
        result: bounded(result),
      };
    }
    case 'agent_device_press': {
      const target = optionalString(input.args.target);
      const hasPoint = typeof input.args.x === 'number' && typeof input.args.y === 'number';
      if (!target && !hasPoint) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'target or x/y is required.', { retryable: false });
      if (record.provider === DEVICE_PROVIDER && target && SENSITIVE_SEMANTICS.test(target)) {
        throw new AssistantPluginError('IOS_DEVICE_SENSITIVE_ACTION_BLOCKED', 'Press targets involving credentials, verification, biometrics, checkout, purchase or payment require human interaction.', { retryable: false });
      }
      const baseArgs = ['press', ...(target ? [target] : [String(input.args.x), String(input.args.y)])];
      // Explicit coordinate presses are the bounded fallback for screens whose
      // accessibility tree is too heavy or animated to snapshot reliably.
      // Settling forces an AX snapshot after the mutation, defeating that
      // fallback and can recycle/wedge the XCTest runner. Keep semantic target
      // presses settled, but let explicit points complete without AX capture.
      const args = target
        ? appendSettleFlag(capabilityProfile(input.repoRoot), baseArgs, 'press')
        : baseArgs;
      return { provider: 'agent-device', interaction: record, result: bounded(await runSessionCommand(input, record, args, 'AGENT_DEVICE_PRESS_FAILED')) };
    }
    case 'agent_device_fill': {
      const target = requireString(input.args.target, 'target');
      const text = typeof input.args.text === 'string' ? input.args.text : undefined;
      if (text === undefined) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'text is required.', { retryable: false });
      if (record.provider === DEVICE_PROVIDER && (SENSITIVE_SEMANTICS.test(target) || SENSITIVE_SEMANTICS.test(text))) {
        throw new AssistantPluginError('IOS_DEVICE_SENSITIVE_ACTION_BLOCKED', 'Sensitive text and credential, verification, checkout, purchase or payment targets require human interaction.', { retryable: false });
      }
      const profile = capabilityProfile(input.repoRoot);
      const args = appendSettleFlag(profile, ['fill', target, text]);
      if (typeof input.args.delay_ms === 'number') {
        if (!profile.fill.delayFlag) {
          throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', 'The detected agent-device contract does not support delayed fill.', { retryable: false });
        }
        args.push(profile.fill.delayFlag, String(Math.max(0, Math.min(5_000, Math.trunc(input.args.delay_ms)))));
      }
      const result = await runSessionCommand(input, record, args, 'AGENT_DEVICE_FILL_FAILED');
      return { provider: 'agent-device', interaction: record, result: bounded(redactExactText(result, text)) };
    }
    case 'agent_device_scroll': {
      const direction = requireString(input.args.direction, 'direction');
      if (!['up', 'down', 'left', 'right', 'top', 'bottom'].includes(direction)) {
        throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Unsupported scroll direction.', { retryable: false });
      }
      const args = ['scroll', direction];
      if (typeof input.args.amount === 'number') args.push(String(Math.max(1, Math.min(100, Math.trunc(input.args.amount)))));
      return { provider: 'agent-device', interaction: record, result: bounded(await runSessionCommand(input, record, args, 'AGENT_DEVICE_SCROLL_FAILED')) };
    }
    case 'agent_device_screenshot': {
      const label = sanitize(optionalString(input.args.label) ?? 'screenshot');
      const path = join(artifactDir(input, record.interactionId), `${label}-${hooks.now().getTime()}.png`);
      const args = ['screenshot', path];
      if (input.args.overlay_refs === true) args.push('--overlay-refs');
      if (typeof input.args.max_size === 'number') args.push('--max-size', String(Math.max(320, Math.min(4_096, Math.trunc(input.args.max_size)))));
      const result = await runSessionCommand(input, record, args, 'AGENT_DEVICE_SCREENSHOT_FAILED');
      if (!existsSync(path)) {
        return failSession(input, record, new AssistantPluginError('AGENT_DEVICE_SCREENSHOT_MISSING', 'agent-device succeeded without creating the requested screenshot.', { retryable: false }));
      }
      return {
        provider: 'agent-device', interaction: record, result: bounded(result),
        artifactCandidates: [{ kind: 'ios_agent_device_screenshot', mediaType: 'image/png', path }],
      };
    }
    case 'agent_device_events': {
      const args = ['events'];
      if (typeof input.args.limit === 'number') args.push(String(Math.max(1, Math.min(200, Math.trunc(input.args.limit)))));
      const cursor = optionalString(input.args.cursor);
      if (cursor) args.push(cursor);
      const result = await runSessionCommand(input, record, args, 'AGENT_DEVICE_EVENTS_FAILED', 30_000);
      return { provider: 'agent-device', interaction: record, result: bounded(redactEventEvidence(result)) };
    }
    case 'agent_device_close': {
      if (!isInteractionSessionActive(record.status)) {
        return { provider: 'agent-device', interaction: record, alreadyClosed: true };
      }
      return serializeInteractionCommand(input, record, async (current) => {
        if (!isInteractionSessionActive(current.status)) {
          return { provider: 'agent-device', interaction: current, alreadyClosed: true };
        }
        const args = ['close'];
        if (current.provider === SIMULATOR_PROVIDER && input.args.shutdown_simulator === true) args.push('--shutdown');
        patchInteractionSession(input.repoRoot, current.provider, current.interactionId, { status: 'closing' });
        try {
          const closedProvider = await closeProviderSession(input, current, args);
          const closed = patchInteractionSession(input.repoRoot, current.provider, current.interactionId, { status: 'closed' }) ?? current;
          return {
            provider: 'agent-device',
            interaction: closed,
            result: bounded(closedProvider.result),
            providerAlreadyAbsent: closedProvider.providerAlreadyAbsent,
          };
        } catch (error) {
          return failSession(input, current, error);
        }
      }, { allowTerminal: true });
    }
    default:
      throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', `ios/${input.actionId} is not supported.`, { retryable: false });
  }
}
