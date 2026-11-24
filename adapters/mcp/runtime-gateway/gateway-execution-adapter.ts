import { createHash } from 'crypto';
import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { callRepositoryTool } from '../../../src/runtime/control-plane/facade/repository-tool-dispatch';
import { resolveRepositorySelection } from '../../../src/runtime/repositories/registry';
import { listControllerChecks } from '../../../src/runtime/execution/process-runtime/check-runner';
import { executionIdentityForRepository } from '../../../src/runtime/control-plane/execution/execution-identity';
import { checkRequiresDurableWorkflow } from '../../../src/runtime/execution/process-runtime';
import { runPersistedCheckViaProcessRuntime } from './persisted-check-process';
import { buildCheckExecutionSchedule } from '../../../src/runtime/execution/process-runtime/check-scheduling';
import {
  isProcessIsolatedReadDiagnostic,
  runReadOnlyDiagnosticViaProcessRuntime,
} from '../../../src/runtime/diagnostics/process-facade';
import { result } from './result-adapter';

export function requestsRepositorySafePatchValidation(args: Record<string, unknown>): boolean {
  return args.validation_only === true || (Array.isArray(args.check_ids) && args.check_ids.length > 0);
}

export async function executeRepositorySafePatchComposite(
  ctx: MultiRepositoryMcpToolContext,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  if (args.validation_only === true) {
    return result(
      {
        accepted: false,
        mode: 'reject',
        path: 'reject',
        error: {
          code: 'SAFE_PATCH_VALIDATION_ONLY_RETIRED',
          message: 'Session-bound validation_only is retired; run run_check with explicit repo_id and checkout_id.',
        },
      },
      true,
    );
  }

  const repository = resolveRepositorySelection({
    repoId: typeof args.repo_id === 'string' ? args.repo_id : undefined,
    checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
    explicitPath: ctx.explicitRepository?.canonicalRoot,
    controllerHome: ctx.controllerHome,
    allowSoleRepository: true,
  });
  if (!repository) {
    return result(
      {
        accepted: false,
        mode: 'reject',
        path: 'reject',
        message: 'repository_safe_patch_apply requires a resolvable repository',
      },
      true,
    );
  }

  const checkIds = Array.isArray(args.check_ids)
    ? [...new Set(args.check_ids.map((value: unknown) => String(value).trim()).filter(Boolean))]
    : [];
  const {
    check_ids: _checkIds,
    validation_only: _validationOnly,
    validation_request_id: _validationRequestId,
    reviewer: _reviewer,
    note: _note,
    check_timeout_ms: _checkTimeoutMs,
    lease_wait_ms: _leaseWaitMs,
    interactive_wait_ms: _interactiveWaitMs,
    timeout_ms: _timeoutMs,
    ...patchArgs
  } = args;

  const applied = await callRepositoryTool(ctx.controllerHome, 'repository_safe_patch_apply', patchArgs, ctx);
  if (!applied || applied.isError === true) {
    return (
      applied ??
      result(
        {
          accepted: false,
          mode: 'reject',
          path: 'reject',
          message: 'repository_safe_patch_apply route is unavailable',
        },
        true,
      )
    );
  }
  const patchPayload = (applied.structuredContent ?? {}) as Record<string, unknown>;
  if (patchPayload.status !== 'applied' || checkIds.length === 0) return applied;

  const explicitValidationRequestId =
    typeof args.validation_request_id === 'string' ? args.validation_request_id.trim() : '';
  const patchRequestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
  const validationRequestId = explicitValidationRequestId || (patchRequestId ? patchRequestId + ':checks' : undefined);
  const timeoutMs =
    typeof args.check_timeout_ms === 'number'
      ? args.check_timeout_ms
      : typeof args.timeout_ms === 'number'
        ? args.timeout_ms
        : undefined;
  const validation = await executeGatewayRoutedOperation(
    ctx,
    'run_check',
    {
      repo_id: repository.repoId,
      checkout_id: repository.activeCheckoutId,
      check_ids: checkIds,
      ...(typeof timeoutMs === 'number' ? { timeout_ms: timeoutMs } : {}),
      interactive_wait_ms: 0,
      ...(validationRequestId ? { request_id: validationRequestId } : {}),
    },
    { path: 'fast', reasons: ['post_patch_process_checks'] },
  );
  if (!validation) {
    return result(
      {
        accepted: false,
        mode: 'reject',
        path: 'reject',
        error: {
          code: 'POST_PATCH_CHECK_ROUTE_UNAVAILABLE',
          message: 'The patch was applied, but the Process Runtime run_check route is unavailable.',
        },
        patch: patchPayload,
      },
      true,
    );
  }

  const validationPayload = (validation.structuredContent ?? {}) as Record<string, unknown>;
  const validationStarted = validationPayload.accepted === true;
  const validationCompleted = validationPayload.completed === true;
  const validationPassed = validationCompleted && validationPayload.ok === true;
  return result(
    {
      ...patchPayload,
      validation: validationPayload,
      validationStarted,
      validationCompleted,
      validationPassed,
      acceptanceReady: validationPassed,
      ...(validationRequestId ? { validationRequestId } : {}),
      next: validationCompleted
        ? validationPassed
          ? 'Patch applied and the requested Process Runtime checks passed; proceed only after ChatGPT semantic review.'
          : 'Patch applied but one or more checks failed; return the Process evidence for a targeted repair.'
        : validationStarted
          ? 'Patch applied and Process Runtime checks are running independently; attach to returned processes when their results become a dependency.'
          : 'Patch applied; requested checks were rejected and must be corrected before delivery.',
    },
    validation.isError === true,
  );
}

export async function executeGatewayRoutedOperation(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
  classification: { path: 'direct' | 'fast' | 'durable' | 'reject'; reasons: string[] },
): Promise<CallToolResult | undefined> {
  if (isProcessIsolatedReadDiagnostic(name) && classification.path === 'fast') {
    const repository = resolveRepositorySelection({
      repoId: typeof args.repo_id === 'string' ? args.repo_id : undefined,
      checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
      explicitPath: ctx.explicitRepository?.canonicalRoot,
      controllerHome: ctx.controllerHome,
      allowSoleRepository: true,
    });
    if (!repository) {
      return result(
        {
          accepted: false,
          mode: 'reject',
          path: 'reject',
          message: `${name} requires a resolvable repository`,
        },
        true,
      );
    }
    try {
      const payload = await runReadOnlyDiagnosticViaProcessRuntime({
        controllerHome: ctx.controllerHome,
        repository,
        tool: name,
        args: {
          ...args,
          __diagnostic_toolset: ctx.toolset,
          __diagnostic_profile: ctx.policy.profile,
        },
      });
      return result(payload, payload.accepted === false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const processErrorCode = /^((?:PROCESS_)[A-Z0-9_]+)(?::|$)/.exec(message)?.[1];
      const code = processErrorCode ?? 'DIAGNOSTIC_PROCESS_FAILED';
      return result(
        {
          accepted: false,
          mode: 'process_direct',
          path: 'process_direct',
          error: { code, message },
          durableSideEffects: {
            executionJobCount: 0,
            localJobCount: 0,
            workerSpawnCount: 0,
            projectionUpdateCount: 0,
          },
        },
        true,
      );
    }
  }

  // run_check Process Runtime facade — execute here so legacy LocalBridgeJob path is skipped.
  if (name === 'run_check' && classification.path === 'fast') {
    const restoringDisabledRepository = false;
    void restoringDisabledRepository;
    const repository = resolveRepositorySelection({
      repoId: typeof args.repo_id === 'string' ? args.repo_id : undefined,
      checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
      explicitPath: ctx.explicitRepository?.canonicalRoot,
      controllerHome: ctx.controllerHome,
      allowSoleRepository: true,
    });
    if (!repository) {
      return result({
        accepted: false,
        mode: 'reject',
        path: 'reject',
        message: 'run_check requires a resolvable repository',
      });
    }
    const checkId = String(args.check_id ?? '').trim();
    const rawBatchCheckIds = args.check_ids;
    const hasBatchInput = Array.isArray(rawBatchCheckIds);
    const batchCheckIds: string[] = hasBatchInput
      ? [...new Set(rawBatchCheckIds.map((value: unknown) => String(value).trim()).filter(Boolean))]
      : [];
    if (checkId && hasBatchInput) {
      return result(
        {
          accepted: false,
          mode: 'reject',
          path: 'reject',
          message: 'run_check accepts either check_id or check_ids, not both',
        },
        true,
      );
    }
    if (!checkId && batchCheckIds.length === 0) {
      return result(
        {
          accepted: false,
          mode: 'reject',
          path: 'reject',
          message: 'run_check requires check_id or a non-empty check_ids array',
        },
        true,
      );
    }
    if (hasBatchInput) {
      const availableChecks = listControllerChecks(repository.canonicalRoot);
      const availableChecksById = new Map(availableChecks.map((check) => [check.id, check]));
      const checkScheduling = buildCheckExecutionSchedule({
        checks: availableChecks,
        requestedCheckIds: batchCheckIds,
        repoId: repository.repoId,
        checkoutId: repository.activeCheckoutId,
      });
      const schedulePayload = {
        waveCount: checkScheduling.waves.length,
        maxParallel: checkScheduling.maxParallel,
        waves: checkScheduling.waves,
        conflicts: checkScheduling.conflicts,
        invalidCheckIds: checkScheduling.invalidCheckIds,
        guidance: checkScheduling.guidance,
      };
      if (checkScheduling.invalidCheckIds.length > 0) {
        return result(
          {
            accepted: false,
            mode: 'reject',
            path: 'reject',
            reason: 'invalid_check_ids',
            checkIds: batchCheckIds,
            checkScheduling: schedulePayload,
            message: `run_check batch contains unregistered checks: ${checkScheduling.invalidCheckIds.join(', ')}`,
          },
          true,
        );
      }
      const durableCheckIds = batchCheckIds.filter((id) => checkRequiresDurableWorkflow(availableChecksById.get(id)));
      if (durableCheckIds.length > 0) {
        return result(
          {
            accepted: false,
            mode: 'reject',
            path: 'reject',
            reason: 'batch_contains_durable_check',
            checkIds: batchCheckIds,
            durableCheckIds,
            checkScheduling: schedulePayload,
            message:
              'Batch run_check only launches ordinary focused checks; run release or multi-phase checks through an explicit durable workflow.',
          },
          true,
        );
      }
      if (checkScheduling.waves.length !== 1 || checkScheduling.waves[0]?.checkIds.length !== batchCheckIds.length) {
        return result(
          {
            accepted: false,
            mode: 'reject',
            path: 'reject',
            reason: 'batch_spans_multiple_check_waves',
            checkIds: batchCheckIds,
            checkScheduling: schedulePayload,
            message:
              'Requested checks span multiple resource-conflicting waves. Launch one returned wave per run_check call; Forge will not hide serial waiting inside a batch.',
          },
          true,
        );
      }
      const baseRequestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
      const facades = await Promise.all(
        batchCheckIds.map((batchCheckId, index) => {
          const suffix = createHash('sha256').update(batchCheckId).digest('hex').slice(0, 8);
          return runPersistedCheckViaProcessRuntime({
            controllerHome: ctx.controllerHome,
            repoId: repository.repoId,
            checkoutId: repository.activeCheckoutId,
            repoRoot: repository.canonicalRoot,
            executionIdentity: executionIdentityForRepository(repository),
            checkId: batchCheckId,
            timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
            interactiveWaitMs: 0,
            requestId: baseRequestId ? `${baseRequestId}:batch:${index + 1}:${suffix}` : undefined,
            forceDurable: false,
          });
        }),
      );
      const unexpectedDurable = facades.filter((facade) => facade.mode === 'durable');
      if (unexpectedDurable.length > 0) {
        return result(
          {
            accepted: false,
            mode: 'reject',
            path: 'reject',
            reason: 'batch_check_escalated_to_durable',
            checkIds: batchCheckIds,
            checkScheduling: schedulePayload,
            message:
              'At least one batch check unexpectedly requires Durable execution; no further batch orchestration will be created.',
          },
          true,
        );
      }
      const processes = facades.map((facade) => ({
        checkId: facade.checkId,
        processId: facade.process?.processId,
        status: facade.process?.status,
        completed: facade.process?.completed === true,
        ok: facade.process?.ok,
        exitCode: facade.process?.exitCode,
        timedOut: facade.process?.timedOut,
        deduplicated: facade.process?.deduplicated === true,
        semanticDeduplicated: facade.process?.semanticDeduplicated === true,
        durableSideEffects: facade.durableSideEffects,
      }));
      const completed = processes.every((process) => process.completed);
      const mode = processes.every((process) => process.completed) ? 'direct' : 'managed';
      const durableSideEffects = facades.reduce(
        (total, facade) => ({
          executionJobCount: total.executionJobCount + facade.durableSideEffects.executionJobCount,
          localJobCount: total.localJobCount + facade.durableSideEffects.localJobCount,
          workerSpawnCount: total.workerSpawnCount + facade.durableSideEffects.workerSpawnCount,
          projectionUpdateCount: total.projectionUpdateCount + facade.durableSideEffects.projectionUpdateCount,
        }),
        { executionJobCount: 0, localJobCount: 0, workerSpawnCount: 0, projectionUpdateCount: 0 },
      );
      return result({
        accepted: true,
        batch: true,
        mode,
        path: mode === 'direct' ? 'process_batch_direct' : 'process_batch_managed',
        routing: { path: 'fast', reasons: ['run_check_batch_process_runtime'] },
        repoId: repository.repoId,
        checkoutId: repository.activeCheckoutId,
        checkIds: batchCheckIds,
        checkScheduling: schedulePayload,
        processes,
        processIds: processes.map((process) => process.processId).filter(Boolean),
        completed,
        ...(completed ? { ok: processes.every((process) => process.ok === true) } : {}),
        durableSideEffects,
        next: completed
          ? 'Batch check wave finished on Process Runtime without ExecutionJob / LocalBridgeJob / Worker.'
          : 'Batch check wave is running concurrently. Continue independent work. Attach to each returned process only when that result becomes a real dependency; do not poll or re-run the checks.',
      });
    }
    const facade = await runPersistedCheckViaProcessRuntime({
      controllerHome: ctx.controllerHome,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      repoRoot: repository.canonicalRoot,
      executionIdentity: executionIdentityForRepository(repository),
      checkId,
      timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
      interactiveWaitMs:
        args.apply_mode === 'async' || args.mode === 'async' || args.async === true || args.background === true
          ? 0
          : typeof args.interactive_wait_ms === 'number'
            ? args.interactive_wait_ms
            : undefined,
      requestId: typeof args.request_id === 'string' ? args.request_id : undefined,
      forceDurable: args.force_durable === true || args.mode === 'durable',
    });
    if (facade.mode === 'durable') {
      // Multi-phase/release should already be classified durable. Remaining durable
      // reasons (missing check, explicit force) must not silently create empty jobs
      // without a clear signal — return structured escalation instead of LocalBridge.
      return result({
        accepted: false,
        mode: 'durable',
        path: 'durable',
        routing: {
          path: 'durable',
          reasons: [facade.durable?.reason ?? 'check_requires_durable'],
        },
        checkId: facade.checkId,
        message: facade.durable?.reason ?? 'check requires durable workflow',
        suggestedOperation: facade.durable?.suggestedOperation,
        durableSideEffects: facade.durableSideEffects,
      });
    }
    const handle = facade.process;
    return result({
      accepted: true,
      mode: facade.mode,
      path: facade.mode === 'direct' ? 'process_direct' : 'process_managed',
      routing: {
        path: facade.mode,
        reasons: classification.reasons,
      },
      checkId: facade.checkId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      processId: handle?.processId,
      status: handle?.status,
      completed: handle?.completed === true,
      deduplicated: handle?.deduplicated === true,
      semanticDeduplicated: handle?.semanticDeduplicated === true,
      ok: handle?.ok,
      exitCode: handle?.exitCode,
      timedOut: handle?.timedOut,
      stdout: handle?.stdout,
      stderr: handle?.stderr,
      durableSideEffects: facade.durableSideEffects,
      next: handle?.completed
        ? 'Check finished on Process Runtime without ExecutionJob / LocalBridgeJob / Worker.'
        : `Check still running as managed process ${handle?.processId}. Continue independent work; attach with process_wait only when this exact result becomes a real dependency. An attach may return a running handle because transport time is bounded; continue useful work and attach again only at a later dependency boundary. Do not re-run or periodically poll the same check.`,
    });
  }
  return undefined;
}
