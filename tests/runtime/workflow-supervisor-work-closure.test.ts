import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequirement, reviseRequirementSemantic, updateRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { createWorkContract, reviseWorkSemanticContext } from '../../packages/kernel/work/api/index';
import { callWorkflowSupervisorAdapter } from '../../adapters/mcp/runtime-gateway/workflow-supervisor-adapter';
import { runtimeToolDefinitions } from '../../adapters/mcp/runtime-gateway/runtime-tool-definitions';
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
  reviseRequirementSemantic({ controllerHome }, requirementId, {
    expectedRevision: 1, state: 'completed', remainingWork: [], acceptedEvidenceRefs: ['review:accepted'],
  });
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

test('Requirement DONE follows committed acceptance independently of open successor Work', async () => {
  const controllerHome = home(), repoId = 'repo-predecessor', requirementId = 'REQ-predecessor';
  accepted(controllerHome, requirementId);
  work(controllerHome, repoId, 'origin', { requirementId });
  work(controllerHome, repoId, 'next', { predecessorWorkId: 'origin' });
  reviseWorkSemanticContext({ controllerHome, repoId }, 'origin', { expectedRevision: 1, state: 'completed' });
  const goal = task(controllerHome, repoId, 'forge_requirement_done', requirementId);
  expect(await validate(goal, proposal))
    .toMatchObject({ valid: true, reason: 'requirement_accepted_evidence_committed' });
  reviseWorkSemanticContext({ controllerHome, repoId }, 'next', { expectedRevision: 1, state: 'completed' });
  expect(await validate(goal, proposal))
    .toMatchObject({ valid: true, reason: 'requirement_accepted_evidence_committed' });
});

test('Requirement DONE ignores superseding Work lineage after semantic acceptance', async () => {
  const controllerHome = home(), repoId = 'repo-supersedes', requirementId = 'REQ-supersedes';
  accepted(controllerHome, requirementId);
  work(controllerHome, repoId, 'original', { requirementId });
  work(controllerHome, repoId, 'replacement', { supersedes: ['original'] });
  work(controllerHome, repoId, 'unrelated');
  reviseWorkSemanticContext({ controllerHome, repoId }, 'original', { expectedRevision: 1, state: 'completed' });
  const goal = task(controllerHome, repoId, 'forge_dynamic_requirement_done', requirementId);
  expect(await validate(goal, proposal))
    .toMatchObject({ valid: true, reason: 'requirement_accepted_evidence_committed' });
  reviseWorkSemanticContext({ controllerHome, repoId }, 'replacement', { expectedRevision: 1, state: 'completed' });
  expect(await validate(goal, proposal))
    .toMatchObject({ valid: true, reason: 'requirement_accepted_evidence_committed' });
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

test('model_semantic_completion requires explicit Work proof but preserves unbound standalone tasks', async () => {
  const controllerHome = home(), repoId = 'repo-model-semantic-work';
  work(controllerHome, repoId, 'parent');
  work(controllerHome, repoId, 'child', { parentWorkId: 'parent' });
  const bound = task(controllerHome, repoId, 'model_semantic_completion', undefined, 'parent');
  const unbound = task(controllerHome, repoId, 'model_semantic_completion');

  expect(await validate(unbound, proposal)).toMatchObject({ valid: true, reason: 'model_semantic_completion' });
  expect(await validate(bound, proposal)).toMatchObject({ valid: false, reason: 'work_not_completed' });

  reviseWorkSemanticContext({ controllerHome, repoId }, 'parent', { expectedRevision: 1, state: 'completed' });
  expect(await validate(bound, proposal)).toMatchObject({
    valid: false, reason: 'bound_work_lineage_not_terminal', evidence: ['child'],
  });
  reviseWorkSemanticContext({ controllerHome, repoId }, 'child', { expectedRevision: 1, state: 'completed' });
  expect(await validate(bound, proposal)).toMatchObject({ valid: true, reason: 'work_terminal_committed' });
});

test('model_semantic_completion requires committed Requirement acceptance and rejects ambiguous or missing bindings', async () => {
  const controllerHome = home(), repoId = 'repo-model-semantic-requirement', requirementId = 'REQ-model-semantic';
  createRequirement({ controllerHome }, { requirementId, title: requirementId, outcomeStatement: 'A typed standalone binding must prove acceptance.' });
  updateRequirement({ controllerHome }, { requirementId, action: 'activate', mutate: (r) => ({ ...r, state: 'active' }) });
  const bound = task(controllerHome, repoId, 'model_semantic_completion', requirementId);
  const unbound = task(controllerHome, repoId, 'model_semantic_completion');
  expect(await validate(bound, proposal)).toMatchObject({ valid: false, reason: 'requirement_not_semantically_done:active' });
  expect(await validate(unbound, proposal)).toMatchObject({ valid: true, reason: 'model_semantic_completion' });
  expect(await validate(task(controllerHome, repoId, 'model_semantic_completion', 'REQ-missing'), proposal))
    .toMatchObject({ valid: false, reason: 'requirement_not_found' });

  reviseRequirementSemantic({ controllerHome }, requirementId, {
    expectedRevision: 1, state: 'completed', remainingWork: [], acceptedEvidenceRefs: ['review:accepted'],
  });
  work(controllerHome, repoId, 'parent', { requirementId });
  work(controllerHome, repoId, 'child', { parentWorkId: 'parent' });
  reviseWorkSemanticContext({ controllerHome, repoId }, 'parent', { expectedRevision: 1, state: 'completed' });
  expect(await validate(bound, proposal)).toMatchObject({ valid: true, reason: 'requirement_accepted_evidence_committed' });
  reviseWorkSemanticContext({ controllerHome, repoId }, 'child', { expectedRevision: 1, state: 'completed' });
  expect(await validate(bound, proposal)).toMatchObject({ valid: true, reason: 'requirement_accepted_evidence_committed' });
  expect(await validate(task(controllerHome, repoId, 'model_semantic_completion', requirementId, 'parent'), proposal))
    .toMatchObject({ valid: false, reason: 'semantic_completion_binding_ambiguous' });
});

test('standalone Supervisor exposes typed semantic bindings and rejects ambiguous scope before RPC', async () => {
  const controllerHome = home();
  const tool = runtimeToolDefinitions.find((entry) => entry.name === 'supervisor_task');
  expect(tool).toBeDefined();
  expect(JSON.stringify(tool?.inputSchema)).toContain('"work_id"');
  expect(JSON.stringify(tool?.inputSchema)).toContain('"requirement_id"');
  expect(tool?.description).toContain('omitting both keeps the unbound standalone contract');

  const ctx = { controllerHome } as unknown as Parameters<typeof callWorkflowSupervisorAdapter>[0];
  await expect(callWorkflowSupervisorAdapter(ctx, 'supervisor_task', {
    operation: 'start', objective: 'Reject ambiguous semantic target.', request_id: 'ambiguous-binding',
    repo_id: 'repo-bound', work_id: 'work-bound', requirement_id: 'REQ-bound',
  })).rejects.toThrow('WORKFLOW_SUPERVISOR_SEMANTIC_BINDING_AMBIGUOUS');
  await expect(callWorkflowSupervisorAdapter(ctx, 'supervisor_task', {
    operation: 'start', objective: 'Bound target requires repository scope.', request_id: 'missing-binding-repo', work_id: 'work-bound',
  })).rejects.toThrow('WORKFLOW_SUPERVISOR_SEMANTIC_BINDING_REPO_REQUIRED');
});
