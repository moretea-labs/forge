import { randomUUID } from 'crypto';
import { createHandoffItem, type HandoffInboxStoreOptions } from './handoff-inbox-store';
import { buildFacadeResult } from './facade-result';
import { evaluatePolicyGate } from './policy-gate';
import { validateSuggestedNextActions } from './suggested-actions';
import type { FacadeResult, PolicyDecision, SuggestedNextAction } from './types';

export type SelfHealingOperation = 'diagnose' | 'repair' | 'verify' | 'handoff';

export type SelfHealingIssueKind =
  | 'stuck_execution_job'
  | 'stale_local_job'
  | 'runtime_projection_dirty'
  | 'mcp_tool_result_too_large'
  | 'invalid_check_id_pollution'
  | 'plugin_capability_unavailable'
  | 'codex_claude_unavailable'
  | 'controller_daemon_health'
  | 'durable_scheduler_health'
  | 'local_bridge_health';

export interface SelfHealingIssue {
  kind: SelfHealingIssueKind;
  summary: string;
  severity: 'info' | 'warning' | 'error';
  safeToAutoRepair: boolean;
  requiresApproval: boolean;
  suggestedAction: string;
}

export interface SelfHealingInput {
  operation?: SelfHealingOperation;
  /** Defaults to true for diagnose and repair. */
  dryRun?: boolean;
  approvalConfirmed?: boolean;
  workId?: string;
  /** Observed/simulated issues for deterministic testing and facade injection. */
  issues?: SelfHealingIssue[];
  /** Bounded maintenance status snapshot from buildRuntimeMaintenanceStatus (optional). */
  maintenanceStatus?: {
    readyForExecution?: boolean;
    recommendedActions?: string[];
    candidates?: Array<{ kind?: string; reason?: string; suggestedAction?: string; safe?: boolean }>;
    warnings?: string[];
  };
  /** Optional watchdog/performance digests (bounded). */
  diagnostics?: {
    watchdogSummary?: string;
    performanceSummary?: string;
    codexUnavailable?: boolean;
    grokUnavailable?: boolean;
    pluginUnavailable?: boolean;
    controllerDaemonUnhealthy?: boolean;
    schedulerUnhealthy?: boolean;
    localBridgeUnhealthy?: boolean;
  };
  /** ChatGPT pull failure must not become task failure. */
  chatgptPullFailed?: boolean;
  destructive?: boolean;
  remoteEffect?: boolean;
}

export interface SelfHealingContext {
  repoId: string;
  handoffStore: HandoffInboxStoreOptions;
  now?: () => string;
}

const DEFAULT_ISSUES: SelfHealingIssue[] = [];

function mapMaintenanceCandidate(candidate: {
  kind?: string;
  reason?: string;
  suggestedAction?: string;
  safe?: boolean;
}): SelfHealingIssue {
  const kindText = `${candidate.kind ?? ''} ${candidate.suggestedAction ?? ''}`.toLowerCase();
  let kind: SelfHealingIssueKind = 'runtime_projection_dirty';
  if (kindText.includes('local_job') || kindText.includes('stale') || kindText.includes('reconcile')) {
    kind = kindText.includes('stuck') ? 'stuck_execution_job' : 'stale_local_job';
  } else if (kindText.includes('projection') || kindText.includes('storage')) {
    kind = 'runtime_projection_dirty';
  }
  const safe = candidate.safe !== false;
  return {
    kind,
    summary: (candidate.reason || candidate.suggestedAction || 'Runtime maintenance candidate').slice(0, 400),
    severity: safe ? 'warning' : 'error',
    safeToAutoRepair: safe,
    requiresApproval: !safe,
    suggestedAction: candidate.suggestedAction || 'runtime_maintenance_status',
  };
}

function defaultDiagnoseIssues(input: SelfHealingInput): SelfHealingIssue[] {
  if (input.issues && input.issues.length > 0) return input.issues;
  const issues: SelfHealingIssue[] = [...DEFAULT_ISSUES];
  if (input.chatgptPullFailed) {
    issues.push({
      kind: 'mcp_tool_result_too_large',
      summary: 'ChatGPT pull/result delivery failed or exceeded bounds; treat as bounded artifact/handoff/retry, not task failure.',
      severity: 'warning',
      safeToAutoRepair: true,
      requiresApproval: false,
      suggestedAction: 'retry_with_bounded_artifact',
    });
  }
  for (const candidate of input.maintenanceStatus?.candidates ?? []) {
    issues.push(mapMaintenanceCandidate(candidate));
  }
  if (input.diagnostics?.codexUnavailable || input.diagnostics?.grokUnavailable) {
    issues.push({
      kind: 'codex_claude_unavailable',
      summary: 'Codex/Grok small-brain helper unavailable; prefer handoff or retry, not acceptance failure.',
      severity: 'warning',
      safeToAutoRepair: false,
      requiresApproval: false,
      suggestedAction: 'handoff_or_retry_later',
    });
  }
  if (input.diagnostics?.pluginUnavailable) {
    issues.push({
      kind: 'plugin_capability_unavailable',
      summary: 'Plugin capability unavailable.',
      severity: 'warning',
      safeToAutoRepair: false,
      requiresApproval: false,
      suggestedAction: 'handoff_or_retry_later',
    });
  }
  if (input.diagnostics?.controllerDaemonUnhealthy) {
    issues.push({
      kind: 'controller_daemon_health',
      summary: 'Forge Runtime health issue detected. Runtime lifecycle recovery belongs to the external owner of the existing single Runtime.',
      severity: 'error',
      safeToAutoRepair: false,
      requiresApproval: false,
      suggestedAction: 'external_runtime_lifecycle_handoff',
    });
  }
  if (input.diagnostics?.schedulerUnhealthy) {
    issues.push({
      kind: 'durable_scheduler_health',
      summary: 'Durable scheduler heartbeat is stale or unavailable; inspect bounded runtime maintenance state.',
      severity: 'error',
      safeToAutoRepair: false,
      requiresApproval: false,
      suggestedAction: 'runtime_maintenance_status',
    });
  }
  if (input.diagnostics?.localBridgeUnhealthy) {
    issues.push({
      kind: 'local_bridge_health',
      summary: 'Local bridge health issue detected; use bounded handoff or retry rather than a component restart.',
      severity: 'error',
      safeToAutoRepair: false,
      requiresApproval: false,
      suggestedAction: 'handoff_or_retry_later',
    });
  }
  return issues;
}

function repairPlanFor(issue: SelfHealingIssue): {
  action: string;
  dryRunDefault: boolean;
  approvalRequired: boolean;
  risk: 'readonly' | 'workspace_write' | 'destructive' | 'remote_write';
} {
  switch (issue.kind) {
    case 'stuck_execution_job':
    case 'stale_local_job':
      return {
        action: 'reconcile_local_jobs',
        dryRunDefault: true,
        approvalRequired: false,
        risk: 'workspace_write',
      };
    case 'runtime_projection_dirty':
      return {
        action: 'rebuild_projection',
        dryRunDefault: true,
        approvalRequired: false,
        risk: 'workspace_write',
      };
    case 'mcp_tool_result_too_large':
      return {
        action: 'bound_and_retry_artifact',
        dryRunDefault: true,
        approvalRequired: false,
        risk: 'readonly',
      };
    case 'invalid_check_id_pollution':
      return {
        action: 'normalize_and_drop_invalid_check_ids',
        dryRunDefault: true,
        approvalRequired: false,
        risk: 'readonly',
      };
    case 'plugin_capability_unavailable':
    case 'codex_claude_unavailable':
      return {
        action: 'handoff_or_retry_later',
        dryRunDefault: true,
        approvalRequired: false,
        risk: 'readonly',
      };
    case 'controller_daemon_health':
      return {
        action: 'external_runtime_lifecycle_handoff',
        dryRunDefault: true,
        approvalRequired: false,
        risk: 'readonly',
      };
    case 'durable_scheduler_health':
      return {
        action: 'runtime_maintenance_status',
        dryRunDefault: true,
        approvalRequired: false,
        risk: 'readonly',
      };
    case 'local_bridge_health':
      return {
        action: 'handoff_or_retry_later',
        dryRunDefault: true,
        approvalRequired: false,
        risk: 'readonly',
      };
    default:
      return {
        action: 'diagnose_only',
        dryRunDefault: true,
        approvalRequired: true,
        risk: 'readonly',
      };
  }
}

function verificationSuggestion(workId?: string): SuggestedNextAction {
  return {
    label: 'Verify controller status after repair',
    tool: 'rh_status',
    operation: 'get',
    payload: workId ? { work_id: workId } : undefined,
    risk: 'readonly',
    confidence: 'high',
    reason: 'Repair must be followed by a real verification action.',
  };
}

export function runSelfHealingLoop(ctx: SelfHealingContext, input: SelfHealingInput = {}): FacadeResult {
  const operation: SelfHealingOperation = input.operation ?? 'diagnose';
  // diagnose and repair default to dry_run=true unless explicitly false.
  const dryRun = input.dryRun === undefined ? true : input.dryRun === true;
  const issues = defaultDiagnoseIssues(input);

  if (operation === 'diagnose') {
    const plans = issues.map((issue) => ({
      issue,
      plan: repairPlanFor(issue),
    }));
    const suggested = validateSuggestedNextActions([
      ...(issues.length > 0
        ? [{
            label: 'Preview repair (dry-run)',
            tool: 'rh_work' as const,
            operation: 'repair',
            payload: { repair_operation: 'repair', dry_run: true, work_id: input.workId },
            risk: 'readonly' as const,
            confidence: 'high' as const,
          }]
        : [{
            label: 'Controller status',
            tool: 'rh_status' as const,
            operation: 'get',
            risk: 'readonly' as const,
            confidence: 'medium' as const,
          }]),
      verificationSuggestion(input.workId),
    ]).actions;

    return buildFacadeResult({
      status: 'ok',
      summary: issues.length
        ? `Diagnosed ${issues.length} self-healing issue(s). dry_run=${dryRun}.`
        : 'No self-healing issues diagnosed.',
      data: {
        operation: 'diagnose',
        dryRun: true,
        issues,
        plans,
        maintenance: input.maintenanceStatus
          ? {
              readyForExecution: input.maintenanceStatus.readyForExecution,
              recommendedActions: (input.maintenanceStatus.recommendedActions ?? []).slice(0, 10),
              candidateCount: input.maintenanceStatus.candidates?.length ?? 0,
            }
          : undefined,
        diagnostics: input.diagnostics
          ? {
              watchdogSummary: input.diagnostics.watchdogSummary?.slice(0, 240),
              performanceSummary: input.diagnostics.performanceSummary?.slice(0, 240),
            }
          : undefined,
        linkedTools: [
          'runtime_maintenance_status',
          'runtime_maintenance_apply',
          'workflow_watchdog_report',
          'runtime_performance_diagnostics',
        ],
        isAcceptanceFailure: false,
        chatgptPullFailed: input.chatgptPullFailed === true,
      },
      warnings: [
        ...(input.chatgptPullFailed
          ? ['ChatGPT pull failure is not a task/acceptance failure; use bounded artifact, handoff, or retry.']
          : []),
        ...(input.maintenanceStatus?.warnings ?? []).slice(0, 5),
      ],
      suggestedNextActions: suggested,
      rawAvailable: false,
    });
  }

  if (operation === 'verify') {
    return buildFacadeResult({
      status: 'ok',
      summary: 'Self-healing verification suggestion only; run real registered checks via rh_work verify or rh_status.',
      data: {
        operation: 'verify',
        dryRun,
        isAcceptanceFailure: false,
      },
      suggestedNextActions: validateSuggestedNextActions([
        verificationSuggestion(input.workId),
        {
          label: 'Run work verify if work_id known',
          tool: 'rh_work',
          operation: 'verify',
          payload: { work_id: input.workId },
          risk: 'workspace_write',
          confidence: input.workId ? 'medium' : 'low',
        },
      ]).actions,
    });
  }

  if (operation === 'handoff') {
    const handoff = createHandoffItem(ctx.handoffStore, {
      id: `hnd-heal-${randomUUID().slice(0, 8)}`,
      repoId: ctx.repoId,
      workId: input.workId,
      title: 'Self-healing needs judgement',
      severity: 'needs_review',
      creationReason: 'repeated_infrastructure_failure',
      reason: 'Self-healing could not safely complete without ChatGPT or user decision.',
      summary: issues.map((issue) => issue.summary).join(' | ').slice(0, 500) || 'Manual recovery decision required.',
      currentState: {
        repoId: ctx.repoId,
        workId: input.workId,
        statusSummary: 'self-healing handoff pending',
      },
      attemptedActions: ['self_healing_diagnose', 'self_healing_repair'],
      evidenceRefs: [],
      blockingDecision: 'Choose bounded metadata repair, external lifecycle handoff, retry later, or re-scope work.',
      recommendedDecision: 'Prefer safe dry-run repairs; Runtime lifecycle changes belong to the external lifecycle owner.',
      recommendedPrompt: 'Review self-healing handoff and choose repair or stop.',
      suggestedNextActions: [
        {
          label: 'Diagnose again (dry-run)',
          tool: 'rh_work',
          operation: 'repair',
          payload: { repair_operation: 'diagnose', dry_run: true },
          risk: 'readonly',
        },
      ],
    });

    return buildFacadeResult({
      status: 'blocked',
      summary: `Self-healing handoff ${handoff.id} created.`,
      data: {
        operation: 'handoff',
        handoffId: handoff.id,
        isAcceptanceFailure: false,
      },
      suggestedNextActions: [
        {
          label: 'Get handoff',
          tool: 'rh_inbox',
          operation: 'get',
          payload: { handoff_id: handoff.id },
          risk: 'readonly',
        },
      ],
    });
  }

  // operation === 'repair'
  const needsStrongApproval =
    input.destructive === true
    || input.remoteEffect === true
    || issues.some((issue) => issue.requiresApproval);

  // Safe maintenance is allowed without ChatGPT approval; destructive/remote effects stay gated.
  const policy: PolicyDecision = dryRun
    ? {
        decision: 'dry_run_only',
        reason: 'Repair is dry-run only; no mutation applied.',
        capabilityId: 'maintenance.safe_repair',
        warnings: [],
        suggestedNextActions: [],
      }
    : needsStrongApproval
      ? evaluatePolicyGate({
          capabilityId: 'maintenance.safe_repair',
          risk: 'destructive',
          dryRun: false,
          approvalConfirmed: input.approvalConfirmed === true,
          sideEffect: 'destructive_remote',
        })
      : {
          decision: 'allowed',
          reason: 'Safe maintenance actions are allowed without destructive side effects.',
          capabilityId: 'maintenance.safe_repair',
          warnings: [],
          suggestedNextActions: [],
        };

  if (dryRun) {
    const plans = issues.map((issue) => ({ issue, plan: repairPlanFor(issue) }));
    return buildFacadeResult({
      status: 'ok',
      summary: `Repair dry-run preview for ${issues.length} issue(s). No mutation applied.`,
      data: {
        operation: 'repair',
        dryRun: true,
        applied: false,
        plans,
        policy,
        isAcceptanceFailure: false,
      },
      suggestedNextActions: validateSuggestedNextActions([
        {
          label: 'Apply safe repair (requires approval if destructive)',
          tool: 'rh_work',
          operation: 'repair',
          payload: {
            repair_operation: 'repair',
            dry_run: false,
            approval_confirmed: needsStrongApproval,
            work_id: input.workId,
          },
          risk: needsStrongApproval ? 'destructive' : 'workspace_write',
          confidence: 'medium',
        },
        verificationSuggestion(input.workId),
      ]).actions,
      warnings: policy.warnings,
    });
  }

  if (policy.decision === 'approval_required' || policy.decision === 'denied') {
    const handoff = createHandoffItem(ctx.handoffStore, {
      id: `hnd-heal-approval-${randomUUID().slice(0, 8)}`,
      repoId: ctx.repoId,
      workId: input.workId,
      title: 'Repair requires approval',
      severity: 'blocked',
      creationReason: input.destructive
        ? 'destructive_action_requires_confirmation'
        : 'policy_approval_required',
      reason: policy.reason,
      summary: 'Destructive or remote repair requires explicit approval.',
      currentState: {
        repoId: ctx.repoId,
        workId: input.workId,
        statusSummary: 'repair blocked pending approval',
      },
      attemptedActions: ['self_healing_repair'],
      evidenceRefs: [],
      blockingDecision: 'Confirm destructive repair authorization or keep dry-run only.',
      recommendedDecision: 'Approve only if a destructive or remote effect is intended.',
      recommendedPrompt: 'Approve or dismiss self-healing repair.',
      suggestedNextActions: [
        {
          label: 'List handoffs',
          tool: 'rh_inbox',
          operation: 'list',
          risk: 'readonly',
        },
      ],
    });

    return buildFacadeResult({
      status: 'approval_required',
      summary: `Repair not applied: ${policy.decision}. Handoff ${handoff.id} created.`,
      data: {
        operation: 'repair',
        dryRun: false,
        applied: false,
        policy,
        handoffId: handoff.id,
        isAcceptanceFailure: false,
      },
      suggestedNextActions: [
        {
          label: 'Read approval handoff',
          tool: 'rh_inbox',
          operation: 'get',
          payload: { handoff_id: handoff.id },
          risk: 'readonly',
        },
      ],
    });
  }

  // This facade is policy/planning only. Never claim a mutation succeeded unless
  // the Runtime caller has executed the authoritative maintenance executor.
  const eligible = issues
    .filter((issue) => issue.safeToAutoRepair && !issue.requiresApproval)
    .map((issue) => ({
      kind: issue.kind,
      action: repairPlanFor(issue).action,
      result: 'executor_required',
    }));

  return buildFacadeResult({
    status: eligible.length > 0 ? 'blocked' : 'ok',
    summary: eligible.length > 0
      ? `Safe repair has ${eligible.length} eligible maintenance action(s), but no maintenance executor result was provided; no mutation reported.`
      : 'No safe maintenance mutation was required.',
    data: {
      operation: 'repair',
      dryRun: false,
      applied: false,
      actions: eligible,
      isAcceptanceFailure: false,
      // Infrastructure recovery must not be framed as acceptance failure.
      classification: 'infrastructure_recovery',
    },
    suggestedNextActions: validateSuggestedNextActions([
      verificationSuggestion(input.workId),
      {
        label: 'Continue work if applicable',
        tool: 'rh_work',
        operation: 'continue',
        payload: { work_id: input.workId },
        risk: 'readonly',
        confidence: input.workId ? 'medium' : 'low',
      },
    ]).actions,
    rawAvailable: false,
  });
}
