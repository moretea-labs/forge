import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, extname, join, resolve } from 'path';
import {
  WorkspaceTargetGrantError,
  authorizeWorkspaceTargetGrant,
  getActiveWorkspaceTargetGrant,
  listActiveWorkspaceTargetGrants,
  resolveWorkspaceTargetCwd,
  resolveWorkspaceTargetPath,
  revokeWorkspaceTargetGrant,
  withWorkspaceTargetMutationLocks,
  type ActiveWorkspaceTargetGrant,
  type WorkspaceTargetAccess,
  type WorkspaceTargetGrantScope,
  type WorkspaceTargetOperation,
} from '../workspace-targets';
import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginCapability,
  AssistantPluginHealth,
  AssistantPluginManifest,
  AssistantPluginPermissionScope,
} from './types';
import { AssistantPluginError } from './errors';
import {
  classifyRepositoryCommand,
  classifyRepositoryCommandReplay,
} from '../../cli/repositories/command-classifier';
import {
  assertCommandPathOperandsStayInRepository,
  assertRepositoryCommandInputAllowed,
} from '../../cli/repositories/command-scope';
import { runCanonicalCommand } from '../../cli/repositories/command-executor';

const PLUGIN_ID = 'local_system';
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_TEXT_CHARS = 100_000;
const MAX_DIRECTORY_ENTRIES = 200;
const TARGET_SAFE_FILESYSTEM_MUTATORS = new Set(['touch', 'mkdir', 'cp', 'mv', 'install', 'tee', 'truncate']);
const PROJECT_SCRIPT_RUNTIMES = new Set(['node', 'bun', 'python3', 'ruby', 'bash', 'sh']);
const AUTO_OPEN_DENIED_EXTENSIONS = new Set([
  '.command', '.sh', '.bash', '.zsh', '.fish', '.tool',
  '.app', '.pkg', '.mpkg', '.dmg', '.workflow',
]);

interface CommandResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  command: string[];
}

export interface LocalSystemPluginHooks {
  now?: () => Date;
  runCommand?: (command: string, args: string[], timeoutMs?: number) => CommandResult;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
}

let hooks: LocalSystemPluginHooks = {};

export function setLocalSystemPluginHooksForTest(next: LocalSystemPluginHooks): void {
  hooks = next;
}

export function resetLocalSystemPluginHooksForTest(): void {
  hooks = {};
}

function currentDate(): Date {
  return hooks.now?.() ?? new Date();
}

function now(): string {
  return currentDate().toISOString();
}

const GENERIC_CONTROLLER_ACTORS = new Set([
  '',
  'anonymous',
  'plugin_action_execute',
]);

function requestOwnerScope(input: AssistantPluginActionExecutionInput): string {
  const actor = input.origin.actor?.trim() || '';
  if (GENERIC_CONTROLLER_ACTORS.has(actor)) return 'controller:shared';
  return `${input.origin.surface}:${actor}`;
}

function activeTargets(input: AssistantPluginActionExecutionInput): ActiveWorkspaceTargetGrant[] {
  try {
    return listActiveWorkspaceTargetGrants(
      input.controllerHome,
      currentDate(),
      requestOwnerScope(input),
    );
  } catch (error) {
    return rethrowTargetError(error);
  }
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = typeof args[key] === 'string' ? String(args[key]).trim() : '';
  if (!value) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `${key} is required.`, { retryable: false });
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = typeof args[key] === 'string' ? String(args[key]).trim() : '';
  return value || undefined;
}

function requiredStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `${key} must be a non-empty string array.`, { retryable: false });
  }
  return value.map((entry) => String(entry));
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `${key} must be a string array.`, { retryable: false });
  }
  return value.map(String);
}

function bounded(value: string, maxBytes = MAX_OUTPUT_BYTES): { content: string; truncated: boolean; byteLength: number } {
  const source = Buffer.from(value, 'utf8');
  if (source.byteLength <= maxBytes) return { content: value, truncated: false, byteLength: source.byteLength };
  return {
    content: source.subarray(0, maxBytes).toString('utf8'),
    truncated: true,
    byteLength: source.byteLength,
  };
}

function run(command: string, args: string[], timeoutMs = 30_000): CommandResult {
  if (hooks.runCommand) return hooks.runCommand(command, args, timeoutMs);
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: Math.max(1_000, Math.min(Math.trunc(timeoutMs), 120_000)),
    maxBuffer: MAX_OUTPUT_BYTES * 2,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? result.error?.message ?? ''),
    command: [command, ...args],
  };
}

function projectScriptRuntimePath(runtime: string): string {
  const home = process.env.HOME?.trim();
  const candidates: Record<string, string[]> = {
    node: ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'],
    bun: [
      ...(home ? [join(resolve(home), '.bun', 'bin', 'bun')] : []),
      '/opt/homebrew/bin/bun',
      '/usr/local/bin/bun',
    ],
    python3: ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'],
    ruby: ['/opt/homebrew/bin/ruby', '/usr/local/bin/ruby', '/usr/bin/ruby'],
    bash: ['/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/bin/bash'],
    sh: ['/bin/sh'],
  };
  const executable = (candidates[runtime] ?? []).find((candidate) => {
    try {
      return existsSync(candidate) && statSync(candidate).isFile() && (statSync(candidate).mode & 0o111) !== 0;
    } catch {
      return false;
    }
  });
  if (!executable) {
    throw new AssistantPluginError(
      'LOCAL_SYSTEM_SCRIPT_RUNTIME_UNAVAILABLE',
      `The approved ${runtime} interpreter is not installed in a canonical system location.`,
      { retryable: false, details: { runtime } },
    );
  }
  return realpathSync(executable);
}

const TARGET_ERROR_CODES: Record<WorkspaceTargetGrantError['code'], string> = {
  TARGET_ROOT_INVALID: 'LOCAL_SYSTEM_TARGET_ROOT_INVALID',
  TARGET_KEY_REQUIRED: 'LOCAL_SYSTEM_TARGET_KEY_REQUIRED',
  TARGET_REASON_REQUIRED: 'LOCAL_SYSTEM_TARGET_REASON_REQUIRED',
  TARGET_STORE_CORRUPT: 'LOCAL_SYSTEM_TARGET_STORE_CORRUPT',
  TARGET_STORE_BUSY: 'LOCAL_SYSTEM_TARGET_STORE_BUSY',
  TARGET_MUTATION_BUSY: 'LOCAL_SYSTEM_TARGET_MUTATION_BUSY',
  TARGET_IDENTITY_MISMATCH: 'LOCAL_SYSTEM_TARGET_IDENTITY_MISMATCH',
  TARGET_OWNER_SCOPE_REQUIRED: 'LOCAL_SYSTEM_TARGET_OWNER_INVALID',
  TARGET_OWNER_MISMATCH: 'LOCAL_SYSTEM_TARGET_OWNER_MISMATCH',
  TARGET_PROJECT_REQUIRED: 'LOCAL_SYSTEM_TARGET_PROJECT_REQUIRED',
  TARGET_UNAVAILABLE: 'LOCAL_SYSTEM_TARGET_UNAVAILABLE',
  PATH_OUTSIDE_TARGET: 'LOCAL_SYSTEM_PATH_OUTSIDE_TARGET',
  SYMLINK_ESCAPE: 'LOCAL_SYSTEM_SYMLINK_ESCAPE',
  PATH_NOT_FOUND: 'LOCAL_SYSTEM_PATH_NOT_FOUND',
  PATH_NOT_DIRECTORY: 'LOCAL_SYSTEM_PATH_NOT_DIRECTORY',
  PATH_NOT_FILE: 'LOCAL_SYSTEM_PATH_NOT_FILE',
  TARGET_ACCESS_DENIED: 'LOCAL_SYSTEM_TARGET_READ_ONLY',
};

function rethrowTargetError(error: unknown): never {
  if (error instanceof WorkspaceTargetGrantError) {
    throw new AssistantPluginError(TARGET_ERROR_CODES[error.code], error.message, {
      retryable: error.code === 'TARGET_STORE_BUSY' || error.code === 'TARGET_MUTATION_BUSY',
    });
  }
  throw error;
}

function resolveTargetPath(
  input: AssistantPluginActionExecutionInput,
  targetKey: string,
  relativePath: string | undefined,
  options: {
    mustExist: boolean;
    directory?: boolean;
    file?: boolean;
    operation?: WorkspaceTargetOperation;
  },
) {
  try {
    return resolveWorkspaceTargetPath(input.controllerHome, targetKey, relativePath, {
      mustExist: options.mustExist,
      ownerScope: requestOwnerScope(input),
      at: currentDate(),
      ...(options.directory ? { kind: 'directory' as const } : {}),
      ...(options.file ? { kind: 'file' as const } : {}),
      operation: options.operation ?? 'read',
    });
  } catch (error) {
    return rethrowTargetError(error);
  }
}

async function withTargetMutation<T>(
  input: AssistantPluginActionExecutionInput,
  targetKeys: readonly string[],
  operation: () => Promise<T> | T,
): Promise<T> {
  try {
    const ownerScope = requestOwnerScope(input);
    const targets = targetKeys.map((targetKey) => getActiveWorkspaceTargetGrant(
      input.controllerHome,
      targetKey,
      currentDate(),
      ownerScope,
    ));
    return await withWorkspaceTargetMutationLocks(
      input.controllerHome,
      targets,
      `local-system:${input.requestId}`,
      operation,
      { waitMs: 5_000 },
    );
  } catch (error) {
    return rethrowTargetError(error);
  }
}

function authorizeTarget(input: AssistantPluginActionExecutionInput): Record<string, unknown> {
  const rawAccess = optionalString(input.args, 'access');
  const rawScope = optionalString(input.args, 'scope') ?? 'auto';
  if (rawAccess && rawAccess !== 'read_only' && rawAccess !== 'read_write') {
    throw new AssistantPluginError(
      'PLUGIN_ACTION_ARGUMENT_INVALID',
      'access must be read_only or read_write.',
      { retryable: false },
    );
  }
  if (!['auto', 'project', 'directory'].includes(rawScope)) {
    throw new AssistantPluginError(
      'PLUGIN_ACTION_ARGUMENT_INVALID',
      'scope must be auto, project, or directory.',
      { retryable: false },
    );
  }
  const ownerScope = requestOwnerScope(input);
  const controllerInstanceId = process.env.FORGE_WRITER_INSTANCE_ID?.trim()
    || process.env.FORGE_RUNTIME_INSTANCE_ID?.trim()
    || process.env.FORGE_DAEMON_INSTANCE_ID?.trim();
  try {
    const target = authorizeWorkspaceTargetGrant(input.controllerHome, {
      targetKey: requiredString(input.args, 'target_key'),
      rootPath: requiredString(input.args, 'root_path'),
      expiresInMinutes: Number(input.args.expires_in_minutes ?? 480),
      reason: requiredString(input.args, 'reason'),
      access: (rawAccess as WorkspaceTargetAccess | undefined) ?? 'read_write',
      scope: rawScope as WorkspaceTargetGrantScope,
      ownerScope,
      ...(controllerInstanceId ? { controllerInstanceId } : {}),
      now: currentDate(),
    });
    return {
      target,
      authorizationScope: rawScope,
      requestedRootPath: requiredString(input.args, 'root_path'),
      effectiveRootPath: target.rootPath,
      storage: 'controllerHome/system/local-system/targets.json',
      repositoryRegistered: false,
    };
  } catch (error) {
    return rethrowTargetError(error);
  }
}

function systemSnapshot(): Record<string, unknown> {
  const processes = run('ps', ['-Ao', 'pid=,ppid=,%cpu=,%mem=,comm=', '-r']);
  const vm = run('vm_stat', []);
  const pressure = run('memory_pressure', []);
  return {
    platform: process.platform,
    generatedAt: now(),
    processes: bounded(processes.stdout || processes.stderr),
    virtualMemory: bounded(vm.stdout || vm.stderr),
    memoryPressure: bounded(pressure.stdout || pressure.stderr),
    commands: [processes.command, vm.command, pressure.command],
  };
}

function processDetail(pidValue: unknown): Record<string, unknown> {
  const pid = Number(pidValue);
  if (!Number.isInteger(pid) || pid <= 0) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'pid must be a positive integer.', { retryable: false });
  const detail = run('ps', ['-p', String(pid), '-o', 'pid=,ppid=,user=,%cpu=,%mem=,etime=,state=,command=']);
  return { pid, found: detail.ok && Boolean(detail.stdout.trim()), output: bounded(detail.stdout || detail.stderr), command: detail.command };
}

function requiredPositivePid(value: unknown): number {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'pid must be a positive integer.', { retryable: false });
  }
  if (pid === process.pid) {
    throw new AssistantPluginError('LOCAL_SYSTEM_PROCESS_SELF_DENIED', 'The local_system host process cannot terminate itself.', { retryable: false });
  }
  return pid;
}

function verifiedProcessCommand(pid: number, expectedCommand: string): { found: boolean; commandLine: string; command: string[] } {
  const expected = expectedCommand.trim();
  if (expected.length < 4) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'expected_command_contains must contain at least 4 characters.', { retryable: false });
  }
  const detail = run('ps', ['-p', String(pid), '-o', 'command=']);
  const commandLine = detail.stdout.trim();
  if (!detail.ok || !commandLine) return { found: false, commandLine: '', command: detail.command };
  if (!commandLine.includes(expected)) {
    throw new AssistantPluginError(
      'LOCAL_SYSTEM_PROCESS_IDENTITY_MISMATCH',
      `PID ${pid} does not match expected command identity.`,
      { retryable: false, details: { pid, expectedCommandContains: expected, observedCommand: bounded(commandLine, 4096).content } },
    );
  }
  return { found: true, commandLine, command: detail.command };
}

function terminateVerifiedProcess(pidValue: unknown, expectedCommandValue: unknown): Record<string, unknown> {
  const pid = requiredPositivePid(pidValue);
  const expectedCommand = typeof expectedCommandValue === 'string' ? expectedCommandValue.trim() : '';
  const verified = verifiedProcessCommand(pid, expectedCommand);
  if (!verified.found) {
    return { terminated: false, alreadyExited: true, pid, signal: 'SIGTERM', verificationCommand: verified.command };
  }
  try {
    if (hooks.signalProcess) hooks.signalProcess(pid, 'SIGTERM');
    else process.kill(pid, 'SIGTERM');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return { terminated: false, alreadyExited: true, pid, signal: 'SIGTERM', verificationCommand: verified.command };
    throw new AssistantPluginError('LOCAL_SYSTEM_PROCESS_TERMINATE_FAILED', error instanceof Error ? error.message : String(error), {
      retryable: code === 'EBUSY', details: { pid, expectedCommandContains: expectedCommand },
    });
  }
  return {
    terminated: true,
    alreadyExited: false,
    pid,
    signal: 'SIGTERM',
    expectedCommandContains: expectedCommand,
    observedCommand: bounded(verified.commandLine, 4096),
    verificationCommand: verified.command,
  };
}

function userLaunchAgentIdentity(labelValue: unknown, expectedProgramValue: unknown): { label: string; expectedProgram: string; domain: string; service: string; plistPath: string } {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') {
    throw new AssistantPluginError('LOCAL_SYSTEM_LAUNCHD_UNAVAILABLE', 'User LaunchAgent lifecycle control is available only on macOS.', { retryable: false });
  }
  const label = typeof labelValue === 'string' ? labelValue.trim() : '';
  if (!/^[A-Za-z0-9._-]{3,200}$/.test(label)) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'label must be a concrete macOS LaunchAgent label.', { retryable: false });
  }
  const expectedProgram = typeof expectedProgramValue === 'string' ? expectedProgramValue.trim() : '';
  if (expectedProgram.length < 4) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'expected_program_contains must contain at least 4 characters.', { retryable: false });
  }
  const home = process.env.HOME?.trim();
  if (!home) throw new AssistantPluginError('LOCAL_SYSTEM_HOME_UNAVAILABLE', 'HOME is required to resolve the current user LaunchAgents directory.', { retryable: false });
  const domain = `gui/${process.getuid()}`;
  return {
    label,
    expectedProgram,
    domain,
    service: `${domain}/${label}`,
    plistPath: join(resolve(home), 'Library', 'LaunchAgents', `${label}.plist`),
  };
}

function assertLaunchAgentObservedIdentity(identity: ReturnType<typeof userLaunchAgentIdentity>, observed: string): void {
  if (!observed.includes(identity.expectedProgram)) {
    throw new AssistantPluginError('LOCAL_SYSTEM_LAUNCH_AGENT_IDENTITY_MISMATCH', `LaunchAgent ${identity.label} does not match expected program identity.`, {
      retryable: false,
      details: { label: identity.label, expectedProgramContains: identity.expectedProgram, observed: bounded(observed, 8192).content },
    });
  }
}

function assertInstalledLaunchAgentIdentity(identity: ReturnType<typeof userLaunchAgentIdentity>): void {
  if (!existsSync(identity.plistPath) || !statSync(identity.plistPath).isFile()) {
    throw new AssistantPluginError('LOCAL_SYSTEM_LAUNCH_AGENT_PLIST_NOT_FOUND', `LaunchAgent plist for ${identity.label} is unavailable.`, {
      retryable: false, details: { label: identity.label, plistPath: identity.plistPath },
    });
  }
  const content = readFileSync(identity.plistPath, 'utf8');
  if (!content.includes(identity.expectedProgram) || !content.includes(identity.label)) {
    throw new AssistantPluginError('LOCAL_SYSTEM_LAUNCH_AGENT_IDENTITY_MISMATCH', `LaunchAgent plist for ${identity.label} does not match expected identity.`, {
      retryable: false, details: { label: identity.label, expectedProgramContains: identity.expectedProgram, plistPath: identity.plistPath },
    });
  }
}

export function restartVerifiedUserLaunchAgent(labelValue: unknown, expectedProgramValue: unknown): Record<string, unknown> {
  const identity = userLaunchAgentIdentity(labelValue, expectedProgramValue);
  const inspected = run('/bin/launchctl', ['print', identity.service], 15_000);
  if (!inspected.ok) {
    throw new AssistantPluginError('LOCAL_SYSTEM_LAUNCH_AGENT_NOT_FOUND', `LaunchAgent ${identity.label} is not loaded.`, {
      retryable: false, details: { label: identity.label, service: identity.service, stderr: bounded(inspected.stderr, 4096).content },
    });
  }
  assertLaunchAgentObservedIdentity(identity, `${inspected.stdout}\n${inspected.stderr}`);
  const restarted = run('/bin/launchctl', ['kickstart', '-k', identity.service], 30_000);
  if (!restarted.ok) {
    throw new AssistantPluginError('LOCAL_SYSTEM_LAUNCH_AGENT_RESTART_FAILED', restarted.stderr.trim() || restarted.stdout.trim() || `Failed to restart ${identity.label}.`, {
      retryable: true, details: { label: identity.label, service: identity.service, exitCode: restarted.status },
    });
  }
  return { restarted: true, label: identity.label, service: identity.service, expectedProgramContains: identity.expectedProgram, inspectCommand: inspected.command, restartCommand: restarted.command };
}

export function stopVerifiedUserLaunchAgent(labelValue: unknown, expectedProgramValue: unknown): Record<string, unknown> {
  const identity = userLaunchAgentIdentity(labelValue, expectedProgramValue);
  const inspected = run('/bin/launchctl', ['print', identity.service], 15_000);
  if (!inspected.ok) {
    assertInstalledLaunchAgentIdentity(identity);
    return { stopped: false, alreadyStopped: true, label: identity.label, service: identity.service, plistPath: identity.plistPath };
  }
  assertLaunchAgentObservedIdentity(identity, `${inspected.stdout}\n${inspected.stderr}`);
  const stopped = run('/bin/launchctl', ['bootout', identity.service], 30_000);
  if (!stopped.ok) {
    throw new AssistantPluginError('LOCAL_SYSTEM_LAUNCH_AGENT_STOP_FAILED', stopped.stderr.trim() || stopped.stdout.trim() || `Failed to stop ${identity.label}.`, {
      retryable: true, details: { label: identity.label, service: identity.service, exitCode: stopped.status },
    });
  }
  return { stopped: true, alreadyStopped: false, label: identity.label, service: identity.service, expectedProgramContains: identity.expectedProgram, inspectCommand: inspected.command, stopCommand: stopped.command };
}

export function startVerifiedUserLaunchAgent(labelValue: unknown, expectedProgramValue: unknown): Record<string, unknown> {
  const identity = userLaunchAgentIdentity(labelValue, expectedProgramValue);
  assertInstalledLaunchAgentIdentity(identity);
  const inspected = run('/bin/launchctl', ['print', identity.service], 15_000);
  let bootstrapCommand: string[] | undefined;
  if (inspected.ok) {
    assertLaunchAgentObservedIdentity(identity, `${inspected.stdout}\n${inspected.stderr}`);
  } else {
    const bootstrapped = run('/bin/launchctl', ['bootstrap', identity.domain, identity.plistPath], 30_000);
    if (!bootstrapped.ok) {
      throw new AssistantPluginError('LOCAL_SYSTEM_LAUNCH_AGENT_START_FAILED', bootstrapped.stderr.trim() || bootstrapped.stdout.trim() || `Failed to bootstrap ${identity.label}.`, {
        retryable: true, details: { label: identity.label, service: identity.service, plistPath: identity.plistPath, exitCode: bootstrapped.status },
      });
    }
    bootstrapCommand = bootstrapped.command;
  }
  const enabled = run('/bin/launchctl', ['enable', identity.service], 15_000);
  if (!enabled.ok) throw new AssistantPluginError('LOCAL_SYSTEM_LAUNCH_AGENT_START_FAILED', enabled.stderr.trim() || `Failed to enable ${identity.label}.`, { retryable: true });
  const started = run('/bin/launchctl', ['kickstart', identity.service], 30_000);
  if (!started.ok) throw new AssistantPluginError('LOCAL_SYSTEM_LAUNCH_AGENT_START_FAILED', started.stderr.trim() || `Failed to start ${identity.label}.`, { retryable: true });
  return { started: true, label: identity.label, service: identity.service, plistPath: identity.plistPath, bootstrapCommand, enableCommand: enabled.command, startCommand: started.command };
}

function actions(): AssistantPluginActionDescriptor[] {
  const controllerRead = [{ resource: 'repo-state' as const, mode: 'read' as const }];
  const controllerWrite = [{ resource: 'repo-state' as const, mode: 'write' as const }];
  const targetProperties = {
    target_key: { type: 'string' },
    path: { type: 'string' },
  };
  return [
    { actionId: 'system_snapshot', title: 'System snapshot', description: 'Read bounded CPU, process, memory, and pressure diagnostics.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 30_000, cancellable: true, idempotent: true, scopes: ['local-system.read'], resourceClaims: [], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { actionId: 'process_detail', title: 'Process detail', description: 'Read bounded details for one process id.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 15_000, cancellable: true, idempotent: true, scopes: ['local-system.read'], resourceClaims: [], argumentsSchema: { type: 'object', properties: { pid: { type: 'number' } }, required: ['pid'], additionalProperties: false } },
    { actionId: 'terminate_process', title: 'Terminate verified process', description: 'Send SIGTERM to one exact PID only after its current command line matches the caller-provided expected identity.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 15_000, cancellable: true, idempotent: true, scopes: ['local-system.process'], resourceClaims: controllerWrite, argumentsSchema: { type: 'object', properties: { pid: { type: 'number' }, expected_command_contains: { type: 'string' } }, required: ['pid', 'expected_command_contains'], additionalProperties: false } },
    { actionId: 'restart_user_launch_agent', title: 'Restart verified user LaunchAgent', description: 'Restart one loaded user LaunchAgent by exact label only after launchctl evidence contains the expected program identity.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false, scopes: ['local-system.process'], resourceClaims: controllerWrite, argumentsSchema: { type: 'object', properties: { label: { type: 'string' }, expected_program_contains: { type: 'string' } }, required: ['label', 'expected_program_contains'], additionalProperties: false } },
    { actionId: 'stop_user_launch_agent', title: 'Stop verified user LaunchAgent', description: 'Boot out one exact loaded user LaunchAgent only after its launchd identity matches the expected program.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: true, scopes: ['local-system.process'], resourceClaims: controllerWrite, argumentsSchema: { type: 'object', properties: { label: { type: 'string' }, expected_program_contains: { type: 'string' } }, required: ['label', 'expected_program_contains'], additionalProperties: false } },
    { actionId: 'start_user_launch_agent', title: 'Start verified user LaunchAgent', description: 'Bootstrap or start one exact current-user LaunchAgent from ~/Library/LaunchAgents only after the installed plist matches the expected program identity.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: true, scopes: ['local-system.process'], resourceClaims: controllerWrite, argumentsSchema: { type: 'object', properties: { label: { type: 'string' }, expected_program_contains: { type: 'string' } }, required: ['label', 'expected_program_contains'], additionalProperties: false } },
    { actionId: 'open_application', title: 'Open application', description: 'Open one macOS application by name or bundle id.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false, scopes: ['local-system.open'], resourceClaims: controllerWrite, argumentsSchema: { type: 'object', properties: { app_name: { type: 'string' }, bundle_id: { type: 'string' } }, additionalProperties: false } },
    { actionId: 'list_targets', title: 'List filesystem targets', description: 'List active expiring local filesystem grants.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 10_000, cancellable: true, idempotent: true, scopes: ['local-system.files.read'], resourceClaims: controllerRead, argumentsSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { actionId: 'authorize_target', title: 'Authorize filesystem target', description: 'Authorize an expiring filesystem target. By default, a path inside a Git project authorizes the whole project/repository root; use scope=directory only when intentionally granting a narrower directory.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 15_000, cancellable: true, idempotent: true, scopes: ['local-system.files.write'], resourceClaims: controllerWrite, argumentsSchema: { type: 'object', properties: { target_key: { type: 'string' }, root_path: { type: 'string' }, scope: { type: 'string', enum: ['auto', 'project', 'directory'] }, expires_in_minutes: { type: 'number' }, reason: { type: 'string' }, access: { type: 'string', enum: ['read_only', 'read_write'] } }, required: ['target_key', 'root_path', 'reason'], additionalProperties: false } },
    { actionId: 'revoke_target', title: 'Revoke filesystem target', description: 'Immediately revoke one active filesystem target owned by the authenticated caller.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 15_000, cancellable: true, idempotent: false, scopes: ['local-system.files.write'], resourceClaims: controllerWrite, argumentsSchema: { type: 'object', properties: { target_key: { type: 'string' } }, required: ['target_key'], additionalProperties: false } },
    { actionId: 'list_directory', title: 'List directory', description: 'List a bounded directory snapshot below an authorized target.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 15_000, cancellable: true, idempotent: true, scopes: ['local-system.files.read'], resourceClaims: controllerRead, argumentsSchema: { type: 'object', properties: targetProperties, required: ['target_key'], additionalProperties: false } },
    { actionId: 'read_text', title: 'Read text file', description: 'Read a bounded UTF-8 text file below an authorized target.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 15_000, cancellable: true, idempotent: true, scopes: ['local-system.files.read'], resourceClaims: controllerRead, argumentsSchema: { type: 'object', properties: { ...targetProperties, max_chars: { type: 'number' } }, required: ['target_key', 'path'], additionalProperties: false } },
    { actionId: 'write_text', title: 'Write text file', description: 'Create or explicitly overwrite one bounded UTF-8 text file below an authorized read-write target.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 15_000, cancellable: true, idempotent: true, scopes: ['local-system.files.write'], resourceClaims: controllerWrite, argumentsSchema: { type: 'object', properties: { ...targetProperties, content: { type: 'string' }, overwrite: { type: 'boolean' } }, required: ['target_key', 'path', 'content'], additionalProperties: false } },
    { actionId: 'delete_file', title: 'Delete file', description: 'Delete one exact regular file below an authorized read-write target. Arbitrary recursive or directory deletion is never exposed.', readOnly: false, risk: 'destructive', confirmation: 'strong_confirmation', requiredConfirmationText: 'delete-local-system-file', defaultTimeoutMs: 15_000, cancellable: true, idempotent: false, scopes: ['local-system.files.write'], resourceClaims: controllerWrite, argumentsSchema: { type: 'object', properties: targetProperties, required: ['target_key', 'path'], additionalProperties: false } },
    { actionId: 'initialize_git', title: 'Initialize local Git repository', description: 'Run only git init inside an authorized read-write target without registering it in Repository Registry.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: true, scopes: ['local-system.files.write'], resourceClaims: controllerWrite, argumentsSchema: { type: 'object', properties: { target_key: { type: 'string' }, cwd: { type: 'string' }, initial_branch: { type: 'string' } }, required: ['target_key'], additionalProperties: false } },
    { actionId: 'execute_command', title: 'Execute target command', description: 'Execute one bounded typed-argv command inside an authorized target without repository registration. Shell strings, target escapes, destructive/remote writes, and Git mutations other than the dedicated initialize_git action are denied.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false, scopes: ['local-system.files.read', 'local-system.files.write'], resourceClaims: controllerWrite, argumentsSchema: { type: 'object', properties: { target_key: { type: 'string' }, command: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, max_output_bytes: { type: 'number' } }, required: ['target_key', 'command'], additionalProperties: false } },
    { actionId: 'execute_project_script', title: 'Execute verified project script', description: 'Execute one exact script below an authorized read-write target through a fixed interpreter after its SHA-256 digest and strong confirmation match. Eval flags and shell command strings are never accepted.', readOnly: false, risk: 'destructive', confirmation: 'strong_confirmation', requiredConfirmationText: 'execute-local-system-project-script', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false, scopes: ['local-system.files.read', 'local-system.files.write'], resourceClaims: controllerWrite, argumentsSchema: { type: 'object', properties: { target_key: { type: 'string' }, runtime: { type: 'string', enum: ['node', 'bun', 'python3', 'ruby', 'bash', 'sh'] }, script_path: { type: 'string' }, expected_sha256: { type: 'string' }, arguments: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, max_output_bytes: { type: 'number' } }, required: ['target_key', 'runtime', 'script_path', 'expected_sha256'], additionalProperties: false } },
    { actionId: 'create_directory', title: 'Create directory', description: 'Create a directory below an authorized target without leaving that root.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 15_000, cancellable: true, idempotent: true, scopes: ['local-system.files.write'], resourceClaims: controllerWrite, argumentsSchema: { type: 'object', properties: targetProperties, required: ['target_key', 'path'], additionalProperties: false } },
    { actionId: 'copy_file', title: 'Copy file', description: 'Copy a file between authorized targets without overwriting.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false, scopes: ['local-system.files.write'], resourceClaims: controllerWrite, argumentsSchema: { type: 'object', properties: { source_target_key: { type: 'string' }, source_path: { type: 'string' }, destination_target_key: { type: 'string' }, destination_path: { type: 'string' } }, required: ['source_target_key', 'source_path', 'destination_target_key', 'destination_path'], additionalProperties: false } },
    { actionId: 'move_file', title: 'Move file', description: 'Move a file between authorized targets without overwriting.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false, scopes: ['local-system.files.write'], resourceClaims: controllerWrite, argumentsSchema: { type: 'object', properties: { source_target_key: { type: 'string' }, source_path: { type: 'string' }, destination_target_key: { type: 'string' }, destination_path: { type: 'string' } }, required: ['source_target_key', 'source_path', 'destination_target_key', 'destination_path'], additionalProperties: false } },
    { actionId: 'rename_file', title: 'Rename file', description: 'Rename a file inside one authorized target without overwriting.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false, scopes: ['local-system.files.write'], resourceClaims: controllerWrite, argumentsSchema: { type: 'object', properties: { target_key: { type: 'string' }, source_path: { type: 'string' }, destination_path: { type: 'string' } }, required: ['target_key', 'source_path', 'destination_path'], additionalProperties: false } },
    { actionId: 'reveal_in_finder', title: 'Reveal in Finder', description: 'Reveal an authorized file or directory in Finder.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false, scopes: ['local-system.open'], resourceClaims: controllerRead, argumentsSchema: { type: 'object', properties: targetProperties, required: ['target_key', 'path'], additionalProperties: false } },
    { actionId: 'open_file', title: 'Open document', description: 'Open one authorized non-executable local document with its default application. Scripts, .command files, packages, disk images, app bundles, and executable files are never auto-opened.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false, scopes: ['local-system.open'], resourceClaims: controllerRead, argumentsSchema: { type: 'object', properties: targetProperties, required: ['target_key', 'path'], additionalProperties: false } },
  ];
}

function health(): AssistantPluginHealth {
  const ready = process.platform === 'darwin';
  return {
    state: ready ? 'ready' : 'degraded',
    checkedAt: now(),
    ready,
    probed: true,
    errors: [],
    warnings: ready ? [] : ['Application opening and macOS diagnostics require macOS.'],
    details: {
      provider: 'local-macos',
      scope: 'controller',
      repositoryRegistrationRequired: false,
      targetAuthority: 'controllerHome/system/local-system/targets.json',
    },
  };
}

function permissions(): AssistantPluginPermissionScope[] {
  return [
    { scope: 'local-system.read', mode: 'read', description: 'Read bounded local process and memory diagnostics.', granted: true, required: true },
    { scope: 'local-system.process', mode: 'write', description: 'Terminate one verified PID or control one verified current-user LaunchAgent after explicit authorization.', granted: true, required: false },
    { scope: 'local-system.open', mode: 'write', description: 'Open applications or authorized files.', granted: true, required: false },
    { scope: 'local-system.files.read', mode: 'read', description: 'Read files only below active target grants.', granted: true, required: false },
    { scope: 'local-system.files.write', mode: 'write', description: 'Create, copy, move, or rename files below active read-write target grants.', granted: true, required: false },
  ];
}

function capabilities(): AssistantPluginCapability[] {
  return [
    { capabilityId: 'local-system-diagnostics', title: 'Local diagnostics', description: 'Inspect CPU, processes, and memory with bounded typed commands.', scopes: ['local-system.read'], actions: ['system_snapshot', 'process_detail'] },
    { capabilityId: 'local-system-process-control', title: 'Verified process lifecycle', description: 'Terminate one verified PID or stop/start/restart one verified macOS user LaunchAgent without exposing arbitrary shell execution.', scopes: ['local-system.process'], actions: ['terminate_process', 'restart_user_launch_agent', 'stop_user_launch_agent', 'start_user_launch_agent'] },
    { capabilityId: 'local-system-open', title: 'Open local applications and files', description: 'Open applications and authorized files without arbitrary shell access.', scopes: ['local-system.open'], actions: ['open_application', 'reveal_in_finder', 'open_file'] },
    { capabilityId: 'local-system-files', title: 'Authorized local files', description: 'Use expiring target grants for bounded local file operations and typed-argv commands without repository registration.', scopes: ['local-system.files.read', 'local-system.files.write'], actions: ['list_targets', 'authorize_target', 'revoke_target', 'list_directory', 'read_text', 'write_text', 'delete_file', 'initialize_git', 'execute_command', 'execute_project_script', 'create_directory', 'copy_file', 'move_file', 'rename_file'] },
  ];
}

export function buildLocalSystemPluginManifest(previousRevision = 0, previousUpdatedAt?: string): AssistantPluginManifest {
  const currentHealth = health();
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    revision: Math.max(1, previousRevision || 1),
    pluginId: PLUGIN_ID,
    provider: 'local-macos',
    displayName: 'Local System Assistant',
    pluginVersion: '1.5.0',
    authority: { strategy: 'derived', duplicateStateAllowed: false, sourceOfTruth: ['controllerHome:system/local-system'] },
    enabled: true,
    lifecycle: { state: currentHealth.ready ? 'enabled' : 'degraded', reason: currentHealth.ready ? 'Local system capabilities are ready.' : currentHealth.warnings[0] },
    health: currentHealth,
    permissions: permissions(),
    capabilities: capabilities(),
    actions: actions(),
    updatedAt: previousUpdatedAt ?? now(),
  };
}

function filePair(
  input: AssistantPluginActionExecutionInput,
  sourceOperation: WorkspaceTargetOperation,
): { source: string; destination: string } {
  const source = resolveTargetPath(
    input,
    requiredString(input.args, 'source_target_key'),
    requiredString(input.args, 'source_path'),
    { mustExist: true, file: true, operation: sourceOperation },
  );
  const destination = resolveTargetPath(
    input,
    requiredString(input.args, 'destination_target_key'),
    requiredString(input.args, 'destination_path'),
    { mustExist: false, operation: 'write' },
  );
  if (existsSync(destination.path)) throw new AssistantPluginError('LOCAL_SYSTEM_DESTINATION_EXISTS', 'Destination already exists; overwrite is not allowed.', { retryable: false });
  mkdirSync(dirname(destination.path), { recursive: true });
  return { source: source.path, destination: destination.path };
}

export async function executeLocalSystemPluginAction(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  switch (input.actionId) {
    case 'system_snapshot': return systemSnapshot();
    case 'process_detail': return processDetail(input.args.pid);
    case 'terminate_process': return terminateVerifiedProcess(input.args.pid, input.args.expected_command_contains);
    case 'restart_user_launch_agent': return restartVerifiedUserLaunchAgent(input.args.label, input.args.expected_program_contains);
    case 'stop_user_launch_agent': return stopVerifiedUserLaunchAgent(input.args.label, input.args.expected_program_contains);
    case 'start_user_launch_agent': return startVerifiedUserLaunchAgent(input.args.label, input.args.expected_program_contains);
    case 'open_application': {
      const appName = optionalString(input.args, 'app_name');
      const bundleId = optionalString(input.args, 'bundle_id');
      if ((!appName && !bundleId) || (appName && bundleId)) {
        throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Provide exactly one of app_name or bundle_id.', { retryable: false });
      }
      const command = bundleId ? ['open', '-b', bundleId] : ['open', '-a', appName as string];
      const opened = run(command[0], command.slice(1));
      if (!opened.ok) throw new AssistantPluginError('LOCAL_SYSTEM_OPEN_FAILED', opened.stderr || opened.stdout, { retryable: true, details: { command } });
      return { opened: true, command };
    }
    case 'list_targets': return { targets: activeTargets(input), repositoryRegistered: false };
    case 'authorize_target': return authorizeTarget(input);
    case 'revoke_target': {
      try {
        const target = revokeWorkspaceTargetGrant(input.controllerHome, {
          targetKey: requiredString(input.args, 'target_key'),
          ownerScope: requestOwnerScope(input),
          now: currentDate(),
        });
        return {
          revoked: true,
          targetKey: target.targetKey,
          workspaceId: target.workspaceId,
          identityFingerprint: target.identityFingerprint,
          repositoryRegistered: false,
        };
      } catch (error) {
        return rethrowTargetError(error);
      }
    }
    case 'list_directory': {
      const resolved = resolveTargetPath(input, requiredString(input.args, 'target_key'), optionalString(input.args, 'path'), { mustExist: true, directory: true });
      const entries = readdirSync(resolved.path, { withFileTypes: true }).slice(0, MAX_DIRECTORY_ENTRIES).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
      }));
      return { targetKey: resolved.target.targetKey, path: resolved.relativePath, entries, truncated: entries.length === MAX_DIRECTORY_ENTRIES };
    }
    case 'read_text': {
      const resolved = resolveTargetPath(input, requiredString(input.args, 'target_key'), requiredString(input.args, 'path'), { mustExist: true, file: true });
      const maxChars = Math.max(1, Math.min(Math.trunc(Number(input.args.max_chars ?? 20_000)), MAX_TEXT_CHARS));
      const content = readFileSync(resolved.path, 'utf8');
      return { targetKey: resolved.target.targetKey, path: resolved.relativePath, content: content.slice(0, maxChars), truncated: content.length > maxChars };
    }
    case 'write_text': {
      const targetKey = requiredString(input.args, 'target_key');
      const content = typeof input.args.content === 'string' ? input.args.content : undefined;
      if (content === undefined) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'content must be a string.', { retryable: false });
      if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_CHARS * 4) {
        throw new AssistantPluginError('LOCAL_SYSTEM_TEXT_TOO_LARGE', `Text writes are limited to ${MAX_TEXT_CHARS * 4} UTF-8 bytes.`, { retryable: false });
      }
      const overwrite = input.args.overwrite === true;
      return await withTargetMutation(input, [targetKey], () => {
        const resolved = resolveTargetPath(input, targetKey, requiredString(input.args, 'path'), { mustExist: false, operation: 'write' });
        if (existsSync(resolved.path) && !overwrite) {
          throw new AssistantPluginError('LOCAL_SYSTEM_DESTINATION_EXISTS', 'Destination already exists; set overwrite=true to replace a text file.', { retryable: false });
        }
        if (existsSync(resolved.path) && !statSync(resolved.path).isFile()) {
          throw new AssistantPluginError('LOCAL_SYSTEM_DESTINATION_EXISTS', 'Destination exists and is not a regular file.', { retryable: false });
        }
        mkdirSync(dirname(resolved.path), { recursive: true });
        writeFileSync(resolved.path, content, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx', mode: 0o600 });
        return { written: true, targetKey: resolved.target.targetKey, workspaceId: resolved.target.workspaceId, path: resolved.relativePath, overwrite, bytes: Buffer.byteLength(content, 'utf8'), repositoryRegistered: false };
      });
    }
    case 'delete_file': {
      const targetKey = requiredString(input.args, 'target_key');
      return await withTargetMutation(input, [targetKey], () => {
        const resolved = resolveTargetPath(input, targetKey, requiredString(input.args, 'path'), {
          mustExist: true,
          file: true,
          operation: 'write',
        });
        unlinkSync(resolved.path);
        return {
          deleted: true,
          targetKey: resolved.target.targetKey,
          workspaceId: resolved.target.workspaceId,
          identityFingerprint: resolved.target.identityFingerprint,
          path: resolved.relativePath,
          repositoryRegistered: false,
        };
      });
    }
    case 'initialize_git': {
      const targetKey = requiredString(input.args, 'target_key');
      const initialBranch = optionalString(input.args, 'initial_branch');
      if (initialBranch && !/^[A-Za-z0-9._/-]+$/.test(initialBranch)) {
        throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'initial_branch contains unsupported characters.', { retryable: false });
      }
      return await withTargetMutation(input, [targetKey], async () => {
        let resolved;
        try {
          resolved = resolveWorkspaceTargetCwd(input.controllerHome, targetKey, requestOwnerScope(input), optionalString(input.args, 'cwd') ?? '.', 'write', currentDate());
        } catch (error) {
          return rethrowTargetError(error);
        }
        const command = ['git', 'init', ...(initialBranch ? ['-b', initialBranch] : [])];
        const canonical = assertRepositoryCommandInputAllowed(command);
        const executed = await runCanonicalCommand(canonical, resolved.path, Math.max(1_000, Math.min(Math.trunc(input.timeoutMs ?? 30_000), 30_000)), MAX_OUTPUT_BYTES, { signal: input.signal });
        if (!executed.ok) {
          throw new AssistantPluginError('LOCAL_SYSTEM_GIT_INIT_FAILED', executed.stderr.trim() || executed.stdout.trim() || `git init exited with code ${executed.exitCode}.`, { retryable: false, details: { exitCode: executed.exitCode } });
        }
        return { initialized: true, targetKey: resolved.target.targetKey, workspaceId: resolved.target.workspaceId, cwd: resolved.relativePath || '.', repositoryRegistered: false, command, stdout: executed.stdout, stderr: executed.stderr };
      });
    }
    case 'execute_command': {
      const targetKey = requiredString(input.args, 'target_key');
      const argv = requiredStringArray(input.args, 'command');
      const canonical = assertRepositoryCommandInputAllowed(argv);
      if (canonical.kind !== 'argv') {
        throw new AssistantPluginError('LOCAL_SYSTEM_COMMAND_TYPED_ARGV_REQUIRED', 'Target commands must use typed argv and cannot use a shell string.', { retryable: false });
      }
      const classification = classifyRepositoryCommand(canonical);
      if (classification.risk === 'remote_write' || classification.risk === 'destructive') {
        throw new AssistantPluginError('LOCAL_SYSTEM_COMMAND_RISK_DENIED', `Target command risk ${classification.risk} is not supported without repository registration.`, { retryable: false });
      }
      const executable = canonical.executable!.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
      if (executable === 'git' && classification.risk !== 'readonly') {
        throw new AssistantPluginError('LOCAL_SYSTEM_GIT_MUTATION_REQUIRES_REPOSITORY', 'Git mutations require a registered repository/checkout so refs and worktree ownership remain fenced.', { retryable: false });
      }
      if (classification.risk === 'workspace_write') {
        const replay = classifyRepositoryCommandReplay(canonical);
        const boundedFilesystemMutation = TARGET_SAFE_FILESYSTEM_MUTATORS.has(executable);
        if (!boundedFilesystemMutation && !replay.replayable) {
          throw new AssistantPluginError(
            'LOCAL_SYSTEM_COMMAND_REPOSITORY_REQUIRED',
            `Target command ${executable || '<unknown>'} has unbounded or unclassified side effects; register/promote the target before executing it.`,
            { retryable: false },
          );
        }
      }
      const operation: WorkspaceTargetOperation = classification.risk === 'readonly' ? 'read' : 'write';
      const execute = async () => {
        let resolved;
        try {
          resolved = resolveWorkspaceTargetCwd(
            input.controllerHome,
            targetKey,
            requestOwnerScope(input),
            optionalString(input.args, 'cwd') ?? '.',
            operation,
            currentDate(),
          );
        } catch (error) {
          return rethrowTargetError(error);
        }
        assertCommandPathOperandsStayInRepository(canonical, resolved.path, resolved.root, []);
        const maxOutputBytes = Math.max(1_024, Math.min(Math.trunc(Number(input.args.max_output_bytes ?? MAX_OUTPUT_BYTES)), 1024 * 1024));
        const timeoutMs = Math.max(1_000, Math.min(Math.trunc(input.timeoutMs ?? 30_000), 30_000));
        const executed = await runCanonicalCommand(canonical, resolved.path, timeoutMs, maxOutputBytes, { signal: input.signal });
        if (!executed.ok) {
          const code = executed.timedOut
            ? 'LOCAL_SYSTEM_COMMAND_TIMED_OUT'
            : executed.cancelled
              ? 'LOCAL_SYSTEM_COMMAND_CANCELLED'
              : 'LOCAL_SYSTEM_COMMAND_FAILED';
          const message = executed.stderr.trim()
            || executed.stdout.trim()
            || `Target command exited with code ${executed.exitCode}.`;
          throw new AssistantPluginError(code, bounded(message, maxOutputBytes).content, {
            retryable: executed.timedOut,
            details: {
              command: argv,
              exitCode: executed.exitCode,
              timedOut: executed.timedOut,
              cancelled: executed.cancelled,
            },
          });
        }
        return {
          targetKey: resolved.target.targetKey,
          workspaceId: resolved.target.workspaceId,
          identityFingerprint: resolved.target.identityFingerprint,
          repositoryRegistered: false,
          cwd: resolved.relativePath || '.',
          command: argv,
          classification,
          ok: executed.ok,
          exitCode: executed.exitCode,
          timedOut: executed.timedOut,
          cancelled: executed.cancelled,
          stdout: executed.stdout,
          stderr: executed.stderr,
        };
      };
      return operation === 'write'
        ? await withTargetMutation(input, [targetKey], execute)
        : await execute();
    }
    case 'execute_project_script': {
      const targetKey = requiredString(input.args, 'target_key');
      const runtime = requiredString(input.args, 'runtime').toLowerCase();
      if (!PROJECT_SCRIPT_RUNTIMES.has(runtime)) {
        throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'runtime is not an approved project-script interpreter.', { retryable: false });
      }
      const expectedSha256 = requiredString(input.args, 'expected_sha256').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
        throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'expected_sha256 must be a 64-character hexadecimal digest.', { retryable: false });
      }
      const scriptArguments = optionalStringArray(input.args, 'arguments');
      return await withTargetMutation(input, [targetKey], async () => {
        const script = resolveTargetPath(input, targetKey, requiredString(input.args, 'script_path'), {
          mustExist: true,
          file: true,
          operation: 'write',
        });
        let cwd;
        try {
          cwd = resolveWorkspaceTargetCwd(
            input.controllerHome,
            targetKey,
            requestOwnerScope(input),
            optionalString(input.args, 'cwd') ?? '.',
            'write',
            currentDate(),
          );
        } catch (error) {
          return rethrowTargetError(error);
        }
        const observedSha256 = createHash('sha256').update(readFileSync(script.path)).digest('hex');
        if (observedSha256 !== expectedSha256) {
          throw new AssistantPluginError(
            'LOCAL_SYSTEM_SCRIPT_DIGEST_MISMATCH',
            'The project script changed after review; provide its current SHA-256 digest before retrying.',
            { retryable: false, details: { targetKey, path: script.relativePath, expectedSha256, observedSha256 } },
          );
        }
        const argv = [projectScriptRuntimePath(runtime), script.path, ...scriptArguments];
        const canonical = assertRepositoryCommandInputAllowed(argv);
        assertCommandPathOperandsStayInRepository(canonical, cwd.path, cwd.root, []);
        const maxOutputBytes = Math.max(1_024, Math.min(Math.trunc(Number(input.args.max_output_bytes ?? MAX_OUTPUT_BYTES)), 1024 * 1024));
        const timeoutMs = Math.max(1_000, Math.min(Math.trunc(input.timeoutMs ?? 30_000), 30_000));
        const executed = await runCanonicalCommand(canonical, cwd.path, timeoutMs, maxOutputBytes, { signal: input.signal });
        if (!executed.ok) {
          const code = executed.timedOut
            ? 'LOCAL_SYSTEM_SCRIPT_TIMED_OUT'
            : executed.cancelled
              ? 'LOCAL_SYSTEM_SCRIPT_CANCELLED'
              : 'LOCAL_SYSTEM_SCRIPT_FAILED';
          throw new AssistantPluginError(
            code,
            bounded(executed.stderr.trim() || executed.stdout.trim() || `Project script exited with code ${executed.exitCode}.`, maxOutputBytes).content,
            { retryable: executed.timedOut, details: { runtime, path: script.relativePath, exitCode: executed.exitCode } },
          );
        }
        return {
          targetKey: script.target.targetKey,
          workspaceId: script.target.workspaceId,
          identityFingerprint: script.target.identityFingerprint,
          repositoryRegistered: false,
          cwd: cwd.relativePath || '.',
          runtime,
          scriptPath: script.relativePath,
          scriptSha256: observedSha256,
          arguments: scriptArguments,
          ok: true,
          exitCode: executed.exitCode,
          timedOut: executed.timedOut,
          cancelled: executed.cancelled,
          stdout: executed.stdout,
          stderr: executed.stderr,
        };
      });
    }
    case 'create_directory': {
      const targetKey = requiredString(input.args, 'target_key');
      return await withTargetMutation(input, [targetKey], () => {
        const resolved = resolveTargetPath(input, targetKey, requiredString(input.args, 'path'), { mustExist: false, operation: 'write' });
        if (existsSync(resolved.path) && !statSync(resolved.path).isDirectory()) throw new AssistantPluginError('LOCAL_SYSTEM_DESTINATION_EXISTS', 'A non-directory already exists at the destination.', { retryable: false });
        mkdirSync(resolved.path, { recursive: true });
        return { created: true, targetKey: resolved.target.targetKey, path: resolved.relativePath };
      });
    }
    case 'copy_file': {
      const sourceTargetKey = requiredString(input.args, 'source_target_key');
      const destinationTargetKey = requiredString(input.args, 'destination_target_key');
      return await withTargetMutation(input, [sourceTargetKey, destinationTargetKey], () => {
        const pair = filePair(input, 'read');
        copyFileSync(pair.source, pair.destination, constants.COPYFILE_EXCL);
        return { copied: true, source: pair.source, destination: pair.destination, overwrite: false };
      });
    }
    case 'move_file': {
      const sourceTargetKey = requiredString(input.args, 'source_target_key');
      const destinationTargetKey = requiredString(input.args, 'destination_target_key');
      return await withTargetMutation(input, [sourceTargetKey, destinationTargetKey], () => {
        const pair = filePair(input, 'write');
        renameSync(pair.source, pair.destination);
        return { moved: true, source: pair.source, destination: pair.destination, overwrite: false };
      });
    }
    case 'rename_file': {
      const targetKey = requiredString(input.args, 'target_key');
      return await withTargetMutation(input, [targetKey], () => {
        const source = resolveTargetPath(input, targetKey, requiredString(input.args, 'source_path'), { mustExist: true, operation: 'write' });
        const destination = resolveTargetPath(input, targetKey, requiredString(input.args, 'destination_path'), { mustExist: false, operation: 'write' });
        if (existsSync(destination.path)) throw new AssistantPluginError('LOCAL_SYSTEM_DESTINATION_EXISTS', 'Destination already exists; overwrite is not allowed.', { retryable: false });
        mkdirSync(dirname(destination.path), { recursive: true });
        renameSync(source.path, destination.path);
        return { renamed: true, source: source.relativePath, destination: destination.relativePath, overwrite: false };
      });
    }
    case 'reveal_in_finder':
    case 'open_file': {
      const resolved = resolveTargetPath(input, requiredString(input.args, 'target_key'), requiredString(input.args, 'path'), { mustExist: true });
      if (input.actionId === 'open_file') {
        const file = statSync(resolved.path);
        const extension = extname(resolved.path).toLowerCase();
        const executable = (file.mode & 0o111) !== 0;
        if (!file.isFile() || executable || AUTO_OPEN_DENIED_EXTENSIONS.has(extension)) {
          throw new AssistantPluginError(
            'LOCAL_SYSTEM_EXECUTABLE_OPEN_DENIED',
            'Executable/script-like files are never auto-opened. Use read_text or reveal_in_finder for inspection, or execute_command with explicit typed argv when execution is intended.',
            { retryable: false, details: { targetKey: resolved.target.targetKey, path: resolved.relativePath, extension, executable } },
          );
        }
      }
      const command = input.actionId === 'reveal_in_finder' ? ['open', '-R', resolved.path] : ['open', resolved.path];
      const opened = run(command[0], command.slice(1));
      if (!opened.ok) throw new AssistantPluginError('LOCAL_SYSTEM_OPEN_FAILED', opened.stderr || opened.stdout, { retryable: true, details: { command } });
      return { opened: true, targetKey: resolved.target.targetKey, path: resolved.relativePath, command };
    }
    default:
      throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', `local_system/${input.actionId} is not supported.`, { retryable: false });
  }
}

export const localSystemPluginAdapter = {
  pluginId: PLUGIN_ID,
  scope: 'controller' as const,
  buildManifest: buildLocalSystemPluginManifest,
  executeAction: executeLocalSystemPluginAction,
};
