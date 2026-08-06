#!/usr/bin/env bun
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { resolve } from 'path';
import {
  legacyIssueCutoverState,
  migratedTaskCompletionState,
  recordMigratedTaskCompletion,
} from '../src/cli/controller/legacy-issue-cutover';
import type { CompletionReceipt } from '../src/cli/controller/types';
import { readControlPlaneRecord } from '../src/runtime/control-plane/persistence/sqlite-store';
import type { Requirement } from '../src/runtime/control-plane/persistence/requirement-store';
import type { PlanContract } from '../src/runtime/control-plane/facade/types';

const ISSUE_ID = 'ISS-20260802-7E1D69';
const PLAN_ID = 'PLAN-20260802-7E1D69';
const REQUIREMENT_ID = 'REQ-CONTROL-PLANE';
const TASK_IDS = ['T6', 'T7'] as const;

function git(repoRoot: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0 || result.error) {
    throw new Error(`GIT_COMMAND_FAILED: git ${args.join(' ')}: ${result.stderr || result.error?.message || 'unknown error'}`);
  }
  return result.stdout.trim();
}

function receiptId(taskId: string, head: string): string {
  return `REC-control-plane-final-${taskId}-${createHash('sha256').update(`${taskId}\0${head}`).digest('hex').slice(0, 16)}`;
}

function completionReceipt(taskId: string, head: string, changedPaths: string[], recordedAt: string): CompletionReceipt {
  return {
    schemaVersion: 1,
    receiptId: receiptId(taskId, head),
    source: 'direct_edit',
    issueId: ISSUE_ID,
    taskId,
    targetBranch: 'main',
    targetRevision: head,
    sourceRevision: head,
    changedPaths,
    delivery: {
      kind: 'commit',
      status: 'integrated',
      strategy: 'already_integrated',
      reachable: true,
      recordedAt,
    },
    cleanup: {
      status: 'complete',
      warnings: [],
      blockers: [],
      recordedAt,
    },
    verifiedAt: recordedAt,
    recordedAt,
  };
}

function main(): void {
  const repoRoot = resolve(process.argv[2] ?? process.cwd());
  const expectedHead = (process.argv[3] ?? '').trim();
  const deliveryBase = (process.argv[4] ?? '').trim();
  if (!/^[0-9a-f]{40}$/.test(expectedHead)) {
    throw new Error('USAGE: bun scripts/complete-control-plane-cutover.ts <repo-root> <expected-40-char-head> [delivery-base-40-char-head]');
  }
  if (deliveryBase && !/^[0-9a-f]{40}$/.test(deliveryBase)) {
    throw new Error(`CONTROL_PLANE_COMPLETION_INVALID_DELIVERY_BASE: ${deliveryBase}`);
  }

  const branch = git(repoRoot, ['branch', '--show-current']);
  const head = git(repoRoot, ['rev-parse', 'HEAD']);
  const status = git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (branch !== 'main') throw new Error(`CONTROL_PLANE_COMPLETION_BRANCH_MISMATCH: expected=main actual=${branch || 'detached'}`);
  if (head !== expectedHead) throw new Error(`CONTROL_PLANE_COMPLETION_HEAD_MISMATCH: expected=${expectedHead} actual=${head}`);
  if (status) throw new Error(`CONTROL_PLANE_COMPLETION_DIRTY_CHECKOUT: ${status.split('\n').join(', ')}`);
  const reachable = spawnSync('git', ['merge-base', '--is-ancestor', expectedHead, 'main'], { cwd: repoRoot, encoding: 'utf8' });
  if (reachable.status !== 0 || reachable.error) throw new Error(`CONTROL_PLANE_COMPLETION_HEAD_NOT_REACHABLE: ${expectedHead}`);

  const cutover = legacyIssueCutoverState(repoRoot);
  if (!cutover.retired || !cutover.repoId || !cutover.migration) {
    throw new Error('CONTROL_PLANE_CUTOVER_MARKER_NOT_FOUND');
  }
  const changedPathArgs = deliveryBase
    ? ['diff', '--name-only', `${deliveryBase}..${head}`]
    : ['show', '--pretty=format:', '--name-only', head];
  const changedPaths = [...new Set(git(repoRoot, changedPathArgs).split('\n').filter(Boolean))].sort();
  const recordedAt = new Date().toISOString();
  const outcomes = TASK_IDS.map((taskId) => {
    const current = migratedTaskCompletionState(repoRoot, ISSUE_ID, taskId);
    if (current.completed) return { taskId, action: 'already_completed', ...current };
    const completed = recordMigratedTaskCompletion(repoRoot, {
      issueId: ISSUE_ID,
      taskId,
      receipt: completionReceipt(taskId, head, changedPaths, recordedAt),
      reviewer: 'forge-final-cutover',
      note: 'Final SQLite cutover and legacy writer retirement were integrated at user direction. Final-HEAD tests were explicitly skipped; no check-pass claim is recorded.',
    });
    return { taskId, action: 'completed', ...completed };
  });

  const requirement = readControlPlaneRecord<Requirement>(cutover.controllerHome, 'requirement', 'controller', REQUIREMENT_ID);
  const plan = readControlPlaneRecord<PlanContract>(cutover.controllerHome, 'plan_contract', cutover.repoId, PLAN_ID);
  if (!requirement || requirement.value.state !== 'done') {
    throw new Error(`CONTROL_PLANE_REQUIREMENT_NOT_DONE: ${requirement?.value.state ?? 'missing'}`);
  }
  for (const taskId of TASK_IDS) {
    const step = plan?.value.steps.find((candidate) => candidate.id === taskId);
    if (step?.status !== 'completed') throw new Error(`CONTROL_PLANE_PLAN_STEP_NOT_COMPLETED: ${PLAN_ID}/${taskId}`);
  }
  process.stdout.write(`${JSON.stringify({
    repoRoot,
    repoId: cutover.repoId,
    branch,
    head,
    deliveryBase: deliveryBase || undefined,
    verification: { status: 'skipped_by_user', checksRecorded: [] },
    migrationId: cutover.migration.migrationId,
    requirement: { requirementId: REQUIREMENT_ID, state: requirement.value.state, revision: requirement.revision },
    plan: { planId: PLAN_ID, status: plan?.value.status, revision: plan?.revision },
    outcomes,
  }, null, 2)}\n`);
}

main();
