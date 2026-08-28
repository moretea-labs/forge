import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult as SdkCallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { collectRuntimePerformanceDiagnostics, inferLocalControllerProcess } from '../../diagnostics/performance';
import { defaultSemanticProviderRegistry, type SemanticNavigationKind, type SemanticNavigationRequest } from '../../context/semantic-navigation';
import type { McpToolDefinition, CallToolResult } from '../../../cli/mcp/tools';
import type { MultiRepositoryMcpToolContext } from '../../../cli/mcp/multi-repository';
import { repositoryScopedToolArgs } from '../../../cli/mcp/multi-repository';
import { resolveMcpPath } from '../../../cli/mcp/paths';
import { freshGitIdentity } from '../../../cli/repository/inspector';
import { reconcileReadinessProjectionSource } from '../../../cli/mcp/readiness-projection';
import { listRepositories, repositorySummary, resolveRepositorySelection, selectRepositoryCheckout } from '../../../cli/repositories/registry';
import { repositoryGitStatus } from '../../../cli/repositories/structured-git';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { cancelExecutionJob, findExecutionJob, getExecutionJob, getExecutionJobByRequestId, listExecutionJobs } from '../../execution/jobs/store';
import { waitForExecutionJob } from '../../execution/jobs/wait';
import type { ExecutionJob } from '../../execution/jobs/types';
import { DEFAULT_WORK_CHECK_LEASE_WAIT_MS, checkRequiresDurableWorkflow, getProcessHandle, getProcessRecord, isManagedProcessActive, listProcessRecords, listRecoverableProcessRecords, processCheckCompletionReceipt, processRuntimeResourceDiagnostics, readPersistedCheckResultReceipt, runPersistedCheckViaProcessRuntime, waitForProcess } from '../../execution/process-runtime';
import { listWorkBoundRepositoryProcessEvidence } from '../../control-plane/execution/work-process-evidence';
import { getRepositoryCommandProcess, waitRepositoryCommandProcess } from '../../execution/process-runtime/command-facade';
import { buildJobOperationDigest } from '../../control-plane/facade/operation-digest';
import { readWorkHandle, transitionWorkHandle, workDeliveryBaseRevision, writeWorkHandle, type WorkHandleState } from '../../control-plane/execution/work-handle-store';
import { recoverTerminalWorkHandle } from '../../control-plane/execution/work-terminal-cleanup';
import { gitCommitAtRef, gitWorktreeSnapshot } from '../../control-plane/execution/work-lifecycle-audit';
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
import { applyScheduleDedupe, buildScheduleDedupeReport, deleteSchedule } from '../../workflow/schedules/store';
import {
  createWorkContinuationSchedule,
  getWorkContinuationSchedule,
  listWorkContinuationSchedules,
  pauseWorkContinuationSchedule,
  resumeWorkContinuationSchedule,
  triggerWorkContinuationSchedule,
  type ContinuationControllerType,
} from '../../workflow/schedules/work-continuation';
import {
  gatewayRouteBehaviorSnapshot,
  getMcpToolDefinition,
  RETIRED_AGENT_OPERATIONS,
  routeDurableMcpCall,
} from './router';
import { assertAutomatedOperationAllowed } from '../../control-plane/governance/external-effects';
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
import { assistantPluginScope, controllerPluginRepository, executeAssistantPluginReadDirect, finalizeRemoteEffectWorkFromActionReceipt, getAssistantPluginManifest, isDirectPluginReadAction, listAssistantPluginManifests, submitAssistantPluginAction } from '../../plugins/store';
import { startLightweightPluginAction, waitLightweightPluginAction } from '../../plugins/lightweight-action';
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
  getCapabilityDescriptor,
  getPluginActionCapabilitySchema,
  searchCapabilityDescriptors,
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
  updateWorkContract,
  resumeRetainedCancelledWorkContract,
  buildWorkContinuationSnapshot,
  acceptPlanStepEvidence,
  admitPlanContractAsync,
  approvePlanContractAsync,
  getPlanContract,
  listPlanContracts,
  resolvePlanAdmission,
  withPrimaryWorkAdmissionLockAsync,
  repairDanglingPlanStepWorkBinding,
  repairDraftPlanContractAsync,
  completePlanStepForWork,
  summarizePlanContract,
  supersedePlanContract,
  verifyGoalWorkloop,
  type FacadeTool,
  bindControllerSessionToCurrentRuntime,
  claimControllerSession,
  getControllerSession,
  releaseControllerSessionWithAuthority,
  releaseObservedControllerSession,
  resumeControllerSession,
  withControllerSessionTerminalizationFence,
  type ControllerTerminalizationAuthority,
} from '../../control-plane/facade';
import { currentControllerInstanceId, readExecutionSession, startExecutionSession, updateExecutionSession } from '../../control-plane/execution/session-store';
import { changedPaths as workChangedPaths } from '../../control-plane/execution/work-task-receipt';
import { createRequirement, readRequirement } from '../../control-plane/persistence/requirement-store';
import { ensureManagedWorkspace } from '../../execution/managed-workspace';
import { currentPermissionSnapshotVersion } from '../../control-plane/execution/validation';
import { observeRuntimeStatus } from '../../root/status';
import { reconcileWorkValidation } from './work-validation-reconciler';
import { callExecutionTool } from './execution-tools';
import { launchSuperController } from '../../control-plane/launcher/thin-launcher';
import { runStandaloneChatgptPrompt, runWorkChatgptContinuation, settleWorkChatgptAutomationTab } from '../../control-plane/launcher/chatgpt-work-continuation';
import { getChatgptWorkConversationBinding } from '../../control-plane/launcher/chatgpt-work-binding-store';
import {
  acknowledgeControllerRoundClaim,
  beginControllerRoundRelayAfterRelease,
  beginInitialControllerRoundDispatch,
  reconcileControllerRoundAfterAbandonedRelease,
  buildControllerRoundRelayPrompt,
  finishControllerRoundRelayDispatch,
  getControllerRoundRelay,
  parseControllerDispositionCompatibilityCapability,
  recordControllerRoundTabSettlement,
  submitControllerRoundDisposition,
  type ControllerRoundDisposition,
} from '../../control-plane/facade/controller-round-relay';

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

function rhContextReadSessionId(ctx: MultiRepositoryMcpToolContext): string | undefined {
  const principal = ctx.principalId?.trim();
  if (principal) {
    const controllerInstance = ctx.controllerInstanceId?.trim() || currentControllerInstanceId();
    return `controller:${principal}:${controllerInstance}`;
  }
  const transportSession = ctx.sessionId?.trim();
  return transportSession ? `transport:${transportSession}` : undefined;
}

const RH_CONTEXT_SEMANTIC_QUERY_LIMIT = 8;
const RH_CONTEXT_SEMANTIC_LOCATION_LIMIT = 200;
const RH_CONTEXT_LEGACY_SEMANTIC_SYNTAX = '@tsnav references <repo-path>:<line>:<column> | @swiftnav references <repo-path>:<line>:<column>';

type RhContextSemanticNavigationRequest = {
  navigation: SemanticNavigationKind;
  path: string;
  line: number;
  column: number;
  tsconfig_path?: string;
  language?: string;
};

function rhContextLegacySemanticQuery(query: string): {
  retrievalQuery: string;
  requests: RhContextSemanticNavigationRequest[];
} {
  const requests: RhContextSemanticNavigationRequest[] = [];
  const directive = /(?:^|\s)@(tsnav|swiftnav)\s+(definition|references|implementations)\s+([^\s]+):(\d+):(\d+)(?:\s+tsconfig=([^\s]+))?/gi;
  const retrievalQuery = query.replace(directive, (_match, directiveKind, navigation, path, line, column, tsconfigPath) => {
    const language = String(directiveKind).toLowerCase() === 'swiftnav' ? 'swift' : 'typescript';
    requests.push({
      navigation: String(navigation).toLowerCase() as SemanticNavigationKind,
      path: String(path),
      line: Number(line),
      column: Number(column),
      language,
      ...(tsconfigPath ? { tsconfig_path: String(tsconfigPath) } : {}),
    });
    return ' ';
  }).replace(/\s+/g, ' ').trim();
  const fallback = requests.length > 0
    ? `${requests[0]!.language === 'swift' ? 'Swift' : 'TypeScript'} ${requests[0]!.navigation} ${requests[0]!.path}`
    : query;
  return { retrievalQuery: retrievalQuery || fallback, requests };
}

interface RhContextSemanticNavigationProjection {
  requested: number;
  executed: number;
  results: Record<string, unknown>[];
  errors: Array<{ index: number; code: string; message: string }>;
  providers: unknown[];
  policyDeniedLocations: number;
  policyDeniedReads: number;
  policyDeniedReadSamples: string[];
  requestTruncated: boolean;
  freshness: 'not_requested' | 'changed_during_query' | 'current_at_query';
  sourceIdentity?: Record<string, unknown>;
  staticClosure: { scope: string; status: 'not_requested' | 'incomplete' | 'complete_for_requested_symbols'; limitations: string[] };
}

async function rhContextSemanticNavigation(
  repoRoot: string,
  policy: MultiRepositoryMcpToolContext['policy'],
  value: unknown,
  repositoryIdentity: { repoId: string; checkoutId: string },
): Promise<RhContextSemanticNavigationProjection> {
  const raw = Array.isArray(value) ? value : [];
  const requests = raw.slice(0, RH_CONTEXT_SEMANTIC_QUERY_LIMIT);
  const results: Record<string, unknown>[] = [];
  const errors: Array<{ index: number; code: string; message: string }> = [];
  let anyLocationTruncated = false;
  let policyDeniedLocations = 0;
  let policyDeniedReads = 0;
  const policyDeniedReadSamples = new Set<string>();
  const semanticAccessScope = createHash('sha256')
    .update(JSON.stringify({ profile: policy.profile, readGlobs: policy.readGlobs, denyGlobs: policy.denyGlobs }))
    .digest('hex')
    .slice(0, 20);

  const fingerprintOf = (identity: ReturnType<typeof freshGitIdentity> | undefined): string | undefined => identity
    ? identity.workingTreeFingerprint
      ?? createHash('sha256').update(`${identity.head ?? ''}\n${identity.branch ?? ''}`).digest('hex').slice(0, 24)
    : undefined;
  // Semantic providers are targeted/optional, so pay the stronger fresh identity
  // sampling cost only when semantic evidence was explicitly requested.
  const sourceBefore = requests.length > 0 ? freshGitIdentity(repoRoot) : undefined;
  const sourceFingerprintBefore = fingerprintOf(sourceBefore);
  const indexedRequests: Array<{ index: number; request: SemanticNavigationRequest }> = [];

  requests.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push({ index, code: 'SEMANTIC_NAVIGATION_REQUEST_INVALID', message: 'semantic_navigation entries must be objects.' });
      return;
    }
    const item = entry as Record<string, unknown>;
    const navigation = String(item.navigation ?? '') as SemanticNavigationKind;
    const path = String(item.path ?? '').trim();
    const line = Number(item.line);
    const column = Number(item.column);
    const tsconfigPath = typeof item.tsconfig_path === 'string' && item.tsconfig_path.trim() ? item.tsconfig_path.trim() : undefined;
    const language = typeof item.language === 'string' && item.language.trim() ? item.language.trim().toLowerCase() : undefined;
    if (!['definition', 'references', 'implementations'].includes(navigation) || !path || !Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
      errors.push({ index, code: 'SEMANTIC_NAVIGATION_REQUEST_INVALID', message: 'navigation, path, and positive 1-based line/column are required.' });
      return;
    }
    const targetDecision = resolveMcpPath(repoRoot, path, policy, 'read');
    if (!targetDecision.ok) {
      errors.push({ index, code: 'SEMANTIC_NAVIGATION_TARGET_DENIED', message: targetDecision.reason ?? 'target path denied by MCP read policy.' });
      return;
    }
    indexedRequests.push({
      index,
      request: { navigation, path, line, column, ...(tsconfigPath ? { tsconfigPath } : {}), ...(language ? { language } : {}) },
    });
  });

  const allowRepositoryPath = (relativePath: string): boolean => {
    const decision = resolveMcpPath(repoRoot, relativePath, policy, 'read');
    if (decision.ok) return true;
    policyDeniedReads += 1;
    if (policyDeniedReadSamples.size < 20) policyDeniedReadSamples.add(relativePath);
    return false;
  };

  const navigationOutcomes = await defaultSemanticProviderRegistry.navigate(repoRoot, indexedRequests, {
    cacheScope: `mcp:${semanticAccessScope}`,
    sourceIdentity: sourceFingerprintBefore,
    profile: policy.profile,
    allowRepositoryPath,
  });

  for (const { index, outcome } of navigationOutcomes) {
    if (!outcome.ok) {
      errors.push({ index, code: outcome.code, message: outcome.message });
      continue;
    }
    const semantic = outcome.result;
    const allowedLocations = semantic.locations.filter((location) => {
      const decision = resolveMcpPath(repoRoot, location.path, policy, 'read');
      if (decision.ok) return true;
      policyDeniedLocations += 1;
      return false;
    });
    const truncated = allowedLocations.length > RH_CONTEXT_SEMANTIC_LOCATION_LIMIT;
    anyLocationTruncated ||= truncated;
    results.push({
      provider: semantic.providerId,
      ...(semantic.providerIdentity ? { providerIdentity: semantic.providerIdentity } : {}),
      language: semantic.language,
      navigation: semantic.navigation,
      target: semantic.target,
      locations: allowedLocations.slice(0, RH_CONTEXT_SEMANTIC_LOCATION_LIMIT),
      totalLocations: allowedLocations.length,
      returnedLocations: Math.min(allowedLocations.length, RH_CONTEXT_SEMANTIC_LOCATION_LIMIT),
      truncated,
      policyDeniedReads: semantic.policyDeniedReads ?? 0,
      ...(semantic.details ?? {}),
    });
  }

  results.sort((left, right) => {
    const leftTarget = left.target as { path?: string; line?: number; column?: number } | undefined;
    const rightTarget = right.target as { path?: string; line?: number; column?: number } | undefined;
    return String(leftTarget?.path ?? '').localeCompare(String(rightTarget?.path ?? ''))
      || Number(leftTarget?.line ?? 0) - Number(rightTarget?.line ?? 0)
      || Number(leftTarget?.column ?? 0) - Number(rightTarget?.column ?? 0);
  });

  const sourceAfter = requests.length > 0 ? freshGitIdentity(repoRoot) : undefined;
  const sourceFingerprintAfter = fingerprintOf(sourceAfter);
  const sourceChangedDuringQuery = Boolean(
    sourceBefore
    && sourceAfter
    && (sourceBefore.head !== sourceAfter.head || sourceFingerprintBefore !== sourceFingerprintAfter),
  );
  if (sourceChangedDuringQuery) {
    errors.push({
      index: -1,
      code: 'SEMANTIC_SOURCE_CHANGED_DURING_QUERY',
      message: 'Repository source identity changed while semantic providers were running. Returned locations are retained only as hints for the sampled source and are not proof for the newer source state.',
    });
  }

  const requestTruncated = raw.length > RH_CONTEXT_SEMANTIC_QUERY_LIMIT;
  const incomplete = requestTruncated || anyLocationTruncated || policyDeniedLocations > 0 || policyDeniedReads > 0 || errors.length > 0 || sourceChangedDuringQuery;
  const languages = new Set(results.map((entry) => String(entry.language ?? '')).filter(Boolean));
  const singleLanguage = languages.size === 1 ? [...languages][0] : undefined;
  const scope = singleLanguage === 'typescript'
    ? 'requested_typescript_static_relationships'
    : singleLanguage === 'swift'
      ? 'requested_swift_static_relationships'
      : singleLanguage
        ? `requested_${singleLanguage.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase()}_static_relationships`
        : languages.size > 1
          ? 'requested_multilanguage_static_relationships'
          : 'requested_semantic_static_relationships';
  return {
    requested: raw.length,
    executed: requests.length,
    results,
    errors,
    providers: defaultSemanticProviderRegistry.list(),
    policyDeniedLocations,
    policyDeniedReads,
    policyDeniedReadSamples: Array.from(policyDeniedReadSamples),
    requestTruncated,
    freshness: raw.length === 0 ? 'not_requested' : sourceChangedDuringQuery ? 'changed_during_query' : 'current_at_query',
    ...(sourceBefore ? {
      sourceIdentity: {
        repoId: repositoryIdentity.repoId,
        checkoutId: repositoryIdentity.checkoutId,
        branch: sourceBefore.branch,
        head: sourceBefore.head,
        workingTreeFingerprint: sourceFingerprintBefore,
        sampledAt: new Date(sourceBefore.sampledAt).toISOString(),
      },
    } : {}),
    staticClosure: {
      scope,
      status: raw.length === 0 ? 'not_requested' : incomplete ? 'incomplete' : 'complete_for_requested_symbols',
      limitations: ['dynamic_registration', 'string_or_config_edges', 'reflection', 'runtime_dispatch', 'stale_or_missing_language_index'],
    },
  };
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

export const RH_WORK_VERIFY_LEASE_WAIT_MS = DEFAULT_WORK_CHECK_LEASE_WAIT_MS;

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
  running?: boolean;
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
    running: observation.running,
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
  options: { allowTransportSessionRollover?: boolean } = {},
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
  if (!options.allowTransportSessionRollover && requestedSessionId && requestedSessionId !== sessionId) {
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

function bindFacadeControllerOwnership(
  ctx: MultiRepositoryMcpToolContext,
  store: { controllerHome: string; repoId: string },
  workId: string,
  identity: ReturnType<typeof authenticatedFacadeControllerIdentity>,
  options: { allowClaimIfMissing?: boolean; leaseMs?: number } = {},
) {
  const runtime = runtimeIdentitySnapshot(ctx);
  return bindControllerSessionToCurrentRuntime(store, {
    workId,
    controllerId: identity.controllerId,
    controllerType: identity.controllerType,
    sessionId: identity.sessionId,
    principalId: identity.principalId,
    controllerInstanceId: identity.controllerInstanceId,
    currentRuntimeInstanceId: runtime.running ? runtime.runtimeInstanceId : undefined,
    allowClaimIfMissing: options.allowClaimIfMissing,
    leaseMs: options.leaseMs ?? 3_600_000,
  });
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
    deliveryBaseCommit: contract.baseRevision ?? status.head ?? undefined,
    expectedHead: status.head ?? contract.baseRevision,
    permissionSnapshotVersion: currentPermissionSnapshotVersion(ctx.controllerHome, repository.repoId),
    state: 'prepared',
    createdAt: at,
    updatedAt: at,
    finalization: { validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending' },
    cleanupResponsibility: { owner: 'work_finalizer', registeredAt: at },
  });
}

function materializeFacadeWorkPlacement(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  workId: string,
  args: Record<string, unknown>,
) {
  const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
  const contract = getWorkContract(store, workId);
  if (!contract || contract.worktreePolicy.required !== true || contract.worktreeRef) return contract;
  const workspace = ensureManagedWorkspace(ctx.controllerHome, repository, {
    requestId: workId,
    title: contract.objective,
    baseRef: contract.baseRevision,
    prepareDependencies: args.needs_dependencies === true,
  });
  if (!workspace.managed || !workspace.checkoutId || !workspace.root || workspace.checkoutId === repository.activeCheckoutId) {
    throw new Error('MANAGED_WORKSPACE_NOT_MATERIALIZED');
  }
  return updateWorkContract(store, workId, {
    checkoutId: workspace.checkoutId,
    baseRevision: workspace.baseRevision ?? contract.baseRevision,
    worktreeRef: workspace.root,
    driver: { ...contract.driver, preferred: 'isolated_worktree', allowDirectEdit: false },
  });
}

function reauthorizeCancelledFacadeWork(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  workId: string,
  args: Record<string, unknown>,
): { reconstructedCheckout: boolean } {
  const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
  let work = getWorkContract(store, workId);
  if (!work || work.status !== 'cancelled') return { reconstructedCheckout: false };
  if (args.approval_confirmed !== true || args.requested_by !== 'user') {
    throw new Error(`WORK_CANCELLED_RESUME_REAUTHORIZATION_REQUIRED: ${workId}; use exact work_id with requested_by=user and approval_confirmed=true`);
  }
  const identity = authenticatedFacadeControllerIdentity(ctx, args);
  if (!work.principalId?.trim() || work.principalId.trim() !== identity.principalId) {
    throw new Error(`WORK_CANCELLED_RESUME_PRINCIPAL_MISMATCH: ${workId}`);
  }
  const owner = getControllerSession(store, workId);
  if (owner && (owner.principalId?.trim() || owner.controllerId) !== identity.principalId) {
    throw new Error(`WORK_CANCELLED_RESUME_CONTROLLER_OWNERSHIP_MISMATCH: ${workId}`);
  }
  if (work.completionReceipt || work.completionOutcome) throw new Error(`WORK_CANCELLED_RESUME_COMPLETION_CONFLICT: ${workId}`);
  if (work.reconciliations.length > 0) throw new Error(`WORK_CANCELLED_RESUME_DELIVERY_HISTORY_AMBIGUOUS: ${workId}`);
  if (work.phase !== 'cleanup' || work.phaseEvidence.cleanup.state !== 'skipped' || work.phaseEvidence.cleanup.source !== 'recorded') {
    throw new Error(`WORK_CANCELLED_RESUME_HISTORY_AMBIGUOUS: ${workId}`);
  }
  if (work.workKind !== 'repository_change' || work.worktreePolicy.required !== true) {
    throw new Error(`WORK_CANCELLED_RESUME_ISOLATED_REPOSITORY_WORK_REQUIRED: ${workId}`);
  }

  let handle = readWorkHandle(ctx.controllerHome, repository.repoId, workId);
  if (handle) {
    if (handle.repositoryId !== repository.repoId || (handle.workContractId && handle.workContractId !== workId)) {
      throw new Error(`WORK_CANCELLED_RESUME_HANDLE_IDENTITY_MISMATCH: ${workId}`);
    }
    if (handle.principalId !== identity.principalId) throw new Error(`WORK_CANCELLED_RESUME_HANDLE_PRINCIPAL_MISMATCH: ${workId}`);
    if (['committed', 'merged', 'cleaned', 'failed_terminal_cleanup'].includes(handle.state)
      || handle.finalization.commit === 'done'
      || handle.finalization.merge === 'done'
      || handle.cleanupReceipt?.complete === true) {
      throw new Error(`WORK_CANCELLED_RESUME_DELIVERY_OR_CLEANUP_CONFLICT: ${workId}`);
    }
  }

  const registryRepository = listRepositories(ctx.controllerHome, { includeRemoved: true })
    .find((candidate) => candidate.repoId === repository.repoId);
  if (!registryRepository) throw new Error(`WORK_CANCELLED_RESUME_REPOSITORY_MISSING: ${workId}`);
  const recordedCheckoutId = work.checkoutId?.trim();
  const recordedWorktree = work.worktreeRef?.trim();
  const checkoutRecord = recordedCheckoutId
    ? registryRepository.checkouts.find((candidate) => candidate.checkoutId === recordedCheckoutId)
    : undefined;
  const checkoutActive = checkoutRecord?.lifecycle === 'active';
  const worktreePresent = Boolean(recordedWorktree && existsSync(recordedWorktree));

  if (checkoutActive && worktreePresent && recordedCheckoutId && recordedWorktree) {
    const retained = selectRepositoryCheckout(registryRepository, recordedCheckoutId);
    if (resolve(retained.canonicalRoot) !== resolve(recordedWorktree)) {
      throw new Error(`WORK_CANCELLED_RESUME_CHECKOUT_REUSED: ${workId}`);
    }
    if (!handle) throw new Error(`WORK_CANCELLED_RESUME_HANDLE_REQUIRED: ${workId}`);
    if (handle.checkoutId !== recordedCheckoutId || resolve(handle.worktreePath) !== resolve(recordedWorktree)) {
      throw new Error(`WORK_CANCELLED_RESUME_CHECKOUT_OWNERSHIP_MISMATCH: ${workId}`);
    }
    const status = repositoryGitStatus(retained);
    if (!status.branch || status.branch !== handle.branch) throw new Error(`WORK_CANCELLED_RESUME_BRANCH_OWNERSHIP_MISMATCH: ${workId}`);
    writeWorkHandle(ctx.controllerHome, {
      ...handle,
      principalId: identity.principalId,
      sessionId: identity.sessionId,
      updatedAt: new Date().toISOString(),
    });
    resumeRetainedCancelledWorkContract(store, workId, {
      principalId: identity.principalId,
      controllerInstanceId: identity.controllerInstanceId,
      summary: 'Explicit current user re-authorized the same retained cancelled Work; exact managed checkout ownership was revalidated.',
    });
    return { reconstructedCheckout: false };
  }

  if (checkoutActive) throw new Error(`WORK_CANCELLED_RESUME_PRESERVATION_AMBIGUOUS: ${workId}`);
  if (!recordedCheckoutId || !recordedWorktree || !handle) throw new Error(`WORK_CANCELLED_RESUME_HANDLE_REQUIRED: ${workId}`);

  const actualChangedPaths = work.scopeEvidence?.actualChangedPaths;
  if (!actualChangedPaths || actualChangedPaths.length !== 0
    || work.checks.length !== 0
    || work.checkRefs.length !== 0
    || work.evidenceState !== 'none') {
    throw new Error(`WORK_CANCELLED_RESUME_ZERO_DELTA_PROOF_REQUIRED: ${workId}`);
  }
  const recordedBase = work.baseRevision?.trim();
  if (!recordedBase) throw new Error(`WORK_CANCELLED_RESUME_BASE_REVISION_REQUIRED: ${workId}`);
  const baseRevision = gitCommitAtRef(repository.canonicalRoot, recordedBase);
  if (!baseRevision) throw new Error(`WORK_CANCELLED_RESUME_BASE_REVISION_MISSING: ${workId}`);
  const handleBase = handle.baseCommit ? gitCommitAtRef(repository.canonicalRoot, handle.baseCommit) : undefined;
  const handleHead = handle.expectedHead ? gitCommitAtRef(repository.canonicalRoot, handle.expectedHead) : undefined;
  if ((handle.baseCommit && handleBase !== baseRevision) || (handle.expectedHead && handleHead !== baseRevision)) {
    throw new Error(`WORK_CANCELLED_RESUME_REVISION_AMBIGUOUS: ${workId}`);
  }
  if (handle.checkoutId !== recordedCheckoutId || resolve(handle.worktreePath) !== resolve(recordedWorktree)) {
    throw new Error(`WORK_CANCELLED_RESUME_CHECKOUT_OWNERSHIP_MISMATCH: ${workId}`);
  }
  if (handle.branch) {
    const historicalBranchHead = gitCommitAtRef(repository.canonicalRoot, `refs/heads/${handle.branch}`);
    if (historicalBranchHead && historicalBranchHead !== baseRevision) {
      throw new Error(`WORK_CANCELLED_RESUME_UNIQUE_COMMIT_CONFLICT: ${workId}`);
    }
  }
  if (worktreePresent) {
    const retainedSnapshot = gitWorktreeSnapshot(recordedWorktree);
    if (!retainedSnapshot || !retainedSnapshot.clean || retainedSnapshot.head !== baseRevision || (handle.branch && retainedSnapshot.branch !== handle.branch)) {
      throw new Error(`WORK_CANCELLED_RESUME_ZERO_DELTA_PHYSICAL_CONFLICT: ${workId}`);
    }
  }

  const branchName = `work/resume-${workId.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 42)}-${baseRevision.slice(0, 12)}`;
  const existingResumeBranch = gitCommitAtRef(repository.canonicalRoot, `refs/heads/${branchName}`);
  if (existingResumeBranch && existingResumeBranch !== baseRevision) {
    throw new Error(`WORK_CANCELLED_RESUME_RECONSTRUCTION_BRANCH_CONFLICT: ${workId}`);
  }
  const workspace = ensureManagedWorkspace(ctx.controllerHome, repository, {
    requestId: `${workId}:explicit-user-resume:${baseRevision}`,
    title: `${work.objective} explicit user resume`,
    branchName,
    baseRef: baseRevision,
    prepareDependencies: args.needs_dependencies === true,
  });
  if (!workspace.managed || !workspace.checkoutId || !workspace.root || !workspace.branch) {
    throw new Error(`WORK_CANCELLED_RESUME_RECONSTRUCTION_FAILED: ${workId}`);
  }
  const refreshedRepository = listRepositories(ctx.controllerHome, { includeRemoved: true })
    .find((candidate) => candidate.repoId === repository.repoId);
  if (!refreshedRepository) throw new Error(`WORK_CANCELLED_RESUME_REPOSITORY_MISSING: ${workId}`);
  const reconstructed = selectRepositoryCheckout(refreshedRepository, workspace.checkoutId);
  const reconstructedStatus = repositoryGitStatus(reconstructed);
  if (!reconstructedStatus.clean || reconstructedStatus.head !== baseRevision || reconstructedStatus.branch !== workspace.branch) {
    throw new Error(`WORK_CANCELLED_RESUME_RECONSTRUCTION_REVISION_MISMATCH: ${workId}`);
  }

  work = updateWorkContract(store, workId, {
    checkoutId: workspace.checkoutId,
    worktreeRef: workspace.root,
    baseRevision,
    controllerInstanceId: identity.controllerInstanceId,
  });
  const now = new Date().toISOString();
  handle = writeWorkHandle(ctx.controllerHome, {
    ...handle,
    principalId: identity.principalId,
    sessionId: identity.sessionId,
    checkoutId: workspace.checkoutId,
    worktreePath: workspace.root,
    branch: workspace.branch,
    sourceCheckoutId: repository.activeCheckoutId,
    managedWorktree: true,
    baseCommit: baseRevision,
    deliveryBaseCommit: baseRevision,
    expectedHead: baseRevision,
    state: 'prepared',
    validatedInputFingerprint: undefined,
    failureReason: undefined,
    cleanupReceipt: undefined,
    finalization: { validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending' },
    updatedAt: now,
  });
  resumeRetainedCancelledWorkContract(store, workId, {
    principalId: identity.principalId,
    controllerInstanceId: identity.controllerInstanceId,
    summary: 'Explicit current user re-authorized the same cancelled Work; prior managed checkout was absent and a fresh isolated checkout was reconstructed at the exact zero-delta base revision.',
    checkoutId: workspace.checkoutId,
    worktreeRef: workspace.root,
  });
  return { reconstructedCheckout: true };
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
  let handle = readWorkHandle(ctx.controllerHome, repository.repoId, workId)
    ?? recoverTerminalWorkHandle(ctx.controllerHome, repository.repoId, workId);
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
    remote_write: args.remote_write === true,
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
    // A running Process is not itself a request to poll. The controller should
    // keep making independent progress, then join only at its real dependency
    // boundary through the Process lifecycle surface.
    suggestedNextActions: [],
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
  const planId = typeof args.plan_id === 'string' ? args.plan_id.trim() : '';
  const planStepId = typeof args.plan_step_id === 'string' ? args.plan_step_id.trim() : '';

  if (planId && !planStepId) {
    const plan = getPlanContract(store, planId);
    if (!plan) {
      const facade = buildFacadeResult({ status: 'not_found', summary: `PlanContract ${planId} not found.`, data: { operation: repairOperation, dryRun, planId, repaired: false } });
      return result(facade as unknown as Record<string, unknown>, true);
    }
    if (plan.status !== 'draft') {
      const facade = buildFacadeResult({ status: 'blocked', summary: `PLAN_DRAFT_REPAIR_STATUS_INVALID: ${plan.planId}:${plan.status}`, data: { operation: repairOperation, dryRun, planId, repaired: false } });
      return result(facade as unknown as Record<string, unknown>, true);
    }
    if (repairOperation !== 'repair' || dryRun) {
      const facade = buildFacadeResult({
        summary: `PlanContract ${plan.planId} is a draft. Exact in-place repair is available; the Plan identity and Requirement authority are preserved and only a fully valid draft may be persisted.`,
        data: { operation: repairOperation, dryRun, plan: summarizePlanContract(plan), repaired: false, repairRequired: true },
        suggestedNextActions: [{ label: 'Repair this exact draft Plan', tool: 'rh_work', operation: 'repair', payload: { plan_id: plan.planId, repair_operation: 'repair', dry_run: false }, risk: 'workspace_write', confidence: 'high' }],
      });
      return result(facade as unknown as Record<string, unknown>);
    }
    const rawSteps = Array.isArray(args.plan_steps)
      ? args.plan_steps
      : plan.steps.map((step) => ({
          id: step.id, objective: step.objective, dependencies: step.dependencies, authoritative_files: step.authoritativeFiles,
          allowed_paths: step.allowedPaths, forbidden_paths: step.forbiddenPaths, check_ids: step.checks, acceptance_criteria: step.acceptanceCriteria,
        }));
    const steps = rawSteps
      .filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === 'object' && !Array.isArray(step))
      .map((step) => ({
        id: String(step.id ?? ''),
        objective: String(step.objective ?? ''),
        dependencies: Array.isArray(step.dependencies) ? step.dependencies.map(String) : [],
        authoritativeFiles: Array.isArray(step.authoritative_files) ? step.authoritative_files.map(String) : [],
        allowedPaths: Array.isArray(step.allowed_paths) ? step.allowed_paths.map(String) : [],
        forbiddenPaths: Array.isArray(step.forbidden_paths) ? step.forbidden_paths.map(String) : [],
        checks: Array.isArray(step.check_ids) ? step.check_ids.map(String) : [],
        acceptanceCriteria: Array.isArray(step.acceptance_criteria) ? step.acceptance_criteria.map(String) : [],
      }));
    const availableChecks = listControllerChecks(repository.canonicalRoot);
    const normalizedPlanChecks = normalizeCheckIds(steps.flatMap((step) => step.checks), availableChecks);
    if (normalizedPlanChecks.invalidCheckIds.length > 0) {
      const facade = buildFacadeResult({
        status: 'failed',
        summary: `PLAN_CHECKS_INVALID: ${normalizedPlanChecks.invalidCheckIds.join(', ')}. Draft repair was not persisted.`,
        data: { operation: repairOperation, dryRun: false, planId, repaired: false, normalizedChecks: normalizedPlanChecks, registeredCheckIds: availableChecks.map((check) => check.id).slice(0, 80) },
        suggestedNextActions: [],
      });
      return result(facade as unknown as Record<string, unknown>, true);
    }
    try {
      const repaired = await repairDraftPlanContractAsync(store, planId, {
        scopeKey: typeof args.scope_key === 'string' ? args.scope_key : plan.scopeKey,
        sourceRevision: typeof args.source_revision === 'string' ? args.source_revision : plan.sourceRevision,
        goal: typeof args.objective === 'string' ? args.objective : plan.goal,
        nonGoals: Array.isArray(args.non_goals) ? args.non_goals.map(String) : plan.nonGoals,
        assumptions: Array.isArray(args.assumptions) ? args.assumptions.map(String) : plan.assumptions,
        resolvedDecisions: Array.isArray(args.resolved_decisions) ? args.resolved_decisions.map(String) : plan.resolvedDecisions,
        stopConditions: Array.isArray(args.stop_conditions) ? args.stop_conditions.map(String) : plan.stopConditions,
        replanConditions: Array.isArray(args.replan_conditions) ? args.replan_conditions.map(String) : plan.replanConditions,
        integrationStrategy: typeof args.integration_strategy === 'string' ? args.integration_strategy : plan.integrationStrategy,
        steps,
      });
      const facade = buildFacadeResult({
        summary: `PlanContract ${repaired.planId} draft repaired in place; identity and Requirement authority were preserved.`,
        data: { operation: repairOperation, dryRun: false, plan: summarizePlanContract(repaired), repaired: true, replacementPlanCreated: false },
        suggestedNextActions: [{ label: 'Approve reviewed plan', tool: 'rh_work', operation: 'plan_approve', payload: { plan_id: repaired.planId }, risk: 'workspace_write', confidence: 'medium' }],
      });
      return result(facade as unknown as Record<string, unknown>);
    } catch (error) {
      const facade = buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'PLAN_DRAFT_REPAIR_FAILED', data: { operation: repairOperation, dryRun: false, planId, repaired: false } });
      return result(facade as unknown as Record<string, unknown>, true);
    }
  }

  if (planStepId && !planId) {
    const facade = buildFacadeResult({ status: 'blocked', summary: 'PLAN_STEP_REPAIR_CONTEXT_REQUIRED: plan_id and plan_step_id are both required.', data: { operation: repairOperation, dryRun, repaired: false } });
    return result(facade as unknown as Record<string, unknown>, true);
  }

  if (planId && planStepId) {
    const plan = getPlanContract(store, planId);
    const step = plan?.steps.find((candidate) => candidate.id === planStepId);
    if (!plan || !step) {
      const facade = buildFacadeResult({ status: 'not_found', summary: !plan ? `PlanContract ${planId} not found.` : `PLAN_STEP_NOT_FOUND: ${planStepId}`, data: { operation: repairOperation, dryRun, planId, planStepId, repaired: false } });
      return result(facade as unknown as Record<string, unknown>, true);
    }
    if (!step.workId) {
      const facade = buildFacadeResult({ summary: `Plan step ${planId}/${planStepId} has no Work binding to repair.`, data: { operation: repairOperation, dryRun, planId, planStepId, repaired: false, repairRequired: false } });
      return result(facade as unknown as Record<string, unknown>);
    }
    const boundWork = getWorkContract(store, step.workId);
    if (boundWork) {
      if (['completed', 'failed', 'cancelled'].includes(boundWork.status)) {
        if (repairOperation !== 'repair' || dryRun) {
          const facade = buildFacadeResult({
            summary: `PLAN_STEP_TERMINAL_WORK_RECONCILIABLE: ${planId}/${planStepId} is bound to existing terminal Work ${boundWork.workId}. Explicit repair can project that exact Work without creating a replacement.`,
            data: { operation: repairOperation, dryRun, planId, planStepId, boundWorkId: boundWork.workId, repaired: false, repairRequired: true, reusedExistingWork: true },
            suggestedNextActions: [{ label: 'Project existing terminal Work', tool: 'rh_work', operation: 'repair', payload: { plan_id: planId, plan_step_id: planStepId, repair_operation: 'repair', dry_run: false }, risk: 'workspace_write', confidence: 'high' }],
          });
          return result(facade as unknown as Record<string, unknown>);
        }
        try {
          const reconciledPlan = completePlanStepForWork(store, { planId, stepId: planStepId, work: boundWork });
          const facade = buildFacadeResult({
            summary: `Reconciled Plan step ${planId}/${planStepId} from its existing terminal Work ${boundWork.workId}; no replacement Work was created.`,
            data: { operation: repairOperation, dryRun: false, plan: summarizePlanContract(reconciledPlan), boundWorkId: boundWork.workId, repaired: true, reusedExistingWork: true },
          });
          return result(facade as unknown as Record<string, unknown>);
        } catch (error) {
          const facade = buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'PLAN_STEP_TERMINAL_WORK_RECONCILIATION_FAILED', data: { operation: repairOperation, dryRun: false, planId, planStepId, boundWorkId: boundWork.workId, repaired: false } });
          return result(facade as unknown as Record<string, unknown>, true);
        }
      }
      const facade = buildFacadeResult({
        status: 'blocked',
        summary: `PLAN_STEP_BOUND_WORK_STILL_EXISTS: ${planId}/${planStepId} is bound to active Work ${boundWork.workId}; continue that exact Work instead of repairing or replacing it.`,
        data: { operation: repairOperation, dryRun, planId, planStepId, boundWorkId: boundWork.workId, repaired: false, repairRequired: false },
        suggestedNextActions: [{ label: 'Continue existing Work', tool: 'rh_work', operation: 'continue', payload: { work_id: boundWork.workId }, risk: 'readonly', confidence: 'high' }],
      });
      return result(facade as unknown as Record<string, unknown>, true);
    }
    const conflicting = listWorkContracts({ ...store, status: 'active', limit: 200 })
      .filter((candidate) => candidate.planId === planId && candidate.planStepId === planStepId && candidate.workId !== step.workId);
    if (conflicting.length > 0) {
      const facade = buildFacadeResult({
        status: 'blocked',
        summary: `PLAN_STEP_REPAIR_CONFLICT: ${planId}/${planStepId} is bound to missing Work ${step.workId}, but ${conflicting.length} other active Work record(s) claim the same step. Resolve the conflicting authority before changing the Plan binding.`,
        data: { operation: repairOperation, dryRun, planId, planStepId, boundWorkId: step.workId, conflictingWorkIds: conflicting.map((candidate) => candidate.workId), repaired: false },
      });
      return result(facade as unknown as Record<string, unknown>, true);
    }
    if (repairOperation !== 'repair' || dryRun) {
      const facade = buildFacadeResult({
        summary: `PLAN_STEP_DANGLING_WORK_BINDING: ${planId}/${planStepId} points to missing Work ${step.workId}. Exact repair is available and will clear only this unchanged ghost binding.`,
        data: { operation: repairOperation, dryRun, planId, planStepId, boundWorkId: step.workId, repaired: false, repairRequired: true },
        suggestedNextActions: [{ label: 'Repair exact dangling binding', tool: 'rh_work', operation: 'repair', payload: { plan_id: planId, plan_step_id: planStepId, repair_operation: 'repair', dry_run: false }, risk: 'workspace_write', confidence: 'high' }],
      });
      return result(facade as unknown as Record<string, unknown>);
    }
    try {
      const repairedPlan = repairDanglingPlanStepWorkBinding(store, {
        planId,
        stepId: planStepId,
        expectedWorkId: step.workId,
        reason: 'Explicit Controller repair confirmed that the exact bound Work record is absent and no other active primary Work claims this Plan step.',
      });
      const facade = buildFacadeResult({
        summary: `Repaired dangling Plan step binding ${planId}/${planStepId}; ${step.workId} was cleared without creating a replacement Work.`,
        data: { operation: repairOperation, dryRun: false, plan: summarizePlanContract(repairedPlan), boundWorkId: step.workId, repaired: true, replacementWorkCreated: false },
      });
      return result(facade as unknown as Record<string, unknown>);
    } catch (error) {
      const facade = buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'PLAN_STEP_DANGLING_WORK_REPAIR_FAILED', data: { operation: repairOperation, dryRun: false, planId, planStepId, boundWorkId: step.workId, repaired: false } });
      return result(facade as unknown as Record<string, unknown>, true);
    }
  }

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
): { sourceRevision?: string; workspaceFingerprint?: string; workspaceChangedPaths?: string[]; reconciledProcessIds: string[]; workBoundProcessEvidenceIds: string[] } {
  const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
  const workContract = getWorkContract(store, workId);
  if (!workContract || workContract.completionReceipt) return { reconciledProcessIds: [], workBoundProcessEvidenceIds: [] };

  let verificationRepository: ReturnType<typeof selectRepositoryCheckout>;
  try {
    verificationRepository = workContract.checkoutId
      ? selectRepositoryCheckout(repository, workContract.checkoutId, { allowArchived: true })
      : repository;
  } catch {
    return { reconciledProcessIds: [], workBoundProcessEvidenceIds: [] };
  }
  const verificationStatus = repositoryGitStatus(verificationRepository);
  const sourceRevision = verificationStatus.head ?? undefined;
  if (!sourceRevision) return { reconciledProcessIds: [], workBoundProcessEvidenceIds: [] };
  const verificationHandle = readWorkHandle(ctx.controllerHome, repository.repoId, workId);
  const deliveryBaseRevision = verificationHandle
    ? workDeliveryBaseRevision(verificationHandle)
    : workContract.baseRevision;
  const committedPaths = deliveryBaseRevision
    ? workChangedPaths(verificationRepository.canonicalRoot, deliveryBaseRevision, sourceRevision)
    : [];
  const workspaceChangedPaths = [...new Set([
    ...committedPaths,
    ...verificationStatus.staged,
    ...verificationStatus.unstaged,
    ...verificationStatus.untracked,
  ])].sort();
  const workspaceFingerprint = workspaceValidationFingerprint(verificationRepository.canonicalRoot, verificationStatus);
  const workBoundProcessEvidenceIds = workContract.workKind === 'repository_change' && workContract.checks.length === 0
    ? listWorkBoundRepositoryProcessEvidence({
        controllerHome: ctx.controllerHome,
        repoId: repository.repoId,
        checkoutId: verificationRepository.activeCheckoutId,
        workId,
      }).map((evidence) => evidence.processId)
    : [];
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

  return { sourceRevision, workspaceFingerprint, workspaceChangedPaths, reconciledProcessIds, workBoundProcessEvidenceIds };
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
  const workContract = workId ? getWorkContract(store, workId) : undefined;
  if (workId && (!workContract || workContract.status === 'completed' || workContract.status === 'cancelled' || workContract.status === 'failed')) {
    const facade = verifyGoalWorkloop(workloopCtx, { workId, checkId });
    return result(facade as unknown as Record<string, unknown>, facade.status === 'failed');
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
    const registeredCheck = checks.find((entry) => entry.id === normalizedCheckId);
    const durableClassCheck = checkRequiresDurableWorkflow(normalizedCheckId, registeredCheck);
    let allowDurableCheckExecution = false;
    if (durableClassCheck && workContract?.checks.includes(normalizedCheckId) && !workContract.completionReceipt && workContract.status === 'running') {
      try {
        const identity = authenticatedFacadeControllerIdentity(ctx, args);
        const owner = getControllerSession(store, workId);
        const ownerPrincipal = owner?.principalId?.trim() || owner?.controllerId;
        allowDurableCheckExecution = Boolean(
          owner
          && owner.controllerId === identity.controllerId
          && ownerPrincipal === identity.principalId
          && owner.controllerInstanceId === identity.controllerInstanceId,
        );
      } catch {
        // Durable-class checks remain deferred when the authenticated claim cannot
        // be proven exactly. The lower Process Runtime never infers authority.
        allowDurableCheckExecution = false;
      }
    }
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
      allowDurableCheckExecution,
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
        const detailLevel = args.detail_level === 'detail' ? 'detail' : 'summary';
        if (detailLevel === 'summary') {
          const startedAt = performance.now();
          const observation = observeRuntimeStatus(ctx.controllerHome);
          // Summary answers only whether this repository can work now. Reuse one
          // porcelain-v2 sample for branch/HEAD/dirty and avoid the full Git
          // status/diff-stat, access-policy, and inventory construction paths.
          const repositoryIdentity = cachedGitIdentity(repository.canonicalRoot);
          const runtimeGeneration = readRuntimeGeneration(ctx.controllerHome);
          const runtimeSource = runtimeSourceSnapshotStatus(
            runtimeGeneration?.source,
            ctx.runtimeSourceRoot,
          );
          const sourceSnapshotStale = runtimeSource.restartRequired;
          const toolset = await import('../../../cli/mcp/toolset');
          const exposure = toolset.controllerToolSurfaceStatus(ctx);
          const toolSurfaceReady = exposure.ready && exposure.missingToolNames.length === 0;
          const ready = observation.ready && toolSurfaceReady && !sourceSnapshotStale;
          const reasonCodes = [...observation.reasonCodes];
          if (!toolSurfaceReady) reasonCodes.push('MCP_TOOL_SURFACE_INCOMPLETE');
          if (sourceSnapshotStale) reasonCodes.push(runtimeSource.code === 'RUNTIME_SOURCE_SNAPSHOT_MISSING'
            ? 'RUNTIME_SOURCE_SNAPSHOT_MISSING'
            : runtimeSource.code === 'RUNTIME_SOURCE_CURRENT_UNAVAILABLE'
              ? 'RUNTIME_SOURCE_CURRENT_UNAVAILABLE'
              : 'RUNTIME_SOURCE_SNAPSHOT_STALE');
          const runtimeReadiness = observation.snapshot?.readiness;
          const releaseDiagnostic = runtimeReadiness?.diagnostics.releaseCoherence;
          const activeWorkSnapshot = listWorkContracts({ ...store, status: 'active', limit: 3 }).map((entry) => ({
            workId: entry.workId,
            status: entry.status,
            mode: entry.mode,
            objective: entry.objective.slice(0, 160),
            semantics: buildWorkContinuationSnapshot(entry).semantics,
            nextSafeAction: buildWorkContinuationSnapshot(entry).nextSafeAction,
          }));
          const activePlanSnapshot = listPlanContracts({ ...store, status: 'active', limit: 3 }).map(summarizePlanContract);
          const pendingHandoffSnapshot = listHandoffItems({ ...store, status: 'pending', limit: 4 });
          const preferredFacadeTools = ['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work'] as const;
          const facade = buildFacadeResult({
            status: ready ? 'ok' : 'blocked',
            summary: ready ? 'Controller and MCP tool surface are ready for bounded work.' : 'Controller or MCP tool surface needs attention before work.',
            data: {
              operation,
              repoId: repository.repoId,
              readiness: {
                ready,
                reasonCodes: [...new Set(reasonCodes)],
                diagnostics: {
                  runtime: { ready: observation.ready },
                  runtimeReadiness: runtimeReadiness ? {
                    observedAt: runtimeReadiness.observedAt,
                    database: runtimeReadiness.diagnostics.database,
                    scheduler: runtimeReadiness.diagnostics.scheduler,
                    releaseCoherence: runtimeReadiness.diagnostics.releaseCoherence,
                    mcpEndToEnd: runtimeReadiness.diagnostics.mcpEndToEnd,
                  } : undefined,
                  toolSurface: {
                    ready: toolSurfaceReady,
                    expectedToolCount: exposure.expectedToolNames.length,
                    actualToolCount: exposure.actualToolNames.length,
                    observation: 'computed',
                    missingTools: exposure.missingToolNames,
                    unexpectedTools: exposure.unexpectedToolNames,
                    duplicateTools: exposure.duplicateToolNames,
                    fingerprint: exposure.fingerprint,
                    schemaStableAcrossAccessModes: exposure.schemaStableAcrossAccessModes,
                  },
                  semantics: {
                    executionReady: observation.ready,
                    maintenanceHealthy: null,
                    maintenanceCandidateCount: 0,
                    releaseReady: releaseDiagnostic?.outcome === 'pass',
                    executionBlockers: observation.ready ? [] : observation.reasonCodes,
                    releaseBlockers: releaseDiagnostic?.outcome === 'fail' && releaseDiagnostic.reasonCode ? [releaseDiagnostic.reasonCode] : [],
                  },
                  sourceCoherence: { ready: !sourceSnapshotStale, reasons: runtimeSource.reasons },
                },
                observedAt: observation.observedAt,
              },
              repositoryState: {
                branch: repositoryIdentity.branch,
                head: repositoryIdentity.head,
                dirty: repositoryIdentity.dirty,
                observedAt: new Date().toISOString(),
                sourceSnapshotAgeMs: runtimeGeneration?.source.observedAt
                  ? Math.max(0, Date.now() - Date.parse(runtimeGeneration.source.observedAt))
                  : undefined,
                sourceSnapshotStale,
                sourceSnapshotReasons: runtimeSource.reasons,
                runtimeSourceDirty: runtimeSource.current?.dirty === true,
              },
              toolArchitecture: {
                facadeTools: [...preferredFacadeTools],
                domainSchemaLoading: 'status_summary_runtime_snapshot',
              },
              toolSurface: preferredFacadeTools.filter((tool) => exposure.actualToolNames.includes(tool)),
              toolSurfaceStatus: {
                ready: toolSurfaceReady,
                expectedToolCount: exposure.expectedToolNames.length,
                actualToolCount: exposure.actualToolNames.length,
                observation: 'computed',
                missingTools: exposure.missingToolNames,
                unexpectedTools: exposure.unexpectedToolNames,
                duplicateTools: exposure.duplicateToolNames,
                fingerprint: exposure.fingerprint,
                schemaStableAcrossAccessModes: exposure.schemaStableAcrossAccessModes,
              },
              controllerSnapshot: {
                activeWork: activeWorkSnapshot,
                activePlans: activePlanSnapshot,
                pendingHandoffCount: pendingHandoffSnapshot.length,
                pendingHandoffs: pendingHandoffSnapshot.slice(0, 3).map((item) => ({
                  id: item.id,
                  workId: item.workId,
                  title: item.title.slice(0, 96),
                  severity: item.severity,
                  updatedAt: item.updatedAt,
                })),
                bounded: true,
                nextDetail: 'Use rh_context(work_id=...) or rh_work(plan_get) only when the next decision requires more detail.',
              },
            },
            suggestedNextActions: [{
              label: 'Read repository context',
              tool: 'rh_context',
              operation: 'get',
              risk: 'readonly',
              confidence: 'medium',
            }],
            rawAvailable: false,
            detailLevel,
          });
          const payload = facade as unknown as Record<string, unknown>;
          payload.responseMeta = {
            serverDurationMs: Number((performance.now() - startedAt).toFixed(2)),
            structuredPayloadBytes: 0,
          };
          (payload.responseMeta as { structuredPayloadBytes: number }).structuredPayloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
          return result(payload, facade.status !== 'ok');
        }
        const detailTimingStartedAt = performance.now();
        let detailTimingMark = detailTimingStartedAt;
        const detailPhaseTimingsMs: Record<string, number> = {};
        const markDetailPhase = (phase: string): void => {
          const now = performance.now();
          detailPhaseTimingsMs[phase] = Number((now - detailTimingMark).toFixed(2));
          detailTimingMark = now;
        };
        const readiness = await controllerReadinessEvidence(ctx, repository);
        markDetailPhase('readiness');
        const liveGit = gitSnapshot(repository.canonicalRoot);
        markDetailPhase('git');
        // Compare startup Runtime Source against the Controller package authority —
        // never against the selected execution repository.
        const runtimeSource = runtimeSourceSnapshotStatus(readiness.daemon.source, ctx.runtimeSourceRoot);
        const sourceSnapshotStale = runtimeSource.restartRequired;
        // Dynamic import avoids a static cycle: toolset.ts composes runtimeToolDefinitions.
        const toolset = await import('../../../cli/mcp/toolset');
        const exposure = toolset.controllerExposureSnapshot(ctx);
        const localRegisteredToolNames = toolset.allControllerToolDefinitions(ctx).map((tool) => tool.name).sort();
        markDetailPhase('tool_surface');
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
        markDetailPhase('maintenance');
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
        // Always prefer stored plugin manifests on rh_status detail. Live host probes
        // (Xcode/simctl, etc.) must not stall Managed MCP gateways on reconnect/status.
        const manifests = listAssistantPluginManifests(ctx.controllerHome, repository, {
          preferStored: true,
        });
        const capabilities = listCapabilityDescriptors(manifests);
        markDetailPhase('plugins');
        const pendingHandoffs = listHandoffItems({ ...store, status: 'pending', limit: 20 });
        const activeContracts = listWorkContracts({ ...store, status: 'active', limit: 200 });
        markDetailPhase('work_state');
        const activePrimaryWork = activeContracts.filter((contract) => (contract.lifecycleRole ?? 'primary') === 'primary');
        const activeExecutionChildren = activeContracts.filter((contract) => contract.lifecycleRole === 'execution_child');
        // Current Runtime activity is owned by the in-memory Process monitor set.
        // Do not route an interactive status read through the retired cross-restart
        // recovery index, which may contain historical starting/running records.
        const activeProcessRecords = processRuntimeResourceDiagnostics().activeProcessIds
          .map((processId) => getProcessRecord(ctx.controllerHome, repository.repoId, processId))
          .filter((process): process is NonNullable<typeof process> => Boolean(process && isManagedProcessActive(process)));
        markDetailPhase('process_state');
        const activeProcessWorkIds = new Set(activeProcessRecords.map((process) => process.workId).filter((workId): workId is string => Boolean(workId)));
        const activeControllerWorkIds = new Set(activePrimaryWork.filter((contract) => Boolean(getControllerSession({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, contract.workId))).map((contract) => contract.workId));
        const executingPrimaryWorkIds = new Set([...activeProcessWorkIds, ...activeControllerWorkIds].filter((workId) => activePrimaryWork.some((contract) => contract.workId === workId)));
        markDetailPhase('controller_sessions');
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
        markDetailPhase('response_build');
        const payload = facade as unknown as Record<string, unknown>;
        payload.responseMeta = {
          serverDurationMs: Number((performance.now() - detailTimingStartedAt).toFixed(2)),
          phaseTimingsMs: detailPhaseTimingsMs,
        };
        return result(payload, facade.status !== 'ok');
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
              const released = releaseObservedControllerSession(store, {
                workId: item.workId,
                actor: `handoff-create:${ctx.principalId.trim()}`,
                owner,
              });
              ownershipReleased = released.allowed;
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
          const legacySemanticQuery = rhContextLegacySemanticQuery(query);
          const retrievalQuery = legacySemanticQuery.retrievalQuery;
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
          const requestedCheckIds = list(args.requested_check_ids);
          // Source retrieval is the default Context responsibility. Check
          // readiness is only meaningful when the controller has named the
          // checks it is about to use, so do not pay its Git/dependency/schedule
          // preflight cost for every broad search.
          const checks = requestedCheckIds.length > 0
            ? listControllerChecks(repository.canonicalRoot)
            : [];
          const executionReadiness = requestedCheckIds.length > 0
            ? repositoryExecutionReadiness(repository.canonicalRoot, checks, requestedCheckIds, {
                repoId: repository.repoId,
                checkoutId: repository.activeCheckoutId,
              })
            : undefined;
          const pack = await buildControllerContextPackAsync(repository.canonicalRoot, ctx.policy, {
            description: retrievalQuery,
            // Short code-like queries remain useful exact lexical needles. Long
            // semantic prompts are already tokenized from description; adding the
            // whole prompt as an exact needle prevents batch-search early exit and
            // forces a full bounded repository scan for a phrase that will not match.
            searchTerms: retrievalQuery.length <= 160 ? [retrievalQuery] : undefined,
            knownPaths: list(args.known_paths),
            includeGlobs: list(args.include_globs),
            excludeGlobs: list(args.exclude_globs),
            maxFiles: typeof args.max_files === 'number' ? args.max_files : undefined,
            maxSnippets: typeof args.max_snippets === 'number' ? args.max_snippets : undefined,
            structuralContext,
            structuralIndexRoot: structuralContext === 'off' ? undefined : structuralIndexRoot(repository),
            retrievalMode,
            impactDomains,
            session: rhContextReadSessionId(ctx)
              ? { sessionId: rhContextReadSessionId(ctx)!, repoId: repository.repoId, checkoutId: repository.activeCheckoutId }
              : undefined,
          });
          const explicitSemanticNavigation = Array.isArray(args.semantic_navigation) ? args.semantic_navigation : [];
          const semanticRequests = [...explicitSemanticNavigation, ...legacySemanticQuery.requests];
          const semanticNavigation = {
            ...await rhContextSemanticNavigation(repository.canonicalRoot, ctx.policy, semanticRequests, { repoId: repository.repoId, checkoutId: repository.activeCheckoutId }),
            requestSource: explicitSemanticNavigation.length > 0 && legacySemanticQuery.requests.length > 0
              ? 'schema_and_query'
              : explicitSemanticNavigation.length > 0
                ? 'semantic_navigation'
                : legacySemanticQuery.requests.length > 0
                  ? 'query_compatibility'
                  : 'none',
            compatibilityQuerySyntax: RH_CONTEXT_LEGACY_SEMANTIC_SYNTAX,
          };
          const semanticReasonCodes = Array.from(new Set([
            ...semanticNavigation.errors.map((entry) => `semantic.${String(entry.code ?? 'provider_error').toLowerCase()}`),
            ...(semanticNavigation.requestTruncated ? ['semantic.request_truncated'] : []),
            ...(semanticNavigation.policyDeniedLocations > 0 || semanticNavigation.policyDeniedReads > 0 ? ['semantic.policy_denied'] : []),
            ...(semanticNavigation.freshness === 'changed_during_query' ? ['semantic.source_changed_during_query'] : []),
            ...(semanticNavigation.requested > 0 && semanticNavigation.staticClosure.status !== 'complete_for_requested_symbols' ? ['semantic.static_closure_incomplete'] : []),
          ]));
          const semanticUnavailable = semanticNavigation.requested > 0
            && semanticNavigation.results.length === 0
            && semanticNavigation.errors.length > 0
            && semanticNavigation.errors.every((entry) => /UNAVAILABLE|NOT_AVAILABLE|NOT_READY|MISSING|NOT_FOUND|BUILD_SETTINGS|BUILD_SERVER/i.test(String(entry.code ?? '')));
          const semanticReadinessStatus = semanticNavigation.requested === 0
            ? 'not_requested' as const
            : semanticNavigation.results.length === 0 && semanticNavigation.errors.length > 0
              ? semanticUnavailable ? 'unavailable' as const : 'error' as const
              : semanticNavigation.staticClosure.status === 'complete_for_requested_symbols' && semanticReasonCodes.length === 0
                ? 'ready' as const
                : 'partial' as const;
          const readinessStatus = pack.readiness.status === 'insufficient'
            ? 'insufficient' as const
            : semanticReadinessStatus === 'unavailable' || semanticReadinessStatus === 'error'
              ? 'insufficient' as const
              : pack.readiness.status === 'degraded' || semanticReadinessStatus === 'partial'
                ? 'degraded' as const
                : 'ready' as const;
          const readiness = {
            ...pack.readiness,
            status: readinessStatus,
            semantic: { status: semanticReadinessStatus, reasonCodes: semanticReasonCodes },
            unresolvedReasonCodes: Array.from(new Set([...pack.readiness.unresolvedReasonCodes, ...semanticReasonCodes])).slice(0, 80),
            readyForHighConfidenceMutation: readinessStatus === 'ready',
          };
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
              semanticNavigation,
              readiness,
              expansion: pack.expansion,
              files: pack.files,
              coverage: pack.coverage,
              cache: pack.cache,
              timingsMs: pack.timingsMs,
              deniedPaths: pack.deniedPaths,
              omitted: pack.omitted,
              limits: pack.limits,
              contextContract: pack.contextContract,
              ...(executionReadiness ? {
                executionReadiness,
                registeredChecks: checks.slice(0, 80).map((check) => ({ id: check.id, description: check.description, source: check.source, effects: check.effects })),
              } : {}),
              retrievalPolicy: {
                defaultBackend: 'bounded_lexical',
                structuralBackend: 'codegraph',
                rawReadTool: 'read_repository_file',
                shellSearchFallbackOnly: true,
                executionReadiness: 'requested_check_ids_only',
              },
            },
            warnings,
            suggestedNextActions: [],
            detailLevel: 'summary',
            rawAvailable: true,
          });
          return result(facade as unknown as Record<string, unknown>);
        }
        const startedAt = performance.now();
        const requestedCapabilityId = typeof args.capability_id === 'string' ? args.capability_id.trim() : '';
        if (requestedCapabilityId) {
          const pluginMatch = /^plugin\.([^.]+)\.(.+)$/.exec(requestedCapabilityId);
          const manifests = pluginMatch ? (() => {
            const pluginId = pluginMatch[1];
            const targets = [repository];
            const controllerRepository = controllerPluginRepository(ctx.controllerHome);
            if (controllerRepository.repoId !== repository.repoId) targets.push(controllerRepository);
            for (const target of targets) {
              try {
                return [getAssistantPluginManifest(ctx.controllerHome, target, pluginId)];
              } catch (error) {
                if (error instanceof Error && error.message.startsWith('PLUGIN_NOT_FOUND:')) continue;
                throw error;
              }
            }
            return [];
          })() : [];
          const descriptor = getCapabilityDescriptor(requestedCapabilityId, manifests);
          const pluginAction = getPluginActionCapabilitySchema(requestedCapabilityId, manifests);
          const facade = buildFacadeResult({
            status: 'ok',
            summary: descriptor
              ? `Exact capability ${requestedCapabilityId} is available.`
              : `Capability ${requestedCapabilityId} was not found.`,
            data: {
              operation,
              repoId: repository.repoId,
              repository: {
                repoId: repository.repoId,
                displayName: repository.displayName,
                defaultBranch: repository.defaultBranch,
                repositoryType: repository.repositoryType,
              },
              capabilityLookup: {
                requestedCapabilityId,
                found: Boolean(descriptor),
                descriptor,
                pluginAction,
              },
              toolArchitecture: {
                facadeTools: ['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work'],
                domainSchemaLoading: 'exact_capability_fast_path',
              },
              bounded: true,
            },
            warnings: [],
            suggestedNextActions: [],
            detailLevel: args.detail_level === 'detail' || args.detail_level === 'raw' ? args.detail_level : 'summary',
            rawAvailable: false,
          });
          const payload = facade as unknown as Record<string, unknown>;
          payload.responseMeta = {
            serverDurationMs: Number((performance.now() - startedAt).toFixed(2)),
            structuredPayloadBytes: 0,
          };
          (payload.responseMeta as { structuredPayloadBytes: number }).structuredPayloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
          return result(payload);
        }
        const capabilityIntentQuery = operation === 'list' && typeof args.query === 'string'
          ? args.query.trim()
          : '';
        if (capabilityIntentQuery) {
          const manifestOptions = { preferStored: true };
          const repositoryManifests = listAssistantPluginManifests(ctx.controllerHome, repository, manifestOptions);
          const controllerRepository = controllerPluginRepository(ctx.controllerHome);
          const controllerManifests = repository.repoId === controllerRepository.repoId
            ? []
            : listAssistantPluginManifests(ctx.controllerHome, controllerRepository, manifestOptions);
          const manifests = [...new Map(
            [...repositoryManifests, ...controllerManifests].map((manifest) => [manifest.pluginId, manifest] as const),
          ).values()];
          const matches = searchCapabilityDescriptors(capabilityIntentQuery, manifests, 12)
            .map((match) => ({
              ...match,
              pluginAction: getPluginActionCapabilitySchema(match.capabilityId, manifests),
            }));
          const facade = buildFacadeResult({
            status: 'ok',
            summary: matches.length > 0
              ? `Found ${matches.length} capability candidate(s) for intent: ${capabilityIntentQuery}`
              : `No capability candidates matched intent: ${capabilityIntentQuery}`,
            data: {
              operation,
              repoId: repository.repoId,
              capabilitySearch: {
                query: capabilityIntentQuery,
                matches,
                readOnlyDiscovery: true,
                executeWith: 'plugin_action_execute',
              },
              toolArchitecture: {
                facadeTools: ['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work'],
                domainSchemaLoading: 'intent_ranked_capability_search',
                exactCapabilityLookupStillAvailable: true,
              },
              bounded: true,
            },
            warnings: [],
            suggestedNextActions: [],
            detailLevel: args.detail_level === 'detail' || args.detail_level === 'raw' ? args.detail_level : 'summary',
            rawAvailable: false,
          });
          return result(facade as unknown as Record<string, unknown>);
        }
        const requested = Array.isArray(args.requested_check_ids) ? args.requested_check_ids.map(String) : [];
        const detailLevel = args.detail_level === 'detail' || args.detail_level === 'raw' ? args.detail_level : 'summary';
        const isSummary = detailLevel === 'summary';
        const checks = requested.length > 0 || !isSummary ? listControllerChecks(repository.canonicalRoot) : [];
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
        const processScan = isSummary
          ? listRecoverableProcessRecords(ctx.controllerHome, repository.repoId)
          : listProcessRecords(ctx.controllerHome, repository.repoId, workId ? 100 : 50);
        const relevantProcesses = processScan.filter((process) => workId ? process.workId === workId : timestampIsCurrent(process.updatedAt, currentCutoffMs));
        const liveProcessIds = new Set(processRuntimeResourceDiagnostics().activeProcessIds);
        const activeProcesses = relevantProcesses.filter((process) => liveProcessIds.has(process.processId) && isManagedProcessActive(process));
        const workController = work ? getControllerSession(store, work.workId) : undefined;
        const manifestOptions = { preferStored: true };
        const manifests = isSummary
          ? []
          : (() => {
              const repositoryManifests = listAssistantPluginManifests(ctx.controllerHome, repository, manifestOptions);
              const controllerRepository = controllerPluginRepository(ctx.controllerHome);
              const controllerManifests = repository.repoId === controllerRepository.repoId
                ? []
                : listAssistantPluginManifests(ctx.controllerHome, controllerRepository, manifestOptions);
              return [...new Map(
                [...repositoryManifests, ...controllerManifests].map((manifest) => [manifest.pluginId, manifest] as const),
              ).values()];
            })();
        const capabilities = isSummary ? [] : listCapabilityDescriptors(manifests);
        const capabilityGroups = isSummary ? [] : summarizeCapabilityGroups(manifests);
        const capabilityLookup = undefined;
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
          capabilityInventory: {
            mode: 'detail_only',
            deferred: true,
            reason: 'Work/repository summary does not hydrate plugin manifests; request capability_id or detail/raw only when schema/policy detail is needed.',
          },
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
            capabilityInventoryDeferred: true,
            activeWork: currentContractScan.length,
            activeWorkShown: activeContracts.length,
            storedNonTerminalWork: activeContractScan.length,
            currentWork: currentContractScan.length,
            historicalNonTerminalWork: Math.max(0, activeContractScan.length - currentContractScan.length),
            currentAttention: currentAttentionScan.length,
            currentAttentionShown: attention.length,
            activeProcesses: activeProcesses.length,
            recentProcesses: relevantProcesses.length,
            historicalProcessScanDeferred: true,
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
        const requestedOperation = String(args.operation ?? 'start');
        const frozenScheduleDeleteId = requestedOperation === 'repair' && typeof args.capability_id === 'string' && args.capability_id.startsWith('schedule.delete:')
          ? args.capability_id.slice('schedule.delete:'.length).trim()
          : '';
        let frozenControllerDisposition: ReturnType<typeof parseControllerDispositionCompatibilityCapability>;
        try {
          frozenControllerDisposition = parseControllerDispositionCompatibilityCapability(requestedOperation, args.capability_id);
        } catch (error) {
          return result(buildFacadeResult({
            status: 'blocked',
            summary: error instanceof Error ? error.message : 'Controller disposition compatibility input is invalid.',
            data: {},
          }) as unknown as Record<string, unknown>, true);
        }
        const operation = frozenControllerDisposition
          ? 'controller_disposition'
          : frozenScheduleDeleteId ? 'schedule_delete' : requestedOperation;
        if (!allowedFacadeOperations('rh_work').includes(operation)) {
          return invalidFacadeOperation('rh_work', operation);
        }
        if (operation.startsWith('schedule_')) {
          try {
            const workId = String(args.work_id ?? '').trim();
            const scheduleId = frozenScheduleDeleteId || String(args.schedule_id ?? '').trim();
            if (operation === 'schedule_create') {
              const controllerType = String(args.controller_type ?? 'chatgpt').trim();
              if (!['chatgpt', 'codex', 'claude', 'grok'].includes(controllerType)) throw new Error('CONTROLLER_TYPE_INVALID');
              const triggerTypeRaw = String(args.trigger_type ?? '').trim();
              const triggerType = ['interval', 'cron', 'calendar', 'condition', 'repository-event', 'dependency-checkpoint', 'manual'].includes(triggerTypeRaw)
                ? triggerTypeRaw as 'interval' | 'cron' | 'calendar' | 'condition' | 'repository-event' | 'dependency-checkpoint' | 'manual'
                : undefined;
              const scheduleModeRaw = String(args.schedule_mode ?? (workId ? 'continuation' : '')).trim();
              if (!['continuation', 'browser_watch', 'browser_keepalive'].includes(scheduleModeRaw)) throw new Error('SCHEDULE_MODE_REQUIRES_WORK_OR_EXPLICIT_BROWSER_KEEPALIVE');
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
              const schedules = listWorkContinuationSchedules(ctx.controllerHome, repository.repoId, {
                workId: workId || undefined,
                includeOccurrences: args.include_occurrences === true,
              });
              const data = args.include_occurrences === true ? schedules : { schedules: schedules.schedules };
              return result(buildFacadeResult({ summary: `Found ${schedules.schedules.length} schedule(s).`, data }) as unknown as Record<string, unknown>);
            }
            if (!scheduleId) throw new Error('SCHEDULE_ID_REQUIRED');
            if (operation === 'schedule_get') {
              const data = getWorkContinuationSchedule(ctx.controllerHome, repository.repoId, scheduleId, args.include_occurrences === true);
              return result(buildFacadeResult({ summary: `Schedule ${scheduleId}.`, data }) as unknown as Record<string, unknown>);
            }
            if (operation === 'schedule_pause') {
              const saved = pauseWorkContinuationSchedule(ctx.controllerHome, repository.repoId, scheduleId, typeof args.reason === 'string' ? args.reason : undefined);
              return result(buildFacadeResult({ summary: `Schedule ${scheduleId} is paused.`, data: { schedule: saved } }) as unknown as Record<string, unknown>);
            }
            if (operation === 'schedule_resume') {
              const saved = resumeWorkContinuationSchedule(ctx.controllerHome, repository.repoId, scheduleId);
              return result(buildFacadeResult({ summary: `Schedule ${scheduleId} is resumed.`, data: { schedule: saved } }) as unknown as Record<string, unknown>);
            }
            if (operation === 'schedule_delete') {
              const schedule = getWorkContinuationSchedule(ctx.controllerHome, repository.repoId, scheduleId).schedule;
              deleteSchedule(ctx.controllerHome, repository.repoId, scheduleId);
              return result(buildFacadeResult({
                summary: `Schedule ${scheduleId} is deleted; historical occurrences and evidence are retained.`,
                data: { scheduleId, deleted: true, requestId: schedule.requestId },
              }) as unknown as Record<string, unknown>);
            }
            if (operation === 'schedule_trigger') {
              const repositoryEvent = typeof args.event_name === 'string' && args.event_name.trim().length > 0;
              const explicitEventId = typeof args.event_id === 'string' ? args.event_id.trim() : '';
              const manualRequestId = !repositoryEvent && typeof args.request_id === 'string' ? args.request_id.trim() : '';
              const occurrence = await triggerWorkContinuationSchedule(ctx.controllerHome, repository.repoId, scheduleId, {
                source: repositoryEvent ? 'repository-event' : 'manual',
                eventName: typeof args.event_name === 'string' ? args.event_name : undefined,
                eventId: explicitEventId || manualRequestId || undefined,
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
            const relay = acknowledgeControllerRoundClaim(
              { controllerHome: ctx.controllerHome, repoId: repository.repoId },
              { workId, session },
            );
            return result(buildFacadeResult({
              summary: relay?.status === 'claimed'
                ? `Controller ${session.controllerId} claimed ${session.workId}; the dispatched ChatGPT round is mechanically acknowledged and still requires an explicit semantic disposition.`
                : `Controller ${session.controllerId} claimed ${session.workId}.`,
              data: { session, relay },
            }) as unknown as Record<string, unknown>);
          } catch (error) {
            return result(buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Controller claim failed.', data: {} }) as unknown as Record<string, unknown>, true);
          }
        }
        if (operation === 'controller_disposition') {
          try {
            const workId = String(args.work_id ?? '').trim();
            const disposition = frozenControllerDisposition?.disposition ?? String(args.disposition ?? '').trim();
            if (!['continue_immediately', 'wait', 'wait_for_user', 'goal_complete'].includes(disposition)) {
              throw new Error('CONTROLLER_RELAY_DISPOSITION_INVALID');
            }
            const identity = authenticatedFacadeControllerIdentity(ctx, args, { allowTransportSessionRollover: true });
            const work = getWorkContract(store, workId);
            if (!work) throw new Error(`WORK_NOT_FOUND: ${workId}`);
            const terminalGoalComplete = work.status === 'completed' && disposition === 'goal_complete';
            const currentOwner = getControllerSession(store, workId);
            if (!currentOwner && !terminalGoalComplete) {
              if (work.status === 'failed' || work.status === 'cancelled' || work.status === 'completed') {
                throw new Error(`CONTROLLER_RELAY_WORK_TERMINAL: ${work.status}`);
              }
              throw new Error(`CONTROLLER_RELAY_ACTIVE_CLAIM_REQUIRED: ${workId}`);
            }
            if (currentOwner) {
              if (currentOwner.controllerType !== 'chatgpt') throw new Error(`CONTROLLER_RELAY_CHATGPT_ONLY: ${workId}`);
              if (currentOwner.controllerId !== identity.controllerId) throw new Error(`WORK_CONTROLLER_OWNER_MISMATCH: ${workId}`);
              if ((currentOwner.principalId?.trim() || currentOwner.controllerId) !== identity.principalId) {
                throw new Error(`WORK_CONTROLLER_PRINCIPAL_MISMATCH: ${workId}`);
              }
              // Finalization may terminalize the Work before the prompt-required
              // goal_complete disposition is submitted. A frozen MCP client may also
              // rotate transport sessions between those two calls. Never resume or
              // rewrite a terminal Work lease here; terminal authorization is fenced
              // by the already-claimed relay lineage in submitControllerRoundDisposition.
              if (!terminalGoalComplete) {
                bindFacadeControllerOwnership(ctx, store, workId, { ...identity, controllerType: 'chatgpt' });
              }
            }
            const chatgptBinding = getChatgptWorkConversationBinding(store, workId);
            const relay = submitControllerRoundDisposition({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, {
              workId,
              identity,
              disposition: disposition as ControllerRoundDisposition,
              relayScopeId: frozenControllerDisposition?.relayScopeId ?? (typeof args.relay_scope_id === 'string' ? args.relay_scope_id : undefined),
              requirementId: typeof args.requirement_id === 'string' ? args.requirement_id : undefined,
              handoffId: typeof args.handoff_id === 'string' ? args.handoff_id : undefined,
              stateFingerprint: typeof args.state_fingerprint === 'string' ? args.state_fingerprint : undefined,
              reason: typeof args.reason === 'string' ? args.reason : undefined,
              browserSessionId: typeof args.browser_session_id === 'string' ? args.browser_session_id : chatgptBinding?.latestBrowserSessionId,
              conversationUrl: typeof args.conversation_url === 'string' ? args.conversation_url : chatgptBinding?.conversationUrl,
              maxRounds: typeof args.max_rounds === 'number' ? args.max_rounds : undefined,
              maxRepeatedState: typeof args.max_repeated_state === 'number' ? args.max_repeated_state : undefined,
              maxFailures: typeof args.max_failures === 'number' ? args.max_failures : undefined,
            });
            return result(buildFacadeResult({
              status: relay.status === 'blocked' ? 'blocked' : 'ok',
              summary: relay.status === 'pending_release'
                ? `Controller disposition ${relay.disposition} recorded; relay will dispatch only after the current lease is released.`
                : `Controller disposition ${relay.disposition} recorded with status ${relay.status}.`,
              data: { relay },
            }) as unknown as Record<string, unknown>, relay.status === 'blocked');
          } catch (error) {
            return result(buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Controller disposition failed.', data: {} }) as unknown as Record<string, unknown>, true);
          }
        }
        if (operation === 'controller_release') {
          try {
            const workId = String(args.work_id ?? '').trim();
            const identity = authenticatedFacadeControllerIdentity(ctx, args, { allowTransportSessionRollover: true });
            const observedOwner = getControllerSession(store, workId);
            const owner = observedOwner ? bindFacadeControllerOwnership(ctx, store, workId, identity) : undefined;
            if (owner) {
              const ownerPrincipal = owner.principalId?.trim() || owner.controllerId;
              const ownerInstanceId = owner.controllerInstanceId?.trim() || '';
              if (typeof owner.claimGeneration !== 'number' || owner.claimGeneration < 1) {
                throw new Error(`WORK_CONTROLLER_CLAIM_GENERATION_REQUIRED: ${workId}`);
              }
              const released = releaseControllerSessionWithAuthority(store, {
                workId,
                actor: `controller-release:${identity.controllerId}:${identity.controllerInstanceId}`,
                authority: {
                  controllerId: owner.controllerId,
                  controllerType: owner.controllerType,
                  principalId: ownerPrincipal,
                  controllerInstanceId: ownerInstanceId,
                  claimGeneration: owner.claimGeneration,
                },
              });
              if (!released.allowed) {
                throw new Error(`WORK_CONTROLLER_RELEASE_FENCED: ${workId}:${released.reason}`);
              }
            }
            const executionSession = readExecutionSession(ctx.controllerHome, identity);
            if (executionSession?.activeWorkId === workId) {
              updateExecutionSession(ctx.controllerHome, identity, { activeWorkId: undefined, lastValidatedAt: new Date().toISOString() });
            }
            const relayStore = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
            const relay = owner ? beginControllerRoundRelayAfterRelease(
              relayStore,
              { workId, releasedSession: owner },
            ) : undefined;
            const abandonedRelay = owner && !relay
              ? reconcileControllerRoundAfterAbandonedRelease(relayStore, { workId, releasedSession: owner })
              : undefined;
            if (relay?.status === 'dispatching') {
              try {
                assertAutomatedOperationAllowed('external_controller_wake', {
                  controller_type: 'chatgpt',
                  relay_scope_id: relay.relayScopeId,
                  requirement_id: relay.requirementId,
                });
                const prompt = buildControllerRoundRelayPrompt(relayStore, relay);
                const dispatched = await runWorkChatgptContinuation({
                  controllerHome: ctx.controllerHome,
                  repoId: repository.repoId,
                  repoRoot: repository.canonicalRoot,
                  workId,
                  prompt,
                  browserSessionId: relay.browserSessionId,
                  conversationUrl: relay.conversationUrl,
                  tabPolicy: 'reuse',
                });
                if (dispatched.status === 'failed') throw new Error(dispatched.error?.message ?? 'CONTROLLER_RELAY_DISPATCH_FAILED');
                // The next prompt is externally committed before this transition is
                // recorded. Contiguous immediate rounds intentionally retain one
                // Forge-owned tab, avoiding a close/reopen race and duplicate prompt.
                recordControllerRoundTabSettlement(relayStore, {
                  workId,
                  status: 'retained_for_immediate_continuation',
                });
                const completed = finishControllerRoundRelayDispatch(
                  relayStore,
                  { workId, ok: true, browserSessionId: dispatched.browserSessionId, conversationUrl: dispatched.conversationUrl },
                );
                return result(buildFacadeResult({
                  summary: `Controller lease released and immediate relay ${relay.relayScopeId} dispatched through the canonical ChatGPT launcher.`,
                  data: { relay: completed, dispatch: dispatched },
                }) as unknown as Record<string, unknown>);
              } catch (relayError) {
                const failed = finishControllerRoundRelayDispatch(
                  relayStore,
                  { workId, ok: false, error: relayError instanceof Error ? relayError.message : String(relayError) },
                );
                return result(buildFacadeResult({
                  status: 'blocked',
                  summary: `Controller lease released, but immediate relay dispatch failed: ${relayError instanceof Error ? relayError.message : String(relayError)}`,
                  data: { relay: failed },
                }) as unknown as Record<string, unknown>, true);
              }
            }
            const settledRelay = getControllerRoundRelay(relayStore, workId);
            let tabSettlement;
            if (
              owner?.controllerType === 'chatgpt'
              && settledRelay
              && ['waiting', 'waiting_for_user', 'goal_complete', 'blocked', 'failed'].includes(settledRelay.status)
            ) {
              const binding = getChatgptWorkConversationBinding(store, workId);
              const browserSessionId = settledRelay.browserSessionId ?? binding?.latestBrowserSessionId;
              if (browserSessionId) {
                tabSettlement = await settleWorkChatgptAutomationTab({
                  controllerHome: ctx.controllerHome,
                  workId,
                  browserSessionId,
                });
                recordControllerRoundTabSettlement(relayStore, {
                  workId,
                  status: tabSettlement.status,
                  error: tabSettlement.error?.message,
                });
              }
            }
            return result(buildFacadeResult({
              summary: abandonedRelay
                ? 'Controller lease released; the claimed round was mechanically marked abandoned without semantic completion and can be relaunched through the bounded launcher path.'
                : 'Controller lease released.',
              data: { relay: getControllerRoundRelay(relayStore, workId) ?? abandonedRelay ?? relay, tabSettlement },
            }) as unknown as Record<string, unknown>);
          } catch (error) {
            return result(buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Controller release failed.', data: {} }) as unknown as Record<string, unknown>, true);
          }
        }
        if (operation === 'launcher_start') {
          try {
            const controllerType = String(args.controller_type ?? 'codex');
            if (!['chatgpt', 'codex', 'grok', 'claude'].includes(controllerType)) throw new Error('CONTROLLER_TYPE_INVALID');
            const workId = String(args.work_id ?? '').trim();
            const launchArgs = Array.isArray(args.launch_args) ? args.launch_args.map(String) : [];
            if (controllerType === 'chatgpt') {
              const work = getWorkContract(store, workId);
              if (!work) throw new Error(`WORK_NOT_FOUND: ${workId}`);
              const handoffId = typeof args.handoff_id === 'string' ? args.handoff_id.trim() : '';
              const handoff = handoffId ? getHandoffItem(store, handoffId) : undefined;
              const valueForFlag = (flag: string): string | undefined => {
                const index = launchArgs.indexOf(flag);
                if (index < 0) return undefined;
                const value = launchArgs[index + 1];
                if (!value || value.startsWith('--')) throw new Error(`CHATGPT_LAUNCH_ARG_VALUE_REQUIRED: ${flag}`);
                return value;
              };
              const supportedFlags = new Set(['--model', '--reasoning', '--tab-policy', '--timeout-ms']);
              for (let index = 0; index < launchArgs.length; index += 2) {
                const flag = launchArgs[index];
                if (!flag || !supportedFlags.has(flag)) throw new Error(`CHATGPT_LAUNCH_ARG_UNSUPPORTED: ${flag ?? ''}`);
                if (!launchArgs[index + 1] || launchArgs[index + 1]!.startsWith('--')) throw new Error(`CHATGPT_LAUNCH_ARG_VALUE_REQUIRED: ${flag}`);
              }
              const reasoning = valueForFlag('--reasoning') ?? 'high';
              if (!['medium', 'high', 'xhigh'].includes(reasoning)) throw new Error(`CHATGPT_LAUNCH_REASONING_INVALID: ${reasoning}`);
              const tabPolicy = valueForFlag('--tab-policy') ?? 'auto';
              if (!['auto', 'reuse', 'new'].includes(tabPolicy)) throw new Error(`CHATGPT_LAUNCH_TAB_POLICY_INVALID: ${tabPolicy}`);
              const timeoutValue = valueForFlag('--timeout-ms');
              const timeoutMs = timeoutValue === undefined ? undefined : Number(timeoutValue);
              if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error(`CHATGPT_LAUNCH_TIMEOUT_INVALID: ${timeoutValue}`);
              const continuationPrompt = typeof args.continuation_prompt === 'string' ? args.continuation_prompt.trim() : '';
              const relay = beginInitialControllerRoundDispatch(
                { controllerHome: ctx.controllerHome, repoId: repository.repoId },
                {
                  workId,
                  identity: authenticatedFacadeControllerIdentity(ctx, args),
                  requirementId: work.requirementId,
                  browserSessionId: typeof args.browser_session_id === 'string' ? args.browser_session_id : undefined,
                  conversationUrl: typeof args.conversation_url === 'string' ? args.conversation_url : undefined,
                },
              );
              if (relay.status === 'blocked') {
                throw new Error(`CONTROLLER_RELAY_LAUNCH_BLOCKED: ${relay.blockedReason ?? relay.relayScopeId}`);
              }
              const prompt = [
                `Continue Forge Work ${work.workId} in repo ${work.repoId}.`,
                `Objective: ${work.objective}`,
                `Acceptance: ${work.acceptanceCriteria.join('; ') || 'none declared'}`,
                `Current status: ${work.status}`,
                `Controller round: ${relay.relayScopeId}. launcher_start opened this durable round; dispatch success is not semantic completion.`,
                handoff ? `Handoff: ${handoff.summary}\nNext: ${handoff.recommendedContinuationPrompt ?? handoff.recommendedPrompt}` : '',
                continuationPrompt ? `Continuation: ${continuationPrompt}` : '',
                'Treat Forge Work/Plan/evidence as source of truth. Claim the exact Work before any mutation; if ownership cannot be established, do not mutate.',
                `Before this ChatGPT round ends, submit exactly one rh_work controller_disposition for Work ${work.workId} and relay_scope_id=${relay.relayScopeId}: continue_immediately, wait, wait_for_user (with an active Handoff), or goal_complete. If this client schema is frozen and omits controller_disposition, use rh_work operation=repair with capability_id=controller.disposition:<disposition>:${relay.relayScopeId}; it is mapped to the same canonical disposition path. Ending the response without a disposition does not close the round and may trigger bounded mechanical recovery.`,
              ].filter(Boolean).join('\n');
              let dispatched: Awaited<ReturnType<typeof runWorkChatgptContinuation>>;
              try {
                dispatched = await runWorkChatgptContinuation({
                  controllerHome: ctx.controllerHome,
                  repoId: repository.repoId,
                  repoRoot: repository.canonicalRoot,
                  workId,
                  prompt,
                  browserSessionId: typeof args.browser_session_id === 'string' ? args.browser_session_id : undefined,
                  conversationUrl: typeof args.conversation_url === 'string' ? args.conversation_url : undefined,
                  model: valueForFlag('--model') ?? 'gpt-5.6',
                  reasoning: reasoning as 'medium' | 'high' | 'xhigh',
                  tabPolicy: tabPolicy as 'auto' | 'reuse' | 'new',
                  timeoutMs,
                });
                if (dispatched.status === 'failed') throw new Error(dispatched.error?.message ?? 'CHATGPT_WORK_CONTINUATION_FAILED');
              } catch (launchError) {
                finishControllerRoundRelayDispatch(
                  { controllerHome: ctx.controllerHome, repoId: repository.repoId },
                  { workId, ok: false, error: launchError instanceof Error ? launchError.message : String(launchError) },
                );
                throw launchError;
              }
              const completedRelay = finishControllerRoundRelayDispatch(
                { controllerHome: ctx.controllerHome, repoId: repository.repoId },
                { workId, ok: true, browserSessionId: dispatched.browserSessionId, conversationUrl: dispatched.conversationUrl },
              );
              return result(buildFacadeResult({
                summary: 'ChatGPT continuation dispatched; wake completion remains pending until the new ChatGPT Controller claims the Work, and semantic closure still requires an explicit disposition.',
                data: {
                  workId,
                  relay: completedRelay,
                  browserSessionId: dispatched.browserSessionId,
                  conversationUrl: dispatched.conversationUrl,
                  executionPreferenceVerified: dispatched.executionPreferenceVerified,
                },
              }) as unknown as Record<string, unknown>);
            }
            const launched = await launchSuperController({ work: store, handoff: store }, {
              controllerType: controllerType as 'codex' | 'grok' | 'claude',
              executable: typeof args.executable === 'string' && args.executable.trim() ? args.executable.trim() : undefined,
              args: launchArgs,
              workId,
              launchReservationMs: typeof args.launch_reservation_ms === 'number' ? args.launch_reservation_ms : typeof args.lease_ms === 'number' ? args.lease_ms : undefined,
              handoffId: typeof args.handoff_id === 'string' ? args.handoff_id : undefined,
              browserSessionId: typeof args.browser_session_id === 'string' ? args.browser_session_id : undefined,
              conversationUrl: typeof args.conversation_url === 'string' ? args.conversation_url : undefined,
              continuationPrompt: typeof args.continuation_prompt === 'string' ? args.continuation_prompt : undefined,
              cwd: repository.canonicalRoot,
            });
            return result(buildFacadeResult({ summary: `Thin Launcher started ${launched.controllerType}.`, data: { pid: launched.pid, executable: launched.executable, workId, reservationId: launched.reservationId } }) as unknown as Record<string, unknown>);
          } catch (error) {
            return result(buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Launcher failed.', data: {} }) as unknown as Record<string, unknown>, true);
          }
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

        if (operation === 'requirement_create') {
          const requirementId = typeof args.requirement_id === 'string' ? args.requirement_id.trim() : '';
          const title = typeof args.requirement_title === 'string' ? args.requirement_title.trim().slice(0, 500) : '';
          const outcomeStatement = typeof args.requirement_outcome === 'string' ? args.requirement_outcome.trim().slice(0, 2_000) : '';
          const acceptanceCriteria = Array.isArray(args.requirement_acceptance_criteria)
            ? args.requirement_acceptance_criteria.map((value) => String(value).trim()).filter(Boolean).slice(0, 50).map((value) => value.slice(0, 500))
            : [];
          const requiredDeliveryReferences = Array.isArray(args.requirement_delivery_references)
            ? args.requirement_delivery_references.map((value) => String(value).trim()).filter(Boolean).slice(0, 50).map((value) => value.slice(0, 500))
            : [];
          const legacyAliases = Array.isArray(args.requirement_legacy_aliases)
            ? args.requirement_legacy_aliases.map((value) => String(value).trim()).filter(Boolean).slice(0, 20).map((value) => value.slice(0, 160))
            : [];
          if (!requirementId || !title || !outcomeStatement) {
            return result(buildFacadeResult({
              status: 'blocked',
              summary: 'REQUIREMENT_CREATE_INPUT_REQUIRED: requirement_id, requirement_title, and requirement_outcome are required.',
              data: { requirementCreated: false },
            }) as unknown as Record<string, unknown>, true);
          }
          const existing = readRequirement({ controllerHome: ctx.controllerHome }, requirementId)?.value;
          if (existing) {
            const identical = existing.title === title
              && existing.outcomeStatement === outcomeStatement
              && JSON.stringify(existing.acceptanceCriteria) === JSON.stringify(acceptanceCriteria)
              && JSON.stringify(existing.requiredDeliveryReferences) === JSON.stringify(requiredDeliveryReferences)
              && JSON.stringify(existing.legacyAliases) === JSON.stringify(legacyAliases);
            if (!identical) {
              return result(buildFacadeResult({
                status: 'blocked',
                summary: `REQUIREMENT_ALREADY_EXISTS_CONFLICT: ${requirementId}. Existing Requirement authority was not changed.`,
                data: { requirement: existing, requirementCreated: false, admissionDecision: 'existing_conflict' },
                suggestedNextActions: [],
              }) as unknown as Record<string, unknown>, true);
            }
            return result(buildFacadeResult({
              summary: `REQUIREMENT_AUTHORITY_REUSED: ${requirementId}. Requirement authority does not imply a Plan; Controller chooses the next action.`,
              data: { requirement: existing, requirementCreated: false, admissionDecision: 'reuse_existing' },
              suggestedNextActions: [],
            }) as unknown as Record<string, unknown>);
          }
          const requirement = createRequirement({ controllerHome: ctx.controllerHome }, {
            requirementId,
            title,
            outcomeStatement,
            acceptanceCriteria,
            requiredDeliveryReferences,
            legacyAliases,
          });
          return result(buildFacadeResult({
            summary: `Requirement ${requirementId} created. Requirement authority does not imply a Plan; Controller chooses the next action.`,
            data: { requirement, requirementCreated: true, admissionDecision: 'created' },
            suggestedNextActions: [],
          }) as unknown as Record<string, unknown>);
        }

        if (operation.startsWith('plan_')) {
          try {
            if (operation === 'plan_create') {
              const rawSteps = Array.isArray(args.plan_steps) ? args.plan_steps : [];
              const requestedRequirementId = typeof args.requirement_id === 'string' && args.requirement_id.trim() ? args.requirement_id.trim() : undefined;
              const requestedPlanRelation: 'extend' | 'parallel' | undefined = args.plan_relation === 'extend' || args.plan_relation === 'parallel'
                ? args.plan_relation
                : undefined;
              const relatedPlanId = typeof args.related_plan_id === 'string' && args.related_plan_id.trim() ? args.related_plan_id.trim() : undefined;
              if (requestedRequirementId && !readRequirement({ controllerHome: ctx.controllerHome }, requestedRequirementId)) {
                const facade = buildFacadeResult({
                  status: 'failed',
                  summary: `PLAN_REQUIREMENT_NOT_FOUND: ${requestedRequirementId}. Plan was not persisted; create or reconcile the Requirement authority first.`,
                  data: { executionStarted: false, planContractCreated: false, admissionDecision: 'missing_requirement', requirementId: requestedRequirementId },
                });
                return result(facade as unknown as Record<string, unknown>, true);
              }
              const admissionInput = {
                requirementId: requestedRequirementId,
                scopeKey: String(args.scope_key ?? ''),
                planRelation: requestedPlanRelation,
                relatedPlanId,
              };
              const renderPlanAdmission = (admission: ReturnType<typeof resolvePlanAdmission>): CallToolResult | undefined => {
                if (admission.admissionDecision === 'create_new') return undefined;
                if (admission.reason === 'exact_scope_authority' && admission.plan) {
                  const facade = buildFacadeResult({
                    summary: `PLAN_AUTHORITY_REUSED: active Plan ${admission.plan.planId} already owns scope ${admission.normalizedScopeKey}; no duplicate draft was created.`,
                    data: {
                      plan: summarizePlanContract(admission.plan),
                      executionStarted: false,
                      planContractCreated: false,
                      admissionDecision: 'reuse_existing',
                      resolutionRequired: false,
                    },
                    suggestedNextActions: [{ label: 'Read active Plan', tool: 'rh_work', operation: 'plan_get', payload: { plan_id: admission.plan.planId }, risk: 'readonly', confidence: 'high' }],
                  });
                  return result(facade as unknown as Record<string, unknown>);
                }
                if (admission.reason === 'requirement_relation_required') {
                  const facade = buildFacadeResult({
                    summary: `PLAN_RELATION_RESOLUTION_REQUIRED: Requirement ${requestedRequirementId} already has ${admission.candidates.length} active Plan slice(s). Decide whether this scope extends one of them or is an intentional parallel slice before creating a draft.`,
                    data: {
                      executionStarted: false,
                      planContractCreated: false,
                      admissionDecision: 'resolution_required',
                      resolutionRequired: true,
                      candidates: admission.candidates.map(summarizePlanContract),
                      allowedPlanRelations: admission.allowedPlanRelations ?? ['extend', 'parallel'],
                    },
                    suggestedNextActions: admission.candidates.slice(0, 3).map((candidate) => ({ label: `Read ${candidate.planId}`, tool: 'rh_work', operation: 'plan_get', payload: { plan_id: candidate.planId }, risk: 'readonly' as const, confidence: 'high' as const })),
                  });
                  return result(facade as unknown as Record<string, unknown>);
                }
                if (admission.reason === 'extension_target_required') {
                  const facade = buildFacadeResult({
                    summary: `PLAN_EXTENSION_TARGET_REQUIRED: select related_plan_id from the active Plan slices for Requirement ${requestedRequirementId}.`,
                    data: { executionStarted: false, planContractCreated: false, admissionDecision: 'resolution_required', resolutionRequired: true, candidates: admission.candidates.map(summarizePlanContract) },
                  });
                  return result(facade as unknown as Record<string, unknown>);
                }
                if (admission.reason === 'extend_existing' && admission.plan) {
                  // plan_create + plan_relation=extend is the atomic serial-replan
                  // path. Admission continues under the same lock so successor
                  // creation and predecessor supersession are persisted together.
                  return undefined;
                }
                throw new Error(`PLAN_ADMISSION_RESULT_INVALID: ${admission.admissionDecision}:${admission.reason}`);
              };
              const activePlans = listPlanContracts({ ...store, status: 'active', limit: 100 });
              const preflightAdmission = resolvePlanAdmission(activePlans, admissionInput);
              const preflightResult = renderPlanAdmission(preflightAdmission);
              if (preflightResult) return preflightResult;
              const requestedPlanCheckIds = rawSteps
                .filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === 'object' && !Array.isArray(step))
                .flatMap((step) => Array.isArray(step.check_ids) ? step.check_ids.map(String) : []);
              const normalizedPlanChecks = normalizeCheckIds(requestedPlanCheckIds, checks);
              if (normalizedPlanChecks.invalidCheckIds.length > 0) {
                const facade = buildFacadeResult({
                  status: 'failed',
                  summary: `PLAN_CHECKS_INVALID: ${normalizedPlanChecks.invalidCheckIds.join(', ')}. Plan was not persisted; select replacement IDs from registeredCheckIds in this response, then request readiness only for the checks you choose.`,
                  data: {
                    executionStarted: false,
                    planContractCreated: false,
                    admissionDecision: 'invalid_checks',
                    normalizedChecks: normalizedPlanChecks,
                    registeredCheckIds: checks.map((check) => check.id).slice(0, 80),
                  },
                  suggestedNextActions: [],
                });
                return result(facade as unknown as Record<string, unknown>, true);
              }
              const admitted = await admitPlanContractAsync(store, {
                planId: String(args.plan_id ?? ''),
                repoId: repository.repoId,
                requirementId: requestedRequirementId,
                scopeKey: String(args.scope_key ?? ''),
                planRelation: requestedPlanRelation,
                relatedPlanId,
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
              const racedAdmissionResult = renderPlanAdmission(admitted);
              if (racedAdmissionResult) return racedAdmissionResult;
              if (!admitted.plan) throw new Error('PLAN_ADMISSION_CREATE_MISSING_PLAN');
              const plan = admitted.plan;
              const facade = buildFacadeResult({
                summary: `PlanContract ${plan.planId} created as draft after atomic authority admission; no execution was started.`,
                data: { plan: summarizePlanContract(plan), executionStarted: false, planContractCreated: true, admissionDecision: 'create_new' },
                suggestedNextActions: [{ label: 'Approve reviewed plan', tool: 'rh_work', operation: 'plan_approve', payload: { plan_id: plan.planId }, risk: 'workspace_write', confidence: 'medium' }],
              });
              return result(facade as unknown as Record<string, unknown>);
            }
            if (operation === 'plan_approve') {
              const plan = await approvePlanContractAsync(store, String(args.plan_id ?? ''));
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
                acceptedSourceRevision: workloopCtx.sourceRevision,
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
          const workId = String(args.work_id ?? '').trim();
          const currentOwner = workId ? getControllerSession(store, workId) : undefined;
          let terminalizationAuthority: ControllerTerminalizationAuthority | undefined;
          if (currentOwner) {
            try {
              const identity = authenticatedFacadeControllerIdentity(ctx, args);
              const reboundOwner = bindFacadeControllerOwnership(ctx, store, workId, identity);
              const ownerPrincipal = reboundOwner.principalId?.trim() || reboundOwner.controllerId;
              const ownerInstanceId = reboundOwner.controllerInstanceId?.trim() || '';
              if (typeof reboundOwner.claimGeneration !== 'number' || reboundOwner.claimGeneration < 1) {
                throw new Error(`WORK_CONTROLLER_CLAIM_GENERATION_REQUIRED: ${workId}`);
              }
              terminalizationAuthority = {
                controllerId: reboundOwner.controllerId,
                controllerType: reboundOwner.controllerType,
                principalId: ownerPrincipal,
                controllerInstanceId: ownerInstanceId,
                claimGeneration: reboundOwner.claimGeneration,
              };
            } catch (error) {
              const blocked = buildFacadeResult({
                status: 'blocked',
                summary: error instanceof Error ? error.message : `Work ${workId} terminalization authority check failed.`,
                data: { workId, terminalizationApplied: false },
              });
              return result(blocked as unknown as Record<string, unknown>, true);
            }
          } else if (!['user', 'system'].includes(String(args.requested_by ?? ''))) {
            const blocked = buildFacadeResult({
              status: 'blocked',
              summary: `WORK_CONTROLLER_OWNER_REQUIRED: ${workId}; unclaimed stop requires explicit requested_by=user or requested_by=system authority.`,
              data: { workId, terminalizationApplied: false },
            });
            return result(blocked as unknown as Record<string, unknown>, true);
          }

          const fenced = withControllerSessionTerminalizationFence(
            store,
            {
              workId,
              actor: `rh-work-stop:${terminalizationAuthority?.controllerId ?? String(args.requested_by ?? 'explicit')}`,
              authority: terminalizationAuthority,
            },
            () => runGoalWorkloop({ ...workloopCtx, sourceRevision: workloopCtx.sourceRevision ?? undefined }, 'stop', args),
          );
          if (!fenced.allowed) {
            const blocked = buildFacadeResult({
              status: 'blocked',
              summary: `WORK_TERMINALIZATION_AUTHORITY_FENCED: ${workId}:${fenced.reason}`,
              data: {
                workId,
                terminalizationApplied: false,
                currentClaimGeneration: fenced.owner?.claimGeneration,
              },
            });
            return result(blocked as unknown as Record<string, unknown>, true);
          }
          const facade = fenced.value;
          if (facade.status !== 'ok') {
            return result(facade as unknown as Record<string, unknown>, true);
          }
          try {
            const physical = await finalizeFacadeWorkHandle(ctx, repository, args, 'stop');
            if (!physical) return result(facade as unknown as Record<string, unknown>);
            const cleanup = contextRecord(physical.structuredContent);
            const cleanupCompleted = cleanup.cleanupCompleted === true || contextRecord(cleanup.work).state === 'cleaned';
            const cleanupRetained = cleanup.cleanupRetained === true;
            const cleanupSettled = cleanupCompleted || cleanupRetained;
            const response = {
              ...facade,
              status: cleanupSettled ? 'ok' : 'blocked',
              summary: cleanupCompleted
                ? `${facade.summary} Managed worktree and branch cleanup completed automatically.`
                : cleanupRetained
                  ? `${facade.summary} Managed worktree and branch retention was recorded durably; automatic cleanup is disabled for this terminal Work.`
                  : `${facade.summary} Automatic managed-resource cleanup is incomplete and remains visible for retry.`,
              data: {
                ...(facade.data && typeof facade.data === 'object' ? facade.data : {}),
                worktreeDeleted: cleanupCompleted,
                cleanupPending: !cleanupSettled,
                cleanupRetained,
                lifecycleCleanup: cleanup,
              },
            };
            return result(response as unknown as Record<string, unknown>, !cleanupSettled || physical.isError === true);
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
          const finalizeReconciliation = workId
            ? reconcileTerminalFacadeWorkVerifications(ctx, repository, workId)
            : undefined;
          const semanticFinalizeContext = {
            ...workloopCtx,
            sourceRevision: finalizeReconciliation?.sourceRevision ?? workloopCtx.sourceRevision ?? undefined,
            workspaceFingerprint: finalizeReconciliation?.workspaceFingerprint,
            workspaceChangedPaths: finalizeReconciliation?.workspaceChangedPaths,
            workBoundProcessEvidenceIds: finalizeReconciliation?.workBoundProcessEvidenceIds,
          };
          let before = workId ? getWorkContract(store, workId) : undefined;
          // Physical finalization may itself consult ControllerSession ownership.
          // Rebind the same authenticated Controller to the current canonical
          // Runtime before any commit/merge/cleanup stage, not after it.
          if (before && !['completed', 'failed', 'cancelled'].includes(before.status)) {
            try {
              const identity = authenticatedFacadeControllerIdentity(ctx, args);
              bindFacadeControllerOwnership(ctx, store, workId, identity, { allowClaimIfMissing: true });
            } catch (error) {
              const blocked = buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : `Work ${workId} Controller continuity check failed.`, data: { workId, lifecycleClosed: false } });
              return result(blocked as unknown as Record<string, unknown>, true);
            }
          }
          if (before && !before.completionReceipt && args.reconcile_historical_delivery === true) {
            try {
              const identity = authenticatedFacadeControllerIdentity(ctx, args);
              const owner = getControllerSession(store, workId);
              if (!owner || (owner.principalId?.trim() || owner.controllerId) !== identity.principalId) {
                throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_CONTROLLER_CLAIM_REQUIRED: ${workId}`);
              }
              const historicalHandle = readWorkHandle(ctx.controllerHome, repository.repoId, workId);
              if (historicalHandle?.managedWorktree) {
                const managedCleanupComplete = historicalHandle.finalization.merge === 'done'
                  && historicalHandle.finalization.branchCleanup === 'done'
                  && historicalHandle.finalization.worktreeCleanup === 'done'
                  && !existsSync(historicalHandle.worktreePath);
                if (!managedCleanupComplete) throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_MANAGED_CLEANUP_REQUIRED: ${workId}`);
              }
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
                const finalization: WorkHandleState['finalization'] = historicalHandle.managedWorktree
                  ? historicalHandle.finalization
                  : { validation: 'done', commit: 'done', merge: 'skipped', branchCleanup: 'skipped', worktreeCleanup: 'skipped' };
                const delivered = historicalHandle.state === 'committed' || historicalHandle.state === 'merged' || historicalHandle.state === 'failed_terminal_cleanup'
                  ? historicalHandle
                  : transitionWorkHandle(ctx.controllerHome, historicalHandle, 'committed', { expectedHead: reconciliation.receipt.targetRevision, finalization, failureReason: undefined });
                transitionWorkHandle(ctx.controllerHome, delivered, 'cleaned', { expectedHead: reconciliation.receipt.targetRevision, finalization, failureReason: undefined });
              }
              const released = releaseObservedControllerSession(store, {
                workId,
                actor: `direct-edit-reconciliation:${identity.principalId}`,
                owner,
              });
              if (!released.allowed) {
                throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_CONTROLLER_RELEASE_FENCED: ${workId}:${released.reason}`);
              }
              before = getWorkContract(store, workId);
            } catch (error) {
              const blocked = buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Historical Work delivery reconciliation failed.', data: { workId, lifecycleClosed: false } });
              return result(blocked as unknown as Record<string, unknown>, true);
            }
          }
          // Legacy callers could classify repository mutation + Git remote delivery
          // as remote_effect. A physical WorkHandle proves this is repository delivery,
          // so keep it on work_finalize instead of demanding a plugin action receipt.
          // Pure plugin remote effects have no repository WorkHandle and retain the
          // action-receipt finalization contract.
          const repositoryDeliveryHandle = workId
            ? readWorkHandle(ctx.controllerHome, repository.repoId, workId)
            : undefined;
          if (before?.workKind === 'remote_effect' && !before.completionReceipt && !repositoryDeliveryHandle) {
            try {
              before = finalizeRemoteEffectWorkFromActionReceipt(ctx.controllerHome, repository.repoId, workId);
            } catch (error) {
              const blocked = buildFacadeResult({
                status: 'blocked',
                summary: error instanceof Error ? error.message : 'Remote-effect semantic finalization failed.',
                data: { workId, lifecycleClosed: false },
              });
              return result(blocked as unknown as Record<string, unknown>, true);
            }
          }
          const completedCleanupPending = Boolean(
            before?.completionReceipt
            && args.cleanup !== false
            && before.worktreeRef?.trim()
            && existsSync(before.worktreeRef),
          );
          if (before && before.workKind !== 'local_effect' && (!before.completionReceipt || completedCleanupPending)) {
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
          const semanticWork = getWorkContract(store, workId);
          let facade;
          if (semanticWork && !['completed', 'failed', 'cancelled'].includes(semanticWork.status)) {
            try {
              const identity = authenticatedFacadeControllerIdentity(ctx, args);
              const owner = bindFacadeControllerOwnership(ctx, store, workId, identity, { allowClaimIfMissing: true });
              const ownerPrincipal = owner.principalId?.trim() || owner.controllerId;
              const ownerInstanceId = owner.controllerInstanceId?.trim() || '';
              if (typeof owner.claimGeneration !== 'number' || owner.claimGeneration < 1) throw new Error(`WORK_CONTROLLER_CLAIM_GENERATION_REQUIRED: ${workId}`);
              const fenced = withControllerSessionTerminalizationFence(
                store,
                {
                  workId,
                  actor: `rh-work-finalize:${identity.controllerId}:${identity.controllerInstanceId}`,
                  authority: {
                    controllerId: owner.controllerId,
                    controllerType: owner.controllerType,
                    principalId: ownerPrincipal,
                    controllerInstanceId: ownerInstanceId,
                    claimGeneration: owner.claimGeneration,
                  },
                },
                () => runGoalWorkloop(semanticFinalizeContext, 'finalize', args),
              );
              if (!fenced.allowed) {
                throw new Error(`WORK_TERMINALIZATION_AUTHORITY_FENCED: ${workId}:${fenced.reason}`);
              }
              facade = fenced.value;
            } catch (error) {
              const blocked = buildFacadeResult({
                status: 'blocked',
                summary: error instanceof Error ? error.message : `Work ${workId} semantic finalization authority check failed.`,
                data: { workId, terminalizationApplied: false, lifecycleClosed: false },
              });
              return result(blocked as unknown as Record<string, unknown>, true);
            }
          } else {
            facade = runGoalWorkloop(semanticFinalizeContext, 'finalize', args);
          }
          const completed = getWorkContract(store, workId);
          // Finalizing a Work proves the Work lifecycle only. A Plan step may aggregate
          // acceptance criteria that are broader than this Work (for example, a canary
          // plus a later stabilization soak), so finalize must never synthesize semantic
          // Plan acceptance. Only the explicit plan_accept_step operation may promote a
          // validating step to completed after the Controller reviews all criteria.
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
        let cancelledWorkReauthorized = false;
        let reconstructedCancelledCheckout = false;
        let continuationSourceRevision = workloopCtx.sourceRevision;
        let continuationWorkspaceFingerprint: string | undefined;
        let continuationWorkspaceChangedPaths: string[] | undefined;
        let continuationWorkBoundProcessEvidenceIds: string[] | undefined;
        if (operation === 'continue') {
          try {
            const workId = String(args.work_id ?? '').trim();
            let work = getWorkContract(store, workId);
            if (work?.status === 'cancelled') {
              const resumed = reauthorizeCancelledFacadeWork(ctx, repository, workId, args);
              cancelledWorkReauthorized = true;
              reconstructedCancelledCheckout = resumed.reconstructedCheckout;
              work = getWorkContract(store, workId);
            }
            if (work && !['cancelled', 'completed', 'failed'].includes(work.status)) {
              const identity = authenticatedFacadeControllerIdentity(ctx, args);
              resumedControllerSession = resumeControllerSession(store, {
                workId,
                controllerId: identity.controllerId,
                controllerType: identity.controllerType,
                sessionId: identity.sessionId,
                principalId: identity.principalId,
                controllerInstanceId: identity.controllerInstanceId,
                leaseMs: 3_600_000,
              });
              const existingHandle = readWorkHandle(ctx.controllerHome, repository.repoId, workId);
              if (existingHandle && (existingHandle.principalId !== identity.principalId || existingHandle.sessionId !== identity.sessionId)) {
                writeWorkHandle(ctx.controllerHome, {
                  ...existingHandle,
                  principalId: identity.principalId,
                  sessionId: identity.sessionId,
                });
              }
              if (work.worktreePolicy.required === true && !work.worktreeRef) {
                materializeFacadeWorkPlacement(ctx, repository, workId, args);
              }
            }
            if (workId) {
              const reconciled = reconcileTerminalFacadeWorkVerifications(ctx, repository, workId);
              continuationSourceRevision = reconciled.sourceRevision ?? continuationSourceRevision;
              continuationWorkspaceFingerprint = reconciled.workspaceFingerprint ?? continuationWorkspaceFingerprint;
              continuationWorkspaceChangedPaths = reconciled.workspaceChangedPaths ?? continuationWorkspaceChangedPaths;
              continuationWorkBoundProcessEvidenceIds = reconciled.workBoundProcessEvidenceIds;
            }
          } catch (error) {
            const facade = buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Controller resume failed.', data: { operation, executionStarted: false, ownershipResumed: false } });
            return result(facade as unknown as Record<string, unknown>, true);
          }
        }

        const semanticAdmissionRequired = operation === 'start' && Boolean(
          (typeof args.plan_id === 'string' && args.plan_id.trim())
          || (typeof args.plan_step_id === 'string' && args.plan_step_id.trim())
          || (typeof args.requirement_id === 'string' && args.requirement_id.trim())
          || (typeof args.related_work_id === 'string' && args.related_work_id.trim())
          || (typeof args.work_relation === 'string' && args.work_relation.trim()),
        );
        const startContext = {
          ...workloopCtx,
          sourceRevision: continuationSourceRevision ?? undefined,
          workspaceFingerprint: continuationWorkspaceFingerprint,
          workspaceChangedPaths: continuationWorkspaceChangedPaths,
          workBoundProcessEvidenceIds: continuationWorkBoundProcessEvidenceIds,
          semanticAdmissionLocked: semanticAdmissionRequired,
        };
        const facade = semanticAdmissionRequired
          ? await withPrimaryWorkAdmissionLockAsync(store, () => runGoalWorkloop(startContext, 'start', args))
          : runGoalWorkloop(startContext, operation as 'start' | 'continue', args);
        const facadeData = facade.data && typeof facade.data === 'object' ? facade.data as Record<string, unknown> : {};
        const facadeWorkId = contextText(contextRecord(facadeData.work).workId, 200);
        if (facade.status === 'ok' && facadeWorkId) {
          try {
            if (facadeData.workContractCreated === true) {
              materializeFacadeWorkPlacement(ctx, repository, facadeWorkId, args);
            }
            const handle = ensureFacadeWorkHandle(ctx, repository, facadeWorkId, args);
            if (handle) facadeData.executionHandle = { workId: handle.workId, checkoutId: handle.checkoutId, managedWorktree: handle.managedWorktree, state: handle.state };
            if (facadeData.workContractCreated === true) {
              const owner = claimNewFacadeWork(ctx, repository, facadeWorkId, args);
              facadeData.controllerSession = owner;
              facadeData.ownershipClaimed = true;
            }
          } catch (error) {
            const blocked = buildFacadeResult({ status: 'blocked', summary: `WORK_HANDLE_MATERIALIZATION_FAILED: ${error instanceof Error ? error.message : String(error)}`, data: { ...facadeData, workId: facadeWorkId, executionStarted: false, canonicalWorkRetained: true } });
            return result(blocked as unknown as Record<string, unknown>, true);
          }
        }
        const response = resumedControllerSession
          ? {
              ...facade,
              ...(cancelledWorkReauthorized
                ? {
                    status: 'ok' as const,
                    summary: `Explicit current-user reauthorization resumed ${resumedControllerSession.workId}; implementation may continue on the exact Work identity.`,
                  }
                : { summary: `Controller ownership resumed for ${resumedControllerSession.workId}. ${facade.summary}` }),
              data: {
                ...facadeData,
                ownershipResumed: true,
                controllerSession: resumedControllerSession,
                ...(cancelledWorkReauthorized ? {
                  cancelledWorkReauthorized: true,
                  reconstructedCancelledCheckout,
                  nextStep: 'execute',
                } : {}),
              },
            }
          : facade;
        return result(response as unknown as Record<string, unknown>, response.status === 'blocked' || response.status === 'failed' || response.status === 'not_found');
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
              : 'Historical Job is still active. Continue independent work; read it only if an observation can change the next decision, and use work_wait only when this exact result becomes a dependency. Do not periodically poll.',
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
        const workId = typeof args.work_id === 'string' && args.work_id.trim() ? args.work_id.trim() : undefined;
        const repository = pluginRepository(ctx, args, pluginId);
        const workRepository = workId ? selected(ctx, args) : undefined;
        const actionId = String(args.action_id ?? '').trim();
        const requestId = String(args.request_id ?? '').trim();
        const actionArguments = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
          ? args.arguments as Record<string, unknown>
          : {};
        const request = {
          pluginId,
          actionId,
          requestId,
          workId,
          ...(workId && workRepository ? { workRepoId: workRepository.repoId } : {}),
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
        if (repository.repoId !== '__controller__' && action?.executionMode === 'lightweight_process') {
          const timeoutMs = Math.max(1_000, request.timeoutMs ?? action?.defaultTimeoutMs ?? 10 * 60_000);
          let { handle } = await startLightweightPluginAction({
            controllerHome: ctx.controllerHome,
            repository,
            request,
            interactiveWaitMs: typeof args.interactive_wait_ms === 'number' ? args.interactive_wait_ms : 750,
            timeoutMs,
          });
          if (!handle.completed && args.wait === true) {
            handle = await waitLightweightPluginAction(
              ctx.controllerHome,
              repository.repoId,
              handle.processId,
              typeof args.wait_ms === 'number' ? Math.max(1, args.wait_ms) : 15_000,
              ctx.signal,
            );
          }
          if (!handle.completed) {
            return result({
              accepted: true,
              direct: false,
              durable: false,
              mode: 'lightweight_process',
              plugin: summarizePluginActionReceipt(manifest),
              action: action ? {
                actionId: action.actionId,
                risk: action.risk,
                confirmation: action.confirmation,
                requiredConfirmationText: action.requiredConfirmationText,
              } : { actionId },
              scope: 'repository',
              requestId,
              process: handle,
              resultRef: { kind: 'process_logs', processId: handle.processId },
              next: 'The typed plugin action is isolated from the Canonical Runtime. Use process_wait on processId; after completion, call plugin_action_execute again with the same request_id to retrieve the deduplicated structured receipt.',
            });
          }
          if (!handle.ok) {
            return result({
              accepted: true,
              direct: false,
              durable: false,
              mode: 'lightweight_process',
              requestId,
              process: handle,
              error: {
                code: handle.timedOut ? 'PLUGIN_ACTION_TIMEOUT' : handle.cancelled ? 'PLUGIN_ACTION_CANCELLED' : 'PLUGIN_ACTION_FAILED',
                message: handle.stderrTail || handle.stdoutTail || `Plugin action process exited with code ${String(handle.exitCode)}`,
              },
            }, true);
          }
        }
        // The sidecar writes the authoritative receipt. Re-entering the store
        // with the same request id is a bounded deduplicated read of that result.
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
            : `Continue independent work. Use process_get only if an observation can change the next decision; join once with process_wait when this exact result becomes a dependency. Do not re-run the original operation.`,
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
      default: return undefined;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const structuredCode = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1];
    return result({ error: { code: structuredCode ?? 'RUNTIME_TOOL_FAILED', message } }, true);
  }
}
