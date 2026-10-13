import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequirement, updateRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { createWorkContract, reviseWorkSemanticContext } from '../../packages/kernel/work/api/index';
import { forgeWorkflowSupervisorValidators } from '../../supervisor/forge-validators';
import type { WorkflowSupervisorTask } from '../../supervisor/types';

const homes: string[] = [];
afterEach(() => { while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true }); });
const home = () => { const path = mkdtempSync(join(tmpdir(), 'forge-work-close-lineage-')); homes.push(path); return path; };
function work(controllerHome: string, repoId: string, id: string, extra: {
  requirementId?: string; parentWorkId?: string; predecessorWorkId?: string; supersedes?: string[];
} = {}) {
  return createWorkContract({ controllerHome, repoId }, {
    workId: id, repoId, checkoutId: 'fixture', objective: id,
    ...extra, acceptanceCriteria: [], allowedPaths: [], forbiddenPaths: [],
    checks: [], constraints: {}, requestedBy: 'chatgpt', dispatchState: 'running',
  });
}
function accepted(controllerHome: string, requirementId: string) {
  createRequirement({ controllerHome }, {
    requirementId, title: requirementId, outcomeStatement: 'Delivery after linked Work evidence',
  });
  updateRequirement({ controllerHome }, { requirementId, action: 'activate', mutate: r => ({ ...r, state: 'active' }) });
  updateRequirement({ controllerHome }, { requirementId, action: 'accepted', mutate: r => ({
    ...r, state: 'done',
    semanticAcceptance: { reviewer: 'test', rationale: 'reviewed', planIds: [], acceptedAt: new Date().toISOString() },
  }) });
}
function task(controllerHome: string, repoId: string, kind: string, requirementId?: string, workId?: string) {
  return { completionContract: { kind, controller_home: controllerHome, repo_id: repoId,
    ...(requirementId ? { requirement_id: requirementId } : {}),
    ...(workId ? { work_id: workId } : {}) }, userBlockerPolicy: {},
  } as unknown as WorkflowSupervisorTask;
}
const validate = forgeWorkflowSupervisorValidators().completionContract!;
const proposal = { action: 'DONE' } as any;

test('a cancelled Work is never evidence for forge_work_done', async () => {
  const controllerHome = home(), repoId = 'repo-cancelled';
  work(controllerHome, repoId, 'cancelled');
  reviseWorkSemanticContext({ controllerHome, repoId }, 'cancelled', { expectedRevision: 1, state: 'cancelled' });
  expect(await validate(task(controllerHome, repoId, 'forge_work_done', undefined, 'cancelled'), proposal))
    .toMatchObject({ valid: false, reason: 'work_not_completed' });
});

test('Requirement DONE must include a later open predecessor successor, not only the accepted origin', async () => {
  const controllerHome = home(), repoId = 'repo-predecessor', requirementId = 'REQ-predecessor';
  accepted(controllerHome, requirementId);
  work(controllerHome, repoId, 'origin', { requirementId });
  work(controllerHome, repoId, 'next', { predecessorWorkId: 'origin' });
  reviseWorkSemanticContext({ controllerHome, repoId }, 'origin', { expectedRevision: 1, state: 'completed' });
  const goal = task(controllerHome, repoId, 'forge_requirement_done', requirementId);
  expect(await validate(goal, proposal))
    .toMatchObject({ valid: false, reason: 'bound_work_lineage_not_terminal', evidence: ['next'] });
  reviseWorkSemanticContext({ controllerHome, repoId }, 'next', { expectedRevision: 1, state: 'completed' });
  expect(await validate(goal, proposal))
    .toMatchObject({ valid: true, reason: 'requirement_semantic_acceptance_committed' });
});

test('Requirement DONE must follow explicitly superseding primary Work without pulling unrelated Work', async () => {
  const controllerHome = home(), repoId = 'repo-supersedes', requirementId = 'REQ-supersedes';
  accepted(controllerHome, requirementId);
  work(controllerHome, repoId, 'original', { requirementId });
  work(controllerHome, repoId, 'replacement', { supersedes: ['original'] });
  work(controllerHome, repoId, 'unrelated');
  reviseWorkSemanticContext({ controllerHome, repoId }, 'original', { expectedRevision: 1, state: 'completed' });
  const goal = task(controllerHome, repoId, 'forge_dynamic_requirement_done', requirementId);
  expect(await validate(goal, proposal))
    .toMatchObject({ valid: false, reason: 'bound_work_lineage_not_terminal', evidence: ['replacement'] });
  reviseWorkSemanticContext({ controllerHome, repoId }, 'replacement', { expectedRevision: 1, state: 'completed' });
  expect(await validate(goal, proposal))
    .toMatchObject({ valid: true, reason: 'requirement_semantic_acceptance_committed' });
});

test('completed parent is insufficient while execution child is still open', async () => {
  const controllerHome = home(), repoId = 'repo-child';
  work(controllerHome, repoId, 'parent');
  work(controllerHome, repoId, 'child', { parentWorkId: 'parent' });
  reviseWorkSemanticContext({ controllerHome, repoId }, 'parent', { expectedRevision: 1, state: 'completed' });
  const goal = task(controllerHome, repoId, 'forge_work_done', undefined, 'parent');
  expect(await validate(goal, proposal))
    .toMatchObject({ valid: false, reason: 'bound_work_lineage_not_terminal', evidence: ['child'] });
  reviseWorkSemanticContext({ controllerHome, repoId }, 'child', { expectedRevision: 1, state: 'completed' });
  expect(await validate(goal, proposal))
    .toMatchObject({ valid: true, reason: 'work_terminal_committed' });
});
