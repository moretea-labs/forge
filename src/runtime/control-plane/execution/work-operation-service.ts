import { createHash, randomUUID } from 'crypto';
import { isAbsolute, relative, resolve } from 'path';
import type { McpExecutionContext } from '../../../../packages/protocols/mcp/execution-context';
import { repositoryGitStatus, repositoryGitDiff } from '../../../cli/repositories/structured-git';
import { classifyRepositoryCommand } from '../../../cli/repositories/command-classifier';
import { listControllerChecks } from '../../../cli/controller/check-runner';
import { readRepositoryAccessPolicy } from '../governance/access-policy';
import { appendVerificationRecord } from '../../../../packages/kernel/work/api/index';
import { validateWorkHandle } from './validation';
import { commandFingerprint, effectiveVerificationEvidence, verificationInputFingerprint, workspaceValidationFingerprint, workValidationInputFingerprint } from './verification-evidence';
import { executionIdentityForWork } from './execution-identity';
import { markWorkHandleFailed, transitionWorkHandle, type WorkHandleState } from './work-handle-store';
import { assertResolvedAuthorization, decideAuthorization, type AuthorizationDecision, type AuthorizationRiskClass } from '../governance/authorization';
import { recordMcpTiming } from '../../diagnostics/mcp-timing';
import { commandValue, normalizeRepositoryCommand, type RepositoryCommandValue } from '../../../cli/repositories/command-normalization';
import { executeRepositoryCommandViaProcessRuntime } from '../../execution/process-runtime/command-facade';
import { getCheckProcessHandle } from '../../execution/process-runtime/check-facade';
import { processCheckCompletionReceipt } from '../../execution/process-runtime/check-receipt';
import { classifyPersistedCheckTerminalEvidence } from '../../execution/process-runtime/check-result';
import { claimProcessInvocation, getProcessRecord } from '../../execution/process-runtime/store';
import { runPersistedCheckViaProcessRuntime } from '../../execution/process-runtime/persisted-check';
import { markWorkValidationPending, projectWorkValidationOutcome } from './work-validation-reconciler';
import { assertWorkControllerOwnership, compactHandle, contractFor, gitHead, identityFor, makeBoundedWorkResult, reconcileTerminalCleanup, requireSession, terminalCleanupOutcome, workForSession } from './work-execution-support';

function commandInputs(args: Record<string, unknown>): Array<Record<string, unknown>> {
  if (Array.isArray(args.commands)) return args.commands.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value)));
  if (args.command !== undefined) return [{ command: args.command, cwd: args.cwd, approval_token: args.approval_token, timeout_ms: args.timeout_ms, max_output_bytes: args.max_output_bytes }];
  throw new Error('COMMAND_REQUIRED: provide command or commands');
}

function authorizationRisk(command: RepositoryCommandValue, classification: ReturnType<typeof classifyRepositoryCommand>): AuthorizationRiskClass {
  if (classification.risk === 'readonly') return 'readonly';
  if (classification.risk === 'remote_write') return 'remote_write';
  if (classification.risk === 'destructive') return 'destructive';
  const executable = typeof command === 'string' ? command : command[0] ?? '';
  if (typeof command === 'string' && /\b(?:npm|bun|pnpm|yarn)\s+(?:install|add|remove|update)\b/i.test(command)) return 'dependency_change';
  if (/^\s*(?:git|.*[\\/]git)(?:\s|$)/i.test(executable)) return 'local_git';
  return 'workspace_write';
}

export async function executeWork(ctx: McpExecutionContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const session = requireSession(ctx, args);
  const handle = workForSession(ctx, session, args);
  assertWorkControllerOwnership(ctx, session, handle, args);
  const commands = commandInputs(args);
  if (commands.length > 16) throw new Error('COMMAND_BATCH_TOO_LARGE: at most 16 commands per work_execute');
  const cheap = validateWorkHandle(ctx.controllerHome, handle, identityFor(ctx, args), 'cheap', 'execute');
  const inputs = commands.map((entry) => ({
    command: commandValue(normalizeRepositoryCommand(entry.command)),
    cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
    approvalToken: typeof entry.approval_token === 'string' ? entry.approval_token : undefined,
  }));
  const classifications = inputs.map((entry) => classifyRepositoryCommand(entry.command, cheap.repository.defaultBranch));
  const requiresFull = classifications.some((classification) => classification.risk !== 'readonly');
  if (requiresFull) validateWorkHandle(ctx.controllerHome, handle, identityFor(ctx, args), 'full', 'execute');
  const decisions: AuthorizationDecision[] = [];
  const approvalRequestId = typeof args.approval_request_id === 'string' ? args.approval_request_id.trim() : '';
  const resolvedRequest = approvalRequestId
    ? assertResolvedAuthorization({ controllerHome: ctx.controllerHome, repositoryId: handle.repositoryId, approvalRequestId, sessionId: session.sessionId, principalId: session.principalId, workId: handle.workId, permissionSnapshotVersion: handle.permissionSnapshotVersion, command: inputs[0]?.command })
    : undefined;
  for (const [index, entry] of inputs.entries()) {
    const classification = classifications[index]!;
    const outsideCwd = Boolean(entry.cwd && (isAbsolute(entry.cwd) || (() => {
      const rel = relative(resolve(handle.worktreePath), resolve(handle.worktreePath, entry.cwd));
      return rel === '..' || rel.startsWith('../') || rel.startsWith('..\\');
    })()));
    const risk = outsideCwd ? 'outside_repository' : authorizationRisk(entry.command, classification);
    const decision = resolvedRequest
      ? { decision: 'allow', source: 'user_confirmation', reason: 'The user resolved the exact approval request for this command.' } as const
      : decideAuthorization({
        controllerHome: ctx.controllerHome,
        accessMode: readRepositoryAccessPolicy(ctx.controllerHome, handle.repositoryId).mode,
        risk,
        repositoryId: handle.repositoryId,
        currentRepositoryId: handle.repositoryId,
        workId: handle.workId,
        boundWorkId: handle.workId,
        goalId: handle.goalId,
        boundGoalId: handle.goalId,
        sessionId: session.sessionId,
        principalId: session.principalId,
        permissionSnapshotVersion: handle.permissionSnapshotVersion,
        delegation: session.goalDelegation,
        worktreePath: handle.worktreePath,
        cwd: entry.cwd,
        command: entry.command,
        approvedByUser: Boolean(resolvedRequest),
      });
    decisions.push(decision);
    if (decision.decision !== 'allow') return { authorization: decision, work: compactHandle(handle), command: entry.command };
  }
  const invocationId = typeof args.request_id === 'string' && args.request_id.trim()
    ? args.request_id.trim()
    : `invoke-${session.sessionId}-${handle.workId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const invocationFingerprint = createHash('sha256')
    .update(JSON.stringify({
      tool: 'work_execute',
      workId: handle.workId,
      commands: inputs.map((entry) => ({ command: entry.command, cwd: entry.cwd ?? null })),
      timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : null,
      maxOutputBytes: typeof args.max_output_bytes === 'number' ? args.max_output_bytes : null,
    }))
    .digest('hex');
  claimProcessInvocation({
    controllerHome: ctx.controllerHome,
    repoId: handle.repositoryId,
    checkoutId: handle.checkoutId,
    requestId: invocationId,
    invocationFingerprint,
  });
  const run = async (entry: typeof inputs[number], index: number) => {
    const commandId = `${invocationId}:command:${index + 1}`;
    const execution = await executeRepositoryCommandViaProcessRuntime({
      controllerHome: ctx.controllerHome,
      repository: cheap.worktreeRepository,
      executionIdentity: executionIdentityForWork(cheap.worktreeRepository, handle),
      command: entry.command,
      cwd: entry.cwd,
      workId: handle.workId,
      commandId,
      requestId: commandId,
      timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
      maxOutputBytes: typeof args.max_output_bytes === 'number' ? args.max_output_bytes : undefined,
    });
    const process = execution.process;
    const ok = process ? process.ok === true : execution.ok === true;
    const status = process
      ? (process.completed
        ? (process.cancelled ? 'cancelled' : process.timedOut ? 'timed_out' : ok ? 'executed' : 'failed')
        : 'running')
      : execution.route === 'process_direct'
        ? (ok ? 'executed' : 'failed')
        : execution.route === 'durable'
          ? 'deferred_durable'
          : 'rejected';
    return {
      processId: process?.processId,
      commandId,
      requestId: commandId,
      status,
      ok,
      exitCode: process?.exitCode ?? execution.exitCode,
      timedOut: process?.timedOut === true,
      cancelled: process?.cancelled === true,
      startedAt: process?.startedAt,
      finishedAt: process?.completed ? process.startedAt : undefined,
      stdout: process?.stdout ?? execution.stdout,
      stderr: process?.stderr ?? execution.stderr,
      logArtifact: process?.processId ? { processId: process.processId, kind: 'process_logs' } : undefined,
      route: execution.route,
      reason: execution.reason,
      authorizationDecision: decisions[index],
      approvalRequestId: resolvedRequest?.approvalRequestId,
      authorization: decisions[index]?.decision === 'allow'
        ? (resolvedRequest ? 'confirmed_plan' : decisions[index]?.source)
        : 'explicit_user_request',
      durableSideEffects: execution.durableSideEffects,
      process,
    };
  };
  const started = performance.now();
  const executions = classifications.every((classification) => classification.risk === 'readonly')
    ? await Promise.all(inputs.map((entry, index) => run(entry, index)))
    : await (async () => {
      const ordered: Awaited<ReturnType<typeof run>>[] = [];
      for (const [index, entry] of inputs.entries()) {
        const execution = await run(entry, index);
        ordered.push(execution);
        // Do not launch another mutating command while a Work-owned Lightweight
        // process is still changing the workspace. This is sequencing, not a
        // durable Lease boundary; the caller resumes through process_wait.
        if (execution.process && !execution.process.completed) break;
      }
      return ordered;
    })();
  const branch = repositoryGitStatus(cheap.worktreeRepository).branch;
  const head = gitHead(cheap.worktreeRepository.canonicalRoot);
  let nextHandle = handle;
  if (branch !== handle.branch) nextHandle = markWorkHandleFailed(ctx.controllerHome, handle, `command changed the bound branch to ${branch ?? 'detached'}`);
  else nextHandle = transitionWorkHandle(ctx.controllerHome, handle, 'editing', { expectedHead: head, failureReason: undefined });
  const value = {
    work: compactHandle(nextHandle),
    commands: executions,
    executedCount: executions.filter((entry) => entry.status === 'executed' && entry.ok === true).length,
    managedProcessCount: executions.filter((entry) => entry.process && !entry.process.completed).length,
    deferredCommandCount: Math.max(0, inputs.length - executions.length),
    authorization: decisions[0],
    requestId: invocationId,
  };
  const response = makeBoundedWorkResult(ctx, session, handle.repositoryId, handle.workId, 'command', value);
  recordMcpTiming(ctx.controllerHome, { tool: 'work_execute', workHandleValidationMs: 0, commandExecutionMs: Math.round((performance.now() - started) * 100) / 100, totalToolDurationMs: Math.round((performance.now() - started) * 100) / 100, sessionId: session.sessionId, repoId: handle.repositoryId, workId: handle.workId });
  return response;
}

export function selectDefaultWorkValidationChecks(
  contract: ReturnType<typeof contractFor>,
  changedPaths: string[],
): string[] {
  if (!contract || changedPaths.length === 0) return [];
  if (contract.risk === 'medium' || contract.risk === 'high' || contract.risk === 'destructive') {
    return [...contract.checks];
  }
  const sourceTypeScriptChanged = changedPaths.some((path) =>
    /\.(?:ts|tsx|mts|cts)$/.test(path)
    && !/(?:^|\/)(?:tests?|__tests__|fixtures)(?:\/|$)/.test(path));
  return contract.checks.filter((checkId) => {
    const normalized = checkId.toLowerCase();
    if (normalized.includes('package:test') || normalized.includes('full') || normalized.includes('architecture') || normalized.includes('release') || normalized.includes('runtime')) {
      return false;
    }
    if (normalized.includes('type')) return sourceTypeScriptChanged;
    return normalized.includes('focused') || normalized.includes('unit') || normalized.includes('changed') || normalized.includes('target');
  });
}

export async function validateWork(ctx: McpExecutionContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const session = requireSession(ctx, args);
  const handle = workForSession(ctx, session, args, {
    reconcileValidation: false,
    allowClaimedTerminalCleanup: args.cleanup !== false,
  });
  const terminalOutcome = terminalCleanupOutcome(ctx, handle);
  if (terminalOutcome && args.cleanup !== false) {
    return await reconcileTerminalCleanup(ctx, session, handle, args, terminalOutcome);
  }
  const validated = validateWorkHandle(ctx.controllerHome, handle, identityFor(ctx, args), 'full', 'validate');
  const contract = contractFor(ctx, handle);
  const changed = repositoryGitDiff(validated.worktreeRepository, { maxBytes: 64 * 1024 });
  const changedPaths = Array.isArray(changed.nameOnly) ? changed.nameOnly.map(String) : [];
  const requestedChecks = Array.isArray(args.check_ids)
    ? args.check_ids.map(String).filter(Boolean)
    : selectDefaultWorkValidationChecks(contract, changedPaths);
  const validationInvocationId = typeof args.request_id === 'string' && args.request_id.trim()
    ? args.request_id.trim()
    : `validate-${session.sessionId}-${handle.workId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const validationStatus = repositoryGitStatus(validated.worktreeRepository);
  const validationHead = validationStatus.head
    ?? handle.expectedHead
    ?? handle.baseCommit
    ?? 'unknown';
  const workspaceFingerprint = workspaceValidationFingerprint(
    validated.worktreeRepository.canonicalRoot,
    validationStatus,
  );
  const validationFingerprint = workValidationInputFingerprint(
    validationHead,
    workspaceFingerprint,
    requestedChecks,
  );
  const previousRun = handle.validationRun?.fingerprint === validationFingerprint
    ? handle.validationRun
    : undefined;
  let validationRun: NonNullable<WorkHandleState['validationRun']> = previousRun ?? {
    fingerprint: validationFingerprint,
    head: validationHead,
    workspaceFingerprint,
    requestedChecks,
    resumeState: handle.state === 'committed' || handle.state === 'merged' ? handle.state : 'editing',
    processes: {},
  };
  let current = transitionWorkHandle(ctx.controllerHome, handle, 'validating', {
    finalization: { ...handle.finalization, validation: 'pending', lastError: undefined },
    validationRun,
  });
  markWorkValidationPending(ctx.controllerHome, current);
  const available = new Set(listControllerChecks(validated.worktreeRepository.canonicalRoot).map((check) => check.id));
  const checks: Array<Record<string, unknown>> = [];
  for (const [index, checkId] of requestedChecks.entries()) {
    if (!available.has(checkId)) {
      checks.push({ checkId, ok: false, status: 'missing', summary: `Check not found: ${checkId}` });
      break;
    }
    const reusablePass = contract
      ? [...effectiveVerificationEvidence(contract.checkRefs, {
          sourceRevision: validationHead,
          workspaceFingerprint,
          checkId,
          requestedChecks,
        })].reverse().find((entry) => entry.current && entry.record.outcome === 'valid_pass' && Boolean(entry.record.receipt))
      : undefined;
    if (reusablePass) {
      checks.push({
        checkId,
        ok: true,
        status: 'passed',
        reusedEvidence: true,
        receipt: reusablePass.record.receipt,
      });
      continue;
    }
    const existingBinding = validationRun.processes[checkId];
    let process = existingBinding
      ? getCheckProcessHandle(ctx.controllerHome, handle.repositoryId, existingBinding.processId)
      : undefined;
    if (existingBinding && !process) {
      checks.push({
        checkId,
        ok: false,
        status: 'infrastructure_failure',
        summary: `Validation process record is unavailable: ${existingBinding.processId}`,
      });
      break;
    }
    if (!process) {
      const processRequestId = `${validationInvocationId}:check:${index + 1}`;
      const executed = await runPersistedCheckViaProcessRuntime({
        controllerHome: ctx.controllerHome,
        repoId: handle.repositoryId,
        checkoutId: handle.checkoutId,
        repoRoot: validated.worktreeRepository.canonicalRoot,
        executionIdentity: Object.freeze({
          ...executionIdentityForWork(validated.worktreeRepository, handle),
          expectedHead: validationHead === 'unknown' ? handle.expectedHead : validationHead,
        }),
        checkId,
        requestId: processRequestId,
        workId: handle.workId,
        commandId: processRequestId,
        verificationBinding: { executionSessionId: session.sessionId },
        verificationSnapshot: contract && contract.allowedPaths.length > 0 ? {
          workId: contract.workId,
          allowedPaths: contract.allowedPaths,
          forbiddenPaths: contract.forbiddenPaths,
        } : undefined,
      });
      if (executed.mode === 'durable') {
        checks.push({ checkId, ok: undefined, status: 'deferred', summary: executed.durable?.reason, durable: executed.durable });
        break;
      }
      process = executed.process!;
      const launchedRecord = getProcessRecord(ctx.controllerHome, handle.repositoryId, process.processId);
      validationRun = {
        ...validationRun,
        processes: {
          ...validationRun.processes,
          [checkId]: {
            processId: process.processId,
            requestId: processRequestId,
            ...(launchedRecord?.checkExecution ? { checkExecution: { ...launchedRecord.checkExecution } } : {}),
          },
        },
      };
      current = transitionWorkHandle(ctx.controllerHome, current, 'validating', { validationRun });
    }
    if (!process.completed) {
      checks.push({ checkId, ok: undefined, status: 'running', process });
      break;
    }
    const record = getProcessRecord(ctx.controllerHome, handle.repositoryId, process.processId);
    if (!record) {
      checks.push({ checkId, ok: false, status: 'infrastructure_failure', summary: `Validation process record is unavailable: ${process.processId}` });
      break;
    }
    const boundCheckExecution = validationRun.processes[checkId]?.checkExecution;
    const receipt = processCheckCompletionReceipt(record, {
      repoId: handle.repositoryId,
      checkoutId: handle.checkoutId,
      workId: handle.workId,
      checkId,
      processId: process.processId,
      ...(boundCheckExecution ? {
        checkExecution: {
          cacheKey: boundCheckExecution.cacheKey,
          revision: boundCheckExecution.revision,
          definitionDigest: boundCheckExecution.definitionDigest,
          environmentFingerprint: boundCheckExecution.environmentFingerprint,
          timeoutMs: boundCheckExecution.timeoutMs,
          scopeKey: boundCheckExecution.scopeKey,
        },
      } : {}),
    });
    const terminalEvidence = classifyPersistedCheckTerminalEvidence(record, checkId);
    const infrastructureFailed = receipt.timedOut
      || receipt.cancelled
      || terminalEvidence.state !== 'matched'
      || (!receipt.ok && terminalEvidence.failureClass !== 'acceptance_failure');
    appendVerificationRecord({ controllerHome: ctx.controllerHome, repoId: handle.repositoryId }, handle.workId, {
      checkId,
      outcome: infrastructureFailed ? 'infrastructure_failure' : receipt.ok ? 'valid_pass' : 'valid_fail',
      summary: receipt.summary,
      recordedAt: receipt.finishedAt,
      sourceRevision: validationHead,
      workspaceFingerprint,
      verificationInputFingerprint: verificationInputFingerprint({
        sourceRevision: validationHead,
        workspaceFingerprint,
        checkId,
        requestedChecks,
      }),
      commandFingerprint: commandFingerprint(checkId, receipt.commandId),
      resultArtifactId: receipt.receiptId,
      startedAt: receipt.startedAt,
      completedAt: receipt.finishedAt,
      evidenceRef: { title: checkId, summary: `${receipt.receiptId}; artifact=${receipt.artifactPath}`, detailLevel: 'summary' },
      receipt,
    });
    checks.push({
      checkId,
      ok: receipt.ok,
      status: infrastructureFailed ? 'infrastructure_failure' : receipt.ok ? 'passed' : 'failed',
      process,
      receipt,
      ...(terminalEvidence.warning ? { warning: terminalEvidence.warning } : {}),
    });
    if (!receipt.ok) break;
  }
  const infrastructureFailure = checks.find((check) => (
    check.status === 'missing'
    || check.status === 'infrastructure_failure'
    || check.status === 'deferred'
  ));
  const acceptedFailure = checks.find((check) => check.status === 'failed');
  const allObserved = checks.length === requestedChecks.length && checks.every((check) => check.ok !== undefined);
  const completed = Boolean(infrastructureFailure || acceptedFailure || allObserved);
  const passed = completed
    && !infrastructureFailure
    && !acceptedFailure
    && checks.every((check) => check.ok === true);
  const failureSummary = infrastructureFailure
    ? String(infrastructureFailure.summary ?? 'validation infrastructure failure')
    : acceptedFailure
      ? String(acceptedFailure.summary ?? 'targeted validation failed')
      : undefined;
  const nextState = !completed
    ? 'validating'
    : passed
      ? validationRun.resumeState
      : 'failed';
  const validation = !completed ? 'pending' : passed ? 'done' : 'failed';
  const next = transitionWorkHandle(ctx.controllerHome, current, nextState, {
    finalization: {
      ...current.finalization,
      validation,
      lastError: failureSummary,
    },
    validationRun: completed ? undefined : validationRun,
    ...(passed ? { validatedInputFingerprint: validationFingerprint } : {}),
    ...(failureSummary ? { failureReason: failureSummary } : { failureReason: undefined }),
  });
  if (completed) {
    projectWorkValidationOutcome(
      ctx.controllerHome,
      next,
      infrastructureFailure ? 'infrastructure_failure' : passed ? 'passed' : 'failed',
      failureSummary,
    );
  }
  if (completed && acceptedFailure) {
    const cleanup = await reconcileTerminalCleanup(ctx, session, next, args, 'validation_failed');
    const value = {
      ...cleanup,
      validation: { passed, completed, checks, targeted: true, changedPaths, cleanupTriggered: true },
    };
    return makeBoundedWorkResult(ctx, session, handle.repositoryId, handle.workId, 'validation', value);
  }
  const value = {
    work: compactHandle(next),
    validation: {
      passed,
      completed,
      checks,
      targeted: true,
      changedPaths,
      ...(infrastructureFailure ? { retryable: true, cleanupTriggered: false } : {}),
    },
  };
  return makeBoundedWorkResult(ctx, session, handle.repositoryId, handle.workId, 'validation', value);
}
