import { createHash } from 'crypto';
import {
  readControlPlaneRecordWithinTransaction,
  withControlPlaneTransaction,
  writeControlPlaneRecordWithinTransaction,
} from '../../runtime/control-plane/persistence/sqlite-store';
import type { Requirement, RequirementState } from '../../runtime/control-plane/persistence/requirement-store';
import {
  isTerminalPlanContractStatus,
  type EvidenceRef,
  type PlanContract,
  type PlanContractStatus,
} from '../../runtime/control-plane/facade/types';
import type { IssueStatus } from './types';
import { legacyIssueCutoverState } from './legacy-issue-cutover';
import { portfolioPlanIdForIssue } from './requirement-portfolio-migration';

export interface MigratedIssueDecisionInput {
  issueId: string;
  title?: string;
  status?: IssueStatus;
  summary?: string;
  acceptanceCriteria?: string[];
  goals?: string[];
  nonGoals?: string[];
  relatedArtifacts?: string[];
}

export interface MigratedIssueDecisionResult {
  migrated: true;
  legacyIssueId: string;
  legacyIssueFrozen: true;
  decisionId: string;
  legacyPlanClosed: boolean;
  requirementClosed: boolean;
  requirement: Requirement;
  plan: PlanContract;
}

function boundedText(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function boundedList(values: readonly string[] | undefined, limit: number, maxLength = 500): string[] | undefined {
  if (!values) return undefined;
  return values.map((value) => String(value).trim()).filter(Boolean).slice(0, limit).map((value) => value.slice(0, maxLength));
}

function decisionId(input: MigratedIssueDecisionInput): string {
  const fingerprint = JSON.stringify({
    issueId: input.issueId.trim(),
    title: boundedText(input.title, 500),
    status: input.status,
    summary: boundedText(input.summary, 2_000),
    acceptanceCriteria: boundedList(input.acceptanceCriteria, 50),
  });
  return `legacy-issue-decision:${createHash('sha256').update(fingerprint).digest('hex').slice(0, 24)}`;
}

function requirementState(status: IssueStatus | undefined, current: RequirementState): RequirementState {
  if (!status) return current;
  if (status === 'done') return 'done';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'in_progress' || status === 'review') return 'active';
  return 'planned';
}

function planStatus(status: IssueStatus | undefined, current: PlanContractStatus): PlanContractStatus {
  if (!status) return current;
  if (status === 'done') return current === 'finalized' ? current : 'superseded';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'review') return 'verifying';
  if (status === 'in_progress') return 'executing';
  if (status === 'launch_blocked') return 'replanning';
  return 'approved';
}

function assertTransition(current: RequirementState, next: RequirementState): void {
  if (current === 'cancelled' && next !== 'cancelled') {
    throw new Error(`MIGRATED_REQUIREMENT_STATE_TRANSITION_INVALID: ${current} -> ${next}`);
  }
  if (current === 'done' && next !== 'done' && next !== 'cancelled') {
    throw new Error(`MIGRATED_REQUIREMENT_STATE_TRANSITION_INVALID: ${current} -> ${next}`);
  }
}

function decisionEvidence(id: string, input: MigratedIssueDecisionInput): EvidenceRef {
  const status = input.status ?? 'metadata_update';
  const summary = boundedText(input.summary, 1_000) ?? `Explicit migrated Issue decision: ${status}.`;
  return {
    evidenceId: id,
    title: `Legacy Issue decision ${input.issueId}`,
    summary,
    detailLevel: 'detail',
  };
}

/**
 * Apply a compatibility update to the post-cutover Requirement/Plan authority.
 * Legacy Issue files remain immutable history and are never rewritten here.
 */
export function applyMigratedIssueDecision(
  repoRoot: string,
  input: MigratedIssueDecisionInput,
): MigratedIssueDecisionResult | undefined {
  const cutover = legacyIssueCutoverState(repoRoot);
  if (!cutover.retired || !cutover.repoId) return undefined;
  const planId = portfolioPlanIdForIssue(input.issueId);
  if (!planId) return undefined;
  if (input.goals !== undefined || input.nonGoals !== undefined || input.relatedArtifacts !== undefined) {
    throw new Error('MIGRATED_ISSUE_FIELD_RETIRED: goals, non_goals, and related_artifacts require an explicit Requirement replan');
  }

  const id = decisionId(input);
  const at = new Date().toISOString();
  return withControlPlaneTransaction(cutover.controllerHome, (database) => {
    const planRecord = readControlPlaneRecordWithinTransaction<PlanContract>(
      database,
      'plan_contract',
      cutover.repoId!,
      planId,
    );
    if (!planRecord) throw new Error(`MIGRATED_PLAN_NOT_FOUND: ${planId}`);
    if (!planRecord.value.requirementId) throw new Error(`MIGRATED_PLAN_REQUIREMENT_MISSING: ${planId}`);
    const requirementRecord = readControlPlaneRecordWithinTransaction<Requirement>(
      database,
      'requirement',
      'controller',
      planRecord.value.requirementId,
    );
    if (!requirementRecord) throw new Error(`MIGRATED_REQUIREMENT_NOT_FOUND: ${planRecord.value.requirementId}`);

    const currentRequirement = requirementRecord.value;
    const siblingPlans = currentRequirement.legacyAliases
      .map((alias) => portfolioPlanIdForIssue(alias))
      .filter((candidate): candidate is string => Boolean(candidate) && candidate !== planId)
      .map((candidate) => readControlPlaneRecordWithinTransaction<PlanContract>(
        database,
        'plan_contract',
        cutover.repoId!,
        candidate,
      )?.value)
      .filter((candidate): candidate is PlanContract => Boolean(candidate));
    const siblingWorkRemains = siblingPlans.some((candidate) => !isTerminalPlanContractStatus(candidate.status));
    const requestedRequirementState = requirementState(input.status, currentRequirement.state);
    const nextRequirementState = input.status === 'done' && siblingWorkRemains
      ? currentRequirement.state
      : requestedRequirementState;
    assertTransition(currentRequirement.state, nextRequirementState);
    const blocked = input.status === 'launch_blocked';
    const reviewing = input.status === 'review';
    const terminal = nextRequirementState === 'done' || nextRequirementState === 'cancelled';
    const summary = boundedText(input.summary, 2_000);
    const title = boundedText(input.title, 500);
    const acceptanceCriteria = boundedList(input.acceptanceCriteria, 50);
    const evidence = decisionEvidence(id, input);

    const existingPlanEvidence = planRecord.value.evidenceRefs.some((entry) => entry.evidenceId === id);
    const existingRequirementAudit = currentRequirement.auditRefs.includes(id);
    if (existingPlanEvidence && existingRequirementAudit) {
      return {
        migrated: true,
        legacyIssueId: input.issueId,
        legacyIssueFrozen: true,
        decisionId: id,
        legacyPlanClosed: isTerminalPlanContractStatus(planRecord.value.status),
        requirementClosed: currentRequirement.state === 'done' || currentRequirement.state === 'cancelled',
        requirement: currentRequirement,
        plan: planRecord.value,
      };
    }

    const nextPlan: PlanContract = {
      ...planRecord.value,
      status: planStatus(input.status, planRecord.value.status),
      resolvedDecisions: Array.from(new Set([
        ...planRecord.value.resolvedDecisions,
        summary ?? `Migrated Issue ${input.issueId} set to ${input.status ?? 'metadata_update'}.`,
      ])).slice(-50),
      evidenceRefs: existingPlanEvidence
        ? planRecord.value.evidenceRefs
        : [...planRecord.value.evidenceRefs, evidence].slice(-20),
      updatedAt: at,
    };
    const nextRequirement: Requirement = {
      ...currentRequirement,
      title: title ?? currentRequirement.title,
      acceptanceCriteria: acceptanceCriteria ?? currentRequirement.acceptanceCriteria,
      state: nextRequirementState,
      needsAttention: terminal ? false : blocked || reviewing ? true : currentRequirement.needsAttention,
      attentionSummary: terminal
        ? undefined
        : blocked || reviewing
          ? summary ?? currentRequirement.attentionSummary ?? 'Further investigation and replanning are required.'
          : currentRequirement.attentionSummary,
      revision: currentRequirement.revision + 1,
      updatedAt: at,
      auditRefs: existingRequirementAudit
        ? currentRequirement.auditRefs
        : [...currentRequirement.auditRefs, id].slice(-50),
    };

    writeControlPlaneRecordWithinTransaction(database, {
      namespace: 'plan_contract',
      scope: cutover.repoId!,
      key: planId,
      schemaVersion: 1,
      value: nextPlan,
      action: 'migrated_issue_decision_applied',
      expectedRevision: planRecord.revision,
    });
    writeControlPlaneRecordWithinTransaction(database, {
      namespace: 'requirement',
      scope: 'controller',
      key: nextRequirement.requirementId,
      schemaVersion: 1,
      value: nextRequirement,
      action: terminal
        ? 'requirement_closed_by_explicit_legacy_decision'
        : input.status === 'done'
          ? 'legacy_plan_closed_by_explicit_decision'
          : 'requirement_replanned_by_legacy_decision',
      expectedRevision: requirementRecord.revision,
    });
    return {
      migrated: true,
      legacyIssueId: input.issueId,
      legacyIssueFrozen: true,
      decisionId: id,
      legacyPlanClosed: isTerminalPlanContractStatus(nextPlan.status),
      requirementClosed: nextRequirement.state === 'done' || nextRequirement.state === 'cancelled',
      requirement: nextRequirement,
      plan: nextPlan,
    };
  });
}
