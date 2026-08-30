import { randomUUID } from 'crypto';
import { statSync } from 'fs';
import { dirname } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ControlPlaneDatabaseInspection } from '../control-plane/persistence/sqlite-store';
import { inspectControlPlaneDatabase } from '../control-plane/persistence/sqlite-store';
import { activateExclusiveWorkAdmission } from '../control-plane/facade/work-admission-policy';
import { closeCodeGraphReadProviderSessions } from '../context/codegraph-read-provider';
import { cancelAllLightweightProcesses } from '../execution/process-runtime/lightweight-managed';
import {
  collectRuntimeSourceIdentity,
  rotateRuntimeGeneration,
} from '../control-plane/runtime-generation';
import { RuntimeControllerServices } from './controller-services';
import { createRuntimeGatewayServer, runtimeGatewayToolSurfaceFingerprint } from './gateway-adapter';
import { startRuntimeMcpTransport, type RuntimeMcpTransportHandle } from './mcp-transport';
import { acquireRuntimeOwnership, type RuntimeOwnershipHandle } from './ownership';
import { RuntimeReadinessState } from './readiness';
import { loadRuntimeReleaseManifest } from './release-manifest';
import { ensureActiveRuntimeRelease, readRuntimeReleaseAuthority, type RuntimeReleaseAuthority } from './release-store';
import { bindRuntimeWriteClaim, clearRuntimeWriteClaim } from './write-fence';
import { startInProcessScheduler, type RuntimeSchedulerHandle } from './scheduler';
import { startConfiguredRuntimeLocalBridge, type RuntimeLocalBridgeHandle } from './local-bridge';
import { removeRuntimeStatusSnapshot, writeRuntimeStatusSnapshot } from './status';
import type {
  CanonicalRuntimeConfig,
  RuntimeExitEvidence,
  RuntimeReadiness,
  RuntimeReleaseManifest,
} from './types';

export interface RuntimeReleaseAuthorityMonitor {
  stop(): void;
}

export interface CanonicalRuntimeDependencies {
  loadReleaseManifest(path: string, controllerHome: string): RuntimeReleaseManifest;
  ensureReleaseAuthority(controllerHome: string, manifestPath: string): RuntimeReleaseAuthority;
  readReleaseAuthority(controllerHome: string): RuntimeReleaseAuthority | undefined;
  startReleaseAuthorityMonitor(observe: () => void): RuntimeReleaseAuthorityMonitor;
  bindWriteClaim(input: { controllerHome: string; owner: RuntimeOwnershipHandle['record']; authority: RuntimeReleaseAuthority }): void;
  acquireOwnership(controllerHome: string, runtimeInstanceId: string): RuntimeOwnershipHandle;
  inspectDatabase(controllerHome: string): ControlPlaneDatabaseInspection;
  startScheduler(controllerHome: string, timeoutMs?: number): RuntimeSchedulerHandle;
  startLocalBridge(input: { controllerHome: string; repositoryRoot: string }): Promise<RuntimeLocalBridgeHandle | undefined>;
  startTransport(options: Parameters<typeof startRuntimeMcpTransport>[0]): Promise<RuntimeMcpTransportHandle>;
  runMcpProbe(endpoint: string, authToken: string): Promise<void>;
  collectRuntimeSourceIdentity: typeof collectRuntimeSourceIdentity;
  rotateRuntimeGeneration: typeof rotateRuntimeGeneration;
  stopLightweightProcesses(controllerHome: string): Promise<number>;
  stopContextReadHelpers(): Promise<void>;
  computeToolSurfaceFingerprint: typeof runtimeGatewayToolSurfaceFingerprint;
}

async function defaultMcpProbe(endpoint: string, authToken: string): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${authToken}` } },
  });
  const client = new Client({ name: 'forge-runtime-probe', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === 'repository_list')) {
      throw new Error('MCP_PROBE_TOOL_MISSING: repository_list');
    }
    // Probe a permanent bootstrap tool that is valid before any repository is
    // selected or registered. Database initialization has already failed closed
    // earlier in Runtime startup; this probe owns only MCP initialize/list/call.
    const result = await client.callTool({ name: 'repository_list', arguments: {} });
    if (result.isError || !result.structuredContent) {
      throw new Error('MCP_PROBE_BOOTSTRAP_CALL_FAILED');
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

const DEFAULT_RELEASE_AUTHORITY_MONITOR_INTERVAL_MS = 1_000;

function startDefaultReleaseAuthorityMonitor(observe: () => void): RuntimeReleaseAuthorityMonitor {
  const timer = setInterval(observe, DEFAULT_RELEASE_AUTHORITY_MONITOR_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

const DEFAULT_DEPENDENCIES: CanonicalRuntimeDependencies = {
  loadReleaseManifest: loadRuntimeReleaseManifest,
  ensureReleaseAuthority: ensureActiveRuntimeRelease,
  readReleaseAuthority: readRuntimeReleaseAuthority,
  startReleaseAuthorityMonitor: startDefaultReleaseAuthorityMonitor,
  bindWriteClaim: (input) => { bindRuntimeWriteClaim(input); },
  acquireOwnership: acquireRuntimeOwnership,
  inspectDatabase: inspectControlPlaneDatabase,
  startScheduler: startInProcessScheduler,
  startLocalBridge: startConfiguredRuntimeLocalBridge,
  startTransport: startRuntimeMcpTransport,
  runMcpProbe: defaultMcpProbe,
  collectRuntimeSourceIdentity,
  rotateRuntimeGeneration,
  stopLightweightProcesses: cancelAllLightweightProcesses,
  stopContextReadHelpers: closeCodeGraphReadProviderSessions,
  computeToolSurfaceFingerprint: runtimeGatewayToolSurfaceFingerprint,
};

export class CanonicalForgeRuntime {
  readonly runtimeInstanceId: string;
  private readonly readinessState = new RuntimeReadinessState();
  private readonly dependencies: CanonicalRuntimeDependencies;
  private ownership?: RuntimeOwnershipHandle;
  private scheduler?: RuntimeSchedulerHandle;
  private localBridge?: RuntimeLocalBridgeHandle;
  private toolSurfaceFingerprint?: string;
  private transport?: RuntimeMcpTransportHandle;
  private controller?: RuntimeControllerServices;
  private release?: RuntimeReleaseManifest;
  private releaseAuthorityMonitor?: RuntimeReleaseAuthorityMonitor;
  private stopPromise?: Promise<void>;
  private stoppedResolve!: () => void;
  private readonly stopped = new Promise<void>((resolve) => { this.stoppedResolve = resolve; });
  private started = false;
  private stopping = false;
  lastExit?: RuntimeExitEvidence;

  constructor(
    readonly config: CanonicalRuntimeConfig,
    dependencies: Partial<CanonicalRuntimeDependencies> = {},
  ) {
    this.runtimeInstanceId = config.runtimeInstanceId?.trim() || `runtime_${randomUUID().replaceAll('-', '')}`;
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    if (!config.controllerHome.trim()) throw new Error('RUNTIME_CONFIG_REQUIRED: controllerHome');
    if (!config.repositoryRoot.trim()) throw new Error('RUNTIME_CONFIG_REQUIRED: repositoryRoot');
    try {
      if (!statSync(config.repositoryRoot).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new Error('RUNTIME_CONFIG_INVALID: repositoryRoot must be an existing directory');
    }
    if (!config.releaseManifestPath.trim()) throw new Error('RUNTIME_CONFIG_REQUIRED: releaseManifestPath');
    if (!config.host.trim()) throw new Error('RUNTIME_CONFIG_REQUIRED: host');
    if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65_535) {
      throw new Error('RUNTIME_CONFIG_INVALID: port');
    }
    if (!config.authToken.trim()) throw new Error('RUNTIME_CONFIG_REQUIRED: authToken');
  }

  readiness(): RuntimeReadiness {
    return this.readinessState.snapshot();
  }

  private publishStatus(): void {
    if (!this.ownership || !this.release) return;
    try {
      writeRuntimeStatusSnapshot(this.config.controllerHome, {
        schemaVersion: 1,
        runtimeInstanceId: this.runtimeInstanceId,
        pid: this.ownership.record.pid,
        releaseId: this.release.releaseId,
        artifactIdentity: this.release.artifactIdentity,
        ...(this.toolSurfaceFingerprint ? { toolSurfaceFingerprint: this.toolSurfaceFingerprint } : {}),
        ...(this.transport?.endpoint ? { endpoint: this.transport.endpoint } : {}),
        readiness: this.readiness(),
        startedAt: this.ownership.record.acquiredAt,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // Status is a read-only projection. Projection failure cannot become a
      // second Runtime readiness or lifecycle authority.
    }
  }

  private refreshToolSurfaceFingerprint(runtimeSourceRoot: string): void {
    const next = this.dependencies.computeToolSurfaceFingerprint({
      controllerHome: this.config.controllerHome,
      runtimeInstanceId: this.runtimeInstanceId,
      runtimeSourceRoot,
    });
    if (next === this.toolSurfaceFingerprint) return;
    this.toolSurfaceFingerprint = next;
    this.publishStatus();
  }

  endpoint(): string | undefined {
    return this.transport?.endpoint;
  }

  private startReleaseAuthorityMonitor(): void {
    const release = this.release;
    if (!release || this.releaseAuthorityMonitor) return;
    this.releaseAuthorityMonitor = this.dependencies.startReleaseAuthorityMonitor(() => {
      if (this.stopping || this.lastExit) return;
      let authority: RuntimeReleaseAuthority | undefined;
      try {
        authority = this.dependencies.readReleaseAuthority(this.config.controllerHome);
      } catch {
        // A read failure or ambiguous authority is not proof that this Runtime
        // was superseded. Existing write fencing remains authoritative.
        return;
      }
      if (!authority) return;
      const active = authority.active;
      if (
        active.releaseId === release.releaseId
        && active.artifactIdentity === release.artifactIdentity
        && active.workerProtocolVersion === release.workerProtocolVersion
      ) return;
      const reasonCode = 'RUNTIME_RELEASE_SUPERSEDED';
      this.readinessState.setDiagnostic('releaseCoherence', 'fail', reasonCode);
      this.failCore(
        reasonCode,
        `Active Runtime release authority changed from ${release.releaseId}/${release.artifactIdentity} to ${active.releaseId}/${active.artifactIdentity}.`,
      );
    });
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('RUNTIME_ALREADY_STARTED');
    this.started = true;
    this.readinessState.markNotReady();
    let stage: 'release' | 'ownership' | 'source' | 'database' | 'scheduler' | 'localBridge' | 'transport' | 'probe' = 'release';
    try {
      this.release = this.dependencies.loadReleaseManifest(this.config.releaseManifestPath, this.config.controllerHome);

      stage = 'ownership';
      this.ownership = this.dependencies.acquireOwnership(this.config.controllerHome, this.runtimeInstanceId);

      stage = 'release';
      const releaseAuthority = this.dependencies.ensureReleaseAuthority(this.config.controllerHome, this.config.releaseManifestPath);
      stage = 'source';
      // A materialized immutable release carries its frozen source identity in
      // the release manifest and must snapshot that release directory. Source/
      // fixture manifests without source identity keep the historical explicit
      // repositoryRoot behavior so development-mode Runtime drift remains live.
      const runtimeSourceRoot = this.release.sourceCommit && this.release.releaseRevision
        ? dirname(this.config.releaseManifestPath)
        : this.config.repositoryRoot;
      const runtimeSource = this.dependencies.collectRuntimeSourceIdentity(runtimeSourceRoot);
      this.dependencies.rotateRuntimeGeneration(this.config.controllerHome, runtimeSource);

      stage = 'release';
      this.dependencies.bindWriteClaim({
        controllerHome: this.config.controllerHome,
        owner: this.ownership.record,
        authority: releaseAuthority,
      });
      this.readinessState.setDiagnostic('releaseCoherence', 'pass');
      this.publishStatus();

      stage = 'database';
      this.controller = new RuntimeControllerServices(
        this.config.controllerHome,
        this.runtimeInstanceId,
        this.release,
        () => this.readiness(),
        this.dependencies.inspectDatabase,
      );
      this.controller.initialize();
      this.readinessState.setDiagnostic('database', 'pass');
      this.publishStatus();
      if (this.config.exclusiveWorkId) {
        activateExclusiveWorkAdmission(this.config.controllerHome, {
          allowedWorkId: this.config.exclusiveWorkId,
          reason: 'P0 canonical single Runtime migration isolation',
        });
      }

      stage = 'scheduler';
      this.scheduler = this.dependencies.startScheduler(
        this.config.controllerHome,
        this.config.schedulerReadyTimeoutMs,
      );
      await this.scheduler.ready;
      this.readinessState.setDiagnostic('scheduler', 'pass');
      this.publishStatus();
      void this.scheduler.done.then(
        () => this.failCore('SCHEDULER_STOPPED', 'Scheduler stopped while Runtime was active.'),
        (error) => this.failCore('SCHEDULER_STALLED', error instanceof Error ? error.message : String(error)),
      );

      stage = 'localBridge';
      this.localBridge = await this.dependencies.startLocalBridge({
        controllerHome: this.config.controllerHome,
        repositoryRoot: this.config.repositoryRoot,
      });

      stage = 'transport';
      this.refreshToolSurfaceFingerprint(runtimeSourceRoot);
      this.transport = await this.dependencies.startTransport({
        host: this.config.host,
        port: this.config.port,
        authToken: this.config.authToken,
        readiness: () => this.readiness(),
        createServer: (principalId, sessionId, controllerType) => createRuntimeGatewayServer(this.controller!, principalId, {
          controllerHome: this.config.controllerHome,
          runtimeInstanceId: this.runtimeInstanceId,
          runtimeSourceRoot,
          sessionId,
          controllerType,
        }),
        onToolSurfaceObservation: () => this.refreshToolSurfaceFingerprint(runtimeSourceRoot),
        onFatal: (error) => this.failCore('MCP_TRANSPORT_FAILED', error.message),
      });
      this.publishStatus();

      stage = 'probe';
      await this.dependencies.runMcpProbe(this.transport.endpoint, this.config.authToken);
      this.readinessState.setDiagnostic('mcpEndToEnd', 'pass');
      this.readinessState.markReady();
      this.publishStatus();
      stage = 'release';
      this.startReleaseAuthorityMonitor();
    } catch (error) {
      const reason = this.startupReason(stage);
      this.markStartupFailure(stage, reason);
      await this.stop(reason, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private startupReason(stage: string): string {
    if (stage === 'release') return 'RELEASE_COHERENCE_FAILED';
    if (stage === 'ownership') return 'RUNTIME_OWNERSHIP_CONFLICT';
    if (stage === 'source') return 'RUNTIME_SOURCE_SNAPSHOT_FAILED';
    if (stage === 'database') return 'DATABASE_UNAVAILABLE';
    if (stage === 'scheduler') return 'SCHEDULER_INITIALIZATION_FAILED';
    if (stage === 'localBridge') return 'LOCAL_BRIDGE_STARTUP_FAILED';
    if (stage === 'transport') return 'MCP_LISTENER_FAILED';
    return 'MCP_END_TO_END_FAILED';
  }

  private markStartupFailure(stage: string, reason: string): void {
    if (stage === 'release' || stage === 'source') {
      this.readinessState.setDiagnostic('releaseCoherence', 'fail', reason);
    } else if (stage === 'database') this.readinessState.setDiagnostic('database', 'fail', reason);
    else if (stage === 'scheduler') this.readinessState.setDiagnostic('scheduler', 'fail', reason);
    else if (stage === 'transport' || stage === 'probe') this.readinessState.setDiagnostic('mcpEndToEnd', 'fail', reason);
    this.readinessState.addReason(reason);
    this.publishStatus();
  }

  private failCore(reasonCode: string, message: string): void {
    if (this.stopping || this.lastExit) return;
    process.stderr.write(`${JSON.stringify({
      event: 'forge_runtime_core_failure',
      runtimeInstanceId: this.runtimeInstanceId,
      reasonCode,
      message,
      observedAt: new Date().toISOString(),
    })}\n`);
    if (reasonCode.startsWith('SCHEDULER_')) this.readinessState.setDiagnostic('scheduler', 'fail', reasonCode);
    if (reasonCode.startsWith('MCP_')) this.readinessState.setDiagnostic('mcpEndToEnd', 'fail', reasonCode);
    this.readinessState.addReason(reasonCode);
    this.publishStatus();
    void this.stop(reasonCode, message);
  }

  async stop(reasonCode = 'RUNTIME_STOP_REQUESTED', message?: string): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.stopping = true;
      this.readinessState.markNotReady(reasonCode);
      this.publishStatus();
      // Stop the release observer before withdrawing MCP work so no second
      // supersession callback can race the teardown sequence.
      try { this.releaseAuthorityMonitor?.stop(); } catch { /* cleanup is best effort */ }
      this.releaseAuthorityMonitor = undefined;
      // Stop accepting new MCP work before quiescing Scheduler activity, then
      // release the Controller Home claim only after all in-process services stop.
      await this.transport?.close().catch(() => undefined);
      await this.dependencies.stopLightweightProcesses(this.config.controllerHome).catch(() => undefined);
      await this.dependencies.stopContextReadHelpers().catch(() => undefined);
      await this.localBridge?.close().catch(() => undefined);
      await this.scheduler?.stop().catch(() => undefined);
      const ownerPid = this.ownership?.record.pid;
      this.ownership?.release();
      clearRuntimeWriteClaim(this.runtimeInstanceId);
      if (ownerPid !== undefined) {
        removeRuntimeStatusSnapshot(this.config.controllerHome, this.runtimeInstanceId, ownerPid);
      }
      this.lastExit = { reasonCode, observedAt: new Date().toISOString(), ...(message ? { message } : {}) };
      this.stopping = false;
      this.stoppedResolve();
    })();
    return this.stopPromise;
  }

  waitForStopped(): Promise<void> {
    return this.stopped;
  }
}
