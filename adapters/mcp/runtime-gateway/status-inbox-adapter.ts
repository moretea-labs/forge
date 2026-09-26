import { existsSync } from "fs";
import { join } from "path";
import { runProcess } from '../../../src/effects/process-runner';
import type { MultiRepositoryMcpToolContext } from "../multi-repository";
import { allControllerToolDefinitions, controllerExposureSnapshot, controllerToolSurfaceStatus } from "../toolset";
import { result } from "./result-adapter";
import { selected, selectedOptional } from "./shared-adapter";
import { SEMANTIC_SCOPE_KEY } from "../../../src/cli/repositories/controller-home";
import type { ExecutionJob } from '../../../src/runtime/execution/jobs/types';
import { getProcessRecord, isManagedProcessActive, processRuntimeResourceDiagnostics } from "../../../src/runtime/execution/process-runtime";
import { formatRuntimeSourceDriftMessage, readRuntimeGeneration } from "../../../src/runtime/control-plane/runtime-generation";
import { listControllerChecks } from "../../../src/cli/controller/check-runner";
import { buildCheckExecutionSchedule } from "../../../src/runtime/execution/process-runtime/check-scheduling";
import { listAssistantPluginManifests } from "../../../src/runtime/plugins/store";
import { cachedGitIdentity, gitSnapshot } from "../../../src/cli/repository/inspector";
import { buildRuntimeMaintenanceStatus } from "../../../src/runtime/recovery";
import { allowedFacadeOperations, buildFacadeResult, listCapabilityDescriptors, summarizeCapabilityGroups, listHandoffAttentionItems, normalizeCheckIds, buildWorkContinuationSnapshot, listPlanContracts, summarizePlanContract, runHandoffInboxApplication, type FacadeTool } from "../../../src/runtime/control-plane/facade";
import { buildJobOperationDigest } from '../../../src/runtime/control-plane/facade/operation-digest';
import { readActiveWorkCandidates, type InvalidActiveWorkCandidate } from "../../../packages/kernel/work/api/index";
import { observeRuntimeStatus } from "../../../src/runtime/root/status";
import { getControllerSession } from "../../../packages/kernel/controller/api/index";
import { summarizeHandoffItem } from '../../../src/runtime/control-plane/facade';
import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import { triggerResolvedHandoffContinuation } from '../../../src/runtime/workflow/schedules/work-continuation';
import { getUserRequest, listUserRequests, recordUserRequest, resolveUserRequest, type UserRequest } from '../../../packages/kernel/identity/api/index';
import { controllerReadinessEvidence, runtimeSourceSnapshotStatus } from './runtime-readiness-observation';
export { ageMs, probeLocalControllerHealth, localControllerDiagnosticMatchesRuntime, controllerReadinessEvidence, runtimeSourceSnapshotStatus } from './runtime-readiness-observation';
export type { ControllerReadinessSignals } from './runtime-readiness-observation';


export const GIT_IDENTITY_SAMPLE_TTL_MS = Math.max(1_000, Number(process.env.FORGE_GIT_IDENTITY_SAMPLE_TTL_MS ?? 3_000));

export function repositoryRevisionContains(repoRoot: string, ancestorRevision: string, descendantRevision: string): boolean {
  const ancestor = ancestorRevision.trim();
  const descendant = descendantRevision.trim();
  if (!/^[a-f0-9]{40}$/i.test(ancestor) || !/^[a-f0-9]{40}$/i.test(descendant)) return false;
  if (ancestor === descendant) return true;
  return runProcess('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: repoRoot,
    timeoutMs: 10_000,
    maxOutputBytes: 32_000,
  }).ok;
}

export function summarizeInvalidActiveWorkCandidate(entry: InvalidActiveWorkCandidate) {
  return {
    workId: entry.workId,
    updatedAt: entry.updatedAt,
    requirementId: entry.requirementId,
    planId: entry.planId,
    planStepId: entry.planStepId,
    semanticScopeKeys: entry.semanticScopeKeys.slice(0, 4),
    isolation: entry.isolation,
    error: entry.error.slice(0, 160),
  };
}

export function summarizeWorkListItem(job: ExecutionJob): Record<string, unknown> {
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

export function invalidFacadeOperation(tool: FacadeTool, operation: string): CallToolResult {
  const allowed = allowedFacadeOperations(tool);
  const facade = buildFacadeResult({
    status: 'failed',
    summary: `Invalid ${tool} operation: ${operation || '<empty>'}.`,
    data: { tool, operation: operation || null, allowedOperations: [...allowed] },
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

export interface StatusInboxAdapterPorts {
  repair(
    ctx: MultiRepositoryMcpToolContext,
    repository: ReturnType<typeof selected>,
    args: Record<string, unknown>,
  ): Promise<CallToolResult>;
}

export async function callStatusInboxAdapter(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
  ports: StatusInboxAdapterPorts,
): Promise<CallToolResult | undefined> {
  if (name === 'rh_status') {
      const repository = selectedOptional(ctx, args);
      const operation = String(args.operation ?? 'get');
      if (!allowedFacadeOperations('rh_status').includes(operation)) {
        return invalidFacadeOperation('rh_status', operation);
      }
      // Instance-level status stays available with zero (or several) registered
      // repositories: only the repository-derived sections need a target.
      const store = repository
        ? {
            controllerHome: ctx.controllerHome,
            repoId: repository.repoId,
            revisionContains: (ancestorRevision: string, descendantRevision: string) =>
              repositoryRevisionContains(repository.canonicalRoot, ancestorRevision, descendantRevision),
          }
        : undefined;
      if (operation === 'repair') {
        if (!repository) {
          return result(buildFacadeResult({
            status: 'blocked',
            summary: 'REPOSITORY_CONTEXT_REQUIRED_FOR_REPAIR: rh_status repair needs an explicit repository target.',
            data: { operation, repositoryContext: null },
          }) as unknown as Record<string, unknown>, true);
        }
        return await ports.repair(ctx, repository, args);
      }
      const requestedDetailLevel = args.detail_level === 'detail' ? 'detail' : 'summary';
      // Repository detail needs a repository; the instance-level summary remains
      // available and reports the downgrade explicitly instead of failing.
      const detailLevel = repository ? requestedDetailLevel : 'summary';
      if (detailLevel === 'summary') {
        const startedAt = performance.now();
        let summaryTimingMark = startedAt;
        const summaryPhaseTimingsMs: Record<string, number> = {};
        const markSummaryPhase = (phase: string): void => {
          const now = performance.now();
          summaryPhaseTimingsMs[phase] = Number((now - summaryTimingMark).toFixed(2));
          summaryTimingMark = now;
        };
        const observation = observeRuntimeStatus(ctx.controllerHome);
        markSummaryPhase('runtime');
        // Summary answers only whether this repository can work now. Reuse one
        // porcelain-v2 sample for branch/HEAD/dirty and avoid the full Git
        // status/diff-stat, access-policy, and inventory construction paths.
        const repositoryIdentity = repository ? cachedGitIdentity(repository.canonicalRoot) : undefined;
        const repositoryIdentityAgeMs = repositoryIdentity ? Math.max(0, Date.now() - repositoryIdentity.sampledAt) : undefined;
        markSummaryPhase('git');
        const runtimeGeneration = readRuntimeGeneration(ctx.controllerHome);
        const runtimeSource = runtimeSourceSnapshotStatus(
          runtimeGeneration?.source,
          ctx.runtimeSourceRoot,
        );
        const sourceSnapshotStale = runtimeSource.restartRequired;
        const exposure = controllerToolSurfaceStatus(ctx);
        markSummaryPhase('source_tool_surface');
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
        const activeWorkProjection = repository && store
          ? readActiveWorkCandidates({ ...store, limit: 3 })
          : { contracts: [], invalid: [] };
        const activeWorkSnapshot = activeWorkProjection.contracts.map((entry) => ({
          workId: entry.workId,
          status: entry.status,
          objective: entry.objective.slice(0, 160),
          semantics: buildWorkContinuationSnapshot(entry).semantics,
          nextSafeAction: buildWorkContinuationSnapshot(entry).nextSafeAction,
        }));
        // Plans are authored semantic context: without a repository target the
        // instance-level semantic scope carries them.
        const activePlanSnapshot = (repository && store
          ? listPlanContracts({ ...store, status: 'active', limit: 3 })
          : listPlanContracts({ controllerHome: ctx.controllerHome, scopeKey: SEMANTIC_SCOPE_KEY, status: 'active', limit: 3 })
        ).map(summarizePlanContract);
        const pendingHandoffAttention = store ? listHandoffAttentionItems(store, 100) : [];
        const pendingHandoffSnapshot = pendingHandoffAttention.slice(0, 4);
        const pendingHandoffCount = pendingHandoffAttention.length;
        markSummaryPhase('controller_state');
        const preferredFacadeTools = ['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work'] as const;
        const facade = buildFacadeResult({
          status: ready ? 'ok' : 'blocked',
          summary: ready ? 'Controller and MCP tool surface are ready for bounded work.' : 'Controller or MCP tool surface needs attention before work.',
          data: {
            operation,
            ...(repository ? { repoId: repository.repoId } : {}),
            /** Null means this answer is ForgeInstance-scoped, not repository-scoped. */
            repositoryContext: repository ? { repoId: repository.repoId, checkoutId: repository.activeCheckoutId } : null,
            requestedDetailLevel,
            readiness: {
              ready,
              readyFor: 'bounded_execution',
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
                  // Summary is intentionally the cheap Runtime snapshot path. It
                  // reports bounded execution readiness without pretending that the
                  // full scheduler/worker diagnostics for unattended continuation ran.
                  autonomousContinuationReady: null,
                  autonomousContinuationBlockers: null,
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
            repositoryState: repositoryIdentity
              ? {
                  branch: repositoryIdentity.branch,
                  head: repositoryIdentity.head,
                  dirty: repositoryIdentity.dirty,
                  observedAt: new Date(repositoryIdentity.sampledAt).toISOString(),
                  observationAgeMs: repositoryIdentityAgeMs,
                  observationMaxAgeMs: GIT_IDENTITY_SAMPLE_TTL_MS,
                  observationPolicy: 'bounded_sample_with_mutation_invalidation',
                  sourceSnapshotAgeMs: runtimeGeneration?.source.observedAt
                    ? Math.max(0, Date.now() - Date.parse(runtimeGeneration.source.observedAt))
                    : undefined,
                  sourceSnapshotStale,
                  sourceSnapshotReasons: runtimeSource.reasons,
                  runtimeSourceDirty: runtimeSource.current?.dirty === true,
                }
              : null,
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
              invalidActiveWorkCount: activeWorkProjection.invalid.length,
              invalidActiveWork: activeWorkProjection.invalid.slice(0, 3).map(summarizeInvalidActiveWorkCandidate),
              activePlans: activePlanSnapshot,
              pendingHandoffCount,
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
        markSummaryPhase('response_build');
        const payload = facade as unknown as Record<string, unknown>;
        payload.responseMeta = {
          serverDurationMs: Number((performance.now() - startedAt).toFixed(2)),
          phaseTimingsMs: summaryPhaseTimingsMs,
          structuredPayloadBytes: 0,
        };
        (payload.responseMeta as { structuredPayloadBytes: number }).structuredPayloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
        return result(payload, facade.status !== 'ok');
      }
      // Detail is repository-derived; without a repository target the requested
      // detail level was already downgraded to the instance-level summary above.
      if (!repository || !store) {
        return result(buildFacadeResult({
          status: 'blocked',
          summary: 'REPOSITORY_CONTEXT_REQUIRED_FOR_DETAIL: rh_status detail needs an explicit repository target.',
          data: { operation, repositoryContext: null },
        }) as unknown as Record<string, unknown>, true);
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
      const exposure = controllerExposureSnapshot(ctx);
      const localRegisteredToolNames = allControllerToolDefinitions(ctx).map((tool) => tool.name).sort();
      markDetailPhase('tool_surface');
      const toolSurfaceReady = exposure.ready && exposure.missingToolNames.length === 0;
      // Ordinary interactive execution depends on the execution axis only.
      // Maintenance debt / durable queue debt are reported as separate
      // semantics and must not promote ordinary work into repair flows.
      const executionReady = readiness.semantics.executionReady;
      let maintenanceHealthy: boolean | null = null;
      let maintenanceCandidateCount: number | null = null;
      let maintenanceObservation: 'not_requested' | 'observed' | 'unavailable' = 'not_requested';
      // A full maintenance pass traverses runtime storage, retained Work and
      // temp roots. It is a diagnostic with a dedicated typed tool, not a
      // prerequisite for an ordinary detailed status read. Do not hide that
      // cost behind a cross-request cache or represent unobserved debt as
      // healthy; callers can opt in when that diagnostic changes a decision.
      if (args.include_maintenance === true) {
        try {
          const maintenance = buildRuntimeMaintenanceStatus(repository, ctx.controllerHome, { maxCandidates: 20 });
          // stale_runtime_temp_entry is non-blocking by design (the executor
          // excludes it from readyForExecution), so it is not maintenance debt.
          const blockingCandidates = maintenance.candidates.filter((candidate) => candidate.kind !== 'stale_runtime_temp_entry');
          maintenanceHealthy = blockingCandidates.length === 0;
          maintenanceCandidateCount = blockingCandidates.length;
          maintenanceObservation = 'observed';
        } catch {
          maintenanceHealthy = null;
          maintenanceObservation = 'unavailable';
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
      const autonomousContinuationReady = readiness.ready && toolSurfaceReady && !sourceSnapshotStale;
      const autonomousContinuationBlockers = [...new Set(
        readinessReasons
          .map((reason) => reason.code)
          .filter((code): code is string => typeof code === 'string' && code.length > 0),
      )];
      const readinessWithToolSurface = {
        ready: effectiveReady,
        readyFor: 'bounded_execution' as const,
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
            // Derived from existing whole-runtime health and the same tool/source
            // coherence gates already reported here. Per-Work continuation
            // eligibility remains owned by Controller/Scheduler lifecycle facts.
            autonomousContinuationReady,
            autonomousContinuationBlockers,
            maintenanceHealthy,
            maintenanceCandidateCount,
            maintenanceObservation,
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
        // rh_status detail is still a read path. Missing materialized plugin
        // projections remain unknown until explicit discovery/execution refreshes
        // them; status must never synchronously probe provider hosts.
        fallbackToLive: false,
      });
      const capabilities = listCapabilityDescriptors(manifests);
      markDetailPhase('plugins');
      const pendingHandoffAttention = listHandoffAttentionItems(store, 100);
      const pendingHandoffs = pendingHandoffAttention.slice(0, 20);
      const pendingHandoffCount = pendingHandoffAttention.length;
      const activeWorkProjection = readActiveWorkCandidates({ ...store, limit: 200 });
      const activeContracts = activeWorkProjection.contracts;
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
        summary: effectiveReady
          ? autonomousContinuationReady
            ? 'Controller and MCP tool surface are ready for bounded work and autonomous continuation.'
            : 'Controller and MCP tool surface are ready for bounded work; autonomous continuation needs attention.'
          : 'Controller or MCP tool surface needs attention before bounded work.',
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
          pendingHandoffCount,
          // User-facing Work count means objective-level primary lanes. Low-level
          // resumable operation handles are reported separately.
          activeWorkCount: activePrimaryWork.length,
          activePrimaryWorkCount: activePrimaryWork.length,
          activeExecutionChildCount: activeExecutionChildren.length,
          activeProcessCount: activeProcessRecords.length,
          executingPrimaryWorkCount: executingPrimaryWorkIds.size,
          waitingPrimaryWorkCount: Math.max(0, activePrimaryWork.length - executingPrimaryWorkIds.size),
          activeContractCount: activeContracts.length,
          invalidActiveContractCount: activeWorkProjection.invalid.length,
          invalidActiveContracts: activeWorkProjection.invalid.slice(0, 10).map(summarizeInvalidActiveWorkCandidate),
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
  if (name === 'rh_inbox') {
    return await callInboxAdapter(ctx, args);
  }
  return undefined;
}

function summarizeUserRequest(request: UserRequest) {
  return {
    requestId: request.requestId,
    kind: request.kind,
    title: request.title,
    summary: request.summary,
    actionRequired: request.actionRequired,
    status: request.status,
    targetScope: request.targetScope,
    resolution: request.resolution,
    updatedAt: request.updatedAt,
  };
}

function findCanonicalUserRequest(controllerHome: string, args: Record<string, unknown>): UserRequest | undefined {
  const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
  if (requestId) return getUserRequest(controllerHome, requestId);
  const legacyHandoffId = typeof args.handoff_id === 'string' ? args.handoff_id.trim() : '';
  if (!legacyHandoffId) return undefined;
  return listUserRequests(controllerHome, 'all').find((request) => request.presentation?.legacyHandoffId === legacyHandoffId);
}

function callCanonicalUserRequestInbox(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>, operation: string): CallToolResult {
  const limit = Math.max(1, Math.min(Math.trunc(typeof args.limit === 'number' ? args.limit : 50), 100));
  if (operation === 'list') {
    const items = listUserRequests(ctx.controllerHome, 'pending').slice(0, limit);
    return result(buildFacadeResult({
      summary: items.length ? `${items.length} pending UserRequest item(s).` : 'No pending UserRequest items.',
      data: { items: items.map(summarizeUserRequest) },
      suggestedNextActions: items.slice(0, 1).map((item) => ({ label: `Read ${item.requestId}`, tool: 'rh_inbox', operation: 'get', payload: { request_id: item.requestId }, risk: 'readonly' as const })),
    }) as unknown as Record<string, unknown>);
  }
  if (operation === 'create') {
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const summary = typeof args.summary === 'string' ? args.summary.trim() : typeof args.reason === 'string' ? args.reason.trim() : '';
    if (!title || !summary) throw new Error('USER_REQUEST_TITLE_SUMMARY_REQUIRED');
    const workId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
    const explicitId = typeof args.request_id === 'string' ? args.request_id.trim() : typeof args.handoff_id === 'string' ? args.handoff_id.trim() : '';
    const actionRequired = (typeof args.action_required === 'string' ? args.action_required : 'product_decision') as 'login' | 'grant_permission' | 'confirm_destructive' | 'product_decision';
    const kind = (typeof args.request_kind === 'string' ? args.request_kind : actionRequired === 'product_decision' ? 'user_decision_request' : 'user_action_request') as 'user_action_request' | 'user_decision_request';
    const rootCauseKey = typeof args.root_cause_key === 'string' && args.root_cause_key.trim()
      ? args.root_cause_key.trim()
      : `rh_inbox:${explicitId || workId || title}:${summary}`;
    const item = recordUserRequest(ctx.controllerHome, {
      ...(explicitId ? { requestId: explicitId } : {}),
      kind,
      rootCauseKey,
      title,
      summary,
      actionRequired,
      ...(workId ? { targetScope: { scopeKind: 'work', scopeId: workId, workId } } : {}),
      presentation: {
        ...(typeof args.handoff_id === 'string' && args.handoff_id.trim() ? { legacyHandoffId: args.handoff_id.trim() } : {}),
        ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
        ...(typeof args.recommended_decision === 'string' ? { recommendedDecision: args.recommended_decision } : {}),
        ...(typeof args.recommended_prompt === 'string' ? { recommendedPrompt: args.recommended_prompt } : {}),
      },
    });
    return result(buildFacadeResult({ summary: `Created UserRequest ${item.requestId}.`, data: { item: summarizeUserRequest(item) } }) as unknown as Record<string, unknown>);
  }
  const current = findCanonicalUserRequest(ctx.controllerHome, args);
  if (operation === 'get') {
    const facade = buildFacadeResult({
      status: current ? 'ok' : 'not_found',
      summary: current ? `UserRequest ${current.requestId}.` : 'UserRequest not found.',
      data: { item: current ? summarizeUserRequest(current) : undefined },
      suggestedNextActions: current?.status === 'pending' ? [{ label: 'Resolve request', tool: 'rh_inbox', operation: 'resolve', payload: { request_id: current.requestId }, risk: 'workspace_write' }] : [],
    });
    return result(facade as unknown as Record<string, unknown>, facade.status === 'not_found');
  }
  if (!current) throw new Error('USER_REQUEST_NOT_FOUND');
  if (operation === 'ack' || operation === 'accept') {
    return result(buildFacadeResult({
      summary: `${operation === 'accept' ? 'Accepted' : 'Acknowledged'} UserRequest ${current.requestId}; semantic state remains pending until resolve/dismiss.`,
      data: { item: summarizeUserRequest(current), compatibilityNoop: true },
    }) as unknown as Record<string, unknown>);
  }
  if (operation === 'resolve' || operation === 'dismiss') {
    const decision = operation === 'dismiss'
      ? (typeof args.decision === 'string' && args.decision.trim() ? args.decision.trim() : 'dismissed')
      : (typeof args.decision === 'string' ? args.decision.trim() : '');
    if (!decision) throw new Error('USER_REQUEST_DECISION_REQUIRED');
    const resolved = resolveUserRequest(ctx.controllerHome, {
      requestId: current.requestId,
      decision,
      resolvedBy: typeof args.resolver === 'string' && args.resolver.trim() ? args.resolver.trim() : (ctx.principalId?.trim() || 'mcp-user'),
    });
    return result(buildFacadeResult({ summary: `Resolved UserRequest ${resolved.requestId}.`, data: { item: summarizeUserRequest(resolved) } }) as unknown as Record<string, unknown>);
  }
  throw new Error(`USER_REQUEST_OPERATION_UNSUPPORTED:${operation}`);
}

async function callInboxAdapter(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>): Promise<CallToolResult> {
  const repository = selectedOptional(ctx, args);
  const operation = String(args.operation ?? 'list');
  if (!allowedFacadeOperations('rh_inbox').includes(operation)) return invalidFacadeOperation('rh_inbox', operation);
  const canonicalRequestId = typeof args.request_id === 'string' && args.request_id.trim();
  if (!repository || canonicalRequestId) return callCanonicalUserRequestInbox(ctx, args, operation);
  const app = await runHandoffInboxApplication({
    operation: operation as 'get' | 'list' | 'ack' | 'accept' | 'resolve' | 'dismiss' | 'create',
    store: { controllerHome: ctx.controllerHome, repoId: repository.repoId },
    handoffId: typeof args.handoff_id === 'string' ? args.handoff_id : undefined,
    limit: typeof args.limit === 'number' ? args.limit : undefined,
    workId: typeof args.work_id === 'string' ? args.work_id : undefined,
    title: typeof args.title === 'string' ? args.title : undefined,
    reason: typeof args.reason === 'string' ? args.reason : undefined,
    summary: typeof args.summary === 'string' ? args.summary : undefined,
    attemptedActions: Array.isArray(args.attempted_actions) ? args.attempted_actions.map(String) : undefined,
    blockingDecision: typeof args.blocking_decision === 'string' ? args.blocking_decision : undefined,
    recommendedDecision: typeof args.recommended_decision === 'string' ? args.recommended_decision : undefined,
    recommendedPrompt: typeof args.recommended_prompt === 'string' ? args.recommended_prompt : undefined,
    recommendedContinuationPrompt: typeof args.recommended_continuation_prompt === 'string' ? args.recommended_continuation_prompt : undefined,
    decision: typeof args.decision === 'string' ? args.decision : undefined,
    resolver: typeof args.resolver === 'string' ? args.resolver : undefined,
    controllerIdentity: { principalId: ctx.principalId, sessionId: ctx.sessionId },
  }, {
    triggerResolvedContinuation: (item) => triggerResolvedHandoffContinuation(ctx.controllerHome, repository.repoId, item),
  });
  if (operation === 'get') {
    const item = 'item' in app ? app.item : undefined;
    const facade = buildFacadeResult({
      status: item ? 'ok' : 'not_found',
      summary: item ? `Handoff ${item.id}.` : 'Handoff item not found.',
      data: { item },
      suggestedNextActions: item && item.status === 'pending'
        ? [{ label: 'Acknowledge handoff', tool: 'rh_inbox', operation: 'ack', payload: { handoff_id: item.id }, risk: 'readonly' }]
        : [],
    });
    return result(facade as unknown as Record<string, unknown>, facade.status === 'not_found');
  }
  if (operation === 'list') {
    const items = 'items' in app && Array.isArray(app.items) ? app.items : [];
    return result(buildFacadeResult({
      summary: items.length ? `${items.length} pending handoff item(s).` : 'No pending handoff items.',
      data: { items: items.map(summarizeHandoffItem) },
      suggestedNextActions: items.slice(0, 1).map((item) => ({ label: `Read ${item.id}`, tool: 'rh_inbox', operation: 'get', payload: { handoff_id: item.id }, risk: 'readonly' as const })),
    }) as unknown as Record<string, unknown>);
  }
  const item = 'item' in app ? app.item : undefined;
  if (!item) throw new Error(`HANDOFF_APPLICATION_RESULT_INVALID:${operation}`);
  if (operation === 'resolve') {
    return result(buildFacadeResult({
      summary: `Resolved handoff ${item.id}.`,
      data: { item: { id: item.id, status: item.status, decision: item.decision, resolver: item.resolver }, continuationOccurrences: 'continuationOccurrences' in app ? app.continuationOccurrences : [] },
    }) as unknown as Record<string, unknown>);
  }
  if (operation === 'dismiss') {
    return result(buildFacadeResult({
      summary: `Dismissed handoff ${item.id}.`,
      data: { item: { id: item.id, status: item.status, decision: item.decision, resolver: item.resolver } },
    }) as unknown as Record<string, unknown>);
  }
  if (operation === 'create') {
    return result(buildFacadeResult({
      summary: `Created handoff ${item.id}.`,
      data: { item: summarizeHandoffItem(item), ownershipReleased: 'ownershipReleased' in app ? app.ownershipReleased : false },
    }) as unknown as Record<string, unknown>);
  }
  return result(buildFacadeResult({
    summary: `${operation === 'accept' ? 'Accepted' : 'Acknowledged'} handoff ${item.id}.`,
    data: { item },
    suggestedNextActions: item.suggestedNextActions,
  }) as unknown as Record<string, unknown>);
}
