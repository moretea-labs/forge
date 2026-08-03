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
import type { CompletionReceipt } from './types';
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
