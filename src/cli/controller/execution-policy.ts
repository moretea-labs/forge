import type { CleanupEvidence, CompletionReceipt, CompletionResourceBlocker, ControllerTask, IntegrationEvidence, TaskAcceptanceOutcome, TaskAcceptanceResult, TaskRisk, TaskVerification } from './types';

export type TaskExecutionClass =
  | 'read_only'
  | 'low_risk_change'
  | 'medium_risk_change'
  | 'high_risk_change'
  | 'destructive_change';

export type ApprovalRequirement = 'auto' | 'manual-only';

export interface TaskExecutionPolicy {
  risk: TaskRisk;
  executionClass: TaskExecutionClass;
  approval: ApprovalRequirement;
  warnings: string[];
}

export interface CompletionReceiptExpectation {
  issueId?: string;
  taskId?: string;
  runId?: string;
  editSessionId?: string;
  targetBranch?: string;
}

function receiptSourceIdentityComplete(receipt: CompletionReceipt): boolean {
  if (receipt.source === 'direct_edit') return Boolean(receipt.editSessionId?.trim()) && !receipt.runId;
  if (receipt.source === 'isolated_agent_run' || receipt.source === 'workspace_run') return Boolean(receipt.runId?.trim());
  return true;
}

export function completionReceiptComplete(
  receipt: CompletionReceipt | undefined,
  expected: CompletionReceiptExpectation = {},
): receipt is CompletionReceipt {
  return Boolean(receipt
    && receipt.schemaVersion === 1
    && receipt.receiptId.trim()
    && receipt.issueId.trim()
    && receipt.taskId.trim()
    && receipt.targetBranch.trim()
    && receipt.targetRevision.trim()
    && receiptSourceIdentityComplete(receipt)
    && (!expected.issueId || receipt.issueId === expected.issueId)
    && (!expected.taskId || receipt.taskId === expected.taskId)
    && (!expected.runId || receipt.runId === expected.runId)
    && (!expected.editSessionId || receipt.editSessionId === expected.editSessionId)
    && (!expected.targetBranch || receipt.targetBranch === expected.targetBranch)
    && receipt.delivery.status === 'integrated'
    && receipt.delivery.reachable
    && receipt.cleanup.status !== 'blocked'
    && Array.isArray(receipt.cleanup.blockers)
    && receipt.cleanup.blockers.length === 0);
}

function cleanupBlocker(
  code: CompletionResourceBlocker['code'],
  message: string,
  resourceKind: CompletionResourceBlocker['resourceKind'],
  recordedAt: string,
): CompletionResourceBlocker {
  return { code, message, resourceKind, recordedAt };
}

export function cleanupEvidenceResourceBlockers(
  cleanup: CleanupEvidence,
  options: { includeRunTerminal?: boolean } = {},
): CompletionResourceBlocker[] {
  const recordedAt = cleanup.recordedAt || new Date().toISOString();
  const blockers = [...(cleanup.resourceBlockers ?? [])];
  const warningOnlyRetention = (cleanup.maintenanceWarnings?.length ?? 0) > 0 && blockers.length === 0;
  const add = (entry: CompletionResourceBlocker): void => {
    if (!blockers.some((candidate) => candidate.code === entry.code && candidate.resourceKind === entry.resourceKind)) blockers.push(entry);
  };
  if (!cleanup.worktreeRemovedOrNotCreated && !warningOnlyRetention) {
    add(cleanupBlocker('unknown_resource_ownership', 'Worktree removal or absence was not proven.', 'worktree', recordedAt));
  }
  if (!cleanup.branchDeletedOrRetained && !warningOnlyRetention) {
    add(cleanupBlocker('unknown_resource_ownership', 'Temporary branch deletion or retention was not proven.', 'branch', recordedAt));
  }
  if (!cleanup.leasesReleased) add(cleanupBlocker('lease_active', 'Task-owned leases are still active.', 'lease', recordedAt));
  if (!cleanup.editSessionClosedOrNotCreated) add(cleanupBlocker('edit_session_open', 'Task-owned edit session is not closed.', 'edit_session', recordedAt));
  if (!cleanup.noActiveProcess) add(cleanupBlocker('active_write_process', 'Task-owned execution process may still be active.', 'process', recordedAt));
  if (!cleanup.noDirtyDiff) add(cleanupBlocker('dirty_owned_paths', 'Task-owned paths still have uncommitted changes.', 'workspace', recordedAt));
  if (options.includeRunTerminal !== false && !cleanup.runTerminal) {
    add(cleanupBlocker('run_not_terminal', 'Task-owned Run has not reached a terminal state.', 'process', recordedAt));
  }
  return blockers;
}

function cleanupEvidenceHasOnlyMaintenanceWarnings(cleanup: CleanupEvidence): boolean {
  return Boolean(
    (cleanup.maintenanceWarnings?.length ?? 0) > 0
    && cleanupEvidenceResourceBlockers(cleanup).length === 0
    && cleanup.leasesReleased
    && cleanup.runTerminal
    && cleanup.editSessionClosedOrNotCreated
    && cleanup.noActiveProcess
    && cleanup.noDirtyDiff,
  );
}

export function completionEvidenceComplete(
  verification: TaskVerification | undefined,
  expected: CompletionReceiptExpectation = {},
): verification is TaskVerification & {
  integrationEvidence?: IntegrationEvidence;
  cleanupEvidence?: CleanupEvidence;
  completionReceipt?: CompletionReceipt;
} {
  const expectedReceipt = { ...expected, runId: expected.runId ?? verification?.runId };
  if (completionReceiptComplete(verification?.completionReceipt, expectedReceipt)) return true;
  const runId = verification?.runId;
  const integration = verification?.integrationEvidence;
  const cleanup = verification?.cleanupEvidence;
  return Boolean(runId
    && (!expected.runId || runId === expected.runId)
    && integration?.runId === runId
    && cleanup?.runId === runId
    && integration.reachable
    && integration.targetBranch.trim()
    && integration.targetRevision.trim()
    && (!expected.targetBranch || integration.targetBranch === expected.targetBranch)
    && (cleanup.worktreeRemovedOrNotCreated || cleanupEvidenceHasOnlyMaintenanceWarnings(cleanup))
    && (cleanup.branchDeletedOrRetained || cleanupEvidenceHasOnlyMaintenanceWarnings(cleanup))
    && cleanup.leasesReleased
    && cleanup.runTerminal
    && cleanup.editSessionClosedOrNotCreated
    && cleanup.noActiveProcess
    && cleanup.noDirtyDiff);
}

function normalizeRisk(value: TaskRisk | undefined): TaskRisk {
  return value ?? 'medium';
}

/**
 * Legacy Task risk is explicit model-authored metadata only. Forge does not infer
 * risk or destructive authority from objective text, path names, or keywords.
 */
export function classifyTaskExecution(task: Pick<ControllerTask, 'risk'>): {
  risk: TaskRisk;
  executionClass: TaskExecutionClass;
} {
  const risk = normalizeRisk(task.risk);
  if (risk === 'readonly') return { risk, executionClass: 'read_only' };
  if (risk === 'destructive') return { risk, executionClass: 'destructive_change' };
  if (risk === 'high') return { risk, executionClass: 'high_risk_change' };
  if (risk === 'medium') return { risk, executionClass: 'medium_risk_change' };
  return { risk, executionClass: 'low_risk_change' };
}

export function taskExecutionPolicy(task: Pick<ControllerTask, 'risk' | 'allowedPaths' | 'checks' | 'acceptanceCriteria'>): TaskExecutionPolicy {
  const classification = classifyTaskExecution(task);
  const warnings: string[] = [];
  if (task.checks.length === 0) warnings.push('No named checks are declared; completion relies on concrete execution or delivery evidence when present.');
  if (task.acceptanceCriteria.length === 0) warnings.push('No Task-level acceptance criteria are declared.');
  if (task.allowedPaths.length === 0 && classification.executionClass !== 'read_only') warnings.push('No allowed path scope is declared; concrete runtime path and conflict guards remain authoritative.');
  return {
    ...classification,
    // Only an explicitly authored destructive risk retains a legacy Task-level
    // authorization boundary. Ordinary risk classes are descriptive metadata.
    approval: classification.risk === 'destructive' ? 'manual-only' : 'auto',
    warnings,
  };
}


export interface ExecutionScopeDescriptor {
  executionClass: TaskExecutionClass;
  allowedPaths: readonly string[];
}

function scopePrefix(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .split(/[?*{\[]/, 1)[0]
    .replace(/\/+$/, '');
}

/**
 * Returns true only when two non-read-only Tasks declare overlapping write scopes.
 * Missing scope is not treated as a global lock: it is insufficient evidence of a
 * conflict and the workspace isolation guard remains authoritative. A declared
 * repository-rooted globstar scope is intentionally broad
 * and conflicts with every other declared write scope.
 */
export function executionScopesConflict(
  left: ExecutionScopeDescriptor,
  right: ExecutionScopeDescriptor,
): boolean {
  if (left.executionClass === 'read_only' || right.executionClass === 'read_only') return false;
  if (left.allowedPaths.length === 0 || right.allowedPaths.length === 0) return false;
  for (const leftPath of left.allowedPaths) {
    const a = scopePrefix(leftPath);
    if (!a) return true;
    for (const rightPath of right.allowedPaths) {
      const b = scopePrefix(rightPath);
      if (!b || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true;
    }
  }
  return false;
}

export function taskWriteScopesConflict(
  left: Pick<ControllerTask, 'objective' | 'title' | 'risk' | 'allowedPaths' | 'forbiddenPaths'>,
  right: Pick<ControllerTask, 'objective' | 'title' | 'risk' | 'allowedPaths' | 'forbiddenPaths'>,
): boolean {
  const leftClass = classifyTaskExecution(left).executionClass;
  const rightClass = classifyTaskExecution(right).executionClass;
  return executionScopesConflict(
    { executionClass: leftClass, allowedPaths: left.allowedPaths },
    { executionClass: rightClass, allowedPaths: right.allowedPaths },
  );
}

const LEGACY_AUTOMATIC_ACCEPTANCE = /(?:^successful run [^;]+(?: integrated by [^;]+)?\.?$|successful run .*acceptance evidence|accepted from successful run)/i;

export function taskAcceptanceOutcome(result: TaskAcceptanceResult | undefined): TaskAcceptanceOutcome | 'missing' {
  if (!result) return 'missing';
  if (result.outcome) return result.outcome;
  if (result.source === 'run_completion') return 'not_evaluated';
  if (result.evidence && LEGACY_AUTOMATIC_ACCEPTANCE.test(result.evidence)) return 'not_evaluated';
  return result.ok ? 'passed' : 'failed';
}

export function verificationEvidencePassed(task: Pick<ControllerTask, 'checks' | 'acceptanceCriteria'>, verification: TaskVerification | undefined): {
  status: 'passed' | 'failed' | 'incomplete';
  ok: boolean;
  checksOk: boolean;
  acceptanceOk: boolean;
  hasEvidence: boolean;
  reasons: string[];
} {
  const checksRequired = task.checks.length > 0;
  const acceptanceRequired = task.acceptanceCriteria.length > 0;
  if (!verification) {
    const ok = !checksRequired && !acceptanceRequired;
    return {
      status: ok ? 'passed' : 'incomplete',
      ok,
      checksOk: !checksRequired,
      acceptanceOk: !acceptanceRequired,
      hasEvidence: false,
      reasons: ok ? [] : ['Explicitly declared check or acceptance evidence is missing.'],
    };
  }
  const reportedCommands = verification.commandEvidence ?? [];
  const hasEvidence = verification.checkResults.length > 0 || reportedCommands.length > 0 || Boolean(verification.runId);
  const evidenceFailed = verification.checkResults.some((entry) => !entry.ok)
    || reportedCommands.some((entry) => !entry.ok);
  const namedChecksComplete = !checksRequired || task.checks.every((checkId) =>
    verification.checkResults.some((entry) => entry.checkId === checkId && entry.ok),
  );
  const checksOk = !evidenceFailed && namedChecksComplete;

  const acceptanceOutcomes = task.acceptanceCriteria.map((criterion) => taskAcceptanceOutcome(
    verification.acceptanceResults.find((entry) => entry.criterion === criterion),
  ));
  const acceptanceFailed = acceptanceOutcomes.some((outcome) => outcome === 'failed');
  const acceptanceComplete = !acceptanceRequired || acceptanceOutcomes.every((outcome) => outcome === 'passed');
  const acceptanceOk = acceptanceComplete && !acceptanceFailed;
  const failed = evidenceFailed || acceptanceFailed;
  const complete = checksOk && acceptanceOk;
  const status = failed ? 'failed' : complete ? 'passed' : 'incomplete';
  const reasons: string[] = [];
  if (evidenceFailed) reasons.push('One or more executed checks or reported commands failed.');
  else if (!checksOk) reasons.push('One or more explicitly declared checks are missing.');
  if (acceptanceFailed) reasons.push('One or more acceptance criteria explicitly failed.');
  else if (!acceptanceOk) reasons.push('One or more explicitly declared acceptance criteria are missing or not evaluated.');
  return { status, ok: status === 'passed', checksOk, acceptanceOk, hasEvidence, reasons };
}
