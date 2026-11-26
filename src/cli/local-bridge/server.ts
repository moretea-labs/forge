import { createHash, randomBytes } from 'crypto';
import { createServer, type Server } from 'http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { describeFailure } from '../../../packages/protocols/failure';
import { ControllerLockContentionError, withControllerLock } from '../../effects/controller-locks';
import {
  cancelAgentJob,
  getAgentJob,
  getAgentJobEvents,
  getAgentJobLog,
  listAgentJobs,
  reconcileAgentJobs,
} from '../agent-jobs/job-manager';
import { cleanupIntegratedWorktree, integrateAgentJob, taskRunDiff } from '../agent-jobs/integration';
import { listControllerChecks, runControllerCheck } from '../../runtime/execution/process-runtime/check-runner';
import { projectBoard } from '../controller/issue-store';
import { buildControllerTaskLedgerProjection } from '../controller/task-ledger';
import {
  exportControllerWorklog,
  listControllerWorklogEvents,
  parseWorklogCategory,
} from '../../runtime/evidence/controller-worklog';
import { inspectProjectGovernance } from '../controller/governance';
import { loadControllerProjectState } from '../controller/project-state';
import { legacyIssueCutoverState } from '../controller/legacy-issue-cutover';
import { buildExecutionDiagnostics, buildRequirementBoard } from '../../runtime/control-plane/facade/requirement-board';
import {
  closeIssueWithGitHubPlugin,
  githubIssueSyncPort,
  publishIssueWithGitHubPlugin,
  refreshIssueWithGitHubPlugin,
} from '../github/plugin';
import { getGitHubPluginStatus, saveGitHubPluginConfig } from '../../runtime/plugins/github-config';
import {
  cancelLocalBridgeJob,
  getLocalBridgeJob,
  getLocalBridgeJobEvents,
  listLocalBridgeJobs,
  localBridgeTimeoutPolicy,
  reconcileLocalBridgeJobs,
} from './job-store';
import {
  applyConsoleAutomationAction,
  listConsoleAutomations,
  summarizeConsoleAutomations,
} from './console-automations';
import {
  ackConsoleHandoff,
  approveConsoleHandoff,
  applyConsoleSafePatch,
  buildAdvancedDiagnosticsEnvelope,
  buildCommandCenter,
  buildPluginSummary,
  buildSystemReadiness,
  evaluateConsoleConnectorFreshness,
  getConsoleAccessPolicy,
  getConsolePlugin,
  listConsolePlugins,
  dismissConsoleHandoff,
  getConsoleHandoff,
  listConsoleHandoffs,
  mapRepositoryCard,
  repairConsole,
  resolveConsoleHandoff,
  setConsoleAccessPolicy,
} from './facade-api';
import {
  FORGE_MCP_SCHEMA_VERSION,
  FORGE_TOOL_SURFACE,
  FORGE_VERSION,
  defaultLocalAgentRunners,
} from '../../runtime/shared/runtime-config';
import { getToolPolicy } from '../../runtime/control-plane/tool-policy';
import type { MultiRepositoryMcpToolContext } from '../../../adapters/mcp/multi-repository';
import { createMcpToolContext as createControllerMcpToolContext } from '../../../adapters/mcp/server';
import { callRhProjectWorkflowOperation } from '../../../adapters/mcp/runtime-gateway/rh-project-workflow-operations';
import {
  AGENTMAIL_EVENT_WORKFLOW_ID,
  resolveAgentMailAppCaseRoute,
} from '../../runtime/workflows/first-party/agentmail-event';
import { normalizeAgentMailWatchEvent } from '../../runtime/events/adapters/agentmail-watch';
import { loadMcpServiceLocalConfig, loadMcpServiceRuntimeState } from '../../../adapters/mcp/auth';
import {
  loadRepositoryRegistry,
  registerRepository,
  removeRepository,
  resolveRepositorySelection,
} from '../../runtime/repositories/registry';
import { resolveControllerHome, resolveRepoPreferredControllerHome } from '../../effects/controller-home';
import { ensureRepositoryRuntimeStorage } from '../../runtime/repositories/runtime-storage';
import { readForgeRuntimeStatus } from '../../runtime/control-plane/runtime-status-client';
import { readRuntimeGeneration } from '../../runtime/control-plane/runtime-generation';
import { findExecutionJob, listActiveExecutionJobs, listExecutionJobs } from '../../runtime/execution/jobs/store';
import {
  rebuildRepositoryProjection,
  readRepositoryProjectionSnapshot,
} from '../../runtime/projections/materialized-view';
import {
  getAssistantPluginManifest,
  listAssistantPluginManifests,
  listControllerPluginManifests,
  submitAssistantPluginAction,
  findPluginActionReceipt,
  compatibilityPluginJobFromReceipt,
} from '../../runtime/plugins/store';
import {
  createMobileIntentDevice,
  listMobileIntentDevices,
  mobileIntentHasScope,
  revokeMobileIntentDevice,
  verifyMobileIntentRequest,
} from './mobile-intents';
import { buildMobileMonitorSnapshot } from './mobile-monitor';
import { controllerExposureSnapshot } from '../../../adapters/mcp/toolset';
import { completeGoogleOAuthLogin } from '../../runtime/safe-tooling/google-oauth-broker';
import { completeResendOAuthLogin } from '../../runtime/safe-tooling/resend-oauth';
import { summarizePluginForLowInterception } from '../../runtime/safe-tooling';
import {
  buildModelClientSummary,
  buildModelControlPlaneSummary,
  deepSeekControllerManifest,
  deepSeekFunctionToolManifest,
  prepareDeepSeekControllerHandoff,
  prepareDeepSeekControllerRequest,
  prepareDeepSeekToolCall,
} from '../../runtime/model-clients';
import { previewRuntimeCleanup } from '../../runtime/maintenance/cleanup';
import {
  assertRecoveryAuthorized,
  buildCapabilityRecoverySnapshot,
  buildRecoveryAuditRecord,
  executeCapabilityRecoveryAction,
  recoveryActionById,
  writeRecoveryAuditRecord,
} from '../../runtime/recovery';

export interface LocalBridgeServerOptions {
  /**
   * Compatibility root used to bootstrap older repo-local storage. New Local
   * Bridge endpoints should resolve the active repository through repoId and
   * use repoRoot only as a fallback/default selection.
   */
  repoRoot: string;
  controllerHome?: string;
  defaultRepoId?: string;
  host?: string;
  port?: number;
  token?: string;
  allowLanMobileIntents?: boolean;
  mode?: 'standalone' | 'embedded' | 'remote' | 'disabled' | 'unknown';
  slot?: 'blue' | 'green';
}

export interface LocalBridgeServerHandle {
  host: string;
  port: number;
  url: string;
  token: string;
  server: Server;
  close(): Promise<void>;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function isLoopbackHostname(hostname: string): boolean {
  return ['127.0.0.1', 'localhost', '::1'].includes(normalizeHostname(hostname));
}

function isWildcardBindHost(host: string): boolean {
  return ['0.0.0.0', '::', '[::]'].includes(normalizeHostname(host));
}

function assertAllowedBindHost(host: string, allowLanMobileIntents: boolean): void {
  if (isLoopbackHostname(host)) return;
  if (allowLanMobileIntents && isWildcardBindHost(host)) return;
  throw new Error(`local controller must bind to loopback unless --mobile-lan is enabled, received: ${host}`);
}

function parsedRequestHost(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(`http://${value}`);
  } catch (_error) {
    return undefined;
  }
}

function cookieValue(request: Request, name: string): string | undefined {
  const raw = request.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [key, ...valueParts] = part.trim().split('=');
    if (key !== name) continue;
    try {
      return decodeURIComponent(valueParts.join('='));
    } catch (_error) {
      return undefined;
    }
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mobileIntentFailureResponse(error: unknown): { message: string; status: number } {
  if (error instanceof ControllerLockContentionError) {
    return { message: 'MOBILE_INTENT_STORE_BUSY', status: 503 };
  }
  const failure = describeFailure(error, {
    fallbackCode: 'MOBILE_INTENT_REQUEST_FAILED',
    fallbackHttpStatus: 400,
  });
  return { message: failure.message, status: failure.httpStatus ?? 400 };
}

function sendMobileIntentFailure(response: Response, error: unknown): void {
  const failure = mobileIntentFailureResponse(error);
  if (failure.status === 503) response.setHeader('Retry-After', '1');
  response.status(failure.status).json({ error: failure.message });
}

function withMobileIntentStoreLock<T>(controllerHome: string, repoId: string, operation: () => T): T {
  return withControllerLock(
    controllerHome,
    { scope: 'repository', repoId },
    'local-bridge:mobile-intent-store',
    operation,
  );
}

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function controllerStateSignature(repoRoot: string): string {
  const snapshot = cachedLocalControllerSnapshot(repoRoot);
  const latestWorklog = listControllerWorklogEvents(repoRoot, { limit: 1 })[0];
  return JSON.stringify({
    issues: snapshot.board.issues.map((issue) => ({
      id: issue.id,
      status: issue.status,
      updatedAt: issue.updatedAt,
      tasks: (Array.isArray(issue.tasks) ? issue.tasks : []).map((task) => {
        const value = task as { id?: unknown; status?: unknown; updatedAt?: unknown; runIds?: unknown[] };
        return [value.id, value.status, value.updatedAt, Array.isArray(value.runIds) ? value.runIds.at(-1) : undefined];
      }),
    })),
    runs: snapshot.runs.map((run) => [
      run.runId,
      run.status,
      run.lastHeartbeatAt,
      run.progress?.lastActivityAt,
      run.integratedAt,
      run.autoIntegrationError,
    ]),
    jobs: snapshot.localJobs.map((job) => [job.jobId, job.status, job.updatedAt, job.runId]),
    worklog: latestWorklog?.id,
    projectState: snapshot.projectState,
  });
}

const SNAPSHOT_CACHE_TTL_MS = 2_000;
const localSnapshotCache = new Map<
  string,
  { createdAt: number; value: ReturnType<typeof buildLocalControllerSnapshot> }
>();

function cachedLocalControllerSnapshot(repoRoot: string): ReturnType<typeof buildLocalControllerSnapshot> {
  const now = Date.now();
  const cached = localSnapshotCache.get(repoRoot);
  if (cached && now - cached.createdAt <= SNAPSHOT_CACHE_TTL_MS) return cached.value;
  const value = buildLocalControllerSnapshot(repoRoot);
  localSnapshotCache.set(repoRoot, { createdAt: now, value });
  return value;
}

function runtimeControllerSnapshot(repoRoot: string) {
  const controllerHome = resolveControllerHome();
  const normalizedRoot = repoRoot.replace(/\\/g, '/');
  const repository = loadRepositoryRegistry(controllerHome).repositories.find(
    (entry) => entry.canonicalRoot.replace(/\\/g, '/') === normalizedRoot,
  );
  if (!repository) return { registered: false, daemon: readForgeRuntimeStatus(controllerHome) };
  return {
    registered: true,
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    daemon: readForgeRuntimeStatus(controllerHome),
    projection: readRepositoryProjectionSnapshot(controllerHome, repository.repoId).projection,
    activeExecutionJobs: listActiveExecutionJobs(controllerHome, repository.repoId),
    recentExecutionJobs: listExecutionJobs(controllerHome, repository.repoId, 12),
  };
}

export function buildLocalControllerSnapshot(repoRoot: string) {
  const cutover = legacyIssueCutoverState(repoRoot);
  const retiredLegacyControlPlane = cutover.retired;
  const requirementBoard = retiredLegacyControlPlane
    ? buildRequirementBoard({ controllerHome: cutover.controllerHome, repoId: cutover.repoId })
    : undefined;
  const executionDiagnostics = retiredLegacyControlPlane
    ? buildExecutionDiagnostics({
        controllerHome: cutover.controllerHome,
        repoId: cutover.repoId,
        detailLevel: 'detail',
      })
    : undefined;
  const runs = listAgentJobs(repoRoot, 30);
  const localJobs = listLocalBridgeJobs(repoRoot, 30);
  const legacyBoard = retiredLegacyControlPlane ? undefined : projectBoard(repoRoot);
  const board = legacyBoard ?? {
    schemaVersion: 1,
    projection: 'deprecated_frozen_legacy_board',
    authority: 'controller-home-sqlite',
    deprecated: true,
    frozen: true,
    issues: [],
    counts: requirementBoard?.counts ?? {},
    declaredCounts: {},
    archivedCounts: {},
    readyTasks: [],
    queueableTasks: [],
    archivedIssueCount: 0,
    notice: 'Requirement Board is authoritative. Legacy Issue/Task board data is intentionally omitted.',
  };
  const taskLedger = buildControllerTaskLedgerProjection(repoRoot, legacyBoard, requirementBoard);
  const runtime = runtimeControllerSnapshot(repoRoot);
  const activeExecutionJobs = 'activeExecutionJobs' in runtime ? (runtime.activeExecutionJobs ?? []) : [];
  const recentExecutionJobs = 'recentExecutionJobs' in runtime ? (runtime.recentExecutionJobs ?? []) : [];
  const executionJobs = [
    ...new Map([...activeExecutionJobs, ...recentExecutionJobs].map((job) => [job.jobId, job] as const)).values(),
  ];
  const controllerHome = resolveControllerHome();
  const normalizedAssistantRoot = repoRoot.replace(/\\/g, '/');
  const assistantRepository = loadRepositoryRegistry(controllerHome).repositories.find(
    (entry) => entry.canonicalRoot.replace(/\\/g, '/') === normalizedAssistantRoot,
  );
  const assistantPlugins = (
    assistantRepository
      ? listAssistantPluginManifests(controllerHome, assistantRepository, {
          preferStored: true,
        })
      : []
  ).map((plugin) => ({
    pluginId: plugin.pluginId,
    provider: plugin.provider,
    displayName: plugin.displayName,
    enabled: plugin.enabled,
    revision: plugin.revision,
    lifecycle: plugin.lifecycle,
    health: plugin.health,
    permissions: plugin.permissions,
    actions: plugin.actions.map((action) => ({
      actionId: action.actionId,
      title: action.title,
      readOnly: action.readOnly,
      risk: action.risk,
      confirmation: action.confirmation,
      requiredConfirmationText: action.requiredConfirmationText,
      scopes: action.scopes,
    })),
  }));
  const mobileIntents = listMobileIntentDevices(repoRoot);
  const boardIssues = board.issues as Array<{
    id: string;
    tasks?: Array<{ id: string; title: string; effectiveStatus: string }>;
  }>;
  const reviewTasks = boardIssues.flatMap((issue) =>
    (issue.tasks ?? [])
      .filter((task) => ['review', 'verified', 'changes_requested'].includes(task.effectiveStatus))
      .map((task) => ({
        kind: 'task',
        issueId: issue.id,
        taskId: task.id,
        title: task.title,
        status: task.effectiveStatus,
      })),
  );
  const decisionQueues = {
    needsAttention: [
      ...runs
        .filter((run) => ['failed', 'waiting_for_user', 'unknown'].includes(run.status))
        .map((run) => ({
          kind: 'run',
          id: run.runId,
          title: run.progress?.currentActivity ?? run.runId,
          status: run.status,
          updatedAt: run.lastHeartbeatAt,
        })),
      ...executionJobs
        .filter((job) => ['human_attention_required', 'failed', 'orphaned', 'stale'].includes(job.status))
        .map((job) => ({
          kind: 'execution-job',
          id: job.jobId,
          title: String(job.payload.operation ?? job.type),
          status: job.status,
          updatedAt: job.updatedAt,
        })),
    ].slice(0, 12),
    runningNow: [
      ...runs
        .filter((run) => ['queued', 'starting', 'running'].includes(run.status))
        .map((run) => ({
          kind: 'run',
          id: run.runId,
          title: run.progress?.currentActivity ?? run.runId,
          status: run.status,
          updatedAt: run.lastHeartbeatAt,
        })),
      ...activeExecutionJobs
        .filter((job) =>
          [
            'queued',
            'dispatched',
            'running',
            'waiting_for_dependency',
            'waiting_for_workspace',
            'waiting_for_heavy_check',
            'waiting_for_integration',
          ].includes(job.status),
        )
        .map((job) => ({
          kind: 'execution-job',
          id: job.jobId,
          title: String(job.payload.operation ?? job.type),
          status: job.status,
          updatedAt: job.updatedAt,
        })),
    ].slice(0, 12),
    readyForReview: reviewTasks.slice(0, 12),
    pendingApprovals: [
      ...localJobs
        .filter((job) => job.status === 'pending_approval')
        .map((job) => ({
          kind: 'local-job',
          id: job.jobId,
          title: job.action,
          status: job.status,
          updatedAt: job.updatedAt,
        })),
      ...activeExecutionJobs
        .filter((job) => job.status === 'human_attention_required')
        .map((job) => ({
          kind: 'execution-job',
          id: job.jobId,
          title: String(job.payload.operation ?? job.type),
          status: job.status,
          updatedAt: job.updatedAt,
        })),
    ].slice(0, 12),
    recentlyCompleted: [
      ...runs
        .filter((run) => ['succeeded', 'cancelled'].includes(run.status))
        .map((run) => ({
          kind: 'run',
          id: run.runId,
          title: run.progress?.currentActivity ?? run.runId,
          status: run.status,
          updatedAt: run.finishedAt ?? run.lastHeartbeatAt,
        })),
      ...recentExecutionJobs
        .filter((job) => ['succeeded', 'cancelled', 'timed_out'].includes(job.status))
        .map((job) => ({
          kind: 'execution-job',
          id: job.jobId,
          title: String(job.payload.operation ?? job.type),
          status: job.status,
          updatedAt: job.updatedAt,
        })),
    ]
      .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
      .slice(0, 12),
  };
  const mcpRuntime = loadMcpServiceRuntimeState(controllerHome);
  const mcpConfig = loadMcpServiceLocalConfig(controllerHome);
  const mcpExposureContext = createControllerMcpToolContext({
    repo: repoRoot,
    controllerHome,
    profile: 'controller',
  }) as MultiRepositoryMcpToolContext;
  const exposure = controllerExposureSnapshot(mcpExposureContext);
  // mcp.runtime.json is lifecycle diagnostics only. In particular, its server
  // fields may describe a Gateway process from a prior Runtime release and
  // must never be treated as the Connector's callable schema.
  const CONNECTOR_SCHEMA_UNVERIFIED_MESSAGE = 'Connector schema is unverified until live MCP discovery completes.';
  const expectedFingerprint = exposure.fingerprint;
  // Snapshot construction is synchronous. Do not infer connector health from
  // mcp.runtime.json; only an async live MCP discovery can establish it.
  const connectorHealthy = undefined;
  const runtimeProjection = 'projection' in runtime ? runtime.projection : undefined;
  const recovery = buildCapabilityRecoverySnapshot({
    daemonStatus: runtime.daemon.status,
    daemonError: runtime.daemon.error,
    schedulerStatus: runtimeProjection
      ? runtimeProjection.queueDepth > 0 && runtimeProjection.runningWorkers === 0
        ? 'degraded'
        : 'ready'
      : undefined,
    queueDepth: runtimeProjection?.queueDepth,
    runningWorkers: runtimeProjection?.runningWorkers,
    activeLeases: runtimeProjection?.activeLeases,
    localBridgeRunning: true,
    connectorHealthy,
    connectorMismatch: CONNECTOR_SCHEMA_UNVERIFIED_MESSAGE,
    runtimeProjectionStale: false,
    runtimeProjectionPersisted: Boolean(runtimeProjection),
    commandPreviewAvailable: true,
    commandExecuteAvailable: true,
    issueToolsAvailable: !retiredLegacyControlPlane,
    jobToolsAvailable: true,
    checksAvailable: listControllerChecks(repoRoot).length > 0,
    pluginStates: assistantPlugins.map((plugin) => ({
      pluginId: plugin.pluginId,
      enabled: plugin.enabled,
      healthState: plugin.health.state,
      ready: plugin.health.ready,
      errors: plugin.health.errors,
      warnings: plugin.health.warnings,
    })),
    recentErrors: [
      ...localJobs.flatMap((job) => (job.error ? [job.error] : [])),
      ...executionJobs.flatMap((job) => (job.error?.message ? [job.error.message] : [])),
    ],
    localJobs: localJobs.map((job) => ({ status: job.status, error: job.error, updatedAt: job.updatedAt })),
    executionJobs: executionJobs.map((job) => ({
      status: job.status,
      error: job.error,
      updatedAt: job.updatedAt,
      operation: job.payload.operation,
    })),
  });
  return {
    generatedAt: new Date().toISOString(),
    repoRoot,
    toolSurface: FORGE_TOOL_SURFACE,
    schemaVersion: FORGE_MCP_SCHEMA_VERSION,
    version: FORGE_VERSION,
    toolSurfaceFingerprint: expectedFingerprint,
    connector: {
      configuredServerName: mcpConfig?.chatgpt?.serverName,
      publicEndpoint: mcpConfig?.chatgpt?.endpoint ?? mcpRuntime?.tunnel?.publicEndpoint,
      runtimeStatus: mcpRuntime?.status ?? 'not_started',
      runtimeProfile: null,
      runtimeSurface: null,
      runtimeSchemaVersion: null,
      runtimeForgeVersion: null,
      runtimeFingerprint: null,
      expectedFingerprint,
      runtimeToolset: null,
      configuredToolset: exposure.access.effectiveToolset,
      configuredAccessMode: exposure.access.configuredAccessMode,
      effectiveAccessMode: exposure.access.effectiveAccessMode,
      exposureRevision: exposure.access.exposureRevision,
      runtimeToolFingerprint: null,
      expectedRuntimeFingerprint: expectedFingerprint,
      toolCount: null,
      healthy: connectorHealthy,
      needsReconnect: mcpRuntime?.tunnel?.connectorNeedsReconnect === true,
      mismatch: CONNECTOR_SCHEMA_UNVERIFIED_MESSAGE,
    },
    timeoutPolicy: localBridgeTimeoutPolicy(repoRoot),
    runtime,
    decisionQueues,
    execution: {
      defaultMode: 'direct-edit',
      agentRunner: mcpConfig?.devMode?.agentRunner === true,
      allowedAgents: mcpConfig?.devMode?.allowedAgents ?? defaultLocalAgentRunners(),
      taskAgentBinding: false,
      localRiskApprovalGate: false,
    },
    requirementBoard,
    executionDiagnostics,
    legacyCompatibility: retiredLegacyControlPlane
      ? {
          authority: 'controller-home-sqlite',
          projection: 'deprecated_frozen',
          mutationApis: 'retired',
        }
      : undefined,
    board,
    taskLedger,
    projectState: loadControllerProjectState(repoRoot),
    governance: inspectProjectGovernance(repoRoot, requirementBoard),
    recovery,
    timeline: listControllerWorklogEvents(repoRoot, { limit: 40 }),
    githubPlugin: getGitHubPluginStatus(repoRoot),
    assistantPlugins,
    mobileIntents,
    runs,
    runCounts: runs.reduce<Record<string, number>>((counts, run) => {
      counts[run.status] = (counts[run.status] ?? 0) + 1;
      return counts;
    }, {}),
    localJobs,
    checks: listControllerChecks(repoRoot),
  };
}

type LocalControllerSnapshot = ReturnType<typeof buildLocalControllerSnapshot>;

interface UserFacingAction {
  id: string;
  label: string;
}

interface UserFacingAttentionItem {
  id: string;
  category: string;
  categoryLabel: string;
  title: string;
  reason: string;
  scope: string;
  icon: string;
  primaryAction: UserFacingAction;
  refs?: Record<string, string | undefined>;
}

function normalizePathForCompare(value: string | undefined): string {
  return String(value ?? '').replace(/\\/g, '/');
}

function displayPath(value: string | undefined): string {
  const raw = String(value ?? '');
  const home = process.env.HOME;
  return home && raw.startsWith(home) ? `~${raw.slice(home.length)}` : raw;
}

function action(id: string, label: string): UserFacingAction {
  return { id, label };
}

function userFacingRepositories(repoRoot: string, controllerHome = resolveControllerHome(), selectedRepoId?: string) {
  const currentRoot = normalizePathForCompare(repoRoot);
  return loadRepositoryRegistry(controllerHome)
    .repositories.filter((record) => !record.removedAt)
    .map((record) => {
      const checkout =
        record.checkouts.find((value) => value.checkoutId === record.activeCheckoutId) ?? record.checkouts[0];
      const current = selectedRepoId
        ? record.repoId === selectedRepoId
        : normalizePathForCompare(record.canonicalRoot) === currentRoot ||
          normalizePathForCompare(checkout?.canonicalRoot) === currentRoot;
      const status = record.enabled === false ? 'disabled' : current ? 'ready' : 'available';
      return {
        id: record.repoId,
        name: record.displayName,
        path: displayPath(checkout?.canonicalRoot ?? record.canonicalRoot),
        status,
        statusLabel: status === 'ready' ? '就绪' : status === 'available' ? '可用' : '已停用',
        current,
        defaultBranch: record.defaultBranch,
        remote: record.remoteUrl,
        updatedAt: record.updatedAt,
        lastSeenAt: record.lastSeenAt,
      };
    })
    .sort(
      (left, right) =>
        Number(right.current) - Number(left.current) ||
        String(right.lastSeenAt ?? '').localeCompare(String(left.lastSeenAt ?? '')),
    );
}

function requestRepositorySelection(request: Request, options: LocalBridgeServerOptions, controllerHome: string) {
  const body =
    request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? (request.body as Record<string, unknown>)
      : {};
  const repoId =
    queryString(request.params.repoId) ??
    queryString(request.query.repoId) ??
    queryString(body.repoId) ??
    options.defaultRepoId;
  const checkoutId =
    queryString(request.params.checkoutId) ?? queryString(request.query.checkoutId) ?? queryString(body.checkoutId);
  return resolveRepositorySelection({
    repoId,
    checkoutId,
    explicitPath: repoId ? undefined : options.repoRoot,
    controllerHome,
    allowSoleRepository: true,
  });
}

function requestRepositoryRoot(request: Request, options: LocalBridgeServerOptions, controllerHome: string): string {
  return requestRepositorySelection(request, options, controllerHome).canonicalRoot;
}

function userFacingPluginStatus(plugin: LocalControllerSnapshot['assistantPlugins'][number]) {
  const health = plugin.health;
  const lifecycle = plugin.lifecycle;
  const ready =
    plugin.enabled !== false && health.ready !== false && health.state !== 'error' && lifecycle.state !== 'error';
  const needsAuthorization = [...(health.errors ?? []), ...(health.warnings ?? []), lifecycle.reason ?? ''].some(
    (entry) => /auth|token|credential|permission|scope|授权|登录/i.test(String(entry)),
  );
  const status =
    plugin.enabled === false
      ? 'disabled'
      : ready
        ? 'ready'
        : needsAuthorization
          ? 'authorization_required'
          : health.state === 'error' || lifecycle.state === 'error'
            ? 'failed'
            : 'needs_setup';
  const nextStep =
    status === 'ready'
      ? '已连接，可用于任务执行'
      : status === 'authorization_required'
        ? '需要完成授权后才能使用'
        : status === 'disabled'
          ? '插件已禁用，可在高级配置中启用'
          : '需要配置并测试连接';
  return {
    id: plugin.pluginId,
    name: plugin.displayName || plugin.pluginId,
    provider: plugin.provider,
    status,
    statusLabel:
      status === 'ready'
        ? '可用'
        : status === 'authorization_required'
          ? '待授权'
          : status === 'failed'
            ? '测试失败'
            : status === 'disabled'
              ? '已禁用'
              : '需配置',
    enabled: plugin.enabled !== false,
    actionCount: plugin.actions.length,
    description: `${plugin.actions.length} 个可用动作`,
    nextStep,
    health: plugin.health,
    lifecycle: plugin.lifecycle,
  };
}

function userFacingAttentionItems(snapshot: LocalControllerSnapshot): UserFacingAttentionItem[] {
  const items: UserFacingAttentionItem[] = [];
  const seen = new Set<string>();
  const push = (item: UserFacingAttentionItem): void => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  };
  const queues = snapshot.decisionQueues;
  for (const entry of queues.readyForReview.slice(0, 12)) {
    const value = entry as typeof entry & Record<string, unknown>;
    push({
      id: `review:${String(value.issueId ?? value.id ?? value.title)}:${String(value.taskId ?? '')}`,
      category: 'confirm_result',
      categoryLabel: '任务待确认',
      title: String(value.title ?? '任务结果待确认'),
      reason: '任务已有可审阅结果，请直接查看实际变更和验证结果。',
      scope: '当前仓库',
      icon: '✓',
      primaryAction: action('view_advanced', '查看结果'),
      refs: {
        ...(typeof value.issueId === 'string' ? { issueId: value.issueId } : {}),
        ...(typeof value.taskId === 'string' ? { taskId: value.taskId } : {}),
      },
    });
  }
  for (const entry of queues.pendingApprovals.slice(0, 12)) {
    const value = entry as typeof entry & Record<string, unknown>;
    push({
      id: `approval:${String(value.id ?? value.title)}`,
      category: 'confirm_result',
      categoryLabel: '待授权',
      title: String(value.title ?? '操作等待授权'),
      reason: `当前状态：${String(value.status ?? 'pending')}。`,
      scope: '当前仓库',
      icon: '✓',
      primaryAction: action('view_advanced', '查看详情'),
      refs: {},
    });
  }
  for (const entry of queues.needsAttention.slice(0, 12)) {
    const value = entry as typeof entry & Record<string, unknown>;
    push({
      id: `attention:${String(value.id ?? value.title)}`,
      category: String(value.status) === 'failed' ? 'fix_failed_run' : 'needs_inspection',
      categoryLabel: String(value.status) === 'failed' ? '失败需要处理' : '需要检查',
      title: String(value.title ?? '执行需要处理'),
      reason: `当前状态：${String(value.status ?? 'unknown')}。`,
      scope: '当前仓库',
      icon: String(value.status) === 'failed' ? '!' : '?',
      primaryAction: action('view_advanced', '查看诊断'),
      refs: {},
    });
  }
  for (const plugin of snapshot.assistantPlugins
    .map(userFacingPluginStatus)
    .filter((entry) => ['authorization_required', 'failed', 'needs_setup'].includes(entry.status))
    .slice(0, 8)) {
    push({
      id: `plugin:${plugin.id}`,
      category: 'connect_plugin',
      categoryLabel: '插件待授权',
      title: `${plugin.name} ${plugin.statusLabel}`,
      reason: plugin.nextStep,
      scope: '能力中心',
      icon: '✣',
      primaryAction: action('configure_plugins', '去配置'),
      refs: { pluginId: plugin.id },
    });
  }
  const issues = Array.isArray(snapshot.board.issues) ? snapshot.board.issues : [];
  for (const issue of issues.slice(0, 40)) {
    const tasks = Array.isArray(issue.tasks) ? issue.tasks : [];
    for (const task of tasks) {
      const effectiveStatus = String(
        (task as Record<string, unknown>).effectiveStatus ?? (task as Record<string, unknown>).status ?? '',
      );
      if (effectiveStatus !== 'changes_requested') continue;
      push({
        id: `changes:${issue.id}:${String((task as Record<string, unknown>).id ?? '')}`,
        category: 'changes_requested',
        categoryLabel: '已打回等待修改',
        title: String((task as Record<string, unknown>).title ?? issue.title ?? '任务等待修改'),
        reason: '该任务已经被打回，不应该继续显示成待审批。',
        scope: String(issue.title ?? issue.id),
        icon: '↩',
        primaryAction: action('start_task', '继续修改'),
        refs: { issueId: String(issue.id), taskId: String((task as Record<string, unknown>).id ?? '') },
      });
    }
  }
  return items.slice(0, 24);
}

function userFacingRecentTasks(snapshot: LocalControllerSnapshot) {
  const queues = snapshot.decisionQueues;
  const fromRunning = queues.runningNow.map((item) => {
    const value = item as typeof item & Record<string, unknown>;
    return {
      id: String(value.id ?? value.runId ?? value.taskId ?? value.title),
      title: String(value.title ?? '执行中的任务'),
      summary: '助手正在处理，请等待下一步结果。',
      status: 'running',
      actor: 'G',
      updatedAt: item.updatedAt,
    };
  });
  const fromCompleted = queues.recentlyCompleted.map((item) => {
    const value = item as typeof item & Record<string, unknown>;
    return {
      id: String(value.id ?? value.runId ?? value.taskId ?? value.title),
      title: String(value.title ?? '已完成任务'),
      summary: String(item.status) === 'cancelled' ? '任务已取消。' : '任务已经完成，可在历史中查看凭证。',
      status: String(item.status) === 'cancelled' ? 'attention' : 'completed',
      actor: 'G',
      updatedAt: item.updatedAt,
    };
  });
  const fromAttention = userFacingAttentionItems(snapshot)
    .slice(0, 3)
    .map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.reason,
      status: 'attention',
      actor: 'G',
      updatedAt: undefined,
    }));
  return [...fromRunning, ...fromCompleted, ...fromAttention].slice(0, 8);
}

function buildUserControllerExperienceSnapshot(
  repoRoot: string,
  controllerHome = resolveControllerHome(),
  selectedRepoId?: string,
) {
  const snapshot = cachedLocalControllerSnapshot(repoRoot);
  const repositories = userFacingRepositories(repoRoot, controllerHome, selectedRepoId);
  const currentRepository = repositories.find((entry) => entry.current) ?? repositories[0];
  const plugins = snapshot.assistantPlugins.map(userFacingPluginStatus);
  const readyPlugins = plugins.filter((plugin) => plugin.status === 'ready');
  const attentionItems = userFacingAttentionItems(snapshot);
  const blocked = snapshot.recovery.overallState === 'blocked' || snapshot.recovery.overallState === 'unavailable';
  const needsSetup = !currentRepository || currentRepository.status !== 'ready';
  const readinessState = blocked ? 'blocked' : needsSetup ? 'needs_setup' : 'ready';
  const recommendation = needsSetup
    ? {
        title: '先选择或注册一个仓库',
        description: '仓库可用后才能执行任务。',
        action: action('manage_repositories', '管理仓库'),
      }
    : attentionItems.length > 0
      ? {
          title: '先处理高优先级事项',
          description: `有 ${attentionItems.length} 项需要你处理，处理后助手即可继续推进。`,
          action: action('handle_attention', '处理待办'),
        }
      : readyPlugins.length < plugins.length
        ? {
            title: '补全插件能力',
            description: '核心仓库能力可用，但部分助手能力还未连接。',
            action: action('configure_plugins', '配置插件'),
          }
        : {
            title: '创建一个新任务，让助手为你完成工作',
            description: '当前系统可用，你可以直接输入自然语言任务。',
            action: action('start_task', '执行一个任务'),
          };
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    readiness: {
      state: readinessState,
      label: readinessState === 'ready' ? '系统就绪' : readinessState === 'needs_setup' ? '需要设置' : '系统阻塞',
      title:
        readinessState === 'ready' ? '系统可用' : readinessState === 'needs_setup' ? '需要完成设置' : '系统暂不可用',
      description: currentRepository
        ? `仓库 ${currentRepository.name} ${readinessState === 'ready' ? '已就绪，可接受任务与调度检查' : '需要处理后才能执行任务'}`
        : '请先添加一个本地仓库。',
      chips: [
        { label: snapshot.execution.defaultMode === 'direct-edit' ? '直接执行模式' : '执行模式已设置', tone: 'green' },
        {
          label: snapshot.runtime.registered ? '环境就绪' : '仓库未注册',
          tone: snapshot.runtime.registered ? 'green' : 'amber',
        },
        {
          label:
            snapshot.connector.healthy === true
              ? '权限充足'
              : snapshot.connector.healthy === false
                ? '连接异常'
                : '连接待验证',
          tone: snapshot.connector.healthy === true ? 'green' : 'amber',
        },
        { label: '安全防护已启用', tone: 'green' },
      ],
      primaryAction: recommendation.action,
    },
    currentRepository,
    repositories,
    pluginSummary: {
      ready: readyPlugins.length,
      total: plugins.length,
      lines: plugins.slice(0, 5).map((plugin) => `${plugin.name}  ${plugin.statusLabel}`),
    },
    plugins,
    attentionItems,
    recommendation,
    recentTasks: userFacingRecentTasks(snapshot),
  };
}

export async function startLocalBridgeServer(options: LocalBridgeServerOptions): Promise<LocalBridgeServerHandle> {
  const repositoryControllerHome = resolveRepoPreferredControllerHome(options.repoRoot, options.controllerHome);
  const repository = registerRepository({ path: options.repoRoot, controllerHome: repositoryControllerHome });
  ensureRepositoryRuntimeStorage(repository, repositoryControllerHome);
  const repoRoot = repository.canonicalRoot;
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 8766;
  const controllerHome = repositoryControllerHome;
  const mcpExposureContext = createControllerMcpToolContext({
    repo: repoRoot,
    controllerHome,
    profile: 'controller',
  }) as MultiRepositoryMcpToolContext;
  assertAllowedBindHost(host, options.allowLanMobileIntents === true);
  reconcileAgentJobs(repoRoot);
  reconcileLocalBridgeJobs(repoRoot);
  const token = options.token ?? randomBytes(32).toString('base64url');
  const app = express();
  const streamClients = new Map<Response, { repoRoot: string; signature: string }>();
  let streamIdleTicks = 0;
  const sendStreamEvent = (response: Response, type: string): void => {
    response.write(`event: ${type}\n`);
    response.write(`data: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  };
  const streamInterval = setInterval(() => {
    if (streamClients.size === 0) return;
    let refreshed = false;
    for (const [client, state] of streamClients) {
      const next = controllerStateSignature(state.repoRoot);
      if (next !== state.signature) {
        streamClients.set(client, { ...state, signature: next });
        sendStreamEvent(client, 'refresh');
        refreshed = true;
      }
    }
    if (refreshed) {
      streamIdleTicks = 0;
      return;
    }
    streamIdleTicks += 1;
    if (streamIdleTicks >= 8) {
      streamIdleTicks = 0;
      for (const client of streamClients.keys()) sendStreamEvent(client, 'heartbeat');
    }
  }, 2_000);
  streamInterval.unref();
  const cookieName = 'forge_local_token';
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    const requestHost = parsedRequestHost(request.headers.host);
    const mobileIntentPath = request.path === '/mobile/intent' || request.path.startsWith('/mobile/');
    if (!requestHost) {
      response.status(403).json({ error: 'invalid local controller host' });
      return;
    }
    if (!isLoopbackHostname(requestHost.hostname) && !(options.allowLanMobileIntents === true && mobileIntentPath)) {
      response.status(403).json({ error: 'invalid local controller host' });
      return;
    }
    const origin = request.headers.origin;
    if (origin) {
      try {
        const parsedOrigin = new URL(origin);
        if (
          parsedOrigin.host !== requestHost.host ||
          (!isLoopbackHostname(parsedOrigin.hostname) && !(options.allowLanMobileIntents === true && mobileIntentPath))
        ) {
          response.status(403).json({ error: 'invalid local controller origin' });
          return;
        }
      } catch (_error) {
        response.status(403).json({ error: 'invalid local controller origin' });
        return;
      }
    }
    next();
  });
  app.use(
    express.json({
      limit: '512kb',
      verify: (request, _response, buffer) => {
        (request as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
      },
    }),
  );

  const requireToken = (request: Request, response: Response, next: NextFunction): void => {
    const supplied = request.header('x-forge-local-token') ?? cookieValue(request, cookieName);
    if (supplied !== token) {
      response.status(403).json({ error: 'invalid local controller token' });
      return;
    }
    next();
  };

  app.get('/health', (_request, response) => {
    const exposure = controllerExposureSnapshot(mcpExposureContext);
    const fingerprint = exposure.fingerprint;
    const runtime = readRuntimeGeneration(controllerHome);
    response.json({
      status: 'ok',
      localOnly: true,
      mode: options.mode ?? 'standalone',
      ...(options.slot ? { slot: options.slot } : {}),
      toolSurface: FORGE_TOOL_SURFACE,
      schemaVersion: FORGE_MCP_SCHEMA_VERSION,
      version: FORGE_VERSION,
      toolSurfaceFingerprint: fingerprint,
      runtimeToolSurfaceFingerprint: fingerprint,
      generation: runtime?.generation,
      source: runtime?.source,
      toolset: exposure.access.effectiveToolset,
      configuredAccessMode: exposure.access.configuredAccessMode,
      effectiveAccessMode: exposure.access.effectiveAccessMode,
      effectiveToolset: exposure.access.effectiveToolset,
      accessModeSource: exposure.access.source,
      accessModeLastAppliedAt: exposure.access.lastAppliedAt,
      exposureRevision: exposure.access.exposureRevision,
      toolCount: exposure.toolNames.length,
    });
  });

  app.post('/mobile/v1/monitor/snapshot', (request, response) => {
    try {
      const selected = repository;
      const verified = withMobileIntentStoreLock(controllerHome, selected.repoId, () =>
        verifyMobileIntentRequest(selected.canonicalRoot, request),
      );
      if (!mobileIntentHasScope(verified.principal.scopes, 'monitor:read')) {
        throw new Error('MOBILE_INTENT_SCOPE_DENIED: monitor:read is required');
      }
      response.setHeader('Cache-Control', 'no-store');
      response.json({
        ...buildMobileMonitorSnapshot({
          controllerHome,
          repoId: selected.repoId,
          repoRoot: selected.canonicalRoot,
          repositoryName: selected.displayName,
        }),
        device: verified.principal.device,
        signatureVerified: verified.signatureVerified,
      });
    } catch (error) {
      sendMobileIntentFailure(response, error);
    }
  });

  app.get('/mobile/v1/monitor/events', (request, response) => {
    try {
      const selected = repository;
      const verified = withMobileIntentStoreLock(controllerHome, selected.repoId, () =>
        verifyMobileIntentRequest(selected.canonicalRoot, request),
      );
      if (!mobileIntentHasScope(verified.principal.scopes, 'monitor:read')) {
        throw new Error('MOBILE_INTENT_SCOPE_DENIED: monitor:read is required');
      }
      response.status(200);
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader('Cache-Control', 'no-cache, no-transform');
      response.setHeader('Connection', 'keep-alive');
      response.flushHeaders();
      streamClients.set(response, { repoRoot, signature: controllerStateSignature(repoRoot) });
      sendStreamEvent(response, 'ready');
      request.on('close', () => streamClients.delete(response));
    } catch (error) {
      sendMobileIntentFailure(response, error);
    }
  });

  app.post('/mobile/intent', async (request, response) => {
    try {
      const verified = withMobileIntentStoreLock(controllerHome, repository.repoId, () =>
        verifyMobileIntentRequest(repository.canonicalRoot, request),
      );
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const intent = queryString(body.intent) ?? 'plugin_action';
      if (intent === 'list_plugins') {
        if (!mobileIntentHasScope(verified.principal.scopes, 'plugins:read'))
          throw new Error('MOBILE_INTENT_SCOPE_DENIED: plugins:read is required');
        response.json({
          schemaVersion: 1,
          accepted: true,
          device: verified.principal.device,
          signatureVerified: verified.signatureVerified,
          // One canonical store; mobile discovery includes both repository and controller-scoped plugins.
          plugins: [
            ...new Map(
              [
                ...listAssistantPluginManifests(controllerHome, repository),
                ...listControllerPluginManifests(controllerHome),
              ].map((plugin) => [plugin.pluginId, plugin] as const),
            ).values(),
          ].map((plugin) => ({
            pluginId: plugin.pluginId,
            displayName: plugin.displayName,
            enabled: plugin.enabled,
            lifecycle: plugin.lifecycle,
            health: plugin.health,
            actions: plugin.actions.map((action) => ({
              actionId: action.actionId,
              title: action.title,
              readOnly: action.readOnly,
              risk: action.risk,
              confirmation: action.confirmation,
              requiredConfirmationText: action.requiredConfirmationText,
            })),
          })),
        });
        return;
      }
      if (intent === 'get_plugin') {
        if (!mobileIntentHasScope(verified.principal.scopes, 'plugins:read'))
          throw new Error('MOBILE_INTENT_SCOPE_DENIED: plugins:read is required');
        const pluginId = queryString(body.pluginId);
        if (!pluginId) throw new Error('MOBILE_INTENT_PLUGIN_REQUIRED: pluginId is required');
        response.json({
          schemaVersion: 1,
          accepted: true,
          device: verified.principal.device,
          signatureVerified: verified.signatureVerified,
          plugin: getAssistantPluginManifest(controllerHome, repository, pluginId),
        });
        return;
      }
      if (intent === 'poll_job') {
        if (!mobileIntentHasScope(verified.principal.scopes, 'jobs:read'))
          throw new Error('MOBILE_INTENT_SCOPE_DENIED: jobs:read is required');
        const jobId = queryString(body.jobId);
        if (!jobId) throw new Error('MOBILE_INTENT_JOB_REQUIRED: jobId is required');
        const job =
          findExecutionJob(controllerHome, jobId) ??
          (() => {
            const receipt = findPluginActionReceipt(controllerHome, jobId);
            return receipt ? compatibilityPluginJobFromReceipt(receipt) : undefined;
          })();
        if (!job) {
          response.status(404).json({ error: `Execution Job not found: ${jobId}` });
          return;
        }
        response.json({
          schemaVersion: 1,
          accepted: true,
          device: verified.principal.device,
          signatureVerified: verified.signatureVerified,
          job,
        });
        return;
      }
      if (intent === 'workflow_event') {
        if (!verified.signatureVerified)
          throw new Error('MOBILE_INTENT_SIGNATURE_REQUIRED: workflow events require an HMAC signature');
        if (!mobileIntentHasScope(verified.principal.scopes, `workflow:${AGENTMAIL_EVENT_WORKFLOW_ID}:execute`)) {
          throw new Error(`MOBILE_INTENT_SCOPE_DENIED: workflow:${AGENTMAIL_EVENT_WORKFLOW_ID}:execute is required`);
        }
        if (Object.keys(body).some((key) => !['intent', 'event'].includes(key))) {
          throw new Error('MOBILE_INTENT_EVENT_FIELDS_INVALID: only intent and event are accepted');
        }
        const event =
          body.event && typeof body.event === 'object' && !Array.isArray(body.event)
            ? (body.event as Record<string, unknown>)
            : {};
        const allowedEventFields = new Set(['source', 'event_id', 'observed_at', 'ref', 'summary', 'route']);
        const unknownFields = Object.keys(event).filter((key) => !allowedEventFields.has(key));
        if (unknownFields.length > 0)
          throw new Error('MOBILE_INTENT_EVENT_FIELD_UNSUPPORTED: ' + unknownFields.sort().join(','));
        const isRecord = (value: unknown): value is Record<string, unknown> =>
          value !== null && typeof value === 'object' && !Array.isArray(value);
        const isString = (value: unknown, maximum: number, allowEmpty = false): value is string =>
          typeof value === 'string' && value.length <= maximum && (allowEmpty || value.length > 0);
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const ref = isRecord(event.ref) ? event.ref : {};
        const eventSummary = isRecord(event.summary) ? event.summary : {};
        const unknownRefFields = Object.keys(ref).filter(
          (key) => !['provider', 'account_id', 'provider_message_id'].includes(key),
        );
        const unknownSummaryFields = Object.keys(eventSummary).filter(
          (key) => !['rule_id', 'sender_email'].includes(key),
        );
        if (unknownRefFields.length > 0 || unknownSummaryFields.length > 0) {
          const unsupported = [
            ...unknownRefFields.map((key) => 'ref.' + key),
            ...unknownSummaryFields.map((key) => 'summary.' + key),
          ];
          throw new Error('MOBILE_INTENT_EVENT_FIELD_UNSUPPORTED: ' + unsupported.sort().join(','));
        }
        const source = event.source;
        const eventId = event.event_id;
        const observedAt = event.observed_at;
        const provider = ref.provider;
        const accountId = ref.account_id;
        const providerMessageId = ref.provider_message_id;
        const ruleId = eventSummary.rule_id;
        const senderEmail = eventSummary.sender_email;
        if (source !== 'mail.watch.matched')
          throw new Error('MOBILE_INTENT_EVENT_SOURCE_INVALID: only AgentMail Watch matches are accepted');
        if (!isString(eventId, 4096)) throw new Error('MOBILE_INTENT_EVENT_ID_INVALID');
        if (!isString(observedAt, 64) || !Number.isFinite(Date.parse(observedAt)))
          throw new Error('MOBILE_INTENT_EVENT_TIME_INVALID');
        if (provider !== 'agentmail' || !isString(accountId, 36) || !uuid.test(accountId)) {
          throw new Error('MOBILE_INTENT_EVENT_ACCOUNT_INVALID');
        }
        if (!isString(providerMessageId, 1024)) throw new Error('MOBILE_INTENT_EVENT_MESSAGE_INVALID');
        if (!isString(ruleId, 36) || !uuid.test(ruleId)) throw new Error('MOBILE_INTENT_EVENT_RULE_INVALID');
        if (!isString(senderEmail, 320, true)) throw new Error('MOBILE_INTENT_EVENT_SENDER_INVALID');
        let route: ReturnType<typeof resolveAgentMailAppCaseRoute> | undefined;
        if (event.route !== undefined) {
          if (
            !isRecord(event.route) ||
            Object.keys(event.route).length !== 1 ||
            !isString(event.route.app_id, 10) ||
            !/^\d{10}$/.test(event.route.app_id)
          ) {
            throw new Error('MOBILE_INTENT_EVENT_ROUTE_INVALID');
          }
          route = resolveAgentMailAppCaseRoute(event.route.app_id);
        }
        const eventEnvelope = normalizeAgentMailWatchEvent(
          {
            source,
            event_id: eventId,
            observed_at: observedAt,
            ref: {
              provider,
              account_id: accountId,
              provider_message_id: providerMessageId,
            },
            summary: {
              rule_id: ruleId,
              sender_email: senderEmail,
            },
          },
          // AgentMail's persisted observed_at is stable across Outbox retries.
          { receivedAt: observedAt },
        );
        const workflowInputs: Record<string, unknown> = {
          source,
          event_id: eventId,
          observed_at: observedAt,
          ref: {
            provider,
            account_id: accountId,
            provider_message_id: providerMessageId,
          },
          summary: {
            rule_id: ruleId,
            sender_email: senderEmail,
          },
          event_envelope: eventEnvelope,
        };
        if (route) workflowInputs.route = route;
        const workflowRunId = `agentmail-${createHash('sha256').update(eventId).digest('hex').slice(0, 40)}`;
        const workflowArguments = {
          workflow_id: AGENTMAIL_EVENT_WORKFLOW_ID,
          workflow_run_id: workflowRunId,
          workflow_inputs: workflowInputs,
        };
        const reconciliationRequestId = `agentmail-reconcile-${createHash('sha256').update(eventId).digest('hex').slice(0, 40)}`;
        let dispatched = await callRhProjectWorkflowOperation(
          mcpExposureContext,
          repository,
          'workflow_execute',
          workflowArguments,
        );
        let dispatchResult = dispatched?.structuredContent as Record<string, unknown> | undefined;
        let dispatchData =
          dispatchResult?.data && typeof dispatchResult.data === 'object'
            ? (dispatchResult.data as Record<string, unknown>)
            : {};
        let workflow =
          dispatchData.workflow && typeof dispatchData.workflow === 'object'
            ? (dispatchData.workflow as Record<string, unknown>)
            : undefined;
        let summary =
          typeof dispatchResult?.summary === 'string' ? dispatchResult.summary : 'WORKFLOW_EVENT_RECEIPT_FAILED';
        let durable =
          Boolean(workflow) ||
          summary.startsWith('WORKFLOW_RUN_RECONCILIATION_REQUIRED:') ||
          summary === 'WORKFLOW_RUN_FAILED_RESTART_REQUIRES_NEW_RUN_ID' ||
          summary === 'WORKFLOW_RUN_ALREADY_SUCCEEDED' ||
          summary === 'WORKFLOW_RUN_IDENTITY_CONFLICT';
        let recovered = false;

        // A duplicate delivery can be the recovery signal after the Process finished but
        // the WorkflowRun checkpoint/HTTP ACK was interrupted. Reconcile only from the
        // canonical Process receipt; never dispatch the uncertain script a second time.
        if (
          workflow?.status === 'reconcile_required' ||
          (!workflow && summary.startsWith('WORKFLOW_RUN_RECONCILIATION_REQUIRED:'))
        ) {
          recovered = true;
          dispatched = await callRhProjectWorkflowOperation(mcpExposureContext, repository, 'workflow_reconcile', {
            ...workflowArguments,
            workflow_reconciliation_request_id: reconciliationRequestId,
          });
          dispatchResult = dispatched?.structuredContent as Record<string, unknown> | undefined;
          dispatchData =
            dispatchResult?.data && typeof dispatchResult.data === 'object'
              ? (dispatchResult.data as Record<string, unknown>)
              : {};
          workflow =
            dispatchData.workflow && typeof dispatchData.workflow === 'object'
              ? (dispatchData.workflow as Record<string, unknown>)
              : undefined;
          summary =
            typeof dispatchResult?.summary === 'string'
              ? dispatchResult.summary
              : 'WORKFLOW_EVENT_RECONCILIATION_FAILED';
          durable = durable || Boolean(workflow);
        }

        // AgentMail ACKs only after the exact event has a succeeded canonical WorkflowRun.
        // A persisted failed/running/reconcile-required record remains unacknowledged in
        // the source Outbox so it can retry or surface for recovery.
        if (workflow?.status === 'succeeded') {
          response.status(202).json({
            schemaVersion: 1,
            accepted: true,
            durable: true,
            deduplicated: recovered,
            device: verified.principal.device,
            signatureVerified: verified.signatureVerified,
            workflowId: AGENTMAIL_EVENT_WORKFLOW_ID,
            workflowRunId,
            eventId,
            status: 'succeeded',
          });
          return;
        }
        if (summary === 'WORKFLOW_RUN_ALREADY_SUCCEEDED') {
          response.status(202).json({
            schemaVersion: 1,
            accepted: true,
            durable: true,
            deduplicated: true,
            device: verified.principal.device,
            signatureVerified: verified.signatureVerified,
            workflowId: AGENTMAIL_EVENT_WORKFLOW_ID,
            workflowRunId,
            eventId,
            status: 'succeeded',
          });
          return;
        }
        const conflict = summary === 'WORKFLOW_RUN_IDENTITY_CONFLICT';
        response.status(conflict ? 409 : 503).json({
          schemaVersion: 1,
          accepted: false,
          durable,
          device: verified.principal.device,
          signatureVerified: verified.signatureVerified,
          error: summary,
          workflowId: AGENTMAIL_EVENT_WORKFLOW_ID,
          workflowRunId,
          eventId,
          status: typeof workflow?.status === 'string' ? workflow.status : summary,
        });
        return;
      }
      if (intent !== 'plugin_action') throw new Error(`MOBILE_INTENT_UNSUPPORTED: ${intent}`);
      const pluginId = queryString(body.pluginId);
      const actionId = queryString(body.actionId);
      if (!pluginId || !actionId) throw new Error('MOBILE_INTENT_ACTION_REQUIRED: pluginId and actionId are required');
      if (!mobileIntentHasScope(verified.principal.scopes, `plugin:${pluginId}:${actionId}`)) {
        throw new Error(`MOBILE_INTENT_SCOPE_DENIED: plugin:${pluginId}:${actionId} is required`);
      }
      const manifest = getAssistantPluginManifest(controllerHome, repository, pluginId);
      const action = manifest.actions.find((entry) => entry.actionId === actionId);
      if (!action) throw new Error(`PLUGIN_ACTION_NOT_FOUND: ${pluginId}/${actionId}`);
      if (action.confirmation !== 'none' && body.confirmAuthorization !== true) {
        response.status(409).json({
          schemaVersion: 1,
          accepted: false,
          approvalRequired: true,
          device: verified.principal.device,
          plugin: {
            pluginId,
            displayName: manifest.displayName,
            enabled: manifest.enabled,
            lifecycle: manifest.lifecycle,
            health: manifest.health,
          },
          action: {
            actionId: action.actionId,
            risk: action.risk,
            confirmation: action.confirmation,
            requiredConfirmationText: action.requiredConfirmationText,
          },
          message:
            action.confirmation === 'strong_confirmation'
              ? `Repeat the request with confirmAuthorization=true and confirmationText=${action.requiredConfirmationText}`
              : 'Repeat the request with confirmAuthorization=true after human approval.',
        });
        return;
      }
      const submitted = await submitAssistantPluginAction(
        controllerHome,
        repository,
        {
          pluginId,
          actionId,
          requestId: queryString(body.requestId) ?? `${verified.principal.deviceId}:${Date.now()}`,
          args:
            body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)
              ? (body.arguments as Record<string, unknown>)
              : {},
          timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
          confirmAuthorization: body.confirmAuthorization === true,
          confirmationText: queryString(body.confirmationText),
          origin: {
            surface: 'mobile-intent',
            actor: verified.principal.deviceId,
            correlationId: queryString(body.requestId),
          },
        },
        { githubIssueSync: githubIssueSyncPort },
      );
      response.status(202).json({
        schemaVersion: 1,
        accepted: true,
        deduplicated: submitted.deduplicated,
        device: verified.principal.device,
        signatureVerified: verified.signatureVerified,
        pollAfterMs: 2_000,
        plugin: {
          pluginId: submitted.manifest.pluginId,
          displayName: submitted.manifest.displayName,
          lifecycle: submitted.manifest.lifecycle,
          health: submitted.manifest.health,
        },
        action: {
          actionId: submitted.action.actionId,
          risk: submitted.action.risk,
          confirmation: submitted.action.confirmation,
          requiredConfirmationText: submitted.action.requiredConfirmationText,
        },
        job: submitted.job,
      });
    } catch (error) {
      sendMobileIntentFailure(response, error);
    }
  });

  app.get('/oauth/google/callback', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const result = await completeGoogleOAuthLogin(controllerHome, {
        state: queryString(request.query.state),
        code: queryString(request.query.code),
        error: queryString(request.query.error),
        errorDescription: queryString(request.query.error_description),
      });
      response
        .status(200)
        .type('html')
        .send(
          `<!doctype html><meta charset="utf-8"><title>Google authorization complete</title><h1>Google authorization complete</h1><p>${String(result.service)} is connected. You can close this window.</p>`,
        );
    } catch (error) {
      response
        .status(400)
        .type('html')
        .send(
          `<!doctype html><meta charset="utf-8"><title>Google authorization failed</title><h1>Google authorization failed</h1><p>${errorMessage(error).replace(/[<>&]/g, '')}</p>`,
        );
    }
  });

  app.get('/oauth/resend/callback', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      await completeResendOAuthLogin(controllerHome, {
        state: queryString(request.query.state),
        code: queryString(request.query.code),
        error: queryString(request.query.error),
        errorDescription: queryString(request.query.error_description),
      });
      response
        .status(200)
        .type('html')
        .send(
          '<!doctype html><meta charset="utf-8"><title>Resend authorization complete</title><h1>Resend authorization complete</h1><p>Forge is connected to Resend. You can close this window.</p>',
        );
    } catch (error) {
      response
        .status(400)
        .type('html')
        .send(
          `<!doctype html><meta charset="utf-8"><title>Resend authorization failed</title><h1>Resend authorization failed</h1><p>${errorMessage(error).replace(/[<>&]/g, '')}</p>`,
        );
    }
  });

  app.use('/api', requireToken);

  const consoleCtx = (request: Request) => {
    const repository = requestRepositorySelection(request, options, controllerHome);
    return { controllerHome, repository };
  };

  app.get('/api/console/command-center', async (request, response) => {
    try {
      const ctx = consoleCtx(request);
      const repositories = userFacingRepositories(
        ctx.repository.canonicalRoot,
        controllerHome,
        ctx.repository.repoId,
      ).map((entry) => {
        const record = loadRepositoryRegistry(controllerHome).repositories.find((item) => item.repoId === entry.id);
        if (!record) {
          return {
            id: entry.id,
            name: entry.name,
            path: entry.path,
            statusLabel: entry.statusLabel,
            tone: entry.current ? ('green' as const) : ('blue' as const),
            current: entry.current,
          };
        }
        return mapRepositoryCard(record, entry.current);
      });
      response.json(await buildCommandCenter(ctx, repositories));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/console/requirements', (_request, response) => {
    try {
      response.json(buildRequirementBoard({ controllerHome }));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/console/automations', (_request, response) => {
    try {
      const repositories = loadRepositoryRegistry(controllerHome).repositories;
      const automations = listConsoleAutomations(controllerHome, repositories);
      response.json({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        summary: summarizeConsoleAutomations(automations),
        automations,
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post('/api/console/automations/:source/:repoId/:automationId/:action', async (request, response) => {
    try {
      const result = await applyConsoleAutomationAction(
        controllerHome,
        loadRepositoryRegistry(controllerHome).repositories,
        String(request.params.source ?? ''),
        String(request.params.repoId ?? ''),
        String(request.params.automationId ?? ''),
        String(request.params.action ?? ''),
      );
      response.json({ result });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/console/readiness', async (request, response) => {
    try {
      response.json(await buildSystemReadiness(consoleCtx(request)));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  /** User-facing plugin/capability catalog for the console. */
  app.get('/api/console/plugins', (request, response) => {
    try {
      const ctx = consoleCtx(request);
      const plugins = listConsolePlugins(ctx);
      response.json({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        summary: buildPluginSummary(plugins),
        plugins,
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/console/plugins/:pluginId', (request, response) => {
    try {
      const plugin = getConsolePlugin(consoleCtx(request), request.params.pluginId);
      if (!plugin) {
        response.status(404).json({ error: `PLUGIN_NOT_FOUND: ${request.params.pluginId}` });
        return;
      }
      response.json({ schemaVersion: 1, plugin });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  /** Local MCP tool-surface self-test. Does not invent ChatGPT connector tool names. */
  app.get('/api/console/connector/status', async (request, response) => {
    try {
      const report = await evaluateConsoleConnectorFreshness(consoleCtx(request));
      response.json({
        responseSchemaVersion: 1,
        generatedAt: new Date().toISOString(),
        ...report,
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  /**
   * Optional precise check when ChatGPT connector tool names are known.
   * Body: { connector_tool_names?: string[] }
   */
  app.post('/api/console/connector/check', async (request, response) => {
    try {
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const connectorToolNames = Array.isArray(body.connector_tool_names)
        ? body.connector_tool_names.map(String)
        : Array.isArray(body.connectorToolNames)
          ? body.connectorToolNames.map(String)
          : undefined;
      const report = await evaluateConsoleConnectorFreshness(consoleCtx(request), {
        connectorToolNames,
      });
      response.json({
        responseSchemaVersion: 1,
        generatedAt: new Date().toISOString(),
        connectorToolNamesProvided: connectorToolNames !== undefined,
        ...report,
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/console/access-policy', (request, response) => {
    try {
      response.json(getConsoleAccessPolicy(consoleCtx(request)));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post('/api/console/access-policy', (request, response) => {
    try {
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      response.json(
        setConsoleAccessPolicy(consoleCtx(request), {
          mode: body.mode,
          confirmAuthorization: body.confirmAuthorization === true,
          confirmationText: queryString(body.confirmationText),
        }),
      );
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/console/inbox', (request, response) => {
    try {
      const status =
        queryString(request.query.status) === 'all'
          ? 'all'
          : queryString(request.query.status) === 'active'
            ? 'active'
            : 'pending';
      response.json({ items: listConsoleHandoffs(consoleCtx(request), status) });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/console/inbox/:handoffId', (request, response) => {
    try {
      const item = getConsoleHandoff(consoleCtx(request), String(request.params.handoffId ?? ''));
      if (!item) {
        response.status(404).json({ error: 'handoff not found' });
        return;
      }
      response.json({ item });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post('/api/console/inbox/:handoffId/ack', (request, response) => {
    try {
      response.json({ item: ackConsoleHandoff(consoleCtx(request), String(request.params.handoffId ?? '')) });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post('/api/console/inbox/:handoffId/approve', async (request, response) => {
    try {
      const result = await approveConsoleHandoff(consoleCtx(request), String(request.params.handoffId ?? ''), 'user');
      response.status(200).json({
        ...result,
        phase: 'succeeded',
        statusLabel: '已记录决定',
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post('/api/console/inbox/:handoffId/resolve', async (request, response) => {
    try {
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      response.json({
        item: await resolveConsoleHandoff(
          consoleCtx(request),
          String(request.params.handoffId ?? ''),
          queryString(body.decision) ?? 'resolved',
          queryString(body.resolver) ?? 'user',
        ),
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post('/api/console/inbox/:handoffId/dismiss', (request, response) => {
    try {
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      response.json({
        item: dismissConsoleHandoff(
          consoleCtx(request),
          String(request.params.handoffId ?? ''),
          queryString(body.decision) ?? 'dismissed',
          queryString(body.resolver) ?? 'user',
        ),
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post('/api/console/repair', (request, response) => {
    try {
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const operation = queryString(body.operation);
      const result = repairConsole(consoleCtx(request), {
        operation:
          operation === 'repair' || operation === 'verify' || operation === 'handoff' || operation === 'diagnose'
            ? operation
            : 'diagnose',
        dryRun: body.dryRun === undefined ? true : body.dryRun === true,
        approvalConfirmed: body.approvalConfirmed === true,
        destructive: body.destructive === true,
      });
      response.status(result.status === 'approval_required' || result.status === 'blocked' ? 409 : 200).json({
        ...result,
        phase:
          result.status === 'ok' ? 'succeeded' : result.status === 'approval_required' ? 'needs_attention' : 'failed',
        statusLabel:
          result.status === 'ok' ? '已完成' : result.status === 'approval_required' ? '需要确认' : '需要处理',
        terminal: true,
      });
    } catch (error) {
      response.status(400).json({
        error: errorMessage(error),
        errorClass: 'unknown_failure',
        summary: errorMessage(error) || '操作失败，但未提供详细错误。',
        phase: 'failed',
        statusLabel: '失败',
      });
    }
  });

  app.post('/api/console/edit/apply', (request, response) => {
    try {
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const unsupportedFields = Object.keys(body).filter(
        (key) => !['operations', 'purpose', 'allowedPaths'].includes(key),
      );
      if (unsupportedFields.length > 0) {
        response.status(400).json({
          error: 'unsupported console edit fields: ' + unsupportedFields.join(', '),
          errorClass: 'invalid_request',
          summary: 'Only operations, purpose, and allowedPaths are accepted.',
          phase: 'failed',
          statusLabel: '失败',
          terminal: true,
        });
        return;
      }
      const applied = applyConsoleSafePatch(consoleCtx(request), {
        operations: body.operations,
        purpose: queryString(body.purpose),
        allowedPaths: Array.isArray(body.allowedPaths) ? body.allowedPaths.map(String) : undefined,
      });
      response.status(applied.phase === 'failed' ? 409 : 200).json(applied);
    } catch (error) {
      response.status(400).json({
        error: errorMessage(error),
        errorClass: 'unknown_failure',
        summary: errorMessage(error) || '同步修改失败。',
        phase: 'failed',
        statusLabel: '失败',
        terminal: true,
      });
    }
  });

  app.get('/api/console/advanced', async (request, response) => {
    try {
      const ctx = consoleCtx(request);
      const raw = cachedLocalControllerSnapshot(ctx.repository.canonicalRoot);
      response.json(await buildAdvancedDiagnosticsEnvelope(raw, ctx));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/snapshot', (request, response) => {
    try {
      response.json(cachedLocalControllerSnapshot(requestRepositoryRoot(request, options, controllerHome)));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get('/api/user-snapshot', (request, response) => {
    try {
      const repository = requestRepositorySelection(request, options, controllerHome);
      response.json(buildUserControllerExperienceSnapshot(repository.canonicalRoot, controllerHome, repository.repoId));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/repositories', (request, response) => {
    try {
      const selectedRepoId = queryString(request.query.repoId) ?? options.defaultRepoId;
      response.json({ repositories: userFacingRepositories(repoRoot, controllerHome, selectedRepoId) });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/repositories/:repoId/snapshot', (request, response) => {
    try {
      response.json(cachedLocalControllerSnapshot(requestRepositoryRoot(request, options, controllerHome)));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/repositories/:repoId/user-snapshot', (request, response) => {
    try {
      const repository = requestRepositorySelection(request, options, controllerHome);
      response.json(buildUserControllerExperienceSnapshot(repository.canonicalRoot, controllerHome, repository.repoId));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post('/api/repositories/register', (request, response) => {
    try {
      const path = queryString(request.body?.path);
      if (!path) throw new Error('REPOSITORY_PATH_REQUIRED');
      const repository = registerRepository({
        path,
        controllerHome,
        displayName: queryString(request.body?.displayName),
        remoteUrl: queryString(request.body?.remoteUrl),
        defaultBranch: queryString(request.body?.defaultBranch),
      });
      localSnapshotCache.delete(repository.canonicalRoot);
      response.status(201).json({
        repository,
        userSnapshot: buildUserControllerExperienceSnapshot(
          repository.canonicalRoot,
          controllerHome,
          repository.repoId,
        ),
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post('/api/repositories/:repoId/remove', (request, response) => {
    try {
      const repoId = queryString(request.params.repoId);
      if (!repoId) throw new Error('REPOSITORY_ID_REQUIRED');
      const repository = removeRepository(repoId, controllerHome);
      localSnapshotCache.delete(repository.canonicalRoot);
      for (const checkout of repository.checkouts ?? []) {
        if (checkout.canonicalRoot) localSnapshotCache.delete(checkout.canonicalRoot);
      }
      const remaining = userFacingRepositories(repoRoot, controllerHome);
      response.json({
        repository,
        repositories: remaining,
        summary: `已删除仓库注册：${repository.displayName || repository.repoId}`,
      });
    } catch (error) {
      const message = errorMessage(error);
      if (message.startsWith('REPOSITORY_SELF_PROTECTED')) {
        response.status(400).json({
          error: message,
          errorMessage: '不能删除当前进程所在仓库的注册（自我保护）',
        });
        return;
      }
      response.status(400).json({ error: message });
    }
  });
  app.get('/api/stream', (request, response) => {
    try {
      const repoRoot = requestRepositoryRoot(request, options, controllerHome);
      response.status(200);
      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-cache, no-transform');
      response.setHeader('Connection', 'keep-alive');
      response.flushHeaders();
      streamClients.set(response, { repoRoot, signature: controllerStateSignature(repoRoot) });
      sendStreamEvent(response, 'connected');
      request.on('close', () => streamClients.delete(response));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get('/api/governance', (request, response) => {
    try {
      response.json(inspectProjectGovernance(requestRepositoryRoot(request, options, controllerHome)));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/recovery/probe', (request, response) => {
    try {
      response.json(cachedLocalControllerSnapshot(requestRepositoryRoot(request, options, controllerHome)).recovery);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/recovery/plan', (request, response) => {
    try {
      const recovery = cachedLocalControllerSnapshot(requestRepositoryRoot(request, options, controllerHome)).recovery;
      response.json({
        generatedAt: recovery.generatedAt,
        overallState: recovery.overallState,
        fallbackRequired: recovery.fallbackRequired,
        recommendedActions: recovery.recommendedActions,
        blockingCapabilities: recovery.capabilities.filter((capability) =>
          ['blocked', 'unavailable', 'degraded'].includes(capability.state),
        ),
        notes: recovery.notes,
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post('/api/recovery/apply', async (request, response) => {
    try {
      const repository = requestRepositorySelection(request, options, controllerHome);
      const repoRoot = repository.canonicalRoot;
      const actionId = queryString(request.body?.actionId) ?? queryString(request.body?.action_id) ?? '';
      const action = recoveryActionById(actionId);
      if (!action) throw new Error(`RECOVERY_ACTION_UNKNOWN: ${actionId}`);
      assertRecoveryAuthorized(
        action,
        action.confirmation === 'none'
          ? action.id
          : request.body?.confirmAuthorization === true
            ? queryString(request.body?.authorization)
            : undefined,
      );
      const reason = queryString(request.body?.reason) ?? 'local controller recovery action';
      let result: Record<string, unknown>;
      let affectedPaths: string[] = [];
      if (action.id === 'recovery.probe_again') {
        result = cachedLocalControllerSnapshot(repoRoot).recovery as unknown as Record<string, unknown>;
      } else if (action.id === 'recovery.rebuild_projection' || action.id === 'recovery.refresh_repository') {
        result = { projection: rebuildRepositoryProjection(controllerHome, repository.repoId) };
        affectedPaths = ['.ai/harness/controller/projections'];
      } else if (action.id === 'recovery.cleanup_preview') {
        result = previewRuntimeCleanup(repoRoot, {
          includeTempDirs: true,
          includeTerminalLocalJobs: true,
          includeLegacyRuns: true,
          includeHistoricalAttention: true,
        }) as unknown as Record<string, unknown>;
      } else if (action.id === 'recovery.local_jobs_reconcile') {
        // Delegate to the one canonical Recovery application boundary instead of
        // running a second mutation from the HTTP transport. Authorization was
        // validated above with the same descriptor; the canonical owner rechecks
        // and writes the single audit record.
        const canonical = await executeCapabilityRecoveryAction({
          controllerHome,
          repository,
          actionId: action.id,
          reason,
          confirmAuthorization: request.body?.confirmAuthorization === true,
          authorization: queryString(request.body?.authorization),
          minAgeMinutes: typeof request.body?.minAgeMinutes === 'number' ? request.body.minAgeMinutes : undefined,
          maxCandidates: typeof request.body?.maxCandidates === 'number' ? request.body.maxCandidates : undefined,
          callStandaloneRecoveryTool: async () => {
            throw new Error('RECOVERY_ACTION_REQUIRES_MCP_TRANSPORT');
          },
          recoverySnapshot: async () =>
            cachedLocalControllerSnapshot(repoRoot).recovery as unknown as Record<string, unknown>,
        });
        localSnapshotCache.delete(repoRoot);
        response.json({ action: canonical.action, audit: canonical.audit, result: canonical.result });
        return;
      } else {
        result = {
          skipped: true,
          reason: `${action.id} is planned but not executable from the Local Bridge HTTP process.`,
        };
      }
      const audit = writeRecoveryAuditRecord(
        controllerHome,
        repository.repoId,
        buildRecoveryAuditRecord({
          actor: 'local-bridge-gui',
          action,
          result: result.skipped === true ? 'skipped' : 'succeeded',
          reason,
          affectedPaths,
        }),
      );
      localSnapshotCache.delete(repoRoot);
      response.json({ action, audit, result });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/mobile/devices', (request, response) => {
    try {
      const repository = requestRepositorySelection(request, options, controllerHome);
      response.json(
        withMobileIntentStoreLock(controllerHome, repository.repoId, () =>
          listMobileIntentDevices(repository.canonicalRoot),
        ),
      );
    } catch (error) {
      sendMobileIntentFailure(response, error);
    }
  });
  app.post('/api/mobile/devices', (request, response) => {
    try {
      const repository = requestRepositorySelection(request, options, controllerHome);
      const created = withMobileIntentStoreLock(controllerHome, repository.repoId, () =>
        createMobileIntentDevice(repository.canonicalRoot, {
          name: queryString(request.body?.name),
          deviceId: queryString(request.body?.deviceId),
          scopes: request.body?.scopes,
          rateLimitPerMinute: request.body?.rateLimitPerMinute,
        }),
      );
      response.status(201).json(created);
    } catch (error) {
      sendMobileIntentFailure(response, error);
    }
  });
  app.post('/api/mobile/devices/:deviceId/revoke', (request, response) => {
    try {
      const repository = requestRepositorySelection(request, options, controllerHome);
      response.json(
        withMobileIntentStoreLock(controllerHome, repository.repoId, () =>
          revokeMobileIntentDevice(repository.canonicalRoot, request.params.deviceId),
        ),
      );
    } catch (error) {
      if (error instanceof ControllerLockContentionError) {
        sendMobileIntentFailure(response, error);
        return;
      }
      response.status(404).json({ error: errorMessage(error) });
    }
  });
  app.post('/api/checks/run', (request, response) => {
    try {
      const repoRoot = requestRepositoryRoot(request, options, controllerHome);
      const requested = Array.isArray(request.body?.checkIds) ? request.body.checkIds.map(String) : [];
      const ids: string[] = requested.length > 0 ? requested.slice(0, 8) : ['package:check:type'];
      const results = ids.map((checkId: string) => {
        const result = runControllerCheck(
          repoRoot,
          checkId,
          typeof request.body?.timeoutMs === 'number' ? request.body.timeoutMs : undefined,
        );
        return {
          checkId,
          ok: result.ok,
          status: result.status,
          timedOut: result.timedOut,
          artifactPath: result.artifactPath,
          executedAt: result.executedAt,
        };
      });
      response.json({ ok: results.every((entry: { ok: boolean }) => entry.ok), results });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get('/api/timeline', (request, response) => {
    try {
      response.json({
        events: listControllerWorklogEvents(requestRepositoryRoot(request, options, controllerHome), {
          category: parseWorklogCategory(queryString(request.query.category)),
          issueId: queryString(request.query.issueId),
          taskId: queryString(request.query.taskId),
          runId: queryString(request.query.runId),
          since: queryString(request.query.since),
          until: queryString(request.query.until),
          limit: request.query.limit ? Number(request.query.limit) : 300,
        }),
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post('/api/worklog/export', (request, response) => {
    try {
      response.json(
        exportControllerWorklog(requestRepositoryRoot(request, options, controllerHome), {
          format: request.body?.format === 'json' ? 'json' : 'markdown',
          outputPath: queryString(request.body?.outputPath),
          filter: {
            issueId: queryString(request.body?.issueId),
            taskId: queryString(request.body?.taskId),
            runId: queryString(request.body?.runId),
          },
        }),
      );
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get('/api/github/plugin', (request, response) => {
    try {
      response.json(getGitHubPluginStatus(requestRepositoryRoot(request, options, controllerHome)));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get('/api/toolchain/plugins/:pluginId/summary', (request, response) => {
    try {
      const repository = requestRepositorySelection(request, options, controllerHome);
      const manifest = getAssistantPluginManifest(controllerHome, repository, request.params.pluginId);
      response.json({ plugin: summarizePluginForLowInterception(manifest) });
    } catch (error) {
      response.status(404).json({ error: errorMessage(error) });
    }
  });
  app.get('/api/toolchain/model-clients', (_request, response) => {
    response.json({ clients: buildModelClientSummary(), policyOwner: 'forge' });
  });
  app.get('/api/toolchain/model-control-plane', (_request, response) => {
    response.json({
      controlPlane: buildModelControlPlaneSummary(),
      transportEncryption: 'not-configured-by-this-tool',
    });
  });
  app.get('/api/toolchain/deepseek/tools', (_request, response) => {
    response.json({ provider: 'deepseek', tools: deepSeekFunctionToolManifest(), policyOwner: 'forge' });
  });
  app.get('/api/toolchain/deepseek/controller-manifest', (_request, response) => {
    response.json({ manifest: deepSeekControllerManifest() });
  });
  app.post('/api/toolchain/deepseek/prepare', (request, response) => {
    try {
      const args =
        request.body?.functionArguments &&
        typeof request.body.functionArguments === 'object' &&
        !Array.isArray(request.body.functionArguments)
          ? (request.body.functionArguments as Record<string, unknown>)
          : {};
      response.json({ prepared: prepareDeepSeekToolCall(String(request.body?.functionName ?? '').trim(), args) });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post('/api/toolchain/deepseek/handoff', (request, response) => {
    try {
      const repository = requestRepositorySelection(request, options, controllerHome);
      response.json({
        handoff: prepareDeepSeekControllerHandoff({
          reason: request.body?.reason,
          objective: request.body?.objective,
          repoId: repository.repoId,
          currentController: request.body?.currentController,
          blockedToolName: request.body?.blockedToolName,
          recentSafeError: request.body?.recentSafeError,
        }),
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post('/api/toolchain/deepseek/controller-request', (request, response) => {
    try {
      const repository = requestRepositorySelection(request, options, controllerHome);
      response.json({
        preview: prepareDeepSeekControllerRequest({
          reason: request.body?.reason,
          objective: request.body?.objective,
          userMessage: request.body?.userMessage,
          repoId: repository.repoId,
          currentController: request.body?.currentController,
          blockedToolName: request.body?.blockedToolName,
          recentSafeError: request.body?.recentSafeError,
          model: request.body?.model,
        }),
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get('/api/plugins', (request, response) => {
    try {
      const repository = requestRepositorySelection(request, options, controllerHome);
      response.json({ plugins: listAssistantPluginManifests(controllerHome, repository) });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get('/api/plugins/:pluginId', (request, response) => {
    try {
      const repository = requestRepositorySelection(request, options, controllerHome);
      response.json({ plugin: getAssistantPluginManifest(controllerHome, repository, request.params.pluginId) });
    } catch (error) {
      response.status(404).json({ error: errorMessage(error) });
    }
  });
  app.post('/api/plugins/:pluginId/actions/:actionId', async (request, response) => {
    try {
      const repository = requestRepositorySelection(request, options, controllerHome);
      const submitted = await submitAssistantPluginAction(
        controllerHome,
        repository,
        {
          pluginId: request.params.pluginId,
          actionId: request.params.actionId,
          requestId: queryString(request.body?.requestId) ?? '',
          args:
            request.body?.arguments &&
            typeof request.body.arguments === 'object' &&
            !Array.isArray(request.body.arguments)
              ? (request.body.arguments as Record<string, unknown>)
              : {},
          timeoutMs: typeof request.body?.timeoutMs === 'number' ? request.body.timeoutMs : undefined,
          confirmAuthorization: request.body?.confirmAuthorization === true,
          confirmationText: queryString(request.body?.confirmationText),
          origin: {
            surface: 'local-ui',
            actor: 'local-controller',
            correlationId: queryString(request.body?.requestId),
          },
        },
        { githubIssueSync: githubIssueSyncPort },
      );
      response.status(202).json({
        accepted: true,
        deduplicated: submitted.deduplicated,
        plugin: submitted.manifest,
        action: {
          actionId: submitted.action.actionId,
          risk: submitted.action.risk,
          confirmation: submitted.action.confirmation,
          requiredConfirmationText: submitted.action.requiredConfirmationText,
        },
        job: submitted.job,
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.patch('/api/github/plugin', (request, response) => {
    try {
      const body = request.body ?? {};
      response.json(
        saveGitHubPluginConfig(requestRepositoryRoot(request, options, controllerHome), {
          enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
          repository: typeof body.repository === 'string' ? body.repository : undefined,
          syncMode: body.syncMode === 'checkpoint' ? 'checkpoint' : body.syncMode === 'manual' ? 'manual' : undefined,
          includeTasks: typeof body.includeTasks === 'boolean' ? body.includeTasks : undefined,
          projectOwner: typeof body.projectOwner === 'string' ? body.projectOwner : undefined,
          projectNumber:
            body.projectNumber === null
              ? null
              : typeof body.projectNumber === 'number'
                ? body.projectNumber
                : undefined,
        }),
      );
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post('/api/issues/:issueId/github/publish', (request, response) => {
    try {
      response.json(
        publishIssueWithGitHubPlugin(requestRepositoryRoot(request, options, controllerHome), request.params.issueId),
      );
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post('/api/issues/:issueId/github/refresh', (request, response) => {
    try {
      response.json(
        refreshIssueWithGitHubPlugin(requestRepositoryRoot(request, options, controllerHome), request.params.issueId),
      );
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post('/api/issues/:issueId/github/close', (request, response) => {
    try {
      response.json(
        closeIssueWithGitHubPlugin(requestRepositoryRoot(request, options, controllerHome), request.params.issueId),
      );
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get('/api/jobs/:jobId', (request, response) => {
    try {
      const repoRoot = requestRepositoryRoot(request, options, controllerHome);
      response.json({
        job: getLocalBridgeJob(repoRoot, request.params.jobId),
        events: getLocalBridgeJobEvents(repoRoot, request.params.jobId),
      });
    } catch (error) {
      response.status(404).json({ error: errorMessage(error) });
    }
  });
  app.post('/api/jobs/:jobId/cancel', (request, response) => {
    try {
      response.json(
        cancelLocalBridgeJob(requestRepositoryRoot(request, options, controllerHome), request.params.jobId),
      );
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get('/api/runs/:runId', (request, response) => {
    try {
      response.json(getAgentJob(requestRepositoryRoot(request, options, controllerHome), request.params.runId));
    } catch (error) {
      response.status(404).json({ error: errorMessage(error) });
    }
  });
  app.get('/api/runs/:runId/log', (request, response) => {
    try {
      const repoRoot = requestRepositoryRoot(request, options, controllerHome);
      const run = getAgentJob(repoRoot, request.params.runId);
      const result = getAgentJobLog(repoRoot, request.params.runId, false);
      response.json({ ...result, status: run.status, agent: run.agent });
    } catch (error) {
      response.status(404).json({ error: errorMessage(error) });
    }
  });
  app.get('/api/runs/:runId/events', (request, response) => {
    try {
      response.json({
        events: getAgentJobEvents(requestRepositoryRoot(request, options, controllerHome), request.params.runId, 500),
      });
    } catch (error) {
      response.status(404).json({ error: errorMessage(error) });
    }
  });
  app.get('/api/runs/:runId/diff', (request, response) => {
    try {
      response.json(taskRunDiff(requestRepositoryRoot(request, options, controllerHome), request.params.runId));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post('/api/runs/:runId/integrate', (request, response) => {
    try {
      const repoRoot = requestRepositoryRoot(request, options, controllerHome);
      const integrated = integrateAgentJob(repoRoot, getToolPolicy('controller', { repoRoot }), request.params.runId);
      const cleanup = cleanupIntegratedWorktree(repoRoot, request.params.runId);
      response.json({
        integrated,
        cleanup,
        run: getAgentJob(repoRoot, request.params.runId),
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post('/api/runs/:runId/cancel', (request, response) => {
    try {
      response.json(cancelAgentJob(requestRepositoryRoot(request, options, controllerHome), request.params.runId));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  const server = createServer(app);
  server.listen(requestedPort, host);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 120_000;
  server.on('close', () => {
    clearInterval(streamInterval);
    for (const client of streamClients.keys()) client.end();
    streamClients.clear();
    localSnapshotCache.delete(repoRoot);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;
  const url = `http://${host === '::1' ? '[::1]' : host}:${port}/`;
  return {
    host,
    port,
    url,
    token,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        for (const client of streamClients.keys()) client.end();
        streamClients.clear();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
