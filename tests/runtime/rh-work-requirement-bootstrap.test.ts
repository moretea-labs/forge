import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { addRepositoryCheckout, registerRepository } from '../../src/cli/repositories/registry';
import { createWorkContract, getWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { getPlanContract } from '../../src/runtime/control-plane/facade/plan-contract-store';
import { readRequirement, updateRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { ensureForgeInstanceIdentity, readForgeInstanceIdentity } from '../../packages/kernel/identity/api/index';
import { recordCognitiveMemory, type CognitiveWriteAuthorityPort } from '../../packages/kernel/cognition/api/index';
import { cognitionMemoryStore } from '../../src/runtime/control-plane/persistence/cognition-store';
import {
  resolveProjectForRepositoryPlacement,
  writeProjectIdentity,
  writeProjectPlacement,
  writeWorkspaceIdentity,
} from '../../src/runtime/control-plane/workspace/workspace-store';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(repoRoot: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function initRepo(repoRoot: string): string {
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
    name: 'requirement-bootstrap-fixture',
    scripts: { 'check:type': 'node -e "process.exit(0)"' },
  }, null, 2));
  writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export const ready = true;\n');
  git(repoRoot, 'init', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 'test@example.com');
  git(repoRoot, 'config', 'user.name', 'Forge Test');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-m', 'init');
  return git(repoRoot, 'rev-parse', 'HEAD');
}

function mcpContext(controllerHome: string, repository: ReturnType<typeof registerRepository>): MultiRepositoryMcpToolContext {
  return {
    repoRoot: repository.canonicalRoot,
    controllerHome,
    policy: getMcpPolicy('controller', { repoRoot: repository.canonicalRoot }),
    toolset: 'core',
    enableChatgptBrowser: false,
    explicitRepository: repository,
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext;
}

function structured(result: Awaited<ReturnType<typeof callRuntimeTool>>): Record<string, any> {
  expect(result).toBeTruthy();
  return (result!.structuredContent
    ?? JSON.parse(result!.content[0] && 'text' in result!.content[0] ? String(result!.content[0].text) : '{}')) as Record<string, any>;
}

describe('rh_work Requirement bootstrap', () => {
  test('automatically onboards Project/Workspace identity during normal Work start admission', async () => {
    const repoRoot = tempRoot('forge-work-project-onboarding-repo-');
    const controllerHome = tempRoot('forge-work-project-onboarding-home-');
    initRepo(repoRoot);
    mkdirSync(join(repoRoot, '.forge'), { recursive: true });
    writeFileSync(join(repoRoot, '.forge', 'project-engineering.json'), JSON.stringify({
      schemaVersion: 1,
      contractId: 'work-onboarding-contract',
      contractVersion: '1',
      projectId: 'work-onboarding-project',
      authority: {},
      quality: {},
      checks: [],
      journeys: [],
    }, null, 2));
    git(repoRoot, 'add', '.forge/project-engineering.json');
    git(repoRoot, 'commit', '-m', 'add project contract');
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Work onboarding fixture' });
    const ctx = {
      ...mcpContext(controllerHome, repository),
      principalId: 'project-onboarding-principal',
      sessionId: 'project-onboarding-session',
      controllerInstanceId: 'project-onboarding-runtime',
      controllerType: 'chatgpt',
    } as unknown as MultiRepositoryMcpToolContext;

    const started = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'start',
      objective: 'Verify semantic project onboarding at Work admission.',
      requested_by: 'user',
      scope_clear: true,
      work_kind: 'completed_no_change',
    }));
    expect(started.status).toBe('ok');
    expect(started.data.projectOnboarding).toMatchObject({
      status: 'bound',
      projectId: 'work-onboarding-project',
      workspaceId: 'workspace-personal',
      identitySource: 'project_contract',
      createdProject: true,
      createdPlacement: true,
    });
    const instance = readForgeInstanceIdentity(controllerHome);
    expect(instance).toBeTruthy();
    expect(resolveProjectForRepositoryPlacement({
      controllerHome,
      forgeInstanceId: instance!.instanceId,
      repositoryId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
    })).toMatchObject({
      projectId: 'work-onboarding-project',
      workspaceId: 'workspace-personal',
    });
  });

  test('explicitly promotes one Workspace Cognitive requirement candidate into exactly one canonical Requirement', async () => {
    const repoRoot = tempRoot('forge-requirement-candidate-repo-');
    const controllerHome = tempRoot('forge-requirement-candidate-home-');
    initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Requirement candidate fixture' });
    const instance = ensureForgeInstanceIdentity({ controllerHome });
    const workspaceId = 'workspace-requirement-candidate';
    const projectId = 'project-requirement-candidate';
    writeWorkspaceIdentity({
      controllerHome,
      value: { workspaceId, title: 'Requirement Candidate Workspace' },
    });
    writeProjectIdentity({
      controllerHome,
      value: { projectId, workspaceId, displayName: 'Requirement Candidate Project' },
    });
    writeProjectPlacement({
      controllerHome,
      value: {
        projectId,
        forgeInstanceId: instance.instanceId,
        repositoryId: repository.repoId,
        checkoutId: repository.activeCheckoutId,
      },
    });

    const scope = { schemaVersion: 1 as const, kind: 'workspace' as const, id: workspaceId };
    const store = cognitionMemoryStore(controllerHome);
    const authority: CognitiveWriteAuthorityPort = {
      assertMemoryWrite: () => undefined,
      assertEdgeWrite: () => undefined,
      evidenceAvailable: () => true,
    };
    const observedAt = '2026-09-20T09:00:00.000Z';
    recordCognitiveMemory(store, authority, {
      id: 'promoted:requirement-candidate-source',
      scope,
      facets: ['knowledge', 'pattern', 'engineering-principle', 'cross-project', 'repeated_root_cause'],
      canonicalText: 'Repeated root cause shows a systemic architecture defect.',
      concepts: ['forge.execution-quality.repeated_root_cause'],
      provenance: {
        sourceKind: 'system',
        sourceId: 'project-learning-promotion:project-source:consolidated-source',
        recordedAt: observedAt,
        evidenceRefs: ['receipt-root-cause-1', 'receipt-root-cause-2', 'receipt-root-cause-3'],
      },
      confidence: 0.95,
      utility: 0.9,
      tier: 'warm',
      validFrom: observedAt,
      counterEvidenceRefs: [],
    });
    recordCognitiveMemory(store, authority, {
      id: 'candidate:requirement-candidate-source',
      scope,
      facets: ['candidate-finding', 'requirement-candidate', 'advisory', 'engineering-improvement', 'repeated_root_cause'],
      canonicalText: 'Candidate finding for normal Requirement promotion only.',
      concepts: ['forge.requirement-candidate', 'forge.engineering-improvement', 'forge.execution-quality.repeated_root_cause'],
      provenance: {
        sourceKind: 'system',
        sourceId: 'cognitive-requirement-candidate:promoted:requirement-candidate-source',
        recordedAt: observedAt,
        evidenceRefs: ['receipt-root-cause-1', 'receipt-root-cause-2', 'receipt-root-cause-3'],
      },
      confidence: 0.95,
      utility: 0.9,
      tier: 'warm',
      validFrom: observedAt,
      counterEvidenceRefs: [],
    });

    const ctx = mcpContext(controllerHome, repository);
    const promoted = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'requirement_promote_candidate',
      requirement_candidate_id: 'candidate:requirement-candidate-source',
      requirement_id: 'REQ-COGNITIVE-CANDIDATE',
      requirement_title: 'Resolve repeated systemic root cause',
      requirement_outcome: 'Replace the repeated root cause with one coherent architecture correction.',
      requirement_acceptance_criteria: ['The root cause is corrected through normal Requirement/Plan/Work authority.'],
    }));
    expect(promoted.status).toBe('ok');
    expect(promoted.data.requirementCreated).toBe(true);
    expect(promoted.data.admissionDecision).toBe('created');
    expect(promoted.data.requirementCandidatePromoted).toBe(true);
    expect(promoted.data.requirement).not.toHaveProperty('auditRefs');
    expect(readRequirement({ controllerHome }, 'REQ-COGNITIVE-CANDIDATE')?.value.auditRefs)
      .toContain(promoted.data.candidateAuditRef);

    const duplicate = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'requirement_promote_candidate',
      requirement_candidate_id: 'candidate:requirement-candidate-source',
      requirement_id: 'REQ-COGNITIVE-CANDIDATE-DUPLICATE',
      requirement_title: 'Duplicate semantic branch must not be created',
      requirement_outcome: 'This should reuse the original candidate-bound Requirement.',
    }));
    expect(duplicate.status).toBe('ok');
    expect(duplicate.data.requirementCreated).toBe(false);
    expect(duplicate.data.admissionDecision).toBe('candidate_already_promoted');
    expect(duplicate.data.requirement.requirementId).toBe('REQ-COGNITIVE-CANDIDATE');
    expect(readRequirement({ controllerHome }, 'REQ-COGNITIVE-CANDIDATE-DUPLICATE')).toBeUndefined();
  });

  test('lets an execution-baseline shift preserve Plan authority without replacing an unrelated active Plan', async () => {
    const repoRoot = tempRoot('forge-frozen-invalidated-plan-repo-');
    const controllerHome = tempRoot('forge-frozen-invalidated-plan-home-');
    const sourceRevision = initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Frozen invalidated Plan fixture' });
    const ctx = mcpContext(controllerHome, repository);
    const requirementId = 'REQ-FROZEN-INVALIDATED-PLAN';
    const predecessorPlanId = 'PLAN-FROZEN-INVALIDATED-R1';
    const unrelatedPlanId = 'PLAN-FROZEN-POST-V2';
    const step = {
      id: 'stage-a', objective: 'Preserve exact successor lineage.', dependencies: [], authoritative_files: [],
      allowed_paths: ['src/**'], forbidden_paths: [], check_ids: ['package:check:type'], acceptance_criteria: ['lineage remains exact'],
    };

    expect(structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId, operation: 'requirement_create', requirement_id: requirementId,
      requirement_title: 'Preserve Plan execution baseline', requirement_outcome: 'Keep execution-baseline changes separate from semantic Plan replanning.',
    })).status).toBe('ok');
    expect(structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId, operation: 'plan_create', plan_id: predecessorPlanId, requirement_id: requirementId,
      scope_key: 'v2-release', source_revision: sourceRevision, objective: 'Predecessor Plan.', plan_steps: [step],
    })).status).toBe('ok');
    // The predecessor keeps its authored item state; no Work link, execution
    // baseline or approval-derived status is written.
    expect(getPlanContract({ controllerHome, repoId: repository.repoId }, predecessorPlanId)).toMatchObject({
      planId: predecessorPlanId,
      revision: 1,
      status: 'draft',
      steps: [{ id: 'stage-a', status: 'pending' }],
    });

    expect(structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId, operation: 'plan_create', plan_id: unrelatedPlanId, requirement_id: requirementId,
      scope_key: 'post-v2', source_revision: sourceRevision, objective: 'Unrelated post-V2 Plan.', plan_relation: 'parallel', plan_steps: [step],
    })).status).toBe('ok');

    expect(getPlanContract({ controllerHome, repoId: repository.repoId }, predecessorPlanId)).toMatchObject({
      planId: predecessorPlanId,
      revision: 1,
      status: 'draft',
      steps: [{ id: 'stage-a', status: 'pending' }],
    });
    expect(getPlanContract({ controllerHome, repoId: repository.repoId }, unrelatedPlanId)?.status).toBe('draft');
    expect(getPlanContract({ controllerHome, repoId: repository.repoId }, unrelatedPlanId)?.supersededBy).toBeUndefined();
  }, 15_000);

  test('creates Requirement authority idempotently without implying Plan and still permits explicit Plan creation', async () => {
    const repoRoot = tempRoot('forge-requirement-repo-');
    const controllerHome = tempRoot('forge-requirement-home-');
    const sourceRevision = initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Requirement fixture' });
    const ctx = mcpContext(controllerHome, repository);

    const requirementArgs = {
      repo_id: repository.repoId,
      operation: 'requirement_create',
      requirement_id: 'REQ-ANDROID-NATIVE-V1',
      requirement_title: 'Android native delivery',
      requirement_outcome: 'Deliver Android through contract-first native implementation.',
      requirement_acceptance_criteria: ['Foundation gates exist before production source.'],
    };

    const created = structured(await callRuntimeTool(ctx, 'rh_work', requirementArgs));
    expect(created.status).toBe('ok');
    expect(created.data.requirementCreated).toBe(true);
    expect(created.summary).toContain('does not imply a Plan');
    expect(created.suggestedNextActions ?? []).toEqual([]);
    expect(readRequirement({ controllerHome }, 'REQ-ANDROID-NATIVE-V1')?.value.title).toBe('Android native delivery');

    const retried = structured(await callRuntimeTool(ctx, 'rh_work', requirementArgs));
    expect(retried.status).toBe('ok');
    expect(retried.data.requirementCreated).toBe(false);
    expect(retried.data.admissionDecision).toBe('reuse_existing');
    expect(retried.summary).toContain('does not imply a Plan');
    expect(retried.suggestedNextActions ?? []).toEqual([]);

    const conflict = structured(await callRuntimeTool(ctx, 'rh_work', {
      ...requirementArgs,
      requirement_outcome: 'Conflicting replacement outcome.',
    }));
    expect(conflict.status).toBe('blocked');
    expect(conflict.summary).toContain('REQUIREMENT_ALREADY_EXISTS_CONFLICT');
    expect(readRequirement({ controllerHome }, 'REQ-ANDROID-NATIVE-V1')?.value.outcomeStatement)
      .toBe('Deliver Android through contract-first native implementation.');

    const planned = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'plan_create',
      plan_id: 'PLAN-ANDROID-NATIVE-V1',
      requirement_id: 'REQ-ANDROID-NATIVE-V1',
      scope_key: 'android-native-v1',
      source_revision: sourceRevision,
      objective: 'Bootstrap Android governance.',
      plan_steps: [{
        id: 'governance',
        objective: 'Create governance gates.',
        dependencies: [],
        authoritative_files: [],
        allowed_paths: ['android/**'],
        forbidden_paths: ['ios/**'],
        check_ids: [],
        acceptance_criteria: ['Governance is machine enforced.'],
      }],
    }));
    expect(planned.status).toBe('ok');
    expect(planned.data.planContractCreated).toBe(true);
  }, 15_000);

  test('current plan_create writes thin semantic Plan items without PlanStep authority or approval', async () => {
    const repoRoot = tempRoot('forge-thin-plan-create-repo-');
    const controllerHome = tempRoot('forge-thin-plan-create-home-');
    const sourceRevision = initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Thin Plan create fixture' });
    const ctx = mcpContext(controllerHome, repository);

    expect(structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'requirement_create',
      requirement_id: 'REQ-THIN-PLAN-CREATE',
      requirement_title: 'Thin Plan creation',
      requirement_outcome: 'Plan remains model-authored working memory.',
    })).status).toBe('ok');

    const created = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'plan_create',
      plan_id: 'PLAN-THIN-CREATE',
      requirement_id: 'REQ-THIN-PLAN-CREATE',
      scope_key: 'thin-plan-create',
      source_revision: sourceRevision,
      objective: 'Record strategy without creating execution ownership.',
      plan_items: [
        { id: 'item-a', objective: 'Describe one useful slice.', dependencies: [] },
        { id: 'item-b', objective: 'Describe a dependent slice.', dependencies: ['item-a'] },
      ],
    }));
    expect(created.status).toBe('ok');
    expect(created.summary).toContain('no approval, PlanStep, path/check, scheduling, Work, or acceptance authority');
    expect(created.data.plan).toMatchObject({
      planId: 'PLAN-THIN-CREATE',
      revision: 1,
      items: [
        { id: 'item-a', objective: 'Describe one useful slice.', dependencies: [] },
        { id: 'item-b', objective: 'Describe a dependent slice.', dependencies: ['item-a'] },
      ],
    });
    const stored = getPlanContract({ controllerHome, repoId: repository.repoId }, 'PLAN-THIN-CREATE');
    expect(stored?.steps).toEqual([]);
    expect(stored?.semanticRevision).toBe(1);

    const sameLabel = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'plan_create',
      plan_id: 'PLAN-THIN-CREATE-PARALLEL',
      requirement_id: 'REQ-THIN-PLAN-CREATE',
      scope_key: 'thin-plan-create',
      source_revision: sourceRevision,
      objective: 'A second semantic Plan may share the same descriptive scope label.',
      plan_items: [{ id: 'item-c', objective: 'Remain independent working memory.', dependencies: [] }],
    }));
    expect(sameLabel.status).toBe('ok');
    expect(sameLabel.data.plan).toMatchObject({ planId: 'PLAN-THIN-CREATE-PARALLEL', revision: 1 });

    const revised = structured(await callRuntimeTool(ctx, 'rh_work', {
      operation: 'plan_revise',
      plan_id: 'PLAN-THIN-CREATE',
      expected_revision: 1,
      objective: 'Revise the same stable semantic Plan without repository selection.',
      plan_items: [{ id: 'item-r2', objective: 'Replace working-memory content in place.', dependencies: [] }],
    }));
    expect(revised.status).toBe('ok');
    expect(revised.data.plan).toMatchObject({
      planId: 'PLAN-THIN-CREATE',
      revision: 2,
      goal: 'Revise the same stable semantic Plan without repository selection.',
    });

    const stale = structured(await callRuntimeTool(ctx, 'rh_work', {
      operation: 'plan_revise',
      plan_id: 'PLAN-THIN-CREATE',
      expected_revision: 1,
      objective: 'A stale writer must not overwrite revision 2.',
    }));
    expect(stale.status).toBe('blocked');
    expect(stale.data.currentPlan).toMatchObject({ planId: 'PLAN-THIN-CREATE', revision: 2 });
  }, 15_000);

  test('retires the Plan scope-replan writer and keeps Work scope widening a Work-owned operation', async () => {
    const repoRoot = tempRoot('forge-active-plan-work-replan-repo-');
    const controllerHome = tempRoot('forge-active-plan-work-replan-home-');
    const sourceRevision = initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Active Plan Work replan fixture' });
    const ctx = mcpContext(controllerHome, repository);
    const store = { controllerHome, repoId: repository.repoId };
    const planId = 'PLAN-ACTIVE-SCOPE-R1';

    const created = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'plan_create',
      plan_id: planId,
      scope_key: 'active-scope-replan',
      source_revision: sourceRevision,
      objective: 'Deliver one active scope-bound Work.',
      plan_steps: [{
        id: 'stage', objective: 'Deliver without replacing Work authority.', dependencies: [],
        authoritative_files: ['src/index.ts'], allowed_paths: ['src/**'], forbidden_paths: [],
        check_ids: ['package:check:type'], acceptance_criteria: ['The same Work remains authoritative.'],
      }],
    }));
    expect(created.status).toBe('ok');
    createWorkContract(store, {
      workId: 'work-active-scope', repoId: repository.repoId, planId, planStepId: 'stage', planSourceRevision: sourceRevision,
      objective: 'Deliver without replacing Work authority.', acceptanceCriteria: ['The same Work remains authoritative.'],
      allowedPaths: ['src/**'], forbiddenPaths: [], checks: ['package:check:type'], constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
    });

    // Plan-scoped repair is a read-only fact now: it neither replans the Plan nor
    // rewrites the Work, and it never decides replacement admission.
    const repaired = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'repair',
      plan_id: planId,
      plan_step_id: 'stage',
      superseded_by: 'PLAN-ACTIVE-SCOPE-R2',
      source_revision: sourceRevision,
      allowed_paths: ['src/runtime/context/**'],
      repair_operation: 'repair',
      dry_run: false,
      reason: 'Current-source evidence proved the active Plan omitted a path required by its own accepted scope.',
    }));
    expect(repaired.status).toBe('ok');
    expect(repaired.summary).toContain('PLAN_STEP_AUTHORED_FACT');
    expect(repaired.data).toMatchObject({ repaired: false, repairRequired: false, compatibilityNoop: true, planItemStatus: 'pending' });
    expect(getPlanContract(store, planId)).toMatchObject({ planId, revision: 1, status: 'draft' });
    expect(getPlanContract(store, planId)?.steps[0]).toMatchObject({ allowedPaths: ['src/**'] });
    expect(getPlanContract(store, planId)?.steps[0]?.workId).toBeUndefined();
    expect(getPlanContract(store, 'PLAN-ACTIVE-SCOPE-R2')).toBeUndefined();
    expect(getWorkContract(store, 'work-active-scope')).toMatchObject({ allowedPaths: ['src/**'] });

    // Work scope is owned by the Work: no Plan revision, approval or accepted
    // Plan path fence is consulted when a caller widens its own scope.
    expect(getWorkContract(store, 'work-active-scope')?.planSourceRevision).toBe(sourceRevision);
  }, 15_000);


  test('repairs a malformed draft Plan in place through rh_work without creating a second authority', async () => {
    const repoRoot = tempRoot('forge-plan-repair-repo-');
    const controllerHome = tempRoot('forge-plan-repair-home-');
    const sourceRevision = initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Plan repair fixture' });
    const ctx = mcpContext(controllerHome, repository);

    const malformed = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'plan_create',
      plan_id: 'PLAN-LEGACY-MALFORMED',
      scope_key: 'legacy-malformed-scope',
      source_revision: '',
      objective: '',
      plan_steps: [],
    }));
    expect(malformed.status).toBe('ok');
    expect(malformed.data.planContractCreated).toBe(true);

    const repeatedCreate = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'plan_create',
      plan_id: 'PLAN-LEGACY-MALFORMED',
      scope_key: 'legacy-malformed-scope',
      source_revision: sourceRevision,
      objective: 'Restore the existing draft to a reviewable PlanContract.',
      plan_steps: [{
        id: 'repair', objective: 'Repair the draft authority in place.', dependencies: [],
        authoritative_files: ['src/index.ts'], allowed_paths: ['src/**'], forbidden_paths: [],
        check_ids: ['package:check:type'], acceptance_criteria: ['The same Plan can be approved.'],
      }],
    }));
    expect(repeatedCreate.status).toBe('ok');
    expect(repeatedCreate.data.planContractCreated).toBe(false);
    expect(repeatedCreate.data.repairRequired).toBe(true);
    expect(repeatedCreate.suggestedNextActions[0]).toMatchObject({
      operation: 'repair',
      payload: { plan_id: 'PLAN-LEGACY-MALFORMED', repair_operation: 'repair', dry_run: false },
    });

    const diagnosed = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'repair',
      plan_id: 'PLAN-LEGACY-MALFORMED',
      repair_operation: 'diagnose',
      dry_run: true,
    }));
    expect(diagnosed.status).toBe('ok');
    expect(diagnosed.data.repairRequired).toBe(true);
    expect(diagnosed.data.plan.planId).toBe('PLAN-LEGACY-MALFORMED');

    const repaired = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'repair',
      plan_id: 'PLAN-LEGACY-MALFORMED',
      repair_operation: 'repair',
      dry_run: false,
      scope_key: 'legacy-malformed-scope',
      source_revision: sourceRevision,
      objective: 'Restore the existing draft to a reviewable PlanContract.',
      plan_steps: [{
        id: 'repair',
        objective: 'Repair the draft authority in place.',
        dependencies: [],
        authoritative_files: ['src/index.ts'],
        allowed_paths: ['src/**'],
        forbidden_paths: [],
        check_ids: ['package:check:type'],
        acceptance_criteria: ['The same Plan can be approved.'],
      }],
    }));
    expect(repaired.status).toBe('ok');
    expect(repaired.data.repaired).toBe(true);
    expect(repaired.data.replacementPlanCreated).toBe(false);
    expect(repaired.data.plan.planId).toBe('PLAN-LEGACY-MALFORMED');

    expect(getPlanContract({ controllerHome, repoId: repository.repoId }, 'PLAN-LEGACY-MALFORMED')?.status).toBe('draft');
  }, 15_000);
});
