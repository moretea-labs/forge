import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { resolveRepoPreferredControllerHome } from '../repositories/controller-home';
import {
  readControlPlaneRecord,
  readControlPlaneRecordWithinTransaction,
  withControlPlaneTransaction,
  writeControlPlaneRecordWithinTransaction,
} from '../../runtime/control-plane/persistence/sqlite-store';
import type { Requirement } from '../../runtime/control-plane/persistence/requirement-store';
import type { EvidenceRef, PlanContract } from '../../runtime/control-plane/facade/types';
import type { CompletionReceipt, ControllerIssue, IssueStatus, TaskStatus } from './types';
import type { EffectiveTaskState, IssueLifecycleStatus, VerificationStatus } from './task-status-resolver';
import {
  REQUIREMENT_PORTFOLIO_MIGRATION_ID,
  portfolioPlanIdForIssue,
  type RequirementPortfolioMigrationRecord,
} from './requirement-portfolio-migration';

const REPOSITORY_IDENTITY_PATH = '.ai/harness/repository.json';

export interface LegacyIssueCutoverState {
  retired: boolean;
  controllerHome: string;
  repoId?: string;
  migration?: RequirementPortfolioMigrationRecord;
}

function repositoryIdentity(repoRoot: string): { repoId?: string } {
  const path = join(repoRoot, REPOSITORY_IDENTITY_PATH);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { repoId?: unknown };
    return typeof parsed.repoId === 'string' && parsed.repoId.trim()
      ? { repoId: parsed.repoId.trim() }
      : {};
  } catch {
    return {};
  }
}

export function legacyIssueCutoverState(repoRoot: string): LegacyIssueCutoverState {
  const controllerHome = resolveRepoPreferredControllerHome(repoRoot);
  const { repoId } = repositoryIdentity(repoRoot);
  if (!repoId) return { retired: false, controllerHome };
  const record = readControlPlaneRecord<RequirementPortfolioMigrationRecord>(
    controllerHome,
    'requirement_portfolio_migration',
    repoId,
    REQUIREMENT_PORTFOLIO_MIGRATION_ID,
  );
  return { retired: Boolean(record), controllerHome, repoId, migration: record?.value };
}

export function legacyIssueAuthorityRetired(repoRoot: string): boolean {
  // Only the immutable SQLite migration marker can retire or retain legacy writers;
  // repository projection files never reactivate themselves after cutover.
  return legacyIssueCutoverState(repoRoot).retired;
}

export function assertLegacyIssueWritesAllowed(repoRoot: string, issue?: { id?: string; ephemeral?: boolean }): void {
  if (issue?.ephemeral) return;
  const state = legacyIssueCutoverState(repoRoot);
  if (!state.retired) return;
  throw new Error(
    `LEGACY_ISSUE_WRITES_RETIRED: ${issue?.id ?? 'durable Issue'} is frozen history after ${REQUIREMENT_PORTFOLIO_MIGRATION_ID}; write Requirement/Plan/Work authority instead.`,
  );
}

export function assertLegacyProjectBoardAvailable(repoRoot: string): void {
  if (!legacyIssueAuthorityRetired(repoRoot)) return;
  throw new Error(
    `LEGACY_PROJECT_BOARD_RETIRED: use get_project_board Requirement Board or explicit Execution Diagnostics after ${REQUIREMENT_PORTFOLIO_MIGRATION_ID}.`,
  );
}

export function assertLegacyCurrentIssueWriteAllowed(repoRoot: string): void {
  if (!legacyIssueAuthorityRetired(repoRoot)) return;
  throw new Error(
    `LEGACY_CURRENT_ISSUE_RETIRED: currentIssue is no longer execution authority after ${REQUIREMENT_PORTFOLIO_MIGRATION_ID}.`,
  );
}

export interface FrozenLegacyTaskProjection {
  id: string;
  taskId: string;
  objective: string;
  status: TaskStatus;
  declaredStatus: TaskStatus;
  effectiveStatus: TaskStatus;
  planStepStatus: PlanContract['steps'][number]['status'];
  workId?: string;
  checks: string[];
  acceptanceCriteria: string[];
  evidenceRefs: EvidenceRef[];
  deprecated: true;
  frozen: true;
  readOnly: true;
  authority: 'controller-home-sqlite';
}

export interface FrozenLegacyIssueProjection {
  schemaVersion: 1;
  projection: 'deprecated_frozen_legacy_issue';
  detailLevel: 'summary' | 'full';
  deprecated: true;
  frozen: true;
  readOnly: true;
  authority: 'controller-home-sqlite';
  migrationId: string;
  sourceRevision: string;
  id: string;
  legacyIssueId: string;
  requirementId: string;
  planId: string;
  title: string;
  summary: string;
  kind: 'legacy_compatibility';
  status: IssueStatus;
  archivedAt?: undefined;
  lifecycleStatus: IssueLifecycleStatus;
  updatedAt: string;
  tasks: FrozenLegacyTaskProjection[];
  notice: string;
}

function projectedTaskStatus(status: PlanContract['steps'][number]['status']): TaskStatus {
  if (status === 'completed') return 'done';
  if (status === 'validating') return 'verifying';
  if (status === 'executing') return 'running';
  if (status === 'ready') return 'ready';
  return 'planned';
}

export function frozenLegacyIssueProjection(
  repoRoot: string,
  issueId: string,
  detailLevel: 'summary' | 'full' = 'summary',
): FrozenLegacyIssueProjection | undefined {
  const cutover = legacyIssueCutoverState(repoRoot);
  if (!cutover.retired || !cutover.repoId || !cutover.migration) return undefined;
  const planId = portfolioPlanIdForIssue(issueId);
  if (!planId || !cutover.migration.sourceIssueIds.includes(issueId)) return undefined;
  const plan = readControlPlaneRecord<PlanContract>(cutover.controllerHome, 'plan_contract', cutover.repoId, planId)?.value;
  if (!plan?.requirementId) throw new Error(`MIGRATED_PLAN_REQUIREMENT_MISSING: ${planId}`);
  const requirement = readControlPlaneRecord<Requirement>(cutover.controllerHome, 'requirement', 'controller', plan.requirementId)?.value;
  if (!requirement) throw new Error(`MIGRATED_REQUIREMENT_NOT_FOUND: ${plan.requirementId}`);
  const projected = projectedIssueStatus(requirement.state);
  const tasks = plan.steps.map((step) => ({
    id: step.id,
    taskId: step.id,
    objective: step.objective,
    status: projectedTaskStatus(step.status),
    declaredStatus: projectedTaskStatus(step.status),
    effectiveStatus: projectedTaskStatus(step.status),
    planStepStatus: step.status,
    workId: step.workId,
    checks: step.checks,
    acceptanceCriteria: step.acceptanceCriteria,
    evidenceRefs: detailLevel === 'full' ? step.evidenceRefs : step.evidenceRefs.slice(-3),
    deprecated: true as const,
    frozen: true as const,
    readOnly: true as const,
    authority: 'controller-home-sqlite' as const,
  }));
  return {
    schemaVersion: 1,
    projection: 'deprecated_frozen_legacy_issue',
    detailLevel,
    deprecated: true,
    frozen: true,
    readOnly: true,
    authority: 'controller-home-sqlite',
    migrationId: cutover.migration.migrationId,
    sourceRevision: cutover.migration.sourceRevision,
    id: issueId,
    legacyIssueId: issueId,
    requirementId: requirement.requirementId,
    planId,
    title: requirement.title,
    summary: plan.goal,
    kind: 'legacy_compatibility',
    status: projected.issueStatus,
    archivedAt: undefined,
    lifecycleStatus: projected.lifecycle,
    updatedAt: [requirement.updatedAt, plan.updatedAt].sort().at(-1) ?? requirement.updatedAt,
    tasks,
    notice: 'Deprecated frozen compatibility projection. Requirement, Plan and Work records in controller-home SQLite are authoritative; repository Issue/Task file changes are ignored.',
  };
}

export function listFrozenLegacyIssueProjections(
  repoRoot: string,
  detailLevel: 'summary' | 'full' = 'summary',
): FrozenLegacyIssueProjection[] {
  const cutover = legacyIssueCutoverState(repoRoot);
  if (!cutover.retired || !cutover.migration) return [];
  return cutover.migration.sourceIssueIds
    .map((issueId) => frozenLegacyIssueProjection(repoRoot, issueId, detailLevel))
    .filter((projection): projection is FrozenLegacyIssueProjection => Boolean(projection));
}

export function frozenLegacyTaskProjection(
  repoRoot: string,
  issueId: string,
  taskId: string,
  detailLevel: 'summary' | 'full' = 'summary',
): { issue: FrozenLegacyIssueProjection; task: FrozenLegacyTaskProjection } | undefined {
  const issue = frozenLegacyIssueProjection(repoRoot, issueId, detailLevel);
  if (!issue) return undefined;
  const task = issue.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) throw new Error(`MIGRATED_PLAN_STEP_NOT_FOUND: ${issue.planId}/${taskId}`);
  return { issue, task };
}

export interface MigratedTaskCompletionState {
  migrated: boolean;
  completed: boolean;
  planId?: string;
  requirementId?: string;
  receiptId?: string;
}

function completionEvidence(receipt: CompletionReceipt, input: {
  reviewer: string;
  note?: string;
  checks?: Array<{ checkId: string; ok: boolean; summary?: string }>;
}): EvidenceRef[] {
  const refs: EvidenceRef[] = [{
    evidenceId: receipt.receiptId,
    title: 'Completion receipt',
    summary: `Delivered ${receipt.targetRevision}; delivery=${receipt.delivery.status}; cleanup=${receipt.cleanup.status}; reviewer=${input.reviewer}.`,
    detailLevel: 'detail',
  }];
  for (const check of input.checks ?? []) {
    refs.push({
      evidenceId: `${receipt.receiptId}:${check.checkId}`,
      title: `Check ${check.checkId}`,
      summary: `${check.ok ? 'passed' : 'failed'}${check.summary ? `: ${check.summary}` : ''}`.slice(0, 1_000),
      detailLevel: 'detail',
    });
  }
  if (input.note?.trim()) refs.push({ title: 'Review note', summary: input.note.trim().slice(0, 1_000), detailLevel: 'detail' });
  return refs.slice(0, 12);
}

export interface MigratedIssueReadinessProjection {
  planId: string;
  requirementId: string;
  issueStatus: IssueStatus;
  states: Map<string, EffectiveTaskState>;
}

function projectedIssueStatus(state: Requirement['state']): { issueStatus: IssueStatus; lifecycle: IssueLifecycleStatus } {
  if (state === 'done') return { issueStatus: 'done', lifecycle: 'completed' };
  if (state === 'cancelled') return { issueStatus: 'cancelled', lifecycle: 'cancelled' };
  if (state === 'planned') return { issueStatus: 'planned', lifecycle: 'active' };
  return { issueStatus: 'in_progress', lifecycle: 'active' };
}

function planStepTaskState(
  taskId: string,
  status: PlanContract['steps'][number]['status'],
  lifecycle: IssueLifecycleStatus,
): EffectiveTaskState {
  const mapping: Record<typeof status, {
    declaredStatus: TaskStatus;
    effectiveStatus: EffectiveTaskState['effectiveStatus'];
    verificationStatus: VerificationStatus;
    terminal: boolean;
    dispatchable: boolean;
    dependencySatisfied: boolean;
  }> = {
    pending: { declaredStatus: 'planned', effectiveStatus: 'ready', verificationStatus: 'not_started', terminal: false, dispatchable: true, dependencySatisfied: false },
    ready: { declaredStatus: 'ready', effectiveStatus: 'ready', verificationStatus: 'not_started', terminal: false, dispatchable: true, dependencySatisfied: false },
    executing: { declaredStatus: 'running', effectiveStatus: 'running', verificationStatus: 'pending', terminal: false, dispatchable: false, dependencySatisfied: false },
    validating: { declaredStatus: 'verifying', effectiveStatus: 'verifying', verificationStatus: 'pending', terminal: false, dispatchable: false, dependencySatisfied: false },
    completed: { declaredStatus: 'done', effectiveStatus: 'done', verificationStatus: 'passed', terminal: true, dispatchable: false, dependencySatisfied: true },
  };
  const selected = mapping[status];
  return {
    taskId,
    declaredStatus: selected.declaredStatus,
    effectiveStatus: selected.effectiveStatus,
    reason: status === 'completed' ? 'declared_done' : 'declared_status',
    issueLifecycleStatus: lifecycle,
    activeRunIds: [],
    historicalRunOutcomes: [],
    verificationStatus: selected.verificationStatus,
    replacementTaskIds: [],
    terminal: selected.terminal,
    inactive: false,
    dispatchable: selected.dispatchable,
    retryable: false,
    requiresExplicitRetry: false,
    dependencySatisfied: selected.dependencySatisfied,
    multipleActiveRuns: false,
  };
}

export function migratedIssueReadinessProjection(
  repoRoot: string,
  issue: ControllerIssue,
): MigratedIssueReadinessProjection | undefined {
  const cutover = legacyIssueCutoverState(repoRoot);
  if (!cutover.retired || !cutover.repoId) return undefined;
  const planId = portfolioPlanIdForIssue(issue.id);
  if (!planId) return undefined;
  const plan = readControlPlaneRecord<PlanContract>(cutover.controllerHome, 'plan_contract', cutover.repoId, planId)?.value;
  if (!plan?.requirementId) throw new Error(`MIGRATED_PLAN_REQUIREMENT_MISSING: ${planId}`);
  const requirement = readControlPlaneRecord<Requirement>(cutover.controllerHome, 'requirement', 'controller', plan.requirementId)?.value;
  if (!requirement) throw new Error(`MIGRATED_REQUIREMENT_NOT_FOUND: ${plan.requirementId}`);
  const projected = projectedIssueStatus(requirement.state);
  const states = new Map<string, EffectiveTaskState>();
  for (const step of plan.steps) {
    states.set(step.id, planStepTaskState(step.id, step.status, projected.lifecycle));
  }
  return { planId, requirementId: plan.requirementId, issueStatus: projected.issueStatus, states };
}

export function migratedTaskCompletionState(repoRoot: string, issueId: string, taskId: string): MigratedTaskCompletionState {
  const cutover = legacyIssueCutoverState(repoRoot);
  if (!cutover.retired || !cutover.repoId) return { migrated: false, completed: false };
  const planId = portfolioPlanIdForIssue(issueId);
  if (!planId) return { migrated: false, completed: false };
  const plan = readControlPlaneRecord<PlanContract>(cutover.controllerHome, 'plan_contract', cutover.repoId, planId)?.value;
  const step = plan?.steps.find((candidate) => candidate.id === taskId);
  const receiptId = step?.evidenceRefs.find((reference) => reference.title === 'Completion receipt')?.evidenceId;
  return { migrated: Boolean(plan && step), completed: step?.status === 'completed', planId, requirementId: plan?.requirementId, receiptId };
}

export function recordMigratedTaskCompletion(
  repoRoot: string,
  input: {
    issueId: string;
    taskId: string;
    receipt: CompletionReceipt;
    reviewer: string;
    note?: string;
    checks?: Array<{ checkId: string; ok: boolean; summary?: string }>;
  },
): MigratedTaskCompletionState {
  const cutover = legacyIssueCutoverState(repoRoot);
  if (!cutover.retired || !cutover.repoId) return { migrated: false, completed: false };
  const planId = portfolioPlanIdForIssue(input.issueId);
  if (!planId) throw new Error(`MIGRATED_PLAN_NOT_MAPPED: ${input.issueId}`);

  return withControlPlaneTransaction(cutover.controllerHome, (database) => {
    const migration = readControlPlaneRecordWithinTransaction<RequirementPortfolioMigrationRecord>(
      database, 'requirement_portfolio_migration', cutover.repoId!, REQUIREMENT_PORTFOLIO_MIGRATION_ID,
    );
    if (!migration) throw new Error('REQUIREMENT_PORTFOLIO_MIGRATION_NOT_FOUND');
    const planRecord = readControlPlaneRecordWithinTransaction<PlanContract>(database, 'plan_contract', cutover.repoId!, planId);
    if (!planRecord) throw new Error(`MIGRATED_PLAN_NOT_FOUND: ${planId}`);
    const stepIndex = planRecord.value.steps.findIndex((step) => step.id === input.taskId);
    if (stepIndex < 0) throw new Error(`MIGRATED_PLAN_STEP_NOT_FOUND: ${planId}/${input.taskId}`);
    const currentStep = planRecord.value.steps[stepIndex];
    const existingReceipt = currentStep.evidenceRefs.find((reference) => reference.title === 'Completion receipt')?.evidenceId;
    if (currentStep.status === 'completed') {
      if (existingReceipt && existingReceipt !== input.receipt.receiptId) {
        throw new Error(`MIGRATED_PLAN_STEP_RECEIPT_CONFLICT: ${planId}/${input.taskId}`);
      }
      return { migrated: true, completed: true, planId, requirementId: planRecord.value.requirementId, receiptId: existingReceipt };
    }

    const at = input.receipt.recordedAt;
    const steps = [...planRecord.value.steps];
    steps[stepIndex] = {
      ...currentStep,
      status: 'completed',
      evidenceRefs: [
        ...currentStep.evidenceRefs.filter((reference) => reference.evidenceId !== input.receipt.receiptId),
        ...completionEvidence(input.receipt, input),
      ].slice(-20),
    };
    const allCompleted = steps.every((step) => step.status === 'completed');
    const nextPlan: PlanContract = {
      ...planRecord.value,
      sourceRevision: input.receipt.targetRevision,
      steps,
      status: allCompleted ? 'finalized' : 'executing',
      evidenceRefs: [
        ...planRecord.value.evidenceRefs.filter((reference) => reference.evidenceId !== input.receipt.receiptId),
        { evidenceId: input.receipt.receiptId, title: `Completed ${input.taskId}`, summary: `Integrated ${input.receipt.targetRevision}.`, detailLevel: 'detail' as const },
      ].slice(-20),
      updatedAt: at,
    };
    writeControlPlaneRecordWithinTransaction(database, {
      namespace: 'plan_contract', scope: cutover.repoId!, key: planId, schemaVersion: 1,
      value: nextPlan, action: 'migrated_plan_step_completed', expectedRevision: planRecord.revision,
    });

    if (nextPlan.requirementId) {
      const requirementRecord = readControlPlaneRecordWithinTransaction<Requirement>(database, 'requirement', 'controller', nextPlan.requirementId);
      if (!requirementRecord) throw new Error(`MIGRATED_REQUIREMENT_NOT_FOUND: ${nextPlan.requirementId}`);
      const current = requirementRecord.value;
      const next: Requirement = {
        ...current,
        requiredDeliveryReferences: [...new Set([...current.requiredDeliveryReferences, input.receipt.receiptId])].slice(-50),
        state: allCompleted && current.activePlanId === planId ? 'done' : current.state,
        needsAttention: allCompleted && current.activePlanId === planId ? false : current.needsAttention,
        attentionSummary: allCompleted && current.activePlanId === planId ? undefined : current.attentionSummary,
        revision: requirementRecord.revision + 1,
        updatedAt: at,
        auditRefs: [...new Set([...current.auditRefs, input.receipt.receiptId])].slice(-50),
      };
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: 'requirement', scope: 'controller', key: next.requirementId, schemaVersion: 1,
        value: next, action: allCompleted ? 'requirement_delivery_completed' : 'requirement_plan_step_completed',
        expectedRevision: requirementRecord.revision,
      });
    }
    return { migrated: true, completed: true, planId, requirementId: nextPlan.requirementId, receiptId: input.receipt.receiptId };
  });
}
