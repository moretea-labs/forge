import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult as SdkCallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { collectRuntimePerformanceDiagnostics, inferLocalControllerProcess } from '../../diagnostics/performance';
import type { McpToolDefinition, CallToolResult } from '../../../cli/mcp/tools';
import type { MultiRepositoryMcpToolContext } from '../../../cli/mcp/multi-repository';
import { repositoryScopedToolArgs } from '../../../cli/mcp/multi-repository';
import { reconcileReadinessProjectionSource } from '../../../cli/mcp/readiness-projection';
import { listRepositories, repositorySummary, resolveRepositorySelection, selectRepositoryCheckout } from '../../../cli/repositories/registry';
import { repositoryGitStatus } from '../../../cli/repositories/structured-git';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { cancelExecutionJob, findExecutionJob, getExecutionJob, getExecutionJobByRequestId, listExecutionJobs } from '../../execution/jobs/store';
import { waitForExecutionJob } from '../../execution/jobs/wait';
import type { ExecutionJob } from '../../execution/jobs/types';
import { getProcessHandle, getProcessRecord, isManagedProcessActive, listProcessRecords, processCheckCompletionReceipt, processRuntimeResourceDiagnostics, readPersistedCheckResultReceipt, runPersistedCheckViaProcessRuntime, waitForProcess } from '../../execution/process-runtime';
import { getRepositoryCommandProcess, waitRepositoryCommandProcess } from '../../execution/process-runtime/command-facade';
import { buildJobOperationDigest } from '../../control-plane/facade/operation-digest';
import { readWorkHandle, transitionWorkHandle, writeWorkHandle, type WorkHandleState } from '../../control-plane/execution/work-handle-store';
import { executionIdentityForRepository } from '../../control-plane/execution/execution-identity';
import { commandFingerprint, verificationInputFingerprint, workspaceValidationFingerprint } from '../../control-plane/execution/verification-evidence';
import { acceptReviewedDirectEditWorkReconciliation, reconcileFinalizedDirectEditWorksAfterCommit } from '../../control-plane/execution/direct-edit-work-completion';
import { readJobEvents } from '../../evidence/event-ledger';
import { readExecutionArtifact } from '../../evidence/artifact-store';
import { readExecutionEvidence } from '../../evidence/evidence-store';
import { readForgeRuntimeStatus } from '../../control-plane/runtime-status-client';
import { readSchedulerHealthSnapshot } from '../../control-plane/global-scheduler/scheduler';
import {
  evaluateActiveRuntimeSourceDrift,
  formatRuntimeSourceDriftMessage,
  readRuntimeGeneration,
  type RuntimeSourceIdentity,
} from '../../control-plane/runtime-generation';
import { rebuildRepositoryProjection, projectionObservation, readRepositoryProjectionSnapshot, reconcileProjectionWithTaskLedger } from '../../projections/materialized-view';
import {
  buildRuntimeOperationalView,
  classifyRuntimeReadinessSemantics,
  evaluateRuntimeHealth,
  RUNTIME_HEALTH_THRESHOLDS,
  type RuntimeHealthEvaluation,
  type RuntimeOperationalView,
  type GradedObservation,
} from '../../health';
import { applyScheduleDedupe, buildScheduleDedupeReport, createSchedule, getSchedule, getScheduleDecision, listOccurrences, listSchedules, saveSchedule } from '../../workflow/schedules/store';
import { evaluateSchedule } from '../../workflow/schedules/engine';
import {
  createWorkContinuationSchedule,
  type ContinuationControllerType,
} from '../../workflow/schedules/work-continuation';
import { createPortfolioWorkflow, getPortfolioWorkflow, listPortfolioWorkflows } from '../../workflow/portfolio/store';
import { claimsForMcpOperation } from './resource-policy';
import {
  gatewayRouteBehaviorSnapshot,
  getMcpToolDefinition,
  hashMcpToolArguments,
  injectDurableCommandFields,
  operationMetadataForTool,
  RETIRED_AGENT_OPERATIONS,
  routeDurableMcpCall,
  validateMcpToolArguments,
} from './router';
import { assertAutomatedOperationAllowed } from '../../control-plane/governance/external-effects';
import { getCandidateFinding, listCandidateFindings, recordCandidateFinding } from '../../workflow/findings/store';
import { ensureRepositoryRuntimeStorage } from '../../../cli/repositories/runtime-storage';
import { assessWorkMode, parseExplicitTaskMode } from '../../../cli/controller/work-mode';
import { projectBoard } from '../../../cli/controller/issue-store';
import {
  buildControllerTaskLedgerProjection,
  writeControllerTaskLedgerArtifacts,
} from '../../../cli/controller/task-ledger';
import { buildControllerContextPack, buildControllerContextPackAsync, CONTROLLER_CONTEXT_IMPACT_DOMAINS, type ControllerContextImpactDomain } from '../../../cli/controller/context-pack';
import { legacyIssueAuthorityRetired } from '../../../cli/controller/legacy-issue-cutover';
import { buildControllerOperationalPlan } from '../../../cli/controller/operational-plan';
import { listControllerChecks, readLatestControllerCheckEvidence } from '../../../cli/controller/check-runner';
import { buildCheckExecutionSchedule } from '../../execution/process-runtime/check-scheduling';
import { repositoryChangeVerify } from '../../../cli/controller/composite-operations';
import { listActiveAgentJobSnapshots } from '../../../cli/agent-jobs/job-manager';
import { readAgentExecutableReadinessSnapshot } from '../../../cli/agent-jobs/executable-resolver';
import {
  commitSelectedPaths,
  prepareTransferArtifacts,
  selectedPathDiff,
  stageSelectedPaths,
} from '../../../cli/repositories/selected-path-actions';
import type { TaskRisk } from '../../../cli/controller/types';
import {
  controllerContextPerformanceSnapshot,
  controllerContextProjectionAgeMs,
  controllerContextProjectionGeneration,
  controllerContextProjectionPayloadMatchesSourceIdentity,
  controllerContextProjectionNeedsRefresh,
  queueControllerContextProjectionRefresh,
  readControllerContextProjection,
  readControllerContextProjectionInvalidation,
  recordControllerContextRead,
  writeControllerContextProjection,
} from '../../projections/controller-context';
import { loadMcpRuntimeState } from '../../../cli/mcp/auth';
import {
  FORGE_MCP_SCHEMA_VERSION,
  FORGE_TOOL_SURFACE,
  FORGE_VERSION,
} from '../../../cli/controller/runtime-config';
import { redactMcpText } from '../../../cli/mcp/redaction';
import { resolveLocalBridgeSurface, summarizeRecentJobs } from '../../shared/local-bridge-surface';
import { assistantPluginScope, controllerPluginRepository, executeAssistantPluginReadDirect, getAssistantPluginManifest, isDirectPluginReadAction, listAssistantPluginManifests, submitAssistantPluginAction } from '../../plugins/store';
import { mcpPluginExecutionOrigin } from '../../plugins/execution-origin';
import {
  summarizeExecutionJobForMcp,
  summarizeJobResultForLowInterception,
  summarizePluginForLowInterception,
  applyExternalFilesystemGrant,
  buildWorkspaceAuthStatus,
  listExternalFilesystemTargets,
  prepareWorkspaceAuthLogin,
  previewExternalFilesystemGrant,
  readExternalFilesystemSnapshot,
  buildReviewArtifactIndex,
  ensureReviewArtifactRoots,
  prepareBrowserReviewPacket,
  prepareIosReviewPacket,
} from '../../safe-tooling';
import { buildModelClientSummary, buildModelControlPlaneSummary, deepSeekControllerManifest, deepSeekFunctionToolManifest, prepareDeepSeekControllerHandoff, prepareDeepSeekControllerRequest, prepareDeepSeekToolCall } from '../../model-clients';
import { buildAssistantReadinessReport } from '../../assistant/readiness';
import { approveAssistantActionProposal, getAssistantActionProposal, listAssistantActionProposals, rejectAssistantActionProposal } from '../../assistant/action-proposals';
import { assistantModelReadiness } from '../../assistant/model-provider';
import { createAssistantStandingGrant, listAssistantStandingGrants, revokeAssistantStandingGrant } from '../../assistant/standing-grants';
import { buildGmailTriagePlan, readGmailTriageRules, upsertGmailTriageRule } from '../../personal-assistant/gmail-triage-manager';
import { sessionCacheGlobalDiagnostics } from '../../../cli/repository/session-cache';
import { cachedGitIdentity, gitIdentityPerformanceSnapshot, gitSnapshot, gitSnapshotPerformanceSnapshot } from '../../../cli/repository/inspector';
import { buildWorkflowWatchdogReport } from '../../watchdog/workflow-watchdog';
import { applyRuntimeCleanup, previewRuntimeCleanup } from '../../maintenance/cleanup';
import {
  applyRuntimeMaintenance,
  buildCapabilityRecoverySnapshot,
  buildRuntimeMaintenanceStatus,
  recoveryActionById,
  buildRecoveryAuditRecord,
  assertRecoveryAuthorized,
  writeRecoveryAuditRecord,
  listRecoveryAuditRecords,
  type RuntimeMaintenanceActionId,
  previewRuntimeStorageRepair,
  applyRuntimeStorageRepair,
} from '../../recovery';
import { gatewayToken, loadRecoveryConfig } from '../../standalone-recovery/core';
import { assertRuntimeReleaseFiles, stageRuntimeReleaseFromCandidateSource } from '../../root/release-materialize';
import {
  getLocalBridgeJobEventsSnapshot,
  getLocalBridgeJobSnapshot,
  listLocalBridgeJobSnapshots,
  readLocalBridgeJobOutputSnapshot,
} from '../../../cli/local-bridge/job-store';
import {
  acknowledgeHandoffItem,
  allowedFacadeOperations,
  buildFacadeResult,
  classifyVerificationOutcome,
  createHandoffItem,
  dismissHandoffItem,
  getHandoffItem,
  listCapabilityDescriptors,
  getPluginActionCapabilitySchema,
  summarizeCapabilityGroups,
  listHandoffItems,
  normalizeCheckIds,
  resolveHandoffItem,
  runGoalWorkloop,
  runSelfHealingLoop,
  delegateToCodexCerebellum,
  summarizeHandoffItem,
  listWorkContracts,
  getWorkContract,
  getWorkContractByRequestId,
  buildWorkContinuationSnapshot,
  acceptSubmittedWorkContract,
  acceptPlanStepEvidence,
  approvePlanContract,
  createPlanContract,
  getPlanContract,
  listPlanContracts,
  summarizePlanContract,
  supersedePlanContract,
  verifyGoalWorkloop,
  type FacadeTool,
  claimControllerSession,
  getControllerSession,
  releaseControllerSession,
  resumeControllerSession,
} from '../../control-plane/facade';
import { currentControllerInstanceId, readExecutionSession, startExecutionSession, updateExecutionSession } from '../../control-plane/execution/session-store';
import { ensureManagedWorkspace } from '../../execution/managed-workspace';
import { currentPermissionSnapshotVersion } from '../../control-plane/execution/validation';
import { observeRuntimeStatus } from '../../root/status';
import { reconcileWorkValidation } from './work-validation-reconciler';
import { callExecutionTool } from './execution-tools';
import { launchSuperController } from '../../control-plane/launcher/thin-launcher';
import {
  executorDispatch,
  executorRoutePreview,
  goalContinue,
  goalCreate,
  goalFinalize,
  goalGet,
  goalHandoffPacketCreate,
  goalHandoffPacketGet,
  goalList,
  goalStart,
  goalStatus,
  goalStop,
  goalTickOnce,
  providerConfigStatusAction,
  providerHealthAction,
  providerListAction,
  repairContinue,
  repairPlan,
  summarizeGoalContract,
  tickActiveGoals,
  type GoalContract,
  type GoalLoopContext,
  type GoalStatus,
  type TaskIntent,
} from '../../control-plane/goal-loop';

function summarizeGoalPublic(goal: GoalContract) {
  return summarizeGoalContract(goal);
}

export {
  connectorExposedTools,
  currentCallableTools,
  runtimeToolDefinitions,
} from './runtime-tool-definitions';
import {
  currentCallableTools,
  runtimeToolDefinitions,
} from './runtime-tool-definitions';

const RH_CONTEXT_CURRENT_WINDOW_MS = 24 * 60 * 60 * 1_000;

function timestampIsCurrent(value: string | undefined, cutoffMs: number): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= cutoffMs;
}

function isCurrentRhContextWork(
  contract: { status: string; updatedAt?: string },
  cutoffMs: number,
): boolean {
  if (contract.status === 'running') return true;
  if (contract.status !== 'ready' && contract.status !== 'open' && contract.status !== 'blocked') return false;
  return timestampIsCurrent(contract.updatedAt, cutoffMs);
}

export function summarizeControllerReadyPayload(fullPayload: Record<string, unknown>): Record<string, unknown> {
  const health = (fullPayload.health ?? {}) as Record<string, unknown>;
  const workerLoop = (fullPayload.workerLoop ?? {}) as Record<string, unknown>;
  const durableScheduler = (fullPayload.durableScheduler ?? {}) as Record<string, unknown>;
  const localBridge = (fullPayload.localBridge ?? {}) as Record<string, unknown>;
  const localBridgeHealth = (localBridge.health ?? {}) as Record<string, unknown>;
  const toolSurface = (fullPayload.toolSurface ?? {}) as Record<string, unknown>;
  const routeBehavior = (fullPayload.routeBehavior ?? {}) as Record<string, unknown>;
  const expectedTools = Array.isArray(toolSurface.expectedTools) ? toolSurface.expectedTools : [];
  const actualTools = Array.isArray(toolSurface.actualTools) ? toolSurface.actualTools : [];
  const repoIdValue = typeof fullPayload.repoId === 'string' ? fullPayload.repoId : undefined;
  return {
    detailLevel: 'summary',
    repoId: repoIdValue,
    ready: fullPayload.ready,
    state: fullPayload.state,
    reasons: fullPayload.reasons,
    taskLedgerStatus: fullPayload.taskLedgerStatus,
    taskLedgerCounts: fullPayload.taskLedgerCounts,
    gateway: fullPayload.gateway,
    projectionReconciliation: fullPayload.projectionReconciliation,
    health: {
      state: health.state,
      ready: health.ready,
      activeBlockers: health.activeBlockers,
      warnings: health.warnings,
      components: health.components,
    },
    activity: {
      queueDepth: workerLoop.queueDepth,
      runningWorkers: workerLoop.runningWorkers,
      activeLeases: workerLoop.activeLeases,
      schedulerStatus: durableScheduler.status,
      schedulerHeartbeatAgeMs: durableScheduler.heartbeatAgeMs,
      localBridgeReady: localBridgeHealth.ready ?? localBridge.running,
    },
    externalEndpoint: fullPayload.externalEndpoint,
    runtimeIdentity: (() => {
      const identity = fullPayload.runtimeIdentity && typeof fullPayload.runtimeIdentity === 'object'
        ? fullPayload.runtimeIdentity as Record<string, unknown>
        : undefined;
      if (!identity) return undefined;
      return {
        releaseId: identity.releaseId,
        runtimeCommit: identity.runtimeCommit,
        buildCommit: identity.buildCommit,
        startedAt: identity.startedAt,
        controllerInstanceId: identity.controllerInstanceId,
        endpoint: identity.endpoint,
        ready: identity.ready,
        reasonCodes: identity.reasonCodes,
        toolset: identity.toolset,
        profile: identity.profile,
      };
    })(),
    routeBehavior: {
      schemaVersion: routeBehavior.schemaVersion,
      fingerprint: routeBehavior.fingerprint,
      probeCount: routeBehavior.probeCount,
    },
    toolSurface: {
      ready: toolSurface.ready,
      // Never report 0/0 as a real tool surface: an uncomputed exposure is
      // explicitly unknown until the snapshot has been built.
      expectedToolCount: expectedTools.length > 0 || toolSurface.ready ? expectedTools.length : null,
      actualToolCount: actualTools.length > 0 || toolSurface.ready ? actualTools.length : null,
      toolSurfaceState: expectedTools.length === 0 && actualTools.length === 0 && !toolSurface.ready ? 'unknown' : 'computed',
      missingTools: toolSurface.missingTools,
      unexpectedTools: toolSurface.unexpectedTools,
      duplicateTools: toolSurface.duplicateTools,
      fingerprint: toolSurface.fingerprint,
      schemaStableAcrossAccessModes: toolSurface.schemaStableAcrossAccessModes,
    },
    access: fullPayload.access,
    registeredRepositories: fullPayload.registeredRepositories,
    detailPointer: {
      tool: 'controller_ready',
      arguments: { ...(repoIdValue ? { repo_id: repoIdValue } : {}), detail_level: 'detail' },
    },
  };
}

function withRuntimeResponseMeta(
  payload: Record<string, unknown>,
  startedAt: number,
  options: {
    phaseTimingsMs?: Record<string, number>;
    transport?: string;
    sessionId?: string;
    routing?: { repoId?: string; checkoutId?: string };
    cacheHit?: boolean;
    stale?: boolean;
    refreshJobId?: string;
  } = {},
): Record<string, unknown> {
  const response = {
    ...payload,
    responseMeta: {
      serverDurationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      phaseTimingsMs: options.phaseTimingsMs ?? {},
      transport: options.transport ?? 'runtime-local',
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.routing ? { routing: options.routing } : {}),
      ...(options.cacheHit !== undefined ? { cacheHit: options.cacheHit } : {}),
      ...(options.stale !== undefined ? { stale: options.stale } : {}),
      ...(options.refreshJobId ? { refreshJobId: options.refreshJobId } : {}),
      structuredPayloadBytes: 0,
    },
  };
  response.responseMeta.structuredPayloadBytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
  return response;
}

async function callStandaloneRecoveryTool(
  controllerHome: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const config = loadRecoveryConfig(controllerHome);
  const gateway = config.gateway;
  if (!gateway || gateway.host !== '127.0.0.1') {
    throw new Error('RECOVERY_GATEWAY_UNAVAILABLE: loopback Recovery Gateway is not configured');
  }
  const token = gatewayToken(config);
  if (!token) throw new Error('RECOVERY_GATEWAY_AUTH_UNAVAILABLE');
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gateway.port}/recovery/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'forge-runtime-lifecycle-handoff', version: '1.0.0' });
  try {
    await client.connect(transport);
    const response = await client.callTool({ name, arguments: args });
    if (response.isError) throw new Error(`RECOVERY_TOOL_FAILED: ${name}`);
    return (response.structuredContent ?? { content: response.content }) as Record<string, unknown>;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export const RH_WORK_VERIFY_LEASE_WAIT_MS = 8_000;

type TerminalCheckEvidenceState = 'matched' | 'process_runtime_failed_before_result' | 'missing' | 'mismatch';

export function classifyTerminalCheckEvidence(input: {
  processError?: { code: string; message: string };
  structuredPresent: boolean;
  structuredMatches: boolean;
  legacyPresent: boolean;
  legacyMatches: boolean;
}): { state: TerminalCheckEvidenceState; warning?: string; infrastructureReason?: string } {
  if (input.structuredMatches || input.legacyMatches) return { state: 'matched' };
  if (!input.structuredPresent && !input.legacyPresent && input.processError?.message?.trim()) {
    const reason = input.processError.message.trim().slice(0, 512);
    return {
      state: 'process_runtime_failed_before_result',
      warning: `check process failed before structured result receipt: ${reason}`,
      infrastructureReason: reason,
    };
  }
  if (input.structuredPresent || input.legacyPresent) {
    return { state: 'mismatch', warning: 'check result receipt did not match the terminal Process semantic identity' };
  }
  return { state: 'missing', warning: 'check result receipt is missing for the terminal Check Process' };
}

function result(value: Record<string, unknown>, isError = false): CallToolResult {
  // Compact text channel by default (no pretty-print bloat).
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}

const MAX_INLINE_PLUGIN_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_PLUGIN_IMAGES = 4;
const INLINE_PLUGIN_IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

type McpImageContent = Extract<SdkCallToolResult['content'][number], { type: 'image' }>;

export function boundedPluginArtifactImageContent(
  controllerHome: string,
  repoId: string,
  pluginResult: Record<string, unknown> | undefined,
): McpImageContent[] {
  if (!pluginResult) return [];
  const nestedResult = pluginResult.result && typeof pluginResult.result === 'object' && !Array.isArray(pluginResult.result)
    ? pluginResult.result as Record<string, unknown>
    : undefined;
  const candidates = [
    ...(Array.isArray(pluginResult.artifactCandidates) ? pluginResult.artifactCandidates : []),
    ...(nestedResult && Array.isArray(nestedResult.artifactCandidates) ? nestedResult.artifactCandidates : []),
  ];
  if (candidates.length === 0) return [];
  const allowedRoot = resolve(repositoryControllerRoot(controllerHome, repoId));
  const images: McpImageContent[] = [];
  const seenPaths = new Set<string>();

  for (const candidate of candidates) {
    if (images.length >= MAX_INLINE_PLUGIN_IMAGES) break;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const mediaType = typeof record.mediaType === 'string' ? record.mediaType : '';
    const path = typeof record.path === 'string' ? record.path : '';
    if (!INLINE_PLUGIN_IMAGE_MEDIA_TYPES.has(mediaType) || !path) continue;

    const resolvedPath = resolve(path);
    if (seenPaths.has(resolvedPath)) continue;
    const rel = relative(allowedRoot, resolvedPath);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    if (!existsSync(resolvedPath)) continue;

    try {
      const stat = statSync(resolvedPath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_INLINE_PLUGIN_IMAGE_BYTES) continue;
      images.push({
        type: 'image',
        data: readFileSync(resolvedPath).toString('base64'),
        mimeType: mediaType,
      });
      seenPaths.add(resolvedPath);
    } catch {
      // The structured plugin result remains authoritative when an artifact cannot be inlined.
    }
  }

  return images;
}

function resultWithPluginArtifactImages(
  value: Record<string, unknown>,
  controllerHome: string,
  repoId: string,
  pluginResult: Record<string, unknown> | undefined,
): CallToolResult {
  const images = boundedPluginArtifactImageContent(controllerHome, repoId, pluginResult);
  const richResult: SdkCallToolResult = {
    content: [{ type: 'text', text: JSON.stringify(value) }, ...images],
    structuredContent: value,
  };
  // The legacy internal facade intentionally types content as text-first for existing callers.
  // The MCP wire contract supports additional SDK image blocks after that stable first text block.
  return richResult as unknown as CallToolResult;
}

function repositoryRootForRepoId(controllerHome: string, repoId: string): string | undefined {
  return listRepositories(controllerHome).find((repository) => repository.repoId === repoId)?.canonicalRoot;
}

function scrubPathText(text: string, replacements: string[]): string {
  let output = text;
  for (const replacement of [...new Set(replacements.filter((entry) => entry.startsWith('/')))].sort((left, right) => right.length - left.length)) {
    output = output.split(replacement).join('<repo>');
  }
  output = output
    .replace(/\/(?:private\/)?tmp\/[^\s"']+/g, '<abs-path>')
    .replace(/\/(?:private\/)?var\/folders\/[^\s"']+/g, '<abs-path>')
    .replace(/\/Users\/[^\s"']+/g, '<abs-path>')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<abs-path>');
  return output;
}

function jsonPreview(value: unknown, maxChars = 800, replacements: string[] = []): { preview: string; truncated: boolean; byteLength: number } {
  const serialized = JSON.stringify(value);
  const redacted = redactMcpText(scrubPathText(serialized, replacements)).text;
  const byteLength = Buffer.byteLength(serialized);
  if (redacted.length <= maxChars) return { preview: redacted, truncated: false, byteLength };
  return {
    preview: `${redacted.slice(0, maxChars)}...`,
    truncated: true,
    byteLength,
  };
}

function summarizeJobEvents(controllerHome: string, repoId: string, jobId: string): Array<Record<string, unknown>> {
  const repoRoot = repositoryRootForRepoId(controllerHome, repoId);
  return readJobEvents(controllerHome, repoId, jobId).slice(-20).map((event) => {
    const dataPreview = event.data && Object.keys(event.data).length > 0 ? jsonPreview(event.data, 240, repoRoot ? [repoRoot] : []) : undefined;
    return {
      eventId: event.eventId,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      revision: event.revision,
      ...(dataPreview ? { dataPreview: dataPreview.preview, dataTruncated: dataPreview.truncated } : {}),
    };
  });
}

function summarizeExecutionJob(job: ExecutionJob, repoRoot?: string): Record<string, unknown> {
  return summarizeExecutionJobForMcp(job, repoRoot);
}

function summarizeRuntimeProjectionForReadiness<T extends { currentAttention?: unknown; attention?: unknown }>(projection: T): T & { historicalAttention?: unknown } {
  return {
    ...projection,
    attention: projection.currentAttention ?? projection.attention,
    historicalAttention: projection.attention,
  };
}

function summarizePlugin(manifest: ReturnType<typeof getAssistantPluginManifest>): Record<string, unknown> {
  return {
    pluginId: manifest.pluginId,
    provider: manifest.provider,
    displayName: manifest.displayName,
    pluginVersion: manifest.pluginVersion,
    revision: manifest.revision,
    enabled: manifest.enabled,
    lifecycle: manifest.lifecycle,
    health: manifest.health,
    authority: manifest.authority,
    permissions: manifest.permissions,
    capabilities: manifest.capabilities,
    actions: manifest.actions.map((action) => ({
      actionId: action.actionId,
      title: action.title,
      description: action.description,
      readOnly: action.readOnly,
      risk: action.risk,
      confirmation: action.confirmation,
      requiredConfirmationText: action.requiredConfirmationText,
      defaultTimeoutMs: action.defaultTimeoutMs,
      cancellable: action.cancellable,
      idempotent: action.idempotent,
      scopes: action.scopes,
      resourceClaims: action.resourceClaims,
      argumentsSchema: action.argumentsSchema,
    })),
    updatedAt: manifest.updatedAt,
  };
}

function summarizePluginActionReceipt(manifest: ReturnType<typeof getAssistantPluginManifest>): Record<string, unknown> {
  return {
    pluginId: manifest.pluginId,
    provider: manifest.provider,
    displayName: manifest.displayName,
    pluginVersion: manifest.pluginVersion,
    revision: manifest.revision,
    enabled: manifest.enabled,
    lifecycleState: manifest.lifecycle.state,
    health: {
      state: manifest.health.state,
      ready: manifest.health.ready,
      checkedAt: manifest.health.checkedAt,
      errorCount: manifest.health.errors.length,
      warningCount: manifest.health.warnings.length,
    },
    updatedAt: manifest.updatedAt,
  };
}

function compactSubmittedPluginActionResult(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const nested = value.result;
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return value;
  const work = value.work;
  return {
    ...(nested as Record<string, unknown>),
    ...(work && typeof work === 'object' && !Array.isArray(work) ? { work } : {}),
  };
}


function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((entry) => entry.trim()).filter(Boolean) : [];
}

export interface RuntimeIdentitySnapshot {
  releaseId?: string;
  artifactIdentity?: string;
  runtimeCommit?: string;
  buildCommit?: string;
  startedAt?: string;
  runtimeInstanceId?: string;
  controllerInstanceId?: string;
  endpoint?: string;
  ready?: boolean;
  reasonCodes?: string[];
  toolset?: string;
  profile?: string;
}

/**
 * Read-only Runtime identity projection. A stored identity is accepted only
 * while the live Runtime owner has the same Runtime instance and PID.
 */
export function runtimeIdentitySnapshot(ctx: MultiRepositoryMcpToolContext): RuntimeIdentitySnapshot {
  const observation = observeRuntimeStatus(ctx.controllerHome);
  const snapshot = observation.snapshot;
  return {
    releaseId: snapshot?.releaseId,
    artifactIdentity: snapshot?.artifactIdentity,
    startedAt: snapshot?.startedAt,
    runtimeInstanceId: snapshot?.runtimeInstanceId,
    controllerInstanceId: snapshot?.runtimeInstanceId,
    endpoint: snapshot?.endpoint,
    ready: observation.ready,
    reasonCodes: observation.reasonCodes,
    toolset: ctx.toolset,
    profile: ctx.policy.profile,
  };
}

function controllerContextAssessment(args: Record<string, unknown>) {
  const description = typeof args.description === 'string' && args.description.trim()
    ? args.description
    : 'Inspect the selected repository context.';
  return assessWorkMode({
    description,
    knownPaths: stringList(args.known_paths),
    expectedFiles: typeof args.expected_files === 'number' ? args.expected_files : undefined,
    expectedChangedLines: typeof args.expected_changed_lines === 'number' ? args.expected_changed_lines : undefined,
    requiresInvestigation: args.requires_investigation === true,
    requiresParallelism: args.requires_parallelism === true,
    requiresLongRunningChecks: args.requires_long_running_checks === true,
    needsDependencies: args.needs_dependencies === true,
    requiresIndependentDeliverables: args.requires_independent_deliverables === true,
    independentTaskCount: typeof args.independent_task_count === 'number' ? args.independent_task_count : undefined,
    requiresRemoteWrite: args.requires_remote_write === true || args.remote_write === true,
    requiresRecovery: args.requires_recovery === true,
    agentRequested: args.agent_requested === true || args.requires_worker === true,
    requiresWorkerIsolation: args.requires_worker_isolation === true,
    risk: typeof args.risk === 'string' ? args.risk as TaskRisk : undefined,
    explicitMode: parseExplicitTaskMode(args.mode) ?? (typeof args.description === 'string' && args.description.trim() ? undefined : 'direct'),
  });
}

function contextRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function contextText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function compactContextTask(value: unknown): Record<string, unknown> {
  const task = contextRecord(value);
  return {
    issueId: task.issueId ?? task.id,
    taskId: task.taskId ?? task.id,
    title: task.title,
    effectiveStatus: task.effectiveStatus,
    verificationStatus: task.verificationStatus,
    latestRunStatus: task.latestRunStatus,
    retryable: task.retryable,
    dispatchable: task.dispatchable,
    queueable: task.queueable,
  };
}

function compactContextEvent(value: unknown): Record<string, unknown> | string {
  if (typeof value === 'string') return contextText(value, 300) ?? '';
  const event = contextRecord(value);
  return {
    eventId: event.eventId ?? event.id,
    type: event.type ?? event.eventType,
    status: event.status,
    issueId: event.issueId,
    taskId: event.taskId,
    summary: contextText(event.summary ?? event.message, 300),
    occurredAt: event.occurredAt ?? event.createdAt ?? event.at,
  };
}

function compactContextAction(value: unknown): Record<string, unknown> | string {
  if (typeof value === 'string') return contextText(value, 300) ?? '';
  const action = contextRecord(value);
  return {
    actionId: action.actionId ?? action.id,
    title: action.title,
    reason: contextText(action.reason ?? action.summary, 300),
  };
}

function compactControllerContextSummaryPayload(payload: Record<string, unknown>): Record<string, unknown> {
  // Idempotent: already-compacted summaries pass through untouched.
  if (payload.detailLevel === 'summary') return payload;
  const git = contextRecord(payload.git);
  const repository = contextRecord(payload.repository);
  const ledger = contextRecord(payload.taskLedger);
  const operationalPlan = contextRecord(payload.operationalPlan);
  const ready = contextRecord(payload.controllerReady);
  const runtimeProjection = contextRecord(payload.runtimeProjection);
  const runtimeProjectionState = contextRecord(payload.runtimeProjectionState);
  const currentIssue = contextRecord(payload.currentIssue);
  const currentIssueTasks = Array.isArray(currentIssue.tasks) ? currentIssue.tasks : [];
  const plugins = Array.isArray(payload.plugins) ? payload.plugins : [];
  const checks = Array.isArray(payload.checks) ? payload.checks : [];
  const activeRuns = Array.isArray(payload.activeRuns) ? payload.activeRuns : [];
  const attention = Array.isArray(ledger.attention) ? ledger.attention : [];
  const readyTasks = Array.isArray(ledger.readyTasks) ? ledger.readyTasks : [];
  const recommendedExecution = contextRecord(payload.recommendedExecution);
  const runtimeIdentity = contextRecord(payload.runtimeIdentity);
  const runtime = contextRecord(payload.runtime);
  const repoId = String(payload.repoId ?? repository.repoId ?? '');
  const enabledCount = plugins.filter((plugin) => contextRecord(plugin).enabled === true).length;
  const unhealthyCount = plugins.filter((plugin) => {
    const health = contextRecord(contextRecord(plugin).health);
    return health.state === 'unhealthy' || health.ready === false;
  }).length;
  const attentionPluginIds = plugins
    .filter((plugin) => {
      const health = contextRecord(contextRecord(plugin).health);
      return ['degraded', 'unhealthy', 'error'].includes(String(health.state));
    })
    .map((plugin) => contextRecord(plugin).pluginId)
    .filter((id): id is string => typeof id === 'string')
    .slice(0, 5);
  const recommendedCheckIds = checks
    .filter((check) => contextRecord(check).recommended === true || contextRecord(check).required === true)
    .map((check) => contextRecord(check).id)
    .filter((id): id is string => typeof id === 'string')
    .slice(0, 8);
  const lastFailureCount = checks.filter((check) => {
    const value = contextRecord(check);
    return value.lastFailureAt || value.failed === true;
  }).length;
  const changedFileCount = typeof git.changedFileCount === 'number'
    ? git.changedFileCount
    : typeof git.diffStat === 'string'
      ? git.diffStat.split(/\r?\n/).filter((line) => line.includes('|')).length
      : git.dirty === true ? -1 : 0;
  const compact: Record<string, unknown> = {
    detailLevel: 'summary',
    // Deprecated compatibility: legacy clients read this before focus.currentIssue.
    ...(payload.currentIssueId !== undefined ? { currentIssueId: payload.currentIssueId } : {}),
    repoId,
    repository: {
      repoId,
      checkoutId: repository.activeCheckoutId ?? repository.checkoutId,
      root: repository.canonicalRoot ?? repository.root ?? repository.localRoot,
      branch: git.branch,
      head: git.head,
      dirty: git.dirty === true,
      changedFileCount,
    },
    focus: {
      ...(currentIssue.id ? {
        currentIssue: {
          id: currentIssue.id,
          title: currentIssue.title,
          status: currentIssue.status,
          lifecycleStatus: currentIssue.lifecycleStatus,
          updatedAt: currentIssue.updatedAt,
          taskCount: currentIssueTasks.length,
          tasks: currentIssueTasks.slice(0, 5).map(compactContextTask),
        },
      } : {}),
      ...(payload.currentTask && typeof payload.currentTask === 'object' ? { currentTask: payload.currentTask } : {}),
      activeRunCount: activeRuns.length,
      ...(typeof payload.activeJobCount === 'number' ? { activeJobCount: payload.activeJobCount } : {}),
    },
    health: {
      ready: ready.ready === true,
      reasonCodes: Array.isArray(ready.reasonCodes) ? ready.reasonCodes.slice(0, 10) : [],
      diagnostics: contextRecord(ready.diagnostics),
      observedAt: ready.observedAt,
    },
    attention: attention.slice(0, 5).map(compactContextTask),
    readyTasks: readyTasks.slice(0, 5).map(compactContextTask),
    execution: {
      recommendedMode: recommendedExecution.mode ?? recommendedExecution.recommendedMode ?? null,
      executionPath: recommendedExecution.executionPath ?? recommendedExecution.path ?? null,
      requiredChecks: recommendedCheckIds,
    },
    runtime: {
      releaseId: runtime.releaseId ?? runtimeIdentity.releaseId,
      runtimeCommit: runtime.runtimeCommit ?? runtimeIdentity.runtimeCommit,
      controllerInstanceId: runtime.controllerInstanceId ?? runtimeIdentity.controllerInstanceId,
      toolset: runtime.toolset ?? runtimeIdentity.toolset,
    },
    detailPointers: {
      git: { tool: 'repository_git_status', arguments: { repo_id: repoId } },
      taskLedger: { tool: 'controller_context', arguments: { repo_id: repoId, detail_level: 'detail' } },
      plugin: { tool: 'list_plugins', arguments: { repo_id: repoId } },
      check: { tool: 'controller_context', arguments: { repo_id: repoId, detail_level: 'detail' } },
      history: { tool: 'controller_context', arguments: { repo_id: repoId, detail_level: 'detail' } },
    },
    git: {
      branch: git.branch,
      head: git.head,
      dirty: git.dirty === true,
      changedFileCount,
    },
    plugins: { enabledCount, disabledCount: Math.max(0, plugins.length - enabledCount), unhealthyCount, attentionPluginIds },
    checks: { availableCount: checks.length, recommendedCheckIds, lastFailureCount },
    taskLedger: {
      schemaVersion: ledger.schemaVersion,
      source: ledger.source,
      generatedAt: ledger.generatedAt,
      currentIssueId: ledger.currentIssueId,
      counts: ledger.counts,
      issueCount: ledger.issueCount,
      archivedIssueCount: ledger.archivedIssueCount,
      status: ledger.status,
      contextContract: {
        strategy: contextRecord(ledger.contextContract).strategy,
        rawCodeRequiredForImplementation: true,
      },
    },
    operationalPlan: {
      schemaVersion: operationalPlan.schemaVersion,
      source: operationalPlan.source,
      generatedAt: operationalPlan.generatedAt,
      status: operationalPlan.status,
      completedCapabilities: (Array.isArray(operationalPlan.completedCapabilities) ? operationalPlan.completedCapabilities : []).slice(0, 5),
      remainingDecisionPoints: (Array.isArray(operationalPlan.remainingDecisionPoints) ? operationalPlan.remainingDecisionPoints : []).slice(0, 5),
      validationStrategy: operationalPlan.validationStrategy,
    },
    // Required keys for cache-completeness and legacy readers (deprecated).
    runtimeStorage: payload.runtimeStorage,
    runtimeProjectionState,
    runtimeProjection: runtimeProjection.repoId || runtimeProjection.revision !== undefined
      ? {
        schemaVersion: runtimeProjection.schemaVersion,
        repoId: runtimeProjection.repoId,
        generatedAt: runtimeProjection.generatedAt,
        revision: runtimeProjection.revision,
        queueDepth: runtimeProjection.queueDepth,
        runningWorkers: runtimeProjection.runningWorkers,
        activeLeases: runtimeProjection.activeLeases,
        currentAttention: (Array.isArray(runtimeProjection.currentAttention) ? runtimeProjection.currentAttention : []).slice(0, 5),
      }
      : runtimeProjection,
    activeRuns: activeRuns.slice(0, 5).map((run) => {
      const value = contextRecord(run);
      return { runId: value.runId, issueId: value.issueId, taskId: value.taskId, status: value.status, agent: value.agent, provider: value.provider, progress: value.progress, lastHeartbeatAt: value.lastHeartbeatAt, error: contextText(value.error, 300) };
    }),
    localBridge: (() => {
      const localBridge = contextRecord(payload.localBridge);
      return { reconciliation: localBridge.reconciliation };
    })(),
    recommendedExecution: recommendedExecution,
    ...(payload.repository ? { repositorySummary: repository } : {}),
  };
  if (ready.health || ready.ready !== undefined) {
    compact.controllerReady = summarizeControllerReadyPayload(ready);
  }
  return compact;
}

function authenticatedFacadeControllerIdentity(
  ctx: MultiRepositoryMcpToolContext,
  args: Record<string, unknown>,
): { controllerId: string; principalId: string; sessionId: string; controllerInstanceId: string; controllerType: 'chatgpt' | 'codex' | 'claude' | 'grok' | 'human' } {
  const principalId = ctx.principalId?.trim();
  const sessionId = ctx.sessionId?.trim();
  if (!principalId || !sessionId) {
    throw new Error('CONTROLLER_AUTHENTICATED_SESSION_REQUIRED: reconnect or call session_start through the authenticated MCP transport');
  }
  const requestedControllerId = typeof args.controller_id === 'string' ? args.controller_id.trim() : '';
  const requestedSessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
  if (requestedControllerId && requestedControllerId !== principalId) {
    throw new Error('CONTROLLER_ID_CONTEXT_MISMATCH: controller_id must match the authenticated principal');
  }
  if (requestedSessionId && requestedSessionId !== sessionId) {
    throw new Error('CONTROLLER_SESSION_CONTEXT_MISMATCH: session_id must match the authenticated MCP session');
  }
  const requestedControllerType = typeof args.controller_type === 'string' && ['chatgpt', 'codex', 'claude', 'grok', 'human'].includes(args.controller_type)
    ? args.controller_type as 'chatgpt' | 'codex' | 'claude' | 'grok' | 'human'
    : undefined;
  const transportControllerType = ctx.controllerType;
  if (transportControllerType && requestedControllerType && requestedControllerType !== transportControllerType) {
    throw new Error('CONTROLLER_TYPE_CONTEXT_MISMATCH: controller_type must match the authenticated transport provider');
  }
  return {
    controllerId: principalId,
    principalId,
    sessionId,
    controllerType: transportControllerType ?? requestedControllerType ?? 'chatgpt',
    controllerInstanceId: ctx.controllerInstanceId?.trim() || currentControllerInstanceId(),
  };
}

function ensureFacadeWorkHandle(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  workId: string,
  args: Record<string, unknown>,
): WorkHandleState | undefined {
  const existing = readWorkHandle(ctx.controllerHome, repository.repoId, workId);
  if (existing) return existing;
  const contract = getWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, workId);
  if (!contract || contract.workKind !== 'repository_change' || contract.mode !== 'goal_workloop' || !contract.checkoutId) return undefined;
  const executionRepository = resolveRepositorySelection({ repoId: repository.repoId, checkoutId: contract.checkoutId, controllerHome: ctx.controllerHome, allowSoleRepository: false });
  const checkout = selectRepositoryCheckout(executionRepository, contract.checkoutId, { allowArchived: true });
  const status = repositoryGitStatus(checkout);
  if (!status.branch) throw new Error(`WORKTREE_DETACHED: ${contract.checkoutId} has no branch`);
  const identity = authenticatedFacadeControllerIdentity(ctx, args);
  const at = new Date().toISOString();
  const managedWorktree = Boolean(contract.worktreeRef) && resolve(contract.worktreeRef!) === resolve(checkout.canonicalRoot) && resolve(checkout.canonicalRoot) !== resolve(repository.canonicalRoot);
  return writeWorkHandle(ctx.controllerHome, {
    schemaVersion: 1,
    workId,
    sessionId: identity.sessionId,
    principalId: identity.principalId,
    repositoryId: repository.repoId,
    checkoutId: contract.checkoutId,
    worktreePath: checkout.canonicalRoot,
    branch: status.branch,
    sourceCheckoutId: repository.activeCheckoutId,
    managedWorktree,
    workContractId: contract.workId,
    baseCommit: contract.baseRevision ?? status.head ?? undefined,
    expectedHead: status.head ?? contract.baseRevision,
    permissionSnapshotVersion: currentPermissionSnapshotVersion(ctx.controllerHome, repository.repoId),
    state: 'prepared',
    createdAt: at,
    updatedAt: at,
    finalization: { validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending' },
    cleanupResponsibility: { owner: 'work_finalizer', registeredAt: at },
  });
}

function claimNewFacadeWork(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  workId: string,
  args: Record<string, unknown>,
) {
  const identity = authenticatedFacadeControllerIdentity(ctx, args);
  return resumeControllerSession({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, {
    workId,
    controllerId: identity.controllerId,
    controllerType: identity.controllerType,
    sessionId: identity.sessionId,
    principalId: identity.principalId,
    controllerInstanceId: identity.controllerInstanceId,
    leaseMs: typeof args.lease_ms === 'number' ? args.lease_ms : undefined,
  });
}

function bindFacadeExecutionSession(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  handle: WorkHandleState,
  args: Record<string, unknown>,
) {
  const identity = authenticatedFacadeControllerIdentity(ctx, args);
  const session = startExecutionSession(ctx.controllerHome, {
    sessionId: identity.sessionId,
    principalId: identity.principalId,
    controllerInstanceId: identity.controllerInstanceId,
    permissionSnapshotVersion: handle.permissionSnapshotVersion,
  });
  return updateExecutionSession(ctx.controllerHome, {
    sessionId: session.sessionId,
    principalId: session.principalId,
    controllerInstanceId: session.controllerInstanceId,
  }, {
    activeRepositoryId: repository.repoId,
    activeCheckoutId: handle.checkoutId,
    activeWorkId: handle.workId,
    permissionSnapshotVersion: handle.permissionSnapshotVersion,
    lastValidatedAt: new Date().toISOString(),
  });
}

async function finalizeFacadeWorkHandle(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  args: Record<string, unknown>,
  operation: 'finalize' | 'stop',
): Promise<CallToolResult | undefined> {
  const workId = String(args.work_id ?? '').trim();
  if (!workId) return undefined;
  let handle = readWorkHandle(ctx.controllerHome, repository.repoId, workId);
  if (!handle) return undefined;
  const session = bindFacadeExecutionSession(ctx, repository, handle, args);
  const targetBranch = typeof args.target_branch === 'string' && args.target_branch.trim()
    ? args.target_branch.trim()
    : repository.defaultBranch || 'main';
  const common = {
    session_id: session.sessionId,
    repo_id: repository.repoId,
    work_id: workId,
    target_branch: targetBranch,
    delete_branch: args.delete_branch !== false,
    cleanup: args.cleanup !== false,
  };

  if (operation === 'stop') {
    return callExecutionTool(ctx, 'work_finalize', {
      ...common,
      commit: false,
      merge: false,
    });
  }

  const worktree = selectRepositoryCheckout(repository, handle.checkoutId, { allowArchived: true });
  const status = repositoryGitStatus(worktree);
  const head = status.head ?? handle.expectedHead ?? handle.baseCommit;
  const committedDelta = Boolean(head && handle.baseCommit && head !== handle.baseCommit);
  const commit = typeof args.commit === 'boolean' ? args.commit : !status.clean;
  const workContract = getWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, workId);
  if (
    status.clean
    && committedDelta
    && commit === false
    && (workContract?.allowedPaths.length ?? 0) > 0
    && head
    && handle.expectedHead
    && head !== handle.expectedHead
    && (handle.state === 'prepared' || handle.state === 'editing')
  ) {
    const contract = getWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, workId);
    if ((contract?.allowedPaths.length ?? 0) > 0 || (contract?.forbiddenPaths.length ?? 0) > 0) {
      const adopted = await callExecutionTool(ctx, 'work_prepare', {
        session_id: session.sessionId,
        repo_id: repository.repoId,
        checkout_id: handle.checkoutId,
        work_id: workId,
        expected_previous_head: handle.expectedHead,
        adopt_candidate_head: head,
      });
      if (!adopted || adopted.isError === true) return adopted;
      handle = readWorkHandle(ctx.controllerHome, repository.repoId, workId) ?? handle;
    } else if (handle.state === 'prepared') {
      // A Work without explicit path allow/deny constraints historically permits
      // repository-scoped committed progress. Preserve that contract while moving
      // the handle onto a legal lifecycle edge before the physical finalizer
      // validates and adopts the exact delivery HEAD.
      handle = transitionWorkHandle(ctx.controllerHome, handle, 'editing', { failureReason: undefined });
    }
  }
  const requestedOutcome = args.completion_outcome === 'completed_no_change' || args.completion_outcome === 'completed_changed'
    ? args.completion_outcome
    : undefined;
  const completionOutcome = requestedOutcome ?? (!commit && !committedDelta && status.clean ? 'completed_no_change' : 'completed_changed');
  // A proven no-change completion has nothing to merge. Defaulting merge=true
  // forced the generic Git delivery path to do unnecessary work and conflicted
  // with work_finalize's explicit no-change contract.
  const merge = typeof args.merge === 'boolean' ? args.merge : completionOutcome !== 'completed_no_change';
  const explicitNoChangeEvidence = typeof args.no_change_evidence === 'string' ? args.no_change_evidence.trim() : '';
  const noChangeEvidence = completionOutcome === 'completed_no_change'
    ? explicitNoChangeEvidence || `Validated Work ${workId} has no repository delta from base ${handle.baseCommit ?? 'unknown'} at clean HEAD ${head ?? 'unknown'}.`
    : undefined;
  const finalizeArgs = {
    ...common,
    commit,
    merge,
    no_ff: args.no_ff === true,
    completion_outcome: completionOutcome,
    ...(noChangeEvidence ? { no_change_evidence: noChangeEvidence } : {}),
  };

  const validateExactWorkspace = async (): Promise<CallToolResult | undefined> => {
    const contract = getWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, workId);
    const validation = await callExecutionTool(ctx, 'work_validate', {
      session_id: session.sessionId,
      repo_id: repository.repoId,
      work_id: workId,
      check_ids: contract?.checks ?? [],
    });
    if (!validation || validation.isError === true) return validation;
    const validationPayload = contextRecord(validation.structuredContent);
    return contextRecord(validationPayload.validation).passed === true ? undefined : validation;
  };

  let physical = await callExecutionTool(ctx, 'work_finalize', finalizeArgs);
  let payload = contextRecord(physical?.structuredContent);
  if (physical?.isError === true && contextRecord(payload.error).code === 'WORK_VALIDATION_REQUIRED') {
    const validationFailure = await validateExactWorkspace();
    if (validationFailure) return validationFailure;
    physical = await callExecutionTool(ctx, 'work_finalize', finalizeArgs);
    payload = contextRecord(physical?.structuredContent);
  }
  if (
    physical
    && physical.isError !== true
    && typeof payload.continuation === 'string'
    && payload.continuation.startsWith('WORK_COMMITTED_REVALIDATION_REQUIRED')
  ) {
    const validationFailure = await validateExactWorkspace();
    if (validationFailure) return validationFailure;
    physical = await callExecutionTool(ctx, 'work_finalize', finalizeArgs);
  }
  return physical;
}

function structuralIndexRoot(repository: ReturnType<typeof resolveRepositorySelection>): string | undefined {
  if (existsSync(join(repository.canonicalRoot, '.codegraph', 'codegraph.db'))) return repository.canonicalRoot;
  return repository.checkouts
    .filter((checkout) => checkout.checkoutId !== repository.activeCheckoutId && checkout.worktree !== true)
    .map((checkout) => checkout.canonicalRoot)
    .find((root) => existsSync(join(root, '.codegraph', 'codegraph.db')));
}

function selected(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>) {
  return resolveRepositorySelection({
    repoId: typeof args.repo_id === 'string' ? args.repo_id : undefined,
    checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
    explicitPath: ctx.explicitRepository?.canonicalRoot,
    controllerHome: ctx.controllerHome,
    allowSoleRepository: true,
  });
}

function schemaAwareWorkSubmitArguments(
  name: string,
  explicitArguments: Record<string, unknown>,
  repository: ReturnType<typeof selected>,
  definition: McpToolDefinition,
  timeoutMs: unknown,
): Record<string, unknown> {
  const schema = definition.inputSchema as { properties?: Record<string, unknown> };
  const declared = new Set(Object.keys(schema.properties ?? {}));
  const candidates = repositoryScopedToolArgs(name, {
    ...explicitArguments,
    ...(declared.has('repo_id') ? { repo_id: repository.repoId } : {}),
    ...(declared.has('timeout_ms') && typeof timeoutMs === 'number' ? { timeout_ms: timeoutMs } : {}),
  }, repository);
  const scoped: Record<string, unknown> = { ...explicitArguments };
  for (const [key, value] of Object.entries(candidates)) {
    if (Object.hasOwn(explicitArguments, key) || declared.has(key)) scoped[key] = value;
  }
  return scoped;
}

function pluginRepository(
  ctx: MultiRepositoryMcpToolContext,
  args: Record<string, unknown>,
  pluginId: string,
) {
  return assistantPluginScope(pluginId, ctx.controllerHome) === 'controller'
    ? controllerPluginRepository(ctx.controllerHome)
    : selected(ctx, args);
}

function definedArguments(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function legacyIosPluginAction(
  ctx: MultiRepositoryMcpToolContext,
  legacyTool: string,
  args: Record<string, unknown>,
  actionId: string,
  actionArgs: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  const repository = selected(ctx, args);
  const requestId = typeof args.request_id === 'string' && args.request_id.trim()
    ? args.request_id.trim()
    : `legacy-${legacyTool}-${Date.now()}`;
  return callRuntimeTool(ctx, 'plugin_action_execute', {
    repo_id: repository.repoId,
    checkout_id: repository.activeCheckoutId,
    plugin_id: 'ios',
    action_id: actionId,
    request_id: requestId,
    arguments: definedArguments(actionArgs),
    ...(args.confirm_authorization === true ? { confirm_authorization: true } : {}),
  });
}

function expectedRevision(args: Record<string, unknown>, key = 'expected_revision'): number | undefined {
  return typeof args[key] === 'number' ? Math.trunc(args[key] as number) : undefined;
}

/**
 * Projection freshness is event-driven (source identity, invalidation marker,
 * materialized-view revision). The wall-clock TTL is only a bounded fallback
 * for lost events, so it is intentionally coarse.
 */
const CONTROLLER_CONTEXT_PROJECTION_REFRESH_MS = Math.max(
  5_000,
  Number(process.env.FORGE_CONTEXT_PROJECTION_REFRESH_MS ?? 300_000),
);

/** Git identity sampling TTL: one bounded subprocess burst, then cheap reads. */
const GIT_IDENTITY_SAMPLE_TTL_MS = Math.max(1_000, Number(process.env.FORGE_GIT_IDENTITY_SAMPLE_TTL_MS ?? 3_000));

function ageMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : undefined;
}

async function probeLocalControllerHealth(endpoint: string | undefined): Promise<Record<string, unknown> | null> {
  if (!endpoint) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const url = new URL(endpoint);
    url.pathname = '/health';
    url.search = '';
    url.hash = '';
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    return await response.json() as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function localControllerDiagnosticMatchesRuntime(
  payload: Record<string, unknown> | null,
  expected: { generation?: string } = {},
): boolean {
  return payload?.status === 'ok'
    && payload.toolSurface === FORGE_TOOL_SURFACE
    && payload.schemaVersion === FORGE_MCP_SCHEMA_VERSION
    && payload.version === FORGE_VERSION
    && (expected.generation === undefined || payload.generation === expected.generation);
}

export interface ControllerReadinessSignals {
  externalEndpoint?: GradedObservation;
  mcpHandshake?: GradedObservation;
  sessionContinuity?: GradedObservation;
}

export async function controllerReadinessEvidence(
  ctx: MultiRepositoryMcpToolContext,
  repository = ctx.explicitRepository,
  signals: ControllerReadinessSignals = {},
) {
  const daemon = readForgeRuntimeStatus(ctx.controllerHome);
  const scheduler = readSchedulerHealthSnapshot(ctx.controllerHome);
  const projectionSnapshot = repository ? readRepositoryProjectionSnapshot(ctx.controllerHome, repository.repoId) : undefined;
  const projection = projectionSnapshot?.projection;
  const taskLedger = repository && !legacyIssueAuthorityRetired(repository.canonicalRoot)
    ? buildControllerTaskLedgerProjection(repository.canonicalRoot)
    : undefined;
  const projectionReconciliation = projectionSnapshot
    ? reconcileReadinessProjectionSource(projectionSnapshot, taskLedger)
    : undefined;
  const localBridgeSurface = repository
    ? resolveLocalBridgeSurface({
      controllerHome: ctx.controllerHome,
      repoRoot: repository.canonicalRoot,
      allowProcessScan: false,
    })
    : undefined;
  const localBridgeEndpoint = localBridgeSurface?.endpoint;
  const shouldProbeLocalBridge = Boolean(
    localBridgeSurface?.enabled
    && localBridgeSurface.endpointConfigured
    && localBridgeEndpoint
    && localBridgeSurface.mode !== 'disabled',
  );
  const localBridgeLiveHealth = shouldProbeLocalBridge
    ? await probeLocalControllerHealth(localBridgeEndpoint)
    : null;
  const localBridgeEndpointReachable = localBridgeLiveHealth !== null;
  const localBridgeExpectedSurface = shouldProbeLocalBridge
    ? localControllerDiagnosticMatchesRuntime(localBridgeLiveHealth, {
      generation: localBridgeSurface?.generation,
    })
    : true;
  const schedulerHeartbeatAgeMs = ageMs(scheduler.lastTickAt);
  const dispatchHeartbeatAgeMs = ageMs(scheduler.lastDispatchAt);
  const localBridgeObservation = {
    enabled: localBridgeSurface?.enabled ?? false,
    requiredForReadiness: localBridgeSurface?.requiredForReadiness ?? false,
    mode: localBridgeSurface?.mode ?? ('disabled' as const),
    endpoint: localBridgeEndpoint,
    endpointReachable: shouldProbeLocalBridge ? localBridgeEndpointReachable : true,
    expectedSurface: localBridgeExpectedSurface,
    processAlive: localBridgeSurface?.processRunning,
    runtimeStateFresh: localBridgeSurface?.source === 'service-runtime'
      || localBridgeSurface?.source === 'repo-runtime',
    error: localBridgeSurface?.error,
  };
  const runtimeHealth = evaluateRuntimeHealth({
    daemon: {
      status: daemon.status,
      error: daemon.error,
      // Scheduler ticks are emitted by the Canonical Forge Runtime process and provide
      // its continuously refreshed heartbeat without introducing a second timer.
      heartbeatAgeMs: schedulerHeartbeatAgeMs,
    },
    scheduler: {
      status: daemon.degraded ? 'degraded' : daemon.status,
      heartbeatAgeMs: schedulerHeartbeatAgeMs,
      dispatchHeartbeatAgeMs,
    },
    workers: {
      queueDepth: projection?.queueDepth,
      runningWorkers: projection?.runningWorkers,
      activeLeases: projection?.activeLeases,
      activeAttentionCount: projection?.currentAttention.length,
    },
    projection: projectionSnapshot ? projectionObservation(projectionSnapshot, projectionReconciliation) : {
      readable: true,
      persisted: true,
    },
    localBridge: localBridgeObservation,
    runtimeStorage: { readable: true, ready: true },
    ...signals,
  });
  const operationalView: RuntimeOperationalView = buildRuntimeOperationalView({
    health: runtimeHealth,
    handoffs: repository
      ? listHandoffItems({ controllerHome: ctx.controllerHome, repoId: repository.repoId, status: 'all', limit: 100 })
      : [],
    jobs: repository ? listExecutionJobs(ctx.controllerHome, repository.repoId, 100) : [],
  });
  const reasons: Array<{ code: string; message: string }> = runtimeHealth.activeBlockers.map((item) => ({
    code: item.code === 'SCHEDULER_NOT_PROGRESSING'
      ? 'DISPATCH_LOOP_STALLED'
      : item.code === 'LEASE_WITHOUT_WORKER' || item.code === 'WORKER_NOT_RUNNING'
        ? 'WORKER_NOT_RUNNING'
        : item.code,
    message: item.message,
  }));
  if (
    reasons.some((item) => item.code === 'WORKER_NOT_RUNNING')
    && (dispatchHeartbeatAgeMs === undefined || dispatchHeartbeatAgeMs > RUNTIME_HEALTH_THRESHOLDS.queueProgressStaleMs)
  ) {
    reasons.push({
      code: 'QUEUE_NOT_PROGRESSING',
      message: 'Queued Jobs have not received a recent dispatch heartbeat.',
    });
  }
  const ready = runtimeHealth.ready;
  return {
    ready,
    state: ready ? runtimeHealth.state === 'healthy' ? 'ready' as const : 'degraded' as const : daemon.status === 'ready' ? 'degraded' as const : 'not_ready' as const,
    reasons,
    warnings: runtimeHealth.warnings.map((item) => ({ code: item.code, message: item.message })),
    health: runtimeHealth,
    operationalView,
    daemon,
    durableScheduler: {
      status: runtimeHealth.components.scheduler.ready ? 'ready' : daemon.status === 'ready' ? 'degraded' : 'not_ready',
      loopStartedAt: scheduler.loopStartedAt,
      lastTickAt: scheduler.lastTickAt,
      lastDispatchAt: scheduler.lastDispatchAt,
      lastReconcileAt: scheduler.lastReconcileAt,
      heartbeatAgeMs: schedulerHeartbeatAgeMs,
      dispatchHeartbeatAgeMs,
    },
    workerLoop: {
      status: projection?.runningWorkers ? 'running' : projection?.queueDepth ? 'idle' : 'ready',
      queueDepth: projection?.queueDepth ?? 0,
      runningWorkers: projection?.runningWorkers ?? 0,
      activeLeases: projection?.activeLeases ?? 0,
      activeAttentionCount: projection?.currentAttention.length ?? 0,
      consuming: (projection?.queueDepth ?? 0) === 0 || (projection?.runningWorkers ?? 0) > 0,
    },
    localBridge: repository ? {
      running: Boolean(localBridgeSurface?.enabled)
        && runtimeHealth.components.localBridge.ready
        && (!shouldProbeLocalBridge || (localBridgeEndpointReachable && localBridgeExpectedSurface)),
      endpoint: localBridgeEndpoint,
      error: localBridgeSurface?.error,
      inferredPid: localBridgeSurface?.pid,
      statusSource: localBridgeSurface?.source ?? 'none',
      health: runtimeHealth.components.localBridge,
    } : undefined,
    projection,
    projectionSnapshot,
    taskLedger,
    projectionReconciliation,
    semantics: classifyRuntimeReadinessSemantics(runtimeHealth),
  };
}

export async function controllerReadiness(
  ctx: MultiRepositoryMcpToolContext,
  repository = ctx.explicitRepository,
  signals: ControllerReadinessSignals = {},
) {
  const evidence = await controllerReadinessEvidence(ctx, repository, signals);
  const reasonCodes = new Set(evidence.reasons.map((item) => item.code));
  const controllerServicesReady = evidence.daemon.status === 'ready' && evidence.daemon.degraded !== true;
  const schedulerReady = evidence.durableScheduler.status === 'ready';
  const workersReady = evidence.workerLoop.consuming;
  const databaseReady = evidence.health.components.projection.ready;
  const releaseCoherenceReady = evidence.daemon.status === 'ready' && evidence.daemon.degraded !== true;
  const runtimeSource = runtimeSourceSnapshotStatus(evidence.daemon.source, ctx.runtimeSourceRoot);
  const sourceCoherenceReady = !runtimeSource.restartRequired;
  if (!sourceCoherenceReady) reasonCodes.add(runtimeSource.code);
  const ready = evidence.ready
    && controllerServicesReady
    && schedulerReady
    && workersReady
    && databaseReady
    && releaseCoherenceReady
    && sourceCoherenceReady;

  return {
    ready,
    reasonCodes: [...reasonCodes],
    diagnostics: {
      database: {
        ready: databaseReady,
        evidence: {
          persisted: evidence.projectionSnapshot?.persisted,
          stale: evidence.projectionSnapshot?.stale,
          projectionRevision: evidence.projection?.revision,
        },
      },
      controllerServices: {
        ready: controllerServicesReady,
        evidence: {
          status: evidence.daemon.status,
          degraded: evidence.daemon.degraded,
          error: evidence.daemon.error,
        },
      },
      scheduler: {
        ready: schedulerReady,
        evidence: {
          loopStartedAt: evidence.durableScheduler.loopStartedAt,
          lastTickAt: evidence.durableScheduler.lastTickAt,
          lastDispatchAt: evidence.durableScheduler.lastDispatchAt,
          heartbeatAgeMs: evidence.durableScheduler.heartbeatAgeMs,
          dispatchHeartbeatAgeMs: evidence.durableScheduler.dispatchHeartbeatAgeMs,
        },
      },
      workers: {
        ready: workersReady,
        evidence: {
          queueDepth: evidence.workerLoop.queueDepth,
          runningWorkers: evidence.workerLoop.runningWorkers,
          activeLeases: evidence.workerLoop.activeLeases,
          consuming: evidence.workerLoop.consuming,
        },
      },
      releaseCoherence: {
        ready: releaseCoherenceReady && sourceCoherenceReady,
        evidence: {
          status: evidence.daemon.status,
          degraded: evidence.daemon.degraded,
          error: evidence.daemon.error,
          sourceCoherence: {
            ready: sourceCoherenceReady,
            code: runtimeSource.code,
            reasons: runtimeSource.reasons,
          },
        },
      },
      mcpEndToEnd: {
        ready: evidence.ready,
        evidence: {
          activeBlockers: evidence.reasons,
          warnings: evidence.warnings,
        },
      },
    },
    observedAt: new Date().toISOString(),
  };
}

async function capabilityRecoveryInput(ctx: MultiRepositoryMcpToolContext, repository: ReturnType<typeof selected>, args: Record<string, unknown>) {
  const readiness = await controllerReadinessEvidence(ctx, repository);
  const runtimeSnapshot = readRepositoryProjectionSnapshot(ctx.controllerHome, repository.repoId);
  const localBridge = loadMcpRuntimeState(repository.canonicalRoot)?.localController;
  const inferredLocalBridge = inferLocalControllerProcess(repository.canonicalRoot);
  const contextProjectionSourceRevision = String(runtimeSnapshot.projection.metadata?.contentRevision ?? runtimeSnapshot.projection.revision);
  const contextGitIdentity = cachedGitIdentity(repository.canonicalRoot);
  const contextSourceIdentity = {
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    canonicalRoot: repository.canonicalRoot,
    head: contextGitIdentity.head,
    branch: contextGitIdentity.branch,
    workingTreeFingerprint: contextGitIdentity.workingTreeFingerprint,
    runtimeGeneration: runtimeSnapshot.projection.metadata?.producerGeneration,
    sourceRevision: contextProjectionSourceRevision,
    variant: 'summary' as const,
    toolset: ctx.toolset,
    profile: ctx.policy.profile,
  };
  const contextProjection = readControllerContextProjection(ctx.controllerHome, repository.repoId, {
    sourceIdentity: contextSourceIdentity,
  });
  const contextProjectionStale = controllerContextProjectionNeedsRefresh(
    contextProjection,
    contextProjectionSourceRevision,
    contextSourceIdentity,
  );
  const recentErrors = Array.isArray(args.recent_errors) ? args.recent_errors.map(String) : [];
  const runtimeSource = runtimeSourceSnapshotStatus(readiness.daemon.source, ctx.runtimeSourceRoot);
  let runtimeStorageReady: boolean | undefined;
  let runtimeStorageWarnings: string[] = [];
  try {
    const runtimeStorage = ensureRepositoryRuntimeStorage(repository, ctx.controllerHome);
    runtimeStorageReady = runtimeStorage.readyForExecution;
    runtimeStorageWarnings = runtimeStorage.warnings;
  } catch (error) {
    runtimeStorageReady = false;
    runtimeStorageWarnings = [error instanceof Error ? error.message : String(error)];
  }
  const plugins = listAssistantPluginManifests(ctx.controllerHome, repository, {
    preferStored: true,
  });
  const localJobs = listLocalBridgeJobSnapshots(repository.canonicalRoot, 30);
  const executionJobs = listExecutionJobs(ctx.controllerHome, repository.repoId, 30);
  return {
    generatedAt: new Date().toISOString(),
    daemonStatus: readiness.daemon.status,
    daemonError: readiness.daemon.error,
    schedulerStatus: readiness.durableScheduler.status,
    schedulerHeartbeatAgeMs: readiness.durableScheduler.heartbeatAgeMs,
    schedulerDispatchHeartbeatAgeMs: readiness.durableScheduler.dispatchHeartbeatAgeMs,
    queueDepth: readiness.workerLoop.queueDepth,
    runningWorkers: readiness.workerLoop.runningWorkers,
    activeLeases: readiness.workerLoop.activeLeases,
    localBridgeRunning: localBridge?.running ?? inferredLocalBridge?.running,
    localBridgeError: localBridge?.error,
    runtimeHealth: readiness.health as RuntimeHealthEvaluation,
    runtimeOperationalView: readiness.operationalView,
    connectorHealthy: undefined,
    runtimeProjectionStale: runtimeSnapshot.stale,
    runtimeProjectionPersisted: runtimeSnapshot.persisted,
    runtimeSourceCoherence: {
      ready: !runtimeSource.restartRequired,
      code: runtimeSource.code,
      reasons: runtimeSource.reasons,
      summary: runtimeSource.restartRequired
        ? formatRuntimeSourceDriftMessage(runtimeSource)
        : 'Runtime source snapshot matches the current Controller Runtime source.',
    },
    contextProjectionStale,
    commandPreviewAvailable: args.command_preview_available === undefined ? true : args.command_preview_available === true,
    commandExecuteAvailable: args.command_execute_available === undefined ? true : args.command_execute_available === true,
    issueToolsAvailable: args.issue_tools_available === undefined ? true : args.issue_tools_available === true,
    jobToolsAvailable: args.job_tools_available === undefined ? true : args.job_tools_available === true,
    checksAvailable: listControllerChecks(repository.canonicalRoot).length > 0,
    runtimeStorageReady,
    runtimeStorageWarnings,
    pluginStates: plugins.map((plugin) => ({
      pluginId: plugin.pluginId,
      enabled: plugin.enabled,
      healthState: plugin.health.state,
      ready: plugin.health.ready,
      errors: plugin.health.errors,
      warnings: plugin.health.warnings,
    })),
    recentErrors,
    localJobs: localJobs.map((job) => ({ status: job.status, error: job.error, updatedAt: job.updatedAt })),
    executionJobs: executionJobs.map((job) => ({ status: job.status, error: job.error, updatedAt: job.updatedAt, operation: job.payload.operation })),
  };
}

async function capabilityRecoverySnapshot(ctx: MultiRepositoryMcpToolContext, repository: ReturnType<typeof selected>, args: Record<string, unknown>) {
  return buildCapabilityRecoverySnapshot(await capabilityRecoveryInput(ctx, repository, args));
}

function workPhase(status: ExecutionJob['status']): 'queued' | 'running' | 'attention' | 'completed' {
  if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(status)) return 'completed';
  if (['orphaned', 'stale', 'human_attention_required'].includes(status)) return 'attention';
  if (status === 'running' || status === 'dispatched') return 'running';
  return 'queued';
}

function summarizeWork(job: ExecutionJob, repoRoot?: string): Record<string, unknown> {
  const summary = summarizeExecutionJob(job, repoRoot);
  return {
    workId: job.jobId,
    requestId: job.requestId,
    repoId: job.repoId,
    operation: typeof job.payload?.operation === 'string' ? job.payload.operation : job.type,
    phase: workPhase(job.status),
    resumable: true,
    ...summary,
  };
}

const TERMINAL_WORK_HANDLE_STATES = new Set<WorkHandleState['state']>(['cleaned', 'failed']);

function workHandlePhase(handle: WorkHandleState): 'implementation' | 'verification' | 'delivery' | 'cleanup' | 'completed' | 'attention' {
  if (handle.state === 'cleaned') return 'completed';
  if (handle.state === 'failed') return 'attention';
  if (handle.state === 'validating') return 'verification';
  if (handle.state === 'committed') return 'delivery';
  if (handle.state === 'merged') return 'cleanup';
  return 'implementation';
}

function reconcileReadableWorkHandle(
  controllerHome: string,
  repoId: string,
  workId: string,
): WorkHandleState | undefined {
  const handle = readWorkHandle(controllerHome, repoId, workId);
  if (!handle) return undefined;
  try {
    return reconcileWorkValidation(controllerHome, handle).handle;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('CONTROL_PLANE_REVISION_CONFLICT')) throw error;
    return readWorkHandle(controllerHome, repoId, workId);
  }
}

async function waitForReadableWorkHandle(
  controllerHome: string,
  repoId: string,
  workId: string,
  waitMs: number,
): Promise<{ handle?: WorkHandleState; timedOut: boolean; waitedMs: number }> {
  const startedAt = Date.now();
  let handle = reconcileReadableWorkHandle(controllerHome, repoId, workId);
  while (handle && !TERMINAL_WORK_HANDLE_STATES.has(handle.state) && Date.now() - startedAt < waitMs) {
    const remaining = waitMs - (Date.now() - startedAt);
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(100, remaining))));
    handle = reconcileReadableWorkHandle(controllerHome, repoId, workId);
  }
  const waitedMs = Date.now() - startedAt;
  return {
    handle,
    timedOut: Boolean(handle && !TERMINAL_WORK_HANDLE_STATES.has(handle.state)),
    waitedMs,
  };
}

function summarizeWorkHandle(
  handle: WorkHandleState,
  contract?: NonNullable<ReturnType<typeof getWorkContract>>,
): Record<string, unknown> {
  const terminal = TERMINAL_WORK_HANDLE_STATES.has(handle.state);
  const summary = contract?.objective?.trim()
    ? contract.objective.slice(0, 240)
    : `Work ${handle.workId} is ${handle.state}.`;
  return {
    kind: 'work_handle',
    workId: handle.workId,
    repoId: handle.repositoryId,
    checkoutId: handle.checkoutId,
    state: handle.state,
    phase: workHandlePhase(handle),
    statusLabel: handle.state,
    summary,
    terminal,
    resumable: !terminal,
    branch: handle.branch,
    expectedHead: handle.expectedHead,
    validation: handle.finalization.validation,
    updatedAt: handle.updatedAt,
    nextAction: terminal
      ? undefined
      : handle.state === 'validating'
        ? 'Wait for persisted validation receipts.'
        : 'Continue the existing WorkHandle.',
  };
}

function summarizeWorkListItem(job: ExecutionJob): Record<string, unknown> {
  const digest = buildJobOperationDigest(job);
  return {
    workId: job.jobId,
    requestId: job.requestId,
    kind: 'execution_job',
    operation: typeof job.payload?.operation === 'string' ? job.payload.operation : job.type,
    status: job.status,
    phase: digest.phase,
    statusLabel: digest.statusLabel,
    summary: digest.summary,
    terminal: digest.terminal,
    resumable: !digest.terminal || digest.phase === 'needs_attention',
    errorClass: digest.errorClass,
    changedFileCount: digest.changedFiles?.length ?? 0,
    evidenceCount: job.evidenceIds.length,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    suggestedNextAction: digest.suggestedNextActions[0],
    detailPointer: { tool: 'work_get', work_id: job.jobId },
  };
}

function summarizeSubmittedWorkContract(contract: NonNullable<ReturnType<typeof getWorkContract>>): Record<string, unknown> {
  const operation = contract.submittedOperation;
  const continuation = buildWorkContinuationSnapshot(contract);
  return {
    kind: 'work_contract',
    workId: contract.workId,
    repoId: contract.repoId,
    status: contract.status,
    operation: operation?.name,
    requestId: contract.requestId,
    deduplicated: undefined,
    nextAction: continuation.nextSafeAction,
    mode: contract.mode,
    objective: contract.objective,
    updatedAt: contract.updatedAt,
    resourceClaims: operation?.resourceClaims ?? [],
    operationMetadata: operation
      ? {
          mode: operation.mode,
          idempotent: operation.idempotent,
          replayable: operation.replayable,
          resourceClaims: operation.resourceClaims,
        }
      : undefined,
    summary: contract.objective.slice(0, 240),
    phase: contract.status === 'running'
      ? 'running'
      : contract.status === 'failed' || contract.status === 'cancelled'
        ? 'attention'
        : contract.status === 'completed'
          ? 'completed'
          : 'queued',
    statusLabel: contract.status,
    semantics: continuation.semantics,
    reconciliationRequired: continuation.reconciliationRequired,
  };
}

function summarizeWorkContractListItem(contract: NonNullable<ReturnType<typeof getWorkContract>>): Record<string, unknown> {
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(contract.status);
  return {
    workId: contract.workId,
    kind: 'work_contract',
    mode: contract.mode,
    objective: contract.objective,
    status: contract.status,
    phase: terminal ? 'completed' : contract.status === 'running' ? 'running' : 'attention',
    statusLabel: terminal ? '已完成' : contract.status === 'running' ? '运行中' : '待审查',
    summary: `WorkContract ${contract.status}: ${contract.objective.slice(0, 240)}`,
    terminal,
    resumable: !terminal,
    changedFileCount: 0,
    evidenceCount: contract.evidenceRefs.length,
    checkCount: contract.checkRefs.length,
    createdAt: contract.createdAt,
    updatedAt: contract.updatedAt,
    suggestedNextAction: contract.suggestedNextActions[0],
    semantics: buildWorkContinuationSnapshot(contract).semantics,
    reconciliationRequired: buildWorkContinuationSnapshot(contract).reconciliationRequired,
    detailPointer: { tool: 'work_get', work_id: contract.workId },
  };
}

function resolveWorkJob(
  ctx: MultiRepositoryMcpToolContext,
  repoId: string,
  args: Record<string, unknown>,
): ExecutionJob | undefined {
  const workId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
  const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
  if (!workId && !requestId) throw new Error('WORK_ID_REQUIRED: provide work_id or request_id');
  if (workId) {
    try { return getExecutionJob(ctx.controllerHome, repoId, workId); }
    catch { return undefined; }
  }
  return getExecutionJobByRequestId(ctx.controllerHome, requestId, repoId);
}

function managedProcessOperationDigest(
  handle: NonNullable<ReturnType<typeof getProcessHandle>>,
): Record<string, unknown> {
  const terminal = handle.completed === true;
  const phase = terminal
    ? handle.ok === true
      ? 'succeeded'
      : handle.timedOut === true
        ? 'timed_out'
        : handle.cancelled === true
          ? 'cancelled'
          : 'failed'
    : 'running';
  return {
    schemaVersion: 1,
    operationId: handle.processId,
    operationType: 'managed-process',
    workRef: handle.processId,
    status: handle.status,
    phase,
    terminal,
    resumable: !terminal,
    completed: handle.completed === true,
    ok: handle.ok,
    exitCode: handle.exitCode,
    timedOut: handle.timedOut,
    cancelled: handle.cancelled,
    startedAt: handle.startedAt,
    summary: terminal
      ? `Managed process ${handle.processId} completed with status ${handle.status}.`
      : `Managed process ${handle.processId} is still ${handle.status}.`,
    suggestedNextActions: terminal ? [] : [{
      label: 'Poll managed process',
      tool: 'work_status_digest',
      operation: 'get',
      payload: { work_ref: handle.processId },
      risk: 'readonly',
      confidence: 'high',
    }],
  };
}

function invalidFacadeOperation(tool: FacadeTool, operation: string): CallToolResult {
  const allowed = allowedFacadeOperations(tool);
  const facade = buildFacadeResult({
    status: 'failed',
    summary: `Invalid ${tool} operation: ${operation || '<empty>'}.`,
    data: {
      tool,
      operation: operation || null,
      allowedOperations: [...allowed],
    },
    warnings: [`invalid_operation: ${tool} does not support "${operation}"`],
    suggestedNextActions: allowed.slice(0, 4).map((op) => ({
      label: `Try ${tool}.${op}`,
      tool,
      operation: op,
      risk: 'readonly' as const,
      confidence: 'high' as const,
    })),
    rawAvailable: false,
  });
  return result(facade as unknown as Record<string, unknown>, true);
}

async function runFacadeRepair(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
  let maintenanceSnapshot: ReturnType<typeof buildRuntimeMaintenanceStatus> | undefined;
  let maintenanceStatus: {
    readyForExecution?: boolean;
    recommendedActions?: string[];
    candidates?: Array<{ kind?: string; reason?: string; suggestedAction?: string; safe?: boolean }>;
    warnings?: string[];
  } | undefined;
  try {
    const status = buildRuntimeMaintenanceStatus(repository, ctx.controllerHome, {
      minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
      maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : 20,
    });
    maintenanceSnapshot = status;
    maintenanceStatus = {
      readyForExecution: status.readyForExecution,
      recommendedActions: status.recommendedActions,
      candidates: status.candidates.map((candidate) => ({
        kind: candidate.kind,
        reason: candidate.reason,
        suggestedAction: candidate.suggestedAction,
        safe: candidate.safe,
      })),
      warnings: status.warnings,
    };
  } catch {
    maintenanceStatus = {
      readyForExecution: false,
      recommendedActions: [],
      candidates: [],
      warnings: ['runtime_maintenance_status inspection failed; treating as infrastructure issue, not acceptance failure'],
    };
  }

  const repairOperation = args.repair_operation === 'repair' || args.repair_operation === 'verify' || args.repair_operation === 'handoff'
    ? args.repair_operation
    : 'diagnose';
  const dryRun = args.dry_run === undefined ? true : args.dry_run === true;
  const elevatedRepair = args.destructive === true || args.remote_write === true || args.remote_effect === true;

  // The self-healing facade is a policy/planning surface; the authoritative
  // maintenance executor owns mutations. Execute it here only for an explicit,
  // non-dry-run repair whose entire observed candidate set is already classified
  // safe. Unsafe/destructive/remote repair continues through the approval path.
  if (
    repairOperation === 'repair'
    && !dryRun
    && !elevatedRepair
    && maintenanceSnapshot
    && maintenanceSnapshot.candidates.length > 0
  ) {
    const applied = applyRuntimeMaintenance(repository, ctx.controllerHome, {
      actionId: 'full_maintenance_pass',
      confirmMaintenance: true,
      minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
      maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : 20,
    });
    const actions = applied.applied.slice(0, 20).map((entry) => ({
      kind: entry.kind,
      id: entry.id,
      applied: entry.applied,
      result: entry.result,
      ...(entry.error ? { error: entry.error.slice(0, 300) } : {}),
    }));
    const appliedCount = applied.applied.filter((entry) => entry.applied).length;
    // Protected stale runtime temp entries are intentionally non-blocking maintenance
    // diagnostics. Keep repair completion semantics aligned with rh_status readiness so
    // their presence does not falsely report a blocked repair after safe debt is cleared.
    const remainingCandidateCount = applied.candidates.filter((candidate) => candidate.kind !== 'stale_runtime_temp_entry').length;
    const blocked = remainingCandidateCount > 0;
    const facade = buildFacadeResult({
      status: blocked ? 'blocked' : 'ok',
      summary: blocked
        ? `Runtime maintenance applied ${appliedCount} candidate(s); ${remainingCandidateCount} candidate(s) remain after the authoritative executor pass.`
        : `Runtime maintenance applied ${appliedCount} candidate(s); no maintenance candidates remain.`,
      data: {
        operation: 'repair',
        dryRun: false,
        applied: appliedCount > 0,
        actionId: 'full_maintenance_pass',
        appliedCount,
        remainingCandidateCount,
        actions,
        classification: 'infrastructure_recovery',
        isAcceptanceFailure: false,
      },
      warnings: applied.warnings.slice(0, 5),
      suggestedNextActions: [{
        label: 'Verify controller status after repair',
        tool: 'rh_status',
        operation: 'get',
        risk: 'readonly',
        confidence: 'high',
      }],
      rawAvailable: false,
    });
    return result(facade as unknown as Record<string, unknown>, blocked);
  }

  let watchdogSummary: string | undefined;
  let performanceSummary: string | undefined;
  try {
    const watchdog = buildWorkflowWatchdogReport(ctx.controllerHome, repository, { includeProcesses: false });
    watchdogSummary = `status=${watchdog.status}; findings=${watchdog.findings.length}; stale=${watchdog.staleWork.length}`.slice(0, 240);
  } catch {
    watchdogSummary = undefined;
  }
  try {
    const perf = collectRuntimePerformanceDiagnostics({
      repoId: repository.repoId,
      repoRoot: repository.canonicalRoot,
      includeProcesses: false,
      includeTempDirs: false,
    });
    performanceSummary = perf.summary.slice(0, 240);
  } catch {
    performanceSummary = undefined;
  }

  const daemon = readForgeRuntimeStatus(ctx.controllerHome);
  const readiness = await controllerReadinessEvidence(ctx, repository);
  const facade = runSelfHealingLoop(
    { repoId: repository.repoId, handoffStore: store },
    {
      operation: repairOperation,
      dryRun,
      approvalConfirmed: args.approval_confirmed === true,
      workId: typeof args.work_id === 'string' ? args.work_id : undefined,
      chatgptPullFailed: args.chatgpt_pull_failed === true,
      destructive: args.destructive === true,
      remoteEffect: args.remote_write === true || args.remote_effect === true,
      maintenanceStatus,
      diagnostics: {
        watchdogSummary,
        performanceSummary,
        controllerDaemonUnhealthy: daemon.status !== 'ready',
        schedulerUnhealthy: readiness.durableScheduler.status !== 'ready',
        codexUnavailable: args.codex_available === false,
        grokUnavailable: args.grok_available === false || args.target === 'grok',
        pluginUnavailable: args.plugin_unavailable === true,
      },
    },
  );
  return result(facade as unknown as Record<string, unknown>, facade.status === 'blocked' || facade.status === 'approval_required' || facade.status === 'failed');
}

function reconcileTerminalFacadeWorkVerifications(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  workId: string,
): { sourceRevision?: string; reconciledProcessIds: string[] } {
  const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
  const workContract = getWorkContract(store, workId);
  if (!workContract || workContract.completionReceipt) return { reconciledProcessIds: [] };

  let verificationRepository: ReturnType<typeof selectRepositoryCheckout>;
  try {
    verificationRepository = workContract.checkoutId
      ? selectRepositoryCheckout(repository, workContract.checkoutId, { allowArchived: true })
      : repository;
  } catch {
    return { reconciledProcessIds: [] };
  }
  const verificationStatus = repositoryGitStatus(verificationRepository);
  const sourceRevision = verificationStatus.head ?? undefined;
  if (!sourceRevision) return { reconciledProcessIds: [] };
  const workspaceFingerprint = workspaceValidationFingerprint(verificationRepository.canonicalRoot, verificationStatus);
  const availableChecks = listControllerChecks(repository.canonicalRoot);
  const workloopCtx = {
    workStore: store,
    handoffStore: store,
    repoId: repository.repoId,
    availableChecks,
  };
  const seenChecks = new Set<string>();
  const reconciledProcessIds: string[] = [];
  const candidates = listProcessRecords(ctx.controllerHome, repository.repoId, 500)
    .filter((record) => (
      record.workId === workId
      && record.checkoutId === verificationRepository.activeCheckoutId
      && !isManagedProcessActive(record)
      && record.origin?.workVerificationSnapshot === true
      && typeof record.origin?.checkId === 'string'
      && typeof record.origin?.requestSemanticFingerprint === 'string'
    ));

  for (const record of candidates) {
    const checkId = record.origin?.checkId?.trim() ?? '';
    if (!checkId || seenChecks.has(checkId)) continue;
    seenChecks.add(checkId);
    const classified = classifyVerificationOutcome({ checkId, available: availableChecks });
    if (classified.outcome === 'invalid_check_id' || !classified.normalizedCheckId) continue;
    const normalizedCheckId = classified.normalizedCheckId;
    const requestedChecks = workContract.checks.length ? workContract.checks : [normalizedCheckId];
    const currentFingerprint = verificationInputFingerprint({
      sourceRevision,
      workspaceFingerprint,
      checkId: normalizedCheckId,
      requestedChecks,
    });
    if (record.origin?.requestSemanticFingerprint !== currentFingerprint || !record.checkExecution) continue;

    try {
      const receipt = processCheckCompletionReceipt(record, {
        repoId: verificationRepository.repoId,
        checkoutId: verificationRepository.activeCheckoutId,
        workId,
        checkId: normalizedCheckId,
        processId: record.processId,
        requestId: record.origin?.requestId,
        checkExecution: {
          cacheKey: record.checkExecution.cacheKey,
          revision: record.checkExecution.revision,
          definitionDigest: record.checkExecution.definitionDigest,
          environmentFingerprint: record.checkExecution.environmentFingerprint,
          timeoutMs: record.checkExecution.timeoutMs,
          scopeKey: record.checkExecution.scopeKey,
        },
      });
      const latestContract = getWorkContract(store, workId);
      if (latestContract?.checkRefs.some((entry) => entry.receipt?.receiptId === receipt.receiptId)) continue;

      const structuredCheckResult = readPersistedCheckResultReceipt(record.origin?.checkResultReceiptPath);
      const structuredResultMatchesProcess = Boolean(
        structuredCheckResult
        && structuredCheckResult.checkId === normalizedCheckId
        && structuredCheckResult.cacheKey === record.checkExecution.cacheKey,
      );
      const legacyEvidence = record.origin?.checkResultReceiptPath
        ? undefined
        : readLatestControllerCheckEvidence(verificationRepository.canonicalRoot, normalizedCheckId);
      const legacyEvidenceMatchesProcess = Boolean(
        legacyEvidence?.cacheKey
        && legacyEvidence.cacheKey === record.checkExecution.cacheKey,
      );
      const evidenceState = classifyTerminalCheckEvidence({
        processError: record.error,
        structuredPresent: Boolean(structuredCheckResult),
        structuredMatches: structuredResultMatchesProcess,
        legacyPresent: Boolean(legacyEvidence),
        legacyMatches: legacyEvidenceMatchesProcess,
      });
      const failureClass = structuredResultMatchesProcess
        ? structuredCheckResult?.failureClass
        : legacyEvidenceMatchesProcess ? legacyEvidence?.failureClass : undefined;
      const infrastructureFailed = receipt.timedOut
        || receipt.cancelled
        || evidenceState.state !== 'matched'
        || (!receipt.ok && failureClass !== 'acceptance_failure');
      const checkFailed = !receipt.ok && !infrastructureFailed;
      verifyGoalWorkloop(workloopCtx, {
        workId,
        checkId: normalizedCheckId,
        sourceRevision,
        workspaceFingerprint,
        verificationInputFingerprint: currentFingerprint,
        commandFingerprint: commandFingerprint(normalizedCheckId, receipt.commandId),
        receipt,
        infrastructureFailed,
        checkFailed,
      });
      reconciledProcessIds.push(record.processId);
    } catch {
      // Exact receipt/process identity is mandatory. Any malformed, stale, or
      // mismatched terminal Process remains non-authoritative and is ignored.
    }
  }

  return { sourceRevision, reconciledProcessIds };
}

async function runFacadeVerify(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
  const checks = listControllerChecks(repository.canonicalRoot);
  const workloopCtx = {
    workStore: store,
    handoffStore: store,
    repoId: repository.repoId,
    availableChecks: checks,
  };
  const workId = typeof args.work_id === 'string' ? args.work_id : '';
  const checkId = String(args.check_id ?? args.checkId ?? '').trim();
  if (!checkId) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: 'rh_work verify requires a registered check_id.',
      data: {
        verification: {
          outcome: 'check_id_required',
          isAcceptanceFailure: false,
          isInfrastructureIssue: true,
          doesNotRequestTaskChanges: true,
        },
        registeredCheckCount: checks.length,
      },
      warnings: ['CHECK_ID_REQUIRED: pass check_id for one registered repository check.'],
      suggestedNextActions: normalizeCheckIds(checks.slice(0, 3).map((check) => check.id), checks).suggestedNextActions,
    }) as unknown as Record<string, unknown>, true);
  }
  const classified = classifyVerificationOutcome({
    checkId,
    available: checks,
  });

  if (classified.outcome === 'invalid_check_id') {
    if (workId) {
      const facade = verifyGoalWorkloop(workloopCtx, { workId, checkId });
      return result(facade as unknown as Record<string, unknown>);
    }
    return result(buildFacadeResult({
      status: 'ok',
      summary: classified.summary,
      data: {
        verification: {
          checkId,
          outcome: 'invalid_check_id',
          isAcceptanceFailure: false,
          isInfrastructureIssue: true,
          doesNotRequestTaskChanges: true,
        },
        registeredCheckCount: checks.length,
      },
      warnings: classified.warnings,
      suggestedNextActions: normalizeCheckIds(checks.slice(0, 3).map((check) => check.id), checks).suggestedNextActions,
    }) as unknown as Record<string, unknown>);
  }

  // Simulation path for unit tests / explicit dry verification without process execution.
  if (args.simulate_check === true || args.infrastructure_failed === true || args.check_failed === true || args.skipped === true) {
    if (!workId) {
      return result(buildFacadeResult({
        status: args.check_failed === true ? 'failed' : 'ok',
        summary: 'Simulated verification without WorkContract.',
        data: {
          verification: {
            checkId: classified.normalizedCheckId,
            outcome: args.skipped ? 'skipped' : args.infrastructure_failed ? 'infrastructure_failure' : args.check_failed ? 'valid_fail' : 'valid_pass',
            isAcceptanceFailure: args.check_failed === true,
            simulated: true,
          },
        },
      }) as unknown as Record<string, unknown>, args.check_failed === true);
    }
    const facade = verifyGoalWorkloop(workloopCtx, {
      workId,
      checkId: classified.normalizedCheckId ?? checkId,
      infrastructureFailed: args.infrastructure_failed === true,
      checkFailed: args.check_failed === true,
      skipped: args.skipped === true,
    });
    return result(facade as unknown as Record<string, unknown>, facade.status === 'failed');
  }

  // Real checks share the same persisted Process Runtime path as run_check and
  // work_validate. Never synchronously block the MCP facade on long native tests.
  try {
    const normalizedCheckId = classified.normalizedCheckId!;
    const requestId = typeof args.request_id === 'string' && args.request_id.trim()
      ? args.request_id.trim()
      : undefined;
    const workContract = workId ? getWorkContract(store, workId) : undefined;
    if (workId && !workContract) throw new Error(`WORK_NOT_FOUND: ${workId}`);
    const verificationRepository = workContract?.checkoutId
      ? selectRepositoryCheckout(repository, workContract.checkoutId, { allowArchived: true })
      : repository;
    const verificationStatus = repositoryGitStatus(verificationRepository);
    const observedGitHead = verificationStatus.head;
    const workspaceFingerprint = workspaceValidationFingerprint(verificationRepository.canonicalRoot, verificationStatus);
    const requestedChecks = workContract?.checks.length ? workContract.checks : [normalizedCheckId];
    const verificationRequestFingerprint = observedGitHead ? verificationInputFingerprint({
      sourceRevision: observedGitHead,
      workspaceFingerprint,
      checkId: normalizedCheckId,
      requestedChecks,
    }) : undefined;
    const executed = await runPersistedCheckViaProcessRuntime({
      controllerHome: ctx.controllerHome,
      repoId: verificationRepository.repoId,
      checkoutId: verificationRepository.activeCheckoutId,
      repoRoot: verificationRepository.canonicalRoot,
      executionIdentity: executionIdentityForRepository(verificationRepository, workId ? { workId } : {}),
      checkId: normalizedCheckId,
      timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
      // rh_work.verify is a control-plane continuation primitive: callers should
      // be able to keep working and later reattach to the exact same Process.
      // Absorb brief shared build-cache/resource contention during admission so
      // a lifecycle verification does not turn a few seconds of contention into
      // a terminal failed Check that the controller must manually retry.
      interactiveWaitMs: 0,
      leaseWaitMs: RH_WORK_VERIFY_LEASE_WAIT_MS,
      requestId,
      requestSemanticFingerprint: verificationRequestFingerprint,
      workId: workId || undefined,
      commandId: requestId,
      verificationSnapshot: workContract ? {
        workId: workContract.workId,
        allowedPaths: workContract.allowedPaths,
        forbiddenPaths: workContract.forbiddenPaths,
      } : undefined,
    });

    if (executed.mode === 'durable') {
      return result(buildFacadeResult({
        status: 'blocked',
        summary: `Check ${normalizedCheckId} requires an explicit durable workflow; no acceptance result was recorded.`,
        data: {
          verification: {
            checkId: normalizedCheckId,
            outcome: 'deferred',
            isAcceptanceFailure: false,
            isInfrastructureIssue: false,
            durable: executed.durable,
            observedGitHead,
          },
        },
        suggestedNextActions: [{
          label: 'Continue Work with the durable check requirement',
          tool: 'rh_work',
          operation: 'continue',
          payload: { work_id: workId || undefined },
          risk: 'workspace_write',
          confidence: 'high',
        }],
      }) as unknown as Record<string, unknown>, true);
    }

    const handle = executed.process;
    if (!handle) throw new Error(`PROCESS_CHECK_HANDLE_MISSING: ${normalizedCheckId}`);
    const record = getProcessRecord(ctx.controllerHome, verificationRepository.repoId, handle.processId);
    const checkContentRevision = record?.checkExecution?.revision;

    if (!handle.completed) {
      return result(buildFacadeResult({
        status: 'ok',
        summary: `Check ${normalizedCheckId} is running through Process Runtime; continue other work and reattach to ${handle.processId}.`,
        data: {
          verification: {
            checkId: normalizedCheckId,
            outcome: 'running',
            isAcceptanceFailure: false,
            isInfrastructureIssue: false,
            executed: true,
            completed: false,
            processId: handle.processId,
            processStatus: handle.status,
            deduplicated: handle.deduplicated === true,
            semanticDeduplicated: handle.semanticDeduplicated === true,
            checkContentRevision,
            observedGitHead,
            verificationIsolation: workContract ? 'work_snapshot' : 'shared_checkout',
            revisionSemantics: 'checkContentRevision is a content-bound Check identity; observedGitHead is Git HEAD and is not interchangeable.',
          },
        },
        rawAvailable: false,
      }) as unknown as Record<string, unknown>);
    }

    if (!record) throw new Error(`PROCESS_CHECK_RECORD_MISSING: ${handle.processId}`);
    const receipt = processCheckCompletionReceipt(record, {
      repoId: verificationRepository.repoId,
      checkId: normalizedCheckId,
      processId: handle.processId,
      ...(record.checkExecution ? {
        checkoutId: verificationRepository.activeCheckoutId,
        workId: workId || undefined,
        requestId,
        checkExecution: {
          cacheKey: record.checkExecution.cacheKey,
          revision: record.checkExecution.revision,
          definitionDigest: record.checkExecution.definitionDigest,
          environmentFingerprint: record.checkExecution.environmentFingerprint,
          timeoutMs: record.checkExecution.timeoutMs,
          scopeKey: record.checkExecution.scopeKey,
        },
      } : {}),
    });
    const structuredCheckResult = readPersistedCheckResultReceipt(record.origin?.checkResultReceiptPath);
    const structuredResultMatchesProcess = Boolean(
      structuredCheckResult
      && record.checkExecution?.cacheKey
      && structuredCheckResult.checkId === normalizedCheckId
      && structuredCheckResult.cacheKey === record.checkExecution.cacheKey,
    );
    const legacyEvidence = record.origin?.checkResultReceiptPath
      ? undefined
      : readLatestControllerCheckEvidence(verificationRepository.canonicalRoot, normalizedCheckId);
    const legacyEvidenceMatchesProcess = Boolean(
      legacyEvidence?.cacheKey
      && record.checkExecution?.cacheKey
      && legacyEvidence.cacheKey === record.checkExecution.cacheKey,
    );
    const evidenceState = classifyTerminalCheckEvidence({
      processError: record.error,
      structuredPresent: Boolean(structuredCheckResult),
      structuredMatches: structuredResultMatchesProcess,
      legacyPresent: Boolean(legacyEvidence),
      legacyMatches: legacyEvidenceMatchesProcess,
    });
    const resultMatchesProcess = evidenceState.state === 'matched';
    const failureClass = structuredResultMatchesProcess
      ? structuredCheckResult?.failureClass
      : legacyEvidenceMatchesProcess ? legacyEvidence?.failureClass : undefined;
    const infrastructureFailed = receipt.timedOut
      || receipt.cancelled
      || !resultMatchesProcess
      || (!receipt.ok && failureClass !== 'acceptance_failure');
    const checkFailed = !receipt.ok && !infrastructureFailed;
    const boundedStatus = receipt.ok ? 'pass' : infrastructureFailed ? 'infrastructure_failure' : 'fail';
    const commonVerification = {
      checkId: normalizedCheckId,
      outcome: infrastructureFailed ? 'infrastructure_failure' : receipt.ok ? 'valid_pass' : 'valid_fail',
      isAcceptanceFailure: checkFailed,
      isInfrastructureIssue: infrastructureFailed,
      executed: true,
      completed: true,
      processId: receipt.processId,
      processStatus: receipt.runtimeStatus,
      ok: receipt.ok,
      timedOut: receipt.timedOut,
      cancelled: receipt.cancelled,
      failureClass: infrastructureFailed ? 'infrastructure_failure' : failureClass,
      deduplicated: handle.deduplicated === true,
      semanticDeduplicated: handle.semanticDeduplicated === true,
      checkContentRevision: receipt.checkRevision,
      observedGitHead,
      revisionSemantics: 'checkContentRevision is a content-bound Check identity; observedGitHead is Git HEAD and is not interchangeable.',
      evidenceArtifactPath: record.origin?.workVerificationSnapshot ? undefined : receipt.artifactPath,
      evidenceReceiptId: receipt.receiptId,
      checkResultReceiptId: structuredCheckResult?.receiptId,
      verificationIsolation: record.origin?.workVerificationSnapshot ? 'work_snapshot' : 'shared_checkout',
      boundedStatus,
      evidenceState: evidenceState.state,
      ...(evidenceState.infrastructureReason ? { infrastructureReason: evidenceState.infrastructureReason } : {}),
      ...(record.error?.code ? { processErrorCode: record.error.code } : {}),
    };

    if (workId) {
      const sourceRevision = observedGitHead ?? undefined;
      const facade = verifyGoalWorkloop(workloopCtx, {
        workId,
        checkId: normalizedCheckId,
        sourceRevision,
        workspaceFingerprint,
        verificationInputFingerprint: sourceRevision ? verificationRequestFingerprint : undefined,
        commandFingerprint: commandFingerprint(normalizedCheckId, receipt.commandId),
        receipt,
        infrastructureFailed,
        checkFailed,
      });
      const data = facade.data as Record<string, unknown>;
      return result({
        ...facade,
        data: {
          ...data,
          verification: {
            ...(typeof data.verification === 'object' && data.verification ? data.verification as Record<string, unknown> : {}),
            ...commonVerification,
          },
        },
        warnings: infrastructureFailed
          ? [...facade.warnings, evidenceState.warning ?? 'infrastructure_failure is distinct from acceptance failure']
          : facade.warnings,
      } as unknown as Record<string, unknown>, facade.status === 'failed');
    }

    return result(buildFacadeResult({
      status: checkFailed ? 'failed' : 'ok',
      summary: infrastructureFailed
        ? `Infrastructure failure while running ${normalizedCheckId}; not an acceptance failure.`
        : receipt.ok
          ? `Check ${normalizedCheckId} passed with persisted Process evidence.`
          : `Check ${normalizedCheckId} failed acceptance.`,
      data: { verification: commonVerification },
      warnings: infrastructureFailed
        ? [evidenceState.warning ?? 'infrastructure_failure is distinct from acceptance failure']
        : [],
      rawAvailable: false,
    }) as unknown as Record<string, unknown>, checkFailed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (workId) {
      const facade = verifyGoalWorkloop(workloopCtx, {
        workId,
        checkId: classified.normalizedCheckId ?? checkId,
        infrastructureFailed: true,
      });
      return result({
        ...facade,
        warnings: [...facade.warnings, `check_runner_error: ${message.slice(0, 200)}`],
        data: {
          ...(facade.data as Record<string, unknown>),
          isAcceptanceFailure: false,
        },
      } as unknown as Record<string, unknown>);
    }
    return result(buildFacadeResult({
      status: 'ok',
      summary: `Infrastructure failure invoking Process Runtime for ${classified.normalizedCheckId}; not acceptance failure.`,
      data: {
        verification: {
          checkId: classified.normalizedCheckId,
          outcome: 'infrastructure_failure',
          isAcceptanceFailure: false,
          isInfrastructureIssue: true,
        },
      },
      warnings: [`check_runner_error: ${message.slice(0, 200)}`],
      suggestedNextActions: [{
        label: 'Diagnose runtime (dry-run)',
        tool: 'rh_work',
        operation: 'repair',
        payload: { repair_operation: 'diagnose', dry_run: true },
        risk: 'readonly',
      }],
    }) as unknown as Record<string, unknown>);
  }
}

/**
 * Runtime Source drift for MCP readiness.
 *
 * `currentRuntimeRoot` is only for tests that pin a Controller Runtime Source
 * fixture. Callers must never pass an execution repository canonicalRoot here.
 */
export function runtimeSourceSnapshotStatus(
  active: RuntimeSourceIdentity | undefined,
  currentRuntimeRoot?: string,
) {
  const drift = evaluateActiveRuntimeSourceDrift(active, {
    currentRuntimeRoot,
  });
  return {
    current: drift.current,
    restartRequired: drift.restartRequired,
    reasons: drift.reasons,
    code: drift.code,
  };
}

export function repositoryExecutionReadiness(
  repoRoot: string,
  availableChecks: ReturnType<typeof listControllerChecks>,
  requestedCheckIds: string[] = [],
  schedulingScope: { repoId?: string; checkoutId?: string } = {},
): Record<string, unknown> {
  const git = gitSnapshot(repoRoot);
  const registeredCheckIds = availableChecks.map((check) => check.id);
  const normalizedChecks = normalizeCheckIds(requestedCheckIds, availableChecks);
  const hasPackageJson = existsSync(join(repoRoot, 'package.json'));
  const nodeModulesReady = !hasPackageJson || existsSync(join(repoRoot, 'node_modules'));
  const lockCandidates = [
    ['bun', 'bun.lock'],
    ['bun', 'bun.lockb'],
    ['pnpm', 'pnpm-lock.yaml'],
    ['npm', 'package-lock.json'],
    ['yarn', 'yarn.lock'],
  ] as const;
  const detectedLock = lockCandidates.find(([, path]) => existsSync(join(repoRoot, path)));
  const packageManager = detectedLock?.[0];
  const bootstrapCommand = hasPackageJson && !nodeModulesReady
    ? packageManager === 'bun' ? ['bun', 'install', '--frozen-lockfile']
      : packageManager === 'pnpm' ? ['pnpm', 'install', '--frozen-lockfile']
        : packageManager === 'npm' ? ['npm', 'ci']
          : packageManager === 'yarn' ? ['yarn', 'install', '--frozen-lockfile']
            : undefined
    : undefined;
  const hasPythonManifest = existsSync(join(repoRoot, 'pyproject.toml'))
    || existsSync(join(repoRoot, 'requirements.txt'))
    || existsSync(join(repoRoot, 'requirements-dev.txt'));
  const localPythonReady = !hasPythonManifest
    || existsSync(join(repoRoot, '.venv', 'bin', 'python'))
    || existsSync(join(repoRoot, '.venv', 'Scripts', 'python.exe'));
  const checkScheduling = buildCheckExecutionSchedule({
    checks: availableChecks,
    requestedCheckIds,
    repoId: schedulingScope.repoId?.trim() || 'selected-repository',
    checkoutId: schedulingScope.checkoutId?.trim() || 'active',
  });
  const blockers = [
    ...(!nodeModulesReady ? [{ code: 'NODE_DEPENDENCIES_MISSING', message: 'package.json is present but node_modules is not materialized in this checkout.' }] : []),
    ...normalizedChecks.invalidCheckIds.map((checkId) => ({ code: 'CHECK_NOT_REGISTERED', message: `Requested check is not registered: ${checkId}`, checkId })),
  ];
  return {
    readyForFocusedExecution: blockers.length === 0,
    git: { head: git.head, branch: git.branch, dirty: git.dirty },
    checks: {
      registeredCount: registeredCheckIds.length,
      registeredCheckIds: registeredCheckIds.slice(0, 80),
      requestedCheckIds: requestedCheckIds.slice(0, 40),
      normalized: normalizedChecks,
    },
    checkScheduling: {
      waveCount: checkScheduling.waves.length,
      maxParallel: checkScheduling.maxParallel,
      waveSummaries: checkScheduling.waves.map((wave) => `wave ${wave.wave}: ${wave.checkIds.join(', ')}`),
      conflictSummaries: checkScheduling.conflicts.map((conflict) => {
        const resources = [...new Set(conflict.resources.flatMap(({ left, right }) => [left.resourceKey, right.resourceKey]))];
        return `${conflict.leftCheckId} <> ${conflict.rightCheckId}: ${resources.join(', ')}`;
      }),
      invalidCheckIds: checkScheduling.invalidCheckIds,
      guidance: checkScheduling.guidance,
    },
    dependencies: {
      node: {
        applicable: hasPackageJson,
        ready: nodeModulesReady,
        packageManager: packageManager ?? null,
        lockfile: detectedLock?.[1] ?? null,
        ...(bootstrapCommand ? { bootstrapCommand } : {}),
      },
      python: {
        applicable: hasPythonManifest,
        localVirtualEnvReady: localPythonReady,
        advisoryOnly: true,
      },
    },
    blockers,
    guidance: bootstrapCommand
      ? [`Materialize checkout dependencies before tests/builds: ${bootstrapCommand.join(' ')}`]
      : [],
  };
}

export async function callRuntimeTool(ctx: MultiRepositoryMcpToolContext, name: string, args: Record<string, unknown>): Promise<CallToolResult | undefined> {
  try {
    switch (name) {
      case 'rh_status': {
        const repository = selected(ctx, args);
        const operation = String(args.operation ?? 'get');
        if (!allowedFacadeOperations('rh_status').includes(operation)) {
          return invalidFacadeOperation('rh_status', operation);
        }
        const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
        if (operation === 'repair') {
          return await runFacadeRepair(ctx, repository, args);
        }
        const readiness = await controllerReadinessEvidence(ctx, repository);
        const liveGit = gitSnapshot(repository.canonicalRoot);
        // Compare startup Runtime Source against the Controller package authority —
        // never against the selected execution repository.
        const runtimeSource = runtimeSourceSnapshotStatus(readiness.daemon.source, ctx.runtimeSourceRoot);
        const sourceSnapshotStale = runtimeSource.restartRequired;
        // Dynamic import avoids a static cycle: toolset.ts composes runtimeToolDefinitions.
        const toolset = await import('../../../cli/mcp/toolset');
        const exposure = toolset.controllerExposureSnapshot(ctx);
        const localRegisteredToolNames = toolset.allControllerToolDefinitions(ctx).map((tool) => tool.name).sort();
        const toolSurfaceReady = exposure.ready && exposure.missingToolNames.length === 0;
        // Ordinary interactive execution depends on the execution axis only.
        // Maintenance debt / durable queue debt are reported as separate
        // semantics and must not promote ordinary work into repair flows.
        const executionReady = readiness.semantics.executionReady;
        let maintenanceHealthy: boolean | null = null;
        let maintenanceCandidateCount = 0;
        if (args.detail_level === 'detail') {
          try {
            const maintenance = buildRuntimeMaintenanceStatus(repository, ctx.controllerHome, { maxCandidates: 20 });
            // stale_runtime_temp_entry is non-blocking by design (the executor
            // excludes it from readyForExecution), so it is not maintenance debt.
            const blockingCandidates = maintenance.candidates.filter((candidate) => candidate.kind !== 'stale_runtime_temp_entry');
            maintenanceHealthy = blockingCandidates.length === 0;
            maintenanceCandidateCount = blockingCandidates.length;
          } catch {
            maintenanceHealthy = null;
          }
        }
        const effectiveReady = executionReady && toolSurfaceReady && !sourceSnapshotStale;
        const readinessReasons = [...readiness.reasons];
        if (!toolSurfaceReady) {
          readinessReasons.push({
            code: 'MCP_TOOL_SURFACE_INCOMPLETE',
            message: `MCP schema mismatch: missing=${exposure.missingToolNames.length}, duplicates=${exposure.duplicateToolNames.length}.`,
          });
        }
        if (sourceSnapshotStale) {
          readinessReasons.push({
            code: runtimeSource.code === 'RUNTIME_SOURCE_SNAPSHOT_MISSING'
              ? 'RUNTIME_SOURCE_SNAPSHOT_MISSING'
              : runtimeSource.code === 'RUNTIME_SOURCE_CURRENT_UNAVAILABLE'
                ? 'RUNTIME_SOURCE_CURRENT_UNAVAILABLE'
                : 'RUNTIME_SOURCE_SNAPSHOT_STALE',
            message: formatRuntimeSourceDriftMessage(runtimeSource),
          });
        }
        const toolSurfaceComputed = exposure.expectedToolNames.length > 0 || exposure.actualToolNames.length > 0 || toolSurfaceReady;
        const readinessWithToolSurface = {
          ready: effectiveReady,
          reasonCodes: [...new Set(
            readinessReasons
              .map((reason) => reason.code)
              .filter((code): code is string => typeof code === 'string' && code.length > 0),
          )],
          diagnostics: {
            runtime: {
              ready: readiness.ready,
            },
            toolSurface: {
              ready: toolSurfaceReady,
              // An uncomputed exposure is explicitly unknown, never a false 0/0.
              expectedToolCount: toolSurfaceComputed ? exposure.expectedToolNames.length : null,
              actualToolCount: toolSurfaceComputed ? exposure.actualToolNames.length : null,
              observation: toolSurfaceComputed ? 'computed' : 'unknown',
              missingTools: exposure.missingToolNames,
              unexpectedTools: exposure.unexpectedToolNames,
              duplicateTools: exposure.duplicateToolNames,
              fingerprint: exposure.fingerprint,
              schemaStableAcrossAccessModes: exposure.schemaStableAcrossAccessModes,
            },
            semantics: {
              executionReady,
              maintenanceHealthy,
              maintenanceCandidateCount,
              releaseReady: readiness.semantics.releaseReady,
              executionBlockers: readiness.semantics.reasons.executionReady.map((reason) => reason.code),
              releaseBlockers: readiness.semantics.reasons.releaseReady.map((reason) => reason.code),
            },
            sourceCoherence: {
              ready: !sourceSnapshotStale,
              reasons: runtimeSource.reasons,
            },
          },
          observedAt: new Date().toISOString(),
        };
        const detailLevel = args.detail_level === 'detail' ? 'detail' : 'summary';
        // Always prefer stored plugin manifests on rh_status get. Live host probes
        // (Xcode/simctl, etc.) must not stall Managed MCP gateways on reconnect/status.
        const manifests = listAssistantPluginManifests(ctx.controllerHome, repository, {
          preferStored: true,
        });
        const capabilities = listCapabilityDescriptors(manifests);
        const pendingHandoffs = listHandoffItems({ ...store, status: 'pending', limit: 20 });
        const activeContracts = listWorkContracts({ ...store, status: 'active', limit: 200 });
        const activePrimaryWork = activeContracts.filter((contract) => (contract.lifecycleRole ?? 'primary') === 'primary');
        const activeExecutionChildren = activeContracts.filter((contract) => contract.lifecycleRole === 'execution_child');
        const activeRuntimeInstanceId = currentControllerInstanceId();
        const activeProcessRecords = listProcessRecords(ctx.controllerHome, repository.repoId, 500).filter((process) => isManagedProcessActive(process) && (!process.runtimeInstanceId || process.runtimeInstanceId === activeRuntimeInstanceId));
        const activeProcessWorkIds = new Set(activeProcessRecords.map((process) => process.workId).filter((workId): workId is string => Boolean(workId)));
        const activeControllerWorkIds = new Set(activePrimaryWork.filter((contract) => Boolean(getControllerSession({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, contract.workId))).map((contract) => contract.workId));
        const executingPrimaryWorkIds = new Set([...activeProcessWorkIds, ...activeControllerWorkIds].filter((workId) => activePrimaryWork.some((contract) => contract.workId === workId)));
        const preferredFacadeTools = ['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work'] as const;
        const facade = buildFacadeResult({
          status: effectiveReady ? 'ok' : 'blocked',
          summary: effectiveReady ? 'Controller and MCP tool surface are ready for bounded work.' : 'Controller or MCP tool surface needs attention before work.',
          data: {
            operation,
            repoId: repository.repoId,
            readiness: readinessWithToolSurface,
            repositoryState: {
              ...liveGit,
              observedAt: new Date().toISOString(),
              sourceSnapshotAgeMs: readiness.daemon.source?.observedAt
                ? Math.max(0, Date.now() - Date.parse(readiness.daemon.source.observedAt))
                : undefined,
              sourceSnapshotStale,
              sourceSnapshotReasons: runtimeSource.reasons,
              runtimeSourceDirty: runtimeSource.current?.dirty === true,
            },
            capabilityCount: capabilities.length,
            capabilityGroups: summarizeCapabilityGroups(manifests),
            toolArchitecture: {
              facadeTools: [...preferredFacadeTools],
              atomicTypedToolsRetained: true,
              internalHandlersRetained: true,
              domainSchemaLoading: 'static_stable_surface',
              dynamicDomainSchemaLoadingSupported: false,
            },
            pendingHandoffCount: pendingHandoffs.length,
            // User-facing Work count means objective-level primary lanes. Low-level
            // resumable operation handles are reported separately.
            activeWorkCount: activePrimaryWork.length,
            activePrimaryWorkCount: activePrimaryWork.length,
            activeExecutionChildCount: activeExecutionChildren.length,
            activeProcessCount: activeProcessRecords.length,
            executingPrimaryWorkCount: executingPrimaryWorkIds.size,
            waitingPrimaryWorkCount: Math.max(0, activePrimaryWork.length - executingPrimaryWorkIds.size),
            activeContractCount: activeContracts.length,
            // Summary keeps the stable facade surface only; detail expands to the full registered schema.
            toolSurface: detailLevel === 'detail'
              ? exposure.actualToolNames
              : preferredFacadeTools.filter((name) => exposure.actualToolNames.includes(name)),
            toolSurfaceStatus: readinessWithToolSurface.diagnostics.toolSurface,
            access: exposure.access,
          },
          suggestedNextActions: pendingHandoffs.length > 0 ? [{
            label: 'Review pending handoffs',
            tool: 'rh_inbox',
            operation: 'list',
            risk: 'readonly',
            confidence: 'high',
          }] : [{
            label: 'Read repository context',
            tool: 'rh_context',
            operation: 'get',
            risk: 'readonly',
            confidence: 'medium',
          }],
          rawAvailable: detailLevel === 'detail',
          detailLevel,
        });
        return result(facade as unknown as Record<string, unknown>, facade.status !== 'ok');
      }
      case 'rh_inbox': {
        const repository = selected(ctx, args);
        const operation = String(args.operation ?? 'list');
        if (!allowedFacadeOperations('rh_inbox').includes(operation)) {
          return invalidFacadeOperation('rh_inbox', operation);
        }
        const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
        if (operation === 'get') {
          const item = getHandoffItem(store, String(args.handoff_id ?? ''));
          const facade = buildFacadeResult({
            status: item ? 'ok' : 'not_found',
            summary: item ? `Handoff ${item.id}.` : 'Handoff item not found.',
            data: { item },
            suggestedNextActions: item && item.status === 'pending' ? [{ label: 'Acknowledge handoff', tool: 'rh_inbox', operation: 'ack', payload: { handoff_id: item.id }, risk: 'readonly' }] : [],
          });
          return result(facade as unknown as Record<string, unknown>, facade.status === 'not_found');
        }
        if (operation === 'ack' || operation === 'accept') {
          const item = acknowledgeHandoffItem(store, String(args.handoff_id ?? '').trim());
          return result(buildFacadeResult({
            summary: `${operation === 'accept' ? 'Accepted' : 'Acknowledged'} handoff ${item.id}.`,
            data: { item },
            suggestedNextActions: item.suggestedNextActions,
          }) as unknown as Record<string, unknown>);
        }
        if (operation === 'resolve') {
          const item = resolveHandoffItem(store, String(args.handoff_id ?? '').trim(), {
            decision: String(args.decision ?? 'resolved'),
            resolver: String(args.resolver ?? 'chatgpt'),
          });
          return result(buildFacadeResult({
            summary: `Resolved handoff ${item.id}.`,
            data: { item: { id: item.id, status: item.status, decision: item.decision, resolver: item.resolver } },
          }) as unknown as Record<string, unknown>);
        }
        if (operation === 'dismiss') {
          const item = dismissHandoffItem(store, String(args.handoff_id ?? '').trim(), {
            decision: String(args.decision ?? 'dismissed'),
            resolver: String(args.resolver ?? 'chatgpt'),
          });
          return result(buildFacadeResult({
            summary: `Dismissed handoff ${item.id}.`,
            data: { item: { id: item.id, status: item.status, decision: item.decision, resolver: item.resolver } },
          }) as unknown as Record<string, unknown>);
        }
        if (operation === 'create') {
          const id = String(args.handoff_id ?? `hnd-${Date.now()}`).trim();
          const item = createHandoffItem(store, {
            id,
            repoId: repository.repoId,
            workId: typeof args.work_id === 'string' ? args.work_id : undefined,
            title: String(args.title ?? 'Controller handoff'),
            severity: 'needs_review',
            creationReason: 'ambiguous_outcome',
            reason: String(args.reason ?? 'ChatGPT or user judgement is required before continuing.'),
            summary: String(args.summary ?? 'A bounded controller handoff was recorded.'),
            currentState: { repoId: repository.repoId, statusSummary: 'pending decision', workId: typeof args.work_id === 'string' ? args.work_id : undefined },
            attemptedActions: Array.isArray(args.attempted_actions) ? args.attempted_actions.map(String) : [],
            evidenceRefs: [],
            blockingDecision: typeof args.blocking_decision === 'string' ? args.blocking_decision : undefined,
            recommendedDecision: String(args.recommended_decision ?? 'Decide whether to continue, repair, or stop.'),
            recommendedPrompt: String(args.recommended_prompt ?? `Continue from handoff ${id}.`),
            recommendedContinuationPrompt: typeof args.recommended_continuation_prompt === 'string' ? args.recommended_continuation_prompt : undefined,
            suggestedNextActions: [],
          });
          let ownershipReleased = false;
          if (item.workId && ctx.principalId?.trim() && ctx.sessionId?.trim()) {
            const owner = getControllerSession(store, item.workId);
            if (owner && owner.controllerId === ctx.principalId.trim() && owner.sessionId === ctx.sessionId.trim()) {
              releaseControllerSession(store, item.workId, owner.controllerId);
              ownershipReleased = true;
            }
          }
          return result(buildFacadeResult({ summary: `Created handoff ${item.id}.`, data: { item: summarizeHandoffItem(item), ownershipReleased } }) as unknown as Record<string, unknown>);
        }
        // Default list: pending summary only.
        const items = listHandoffItems({ ...store, status: 'pending', limit: typeof args.limit === 'number' ? args.limit : 50 });
        return result(buildFacadeResult({
          summary: items.length ? `${items.length} pending handoff item(s).` : 'No pending handoff items.',
          data: { items: items.map(summarizeHandoffItem) },
          suggestedNextActions: items.slice(0, 1).map((item) => ({ label: `Read ${item.id}`, tool: 'rh_inbox', operation: 'get', payload: { handoff_id: item.id }, risk: 'readonly' as const })),
        }) as unknown as Record<string, unknown>);
      }
      case 'rh_context': {
        const repository = selected(ctx, args);
        const operation = String(args.operation ?? 'get');
        if (!allowedFacadeOperations('rh_context').includes(operation)) {
          return invalidFacadeOperation('rh_context', operation);
        }
        if (operation === 'search') {
          const query = typeof args.query === 'string' ? args.query.trim() : '';
          if (!query) {
            const facade = buildFacadeResult({
              status: 'failed',
              summary: 'rh_context.search requires a non-empty query.',
              data: { operation, repoId: repository.repoId },
              suggestedNextActions: [],
            });
            return result(facade as unknown as Record<string, unknown>, true);
          }
          const list = (value: unknown): string[] => Array.isArray(value)
            ? value.map(String).map((entry) => entry.trim()).filter(Boolean)
            : [];
          const retrievalMode = args.retrieval_mode === 'plan' || args.retrieval_mode === 'debug' || args.retrieval_mode === 'review'
            ? args.retrieval_mode
            : 'implementation';
          const impactDomains = list(args.impact_domains)
            .filter((domain): domain is ControllerContextImpactDomain => CONTROLLER_CONTEXT_IMPACT_DOMAINS.includes(domain as ControllerContextImpactDomain));
          const structuralContext = args.structural_context === 'off' || args.structural_context === 'auto' || args.structural_context === 'required'
            ? args.structural_context
            : retrievalMode === 'plan' || retrievalMode === 'debug'
              ? 'required'
              : 'auto';
          const checks = listControllerChecks(repository.canonicalRoot);
          const requestedCheckIds = list(args.requested_check_ids);
          const executionReadiness = repositoryExecutionReadiness(repository.canonicalRoot, checks, requestedCheckIds, {
            repoId: repository.repoId,
            checkoutId: repository.activeCheckoutId,
          });
          const pack = await buildControllerContextPackAsync(repository.canonicalRoot, ctx.policy, {
            description: query,
            searchTerms: [query],
            knownPaths: list(args.known_paths),
            includeGlobs: list(args.include_globs),
            excludeGlobs: list(args.exclude_globs),
            maxFiles: typeof args.max_files === 'number' ? args.max_files : undefined,
            maxSnippets: typeof args.max_snippets === 'number' ? args.max_snippets : undefined,
            structuralContext,
            structuralIndexRoot: structuralContext === 'off' ? undefined : structuralIndexRoot(repository),
            retrievalMode,
            impactDomains,
            session: ctx.sessionId?.trim()
              ? { sessionId: ctx.sessionId.trim(), repoId: repository.repoId, checkoutId: repository.activeCheckoutId }
              : undefined,
          });
          const warnings = structuralContext === 'required' && !pack.structuralContext.requiredSatisfied
            ? [pack.structuralContext.fallbackReason ?? 'Required structural context is not ready; lexical retrieval results are returned as degraded evidence.']
            : [];
          const facade = buildFacadeResult({
            status: 'ok',
            summary: pack.files.length
              ? `Retrieved ${pack.files.length} bounded code context file(s) for the query.`
              : 'No bounded code context matched the query.',
            data: {
              operation,
              repoId: repository.repoId,
              goal: pack.goal,
              search: pack.search,
              structuralContext: pack.structuralContext,
              impactContext: pack.impactContext,
              files: pack.files,
              coverage: pack.coverage,
              cache: pack.cache,
              timingsMs: pack.timingsMs,
              deniedPaths: pack.deniedPaths,
              omitted: pack.omitted,
              limits: pack.limits,
              contextContract: pack.contextContract,
              executionReadiness,
              registeredChecks: checks.slice(0, 80).map((check) => ({ id: check.id, description: check.description, source: check.source, effects: check.effects })),
              retrievalPolicy: {
                defaultBackend: 'bounded_lexical',
                structuralBackend: 'codegraph',
                rawReadTool: 'read_repository_file',
                shellSearchFallbackOnly: true,
              },
            },
            warnings,
            suggestedNextActions: [],
            detailLevel: 'summary',
            rawAvailable: true,
          });
          return result(facade as unknown as Record<string, unknown>);
        }
        const checks = listControllerChecks(repository.canonicalRoot);
        const requested = Array.isArray(args.requested_check_ids) ? args.requested_check_ids.map(String) : [];
        const normalizedChecks = normalizeCheckIds(requested, checks);
        const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
        const workId = typeof args.work_id === 'string' ? args.work_id : undefined;
        const work = workId ? getWorkContract(store, workId) : undefined;
        const executionJob = workId && !work ? (() => { try { return getExecutionJob(ctx.controllerHome, repository.repoId, workId); } catch { return undefined; } })() : undefined;
        if (workId && !work && !executionJob) {
          const facade = buildFacadeResult({
            status: 'not_found',
            summary: `Work ${workId} not found in this repository.`,
            data: { operation, repoId: repository.repoId, workId },
            suggestedNextActions: [],
          });
          return result(facade as unknown as Record<string, unknown>, true);
        }
        const startedAt = performance.now();
        const detailLevel = args.detail_level === 'detail' || args.detail_level === 'raw' ? args.detail_level : 'summary';
        const isSummary = detailLevel === 'summary';
        const activeContractScan = operation === 'list' || !workId
          ? listWorkContracts({ ...store, status: 'active', limit: 20 })
          : [];
        const currentCutoffMs = Date.now() - RH_CONTEXT_CURRENT_WINDOW_MS;
        const currentContractScan = isSummary
          ? activeContractScan.filter((contract) => isCurrentRhContextWork(contract, currentCutoffMs))
          : activeContractScan;
        const activeContracts = isSummary ? currentContractScan.slice(0, 3) : activeContractScan;
        const recentJobs = !isSummary && (operation === 'list' || !workId)
          ? listExecutionJobs(ctx.controllerHome, repository.repoId, 20)
            .filter((job) => timestampIsCurrent(job.updatedAt, currentCutoffMs))
            .slice(0, 5)
          : [];
        const processScan = listProcessRecords(ctx.controllerHome, repository.repoId, workId ? 100 : 50);
        const relevantProcesses = processScan.filter((process) => workId ? process.workId === workId : timestampIsCurrent(process.updatedAt, currentCutoffMs));
        const activeRuntimeInstanceId = currentControllerInstanceId();
        const activeProcesses = relevantProcesses.filter((process) => isManagedProcessActive(process) && (!process.runtimeInstanceId || process.runtimeInstanceId === activeRuntimeInstanceId));
        const workController = work ? getControllerSession(store, work.workId) : undefined;
        const requestedCapabilityId = typeof args.capability_id === 'string' ? args.capability_id.trim() : '';
        const exactPluginCapabilityLookup = requestedCapabilityId.startsWith('plugin.');
        const manifestOptions = exactPluginCapabilityLookup
          ? { forceRefresh: true }
          : { preferStored: true };
        const repositoryManifests = listAssistantPluginManifests(ctx.controllerHome, repository, manifestOptions);
        const controllerRepository = controllerPluginRepository(ctx.controllerHome);
        const controllerManifests = repository.repoId === controllerRepository.repoId
          ? []
          : listAssistantPluginManifests(ctx.controllerHome, controllerRepository, manifestOptions);
        const manifests = [...new Map(
          [...repositoryManifests, ...controllerManifests].map((manifest) => [manifest.pluginId, manifest] as const),
        ).values()];
        const capabilities = listCapabilityDescriptors(manifests);
        const capabilityGroups = summarizeCapabilityGroups(manifests);
        const selectedCapability = requestedCapabilityId
          ? capabilities.find((descriptor) => descriptor.capabilityId === requestedCapabilityId)
          : undefined;
        const pluginActionSchema = requestedCapabilityId
          ? getPluginActionCapabilitySchema(requestedCapabilityId, manifests)
          : undefined;
        const capabilityLookup = requestedCapabilityId ? {
          requestedCapabilityId,
          found: Boolean(selectedCapability),
          descriptor: selectedCapability,
          pluginAction: pluginActionSchema,
        } : undefined;
        const selectedChecks = normalizedChecks.validCheckIds
          .map((id) => checks.find((check) => check.id === id))
          .filter((check): check is (typeof checks)[number] => Boolean(check))
          .map((check) => ({ id: check.id, description: check.description, source: check.source }));
        const pendingAttention = listHandoffItems({ ...store, status: 'pending', limit: isSummary ? 20 : 5 });
        const currentWorkIds = new Set(currentContractScan.map((entry) => entry.workId));
        const currentAttentionScan = isSummary
          ? pendingAttention.filter((item) => (
            Boolean(item.workId && currentWorkIds.has(item.workId))
            || timestampIsCurrent(item.updatedAt, currentCutoffMs)
          ))
          : pendingAttention;
        const workAttention = work ? currentAttentionScan.find((item) => item.workId === work.workId) : undefined;
        const currentAttentionItems = isSummary
          ? currentAttentionScan.slice(0, 3)
          : pendingAttention;
        const attention = isSummary
          ? currentAttentionItems.map((item) => ({
            id: item.id,
            workId: item.workId,
            title: item.title.slice(0, 96),
            severity: item.severity,
            reason: item.reason.slice(0, 160),
            blockingDecision: item.blockingDecision?.slice(0, 160),
            updatedAt: item.updatedAt,
          }))
          : currentAttentionItems.map(summarizeHandoffItem);
        const detailCheckCandidates = requested.length > 0
          ? selectedChecks
          : checks.map((check) => ({ id: check.id, description: check.description, source: check.source }));
        const checkSummaries = isSummary ? selectedChecks : detailCheckCandidates.slice(0, 24);
        const detailArguments = {
          repo_id: repository.repoId,
          operation,
          ...(workId ? { work_id: workId } : {}),
          ...(requested.length ? { requested_check_ids: requested } : {}),
        };
        const summaryData = {
          operation,
          repoId: repository.repoId,
          repository: {
            repoId: repository.repoId,
            displayName: repository.displayName,
            defaultBranch: repository.defaultBranch,
            repositoryType: repository.repositoryType,
          },
          checks: selectedChecks,
          selectedChecks,
          requestedCheckIds: requested,
          normalizedChecks,
          invalidCheckIdsAreNotFailures: true,
          capabilityCount: capabilities.length,
          capabilityGroups: capabilityGroups.map((group) => ({ group: group.group, capabilityCount: group.capabilityCount })),
          capabilityLookup,
          toolArchitecture: {
            facadeTools: ['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work'],
            domainSchemaLoading: 'static_stable_surface',
          },
          work: work
            ? {
                workId: work.workId,
                status: work.status,
                mode: work.mode,
                objective: work.objective.slice(0, 160),
                continuation: buildWorkContinuationSnapshot(work),
              }
            : undefined,
          executionJob: executionJob ? summarizeWorkListItem(executionJob) : undefined,
          executionState: work ? (workAttention ? 'blocked' : activeProcesses.length > 0 ? 'executing' : workController ? 'controller_active' : 'waiting_trigger') : undefined,
          activeController: workController ? { controllerType: workController.controllerType, sessionId: workController.sessionId, leaseExpiresAt: workController.leaseExpiresAt } : undefined,
          activeProcesses: activeProcesses.slice(0, 3).map((process) => ({ processId: process.processId, workId: process.workId, status: process.status, route: process.route, startedAt: process.startedAt, updatedAt: process.updatedAt })),
          recentProcesses: relevantProcesses.slice(0, 5).map((process) => ({ processId: process.processId, workId: process.workId, status: process.status, route: process.route, startedAt: process.startedAt, updatedAt: process.updatedAt })),
          activeWork: activeContracts.map((entry) => ({
            workId: entry.workId,
            status: entry.status,
            mode: entry.mode,
            objective: entry.objective.slice(0, 160),
            semantics: buildWorkContinuationSnapshot(entry).semantics,
            reconciliationRequired: buildWorkContinuationSnapshot(entry).reconciliationRequired,
            nextSafeAction: buildWorkContinuationSnapshot(entry).nextSafeAction,
          })),
          activeAttention: attention,
          counts: {
            availableChecks: checks.length,
            selectedChecks: selectedChecks.length,
            capabilities: capabilities.length,
            capabilityGroups: capabilityGroups.length,
            activeWork: currentContractScan.length,
            activeWorkShown: activeContracts.length,
            storedNonTerminalWork: activeContractScan.length,
            currentWork: currentContractScan.length,
            historicalNonTerminalWork: Math.max(0, activeContractScan.length - currentContractScan.length),
            currentAttention: currentAttentionScan.length,
            currentAttentionShown: attention.length,
            activeProcesses: activeProcesses.length,
            recentProcesses: relevantProcesses.length,
            pendingAttentionScanned: pendingAttention.length,
            historicalPendingAttention: Math.max(0, pendingAttention.length - currentAttentionScan.length),
            omittedCurrentAttention: Math.max(0, currentAttentionScan.length - attention.length),
            omittedPendingAttention: Math.max(0, pendingAttention.length - attention.length),
          },
          historicalExecutionJobsIncluded: false,
          detailPointers: {
            detail: { tool: 'rh_context', arguments: { ...detailArguments, detail_level: 'detail' } },
            raw: { tool: 'rh_context', arguments: { ...detailArguments, detail_level: 'raw' } },
          },
          bounded: true,
        };
        const detailCapabilities = capabilities.slice(0, 24);
        const detailData = {
          operation,
          repoId: repository.repoId,
          repository: repositorySummary(repository),
          checks: checkSummaries,
          omittedCheckCount: Math.max(0, checks.length - checkSummaries.length),
          selectedChecks,
          requestedCheckIds: requested,
          normalizedChecks,
          invalidCheckIdsAreNotFailures: true,
          capabilityCount: capabilities.length,
          capabilities: detailCapabilities,
          omittedCapabilityCount: Math.max(0, capabilities.length - detailCapabilities.length),
          capabilityGroups,
          capabilityLookup,
          toolArchitecture: {
            facadeTools: ['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work'],
            atomicTypedToolsRetained: true,
            internalHandlersRetained: true,
            domainSchemaLoading: 'static_stable_surface',
            dynamicDomainSchemaLoadingSupported: false,
          },
          work: work ? { ...work, continuation: buildWorkContinuationSnapshot(work) } : undefined,
          executionJob: executionJob ? summarizeWorkListItem(executionJob) : undefined,
          executionState: work ? (workAttention ? 'blocked' : activeProcesses.length > 0 ? 'executing' : workController ? 'controller_active' : 'waiting_trigger') : undefined,
          activeController: workController,
          activeProcesses: activeProcesses.slice(0, 10),
          recentProcesses: relevantProcesses.slice(0, 20),
          activeWork: activeContracts.map((entry) => ({
            workId: entry.workId,
            status: entry.status,
            mode: entry.mode,
            objective: entry.objective.slice(0, 240),
            continuation: buildWorkContinuationSnapshot(entry),
          })),
          recentExecutionJobs: recentJobs.map(summarizeWorkListItem),
          activeAttention: attention,
          counts: {
            availableChecks: checks.length,
            selectedChecks: selectedChecks.length,
            capabilities: capabilities.length,
            activeWork: activeContracts.length,
            recentExecutionJobs: recentJobs.length,
            activeProcesses: activeProcesses.length,
            recentProcesses: relevantProcesses.length,
            activeAttention: attention.length,
          },
          bounded: true,
        };
        const facade = buildFacadeResult({
          status: 'ok',
          summary: work
            ? `Bounded context for work ${work.workId}.`
            : executionJob
              ? `Bounded context for execution job ${executionJob.jobId}.`
              : 'Bounded repository context and active work summaries are available.',
          data: isSummary ? summaryData : detailData,
          warnings: normalizedChecks.warnings,
          evidenceRefs: work?.evidenceRefs?.slice(0, 5) ?? [],
          suggestedNextActions: normalizedChecks.suggestedNextActions.length ? normalizedChecks.suggestedNextActions : [{
            label: 'Choose work mode',
            tool: 'rh_work',
            operation: 'start',
            risk: 'workspace_write',
            confidence: 'medium',
          }],
          detailLevel,
          rawAvailable: detailLevel === 'raw',
        });
        const payload = facade as unknown as Record<string, unknown>;
        if (isSummary) {
          payload.responseMeta = {
            serverDurationMs: Number((performance.now() - startedAt).toFixed(2)),
            structuredPayloadBytes: 0,
          };
          (payload.responseMeta as { structuredPayloadBytes: number }).structuredPayloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
        }
        return result(payload);
      }
      case 'rh_work': {
        const repository = selected(ctx, args);
        const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
        const operation = String(args.operation ?? 'start');
        if (!allowedFacadeOperations('rh_work').includes(operation)) {
          return invalidFacadeOperation('rh_work', operation);
        }
        if (operation.startsWith('schedule_')) {
          try {
            const workId = String(args.work_id ?? '').trim();
            const scheduleId = String(args.schedule_id ?? '').trim();
            if (operation === 'schedule_create') {
              const controllerType = String(args.controller_type ?? 'chatgpt').trim();
              if (!['chatgpt', 'codex', 'claude', 'grok'].includes(controllerType)) throw new Error('CONTROLLER_TYPE_INVALID');
              const triggerTypeRaw = String(args.trigger_type ?? '').trim();
              const triggerType = ['interval', 'cron', 'calendar', 'condition', 'repository-event', 'dependency-checkpoint', 'manual'].includes(triggerTypeRaw)
                ? triggerTypeRaw as 'interval' | 'cron' | 'calendar' | 'condition' | 'repository-event' | 'dependency-checkpoint' | 'manual'
                : undefined;
              const scheduleModeRaw = String(args.schedule_mode ?? (workId ? 'continuation' : 'workflow')).trim();
              if (!['workflow', 'continuation', 'browser_watch', 'browser_keepalive'].includes(scheduleModeRaw)) throw new Error('SCHEDULE_MODE_INVALID');
              if (scheduleModeRaw === 'workflow') {
                if (controllerType !== 'chatgpt') throw new Error('WORKFLOW_SCHEDULE_CONTROLLER_TYPE_UNSUPPORTED');
                const prompt = (typeof args.objective === 'string' ? args.objective : typeof args.continuation_prompt === 'string' ? args.continuation_prompt : '').trim();
                if (!prompt) throw new Error('WORKFLOW_SCHEDULE_PROMPT_REQUIRED');
                const trigger = {
                  type: triggerType ?? (typeof args.every_minutes === 'number' ? 'interval' : 'manual'),
                  everyMinutes: typeof args.every_minutes === 'number' ? Math.max(1, Math.trunc(args.every_minutes)) : undefined,
                  cronExpression: typeof args.cron_expression === 'string' ? args.cron_expression : undefined,
                  timezone: typeof args.schedule_timezone === 'string' ? args.schedule_timezone : undefined,
                  catchUpMinutes: typeof args.catch_up_minutes === 'number' ? Math.max(0, Math.trunc(args.catch_up_minutes)) : undefined,
                  calendarAt: typeof args.calendar_at === 'string' ? args.calendar_at : undefined,
                  condition: args.condition && typeof args.condition === 'object' && !Array.isArray(args.condition) ? args.condition as never : undefined,
                  eventName: typeof args.event_name === 'string' ? args.event_name : undefined,
                  dependencyJobIds: Array.isArray(args.dependency_job_ids) ? args.dependency_job_ids.map(String) : undefined,
                };
                const policy = {
                  maxActiveOccurrences: 1,
                  maxFailures: typeof args.max_failures === 'number' ? Math.max(1, Math.trunc(args.max_failures)) : 3,
                  cooldownMinutes: typeof args.cooldown_minutes === 'number' ? Math.max(0, Math.trunc(args.cooldown_minutes)) : 120,
                  dailyBudgetMinutes: typeof args.daily_budget_minutes === 'number' ? Math.max(1, Math.trunc(args.daily_budget_minutes)) : 180,
                  shadowMode: args.shadow_mode !== false,
                  backoffBaseMinutes: typeof args.backoff_base_minutes === 'number' ? Math.max(1, Math.trunc(args.backoff_base_minutes)) : 5,
                  backoffMaxMinutes: typeof args.backoff_max_minutes === 'number' ? Math.max(1, Math.trunc(args.backoff_max_minutes)) : 24 * 60,
                };
                const actionArguments = {
                  prompt,
                  ...(typeof args.browser_session_id === 'string' && args.browser_session_id.trim() ? { browser_session_id: args.browser_session_id.trim() } : {}),
                  ...(typeof args.conversation_url === 'string' && args.conversation_url.trim() ? { conversation_url: args.conversation_url.trim() } : {}),
                };
                assertAutomatedOperationAllowed('chatgpt_browser_prompt', actionArguments);
                const name = typeof args.schedule_name === 'string' && args.schedule_name.trim() ? args.schedule_name.trim() : `Workflow: ${prompt.slice(0, 80)}`;
                const stopConditions = Array.isArray(args.stop_conditions) ? args.stop_conditions.map(String) : [];
                const semantic = JSON.stringify({ repoId: repository.repoId, name, trigger, policy, actionArguments, stopConditions });
                const requestId = typeof args.schedule_request_id === 'string' && args.schedule_request_id.trim()
                  ? args.schedule_request_id.trim()
                  : `workflow-schedule:${repository.repoId}:${createHash('sha256').update(semantic).digest('hex').slice(0, 20)}`;
                const schedule = createSchedule(ctx.controllerHome, {
                  requestId,
                  repoId: repository.repoId,
                  name,
                  enabled: true,
                  trigger,
                  policy,
                  action: { operation: 'chatgpt_browser_prompt', target: 'runtime', arguments: actionArguments, resourceClaims: [] },
                  stopConditions,
                });
                return result(buildFacadeResult({ summary: `Workflow schedule ${schedule.scheduleId} is configured without a durable Work.`, data: { schedule } }) as unknown as Record<string, unknown>);
              }
              const created = createWorkContinuationSchedule(ctx.controllerHome, repository.repoId, {
                workId,
                scheduleMode: scheduleModeRaw as 'continuation' | 'browser_watch' | 'browser_keepalive',
                controllerType: controllerType as ContinuationControllerType,
                executable: typeof args.executable === 'string' ? args.executable : undefined,
                launchArgs: Array.isArray(args.launch_args) ? args.launch_args.map(String) : undefined,
                launchReservationMs: typeof args.launch_reservation_ms === 'number' ? args.launch_reservation_ms : typeof args.lease_ms === 'number' ? args.lease_ms : undefined,
                handoffId: typeof args.handoff_id === 'string' ? args.handoff_id : undefined,
                browserSessionId: typeof args.browser_session_id === 'string' ? args.browser_session_id : undefined,
                conversationUrl: typeof args.conversation_url === 'string' ? args.conversation_url : undefined,
                continuationPrompt: typeof args.continuation_prompt === 'string' ? args.continuation_prompt : undefined,
                probeUrl: typeof args.probe_url === 'string' ? args.probe_url : undefined,
                probeBrowserSessionId: typeof args.probe_browser_session_id === 'string' ? args.probe_browser_session_id : undefined,
                probeSelector: typeof args.probe_selector === 'string' ? args.probe_selector : undefined,
                probeMaxChars: typeof args.probe_max_chars === 'number' ? args.probe_max_chars : undefined,
                probeTimeoutMs: typeof args.probe_timeout_ms === 'number' ? args.probe_timeout_ms : undefined,
                includeTerms: Array.isArray(args.include_terms) ? args.include_terms.map(String) : undefined,
                ignorePatterns: Array.isArray(args.ignore_patterns) ? args.ignore_patterns.map(String) : undefined,
                loginUrlTerms: Array.isArray(args.login_url_terms) ? args.login_url_terms.map(String) : undefined,
                loginTextTerms: Array.isArray(args.login_text_terms) ? args.login_text_terms.map(String) : undefined,
                wakeOnFirstObservation: args.wake_on_first_observation === true,
                wakeOnAuthRequired: args.wake_on_auth_required !== false,
                authRequiredPrompt: typeof args.auth_required_prompt === 'string' ? args.auth_required_prompt : undefined,
                scheduleName: typeof args.schedule_name === 'string' ? args.schedule_name : undefined,
                requestId: typeof args.schedule_request_id === 'string' ? args.schedule_request_id : undefined,
                triggerType,
                everyMinutes: typeof args.every_minutes === 'number' ? args.every_minutes : undefined,
                cronExpression: typeof args.cron_expression === 'string' ? args.cron_expression : undefined,
                timezone: typeof args.schedule_timezone === 'string' ? args.schedule_timezone : undefined,
                catchUpMinutes: typeof args.catch_up_minutes === 'number' ? args.catch_up_minutes : undefined,
                calendarAt: typeof args.calendar_at === 'string' ? args.calendar_at : undefined,
                condition: args.condition && typeof args.condition === 'object' && !Array.isArray(args.condition) ? args.condition as never : undefined,
                eventName: typeof args.event_name === 'string' ? args.event_name : undefined,
                dependencyJobIds: Array.isArray(args.dependency_job_ids) ? args.dependency_job_ids.map(String) : undefined,
                maxFailures: typeof args.max_failures === 'number' ? args.max_failures : undefined,
                cooldownMinutes: typeof args.cooldown_minutes === 'number' ? args.cooldown_minutes : undefined,
                dailyBudgetMinutes: typeof args.daily_budget_minutes === 'number' ? args.daily_budget_minutes : undefined,
                shadowMode: typeof args.shadow_mode === 'boolean' ? args.shadow_mode : undefined,
                backoffBaseMinutes: typeof args.backoff_base_minutes === 'number' ? args.backoff_base_minutes : undefined,
                backoffMaxMinutes: typeof args.backoff_max_minutes === 'number' ? args.backoff_max_minutes : undefined,
                stopConditions: Array.isArray(args.stop_conditions) ? args.stop_conditions.map(String) : undefined,
              });
              return result(buildFacadeResult({
                summary: created.work
                  ? `Work schedule ${created.schedule.scheduleId} is configured for Work ${created.work.workId}.`
                  : `Browser keepalive schedule ${created.schedule.scheduleId} is configured without a durable Work.`,
                data: {
                  schedule: created.schedule,
                  ...(created.work ? { work: buildWorkContinuationSnapshot(created.work) } : {}),
                },
              }) as unknown as Record<string, unknown>);
            }
            if (operation === 'schedule_list') {
              const schedules = listSchedules(ctx.controllerHome, repository.repoId)
                .filter((entry) => !workId || entry.action.arguments?.work_id === workId);
              const data = args.include_occurrences === true
                ? { schedules, occurrences: listOccurrences(ctx.controllerHome, repository.repoId, undefined, 100).filter((entry) => schedules.some((schedule) => schedule.scheduleId === entry.scheduleId)) }
                : { schedules };
              return result(buildFacadeResult({ summary: `Found ${schedules.length} schedule(s).`, data }) as unknown as Record<string, unknown>);
            }
            if (!scheduleId) throw new Error('SCHEDULE_ID_REQUIRED');
            if (operation === 'schedule_get') {
              const schedule = getSchedule(ctx.controllerHome, repository.repoId, scheduleId);
              const data = args.include_occurrences === true ? { schedule, occurrences: listOccurrences(ctx.controllerHome, repository.repoId, scheduleId, 50) } : { schedule };
              return result(buildFacadeResult({ summary: `Schedule ${scheduleId}.`, data }) as unknown as Record<string, unknown>);
            }
            if (operation === 'schedule_pause') {
              const schedule = getSchedule(ctx.controllerHome, repository.repoId, scheduleId);
              const saved = saveSchedule(ctx.controllerHome, { ...schedule, enabled: false, pausedReason: typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : 'Paused by ChatGPT.' });
              return result(buildFacadeResult({ summary: `Schedule ${scheduleId} is paused.`, data: { schedule: saved } }) as unknown as Record<string, unknown>);
            }
            if (operation === 'schedule_resume') {
              const schedule = getSchedule(ctx.controllerHome, repository.repoId, scheduleId);
              const saved = saveSchedule(ctx.controllerHome, { ...schedule, enabled: true, pausedReason: undefined, consecutiveFailures: 0, nextEligibleAt: undefined });
              return result(buildFacadeResult({ summary: `Schedule ${scheduleId} is resumed.`, data: { schedule: saved } }) as unknown as Record<string, unknown>);
            }
            if (operation === 'schedule_trigger') {
              const schedule = getSchedule(ctx.controllerHome, repository.repoId, scheduleId);
              const occurrence = await evaluateSchedule(ctx.controllerHome, schedule, true, {
                source: typeof args.event_name === 'string' && args.event_name.trim() ? 'repository-event' : 'manual',
                eventName: typeof args.event_name === 'string' ? args.event_name : undefined,
                eventId: typeof args.event_id === 'string' ? args.event_id : undefined,
                data: args.event_data && typeof args.event_data === 'object' && !Array.isArray(args.event_data) ? args.event_data as Record<string, unknown> : undefined,
              });
              return result(buildFacadeResult({ summary: occurrence ? `Schedule ${scheduleId} produced ${occurrence.decision}.` : `Schedule ${scheduleId} produced no occurrence.`, data: { occurrence } }) as unknown as Record<string, unknown>);
            }
          } catch (error) {
            return result(buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Schedule operation failed.', data: {} }) as unknown as Record<string, unknown>, true);
          }
        }
        if (operation === 'controller_get_owner') {
          const owner = getControllerSession(store, String(args.work_id ?? '').trim());
          return result(buildFacadeResult({ summary: owner ? `Work is claimed by ${owner.controllerId}.` : 'Work has no active controller owner.', data: { owner } }) as unknown as Record<string, unknown>);
        }
        if (operation === 'controller_claim') {
          try {
            const workId = String(args.work_id ?? '').trim();
            const work = getWorkContract(store, workId);
            if (!work) throw new Error(`WORK_NOT_FOUND: ${workId}`);
            const identity = authenticatedFacadeControllerIdentity(ctx, args);
            const session = resumeControllerSession(store, {
              workId,
              controllerId: identity.controllerId,
              controllerType: ['chatgpt', 'codex', 'grok', 'claude', 'human'].includes(String(args.controller_type)) ? String(args.controller_type) as 'chatgpt' | 'codex' | 'grok' | 'claude' | 'human' : 'chatgpt',
              sessionId: identity.sessionId,
              principalId: identity.principalId,
              controllerInstanceId: identity.controllerInstanceId,
              leaseMs: typeof args.lease_ms === 'number' ? args.lease_ms : undefined,
            });
            const permissionSnapshotVersion = currentPermissionSnapshotVersion(ctx.controllerHome, repository.repoId);
            const executionSession = startExecutionSession(ctx.controllerHome, {
              sessionId: identity.sessionId,
              principalId: identity.principalId,
              controllerInstanceId: identity.controllerInstanceId,
              permissionSnapshotVersion,
            });
            updateExecutionSession(ctx.controllerHome, {
              sessionId: executionSession.sessionId,
              principalId: executionSession.principalId,
              controllerInstanceId: executionSession.controllerInstanceId,
            }, {
              activeRepositoryId: repository.repoId,
              activeCheckoutId: work.checkoutId || repository.activeCheckoutId,
              activeWorkId: work.workId,
              permissionSnapshotVersion,
              lastValidatedAt: new Date().toISOString(),
            });
            return result(buildFacadeResult({ summary: `Controller ${session.controllerId} claimed ${session.workId}.`, data: { session } }) as unknown as Record<string, unknown>);
          } catch (error) {
            return result(buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Controller claim failed.', data: {} }) as unknown as Record<string, unknown>, true);
          }
        }
        if (operation === 'controller_release') {
          try {
            const workId = String(args.work_id ?? '').trim();
            const identity = authenticatedFacadeControllerIdentity(ctx, args);
            const owner = getControllerSession(store, workId);
            if (owner && owner.controllerId !== identity.controllerId) {
              throw new Error(`WORK_CONTROLLER_OWNER_MISMATCH: ${workId} is owned by ${owner.controllerId}`);
            }
            releaseControllerSession(store, workId, identity.controllerId);
            const executionSession = readExecutionSession(ctx.controllerHome, identity);
            if (executionSession?.activeWorkId === workId) {
              updateExecutionSession(ctx.controllerHome, identity, { activeWorkId: undefined, lastValidatedAt: new Date().toISOString() });
            }
            return result(buildFacadeResult({ summary: 'Controller lease released.', data: {} }) as unknown as Record<string, unknown>);
          } catch (error) {
            return result(buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Controller release failed.', data: {} }) as unknown as Record<string, unknown>, true);
          }
        }
        if (operation === 'launcher_start') {
          try {
            const controllerType = String(args.controller_type ?? 'codex');
            if (!['chatgpt', 'codex', 'grok', 'claude'].includes(controllerType)) throw new Error('CONTROLLER_TYPE_INVALID');
            const launched = launchSuperController({ work: store, handoff: store }, {
              controllerType: controllerType as 'chatgpt' | 'codex' | 'grok' | 'claude',
              executable: typeof args.executable === 'string' && args.executable.trim() ? args.executable.trim() : undefined,
              args: Array.isArray(args.launch_args) ? args.launch_args.map(String) : [],
              workId: String(args.work_id ?? '').trim(),
              launchReservationMs: typeof args.launch_reservation_ms === 'number' ? args.launch_reservation_ms : typeof args.lease_ms === 'number' ? args.lease_ms : undefined,
              handoffId: typeof args.handoff_id === 'string' ? args.handoff_id : undefined,
              browserSessionId: typeof args.browser_session_id === 'string' ? args.browser_session_id : undefined,
              conversationUrl: typeof args.conversation_url === 'string' ? args.conversation_url : undefined,
              continuationPrompt: typeof args.continuation_prompt === 'string' ? args.continuation_prompt : undefined,
              cwd: repository.canonicalRoot,
            });
            return result(buildFacadeResult({ summary: `Thin Launcher started ${launched.controllerType}.`, data: { pid: launched.pid, executable: launched.executable, workId: String(args.work_id ?? ''), reservationId: launched.reservationId } }) as unknown as Record<string, unknown>);
          } catch (error) {
            return result(buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Launcher failed.', data: {} }) as unknown as Record<string, unknown>, true);
          }
        }
        const checks = listControllerChecks(repository.canonicalRoot);
        const workloopCtx = {
          workStore: store,
          handoffStore: store,
          planStore: store,
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          principalId: ctx.principalId,
          controllerInstanceId: ctx.controllerInstanceId,
          availableChecks: checks,
          sourceRevision: gitSnapshot(repository.canonicalRoot).head ?? undefined,
          materializeIsolatedWorkspace: ({ workId, title, baseRef, needsDependencies }: { workId: string; title: string; baseRef?: string; needsDependencies?: boolean }) => {
            const workspace = ensureManagedWorkspace(ctx.controllerHome, repository, {
              requestId: workId,
              title,
              baseRef,
              prepareDependencies: needsDependencies === true,
            });
            if (!workspace.managed || !workspace.checkoutId || !workspace.root) throw new Error('MANAGED_WORKSPACE_NOT_MATERIALIZED');
            return { checkoutId: workspace.checkoutId, root: workspace.root, baseRevision: workspace.baseRevision, managed: true as const };
          },
        };

        if (operation.startsWith('plan_')) {
          try {
            if (operation === 'plan_create') {
              const rawSteps = Array.isArray(args.plan_steps) ? args.plan_steps : [];
              const requestedRequirementId = typeof args.requirement_id === 'string' && args.requirement_id.trim() ? args.requirement_id.trim() : undefined;
              const requestedScopeKey = String(args.scope_key ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 160);
              const activePlans = listPlanContracts({ ...store, status: 'active', limit: 100 });
              const exactScopeAuthority = requestedScopeKey
                ? activePlans.find((candidate) => candidate.scopeKey === requestedScopeKey)
                : undefined;
              if (exactScopeAuthority) {
                const facade = buildFacadeResult({
                  summary: `PLAN_AUTHORITY_REUSED: active Plan ${exactScopeAuthority.planId} already owns scope ${requestedScopeKey}; no duplicate draft was created.`,
                  data: {
                    plan: summarizePlanContract(exactScopeAuthority),
                    executionStarted: false,
                    planContractCreated: false,
                    admissionDecision: 'reuse_existing',
                    resolutionRequired: false,
                  },
                  suggestedNextActions: [{ label: 'Read active Plan', tool: 'rh_work', operation: 'plan_get', payload: { plan_id: exactScopeAuthority.planId }, risk: 'readonly', confidence: 'high' }],
                });
                return result(facade as unknown as Record<string, unknown>);
              }
              const requirementPlans = requestedRequirementId
                ? activePlans.filter((candidate) => candidate.requirementId === requestedRequirementId)
                : [];
              const requestedPlanRelation = args.plan_relation === 'extend' || args.plan_relation === 'parallel'
                ? args.plan_relation
                : undefined;
              const relatedPlanId = typeof args.related_plan_id === 'string' && args.related_plan_id.trim() ? args.related_plan_id.trim() : undefined;
              const relatedPlan = relatedPlanId
                ? requirementPlans.find((candidate) => candidate.planId === relatedPlanId)
                : requirementPlans.length === 1 ? requirementPlans[0] : undefined;
              if (requirementPlans.length > 0 && !requestedPlanRelation) {
                const facade = buildFacadeResult({
                  summary: `PLAN_RELATION_RESOLUTION_REQUIRED: Requirement ${requestedRequirementId} already has ${requirementPlans.length} active Plan slice(s). Decide whether this scope extends one of them or is an intentional parallel slice before creating a draft.`,
                  data: {
                    executionStarted: false,
                    planContractCreated: false,
                    admissionDecision: 'resolution_required',
                    resolutionRequired: true,
                    candidates: requirementPlans.slice(0, 8).map(summarizePlanContract),
                    allowedPlanRelations: ['extend', 'parallel'],
                  },
                  suggestedNextActions: requirementPlans.slice(0, 3).map((candidate) => ({ label: `Read ${candidate.planId}`, tool: 'rh_work', operation: 'plan_get', payload: { plan_id: candidate.planId }, risk: 'readonly' as const, confidence: 'high' as const })),
                });
                return result(facade as unknown as Record<string, unknown>);
              }
              if (requirementPlans.length > 0 && requestedPlanRelation === 'extend') {
                if (!relatedPlan) {
                  const facade = buildFacadeResult({
                    summary: `PLAN_EXTENSION_TARGET_REQUIRED: select related_plan_id from the active Plan slices for Requirement ${requestedRequirementId}.`,
                    data: { executionStarted: false, planContractCreated: false, admissionDecision: 'resolution_required', resolutionRequired: true, candidates: requirementPlans.slice(0, 8).map(summarizePlanContract) },
                  });
                  return result(facade as unknown as Record<string, unknown>);
                }
                const facade = buildFacadeResult({
                  summary: `PLAN_EXTENSION_REQUIRES_REPLAN: ${relatedPlan.planId} remains the serial authority. Extend/replan and supersede that authority rather than creating a second active Plan draft.`,
                  data: { plan: summarizePlanContract(relatedPlan), executionStarted: false, planContractCreated: false, admissionDecision: 'extend_existing', resolutionRequired: false },
                  suggestedNextActions: [{ label: 'Read active Plan', tool: 'rh_work', operation: 'plan_get', payload: { plan_id: relatedPlan.planId }, risk: 'readonly', confidence: 'high' }],
                });
                return result(facade as unknown as Record<string, unknown>);
              }
              const requestedPlanCheckIds = rawSteps
                .filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === 'object' && !Array.isArray(step))
                .flatMap((step) => Array.isArray(step.check_ids) ? step.check_ids.map(String) : []);
              const normalizedPlanChecks = normalizeCheckIds(requestedPlanCheckIds, checks);
              if (normalizedPlanChecks.invalidCheckIds.length > 0) {
                const facade = buildFacadeResult({
                  status: 'failed',
                  summary: `PLAN_CHECKS_INVALID: ${normalizedPlanChecks.invalidCheckIds.join(', ')}. Plan was not persisted; use registered checks from rh_context executionReadiness.`,
                  data: {
                    executionStarted: false,
                    planContractCreated: false,
                    admissionDecision: 'invalid_checks',
                    normalizedChecks: normalizedPlanChecks,
                    registeredCheckIds: checks.map((check) => check.id).slice(0, 80),
                  },
                  suggestedNextActions: [{ label: 'Read execution readiness', tool: 'rh_context', operation: 'search', payload: { repo_id: repository.repoId, query: 'execution readiness and registered checks', structural_context: 'off' }, risk: 'readonly', confidence: 'high' }],
                });
                return result(facade as unknown as Record<string, unknown>, true);
              }
              const plan = createPlanContract(store, {
                planId: String(args.plan_id ?? ''),
                repoId: repository.repoId,
                requirementId: requestedRequirementId,
                scopeKey: String(args.scope_key ?? ''),
                sourceRevision: String(args.source_revision ?? ''),
                goal: String(args.objective ?? ''),
                nonGoals: Array.isArray(args.non_goals) ? args.non_goals.map(String) : undefined,
                assumptions: Array.isArray(args.assumptions) ? args.assumptions.map(String) : undefined,
                resolvedDecisions: Array.isArray(args.resolved_decisions) ? args.resolved_decisions.map(String) : undefined,
                stopConditions: Array.isArray(args.stop_conditions) ? args.stop_conditions.map(String) : undefined,
                replanConditions: Array.isArray(args.replan_conditions) ? args.replan_conditions.map(String) : undefined,
                integrationStrategy: typeof args.integration_strategy === 'string' ? args.integration_strategy : undefined,
                steps: rawSteps.filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === 'object' && !Array.isArray(step)).map((step) => ({
                  id: String(step.id ?? ''),
                  objective: String(step.objective ?? ''),
                  dependencies: Array.isArray(step.dependencies) ? step.dependencies.map(String) : [],
                  authoritativeFiles: Array.isArray(step.authoritative_files) ? step.authoritative_files.map(String) : [],
                  allowedPaths: Array.isArray(step.allowed_paths) ? step.allowed_paths.map(String) : [],
                  forbiddenPaths: Array.isArray(step.forbidden_paths) ? step.forbidden_paths.map(String) : [],
                  checks: Array.isArray(step.check_ids) ? step.check_ids.map(String) : [],
                  acceptanceCriteria: Array.isArray(step.acceptance_criteria) ? step.acceptance_criteria.map(String) : [],
                })),
              });
              const facade = buildFacadeResult({
                summary: `PlanContract ${plan.planId} created as draft after authority preflight; no execution was started.`,
                data: { plan: summarizePlanContract(plan), executionStarted: false, planContractCreated: true, admissionDecision: 'create_new' },
                suggestedNextActions: [{ label: 'Approve reviewed plan', tool: 'rh_work', operation: 'plan_approve', payload: { plan_id: plan.planId }, risk: 'workspace_write', confidence: 'medium' }],
              });
              return result(facade as unknown as Record<string, unknown>);
            }
            if (operation === 'plan_list') {
              const plans = listPlanContracts({ ...store, status: 'active', limit: typeof args.limit === 'number' ? args.limit : 20 });
              const facade = buildFacadeResult({
                summary: `${plans.length} active PlanContract(s) in this repository.`,
                data: { plans: plans.map(summarizePlanContract), bounded: true },
              });
              return result(facade as unknown as Record<string, unknown>);
            }
            if (operation === 'plan_get') {
              const plan = getPlanContract(store, String(args.plan_id ?? ''));
              const facade = plan
                ? buildFacadeResult({ summary: `PlanContract ${plan.planId} retrieved.`, data: { plan: args.detail_level === 'detail' ? plan : summarizePlanContract(plan) }, detailLevel: args.detail_level === 'detail' ? 'detail' : 'summary' })
                : buildFacadeResult({ status: 'not_found', summary: `PlanContract ${String(args.plan_id ?? '')} not found.`, data: { planId: String(args.plan_id ?? '') } });
              return result(facade as unknown as Record<string, unknown>, !plan);
            }
            if (operation === 'plan_approve') {
              const plan = approvePlanContract(store, String(args.plan_id ?? ''));
              const facade = buildFacadeResult({
                summary: `PlanContract ${plan.planId} approved at source revision ${plan.sourceRevision}; execution remains explicit.`,
                data: { plan: summarizePlanContract(plan), executionStarted: false },
              });
              return result(facade as unknown as Record<string, unknown>);
            }
            if (operation === 'plan_accept_step') {
              const identity = authenticatedFacadeControllerIdentity(ctx, args);
              const planId = String(args.plan_id ?? '').trim();
              const stepId = String(args.plan_step_id ?? '').trim();
              const rationale = String(args.acceptance_rationale ?? '').trim();
              const plan = acceptPlanStepEvidence(store, {
                planId,
                stepId,
                reviewer: identity.principalId,
                rationale,
              });
              const facade = buildFacadeResult({
                summary: `Plan step ${stepId} semantically accepted by the current Controller.`,
                data: { plan: summarizePlanContract(plan), semanticAcceptanceRecorded: true, reviewer: identity.principalId },
                suggestedNextActions: plan.status === 'finalized'
                  ? []
                  : [{ label: 'Continue the next approved Plan step', tool: 'rh_work', operation: 'plan_get', payload: { plan_id: plan.planId }, risk: 'readonly', confidence: 'high' }],
              });
              return result(facade as unknown as Record<string, unknown>);
            }
            const plan = supersedePlanContract(store, String(args.plan_id ?? ''), String(args.superseded_by ?? ''));
            const facade = buildFacadeResult({ summary: `PlanContract ${plan.planId} superseded by ${plan.supersededBy}.`, data: { plan: summarizePlanContract(plan) } });
            return result(facade as unknown as Record<string, unknown>);
          } catch (error) {
            const facade = buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'PlanContract operation failed.', data: { operation, executionStarted: false } });
            return result(facade as unknown as Record<string, unknown>, true);
          }
        }

        if (operation === 'repair') {
          return await runFacadeRepair(ctx, repository, args);
        }

        if (operation === 'verify') {
          return await runFacadeVerify(ctx, repository, args);
        }

        if (operation === 'delegate') {
          const facade = delegateToCodexCerebellum(
            { repoId: repository.repoId },
            {
              workId: typeof args.work_id === 'string' ? args.work_id : undefined,
              target: args.target === 'grok' || args.target === 'claude' || args.target === 'codex' ? args.target : 'codex',
              objective: typeof args.objective === 'string' ? args.objective : 'Delegated cerebellum work',
              acceptanceCriteria: Array.isArray(args.acceptance_criteria) ? args.acceptance_criteria.map(String) : undefined,
              allowedPaths: Array.isArray(args.allowed_paths) ? args.allowed_paths.map(String) : undefined,
              forbiddenPaths: Array.isArray(args.forbidden_paths) ? args.forbidden_paths.map(String) : undefined,
              available: typeof args.available === 'boolean' ? args.available : undefined,
              codexAvailable: args.codex_available !== false,
              workerOutput: args.worker_output && typeof args.worker_output === 'object' && !Array.isArray(args.worker_output)
                ? args.worker_output as { uncertain?: boolean; summary?: string; patchProposal?: string; evidenceSummary?: string }
                : undefined,
            },
          );
          return result(facade as unknown as Record<string, unknown>, facade.status === 'blocked');
        }

        if (operation === 'stop') {
          const facade = runGoalWorkloop({ ...workloopCtx, sourceRevision: workloopCtx.sourceRevision ?? undefined }, 'stop', args);
          if (facade.status !== 'ok') {
            return result(facade as unknown as Record<string, unknown>, true);
          }
          try {
            const physical = await finalizeFacadeWorkHandle(ctx, repository, args, 'stop');
            if (!physical) return result(facade as unknown as Record<string, unknown>);
            const cleanup = contextRecord(physical.structuredContent);
            const cleanupCompleted = cleanup.cleanupCompleted === true || contextRecord(cleanup.work).state === 'cleaned';
            const response = {
              ...facade,
              status: cleanupCompleted ? 'ok' : 'blocked',
              summary: cleanupCompleted
                ? `${facade.summary} Managed worktree and branch cleanup completed automatically.`
                : `${facade.summary} Automatic managed-resource cleanup is incomplete and remains visible for retry.`,
              data: {
                ...(facade.data && typeof facade.data === 'object' ? facade.data : {}),
                worktreeDeleted: cleanupCompleted,
                cleanupPending: !cleanupCompleted,
                lifecycleCleanup: cleanup,
              },
            };
            return result(response as unknown as Record<string, unknown>, !cleanupCompleted || physical.isError === true);
          } catch (error) {
            const response = {
              ...facade,
              status: 'blocked',
              summary: `${facade.summary} Automatic managed-resource cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
              data: {
                ...(facade.data && typeof facade.data === 'object' ? facade.data : {}),
                worktreeDeleted: false,
                cleanupPending: true,
              },
            };
            return result(response as unknown as Record<string, unknown>, true);
          }
        }

        if (operation === 'finalize') {
          const workId = String(args.work_id ?? '').trim();
          if (workId) reconcileTerminalFacadeWorkVerifications(ctx, repository, workId);
          let before = workId ? getWorkContract(store, workId) : undefined;
          if (before && !before.completionReceipt && args.reconcile_historical_delivery === true) {
            try {
              const identity = authenticatedFacadeControllerIdentity(ctx, args);
              const owner = getControllerSession(store, workId);
              if (!owner || (owner.principalId?.trim() || owner.controllerId) !== identity.principalId) {
                throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_CONTROLLER_CLAIM_REQUIRED: ${workId}`);
              }
              const historicalHandle = readWorkHandle(ctx.controllerHome, repository.repoId, workId);
              if (historicalHandle?.managedWorktree) throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_MANAGED_CLEANUP_REQUIRED: ${workId}`);
              const reconciliation = acceptReviewedDirectEditWorkReconciliation({
                controllerHome: ctx.controllerHome,
                repoId: repository.repoId,
                checkoutId: before.checkoutId ?? repository.activeCheckoutId,
                repoRoot: repository.canonicalRoot,
                workId,
                targetBranch: typeof args.target_branch === 'string' && args.target_branch.trim() ? args.target_branch.trim() : repository.defaultBranch || 'main',
                targetRevision: String(args.reconcile_target_revision ?? ''),
                comparedPaths: Array.isArray(args.reconcile_compared_paths) ? args.reconcile_compared_paths.map(String) : [],
                reviewer: identity.principalId,
                rationale: String(args.reconcile_rationale ?? ''),
                cleanupOwnershipProof: String(args.reconcile_cleanup_proof ?? ''),
              });
              if (historicalHandle && historicalHandle.state !== 'cleaned') {
                const finalization: WorkHandleState['finalization'] = { validation: 'done', commit: 'done', merge: 'skipped', branchCleanup: 'skipped', worktreeCleanup: 'skipped' };
                const delivered = historicalHandle.state === 'committed' || historicalHandle.state === 'merged' || historicalHandle.state === 'failed_terminal_cleanup'
                  ? historicalHandle
                  : transitionWorkHandle(ctx.controllerHome, historicalHandle, 'committed', { expectedHead: reconciliation.receipt.targetRevision, finalization, failureReason: undefined });
                transitionWorkHandle(ctx.controllerHome, delivered, 'cleaned', { expectedHead: reconciliation.receipt.targetRevision, finalization, failureReason: undefined });
              }
              releaseControllerSession(store, workId, owner.controllerId);
              before = getWorkContract(store, workId);
            } catch (error) {
              const blocked = buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Historical Work delivery reconciliation failed.', data: { workId, lifecycleClosed: false } });
              return result(blocked as unknown as Record<string, unknown>, true);
            }
          }
          if (before && !before.completionReceipt) {
            try {
              const physical = await finalizeFacadeWorkHandle(ctx, repository, args, 'finalize');
              if (physical?.isError === true) return physical;
              const refreshed = getWorkContract(store, workId);
              if (physical && !refreshed?.completionReceipt) return physical;
            } catch (error) {
              const blocked = buildFacadeResult({
                status: 'blocked',
                summary: error instanceof Error ? error.message : 'Work delivery/finalization failed.',
                data: { workId, lifecycleClosed: false },
              });
              return result(blocked as unknown as Record<string, unknown>, true);
            }
          }
          const facade = runGoalWorkloop({ ...workloopCtx, sourceRevision: workloopCtx.sourceRevision ?? undefined }, 'finalize', args);
          const completed = getWorkContract(store, workId);
          const lifecycleClosed = Boolean(completed?.completionReceipt)
            && (!readWorkHandle(ctx.controllerHome, repository.repoId, workId)
              || readWorkHandle(ctx.controllerHome, repository.repoId, workId)?.finalization.worktreeCleanup !== 'pending');
          const response = {
            ...facade,
            data: {
              ...(facade.data && typeof facade.data === 'object' ? facade.data : {}),
              lifecycleClosed,
            },
          };
          return result(response as unknown as Record<string, unknown>, response.status === 'blocked' || response.status === 'failed' || response.status === 'not_found');
        }

        let resumedControllerSession: ReturnType<typeof resumeControllerSession> | undefined;
        let continuationSourceRevision = workloopCtx.sourceRevision;
        if (operation === 'continue') {
          try {
            const workId = String(args.work_id ?? '').trim();
            const work = getWorkContract(store, workId);
            if (work && !['cancelled', 'completed', 'failed'].includes(work.status)) {
              const identity = authenticatedFacadeControllerIdentity(ctx, args);
              const currentOwner = getControllerSession(store, workId);
              resumedControllerSession = resumeControllerSession(store, {
                workId,
                controllerId: identity.controllerId,
                controllerType: identity.controllerType,
                sessionId: identity.sessionId,
                principalId: identity.principalId,
                controllerInstanceId: identity.controllerInstanceId,
                leaseMs: 3_600_000,
              });
            }
            if (workId) {
              const reconciled = reconcileTerminalFacadeWorkVerifications(ctx, repository, workId);
              continuationSourceRevision = reconciled.sourceRevision ?? continuationSourceRevision;
            }
          } catch (error) {
            const facade = buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Controller resume failed.', data: { operation, executionStarted: false, ownershipResumed: false } });
            return result(facade as unknown as Record<string, unknown>, true);
          }
        }

        const facade = runGoalWorkloop({ ...workloopCtx, sourceRevision: continuationSourceRevision ?? undefined }, operation as 'start' | 'continue', args);
        const facadeData = facade.data && typeof facade.data === 'object' ? facade.data as Record<string, unknown> : {};
        const facadeWorkId = contextText(contextRecord(facadeData.work).workId, 200);
        if (facade.status === 'ok' && facadeWorkId) {
          try {
            const handle = ensureFacadeWorkHandle(ctx, repository, facadeWorkId, args);
            if (handle) facadeData.executionHandle = { workId: handle.workId, checkoutId: handle.checkoutId, managedWorktree: handle.managedWorktree, state: handle.state };
            if (facadeData.workContractCreated === true) {
              const owner = claimNewFacadeWork(ctx, repository, facadeWorkId, args);
              facadeData.controllerSession = owner;
              facadeData.ownershipClaimed = true;
            }
          } catch (error) {
            const blocked = buildFacadeResult({ status: 'blocked', summary: `WORK_HANDLE_MATERIALIZATION_FAILED: ${error instanceof Error ? error.message : String(error)}`, data: { ...facadeData, workId: facadeWorkId, executionStarted: false } });
            return result(blocked as unknown as Record<string, unknown>, true);
          }
        }
        const response = resumedControllerSession
          ? {
              ...facade,
              summary: `Controller ownership resumed for ${resumedControllerSession.workId}. ${facade.summary}`,
              data: {
                ...facadeData,
                ownershipResumed: true,
                controllerSession: resumedControllerSession,
              },
            }
          : facade;
        return result(response as unknown as Record<string, unknown>, response.status === 'blocked' || response.status === 'failed' || response.status === 'not_found');
      }
      case 'work_submit': {
        const operationArgs = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
          ? { ...(args.arguments as Record<string, unknown>) }
          : {};
        const requestedCheckoutId = typeof operationArgs.checkout_id === 'string' && operationArgs.checkout_id.trim()
          ? operationArgs.checkout_id.trim()
          : undefined;
        const repository = selected(ctx, requestedCheckoutId ? { ...args, checkout_id: requestedCheckoutId } : args);
        const requestId = String(args.request_id ?? '').trim();
        const operation = String(args.operation ?? '').trim();
        if (!requestId) throw new Error('INVALID_ARGUMENT: work_submit is missing required argument(s): request_id');
        if (!operation) throw new Error('INVALID_ARGUMENT: work_submit is missing required argument(s): operation');
        if (operation.startsWith('work_')) {
          throw new Error('WORK_OPERATION_INVALID: choose an existing durable controller operation');
        }
        if (RETIRED_AGENT_OPERATIONS.has(operation)) {
          throw new Error('AGENT_RUN_RETIRED: Kernel-managed Agent Runs are retired. Accept a WorkContract and launch an external SuperController instead.');
        }
        const definition = getMcpToolDefinition(ctx, operation);
        if (!definition) {
          throw new Error(`WORK_OPERATION_INVALID: ${operation} is unknown or not eligible for durable execution`);
        }

        const isRepositoryTool = operation.startsWith('repository_');
        const workerArgs = schemaAwareWorkSubmitArguments(
          operation,
          operationArgs,
          repository,
          definition,
          args.timeout_ms,
        );
        // Validate the target operation before any WorkContract / index write.
        validateMcpToolArguments(operation, injectDurableCommandFields(definition), workerArgs);
        delete workerArgs.request_id;
        delete workerArgs.apply_mode;
        delete workerArgs.wait;
        delete workerArgs.wait_ms;
        delete workerArgs.await_result;
        delete workerArgs.wait_for_result;

        const existingRequest = getWorkContractByRequestId(ctx.controllerHome, requestId);
        if (existingRequest && existingRequest.repoId !== repository.repoId) {
          throw new Error(`REQUEST_ID_REPO_CONFLICT: ${requestId} already belongs to repository ${existingRequest.repoId}`);
        }

        const argumentHash = hashMcpToolArguments(workerArgs);
        const semanticKey = `${isRepositoryTool ? 'repository-tool' : 'mcp-tool'}:${operation}:${repository.repoId}:${argumentHash}`;
        const claims = claimsForMcpOperation(operation, workerArgs, repository.repoId, repository.activeCheckoutId);
        const operationMetadata = operationMetadataForTool(
          operation,
          definition,
          claims,
          typeof args.timeout_ms === 'number' ? args.timeout_ms : 30_000,
          workerArgs,
          repository.defaultBranch,
        );

        const accepted = acceptSubmittedWorkContract(ctx.controllerHome, {
          requestId,
          repoId: repository.repoId,
          parentWorkId: typeof args.parent_work_id === 'string' && args.parent_work_id.trim() ? args.parent_work_id.trim() : undefined,
          semanticKey,
          operation: {
            name: operation,
            semanticKey,
            argumentHash,
            mode: operationMetadata.mode,
            idempotent: operationMetadata.idempotent,
            replayable: operationMetadata.replayable,
            resourceClaims: operationMetadata.resourceClaims.map((claim) => ({
              resourceKey: claim.resourceKey,
              mode: claim.mode,
              ...(claim.quantity !== undefined ? { quantity: claim.quantity } : {}),
            })),
          },
          objective: `Accepted operation ${operation}`,
          mode: 'direct_control',
        });

        const work = summarizeSubmittedWorkContract(accepted.contract);
        return result({
          accepted: true,
          deduplicated: accepted.deduplicated,
          operation,
          nextAction: work.nextAction,
          work,
          workContract: accepted.contract,
        });
      }
      case 'work_get': {
        const repository = selected(ctx, args);
        const workId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
        const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
        const contract = workId
          ? getWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, workId)
          : requestId
            ? getWorkContractByRequestId(ctx.controllerHome, requestId, repository.repoId)
            : undefined;
        const handleId = workId || contract?.workId || '';
        if (handleId) {
          const waited = args.wait === true || typeof args.wait_ms === 'number';
          const waitMs = typeof args.wait_ms === 'number' ? Math.max(0, args.wait_ms) : 15_000;
          const resolved = waited
            ? await waitForReadableWorkHandle(ctx.controllerHome, repository.repoId, handleId, waitMs)
            : { handle: reconcileReadableWorkHandle(ctx.controllerHome, repository.repoId, handleId), timedOut: false, waitedMs: 0 };
          if (resolved.handle) {
            const work = summarizeWorkHandle(resolved.handle, contract);
            return result({
              work,
              workHandle: resolved.handle,
              ...(contract ? {
                workContract: contract,
                continuation: buildWorkContinuationSnapshot(contract),
              } : {}),
              summary: work.summary,
              phase: work.phase,
              statusLabel: work.statusLabel,
              waited,
              timedOut: resolved.timedOut,
              waitedMs: resolved.waitedMs,
              next: work.nextAction,
            }, resolved.handle.state === 'failed');
          }
        }
        let job = resolveWorkJob(ctx, repository.repoId, args);
        if (!job) {
          if (contract) {
            const work = summarizeSubmittedWorkContract(contract);
            const waited = args.wait === true || typeof args.wait_ms === 'number';
            const terminal = contract.status === 'completed' || contract.status === 'failed' || contract.status === 'cancelled';
            return result({
              work,
              workContract: contract,
              continuation: buildWorkContinuationSnapshot(contract),
              summary: work.summary,
              phase: work.phase,
              statusLabel: work.statusLabel,
              waited,
              timedOut: waited ? !terminal : false,
              waitedMs: waited && typeof args.wait_ms === 'number' ? args.wait_ms : 0,
              next: work.nextAction,
            });
          }
          return result({ error: { code: 'WORK_NOT_FOUND', message: 'No Work matched this repository and identifier.', errorClass: 'not_found', summary: '未找到对应任务。' } }, true);
        }
        let timedOut = false;
        let waitedMs = 0;
        if (args.wait === true) {
          const waited = await waitForExecutionJob({
            controllerHome: ctx.controllerHome,
            repoId: repository.repoId,
            jobId: job.jobId,
            timeoutMs: typeof args.wait_ms === 'number' ? args.wait_ms : 15_000,
          });
          job = waited.job;
          timedOut = waited.timedOut;
          waitedMs = waited.waitedMs;
        }
        const digest = buildJobOperationDigest(job, { waited: args.wait === true, stillRunning: timedOut });
        return result({
          work: summarizeWork(job, repository.canonicalRoot),
          digest,
          summary: digest.summary,
          phase: digest.phase,
          statusLabel: digest.statusLabel,
          errorClass: digest.errorClass,
          errorMessage: digest.errorMessage,
          waited: args.wait === true || typeof args.wait_ms === 'number',
          timedOut,
          waitedMs,
          ...(args.include_events === true ? { events: summarizeJobEvents(ctx.controllerHome, job.repoId, job.jobId) } : {}),
        }, digest.phase === 'failed' || digest.phase === 'timed_out');
      }
      case 'work_wait': {
        const repository = selected(ctx, args);
        const waitMs = typeof args.wait_ms === 'number' ? Math.max(0, args.wait_ms) : 15_000;
        const workId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
        const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
        const contract = workId
          ? getWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, workId)
          : requestId
            ? getWorkContractByRequestId(ctx.controllerHome, requestId, repository.repoId)
            : undefined;
        const handleId = workId || contract?.workId || '';
        if (handleId) {
          const resolved = await waitForReadableWorkHandle(ctx.controllerHome, repository.repoId, handleId, waitMs);
          if (resolved.handle) {
            const work = summarizeWorkHandle(resolved.handle, contract);
            return result({
              work,
              workHandle: resolved.handle,
              ...(contract ? {
                workContract: contract,
                continuation: buildWorkContinuationSnapshot(contract),
              } : {}),
              summary: work.summary,
              phase: work.phase,
              statusLabel: work.statusLabel,
              waited: true,
              timedOut: resolved.timedOut,
              waitedMs: resolved.waitedMs,
              next: work.nextAction,
            }, resolved.handle.state === 'failed');
          }
        }
        const job = resolveWorkJob(ctx, repository.repoId, args);
        if (!job) {
          const processRef = String(args.work_id ?? args.request_id ?? '').trim();
          const process = getRepositoryCommandProcess(ctx.controllerHome, repository.repoId, processRef);
          if (!process) return result({ error: { code: 'WORK_NOT_FOUND', message: 'No Work or managed process matched this repository and identifier.', errorClass: 'not_found', summary: '未找到对应任务。' } }, true);
          const waitedProcess = await waitRepositoryCommandProcess(ctx.controllerHome, repository.repoId, processRef, { timeoutMs: waitMs });
          const digest = managedProcessOperationDigest(waitedProcess);
          return result({
            work: { kind: 'managed_process', processId: processRef },
            digest,
            summary: digest.summary,
            phase: digest.phase,
            suggestedNextActions: digest.suggestedNextActions,
            waited: true,
            timedOut: waitedProcess.completed !== true,
            waitedMs: waitMs,
          }, digest.phase === 'failed' || digest.phase === 'timed_out');
        }
        const waited = await waitForExecutionJob({
          controllerHome: ctx.controllerHome,
          repoId: repository.repoId,
          jobId: job.jobId,
          timeoutMs: waitMs,
        });
        const digest = buildJobOperationDigest(waited.job, { waited: true, stillRunning: waited.timedOut });
        return result({
          work: summarizeWork(waited.job, repository.canonicalRoot),
          digest,
          summary: digest.summary,
          phase: digest.phase,
          statusLabel: digest.statusLabel,
          errorClass: digest.errorClass,
          errorMessage: digest.errorMessage,
          changedFiles: digest.changedFiles,
          suggestedNextActions: digest.suggestedNextActions,
          waited: true,
          timedOut: waited.timedOut,
          waitedMs: waited.waitedMs,
        }, digest.phase === 'failed' || digest.phase === 'timed_out');
      }
      case 'work_list': {
        const repository = selected(ctx, args);
        const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(Math.trunc(args.limit), 100)) : 50;
        const jobs = listExecutionJobs(ctx.controllerHome, repository.repoId, limit).map(summarizeWorkListItem);
        const contracts = listWorkContracts({
          controllerHome: ctx.controllerHome,
          repoId: repository.repoId,
          status: 'all',
          limit,
        }).map(summarizeWorkContractListItem);
        const works = [...jobs, ...contracts]
          .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
          .slice(0, limit);
        return result({ detailLevel: 'summary', works, next: 'Call work_get for bounded details.' });
      }
      case 'work_cancel': {
        const repository = selected(ctx, args);
        const job = resolveWorkJob(ctx, repository.repoId, args);
        if (!job) return result({ error: { code: 'WORK_NOT_FOUND', message: 'No Work matched this repository and identifier.', errorClass: 'not_found', summary: '未找到对应任务。' } }, true);
        const cancelled = await cancelExecutionJob(
          ctx.controllerHome,
          repository.repoId,
          job.jobId,
          typeof args.reason === 'string' ? args.reason : undefined,
        );
        const digest = buildJobOperationDigest(cancelled);
        return result({ work: summarizeWork(cancelled, repository.canonicalRoot), digest, summary: digest.summary, phase: digest.phase });
      }
      case 'git_diff_paths': {
        const repository = selected(ctx, args);
        return result({
          ...selectedPathDiff(repository, {
            paths: args.paths,
            staged: args.staged === true,
            maxBytes: typeof args.max_bytes === 'number' ? args.max_bytes : undefined,
          }),
        });
      }
      case 'git_stage_paths': {
        const repository = selected(ctx, args);
        const staged = stageSelectedPaths(ctx.controllerHome, repository, { paths: args.paths });
        return result({
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          ...staged,
        }, staged.execution.ok !== true);
      }
      case 'git_commit_paths': {
        const repository = selected(ctx, args);
        const committed = commitSelectedPaths(ctx.controllerHome, repository, {
          paths: args.paths,
          message: args.message,
        });
        const directEditWorkCompletion = !committed.error && committed.commit?.ok === true
          ? reconcileFinalizedDirectEditWorksAfterCommit({
              controllerHome: ctx.controllerHome,
              repoId: repository.repoId,
              checkoutId: repository.activeCheckoutId,
              repoRoot: repository.canonicalRoot,
              committedPaths: committed.paths,
              fallbackBranch: repository.defaultBranch || 'main',
            })
          : undefined;
        return result({
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          ...committed,
          ...(directEditWorkCompletion ? { directEditWorkCompletion } : {}),
        }, Boolean(committed.error));
      }
      case 'prepare_transfer_artifacts': {
        const repository = selected(ctx, args);
        const transfer = prepareTransferArtifacts(repository, { reason: args.reason });
        const taskLedger = writeControllerTaskLedgerArtifacts(repository.canonicalRoot, { reason: args.reason });
        return result({
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          ...transfer,
          taskLedger: taskLedger.projection,
          artifacts: [
            ...transfer.artifacts,
            ...taskLedger.artifacts,
          ],
        });
      }

      case 'schedule_dedupe_report': {
        const repository = selected(ctx, args);
        return result({ report: buildScheduleDedupeReport(ctx.controllerHome, repository.repoId) });
      }
      case 'schedule_dedupe_apply': {
        const repository = selected(ctx, args);
        return result({ dedupe: applyScheduleDedupe(ctx.controllerHome, repository.repoId, { dryRun: args.dry_run, confirmAuthorization: args.confirm_authorization }) });
      }
      case 'local_bridge_status': {
        const repository = selected(ctx, args);
        const detailLevel = args.detail_level === 'detail' || args.detail === true ? 'detail' : 'summary';
        const surface = resolveLocalBridgeSurface({
          controllerHome: ctx.controllerHome,
          repoRoot: repository.canonicalRoot,
          // Process scan is expensive; only for detail or missing runtime state.
          allowProcessScan: detailLevel === 'detail',
        });
        const endpoint = surface.endpoint;
        const shouldProbe = surface.enabled
          && surface.endpointConfigured
          && Boolean(endpoint)
          && surface.mode !== 'disabled';
        const liveHealth = shouldProbe ? await probeLocalControllerHealth(endpoint) : null;
        const endpointReachable = liveHealth !== null;
        const expectedSurface = shouldProbe
          ? localControllerDiagnosticMatchesRuntime(liveHealth, {
            generation: surface.generation,
          })
          : false;
        const processAlive = surface.processRunning;
        const projectionSnapshot = readRepositoryProjectionSnapshot(ctx.controllerHome, repository.repoId);
        const daemon = readForgeRuntimeStatus(ctx.controllerHome);
        const scheduler = readSchedulerHealthSnapshot(ctx.controllerHome);
        const schedulerHeartbeatAgeMs = ageMs(scheduler.lastTickAt);
        const schedulerDispatchHeartbeatAgeMs = ageMs(scheduler.lastDispatchAt);
        const runtimeStorage = ensureRepositoryRuntimeStorage(repository, ctx.controllerHome);
        const health = evaluateRuntimeHealth({
          daemon: {
            status: daemon.status,
            error: daemon.error,
            heartbeatAgeMs: schedulerHeartbeatAgeMs,
          },
          scheduler: {
            status: daemon.degraded ? 'degraded' : daemon.status,
            heartbeatAgeMs: schedulerHeartbeatAgeMs,
            dispatchHeartbeatAgeMs: schedulerDispatchHeartbeatAgeMs,
          },
          workers: {
            queueDepth: projectionSnapshot.projection.queueDepth,
            runningWorkers: projectionSnapshot.projection.runningWorkers,
            activeLeases: projectionSnapshot.projection.activeLeases,
            activeAttentionCount: projectionSnapshot.projection.currentAttention.length,
          },
          projection: projectionObservation(projectionSnapshot),
          localBridge: {
            enabled: surface.enabled,
            requiredForReadiness: surface.requiredForReadiness,
            mode: surface.mode,
            endpoint,
            // When endpoint is not configured (disabled/unknown), treat as non-issue.
            endpointReachable: shouldProbe ? endpointReachable : true,
            expectedSurface: shouldProbe ? expectedSurface : true,
            processAlive,
            runtimeStateFresh: surface.source === 'service-runtime' || surface.source === 'repo-runtime',
            error: surface.error,
          },
          runtimeStorage: {
            readable: true,
            ready: runtimeStorage.readyForExecution,
            warnings: runtimeStorage.warnings,
          },
        });
        const jobs = listLocalBridgeJobSnapshots(repository.canonicalRoot, detailLevel === 'detail' ? 12 : 20);
        const { activeJobCount, recentJobSummary } = summarizeRecentJobs(jobs);
        const running = surface.enabled
          && health.components.localBridge.ready
          && (!shouldProbe || (endpointReachable && expectedSurface));
        // Historical job counts are operational stats, not current readiness blockers.
        const bridgeWarnings = health.components.localBridge.warnings
          .filter((warning) => warning.code !== 'LOCAL_BRIDGE_ENDPOINT_UNAVAILABLE'
            || surface.requiredForReadiness
            || shouldProbe)
          .map((warning) => ({ code: warning.code, message: warning.message }));

        if (detailLevel === 'summary') {
          return result({
            localBridgeSummary: true,
            omitEnvelope: true,
            detailLevel: 'summary',
            repoId: repository.repoId,
            running,
            ready: health.components.localBridge.ready,
            mode: surface.mode,
            endpoint: endpoint ?? null,
            endpointConfigured: surface.endpointConfigured,
            endpointReachable: shouldProbe ? endpointReachable : null,
            processRunning: processAlive ?? null,
            expectedSurface: surface.expectedSurface,
            requiredForReadiness: surface.requiredForReadiness,
            warnings: bridgeWarnings,
            activeJobCount,
            recentJobSummary,
            statusSource: surface.source,
            nonBlocking: !surface.requiredForReadiness,
          });
        }

        return result({
          detailLevel: 'detail',
          endpoint: endpoint ?? null,
          endpointConfigured: surface.endpointConfigured,
          running,
          capability: {
            enabled: surface.enabled,
            requiredForReadiness: surface.requiredForReadiness,
            mode: surface.mode,
            ready: health.components.localBridge.ready,
            endpointReachable: shouldProbe ? endpointReachable : null,
            expectedSurface: shouldProbe ? expectedSurface : null,
            observedAt: new Date().toISOString(),
            owner: {
              kind: surface.ownerKind,
              ...(surface.pid ? { pid: surface.pid } : {}),
            },
            evidence: {
              endpointReachable: shouldProbe ? endpointReachable : null,
              expectedSurface: shouldProbe ? expectedSurface : null,
              ...(processAlive !== undefined ? { processAlive } : {}),
              runtimeStateFresh: surface.source === 'service-runtime' || surface.source === 'repo-runtime',
              observedAt: new Date().toISOString(),
            },
          },
          health: {
            ready: health.ready,
            // Do not elevate historical job failures into active blockers.
            activeBlockers: health.activeBlockers,
            warnings: health.warnings,
          },
          error: surface.error,
          statusSource: surface.source,
          counts: recentJobSummary,
          activeJobCount,
          recentJobSummary,
          approvalQueue: false,
          reconciliation: { scanned: jobs.length, active: activeJobCount, terminalized: 0, deferredToController: true },
          recentJobs: jobs.map((job) => ({
            jobId: job.jobId,
            action: job.action,
            status: job.status,
            checkId: job.action === 'run-check' ? (job.payload as { checkId?: string }).checkId : undefined,
            runId: job.runId,
            issueId: job.issueId,
            taskId: job.taskId,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            finishedAt: job.finishedAt,
            revision: job.revision,
            deadlineAt: job.deadlineAt,
            error: job.error?.slice(0, 300),
          })),
          fallback: 'Open the localhost Local Controller to launch work or inspect execution when a ChatGPT write action is unavailable.',
          repoId: repository.repoId,
          repository: repositorySummary(repository),
          runtimeStorage,
          nonBlocking: !surface.requiredForReadiness,
        });
      }
      case 'get_local_job': {
        const repository = selected(ctx, args);
        const jobId = String(args.job_id ?? '').trim();
        const job = getLocalBridgeJobSnapshot(repository.canonicalRoot, jobId);
        return result({
          job: job.job,
          lookup: job.status === 'ok' ? undefined : job,
          ...(args.include_events === true && job.status === 'ok'
            ? { events: getLocalBridgeJobEventsSnapshot(repository.canonicalRoot, jobId) }
            : {}),
          ...(args.include_output === true ? { output: readLocalBridgeJobOutputSnapshot(repository.canonicalRoot, jobId, {
            stream: args.stream === 'stderr' ? 'stderr' : 'stdout',
            maxBytes: typeof args.max_bytes === 'number' ? args.max_bytes : undefined,
          }) } : {}),
          repoId: repository.repoId,
          repository: repositorySummary(repository),
          runtimeStorage: ensureRepositoryRuntimeStorage(repository, ctx.controllerHome),
          nonBlocking: true,
        });
      }
      case 'get_local_job_output': {
        const repository = selected(ctx, args);
        const jobId = String(args.job_id ?? '').trim();
        return result({
          ...readLocalBridgeJobOutputSnapshot(repository.canonicalRoot, jobId, {
            stream: args.stream === 'stderr' ? 'stderr' : 'stdout',
            maxBytes: typeof args.max_bytes === 'number' ? args.max_bytes : undefined,
          }),
          repoId: repository.repoId,
          repository: repositorySummary(repository),
          runtimeStorage: ensureRepositoryRuntimeStorage(repository, ctx.controllerHome),
          nonBlocking: true,
        });
      }
      case 'controller_context': {
        const responseStartedAt = performance.now();
        const phaseTimingsMs: Record<string, number> = {};
        const markPhase = (name: string, startedAt: number): void => {
          phaseTimingsMs[name] = Math.round((performance.now() - startedAt) * 100) / 100;
        };
        const repositoryStartedAt = performance.now();
        const repository = selected(ctx, args);
        const recommendedExecution = controllerContextAssessment(args);
        const modeContextPack = recommendedExecution.modeBehavior.structuralContext === 'required'
          ? buildControllerContextPack(repository.canonicalRoot, ctx.policy, {
              description: typeof args.description === 'string' ? args.description : undefined,
              knownPaths: stringList(args.known_paths),
              structuralContext: 'required',
              maxFiles: 8,
              maxSnippets: 20,
              session: ctx.sessionId?.trim()
                ? { sessionId: ctx.sessionId.trim(), repoId: repository.repoId, checkoutId: repository.activeCheckoutId }
                : undefined,
            })
          : undefined;
        markPhase('repositoryRouting', repositoryStartedAt);
        const variant = args.detail_level === 'detail' ? 'detail' as const : 'summary' as const;
        const runtimeRoot = repositoryControllerRoot(ctx.controllerHome, repository.repoId);
        const runtimeStorage = {
          repoId: repository.repoId,
          controllerRoot: runtimeRoot,
          readyForExecution: existsSync(runtimeRoot),
          readOnly: true,
        };
        const runtimeSnapshot = readRepositoryProjectionSnapshot(ctx.controllerHome, repository.repoId);
        const runtimeProjection = runtimeSnapshot.projection;
        const contextSourceRevision = String(runtimeProjection.metadata?.contentRevision ?? runtimeProjection.revision);
        // Git identity is sampled at most once per TTL per repository; hot reads
        // reuse the sampled HEAD/fingerprint instead of spawning subprocesses.
        const gitIdentityStartedAt = performance.now();
        const gitIdentity = cachedGitIdentity(repository.canonicalRoot);
        markPhase('gitIdentity', gitIdentityStartedAt);
        const invalidationStartedAt = performance.now();
        const contextInvalidation = readControllerContextProjectionInvalidation(repository.canonicalRoot);
        markPhase('invalidation', invalidationStartedAt);
        const sourceIdentity = {
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          canonicalRoot: repository.canonicalRoot,
          head: gitIdentity.head,
          branch: gitIdentity.branch,
          workingTreeFingerprint: gitIdentity.workingTreeFingerprint,
          runtimeGeneration: runtimeProjection.metadata?.producerGeneration,
          sourceRevision: contextSourceRevision,
          variant,
          toolset: ctx.toolset,
          profile: ctx.policy.profile,
        };
        markPhase('identity', repositoryStartedAt);
        const cacheStartedAt = performance.now();
        const cached = readControllerContextProjection(ctx.controllerHome, repository.repoId, {
          sourceIdentity,
        });
        const projectionAgeMs = controllerContextProjectionAgeMs(cached);
        markPhase('cacheRead', cacheStartedAt);
        const cachedPayload = cached?.payload;
        const cachedProjectionIncomplete = !cachedPayload
          || typeof cachedPayload !== 'object'
          || !('repoId' in cachedPayload)
          || !('runtimeProjectionState' in cachedPayload)
          || !('controllerReady' in cachedPayload);
        const invalidatedAfterBuild = Boolean(
          cached
          && contextInvalidation
          && cached.invalidationNonce !== contextInvalidation.nonce,
        );
        // The materialized-view stale flag is reported, not acted on: a view
        // that is stale-but-unchanged (daemon down) would otherwise force an
        // endless rebuild of an already-current context projection. Context
        // freshness tracks its own source identity, the view revision, and the
        // invalidation marker.
        const cacheStale = controllerContextProjectionNeedsRefresh(cached, contextSourceRevision, sourceIdentity)
          || invalidatedAfterBuild
          || !Number.isFinite(projectionAgeMs)
          || projectionAgeMs >= CONTROLLER_CONTEXT_PROJECTION_REFRESH_MS;
        const projectionPayload = (
          projectionRecord: typeof cached,
          stale: boolean,
          refreshJobId?: string,
        ): Record<string, unknown> => {
          const ageMs = controllerContextProjectionAgeMs(projectionRecord);
          return {
            contextProjection: {
              variant,
              generatedAt: projectionRecord?.generatedAt,
              ageMs: Number.isFinite(ageMs) ? ageMs : undefined,
              stale,
              healthImpact: false,
              sourceIdentity: projectionRecord?.sourceIdentity ?? sourceIdentity,
              projectionGeneration: projectionRecord?.projectionGeneration ?? controllerContextProjectionGeneration(sourceIdentity),
              refreshState: projectionRecord?.refreshState ?? 'idle',
              lastRefreshError: projectionRecord?.lastRefreshError,
              nextAttemptAt: projectionRecord?.nextAttemptAt,
              sourceRevision: projectionRecord?.sourceRevision ?? contextSourceRevision,
              strategy: 'event-driven-swr',
              refreshJobId,
              readOnly: true,
              nonBlocking: true,
            },
          };
        };

        const responseOptions = {
          phaseTimingsMs,
          transport: 'runtime-local',
          sessionId: ctx.sessionId,
          routing: { repoId: repository.repoId, checkoutId: repository.activeCheckoutId },
        };
        const respondWith = (
          payload: Record<string, unknown>,
          projectionRecord: typeof cached,
          input: { cacheHit: boolean; stale: boolean; refreshJobId?: string },
        ): CallToolResult => {
          const { modeContextPack: _cachedModeContextPack, ...basePayload } = payload;
          const taskScopedPayload = {
            ...basePayload,
            ...(basePayload.detailLevel === 'summary' ? {
              execution: {
                ...contextRecord(basePayload.execution),
                recommendedMode: recommendedExecution.recommendedMode,
                executionPath: recommendedExecution.executionPath,
              },
            } : {}),
            recommendedExecution,
            ...(modeContextPack ? { modeContextPack } : {}),
          };
          if (!controllerContextProjectionPayloadMatchesSourceIdentity(taskScopedPayload, sourceIdentity)) {
            const response = withRuntimeResponseMeta({
              error: {
                code: 'CONTEXT_PROJECTION_SOURCE_MISMATCH',
                message: 'Refusing controller context whose payload identity differs from the selected repository checkout.',
                errorClass: 'infrastructure_failure',
                summary: 'Controller context identity validation failed closed.',
              },
              ...projectionPayload(projectionRecord, true, input.refreshJobId),
            }, responseStartedAt, { ...responseOptions, cacheHit: input.cacheHit, stale: true, refreshJobId: input.refreshJobId });
            const responseBytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
            recordControllerContextRead({
              durationMs: performance.now() - responseStartedAt,
              cacheHit: input.cacheHit,
              stale: true,
              responseBytes,
              phaseDurationsMs: phaseTimingsMs,
            });
            return result(response, true);
          }
          const response = withRuntimeResponseMeta({
            ...taskScopedPayload,
            ...projectionPayload(projectionRecord, input.stale, input.refreshJobId),
          }, responseStartedAt, { ...responseOptions, cacheHit: input.cacheHit, stale: input.stale, refreshJobId: input.refreshJobId });
          const responseBytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
          recordControllerContextRead({
            durationMs: performance.now() - responseStartedAt,
            cacheHit: input.cacheHit,
            stale: input.stale,
            responseBytes,
            phaseDurationsMs: phaseTimingsMs,
          });
          return result(response);
        };
        if (variant === 'summary' && cached && !cachedProjectionIncomplete && !cacheStale) {
          return respondWith(compactControllerContextSummaryPayload(cached.payload), cached, { cacheHit: true, stale: false });
        }

        const buildStartedAt = performance.now();
        const buildPayload = async (): Promise<Record<string, unknown>> => {
          const readiness = await controllerReadiness(ctx, repository);
          const activeCheckout = repository.checkouts.find((checkout) => checkout.checkoutId === repository.activeCheckoutId);
          const liveGit = gitSnapshot(repository.canonicalRoot);
          const board = legacyIssueAuthorityRetired(repository.canonicalRoot)
            ? undefined
            : projectBoard(repository.canonicalRoot);
          const taskLedger = buildControllerTaskLedgerProjection(repository.canonicalRoot, board);
          const operationalPlan = buildControllerOperationalPlan(repository.canonicalRoot, taskLedger);
          const currentIssueRecord = board?.currentIssueId
            ? board.issues.find((issue) => issue.id === board.currentIssueId)
            : undefined;
          const currentIssue = currentIssueRecord ? {
            id: currentIssueRecord.id,
            title: currentIssueRecord.title,
            status: currentIssueRecord.status,
            lifecycleStatus: currentIssueRecord.lifecycleStatus,
            updatedAt: currentIssueRecord.updatedAt,
            tasks: Array.isArray(currentIssueRecord.tasks)
              ? currentIssueRecord.tasks.slice(0, 20).map((task) => {
                const item = task as Record<string, unknown>;
                return {
                  id: item.id,
                  title: item.title,
                  effectiveStatus: item.effectiveStatus,
                  latestRunStatus: item.latestRunStatus,
                };
              })
              : [],
          } : undefined;
          const activeRuns = listActiveAgentJobSnapshots(repository.canonicalRoot, 20).map((run) => ({
            runId: run.runId,
            issueId: run.issueId,
            taskId: run.taskId,
            status: run.status,
            agent: run.agent,
            provider: run.provider,
            executionMode: run.executionMode,
            progress: run.progress,
            lastHeartbeatAt: run.lastHeartbeatAt,
            error: run.error,
          }));
          const localJobs = listLocalBridgeJobSnapshots(repository.canonicalRoot, 12);
          const activeLocalJobs = localJobs.filter((job) => ['approved', 'running', 'dispatched'].includes(job.status)).length;
          const recentLocalJobs = localJobs.map((job) => ({
            jobId: job.jobId,
            action: job.action,
            status: job.status,
            runId: job.runId,
            issueId: job.issueId,
            taskId: job.taskId,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            finishedAt: job.finishedAt,
            error: job.error?.slice(0, 300),
          }));
          const checks = listControllerChecks(repository.canonicalRoot).map((check) => {
            const evidence = readLatestControllerCheckEvidence(repository.canonicalRoot, check.id);
            return {
              id: check.id,
              description: check.description,
              timeoutMs: check.timeoutMs,
              source: check.source,
              ...(evidence ? { lastFailureAt: evidence.ok ? undefined : evidence.executedAt, failed: !evidence.ok } : {}),
            };
          });
          const plugins = listAssistantPluginManifests(ctx.controllerHome, repository, {
            preferStored: true,
          }).map((plugin) => ({
            pluginId: plugin.pluginId,
            provider: plugin.provider,
            enabled: plugin.enabled,
            revision: plugin.revision,
            lifecycle: plugin.lifecycle,
            health: plugin.health,
            actionCount: plugin.actions.length,
            actions: plugin.actions.map((action) => ({
              actionId: action.actionId,
              readOnly: action.readOnly,
              risk: action.risk,
              confirmation: action.confirmation,
            })),
          }));
          return {
            git: liveGit.branch || liveGit.head || liveGit.status || liveGit.diffStat ? liveGit : {
              branch: activeCheckout?.branch ?? sourceIdentity.branch ?? null,
              head: sourceIdentity.head ?? null,
              status: 'No live repository scan is available; showing bounded runtime state only.',
              diffStat: '',
              dirty: false,
            },
            currentIssueId: board?.currentIssueId ?? taskLedger.currentIssueId,
            currentIssue,
            taskLedger,
            taskLedgerStatus: taskLedger.status,
            operationalPlan,
            readyTasks: (board?.readyTasks ?? taskLedger.readyTasks).slice(0, 20),
            activeRuns,
            activeJobCount: activeLocalJobs,
            localBridge: {
              reconciliation: { scanned: localJobs.length, active: activeLocalJobs, terminalized: 0 },
              recentJobs: recentLocalJobs,
            },
            plugins,
            checks,
            repoId: repository.repoId,
            repository: repositorySummary(repository),
            runtimeStorage,
            recommendedExecution,
            ...(modeContextPack ? { modeContextPack } : {}),
            runtimeProjection,
            runtimeProjectionState: {
              stale: runtimeSnapshot.stale,
              persisted: runtimeSnapshot.persisted,
            },
            controllerReady: readiness,
            runtimeIdentity: runtimeIdentitySnapshot(ctx),
          };
        };

        if (variant === 'summary' && cached && !cachedProjectionIncomplete) {
          const refresh = queueControllerContextProjectionRefresh(ctx.controllerHome, repository.repoId, {
            variant,
            sourceIdentity,
            projectionGeneration: controllerContextProjectionGeneration(sourceIdentity),
            invalidationNonce: contextInvalidation?.nonce,
            build: buildPayload,
          });
          markPhase('refreshQueue', buildStartedAt);
          const refreshing = readControllerContextProjection(ctx.controllerHome, repository.repoId, {
            sourceIdentity,
          });
          return respondWith(compactControllerContextSummaryPayload(cached.payload), refreshing ?? cached, {
            cacheHit: true,
            stale: true,
            refreshJobId: refresh.refreshJobId,
          });
        }

        const payload = await buildPayload();
        const persistedPayload = variant === 'summary'
          ? compactControllerContextSummaryPayload(payload)
          : payload;
        markPhase('build', buildStartedAt);
        let projectionRecord: typeof cached;
        try {
          projectionRecord = writeControllerContextProjection(ctx.controllerHome, repository.repoId, persistedPayload, {
            sourceRevision: contextSourceRevision,
            contentFingerprint: runtimeProjection.metadata?.contentFingerprint,
            invalidationNonce: contextInvalidation?.nonce,
            sourceIdentity,
            variant,
            projectionGeneration: controllerContextProjectionGeneration(sourceIdentity),
            refreshState: 'idle',
          });
        } catch {
          projectionRecord = cached;
        }
        markPhase('serialize', performance.now());
        return respondWith(persistedPayload, projectionRecord, {
          cacheHit: false,
          stale: controllerContextProjectionNeedsRefresh(projectionRecord, contextSourceRevision, sourceIdentity),
        });
      }

      case 'get_job': {
        const jobId = String(args.job_id ?? '').trim();
        let job = typeof args.repo_id === 'string' ? getExecutionJob(ctx.controllerHome, args.repo_id, jobId) : findExecutionJob(ctx.controllerHome, jobId);
        if (!job) return result({ error: { code: 'JOB_NOT_FOUND', message: jobId || 'missing job_id', errorClass: 'not_found', summary: '未找到对应 Job。' } }, true);
        let timedOut = false;
        let waitedMs = 0;
        if (args.wait === true || typeof args.wait_ms === 'number') {
          const waited = await waitForExecutionJob({
            controllerHome: ctx.controllerHome,
            repoId: job.repoId,
            jobId: job.jobId,
            timeoutMs: typeof args.wait_ms === 'number' ? args.wait_ms : 15_000,
          });
          job = waited.job;
          timedOut = waited.timedOut;
          waitedMs = waited.waitedMs;
        }
        const full = args.detail_level === 'full';
        const repoRoot = repositoryRootForRepoId(ctx.controllerHome, job.repoId);
        // summarizeExecutionJob already embeds a compact digest + single suggestedNextActions list.
        const jobSummary = summarizeExecutionJob(job, repoRoot);
        return result({
          detailLevel: 'summary',
          requestedDetailLevel: full ? 'full' : 'summary',
          job: jobSummary,
          summary: jobSummary.summary,
          phase: jobSummary.phase,
          statusLabel: jobSummary.statusLabel,
          errorClass: jobSummary.errorClass,
          errorMessage: jobSummary.errorMessage,
          changedFiles: jobSummary.changedFiles,
          suggestedNextActions: jobSummary.suggestedNextActions,
          artifactRefs: jobSummary.artifactRefs,
          evidenceIds: jobSummary.evidenceIds,
          evidenceRefs: jobSummary.evidenceRefs,
          waited: args.wait === true || typeof args.wait_ms === 'number',
          timedOut,
          waitedMs,
          ...(args.include_events === true
            ? { events: summarizeJobEvents(ctx.controllerHome, job.repoId, job.jobId) }
            : {}),
          next: full
            ? 'Raw job state is intentionally not returned through MCP. Use the bounded job summary, events, and get_artifact with artifactId (ART-...), not evidenceId (EVD-...).'
            : jobSummary.terminal
              ? String(jobSummary.summary ?? '')
              : 'Job is still active. Poll get_job without waiting, or use work_wait only when blocking is explicitly required.',
        }, jobSummary.phase === 'failed' || jobSummary.phase === 'timed_out');
      }
      case 'repository_change_verify': {
        const repository = selected(ctx, args);
        const expectedFileShas = args.expected_file_shas && typeof args.expected_file_shas === 'object' && !Array.isArray(args.expected_file_shas)
          ? Object.fromEntries(
            Object.entries(args.expected_file_shas as Record<string, unknown>)
              .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
          )
          : undefined;
        const payload = repositoryChangeVerify({
          repo: repository.canonicalRoot,
          expectedBranch: typeof args.expected_branch === 'string' ? args.expected_branch : undefined,
          expectedHead: typeof args.expected_head === 'string' ? args.expected_head : undefined,
          expectedFileShas,
          patch: typeof args.patch === 'string' ? args.patch : undefined,
          allowedPaths: Array.isArray(args.allowed_paths)
            ? args.allowed_paths.filter((value): value is string => typeof value === 'string')
            : undefined,
          checks: Array.isArray(args.checks)
            ? args.checks.filter((value): value is string => typeof value === 'string')
            : undefined,
          checkTimeoutMs: typeof args.check_timeout_ms === 'number' ? args.check_timeout_ms : undefined,
        });
        return result(payload as unknown as Record<string, unknown>, payload.status === 'failed');
      }
      case 'get_artifact': {
        const artifactId = String(args.artifact_id ?? '').trim();
        const artifactRepoId = String(args.repo_id ?? '').trim();
        if (artifactId.startsWith('EVD-')) {
          const evidence = readExecutionEvidence(ctx.controllerHome, artifactRepoId, artifactId);
          return result({
            referenceType: 'evidence',
            evidenceId: evidence.evidenceId,
            repoId: evidence.repoId,
            jobId: evidence.jobId,
            outcome: evidence.outcome,
            operation: evidence.operation,
            revision: evidence.revision,
            executedAt: evidence.executedAt,
            note: 'This is an evidenceId (EVD-...), not an artifactId (ART-...). Evidence holds audit metadata; command output lives under artifactRefs/artifactId.',
            next: `For output content, call get_job with job_id=${evidence.jobId} and use artifactRefs.artifactId, then get_artifact with that ART-... id.`,
          });
        }
        if (!artifactId.startsWith('ART-') && artifactId) {
          return result({
            error: {
              code: 'ARTIFACT_ID_EXPECTED',
              message: `Expected artifactId starting with ART- (got ${artifactId.slice(0, 40)}). evidenceId (EVD-...) is audit metadata; use get_job artifactRefs for content.`,
            },
            referenceType: 'unknown',
            next: 'Call get_job, read artifactRefs[].artifactId (ART-...), then get_artifact with that id and repo_id.',
          }, true);
        }
        const maxBytes = typeof args.max_bytes === 'number' ? args.max_bytes : 64 * 1024;
        const loaded = readExecutionArtifact(ctx.controllerHome, artifactRepoId, artifactId, maxBytes);
        // Do not re-attach controller/repository/runtime envelopes here; multi-repo layer already compact.
        return result({
          referenceType: 'artifact',
          artifactId: loaded.artifact.artifactId,
          artifactKind: loaded.artifact.kind,
          repoId: loaded.artifact.repoId,
          jobId: loaded.artifact.jobId,
          byteLength: loaded.artifact.byteLength,
          mediaType: loaded.artifact.mediaType,
          truncated: loaded.truncated,
          content: loaded.content,
          next: loaded.truncated
            ? `Artifact truncated at ${maxBytes} bytes. Re-call get_artifact with a larger max_bytes (up to 512KB) or page via result refs.`
            : 'Artifact content loaded.',
        });
      }
      case 'list_jobs': {
        const repository = selected(ctx, args);
        const requestedLimit = typeof args.limit === 'number' ? Math.trunc(args.limit) : 100;
        const limit = Math.max(1, Math.min(requestedLimit, 100));
        const jobs = listExecutionJobs(ctx.controllerHome, repository.repoId, limit);
        const full = args.detail_level === 'full';
        return result({
          detailLevel: 'summary',
          requestedDetailLevel: full ? 'full' : 'summary',
          limit,
          jobs: jobs.map((job) => summarizeExecutionJob(job, repository.canonicalRoot)),
          next: 'Call get_job with one job_id for bounded details; raw job state is intentionally not returned through MCP.',
        });
      }
      case 'cancel_job': {
        const jobId = String(args.job_id ?? '').trim();
        const job = typeof args.repo_id === 'string' ? getExecutionJob(ctx.controllerHome, args.repo_id, jobId) : findExecutionJob(ctx.controllerHome, jobId);
        if (!job) return result({ error: { code: 'JOB_NOT_FOUND', message: jobId } }, true);
        const cancelled = await cancelExecutionJob(ctx.controllerHome, job.repoId, job.jobId, typeof args.reason === 'string' ? args.reason : undefined);
        const repoRoot = repositoryRootForRepoId(ctx.controllerHome, cancelled.repoId);
        return result({ job: summarizeExecutionJob(cancelled, repoRoot) });
      }
      case 'controller_ready': {
        const explicitRepoId = typeof args.repo_id === 'string' && args.repo_id.trim() ? args.repo_id.trim() : undefined;
        const registered = listRepositories(ctx.controllerHome).filter((repository) => repository.enabled && !repository.removedAt);
        const repository = explicitRepoId
          ? selected(ctx, args)
          : (ctx.explicitRepository ?? (registered.length === 1 ? registered[0] : undefined));
        const readiness = await controllerReadiness(ctx, repository);
        const toolset = await import('../../../cli/mcp/toolset');
        const exposure = toolset.controllerExposureSnapshot(ctx);
        const toolSurfaceReady = exposure.ready && exposure.missingToolNames.length === 0;
        const reasonCodes = new Set(readiness.reasonCodes);
        if (!toolSurfaceReady) reasonCodes.add('MCP_TOOL_SURFACE_INCOMPLETE');
        const mcpReady = readiness.diagnostics.mcpEndToEnd.ready && toolSurfaceReady;
        const ready = readiness.ready && mcpReady;
        const payload = {
          ready,
          reasonCodes: [...reasonCodes],
          diagnostics: {
            ...readiness.diagnostics,
            mcpEndToEnd: {
              ready: mcpReady,
              evidence: {
                ...readiness.diagnostics.mcpEndToEnd.evidence,
                expectedToolCount: exposure.expectedToolNames.length,
                actualToolCount: exposure.actualToolNames.length,
                missingTools: exposure.missingToolNames,
                unexpectedTools: exposure.unexpectedToolNames,
                duplicateTools: exposure.duplicateToolNames,
                fingerprint: exposure.fingerprint,
              },
            },
          },
          observedAt: readiness.observedAt,
        };
        return result(payload);
      }
      case 'repository_runtime_snapshot': {
        const repository = selected(ctx, args);
        const snapshot = readRepositoryProjectionSnapshot(ctx.controllerHome, repository.repoId);
        return result({
          snapshot: summarizeRuntimeProjectionForReadiness(snapshot.projection),
          stale: snapshot.stale,
          persisted: snapshot.persisted,
          dirtySinceAt: snapshot.dirtySinceAt,
          dirtyReason: snapshot.dirtyReason,
        });
      }
      case 'runtime_performance_diagnostics': {
        const repository = selected(ctx, args);
        const projection = readRepositoryProjectionSnapshot(ctx.controllerHome, repository.repoId).projection;
        const runtime = loadMcpRuntimeState(repository.canonicalRoot);
        const inferredLocalBridge = inferLocalControllerProcess(repository.canonicalRoot);
        const activeJobIds = listExecutionJobs(ctx.controllerHome, repository.repoId, 100)
          .filter((job) => ['queued', 'dispatched', 'running', 'waiting_for_dependency', 'waiting_for_workspace', 'waiting_for_heavy_check', 'waiting_for_integration'].includes(job.status))
          .map((job) => job.jobId);
        const diagnostics = collectRuntimePerformanceDiagnostics({
          repoId: repository.repoId,
          repoRoot: repository.canonicalRoot,
          queueDepth: projection?.queueDepth ?? 0,
          runningWorkers: projection?.runningWorkers ?? 0,
          activeLeases: projection?.activeLeases ?? 0,
          activeJobIds,
          includeProcesses: args.include_processes !== false,
          includeTempDirs: args.include_temp_dirs !== false,
          cleanupPreview: args.cleanup_preview === true,
          localControllerRunning: runtime?.localController?.running === true || inferredLocalBridge?.running === true,
          localControllerPid: runtime?.localController?.pid ?? inferredLocalBridge?.pid,
          localControllerEndpoint: runtime?.localController?.endpoint ?? inferredLocalBridge?.endpoint,
        });
        return result({
          ...diagnostics,
          contextPerformance: controllerContextPerformanceSnapshot(),
          gitPerformance: gitSnapshotPerformanceSnapshot(),
          gitIdentity: gitIdentityPerformanceSnapshot(),
          runtimeIdentity: runtimeIdentitySnapshot(ctx),
          resourceCost: {
            processRuntime: processRuntimeResourceDiagnostics(),
            scheduler: readSchedulerHealthSnapshot(ctx.controllerHome),
            sessionCache: sessionCacheGlobalDiagnostics(),
          },
        });
      }
      case 'capability_recovery_probe': {
        const repository = selected(ctx, args);
        const snapshot = await capabilityRecoverySnapshot(ctx, repository, args);
        const blockingCapabilityCount = snapshot.capabilities
          .filter((capability) => ['blocked', 'unavailable', 'degraded'].includes(capability.state))
          .length;
        const ready = blockingCapabilityCount === 0 && snapshot.platformBlocked !== true;
        return result({
          ready,
          reasonCodes: ready ? [] : [snapshot.externalLifecycleHandoff?.reasonCode ?? 'RUNTIME_DIAGNOSTICS_ATTENTION_REQUIRED'],
          diagnostics: {
            capabilityCount: snapshot.capabilities.length,
            blockingCapabilityCount,
            platformBlocked: snapshot.platformBlocked === true,
            recentAuditCount: listRecoveryAuditRecords(ctx.controllerHome, repository.repoId, 10).length,
          },
          externalLifecycleHandoff: snapshot.externalLifecycleHandoff,
          observedAt: snapshot.generatedAt,
          mutatesState: false,
          ownsRuntimeLifecycle: false,
        });
      }
      case 'capability_recovery_plan': {
        const repository = selected(ctx, args);
        const snapshot = await capabilityRecoverySnapshot(ctx, repository, args);
        const blockingCapabilityCount = snapshot.capabilities
          .filter((capability) => ['blocked', 'unavailable', 'degraded'].includes(capability.state))
          .length;
        const ready = blockingCapabilityCount === 0 && snapshot.platformBlocked !== true;
        return result({
          ready,
          reasonCodes: ready ? [] : [snapshot.externalLifecycleHandoff?.reasonCode ?? 'RUNTIME_DIAGNOSTICS_ATTENTION_REQUIRED'],
          diagnostics: {
            capabilityCount: snapshot.capabilities.length,
            blockingCapabilityCount,
            platformBlocked: snapshot.platformBlocked === true,
          },
          observedAt: snapshot.generatedAt,
          handoffRequired: !ready,
          externalLifecycleHandoff: snapshot.externalLifecycleHandoff,
          notes: snapshot.notes,
          next: ready
            ? 'Continue through the current Runtime and Work interfaces.'
            : snapshot.externalLifecycleHandoff
              ? 'Create or consume an rh_inbox handoff for the external Runtime lifecycle owner. Operate on the existing single forge-runtime only, then verify controller_ready and rh_status source coherence.'
              : 'Inspect runtime_maintenance_status and create an rh_inbox handoff when operator or external Controller action is required.',
        });
      }
      case 'runtime_maintenance_status': {
        const repository = selected(ctx, args);
        return result(buildRuntimeMaintenanceStatus(repository, ctx.controllerHome, {
          minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
          maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
          cancelPendingApprovals: args.cancel_pending_approvals === true,
        }) as unknown as Record<string, unknown>);
      }
      case 'runtime_maintenance_apply': {
        const repository = selected(ctx, args);
        const actionId = String(args.action_id ?? '').trim() as RuntimeMaintenanceActionId;
        if (!actionId) return result({ error: { code: 'RUNTIME_MAINTENANCE_ACTION_REQUIRED', message: 'action_id is required.' } }, true);
        if (args.confirm_maintenance !== true || String(args.authorization ?? '') !== actionId) {
          throw new Error('RUNTIME_MAINTENANCE_AUTHORIZATION_REQUIRED: confirm_maintenance=true and authorization=action_id are required.');
        }
        return result(applyRuntimeMaintenance(repository, ctx.controllerHome, {
          actionId,
          confirmMaintenance: true,
          minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
          maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
          cancelPendingApprovals: args.cancel_pending_approvals === true,
        }) as unknown as Record<string, unknown>);
      }
      case 'goal_create':
      case 'goal_list':
      case 'goal_get':
      case 'goal_start':
      case 'goal_continue':
      case 'goal_stop':
      case 'goal_finalize':
      case 'goal_status':
      case 'goal_tick_once':
      case 'goal_handoff_packet_create':
      case 'goal_handoff_packet_get':
      case 'provider_list':
      case 'provider_health':
      case 'provider_config_status':
      case 'executor_route_preview':
      case 'executor_dispatch':
      case 'repair_plan':
      case 'repair_continue': {
        const repository = selected(ctx, args);
        if (['goal_create', 'goal_start', 'goal_continue', 'goal_tick_once', 'executor_dispatch', 'repair_continue'].includes(name)) {
          return result({
            error: {
              code: 'GOAL_LOOP_DEPRECATED',
              message: 'Goal provider dispatch is retired. Use rh_work.plan_create/plan_approve, rh_work.controller_claim, rh_work.launcher_start, and rh_inbox for continuation.',
            },
            deprecated: true,
            migration: ['rh_work.plan_create', 'rh_work.controller_claim', 'rh_work.launcher_start', 'rh_inbox.create'],
          }, true);
        }
        const goalCtx: GoalLoopContext = {
          goalStore: { controllerHome: ctx.controllerHome, repoId: repository.repoId },
          packetStore: { controllerHome: ctx.controllerHome, repoId: repository.repoId },
          repoId: repository.repoId,
        };
        const goalId = typeof args.goal_id === 'string' ? args.goal_id : '';
        const taskIntent = typeof args.task_intent === 'string' ? args.task_intent as TaskIntent : undefined;
        switch (name) {
          case 'goal_create': {
            const goal = goalCreate(goalCtx, {
              title: String(args.title ?? ''),
              objective: String(args.objective ?? ''),
              mode: args.mode === 'manual' || args.mode === 'supervised' || args.mode === 'autonomous' ? args.mode : 'autonomous',
              issueId: typeof args.issue_id === 'string' ? args.issue_id : undefined,
              taskIds: Array.isArray(args.task_ids) ? args.task_ids.map(String) : undefined,
              acceptanceCriteria: Array.isArray(args.acceptance_criteria) ? args.acceptance_criteria.map(String) : undefined,
              checkIds: Array.isArray(args.check_ids) ? args.check_ids.map(String) : undefined,
              allowedExecutors: Array.isArray(args.allowed_executors) ? args.allowed_executors.map(String) : undefined,
              forbiddenExecutors: Array.isArray(args.forbidden_executors) ? args.forbidden_executors.map(String) : undefined,
              retryBudget: typeof args.retry_budget === 'number' ? args.retry_budget : undefined,
            });
            return result({ goal, summary: summarizeGoalPublic(goal) });
          }
          case 'goal_list': {
            const status = typeof args.status === 'string' ? args.status as GoalStatus | 'active' | 'all' : 'active';
            const goals = goalList(goalCtx, status, typeof args.limit === 'number' ? args.limit : 50);
            return result({ goals: goals.map(summarizeGoalPublic), count: goals.length });
          }
          case 'goal_get': {
            const goal = goalGet(goalCtx, goalId);
            if (!goal) return result({ error: { code: 'GOAL_NOT_FOUND', message: `Goal not found: ${goalId}` } }, true);
            return result({ goal, summary: summarizeGoalPublic(goal) });
          }
          case 'goal_start':
            return result({ tick: goalStart(goalCtx, goalId) });
          case 'goal_continue':
            return result({ tick: goalContinue(goalCtx, goalId) });
          case 'goal_stop':
            return result({ goal: summarizeGoalPublic(goalStop(goalCtx, goalId, typeof args.reason === 'string' ? args.reason : undefined)) });
          case 'goal_finalize': {
            const finalized = goalFinalize(goalCtx, goalId, { force: args.force === true });
            return result({ ok: finalized.ok, reason: finalized.reason, goal: summarizeGoalPublic(finalized.goal) }, !finalized.ok);
          }
          case 'goal_status':
            return result(goalStatus(goalCtx, goalId || undefined));
          case 'goal_tick_once': {
            if (goalId) {
              return result({
                tick: goalTickOnce(goalCtx, goalId, {
                  taskIntent,
                  providerFailure: args.provider_failure === true,
                  externalWrite: args.external_write === true,
                  approvalConfirmed: args.approval_confirmed === true,
                  verificationResult: typeof args.verification_check_id === 'string'
                    ? {
                        checkId: args.verification_check_id,
                        ok: args.verification_ok === true,
                      }
                    : undefined,
                }),
              });
            }
            return result({ ticks: tickActiveGoals(goalCtx) });
          }
          case 'goal_handoff_packet_create':
            return result({
              packet: goalHandoffPacketCreate(goalCtx, goalId, {
                blockers: Array.isArray(args.blockers) ? args.blockers.map(String) : undefined,
                requiredUserDecision: typeof args.required_user_decision === 'string' ? args.required_user_decision : undefined,
                recommendedProvider: typeof args.recommended_provider === 'string' ? args.recommended_provider : undefined,
              }),
            });
          case 'goal_handoff_packet_get': {
            const packet = goalHandoffPacketGet(goalCtx, String(args.packet_id ?? ''));
            if (!packet) return result({ error: { code: 'PACKET_NOT_FOUND', message: 'Handoff packet not found.' } }, true);
            return result({ packet });
          }
          case 'provider_list':
            return result({ providers: providerListAction(goalCtx), policyOwner: 'forge' });
          case 'provider_health':
            return result({
              health: providerHealthAction(goalCtx, typeof args.provider_id === 'string' ? args.provider_id : undefined),
              redacted: true,
            });
          case 'provider_config_status':
            return result(providerConfigStatusAction(goalCtx));
          case 'executor_route_preview':
            return result({
              route: executorRoutePreview(goalCtx, {
                goalId: goalId || undefined,
                taskIntent,
                risk: typeof args.risk === 'string' ? args.risk as 'readonly' | 'local_repo_write' | 'workspace_write' | 'remote_write' | 'destructive' | 'raw_secret_config' : undefined,
                objective: typeof args.objective === 'string' ? args.objective : undefined,
              }),
            });
          case 'executor_dispatch':
            return result(executorDispatch(goalCtx, {
              goalId,
              providerId: typeof args.provider_id === 'string' ? args.provider_id : undefined,
              taskIntent,
              risk: typeof args.risk === 'string' ? args.risk as 'readonly' | 'local_repo_write' | 'workspace_write' | 'remote_write' | 'destructive' | 'raw_secret_config' : undefined,
              approvalConfirmed: args.approval_confirmed === true,
              externalWrite: args.external_write === true,
              strongConfirmationText: typeof args.strong_confirmation_text === 'string' ? args.strong_confirmation_text : undefined,
            }));
          case 'repair_plan':
            return result(repairPlan(goalCtx, goalId));
          case 'repair_continue':
            return result({
              tick: repairContinue(goalCtx, goalId, {
                forceFailureClass: typeof args.force_failure_class === 'string'
                  ? args.force_failure_class as import('../../control-plane/goal-loop').FailureClass
                  : undefined,
              }),
            });
          default:
            return result({ error: { code: 'GOAL_LOOP_UNKNOWN', message: name } }, true);
        }
      }
      case 'workspace_auth_status': {
        const repository = selected(ctx, args);
        return result(buildWorkspaceAuthStatus(listAssistantPluginManifests(ctx.controllerHome, repository)));
      }
      case 'workspace_auth_login_prepare': {
        selected(ctx, args);
        return result(prepareWorkspaceAuthLogin(ctx.controllerHome, {
          service: typeof args.service === 'string' ? args.service : undefined,
          scopes: Array.isArray(args.scopes) ? args.scopes.map(String) : undefined,
          redirectUri: typeof args.redirect_uri === 'string' ? args.redirect_uri : undefined,
        }));
      }
      case 'assistant_model_readiness': {
        return result(assistantModelReadiness());
      }
      case 'assistant_standing_grants': {
        const repository = selected(ctx, args);
        return result(listAssistantStandingGrants(ctx.controllerHome, repository, {
          status: typeof args.status === 'string' ? args.status as any : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        }));
      }
      case 'assistant_standing_grant_create': {
        const repository = selected(ctx, args);
        return result({ grant: createAssistantStandingGrant(ctx.controllerHome, repository, {
          name: typeof args.name === 'string' ? args.name : undefined,
          pluginId: String(args.plugin_id ?? '').trim(),
          actionId: String(args.action_id ?? '').trim(),
          routineIds: Array.isArray(args.routine_ids) ? args.routine_ids.map(String) : undefined,
          senderAllowlist: Array.isArray(args.sender_allowlist) ? args.sender_allowlist.map(String) : undefined,
          subjectContains: Array.isArray(args.subject_contains) ? args.subject_contains.map(String) : undefined,
          minConfidence: typeof args.min_confidence === 'number' ? args.min_confidence : undefined,
          maxPerRun: typeof args.max_per_run === 'number' ? args.max_per_run : undefined,
          expiresInDays: typeof args.expires_in_days === 'number' ? args.expires_in_days : undefined,
          confirmAuthorization: args.confirm_authorization === true,
          origin: { surface: 'mcp', actor: 'assistant_standing_grant_create' },
        }) });
      }
      case 'assistant_standing_grant_revoke': {
        const repository = selected(ctx, args);
        return result({ grant: revokeAssistantStandingGrant(ctx.controllerHome, repository, {
          grantId: String(args.grant_id ?? '').trim(),
          reason: typeof args.reason === 'string' ? args.reason : undefined,
          confirmAuthorization: args.confirm_authorization === true,
          origin: { surface: 'mcp', actor: 'assistant_standing_grant_revoke' },
        }) });
      }
      case 'assistant_action_proposals': {
        const repository = selected(ctx, args);
        const proposalId = typeof args.proposal_id === 'string' ? args.proposal_id.trim() : '';
        return result(proposalId
          ? { proposal: getAssistantActionProposal(ctx.controllerHome, repository, proposalId) }
          : listAssistantActionProposals(ctx.controllerHome, repository, {
              status: typeof args.status === 'string' ? args.status as any : undefined,
              limit: typeof args.limit === 'number' ? args.limit : undefined,
            }));
      }
      case 'assistant_action_proposal_resolve': {
        const repository = selected(ctx, args);
        const proposalId = String(args.proposal_id ?? '').trim();
        if (args.decision === 'reject') {
          return result({ proposal: rejectAssistantActionProposal(ctx.controllerHome, repository, proposalId, typeof args.reason === 'string' ? args.reason : undefined) });
        }
        if (args.confirm_authorization !== true) throw new Error('ASSISTANT_ACTION_APPROVAL_REQUIRED: confirm_authorization=true');
        const requestId = String(args.request_id ?? `assistant-proposal:${proposalId}`).trim();
        return result({ proposal: await approveAssistantActionProposal(ctx.controllerHome, repository, {
          proposalId,
          requestId,
          confirmationText: typeof args.confirmation_text === 'string' ? args.confirmation_text : undefined,
          origin: { surface: 'mcp', actor: 'assistant_action_proposal_resolve' },
        }) });
      }
      case 'external_filesystem_targets_list': {
        const repository = selected(ctx, args);
        return result(listExternalFilesystemTargets(repository.canonicalRoot));
      }
      case 'external_filesystem_grant_preview': {
        const repository = selected(ctx, args);
        return result(previewExternalFilesystemGrant(repository.canonicalRoot, args) as unknown as Record<string, unknown>);
      }
      case 'external_filesystem_grant_apply': {
        const repository = selected(ctx, args);
        return result(applyExternalFilesystemGrant(repository.canonicalRoot, args) as unknown as Record<string, unknown>);
      }
      case 'external_filesystem_text_snapshot': {
        const repository = selected(ctx, args);
        return result(readExternalFilesystemSnapshot(repository.canonicalRoot, args) as unknown as Record<string, unknown>);
      }
      case 'capability_recovery_apply': {
        const repository = selected(ctx, args);
        const actionId = String(args.action_id ?? '').trim();
        const action = recoveryActionById(actionId);
        if (!action) return result({ error: { code: 'RECOVERY_ACTION_UNKNOWN', message: actionId } }, true);
        assertRecoveryAuthorized(action, action.confirmation === 'none' ? action.id : args.confirm_authorization === true ? String(args.authorization ?? '') : undefined);
        const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : 'manual recovery action';
        let payload: Record<string, unknown>;
        let affectedPaths: string[] = [];
        switch (action.id) {
          case 'recovery.stage_and_activate_runtime_release': {
            const staged = stageRuntimeReleaseFromCandidateSource({
              controllerHome: ctx.controllerHome,
              sourceRoot: repository.canonicalRoot,
            });
            assertRuntimeReleaseFiles(staged);
            payload = {
              staged: {
                releaseId: staged.releaseId,
                sourceCommit: staged.sourceCommit,
                artifactIdentity: staged.artifactIdentity,
                manifestSha256: staged.manifestSha256,
              },
              activation: await callStandaloneRecoveryTool(ctx.controllerHome, 'activate_runtime_release', {
                request_id: `runtime-cutover-${Date.now()}`,
                release_path: staged.manifestPath,
              }),
            };
            affectedPaths = ['controllerHome/runtime/releases', 'controllerHome/runtime/releases/authority.json'];
            break;
          }
          case 'recovery.restart_primary_connector': {
            payload = await callStandaloneRecoveryTool(ctx.controllerHome, 'restart_primary_connector', {
              request_id: `connector-restart-${Date.now()}`,
            });
            affectedPaths = ['controllerHome/recovery/audit'];
            break;
          }
          case 'recovery.probe_again':
            payload = { recovery: await capabilityRecoverySnapshot(ctx, repository, args) };
            break;
          case 'recovery.rebuild_projection': {
            const projection = rebuildRepositoryProjection(ctx.controllerHome, repository.repoId);
            payload = { projection };
            affectedPaths = ['.ai/harness/controller/projections'];
            break;
          }
          case 'recovery.refresh_repository': {
            const runtimeStorage = ensureRepositoryRuntimeStorage(repository, ctx.controllerHome);
            const projection = rebuildRepositoryProjection(ctx.controllerHome, repository.repoId);
            payload = { runtimeStorage, projection };
            affectedPaths = ['.ai/harness/controller', '.ai/harness/local-bridge'];
            break;
          }
          case 'recovery.cleanup_preview': {
            payload = previewRuntimeCleanup(repository.canonicalRoot, {
              minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
              includeTempDirs: true,
              includeTerminalLocalJobs: true,
              includeLegacyRuns: true,
              includeHistoricalAttention: true,
              maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
            }) as unknown as Record<string, unknown>;
            break;
          }
          case 'recovery.cleanup_apply': {
            payload = applyRuntimeCleanup(repository.canonicalRoot, {
              minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
              includeTempDirs: true,
              includeTerminalLocalJobs: true,
              includeLegacyRuns: true,
              includeHistoricalAttention: true,
              maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
              confirmCleanup: true,
            }) as unknown as Record<string, unknown>;
            affectedPaths = ['.ai/harness/local-jobs-archive', '.ai/harness/jobs-archive', '.ai/harness/controller/acknowledged-attention.jsonl'];
            break;
          }
          case 'recovery.reconcile_jobs':
          case 'recovery.local_jobs_reconcile': {
            const maintenance = applyRuntimeMaintenance(repository, ctx.controllerHome, {
              actionId: 'local_jobs_reconcile',
              confirmMaintenance: true,
              minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : 10,
              maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
            });
            payload = { maintenance };
            affectedPaths = ['.ai/harness/local-jobs', '.ai/harness/local-jobs-quarantine', '.ai/harness/controller'];
            break;
          }
          case 'recovery.local_jobs_quarantine_unreadable': {
            const maintenance = applyRuntimeMaintenance(repository, ctx.controllerHome, {
              actionId: 'quarantine_unreadable_local_jobs',
              confirmMaintenance: true,
              minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : 0,
              maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
            });
            payload = { maintenance };
            affectedPaths = ['.ai/harness/local-jobs', '.ai/harness/local-jobs-quarantine'];
            break;
          }
          case 'recovery.runtime_storage_finalize_relocation': {
            const maintenance = applyRuntimeMaintenance(repository, ctx.controllerHome, {
              actionId: 'runtime_storage_finalize_relocation',
              confirmMaintenance: true,
              minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : 0,
              maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
            });
            payload = { maintenance };
            affectedPaths = ['.ai/harness/local-jobs', '.ai/harness/controller'];
            break;
          }
          case 'recovery.create_patch_handoff':
            payload = prepareTransferArtifacts(repository, { reason }) as unknown as Record<string, unknown>;
            affectedPaths = ['.ai/harness/transfers', '.ai/harness/session'];
            break;
          case 'recovery.workspace_auth_login_prepare':
            payload = { skipped: true, nextTool: 'workspace_auth_login_prepare', reason: 'Auth login is a non-secret handoff and should be prepared through the dedicated typed tool.' };
            break;
          case 'recovery.external_filesystem_grant_preview':
            payload = { skipped: true, nextTool: 'external_filesystem_grant_preview', reason: 'External filesystem access must be converted into a named read-only target first.' };
            break;
          default:
            payload = { skipped: true, reason: `No executor is registered for ${action.id}.` };
        }
        const audit = writeRecoveryAuditRecord(ctx.controllerHome, repository.repoId, buildRecoveryAuditRecord({
          actor: 'capability_recovery_apply',
          action,
          result: payload.skipped === true ? 'skipped' : 'succeeded',
          reason,
          affectedPaths,
        }));
        return result({ repoId: repository.repoId, action, audit, result: payload });
      }
      case 'runtime_storage_repair_preview': {
        const repository = selected(ctx, args);
        const preview = previewRuntimeStorageRepair(repository, ctx.controllerHome, {
          minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
          maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
        });
        return result({ ...preview });
      }
      case 'runtime_storage_repair_apply': {
        const repository = selected(ctx, args);
        const candidateIds = Array.isArray(args.candidate_ids) ? args.candidate_ids.map(String) : undefined;
        const applied = applyRuntimeStorageRepair(repository, ctx.controllerHome, {
          candidateIds,
          minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
          maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
          confirmRepair: args.confirm_repair === true,
        });
        const runtimeStorage = ensureRepositoryRuntimeStorage(repository, ctx.controllerHome);
        const projection = rebuildRepositoryProjection(ctx.controllerHome, repository.repoId);
        return result({ ...applied, runtimeStorage, projection });
      }
      case 'list_plugins': {
        const controllerRepository = controllerPluginRepository(ctx.controllerHome);
        const controllerPlugins = listAssistantPluginManifests(ctx.controllerHome, controllerRepository, {
          forceRefresh: true,
        }).map(summarizePlugin);
        let repositoryPlugins: ReturnType<typeof summarizePlugin>[] = [];
        let repositoryId: string | undefined;
        try {
          const repository = selected(ctx, args);
          repositoryId = repository.repoId;
          repositoryPlugins = listAssistantPluginManifests(ctx.controllerHome, repository, {
            forceRefresh: true,
          }).map(summarizePlugin);
        } catch (error) {
          if (typeof args.repo_id === 'string' && args.repo_id.trim()) throw error;
        }
        return result({
          scope: repositoryPlugins.length > 0 ? 'combined' : 'controller',
          repositoryId,
          plugins: [...repositoryPlugins, ...controllerPlugins]
            .sort((left, right) => String(left.pluginId).localeCompare(String(right.pluginId))),
        });
      }
      case 'get_plugin': {
        const pluginId = String(args.plugin_id ?? '').trim();
        const repository = pluginRepository(ctx, args, pluginId);
        return result({
          scope: repository.repoId === '__controller__' ? 'controller' : 'repository',
          plugin: summarizePlugin(getAssistantPluginManifest(ctx.controllerHome, repository, pluginId)),
        });
      }
      case 'assistant_readiness': {
        const repository = selected(ctx, args);
        const readiness = buildAssistantReadinessReport(ctx.controllerHome, repository);
        return result({ ...readiness });
      }

      case 'gmail_triage_rules': {
        const repository = selected(ctx, args);
        return result({ repoId: repository.repoId, checkoutId: repository.activeCheckoutId, path: '.forge/assistant/gmail-triage-rules.json', ...readGmailTriageRules(repository) });
      }
      case 'gmail_triage_rule_upsert': {
        const repository = selected(ctx, args);
        const upserted = upsertGmailTriageRule(repository, args);
        return result({ repoId: repository.repoId, checkoutId: repository.activeCheckoutId, ...upserted });
      }
      case 'gmail_triage_plan': {
        const repository = selected(ctx, args);
        let manifest;
        try { manifest = getAssistantPluginManifest(ctx.controllerHome, repository, 'gmail'); } catch (_error) { manifest = undefined; }
        return result(buildGmailTriagePlan(repository, { manifest, items: args.items, query: args.query }) as unknown as Record<string, unknown>);
      }
      case 'review_artifacts_prepare': {
        const repository = selected(ctx, args);
        return result(ensureReviewArtifactRoots(repository));
      }
      case 'review_artifacts_index': {
        const repository = selected(ctx, args);
        return result(buildReviewArtifactIndex(repository, { limit: args.limit }) as unknown as Record<string, unknown>);
      }
      case 'browser_review_packet': {
        const repository = selected(ctx, args);
        return result(prepareBrowserReviewPacket(repository, { limit: args.limit }) as unknown as Record<string, unknown>);
      }
      case 'ios_review_packet': {
        const repository = selected(ctx, args);
        return result(prepareIosReviewPacket(repository, { udid: args.udid, label: args.label, capture: args.capture, limit: args.limit }) as unknown as Record<string, unknown>);
      }
      case 'workflow_watchdog_report': {
        const repository = selected(ctx, args);
        return result(buildWorkflowWatchdogReport(ctx.controllerHome, repository, { staleMinutes: args.stale_minutes, includeProcesses: args.include_processes }) as unknown as Record<string, unknown>);
      }
      case 'ios_xcode_status':
        return legacyIosPluginAction(ctx, name, args, 'xcode_status', {});
      case 'ios_simulators_list':
        return legacyIosPluginAction(ctx, name, args, 'list_simulators', {
          runtime: typeof args.runtime === 'string' ? args.runtime : undefined,
          name: typeof args.name === 'string' ? args.name : undefined,
        });
      case 'ios_project_discover':
        return legacyIosPluginAction(ctx, name, args, 'discover_project', {});
      case 'ios_schemes_list':
        return legacyIosPluginAction(ctx, name, args, 'list_schemes', {
          workspace: typeof args.workspace === 'string' ? args.workspace : undefined,
          project: typeof args.project === 'string' ? args.project : undefined,
        });
      case 'ios_simulator_boot':
        return legacyIosPluginAction(ctx, name, args, 'launch_simulator', {
          udid: String(args.udid ?? '').trim(),
          open_simulator: args.open_simulator !== false,
          timeout_ms: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
        });
      case 'ios_app_build':
        return legacyIosPluginAction(ctx, name, args, 'build', {
          scheme: String(args.scheme ?? '').trim(),
          udid: typeof args.udid === 'string' ? args.udid : undefined,
          simulator_name: typeof args.simulator_name === 'string' ? args.simulator_name : undefined,
          workspace: typeof args.workspace === 'string' ? args.workspace : undefined,
          project: typeof args.project === 'string' ? args.project : undefined,
          configuration: typeof args.configuration === 'string' ? args.configuration : undefined,
          timeout_ms: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
        });
      case 'ios_simulator_screenshot':
        return legacyIosPluginAction(ctx, name, args, 'capture_screenshot', {
          udid: String(args.udid ?? '').trim(),
          label: typeof args.label === 'string' ? args.label : undefined,
        });
      case 'ios_ui_smoke_test':
        return legacyIosPluginAction(ctx, name, args, 'smoke_review', {
          scheme: typeof args.scheme === 'string' ? args.scheme : undefined,
          bundle_id: typeof args.bundle_id === 'string' ? args.bundle_id : undefined,
          udid: typeof args.udid === 'string' ? args.udid : undefined,
          simulator_name: typeof args.simulator_name === 'string' ? args.simulator_name : undefined,
          workspace: typeof args.workspace === 'string' ? args.workspace : undefined,
          project: typeof args.project === 'string' ? args.project : undefined,
          configuration: typeof args.configuration === 'string' ? args.configuration : undefined,
          app_path: typeof args.app_path === 'string' ? args.app_path : undefined,
          screenshot_label: typeof args.screenshot_label === 'string' ? args.screenshot_label : undefined,
        });
      case 'ios_app_install':
      case 'ios_app_launch':
      case 'ios_simulator_log_tail':
        return result({
          accepted: false,
          mode: 'compatibility_migration',
          path: 'plugin_action_execute',
          rejectCode: 'LEGACY_IOS_ATOMIC_RETIRED',
          message: `${name} no longer owns an independent iOS execution path. Use plugin_action_execute with plugin_id=ios and action_id=smoke_review for staged simulator validation.`,
          migration: { tool: 'plugin_action_execute', plugin_id: 'ios', action_id: 'smoke_review' },
        }, true);
      case 'runtime_cleanup_preview': {
        const repository = selected(ctx, args);
        const preview = previewRuntimeCleanup(repository.canonicalRoot, {
          minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
          includeTempDirs: args.include_temp_dirs !== false,
          includeTerminalLocalJobs: args.include_terminal_local_jobs === true,
          includeLegacyRuns: args.include_legacy_runs === true,
          includeHistoricalAttention: args.include_historical_attention === true,
          maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
        });
        return result({ ...preview });
      }
      case 'runtime_cleanup_apply': {
        const repository = selected(ctx, args);
        const applied = applyRuntimeCleanup(repository.canonicalRoot, {
          minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
          includeTempDirs: args.include_temp_dirs !== false,
          includeTerminalLocalJobs: args.include_terminal_local_jobs === true,
          includeLegacyRuns: args.include_legacy_runs === true,
          includeHistoricalAttention: args.include_historical_attention === true,
          maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
          confirmCleanup: args.confirm_cleanup === true,
        });
        return result({ ...applied });
      }
      case 'plugin_action_execute': {
        const pluginId = String(args.plugin_id ?? '').trim();
        const repository = pluginRepository(ctx, args, pluginId);
        const actionId = String(args.action_id ?? '').trim();
        const requestId = String(args.request_id ?? '').trim();
        const actionArguments = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
          ? args.arguments as Record<string, unknown>
          : {};
        const request = {
          pluginId,
          actionId,
          requestId,
          workId: typeof args.work_id === 'string' && args.work_id.trim() ? args.work_id.trim() : undefined,
          args: actionArguments,
          timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
          signal: ctx.signal,
          confirmAuthorization: args.confirm_authorization === true,
          confirmationText: typeof args.confirmation_text === 'string' ? args.confirmation_text : undefined,
          origin: mcpPluginExecutionOrigin(ctx.principalId, 'plugin_action_execute', requestId),
        };
        const manifest = getAssistantPluginManifest(ctx.controllerHome, repository, pluginId);
        const action = manifest.actions.find((entry) => entry.actionId === actionId);
        if (action && isDirectPluginReadAction(action)) {
          const direct = await executeAssistantPluginReadDirect(ctx.controllerHome, repository, request);
          const value = {
            accepted: true,
            direct: true,
            durable: false,
            plugin: summarizePluginActionReceipt(direct.manifest),
            action: {
              actionId: direct.action.actionId,
              risk: direct.action.risk,
              confirmation: direct.action.confirmation,
            },
            scope: repository.repoId === '__controller__' ? 'controller' : 'repository',
            result: direct.result,
            detail: {
              tool: 'rh_context',
              arguments: {
                ...(repository.repoId === '__controller__' ? {} : { repo_id: repository.repoId }),
                capability_id: `plugin.${pluginId}.${actionId}`,
                detail_level: 'detail',
              },
            },
            next: 'Continue with the returned bounded result; use rh_context capability detail only when the typed action schema/policy is needed.',
          };
          return resultWithPluginArtifactImages(value, ctx.controllerHome, repository.repoId, direct.result);
        }
        const submitted = await submitAssistantPluginAction(ctx.controllerHome, repository, request);
        const compactResult = compactSubmittedPluginActionResult(submitted.result);
        const value = {
          accepted: true,
          deduplicated: submitted.deduplicated,
          direct: true,
          durable: false,
          plugin: summarizePluginActionReceipt(submitted.manifest),
          action: {
            actionId: submitted.action.actionId,
            risk: submitted.action.risk,
            confirmation: submitted.action.confirmation,
            requiredConfirmationText: submitted.action.requiredConfirmationText,
          },
          scope: repository.repoId === '__controller__' ? 'controller' : 'repository',
          receiptId: submitted.receipt.receiptId,
          requestId: submitted.receipt.requestId,
          ...(submitted.receipt.workId ? { workId: submitted.receipt.workId } : {}),
          authorization: submitted.authorization,
          result: compactResult,
          detail: {
            tool: 'rh_context',
            arguments: {
              ...(repository.repoId === '__controller__' ? {} : { repo_id: repository.repoId }),
              capability_id: `plugin.${pluginId}.${actionId}`,
              detail_level: 'detail',
            },
          },
          next: 'Continue with the returned bounded plugin result; use rh_context capability detail only when the typed action schema/policy is needed.',
        };
        return resultWithPluginArtifactImages(value, ctx.controllerHome, repository.repoId, compactResult);
      }
      case 'toolchain_plugin_summary': {
        const pluginId = String(args.plugin_id ?? '').trim();
        const repository = pluginRepository(ctx, args, pluginId);
        const manifest = getAssistantPluginManifest(ctx.controllerHome, repository, pluginId);
        return result({
          plugin: summarizePluginForLowInterception(manifest),
          nonOpaque: true,
          next: manifest.pluginId === 'browser'
            ? 'Use rh_context for browser capability schemas and plugin_action_execute for typed HTTP(S) browser actions.'
            : undefined,
        });
      }
      case 'work_result_summary': {
        const repository = selected(ctx, args);
        const jobId = String(args.job_id ?? '').trim();
        const job = getExecutionJob(ctx.controllerHome, repository.repoId, jobId);
        const taskLedger = buildControllerTaskLedgerProjection(repository.canonicalRoot);
        return result({
          summary: summarizeJobResultForLowInterception(job),
          taskLedgerStatus: taskLedger.status,
          next: taskLedger.status.nextAction,
        });
      }
      case 'work_status_digest': {
        const repository = selected(ctx, args);
        const workRef = String(args.work_ref ?? '').trim();
        let job: ExecutionJob | undefined;
        try { job = getExecutionJob(ctx.controllerHome, repository.repoId, workRef); }
        catch { job = undefined; }
        const taskLedger = buildControllerTaskLedgerProjection(repository.canonicalRoot);
        if (job) {
          return result({
            digest: summarizeJobResultForLowInterception(job),
            workRef,
            taskLedgerStatus: taskLedger.status,
            next: taskLedger.status.nextAction,
          });
        }
        const contract = getWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, workRef);
        if (contract) {
          const continuation = buildWorkContinuationSnapshot(contract);
          return result({
            digest: continuation,
            workRef,
            taskLedgerStatus: taskLedger.status,
            next: continuation.nextSafeAction,
          }, contract.status === 'failed' || continuation.reconciliationRequired);
        }
        const process = getRepositoryCommandProcess(ctx.controllerHome, repository.repoId, workRef);
        if (!process) return result({ error: { code: 'WORK_NOT_FOUND', message: 'No Work or managed process matched work_ref.', errorClass: 'not_found', summary: '未找到对应任务。' } }, true);
        const digest = managedProcessOperationDigest(process);
        return result({
          digest,
          workRef,
          taskLedgerStatus: taskLedger.status,
          next: process.completed === true
            ? 'Managed process is terminal; inspect the bounded digest above.'
            : `Poll process_get or process_wait with process_id=${workRef}; do not re-run the original operation.`,
        }, digest.phase === 'failed' || digest.phase === 'timed_out');
      }
      case 'model_clients_summary': {
        return result({ clients: buildModelClientSummary(), policyOwner: 'forge', transportEncryption: 'not-configured-by-this-tool' });
      }
      case 'model_control_plane_summary': {
        return result({ controlPlane: buildModelControlPlaneSummary(), transportEncryption: 'not-configured-by-this-tool' });
      }
      case 'deepseek_tool_manifest': {
        return result({ provider: 'deepseek', tools: deepSeekFunctionToolManifest(), policyOwner: 'forge' });
      }
      case 'deepseek_tool_call_prepare': {
        const functionArguments = args.function_arguments && typeof args.function_arguments === 'object' && !Array.isArray(args.function_arguments)
          ? args.function_arguments as Record<string, unknown>
          : {};
        return result({ prepared: prepareDeepSeekToolCall(String(args.function_name ?? '').trim(), functionArguments) });
      }
      case 'deepseek_controller_manifest': {
        return result({ manifest: deepSeekControllerManifest() });
      }
      case 'deepseek_controller_handoff_prepare': {
        const repository = selected(ctx, args);
        return result({ handoff: prepareDeepSeekControllerHandoff({
          reason: args.reason as never,
          objective: typeof args.objective === 'string' ? args.objective : undefined,
          repoId: repository.repoId,
          currentController: typeof args.current_controller === 'string' ? args.current_controller : undefined,
          blockedToolName: typeof args.blocked_tool_name === 'string' ? args.blocked_tool_name : undefined,
          recentSafeError: typeof args.recent_safe_error === 'string' ? args.recent_safe_error : undefined,
        }) });
      }
      case 'deepseek_controller_request_prepare': {
        const repository = selected(ctx, args);
        return result({ preview: prepareDeepSeekControllerRequest({
          reason: args.reason as never,
          objective: typeof args.objective === 'string' ? args.objective : undefined,
          userMessage: typeof args.user_message === 'string' ? args.user_message : undefined,
          repoId: repository.repoId,
          currentController: typeof args.current_controller === 'string' ? args.current_controller : undefined,
          blockedToolName: typeof args.blocked_tool_name === 'string' ? args.blocked_tool_name : undefined,
          recentSafeError: typeof args.recent_safe_error === 'string' ? args.recent_safe_error : undefined,
          model: typeof args.model === 'string' ? args.model : undefined,
        }) });
      }
      case 'create_schedule': {
        const repository = selected(ctx, args);
        const operation = String(args.operation ?? '').trim();
        const operationArgs = args.arguments && typeof args.arguments === 'object' ? args.arguments as Record<string, unknown> : {};
        assertAutomatedOperationAllowed(operation, operationArgs);
        const scheduleRequestId = typeof args.request_id === 'string' && args.request_id.trim()
          ? args.request_id.trim()
          : `schedule:auto:${repository.repoId}:${createHash('sha256').update(JSON.stringify({ name: args.name, operation, arguments: operationArgs, everyMinutes: args.every_minutes })).digest('hex').slice(0, 20)}:${Math.floor(Date.now() / (5 * 60_000))}`;
        const schedule = createSchedule(ctx.controllerHome, {
          requestId: scheduleRequestId,
          repoId: repository.repoId,
          name: String(args.name ?? '').trim(),
          enabled: true,
          trigger: {
            type: ['interval', 'cron', 'calendar', 'condition', 'repository-event', 'dependency-checkpoint', 'manual'].includes(String(args.trigger_type))
              ? String(args.trigger_type) as 'interval' | 'cron' | 'calendar' | 'condition' | 'repository-event' | 'dependency-checkpoint' | 'manual'
              : typeof args.every_minutes === 'number' ? 'interval' : 'manual',
            everyMinutes: typeof args.every_minutes === 'number' ? Math.max(1, args.every_minutes) : undefined,
            cronExpression: typeof args.cron_expression === 'string' ? args.cron_expression : undefined,
            calendarAt: typeof args.calendar_at === 'string' ? args.calendar_at : undefined,
            condition: args.condition && typeof args.condition === 'object' ? args.condition as never : undefined,
            eventName: typeof args.event_name === 'string' ? args.event_name : undefined,
            dependencyJobIds: Array.isArray(args.dependency_job_ids) ? args.dependency_job_ids.map(String) : undefined,
          },
          policy: {
            maxActiveOccurrences: 1,
            maxFailures: typeof args.max_failures === 'number' ? Math.max(1, args.max_failures) : 3,
            cooldownMinutes: typeof args.cooldown_minutes === 'number' ? Math.max(0, args.cooldown_minutes) : 120,
            dailyBudgetMinutes: typeof args.daily_budget_minutes === 'number' ? Math.max(1, args.daily_budget_minutes) : 180,
            shadowMode: args.shadow_mode !== false,
            backoffBaseMinutes: typeof args.backoff_base_minutes === 'number' ? Math.max(1, args.backoff_base_minutes) : 5,
            backoffMaxMinutes: typeof args.backoff_max_minutes === 'number' ? Math.max(1, args.backoff_max_minutes) : 24 * 60,
          },
          action: { operation, arguments: operationArgs, resourceClaims: claimsForMcpOperation(operation, operationArgs, repository.repoId, repository.activeCheckoutId) },
          stopConditions: Array.isArray(args.stop_conditions) ? args.stop_conditions.map(String) : ['release_ready', 'external_blocker', 'human_review_required'],
        });
        return result({ schedule });
      }
      case 'list_schedules': {
        const repository = selected(ctx, args);
        const schedules = listSchedules(ctx.controllerHome, repository.repoId);
        if (args.include_occurrences !== true) return result({ schedules });
        const occurrences = listOccurrences(ctx.controllerHome, repository.repoId, undefined, 100);
        const decisions = occurrences.flatMap((occurrence) => occurrence.decisionId
          ? [getScheduleDecision(ctx.controllerHome, repository.repoId, occurrence.decisionId)].filter(Boolean)
          : []);
        return result({ schedules, occurrences, decisions });
      }
      case 'pause_schedule': {
        const repository = selected(ctx, args);
        const schedule = getSchedule(ctx.controllerHome, repository.repoId, String(args.schedule_id ?? ''));
        return result({ schedule: saveSchedule(ctx.controllerHome, { ...schedule, enabled: false, pausedReason: typeof args.reason === 'string' ? args.reason : 'Paused by user.' }) });
      }
      case 'trigger_schedule': {
        const repository = selected(ctx, args);
        const schedule = getSchedule(ctx.controllerHome, repository.repoId, String(args.schedule_id ?? ''));
        const occurrence = await evaluateSchedule(ctx.controllerHome, schedule, true, {
          source: typeof args.event_name === 'string' ? 'repository-event' : 'manual',
          eventName: typeof args.event_name === 'string' ? args.event_name : undefined,
          eventId: typeof args.event_id === 'string' ? args.event_id : undefined,
          data: args.event_data && typeof args.event_data === 'object' ? args.event_data as Record<string, unknown> : undefined,
        });
        return result({ occurrence });
      }
      case 'request_release_gate': {
        const repository = selected(ctx, args);
        const requestId = typeof args.request_id === 'string' && args.request_id.trim()
          ? args.request_id.trim()
          : `release:${repository.repoId}:${Math.floor(Date.now() / 60_000)}`;
        return result({
          accepted: false,
          mode: 'external_controller_required',
          requestId,
          repoId: repository.repoId,
          rejectCode: 'EXECUTION_JOB_RETIRED',
          message: 'Release Gate no longer creates an ExecutionJob. An external Controller must claim the related Work and execute release evidence explicitly.',
          suggestedOperation: 'rh_work.controller_claim followed by Process Runtime checks and explicit release authorization.',
        });
      }
      case 'create_portfolio_workflow': {
        const rawSteps = Array.isArray(args.steps) ? args.steps : [];
        const workflow = createPortfolioWorkflow(ctx.controllerHome, {
          name: String(args.name ?? '').trim(),
          requestId: String(args.request_id ?? '').trim(),
          failurePolicy: args.failure_policy === 'compensate' ? 'compensate' : 'stop',
          steps: rawSteps.map((raw, index) => {
            if (!raw || typeof raw !== 'object') throw new Error(`PORTFOLIO_STEP_INVALID: step ${index + 1}`);
            const step = raw as Record<string, unknown>;
            const stepRepoId = String(step.repo_id ?? '').trim();
            const operation = String(step.operation ?? '').trim();
            const operationArgs = step.arguments && typeof step.arguments === 'object' ? step.arguments as Record<string, unknown> : {};
            if (!stepRepoId || !operation) throw new Error(`PORTFOLIO_STEP_INVALID: step ${index + 1} requires repo_id and operation`);
            assertAutomatedOperationAllowed(operation, operationArgs);
            const checkoutId = resolveRepositorySelection({ repoId: stepRepoId, controllerHome: ctx.controllerHome, allowSoleRepository: false }).activeCheckoutId;
            const compensation = step.compensation && typeof step.compensation === 'object'
              ? step.compensation as Record<string, unknown>
              : undefined;
            if (compensation) {
              const compensationOperation = String(compensation.operation ?? '').trim();
              const compensationArguments = compensation.arguments && typeof compensation.arguments === 'object'
                ? compensation.arguments as Record<string, unknown>
                : {};
              assertAutomatedOperationAllowed(compensationOperation, compensationArguments);
            }
            return {
              stepId: String(step.step_id ?? `step-${index + 1}`),
              repoId: stepRepoId,
              operation,
              arguments: operationArgs,
              dependsOn: Array.isArray(step.depends_on) ? step.depends_on.map(String) : [],
              priority: ['P0', 'P1', 'P2', 'P3', 'P4'].includes(String(step.priority)) ? String(step.priority) as 'P0' | 'P1' | 'P2' | 'P3' | 'P4' : 'P2',
              resourceClaims: claimsForMcpOperation(operation, operationArgs, stepRepoId, checkoutId),
              compensation: compensation ? { operation: String(compensation.operation ?? ''), arguments: compensation.arguments && typeof compensation.arguments === 'object' ? compensation.arguments as Record<string, unknown> : undefined } : undefined,
              status: 'pending' as const,
            };
          }),
        });
        return result({ workflow });
      }
      case 'list_portfolio_workflows':
        return result({ workflows: listPortfolioWorkflows(ctx.controllerHome, typeof args.limit === 'number' ? args.limit : 100) });
      case 'get_portfolio_workflow':
        return result({ workflow: getPortfolioWorkflow(ctx.controllerHome, String(args.workflow_id ?? '')) });
      case 'record_candidate_finding': {
        const repository = selected(ctx, args);
        const semanticKey = String(args.semantic_key ?? '').trim();
        const requestId = typeof args.request_id === 'string' && args.request_id.trim()
          ? args.request_id.trim()
          : `candidate:${repository.repoId}:${createHash('sha256').update(semanticKey).digest('hex').slice(0, 20)}:${Math.floor(Date.now() / (5 * 60_000))}`;
        const finding = recordCandidateFinding(ctx.controllerHome, {
          repoId: repository.repoId,
          requestId,
          semanticKey,
          title: String(args.title ?? '').trim(),
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          severity: ['low', 'medium', 'high', 'critical'].includes(String(args.severity))
            ? String(args.severity) as 'low' | 'medium' | 'high' | 'critical'
            : 'medium',
          evidence: {
            source: 'mcp',
            reference: typeof args.reference === 'string' ? args.reference : undefined,
            details: args.evidence && typeof args.evidence === 'object' ? args.evidence as Record<string, unknown> : undefined,
          },
        });
        return result({ finding });
      }
      case 'list_candidate_findings': {
        const repository = selected(ctx, args);
        return result({ findings: listCandidateFindings(ctx.controllerHome, repository.repoId, {
          includeTerminal: args.include_terminal === true,
          limit: typeof args.limit === 'number' ? args.limit : 100,
        }) });
      }
      case 'promote_candidate_finding': {
        const repository = selected(ctx, args);
        const finding = getCandidateFinding(ctx.controllerHome, repository.repoId, String(args.finding_id ?? ''));
        return result({
          accepted: false,
          mode: 'external_controller_required',
          repoId: repository.repoId,
          finding,
          rejectCode: 'EXECUTION_JOB_RETIRED',
          message: 'Candidate promotion no longer creates an ExecutionJob. An external Controller must create the Issue after claiming the related Work.',
          suggestedOperation: 'Create or claim WorkContract, then use the explicit issue-creation tool from the external Controller session.',
        });
      }
      default: return undefined;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const structuredCode = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1];
    return result({ error: { code: structuredCode ?? 'RUNTIME_TOOL_FAILED', message } }, true);
  }
}
