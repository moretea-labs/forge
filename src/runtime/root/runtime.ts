import { randomUUID } from 'crypto';
import { statSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ControlPlaneDatabaseInspection } from '../control-plane/persistence/sqlite-store';
import { inspectControlPlaneDatabase } from '../control-plane/persistence/sqlite-store';
import { activateExclusiveWorkAdmission } from '../control-plane/facade/work-admission-policy';
import { RuntimeControllerServices } from './controller-services';
import { createRuntimeGatewayServer } from './gateway-adapter';
import { startRuntimeMcpTransport, type RuntimeMcpTransportHandle } from './mcp-transport';
import { acquireRuntimeOwnership, type RuntimeOwnershipHandle } from './ownership';
import { RuntimeReadinessState } from './readiness';
import { loadRuntimeReleaseManifest } from './release-manifest';
import { startInProcessScheduler, type RuntimeSchedulerHandle } from './scheduler';
import type {
  CanonicalRuntimeConfig,
  RuntimeExitEvidence,
  RuntimeReadiness,
  RuntimeReleaseManifest,
} from './types';

export interface CanonicalRuntimeDependencies {
  loadReleaseManifest(path: string, controllerHome: string): RuntimeReleaseManifest;
  acquireOwnership(controllerHome: string, runtimeInstanceId: string): RuntimeOwnershipHandle;
  inspectDatabase(controllerHome: string): ControlPlaneDatabaseInspection;
  startScheduler(controllerHome: string, timeoutMs?: number): RuntimeSchedulerHandle;
  startTransport(options: Parameters<typeof startRuntimeMcpTransport>[0]): Promise<RuntimeMcpTransportHandle>;
  runMcpProbe(endpoint: string, authToken: string): Promise<void>;
}

async function defaultMcpProbe(endpoint: string, authToken: string): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${authToken}` } },
  });
  const client = new Client({ name: 'repo-harness-runtime-probe', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === 'controller_ready')) {
      throw new Error('MCP_PROBE_TOOL_MISSING: controller_ready');
    }
    const result = await client.callTool({ name: 'controller_ready', arguments: {} });
    if (result.isError) throw new Error('MCP_PROBE_CONTROLLER_CALL_FAILED');
    const structured = result.structuredContent as Record<string, unknown> | undefined;
    const database = structured?.database as Record<string, unknown> | undefined;
    if (database?.integrity !== 'ok') throw new Error('MCP_PROBE_SQLITE_READ_FAILED');
  } finally {
    await client.close().catch(() => undefined);
  }
}

const DEFAULT_DEPENDENCIES: CanonicalRuntimeDependencies = {
  loadReleaseManifest: loadRuntimeReleaseManifest,
  acquireOwnership: acquireRuntimeOwnership,
  inspectDatabase: inspectControlPlaneDatabase,
  startScheduler: startInProcessScheduler,
  startTransport: startRuntimeMcpTransport,
  runMcpProbe: defaultMcpProbe,
};

export class CanonicalRepoHarnessRuntime {
  readonly runtimeInstanceId: string;
  private readonly readinessState = new RuntimeReadinessState();
  private readonly dependencies: CanonicalRuntimeDependencies;
  private ownership?: RuntimeOwnershipHandle;
  private scheduler?: RuntimeSchedulerHandle;
  private transport?: RuntimeMcpTransportHandle;
  private controller?: RuntimeControllerServices;
  private release?: RuntimeReleaseManifest;
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

  endpoint(): string | undefined {
    return this.transport?.endpoint;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('RUNTIME_ALREADY_STARTED');
    this.started = true;
    this.readinessState.setLifecycle('starting');
    let stage: 'release' | 'ownership' | 'database' | 'scheduler' | 'transport' | 'probe' = 'release';
    try {
      this.release = this.dependencies.loadReleaseManifest(this.config.releaseManifestPath, this.config.controllerHome);
      this.readinessState.setCheck('releaseCoherence', 'pass');

      stage = 'ownership';
      this.ownership = this.dependencies.acquireOwnership(this.config.controllerHome, this.runtimeInstanceId);

      stage = 'database';
      this.controller = new RuntimeControllerServices(
        this.config.controllerHome,
        this.runtimeInstanceId,
        this.release,
        () => this.readiness(),
        this.dependencies.inspectDatabase,
      );
      this.controller.initialize();
      this.readinessState.setCheck('database', 'pass');
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
      this.readinessState.setCheck('scheduler', 'pass');
      void this.scheduler.done.then(
        () => this.failCore('SCHEDULER_STOPPED', 'Scheduler stopped while Runtime was active.'),
        (error) => this.failCore('SCHEDULER_STALLED', error instanceof Error ? error.message : String(error)),
      );

      stage = 'transport';
      this.transport = await this.dependencies.startTransport({
        host: this.config.host,
        port: this.config.port,
        authToken: this.config.authToken,
        readiness: () => this.readiness(),
        createServer: (principalId) => createRuntimeGatewayServer(this.controller!, principalId),
        onFatal: (error) => this.failCore('MCP_TRANSPORT_FAILED', error.message),
      });

      stage = 'probe';
      await this.dependencies.runMcpProbe(this.transport.endpoint, this.config.authToken);
      this.readinessState.setCheck('mcpEndToEnd', 'pass');
      this.readinessState.setLifecycle('running');
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
    if (stage === 'database') return 'DATABASE_UNAVAILABLE';
    if (stage === 'scheduler') return 'SCHEDULER_INITIALIZATION_FAILED';
    if (stage === 'transport') return 'MCP_LISTENER_FAILED';
    return 'MCP_END_TO_END_FAILED';
  }

  private markStartupFailure(stage: string, reason: string): void {
    if (stage === 'release') this.readinessState.setCheck('releaseCoherence', 'fail', reason);
    else if (stage === 'database') this.readinessState.setCheck('database', 'fail', reason);
    else if (stage === 'scheduler') this.readinessState.setCheck('scheduler', 'fail', reason);
    else if (stage === 'transport' || stage === 'probe') this.readinessState.setCheck('mcpEndToEnd', 'fail', reason);
    this.readinessState.addReason(reason);
  }

  private failCore(reasonCode: string, message: string): void {
    if (this.stopping || this.readiness().lifecycle === 'stopped') return;
    if (reasonCode.startsWith('SCHEDULER_')) this.readinessState.setCheck('scheduler', 'fail', reasonCode);
    if (reasonCode.startsWith('MCP_')) this.readinessState.setCheck('mcpEndToEnd', 'fail', reasonCode);
    this.readinessState.addReason(reasonCode);
    void this.stop(reasonCode, message);
  }

  async stop(reasonCode = 'RUNTIME_STOP_REQUESTED', message?: string): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.stopping = true;
      this.readinessState.setLifecycle('stopping');
      // Stop accepting new MCP work before quiescing Scheduler activity, then
      // release the Controller Home claim only after all in-process services stop.
      await this.transport?.close().catch(() => undefined);
      await this.scheduler?.stop().catch(() => undefined);
      this.ownership?.release();
      this.lastExit = { reasonCode, observedAt: new Date().toISOString(), ...(message ? { message } : {}) };
      this.readinessState.setLifecycle('stopped');
      this.stopping = false;
      this.stoppedResolve();
    })();
    return this.stopPromise;
  }

  waitForStopped(): Promise<void> {
    return this.stopped;
  }
}
