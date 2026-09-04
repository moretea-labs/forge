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
import { claimPlanStepForWork, getPlanContract } from '../../src/runtime/control-plane/facade/plan-contract-store';
import { readRequirement, updateRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';
import { buildFrozenSemanticCompatibilityCapability } from '../../adapters/mcp/frozen-client-semantic-compatibility';

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
  test('lets a frozen rh_work schema create Requirement authority through a bounded semantic transport envelope', async () => {
    const repoRoot = tempRoot('forge-frozen-requirement-repo-');
    const controllerHome = tempRoot('forge-frozen-requirement-home-');
    initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Frozen Requirement fixture' });
    const ctx = mcpContext(controllerHome, repository);
    const capability = buildFrozenSemanticCompatibilityCapability({
      operation: 'requirement_create',
      args: {
        requirement_title: 'Frozen client semantic compatibility',
        requirement_outcome: 'Establish Requirement authority through the canonical Runtime even when the client schema predates requirement_create.',
        requirement_acceptance_criteria: ['The compatibility envelope remains transport-only and bounded.'],
        requirement_delivery_references: ['frozen-client-self-host-proof'],
      },
    });
    const frozenArgs = {
      repo_id: repository.repoId,
      operation: 'repair',
      requirement_id: 'REQ-FROZEN-SEMANTIC-COMPAT',
      capability_id: capability,
    };

    const created = structured(await callRuntimeTool(ctx, 'rh_work', frozenArgs));
    expect(created.status).toBe('ok');
    expect(created.data.requirementCreated).toBe(true);
    expect(readRequirement({ controllerHome }, 'REQ-FROZEN-SEMANTIC-COMPAT')?.value).toMatchObject({
      title: 'Frozen client semantic compatibility',
      outcomeStatement: 'Establish Requirement authority through the canonical Runtime even when the client schema predates requirement_create.',
    });

    const retried = structured(await callRuntimeTool(ctx, 'rh_work', frozenArgs));
    expect(retried.status).toBe('ok');
    expect(retried.data.requirementCreated).toBe(false);
    expect(retried.data.admissionDecision).toBe('reuse_existing');

    const nativeConflict = structured(await callRuntimeTool(ctx, 'rh_work', {
      ...frozenArgs,
      requirement_title: 'must not override envelope transport',
    }));
    expect(nativeConflict.status).toBe('blocked');
    expect(nativeConflict.summary).toContain('FROZEN_SEMANTIC_COMPATIBILITY_CONFLICT');

    const hiddenScope = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'repair',
      capability_id: capability,
    }));
    expect(hiddenScope.status).toBe('blocked');
    expect(hiddenScope.summary).toContain('FROZEN_SEMANTIC_COMPATIBILITY_SCOPE_REQUIRED');
  });

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

  test('explicit requirement_continue resumes waiting_for_user idempotently and never reopens terminal Requirement', async () => {
    const repoRoot = tempRoot('forge-requirement-continue-repo-');
    const controllerHome = tempRoot('forge-requirement-continue-home-');
    initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Requirement continue fixture' });
    const ctx = mcpContext(controllerHome, repository);
    const requirementId = 'REQ-SEMANTIC-CONTINUE';

    const created = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'requirement_create',
      requirement_id: requirementId,
      requirement_title: 'Semantic continuation',
      requirement_outcome: 'Resume machine-valid delivery only after an explicit semantic continue.',
    }));
    expect(created.status).toBe('ok');
    updateRequirement({ controllerHome }, {
      requirementId,
      action: 'machine_valid_delivery_waits_for_semantics',
      mutate: (current) => ({ ...current, state: 'waiting_for_user', needsAttention: true, attentionSummary: 'Explicit continue required.' }),
    });

    const resumed = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'requirement_continue',
      requirement_id: requirementId,
      requested_by: 'user',
    }));
    expect(resumed.status).toBe('ok');
    expect(resumed.data.requirementResumed).toBe(true);
    expect(resumed.data.requirement).toMatchObject({ state: 'active', needsAttention: false });
    expect(resumed.data.requirement.attentionSummary).toBeUndefined();

    const repeated = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'requirement_continue',
      requirement_id: requirementId,
      requested_by: 'user',
    }));
    expect(repeated.status).toBe('ok');
    expect(repeated.data.requirementResumed).toBe(false);
    expect(repeated.data.requirement.revision).toBe(resumed.data.requirement.revision);

    updateRequirement({ controllerHome }, {
      requirementId,
      action: 'semantic_acceptance',
      mutate: (current) => ({ ...current, state: 'done' }),
    });
    const terminal = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'requirement_continue',
      requirement_id: requirementId,
      requested_by: 'user',
    }));
    expect(terminal.status).toBe('blocked');
    expect(terminal.summary).toContain(`REQUIREMENT_TERMINAL: ${requirementId}:done`);
    expect(readRequirement({ controllerHome }, requirementId)?.value.state).toBe('done');
  }, 15_000);

  test('atomically replans an active Plan-bound Work scope through rh_work without replacing the Work', async () => {
    const repoRoot = tempRoot('forge-active-plan-work-replan-repo-');
    const controllerHome = tempRoot('forge-active-plan-work-replan-home-');
    const sourceRevision = initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Active Plan Work replan fixture' });
    const ctx = mcpContext(controllerHome, repository);
    const store = { controllerHome, repoId: repository.repoId };

    const created = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'plan_create',
      plan_id: 'PLAN-ACTIVE-SCOPE-R1',
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
    const approved = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId, operation: 'plan_approve', plan_id: 'PLAN-ACTIVE-SCOPE-R1',
    }));
    expect(approved.status).toBe('ok');

    createWorkContract(store, {
      workId: 'work-active-scope', repoId: repository.repoId, planId: 'PLAN-ACTIVE-SCOPE-R1', planStepId: 'stage', planSourceRevision: sourceRevision,
      mode: 'goal_workloop', objective: 'Deliver without replacing Work authority.', acceptanceCriteria: ['The same Work remains authoritative.'],
      allowedPaths: ['src/**'], forbiddenPaths: [], checks: ['package:check:type'], constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
    });
    claimPlanStepForWork(store, { planId: 'PLAN-ACTIVE-SCOPE-R1', stepId: 'stage', workId: 'work-active-scope', sourceRevision });

    const diagnosed = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'repair',
      plan_id: 'PLAN-ACTIVE-SCOPE-R1',
      plan_step_id: 'stage',
      superseded_by: 'PLAN-ACTIVE-SCOPE-R2',
      source_revision: sourceRevision,
      allowed_paths: ['src/runtime/context/**'],
      repair_operation: 'diagnose',
      dry_run: true,
    }));
    expect(diagnosed.status).toBe('ok');
    expect(diagnosed.summary).toContain('PLAN_WORK_SCOPE_REPLAN_AVAILABLE');
    expect(diagnosed.data).toMatchObject({ boundWorkId: 'work-active-scope', successorPlanId: 'PLAN-ACTIVE-SCOPE-R2', repaired: false, reusedExistingWork: true });
    expect(diagnosed.data.requestedAllowedPaths).toEqual(['src/**', 'src/runtime/context/**']);

    const repaired = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'repair',
      plan_id: 'PLAN-ACTIVE-SCOPE-R1',
      plan_step_id: 'stage',
      superseded_by: 'PLAN-ACTIVE-SCOPE-R2',
      source_revision: sourceRevision,
      allowed_paths: ['src/runtime/context/**'],
      repair_operation: 'repair',
      dry_run: false,
      reason: 'Current-source evidence proved the active Plan omitted a path required by its own accepted scope.',
    }));
    expect(repaired.status).toBe('ok');
    expect(repaired.data).toMatchObject({ repaired: true, replacementWorkCreated: false, reusedExistingWork: true });
    expect(repaired.data.predecessor).toMatchObject({ planId: 'PLAN-ACTIVE-SCOPE-R1', status: 'superseded' });
    expect(repaired.data.successor).toMatchObject({ planId: 'PLAN-ACTIVE-SCOPE-R2', status: 'executing' });
    expect(repaired.data.work).toMatchObject({ workId: 'work-active-scope', status: 'running' });
    expect(getPlanContract(store, 'PLAN-ACTIVE-SCOPE-R1')?.supersededBy).toBe('PLAN-ACTIVE-SCOPE-R2');
    expect(getPlanContract(store, 'PLAN-ACTIVE-SCOPE-R2')?.steps[0]).toMatchObject({ workId: 'work-active-scope', allowedPaths: ['src/**', 'src/runtime/context/**'] });
    expect(getWorkContract(store, 'work-active-scope')).toMatchObject({ planId: 'PLAN-ACTIVE-SCOPE-R2', allowedPaths: ['src/**', 'src/runtime/context/**'], checks: ['package:check:type'] });
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

    const approved = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'plan_approve',
      plan_id: 'PLAN-LEGACY-MALFORMED',
    }));
    expect(approved.status).toBe('ok');
    expect(approved.data.plan.status).toBe('approved');
  }, 15_000);
});

describe('rh_work verification registry', () => {
  test('resolves checks from the Work checkout when candidate content adds a package check after admission', async () => {
    const repoRoot = tempRoot('forge-verify-registry-repo-');
    const controllerHome = tempRoot('forge-verify-registry-home-');
    const sourceRevision = initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Verification registry fixture' });
    const worktreeParent = tempRoot('forge-verify-registry-worktree-');
    const candidateRoot = join(worktreeParent, 'candidate');
    git(repoRoot, 'worktree', 'add', '-b', 'candidate-registry', candidateRoot);
    const repositoryWithCandidate = addRepositoryCheckout({
      controllerHome,
      repoId: repository.repoId,
      path: candidateRoot,
    });
    const candidateCheckout = repositoryWithCandidate.checkouts.find((checkout) => checkout.checkoutId !== repository.activeCheckoutId);
    expect(candidateCheckout).toBeTruthy();

    const workId = 'WORK-VERIFY-CANDIDATE-REGISTRY';
    createWorkContract({ controllerHome, repoId: repository.repoId }, {
      workId,
      repoId: repository.repoId,
      checkoutId: candidateCheckout!.checkoutId,
      baseRevision: sourceRevision,
      mode: 'goal_workloop',
      objective: 'Verify a check introduced only by the candidate checkout.',
      acceptanceCriteria: ['Candidate check is resolved from the Work checkout.'],
      allowedPaths: ['package.json'],
      forbiddenPaths: [],
      checks: ['package:check:candidate'],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });

    writeFileSync(join(candidateRoot, 'package.json'), JSON.stringify({
      name: 'requirement-bootstrap-fixture',
      scripts: {
        'check:type': 'node -e "process.exit(0)"',
        'check:candidate': 'node -e "process.exit(0)"',
      },
    }, null, 2));

    const verified = structured(await callRuntimeTool(mcpContext(controllerHome, repositoryWithCandidate), 'rh_work', {
      repo_id: repository.repoId,
      operation: 'verify',
      work_id: workId,
      check_id: 'package:check:candidate',
      simulate_check: true,
    }));
    expect(verified.status).toBe('ok');
    expect(verified.data.verification).toMatchObject({ checkId: 'package:check:candidate', outcome: 'valid_pass' });
    expect(verified.summary).not.toContain('not registered');
  });
});
