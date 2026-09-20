import { randomUUID } from 'crypto';
import { statSync } from 'fs';
import { writeJsonAtomic } from '../shared/json-files';
import { ensureForgeInstanceIdentity } from '../../../packages/kernel/identity/api/index';
import { dirname, join } from 'path';
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { ControlPlaneDatabaseInspection } from '../control-plane/persistence/sqlite-store';
import {
  disableControlPlaneReadConnectionReuse,
  enableControlPlaneReadConnectionReuse,
  inspectControlPlaneDatabase,
} from '../control-plane/persistence/sqlite-store';
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
import { loadRuntimeReleaseManifest, requireCompleteCompiledRuntimeReleaseManifest } from './release-manifest';
import { ensureActiveRuntimeRelease, readRuntimeReleaseAuthority, type RuntimeReleaseAuthority } from './release-store';
import { migrateReleaseDurableState } from '../release/release-state-migration';
import { bindRuntimeWriteClaim, clearRuntimeWriteClaim } from './write-fence';
import { startInProcessScheduler, type RuntimeSchedulerHandle } from './scheduler';
import { startConfiguredRuntimeLocalBridge, type RuntimeLocalBridgeHandle } from './local-bridge';
import { startActiveExecutionPowerAssertion, type RuntimePowerAssertionHandle } from './active-execution-power-assertion';
import { startWorkflowSupervisorRuntime, type RuntimeWorkflowSupervisorHandle } from './workflow-supervisor-runtime';
import { normalizeRuntimeDeploymentTopology, type RuntimeDeploymentTopology } from './deployment-topology';
import { removeRuntimeStartupFailureEvidence, removeRuntimeStatusSnapshot, writeRuntimeStartupFailureEvidence, writeRuntimeStatusSnapshot } from './status';
import type {
  CanonicalRuntimeConfig,
  CanonicalRuntimeStatusSnapshot,
  RuntimeExitEvidence,
  RuntimeReadiness,
  RuntimeReleaseManifest,
} from './types';

export interface RuntimeReleaseAuthorityMonitor {
  stop(): void;
}

export interface CanonicalRuntimeDependencies {
  loadReleaseManifest(path: string, controllerHome: string): RuntimeReleaseManifest;
  migrateReleaseState(controllerHome: string): void;
  ensureReleaseAuthority(controllerHome: string, manifestPath: string): RuntimeReleaseAuthority;
  readReleaseAuthority(controllerHome: string): RuntimeReleaseAuthority | undefined;
  startReleaseAuthorityMonitor(observe: () => void): RuntimeReleaseAuthorityMonitor;
  bindWriteClaim(input: { controllerHome: string; owner: RuntimeOwnershipHandle['record']; authority: RuntimeReleaseAuthority }): void;
  acquireOwnership(controllerHome: string, runtimeInstanceId: string): RuntimeOwnershipHandle;
  inspectDatabase(controllerHome: string): ControlPlaneDatabaseInspection;
  startScheduler(input: Parameters<typeof startInProcessScheduler>[0]): RuntimeSchedulerHandle;
  startLocalBridge(input: { controllerHome: string; repositoryRoot?: string }): Promise<RuntimeLocalBridgeHandle | undefined>;
  startPowerAssertion(input: { controllerHome: string; runtimePid: number }): RuntimePowerAssertionHandle;
  startWorkflowSupervisor(controllerHome: string, options?: { nativeBrowserAdapter?: boolean }): Promise<RuntimeWorkflowSupervisorHandle>;
  startTransport(options: Parameters<typeof startRuntimeMcpTransport>[0]): Promise<RuntimeMcpTransportHandle>;
  runMcpProbe(endpoint: string, authToken: string): Promise<void>;
  collectRuntimeSourceIdentity: typeof collectRuntimeSourceIdentity;
  rotateRuntimeGeneration: typeof rotateRuntimeGeneration;
  stopLightweightProcesses(controllerHome: string): Promise<number>;
  stopContextReadHelpers(): Promise<void>;
  computeToolSurfaceFingerprint: typeof runtimeGatewayToolSurfaceFingerprint;
  ensureForgeInstanceIdentity: typeof ensureForgeInstanceIdentity;
  captureJscSamplingProfile(options: { durationMs: number; sampleIntervalUs: number }): Promise<{
    requestedDurationMs: number;
    elapsedMs: number;
    sampleIntervalUs: number;
    functions: string;
    bytecodes: string;
    stackTraces: {
      interval: number | null;
      totalTraceCount: number;
      retainedTraceCount: number;
      traces: Array<{ timestamp: number | null; frames: Array<Record<string, unknown>> }>;
      sources: Array<Record<string, unknown>>;
    };
  }>;
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
const JSC_SAMPLING_DURATION_MS = 2_000;
const JSC_SAMPLING_INTERVAL_US = 1_000;
const JSC_SAMPLING_TRACE_LIMIT = 2_000;
const JSC_SAMPLING_FRAME_LIMIT = 32;
const JSC_SAMPLING_SOURCE_LIMIT = 512;
const JSC_SAMPLING_REPORT_CHAR_LIMIT = 128 * 1024;

function startDefaultReleaseAuthorityMonitor(observe: () => void): RuntimeReleaseAuthorityMonitor {
  const timer = setInterval(observe, DEFAULT_RELEASE_AUTHORITY_MONITOR_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

async function captureDefaultJscSamplingProfile(options: { durationMs: number; sampleIntervalUs: number }): Promise<{
  requestedDurationMs: number;
  elapsedMs: number;
  sampleIntervalUs: number;
  functions: string;
  bytecodes: string;
  stackTraces: {
    interval: number | null;
    totalTraceCount: number;
    retainedTraceCount: number;
    traces: Array<{ timestamp: number | null; frames: Array<Record<string, unknown>> }>;
    sources: Array<Record<string, unknown>>;
  };
}> {
  const { profile } = await import('bun:jsc');
  const startedAt = performance.now();
  const sampling = await profile(
    () => new Promise<void>((resolve) => setTimeout(resolve, options.durationMs)),
    options.sampleIntervalUs,
  );
  // Bun's current runtime returns an object here even though bun-types still
  // declares SamplingProfile.stackTraces as string[]. Treat the runtime value
  // as diagnostic input and normalize it defensively instead of trusting that
  // stale declaration at the production boundary.
  const rawStackTraces = sampling.stackTraces as unknown as {
    interval?: unknown;
    traces?: unknown;
    sources?: unknown;
  };
  const rawTraces = Array.isArray(rawStackTraces?.traces) ? rawStackTraces.traces : [];
  const traces = rawTraces.slice(-JSC_SAMPLING_TRACE_LIMIT).map((trace) => {
    const record = trace && typeof trace === 'object' && !Array.isArray(trace)
      ? trace as Record<string, unknown>
      : {};
    const frames = Array.isArray(record.frames)
      ? record.frames.filter((frame): frame is Record<string, unknown> => Boolean(frame) && typeof frame === 'object' && !Array.isArray(frame)).slice(0, JSC_SAMPLING_FRAME_LIMIT)
      : [];
    return {
      timestamp: typeof record.timestamp === 'number' ? record.timestamp : null,
      frames,
    };
  });
  const sources = Array.isArray(rawStackTraces?.sources)
    ? rawStackTraces.sources.filter((source): source is Record<string, unknown> => Boolean(source) && typeof source === 'object' && !Array.isArray(source)).slice(0, JSC_SAMPLING_SOURCE_LIMIT)
    : [];
  return {
    requestedDurationMs: options.durationMs,
    elapsedMs: Math.max(0, performance.now() - startedAt),
    sampleIntervalUs: options.sampleIntervalUs,
    functions: sampling.functions.slice(0, JSC_SAMPLING_REPORT_CHAR_LIMIT),
    bytecodes: sampling.bytecodes.slice(0, JSC_SAMPLING_REPORT_CHAR_LIMIT),
    stackTraces: {
      interval: typeof rawStackTraces?.interval === 'number' ? rawStackTraces.interval : null,
      totalTraceCount: rawTraces.length,
      retainedTraceCount: traces.length,
      traces,
      sources,
    },
  };
}

const DEFAULT_DEPENDENCIES: CanonicalRuntimeDependencies = {
  loadReleaseManifest: loadRuntimeReleaseManifest,
  migrateReleaseState: migrateReleaseDurableState,
  ensureReleaseAuthority: ensureActiveRuntimeRelease,
  readReleaseAuthority: readRuntimeReleaseAuthority,
  startReleaseAuthorityMonitor: startDefaultReleaseAuthorityMonitor,
  bindWriteClaim: (input) => { bindRuntimeWriteClaim(input); },
  acquireOwnership: acquireRuntimeOwnership,
  inspectDatabase: inspectControlPlaneDatabase,
  startScheduler: startInProcessScheduler,
  startLocalBridge: startConfiguredRuntimeLocalBridge,
  startPowerAssertion: startActiveExecutionPowerAssertion,
  startWorkflowSupervisor: startWorkflowSupervisorRuntime,
  startTransport: startRuntimeMcpTransport,
  runMcpProbe: defaultMcpProbe,
  collectRuntimeSourceIdentity,
  rotateRuntimeGeneration,
  stopLightweightProcesses: cancelAllLightweightProcesses,
  stopContextReadHelpers: closeCodeGraphReadProviderSessions,
  computeToolSurfaceFingerprint: runtimeGatewayToolSurfaceFingerprint,
  ensureForgeInstanceIdentity,
  captureJscSamplingProfile: captureDefaultJscSamplingProfile,
};

export class CanonicalForgeRuntime {
  readonly forgeInstanceId: string;
  readonly runtimeInstanceId: string;
  readonly topology: RuntimeDeploymentTopology;
  private readonly readinessState = new RuntimeReadinessState();
  private readonly dependencies: CanonicalRuntimeDependencies;
  private ownership?: RuntimeOwnershipHandle;
  private scheduler?: RuntimeSchedulerHandle;
  private localBridge?: RuntimeLocalBridgeHandle;
  private powerAssertion?: RuntimePowerAssertionHandle;
  private workflowSupervisor?: RuntimeWorkflowSupervisorHandle;
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
  private jscHeapDiagnosticsSignalHandler?: () => void;
  private jscHeapDiagnosticsCaptureInFlight = false;
  private jscSamplingProfilerSignalHandler?: () => void;
  private jscSamplingProfileCaptureInFlight = false;
  lastExit?: RuntimeExitEvidence;

  constructor(
    readonly config: CanonicalRuntimeConfig,
    dependencies: Partial<CanonicalRuntimeDependencies> = {},
  ) {
    this.runtimeInstanceId = config.runtimeInstanceId?.trim() || `runtime_${randomUUID().replaceAll('-', '')}`;
    this.topology = normalizeRuntimeDeploymentTopology(config.topology);
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    if (!config.controllerHome.trim()) throw new Error('RUNTIME_CONFIG_REQUIRED: controllerHome');
    if (config.repositoryRoot?.trim()) {
      try {
        if (!statSync(config.repositoryRoot).isDirectory()) throw new Error('not a directory');
      } catch {
        throw new Error('RUNTIME_CONFIG_INVALID: repositoryRoot must be an existing directory');
      }
    }
    if (!config.releaseManifestPath.trim()) throw new Error('RUNTIME_CONFIG_REQUIRED: releaseManifestPath');
    if (!config.host.trim()) throw new Error('RUNTIME_CONFIG_REQUIRED: host');
    if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65_535) {
      throw new Error('RUNTIME_CONFIG_INVALID: port');
    }
    if (!config.authToken.trim()) throw new Error('RUNTIME_CONFIG_REQUIRED: authToken');
    this.forgeInstanceId = this.dependencies.ensureForgeInstanceIdentity({
      controllerHome: config.controllerHome,
      preferredInstanceId: process.env.FORGE_INSTANCE_ID?.trim(),
    }).instanceId;
  }

  readiness(): RuntimeReadiness {
    return this.readinessState.snapshot();
  }

  private installJscHeapDiagnosticsSignal(): void {
    if (process.platform === 'win32' || this.jscHeapDiagnosticsSignalHandler) return;
    const handler = () => {
      if (this.jscHeapDiagnosticsCaptureInFlight) return;
      this.jscHeapDiagnosticsCaptureInFlight = true;
      void import('bun:jsc').then(({ fullGC, heapStats, memoryUsage }) => {
        const gcStartedAt = performance.now();
        const fullGcResult = fullGC();
        const fullGcDurationMs = Math.max(0, performance.now() - gcStartedAt);
        const heap = heapStats();
        const topTypes = (counts: Record<string, number>, limit: number) => Object.entries(counts)
          .sort((left, right) => right[1] - left[1])
          .slice(0, limit)
          .map(([type, count]) => ({ type, count }));
        writeJsonAtomic(join(this.config.controllerHome, 'diagnostics', 'jsc-heap.json'), {
          schemaVersion: 1,
          capturedAt: new Date().toISOString(),
          pid: process.pid,
          runtimeInstanceId: this.runtimeInstanceId,
          releaseId: this.release?.releaseId,
          gc: {
            forced: true,
            kind: 'full',
            durationMs: fullGcDurationMs,
            result: fullGcResult,
          },
          heap: {
            heapSize: heap.heapSize,
            heapCapacity: heap.heapCapacity,
            extraMemorySize: heap.extraMemorySize,
            objectCount: heap.objectCount,
            protectedObjectCount: heap.protectedObjectCount,
            globalObjectCount: heap.globalObjectCount,
            protectedGlobalObjectCount: heap.protectedGlobalObjectCount,
            objectTypeCount: Object.keys(heap.objectTypeCounts).length,
            protectedObjectTypeCount: Object.keys(heap.protectedObjectTypeCounts).length,
            topObjectTypes: topTypes(heap.objectTypeCounts, 100),
            topProtectedObjectTypes: topTypes(heap.protectedObjectTypeCounts, 50),
          },
          memoryUsage: memoryUsage(),
        });
      }).catch((error) => {
        process.stderr.write(`${JSON.stringify({
          event: 'forge_runtime_jsc_heap_diagnostics_failed',
          runtimeInstanceId: this.runtimeInstanceId,
          message: error instanceof Error ? error.message : String(error),
          observedAt: new Date().toISOString(),
        })}\n`);
      }).finally(() => {
        this.jscHeapDiagnosticsCaptureInFlight = false;
      });
    };
    process.on('SIGUSR2', handler);
    this.jscHeapDiagnosticsSignalHandler = handler;
  }

  private removeJscHeapDiagnosticsSignal(): void {
    const handler = this.jscHeapDiagnosticsSignalHandler;
    if (!handler) return;
    process.off('SIGUSR2', handler);
    this.jscHeapDiagnosticsSignalHandler = undefined;
  }

  private installJscSamplingProfilerSignal(): void {
    if (process.platform === 'win32' || this.jscSamplingProfilerSignalHandler) return;
    const handler = () => {
      if (this.jscSamplingProfileCaptureInFlight) return;
      this.jscSamplingProfileCaptureInFlight = true;
      void this.dependencies.captureJscSamplingProfile({
        durationMs: JSC_SAMPLING_DURATION_MS,
        sampleIntervalUs: JSC_SAMPLING_INTERVAL_US,
      }).then((sampling) => {
        const path = join(this.config.controllerHome, 'diagnostics', 'jsc-sampling-profile.json');
        writeJsonAtomic(path, {
          schemaVersion: 1,
          capturedAt: new Date().toISOString(),
          pid: process.pid,
          runtimeInstanceId: this.runtimeInstanceId,
          releaseId: this.release?.releaseId,
          bounded: true,
          ...sampling,
        });
        process.stderr.write(`${JSON.stringify({
          event: 'forge_runtime_jsc_sampling_profile_captured',
          runtimeInstanceId: this.runtimeInstanceId,
          path,
          requestedDurationMs: sampling.requestedDurationMs,
          elapsedMs: sampling.elapsedMs,
          sampleIntervalUs: sampling.sampleIntervalUs,
          retainedTraceCount: sampling.stackTraces.retainedTraceCount,
          observedAt: new Date().toISOString(),
        })}\n`);
      }).catch((error) => {
        process.stderr.write(`${JSON.stringify({
          event: 'forge_runtime_jsc_sampling_profile_failed',
          runtimeInstanceId: this.runtimeInstanceId,
          message: error instanceof Error ? error.message : String(error),
          observedAt: new Date().toISOString(),
        })}\n`);
      }).finally(() => {
        this.jscSamplingProfileCaptureInFlight = false;
      });
    };
    process.on('SIGUSR1', handler);
    this.jscSamplingProfilerSignalHandler = handler;
  }

  private removeJscSamplingProfilerSignal(): void {
    const handler = this.jscSamplingProfilerSignalHandler;
    if (!handler) return;
    process.off('SIGUSR1', handler);
    this.jscSamplingProfilerSignalHandler = undefined;
  }

  private publishStatus(): void {
    if (!this.ownership || !this.release) return;
    try {
      const snapshot: CanonicalRuntimeStatusSnapshot = {
        schemaVersion: 1,
        forgeInstanceId: this.forgeInstanceId,
        runtimeInstanceId: this.runtimeInstanceId,
        pid: this.ownership.record.pid,
        releaseId: this.release.releaseId,
        artifactIdentity: this.release.artifactIdentity,
        ...(this.toolSurfaceFingerprint ? { toolSurfaceFingerprint: this.toolSurfaceFingerprint } : {}),
        ...(this.transport?.endpoint ? { endpoint: this.transport.endpoint } : {}),
        readiness: this.readiness(),
        startedAt: this.ownership.record.acquiredAt,
        updatedAt: new Date().toISOString(),
      };
      writeRuntimeStatusSnapshot(this.config.controllerHome, snapshot);
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
    let stage: 'release' | 'ownership' | 'source' | 'database' | 'supervisor' | 'scheduler' | 'localBridge' | 'transport' | 'probe' = 'release';
    try {
      this.release = this.dependencies.loadReleaseManifest(this.config.releaseManifestPath, this.config.controllerHome);

      stage = 'ownership';
      this.ownership = this.dependencies.acquireOwnership(this.config.controllerHome, this.runtimeInstanceId);

      stage = 'release';
      this.dependencies.migrateReleaseState(this.config.controllerHome);
      const releaseAuthority = this.dependencies.ensureReleaseAuthority(this.config.controllerHome, this.config.releaseManifestPath);
      stage = 'source';
      // A compiled release is a closed execution surface. Fail before Scheduler
      // composition if a stale/corrupt manifest omits any immutable component;
      // standalone Runtime must never regain source/import.meta.url fallback.
      if (this.release.executionMode === 'standalone-binary') {
        requireCompleteCompiledRuntimeReleaseManifest(this.release);
      }
      // A materialized immutable release carries either a source revision or a
      // package release revision and must snapshot that release directory.
      // Source/fixture manifests without either identity keep the historical
      // explicit repositoryRoot behavior so development-mode Runtime drift
      // remains live.
      const materializedRelease = Boolean(
        this.release.releaseRevision
        && (this.release.sourceCommit || this.release.releaseRevision.startsWith('package:')),
      );
      const runtimeSourceRoot = materializedRelease
        ? dirname(this.config.releaseManifestPath)
        : this.config.repositoryRoot;
      if (!runtimeSourceRoot) {
        throw new Error('RUNTIME_CONFIG_REQUIRED: repositoryRoot is required only for non-materialized development Runtime');
      }
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
      // The Canonical Runtime is the only process that keeps a control-plane
      // reader alive across operations. Writers remain short-lived WAL/CAS
      // transactions, while CLI/tests/workers keep their existing close-on-read
      // semantics.
      enableControlPlaneReadConnectionReuse(this.config.controllerHome);
      this.installJscHeapDiagnosticsSignal();
      this.installJscSamplingProfilerSignal();
      this.readinessState.setDiagnostic('database', 'pass');
      this.publishStatus();
      if (this.config.exclusiveWorkId) {
        activateExclusiveWorkAdmission(this.config.controllerHome, {
          allowedWorkId: this.config.exclusiveWorkId,
          reason: 'P0 canonical single Runtime migration isolation',
        });
      }

      if (this.topology.components.workflowSupervisor) {
        stage = 'supervisor';
        this.workflowSupervisor = await this.dependencies.startWorkflowSupervisor(this.config.controllerHome, {
          nativeBrowserAdapter: this.topology.components.workflowSupervisorNativeBrowser,
        });
        void this.workflowSupervisor.done.then(
          () => this.failCore('WORKFLOW_SUPERVISOR_STOPPED', 'Workflow Supervisor stopped while Runtime was active.'),
          (error) => this.failCore('WORKFLOW_SUPERVISOR_FAILED', error instanceof Error ? error.message : String(error)),
        );
      }

      stage = 'scheduler';
      const standaloneReleaseRoot = this.release.executionMode === 'standalone-binary'
        ? dirname(this.config.releaseManifestPath)
        : undefined;
      this.scheduler = this.dependencies.startScheduler({
        controllerHome: this.config.controllerHome,
        readyTimeoutMs: this.config.schedulerReadyTimeoutMs,
        runtimeSourceRoot: standaloneReleaseRoot ? undefined : runtimeSourceRoot,
        workerExecutable: standaloneReleaseRoot && this.release.schedulerWorkerEntrypoint
          ? join(standaloneReleaseRoot, this.release.schedulerWorkerEntrypoint)
          : undefined,
        periodicCleanupExecutable: standaloneReleaseRoot && this.release.periodicCleanupEntrypoint
          ? join(standaloneReleaseRoot, this.release.periodicCleanupEntrypoint)
          : undefined,
      });
      await this.scheduler.ready;
      this.readinessState.setDiagnostic('scheduler', 'pass');
      this.publishStatus();
      void this.scheduler.done.then(
        () => this.failCore('SCHEDULER_STOPPED', 'Scheduler stopped while Runtime was active.'),
        (error) => this.failCore('SCHEDULER_STALLED', error instanceof Error ? error.message : String(error)),
      );
      this.powerAssertion = this.dependencies.startPowerAssertion({
        controllerHome: this.config.controllerHome,
        runtimePid: this.ownership.record.pid,
      });

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
      removeRuntimeStartupFailureEvidence(this.config.controllerHome);
      stage = 'release';
      this.startReleaseAuthorityMonitor();
    } catch (error) {
      const reason = this.startupReason(stage);
      const message = error instanceof Error ? error.message : String(error);
      this.markStartupFailure(stage, reason);
      try {
        writeRuntimeStartupFailureEvidence(this.config.controllerHome, {
          schemaVersion: 1,
          runtimeInstanceId: this.runtimeInstanceId,
          stage,
          reasonCode: reason,
          message,
          ...(this.release ? {
            releaseId: this.release.releaseId,
            artifactIdentity: this.release.artifactIdentity,
          } : {}),
          observedAt: new Date().toISOString(),
        });
      } catch {
        // Diagnostic persistence must never replace the original startup failure.
      }
      await this.stop(reason, message);
      throw error;
    }
  }

  private startupReason(stage: string): string {
    if (stage === 'release') return 'RELEASE_COHERENCE_FAILED';
    if (stage === 'ownership') return 'RUNTIME_OWNERSHIP_CONFLICT';
    if (stage === 'source') return 'RUNTIME_SOURCE_SNAPSHOT_FAILED';
    if (stage === 'database') return 'DATABASE_UNAVAILABLE';
    if (stage === 'supervisor') return 'WORKFLOW_SUPERVISOR_INITIALIZATION_FAILED';
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
      this.removeJscHeapDiagnosticsSignal();
      this.removeJscSamplingProfilerSignal();
      // Stop accepting new MCP work before quiescing Scheduler activity, then
      // release the Controller Home claim only after all in-process services stop.
      await this.workflowSupervisor?.close().catch(() => undefined);
      this.workflowSupervisor = undefined;
      await this.transport?.close().catch(() => undefined);
      await this.dependencies.stopLightweightProcesses(this.config.controllerHome).catch(() => undefined);
      await this.dependencies.stopContextReadHelpers().catch(() => undefined);
      await this.localBridge?.close().catch(() => undefined);
      await this.scheduler?.stop().catch(() => undefined);
      try { this.powerAssertion?.stop(); } catch { /* power assertion cleanup is best effort */ }
      this.powerAssertion = undefined;
      disableControlPlaneReadConnectionReuse(this.config.controllerHome);
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
