import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { controllerExpectedToolNames } from '../../src/cli/mcp/legacy-tool-service';
import {
  ADVANCED_CONTROLLER_TOOL_NAMES,
  DEFAULT_CONTROLLER_TOOL_NAMES,
  PREFERRED_FACADE_TOOL_NAMES,
  allControllerToolDefinitions,
  classifyControllerToolExposure,
  exposedControllerToolDefinitions,
} from '../../src/cli/mcp/toolset';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';
import { callRuntimeTool, runtimeSourceSnapshotStatus, runtimeToolDefinitions } from '../../src/runtime/gateway/mcp/runtime-tools';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { collectRuntimeSourceIdentity } from '../../src/runtime/control-plane/runtime-generation';
import { createWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { createHandoffItem } from '../../src/runtime/control-plane/facade/handoff-inbox-store';
import { claimControllerSession, getControllerSession } from '../../src/runtime/control-plane/facade/controller-session-store';
import { startExecutionSession } from '../../src/runtime/control-plane/execution/session-store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function controllerFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-facade-mcp-repo-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-facade-mcp-home-'));
  roots.push(repoRoot, controllerHome);
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
    name: 'facade-mcp-fixture',
    scripts: {
      'check:type': 'node -e "process.exit(0)"',
      test: 'node -e "process.exit(0)"',
    },
  }, null, 2));
  spawnSync('git', ['add', 'package.json'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  ensureControllerHome(controllerHome);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'fixture' });
  const policy = getMcpPolicy('controller', { repoRoot });
  const ctx = {
    repoRoot,
    controllerHome,
    policy,
    toolset: 'core' as const,
    enableChatgptBrowser: false,
    explicitRepository: repository,
    sessionId: 'facade-session-default',
    principalId: 'facade-principal-default',
    controllerInstanceId: 'facade-controller-default',
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext;
  return { ctx, repository, controllerHome, repoRoot, policy };
}

function structured(result: Awaited<ReturnType<typeof callRuntimeTool>>): Record<string, unknown> {
  expect(result).toBeTruthy();
  return (result!.structuredContent ?? JSON.parse(result!.content[0] && 'text' in result!.content[0] ? String(result!.content[0].text) : '{}')) as Record<string, unknown>;
}

describe('facade MCP surface wiring', () => {
  test('preferred facade tools are part of default core exposure and runtime definitions', () => {
    expect(PREFERRED_FACADE_TOOL_NAMES).toEqual(['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work']);
    for (const name of PREFERRED_FACADE_TOOL_NAMES) {
      expect(DEFAULT_CONTROLLER_TOOL_NAMES).toContain(name);
      expect(ADVANCED_CONTROLLER_TOOL_NAMES).toContain(name);
      const all = allControllerToolDefinitions(controllerFixture().ctx);
      expect(all.some((tool) => tool.name === name)).toBe(true);
      expect(classifyControllerToolExposure(name)).toBe('facade');
    }
  });

  test('controllerExpectedToolNames includes rh_status/rh_inbox/rh_context/rh_work', () => {
    const policy = getMcpPolicy('controller');
    const expected = controllerExpectedToolNames(policy);
    expect(expected).toContain('rh_status');
    expect(expected).toContain('rh_inbox');
    expect(expected).toContain('rh_context');
    expect(expected).toContain('rh_work');
    // Preferred facade tools are listed first.
    expect(expected.slice(0, 5)).toEqual(['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work']);
  });

  test('core toolset exposes rh_* schemas in runtime registry', () => {
    const { ctx } = controllerFixture();
    const exposed = exposedControllerToolDefinitions(ctx).map((tool) => tool.name);
    expect(exposed).toContain('rh_status');
    expect(exposed).toContain('rh_inbox');
    expect(exposed).toContain('rh_context');
    expect(exposed).toContain('rh_work');
    const all = allControllerToolDefinitions(ctx);
    for (const name of PREFERRED_FACADE_TOOL_NAMES) {
      const def = all.find((tool) => tool.name === name);
      expect(def?.inputSchema).toBeTruthy();
      expect((def?.inputSchema as { properties?: Record<string, unknown> }).properties?.operation).toBeTruthy();
    }
    const inbox = all.find((tool) => tool.name === 'rh_inbox');
    const work = all.find((tool) => tool.name === 'rh_work');
    expect(JSON.stringify(inbox?.inputSchema)).toContain('accept');
    expect(JSON.stringify(work?.inputSchema)).toContain('controller_claim');
    expect(JSON.stringify(work?.inputSchema)).toContain('launcher_start');
  });

  test('runtime source snapshot ignores workflow artifacts but detects runtime code edits', () => {
    const { repoRoot } = controllerFixture();
    const active = collectRuntimeSourceIdentity(repoRoot);

    mkdirSync(join(repoRoot, 'tasks', 'issues'), { recursive: true });
    writeFileSync(join(repoRoot, 'tasks', 'issues', 'ISS-pending.issue.md'), '# pending\n');
    // Second arg pins Controller Runtime Source fixture for the test; it is not
    // an execution repository selection.
    const workflowOnly = runtimeSourceSnapshotStatus(active, repoRoot);
    expect(workflowOnly.restartRequired).toBe(false);
    expect(workflowOnly.current?.dirty).toBe(false);

    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src', 'runtime-change.ts'), 'export const changed = true;\n');
    const runtimeChanged = runtimeSourceSnapshotStatus(active, repoRoot);
    expect(runtimeChanged.restartRequired).toBe(true);
    expect(runtimeChanged.current?.dirty).toBe(true);
    expect(runtimeChanged.reasons).toContain('runtime source files changed after startup');
  });

  test('rh_status returns FacadeResult', async () => {
    const { ctx, repository } = controllerFixture();
    const payload = structured(await callRuntimeTool(ctx, 'rh_status', {
      repo_id: repository.repoId,
      operation: 'get',
    }));
    expect(payload).toMatchObject({
      schemaVersion: 1,
      status: expect.stringMatching(/ok|blocked/),
      summary: expect.any(String),
      rawAvailable: false,
      detailLevel: 'summary',
    });
    const toolSurface = (payload.data as { toolSurface: string[] }).toolSurface;
    // Summary keeps the preferred facade surface only; full schema is detail-level.
    expect(toolSurface).toEqual([...PREFERRED_FACADE_TOOL_NAMES]);
    expect((payload.data as { toolSurfaceStatus: { missingTools: string[] } }).toolSurfaceStatus.missingTools).toEqual([]);
    expect(JSON.stringify(payload)).not.toMatch(/stdout|stderr|Bearer |private_key/i);

    const detail = structured(await callRuntimeTool(ctx, 'rh_status', {
      repo_id: repository.repoId,
      operation: 'get',
      detail_level: 'detail',
    }));
    const detailSurface = (detail.data as { toolSurface: string[] }).toolSurface;
    for (const name of PREFERRED_FACADE_TOOL_NAMES) expect(detailSurface).toContain(name);
    expect(detailSurface.length).toBeGreaterThan(PREFERRED_FACADE_TOOL_NAMES.length);
    expect(detail.rawAvailable).toBe(true);
    expect(detail.detailLevel).toBe('detail');
  });

  test('rh_inbox list/get/resolve returns bounded FacadeResult', async () => {
    const { ctx, repository } = controllerFixture();
    const created = structured(await callRuntimeTool(ctx, 'rh_inbox', {
      repo_id: repository.repoId,
      operation: 'create',
      title: 'Needs decision',
      reason: 'Ambiguous outcome',
    }));
    const handoffId = (created.data as { item: { id: string } }).item.id;
    const listed = structured(await callRuntimeTool(ctx, 'rh_inbox', {
      repo_id: repository.repoId,
      operation: 'list',
    }));
    expect((listed.data as { items: Array<{ id: string }> }).items.some((item) => item.id === handoffId)).toBe(true);
    expect(JSON.stringify(listed.data)).not.toContain('stdout');

    const got = structured(await callRuntimeTool(ctx, 'rh_inbox', {
      repo_id: repository.repoId,
      operation: 'get',
      handoff_id: handoffId,
    }));
    expect(got.status).toBe('ok');

    const resolved = structured(await callRuntimeTool(ctx, 'rh_inbox', {
      repo_id: repository.repoId,
      operation: 'resolve',
      handoff_id: handoffId,
      decision: 'continue',
      resolver: 'chatgpt',
    }));
    expect(resolved).toMatchObject({
      status: 'ok',
      data: { item: { id: handoffId, status: 'resolved', decision: 'continue', resolver: 'chatgpt' } },
    });
  });

  test('rh_context with invalid requested check id returns warning not failure', async () => {
    const { ctx, repository } = controllerFixture();
    const payload = structured(await callRuntimeTool(ctx, 'rh_context', {
      repo_id: repository.repoId,
      operation: 'get',
      requested_check_ids: ['not-a-real-check', 'typecheck'],
    }));
    expect(payload.status).toBe('ok');
    expect((payload.warnings as string[]).some((warning) => warning.includes('invalid_check_id'))).toBe(true);
    expect((payload.data as { invalidCheckIdsAreNotFailures: boolean }).invalidCheckIdsAreNotFailures).toBe(true);
  });

  test('rh_context distinguishes missing work ids and preserves raw detail level', async () => {
    const { ctx, repository } = controllerFixture();
    const missing = structured(await callRuntimeTool(ctx, 'rh_context', {
      repo_id: repository.repoId,
      operation: 'get',
      work_id: 'work-does-not-exist',
    }));
    expect(missing.status).toBe('not_found');

    const raw = structured(await callRuntimeTool(ctx, 'rh_context', {
      repo_id: repository.repoId,
      operation: 'list',
      detail_level: 'raw',
    }));
    expect(raw.detailLevel).toBe('raw');
    expect(raw.rawAvailable).toBe(true);
    expect((raw.suggestedNextActions as Array<{ operation: string; risk: string }>)[0]).toMatchObject({
      operation: 'start',
      risk: 'workspace_write',
    });
  });

  test('rh_context summary is decision-focused, path-free, and bounded while detail stays compatible', async () => {
    const { ctx, repository, controllerHome } = controllerFixture();
    const longObjective = 'Keep recovery context bounded without returning repository paths or historical execution details. '.repeat(12);
    for (let index = 0; index < 12; index += 1) {
      createWorkContract(
        { controllerHome, repoId: repository.repoId },
        {
          workId: `work-context-${index}`,
          repoId: repository.repoId,
          mode: 'goal_workloop',
          objective: `${longObjective}${index}`,
          acceptanceCriteria: ['Summary remains bounded.'],
          allowedPaths: ['src/runtime/'],
          forbiddenPaths: [],
          checks: [],
          constraints: {
            accessMode: 'full_access',
            workspaceMode: 'current',
            requireWorktree: false,
            allowCommit: true,
            allowMerge: true,
            allowCleanup: true,
          },
          status: 'running',
          driver: { preferred: 'direct_edit', allowWorker: false, allowDirectEdit: true },
          worktreePolicy: { required: false, reason: 'bounded context test' },
          evidencePolicy: { defaultDetailLevel: 'summary', allowRawOptIn: true, maxEvidenceRefs: 20 },
          approvalPolicy: { required: false, reasons: [], confirmed: false },
          recoveryPolicy: { allowSelfHealing: false, maxInfrastructureRetries: 0, handoffOnAmbiguity: true },
          requestedBy: 'chatgpt',
        },
      );
      structured(await callRuntimeTool(ctx, 'rh_inbox', {
        repo_id: repository.repoId,
        operation: 'create',
        work_id: `work-context-${index}`,
        title: `Context decision ${index}`,
        reason: `${longObjective}${index}`,
      }));
    }

    const summary = structured(await callRuntimeTool(ctx, 'rh_context', {
      repo_id: repository.repoId,
      operation: 'list',
      requested_check_ids: ['typecheck'],
    }));
    const data = summary.data as Record<string, unknown>;
    expect(summary.detailLevel).toBe('summary');
    expect(data.capabilities).toBeUndefined();
    expect(data.recentExecutionJobs).toBeUndefined();
    expect(data.historicalExecutionJobsIncluded).toBe(false);
    expect(data.requestedCheckIds).toEqual(['typecheck']);
    expect((data.selectedChecks as Array<{ id: string }>).map((entry) => entry.id)).toEqual(['package:check:type']);
    expect((data.checks as unknown[]).length).toBe(1);
    expect((data.activeWork as unknown[]).length).toBeLessThanOrEqual(3);
    expect((data.activeAttention as unknown[]).length).toBeLessThanOrEqual(3);
    expect((data.capabilityGroups as Array<Record<string, unknown>>).every((entry) => Object.keys(entry).sort().join(',') === 'capabilityCount,group')).toBe(true);
    expect((data.counts as Record<string, number>).activeWork).toBe(12);
    expect((data.counts as Record<string, number>).activeWorkShown).toBe(3);
    expect((data.counts as Record<string, number>).omittedPendingAttention).toBeGreaterThan(0);
    expect((data.detailPointers as { detail: { tool: string }; raw: { tool: string } })).toMatchObject({
      detail: { tool: 'rh_context' },
      raw: { tool: 'rh_context' },
    });
    const encoded = JSON.stringify(summary);
    expect(encoded).not.toContain(repository.canonicalRoot);
    expect(encoded).not.toContain(repository.localRoot);
    if (repository.remoteUrl) expect(encoded).not.toContain(repository.remoteUrl);
    expect(encoded).not.toContain(longObjective.slice(0, 200));
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect((summary.responseMeta as { structuredPayloadBytes: number }).structuredPayloadBytes).toBeLessThanOrEqual(16 * 1024);

    const detail = structured(await callRuntimeTool(ctx, 'rh_context', {
      repo_id: repository.repoId,
      operation: 'list',
      detail_level: 'detail',
    }));
    const detailData = detail.data as Record<string, unknown>;
    expect((detailData.repository as { canonicalRoot: string }).canonicalRoot).toBe(repository.canonicalRoot);
    expect(Array.isArray(detailData.recentExecutionJobs)).toBe(true);
    expect((detailData.capabilityGroups as Array<{ domains: string[] }>)[0]?.domains).toBeArray();
  });

  test('rh_context summary separates stale nonterminal Work and handoffs from current attention', async () => {
    const { ctx, repository, controllerHome } = controllerFixture();
    const oldAt = new Date(Date.now() - 72 * 60 * 60 * 1_000).toISOString();
    const createWork = (workId: string, status: 'open' | 'running' | 'blocked' | 'ready', updatedAt?: string) => createWorkContract(
      { controllerHome, repoId: repository.repoId, ...(updatedAt ? { now: () => updatedAt } : {}) },
      {
        workId,
        repoId: repository.repoId,
        mode: 'goal_workloop',
        objective: `Currentness fixture ${workId}`,
        acceptanceCriteria: [],
        allowedPaths: ['src/runtime/'],
        forbiddenPaths: [],
        checks: [],
        constraints: { accessMode: 'full_access', workspaceMode: 'current', requireWorktree: false },
        status,
        driver: { preferred: 'direct_edit', allowWorker: false, allowDirectEdit: true },
        worktreePolicy: { required: false, reason: 'currentness fixture' },
        evidencePolicy: { defaultDetailLevel: 'summary', allowRawOptIn: true, maxEvidenceRefs: 20 },
        approvalPolicy: { required: false, reasons: [], confirmed: false },
        recoveryPolicy: { allowSelfHealing: false, maxInfrastructureRetries: 0, handoffOnAmbiguity: true },
        requestedBy: 'chatgpt',
      },
    );
    createWork('work-stale-open', 'open', oldAt);
    createWork('work-stale-blocked', 'blocked', oldAt);
    createWork('work-stale-running', 'running', oldAt);
    createWork('work-stale-ready', 'ready', oldAt);
    createWork('work-recent-ready', 'ready');
    createWork('work-recent-blocked', 'blocked');

    const createAttention = (id: string, workId: string | undefined, updatedAt?: string) => createHandoffItem(
      { controllerHome, repoId: repository.repoId, ...(updatedAt ? { now: () => updatedAt } : {}) },
      {
        id,
        repoId: repository.repoId,
        ...(workId ? { workId } : {}),
        title: id,
        severity: 'needs_review',
        reason: `Review ${id}`,
        summary: `Summary ${id}`,
        currentState: { repoId: repository.repoId, ...(workId ? { workId } : {}), statusSummary: 'pending' },
        evidenceRefs: [],
        recommendedDecision: 'review',
        recommendedPrompt: 'Review this handoff.',
        suggestedNextActions: [],
      },
    );
    createAttention('attention-stale-work', 'work-stale-blocked', oldAt);
    createAttention('attention-stale-ready', 'work-stale-ready', oldAt);
    createAttention('attention-current-work', 'work-stale-running', oldAt);
    createAttention('attention-recent-ready', 'work-recent-ready', oldAt);
    createAttention('attention-recent-unattached', undefined);

    const summary = structured(await callRuntimeTool(ctx, 'rh_context', {
      repo_id: repository.repoId,
      operation: 'list',
    }));
    const data = summary.data as Record<string, unknown>;
    const workIds = (data.activeWork as Array<{ workId: string }>).map((entry) => entry.workId);
    const attentionIds = (data.activeAttention as Array<{ id: string }>).map((entry) => entry.id);
    expect(workIds).toEqual(expect.arrayContaining(['work-stale-running', 'work-recent-ready', 'work-recent-blocked']));
    expect(workIds).not.toContain('work-stale-open');
    expect(workIds).not.toContain('work-stale-blocked');
    expect(workIds).not.toContain('work-stale-ready');
    expect(attentionIds).toEqual(expect.arrayContaining(['attention-current-work', 'attention-recent-ready', 'attention-recent-unattached']));
    expect(attentionIds).not.toContain('attention-stale-work');
    expect(attentionIds).not.toContain('attention-stale-ready');
    expect(data.counts).toMatchObject({
      activeWork: 3,
      storedNonTerminalWork: 6,
      currentWork: 3,
      historicalNonTerminalWork: 3,
      currentAttention: 3,
      currentAttentionShown: 3,
      pendingAttentionScanned: 5,
      historicalPendingAttention: 2,
    });
    expect(data.historicalExecutionJobsIncluded).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(summary), 'utf8')).toBeLessThanOrEqual(16 * 1024);

    const detail = structured(await callRuntimeTool(ctx, 'rh_context', {
      repo_id: repository.repoId,
      operation: 'list',
      detail_level: 'detail',
    }));
    const detailData = detail.data as Record<string, unknown>;
    expect((detailData.activeWork as unknown[])).toHaveLength(6);
    expect((detailData.activeAttention as unknown[])).toHaveLength(5);
  });

  test('rh_work start routes small/complex/high-risk modes', async () => {
    const { ctx, repository } = controllerFixture();
    const small = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'start',
      objective: 'Fix typo',
      expected_files: 1,
      expected_changed_lines: 4,
      scope_clear: true,
    }));
    expect((small.data as { workContractCreated: boolean; mode: { mode: string } }).workContractCreated).toBe(false);
    expect((small.data as { mode: { mode: string } }).mode.mode).toBe('direct_control');

    const sourceRevision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository.canonicalRoot, encoding: 'utf8' }).stdout.trim();
    structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'plan_create',
      plan_id: 'plan-complex-start',
      scope_key: 'src/runtime/control-plane',
      source_revision: sourceRevision,
      objective: 'Refactor facade routing and recovery loop',
      plan_steps: [{ id: 'implement', objective: 'Implement the reviewed refactor', check_ids: ['typecheck'], acceptance_criteria: ['Typecheck passes.'] }],
    }));
    structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'plan_approve',
      plan_id: 'plan-complex-start',
    }));

    const complex = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'start',
      objective: 'Refactor facade routing and recovery loop',
      expected_files: 12,
      expected_changed_lines: 600,
      requires_long_running_checks: true,
      scope_clear: true,
      check_ids: ['typecheck'],
      plan_id: 'plan-complex-start',
      plan_step_id: 'implement',
    }));
    expect((complex.data as { workContractCreated: boolean }).workContractCreated).toBe(true);
    expect((complex.data as { mode: { mode: string } }).mode.mode).toBe('goal_workloop');
    const workId = (complex.data as { work: { workId: string } }).work.workId;

    const risky = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'start',
      objective: 'Force push and rotate secrets',
      destructive: true,
      secret_access: true,
      requires_approval: true,
      requires_user_approval: true,
      scope_clear: true,
    }));
    expect((risky.data as { workContractCreated: boolean; mode: { mode: string } }).workContractCreated).toBe(false);
    expect((risky.data as { mode: { mode: string } }).mode.mode).toBe('handoff_only');

    const invalidVerify = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'verify',
      work_id: workId,
      check_id: 'docs-not-registered',
      simulate_check: true,
    }));
    expect((invalidVerify.data as { verification: { outcome: string; isAcceptanceFailure: boolean } }).verification).toMatchObject({
      outcome: 'invalid_check_id',
      isAcceptanceFailure: false,
    });

    const validVerify = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'verify',
      work_id: workId,
      check_id: 'typecheck',
      simulate_check: true,
    }));
    expect((validVerify.data as { verification: { checkId: string; outcome: string } }).verification.checkId).toBe('package:check:type');
    expect((validVerify.data as { verification: { outcome: string } }).verification.outcome).toBe('valid_pass');
  });

  test('rh_work persists and approves bounded plans without expanding the facade', async () => {
    const { ctx, repository } = controllerFixture();
    const created = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'plan_create',
      plan_id: 'plan-facade-contract',
      scope_key: 'src/runtime/gateway/mcp',
      source_revision: 'abc123',
      objective: 'Add a durable plan before complex execution',
      plan_steps: [{
        id: 'inspect',
        objective: 'Inspect facade routing',
        authoritative_files: ['src/runtime/gateway/mcp/runtime-tools.ts'],
        allowed_paths: ['src/runtime/'],
        forbidden_paths: ['_ops/'],
        check_ids: ['package:check:type'],
        acceptance_criteria: ['Plan can be approved without execution.'],
      }],
    }));
    expect(created).toMatchObject({
      status: 'ok',
      data: { executionStarted: false, plan: { planId: 'plan-facade-contract', status: 'draft' } },
    });

    const approved = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'plan_approve',
      plan_id: 'plan-facade-contract',
    }));
    expect(approved).toMatchObject({ data: { executionStarted: false, plan: { status: 'approved', sourceRevision: 'abc123' } } });

    const listed = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'plan_list',
    }));
    expect((listed.data as { plans: Array<{ planId: string }> }).plans.map((plan) => plan.planId)).toContain('plan-facade-contract');
    expect(PREFERRED_FACADE_TOOL_NAMES).toEqual(['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work']);
  });

  test('rh_work blocks approval for an overlapping or incomplete plan', async () => {
    const { ctx, repository } = controllerFixture();
    for (const planId of ['plan-first', 'plan-second']) {
      structured(await callRuntimeTool(ctx, 'rh_work', {
        repo_id: repository.repoId,
        operation: 'plan_create',
        plan_id: planId,
        scope_key: 'src/runtime/control-plane',
        source_revision: planId === 'plan-first' ? 'abc123' : '',
        objective: 'Persist plan state',
        plan_steps: [{ id: 'step', objective: 'Create plan', check_ids: ['package:check:type'], acceptance_criteria: ['Created.'] }],
      }));
    }
    const first = structured(await callRuntimeTool(ctx, 'rh_work', { repo_id: repository.repoId, operation: 'plan_approve', plan_id: 'plan-first' }));
    expect(first.status).toBe('ok');
    const second = structured(await callRuntimeTool(ctx, 'rh_work', { repo_id: repository.repoId, operation: 'plan_approve', plan_id: 'plan-second' }));
    expect(second).toMatchObject({ status: 'blocked', data: { executionStarted: false } });
    expect(second.summary).toMatch(/source_revision/i);
  });

  test('rh_work.delegate is deprecated and read-only', async () => {
    const { ctx, repository } = controllerFixture();
    const workId = 'legacy-delegate-work';

    const codex = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'delegate',
      target: 'codex',
      work_id: workId,
      objective: 'Implement bounded patch',
      available: true,
      worker_output: { summary: 'patch ready', patchProposal: 'diff --git a/x' },
    }));
    expect(codex.status).toBe('blocked');
    expect((codex.data as { canFinalize: boolean; target: string; deprecated: boolean }).canFinalize).toBe(false);
    expect((codex.data as { target: string }).target).toBe('codex');
    expect((codex.data as { deprecated: boolean }).deprecated).toBe(true);

    const grok = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'delegate',
      target: 'grok',
      work_id: workId,
      objective: 'Parallel review',
    }));
    expect(grok.status).toBe('blocked');
    expect((grok.data as { target: string; deprecated: boolean; canFinalize: boolean }).target).toBe('grok');
    expect((grok.data as { deprecated: boolean }).deprecated).toBe(true);
    expect((grok.data as { canFinalize: boolean }).canFinalize).toBe(false);
  });

  test('repair diagnose defaults dry_run; destructive requires approval', async () => {
    const { ctx, repository } = controllerFixture();
    const diagnose = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'repair',
      repair_operation: 'diagnose',
    }));
    expect((diagnose.data as { dryRun: boolean; isAcceptanceFailure: boolean }).dryRun).toBe(true);
    expect((diagnose.data as { isAcceptanceFailure: boolean }).isAcceptanceFailure).toBe(false);
    expect((diagnose.data as { linkedTools: string[] }).linkedTools).toContain('runtime_maintenance_status');

    const destructive = structured(await callRuntimeTool(ctx, 'rh_status', {
      repo_id: repository.repoId,
      operation: 'repair',
      repair_operation: 'repair',
      dry_run: false,
      process_kill_or_restart: true,
      destructive: true,
    }));
    expect(destructive.status).toBe('approval_required');
    expect((destructive.data as { applied: boolean; isAcceptanceFailure: boolean }).applied).toBe(false);
    expect((destructive.data as { isAcceptanceFailure: boolean }).isAcceptanceFailure).toBe(false);
  });

  test('stale rh_work continue schema safely resumes ownership only after a controller epoch change', async () => {
    const { ctx, repository, controllerHome } = controllerFixture();
    const principalId = 'facade-rollout-principal';
    const oldCtx = {
      ...ctx,
      sessionId: 'facade-rollout-old-session',
      principalId,
      controllerInstanceId: 'facade-rollout-epoch-a',
    } as MultiRepositoryMcpToolContext;
    const work = createWorkContract(
      { controllerHome, repoId: repository.repoId },
      {
        workId: `work-facade-rollout-${Date.now()}`,
        repoId: repository.repoId,
        mode: 'goal_workloop',
        objective: 'Resume through the cached continue-only rh_work schema',
        acceptanceCriteria: ['Continue can recover ownership after rollout.'],
        allowedPaths: ['src/runtime/'],
        forbiddenPaths: [],
        checks: [],
        constraints: {
          accessMode: 'full_access',
          workspaceMode: 'current',
          requireWorktree: false,
          allowCommit: true,
          allowMerge: true,
          allowCleanup: true,
        },
        status: 'running',
        driver: { preferred: 'direct_edit', allowWorker: false, allowDirectEdit: true },
        worktreePolicy: { required: false, reason: 'facade compatibility test' },
        evidencePolicy: { defaultDetailLevel: 'summary', allowRawOptIn: true, maxEvidenceRefs: 20 },
        approvalPolicy: { required: false, reasons: [], confirmed: false },
        recoveryPolicy: { allowSelfHealing: true, maxInfrastructureRetries: 3, handoffOnAmbiguity: true },
        requestedBy: 'chatgpt',
      },
    );
    startExecutionSession(controllerHome, {
      sessionId: oldCtx.sessionId,
      principalId,
      controllerInstanceId: oldCtx.controllerInstanceId,
    });
    claimControllerSession(
      { controllerHome, repoId: repository.repoId },
      {
        workId: work.workId,
        controllerId: principalId,
        controllerType: 'chatgpt',
        sessionId: oldCtx.sessionId!,
        principalId,
        controllerInstanceId: oldCtx.controllerInstanceId!,
      },
    );

    const sameEpochCtx = {
      ...oldCtx,
      sessionId: 'facade-rollout-same-epoch-session',
    } as MultiRepositoryMcpToolContext;
    startExecutionSession(controllerHome, {
      sessionId: sameEpochCtx.sessionId,
      principalId,
      controllerInstanceId: sameEpochCtx.controllerInstanceId,
    });
    const sameEpoch = structured(await callRuntimeTool(sameEpochCtx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'continue',
      work_id: work.workId,
    }));
    expect(sameEpoch.status).toBe('blocked');
    expect(String(sameEpoch.summary)).toContain('WORK_ALREADY_CLAIMED');

    const spoofed = structured(await callRuntimeTool({
      ...sameEpochCtx,
      controllerInstanceId: 'facade-rollout-epoch-b',
    } as MultiRepositoryMcpToolContext, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'controller_claim',
      work_id: work.workId,
      controller_id: 'spoofed-controller',
    }));
    expect(spoofed.status).toBe('blocked');
    expect(String(spoofed.summary)).toContain('CONTROLLER_ID_CONTEXT_MISMATCH');

    const newEpochCtx = {
      ...oldCtx,
      sessionId: 'facade-rollout-new-session',
      controllerInstanceId: 'facade-rollout-epoch-b',
    } as MultiRepositoryMcpToolContext;
    startExecutionSession(controllerHome, {
      sessionId: newEpochCtx.sessionId,
      principalId,
      controllerInstanceId: newEpochCtx.controllerInstanceId,
    });
    const resumed = structured(await callRuntimeTool(newEpochCtx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'continue',
      work_id: work.workId,
    }));
    expect(resumed.status).toBe('blocked');
    expect(String(resumed.summary)).toContain('Controller ownership resumed');
    expect((resumed.data as { ownershipResumed: boolean; nextStep: string }).ownershipResumed).toBe(true);
    expect((resumed.data as { ownershipResumed: boolean; nextStep: string }).nextStep).toBe('execute');
    expect(getControllerSession({ controllerHome, repoId: repository.repoId }, work.workId)).toMatchObject({
      controllerId: principalId,
      principalId,
      sessionId: 'facade-rollout-new-session',
      controllerInstanceId: 'facade-rollout-epoch-b',
    });
  });

  test('invalid facade operation returns structured FacadeResult error', async () => {
    const { ctx, repository } = controllerFixture();
    const payload = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'explode',
    }));
    expect(payload.status).toBe('failed');
    expect((payload.data as { allowedOperations: string[] }).allowedOperations).toContain('start');
    expect((payload.suggestedNextActions as unknown[]).length).toBeGreaterThan(0);
  });
});
