import { appendFileSync, closeSync, mkdirSync, openSync } from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { dirname, join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { loadLocalBridgeConfig } from '../../cli/local-bridge/job-store';
import { loadMcpServiceLocalConfig } from '../../cli/mcp/auth';
import { ensureSlotHome, readActiveSlotAuthority, readSlotIdentity, type RuntimeSlotId } from '../../cli/controller/runtime-slots';
import { readWriterAuthority } from '../../cli/controller/stable-state/writer-authority';
import { terminateProcessTree } from '../shared/process-tree';
import { captureProcessIdentity, defaultProcessIdentityProbe, executableFingerprint, newProcessInstanceId, processIdentityMatches, type ProcessIdentityProbe } from './identity';
import type { ProcessIdentity, SupervisorComponentName } from './types';

export interface SupervisorProcessManagerOptions {
  repoRoot: string;
  controllerHome: string;
  ownerEpoch: number;
  runtimeSourceRoot: string;
  runtimeExecutable?: string;
  daemonExecutable?: string;
  releasePath?: string;
  releaseRevision?: string;
  logPath: string;
  stableIngressHost?: string;
  stableIngressPort?: number;
  gatewayPortOffset?: number;
  slot?: RuntimeSlotId;
  identityProbe?: ProcessIdentityProbe;
}

export interface SpawnedSupervisorProcess {
  identity: ProcessIdentity;
  child?: ChildProcess;
  command: string;
  args: string[];
  component: SupervisorComponentName;
  home: string;
}

export type ProcessObservation = 'alive' | 'dead' | 'unknown';

export interface SupervisorProcessStopContext {
  reason: string;
  operationId?: string;
  component?: SupervisorComponentName;
}

export interface StaleSlotDaemonCleanupResult {
  inspected: number;
  matched: number;
  stopped: number;
  refused: number;
  failed: number;
  errors: string[];
}

export function supervisorProcessStopAuditPath(logPath: string): string {
  return join(dirname(resolve(logPath)), 'process-stops.jsonl');
}

function boundedAuditText(value: string | undefined, fallback: string): string {
  return (value?.replace(/\s+/g, ' ').trim() || fallback).slice(0, 300);
}

function appendSupervisorProcessStopAudit(
  logPath: string,
  identity: ProcessIdentity,
  context: SupervisorProcessStopContext,
  phase: 'requested' | 'completed' | 'refused',
  detail: Record<string, unknown> = {},
): void {
  try {
    const path = supervisorProcessStopAuditPath(logPath);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      at: new Date().toISOString(),
      phase,
      reason: boundedAuditText(context.reason, 'unspecified_supervisor_stop'),
      ...(context.operationId ? { operationId: boundedAuditText(context.operationId, 'unknown') } : {}),
      component: context.component ?? 'unknown',
      pid: identity.pid,
      instanceId: identity.instanceId,
      controllerHome: identity.controllerHome,
      ...(identity.slot ? { slot: identity.slot } : {}),
      ...(identity.generation ? { generation: identity.generation } : {}),
      ...(identity.releaseRevision ? { releaseRevision: identity.releaseRevision } : {}),
      ownerEpoch: identity.ownerEpoch,
      ...detail,
    })}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Stop audit is best-effort evidence and must not block identity-safe cleanup.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function configuredRuntimeSourceRoot(input: string): string {
  return resolve(input);
}

function componentHome(baseHome: string, slot: RuntimeSlotId | undefined, explicitSlot = false): string {
  if (!slot) return resolve(baseHome);
  const identity = readSlotIdentity(baseHome, slot);
  if (identity?.slotHome) return resolve(identity.slotHome);
  return explicitSlot ? ensureSlotHome(baseHome, slot) : resolve(baseHome);
}

function processCommand(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

function tokenizeProcessCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function commandOptionValue(tokens: string[], option: string): string | undefined {
  const index = tokens.indexOf(option);
  if (index < 0) return undefined;
  const value = tokens[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function commandOptionNumber(tokens: string[], option: string): number | undefined {
  const value = commandOptionValue(tokens, option);
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function commandTargetsDaemon(tokens: string[]): boolean {
  return tokens.some((token) => (
    token.endsWith('/daemon.js')
    || token.endsWith('/daemon-entry.ts')
    || token.endsWith('/daemon-entry.js')
    || token === 'daemon.js'
    || token === 'daemon-entry.ts'
    || token === 'daemon-entry.js'
  ));
}

export function runtimeWriterEnvironment(controllerHome: string, slot: RuntimeSlotId): NodeJS.ProcessEnv {
  const authority = readWriterAuthority(controllerHome);
  if (!authority) return {};
  const passive = authority.activeSlot !== slot;
  // Passive candidates still inherit a complete claim so they can prove
  // process and Gateway readiness. The explicit passive marker prevents the
  // daemon from running startup reconciliation, cleanup, Scheduler, Workers,
  // or any other mutation loop before authority cutover.
  return {
    REPO_HARNESS_WRITER_SLOT: slot,
    REPO_HARNESS_WRITER_EPOCH: authority.epoch,
    REPO_HARNESS_WRITER_FENCING_TOKEN: authority.fencingToken,
    REPO_HARNESS_RUNTIME_PASSIVE: passive ? '1' : '0',
    ...(authority.generation ? { REPO_HARNESS_WRITER_GENERATION: authority.generation } : {}),
  };
}

export class SupervisorProcessManager {
  readonly options: SupervisorProcessManagerOptions;
  private readonly probe: ProcessIdentityProbe;

  constructor(options: SupervisorProcessManagerOptions) {
    this.options = { ...options, repoRoot: resolve(options.repoRoot), controllerHome: resolve(options.controllerHome) };
    this.probe = options.identityProbe ?? defaultProcessIdentityProbe;
  }

  private runtimeCli(): string {
    return this.options.runtimeExecutable ?? join(configuredRuntimeSourceRoot(this.options.runtimeSourceRoot), 'src', 'cli', 'index.ts');
  }

  private runtimeDaemon(): string {
    return this.options.daemonExecutable ?? join(configuredRuntimeSourceRoot(this.options.runtimeSourceRoot), 'src', 'runtime', 'control-plane', 'daemon-entry.ts');
  }

  gatewayBinding(slot = this.options.slot ?? readActiveSlotAuthority(this.options.controllerHome).activeSlot): { host: string; port: number } {
    const stablePort = this.options.stableIngressPort ?? 8765;
    const offset = this.options.gatewayPortOffset ?? 20;
    return {
      // Slot backends are never public listeners. Stable ingress is the only
      // binding that may follow the configured LAN/public host.
      host: '127.0.0.1',
      port: stablePort + offset + (slot === 'green' ? 10 : 0),
    };
  }

  localControllerBinding(slot = this.options.slot ?? readActiveSlotAuthority(this.options.controllerHome).activeSlot): { host: string; port: number } {
    const gateway = this.gatewayBinding(slot);
    return {
      host: '127.0.0.1',
      // Keep every slot-local UI away from the legacy/root Local Bridge port
      // (8766) and adjacent to its private Gateway backend.
      port: gateway.port + 1,
    };
  }

  private spawnDetached(component: SupervisorComponentName, home: string, args: string[], instanceId: string, slot: RuntimeSlotId): SpawnedSupervisorProcess {
    const command = process.execPath;
    mkdirSync(dirname(this.options.logPath), { recursive: true });
    const fd = openSync(this.options.logPath, 'a');
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: this.options.repoRoot,
        detached: true,
        stdio: ['ignore', fd, fd],
        env: {
          ...process.env,
          REPO_HARNESS_CONTROLLER_HOME: home,
          REPO_HARNESS_CONTROLLER_LIFECYCLE_OWNER: '1',
          REPO_HARNESS_SUPERVISOR_CHILD: '1',
          REPO_HARNESS_SUPERVISOR_EPOCH: String(this.options.ownerEpoch),
          REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT: this.options.runtimeSourceRoot,
          REPO_HARNESS_DAEMON_INSTANCE_ID: instanceId,
          REPO_HARNESS_RUNTIME_SLOT: slot,
          ...runtimeWriterEnvironment(this.options.controllerHome, slot),
        },
      });
      child.unref();
    } finally {
      closeSync(fd);
    }
    if (!child.pid) throw new Error(`SUPERVISOR_${component.toUpperCase()}_SPAWN_FAILED`);
    const commandText = processCommand(command, args);
    return {
      identity: {
        pid: child.pid,
        instanceId,
        processStartTime: new Date().toISOString(),
        executableFingerprint: executableFingerprint(commandText),
        controllerHome: home,
        slot,
        ...(this.options.releasePath ? { releasePath: resolve(this.options.releasePath) } : {}),
        ...(this.options.releaseRevision ? { releaseRevision: this.options.releaseRevision } : {}),
        ownerEpoch: this.options.ownerEpoch,
      },
      child,
      command,
      args,
      component,
      home,
    };
  }

  private async identify(spawned: SpawnedSupervisorProcess): Promise<SpawnedSupervisorProcess> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const identity = captureProcessIdentity(spawned.identity.pid, {
        controllerHome: spawned.identity.controllerHome,
        instanceId: spawned.identity.instanceId,
        ...(spawned.identity.slot ? { slot: spawned.identity.slot } : {}),
        ...(spawned.identity.releasePath ? { releasePath: spawned.identity.releasePath } : {}),
        ...(spawned.identity.releaseRevision ? { releaseRevision: spawned.identity.releaseRevision } : {}),
        ownerEpoch: spawned.identity.ownerEpoch,
      }, this.probe);
      if (identity) return { ...spawned, identity };
      if (!spawned.child?.pid || !this.probe.isAlive(spawned.child.pid)) {
        try { spawned.child?.kill('SIGTERM'); } catch { /* child may have already exited */ }
        throw new Error(`SUPERVISOR_${spawned.component.toUpperCase()}_PROCESS_DIED`);
      }
      await sleep(25);
    }
    // Identity probe fully exhausted but the child is still alive (e.g. ps
    // unavailable due to system restrictions). Accept the pre-populated
    // identity from spawnDetached so the Supervisor can proceed.
    return spawned;
  }

  async startDaemon(): Promise<SpawnedSupervisorProcess> {
    const slot = this.options.slot ?? readActiveSlotAuthority(this.options.controllerHome).activeSlot;
    const home = componentHome(this.options.controllerHome, slot, this.options.slot !== undefined);
    const instanceId = newProcessInstanceId('daemon');
    const args = [
      this.runtimeDaemon(),
      '--controller-home', home,
      '--runtime-source-root', this.options.runtimeSourceRoot,
      '--owner-epoch', String(this.options.ownerEpoch),
      '--instance-id', instanceId,
      '--slot', slot,
    ];
    return this.identify(this.spawnDetached('controllerDaemon', home, args, instanceId, slot));
  }

  gatewayArgs(home: string, slot = this.options.slot ?? readActiveSlotAuthority(this.options.controllerHome).activeSlot): string[] {
    const localConfig = loadMcpServiceLocalConfig(home, this.options.repoRoot);
    const bridge = loadLocalBridgeConfig(this.options.repoRoot);
    const binding = this.gatewayBinding(slot);
    const host = binding.host;
    const port = binding.port;
    const profile = localConfig?.profile ?? 'controller';
    const auth = localConfig?.auth?.mode ?? 'oauth';
    const toolset = localConfig?.toolset ?? 'advanced';
    const localHost = localConfig?.localController?.host ?? bridge.host ?? '127.0.0.1';
    const localPort = localConfig?.localController?.port ?? bridge.port ?? 8766;
    const publicEndpoint = localConfig?.chatgpt?.endpoint;
    // The stable Supervisor owns the public ingress. Gateway hosts bind private
    // backend ports and must never create a competing tunnel lifecycle owner.
    const tunnelMode = 'none';
    const args = [
      this.runtimeCli(), 'mcp', 'keepalive',
      '--repo', this.options.repoRoot,
      '--controller-home', home,
      '--host', host,
      '--port', String(port),
      '--profile', profile,
      '--auth', auth,
      '--toolset', toolset,
      '--local-ui',
      '--local-ui-host', localHost,
      '--local-ui-port', String(localPort),
      '--tunnel', tunnelMode,
    ];
    if (publicEndpoint) args.push('--public-endpoint', publicEndpoint);
    if (localConfig?.devMode?.agentRunner) {
      args.push('--enable-dev-runner');
      if (localConfig.devMode.allowedAgents?.length) args.push('--dev-runner-agents', localConfig.devMode.allowedAgents.join(','));
      if (localConfig.devMode.timeoutMs) args.push('--dev-runner-timeout-ms', String(localConfig.devMode.timeoutMs));
      if (localConfig.devMode.maxTimeoutMs) args.push('--dev-runner-max-timeout-ms', String(localConfig.devMode.maxTimeoutMs));
    }
    return args;
  }

  async startGateway(): Promise<SpawnedSupervisorProcess> {
    const activeSlot = this.options.slot ?? readActiveSlotAuthority(this.options.controllerHome).activeSlot;
    const home = componentHome(this.options.controllerHome, activeSlot, this.options.slot !== undefined);
    const instanceId = newProcessInstanceId('gateway');
    return this.identify(this.spawnDetached('gatewayHost', home, this.gatewayArgs(home, activeSlot), instanceId, activeSlot));
  }

  observe(identity: ProcessIdentity | undefined): ProcessObservation {
    if (!identity || !this.probe.isAlive(identity.pid)) return 'dead';
    const command = this.probe.command(identity.pid);
    const startTime = this.probe.startTime(identity.pid);
    // When the OS probe is unavailable (e.g. restricted ps), accept the
    // isAlive check as sufficient evidence.  Return 'alive' so the Supervisor
    // can continue monitoring and recovery; the pre-populated spawn identity
    // carries the authoritative PID/start-time/fingerprint.
    if (!command || !startTime) return 'alive';
    return processIdentityMatches(identity, identity.pid, this.probe).matches ? 'alive' : 'unknown';
  }

  processCommandMatches(identity: ProcessIdentity | undefined, executablePaths: string[]): boolean {
    if (!identity || !this.probe.isAlive(identity.pid)) return false;
    const command = this.probe.command(identity.pid);
    // When the OS probe is unavailable, accept any alive process as matching.
    if (!command) return true;
    return executablePaths.some((path) => command.includes(resolve(path)));
  }

  async cleanupStaleSlotDaemons(
    slot = this.options.slot ?? readActiveSlotAuthority(this.options.controllerHome).activeSlot,
    context: Omit<SupervisorProcessStopContext, 'component'> = { reason: 'stale_slot_daemon_cleanup' },
  ): Promise<StaleSlotDaemonCleanupResult> {
    const result: StaleSlotDaemonCleanupResult = {
      inspected: 0,
      matched: 0,
      stopped: 0,
      refused: 0,
      failed: 0,
      errors: [],
    };
    const entries = this.probe.listProcesses?.() ?? [];
    const targetHome = componentHome(this.options.controllerHome, slot, true);
    for (const entry of entries) {
      if (entry.pid === process.pid) continue;
      result.inspected += 1;
      const tokens = tokenizeProcessCommand(entry.command);
      const commandHome = commandOptionValue(tokens, '--controller-home');
      if (!commandHome || resolve(commandHome) !== targetHome) continue;
      const commandSlot = commandOptionValue(tokens, '--slot');
      if (commandSlot !== slot) continue;
      result.matched += 1;

      const ownerEpoch = commandOptionNumber(tokens, '--owner-epoch');
      const startTime = this.probe.startTime(entry.pid);
      const instanceId = commandOptionValue(tokens, '--instance-id') ?? newProcessInstanceId('stale-daemon');
      const identity: ProcessIdentity = {
        pid: entry.pid,
        instanceId,
        processStartTime: startTime ?? 'unknown',
        executableFingerprint: executableFingerprint(entry.command),
        controllerHome: targetHome,
        slot,
        ownerEpoch: ownerEpoch ?? this.options.ownerEpoch,
      };

      if (!this.probe.isAlive(entry.pid)) continue;
      if (!commandTargetsDaemon(tokens) || ownerEpoch === undefined || !startTime) {
        result.refused += 1;
        appendSupervisorProcessStopAudit(this.options.logPath, identity, {
          ...context,
          component: 'controllerDaemon',
        }, 'refused', {
          observation: 'alive',
          stopped: false,
          error: !commandTargetsDaemon(tokens)
            ? 'SUPERVISOR_STALE_SLOT_DAEMON_COMMAND_MISMATCH'
            : ownerEpoch === undefined
              ? 'SUPERVISOR_STALE_SLOT_DAEMON_OWNER_EPOCH_MISSING'
              : 'SUPERVISOR_STALE_SLOT_DAEMON_START_TIME_MISSING',
          command: boundedAuditText(entry.command, 'unknown'),
        });
        continue;
      }
      if (ownerEpoch >= this.options.ownerEpoch) continue;

      try {
        const stopped = await this.stop(identity, {
          ...context,
          component: 'controllerDaemon',
        });
        if (stopped.stopped) {
          result.stopped += 1;
        } else {
          result.failed += 1;
          result.errors.push(`pid=${entry.pid}: stop incomplete`);
        }
      } catch (error) {
        result.failed += 1;
        result.errors.push(`pid=${entry.pid}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  }

  async stop(
    identity: ProcessIdentity | undefined,
    context: SupervisorProcessStopContext = { reason: 'unspecified_supervisor_stop' },
  ): Promise<{ stopped: boolean; observation: ProcessObservation }> {
    const observation = this.observe(identity);
    if (!identity) return { stopped: true, observation };
    appendSupervisorProcessStopAudit(this.options.logPath, identity, context, 'requested', { observation });
    if (observation === 'dead') {
      appendSupervisorProcessStopAudit(this.options.logPath, identity, context, 'completed', {
        observation,
        stopped: true,
        alreadyDead: true,
      });
      return { stopped: true, observation };
    }
    // When the OS probe is unavailable, observe returns 'alive' after
    // verifying liveness.  Proceed with termination.
    if (observation === 'unknown') {
      appendSupervisorProcessStopAudit(this.options.logPath, identity, context, 'refused', {
        observation,
        stopped: false,
        error: 'SUPERVISOR_PROCESS_IDENTITY_MISMATCH',
      });
      throw new Error(`SUPERVISOR_PROCESS_IDENTITY_MISMATCH: refusing to terminate pid=${identity.pid}`);
    }
    const result = await terminateProcessTree(identity.pid, { gracePeriodMs: 1_500, killAfterMs: 8_000, pollIntervalMs: 100 });
    appendSupervisorProcessStopAudit(this.options.logPath, identity, context, 'completed', {
      observation: result.exited ? 'dead' : 'unknown',
      stopped: result.exited,
      signaled: result.signaled,
      escalated: result.escalated,
      remainingPids: result.remainingPids.slice(0, 20),
    });
    return { stopped: result.exited, observation: result.exited ? 'dead' : 'unknown' };
  }
}
